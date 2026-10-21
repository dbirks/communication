package postgres

// ADR-0049 part 2 against a real Postgres: publish writes the refs table in
// the publish transaction, the § 4 count is honest, "Edit for all" opens
// adopt drafts (skipping pipelines with an open draft) in the revision
// transaction, and from_node reads a validated draft's node. Nothing here
// is mocked — every sentinel is the database's own answer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

func p2Doc(slug, name string) string {
	return `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ` + name + `
  description: ADR-0049 part 2 template reference probe.
spec:
  inputs:
    type: object
  nodes:
    - id: review
      kind: agent.acp
      template: ` + slug + `@1.0.0
      config:
        focus: auth
`
}

// p2Mop deletes this test family's rows at test end (the shared database is
// kept clean for the next run).
func p2Mop(t *testing.T, pool *pgxpool.Pool, pipelineIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		// drafts ↔ revisions reference each other (published_revision_id /
		// draft_id), so the cycle is broken before either table is emptied.
		if _, err := pool.Exec(bg, `UPDATE pipeline_drafts SET published_revision_id = NULL
			WHERE pipeline_id = ANY($1::uuid[])`, pipelineIDs); err != nil {
			t.Errorf("cleanup draft pins: %v", err)
		}
		for _, id := range pipelineIDs {
			if _, err := pool.Exec(bg, `DELETE FROM pipeline_revisions WHERE pipeline_id = $1`, id); err != nil {
				t.Errorf("cleanup revisions %s: %v", id, err)
			}
			if _, err := pool.Exec(bg, `DELETE FROM pipeline_drafts WHERE pipeline_id = $1`, id); err != nil {
				t.Errorf("cleanup drafts %s: %v", id, err)
			}
		}
		if len(pipelineIDs) > 0 {
			if _, err := pool.Exec(bg, `DELETE FROM pipelines WHERE id = ANY($1::uuid[])`, pipelineIDs); err != nil {
				t.Errorf("cleanup pipelines: %v", err)
			}
		}
		const eventTypes = `('node_template.create','node_template.revision.publish',
			 'pipeline.draft.create','pipeline.revision.published','pipeline.draft.validated')`
		if _, err := pool.Exec(bg, `DELETE FROM outbox WHERE global_seq IN
			(SELECT global_seq FROM domain_events WHERE type IN `+eventTypes+`)`); err != nil {
			t.Errorf("cleanup outbox: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM domain_events WHERE type IN `+eventTypes); err != nil {
			t.Errorf("cleanup events: %v", err)
		}
	})
}

// p2Publish validates (against the real Postgres template registry), records
// the validation and publishes one draft, returning the revision and draft.
func p2Publish(t *testing.T, ctx context.Context, f *m4Fixture, c api.Caller,
	store APIPipelineStore, defs *PipelineDefinitions, pipelineID, doc, versionLabel string) (api.RevisionView, string) {
	t.Helper()
	draft, err := store.CreateDraft(ctx, c, pipelineID, api.DraftCreateInput{
		DocumentYAML: doc, SourceKind: "yaml_import", SourceSHA256: m4Hex("p2/" + pipelineID),
	})
	if err != nil {
		t.Fatalf("CreateDraft %s: %v", pipelineID, err)
	}
	outcome, err := defs.Validate(ctx, c, doc)
	if err != nil {
		t.Fatalf("Validate %s: %v", pipelineID, err)
	}
	if !outcome.Body.Valid {
		t.Fatalf("Validate %s refused the template reference: %+v", pipelineID, outcome.Body.Errors)
	}
	record := api.DraftValidationRecord{
		Status: "valid", Body: outcome.Body, CanonicalDocument: outcome.CanonicalDocument,
		RevisionDigest: outcome.RevisionDigest, CompiledPlan: outcome.CompiledPlan,
		PlanDigest: outcome.PlanDigest, DigestScope: outcome.DigestScope,
	}
	if _, err := store.RecordValidation(ctx, c, draft.ID, record); err != nil {
		t.Fatalf("RecordValidation %s: %v", pipelineID, err)
	}
	got, err := store.GetDraft(ctx, c, draft.ID)
	if err != nil {
		t.Fatalf("GetDraft %s: %v", pipelineID, err)
	}
	text, err := defs.Export(got.CanonicalDocument)
	if err != nil {
		t.Fatalf("Export %s: %v", pipelineID, err)
	}
	rev, err := store.PublishDraft(ctx, c, draft.ID, api.DraftPublishInput{
		ExpectedVersion: got.Version, VersionLabel: versionLabel, DocumentText: text,
		SchemaDigest: schema.Digest(), CelEnvDigest: defs.EnvDigest(),
	})
	if err != nil {
		t.Fatalf("PublishDraft %s: %v", pipelineID, err)
	}
	return rev, draft.ID
}

