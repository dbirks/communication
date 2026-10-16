package worker

import (
	"context"
	"errors"
	"log/slog"
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
type EgressAuditor interface {
	AuditSessionEgress(ctx context.Context, marker string) (nono.EgressObservation, error)
}

// egressMarker is the launch marker an agent turn's audit is found by. The
// attempt id is already in the child's argv (agentturn.go's Extra env, applied
// through nono's `env` hop, which `nono audit list --json` records verbatim), so
// attribution needs no new flag in the argv ADR-0035 froze as "unchanged".
func egressMarker(attemptID string) string {
	return egressMarkerEnv + "=" + attemptID
}

const egressMarkerEnv = "COMMUNICATION_ATTEMPT_ID"

// egressAuditor returns the audit seam: the explicit field if wired, else the
// sandbox backend when it can read audits itself, else nil (= no surface).
func (a *AgentTurn) egressAuditor() EgressAuditor {
	if a.Egress != nil {
		return a.Egress
	}
	if au, ok := a.Sandbox.(EgressAuditor); ok {
		return au
	}
	return nil
}

// journalEgressAudit performs design A's read for one finished agent turn and
// journals what it found. It is called once, after the sandboxed child is gone,
// and only under a profile whose digest commits to a host set: an open profile
// has nothing to earn, and a `--block-net` profile is already labelled by the
// argv sandbox.verified recorded (ADR-0035 § 3).
//
// The VerificationResult it reads is copied, never mutated: the same fake object
// can be handed to two attempts, and stamping one run's denials onto another's
// verification would let an unexercised allowlist borrow a denial it never saw.
func (a *AgentTurn) journalEgressAudit(ctx context.Context, sink AttemptSink, c AttemptClaim, workspaceID string, chain *nono.VerificationResult) {
	if chain == nil || chain.NetworkEnforced != nono.NetworkAllowlisted {
		return
	}
	run := *chain
	audit := a.egressAuditor()
	if audit == nil {
		a.journal(ctx, sink, c, events.TypeSandboxEgressObserved,
			egressObservedPayload(c, workspaceID, &run, nono.EgressObservation{},
				errNoEgressAuditSurface))
		return
	}
	actx, cancel := context.WithTimeout(ctx, egressAuditTimeout)
	obs, err := audit.AuditSessionEgress(actx, egressMarker(c.AttemptID))
	cancel()
	if err != nil {
		// Bounded and non-fatal by design: the turn already succeeded or failed
		// on its own merits, and this row only says whether its egress claim can
		// be made. Say it out loud, then say it in the journal — and redact first,
		// because nono's own failure line quotes its state root and the journal is
		// browser-visible (sandbox.enforcement_failed's Detail rule).
		msg := a.redact(err.Error())
		a.logger().Warn("agent.acp egress audit unavailable; reporting the run's network claim as unenforced",
			slog.String("attempt_id", c.AttemptID), slog.String("error", msg))
		err = errors.New(msg)
	}
	run.EgressDenials = obs.Denials
	a.journal(ctx, sink, c, events.TypeSandboxEgressObserved,
		egressObservedPayload(c, workspaceID, &run, obs, err))
}

// egressObservedPayload builds the row from the run's copy of the chain plus
// what the audit said (or why it could not be read). The network label is
// computed by the ONE path ADR-0035 allows — VerificationResult.EgressReport —
// so this event and sandbox.verified can never spell the claim differently.
func egressObservedPayload(c AttemptClaim, workspaceID string, run *nono.VerificationResult, obs nono.EgressObservation, auditErr error) events.SandboxEgressObservedPayload {
	network, enforced := run.EgressReport()
	p := events.SandboxEgressObservedPayload{
		ProjectID: c.ProjectID, WorkspaceID: workspaceID, WorkerID: c.WorkerID,
		PolicyDigest: run.PolicyDigest, Backend: run.Backend,
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
