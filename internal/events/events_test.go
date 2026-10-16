package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// schemaShape is the part of event-envelope.schema.json this test cares about:
// the property names, the required list and the actor's own properties. The
// schema file is the contract, so it is read from disk rather than copied
// into this test.
type schemaShape struct {
	Required   []string `json:"required"`
	Properties map[string]struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Type       any                        `json:"type"`
	} `json:"properties"`
}

func loadSchema(t *testing.T) schemaShape {
	t.Helper()
	path := filepath.Join("..", "..", "api", "schemas", "event-envelope.schema.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read envelope schema: %v", err)
	}
	var s schemaShape
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("decode envelope schema: %v", err)
	}
	if len(s.Required) == 0 || len(s.Properties) == 0 {
		t.Fatalf("schema parsed empty: %+v", s)
	}
	return s
}

func fullEnvelope() Envelope {
	return Envelope{
		EventID:        "01987a6e-2f3a-7c1d-9a2e-4f6b8c0d1e2f",
		GlobalSeq:      152003,
		Type:           TypeRepositoryAdded,
		SchemaVersion:  1,
		OccurredAt:     time.Date(2026, 10, 14, 18, 0, 0, 0, time.UTC),
		OrganizationID: "01987a6b-9c1d-7e5f-8a0b-1c2d3e4f5a60",
		ProjectID:      "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80",
		ConversationID: "01987a6d-5e6f-7a2b-8c3d-4e5f6a7b8c90",
		RunID:          "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",

		NodeExecutionID: "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d",
		AttemptID:       "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e",
		Actor:           Actor{Kind: ActorKindHuman, ID: "01987a61-2345-7000-8000-abcdef012345"},
		TraceID:         "0af7651916cd43dd8448eb211c80319c",
		Payload:         map[string]any{"repository_id": "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0"},
	}
}

func jsonKeys(t *testing.T, v any) []string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestEnvelopeFieldNamesMatchSchema is the contract test: the marshalled
// Envelope must use exactly the schema's property names — no extra field, and
// with every field set, no missing one.
func TestEnvelopeFieldNamesMatchSchema(t *testing.T) {
	s := loadSchema(t)
	want := make([]string, 0, len(s.Properties))
	for name := range s.Properties {
		want = append(want, name)
	}
	sort.Strings(want)

	got := jsonKeys(t, fullEnvelope())
	if !reflect.DeepEqual(got, want) {
		t.Errorf("envelope JSON members = %v, want schema properties %v", got, want)
	}

	for _, req := range s.Required {
		if _, ok := s.Properties[req]; !ok {
			t.Errorf("schema requires %q, which is not a property", req)
		}
	}
}

// TestEnvelopeOptionalMembersOmitted pins the second half of the schema
// story: the optionals are absent (not null) when unset, and every required
// member is still present.
func TestEnvelopeOptionalMembersOmitted(t *testing.T) {
	s := loadSchema(t)
	min := Envelope{
		EventID:        "01987a6e-2f3a-7c1d-9a2e-4f6b8c0d1e2f",
		GlobalSeq:      4,
		Type:           TypeProjectCreated,
		SchemaVersion:  1,
		OccurredAt:     time.Date(2026, 10, 14, 18, 0, 0, 0, time.UTC),
		OrganizationID: "01987a6b-9c1d-7e5f-8a0b-1c2d3e4f5a60",
		Actor:          Human("u-1"),
		Payload:        map[string]any{},
	}
	got := jsonKeys(t, min)

	optional := map[string]bool{
		"project_id": true, "conversation_id": true, "trace_id": true,
		"run_id": true, "node_execution_id": true, "attempt_id": true,
	}
	for _, k := range got {
		if optional[k] {
			t.Errorf("unset optional %q was emitted (keys %v)", k, got)
		}
	}
	for _, req := range s.Required {
		found := false
		for _, k := range got {
			if k == req {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("required member %q missing from %v", req, got)
		}
	}
}

func TestActorFieldNames(t *testing.T) {
	s := loadSchema(t)
	props, ok := s.Properties["actor"]
	if !ok {
		t.Fatal("schema has no actor property")
	}
	want := []string{"id", "kind"}
	got := jsonKeys(t, Actor{Kind: ActorKindWorker, ID: "worker_a"})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("actor JSON members = %v, want %v", got, want)
	}
	for name := range props.Properties {
		if name != "kind" && name != "id" {
			t.Errorf("unexpected actor property %q", name)
		}
	}
}

// TestEnvelopeMatchesSchemaExample checks the Go tags against the schema's own
// worked example, field for field.
func TestEnvelopeMatchesSchemaExample(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "schemas", "event-envelope.schema.json"))
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	var doc struct {
		Examples []map[string]json.RawMessage `json:"examples"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	if len(doc.Examples) == 0 {
		t.Fatal("schema has no example to compare against")
	}
	example := doc.Examples[0]

	// The example is the schema author's statement of the wire shape: every
	// member it uses must appear in our output with the same name, and the
	// values we control must agree.
	env := fullEnvelope()
	env.ConversationID = ""
	env.OccurredAt = time.Date(2026, 10, 14, 18, 0, 0, 0, time.UTC)
	got := map[string]json.RawMessage{}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for k, wantRaw := range example {
		gotRaw, ok := got[k]
		if !ok {
			t.Errorf("example field %q absent from marshalled envelope", k)
			continue
		}
		switch k {
		case "event_id", "global_seq", "payload":
			continue // per-instance values; presence is what is pinned here
		case "occurred_at":
			if string(gotRaw) != `"2026-10-14T18:00:00Z"` {
				t.Errorf("occurred_at = %s, want the example's RFC 3339 timestamp", gotRaw)
			}
		case "actor":
			var a, w Actor
			if err := json.Unmarshal(gotRaw, &a); err != nil {
				t.Fatalf("decode actor %s: %v", gotRaw, err)
			}
			if err := json.Unmarshal(wantRaw, &w); err != nil {
				t.Fatalf("decode example actor: %v", err)
			}
			if a.Kind != w.Kind {
				t.Errorf("actor.kind = %q, want %q", a.Kind, w.Kind)
			}
		default:
			if string(gotRaw) != string(wantRaw) {
				t.Errorf("%s = %s, want %s", k, gotRaw, wantRaw)
			}
		}
	}
}

func TestM1TypeConstants(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`) // the schema's type pattern
	for _, tt := range []struct{ got, want string }{
		{TypeProjectCreated, "project.created"},
		{TypeProjectMemberUpdated, "project.member.updated"},
		{TypeRepositoryAdded, "repository.added"},
	} {
		if tt.got != tt.want {
			t.Errorf("event type constant = %q, want %q", tt.got, tt.want)
		}
		if !pattern.MatchString(tt.got) {
			t.Errorf("event type %q does not match the schema pattern %s", tt.got, pattern)
		}
	}
}

func TestValidActorKind(t *testing.T) {
	for _, tt := range []struct {
		kind string
		want bool
	}{
		{"human", true}, {"system", true}, {"agent", true}, {"integration", true},
		{"worker", true}, {"", false}, {"Human", false}, {"admin", false},
	} {
		if got := ValidActorKind(tt.kind); got != tt.want {
			t.Errorf("ValidActorKind(%q) = %v, want %v", tt.kind, got, tt.want)
		}
	}
}

func TestHumanActor(t *testing.T) {
	if got, want := Human("u-1"), (Actor{Kind: "human", ID: "u-1"}); got != want {
		t.Errorf("Human(%q) = %+v, want %+v", "u-1", got, want)
	}
}

// ------------------------------------------------------------ M2 contract

// m2Types is the full M2 event-type surface, paired with the payload struct the
// control plane and the worker must emit for it. The pairing is the contract
// three implementation workers build against, so it is asserted rather than
// implied by prose.
func m2Types() []struct {
	constant string
	literal  string
	payload  any
} {
	return []struct {
		constant string
		literal  string
		payload  any
	}{
		{TypeConversationCreated, "conversation.created", ConversationCreatedPayload{}},
		{TypeConversationControlTransferred, "conversation.control.transferred", ControlTransferredPayload{}},
		{TypeConversationMessageUser, "conversation.message.user", MessageUserPayload{}},
		{TypeConversationMessageAgent, "conversation.message.agent", MessageAgentPayload{}},
		{TypeConversationThought, "conversation.thought", ThoughtPayload{}},
		{TypeConversationToolCall, "conversation.tool.call", ToolCallPayload{}},
		{TypeConversationToolUpdate, "conversation.tool.update", ToolUpdatePayload{}},
		{TypeConversationPermissionRequested, "conversation.permission.requested", PermissionRequestedPayload{}},
		{TypeConversationPermissionDecided, "conversation.permission.decided", PermissionDecidedPayload{}},
		{TypeConversationTurnStarted, "conversation.turn.started", TurnStartedPayload{}},
		{TypeConversationTurnCompleted, "conversation.turn.completed", TurnCompletedPayload{}},
		{TypeConversationTurnCancelled, "conversation.turn.cancelled", TurnCancelledPayload{}},
		{TypeConversationTurnFailed, "conversation.turn.failed", TurnFailedPayload{}},
		{TypeConversationTurnInterrupted, "conversation.turn.interrupted", TurnInterruptedPayload{}},
		{TypeAgentSessionConnected, "agent.session.connected", SessionConnectedPayload{}},
		{TypeAgentSessionDisconnected, "agent.session.disconnected", SessionDisconnectedPayload{}},
	}
}

