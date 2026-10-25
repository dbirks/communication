package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/worker"
)

// ADR-0062 on a REAL Postgres (the m4/m6/it fixtures skip without
// COMMUNICATION_TEST_DATABASE_URL — a mocked green test never substitutes):
// the agent turn of a schedule-fired or issue-trigger-fired run is stamped
// with submitted_by = the human who authored the trigger row that fired it,
// the automation kind in submitted_via; a child run inherits its ancestor's
// submitter; and when no human can be named the stamp fails CLOSED, writing
// nothing. This is the product's core loop — before 00017 every such run
// died on "run has no triggering user" at its first agent.acp node.

// utAttemptStore wires the claim store and the seam under test over one
// RunStore (the pair awSetup builds, on the caller's fixture).
func utAttemptStore(f *m4Fixture) (*AttemptStore, *AttemptSessions) {
	store := &AttemptStore{Runs: &RunStore{Pool: f.pool, LeaseTTL: 2 * time.Second}}
	return store, &AttemptSessions{Runs: store.Runs}
}

// utAuthor seeds the human who WROTE the automation. It registers no cleanup:
// the trigger rows reference this user and so do the stamped conversation
// rows until the sweep clears them, so the delete order belongs to
// utAutomationSweep — registered BEFORE m4Worker/atsConversationSweep so it
// RUNS after they do (t.Cleanup is LIFO).
func utAuthor(t *testing.T, ctx context.Context, f *m4Fixture, label string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'adr0062-' || $2 || '-' || substr(md5(random()::text), 1, 8))
		RETURNING id::text`, f.orgID, label).Scan(&id); err != nil {
		t.Fatalf("seed author user: %v", err)
	}
	return id
}

// utAutomationSweep deletes the named trigger rows and then the author user
// (created_by FKs point at the user). Each SQL takes the project id.
func utAutomationSweep(t *testing.T, f *m4Fixture, author string, deleteTriggerSQLs ...string) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		for _, step := range deleteTriggerSQLs {
			if _, err := f.pool.Exec(bg, step, f.projectID); err != nil {
				t.Errorf("automation sweep %q: %v", step, err)
			}
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM users WHERE id = $1::uuid`, author); err != nil {
			t.Errorf("cleanup author user %s: %v", author, err)
		}
	})
}

// utReadyAttempt moves a fired run to running, pins the ats plan (literal
// prompt + profile), seeds the /implement agent.acp node with its queued
// attempt, and claims it — the state a worker finds at § 4 step 6. The
// caller registers atsConversationSweep AFTER this call (LIFO: the sweep
// must run before the worker cleanup, as in the ats tests).
func utReadyAttempt(t *testing.T, ctx context.Context, f *m4Fixture, store *AttemptStore, runID, profile, tag string) worker.AttemptClaim {
	t.Helper()
	if _, err := f.runs.SetRunStatus(ctx, runID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("start run %s: %v", runID, err)
	}
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, tag, 1)
	return atsClaimRunning(t, ctx, f, store, workerID)
}

// utTurnOrigin reads the stamped turn's honest naming of itself (00017).
func utTurnOrigin(t *testing.T, ctx context.Context, f *m4Fixture, turnID string) (string, string) {
	t.Helper()
	var submittedBy, submittedVia string
	if err := f.pool.QueryRow(ctx, `
		SELECT submitted_by::text, submitted_via FROM conversation_turns WHERE id = $1::uuid`,
		turnID).Scan(&submittedBy, &submittedVia); err != nil {
		t.Fatalf("read stamped turn %s: %v", turnID, err)
	}
	return submittedBy, submittedVia
}

