package postgres

// TestRunSource*: ADR-0053 (start a run from a thread) against a real
// Postgres that ran 00011. Every claim is a row or a journal payload read
// back: the link both ways, the permission arms (404 invisible / 422
// mismatch), the thread-branch base vs the clean-thread default-branch
// fallback, the handoff_summary input and the artifact attach.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// rsSHA40 builds a plausible 40-char commit id from a label (the control
// plane stores the identity, it does not verify it against git — the worker
// does, at prepare).
func rsSHA40(t *testing.T, label string) string {
	t.Helper()
	// 16 hex chars from the digest helper, repeated to a commit-shape id.
	full := strings.Repeat(m4Hex(label), 4)[:40]
	if len(full) != 40 {
		t.Fatalf("sha helper produced %d chars", len(full))
	}
	return full
}

const rsVolume = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// rsThreadWorkspace inserts a live conversation workspace + one
// workspace_repos row with the recorded head/base for the given repo, the
// shape the worker writes after a committed thread turn (ADR-0017 D8/P8).
func rsThreadWorkspace(t *testing.T, f *m4Fixture, conversationID, repoID, base, head, state string) string {
	t.Helper()
	ctx := testCtx(t)
	var wsID, workerID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status, last_heartbeat_at)
		VALUES ('rs-worker-' || $1, 'lab', 'dev', 'online', now()) RETURNING id::text`,
		migFixtureToken(t)).Scan(&workerID); err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                          worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'conversation', $3::uuid, $4::uuid, $5, $6, $7,
		        CASE WHEN $7 IN ('ready','quarantined','released','lost') THEN now() END)
		RETURNING id::text`,
		f.orgID, f.projectID, conversationID, workerID, rsVolume,
		t.TempDir()+"/workspaces/conversation/"+conversationID, state).Scan(&wsID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// workspace_repos first: it references both the workspace and the
		// repository, and outlives both of my other cleanups otherwise.
		if _, err := f.pool.Exec(bg, `DELETE FROM workspace_repos WHERE workspace_id = $1`, wsID); err != nil {
			t.Logf("cleanup workspace_repos of %s: %v", wsID, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workspaces WHERE id = $1`, wsID); err != nil {
			t.Logf("cleanup workspace %s: %v", wsID, err)
		}
	})
	var headArg *string
	if head != "" {
		h := head
		headArg = &h
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO workspace_repos (workspace_id, repository_id, mirror_volume_id,
		                              checkout_path, mirror_path, admin_dir, run_ref,
		                              base_commit, head_commit)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
		wsID, repoID, rsVolume, t.TempDir()+"/acme", t.TempDir()+"/acme.git",
		t.TempDir()+"/acme.git/worktrees/acme", conversationID+"/acme-api", base, headArg); err != nil {
		t.Fatalf("insert workspace_repos: %v", err)
	}
	return wsID
}

// rsRepository inserts one project repository row.
func rsRepository(t *testing.T, f *m4Fixture, name string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		f.projectID, name, f.userID).Scan(&id); err != nil {
		t.Fatalf("insert repository %s: %v", name, err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM repositories WHERE id = $1`, id); err != nil {
			t.Logf("cleanup repository %s: %v", id, err)
		}
	})
	return id
}

