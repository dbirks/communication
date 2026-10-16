package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// prepareUnit is the loop's M3 path: everything contract § 4.2 steps 1–4 do,
// with the two things a turn cannot do on its own — read the profile axes the
// unit must run under, and translate a sandbox refusal into the event pair the
// contract requires.
//
// The failure rule differs from M2's deliberately and in one respect only:
// a project with no repositories may still chat (the note survives), but a
// workspace that cannot be prepared for a project that *has* repositories fails
// the turn. The difference is whether there was anything to prepare, not whether
// a failure would be inconvenient.
func (l *TurnLoop) prepareUnit(ctx context.Context, c Claim, repos []Repo) (*Unit, error) {
	svc := l.units
	if svc == nil {
		return nil, errors.New("worker: no unit service configured")
	}
	axes, err := svc.profileName(ctx, c)
	if err != nil {
		return nil, err
	}
	unit, prepErr := svc.Prepare(ctx, UnitRequest{
		OrganizationID: c.OrganizationID, ProjectID: c.ProjectID,
		ConversationID: c.ConversationID, TurnID: c.TurnID, WorkerID: c.WorkerID,
		Axes: axes, LauncherID: c.LauncherID, FencingToken: c.FencingToken,
		Repos: toProjectRepos(repos),
	})
	if prepErr != nil {
		// The row is left `preparing` by the service; the loop's job is the
		// transcript note that says so. `workspace.prepared` is *not* emitted —
		// it means the tree is what the rows say it is, and nothing here earned
		// that claim.
		if len(repos) == 0 {
			l.note(c.ConversationID, "This conversation has no repositories, so no workspace was prepared: "+prepErr.Error())
			return nil, nil
		}
		return nil, prepErr
	}
	// workspace.prepared is emitted once per unit, by the loop rather than the
	// service: it is a journal write on a fenced turn, and ADR-0016 § 9 admits
	// exactly one holder of that fence. A service that journalled on its own
	// would have to be handed the fencing token, which is how you get a
	// quarantined worker writing events after its lease was stolen.
	if err := l.store.WorkspaceEvent(ctx, c, TurnEvent{
		Type: events.TypeWorkspacePrepared, ActorKind: events.ActorKindWorker, ActorID: c.WorkerID,
		Payload: events.WorkspacePreparedPayload{
			WorkspaceID: unit.WorkspaceID, ProjectID: c.ProjectID, ScopeKind: "conversation",
			ConversationID: c.ConversationID, WorkerID: c.WorkerID,
			VolumeID: unit.VolumeID(), WorkspaceMode: unit.Profile.WorkspaceMode,
			Repos:        repoFacts(unit),
			BaseCommits:  baseCommits(unit),
			PolicyDigest: unit.policyDigest(),
		},
	}); err != nil {
		// The workspace exists and the journal could not say so. Releasing it is
		// the only honest response: a `ready` row nobody can point at is exactly
		// the topology drift the state machine exists to catch.
		if _, cerr := unit.Cleanup(ctx); cerr != nil {
			l.log.Error("workspace cleanup after a failed journal append also failed", slog.String("error", cerr.Error()))
		}
		return nil, err
	}
	l.rememberUnit(c.ConversationID, unit)
	return unit, nil
}

// profileName resolves the axes a claim runs under. The default reads them from
// the profile revision the conversation is pinned to; tests and `disabled` mode
// install their own.
func (s *UnitService) profileName(ctx context.Context, c Claim) (ProfileAxes, error) {
	if s.Profiles == nil {
		// No profile source configured: the unit runs with the mode default, no
		// packaged context, and no commit grant. That is *not* the same as a
		// profile that says so — it is a worker that was started without the
		// profile reader wired, so it is loud in the log rather than silently
		// less capable.
		s.logger().Warn("no profile source configured; the unit runs with default axes",
			slog.String("launcher_id", c.LauncherID))
		return ProfileAxes{LauncherID: c.LauncherID, WorkspaceMode: "worktree"}, nil
	}
	axes, err := s.Profiles.ProfileFor(ctx, c.ConversationID)
	if err != nil {
		return ProfileAxes{}, err
	}
	if axes.WorkspaceMode == "" {
		axes.WorkspaceMode = "worktree"
	}
	return axes, nil
}

