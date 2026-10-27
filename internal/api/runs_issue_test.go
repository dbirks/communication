package api

// TestCreateRunTitleIssue: ADR-0064's handler half — the `title` shape is
// answered before the store, the `issue` claim is validated against the pin
// (a repo-scoped assignment on a GitHub remote) with the promised 422 codes,
// a valid claim reaches the store as the fire's own trigger pair plus the
// assignment's repository, and the server-side issue-title default is
// best-effort: every failure of that read leaves the title null and the run
// still starts.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// rnRepoID is the repository id the ADR-0064 fixture serves (a uuid, as the
// handler demands).
const rnRepoID = "01987a81-3333-7000-8000-abcdef012345"

// rnTestLister is the fake GitHub side of the ADR-0064 title read.
type rnTestLister struct {
	issues []github.Issue
	err    error
	calls  int
	token  string
}

func (l *rnTestLister) ListIssues(_ context.Context, _ github.Repository, _ github.IssueQuery, token string) ([]github.Issue, error) {
	l.calls++
	l.token = token
	return l.issues, l.err
}

// rnTestCreds is the fake ADR-0061 broker.
type rnTestCreds struct {
	token string
	err   error
	calls int
}

func (c *rnTestCreds) ResolveRepositoryCredential(_ context.Context, _, _, _ string) (string, error) {
	c.calls++
	return c.token, c.err
}

// rnIssueServer is m4Server's shape with the WithGitHubIssueReader seam
// mounted, plus a repo-scoped assignment and its GitHub (or not) repository.
func rnIssueServer(t *testing.T, lister github.IssueLister, creds RepositoryCredentialResolver, gitURL string) *m4Fixture {
	t.Helper()
	fx := &m4Fixture{
		projects: &m4Projects{role: "maintainer", repos: []RepositoryView{{
			ID: rnRepoID, ProjectID: "p-1", Name: "web",
			GitURL: gitURL, DefaultBranch: "main", CreatedAt: time.Now().UTC(),
		}}},
		pipes:   &m4Pipelines{},
		defs:    &m4Defs{export: "apiVersion: communication.dev/v1alpha1\n"},
		runs:    &m4Runs{created: true},
		asgns:   &m4Assignments{},
		approvs: &m4Approvals{},
		stream:  &m4Stream{watchCh: make(chan struct{})},
	}
	fx.prin = testPrincipal()
	fx.prin.IsOrgAdmin = true
	s := newTestServer(t, nil, fakeReadiness{expected: 5}, AuthenticatorFunc(
		func(*http.Request) (*Principal, error) { return fx.prin, nil }))
	repoID := rnRepoID
	fx.asgns.item = AssignmentView{ID: m4UUID, ProjectID: "p-1", PipelineID: m4UUID,
		PinnedRevisionID: m4UUID, PinnedRevisionDigest: m4FullDigest, MaxConcurrentRuns: 1,
		BudgetOverrides: json.RawMessage(`{}`), EffectiveBudgets: json.RawMessage(`{}`),
		RepositoryID: &repoID, Enabled: true, Version: 1, MyRole: "maintainer"}
	out := RunView{RunSummaryView: RunSummaryView{ID: "run-1", ProjectID: "p-1",
		PipelineID: m4UUID, PipelineRevisionID: m4UUID, RevisionDigest: m4FullDigest,
		PlanDigest: m4FullDigest, Status: "queued"}}
	fx.runs.createOut = out
	fx.runs.run = out
	RegisterRuns(s, fx.runs, fx.asgns, fx.projects, fx.stream, nil,
		WithGitHubIssueReader(lister, creds))
	fx.s = s
	return fx
}

