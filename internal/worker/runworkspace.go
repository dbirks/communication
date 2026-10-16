package worker

// The worker half of docs/m4-contract.md § 4 step 3: before an attempt body
// runs, the worker that claimed the attempt must ensure the run's workspace
// exists, and from that moment the run is bound to this worker + volume.
//
// It is a decorator rather than a step inside each executor because both
// wired kinds (process.exec and agent.acp) need the same guarantee and
// neither may proceed without it: the boundary a successful attempt records
// (run_checkpoints.workspace_id / volume_id, contract § 4 step 10, D-024's
// same-volume rule) is only truthful if the tree behind it was prepared by
// this worker. An executor that ran on an unprepared workspace would either
// fail on the nil resolver or write a checkpoint naming a directory that does
// not exist.
//
// Dependency rule (AGENTS.md): this file names no store type. The preparation
// arrives as a func supplied by cmd/communication, which is where postgres is
// already imported; the decorator only needs the typed refusal, and
// ErrDifferentRunWorkspaceOwner is the sentinel that wiring wraps the store's
// error in.

import (
	"context"
	"errors"
	"log/slog"
)

// ErrDifferentRunWorkspaceOwner is the refusal of ADR-0023 § 4's one-way door,
// stated in the worker's own vocabulary: the run already belongs to another
// worker's workspace, so this worker fails the attempt rather than cloning a
// second copy. The wiring in cmd/communication maps the store's typed error
// onto this one (the workspace half lives in another package and this package
// must not reach for it); the contract § 4 step 3 `workspace.recovery_lost`
// row with reason 'different_worker' is written by that same store call.
var ErrDifferentRunWorkspaceOwner = errors.New("worker: run workspace belongs to a different worker")

// RunWorkspaceDetailDifferentWorker is the detail a refused attempt carries.
// It names the event and the enum reason because that pair is the whole
// reportable story (contract § 3): the browser renders recovery_lost /
// different_worker, and an operator reading the attempt detail should be able
// to tie it to that row.
const RunWorkspaceDetailDifferentWorker = "workspace.recovery_lost/different_worker: this run is bound to another " +
	"worker's workspace; its prior edits are not recoverable here and a rerun on the owning worker is required"

// RunWorkspacePreparer ensures the run's workspace exists before an attempt
// body runs. It must be idempotent for the worker that already owns the run
// (a retried attempt re-enters it) and must fail with
// ErrDifferentRunWorkspaceOwner when another worker owns it.
type RunWorkspacePreparer func(ctx context.Context, c AttemptClaim) error

// RunWorkspaceExecutor wraps an AttemptExecutor so the run workspace step
// (§ 4 step 3) happens first, exactly once per attempt body, and cannot be
// skipped by the kind that was dispatched.
type RunWorkspaceExecutor struct {
	// Inner is the kind's real executor (ProcExec / AgentTurn).
	Inner AttemptExecutor
	// Prepare is § 4 step 3 for this run; nil means "assume prepared", which
	// the wiring never sets — the executor exists to close that gap, so a nil
	// Prepare is reported rather than silently skipped.
	Prepare RunWorkspacePreparer
	Logger  *slog.Logger
}

var _ AttemptExecutor = (*RunWorkspaceExecutor)(nil)

// Execute prepares the run workspace and then delegates. Any preparation
// failure short-circuits: Inner is never launched on a tree nobody prepared,
// and the honest terminal is failed/infra (an unprepared workspace is a
// wiring or affinity fact, not the command's or agent's failure — ADR-0023
// § 7 has no class for "the run lives somewhere else", and infra is the one
// that does not blame the node).
func (e *RunWorkspaceExecutor) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	if e.Prepare == nil {
		return failedResult(ErrorClassInfra,
			"run workspace preparation is not wired (contract § 4 step 3): the attempt did not launch"), nil
	}
	if err := e.Prepare(ctx, c); err != nil {
		detail := "run workspace preparation failed (contract § 4 step 3): " + err.Error()
		if errors.Is(err, ErrDifferentRunWorkspaceOwner) {
			detail = RunWorkspaceDetailDifferentWorker + ": " + err.Error()
		}
		if e.Logger != nil {
			e.Logger.Warn("run workspace preparation refused the attempt",
				slog.String("attempt_id", c.AttemptID), slog.String("run_id", c.RunID),
				slog.String("error", bounded(err.Error(), 512)))
		}
		return failedResult(ErrorClassInfra, detail), nil
	}
	if e.Inner == nil {
		return failedResult(ErrorClassInfra,
			"run workspace prepared but no inner executor is wired for kind "+c.Kind), nil
	}
	return e.Inner.Execute(ctx, c, sink)
}
