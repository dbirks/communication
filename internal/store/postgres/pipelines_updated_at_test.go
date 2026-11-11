package postgres

// pipelines_updated_at_test.go: migration 00034's contract against a real
// Postgres (assistant exercise 2026-11-11, F-6 remainder — the assistant
// could not say a workflow "was created today" because nothing carried a
// date). The rule under test: pipelines.updated_at is the newest write the
// pipeline store made for the definition, so draft save and publish must move
// it — through BOTH write faces the store has: PipelineStore's own methods
// and the APIPipelineStore routes the control plane actually calls.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// readPipelineUpdatedAt reads the column straight off the pipelines row —
// the answer the store's own views must agree with.
func readPipelineUpdatedAt(t *testing.T, pool *pgxpool.Pool, pipelineID string) time.Time {
	t.Helper()
	var updated time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT updated_at FROM pipelines WHERE id = $1::uuid`, pipelineID).Scan(&updated); err != nil {
		t.Fatalf("read pipelines.updated_at for %s: %v", pipelineID, err)
	}
	return updated
}

// assertMovedAt requires updated_at to be strictly after `before`. Postgres
// now() is the transaction start at microsecond resolution, so each caller
// sleeps past one clock tick before the write it expects to move the stamp.
func assertMovedAt(t *testing.T, what string, before, got time.Time) {
	t.Helper()
	if !got.After(before) {
		t.Fatalf("%s did not move pipelines.updated_at: %s, want after %s", what, got, before)
	}
}

// clockTick outruns Postgres' microsecond now() between two writes.
func clockTick() { time.Sleep(2 * time.Millisecond) }

// TestPipelineStoreUpdatedAtMoves drives the definition-service store's own
// write methods (00034's contract): create stamps it, draft save moves it,
// publish moves it again.
func TestPipelineStoreUpdatedAtMoves(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)

	pipe, err := f.pipelines.CreatePipeline(ctx, f.orgID, f.userID, "pip-ts-"+token, "TS pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4APIPipeMop(t, ctx, f, pipe.ID) })
	if pipe.UpdatedAt.IsZero() || pipe.CreatedAt.IsZero() {
		t.Fatalf("CreatePipeline view: CreatedAt=%s UpdatedAt=%s, want both set", pipe.CreatedAt, pipe.UpdatedAt)
	}
	base := readPipelineUpdatedAt(t, f.pool, pipe.ID)

	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: pipe.ID, DocumentText: "kind: Pipeline\n# v1\n",
		SourceKind: "manual", SourceSHA256: m4Hex("ts-draft/" + token), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	afterDraft := readPipelineUpdatedAt(t, f.pool, pipe.ID)
	assertMovedAt(t, "CreateDraft", base, afterDraft)

	clockTick()
	if _, err := f.pipelines.ReplaceDraftDocument(ctx, draft.ID, "kind: Pipeline\n# v2\n",
		m4Hex("ts-draft2/"+token), nil, draft.Version, f.userID); err != nil {
		t.Fatalf("ReplaceDraftDocument: %v", err)
	}
	afterSave := readPipelineUpdatedAt(t, f.pool, pipe.ID)
	assertMovedAt(t, "draft save (ReplaceDraftDocument)", afterDraft, afterSave)

	clockTick()
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1",` +
			`"kind":"Pipeline","marker":"ts/` + token + `"}`),
		RevisionDigest: m4Digest("ts-rev/" + token),
		CompiledPlan:   json.RawMessage(`{"nodes":[]}`),
		PlanDigest:     m4Digest("ts-plan/" + token),
		DigestScope:    "v1alpha1-canonical-1",
		Validation:     json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	afterValidate := readPipelineUpdatedAt(t, f.pool, pipe.ID)
	assertMovedAt(t, "RecordValidation", afterSave, afterValidate)

	clockTick()
	reread, err := f.pipelines.GetDraft(ctx, draft.ID)
	if err != nil {
		t.Fatalf("GetDraft: %v", err)
	}
	if _, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "1.0.0", DocumentText: "kind: Pipeline\n# v2\n",
		SchemaDigest: m4Digest("ts-schema"), CelEnvDigest: m4Digest("ts-cel"),
		PublishedBy: f.userID, ExpectedDraftVersion: reread.Version,
	}); err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	afterPublish := readPipelineUpdatedAt(t, f.pool, pipe.ID)
	assertMovedAt(t, "publish", afterValidate, afterPublish)

	// The reads carry the same clock the row does (route 1's summary and
	// route 3's view both feed the assistant's timestamps).
	got, err := f.pipelines.GetPipeline(ctx, pipe.ID)
	if err != nil {
		t.Fatalf("GetPipeline: %v", err)
	}
	if !got.UpdatedAt.Equal(afterPublish) || !got.CreatedAt.Equal(pipe.CreatedAt) {
		t.Errorf("GetPipeline times = (%s, %s), want created %s, updated %s",
			got.CreatedAt, got.UpdatedAt, pipe.CreatedAt, afterPublish)
	}
}

