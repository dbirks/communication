package postgres

// The store-side proof of the model.chat boundary fix (lab pass 35): a
// model.chat attempt in a WORKSPACE run must complete with its run_checkpoints
// row. Before the fix the worker's terminal write was refused at
// CompleteAttempt's volume CHECK ("a boundary that names no volume promises a
// a restore nobody can perform"), the attempt sat until its lease
// expired, and
// the reconciler closed it interrupted/lease_expired — EVERY successful
// model.chat node lost. Integration layer: every assertion reads rows a real
// Postgres wrote, and the capture reads a real git checkout.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/worker"
)

// mcBoundaryPlan is one model.chat node declaring no outputs — the boundary
// then accepts the executor's envelope without a schema gate (C10's
// "skips plans that declare nothing" arm), so the test isolates the
// checkpoint half of the terminal transaction.
const mcBoundaryPlan = `{
	"version": "v1alpha1-plan-1",
	"nodes": [{
		"id": "chat", "scope": "/", "kind": "model.chat"
	}]
}`

// mcTwoCommitRepo initialises a real git repository with two commits and
// returns their hashes — the capture's boundary must read back the second
// one as the committed head.
func mcTwoCommitRepo(t *testing.T, dir string) (base, head string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is unavailable: %v", err)
	}
	git := func(name string, args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-c", "user.name=lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", name, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if err := exec.Command("git", "init", "-q", dir).Run(); err != nil {
		t.Fatalf("git init: %v", err)
	}
	write := func(file, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", file, err)
		}
	}
	write("a.txt", "one\n")
	git("add-1", "add", "-A")
	git("commit-1", "commit", "-q", "-m", "base")
	base = git("rev-parse-base", "rev-parse", "HEAD")
	write("b.txt", "two\n")
	git("add-2", "add", "-A")
	git("commit-2", "commit", "-q", "-m", "second")
	head = git("rev-parse-head", "rev-parse", "HEAD")
	if base == "" || head == "" || base == head {
		t.Fatalf("commits = %s %s, want two distinct hashes", base, head)
	}
	return base, head
}

