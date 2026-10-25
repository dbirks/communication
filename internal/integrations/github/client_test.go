package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// --- ParseRepository ----------------------------------------------------

func TestParseRepositoryAcceptsTheRegisteredRemoteForms(t *testing.T) {
	cases := []struct {
		name, gitURL, owner, repo string
	}{
		{"https", "https://github.com/octo/widgets", "octo", "widgets"},
		{"https .git", "https://github.com/octo/widgets.git", "octo", "widgets"},
		{"https trailing slash", "https://github.com/octo/widgets/", "octo", "widgets"},
		{"https dots and dashes", "https://github.com/GitHub-User/my.repo.git", "GitHub-User", "my.repo"},
		{"scp style", "git@github.com:octo/widgets.git", "octo", "widgets"},
		{"scp style no suffix", "git@github.com:octo/widgets", "octo", "widgets"},
		{"ssh url", "ssh://git@github.com/octo/widgets.git", "octo", "widgets"},
		{"ssh url no user", "ssh://github.com/octo/widgets", "octo", "widgets"},
		{"uppercase host", "https://GitHub.com/octo/widgets", "octo", "widgets"},
		{"surrounding space", "  https://github.com/octo/widgets  ", "octo", "widgets"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseRepository(tc.gitURL)
			if err != nil {
				t.Fatalf("ParseRepository(%q) = %v, want success", tc.gitURL, err)
			}
			if got.Owner != tc.owner || got.Name != tc.repo {
				t.Errorf("ParseRepository(%q) = %s/%s, want %s/%s", tc.gitURL, got.Owner, got.Name, tc.owner, tc.repo)
			}
		})
	}
}

func TestParseRepositoryRefusesEverythingElse(t *testing.T) {
	cases := []struct {
		name, gitURL string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"gitlab", "https://gitlab.com/octo/widgets"},
		{"enterprise host", "https://git.example.com/octo/widgets"},
		{"local file", "file:///srv/git/widgets.git"},
		{"bare path", "/srv/git/widgets.git"},
		{"no repo segment", "https://github.com/octo"},
		{"extra path segment", "https://github.com/octo/widgets/issues/12"},
		{"web url with tree", "https://github.com/octo/widgets/tree/main"},
		{"scp with no colon", "git@github.com/octo/widgets"},
		{"scp empty path", "git@github.com:"},
		{"dot repo", "https://github.com/octo/.."},
		{"scheme but no host", "https://"},
		{"relative with drive colon", "./widgets"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseRepository(tc.gitURL)
			if err == nil {
				t.Fatalf("ParseRepository(%q) = %s/%s, want an error", tc.gitURL, got.Owner, got.Name)
			}
			if !errors.Is(err, ErrNotGitHubRepository) {
				t.Errorf("ParseRepository(%q) error = %v, want ErrNotGitHubRepository", tc.gitURL, err)
			}
			var typed *NotGitHubRepositoryError
			if !errors.As(err, &typed) {
				t.Errorf("ParseRepository(%q) error is %T, want *NotGitHubRepositoryError", tc.gitURL, err)
			}
		})
	}
}

// --- Client: URL, headers, filtering --------------------------------------

// ghiStub serves a canned response and records the request that produced it.
type ghiStub struct {
	t         *testing.T
	status    int
	headers   http.Header
	body      string
	gotPath   string
	gotQuery  url.Values
	gotRawQry string
	gotHead   http.Header
}

func (s *ghiStub) server() *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.gotPath = r.URL.Path
		s.gotQuery = r.URL.Query()
		s.gotRawQry = r.URL.RawQuery
		s.gotHead = r.Header.Clone()
		for k, vs := range s.headers {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		code := s.status
		if code == 0 {
			code = http.StatusOK
		}
		w.WriteHeader(code)
		fmt.Fprint(w, s.body)
	}))
	s.t.Cleanup(srv.Close)
	return srv
}

func ghiClient(t *testing.T, status int, headers http.Header, body string) (*Client, *ghiStub) {
	t.Helper()
	stub := &ghiStub{t: t, status: status, headers: headers, body: body}
	return &Client{BaseURL: stub.server().URL}, stub
}

const ghiOneIssue = `[{"number":7,"title":"Fix the parser","body":"detail",
	"labels":[{"name":"bug","color":"d73a4a"}],"state":"open",
	"html_url":"https://github.com/octo/widgets/issues/7",
	"updated_at":"2026-10-16T07:00:00Z"}]`

