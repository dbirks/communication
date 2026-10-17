package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/events"
)

// The M2 conversation surface (ADR-0016, api/openapi.yaml "conversations").
//
// Package api knows nothing about SQL: everything below is a view type, a
// validation rule and an interface a store adapter implements. The two things
// this package owns outright are the authorization *shape* (non-member 404 with
// an audit row, viewer 403, controller-only 409 carrying live state) and the
// rule that lease machinery never reaches a browser (ADR-0016 §8).

// Errors the conversation handlers understand. A store adapter maps its own
// errors onto these so this package stays free of any driver dependency.
var (
	// ErrConversationNotFound is also the answer to "you may not know this
	// conversation exists": a non-member gets 404, never 403 (ADR-0016 §8).
	ErrConversationNotFound = errors.New("api: conversation not found")
	// ErrConversationForbidden is a member whose role is too low to write
	// (viewer): 403, since role is not existence information.
	ErrConversationForbidden = errors.New("api: conversation write not allowed")
	// ErrConversationValidation is a well-formed body the contract rejects (an
	// unknown agent profile, an option the agent never offered): 422.
	ErrConversationValidation = errors.New("api: conversation request failed validation")
)

// ConversationConflictKind values. They are the store's vocabulary and this
// package's problem-type table at once, which is why they are plain strings
// pinned by cnvConflictTypes below rather than an enum the adapter would have
// to translate.
const (
	ConflictControlVersionStale  = "control_version_stale"
	ConflictNotController        = "not_controller"
	ConflictTurnInProgress       = "turn_in_progress"
	ConflictNoActiveTurn         = "no_active_turn"
	ConflictPermissionNotPending = "permission_not_pending"
	ConflictArchived             = "conversation_archived"
)

// ConversationConflict is a refused conversation mutation that must answer 409
// with the state that refused it. A bare 409 would leave the loser of a control
// race unable to learn who won (communication-spec/06 edge cases), so the
// conflict carries the live control row — and the turn in the way when a turn
// is what is in the way.
type ConversationConflict struct {
	Kind           string
	Detail         string
	ConversationID string
	Control        *ConversationControlView
	ActiveTurn     *ConversationTurnView
}

func (c *ConversationConflict) Error() string {
	if c == nil {
		return "api: conversation conflict"
	}
	return fmt.Sprintf("api: conversation conflict (%s): %s", c.Kind, c.Detail)
}

// --- views (api/openapi.yaml schemas) -----------------------------------

// AgentProfileView is the AgentProfile schema. launcher_id is a launch
// descriptor, never a claim that the harness works here
// (docs/compatibility/ACP.md answers that).
type AgentProfileView struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	LauncherID     string    `json:"launcher_id"`
	PermissionMode string    `json:"permission_mode"`
	CreatedAt      time.Time `json:"created_at"`
	// The APM triple (ADR-0030). Explicit nulls, because "this profile stages no
	// packaged context" is an answer the UI has to be able to tell apart from a
	// field it never read. A ref with no digest is impossible by construction: the
	// store refuses a partial triple and the worker refuses an unverifiable pin.
	APMPackageRef *string `json:"apm_package_ref"`
	APMTarget     *string `json:"apm_target"`
	APMLockDigest *string `json:"apm_lock_digest"`
}

// ConversationControlView is the ConversationControl schema. Version is the CAS
// token every control mutation must echo, so it is always present; the nullable
// members are emitted as explicit nulls because the UI distinguishes "nobody is
// driving" from a field it never read.
type ConversationControlView struct {
	Kind           string  `json:"kind"`
	UserID         *string `json:"user_id"`
	DisplayName    *string `json:"display_name"`
	PreviousUserID *string `json:"previous_user_id"`
	Version        int     `json:"version"`
}

// AgentSessionBindingView is the AgentSessionBinding schema: what is attached
// right now, as observed. Capabilities are the agent's own reported object —
// data, not a support claim (communication-spec/04).
type AgentSessionBindingView struct {
	BindingID         string          `json:"binding_id"`
	WorkerID          string          `json:"worker_id"`
	WorkerName        *string         `json:"worker_name"`
	LauncherID        string          `json:"launcher_id"`
	LauncherVersion   string          `json:"launcher_version"`
	ACPSessionID      string          `json:"acp_session_id"`
	ProtocolVersion   int             `json:"protocol_version"`
	SessionOrigin     string          `json:"session_origin"`
	AgentCapabilities json.RawMessage `json:"agent_capabilities"`
	ConnectedAt       time.Time       `json:"connected_at"`
	LastSeenAt        time.Time       `json:"last_seen_at"`
}