// TestM2TypeConstants pins each M2 event type's spelling and checks it against
// the envelope schema's own `type` pattern: a dotted name the journal would
// reject is a contract bug, not a typo in a test.
func TestM2TypeConstants(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
	seen := map[string]bool{}
	for _, tt := range m2Types() {
		if tt.constant != tt.literal {
			t.Errorf("event type constant = %q, want %q", tt.constant, tt.literal)
		}
		if seen[tt.constant] {
			t.Errorf("event type %q listed twice", tt.constant)
		}
		seen[tt.constant] = true
		if !pattern.MatchString(tt.constant) {
			t.Errorf("event type %q does not match the schema pattern %s", tt.constant, pattern)
		}
	}
}

// TestM2TypesDocumentedInOpenAPI keeps api/openapi.yaml honest: every event type
// a worker can append must be named by the API contract the UI is generated
// from, or the UI silently drops transcript rows.
func TestM2TypesDocumentedInOpenAPI(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	doc := string(raw)
	for _, tt := range m2Types() {
		if !strings.Contains(doc, tt.constant) {
			t.Errorf("event type %q is not documented in api/openapi.yaml", tt.constant)
		}
	}
}

// TestM2PayloadFieldNames pins the JSON member set of every M2 payload, in
// sorted order. Payloads are validated by their own schema, not the envelope's,
// so this test is the only thing standing between a renamed field and a broken
// worker->browser transcript render.
func TestM2PayloadFieldNames(t *testing.T) {
	want := map[string][]string{
		"ConversationCreatedPayload": {
			"agent_profile_id", "agent_profile_name", "controller_user_id", "control_version",
			"conversation_id", "launcher_id", "project_id", "title",
		},
		"ControlTransferredPayload": {
			"conversation_id", "control_version", "from_kind", "from_user_id",
			"reason", "to_kind", "to_user_id", "turn_id",
		},
		"MessageUserPayload": {
			"conversation_id", "submitted_by", "text", "turn_id",
		},
		"MessageAgentPayload": {
			"chunk_seq", "conversation_id", "final", "text", "truncated", "turn_id",
		},
		"ThoughtPayload": {
			"chunk_seq", "conversation_id", "text", "truncated", "turn_id",
		},
		"ToolCallPayload": {
			"conversation_id", "input_preview", "kind", "status", "title", "tool_call_id", "truncated", "turn_id",
		},
		"ToolUpdatePayload": {
			"conversation_id", "output_preview", "status", "title", "tool_call_id", "truncated", "turn_id", "update_seq",
		},
		"PermissionRequestedPayload": {
			"conversation_id", "deadline_at", "kind", "options", "permission_request_id",
			"title", "tool_call_id", "turn_id",
		},
		"PermissionDecidedPayload": {
			"conversation_id", "decided_by", "decision_option_id", "permission_request_id", "status", "turn_id",
		},
		"TurnStartedPayload": {
			"acp_session_id", "binding_id", "conversation_id", "fencing_token",
			"session_origin", "turn_id", "worker_id",
		},
		"TurnCompletedPayload": {
			"conversation_id", "fencing_token", "stop_reason", "turn_id", "worker_id",
		},
		"TurnCancelledPayload": {
			"conversation_id", "fencing_token", "requested_by", "stop_reason", "turn_id", "worker_id",
		},
		"TurnFailedPayload": {
			"conversation_id", "fencing_token", "message", "stop_reason", "turn_id", "worker_id",
		},
		"TurnInterruptedPayload": {
			"conversation_id", "fencing_token", "reason", "turn_id", "worker_id",
		},
		"SessionConnectedPayload": {
			"acp_session_id", "agent_capabilities", "binding_id", "conversation_id", "launcher_id",
			"launcher_version", "protocol_version", "session_origin", "worker_id",
		},
		"SessionDisconnectedPayload": {
			"acp_session_id", "binding_id", "conversation_id", "reason", "worker_id",
		},
		"PermissionOption": {
			"kind", "label", "option_id",
		},
	}

	// Every member, including the optional ones, has to appear: each value is
	// populated so the marshalled key set is the payload's full vocabulary,
	// which is what a consumer's parser must accept.
	full := map[string]any{
		"ConversationCreatedPayload": ConversationCreatedPayload{
			ConversationID: "c-1", ProjectID: "p-1", Title: "T", AgentProfileID: "ap-1",
			AgentProfileName: "Claude Code", LauncherID: "claude", ControllerUserID: "u-1", ControlVersion: 1,
		},
		"ControlTransferredPayload": ControlTransferredPayload{
			ConversationID: "c-1", TurnID: "t-1", FromKind: ControllerKindHuman, FromUserID: "u-1",
			ToKind: ControllerKindHuman, ToUserID: "u-2", Reason: TransferTaken, ControlVersion: 2,
		},
		"MessageUserPayload": MessageUserPayload{
			ConversationID: "c-1", TurnID: "t-1", SubmittedBy: "u-1", Text: "hi",
		},
		"MessageAgentPayload": MessageAgentPayload{
			ConversationID: "c-1", TurnID: "t-1", ChunkSeq: 1, Text: "hello", Truncated: true, Final: true,
		},
		"ThoughtPayload": ThoughtPayload{
			ConversationID: "c-1", TurnID: "t-1", ChunkSeq: 1, Text: "thinking", Truncated: true,
		},
		"ToolCallPayload": ToolCallPayload{
			ConversationID: "c-1", TurnID: "t-1", ToolCallID: "call-1", Title: "edit", Kind: "edit",
			Status: "pending", InputPreview: "{\"path\":\"main.go\"}", Truncated: true,
		},
		"ToolUpdatePayload": ToolUpdatePayload{
			ConversationID: "c-1", TurnID: "t-1", ToolCallID: "call-1", Status: "completed",
			Title: "edit", OutputPreview: "ok", Truncated: true, UpdateSeq: 1,
		},
		"PermissionRequestedPayload": PermissionRequestedPayload{
			ConversationID: "c-1", TurnID: "t-1", PermissionRequestID: "pr-1", ToolCallID: "call-1",
			Title: "Write main.go", Kind: "edit",
			Options:    []PermissionOption{{OptionID: "allow_once", Label: "Allow once", Kind: "allow_once"}},
			DeadlineAt: "2026-10-14T18:05:00Z",
		},
		"PermissionDecidedPayload": PermissionDecidedPayload{
			ConversationID: "c-1", TurnID: "t-1", PermissionRequestID: "pr-1", Status: PermissionStatusDecided,
			DecisionOptionID: "allow_once", DecidedBy: "u-1",
		},
		"TurnStartedPayload": TurnStartedPayload{
			ConversationID: "c-1", TurnID: "t-1", WorkerID: "w-1", FencingToken: 1,
			BindingID: "b-1", ACPSessionID: "s-1", SessionOrigin: SessionOriginNew,
		},
		"TurnCompletedPayload": TurnCompletedPayload{
			ConversationID: "c-1", TurnID: "t-1", WorkerID: "w-1", FencingToken: 1, StopReason: "end_turn",
		},
		"TurnCancelledPayload": TurnCancelledPayload{
			ConversationID: "c-1", TurnID: "t-1", WorkerID: "w-1", FencingToken: 1,
			StopReason: "cancelled", RequestedBy: "u-2",
		},
		"TurnFailedPayload": TurnFailedPayload{
			ConversationID: "c-1", TurnID: "t-1", WorkerID: "w-1", FencingToken: 1,
			StopReason: "refusal", Message: "agent returned an error",
		},
		"TurnInterruptedPayload": TurnInterruptedPayload{
			ConversationID: "c-1", TurnID: "t-1", WorkerID: "w-1", FencingToken: 1, Reason: InterruptLeaseExpired,
		},
		"SessionConnectedPayload": SessionConnectedPayload{
			ConversationID: "c-1", BindingID: "b-1", WorkerID: "w-1", ACPSessionID: "s-1", ProtocolVersion: 1,
			LauncherID: "claude", LauncherVersion: "0.90.0", SessionOrigin: SessionOriginResumed,
			AgentCapabilities: map[string]any{"loadSession": true},
		},
		"SessionDisconnectedPayload": SessionDisconnectedPayload{
			ConversationID: "c-1", BindingID: "b-1", WorkerID: "w-1", ACPSessionID: "s-1", Reason: InterruptShutdown,
		},
		"PermissionOption": PermissionOption{OptionID: "allow_once", Label: "Allow once", Kind: "allow_once"},
	}

	for name, fields := range want {
		v, ok := full[name]
		if !ok {
			t.Errorf("no M2 payload struct %q to check", name)
			continue
		}
		sort.Strings(fields) // the expectation is a set; jsonKeys returns sorted keys
		got := jsonKeys(t, v)
		if !reflect.DeepEqual(got, fields) {
			t.Errorf("%s JSON members = %v, want %v", name, got, fields)
		}
		delete(full, name)
	}
	for name := range full {
		if _, ok := want[name]; !ok {
			t.Errorf("M2 payload %q has no pinned member list", name)
		}
	}
}

