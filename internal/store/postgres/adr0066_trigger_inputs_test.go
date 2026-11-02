package postgres

// ADR-0066 step 2 against a PostgreSQL that actually ran 00024: the
// trigger→input mapping stored on the trigger row (default = the single
// github_issue input; several = a refused write), the fired run carrying the
// issue object {number, title, body, url, repo} under the mapped name, the
// fill facts behind the publish-time warning, the typed-input view on the
// revision and draft reads, and the missing-required-input refusal staying a
// named error at schedule create and schedule fire. The HTTP shapes ride on
// these facts; internal/api/adr0066_inputs_test.go pins them.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// a66IssueOnlyInputs is a spec.inputs block with ONE github_issue-typed input
// (required, no default) and an optional branch defaulting to main — the
// shape where the trigger's mapping is implicit.
const a66IssueOnlyInputs = `{"type":"object","required":["issue"],"properties":{` +
	`"issue":{"type":"object","x-communication-input":{"type":"github_issue","label":"Issue","help":"The issue to work on"}},` +
	`"base":{"type":"string","default":"main","x-communication-input":{"type":"branch"}}}}`

// a66TwoIssueInputs has two github_issue inputs, so an unmapped trigger is
// ambiguous and the write must name the one the issue fills.
const a66TwoIssueInputs = `{"type":"object","properties":{` +
	`"first":{"type":"object","x-communication-input":{"type":"github_issue"}},` +
	`"second":{"type":"object","x-communication-input":{"type":"github_issue"}},` +
	`"goal":{"type":"string"}}}`

// a66TriggeredIssue is the fired issue every fill test projects.
var a66TriggeredIssue = itWireIssue{
	Number: 42, Title: "Crash on boot", Body: "it crashes", State: "open",
	HTMLURL: "https://github.com/octo/widgets/issues/42",
}

// a66IssueTrigger authors one enabled trigger through the real create path.
func a66IssueTrigger(t *testing.T, f *itFixture, ctx context.Context, inputs json.RawMessage, issueInput string) IssueTrigger {
	t.Helper()
	it, err := f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: "opened", Labels: []string{}, Inputs: inputs, IssueInput: issueInput,
		Enabled: boolPtr(true), CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("create issue trigger (issue_input=%q, inputs=%s): %v", issueInput, inputs, err)
	}
	return it
}

// a66FireTick fires the fixture's triggers at a66TriggeredIssue created an
// hour after the trigger (the no-backfill arm stays honest).
func a66FireTick(t *testing.T, f *itFixture, ctx context.Context, trigger IssueTrigger) string {
	t.Helper()
	issue := a66TriggeredIssue
	issue.CreatedAt = trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339)
	issue.UpdatedAt = trigger.CreatedAt.Add(2 * time.Hour).Format(time.RFC3339)
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("tick = (%d, %v), want one fire", fired, err)
	}
	runID, kind := itIssueRunFor(t, ctx, f, "octo/widgets#42")
	if kind != "issue" {
		t.Fatalf("fired run kind = %s, want issue", kind)
	}
	return runID
}

// a66RunInputObject reads one run input and asserts it is the ADR-0066 issue
// value shape over the fired issue.
func a66RunInputObject(t *testing.T, ctx context.Context, f *itFixture, runID, name string) map[string]any {
	t.Helper()
	value, kind := itIssueInputRaw(t, ctx, f, runID, name)
	if kind != "object" {
		t.Fatalf("run input %s = %s of jsonb type %s, want an object", name, value, kind)
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(value), &obj); err != nil {
		t.Fatalf("decode %s input %q: %v", name, value, err)
	}
	if obj["number"] != float64(42) || obj["title"] != "Crash on boot" || obj["body"] != "it crashes" ||
		obj["url"] != "https://github.com/octo/widgets/issues/42" || obj["repo"] != "octo/widgets" {
		t.Errorf("issue input %s = %v, want {42, Crash on boot, it crashes, the url, octo/widgets}", name, obj)
	}
	return obj
}

