package api

// The schedule surface (ADR-0032 part 2): "when to run" for a project's
// pipeline assignments. Mounted beside the assignment routes in serveStack.
//
// The permission shape is the assignment's, because a schedule IS an
// assignment property: reading is viewer+, creating/editing is maintainer+
// (01-domain-model's assignment ACL). A schedule in another project — or a
// schedule id that is not yours to see — answers the same 404 a random uuid
// does; the predicate lives in the store adapter's SQL, not here.
//
// The one piece of validation this layer owns outright is the cron
// expression: a mis-authored calendar is named on the request that submits
// it (422 invalid_cron, field "cron_expr"), using the same parser the tick
// will use — the handler cannot accept an expression the firer rejects.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/pipelines/schedule"
)

// Sentinels the store adapter maps its own misses onto (house style: the
// adapter, not the handler, translates database facts into HTTP facts).
var (
	// ErrScheduleNotFound covers a missing id AND a schedule whose project the
	// caller may not see — one answer, never a peek (ADR-0014 §3).
	ErrScheduleNotFound = errors.New("api: schedule not found")
	// ErrScheduleStaleVersion is the optimistic-concurrency miss: somebody
	// else edited the row. 409; the client re-reads and replays.
	ErrScheduleStaleVersion = errors.New("api: schedule version is stale")
	// ErrScheduleNotFireable refuses a schedule whose assignment can never
	// fire (disabled, or pinned to an unpublished revision). The ADR's
	// reasoning: "the schedule is broken" must beat "the schedule silently
	// never ran", so the create says no out loud.
	ErrScheduleNotFireable = errors.New("api: schedule assignment cannot fire")
)

// Problem codes this surface emits (422s; the 409s travel as codes too).
const (
	ScheduleCodeCronInvalid   = "invalid_cron"
	ScheduleCodeInputsInvalid = "invalid_inputs"
	ScheduleCodeNotFireable   = "assignment_not_fireable"
	ScheduleCodeVersionStale  = "schedule_version_stale"
	ScheduleCodePatchEmpty    = "empty_patch"
	ScheduleCodeFieldRequired = "field_required"
)

