package api

// ADR-0032 part 2's schedule routes, against a fake store. What this file
// pins is the HTTP surface: role gates, the named 422s (invalid_cron names
// its field), optimistic-concurrency 409s, and that the store is never
// reached for a request the handler can refuse. The SQL-side predicates are
// exercised against real Postgres in internal/store/postgres.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	schProjectID = "11111111-1111-4111-8111-111111111111"
	schAssignID  = "22222222-2222-4222-8222-222222222222"
	schSchedID   = "33333333-3333-4333-8333-333333333333"
	schUser      = "44444444-4444-4444-8444-444444444444"
)

// --- fakes ---------------------------------------------------------------

// schProjects is the ProjectStore gate stand-in: one project whose MyRole the
// test controls, plus the denial audit log.
type schProjects struct {
	role    string
	denials []string
}

func (p *schProjects) GetProject(_ context.Context, _ Caller, projectID string) (ProjectView, error) {
	if projectID != schProjectID {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: p.id(), Slug: "widgets", Name: "Widgets", MyRole: p.role}, nil
}
func (p *schProjects) id() string { return schProjectID }
func (p *schProjects) RecordDenied(_ context.Context, _ Caller, _, action string) error {
	p.denials = append(p.denials, action)
	return nil
}

func (p *schProjects) ListProjects(context.Context, Caller) ([]ProjectView, error) {
	return nil, notExpected("ListProjects")
}
func (p *schProjects) CreateProject(context.Context, Caller, string, string, string) (ProjectView, error) {
	return ProjectView{}, notExpected("CreateProject")
}
func (p *schProjects) ListRepositories(context.Context, Caller, string) ([]RepositoryView, error) {
	return nil, notExpected("ListRepositories")
}
func (p *schProjects) AddRepository(context.Context, Caller, string, string, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, notExpected("AddRepository")
}
func (p *schProjects) PatchRepositoryCredential(context.Context, Caller, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, notExpected("PatchRepositoryCredential")
}

func (p *schProjects) ListMembers(context.Context, Caller, string) ([]MemberView, error) {
	return nil, notExpected("ListMembers")
}
func (p *schProjects) PutMember(context.Context, Caller, string, string, string) (MemberView, error) {
	return MemberView{}, notExpected("PutMember")
}

func notExpected(name string) error { return errSchNotExpected{name} }

type errSchNotExpected struct{ name string }

func (e errSchNotExpected) Error() string { return "schProjects: " + e.name + " not expected" }

// schStore is the ScheduleStore fake: canned answers, recorded calls, and a
// tripwire so a refused-at-the-handler request never shows up as a write.
type schStore struct {
	list      []ScheduleView
	listErr   error
	created   []ScheduleCreateInput
	createdOK ScheduleView
	createErr error
	current   ScheduleView
	getErr    error
	patched   []SchedulePatchInput
	patchErr  error
}

func (s *schStore) ListProjectSchedules(_ context.Context, _ Caller, projectID string) ([]ScheduleView, error) {
	if projectID != schProjectID {
		return nil, ErrScheduleNotFound
	}
	return s.list, s.listErr
}
func (s *schStore) CreateSchedule(_ context.Context, _ Caller, projectID string, in ScheduleCreateInput) (ScheduleView, error) {
	if s.createErr != nil {
		return ScheduleView{}, s.createErr
	}
	s.created = append(s.created, in)
	return s.createdOK, nil
}
func (s *schStore) GetSchedule(_ context.Context, _ Caller, id string) (ScheduleView, error) {
	if s.getErr != nil {
		return ScheduleView{}, s.getErr
	}
	if id != schSchedID {
		return ScheduleView{}, ErrScheduleNotFound
	}
	return s.current, nil
}
func (s *schStore) UpdateSchedule(_ context.Context, _ Caller, id string, in SchedulePatchInput) (ScheduleView, error) {
	if s.patchErr != nil {
		return ScheduleView{}, s.patchErr
	}
	if id != schSchedID {
		return ScheduleView{}, ErrScheduleNotFound
	}
	s.patched = append(s.patched, in)
	return s.current, nil
}

