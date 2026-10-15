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
		events.TypePipelineCreated, events.TypePipelineDraftUpdated,
		events.TypePipelineDraftValidated, events.TypePipelineRevisionPublished,
		events.TypePipelineRevisionDeprecated,
		events.TypeAssignmentCreated, events.TypeAssignmentUpdated,
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
		events.PipelineCreated{}, events.PipelineDraftUpdated{}, events.PipelineDraftValidated{},
		events.PipelineRevisionPublished{}, events.PipelineRevisionDeprecated{},
		events.AssignmentCreated{}, events.AssignmentUpdated{},
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

// TestPipelineLibraryAndAssignmentPayloads covers § 3 rows 31-36 with the
// idiom the suite uses everywhere: each payload round-trips over the wire,
// each good shape validates, and every shape the emitter might get wrong is
// refused — by the payload AND through the Record.Validate bridge, so a bad
// payload cannot reach the journal even when the writer forgot to check.
func TestPipelineLibraryAndAssignmentPayloads(t *testing.T) {
	const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	digest := "sha256:" + hex64
	overrides := map[string]any{"max_duration_seconds": 600}
	for _, tc := range []struct {
		name string
		typ  events.TypeName
		good events.Validator
		bad  []events.Validator
	}{
		{
			name: "pipeline.created", typ: events.TypePipelineCreated,
			good: events.PipelineCreated{ProjectID: "p1", PipelineID: "pipe1", Slug: "feature-development"},
			bad: []events.Validator{
				events.PipelineCreated{PipelineID: "pipe1", Slug: "ok"},
				events.PipelineCreated{ProjectID: "p1", Slug: "ok"},
				events.PipelineCreated{ProjectID: "p1", PipelineID: "pipe1"},
				events.PipelineCreated{ProjectID: "p1", PipelineID: "pipe1", Slug: "Feature_Dev"},
				events.PipelineCreated{ProjectID: "p1", PipelineID: "pipe1", Slug: "a" + strings.Repeat("b", 128)},
			},
		},
		{
			name: "pipeline.draft.updated", typ: events.TypePipelineDraftUpdated,
			good: events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2,
				SourceSHA256: hex64, EditedBy: "u1", Kind: "yaml_import"},
			bad: []events.Validator{
				events.PipelineDraftUpdated{DraftID: "d1", Version: 2, SourceSHA256: hex64, EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", Version: 2, SourceSHA256: hex64, EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", SourceSHA256: hex64, EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2, EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2, SourceSHA256: digest, EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2, SourceSHA256: "nothex", EditedBy: "u1", Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2, SourceSHA256: hex64, Kind: "manual"},
				events.PipelineDraftUpdated{ProjectID: "p1", DraftID: "d1", Version: 2, SourceSHA256: hex64, EditedBy: "u1", Kind: "telepathy"},
			},
		},
		{
			name: "pipeline.draft.validated (valid)", typ: events.TypePipelineDraftValidated,
			good: events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", Valid: true,
				RevisionDigest: digest, PlanDigest: digest},
			bad: []events.Validator{
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", Valid: true},
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", Valid: true, RevisionDigest: digest},
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", Valid: true, RevisionDigest: digest, PlanDigest: digest, ErrorCount: 3},
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", Valid: true, RevisionDigest: "sha256:zz", PlanDigest: digest},
				events.PipelineDraftValidated{DraftID: "d1", Valid: true, RevisionDigest: digest, PlanDigest: digest},
			},
		},
		{
			name: "pipeline.draft.validated (invalid)", typ: events.TypePipelineDraftValidated,
			good: events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", ErrorCount: 2,
				ErrorCodes: []string{"cycle_detected", "cel_compile_error"}},
			bad: []events.Validator{
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1"},
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", ErrorCount: 1, RevisionDigest: "sha256:zz"},
				events.PipelineDraftValidated{ProjectID: "p1", DraftID: "d1", ErrorCount: 1, ErrorCodes: []string{"a", "b", "c"}},
				events.PipelineDraftValidated{ProjectID: "p1", ErrorCount: 1, ErrorCodes: []string{"cycle_detected"}},
			},
		},
		{
			name: "pipeline.revision.published", typ: events.TypePipelineRevisionPublished,
			good: events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionID: "rev1",
				RevisionNumber: 3, VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
				DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
			bad: []events.Validator{
				events.PipelineRevisionPublished{ProjectID: "p1", RevisionID: "rev1", RevisionNumber: 3,
					VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
					DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
				events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionNumber: 3,
					VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
					DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
				events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionID: "rev1",
					VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
					DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
				events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionID: "rev1", RevisionNumber: 3,
					VersionLabel: "1.2", RevisionDigest: digest, PlanDigest: digest,
					DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
				events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionID: "rev1", RevisionNumber: 3,
					VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
					SchemaDigest: digest, CelEnvDigest: digest},
				events.PipelineRevisionPublished{ProjectID: "p1", PipelineID: "pipe1", RevisionID: "rev1", RevisionNumber: 3,
					VersionLabel: "1.2.0", RevisionDigest: hex64, PlanDigest: digest,
					DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest},
			},
		},
		{
			name: "pipeline.revision.deprecated", typ: events.TypePipelineRevisionDeprecated,
			good: events.PipelineRevisionDeprecated{ProjectID: "p1", RevisionID: "rev1", RevisionDigest: digest},
			bad: []events.Validator{
				events.PipelineRevisionDeprecated{RevisionID: "rev1", RevisionDigest: digest},
				events.PipelineRevisionDeprecated{ProjectID: "p1", RevisionDigest: digest},
				events.PipelineRevisionDeprecated{ProjectID: "p1", RevisionID: "rev1", RevisionDigest: "sha256:abc"},
			},
		},
		{
			name: "assignment.created", typ: events.TypeAssignmentCreated,
			good: events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
				PinnedRevisionID: "rev1", RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
			bad: []events.Validator{
				events.AssignmentCreated{AssignmentID: "a1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
					RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: hex64, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 0, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 9, BudgetOverrides: overrides},
				events.AssignmentCreated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1", PinnedRevisionID: "rev1",
					RevisionDigest: digest, MaxConcurrentRuns: 3},
			},
		},
		{
			name: "assignment.updated", typ: events.TypeAssignmentUpdated,
			good: events.AssignmentUpdated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
				PinnedRevisionID: "rev1", RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides,
				Before: map[string]any{"max_concurrent_runs": 1}, After: map[string]any{"max_concurrent_runs": 3}},
			bad: []events.Validator{
				events.AssignmentUpdated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
					PinnedRevisionID: "rev1", RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides},
				events.AssignmentUpdated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
					PinnedRevisionID: "rev1", RevisionDigest: digest, MaxConcurrentRuns: 3, BudgetOverrides: overrides,
					Before: map[string]any{"max_concurrent_runs": 1}},
				events.AssignmentUpdated{ProjectID: "p1", AssignmentID: "a1", PipelineID: "pipe1",
					PinnedRevisionID: "rev1", RevisionDigest: digest, MaxConcurrentRuns: 9, BudgetOverrides: overrides,
					Before: map[string]any{}, After: map[string]any{}},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.good)
			if err != nil {
				t.Fatalf("good payload does not marshal: %v", err)
			}
			rv := reflect.New(reflect.TypeOf(tc.good))
			if err := json.Unmarshal(b, rv.Interface()); err != nil {
				t.Fatalf("round-trip unmarshal: %v", err)
			}
			b2, err := json.Marshal(rv.Elem().Interface())
			if err != nil {
				t.Fatalf("round-trip re-marshal: %v", err)
			}
			if string(b) != string(b2) {
				t.Errorf("wire drift: %s != %s", b, b2)
			}
			if err := tc.good.Validate(); err != nil {
				t.Errorf("good payload refused: %v", err)
			}
			rec := events.Record{Type: tc.typ, Payload: tc.good, ProjectID: "p1",
				ActorKind: events.ActorKindSystem, Timestamp: time.Now()}
			if err := rec.Validate(); err != nil {
				t.Errorf("record with good payload refused: %v", err)
			}
			for i, p := range tc.bad {
				if err := p.Validate(); err == nil {
					t.Errorf("bad payload %d accepted", i)
				}
				bad := rec
				bad.Payload = p
				if err := bad.Validate(); err == nil {
					t.Errorf("bad payload %d reached the journal through Record.Validate", i)
				}
			}
		})
	}
}
