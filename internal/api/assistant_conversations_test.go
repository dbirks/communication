package api

// ADR-0050 part 1: handler tests for the assistant conversation and change
// routes. The store is an in-memory fake (the real-PostgreSQL behaviour
// lives in internal/store/postgres/assistant_conversations_test.go); the
// runner is scripted, so the tests pin the route contract: statuses, the
// 404 across users, the 409 change_not_undoable, the "a failed turn stores
// nothing" rule, CSRF before the handler, and the problem shapes.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	as "github.com/dbirks/communication/internal/assistant"
)

// fakeAssistantStore is the in-memory AssistantConversationStore.
type fakeAssistantStore struct {
	mu            sync.Mutex
	conversations map[string]fakeAssistantConv
	nextCursor    string
	addTurnCalls  int
}

type fakeAssistantConv struct {
	row     AssistantConversation
	user    string
	msgs    []AssistantMessage
	changes []AssistantChange
}

func newFakeAssistantStore() *fakeAssistantStore {
	return &fakeAssistantStore{conversations: map[string]fakeAssistantConv{}}
}

func (f *fakeAssistantStore) seedConversation(userID, id, title string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conversations[id] = fakeAssistantConv{
		row: AssistantConversation{
			ID:        id,
			Title:     assistantStrPtr(title),
			CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		},
		user: userID,
	}
}

func (f *fakeAssistantStore) CreateConversation(ctx context.Context, userID string) (AssistantConversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := "conv-" + string(rune('A'+len(f.conversations)))
	f.conversations[id] = fakeAssistantConv{
		row:  AssistantConversation{ID: id, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()},
		user: userID,
	}
	return f.conversations[id].row, nil
}

func (f *fakeAssistantStore) ListConversations(ctx context.Context, userID string,
	limit int, cursor AssistantListCursor) ([]AssistantConversation, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []AssistantConversation
	for _, c := range f.conversations {
		if c.user == userID {
			out = append(out, c.row)
		}
	}
	return out, f.nextCursor, nil
}

func (f *fakeAssistantStore) GetConversation(ctx context.Context, userID, id string) (AssistantConversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conversations[id]
	if !ok || c.user != userID {
		return AssistantConversation{}, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	return c.row, nil
}

func (f *fakeAssistantStore) AddTurnMessages(ctx context.Context, userID, conversationID string,
	msgs []AssistantMessageInput) ([]AssistantMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addTurnCalls++
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	out := make([]AssistantMessage, 0, len(msgs))
	for i, m := range msgs {
		row := AssistantMessage{
			ID:        conversationID + "-m" + string(rune('0'+i)),
			Kind:      m.Kind,
			Payload:   m.Payload,
			CreatedAt: time.Now().UTC(),
		}
		out = append(out, row)
		c.msgs = append(c.msgs, row)
	}
	f.conversations[conversationID] = c
	return out, nil
}

func (f *fakeAssistantStore) ListMessages(ctx context.Context, userID, conversationID string,
	limit int, cursor AssistantListCursor) ([]AssistantMessage, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, "", fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	return c.msgs, f.nextCursor, nil
}

func (f *fakeAssistantStore) RecentMessages(ctx context.Context, userID, conversationID string,
	limit int) ([]AssistantMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	return c.msgs, nil
}

func (f *fakeAssistantStore) ListChanges(ctx context.Context, userID, conversationID, state string) ([]AssistantChange, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	var out []AssistantChange
	for _, ch := range c.changes {
		switch state {
		case "", "all":
			out = append(out, ch)
		case "open":
			if ch.UndoneAt == nil {
				out = append(out, ch)
			}
		case "undone":
			if ch.UndoneAt != nil {
				out = append(out, ch)
			}
		}
	}
	return out, nil
}

// fakeAssistantStore.UndoChange reports the stable sentinels by change id
// suffix: -ok → undone, -conflict → not undoable (with detail), -done →
// already undone, anything else → not found.
func (f *fakeAssistantStore) UndoChange(ctx context.Context, c as.Caller, changeID string) (AssistantChange, error) {
	var ch AssistantChange
	switch {
	case strings.HasSuffix(changeID, "-ok"):
		now := time.Now().UTC()
		ch = AssistantChange{ID: changeID, Kind: "draft_edit", Undoable: true}
		ch.UndoneAt = &now
		return ch, nil
	case strings.HasSuffix(changeID, "-conflict"):
		return ch, &AssistantChangeNotUndoable{Detail: "the inserted node gained dependents"}
	case strings.HasSuffix(changeID, "-done"):
		return ch, fmt.Errorf("x: %w", ErrAssistantChangeAlreadyUndone)
	default:
		return ch, fmt.Errorf("x: %w", ErrAssistantChangeNotFound)
	}
}

func (f *fakeAssistantStore) UndoAll(ctx context.Context, c as.Caller, conversationID string) ([]ChangeUndoResult, error) {
	c2, ok := f.conversations[conversationID]
	if !ok || c2.user != c.UserID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	return []ChangeUndoResult{
		{ChangeID: "ch-1", Status: "undone"},
		{ChangeID: "ch-2", Status: "not_undoable"},
		{ChangeID: "ch-3", Status: "failed", Error: "the draft no longer exists"},
	}, nil
}

// fakeAssistantRunner scripts the turn's answer (or failure) and records
// what the route handed it.
type fakeAssistantRunner struct {
	answer  *as.Answer
	failure *as.Failure
	gotText string
	gotCtx  as.TurnContext
}

func (r *fakeAssistantRunner) RunTurn(ctx context.Context, req as.TurnRequest) (*as.Answer, *as.Failure) {
	r.gotText = req.Text
	r.gotCtx = req.Context
	if r.failure != nil {
		return nil, r.failure
	}
	return r.answer, nil
}

func assistantStrPtr(s string) *string { return &s }

func newAssistantConvTestServer(t *testing.T,
	store AssistantConversationStore, runner as.TurnRunner, auth Authenticator) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, auth)
	RegisterAssistantConversations(s, AssistantConversationDeps{Store: store, Runner: runner})
	return s
}

