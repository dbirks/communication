package api

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Cross-project reads (ADR-0047, contract C3): the app shell's Home, Board,
// Threads and Inbox each need one scoped answer per page instead of an N-
// project fan-out. The three routes here — a runs list, an approvals list
// and a conversations list — return only rows from projects the caller is a
// member of (an organization admin sees their organization). The permission
// predicate lives in the store's SQL, so an invisible project contributes
// no rows: a LIST never discloses a project's existence the way a detail
// route's uniform 404 must (ADR-0014 §3).
//
// Live updates are the org event stream's job (ADR-0048, multiplexing the
// same envelope the project streams send); these are request/response
// reads, and the UI must not poll them.

// The seven step states of the cross-project runs' per-step projection
// (ADR-0047 § 4). They are a projection of node execution states, not a
// second state machine: `ready`/`leased` read as pending (the step has not
// visibly started), and `interrupted` reads as failed (the step stopped
// without completing and retry is the response — it is never a deliberate
// stop, which is cancelled).
const (
	CrossProjectStepPending   = "pending"
	CrossProjectStepRunning   = "running"
	CrossProjectStepWaiting   = "waiting"
	CrossProjectStepSucceeded = "succeeded"
	CrossProjectStepFailed    = "failed"
	CrossProjectStepSkipped   = "skipped"
	CrossProjectStepCancelled = "cancelled"
)

var crossProjectStepStates = map[string]bool{
	CrossProjectStepPending:   true,
	CrossProjectStepRunning:   true,
	CrossProjectStepWaiting:   true,
	CrossProjectStepSucceeded: true,
	CrossProjectStepFailed:    true,
	CrossProjectStepSkipped:   true,
	CrossProjectStepCancelled: true,
}

// CrossProjectRunStep is one top-level node of a run's pinned revision in
// definition order (ADR-0047 § 4): loops aggregate into their single
// top-level row, so the board's segment count is the step count, not the
// execution count.
type CrossProjectRunStep struct {
	NodeID string `json:"node_id"`
	Kind   string `json:"kind"`
	State  string `json:"state"`
}

// CrossProjectRunView is the RunSummary row plus the cross-project extras a
// board card or Home row needs without a second fetch: which project, which
// workflow (by its human names, not bare ids), and the per-step projection.
type CrossProjectRunView struct {
	RunSummaryView
	ProjectName         string                `json:"project_name"`
	PipelineSlug        string                `json:"pipeline_slug"`
	PipelineDisplayName string                `json:"pipeline_display_name"`
	Steps               []CrossProjectRunStep `json:"steps"`
}

// CrossProjectRunListView is the GET /api/v1/runs envelope. NextCursor is
// null exactly when the page holds the last row.
type CrossProjectRunListView struct {
	Runs       []CrossProjectRunView `json:"runs"`
	NextCursor *string               `json:"next_cursor"`
}

// CrossProjectApprovalListView is the GET /api/v1/approvals envelope: the
// existing Approval schema (project_id and run_id are on it).
type CrossProjectApprovalListView struct {
	Approvals []ApprovalView `json:"approvals"`
}

// CrossProjectConversationListView is the GET /api/v1/conversations
// envelope: the existing ConversationSummary schema (project_id is on it).
type CrossProjectConversationListView struct {
	Items      []ConversationSummaryView `json:"items"`
	NextCursor *string                   `json:"next_cursor"`
}

// CrossProjectRunsFilter is the validated GET /api/v1/runs query state: the
// handler owns the 400s, the store sees only values that are legal.
type CrossProjectRunsFilter struct {
	// Statuses is the deduplicated `status` csv; empty = no filter.
	Statuses []string
	// ProjectID and PipelineID are uuid-filter values; empty = no filter.
	ProjectID  string
	PipelineID string
	// Mine = runs whose triggered_by is the caller (a child or a system
	// start is never "mine").
	Mine bool
	// UpdatedSince asks for "changed since": COALESCE(finished_at,
	// created_at) >= the value — done-today and just-created rows.
	UpdatedSince *time.Time
	Limit        int
	Cursor       string
}

