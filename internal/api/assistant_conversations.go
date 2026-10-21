package api

// The assistant v2 conversation routes (ADR-0050 part 1,
// docs/adr/ADR-0050-assistant-v2.md): the per-user persisted transcript
// and the change log. This unit covers conversations, messages (one
// server-side turn per post, through the ADR-0034 broker with the
// transcript folded in) and the change routes (list / undo / undo-all).
// The multi-turn tool loop, trust gating, questions and the draft-edit
// inverse op land in part 2 behind the seams this file consumes
// (assistant.TurnRunner, assistant.Undoer).
//
// Scoping and honesty rules (ADR-0050 decisions 1–2, ADR-0014 §3):
// every route is keyed on the caller's own user id — a conversation or
// change that exists but belongs to another user answers the api
// not-found sentinel (404, never 403). `undo_payload` is never returned
// on any read route; only its presence, as `undoable`. A turn that fails
// (secret in the message, model unreachable, caps) stores NOTHING: the
// problem is written and the transcript stays exactly as it was, the
// ADR-0034 refusal behaviour carried over.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// The stable sentinels the store reports and the routes map.
// ErrAssistantConversationNotFound is "you may not know this conversation
// exists" (another user's row), the same family as ErrApprovalNotFound.
var (
	ErrAssistantConversationNotFound = errors.New("api: assistant conversation not found")
	ErrAssistantChangeNotFound       = errors.New("api: assistant change not found")
	ErrAssistantChangeNotUndoable    = errors.New("api: assistant change is not undoable")
	ErrAssistantChangeAlreadyUndone  = errors.New("api: assistant change is already undone")
	// ErrAssistantMessageNotFound is one transcript row the caller does not
	// own; the confirm/dismiss route answers it with the same stable 409
	// as a not-pending request so a probe cannot enumerate request ids.
	ErrAssistantMessageNotFound = errors.New("api: assistant message not found")
	// ErrAssistantApprovalNotPending is confirm/dismiss on an unknown id or
	// a row that is not state=pending (decision 2: 409
	// approval_request_not_pending).
	ErrAssistantApprovalNotPending = errors.New("api: assistant approval request is not pending")
)

// AssistantChangeNotUndoable carries the detail the 409 names (ADR-0050
// decision 5: the draft no longer exists, the caller lost draft-write
// right, the inverse op does not structurally apply — in the structural
// case the detail says so and the draft is left untouched).
type AssistantChangeNotUndoable struct{ Detail string }

func (e *AssistantChangeNotUndoable) Error() string {
	if e == nil || e.Detail == "" {
		return ErrAssistantChangeNotUndoable.Error()
	}
	return ErrAssistantChangeNotUndoable.Error() + ": " + e.Detail
}

func (e *AssistantChangeNotUndoable) Unwrap() error {
	return ErrAssistantChangeNotUndoable
}

// The contract shapes (api/openapi.yaml's Assistant* schemas; the UI
// client maps to camelCase).
type (
	// AssistantConversation is the route's conversation row. Title is
	// null until the first user message.
	AssistantConversation struct {
		ID            string     `json:"id"`
		Title         *string    `json:"title"`
		CreatedAt     time.Time  `json:"created_at"`
		UpdatedAt     time.Time  `json:"updated_at"`
		LastMessageAt *time.Time `json:"last_message_at"`
	}

	// AssistantMessage is one transcript row; Payload is the per-kind
	// document (ADR-0050 decision 3).
	AssistantMessage struct {
		ID        string          `json:"id"`
		Kind      string          `json:"kind"`
		Payload   json.RawMessage `json:"payload"`
		CreatedAt time.Time       `json:"created_at"`
	}

	// AssistantMessageInput is one row the route appends; the store
	// assigns id and created_at.
	AssistantMessageInput struct {
		Kind    string
		Payload json.RawMessage
	}

	// AssistantChange is one change-log row. Undoable is the presence of
	// the undo_payload; the payload itself is never returned.
	AssistantChange struct {
		ID        string     `json:"id"`
		Kind      string     `json:"kind"`
		TargetRef string     `json:"target_ref"`
		Summary   string     `json:"summary"`
		Undoable  bool       `json:"undoable"`
		UndoneAt  *time.Time `json:"undone_at"`
		CreatedAt time.Time  `json:"created_at"`
	}

	// AssistantChangeInput is one change-log row the turn's mutations
	// record (ADR-0050 decision 5); UndoPayload is nil for the not-
	// undoable kinds and the server's closed inverse for draft edits.
	AssistantChangeInput struct {
		Kind        string
		ProjectID   *string
		TargetRef   string
		Summary     string
		UndoPayload []byte
	}

	// AppendTurnInput is one turn's rows in the store's append order
	// (decision 3): the user row, the assistant row, one `change` message
	// per change, the question row and the approval_request row.
	AppendTurnInput struct {
		User      *AssistantMessageInput
		Assistant *AssistantMessageInput
		Changes   []AssistantChangeInput
		Question  *AssistantMessageInput
		Approval  *AssistantMessageInput
	}

	// ChangeUndoResult is one row of the undo-all results array: one
	// independent outcome per open change.
	ChangeUndoResult struct {
		ChangeID string `json:"change_id"`
		// Status is undone | already_undone | not_undoable | failed.
		Status string `json:"status"`
		Error  string `json:"error,omitempty"`
	}
)

