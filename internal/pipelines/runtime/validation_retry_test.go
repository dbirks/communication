package runtime_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func attemptByIDFor(t *testing.T, st *runtime.State, nodeExecID, id string) *runtime.Attempt {
	t.Helper()
	for _, a := range st.AttemptsFor(nodeExecID) {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no attempt %s", id)
	return nil
}

// TestInvalidOutputRetryCarriesValidationErrors is the lab live16 regression:
// /plan answered a 647-character summary against a declared maxLength of 600,
// was refused invalid_output, and each of its three attempts was handed the
// SAME prompt — so the agent never learned why it had been rejected and kept
// answering 760, then 765 characters long. An invalid_output refusal must
// name the violating fields in the retry_context the ENGINE queues with the
// next attempt (ADR-0023 § 6's "the retry's prompt gains a recorded
// retry_context block", ADR-0073): path, rule, got, want — schema sentences
// only.
func TestInvalidOutputRetryCarriesValidationErrors(t *testing.T) {
	plan := loadPlan(t, "../testdata/outputs-retry.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "ship it"})
	dv.advance()
	a, err := dv.ms.Claim(dv.run.ID, "worker-a")
	if err != nil || a == nil {
		t.Fatalf("claim: %v %v", a, err)
	}
	if err := dv.ms.Start(dv.run.ID, a.ID, a.WorkerID, a.FencingToken); err != nil {
		t.Fatal(err)
	}
	ck := runtime.CheckpointRecord{InputsDigest: "sha256:" + strings.Repeat("1", 64),
		OutputsDigest: "sha256:" + strings.Repeat("2", 64), VolumeID: "v", WorkspaceID: "w", WorkerID: "worker-a"}
	// The over-long reply: 647 characters against maxLength 600.
	if err := dv.ms.Complete(dv.run.ID, a.ID, a.WorkerID, a.FencingToken,
		map[string]any{"plan": map[string]any{"summary": strings.Repeat("x", 647)}},
		"sha256:x", nil, "", ck); err != nil {
		t.Fatalf("complete: %v", err)
	}
	st := dv.state()
	atts := st.AttemptsFor(a.NodeExecutionID)
	if len(atts) != 2 || atts[1].Status != runtime.AttemptQueued {
		t.Fatalf("attempts after the refusal = %d, want a second queued (invalid_output is retriable here)", len(atts))
	}
	if atts[1].RetryContext == nil {
		t.Fatal("the invalid_output retry carries no retry_context at all (ADR-0023 § 6)")
	}
	fb, ok := atts[1].RetryContext["validation_errors"].([]any)
	if !ok || len(fb) != 1 {
		t.Fatalf("retry_context.validation_errors = %#v, want one entry naming the refusal", atts[1].RetryContext["validation_errors"])
	}
	entry, ok := fb[0].(map[string]any)
	if !ok {
		t.Fatalf("validation_errors[0] = %#v, want an object", fb[0])
	}
	if entry["path"] != "/plan/summary" || entry["rule"] != "maxLength" {
		t.Errorf("validation_errors[0] = %v, want path /plan/summary rule maxLength", entry)
	}
	if entry["got"] != "647" || entry["want"] != "600" {
		t.Errorf("validation_errors[0] got/want = %v/%v, want 647/600 (the numbers the agent must stay under)", entry["got"], entry["want"])
	}
	if s, _ := entry["message"].(string); !strings.Contains(s, "maxLength") {
		t.Errorf("validation_errors[0].message = %v, want the schema sentence", entry["message"])
	}
	// The block stays bounded: 600+ characters of the offending reply never
	// ride along — only the schema's own words do.
	blobBytes, err := json.Marshal(atts[1].RetryContext)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blobBytes), strings.Repeat("x", 40)) {
		t.Error("retry_context carries the rejected reply itself, not just the violation")
	}
	// Other continue_workspace facts are untouched by the new key.
	if atts[1].RetryContext["attempt"] != int64(1) || atts[1].RetryContext["error_class"] != runtime.ErrInvalidOutput {
		t.Errorf("retry_context = %v, want the ADR-0023 § 6 attempt/error_class facts alongside", atts[1].RetryContext)
	}
}

