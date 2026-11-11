package postgres

// ADR-0068 (docs/adr/ADR-0068-per-turn-agent-profile.md): the controller may
// switch the agent a conversation runs on BETWEEN turns; every turn records
// the profile it ran on; the switch journals the divider row the transcript
// renders; the derived "agents in this chat" list carries turn ranges; and the
// worker's resume probe never offers the old profile's session to the new
// profile's launch. These run against a real PostgreSQL because every one of
// those promises is database semantics, not handler discipline.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// cnvSwitchProfile makes an organization-owned profile with the store's own
// write path (so the version history and the ADR-0068 model column ride it)
// and deletes it after the test — the shared cnvFixture cleanup does not know
// about profiles a test adds.
func cnvSwitchProfile(t *testing.T, f *cnvFixture, orgID, model string) CnvProfile {
	t.Helper()
	name := fmt.Sprintf("switch-codex-%s", migFixtureToken(t))
	p, err := f.store.CreateAgentProfile(testCtx(t), Caller{UserID: f.alice, OrganizationID: orgID, IsOrgAdmin: true},
		name, "codex", model, "", "")
	if err != nil {
		t.Fatalf("CreateAgentProfile(%s): %v", name, err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// This cleanup runs BEFORE the shared cnvFixture delete (LIFO), so the
		// rows still reference the profile: repoint them at the seeded one and
		// let f.delete remove the rows themselves.
		stmts := []struct {
			q   string
			arg []any
		}{
			{`UPDATE conversation_turns SET agent_profile_id = $2::uuid WHERE agent_profile_id = $1::uuid`, []any{p.ID, f.profile}},
			{`UPDATE acp_session_bindings SET agent_profile_id = $2::uuid WHERE agent_profile_id = $1::uuid`, []any{p.ID, f.profile}},
			{`UPDATE conversations SET agent_profile_id = $2::uuid WHERE agent_profile_id = $1::uuid`, []any{p.ID, f.profile}},
			{`DELETE FROM agent_profile_versions WHERE profile_id = $1::uuid`, []any{p.ID}},
			{`DELETE FROM agent_profiles WHERE id = $1::uuid`, []any{p.ID}},
		}
		for _, st := range stmts {
			if _, err := f.pool.Exec(bg, st.q, st.arg...); err != nil {
				t.Errorf("cleanup profile (%.40s): %v", st.q, err)
			}
		}
	})
	return p
}

// cnvFinishTurn closes a queued turn the way the loop's terminal write does —
// by status and timestamp only, because that is all the one-active-turn index
// and the turn CHECKs require — so the next PostMessage is legal.
func cnvFinishTurn(t *testing.T, f *cnvFixture, turnID string) {
	t.Helper()
	f.exec(t, `UPDATE conversation_turns SET status = 'completed', finished_at = now()
		WHERE id = $1::uuid`, turnID)
}