// TestADR0066IssueTriggerFillsTheSingleIssueInputByDefault: the whole fire
// promise. A required github_issue input with no default is ACCEPTED at
// create (the mapping, not a template, is what fills it — the sample-issue
// projection runs the same validator a POST /runs would), the row stores no
// explicit mapping, and the fired run carries the issue object with a JSON
// number `number` plus the unannotated default still applying for `base`.
func TestADR0066IssueTriggerFillsTheSingleIssueInputByDefault(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	f.itPublishPlan(t, ctx, "2.0.0", json.RawMessage(a66IssueOnlyInputs))

	trigger := a66IssueTrigger(t, f, ctx, json.RawMessage(`{}`), "")
	if trigger.IssueInput != "" {
		t.Errorf("stored mapping = %q, want the implicit default (empty)", trigger.IssueInput)
	}

	runID := a66FireTick(t, f, ctx, trigger)
	a66RunInputObject(t, ctx, f, runID, "issue")
	value, kind := itIssueInputRaw(t, ctx, f, runID, "base")
	if kind != "string" || value != `"main"` {
		t.Errorf("run input base = %s of type %s, want the schema default \"main\"", value, kind)
	}
	var origin string
	if err := f.pool.QueryRow(ctx,
		`SELECT origin FROM run_inputs WHERE run_id = $1::uuid AND name = 'base'`, runID).Scan(&origin); err != nil {
		t.Fatalf("read base's origin: %v", err)
	}
	if origin != "default" {
		t.Errorf("base origin = %s, want default", origin)
	}
}

