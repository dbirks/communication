package api

// ADR-0066 step 2's HTTP surface, against the scripted fakes the m4/issue-
// trigger tests use: the typed-input declaration on the revision and draft
// reads, the publish-time WARNING on validate and publish (the publish still
// succeeds — it is a warning), the issue trigger's mapping refusals as named
// 400s, and the missing-required-input refusal traveling from the store as
// the named 422 rather than a crash. The behaviour behind these — the
// resolution, the fill, the facts — is proven against real Postgres in
// internal/store/postgres/adr0066_trigger_inputs_test.go.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// a66IssuePlan is a compiled plan whose spec.inputs declares a required
// github_issue input with no default plus an optional branch with one. The
// annotation lives inside spec.inputs — the object the plan already copies
// verbatim — so this is exactly what a real compiler emits for such a
// document.
const a66IssuePlan = `{"version":"v1alpha1-plan-1","nodes":[],"inputs":{` +
	`"type":"object","required":["issue"],"properties":{` +
	`"issue":{"type":"object","x-communication-input":{"type":"github_issue","label":"Issue","help":"The issue to work on"}},` +
	`"base":{"type":"string","default":"main","x-communication-input":{"type":"branch","label":"Base branch"}}}}}`

func a66PlanJSON() json.RawMessage { return json.RawMessage(a66IssuePlan) }

// --- the typed inputs on the reads ---------------------------------------

func TestADR0066RevisionReadExposesInputSpecs(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.pipes.revision.CompiledPlan = a66PlanJSON()

	rec := fx.get(t, "http://localhost:8080/api/v1/revisions/"+m4UUID)
	if rec.Code != http.StatusOK {
		t.Fatalf("get revision = %d: %s", rec.Code, rec.Body)
	}
	var view RevisionView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode revision: %v", err)
	}
	if len(view.InputSpecs) != 2 {
		t.Fatalf("input_specs = %s, want the two declared inputs", rec.Body)
	}
	// Sorted by name, ADR-0066; required/default/label from the schema, type
	// from the annotation.
	base, issue := view.InputSpecs[0], view.InputSpecs[1]
	if base.Name != "base" || base.Type != "branch" || base.Label != "Base branch" ||
		base.Required || base.Default != "main" {
		t.Errorf("spec[0] = %+v, want base/branch/not-required/default main", base)
	}
	if issue.Name != "issue" || issue.Type != "github_issue" || issue.Label != "Issue" ||
		issue.Help != "The issue to work on" || !issue.Required || issue.Default != nil {
		t.Errorf("spec[1] = %+v, want issue/github_issue/required/no default", issue)
	}
	// The raw wire member, since the UI reads `input_specs` from
	// schema.d.ts off exactly this name.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if _, has := raw["input_specs"]; !has {
		t.Errorf("revision body carries no input_specs member: %s", rec.Body)
	}
}

func TestADR0066DraftReadExposesInputSpecs(t *testing.T) {
	fx := m4Server(t)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "valid",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), DigestScope: "v1alpha1-canonical-1",
		Version: 1, InputSpecs: InputSpecsFromPlan(a66PlanJSON())}

	rec := fx.get(t, "http://localhost:8080/api/v1/drafts/"+m4UUID2)
	if rec.Code != http.StatusOK {
		t.Fatalf("get draft = %d: %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(),
		`"input_specs":[{"name":"base","type":"branch","label":"Base branch","required":false,"default":"main"},`+
			`{"name":"issue","type":"github_issue","label":"Issue","help":"The issue to work on","required":true}]`) {
		t.Errorf("draft body lacks the sorted input_specs declaration: %s", rec.Body)
	}
}

