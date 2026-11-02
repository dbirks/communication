package api

// TestRunListProgressContract: ADR-0070's wire contract for
// GET /projects/{projectId}/runs. The list row's `progress` member is the
// strip's whole data need: steps in definition order, the five coarse
// states, the 12-cap with a `more` count — and NOTHING else learns it: a
// producer that does not compute progress (run detail, tree, the
// cross-project board's RunSummary rows) omits the member entirely, so no
// surface can pretend a strip it never derived.

import (
	"encoding/json"
	"strings"
	"testing"
)

func m4ProgressRow(id string, progress *RunProgressView) RunSummaryView {
	return RunSummaryView{
		ID: id, ProjectID: "p-1", PipelineID: m4UUID, PipelineRevisionID: m4UUID,
		RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest,
		Status: "running", Depth: 0, Priority: 5,
		Trigger:  &RunTriggerView{Kind: "manual"},
		Progress: progress,
	}
}

func TestRunListProgressContract(t *testing.T) {
	fx := m4Server(t)
	fx.runs.runs = []RunSummaryView{
		m4ProgressRow("r-1", &RunProgressView{
			Steps: []RunProgressStepView{
				{NodeID: "plan", State: RunStepDone},
				{NodeID: "implement", State: RunStepRunning},
				{NodeID: "review", State: RunStepWaiting},
				{NodeID: "harden", State: RunStepFailed},
				{NodeID: "ship", State: RunStepOpen},
			},
			More: 0,
		}),
		m4ProgressRow("r-2", &RunProgressView{
			Steps: []RunProgressStepView{
				{NodeID: "s1", State: RunStepDone},
				{NodeID: "s2", State: RunStepRunning},
			},
			More: 7, // the 12-cap: only 2 of 9 shown here, the rest counted
		}),
	}
	rec := fx.get(t, "http://localhost:8080/api/v1/projects/p-1/runs")
	if rec.Code != 200 {
		t.Fatalf("GET runs = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Runs []struct {
			ID       string `json:"id"`
			Progress *struct {
				Steps []struct {
					NodeID string `json:"node_id"`
					State  string `json:"state"`
				} `json:"steps"`
				More int `json:"more"`
			} `json:"progress"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list body: %v (%s)", err, rec.Body.String())
	}
	if len(out.Runs) != 2 {
		t.Fatalf("runs = %d, want 2", len(out.Runs))
	}
	first := out.Runs[0]
	if first.Progress == nil || len(first.Progress.Steps) != 5 || first.Progress.More != 0 {
		t.Fatalf("r-1 progress = %+v, want 5 steps and more=0", first.Progress)
	}
	wantStates := []string{"done", "running", "waiting", "failed", "open"}
	for i, want := range wantStates {
		if got := first.Progress.Steps[i]; got.NodeID == "" || got.State != want {
			t.Fatalf("r-1 step %d = %+v, want state %q with a node id label", i, got, want)
		}
	}
	// The five coarse states are the ONLY vocabulary the strip may see.
	if !strings.Contains(rec.Body.String(), `"more":7`) {
		t.Fatalf("r-2 more=7 absent from the body: %s", rec.Body.String())
	}

	// Omission is the contract everywhere else: a RunSummaryView whose
	// producer never computed progress serializes WITHOUT the member — the
	// run detail (which embeds the summary) can't grow a fake strip.
	if !strings.Contains(rec.Body.String(), `"progress"`) {
		t.Fatalf("the list body must carry progress: %s", rec.Body.String())
	}
	fx.runs.run = RunView{RunSummaryView: m4ProgressRow("r-1", nil)}
	fx.runs.getErr = nil
	rec = fx.get(t, "http://localhost:8080/api/v1/runs/r-1")
	if rec.Code != 200 {
		t.Fatalf("GET run = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"progress"`) {
		t.Fatalf("run detail leaks a progress member it never derived: %s", rec.Body.String())
	}
}