var assistantCSRF = map[string]string{HeaderCSRFToken: "csrf-token-value"}

// asstPost is the authenticated CSRF-carrying POST the mutation tests need.
func convPost(t *testing.T, srv *Server, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	var err error
	if body == "" {
		req, err = http.NewRequest(http.MethodPost, target, nil)
	} else {
		req, err = http.NewRequest(http.MethodPost, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func convGet(t *testing.T, srv *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := do(t, srv, request(http.MethodGet, target, nil))
	return rec
}

func TestAssistantConversationsCreate(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))

	rec := convPost(t, srv, "http://localhost:8080/api/v1/assistant/conversations", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["title"] != nil || body["last_message_at"] != nil {
		t.Fatalf("fresh conversation = %v, want null title and last_message_at", body)
	}
	if id, _ := body["id"].(string); id == "" {
		t.Fatalf("no id in the 201 body: %v", body)
	}

	// A second user's conversation list is empty: per-principal scoping.
	stranger := *testPrincipal()
	stranger.UserID = "u-2"
	rec2 := convGet(t, newAssistantConvTestServer(t, store, nil, principalAuth(&stranger, nil)),
		"http://localhost:8080/api/v1/assistant/conversations")
	if rec2.Code != http.StatusOK {
		t.Fatalf("stranger list status = %d", rec2.Code)
	}
	list := decodeBody(t, rec2)
	convs, _ := list["conversations"].([]any)
	if len(convs) != 0 {
		t.Fatalf("stranger listed %d conversations, want 0", len(convs))
	}
	if list["next_cursor"] != nil {
		t.Fatalf("next_cursor = %v, want null", list["next_cursor"])
	}
}

func TestAssistantConversationsListCursorAndLimit(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))

	bad := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations?cursor=zz")
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid cursor status = %d, want 400", bad.Code)
	}
	badLimit := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations?limit=999")
	if badLimit.Code != http.StatusBadRequest {
		t.Fatalf("limit=999 status = %d, want 400", badLimit.Code)
	}
}

