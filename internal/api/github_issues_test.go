package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// --- fake lister --------------------------------------------------------

// ghiFakeLister answers ListIssues from a fixture and records the calls the
// route made. No test in this file touches the network.
type ghiFakeLister struct {
	issues []github.Issue
	err    error
	calls  []ghiListCall
}

type ghiListCall struct {
	repo  github.Repository
	query github.IssueQuery
	token string
}

func (f *ghiFakeLister) ListIssues(ctx context.Context, repo github.Repository,
	q github.IssueQuery, token string) ([]github.Issue, error) {
	f.calls = append(f.calls, ghiListCall{repo: repo, query: q, token: token})
	if f.err != nil {
		return nil, f.err
	}
	return f.issues, nil
}

// ghiFakeCredentials records the ADR-0061 resolves the route asks for and
// answers them from a fixture. resolveErr non-nil means every resolve fails
// — the fail-closed arm of the route.
type ghiFakeCredentials struct {
	calls      []string // repository ids, in order
	token      string
	resolveErr error
}

func (c *ghiFakeCredentials) ResolveRepositoryCredential(ctx context.Context, repositoryID, consumer, actorID string) (string, error) {
	c.calls = append(c.calls, repositoryID)
	if consumer != ghConsumerIssueRead {
		return "", errors.New("ghiFakeCredentials: consumer is not issue_read: " + consumer)
	}
	if c.resolveErr != nil {
		return "", c.resolveErr
	}
	return c.token, nil
}

// ghiFixture is one project the caller is a maintainer of, plus a repository
// whose remote is GitHub. The third return is the project id.
func ghiFixture(t *testing.T, gitURL string) (*prjFakeStore, *ghiFakeLister, string, string) {
	t.Helper()
	store := prjNewFakeStore()
	projectID := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	store.repos[projectID] = []RepositoryView{
		{ID: "r-gh", ProjectID: projectID, Name: "widgets", GitURL: gitURL, DefaultBranch: "main", CreatedAt: prjFixedTime, Credential: "none"},
		{ID: "r-other", ProjectID: projectID, Name: "other", GitURL: "https://gitlab.com/octo/other.git", CreatedAt: prjFixedTime, Credential: "none"},
	}
	return store, &ghiFakeLister{}, projectID, "r-gh"
}

func ghiServer(t *testing.T, store ProjectStore, lister github.IssueLister, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	RegisterGitHubIssues(s, store, lister, nil)
	return s
}

// ghiServerCredentialed mounts the route with the ADR-0061 resolver seam.
func ghiServerCredentialed(t *testing.T, store ProjectStore, lister github.IssueLister,
	creds RepositoryCredentialResolver, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	RegisterGitHubIssues(s, store, lister, creds)
	return s
}

func ghiGet(path string) *http.Request {
	return request(http.MethodGet, "http://localhost:8080"+path, nil)
}

const ghiIssueJSON = `[{"number":12,"title":"Ship W3","body":"the read half",
	"labels":[{"name":"ready-for-agent"}],"state":"open",
	"html_url":"https://github.com/octo/widgets/issues/12",
	"updated_at":"2026-10-16T07:33:53Z"}]`

// ghiMarshal re-encodes a decoded JSON object so prjWantFields can name its
// members.
func ghiMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("re-encode %v: %v", v, err)
	}
	return raw
}

// --- tests --------------------------------------------------------------

