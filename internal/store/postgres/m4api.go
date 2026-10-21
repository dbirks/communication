package postgres

// The M4 serve-side wiring (docs/m4-contract.md § 2/§ 5): the postgres
// adapters behind the api-layer store interfaces (RegisterPipelines,
// RegisterRuns, RegisterApprovals, RegisterScheduler), the pipeline
// definition service (loader → schema → canon → digest → compiler glue over
// the committed internal/pipelines packages), the advancer tick, the
// reconciler's M4 passes, and the ChildResolver behind pipeline.invoke.
//
// Two rules govern every adapter here, mirroring the handlers' comments:
//
//   - The permission predicate is part of the SQL. A run, draft, revision,
//     gate or assignment the caller may not see answers the package's
//     not-found sentinel — the same bytes nonsense produces (contract § 2.1
//     route 13), never a peek.
//   - Every mutation writes state + its § 3 journal row in ONE transaction.
//     The committed single-statement methods (PipelineStore.PublishDraft et
//     al.) stay authoritative for callers without an event to append; the
//     API writes below re-run those exact statements inside a tx so the
//     append rides the same commit (ADR-0013/0016).
//
// The engine is never re-implemented here: every run advance is a
// runtime.Advancer pass over a postgres.RuntimeStore hydration (the
// committed hydrate-per-transaction adapter), every gate decision goes
// through the committed RuntimeStore.Decide CAS, and every child run pins
// the digests its resolved revision already carries.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	yaml "go.yaml.in/yaml/v3"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

var (
	_ api.PipelineStore             = APIPipelineStore{}
	_ api.RunStore                  = APIRunStore{}
	_ api.AssignmentStore           = APIAssignmentStore{}
	_ api.ApprovalStore             = APIApprovalStore{}
	_ api.RunEventStream            = APIRunEventStream{}
	_ api.SchedulerStore            = APISchedulerStore{}
	_ api.PipelineDefinitionService = (*PipelineDefinitions)(nil)
	_ runtime.ChildResolver         = (*M4Children)(nil)
)

// m4Pool resolves an adapter's pool or refuses with a plain error — an
// unwired adapter answers 500, never a nil-deref panic mid-handler.
func m4Pool(pool *pgxpool.Pool, what string) (*pgxpool.Pool, error) {
	if pool == nil {
		return nil, fmt.Errorf("postgres: %s has no pool", what)
	}
	return pool, nil
}

