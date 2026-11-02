package postgres

// ADR-0072 § 5's other half, proven where the answer lands: the follow-up
// prompt the asked chat's FinishTurn queues on the ASKING chat must become
// real claimable work — same turn machine as a human prompt, stamped with the
// asking chat's profile per ADR-0068 § 1, and pinned (like every other turn of
// a conversation with a live session) to the worker that holds that session,
// because that is the worker whose workspace and branch the asking chat's
// transcript is talking about.
//
// Design review round 4 read the 3d leg's minutes of silence as this turn never
// starting. On the lab it started 1.8 s after the answer (the pass's journal:
// mail.answered 19:55:35.719 → turn.started 19:55:37.522) and the delay was an
// unanswered `ask` prompt eating the whole PermissionTTL — ADR-0072 § 11 and
// internal/worker/turns_unattended_ask_test.go own that. What this file owns is
// the claim half: nothing about the mail arm may leave the asking chat with a
// turn no worker can take.

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// amAnsweredFollowup drives one full ask→answer cycle and returns the facts of
// the asking chat's queued follow-up turn.
func amAnsweredFollowup(t *testing.T, f *cnvFixture) (askingChat, linkID, followupTurn, followupPrompt string) {
	t.Helper()
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)
	st := amStore(f)

	chatA := amChat(t, f, f.alice, "search chat", "how is search wired?", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)
	results, err := st.DispatchMail(f.ctx(), claimA, []worker.MailAsk{{Repo: "api", Question: "where is search wired?"}})
	if err != nil || results[0].State != events.MailStateAsked {
		t.Fatalf("DispatchMail: %+v err=%v", results, err)
	}
	if err := st.FinishTurn(f.ctx(), claimA, worker.TurnOutcome{
		Status: events.TurnStatusCompleted, StopReason: "end_turn",
	}); err != nil {
		t.Fatalf("FinishTurn asking: %v", err)
	}

	var toConv, targetTurn string
	f.queryRow(t, `
		SELECT l.to_conversation_id::text, t.id::text
		FROM conversation_links l
		JOIN conversation_turns t ON t.mail_link_id = l.id
		WHERE l.id = $1::uuid`, results[0].LinkID).into(t, &toConv, &targetTurn)

	claimT := amClaimExact(t, f, targetTurn)
	if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
		Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.worker,
		Payload: events.MessageAgentPayload{ConversationID: toConv, TurnID: targetTurn, ChunkSeq: 1, Text: "the endpoint lives in handlers/search.go", Final: true},
	}); err != nil {
		t.Fatalf("AppendTurnEvent: %v", err)
	}
	if err := st.FinishTurn(f.ctx(), claimT, worker.TurnOutcome{
		Status: events.TurnStatusCompleted, StopReason: "end_turn",
	}); err != nil {
		t.Fatalf("FinishTurn target: %v", err)
	}

	f.queryRow(t, `
		SELECT id::text, prompt FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status = 'queued' AND id <> $2::uuid`,
		chatA.ID, claimA.TurnID).into(t, &followupTurn, &followupPrompt)
	return chatA.ID, results[0].LinkID, followupTurn, followupPrompt
}

