package worker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
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
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
				t.Fatalf("result = %+v, want failed/infra", res)
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