// m4Denied writes the audit row for a refused read or mutation of an
// M4-family resource. The owning project is resolved from the id where one
// exists (runs, gates, assignments, and the run-family node execution /
// attempt ids APIRunStore.RecordDenied also receives, via their run);
// definitions are org-scoped and have none (audit_events.project_id is
// nullable — api/pipelines.go's rule).
func m4Denied(ctx context.Context, pool *pgxpool.Pool, c api.Caller, resourceID, action string) error {
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return err
	}
	var projectID string
	if prjValidUUID(resourceID) {
		err := pool.QueryRow(ctx, `
			SELECT COALESCE(
				(SELECT project_id::text FROM runs WHERE id = $1::uuid),
				(SELECT project_id::text FROM approval_requests WHERE id = $1::uuid),
				(SELECT project_id::text FROM assignments WHERE id = $1::uuid),
				(SELECT r.project_id::text FROM node_executions ne
					JOIN runs r ON r.id = ne.run_id WHERE ne.id = $1::uuid),
				(SELECT r.project_id::text FROM attempts att
					JOIN runs r ON r.id = att.run_id WHERE att.id = $1::uuid),
				'')`, resourceID).Scan(&projectID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("postgres: resolve denial project for %s: %w", resourceID, err)
		}
	}
	detail := fmt.Sprintf(`{"action":%q,"resource_id":%q}`, action, resourceID)
	_, err := pool.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, 'human', $3, $4, 'denied', $5::jsonb)`,
		c.OrganizationID, prjCleanUUID(projectID), c.UserID, action, detail)
	if err != nil {
		return fmt.Errorf("postgres: record m4 denial: %w", err)
	}
	return nil
}

// m4DraftConflict maps the § 2.2 publish-time code vocabulary onto the
// shared error type the pipeline handlers render.
func m4DraftConflict(kind, detail, draftID string) *api.DraftConflictError {
	return &api.DraftConflictError{Kind: kind, Detail: detail, DraftID: draftID}
}

// m4DiagsToValidateErrors converts a diagnostic list to the § 2.2 error
// units. The list arrives already ordered by the diag contract
// (SortOrder: instance_location, schema_location, code, message); this only
// restates the members in snake_case form.
func m4DiagsToValidateErrors(d diag.List) []api.ValidateError {
	out := make([]api.ValidateError, 0, len(d))
	for _, x := range d {
		e := api.ValidateError{
			Code:    string(x.Code),
			Source:  string(x.Source),
			Message: x.Message,
			Hint:    x.Hint,
		}
		loc := string(x.InstanceLocation)
		if loc == "" {
			loc = "/"
		}
		e.InstanceLocation = &loc
		if x.SchemaLocation != "" {
			sl := x.SchemaLocation
			e.SchemaLocation = &sl
		}
		out = append(out, e)
	}
	return out
}

// m4AuditPipelineDenied is the PipelineStore.RecordDenied face.
func m4AuditPipelineDenied(ctx context.Context, pool *pgxpool.Pool, c api.Caller, resourceID, action string) error {
	return m4Denied(ctx, pool, c, resourceID, action)
}

// m4AppendAppendable appends one § 3 row through the generic journal
// append (org-scoped pipeline/assignment events have no run to correlate
// on; runAppendTx would refuse them for exactly that reason).
func m4AppendAppendable(ctx context.Context, tx pgx.Tx, typ, orgID, projectID, actorID string, payload any) error {
	kind := events.ActorKindHuman
	if actorID == "" {
		kind, actorID = events.ActorKindSystem, "system"
	}
	_, err := AppendEvent(ctx, tx, events.New{
		Type:           typ,
		OrganizationID: orgID,
		ProjectID:      projectID,
		Actor:          events.Actor{Kind: kind, ID: actorID},
		Payload:        payload,
	})
	return err
}

// discardM4Log is the fallback logger for adapters built without one.
func discardM4Log() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// m4UniqueViolation reports a 23505 anywhere under a wrapped error chain.
func m4UniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// =================================================================== pipelines

// APIPipelineStore exposes a *PipelineStore as api.PipelineStore (routes
// 1–16). Every read carries the caller's ORGANIZATION in its SQL — a
// pipeline, draft or revision digest of another organization answers
// api.ErrPipelineNotFound, byte-identical to nonsense — and every mutation
// appends its § 3 row in the same transaction as its state write.
//
// UpdatePipeline is route 4's metadata-only UPDATE: the statement the
// committed PipelineStore never carried (it only had ArchivePipeline), added
// here because the handler needs the nil-means-unchanged PATCH semantics.
type APIPipelineStore struct {
	S *PipelineStore
	// ExtractUI re-resolves metadata.ui from a replaced document (route 9:
	// "the stored metadata.ui is re-resolved from the new document inside
	// the adapter"). nil keeps the stored layout — an adapter built without
	// the loader seam never loses data, it just does not repaint.
	ExtractUI func(documentYAML string) (json.RawMessage, error)
}

func (a APIPipelineStore) pool() (*pgxpool.Pool, error) {
	if a.S == nil {
		return nil, errors.New("postgres: APIPipelineStore has no store")
	}
	return m4Pool(a.S.Pool, "APIPipelineStore")
}

// m4PipelineShape is pipPipelineShape under the caller's organization.
const m4PipelineShape = pipPipelineShape + `
	WHERE p.organization_id = $1::uuid`

// m4PipelineFrom is pipPipelineShape's FROM/JOIN tail without its SELECT list,
// for the routes that project a narrower shape than the full
// pipeline row (route 1's summary). pipPipelineShape already carries its own
// SELECT, so a caller that prepends its own list must reuse this tail and not
// the full shape.
const m4PipelineFrom = `
	FROM pipelines p
	LEFT JOIN LATERAL (
		SELECT max(revision_number) AS latest, count(*) AS total
		FROM pipeline_revisions pr WHERE pr.pipeline_id = p.id
	) r ON true
	WHERE p.organization_id = $1::uuid`

func m4PipelineView(p Pipeline) api.PipelineView {
	return api.PipelineView{
		ID: p.ID, Slug: p.Slug, DisplayName: p.DisplayName, Description: p.Description,
		Folder:    p.Folder,
		CreatedBy: p.CreatedBy, CreatedAt: p.CreatedAt,
		LatestRevisionNumber: p.LatestRevisionNumber, RevisionCount: p.RevisionCount,
		Archived:  p.ArchivedAt != nil,
		Revisions: []api.RevisionSummaryView{},
	}
}

func m4RevisionSummaries(revs []PipelineRevision) []api.RevisionSummaryView {
	out := make([]api.RevisionSummaryView, 0, len(revs))
	for _, r := range revs {
		out = append(out, api.RevisionSummaryView{
			RevisionNumber: r.RevisionNumber, VersionLabel: r.VersionLabel,
			RevisionDigest: r.RevisionDigest, PlanDigest: r.PlanDigest,
			DigestScope: r.DigestScope, PublishedAt: r.PublishedAt,
			PublishedBy: r.PublishedBy, Status: r.Status,
		})
	}
	return out
}

func (a APIPipelineStore) ListPipelines(ctx context.Context, c api.Caller) ([]api.PipelineSummaryView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT p.id, p.slug, p.display_name, p.folder, COALESCE(r.latest, 0), COALESCE(r.total, 0),
		       p.archived_at IS NOT NULL
		`+m4PipelineFrom+`
		ORDER BY p.slug`, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list pipelines: %w", err)
	}
	defer rows.Close()
	out := []api.PipelineSummaryView{}
	for rows.Next() {
		var v api.PipelineSummaryView
		var archived bool
		if err := rows.Scan(&v.ID, &v.Slug, &v.DisplayName, &v.Folder, &v.LatestRevisionNumber,
			&v.RevisionCount, &archived); err != nil {
			return nil, fmt.Errorf("postgres: scan api pipeline: %w", err)
		}
		v.Archived = archived
		out = append(out, v)
	}
	return out, rows.Err()
}

// CreatePipeline is route 2's write: the logical definition plus its
// pipeline.created row, one commit. A duplicate slug in the organization is
// the plain 409 (api.ErrPipelineConflict).
func (a APIPipelineStore) CreatePipeline(ctx context.Context, c api.Caller, slug, displayName, description string) (api.PipelineView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.PipelineView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.PipelineView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: begin create pipeline: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pipe Pipeline
	err = tx.QueryRow(ctx, `
		INSERT INTO pipelines (organization_id, slug, display_name, description, created_by)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING id::text, organization_id::text, slug, display_name, description,
		          created_by::text, created_at, archived_at`,
		c.OrganizationID, slug, displayName, description, c.UserID).
		Scan(&pipe.ID, &pipe.OrganizationID, &pipe.Slug, &pipe.DisplayName,
			&pipe.Description, &pipe.CreatedBy, &pipe.CreatedAt, &pipe.ArchivedAt)
	if pipUniqueErr(err) != nil {
		return api.PipelineView{}, api.ErrPipelineConflict
	}
	if err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: api create pipeline %q: %w", slug, err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineCreated, pipe.OrganizationID, "",
		c.UserID, events.PipelineCreatedPayload{PipelineID: pipe.ID, Slug: pipe.Slug}); err != nil {
		return api.PipelineView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: commit create pipeline: %w", err)
	}
	return m4PipelineView(pipe), nil
}