// rsConversation creates a manual conversation through the real store path.
func rsConversation(t *testing.T, f *m4Fixture, projectID string) string {
	t.Helper()
	var profileID string
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT id::text FROM agent_profiles WHERE organization_id = $1::uuid AND name = 'Claude Code'`,
		f.orgID).Scan(&profileID); err != nil {
		t.Fatalf("seeded profile lookup (migration 00003): %v", err)
	}
	cv, err := (&CnvStore{Pool: f.pool}).CreateConversation(testCtx(t),
		Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true},
		projectID, profileID, "Why is CI slow on acme-api?", "")
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		for _, sql := range []string{
			`DELETE FROM conversation_control WHERE conversation_id = $1`,
			`DELETE FROM conversation_turns WHERE conversation_id = $1`,
			`DELETE FROM conversations WHERE id = $1`,
		} {
			if _, err := f.pool.Exec(bg, sql, cv.ID); err != nil {
				t.Logf("cleanup conversation %s: %v", cv.ID, err)
			}
		}
	})
	return cv.ID
}

// rsArtifact inserts a ready conversation artifact; label keeps the
// content-address sha distinct (artifacts_project_id_kind_sha256_key).
func rsArtifact(t *testing.T, f *m4Fixture, conversationID, label string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO artifacts (organization_id, project_id, conversation_id,
		                       name, kind, media_type, sha256, size_bytes,
		                       storage_backend, storage_key, created_by, state, ready_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'ci-timings.md', 'markdown', 'text/markdown',
		        $4, 100, 'local', 'artifacts/rs', 'worker', 'ready', now())
		RETURNING id::text`, f.orgID, f.projectID, conversationID, m4Hex("artifact/"+label)).Scan(&id); err != nil {
		t.Fatalf("insert artifact: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM artifacts WHERE id = $1`, id); err != nil {
			t.Logf("cleanup artifact %s: %v", id, err)
		}
	})
	return id
}

// rsSourceRun creates one run through the real API adapter with a source.
func rsSourceRun(t *testing.T, f *m4Fixture, key string, src *api.RunSourceInput) (api.RunView, bool, error) {
	t.Helper()
	return m4RunsWriteStore(f).CreateRun(testCtx(t), m4RunsWriteCaller(f), api.RunCreateInput{
		ProjectID:          f.projectID,
		PipelineRevisionID: f.revisionID,
		Key:                key,
		RequestSHA:         m4Hex("rs/" + key),
		TriggeredBy:        f.userID,
		Source:             src,
	})
}

// TestRunSourceThreadBranchBase is the happy arm: the thread branch has a
// recorded head beyond its base, so the run pins that head (repo_snapshot),
// the link is readable both ways, the handoff_summary input is recorded with
// origin submitted, the artifact is attached by reference and the
// run.created payload carries the source.
func TestRunSourceThreadBranchBase(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	repoID := rsRepository(t, f, "acme-api")
	convID := rsConversation(t, f, f.projectID)
	artID := rsArtifact(t, f, convID, "1")
	base, head := rsSHA40(t, "base"), rsSHA40(t, "head")
	rsThreadWorkspace(t, f, convID, repoID, base, head, "ready")

	view, created, err := rsSourceRun(t, f, "rs-thread", &api.RunSourceInput{
		ConversationID: convID, Summary: "Cache key misses every run.", ArtifactIDs: []string{artID},
	})
	if err != nil {
		t.Fatalf("CreateRun with source: %v", err)
	}
	if !created {
		t.Fatalf("first create reported created=false")
	}
	if view.SourceConversationID == nil || *view.SourceConversationID != convID {
		t.Errorf("run source_conversation_id = %v, want %s", view.SourceConversationID, convID)
	}
	if len(view.RepoSnapshot) != 1 || view.RepoSnapshot[0].BaseCommit != head {
		t.Errorf("repo_snapshot = %+v, want one entry pinned to the thread head %s", view.RepoSnapshot, head)
	}
	if view.SourceBase == nil || len(view.SourceBase.Repositories) != 1 {
		t.Fatalf("create response base = %+v, want one per-repository row", view.SourceBase)
	}
	row := view.SourceBase.Repositories[0]
	if row.Mode != api.RunBaseThreadBranch || row.BaseCommit == nil || *row.BaseCommit != head || row.Reason == "" {
		t.Errorf("base row = %+v, want thread_branch pinning %s with a reason", row, head)
	}
	var summary *api.RunInputValueView
	for _, in := range view.Inputs {
		if in.Name == "handoff_summary" {
			summary = &in
		}
	}
	if summary == nil {
		t.Fatalf("handoff_summary input missing from %+v", view.Inputs)
	}
	if summary.Origin != "submitted" {
		t.Errorf("handoff_summary origin = %q, want submitted", summary.Origin)
	}
	var got string
	if err := json.Unmarshal(summary.Value, &got); err != nil || got != "Cache key misses every run." {
		t.Errorf("handoff_summary value = %s (%v), want the submitted summary", string(summary.Value), err)
	}

	// Linked back from the thread.
	cv, err := (&CnvStore{Pool: f.pool}).GetConversation(ctx,
		Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}, convID)
	if err != nil {
		t.Fatalf("GetConversation: %v", err)
	}
	if len(cv.LinkedRuns) != 1 || cv.LinkedRuns[0].RunID != view.ID || cv.LinkedRuns[0].CreatedAt.IsZero() {
		t.Errorf("conversation linked_runs = %+v, want exactly this run", cv.LinkedRuns)
	}

	// The artifact is attached by reference, keeping its conversation_id.
	var artRun, artConv string
	if err := f.pool.QueryRow(ctx,
		`SELECT run_id::text, conversation_id::text FROM artifacts WHERE id = $1`, artID).
		Scan(&artRun, &artConv); err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if artRun != view.ID || artConv != convID {
		t.Errorf("artifact (run %s, conversation %s), want (run %s, conversation %s)", artRun, artConv, view.ID, convID)
	}

	// The journal row carries the link.
	var payload string
	if err := f.pool.QueryRow(ctx,
		`SELECT payload::text FROM domain_events WHERE run_id = $1::uuid AND type = 'run.created'`,
		view.ID).Scan(&payload); err != nil {
		t.Fatalf("read run.created payload: %v", err)
	}
	if !strings.Contains(payload, `"source_conversation_id": `+"\""+convID) && !strings.Contains(payload, `"source_conversation_id":"`+convID) {
		t.Errorf("run.created payload %s does not name the source conversation", payload)
	}

	// A second run from the same thread: both must be listed, creation order.
	second, _, err := rsSourceRun(t, f, "rs-thread-2", &api.RunSourceInput{ConversationID: convID})
	if err != nil {
		t.Fatalf("second CreateRun: %v", err)
	}
	cv2, err := (&CnvStore{Pool: f.pool}).GetConversation(ctx,
		Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}, convID)
	if err != nil {
		t.Fatalf("GetConversation (second): %v", err)
	}
	if len(cv2.LinkedRuns) != 2 || cv2.LinkedRuns[0].RunID != view.ID || cv2.LinkedRuns[1].RunID != second.ID {
		t.Errorf("linked_runs after second handoff = %+v, want both, creation order", cv2.LinkedRuns)
	}
	// The second run's response has the same honest per-repo answer.
	if second.SourceBase == nil || second.SourceBase.Repositories[0].Mode != api.RunBaseThreadBranch {
		t.Errorf("second run base = %+v, want thread_branch", second.SourceBase)
	}
}