// AssistantListCursor is one page position, decoded by the route before
// the store is asked. After is the list's time key: the conversations
// list's last_message_at (nil = the never-messaged zone, where the id
// alone orders) or the messages list's created_at.
type AssistantListCursor struct {
	Has     bool
	After   *time.Time
	AfterID string
}

// EncodeAssistantConversationCursor renders the conversations list's
// cursor for the `next_cursor` field.
func EncodeAssistantConversationCursor(lastMessageAt *time.Time, id string) string {
	var l string
	if lastMessageAt != nil {
		l = lastMessageAt.UTC().Format(time.RFC3339Nano)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(l + "\x1f" + id))
}

// EncodeAssistantMessageCursor renders the messages list's cursor.
func EncodeAssistantMessageCursor(createdAt time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(createdAt.UTC().Format(time.RFC3339Nano) + "\x1f" + id))
}

// ParseAssistantListCursor reads a client-supplied cursor. Anything that
// is not the exact encoded shape is a refusal, so a cursor cannot probe
// row ids it was never handed (the cross-project cursor's rule).
func ParseAssistantListCursor(s string) (AssistantListCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(raw) < 3 {
		return AssistantListCursor{}, errors.New("invalid assistant cursor")
	}
	parts := strings.SplitN(string(raw), "\x1f", 2)
	if len(parts) != 2 || parts[1] == "" {
		return AssistantListCursor{}, errors.New("invalid assistant cursor")
	}
	var after *time.Time
	if parts[0] != "" {
		t, err := time.Parse(time.RFC3339Nano, parts[0])
		if err != nil {
			return AssistantListCursor{}, errors.New("invalid assistant cursor")
		}
		after = &t
	}
	return AssistantListCursor{Has: true, After: after, AfterID: parts[1]}, nil
}

// The list paging bounds, shared by the route (input validation) and the
// store (output clamping): 50 default, 200 max (the cross-project lists'
// convention).
const (
	assistantListDefaultLimit = 50
	assistantListMaxLimit     = 200
)

// --- the routes ---------------------------------------------------------

// AssistantConversationStore is the datastore the routes need. Every
// method is keyed on the caller's own user id, so nothing here can read
// or touch another user's transcript; the store reports the sentinels
// above and the routes map them onto 404 / 409.
type AssistantConversationStore interface {
	CreateConversation(ctx context.Context, userID string) (AssistantConversation, error)
	ListConversations(ctx context.Context, userID string,
		limit int, cursor AssistantListCursor) ([]AssistantConversation, string, error)
	GetConversation(ctx context.Context, userID, id string) (AssistantConversation, error)
	GetMessage(ctx context.Context, userID, conversationID, messageID string) (AssistantMessage, error)
	AddTurnMessages(ctx context.Context, userID, conversationID string,
		msgs []AssistantMessageInput) ([]AssistantMessage, error)
	// AppendTurn is the part-2 append: one turn's rows (user, assistant,
	// change messages, question, approval_request) plus the change rows in
	// ONE transaction, the question's answered_by stamped by the user row.
	AppendTurn(ctx context.Context, userID, conversationID string,
		in AppendTurnInput) ([]AssistantMessage, error)
	// CompleteApproval resolves one pending approval_request (confirm / Not
	// now): the state update, the acknowledgement message and the change
	// row the confirmed action logged in ONE transaction.
	CompleteApproval(ctx context.Context, userID, conversationID, messageID, state string,
		ack AssistantMessageInput, change *AssistantChangeInput) ([]AssistantMessage, error)
	ListMessages(ctx context.Context, userID, conversationID string,
		limit int, cursor AssistantListCursor) ([]AssistantMessage, string, error)
	RecentMessages(ctx context.Context, userID, conversationID string, limit int) ([]AssistantMessage, error)
	ListChanges(ctx context.Context, userID, conversationID, state string) ([]AssistantChange, error)
	UndoChange(ctx context.Context, c assistant.Caller, changeID string) (AssistantChange, error)
	UndoAll(ctx context.Context, c assistant.Caller, conversationID string) ([]ChangeUndoResult, error)
}

