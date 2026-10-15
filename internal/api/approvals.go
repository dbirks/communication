package api

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
)

// The M4 approval surface: durable pipeline gates (docs/m4-contract.md
// § 2.1 routes 34–36, ADR-0023 § 9). These are NOT M2's ACP permission
// prompts (`permission_requests`): different table, different authorizer,
// different CAS. A gate holds no worker and no lease — while it is pending
// there is no attempt behind it (§ 5.3, 12 case 9's C9a).
//
// The decision route carries the milestone's sharpest rule: **authorization
// is evaluated at decision time, not at gate creation**. The handler hands
// the store an authorize callback (the same shape runtime's
// Decide/AuthorizeFunc takes) which re-reads the caller's CURRENT project
// role inside the store's transaction; a decider who lost access gets a
// refusal plus `approval.denied`, and the gate stays pending — a refusal is
// never a decision, and a stale grant cannot decide anything (12 case 9c).

// Approval-conflict kinds: the § 3 row-29 reason enum plus the CAS arm.
const (
	ApprovalDeniedLostAccess     = "approver_lost_access"
	ApprovalDeniedNotDesignated  = "not_a_designated_approver"
	ApprovalDeniedAlreadyDecided = "already_decided"
	ApprovalDeniedRunTerminal    = "run_terminal"
)

// ApprovalConflictError is a refused decision. For the already-decided/CAS
// arm the winner rides along (state, decision, decider, version) so the
// loser renders the truth instead of guessing (12 case 9d); for the denial
// arms the gate stays pending and only the reason is reported.
type ApprovalConflictError struct {
	Kind       string // one of the ApprovalDenied* kinds
	Detail     string
	ApprovalID string
	State      string
	Decision   string
	DecidedBy  string
	Version    int
}

func (e *ApprovalConflictError) Error() string {
	return fmt.Sprintf("api: approval conflict (%s): %s", e.Kind, e.Detail)
}

// Errors the approval handlers understand.
var (
	// ErrApprovalNotFound is also "you may not know this gate exists".
	ErrApprovalNotFound = errors.New("api: approval not found")
)

// ApproverAuthorize is the decision-time authorization callback handed to
// the store: the adapter evaluates it INSIDE the gate's transaction (the
// runtime Decide/AuthorizeFunc shape), so the grant checked is the grant
// that exists at commit time. ok=false must name a § 3 reason.
type ApproverAuthorize func(ap ApprovalView, decider string) (ok bool, reason string)

// ApprovalStore is the gate ledger's API face. Reads enforce the caller's
// project visibility themselves (a gate of an invisible project answers
// ErrApprovalNotFound); DecideApproval appends approval.decided (or
// approval.denied) in the same transaction as the CAS write.
type ApprovalStore interface {
	// ListProjectApprovals returns pending gates first ordered by
	// deadline_at (the urgent one is the one about to expire), then decided
	// history newest first — the UI's "needs attention" list.
	ListProjectApprovals(ctx context.Context, c Caller, projectID string) ([]ApprovalView, error)
	GetApproval(ctx context.Context, c Caller, approvalID string) (ApprovalView, error)
	// DecideApproval CAS-decides a pending gate: it loads the row, calls
	// authorize with the CURRENT membership state, refuses without touching
	// the gate on ok=false (approval.denied is journaled, the gate stays
	// pending), and on a CAS miss or a decided gate answers a
	// *ApprovalConflictError carrying the winner. A gate whose run went
	// terminal is the run_terminal arm.
	DecideApproval(ctx context.Context, c Caller, approvalID, decision, comments string,
		version int, authorize ApproverAuthorize) (ApprovalView, error)
	RecordDenied(ctx context.Context, c Caller, approvalID, action string) error
}

// ApprovalView is the Approval schema: a durable pipeline gate. The full
// summary text lives HERE and only here — the journal carries its digest,
// because a gate summary may embed another node's output and the journal is
// readable by every project member (12 C11's vector).
type ApprovalView struct {
	ID              string          `json:"id"`
	ProjectID       string          `json:"project_id"`
	RunID           string          `json:"run_id"`
	NodeExecutionID string          `json:"node_execution_id"`
	NodeInstanceKey *string         `json:"node_instance_key"`
	Kind            string          `json:"kind"`
	Summary         string          `json:"summary"`
	ArtifactRefs    json.RawMessage `json:"artifact_refs"`
	ApproverRoles   []string        `json:"approver_roles"`
	ApproverUserIDs []string        `json:"approver_user_ids"`
	DeadlineAt      time.Time       `json:"deadline_at"`
	OnTimeout       string          `json:"on_timeout"`
	ReRequested     bool            `json:"re_requested"`
	State           string          `json:"state"`
	Decision        *string         `json:"decision"`
	Comments        *string         `json:"comments"`
	DecidedBy       *string         `json:"decided_by"`
	DecidedAt       *time.Time      `json:"decided_at"`
	Version         int             `json:"version"`
	CreatedAt       time.Time       `json:"created_at"`

	MyRole string `json:"-"`
}