// TestADR0066AmbiguousMappingIsRefusedAtTheWrite: several github_issue inputs
// make the default a guess, so create refuses until the trigger names one;
// a name outside the issue-typed set refuses too; and the named mapping is
// what the fire fills.
func TestADR0066AmbiguousMappingIsRefusedAtTheWrite(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	f.itPublishPlan(t, ctx, "3.0.0", json.RawMessage(a66TwoIssueInputs))

	_, err := f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: "opened", Inputs: json.RawMessage(`{}`), Enabled: boolPtr(true), CreatedBy: f.userID,
	})
	if !errors.Is(err, ErrIssueTriggerInputAmbiguous) {
		t.Fatalf("unmapped create = %v, want %v", err, ErrIssueTriggerInputAmbiguous)
	}
	if !strings.Contains(err.Error(), "first") || !strings.Contains(err.Error(), "second") {
		t.Errorf("ambiguous error does not name the candidates: %v", err)
	}
	if _, err := f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: "opened", Inputs: json.RawMessage(`{}`), IssueInput: "goal",
		Enabled: boolPtr(true), CreatedBy: f.userID,
	}); !errors.Is(err, ErrIssueTriggerInputUnmappable) {
		t.Fatalf("create with issue_input=goal = %v, want %v", err, ErrIssueTriggerInputUnmappable)
	}

	trigger := a66IssueTrigger(t, f, ctx, json.RawMessage(`{}`), "second")
	var stored string
	if err := f.pool.QueryRow(ctx,
		`SELECT COALESCE(issue_input, '<null>') FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).
		Scan(&stored); err != nil || stored != "second" {
		t.Fatalf("stored issue_input = %q (err %v), want \"second\"", stored, err)
	}

	runID := a66FireTick(t, f, ctx, trigger)
	a66RunInputObject(t, ctx, f, runID, "second")
	// The unmapped issue input is simply absent — filling BOTH on a guess is
	// the accident the refused write exists to prevent.
	err = f.pool.QueryRow(ctx,
		`SELECT 1 FROM run_inputs WHERE run_id = $1::uuid AND name = 'first'`, runID).Scan(new(int))
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("run carries the unmapped input first (err %v); the fire must fill only the mapped one", err)
	}
}

// TestADR0066MappingUpdateClearsAndRevalidates: PATCH-level rules on the
// stored mapping — clearing back to the implicit default is refused while
// the pinned revision declares two issue inputs, and lands once the pin has
// exactly one, which the next fire then fills.
func TestADR0066MappingUpdateClearsAndRevalidates(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	f.itPublishPlan(t, ctx, "3.1.0", json.RawMessage(a66TwoIssueInputs))
	trigger := a66IssueTrigger(t, f, ctx, json.RawMessage(`{}`), "first")

	clear := ""
	if _, err := f.triggers.UpdateIssueTrigger(ctx, UpdateIssueTriggerInput{
		ID: trigger.ID, ExpectedVersion: trigger.Version, IssueInput: &clear,
	}); !errors.Is(err, ErrIssueTriggerInputAmbiguous) {
		t.Fatalf("clear under two issue inputs = %v, want %v", err, ErrIssueTriggerInputAmbiguous)
	}

	f.itPublishPlan(t, ctx, "3.1.1", json.RawMessage(a66IssueOnlyInputs))
	updated, err := f.triggers.UpdateIssueTrigger(ctx, UpdateIssueTriggerInput{
		ID: trigger.ID, ExpectedVersion: trigger.Version, IssueInput: &clear,
	})
	if err != nil {
		t.Fatalf("clear under a single issue input: %v", err)
	}
	if updated.IssueInput != "" {
		t.Errorf("updated mapping = %q, want cleared", updated.IssueInput)
	}
	// The cleared row resolves its default from the NEW pin at fire time: the
	// required issue input rides the same {number,title,body,url,repo} object.
	runID := a66FireTick(t, f, ctx, updated)
	a66RunInputObject(t, ctx, f, runID, "issue")
}

// TestADR0066MissingRequiredInputIsANamedErrorNotACrash: the run start keeps
// its authority against real Postgres. Create refuses the schedule whose
// inputs cannot satisfy the pinned revision with the same named validation
// body a manual POST /runs answers; and a schedule that fell behind its pin
// (a re-pin added the requirement) fails its fire with the named code,
// creates no run, and does not take the tick down with it.
func TestADR0066MissingRequiredInputIsANamedErrorNotACrash(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	strict := `{"type":"object","required":["goal"],"properties":{"goal":{"type":"string"}}}`
	f.itPublishPlan(t, ctx, "4.0.0", json.RawMessage(strict))
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM schedules WHERE project_id = $1`, f.projectID)
	})

	scheds := &ScheduleStore{Pool: f.pool, Runs: f.runs}
	_, err := scheds.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment, CronExpr: "0 3 * * *",
		Inputs: json.RawMessage(`{}`), Enabled: boolPtr(true), CreatedBy: f.userID,
	})
	var invalid *api.RunInputsInvalid
	if !errors.As(err, &invalid) {
		t.Fatalf("schedule create with the gap = %v, want *api.RunInputsInvalid", err)
	}
	if len(invalid.Errors) == 0 || invalid.Errors[0].Code != "missing_input" ||
		!strings.Contains(invalid.Errors[0].Message, `"goal"`) {
		t.Errorf("named refusal = %+v, want missing_input naming \"goal\"", invalid.Errors)
	}

	// A schedule that fits TODAY's pin, then meets a stricter one.
	f.itPublishPlan(t, ctx, "4.1.0", json.RawMessage(`{"type":"object","required":["goal"],"properties":{"goal":{"type":"string"}}}`))
	var schedID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO schedules (project_id, assignment_id, cron_expr, inputs, enabled, next_run_at, created_by)
		VALUES ($1, $2, '* * * * *', '{"goal":"nightly"}'::jsonb, true, $3, $4) RETURNING id`,
		f.projectID, f.assignment, time.Now().UTC().Add(-time.Minute), f.userID).Scan(&schedID); err != nil {
		t.Fatalf("insert due schedule: %v", err)
	}
	f.itPublishPlan(t, ctx, "4.2.0", json.RawMessage(`{"type":"object","required":["goal","extra"],"properties":{`+
		`"goal":{"type":"string"},"extra":{"type":"string"}}}`))

	fired, err := scheds.TickSchedules(ctx, time.Now().UTC())
	if fired != 0 {
		t.Fatalf("tick fired %d runs, want 0 — the fire must be refused, not completed on the gap", fired)
	}
	var staleInvalid *api.RunInputsInvalid
	if err == nil || !errors.As(err, &staleInvalid) {
		t.Fatalf("tick error = %v, want the named run-input refusal", err)
	}
	named := false
	for _, e := range staleInvalid.Errors {
		if e.Code == "missing_input" && strings.Contains(e.Message, `"extra"`) {
			named = true
		}
	}
	if !named {
		t.Fatalf("tick refusal = %+v, want missing_input naming \"extra\"", staleInvalid.Errors)
	}
	var runs int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE trigger_kind = 'schedule' AND project_id = $1`, f.projectID).Scan(&runs); err != nil {
		t.Fatalf("count schedule runs: %v", err)
	}
	if runs != 0 {
		t.Errorf("schedule runs created = %d, want 0 (the named refusal IS the failure, never a crash or a half-run)", runs)
	}
}