func TestListIssuesBuildsThePinnedRequest(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, ghiOneIssue)
	got, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if len(got) != 1 || got[0].Number != 7 {
		t.Fatalf("issues = %+v, want the single issue", got)
	}

	if want := "/repos/octo/widgets/issues"; stub.gotPath != want {
		t.Errorf("path = %q, want %q", stub.gotPath, want)
	}
	if gotState := stub.gotQuery.Get("state"); gotState != "open" {
		t.Errorf("state = %q, want open (the default)", gotState)
	}
	if per := stub.gotQuery.Get("per_page"); per != "50" {
		t.Errorf("per_page = %q, want 50", per)
	}
	if l := stub.gotQuery.Get("labels"); l != "" {
		t.Errorf("labels = %q, want the parameter absent when no label was asked for", l)
	}
	if a := stub.gotHead.Get("Accept"); a != acceptHeader {
		t.Errorf("Accept = %q, want %q", a, acceptHeader)
	}
	if v := stub.gotHead.Get(apiVersionHead); v != apiVersion {
		t.Errorf("%s = %q, want %q", apiVersionHead, v, apiVersion)
	}
	if ua := stub.gotHead.Get("User-Agent"); ua == "" {
		t.Error("User-Agent must be set; GitHub refuses anonymous requests without one")
	}
	if auth := stub.gotHead.Get("Authorization"); auth != "" {
		t.Errorf("Authorization = %q, want none: no token was passed to this call", auth)
	}
}

func TestListIssuesSendsTheBearerHeaderOnlyWhenATokenIsPassed(t *testing.T) {
	const token = "ghp_testtoken1234567890"
	c, stub := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{}, token); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got := stub.gotHead.Get("Authorization"); got != "Bearer "+token {
		t.Errorf("Authorization = %q, want %q", got, "Bearer "+token)
	}

	// An empty token sends no Authorization header at all, not even an empty
	// one: the request is byte-for-byte the anonymous request of ADR-0031.
	c2, stub2 := ghiClient(t, 0, nil, `[]`)
	if _, err := c2.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{}, ""); err != nil {
		t.Fatalf("ListIssues (no token): %v", err)
	}
	if got := stub2.gotHead.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want the header absent for an empty token", got)
	}
}

func TestListIssuesNeverLeavesATokenInTheURL(t *testing.T) {
	// Defense in depth: the token rides the header, so neither the path the
	// server saw nor any error built from the request may carry it.
	c, stub := ghiClient(t, http.StatusNotFound, nil, `{"message":"Not Found"}`)
	_, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"},
		IssueQuery{}, "secret-token-value")
	if !errors.Is(err, ErrRepositoryNotFound) {
		t.Fatalf("err = %v, want ErrRepositoryNotFound", err)
	}
	if strings.Contains(stub.gotPath, "secret-token-value") {
		t.Errorf("path = %q must not carry the token", stub.gotPath)
	}
	if strings.Contains(err.Error(), "secret-token-value") {
		t.Errorf("error %q must not name the token", err)
	}
}

func TestListIssuesPassesStateAndLabel(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{State: StateAll, Label: "ready-for-agent", PerPage: 5}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got := stub.gotQuery.Get("state"); got != "all" {
		t.Errorf("state = %q, want all", got)
	}
	if got := stub.gotQuery.Get("labels"); got != "ready-for-agent" {
		t.Errorf("labels = %q, want ready-for-agent", got)
	}
	if got := stub.gotQuery.Get("per_page"); got != "5" {
		t.Errorf("per_page = %q, want 5", got)
	}
}

func TestListIssuesRejectsAnUnknownState(t *testing.T) {
	c, _ := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"},
		IssueQuery{State: "everything"}, ""); err == nil {
		t.Fatal("state=everything: want an error, got none")
	}
}

func TestListIssuesEscapesTheRepositoryNameIntoThePath(t *testing.T) {
	// A name with a slash must not become a second path segment: that is how
	// "/repos/o/r/../../someother/thing" style escapes are stopped.
	c, stub := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widg ets/../../x"},
		IssueQuery{}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if strings.HasPrefix(stub.gotPath, "/repos/octo/widgets/..") {
		t.Errorf("path = %q: the name escaped its segment", stub.gotPath)
	}
	if !strings.HasPrefix(stub.gotPath, "/repos/octo/") {
		t.Errorf("path = %q, want it to stay under /repos/octo/", stub.gotPath)
	}
}

func TestListIssuesSkipsPullRequests(t *testing.T) {
	body := `[
		{"number":1,"title":"a real issue","labels":[],"state":"open",
		 "html_url":"https://github.com/o/r/issues/1","updated_at":"2026-10-16T00:00:00Z"},
		{"number":2,"title":"a pull request","labels":[],"state":"open",
		 "html_url":"https://github.com/o/r/pull/2","updated_at":"2026-10-16T00:00:00Z",
		 "pull_request":{"url":"https://api.github.com/repos/o/r/pulls/2"}},
		{"number":3,"title":"null pull_request is still an issue","labels":[],"state":"open",
		 "html_url":"https://github.com/o/r/issues/3","updated_at":"2026-10-16T00:00:00Z",
		 "pull_request":null}
	]`
	c, _ := ghiClient(t, 0, nil, body)
	got, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d issues (%+v), want 2: the pull request must be dropped", len(got), got)
	}
	if got[0].Number != 1 || got[1].Number != 3 {
		t.Errorf("numbers = %d, %d, want 1 and 3", got[0].Number, got[1].Number)
	}
}