func TestADR0066EmptyInputSpecsIsAnArrayNotNull(t *testing.T) {
	fx := m4Server(t)
	fx.pipes.revision = RevisionView{ID: m4UUID, PipelineID: m4UUID, RevisionNumber: 1,
		VersionLabel: "1.0.0", APIVersion: "communication.dev/v1alpha1",
		CompiledPlan: json.RawMessage(`{"nodes":[]}`), Status: "published"}
	rec := fx.get(t, "http://localhost:8080/api/v1/revisions/"+m4UUID)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"input_specs":[]`) {
		t.Fatalf("plan with no inputs = %d %s, want input_specs:[]", rec.Code, rec.Body)
	}
}

// --- the publish-time warning --------------------------------------------

// a66Store adds the optional TriggerFactStore face to the scripted pipelines.
type a66Store struct {
	*m4Pipelines
	facts    []TriggerFillFacts
	factsErr error
	calls    int
}

func (s *a66Store) ListPipelineTriggerFacts(context.Context, Caller, string) ([]TriggerFillFacts, error) {
	s.calls++
	return s.facts, s.factsErr
}

func a66Server(t *testing.T, facts []TriggerFillFacts, factsErr error) *m4Fixture {
	t.Helper()
	fx := m4Server(t)
	// The wrapper embeds the scripted fake, so every assertion still reads
	// fx.pipes — only the mounted store grows the optional TriggerFactStore
	// face. (Re-registering on the m4Server instance would panic the route
	// mux, so the test gets its own server.)
	store := &a66Store{m4Pipelines: fx.pipes, facts: facts, factsErr: factsErr}
	rebuilt := newTestServer(t, nil, fakeReadiness{expected: 5}, AuthenticatorFunc(
		func(*http.Request) (*Principal, error) { return fx.prin, nil }))
	RegisterPipelines(rebuilt, store, fx.defs)
	fx.s = rebuilt
	return fx
}

func a66ValidOutcome() ValidationOutcome {
	return ValidationOutcome{
		Body:              ValidateResponse{Valid: true, DigestScope: "v1alpha1-canonical-1"},
		CanonicalDocument: json.RawMessage(`{"kind":"Pipeline"}`),
		RevisionDigest:    m4FullDigest,
		CompiledPlan:      a66PlanJSON(),
		PlanDigest:        m4FullDigest,
		DigestScope:       "v1alpha1-canonical-1",
	}
}

var a66ScheduleFact = TriggerFillFacts{Kind: "schedule", ID: "s-1", ProjectID: "p-1",
	Name: "* * * * *", Fills: []string{}}
var a66IssueTriggerFact = TriggerFillFacts{Kind: "issue", ID: "t-1", ProjectID: "p-1",
	Name: "octo/widgets #opened", Fills: []string{"issue"}}

// a66GoalRepoPlan is the reviewed 1j document: `goal` (long_text) and
// `repository` (text) are required with no default next to the required
// `issue`; only `revision` carries a default. No annotation is needed for
// the rule — required-without-default is JSON Schema's own reading.
const a66GoalRepoPlan = `{"version":"v1alpha1-plan-1","nodes":[],"inputs":{` +
	`"type":"object","required":["goal","issue","repository"],"properties":{` +
	`"goal":{"type":"string","x-communication-input":{"type":"long_text","label":"Goal"}},` +
	`"issue":{"type":"object","x-communication-input":{"type":"github_issue","label":"Issue"}},` +
	`"repository":{"type":"string","x-communication-input":{"type":"text","label":"Repository"}},` +
	`"revision":{"type":"string","default":"main","x-communication-input":{"type":"branch","label":"Branch"}}}}}`

// The review's gap, pinned server-side: an ISSUE trigger that fills only the
// issue input leaves every OTHER required input with no default unfillable,
// and each one is its own warning. The rule is not schedule-only, and the
// repository the assignment pins fills nothing implicitly (ADR-0066 note).
func TestADR0066ValidateWarnsPerRequiredInputPerTriggerIncludingIssueTriggers(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{a66IssueTriggerFact}, nil)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	outcome := a66ValidOutcome()
	outcome.CompiledPlan = json.RawMessage(a66GoalRepoPlan)
	fx.defs.outcome = outcome

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("validate = %d: %s", rec.Code, rec.Body)
	}
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode validate body: %v", err)
	}
	if !body.Valid {
		t.Errorf("valid = false; warnings must not flip the verdict: %s", rec.Body)
	}
	// `issue` is filled by the trigger; `revision` has a default; `goal` and
	// `repository` are each the trigger's own warning — TWO findings, one per
	// unfillable required input, both naming the issue trigger.
	if len(body.Warnings) != 2 {
		t.Fatalf("warnings = %d, want goal + repository for the issue trigger: %s",
			len(body.Warnings), rec.Body)
	}
	for i, want := range []struct{ triggerID, kind, input string }{
		{"t-1", "issue", "goal"},
		{"t-1", "issue", "repository"},
	} {
		w := body.Warnings[i]
		if w.Code != CodeInputUnfillableByTrigger || w.TriggerID != want.triggerID ||
			w.TriggerKind != want.kind || w.Input != want.input {
			t.Errorf("warning[%d] = %+v, want %s/%s named by trigger %s (%s)",
				i, w, want.kind, want.input, want.triggerID, want.kind)
		}
		if !strings.Contains(w.Message, want.input) {
			t.Errorf("warning[%d].message does not name %q: %s", i, want.input, w.Message)
		}
	}
}

// Two triggers, several inputs: the body is sorted (trigger, input), so the
// UI rows and any diff of the wire body are stable across reads.
func TestADR0066WarningsAreSortedByTriggerThenInput(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{a66IssueTriggerFact, a66ScheduleFact}, nil)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	outcome := a66ValidOutcome()
	outcome.CompiledPlan = json.RawMessage(a66GoalRepoPlan)
	fx.defs.outcome = outcome

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The schedule fills nothing → goal, issue, repository; the issue trigger
	// fills `issue` → goal, repository. Five findings, grouped by trigger id
	// (s-1 before t-1) and sorted by input inside each trigger.
	got := make([]string, 0, len(body.Warnings))
	for _, w := range body.Warnings {
		if w.Code != CodeInputUnfillableByTrigger {
			t.Errorf("unexpected warning code %q: %+v", w.Code, w)
		}
		got = append(got, w.TriggerID+"/"+w.Input)
	}
	want := []string{"s-1/goal", "s-1/issue", "s-1/repository", "t-1/goal", "t-1/repository"}
	if len(got) != len(want) {
		t.Fatalf("warnings = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("warnings = %v, want %v (sorted trigger, input)", got, want)
		}
	}
}

func TestADR0066ValidateWarnsWhenTheScheduleCannotFillARequiredIssueInput(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{a66ScheduleFact}, nil)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	fx.defs.outcome = a66ValidOutcome()

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("validate = %d: %s", rec.Code, rec.Body)
	}
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode validate body: %v", err)
	}
	if !body.Valid {
		t.Errorf("valid = false; a warning must not flip the verdict: %s", rec.Body)
	}
	if len(body.Warnings) != 1 {
		t.Fatalf("warnings = %d, want the one schedule/issue pair: %s", len(body.Warnings), rec.Body)
	}
	w := body.Warnings[0]
	if w.Code != CodeInputUnfillableByTrigger || w.TriggerID != "s-1" || w.TriggerKind != "schedule" ||
		w.Input != "issue" || !strings.Contains(w.Message, "issue") {
		t.Errorf("warning = %+v, want input_unfillable_by_trigger naming the schedule and the issue input", w)
	}
	// `base` has a default; it must not warn. `issue` is the only finding.
	if got := strings.Count(rec.Body.String(), CodeInputUnfillableByTrigger); got != 1 {
		t.Errorf("body carries %d warnings, want exactly 1", got)
	}
	// The stored validation body carries the warnings too (the draft echo).
	if len(fx.pipes.recordedVal.Body.Warnings) != 1 {
		t.Errorf("recorded validation warnings = %d, want 1", len(fx.pipes.recordedVal.Body.Warnings))
	}
}

func TestADR0066ValidateQuietWhenTheIssueTriggerFillsTheInput(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{a66ScheduleFact, a66IssueTriggerFact}, nil)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	fx.defs.outcome = a66ValidOutcome()

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The rule is per (trigger, input): the issue trigger fills `issue`, the
	// schedule still cannot — so exactly the schedule's warning stands.
	if len(body.Warnings) != 1 || body.Warnings[0].TriggerKind != "schedule" {
		t.Fatalf("warnings = %+v, want only the schedule's", body.Warnings)
	}
	if !body.Valid {
		t.Errorf("valid = false, want true")
	}
}

// errA66Facts is the trigger-table read failing under the validate.
var errA66Facts = errors.New("boom: schedules table offline")

func TestADR0066ValidateFactsFailureDegradesToNoWarnings(t *testing.T) {
	fx := a66Server(t, nil, errA66Facts)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	fx.defs.outcome = a66ValidOutcome()

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("a trigger-table read failure must not fail the validate: %d %s", rec.Code, rec.Body)
	}
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Valid || body.Warnings == nil || len(body.Warnings) != 0 {
		t.Errorf("body = %s, want valid with an empty warnings array", rec.Body)
	}
}

func TestADR0066PublishSucceedsAndCarriesTheWarning(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{a66ScheduleFact}, nil)
	digest := m4FullDigest
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "valid",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1, RevisionDigest: &digest}
	fx.pipes.pipeline = PipelineView{ID: m4UUID, Slug: "feature-development", LatestRevisionNumber: 1}
	fx.pipes.publishedOut = RevisionView{ID: m4UUID, PipelineID: m4UUID, RevisionNumber: 2,
		VersionLabel: "2.0.0", APIVersion: "communication.dev/v1alpha1",
		CompiledPlan: a66PlanJSON(), Status: "published"}

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish",
		`{"version":1,"version_label":"2.0.0"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("publish = %d: %s — a warning must not refuse the publish", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), CodeInputUnfillableByTrigger) {
		t.Errorf("publish response carries no %s warning: %s", CodeInputUnfillableByTrigger, rec.Body)
	}
}