// The follow-up prompt is a turn like any other: it is stamped at enqueue
// (ADR-0068 § 1 — every writer stamps), it carries the asking chat's profile
// and launcher on the claim, and a worker takes it.
func TestAgentMailFollowUpTurnClaimsLikeATurn(t *testing.T) {
	f := cnvSetup(t)
	askingChat, _, followupTurn, prompt := amAnsweredFollowup(t, f)
	if !strings.Contains(prompt, "the agent in the repository “api” answered") ||
		!strings.Contains(prompt, "handlers/search.go") {
		t.Fatalf("follow-up prompt = %q, want the answer delivered as the asking chat's prompt", prompt)
	}

	// The notice runs on the asking chat's own agent, and the row says so at
	// enqueue: the profile of the follow-up turn is the asking chat's pointer,
	// never the asked chat's and never a default.
	var stamped, chatProfile string
	f.queryRow(t, `SELECT COALESCE(agent_profile_id::text, '') FROM conversation_turns WHERE id = $1::uuid`,
		followupTurn).into(t, &stamped)
	f.queryRow(t, `SELECT agent_profile_id::text FROM conversations WHERE id = $1::uuid`, askingChat).
		into(t, &chatProfile)
	if stamped != chatProfile {
		t.Fatalf("follow-up turn stamped %q, want the asking chat's profile %q (ADR-0068 § 1: every turn "+
			"writer stamps, so a switch between the answer and the claim cannot move whose turn this was)", stamped, chatProfile)
	}

	st := amStore(f)
	claim, ok, err := st.ClaimTurn(f.ctx(), f.worker)
	if err != nil || !ok {
		t.Fatalf("the asking chat's follow-up turn was not claimable: ok=%v err=%v", ok, err)
	}
	if claim.TurnID != followupTurn || claim.ConversationID != askingChat {
		t.Fatalf("claim = %+v, want the follow-up turn %s of %s", claim, followupTurn, askingChat)
	}
	if claim.AgentProfileID != chatProfile {
		t.Fatalf("claim profile = %q, want %q", claim.AgentProfileID, chatProfile)
	}
	if claim.LauncherID == "" || claim.PermissionMode == "" {
		t.Fatalf("claim axes = launcher %q mode %q", claim.LauncherID, claim.PermissionMode)
	}
	// The asking chat is the FROM end of the link, so it keeps its own mail
	// rights (depth 1 refuses only a chat that is somebody's target).
	if !claim.MailAllowed {
		t.Errorf("the asking chat's follow-up claim is not mail-eligible; depth 1 binds the TARGET, not the asker")
	}
}

// ADR-0016 § 3's affinity is what makes ADR-0068's "same workspace and branch"
// true rather than aspirational: while a conversation has a live session, only
// the worker holding it may take its next turn. The follow-up prompt is that
// next turn, so a conversation whose session lives on another worker must not
// be handed to this one — and must be taken the moment the session's worker
// asks for it.
func TestAgentMailFollowUpTurnPinnedToTheAskingChatsWorker(t *testing.T) {
	f := cnvSetup(t)
	askingChat, _, followupTurn, _ := amAnsweredFollowup(t, f)
	other := amOtherWorker(t, f)
	f.cnvAttachBinding(t, askingChat, other, "acp-held-elsewhere", "")

	st := amStore(f)
	if _, ok, err := st.ClaimTurn(f.ctx(), f.worker); err != nil || ok {
		t.Fatalf("a turn whose session is live on another worker was claimed here (ok=%v err=%v)", ok, err)
	}
	claim, ok, err := st.ClaimTurn(f.ctx(), other)
	if err != nil || !ok {
		t.Fatalf("the session's own worker could not claim the follow-up turn: ok=%v err=%v", ok, err)
	}
	if claim.TurnID != followupTurn {
		t.Fatalf("claimed %s, want the follow-up turn %s", claim.TurnID, followupTurn)
	}
}

// amOtherWorker registers a second live worker and removes it with the test.
func amOtherWorker(t *testing.T, f *cnvFixture) string {
	t.Helper()
	name := "cnv-other-" + t.Name() + "-" + strings.TrimSuffix(time.Now().Format("150405.000000"), ".")
	var id string
	f.queryRow(t, `
		INSERT INTO workers (name, hostname, version, status, last_heartbeat_at)
		VALUES ($1, 'lab', 'dev', 'online', now())
		RETURNING id::text`, name).into(t, &id)
	t.Cleanup(func() {
		bg := context.Background()
		// A claimed turn out-references the worker (ADR-0016 § 3 keeps the
		// lease owner on the row), so the reference goes before the row.
		// The lease triple is one fact (conversation_turns' CHECK): a row keeps
		// its worker, token and deadline together or gives all three up.
		if _, err := f.pool.Exec(bg, `
			UPDATE conversation_turns
			SET status = 'queued', worker_id = NULL, fencing_token = 0, lease_expires_at = NULL
			WHERE worker_id = $1::uuid`, id); err != nil {
			t.Errorf("release turns held by worker %s: %v", id, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM acp_session_bindings WHERE worker_id = $1::uuid`, id); err != nil {
			t.Errorf("delete bindings of worker %s: %v", id, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workers WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("delete worker %s: %v", id, err)
		}
	})
	return id
}
