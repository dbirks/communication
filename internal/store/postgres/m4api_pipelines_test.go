package postgres

// TestM4APIPipelines*: the SQL behind api.PipelineStore (docs/m4-contract.md
// § 2.1 routes 1–15, § 5's control-plane duties) exercised against a real
// Postgres. Every method of APIPipelineStore is called at least once, in the
// order the routes happen in for real: create -> list -> draft -> get ->
// replace -> validate -> publish -> get revision by id and by digest ->
// deprecate -> list revisions. Nothing here is mocked: an error the handler
// would see as a 500 (a 42601, a 42702, a mis-bound parameter) fails this
// test with the database's own words.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// m4APIProbeDoc returns the § 7 exit seed's first document (the
// agent-driven feature-development pipeline) exactly as authored — the
// bytes a route-7 create would have stored, so source_sha256 semantics stay
// honest.
func m4APIProbeDoc(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..",
		"docs", "compatibility", "probes", "m4", "pipeline.yaml"))
	if err != nil {
		t.Fatalf("read probe pipeline.yaml: %v", err)
	}
	doc := string(raw)
	if i := strings.Index(doc, "\n---\n"); i >= 0 {
		doc = doc[:i+1]
	}
	if !strings.Contains(doc, "kind: Pipeline") {
		t.Fatalf("probe document 1 has no kind: Pipeline\n%s", doc[:200])
	}
	return doc
}

// m4APIEventsMopped deletes the § 3 rows this test appended. Org-scoped
// pipeline events carry no run_id, so the fixture's run-scoped sweep never
// reaches them; they are keyed by the ids their payloads name.
func m4APIEventsMopped(t *testing.T, pool *pgxpool.Pool, ids ...string) {
	t.Helper()
	bg := context.Background()
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, err := pool.Exec(bg, `
			DELETE FROM outbox WHERE global_seq IN
				(SELECT global_seq FROM domain_events WHERE payload::text LIKE '%'''||$1||'''%')`, id); err != nil {
			t.Errorf("cleanup outbox for %s: %v", id, err)
		}
		if _, err := pool.Exec(bg,
			`DELETE FROM domain_events WHERE payload::text LIKE '%'''||$1||'''%'`, id); err != nil {
			t.Errorf("cleanup domain_events for %s: %v", id, err)
		}
	}
}

// m4APICaller is the caller a browser session's handler builds.
func m4APICaller(f *m4Fixture) api.Caller {
	return api.Caller{UserID: f.userID, OrganizationID: f.orgID}
}