// --- the trigger-mapping refusals (400s) ---------------------------------

func TestADR0066IssueTriggerMappingRefusals(t *testing.T) {
	t.Run("ambiguous store answer is a named 400", func(t *testing.T) {
		store := &itStore{createErr: ErrIssueTriggerInputAmbiguous}
		s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", true)
		rec := itSend(t, s, "POST", "http://localhost:8080/api/v1/projects/"+itProjectID+"/issue-triggers",
			IssueTriggerCreateInput{AssignmentID: itAssignID, RepositoryID: itRepoID, Event: "opened"})
		if rec.Code != http.StatusBadRequest ||
			!strings.Contains(rec.Body.String(), IssueTriggerCodeInputAmbiguous) {
			t.Fatalf("ambiguous create = %d %s, want 400 %s", rec.Code, rec.Body, IssueTriggerCodeInputAmbiguous)
		}
	})
	t.Run("unmappable store answer is a named 400", func(t *testing.T) {
		store := &itStore{createErr: ErrIssueTriggerInputUnmappable}
		s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", true)
		issueInput := "goal"
		in := IssueTriggerCreateInput{AssignmentID: itAssignID, RepositoryID: itRepoID, Event: "opened"}
		in.IssueInput = issueInput
		rec := itSend(t, s, "POST", "http://localhost:8080/api/v1/projects/"+itProjectID+"/issue-triggers", in)
		if rec.Code != http.StatusBadRequest ||
			!strings.Contains(rec.Body.String(), IssueTriggerCodeInputUnmappable) {
			t.Fatalf("unmappable create = %d %s, want 400 %s", rec.Code, rec.Body, IssueTriggerCodeInputUnmappable)
		}
	})
	t.Run("a malformed issue_input never reaches the store", func(t *testing.T) {
		for _, bad := range []string{"Bad Name", "9lives", strings.Repeat("x", 64)} {
			store := &itStore{}
			s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", true)
			in := IssueTriggerCreateInput{AssignmentID: itAssignID, RepositoryID: itRepoID, Event: "opened",
				IssueInput: bad}
			rec := itSend(t, s, "POST", "http://localhost:8080/api/v1/projects/"+itProjectID+"/issue-triggers", in)
			if rec.Code != http.StatusBadRequest ||
				!strings.Contains(rec.Body.String(), IssueTriggerCodeIssueInputShape) {
				t.Fatalf("issue_input %q = %d %s, want 400 %s", bad, rec.Code, rec.Body, IssueTriggerCodeIssueInputShape)
			}
			if len(store.created) != 0 {
				t.Fatalf("store saw a create for %q; the shape refusal is before the store", bad)
			}
		}
	})
	t.Run("patch can clear and set issue_input", func(t *testing.T) {
		store := &itStore{current: IssueTriggerView{ID: itTriggerID, ProjectID: itProjectID,
			AssignmentID: itAssignID, RepositoryID: itRepoID, Event: "opened", Labels: []string{},
			Inputs: json.RawMessage(`{}`), IssueInput: "issue", Enabled: true, Version: 1, MyRole: "maintainer"}}
		s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", true)
		clear := ""
		rec := itSend(t, s, "PATCH", "http://localhost:8080/api/v1/issue-triggers/"+itTriggerID,
			IssueTriggerPatchInput{Version: 1, IssueInput: &clear})
		if rec.Code != http.StatusOK {
			t.Fatalf("clearing patch = %d %s, want 200", rec.Code, rec.Body)
		}
		if len(store.patched) != 1 || store.patched[0].IssueInput == nil || *store.patched[0].IssueInput != "" {
			t.Fatalf("store patches = %+v, want one with IssueInput=\"\" (clear to the default)", store.patched)
		}
	})
}