func toProjectRepos(in []Repo) []ProjectRepo {
	out := make([]ProjectRepo, 0, len(in))
	for _, r := range in {
		out = append(out, ProjectRepo{ID: r.ID, Name: r.Name, GitURL: r.GitURL, DefaultBranch: r.DefaultBranch})
	}
	return out
}

// repoFacts is the per-repository part of workspace.prepared's payload: what the
// tree actually is, as established rather than as requested.
// repoFacts is the per-repository part of workspace.prepared: the run ref and
// the identity it was cut from. Paths are deliberately absent — the event schema
// carries none, and the journal is browser-visible (contract § 3).
func repoFacts(u *Unit) []events.WorkspaceRepoRef {
	out := make([]events.WorkspaceRepoRef, 0, len(u.Repos))
	for _, r := range u.Repos {
		out = append(out, events.WorkspaceRepoRef{
			RepositoryID: r.RepositoryID, Name: r.Name, RunRef: r.RunRef,
		})
	}
	return out
}

// baseCommits maps repository *name* to the commit its worktree was created at,
// per the payload's own comment: a human reading the stream needs the name.
func baseCommits(u *Unit) map[string]string {
	out := make(map[string]string, len(u.Repos))
	for _, r := range u.Repos {
		out[r.Name] = r.BaseCommit
	}
	return out
}

// policyDigest is the digest of the policy this unit would launch under, or ""
// for a unit that runs without a sandbox. An empty string in a
// workspace.prepared event is meaningful — it says no policy was in play — and
// must not be backfilled with a placeholder that looks like a digest.
func (u *Unit) policyDigest() string {
	if u.Verified != nil {
		return u.Verified.PolicyDigest
	}
	if u.Enforcement == domain.EnforceDisabled || u.Enforcement == domain.EnforcePermissiveDev {
		return ""
	}
	d, err := u.svc.ProfileDigestFor(u.svc.kind())
	if err != nil {
		return ""
	}
	return d
}

// VolumeID is the identity of the storage root the workspace lives on — the
// value case 20 compares against the worker's current measurement. It comes from
// the prepare that established the tree, not from a fresh measure.
func (u *Unit) VolumeID() string { return u.workspaceVolume }

// rememberUnit keeps the live unit for capture/cleanup at the turn boundary.
func (l *TurnLoop) rememberUnit(conversationID string, u *Unit) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.liveUnits == nil {
		l.liveUnits = map[string]*Unit{}
	}
	l.liveUnits[conversationID] = u
}

func (l *TurnLoop) forgetUnit(conversationID string) *Unit {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.liveUnits == nil {
		return nil
	}
	u := l.liveUnits[conversationID]
	delete(l.liveUnits, conversationID)
	return u
}

// unitFor reads the live unit without taking it out of the map: the turn sink
// asks it for the secret-redaction hook on every flush, which is a read of
// state the unit owns, not a claim on its lifecycle.
func (l *TurnLoop) unitFor(conversationID string) *Unit {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.liveUnits == nil {
		return nil
	}
	return l.liveUnits[conversationID]
}

// note appends a transcript-visible line without going through a turn's stream,
// for the shapes where there is no turn content to attach to.
func (l *TurnLoop) note(conversationID, text string) {
	l.log.Warn("workspace note", slog.String("conversation_id", conversationID), slog.String("note", text))
}

