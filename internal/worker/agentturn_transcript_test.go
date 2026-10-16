package worker

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// The defect these tests pin: an agent.acp attempt journals its transcript into
// the conversation the attempt owns, with the same coalescing, bounds and
// redaction M2's turn loop uses (docs/m4-contract.md § 4 step 6, "transcript
// coalescing rules unchanged from M2"). Before the fix the attempt's
// conversation held one conversation.turn.completed row and nothing else, so
// the UI could not show what the agent did inside a run.

// transcriptSession emits one agent message chunk, one tool call and one tool
// update, then answers with the JSON the structured-output extractor reads.
func transcriptSession(info domain.SessionInfo, toolInput string) *agentSessionStub {
	sess := newAgentSessionStub(info)
	sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
		sess.eventsCh <- domain.ConversationEvent{Kind: "message_chunk", Text: "Reading the plan. "}
		sess.eventsCh <- domain.ConversationEvent{Kind: "thought_chunk", Text: "the schema lives in domain"}
		sess.eventsCh <- domain.ConversationEvent{Kind: "tool_call", ToolCallID: "tc-1",
			Text: "read plan.md", ToolKind: "read", ToolStatus: "pending", Input: toolInput}
		sess.eventsCh <- domain.ConversationEvent{Kind: "tool_call_update", ToolCallID: "tc-1",
			ToolStatus: "completed", Output: "plan ok"}
		sess.eventsCh <- domain.ConversationEvent{Kind: "message_chunk", Text: `{"files":["plan.md"]}`}
		return domain.StopEndTurn, nil
	}
	return sess
}

// journalOf returns the transcript rows an attempt journaled, keyed by type, in
// append order.
func journalOf(journal []AttemptEvent, typ string) []AttemptEvent {
	var out []AttemptEvent
	for _, e := range journal {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

// TestAgentTurnAttemptJournalsTranscriptIntoConversation is the exit-gate
// shape: one fake ACP session that streams a message chunk and a tool call
// produces conversation.message.agent / conversation.thought /
// conversation.tool.call / conversation.tool.update rows scoped to the
// attempt's conversation and turn, in transcript order, with previews bounded
// exactly like M2's.
func TestAgentTurnAttemptJournalsTranscriptIntoConversation(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Transcript.IdleFlush = time.Hour // flush on the tool call and at turn end only
	f.turn.Quiesce = time.Millisecond
	f.spawn.queue(transcriptSession(domain.SessionInfo{}, strings.Repeat("i", 2*DefaultMaxPreviewBytes)))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}

	msgs := journalOf(f.sink.events, events.TypeConversationMessageAgent)
	if len(msgs) < 2 {
		t.Fatalf("agent message rows = %d, want the pre-tool line and the final answer: %v",
			len(msgs), f.sink.types())
	}
	first, ok := msgs[0].Payload.(events.MessageAgentPayload)
	if !ok {
		t.Fatalf("payload type = %T, want events.MessageAgentPayload", msgs[0].Payload)
	}
	if first.ConversationID != "conv-1" || first.TurnID != "turn-1" {
		t.Errorf("message scope = %s/%s, want the attempt's stamped conversation/turn pair",
			first.ConversationID, first.TurnID)
	}
	if first.Text != "Reading the plan. " {
		t.Errorf("first chunk = %q, want the text streamed before the tool call", first.Text)
	}
	last, ok := msgs[len(msgs)-1].Payload.(events.MessageAgentPayload)
	if !ok {
		t.Fatalf("payload type = %T", msgs[len(msgs)-1].Payload)
	}
	if !last.Final {
		t.Errorf("last agent chunk carries final=false; ADR-0016 § 7 ends a completed turn's transcript with final=true")
	}
	if last.ChunkSeq <= first.ChunkSeq {
		t.Errorf("chunk order = %d then %d, want strictly increasing", first.ChunkSeq, last.ChunkSeq)
	}

	tools := journalOf(f.sink.events, events.TypeConversationToolCall)
	if len(tools) != 1 {
		t.Fatalf("tool.call rows = %d, want 1", len(tools))
	}
	call, ok := tools[0].Payload.(events.ToolCallPayload)
	if !ok {
		t.Fatalf("tool payload type = %T", tools[0].Payload)
	}
	if call.ConversationID != "conv-1" || call.TurnID != "turn-1" || call.ToolCallID != "tc-1" {
		t.Errorf("tool scope = %+v, want conv-1/turn-1/tc-1", call)
	}
	if len(call.InputPreview) > DefaultMaxPreviewBytes+len("…") || !call.Truncated {
		t.Errorf("input preview = %d bytes truncated=%v, want M2's bounded preview (cap + ellipsis) of the 2x-cap input",
			len(call.InputPreview), call.Truncated)
	}
	if call.Status != "pending" || call.Kind != "read" {
		t.Errorf("tool call status/kind = %s/%s, want the streamed pending read", call.Status, call.Kind)
	}
	updates := journalOf(f.sink.events, events.TypeConversationToolUpdate)
	if len(updates) != 1 {
		t.Fatalf("tool.update rows = %d, want 1", len(updates))
	}
	upd, ok := updates[0].Payload.(events.ToolUpdatePayload)
	if !ok || upd.OutputPreview != "plan ok" || upd.UpdateSeq != 1 || upd.ConversationID != "conv-1" {
		t.Errorf("tool update row = %+v, want the completed preview on seq 1 in conv-1", updates[0].Payload)
	}
	thoughts := journalOf(f.sink.events, events.TypeConversationThought)
	if len(thoughts) != 1 {
		t.Fatalf("thought rows = %d, want 1", len(thoughts))
	}

	// Transcript order is the order a human watched: the text before the tool
	// call is journaled before the tool row, not after it.
	if i, j := eventIndex(f.sink.events, events.TypeConversationMessageAgent), eventIndex(f.sink.events, events.TypeConversationToolCall); i > j {
		t.Errorf("first agent message at %d after tool call at %d — the sink must flush before a tool row", i, j)
	}
	// The rows are attempt-scoped too: § 3's correlation is the store's job
	// (attempt_worker_test proves the columns), here the type+payload pair is
	// what the executor owes.
	if n := len(journalOf(f.sink.events, "conversation.message.user")); n != 0 {
		t.Errorf("conversation.message.user rows = %d, want 0: the prompt row belongs to the claim transaction", n)
	}
}

func eventIndex(journal []AttemptEvent, typ string) int {
	for i, e := range journal {
		if e.Type == typ {
			return i
		}
	}
	return -1
}

// transcriptSecrets is the node_attempt arm's delivery with a working Redact:
// the black box the M2 sink honours and that redactingAttemptSink wraps around
// every attempt append.
type transcriptSecrets struct {
	mu    sync.Mutex
	value string
	calls int
}

func (s *transcriptSecrets) Materialize(_ context.Context, req MaterializeRequest) (Materialized, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if req.Lifecycle != LifecycleNodeAttempt || req.AttemptID == "" {
		return Materialized{}, errFake("not a node_attempt delivery")
	}
	value := s.value
	return Materialized{
		Env: []string{"DATABASE_URL=" + value},
		Redact: func(text string) (string, int) {
			n := strings.Count(text, value)
			if n == 0 {
				return text, 0
			}
			return strings.ReplaceAll(text, value, "<redacted>"), n
		},
		Done: func(context.Context) error { return nil },
	}, nil
}

func (s *transcriptSecrets) ReposForWorkspace(context.Context, string) ([]MaterializeRepo, error) {
	return nil, nil
}

// TestAgentTurnAttemptTranscriptIsRedacted proves the transcript rows carry no
// materialized secret: the agent cats its own .env mid-reply and the journal
// still shows only the marker (12-test-strategy case 12, at attempt scope).
func TestAgentTurnAttemptTranscriptIsRedacted(t *testing.T) {
	const secret = "sup3r-secret-token"
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Transcript.IdleFlush = time.Hour
	f.turn.Quiesce = time.Millisecond
	f.turn.Secrets = &transcriptSecrets{value: secret}
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
		// Coalesced (IdleFlush is an hour), the reply reads
		// {"db":"sup3r-secret-token"} — the agent that cats its own .env into
		// the answer, in the shape the extractor still accepts as outputs.
		// The tool call first, because agentText resets its buffer on one —
		// the text after it is the answer. Both rows carry the value: the tool
		// input preview (the agent cat'd its .env) and the reply.
		sess.eventsCh <- domain.ConversationEvent{Kind: "tool_call", ToolCallID: "tc-1",
			Text: "cat .env", ToolKind: "read", ToolStatus: "pending", Input: "DATABASE_URL=" + secret}
		sess.eventsCh <- domain.ConversationEvent{Kind: "message_chunk", Text: `{"db":"`}
		sess.eventsCh <- domain.ConversationEvent{Kind: "message_chunk", Text: secret + `"}`}
		return domain.StopEndTurn, nil
	}
	f.spawn.queue(sess)

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	raw, err := json.Marshal(f.sink.events)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Errorf("journal carries the materialized secret: %s", redactForTest(string(raw)))
	}
	if !strings.Contains(string(raw), "redacted") { // "<redacted>", json-escaped by Marshal
		t.Errorf("journal carries no redaction marker, so nothing redacted it: %s", redactForTest(string(raw)))
	}
}

