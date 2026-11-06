package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// Tests for the transient-upstream retry (retry.go), introduced after
// acceptance run 42164529404 pass 2: one GitHub 5xx emptied the ISSUES lane
// for a human whose browser still saw the tracker.

// scriptedReply is one canned answer from a retryStub.
type scriptedReply struct {
	status  int
	headers http.Header
	body    string
}

// retryStub answers request n with script[n], repeating the last entry
// forever, and records every hit and every wait the retry loop asked for so
// the backoff is checked as a number instead of slept through.
type retryStub struct {
	t      *testing.T
	script []scriptedReply

	mu    sync.Mutex
	hits  int
	waits []time.Duration
}

func newRetryStub(t *testing.T, script ...scriptedReply) (*Client, *retryStub) {
	t.Helper()
	stub := &retryStub{t: t, script: script}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.mu.Lock()
		n := stub.hits
		stub.hits++
		stub.mu.Unlock()
		reply := script[len(script)-1]
		if n < len(script) {
			reply = script[n]
		}
		for k, vs := range reply.headers {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		code := reply.status
		if code == 0 {
			code = http.StatusOK
		}
		w.WriteHeader(code)
		fmt.Fprint(w, reply.body)
	}))
	t.Cleanup(srv.Close)
	c := &Client{BaseURL: srv.URL}
	c.sleep = func(ctx context.Context, d time.Duration) error {
		stub.mu.Lock()
		stub.waits = append(stub.waits, d)
		stub.mu.Unlock()
		return ctx.Err()
	}
	return c, stub
}

func (s *retryStub) countHits() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

func (s *retryStub) countWaits() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.waits...)
}

const retryOneIssue = `[{"number":7,"title":"Fix the parser","body":"detail",` +
	`"state":"open","html_url":"https://github.com/octo/widgets/issues/7",` +
	`"updated_at":"2026-10-16T07:00:00Z"}]`

func retryIssues(ctx context.Context, c *Client) ([]Issue, error) {
	return c.ListIssues(ctx, Repository{Owner: "octo", Name: "widgets"}, IssueQuery{}, "")
}

// A 502 then 200 succeeds: the wobble never reaches the lane.
func TestListIssuesRetriesTransient502AndSucceeds(t *testing.T) {
	c, stub := newRetryStub(t,
		scriptedReply{status: http.StatusBadGateway, body: `{"message":"boom"}`},
		scriptedReply{body: retryOneIssue},
	)
	got, err := retryIssues(context.Background(), c)
	if err != nil {
		t.Fatalf("ListIssues after one 502: %v, want the retry to succeed", err)
	}
	if len(got) != 1 || got[0].Number != 7 {
		t.Fatalf("issues = %+v, want the single issue", got)
	}
	if got := stub.countHits(); got != 2 {
		t.Errorf("upstream hits = %d, want 2 (the 502 and the good page)", got)
	}
	if want := []time.Duration{500 * time.Millisecond}; !equalDurations(stub.countWaits(), want) {
		t.Errorf("waits = %v, want the first backoff rung %v", stub.countWaits(), want[0])
	}
}

// Three 502s report the upstream error exactly as a single attempt did —
// the retry changes when it asks again, never what a giving-up read says.
func TestListIssuesReportsUpstreamErrorAfterAllRetries(t *testing.T) {
	c, stub := newRetryStub(t,
		scriptedReply{status: http.StatusBadGateway, body: `{"message":"boom"}`},
	)
	_, err := retryIssues(context.Background(), c)
	var api *APIError
	if !errors.As(err, &api) || api.Status != http.StatusBadGateway || api.Message != "boom" {
		t.Fatalf("err = %v (%T), want the same *APIError{502, boom} a single attempt reported", err, err)
	}
	if got := stub.countHits(); got != 1+upstreamMaxRetries {
		t.Errorf("upstream hits = %d, want %d (the first try and %d retries)", got, 1+upstreamMaxRetries, upstreamMaxRetries)
	}
	if want := []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond}; !equalDurations(stub.countWaits(), want) {
		t.Errorf("waits = %v, want the %v schedule", stub.countWaits(), want)
	}
}

