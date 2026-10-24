package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PipelineStore is the definition service's persistence face (ADR-0021,
// docs/m4-contract.md § 1/§ 2.1): pipelines, mutable drafts, immutable
// published revisions and project assignments. Immutability is structural —
// the only UPDATEs issued here target pipeline_drafts (the one mutable row per
// authoring session) and pipeline_revisions.status (published→deprecated,
// ADR-0002: deprecation never touches existing runs). A published digest
// collision surfaces as ErrConflict so the API can answer
// 409 revision_already_published with the existing revision id.
//
// The store never computes digests or canonical documents: those are the
// schema/compiler's output (internal/pipelines), and the dependency rule
// (AGENTS.md) keeps this package dependent on nothing but pgx and the domain
// vocabulary. What arrives here is already canonical, already digested.
type PipelineStore struct {
	Pool *pgxpool.Pool
}

// Errors specific to the definition surface. Callers map ErrConflict to 409
// (unique/CAS refusals); everything else is an infrastructure failure.
var (
	// ErrPipelineNotFound means the pipeline (or draft/revision below it)
	// does not exist. Organization scoping is the caller's predicate; a
	// digest that exists in another org answers not-found (contract § 2.1
	// route 13), never the document.
	ErrPipelineNotFound = errors.New("postgres: pipeline object not found")

	// ErrDraftNotPublishable refuses a publish whose draft is not at
	// status='valid' (contract § 2.1 route 12: draft_not_valid, never a
	// silent revalidate).
	ErrDraftNotPublishable = errors.New("postgres: draft is not valid at its current version")

	// ErrInvalidDocumentKind marks a validation attempt for a document kind
	// with no registered schema branch (ADR-0021 § 2): validate refuses, it
	// does not fall back to the Pipeline branch.
	ErrInvalidDocumentKind = errors.New("postgres: document kind has no schema branch")
)

// Pipeline is a logical pipeline definition: identity only. Everything
// mutable lives on a draft; everything frozen lives on a revision.
type Pipeline struct {
	ID             string
	OrganizationID string
	Slug           string
	DisplayName    string
	Description    string
	// Folder is ADR-0049 § 8's display string: NULL = unfiled, the API
	// never special-cases an empty string (the CHECK allows none).
	Folder     *string
	CreatedBy  string
	CreatedAt  time.Time
	ArchivedAt *time.Time
	// LatestRevisionNumber and RevisionCount are read together with the row
	// (contract § 2.1 route 1); 0 when nothing has ever been published.
	LatestRevisionNumber int
	RevisionCount        int
}

// Draft is the only mutable pipeline object. CanonicalDocument/RevisionDigest/
// CompiledPlan/PlanDigest are the last validation's output and are NULL until
// a validation says them; Version is the CAS token PUT /drafts compares.
type Draft struct {
	ID                  string
	PipelineID          string
	Status              string // draft|validating|valid|invalid|published
	DocumentText        string
	SourceKind          string
	SourceSHA256        string
	CanonicalDocument   json.RawMessage // nil until validated valid
	UILayout            json.RawMessage
	RevisionDigest      string // "" until validated valid
	CompiledPlan        json.RawMessage
	PlanDigest          string
	DigestScope         string
	Validation          json.RawMessage // last validate body, verbatim
	Version             int
	EditedBy            string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	PublishedRevisionID string // "" until published
}

// PipelineRevision is an immutable published record. Nothing in this package
// updates a revision row except DeprecateRevision (status only).
type PipelineRevision struct {
	ID                string
	PipelineID        string
	DraftID           string
	OrganizationID    string
	RevisionNumber    int
	VersionLabel      string
	APIVersion        string
	CanonicalDocument json.RawMessage
	DocumentText      string // regenerated from canonical, never re-hashed
	UILayout          json.RawMessage
	RevisionDigest    string
	DigestScope       string
	CompiledPlan      json.RawMessage
	PlanDigest        string
	SchemaDigest      string
	CelEnvDigest      string
	Status            string
	PublishedBy       string
	PublishedAt       time.Time
}

