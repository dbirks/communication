package worker

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// errNoEgressAuditSurface is the honest sentence for a sandbox backend that has
// no audit read at all: the run's label stays what an unexercised allowlist
// says, and the journal says why rather than going silent.
var errNoEgressAuditSurface = errors.New("no egress audit surface is wired for this sandbox backend")

// egressAuditTimeout bounds the post-turn audit read. Two seconds is the whole
// budget for a surface that runs after the turn has already answered: the worst
// outcome it can produce is a missing label, never a stuck attempt, so it gets
// no share of the 30 s verification timeout the pre-launch chain spends.
const egressAuditTimeout = 2 * time.Second

// EgressAuditor reads one finished launch's OWN egress audit, finding the
// backend's session by the marker that launch's argv carried.
//
// `*nono.Launcher` satisfies it, so the production worker (whose Sandbox seam IS
// a nono launcher) reads its audits with no new wiring; a test substitutes a
// fake. Nothing here may fail a turn: an error means "this run cannot show what
// its allowlist did", which ADR-0035 answers with the open/not-enforced label —
// never with a guess and never with a failure.
//
// Both launch paths use it: the pipeline attempt (AgentTurn.journalEgressAudit)
// and the interactive conversation turn (TurnLoop.journalTurnEgressAudit), which
// is the coverage row docs/compatibility/SANDBOX.md § "Egress allowlist lab
// evaluation" recorded as FAIL — the enforcement and the audit existed, only the
// read was never wired on that path.
type EgressAuditor interface {
	AuditSessionEgress(ctx context.Context, marker string) (nono.EgressObservation, error)
}

// The two launch markers. A marker is one `env KEY=ID` entry in the child's
// argv, which `nono audit list --json` records verbatim, so a finished run can
// find ITS OWN audit session and no one else's (design A's rule: a label is
// earned by that run's denials or not at all). The attempt id is already in the
// attempt argv and the turn id is already in the conversation argv
// (unit.go's adapterEnv); attribution needed no new flag in the argv ADR-0035
// froze as "unchanged".
func egressMarker(attemptID string) string { return egressMarkerEnv + "=" + attemptID }

// egressTurnMarker is the conversation path's equivalent of egressMarker. It is
// a *turn* id rather than a session or workspace id on purpose: a conversation's
// workspace id outlives one launch's audit and would attribute a turn's egress
// claim to a tree rather than to the run that made it.
func egressTurnMarker(turnID string) string { return egressTurnMarkerEnv + "=" + turnID }

const (
	egressMarkerEnv     = "COMMUNICATION_ATTEMPT_ID"
	egressTurnMarkerEnv = "COMMUNICATION_TURN_ID"
)

// egressRun identifies the one launch whose audit is being read: the ids the
// row must carry, plus the marker that finds the backend's session. TurnID is
// set on the conversation path and empty on the attempt path, whose subject is
// the attempt (the payload has no attempt field because the attempt's own
// terminal rows are what a reader joins it to).
type egressRun struct {
	ProjectID   string
	WorkerID    string
	WorkspaceID string
	TurnID      string
	Marker      string
}

// resolveEgressAuditor returns the audit seam: the explicit field if wired, else
// the sandbox backend when it can read audits itself (the production shape —
// *nono.Launcher is both the AgentSandbox and the auditor), else nil = no
// surface, which is a configuration the journal states rather than a defect.
func resolveEgressAuditor(explicit EgressAuditor, sandbox any) EgressAuditor {
	if explicit != nil {
		return explicit
	}
	if au, ok := sandbox.(EgressAuditor); ok {
		return au
	}
	return nil
}

// egressAuditor returns the audit seam for the attempt path.
func (a *AgentTurn) egressAuditor() EgressAuditor {
	return resolveEgressAuditor(a.Egress, a.Sandbox)
}

// egressAuditor returns the audit seam for the conversation path, which reaches
// the same backend through the unit service that prepared and verified its launch.
func (s *UnitService) egressAuditor() EgressAuditor {
	if s == nil {
		return nil
	}
	return resolveEgressAuditor(s.Egress, s.Sandbox)
}

// readEgressAudit performs design A's read for one finished launch and returns
// the row it earned. It is called once, after that launch's sandboxed child is
// gone, and only under a profile whose digest commits to a host set: an open
// profile has nothing to earn, and a `--block-net` profile is already labelled by
// the argv sandbox.verified recorded (ADR-0035 § 3).
//
// The VerificationResult it reads is copied, never mutated: the same fake object
// can be handed to two runs, and stamping one run's denials onto another's
// verification would let an unexercised allowlist borrow a denial it never saw.
func readEgressAudit(ctx context.Context, audit EgressAuditor, run egressRun, chain *nono.VerificationResult,
	redact func(string) string, logger *slog.Logger) events.SandboxEgressObservedPayload {
	res := *chain
	if audit == nil {
		return egressObservedPayload(run, &res, nono.EgressObservation{}, errNoEgressAuditSurface)
	}
	actx, cancel := context.WithTimeout(ctx, egressAuditTimeout)
	obs, err := audit.AuditSessionEgress(actx, run.Marker)
	cancel()
	if err != nil {
		// Bounded and non-fatal by design: the turn already succeeded or failed
		// on its own merits, and this row only says whether its egress claim can
		// be made. Say it out loud, then say it in the journal — and redact first,
		// because nono's own failure line quotes its state root and the journal is
		// browser-visible (sandbox.enforcement_failed's Detail rule).
		msg := err.Error()
		if redact != nil {
			msg = redact(msg)
		}
		if logger != nil {
			logger.Warn("egress audit unavailable; reporting the run's network claim as unenforced",
				slog.String("marker", run.Marker), slog.String("error", msg))
		}
		err = errors.New(msg)
	}
	res.EgressDenials = obs.Denials
	return egressObservedPayload(run, &res, obs, err)
}

