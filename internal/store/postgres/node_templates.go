package postgres

// ADR-0049 part 1: the node-template ("Step") registry store. Every read
// carries the caller's ORGANIZATION in its SQL — a template of another
// organization answers api.ErrNodeTemplateNotFound, byte-identical to
// nonsense (house style) — and every mutation writes its state and its
// § 7 journal row in ONE transaction (the same rule m4api.go states for
// the pipeline surface).
//
// Immutability is structural: there is no UPDATE path to a revision row in
// this file at all. "Edit for all" is a new row (revision N+1), never a
// rewrite of an older one (ADR-0002).
//
// The § 4 usage number is computed, not stored: it joins
// pipeline_revision_template_refs over each pipeline's LATEST published
// revision. Part 2 writes those refs at publish; until then the table is
// empty and every count/usage list is honestly zero/empty.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/canon"
)

var _ api.NodeTemplateStore = APINodeTemplateStore{}

// APINodeTemplateStore exposes the registry's SQL as api.NodeTemplateStore.
// It is pool-only (no base store to wrap): the three 00009 tables are new
// and nothing outside this file touches them yet.
type APINodeTemplateStore struct {
	Pool *pgxpool.Pool
}

func (s APINodeTemplateStore) pool() (*pgxpool.Pool, error) {
	return m4Pool(s.Pool, "APINodeTemplateStore")
}

// nodeTemplateContentDigest is the revision digest: ADR-0021 canonical
// bytes of the four content members, scope v1alpha1-canonical-1. Identical
// content gives identical digests even across templates — that is the
// intended semantics (no org-wide uniqueness, § 1 note).
func nodeTemplateContentDigest(parameters, config, outputSchema json.RawMessage, workspaceMode string) (string, error) {
	members := map[string]canon.Value{}
	for _, u := range []struct {
		name string
		raw  json.RawMessage
	}{{"parameters", parameters}, {"config", config}, {"output_schema", outputSchema}} {
		var v canon.Value
		if len(u.raw) == 0 {
			u.raw = json.RawMessage(`{}`)
		}
		if err := json.Unmarshal(u.raw, &v); err != nil {
			return "", fmt.Errorf("node template %s is not JSON: %w", u.name, err)
		}
		members[u.name] = v
	}
	members["workspace_mode"] = workspaceMode
	return canon.DigestValue(members)
}

// ntUsedInCountSQL is the § 4 count as a scalar subquery: the number of
// non-archived pipelines whose LATEST published revision references the
// template row the embedding query aliases as `t`. Inlining it into the
// SELECT list keeps both read routes one query (no N+1).
const ntUsedInCountSQL = `
(SELECT count(*) FROM (
    SELECT DISTINCT pr2.pipeline_id
    FROM pipeline_revision_template_refs r2
    JOIN pipeline_revisions pr2 ON pr2.id = r2.pipeline_revision_id
    JOIN pipelines p2 ON p2.id = pr2.pipeline_id
    WHERE r2.template_id = t.id AND p2.archived_at IS NULL
      AND pr2.revision_number = (SELECT max(revision_number)
                                 FROM pipeline_revisions
                                 WHERE pipeline_id = p2.id)
) used) AS used_in_count`

