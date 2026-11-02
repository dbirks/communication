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
	"strings"
	"testing"
	"time"

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