// journalEgressAudit is the attempt path's call of readEgressAudit + append.
func (a *AgentTurn) journalEgressAudit(ctx context.Context, sink AttemptSink, c AttemptClaim, workspaceID string, chain *nono.VerificationResult) {
	if chain == nil || chain.NetworkEnforced != nono.NetworkAllowlisted {
		return
	}
	run := egressRun{ProjectID: c.ProjectID, WorkerID: c.WorkerID, WorkspaceID: workspaceID,
		Marker: egressMarker(c.AttemptID)}
	a.journal(ctx, sink, c, events.TypeSandboxEgressObserved,
		readEgressAudit(ctx, a.egressAuditor(), run, chain, a.redact, a.logger()))
}

// journalTurnEgressAudit is ADR-0035's evidence read for one interactive
// conversation turn, called from the loop's turn-end hook. Same rule as the
// attempt path, same row, one extra guard: the marker is the *launching* turn's
// id, so a turn that rode a session some earlier turn launched has no audit of
// its own to read and journals nothing. Claiming a borrowed session's denials
// would let a turn that made no connection say its allowlist was enforced.
//
// Unlike the attempt path, this seam does not wait for the child to exit: the
// loop keeps a completed turn's session live, so the row reports the launch's
// journal as of turn end. That can only under-report — a denial recorded after
// this read costs the next reader a label, it can never invent one — which is
// the same direction of error ADR-0035 § 3 mandates for an unread audit.
func (l *TurnLoop) journalTurnEgressAudit(ctx context.Context, c Claim, u *Unit) {
	if u == nil || u.TurnID == "" || u.TurnID != c.TurnID {
		return
	}
	if u.Verified == nil || u.Verified.NetworkEnforced != nono.NetworkAllowlisted {
		return
	}
	run := egressRun{ProjectID: c.ProjectID, WorkerID: c.WorkerID, WorkspaceID: u.WorkspaceID,
		TurnID: c.TurnID, Marker: egressTurnMarker(c.TurnID)}
	p := readEgressAudit(ctx, u.svc.egressAuditor(), run, u.Verified, turnEgressRedact(u), l.log)
	if err := l.store.WorkspaceEvent(ctx, c, TurnEvent{
		Type: events.TypeSandboxEgressObserved, ActorKind: events.ActorKindWorker, ActorID: c.WorkerID,
		Payload: p,
	}); err != nil {
		// A label we could not write is a label we did not claim; the turn's own
		// terminal state is already durable and stays untouched.
		l.log.Warn("sandbox.egress_observed could not be journalled",
			slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
	}
}

// turnEgressRedact is the conversation path's Detail redactor: the host roots a
// nono failure line quotes, plus anything this unit materialized (a secret value
// must never reach the journal, not even inside an adapter's own error).
func turnEgressRedact(u *Unit) func(string) string {
	roots := []string{u.svc.LauncherHome, u.svc.PolicyDir, u.Layout.Root, u.Layout.Work}
	secret := func(s string) string { return s }
	if u.Materialized != nil && u.Materialized.Redact != nil {
		red := u.Materialized.Redact
		secret = func(s string) string { out, _ := red(s); return out }
	}
	return func(s string) string {
		for _, root := range roots {
			if root != "" {
				s = strings.ReplaceAll(s, root, "<host-root>")
			}
		}
		return bounded(secret(s), 512)
	}
}

// egressObservedPayload builds the row from the run's copy of the chain plus
// what the audit said (or why it could not be read). The network label is
// computed by the ONE path ADR-0035 allows — VerificationResult.EgressReport —
// so this event and sandbox.verified can never spell the claim differently.
func egressObservedPayload(run egressRun, res *nono.VerificationResult, obs nono.EgressObservation, auditErr error) events.SandboxEgressObservedPayload {
	network, enforced := res.EgressReport()
	p := events.SandboxEgressObservedPayload{
		ProjectID: run.ProjectID, TurnID: run.TurnID, WorkspaceID: run.WorkspaceID,
		WorkerID:     run.WorkerID,
		PolicyDigest: res.PolicyDigest, Backend: res.Backend,
		Network: network, NetworkEnforced: enforced,
		Allowed: obs.Allows, Denied: len(obs.Denials),
		DeniedHosts: obs.DeniedHosts(),
		Status:      events.EgressAuditStatusObserved,
	}
	if p.DeniedHosts == nil {
		p.DeniedHosts = []string{}
	}
	if auditErr != nil {
		p.Status = events.EgressAuditStatusUnavailable
		p.Detail = bounded(auditErr.Error(), 512)
		// A failed read is not an observation: the label falls back to what the
		// chain alone supports, which for an allowlisted profile with no observed
		// denial is "open" + not enforced (ADR-0035 § 3).
		p.Network, p.NetworkEnforced = string(nono.NetworkOpen), false
		p.Allowed, p.Denied, p.DeniedHosts = 0, 0, []string{}
		return p
	}
	p.SandboxSession = obs.SessionID
	return p
}
