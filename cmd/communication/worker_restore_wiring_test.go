package main

// The wiring proof for ADR-0023 § 6's restore_checkpoint arm. The decorator
// itself is tested in internal/worker; what is NOT tested there is that this
// binary actually puts it between § 4 step 3's preparer and the kind's
// launcher, for EVERY wired kind, in that order. A decorator that exists but
// is never installed is the exact shape of e2de8fa's gap, so these tests drive
// the same newAttemptExecutors the worker builds at boot — with the store and
// git replaced by recorders, because what is under test is the chain, not a
// disk.
//
// The continue_workspace leg matters as much as the restore leg: it is M4's
// default, every run today uses it, and § 6 promises the tree is "left exactly
// as the interrupted attempt left it". A wiring that touched git on the
// default path would be a data-loss bug shipped inside a feature flag nobody
// set.

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// chainProbe is one kind's executor: it records that the launch was reached
// and where in the sequence it happened.
type chainProbe struct {
	name  string
	order *[]string
}

func (p *chainProbe) Execute(context.Context, worker.AttemptClaim, worker.AttemptSink) (worker.AttemptResult, error) {
	*p.order = append(*p.order, "launch:"+p.name)
	return worker.AttemptResult{Status: worker.AttemptStatusSucceeded, Outcome: "passed"}, nil
}

// chainGit records the resets the wiring asked for.
type chainGit struct {
	order *[]string
	calls []wsgit.RestoreRequest
}

func (g *chainGit) RestoreToBoundary(_ context.Context, req wsgit.RestoreRequest) (wsgit.RestoreReport, error) {
	*g.order = append(*g.order, "restore:"+req.Checkout)
	g.calls = append(g.calls, req)
	return wsgit.RestoreReport{HeadBefore: "bbb2222", HeadAfter: req.HeadCommit,
		DiscardedPaths: []string{"scratch.txt"}}, nil
}

// chainSink captures the journalled events.
type chainSink struct {
	events []worker.AttemptEvent
}

func (s *chainSink) AppendEvent(_ context.Context, ev worker.AttemptEvent) error {
	s.events = append(s.events, ev)
	return nil
}

func (s *chainSink) Stopping() <-chan struct{} { return nil }

// chainFixture builds the production executor map over fakes, with the
// boundary's mode chosen per test.
func chainFixture(mode string) (*[]string, *chainGit, *chainSink, worker.AttemptExecutors, *[]string) {
	order := &[]string{}
	git := &chainGit{order: order}
	sink := &chainSink{}
	prepared := &[]string{}
	chain := attemptChain{
		prepare: func(context.Context, worker.AttemptClaim) error {
			*order = append(*order, "prepare")
			*prepared = append(*prepared, "prepare")
			return nil
		},
		boundary: func(context.Context, worker.AttemptClaim) (worker.RestoreBoundary, bool, error) {
			count, committed := worker.RepoStateCapture(0, true)
			return worker.RestoreBoundary{
				Mode: mode,
				RepoStates: []worker.CheckpointRepoState{
					{RepositoryID: "repo-app", BaseCommit: "aaa1111", HeadCommit: "ccc3333",
						ModifiedPathCount: count, Committed: committed},
				},
				Checkouts: map[string]string{"repo-app": "/ws/run/work/repos/app"},
				Excluded:  []string{".env"},
			}, true, nil
		},
		git: git,
	}
	probes := map[string]*chainProbe{}
	for _, kind := range []string{worker.NodeKindProcessExec, worker.NodeKindAgentACP,
		worker.NodeKindArtifactPublish, worker.NodeKindModelChat} {
		probes[kind] = &chainProbe{name: kind, order: order}
	}
	execs := newAttemptExecutors(chain,
		probes[worker.NodeKindProcessExec], probes[worker.NodeKindAgentACP],
		probes[worker.NodeKindArtifactPublish], probes[worker.NodeKindModelChat])
	return order, git, sink, execs, prepared
}

func chainClaim(kind string) worker.AttemptClaim {
	return worker.AttemptClaim{AttemptID: "at-1", NodeExecutionID: "ne-2", RunID: "run-1",
		ProjectID: "p-1", OrganizationID: "o-1", WorkerID: "w-1", FencingToken: 4,
		NodeID: "task", NodeInstanceKey: "/task", Kind: kind, AttemptNumber: 2,
		Config: map[string]any{}}
}