// ListTemplates is GET /node-templates: one query, org-scoped, ordered by
// slug (the handler's contract), the latest revision and the § 4 count
// joined in laterals.
func (s APINodeTemplateStore) ListTemplates(ctx context.Context, c api.Caller) ([]api.NodeTemplateView, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT t.id, t.slug, t.display_name, t.kind, t.description, t.status,
		       t.created_by::text, t.created_at, t.updated_at,
		       lr.id::text, lr.revision_number, lr.version_label,
		       lr.revision_digest, lr.created_at,
		       `+ntUsedInCountSQL+`
		FROM node_templates t
		LEFT JOIN LATERAL (
			SELECT id, revision_number, version_label, revision_digest, created_at
			FROM node_template_revisions
			WHERE template_id = t.id
			ORDER BY revision_number DESC
			LIMIT 1
		) lr ON true
		WHERE t.organization_id = $1::uuid
		ORDER BY t.slug`, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list node templates: %w", err)
	}
	defer rows.Close()
	out := []api.NodeTemplateView{}
	for rows.Next() {
		var v api.NodeTemplateView
		var revID *string
		var usedIn int64
		if err := rows.Scan(
			&v.ID, &v.Slug, &v.DisplayName, &v.Kind, &v.Description, &v.Status,
			&v.CreatedBy, &v.CreatedAt, &v.UpdatedAt,
			&revID, &v.LatestRevision.RevisionNumber, &v.LatestRevision.VersionLabel,
			&v.LatestRevision.RevisionDigest, &v.LatestRevision.CreatedAt,
			&usedIn,
		); err != nil {
			return nil, fmt.Errorf("postgres: scan api node template: %w", err)
		}
		if revID != nil {
			v.LatestRevision.RevisionID = *revID
		}
		v.UsedInCount = int(usedIn)
		out = append(out, v)
	}
	return out, rows.Err()
}

// ntLatestRevisionSQL fetches a template's latest revision (the one its
// list view and its :duplicate copy both pin). It is org-scoped: a
// template the caller may not see has no latest revision.
const ntLatestRevisionSQL = `
	SELECT ntr.id::text, ntr.revision_number, ntr.version_label, ntr.revision_digest,
	       ntr.created_at
	FROM node_template_revisions ntr
	WHERE ntr.template_id = $1::uuid AND ntr.organization_id = $2::uuid
	ORDER BY ntr.revision_number DESC
	LIMIT 1`

// GetTemplate is GET /node-templates/{id}: the template row, its full
// revision history (newest first) and its § 4 usages — one query per
// relation. A foreign-org id is ErrNodeTemplateNotFound.
func (s APINodeTemplateStore) GetTemplate(ctx context.Context, c api.Caller, templateID string) (api.NodeTemplateDetailView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.NodeTemplateDetailView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.NodeTemplateDetailView{}, err
	}
	if !prjValidUUID(templateID) {
		return api.NodeTemplateDetailView{}, api.ErrNodeTemplateNotFound
	}
	var detail api.NodeTemplateDetailView
	if err := pool.QueryRow(ctx, `
		SELECT t.id, t.slug, t.display_name, t.kind, t.description, t.status,
		       t.created_by::text, t.created_at, t.updated_at,
		       `+ntUsedInCountSQL+`
		FROM node_templates t
		WHERE t.id = $1::uuid AND t.organization_id = $2::uuid`, templateID, c.OrganizationID).
		Scan(&detail.Template.ID, &detail.Template.Slug, &detail.Template.DisplayName,
			&detail.Template.Kind, &detail.Template.Description, &detail.Template.Status,
			&detail.Template.CreatedBy, &detail.Template.CreatedAt, &detail.Template.UpdatedAt,
			&detail.Template.UsedInCount); errors.Is(err, pgx.ErrNoRows) {
		return api.NodeTemplateDetailView{}, api.ErrNodeTemplateNotFound
	}
	if err != nil {
		return api.NodeTemplateDetailView{}, fmt.Errorf("postgres: api get node template %s: %w", templateID, err)
	}

	revs, err := s.revisions(ctx, pool, c, templateID)
	if err != nil {
		return api.NodeTemplateDetailView{}, err
	}
	detail.Revisions = revs

	latestID := ""
	if len(revs) > 0 {
		latestID = revs[0].RevisionID // newest first
	}
	detail.Usages, err = s.usages(ctx, pool, c, templateID, latestID)
	if err != nil {
		return api.NodeTemplateDetailView{}, err
	}
	return detail, nil
}

func (s APINodeTemplateStore) revisions(ctx context.Context, pool *pgxpool.Pool, c api.Caller, templateID string) ([]api.NodeTemplateRevisionView, error) {
	rows, err := pool.Query(ctx, `
		SELECT id::text, revision_number, version_label, parameters, config,
		       output_schema, workspace_mode, revision_digest, created_by::text, created_at
		FROM node_template_revisions
		WHERE template_id = $1::uuid AND organization_id = $2::uuid
		ORDER BY revision_number DESC`, templateID, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api node template revisions: %w", err)
	}
	defer rows.Close()
	out := []api.NodeTemplateRevisionView{}
	for rows.Next() {
		var v api.NodeTemplateRevisionView
		if err := rows.Scan(&v.RevisionID, &v.RevisionNumber, &v.VersionLabel,
			&v.Parameters, &v.Config, &v.OutputSchema, &v.WorkspaceMode,
			&v.RevisionDigest, &v.CreatedBy, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan node template revision: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// usages is the § 4 query in full: the workflows whose LATEST published
// revision references this template, the node ids grouped, and up_to_date
// computed against the template's latest revision id (empty when the
// template has none — cannot happen through the API, guarded anyway).
func (s APINodeTemplateStore) usages(ctx context.Context, pool *pgxpool.Pool, c api.Caller, templateID, latestRevisionID string) ([]api.TemplateUsage, error) {
	rows, err := pool.Query(ctx, `
		SELECT pr.pipeline_id::text, p.slug, p.display_name, pr.revision_number,
		       r.template_revision_id::text, array_agg(r.node_id ORDER BY r.node_id)
		FROM pipeline_revision_template_refs r
		JOIN pipeline_revisions pr ON pr.id = r.pipeline_revision_id
		JOIN pipelines p ON p.id = pr.pipeline_id
		WHERE r.template_id = $1::uuid AND pr.organization_id = $2::uuid
		  AND p.archived_at IS NULL
		  AND pr.revision_number = (SELECT max(revision_number) FROM pipeline_revisions
		                             WHERE pipeline_id = p.id)
		GROUP BY pr.pipeline_id, p.slug, p.display_name, pr.revision_number, r.template_revision_id
		ORDER BY p.slug`, templateID, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api node template usages: %w", err)
	}
	defer rows.Close()
	out := []api.TemplateUsage{}
	for rows.Next() {
		var u api.TemplateUsage
		if err := rows.Scan(&u.PipelineID, &u.PipelineSlug, &u.PipelineDisplayName,
			&u.RevisionNumber, &u.TemplateRevisionID, &u.NodeIDs); err != nil {
			return nil, fmt.Errorf("postgres: scan node template usage: %w", err)
		}
		u.UpToDate = latestRevisionID != "" && u.TemplateRevisionID == latestRevisionID
		out = append(out, u)
	}
	return out, rows.Err()
}

// ntRevisionInsert is the revision row insert shared by CreateTemplate
// (revision 1) and CreateTemplateRevision (revision N+1). Immutability is
// structural: this file has no UPDATE to node_template_revisions at all.
const ntRevisionInsert = `
	INSERT INTO node_template_revisions
		(template_id, organization_id, revision_number, version_label,
		 parameters, config, output_schema, workspace_mode,
		 revision_digest, created_by)
	VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
	        $8, $9, $10::uuid)
	RETURNING id::text, created_at`

// ntTemplateWithLatest is the SELECT a mutation RETURNs: the template row
// plus its (just inserted) latest revision summary.
const ntTemplateWithLatest = `
	SELECT t.id::text, t.slug, t.display_name, t.kind, t.description, t.status,
	       t.created_by::text, t.created_at, t.updated_at,
	       ntr.id::text, ntr.revision_number, ntr.version_label,
	       ntr.revision_digest, ntr.created_at
	FROM node_templates t
	JOIN node_template_revisions ntr
	    ON ntr.template_id = t.id
	   AND ntr.revision_number = (SELECT max(revision_number)
	                              FROM node_template_revisions
	                              WHERE template_id = t.id)`

// CreateTemplate is POST /node-templates: template row + revision 1 + the
// node_template.create journal row, one commit. A slug the org already
// holds is api.ErrNodeTemplateConflict (409).
func (s APINodeTemplateStore) CreateTemplate(ctx context.Context, c api.Caller, in api.NodeTemplateCreateInput) (api.NodeTemplateView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.NodeTemplateView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.NodeTemplateView{}, err
	}
	digest, err := nodeTemplateContentDigest(in.Parameters, in.Config, in.OutputSchema, in.WorkspaceMode)
	if err != nil {
		return api.NodeTemplateView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: begin create node template: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var templateID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO node_templates
			(organization_id, slug, display_name, kind, description, created_by)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)
		RETURNING id::text`,
		c.OrganizationID, in.Slug, in.DisplayName, in.Kind, in.Description, c.UserID).
		Scan(&templateID); m4UniqueViolation(err) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateConflict
	} else if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: create node template %q: %w", in.Slug, err)
	}
	var revisionID string
	var createdAt time.Time
	if err := tx.QueryRow(ctx, ntRevisionInsert,
		templateID, c.OrganizationID, 1, in.VersionLabel,
		orEmptyJSON(in.Parameters), orEmptyJSON(in.Config), orEmptyJSON(in.OutputSchema),
		in.WorkspaceMode, digest, c.UserID).
		Scan(&revisionID, &createdAt); m4UniqueViolation(err) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateConflict
	} else if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: create node template revision 1: %w", err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypeNodeTemplateCreated, c.OrganizationID, "",
		c.UserID, events.NodeTemplateCreatedPayload{
			ProjectID: "", TemplateID: templateID, Slug: in.Slug, VersionLabel: in.VersionLabel,
		}); err != nil {
		return api.NodeTemplateView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: commit create node template: %w", err)
	}
	var v api.NodeTemplateView
	err = pool.QueryRow(ctx, ntTemplateWithLatest+`
		WHERE t.id = $1::uuid`, templateID).
		Scan(
			&v.ID, &v.Slug, &v.DisplayName, &v.Kind, &v.Description, &v.Status,
			&v.CreatedBy, &v.CreatedAt, &v.UpdatedAt,
			&v.LatestRevision.RevisionID, &v.LatestRevision.RevisionNumber,
			&v.LatestRevision.VersionLabel, &v.LatestRevision.RevisionDigest,
			&v.LatestRevision.CreatedAt,
		)
	if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: rescan created node template: %w", err)
	}
	return v, nil
}

