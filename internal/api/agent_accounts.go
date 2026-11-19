package api

// ADR-0085: the HTTP surface for in-app agent sign-in — the Settings "Agent
// accounts" tab's five routes. The wire shapes are the types in
// agent_accounts_types.go (never a store type), and the persistence face is
// the AgentAccountStore port there. What this file owns is the HTTP contract:
//
//   - Every route is org-admin-only: the 403 gate runs BEFORE the store is
//     touched, so a member's request never reaches a query. The session check
//     itself is HandleAuthed's (ADR-0014 §2), and mutations carry CSRF exactly
//     like the ADR-0084 collection POSTs — HandleAuthed installs RequireCSRF
//     from the pattern's method, so there is nothing extra to remember here.
//   - A foreign or malformed id is the uniform 404; nothing leaks existence
//     across organizations (the store answers ErrAgentLoginNotFound for both).
//   - The pasted Antigravity code is the one value this file must never
//     reproduce: not in a response, not in a log line, not in an error. The
//     handler trims it, hands it to the store and forgets it; logs name only
//     the login id (ADR-0085 Security).

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
)

// agentSignInLaunchers is the openapi.yaml enum for {launcher}: the agents
// whose drivers exist. Anything else is 404, not 400 — "no in-app sign-in for
// that agent" is the same invisible-resource answer as an unknown id, because
// an unsupported launcher is not a resource this deployment has.
var agentSignInLaunchers = map[string]bool{"codex": true, "antigravity": true}

// agentLoginCodeMaxChars is AgentLoginCode.code's maxLength (and its minLength
// is 1, enforced after the trim).
const agentLoginCodeMaxChars = 2048

// agentLoginWorkerIDMaxChars bounds the optional worker_id of a start request.
const agentLoginWorkerIDMaxChars = 200

// agentLoginCreateBody is POST /agent-accounts/{launcher}/logins' body. The
// whole body is optional (an empty body means "any worker"); `worker_id: null`
// decodes to the same nil as an omitted field.
type agentLoginCreateBody struct {
	WorkerID *string `json:"worker_id"`
}

// agentLoginCodeBody is POST /agent-logins/{loginId}/code's body: {"code":
// "..."} and nothing else (DecodeJSON rejects unknown fields).
type agentLoginCodeBody struct {
	Code string `json:"code"`
}

// RegisterAgentAccounts mounts ADR-0085's sign-in surface. A nil store mounts
// nothing (the house idiom: the routes exist only where the queue exists).
func RegisterAgentAccounts(s *Server, store AgentAccountStore) {
	if store == nil {
		return
	}
	h := &agentAccountHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/agent-accounts", http.HandlerFunc(h.list))
	s.HandleAuthed("POST /api/v1/agent-accounts/{launcher}/logins", http.HandlerFunc(h.startLogin))
	s.HandleAuthed("GET /api/v1/agent-logins/{loginId}", http.HandlerFunc(h.getLogin))
	s.HandleAuthed("POST /api/v1/agent-logins/{loginId}/code", http.HandlerFunc(h.submitCode))
	s.HandleAuthed("POST /api/v1/agent-logins/{loginId}/cancel", http.HandlerFunc(h.cancelLogin))
}

type agentAccountHandlers struct {
	store AgentAccountStore
	srv   *Server
}