func TestCreateRunTitleShape(t *testing.T) {
	fx := m4PopulatedServer(t)
	const head = `{"pipeline_revision_id":"` + m4UUID + `",`

	for body, want := range map[string]string{
		`"title":""}`:    "1 to 200",
		`"title":"   "}`: "1 to 200",
		`"title":"` + strings.Repeat("x", 201) + `"}`: "1 to 200",
	} {
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs", head+body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("body %s = %d, want 422 before the store: %s", body, rec.Code, rec.Body)
			continue
		}
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("title refusal %s does not name the bound %q", rec.Body, want)
		}
	}
	if got := len(fx.runs.calls); got != 0 {
		t.Errorf("store saw %d create call(s), want none (shape validation is before the store)", got)
	}

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		head+`"title":"Add saved cards to checkout"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("titled create = %d: %s", rec.Code, rec.Body)
	}
	if fx.runs.lastCreate.Title != "Add saved cards to checkout" {
		t.Errorf("store input Title = %q, want the caller's banner verbatim", fx.runs.lastCreate.Title)
	}
	if fx.runs.lastCreate.Issue != nil {
		t.Errorf("store input Issue = %+v, want nil — no issue was claimed", fx.runs.lastCreate.Issue)
	}
}

func TestCreateRunIssueRefusals(t *testing.T) {
	// A direct revision start cannot claim an issue: it names no repository.
	fx := m4PopulatedServer(t)
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"pipeline_revision_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), RunIssueCodeRepoAssignmentRequired) {
		t.Errorf("issue on a revision start = %d %s, want 422 %s",
			rec.Code, rec.Body, RunIssueCodeRepoAssignmentRequired)
	}
	if len(fx.runs.calls) != 0 {
		t.Errorf("store saw %d call(s); a refused claim writes nothing", len(fx.runs.calls))
	}

	// A project-wide assignment names no repository either.
	// (m4PopulatedServer's fx.asgns.item has RepositoryID nil.)
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), RunIssueCodeRepoAssignmentRequired) {
		t.Errorf("issue on a project-wide assignment = %d %s, want 422 %s",
			rec.Code, rec.Body, RunIssueCodeRepoAssignmentRequired)
	}

	// A repo-scoped assignment on a non-GitHub remote has no issue tracker.
	fx = rnIssueServer(t, &rnTestLister{}, nil, "https://gitlab.com/acme/web.git")
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), RunIssueCodeGitHubRequired) {
		t.Errorf("issue on a GitLab remote = %d %s, want 422 %s",
			rec.Code, rec.Body, RunIssueCodeGitHubRequired)
	}

	// issue.number < 1 is a shape mistake, answered before any lookup.
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":0}}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("issue.number 0 = %d, want 422: %s", rec.Code, rec.Body)
	}

	// An explicit repository_id that disagrees with the assignment's is the
	// invalid_repository 422 — the issue fixes the repository, not the body.
	fx = rnIssueServer(t, &rnTestLister{}, nil, "https://github.com/acme/web.git")
	other := m4UUID2
	fx.projects.repos = append(fx.projects.repos, RepositoryView{
		ID: other, ProjectID: "p-1", Name: "other", GitURL: "https://github.com/acme/other.git",
		DefaultBranch: "main", CreatedAt: time.Now().UTC()})
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","repository_id":"`+other+`","issue":{"number":42}}`)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), RunRepositoryCodeInvalid) {
		t.Errorf("conflicting repository_id = %d %s, want 422 %s",
			rec.Code, rec.Body, RunRepositoryCodeInvalid)
	}
	if len(fx.runs.calls) != 0 {
		t.Errorf("store saw %d call(s); every 422 above writes nothing", len(fx.runs.calls))
	}
}

func TestCreateRunIssueAccepted(t *testing.T) {
	lister := &rnTestLister{issues: []github.Issue{
		{Number: 43, Title: "Unrelated"},
		{Number: 42, Title: "Add saved cards to checkout"},
	}}
	fx := rnIssueServer(t, lister, nil, "https://github.com/acme/web.git")

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("hand issue start = %d: %s", rec.Code, rec.Body)
	}
	in := fx.runs.lastCreate
	if in.Issue == nil || in.Issue.Number != 42 || in.Issue.Repository != "acme/web" {
		t.Fatalf("store input Issue = %+v, want {42 acme/web} — the fire's owner/repo form", in.Issue)
	}
	if in.Title != "Add saved cards to checkout" {
		t.Errorf("store input Title = %q, want the issue's own title as the default banner", in.Title)
	}
	if in.RepositoryID != rnRepoID {
		t.Errorf("store input RepositoryID = %q, want the assignment's repository", in.RepositoryID)
	}

	// An explicit title outranks the read — and the read is then skipped:
	// the server does not spend rate budget on a banner it was already given.
	lister.calls = 0
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42},"title":"My own words"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("titled issue start = %d: %s", rec.Code, rec.Body)
	}
	if fx.runs.lastCreate.Title != "My own words" {
		t.Errorf("Title = %q, want the caller's words to win", fx.runs.lastCreate.Title)
	}
	if lister.calls != 0 {
		t.Errorf("issue read ran %d time(s) despite an explicit title", lister.calls)
	}
}

