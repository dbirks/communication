package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// The § 4 step 6 seams on a REAL Postgres 18 that ran 00005 (m4Setup idiom:
// no URL, clean skip — a mocked green unit test never substitutes). What is
// asserted here is row state: the stamped pair, the run_attempt control take,
// the binding table's honest reuse labelling round-trip, and the audit pair's
// correlation columns.

// atsPlan pins a plan_snapshot whose /implement node hydrates a literal
// prompt and profile — the same shape TestConfigHydrationFromPinnedPlan
// proves the claim carries to the executor.
func atsPlan(t *testing.T, ctx context.Context, f *m4Fixture, runID, profileName string) {
	t.Helper()
	plan := fmt.Sprintf(`{
		"version": "v1alpha1-plan-1",
		"nodes": [{
			"id": "implement", "scope": "/",
			"configBindings": [
				{"pointer": "/spec/nodes/0/config/prompt", "position": "literal", "literal": "document add()"},
				{"pointer": "/spec/nodes/0/config/profile", "position": "literal", "literal": %q}
			]
		}]
	}`, profileName)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET plan_snapshot = $2 WHERE id = $1::uuid`, runID, plan); err != nil {
		t.Fatalf("pin the plan: %v", err)
	}
}

// atsProfile seeds an org-scoped agent profile through the same columns M2/M3
// established (name is the compiler-validated reference; D10: no revisions).
func atsProfile(t *testing.T, ctx context.Context, f *m4Fixture, orgID, name, launcher, mode string, commit bool) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, commit_granted)
		VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text`,
		orgID, name, launcher, mode, commit).Scan(&id); err != nil {
		t.Fatalf("seed agent profile %q: %v", name, err)
	}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM agent_profile_versions WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup profile version %s: %v", id, err)
		}
		if _, err := f.pool.Exec(context.Background(), `DELETE FROM agent_profiles WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup profile %s: %v", name, err)
		}
	})
	return id
}

func atsClaimRunning(t *testing.T, ctx context.Context, f *m4Fixture, store *AttemptStore, workerID string) worker.AttemptClaim {
	t.Helper()
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v), want one attempt", claims, err)
	}
	if err := store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	return claims[0]
}

// atsConversationSweep unwinds the conversation family this seam creates
// (control, bindings, turns, the conversation itself, and the attempt stamps)
// BEFORE the shared m4/m4Worker cleanups run — t.Cleanup is LIFO, so the
// rows this test brought into the project must leave first, or the worker
// delete trips conversation_turns_worker_id_fkey. The shared fixture
// predates run-attempt conversations and does not know about
// conversation_control; it is not edited, so the knowledge lives here.
func atsConversationSweep(t *testing.T, f *m4Fixture) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		for _, step := range []string{
			`UPDATE attempts SET conversation_id = NULL, turn_id = NULL
			 WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)`,
			`DELETE FROM permission_requests WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id = $1)`,
			`DELETE FROM acp_session_bindings WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id = $1)`,
			`DELETE FROM conversation_turns WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id = $1)`,
			`DELETE FROM conversation_control WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id = $1)`,
			`DELETE FROM conversations WHERE project_id = $1`,
		} {
			if _, err := f.pool.Exec(bg, step, f.projectID); err != nil {
				t.Errorf("conversation sweep %q: %v", step, err)
			}
		}
	})
}

// TestAttemptSessionConversationStamp is contract § 4 step 6 as row state:
// the conversation and its turn are created under the attempt fence with the
// two-lease triple, conversation_control is taken as controller_kind =
// 'run_attempt' (the reserved M2 kind finally written), the pair is stamped
// on the attempt, a re-call is idempotent, and an honest interrupt closes the
// turn so the RETRY attempt rides the same conversation with a new turn.
func TestAttemptSessionConversationStamp(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("ats-profile-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)

	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "stamp", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)

	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v), want a stamped pair", conv, err)
	}
	if conv.ConversationID == "" || conv.TurnID == "" {
		t.Fatalf("pair has empty halves: %+v", conv)
	}

	// The attempt row carries the pair (attempts_agent_turn_pair).
	var dbConv, dbTurn string
	if err := f.pool.QueryRow(ctx, `
		SELECT conversation_id::text, turn_id::text FROM attempts WHERE id = $1::uuid`, c.AttemptID).
		Scan(&dbConv, &dbTurn); err != nil {
		t.Fatal(err)
	}
	if dbConv != conv.ConversationID || dbTurn != conv.TurnID {
		t.Fatalf("attempt stamp = (%s,%s), seam said (%s,%s)", dbConv, dbTurn, conv.ConversationID, conv.TurnID)
	}

	// The turn: leased on the ATTEMPT's triple, linked by node_attempt_id, and
	// holding the resolved prompt — never queued, so M2's human-turn claim
	// scan (status='queued') can never reach it (contract § 4 step 2).
	var status, tWorker, via string
	var token int64
	var prompt, attemptLink string
	if err := f.pool.QueryRow(ctx, `
		SELECT status, worker_id::text, fencing_token, prompt, node_attempt_id::text, submitted_via
		FROM conversation_turns WHERE id = $1::uuid`, conv.TurnID).
		Scan(&status, &tWorker, &token, &prompt, &attemptLink, &via); err != nil {
		t.Fatalf("read stamped turn: %v", err)
	}
	// ADR-0062: this run was started by a human (f.m4QueuedRun stamps
	// triggered_by), so its attempt turn says so — submitted_via is what
	// stops a transcript from rendering an automation's author as a typer.
	if via != "human" {
		t.Errorf("turn submitted_via = %q, want human for a manually started run", via)
	}
	if status != "leased" || tWorker != workerID || token != c.FencingToken || attemptLink != c.AttemptID {
		t.Fatalf("turn = (%s, owner %s, token %d, attempt %s), want leased on the attempt triple (%s/%d/%s)",
			status, tWorker, token, attemptLink, workerID, c.FencingToken, c.AttemptID)
	}
	if prompt != "document add()" {
		t.Errorf("turn prompt = %q, want the hydrated bindingText value", prompt)
	}

	// Control held AS the attempt (ADR-0016 § 2's reserved kind).
	var kind string
	var holder string
	if err := f.pool.QueryRow(ctx, `
		SELECT controller_kind, COALESCE(controller_run_attempt_id::text, '')
		FROM conversation_control WHERE conversation_id = $1::uuid`, conv.ConversationID).
		Scan(&kind, &holder); err != nil {
		t.Fatalf("read control: %v", err)
	}
	if kind != "run_attempt" || holder != c.AttemptID {
		t.Errorf("control = (%s, %s), want run_attempt held by attempt %s", kind, holder, c.AttemptID)
	}

	// Idempotent: the pair is read back, not recreated.
	again, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok || again != conv {
		t.Fatalf("second ConversationFor = (%v, %v, %v), want the same pair", again, ok, err)
	}
	var convCount int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM conversations WHERE project_id = $1::uuid`, f.projectID).Scan(&convCount); err != nil {
		t.Fatal(err)
	}
	if convCount != 1 {
		t.Fatalf("conversations = %d after a re-call, want 1", convCount)
	}

	// The retry rides the same conversation: the honest worker closes its own
	// attempt (turn included, § 4 step 12's pairing), the next attempt gets a
	// NEW turn on the SAME conversation — the continuity resume answers read.
	if err := store.InterruptAttemptOwn(ctx, c, worker.InterruptReasonWorkerShutdown); err != nil {
		t.Fatalf("InterruptAttemptOwn: %v", err)
	}
	a2, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: c.NodeExecutionID, AttemptNumber: 2})
	if err != nil {
		t.Fatalf("queue attempt 2: %v", err)
	}
	c2 := atsClaimRunning(t, ctx, f, store, workerID)
	if c2.AttemptID != a2.ID {
		t.Fatalf("claimed %s, expected attempt 2 %s", c2.AttemptID, a2.ID)
	}
	conv2, ok, err := sessions.ConversationFor(ctx, c2)
	if err != nil || !ok {
		t.Fatalf("retry ConversationFor = (%v, %v), want the node's conversation", conv2, err)
	}
	if conv2.ConversationID != conv.ConversationID {
		t.Errorf("retry conversation = %s, want the node's %s (resume_if_supported has nothing to answer against otherwise)", conv2.ConversationID, conv.ConversationID)
	}
	if conv2.TurnID == conv.TurnID {
		t.Error("retry reused the closed turn row; each attempt owns its turn")
	}
	var turns int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM conversation_turns WHERE conversation_id = $1::uuid`, conv.ConversationID).Scan(&turns); err != nil {
		t.Fatal(err)
	}
	if turns != 2 {
		t.Errorf("turn rows = %d, want 2 (append, not overwrite — 01)", turns)
	}
}

// TestAttemptSessionBindingLabelling is the honest reuse labelling round-trip
// (commit 9d0e560's rule, contract § 4 step 14): a binding records 'new' or
// 'resumed' — the 'reused' an attempt may never claim is refused in words
// before the CHECK refuses it by code — RecordBinding closes the prior live
// row and names it, resume answers only from a connected row whose observed
// capabilities advertised loadSession, and a stale triple lands NOTHING.
func TestAttemptSessionBindingLabelling(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("ats-bind-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "bind", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v)", conv, err)
	}

	newSession := domain.SessionInfo{
		ACPSessionID: "acp-sess-1", ProtocolVersion: 1, LauncherID: "claude",
		LauncherVersion: "0.90.0", Origin: events.SessionOriginNew,
		AgentCapabilities: map[string]any{"loadSession": true},
	}
	id1, closed, err := sessions.RecordBinding(ctx, c, conv.ConversationID, newSession)
	if err != nil || id1 == "" || len(closed) != 0 {
		t.Fatalf("first RecordBinding = (%s, %v, %v)", id1, closed, err)
	}

	info, resumable, err := sessions.ResumableSession(ctx, conv.ConversationID, workerID)
	if err != nil || !resumable || info.ACPSessionID != "acp-sess-1" {
		t.Fatalf("ResumableSession = (%v, %v, %v), want the connected binding", info, resumable, err)
	}
	if info.Origin != events.SessionOriginNew {
		t.Errorf("stored origin = %q, want the observed 'new' (the label is what was negotiated, not what later turns wish)", info.Origin)
	}
	// Another worker sees nothing: the binding is per conversation AND worker
	// (session/load is a promise THIS process's successor can keep).
	if _, other, err := sessions.ResumableSession(ctx, conv.ConversationID, "00000000-0000-0000-0000-0000000000ff"); err != nil || other {
		t.Errorf("foreign worker resumable = (%v, %v), want false", other, err)
	}

	// The resumed label round-trips and closes the prior row, naming it.
	loaded := newSession
	loaded.ACPSessionID = "acp-sess-1"
	loaded.Origin = events.SessionOriginResumed
	id2, closed, err := sessions.RecordBinding(ctx, c, conv.ConversationID, loaded)
	if err != nil || id2 == "" || len(closed) != 1 || closed[0] != id1 {
		t.Fatalf("resumed RecordBinding = (%s, %v, %v), want the prior id closed", id2, closed, err)
	}
	var origin string
	if err := f.pool.QueryRow(ctx, `
		SELECT session_origin FROM acp_session_bindings WHERE id = $1::uuid`, id2).Scan(&origin); err != nil {
		t.Fatal(err)
	}
	if origin != events.SessionOriginResumed {
		t.Errorf("binding origin = %q, want resumed", origin)
	}

	// 'reused' is unrepresentable for an attempt: refused here, CHECKed in
	// 00003 — no row may carry it either way.
	bad := newSession
	bad.Origin = events.SessionOriginReused
	rowsBefore := awCount(t, ctx, f, `SELECT count(*) FROM acp_session_bindings`)
	if _, _, err := sessions.RecordBinding(ctx, c, conv.ConversationID, bad); err == nil ||
		!strings.Contains(err.Error(), "reused") {
		t.Fatalf("reused-label RecordBinding = %v, want the honest refusal naming it", err)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM acp_session_bindings`); n != rowsBefore {
		t.Errorf("binding rows went %d→%d on a refused write", rowsBefore, n)
	}

	// The foreign-conversation guard: a binding for a conversation this
	// attempt does not own is a claim the fence says nothing about.
	if _, _, err := sessions.RecordBinding(ctx, c, "00000000-0000-0000-0000-0000000000ee", newSession); err == nil {
		t.Error("RecordBinding for a foreign conversation accepted")
	}

	// A stale triple lands nothing (the binding row is a claim about THIS
	// owner's session; case 3's rule extended to every fenced seam write).
	thief := m4Worker(t, ctx, f.pool, "bind-thief", 1)
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET fencing_token = fencing_token + 1, worker_id = $2::uuid WHERE id = $1::uuid`,
		c.AttemptID, thief); err != nil {
		t.Fatal(err)
	}
	if _, _, err := sessions.RecordBinding(ctx, c, conv.ConversationID, newSession); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale RecordBinding = %v, want worker.ErrLeaseLost", err)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM acp_session_bindings`); n != rowsBefore {
		t.Errorf("stale write landed bindings: %d→%d rows", rowsBefore, n)
	}

	// The honest close: this worker's live rows go, the seam returns their ids
	// for eventing, and nothing is offered for resume afterwards.
	ids, err := sessions.CloseBinding(ctx, conv.ConversationID, workerID, "process_exited")
	if err != nil || len(ids) != 1 || ids[0] != id2 {
		t.Fatalf("CloseBinding = (%v, %v), want the live id", ids, err)
	}
	if _, resumable, err := sessions.ResumableSession(ctx, conv.ConversationID, workerID); err != nil || resumable {
		t.Errorf("closed binding still offers resume = (%v, %v)", resumable, err)
	}
}