var _ ScheduleStore = (*schStore)(nil)

// --- mounting -------------------------------------------------------------

func schMount(t *testing.T, store *schStore, projects *schProjects, role string, admin bool) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3},
		principalAuth(&Principal{UserID: schUser, OrganizationID: "o-1",
			DisplayName: "u", CSRFToken: "csrf-token-value", IsOrgAdmin: admin}, nil), nil)
	RegisterSchedules(s, store, projects)
	return s
}

func schSend(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
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

func schProblemCode(t *testing.T, rec *httptest.ResponseRecorder) string {
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

func schFuture() time.Time { return time.Now().UTC().Add(3 * time.Hour).Truncate(time.Second) }

// --- routes ----------------------------------------------------------------

func TestListSchedulesEnvelopeAndRoles(t *testing.T) {
	store := &schStore{list: []ScheduleView{{ID: schSchedID, ProjectID: schProjectID,
		AssignmentID: schAssignID, CronExpr: "0 9 * * *", Inputs: json.RawMessage(`{}`),
		Enabled: true, NextRunAt: schFuture(), Version: 1}}}
	projects := &schProjects{role: "viewer"}
	rec := schSend(t, schMount(t, store, projects, "viewer", false), http.MethodGet,
		"/api/v1/projects/"+schProjectID+"/schedules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET as viewer = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view ScheduleListView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(view.Schedules) != 1 || view.Schedules[0].CronExpr != "0 9 * * *" {
		t.Fatalf("body = %s", rec.Body)
	}
	// Empty is an empty array, never null: the UI maps over it unconditionally.
	store.list = nil
	rec = schSend(t, schMount(t, store, &schProjects{role: "contributor"}, "contributor", false),
		http.MethodGet, "/api/v1/projects/"+schProjectID+"/schedules", nil)
	if !strings.Contains(rec.Body.String(), `"schedules":[]`) {
		t.Errorf("empty list body = %s, want schedules:[]", rec.Body)
	}
}

func TestCreateSchedulesRoleGateAndValidation(t *testing.T) {
	t.Run("viewer is refused before the store", func(t *testing.T) {
		store := &schStore{}
		projects := &schProjects{role: "viewer"}
		s := schMount(t, store, projects, "viewer", false)
		rec := schSend(t, s, http.MethodPost, "/api/v1/projects/"+schProjectID+"/schedules",
			map[string]any{"assignment_id": schAssignID, "cron_expr": "0 * * * *"})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("POST as viewer = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if len(store.created) != 0 {
			t.Errorf("store saw %d creates; the role gate must run first", len(store.created))
		}
		if len(projects.denials) != 1 || projects.denials[0] != "schedule.create" {
			t.Errorf("denials = %v, want one schedule.create audit row", projects.denials)
		}
	})
	for _, tc := range []struct {
		name string
		body map[string]any
		want string // type URI suffix or exact body marker
	}{
		{"bad cron", map[string]any{"assignment_id": schAssignID, "cron_expr": "*/0 * * * *"}, ScheduleCodeCronInvalid},
		{"no cron", map[string]any{"assignment_id": schAssignID, "cron_expr": ""}, ScheduleCodeCronInvalid},
		{"names refused", map[string]any{"assignment_id": schAssignID, "cron_expr": "@daily"}, ScheduleCodeCronInvalid},
		{"inputs not object", map[string]any{"assignment_id": schAssignID, "cron_expr": "0 * * * *",
			"inputs": json.RawMessage(`"hello"`)}, ScheduleCodeInputsInvalid},
		{"assignment not a uuid", map[string]any{"assignment_id": "assign-1", "cron_expr": "0 * * * *"},
			ScheduleCodeFieldRequired},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &schStore{}
			s := schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false)
			rec := schSend(t, s, http.MethodPost, "/api/v1/projects/"+schProjectID+"/schedules", tc.body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("POST %s = %d, want 422 (%s)", tc.name, rec.Code, rec.Body)
			}
			if !strings.Contains(schProblemCode(t, rec), tc.want) {
				t.Errorf("problem type = %s, want it to name %s", schProblemCode(t, rec), tc.want)
			}
			if len(store.created) != 0 {
				t.Errorf("store saw a create for a request the handler can refuse (%s)", tc.name)
			}
		})
	}
}

