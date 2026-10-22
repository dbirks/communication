package assistant

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// retryOutcome is one scripted answer from the fake completion endpoint. A
// status of 0 means "answer with a normal completion envelope".
type retryOutcome struct {
	status     int
	body       string
	retryAfter string
}

// retryEndpoint answers the chat-completions path from a scripted sequence.
type retryEndpoint struct {
	outcomes []retryOutcome
	calls    int64
	server   *httptest.Server
}

func newRetryEndpoint(t *testing.T, outcomes ...retryOutcome) *retryEndpoint {
	t.Helper()
	e := &retryEndpoint{outcomes: outcomes}
	e.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		i := atomic.AddInt64(&e.calls, 1)
		idx := int(i - 1)
		if idx >= len(e.outcomes) {
			idx = len(e.outcomes) - 1
		}
		o := e.outcomes[idx]
		if o.status > 0 {
			if o.retryAfter != "" {
				w.Header().Set("Retry-After", o.retryAfter)
			}
			w.WriteHeader(o.status)
			_, _ = w.Write([]byte(o.body))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"the answer"},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(e.server.Close)
	return e
}

// fakeSleeper records backoff waits and honours context cancellation instead
// of actually sleeping, so retry tests run at real speed.
type fakeSleeper struct {
	mu     sync.Mutex
	delays []time.Duration
	ctxs   []context.Context
}