func (a APIPipelineStore) GetPipeline(ctx context.Context, c api.Caller, pipelineID string) (api.PipelineView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.PipelineView{}, err
	}
	if !prjValidUUID(pipelineID) {
		return api.PipelineView{}, api.ErrPipelineNotFound
	}
	pipe, err := a.S.scanPipeline(pool.QueryRow(ctx, m4PipelineShape+` AND p.id = $2::uuid`,
		c.OrganizationID, pipelineID))
	if errors.Is(err, pgx.ErrNoRows) {
		return api.PipelineView{}, api.ErrPipelineNotFound
	}
	if err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: api get pipeline %s: %w", pipelineID, err)
	}
	revs, err := a.ListPipelineRevisions(ctx, c, pipelineID)
	if err != nil {
		return api.PipelineView{}, err
	}
	view := m4PipelineView(pipe)
	view.Revisions = revs
	return view, nil
}

// UpdatePipeline is route 4: metadata only — nil patch members do not
// move, and no column this touches can reach a revision, a draft or a run.
// ADR-0049 § 8: `folder` rides the same PATCH — its three wire states are
// absent (untouched), JSON null (cleared) and a string (set) — and the
// pipeline.update journal row (ADR-0049 § 7) lands in the same
// transaction, naming the members that moved.
func (a APIPipelineStore) UpdatePipeline(ctx context.Context, c api.Caller, pipelineID string,
	in api.PipelineUpdateInput) (api.PipelineView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.PipelineView{}, err
	}
	if !prjValidUUID(pipelineID) {
		return api.PipelineView{}, api.ErrPipelineNotFound
	}
	// folderMode: 0 absent (untouched), 1 JSON null (clear), 2 set.
	folderMode := 0
	var folderVal *string
	if in.Folder.Set {
		folderMode, folderVal = 2, &in.Folder.Value
	} else if in.Folder.Clear {
		folderMode = 1
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: begin update pipeline: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var pipe Pipeline
	err = tx.QueryRow(ctx, `
		UPDATE pipelines
		SET display_name = COALESCE($3, display_name),
		    description  = COALESCE($4, description),
		    archived_at  = CASE
		        WHEN $5::boolean IS NULL THEN archived_at
		        WHEN $5::boolean       THEN COALESCE(archived_at, now())
		        ELSE NULL END,
		    folder       = CASE
		        WHEN $6::int = 0 THEN folder
		        WHEN $6::int = 1 THEN NULL
		        ELSE $7 END
		WHERE id = $2::uuid AND organization_id = $1::uuid
		RETURNING id, organization_id, slug, display_name, description, folder,
		          created_by::text, created_at, archived_at`,
		c.OrganizationID, pipelineID, in.DisplayName, in.Description, in.Archived,
		folderMode, folderVal).
		Scan(&pipe.ID, &pipe.OrganizationID, &pipe.Slug, &pipe.DisplayName, &pipe.Description,
			&pipe.Folder, &pipe.CreatedBy, &pipe.CreatedAt, &pipe.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.PipelineView{}, api.ErrPipelineNotFound
	}
	if err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: api update pipeline %s: %w", pipelineID, err)
	}
	// The journal row names the members the PATCH moved — `folder`
	// whenever it set or cleared the group (ADR-0049 § 7).
	changed := []string{}
	if in.DisplayName != nil {
		changed = append(changed, "display_name")
	}
	if in.Description != nil {
		changed = append(changed, "description")
	}
	if in.Archived != nil {
		changed = append(changed, "archived")
	}
	if in.Folder.Set || in.Folder.Clear {
		changed = append(changed, "folder")
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineUpdate, pipe.OrganizationID, "",
		c.UserID, events.PipelineUpdatePayload{
			ProjectID: "", PipelineID: pipe.ID, ChangedFields: changed,
		}); err != nil {
		return api.PipelineView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.PipelineView{}, fmt.Errorf("postgres: commit update pipeline: %w", err)
	}
	view := m4PipelineView(pipe)
	view.Revisions = []api.RevisionSummaryView{}
	return view, nil
}

func (a APIPipelineStore) ListPipelineRevisions(ctx context.Context, c api.Caller, pipelineID string) ([]api.RevisionSummaryView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	if !prjValidUUID(pipelineID) {
		return nil, api.ErrPipelineNotFound
	}
	var visible bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pipelines WHERE id = $2::uuid AND organization_id = $1::uuid)`,
		c.OrganizationID, pipelineID).Scan(&visible); err != nil {
		return nil, fmt.Errorf("postgres: api pipeline visibility: %w", err)
	}
	if !visible {
		return nil, api.ErrPipelineNotFound
	}
	revs, err := a.S.ListRevisions(ctx, pipelineID)
	if err != nil {
		return nil, err
	}
	return m4RevisionSummaries(revs), nil
}

func (a APIPipelineStore) ListPipelineDrafts(ctx context.Context, c api.Caller, pipelineID string) ([]api.DraftSummaryView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	if !prjValidUUID(pipelineID) {
		return nil, api.ErrPipelineNotFound
	}
	var visible bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pipelines WHERE id = $2::uuid AND organization_id = $1::uuid)`,
		c.OrganizationID, pipelineID).Scan(&visible); err != nil {
		return nil, fmt.Errorf("postgres: api pipeline visibility: %w", err)
	}
	if !visible {
		return nil, api.ErrPipelineNotFound
	}
	drafts, err := a.S.ListDrafts(ctx, pipelineID)
	if err != nil {
		return nil, err
	}
	out := make([]api.DraftSummaryView, 0, len(drafts))
	for _, d := range drafts {
		out = append(out, api.DraftSummaryView{
			ID: d.ID, Status: d.Status, Version: d.Version, UpdatedAt: d.UpdatedAt, EditedBy: d.EditedBy,
		})
	}
	return out, nil
}