// ConversationTurnView is the ConversationTurn schema. lease_expires_at and
// fencing_token are deliberately absent: a browser cannot and must not
// participate in lease arbitration (ADR-0016 §8), so a token a client could use
// to pretend it owns work never leaves the server.
type ConversationTurnView struct {
	ID                     string     `json:"id"`
	ConversationID         string     `json:"conversation_id"`
	Status                 string     `json:"status"`
	Prompt                 string     `json:"prompt,omitempty"`
	SubmittedBy            string     `json:"submitted_by"`
	SubmittedByDisplayName *string    `json:"submitted_by_display_name"`
	WorkerID               *string    `json:"worker_id"`
	CancelRequestedAt      *time.Time `json:"cancel_requested_at"`
	StopReason             *string    `json:"stop_reason"`
	CreatedAt              time.Time  `json:"created_at"`
	StartedAt              *time.Time `json:"started_at"`
	FinishedAt             *time.Time `json:"finished_at"`
}

// PermissionOptionView is the PermissionOption schema — one choice the agent
// offered. A client may echo one, never invent one.
type PermissionOptionView struct {
	OptionID string `json:"option_id"`
	Label    string `json:"label"`
	Kind     string `json:"kind,omitempty"`
}

// PermissionRequestView is the PermissionRequest schema.
type PermissionRequestView struct {
	ID             string                 `json:"id"`
	ConversationID string                 `json:"conversation_id"`
	TurnID         string                 `json:"turn_id"`
	Status         string                 `json:"status"`
	ToolTitle      string                 `json:"tool_title"`
	ToolKind       string                 `json:"tool_kind"`
	ToolCallID     *string                `json:"tool_call_id"`
	Options        []PermissionOptionView `json:"options"`
	DecidedBy      *string                `json:"decided_by"`
	// DecidedByKind is user | policy (ADR-0039 Option A): the policy's
	// permission mode names itself on `decided` rows the controller never saw.
	DecidedByKind    *string    `json:"decided_by_kind"`
	DecidedByPolicy  *string    `json:"decided_by_policy"`
	DecisionOptionID *string    `json:"decision_option_id"`
	RequestedAt      time.Time  `json:"requested_at"`
	DeadlineAt       *time.Time `json:"deadline_at"`
	DecidedAt        *time.Time `json:"decided_at"`
}

// ConversationView is the Conversation schema.
type ConversationView struct {
	ID                 string                   `json:"id"`
	ProjectID          string                   `json:"project_id"`
	AgentProfileID     string                   `json:"agent_profile_id"`
	AgentProfileName   string                   `json:"agent_profile_name"`
	LauncherID         string                   `json:"launcher_id"`
	Title              string                   `json:"title"`
	Status             string                   `json:"status"`
	CreatedBy          string                   `json:"created_by"`
	CreatedByDisplay   *string                  `json:"created_by_display_name"`
	CreatedAt          time.Time                `json:"created_at"`
	UpdatedAt          time.Time                `json:"updated_at"`
	Control            ConversationControlView  `json:"control"`
	ActiveTurn         *ConversationTurnView    `json:"active_turn"`
	AgentSession       *AgentSessionBindingView `json:"agent_session"`
	PendingPermissions []PermissionRequestView  `json:"pending_permissions"`
}

// ConversationSummaryView is the ConversationSummary schema: the project
// timeline row. It carries the controller and two booleans and none of the
// joins the detail route pays for.
type ConversationSummaryView struct {
	ID               string                  `json:"id"`
	ProjectID        string                  `json:"project_id"`
	AgentProfileID   string                  `json:"agent_profile_id"`
	Title            string                  `json:"title"`
	Status           string                  `json:"status"`
	CreatedBy        string                  `json:"created_by"`
	CreatedByDisplay *string                 `json:"created_by_display_name"`
	CreatedAt        time.Time               `json:"created_at"`
	UpdatedAt        time.Time               `json:"updated_at"`
	Control          ConversationControlView `json:"control"`
	HasActiveTurn    bool                    `json:"has_active_turn"`
	AgentConnected   bool                    `json:"agent_connected"`
}

