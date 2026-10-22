package api

// The issue-trigger surface (ADR-0056 part 2): "when an open GitHub issue in
// this repository for this assignment shows up, start it" — the CRUD half of
// the ADR's fire contract, mounted beside the schedule routes in serveStack.
//
// The permission shape is the assignment's, exactly as schedules are: reading
// is viewer+ on the owning project, creating/editing is maintainer+, and a row
// in another project — or a trigger id that is not yours to see — answers the
// same 404 a nonsense uuid does (ADR-0014 §3). The SQL-side predicates live in
// the store adapter; this layer owns the request-shape validation that a fire
// can never be trusted to re-derive (the event vocabulary, the label bounds, the
// inputs shape) and the named problem codes those refusals answer with.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/integrations/github"
)

// Sentinels the store adapter maps its own misses onto (house style: the
// adapter, not the handler, translates database facts into HTTP facts).
var (
	// ErrIssueTriggerNotFound covers a missing id AND a trigger whose project
	// the caller may not see — one answer, never a peek (ADR-0014 §3).
	ErrIssueTriggerNotFound = errors.New("api: issue trigger not found")
	// ErrIssueTriggerStaleVersion is the optimistic-concurrency miss: somebody
	// else edited the trigger. 409; the client re-reads and replays.
	ErrIssueTriggerStaleVersion = errors.New("api: issue trigger version is stale")
	// ErrIssueTriggerNotFireable refuses a trigger whose assignment can never
	// fire (disabled, or pinned to an unpublished revision). The ADR's
	// reasoning: "the trigger is broken" must beat "the trigger silently never
	// ran", so the create says no out loud.
	ErrIssueTriggerNotFireable = errors.New("api: issue trigger assignment cannot fire")
)

// Problem codes this surface emits. The 422s ride the m4WriteTypedProblem
// envelope (the errors:// URI of the code); the 400s are the shape refusals a
// fire cannot be trusted to re-derive.
const (
	IssueTriggerCodeInvalidEvent  = "invalid_event"
	IssueTriggerCodeInvalidLabels = "invalid_labels"
	IssueTriggerCodeNotGitHubRepo = "not_a_github_repository"
	IssueTriggerCodeVersionStale  = "issue_trigger_version_stale"
	IssueTriggerCodeNotFireable   = "issue_trigger_not_fireable"
	IssueTriggerCodePatchEmpty    = "empty_patch"
	IssueTriggerCodeFieldRequired = "field_required"
	IssueTriggerCodeInputsInvalid = "invalid_inputs"
)