// CreateDraft (route 7) stores exactly the bytes the handler hashed — the
// committed CreateDraft is the whole write (no § 3 row is listed for
// creation; pipeline.draft.updated belongs to PUT, route 9).
func (a APIPipelineStore) CreateDraft(ctx context.Context, c api.Caller, pipelineID string,
	in api.DraftCreateInput) (api.DraftView, error) {
	if _, err := a.pool(); err != nil {
		return api.DraftView{}, err
	}
	if !prjValidUUID(pipelineID) {
		return api.DraftView{}, api.ErrPipelineNotFound
	}
	pool := a.S.Pool
	var visible bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pipelines WHERE id = $2::uuid AND organization_id = $1::uuid)`,
		c.OrganizationID, pipelineID).Scan(&visible); err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: api draft pipeline visibility: %w", err)
	}
	if !visible {
		return api.DraftView{}, api.ErrPipelineNotFound
	}
	d, err := a.S.CreateDraft(ctx, NewDraft{
		PipelineID: pipelineID, DocumentText: in.DocumentYAML,
		SourceKind: in.SourceKind, SourceSHA256: in.SourceSHA256, EditedBy: c.UserID,
	})
	if err != nil {
		if errors.Is(err, ErrPipelineNotFound) || errors.Is(err, pgx.ErrNoRows) {
			return api.DraftView{}, api.ErrPipelineNotFound
		}
		return api.DraftView{}, err
	}
	return m4DraftView(d), nil
}

func m4DraftView(d Draft) api.DraftView {
	v := api.DraftView{
		ID: d.ID, PipelineID: d.PipelineID, Status: d.Status,
		DocumentYAML: d.DocumentText, SourceKind: d.SourceKind, SourceSHA256: d.SourceSHA256,
		UILayout: d.UILayout, Validation: d.Validation, DigestScope: d.DigestScope,
		Version: d.Version, EditedBy: d.EditedBy, CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt,
		CanonicalDocument: d.CanonicalDocument,
	}
	if d.RevisionDigest != "" {
		s := d.RevisionDigest
		v.RevisionDigest = &s
	}
	if d.PlanDigest != "" {
		s := d.PlanDigest
		v.PlanDigest = &s
	}
	if d.PublishedRevisionID != "" {
		s := d.PublishedRevisionID
		v.PublishedRevisionID = &s
	}
	return v
}

// m4OrgDraftColumns is pipDraftColumns qualified for m4OrgDraft's join: under
// `pipeline_drafts d JOIN pipelines p` the bare `id`/`created_at` of
// pipDraftColumns answer 42702 column reference "id" is ambiguous.
const m4OrgDraftColumns = `d.id, d.pipeline_id, d.status, d.document_text, d.source_kind, d.source_sha256,
	d.canonical_document, d.ui_layout, d.revision_digest, d.compiled_plan, d.plan_digest,
	d.digest_scope, d.validation, d.version, d.edited_by::text, d.created_at, d.updated_at,
	d.published_revision_id::text`

// m4OrgDraft reads one draft with its pipeline's organization — the org
// predicate the committed GetDraft does not carry (drafts are read by id at
// the routes, and an id of another organization must answer not-found).
func m4OrgDraft(ctx context.Context, pool *pgxpool.Pool, s *PipelineStore, orgID, draftID string) (Draft, string, error) {
	d, err := s.scanDraft(pool.QueryRow(ctx, `
		SELECT `+m4OrgDraftColumns+`
		FROM pipeline_drafts d JOIN pipelines p ON p.id = d.pipeline_id
		WHERE d.id = $2::uuid AND p.organization_id = $1::uuid`, orgID, draftID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, "", api.ErrPipelineNotFound
	}
	if err != nil {
		return Draft{}, "", fmt.Errorf("postgres: api get draft %s: %w", draftID, err)
	}
	return d, d.PipelineID, nil
}

func (a APIPipelineStore) GetDraft(ctx context.Context, c api.Caller, draftID string) (api.DraftView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.DraftView{}, err
	}
	if !prjValidUUID(draftID) {
		return api.DraftView{}, api.ErrPipelineNotFound
	}
	d, _, err := m4OrgDraft(ctx, pool, a.S, c.OrganizationID, draftID)
	if err != nil {
		return api.DraftView{}, err
	}
	return m4DraftView(d), nil
}

// ReplaceDraft is PUT under CAS. The committed ReplaceDraftDocument
// statement is re-run inside a transaction that also appends
// pipeline.draft.updated (§ 3 row 32 — hashes and versions, never the body),
// and metadata.ui is re-resolved from the new document (route 9).
func (a APIPipelineStore) ReplaceDraft(ctx context.Context, c api.Caller, draftID, documentYAML,
	sourceSHA256 string, expectedVersion int) (api.DraftView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.DraftView{}, err
	}
	if !prjValidUUID(draftID) {
		return api.DraftView{}, api.ErrPipelineNotFound
	}
	var ui string
	if a.ExtractUI != nil {
		raw, uerr := a.ExtractUI(documentYAML)
		if uerr == nil && len(raw) > 0 {
			ui = string(raw)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: begin replace draft: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var orgID string
	if err := tx.QueryRow(ctx, `
		SELECT p.organization_id::text FROM pipeline_drafts d
		JOIN pipelines p ON p.id = d.pipeline_id WHERE d.id = $1::uuid`, draftID).
		Scan(&orgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.DraftView{}, api.ErrPipelineNotFound
		}
		return api.DraftView{}, fmt.Errorf("postgres: resolve draft %s org: %w", draftID, err)
	}
	if orgID != c.OrganizationID {
		return api.DraftView{}, api.ErrPipelineNotFound
	}

	d, err := a.S.scanDraft(tx.QueryRow(ctx, `
		UPDATE pipeline_drafts
		SET document_text = $2, source_sha256 = $3, status = 'draft',
		    canonical_document = NULL, revision_digest = NULL,
		    compiled_plan = NULL, plan_digest = NULL,
		    validation = '[]'::jsonb,
		    ui_layout = COALESCE(NULLIF($4, '')::jsonb, ui_layout),
		    version = version + 1, edited_by = $5::uuid, updated_at = now()
		WHERE id = $1::uuid AND version = $6 AND status <> 'published'
		RETURNING `+pipDraftColumns,
		draftID, documentYAML, sourceSHA256, ui, c.UserID, expectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		var status string
		var version int
		probe := tx.QueryRow(ctx, `SELECT status, version FROM pipeline_drafts WHERE id = $1::uuid`,
			draftID).Scan(&status, &version)
		if errors.Is(probe, pgx.ErrNoRows) {
			return api.DraftView{}, api.ErrPipelineNotFound
		}
		if probe != nil {
			return api.DraftView{}, fmt.Errorf("postgres: draft cas probe %s: %w", draftID, probe)
		}
		if status == "published" {
			return api.DraftView{}, m4DraftConflict(api.DraftConflictPublished,
				"a published draft is a revision's audit trail, not a mutable document", draftID)
		}
		return api.DraftView{}, &api.DraftConflictError{
			Kind: api.DraftConflictStaleVersion, DraftID: draftID, CurrentVersion: version,
			Detail: fmt.Sprintf("draft version is %d, not %d.", version, expectedVersion),
		}
	}
	if err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: api replace draft %s: %w", draftID, err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineDraftUpdated, orgID, "",
		c.UserID, events.PipelineDraftUpdatedPayload{
			DraftID: d.ID, Version: d.Version, SourceSHA256: d.SourceSHA256,
			EditedBy: c.UserID, Kind: "manual",
		}); err != nil {
		return api.DraftView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: commit replace draft: %w", err)
	}
	return m4DraftView(d), nil
}

func (a APIPipelineStore) DeleteDraft(ctx context.Context, c api.Caller, draftID string) error {
	pool, err := a.pool()
	if err != nil {
		return err
	}
	d, _, err := m4OrgDraft(ctx, pool, a.S, c.OrganizationID, draftID)
	if err != nil {
		return err
	}
	if d.Status == "published" {
		return m4DraftConflict(api.DraftConflictPublished,
			"this draft is already published and immutable", d.ID)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM pipeline_drafts WHERE id = $1::uuid`, draftID); err != nil {
		return fmt.Errorf("postgres: api delete draft %s: %w", draftID, err)
	}
	return nil
}

