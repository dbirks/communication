package postgres

// The ADR-0066 fill-fact read (pipeline_trigger_facts.go) against a PostgreSQL
// that ran the migrations, all the way to the WARNING the pipeline editor
// shows: the read carries each trigger's MAPPING, and
// api.InputUnfillableWarnings applies that mapping to the input specs under
// validation. The rcn-1j lab is the case that pins the scope — an assignment
// pinned to a revision with no github_issue input at all, an issue trigger
// whose template inputs are the revision's own, and a draft that has just
// added the workflow's first `issue` input plus a `ticket` nothing fills.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// a66LabR1Inputs is what the lab's published r1 declared: `goal` and
// `repository` required with no default, `revision` optional — and NO
// github_issue input anywhere, the way the shipped template looked before
// anyone authored one.
const a66LabR1Inputs = `{"type":"object","required":["goal","repository"],"properties":{` +
	`"goal":{"type":"string","x-communication-input":{"type":"long_text","label":"Goal"}},` +
	`"repository":{"type":"string","x-communication-input":{"type":"text","label":"Repository"}},` +
	`"revision":{"type":"string","default":"main","x-communication-input":{"type":"branch","label":"Branch"}}}}`

// a66LabR2Inputs is the DRAFT the author saves on top of it: the same inputs,
// plus a required `issue` (github_issue) and a required `ticket` (text) that
// no trigger names.
const a66LabR2Inputs = `{"type":"object","required":["goal","issue","repository","ticket"],"properties":{` +
	`"goal":{"type":"string","x-communication-input":{"type":"long_text","label":"Goal"}},` +
	`"issue":{"type":"object","x-communication-input":{"type":"github_issue","label":"GitHub issue"}},` +
	`"repository":{"type":"string","x-communication-input":{"type":"text","label":"Repository"}},` +
	`"revision":{"type":"string","default":"main","x-communication-input":{"type":"branch","label":"Branch"}},` +
	`"ticket":{"type":"string","x-communication-input":{"type":"text","label":"Ticket"}}}}`

func a66LabPlan(inputs string) json.RawMessage {
	return json.RawMessage(`{"version":"v1alpha1-plan-1","nodes":[],"inputs":` + inputs + `}`)
}

// TestADR0066FillFactsWarnAgainstTheDraftNotThePin reproduces the rcn-1j setup
// end to end on real rows: pin r1 (no issue input), attach an issue trigger
// that templates r1's own inputs, then author r2 with the single
// `github_issue` input and an unrelated required `ticket`. The answer for
// r2's specs is ONE warning — `ticket`. The draft's `issue` is filled by the
// trigger's default mapping (the single github_issue input) even though the
// revision the assignment is pinned to declares no such input: the pin is not
// a reason to call the draft's input unfillable.
func TestADR0066FillFactsWarnAgainstTheDraftNotThePin(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)

	// r1 published and the assignment pinned to it.
	f.itPublishPlan(t, ctx, "2.0.0", json.RawMessage(a66LabR1Inputs))
	// The trigger the lab seeds: it templates r1's inputs and maps no issue
	// input explicitly — there is none to map yet.
	it := a66IssueTrigger(t, f, ctx,
		json.RawMessage(`{"goal":"{{issue.title}}","repository":"octo/widgets"}`), "")
	// The draft lands as r2 in the store's own terms (the Inputs tab validates
	// the draft document; the pipeline_revisions row is what the reads see).
	f.itPublishPlan(t, ctx, "2.1.0", json.RawMessage(a66LabR2Inputs))

	store := APIPipelineStore{S: f.pipelines}
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	facts, err := store.ListPipelineTriggerFacts(ctx, caller, f.pipelineID)
	if err != nil {
		t.Fatalf("ListPipelineTriggerFacts: %v", err)
	}
	if len(facts) != 1 {
		t.Fatalf("facts = %+v, want the one enabled issue trigger", facts)
	}
	fact := facts[0]
	if fact.Kind != "issue" || fact.ID != it.ID {
		t.Fatalf("fact = %+v, want the issue trigger %s", fact, it.ID)
	}
	// The mapping travels as the trigger's own word, unresolved: the read does
	// not get to decide which input a draft's trigger fills from the pin's plan.
	if fact.IssueInput != "" {
		t.Errorf("fact.IssueInput = %q, want the empty default rule", fact.IssueInput)
	}
	if strings.Join(fact.Fills, ",") != "goal,repository" {
		t.Errorf("fact.Fills = %v, want the trigger's own template names only", fact.Fills)
	}
	if fact.Label != "opened" || !strings.Contains(fact.Name, "octo/widgets") {
		t.Errorf("fact = {Name:%q Label:%q}, want the repo handle and the bare event word",
			fact.Name, fact.Label)
	}

	// The warning over the DRAFT's specs (r2): only `ticket`.
	warnings := api.InputUnfillableWarnings(api.InputSpecsFromPlan(a66LabPlan(a66LabR2Inputs)), facts)
	if len(warnings) != 1 {
		t.Fatalf("warnings over the draft's specs = %+v, want the one ticket finding", warnings)
	}
	w := warnings[0]
	if w.Code != api.CodeInputUnfillableByTrigger || w.Input != "ticket" ||
		w.TriggerID != it.ID || w.TriggerKind != "issue" || w.TriggerLabel != "opened" {
		t.Errorf("warning = %+v, want input_unfillable_by_trigger for ticket named by the issue trigger", w)
	}

	// The same facts over what the pin itself declares: goal and repository are
	// templated, `revision` defaults — so r1 earns nothing, and the answer the
	// panel showed (an `issue` warning born of the pin's plan) cannot appear.
	if got := api.InputUnfillableWarnings(api.InputSpecsFromPlan(a66LabPlan(a66LabR1Inputs)), facts); len(got) != 0 {
		t.Errorf("warnings over the pinned revision's specs = %+v, want none", got)
	}
}