// TestM2PayloadsAreObjects pins the one thing the envelope schema requires of
// every payload: it is an object, never an array, string or null.
func TestM2PayloadsAreObjects(t *testing.T) {
	for _, tt := range m2Types() {
		raw, err := json.Marshal(tt.payload)
		if err != nil {
			t.Fatalf("%s: marshal: %v", tt.literal, err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("%s: payload is not a JSON object: %s", tt.literal, raw)
			continue
		}
		if _, ok := m["conversation_id"]; !ok {
			t.Errorf("%s: payload has no conversation_id, so a stream reader cannot attribute it", tt.literal)
		}
	}
}

func TestM2EnumValidators(t *testing.T) {
	cases := []struct {
		name  string
		valid func(string) bool
		yes   []string
		no    []string
	}{
		{"controller kind", ValidControllerKind,
			[]string{"none", "human", "run_attempt"}, []string{"", "user", "factory_run", "Human"}},
		{"turn status", ValidTurnStatus,
			[]string{"queued", "leased", "running", "completed", "cancelled", "failed", "interrupted"},
			[]string{"", "pending", "succeeded", "Cancelled"}},
		{"permission status", ValidPermissionStatus,
			[]string{"pending", "decided", "expired", "cancelled"},
			[]string{"", "allowed", "denied", "Decided"}},
		{"session origin", ValidSessionOrigin, []string{"new", "resumed"},
			[]string{"", "load", "resume", "New", "reused"}},
		{"turn session origin", ValidTurnSessionOrigin,
			[]string{"new", "resumed", "reused"},
			[]string{"", "load", "loaded", "Reused"}},
		{"binding status", ValidBindingStatus,
			[]string{"connected", "disconnected", "closed"},
			[]string{"", "live", "errored", "Connected"}},
		{"transfer reason", ValidTransferReason,
			[]string{"taken", "returned", "lost_lease"}, []string{"", "stolen", "give_back"}},
		{"interrupt reason", ValidInterruptReason,
			[]string{"lease_expired", "worker_gone", "shutdown"}, []string{"", "crash", "timeout"}},
	}
	for _, c := range cases {
		for _, v := range c.yes {
			if !c.valid(v) {
				t.Errorf("%s: Valid(%q) = false, want true", c.name, v)
			}
		}
		for _, v := range c.no {
			if c.valid(v) {
				t.Errorf("%s: Valid(%q) = true, want false", c.name, v)
			}
		}
	}
}

// TestNewCarriesConversationScope guards the ADR-0016 store obligation: the
// append input has a conversation field at all, and it is a plain string like
// the other scopes (a missing field here means conversation events silently
// land in the project stream only).
func TestNewCarriesConversationScope(t *testing.T) {
	n := New{
		Type:           TypeConversationMessageUser,
		OrganizationID: "o-1",
		ProjectID:      "p-1",
		ConversationID: "c-1",
		Actor:          Human("u-1"),
	}
	if n.ConversationID != "c-1" || n.ProjectID != "p-1" {
		t.Errorf("New scopes lost: project=%q conversation=%q", n.ProjectID, n.ConversationID)
	}
	rt := reflect.TypeOf(n)
	for _, field := range []string{"ProjectID", "ConversationID"} {
		f, ok := rt.FieldByName(field)
		if !ok {
			t.Fatalf("events.New has no %s field", field)
		}
		if f.Type.Kind() != reflect.String {
			t.Errorf("events.New.%s is %s, want string", field, f.Type)
		}
	}
}

// TestM2PayloadFieldsMatchOpenAPITable closes the loop between the two places
// the M2 payload shapes are written down: the table in
// streamConversationEvents' description in api/openapi.yaml (what the UI is
// generated against) and the Go structs (what the control plane and the worker
// emit). A field renamed in one and not the other fails here, which is the
// whole point of freezing the contract before three workers build on it.
func TestM2PayloadFieldsMatchOpenAPITable(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}

	// Each table row is "| `type` | `a`, `b`, ... |" inside a description block
	// scalar, so the rows are found as lines rather than by parsing YAML.
	wanted := map[string]map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "| `") {
			continue
		}
		cells := strings.Split(strings.Trim(trimmed, "|"), "|")
		if len(cells) < 2 {
			continue
		}
		eventType := strings.Trim(strings.TrimSpace(cells[0]), "`")
		if !strings.Contains(eventType, ".") || strings.HasPrefix(eventType, "type") {
			continue // header row
		}
		fields := map[string]bool{}
		for _, f := range backticked(strings.TrimSpace(cells[1])) {
			fields[f] = true
		}
		wanted[eventType] = fields
	}
	if len(wanted) == 0 {
		t.Fatal("no event payload table found in api/openapi.yaml")
	}

	byType := map[string]any{}
	for _, tt := range m2Types() {
		byType[tt.constant] = tt.payload
	}
	// M3 rows in the same table are checked the same way — one table, one
	// mechanism, so an M3 event documented without a Go payload fails here too.
	for _, tt := range m3Types() {
		byType[tt.constant] = tt.payload
	}
	// M4 rows ride the same mechanism (docs/m4-contract.md § 3's table is
	// this one table): a documented run/node/approval/pipeline/assignment
	// payload with no Go struct, or a Go struct outside the table, fails here.
	for _, tt := range m4Types() {
		byType[tt.constant] = tt.payload
	}

	for typ, fields := range wanted {
		payload, ok := byType[typ]
		if !ok {
			// M1 rows (project.*, repository.*) are documented the same way and
			// have no Go payload struct by design (09: unmodelled payloads).
			if !strings.HasPrefix(typ, "project.") && !strings.HasPrefix(typ, "repository.") {
				t.Errorf("openapi documents event type %q with a payload table, but internal/events has no such constant", typ)
			}
			continue
		}
		// Zero values omit optional members, so fill every member first.
		got := map[string]bool{}
		for _, k := range jsonKeys(t, filledValue(t, payload)) {
			got[k] = true
		}
		for k := range fields {
			if !got[k] {
				t.Errorf("%s: openapi documents payload field %q, which the Go struct does not emit", typ, k)
			}
		}
		for k := range got {
			if !fields[k] {
				t.Errorf("%s: Go payload emits %q, which the openapi table does not document", typ, k)
			}
		}
	}
}

// backticked returns the identifiers inside single backticks, which is how the
// payload table writes field names.
func backticked(s string) []string {
	var out []string
	for {
		i := strings.IndexByte(s, '`')
		if i < 0 {
			return out
		}
		s = s[i+1:]
		j := strings.IndexByte(s, '`')
		if j < 0 {
			return out
		}
		out = append(out, s[:j])
		s = s[j+1:]
	}
}

// filledValue returns a copy of payload with every member set, so a zero value's
// omitempty omissions cannot hide a documented field. It is deliberately
// reflective rather than a per-type fixture: the point is the member set.
func filledValue(t *testing.T, payload any) any {
	t.Helper()
	v := reflect.ValueOf(payload)
	if v.Kind() != reflect.Struct {
		t.Fatalf("payload %T is not a struct", payload)
	}
	out := reflect.New(v.Type()).Elem()
	for i := range out.NumField() {
		f := out.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString("x")
		case reflect.Bool:
			f.SetBool(true)
		case reflect.Int:
			f.SetInt(1)
		case reflect.Int64:
			f.SetInt(2)
		case reflect.Slice:
			f.Set(reflect.MakeSlice(f.Type(), 1, 1))
		case reflect.Map:
			m := reflect.MakeMapWithSize(f.Type(), 1)
			m.SetMapIndex(reflect.New(f.Type().Key()).Elem(), reflect.New(f.Type().Elem()).Elem())
			f.Set(m)
		}
	}
	return out.Interface()
}

// ------------------------------------------------------------ M3 contract

// m3Types is the M3 event-type surface (docs/m3-contract.md § 3) paired with the
// payload struct the control plane and the worker must emit for it. Same purpose
// as m2Types: the pairing is what three parallel M3 workers build against, so it
// is asserted rather than implied by prose.
func m3Types() []struct {
	constant string
	literal  string
	payload  any
} {
	return []struct {
		constant string
		literal  string
		payload  any
	}{
		{TypeWorkspacePrepared, "workspace.prepared", WorkspacePreparedPayload{}},
		{TypeWorkspaceCommitted, "workspace.committed", WorkspaceCommittedPayload{}},
		{TypeWorkspaceQuarantined, "workspace.quarantined", WorkspaceQuarantinedPayload{}},
		{TypeWorkspaceReleased, "workspace.released", WorkspaceReleasedPayload{}},
		{TypeWorkspaceRecoveryLost, "workspace.recovery_lost", WorkspaceRecoveryLostPayload{}},
		{TypeSandboxVerified, "sandbox.verified", SandboxVerifiedPayload{}},
		{TypeSandboxEnforcementFailed, "sandbox.enforcement_failed", SandboxEnforcementFailedPayload{}},
		{TypeSecretCreated, "secret.created", SecretCreatedPayload{}},
		{TypeSecretVersionAdded, "secret.version.added", SecretVersionAddedPayload{}},
		{TypeSecretPolicyUpdated, "secret.policy.updated", SecretPolicyUpdatedPayload{}},
		{TypeSecretRevoked, "secret.revoked", SecretRevokedPayload{}},
		{TypeSecretMaterialized, "secret.materialized", SecretMaterializedPayload{}},
		{TypeSecretRemoved, "secret.removed", SecretRemovedPayload{}},
		{TypeSecretMaterializationFailed, "secret.materialization_failed", SecretMaterializationFailedPayload{}},
		{TypeArtifactCreated, "artifact.created", ArtifactCreatedPayload{}},
		{TypeArtifactDeleted, "artifact.deleted", ArtifactDeletedPayload{}},
		{TypeRepositoryMirrorUpdated, "repository.mirror_updated", RepositoryMirrorUpdatedPayload{}},
	}
}