func TestCreateSchedulePersistsAndAnswersTheRow(t *testing.T) {
	store := &schStore{createdOK: ScheduleView{ID: schSchedID, ProjectID: schProjectID,
		AssignmentID: schAssignID, CronExpr: "0 9 * * *", Inputs: json.RawMessage(`{"branch":"main"}`),
		Enabled: true, NextRunAt: schFuture(), Version: 1, CreatedBy: schUser,
		CreatedAt: schFuture(), UpdatedAt: schFuture()}}
	s := schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false)
	rec := schSend(t, s, http.MethodPost, "/api/v1/projects/"+schProjectID+"/schedules",
		map[string]any{"assignment_id": schAssignID, "cron_expr": "0 9 * * *",
			"inputs": map[string]string{"branch": "main"}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST as maintainer = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if len(store.created) != 1 || store.created[0].CronExpr != "0 9 * * *" {
		t.Fatalf("store creates = %+v", store.created)
	}
	// next_run_at is on the wire: the UI's "in 3h 20m" reads it here.
	if !strings.Contains(rec.Body.String(), `"next_run_at"`) {
		t.Errorf("body = %s, want next_run_at", rec.Body)
	}
	// The org admin arm: same route, no membership at all.
	store2 := &schStore{createdOK: store.createdOK}
	rec = schSend(t, schMount(t, store2, &schProjects{role: "maintainer"}, "", true),
		http.MethodPost, "/api/v1/projects/"+schProjectID+"/schedules",
		map[string]any{"assignment_id": schAssignID, "cron_expr": "0 * * * *"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST as org admin = %d, want 201 (%s)", rec.Code, rec.Body)
	}
}

func TestPatchScheduleGatesAndConflicts(t *testing.T) {
	base := ScheduleView{ID: schSchedID, ProjectID: schProjectID, AssignmentID: schAssignID,
		CronExpr: "0 9 * * *", Inputs: json.RawMessage(`{}`), Enabled: true,
		NextRunAt: schFuture(), Version: 3, MyRole: "maintainer"}

	t.Run("non-maintainer gets 403 with an audit row", func(t *testing.T) {
		projects := &schProjects{role: "viewer"}
		store := &schStore{current: func() ScheduleView { v := base; v.MyRole = "viewer"; return v }()}
		rec := schSend(t, schMount(t, store, projects, "viewer", false), http.MethodPatch,
			"/api/v1/schedules/"+schSchedID, map[string]any{"version": 3, "enabled": false})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("PATCH as viewer = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if len(store.patched) != 0 {
			t.Error("store saw a patch the role gate must have refused")
		}
		if len(projects.denials) != 1 || projects.denials[0] != "schedule.update" {
			t.Errorf("denials = %v, want one schedule.update", projects.denials)
		}
	})

	t.Run("stale version is a named 409", func(t *testing.T) {
		store := &schStore{current: base, patchErr: ErrScheduleStaleVersion}
		rec := schSend(t, schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPatch, "/api/v1/schedules/"+schSchedID, map[string]any{"version": 2, "enabled": false})
		if rec.Code != http.StatusConflict {
			t.Fatalf("stale PATCH = %d, want 409 (%s)", rec.Code, rec.Body)
		}
		if !strings.Contains(schProblemCode(t, rec), ScheduleCodeVersionStale) {
			t.Errorf("type = %s, want %s", schProblemCode(t, rec), ScheduleCodeVersionStale)
		}
	})

	t.Run("an assignment that cannot fire is a named 409", func(t *testing.T) {
		store := &schStore{current: base, createErr: ErrScheduleNotFireable}
		rec := schSend(t, schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPost, "/api/v1/projects/"+schProjectID+"/schedules",
			map[string]any{"assignment_id": schAssignID, "cron_expr": "0 9 * * *"})
		if rec.Code != http.StatusConflict {
			t.Fatalf("unfireable POST = %d, want 409 (%s)", rec.Code, rec.Body)
		}
		if !strings.Contains(schProblemCode(t, rec), ScheduleCodeNotFireable) {
			t.Errorf("type = %s, want %s", schProblemCode(t, rec), ScheduleCodeNotFireable)
		}
	})

	t.Run("unknown or malformed ids never peek", func(t *testing.T) {
		store := &schStore{current: base}
		s := schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false)
		rec := schSend(t, s, http.MethodPatch, "/api/v1/schedules/nonsense", map[string]any{"version": 3, "enabled": false})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("malformed id = %d, want 404 (%s)", rec.Code, rec.Body)
		}
		rec = schSend(t, s, http.MethodPatch, "/api/v1/schedules/55555555-5555-4555-8555-555555555555",
			map[string]any{"version": 3, "enabled": false})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("unknown id = %d, want 404 (%s)", rec.Code, rec.Body)
		}
	})

	t.Run("the body must say something, with a version", func(t *testing.T) {
		store := &schStore{current: base}
		s := schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false)
		rec := schSend(t, s, http.MethodPatch, "/api/v1/schedules/"+schSchedID, map[string]any{"enabled": false})
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(schProblemCode(t, rec), ScheduleCodeFieldRequired) {
			t.Fatalf("no version = %d (%s), want 422 field_required", rec.Code, rec.Body)
		}
		rec = schSend(t, s, http.MethodPatch, "/api/v1/schedules/"+schSchedID, map[string]any{"version": 3})
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(schProblemCode(t, rec), ScheduleCodePatchEmpty) {
			t.Fatalf("empty patch = %d (%s), want 422 empty_patch", rec.Code, rec.Body)
		}
		rec = schSend(t, s, http.MethodPatch, "/api/v1/schedules/"+schSchedID,
			map[string]any{"version": 3, "cron_expr": "99 * * * *"})
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(schProblemCode(t, rec), ScheduleCodeCronInvalid) {
			t.Fatalf("bad cron patch = %d (%s), want 422 invalid_cron", rec.Code, rec.Body)
		}
		if len(store.patched) != 0 {
			t.Error("a request the handler can refuse reached the store")
		}
	})

	t.Run("happy path carries the patch through", func(t *testing.T) {
		store := &schStore{current: base}
		rec := schSend(t, schMount(t, store, &schProjects{role: "maintainer"}, "maintainer", false),
			http.MethodPatch, "/api/v1/schedules/"+schSchedID,
			map[string]any{"version": 3, "cron_expr": "30 4 * * 1", "enabled": false})
		if rec.Code != http.StatusOK {
			t.Fatalf("PATCH = %d, want 200 (%s)", rec.Code, rec.Body)
		}
		if len(store.patched) != 1 {
			t.Fatalf("patched = %+v", store.patched)
		}
		got := store.patched[0]
		if got.Version != 3 || got.CronExpr == nil || *got.CronExpr != "30 4 * * 1" ||
			got.Enabled == nil || *got.Enabled {
			t.Errorf("patch = %+v, want version 3 with the new cron and enabled=false", got)
		}
		if got.Inputs != nil {
			t.Errorf("inputs = %s, want nil (absent means unchanged)", got.Inputs)
		}
	})
}