// Assignment pins one published revision to one project with budget ceilings
// (contract § 2.1 routes 17-20). M4's assignment is a pin plus budgets: no
// channels, no promote/preview (all M6).
type Assignment struct {
	ID                string
	ProjectID         string
	PipelineID        string
	PinnedRevisionID  string
	MaxConcurrentRuns int
	BudgetOverrides   json.RawMessage
	Enabled           bool
	Version           int
	CreatedBy         string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	// RepositoryID (ADR-0060) is the repository this pipeline is used in;
	// empty string is NULL — the whole project, the legacy / any-repo meaning.
	RepositoryID string
}

const pipPipelineColumns = `id, organization_id, slug, display_name, description,
	created_by::text, created_at, archived_at`

const pipPipelineShape = `
	SELECT p.id, p.organization_id, p.slug, p.display_name, p.description,
	       p.folder, p.created_by::text, p.created_at, p.archived_at,
	       COALESCE(r.latest, 0), COALESCE(r.total, 0)
	FROM pipelines p
	LEFT JOIN LATERAL (
		SELECT max(revision_number) AS latest, count(*) AS total
		FROM pipeline_revisions pr WHERE pr.pipeline_id = p.id
	) r ON true`

func (s *PipelineStore) scanPipeline(row pgx.Row) (Pipeline, error) {
	var (
		p    Pipeline
		arch *time.Time
	)
	err := row.Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.DisplayName, &p.Description,
		&p.Folder, &p.CreatedBy, &p.CreatedAt, &arch, &p.LatestRevisionNumber, &p.RevisionCount)
	p.ArchivedAt = arch
	return p, err
}

// CreatePipeline creates the logical definition — no revision, no run
// (contract § 2.1 route 2). A duplicate slug in the organization is
// ErrConflict.
func (s *PipelineStore) CreatePipeline(ctx context.Context, organizationID, createdBy, slug, displayName, description string) (Pipeline, error) {
	var p Pipeline
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO pipelines (organization_id, slug, display_name, description, created_by)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING `+pipPipelineColumns,
		organizationID, slug, displayName, description, createdBy).
		Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.DisplayName, &p.Description,
			&p.CreatedBy, &p.CreatedAt, &p.ArchivedAt)
	if pipUniqueErr(err) != nil {
		return Pipeline{}, ErrConflict
	}
	if err != nil {
		return Pipeline{}, fmt.Errorf("postgres: create pipeline %q: %w", slug, err)
	}
	return p, nil
}

// GetPipeline reads one definition with its revision summary.
func (s *PipelineStore) GetPipeline(ctx context.Context, id string) (Pipeline, error) {
	p, err := s.scanPipeline(s.Pool.QueryRow(ctx, pipPipelineShape+`
		WHERE p.id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Pipeline{}, ErrPipelineNotFound
	}
	if err != nil {
		return Pipeline{}, fmt.Errorf("postgres: get pipeline %s: %w", id, err)
	}
	return p, nil
}

