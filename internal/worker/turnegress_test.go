package worker

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// turnEgressStore is the loop's persistence port for these tests: it implements
// WorkspaceEvent, the one method the turn-end egress hook may call, and embeds
// the interface so a call to anything else panics loudly rather than silently
// succeeding — the hook must not grow a second write path unnoticed.
type turnEgressStore struct {
	TurnStore
	writes []TurnEvent
	err    error
}

func (s *turnEgressStore) WorkspaceEvent(_ context.Context, _ Claim, ev TurnEvent) error {
	if s.err != nil {
		return s.err
	}
	s.writes = append(s.writes, ev)
	return nil
}

func turnEgressClaim() Claim {
	return Claim{TurnID: "01turn", ConversationID: "conv-1", ProjectID: "p-1",
		OrganizationID: "o-1", WorkerID: "worker-1", FencingToken: 7}
}

// newTurnEgressLoop builds a unit whose launch was verified under an allowlisted
// profile, the shape docs/compatibility/SANDBOX.md § "Egress allowlist lab
// evaluation" observed, plus the loop that has to read its audit.
func newTurnEgressLoop(audit EgressAuditor) (*TurnLoop, *turnEgressStore, *Unit) {
	svc := &UnitService{
		LauncherHome: "/srv/launcher-home", PolicyDir: "/srv/policy",
		Egress: audit,
	}
	u := &Unit{
		svc: svc, TurnID: "01turn", ConversationID: "conv-1", ProjectID: "p-1", WorkerID: "worker-1",
		WorkspaceID: "01workspace", Layout: wsgit.Layout{Root: "/workspaces/conversation/01conv", Work: "/workspaces/conversation/01conv/work"},
		Verified: allowlistedChain(),
	}
	st := &turnEgressStore{}
	l := &TurnLoop{store: st, units: svc, log: slog.New(slog.NewTextHandler(discardWriter{}, nil))}
	return l, st, u
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

// TestConversationTurnEarnsItsOwnEgressLabel closes the one FAIL row of
// docs/compatibility/SANDBOX.md § "Egress allowlist lab evaluation": an
// interactive conversation enforced the same boundary and nono audited it, but
// nothing in its own journal could ever say so, because the read was wired only
// for pipeline attempts. The rule is unchanged and shared with that path: a
// denial in THIS turn's audit earns allowlisted:<hosts>, none proves nothing,
// and an unread audit says so in the row while costing a label and not the turn.
func TestConversationTurnEarnsItsOwnEgressLabel(t *testing.T) {
	oneDenial := nono.EgressObservation{
		SessionID: "turn0000000000003", Allows: 20,
		Denials: []nono.EgressDenial{{
			Target: "example.com", Port: 443, Mode: "connect", Category: "host_denied",
			Reason: "host example.com:443 is not in the allowlist",
		}},
	}
	t.Run("a denial in its own audit earns the label", func(t *testing.T) {
		audit := &fakeEgressAudit{obs: oneDenial}
		l, st, u := newTurnEgressLoop(audit)
		l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
		if audit.marker != "COMMUNICATION_TURN_ID=01turn" {
			t.Fatalf("marker = %q, want the conversation launch's own turn marker: reading some other run's audit would buy a label this turn never earned", audit.marker)
		}
		p := turnEgressRow(t, st)
		if p.TurnID != "01turn" || p.ProjectID != "p-1" || p.WorkerID != "worker-1" || p.WorkspaceID != "01workspace" {
			t.Errorf("row does not identify its turn: %+v", p)
		}
		want := "allowlisted:" + strings.Join(nono.DefaultEgressHosts(), ",")
		if p.Network != want || !p.NetworkEnforced {
			t.Errorf("network = %q enforced = %v, want %q/true", p.Network, p.NetworkEnforced, want)
		}
		if p.Status != events.EgressAuditStatusObserved || p.Denied != 1 || p.Allowed != 20 || strings.Join(p.DeniedHosts, ",") != "example.com" {
			t.Errorf("counts = %+v, want observed 20 allowed / 1 denied (example.com)", p)
		}
		if p.SandboxSession != "turn0000000000003" {
			t.Errorf("sandbox_session = %q, want the row a lab operator quotes", p.SandboxSession)
		}
		// The unit's own chain is untouched: sandbox.verified was already written
		// from it and must keep saying what the chain alone supported.
		if len(u.Verified.EgressDenials) != 0 {
			t.Error("the post-turn audit retroactively stamped the unit's verification result")
		}
	})

	t.Run("no denial proves nothing", func(t *testing.T) {
		l, st, u := newTurnEgressLoop(&fakeEgressAudit{})
		l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
		p := turnEgressRow(t, st)
		if p.Network != string(nono.NetworkOpen) || p.NetworkEnforced || p.Status != events.EgressAuditStatusObserved {
			t.Errorf("an unexercised allowlist claimed %q/%v/%q", p.Network, p.NetworkEnforced, p.Status)
		}
	})

	t.Run("an unread audit is diagnosable and not fatal", func(t *testing.T) {
		l, st, u := newTurnEgressLoop(&fakeEgressAudit{err: errors.New(
			"sandbox: none of the last 50 audited sessions carries the launch marker COMMUNICATION_TURN_ID=01turn (state root /srv/launcher-home/nono)",
		)})
		l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
		p := turnEgressRow(t, st)
		if p.Status != events.EgressAuditStatusUnavailable || p.Network != string(nono.NetworkOpen) || p.NetworkEnforced {
			t.Errorf("row = %+v, want unavailable + open/false", p)
		}
		if !strings.Contains(p.Detail, "marker") {
			t.Errorf("detail = %q, want the row to say why the audit was unread", p.Detail)
		}
		if strings.Contains(p.Detail, "/srv/launcher-home") {
			t.Errorf("detail leaks a host root into a browser-visible journal: %q", p.Detail)
		}
	})

	t.Run("no audit surface says so", func(t *testing.T) {
		svc := &UnitService{LauncherHome: "/srv/launcher-home", PolicyDir: "/srv/policy"}
		u := &Unit{svc: svc, TurnID: "01turn", WorkspaceID: "01workspace", Verified: allowlistedChain()}
		st := &turnEgressStore{}
		l := &TurnLoop{store: st, units: svc, log: slog.New(slog.NewTextHandler(discardWriter{}, nil))}
		l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
		if p := turnEgressRow(t, st); p.Status != events.EgressAuditStatusUnavailable ||
			!strings.Contains(p.Detail, "no egress audit surface") {
			t.Errorf("row = %+v, want an unavailable row naming the missing surface", p)
		}
	})
}

// TestConversationEgressJournalStaysScoped is the negative half: the row belongs
// to the launch, so nothing may be written for a turn that did not make it, for
// a unit that never ran the chain, or for a profile that commits to no host set.
// Each silent case is what keeps the positive one meaningful — a borrowed label
// is the failure ADR-0035 § 3 exists to refuse.
func TestConversationEgressJournalStaysScoped(t *testing.T) {
	audit := &fakeEgressAudit{obs: nono.EgressObservation{SessionID: "s", Allows: 1,
		Denials: []nono.EgressDenial{{Target: "example.com", Category: "host_denied"}}}}
	cases := []struct {
		name string
		mut  func(*Unit)
	}{
		{name: "a turn riding someone else's launch", mut: func(u *Unit) { u.TurnID = "01earlier" }},
		{name: "no turn id at all", mut: func(u *Unit) { u.TurnID = "" }},
		{name: "a unit that never ran the chain", mut: func(u *Unit) { u.Verified = nil }},
		{name: "an open profile has nothing to earn", mut: func(u *Unit) {
			v := *allowlistedChain()
			v.NetworkEnforced = nono.NetworkOpen
			v.EgressHosts = nil
			u.Verified = &v
		}},
		{name: "a denied-egress profile is already labelled by sandbox.verified", mut: func(u *Unit) {
			v := *allowlistedChain()
			v.NetworkEnforced = nono.NetworkDenied
			u.Verified = &v
		}},
		{name: "no unit", mut: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l, st, u := newTurnEgressLoop(audit)
			if tc.mut != nil {
				tc.mut(u)
			}
			if tc.name == "no unit" {
				u = nil
			}
			l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
			if len(st.writes) != 0 {
				t.Fatalf("journalled %d events for a turn that earned none: %+v", len(st.writes), st.writes[0].Payload)
			}
		})
	}
	if audit.calls != 0 {
		t.Fatalf("the audit surface was read %d times by turns that had no business reading it", audit.calls)
	}
}