func TestAssistantMessagesPostRunsOneTurnAndStores(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "old title")
	runner := &fakeAssistantRunner{answer: &as.Answer{
		AnswerMarkdown: "I added the reviewer.",
		Links:          []as.Link{}, ToolCalls: []as.ToolCall{},
		TurnID: "turn-1",
	}}
	srv := newAssistantConvTestServer(t, store, runner, principalAuth(testPrincipal(), nil))

	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages",
		`{"text":"add a reviewer","context":{"route":"/projects/p-1/pipelines","project_id":"p-1"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	msgs := body["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want the user row and the answer row", len(msgs))
	}
	if msgs[0].(map[string]any)["kind"] != "user" || msgs[1].(map[string]any)["kind"] != "assistant" {
		t.Fatalf("row order = %s, %s, want user first",
			msgs[0].(map[string]any)["kind"], msgs[1].(map[string]any)["kind"])
	}
	userPayload := msgs[0].(map[string]any)["payload"].(map[string]any)
	if userPayload["text"] != "add a reviewer" {
		t.Fatalf("user payload text = %v", userPayload["text"])
	}
	assistantPayload := msgs[1].(map[string]any)["payload"].(map[string]any)
	if assistantPayload["answer_markdown"] != "I added the reviewer." ||
		assistantPayload["turn_id"] != "turn-1" {
		t.Fatalf("assistant payload = %v", assistantPayload)
	}
	if runner.gotText != "add a reviewer" || runner.gotCtx.Route != "/projects/p-1/pipelines" {
		t.Fatalf("runner got text %q ctx %+v", runner.gotText, runner.gotCtx)
	}
	if store.addTurnCalls != 1 {
		t.Fatalf("store AddTurnMessages calls = %d, want 1", store.addTurnCalls)
	}
}

func TestAssistantMessagesPostRefusals(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	auth := principalAuth(testPrincipal(), nil)
	srv := newAssistantConvTestServer(t, store, nil, auth)
	base := "http://localhost:8080/api/v1/assistant/conversations/conv-1/messages"

	// Empty text is a 400 before the store or the runner are touched.
	if rec := convPost(t, srv, base, `{"text":"  "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty text status = %d, want 400", rec.Code)
	}
	// Oversized text is a 400.
	big := `{"text":"` + strings.Repeat("a", 2001) + `"}`
	if rec := convPost(t, srv, base, big); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized text status = %d, want 400", rec.Code)
	}
	// confirm/dismiss is the part-2 approval flow: an honest 400.
	if rec := convPost(t, srv, base, `{"confirm":"msg-1"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("confirm status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}
	// Unknown conversation: the not-found sentinel, never 403.
	rec404 := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-404/messages", `{"text":"hi"}`)
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("unknown conversation status = %d, want 404", rec404.Code)
	}
	if store.addTurnCalls != 0 {
		t.Fatalf("a refused turn stored rows: %d calls", store.addTurnCalls)
	}
}

func TestAssistantMessagesPostNoRunnerIs503(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))
	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages", `{"text":"hi"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body %s)", rec.Code, rec.Body)
	}
	var p struct {
		Degraded string `json:"degraded"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || p.Degraded != "assistant_not_configured" {
		t.Fatalf("problem = %s, want degraded assistant_not_configured", rec.Body)
	}
	if store.addTurnCalls != 0 {
		t.Fatalf("503 stored rows")
	}
}

func TestAssistantMessagesPostFailedTurnStoresNothing(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	runner := &fakeAssistantRunner{failure: &as.Failure{
		Code: "secret_in_request", Detail: "secret-shaped material", Status: 400,
	}}
	srv := newAssistantConvTestServer(t, store, runner, principalAuth(testPrincipal(), nil))
	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages", `{"text":"the key is here"}`)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}
	if store.addTurnCalls != 0 {
		t.Fatalf("a failed turn stored rows: %d calls, want 0", store.addTurnCalls)
	}
}

func TestAssistantMessagesList(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	seeded := store.conversations["conv-1"]
	seeded.msgs = []AssistantMessage{
		{ID: "m-1", Kind: "user", Payload: json.RawMessage(`{"kind":"user","text":"hi"}`), CreatedAt: time.Now().UTC()},
	}
	store.conversations["conv-1"] = seeded
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))

	rec := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations/conv-1/messages")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	msgs := body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["kind"] != "user" {
		t.Fatalf("messages = %v", msgs)
	}

	// An invalid messages cursor (the NULL-zone one) is a 400.
	nullZone := EncodeAssistantConversationCursor(nil, "m-1")
	rec2 := convGet(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages?cursor="+nullZone)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("NULL-zone cursor status = %d, want 400", rec2.Code)
	}
}

func TestAssistantChangesListAndUndo(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	seeded := store.conversations["conv-1"]
	seeded.changes = []AssistantChange{
		{ID: "ch-ok", Kind: "draft_edit", TargetRef: "draft:d-1",
			Summary: "Inserted node", Undoable: true},
		{ID: "ch-2", Kind: "run_retry", TargetRef: "run:r-1",
			Summary: "Retried node", Undoable: false},
	}
	store.conversations["conv-1"] = seeded
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))

	rec := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations/conv-1/changes")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeBody(t, rec)
	changes := body["changes"].([]any)
	if len(changes) != 2 {
		t.Fatalf("changes = %d, want 2", len(changes))
	}
	for _, ch := range changes {
		m := ch.(map[string]any)
		if _, hasPayload := m["undo_payload"]; hasPayload {
			t.Fatalf("the read route returned undo_payload: %v", m)
		}
		if _, hasUndoable := m["undoable"]; !hasUndoable {
			t.Fatalf("change missing undoable: %v", m)
		}
	}

	// An invalid state is a 400.
	if bad := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations/conv-1/changes?state=maybe"); bad.Code != http.StatusBadRequest {
		t.Fatalf("bad state status = %d, want 400", bad.Code)
	}

	// Undo: 200 with the updated change.
	recUndo := convPost(t, srv, "http://localhost:8080/api/v1/assistant/changes/ch-ok/undo", "")
	if recUndo.Code != http.StatusOK {
		t.Fatalf("undo status = %d, want 200 (body %s)", recUndo.Code, recUndo.Body)
	}
	undone := decodeBody(t, recUndo)
	if undone["id"] != "ch-ok" || undone["undone_at"] == nil {
		t.Fatalf("undo body = %v, want the change with undone_at", undone)
	}
	// 409 change_not_undoable, with the store's detail.
	rec409 := convPost(t, srv, "http://localhost:8080/api/v1/assistant/changes/ch-conflict/undo", "")
	if rec409.Code != http.StatusConflict {
		t.Fatalf("conflict undo status = %d, want 409 (body %s)", rec409.Code, rec409.Body)
	}
	var conflict struct {
		Code   string `json:"code"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rec409.Body.Bytes(), &conflict); err != nil ||
		conflict.Code != "change_not_undoable" ||
		!strings.Contains(conflict.Detail, "dependents") {
		t.Fatalf("conflict problem = %s", rec409.Body)
	}
	// 404: not the caller's change.
	rec404 := convPost(t, srv, "http://localhost:8080/api/v1/assistant/changes/ch-unknown/undo", "")
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("unknown change status = %d, want 404", rec404.Code)
	}
}

