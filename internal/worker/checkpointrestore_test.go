package worker

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// fakeRestore records the resets the worker asked for. It is the only way to
// prove ADR-0023 § 6's *ordering* claim — "before launching anything" — because
// the launch it precedes is a stub whose only job is to say whether it ran.
type fakeRestore struct {
	calls   []wsgit.RestoreRequest
	reports map[string]wsgit.RestoreReport
	errFor  map[string]error
}

func (f *fakeRestore) RestoreToBoundary(_ context.Context, req wsgit.RestoreRequest) (wsgit.RestoreReport, error) {
	f.calls = append(f.calls, req)
	if err := f.errFor[req.Checkout]; err != nil {
		return wsgit.RestoreReport{}, err
	}
	if rep, ok := f.reports[req.Checkout]; ok {
		return rep, nil
	}
	return wsgit.RestoreReport{HeadBefore: "b", HeadAfter: req.HeadCommit}, nil
}

// launchProbe is the inner executor: it records that the launch was reached.
type launchProbe struct{ ran bool }

func (p *launchProbe) Execute(_ context.Context, _ AttemptClaim, _ AttemptSink) (AttemptResult, error) {
	p.ran = true
	return AttemptResult{Status: AttemptStatusSucceeded, Outcome: "passed"}, nil
}

func committedState(t *testing.T, id, head string) CheckpointRepoState {
	t.Helper()
	count := int64(0)
	yes := true
	if head == "" {
		count, yes = int64(3), false
	}
	return CheckpointRepoState{RepositoryID: id, BaseCommit: "base", HeadCommit: head,
		ModifiedPathCount: &count, Committed: &yes}
}

func restoreClaim() AttemptClaim {
	return AttemptClaim{AttemptID: "at-1", NodeExecutionID: "ne-1", RunID: "run-1",
		ProjectID: "p-1", WorkerID: "w-1", FencingToken: 1, NodeID: "task",
		NodeInstanceKey: "/task", Kind: NodeKindProcessExec, AttemptNumber: 2}
}

func TestCheckpointRestoreResetsBeforeLaunchAndEvents(t *testing.T) {
	gitFake := &fakeRestore{reports: map[string]wsgit.RestoreReport{"/ws/work/repos/app": {
		HeadBefore: "second", HeadAfter: "aaaa1111", DiscardedPaths: []string{"app.txt", "junk.log"},
	}}}
	inner := &launchProbe{}
	sink := &recordingSink{}
	boundaryCalls := 0
	e := &CheckpointRestorer{
		Inner: inner, Git: gitFake,
		Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
			boundaryCalls++
			return RestoreBoundary{
				Mode: WorkspacePolicyRestore,
				RepoStates: []CheckpointRepoState{
					committedState(t, "repo-app", "aaaa1111"), committedState(t, "repo-lib", "bbbb2222"),
				},
				Checkouts: map[string]string{"repo-app": "/ws/work/repos/app", "repo-lib": "/ws/work/repos/lib"},
				Excluded:  []string{".env"},
			}, true, nil
		},
	}
	res, err := e.Execute(context.Background(), restoreClaim(), sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("result = %+v, want the inner executor's success", res)
	}
	if boundaryCalls != 1 {
		t.Errorf("boundary resolved %d times, want 1", boundaryCalls)
	}
	// Every committed repo was reset, with the boundary commit and the
	// exclusion set handed down, and the launch happened after all of them.
	if len(gitFake.calls) != 2 {
		t.Fatalf("restore calls = %v, want two (one per repo)", gitFake.calls)
	}
	if gitFake.calls[0].HeadCommit != "aaaa1111" || gitFake.calls[1].HeadCommit != "bbbb2222" {
		t.Errorf("boundary commits = %q, %q, want aaaa1111 then bbbb2222 (repository id order)",
			gitFake.calls[0].HeadCommit, gitFake.calls[1].HeadCommit)
	}
	if !slices.Equal(gitFake.calls[0].Excluded, []string{".env"}) {
		t.Errorf("Excluded = %v, want the declared set handed to git", gitFake.calls[0].Excluded)
	}
	if !inner.ran {
		t.Error("inner executor did not run after a completed restore")
	}
	if len(sink.events) != 1 || sink.events[0].Type != events.TypeRunCheckpointRestored {
		t.Fatalf("events = %v, want exactly one run.checkpoint_restored", sink.types())
	}
	if sink.events[0].ActorKind != events.ActorKindWorker {
		t.Errorf("actor kind = %q, want worker", sink.events[0].ActorKind)
	}
	pl, ok := sink.events[0].Payload.(events.RunCheckpointRestoredPayload)
	if !ok {
		t.Fatalf("payload type = %T, want RunCheckpointRestoredPayload", sink.events[0].Payload)
	}
	if pl.FromCommit != "aaaa1111" {
		t.Errorf("from_commit = %q, want the first boundary state's commit (runtime.RetryPlan's rule)", pl.FromCommit)
	}
	if !slices.Equal(pl.DiscardedPaths, []string{"app.txt", "junk.log"}) {
		t.Errorf("discarded_paths = %v, want the measured paths", pl.DiscardedPaths)
	}
	if pl.RunID != "run-1" || pl.ProjectID != "p-1" || pl.NodeInstanceKey != "/task" {
		t.Errorf("correlation = %+v, want it carried from the claim", pl)
	}
}