// TestFakeAgentOverrunsOnceThenComplies is the loop the fix closes: a fake
// agent that reads its attempt's retry_context, corrects the named field, and
// passes on attempt 2 — the same retry_context the worker's prompt builder
// folds into the next turn (internal/worker agentturn_prompt_test.go pins the
// wording; this pins that the durable facts to fold are queued).
func TestFakeAgentOverrunsOnceThenComplies(t *testing.T) {
	plan := loadPlan(t, "../testdata/outputs-retry.yaml")
	dv := newDriver(t, plan, map[string]any{"goal": "ship it"})
	dv.advance()
	a1, err := dv.ms.Claim(dv.run.ID, "worker-a")
	if err != nil || a1 == nil {
		t.Fatalf("claim: %v %v", a1, err)
	}
	if err := dv.ms.Start(dv.run.ID, a1.ID, a1.WorkerID, a1.FencingToken); err != nil {
		t.Fatal(err)
	}
	ck := runtime.CheckpointRecord{InputsDigest: "sha256:" + strings.Repeat("1", 64),
		OutputsDigest: "sha256:" + strings.Repeat("2", 64), VolumeID: "v", WorkspaceID: "w", WorkerID: "worker-a"}
	long := strings.Repeat("x", 647)
	if err := dv.ms.Complete(dv.run.ID, a1.ID, a1.WorkerID, a1.FencingToken,
		map[string]any{"plan": map[string]any{"summary": long}}, "sha256:x", nil, "", ck); err != nil {
		t.Fatalf("complete attempt 1: %v", err)
	}
	st := dv.state()
	if att := attemptByIDFor(t, st, a1.NodeExecutionID, a1.ID); att.Status != runtime.AttemptFailed || att.ErrorClass != runtime.ErrInvalidOutput {
		t.Fatalf("attempt 1 = %s/%s, want failed/invalid_output", att.Status, att.ErrorClass)
	}

	// The fake agent for attempt 2: it trims exactly what the retry_context
	// named, within the walked-clock backoff the authored policy sets
	// (baseSeconds 5 * multiplier 2^attempt 1 = 10s).
	dv.now = dv.now.Add(11 * time.Second)
	a2, err := dv.ms.Claim(dv.run.ID, "worker-a")
	if err != nil || a2 == nil {
		t.Fatalf("claim attempt 2: %v %v", a2, err)
	}
	if err := dv.ms.Start(dv.run.ID, a2.ID, a2.WorkerID, a2.FencingToken); err != nil {
		t.Fatal(err)
	}
	fb, _ := a2.RetryContext["validation_errors"].([]any)
	summary := long // the "agent" only complies once told
	for _, e := range fb {
		m, _ := e.(map[string]any)
		if m["path"] == "/plan/summary" && m["rule"] == "maxLength" {
			summary = strings.Repeat("x", 600)
		}
	}
	if err := dv.ms.Complete(dv.run.ID, a2.ID, a2.WorkerID, a2.FencingToken,
		map[string]any{"plan": map[string]any{"summary": summary}},
		"sha256:y", nil, "passed", ck); err != nil {
		t.Fatalf("complete attempt 2: %v", err)
	}
	st = dv.state()
	if att := attemptByIDFor(t, st, a2.NodeExecutionID, a2.ID); att.Status != runtime.AttemptSucceeded {
		t.Fatalf("attempt 2 = %s/%s, want succeeded (the retry_context named the field the fake agent fixed)",
			att.Status, att.ErrorClass)
	}
	if n := st.Node("/plan"); n.Status != runtime.NodeSucceeded {
		t.Errorf("node after the compliant retry = %s, want succeeded", n.Status)
	}
}