// TestRunSourceCleanThreadFallsBackToDefaultBranch is the honest empty arm:
// a thread whose recorded head equals its base (or has no recorded head at
// all) carries nothing — the run still links to the thread, but that
// repository's mode is default_branch with a null base_commit, and
// repo_snapshot pins nothing.
func TestRunSourceCleanThreadFallsBackToDefaultBranch(t *testing.T) {
	f := m4Setup(t)
	repoID := rsRepository(t, f, "acme-api")
	convID := rsConversation(t, f, f.projectID)
	base := rsSHA40(t, "clean-base")
	// A second repo with NO workspace row at all (the thread never checked it
	// out) — both arms of the fallback in one project.
	rsRepository(t, f, "other")
	rsThreadWorkspace(t, f, convID, repoID, base, base, "ready") // head == base: clean

	view, _, err := rsSourceRun(t, f, "rs-clean", &api.RunSourceInput{ConversationID: convID})
	if err != nil {
		t.Fatalf("CreateRun with clean-thread source: %v", err)
	}
	if view.SourceConversationID == nil || *view.SourceConversationID != convID {
		t.Errorf("source_conversation_id = %v, want %s (the link survives a clean branch)", view.SourceConversationID, convID)
	}
	if len(view.RepoSnapshot) != 0 {
		t.Errorf("repo_snapshot = %+v, want nothing pinned for a clean thread", view.RepoSnapshot)
	}
	if view.SourceBase == nil || len(view.SourceBase.Repositories) != 2 {
		t.Fatalf("base = %+v, want one row per repository", view.SourceBase)
	}
	for _, row := range view.SourceBase.Repositories {
		if row.Mode != api.RunBaseDefaultBranch {
			t.Errorf("repo %s mode = %s, want default_branch", row.RepositoryID, row.Mode)
		}
		if row.BaseCommit != nil {
			t.Errorf("repo %s base_commit = %v, want null", row.RepositoryID, *row.BaseCommit)
		}
		if row.Reason == "" {
			t.Errorf("repo %s reason is empty: the response must say WHY it is the default branch", row.RepositoryID)
		}
	}
}

