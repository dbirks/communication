package github

import (
	"context"
	"encoding/json"
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

// ListIssueEvents reads GET /repos/{owner}/{repo}/issues/{n}/events — the
// issue events endpoint, per_page 100, one page: the trigger only asks
// whether a labeled event exists at or after a timestamp that is minutes or
// hours old, and a project whose issue has more than 100 lifetime events
// still answers inside the first page in every sane ordering GitHub has
// shipped (events come back oldest-first). Errors are the same typed
// answers ListIssues gives.
func (c *Client) ListIssueEvents(ctx context.Context, repo Repository, issueNumber int, token string) ([]IssueEvent, error) {
	if repo.Owner == "" || repo.Name == "" {
		return nil, &NotGitHubRepositoryError{GitURL: repo.String()}
	}
	if issueNumber <= 0 {
		return nil, fmt.Errorf("github: issue number %d is not a positive integer", issueNumber)
	}
	query := url.Values{"per_page": []string{strconv.Itoa(100)}}
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
	out := make([]IssueEvent, 0, len(items))
	for _, it := range items {
		out = append(out, IssueEvent{
			Event:     it.Event,
			CreatedAt: parseTime(it.CreatedAt),
			LabelName: it.Label.Name,
		})
	}
	return out, nil
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
