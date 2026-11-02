package worker_test

// ADR-0068's loop-side contract, tested where the live-session bookkeeping
// lives: after the controller switches the conversation's agent profile
// between turns, the NEXT claim must not ride the old profile's live process
// and must not be offered the old profile's session for resume — it launches
// a NEW ACP session, in the same prepared workspace, honestly closing the old
// binding first (agent.session.disconnected{replaced-by-switch} rides the
// CloseBinding return). Same-profile reuse (continue_live) is unchanged and
// stays covered by the loop's existing tests.

import (
	"context"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

func TestProfileSwitchReplacesLiveSession(t *testing.T) {
	st := newFakeStore()
	c1 := testClaim()
	c1.AgentProfileID = "profile-a"
	c2 := testClaim()
	c2.TurnID = "turn-2"
	c2.AgentProfileID = "profile-b"
	st.claims = []worker.Claim{c1, c2}
	// The resume offer exists only for profile-a (the fake answers like the
	// real store's binding filter, proven in internal/store/postgres).
	st.resumableOK = true
	st.resumableFor = "profile-a"
	st.resumable = domain.SessionInfo{ACPSessionID: "acp-old", Origin: events.SessionOriginResumed}

	immediate := func(context.Context, *fakeSession) (domain.StopReason, error) {
		return domain.StopEndTurn, nil
	}
	s1 := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-1", Origin: events.SessionOriginNew, LauncherID: "claude"})
	s1.promptFn = immediate
	s2 := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-2", Origin: events.SessionOriginNew, LauncherID: "claude"})
	s2.promptFn = immediate
	ff := &fakeFactory{sessions: []*fakeSession{s1, s2}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)

	// Both turns complete: turn 1 on profile-a, turn 2 on profile-b.
	recv(t, st.begun, "BeginTurn turn-1")
	recv(t, st.begun, "BeginTurn turn-2")
	recv(t, st.finishing, "FinishTurn turn-1")
	recv(t, st.finishing, "FinishTurn turn-2")

	if ff.count() != 2 {
		t.Fatalf("launches = %d, want 2 (the switch must launch a NEW session per the ADR)", ff.count())
	}
	// Turn 1 rode the resume the old profile's binding offered…
	if got := ff.request(0).LoadSessionID; got != "acp-old" {
		t.Errorf("turn-1 load_session_id = %q, want acp-old (same-profile resume still offered)", got)
	}
	// …turn 2 got none: session/load belongs to the harness that made the
	// session, and the new profile must start fresh.
	if got := ff.request(1).LoadSessionID; got != "" {
		t.Errorf("turn-2 load_session_id = %q, want empty across the switch", got)
	}
	// The old profile's process was closed honestly, with the switch named.
	if !s1.closed.Load() {
		t.Errorf("profile switch kept the old profile's process alive")
	}
	bind := recv(t, st.closedBinds, "CloseBinding on the switch")
	if bind.reason != "agent_switched" || bind.conversation != "conv-1" {
		t.Errorf("closed binding = %+v, want conv-1 closed as agent_switched", bind)
	}
	// Same workspace/branch: both launches prepared the same work dir.
	if ff.requests[1].WorkDir != ff.requests[0].WorkDir || ff.requests[1].WorkDir == "" {
		t.Errorf("turn-2 work dir = %q, want the SAME non-empty workspace as turn-1 (%q) — the branch carries over",
			ff.requests[1].WorkDir, ff.requests[0].WorkDir)
	}
	// The status beats are honest: active (turn 1), idle (the switch closed
	// the session), active again (the new profile's session).
	if got := recvStatus(t, st.convStatus, "active", "turn-1 active"); got != "active" {
		t.Errorf("first status beat = %q", got)
	}
	recvStatus(t, st.convStatus, "idle", "conversation idle after the switch")
	recvStatus(t, st.convStatus, "active", "conversation active on the new profile")
}
