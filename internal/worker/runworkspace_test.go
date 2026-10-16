package worker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
)

// Unit layer for the § 4 step 3 decorator: ordering, the refusal arm, and
// verbatim delegation. The database half (workspace row + affinity door) has
// its own integration tests in internal/store/postgres.

type rwOrder struct {
	calls []string
}

type rwInnerFake struct {
	order  *rwOrder
	result AttemptResult
	err    error
	calls  int
	claim  AttemptClaim
}

func (f *rwInnerFake) Execute(_ context.Context, c AttemptClaim, _ AttemptSink) (AttemptResult, error) {
	f.calls++
	f.claim = c
	f.order.calls = append(f.order.calls, "inner")
	return f.result, f.err
}

func TestRunWorkspaceExecutorPreparesBeforeInner(t *testing.T) {
	order := &rwOrder{}
	inner := &rwInnerFake{order: order, result: AttemptResult{Status: AttemptStatusSucceeded, Outcome: "passed"}}
	prepCalls := 0
	var prepared AttemptClaim
	ex := &RunWorkspaceExecutor{
		Inner: inner,
		Prepare: func(_ context.Context, c AttemptClaim) error {
			prepCalls++
			order.calls = append(order.calls, "prepare")
			prepared = c
			return nil
		},
	}
	res, err := ex.Execute(context.Background(), AttemptClaim{AttemptID: "a1", RunID: "r1", Kind: NodeKindProcessExec}, nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if prepCalls != 1 || inner.calls != 1 {
		t.Fatalf("prepare calls = %d, inner calls = %d, want 1 and 1", prepCalls, inner.calls)
	}
	if strings.Join(order.calls, ",") != "prepare,inner" {
		t.Fatalf("call order = %v, want prepare before inner", order.calls)
	}
	if prepared.RunID != "r1" || prepared.AttemptID != "a1" {
		t.Fatalf("Prepare saw %+v, want the claim it was handed", prepared)
	}
	if res.Status != AttemptStatusSucceeded || res.Outcome != "passed" {
		t.Fatalf("result = %+v, want Inner's result returned verbatim", res)
	}
}

func TestRunWorkspaceExecutorDelegatesInnerResultAndError(t *testing.T) {
	order := &rwOrder{}
	sentinel := errors.New("inner blew up")
	inner := &rwInnerFake{order: order, result: AttemptResult{Status: AttemptStatusFailed, ErrorClass: ErrorClassTimeout}, err: sentinel}
	ex := &RunWorkspaceExecutor{Inner: inner, Prepare: func(context.Context, AttemptClaim) error { return nil }}
	res, err := ex.Execute(context.Background(), AttemptClaim{Kind: NodeKindAgentACP}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("Execute error = %v, want Inner's error propagated", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassTimeout {
		t.Fatalf("result = %+v, want Inner's result", res)
	}
}

func TestRunWorkspaceExecutorDifferentWorkerRefusal(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"sentinel", ErrDifferentRunWorkspaceOwner},
		{"wrapped", fmt.Errorf("store says no: %w", ErrDifferentRunWorkspaceOwner)},
		{"folded", errors.Join(errors.New("pinned elsewhere"), ErrDifferentRunWorkspaceOwner)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order := &rwOrder{}
			inner := &rwInnerFake{order: order, result: AttemptResult{Status: AttemptStatusSucceeded}}
			ex := &RunWorkspaceExecutor{
				Inner:   inner,
				Prepare: func(context.Context, AttemptClaim) error { return tc.err },
			}
			res, err := ex.Execute(context.Background(), AttemptClaim{AttemptID: "a9", RunID: "r9", Kind: NodeKindProcessExec}, nil)
			if err != nil {
				t.Fatalf("Execute: %v — a refusal is an honest terminal, not a loop error", err)
			}
			if inner.calls != 0 {
				t.Fatalf("inner calls = %d after a refusal, want 0 (call order %v)", inner.calls, order.calls)
			}
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassWorkspaceLost {
				t.Fatalf("result = %+v, want failed/workspace_lost (ADR-0023 § 7: a lost workspace is never infra, because infra is retryable)", res)
			}
			if !strings.Contains(res.Detail, "workspace.recovery_lost/different_worker") {
				t.Fatalf("detail = %q, want it to name workspace.recovery_lost/different_worker", res.Detail)
			}
			if len(res.Detail) > 512 {
				t.Fatalf("detail length = %d, want <= 512 (attempts.detail bound)", len(res.Detail))
			}
		})
	}
}

