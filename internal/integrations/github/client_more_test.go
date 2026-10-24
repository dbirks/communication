package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestListIssuesTruncatesBodiesToFourThousandBytes(t *testing.T) {
	long := strings.Repeat("a", MaxBodyBytes+250)
	raw, err := json.Marshal([]rawIssue{{Number: 1, Title: "t", Body: long, State: "open"}})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	c, _ := ghiClient(t, 0, nil, string(raw))
	got, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d issues, want 1", len(got))
	}
	if len(got[0].Body) != MaxBodyBytes {
		t.Errorf("body length = %d, want %d", len(got[0].Body), MaxBodyBytes)
	}
	if !got[0].BodyTruncated {
		t.Error("BodyTruncated = false, want true: the caller must be able to say so")
	}

	// A short body is untouched and not flagged.
	c2, _ := ghiClient(t, 0, nil, `[{"number":2,"title":"t","body":"short","state":"open"}]`)
	issue, err := c2.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if issue[0].Body != "short" || issue[0].BodyTruncated {
		t.Errorf("body = %q truncated=%v, want %q untouched", issue[0].Body, issue[0].BodyTruncated, "short")
	}
}

func TestListIssuesTruncationNeverSplitsARune(t *testing.T) {
	// 'é' is two bytes; with MaxBodyBytes odd-relative to the filler the cut
	// lands mid-rune unless the walk-back works.
	body := strings.Repeat("a", MaxBodyBytes-1) + "étail"
	raw, err := json.Marshal([]rawIssue{{Number: 1, Body: body}})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	c, _ := ghiClient(t, 0, nil, string(raw))
	got, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if !isValidUTF8(got[0].Body) {
		t.Errorf("truncated body is not valid UTF-8: %q", lastBytes(got[0].Body, 8))
	}
	if len(got[0].Body) != MaxBodyBytes-1 {
		t.Errorf("body length = %d, want %d (the split rune dropped)", len(got[0].Body), MaxBodyBytes-1)
	}
	if !got[0].BodyTruncated {
		t.Error("BodyTruncated = false, want true")
	}
}

func TestListIssuesReadsLabelsTimeAndURL(t *testing.T) {
	body := `[{"number":12,"title":"Ship W3","body":"b",
		"labels":[{"name":"ready-for-agent"},{"name":"bug"}],"state":"closed",
		"html_url":"https://github.com/octo/widgets/issues/12",
		"updated_at":"2026-10-16T07:33:53Z"}]`
	c, _ := ghiClient(t, 0, nil, body)
	got, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	i := got[0]
	if i.Number != 12 || i.Title != "Ship W3" || i.State != "closed" {
		t.Errorf("issue = %+v, want number 12 / title Ship W3 / state closed", i)
	}
	if strings.Join(i.Labels, ",") != "ready-for-agent,bug" {
		t.Errorf("labels = %v, want [ready-for-agent bug]", i.Labels)
	}
	if i.HTMLURL != "https://github.com/octo/widgets/issues/12" {
		t.Errorf("html_url = %q", i.HTMLURL)
	}
	if !i.UpdatedAt.Equal(time.Date(2026, 10, 16, 7, 33, 53, 0, time.UTC)) {
		t.Errorf("updated_at = %v, want 2026-10-16T07:33:53Z", i.UpdatedAt)
	}

	// A bare-string label form and an unreadable timestamp: neither fails the
	// call, and the time stays zero rather than becoming "now".
	body = `[{"number":13,"title":"t","body":"","labels":["enhancement"],
		"state":"open","html_url":"","updated_at":"not a time"}]`
	c2, _ := ghiClient(t, 0, nil, body)
	got, err = c2.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err != nil {
		t.Fatalf("ListIssues (string labels): %v", err)
	}
	if strings.Join(got[0].Labels, ",") != "enhancement" {
		t.Errorf("labels = %v, want [enhancement]", got[0].Labels)
	}
	if !got[0].UpdatedAt.IsZero() {
		t.Errorf("updated_at = %v, want zero for an unparseable value", got[0].UpdatedAt)
	}
}