// AssistantConversationDeps carries the store, the turn runner and the
// trust-level read. A nil Runner is the deployment without an assistant
// endpoint: the messages route answers 503 assistant_not_configured, the
// read routes stay live (an existing transcript is still readable), and no
// turn is ever faked. TrustLevel (nil here) is the per-user
// assistant.trust_level read from user_preferences (ADR-0046/C2) at the
// start of each turn; a nil reader keeps the ADR's default (ask_risky).
type AssistantConversationDeps struct {
	Store  AssistantConversationStore
	Runner assistant.TurnRunner
	// TrustLevel reads the caller's assistant.trust_level (the stored
	// string; the runner normalizes it). The bool is false when the
	// preference has never been saved.
	TrustLevel func(ctx context.Context, c assistant.Caller) (string, bool)
}

// RegisterAssistantConversations mounts the ADR-0050 conversation and
// change routes. Session-authed; the mutations (POST) carry the same
// CSRF contract as every other mutation (ADR-0014).
func RegisterAssistantConversations(s *Server, deps AssistantConversationDeps) {
	h := &assistantConversationHandlers{store: deps.Store, runner: deps.Runner, trust: deps.TrustLevel, srv: s}
	s.HandleAuthed("POST /api/v1/assistant/conversations", http.HandlerFunc(h.createConversation))
	s.HandleAuthed("GET /api/v1/assistant/conversations", http.HandlerFunc(h.listConversations))
	s.HandleAuthed("POST /api/v1/assistant/conversations/{conversationId}/messages",
		http.HandlerFunc(h.postMessage))
	s.HandleAuthed("GET /api/v1/assistant/conversations/{conversationId}/messages",
		http.HandlerFunc(h.listMessages))
	s.HandleAuthed("GET /api/v1/assistant/conversations/{conversationId}/changes",
		http.HandlerFunc(h.listChanges))
	s.HandleAuthed("POST /api/v1/assistant/conversations/{conversationId}/undo-all",
		http.HandlerFunc(h.undoAll))
	s.HandleAuthed("POST /api/v1/assistant/changes/{changeId}/undo",
		http.HandlerFunc(h.undoChange))
}

type assistantConversationHandlers struct {
	store  AssistantConversationStore
	runner assistant.TurnRunner
	trust  func(ctx context.Context, c assistant.Caller) (string, bool)
	srv    *Server
}

func (h *assistantConversationHandlers) principal(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.srv.logger.Error("assistant.conversations: no principal in context")
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"No principal in context.")
		return nil, false
	}
	return p, true
}

func (h *assistantConversationHandlers) caller(p *Principal) assistant.Caller {
	return assistant.Caller{
		UserID:         p.UserID,
		OrganizationID: p.OrganizationID,
		IsOrgAdmin:     p.IsOrgAdmin,
	}
}

// assistantCursor parses the `cursor` query value; an invalid one is a
// 400 invalid_cursor before the store is asked (the cross-project rule).
func assistantCursor(w http.ResponseWriter, v string) (AssistantListCursor, bool) {
	if v == "" {
		return AssistantListCursor{}, true
	}
	cursor, err := ParseAssistantListCursor(v)
	if err != nil {
		assistantCodeProblem(w, http.StatusBadRequest, "invalid_cursor",
			"cursor must be a next_cursor value from an earlier response.")
		return AssistantListCursor{}, false
	}
	return cursor, true
}