// TestM3TypeConstants pins each M3 event type's spelling against the envelope
// schema's own `type` pattern. The `.`-joined lowercase form is not a convention
// — a name the journal's schema would reject is a contract bug.
func TestM3TypeConstants(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
	seen := map[string]bool{}
	for _, tt := range m3Types() {
		if tt.constant != tt.literal {
			t.Errorf("event type constant = %q, want %q", tt.constant, tt.literal)
		}
		if seen[tt.constant] {
			t.Errorf("event type %q listed twice", tt.constant)
		}
		seen[tt.constant] = true
		if !pattern.MatchString(tt.constant) {
			t.Errorf("event type %q does not match the schema pattern %s", tt.constant, pattern)
		}
	}
}

// TestM3TypesDocumentedInOpenAPI keeps api/openapi.yaml honest for the M3 surface
// too: an event type the worker can append that the API contract does not name is
// an event the UI silently drops.
func TestM3TypesDocumentedInOpenAPI(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	doc := string(raw)
	for _, tt := range m3Types() {
		if !strings.Contains(doc, tt.constant) {
			t.Errorf("event type %q is not documented in api/openapi.yaml", tt.constant)
		}
	}
}

// TestM3PayloadFieldNames pins the JSON member set of every M3 payload. The
// envelope schema validates payloads only as objects, so this is the only thing
// between a renamed field and a UI that renders nothing.
func TestM3PayloadFieldNames(t *testing.T) {
	want := map[string][]string{
		"WorkspacePreparedPayload": {
			"base_commits", "conversation_id", "policy_digest", "project_id", "repos",
			"run_id", "scope_kind", "volume_id", "worker_id", "workspace_id", "workspace_mode",
		},
		"WorkspaceRepoRef": {"name", "repository_id", "run_ref"},
		"WorkspaceCommittedPayload": {
			"head_commit", "project_id", "repository_id", "run_ref", "workspace_id",
		},
		"WorkspaceQuarantinedPayload": {"project_id", "reason", "workspace_id"},
		"WorkspaceReleasedPayload":    {"project_id", "repos_pruned", "workspace_id"},
		"WorkspaceRecoveryLostPayload": {
			"expected_volume_id", "found_volume_id", "project_id", "reason", "workspace_id",
		},
		"SandboxVerifiedPayload": {
			"af_unix_mediation", "backend", "backend_version", "commit_granted", "grants",
			"network", "network_enforced", "policy_digest", "project_id", "turn_id",
			"verified", "worker_id", "workspace_id",
		},
		"SandboxGrant": {"access", "role"},
		"SandboxEnforcementFailedPayload": {
			"backend", "backend_version", "child_started", "detail", "policy_digest", "project_id",
			"reason", "stage", "turn_id", "verified", "worker_id", "workspace_id",
		},
		"SecretCreatedPayload": {
			"allowed_agent_profile_ids", "delivery_mode", "project_id", "purpose",
			"scope", "secret_id", "slug", "version",
		},
		"SecretVersionAddedPayload": {
			"key_id", "previous_version", "project_id", "secret_id", "version",
		},
		"SecretPolicyUpdatedPayload": {
			"after", "before", "project_id", "secret_id",
		},
		"SecretPolicyState": {
			"allowed_agent_profile_ids", "audit_policy", "purpose",
		},
		"SecretRevokedPayload": {"project_id", "revoked_at", "revoked_by", "secret_id", "versions"},
		"SecretMaterializedPayload": {
			"delivery_mode", "env_name", "lifecycle", "mode", "policy_digest", "project_id",
			"relative_path", "repository_name", "secret_id", "slug", "turn_id",
			"version", "workspace_id",
		},
		"SecretRemovedPayload": {
			"cleaned_by", "project_id", "secret_id", "target", "turn_id", "workspace_id",
		},
		"SecretMaterializationFailedPayload": {
			"child_started", "delivery_mode", "project_id", "reason", "secret_id",
			"slug", "target", "turn_id", "workspace_id",
		},
		"ArtifactCreatedPayload": {
			"artifact_id", "kind", "media_type", "name", "project_id", "redaction_count",
			"sensitivity", "sha256", "size_bytes", "turn_id", "workspace_id",
		},
		"ArtifactDeletedPayload": {"artifact_id", "project_id", "reason"},
		"RepositoryMirrorUpdatedPayload": {
			"fetch_duration_ms", "from_commit", "mirror_kind", "project_id",
			"repository_id", "to_commit", "worker_id",
		},
	}

	full := map[string]any{
		"WorkspacePreparedPayload": WorkspacePreparedPayload{
			WorkspaceID: "ws-1", ProjectID: "p-1", ScopeKind: WorkspaceScopeConversation,
			ConversationID: "c-1", RunID: "r-1", WorkerID: "w-1",
			VolumeID: "sha256:" + strings.Repeat("1", 64), WorkspaceMode: WorkspaceModeWorktree,
			Repos:        []WorkspaceRepoRef{{RepositoryID: "repo-1", Name: "backend", RunRef: "c-1/backend"}},
			BaseCommits:  map[string]string{"backend": "2222222222222222222222222222222222222222"},
			PolicyDigest: "sha256:" + strings.Repeat("2", 64),
		},
		"WorkspaceRepoRef":            WorkspaceRepoRef{RepositoryID: "repo-1", Name: "backend", RunRef: "c-1/backend"},
		"WorkspaceCommittedPayload":   WorkspaceCommittedPayload{WorkspaceID: "ws-1", ProjectID: "p-1", RepositoryID: "repo-1", RunRef: "c-1/backend", HeadCommit: "3333333333333333333333333333333333333333"},
		"WorkspaceQuarantinedPayload": WorkspaceQuarantinedPayload{WorkspaceID: "ws-1", ProjectID: "p-1", Reason: QuarantineSecretLeftBehind},
		"WorkspaceReleasedPayload":    WorkspaceReleasedPayload{WorkspaceID: "ws-1", ProjectID: "p-1", ReposPruned: true},
		"WorkspaceRecoveryLostPayload": WorkspaceRecoveryLostPayload{
			WorkspaceID: "ws-1", ProjectID: "p-1",
			ExpectedVolumeID: "sha256:" + strings.Repeat("1", 64),
			FoundVolumeID:    "sha256:" + strings.Repeat("9", 64),
			Reason:           RecoveryVolumeChanged,
		},
		"SandboxVerifiedPayload": SandboxVerifiedPayload{
			ProjectID: "p-1", TurnID: "t-1", WorkspaceID: "ws-1", WorkerID: "w-1",
			PolicyDigest: "sha256:" + strings.Repeat("2", 64), Backend: "nono",
			BackendVersion: "0.80.0", AfUnixMediation: "pathname", NetworkEnforced: false,
			Network:       "open",
			Grants:        []SandboxGrant{{Role: GrantRoleWorkspaceRepo, Access: GrantAccessRW}},
			CommitGranted: true, Verified: true,
		},
		"SandboxGrant": SandboxGrant{Role: GrantRoleMirrorRead, Access: GrantAccessRO},
		"SandboxEnforcementFailedPayload": SandboxEnforcementFailedPayload{
			ProjectID: "p-1", TurnID: "t-1", WorkspaceID: "ws-1", WorkerID: "w-1",
			Stage: SandboxStageGrantAssert, Reason: SandboxReasonTempPathGrant,
			Backend: "nono", BackendVersion: "0.80.0",
			PolicyDigest: "sha256:" + strings.Repeat("2", 64), Detail: "grant role workspace_repo resolved under /tmp",
		},
		"SecretCreatedPayload": SecretCreatedPayload{
			SecretID: "s-1", ProjectID: "p-1", Slug: "test-database-url",
			Scope: "project", Purpose: "m3-exit", DeliveryMode: "env_file", Version: 1,
			AllowedAgentProfileIDs: []string{"ap-1"},
		},
		"SecretVersionAddedPayload": SecretVersionAddedPayload{
			SecretID: "s-1", ProjectID: "p-1", Version: 2,
			KeyID: "gen-2", PreviousVersion: 1,
		},
		"SecretPolicyUpdatedPayload": SecretPolicyUpdatedPayload{
			SecretID: "s-1", ProjectID: "p-1",
			Before: SecretPolicyState{Purpose: "old", AuditPolicy: "materialization", AllowedAgentProfileIDs: []string{"ap-1"}},
			After:  SecretPolicyState{Purpose: "new", AuditPolicy: "materialization_and_access", AllowedAgentProfileIDs: []string{}},
		},
		"SecretPolicyState": SecretPolicyState{Purpose: "p", AuditPolicy: "materialization", AllowedAgentProfileIDs: []string{"ap-1"}},
		"SecretRevokedPayload": SecretRevokedPayload{
			SecretID: "s-1", ProjectID: "p-1", Versions: []int{1, 2},
			RevokedAt: "2026-10-15T05:00:00Z", RevokedBy: "u-1",
		},
		"SecretMaterializedPayload": SecretMaterializedPayload{
			SecretID: "s-1", ProjectID: "p-1", Slug: "test-database-url", Version: 1,
			DeliveryMode: "env_file", RepositoryName: "backend", RelativePath: ".env.test.local",
			EnvName: "TEST_DATABASE_URL", Lifecycle: "turn", Mode: "0600",
			WorkspaceID: "ws-1", TurnID: "t-1", PolicyDigest: "sha256:" + strings.Repeat("2", 64),
		},
		"SecretRemovedPayload": SecretRemovedPayload{
			SecretID: "s-1", ProjectID: "p-1", Target: ".env.test.local",
			WorkspaceID: "ws-1", TurnID: "t-1", CleanedBy: "worker",
		},
		"SecretMaterializationFailedPayload": SecretMaterializationFailedPayload{
			SecretID: "s-1", ProjectID: "p-1", Slug: "test-database-url", DeliveryMode: "env_file",
			Target: "../../etc/x", Reason: MaterializationPathEscape,
			WorkspaceID: "ws-1", TurnID: "t-1", ChildStarted: false,
		},
		"ArtifactCreatedPayload": ArtifactCreatedPayload{
			ArtifactID: "a-1", ProjectID: "p-1", Name: "report.html", Kind: "html",
			MediaType: "text/html", SHA256: strings.Repeat("a", 64), SizeBytes: 12,
			Sensitivity: "standard", RedactionCount: 0, WorkspaceID: "ws-1", TurnID: "t-1",
		},
		"ArtifactDeletedPayload": ArtifactDeletedPayload{ArtifactID: "a-1", ProjectID: "p-1", Reason: ArtifactDeletionExpired},
		"RepositoryMirrorUpdatedPayload": RepositoryMirrorUpdatedPayload{
			ProjectID: "p-1", RepositoryID: "repo-1", WorkerID: "w-1", MirrorKind: MirrorKindFetched,
			FromCommit: "4444444444444444444444444444444444444444",
			ToCommit:   "5555555555555555555555555555555555555555", FetchDurationMS: 41,
		},
	}

	for name, fields := range want {
		v, ok := full[name]
		if !ok {
			t.Errorf("no M3 payload struct %q to check", name)
			continue
		}
		sort.Strings(fields)
		got := jsonKeys(t, v)
		if !reflect.DeepEqual(got, fields) {
			t.Errorf("%s JSON members = %v, want %v", name, got, fields)
		}
		delete(full, name)
	}
	for name := range full {
		if _, ok := want[name]; !ok {
			t.Errorf("M3 payload %q has no pinned member list", name)
		}
	}
}