func TestAssistantChangesUndoAll(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))

	rec := convPost(t, srv, "http://localhost:8080/api/v1/assistant/conversations/conv-1/undo-all", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("undo-all status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	results := body["results"].([]any)
	if len(results) != 3 {
		t.Fatalf("results = %d, want 3 independent outcomes", len(results))
	}
	var statuses []string
	for _, r := range results {
		statuses = append(statuses, r.(map[string]any)["status"].(string))
	}
	if statuses[0] != "undone" || statuses[1] != "not_undoable" || statuses[2] != "failed" {
		t.Fatalf("statuses = %v", statuses)
	}
	if failed := results[2].(map[string]any)["error"]; failed == nil {
		t.Fatalf("failed result has no error detail")
	}

	rec404 := convPost(t, srv, "http://localhost:8080/api/v1/assistant/conversations/conv-404/undo-all", "")
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("unknown conversation undo-all status = %d, want 404", rec404.Code)
	}
}

func TestAssistantConversationsAuthAndCSRF(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	// Unauthenticated: 401.
	srv := newAssistantConvTestServer(t, store, nil, principalAuth(nil, ErrUnauthenticated))
	if rec := convGet(t, srv, "http://localhost:8080/api/v1/assistant/conversations"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", rec.Code)
	}
	// Authenticated but no CSRF token on a mutation: 403 before the handler.
	srv2 := newAssistantConvTestServer(t, store, nil, principalAuth(testPrincipal(), nil))
	req, err := http.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/assistant/conversations", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	rec2 := httptest.NewRecorder()
	srv2.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want 403", rec2.Code)
	}
}