func TestGitHubIssuesReturnsTheList(t *testing.T) {
	store, lister, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets.git")
	fixture := []github.Issue{{
		Number: 12, Title: "Ship W3", Body: "the read half",
		Labels: []string{"ready-for-agent"}, State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/12",
		UpdatedAt: time.Date(2026, 10, 16, 7, 33, 53, 0, time.UTC),
	}}
	lister.issues = fixture
	srv := ghiServer(t, store, lister, prjAs("u-1", false))

	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+"/issues"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	prjWantFields(t, rec.Body.Bytes(), "repository", "state", "items")
	body := decodeBody(t, rec)
	prjEqual(t, body["repository"], "octo/widgets", "repository")
	prjEqual(t, body["state"], "open", "state defaults to open")
	items, ok := body["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items = %v, want one item", body["items"])
	}
	first := items[0].(map[string]any)
	prjWantFields(t, ghiMarshal(t, first), "number", "title", "body", "labels",
		"html_url", "state", "updated_at", "body_truncated")
	prjEqual(t, first["number"], float64(12), "number")
	prjEqual(t, first["title"], "Ship W3", "title")
	prjEqual(t, first["html_url"], "https://github.com/octo/widgets/issues/12", "html_url")
	prjEqual(t, first["updated_at"], "2026-10-16T07:33:53Z", "updated_at")

	if len(lister.calls) != 1 {
		t.Fatalf("lister saw %d calls, want 1", len(lister.calls))
	}
	call := lister.calls[0]
	if call.repo.Owner != "octo" || call.repo.Name != "widgets" {
		t.Errorf("lister repo = %s, want octo/widgets (parsed from the .git remote)", call.repo)
	}
	if call.query.State != github.StateOpen || call.query.Label != "" {
		t.Errorf("lister query = %+v, want state=open with no label", call.query)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store: this is somebody else's tracker, read live", cc)
	}
}

func TestGitHubIssuesEmptyListIsAnArrayNotNull(t *testing.T) {
	store, lister, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets")
	srv := ghiServer(t, store, lister, prjAs("u-1", false))
	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+"/issues"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Errorf("body = %s, want an empty array for no issues", rec.Body)
	}
}

func TestGitHubIssuesPassesStateAndLabelThrough(t *testing.T) {
	store, lister, projectID, repoID := ghiFixture(t, "ssh://git@github.com/octo/widgets.git")
	srv := ghiServer(t, store, lister, prjAs("u-1", false))
	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+
		"/issues?state=closed&label=ready-for-agent"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	call := lister.calls[0]
	if call.query.State != "closed" || call.query.Label != "ready-for-agent" {
		t.Errorf("lister query = %+v, want closed / ready-for-agent", call.query)
	}
	prjEqual(t, decodeBody(t, rec)["label"], "ready-for-agent", "label echo")
}

func TestGitHubIssuesRefusesAnUnknownState(t *testing.T) {
	store, lister, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets")
	srv := ghiServer(t, store, lister, prjAs("u-1", false))
	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+"/issues?state=everything"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body)
	}
	if len(lister.calls) != 0 {
		t.Errorf("lister saw %d calls, want 0: validate before calling upstream", len(lister.calls))
	}
}

func TestGitHubIssuesRequiresASession(t *testing.T) {
	store, lister, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets")
	srv := ghiServer(t, store, lister, principalAuth(nil, ErrUnauthenticated))
	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+"/issues"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body)
	}
}

