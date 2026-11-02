package postgres

// ADR-0072 § 12 (docs/adr/ADR-0072-agent-mail.md): the rows the worker reads
// when it decides what a mailed chat's sandbox may do. `MailRepoAccess` is the
// only place that answers "is this the asked side, and has a person said it may
// edit?", so the two predicates it is built from are pinned against a real
// PostgreSQL: an ordinary chat is never read-only, a mailed chat is read-only
// until a *person* says otherwise, a *policy* verdict is not a person, and a
// turn the controller queued themselves is their own instruction.

import (
	"testing"

	"github.com/dbirks/communication/internal/worker"
)

// amVerdict writes one answered permission row in the shape ADR-0039 records
// it: a user's answer names the user, a policy's answer names the policy. The
// chosen option must be one the agent offered, so the option kinds here are
// the ACP kinds the worker journals.
func amVerdict(t *testing.T, f *cnvFixture, conversationID, turnID, id, kindBy, policy, userID, optKind string) {
	t.Helper()
	var (
		decidedBy any
		byPolicy  any
		byKind    = kindBy
		options   = `[{"option_id":"allow","label":"Yes","kind":"` + optKind + `"},{"option_id":"reject","label":"No","kind":"reject_once"}]`
	)
	if kindBy == "user" {
		decidedBy = userID
	} else {
		byPolicy = policy
	}
	f.exec(t, `
		INSERT INTO permission_requests
		    (conversation_id, turn_id, acp_request_id, tool_title, tool_kind, options,
		     status, decided_by, decided_by_kind, decided_by_policy, decision_option_id,
		     requested_at, decided_at)
		VALUES ($1::uuid, $2::uuid, $3, 'edit a file', 'edit', $4::jsonb,
		        'decided', $5::uuid, $6, $7, 'allow', now(), now())`,
		conversationID, turnID, id, options, decidedBy, byKind, byPolicy)
}

func TestMailRepoAccessIsTheAskedSideUntilAPersonSaysOtherwise(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)
	st := amStore(f)

	asking := amChat(t, f, f.alice, "web chat", "how is search wired?", "")

	// 1. An ordinary conversation's turn: not asked, not read-only.
	acc, err := st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: asking.ID, TurnID: asking.ActiveTurn.ID,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(ordinary): %v", err)
	}
	if acc.ReadOnlyRepo() {
		t.Fatalf("an ordinary chat's turn reads as read-only (%+v): § 12 would narrow every chat, not the asked side", acc)
	}

	// The composer ask: a linked chat born bound to `api`, its answer turn
	// stamped `ask`, its control held by none.
	ask, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), asking.ID, "api", "how is auth wired?")
	if err != nil {
		t.Fatalf("AskRepoMail: %v", err)
	}
	var askedTurn string
	f.queryRow(t, `
		SELECT id::text FROM conversation_turns WHERE mail_link_id = $1::uuid`, ask.LinkID).
		into(t, &askedTurn)

	// 2. The asked chat's answer turn: asked-side, nobody has approved, so the
	// repository mounts read-only. This is the row that makes the pi launch
	// honest without a prompting mode (ADR-0072 § 10's cost, now paid).
	acc, err = st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: askedTurn,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(asked): %v", err)
	}
	if !acc.Asked || acc.EditsApproved || !acc.ReadOnlyRepo() {
		t.Fatalf("asked turn = %+v, want Asked with no approval (read-only)", acc)
	}

	// 3. A POLICY verdict is not a person: preapproved_within_sandbox answering
	// the mailed chat's own prompt does not lift the mount (ADR-0039's decider
	// kinds are exactly this distinction).
	amVerdict(t, f, ask.ToConversationID, askedTurn, "policy-1",
		"policy", "preapproved_within_sandbox", "", "allow_once")
	acc, err = st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: askedTurn,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(policy verdict): %v", err)
	}
	if acc.EditsApproved || !acc.ReadOnlyRepo() {
		t.Errorf("after a policy verdict = %+v, still read-only: a policy cannot approve on a person's behalf", acc)
	}

	// A rejected human answer is also not an approval.
	amVerdict(t, f, ask.ToConversationID, askedTurn, "user-reject-1",
		"user", "", f.alice, "reject_once")
	f.exec(t, `
		UPDATE permission_requests SET decision_option_id = 'reject'
		WHERE conversation_id = $1::uuid AND acp_request_id = 'user-reject-1'`,
		ask.ToConversationID)
	acc, _ = st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: askedTurn,
	})
	if acc.EditsApproved {
		t.Errorf("a human reject lifted the read-only mount: %+v", acc)
	}

	// 4. A human `allow_once` answer — the durable row § 4's approval machinery
	// produces — lifts it, for the launches that follow.
	amVerdict(t, f, ask.ToConversationID, askedTurn, "user-allow-1",
		"user", "", f.alice, "allow_once")
	acc, err = st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: askedTurn,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(human verdict): %v", err)
	}
	if !acc.Asked || !acc.EditsApproved || acc.ReadOnlyRepo() {
		t.Errorf("after a person's allow = %+v, want approved (rw): the mount follows a person's yes", acc)
	}
}

