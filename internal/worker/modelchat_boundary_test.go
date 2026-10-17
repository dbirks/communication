package worker

// The model.chat half of ADR-0023 § 6's boundary rule: a successful node
// boundary writes its checkpoint row in the terminal transaction, and the
// store refuses a completion that names no volume (D-024 is same-volume
// only) — lab pass 35's model.chat node sat until the reconciler spoke
// interrupted/lease_expired for exactly this refusal. The capture here is
// procexec_capture.go's function (captureRepos) over the SAME rows: a
// model.chat node does not touch the tree, so the boundary is the
// workspace's CURRENT state, read back and recorded — never invented.

import (
	"context"
	"strings"
	"testing"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// mcCheckoutPath is the one checkout the fixture's run workspace holds.
const mcCheckoutPath = "/ws/run/mc/work/repos/app"

// mcBoundary is the § 4 step 3 seam with the write half: a BOUND run
// workspace whose RepoStates are re-derived from what the capture records
// (capResolver's rule, procexec_capture_test.go).
func mcBoundary() *capResolver {
	return &capResolver{ref: RunWorkspaceRef{
		WorkspaceID: "ws-mc", VolumeID: "vol-mc",
		Repos: []BoundaryRepo{{
			RowID: "row-mc", RepositoryID: "repo-app",
			CheckoutPath: mcCheckoutPath, RunRef: "run-mc/app",
			BaseCommit: "aaaa1111",
		}},
	}}
}

// mcBoundaryGit is the capture's read seam: the checkout moved the run ref
// to bbbb2222 with a clean tree — the committed, captured boundary.
func mcBoundaryGit() *capGitStub {
	return &capGitStub{
		heads:     map[string]string{mcCheckoutPath: "bbbb2222"},
		summaries: map[string]wsgit.Summary{mcCheckoutPath: {}},
	}
}

// TestModelChatCompletionCapturesTheWorkspaceBoundary pins the happy path's
// boundary: the completion carries the checkpoint its terminal transaction
// writes, and the capture recorded the ref the rows now hold.
func TestModelChatCompletionCapturesTheWorkspaceBoundary(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve"}`)})
	res, err := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s class=%s detail=%s, want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	ck := res.Checkpoint
	if ck.WorkspaceID != "ws-mc" || ck.VolumeID != "vol-mc" {
		t.Fatalf("checkpoint = %#v, want the run workspace row and its volume", ck)
	}
	if ck.WorkerID != "w1" || ck.OutputsDigest != res.OutputsDigest {
		t.Fatalf("checkpoint identity = %#v, want the claim's worker and the outputs digest", ck)
	}
	if !strings.HasPrefix(ck.InputsDigest, "sha256:") || len(ck.InputsDigest) != len("sha256:")+64 {
		t.Fatalf("inputs digest = %q, want sha256:<64 hex> over the plan's own words", ck.InputsDigest)
	}
	if len(ck.RepoStates) != 1 {
		t.Fatalf("repo states = %#v, want the one workspace repository", ck.RepoStates)
	}
	st := ck.RepoStates[0]
	if st.HeadCommit != "bbbb2222" || st.BaseCommit != "aaaa1111" || st.Committed == nil || !*st.Committed {
		t.Fatalf("state = %#v, want the CAPTURED ref (head bbbb2222, committed), not the row's stale record", st)
	}
}

// TestModelChatCompletionWithoutResolverFailsHonest: an executor wired with
// no resolver cannot name a volume, and the store would refuse the write —
// so the worker says so itself, the same infra word process.exec and
// agent.acp speak for an unbound boundary.
func TestModelChatCompletionWithoutResolverFailsHonest(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve"}`)})
	m := mcExecutor(srv.srv.URL)
	m.Checkpoints = nil
	res, err := m.Execute(context.Background(), mcClaim(mcConfig()), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status = %s/%s, want failed/infra (the store refuses a volume-less boundary)", res.Status, res.ErrorClass)
	}
	if !strings.Contains(res.Detail, "no run workspace boundary") {
		t.Fatalf("detail %q must name the missing boundary, not a generic error", res.Detail)
	}
	if res.Checkpoint.VolumeID != "" {
		t.Fatalf("checkpoint = %#v, want no invented volume", res.Checkpoint)
	}
}

// TestModelChatCompletionWorkspacelessRunFailsHonest: the resolver answers
// "this run owns no workspace" — the boundary transaction would refuse the
// same way, so the honest terminal is the executor's failed/infra, not a
// completion left for the reconciler to interrupt.
type mcNoWorkspace struct{}

func (mcNoWorkspace) RunWorkspace(context.Context, string) (RunWorkspaceRef, bool, error) {
	return RunWorkspaceRef{}, false, nil
}

func TestModelChatCompletionWorkspacelessRunFailsHonest(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve"}`)})
	m := mcExecutor(srv.srv.URL)
	m.Checkpoints = mcNoWorkspace{}
	res, err := m.Execute(context.Background(), mcClaim(mcConfig()), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status = %s/%s, want failed/infra", res.Status, res.ErrorClass)
	}
	if !strings.Contains(res.Detail, "no run workspace boundary") {
		t.Fatalf("detail %q must name the missing boundary", res.Detail)
	}
}

// TestModelChatCaptureRefusalKeepsTheCompletion: the store refuses the
// boundary's row write (fenced write refused) — best-effort by the
// procexec_capture.go rule, the capture never fails the attempt. The
// completion still succeeds and still names the volume; the boundary simply
// stays un-captured, which restore_checkpoint already reports honestly.
func TestModelChatCaptureRefusalKeepsTheCompletion(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve"}`)})
	m := mcExecutor(srv.srv.URL)
	m.Checkpoints = &capResolver{noWrite: true, ref: RunWorkspaceRef{
		WorkspaceID: "ws-mc", VolumeID: "vol-mc",
		Repos: []BoundaryRepo{{
			RowID: "row-mc", RepositoryID: "repo-app",
			CheckoutPath: mcCheckoutPath, RunRef: "run-mc/app",
			BaseCommit: "bbbb2222", RecordedHead: "bbbb2222",
		}},
	}}
	res, err := m.Execute(context.Background(), mcClaim(mcConfig()), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("a capture refusal is a bookkeeping read, not an attempt failure: %s/%s %s",
			res.Status, res.ErrorClass, res.Detail)
	}
	if res.Checkpoint.VolumeID != "vol-mc" {
		t.Fatalf("checkpoint = %#v, want the bound volume regardless of the refusal", res.Checkpoint)
	}
	// The un-captured record says what the rows truthfully hold: the ref at
	// the base commit, committed (no move recorded by this attempt).
	if len(res.Checkpoint.RepoStates) != 1 || res.Checkpoint.RepoStates[0].HeadCommit != "bbbb2222" {
		t.Fatalf("states = %#v, want the rows' truthful record, not an invented head", res.Checkpoint.RepoStates)
	}
}
