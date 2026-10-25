package api

// The ADR-0056 part-2 issue-trigger routes, against a fake store. What this
// file pins is the HTTP surface: the role gates, the named problem codes (the
// bad-event and label-bounds refusals are shape refusals a fire cannot
// re-derive), the not-a-GitHub-repository 422, and that the store is never
// reached for a request the handler can refuse.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

const (
	itProjectID = "11111111-1111-4111-8111-111111111111"
	itAssignID  = "22222222-2222-4222-8222-222222222222"
	itRepoID    = "44444444-4444-4444-8444-444444444444"
	itTriggerID = "33333333-3333-4333-8333-333333333333"
	itUser      = "44444444-4444-4444-8444-444444444444"
)

// --- fakes ---------------------------------------------------------------

type itProjects struct {
	role    string
	denials []string
}

func (p *itProjects) GetProject(_ context.Context, _ Caller, projectID string) (ProjectView, error) {
	if projectID != itProjectID {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: itProjectID, Slug: "widgets", Name: "Widgets", MyRole: p.role}, nil
}
func (p *itProjects) RecordDenied(_ context.Context, _ Caller, _, action string) error {
	p.denials = append(p.denials, action)
	return nil
}
func (p *itProjects) ListProjects(context.Context, Caller) ([]ProjectView, error) {
	return nil, notExpectedIT("ListProjects")
}
func (p *itProjects) CreateProject(context.Context, Caller, string, string, string) (ProjectView, error) {
	return ProjectView{}, notExpectedIT("CreateProject")
}
func (p *itProjects) ListRepositories(context.Context, Caller, string) ([]RepositoryView, error) {
	return nil, notExpectedIT("ListRepositories")
}
func (p *itProjects) AddRepository(context.Context, Caller, string, string, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, notExpectedIT("AddRepository")
}
func (p *itProjects) PatchRepositoryCredential(context.Context, Caller, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, notExpectedIT("PatchRepositoryCredential")
}

func (p *itProjects) ListMembers(context.Context, Caller, string) ([]MemberView, error) {
	return nil, notExpectedIT("ListMembers")
}
func (p *itProjects) PutMember(context.Context, Caller, string, string, string) (MemberView, error) {
	return MemberView{}, notExpectedIT("PutMember")
}
func notExpectedIT(name string) error { return errItNotExpected{name: name} }

type errItNotExpected struct{ name string }

func (e errItNotExpected) Error() string { return "itProjects: " + e.name + " not expected" }

type itStore struct {
	list      []IssueTriggerView
	listErr   error
	created   []IssueTriggerCreateInput
	createdOK IssueTriggerView
	createErr error
	current   IssueTriggerView
	getErr    error
	patched   []IssueTriggerPatchInput
	patchErr  error
}

func (s *itStore) ListProjectIssueTriggers(_ context.Context, _ Caller, projectID string) ([]IssueTriggerView, error) {
	if projectID != itProjectID {
		return nil, ErrIssueTriggerNotFound
	}
	return s.list, s.listErr
}
func (s *itStore) CreateIssueTrigger(_ context.Context, _ Caller, _ string, in IssueTriggerCreateInput) (IssueTriggerView, error) {
	if s.createErr != nil {
		return IssueTriggerView{}, s.createErr
	}
	s.created = append(s.created, in)
	return s.createdOK, nil
}
func (s *itStore) GetIssueTrigger(_ context.Context, _ Caller, id string) (IssueTriggerView, error) {
	if s.getErr != nil {
		return IssueTriggerView{}, s.getErr
	}
	if id != itTriggerID {
		return IssueTriggerView{}, ErrIssueTriggerNotFound
	}
	return s.current, nil
}
func (s *itStore) UpdateIssueTrigger(_ context.Context, _ Caller, id string, in IssueTriggerPatchInput) (IssueTriggerView, error) {
	if s.patchErr != nil {
		return IssueTriggerView{}, s.patchErr
	}
	if id != itTriggerID {
		return IssueTriggerView{}, ErrIssueTriggerNotFound
	}
	s.patched = append(s.patched, in)
	out := s.current
	if in.Enabled != nil {
		out.Enabled = *in.Enabled
	}
	return out, nil
}

