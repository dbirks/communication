package postgres

// TestNodeTemplate*: ADR-0049 part 1 (the step-registry store) exercised
// against a real Postgres. Nothing here is mocked: a 23505, a 42702 or a
// mis-bound parameter fails with the database's own words.

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// ntMop deletes this test family's rows both NOW (a crashed earlier run
// may have leaked them into the shared database) and at test end (this
// run's own rows, before the fixture's user deletion).
func ntMop(t *testing.T, pool *pgxpool.Pool, orgIDs ...string) {
	t.Helper()
	mop := func() {
		bg := context.Background()
		for _, orgID := range orgIDs {
			for _, sql := range []string{
				`DELETE FROM node_template_revisions WHERE organization_id = $1`,
				`DELETE FROM node_templates WHERE organization_id = $1`,
			} {
				if _, err := pool.Exec(bg, sql, orgID); err != nil {
					t.Errorf("cleanup %s: %v", sql, err)
				}
			}
		}
		for _, sql := range []string{
			`DELETE FROM outbox WHERE global_seq IN
				(SELECT global_seq FROM domain_events WHERE type IN
					('node_template.create','node_template.revision.publish',
					 'node_template.duplicate','pipeline.update'))`,
			`DELETE FROM domain_events WHERE type IN
				('node_template.create','node_template.revision.publish',
				 'node_template.duplicate','pipeline.update')`,
		} {
			if _, err := pool.Exec(bg, sql); err != nil {
				t.Errorf("cleanup %s: %v", sql, err)
			}
		}
	}
	mop()
	t.Cleanup(mop)
}

// ntJournalRow asserts the journal row for one event type naming id.
func ntJournalRow(t *testing.T, pool *pgxpool.Pool, typ, id string) {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM domain_events WHERE "type" = $1 AND payload::text LIKE '%'||$2||'%'`,
		typ, id).Scan(&n); err != nil {
		t.Fatalf("journal query: %v", err)
	}
	if n != 1 {
		t.Errorf("journal rows for %s naming %s = %d, want 1", typ, id, n)
	}
}

// ntForeignOrg seeds a second organization with its own user on the
// fixture's pool: the org-isolation arm of every read.
func ntForeignOrg(t *testing.T, pool *pgxpool.Pool) (orgID, userID string) {
	t.Helper()
	bg := context.Background()
	if err := pool.QueryRow(bg, `
		INSERT INTO organizations (slug, name)
		VALUES ('nt-other', 'NT other org') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatalf("insert foreign org: %v", err)
	}
	if err := pool.QueryRow(bg, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'nt-other-user') RETURNING id`, orgID).Scan(&userID); err != nil {
		t.Fatalf("insert foreign user: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, `DELETE FROM node_template_revisions WHERE organization_id = $1`, orgID); err != nil {
			t.Errorf("cleanup foreign revisions: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM node_templates WHERE organization_id = $1`, orgID); err != nil {
			t.Errorf("cleanup foreign templates: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup foreign user: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, orgID); err != nil {
			t.Errorf("cleanup foreign org: %v", err)
		}
	})
	return orgID, userID
}