// ScheduleView is one schedules row as the API presents it. next_run_at is
// always set (the row's CHECK guarantees a derived clock); the last_run pair
// is null until the first fire, and null here means "never fired" — not
// "unknown".
type ScheduleView struct {
	ID           string          `json:"id"`
	ProjectID    string          `json:"project_id"`
	AssignmentID string          `json:"assignment_id"`
	CronExpr     string          `json:"cron_expr"`
	Inputs       json.RawMessage `json:"inputs"`
	Enabled      bool            `json:"enabled"`
	NextRunAt    time.Time       `json:"next_run_at"`
	LastRunAt    *time.Time      `json:"last_run_at"`
	LastRunID    *string         `json:"last_run_id,omitempty"`
	Version      int             `json:"version"`
	CreatedBy    string          `json:"created_by"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	MyRole       string          `json:"my_role,omitempty"`
}

// ScheduleListView is GET /projects/{id}/schedules' envelope.
type ScheduleListView struct {
	Schedules []ScheduleView `json:"schedules"`
}

// ScheduleCreateInput is POST /projects/{id}/schedules' body (the handler
// reads it from JSON; enabled defaults to true when absent).
type ScheduleCreateInput struct {
	AssignmentID string          `json:"assignment_id"`
	CronExpr     string          `json:"cron_expr"`
	Inputs       json.RawMessage `json:"inputs"`
	Enabled      *bool           `json:"enabled"`
}

// SchedulePatchInput is PATCH /schedules/{id}'s body. Version is the caller's
// read of the row (optimistic concurrency); the three members are nil ⇒
// unchanged and at least one must be present.
type SchedulePatchInput struct {
	Version  int              `json:"version"`
	CronExpr *string          `json:"cron_expr"`
	Inputs   *json.RawMessage `json:"inputs"`
	Enabled  *bool            `json:"enabled"`
}

// ScheduleStore is what the handlers need from the datastore. Every method
// carries the caller so the permission predicate can stay part of the SQL
// (m4api.go's rule); a row outside the caller's view is the not-found
// sentinel, never a shorter answer.
type ScheduleStore interface {
	ListProjectSchedules(ctx context.Context, c Caller, projectID string) ([]ScheduleView, error)
	CreateSchedule(ctx context.Context, c Caller, projectID string, in ScheduleCreateInput) (ScheduleView, error)
	GetSchedule(ctx context.Context, c Caller, scheduleID string) (ScheduleView, error)
	UpdateSchedule(ctx context.Context, c Caller, scheduleID string, in SchedulePatchInput) (ScheduleView, error)
}

// RegisterSchedules mounts the three ADR-0032 routes beside the assignment
// routes of RegisterRuns.
func RegisterSchedules(s *Server, store ScheduleStore, projects ProjectStore) {
	h := &scheduleHandlers{store: store, projects: projects, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/schedules", http.HandlerFunc(h.listSchedules))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/schedules", http.HandlerFunc(h.createSchedule))
	s.HandleAuthed("PATCH /api/v1/schedules/{scheduleId}", http.HandlerFunc(h.patchSchedule))
}

type scheduleHandlers struct {
	store    ScheduleStore
	projects ProjectStore
	srv      *Server
}

// --- handlers -----------------------------------------------------------

func (h *scheduleHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireRole gates a project-scoped schedule route on the one ProjectStore
// read, the way runs.go's requireProjectRole does: invisible project → 404
// (audited there), visible-but-under-ranked → audited 403.
func (h *scheduleHandlers) requireRole(w http.ResponseWriter, r *http.Request, c Caller,
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

func (h *scheduleHandlers) listSchedules(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireRole(w, r, c, projectID, "schedule.list", false) {
		return
	}
	items, err := h.store.ListProjectSchedules(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "schedule.list", err)
		return
	}
	if items == nil {
		items = []ScheduleView{}
	}
	WriteJSON(w, http.StatusOK, ScheduleListView{Schedules: items})
}

func (h *scheduleHandlers) createSchedule(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if !h.requireRole(w, r, c, projectID, "schedule.create", true) {
		return
	}
	var body ScheduleCreateInput
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !validUUID(body.AssignmentID) {
		schedProblem(w, ScheduleCodeFieldRequired, "assignment_id",
			"assignment_id must be the uuid of one of this project's pipeline assignments.")
		return
	}
	if _, err := schedule.Parse(body.CronExpr); err != nil {
		schedProblem(w, ScheduleCodeCronInvalid, "cron_expr",
			"cron_expr must be a 5-field cron expression (minute hour day-of-month month day-of-week), UTC: "+err.Error())
		return
	}
	if err := schedCheckInputsShape(body.Inputs); err != nil {
		schedProblem(w, ScheduleCodeInputsInvalid, "inputs", err.Error())
		return
	}
	item, err := h.store.CreateSchedule(r.Context(), c, projectID, body)
	if err != nil {
		h.fail(w, r, c, projectID, "schedule.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, item)
}

func (h *scheduleHandlers) patchSchedule(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	scheduleID := r.PathValue("scheduleId")
	if !validUUID(scheduleID) {
		h.denied(w, r, c, scheduleID, "schedule.update", "malformed schedule id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such schedule.")
		return
	}
	current, err := h.store.GetSchedule(r.Context(), c, scheduleID)
	if err != nil {
		h.fail(w, r, c, scheduleID, "schedule.update", err)
		return
	}
	// The write gate is the assignment's: maintainer-or-admin of the owning
	// project (01). MyRole rode back on the read the adapter just made.
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(current.MyRole)) {
		h.denied(w, r, c, current.ProjectID, "schedule.update", "project role is not maintainer")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Editing a schedule requires a maintainer role on the owning project.")
		return
	}
	var body SchedulePatchInput
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Version < 1 {
		schedProblem(w, ScheduleCodeFieldRequired, "version",
			"version is required: the version you read, for optimistic concurrency.")
		return
	}
	if body.CronExpr == nil && body.Inputs == nil && body.Enabled == nil {
		schedProblem(w, ScheduleCodePatchEmpty, "",
			"At least one of cron_expr, inputs or enabled is required.")
		return
	}
	if body.CronExpr != nil {
		if _, err := schedule.Parse(*body.CronExpr); err != nil {
			schedProblem(w, ScheduleCodeCronInvalid, "cron_expr",
				"cron_expr must be a 5-field cron expression (minute hour day-of-month month day-of-week), UTC: "+err.Error())
			return
		}
	}
	if body.Inputs != nil {
		if err := schedCheckInputsShape(*body.Inputs); err != nil {
			schedProblem(w, ScheduleCodeInputsInvalid, "inputs", err.Error())
			return
		}
	}
	item, err := h.store.UpdateSchedule(r.Context(), c, scheduleID, body)
	if err != nil {
		h.fail(w, r, c, scheduleID, "schedule.update", err)
		return
	}
	WriteJSON(w, http.StatusOK, item)
}

// --- shared plumbing ----------------------------------------------------

// schedProblem writes the family's 422: a Problem document plus the stable
// `code` member (the m4WriteTypedProblem envelope, so a client switches on
// `code`/`type` rather than prose). `field`, when set, rides as the `field`
// member naming the request member to fix.
func schedProblem(w http.ResponseWriter, code, field, detail string) {
	if field != "" {
		m4WriteTypedProblemExtra(w, http.StatusUnprocessableEntity, code, "Validation Failed", detail,
			struct {
				Field string `json:"field"`
			}{Field: field})
		return
	}
	m4WriteTypedProblem(w, http.StatusUnprocessableEntity, code, "Validation Failed", detail)
}

// schedCheckInputsShape is the handler-side half of the inputs rule: a JSON
// object (or absent). What the KEYS and VALUES may be is the pinned
// revision's input schema, and only the store can answer that — this check
// exists so a string body is a named 422 rather than a database error.
func schedCheckInputsShape(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return errors.New("inputs must be a JSON object of run input names to values")
	}
	return nil
}

// fail maps a schedule store error onto the HTTP contract: 404 (never a
// peek), 409 named codes for the stale-version and cannot-fire races, the
// pinned-revision 422, and 500 for everything else.
func (h *scheduleHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action string, err error) {
	var invalid *RunInputsInvalid
	if errors.As(err, &invalid) {
		m4WriteValidateProblem(w, invalid)
		return
	}
	switch {
	case errors.Is(err, ErrScheduleNotFound):
		h.denied(w, r, c, resourceID, action, "no such schedule, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such schedule.")
	case errors.Is(err, ErrProjectNotFound):
		// The project gate's own answer (ADR-0014 § 3): a non-member sees the
		// same 404 as an unknown project, never the 500 an unmapped store
		// error would produce here.
		h.denied(w, r, c, resourceID, action, "no such project, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
	case errors.Is(err, ErrScheduleStaleVersion):
		m4WriteTypedProblem(w, http.StatusConflict, ScheduleCodeVersionStale,
			"Schedule Version Stale",
			"The schedule changed since you read it; re-read and replay your edit against the current version.")
	case errors.Is(err, ErrScheduleNotFireable):
		m4WriteTypedProblem(w, http.StatusConflict, ScheduleCodeNotFireable,
			"Assignment Cannot Fire",
			"The assignment behind this schedule is disabled or pinned to an unpublished revision; fix the assignment before scheduling it.")
	default:
		h.serverError(w, r, resourceID, action, err)
	}
}

// denied writes the audit row (through the project store, the schedule
// family's owner of a project for every route here) and the warn log.
func (h *scheduleHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, reason string) {
	if h.projects != nil {
		if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
			h.log(r).ErrorContext(r.Context(), "could not write audit denial",
				slog.String("action", action), slog.String("project_id", projectID),
				slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
			return
		}
	}
	h.log(r).WarnContext(r.Context(), "schedule access denied",
		slog.String("action", action), slog.String("user_id", c.UserID),
		slog.String("project_id", projectID), slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *scheduleHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "schedule store failure",
		slog.String("action", action), slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *scheduleHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
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

func (h *scheduleHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