// TestRunSourceUnknownAndInvisibleConversationIsNotFound is the 404 arm: an
// unknown conversation id and a conversation the caller is not a member of
// are the same answer (no existence is disclosed).
func TestRunSourceUnknownAndInvisibleConversationIsNotFound(t *testing.T) {
	f := m4Setup(t)
	// Unknown id.
	_, _, err := rsSourceRun(t, f, "rs-unknown", &api.RunSourceInput{
		ConversationID: "00000000-0000-4000-8000-0000000000ff",
	})
	if !errors.Is(err, api.ErrConversationNotFound) {
		t.Errorf("unknown conversation: err = %v, want api.ErrConversationNotFound", err)
	}

	// Invisible: a second project the caller is NOT a member of, with a
	// conversation in it, while the run is created in the fixture's project.
	var otherProject string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'rs-other-' || $2, 'RS other', $3) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.userID).Scan(&otherProject); err != nil {
		t.Fatalf("insert other project: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM projects WHERE id = $1`, otherProject); err != nil {
			t.Logf("cleanup other project: %v", err)
		}
	})
	var bob string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO users (organization_id, display_name) VALUES ($1, 'rs-bob-' || $2) RETURNING id::text`,
		f.orgID, migFixtureToken(t)).Scan(&bob); err != nil {
		t.Fatalf("insert bob: %v", err)
	}
	if _, err := f.pool.Exec(testCtx(t), `
		INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'contributor')`,
		f.projectID, bob); err != nil {
		t.Fatalf("membership: %v", err)
	}
	// Clean up bob's membership + user before the m4 fixture drops the project
	// and org users (LIFO: mine runs first).
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`, f.projectID, bob); err != nil {
			t.Logf("cleanup bob membership: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM users WHERE id = $1::uuid`, bob); err != nil {
			t.Logf("cleanup bob: %v", err)
		}
	})
	convID := rsConversation(t, f, otherProject)
	_, _, err = m4RunsWriteStore(f).CreateRun(testCtx(t),
		api.Caller{UserID: bob, OrganizationID: f.orgID},
		api.RunCreateInput{
			ProjectID: f.projectID, PipelineRevisionID: f.revisionID,
			Key: "rs-invisible", RequestSHA: m4Hex("rs/invisible"), TriggeredBy: bob,
			Source: &api.RunSourceInput{ConversationID: convID},
		})
	if !errors.Is(err, api.ErrConversationNotFound) {
		t.Errorf("invisible conversation: err = %v, want api.ErrConversationNotFound", err)
	}
}