// RecordValidation is route 11's write: status + the body verbatim + the
// compiler output, with pipeline.draft.validated appended codes-only in the
// same commit (§ 3 row 33).
func (a APIPipelineStore) RecordValidation(ctx context.Context, c api.Caller, draftID string,
	in api.DraftValidationRecord) (api.DraftView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.DraftView{}, err
	}
	var orgID string
	if err := pool.QueryRow(ctx, `
		SELECT p.organization_id::text FROM pipeline_drafts d
		JOIN pipelines p ON p.id = d.pipeline_id WHERE d.id = $1::uuid`, draftID).
		Scan(&orgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.DraftView{}, api.ErrPipelineNotFound
		}
		return api.DraftView{}, fmt.Errorf("postgres: resolve draft %s org: %w", draftID, err)
	}
	if orgID != c.OrganizationID {
		return api.DraftView{}, api.ErrPipelineNotFound
	}
	body, err := json.Marshal(in.Body)
	if err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: encode validate body: %w", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: begin record validation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	d, err := a.S.scanDraft(tx.QueryRow(ctx, `
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
		draftID, in.Status, in.Status == "valid",
		string(orEmptyJSON(in.CanonicalDocument)), in.RevisionDigest,
		string(orEmptyJSON(in.CompiledPlan)), in.PlanDigest, in.DigestScope,
		string(body)))
	if errors.Is(err, pgx.ErrNoRows) {
		return api.DraftView{}, a.S.draftCasMiss(ctx, draftID, "record validation for")
	}
	if err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: api record validation %s: %w", draftID, err)
	}
	codes := make([]string, 0, len(in.Body.Errors))
	for _, e := range in.Body.Errors {
		codes = append(codes, e.Code)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineDraftValidated, orgID, "",
		c.UserID, events.PipelineDraftValidatedPayload{
			DraftID: d.ID, Valid: in.Body.Valid, RevisionDigest: in.RevisionDigest,
			PlanDigest: in.PlanDigest, ErrorCount: len(codes), ErrorCodes: codes,
		}); err != nil {
		return api.DraftView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.DraftView{}, fmt.Errorf("postgres: commit record validation: %w", err)
	}
	return m4DraftView(d), nil
}

