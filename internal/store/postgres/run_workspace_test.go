package postgres

// TestRunWorkspace*: the database half of docs/m4-contract.md § 4 step 3 —
// the run-scoped workspaces row and the one-way affinity door (ADR-0023 § 4)
// committed in ONE transaction, plus worker.RunWorkspaceResolver. Integration
// layer: every assertion reads rows a real Postgres wrote, and the refusal
// leg checks the journal row the refusal is required to leave behind.

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/worker"
)

// runWorkspaceVolume records a worker's measured workspaces root, the way M2's
// prepare does, so Prepare can derive root_path instead of inventing one.
func runWorkspaceVolume(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workerID, tag string) string {
	t.Helper()
	volumeID := m4Digest("volume/" + tag)
	if _, err := pool.Exec(ctx, `
		INSERT INTO worker_volumes (worker_id, root_kind, root_path, st_dev, st_ino, fstype, volume_id)
		VALUES ($1::uuid, 'workspaces', $2, 66391, 100, 'ext4', $3)
		ON CONFLICT (worker_id, root_kind) DO UPDATE SET volume_id = EXCLUDED.volume_id`,
		workerID, "/var/lib/communication/workspaces-"+tag, volumeID); err != nil {
		t.Fatalf("seed worker volume: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE worker_id = $1)`,
			workerID); err != nil {
			t.Errorf("cleanup workspace repos: %v", err)
		}
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM workspaces WHERE worker_id = $1`, workerID); err != nil {
			t.Errorf("cleanup workspaces: %v", err)
		}
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM worker_volumes WHERE worker_id = $1`, workerID); err != nil {
			t.Errorf("cleanup worker volume: %v", err)
		}
	})
	return volumeID
}

// runWorkspaceRepo seeds one repository of the fixture project.
func runWorkspaceRepo(t *testing.T, ctx context.Context, pool *pgxpool.Pool, f *m4Fixture) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1::uuid, 'backend-' || $2, 'file:///lab/backend.git', $3::uuid) RETURNING id::text`,
		f.projectID, migFixtureToken(t), f.userID).Scan(&id); err != nil {
		t.Fatalf("seed repository: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM repositories WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup repository: %v", err)
		}
	})
	return id
}

// runWorkspaceEvents counts workspace.recovery_lost rows for a run and
// returns the payload reason of the newest one.
func runWorkspaceEvents(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID string) (int, string) {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT payload->>'reason' FROM domain_events
		WHERE run_id = $1::uuid AND type = 'workspace.recovery_lost'`, runID)
	if err != nil {
		t.Fatalf("read recovery_lost: %v", err)
	}
	defer rows.Close()
	var n int
	var reason string
	for rows.Next() {
		n++
		if err := rows.Scan(&reason); err != nil {
			t.Fatalf("scan recovery_lost: %v", err)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read recovery_lost rows: %v", err)
	}
	return n, reason
}

