package worker

// Offline (no-ACP) unit proof for extractStructuredOutput's balanced-object
// arm (docs/m4-contract.md § 4 step 6). Run 42045469577, shard m4-core-a-1:
// the § 7.1 C1 agent leg's /implement attempt #1 died
// invalid_output{"agent reply is not a JSON object; structuredOutput
// extraction failed (§ 4 step 6)"} while the journaled last agent message
// (global_seq=207) OPENED with `{"summary": "Documented and hardened add() …`
// — a real reply the extractor refused. The candidate that must survive a
// narrated tail / a doubled object is the brace-balanced span; the shapes
// below pin it. This tests extraction ONLY: the engine's JSON-Schema
// validation at Complete (§ 4 step 6, ADR-0022 § 4 rule 2) is a separate gate
// this test neither replaces nor loosens.
//
// usage: go test ./internal/worker/ -run TestExtractStructuredOutput

import (
	"strings"
	"testing"
)

func decodeObject(t *testing.T, val any) map[string]any {
	t.Helper()
	obj, ok := val.(map[string]any)
	if !ok {
		t.Fatalf("extraction returned %T, want a JSON object", val)
	}
	return obj
}

// TestExtractStructuredOutputBalancedArm reproduces the refused reply's
// observed head plus the tails that the first-'{'-to-last-'}' slice could not
// parse: narration after the object that contains braces, and a doubled
// object. It also pins that the pre-existing shapes still extract, and that
// truncated or non-object replies STILL say invalid_output — the fix hands
// the engine a document, it never manufactures one.
func TestExtractStructuredOutputBalancedArm(t *testing.T) {
	// The head is the journaled seq=207 text (bounded print, run 42045469577);
	// the tails are the two shapes that make the old slice unparseable while
	// the object itself is complete.
	head := `{"summary": "Documented and hardened add() in hello.py and reconciled ` +
		`its test. hello.py's add() now carries a full docstring (purpose, ` +
		`Args/Returns/Raises, and doctest-style examples) while keeping the correct, ` +
		`side-effect-free ` + "`a + b`" + ` semantics rather than hard-coding any special ` +
		`case. The fixture's test suite shipped with an intentionally failing seed: ` +
		`test_add_sums asserted ` + "`add(1, 2) == 99`" + ` while its own comment stated ` +
		`the intended reading is ` + "`== 3`" + ` semantics. Rather than make add() return ` +
		`99 for 1+2 (which would game the assertion and break the documented ` +
		`behaviour), I corrected the stale assertion.", "files_changed": ["hello.py", "tests/test_hello.py"]}`
	if _, bad := extractStructuredOutput(head); bad != nil {
		t.Fatalf("the bare object must extract: %s", *bad)
	}

	cases := []struct {
		name string
		text string
	}{
		{"narrated tail with braces", head + "\n\nVerified locally: run `pytest tests/` and watch the {status} line; the docstring covers Args/Returns/Raises as promised { in full }."},
		{"second object after the answer", head + ` {"note": "trailing extra object"}`},
		{"prose before the object", "Let me summarise: {see below}\n" + head},
		{"fenced block after narration", head + "\n```json\n" + head + "\n```"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			val, bad := extractStructuredOutput(tc.text)
			if bad != nil {
				t.Fatalf("extraction refused a reply that contains a complete object: %s", *bad)
			}
			obj := decodeObject(t, val)
			if _, ok := obj["summary"]; !ok {
				t.Fatalf("extracted %v — not the answer object the reply opened with", obj)
			}
			paths, _ := obj["files_changed"].([]any)
			if len(paths) != 2 {
				t.Fatalf("files_changed = %v, want the answer's two paths, not a prose object", obj["files_changed"])
			}
			if s, _ := obj["summary"].(string); !strings.HasPrefix(s, "Documented and hardened add()") {
				t.Fatalf("summary = %q, want the journaled reply's summary", s)
			}
		})
	}

	t.Run("a truncated object is still invalid_output", func(t *testing.T) {
		trunc := head[:len(head)-40] // cuts the closing quote/brace off
		_, bad := extractStructuredOutput(trunc)
		if bad == nil || !strings.Contains(*bad, "not a JSON object") {
			t.Fatalf("truncated reply extracted (bad=%v); an unfinished object must stay invalid_output", bad)
		}
	})

	t.Run("a json array reply keeps its sharper message", func(t *testing.T) {
		_, bad := extractStructuredOutput("[1,2]")
		if bad == nil || !strings.Contains(*bad, "not an object") {
			t.Fatalf("array reply bad=%v, want the not-an-object evidence", bad)
		}
	})

	t.Run("no json at all stays invalid_output", func(t *testing.T) {
		_, bad := extractStructuredOutput("I could not do it")
		if bad == nil || !strings.Contains(*bad, "not a JSON object") {
			t.Fatalf("prose reply bad=%v, want invalid_output", bad)
		}
	})
}

func TestBraceBalancedObjectsIsStringAware(t *testing.T) {
	s := `he said "keep the } brace" then {"a": {"b": 1}} done {x}`
	got := braceBalancedObjects(s)
	want := []string{`{"a": {"b": 1}}`, `{x}`}
	if len(got) != len(want) {
		t.Fatalf("braceBalancedObjects(%q) = %q, want %q", s, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("span %d = %q, want %q", i, got[i], want[i])
		}
	}
	if n := len(braceBalancedObjects(strings.Repeat("{} ", 40))); n != 16 {
		t.Errorf("bounded scan returned %d spans, want the 16-span cap", n)
	}
}