// ListPipelines returns the organization's pipeline library, newest first
// (contract § 2.1 route 1).
func (s *PipelineStore) ListPipelines(ctx context.Context, organizationID string) ([]Pipeline, error) {
	rows, err := s.Pool.Query(ctx, pipPipelineShape+`
		WHERE p.organization_id = $1::uuid
		ORDER BY p.created_at DESC, p.id DESC`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list pipelines for %s: %w", organizationID, err)
	}
	defer rows.Close()
	var out []Pipeline
	for rows.Next() {
		p, err := s.scanPipeline(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan pipeline: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ArchivePipeline soft-deletes a definition (route 4's archive arm). Existing
// revisions and runs are untouched (ADR-0002); archiving twice is a no-op.
func (s *PipelineStore) ArchivePipeline(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, `
		UPDATE pipelines SET archived_at = COALESCE(archived_at, now()) WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("postgres: archive pipeline %s: %w", id, err)
	}
	return nil
}

// ------------------------------------------------------------------ drafts

const pipDraftColumns = `id, pipeline_id, status, document_text, source_kind, source_sha256,
	canonical_document, ui_layout, revision_digest, compiled_plan, plan_digest,
	digest_scope, validation, version, edited_by::text, created_at, updated_at,
	published_revision_id::text`

func (s *PipelineStore) scanDraft(row pgx.Row) (Draft, error) {
	var (
		d                               Draft
		canonical, ui, plan, validation []byte
		digest, planDigest, published   *string
	)
	err := row.Scan(&d.ID, &d.PipelineID, &d.Status, &d.DocumentText, &d.SourceKind,
		&d.SourceSHA256, &canonical, &ui, &digest, &plan, &planDigest,
		&d.DigestScope, &validation, &d.Version, &d.EditedBy, &d.CreatedAt, &d.UpdatedAt,
		&published)
	if err != nil {
		return Draft{}, err
	}
	d.CanonicalDocument = canonical
	d.UILayout = orEmptyJSON(ui)
	d.RevisionDigest = derefStr(digest)
	d.CompiledPlan = plan
	d.PlanDigest = derefStr(planDigest)
	d.Validation = validation
	d.PublishedRevisionID = derefStr(published)
	return d, nil
}

// NewDraft is the CreateDraft input. DocumentText is what the author wrote
// (the DB bounds it at 256 KiB); SourceSHA256 is the digest of the exact
// imported bytes (ADR-0021 § 6) so publish can refuse a re-validation race.
type NewDraft struct {
	PipelineID   string
	DocumentText string
	SourceKind   string // manual|yaml_import|assistant|clone (default manual)
	SourceSHA256 string
	UILayout     json.RawMessage
	EditedBy     string
}

// CreateDraft opens a draft (contract § 2.1 route 7).
func (s *PipelineStore) CreateDraft(ctx context.Context, in NewDraft) (Draft, error) {
	sourceKind := in.SourceKind
	if sourceKind == "" {
		sourceKind = "manual"
	}
	d, err := s.scanDraft(s.Pool.QueryRow(ctx, `
		INSERT INTO pipeline_drafts (pipeline_id, document_text, source_kind, source_sha256, ui_layout, edited_by)
		VALUES ($1::uuid, $2, $3, $4, COALESCE(NULLIF($5, '')::jsonb, '{}'::jsonb), $6::uuid)
		RETURNING `+pipDraftColumns,
		in.PipelineID, in.DocumentText, sourceKind, in.SourceSHA256, string(in.UILayout), in.EditedBy))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return Draft{}, ErrPipelineNotFound // no such pipeline to draft against
		}
		return Draft{}, fmt.Errorf("postgres: create draft for pipeline %s: %w", in.PipelineID, err)
	}
	return d, nil
}

// GetDraft reads one draft including the last validate body, so an editor
// reload does not need to revalidate (route 8).
func (s *PipelineStore) GetDraft(ctx context.Context, id string) (Draft, error) {
	d, err := s.scanDraft(s.Pool.QueryRow(ctx, `
		SELECT `+pipDraftColumns+` FROM pipeline_drafts WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, ErrPipelineNotFound
	}
	if err != nil {
		return Draft{}, fmt.Errorf("postgres: get draft %s: %w", id, err)
	}
	return d, nil
}

// ListDrafts returns a pipeline's drafts, newest first (route 6).
func (s *PipelineStore) ListDrafts(ctx context.Context, pipelineID string) ([]Draft, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+pipDraftColumns+` FROM pipeline_drafts
		WHERE pipeline_id = $1::uuid ORDER BY updated_at DESC, id DESC`, pipelineID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list drafts for pipeline %s: %w", pipelineID, err)
	}
	defer rows.Close()
	var out []Draft
	for rows.Next() {
		d, err := s.scanDraft(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan draft: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ReplaceDraftDocument is PUT /drafts/{id}: replace the document under CAS on
// version and re-open it as 'draft' — the previous validation's digests and
// plan describe the OLD bytes, so they are cleared with the write (route 9).
// A nil uiLayout keeps the stored one; the API re-resolves metadata.ui from
// the new document (§ 2.3) and passes the result. A stale version, or a
// published (immutable) draft, is ErrConflict; the caller re-reads the
// winner's version to report stale_draft_version.
func (s *PipelineStore) ReplaceDraftDocument(ctx context.Context, draftID, documentText, sourceSHA256 string, uiLayout json.RawMessage, expectedVersion int, editedBy string) (Draft, error) {
	d, err := s.scanDraft(s.Pool.QueryRow(ctx, `
		UPDATE pipeline_drafts
		SET document_text = $2, source_sha256 = $3, status = 'draft',
		    canonical_document = NULL, revision_digest = NULL,
		    compiled_plan = NULL, plan_digest = NULL,
		    validation = '[]'::jsonb,
		    ui_layout = COALESCE(NULLIF($4, '')::jsonb, ui_layout),
		    version = version + 1, edited_by = $5::uuid, updated_at = now()
		WHERE id = $1::uuid AND version = $6 AND status <> 'published'
		RETURNING `+pipDraftColumns,
		draftID, documentText, sourceSHA256, string(uiLayout), editedBy, expectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, s.draftCasMiss(ctx, draftID, "replace document on")
	}
	if err != nil {
		return Draft{}, fmt.Errorf("postgres: replace draft %s document: %w", draftID, err)
	}
	return d, nil
}

// draftCasMiss distinguishes "no such draft" from "someone else won the CAS"
// after an UPDATE ... WHERE version = $n matched nothing (ADR-0016 § 2's
// loser-reads-the-winner pattern).
func (s *PipelineStore) draftCasMiss(ctx context.Context, draftID, verb string) error {
	var exists bool
	if err := s.Pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pipeline_drafts WHERE id = $1::uuid)`, draftID).Scan(&exists); err != nil {
		return fmt.Errorf("postgres: %s draft %s: check existence: %w", verb, draftID, err)
	}
	if !exists {
		return ErrPipelineNotFound
	}
	return ErrConflict
}

// RecordValidation stores the outcome of one validate pass (route 11): the
// status, the last validate body verbatim, and — only when valid — the
// canonical document, both digests and the compiled plan. An invalid pass
// clears any previous digests so publish cannot read a stale plan.
func (s *PipelineStore) RecordValidation(ctx context.Context, draftID, status string, in DraftValidation) (Draft, error) {
	switch status {
	case "validating", "valid", "invalid":
	default:
		return Draft{}, fmt.Errorf("postgres: draft validation status %q is not a validate outcome", status)
	}
	valid := status == "valid"
	d, err := s.scanDraft(s.Pool.QueryRow(ctx, `
		UPDATE pipeline_drafts
		SET status = $2,
		    canonical_document = CASE WHEN $3::boolean THEN NULLIF($4, '')::jsonb END,
		    revision_digest    = CASE WHEN $3::boolean THEN NULLIF($5, '') END,
		    compiled_plan      = CASE WHEN $3::boolean THEN NULLIF($6, '')::jsonb END,
		    plan_digest        = CASE WHEN $3::boolean THEN NULLIF($7, '') END,
		    digest_scope       = COALESCE(NULLIF($8, ''), digest_scope),
		    validation         = COALESCE(NULLIF($9, '')::jsonb, '[]'::jsonb),
		    updated_at         = now()
		WHERE id = $1::uuid AND status <> 'published'
		RETURNING `+pipDraftColumns,
		draftID, status, valid,
		string(orEmptyJSON(in.CanonicalDocument)), in.RevisionDigest,
		string(orEmptyJSON(in.CompiledPlan)), in.PlanDigest, in.DigestScope,
		string(orEmptyJSON(in.Validation))))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, s.draftCasMiss(ctx, draftID, "record validation for")
	}
	if err != nil {
		return Draft{}, fmt.Errorf("postgres: record validation for draft %s: %w", draftID, err)
	}
	return d, nil
}

// DraftValidation is the RecordValidation input: the compiler's output for a
// valid pass, and the serialized errors body for any pass.
type DraftValidation struct {
	CanonicalDocument json.RawMessage
	RevisionDigest    string
	CompiledPlan      json.RawMessage
	PlanDigest        string
	DigestScope       string // "" keeps the draft's current scope
	Validation        json.RawMessage
}

// ---------------------------------------------------------------- publish

// NewRevision is the PublishDraft input. The canonical document and both
// digests are COPIED from the draft's validated columns — publish never
// accepts new ones — so the only authored choices here are the semver label,
// the regenerated export text, and the two environment digests (ADR-0021 § 6).
type NewRevision struct {
	VersionLabel         string
	DocumentText         string
	SchemaDigest         string
	CelEnvDigest         string
	PublishedBy          string
	ExpectedDraftVersion int
}

// PublishDraft freezes the draft's validated content into an immutable
// revision and marks the draft published, in one transaction (route 12).
// Refusals, all typed before any row is written:
//   - the draft is not at status='valid'        → ErrDraftNotPublishable
//   - its version moved under us (CAS)          → ErrConflict
//   - revision_digest already published in this org → ErrConflict
//     (the API answers 409 revision_already_published; the UNIQUE is the
//     arbiter, per 12 case 11's storage half)
func (s *PipelineStore) PublishDraft(ctx context.Context, draftID string, in NewRevision) (PipelineRevision, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: begin publish tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status                     string
		version                    int
		pipelineID                 string
		orgID                      string
		canonical                  []byte
		revisionDigest, planDigest string
		compiledPlan               []byte
		uiLayout                   []byte
	)
	err = tx.QueryRow(ctx, `
		SELECT d.status, d.version, p.id::text, p.organization_id::text,
		       d.canonical_document, COALESCE(d.revision_digest, ''), d.compiled_plan,
		       COALESCE(d.plan_digest, ''), d.ui_layout
		FROM pipeline_drafts d
		JOIN pipelines p ON p.id = d.pipeline_id
		WHERE d.id = $1::uuid
		FOR UPDATE OF d`, draftID).
		Scan(&status, &version, &pipelineID, &orgID,
			&canonical, &revisionDigest, &compiledPlan, &planDigest, &uiLayout)
	if errors.Is(err, pgx.ErrNoRows) {
		return PipelineRevision{}, ErrPipelineNotFound
	}
	if err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: lock draft %s: %w", draftID, err)
	}
	if status != "valid" {
		return PipelineRevision{}, ErrDraftNotPublishable
	}
	if version != in.ExpectedDraftVersion {
		return PipelineRevision{}, ErrConflict
	}

	rev, err := s.scanRevision(tx.QueryRow(ctx, `
		INSERT INTO pipeline_revisions
			(pipeline_id, draft_id, organization_id, revision_number, version_label,
			 api_version, canonical_document, document_text, ui_layout,
			 revision_digest, compiled_plan, plan_digest, schema_digest, cel_env_digest,
			 published_by)
		SELECT d.pipeline_id, d.id, $2::uuid,
		       COALESCE((SELECT max(revision_number) FROM pipeline_revisions WHERE pipeline_id = d.pipeline_id), 0) + 1,
		       $3, 'communication.dev/v1alpha1', d.canonical_document, $4, d.ui_layout,
		       d.revision_digest, d.compiled_plan, d.plan_digest, $5, $6,
		       $7::uuid
		FROM pipeline_drafts d WHERE d.id = $1::uuid
		RETURNING `+pipRevisionColumns,
		draftID, orgID, in.VersionLabel, in.DocumentText,
		in.SchemaDigest, in.CelEnvDigest, in.PublishedBy))
	if err != nil {
		if pipUniqueErr(err) != nil {
			return PipelineRevision{}, ErrConflict
		}
		return PipelineRevision{}, fmt.Errorf("postgres: publish draft %s: %w", draftID, err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE pipeline_drafts
		SET status = 'published', published_revision_id = $2::uuid,
		    version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $3`, draftID, rev.ID, in.ExpectedDraftVersion); err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: mark draft %s published: %w", draftID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: commit publish: %w", err)
	}
	return rev, nil
}

const pipRevisionColumns = `id, pipeline_id, draft_id, organization_id, revision_number,
	version_label, api_version, canonical_document, document_text, ui_layout,
	revision_digest, digest_scope, compiled_plan, plan_digest, schema_digest, cel_env_digest,
	status, published_by::text, published_at`

func (s *PipelineStore) scanRevision(row pgx.Row) (PipelineRevision, error) {
	var (
		r         PipelineRevision
		canonical []byte
		ui, plan  []byte
	)
	err := row.Scan(&r.ID, &r.PipelineID, &r.DraftID, &r.OrganizationID, &r.RevisionNumber,
		&r.VersionLabel, &r.APIVersion, &canonical, &r.DocumentText, &ui,
		&r.RevisionDigest, &r.DigestScope, &plan, &r.PlanDigest, &r.SchemaDigest, &r.CelEnvDigest,
		&r.Status, &r.PublishedBy, &r.PublishedAt)
	if err != nil {
		return PipelineRevision{}, err
	}
	r.CanonicalDocument = canonical
	r.UILayout = orEmptyJSON(ui)
	r.CompiledPlan = plan
	return r, nil
}

const pipRevisionSelect = `SELECT ` + pipRevisionColumns + ` FROM pipeline_revisions `

// GetRevision reads one revision by id.
func (s *PipelineStore) GetRevision(ctx context.Context, id string) (PipelineRevision, error) {
	r, err := s.scanRevision(s.Pool.QueryRow(ctx, pipRevisionSelect+`WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return PipelineRevision{}, ErrPipelineNotFound
	}
	if err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: get revision %s: %w", id, err)
	}
	return r, nil
}

// ResolveRevision reads one revision inside ONE organization, by id or by
// revision_digest (route 13). A digest that exists only in another
// organization answers ErrPipelineNotFound — that is the 404 the route
// promises, not a lookup failure.
func (s *PipelineStore) ResolveRevision(ctx context.Context, organizationID, digestOrID string) (PipelineRevision, error) {
	r, err := s.scanRevision(s.Pool.QueryRow(ctx, pipRevisionSelect+`
		WHERE organization_id = $1::uuid
		  AND (id = NULLIF($2, '')::uuid OR revision_digest = $2)
		ORDER BY (id = NULLIF($2, '')::uuid) DESC
		LIMIT 1`, organizationID, digestOrID))
	if errors.Is(err, pgx.ErrNoRows) {
		return PipelineRevision{}, ErrPipelineNotFound
	}
	if err != nil {
		return PipelineRevision{}, fmt.Errorf("postgres: resolve revision %q in %s: %w", digestOrID, organizationID, err)
	}
	return r, nil
}

// ListRevisions returns a pipeline's immutable summaries, newest first
// (route 5). The document body is on the row for the resolver routes; list
// callers are expected to project it away.
func (s *PipelineStore) ListRevisions(ctx context.Context, pipelineID string) ([]PipelineRevision, error) {
	rows, err := s.Pool.Query(ctx, pipRevisionSelect+`
		WHERE pipeline_id = $1::uuid ORDER BY revision_number DESC`, pipelineID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list revisions for %s: %w", pipelineID, err)
	}
	defer rows.Close()
	var out []PipelineRevision
	for rows.Next() {
		r, err := s.scanRevision(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan revision: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeprecateRevision marks a published revision deprecated; existing runs are
// untouched (ADR-0002, route 15). A deprecated row deprecating again is a
// no-op, and no other column moves.
func (s *PipelineStore) DeprecateRevision(ctx context.Context, revisionID string) error {
	_, err := s.Pool.Exec(ctx, `
		UPDATE pipeline_revisions SET status = 'deprecated'
		WHERE id = $1::uuid AND status = 'published'`, revisionID)
	if err != nil {
		return fmt.Errorf("postgres: deprecate revision %s: %w", revisionID, err)
	}
	return nil
}

// ------------------------------------------------------------- assignments

const pipAssignmentColumns = `id, project_id, pipeline_id, pinned_revision_id,
	max_concurrent_runs, budget_overrides, enabled, version, created_by::text,
	created_at, updated_at, COALESCE(repository_id::text, '')`

func (s *PipelineStore) scanAssignment(row pgx.Row) (Assignment, error) {
	var (
		a      Assignment
		budget []byte
	)
	if err := row.Scan(&a.ID, &a.ProjectID, &a.PipelineID, &a.PinnedRevisionID,
		&a.MaxConcurrentRuns, &budget, &a.Enabled, &a.Version, &a.CreatedBy,
		&a.CreatedAt, &a.UpdatedAt, &a.RepositoryID); err != nil {
		return Assignment{}, err
	}
	a.BudgetOverrides = orEmptyJSON(budget)
	return a, nil
}

// NewAssignment is the CreateAssignment input (route 18). Budget ceilings are
// validated upstream — a budget_overrides value that raises a limit is a 400
// there, not a constraint here; the DB only bounds max_concurrent_runs.
type NewAssignment struct {
	ProjectID         string
	PipelineID        string
	PinnedRevisionID  string
	MaxConcurrentRuns int // 0 ⇒ the column default (1)
	BudgetOverrides   json.RawMessage
	CreatedBy         string
	// RepositoryID (ADR-0060) is the repository this pipeline is used in;
	// empty means the whole project (the legacy / any-repo meaning).
	RepositoryID string
}

// CreateAssignment pins a published revision to a project. A second
// assignment of one pipeline to one repository (or to the whole project) is
// ErrConflict (UNIQUE (project_id, pipeline_id, repository_id) NULLS NOT
// DISTINCT — ADR-0060).
func (s *PipelineStore) CreateAssignment(ctx context.Context, in NewAssignment) (Assignment, error) {
	a, err := s.scanAssignment(s.Pool.QueryRow(ctx, `
		INSERT INTO assignments
			(project_id, pipeline_id, pinned_revision_id, max_concurrent_runs, budget_overrides, created_by, repository_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, COALESCE(NULLIF($4, 0), 1),
		        COALESCE(NULLIF($5, '')::jsonb, '{}'::jsonb), $6::uuid, NULLIF($7, '')::uuid)
		RETURNING `+pipAssignmentColumns,
		in.ProjectID, in.PipelineID, in.PinnedRevisionID, in.MaxConcurrentRuns,
		string(in.BudgetOverrides), in.CreatedBy, in.RepositoryID))
	if pipUniqueErr(err) != nil {
		return Assignment{}, ErrConflict
	}
	if err != nil {
		return Assignment{}, fmt.Errorf("postgres: create assignment project=%s pipeline=%s: %w",
			in.ProjectID, in.PipelineID, err)
	}
	return a, nil
}

// GetAssignment reads one assignment.
func (s *PipelineStore) GetAssignment(ctx context.Context, id string) (Assignment, error) {
	a, err := s.scanAssignment(s.Pool.QueryRow(ctx, `
		SELECT `+pipAssignmentColumns+` FROM assignments WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, ErrPipelineNotFound
	}
	if err != nil {
		return Assignment{}, fmt.Errorf("postgres: get assignment %s: %w", id, err)
	}
	return a, nil
}

// ListProjectAssignments reads a project's assignments (route 17's rows).
func (s *PipelineStore) ListProjectAssignments(ctx context.Context, projectID string) ([]Assignment, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+pipAssignmentColumns+` FROM assignments
		WHERE project_id = $1::uuid ORDER BY created_at DESC, id DESC`, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list assignments for %s: %w", projectID, err)
	}
	defer rows.Close()
	var out []Assignment
	for rows.Next() {
		a, err := s.scanAssignment(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan assignment: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpdateAssignmentPatch is the PATCH input; nil members do not move (route
// 19). Re-pinning is an explicit promotion: it takes effect at NEW run
// creation only, never on running runs, which keep their pinned revision.
type UpdateAssignmentPatch struct {
	PinnedRevisionID  *string
	MaxConcurrentRuns *int
	BudgetOverrides   *json.RawMessage
	Enabled           *bool
	ExpectedVersion   int
}

// UpdateAssignment applies a PATCH under CAS on version. A stale version is
// ErrConflict; the loser re-reads the winner.
func (s *PipelineStore) UpdateAssignment(ctx context.Context, id string, p UpdateAssignmentPatch) (Assignment, error) {
	a, err := s.scanAssignment(s.Pool.QueryRow(ctx, `
		UPDATE assignments
		SET pinned_revision_id = COALESCE(NULLIF($2, '')::uuid, pinned_revision_id),
		    max_concurrent_runs = COALESCE(NULLIF($3, 0), max_concurrent_runs),
		    budget_overrides = COALESCE(NULLIF($4, '')::jsonb, budget_overrides),
		    enabled = COALESCE($5::boolean, enabled),
		    version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $6
		RETURNING `+pipAssignmentColumns,
		id, derefAnyStr(p.PinnedRevisionID), derefInt(p.MaxConcurrentRuns),
		derefJSON(p.BudgetOverrides), p.Enabled, p.ExpectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := s.Pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM assignments WHERE id = $1::uuid)`, id).Scan(&exists); err != nil {
			return Assignment{}, fmt.Errorf("postgres: update assignment %s: check existence: %w", id, err)
		}
		if !exists {
			return Assignment{}, ErrPipelineNotFound
		}
		return Assignment{}, ErrConflict
	}
	if pipUniqueErr(err) != nil {
		return Assignment{}, ErrConflict
	}
	if err != nil {
		return Assignment{}, fmt.Errorf("postgres: update assignment %s: %w", id, err)
	}
	return a, nil
}

// DeleteAssignment removes an assignment (route 20); running runs keep their
// pinned revision and policies_snapshot because runs reference the revision
// row, not the assignment, for everything that executes.
func (s *PipelineStore) DeleteAssignment(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM assignments WHERE id = $1::uuid`, id)
	if err != nil {
		// A run still pointing at the assignment is a FK refusal, not a
		// miss: the API answers 409 with that fact.
		return fmt.Errorf("postgres: delete assignment %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return ErrPipelineNotFound
	}
	return nil
}

// ---------------------------------------------------------------- helpers

// pipUniqueErr maps 23505 (and composite-key 23P01) onto ErrConflict and
// returns every other error unchanged.
// pipUniqueErr maps 23505 (and composite-key 23P01) onto ErrConflict and
// returns nil for every other error — the callers test the answer with
// `!= nil`, so a pass-through of the real error would mask it as a conflict.
func pipUniqueErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "23P01") {
		return ErrConflict
	}
	return nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefAnyStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

func derefJSON(j *json.RawMessage) string {
	if j == nil || len(*j) == 0 {
		return ""
	}
	return string(*j)
}

func orEmptyJSON(b json.RawMessage) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("{}")
	}
	return b
}