// --- the store interfaces handlers call ---------------------------------

// ConversationStore is everything the conversation handlers need from the
// datastore. Every method enforces the caller's visibility itself — the handler
// cannot be the only gate, because the same store backs later transports — and
// answers ErrConversationNotFound, ErrConversationForbidden,
// ErrConversationValidation or *ConversationConflict for the cases named in
// api/openapi.yaml.
type ConversationStore interface {
	ListConversations(ctx context.Context, c Caller, projectID string) ([]ConversationSummaryView, error)
	CreateConversation(ctx context.Context, c Caller, projectID, agentProfileID, title, prompt string) (ConversationView, error)
	GetConversation(ctx context.Context, c Caller, conversationID string) (ConversationView, error)
	PostMessage(ctx context.Context, c Caller, conversationID, prompt string) (ConversationTurnView, error)
	TakeControl(ctx context.Context, c Caller, conversationID string, version int) (ConversationView, error)
	ReturnControl(ctx context.Context, c Caller, conversationID string, version int) (ConversationView, error)
	CancelTurn(ctx context.Context, c Caller, conversationID string) (ConversationTurnView, error)
	DecidePermission(ctx context.Context, c Caller, conversationID, requestID, optionID string) (PermissionRequestView, error)
	// AuthorizeConversation answers the one question an open stream must keep
	// asking: may this caller still see this conversation's project?
	AuthorizeConversation(ctx context.Context, c Caller, conversationID string) (projectID string, err error)
	// RecordDenied audits a refused attempt against a conversation.
	RecordDenied(ctx context.Context, c Caller, conversationID, action string) error
	// RecordProjectDenied audits a refused attempt on a project-scoped
	// conversation route (list, create), where there is no conversation to name
	// yet and the project id is all the route has. Without it a non-member
	// probing /projects/{id}/conversations would leave no trace at all, which is
	// precisely the probing ADR-0014 §3 wants visible.
	RecordProjectDenied(ctx context.Context, c Caller, projectID, action string) error
}

// cnvTarget names what a refused attempt was aimed at, and why. Exactly one of
// the two ids is set by any route: the project-scoped routes have a project id
// and no conversation, the conversation-scoped routes have the reverse.
type cnvTarget struct {
	action         string
	projectID      string
	conversationID string
}

func cnvAtConversation(action, conversationID string) cnvTarget {
	return cnvTarget{action: action, conversationID: conversationID}
}

func cnvAtProject(action, projectID string) cnvTarget {
	return cnvTarget{action: action, projectID: projectID}
}

// ConversationEventStream is the journal read behind the conversation SSE
// route. It is the conversation-scoped twin of EventStream, and the same
// wake-up-is-a-hint rule applies: the handler always re-queries by sequence.
type ConversationEventStream interface {
	ConversationEventsAfter(ctx context.Context, c Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error)
	Watch(ctx context.Context) (<-chan struct{}, func(), error)
}

// ProfileStore reads the agent profiles the caller's organization may launch,
// and (ADR-0030) writes their identity and their APM pin. Writes are the
// organization's library role — the same predicate api/pipelines.go applies to
// the shared pipeline library — and the store re-checks it in its own SQL.
type ProfileStore interface {
	ListAgentProfiles(ctx context.Context, c Caller) ([]AgentProfileView, error)
	CreateAgentProfile(ctx context.Context, c Caller, in AgentProfileCreateInput) (AgentProfileView, error)
	PatchAgentProfileAPM(ctx context.Context, c Caller, profileID string, in AgentProfileAPMPatch) (AgentProfileView, error)
}

// Validation limits, the tighter of api/openapi.yaml and the schema CHECKs.
const (
	cnvMaxTitleLen  = 200
	cnvMaxPromptLen = 65536
	cnvMaxOptionLen = 200
)

