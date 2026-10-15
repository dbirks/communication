package events_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/events"
)

// TestTypeNamesSatisfyTheEnvelopeGrammar: every constant this package emits
// must match the event envelope schema's type pattern (contract § 3), and
// the reserved row too — M5 must not need a rename to use it.
func TestTypeNamesSatisfyTheEnvelopeGrammar(t *testing.T) {
	all := []events.TypeName{
		events.TypeRunCreated, events.TypeRunStarted, events.TypeRunWaitingHuman,
		events.TypeRunCompleted, events.TypeRunFailed, events.TypeRunCancelled,
		events.TypeRunCancelRequested, events.TypeRunPaused, events.TypeRunResumed,
		events.TypeRunRetried, events.TypeRunInterrupted, events.TypeRunCheckpointSaved,
		events.TypeRunCheckpointRestored, events.TypeNodeScopeStarted,
		events.TypeNodeScopeIteration, events.TypeNodeScopeCompleted, events.TypeNodeScopeFailed,
		events.TypeNodeExecutionSkipped, events.TypeNodeExecutionCancelled,
		events.TypeNodeAttemptStarted, events.TypeNodeAttemptCompleted, events.TypeNodeAttemptFailed,
		events.TypeNodeAttemptRetryScheduled, events.TypeNodeAttemptInterrupted, events.TypeNodeAttemptCancelled,
		events.TypeApprovalRequested, events.TypeApprovalDecided, events.TypeApprovalDenied,
		events.TypeApprovalExpired, events.TypeApprovalCancelled,
	}
	seen := map[events.TypeName]bool{}
	for _, ty := range all {
		if seen[ty] {
			t.Errorf("duplicate type constant %s", ty)
		}
		seen[ty] = true
		if !events.ValidTypeName(string(ty)) {
			t.Errorf("type %q breaks the envelope grammar", ty)
		}
		for _, r := range events.ReservedTypes {
			if r == ty {
				t.Errorf("%s is reserved — it must not be a runtime-emitted constant", ty)
			}
		}
	}
	for _, r := range events.ReservedTypes {
		if !events.ValidTypeName(string(r)) {
			t.Errorf("reserved type %q breaks the grammar", r)
		}
	}
	for _, bad := range []string{"run", "RUN.STARTED", "run.Started", ".run.x", "run.", "run.x.", "run x y"} {
		if events.ValidTypeName(bad) {
			t.Errorf("grammar accepted %q", bad)
		}
	}
}

// TestPayloadsCarryProjectIDAndMarshalSnakeCase enforces contract § 3's
// "every M4 payload carries project_id" plus the wire style, by reflection
// over one instance of every exported payload struct.
func TestPayloadsCarryProjectIDAndMarshalSnakeCase(t *testing.T) {
	// run.created has no payload struct here on purpose: the API
	// transaction writes it, not the runtime (contract § 4 step 1).
	payloads := []any{
		events.RunStarted{}, events.RunWaitingHuman{}, events.RunCompleted{},
		events.RunFailed{}, events.RunCancelled{}, events.RunCancelRequested{},
		events.RunPaused{}, events.RunResumed{}, events.RunRetried{}, events.RunInterrupted{},
		events.RunCheckpointSaved{}, events.RunCheckpointRestored{},
		events.NodeScopeStarted{}, events.NodeScopeIteration{}, events.NodeScopeCompleted{},
		events.NodeScopeFailed{}, events.NodeExecutionSkipped{}, events.NodeExecutionCancelled{},
		events.NodeAttemptStarted{}, events.NodeAttemptCompleted{}, events.NodeAttemptFailed{},
		events.NodeAttemptRetryScheduled{}, events.NodeAttemptInterrupted{}, events.NodeAttemptCancelled{},
		events.ApprovalRequested{}, events.ApprovalDecided{}, events.ApprovalDenied{},
		events.ApprovalExpired{}, events.ApprovalCancelled{},
	}
	for _, p := range payloads {
		rv := reflect.ValueOf(p)
		typ := rv.Type()
		field, ok := typ.FieldByName("ProjectID")
		if !ok {
			t.Errorf("%s lacks ProjectID (§ 3: every payload carries project_id)", typ.Name())
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")[0]
		if tag != "project_id" {
			t.Errorf("%s.ProjectID json tag = %q", typ.Name(), tag)
		}
		b, err := json.Marshal(p)
		if err != nil {
			t.Errorf("%s does not marshal: %v", typ.Name(), err)
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if _, ok := m["project_id"]; !ok {
			t.Errorf("%s marshals without project_id: %s", typ.Name(), b)
		}
		for k := range m {
			if k != strings.ToLower(k) || strings.ContainsAny(k, "A-Z") {
				t.Errorf("%s field %q is not snake_case", typ.Name(), k)
			}
		}
	}
}

func TestRecordValidate(t *testing.T) {
	good := events.Record{
		Type: events.TypeRunCompleted, Payload: events.RunCompleted{ProjectID: "p"},
		ProjectID: "p", RunID: "r", ActorKind: events.ActorKindSystem, Timestamp: time.Now(),
	}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := good
	bad.Payload = nil
	if err := bad.Validate(); err == nil {
		t.Error("nil payload must be refused")
	}
	bad = good
	bad.ProjectID = ""
	if err := bad.Validate(); err == nil {
		t.Error("a record without project_id cannot be authorized")
	}
	bad = good
	bad.ActorKind = "ghost"
	if err := bad.Validate(); err == nil {
		t.Error("actor kinds are an enum")
	}
	bad = good
	bad.Type = "not.a.valid type"
	if err := bad.Validate(); err == nil {
		t.Error("type grammar is a CHECK, not a convention")
	}
	// Correlation rule (§ 3): node rows may have no attempt — control-plane
	// executions have none (ADR-0023 § 3).
	nodeOnly := good
	nodeOnly.NodeExecutionID = "ne1"
	nodeOnly.AttemptID = ""
	if err := nodeOnly.Validate(); err != nil {
		t.Errorf("control-plane rows are legal without an attempt id: %v", err)
	}
}