// ApprovalListView is the ApprovalList envelope.
type ApprovalListView struct {
	Approvals []ApprovalView `json:"approvals"`
}

// apDecideBody is ApprovalDecide.
type apDecideBody struct {
	Decision string `json:"decision"`
	Comments string `json:"comments,omitempty"`
	Version  int    `json:"version"`
}

// RegisterApprovals mounts routes 34–36. projects backs the decision-time
// role read; trigger nudges the advancer so the run leaves waiting_human
// (the response itself only proves the decision — the run moves through
// the advancer, not in this handler).
func RegisterApprovals(s *Server, store ApprovalStore, projects ProjectStore, trigger M4Trigger) {
	h := &apHandlers{store: store, projects: projects, trigger: trigger, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/approvals", http.HandlerFunc(h.list))
	s.HandleAuthed("GET /api/v1/approvals/{approvalId}", http.HandlerFunc(h.get))
	s.HandleAuthed("POST /api/v1/approvals/{approvalId}/decide", http.HandlerFunc(h.decide))
}

type apHandlers struct {
	store    ApprovalStore
	projects ProjectStore
	trigger  M4Trigger
	srv      *Server
}

func (h *apHandlers) list(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if _, err := h.projects.GetProject(r.Context(), c, projectID); err != nil {
		h.prjFail(w, r, c, projectID, "approval.list", err)
		return
	}
	items, err := h.store.ListProjectApprovals(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "approval.list", err)
		return
	}
	if items == nil {
		items = []ApprovalView{}
	}
	for i := range items {
		items[i] = normalizeApprovalView(items[i])
	}
	WriteJSON(w, http.StatusOK, ApprovalListView{Approvals: items})
}

func (h *apHandlers) get(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	ap, err := h.store.GetApproval(r.Context(), c, approvalID)
	if err != nil {
		h.fail(w, r, c, approvalID, "approval.get", err)
		return
	}
	if !authz.CanView(c.IsOrgAdmin, authz.Role(ap.MyRole)) {
		// The store predicate should have refused first; belt and braces,
		// and the answer is the uniform 404 (a gate of a project the
		// caller cannot see is not a 403-shaped existence claim).
		h.denied(w, r, c, approvalID, "approval.get", "gate is not visible to the caller")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such approval.")
		return
	}
	WriteJSON(w, http.StatusOK, normalizeApprovalView(ap))
}

// decide is route 36. The two rules of 12 case 9, in handler order:
//
//  1. Authorization NOW. The callback handed to the store re-reads the
//     caller's membership in the gate's project at evaluation time — a
//     decider removed between gate-open and decide gets 403
//     (approval.denied, approver_lost_access) and the gate stays pending,
//     version unmoved. Being a member is not enough: the caller must be
//     named in approver_user_ids or hold one of the approver_roles in THIS
//     project (designated approvers only; an org admin is not exempt —
//     `01`'s matrix says so in words).
//  2. Exactly one decision. A CAS miss or an already-decided gate is 409
//     approval_already_decided carrying the winner's decision/decider/
//     version.
//
// A REJECTION is a business outcome, not an execution failure: it decides
// the gate normally (200); the node lands succeeded with
// outputs.decision=rejected and downstream expressions read it. Only a
// timeout is the execution-side arm, and that is the reconciler's, not
// this route's. comments never enters the journal (approval.decided says
// comments_present), which is why the 8 KiB bound is checked before the
// store — over the DB CHECK for a cleaner problem.
func (h *apHandlers) decide(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	var body apDecideBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Decision != "approved" && body.Decision != "rejected" {
		rnInvalid(w, "decision must be approved or rejected.")
		return
	}
	if len(body.Comments) > 8192 {
		rnInvalid(w, "comments must be at most 8192 bytes.")
		return
	}
	if body.Version < 1 {
		rnInvalid(w, "version must be at least 1.")
		return
	}

	authorize := func(ap ApprovalView, decider string) (bool, string) {
		// Decision time: the current role is re-read here, inside the
		// store's transaction, never carried in from an earlier request.
		role := h.currentRole(r.Context(), c, ap.ProjectID)
		if role == "" {
			return false, ApprovalDeniedLostAccess
		}
		return apMayDecide(ap, decider, role)
	}

	ap, err := h.store.DecideApproval(r.Context(), c, approvalID, body.Decision, body.Comments,
		body.Version, authorize)
	if err != nil {
		h.fail(w, r, c, approvalID, "approval.decide", err)
		return
	}
	if h.trigger != nil {
		h.trigger(r.Context(), ap.RunID)
	}
	WriteJSON(w, http.StatusOK, normalizeApprovalView(ap))
}

// apMayDecide is the designated-approver rule: named in approver_user_ids,
// or holding one of the approver_roles in the gate's project right now.
// An organization admin is deliberately NOT exempt (`01` "Approve human
// gates: only designated approvers", and a role-based bypass would make the
// role list a suggestion).
func apMayDecide(ap ApprovalView, decider, role string) (bool, string) {
	for _, uid := range ap.ApproverUserIDs {
		if uid == decider {
			return true, ""
		}
	}
	for _, want := range ap.ApproverRoles {
		if want == role {
			return true, ""
		}
	}
	return false, ApprovalDeniedNotDesignated
}

