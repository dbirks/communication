package assistant

import (
	"encoding/json"
	"strings"
	"testing"
)

// The ids this file's cards talk about. Every short id is the TAIL-8 (UUIDv7
// heads are timestamps shared by ids minted together): project c599029e,
// pipeline 0000000f, run 029e1a20.
const (
	sumProjectID  = "01a1c47a-2a04-7f8c-aac4-b36bc599029e"
	sumPipelineID = "01c2d3e4-0000-7000-8000-00000000000f"
	sumRunID      = "019e2a04-7f8c-aac4-b36b-c599029e1a20"
)

// A card that dumps 36-char hex is unreadable (the lab's “Start a run
// 01a1c47a-2a04-… · 01a1c47a-2d95-…”). Every uuid arg renders as a noun +
// short id instead — the run by its tail-8, like the UI labels runs.
func TestActionSummaryRendersUUIDsAsShortIDs(t *testing.T) {
	got := actionSummary("run.start", map[string]string{
		"project_id": sumProjectID, "pipeline_id": sumPipelineID,
	}, nil)
	want := "Start a run project c599029e · workflow 0000000f"
	if got != want {
		t.Fatalf("run.start summary = %q, want %q", got, want)
	}
	for _, leak := range []string{sumProjectID, sumPipelineID} {
		if strings.Contains(got, leak) {
			t.Fatalf("the card leaked a full uuid: %q", got)
		}
	}
	// Runs take the tail-8 (the UI's run labels), and the verb already
	// names the kind, so the noun is not said twice.
	got = actionSummary("run.cancel", map[string]string{"run_id": sumRunID}, nil)
	if got != "Cancel run 029e1a20" {
		t.Fatalf("run.cancel summary = %q", got)
	}
	// With a verb that does not name the kind, the noun stays.
	got = actionSummary("run.retry", map[string]string{"run_id": sumRunID}, nil)
	if got != "Retry node run 029e1a20" {
		t.Fatalf("run.retry summary = %q", got)
	}
	// A non-uuid value is already readable (a slug, a version label) and
	// passes through untouched.
	got = actionSummary("run.start", map[string]string{
		"project_id": "feature-delivery", "pipeline_id": "v2 (r7)",
	}, nil)
	if got != "Start a run feature-delivery · v2 (r7)" {
		t.Fatalf("non-uuid summary = %q", got)
	}
}

// When an earlier read this turn named the entity (project.list /
// workflow.list rows with id + slug/name), the card prints the name.
func TestActionSummaryPrefersNamesCollectedFromReads(t *testing.T) {
	names := map[string]string{
		sumProjectID:  "feature-delivery",
		sumPipelineID: "Review flow",
	}
	got := actionSummary("run.start", map[string]string{
		"project_id": sumProjectID, "pipeline_id": sumPipelineID,
	}, names)
	want := "Start a run project feature-delivery · workflow Review flow"
	if got != want {
		t.Fatalf("named summary = %q, want %q", got, want)
	}
	// assignment.set names the workflow through the same map, and the pin
	// line is untouched.
	got = actionSummary("assignment.set", map[string]string{
		"project_id": sumProjectID, "pipeline_id": sumPipelineID, "revision": "v2 (r7)",
	}, names)
	if got != "Assign workflow Review flow · pins v2 (r7)" {
		t.Fatalf("assignment.set named summary = %q", got)
	}
	// An id the reads never named still renders as noun + short id.
	got = actionSummary("run.cancel", map[string]string{"run_id": sumRunID}, names)
	if got != "Cancel run 029e1a20" {
		t.Fatalf("unnamed run summary = %q", got)
	}
}

// An id key outside the closed noun table still renders readably, under the
// noun its own key gives.
func TestReadableArgUnknownIDKeyDerivesItsNoun(t *testing.T) {
	got := readableArg("team_id", sumProjectID, nil)
	if got != "team c599029e" {
		t.Fatalf("readableArg(team_id) = %q", got)
	}
	// No noun to be had: the short id alone.
	got = readableArg("reference", sumProjectID, nil)
	if got != "c599029e" {
		t.Fatalf("readableArg(reference) = %q", got)
	}
}

// --- noteEntityNames: the turn's read payloads feed the name map ----------

func TestNoteEntityNamesHarvestsIDNameRows(t *testing.T) {
	names := map[string]string{}
	noteEntityNames(names, json.RawMessage(
		`[{"id":"`+sumProjectID+`","slug":"feature-delivery","name":"Feature Delivery","my_role":"maintainer"},`+
			`{"id":"`+sumPipelineID+`","slug":"review-flow","latest_revision":3}]`))
	if names[sumProjectID] != "Feature Delivery" {
		t.Fatalf("name for the project = %q, want the row's name", names[sumProjectID])
	}
	if names[sumPipelineID] != "review-flow" {
		t.Fatalf("name for the pipeline = %q, want the row's slug", names[sumPipelineID])
	}
	// The wrapper shape and first-name-wins.
	noteEntityNames(names, json.RawMessage(
		`{"items":[{"id":"`+sumRunID+`","name":"Later Run"}]}`))
	if names[sumRunID] != "Later Run" {
		t.Fatalf("wrapper rows not harvested: %q", names[sumRunID])
	}
	noteEntityNames(names, json.RawMessage(
		`[{"id":"`+sumRunID+`","slug":"first-wins"}]`))
	if names[sumRunID] != "Later Run" {
		t.Fatalf("a later row overwrote the first name: %q", names[sumRunID])
	}
	// Rows without an id+name shape, non-object payloads and empties all
	// contribute nothing (and never panic).
	noteEntityNames(names, json.RawMessage(`[{"draft_id":"d-1"},{"id":""}]`))
	noteEntityNames(names, json.RawMessage(`{"op":"insert_on_edge"}`))
	noteEntityNames(names, nil)
	if len(names) != 3 {
		t.Fatalf("names gained junk: %v", names)
	}
}