// IssueTriggerView is one issue_triggers row as the API presents it. The
// poll bookkeeping (cursor / last_polled / last_error) rides along: the UI
// answers "what is it watching, and what did it last say?" from this row alone.
type IssueTriggerView struct {
	ID           string          `json:"id"`
	ProjectID    string          `json:"project_id"`
	AssignmentID string          `json:"assignment_id"`
	RepositoryID string          `json:"repository_id"`
	Event        string          `json:"event"`
	Labels       []string        `json:"labels"`
	Inputs       json.RawMessage `json:"inputs"`
	Enabled      bool            `json:"enabled"`
	CursorAt     *time.Time      `json:"cursor_at"`
	LastPolledAt *time.Time      `json:"last_polled_at"`
	LastError    string          `json:"last_error"`
	Version      int             `json:"version"`
	CreatedBy    string          `json:"created_by"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	MyRole       string          `json:"my_role,omitempty"`
}

// IssueTriggerListView is GET /projects/{id}/issue-triggers' envelope.
type IssueTriggerListView struct {
	IssueTriggers []IssueTriggerView `json:"issue_triggers"`
}

// IssueTriggerCreateInput is POST /projects/{id}/issue-triggers' body
// (the handler reads it from JSON; enabled defaults to true when absent).
type IssueTriggerCreateInput struct {
	AssignmentID string          `json:"assignment_id"`
	RepositoryID string          `json:"repository_id"`
	Event        string          `json:"event"`
	Labels       []string        `json:"labels"`
	Inputs       json.RawMessage `json:"inputs"`
	Enabled      *bool           `json:"enabled"`
}

// IssueTriggerPatchInput is PATCH /issue-triggers/{id}'s body. Version is the
// caller's read of the row (optimistic concurrency); the editable members are
// nil ⇒ unchanged and at least one must be present.
type IssueTriggerPatchInput struct {
	Version      int              `json:"version"`
	AssignmentID *string          `json:"assignment_id"`
	RepositoryID *string          `json:"repository_id"`
	Event        *string          `json:"event"`
	Labels       *[]string        `json:"labels"`
	Inputs       *json.RawMessage `json:"inputs"`
	Enabled      *bool            `json:"enabled"`
}

// IssueTriggerStore is what the handlers need from the datastore. Every method
// carries the caller so the permission predicate can stay part of the SQL (the
// m4api.go's rule); a row outside the caller's view is the not-found
// sentinel, never a shorter answer.
type IssueTriggerStore interface {
	ListProjectIssueTriggers(ctx context.Context, c Caller, projectID string) ([]IssueTriggerView, error)
	CreateIssueTrigger(ctx context.Context, c Caller, projectID string, in IssueTriggerCreateInput) (IssueTriggerView, error)
	GetIssueTrigger(ctx context.Context, c Caller, issueTriggerID string) (IssueTriggerView, error)
	UpdateIssueTrigger(ctx context.Context, c Caller, issueTriggerID string, in IssueTriggerPatchInput) (IssueTriggerView, error)
}

// RegisterIssueTriggers mounts the three ADR-0056 part-2 routes beside the
// schedule routes of RegisterSchedules.
func RegisterIssueTriggers(s *Server, store IssueTriggerStore, projects ProjectStore) {
	h := &issueTriggerHandlers{store: store, projects: projects, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/issue-triggers", http.HandlerFunc(h.listIssueTriggers))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/issue-triggers", http.HandlerFunc(h.createIssueTriggers))
	s.HandleAuthed("PATCH /api/v1/issue-triggers/{issueTriggerId}", http.HandlerFunc(h.patchIssueTrigger))
}

type issueTriggerHandlers struct {
	store    IssueTriggerStore
	projects ProjectStore
	srv      *Server
}

// --- handlers -----------------------------------------------------------

func (h *issueTriggerHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireRole gates a project-scoped issue-trigger route on the one
// ProjectStore read, the way runs.go's requireProjectRole does: invisible
// project → 404 (audited there), visible-but-under-ranked → audited 403.
func (h *issueTriggerHandlers) requireRole(w http.ResponseWriter, r *http.Request, c Caller,
	projectID, action string, manage bool) bool {
	project, err := h.projects.GetProject(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, err)
		return false
	}
	role := authz.Role(project.MyRole)
	if manage {
		if authz.CanManage(c.IsOrgAdmin, role) {
			return true
		}
	} else if authz.CanView(c.IsOrgAdmin, role) {
		return true
	}
	h.denied(w, r, c, projectID, action, "project role is not sufficient")
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is not sufficient for this operation.")
	return false
}

func (h *issueTriggerHandlers) listIssueTriggers(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireRole(w, r, c, projectID, "issue_trigger.list", false) {
		return
	}
	items, err := h.store.ListProjectIssueTriggers(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "issue_trigger.list", err)
		return
	}
	if items == nil {
		items = []IssueTriggerView{}
	}
	WriteJSON(w, http.StatusOK, IssueTriggerListView{IssueTriggers: items})
}

func (h *issueTriggerHandlers) createIssueTriggers(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireRole(w, r, c, projectID, "issue_trigger.create", true) {
		return
	}
	var body IssueTriggerCreateInput
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !validUUID(body.AssignmentID) {
		issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeFieldRequired, "assignment_id",
			"assignment_id must be the uuid of one of this project's pipeline assignments.")
		return
	}
	if !validUUID(body.RepositoryID) {
		issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeFieldRequired, "repository_id",
			"repository_id must be the uuid of one of this project's repositories.")
		return
	}
	if !issueTriggerValidEvent(body.Event) {
		issueTriggerProblem(w, http.StatusBadRequest, IssueTriggerCodeInvalidEvent, "event",
			"event must be one of opened, labeled.")
		return
	}
	if err := issueTriggerValidLabels(body.Labels); err != nil {
		issueTriggerProblem(w, http.StatusBadRequest, IssueTriggerCodeInvalidLabels, "labels", err.Error())
		return
	}
	if err := issueTriggerCheckInputsShape(body.Inputs); err != nil {
		issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeInputsInvalid, "inputs", err.Error())
		return
	}
	item, err := h.store.CreateIssueTrigger(r.Context(), c, projectID, body)
	if err != nil {
		h.fail(w, r, c, projectID, "issue_trigger.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, item)
}

func (h *issueTriggerHandlers) patchIssueTrigger(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	issueTriggerID := r.PathValue("issueTriggerId")
	if !validUUID(issueTriggerID) {
		h.denied(w, r, c, issueTriggerID, "issue_trigger.update", "malformed issue trigger id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such issue trigger.")
		return
	}
	current, err := h.store.GetIssueTrigger(r.Context(), c, issueTriggerID)
	if err != nil {
		h.fail(w, r, c, issueTriggerID, "issue_trigger.update", err)
		return
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(current.MyRole)) {
		h.denied(w, r, c, current.ProjectID, "issue_trigger.update", "project role is not maintainer")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Editing an issue trigger requires a maintainer role on the owning project.")
		return
	}
	var body IssueTriggerPatchInput
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Version < 1 {
		issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeFieldRequired, "version",
			"version is required: the version you read, for optimistic concurrency.")
		return
	}
	if body.AssignmentID == nil && body.RepositoryID == nil && body.Event == nil && body.Labels == nil &&
		body.Inputs == nil && body.Enabled == nil {
		issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodePatchEmpty, "",
			"At least one editable member must be present.")
		return
	}
	if body.Event != nil && !issueTriggerValidEvent(*body.Event) {
		issueTriggerProblem(w, http.StatusBadRequest, IssueTriggerCodeInvalidEvent, "event",
			"event must be one of opened, labeled.")
		return
	}
	if body.Labels != nil && issueTriggerValidLabels(*body.Labels) != nil {
		issueTriggerProblem(w, http.StatusBadRequest, IssueTriggerCodeInvalidLabels, "labels",
			"labels must be at most 20 names of at most 50 characters each.")
		return
	}
	if body.Inputs != nil {
		if err := issueTriggerCheckInputsShape(*body.Inputs); err != nil {
			issueTriggerProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeInputsInvalid, "inputs", err.Error())
			return
		}
	}
	item, err := h.store.UpdateIssueTrigger(r.Context(), c, issueTriggerID, body)
	if err != nil {
		h.fail(w, r, c, issueTriggerID, "issue_trigger.update", err)
		return
	}
	WriteJSON(w, http.StatusOK, item)
}

// --- shared plumbing ----------------------------------------------------

// issueTriggerProblem writes the issue-trigger family's problem+json response.
// `field`, when set, rides as the `field` member naming the request member to
// fix; the status carries the family's refusal verb (422 for the store-owned
// facts, 400 for the shape refusals a fire cannot re-derive).
func issueTriggerProblem(w http.ResponseWriter, status int, code, field, detail string) {
	if field != "" {
		m4WriteTypedProblemExtra(w, status, code, "Validation Failed", detail,
			struct {
				Field string `json:"field"`
			}{Field: field})
		return
	}
	m4WriteTypedProblem(w, status, code, "Validation Failed", detail)
}

// issueTriggerValidEvent is the ADR's fired-condition vocabulary: an issue
// trigger names WHEN (an issue was opened) and optionally WHAT (labels).
func issueTriggerValidEvent(event string) bool {
	return event == "opened" || event == "labeled"
}

// issueTriggerValidLabels bounds the any-of label set: at most 20 names, each
// at most 50 characters (GitHub's own label-name ceiling), and no empty name.
func issueTriggerValidLabels(labels []string) error {
	if len(labels) > 20 {
		return errors.New("issue triggers may name at most 20 labels")
	}
	for _, l := range labels {
		if l == "" || len(l) > 50 {
			return fmt.Errorf("issue trigger label %q is empty or longer than 50 characters", l)
		}
	}
	return nil
}

// issueTriggerCheckInputsShape is the handler-side half of the inputs rule: a
// JSON object (or absent). What the KEYS and VALUES may be is the pinned
// revision's input schema, and only the store can answer that — this check
// exists so a string body is a named 422 rather than a database error.
func issueTriggerCheckInputsShape(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return errors.New("inputs must be a JSON object of run input names to values")
	}
	return nil
}

// fail maps an issue-trigger store error onto the HTTP contract: 404 (never a
// peek), 409 named codes for the stale-version and cannot-fire races, the
// not-a-GitHub-repository 422, and 500 for everything else.
func (h *issueTriggerHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action string, err error) {
	var invalid *RunInputsInvalid
	if errors.As(err, &invalid) {
		m4WriteValidateProblem(w, invalid)
		return
	}
	switch {
	case errors.Is(err, ErrIssueTriggerNotFound):
		h.denied(w, r, c, resourceID, action, "no such issue trigger, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such issue trigger.")
	case errors.Is(err, ErrProjectNotFound):
		h.denied(w, r, c, resourceID, action, "no such project, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
	case errors.Is(err, ErrIssueTriggerStaleVersion):
		m4WriteTypedProblem(w, http.StatusConflict, IssueTriggerCodeVersionStale,
			"Issue Trigger Version Stale",
			"The issue trigger changed since you read it; re-read and replay your edit against the current version.")
	case errors.Is(err, ErrIssueTriggerNotFireable):
		m4WriteTypedProblem(w, http.StatusConflict, IssueTriggerCodeNotFireable,
			"Issue Trigger Not Fireable",
			"The assignment behind this issue trigger is disabled or pinned to an unpublished revision; fix the assignment before triggering it.")
	case errors.Is(err, github.ErrNotGitHubRepository):
		m4WriteTypedProblem(w, http.StatusUnprocessableEntity, IssueTriggerCodeNotGitHubRepo,
			"Not A GitHub Repository",
			"The repository behind this issue trigger is not a GitHub repository, so it has no issues to watch.")
	default:
		h.serverError(w, r, resourceID, action, err)
	}
}

// denied writes the audit row (through the project store, the issue-trigger
// family's owner of a project for every route here) and the warn log.
func (h *issueTriggerHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, reason string) {
	if h.projects != nil {
		if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
			h.log(r).ErrorContext(r.Context(), "could not write audit denial",
				slog.String("action", action), slog.String("project_id", projectID),
				slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
			return
		}
	}
	h.log(r).WarnContext(r.Context(), "issue trigger access denied",
		slog.String("action", action), slog.String("user_id", c.UserID), slog.String("project_id", projectID),
		slog.String("reason", reason), slog.String("request_id", RequestIDFrom(r)))
}

func (h *issueTriggerHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "issue trigger store failure",
		slog.String("action", action), slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *issueTriggerHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
	h.log(r).WarnContext(r.Context(), "rejected request body",
		slog.String("path", r.URL.Path), slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
}

func (h *issueTriggerHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