func TestConversationAgentSwitchByController(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "gpt-5")

	chat := f.cnvCreate(t, f.alice, "cnv-switch create", "")

	// The controller switches the next turn's profile.
	out, err := f.store.SwitchAgent(testCtx(t), f.caller(f.alice), chat.ID, codex.ID)
	if err != nil {
		t.Fatalf("SwitchAgent by the controller: %v", err)
	}
	if out.AgentProfileID != codex.ID || out.AgentProfileName != codex.Name || out.AgentProfileModel != "gpt-5" {
		t.Errorf("switched conversation = %s/%s/%q, want the codex profile with its model",
			out.AgentProfileID, out.AgentProfileName, out.AgentProfileModel)
	}
	var pin int
	f.queryRow(t, `SELECT agent_profile_version FROM conversations WHERE id = $1`, chat.ID).into(t, &pin)
	if pin != codex.Version {
		t.Errorf("agent_profile_version pin = %d, want the new profile's %d", pin, codex.Version)
	}

	// The journal carries the divider row with actor, from, to and model.
	var found events.AgentSwitchedPayload
	var sawSwitch bool
	for _, row := range f.journalRows(t, chat.ID) {
		if row.typ != events.TypeConversationAgentSwitched {
			continue
		}
		sawSwitch = true
		if err := json.Unmarshal(row.payload, &found); err != nil {
			t.Fatalf("decode agent.switched payload: %v", err)
		}
	}
	if !sawSwitch {
		t.Fatalf("no conversation.agent.switched row in the journal")
	}
	if found.ActorUserID != f.alice || found.FromAgentProfileID != chat.AgentProfileID ||
		found.ToAgentProfileID != codex.ID || found.ToProfileName != codex.Name || found.ToLauncherID != "codex" {
		t.Errorf("agent.switched payload = %+v, want alice from %s to %s", found, chat.AgentProfileID, codex.ID)
	}
	if found.Model == nil || *found.Model != "gpt-5" {
		t.Errorf("agent.switched model = %v, want gpt-5", found.Model)
	}
	if !found.TranscriptCarriedOver {
		t.Errorf("agent.switched transcript_carried_over = false, want true")
	}

	// The next turn records the NEW profile — stamped at enqueue.
	turn, err := f.store.PostMessage(testCtx(t), f.caller(f.alice), chat.ID, "second turn on codex")
	if err != nil {
		t.Fatalf("PostMessage after the switch: %v", err)
	}
	if turn.AgentProfileID != codex.ID || turn.AgentProfileName != codex.Name || turn.AgentProfileModel != "gpt-5" {
		t.Errorf("turn profile = %s/%s/%q, want the codex profile", turn.AgentProfileID, turn.AgentProfileName, turn.AgentProfileModel)
	}
	var rowProfile string
	f.queryRow(t, `SELECT agent_profile_id::text FROM conversation_turns WHERE id = $1`, turn.ID).into(t, &rowProfile)
	if rowProfile != codex.ID {
		t.Errorf("conversation_turns.agent_profile_id = %s, want %s", rowProfile, codex.ID)
	}
}

// TestConversationAgentSwitchLaunchesOnNewProfile proves the worker half: the
// claim resolves launcher and permission mode through the TURN's profile row
// (so the next ACP session launches on the new harness), the recorded binding
// names the profile that launched it, and the resume probe refuses the old
// profile's session to the new profile's turn — which is what makes "a NEW
// ACP session, same workspace/branch" the behavior rather than the intention.
func TestConversationAgentSwitchLaunchesOnNewProfile(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "gpt-5")
	chat := f.cnvCreate(t, f.alice, "cnv-switch launch", "")
	ctx := testCtx(t)
	ts := &TurnStore{Pool: f.pool}

	// Turn 1 runs on the original profile and records its binding.
	if _, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "first turn"); err != nil {
		t.Fatalf("PostMessage: %v", err)
	}
	claim1, ok, err := ts.ClaimTurn(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("ClaimTurn turn 1: ok=%v err=%v", ok, err)
	}
	if claim1.AgentProfileID != chat.AgentProfileID {
		t.Fatalf("claim 1 profile = %s, want the conversation's %s", claim1.AgentProfileID, chat.AgentProfileID)
	}
	if _, _, err := ts.RecordBinding(ctx, claim1, domain.SessionInfo{
		ACPSessionID: "sess-old", ProtocolVersion: 1, LauncherID: claim1.LauncherID,
		AgentCapabilities: map[string]any{"loadSession": true}, Origin: events.SessionOriginNew,
	}); err != nil {
		t.Fatalf("RecordBinding turn 1: %v", err)
	}
	// The same profile may resume its own dropped process.
	if _, resumable, err := ts.ResumableSession(ctx, chat.ID, f.worker, claim1.AgentProfileID); err != nil || !resumable {
		t.Fatalf("resume for the SAME profile: ok=%v err=%v, want resumable", resumable, err)
	}
	cnvFinishTurn(t, f, claim1.TurnID)

	// The controller switches. Turn 2 is posted, claimed, and must launch on
	// codex — and must NOT be offered the old profile's session.
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID); err != nil {
		t.Fatalf("SwitchAgent: %v", err)
	}
	if _, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "second turn"); err != nil {
		t.Fatalf("PostMessage after switch: %v", err)
	}
	claim2, ok, err := ts.ClaimTurn(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("ClaimTurn turn 2: ok=%v err=%v", ok, err)
	}
	if claim2.AgentProfileID != codex.ID {
		t.Errorf("claim 2 profile = %s, want %s", claim2.AgentProfileID, codex.ID)
	}
	if claim2.LauncherID != "codex" {
		t.Errorf("claim 2 launcher = %q, want codex (the turn's profile launches the session)", claim2.LauncherID)
	}
	if _, resumable, err := ts.ResumableSession(ctx, chat.ID, f.worker, codex.ID); err != nil || resumable {
		t.Errorf("resume across a profile switch: ok=%v err=%v, want NOT resumable (a switch launches NEW)", resumable, err)
	}
	if _, _, err := ts.ResumableSession(ctx, chat.ID, f.worker, ""); err != nil {
		t.Errorf("attempt-path resume probe (no profile filter): %v", err)
	}
}