// RegisterConversations mounts the conversation, turn, control, permission and
// transcript-stream routes of api/openapi.yaml on s, and RegisterAgentProfiles
// mounts the profile listing they need. Mutations require the CSRF/Origin pair
// HandleAuthed installs from the pattern's method.
func RegisterConversations(s *Server, store ConversationStore, profiles ProfileStore, stream ConversationEventStream) {
	h := &cnvHandlers{store: store, profiles: profiles, srv: s}
	if profiles != nil {
		s.HandleAuthed("GET /api/v1/agent-profiles", http.HandlerFunc(h.listProfiles))
		// ADR-0030: profiles are writable by the organization's library role.
		s.HandleAuthed("POST /api/v1/agent-profiles", http.HandlerFunc(h.createProfile))
		s.HandleAuthed("PATCH /api/v1/agent-profiles/{profileId}", http.HandlerFunc(h.patchProfile))
	}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/conversations", http.HandlerFunc(h.listConversations))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/conversations", http.HandlerFunc(h.createConversation))
	s.HandleAuthed("GET /api/v1/conversations/{conversationId}", http.HandlerFunc(h.getConversation))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/messages", http.HandlerFunc(h.postMessage))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/take-control", http.HandlerFunc(h.takeControl))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/return-control", http.HandlerFunc(h.returnControl))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/cancel", http.HandlerFunc(h.cancel))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/permissions/{requestId}", http.HandlerFunc(h.decidePermission))
	if stream != nil {
		registerConversationEvents(s, h, stream, evtProductionTiming())
	}
}

type cnvHandlers struct {
	store    ConversationStore
	profiles ProfileStore
	srv      *Server
}

// --- request bodies -----------------------------------------------------

type cnvCreateBody struct {
	AgentProfileID string `json:"agent_profile_id"`
	Title          string `json:"title"`
	Prompt         string `json:"prompt,omitempty"`
}

type cnvMessageBody struct {
	Prompt string `json:"prompt"`
}

type cnvControlBody struct {
	Version int `json:"version"`
}

type cnvPermissionBody struct {
	OptionID string `json:"option_id"`
}

// --- handlers -----------------------------------------------------------

func (h *cnvHandlers) listProfiles(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.profiles.ListAgentProfiles(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, cnvTarget{action: "profile.list"}, err)
		return
	}
	if items == nil {
		items = []AgentProfileView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]AgentProfileView]{Items: items})
}

func (h *cnvHandlers) listConversations(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	items, err := h.store.ListConversations(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, cnvAtProject("conversation.list", projectID), err)
		return
	}
	if items == nil {
		items = []ConversationSummaryView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]ConversationSummaryView]{Items: items})
}

func (h *cnvHandlers) createConversation(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")

	var body cnvCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		cnvInvalid(w, "title is required.")
		return
	}
	if utf8.RuneCountInString(title) > cnvMaxTitleLen {
		cnvInvalid(w, fmt.Sprintf("title must be at most %d characters.", cnvMaxTitleLen))
		return
	}
	if !validUUID(body.AgentProfileID) {
		cnvInvalid(w, "agent_profile_id must be a uuid.")
		return
	}
	prompt := body.Prompt
	if strings.TrimSpace(prompt) != "" && utf8.RuneCountInString(prompt) > cnvMaxPromptLen {
		cnvInvalid(w, fmt.Sprintf("prompt must be at most %d characters.", cnvMaxPromptLen))
		return
	}

	chat, err := h.store.CreateConversation(r.Context(), c, projectID, body.AgentProfileID, title, prompt)
	if err != nil {
		h.fail(w, r, c, cnvAtProject("conversation.create", projectID), err)
		return
	}
	WriteJSON(w, http.StatusCreated, chat)
}

func (h *cnvHandlers) getConversation(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	chat, err := h.store.GetConversation(r.Context(), c, conversationID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.get", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

func (h *cnvHandlers) postMessage(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvMessageBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		cnvInvalid(w, "prompt is required.")
		return
	}
	if utf8.RuneCountInString(body.Prompt) > cnvMaxPromptLen {
		cnvInvalid(w, fmt.Sprintf("prompt must be at most %d characters.", cnvMaxPromptLen))
		return
	}

	turn, err := h.store.PostMessage(r.Context(), c, conversationID, body.Prompt)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.message", conversationID), err)
		return
	}
	// 202, not 201: the prompt is durable, the answer is not, and nothing here
	// waits for the agent (ADR-0016 §3).
	w.Header().Set("Location", "/api/v1/conversations/"+conversationID)
	WriteJSON(w, http.StatusAccepted, turn)
}