func (s *fakeSleeper) sleep(ctx context.Context, d time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delays = append(s.delays, d)
	s.ctxs = append(s.ctxs, ctx)
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// blockingSleeper waits for context cancellation instead of sleeping, so a
// test can hold a retry backoff until it cancels.
type blockingSleeper struct {
	mu     sync.Mutex
	delays []time.Duration
	ctxs   []context.Context
}

func (s *blockingSleeper) sleep(ctx context.Context, d time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delays = append(s.delays, d)
	s.ctxs = append(s.ctxs, ctx)
	<-ctx.Done()
	return ctx.Err()
}

func retryBroker(t *testing.T, ep *retryEndpoint, sleep func(context.Context, time.Duration) error) *Broker {
	t.Helper()
	b, err := New(Config{
		BaseURL:    ep.server.URL + "/v1",
		APIKey:     "test-key-not-a-secret",
		Model:      DefaultModel,
		HTTPClient: ep.server.Client(),
		Timeout:    time.Minute,
		Sleep:      sleep,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, newFakeStore())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b
}

func TestCompleteRetriesTransient429UntilSuccess(t *testing.T) {
	ep := newRetryEndpoint(t,
		retryOutcome{status: http.StatusTooManyRequests, body: `{"error":{"message":"rate limited, try again later"}}`},
		retryOutcome{status: 0, body: `{"choices":[{"message":{"content":"the answer"},"finish_reason":"stop"}]}`})
	sleep := &fakeSleeper{}
	b := retryBroker(t, ep, sleep.sleep)

	ans, bad := b.complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad != nil {
		t.Fatalf("complete failed after a transient retry: %+v", bad)
	}
	if ans.Text != "the answer" || !ans.Finished {
		t.Fatalf("answer = %+v, want the retried completion's answer", ans)
	}
	if got := atomic.LoadInt64(&ep.calls); got != 2 {
		t.Fatalf("completion calls = %d, want 2 (one retry)", got)
	}
}

func TestCompleteHonoursRetryAfter(t *testing.T) {
	ep := newRetryEndpoint(t,
		retryOutcome{status: http.StatusTooManyRequests, body: `{"error":{"message":"rate limited"}}`, retryAfter: "7"},
		retryOutcome{status: 0, body: `{"choices":[{"message":{"content":"the answer"},"finish_reason":"stop"}]}`})
	sleep := &fakeSleeper{}
	b := retryBroker(t, ep, sleep.sleep)

	ans, bad := b.complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad != nil {
		t.Fatalf("complete failed after a retry: %+v", bad)
	}
	if ans.Text != "the answer" {
		t.Fatalf("answer = %q", ans.Text)
	}
	sleep.mu.Lock()
	defer sleep.mu.Unlock()
	if len(sleep.delays) != 1 || sleep.delays[0] != 7*time.Second {
		t.Fatalf("backoff waits = %v, want [7s] (the offered Retry-After)", sleep.delays)
	}
}

func TestCompleteGivesUpAfterThreeAttempts(t *testing.T) {
	ep := newRetryEndpoint(t)
	ep.outcomes = make([]retryOutcome, MaxAttempts)
	for i := range ep.outcomes {
		ep.outcomes[i] = retryOutcome{status: http.StatusServiceUnavailable, body: `{"error":{"message":"upstream unavailable"}}`}
	}
	sleep := &fakeSleeper{}
	b := retryBroker(t, ep, sleep.sleep)

	_, bad := b.complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad == nil {
		t.Fatal("expected the terminal failure after three attempts")
	}
	if bad.Code != FailModelUnreachable || bad.Status != http.StatusServiceUnavailable {
		t.Fatalf("bad = %+v, want model_unreachable / http %d", bad, http.StatusServiceUnavailable)
	}
	if got := atomic.LoadInt64(&ep.calls); got != int64(MaxAttempts) {
		t.Fatalf("completion calls = %d, want %d (no retry after the last attempt)", got, MaxAttempts)
	}
	sleep.mu.Lock()
	defer sleep.mu.Unlock()
	if len(sleep.delays) != MaxAttempts-1 {
		t.Fatalf("backoff waits = %v, want %d (after attempts 1 and 2)", sleep.delays, MaxAttempts-1)
	}
}

func TestCompleteDoesNotRetryNonRetryableStatus(t *testing.T) {
	ep := newRetryEndpoint(t, retryOutcome{status: http.StatusBadRequest, body: `{"error":{"message":"bad request"}}`})
	b := retryBroker(t, ep, (&fakeSleeper{}).sleep)

	_, bad := b.complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad == nil {
		t.Fatal("expected a failure for a 400")
	}
	if bad.Code != FailBadModelResponse || bad.Status != http.StatusBadGateway {
		t.Fatalf("bad = %+v, want malformed_completion / http %d", bad, http.StatusBadGateway)
	}
	if got := atomic.LoadInt64(&ep.calls); got != 1 {
		t.Fatalf("completion calls = %d, want 1 (no retry on a non-retryable status)", got)
	}
}

func TestCompleteRetriesModelReload404UntilSuccess(t *testing.T) {
	ep := newRetryEndpoint(t,
		retryOutcome{status: http.StatusNotFound, body: `{"error":{"message":"the model is currently loading, retry later"}}`},
		retryOutcome{status: 0, body: `{"choices":[{"message":{"content":"the answer"},"finish_reason":"stop"}]}`})
	ans, bad := retryBroker(t, ep, (&fakeSleeper{}).sleep).complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad != nil {
		t.Fatalf("complete failed after a reload retry: %+v", bad)
	}
	if ans.Text != "the answer" {
		t.Fatalf("answer = %q", ans.Text)
	}
	if got := atomic.LoadInt64(&ep.calls); got != 2 {
		t.Fatalf("completion calls = %d, want 2 (one reload retry)", got)
	}
}

func TestCompleteDoesNotRetry404WhenModelIsAddressable(t *testing.T) {
	ep := newRetryEndpoint(t, retryOutcome{status: http.StatusNotFound, body: `{"error":{"message":"unknown model"}}`})
	_, bad := retryBroker(t, ep, (&fakeSleeper{}).sleep).complete(context.Background(), chatRequest{Model: DefaultModel})
	if bad == nil {
		t.Fatal("expected a failure for a 404 that is not a reload")
	}
	if got := atomic.LoadInt64(&ep.calls); got != 1 {
		t.Fatalf("completion calls = %d, want 1 (no retry for a plain 404)", got)
	}
}

func TestCompleteStopsRetryingOnContextCancel(t *testing.T) {
	ep := newRetryEndpoint(t,
		retryOutcome{status: http.StatusServiceUnavailable, body: `{"error":{"message":"upstream unavailable"}}`},
		retryOutcome{status: http.StatusServiceUnavailable, body: `{"error":{"message":"upstream unavailable"}}`},
		retryOutcome{status: http.StatusServiceUnavailable, body: `{"error":{"message":"upstream unavailable"}}`})
	ctx, cancel := context.WithCancel(context.Background())
	b := retryBroker(t, ep, (&blockingSleeper{}).sleep)
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()
	_, bad := b.complete(ctx, chatRequest{Model: DefaultModel})
	if bad == nil {
		t.Fatal("expected a failure")
	}
	if got := atomic.LoadInt64(&ep.calls); got > 2 {
		t.Fatalf("retried after the context cancelled: %d calls", got)
	}
}