// TestRunWorkspacePrepareAndResolve is the happy path in the order the worker
// meets it: unresolved before preparation, then row + affinity atomically,
// then an idempotent repeat, then the second worker's refusal.
func TestRunWorkspacePrepareAndResolve(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	resolver := worker.RunWorkspaceResolver(store)

	runID := m4RunsReadSeedRun(t, ctx, f)
	w1 := m4Worker(t, ctx, f.pool, "rws-a", 2)
	vol1 := runWorkspaceVolume(t, ctx, f.pool, w1, "rws-a")

	// Before: the honest "not prepared yet", never a zero-value ref.
	if ref, ok, err := resolver.RunWorkspace(ctx, runID); err != nil || ok || ref.WorkspaceID != "" {
		t.Fatalf("RunWorkspace before prepare = (%+v, %v, %v), want zero/false/nil", ref, ok, err)
	}

	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	ref, err := store.Prepare(ctx, runID, w1, vol1,
		[]worker.CheckpointRepoState{{RepositoryID: repoID, BaseCommit: "a1", HeadCommit: "b2"}})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if ref.WorkspaceID == "" || ref.VolumeID != vol1 || len(ref.RepoStates) != 1 {
		t.Fatalf("Prepare returned %+v", ref)
	}

	// The row and the door, read back from the database — one commit means
	// both are there, and the run arm of the scope CHECK means run_id is set
	// with conversation_id NULL.
	var scopeKind, convID, rootPath, state string
	if err := f.pool.QueryRow(ctx, `
		SELECT scope_kind, COALESCE(conversation_id::text, ''), root_path, state
		FROM workspaces WHERE id = $1::uuid`, ref.WorkspaceID).
		Scan(&scopeKind, &convID, &rootPath, &state); err != nil {
		t.Fatalf("read workspace row: %v", err)
	}
	if scopeKind != "run" || convID != "" || state != "preparing" {
		t.Errorf("workspace row = scope %q conversation %q state %q", scopeKind, convID, state)
	}
	// root_path is LayoutOf's run path under the worker's measured root, which
	// is the path the sandbox grant will be built from.
	if want := "/var/lib/communication/workspaces-rws-a/run/" + runID; rootPath != want {
		t.Errorf("root_path = %q, want %q", rootPath, want)
	}
	var affinity, affVolume string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(worker_affinity::text, ''), COALESCE(worker_volume_id, '')
		FROM runs WHERE id = $1::uuid`, runID).Scan(&affinity, &affVolume); err != nil {
		t.Fatalf("read run affinity: %v", err)
	}
	if affinity != w1 || affVolume != vol1 {
		t.Fatalf("affinity = (%s, %s), want (%s, %s)", affinity, affVolume, w1, vol1)
	}

	// Idempotent: the same worker prepares the same run again and gets the
	// same row, not a second copy.
	again, err := store.Prepare(ctx, runID, w1, vol1, nil)
	if err != nil {
		t.Fatalf("Prepare (repeat): %v", err)
	}
	if again.WorkspaceID != ref.WorkspaceID {
		t.Fatalf("repeat Prepare workspace = %s, want %s", again.WorkspaceID, ref.WorkspaceID)
	}

	// After: the resolver answers, and the repo states come from the recorded
	// workspace_repos rows (none yet here — RecordRepos owns those), so the
	// ref is at least identity-complete.
	got, ok, err := resolver.RunWorkspace(ctx, runID)
	if err != nil || !ok {
		t.Fatalf("RunWorkspace after prepare = (%v, %v), want ok", ok, err)
	}
	if got.WorkspaceID != ref.WorkspaceID || got.VolumeID != vol1 {
		t.Errorf("resolved %+v, want workspace %s volume %s", got, ref.WorkspaceID, vol1)
	}

	// A different worker is refused, and the refusal is case 20's honest arm.
	w2 := m4Worker(t, ctx, f.pool, "rws-b", 2)
	vol2 := runWorkspaceVolume(t, ctx, f.pool, w2, "rws-b")
	if _, err := store.Prepare(ctx, runID, w2, vol2, nil); !errors.Is(err, ErrRunWorkspaceDifferentWorker) {
		t.Fatalf("Prepare by a different worker err = %v, want ErrRunWorkspaceDifferentWorker", err)
	}
	n, reason := runWorkspaceEvents(t, ctx, f.pool, runID)
	if n != 1 || reason != "different_worker" {
		t.Fatalf("workspace.recovery_lost rows = %d reason %q, want 1 different_worker", n, reason)
	}
	// The refusal changed nothing: still worker 1's door, still one workspace.
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(worker_affinity::text, '') FROM runs WHERE id = $1::uuid`, runID).
		Scan(&affinity); err != nil || affinity != w1 {
		t.Fatalf("affinity after refusal = (%s, %v), want %s", affinity, err, w1)
	}
	var count int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM workspaces WHERE scope_kind = 'run' AND run_id = $1::uuid`, runID).
		Scan(&count); err != nil || count != 1 {
		t.Fatalf("run workspace rows = %d (err %v), want 1 — a refusal never clones a second copy", count, err)
	}

	// Retrying the wrong worker does not bury the journal in repeats.
	if _, err := store.Prepare(ctx, runID, w2, vol2, nil); !errors.Is(err, ErrRunWorkspaceDifferentWorker) {
		t.Fatalf("second refusal err = %v, want ErrRunWorkspaceDifferentWorker", err)
	}
	if n, _ := runWorkspaceEvents(t, ctx, f.pool, runID); n != 1 {
		t.Fatalf("workspace.recovery_lost rows = %d after a retry, want still 1", n)
	}
}

// TestRunWorkspacePrepareRefusals covers what Prepare must never accept: a run
// that does not exist, and a worker whose volume was never measured (a root
// path invented here would be a sandbox grant invented too).
func TestRunWorkspacePrepareRefusals(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	runID := m4RunsReadSeedRun(t, ctx, f)
	w := m4Worker(t, ctx, f.pool, "rws-c", 1)

	if _, err := store.Prepare(ctx, runID, w, m4Digest("volume/unmeasured"), nil); err == nil {
		t.Fatal("Prepare with an unrecorded volume succeeded, want an error")
	} else if errors.Is(err, ErrRunNotFound) {
		t.Fatalf("Prepare err = %v, want a volume error not ErrRunNotFound", err)
	}
	if _, err := store.Prepare(ctx, "0af0df00-0000-4000-8000-0000000000c1", w,
		m4Digest("volume/any"), nil); !errors.Is(err, ErrRunNotFound) {
		t.Fatalf("Prepare unknown run err = %v, want ErrRunNotFound", err)
	}
	if _, err := store.Prepare(ctx, runID, w, "not-a-volume-id", nil); err == nil {
		t.Fatal("Prepare with a malformed volume id succeeded, want an error")
	}
	// The repository ownership leg: foreign commit identity is refused.
	vol := runWorkspaceVolume(t, ctx, f.pool, w, "rws-c")
	foreign := "0af0df00-0000-4000-8000-0000000000c2"
	if _, err := store.Prepare(ctx, runID, w, vol,
		[]worker.CheckpointRepoState{{RepositoryID: foreign, BaseCommit: "a1"}}); err == nil {
		t.Fatal("Prepare with a foreign repository succeeded, want an error")
	}
	var affinity string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(worker_affinity::text, '') FROM runs WHERE id = $1::uuid`, runID).
		Scan(&affinity); err != nil {
		t.Fatalf("read run affinity: %v", err)
	}
	if affinity != "" {
		t.Fatalf("affinity = %s after a failed Prepare, want NULL (the transaction rolled back)", affinity)
	}
	var nWorkspaces int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM workspaces WHERE run_id = $1::uuid`, runID).Scan(&nWorkspaces); err != nil {
		t.Fatalf("count workspaces: %v", err)
	}
	if nWorkspaces != 0 {
		t.Fatalf("workspace rows = %d after a failed Prepare, want 0", nWorkspaces)
	}
	// A valid prepare after the refused one still works, and its repo state is
	// echoed on the ref.
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	ref, err := store.Prepare(ctx, runID, w, vol,
		[]worker.CheckpointRepoState{{RepositoryID: repoID, BaseCommit: "a1", HeadCommit: "b2"}})
	if err != nil {
		t.Fatalf("Prepare after refusals: %v", err)
	}
	if len(ref.RepoStates) != 1 || ref.RepoStates[0].RepositoryID != repoID ||
		ref.RepoStates[0].BaseCommit != "a1" || ref.RepoStates[0].HeadCommit != "b2" {
		t.Errorf("ref.RepoStates = %+v, want the boundary state echoed", ref.RepoStates)
	}
}

// runWorkspaceRowState reads the workspace row's state and its repo-row count.
func runWorkspaceRowState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) (string, int, bool) {
	t.Helper()
	var state string
	var n int
	var readyAt bool
	if err := pool.QueryRow(ctx, `
		SELECT w.state,
			(SELECT count(*) FROM workspace_repos wr WHERE wr.workspace_id = w.id),
			w.ready_at IS NOT NULL
		FROM workspaces w WHERE w.id = $1::uuid`, workspaceID).
		Scan(&state, &n, &readyAt); err != nil {
		t.Fatalf("read workspace %s: %v", workspaceID, err)
	}
	return state, n, readyAt
}

// TestRunWorkspaceRepoRowsRecordedOnce is the run-workspace bug's regression
// gate in the seams cmd/communication's newRunWorkspacePreparer drives: the
// first preparation must be able to tell "no rows yet" from the commit states
// Prepare echoes back (which are the caller's own input on the arm that created
// the row), record its repos, and reach 'ready' exactly once; a re-entry adds
// no duplicate rows; a different worker is still refused. Integration layer —
// every assertion counts rows a real Postgres wrote.
func TestRunWorkspaceRepoRowsRecordedOnce(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	workspaces := &WorkspaceStore{Pool: f.pool}

	runID := m4RunsReadSeedRun(t, ctx, f)
	w1 := m4Worker(t, ctx, f.pool, "rwrec-a", 2)
	vol1 := runWorkspaceVolume(t, ctx, f.pool, w1, "rwrec-a")
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	// This test is the one that writes workspace_repos rows, so it also owns
	// deleting them first — registered last, it runs first (LIFO), before the
	// repository cleanup above can be blocked by the FK.
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE run_id = $1)`, runID)
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM workspaces WHERE run_id = $1`, runID)
	})
	states := []worker.CheckpointRepoState{{RepositoryID: repoID, BaseCommit: "a1", HeadCommit: "b2"}}

	// Before any preparation: nothing exists, nothing is written, nothing is
	// ready. This is the answer the preparer must key its write on.
	if exists, rows, ready, err := store.RunWorkspaceRepoState(ctx, runID); err != nil || exists || rows || ready {
		t.Fatalf("RunWorkspaceRepoState before prepare = (%v, %v, %v, %v), want false/false/false/nil", exists, rows, ready, err)
	}

	// Step 4 of § 4: the door closes, the row opens 'preparing'.
	ref, err := store.Prepare(ctx, runID, w1, vol1, states)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// The echo the bug mistook for recorded rows, pinned as behaviour: the ref
	// carries the caller's states...
	if len(ref.RepoStates) != 1 || ref.RepoStates[0].RepositoryID != repoID {
		t.Fatalf("Prepare echoed %+v, want the boundary state", ref.RepoStates)
	}
	// ...while the store says there are NO rows and the workspace is not ready.
	// A preparer that trusted the echo would return here and leave the run
	// workspace 'preparing' with no authorized checkout forever.
	exists, rows, ready, err := store.RunWorkspaceRepoState(ctx, runID)
	if err != nil || !exists || rows || ready {
		t.Fatalf("RunWorkspaceRepoState after Prepare = (%v, %v, %v, %v), want exists/rows=false/ready=false", exists, rows, ready, err)
	}

	// Step 5: the paths and 'ready' land in one transaction.
	if err := workspaces.RecordRepos(ctx, ref.WorkspaceID, []worker.WorkspaceRepo{{
		WorkspaceID: ref.WorkspaceID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, CheckoutPath: "/work/run/" + runID + "/work/repos/backend",
		MirrorPath: "/repos/" + f.projectID + "/backend.git", MirrorVolumeID: m4Digest("mirror/rwrec"),
		AdminDir: "/work/run/" + runID + "/meta/admin", RunRef: runID + "/backend", BaseCommit: "a1",
	}}, true); err != nil {
		t.Fatalf("RecordRepos: %v", err)
	}
	if state, n, readyAt := runWorkspaceRowState(t, ctx, f.pool, ref.WorkspaceID); state != "ready" || n != 1 || !readyAt {
		t.Fatalf("after RecordRepos: state=%q rows=%d ready_at_set=%v, want ready/1/true", state, n, readyAt)
	}
	if _, rows, ready, err := store.RunWorkspaceRepoState(ctx, runID); err != nil || !rows || !ready {
		t.Fatalf("RunWorkspaceRepoState after RecordRepos = (%v, %v, %v), want rows/ready true", rows, ready, err)
	}
	// The resolver now reads commit identity back from those rows.
	resolved, ok, err := store.RunWorkspace(ctx, runID)
	if err != nil || !ok || len(resolved.RepoStates) != 1 || resolved.RepoStates[0].BaseCommit != "a1" {
		t.Fatalf("RunWorkspace = (%+v, %v, %v), want one recorded state", resolved, ok, err)
	}

	// Re-entry: a later attempt of the same run on the same worker checks the
	// door and finds the facts already committed — one row, still ready, no
	// duplicate.
	again, err := store.Prepare(ctx, runID, w1, vol1, states)
	if err != nil {
		t.Fatalf("Prepare (re-entry): %v", err)
	}
	if again.WorkspaceID != ref.WorkspaceID {
		t.Fatalf("re-entry Prepare workspace = %s, want %s", again.WorkspaceID, ref.WorkspaceID)
	}
	if _, rows, ready, err := store.RunWorkspaceRepoState(ctx, runID); err != nil || rows != true || !ready {
		t.Fatalf("re-entry state = (%v, %v, %v), want rows/ready true", rows, ready, err)
	}
	// Idempotent under a concurrent same-worker attempt: replaying the write
	// upserts the same row rather than adding a second one.
	if err := workspaces.RecordRepos(ctx, ref.WorkspaceID, []worker.WorkspaceRepo{{
		WorkspaceID: ref.WorkspaceID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, CheckoutPath: "/work/run/" + runID + "/work/repos/backend",
		MirrorPath: "/repos/" + f.projectID + "/backend.git", MirrorVolumeID: m4Digest("mirror/rwrec"),
		AdminDir: "/work/run/" + runID + "/meta/admin", RunRef: runID + "/backend", BaseCommit: "a1",
	}}, false); err != nil {
		t.Fatalf("RecordRepos (replay): %v", err)
	}
	if state, n, _ := runWorkspaceRowState(t, ctx, f.pool, ref.WorkspaceID); state != "ready" || n != 1 {
		t.Fatalf("after replay: state=%q rows=%d, want ready/1", state, n)
	}
	// The ready move is one-way: a replay that still asks for it is refused
	// rather than silently re-writing history (the preparer turns this refusal
	// into a no-op by reading the facts back).
	if err := workspaces.RecordRepos(ctx, ref.WorkspaceID, nil, true); err == nil {
		t.Fatal("RecordRepos(markReady) on a ready workspace succeeded, want the not-preparing refusal")
	}

	// A different worker is still refused, and the refusal is journalled.
	w2 := m4Worker(t, ctx, f.pool, "rwrec-b", 2)
	vol2 := runWorkspaceVolume(t, ctx, f.pool, w2, "rwrec-b")
	if _, err := store.Prepare(ctx, runID, w2, vol2, nil); !errors.Is(err, ErrRunWorkspaceDifferentWorker) {
		t.Fatalf("Prepare on worker B = %v, want ErrRunWorkspaceDifferentWorker", err)
	}
	if n, reason := runWorkspaceEvents(t, ctx, f.pool, runID); n != 1 || reason != "different_worker" {
		t.Fatalf("recovery_lost rows = %d reason %q, want 1 different_worker", n, reason)
	}
	if state, n, _ := runWorkspaceRowState(t, ctx, f.pool, ref.WorkspaceID); state != "ready" || n != 1 {
		t.Fatalf("after refusal: state=%q rows=%d, want ready/1", state, n)
	}
}

// TestRunWorkspaceRepoStateNoRepos covers the project that holds no repository:
// the tree is prepared, so the workspace must still leave 'preparing' — the
// old len(rows) > 0 gate kept it there forever on a second path.
func TestRunWorkspaceRepoStateNoRepos(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &RunWorkspaces{Pool: f.pool}
	workspaces := &WorkspaceStore{Pool: f.pool}

	runID := m4RunsReadSeedRun(t, ctx, f)
	w := m4Worker(t, ctx, f.pool, "rwrec-empty", 2)
	vol := runWorkspaceVolume(t, ctx, f.pool, w, "rwrec-empty")
	ref, err := store.Prepare(ctx, runID, w, vol, nil)
	if err != nil {
		t.Fatalf("Prepare (no repos): %v", err)
	}
	if _, rows, ready, err := store.RunWorkspaceRepoState(ctx, runID); err != nil || rows || ready {
		t.Fatalf("state before RecordRepos = (%v, %v, %v), want false/false", rows, ready, err)
	}
	if err := workspaces.RecordRepos(ctx, ref.WorkspaceID, nil, true); err != nil {
		t.Fatalf("RecordRepos (no repos, markReady): %v", err)
	}
	if state, n, readyAt := runWorkspaceRowState(t, ctx, f.pool, ref.WorkspaceID); state != "ready" || n != 0 || !readyAt {
		t.Fatalf("repo-less workspace: state=%q rows=%d ready_at_set=%v, want ready/0/true", state, n, readyAt)
	}
}