// CreateTemplateRevision is POST /node-templates/{id}/revisions: revision
// N+1, immutable, in one transaction with its
// node_template.revision.publish row. The template row is locked FOR
// UPDATE so two concurrent publishes of the same template cannot compute
// the same N+1; a version_label the template already carries (or a race
// into the unique index) is api.ErrNodeTemplateConflict (409).
//
// adopt_using_workflows (ADR-0049 § 5) is part 2: until publish writes
// pipeline_revision_template_refs the scope query below returns nothing,
// so the response's adopted/skipped arrays are empty — the honest answer
// for a registry with no published references yet.
func (s APINodeTemplateStore) CreateTemplateRevision(ctx context.Context, c api.Caller, templateID string, in api.NodeTemplateRevisionInput) (api.NodeTemplateRevisionCreateResponse, error) {
	pool, err := s.pool()
	if err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, err
	}
	if !prjValidUUID(templateID) {
		return api.NodeTemplateRevisionCreateResponse{}, api.ErrNodeTemplateNotFound
	}
	digest, err := nodeTemplateContentDigest(in.Parameters, in.Config, in.OutputSchema, in.WorkspaceMode)
	if err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, fmt.Errorf("postgres: begin node template revision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var nextNumber int
	if err := tx.QueryRow(ctx, `
		SELECT (SELECT coalesce(max(revision_number), 0) + 1
		        FROM node_template_revisions WHERE template_id = $1::uuid)
		FROM node_templates
		WHERE id = $1::uuid AND organization_id = $2::uuid
		FOR UPDATE OF node_templates`, templateID, c.OrganizationID).
		Scan(&nextNumber); errors.Is(err, pgx.ErrNoRows) {
		return api.NodeTemplateRevisionCreateResponse{}, api.ErrNodeTemplateNotFound
	} else if err != nil {
		return api.NodeTemplateRevisionCreateResponse{},
			fmt.Errorf("postgres: node template next revision number: %w", err)
	}
	var taken bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM node_template_revisions
		                WHERE template_id = $1::uuid AND version_label = $2)`,
		templateID, in.VersionLabel).Scan(&taken); err != nil {
		return api.NodeTemplateRevisionCreateResponse{},
			fmt.Errorf("postgres: node template version label taken check: %w", err)
	}
	if taken {
		return api.NodeTemplateRevisionCreateResponse{}, api.ErrNodeTemplateConflict
	}
	var rev api.NodeTemplateRevisionView
	if err := tx.QueryRow(ctx, ntRevisionInsert,
		templateID, c.OrganizationID, nextNumber, in.VersionLabel,
		orEmptyJSON(in.Parameters), orEmptyJSON(in.Config), orEmptyJSON(in.OutputSchema),
		in.WorkspaceMode, digest, c.UserID).
		Scan(&rev.RevisionID, &rev.CreatedAt); m4UniqueViolation(err) {
		return api.NodeTemplateRevisionCreateResponse{}, api.ErrNodeTemplateConflict
	} else if err != nil {
		return api.NodeTemplateRevisionCreateResponse{},
			fmt.Errorf("postgres: create node template revision %d: %w", nextNumber, err)
	}
	rev.RevisionNumber = nextNumber
	rev.VersionLabel = in.VersionLabel
	rev.Parameters = in.Parameters
	rev.Config = in.Config
	rev.OutputSchema = in.OutputSchema
	rev.WorkspaceMode = in.WorkspaceMode
	rev.RevisionDigest = digest
	rev.CreatedBy = c.UserID
	if err := m4AppendAppendable(ctx, tx, events.TypeNodeTemplateRevisionPublished, c.OrganizationID, "",
		c.UserID, events.NodeTemplateRevisionPublishedPayload{
			ProjectID: "", TemplateID: templateID, RevisionID: rev.RevisionID,
			RevisionNumber: nextNumber, VersionLabel: in.VersionLabel, RevisionDigest: digest,
		}); err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.NodeTemplateRevisionCreateResponse{}, fmt.Errorf("postgres: commit node template revision: %w", err)
	}
	return api.NodeTemplateRevisionCreateResponse{
		Revision: rev,
		Adopted:  []api.TemplateAdoption{},
		Skipped:  []api.TemplateAdoptionSkipped{},
	}, nil
}

// DuplicateTemplate is POST /node-templates/{id}/duplicate: a NEW template
// whose revision 1 is a content copy of the source's latest revision —
// same parameters/config/output_schema/workspace_mode, same version_label,
// revision_number 1, the same digest (content is identical; that is the
// point). One transaction, one node_template.duplicate row.
func (s APINodeTemplateStore) DuplicateTemplate(ctx context.Context, c api.Caller, templateID, slug, displayName string) (api.NodeTemplateView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.NodeTemplateView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.NodeTemplateView{}, err
	}
	if !prjValidUUID(templateID) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateNotFound
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: begin duplicate node template: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		sourceSlug            string
		sourceKind            string
		revisionNum           int
		versionLabel          string
		parameters            json.RawMessage
		config                json.RawMessage
		outputSchema          json.RawMessage
		workspaceMode, digest string
	)
	// Lock the template row first: FOR UPDATE may not ride a query with an
	// aggregate (the latest-revision join carries a max), so the row is
	// locked plain and the latest revision read in its own statement.
	if err := tx.QueryRow(ctx, `
		SELECT slug, kind
		FROM node_templates
		WHERE id = $1::uuid AND organization_id = $2::uuid
		FOR UPDATE`, templateID, c.OrganizationID).
		Scan(&sourceSlug, &sourceKind); errors.Is(err, pgx.ErrNoRows) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateNotFound
	} else if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: lock source node template: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT revision_number, version_label, parameters, config,
		       output_schema, workspace_mode, revision_digest
		FROM node_template_revisions
		WHERE template_id = $1::uuid
		ORDER BY revision_number DESC
		LIMIT 1`, templateID).
		Scan(&revisionNum, &versionLabel, &parameters, &config,
			&outputSchema, &workspaceMode, &digest); err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: read source node template: %w", err)
	}

	var newID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO node_templates
			(organization_id, slug, display_name, kind, description, created_by)
		VALUES ($1::uuid, $2, $3, $4, '', $5::uuid)
		RETURNING id::text`,
		c.OrganizationID, slug, displayName, sourceKind, c.UserID).
		Scan(&newID); m4UniqueViolation(err) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateConflict
	} else if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: duplicate node template: %w", err)
	}
	var (
		newRevisionID string
		newRevAt      time.Time
	)
	if err := tx.QueryRow(ctx, ntRevisionInsert,
		newID, c.OrganizationID, 1, versionLabel,
		parameters, config, outputSchema,
		workspaceMode, digest, c.UserID).
		Scan(&newRevisionID, &newRevAt); m4UniqueViolation(err) {
		return api.NodeTemplateView{}, api.ErrNodeTemplateConflict
	} else if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: duplicate node template revision: %w", err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypeNodeTemplateDuplicated, c.OrganizationID, "",
		c.UserID, events.NodeTemplateDuplicatedPayload{
			ProjectID: "", TemplateID: newID, SourceTemplateID: templateID,
			Slug: slug, SourceTemplateSlug: sourceSlug,
		}); err != nil {
		return api.NodeTemplateView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: commit duplicate node template: %w", err)
	}
	var v api.NodeTemplateView
	err = pool.QueryRow(ctx, ntTemplateWithLatest+`
		WHERE t.id = $1::uuid`, newID).
		Scan(&v.ID, &v.Slug, &v.DisplayName, &v.Kind, &v.Description, &v.Status,
			&v.CreatedBy, &v.CreatedAt, &v.UpdatedAt,
			&v.LatestRevision.RevisionID, &v.LatestRevision.RevisionNumber,
			&v.LatestRevision.VersionLabel, &v.LatestRevision.RevisionDigest,
			&v.LatestRevision.CreatedAt)
	if err != nil {
		return api.NodeTemplateView{}, fmt.Errorf("postgres: rescan duplicated node template: %w", err)
	}
	return v, nil
}

// RecordDenied writes the audit row for a refused registry read (the
// m4audit face: definitions are org-scoped, project_id stays NULL).
func (s APINodeTemplateStore) RecordDenied(ctx context.Context, c api.Caller, resourceID, action string) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	return m4Denied(ctx, pool, c, resourceID, action)
}