// PublishDraft is route 12's freeze. The committed PublishDraft statement
// pair is re-run inside one transaction with pipeline.revision.published
// (§ 3 row 34); the three refusals keep their own arms:
//
//   - draft not at status='valid'     → draft_not_valid (never a revalidate)
//   - CAS miss                        → stale_draft_version with the winner
//   - org digest collision            → revision_already_published with the
//     existing revision id (the UNIQUE (organization_id, revision_digest)
//     is the arbiter, read back after the 23505)
func (a APIPipelineStore) PublishDraft(ctx context.Context, c api.Caller, draftID string,
	in api.DraftPublishInput) (api.RevisionView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.RevisionView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: begin publish: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status     string
		version    int
		orgID      string
		draftRevID string
	)
	err = tx.QueryRow(ctx, `
		SELECT d.status, d.version, p.organization_id::text, COALESCE(d.revision_digest, '')
		FROM pipeline_drafts d JOIN pipelines p ON p.id = d.pipeline_id
		WHERE d.id = $1::uuid
		FOR UPDATE OF d`, draftID).
		Scan(&status, &version, &orgID, &draftRevID)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.RevisionView{}, api.ErrPipelineNotFound
	}
	if err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: lock draft %s: %w", draftID, err)
	}
	if orgID != c.OrganizationID {
		return api.RevisionView{}, api.ErrPipelineNotFound
	}
	if status == "published" {
		return api.RevisionView{}, m4DraftConflict(api.DraftConflictPublished,
			"this draft is already published and immutable", draftID)
	}
	if status != "valid" {
		return api.RevisionView{}, m4DraftConflict(api.DraftConflictNotValid,
			"the draft's current validation is not valid; validate it again after editing", draftID)
	}
	if version != in.ExpectedVersion {
		return api.RevisionView{}, &api.DraftConflictError{
			Kind: api.DraftConflictStaleVersion, DraftID: draftID, CurrentVersion: version,
			Detail: fmt.Sprintf("draft version is %d, not %d.", version, in.ExpectedVersion),
		}
	}

	rev, err := a.S.scanRevision(tx.QueryRow(ctx, `
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
		in.SchemaDigest, in.CelEnvDigest, c.UserID))
	if err != nil {
		if m4UniqueViolation(err) {
			// The 23505 aborts this transaction, so the read-back that
			// names the winner runs on the pool, not on tx.
			existing := a.revisionIDForDigest(ctx, pool, orgID, draftRevID)
			return api.RevisionView{}, &api.DraftConflictError{
				Kind: api.DraftConflictAlreadyPublished, DraftID: draftID,
				ExistingRevisionID: existing,
				Detail: fmt.Sprintf("a revision with this document's digest is already published (%s).",
					existing),
			}
		}
		return api.RevisionView{}, fmt.Errorf("postgres: api publish draft %s: %w", draftID, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE pipeline_drafts
		SET status = 'published', published_revision_id = $2::uuid,
		    version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $3`, draftID, rev.ID, in.ExpectedVersion); err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: mark draft %s published: %w", draftID, err)
	}
	// ADR-0049 § 2.4: one pipeline_revision_template_refs row per (node,
	// template) in the SAME transaction as the revision row. The pins are
	// already in the compiled plan (validated against the org's registry),
	// so publish extracts them instead of re-resolving.
	if err := insertRevisionTemplateRefs(ctx, tx, rev.ID, rev.CompiledPlan); err != nil {
		return api.RevisionView{}, err
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineRevisionPublished, orgID, "",
		c.UserID, events.PipelineRevisionPublishedPayload{
			PipelineID: rev.PipelineID, RevisionID: rev.ID, RevisionNumber: rev.RevisionNumber,
			VersionLabel: rev.VersionLabel, RevisionDigest: rev.RevisionDigest,
			PlanDigest: rev.PlanDigest, DigestScope: rev.DigestScope,
			SchemaDigest: rev.SchemaDigest, CelEnvDigest: rev.CelEnvDigest,
		}); err != nil {
		return api.RevisionView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: commit publish: %w", err)
	}
	return m4RevisionView(rev), nil
}

// insertRevisionTemplateRefs writes the ADR-0049 § 2.4 refs rows: one per
// templateRefs entry the compiler pinned on a plan node. The plan is the
// source of truth — it was compiled (and its digest taken) against the
// org's registry at validate, so what the refs table says is exactly what
// the pinned plan says.
func insertRevisionTemplateRefs(ctx context.Context, tx pgx.Tx, revisionID string, compiledPlan []byte) error {
	if len(compiledPlan) == 0 {
		return nil
	}
	var plan struct {
		Nodes []struct {
			ID           string `json:"id"`
			TemplateRefs []struct {
				TemplateID         string `json:"template_id"`
				TemplateRevisionID string `json:"template_revision_id"`
			} `json:"templateRefs"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(compiledPlan, &plan); err != nil {
		return fmt.Errorf("postgres: read template pins from compiled plan: %w", err)
	}
	for _, n := range plan.Nodes {
		for _, ref := range n.TemplateRefs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO pipeline_revision_template_refs
					(pipeline_revision_id, template_id, template_revision_id, node_id)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
				revisionID, ref.TemplateID, ref.TemplateRevisionID, n.ID); err != nil {
				return fmt.Errorf("postgres: insert pipeline revision template refs: %w", err)
			}
		}
	}
	return nil
}

// revisionIDForDigest reads back the winning revision after a digest-collision
// 23505, so the 409 body can name it. An unresolvable digest (someone
// deleted? nothing can) yields "" and the client re-reads the revision list.
func (a APIPipelineStore) revisionIDForDigest(ctx context.Context, pool *pgxpool.Pool, orgID, digest string) string {
	if digest == "" {
		return ""
	}
	var id string
	if err := pool.QueryRow(ctx, `
		SELECT id::text FROM pipeline_revisions
		WHERE organization_id = $1::uuid AND revision_digest = $2 LIMIT 1`, orgID, digest).
		Scan(&id); err != nil {
		return ""
	}
	return id
}

func m4RevisionView(r PipelineRevision) api.RevisionView {
	return api.RevisionView{
		ID: r.ID, PipelineID: r.PipelineID, RevisionNumber: r.RevisionNumber,
		VersionLabel: r.VersionLabel, APIVersion: r.APIVersion,
		CanonicalDocument: r.CanonicalDocument, DocumentText: r.DocumentText,
		UILayout: r.UILayout, RevisionDigest: r.RevisionDigest, DigestScope: r.DigestScope,
		CompiledPlan: r.CompiledPlan, PlanDigest: r.PlanDigest,
		SchemaDigest: r.SchemaDigest, CelEnvDigest: r.CelEnvDigest,
		Status: r.Status, PublishedBy: r.PublishedBy, PublishedAt: r.PublishedAt,
	}
}

// GetRevision resolves by id OR revision_digest inside the caller's
// organization (route 13): a digest held only by another organization, a
// nonsense reference and a deleted id all answer the uniform not-found, so
// none of the three is distinguishable from the outside.
func (a APIPipelineStore) GetRevision(ctx context.Context, c api.Caller, digestOrID string) (api.RevisionView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.RevisionView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.RevisionView{}, err
	}
	r, err := a.S.scanRevision(pool.QueryRow(ctx, pipRevisionSelect+`
		WHERE organization_id = $1::uuid AND `+m4RevisionRefPredicate(digestOrID)+`
		LIMIT 1`, c.OrganizationID, digestOrID))
	if errors.Is(err, pgx.ErrNoRows) {
		return api.RevisionView{}, api.ErrPipelineNotFound
	}
	if err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: api resolve revision %s in %s: %w", digestOrID, c.OrganizationID, err)
	}
	return m4RevisionView(r), nil
}

// m4RevisionRefPredicate picks the id or the digest arm of route 13's
// lookup. The uuid cast is applied only when the reference IS a uuid: an
// unguarded `$2::uuid` (the committed ResolveRevision's shape) makes
// Postgres evaluate the cast for every digest lookup and answer a nonsense
// reference with 22P02 / a 500 instead of the uniform not-found.
func m4RevisionRefPredicate(ref string) string {
	if prjValidUUID(ref) {
		return `id = $2::uuid`
	}
	return `revision_digest = $2`
}

// DeprecateRevision is route 15: status only, org-predicated, with
// pipeline.revision.deprecated in the same transaction (ADR-0002: runs
// untouched).
func (a APIPipelineStore) DeprecateRevision(ctx context.Context, c api.Caller, revisionID string) (api.RevisionView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.RevisionView{}, err
	}
	if !prjValidUUID(revisionID) {
		return api.RevisionView{}, api.ErrPipelineNotFound
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: begin deprecate revision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var orgID, digest string
	err = tx.QueryRow(ctx, `
		UPDATE pipeline_revisions SET status = 'deprecated'
		WHERE id = $1::uuid AND organization_id = $2::uuid AND status = 'published'
		RETURNING organization_id::text, revision_digest`, revisionID, c.OrganizationID).
		Scan(&orgID, &digest)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM pipeline_revisions
				WHERE id = $1::uuid AND organization_id = $2::uuid)`,
			revisionID, c.OrganizationID).Scan(&exists); err != nil {
			return api.RevisionView{}, fmt.Errorf("postgres: deprecate probe %s: %w", revisionID, err)
		}
		if !exists {
			return api.RevisionView{}, api.ErrPipelineNotFound
		}
		r, rerr := a.S.GetRevision(ctx, revisionID)
		if rerr != nil {
			return api.RevisionView{}, api.ErrPipelineNotFound
		}
		return m4RevisionView(r), nil // already deprecated: idempotent read-back
	}
	if err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: api deprecate revision %s: %w", revisionID, err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypePipelineRevisionDeprecated, orgID, "",
		c.UserID, events.PipelineRevisionDeprecatedPayload{RevisionID: revisionID, RevisionDigest: digest}); err != nil {
		return api.RevisionView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.RevisionView{}, fmt.Errorf("postgres: commit deprecate: %w", err)
	}
	r, err := a.S.GetRevision(ctx, revisionID)
	if err != nil {
		return api.RevisionView{}, err
	}
	return m4RevisionView(r), nil
}