// Shared page limits (keyset pagination, ADR-0047 § 5).
const (
	CrossProjectDefaultLimit = 50
	CrossProjectMaxLimit     = 200
)

// CrossProjectStore answers the cross-project reads. Every method enforces
// the caller's visibility itself (the membership predicate in its SQL); a
// project the caller does not belong to contributes no rows and no error —
// the handler cannot be the only gate, because the same store backs later
// transports.
type CrossProjectStore interface {
	ListVisibleRuns(ctx context.Context, c Caller, f CrossProjectRunsFilter) ([]CrossProjectRunView, string, error)
	ListVisibleApprovals(ctx context.Context, c Caller, status string) ([]ApprovalView, error)
	ListVisibleConversations(ctx context.Context, c Caller, limit int, cursor string) ([]ConversationSummaryView, string, error)
}

// CrossProjectCursor is a keyset page position over the shared
// (created_at DESC, id DESC) order. The encoding is the wire format, so it
// lives here and the stores parse it with this helper rather than
// re-inventing a format.
type CrossProjectCursor struct {
	CreatedAt time.Time
	ID        string
}

// errInvalidCrossProjectCursor is the parse refusal; the handlers turn it
// into a 400 invalid_cursor.
var errInvalidCrossProjectCursor = errors.New("api: invalid cross-project cursor")

// EncodeCrossProjectCursor renders a cursor for the `next_cursor` field.
func EncodeCrossProjectCursor(c CrossProjectCursor) string {
	raw := c.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x1f" + c.ID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// ParseCrossProjectCursor reads a client-supplied `cursor`. Anything that
// is not the exact encoded shape is a refusal, so a cursor cannot probe
// row ids it was never handed.
func ParseCrossProjectCursor(s string) (CrossProjectCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(raw) < 3 {
		return CrossProjectCursor{}, errInvalidCrossProjectCursor
	}
	parts := strings.SplitN(string(raw), "\x1f", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return CrossProjectCursor{}, errInvalidCrossProjectCursor
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return CrossProjectCursor{}, errInvalidCrossProjectCursor
	}
	return CrossProjectCursor{CreatedAt: createdAt, ID: parts[1]}, nil
}

// RegisterCrossProject mounts the cross-project read routes (ADR-0047).
// All three are GETs, so HandleAuthed installs the session gate only — no
// CSRF guard is needed for a read.
func RegisterCrossProject(s *Server, store CrossProjectStore) {
	h := &cpHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/runs", http.HandlerFunc(h.listRuns))
	s.HandleAuthed("GET /api/v1/approvals", http.HandlerFunc(h.listApprovals))
	s.HandleAuthed("GET /api/v1/conversations", http.HandlerFunc(h.listConversations))
}

type cpHandlers struct {
	store CrossProjectStore
	srv   *Server
}

var crossProjectUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// The runs route's status vocabulary (the RunStatus enum, verbatim).
var crossProjectRunStatuses = map[string]bool{
	"queued": true, "preparing": true, "running": true, "waiting_human": true,
	"paused": true, "completed": true, "failed": true, "cancelled": true,
	"interrupted": true,
}

// The approvals route's state vocabulary (approval_requests.state CHECK).
var crossProjectApprovalStates = map[string]bool{
	"pending": true, "decided": true, "expired": true, "cancelled": true,
	"denied": true,
}

// listRuns serves GET /api/v1/runs: the cross-project run list with the
// board's filters (status csv, project, pipeline, mine, updated_since) and
// keyset pagination. Every bad value is a 400 before any store call, so a
// malformed probe cannot reach SQL.
func (h *cpHandlers) listRuns(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	f := CrossProjectRunsFilter{Limit: CrossProjectDefaultLimit}

	if raw := q.Get("status"); raw != "" {
		seen := map[string]bool{}
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if !crossProjectRunStatuses[part] {
				h.badRequest(w, "invalid_status: status must be a comma-separated list of run states: queued, preparing, running, waiting_human, paused, completed, failed, cancelled, interrupted.")
				return
			}
			if !seen[part] {
				seen[part] = true
				f.Statuses = append(f.Statuses, part)
			}
		}
	}
	if v := q.Get("project_id"); v != "" {
		if !crossProjectUUIDPattern.MatchString(v) {
			h.badRequest(w, "invalid_project_id: project_id must be a uuid.")
			return
		}
		f.ProjectID = v
	}
	if v := q.Get("pipeline_id"); v != "" {
		if !crossProjectUUIDPattern.MatchString(v) {
			h.badRequest(w, "invalid_pipeline_id: pipeline_id must be a uuid.")
			return
		}
		f.PipelineID = v
	}
	if v := q.Get("mine"); v != "" {
		if v != "true" {
			h.badRequest(w, "invalid_mine: mine must be true (or absent).")
			return
		}
		f.Mine = true
	}
	if v := q.Get("updated_since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			h.badRequest(w, "invalid_updated_since: updated_since must be an RFC 3339 timestamp.")
			return
		}
		f.UpdatedSince = &t
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > CrossProjectMaxLimit {
			h.badRequest(w, "invalid_limit: limit must be an integer between 1 and 200.")
			return
		}
		f.Limit = n
	}
	if v := q.Get("cursor"); v != "" {
		if _, err := ParseCrossProjectCursor(v); err != nil {
			h.badRequest(w, "invalid_cursor: cursor must be a next_cursor value from an earlier response.")
			return
		}
		f.Cursor = v
	}

	items, next, err := h.store.ListVisibleRuns(r.Context(), c, f)
	if err != nil {
		h.serverError(w, r, "crossproject.runs.list", err)
		return
	}
	if items == nil {
		items = []CrossProjectRunView{}
	}
	WriteJSON(w, http.StatusOK, CrossProjectRunListView{Runs: items, NextCursor: nextPtr(next)})
}

