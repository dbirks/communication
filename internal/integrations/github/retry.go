package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Transient-upstream retry (acceptance run 42164529404, verification pass 2).
//
// The ISSUES lane reads GitHub live through ListIssues, and a single
// github.com wobble — a 5xx, a secondary-limit 429/403, a connection reset —
// emptied the lane for a human who could see the tracker in their browser at
// the same moment. One read is now up to three attempts (2 retries) with a
// short backoff, bounded by the caller's context. This is the shared read
// every consumer rides — the repo-page issue list, the issue picker and the
// notes generator all call ListIssues — so the retry belongs here, on the
// adapter, not on one handler.
//
// What is never retried, because repeating it cannot change the answer:
// 401, 404, 422, and the primary spent-budget refusal (the 403/429 whose
// X-RateLimit-Remaining is 0, which classify already types as
// *RateLimitError — ErrRateLimited's own contract says "back off, do not
// retry immediately"). Those report exactly as before.
const (
	// upstreamMaxRetries are the repeats after the first attempt.
	upstreamMaxRetries = 2
	// upstreamRetryAfterCap is the longest a Retry-After instruction may
	// make this call wait — the request context belongs to a browser waiting
	// on a lane, so an hour from GitHub is answered with five seconds.
	upstreamRetryAfterCap = 5 * time.Second
)

// upstreamBackoffs are the per-attempt base delays, short by design: a
// transient wobble clears in under a second, and the whole retry sequence
// (500 ms + 1.5 s + three request timeouts) stays inside one impatient page
// load.
var upstreamBackoffs = [...]time.Duration{
	500 * time.Millisecond,
	1500 * time.Millisecond,
}

// upstreamBaseDelay is the backoff scheduled after attempt `attempt`
// (0-based); attempts past the table reuse the last rung.
func upstreamBaseDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= len(upstreamBackoffs) {
		return upstreamBackoffs[len(upstreamBackoffs)-1]
	}
	return upstreamBackoffs[attempt]
}

// retryAfterOf reads GitHub's Retry-After instruction: delta-seconds (the
// form the API sends) or an HTTP-date. ok is false when the header is
// absent or unreadable, which means "no instruction", not "wait zero".
func retryAfterOf(resp *http.Response) (d time.Duration, ok bool) {
	if resp == nil {
		return 0, false
	}
	v := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if v == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(v); err == nil {
		if n < 0 {
			return 0, false
		}
		return time.Duration(n) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// transientUpstream reports whether classify's refusal is a wobble worth
// repeating. Only a classified *APIError can be one: NotFoundError is a fact
// about the repository and RateLimitError is the spent-budget refusal the
// adapter's own contract says to back off from, never re-knock.
func transientUpstream(resp *http.Response, err error) bool {
	var rl *RateLimitError
	if errors.As(err, &rl) {
		return false
	}
	var api *APIError
	if !errors.As(err, &api) {
		return false
	}
	switch {
	case api.Status >= 500:
		// GitHub's own failure; a repeat usually lands elsewhere.
		return true
	case api.Status == http.StatusTooManyRequests:
		// 429 without the spent-budget header (that one is a
		// RateLimitError and was refused above).
		return true
	case api.Status == http.StatusForbidden:
		// A 403 is only transient when the upstream says when to come
		// back, or names the secondary limit — a bare 403 is a
		// permission answer, and repeating it is noise.
		if _, ok := retryAfterOf(resp); ok {
			return true
		}
		return strings.Contains(strings.ToLower(api.Message), "secondary rate limit")
	default:
		return false
	}
}

// upstreamDelay is how long to wait before the repeat after attempt `attempt`
// (0-based): the scheduled backoff, at least the upstream's Retry-After if it
// gave one, and never more than the cap.
func upstreamDelay(attempt int, resp *http.Response) time.Duration {
	d := upstreamBaseDelay(attempt)
	if ra, ok := retryAfterOf(resp); ok && ra > d {
		d = ra
	}
	if d > upstreamRetryAfterCap {
		d = upstreamRetryAfterCap
	}
	return d
}

// sleepContext waits d, or reports the context's end — the retry loop is
// bounded by the caller's request context, never by the backoff table.
func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// sleeper is the wait seam: tests replace Client.sleep so a Retry-After of
// sixty seconds is checked as a number instead of slept through.
func (c *Client) sleeper() func(context.Context, time.Duration) error {
	if c.sleep != nil {
		return c.sleep
	}
	return sleepContext
}

// getRetried performs the pinned GET behind the issue read — same headers,
// same URL, one Authorization header if the call carries a token — repeating
// transient upstream failures up to upstreamMaxRetries times. A returned
// response is a 2xx/3xx whose body is still unread; a returned error is the
// LAST attempt's classified failure, so a caller that gave up sees the same
// typed error (and the same 502 problem upstream) it saw before the retry
// existed.
func (c *Client) getRetried(ctx context.Context, target string, repo Repository, token string) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, fmt.Errorf("github: build request: %w", err)
		}
		req.Header.Set("Accept", acceptHeader)
		req.Header.Set(apiVersionHead, apiVersion)
		req.Header.Set("User-Agent", userAgent)
		if token != "" {
			// ADR-0061 §5: the per-call credential is re-sent on every
			// attempt and never stored anywhere in between.
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := c.client().Do(req)
		if err != nil {
			// A transport failure (timeout, reset, refused connection).
			// A caller whose context is done has stopped waiting; so do we.
			gone := fmt.Errorf("github: GET %s: %w", target, err)
			if ctx.Err() != nil || attempt >= upstreamMaxRetries {
				return nil, gone
			}
			if serr := c.sleeper()(ctx, upstreamDelay(attempt, nil)); serr != nil {
				return nil, gone
			}
			continue
		}

		cerr := classify(resp, repo)
		if cerr == nil {
			return resp, nil
		}
		// A refused attempt: classify already consumed the error body,
		// and the connection's response is spent either way.
		_ = resp.Body.Close()
		if !transientUpstream(resp, cerr) || attempt >= upstreamMaxRetries {
			return nil, cerr
		}
		if serr := c.sleeper()(ctx, upstreamDelay(attempt, resp)); serr != nil {
			return nil, cerr
		}
	}
}
