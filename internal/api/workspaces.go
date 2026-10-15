package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// Workspace routes: the read-only surface of ADR-0017's topology
// (docs/m3-contract.md § 2, api/openapi.yaml workspaces tag).
//
// Two rules shape every handler here:
//
//   - No paths. `root_path`, `checkout_path`, `mirror_path` and `admin_dir` are
//     worker-side topology; the browser-visible identity is `run_ref` and the
//     volume digest. A view type that grew a path field would turn the UI into
//     a map of the fleet's disks (09: no accidental worker-service surface).
//   - Rows, not shell-outs. The status route answers from `workspace_repos`,
//     the row the worker wrote at the unit boundary. `recorded_at` makes the
//     staleness explicit rather than implying the API watched the filesystem.

// WorkspaceStore is the datastore's workspace surface. Every method answers
// with ErrWorkspaceNotFound for a row outside the caller's project — the same
// 404 body a random uuid produces, so probing cannot distinguish "not yours"
// from "not there" (C15d's rule, applied to workspaces).
type WorkspaceStore interface {
	ListWorkspaces(ctx context.Context, c Caller, projectID string) ([]WorkspaceView, error)
	GetWorkspace(ctx context.Context, c Caller, workspaceID string) (WorkspaceView, error)
	// GetWorkspaceRepoStatus is the contributor-gated variant: the handler
	// checks the role on the returned view because the answer itself (what is
	// dirty in a checkout) is work-in-progress information.
	GetWorkspaceRepoStatus(ctx context.Context, c Caller, workspaceID, repositoryID string) (WorkspaceRepoStatusView, error)
}

// ErrWorkspaceNotFound is also "you may not know this exists".
var ErrWorkspaceNotFound = errors.New("api: workspace not found")

// WorkspaceRepoView is openapi's WorkspaceRepo.
type WorkspaceRepoView struct {
	RepositoryID  string   `json:"repository_id"`
	Name          string   `json:"name"`
	RunRef        string   `json:"run_ref"`
	BaseCommit    string   `json:"base_commit"`
	HeadCommit    *string  `json:"head_commit"`
	WorkspaceMode string   `json:"workspace_mode"`
	ModifiedPaths []string `json:"modified_paths"`
	ExcludedPaths []string `json:"excluded_paths"`
}

// WorkspaceView is openapi's Workspace. MyRole travels for the status route's
// gate and is never serialized.
type WorkspaceView struct {
	ID             string              `json:"id"`
	ProjectID      string              `json:"project_id"`
	ScopeKind      string              `json:"scope_kind"`
	ConversationID *string             `json:"conversation_id"`
	RunID          *string             `json:"run_id"`
	WorkerID       string              `json:"worker_id"`
	VolumeID       string              `json:"volume_id"`
	WorkspaceMode  string              `json:"workspace_mode"`
	State          string              `json:"state"`
	Repos          []WorkspaceRepoView `json:"repos"`
	CreatedAt      time.Time           `json:"created_at"`
	ReadyAt        *time.Time          `json:"ready_at"`
	ReleasedAt     *time.Time          `json:"released_at"`
	LostAt         *time.Time          `json:"lost_at"`
	// LostReason is the enum from workspace.recovery_lost's payload, read from
	// the journal rather than duplicated into the workspaces row: the event is
	// the record, and a second copy of it could disagree.
	LostReason *string `json:"lost_reason"`

	MyRole string `json:"-"`
}

// WorkspaceListView is openapi's WorkspaceList.
type WorkspaceListView struct {
	Workspaces []WorkspaceView `json:"workspaces"`
}

// WorkspaceRepoStatusView is openapi's WorkspaceRepoStatus.
type WorkspaceRepoStatusView struct {
	WorkspaceID   string   `json:"workspace_id"`
	RepositoryID  string   `json:"repository_id"`
	RunRef        string   `json:"run_ref"`
	BaseCommit    string   `json:"base_commit"`
	HeadCommit    *string  `json:"head_commit"`
	Dirty         bool     `json:"dirty"`
	ModifiedPaths []string `json:"modified_paths"`
	ExcludedPaths []string `json:"excluded_paths"`
	// RecordedAt is when the worker last wrote the row, so a stale answer says
	// so instead of reading as current.
	RecordedAt time.Time `json:"recorded_at"`

	MyRole string `json:"-"`
}

// RegisterWorkspaces mounts the three workspace routes.
func RegisterWorkspaces(s *Server, store WorkspaceStore) {
	h := &wsHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/workspaces", http.HandlerFunc(h.list))
	s.HandleAuthed("GET /api/v1/workspaces/{workspaceId}", http.HandlerFunc(h.get))
	s.HandleAuthed("GET /api/v1/workspaces/{workspaceId}/repos/{repositoryId}/status", http.HandlerFunc(h.status))
}

type wsHandlers struct {
	store WorkspaceStore
	srv   *Server
}

func (h *wsHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.fail(w, r, errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

func (h *wsHandlers) list(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.store.ListWorkspaces(r.Context(), c, r.PathValue("projectId"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if items == nil {
		items = []WorkspaceView{}
	}
	WriteJSON(w, http.StatusOK, WorkspaceListView{Workspaces: items})
}

func (h *wsHandlers) get(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	view, err := h.store.GetWorkspace(r.Context(), c, r.PathValue("workspaceId"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, view)
}

func (h *wsHandlers) status(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	view, err := h.store.GetWorkspaceRepoStatus(r.Context(), c, r.PathValue("workspaceId"), r.PathValue("repositoryId"))
	if errors.Is(err, ErrWorkspaceNotFound) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such workspace.")
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// Contributor or above: "what is dirty in the checkout" is
	// work-in-progress information (openapi getWorkspaceRepoStatus). A viewer
	// sees the workspace and its refs; the manifest is one role up.
	if !wsMaySeeStatus(c, view.MyRole) {
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"The modified-path manifest needs the contributor role.")
		return
	}
	WriteJSON(w, http.StatusOK, view)
}

func (h *wsHandlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrWorkspaceNotFound) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such workspace.")
		return
	}
	h.srv.logger.ErrorContext(r.Context(), "workspace store failure",
		slog.String("error", err.Error()), slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

// wsMaySeeStatus is the contributor gate, spelled against internal/authz's
// roles: an org admin with no membership row reaches everything in their
// organization (the same convention ADR-0014's role algebra uses).
func wsMaySeeStatus(c Caller, role string) bool {
	if c.IsOrgAdmin {
		return true
	}
	switch role {
	case "maintainer", "contributor":
		return true
	default:
		return false
	}
}