// listApprovals serves GET /api/v1/approvals: the cross-project gate list.
// Pending-first ordering (the urgent one is the one about to expire) with
// the project list's rule.
func (h *cpHandlers) listApprovals(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && !crossProjectApprovalStates[status] {
		h.badRequest(w, "invalid_status: status must be one of pending, decided, expired, cancelled, denied.")
		return
	}
	items, err := h.store.ListVisibleApprovals(r.Context(), c, status)
	if err != nil {
		h.serverError(w, r, "crossproject.approvals.list", err)
		return
	}
	if items == nil {
		items = []ApprovalView{}
	}
	for i := range items {
		items[i] = normalizeApprovalView(items[i])
	}
	WriteJSON(w, http.StatusOK, CrossProjectApprovalListView{Approvals: items})
}

// listConversations serves GET /api/v1/conversations: the cross-project
// thread list (newest first) with keyset pagination.
func (h *cpHandlers) listConversations(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit := CrossProjectDefaultLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > CrossProjectMaxLimit {
			h.badRequest(w, "invalid_limit: limit must be an integer between 1 and 200.")
			return
		}
		limit = n
	}
	cursor := q.Get("cursor")
	if cursor != "" {
		if _, err := ParseCrossProjectCursor(cursor); err != nil {
			h.badRequest(w, "invalid_cursor: cursor must be a next_cursor value from an earlier response.")
			return
		}
	}
	items, next, err := h.store.ListVisibleConversations(r.Context(), c, limit, cursor)
	if err != nil {
		h.serverError(w, r, "crossproject.conversations.list", err)
		return
	}
	if items == nil {
		items = []ConversationSummaryView{}
	}
	WriteJSON(w, http.StatusOK, CrossProjectConversationListView{Items: items, NextCursor: nextPtr(next)})
}

// nextPtr renders the absent cursor as a null, never a blank string: the
// UI's "no more pages" test is null, and "" would be an unparseable cursor
// on the next request.
func nextPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (h *cpHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

func (h *cpHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// badRequest answers 400 in the file's problem shape. It is logged at warn
// (a bad value is a client mistake, not a secret).
func (h *cpHandlers) badRequest(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusBadRequest, "Bad Request", detail)
}

func (h *cpHandlers) serverError(w http.ResponseWriter, r *http.Request, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "cross-project store failure",
		slog.String("action", action), slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}