// TestADR0066RevisionAndDraftReadsExposeInputSpecs: the API-side view is
// derived from the stored compiled plan — through the real
// pipeline_drafts → pipeline_revisions publish path and the caller-scoped
// reads, not a fake.
func TestADR0066RevisionAndDraftReadsExposeInputSpecs(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	revID := f.itPublishPlan(t, ctx, "5.0.0", json.RawMessage(a66IssueOnlyInputs))
	store := api.PipelineStore(APIPipelineStore{S: f.pipelines})
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}

	rev, err := store.GetRevision(ctx, caller, revID)
	if err != nil {
		t.Fatalf("GetRevision: %v", err)
	}
	a66CheckSpecs(t, rev.InputSpecs)

	var draftID string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM pipeline_drafts WHERE published_revision_id = $1::uuid`, revID).
		Scan(&draftID); err != nil {
		t.Fatalf("find the published draft: %v", err)
	}
	draft, err := store.GetDraft(ctx, caller, draftID)
	if err != nil {
		t.Fatalf("GetDraft: %v", err)
	}
	a66CheckSpecs(t, draft.InputSpecs)
}

func a66CheckSpecs(t *testing.T, specs []compiler.InputSpec) {
	t.Helper()
	if len(specs) != 2 {
		t.Fatalf("input specs = %+v, want the two declared inputs sorted by name", specs)
	}
	base, issue := specs[0], specs[1]
	if base.Name != "base" || base.Type != "branch" || base.Required || base.Default != "main" {
		t.Errorf("base spec = %+v, want branch/not-required/default main", base)
	}
	if issue.Name != "issue" || issue.Type != "github_issue" || issue.Label != "Issue" ||
		issue.Help != "The issue to work on" || !issue.Required || issue.Default != nil {
		t.Errorf("issue spec = %+v, want github_issue/required/label+help", issue)
	}
}

// TestADR0066TriggerFillFactsBackThePublishWarning: the store-side read the
// validate/publish WARNING computes from — the pipeline's assigned triggers,
// the names each trigger's own inputs carry, the issue trigger's mapping
// carried UNRESOLVED (api.InputUnfillableWarnings applies it to the specs
// under validation), and a disabled trigger out.
func TestADR0066TriggerFillFactsBackThePublishWarning(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	both := `{"type":"object","required":["issue","goal"],"properties":{` +
		`"issue":{"type":"object","x-communication-input":{"type":"github_issue"}},` +
		`"goal":{"type":"string"}}}`
	f.itPublishPlan(t, ctx, "6.0.0", json.RawMessage(both))
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM schedules WHERE project_id = $1`, f.projectID)
	})

	// The issue trigger maps `issue` by default and templates `goal`.
	it := a66IssueTrigger(t, f, ctx, json.RawMessage(`{"goal":"{{issue.title}}"}`), "")
	var schedID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO schedules (project_id, assignment_id, cron_expr, inputs, enabled, next_run_at, created_by)
		VALUES ($1, $2, '30 4 * * *', '{"goal":"nightly scan"}'::jsonb, true, $3, $4) RETURNING id`,
		f.projectID, f.assignment, time.Now().UTC().Add(-time.Hour), f.userID).Scan(&schedID); err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO schedules (project_id, assignment_id, cron_expr, inputs, enabled, next_run_at, created_by)
		 VALUES ($1, $2, '0 5 * * *', '{}'::jsonb, false, $3, $4)`,
		f.projectID, f.assignment, time.Now().UTC().Add(-time.Hour), f.userID); err != nil {
		t.Fatalf("insert disabled schedule: %v", err)
	}

	store := APIPipelineStore{S: f.pipelines}
	facts, err := store.ListPipelineTriggerFacts(ctx, api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}, f.pipelineID)
	if err != nil {
		t.Fatalf("ListPipelineTriggerFacts: %v", err)
	}
	if len(facts) != 2 {
		t.Fatalf("facts = %+v, want the enabled issue trigger and schedule (disabled out)", facts)
	}
	var byKind = map[string]api.TriggerFillFacts{}
	for _, fact := range facts {
		byKind[fact.Kind] = fact
	}
	sched, ok := byKind["schedule"]
	if !ok {
		t.Fatalf("no schedule fact in %+v", facts)
	}
	if strings.Join(sched.Fills, ",") != "goal" || sched.ID != schedID || sched.ProjectID != f.projectID ||
		!strings.Contains(sched.Name, "30 4") {
		t.Errorf("schedule fact = %+v, want fills [goal], the row's id/project and the cron in its name", sched)
	}
	iss, ok := byKind["issue"]
	if !ok {
		t.Fatalf("no issue fact in %+v", facts)
	}
	if strings.Join(iss.Fills, ",") != "goal" || iss.ID != it.ID || iss.IssueInput != "" {
		t.Errorf("issue fact = %+v, want fills [goal] (the trigger's own template) and the default "+
			"issue_input carried for the warning to resolve against the specs under validation", iss)
	}
	if !strings.Contains(iss.Name, "octo/widgets") {
		t.Errorf("issue trigger name = %q, want it to name the watched repository", iss.Name)
	}
}
