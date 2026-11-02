package worker_test

// The journal sentence for a launcher that will not sign in, proven where the
// sentence is written: the turn loop's own failure path. Design review round 4
// caught a switched Codex turn (ADR-0068) being reported as a workspace/git
// failure; the worker's half of the fix is that `conversation.turn.failed`
// names the harness that refused. worker.describeLaunchFailure is asserted
// directly in launchfailure_internal_test.go; this is the wiring.

import (
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

func TestTurnFailsHonestlyWhenTheLauncherWillNotSignIn(t *testing.T) {
	st := newFakeStore()
	c := testClaim()
	c.LauncherID = "codex"
	st.claims = []worker.Claim{c}
	ff := &fakeFactory{err: errors.New(
		`acp: session/new: {"code":-32000,"message":"Authentication required"}`)}
	cfg := fastCfg()
	// Codex has a verified prompting mode (docs/compatibility/ACP.md), so an
	// `ask` turn on it reaches the launch — the refusal the lab saw came from
	// the harness, not from the mode gate.
	cfg.AskModeID = func(id string) string {
		if id == "claude" || id == "codex" {
			return "default"
		}
		return ""
	}
	l := newLoop(t, cfg, st, ff)
	startLoop(t, l)

	out := recv(t, st.finishing, "finish")
	if out.Status != events.TurnStatusFailed {
		t.Fatalf("outcome = %+v, want a failed turn", out)
	}
	if !strings.Contains(out.Message, `launcher "codex" is not signed in`) {
		t.Fatalf("failure message = %q, want it to name the launcher that refused to sign in", out.Message)
	}
	// The phrase that made the chat blame the repository: no failure copy that
	// quotes it can be read as anything but a sign-in problem by a reader who
	// has no git on the page.
	if strings.Contains(strings.ToLower(out.Message), "authentication required") {
		t.Fatalf("the turn repeated the adapter's git-shaped phrase: %q", out.Message)
	}
	if ff.count() != 1 {
		t.Fatalf("launches = %d, want the one refused attempt", ff.count())
	}
}