// TestM3PayloadsAreObjectsAndCarryProjectID pins the two rules § 3 states for
// every M3 payload: it is an object, and it names its project — the project is
// the authorization scope of the stream it arrives on, so a payload that cannot
// name one cannot be filtered by the SSE reader.
func TestM3PayloadsAreObjectsAndCarryProjectID(t *testing.T) {
	for _, tt := range m3Types() {
		raw, err := json.Marshal(filledValue(t, tt.payload))
		if err != nil {
			t.Fatalf("%s: marshal: %v", tt.literal, err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("%s: payload is not a JSON object: %s", tt.literal, raw)
			continue
		}
		if _, ok := m["project_id"]; !ok {
			t.Errorf("%s: payload has no project_id, so a stream reader cannot attribute it", tt.literal)
		}
	}
}

// TestM3PayloadsCarryNoSecretValuesOrHostPaths is the structural half of § 3's
// "no payload carries a secret value, a .env body, an absolute host path or a
// prompt". Prose cannot stop a later worker from adding `Value string` to a
// secret payload or `RootPath string` to a workspace one — this can, and it
// reads the structs rather than the event stream because a struct field is how
// both get introduced.
func TestM3PayloadsCarryNoSecretValuesOrHostPaths(t *testing.T) {
	// Names that could receive a forbidden thing, at any nesting depth.
	denied := map[string]string{
		"value": "a secret value", "secret_value": "a secret value", "plaintext": "a decrypted value",
		"cleartext": "a decrypted value", "env_body": "a generated .env file", "ciphertext": "encrypted bytes",
		"prompt": "a user prompt", "token": "a credential", "preview_token": "a credential",
		"raw": "unfiltered material", "password": "a credential", "passphrase": "a credential",
		"root_path": "an absolute host path", "mirror_path": "an absolute host path",
		"admin_dir": "an absolute host path", "checkout_path": "an absolute host path",
		"storage_key": "an object-store key", "home": "an absolute host path", "cwd": "an absolute host path",
	}
	var walk func(v reflect.Value, typ string)
	walk = func(v reflect.Value, typ string) {
		for i := range v.NumField() {
			f := v.Type().Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if why, bad := denied[name]; bad {
				t.Errorf("%s: member %q could carry %s", typ, name, why)
			}
			if strings.HasSuffix(name, "_path") && name != "relative_path" {
				t.Errorf("%s: member %q names a path that is not relative_path", typ, name)
			}
			fv := v.Field(i)
			for fv.Kind() == reflect.Pointer || fv.Kind() == reflect.Slice {
				fv = reflect.New(fv.Type().Elem()).Elem()
			}
			if fv.Kind() == reflect.Struct && f.Type.String() != "time.Time" {
				walk(fv, typ+"."+name)
			}
		}
	}
	for _, tt := range m3Types() {
		walk(reflect.ValueOf(tt.payload), tt.literal)
	}
}

// TestM3EnumValidators exercises every M3 enum the events package owns, so the
// wire vocabulary and the database CHECKs cannot drift apart silently.
func TestM3EnumValidators(t *testing.T) {
	cases := []struct {
		name  string
		valid func(string) bool
		yes   []string
		no    []string
	}{
		{"workspace scope kind", ValidWorkspaceScopeKind,
			[]string{"conversation", "run"}, []string{"", "attempt", "Run", "node"}},
		{"workspace state", ValidWorkspaceState,
			[]string{"preparing", "ready", "quarantined", "released", "lost"},
			[]string{"", "active", "Ready", "deleted", "resumed"}},
		{"workspace mode", ValidWorkspaceMode,
			[]string{"worktree", "clone"}, []string{"", "symlink", "hardlink", "Worktree"}},
		{"quarantine reason", ValidQuarantineReason,
			[]string{"secret_left_behind", "exclusion_failed", "worktree_unusable"},
			[]string{"", "secret_found", "quarantined", "Secret_left_behind"}},
		{"recovery lost reason", ValidRecoveryLostReason,
			[]string{"volume_changed", "path_missing", "different_worker"},
			[]string{"", "volume_gone", "resumed", "unknown"}},
		{"sandbox stage", ValidSandboxStage,
			[]string{"probe", "profile", "policy_assert", "grant_assert", "exec", "runtime"},
			[]string{"", "launch", "verify", "Probe", "sandbox"}},
		{"sandbox failure reason", ValidSandboxFailureReason,
			[]string{"binary_missing", "landlock_unavailable", "fs_unverified", "tcp_unverified",
				"af_unix_not_mediated", "profile_invalid", "grant_mismatch", "temp_path_grant",
				"cwd_not_granted", "policy_delegation_refused", "deny_unsupported", "egress_check_failed"},
			[]string{"", "sandbox_off", "unknown", "Landlock_unavailable", "external_policy"}},
		{"grant role", ValidGrantRole,
			[]string{"workspace_repo", "workspace_scratch", "workspace_home", "mirror_read",
				"mirror_objects", "mirror_run_refs", "mirror_run_logs", "mirror_admin_dir", "harness_credentials"},
			[]string{"", "workspace_root", "mirror", "/workspaces/x", "Mirror_read"}},
		{"grant access", ValidGrantAccess, []string{"ro", "rw"}, []string{"", "read", "write", "RW"}},
		{"materialization failure reason", ValidMaterializationFailureReason,
			[]string{"path_escape", "absolute_path", "bad_shape", "tracked_target", "exists",
				"symlink_parent", "keyring_unreadable", "revoked_version", "broker_unsupported", "mirror_writable"},
			[]string{"", "not_found", "PERMISSION_DENIED", "written"}},
		{"artifact deletion reason", ValidArtifactDeletionReason,
			[]string{"expired", "swept", "retention"}, []string{"", "deleted", "user", "Expired"}},
		{"mirror kind", ValidMirrorKind, []string{"created", "fetched"}, []string{"", "cloned", "gc", "init"}},
	}
	for _, tc := range cases {
		for _, yes := range tc.yes {
			if !tc.valid(yes) {
				t.Errorf("%s: %q rejected, want accepted", tc.name, yes)
			}
		}
		for _, no := range tc.no {
			if tc.valid(no) {
				t.Errorf("%s: %q accepted, want rejected", tc.name, no)
			}
		}
	}
}

// ------------------------------------------------------------ M4 contract

// m4Types is the M4 event-type surface (docs/m4-contract.md § 3 rows 1-36,
// as documented by api/openapi.yaml's streamRunEvents payload table) paired
// with the payload struct the control plane and the worker must emit for it.
// Same purpose as m2Types/m3Types: the pairing is what the M4 workers build
// against, so it is asserted rather than implied by prose. run.override.applied
// (§ 3 row 37) is deliberately absent — it is reserved, never emitted.
func m4Types() []struct {
	constant string
	literal  string
	payload  any
} {
	return []struct {
		constant string
		literal  string
		payload  any
	}{
		{TypeRunCreated, "run.created", RunCreatedPayload{}},
		{TypeRunStarted, "run.started", RunStartedPayload{}},
		{TypeRunPaused, "run.paused", RunPausedPayload{}},
		{TypeRunResumed, "run.resumed", RunResumedPayload{}},
		{TypeRunWaitingHuman, "run.waiting_human", RunWaitingHumanPayload{}},
		{TypeRunRetried, "run.retried", RunRetriedPayload{}},
		{TypeRunCheckpointSaved, "run.checkpoint_saved", RunCheckpointSavedPayload{}},
		{TypeRunCheckpointRestored, "run.checkpoint_restored", RunCheckpointRestoredPayload{}},
		{TypeRunCompleted, "run.completed", RunCompletedPayload{}},
		{TypeRunFailed, "run.failed", RunFailedPayload{}},
		{TypeRunCancelRequested, "run.cancel_requested", RunCancelRequestedPayload{}},
		{TypeRunCancelled, "run.cancelled", RunCancelledPayload{}},
		{TypeRunInterrupted, "run.interrupted", RunInterruptedPayload{}},
		{TypeNodeExecutionSkipped, "node.execution_skipped", NodeExecutionSkippedPayload{}},
		{TypeNodeExecutionCancelled, "node.execution_cancelled", NodeExecutionCancelledPayload{}},
		{TypeNodeScopeStarted, "node.scope.started", NodeScopeStartedPayload{}},
		{TypeNodeScopeIteration, "node.scope.iteration", NodeScopeIterationPayload{}},
		{TypeNodeScopeCompleted, "node.scope.completed", NodeScopeCompletedPayload{}},
		{TypeNodeScopeFailed, "node.scope.failed", NodeScopeFailedPayload{}},
		{TypeNodeAttemptStarted, "node.attempt.started", NodeAttemptStartedPayload{}},
		{TypeNodeAttemptCompleted, "node.attempt.completed", NodeAttemptCompletedPayload{}},
		{TypeNodeAttemptFailed, "node.attempt.failed", NodeAttemptFailedPayload{}},
		{TypeNodeAttemptInterrupted, "node.attempt.interrupted", NodeAttemptInterruptedPayload{}},
		{TypeNodeAttemptCancelled, "node.attempt.cancelled", NodeAttemptCancelledPayload{}},
		{TypeNodeAttemptRetryScheduled, "node.attempt.retry_scheduled", NodeAttemptRetryScheduledPayload{}},
		{TypeApprovalRequested, "approval.requested", ApprovalRequestedPayload{}},
		{TypeApprovalDecided, "approval.decided", ApprovalDecidedPayload{}},
		{TypeApprovalExpired, "approval.expired", ApprovalExpiredPayload{}},
		{TypeApprovalDenied, "approval.denied", ApprovalDeniedPayload{}},
		{TypeApprovalCancelled, "approval.cancelled", ApprovalCancelledPayload{}},
		{TypePipelineCreated, "pipeline.created", PipelineCreatedPayload{}},
		{TypePipelineDraftUpdated, "pipeline.draft.updated", PipelineDraftUpdatedPayload{}},
		{TypePipelineDraftValidated, "pipeline.draft.validated", PipelineDraftValidatedPayload{}},
		{TypePipelineRevisionPublished, "pipeline.revision.published", PipelineRevisionPublishedPayload{}},
		{TypePipelineRevisionDeprecated, "pipeline.revision.deprecated", PipelineRevisionDeprecatedPayload{}},
		{TypeAssignmentCreated, "assignment.created", AssignmentCreatedPayload{}},
		{TypeAssignmentUpdated, "assignment.updated", AssignmentUpdatedPayload{}},
	}
}

// TestM4TypeConstants pins each M4 event type's spelling and checks it against
// the envelope schema's own `type` pattern, and that the reserved
// run.override.applied is never one of the emitted constants (ADR-0024 § 3:
// M4 has no emitter for it; the name exists so M5 needs no rename).
func TestM4TypeConstants(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
	seen := map[string]bool{}
	for _, tt := range m4Types() {
		if tt.constant != tt.literal {
			t.Errorf("event type constant = %q, want %q", tt.constant, tt.literal)
		}
		if seen[tt.constant] {
			t.Errorf("event type %q listed twice", tt.constant)
		}
		seen[tt.constant] = true
		if !pattern.MatchString(tt.constant) {
			t.Errorf("event type %q does not match the schema pattern %s", tt.constant, pattern)
		}
		if tt.constant == ReservedTypeRunOverrideApplied {
			t.Errorf("reserved type %q must not be an emitted constant", tt.constant)
		}
	}
	if !pattern.MatchString(ReservedTypeRunOverrideApplied) {
		t.Errorf("reserved type %q does not match the schema pattern", ReservedTypeRunOverrideApplied)
	}
}

// TestM4TypesDocumentedInOpenAPI keeps api/openapi.yaml honest for the M4
// surface too, in both directions: every constant must appear in the frozen
// contract, and the reserved name must appear only as reserved.
func TestM4TypesDocumentedInOpenAPI(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	doc := string(raw)
	for _, tt := range m4Types() {
		if !strings.Contains(doc, tt.constant) {
			t.Errorf("event type %q is not documented in api/openapi.yaml", tt.constant)
		}
	}
	if !strings.Contains(doc, ReservedTypeRunOverrideApplied) {
		t.Errorf("reserved type %q is not named by api/openapi.yaml", ReservedTypeRunOverrideApplied)
	}
}

// TestNewCarriesRunCorrelationScope guards the § 1/§ 3 store obligation in
// the same shape as TestNewCarriesConversationScope: the append input has the
// three run-correlation fields at all, and they are plain strings like the
// other scopes — a missing one here means run-stream rows silently lose their
// correlation columns.
func TestNewCarriesRunCorrelationScope(t *testing.T) {
	n := New{
		Type:            TypeNodeAttemptCompleted,
		OrganizationID:  "o-1",
		ProjectID:       "p-1",
		RunID:           "r-1",
		NodeExecutionID: "ne-1",
		AttemptID:       "at-1",
		Actor:           Actor{Kind: ActorKindWorker, ID: "worker-a"},
	}
	rt := reflect.TypeOf(n)
	for _, field := range []string{"RunID", "NodeExecutionID", "AttemptID"} {
		f, ok := rt.FieldByName(field)
		if !ok {
			t.Fatalf("events.New has no %s field", field)
		}
		if f.Type.Kind() != reflect.String {
			t.Errorf("events.New.%s is %s, want string", field, f.Type)
		}
	}
	if n.RunID != "r-1" || n.NodeExecutionID != "ne-1" || n.AttemptID != "at-1" {
		t.Errorf("New run scopes lost: run=%q node=%q attempt=%q", n.RunID, n.NodeExecutionID, n.AttemptID)
	}
}

// TestM4PayloadFieldNames pins the JSON member set of every M4 payload, in
// sorted order, following the TestM2PayloadFieldNames/TestM3PayloadFieldNames
// idiom. Payloads are validated by their own contract, not the envelope's, so
// this is the only thing standing between a renamed field and a UI (or a
// worker) that reads nothing.
func TestM4PayloadFieldNames(t *testing.T) {
	const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	digest := "sha256:" + hex64
	when := time.Date(2026, 10, 15, 9, 12, 0, 0, time.UTC)
	want := map[string][]string{
		"RunCreatedPayload": {
			"assignment_id", "depth", "digest_scope", "input_names", "parent_run_id",
			"pipeline_id", "plan_digest", "priority", "project_id", "revision_digest",
			"revision_id", "run_id",
		},
		"RunStartedPayload": {
			"project_id", "repo_snapshot", "run_id", "worker_affinity_present",
		},
		"RunPausedPayload": {
			"in_flight_attempts", "paused_reason", "project_id", "requested_by", "run_id",
		},
		"RunResumedPayload": {"paused_reason", "project_id", "run_id"},
		"RunWaitingHumanPayload": {
			"approval_id", "approver_roles", "deadline_at", "node_instance_key",
			"project_id", "run_id",
		},
		"RunRetriedPayload": {
			"input_names", "project_id", "requested_by", "run_id", "targets", "workspace_policies",
		},
		"RunCheckpointSavedPayload": {"checkpoint", "project_id", "run_id"},
		"Checkpoint": {
			"artifact_refs", "inputs_digest", "node_instance_key", "outputs_digest",
			"repo_states", "volume_id",
		},
		"RepoState": {"base_commit", "head_commit", "modified_paths_artifact", "repository_id"},
		"RunCheckpointRestoredPayload": {
			"discarded_paths", "from_commit", "node_instance_key", "project_id", "run_id",
		},
		"RunCompletedPayload": {
			"artifact_refs", "iteration_totals", "project_id", "result_bindings", "run_id",
		},
		"RunFailedPayload": {
			"budget", "evidence_artifacts", "error_class", "failed_cause",
			"node_instance_key", "project_id", "run_id",
		},
		"RunCancelRequestedPayload": {
			"cascade", "children", "project_id", "requested_by", "run_id",
		},
		"RunCancelledPayload": {
			"cancelled_attempts", "cancelled_node_executions", "project_id", "run_id",
		},
		"RunInterruptedPayload": {
			"error_class", "node_instance_keys", "project_id", "reason", "run_id",
		},
		"NodeExecutionSkippedPayload": {
			"node_instance_key", "project_id", "reason", "run_id",
		},
		"NodeExecutionCancelledPayload": {
			"node_instance_key", "project_id", "reason", "run_id",
		},
		"NodeScopeStartedPayload": {
			"items", "iteration", "kind", "node_instance_key", "project_id",
			"run_id", "scope_key",
		},
		"NodeScopeIterationPayload": {
			"items", "iteration", "node_instance_key", "pass_when_result",
			"predicate_error_detail", "project_id", "run_id", "scope_key",
		},
		"NodeScopeCompletedPayload": {
			"items", "iterations", "kind", "node_instance_key", "project_id",
			"result_bindings", "run_id", "scope_key",
		},
		"NodeScopeFailedPayload": {
			"evidence", "failed_cause", "iterations_stopped", "kind",
			"node_instance_key", "project_id", "run_id", "scope_key",
		},
		"NodeAttemptStartedPayload": {
			"attempt_number", "error_class", "node_instance_key", "project_id",
			"run_id", "sandbox_verified", "session_resumed", "worker_affinity",
		},
		"NodeAttemptCompletedPayload": {
			"artifact_refs", "attempt_number", "checkpoint_saved", "node_instance_key",
			"outputs", "outputs_digest", "project_id", "run_id",
		},
		"NodeAttemptFailedPayload": {
			"attempt_number", "detail", "error_class", "next_attempt_number",
			"node_instance_key", "output_errors", "project_id", "run_id", "scheduled_at",
		},
		"NodeAttemptInterruptedPayload": {
			"attempt_number", "node_instance_key", "project_id", "reason", "run_id",
		},
		"NodeAttemptCancelledPayload": {
			"attempt_number", "node_instance_key", "project_id", "reason", "run_id",
		},
		"NodeAttemptRetryScheduledPayload": {
			"attempt_number", "delay_seconds", "error_class", "next_attempt_number",
			"node_instance_key", "project_id", "run_id", "scheduled_at",
		},
		"ApprovalRequestedPayload": {
			"approval_id", "approver_roles", "approver_user_ids", "artifact_refs",
			"deadline_at", "node_instance_key", "on_timeout", "project_id",
			"run_id", "summary_digest",
		},
		"ApprovalDecidedPayload": {
			"approval_id", "comments_present", "decided_by", "decision",
			"project_id", "run_id", "version",
		},
		"ApprovalExpiredPayload": {
			"approval_id", "on_timeout", "project_id", "re_requested", "run_id",
		},
		"ApprovalDeniedPayload":    {"approval_id", "project_id", "reason", "run_id"},
		"ApprovalCancelledPayload": {"approval_id", "project_id", "reason", "run_id"},
		"PipelineCreatedPayload":   {"pipeline_id", "project_id", "slug"},
		"PipelineDraftUpdatedPayload": {
			"draft_id", "edited_by", "kind", "project_id", "source_sha256", "version",
		},
		"PipelineDraftValidatedPayload": {
			"draft_id", "error_codes", "error_count", "plan_digest",
			"project_id", "revision_digest", "valid",
		},
		"PipelineRevisionPublishedPayload": {
			"cel_env_digest", "digest_scope", "pipeline_id", "plan_digest",
			"project_id", "revision_digest", "revision_id", "revision_number",
			"schema_digest", "version_label",
		},
		"PipelineRevisionDeprecatedPayload": {"project_id", "revision_digest", "revision_id"},
		"AssignmentCreatedPayload": {
			"assignment_id", "budget_overrides", "max_concurrent_runs", "pinned_revision_id",
			"pipeline_id", "project_id", "revision_digest",
		},
		"AssignmentUpdatedPayload": {
			"after", "assignment_id", "before", "budget_overrides", "max_concurrent_runs",
			"pinned_revision_id", "pipeline_id", "project_id", "revision_digest",
		},
	}

	// Every member, including the optional ones, has to appear: each value is
	// populated so the marshalled key set is the payload's full vocabulary.
	full := map[string]any{
		"RunCreatedPayload": RunCreatedPayload{
			ProjectID: "p-1", RunID: "r-1", PipelineID: "pipe-1", RevisionID: "rev-1",
			RevisionDigest: digest, PlanDigest: digest, DigestScope: "v1alpha1-canonical-1",
			AssignmentID: "as-1", Depth: 1, ParentRunID: "r-0",
			InputNames: []string{"goal"}, Priority: 3,
		},
		"RunStartedPayload": RunStartedPayload{
			ProjectID: "p-1", RunID: "r-1", WorkerAffinityPresent: true,
			RepoSnapshot: []any{map[string]any{"repository_id": "repo-1", "base_commit": "2222222"}},
		},
		"RunPausedPayload": RunPausedPayload{
			ProjectID: "p-1", RunID: "r-1", PausedReason: "human_takeover",
			InFlightAttempts: []string{"at-1"}, RequestedBy: "u-1",
		},
		"RunResumedPayload": RunResumedPayload{ProjectID: "p-1", RunID: "r-1", PausedReason: "manual"},
		"RunWaitingHumanPayload": RunWaitingHumanPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1",
			NodeInstanceKey: "/approve", DeadlineAt: when, ApproverRoles: []string{"maintainer"},
		},
		"RunRetriedPayload": RunRetriedPayload{
			ProjectID: "p-1", RunID: "r-1", RequestedBy: "u-1",
			Targets: []string{"/work"}, InputNames: []string{"goal"},
			WorkspacePolicies: map[string]string{"/work": "continue_workspace"},
		},
		"RunCheckpointSavedPayload": RunCheckpointSavedPayload{
			ProjectID: "p-1", RunID: "r-1",
			Checkpoint: Checkpoint{
				NodeInstanceKey: "/work", InputsDigest: digest, OutputsDigest: digest,
				RepoStates:   []RepoState{{RepositoryID: "repo-1", BaseCommit: "111", HeadCommit: "222", ModifiedPathsArtifact: "art:mp"}},
				ArtifactRefs: []any{"art:1"}, VolumeID: "sha256:" + strings.Repeat("1", 64),
			},
		},
		"Checkpoint": Checkpoint{
			NodeInstanceKey: "/work", InputsDigest: digest, OutputsDigest: digest,
			RepoStates: []RepoState{{RepositoryID: "repo-1", BaseCommit: "111", HeadCommit: "222"}},
		},
		"RepoState": RepoState{RepositoryID: "repo-1", BaseCommit: "111", HeadCommit: "222", ModifiedPathsArtifact: "art:mp"},
		"RunCheckpointRestoredPayload": RunCheckpointRestoredPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work",
			FromCommit:     "2222222222222222222222222222222222222222",
			DiscardedPaths: []string{"hello.py"},
		},
		"RunCompletedPayload": RunCompletedPayload{
			ProjectID: "p-1", RunID: "r-1",
			ResultBindings: map[string]any{"review_approved": true},
			ArtifactRefs:   []any{"art:1"}, IterationTotals: map[string]int{"/build": 2},
		},
		"RunFailedPayload": RunFailedPayload{
			ProjectID: "p-1", RunID: "r-1", FailedCause: "expression_eval_budget_exceeded",
			ErrorClass: "predicate_error", NodeInstanceKey: "/work",
			Budget: "expression_eval_budget_exceeded", EvidenceArtifacts: []any{"art:err"},
		},
		"RunCancelRequestedPayload": RunCancelRequestedPayload{
			ProjectID: "p-1", RunID: "r-1", Cascade: true, Children: []string{"r-2"}, RequestedBy: "u-1",
		},
		"RunCancelledPayload": RunCancelledPayload{
			ProjectID: "p-1", RunID: "r-1",
			CancelledNodeExecutions: []string{"/work"}, CancelledAttempts: []string{"at-2"},
		},
		"RunInterruptedPayload": RunInterruptedPayload{
			ProjectID: "p-1", RunID: "r-1", Reason: "volume_lost",
			ErrorClass: "workspace_lost", NodeInstanceKeys: []string{"/work"},
		},
		"NodeExecutionSkippedPayload": NodeExecutionSkippedPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/review", Reason: "dependency_skipped",
		},
		"NodeExecutionCancelledPayload": NodeExecutionCancelledPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", Reason: "cascade",
		},
		"NodeScopeStartedPayload": NodeScopeStartedPayload{
			ProjectID: "p-1", RunID: "r-1", ScopeKey: "/build_until_verified[1]/",
			NodeInstanceKey: "/build_until_verified[1]/test", Kind: "until", Iteration: 1, Items: 3,
		},
		"NodeScopeIterationPayload": NodeScopeIterationPayload{
			ProjectID: "p-1", RunID: "r-1", ScopeKey: "/build_until_verified[1]/",
			NodeInstanceKey: "/build_until_verified", Iteration: 2, Items: 1,
			PassWhenResult:       boolPtr(false),
			PredicateErrorDetail: "no such key",
		},
		"NodeScopeCompletedPayload": NodeScopeCompletedPayload{
			ProjectID: "p-1", RunID: "r-1", ScopeKey: "/build_until_verified/",
			NodeInstanceKey: "/build_until_verified", Kind: "until", Iterations: 2, Items: 0,
			ResultBindings: map[string]any{"iterations": 2},
		},
		"NodeScopeFailedPayload": NodeScopeFailedPayload{
			ProjectID: "p-1", RunID: "r-1", ScopeKey: "/build_until_verified/",
			NodeInstanceKey: "/build_until_verified", Kind: "until",
			FailedCause: "until_exhausted", Evidence: []any{map[string]any{"iteration": 32}},
			Iterations: 32,
		},
		"NodeAttemptStartedPayload": NodeAttemptStartedPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", AttemptNumber: 1,
			ErrorClass: "", WorkerAffinity: true, SandboxVerified: true, SessionResumed: boolPtr(false),
		},
		"NodeAttemptCompletedPayload": NodeAttemptCompletedPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", AttemptNumber: 1,
			OutputsDigest: digest, Outputs: map[string]any{"note": "done"},
			ArtifactRefs: []any{"art:1"}, CheckpointSaved: true,
		},
		"NodeAttemptFailedPayload": NodeAttemptFailedPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", AttemptNumber: 1,
			ErrorClass: "invalid_output", Detail: "outputs rejected",
			OutputErrors: []any{"missing required property"}, NextAttemptNumber: 2,
			ScheduledAt: &when,
		},
		"NodeAttemptInterruptedPayload": NodeAttemptInterruptedPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", AttemptNumber: 1,
			Reason: "lease_expired",
		},
		"NodeAttemptCancelledPayload": NodeAttemptCancelledPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/work", AttemptNumber: 1,
			Reason: "acp_cancel_ack",
		},
		"NodeAttemptRetryScheduledPayload": NodeAttemptRetryScheduledPayload{
			ProjectID: "p-1", RunID: "r-1", NodeInstanceKey: "/build_until_verified[2]/test",
			AttemptNumber: 1, NextAttemptNumber: 2, ErrorClass: "interrupted",
			DelaySeconds: 15, ScheduledAt: when,
		},
		"ApprovalRequestedPayload": ApprovalRequestedPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1", NodeInstanceKey: "/approve",
			SummaryDigest: digest, ArtifactRefs: []any{"art:1"}, DeadlineAt: when,
			OnTimeout: "fail", ApproverRoles: []string{"maintainer"}, ApproverUserIDs: []string{"u-1"},
		},
		"ApprovalDecidedPayload": ApprovalDecidedPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1", Decision: "approved",
			CommentsPresent: true, Version: 2, DecidedBy: "u-1",
		},
		"ApprovalExpiredPayload": ApprovalExpiredPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1",
			OnTimeout: "expire", ReRequested: true,
		},
		"ApprovalDeniedPayload": ApprovalDeniedPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1", Reason: "approver_lost_access",
		},
		"ApprovalCancelledPayload": ApprovalCancelledPayload{
			ProjectID: "p-1", RunID: "r-1", ApprovalID: "ap-1", Reason: "run_cancelled",
		},
		"PipelineCreatedPayload": PipelineCreatedPayload{
			ProjectID: "p-1", PipelineID: "pipe-1", Slug: "feature-development",
		},
		"PipelineDraftUpdatedPayload": PipelineDraftUpdatedPayload{
			ProjectID: "p-1", DraftID: "d-1", Version: 2, SourceSHA256: hex64,
			EditedBy: "u-1", Kind: "yaml_import",
		},
		"PipelineDraftValidatedPayload": PipelineDraftValidatedPayload{
			ProjectID: "p-1", DraftID: "d-1", Valid: true, RevisionDigest: digest,
			PlanDigest: digest, ErrorCount: 1, ErrorCodes: []string{"cycle_detected"},
		},
		"PipelineRevisionPublishedPayload": PipelineRevisionPublishedPayload{
			ProjectID: "p-1", PipelineID: "pipe-1", RevisionID: "rev-1", RevisionNumber: 3,
			VersionLabel: "1.2.0", RevisionDigest: digest, PlanDigest: digest,
			DigestScope: "v1alpha1-canonical-1", SchemaDigest: digest, CelEnvDigest: digest,
		},
		"PipelineRevisionDeprecatedPayload": PipelineRevisionDeprecatedPayload{
			ProjectID: "p-1", RevisionID: "rev-1", RevisionDigest: digest,
		},
		"AssignmentCreatedPayload": AssignmentCreatedPayload{
			ProjectID: "p-1", AssignmentID: "as-1", PipelineID: "pipe-1",
			PinnedRevisionID: "rev-1", RevisionDigest: digest, MaxConcurrentRuns: 2,
			BudgetOverrides: map[string]any{"max_duration_seconds": 3600},
		},
		"AssignmentUpdatedPayload": AssignmentUpdatedPayload{
			ProjectID: "p-1", AssignmentID: "as-1", PipelineID: "pipe-1",
			PinnedRevisionID: "rev-1", RevisionDigest: digest, MaxConcurrentRuns: 2,
			BudgetOverrides: map[string]any{"max_duration_seconds": 3600},
			Before:          map[string]any{"max_concurrent_runs": 1},
			After:           map[string]any{"max_concurrent_runs": 2},
		},
	}

	for name, fields := range want {
		v, ok := full[name]
		if !ok {
			t.Errorf("no M4 payload struct %q to check", name)
			continue
		}
		sort.Strings(fields)
		got := jsonKeys(t, v)
		if !reflect.DeepEqual(got, fields) {
			t.Errorf("%s JSON members = %v, want %v", name, got, fields)
		}
		delete(full, name)
	}
	for name := range full {
		if _, ok := want[name]; !ok {
			t.Errorf("M4 payload %q has no pinned member list", name)
		}
	}
}