func redactForTest(s string) string {
	if len(s) > 400 {
		return s[:400]
	}
	return s
}

// leaseFailingSink refuses every append from the n-th onward with ErrLeaseLost,
// the answer attemptloop.go's attemptSink gives when the fence moves under the
// attempt.
type leaseFailingSink struct {
	recordingSink
	failAt int
	err    error
}

func (s *leaseFailingSink) AppendEvent(_ context.Context, ev AttemptEvent) error {
	if s.failAt > 0 && len(s.events) >= s.failAt {
		s.err = ErrLeaseLost
		return ErrLeaseLost
	}
	s.events = append(s.events, ev)
	return nil
}

func (s *leaseFailingSink) Stopping() <-chan struct{} { return s.stopping }

// TestAgentTurnAttemptTranscriptStopsWhenFenceIsLost is the M2 sink rule at
// attempt scope: one ErrLeaseLost and the transcript stops writing forever —
// the loop's fence, not the sink, decides what a stale worker may say.
func TestAgentTurnAttemptTranscriptStopsWhenFenceIsLost(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.turn.Transcript.IdleFlush = time.Hour
	f.turn.Quiesce = time.Millisecond
	f.spawn.queue(transcriptSession(domain.SessionInfo{}, "plan.md"))
	sink := &leaseFailingSink{recordingSink: recordingSink{stopping: make(chan struct{})}, failAt: 3}

	if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), sink); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !errors.Is(sink.err, ErrLeaseLost) {
		t.Fatalf("sink error = %v, want the fence refusal to have reached the attempt body", sink.err)
	}
	if n := len(journalOf(sink.events, events.TypeConversationMessageAgent)); n > 1 {
		t.Errorf("agent message rows after the fence refused = %d, want the sink to stop writing", n)
	}
	for _, typ := range []string{events.TypeConversationToolCall, events.TypeConversationToolUpdate} {
		if n := len(journalOf(sink.events, typ)); n != 0 {
			t.Errorf("%s rows after the fence refused = %d, want 0", typ, n)
		}
	}
}
