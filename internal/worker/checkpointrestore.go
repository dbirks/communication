package worker

// The worker half of ADR-0023 § 6's `restore_checkpoint` arm:
//
//	"the worker, unsandboxed and *before* launching anything, resets the
//	 worktree branch to checkpoint.head_commit for the last completed
//	 boundary. Allowed only when every repo in the run is at a committed
//	 state at that boundary (an uncommitted diff would be destroyed), and it
//	 emits run.checkpoint_restored {from_commit, discarded_paths[]}"
//
// It is a decorator rather than a step inside ProcExec/AgentTurn for the same
// reason runworkspace.go's preparer is: every launchable kind needs it, none
// may launch without it, and the two must nest in a fixed order —
// RunWorkspaceExecutor{Prepare, Inner: CheckpointRestorer{Inner: ProcExec}} —
// so the reset lands AFTER § 4 step 3 built the tree and BEFORE step 5/6
// launches anything inside it.
//
// The reset runs in the worker process itself. That is what "unsandboxed"
// means here, and it is deliberate: no nono profile and no Landlock
// restriction wraps this call (AGENTS.md forbids sandboxing the main process,
// and ADR-0019's policies cover the launched program, not the worker's own
// git plumbing). It is also why the refusal checks all run before the first
// destructive command: an operation this powerful gets validated whole, then
// performed.
//
// Dependency rule (AGENTS.md): no store type appears here. The boundary
// arrives as a func supplied by cmd/communication, which is where postgres is
// already imported — exactly the shape runworkspace.go's RunWorkspacePreparer
// uses.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/events"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// Workspace policies (ADR-0023 § 6) — the two spellings the compiler admits
// (internal/pipelines/compiler policy.go/plan.go). A node that authored
// nothing is continue_workspace, and continue_workspace must never touch the
// tree: "the worktree is left exactly as the interrupted attempt left it".
const (
	WorkspacePolicyContinue = "continue_workspace"
	WorkspacePolicyRestore  = "restore_checkpoint"
)

// CheckpointRestoreDetailUnavailable is the refusal detail a restore that lost
// its precondition carries. The code is the SAME one the API refuses route 31
// with (api.RunConflictCheckpointUnavailable ← runtime.ErrCheckpointUnavailable):
// the engine checked the boundary when it re-queued the attempt, so a worker
// that finds the boundary uncommitted, unrecorded or unresolvable is reporting
// that the rows moved underneath the retry — the same fact, same name, one
// layer later. It says what was not touched because a refusal that reads like
// a completion is how a data-loss bug ships.
const CheckpointRestoreDetailUnavailable = "checkpoint_unavailable: ADR-0023 § 6 allows " +
	"restore_checkpoint only when every repository in the run is at a committed state at the " +
	"last completed boundary; the boundary was not provably committed, so no worktree was reset"

// hexCommit is the only shape a boundary identity may have — the same rule
// wsgit.restore.go enforces, restated here so a malformed commit is refused
// before any git process is spawned rather than after.
var hexCommit = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// RestoreBoundary is everything § 6's arm needs to know about one retried
// attempt, resolved from rows: the node's compiled policy, the boundary's
// recorded repo states, and where those repositories live on THIS worker's
// tree.
type RestoreBoundary struct {
	// Mode is the retried node's compiled retry.workspacePolicy.
	Mode string
	// RepoStates are checkpoint.head_commit's owners: one entry per repository
	// in the run, exactly as run_checkpoints.repo_states recorded it.
	RepoStates []CheckpointRepoState
	// Checkouts maps repository id to the absolute worktree path of this run.
	Checkouts map[string]string
	// Excluded is the declared exclusion set (ADR-0017 D6). Excluded paths
	// survive the clean and are never reported as discarded.
	Excluded []string
}

// BoundaryResolver answers "what does this attempt inherit?" for one claim.
// ok=false means no boundary is recorded for the run at all (its first node),
// which continue_workspace handles by simply starting clean; under
// restore_checkpoint it is the refusal runtime already named.
type BoundaryResolver func(ctx context.Context, c AttemptClaim) (b RestoreBoundary, ok bool, err error)

