package postgres

// ADR-0072 (docs/adr/ADR-0072-agent-mail.md): agent mail across repos,
// against a real PostgreSQL. What is proven here is the gating and the
// ledger, not a live ACP session: the setting must be ON and re-checked at
// dispatch; the asker must still be a member; the target turn must arrive
// read-only (permission_override 'ask' outranks the profile's mode); depth 1
// (a mailed chat is never mail-eligible); the per-chat cap bites; the answer
// settles the link and queues the asking chat's follow-up in the same
// transaction the target turn went terminal in; a failed target fails the
// link; and the reconciler expires an answer that never came.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// amRepo attaches a repository to the fixture project. The cleanup is
// registered AFTER cnvSetup's, so it runs BEFORE it (LIFO): repositories is
// out-referenced by conversations born bound to it.
func amRepo(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file:///srv/' || $2, 'main', $3::uuid) RETURNING id::text`,
		f.project, name, f.alice).into(t, &id)
	t.Cleanup(func() {
		bg := context.Background()
		// Conversations born bound to this repository out-reference it (the
		// ADR-0067 composite FK); unbind first, then the row can go. The
		// fixture's own conversation cleanup runs after this (LIFO).
		if _, err := f.pool.Exec(bg, `UPDATE conversations SET repository_id = NULL WHERE repository_id = $1::uuid`, id); err != nil {
			t.Errorf("unbind conversations from repository %s: %v", name, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM repositories WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup repository %s: %v", name, err)
		}
	})
	return id
}

// amStore is the worker-facing TurnStore; per-test knobs default to prod.
func amStore(f *cnvFixture) *TurnStore {
	return &TurnStore{Pool: f.pool}
}

// amChat starts a conversation and returns it (with its first turn).
func amChat(t *testing.T, f *cnvFixture, user, title, prompt, repo string) CnvConversation {
	t.Helper()
	cv, err := f.store.CreateConversation(f.ctx(), f.caller(user), f.project, f.profile, title, prompt, repo)
	if err != nil {
		t.Fatalf("CreateConversation(%q): %v", title, err)
	}
	return cv
}

// amClaimExact fences a named turn onto the fixture worker regardless of
// what else sits in the queue (the FIFO claim would take older turns from
// other conversations first).
func amClaimExact(t *testing.T, f *cnvFixture, turnID string) worker.Claim {
	t.Helper()
	token := f.cnvClaim(t, turnID, f.worker, time.Minute)
	var c worker.Claim
	c.TurnID = turnID
	c.WorkerID = f.worker
	c.FencingToken = token
	f.queryRow(t, `
		SELECT t.conversation_id::text, c.project_id::text, p.organization_id::text
		FROM conversation_turns t
		JOIN conversations c ON c.id = t.conversation_id
		JOIN projects p ON p.id = c.project_id
		WHERE t.id = $1::uuid`, turnID).into(t, &c.ConversationID, &c.ProjectID, &c.OrganizationID)
	return c
}

// amClaim wins f's queued turn on the fixture worker.
func amClaim(t *testing.T, f *cnvFixture, wantTurn string) worker.Claim {
	t.Helper()
	st := amStore(f)
	claim, ok, err := st.ClaimTurn(f.ctx(), f.worker)
	if err != nil || !ok {
		t.Fatalf("ClaimTurn: ok=%v err=%v", ok, err)
	}
	if claim.TurnID != wantTurn {
		t.Fatalf("claimed turn %s, want %s", claim.TurnID, wantTurn)
	}
	return claim
}

func amSetEnabled(t *testing.T, f *cnvFixture, enabled bool) {
	t.Helper()
	f.exec(t, `UPDATE projects SET agent_mail_enabled = $2 WHERE id = $1::uuid`, f.project, enabled)
}

func amLinkState(t *testing.T, f *cnvFixture, linkID string) (state, answer, reason string) {
	t.Helper()
	f.queryRow(t, `
		SELECT state, COALESCE(answer, ''), COALESCE(reason, '') FROM conversation_links WHERE id = $1::uuid`,
		linkID).into(t, &state, &answer, &reason)
	return
}