// utFiredRun reads a fired run's attribution columns by id.
func utFiredRun(t *testing.T, ctx context.Context, f *m4Fixture, runID string) (triggeredBy, triggerID, triggerKind string) {
	t.Helper()
	var ref *string
	err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(triggered_by::text, ''), COALESCE(trigger_id::text, ''), trigger_kind, trigger_ref
		FROM runs WHERE id = $1::uuid`, runID).Scan(&triggeredBy, &triggerID, &triggerKind, &ref)
	if err != nil {
		t.Fatalf("read the fired run %s: %v", runID, err)
	}
	return triggeredBy, triggerID, triggerKind
}

// TestUnattendedScheduleTurnNamesTheScheduleAuthor is the schedule arm on
// the real fire path: TickSchedules creates the run with triggered_by NULL
// and trigger_id pointing at its schedules row (ADR-0056 § 1 extended by
// ADR-0062), and the attempt's turn is submitted on behalf of the schedule's
// created_by — a user the run names nowhere else.
func TestUnattendedScheduleTurnNamesTheScheduleAuthor(t *testing.T) {
	ctx := testCtx(t)
	f := m6Setup(t)
	store, sessions := utAttemptStore(f.m4Fixture)
	author := utAuthor(t, ctx, f.m4Fixture, "sched")
	utAutomationSweep(t, f.m4Fixture, author, `DELETE FROM schedules WHERE project_id = $1::uuid`)

	enabled := true
	next := m6At(2026, 3, 10, 0, 0)
	sc, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "0 0 * * *", Enabled: &enabled, NextRunAt: &next, CreatedBy: author,
	})
	if err != nil {
		t.Fatalf("create schedule: %v", err)
	}
	fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 0, 30))
	if err != nil || fired != 1 {
		t.Fatalf("TickSchedules = (%d, %v), want one fire", fired, err)
	}

	var runID string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM runs WHERE assignment_id = $1::uuid`, f.assignment).Scan(&runID); err != nil {
		t.Fatalf("read the fired run: %v", err)
	}
	triggeredBy, triggerID, kind := utFiredRun(t, ctx, f.m4Fixture, runID)
	if triggeredBy != "" {
		t.Errorf("fired run triggered_by = %s, want NULL: the fire stays a system start", triggeredBy)
	}
	if kind != "schedule" || triggerID != sc.ID {
		t.Errorf("fired run trigger = (%s, %s), want (schedule, %s) — the run must record the row it names it", kind, triggerID, sc.ID)
	}

	profile := "ats-sched-" + migFixtureToken(t)
	atsProfile(t, ctx, f.m4Fixture, f.orgID, profile, "claude", "deny", false)
	c := utReadyAttempt(t, ctx, f.m4Fixture, store, runID, profile, "sched")
	atsConversationSweep(t, f.m4Fixture)

	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v), want the stamped pair: a schedule-fired run is the product's core loop", conv, err)
	}
	submittedBy, submittedVia := utTurnOrigin(t, ctx, f.m4Fixture, conv.TurnID)
	if submittedBy != author {
		t.Errorf("turn submitted_by = %s, want the schedule author %s", submittedBy, author)
	}
	if submittedVia != "schedule" {
		t.Errorf("turn submitted_via = %q, want schedule: the transcript may not render this as a human typing", submittedVia)
	}
	var convCreator string
	if err := f.pool.QueryRow(ctx,
		`SELECT created_by::text FROM conversations WHERE id = $1::uuid`, conv.ConversationID).Scan(&convCreator); err != nil {
		t.Fatal(err)
	}
	if convCreator != author {
		t.Errorf("conversation created_by = %s, want the same author %s", convCreator, author)
	}
}