// assistantLimitParam parses the `limit` query value; out of bounds is a
// 400 invalid_limit (the cross-project list's rule), not a silent clamp.
func assistantLimitParam(w http.ResponseWriter, v string) (int, bool) {
	if v == "" {
		return assistantListDefaultLimit, true
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > assistantListMaxLimit {
		assistantCodeProblem(w, http.StatusBadRequest, "invalid_limit",
			"limit must be an integer between 1 and "+strconv.Itoa(assistantListMaxLimit)+".")
		return 0, false
	}
	return n, true
}

// assistantCodeProblem writes a problem+json answer with the stable
// machine code, so the UI branches on a code rather than a sentence.
func assistantCodeProblem(w http.ResponseWriter, status int, code, detail string) {
	if detail == "" {
		detail = code
	}
	w.Header().Set("Content-Type", ProblemJSON)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Code   string `json:"code"`
		Detail string `json:"detail,omitempty"`
	}{Type: "about:blank", Title: http.StatusText(status), Status: status,
		Code: code, Detail: detail})
}

// --- conversations ------------------------------------------------------

func (h *assistantConversationHandlers) createConversation(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	conv, err := h.store.CreateConversation(r.Context(), p.UserID)
	if err != nil {
		h.srv.logger.Error("assistant.conversations.create", "user", p.UserID, "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not start the conversation.")
		return
	}
	WriteJSON(w, http.StatusCreated, conv)
}

func (h *assistantConversationHandlers) listConversations(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, ok2 := assistantLimitParam(w, q.Get("limit"))
	if !ok2 {
		return
	}
	cursor, ok3 := assistantCursor(w, q.Get("cursor"))
	if !ok3 {
		return
	}
	convs, next, err := h.store.ListConversations(r.Context(), p.UserID, limit, cursor)
	if err != nil {
		h.srv.logger.Error("assistant.conversations.list", "user", p.UserID, "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not list your conversations.")
		return
	}
	var nextPtr *string
	if next != "" {
		nextPtr = &next
	}
	WriteJSON(w, http.StatusOK, struct {
		Conversations []AssistantConversation `json:"conversations"`
		NextCursor    *string                 `json:"next_cursor"`
	}{Conversations: convs, NextCursor: nextPtr})
}

// --- messages -----------------------------------------------------------

// AssistantMessagePost is POST …/messages' body (ADR-0050 decision 2).
// `confirm`/`dismiss` name a pending approval_request; the approval flow
// lands in part 2, so posting one now is an honest 400.
type AssistantMessagePost struct {
	Text    string                  `json:"text"`
	Context AssistantMessageContext `json:"context,omitempty"`
	Confirm *string                 `json:"confirm,omitempty"`
	Dismiss *string                 `json:"dismiss,omitempty"`
}

// AssistantMessageContext is the client's page context; every member is
// untrusted input normalized by assistant.ValidateTurnContext.
type AssistantMessageContext struct {
	Route     string                         `json:"route,omitempty"`
	ProjectID string                         `json:"project_id,omitempty"`
	Entity    *AssistantMessageContextEntity `json:"entity,omitempty"`
}

// AssistantMessageContextEntity is the page's entity reference.
type AssistantMessageContextEntity struct {
	Kind string `json:"kind,omitempty"`
	ID   string `json:"id,omitempty"`
}

// userMessagePayload is the kind-"user" payload (ADR-0050 decision 3):
// the text plus the validated page context (omitted when it is empty).
type userMessagePayload struct {
	Kind    string                 `json:"kind"`
	Text    string                 `json:"text"`
	Context *assistant.TurnContext `json:"context,omitempty"`
}

// assistantMessagePayload is the kind-"assistant" payload: the broker's
// answer as it returned it, in ADR-0050's message vocabulary — links named
// by route (not the one-shot ask's href) and every tool_call carrying its
// short server-supplied summary (part 2 reshapes it with the tool-loop's
// summaries).
type assistantMessagePayload struct {
	Kind           string                  `json:"kind"`
	TurnID         string                  `json:"turn_id"`
	AnswerMarkdown string                  `json:"answer_markdown"`
	Links          []assistant.MessageLink `json:"links"`
	ToolCalls      []assistant.ToolCall    `json:"tool_calls"`
	Degraded       *string                 `json:"degraded"`
}