func TestConversationAgentSwitchNonControllerForbidden(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "")
	chat := f.cnvCreate(t, f.alice, "cnv-switch 403", "")
	ctx := testCtx(t)

	// Bob may write the conversation (contributor) but does not hold the
	// wheel: 403 on identity, not a conflict on timing.
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.bob), chat.ID, codex.ID); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("non-controller SwitchAgent err = %v, want ErrConversationForbidden", err)
	}
	// A viewer is denied on role, the same 403.
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.carl), chat.ID, codex.ID); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("viewer SwitchAgent err = %v, want ErrConversationForbidden", err)
	}
	// A non-member learns nothing, not even that the id is a profile.
	if _, err := f.store.SwitchAgent(ctx, Caller{UserID: f.mallory, OrganizationID: f.orgID}, chat.ID, codex.ID); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("non-member SwitchAgent err = %v, want ErrConversationNotFound", err)
	}
	// And nothing moved.
	var now string
	f.queryRow(t, `SELECT agent_profile_id::text FROM conversations WHERE id = $1`, chat.ID).into(t, &now)
	if now != chat.AgentProfileID {
		t.Errorf("conversation profile moved to %s despite the refusals, want %s", now, chat.AgentProfileID)
	}
	// The refusals left no journal row either.
	for _, row := range f.journalRows(t, chat.ID) {
		if row.typ == events.TypeConversationAgentSwitched {
			t.Errorf("a refused switch journalled %s", row.typ)
		}
	}
}

func TestConversationAgentSwitchMidTurnConflict(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "")
	chat := f.cnvCreate(t, f.alice, "cnv-switch 409", "")
	ctx := testCtx(t)

	turn, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "a turn in flight")
	if err != nil {
		t.Fatalf("PostMessage: %v", err)
	}
	for _, status := range []string{"queued", "leased", "running"} {
		f.exec(t, `
			UPDATE conversation_turns
			SET status = $2,
			    worker_id = CASE WHEN $2 = 'queued' THEN NULL ELSE $3::uuid END,
			    lease_expires_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() + interval '30 seconds' END,
			    fencing_token = CASE WHEN $2 = 'queued' THEN 0 ELSE 7 END,
			    started_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END
			WHERE id = $1::uuid`, turn.ID, status, f.worker)
		_, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID)
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictTurnInProgress {
			t.Errorf("switch while %s: err = %v, want turn_in_progress conflict", status, err)
			continue
		}
		if cf.ActiveTurn == nil || cf.ActiveTurn.ID != turn.ID {
			t.Errorf("switch while %s: conflict must carry the turn in the way, got %+v", status, cf.ActiveTurn)
		}
	}
	// The conversation's next-turn profile never moved.
	var now string
	f.queryRow(t, `SELECT agent_profile_id::text FROM conversations WHERE id = $1`, chat.ID).into(t, &now)
	if now != chat.AgentProfileID {
		t.Errorf("profile moved to %s despite the mid-turn refusals, want %s", now, chat.AgentProfileID)
	}
}