func TestM4APIPipelines(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	c := m4APICaller(f)
	doc := m4APIProbeDoc(t)

	// --- route 2: create the logical definition (+ pipeline.created row).
	created, err := store.CreatePipeline(ctx, c, "m4api-pipe-"+token, "M4 API pipe", "brief test")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4APIPipeMop(t, ctx, f, created.ID) })
	if created.ID == "" || created.Slug != "m4api-pipe-"+token {
		t.Fatalf("CreatePipeline view = %+v", created)
	}
	if created.LatestRevisionNumber != 0 || created.RevisionCount != 0 || created.Archived {
		t.Errorf("fresh pipeline view = %+v, want zero revisions and unarchived", created)
	}
	if _, err := store.CreatePipeline(ctx, c, "m4api-pipe-"+token, "dup", ""); !errors.Is(err, api.ErrPipelineConflict) {
		t.Errorf("duplicate slug err = %v, want api.ErrPipelineConflict", err)
	}

	// --- route 1: the org's library, slug-ordered.
	if err := store.RecordDenied(ctx, c, created.ID, "pipeline.list"); err != nil {
		t.Fatalf("RecordDenied: %v", err)
	}
	var fixtureSlug string
	if err := f.pool.QueryRow(ctx, `SELECT slug FROM pipelines WHERE id = $1`, f.pipelineID).
		Scan(&fixtureSlug); err != nil {
		t.Fatalf("fixture slug: %v", err)
	}
	summaries, err := store.ListPipelines(ctx, c)
	if err != nil {
		t.Fatalf("ListPipelines: %v", err)
	}
	var seen []string
	for _, s := range summaries {
		seen = append(seen, s.Slug)
		if s.ID == created.ID {
			if s.RevisionCount != 0 || s.Archived {
				t.Errorf("list row for new pipeline = %+v, want 0 revisions, unarchived", s)
			}
		}
	}
	if len(summaries) < 2 {
		t.Fatalf("ListPipelines returned %d rows (%v), want the fixture pipeline too", len(summaries), seen)
	}
	if !containsString(seen, created.Slug) || !containsString(seen, fixtureSlug) {
		t.Fatalf("ListPipelines slugs = %v, want both fixtures", seen)
	}
	// The order is the database's slug collation, so it is compared against
	// the same ORDER BY applied to the same values, not against Go's bytes.
	var wantOrder []string
	values := make([]any, 0, len(seen))
	args := make([]string, 0, len(seen))
	for i, slug := range seen {
		args = append(args, "$"+itoa(i+1))
		values = append(values, slug)
	}
	rows, err := f.pool.Query(ctx, `SELECT slug FROM (VALUES (`+strings.Join(args, "),(")+`)) AS t(slug) ORDER BY slug`,
		values...)
	if err != nil {
		t.Fatalf("collation probe: %v", err)
	}
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			rows.Close()
			t.Fatalf("collation scan: %v", err)
		}
		wantOrder = append(wantOrder, slug)
	}
	rows.Close()
	if strings.Join(wantOrder, ",") != strings.Join(seen, ",") {
		t.Errorf("ListPipelines order = %v, database slug collation wants %v", seen, wantOrder)
	}

	// --- route 4: metadata-only PATCH; nil members do not move.
	desc := "patched description"
	patched, err := store.UpdatePipeline(ctx, c, created.ID, api.PipelineUpdateInput{Description: &desc})
	if err != nil {
		t.Fatalf("UpdatePipeline: %v", err)
	}
	if patched.Description != desc {
		t.Errorf("Description = %q, want %q", patched.Description, desc)
	}
	if patched.DisplayName != "M4 API pipe" {
		t.Errorf("nil DisplayName moved: %q", patched.DisplayName)
	}

	// --- route 3: the detail read (revisions included).
	got, err := store.GetPipeline(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("GetPipeline: %v", err)
	}
	if got.Slug != created.Slug || got.Description != desc {
		t.Errorf("GetPipeline view = %+v", got)
	}
	if got.Revisions == nil || len(got.Revisions) != 0 {
		t.Errorf("GetPipeline Revisions = %v, want an empty non-nil list", got.Revisions)
	}

	// --- route 7: the draft from already-hashed bytes.
	draft, err := store.CreateDraft(ctx, c, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "yaml_import", SourceSHA256: m4Hex("api-draft/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if draft.DocumentYAML != doc || draft.Status != "draft" || draft.Version != 1 {
		t.Errorf("CreateDraft view = %+v", draftViewBrief(draft))
	}

	// --- route 8: read it back by id.
	reread, err := store.GetDraft(ctx, c, draft.ID)
	if err != nil {
		t.Fatalf("GetDraft: %v", err)
	}
	if reread.ID != draft.ID || reread.PipelineID != created.ID || reread.DocumentYAML != doc {
		t.Errorf("GetDraft view = %+v", draftViewBrief(reread))
	}

	// --- route 6: drafts listed under the pipeline.
	drafts, err := store.ListPipelineDrafts(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("ListPipelineDrafts: %v", err)
	}
	if len(drafts) != 1 || drafts[0].ID != draft.ID || drafts[0].Version != 1 {
		t.Fatalf("ListPipelineDrafts = %+v, want the one draft", drafts)
	}

	// --- route 9: PUT under CAS, with metadata.ui re-resolved.
	ui := `{"sections":[{"kind":"summary"}]}`
	storeWithUI := store
	storeWithUI.ExtractUI = func(string) (json.RawMessage, error) { return json.RawMessage(ui), nil }
	replaced, err := storeWithUI.ReplaceDraft(ctx, c, draft.ID, doc, m4Hex("api-draft/"+token), draft.Version)
	if err != nil {
		t.Fatalf("ReplaceDraft: %v", err)
	}
	if replaced.Version != draft.Version+1 {
		t.Errorf("ReplaceDraft version = %d, want %d", replaced.Version, draft.Version+1)
	}
	if strings.ReplaceAll(string(replaced.UILayout), " ", "") != ui {
		t.Errorf("ReplaceDraft ui_layout = %s, want %s", replaced.UILayout, ui)
	}
	if _, err := store.ReplaceDraft(ctx, c, draft.ID, doc, m4Hex("stale"), 1); err == nil {
		t.Error("ReplaceDraft at a stale version succeeded, want a conflict")
	} else {
		var conflict *api.DraftConflictError
		if !errors.As(err, &conflict) || conflict.Kind != api.DraftConflictStaleVersion ||
			conflict.CurrentVersion != replaced.Version {
			t.Errorf("stale PUT err = %v, want stale_draft_version at version %d", err, replaced.Version)
		}
	}

	// --- route 11: the validate pass' write.
	canonical := json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":"` +
		"api-rev/" + token + `"}`)
	revDigest := m4Digest("api-rev/" + token)
	planDigest := m4Digest("api-plan/" + token)
	body := api.ValidateResponse{Valid: true, DigestScope: "v1alpha1-canonical-1", Errors: []api.ValidateError{}}
	validated, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status:            "valid",
		Body:              body,
		CanonicalDocument: canonical,
		RevisionDigest:    revDigest,
		CompiledPlan:      json.RawMessage(`{"nodes":[]}`),
		PlanDigest:        planDigest,
		DigestScope:       "v1alpha1-canonical-1",
	})
	if err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	if validated.Status != "valid" || validated.RevisionDigest == nil ||
		*validated.RevisionDigest != revDigest || validated.PlanDigest == nil {
		t.Fatalf("RecordValidation view = %+v", draftViewBrief(validated))
	}

	// --- route 12: publish freezes it.
	rev, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: validated.Version, VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	if rev.RevisionDigest != revDigest || rev.PlanDigest != planDigest || rev.Status != "published" {
		t.Errorf("PublishDraft view = %+v", revBrief(rev))
	}
	if rev.RevisionNumber < 1 {
		t.Errorf("RevisionNumber = %d, want >= 1", rev.RevisionNumber)
	}

	// --- route 10: the published draft is immutable, but an unpublished one
	// deletes.
	if err := store.DeleteDraft(ctx, c, draft.ID); err == nil {
		t.Error("DeleteDraft on a published draft succeeded, want a conflict")
	} else {
		var conflict *api.DraftConflictError
		if !errors.As(err, &conflict) || conflict.Kind != api.DraftConflictPublished {
			t.Errorf("DeleteDraft published err = %v, want draft_published", err)
		}
	}
	// --- a published draft also refuses PUT and re-validation.
	if _, err := store.ReplaceDraft(ctx, c, draft.ID, doc, m4Hex("post-publish"), replaced.Version); err == nil {
		t.Error("ReplaceDraft on a published draft succeeded, want draft_published")
	} else {
		var conflict *api.DraftConflictError
		if !errors.As(err, &conflict) || conflict.Kind != api.DraftConflictPublished {
			t.Errorf("published PUT err = %v, want draft_published", err)
		}
	}
	if _, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status: "valid", Body: body,
	}); err == nil || errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("RecordValidation on a published draft = %v, want a non-not-found refusal", err)
	}
	if _, err := store.GetDraft(ctx, c, "not-a-uuid"); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("non-uuid GetDraft = %v, want ErrPipelineNotFound", err)
	}

	temp, err := store.CreateDraft(ctx, c, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("api-temp/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft(temp): %v", err)
	}
	if err := store.DeleteDraft(ctx, c, temp.ID); err != nil {
		t.Fatalf("DeleteDraft(temp): %v", err)
	}
	if _, err := store.GetDraft(ctx, c, temp.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("GetDraft after delete = %v, want ErrPipelineNotFound", err)
	}

	// --- route 12's refusals, each of which is its own SQL path: a draft
	// that never validated, and a digest the organization already publishes.
	lazy, err := store.CreateDraft(ctx, c, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("api-lazy/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft(lazy): %v", err)
	}
	if _, err := store.PublishDraft(ctx, c, lazy.ID, api.DraftPublishInput{
		ExpectedVersion: lazy.Version, VersionLabel: "2.0.0", DocumentText: doc,
	}); err == nil {
		t.Error("PublishDraft of an unvalidated draft succeeded, want draft_not_valid")
	} else {
		var conflict *api.DraftConflictError
		if !errors.As(err, &conflict) || conflict.Kind != api.DraftConflictNotValid {
			t.Errorf("unvalidated publish err = %v, want draft_not_valid", err)
		}
	}
	invalidBody := api.ValidateResponse{
		Valid: false, DigestScope: "v1alpha1-canonical-1",
		Errors: []api.ValidateError{{Code: "schema_violation", Message: "spec.inputs is required"}},
	}
	if _, err := store.RecordValidation(ctx, c, lazy.ID, api.DraftValidationRecord{
		Status: "invalid", Body: invalidBody,
	}); err != nil {
		t.Fatalf("RecordValidation(invalid): %v", err)
	}
	invalid, err := store.GetDraft(ctx, c, lazy.ID)
	if err != nil {
		t.Fatalf("GetDraft(invalid): %v", err)
	}
	if invalid.Status != "invalid" || invalid.RevisionDigest != nil || invalid.PlanDigest != nil ||
		len(invalid.Validation) == 0 || !strings.Contains(string(invalid.Validation), "schema_violation") {
		t.Errorf("invalid validation view = %+v", draftViewBrief(invalid))
	}
	if _, err := store.RecordValidation(ctx, c, lazy.ID, api.DraftValidationRecord{
		Status: "valid", Body: body, CanonicalDocument: canonical, RevisionDigest: revDigest,
		CompiledPlan: json.RawMessage(`{"nodes":[]}`), PlanDigest: planDigest,
		DigestScope: "v1alpha1-canonical-1",
	}); err != nil {
		t.Fatalf("RecordValidation(collision): %v", err)
	}
	if _, err := store.PublishDraft(ctx, c, lazy.ID, api.DraftPublishInput{
		ExpectedVersion: invalid.Version, VersionLabel: "2.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
	}); err == nil {
		t.Error("double publish of one digest succeeded, want revision_already_published")
	} else {
		var conflict *api.DraftConflictError
		if !errors.As(err, &conflict) || conflict.Kind != api.DraftConflictAlreadyPublished {
			t.Errorf("collision err = %v, want revision_already_published", err)
		} else if conflict.ExistingRevisionID != rev.ID {
			t.Errorf("collision names revision %q, want the winner %q", conflict.ExistingRevisionID, rev.ID)
		}
	}

	// --- route 4's archive arms (and back again).
	archived := true
	notArchived := false
	got, err = store.UpdatePipeline(ctx, c, created.ID, api.PipelineUpdateInput{Archived: &archived})
	if err != nil {
		t.Fatalf("UpdatePipeline(archive): %v", err)
	}
	if !got.Archived {
		t.Errorf("Archived = false after archive")
	}
	if got, err = store.UpdatePipeline(ctx, c, created.ID, api.PipelineUpdateInput{Archived: &notArchived}); err != nil {
		t.Fatalf("UpdatePipeline(unarchive): %v", err)
	}
	if got.Archived {
		t.Errorf("Archived = true after unarchive")
	}
	if _, err := store.GetPipeline(ctx, c, "22222222-2222-4222-8222-222222222222"); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("absent pipeline = %v, want ErrPipelineNotFound", err)
	}

	// --- route 13: by id and by digest, same view.
	byID, err := store.GetRevision(ctx, c, rev.ID)
	if err != nil {
		t.Fatalf("GetRevision(id): %v", err)
	}
	byDigest, err := store.GetRevision(ctx, c, revDigest)
	if err != nil {
		t.Fatalf("GetRevision(digest): %v", err)
	}
	if byID.ID != rev.ID || byDigest.ID != rev.ID {
		t.Errorf("GetRevision id=%s digest=%s, want both %s", byID.ID, byDigest.ID, rev.ID)
	}
	if _, err := store.GetRevision(ctx, c, m4Digest("nowhere/"+token)); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("unknown digest = %v, want ErrPipelineNotFound", err)
	}

	// --- route 5: the revision list now carries the new revision.
	revs, err := store.ListPipelineRevisions(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("ListPipelineRevisions: %v", err)
	}
	if len(revs) != 1 || revs[0].RevisionDigest != revDigest || revs[0].Status != "published" {
		t.Fatalf("ListPipelineRevisions = %+v, want the one published revision", revs)
	}

	// --- route 15: deprecate, then deprecate again (idempotent).
	deprecated, err := store.DeprecateRevision(ctx, c, rev.ID)
	if err != nil {
		t.Fatalf("DeprecateRevision: %v", err)
	}
	if deprecated.Status != "deprecated" {
		t.Errorf("DeprecateRevision status = %q, want deprecated", deprecated.Status)
	}
	again, err := store.DeprecateRevision(ctx, c, rev.ID)
	if err != nil {
		t.Fatalf("DeprecateRevision (idempotent): %v", err)
	}
	if again.Status != "deprecated" || again.ID != rev.ID {
		t.Errorf("second DeprecateRevision = %+v", revBrief(again))
	}

	// --- the revision list now reports the deprecation.
	revs, err = store.ListPipelineRevisions(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("ListPipelineRevisions (after deprecate): %v", err)
	}
	if len(revs) != 1 || revs[0].Status != "deprecated" {
		t.Errorf("ListPipelineRevisions after deprecate = %+v, want deprecated", revs)
	}

	// --- the journal rode the same commits (§ 3).
	for _, typ := range []string{
		string(events.TypePipelineCreated), string(events.TypePipelineDraftUpdated),
		string(events.TypePipelineDraftValidated), string(events.TypePipelineRevisionPublished),
		string(events.TypePipelineRevisionDeprecated),
	} {
		var n int
		if err := f.pool.QueryRow(ctx, `
			SELECT count(*) FROM domain_events WHERE organization_id = $1::uuid AND type = $2`,
			f.orgID, typ).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", typ, err)
		}
		if n == 0 {
			t.Errorf("no %s event row was appended", typ)
		}
	}

	// --- the audit row for a refused pipeline read.
	var denials int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_events WHERE actor_id = $1 AND action = 'pipeline.list'`,
		c.UserID).Scan(&denials); err != nil {
		t.Fatalf("count denials: %v", err)
	}
	if denials != 1 {
		t.Errorf("pipeline.list denial rows = %d, want 1", denials)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM audit_events WHERE actor_id = $1`, c.UserID); err != nil {
		t.Errorf("cleanup audit rows: %v", err)
	}
	m4APIEventsMopped(t, f.pool, created.ID, draft.ID, rev.ID)
}