// postMessage runs ONE server-side turn (ADR-0050 decision 2): the
// caller's message plus the transcript history goes to the runner with
// the caller's trust level (read server-side, decision 4), and the rows
// the turn produced (the user row first, then the turn's output —
// assistant, change rows, question and approval_request rows) are
// appended in ONE store transaction; the response carries exactly those
// rows. A failed turn stores nothing (the ADR-0034 refusal behaviour).
// A `confirm`/`dismiss` post is the approval decision instead of a turn
// (decision 2's confirm mechanics): no model call, the state moves, the
// action (if confirmed) executes once as the caller.
func (h *assistantConversationHandlers) postMessage(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	var body AssistantMessagePost
	if err := DecodeJSON(r, &body); err != nil {
		WriteProblem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	conversationID := r.PathValue("conversationId")
	if _, err := h.store.GetConversation(r.Context(), p.UserID, conversationID); err != nil {
		assistantConversationNotFound(w, err)
		return
	}
	if body.Confirm != nil || body.Dismiss != nil {
		h.postMessageApproval(w, r, p, conversationID, &body)
		return
	}
	text := strings.TrimSpace(body.Text)
	switch {
	case text == "":
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"text is required: 1..2000 characters.")
		return
	case len([]rune(text)) > assistant.MaxMessageRunes:
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"text must be at most "+strconv.Itoa(assistant.MaxMessageRunes)+" characters.")
		return
	}
	if h.runner == nil {
		writeAssistantProblem(w, http.StatusServiceUnavailable, "assistant_not_configured",
			"the assistant is not enabled on this deployment (COMMUNICATION_ASSISTANT_BASE_URL is unset)")
		return
	}
	// The folded history: the newest transcript rows, oldest-first for
	// the runner (which trims to its own 20-message / 12 KB budget).
	recent, err := h.store.RecentMessages(r.Context(), p.UserID, conversationID,
		assistant.MaxHistoryMessages)
	if err != nil {
		h.srv.logger.Error("assistant.messages.history", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not read the conversation history.")
		return
	}
	history := make([]assistant.HistoryMessage, 0, len(recent))
	for i := len(recent) - 1; i >= 0; i-- {
		history = append(history, assistant.HistoryMessage{Kind: recent[i].Kind, Payload: recent[i].Payload})
	}
	// The validated page context (decision 6): allowlisted route, bounded
	// project id, closed entity kind — stored as the user row carries it.
	var entity *assistant.TurnContextEntity
	if body.Context.Entity != nil {
		entity = &assistant.TurnContextEntity{
			Kind: body.Context.Entity.Kind, ID: body.Context.Entity.ID,
		}
	}
	ctx := assistant.ValidateTurnContext(assistant.TurnContext{
		Route:     body.Context.Route,
		ProjectID: body.Context.ProjectID,
		Entity:    entity,
	})
	userPayload, err := json.Marshal(userMessagePayload{
		Kind:    "user",
		Text:    text,
		Context: contextOrNil(ctx),
	})
	if err != nil {
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not prepare the message.")
		return
	}
	result, bad := h.runner.RunTurn(r.Context(), assistant.TurnRequest{
		Caller:     h.caller(p),
		Text:       text,
		Context:    ctx,
		History:    history,
		TrustLevel: h.trustLevel(r.Context(), h.caller(p)),
	})
	if bad != nil {
		// ADR-0034's refusal behaviour: nothing is stored, the problem
		// names the cause in `degraded`.
		writeAssistantProblem(w, bad.Status, bad.Code, bad.Detail)
		return
	}
	in := AppendTurnInput{User: &AssistantMessageInput{Kind: "user", Payload: userPayload}}
	if result.Answer != nil {
		assistantPayload, err := json.Marshal(assistantMessagePayload{
			Kind:           "assistant",
			TurnID:         result.Answer.TurnID,
			AnswerMarkdown: result.Answer.AnswerMarkdown,
			Links:          assistant.MessageLinks(result.Answer.Links),
			ToolCalls:      result.Answer.ToolCalls,
			Degraded:       result.Answer.Degraded,
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
				"Could not prepare the answer.")
			return
		}
		in.Assistant = &AssistantMessageInput{Kind: "assistant", Payload: assistantPayload}
	}
	for _, ch := range result.Changes {
		in.Changes = append(in.Changes, AssistantChangeInput{
			Kind:        ch.Kind,
			ProjectID:   ch.ProjectID,
			TargetRef:   ch.TargetRef,
			Summary:     ch.Summary,
			UndoPayload: ch.UndoPayload,
		})
	}
	if result.Question != nil {
		turnID := ""
		if result.Answer != nil {
			turnID = result.Answer.TurnID
		}
		q, err := json.Marshal(questionMessagePayload{
			Kind:          "question",
			TurnID:        turnID,
			Prompt:        result.Question.Prompt,
			Options:       result.Question.Options,
			AllowFreeText: result.Question.AllowFreeText,
			AnsweredBy:    nil,
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
				"Could not prepare the question.")
			return
		}
		in.Question = &AssistantMessageInput{Kind: "question", Payload: q}
	}
	if result.Approval != nil {
		turnID := ""
		if result.Answer != nil {
			turnID = result.Answer.TurnID
		}
		a, err := json.Marshal(approvalRequestPayload{
			Kind:    "approval_request",
			TurnID:  turnID,
			Action:  result.Approval.Tool,
			Args:    result.Approval.Args,
			Summary: result.Approval.Summary,
			Risk:    result.Approval.Risk,
			State:   "pending",
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
				"Could not prepare the approval request.")
			return
		}
		in.Approval = &AssistantMessageInput{Kind: "approval_request", Payload: a}
	}
	rows, err := h.store.AppendTurn(r.Context(), p.UserID, conversationID, in)
	if err != nil {
		if errors.Is(err, ErrAssistantConversationNotFound) {
			assistantConversationNotFound(w, err)
			return
		}
		h.srv.logger.Error("assistant.messages.store", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not save the turn.")
		return
	}
	WriteJSON(w, http.StatusOK, struct {
		Messages []AssistantMessage `json:"messages"`
	}{Messages: rows})
}

// trustLevel reads the caller's assistant.trust_level (ADR-0046/C2) for
// the tool loop (decision 4). A deployment without the preference read
// wired, or a value never saved, keeps the ADR's default: ask_risky.
func (h *assistantConversationHandlers) trustLevel(ctx context.Context, c assistant.Caller) assistant.TrustLevel {
	if h.trust == nil {
		return assistant.TrustAskRisky
	}
	s, ok := h.trust(ctx, c)
	if !ok || strings.TrimSpace(s) == "" {
		return assistant.TrustAskRisky
	}
	return assistant.NormalizeTrustLevel(assistant.TrustLevel(s))
}

// postMessageApproval is the `confirm`/`dismiss` branch (decision 2): the
// decision row is updated, the action (if confirmed) executes once through
// the underlying service as the caller, and one short acknowledgement is
// appended. There is no model call on this path. Unknown ids and
// non-pending states answer 409 approval_request_not_pending; a confirmed
// action the caller's role no longer permits is 409 action_denied and the
// request stays pending.
func (h *assistantConversationHandlers) postMessageApproval(w http.ResponseWriter, r *http.Request,
	p *Principal, conversationID string, body *AssistantMessagePost) {
	if body.Confirm != nil && body.Dismiss != nil {
		assistantCodeProblem(w, http.StatusBadRequest, "confirm_and_dismiss_exclusive",
			"confirm and dismiss are mutually exclusive: post one or the other.")
		return
	}
	confirm := body.Confirm != nil
	var id string
	if confirm {
		id = strings.TrimSpace(*body.Confirm)
	} else {
		id = strings.TrimSpace(*body.Dismiss)
	}
	if id == "" {
		assistantCodeProblem(w, http.StatusBadRequest, "invalid_approval_id",
			"confirm/dismiss must name an approval_request message id.")
		return
	}
	if strings.TrimSpace(body.Text) != "" {
		assistantCodeProblem(w, http.StatusBadRequest, "text_with_approval",
			"text must be empty when confirming or dismissing an approval request.")
		return
	}
	if h.runner == nil {
		writeAssistantProblem(w, http.StatusServiceUnavailable, "assistant_not_configured",
			"the assistant is not enabled on this deployment (COMMUNICATION_ASSISTANT_BASE_URL is unset)")
		return
	}
	if confirm {
		// A part-1 deployment (the folded-broker runner) has no confirm
		// path: the honest answer, as before part 2, before any read.
		if _, ok := h.runner.(approvalExecutor); !ok {
			assistantCodeProblem(w, http.StatusBadRequest, "approval_requests_not_available",
				"the assistant's approval flow is not available on this build yet.")
			return
		}
	}
	msg, err := h.store.GetMessage(r.Context(), p.UserID, conversationID, id)
	if err != nil || msg.Kind != "approval_request" {
		assistantApprovalProblem(w, http.StatusConflict, "approval_request_not_pending",
			"That approval request is not pending.")
		return
	}
	var ap approvalRequestPayload
	if err := json.Unmarshal(msg.Payload, &ap); err != nil || ap.State != "pending" {
		assistantApprovalProblem(w, http.StatusConflict, "approval_request_not_pending",
			"That approval request is not pending.")
		return
	}
	state := "dismissed"
	var change *AssistantChangeInput
	var ackMarkdown string
	var ackCalls []assistant.ToolCall
	if confirm {
		ex := h.runner.(approvalExecutor)
		args := ap.Args
		if args == nil {
			args = map[string]string{}
		}
		ack, ch, err := ex.ExecuteAction(r.Context(), h.caller(p), ap.Action, args)
		if err != nil {
			// Decision 4: the denial is reported with a stable reason,
			// naming no project facts, and the request stays pending so
			// the client can answer it again.
			assistantApprovalProblem(w, http.StatusConflict, "action_denied",
				"That action could not be run with your current permissions; the request stays pending.")
			return
		}
		state = "confirmed"
		ackMarkdown = ack
		ackCalls = []assistant.ToolCall{{
			Name:    ap.Action,
			Args:    stringMapToAny(args),
			OK:      true,
			Summary: ack,
		}}
		if ch != nil {
			change = &AssistantChangeInput{
				Kind:        ch.Kind,
				ProjectID:   ch.ProjectID,
				TargetRef:   ch.TargetRef,
				Summary:     ch.Summary,
				UndoPayload: ch.UndoPayload,
			}
		}
	} else {
		ackMarkdown = "Noted — I have not run that action."
	}
	ackPayload, err := json.Marshal(assistantMessagePayload{
		Kind:           "assistant",
		TurnID:         ap.TurnID,
		AnswerMarkdown: ackMarkdown,
		Links:          []assistant.MessageLink{},
		ToolCalls:      nonNilToolCalls(ackCalls),
		Degraded:       nil,
	})
	if err != nil {
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not prepare the acknowledgement.")
		return
	}
	rows, err := h.store.CompleteApproval(r.Context(), p.UserID, conversationID, id, state,
		AssistantMessageInput{Kind: "assistant", Payload: ackPayload}, change)
	switch {
	case err == nil:
		WriteJSON(w, http.StatusOK, struct {
			Messages []AssistantMessage `json:"messages"`
		}{Messages: rows})
	case errors.Is(err, ErrAssistantApprovalNotPending):
		// The request resolved between the read and this write.
		assistantApprovalProblem(w, http.StatusConflict, "approval_request_not_pending",
			"That approval request is not pending.")
	case errors.Is(err, ErrAssistantConversationNotFound):
		assistantConversationNotFound(w, err)
	default:
		h.srv.logger.Error("assistant.messages.approval", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not save the decision.")
	}
}

// approvalExecutor is the part-2 runner's confirm seam: it re-runs one
// recorded action exactly once as the caller (decision 4). The part-1
// folded-broker runner does not implement it, which is the deployment's
// honest 400 approval_requests_not_available.
type approvalExecutor interface {
	ExecuteAction(ctx context.Context, c assistant.Caller, tool string,
		args map[string]string) (string, *assistant.ChangeRecord, error)
}

// questionMessagePayload is the kind-"question" payload (ADR-0050
// decision 3): the model-written prompt, 2–4 options, free text always
// allowed. answered_by is the replying user message's id, stamped by the
// next turn in the same transaction the reply appends.
type questionMessagePayload struct {
	Kind          string                         `json:"kind"`
	TurnID        string                         `json:"turn_id"`
	Prompt        string                         `json:"prompt"`
	Options       []assistant.TurnQuestionOption `json:"options"`
	AllowFreeText bool                           `json:"allow_free_text"`
	AnsweredBy    *string                        `json:"answered_by"`
}

// approvalRequestPayload is the kind-"approval_request" payload
// (ADR-0050 decision 3): the action and its server-bounded string args
// (the confirm path re-runs exactly these), the summary and risk the card
// shows, and state pending -> confirmed | dismissed.
type approvalRequestPayload struct {
	Kind    string            `json:"kind"`
	TurnID  string            `json:"turn_id"`
	Action  string            `json:"action"`
	Args    map[string]string `json:"args"`
	Summary string            `json:"summary"`
	Risk    string            `json:"risk"`
	State   string            `json:"state"`
}

// assistantApprovalProblem is assistantCodeProblem for the approval flow's
// two stable 409s, keeping one place that knows the shape.
func assistantApprovalProblem(w http.ResponseWriter, status int, code, detail string) {
	assistantCodeProblem(w, status, code, detail)
}

func stringMapToAny(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func nonNilToolCalls(calls []assistant.ToolCall) []assistant.ToolCall {
	if calls == nil {
		return []assistant.ToolCall{}
	}
	return calls
}

// contextOrNil renders an empty validated context as an absent member.
func contextOrNil(c assistant.TurnContext) *assistant.TurnContext {
	if c.Empty() {
		return nil
	}
	return &c
}

// assistantConversationNotFound maps the store's sentinel to the 404
// not-found answer; anything else is a 500 (logged).
func assistantConversationNotFound(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrAssistantConversationNotFound) {
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"The conversation does not exist.")
		return
	}
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"Could not read the conversation.")
}

