package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Issue events (the timeline): the second read of the read-only adapter, and
// the witness the issue trigger's `labeled` arm needs. The issues LIST says
// which labels an issue carries NOW and when anything about it last moved;
// it cannot say WHEN a given label was applied. ADR-0056's no-backfill rule
// for `labeled` (amendment of 2026-10-25) asks exactly that question — "was
// this label applied at or after the trigger's created_at?" — and only the
// per-issue event list answers it: a comment or an edit bumps updated_at
// without any label riding along.

// IssueEvent is one row of an issue's timeline, kept to the two facts the
// trigger reads: which event happened, and when. LabelName carries the
// label's name for `labeled`/`unlabeled` events (GitHub's `label.name`) and
// is empty for every other event.
type IssueEvent struct {
	Event     string
	CreatedAt time.Time
	LabelName string
}

// IssueEventLister reads an issue's timeline. It is deliberately NOT folded
// into IssueLister: the routes that only list issues keep their existing
// fakes, and callers that care about event times assert for this capability
// and degrade honestly when a lister does not carry it.
type IssueEventLister interface {
	ListIssueEvents(ctx context.Context, repo Repository, issueNumber int, token string) ([]IssueEvent, error)
}

// Client is an IssueEventLister too: the fire's lister IS the Client in
// production (github.New()), so the amendment's preferred evidence path is
// the one that actually runs.
var _ IssueEventLister = (*Client)(nil)

// ListIssueEvents reads GET /repos/{owner}/{repo}/issues/{n}/events,
// paginated to maxEventPages: GitHub answers events OLDEST first, so a
// recent labeled event on a busy issue lives on a later page — and "I cannot
// see the label event" is exactly the question the no-backfill rule must
// never answer wrongly by reading only page one. Errors are the same typed
// answers ListIssues gives.
func (c *Client) ListIssueEvents(ctx context.Context, repo Repository, issueNumber int, token string) ([]IssueEvent, error) {
	if repo.Owner == "" || repo.Name == "" {
		return nil, &NotGitHubRepositoryError{GitURL: repo.String()}
	}
	if issueNumber <= 0 {
		return nil, fmt.Errorf("github: issue number %d is not a positive integer", issueNumber)
	}
	var out []IssueEvent
	for page := 1; page <= maxEventPages; page++ {
		query := url.Values{"per_page": []string{strconv.Itoa(100)}, "page": []string{strconv.Itoa(page)}}
		items, err := c.getIssueEventPage(ctx, repo, issueNumber, token, query)
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			out = append(out, IssueEvent{
				Event:     it.Event,
				CreatedAt: parseTime(it.CreatedAt),
				LabelName: it.Label.Name,
			})
		}
		if len(items) < 100 {
			return out, nil // the last page
		}
	}
	return out, nil
}

// maxEventPages bounds the timeline walk at 500 events. Past that the caller
// reports what it saw, and the trigger's "the label event is not visible
// (yet)" rule — which holds the cursor and retries rather than firing or
// backfill-refusing — is exactly the honest answer for a read that may have
// been truncated or lagged.
const maxEventPages = 5

func (c *Client) getIssueEventPage(ctx context.Context, repo Repository, issueNumber int, token string, query url.Values) ([]rawIssueEvent, error) {
	target := c.base() + "/repos/" + url.PathEscape(repo.Owner) + "/" +
		url.PathEscape(repo.Name) + "/issues/" + strconv.Itoa(issueNumber) + "/events?" + query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("github: build request: %w", err)
	}
	req.Header.Set("Accept", acceptHeader)
	req.Header.Set(apiVersionHead, apiVersion)
	req.Header.Set("User-Agent", userAgent)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: GET %s: %w", target, err)
	}
	defer resp.Body.Close()

	if err := classify(resp, repo); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("github: read response: %w", err)
	}
	var items []rawIssueEvent
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("github: decode issue events: %w", err)
	}
	return items, nil
}

// rawIssueEvent is GitHub's wire shape, narrowed. GitHub may answer `null`
// for created_at on events it never timestamped (webhook-imported rows);
// parseTime turns that into the zero time, which is Before any trigger's
// created_at and therefore never fires — the honest default.
type rawIssueEvent struct {
	Event     string `json:"event"`
	CreatedAt string `json:"created_at"`
	Label     struct {
		Name string `json:"name"`
	} `json:"label"`
}

// IssueClock answers "what time is it on GitHub, right now?" — every GitHub
// response carries a Date header on GitHub's own clock, and GET /rate_limit
// is the cheapest response to read it from (anonymous-OK, touches nothing,
// exists on GHES too). It exists because the gh-loop of 2026-10-25 proved
// that trigger created_at (the database clock) and event created_at (GitHub's
// clock) can be 50 seconds apart on one healthy deployment — NTP discipline
// is not a cross-service agreement — and a no-backfill rule that compares
// them directly silently skipped issue #16: labeled after its trigger by
// GitHub's own clock, "before" it by the naive one. A rule that compares two
// clocks must first put them on one.
type IssueClock interface {
	GithubNow(ctx context.Context, token string) (time.Time, error)
}

var _ IssueClock = (*Client)(nil)

// GithubNow reads the Date header of one GET /rate_limit response. The token
// is the same per-call credential the listing uses (a credentialed repository
// budgets its own rate pool); empty asks anonymously. A missing or malformed
// Date header is an error — "GitHub's clock is unreadable" must be a declared
// fallback for the caller, never a silent guess.
func (c *Client) GithubNow(ctx context.Context, token string) (time.Time, error) {
	target := c.base() + "/rate_limit"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return time.Time{}, fmt.Errorf("github: build request: %w", err)
	}
	req.Header.Set("Accept", acceptHeader)
	req.Header.Set(apiVersionHead, apiVersion)
	req.Header.Set("User-Agent", userAgent)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return time.Time{}, fmt.Errorf("github: GET %s: %w", target, err)
	}
	defer resp.Body.Close()
	if err := classify(resp, Repository{Owner: "github", Name: "rate_limit"}); err != nil {
		return time.Time{}, err
	}
	// Drain the small body so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	raw := resp.Header.Get("Date")
	if raw == "" {
		return time.Time{}, errors.New("github: the response carried no Date header")
	}
	at, err := http.ParseTime(raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("github: unparseable Date header %q: %w", raw, err)
	}
	return at.UTC(), nil
}