// TestModelChatWorkspaceRunCompletesWithCheckpointRow drives the REAL
// executor against the REAL store: the completion is answered by a fake
// endpoint, the boundary capture reads a real checkout, and the terminal
// write must land — attempt succeeded, one run_checkpoints row, the
// workspace's volume, and the captured ref in repo_states.
func TestModelChatWorkspaceRunCompletesWithCheckpointRow(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)

	// The run, the model.chat node and its claimed, begun attempt.
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID, mcBoundaryPlan); err != nil {
		t.Fatalf("pin the model.chat plan: %v", err)
	}
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: "chat", Kind: "model.chat",
		NodeInstanceKey: "/chat", ScopeKey: "/",
		ExecutionLocation: "worker", AttemptLimit: 2,
	})
	if err != nil {
		t.Fatalf("seed the chat node: %v", err)
	}
	if _, err := f.runs.SetNodeStatus(ctx, node.ID, NodeStatusInput{Status: "ready"}); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: node.ID, AttemptNumber: 1}); err != nil {
		t.Fatalf("queue attempt 1: %v", err)
	}
	wid := m4Worker(t, ctx, f.pool, "mchat", 1)
	claims, err := store.ClaimAttempts(ctx, wid, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v)", claims, err)
	}
	claim := claims[0]
	if err := store.BeginAttempt(ctx, claim); err != nil {
		t.Fatalf("begin attempt: %v", err)
	}
	// Claim hydration's shape for a chat node: model + messages resolved.
	claim.Config = map[string]any{
		"model":    "gpt-test",
		"messages": []any{map[string]any{"role": "user", "content": "review the diff"}},
	}

	// The run's workspace, its repository row and the REAL checkout the
	// capture will read.
	wsID := m4Workspace(t, ctx, f, claim.RunID)
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	// OUTSIDE the temp tree: wsgit's read manager refuses /tmp roots by the
	// C-TMP1 probe rule (workspaces must not live where the sandbox grants
	// write access by default), and this is the same root the capture reads.
	home, herr := os.UserHomeDir()
	if herr != nil || home == "" {
		t.Fatalf("scratch workspace root: no user home: %v", herr)
	}
	root, err := os.MkdirTemp(home, "modelchat-boundary-")
	if err != nil {
		t.Fatalf("scratch workspace root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	checkout := filepath.Join(root, "backend")
	base, head := mcTwoCommitRepo(t, checkout)
	// Registered last, it runs first (LIFO): workspace_repos has an FK to
	// workspaces without a cascade, and the fixture's project cleanup cannot
	// outrun it.
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM workspace_repos WHERE workspace_id = $1`, wsID)
	})
	if err := (&WorkspaceStore{Pool: f.pool}).RecordRepos(ctx, wsID, []worker.WorkspaceRepo{{
		WorkspaceID: wsID, OrganizationID: f.orgID, ProjectID: f.projectID,
		RepositoryID: repoID, CheckoutPath: checkout,
		MirrorPath: "/repos/" + f.projectID + "/backend.git", MirrorVolumeID: m4Digest("mirror/mchat"),
		AdminDir: "/workspaces/run/" + runID + "/meta/admin", RunRef: runID + "/backend",
		BaseCommit: base,
	}}, false); err != nil {
		t.Fatalf("RecordRepos: %v", err)
	}
	var volumeID string
	if err := f.pool.QueryRow(ctx, `SELECT volume_id FROM workspaces WHERE id = $1`, wsID).Scan(&volumeID); err != nil {
		t.Fatalf("read the workspace's volume: %v", err)
	}

	// The endpoint the egress honesty test names: a fake, on a real server.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("model.chat posted to %s, want /v1/chat/completions", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"looks good"},"finish_reason":"stop"}]}`))
	}))
	defer srv.Close()

	m := &worker.ModelChat{
		BaseURL:       srv.URL + "/v1",
		APIKey:        "sk-integration-fixture-not-a-secret",
		Models:        []string{"gpt-test"},
		Timeout:       5 * time.Second,
		Checkpoints:   &RunWorkspaces{Pool: f.pool},
		WorkspaceRoot: root,
	}
	res, err := m.Execute(ctx, claim, nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != "succeeded" {
		t.Fatalf("executor = %s/%s %s, want a completed chat with a boundary",
			res.Status, res.ErrorClass, res.Detail)
	}
	if res.Checkpoint.WorkspaceID != wsID || res.Checkpoint.VolumeID != volumeID {
		t.Fatalf("checkpoint = (ws %s, vol %s), want the run's workspace row and its volume",
			res.Checkpoint.WorkspaceID, res.Checkpoint.VolumeID)
	}

	// The boundary transaction: the write the lab's pass 35 refused.
	if err := store.CompleteAttempt(ctx, claim, res.Outputs, res.OutputsDigest,
		res.ArtifactRefs, "passed", res.Checkpoint); err != nil {
		t.Fatalf("the terminal write must land for a captured workspace boundary: %v", err)
	}

	// Read the ledger back: the attempt, the node and the checkpoint row.
	var attStatus, attDigest, ckVolume, repoStates string
	if err := f.pool.QueryRow(ctx,
		`SELECT status, outputs_digest FROM attempts WHERE id = $1::uuid`, claim.AttemptID).Scan(&attStatus, &attDigest); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	var ckCount int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*)::int, COALESCE(max(volume_id), ''), COALESCE(max(repo_states::text), '')
		 FROM run_checkpoints WHERE attempt_id = $1::uuid`,
		claim.AttemptID).Scan(&ckCount, &ckVolume, &repoStates); err != nil {
		t.Fatalf("read checkpoint row: %v", err)
	}
	if attStatus != "succeeded" || attDigest == "" {
		t.Fatalf("attempt = %s digest %q, want succeeded with its outputs digest", attStatus, attDigest)
	}
	if ckCount != 1 || ckVolume != volumeID {
		t.Fatalf("checkpoint rows = %d (volume %q), want exactly one on the run's volume %q",
			ckCount, ckVolume, volumeID)
	}
	// repo_states must carry the CAPTURED head (the second commit) with
	// committed:true — the base_commit column names the base, so the check
	// is on the head and the committed flag, not the base's absence.
	if !strings.Contains(repoStates, `"head_commit": "`+head+`"`) || !strings.Contains(repoStates, `"committed": true`) {
		t.Fatalf("repo_states %s, want the captured head %s committed (base %s)", repoStates, head, base)
	}
}