// currentRole is the decision-time membership read; a caller who can no
// longer see the project has no role at all (the empty string), which the
// authorize callback turns into approver_lost_access. A store failure is
// NOT silently "no role" in the denial sense — the store's own load of the
// gate happens first, so by the time this runs the project was reachable;
// a mid-flight failure still fails closed (no role ⇒ refusal), because an
// undecided gate is a safe state and a wrongly-decided one is not.
func (h *apHandlers) currentRole(ctx context.Context, c Caller, projectID string) string {
	project, err := h.projects.GetProject(ctx, c, projectID)
	if err != nil {
		return ""
	}
	return project.MyRole
}

// --- error mapping ------------------------------------------------------------

// fail maps an approval-store error onto the HTTP contract.
func (h *apHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action string, err error) {
	var conflict *ApprovalConflictError
	if errors.As(err, &conflict) {
		if conflict.ApprovalID == "" {
			conflict.ApprovalID = resourceID
		}
		switch conflict.Kind {
		case ApprovalDeniedAlreadyDecided:
			h.denied(w, r, c, resourceID, action, conflict.Kind)
			m4WriteApprovalConflict(w, conflict)
		case ApprovalDeniedRunTerminal:
			// 409 with approval.denied (route 36's text): the gate can no
			// longer be decided because its run ended.
			h.denied(w, r, c, resourceID, action, conflict.Kind)
			m4WriteTypedProblem(w, http.StatusConflict, "approval-denied",
				"Approval Denied", approvalDeniedDetail(conflict))
		default:
			// A refusal (lost access / not designated) is 403 — the gate
			// stays pending, and the caller is authenticated but not the
			// approver (C9b/C9c). approval.denied is journaled store-side.
			h.denied(w, r, c, resourceID, action, conflict.Kind)
			m4WriteTypedProblem(w, http.StatusForbidden, "approval-denied",
				"Approval Denied", approvalDeniedDetail(conflict))
		}
		return
	}
	switch {
	case errors.Is(err, ErrApprovalNotFound), errors.Is(err, ErrRunNotFound):
		h.denied(w, r, c, resourceID, action, "no such gate, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such approval.")
	default:
		h.serverError(w, r, resourceID, action, err)
	}
}

func approvalDeniedDetail(conflict *ApprovalConflictError) string {
	if conflict.Detail != "" {
		return conflict.Detail
	}
	return "The decision was refused (" + conflict.Kind + "); the gate keeps waiting — a refusal is not a decision."
}

// prjFail handles the project-gate arm (the list route's projectId is a
// caller path value, so denial audits go through the project store).
func (h *apHandlers) prjFail(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string, err error) {
	if errors.Is(err, ErrProjectNotFound) {
		h.prjDenied(w, r, c, projectID, action)
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
		return
	}
	h.serverError(w, r, projectID, action, err)
}

func (h *apHandlers) prjDenied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string) {
	if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action), slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
	}
}

func (h *apHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, approvalID, action, reason string) {
	if err := h.store.RecordDenied(r.Context(), c, approvalID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action), slog.String("approval_id", approvalID),
			slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "approval access denied",
		slog.String("action", action), slog.String("user_id", c.UserID),
		slog.String("approval_id", approvalID), slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *apHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "approval store failure",
		slog.String("action", action), slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)), slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *apHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
}

func (h *apHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

func (h *apHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func normalizeApprovalView(v ApprovalView) ApprovalView {
	v.ArtifactRefs = m4OrEmptyJSONArray(v.ArtifactRefs)
	if v.ApproverRoles == nil {
		v.ApproverRoles = []string{}
	}
	if v.ApproverUserIDs == nil {
		v.ApproverUserIDs = []string{}
	}
	return v
}

// m4WriteApprovalConflict renders ApprovalConflictProblem: a Problem plus
// the winner as the loser must render it (state, decision, decider,
// version) — 12 case 9d: exactly one 200 and both callers see one truth.
func m4WriteApprovalConflict(w http.ResponseWriter, conflict *ApprovalConflictError) {
	detail := conflict.Detail
	if detail == "" {
		detail = "The gate is already decided; the body carries the winner."
	}
	extra := struct {
		ApprovalID string `json:"approval_id"`
		Approval   struct {
			State     string  `json:"state"`
			Decision  *string `json:"decision"`
			DecidedBy *string `json:"decided_by"`
			Version   int     `json:"version"`
		} `json:"approval"`
	}{ApprovalID: conflict.ApprovalID}
	extra.Approval.State = conflict.State
	extra.Approval.Version = conflict.Version
	if conflict.Decision != "" {
		d := conflict.Decision
		extra.Approval.Decision = &d
	}
	if conflict.DecidedBy != "" {
		d := conflict.DecidedBy
		extra.Approval.DecidedBy = &d
	}
	m4WriteTypedProblemExtra(w, http.StatusConflict, "approval-already-decided",
		"Approval Already Decided", detail, extra)
}