func (h *assistantConversationHandlers) listMessages(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	if _, err := h.store.GetConversation(r.Context(), p.UserID, conversationID); err != nil {
		assistantConversationNotFound(w, err)
		return
	}
	q := r.URL.Query()
	limit, ok2 := assistantLimitParam(w, q.Get("limit"))
	if !ok2 {
		return
	}
	cursor, ok3 := assistantCursor(w, q.Get("cursor"))
	if !ok3 {
		return
	}
	// A messages cursor must carry its created_at position; the nil-After
	// cursor is the conversations list's NULL zone and is invalid here.
	if cursor.Has && cursor.After == nil {
		assistantCodeProblem(w, http.StatusBadRequest, "invalid_cursor",
			"cursor must be a next_cursor value from an earlier response.")
		return
	}
	messages, next, err := h.store.ListMessages(r.Context(), p.UserID, conversationID, limit, cursor)
	if err != nil {
		h.srv.logger.Error("assistant.messages.list", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not read the conversation.")
		return
	}
	var nextPtr *string
	if next != "" {
		nextPtr = &next
	}
	WriteJSON(w, http.StatusOK, struct {
		Messages   []AssistantMessage `json:"messages"`
		NextCursor *string            `json:"next_cursor"`
	}{Messages: messages, NextCursor: nextPtr})
}

// --- changes --------------------------------------------------------------

func (h *assistantConversationHandlers) listChanges(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	if _, err := h.store.GetConversation(r.Context(), p.UserID, conversationID); err != nil {
		assistantConversationNotFound(w, err)
		return
	}
	state := r.URL.Query().Get("state")
	switch state {
	case "", "all", "open", "undone":
	default:
		assistantCodeProblem(w, http.StatusBadRequest, "invalid_state",
			"state must be open, undone or all.")
		return
	}
	changes, err := h.store.ListChanges(r.Context(), p.UserID, conversationID, state)
	if err != nil {
		h.srv.logger.Error("assistant.changes.list", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not read the change log.")
		return
	}
	WriteJSON(w, http.StatusOK, struct {
		Changes []AssistantChange `json:"changes"`
	}{Changes: changes})
}

// undoChange applies one change's recorded inverse op (ADR-0050
// decision 5): 404 when the change is not the caller's, 409
// change_not_undoable when it cannot be undone (no inverse op, already
// undone, or the inverse does not structurally apply).
func (h *assistantConversationHandlers) undoChange(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	changeID := r.PathValue("changeId")
	ch, err := h.store.UndoChange(r.Context(), h.caller(p), changeID)
	switch {
	case err == nil:
		WriteJSON(w, http.StatusOK, ch)
	case errors.Is(err, ErrAssistantChangeNotFound):
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"The change does not exist.")
	case errors.Is(err, ErrAssistantChangeNotUndoable),
		errors.Is(err, ErrAssistantChangeAlreadyUndone):
		var ne *AssistantChangeNotUndoable
		detail := "This change cannot be undone."
		if errors.As(err, &ne) && ne.Detail != "" {
			detail = ne.Detail
		}
		assistantCodeProblem(w, http.StatusConflict, "change_not_undoable", detail)
	default:
		h.srv.logger.Error("assistant.changes.undo", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not undo the change.")
	}
}

// undoAll undoes every still-open change of the conversation, newest
// first (ADR-0050 decision 2): the results array is one independent
// outcome per open change — one failure never blocks the next.
func (h *assistantConversationHandlers) undoAll(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	results, err := h.store.UndoAll(r.Context(), h.caller(p), conversationID)
	if err != nil {
		if errors.Is(err, ErrAssistantConversationNotFound) {
			WriteProblem(w, http.StatusNotFound, "Not Found",
				"The conversation does not exist.")
			return
		}
		h.srv.logger.Error("assistant.changes.undo-all", "err", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not undo the changes.")
		return
	}
	WriteJSON(w, http.StatusOK, struct {
		Results []ChangeUndoResult `json:"results"`
	}{Results: results})
}