func TestGitHubIssuesHidesForeignProjectsAndUnknownRepositories(t *testing.T) {
	// The fake store mirrors the real one's per-caller my_role gate: a project
	// with no role for the caller is invisible, exactly as a foreign project
	// is for a non-member.
	store, lister, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets")
	cfg := store.byID[projectID]
	cfg.MyRole = ""
	store.byID[projectID] = cfg
	stranger := prjAs("u-9", false)
	rec := do(t, ghiServer(t, store, lister, stranger),
		ghiGet("/api/v1/projects/"+projectID+"/repos/"+repoID+"/issues"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-member status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Status != http.StatusNotFound || !strings.Contains(p.Detail, "project") {
		t.Errorf("problem = %+v, want the project-not-found body every project route gives", p)
	}
	if len(store.denied) == 0 {
		t.Error("want an audit denial for the foreign project read")
	}

	// A repository id that is not in this caller's project is the same 404.
	store, lister, projectID, repoID = ghiFixture(t, "https://github.com/octo/widgets")
	rec = do(t, ghiServer(t, store, lister, prjAs("u-1", false)),
		ghiGet("/api/v1/projects/"+projectID+"/repos/r-nope/issues"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown repository status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	if len(lister.calls) != 0 {
		t.Errorf("lister saw %d calls, want 0: a missing row never reaches upstream", len(lister.calls))
	}
}

// --- ADR-0061: the repository's credential on the read -------------------

// ghiCredentialedFixture mounts the route against a repository that HAS an
// ADR-0061 credential, with the fake resolver in the loop.
func ghiCredentialedFixture(t *testing.T, creds RepositoryCredentialResolver,
	lister github.IssueLister) (*Server, string) {
	t.Helper()
	store, _, projectID, repoID := ghiFixture(t, "https://github.com/octo/widgets.git")
	for i, r := range store.repos[projectID] {
		if r.ID == repoID {
			cred := prjTBrokerCredential
			r.CredentialSecretID = &cred
			r.Credential = "configured"
			store.repos[projectID][i] = r
		}
	}
	return ghiServerCredentialed(t, store, lister, creds, prjAs("u-1", false)), projectID
}

// TestIssueListPassesRepositoryCredential is the route half of ADR-0061 § 5:
// a repository with a credential gets its issues read WITH that credential;
// the consumer is issue_read; a repository without one keeps the anonymous
// call and never touches the resolver.
func TestIssueListPassesRepositoryCredential(t *testing.T) {
	creds := &ghiFakeCredentials{token: "ghp_repository_token_123"}
	lister := &ghiFakeLister{}
	srv, projectID := ghiCredentialedFixture(t, creds, lister)

	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/r-gh/issues"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if len(lister.calls) != 1 || lister.calls[0].token != "ghp_repository_token_123" {
		t.Fatalf("lister calls = %+v, want the token to ride the call", lister.calls)
	}
	if len(creds.calls) != 1 || creds.calls[0] != "r-gh" {
		t.Errorf("resolves = %v, want exactly one for r-gh", creds.calls)
	}

	// The uncredentialed repository on the same fixture: anonymous, and the
	// resolver is not consulted at all.
	plainStore, plainLister, p2, _ := ghiFixture(t, "https://github.com/octo/widgets.git")
	plainSrv := ghiServerCredentialed(t, plainStore, plainLister, creds, prjAs("u-1", false))
	rec = do(t, plainSrv, ghiGet("/api/v1/projects/"+p2+"/repos/r-gh/issues"))
	if rec.Code != http.StatusOK {
		t.Fatalf("anonymous arm: status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if len(plainLister.calls) != 1 || plainLister.calls[0].token != "" {
		t.Errorf("anonymous lister calls = %+v, want an empty token", plainLister.calls)
	}
	if len(creds.calls) != 1 {
		t.Errorf("resolver was consulted for an uncredentialed repository: %v", creds.calls)
	}
}

// TestIssueListCredentialResolveFailsClosed is the never-silently-anonymous
// rule: when the resolve refuses, the route answers 502 with the typed code,
// names the repository, and GitHub is never called.
func TestIssueListCredentialResolveFailsClosed(t *testing.T) {
	creds := &ghiFakeCredentials{resolveErr: errGhiCredential}
	lister := &ghiFakeLister{}
	srv, projectID := ghiCredentialedFixture(t, creds, lister)

	rec := do(t, srv, ghiGet("/api/v1/projects/"+projectID+"/repos/r-gh/issues"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), GitHubIssueCodeCredentialUnresolvable) {
		t.Errorf("body has no %s code: %s", GitHubIssueCodeCredentialUnresolvable, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "widgets") {
		t.Errorf("body should name the repository: %s", rec.Body)
	}
	if len(lister.calls) != 0 {
		t.Errorf("GitHub was called after a failed resolve: %+v", lister.calls)
	}

	// A deployment that wired no resolver answers the same typed 502 for a
	// credentialed repository (not anonymous, not 500).
	srv2, projectID2 := ghiCredentialedFixture(t, nil, &ghiFakeLister{})
	rec = do(t, srv2, ghiGet("/api/v1/projects/"+projectID2+"/repos/r-gh/issues"))
	if rec.Code != http.StatusBadGateway ||
		!strings.Contains(rec.Body.String(), GitHubIssueCodeCredentialUnresolvable) {
		t.Fatalf("unwired deployment: status = %d body = %s", rec.Code, rec.Body)
	}
}

var errGhiCredential = errors.New("postgres: repository GitHub credential could not be resolved: repository \"widgets\"")