func (h *cnvHandlers) takeControl(w http.ResponseWriter, r *http.Request) {
	h.controlMutation(w, r, "conversation.take-control", h.store.TakeControl)
}

func (h *cnvHandlers) returnControl(w http.ResponseWriter, r *http.Request) {
	h.controlMutation(w, r, "conversation.return-control", h.store.ReturnControl)
}

// controlMutation is both control routes: the bodies, the validation, the 409
// rendering and the response are identical, and the only difference between
// taking and returning is which state the store requires.
func (h *cnvHandlers) controlMutation(w http.ResponseWriter, r *http.Request, action string, fn func(context.Context, Caller, string, int) (ConversationView, error)) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvControlBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	// version >= 1 is conversation_control's own CHECK; saying 422 here keeps a
	// client that never read a control row from looking like it lost a race.
	if body.Version < 1 {
		cnvInvalid(w, "version must be at least 1.")
		return
	}

	chat, err := fn(r.Context(), c, conversationID, body.Version)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation(action, conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

func (h *cnvHandlers) cancel(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	turn, err := h.store.CancelTurn(r.Context(), c, conversationID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.cancel", conversationID), err)
		return
	}
	// A cancellation is a request, not a stop: 202 because the turn is still
	// non-terminal whenever a worker has to notice (ADR-0016 §5).
	WriteJSON(w, http.StatusAccepted, turn)
}

func (h *cnvHandlers) decidePermission(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	requestID := r.PathValue("requestId")

	var body cnvPermissionBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if strings.TrimSpace(body.OptionID) == "" {
		cnvInvalid(w, "option_id is required.")
		return
	}
	if utf8.RuneCountInString(body.OptionID) > cnvMaxOptionLen {
		cnvInvalid(w, fmt.Sprintf("option_id must be at most %d characters.", cnvMaxOptionLen))
		return
	}
	if !validUUID(requestID) {
		h.denied(w, r, c, cnvAtConversation("conversation.permission", conversationID), "malformed permission id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such permission request.")
		return
	}

	permission, err := h.store.DecidePermission(r.Context(), c, conversationID, requestID, body.OptionID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.permission", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, permission)
}

// --- shared plumbing ----------------------------------------------------

func (h *cnvHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, cnvTarget{action: "no action"}, errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// fail maps a conversation store error onto the HTTP contract. Order matters:
// a conflict is checked first because it is the widest case, and a non-member
// answer always writes the audit row before the 404 goes out (ADR-0014 §3).
func (h *cnvHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, target cnvTarget, err error) {
	var conflict *ConversationConflict
	if errors.As(err, &conflict) {
		h.denied(w, r, c, target, conflict.Kind)
		cnvWriteConflict(w, conflict)
		return
	}
	switch {
	case errors.Is(err, ErrConversationNotFound):
		h.denied(w, r, c, target, "no such conversation, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such conversation.")
	case errors.Is(err, ErrConversationForbidden):
		h.denied(w, r, c, target, "the caller's project role is read-only")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Your project role is read-only; a contributor is required to change a conversation.")
	case errors.Is(err, ErrConversationValidation):
		cnvInvalid(w, cnvValidationDetail(err))
	default:
		h.serverError(w, r, target, err)
	}
}

// cnvValidationDetail turns a wrapped ErrConversationValidation into the 422
// detail the client needs. The store names the offending value (which option an
// agent never offered, which profile is not in the organization) and that
// naming is the whole point of a 422, so the text after the sentinel is
// forwarded; anything else is replaced by a generic line rather than echoed.
func cnvValidationDetail(err error) string {
	text := err.Error()
	prefix := ErrConversationValidation.Error()
	if i := strings.Index(text, prefix); i >= 0 {
		text = text[i+len(prefix):]
	}
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), ":"))
	text = strings.TrimSpace(text)
	if text == "" {
		return "The request is not valid for this conversation."
	}
	return text
}

