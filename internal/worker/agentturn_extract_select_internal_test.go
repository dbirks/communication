package worker

// Offline (no-ACP) unit proof for selectOutputDocument's schema-aware
// selection and the split-answer merge (docs/m4-contract.md § 4 step 6).
// Run 42079149686, shard m4-core-a-1, § 7.1 C1c: the /implement reply ended
// `…syntactically valid Python."} {"files_changed": ["app/hello.py"]}` — TWO
// top-level objects. The schema-blind extractor took the LAST candidate that
// decoded first (the files_changed object), so /implement succeeded without
// its required summary, the review prompt's
// `${{ nodes.implement.outputs.summary }}` never resolved, and the run died
// binding_error. Selection now asks the node's declared schema which
// candidate answers it; a reply that splits ONE answer across disjoint
// objects is merged — with an honest note, never silently. The schema RULE
// is runtime.CheckNodeOutputs unchanged (the same judge the boundary re-runs
// at Complete); these tests pin only WHICH document gets handed to it.
//
// usage: go test ./internal/worker/ -run TestSelectOutputDocument

import (
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

func judgeFor(t *testing.T, schema any) outputJudge {
	t.Helper()
	return func(doc any) (bool, *runtime.OutputRejection, error) {
		rej, err := runtime.CheckNodeOutputs("\x00test\x00"+t.Name(), t.Name(), schema, doc)
		if err != nil {
			return false, nil, err
		}
		return rej == nil, rej, nil
	}
}

// implementSchema is /implement's declared outputs with BOTH fields required
// (docs/compatibility/probes/m4/pipeline.yaml's shape plus the summary half
// that made its absence fatal): each split object alone refuses it.
func implementSchema(required ...string) map[string]any {
	if len(required) == 0 {
		required = []string{"summary", "files_changed"}
	}
	req := make([]any, 0, len(required))
	for _, r := range required {
		req = append(req, r)
	}
	return map[string]any{
		"type":     "object",
		"required": req,
		"properties": map[string]any{
			"summary":       map[string]any{"type": "string", "minLength": int64(1)},
			"files_changed": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
	}
}

// splitReply replays run 42079149686's /implement answer. seq=243 is journalled
// head-truncated (evidence m4.out: `…verified by inspection and is syntactically
// valid Python."} {"files_changed": ["app/hello.py"]}`); the head is restored,
// the tail is verbatim.
const splitReply = `{"summary": "Documented add() in app/hello.py and reconciled its test, keeping the correct sum semantics while adding the missing ` +
	"documentation and a cheap regression guard. The sum logic itself was confirmed correct and left unchanged. Note: no Python interpreter is installed in this environment (python/python3 not found), so the self-check could not be executed here; the file was verified by inspection and is syntactically valid Python.\"} {\"files_changed\": [\"app/hello.py\"]}"

func decodeSelected(t *testing.T, ex outputSelection) map[string]any {
	t.Helper()
	if ex.failed != nil {
		t.Fatalf("selection failed: %s", *ex.failed)
	}
	obj, ok := ex.value.(map[string]any)
	if !ok {
		t.Fatalf("selection returned %T, want a JSON object", ex.value)
	}
	return obj
}

// TestSelectOutputDocumentMergesSplitAnswer is the incident itself: summary
// object + files_changed object, neither validates alone, keys are disjoint,
// the union validates — merged, with the honest note and no rejection.
func TestSelectOutputDocumentMergesSplitAnswer(t *testing.T) {
	ex := selectOutputDocument(splitReply, judgeFor(t, implementSchema()))
	obj := decodeSelected(t, ex)
	if s, _ := obj["summary"].(string); !strings.Contains(s, "syntactically valid Python.") {
		t.Fatalf("summary = %q, want the journaled reply's summary", s)
	}
	paths, _ := obj["files_changed"].([]any)
	if len(paths) != 1 || paths[0] != "app/hello.py" {
		t.Fatalf("files_changed = %v, want [\"app/hello.py\"]", obj["files_changed"])
	}
	if ex.rejection != nil {
		t.Fatalf("a merged answer that validates must not carry a rejection: %v", ex.rejection)
	}
	if !strings.Contains(ex.note, "merged 2 objects") || !strings.Contains(ex.note, "summary") ||
		!strings.Contains(ex.note, "files_changed") {
		t.Fatalf("merge note is %q, want an honest 'merged 2 objects' naming both key sets", ex.note)
	}

	// The same reply against a schema where the FIRST object already
	// validates (summary-only required) needs no merge: first valid wins
	// and no note is owed.
	ex2 := selectOutputDocument(splitReply, judgeFor(t, implementSchema("summary")))
	obj2 := decodeSelected(t, ex2)
	if _, has := obj2["files_changed"]; has {
		t.Fatalf("a valid first candidate must be taken whole, not merged: %v", obj2)
	}
	if ex2.note != "" {
		t.Fatalf("note = %q, want empty — nothing was merged", ex2.note)
	}

	// Schema-blind, today's pick is unchanged: the FIRST decoded object
	// (never the merge, never the second). This is the exact behavior that
	// LOST run 42079149686 at the schema layer — extraction alone still
	// cannot know summaries are required; that is what the judge is for.
	val, bad := extractStructuredOutput(splitReply)
	if bad != nil {
		t.Fatalf("schema-blind extraction regressed: %s", *bad)
	}
	blind, _ := val.(map[string]any)
	if _, has := blind["files_changed"]; has || len(blind) != 1 {
		t.Fatalf("schema-blind pick = %v, want today's first object alone", blind)
	}
}

// TestSelectOutputDocumentPicksFirstValidObject: two objects, only the second
// validates — the second is taken, no merge note, no rejection.
func TestSelectOutputDocumentPicksFirstValidObject(t *testing.T) {
	reply := `{"note": "thinking out loud"} {"approved": true, "evidence": "pytest green, 12 passed"}`
	schema := map[string]any{
		"type":     "object",
		"required": []any{"approved", "evidence"},
		"properties": map[string]any{
			"approved": map[string]any{"type": "boolean"},
			"evidence": map[string]any{"type": "string"},
		},
	}
	ex := selectOutputDocument(reply, judgeFor(t, schema))
	obj := decodeSelected(t, ex)
	if obj["approved"] != true {
		t.Fatalf("selected %v, want the SECOND object (the one that validates)", obj)
	}
	if ex.note != "" || ex.rejection != nil {
		t.Fatalf("note=%q rejection=%v, want neither — a valid candidate is taken whole", ex.note, ex.rejection)
	}
}

// TestSelectOutputDocumentOverlappingKeysNoMerge: objects that answer the same
// field twice are not one split answer. No merge; today's pick stands and the
// selection carries its schema errors. attachOutputs keeps the unchanged
// semantics — the document travels to the engine, which validates at Complete.
func TestSelectOutputDocumentOverlappingKeysNoMerge(t *testing.T) {
	reply := `{"summary": "first half"} {"summary": "second half", "files_changed": "app/hello.py"}`
	ex := selectOutputDocument(reply, judgeFor(t, implementSchema()))
	obj := decodeSelected(t, ex)
	if obj["summary"] != "first half" {
		t.Fatalf("pick = %v, want today's choice (the first decoded object)", obj)
	}
	if ex.note != "" {
		t.Fatalf("note=%q, want empty — overlapping keys are two answers, not one split", ex.note)
	}
	if ex.rejection == nil {
		t.Fatal("rejection = nil, want the schema errors of the refused pick")
	}
	if !strings.Contains(ex.rejection.Error(), "files_changed") {
		t.Fatalf("rejection detail = %q, want it to name the missing files_changed", ex.rejection.Error())
	}

	// Unchanged semantics at the envelope level: the refused pick still
	// travels as the attempt's outputs (the reply itself is the evidence at
	// this layer; the boundary's verdict lands at Complete).
	c := AttemptClaim{
		AttemptID: "a1", RunID: "r1", NodeID: "/implement",
		NodeInstanceKey: "/build_until_verified[1]/implement",
		OutputsSchema:   implementSchema(),
	}
	built, note, fail := (&AgentTurn{}).attachOutputs(c, agentTurnSpec{}, AgentProfile{}, reply)
	if fail != nil {
		t.Fatalf("attachOutputs refused locally (status=%s class=%s); the schema verdict belongs to the boundary at Complete", fail.Status, fail.ErrorClass)
	}
	if note != "" {
		t.Fatalf("note=%q, want none — nothing merged", note)
	}
	if got := built.Outputs.(map[string]any)["summary"]; got != "first half" {
		t.Fatalf("outputs = %v, want today's pick handed to the engine", built.Outputs)
	}
}

// TestAttachOutputsSplitsMergeAndNoSchema walks attachOutputs itself: the
// merged answer succeeds WITH the note (the caller journals it), and a claim
// with no declared outputs schema keeps the schema-blind pick unchanged.
func TestAttachOutputsSplitsMergeAndNoSchema(t *testing.T) {
	turn := &AgentTurn{}
	c := AttemptClaim{
		AttemptID: "a1", RunID: "r1", NodeID: "/implement",
		NodeInstanceKey: "/build_until_verified[1]/implement",
		OutputsSchema:   implementSchema(),
	}
	built, note, fail := turn.attachOutputs(c, agentTurnSpec{}, AgentProfile{}, splitReply)
	if fail != nil {
		t.Fatalf("the split answer must succeed merged: %+v", *fail)
	}
	obj := built.Outputs.(map[string]any)
	if _, has := obj["summary"]; !has {
		t.Fatalf("merged outputs %v lack summary", obj)
	}
	if _, has := obj["files_changed"]; !has {
		t.Fatalf("merged outputs %v lack files_changed", obj)
	}
	if !strings.Contains(note, "merged 2 objects") {
		t.Fatalf("note = %q, want the 'merged 2 objects' evidence", note)
	}
	if built.OutputsDigest == "" {
		t.Fatal("merged envelope owes a digest like any other")
	}

	// No declared outputs: today's behaviour, schema-blind, no note.
	plain := c
	plain.OutputsSchema = nil
	built2, note2, fail2 := turn.attachOutputs(plain, agentTurnSpec{}, AgentProfile{}, splitReply)
	if fail2 != nil {
		t.Fatalf("schema-less attachOutputs regressed: %+v", *fail2)
	}
	if _, has := built2.Outputs.(map[string]any)["files_changed"]; has {
		t.Fatalf("schema-less pick = %v, want today's first object", built2.Outputs)
	}
	if note2 != "" {
		t.Fatalf("note = %q, want empty without a declared schema", note2)
	}
}