func TestCheckpointRestoreFirstAttemptOfARestoreNodeIsNotReset(t *testing.T) {
	// ADR-0023 § 6 states the arm as retry.workspacePolicy: it governs what a
	// RETRY does with the tree the interrupted attempt left behind. The first
	// attempt of a restore-policy node — e.g. iteration 2 of an `until` whose
	// iteration 1 just completed — has no interrupted attempt to restore
	// from, and its predecessor's uncommitted edits are exactly what the next
	// iteration inherits. Resetting it destroyed live work (lab live19 C6c:
	// every /implement iteration was reset to the /plan boundary, the loop
	// replayed iteration 1 until it exhausted, and the run failed). Attempt 1
	// must launch with no git call and no event.
	gitFake := &fakeRestore{}
	inner := &launchProbe{}
	sink := &recordingSink{}
	e := &CheckpointRestorer{Inner: inner, Git: gitFake,
		Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
			return RestoreBoundary{
				Mode:       WorkspacePolicyRestore,
				RepoStates: []CheckpointRepoState{committedState(t, "repo-app", "aaaa1111")},
				Checkouts:  map[string]string{"repo-app": "/ws/work/repos/app"},
			}, true, nil
		}}
	claim := restoreClaim()
	claim.AttemptNumber = 1
	res, err := e.Execute(context.Background(), claim, sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded || !inner.ran {
		t.Fatalf("result = %+v, inner.ran = %v, want the first attempt to launch normally", res, inner.ran)
	}
	if len(gitFake.calls) != 0 {
		t.Errorf("restore calls = %v, want none for an attempt that is not a retry", gitFake.calls)
	}
	if len(sink.events) != 0 {
		t.Errorf("events = %v, want no run.checkpoint_restored for a reset that never happened", sink.types())
	}
}

func TestCheckpointRestoreContinueLeavesTheTreeAlone(t *testing.T) {
	gitFake := &fakeRestore{}
	inner := &launchProbe{}
	sink := &recordingSink{}
	e := &CheckpointRestorer{Inner: inner, Git: gitFake,
		Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
			return RestoreBoundary{Mode: WorkspacePolicyContinue}, true, nil
		}}
	if _, err := e.Execute(context.Background(), restoreClaim(), sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(gitFake.calls) != 0 {
		t.Errorf("restore calls = %v, want none under continue_workspace", gitFake.calls)
	}
	if len(sink.events) != 0 {
		t.Errorf("events = %v, want no run.checkpoint_restored beside a continue retry (contract D5)", sink.types())
	}
	if !inner.ran {
		t.Error("continue_workspace must still launch the node")
	}
}

// TestCheckpointRestoreContinueDoesNotInheritTheRestoreRefusal is the same
// rule seen from the worker: the unrecorded-boundary refusal is § 6's licence
// check for the DESTRUCTIVE arm. A continue_workspace attempt whose boundary
// was never captured still launches — it resets nothing, so it needs no
// licence. If the check ever moves above the mode test, every retry of a run
// with a process.exec boundary (which never captures) dies at prepare with
// error_class=infra, and the kill leg of C5b/C6b reads as a mis-classed
// interruption (lab live18).
func TestCheckpointRestoreContinueDoesNotInheritTheRestoreRefusal(t *testing.T) {
	uncaptured := []CheckpointRepoState{{RepositoryID: "repo-app", HeadCommit: "aaaa1111"}}
	for _, mode := range []string{WorkspacePolicyContinue, ""} {
		gitFake := &fakeRestore{}
		inner := &launchProbe{}
		sink := &recordingSink{}
		e := &CheckpointRestorer{Inner: inner, Git: gitFake,
			Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
				return RestoreBoundary{Mode: mode, RepoStates: uncaptured,
					Checkouts: map[string]string{"repo-app": "/ws/work/repos/app"}}, true, nil
			}}
		res, err := e.Execute(context.Background(), restoreClaim(), sink)
		if err != nil {
			t.Fatalf("Execute (mode %q): %v", mode, err)
		}
		if !inner.ran || res.Status == AttemptStatusFailed {
			t.Fatalf("mode %q: result = %+v launched=%v, want the node to launch "+
				"under continue_workspace with an unmeasured boundary", mode, res, inner.ran)
		}
		if len(gitFake.calls) != 0 || len(sink.events) != 0 {
			t.Errorf("mode %q: restores=%v events=%v, want neither touched", mode, gitFake.calls, sink.types())
		}
	}
}