// m4APIPipeMop unwinds a pipeline this test created (children first; the
// draft->revision pointer is circular, so it is cleared before either table
// loses rows).
func m4APIPipeMop(t *testing.T, ctx context.Context, f *m4Fixture, pipelineID string) {
	t.Helper()
	bg := context.Background()
	steps := []string{
		`UPDATE pipeline_drafts SET published_revision_id = NULL WHERE pipeline_id = $1`,
		`DELETE FROM pipeline_revisions WHERE pipeline_id = $1`,
		`DELETE FROM pipeline_drafts WHERE pipeline_id = $1`,
		`DELETE FROM pipelines WHERE id = $1`,
	}
	for _, sql := range steps {
		if _, err := f.pool.Exec(bg, sql, pipelineID); err != nil {
			t.Errorf("cleanup %q: %v", sql, err)
		}
	}
}

// TestM4APIPipelinesCrossOrg: a caller from another organization reads the
// uniform not-found on every id-keyed route — never a peek, never a 500.
func TestM4APIPipelinesCrossOrg(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	store := APIPipelineStore{S: f.pipelines}
	c := m4APICaller(f)
	doc := m4APIProbeDoc(t)

	created, err := store.CreatePipeline(ctx, c, "m4api-xorg-"+token, "xorg", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4APIPipeMop(t, ctx, f, created.ID) })
	draft, err := store.CreateDraft(ctx, c, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("xorg/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	// A second organization with a member of its own.
	var otherOrg, otherUser string
	t.Cleanup(func() {
		bg := context.Background()
		for _, sql := range []string{
			`DELETE FROM users WHERE id = $1`,
			`DELETE FROM organizations WHERE id = $1`,
		} {
			var id string
			if sql == "DELETE FROM users WHERE id = $1" {
				id = otherUser
			} else {
				id = otherOrg
			}
			if _, err := f.pool.Exec(bg, sql, id); err != nil {
				t.Errorf("cleanup %q: %v", sql, err)
			}
		}
	})
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO organizations (slug, name) VALUES ($1, 'other org') RETURNING id`,
		"m4api-other-"+token).Scan(&otherOrg); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name) VALUES ($1, 'other user') RETURNING id`,
		otherOrg).Scan(&otherUser); err != nil {
		t.Fatalf("insert other user: %v", err)
	}
	other := api.Caller{UserID: otherUser, OrganizationID: otherOrg}

	if _, err := store.GetPipeline(ctx, other, created.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org GetPipeline = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.GetDraft(ctx, other, draft.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org GetDraft = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.UpdatePipeline(ctx, other, created.ID,
		api.PipelineUpdateInput{Description: &token}); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org UpdatePipeline = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.ListPipelineRevisions(ctx, other, created.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org ListPipelineRevisions = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.ListPipelineDrafts(ctx, other, created.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org ListPipelineDrafts = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.ReplaceDraft(ctx, other, draft.ID, doc, m4Hex("nope"), draft.Version); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org ReplaceDraft = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.RecordValidation(ctx, other, draft.ID, api.DraftValidationRecord{
		Status: "valid", Body: api.ValidateResponse{Valid: true, Errors: []api.ValidateError{}},
	}); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org RecordValidation = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.PublishDraft(ctx, other, draft.ID, api.DraftPublishInput{
		ExpectedVersion: draft.Version, VersionLabel: "9.9.9", DocumentText: doc,
	}); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org PublishDraft = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.DeprecateRevision(ctx, other, "22222222-2222-4222-8222-222222222222"); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org DeprecateRevision = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.GetRevision(ctx, other, m4Digest("api-rev/"+token)); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org GetRevision = %v, want ErrPipelineNotFound", err)
	}
	if _, err := store.CreateDraft(ctx, other, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("xorg2/" + token),
	}); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org CreateDraft = %v, want ErrPipelineNotFound", err)
	}
	if err := store.DeleteDraft(ctx, other, draft.ID); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("cross-org DeleteDraft = %v, want ErrPipelineNotFound", err)
	}
	// The intruder's library is empty, not leaked.
	mine, err := store.ListPipelines(ctx, other)
	if err != nil {
		t.Fatalf("cross-org ListPipelines: %v", err)
	}
	if len(mine) != 0 {
		t.Errorf("cross-org ListPipelines = %v, want none", mine)
	}
	if _, err := store.GetPipeline(ctx, c, "not-a-uuid"); !errors.Is(err, api.ErrPipelineNotFound) {
		t.Errorf("non-uuid GetPipeline = %v, want ErrPipelineNotFound", err)
	}
	if err := store.RecordDenied(ctx, other, created.ID, "pipeline.get"); err != nil {
		t.Errorf("cross-org RecordDenied: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM audit_events WHERE actor_id = $1`, otherUser); err != nil {
		t.Errorf("cleanup audit rows: %v", err)
	}
	m4APIEventsMopped(t, f.pool, created.ID, draft.ID)
}

func itoa(i int) string { return strconv.Itoa(i) }

func containsString(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

func draftViewBrief(v api.DraftView) api.DraftView {
	v.DocumentYAML = ""
	return v
}

func revBrief(v api.RevisionView) api.RevisionView {
	v.DocumentText = ""
	v.CanonicalDocument = nil
	v.CompiledPlan = nil
	return v
}
