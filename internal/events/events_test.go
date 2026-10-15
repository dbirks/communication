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
		Actor:          Actor{Kind: ActorKindHuman, ID: "01987a61-2345-7000-8000-abcdef012345"},
		TraceID:        "0af7651916cd43dd8448eb211c80319c",
		Payload:        map[string]any{"repository_id": "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0"},
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
			[]string{"", "load", "resume", "New"}},
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