func amEventCount(t *testing.T, f *cnvFixture, conversationID, typ string) int {
	t.Helper()
	var n int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events WHERE conversation_id = $1::uuid AND type = $2`,
		conversationID, typ).into(t, &n)
	return n
}

// TestAgentMailDispatchGateAndReadonly: the setting gates dispatch, the ask
// produces a linked chat in the target repo whose answer turn arrives
// read-only even under a preapproved profile, depth 1 keeps the mailed chat
// itself never mail-eligible, and a non-member's ask is rejected.
func TestAgentMailDispatchGateAndReadonly(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")

	// Off by default: a project created by the fixture has the setting false.
	var enabled bool
	f.queryRow(t, `SELECT agent_mail_enabled FROM projects WHERE id = $1::uuid`, f.project).into(t, &enabled)
	if enabled {
		t.Fatalf("agent_mail_enabled defaults true; want false")
	}

	chatA := amChat(t, f, f.alice, "web search chat", "how is search wired?", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)

	// A mail-eligible turn of a normal chat in an enabled project reads
	// MailAllowed; while the setting is off it must not.
	if claimA.MailAllowed {
		t.Fatalf("mail allowed while the project setting is off")
	}
	amSetEnabled(t, f, true)
	f.exec(t, `UPDATE conversation_turns SET status = 'queued', worker_id = NULL, fencing_token = 0, lease_expires_at = NULL, started_at = NULL WHERE id = $1::uuid`, claimA.TurnID)
	claimA = amClaim(t, f, chatA.ActiveTurn.ID)
	if !claimA.MailAllowed {
		t.Fatalf("mail not allowed for a normal chat of a mail-enabled project")
	}
	// ClaimTurn resolves permission_override first; nothing set yet.
	if claimA.PermissionMode != "ask" {
		t.Fatalf("claim permission mode = %q, want the profile's ask", claimA.PermissionMode)
	}

	st := amStore(f)
	// The unknown repo is rejected; the known one is asked.
	results, err := st.DispatchMail(f.ctx(), claimA, []worker.MailAsk{
		{Repo: "nope", Question: "is there a daemon?"},
		{Repo: "api", Question: "where is search wired?"},
	})
	if err != nil {
		t.Fatalf("DispatchMail: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	if results[0].State != events.MailStateRejected || results[0].LinkID != "" {
		t.Errorf("unknown repo result = %+v, want rejected without a link", results[0])
	}
	if results[1].State != events.MailStateAsked || results[1].LinkID == "" {
		t.Fatalf("known repo result = %+v, want asked with a link", results[1])
	}
	linkID := results[1].LinkID

	// The linked chat: born in the target repo, controller none, and its
	// answer turn queued READ-ONLY under the ask override even after the
	// profile's own mode is raised to preapproved_within_sandbox.
	var (
		toConv, toRepo, control string
		targetTurn              string
	)
	f.queryRow(t, `
		SELECT l.to_conversation_id::text, r.name, cc.controller_kind
		FROM conversation_links l
		JOIN conversations c ON c.id = l.to_conversation_id
		JOIN repositories r ON r.id = c.repository_id
		JOIN conversation_control cc ON cc.conversation_id = c.id
		WHERE l.id = $1::uuid AND l.state = 'asked'`, linkID).into(t, &toConv, &toRepo, &control)
	if toRepo != "api" || control != "none" {
		t.Fatalf("target chat repo=%q controller=%q, want api/none", toRepo, control)
	}
	f.queryRow(t, `
		SELECT id::text FROM conversation_turns WHERE conversation_id = $1::uuid AND status = 'queued'`,
		toConv).into(t, &targetTurn)
	f.exec(t, `UPDATE agent_profiles SET permission_mode = 'preapproved_within_sandbox' WHERE id = $1::uuid`, f.profile)
	t.Cleanup(func() {
		f.pool.Exec(context.Background(), `UPDATE agent_profiles SET permission_mode = 'ask' WHERE id = $1::uuid`, f.profile)
	})
	if _, err := f.pool.Exec(f.ctx(), `
		UPDATE conversation_turns SET status = 'queued', worker_id = NULL, fencing_token = 0, lease_expires_at = NULL
		WHERE id = $1::uuid AND status = 'queued'`, targetTurn); err != nil {
		t.Fatalf("requeue target turn: %v", err)
	}
	claimT := amClaim(t, f, targetTurn)
	if claimT.PermissionMode != "ask" {
		t.Errorf("target turn permission mode = %q, want the read-only ask override", claimT.PermissionMode)
	}
	// Depth 1: neither the asking turn re-read... (it is gone) — the mailed
	// chat and every later turn of it are never mail-eligible.
	if claimT.MailAllowed {
		t.Errorf("the target answer turn is mail-eligible; depth 1 is broken")
	}

	// Journal facts: asked on the asking chat only; rejected asks journalled.
	if n := amEventCount(t, f, claimA.ConversationID, events.TypeConversationMailAsked); n != 2 {
		t.Errorf("asking chat mail.asked rows = %d, want 2 (asked + rejected)", n)
	}

	// A second claim of the same target (race-free marker): exactly one
	// link's answering turn exists.
	var answerTurns int
	f.queryRow(t, `SELECT count(*) FROM conversation_turns WHERE mail_link_id = $1::uuid`, linkID).into(t, &answerTurns)
	if answerTurns != 1 {
		t.Fatalf("answer turns for the link = %d, want 1", answerTurns)
	}

	// Membership is re-checked at dispatch: drop alice from the project and
	// the same ask is rejected without a link.
	f.exec(t, `DELETE FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`, f.project, f.alice)
	t.Cleanup(func() {
		f.pool.Exec(context.Background(), `
			INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'maintainer')
			ON CONFLICT DO NOTHING`, f.project, f.alice)
	})
	before := 0
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &before)
	results, err = st.DispatchMail(f.ctx(), claimA, []worker.MailAsk{{Repo: "web", Question: "again?"}})
	if err != nil {
		t.Fatalf("DispatchMail after membership loss: %v", err)
	}
	after := 0
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &after)
	if results[0].State != events.MailStateRejected || after != before {
		t.Errorf("non-member ask: results=%+v links %d→%d, want rejected with no new link", results[0], before, after)
	}
}

// TestAgentMailAnswerAndFollowup: the target turn's completion settles the
// link, journals the answer on BOTH chats, and queues the asking chat's
// follow-up — all inside the FinishTurn transaction.
func TestAgentMailAnswerAndFollowup(t *testing.T) {
	f := cnvSetup(t)
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
	linkID := results[0].LinkID
	var toConv, targetTurn string
	f.queryRow(t, `
		SELECT l.to_conversation_id::text, t.id::text
		FROM conversation_links l
		JOIN conversation_turns t ON t.mail_link_id = l.id
		WHERE l.id = $1::uuid`, linkID).into(t, &toConv, &targetTurn)

	// The asking turn finishes as any turn does (the loop dispatches before
	// the terminal write; the notice arm needs this conversation free).
	if err := st.FinishTurn(f.ctx(), claimA, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn asking: %v", err)
	}

	claimT := amClaim(t, f, targetTurn)
	for i, chunk := range []string{"handlers/search.go ", "wires the endpoint."} {
		if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
			Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.worker,
			Payload: events.MessageAgentPayload{ConversationID: toConv, TurnID: targetTurn, ChunkSeq: i + 1, Text: chunk, Final: i == 1},
		}); err != nil {
			t.Fatalf("AppendTurnEvent: %v", err)
		}
	}
	if err := st.FinishTurn(f.ctx(), claimT, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn target: %v", err)
	}

	state, answer, reason := amLinkState(t, f, linkID)
	if state != events.MailStateAnswered || answer != "handlers/search.go wires the endpoint." || reason != "" {
		t.Fatalf("link after answer: state=%q answer=%q reason=%q", state, answer, reason)
	}
	for _, conv := range []string{chatA.ID, toConv} {
		if n := amEventCount(t, f, conv, events.TypeConversationMailAnswered); n != 1 {
			t.Errorf("conversation %s mail.answered rows = %d, want 1", conv, n)
		}
	}
	// The follow-up prompt queued on the asking chat names the answer.
	var followup string
	f.queryRow(t, `
		SELECT prompt FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status = 'queued' AND id <> $2`,
		chatA.ID, chatA.ActiveTurn.ID).into(t, &followup)
	if followup == "" || !strings.Contains(followup, "the agent in the repository “api” answered") || !strings.Contains(followup, "handlers/search.go") {
		t.Errorf("asking chat follow-up prompt = %q, want it to deliver the answer", followup)
	}
}

// TestAgentMailFailureAndCapAndExpiry: a failed target fails the link; the
// per-chat cap bites; the reconciler expires an unanswered ask and notices
// the asking chat.
func TestAgentMailFailureAndCapAndExpiry(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)
	st0 := amStore(f)

	chatA := amChat(t, f, f.alice, "capped chat", "fan out", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)
	// The asking turn is terminal before the answers start arriving: that is
	// the live order (the loop finishes the turn, the answer comes later), and
	// it is what lets the expiry notice find the asking chat idle.
	if err := st0.FinishTurn(f.ctx(), claimA, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn asking: %v", err)
	}

	// Cap of 2 on this store: the third ask is rejected, with the cap reason.
	st := &TurnStore{Pool: f.pool, MailCap: 2}
	results, err := st.DispatchMail(f.ctx(), claimA, []worker.MailAsk{
		{Repo: "api", Question: "q1"}, {Repo: "api", Question: "q2"}, {Repo: "api", Question: "q3"},
	})
	if err != nil {
		t.Fatalf("DispatchMail(cap): %v", err)
	}
	if results[2].State != events.MailStateRejected || !strings.Contains(results[2].Reason, "mails") {
		t.Errorf("third ask under a cap of 2 = %+v, want rejected with the cap reason", results[2])
	}

	// The second link's target fails: the link fails with the reason, no
	// answer, and mail.answered(failed) lands on both chats.
	var failedLink, failedTurn string
	f.queryRow(t, `
		SELECT l.id::text, t.id::text
		FROM conversation_links l
		JOIN conversation_turns t ON t.mail_link_id = l.id
		WHERE l.from_conversation_id = $1::uuid
		ORDER BY l.created_at, l.id LIMIT 1`, chatA.ID).
		into(t, &failedLink, &failedTurn)
	claimF := amClaim(t, f, failedTurn)
	if err := st.FinishTurn(f.ctx(), claimF, worker.TurnOutcome{
		Status: events.TurnStatusFailed, Message: "launcher exploded",
	}); err != nil {
		t.Fatalf("FinishTurn(failed): %v", err)
	}
	state, answer, reason := amLinkState(t, f, failedLink)
	if state != events.MailStateFailed || answer != "" || !strings.Contains(reason, "launcher exploded") {
		t.Fatalf("failed link: state=%q answer=%q reason=%q", state, answer, reason)
	}
	if n := amEventCount(t, f, chatA.ID, events.TypeConversationMailAnswered); n != 1 {
		t.Errorf("asking chat mail.answered after failure = %d, want 1", n)
	}

	// The failure also noticed the asking chat (a queued follow-up naming
	// the failure). Consume it so the chat is idle for the expiry arm — the
	// one-active-turn rule deliberately keeps the second notice from
	// stacking behind the first.
	var failNotice string
	f.queryRow(t, `
		SELECT id::text FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status = 'queued' AND prompt LIKE '%did not get an answer%'`,
		chatA.ID).into(t, &failNotice)
	claimNotice := amClaimExact(t, f, failNotice)
	if err := st.FinishTurn(f.ctx(), claimNotice, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn(failure notice): %v", err)
	}

	// The remaining link is still `asked`; expire it through a past deadline.
	var openLink string
	f.queryRow(t, `
		SELECT id::text FROM conversation_links WHERE from_conversation_id = $1::uuid AND state = 'asked'
		ORDER BY created_at DESC, id DESC LIMIT 1`, chatA.ID).into(t, &openLink)
	f.exec(t, `UPDATE conversation_links SET answer_deadline = now() - interval '1 second' WHERE id = $1::uuid`, openLink)
	rec := NewReconciler(f.pool, ReconcilerConfig{})
	res, err := rec.Pass(f.ctx())
	if err != nil {
		t.Fatalf("reconciler Pass: %v", err)
	}
	if res.MailLinksExpired < 1 {
		t.Fatalf("MailLinksExpired = %d, want >= 1", res.MailLinksExpired)
	}
	state, _, reason = amLinkState(t, f, openLink)
	if state != events.MailStateExpired || reason == "" {
		t.Fatalf("expired link: state=%q reason=%q", state, reason)
	}
	if n := amEventCount(t, f, chatA.ID, events.TypeConversationMailAnswered); n != 2 {
		t.Errorf("asking chat mail.answered after expiry = %d, want 2", n)
	}
	var notices int
	f.queryRow(t, `
		SELECT count(*) FROM conversation_turns
		WHERE conversation_id = $1::uuid AND prompt LIKE '%timed out%'`, chatA.ID).into(t, &notices)
	if notices != 1 {
		t.Errorf("timeout notices on the asking chat = %d, want 1", notices)
	}
}

// TestAgentMailDetailReadLinks: the conversation detail carries linked chats
// in both directions with the link's state.
func TestAgentMailDetailReadLinks(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)

	chatA := amChat(t, f, f.alice, "asking side", "go", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)
	// Finish the asking turn so the asking chat can carry the follow-up later.
	if err := amStore(f).FinishTurn(f.ctx(), claimA, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn: %v", err)
	}
	results, err := amStore(f).DispatchMail(f.ctx(), claimA, []worker.MailAsk{{Repo: "api", Question: "routes?"}})
	if err != nil || results[0].State != events.MailStateAsked {
		t.Fatalf("DispatchMail: %+v err=%v", results, err)
	}
	var toConv string
	f.queryRow(t, `SELECT to_conversation_id::text FROM conversation_links WHERE id = $1::uuid`,
		results[0].LinkID).into(t, &toConv)

	from, err := f.store.GetConversation(f.ctx(), f.caller(f.alice), chatA.ID)
	if err != nil {
		t.Fatalf("GetConversation asking side: %v", err)
	}
	if len(from.LinkedChats) != 1 {
		t.Fatalf("asking side linked chats = %d, want 1", len(from.LinkedChats))
	}
	lc := from.LinkedChats[0]
	if lc.Direction != "outgoing" || lc.RepoName != "api" || lc.State != events.MailStateAsked || lc.OtherConvID != toConv {
		t.Errorf("asking side link = %+v, want outgoing/api/asked/%s", lc, toConv)
	}
	to, err := f.store.GetConversation(f.ctx(), f.caller(f.alice), toConv)
	if err != nil {
		t.Fatalf("GetConversation target side: %v", err)
	}
	if len(to.LinkedChats) != 1 || to.LinkedChats[0].Direction != "incoming" {
		t.Fatalf("target side links = %+v, want one incoming", to.LinkedChats)
	}
}

// TestAgentMailStaleWorkerDispatchRefused: a fenced port rejects a stale
// triple without writing — the same fail-closed rule as every other turn
// write (ADR-0016 §9 obligation 2).
func TestAgentMailStaleWorkerDispatchRefused(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)

	chatA := amChat(t, f, f.alice, "stale ask", "go", "web")
	claimA := amClaim(t, f, chatA.ActiveTurn.ID)
	// Raise the fencing token as a takeover would; the old triple must now
	// write nothing.
	f.exec(t, `
		UPDATE conversation_turns SET fencing_token = fencing_token + 1, status = 'running'
		WHERE id = $1::uuid`, claimA.TurnID)
	stale := claimA
	stale.FencingToken = claimA.FencingToken // last-known triple
	before := 0
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &before)
	if _, err := amStore(f).DispatchMail(f.ctx(), stale, []worker.MailAsk{{Repo: "api", Question: "?"}}); err == nil {
		t.Fatalf("DispatchMail with a stale triple: want ErrLeaseLost")
	}
	after := 0
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &after)
	if after != before {
		t.Errorf("stale dispatch created links: %d -> %d", before, after)
	}
}

// TestAgentMailComposerAsk (ADR-0072 § 9): the composer @-ask arm. The
// setting gates it (off is a refusal that writes nothing); a repository the
// project does not have is refused as a bad name, not a rejection journalled
// on faith; a non-controller is denied on identity; the accepted ask builds
// the SAME facts the worker's dispatch builds — a fresh chat bound to the
// target repo, controller none, the answer turn stamped read-only — with
// from_turn_id/turn_id empty (a person asked, not a turn) and the human as
// the journal actor. The answer then settles the link through the § 5 arm
// unchanged, and the follow-up prompt lands on the asking chat.
func TestAgentMailComposerAsk(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")

	chatA := amChat(t, f, f.alice, "composer chat", "", "web")

	// Off by default: the ask is denied and nothing is written.
	if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatA.ID, "api", "what is in here?"); !errors.Is(err, ErrConversationForbidden) {
		t.Fatalf("composer ask with the setting off: err=%v, want ErrConversationForbidden", err)
	}
	var links int
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &links)
	if links != 0 {
		t.Fatalf("mail-off ask created %d links", links)
	}

	amSetEnabled(t, f, true)

	// A repository outside the project is the bad-name refusal (400 arm),
	// not a journalled rejected ask: nothing about the project leaks and
	// nothing is written.
	if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatA.ID, "ghost", "hi?"); !errors.Is(err, ErrConversationBadRequest) {
		t.Fatalf("composer ask to a foreign repo: err=%v, want ErrConversationBadRequest", err)
	}
	// A member who does not hold the controller lock is denied on identity
	// (403, the ADR-0068 switch route's rule), not with a 409 control state.
	if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.bob), chatA.ID, "api", "hi?"); !errors.Is(err, ErrConversationForbidden) {
		t.Fatalf("composer ask without the lock: err=%v, want ErrConversationForbidden", err)
	}
	// A non-member cannot even aim the ask at the chat.
	if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.outsider), chatA.ID, "api", "hi?"); !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("composer ask by an outsider: err=%v, want ErrConversationNotFound", err)
	}
	f.queryRow(t, `SELECT count(*) FROM conversation_links`).into(t, &links)
	if links != 0 {
		t.Fatalf("refused asks created %d links", links)
	}

	ask, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatA.ID, "api", "where is search wired?")
	if err != nil {
		t.Fatalf("AskRepoMail: %v", err)
	}
	if ask.State != events.MailStateAsked || ask.LinkID == "" || ask.ToConversationID == "" {
		t.Fatalf("accepted ask = %+v", ask)
	}

	// The linked chat: born bound to `api`, controller none, and its answer
	// turn queued read-only under the ask override — the same facts § 2/§ 4
	// name, off a person's ask instead of a turn's.
	var (
		toRepo, control, targetTurn, override string
		fromTurn                              *string
		askedBy                               string
	)
	f.queryRow(t, `
		SELECT r.name, cc.controller_kind
		FROM conversations c
		JOIN repositories r ON r.id = c.repository_id
		JOIN conversation_control cc ON cc.conversation_id = c.id
		WHERE c.id = $1::uuid`, ask.ToConversationID).into(t, &toRepo, &control)
	f.queryRow(t, `
		SELECT l.from_turn_id::text, l.asked_by::text
		FROM conversation_links l WHERE l.id = $1::uuid`, ask.LinkID).into(t, &fromTurn, &askedBy)
	f.queryRow(t, `
		SELECT t.id::text, COALESCE(t.permission_override, '')
		FROM conversation_turns t WHERE t.conversation_id = $1::uuid AND t.status = 'queued'`,
		ask.ToConversationID).into(t, &targetTurn, &override)
	if toRepo != "api" || control != "none" {
		t.Fatalf("target chat repo=%q controller=%q, want api/none", toRepo, control)
	}
	if fromTurn != nil {
		t.Errorf("composer link carries from_turn_id=%v; a person asked, no turn did", *fromTurn)
	}
	if askedBy != f.alice {
		t.Errorf("link asked_by = %s, want alice (mail runs on behalf of the caller)", askedBy)
	}
	if override != "ask" {
		t.Errorf("target turn permission_override = %q, want the read-only ask", override)
	}

	// The journal row: asked, on the asking chat, authored by the human,
	// with an EMPTY turn_id (the member stays; the value says no turn asked).
	var (
		actorKind, actorID, turnID, state string
		rows                              int
	)
	f.queryRow(t, `
		SELECT actor_kind, actor_id, payload->>'turn_id', payload->>'state', count(*) OVER ()
		FROM domain_events
		WHERE conversation_id = $1::uuid AND type = $2`,
		chatA.ID, events.TypeConversationMailAsked).into(t, &actorKind, &actorID, &turnID, &state, &rows)
	if rows != 1 {
		t.Fatalf("asking chat mail.asked rows = %d, want 1", rows)
	}
	if actorKind != events.ActorKindHuman || actorID != f.alice {
		t.Errorf("mail.asked actor = %s/%s, want human/alice", actorKind, actorID)
	}
	if turnID != "" || state != events.MailStateAsked {
		t.Errorf("mail.asked turn_id=%q state=%q, want empty/asked", turnID, state)
	}

	// The answer returns the SAME way (§ 5): the target turn completes and
	// the link settles, both chats journal the answer, and the asking chat
	// gets its follow-up prompt — from_turn_id NULL or not.
	st := amStore(f)
	claimT := amClaimExact(t, f, targetTurn)
	if claimT.MailAllowed {
		t.Errorf("the composer target's answer turn is mail-eligible; depth 1 is broken")
	}
	if err := st.AppendTurnEvent(f.ctx(), claimT, worker.TurnEvent{
		Type: events.TypeConversationMessageAgent, ActorKind: events.ActorKindWorker, ActorID: f.worker,
		Payload: events.MessageAgentPayload{ConversationID: ask.ToConversationID, TurnID: targetTurn, ChunkSeq: 1, Text: "handlers/search.go wires it.", Final: true},
	}); err != nil {
		t.Fatalf("AppendTurnEvent: %v", err)
	}
	if err := st.FinishTurn(f.ctx(), claimT, worker.TurnOutcome{Status: events.TurnStatusCompleted, StopReason: "end_turn"}); err != nil {
		t.Fatalf("FinishTurn target: %v", err)
	}
	state, answer, reason := amLinkState(t, f, ask.LinkID)
	if state != events.MailStateAnswered || answer != "handlers/search.go wires it." || reason != "" {
		t.Fatalf("composer link after answer: state=%q answer=%q reason=%q", state, answer, reason)
	}
	var followup string
	f.queryRow(t, `
		SELECT prompt FROM conversation_turns
		WHERE conversation_id = $1::uuid AND status = 'queued'`,
		chatA.ID).into(t, &followup)
	if !strings.Contains(followup, "the agent in the repository “api” answered") {
		t.Errorf("asking chat follow-up = %q, want the answer notice", followup)
	}
}

// TestAgentMailComposerDepthAndCap: the § 5 rules bite the § 9 arm too — a
// person who took over a mailed chat inherits its no-ask rule, and the
// per-chat cap bounds composer asks exactly as it bounds agent asks.
func TestAgentMailComposerDepthAndCap(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)

	// Depth: chat B is some link's target; alice takes control of B (the
	// takeover inherits the rule) and B still cannot ask.
	chatA := amChat(t, f, f.alice, " asker", "", "web")
	askA, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatA.ID, "api", "first?")
	if err != nil {
		t.Fatalf("AskRepoMail: %v", err)
	}
	if _, err := f.store.TakeControl(f.ctx(), f.caller(f.alice), askA.ToConversationID, 1); err != nil {
		t.Fatalf("TakeControl on the mailed chat: %v", err)
	}
	if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), askA.ToConversationID, "web", "re-ask?"); !errors.Is(err, ErrConversationValidation) {
		t.Fatalf("mailed chat asking: err=%v, want ErrConversationValidation (depth 1)", err)
	}

	// Cap: the eighth ask lands, the ninth is refused with the cap sentence.
	chatC := amChat(t, f, f.alice, "capped composer", "", "web")
	for i := 0; i < DefaultMailCap; i++ {
		if _, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatC.ID, "api", fmt.Sprintf("q%d?", i)); err != nil {
			t.Fatalf("ask %d: %v", i, err)
		}
	}
	_, err = f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatC.ID, "api", "one too many?")
	if !errors.Is(err, ErrConversationValidation) || !strings.Contains(err.Error(), fmt.Sprintf("used its %d mails", DefaultMailCap)) {
		t.Fatalf("over-cap ask: err=%v, want the cap refusal", err)
	}

	// An archived asking chat takes no asks (the PostMessage refusal, worn
	// as a conflict).
	f.exec(t, `UPDATE conversations SET status = 'archived' WHERE id = $1::uuid`, chatC.ID)
	_, err = f.store.AskRepoMail(f.ctx(), f.caller(f.alice), chatC.ID, "api", "from the grave?")
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.Kind != ConflictArchived {
		t.Fatalf("archived chat ask: err=%v, want the archived conflict", err)
	}
}

// TestAgentMailComposerAPIAdapter (ADR-0072 § 9): the API adapter arm of the
// composer ask against the real database — the accepted ask surfaces as the
// ConversationMailAsk facts, and the setting-off refusal arrives as the
// api-side forbidden sentinel the handler renders 403 (the sentinel
// translation, not just the store-side error, is what the route answers
// from).
func TestAgentMailComposerAPIAdapter(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "web")
	amRepo(t, f, "api")
	chatA := amChat(t, f, f.alice, "adapter chat", "", "web")
	caller := api.Caller{UserID: f.alice, OrganizationID: f.orgID}
	store := APIConversationStore{S: f.store}

	if _, err := store.AskRepoMail(f.ctx(), caller, chatA.ID, "api", "wired where?"); !errors.Is(err, api.ErrConversationForbidden) {
		t.Fatalf("adapter with the setting off: err=%v, want api.ErrConversationForbidden", err)
	}
	amSetEnabled(t, f, true)
	ask, err := store.AskRepoMail(f.ctx(), caller, chatA.ID, "api", "where is search wired?")
	if err != nil {
		t.Fatalf("adapter AskRepoMail: %v", err)
	}
	if ask.State != events.MailStateAsked || ask.Repo != "api" || ask.Question != "where is search wired?" ||
		ask.LinkID == "" || ask.ToConversationID == "" {
		t.Fatalf("adapter ask = %+v", ask)
	}
	var turnID string
	f.queryRow(t, `
		SELECT payload->>'turn_id' FROM domain_events
		WHERE conversation_id = $1::uuid AND type = $2`,
		chatA.ID, events.TypeConversationMailAsked).into(t, &turnID)
	if turnID != "" {
		t.Errorf("journal turn_id = %q, want empty for the person-initiated ask", turnID)
	}
}