func TestRunWorkspaceExecutorOtherPrepareFailuresStillShortCircuit(t *testing.T) {
	order := &rwOrder{}
	inner := &rwInnerFake{order: order}
	ex := &RunWorkspaceExecutor{
		Inner:   inner,
		Prepare: func(context.Context, AttemptClaim) error { return errors.New("worktree add exited 128") },
	}
	res, err := ex.Execute(context.Background(), AttemptClaim{Kind: NodeKindProcessExec}, nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if inner.calls != 0 {
		t.Fatalf("inner calls = %d, want 0 — a command never launches on a tree that failed to prepare", inner.calls)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("result = %+v, want failed/infra", res)
	}
	if !strings.Contains(res.Detail, "worktree add exited 128") {
		t.Fatalf("detail = %q, want the prepare error named", res.Detail)
	}
	if strings.Contains(res.Detail, "recovery_lost") {
		t.Fatalf("detail = %q, must not claim a recovery_lost arm that was not journalled", res.Detail)
	}
}

func TestRunWorkspaceExecutorUnwiredPreparationIsReported(t *testing.T) {
	order := &rwOrder{}
	inner := &rwInnerFake{order: order, result: AttemptResult{Status: AttemptStatusSucceeded}}
	ex := &RunWorkspaceExecutor{Inner: inner}
	res, err := ex.Execute(context.Background(), AttemptClaim{Kind: NodeKindProcessExec}, nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if inner.calls != 0 {
		t.Fatalf("inner calls = %d with no Prepare wired, want 0", inner.calls)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
		!strings.Contains(res.Detail, "§ 4 step 3") {
		t.Fatalf("result = %+v, want failed/infra naming the missing step", res)
	}
}

func TestRunWorkspaceExecutorMissingInnerIsReported(t *testing.T) {
	prepped := false
	ex := &RunWorkspaceExecutor{Prepare: func(context.Context, AttemptClaim) error { prepped = true; return nil }}
	res, err := ex.Execute(context.Background(), AttemptClaim{Kind: "model.chat"}, nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !prepped {
		t.Fatal("prepare skipped")
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
		!strings.Contains(res.Detail, "model.chat") {
		t.Fatalf("result = %+v, want failed/infra naming the kind", res)
	}
}

// TestRunWorkspaceExecutorVolumeChangedRefusal is contract § 7.1 C6e's arm that
// the lab kept missing: the run's OWN worker meets a volume it no longer
// measures, the store refuses with the typed loss (reason volume_changed), and
// the attempt's terminal must be workspace_lost so the advancer refuses to arm
// another attempt (ADR-0023 § 7 keeps workspace_lost out of every
// retriableErrors list) instead of burning the budget on "infra".
func TestRunWorkspaceExecutorVolumeChangedRefusal(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		reason string
	}{
		{"typed", &RunWorkspaceLost{Reason: "volume_changed", Detail: "run r lives on volume A, worker W is now on B"}, "volume_changed"},
		{"wrapped", fmt.Errorf("prepare step 3: %w", &RunWorkspaceLost{Reason: "volume_changed", Detail: "volume moved"}), "volume_changed"},
		{"joined", errors.Join(errors.New("affinity disagrees"), &RunWorkspaceLost{Reason: "path_missing", Detail: "tree gone"}), "path_missing"},
		{"bare sentinel", fmt.Errorf("somewhere: %w", ErrRunWorkspaceLost), "volume_changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order := &rwOrder{}
			inner := &rwInnerFake{order: order, result: AttemptResult{Status: AttemptStatusSucceeded}}
			ex := &RunWorkspaceExecutor{Inner: inner, Prepare: func(context.Context, AttemptClaim) error { return tc.err }}
			res, err := ex.Execute(context.Background(), AttemptClaim{AttemptID: "a3", RunID: "r3", Kind: NodeKindProcessExec}, nil)
			if err != nil {
				t.Fatalf("Execute: %v — the loss is an honest terminal, not a loop error", err)
			}
			if inner.calls != 0 {
				t.Fatalf("inner calls = %d, want 0 — nothing launches on a tree this worker does not have", inner.calls)
			}
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassWorkspaceLost {
				t.Fatalf("result = %+v, want failed/workspace_lost", res)
			}
			want := "workspace.recovery_lost/" + tc.reason
			if !strings.Contains(res.Detail, want) {
				t.Fatalf("detail = %q, want it to name %s", res.Detail, want)
			}
			if !strings.Contains(res.Detail, "rerun required") {
				t.Fatalf("detail = %q, want the honest 'prior edits lost, rerun required' wording (10 J7)", res.Detail)
			}
			if len(res.Detail) > 512 {
				t.Fatalf("detail length = %d, want <= 512 (attempts.detail bound)", len(res.Detail))
			}
		})
	}
}

// TestRunWorkspaceLostReasonIsClosedEnum pins the mapping against the reason
// enum the event schema declares (api/openapi.yaml workspace.recovery_lost.reason:
// volume_changed | path_missing | different_worker). A reason outside it — or a
// plain infra failure — is not a lost workspace and must not be classified as
// one: the loss must be *detected*, never assumed.
func TestRunWorkspaceLostReasonIsClosedEnum(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		reason string
		lost   bool
	}{
		{"nil", nil, "", false},
		{"infra-ish", errors.New("measure storage roots: no such device"), "", false},
		{"different owner sentinel", ErrDifferentRunWorkspaceOwner, "different_worker", true},
		{"loss sentinel", ErrRunWorkspaceLost, "volume_changed", true},
		{"typed reason wins over the owner sentinel",
			fmt.Errorf("%w: %w", ErrDifferentRunWorkspaceOwner, &RunWorkspaceLost{Reason: "path_missing", Detail: "x"}),
			"path_missing", true},
		{"typed but unreportable reason still lost",
			&RunWorkspaceLost{Reason: "cross_host_rehydrated", Detail: "not in the enum"}, "volume_changed", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reason, lost := RunWorkspaceLostReason(tc.err)
			if lost != tc.lost || reason != tc.reason {
				t.Fatalf("RunWorkspaceLostReason(%v) = (%q, %v), want (%q, %v)", tc.err, reason, lost, tc.reason, tc.lost)
			}
			if lost && !events.ValidRecoveryLostReason(reason) {
				t.Fatalf("reason %q is not in the workspace.recovery_lost enum", reason)
			}
		})
	}
}