// TestCheckpointRestoreRefusesUncommittedBoundary is § 6's precondition and
// C6d's data-loss guard: an uncommitted (or unmeasured) repo_state stops the
// reset before git is asked for anything, and the node never launches.
func TestCheckpointRestoreRefusesUncommittedBoundary(t *testing.T) {
	for name, state := range map[string]CheckpointRepoState{
		"uncommitted diff at the boundary": committedState(t, "repo-app", ""),
		"never captured at the boundary":   {RepositoryID: "repo-app", HeadCommit: "aaaa1111"},
		"boundary head is not a commit": {RepositoryID: "repo-app", HeadCommit: "main",
			ModifiedPathCount: ptrInt64(0), Committed: ptrBool(true)},
		"no repo states at all": {RepositoryID: "", HeadCommit: "aaaa1111"},
	} {
		t.Run(name, func(t *testing.T) {
			states := []CheckpointRepoState{state}
			if state.RepositoryID == "" {
				states = nil
			}
			gitFake := &fakeRestore{}
			inner := &launchProbe{}
			sink := &recordingSink{}
			e := &CheckpointRestorer{Inner: inner, Git: gitFake,
				Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
					return RestoreBoundary{Mode: WorkspacePolicyRestore, RepoStates: states,
						Checkouts: map[string]string{"repo-app": "/ws/work/repos/app"}}, true, nil
				}}
			res, err := e.Execute(context.Background(), restoreClaim(), sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
				t.Fatalf("result = %+v, want failed/infra", res)
			}
			if !strings.Contains(res.Detail, "checkpoint_unavailable") {
				t.Errorf("detail = %q, want the checkpoint_unavailable code the API uses", res.Detail)
			}
			if len(gitFake.calls) != 0 {
				t.Errorf("restore calls = %v, want nothing touched", gitFake.calls)
			}
			if inner.ran {
				t.Error("a refused restore must not launch the node")
			}
			if len(sink.events) != 0 {
				t.Errorf("events = %v, want no restored event for a refusal", sink.types())
			}
		})
	}
}

// TestCheckpointRestoreWithoutGitManagerRefuses keeps the destructive arm from
// degrading into a silent continue: a node that asked to restore cannot be
// launched against a tree nobody reset, because its prompt would then describe
// work the boundary says is not there.
func TestCheckpointRestoreWithoutGitManagerRefuses(t *testing.T) {
	inner := &launchProbe{}
	e := &CheckpointRestorer{Inner: inner,
		Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
			return RestoreBoundary{Mode: WorkspacePolicyRestore,
				RepoStates: []CheckpointRepoState{committedState(t, "repo-app", "aaaa1111")},
				Checkouts:  map[string]string{"repo-app": "/ws/work/repos/app"}}, true, nil
		}}
	res, err := e.Execute(context.Background(), restoreClaim(), &recordingSink{})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || !strings.Contains(res.Detail, "no git manager") {
		t.Fatalf("result = %+v, want a failed attempt naming the missing seam", res)
	}
	if inner.ran {
		t.Error("nothing may launch when the required restore could not be performed")
	}
}

// TestCheckpointRestoreDiscardsNothingSilentlyOnPartialFailure is the
// disclosure rule: the first repository WAS reset before the second failed, so
// its run.checkpoint_restored lands even though the attempt itself fails.
func TestCheckpointRestoreDiscardsNothingSilentlyOnPartialFailure(t *testing.T) {
	gitFake := &fakeRestore{
		reports: map[string]wsgit.RestoreReport{"/ws/work/repos/app": {
			HeadAfter: "aaaa1111", DiscardedPaths: []string{"app.txt"}}},
		errFor: map[string]error{"/ws/work/repos/lib": errors.New("git reset --hard failed")},
	}
	inner := &launchProbe{}
	sink := &recordingSink{}
	e := &CheckpointRestorer{Inner: inner, Git: gitFake,
		Boundary: func(context.Context, AttemptClaim) (RestoreBoundary, bool, error) {
			return RestoreBoundary{Mode: WorkspacePolicyRestore,
				RepoStates: []CheckpointRepoState{
					committedState(t, "repo-app", "aaaa1111"), committedState(t, "repo-lib", "bbbb2222")},
				Checkouts: map[string]string{"repo-app": "/ws/work/repos/app", "repo-lib": "/ws/work/repos/lib"},
			}, true, nil
		}}
	res, err := e.Execute(context.Background(), restoreClaim(), sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("result = %+v, want failed/infra", res)
	}
	if inner.ran {
		t.Error("the node must not launch after a restore failed halfway")
	}
	if len(sink.events) != 1 {
		t.Fatalf("events = %v, want the completed repo's disclosure", sink.types())
	}
	pl := sink.events[0].Payload.(events.RunCheckpointRestoredPayload)
	if !slices.Equal(pl.DiscardedPaths, []string{"app.txt"}) || pl.FromCommit != "aaaa1111" {
		t.Errorf("disclosure = %+v, want app.txt from aaaa1111", pl)
	}
}

func ptrInt64(v int64) *int64 { return &v }
func ptrBool(v bool) *bool    { return &v }