// TestAttemptSessionResumeAfterKilledOwner is the arm the lab kill (12 case 5
// shape) leaves behind: the executor died before its CloseBinding, so the
// binding row is still connected, and the retry on the same worker must be
// OFFERED the session (session_resumed is then decided by what the provider
// actually loaded — labelled by the new binding row, not by wish).
func TestAttemptSessionResumeAfterKilledOwner(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("ats-kill-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "kill", 2)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v)", conv, err)
	}
	if _, _, err := sessions.RecordBinding(ctx, c, conv.ConversationID, domain.SessionInfo{
		ACPSessionID: "acp-dead", ProtocolVersion: 1, LauncherID: "claude",
		Origin: events.SessionOriginNew, AgentCapabilities: map[string]any{"loadSession": true},
	}); err != nil {
		t.Fatalf("RecordBinding: %v", err)
	}

	// The owner died: the reconciler's arms (attempt + turn interrupted) run
	// raw here because the reconciler's attempt pass is another wave's table;
	// the binding row deliberately stays connected — that is the death shape.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET status = 'interrupted', error_class = 'interrupted', finished_at = now()
		WHERE id = $1::uuid`, c.AttemptID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'interrupted', finished_at = now()
		WHERE node_attempt_id = $1::uuid`, c.AttemptID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE node_executions SET status = 'ready' WHERE id = $1::uuid`, c.NodeExecutionID); err != nil {
		t.Fatal(err)
	}

	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: c.NodeExecutionID, AttemptNumber: 2}); err != nil {
		t.Fatalf("queue retry: %v", err)
	}
	c2 := atsClaimRunning(t, ctx, f, store, workerID)
	conv2, ok, err := sessions.ConversationFor(ctx, c2)
	if err != nil || !ok || conv2.ConversationID != conv.ConversationID {
		t.Fatalf("retry pair = (%v, %v, %v), want the node's conversation", conv2, ok, err)
	}
	info, resumable, err := sessions.ResumableSession(ctx, conv2.ConversationID, workerID)
	if err != nil || !resumable || info.ACPSessionID != "acp-dead" {
		t.Fatalf("resumable after the kill = (%v, %v, %v), want the dead owner's binding offered", info, resumable, err)
	}
	// The provider loads it: the new row carries the word, the dead row closes.
	id, closed, err := sessions.RecordBinding(ctx, c2, conv2.ConversationID, domain.SessionInfo{
		ACPSessionID: "acp-dead", ProtocolVersion: 1, LauncherID: "claude",
		Origin: events.SessionOriginResumed, AgentCapabilities: map[string]any{"loadSession": true},
	})
	if err != nil || len(closed) != 1 {
		t.Fatalf("resumed RecordBinding = (%v, %v)", id, err)
	}
	var origin string
	if err := f.pool.QueryRow(ctx, `SELECT session_origin FROM acp_session_bindings WHERE id = $1::uuid`, id).Scan(&origin); err != nil {
		t.Fatal(err)
	}
	if origin != events.SessionOriginResumed {
		t.Errorf("retry binding origin = %q, want resumed", origin)
	}
}

// TestAttemptSessionNoSubmitterRefuses pins the honest gap: a run with no
// triggering user cannot get its conversation stamped, because
// conversation_turns.submitted_by is NOT NULL REFERENCES users and this seam
// will not forge a submitter. ok=false (the wiring gap), not a fake.
func TestAttemptSessionNoSubmitterRefuses(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	atsConversationSweep(t, f)
	profile := fmt.Sprintf("ats-nosub-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "ask", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET triggered_by = NULL WHERE id = $1::uuid`, runID); err != nil {
		t.Fatal(err)
	}
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "nosub", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)

	_, ok, err := sessions.ConversationFor(ctx, c)
	if ok {
		t.Fatal("ConversationFor succeeded for a run with no submitter")
	}
	if err == nil || !strings.Contains(err.Error(), "submitted_by") {
		t.Fatalf("err = %v, want it to name the submitted_by gap", err)
	}
	var convs int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM conversations WHERE project_id = $1::uuid`, f.projectID).Scan(&convs); err != nil {
		t.Fatal(err)
	}
	if convs != 0 {
		t.Errorf("refusal created %d conversations", convs)
	}
}

// TestAgentProfilesResolver proves the read § 4 step 6 names: the run-plan
// profile name resolves to the launcher and prompting axes ONLY inside the
// attempt's run organization — an unknown name, or one owned by another org,
// is ok=false (the honest refusal the executor carries), never a default
// launcher.
func TestAgentProfilesResolver(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	resolver := &AgentProfiles{Pool: f.pool}
	own := fmt.Sprintf("ats-prof-own-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, own, "claude", "deny", true)

	c := worker.AttemptClaim{OrganizationID: f.orgID}
	prof, ok, err := resolver.AgentProfileFor(ctx, c, own)
	if err != nil || !ok {
		t.Fatalf("resolve own profile = (%v, %v)", ok, err)
	}
	if prof.LauncherID != "claude" || prof.PermissionMode != "deny" || !prof.CommitGranted || prof.AgentProfileID == "" {
		t.Errorf("resolved %+v, want claude/deny/commit+id from the row", prof)
	}
	if _, ok, err := resolver.AgentProfileFor(ctx, c, "ats-no-such-profile"); err != nil || ok {
		t.Errorf("unknown profile resolved = (%v, %v), want ok=false", ok, err)
	}
	// Another org's profile of the same name must not resolve for this run:
	// the org predicate is what keeps a profile from another tenant's name
	// space off this attempt's launcher.
	var otherOrg string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO organizations (slug, name) VALUES ('ats-other-' || substr(md5(random()::text), 1, 8), 'ats other')
		RETURNING id::text`).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM agent_profile_versions WHERE organization_id = $1::uuid`, otherOrg)
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM agent_profiles WHERE organization_id = $1::uuid`, otherOrg)
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1::uuid`, otherOrg)
	})
	crossName := "ats-cross-" + migFixtureToken(t)
	atsProfile(t, ctx, f, otherOrg, crossName, "codex", "ask", false)
	if _, ok, err := resolver.AgentProfileFor(ctx, c, crossName); err != nil || ok {
		t.Errorf("cross-org profile resolved for this run = (%v, %v), want ok=false", ok, err)
	}
}

// TestAttemptPermissionAuditRows proves the decider bridge's audit half at
// the store: the requested/decided pair lands in the journal correlated to
// run+node+attempt (§ 3's correlation rule, columns not just payload), the
// honest deny travels as decided-status=cancelled, and a STALE writer appends
// NOTHING — it cannot forge a consent record it no longer owns. No
// permission_requests row is written by this path, and that is the honesty:
// the table's CHECK demands a user decided_by for 'decided', and a node
// policy is not a user.
func TestAttemptPermissionAuditRows(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("ats-audit-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "deny", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "audit", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v)", conv, err)
	}

	options := []events.PermissionOption{{OptionID: "opt-reject", Label: "cancel", Kind: "reject_once"}}
	// The exact pair agentturn's bridge journals for a deny verdict.
	req := events.PermissionRequestedPayload{
		ConversationID: conv.ConversationID, TurnID: conv.TurnID,
		PermissionRequestID: "attempt-audit-permission-1", ToolCallID: "tc-1",
		Title: "write file", Kind: "edit", Options: options,
	}
	if err := store.AppendAttemptEvent(ctx, c, worker.AttemptEvent{
		Type: events.TypeConversationPermissionRequested, Payload: req,
	}); err != nil {
		t.Fatalf("requested append: %v", err)
	}
	decided := events.PermissionDecidedPayload{
		ConversationID: conv.ConversationID, TurnID: conv.TurnID,
		PermissionRequestID: "attempt-audit-permission-1",
		Status:              events.PermissionStatusCancelled,
		DecidedBy:           "node_policy:deny",
	}
	if err := store.AppendAttemptEvent(ctx, c, worker.AttemptEvent{
		Type: events.TypeConversationPermissionDecided, Payload: decided,
	}); err != nil {
		t.Fatalf("decided append: %v", err)
	}

	rows, err := f.pool.Query(ctx, `
		SELECT type, run_id::text, node_execution_id::text, attempt_id::text, payload::text
		FROM domain_events WHERE attempt_id = $1::uuid
		  AND type IN ($2, $3) ORDER BY global_seq`,
		c.AttemptID, events.TypeConversationPermissionRequested, events.TypeConversationPermissionDecided)
	if err != nil {
		t.Fatal(err)
	}
	type audit struct{ typ, run, node, attempt, payload string }
	var got []audit
	for rows.Next() {
		var a audit
		if err := rows.Scan(&a.typ, &a.run, &a.node, &a.attempt, &a.payload); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		got = append(got, a)
	}
	rows.Close()
	if len(got) != 2 {
		t.Fatalf("audit rows = %d, want the requested+decided pair", len(got))
	}
	if got[0].typ != events.TypeConversationPermissionRequested || got[1].typ != events.TypeConversationPermissionDecided {
		t.Fatalf("pair order = %s, %s", got[0].typ, got[1].typ)
	}
	for _, a := range got {
		if a.run != c.RunID || a.node != c.NodeExecutionID || a.attempt != c.AttemptID {
			t.Errorf("%s correlation = (%s,%s,%s), want (%s,%s,%s) — § 3 columns, not just payload",
				a.typ, a.run, a.node, a.attempt, c.RunID, c.NodeExecutionID, c.AttemptID)
		}
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(got[1].payload), &payload); err != nil {
		t.Fatalf("decided payload: %v", err)
	}
	if payload["status"] != "cancelled" || payload["decided_by"] != "node_policy:deny" {
		t.Errorf("decided payload = %s, want the honest cancelled-with-decider audit", got[1].payload)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM permission_requests WHERE turn_id = $1::uuid`, conv.TurnID); n != 0 {
		t.Errorf("permission_requests rows = %d, want 0: a machine verdict cannot honestly fill decided_by, so the journal is the audit (00003's CHECK is why)", n)
	}

	// The stale writer: rotate the triple, and a further append lands nothing.
	thief := m4Worker(t, ctx, f.pool, "audit-thief", 1)
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET fencing_token = fencing_token + 1, worker_id = $2::uuid WHERE id = $1::uuid`,
		c.AttemptID, thief); err != nil {
		t.Fatal(err)
	}
	before := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID)
	if err := store.AppendAttemptEvent(ctx, c, worker.AttemptEvent{
		Type: events.TypeConversationPermissionDecided, Payload: events.PermissionDecidedPayload{
			ConversationID: conv.ConversationID, TurnID: conv.TurnID,
			PermissionRequestID: "attempt-audit-permission-1",
			Status:              events.PermissionStatusDecided,
			DecisionOptionID:    "opt-reject", DecidedBy: "node_policy:deny",
		},
	}); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stale audit append = %v, want ErrLeaseLost", err)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid`, c.AttemptID); n != before {
		t.Errorf("stale writer appended: %d→%d journal rows", before, n)
	}
}