// TestM4APIPipelinesTimestampsOnRoutes is the route-level half: create's
// view, the library list's rows, and the moves a draft save and a publish
// make, as the API store reports them.
func TestM4APIPipelinesTimestampsOnRoutes(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	store := APIPipelineStore{S: f.pipelines}
	c := m4APICaller(f)
	doc := m4APIProbeDoc(t)

	created, err := store.CreatePipeline(ctx, c, "m4api-ts-"+token, "M4 API ts pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4APIPipeMop(t, ctx, f, created.ID) })
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("create view timestamps = (%s, %s), want both set", created.CreatedAt, created.UpdatedAt)
	}
	base := readPipelineUpdatedAt(t, f.pool, created.ID)

	var row *api.PipelineSummaryView
	summaries, err := store.ListPipelines(ctx, c)
	if err != nil {
		t.Fatalf("ListPipelines: %v", err)
	}
	for i := range summaries {
		if summaries[i].ID == created.ID {
			row = &summaries[i]
		}
	}
	if row == nil {
		t.Fatal("ListPipelines lost the new pipeline")
	}
	if row.CreatedAt.IsZero() || row.UpdatedAt.IsZero() {
		t.Errorf("list row timestamps = (%s, %s), want both set", row.CreatedAt, row.UpdatedAt)
	}

	// Draft save (routes 7 + 9) moves the definition's clock.
	draft, err := store.CreateDraft(ctx, c, created.ID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "manual", SourceSHA256: m4Hex("ts-api/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := store.ReplaceDraft(ctx, c, draft.ID, doc, m4Hex("ts-api2/"+token), draft.Version); err != nil {
		t.Fatalf("ReplaceDraft: %v", err)
	}
	afterSave := readPipelineUpdatedAt(t, f.pool, created.ID)
	assertMovedAt(t, "api draft save", base, afterSave)

	// Publish (routes 11 + 12) moves it again.
	clockTick()
	validated, err := store.RecordValidation(ctx, c, draft.ID, api.DraftValidationRecord{
		Status: "valid",
		Body: api.ValidateResponse{Valid: true, DigestScope: "v1alpha1-canonical-1",
			Errors: []api.ValidateError{}},
		CanonicalDocument: json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1",` +
			`"kind":"Pipeline","marker":"ts-api/` + token + `"}`),
		RevisionDigest: m4Digest("ts-api-rev/" + token),
		CompiledPlan:   json.RawMessage(`{"nodes":[]}`),
		PlanDigest:     m4Digest("ts-api-plan/" + token),
		DigestScope:    "v1alpha1-canonical-1",
	})
	if err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	clockTick()
	beforePublish := readPipelineUpdatedAt(t, f.pool, created.ID)
	if _, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: validated.Version, VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("ts-api-schema"), CelEnvDigest: m4Digest("ts-api-cel"),
	}); err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	assertMovedAt(t, "api publish", beforePublish, readPipelineUpdatedAt(t, f.pool, created.ID))

	// The PATCH (route 4) moves it too, and its response view says so.
	clockTick()
	name := "renamed"
	patched, err := store.UpdatePipeline(ctx, c, created.ID, api.PipelineUpdateInput{DisplayName: &name})
	if err != nil {
		t.Fatalf("UpdatePipeline: %v", err)
	}
	assertMovedAt(t, "api PATCH", beforePublish, patched.UpdatedAt)
}