func (a APIPipelineStore) RecordDenied(ctx context.Context, c api.Caller, resourceID, action string) error {
	pool, err := a.pool()
	if err != nil {
		return err
	}
	return m4AuditPipelineDenied(ctx, pool, c, resourceID, action)
}

// ============================================================ definition service

// PipelineDefinitions is the api.PipelineDefinitionService the serve wave
// injects behind routes 11–14: loader → schema → compiler (§ 2.2's ordered
// sources), the canonical bytes + revision_digest from canon, and the
// plan_digest from the compiled plan. It composes the committed packages —
// nothing here re-implements a rule they own.
//
// Registry existence checks (unknown_profile / unknown_repository) need
// project context the validate route does not carry (§ 2.1 route 11's
// subject is the draft, not a project), so they stay the compiler's optional
// pass and a build without a pool runs with a nil *compiler.Registries — the
// documented "skip every existence check" configuration (compiler/helpers.go).
// Template references are different (ADR-0049 § 2): they are ORG-scoped, and
// the caller's organization travels in every validate. WithTemplates wires
// the Postgres-backed registry loader; fail-closed, a node's template
// reference that cannot be resolved is template_ref_unresolved, never a 500.
type PipelineDefinitions struct {
	validator *schema.Validator
	pool      *pgxpool.Pool
}

// NewPipelineDefinitions compiles the shipped schema once, at process start
// — a schema that cannot compile is a build failure surfaced at startup,
// not a validate-time 500.
func NewPipelineDefinitions() (*PipelineDefinitions, error) {
	v, err := schema.New()
	if err != nil {
		return nil, fmt.Errorf("postgres: pipeline definition service: %w", err)
	}
	return &PipelineDefinitions{validator: v}, nil
}

// WithTemplates wires the template-registry loader (ADR-0049 § 2): validate
// then resolves node `template: slug@semver` references against the
// caller's organization's published, active revisions.
func (d *PipelineDefinitions) WithTemplates(pool *pgxpool.Pool) *PipelineDefinitions {
	d.pool = pool
	return d
}

// compileOptions builds the compiler's registries for one validate. A pool
// that cannot be read answers an EMPTY registry — a template reference then
// fail-closes as template_ref_unresolved (the honest answer: the registry
// cannot prove the revision) rather than breaking every validate.
func (d *PipelineDefinitions) compileOptions(ctx context.Context, c api.Caller) compiler.Options {
	opts := compiler.Options{}
	if d.pool == nil {
		return opts
	}
	reg, err := LoadTemplateRegistry(ctx, d.pool, c.OrganizationID)
	if err != nil {
		return opts
	}
	opts.Registries = &compiler.Registries{Templates: reg}
	return opts
}

