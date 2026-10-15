package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
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