func TestNodeTemplateCreateRevisionsDuplicateIsolation(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := APINodeTemplateStore{Pool: f.pool}
	caller := m4APICaller(f)
	ntMop(t, f.pool, f.orgID)

	params := json.RawMessage(`{"type":"object","properties":{"focus":{"type":"string"}}}`)
	config := json.RawMessage(`{"prompt":"review ${{ params.focus }}"}`)

	// create: template row + revision 1, one journal row, digest shape.
	created, err := store.CreateTemplate(ctx, caller, api.NodeTemplateCreateInput{
		Slug: "security-reviewer", DisplayName: "Security reviewer",
		Description: "reviews diffs", Kind: "agent.acp",
		Parameters: params, Config: config, OutputSchema: json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "1.0.0",
	})
	if err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}
	if !strings.HasPrefix(created.LatestRevision.RevisionDigest, "sha256:") ||
		len(created.LatestRevision.RevisionDigest) != len("sha256:")+64 {
		t.Errorf("revision digest %q is not the sha256 scope form", created.LatestRevision.RevisionDigest)
	}
	if created.LatestRevision.RevisionNumber != 1 {
		t.Errorf("create returns revision number %d, want 1", created.LatestRevision.RevisionNumber)
	}
	if created.UsedInCount != 0 {
		t.Errorf("used_in_count = %d, want 0 (refs table is empty until publish)", created.UsedInCount)
	}
	ntJournalRow(t, f.pool, "node_template.create", created.ID)

	// slug duplicate in the same org is the conflict sentinel.
	if _, err := store.CreateTemplate(ctx, caller, api.NodeTemplateCreateInput{
		Slug: "security-reviewer", DisplayName: "again", Kind: "agent.acp",
		Parameters: params, Config: config, OutputSchema: json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "1.0.0",
	}); !errors.Is(err, api.ErrNodeTemplateConflict) {
		t.Errorf("duplicate slug: err = %v, want ErrNodeTemplateConflict", err)
	}

	// revision 2: monotonic number, new digest on new content.
	rev2, err := store.CreateTemplateRevision(ctx, caller, created.ID, api.NodeTemplateRevisionInput{
		Parameters:    params,
		Config:        json.RawMessage(`{"prompt":"review ${{ params.focus }} thoroughly"}`),
		OutputSchema:  json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace",
		VersionLabel:  "1.1.0",
	})
	if err != nil {
		t.Fatalf("CreateTemplateRevision: %v", err)
	}
	if rev2.Revision.RevisionNumber != 2 {
		t.Errorf("revision number = %d, want 2", rev2.Revision.RevisionNumber)
	}
	if rev2.Revision.RevisionDigest == created.LatestRevision.RevisionDigest {
		t.Error("changed content produced the same digest")
	}
	ntJournalRow(t, f.pool, "node_template.revision.publish", rev2.Revision.RevisionID)

	// version_label already taken is a 409 sentinel, whatever the number.
	if _, err := store.CreateTemplateRevision(ctx, caller, created.ID, api.NodeTemplateRevisionInput{
		Parameters: params, Config: config, OutputSchema: json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "1.1.0",
	}); !errors.Is(err, api.ErrNodeTemplateConflict) {
		t.Errorf("duplicate version_label: err = %v, want ErrNodeTemplateConflict", err)
	}

	// same content as revision 2: same digest, a NEW row (no org-wide
	// digest uniqueness — identical content in two templates is the
	// duplicate story, and a re-published revision is a new pin).
	rev3, err := store.CreateTemplateRevision(ctx, caller, created.ID, api.NodeTemplateRevisionInput{
		Parameters:    params,
		Config:        json.RawMessage(`{"prompt":"review ${{ params.focus }} thoroughly"}`),
		OutputSchema:  json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace",
		VersionLabel:  "1.1.1",
	})
	if err != nil {
		t.Fatalf("third revision: %v", err)
	}
	if rev3.Revision.RevisionDigest != rev2.Revision.RevisionDigest {
		t.Error("identical content produced different digests")
	}

	// Immutability: revision 1's content is byte-identical after two more
	// revisions landed — there is no UPDATE path to it, so a re-read must
	// return what the create call returned.
	detail, err := store.GetTemplate(ctx, caller, created.ID)
	if err != nil {
		t.Fatalf("GetTemplate: %v", err)
	}
	if len(detail.Revisions) != 3 {
		t.Fatalf("revision history = %d rows, want 3", len(detail.Revisions))
	}
	if detail.Revisions[0].RevisionNumber != 3 || detail.Revisions[2].RevisionNumber != 1 {
		t.Errorf("history order = [%d, ..., %d], want newest first",
			detail.Revisions[0].RevisionNumber, detail.Revisions[2].RevisionNumber)
	}
	var wantC, gotC any
	if err := json.Unmarshal(config, &wantC); err != nil {
		t.Fatalf("unmarshal want config: %v", err)
	}
	if err := json.Unmarshal(detail.Revisions[2].Config, &gotC); err != nil {
		t.Fatalf("unmarshal stored config: %v", err)
	}
	if !reflect.DeepEqual(wantC, gotC) {
		t.Errorf("revision 1 config changed: %s", detail.Revisions[2].Config)
	}
	if detail.Template.UsedInCount != 0 || len(detail.Usages) != 0 {
		t.Errorf("usages = %+v, want none (refs table is empty until publish)", detail.Usages)
	}

	// list: org-scoped, one query's worth.
	templates, err := store.ListTemplates(ctx, caller)
	if err != nil {
		t.Fatalf("ListTemplates: %v", err)
	}
	if len(templates) != 1 || templates[0].ID != created.ID {
		t.Fatalf("list = %d rows, want the one created template", len(templates))
	}

	// duplicate: a NEW template, revision 1 = content copy of the source's
	// LATEST revision (same version_label, same digest, revision_number 1).
	dup, err := store.DuplicateTemplate(ctx, caller, created.ID, "security-reviewer-copy", "Copy")
	if err != nil {
		t.Fatalf("DuplicateTemplate: %v", err)
	}
	if dup.LatestRevision.RevisionNumber != 1 ||
		dup.LatestRevision.VersionLabel != "1.1.1" ||
		dup.LatestRevision.RevisionDigest != detail.Revisions[0].RevisionDigest {
		t.Errorf("duplicate revision = %+v, want a content copy of the latest", dup.LatestRevision)
	}
	ntJournalRow(t, f.pool, "node_template.duplicate", dup.ID)
	if _, err := store.DuplicateTemplate(ctx, caller, created.ID, "security-reviewer", "x"); !errors.Is(err, api.ErrNodeTemplateConflict) {
		t.Errorf("duplicate into a taken slug: err = %v, want conflict", err)
	}
	templates, _ = store.ListTemplates(ctx, caller)
	if len(templates) != 2 {
		t.Errorf("list after duplicate = %d rows, want 2", len(templates))
	}

	// org isolation: the same template id in another org is not-found, and
	// the list never discloses it.
	otherOrg, otherUser := ntForeignOrg(t, f.pool)
	other := api.Caller{UserID: otherUser, OrganizationID: otherOrg}
	otherT, err := store.CreateTemplate(ctx, other, api.NodeTemplateCreateInput{
		Slug: "foreign", DisplayName: "foreign", Kind: "agent.acp",
		Parameters: params, Config: config, OutputSchema: json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "1.0.0",
	})
	if err != nil {
		t.Fatalf("foreign CreateTemplate: %v", err)
	}
	if _, err := store.GetTemplate(ctx, caller, otherT.ID); !errors.Is(err, api.ErrNodeTemplateNotFound) {
		t.Errorf("foreign GetTemplate by caller: err = %v, want ErrNodeTemplateNotFound", err)
	}
	if _, err := store.CreateTemplateRevision(ctx, caller, otherT.ID, api.NodeTemplateRevisionInput{
		Parameters: params, Config: config, OutputSchema: json.RawMessage(`{}`),
		WorkspaceMode: "run_workspace", VersionLabel: "2.0.0",
	}); !errors.Is(err, api.ErrNodeTemplateNotFound) {
		t.Errorf("foreign revision by caller: err = %v, want not-found", err)
	}
	list, err := store.ListTemplates(ctx, caller)
	if err != nil {
		t.Fatalf("list after foreign create: %v", err)
	}
	if len(list) != 2 {
		t.Errorf("list discloses foreign org's template: %d rows, want 2", len(list))
	}
}