func (d *PipelineDefinitions) Validate(ctx context.Context, c api.Caller, documentYAML string) (api.ValidationOutcome, error) {
	doc, diags := loader.Load([]byte(documentYAML))
	if !diags.Valid() {
		return d.invalid(m4RedactFindings(diags, doc)), nil
	}
	// ADR-0049 § 2 lifts the ADR-0024 § 2 deferral: a NodeTemplate document
	// validates (schema + compiler) like any other; the registry API is the
	// template's publish path, and the compiler's template_ref_unresolved
	// diagnostic replaces the former publish refusal for node references.
	if doc.Kind != loader.KindPipeline && doc.Kind != loader.KindNodeTemplate {
		diags.Addf(diag.SourceLoader, diag.CodeUnknownDocument, "/",
			"document kind %q has no schema branch", doc.Kind)
		return d.invalid(m4RedactFindings(diags, doc)), nil
	}
	diags = append(diags, d.validator.Validate(doc.Value)...)
	if !diags.Valid() {
		return d.invalid(m4RedactFindings(diags, doc)), nil
	}
	plan, cdiags := compiler.Compile(doc, d.compileOptions(ctx, c))
	diags = append(diags, cdiags...)
	if !diags.Valid() {
		return d.invalid(m4RedactFindings(diags, doc)), nil
	}
	canonical, err := canon.CanonicalizeDocument(doc.Map())
	if err != nil {
		return api.ValidationOutcome{}, fmt.Errorf("postgres: canonicalize document: %w", err)
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return api.ValidationOutcome{}, fmt.Errorf("postgres: encode compiled plan: %w", err)
	}
	planDigest, err := plan.Digest()
	if err != nil {
		return api.ValidationOutcome{}, fmt.Errorf("postgres: digest compiled plan: %w", err)
	}
	notes := append([]string{}, doc.Notes...)
	revisionDigest := canon.Digest(canonical)
	// The § 2.2 body carries both digests on success (openapi.yaml: "null
	// unless valid is true"); the route echoes in.Body verbatim and the
	// draft row stores it verbatim too (contract § 2 route 8).
	return api.ValidationOutcome{
		Body: api.ValidateResponse{
			Valid: true, DigestScope: canon.DigestScope,
			RevisionDigest: &revisionDigest, PlanDigest: &planDigest,
			Errors: []api.ValidateError{}, Notes: notes,
		},
		CanonicalDocument: json.RawMessage(canonical),
		RevisionDigest:    revisionDigest,
		CompiledPlan:      json.RawMessage(planJSON),
		PlanDigest:        planDigest,
		DigestScope:       canon.DigestScope,
	}, nil
}

// m4RedactFindings strips any literal the compiler's secret detector flags
// from every finding before the validate body is answered or stored. The
// compiler's own messages name a shape, never a value, but the schema
// validator quotes offending scalars and the loader quotes scalars too
// (ADR-0021 § Security/privacy: "the product must not echo a value that a
// secret scanner flags"), and the § 2.2 body is stored verbatim on the draft
// row (contract § 2 route 8) — so redaction happens once, here, before the
// record exists rather than on the way out.
func m4RedactFindings(diags diag.List, doc loader.Document) diag.List {
	diags.Redact(compiler.SecretLiteralValues(doc)...)
	return diags
}

// invalid renders the § 2.2 body for a refused document: verdict in the
// body (the route answers 200), findings sorted per the diag contract,
// digest members null.
func (d *PipelineDefinitions) invalid(diags diag.List) api.ValidationOutcome {
	diags.SortOrder()
	body := api.ValidateResponse{
		Valid:       false,
		DigestScope: canon.DigestScope,
		Errors:      m4DiagsToValidateErrors(diags),
		Notes:       []string{},
	}
	return api.ValidationOutcome{Body: body, DigestScope: canon.DigestScope}
}

// Export renders canonical JSON back to YAML (route 14 and publish's
// regenerated document_text). Canonicalization is one-way, so this is the
// honest textual form — anchors and merge keys do not survive it
// (ADR-0021 § 5), and re-loading what it prints re-canonicalizes to the
// same digest.
func (d *PipelineDefinitions) Export(canonicalDocument json.RawMessage) (string, error) {
	if len(canonicalDocument) == 0 {
		return "", errors.New("postgres: export needs a canonical document")
	}
	dec := json.NewDecoder(strings.NewReader(string(canonicalDocument)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", fmt.Errorf("postgres: decode canonical document: %w", err)
	}
	out, err := yaml.Marshal(jsonNativeToYAML(v))
	if err != nil {
		return "", fmt.Errorf("postgres: render document yaml: %w", err)
	}
	return string(out), nil
}

// jsonNativeToYAML turns json.Number values back into int64/float64 so the
// YAML printer does not quote them as strings — the loader admits the
// output back as the same numeric scalars either way, but quoted numbers
// are not what an author wrote.
func jsonNativeToYAML(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			t[k] = jsonNativeToYAML(e)
		}
		return t
	case []any:
		for i, e := range t {
			t[i] = jsonNativeToYAML(e)
		}
		return t
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	}
	return v
}

// EnvDigest is the pinned CEL declaration-set digest (ADR-0022 § 5).
func (d *PipelineDefinitions) EnvDigest() string { return compiler.EnvDigest() }

// ExtractPipelineUI resolves metadata.ui from authored YAML for route 9's
// re-resolution. Absent/unparseable yields an empty object — the draft keeps
// whatever layout it had rather than losing one to a loader hiccup on
// unrelated keys.
func ExtractPipelineUI(documentYAML string) (json.RawMessage, error) {
	doc, diags := loader.Load([]byte(documentYAML))
	if !diags.Valid() {
		return json.RawMessage("{}"), nil
	}
	meta, _ := doc.Map()["metadata"].(map[string]canon.Value)
	ui, ok := meta["ui"]
	if !ok || ui == nil {
		return json.RawMessage("{}"), nil
	}
	raw, err := json.Marshal(ui)
	if err != nil {
		return nil, fmt.Errorf("postgres: encode metadata.ui: %w", err)
	}
	return raw, nil
}

// __M4API_NEXT__