// ------------------------------------------------------- pure (no database)

// TestPermissionPolicyForVerdicts pins the § 4 node-policy decision table —
// by KIND only (the labels deliberately lie: Codex names its reject option
// "cancel", docs/compatibility/ACP.md), with the adapter's two-step fallback
// and the fail-closed arms.
func TestPermissionPolicyForVerdicts(t *testing.T) {
	offered := domain.PermissionPrompt{Options: []domain.PermissionOption{
		{OptionID: "id-x", Label: "cancel", Kind: "reject_once"},
		{OptionID: "id-y", Label: "Allow this time", Kind: "allow_once"},
	}}
	cases := []struct {
		name      string
		mode      string
		prompt    domain.PermissionPrompt
		wantKind  string
		wantDecBy string
	}{
		{"preapproved picks allow_once by kind", "preapproved_within_sandbox", offered, "allow_once", "node_policy:preapproved_within_sandbox"},
		{"preapproved falls back to allow_always", "preapproved_within_sandbox",
			domain.PermissionPrompt{Options: []domain.PermissionOption{{OptionID: "a", Kind: "allow_always"}}},
			"allow_always", "node_policy:preapproved_within_sandbox"},
		{"deny picks reject_once even when its label lies", "deny", offered, "reject_once", "node_policy:deny"},
		{"no compatible option is the cancelled outcome", "deny",
			domain.PermissionPrompt{Options: []domain.PermissionOption{{OptionID: "only", Label: "Yes", Kind: "allow_once"}}},
			"", "node_policy:deny"},
		{"ask answers cancelled, never an invented consent", "ask", offered, "", "node_policy:ask_unattended"},
		{"undeclared mode fails closed to deny", "", offered, "reject_once", "node_policy:deny_undeclared_mode"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			policy := PermissionPolicyFor(tc.mode)
			if policy == nil {
				t.Fatal("nil policy")
			}
			got := policy(tc.prompt)
			if got.OptionKind != tc.wantKind || got.DecidedBy != tc.wantDecBy {
				t.Fatalf("verdict = %+v, want kind=%q decider=%q", got, tc.wantKind, tc.wantDecBy)
			}
		})
	}
}