// cnvConflictTypes maps a conflict kind onto the stable problem type and title
// api/openapi.yaml ConversationConflict documents.
var cnvConflictTypes = map[string](struct{ typ, title string }){
	ConflictControlVersionStale:  {"https://communication.dev/errors/control-version-stale", "Control Version Stale"},
	ConflictNotController:        {"https://communication.dev/errors/not-controller", "Not the Controller"},
	ConflictTurnInProgress:       {"https://communication.dev/errors/turn-in-progress", "Turn In Progress"},
	ConflictNoActiveTurn:         {"https://communication.dev/errors/no-active-turn", "No Active Turn"},
	ConflictPermissionNotPending: {"https://communication.dev/errors/permission-not-pending", "Permission Not Pending"},
	ConflictArchived:             {"https://communication.dev/errors/conversation-archived", "Conversation Archived"},
}

// cnvWriteConflict writes the ConversationConflictProblem schema: a Problem plus
// the current control row (and the blocking turn when there is one). The UI is
// required to adopt the returned control rather than retry blindly, which is
// only possible if the answer carries it (ADR-0016 §9 obligation 3).
func cnvWriteConflict(w http.ResponseWriter, conflict *ConversationConflict) {
	typ, title := "https://communication.dev/errors/conversation-conflict", "Conversation Conflict"
	if t, ok := cnvConflictTypes[conflict.Kind]; ok {
		typ, title = t.typ, t.title
	}
	status := http.StatusConflict
	detail := conflict.Detail
	if detail == "" {
		detail = "The request conflicts with the conversation's current state."
	}
	control := conflict.Control
	if control == nil {
		control = &ConversationControlView{Kind: events.ControllerKindNone, Version: 0}
	}
	body := struct {
		Type           string                   `json:"type"`
		Title          string                   `json:"title"`
		Status         int                      `json:"status"`
		Detail         string                   `json:"detail,omitempty"`
		ConversationID string                   `json:"conversation_id"`
		Control        *ConversationControlView `json:"control"`
		ActiveTurn     *ConversationTurnView    `json:"active_turn,omitempty"`
	}{typ, title, status, detail, conflict.ConversationID, control, conflict.ActiveTurn}

	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// denied records a refused attempt. A failure to record it is logged but never
// changes the answer: the request is denied either way.
func (h *cnvHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, target cnvTarget, reason string) {
	var err error
	switch {
	case target.conversationID != "":
		err = h.store.RecordDenied(r.Context(), c, target.conversationID, target.action)
	case target.projectID != "":
		err = h.store.RecordProjectDenied(r.Context(), c, target.projectID, target.action)
	}
	if err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", target.action),
			slog.String("conversation_id", target.conversationID),
			slog.String("project_id", target.projectID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "conversation access denied",
		slog.String("action", target.action),
		slog.String("user_id", c.UserID),
		slog.String("conversation_id", target.conversationID),
		slog.String("project_id", target.projectID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *cnvHandlers) serverError(w http.ResponseWriter, r *http.Request, target cnvTarget, err error) {
	h.log(r).ErrorContext(r.Context(), "conversation store failure",
		slog.String("action", target.action),
		slog.String("conversation_id", target.conversationID),
		slog.String("project_id", target.projectID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *cnvHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
	h.log(r).WarnContext(r.Context(), "rejected request body",
		slog.String("path", r.URL.Path),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
}

func (h *cnvHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// cnvInvalid writes the 422 problem+json every validation failure shares.
func cnvInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// validUUID reports whether s is a canonical 8-4-4-4-12 uuid. Path and body ids
// are validated before they reach a store so a malformed id answers 404/422
// rather than a driver syntax error.
func validUUID(s string) bool {
	const hexDigits = "0123456789abcdefABCDEF"
	want := []int{8, 4, 4, 4, 12}
	if len(s) != 36 {
		return false
	}
	i := 0
	for part, n := range want {
		if part > 0 {
			if s[i] != '-' {
				return false
			}
			i++
		}
		if i+n > len(s) {
			return false
		}
		for j := i; j < i+n; j++ {
			if !strings.ContainsRune(hexDigits, rune(s[j])) {
				return false
			}
		}
		i += n
	}
	return i == len(s)
}

// cnvNullString renders "" as a JSON null, which is how the schema's
// `type: ["string","null"]` members are expressed by a Go string.
func cnvNullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// cnvNullTime renders a nil *time.Time as null (encoding/json already does that)
// but normalises the zone so a response never claims a local offset.
func cnvNullTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}
