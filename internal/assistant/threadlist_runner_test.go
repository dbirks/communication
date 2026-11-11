package assistant

// thread.list through the RUNNER's loop, not just the registry: the part-2
// conversation surface is where the deployed exercise asked its thread question
// (prompt 11, "What did Pi do in the Sandbox project?"), and three things have
// to be true there that the v1 ask path does not prove on its own — the tool is
// ANNOUNCED to the model, its call is a read the trust level never GATES, and
// the answer the model is given is the caller's own threads in the /threads
// words.

import (
	"encoding/json"
	"strings"
	"testing"
)

// threadRunnerStore is the fake thread read over a runner: enough Store for
// NewConversationRunner to build, and the optional face thread.list needs.

func TestRunnerAnnouncesThreadListAndRunsItAsTheCaller(t *testing.T) {
	store := newThreadStore()
	store.withThreads(testCaller, "["+
		threadRow("t-1", "p-1", "prof-pi", "Fix the flaky test", "disconnected", false, "2026-11-11T10:00:00Z")+","+
		threadRow("t-2", "p-1", "prof-pi", "Draft the adapter swap", "idle", true, "2026-11-11T11:00:00Z")+"]")
	broker := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), store)
	r := NewConversationRunner(ConversationRunnerDeps{Broker: broker})

	announced := false
	for _, spec := range r.allToolSpecs() {
		if spec.Function.Name == wireName("thread.list") {
			announced = true
			if !strings.Contains(spec.Function.Description, "agent threads") {
				t.Fatalf("the announced description lost its thread wording: %q", spec.Function.Description)
			}
		}
	}
	if !announced {
		t.Fatalf("thread.list is missing from the runner's tool set %v", r.allToolSpecs())
	}

	// Every trust level runs a read: gating a thread list would card a lookup
	// the person could have made themselves at /threads.
	for _, level := range []TrustLevel{TrustAskAll, TrustAskRisky, TrustNoAsk} {
		out := r.execOne(t.Context(), TurnRequest{Caller: testCaller, Text: "what threads are running?", TrustLevel: level},
			level, toolCall("thread.list", nil), nil, nil, nil)
		if !out.call.OK {
			t.Fatalf("thread.list at %s = %+v, want it to run (a read never gates)", level, out.call)
		}
		if out.approval != nil {
			t.Fatalf("thread.list gated at %s; a read never waits for a confirm", level)
		}
		var rows []map[string]any
		if err := json.Unmarshal(out.payload, &rows); err != nil {
			t.Fatalf("payload is not a row array: %s", out.payload)
		}
		if len(rows) != 2 {
			t.Fatalf("rows = %d, want the caller's two threads: %s", len(rows), out.payload)
		}
		// Newest first, and in the page's words: the interrupted one is the
		// OLDER row, so t-2 leads.
		if field(rows[0], "id") != "t-2" || field(rows[0], "status") != "queued" {
			t.Fatalf("first row = %v, want the newest thread queued: %s", rows[0], out.payload)
		}
		if field(rows[1], "status") != "interrupted" {
			t.Fatalf("a disconnected thread is %q, want the /threads word: %s",
				field(rows[1], "status"), out.payload)
		}
		if field(rows[0], "agent_profile") != "Pi" || field(rows[0], "launcher") != "pi" {
			t.Fatalf("the row names no agent or launcher: %v", rows[0])
		}
		if field(rows[0], "project") != "Sandbox" {
			t.Fatalf("the row names no project: %v", rows[0])
		}
	}

	// And the transparency line says THREAD — the word the person read the
	// Threads page with (finding F-7).
	if !strings.Contains(r.execOne(t.Context(), TurnRequest{Caller: testCaller},
		TrustAskRisky, toolCall("thread.list", nil), nil, nil, nil).call.Summary, "threads") {
		t.Fatal("the thread.list summary does not use the page's word")
	}
}

// TestRunnerRefusesThreadListWhenNoReaderIsWired is the honest-degradation rule
// on the runner side: with a store that answers only the v1 six, the model is
// never told about thread.list and cannot reach it by inventing the wire name.
func TestRunnerRefusesThreadListWhenNoReaderIsWired(t *testing.T) {
	broker := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), newFakeStore())
	r := NewConversationRunner(ConversationRunnerDeps{Broker: broker})
	for _, spec := range r.allToolSpecs() {
		if spec.Function.Name == wireName("thread.list") {
			t.Fatal("thread.list was announced over a store with no thread read")
		}
	}
	out := r.execOne(t.Context(), TurnRequest{Caller: testCaller},
		TrustAskRisky, toolCall("thread.list", nil), nil, nil, nil)
	if out.call.OK || out.call.Reason != "unknown_tool" {
		t.Fatalf("unannounced call = %+v, want the unknown_tool refusal", out.call)
	}
}