// TestUnattendedIssueTurnNamesTheTriggerAuthor is the issue arm on the real
// poll path: TickIssueTriggers fires the run with trigger_id = the
// issue_triggers row, and the turn is submitted on behalf of that row's
// created_by.
func TestUnattendedIssueTurnNamesTheTriggerAuthor(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	store, sessions := utAttemptStore(f.m4Fixture)
	author := utAuthor(t, ctx, f.m4Fixture, "issue")
	utAutomationSweep(t, f.m4Fixture, author, `DELETE FROM issue_triggers WHERE project_id = $1::uuid`)

	// Author the trigger with a writer that is NOT the fixture user, so
	// submitted_by can only come from the trigger row.
	f.itDropTriggers(t, ctx)
	enabled := true
	it, err := f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: &enabled, CreatedBy: author,
	})
	if err != nil {
		t.Fatalf("create issue trigger: %v", err)
	}
	lister := newITIssueLister([]itWireIssue{{
		Number: 1, Title: "Comes in hot", Body: "", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/1",
		CreatedAt: it.CreatedAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: it.CreatedAt.Add(time.Hour).Format(time.RFC3339),
	}}, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("TickIssueTriggers = (%d, %v), want one fire", fired, err)
	}

	var runID string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM runs WHERE trigger_kind = 'issue' AND project_id = $1::uuid`,
		f.projectID).Scan(&runID); err != nil {
		t.Fatalf("read the fired run: %v", err)
	}
	triggeredBy, triggerID, _ := utFiredRun(t, ctx, f.m4Fixture, runID)
	if triggeredBy != "" {
		t.Errorf("fired run triggered_by = %s, want NULL: the issue fire stays a system start", triggeredBy)
	}
	if triggerID != it.ID {
		t.Errorf("fired run trigger_id = %s, want the firing issue_triggers row %s", triggerID, it.ID)
	}

	profile := "ats-issue-" + migFixtureToken(t)
	atsProfile(t, ctx, f.m4Fixture, f.orgID, profile, "claude", "deny", false)
	c := utReadyAttempt(t, ctx, f.m4Fixture, store, runID, profile, "issue")
	atsConversationSweep(t, f.m4Fixture)

	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v), want the stamped pair: an issue-fired run is the real issue→PR loop", conv, err)
	}
	submittedBy, submittedVia := utTurnOrigin(t, ctx, f.m4Fixture, conv.TurnID)
	if submittedBy != author {
		t.Errorf("turn submitted_by = %s, want the trigger author %s", submittedBy, author)
	}
	if submittedVia != "issue_trigger" {
		t.Errorf("turn submitted_via = %q, want issue_trigger", submittedVia)
	}
}

// TestUnattendedChildTurnInheritsTheSubmitter is the child arm: a
// pipeline.invoke child of a human-started run names its ancestor's
// triggering user with submitted_via='child_run' — inherited, not guessed
// (the child's own triggered_by stays NULL, which is what made this refuse
// before ADR-0062).
func TestUnattendedChildTurnInheritsTheSubmitter(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: store.Runs}
	profile := "ats-child-" + migFixtureToken(t)
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "deny", false)

	parentID := f.m4QueuedRun(t, ctx, "", 0)
	child, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		Depth: 1, ParentRunID: parentID,
		TriggeredBy: "", TriggerKind: "manual",
	})
	if err != nil {
		t.Fatalf("create child run: %v", err)
	}

	c := utReadyAttempt(t, ctx, f, store, child.ID, profile, "child")
	atsConversationSweep(t, f)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v), want the stamped pair for the child run", conv, err)
	}
	submittedBy, submittedVia := utTurnOrigin(t, ctx, f, conv.TurnID)
	if submittedBy != f.userID {
		t.Errorf("child turn submitted_by = %s, want the parent run's triggering user %s", submittedBy, f.userID)
	}
	if submittedVia != "child_run" {
		t.Errorf("child turn submitted_via = %q, want child_run", submittedVia)
	}
}

// TestUnattendedTurnFailsClosedWhenTheScheduleIsGone is the fail-closed
// half: the trigger row that authorised the run is gone, so no human can be
// named — the seam refuses, writes no conversation, and the error says
// exactly that (the attempt lands failed with this detail; nothing about it
// is retryable by a ghost).
func TestUnattendedTurnFailsClosedWhenTheScheduleIsGone(t *testing.T) {
	ctx := testCtx(t)
	f := m6Setup(t)
	store, sessions := utAttemptStore(f.m4Fixture)
	author := utAuthor(t, ctx, f.m4Fixture, "gone")
	utAutomationSweep(t, f.m4Fixture, author, `DELETE FROM schedules WHERE project_id = $1::uuid`)

	enabled := true
	next := m6At(2026, 3, 10, 0, 0)
	sc, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "0 0 * * *", Enabled: &enabled, NextRunAt: &next, CreatedBy: author,
	})
	if err != nil {
		t.Fatalf("create schedule: %v", err)
	}
	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 0, 30)); err != nil || fired != 1 {
		t.Fatalf("TickSchedules = (%d, %v), want one fire", fired, err)
	}
	var runID string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM runs WHERE assignment_id = $1::uuid`, f.assignment).Scan(&runID); err != nil {
		t.Fatalf("read the fired run: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM schedules WHERE id = $1::uuid`, sc.ID); err != nil {
		t.Fatalf("delete the fired schedule: %v", err)
	}

	profile := "ats-gone-" + migFixtureToken(t)
	atsProfile(t, ctx, f.m4Fixture, f.orgID, profile, "claude", "deny", false)
	c := utReadyAttempt(t, ctx, f.m4Fixture, store, runID, profile, "gone")
	atsConversationSweep(t, f.m4Fixture)

	_, ok, err := sessions.ConversationFor(ctx, c)
	if ok || err == nil {
		t.Fatalf("ConversationFor = (ok %v, err %v), want the closed refusal", ok, err)
	}
	if !strings.Contains(err.Error(), "submitted_by") {
		t.Errorf("err = %v, want it to name the submitted_by constraint it obeys", err)
	}
	if !strings.Contains(err.Error(), sc.ID) || !strings.Contains(err.Error(), "gone") {
		t.Errorf("err = %v, want it to name the vanished schedule %s", err, sc.ID)
	}
	var convs int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM conversations WHERE project_id = $1::uuid`, f.projectID).Scan(&convs); err != nil {
		t.Fatal(err)
	}
	if convs != 0 {
		t.Errorf("refusal created %d conversations, want 0 (fail closed writes nothing)", convs)
	}
}

// TestUnattendedTurnFailsClosedWhenTheIssueTriggerIsGone is the same
// refusal through the issue arm.
func TestUnattendedTurnFailsClosedWhenTheIssueTriggerIsGone(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	store, sessions := utAttemptStore(f.m4Fixture)
	author := utAuthor(t, ctx, f.m4Fixture, "imgone")
	utAutomationSweep(t, f.m4Fixture, author, `DELETE FROM issue_triggers WHERE project_id = $1::uuid`)

	f.itDropTriggers(t, ctx)
	enabled := true
	it, err := f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: &enabled, CreatedBy: author,
	})
	if err != nil {
		t.Fatalf("create issue trigger: %v", err)
	}
	lister := newITIssueLister([]itWireIssue{{
		Number: 2, Title: "Gone in sixty", Body: "", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/2",
		CreatedAt: it.CreatedAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: it.CreatedAt.Add(time.Hour).Format(time.RFC3339),
	}}, nil)
	defer lister.Close()
	if fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister); err != nil || fired != 1 {
		t.Fatalf("TickIssueTriggers = (%d, %v), want one fire", fired, err)
	}
	var runID string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM runs WHERE trigger_kind = 'issue' AND project_id = $1::uuid`,
		f.projectID).Scan(&runID); err != nil {
		t.Fatalf("read the fired run: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM issue_triggers WHERE id = $1::uuid`, it.ID); err != nil {
		t.Fatalf("delete the fired trigger: %v", err)
	}

	profile := "ats-imgone-" + migFixtureToken(t)
	atsProfile(t, ctx, f.m4Fixture, f.orgID, profile, "claude", "deny", false)
	c := utReadyAttempt(t, ctx, f.m4Fixture, store, runID, profile, "imgone")
	atsConversationSweep(t, f.m4Fixture)

	_, ok, err := sessions.ConversationFor(ctx, c)
	if ok || err == nil {
		t.Fatalf("ConversationFor = (ok %v, err %v), want the closed refusal", ok, err)
	}
	if !strings.Contains(err.Error(), it.ID) || !strings.Contains(err.Error(), "submitted_by") {
		t.Errorf("err = %v, want it to name the vanished trigger %s and the constraint", err, it.ID)
	}
}