// --- the run start keeps the named refusal, not a crash -------------------

func TestADR0066RunStartMissingRequiredInputIsTheNamed422(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.runs.createErr = &RunInputsInvalid{
		Detail: "1 input(s) failed validation against the pinned revision",
		Errors: []ValidateError{{Code: "missing_input", Source: "run",
			Message: `input "issue" is required by the pinned revision and was not submitted`}},
	}
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"pipeline_revision_id":"`+m4UUID+`"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("run start = %d %s, want the named 422", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "missing_input") ||
		!strings.Contains(rec.Body.String(), `input \"issue\" is required`) {
		t.Errorf("422 body does not name the missing input: %s", rec.Body)
	}
}

// The rcn-1j review's UI defect was a sentence nobody could act on: the Inputs
// tab printed `message` verbatim — `trigger server #labeled (issue,
// 01a19dd0-58ef-…) cannot fill required input "issue" … (ADR-0066)` — so the
// author saw an internal uuid, a repository handle belonging to the assignment
// above the row, and an ADR number. The warning therefore carries its parts as
// FIELDS (`trigger_kind`, `trigger_label`, `input`), and the label is the
// repository-free word the row heading already uses.
func TestADR0066WarningsCarryTheirPartsAsFields(t *testing.T) {
	fx := a66Server(t, []TriggerFillFacts{
		// The production read: Name is `<repo> #<event>`, Label is the event.
		{Kind: "issue", ID: "t-1", ProjectID: "p-1", Name: "server #labeled",
			Label: "labeled", Fills: []string{"issue"}},
		// A fact table that fills no Label still yields the event word, read
		// off the handle it did provide.
		{Kind: "issue", ID: "t-2", ProjectID: "p-1", Name: "widgets #opened",
			Fills: []string{"issue"}},
		a66ScheduleFact,
	}, nil)
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual",
		SourceSHA256: strings.Repeat("0", 64), Version: 1}
	outcome := a66ValidOutcome()
	outcome.CompiledPlan = json.RawMessage(a66GoalRepoPlan)
	fx.defs.outcome = outcome

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	type part struct{ trigger, kind, label, input string }
	got := make(map[part]bool)
	for _, w := range body.Warnings {
		if w.Code != CodeInputUnfillableByTrigger {
			t.Fatalf("unexpected code %q: %+v", w.Code, w)
		}
		if w.TriggerKind == "" || w.TriggerLabel == "" || w.Input == "" {
			t.Errorf("warning %s/%s is missing a structured part: %+v", w.TriggerID, w.Input, w)
		}
		got[part{w.TriggerID, w.TriggerKind, w.TriggerLabel, w.Input}] = true
	}
	for _, want := range []part{
		{"t-1", "issue", "labeled", "goal"},
		{"t-1", "issue", "labeled", "repository"},
		{"t-2", "issue", "opened", "goal"},
		{"s-1", "schedule", "* * * * *", "goal"},
	} {
		if !got[want] {
			t.Errorf("no warning for %+v; got %d warnings: %+v", want, len(body.Warnings), body.Warnings)
		}
	}
	// The label never repeats the repository: that is the row heading's job,
	// and a warning that restated it read like a different trigger.
	for _, w := range body.Warnings {
		if strings.Contains(w.TriggerLabel, " ") && strings.Contains(w.TriggerLabel, "#") {
			t.Errorf("trigger_label %q still carries the repository handle: %+v", w.TriggerLabel, w)
		}
	}
}