// TestRunSourceProjectMismatchIs422 is the refusal arm: the caller (an org
// admin, who sees both objects) names a conversation from another project
// while creating the run in the fixture's project — the claim is false, so
// the answer is the typed 422, not the 404 invisibility answer.
func TestRunSourceProjectMismatchIs422(t *testing.T) {
	f := m4Setup(t)
	var otherProject string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'rs-mismatch-' || $2, 'RS mismatch', $3) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.userID).Scan(&otherProject); err != nil {
		t.Fatalf("insert other project: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM projects WHERE id = $1`, otherProject); err != nil {
			t.Logf("cleanup other project: %v", err)
		}
	})
	convID := rsConversation(t, f, otherProject)
	_, _, err := rsSourceRun(t, f, "rs-mismatch", &api.RunSourceInput{ConversationID: convID})
	if !errors.Is(err, api.ErrRunSourceProjectMismatch) {
		t.Fatalf("mismatched source: err = %v, want api.ErrRunSourceProjectMismatch", err)
	}
	// Nothing was written for the refused create.
	var n int
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT count(*) FROM runs WHERE project_id = $1::uuid AND source_conversation_id = $2::uuid`,
		f.projectID, convID).Scan(&n); err != nil {
		t.Fatalf("count refused runs: %v", err)
	}
	if n != 0 {
		t.Errorf("refused create wrote %d run row(s), want none", n)
	}
}

// TestRunSourceArtifactAttachAndRefusals covers the artifact arm: unknown and
// foreign ids are 404, an artifact already attached to another run is the
// 422 taken-refusal, and a twice-named id attaches once.
func TestRunSourceArtifactAttachAndRefusals(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	convID := rsConversation(t, f, f.projectID)
	artID := rsArtifact(t, f, convID, "attach")

	// Unknown artifact.
	_, _, err := rsSourceRun(t, f, "rs-art-unknown", &api.RunSourceInput{
		ConversationID: convID,
		ArtifactIDs:    []string{"00000000-0000-4000-8000-000000000aa1"},
	})
	if !errors.Is(err, api.ErrArtifactNotFound) {
		t.Errorf("unknown artifact: err = %v, want api.ErrArtifactNotFound", err)
	}

	// A foreign project's artifact is the same 404 (naming a row that is not
	// here is not a leak target).
	var foreignProject string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'rs-foreign-' || $2, 'RS foreign', $3) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.userID).Scan(&foreignProject); err != nil {
		t.Fatalf("insert foreign project: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM projects WHERE id = $1`, foreignProject); err != nil {
			t.Logf("cleanup foreign project: %v", err)
		}
	})
	var foreignArt string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO artifacts (organization_id, project_id, name, kind, media_type, sha256,
		                       size_bytes, storage_backend, storage_key, created_by, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'foreign.md', 'markdown', 'text/markdown', $3,
		        10, 'local', 'artifacts/foreign', 'worker', 'ready', now())
		RETURNING id::text`, f.orgID, foreignProject, m4Hex("foreign")).Scan(&foreignArt); err != nil {
		t.Fatalf("insert foreign artifact: %v", err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM artifacts WHERE id = $1`, foreignArt); err != nil {
			t.Logf("cleanup foreign artifact: %v", err)
		}
	})
	_, _, err = rsSourceRun(t, f, "rs-art-foreign", &api.RunSourceInput{
		ConversationID: convID, ArtifactIDs: []string{foreignArt},
	})
	if !errors.Is(err, api.ErrArtifactNotFound) {
		t.Errorf("foreign artifact: err = %v, want api.ErrArtifactNotFound", err)
	}

	// Attach to a run, then refuse a second run with the same artifact.
	first, _, err := rsSourceRun(t, f, "rs-art-1", &api.RunSourceInput{
		ConversationID: convID, ArtifactIDs: []string{artID},
	})
	if err != nil {
		t.Fatalf("first CreateRun with artifact: %v", err)
	}
	_, _, err = rsSourceRun(t, f, "rs-art-2", &api.RunSourceInput{
		ConversationID: convID, ArtifactIDs: []string{artID},
	})
	if !errors.Is(err, api.ErrRunSourceArtifactTaken) {
		t.Errorf("taken artifact: err = %v, want api.ErrRunSourceArtifactTaken", err)
	}
	var artRun string
	if err := f.pool.QueryRow(ctx, `SELECT COALESCE(run_id::text,'') FROM artifacts WHERE id = $1`, artID).
		Scan(&artRun); err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if artRun != first.ID {
		t.Errorf("artifact attached to %s, want the first run %s (the refused run must not move it)", artRun, first.ID)
	}

	// A twice-named id (fresh artifact) is one reference, not a failure.
	secondArt := rsArtifact(t, f, convID, "dup")
	_, created, err := rsSourceRun(t, f, "rs-art-dup", &api.RunSourceInput{
		ConversationID: convID,
		ArtifactIDs:    []string{secondArt, secondArt},
	})
	if err != nil || !created {
		t.Fatalf("twice-named artifact: err = %v created = %v, want a clean create", err, created)
	}
	var dupRuns int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(DISTINCT run_id) FROM artifacts WHERE id = $1 AND run_id IS NOT NULL`, secondArt).Scan(&dupRuns); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	if dupRuns != 1 {
		t.Errorf("twice-named artifact attached to %d run(s), want exactly 1", dupRuns)
	}
}