// TestConversationEgressRowSurvivesAFailedAppend keeps the write failure honest:
// the hook reports nothing higher than a warning, because the turn's terminal
// state is already durable and a label we could not write is a label we did not
// claim.
func TestConversationEgressRowSurvivesAFailedAppend(t *testing.T) {
	l, st, u := newTurnEgressLoop(&fakeEgressAudit{obs: nono.EgressObservation{SessionID: "s", Allows: 1}})
	st.err = errors.New("fenced append rejected: lease lost")
	l.journalTurnEgressAudit(context.Background(), turnEgressClaim(), u)
	if len(st.writes) != 0 {
		t.Fatalf("unexpected writes: %+v", st.writes)
	}
}

func turnEgressRow(t *testing.T, st *turnEgressStore) events.SandboxEgressObservedPayload {
	t.Helper()
	for _, ev := range st.writes {
		if p, ok := ev.Payload.(events.SandboxEgressObservedPayload); ok {
			if ev.Type != events.TypeSandboxEgressObserved || ev.ActorKind != events.ActorKindWorker {
				t.Fatalf("row carried actor %q/%q, not a worker's %s", ev.ActorKind, ev.ActorID, events.TypeSandboxEgressObserved)
			}
			return p
		}
	}
	t.Fatalf("no sandbox.egress_observed among %d fenced writes", len(st.writes))
	return events.SandboxEgressObservedPayload{}
}

// TestTheTwoLaunchMarkersStayOnTheirOwnPaths is what keeps ADR-0035's
// per-run-attribution rule from decaying into a shared label: a pipeline attempt
// stamps its launch with the attempt id and an interactive turn with the turn
// id, and neither path may read, carry or cite the other's. A conversation that
// borrowed an attempt's audit would claim enforcement for a run it did not do.
func TestTheTwoLaunchMarkersStayOnTheirOwnPaths(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{}
	f.turn.Sandbox = fake
	f.turn.Egress = &fakeEgressAudit{}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	var attempt, turn bool
	for _, kv := range fake.lastSpec().AdapterEnv {
		switch {
		case kv == egressMarker(fakeAttemptID):
			attempt = true
		case strings.HasPrefix(kv, egressTurnMarkerEnv+"="):
			turn = true
		}
	}
	if !attempt {
		t.Errorf("the agent.acp launch carries no %q: its own egress audit is unfindable", egressMarker(fakeAttemptID))
	}
	if turn {
		t.Errorf("the agent.acp launch carries a %s= marker: only the conversation path may attribute by turn", egressTurnMarkerEnv)
	}
}