func TestNodeTemplateFolderSetClear(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	pipelineAPI := APIPipelineStore{S: f.pipelines}
	ntMop(t, f.pool, f.orgID)
	caller := m4APICaller(f)

	set := "Agent loops"
	got, err := pipelineAPI.UpdatePipeline(ctx, caller, f.pipelineID,
		api.PipelineUpdateInput{Folder: api.FolderPatch{Set: true, Value: set}})
	if err != nil {
		t.Fatalf("set folder: %v", err)
	}
	if got.Folder == nil || *got.Folder != set {
		t.Errorf("folder after set = %v, want %q", got.Folder, set)
	}
	ntJournalRow(t, f.pool, "pipeline.update", f.pipelineID)

	// absent member does not move the column.
	got, err = pipelineAPI.UpdatePipeline(ctx, caller, f.pipelineID,
		api.PipelineUpdateInput{Description: strPtr("unchanged folder test")})
	if err != nil {
		t.Fatalf("description patch: %v", err)
	}
	if got.Folder == nil || *got.Folder != set {
		t.Errorf("folder moved on a folder-less PATCH: %v", got.Folder)
	}

	// JSON null clears it.
	got, err = pipelineAPI.UpdatePipeline(ctx, caller, f.pipelineID,
		api.PipelineUpdateInput{Folder: api.FolderPatch{Clear: true}})
	if err != nil {
		t.Fatalf("clear folder: %v", err)
	}
	if got.Folder != nil {
		t.Errorf("folder after clear = %v, want nil", *got.Folder)
	}

	// the list route carries the column too.
	sums, err := pipelineAPI.ListPipelines(ctx, caller)
	if err != nil {
		t.Fatalf("ListPipelines: %v", err)
	}
	for _, s := range sums {
		if s.ID == f.pipelineID && s.Folder != nil {
			t.Errorf("list row folder = %v, want nil after clear", *s.Folder)
		}
	}
}

func strPtr(s string) *string { return &s }
