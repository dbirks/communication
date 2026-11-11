package api

// The thread.list wiring (deployed finding F-2, docs/testing/assistant-exercise-
// 2026-11-11.md): the assistant's thread read is the SAME cross-project
// conversation list the /threads page is mounted with, so the answer and the
// page cannot disagree about which threads exist. Three things are proven here,
// at the seam where the assistant package's ThreadListReader meets ADR-0047's
// store — the pieces assistant/threadtools_test.go cannot see:
//
//   - the read is made with the CALLER, not an identity of the adapter's own;
//   - the caller's page is what the tool is handed, verbatim;
//   - a lost read stays a lost read (an ordinary error → the tool's
//     `unavailable` refusal), and the thread list is only ANNOUNCED when a
//     thread reader is actually wired (assistant.announcedToolOrder's rule).

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/assistant"
)

// recordedThreadStore is the cross-project read with its page and its caller.
type recordedThreadStore struct {
	mu sync.Mutex

	items  []ConversationSummaryView
	err    error
	as     []Caller
	limits []int
}

func (s *recordedThreadStore) ListVisibleConversations(_ context.Context, c Caller,
	limit int, cursor string) ([]ConversationSummaryView, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.as = append(s.as, c)
	s.limits = append(s.limits, limit)
	if cursor != "" {
		panic("thread.list never pages: the tool's cap is smaller than one page")
	}
	if s.err != nil {
		return nil, "", s.err
	}
	return s.items, "", nil
}

func threadCaller() Caller { return Caller{UserID: "u-1", OrganizationID: "o-1"} }

// TestAssistantThreadStoreReadsAsTheCaller is the whole point of the seam: the
// assistant holds no store handle it does not pass a Caller to.
func TestAssistantThreadStoreReadsAsTheCaller(t *testing.T) {
	store := &recordedThreadStore{items: []ConversationSummaryView{
		{ID: "t-1", ProjectID: "p-1", AgentProfileID: "prof-pi", Title: "Fix the flaky test",
			Status: "disconnected"},
		{ID: "t-2", ProjectID: "p-1", AgentProfileID: "prof-pi", Title: "Draft the adapter swap",
			Status: "idle", HasActiveTurn: true},
	}}
	handle := assistant.Store(assistantThreadStore{
		assistantStore: assistantStore{projects: stubProjectReader{}},
		threads:        store,
	})
	reader, ok := handle.(assistant.ThreadListReader)
	if !ok {
		t.Fatal("the wired handle does not answer assistant.ThreadListReader")
	}
	raw, err := reader.ListAgentThreads(context.Background(),
		assistant.Caller{UserID: "u-1", OrganizationID: "o-1"})
	if err != nil {
		t.Fatalf("ListAgentThreads: %v", err)
	}
	if store.as[0].UserID != "u-1" || store.as[0].OrganizationID != "o-1" {
		t.Fatalf("the read ran as %+v, want the caller", store.as[0])
	}
	if store.limits[0] != assistantThreadFetchLimit {
		t.Fatalf("the read asked for %d rows, want the server's page (%d)",
			store.limits[0], assistantThreadFetchLimit)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("the payload is not a row array: %s", raw)
	}
	if len(rows) != 2 || rows[0]["id"] != "t-1" {
		t.Fatalf("rows = %s, want the route's own rows verbatim", raw)
	}
	if rows[1]["status"] != "idle" || rows[1]["has_active_turn"] != true {
		t.Fatalf("the adapter rewrote the wire row (%v); the TOOL owns the words: %s",
			rows[1]["status"], raw)
	}
}

// TestAssistantThreadStoreKeepsTheLostReadHonest: an ordinary store failure is
// not the 404 rule — the tool refuses with `unavailable` rather than implying
// the caller may not know these threads exist.
func TestAssistantThreadStoreKeepsTheLostReadHonest(t *testing.T) {
	store := &recordedThreadStore{err: errors.New("postgres: list visible conversations: lost connection")}
	_, err := (assistantThreadStore{threads: store}).ListAgentThreads(context.Background(),
		assistant.Caller{UserID: "u-1"})
	if err == nil || errors.Is(err, assistant.ErrNotFound) || errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("a lost read became %v; it must stay an ordinary failure (reason `unavailable`)", err)
	}
	if !strings.Contains(err.Error(), "lost connection") {
		t.Fatalf("the store's own error did not survive: %v", err)
	}
}

// TestAssistantHandleAnnouncesOnlyWhatItCanAnswer is the honest-degradation rule
// at the wiring, in all four combinations: a handle answers an optional read
// ONLY when that read's service is wired, because assistant.announcedToolOrder
// decides by type assertion. The both-wired case is the one that matters most
// and the one a wrapper over the Store interface got wrong — embedding the
// interface promotes Store's methods only, so wiring thread.list would have
// silently UNANNOUNCED catchup.brief on the deployment (serve) that has both.
func TestAssistantHandleAnnouncesOnlyWhatItCanAnswer(t *testing.T) {
	base := assistantStore{projects: stubProjectReader{}}
	noOptionals := assistantStoreHandle(base, AssistantDeps{})
	if _, answered := noOptionals.(assistant.ThreadListReader); answered {
		t.Fatal("a handle with no thread reader answered ThreadListReader")
	}
	if _, answered := noOptionals.(assistant.CatchUpBriefReader); answered {
		t.Fatal("a handle with no brief store answered CatchUpBriefReader")
	}

	threadsOnly := assistantStoreHandle(base, AssistantDeps{Threads: &recordedThreadStore{}})
	if _, answered := threadsOnly.(assistant.ThreadListReader); !answered {
		t.Fatal("thread.list would not be announced over a wired thread reader")
	}
	if _, answered := threadsOnly.(assistant.CatchUpBriefReader); answered {
		t.Fatal("catchup.brief would be announced over a store that cannot assemble it")
	}

	briefOnly := assistantStoreHandle(base, AssistantDeps{Brief: stubBrief{}})
	if _, answered := briefOnly.(assistant.CatchUpBriefReader); !answered {
		t.Fatal("catchup.brief would not be announced over a wired brief store")
	}
	if _, answered := briefOnly.(assistant.ThreadListReader); answered {
		t.Fatal("thread.list would be announced over a store with no thread reader")
	}

	both := assistantStoreHandle(base, AssistantDeps{
		Brief: stubBrief{}, Threads: &recordedThreadStore{},
	})
	if _, answered := both.(assistant.ThreadListReader); !answered {
		t.Fatal("wiring the brief unannounced thread.list")
	}
	if _, answered := both.(assistant.CatchUpBriefReader); !answered {
		t.Fatal("wiring thread.list unannounced catchup.brief — the combination type is load-bearing")
	}
	if _, ok := both.(assistantBriefThreadStore); !ok {
		t.Fatal("both reads wired did not choose the combination handle")
	}
}

// stubProjectReader is enough of the v1 store to build a handle.
type stubProjectReader struct{}

// stubBrief chooses the brief-bearing handle type without a real assembler: the
// combination test asks which METHODS a handle has — exactly what
// assistant.announcedToolOrder asserts on — and never runs a brief.
type stubBrief struct{ CatchUpBriefStore }

func (stubProjectReader) ListProjects(context.Context, Caller) ([]ProjectView, error) {
	return nil, nil
}