// --- ADR-0056 part 2: issue-trigger poll query parameters -----------------

func TestListIssuesPassesSinceAndSortForTheIssuePoll(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, `[]`)
	since := time.Unix(1760000000, 0)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{State: "open", Sort: "updated", Since: since, PerPage: 100}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got := stub.gotQuery.Get("sort"); got != "updated" {
		t.Errorf("sort = %q, want updated", got)
	}
	if got := stub.gotQuery.Get("since"); got != "2025-10-09T08:53:20Z" {
		t.Errorf("since = %q, want 2025-10-09T08:53:20Z", got)
	}
	if got := stub.gotQuery.Get("per_page"); got != "100" {
		t.Errorf("per_page = %q, want 100", got)
	}
}

// TestListIssuesSendsSinceAsISO8601NotUnixSeconds guards the lab failure
// (dbirks/comms-test-repo-1): once a trigger's cursor is set every poll died
// with 422 "The since parameter needs to be in ISO 8601 format:
// YYYY-MM-DDTHH:MM:SSZ" because the cursor rode the wire as Unix seconds.
// The request must carry the ISO form, in UTC, whatever zone the cursor came
// from, and never a bare epoch count.
func TestListIssuesSendsSinceAsISO8601NotUnixSeconds(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, `[]`)
	// 2026-10-25T12:31:26+02:00 is 2026-10-25T10:31:26Z: the rendering must
	// convert to UTC, not just print the wall clock GitHub will not accept.
	since := time.Date(2026, 10, 25, 12, 31, 26, 0, time.FixedZone("UTC+2", 2*3600))
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{State: "open", Sort: "updated", Since: since, PerPage: 100}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got, want := stub.gotQuery.Get("since"), "2026-10-25T10:31:26Z"; got != want {
		t.Errorf("since = %q, want %q", got, want)
	}
	// The exact wire form: url.Values.Encode escapes the colons, and the
	// parameters ride in their sorted order.
	if want := "per_page=100&since=2026-10-25T10%3A31%3A26Z&sort=updated&state=open"; stub.gotRawQry != want {
		t.Errorf("RawQuery = %q, want %q", stub.gotRawQry, want)
	}
	if strings.Contains(stub.gotRawQry, "1792924286") {
		t.Errorf("RawQuery = %q must not carry Unix seconds", stub.gotRawQry)
	}
}

func TestListIssuesPassesAnyOfLabelsForTheIssuePoll(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "octo", Name: "widgets"},
		IssueQuery{State: "open", Labels: []string{"bug", "docs"}, PerPage: 100}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got := stub.gotQuery.Get("labels"); got != "bug,docs" {
		t.Errorf("labels = %q, want bug,docs", got)
	}
}

// --- ListIssueEvents ----------------------------------------------------

const ghiLabeledEvents = `[{"event":"subscribed","created_at":"2026-10-16T06:00:00Z"},
	{"event":"labeled","created_at":"2026-10-16T06:30:00Z","label":{"name":"comm:go","color":"ededed"}}]`

func TestListIssueEventsReadsTheTimelineWithItsPinHeaders(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, ghiLabeledEvents)
	got, err := c.ListIssueEvents(context.Background(), Repository{Owner: "octo", Name: "widgets"}, 11, "tok-1")
	if err != nil {
		t.Fatalf("ListIssueEvents: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("events = %+v, want both timeline rows", got)
	}
	if got[1].Event != "labeled" || got[1].LabelName != "comm:go" {
		t.Errorf("labeled event = %+v, want event=labeled name=comm:go", got[1])
	}
	want := time.Date(2026, 10, 16, 6, 30, 0, 0, time.UTC)
	if !got[1].CreatedAt.Equal(want) {
		t.Errorf("created_at = %v, want %v", got[1].CreatedAt, want)
	}
	if stub.gotPath != "/repos/octo/widgets/issues/11/events" {
		t.Errorf("path = %q, want the issue events endpoint", stub.gotPath)
	}
	if per := stub.gotQuery.Get("per_page"); per != "100" {
		t.Errorf("per_page = %q, want 100", per)
	}
	if a := stub.gotHead.Get("Accept"); a != acceptHeader {
		t.Errorf("Accept = %q, want %q", a, acceptHeader)
	}
	if auth := stub.gotHead.Get("Authorization"); auth != "Bearer tok-1" {
		t.Errorf("Authorization = %q, want the per-call bearer", auth)
	}
}

func TestListIssueEventsRefusesNonPositiveNumbers(t *testing.T) {
	c, _ := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssueEvents(context.Background(), Repository{Owner: "o", Name: "r"}, 0, ""); err == nil {
		t.Fatal("ListIssueEvents(issue 0) = nil error, want a refusal that never hits the wire")
	}
}