// RestoreGit is the git half, satisfied by *wsgit.Manager. It is an interface
// so the policy tests below can prove the refusal without a disk, while the
// real reset still runs through the one implementation.
type RestoreGit interface {
	RestoreToBoundary(ctx context.Context, req wsgit.RestoreRequest) (wsgit.RestoreReport, error)
}

// CheckpointRestorer performs the unsandboxed reset and journals it.
type CheckpointRestorer struct {
	// Inner is the kind's real executor. Nothing launches through it until a
	// restore that was required has either run or refused.
	Inner AttemptExecutor
	// Boundary resolves the attempt's policy + boundary. Nil means this worker
	// was wired without the § 6 arm — the pre-existing behaviour (no reset,
	// no event) is kept rather than invented, and reported by the wiring test.
	Boundary BoundaryResolver
	// Git runs the reset. Required whenever a boundary reports restore mode.
	Git RestoreGit
	// Logger is optional.
	Logger *slog.Logger
}

var _ AttemptExecutor = (*CheckpointRestorer)(nil)

// Execute restores, journals, then delegates. Every branch that does not
// launch says so in the returned AttemptResult.
func (e *CheckpointRestorer) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	if e.Boundary == nil {
		// Unwired: the worker behaves exactly as it did before § 6's arm
		// existed — continue_workspace semantics for every node. Refusing here
		// would break every run over a wiring gap the node's author cannot see.
		return e.delegate(ctx, c, sink)
	}
	b, ok, err := e.Boundary(ctx, c)
	if err != nil {
		return failedResult(ErrorClassInfra,
			"checkpoint boundary read failed (ADR-0023 § 6): "+err.Error()), nil
	}
	// § 6's arm is a RETRY workspace policy: `retry.workspacePolicy` states
	// what the retry does with the tree the interrupted attempt left behind.
	// A node's FIRST attempt has no interrupted attempt — and under
	// restore_checkpoint it is often a fresh until-loop iteration whose
	// predecessor's uncommitted edits are the point of the next iteration.
	// Resetting there destroys work § 6 never licensed (lab live19 C6c: every
	// iteration of /implement was reset to the /plan boundary, the loop
	// replayed iteration 1 until it exhausted, and the run failed). A
	// restore-policy node's attempt 1 therefore runs on the tree it inherits,
	// untouched and un-evented, exactly like continue_workspace.
	if !ok || b.Mode != WorkspacePolicyRestore || c.AttemptNumber <= 1 {
		// continue_workspace (the M4 default) leaves the tree exactly as the
		// interrupted attempt left it: no read of git, no write, no event.
		return e.delegate(ctx, c, sink)
	}
	if e.Git == nil {
		return failedResult(ErrorClassInfra,
			CheckpointRestoreDetailUnavailable+": the node asked for restore_checkpoint but this "+
				"worker has no git manager wired, so nothing was reset and nothing launched"), nil
	}
	states, why := committedBoundary(b)
	if len(states) == 0 {
		return failedResult(ErrorClassInfra, CheckpointRestoreDetailUnavailable+": "+why), nil
	}
	// The reset is per repository but validated whole above: a run whose third
	// repository has no checkout must not have its first two reset halfway
	// (validate-then-mutate, the same rule route 31 follows when it refuses).
	discarded := []string{}
	for _, st := range states {
		checkout := strings.TrimSpace(b.Checkouts[st.RepositoryID])
		if checkout == "" {
			return failedResult(ErrorClassInfra, CheckpointRestoreDetailUnavailable+
				": repository "+st.RepositoryID+" is committed at the boundary but has no checkout on this worker"), nil
		}
	}
	var fromCommit string
	restored := 0
	for _, st := range states {
		if fromCommit == "" {
			// § 3 row 8 carries ONE from_commit. With several repositories the
			// engine already picked one — runtime.RetryPlan takes the boundary
			// states' first entry, and postgres reads them ORDER BY
			// repository_id — so the worker names the same commit the engine
			// journaled rather than inventing a second rule.
			fromCommit = st.HeadCommit
		}
		rep, err := e.Git.RestoreToBoundary(ctx, wsgit.RestoreRequest{
			Checkout:   b.Checkouts[st.RepositoryID],
			HeadCommit: st.HeadCommit,
			Excluded:   b.Excluded,
		})
		if err != nil {
			detail := CheckpointRestoreDetailUnavailable + ": repository " + st.RepositoryID +
				" could not be restored: " + err.Error()
			if errors.Is(err, wsgit.ErrRestoreRefused) {
				// A refusal inside the manager touched nothing.
				detail = err.Error()
			}
			if restored > 0 {
				// An earlier repository in THIS attempt was already reset. Its
				// disclosure is owed even though the attempt fails — § 6 makes
				// discarded_paths the record of what the reset took, and
				// swallowing it here would hide a real loss behind an infra class.
				if eErr := emitCheckpointRestored(ctx, sink, c, fromCommit, discarded, e.log()); eErr != nil {
					e.log().Warn("run.checkpoint_restored could not be journaled after a partial restore",
						slog.String("attempt_id", c.AttemptID), slog.String("error", bounded(eErr.Error(), 512)))
				}
			}
			return failedResult(ErrorClassInfra, detail), nil
		}
		restored++
		discarded = append(discarded, rep.DiscardedPaths...)
	}
	sort.Strings(discarded)
	if err := emitCheckpointRestored(ctx, sink, c, fromCommit, discarded, e.log()); err != nil {
		return failedResult(ErrorClassInfra,
			"run.checkpoint_restored could not be journaled after the reset (ADR-0023 § 6): "+err.Error()), nil
	}
	return e.delegate(ctx, c, sink)
}