// TestAttemptTurnSpecGaps pins the ok=false wiring gaps the executor then
// reports as the § 4 step 6 gap it is: no config, no prompt, no profile.
func TestAttemptTurnSpecGaps(t *testing.T) {
	if _, ok, err := attemptTurnSpec(worker.AttemptClaim{}); ok || err != nil {
		t.Errorf("nil config = (%v, %v), want (false, nil): wiring gap", ok, err)
	}
	if _, ok, _ := attemptTurnSpec(worker.AttemptClaim{Config: map[string]any{"prompt": map[string]any{"$unresolved": true}}}); ok {
		t.Error("unresolved prompt accepted as stampable")
	}
	if _, ok, _ := attemptTurnSpec(worker.AttemptClaim{Config: map[string]any{"prompt": "do it"}}); ok {
		t.Error("prompt without a profile accepted as stampable")
	}
	spec, ok, err := attemptTurnSpec(worker.AttemptClaim{Config: map[string]any{
		"prompt": "do it", "agent": "alt-name",
	}})
	if err != nil || !ok || spec.profile != "alt-name" {
		t.Errorf("agent-name fallback = (%+v, %v, %v)", spec, ok, err)
	}
	long := make([]byte, 65537)
	for i := range long {
		long[i] = 'x'
	}
	if _, _, err := attemptTurnSpec(worker.AttemptClaim{Config: map[string]any{
		"prompt": string(long), "profile": "p",
	}}); err == nil || !strings.Contains(err.Error(), "65536") {
		t.Errorf("oversize prompt err = %v, want the 65536 refusal", err)
	}
}
