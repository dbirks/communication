package postgres

import (
	"fmt"
	"testing"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// The transcript read is scoped by conversation_id (api/openapi.yaml's
// /conversations/{id}/events: "the transcript *is* the journal"), and an
// agent.acp attempt's journal appends arrive through AppendAttemptEvent, which
// historically stamped only the three run columns (§ 3's rule). A run's own
// conversation then had session rows and transcript rows that named it in
// payload and not in the column the reader filters on — the empty transcript the
// UI cannot render. These rows pin the stamping to the attempt row's own
// conversation (§ 4 step 6's stamped pair) and pin that the run columns ride
// along unchanged.

func TestAttemptTranscriptAppendsStampConversationFromTheAttempt(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	sessions := &AttemptSessions{Runs: f.runs}
	profile := fmt.Sprintf("att-%s", migFixtureToken(t))
	atsProfile(t, ctx, f, f.orgID, profile, "claude", "deny", false)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	atsPlan(t, ctx, f, runID, profile)
	_, _ = f.m4WorkerNode(t, ctx, runID, "/implement")
	workerID := m4Worker(t, ctx, f.pool, "att", 1)
	atsConversationSweep(t, f)
	c := atsClaimRunning(t, ctx, f, store, workerID)
	conv, ok, err := sessions.ConversationFor(ctx, c)
	if err != nil || !ok {
		t.Fatalf("ConversationFor = (%v, %v)", conv, err)
	}

	appendOne := func(typ string, payload any) {
		t.Helper()
		if err := store.AppendAttemptEvent(ctx, c, worker.AttemptEvent{Type: typ, Payload: payload}); err != nil {
			t.Fatalf("append %s: %v", typ, err)
		}
	}
	// The executor's transcript pair, in the shape agentturn_transcript.go
	// writes it: one coalesced agent chunk, then the tool call it flushed for.
	appendOne(events.TypeConversationMessageAgent, events.MessageAgentPayload{
		ConversationID: conv.ConversationID, TurnID: conv.TurnID,
		ChunkSeq: 1, Text: "reading the plan", Truncated: false,
	})
	appendOne(events.TypeConversationToolCall, events.ToolCallPayload{
		ConversationID: conv.ConversationID, TurnID: conv.TurnID,
		ToolCallID: "tc-1", Title: "read plan.md", Kind: "read", Status: "pending",
		InputPreview: `{"path":"plan.md"}`,
	})
	// A run-ledger row on the same attempt: correlation stays run-only, or the
	// transcript stream would carry node noise to a member reading a chat.
	appendOne("node.attempt.progress", map[string]any{"x": 1})

	type row struct {
		typ    string
		convID string
	}
	var got []row
	have, err := f.pool.Query(ctx, `
		SELECT type, COALESCE(conversation_id::text, ''), run_id::text,
		       node_execution_id::text, attempt_id::text
		FROM domain_events WHERE attempt_id = $1::uuid ORDER BY global_seq`, c.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	var runIDgot, nodeIDgot, attemptIDgot string
	for have.Next() {
		var r row
		if err := have.Scan(&r.typ, &r.convID, &runIDgot, &nodeIDgot, &attemptIDgot); err != nil {
			have.Close()
			t.Fatal(err)
		}
		got = append(got, r)
	}
	have.Close()
	if len(got) < 3 {
		t.Fatalf("journal rows = %d, want the transcript pair plus the ledger row (%v)", len(got), got)
	}
	for _, r := range got {
		want := ""
		if runTranscriptType(r.typ) {
			want = conv.ConversationID
		}
		if r.convID != want {
			t.Errorf("%s conversation_id = %q, want %q (attemptConversationTx reads the stamped pair for transcript types only)",
				r.typ, r.convID, want)
		}
	}
	if runIDgot != c.RunID || nodeIDgot != c.NodeExecutionID || attemptIDgot != c.AttemptID {
		t.Errorf("correlation = (%s,%s,%s), want (%s,%s,%s): § 3's columns still ride along",
			runIDgot, nodeIDgot, attemptIDgot, c.RunID, c.NodeExecutionID, c.AttemptID)
	}

	// The reader the UI uses: the conversation stream now returns the agent's
	// own lines, which is the whole point of the stamp.
	n := awCount(t, ctx, f, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND project_id = $2::uuid
		  AND type IN ($3, $4)`, conv.ConversationID, f.projectID,
		events.TypeConversationMessageAgent, events.TypeConversationToolCall)
	if n != 2 {
		t.Errorf("conversation-scoped transcript rows = %d, want 2 (GET /conversations/{id}/events reads this scope)", n)
	}
}
