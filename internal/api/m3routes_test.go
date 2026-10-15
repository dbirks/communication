package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Handler-level tests for the routes M3 adds to the read surface
// (docs/m3-contract.md § 2): the three workspace routes and the two sandbox
// routes. What is under test is the *handler contract* — status mapping, the
// contributor gate on the manifest, and the shape rules the openapi document
// pins (empty arrays serialize as [], never null; the internal MyRole never
// reaches the body). The store predicates behind these interfaces are tested
// against a real PostgreSQL in internal/store/postgres.

type fakeWorkspaceStore struct {
	items   []WorkspaceView
	status  WorkspaceRepoStatusView
	statusC error
	lastC   Caller
}

func (f *fakeWorkspaceStore) ListWorkspaces(_ context.Context, c Caller, _ string) ([]WorkspaceView, error) {
	f.lastC = c
	return f.items, nil
}

func (f *fakeWorkspaceStore) GetWorkspace(_ context.Context, _ Caller, id string) (WorkspaceView, error) {
	for _, w := range f.items {
		if w.ID == id {
			return w, nil
		}
	}
	return WorkspaceView{}, ErrWorkspaceNotFound
}

func (f *fakeWorkspaceStore) GetWorkspaceRepoStatus(_ context.Context, _ Caller, _, _ string) (WorkspaceRepoStatusView, error) {
	if f.statusC != nil {
		return WorkspaceRepoStatusView{}, f.statusC
	}
	return f.status, nil
}

func wsTestServer(t *testing.T, store WorkspaceStore, p *Principal) *Server {
	t.Helper()
	s := newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(p, nil))
	RegisterWorkspaces(s, store)
	return s
}

