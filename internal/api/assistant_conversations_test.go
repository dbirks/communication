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
	"errors"
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
	row       AssistantConversation
	user      string
	msgs      []AssistantMessage
	changes   []AssistantChange
	approvals map[string]*AssistantMessage
	nextID    int
}

func newFakeAssistantStore() *fakeAssistantStore {
	return &fakeAssistantStore{conversations: map[string]fakeAssistantConv{}}
}

// seedApproval seeds one pending approval_request row GetMessage can find
// (the confirm/dismiss tests).
func (f *fakeAssistantStore) seedApproval(userID, convID, msgID, action string, args map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.conversations[convID]
	payload, _ := json.Marshal(map[string]any{
		"kind": "approval_request", "turn_id": "turn-1", "action": action,
		"args": args, "summary": "summary of " + action, "risk": "risk line",
		"state": "pending",
	})
	row := &AssistantMessage{ID: msgID, Kind: "approval_request", Payload: payload,
		CreatedAt: time.Now().UTC()}
	c.msgs = append(c.msgs, *row)
	c.approvals[msgID] = row
	f.conversations[convID] = c
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
		user:      userID,
		approvals: map[string]*AssistantMessage{},
	}
}

func (f *fakeAssistantStore) CreateConversation(ctx context.Context, userID string) (AssistantConversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := "conv-" + string(rune('A'+len(f.conversations)))
	f.conversations[id] = fakeAssistantConv{
		row:       AssistantConversation{ID: id, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()},
		user:      userID,
		approvals: map[string]*AssistantMessage{},
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

// GetMessage is the confirm/dismiss read: the row must be in the
// caller's conversation.
func (f *fakeAssistantStore) GetMessage(ctx context.Context,
	userID, conversationID, messageID string) (AssistantMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return AssistantMessage{}, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	// Approval rows update in place (the state moves); read the live row
	// before the transcript copies.
	if m, ok := c.approvals[messageID]; ok {
		return *m, nil
	}
	for _, m := range c.msgs {
		if m.ID == messageID {
			return m, nil
		}
	}
	return AssistantMessage{}, fmt.Errorf("x: %w", ErrAssistantMessageNotFound)
}

// AppendTurn is the part-2 append: user row first, then assistant, the
// change rows + their `change` messages, the question and the
// approval_request row — the store's decision-3 order.
func (f *fakeAssistantStore) AppendTurn(ctx context.Context,
	userID, conversationID string, in AppendTurnInput) ([]AssistantMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addTurnCalls++
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	next := func() string {
		c.nextID++
		return conversationID + "-n" + string(rune('0'+c.nextID))
	}
	appendMsg := func(kind string, payload []byte) AssistantMessage {
		row := AssistantMessage{ID: next(), Kind: kind, Payload: payload, CreatedAt: time.Now().UTC()}
		c.msgs = append(c.msgs, row)
		return row
	}
	var out []AssistantMessage
	out = append(out, appendMsg(in.User.Kind, in.User.Payload))
	if in.Assistant != nil {
		out = append(out, appendMsg(in.Assistant.Kind, in.Assistant.Payload))
	}
	for i := range in.Changes {
		id := next()
		ch := AssistantChange{
			ID:        id,
			Kind:      in.Changes[i].Kind,
			TargetRef: in.Changes[i].TargetRef,
			Summary:   in.Changes[i].Summary,
			Undoable:  in.Changes[i].UndoPayload != nil,
			CreatedAt: time.Now().UTC(),
		}
		c.changes = append(c.changes, ch)
		payload, _ := json.Marshal(map[string]any{
			"kind": "change", "change_id": ch.ID, "change_kind": ch.Kind,
			"target_ref": ch.TargetRef, "summary": ch.Summary, "undoable": ch.Undoable,
		})
		out = append(out, appendMsg("change", payload))
	}
	if in.Question != nil {
		out = append(out, appendMsg(in.Question.Kind, in.Question.Payload))
	}
	if in.Approval != nil {
		row := appendMsg(in.Approval.Kind, in.Approval.Payload)
		if c.approvals == nil {
			c.approvals = map[string]*AssistantMessage{}
		}
		m := row
		c.approvals[row.ID] = &m
		out = append(out, row)
	}
	f.conversations[conversationID] = c
	return out, nil
}

// CompleteApproval resolves one pending approval_request: the state
// moves, the acknowledgement and the change row are appended.
func (f *fakeAssistantStore) CompleteApproval(ctx context.Context,
	userID, conversationID, messageID, state string,
	ack AssistantMessageInput, change *AssistantChangeInput) ([]AssistantMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if state != "confirmed" && state != "dismissed" {
		return nil, fmt.Errorf("x: unknown assistant approval state %s", state)
	}
	c, ok := f.conversations[conversationID]
	if !ok || c.user != userID {
		return nil, fmt.Errorf("x: %w", ErrAssistantConversationNotFound)
	}
	m, ok := c.approvals[messageID]
	if !ok || m.Kind != "approval_request" {
		return nil, fmt.Errorf("x: %w", ErrAssistantApprovalNotPending)
	}
	var doc map[string]any
	if err := json.Unmarshal(m.Payload, &doc); err != nil || doc["state"] != "pending" {
		return nil, fmt.Errorf("x: %w", ErrAssistantApprovalNotPending)
	}
	next := func() string {
		c.nextID++
		return conversationID + "-n" + string(rune('0'+c.nextID))
	}
	appendMsg := func(kind string, payload []byte) AssistantMessage {
		row := AssistantMessage{ID: next(), Kind: kind, Payload: payload, CreatedAt: time.Now().UTC()}
		c.msgs = append(c.msgs, row)
		return row
	}
	doc["state"] = state
	payload, _ := json.Marshal(doc)
	m.Payload = payload
	var out []AssistantMessage
	out = append(out, appendMsg(ack.Kind, ack.Payload))
	if change != nil {
		id := next()
		ch := AssistantChange{
			ID:        id,
			Kind:      change.Kind,
			TargetRef: change.TargetRef,
			Summary:   change.Summary,
			Undoable:  change.UndoPayload != nil,
			CreatedAt: time.Now().UTC(),
		}
		c.changes = append(c.changes, ch)
		cp, _ := json.Marshal(map[string]any{
			"kind": "change", "change_id": ch.ID, "change_kind": ch.Kind,
			"target_ref": ch.TargetRef, "summary": ch.Summary, "undoable": ch.Undoable,
		})
		out = append(out, appendMsg("change", cp))
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
	answer   *as.Answer
	failure  *as.Failure
	gotText  string
	gotCtx   as.TurnContext
	gotTrust as.TrustLevel
}

func (r *fakeAssistantRunner) RunTurn(ctx context.Context, req as.TurnRequest) (*as.TurnResult, *as.Failure) {
	r.gotText = req.Text
	r.gotCtx = req.Context
	r.gotTrust = req.TrustLevel
	if r.failure != nil {
		return nil, r.failure
	}
	if r.answer == nil {
		return nil, nil
	}
	return &as.TurnResult{Answer: r.answer}, nil
}

// fakeApprovalRunner is the part-2 runner: it implements the confirm seam
// (approvalExecutor) the part-1 fake does not, and can answer a turn with
// the tool-loop's extra rows (question / approval_request / changes).
type fakeApprovalRunner struct {
	*fakeAssistantRunner
	question   *as.TurnQuestion
	approval   *as.TurnApproval
	changes    []as.ChangeRecord
	execTool   string
	execArgs   map[string]string
	execAck    string
	execChange *as.ChangeRecord
	execErr    error
	execCalls  int
}

func (r *fakeApprovalRunner) RunTurn(ctx context.Context, req as.TurnRequest) (*as.TurnResult, *as.Failure) {
	res, bad := r.fakeAssistantRunner.RunTurn(ctx, req)
	if bad != nil || res == nil {
		return res, bad
	}
	res.Question = r.question
	res.Approval = r.approval
	res.Changes = r.changes
	return res, nil
}

// ExecuteAction is the confirm path: it re-runs the recorded action once
// as the caller.
func (r *fakeApprovalRunner) ExecuteAction(ctx context.Context, c as.Caller,
	tool string, args map[string]string) (string, *as.ChangeRecord, error) {
	r.execCalls++
	r.execTool = tool
	r.execArgs = args
	return r.execAck, r.execChange, r.execErr
}

func assistantStrPtr(s string) *string { return &s }

func newAssistantConvTestServer(t *testing.T,
	store AssistantConversationStore, runner as.TurnRunner, auth Authenticator) *Server {
	t.Helper()
	return newAssistantConvTestServerTrusted(t, store, runner, auth, nil)
}

// newAssistantConvTestServerTrusted wires the trust-level read (ADR-0046/
// C2 seam) so the confirm/turn tests can assert it reaches the runner.
func newAssistantConvTestServerTrusted(t *testing.T,
	store AssistantConversationStore, runner as.TurnRunner, auth Authenticator,
	trust func(ctx context.Context, c as.Caller) (string, bool)) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, auth)
	RegisterAssistantConversations(s, AssistantConversationDeps{
		Store: store, Runner: runner, TrustLevel: trust,
	})
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
	// confirm with no runner wired is the honest 503: the approval flow
	// ships with the part-2 runner.
	if rec := convPost(t, srv, base, `{"confirm":"msg-1"}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("confirm status = %d, want 503 (body %s)", rec.Code, rec.Body)
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

// TestAssistantMessagesTurnTrustAndRows (ADR-0050 decision 2/4): the
// caller's trust level reaches the runner normalized, and the turn's
// extra rows (change messages, the approval_request row) are appended in
// the store's order after the user and assistant rows.
func TestAssistantMessagesTurnTrustAndRows(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	runner := &fakeApprovalRunner{
		fakeAssistantRunner: &fakeAssistantRunner{answer: &as.Answer{
			AnswerMarkdown: "I can start that run; approve it.", Links: []as.Link{},
			ToolCalls: []as.ToolCall{}, TurnID: "turn-9",
		}},
		approval: &as.TurnApproval{
			Tool: "run.start", Args: map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"},
			Summary: "Start a run p-1 · pl-1", Risk: "starts a new pipeline run",
		},
		changes: []as.ChangeRecord{{
			Kind: "navigate", TargetRef: "/runs", Summary: "Navigated to /runs",
		}},
	}
	srv := newAssistantConvTestServerTrusted(t, store, runner, principalAuth(testPrincipal(), nil),
		func(ctx context.Context, c as.Caller) (string, bool) { return "ask_all", true })
	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages",
		`{"text":"start a run"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	msgs := body["messages"].([]any)
	// user, assistant, the navigate change, the approval_request.
	if len(msgs) != 4 || msgs[0].(map[string]any)["kind"] != "user" ||
		msgs[1].(map[string]any)["kind"] != "assistant" ||
		msgs[2].(map[string]any)["kind"] != "change" ||
		msgs[3].(map[string]any)["kind"] != "approval_request" {
		t.Fatalf("rows = %v, want user/assistant/change/approval_request", msgs)
	}
	changePayload := msgs[2].(map[string]any)["payload"].(map[string]any)
	if changePayload["change_kind"] != "navigate" || changePayload["undoable"] != false {
		t.Fatalf("change payload = %v", changePayload)
	}
	approvalPayload := msgs[3].(map[string]any)["payload"].(map[string]any)
	if approvalPayload["state"] != "pending" || approvalPayload["action"] != "run.start" {
		t.Fatalf("approval payload = %v", approvalPayload)
	}
	if runner.gotTrust != as.TrustAskAll {
		t.Fatalf("runner trust = %q, want the normalized ask_all", runner.gotTrust)
	}
}

// TestAssistantMessagesConfirmAndDismiss (ADR-0050 decision 2): confirm
// re-runs the action exactly once as the caller and appends the
// acknowledgement plus the change row; dismiss only moves the state; a
// second decision on the resolved row is 409; the exclusive pair and the
// action denial are refused without touching the request.
func TestAssistantMessagesConfirmAndDismiss(t *testing.T) {
	t.Parallel()
	store := newFakeAssistantStore()
	store.seedConversation("u-1", "conv-1", "t")
	base := "http://localhost:8080/api/v1/assistant/conversations/conv-1/messages"
	auth := principalAuth(testPrincipal(), nil)

	// The part-1 runner (no confirm seam) keeps the honest 400.
	part1 := &fakeAssistantRunner{}
	if rec := convPost(t, newAssistantConvTestServer(t, store, part1, auth), base,
		`{"confirm":"appr-1"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("part-1 confirm status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}

	runner := &fakeApprovalRunner{
		fakeAssistantRunner: &fakeAssistantRunner{},
		execAck:             "Done — the run started.",
		execChange: &as.ChangeRecord{
			Kind: "run_start", TargetRef: "run:r-1", Summary: "Started run r-1",
		},
	}
	srv := newAssistantConvTestServer(t, store, runner, auth)
	store.seedApproval("u-1", "conv-1", "appr-1", "run.start",
		map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"})

	// confirm + dismiss together is a 400 before anything is read.
	if rec := convPost(t, srv, base, `{"confirm":"appr-1","dismiss":"appr-1"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("exclusive pair status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}
	// text alongside a decision is a 400.
	if rec := convPost(t, srv, base, `{"confirm":"appr-1","text":"yes please"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("text+confirm status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}
	// an unknown id is the same 409 as not-pending (no id enumeration).
	if rec := convPost(t, srv, base, `{"confirm":"appr-unknown"}`); rec.Code != http.StatusConflict {
		t.Fatalf("unknown id status = %d, want 409 (body %s)", rec.Code, rec.Body)
	}

	// The confirm: the action runs exactly once, the ack and the change
	// row land, and the request is confirmed.
	rec := convPost(t, srv, base, `{"confirm":"appr-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	msgs := body["messages"].([]any)
	if len(msgs) != 2 || msgs[0].(map[string]any)["kind"] != "assistant" ||
		msgs[1].(map[string]any)["kind"] != "change" {
		t.Fatalf("confirm rows = %v, want the ack then the change", msgs)
	}
	if runner.execCalls != 1 || runner.execTool != "run.start" ||
		runner.execArgs["pipeline_id"] != "pl-1" {
		t.Fatalf("exec calls = %d tool %q args %v, want one run.start",
			runner.execCalls, runner.execTool, runner.execArgs)
	}
	// The row itself moved to confirmed.
	again := convPost(t, srv, base, `{"confirm":"appr-1"}`)
	if again.Code != http.StatusConflict {
		t.Fatalf("second confirm status = %d, want 409 (body %s)", again.Code, again.Body)
	}
	if runner.execCalls != 1 {
		t.Fatalf("a confirmed action re-ran: %d calls", runner.execCalls)
	}

	// The dismiss: no execution, the state moves, the ack lands.
	store.seedApproval("u-1", "conv-1", "appr-2", "run.retry",
		map[string]string{"project_id": "p-1", "run_id": "r-1", "node_id": "test"})
	rec = convPost(t, srv, base, `{"dismiss":"appr-2"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("dismiss status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body = decodeBody(t, rec)
	msgs = body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["kind"] != "assistant" {
		t.Fatalf("dismiss rows = %v, want the ack alone", msgs)
	}
	if runner.execCalls != 1 {
		t.Fatalf("dismiss executed an action: %d calls", runner.execCalls)
	}
	m2, err := store.GetMessage(context.Background(), "u-1", "conv-1", "appr-2")
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	var doc map[string]any
	_ = json.Unmarshal(m2.Payload, &doc)
	if doc["state"] != "dismissed" {
		t.Fatalf("dismissed state = %v, want dismissed", doc["state"])
	}

	// A denied action: the 409 names the stable code, the request stays
	// pending, and the ack was not appended.
	denied := &fakeApprovalRunner{
		fakeAssistantRunner: &fakeAssistantRunner{},
		execErr:             errors.New("x: " + as.ErrActionDenied.Error()),
	}
	store.seedApproval("u-1", "conv-1", "appr-3", "pipeline.publish",
		map[string]string{"project_id": "p-1", "draft_id": "d-1"})
	srv2 := newAssistantConvTestServer(t, store, denied, auth)
	rec = convPost(t, srv2, base, `{"confirm":"appr-3"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("denied confirm status = %d, want 409 (body %s)", rec.Code, rec.Body)
	}
	if rec.Body.String() == "" || !strings.Contains(rec.Body.String(), "action_denied") {
		t.Fatalf("denied problem lacks the stable code: %s", rec.Body)
	}
	m3, err := store.GetMessage(context.Background(), "u-1", "conv-1", "appr-3")
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	var doc3 map[string]any
	_ = json.Unmarshal(m3.Payload, &doc3)
	if doc3["state"] != "pending" {
		t.Fatalf("denied confirm moved the state to %v, want pending", doc3["state"])
	}
}