// TestADR0066FillFactsCarryAnExplicitMappingTheDraftLacks: the read carries the
// trigger's explicit `issue_input` even when the pinned revision could not
// resolve it, so the warning can say the honest thing — the mapping points at
// a name this workflow does not declare — instead of staying silent about a
// trigger that will stamp no issue when it fires.
func TestADR0066FillFactsCarryAnExplicitMappingTheDraftLacks(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	// The fixture's own seeded trigger (event opened, no template inputs) is
	// the row under test — nothing dropped and re-created.
	f.itPublishPlan(t, ctx, "2.0.0", json.RawMessage(a66LabR1Inputs))
	// An explicit mapping the pinned r1 cannot resolve is a refused WRITE
	// (issue_triggers.go), so author the row the way a re-pin leaves one: the
	// mapping names an input the pipeline does not declare.
	if _, err := f.pool.Exec(ctx,
		`UPDATE issue_triggers SET issue_input = 'issue' WHERE id = $1::uuid`, f.triggerID); err != nil {
		t.Fatalf("point the seeded trigger at an issue input: %v", err)
	}

	store := APIPipelineStore{S: f.pipelines}
	facts, err := store.ListPipelineTriggerFacts(ctx,
		api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}, f.pipelineID)
	if err != nil {
		t.Fatalf("ListPipelineTriggerFacts: %v", err)
	}
	if len(facts) != 1 || facts[0].IssueInput != "issue" {
		t.Fatalf("facts = %+v, want the seeded trigger carrying issue_input \"issue\"", facts)
	}

	warnings := api.InputUnfillableWarnings(api.InputSpecsFromPlan(a66LabPlan(a66LabR1Inputs)), facts)
	var unmapped bool
	for _, w := range warnings {
		if w.Code == api.CodeTriggerIssueInputUnmapped && w.Input == "issue" && w.TriggerID == f.triggerID {
			unmapped = true
		}
		if w.Code == api.CodeInputUnfillableByTrigger && w.Input == "issue" {
			t.Errorf("warning %+v: issue_input \"issue\" is the trigger's mapping, not a required input of r1", w)
		}
	}
	if !unmapped {
		t.Errorf("warnings = %+v, want a %s finding naming the dead mapping",
			warnings, api.CodeTriggerIssueInputUnmapped)
	}
}
