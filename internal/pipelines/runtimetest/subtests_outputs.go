package runtimetest

import (
	"strings"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// testDeclaredOutputsBoundary: docs/m4-contract.md § 7.1 C10a/C10b, ADR-0022 § 4
// rule 2, 01 invariant 4. The reviewer node DECLARES `evidence: boolean`; the
// reply answers a STRING there. The boundary must refuse it as an EXECUTION
// error — invalid_output, JSON-Schema locations in output_errors, no outputs
// anywhere, no node.attempt.completed — and the retry policy must then schedule
// another attempt that names the invalid_output class. A run that reads this
// reply as a business verdict (succeeded, then routed on `approved`) is exactly
// the silent "not approved" the spike measured; this subtest is the regression
// lock for it, and it runs against BOTH stores (the Postgres adapter with it).
func testDeclaredOutputsBoundary(t *testing.T, f Factory) {
	s := f.Open(t, Config{Pipeline: PipelineOutputs})
	_ = s.Advance()
	a1, err := s.Claim(WorkerA)
	if err != nil || a1 == nil {
		t.Fatalf("claim: %v", err)
	}
	_ = s.Start(a1.ID, WorkerA, a1.FencingToken)
	before := s.Events(t)

	// C10a: the malformed reply. `approved` is a valid boolean on purpose — an
	// unvalidated envelope would satisfy the routing expression downstream.
	err = s.Complete(a1.ID, WorkerA, a1.FencingToken, Completion{
		Outputs:       map[string]any{"approved": true, "evidence": "review: string where the plan says boolean"},
		OutputsDigest: BoundaryDigest,
		ArtifactRefs:  []any{"art:1"},
		Outcome:       "passed",
		Checkpoint:    NewCheckpoint(WorkerA),
	})
	if err != nil {
		t.Fatalf("the boundary converts a schema-invalid envelope into an attempt failure, it does not error out: %v", err)
	}
	st := s.State(t)
	att := attemptByID(st, a1.ID)
	if att.Status != runtime.AttemptFailed || att.ErrorClass != runtime.ErrInvalidOutput {
		t.Fatalf("malformed reply closed %s/%s, want failed/invalid_output (a succeeded review here means the engine read the reply as a business verdict)",
			att.Status, att.ErrorClass)
	}
	if att.Outputs != nil || att.OutputsDigest != "" {
		t.Fatalf("the rejected attempt carries outputs (%v / %q): nothing may be visible before validation (01 invariant 4)",
			att.Outputs, att.OutputsDigest)
	}
	if len(att.OutputErrors) == 0 {
		t.Fatalf("invalid_output closed with no output_errors evidence (contract § 1's output_errors column, § 3 row 22)")
	}
	if blob := encodeJSON(att.OutputErrors); !strings.Contains(blob, "/evidence") {
		t.Fatalf("output_errors names no instance location for the offending field: %s", blob)
	}
	if n := st.Node("/review"); n.Outputs != nil || n.Status == runtime.NodeSucceeded {
		t.Fatalf("the rejected reply leaked onto the node row: %s outputs=%v", n.Status, n.Outputs)
	}
	appended := st.Events[len(before):]
	if countType(appended, string(pevents.TypeNodeAttemptCompleted)) != 0 ||
		countType(appended, string(pevents.TypeRunCheckpointSaved)) != 0 {
		t.Fatalf("a refused envelope appended success events (the reply reached the routing layer)")
	}
	failed := 0
	for _, e := range appended {
		if e.Type != string(pevents.TypeNodeAttemptFailed) {
			continue
		}
		failed++
		if blob := encodeJSON(e.Payload); !strings.Contains(blob, "invalid_output") || !strings.Contains(blob, "/evidence") {
			t.Fatalf("node.attempt.failed lost its error_class or its schema locations: %s", blob)
		}
	}
	if failed != 1 {
		t.Fatalf("node.attempt.failed appended %d times, want exactly 1", failed)
	}

	// C10b: the refusal is POLICY-DRIVEN — invalid_output is in this node's
	// retriableErrors, so the advancer queues a second attempt and says so.
	if err := s.Advance(); err != nil {
		t.Fatalf("advance: %v", err)
	}
	st = s.State(t)
	if len(st.Attempts) != 2 || st.Attempts[1].AttemptNumber != 2 ||
		st.Attempts[1].Status != runtime.AttemptQueued {
		t.Fatalf("the rejected reply was not retried per policy: %s", encodeJSON(st.Attempts))
	}
	scheduled := ""
	for _, e := range st.Events {
		if e.Type == string(pevents.TypeNodeAttemptRetryScheduled) {
			scheduled = encodeJSON(e.Payload)
		}
	}
	if !strings.Contains(scheduled, "invalid_output") {
		t.Fatalf("node.attempt.retry_scheduled does not name the invalid_output retry: %q", scheduled)
	}

	// And the retry gets it right: a valid envelope still succeeds normally —
	// the boundary refuses the lie, not the work. The retry is queued with the
	// authored backoff's delay, so walk the clock past it before claiming.
	s.SetNow(s.Now().Add(2 * time.Second))
	a2, err := s.Claim(WorkerA)
	if err != nil || a2 == nil {
		t.Fatalf("claim retry: %v", err)
	}
	_ = s.Start(a2.ID, WorkerA, a2.FencingToken)
	if err := s.Complete(a2.ID, WorkerA, a2.FencingToken, Completion{
		Outputs:       map[string]any{"approved": true, "evidence": true},
		OutputsDigest: BoundaryDigest,
		Outcome:       "passed",
		Checkpoint:    NewCheckpoint(WorkerA),
	}); err != nil {
		t.Fatalf("complete retry: %v", err)
	}
	st = s.State(t)
	if att := attemptByID(st, a2.ID); att.Status != runtime.AttemptSucceeded {
		t.Fatalf("a schema-valid reply closed %s/%s: the boundary is not allowed to reject good work",
			att.Status, att.ErrorClass)
	}
	if n := st.Node("/review"); n.Status != runtime.NodeSucceeded || n.Outputs == nil {
		t.Fatalf("node after the valid retry: %s outputs=%v", n.Status, n.Outputs)
	}
}