// TestNodeTemplatePublishRefsAdoptFromNode runs the whole part-2 surface:
// refs written at publish, the § 4 count, adopt-via-draft (with the
// open-draft skip) and the from_node read.
func TestNodeTemplatePublishRefsAdoptFromNode(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	token := migFixtureToken(t)
	slug := "sec-review-" + token
	c := m4APICaller(f)
	nt := APINodeTemplateStore{Pool: f.pool}
	p2Mop(t, f.pool)
	ntMop(t, f.pool, f.orgID)

	// the template the two workflows will reference.
	params := json.RawMessage(`{"type":"object","required":["focus"],"properties":{"focus":{"type":"string"}}}`)
	created, err := nt.CreateTemplate(ctx, c, api.NodeTemplateCreateInput{
		Slug: slug, DisplayName: "Security reviewer", Kind: "agent.acp",
		Parameters:    params,
		Config:        json.RawMessage(`{"profile":"managed-agent","prompt":"review ${{ parameters.focus }}"}`),
		OutputSchema:  json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "1.0.0",
	})
	if err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}

	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	defs, err := NewPipelineDefinitions()
	if err != nil {
		t.Fatalf("NewPipelineDefinitions: %v", err)
	}
	defs.WithTemplates(f.pool)

	pipeA, err := store.CreatePipeline(ctx, c, "p2-a-"+token, "P2 A", "")
	if err != nil {
		t.Fatalf("CreatePipeline A: %v", err)
	}
	pipeB, err := store.CreatePipeline(ctx, c, "p2-b-"+token, "P2 B", "")
	if err != nil {
		t.Fatalf("CreatePipeline B: %v", err)
	}
	p2Mop(t, f.pool, pipeA.ID, pipeB.ID)

	// A publishes a workflow referencing the template.
	revA, draftA := p2Publish(t, ctx, f, c, store, defs, pipeA.ID, p2Doc(slug, "p2-a-"+token), "1.0.0")

	// the refs row landed in the publish transaction.
	var refsN int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM pipeline_revision_template_refs
		WHERE pipeline_revision_id = $1::uuid AND template_id = $2::uuid AND node_id = 'review'`,
		revA.ID, created.ID).Scan(&refsN); err != nil {
		t.Fatalf("refs query: %v", err)
	}
	if refsN != 1 {
		t.Fatalf("refs rows for the published revision = %d, want 1", refsN)
	}

	// B publishes the same reference, then opens a draft of its own.
	revB, _ := p2Publish(t, ctx, f, c, store, defs, pipeB.ID, p2Doc(slug, "p2-b-"+token), "1.0.0")
	open, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: pipeB.ID, DocumentText: p2Doc(slug, "p2-b-"+token) + "# open draft\n",
		SourceKind: "manual", SourceSHA256: m4Hex("p2-open/" + token), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("open draft for B: %v", err)
	}
	_ = open

	// the § 4 count: two workflows reference the template in their latest
	// published revisions.
	detail, err := nt.GetTemplate(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("GetTemplate: %v", err)
	}
	if detail.Template.UsedInCount != 2 {
		t.Errorf("used_in_count = %d, want 2", detail.Template.UsedInCount)
	}
	if len(detail.Usages) != 2 {
		t.Errorf("usages = %d rows, want 2", len(detail.Usages))
	}
	for _, u := range detail.Usages {
		if !u.UpToDate || len(u.NodeIDs) != 1 || u.NodeIDs[0] != "review" {
			t.Errorf("usage %+v: want up_to_date with node review", u)
		}
	}

	// "Edit for all": revision 1.1.0 adopts A, skips B (open draft).
	resp, err := nt.CreateTemplateRevision(ctx, c, created.ID, api.NodeTemplateRevisionInput{
		Parameters:    params,
		Config:        json.RawMessage(`{"profile":"managed-agent","prompt":"review ${{ parameters.focus }} thoroughly"}`),
		OutputSchema:  json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace",
		VersionLabel:  "1.1.0",
		AdoptUsing:    true,
	})
	if err != nil {
		t.Fatalf("CreateTemplateRevision(adopt): %v", err)
	}
	if len(resp.Adopted) != 1 || resp.Adopted[0].PipelineID != pipeA.ID || resp.Adopted[0].DraftVersion != 1 {
		t.Fatalf("adopted = %+v, want exactly pipeline A with draft version 1", resp.Adopted)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0].PipelineID != pipeB.ID || resp.Skipped[0].Reason != "open_draft" {
		t.Fatalf("skipped = %+v, want exactly pipeline B with reason open_draft", resp.Skipped)
	}

	// the adopted draft: the referencing node points at 1.1.0, nothing else
	// moved, and the journal row carries the template_adopt reason.
	adopted, err := f.pipelines.GetDraft(ctx, resp.Adopted[0].DraftID)
	if err != nil {
		t.Fatalf("GetDraft adopted: %v", err)
	}
	if adopted.Status != "draft" {
		t.Errorf("adopted draft status = %q, want draft", adopted.Status)
	}
	if !contains(adopted.DocumentText, slug+"@1.1.0") {
		t.Errorf("the adopted document does not reference %s@1.1.0:\n%s", slug, adopted.DocumentText)
	}
	if contains(adopted.DocumentText, slug+"@1.0.0") {
		t.Errorf("the adopted document still references the old version:\n%s", adopted.DocumentText)
	}
	// the adopted draft's document_text is re-rendered from the canonical
	// document (ADR-0021 § 5); its canonical_document stays NULL until the
	// adopter validates it — honest, not invented.
	ntJournalRow(t, f.pool, "pipeline.draft.create", resp.Adopted[0].DraftID)

	// A publishes the adopted draft: its latest revision now references
	// 1.1.0, so A is up to date and B is not.
	if err := p2PublishRevalidate(t, ctx, f, c, store, defs, adopted); err != nil {
		t.Fatalf("publish adopted draft: %v", err)
	}
	detail2, err := nt.GetTemplate(ctx, c, created.ID)
	if err != nil {
		t.Fatalf("GetTemplate after adopt: %v", err)
	}
	if detail2.Template.UsedInCount != 2 {
		t.Errorf("used_in_count after adopt = %d, want 2", detail2.Template.UsedInCount)
	}
	latest := detail2.Revisions[0].VersionLabel
	if latest != "1.1.0" {
		t.Fatalf("latest version = %q, want 1.1.0", latest)
	}
	for _, u := range detail2.Usages {
		want := u.PipelineID == pipeA.ID
		if u.UpToDate != want {
			t.Errorf("usage %s up_to_date = %v, want %v (latest %s)", u.PipelineSlug, u.UpToDate, want, latest)
		}
	}
	_ = revB
	_ = draftA

	// from_node: an unvalidated draft has nothing to copy, a validated one
	// hands back the node's kind and config.
	unvalidated, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: pipeB.ID, DocumentText: p2Doc(slug, "p2-b-"+token),
		SourceKind: "manual", SourceSHA256: m4Hex("p2-unval/" + token), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("unvalidated draft: %v", err)
	}
	if _, _, err := nt.NodeFromDraft(ctx, c, unvalidated.ID, "review"); !errors.Is(err, api.ErrNodeTemplateDraftNotValidated) {
		t.Errorf("from_node on unvalidated draft: err = %v, want ErrNodeTemplateDraftNotValidated", err)
	}
	kind, config, err := nt.NodeFromDraft(ctx, c, draftA, "review")
	if err != nil {
		t.Fatalf("NodeFromDraft: %v", err)
	}
	if kind != "agent.acp" || !contains(string(config), `"focus"`) {
		t.Errorf("from_node = %q %s, want agent.acp with the node's config", kind, config)
	}
	if _, _, err := nt.NodeFromDraft(ctx, c, draftA, "nope"); !errors.Is(err, api.ErrNodeTemplateNotFound) {
		t.Errorf("from_node with a missing node: err = %v, want ErrNodeTemplateNotFound", err)
	}
}

// p2PublishRevalidate validates + records + publishes an existing draft (the
// adopt flow's draft) — the same three calls the route makes.
func p2PublishRevalidate(t *testing.T, ctx context.Context, f *m4Fixture, c api.Caller,
	store APIPipelineStore, defs *PipelineDefinitions, d Draft) error {
	t.Helper()
	outcome, err := defs.Validate(ctx, c, d.DocumentText)
	if err != nil {
		return err
	}
	if !outcome.Body.Valid {
		return fmt.Errorf("the adopted document does not validate: %+v", outcome.Body.Errors)
	}
	record := api.DraftValidationRecord{
		Status: "valid", Body: outcome.Body, CanonicalDocument: outcome.CanonicalDocument,
		RevisionDigest: outcome.RevisionDigest, CompiledPlan: outcome.CompiledPlan,
		PlanDigest: outcome.PlanDigest, DigestScope: outcome.DigestScope,
	}
	if _, err := store.RecordValidation(ctx, c, d.ID, record); err != nil {
		return err
	}
	got, err := store.GetDraft(ctx, c, d.ID)
	if err != nil {
		return err
	}
	text, err := defs.Export(got.CanonicalDocument)
	if err != nil {
		return err
	}
	_, err = store.PublishDraft(ctx, c, d.ID, api.DraftPublishInput{
		ExpectedVersion: got.Version, VersionLabel: "1.1.0", DocumentText: text,
		SchemaDigest: schema.Digest(), CelEnvDigest: defs.EnvDigest(),
	})
	return err
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