func TestListIssuesTypedErrors(t *testing.T) {
	ctx := context.Background()
	repo := Repository{Owner: "o", Name: "r"}

	t.Run("404 is ErrRepositoryNotFound", func(t *testing.T) {
		c, _ := ghiClient(t, http.StatusNotFound, nil,
			`{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}`)
		_, err := c.ListIssues(ctx, repo, IssueQuery{}, "")
		if !errors.Is(err, ErrRepositoryNotFound) {
			t.Fatalf("err = %v, want ErrRepositoryNotFound", err)
		}
		var nf *NotFoundError
		if !errors.As(err, &nf) || nf.Repository != "o/r" {
			t.Errorf("err = %#v, want a *NotFoundError naming o/r", err)
		}
		if !strings.Contains(err.Error(), "private") {
			t.Errorf("err = %q, want it to say an anonymous request cannot read private repositories", err)
		}
	})

	t.Run("403 with a spent budget is ErrRateLimited", func(t *testing.T) {
		c, _ := ghiClient(t, http.StatusForbidden, http.Header{
			"X-Ratelimit-Remaining": []string{"0"},
			"X-Ratelimit-Limit":     []string{"60"},
			"X-Ratelimit-Reset":     []string{"1790000000"},
		}, `{"message":"API rate limit exceeded for IP address."}`)
		_, err := c.ListIssues(ctx, repo, IssueQuery{}, "")
		if !errors.Is(err, ErrRateLimited) {
			t.Fatalf("err = %v, want ErrRateLimited", err)
		}
		var rl *RateLimitError
		if !errors.As(err, &rl) {
			t.Fatalf("err = %T, want *RateLimitError", err)
		}
		if rl.Limit != 60 {
			t.Errorf("Limit = %d, want 60", rl.Limit)
		}
		if want := time.Unix(1790000000, 0).UTC(); !rl.Reset.Equal(want) {
			t.Errorf("Reset = %v, want %v", rl.Reset, want)
		}
		if !strings.Contains(err.Error(), "resets") {
			t.Errorf("err = %q, want it to name the reset time", err)
		}
	})

	t.Run("429 with a spent budget is ErrRateLimited too", func(t *testing.T) {
		c, _ := ghiClient(t, http.StatusTooManyRequests,
			http.Header{"X-Ratelimit-Remaining": []string{"0"}}, `{"message":"slow down"}`)
		if _, err := c.ListIssues(ctx, repo, IssueQuery{}, ""); !errors.Is(err, ErrRateLimited) {
			t.Fatalf("err = %v, want ErrRateLimited", err)
		}
	})

	t.Run("403 without the header is not a rate limit", func(t *testing.T) {
		c, _ := ghiClient(t, http.StatusForbidden, nil, `{"message":"Forbidden"}`)
		_, err := c.ListIssues(ctx, repo, IssueQuery{}, "")
		if errors.Is(err, ErrRateLimited) {
			t.Fatalf("err = %v: a plain 403 must not be reported as a spent budget", err)
		}
		var api *APIError
		if !errors.As(err, &api) || api.Status != http.StatusForbidden || api.Message != "Forbidden" {
			t.Fatalf("err = %v (%T), want *APIError{403, Forbidden}", err, err)
		}
	})

	t.Run("500 carries the upstream message", func(t *testing.T) {
		c, _ := ghiClient(t, http.StatusInternalServerError, nil, `{"message":"boom"}`)
		_, err := c.ListIssues(ctx, repo, IssueQuery{}, "")
		var api *APIError
		if !errors.As(err, &api) || api.Status != 500 || api.Message != "boom" {
			t.Fatalf("err = %v, want *APIError{500, boom}", err)
		}
	})

	t.Run("a body that is not a JSON array is a decode failure", func(t *testing.T) {
		c, _ := ghiClient(t, 0, nil, `<html>not json</html>`)
		if _, err := c.ListIssues(ctx, repo, IssueQuery{}, ""); err == nil {
			t.Fatal("want a decode error, got none")
		} else if !strings.Contains(err.Error(), "decode") {
			t.Errorf("err = %v, want it to say the decode failed", err)
		}
	})
}

func TestListIssuesClampsPerPageAndRefusesAnEmptyRepository(t *testing.T) {
	c, stub := ghiClient(t, 0, nil, `[]`)
	if _, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"},
		IssueQuery{PerPage: 5000}, ""); err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if got := stub.gotQuery.Get("per_page"); got != "100" {
		t.Errorf("per_page = %q, want the cap of 100", got)
	}

	if _, err := c.ListIssues(context.Background(), Repository{}, IssueQuery{}, ""); !errors.Is(err, ErrNotGitHubRepository) {
		t.Errorf("empty repository: err = %v, want ErrNotGitHubRepository", err)
	}
}

func TestClientDefaultsToTheRealAPIRoot(t *testing.T) {
	if got := (&Client{}).base(); got != DefaultBaseURL {
		t.Errorf("base() = %q, want %q", got, DefaultBaseURL)
	}
	if got := (&Client{BaseURL: "http://127.0.0.1:9/"}).base(); strings.HasSuffix(got, "/") {
		t.Errorf("base() = %q, want the trailing slash trimmed", got)
	}
	if c := (&Client{}).client(); c.Timeout != requestTimeout {
		t.Errorf("client timeout = %v, want %v", c.Timeout, requestTimeout)
	}
}

func isValidUTF8(s string) bool { return utf8.ValidString(s) }

func lastBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// TestListIssuesGivesUpOnASlowUpstream pins the timeout rule: a GitHub that
// never answers must return an error, not hang the handler. The default client
// carries the 10 s budget; here the same code path is exercised with a short
// one so the test finishes in milliseconds.
func TestListIssuesGivesUpOnASlowUpstream(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	// Cleanup order is LIFO, and srv.Close blocks until every handler returns:
	// the release must therefore be registered *after* it, so it runs first.
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })

	c := &Client{BaseURL: srv.URL, HTTP: &http.Client{Timeout: 25 * time.Millisecond}}
	_, err := c.ListIssues(context.Background(), Repository{Owner: "o", Name: "r"}, IssueQuery{}, "")
	if err == nil {
		t.Fatal("want a timeout error, got none")
	}
	if !strings.Contains(err.Error(), "GET") {
		t.Errorf("err = %v, want it to name the request that timed out", err)
	}
}