func TestConversationAgentSwitchForeignProfile400(t *testing.T) {
	f := cnvSetup(t)
	ctx := testCtx(t)
	// A real profile of ANOTHER organization.
	other, err := f.store.CreateAgentProfile(ctx,
		Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true},
		fmt.Sprintf("switch-foreign-%s", migFixtureToken(t)), "claude", "", "", "")
	if err != nil {
		t.Fatalf("foreign profile: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		f.pool.Exec(bg, `UPDATE conversations SET agent_profile_id = $2::uuid WHERE agent_profile_id = $1::uuid`, other.ID, f.profile)
		f.pool.Exec(bg, `DELETE FROM agent_profile_versions WHERE profile_id = $1::uuid`, other.ID)
		f.pool.Exec(bg, `DELETE FROM agent_profiles WHERE id = $1::uuid`, other.ID)
	})
	chat := f.cnvCreate(t, f.alice, "cnv-switch 400", "")

	for _, id := range []string{other.ID, "not-a-uuid", "00000000-0000-7000-8000-000000000999"} {
		_, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, id)
		if !errors.Is(err, ErrConversationBadRequest) {
			t.Errorf("SwitchAgent(%s) err = %v, want ErrConversationBadRequest", id, err)
			continue
		}
		if text := err.Error(); !strings.Contains(text, "agent_profile_id") {
			t.Errorf("SwitchAgent(%s) detail = %q, want it to name agent_profile_id", id, text)
		}
	}
}

func TestConversationAgentSwitchIsIdempotent(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "")
	chat := f.cnvCreate(t, f.alice, "cnv-switch twice", "")
	ctx := testCtx(t)
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID); err != nil {
		t.Fatalf("first switch: %v", err)
	}
	before := len(f.journalRows(t, chat.ID))
	again, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID)
	if err != nil {
		t.Fatalf("second switch (already the next-turn profile): %v", err)
	}
	if again.AgentProfileID != codex.ID {
		t.Errorf("idempotent switch moved the profile to %s", again.AgentProfileID)
	}
	if after := len(f.journalRows(t, chat.ID)); after != before {
		t.Errorf("idempotent switch appended %d journal rows, want 0", after-before)
	}
}

// TestConversationAgentsListRanges proves the side-panel read: consecutive
// runs of one profile are ONE entry with a turn range, a profile that comes
// back appears again with its own range, and the ordinal numbering is the
// transcript's order.
func TestConversationAgentsListRanges(t *testing.T) {
	f := cnvSetup(t)
	codex := cnvSwitchProfile(t, f, f.orgID, "gpt-5")
	chat := f.cnvCreate(t, f.alice, "cnv-agents", "")
	ctx := testCtx(t)

	if _, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "t1"); err != nil {
		t.Fatalf("t1: %v", err)
	}
	f.exec(t, `UPDATE conversation_turns SET status = 'completed', finished_at = now()
		WHERE conversation_id = $1`, chat.ID)
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, codex.ID); err != nil {
		t.Fatalf("switch to codex: %v", err)
	}
	for _, prompt := range []string{"t2", "t3"} {
		turn, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, prompt)
		if err != nil {
			t.Fatalf("%s: %v", prompt, err)
		}
		cnvFinishTurn(t, f, turn.ID)
	}
	claude := chat.AgentProfileID
	if _, err := f.store.SwitchAgent(ctx, f.caller(f.alice), chat.ID, claude); err != nil {
		t.Fatalf("switch back: %v", err)
	}
	turn, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "t4")
	if err != nil {
		t.Fatalf("t4: %v", err)
	}
	cnvFinishTurn(t, f, turn.ID)

	out, err := f.store.GetConversation(ctx, f.caller(f.alice), chat.ID)
	if err != nil {
		t.Fatalf("GetConversation: %v", err)
	}
	want := []struct {
		profile            string
		first, last, count int
	}{
		{claude, 1, 1, 1},
		{codex.ID, 2, 3, 2},
		{claude, 4, 4, 1},
	}
	if len(out.Agents) != len(want) {
		t.Fatalf("agents list = %+v, want %d segments", out.Agents, len(want))
	}
	for i, w := range want {
		got := out.Agents[i]
		if got.AgentProfileID != w.profile || got.FirstTurn != w.first || got.LastTurn != w.last || got.TurnCount != w.count {
			t.Errorf("agents[%d] = %+v, want profile %s turns %d-%d (%d)", i, got, w.profile, w.first, w.last, w.count)
		}
	}
	if out.Agents[1].Model != "gpt-5" {
		t.Errorf("codex segment model = %q, want gpt-5", out.Agents[1].Model)
	}
}
