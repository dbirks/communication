package worker

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// busySessionsStub is the ErrAttemptConversationBusy story: its first `busy`
// ConversationFor calls refuse with the one-active-turn rejection (the
// returning controller's own human prompt still holds the slot), and every
// call after that stamps the pair — the shape of the takeover journey where
// the human returns the wheel while their prompt's turn is still active
// (m4-contract § 5.3).
type busySessionsStub struct {
	mu      sync.Mutex
	busy    int
	calls   int
	stamped AttemptConversation
}

var _ AttemptSessionStore = (*busySessionsStub)(nil)

func (s *busySessionsStub) ConversationFor(_ context.Context, _ AttemptClaim) (AttemptConversation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls <= s.busy {
		return AttemptConversation{}, false, fmt.Errorf(
			"postgres: conversation conv-1 still carries a non-terminal turn: %w", ErrAttemptConversationBusy)
	}
	return s.stamped, true, nil
}

func (s *busySessionsStub) ResumableSession(context.Context, string, string) (domain.SessionInfo, bool, error) {
	return domain.SessionInfo{}, false, nil
}

func (s *busySessionsStub) RecordBinding(context.Context, AttemptClaim, string, domain.SessionInfo) (string, []string, error) {
	return "", nil, nil
}

func (s *busySessionsStub) CloseBinding(context.Context, string, string, string) ([]string, error) {
	return nil, nil
}

// TestAgentTurnConversationForWaitsForTheBusyConversation is the fix for the
// live takeover journey: the retried attempt's stamp is refused while the
// human's own turn is non-terminal (one-active-turn index, ADR-0016 § 5),
// and the claim WAITS for the slot instead of failing the attempt infra.
// Before the fix this path refused immediately — one call, a failed
// AttemptResult — and the node went failed on a turn nobody asked to stop.
func TestAgentTurnConversationForWaitsForTheBusyConversation(t *testing.T) {
	stub := &busySessionsStub{busy: 2, stamped: AttemptConversation{ConversationID: "conv-1", TurnID: "turn-2"}}
	clock := newFakeClock()
	a := &AgentTurn{Sessions: stub, Clock: clock}
	claim := AttemptClaim{AttemptID: "attempt-2"}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan struct{})
	var conv AttemptConversation
	var refusal *AttemptResult
	go func() {
		defer close(done)
		conv, refusal = a.conversationFor(ctx, claim)
	}()
	clock.tick(t) // first refusal: the human's turn is still in the slot
	clock.tick(t) // second refusal: it reached its terminal between polls
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("conversationFor is not returning after the slot opened")
	}
	if refusal != nil {
		t.Fatalf("busy wait refused the attempt: %q, want the claim to wait and then stamp", refusal.Detail)
	}
	if conv != stub.stamped {
		t.Fatalf("wait stamped %v, want the pair %v", conv, stub.stamped)
	}
	if stub.calls != 3 {
		t.Errorf("ConversationFor calls = %d, want 3 (two refusals + the stamp)", stub.calls)
	}
}

// TestAgentTurnConversationForBusyExitsWithTheAttempt pins the wait's exit:
// a stop signal (the cancel watch, a lost lease, a worker stop) cancels the
// attempt context while the slot is still held, and the wait leaves without
// writing anything — the same "ctx done here, nothing fenced written" rule
// the rest of the attempt body follows.
func TestAgentTurnConversationForBusyExitsWithTheAttempt(t *testing.T) {
	stub := &busySessionsStub{busy: 1 << 30, stamped: AttemptConversation{ConversationID: "conv-1", TurnID: "turn-2"}}
	clock := newFakeClock()
	a := &AgentTurn{Sessions: stub, Clock: clock}
	claim := AttemptClaim{AttemptID: "attempt-2"}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	var refusal *AttemptResult
	go func() {
		defer close(done)
		_, refusal = a.conversationFor(ctx, claim)
	}()
	clock.tick(t) // the wait is live; the stop signal arrives before the slot opens
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("conversationFor is not exiting on the stop signal")
	}
	if refusal == nil {
		t.Fatal("a stop signal during the busy wait must refuse the attempt, not hang")
	}
	if refusal.ErrorClass != ErrorClassInfra {
		t.Errorf("error class = %s, want infra", refusal.ErrorClass)
	}
	if !strings.Contains(refusal.Detail, "read attempt conversation") ||
		!strings.Contains(refusal.Detail, "stopped before the slot opened") {
		t.Errorf("detail = %q, want the stopped-wait refusal", refusal.Detail)
	}
	if stub.calls < 1 {
		t.Error("the wait never asked the store for the slot")
	}
}