// captureAndRelease is the loop's M3 turn-end hook: capture what the unit did,
// then clean it up, on every exit path.
//
// It runs *after* the turn's terminal event is journalled, and never blocks it:
// ordering the other way would make a capture failure able to erase the fact that
// a turn happened, and would let a slow artifact store hold a turn lease. The
// edits themselves are already durable — that is the whole point of ADR-0017 D8's
// capture-only design (deviation D9: an M3 failure loses artifacts, not edits).
// cleanupTimeout bounds the post-turn capture and cleanup. It is generous rather
// than tight because the work is local file removal plus a small number of git
// reads, and a *short* deadline here would silently skip the secret-removal
// assertion — which is the one thing in this path that has a security
// consequence. The upper bound exists so a wedged filesystem cannot hold a worker
// forever.
const cleanupTimeout = 90 * time.Second

func (l *TurnLoop) captureAndRelease(ctx context.Context, c Claim) {
	u := l.forgetUnit(c.ConversationID)
	if u == nil {
		return
	}
	// Context: a killed turn must still clean up, so the removal runs on a fresh
	// context with a deadline rather than the cancelled one. The journal appends
	// inside Cleanup are the fenced ones the loop already owns.
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()

	outcomes, err := u.Capture(cleanupCtx)
	if err != nil {
		l.log.Warn("unit capture failed",
			slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
	}
	for _, res := range outcomes {
		if !res.Committed {
			continue
		}
		// workspace.committed is the post-transaction readback, so it reports a
		// ref that git says exists. A commit whose ref update silently failed
		// (probe P8: exit 128 with a plausible command) cannot produce this event.
		if err := l.store.WorkspaceEvent(ctx, c, TurnEvent{
			Type: events.TypeWorkspaceCommitted, ActorKind: events.ActorKindWorker, ActorID: c.WorkerID,
			Payload: events.WorkspaceCommittedPayload{
				WorkspaceID: u.WorkspaceID, ProjectID: c.ProjectID,
				RepositoryID: res.RepositoryID, RunRef: res.RunRef, HeadCommit: res.HeadCommit,
			},
		}); err != nil {
			l.log.Warn("workspace.committed could not be journalled", slog.String("error", err.Error()))
		}
	}
	// ADR-0035's evidence read, the conversation path's half of it. It lands here
	// rather than in the ACP runtime because this is the loop's turn-end hook: the
	// turn's terminal row is already durable (so a lost audit read can cost a label
	// and never the turn), the append is fenced on the claim it belongs to, and it
	// runs before Cleanup because a wedged teardown must not be able to swallow the
	// one row that says what this turn's allowlist did. It is a no-op unless this
	// turn launched the unit and its profile committed to a host set.
	l.journalTurnEgressAudit(cleanupCtx, c, u)
	if _, err := u.Cleanup(cleanupCtx); err != nil {
		l.log.Error("unit cleanup failed", slog.String("workspace_id", u.WorkspaceID), slog.String("error", err.Error()))
	}
}

// sandboxFailureEvents is the pair ADR-0019 D6 requires on a refusal:
// sandbox.enforcement_failed and then conversation.turn.failed with
// reason="sandbox_enforcement_failed" — never "interrupted", which would report
// the crash of a process that never started, and never a fallback run.
func (l *TurnLoop) sandboxFailureEvents(ctx context.Context, c Claim, d *DenialError) {
	if d == nil {
		return
	}
	stage := d.Stage
	if !events.ValidSandboxStage(stage) {
		stage = events.SandboxStageGrantAssert
	}
	reason := d.Reason
	if !events.ValidSandboxFailureReason(reason) {
		reason = events.SandboxReasonGrantMismatch
	}
	if err := l.store.WorkspaceEvent(ctx, c, TurnEvent{
		Type: events.TypeSandboxEnforcementFailed, ActorKind: events.ActorKindWorker, ActorID: c.WorkerID,
		Payload: events.SandboxEnforcementFailedPayload{
			WorkspaceID: c.ConversationID, ProjectID: c.ProjectID, TurnID: c.TurnID,
			WorkerID: c.WorkerID,
			Backend:  "nono", Stage: stage, Reason: reason,
			PolicyDigest: d.PolicyDigest, ChildStarted: d.ChildStarted,
			// Detail is the bounded diagnostic field, and it is fed the *class* of
			// failure rather than the error text: nono's own messages quote grant
			// paths, and a browser-visible stream must carry role names only
			// (contract § 3). The full message goes to the worker log below.
			Detail: d.Class(),
		},
	}); err != nil {
		l.log.Error("sandbox.enforcement_failed could not be journalled", slog.String("error", err.Error()))
	}
	l.log.Error("sandbox refused the launch; the turn fails rather than running unsandboxed",
		slog.String("turn_id", c.TurnID), slog.String("stage", stage), slog.String("reason", reason))
}

// verifiedEvent is sandbox.verified: the row that makes "this turn really ran
// under required" answerable from the journal. The fields are the *observed*
// ones from the chain, not the configured ones — which is why a unit that has not
// run the chain has no event to emit at all.
func (l *TurnLoop) verifiedEvent(ctx context.Context, c Claim, u *Unit) error {
	if u == nil || u.Verified == nil {
		return nil
	}
	network, enforced := u.Verified.EgressReport()
	return l.store.WorkspaceEvent(ctx, c, TurnEvent{
		Type: events.TypeSandboxVerified, ActorKind: events.ActorKindWorker, ActorID: c.WorkerID,
		Payload: events.SandboxVerifiedPayload{
			ProjectID: c.ProjectID, TurnID: c.TurnID, WorkspaceID: u.WorkspaceID,
			WorkerID:        c.WorkerID,
			PolicyDigest:    u.Verified.PolicyDigest,
			Backend:         u.Verified.Backend,
			BackendVersion:  u.Verified.Version,
			AfUnixMediation: u.Verified.AfUnixMediation,
			NetworkEnforced: enforced,
			Network:         network,
			Grants:          eventGrants(u.Plan),
			CommitGranted:   u.Plan.CommitGranted,
			// Verified is the payload's own honesty field: true only when this
			// unit ran the chain, so a reader never has to infer it from absence.
			Verified: u.Verified.Verified,
		},
	})
}

// launchPlanFor returns the ctx-carrying spawn shape: the loop hands the session
// factory a context with the verified plan attached, and the factory's runtime
// execs argv[0] = the sandbox binary. A plan that was never verified cannot get
// into a context, because there is exactly one place that calls WithLaunchPlan.
func (l *TurnLoop) launchPlanFor(ctx context.Context, c Claim, u *Unit, launcher acp.Launcher) (context.Context, error) {
	if u == nil {
		return ctx, nil // no repositories: no workspace, therefore no sandbox
	}
	plan, err := u.Verify(ctx, launcher)
	if err != nil {
		var d *DenialError
		if errors.As(err, &d) {
			l.sandboxFailureEvents(ctx, c, d)
		}
		return ctx, fmt.Errorf("worker: sandbox verification for turn %s: %w", c.TurnID, err)
	}
	// u.Verify records the chain's own result on the unit; the event is written
	// from that record rather than from the plan, so a plan assembled without
	// running the chain (a configured non-required mode) produces no
	// sandbox.verified at all.
	if u.Verified != nil {
		if err := l.verifiedEvent(ctx, c, u); err != nil {
			l.log.Warn("sandbox.verified could not be journalled", slog.String("error", err.Error()))
		}
	}
	return acp.WithLaunchPlan(ctx, plan), nil
}

// eventGrants is the grant set in the shape the journal carries: role + access,
// never a path. Every role is checked against the event vocabulary here rather
// than trusted from the plan builder, because a role the schema does not know
// would reach a browser as an unrenderable label — and an unrenderable security
// label is one nobody reviewed.
func eventGrants(p wsgit.LaunchPlan) []events.SandboxGrant {
	out := make([]events.SandboxGrant, 0, len(p.Grants))
	for _, g := range p.Grants {
		if !events.ValidGrantRole(g.Role) || !events.ValidGrantAccess(g.Access()) {
			continue
		}
		out = append(out, events.SandboxGrant{Role: g.Role, Access: g.Access()})
	}
	return out
}