// Never retried: 401, 404, 422, and any spent-budget (primary) rate limit or
// bare 403 — repeating these cannot change the answer.
func TestListIssuesNeverRetriesPermanentRefusals(t *testing.T) {
	cases := []struct {
		name    string
		reply   scriptedReply
		wantErr error
	}{
		{"404", scriptedReply{status: http.StatusNotFound, body: `{"message":"Not Found"}`}, ErrRepositoryNotFound},
		{"401", scriptedReply{status: http.StatusUnauthorized, body: `{"message":"Bad credentials"}`}, nil},
		{"422", scriptedReply{status: http.StatusUnprocessableEntity, body: `{"message":"Validation Failed"}`}, nil},
		{"403 primary budget", scriptedReply{status: http.StatusForbidden,
			headers: http.Header{"X-Ratelimit-Remaining": []string{"0"}},
			body:    `{"message":"API rate limit exceeded"}`}, ErrRateLimited},
		{"403 bare", scriptedReply{status: http.StatusForbidden, body: `{"message":"Forbidden"}`}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, stub := newRetryStub(t, tc.reply)
			_, err := retryIssues(context.Background(), c)
			if err == nil {
				t.Fatal("want an error, got none")
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Errorf("err = %v, want %v", err, tc.wantErr)
			}
			if got := stub.countHits(); got != 1 {
				t.Errorf("upstream hits = %d, want exactly 1 (no retry on a permanent refusal)", got)
			}
			if len(stub.countWaits()) != 0 {
				t.Errorf("waits = %v, want none", stub.countWaits())
			}
		})
	}
}

// Retry-After is honoured (the wait grows to the instruction) and capped
// (a sixty-second instruction cannot hold a browser lane for a minute).
func TestListIssuesHonoursRetryAfterAndCapsIt(t *testing.T) {
	t.Run("honoured", func(t *testing.T) {
		c, stub := newRetryStub(t,
			scriptedReply{status: http.StatusTooManyRequests,
				headers: http.Header{"Retry-After": []string{"2"}},
				body:    `{"message":"slow down"}`},
			scriptedReply{body: retryOneIssue},
		)
		if _, err := retryIssues(context.Background(), c); err != nil {
			t.Fatalf("ListIssues: %v", err)
		}
		if want := []time.Duration{2 * time.Second}; !equalDurations(stub.countWaits(), want) {
			t.Errorf("waits = %v, want the upstream's 2 s instruction", stub.countWaits())
		}
	})
	t.Run("capped", func(t *testing.T) {
		c, stub := newRetryStub(t,
			scriptedReply{status: http.StatusTooManyRequests,
				headers: http.Header{"Retry-After": []string{"60"}},
				body:    `{"message":"slow down"}`},
			scriptedReply{body: retryOneIssue},
		)
		if _, err := retryIssues(context.Background(), c); err != nil {
			t.Fatalf("ListIssues: %v", err)
		}
		if want := []time.Duration{upstreamRetryAfterCap}; !equalDurations(stub.countWaits(), want) {
			t.Errorf("waits = %v, want the %v cap", stub.countWaits(), upstreamRetryAfterCap)
		}
	})
}

// A 403 secondary-rate-limit (GitHub's wording, with its Retry-After) is
// transient; the primary budget refusal above is not.
func TestListIssuesRetriesSecondaryRateLimit403(t *testing.T) {
	c, stub := newRetryStub(t,
		scriptedReply{status: http.StatusForbidden,
			headers: http.Header{"Retry-After": []string{"1"}},
			body:    `{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}`},
		scriptedReply{body: retryOneIssue},
	)
	if _, err := retryIssues(context.Background(), c); err != nil {
		t.Fatalf("ListIssues: %v, want the secondary-limit 403 retried", err)
	}
	if want := []time.Duration{time.Second}; !equalDurations(stub.countWaits(), want) {
		t.Errorf("waits = %v, want the upstream's 1 s instruction", stub.countWaits())
	}
}

// A connection reset mid-request is transient: the repeat succeeds and the
// lane never sees the wobble.
func TestListIssuesRetriesConnectionReset(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		first := hits == 1
		mu.Unlock()
		if first {
			// Kill the connection without a response — what a reset looks
			// like from the client.
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Error("httptest server cannot hijack")
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, retryOneIssue)
	}))
	t.Cleanup(srv.Close)

	c := &Client{BaseURL: srv.URL}
	c.sleep = func(context.Context, time.Duration) error { return nil }
	got, err := retryIssues(context.Background(), c)
	if err != nil {
		t.Fatalf("ListIssues after a connection reset: %v, want the retry to succeed", err)
	}
	if len(got) != 1 || got[0].Number != 7 {
		t.Fatalf("issues = %+v, want the single issue", got)
	}
}

// The retry is bounded by the request context: a caller that stops waiting
// stops the loop, waits and all.
func TestListIssuesRetryStopsWithTheContext(t *testing.T) {
	c, stub := newRetryStub(t,
		scriptedReply{status: http.StatusBadGateway, body: `{"message":"boom"}`},
	)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c.sleep = func(ctx context.Context, d time.Duration) error {
		stub.mu.Lock()
		stub.waits = append(stub.waits, d)
		stub.mu.Unlock()
		cancel() // the caller gives up while the loop is between attempts
		return ctx.Err()
	}
	_, err := retryIssues(ctx, c)
	if err == nil {
		t.Fatal("want the upstream error after the context ended, got none")
	}
	if got := stub.countHits(); got != 1 {
		t.Errorf("upstream hits = %d, want 1: no request after the context ended", got)
	}
}

func equalDurations(got, want []time.Duration) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