// TestMailRepoAccessPersonQueuedTurnIsTheirOwnInstruction is the other arm of
// "a person's approval": on a launcher that never asks there is no prompt to
// answer, so the way a person lets the asked agent edit is by taking the wheel
// and asking it themselves. A turn the mail channel authored never counts,
// whatever the control row says.
func TestMailRepoAccessPersonQueuedTurnIsTheirOwnInstruction(t *testing.T) {
	f := cnvSetup(t)
	amRepo(t, f, "api")
	amSetEnabled(t, f, true)
	st := amStore(f)

	asking := amChat(t, f, f.alice, "web chat", "how is search wired?", "")
	ask, err := f.store.AskRepoMail(f.ctx(), f.caller(f.alice), asking.ID, "api", "how is auth wired?")
	if err != nil {
		t.Fatalf("AskRepoMail: %v", err)
	}
	var askedTurn string
	f.queryRow(t, `SELECT id::text FROM conversation_turns WHERE mail_link_id = $1::uuid`, ask.LinkID).
		into(t, &askedTurn)

	// The mailed answer turn, with a human controller already in place: still
	// mail-authored, so still read-only. Control is not consent for a turn the
	// channel wrote.
	f.exec(t, `
		UPDATE conversation_control SET controller_kind = 'human', controller_user_id = $2::uuid
		WHERE conversation_id = $1::uuid`, ask.ToConversationID, f.alice)
	acc, err := st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: askedTurn,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(mailed turn under a controller): %v", err)
	}
	if !acc.ReadOnlyRepo() {
		t.Fatalf("the mailed turn reads as writable because somebody holds the controller lock: %+v", acc)
	}

	// The same person ends that turn and queues their own: this turn is their
	// instruction, and it is not read-only.
	f.exec(t, `
		UPDATE conversation_turns SET status = 'completed', finished_at = now()
		WHERE id = $1::uuid`, askedTurn)
	var ownTurn string
	f.queryRow(t, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by, agent_profile_id)
		VALUES ($1::uuid, 'now make that change', $2::uuid, $3::uuid) RETURNING id::text`,
		ask.ToConversationID, f.alice, f.profile).into(t, &ownTurn)
	acc, err = st.MailRepoAccess(f.ctx(), worker.Claim{
		ConversationID: ask.ToConversationID, TurnID: ownTurn,
	})
	if err != nil {
		t.Fatalf("MailRepoAccess(person's own turn): %v", err)
	}
	if !acc.Asked {
		t.Error("the chat stopped being asked-side: that is right, but not why this turn is writable")
	}
	if !acc.EditsApproved || acc.ReadOnlyRepo() {
		t.Errorf("a person's own prompt on the asked chat = %+v, want approved (rw): they typed it themselves", acc)
	}
}