// delegate hands the attempt to the kind's executor, or refuses honestly when
// the decorator was installed with no inner executor.
func (e *CheckpointRestorer) delegate(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	if e.Inner == nil {
		return failedResult(ErrorClassInfra,
			"checkpoint restore completed but no inner executor is wired for kind "+c.Kind), nil
	}
	return e.Inner.Execute(ctx, c, sink)
}

// committedBoundary is § 6's precondition, evaluated from the record and never
// from a memory: EVERY repository in the run must be at a committed state at
// the boundary. A nil `committed` pointer means nobody measured that tree, and
// "nobody measured" cannot license destroying it (C6d) — the same rule
// runtime.RetryPlan applies before it will re-queue at all.
func committedBoundary(b RestoreBoundary) ([]CheckpointRepoState, string) {
	if len(b.RepoStates) == 0 {
		return nil, "the boundary records no repository state"
	}
	out := make([]CheckpointRepoState, 0, len(b.RepoStates))
	for _, st := range b.RepoStates {
		if st.Committed == nil {
			return nil, "repository " + st.RepositoryID + " was not captured at the boundary: " +
				"its committed state is unrecorded"
		}
		if !*st.Committed {
			return nil, fmt.Sprintf("repository %s has uncommitted changes at the boundary", st.RepositoryID)
		}
		if !hexCommit.MatchString(st.HeadCommit) {
			return nil, fmt.Sprintf("repository %s has no hex boundary commit (head_commit %q)",
				st.RepositoryID, st.HeadCommit)
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RepositoryID < out[j].RepositoryID })
	return out, ""
}

// emitCheckpointRestored appends § 3 row 8 on the attempt's own fenced journal
// path — the same AppendEvent every other worker event travels (attemptloop's
// attemptSink), so a worker that lost its lease cannot write it.
func emitCheckpointRestored(ctx context.Context, sink AttemptSink, c AttemptClaim,
	fromCommit string, discarded []string, log *slog.Logger) error {
	if sink == nil {
		return errors.New("no attempt sink: the event has nowhere fenced to land")
	}
	paths := discarded
	if paths == nil {
		paths = []string{}
	}
	return sink.AppendEvent(ctx, AttemptEvent{
		Type:      events.TypeRunCheckpointRestored,
		ActorKind: events.ActorKindWorker,
		Payload: events.RunCheckpointRestoredPayload{
			ProjectID:       c.ProjectID,
			RunID:           c.RunID,
			NodeInstanceKey: c.NodeInstanceKey,
			FromCommit:      fromCommit,
			DiscardedPaths:  paths,
		},
	})
}

func (e *CheckpointRestorer) log() *slog.Logger {
	if e.Logger != nil {
		return e.Logger
	}
	return slog.Default()
}
