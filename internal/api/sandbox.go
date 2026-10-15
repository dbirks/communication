package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
)

// Sandbox routes: the enforcement record of what a launched unit actually ran
// under (docs/m3-contract.md § 2, api/openapi.yaml sandbox tag).
//
// GET /api/v1/turns/{turnId}/sandbox is 12-test-strategy case 13's observable
// answer — "no process started, and you can see why" — assembled from the
// journal (sandbox.verified / sandbox.enforcement_failed), so reading it never
// reaches a worker.
//
// GET /api/v1/system/sandbox is the ops-page truth table: per worker, the
// backend/version/enforcement it registered with and whether it has *verified*
// — plus the pinned policy digest the deployment ships. No membership check,
// matching GET /api/v1/workers: an operator must be able to see that
// enforcement is missing before anyone trusts it.

// TurnSandboxStore reads one turn's enforcement record.
type TurnSandboxStore interface {
	// GetTurnSandbox resolves turn → conversation → project and applies the
	// viewer predicate in SQL; a turn outside the caller's project is
	// ErrTurnSandboxNotFound, byte-identical to one that never existed.
	GetTurnSandbox(ctx context.Context, c Caller, turnID string) (TurnSandboxView, error)
}

// SystemSandboxStore reads the fleet's registered sandbox state.
type SystemSandboxStore interface {
	ListWorkerSandbox(ctx context.Context) ([]WorkerSandboxStatusView, error)
	// Deployment returns the pinned backend version and the policy digest the
	// binary ships — read from code, not from a worker's report, so the fleet
	// view can disagree with a worker that registered something else.
	Deployment() (pinnedBackendVersion, policyDigest string)
}

// ErrTurnSandboxNotFound is "no such turn" and "not your turn" alike.
var ErrTurnSandboxNotFound = errors.New("api: turn sandbox not found")

// SandboxGrantView is openapi's SandboxGrant. Roles, never paths.
type SandboxGrantView struct {
	Role   string `json:"role"`
	Access string `json:"access"`
}

// TurnSandboxView is openapi's TurnSandbox.
type TurnSandboxView struct {
	TurnID          string             `json:"turn_id"`
	WorkspaceID     *string            `json:"workspace_id"`
	WorkerID        *string            `json:"worker_id"`
	Stage           string             `json:"stage"`
	Reason          *string            `json:"reason"`
	PolicyDigest    *string            `json:"policy_digest"`
	Backend         string             `json:"backend"`
	BackendVersion  *string            `json:"backend_version"`
	Enforcement     *string            `json:"enforcement"`
	Verified        bool               `json:"verified"`
	AfUnixMediation *string            `json:"af_unix_mediation"`
	NetworkEnforced bool               `json:"network_enforced"`
	ChildStarted    bool               `json:"child_started"`
	Grants          []SandboxGrantView `json:"grants"`
	CommitGranted   bool               `json:"commit_granted"`
	DeniedWhat      []string           `json:"denied_what"`
}

// WorkerSandboxStatusView is openapi's WorkerSandboxStatus.
type WorkerSandboxStatusView struct {
	WorkerID       string  `json:"worker_id"`
	Backend        string  `json:"backend"`
	BackendVersion *string `json:"backend_version"`
	Enforcement    string  `json:"enforcement"`
	Verified       bool    `json:"verified"`
	Volumes        []struct {
		RootKind string `json:"root_kind"`
		VolumeID string `json:"volume_id"`
	} `json:"volumes,omitempty"`
	Notes []string `json:"notes"`
}

// SystemSandboxView is openapi's SystemSandbox.
type SystemSandboxView struct {
	Workers              []WorkerSandboxStatusView `json:"workers"`
	PinnedBackendVersion string                    `json:"pinned_backend_version"`
	PolicyDigest         string                    `json:"policy_digest"`
}

// RegisterSandbox mounts the two sandbox routes.
func RegisterSandbox(s *Server, turns TurnSandboxStore, system SystemSandboxStore) {
	h := &sbxHandlers{turns: turns, fleet: system, srv: s}
	s.HandleAuthed("GET /api/v1/turns/{turnId}/sandbox", http.HandlerFunc(h.turn))
	s.HandleAuthed("GET /api/v1/system/sandbox", http.HandlerFunc(h.fleetRoute))
}

type sbxHandlers struct {
	turns TurnSandboxStore
	fleet SystemSandboxStore
	srv   *Server
}

func (h *sbxHandlers) turn(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.fail(w, r, errors.New("api: no principal in context"))
		return
	}
	c := Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}
	view, err := h.turns.GetTurnSandbox(r.Context(), c, r.PathValue("turnId"))
	if errors.Is(err, ErrTurnSandboxNotFound) {
		// One body for both refusals; the difference is not the caller's to
		// learn (C15d's rule again).
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such turn.")
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if view.Grants == nil {
		view.Grants = []SandboxGrantView{}
	}
	if view.DeniedWhat == nil {
		view.DeniedWhat = []string{}
	}
	WriteJSON(w, http.StatusOK, view)
}

func (h *sbxHandlers) fleetRoute(w http.ResponseWriter, r *http.Request) {
	workers, err := h.fleet.ListWorkerSandbox(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if workers == nil {
		workers = []WorkerSandboxStatusView{}
	}
	pinned, digest := h.fleet.Deployment()
	WriteJSON(w, http.StatusOK, SystemSandboxView{
		Workers: workers, PinnedBackendVersion: pinned, PolicyDigest: digest,
	})
}

func (h *sbxHandlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	h.srv.logger.ErrorContext(r.Context(), "sandbox store failure",
		slog.String("error", err.Error()), slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}
