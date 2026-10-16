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

	"github.com/dbirks/communication/internal/events"
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

// ErrRunWorkspaceLost is the closed statement of ADR-0023 § 7's `workspace_lost`
// class in the worker's own vocabulary: this attempt's run has a workspace that
// exists (or existed) on a volume this worker cannot serve, so the prior edits
// are gone and NOTHING here may be described as a resume (contract § 7.1 C6e,
// 12 case 20's second arm). It is deliberately distinct from
// ErrDifferentRunWorkspaceOwner: "another worker owns it" and "my own volume
// changed identity under it" are different reasons of the same honest event,
// and both are lost, not infra.
var ErrRunWorkspaceLost = errors.New("worker: the run's workspace is not recoverable here")

// RunWorkspaceLost is the typed refusal that carries the journal's reason.
//
// `workspace.recovery_lost.reason` is a closed enum (api/openapi.yaml:
// volume_changed | path_missing | different_worker) and it is the only field in
// that payload able to say WHY the tree is unreachable. A refusal that arrived
// as an untyped error would still be a lost workspace — the class is decided by
// the sentinel, never by whether the reason came through — but the detail should
// name the enum value the journal row carries rather than paraphrase it.
type RunWorkspaceLost struct {
	// Reason is the events.Recovery* enum value journalled with the refusal.
	Reason string
	// Detail is the store's own words (ids, volumes) appended for operators.
	Detail string
}

func (e *RunWorkspaceLost) Error() string {
	return "worker: run workspace lost (" + e.Reason + "): " + e.Detail
}

// Unwrap puts the closed-class sentinel in the chain so errors.Is finds the
// loss whether or not the caller wrapped this struct further.
func (e *RunWorkspaceLost) Unwrap() []error { return []error{ErrRunWorkspaceLost} }

// RunWorkspaceLostReason reports the workspace.recovery_lost reason a
// preparation refusal states, and whether the refusal is a lost-workspace arm
// at all (12 case 20's second arm, ADR-0023 § 7's workspace_lost class).
//
// The order is specific: an explicit typed reason always wins; the
// different-worker sentinel means different_worker; the bare loss sentinel is
// the volume-identity arm, which is what the store journalled when it refused
// an attempt whose run recorded a volume this worker no longer measures.
func RunWorkspaceLostReason(err error) (reason string, lost bool) {
	if err == nil {
		return "", false
	}
	var typed *RunWorkspaceLost
	if errors.As(err, &typed) && events.ValidRecoveryLostReason(typed.Reason) {
		return typed.Reason, true
	}
	switch {
	case errors.Is(err, ErrDifferentRunWorkspaceOwner):
		return events.RecoveryDifferentWorker, true
	case errors.Is(err, ErrRunWorkspaceLost):
		return events.RecoveryVolumeChanged, true
	}
	return "", false
}

// runWorkspaceLostDetail is the attempt detail behind a workspace_lost refusal.
// It names the event and the enum reason (the pair is the whole reportable
// story, contract § 3) and it is bounded: attempts.detail is a 512-byte column.
func runWorkspaceLostDetail(reason string, cause error) string {
	head := "workspace.recovery_lost/" + reason + ": this run's workspace is not on a volume this " +
		"worker can serve; its prior edits are lost, rerun required (ADR-0023 § 7 — never retried automatically)"
	if reason == events.RecoveryDifferentWorker {
		// M3 W8's sentence, unchanged: it is the wording the run page and the
		// operator both already quote.
		head = RunWorkspaceDetailDifferentWorker
	}
	if cause == nil {
		return head
	}
	return bounded(head+": "+cause.Error(), 512)
}

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
// failure short-circuits: Inner is never launched on a tree nobody prepared.
//
// The class depends on WHICH refusal it was (ADR-0023 § 7, 12 case 20's second
// arm, contract § 7.1 C6e): a run whose workspace lives on another worker or on
// a volume this worker no longer measures is `workspace_lost` — the prior edits
// are gone, the journal already carries the `workspace.recovery_lost` row that
// says so, and the class is what keeps the advancer from arming another attempt
// (`retriable` reads the author's retriableErrors, and the compiler refuses
// workspace_lost in that list). Every OTHER preparation failure — roots that
// could not be measured, a worktree that would not build, an unwired preparer —
// is still `infra`: the tree might come back on the next attempt, and calling
// it lost would journal a loss nobody observed.
func (e *RunWorkspaceExecutor) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	if e.Prepare == nil {
		return failedResult(ErrorClassInfra,
			"run workspace preparation is not wired (contract § 4 step 3): the attempt did not launch"), nil
	}
	if err := e.Prepare(ctx, c); err != nil {
		detail := "run workspace preparation failed (contract § 4 step 3): " + err.Error()
		class := ErrorClassInfra
		if reason, lost := RunWorkspaceLostReason(err); lost {
			class = ErrorClassWorkspaceLost
			detail = runWorkspaceLostDetail(reason, err)
		}
		if e.Logger != nil {
			e.Logger.Warn("run workspace preparation refused the attempt",
				slog.String("attempt_id", c.AttemptID), slog.String("run_id", c.RunID),
				slog.String("error_class", class),
				slog.String("error", bounded(err.Error(), 512)))
		}
		return failedResult(class, detail), nil
	}
	if e.Inner == nil {
		return failedResult(ErrorClassInfra,
			"run workspace prepared but no inner executor is wired for kind "+c.Kind), nil
	}
	return e.Inner.Execute(ctx, c, sink)
}