// TestRestoreClaimRunsThroughTheRestorerForEveryWiredKind: the reset happens
// after § 4 step 3's prepare and before the kind launches, on every kind the
// worker routes.
func TestRestoreClaimRunsThroughTheRestorerForEveryWiredKind(t *testing.T) {
	for _, kind := range []string{worker.NodeKindProcessExec, worker.NodeKindAgentACP,
		worker.NodeKindArtifactPublish, worker.NodeKindModelChat} {
		t.Run(kind, func(t *testing.T) {
			order, git, sink, execs, prepared := chainFixture(worker.WorkspacePolicyRestore)
			res, err := execs[kind].Execute(context.Background(), chainClaim(kind), sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != worker.AttemptStatusSucceeded {
				t.Fatalf("result = %+v, want the inner kind's success", res)
			}
			want := []string{"prepare", "restore:/ws/run/work/repos/app", "launch:" + kind}
			if !slices.Equal(*order, want) {
				t.Errorf("order = %v, want %v — the reset must land between preparation and launch", *order, want)
			}
			if len(*prepared) != 1 {
				t.Errorf("prepare calls = %v, want exactly one", *prepared)
			}
			if len(git.calls) != 1 || git.calls[0].HeadCommit != "ccc3333" ||
				!slices.Equal(git.calls[0].Excluded, []string{".env"}) {
				t.Errorf("restore calls = %+v, want the boundary commit and the declared exclusions", git.calls)
			}
			if len(sink.events) != 1 || sink.events[0].Type != events.TypeRunCheckpointRestored {
				t.Fatalf("events = %+v, want exactly one run.checkpoint_restored", sink.events)
			}
			raw, err := json.Marshal(sink.events[0].Payload)
			if err != nil {
				t.Fatalf("marshal payload: %v", err)
			}
			for _, want := range []string{"run-1", "/task", "ccc3333", "scratch.txt"} {
				if !strings.Contains(string(raw), want) {
					t.Errorf("event payload %s lacks %q", raw, want)
				}
			}
		})
	}
}

// TestContinueClaimNeverTouchesTheRestorer is the byte-for-byte leg: under the
// M4 default the tree is not read, not reset, and nothing is journalled — the
// kind simply launches, exactly as it did before § 6's arm existed.
func TestContinueClaimNeverTouchesTheRestorer(t *testing.T) {
	for _, kind := range []string{worker.NodeKindProcessExec, worker.NodeKindAgentACP,
		worker.NodeKindArtifactPublish, worker.NodeKindModelChat} {
		t.Run(kind, func(t *testing.T) {
			order, git, sink, execs, prepared := chainFixture(worker.WorkspacePolicyContinue)
			res, err := execs[kind].Execute(context.Background(), chainClaim(kind), sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != worker.AttemptStatusSucceeded || res.Detail != "" {
				t.Fatalf("result = %+v, want the inner kind's unchanged success", res)
			}
			want := []string{"prepare", "launch:" + kind}
			if !slices.Equal(*order, want) {
				t.Errorf("order = %v, want %v — continue_workspace must not consult git", *order, want)
			}
			if len(git.calls) != 0 || len(sink.events) != 0 || len(*prepared) != 1 {
				t.Errorf("git=%v events=%v prepared=%v, want no reset and no event beside a continue retry",
					git.calls, sink.events, *prepared)
			}
		})
	}
}

// TestAttemptExecutorsLeaveUnwiredKindUnregistered keeps newAttemptExecutors
// honest about the shape it is handed: model.chat with no endpoint is nil, and
// a nil seam must stay unregistered so the loop's honest refusal (not a
// restored-then-launched nothing) remains the answer.
func TestAttemptExecutorsLeaveUnwiredKindUnregistered(t *testing.T) {
	order := &[]string{}
	chain := attemptChain{
		prepare: func(context.Context, worker.AttemptClaim) error { return nil },
		boundary: func(context.Context, worker.AttemptClaim) (worker.RestoreBoundary, bool, error) {
			return worker.RestoreBoundary{}, false, nil
		},
		git: &chainGit{order: order},
	}
	inner := &chainProbe{name: "exec", order: order}
	execs := newAttemptExecutors(chain, inner, inner, inner, nil)
	if _, ok := execs[worker.NodeKindModelChat]; ok {
		t.Error("model.chat registered with no endpoint configured")
	}
	for _, kind := range []string{worker.NodeKindProcessExec, worker.NodeKindAgentACP, worker.NodeKindArtifactPublish} {
		if execs[kind] == nil {
			t.Errorf("kind %s is unwired", kind)
		}
	}
	// A nil preparer is reported, never skipped: RunWorkspaceExecutor exists to
	// close that gap, and the chain must not paper over it.
	res, err := (&attemptChain{boundary: chain.boundary, git: chain.git}).wrap(inner).
		Execute(context.Background(), chainClaim(worker.NodeKindProcessExec), &chainSink{})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != worker.AttemptStatusFailed || !strings.Contains(res.Detail, "not wired") {
		t.Errorf("result = %+v, want the honest unwired-preparer failure", res)
	}
}
