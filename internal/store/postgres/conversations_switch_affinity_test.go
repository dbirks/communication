package postgres

// ADR-0068's carry-over, proven where it is actually decided: not in the
// worker's workspace code but in the claim. The switched turn "runs on the new
// agent in the SAME workspace and branch" (Decision 3) only because ADR-0016
// § 3's affinity keeps a conversation's turns on the worker holding its live
// session — and a switch does not release that affinity, because the old
// binding is closed inside the new session's path, after the claim is already
// won.
//
// If that ever stops being true, the next turn of a switched chat does not
// carry over anything: it lands on a worker whose mirror has never seen the
// conversation's branch and re-prepares from scratch. Design review round 4
// read the 2e failure as exactly that (see
// docs/adr/ADR-0068-per-turn-agent-profile.md, "The 2e lab pass"); it was not,
// and this is the assertion that keeps it from becoming true.

import (
	"testing"
)

func TestSwitchedTurnClaimsOnTheWorkspaceOwner(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "gpt-5")
	ctx := testCtx(t)
	st := amStore(f)

	chat := f.cnvCreate(t, f.alice, "cnv-switch affinity", "first turn")
	first, ok, err := st.ClaimTurn(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("ClaimTurn first: ok=%v err=%v", ok, err)
	}
	// The turn ran and the worker holds its live session: this is the state a
	// controller switches away from.
	f.cnvAttachBinding(t, chat.ID, f.worker, "acp-on-worker-a", "")
	cnvFinishTurn(t, f, first.TurnID)

	if _, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID); err != nil {
		t.Fatalf("SwitchAgent: %v", err)
	}
	if _, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "second turn on codex"); err != nil {
		t.Fatalf("PostMessage: %v", err)
	}

	other := amOtherWorker(t, f)
	if claim, ok, err := st.ClaimTurn(ctx, other); err != nil || ok {
		t.Fatalf("a switched turn was claimed by a worker with no session for the chat: claim=%+v ok=%v err=%v",
			claim, ok, err)
	}

	claim, ok, err := st.ClaimTurn(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("the session's own worker could not claim the switched turn: ok=%v err=%v", ok, err)
	}
	if claim.ConversationID != chat.ID {
		t.Fatalf("claim conversation = %q, want %q", claim.ConversationID, chat.ID)
	}
	if claim.AgentProfileID != codex.ID || claim.LauncherID != "codex" {
		t.Fatalf("switched claim = profile %q launcher %q, want %q/codex (the same worker, the new agent)",
			claim.AgentProfileID, claim.LauncherID, codex.ID)
	}
}