func (h *agentAccountHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		// RequireAuth guards every mount; reaching the handler without a
		// principal is a wiring bug, and a wiring bug gets a 500, not a nil
		// caller leaked into the store.
		h.serverError(w, r, "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireAdmin is ADR-0085's only authorization rule: sign-ins start or finish
// someone's credential volume, so the organization's admin owns the button.
// It runs before any store call; a member sees 403 and no query happens.
func (h *agentAccountHandlers) requireAdmin(w http.ResponseWriter, r *http.Request, c Caller) bool {
	if c.IsOrgAdmin {
		return true
	}
	h.log(r).WarnContext(r.Context(), "agent account write denied",
		slog.String("user_id", c.UserID),
		slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Only organization admins can manage agent sign-ins.")
	return false
}

// loginID resolves the {loginId} segment: malformed uuids are the uniform 404
// and never reach the store (house rule — a driver syntax error is not an API
// answer).
func (h *agentAccountHandlers) loginID(w http.ResponseWriter, r *http.Request, c Caller) (string, bool) {
	id := r.PathValue("loginId")
	if !validUUID(id) {
		h.log(r).WarnContext(r.Context(), "agent login id rejected",
			slog.String("user_id", c.UserID),
			slog.String("request_id", RequestIDFrom(r)))
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such sign-in.")
		return "", false
	}
	return id, true
}

func (h *agentAccountHandlers) list(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireAdmin(w, r, c) {
		return
	}
	items, err := h.store.ListAgentAccounts(r.Context(), c)
	if err != nil {
		h.fail(w, r, "agent-account.list", err)
		return
	}
	if items == nil {
		// Empty is [] never null: the tab iterates without a nil check.
		items = []AgentAccountView{}
	}
	WriteJSON(w, http.StatusOK, AgentAccountList{Items: items})
}

func (h *agentAccountHandlers) startLogin(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireAdmin(w, r, c) {
		return
	}
	launcher := r.PathValue("launcher")
	if !agentSignInLaunchers[launcher] {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No in-app sign-in for that agent.")
		return
	}
	var body agentLoginCreateBody
	if err := DecodeJSON(r, &body); err != nil && !errors.Is(err, ErrBodyEmpty) {
		// The empty body is the documented "any worker" request; anything
		// malformed — including an unknown field — is a 400 (AgentLoginCreate
		// is additionalProperties: false). The decoder's error names field
		// names only, so the prose stays generic.
		h.badRequest(w, "The request body is not valid JSON.")
		return
	}
	workerID := ""
	if body.WorkerID != nil {
		workerID = strings.TrimSpace(*body.WorkerID)
		if workerID == "" || len(workerID) > agentLoginWorkerIDMaxChars {
			h.badRequest(w, "worker_id must be between 1 and 200 characters.")
			return
		}
	}
	view, err := h.store.CreateAgentLogin(r.Context(), c, launcher, workerID)
	if err != nil {
		h.fail(w, r, "agent-login.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, view)
}

func (h *agentAccountHandlers) getLogin(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireAdmin(w, r, c) {
		return
	}
	id, ok := h.loginID(w, r, c)
	if !ok {
		return
	}
	view, err := h.store.GetAgentLogin(r.Context(), c, id)
	if err != nil {
		h.fail(w, r, "agent-login.get", err)
		return
	}
	WriteJSON(w, http.StatusOK, view)
}

// submitCode is the one route that carries a secret. The code is trimmed,
// length-checked, handed to the store and never named again: every log line
// and every problem detail on this path is built from the login id alone.
func (h *agentAccountHandlers) submitCode(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireAdmin(w, r, c) {
		return
	}
	id, ok := h.loginID(w, r, c)
	if !ok {
		return
	}
	var body agentLoginCodeBody
	if err := DecodeJSON(r, &body); err != nil {
		if errors.Is(err, ErrBodyEmpty) {
			h.badRequest(w, "Paste the code the sign-in page showed.")
			return
		}
		h.badRequest(w, "The request body is not valid JSON.")
		return
	}
	code := strings.TrimSpace(body.Code)
	if code == "" || len(code) > agentLoginCodeMaxChars {
		h.badRequest(w, "Paste the code the sign-in page showed.")
		return
	}
	if err := h.store.SubmitAgentLoginCode(r.Context(), c, id, code); err != nil {
		h.fail(w, r, "agent-login.code", err)
		return
	}
	// 202 with an empty body: the worker owns what happens next, and the
	// client learns it by polling GET /agent-logins/{id}. The accepted code
	// never travels back down this pipe.
	WriteJSON(w, http.StatusAccepted, nil)
}

func (h *agentAccountHandlers) cancelLogin(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireAdmin(w, r, c) {
		return
	}
	id, ok := h.loginID(w, r, c)
	if !ok {
		return
	}
	if err := h.store.CancelAgentLogin(r.Context(), c, id); err != nil {
		h.fail(w, r, "agent-login.cancel", err)
		return
	}
	// 202 even on an already-terminal row (the store answers nil there):
	// cancelling twice is not an error, and the dialog just re-reads.
	WriteJSON(w, http.StatusAccepted, nil)
}

// fail maps a store error onto the HTTP contract. The three sentinels are the
// documented statuses; anything else is a 500 whose body carries only the
// request-id sentence (ADR-0014 §2 — the error may name tables or, worst of
// all, codes; neither leaves the process).
func (h *agentAccountHandlers) fail(w http.ResponseWriter, r *http.Request, action string, err error) {
	switch {
	case errors.Is(err, ErrAgentLoginActive):
		WriteProblem(w, http.StatusConflict, "Conflict",
			"A sign-in for this agent is already in progress.")
	case errors.Is(err, ErrAgentLoginState):
		WriteProblem(w, http.StatusConflict, "Conflict",
			"This sign-in isn't waiting for a code.")
	case errors.Is(err, ErrAgentLoginNotFound):
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such sign-in.")
	default:
		h.serverError(w, r, action, err)
	}
}

func (h *agentAccountHandlers) badRequest(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusBadRequest, "Bad Request", detail)
}

func (h *agentAccountHandlers) serverError(w http.ResponseWriter, r *http.Request, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "agent account request failed",
		slog.String("action", action),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *agentAccountHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.Default()
}