var _ IssueTriggerStore = (*itStore)(nil)

func itMount(t *testing.T, store *itStore, projects *itProjects, role string, admin bool) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3},
		principalAuth(&Principal{UserID: itUser, OrganizationID: "o-1",
			DisplayName: "u", CSRFToken: "csrf-token-value", IsOrgAdmin: admin}, nil), nil)
	RegisterIssueTriggers(s, store, projects)
	return s
}

func itSend(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, target, nil)
	} else {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		req = httptest.NewRequest(method, target, strings.NewReader(string(data)))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

func itProblemCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Code   string `json:"type"`
		Detail string `json:"detail"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode problem: %v (%s)", err, rec.Body)
	}
	if out.Status != rec.Code {
		t.Errorf("problem.status = %d, response = %d", out.Status, rec.Code)
	}
	return out.Code
}

// --- routes ----------------------------------------------------------------

func TestIssueTriggerListRolesAndEnvelope(t *testing.T) {
	store := &itStore{list: []IssueTriggerView{{ID: itTriggerID, ProjectID: itProjectID, AssignmentID: itAssignID,
		RepositoryID: itRepoID, Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: true,
		Version: 1}}}
	rec := itSend(t, itMount(t, store, &itProjects{role: "viewer"}, "viewer", false), http.MethodGet,
		"/api/v1/projects/"+itProjectID+"/issue-triggers", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET as viewer = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view IssueTriggerListView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(view.IssueTriggers) != 1 || view.IssueTriggers[0].Event != "opened" {
		t.Fatalf("body = %s", rec.Body)
	}
	store.list = nil
	rec = itSend(t, itMount(t, store, &itProjects{role: "contributor"}, "contributor", false),
		http.MethodGet, "/api/v1/projects/"+itProjectID+"/issue-triggers", nil)
	if !strings.Contains(rec.Body.String(), `"issue_triggers":[]`) {
		t.Errorf("empty list body = %s, want issue_triggers:[]", rec.Body)
	}
}

func TestIssueTriggerCreateValidation(t *testing.T) {
	t.Run("viewer is refused before the store", func(t *testing.T) {
		store := &itStore{}
		projects := &itProjects{role: "viewer"}
		s := itMount(t, store, projects, "viewer", false)
		rec := itSend(t, s, http.MethodPost, "/api/v1/projects/"+itProjectID+"/issue-triggers",
			map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "opened"})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("POST as viewer = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if len(store.created) != 0 {
			t.Errorf("store saw %d creates; the role gate must run first", len(store.created))
		}
		if len(projects.denials) != 1 || projects.denials[0] != "issue_trigger.create" {
			t.Errorf("denials = %v, want one issue_trigger.create audit row", projects.denials)
		}
	})

	for _, tc := range []struct {
		name string
		body map[string]any
		want string
	}{
		{"bad event", map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "closed"}, IssueTriggerCodeInvalidEvent},
		{"label too long", map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "opened",
			"labels": []string{"this-label-name-is-way-too-long-for-github-exceeds-the-bound"}}, IssueTriggerCodeInvalidLabels},
		{"too many labels", map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "opened",
			"labels": []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u"}}, IssueTriggerCodeInvalidLabels},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &itStore{}
			s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false)
			rec := itSend(t, s, http.MethodPost, "/api/v1/projects/"+itProjectID+"/issue-triggers", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("POST %s = %d, want 400 (%s)", tc.name, rec.Code, rec.Body)
			}
			if !strings.Contains(itProblemCode(t, rec), tc.want) {
				t.Errorf("problem type = %s, want it to name %s", itProblemCode(t, rec), tc.want)
			}
			if len(store.created) != 0 {
				t.Errorf("store saw a create for a request the handler can refuse (%s)", tc.name)
			}
		})
	}

	t.Run("non_github repository is a named 422", func(t *testing.T) {
		store := &itStore{createErr: fmt.Errorf("github: %s is not a GitHub repository url: %w",
			"https://gitlab.com/octo/widgets", github.ErrNotGitHubRepository)}
		s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false)
		rec := itSend(t, s, http.MethodPost, "/api/v1/projects/"+itProjectID+"/issue-triggers",
			map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "opened"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("POST non-github = %d, want 422 (%s)", rec.Code, rec.Body)
		}
		if !strings.Contains(itProblemCode(t, rec), IssueTriggerCodeNotGitHubRepo) {
			t.Errorf("problem type = %s, want %s", itProblemCode(t, rec), IssueTriggerCodeNotGitHubRepo)
		}
	})

	t.Run("happy path creates through the store", func(t *testing.T) {
		store := &itStore{createdOK: IssueTriggerView{ID: itTriggerID, ProjectID: itProjectID, AssignmentID: itAssignID,
			RepositoryID: itRepoID, Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: true,
			Version: 1, CreatedBy: itUser, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}}
		s := itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false)
		rec := itSend(t, s, http.MethodPost, "/api/v1/projects/"+itProjectID+"/issue-triggers",
			map[string]any{"assignment_id": itAssignID, "repository_id": itRepoID, "event": "opened", "enabled": true})
		if rec.Code != http.StatusCreated {
			t.Fatalf("POST as maintainer = %d, want 201 (%s)", rec.Code, rec.Body)
		}
		if len(store.created) != 1 || store.created[0].Event != "opened" {
			t.Fatalf("store creates = %+v", store.created)
		}
	})
}

func TestIssueTriggerPatchGates(t *testing.T) {
	base := IssueTriggerView{ID: itTriggerID, ProjectID: itProjectID, AssignmentID: itAssignID,
		RepositoryID: itRepoID, Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: true,
		Version: 3, MyRole: "maintainer"}

	t.Run("non-maintainer gets 403 with an audit row", func(t *testing.T) {
		viewer := base
		viewer.MyRole = "viewer"
		store := &itStore{current: viewer}
		projects := &itProjects{role: "viewer"}
		rec := itSend(t, itMount(t, store, projects, "viewer", false), http.MethodPatch,
			"/api/v1/issue-triggers/"+itTriggerID, map[string]any{"version": 3, "enabled": false})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("PATCH as viewer = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if len(store.patched) != 0 {
			t.Error("store saw a patch the role gate must have refused")
		}
		if len(projects.denials) != 1 || projects.denials[0] != "issue_trigger.update" {
			t.Errorf("denials = %v, want one issue_trigger.update", projects.denials)
		}
	})

	t.Run("stale version is a named 409", func(t *testing.T) {
		store := &itStore{current: base, patchErr: ErrIssueTriggerStaleVersion}
		rec := itSend(t, itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPatch, "/api/v1/issue-triggers/"+itTriggerID, map[string]any{"version": 2, "enabled": false})
		if rec.Code != http.StatusConflict {
			t.Fatalf("stale PATCH = %d, want 409 (%s)", rec.Code, rec.Body)
		}
		if !strings.Contains(itProblemCode(t, rec), IssueTriggerCodeVersionStale) {
			t.Errorf("type = %s, want %s", itProblemCode(t, rec), IssueTriggerCodeVersionStale)
		}
	})

	t.Run("an empty patch is refused", func(t *testing.T) {
		store := &itStore{current: base}
		rec := itSend(t, itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPatch, "/api/v1/issue-triggers/"+itTriggerID, map[string]any{"version": 3})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("empty PATCH = %d, want 422 (%s)", rec.Code, rec.Body)
		}
		if !strings.Contains(itProblemCode(t, rec), IssueTriggerCodePatchEmpty) {
			t.Errorf("type = %s, want %s", itProblemCode(t, rec), IssueTriggerCodePatchEmpty)
		}
	})

	t.Run("happy path carries the patch through", func(t *testing.T) {
		store := &itStore{current: base}
		rec := itSend(t, itMount(t, store, &itProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPatch, "/api/v1/issue-triggers/"+itTriggerID,
			map[string]any{"version": 3, "enabled": false})
		if rec.Code != http.StatusOK {
			t.Fatalf("PATCH = %d, want 200 (%s)", rec.Code, rec.Body)
		}
		if len(store.patched) != 1 {
			t.Fatalf("patched = %+v", store.patched)
		}
		got := store.patched[0]
		if got.Version != 3 || got.Enabled == nil || *got.Enabled {
			t.Errorf("patch = %+v, want version 3 with enabled=false", got)
		}
	})
}