func TestWorkspaceListAndGetMapping(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	id := "11111111-1111-4111-8111-111111111111"
	store := &fakeWorkspaceStore{items: []WorkspaceView{{
		ID: id, ProjectID: "p-1", ScopeKind: "conversation", WorkerID: "w-1",
		VolumeID: "sha256:" + strings.Repeat("a", 64), WorkspaceMode: "worktree",
		State: "ready", CreatedAt: now, MyRole: "viewer",
	}}}
	s := wsTestServer(t, store, testPrincipal())

	rec := do(t, s.handler, request(http.MethodGet, "http://localhost:8080/api/v1/projects/p-1/workspaces", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body %s", rec.Code, rec.Body)
	}
	var list WorkspaceListView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(list.Workspaces) != 1 || list.Workspaces[0].ID != id {
		t.Fatalf("list body = %s", rec.Body)
	}
	// The envelope keys are public contract; the role is not.
	if strings.Contains(rec.Body.String(), "my_role") || strings.Contains(rec.Body.String(), "MyRole") {
		t.Errorf("role leaked into the workspace body: %s", rec.Body)
	}
	// No path column may exist anywhere in the workspace views — the whole
	// point of the view types (09: no accidental worker-service surface).
	for _, banned := range []string{"root_path", "checkout_path", "mirror_path", "admin_dir", "agent_root"} {
		if strings.Contains(rec.Body.String(), banned) {
			t.Errorf("workspace body carries %q", banned)
		}
	}

	rec = do(t, s.handler, request(http.MethodGet, "http://localhost:8080/api/v1/workspaces/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d", rec.Code)
	}
	rec = do(t, s.handler, request(http.MethodGet, "http://localhost:8080/api/v1/workspaces/nonexistent", nil))
	if rec.Code != http.StatusNotFound || decodeProblem(t, rec).Title != "Not Found" {
		t.Fatalf("unknown workspace = %d %s", rec.Code, rec.Body)
	}
}

func TestWorkspaceRepoStatusContributorGate(t *testing.T) {
	base := WorkspaceRepoStatusView{
		WorkspaceID: "ws-1", RepositoryID: "r-1", RunRef: "run/repo",
		BaseCommit: "abc", Dirty: true, ModifiedPaths: []string{"a.go"},
		ExcludedPaths: []string{".env"}, RecordedAt: time.Now().UTC(),
	}
	for _, tc := range []struct {
		role   string
		admin  bool
		want   int
		reason string
	}{
		{role: "viewer", want: http.StatusForbidden, reason: "viewer may not read the manifest"},
		{role: "contributor", want: http.StatusOK, reason: "contributor may"},
		{role: "maintainer", want: http.StatusOK, reason: "maintainer may"},
		{role: "", admin: true, want: http.StatusOK, reason: "org admin reaches everything in the org"},
	} {
		store := &fakeWorkspaceStore{status: base}
		store.status.MyRole = tc.role
		p := testPrincipal()
		p.IsOrgAdmin = tc.admin
		s := wsTestServer(t, store, p)
		rec := do(t, s.handler, request(http.MethodGet,
			"http://localhost:8080/api/v1/workspaces/ws-1/repos/r-1/status", nil))
		if rec.Code != tc.want {
			t.Errorf("%s: status = %d body %s", tc.reason, rec.Code, rec.Body)
		}
	}
	// The same 404 body for "not yours" and "not there" — the probe-resistance
	// rule, asserted once at the handler boundary.
	store := &fakeWorkspaceStore{statusC: ErrWorkspaceNotFound}
	s := wsTestServer(t, store, testPrincipal())
	rec := do(t, s.handler, request(http.MethodGet,
		"http://localhost:8080/api/v1/workspaces/ws-1/repos/r-1/status", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("not-found status = %d", rec.Code)
	}
}

type fakeTurnSandboxStore struct {
	view TurnSandboxView
	err  error
}

func (f fakeTurnSandboxStore) GetTurnSandbox(context.Context, Caller, string) (TurnSandboxView, error) {
	return f.view, f.err
}

type fakeSystemSandbox struct{}

func (fakeSystemSandbox) ListWorkerSandbox(context.Context) ([]WorkerSandboxStatusView, error) {
	return []WorkerSandboxStatusView{{
		WorkerID: "w-1", Backend: "nono", Enforcement: "required", Verified: true,
	}}, nil
}

func (fakeSystemSandbox) Deployment() (string, string) {
	return "0.80.0", "sha256:" + strings.Repeat("b", 64)
}

func TestSandboxRoutes(t *testing.T) {
	s := newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterSandbox(s,
		fakeTurnSandboxStore{view: TurnSandboxView{
			TurnID: "t-1", Stage: "launched", Backend: "nono", Verified: true,
			Grants: []SandboxGrantView{{Role: "workspace", Access: "rw"}},
		}},
		fakeSystemSandbox{})

	rec := do(t, s.handler, request(http.MethodGet, "http://localhost:8080/api/v1/turns/t-1/sandbox", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("turn sandbox = %d %s", rec.Code, rec.Body)
	}
	// denied_what is [] never null: openapi pins the array shape.
	if !strings.Contains(rec.Body.String(), `"denied_what":[]`) {
		t.Errorf("body = %s, want denied_what as empty array", rec.Body)
	}
	// Grants are roles, never host paths (ADR-0019 D4's wire rule).
	if strings.Contains(rec.Body.String(), "/workspaces") || strings.Contains(rec.Body.String(), "path") {
		t.Errorf("grant body carries a path: %s", rec.Body)
	}

	rec = do(t, s.handler, request(http.MethodGet, "http://localhost:8080/api/v1/system/sandbox", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("system sandbox = %d %s", rec.Code, rec.Body)
	}
	var sys SystemSandboxView
	if err := json.Unmarshal(rec.Body.Bytes(), &sys); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if sys.PinnedBackendVersion != "0.80.0" || len(sys.Workers) != 1 {
		t.Errorf("system body = %s", rec.Body)
	}

	// Unknown and forbidden turns answer identically.
	s2 := newTestServer(t, nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterSandbox(s2, fakeTurnSandboxStore{err: ErrTurnSandboxNotFound}, fakeSystemSandbox{})
	rec = do(t, s2.handler, request(http.MethodGet, "http://localhost:8080/api/v1/turns/nope/sandbox", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing turn sandbox = %d", rec.Code)
	}
}
