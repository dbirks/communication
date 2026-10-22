package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Client is the anonymous HTTP implementation of IssueLister. It is safe for
// concurrent use: its only mutable fields are set at construction (New) or by
// a test, never during a request.
type Client struct {
	// BaseURL is the API root; empty means DefaultBaseURL. Tests replace it
	// with an httptest server URL.
	BaseURL string
	// HTTP is the client used for the call; nil means one with the 10 s
	// requestTimeout.
	HTTP *http.Client
}

// New returns a Client against api.github.com with the package timeout.
func New() *Client { return &Client{} }

// interface check: Client is an IssueLister.
var _ IssueLister = (*Client)(nil)

func (c *Client) base() string {
	if c.BaseURL == "" {
		return DefaultBaseURL
	}
	return strings.TrimRight(c.BaseURL, "/")
}

func (c *Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: requestTimeout}
}

// rawIssue is the wire shape of one item from
// GET /repos/{owner}/{repo}/issues. Only the members this adapter forwards are
// decoded.
type rawIssue struct {
	Number    int             `json:"number"`
	Title     string          `json:"title"`
	Body      string          `json:"body"`
	State     string          `json:"state"`
	HTMLURL   string          `json:"html_url"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
	Labels    []rawLabel      `json:"labels"`
	PR        json.RawMessage `json:"pull_request"`
}

// rawLabel covers both shapes GitHub sends: the object form ({"name": "bug"})
// and, on reduced representations, a bare string. UnmarshalJSON accepts each.
type rawLabel struct{ Name string }

func (l *rawLabel) UnmarshalJSON(raw []byte) error {
	var obj struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		l.Name = obj.Name
		if l.Name == "" {
			l.Name = obj.Value
		}
		return nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return fmt.Errorf("github: label is neither an object nor a string: %w", err)
	}
	l.Name = s
	return nil
}

// ListIssues fetches one page of a repository's issues, anonymously.
//
// The request URL is built from escaped path segments only, so a repository
// row whose owner/name came from anywhere cannot steer this request elsewhere
// (`05`: an adapter is not a general-purpose fetcher).
//
// Pull requests are dropped: that endpoint lists issues and pull requests
// together, and a run started "from an issue" must not quietly be a run
// started from a PR.
func (c *Client) ListIssues(ctx context.Context, repo Repository, q IssueQuery) ([]Issue, error) {
	if repo.Owner == "" || repo.Name == "" {
		return nil, &NotGitHubRepositoryError{GitURL: repo.String()}
	}
	state := strings.TrimSpace(q.State)
	if state == "" {
		state = StateOpen
	}
	if !validState(state) {
		return nil, fmt.Errorf("github: unknown state %q (want open, closed or all)", state)
	}
	per := q.PerPage
	switch {
	case per <= 0:
		per = defaultPerPage
	case per > maxPerPage:
		per = maxPerPage
	}

	query := url.Values{
		"state":    []string{state},
		"per_page": []string{strconv.Itoa(per)},
	}
	if sort := strings.TrimSpace(q.Sort); sort != "" {
		query.Set("sort", sort)
	}
	if len(q.Labels) > 0 {
		query.Set("labels", strings.Join(q.Labels, ","))
	} else if label := strings.TrimSpace(q.Label); label != "" {
		query.Set("labels", label)
	}
	if !q.Since.IsZero() {
		query.Set("since", strconv.FormatInt(q.Since.Unix(), 10))
	}
	target := c.base() + "/repos/" + url.PathEscape(repo.Owner) + "/" +
		url.PathEscape(repo.Name) + "/issues?" + query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("github: build request: %w", err)
	}
	req.Header.Set("Accept", acceptHeader)
	req.Header.Set(apiVersionHead, apiVersion)
	req.Header.Set("User-Agent", userAgent)
	// Deliberately no Authorization header: anonymous only (package doc).

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
	var items []rawIssue
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("github: decode issue list: %w", err)
	}

	out := make([]Issue, 0, len(items))
	for _, it := range items {
		if len(it.PR) > 0 && !isJSONNull(it.PR) {
			continue // a pull request, not an issue
		}
		text, truncated := truncateBody(it.Body)
		out = append(out, Issue{
			Number:        it.Number,
			Title:         it.Title,
			Body:          text,
			Labels:        labelNames(it.Labels),
			HTMLURL:       it.HTMLURL,
			State:         it.State,
			CreatedAt:     parseTime(it.CreatedAt),
			UpdatedAt:     parseTime(it.UpdatedAt),
			BodyTruncated: truncated,
		})
	}
	return out, nil
}

// classify maps an upstream response onto the typed errors a handler needs.
// A refused response is consumed here (its `message` becomes the error's
// detail), so callers only read a body classify accepted.
func classify(resp *http.Response, repo Repository) error {
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return &NotFoundError{Repository: repo.String()}

	case resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusTooManyRequests:
		// A 403 is GitHub's rate-limit answer when the anonymous budget is
		// spent, but it is also the answer to other refusals — so only the
		// spent-budget header promotes it.
		if strings.TrimSpace(resp.Header.Get("X-RateLimit-Remaining")) == "0" {
			e := &RateLimitError{Reset: parseUnixHeader(resp.Header.Get("X-RateLimit-Reset"))}
			e.Limit, _ = strconv.Atoi(resp.Header.Get("X-RateLimit-Limit"))
			return e
		}
		return &APIError{Status: resp.StatusCode, Message: messageOf(resp)}

	case resp.StatusCode >= 400:
		return &APIError{Status: resp.StatusCode, Message: messageOf(resp)}

	default:
		return nil
	}
}

// messageOf reads GitHub's `message` member out of an error body. Best effort
// over a 1 KiB sample: a body that is not GitHub's error shape contributes
// nothing, and the status code already says what happened.
func messageOf(resp *http.Response) string {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
	if err != nil {
		return ""
	}
	var doc struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	return doc.Message
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// truncateBody clips a body to MaxBodyBytes and reports whether it clipped.
// The cut walks back off a split UTF-8 rune rather than emitting a replacement
// character, so what a browser stores is what GitHub wrote, shortened.
func truncateBody(s string) (string, bool) {
	if len(s) <= MaxBodyBytes {
		return s, false
	}
	cut := s[:MaxBodyBytes]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r == utf8.RuneError && size <= 1 {
			cut = cut[:len(cut)-1]
			continue
		}
		break
	}
	return cut, true
}

// labelNames reduces wire labels to names, dropping any entry with no name at
// all so an empty string never rides into a label filter.
func labelNames(in []rawLabel) []string {
	out := make([]string, 0, len(in))
	for _, l := range in {
		if l.Name != "" {
			out = append(out, l.Name)
		}
	}
	return out
}

// parseTime reads an RFC 3339 timestamp. An unparseable one is the zero Time
// rather than a failed call: a malformed `updated_at` does not make the issue
// unusable as a run's starting point.
func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

// parseUnixHeader reads a Unix-seconds header (X-RateLimit-Reset).
func parseUnixHeader(s string) time.Time {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0).UTC()
}