// TestCreateRunIssueTitleThroughGitHubAdapter is the serve.go wiring proven
// one level down: the SAME read-only adapter `WithGitHubIssueReader(github
// .New(), secretStore)` mounts, aimed at a fake api.github.com. The banner
// arrives at the store out of GitHub's own response — the caller sent no
// title, only the issue number.
func TestCreateRunIssueTitleThroughGitHubAdapter(t *testing.T) {
	seenPath := ""
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"number": 43, "title": "Unrelated", "body": "", "state": "open",
				"labels":     []map[string]string{},
				"html_url":   "https://github.com/acme/web/issues/43",
				"created_at": "2026-10-20T10:00:00Z", "updated_at": "2026-10-20T10:00:00Z"},
			{"number": 42, "title": "Add saved cards to checkout", "body": "please",
				"state": "open", "labels": []map[string]string{{"name": "bug"}},
				"html_url":   "https://github.com/acme/web/issues/42",
				"created_at": "2026-10-20T10:00:00Z", "updated_at": "2026-10-21T10:00:00Z"},
		})
	}))
	defer gh.Close()

	fx := rnIssueServer(t, &github.Client{BaseURL: gh.URL}, nil, "https://github.com/acme/web.git")
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("adapter-backed issue start = %d: %s", rec.Code, rec.Body)
	}
	if seenPath != "/repos/acme/web/issues" {
		t.Errorf("GitHub path = %q, want /repos/acme/web/issues — owner/repo came from the git_url", seenPath)
	}
	if fx.runs.lastCreate.Title != "Add saved cards to checkout" {
		t.Errorf("Title = %q, want GitHub's own title for issue 42", fx.runs.lastCreate.Title)
	}
	if fx.runs.lastCreate.Issue == nil || fx.runs.lastCreate.Issue.Repository != "acme/web" {
		t.Errorf("Issue = %+v, want acme/web#42 recorded with it", fx.runs.lastCreate.Issue)
	}
}

func TestCreateRunIssueTitleReadFailsSilent(t *testing.T) {
	// Upstream refusal: the run starts, the title stays null.
	lister := &rnTestLister{err: errors.New("boom")}
	fx := rnIssueServer(t, lister, nil, "https://github.com/acme/web.git")
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("refused title read = %d: %s — the create must never fail over its banner", rec.Code, rec.Body)
	}
	if fx.runs.lastCreate.Title != "" {
		t.Errorf("Title = %q, want empty after a refused read", fx.runs.lastCreate.Title)
	}
	if fx.runs.lastCreate.Issue == nil {
		t.Error("Issue lost although only the title read failed")
	}

	// A credential the deployment cannot resolve: not read, not failed.
	secrets := &rnTestCreds{err: errors.New("no keyring")}
	lister = &rnTestLister{issues: []github.Issue{{Number: 42, Title: "never read"}}}
	fx = rnIssueServer(t, lister, secrets, "https://github.com/acme/web.git")
	cred := "secret-1"
	fx.projects.repos[0].CredentialSecretID = &cred
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("unresolvable credential = %d: %s", rec.Code, rec.Body)
	}
	if fx.runs.lastCreate.Title != "" || lister.calls != 0 {
		t.Errorf("Title = %q, lister calls = %d; want no read and no title", fx.runs.lastCreate.Title, lister.calls)
	}

	// A resolvable credential reaches the lister as its per-call token.
	secrets = &rnTestCreds{token: "ghs_test"}
	lister = &rnTestLister{issues: []github.Issue{{Number: 42, Title: "Titled by the broker"}}}
	fx = rnIssueServer(t, lister, secrets, "https://github.com/acme/web.git")
	fx.projects.repos[0].CredentialSecretID = &cred
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"assignment_id":"`+m4UUID+`","issue":{"number":42}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("credentialed read = %d: %s", rec.Code, rec.Body)
	}
	if fx.runs.lastCreate.Title != "Titled by the broker" || lister.token != "ghs_test" {
		t.Errorf("Title = %q, token = %q; want the broker token to ride the read",
			fx.runs.lastCreate.Title, lister.token)
	}
}

// TestRunSummaryTitleProjection proves the summary view serializes the new
// members with the nulls the schema promises (Run embeds RunSummary).
func TestRunSummaryTitleProjection(t *testing.T) {
	v := RunSummaryView{ID: "r-1", RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest,
		Status: "queued", Depth: 0, Priority: 0}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range []string{"title", "repository_id", "repository_name"} {
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		got, ok := doc[member]
		if !ok {
			t.Errorf("RunSummary JSON lacks %q — the schema says null, not absent", member)
			continue
		}
		if string(got) != "null" {
			t.Errorf("%s = %s, want null on an unnamed row", member, got)
		}
	}
	title := "Add saved cards to checkout"
	v.Title = &title
	raw, _ = json.Marshal(v)
	if !strings.Contains(string(raw), `"title":"Add saved cards to checkout"`) {
		t.Errorf("titled row JSON = %s", raw)
	}
}
