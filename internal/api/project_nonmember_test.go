package api

// ADR-0014 § 3: a caller who is not a member of a project must get the SAME
// answer for every route under that project as the overview route gives — a
// 404 that hides existence, never a 500 (which says "it exists") and never a
// 403 (which says the same thing more quietly). The runs, assignment and
// schedule families gate through the project read but mapped their errors with
// their own family's nouns, so ErrProjectNotFound fell through to 500; these
// tests pin the shared answer for a non-member on each fixed route.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	nmProject = "55555555-5555-4555-8555-555555555555"
	nmUser    = "66666666-6666-4666-8666-666666666666"
)

// nmMount builds the whole project surface behind one caller whose membership
// is none: m4Projects with an empty role answers ErrProjectNotFound, exactly
// as the postgres store does for a non-member.
func nmMount(t *testing.T, projects *m4Projects, runs *m4Runs, asgns *m4Assignments,
	sched *schStore) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 5},
		principalAuth(&Principal{UserID: nmUser, OrganizationID: "o-1", DisplayName: "Erin",
			CSRFToken: "csrf-token-value", IsOrgAdmin: false}, nil), nil)
	RegisterProjects(s, projects)
	RegisterRuns(s, runs, asgns, projects, &m4Stream{watchCh: make(chan struct{})}, nil)
	RegisterSchedules(s, sched, projects)
	return s
}

func nmSend(t *testing.T, s *Server, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

const nmAssignmentBody = `{"pipeline_id":"` + m4UUID + `","pinned_revision_id":"` + m4UUID2 + `"}`

// TestNonMemberProjectRoutesAnswerAsTheOverviewRoute walks every
// /projects/{id}/… route that gates through the project read and requires its
// answer to be byte-for-byte the overview's: same status, same problem.
func TestNonMemberProjectRoutesAnswerAsTheOverviewRoute(t *testing.T) {
	projects := &m4Projects{} // role "" → every project read is a 404
	runs, asgns, sched := &m4Runs{}, &m4Assignments{}, &schStore{}
	s := nmMount(t, projects, runs, asgns, sched)

	overview := nmSend(t, s, http.MethodGet, "/api/v1/projects/"+nmProject, "")
	if overview.Code != http.StatusNotFound {
		t.Fatalf("GET /projects as a non-member = %d, want 404 (%s)", overview.Code, overview.Body)
	}
	want := decodeProblem(t, overview)
	if want.Detail != "No such project." {
		t.Fatalf("overview detail = %q, want the existence-hiding text", want.Detail)
	}

	for _, tc := range []struct{ name, method, target, body string }{
		{"runs list", http.MethodGet, "/runs", ""},
		{"runs create", http.MethodPost, "/runs", `{"pipeline_revision_id":"` + m4UUID2 + `"}`},
		{"assignments list", http.MethodGet, "/assignments", ""},
		{"assignments create", http.MethodPost, "/assignments", nmAssignmentBody},
		{"schedules list", http.MethodGet, "/schedules", ""},
		{"schedules create", http.MethodPost, "/schedules",
			`{"assignment_id":"` + m4UUID + `","cron_expr":"0 9 * * *","enabled":true}`},
	} {
		rec := nmSend(t, s, tc.method, "/api/v1/projects/"+nmProject+tc.target, tc.body)
		if rec.Code != want.Status {
			t.Errorf("%s: status = %d, want the overview's %d (%s)",
				tc.name, rec.Code, want.Status, rec.Body)
			continue
		}
		got := decodeProblem(t, rec)
		if got.Title != want.Title || got.Status != want.Status || got.Detail != want.Detail {
			t.Errorf("%s: problem = %+v, want the overview's %+v", tc.name, got, want)
		}
	}
	// The refusal is the handler's decision, so no project store was touched
	// and no write happened — a non-member cannot even seed a run row.
	if runs.created || len(runs.calls) != 0 || asgns.lastCreate.PipelineID != "" ||
		len(sched.created) != 0 {
		t.Errorf("a non-member reached the resource stores: created=%v calls=%v asgns=%+v sched=%+v",
			runs.created, runs.calls, asgns.lastCreate, sched.created)
	}
	for _, id := range append(append([]string{}, runs.denied...), asgns.denied...) {
		t.Errorf("denial audited against a resource store instead of the project: %q", id)
	}
	wantActions := []string{"project.get", "run.list", "run.create", "assignment.list",
		"assignment.create", "schedule.list", "schedule.create"}
	if len(projects.denied) != len(wantActions) {
		t.Fatalf("project audit rows = %v, want one per refused route (%v)", projects.denied, wantActions)
	}
	for i, row := range projects.denied {
		if row != wantActions[i]+"@"+nmProject {
			t.Errorf("audit row %d = %q, want %q@%s", i, row, wantActions[i], nmProject)
		}
	}
}

// TestNonMemberProjectReadKeepsResourceNouns guards the other half of the
// mapping: a route whose store answers with its own not-found still names its
// own resource, so the new project arm cannot swallow it.
func TestNonMemberProjectReadKeepsResourceNouns(t *testing.T) {
	projects := &m4Projects{role: "viewer"}
	runs := &m4Runs{runs: []RunSummaryView{{ID: m4UUID, ProjectID: "p-1"}}}
	s := nmMount(t, projects, runs, &m4Assignments{}, &schStore{})
	if got := do(t, s, request(http.MethodGet, "/api/v1/projects/p-1/runs", nil)); got.Code != http.StatusOK {
		t.Fatalf("member GET runs = %d, want 200 (%s)", got.Code, got.Body)
	}

	// A below-role request is still the audited 403, not the project 404.
	projects.role = "viewer"
	nonAdmin := nmSend(t, s, http.MethodPost, "/api/v1/projects/p-1/assignments", nmAssignmentBody)
	if nonAdmin.Code != http.StatusForbidden {
		t.Fatalf("viewer POST assignments = %d, want 403 (%s)", nonAdmin.Code, nonAdmin.Body)
	}
	if p := decodeProblem(t, nonAdmin); p.Detail == "No such project." {
		t.Errorf("a member's role refusal was answered as an invisible project: %+v", p)
	}
}