// TestM4PayloadsAreObjectsAndCarryProjectID pins the two rules § 3 states for
// every M4 payload: it is an object, and it names its project — the M4 types
// also arrive on the project stream, and the project is the authorization
// scope of every stream they can land on.
func TestM4PayloadsAreObjectsAndCarryProjectID(t *testing.T) {
	for _, tt := range m4Types() {
		raw, err := json.Marshal(filledValue(t, tt.payload))
		if err != nil {
			t.Fatalf("%s: marshal: %v", tt.literal, err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("%s: payload is not a JSON object: %s", tt.literal, raw)
			continue
		}
		if _, ok := m["project_id"]; !ok {
			t.Errorf("%s: payload has no project_id, so a stream reader cannot attribute it", tt.literal)
		}
	}
}

// TestM4PayloadsCarryNoSecretsPromptsPathsOrLeases is the structural half of
// § 3's prohibition, reusing M3's denied-name walk over the M4 types: no
// prompt body, no secret value, no absolute host path, no fencing token and
// no lease deadline can be introduced as a field without failing here. CEL
// failure text is admitted only through predicate_error_detail (the name
// itself is the contract), and the checkpoint keeps its digest vocabulary,
// never a path.
func TestM4PayloadsCarryNoSecretsPromptsPathsOrLeases(t *testing.T) {
	denied := map[string]string{
		"value": "a secret value", "secret_value": "a secret value", "plaintext": "a decrypted value",
		"cleartext": "a decrypted value", "env_body": "a generated .env file", "ciphertext": "encrypted bytes",
		"prompt": "a user prompt", "token": "a credential", "fencing_token": "a fencing token",
		"lease_expires_at": "a lease deadline", "raw": "unfiltered material", "comments": "a decision comment body",
		"summary":       "a gate summary body (only summary_digest is journal material)",
		"document_text": "a document body", "document_yaml": "a document body",
		"root_path": "an absolute host path", "mirror_path": "an absolute host path",
		"admin_dir": "an absolute host path", "checkout_path": "an absolute host path",
		"storage_key": "an object-store key", "home": "an absolute host path", "cwd": "an absolute host path",
	}
	var walk func(v reflect.Value, typ string)
	walk = func(v reflect.Value, typ string) {
		for i := range v.NumField() {
			f := v.Type().Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if why, bad := denied[name]; bad {
				t.Errorf("%s: member %q could carry %s", typ, name, why)
			}
			if strings.HasSuffix(name, "_path") {
				t.Errorf("%s: member %q names a path; § 3 admits no host paths", typ, name)
			}
			fv := v.Field(i)
			for fv.Kind() == reflect.Pointer || fv.Kind() == reflect.Slice {
				fv = reflect.New(fv.Type().Elem()).Elem()
			}
			if fv.Kind() == reflect.Struct && f.Type.String() != "time.Time" && f.Type.String() != "*time.Time" {
				walk(fv, typ+"."+name)
			}
		}
	}
	for _, tt := range m4Types() {
		walk(reflect.ValueOf(tt.payload), tt.literal)
	}
}

// filledValue leaves pointer members nil; the M4 payloads that carry a
// tri-state (pass_when_result, session_resumed, scheduled_at) deliberately
// have no omitempty so the member is still present (as null) — this helper
// just makes the fixtures above readable.
func boolPtr(b bool) *bool { return &b }