// TestMigrate0017UnattendedTurnShape proves 00017 landed its invariants as
// catalog state: runs.trigger_id with its kind CHECK, and
// conversation_turns.submitted_via NOT NULL, defaulting to the honest
// 'human', CHECKed against the exhaustive origin vocabulary. The fire-path
// tests above prove the same columns are WRITTEN, not merely present.
func TestMigrate0017UnattendedTurnShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var turnsColDefault, turnsNotNull string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), a.attnotnull::text
		FROM pg_attribute a
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = 'conversation_turns'::regclass AND a.attname = 'submitted_via'`).
		Scan(&turnsColDefault, &turnsNotNull); err != nil {
		t.Fatalf("submitted_via column: %v", err)
	}
	if !strings.Contains(turnsColDefault, "human") || turnsNotNull != "true" {
		t.Errorf("submitted_via default=%q notnull=%s, want DEFAULT 'human' NOT NULL", turnsColDefault, turnsNotNull)
	}
	for _, want := range []struct{ rel, con, def string }{
		{"runs", "runs_trigger_id_names_a_trigger", "trigger_kind"},
		{"conversation_turns", "conversation_turns_submitted_via_is_honest", "submitted_via"},
	} {
		var def string
		if err := pool.QueryRow(ctx, `
			SELECT pg_get_constraintdef(c.oid)
			FROM pg_constraint c WHERE c.conname = $1 AND c.conrelid = $2::regclass`,
			want.con, want.rel).Scan(&def); err != nil {
			t.Fatalf("constraint %s on %s: %v", want.con, want.rel, err)
		}
		if !strings.Contains(def, want.def) {
			t.Errorf("constraint %s = %q, want it to bound %s", want.con, def, want.def)
		}
	}
	var hasCol bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pg_attribute
		WHERE attrelid = 'runs'::regclass AND attname = 'trigger_id' AND NOT attisdropped)`).Scan(&hasCol); err != nil {
		t.Fatalf("runs.trigger_id: %v", err)
	}
	if !hasCol {
		t.Error("runs.trigger_id missing")
	}
}
