package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- keyed bucket -------------------------------------------------------

func newTestBucket(perMinute, burst int) (*keyedBucket, func(time.Duration)) {
	now := time.Unix(1700000000, 0)
	clock := &now
	b := newKeyedBucket(LimitSpec{PerMinute: perMinute, Burst: burst}, 8, time.Minute, func() time.Time {
		return *clock
	})
	advance := func(d time.Duration) { *clock = clock.Add(d) }
	return b, advance
}

func TestKeyedBucketBurstThenRefill(t *testing.T) {
	// 30/min = 0.5 tokens/s, burst 3.
	b, advance := newTestBucket(30, 3)
	for i := 0; i < 3; i++ {
		if ok, _ := b.allow("k"); !ok {
			t.Fatalf("request %d denied inside the burst", i+1)
		}
	}
	ok, retry := b.allow("k")
	if ok {
		t.Fatal("4th back-to-back request allowed past the burst")
	}
	if retry < 1900*time.Millisecond || retry > 2*time.Second {
		t.Fatalf("retry-after = %s, want ~2s (one token at 0.5/s)", retry)
	}
	advance(1 * time.Second) // 0.5 tokens — still not a whole one
	if ok, _ := b.allow("k"); ok {
		t.Fatal("allowed with half a token")
	}
	advance(1 * time.Second) // 2s total = 1 full token
	if ok, _ := b.allow("k"); !ok {
		t.Fatal("denied once a full token had refilled")
	}
}

func TestKeyedBucketRefillCapsAtBurst(t *testing.T) {
	b, advance := newTestBucket(60, 2)
	if ok, _ := b.allow("k"); !ok {
		t.Fatal("first request denied")
	}
	advance(time.Hour) // far beyond a full refill
	for i := 0; i < 2; i++ {
		if ok, _ := b.allow("k"); !ok {
			t.Fatalf("request %d denied; burst did not refill", i+1)
		}
	}
	if ok, _ := b.allow("k"); ok {
		t.Fatal("more than burst capacity allowed after a long idle")
	}
}

func TestKeyedBucketKeysAreIndependent(t *testing.T) {
	b, _ := newTestBucket(60, 1)
	if ok, _ := b.allow("a"); !ok {
		t.Fatal("a denied")
	}
	if ok, _ := b.allow("a"); ok {
		t.Fatal("a allowed twice with burst 1")
	}
	if ok, _ := b.allow("b"); !ok {
		t.Fatal("b denied by a's exhaustion")
	}
}

func TestKeyedBucketIdleEviction(t *testing.T) {
	now := time.Unix(1700000000, 0)
	clock := &now
	b := newKeyedBucket(LimitSpec{PerMinute: 60, Burst: 1}, 3, time.Minute, func() time.Time {
		return *clock
	})
	for _, k := range []string{"a", "b", "c"} {
		b.allow(k)
	}
	if len(b.entries) != 3 {
		t.Fatalf("map size = %d, want 3", len(b.entries))
	}
	*clock = clock.Add(2 * time.Minute) // every key now idle past the TTL
	b.allow("d")
	if len(b.entries) != 1 {
		t.Fatalf("map size = %d, want 1: idle keys should have been evicted", len(b.entries))
	}
	if _, ok := b.entries["d"]; !ok {
		t.Fatal("new key missing after eviction")
	}
}

func TestKeyedBucketCapEvictsOldestTouched(t *testing.T) {
	now := time.Unix(1700000000, 0)
	clock := &now
	b := newKeyedBucket(LimitSpec{PerMinute: 60, Burst: 1}, 3, time.Hour, func() time.Time {
		return *clock
	})
	// Insert a, b, c at distinct times so 'a' is unambiguously the oldest.
	for i, k := range []string{"a", "b", "c"} {
		*clock = clock.Add(time.Duration(i+1) * time.Second)
		b.allow(k)
	}
	*clock = clock.Add(time.Second)
	b.allow("d") // map full, nothing idle: evict the oldest-touched key
	if _, ok := b.entries["a"]; ok {
		t.Fatal("oldest key 'a' survived the cap eviction")
	}
	if len(b.entries) != 3 {
		t.Fatalf("map size = %d, want the cap (3)", len(b.entries))
	}
	// Evicted 'a' returns as a fresh bucket — the price of eviction is a
	// restored burst, never a denial.
	if ok, _ := b.allow("a"); !ok {
		t.Fatal("evicted key denied on return")
	}
}

func TestKeyedBucketDisabledSpecIsNil(t *testing.T) {
	for _, spec := range []LimitSpec{{}, {PerMinute: 10}, {Burst: 5}, {PerMinute: -1, Burst: 5}} {
		if b := newKeyedBucket(spec, 4, time.Minute, nil); b != nil {
			t.Fatalf("newKeyedBucket(%+v) returned a limiter; want nil", spec)
		}
	}
	// A nil bucket allows everything (defence in depth for the call sites).
	var b *keyedBucket
	if ok, retry := b.allow("k"); !ok || retry != 0 {
		t.Fatal("nil bucket denied a request")
	}
}

// --- keyed semaphore ----------------------------------------------------

func TestKeyedSemaphoreCapsPerKey(t *testing.T) {
	l := newKeyedSemaphore(2)
	r1, ok := l.acquire("u")
	if !ok {
		t.Fatal("first acquire denied")
	}
	r2, ok := l.acquire("u")
	if !ok {
		t.Fatal("second acquire denied (max 2)")
	}
	if _, ok := l.acquire("u"); ok {
		t.Fatal("third acquire allowed past the cap")
	}
	// Other keys have their own budget.
	r3, ok := l.acquire("v")
	if !ok {
		t.Fatal("other key denied")
	}
	r1()
	r4, ok := l.acquire("u")
	if !ok {
		t.Fatal("acquire after release denied")
	}
	r2()
	r3()
	r4()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.counts) != 0 {
		t.Fatalf("map left with %d entries after every release", len(l.counts))
	}
}

func TestKeyedSemaphoreReleaseIsIdempotent(t *testing.T) {
	l := newKeyedSemaphore(1)
	release, ok := l.acquire("u")
	if !ok {
		t.Fatal("acquire denied")
	}
	release()
	release() // double release must not underflow the count
	if _, ok := l.acquire("u"); !ok {
		t.Fatal("slot lost to a double release")
	}
}

func TestKeyedSemaphoreDisabledIsNil(t *testing.T) {
	if l := newKeyedSemaphore(0); l != nil {
		t.Fatal("max 0 returned a limiter")
	}
	var l *keyedSemaphore
	release, ok := l.acquire("k")
	if !ok || release == nil {
		t.Fatal("nil semaphore denied")
	}
	release()
}

// --- client key resolution ------------------------------------------------

func TestClientKey(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://x/auth/login", nil)
	r.RemoteAddr = "203.0.113.7:54321"

	if got := clientKey(r, 0); got != "203.0.113.7" {
		t.Fatalf("host = %q, want the port-stripped peer address", got)
	}

	// X-Forwarded-For is inert with no trusted proxy (the default).
	r.Header.Set("X-Forwarded-For", "198.51.100.1, 10.0.0.1")
	if got := clientKey(r, 0); got != "203.0.113.7" {
		t.Fatalf("hops=0 honoured X-Forwarded-For: %q", got)
	}
	// With one trusted hop, the first XFF entry is the client.
	if got := clientKey(r, 1); got != "198.51.100.1" {
		t.Fatalf("hops=1 first hop = %q, want 198.51.100.1", got)
	}
	r.Header.Set("X-Forwarded-For", " , 198.51.100.2")
	if got := clientKey(r, 1); got != "198.51.100.2" {
		t.Fatalf("blank first hop = %q, want the first non-empty entry", got)
	}
	r.Header.Del("X-Forwarded-For")
	if got := clientKey(r, 1); got != "203.0.113.7" {
		t.Fatalf("empty XFF = %q, want the peer address fallback", got)
	}
	// No port (unix sockets, bare IPv6) must not be mangled.
	r2 := httptest.NewRequest(http.MethodGet, "http://x/auth/login", nil)
	r2.RemoteAddr = "@invalid-net-addr"
	if got := clientKey(r2, 0); got != "@invalid-net-addr" {
		t.Fatalf("unsplitable address = %q, want it verbatim", got)
	}
}

// --- HTTP middleware ------------------------------------------------------

func newThrottledTestServer(t *testing.T, limits RateLimits) (*Server, *time.Time) {
	t.Helper()
	now := time.Unix(1700000000, 0)
	clock := &now
	cfg := Config{ReplicaName: "r", PublicURL: "http://localhost:8080", Logger: discardLogger(), Limits: limits}
	s := New(cfg, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil), nil)
	s.limits.setClock(func() time.Time { return *clock })
	return s, clock
}

func TestThrottleAuthAnswers429ProblemWithRetryAfter(t *testing.T) {
	s, clock := newThrottledTestServer(t, RateLimits{Auth: LimitSpec{PerMinute: 60, Burst: 2}})
	s.Handle("GET /auth/login", s.ThrottleAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusFound)
	})))

	for i := 0; i < 2; i++ {
		if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/auth/login", nil)); rec.Code != http.StatusFound {
			t.Fatalf("request %d: status = %d, want the handler's 302", i+1, rec.Code)
		}
	}
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/auth/login", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body %s)", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1 (one token at 1/s, ceil-rounded)", got)
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), ProblemJSON) {
		t.Fatalf("content-type = %q, want problem+json", rec.Header().Get("Content-Type"))
	}
	if p := decodeProblem(t, rec); p.Status != http.StatusTooManyRequests || p.Title != "Too Many Requests" {
		t.Fatalf("problem = %+v", p)
	}

	// The bucket refills.
	*clock = clock.Add(2 * time.Second)
	if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/auth/login", nil)); rec.Code != http.StatusFound {
		t.Fatalf("after refill: status = %d, want 302", rec.Code)
	}

	// A different client IP has its own bucket.
	r := request(http.MethodGet, "http://localhost:8080/auth/login", nil)
	r.RemoteAddr = "198.51.100.9:1234"
	for i := 0; i < 2; i++ {
		if rec := do(t, s, r); rec.Code != http.StatusFound {
			t.Fatalf("other IP request %d: status = %d, want 302", i+1, rec.Code)
		}
	}
}

func TestThrottleAuthHonoursTrustedProxyHops(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{Auth: LimitSpec{PerMinute: 60, Burst: 1}, TrustedProxyHops: 1})
	s.Handle("GET /auth/login", s.ThrottleAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusFound)
	})))
	// Drain the bucket for the XFF client behind the trusted proxy.
	r := request(http.MethodGet, "http://localhost:8080/auth/login", map[string]string{"X-Forwarded-For": "198.51.100.1"})
	if rec := do(t, s, r); rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	if rec := do(t, s, r); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 for the same XFF client", rec.Code)
	}
	// The proxy's own address is never the key: a different first hop passes.
	r2 := request(http.MethodGet, "http://localhost:8080/auth/login", map[string]string{"X-Forwarded-For": "198.51.100.2"})
	if rec := do(t, s, r2); rec.Code != http.StatusFound {
		t.Fatalf("different XFF client: status = %d, want 302", rec.Code)
	}
}

func TestThrottleAssistantIsPerPrincipal(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{Assistant: LimitSpec{PerMinute: 30, Burst: 1}})
	s.HandleAuthed("POST /api/v1/assistant/ask", s.ThrottleAssistant(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "1"})
	})))
	if rec := do(t, s, request(http.MethodPost, "http://localhost:8080/api/v1/assistant/ask", csrfHeaders())); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	rec := do(t, s, request(http.MethodPost, "http://localhost:8080/api/v1/assistant/ask", csrfHeaders()))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body %s)", rec.Code, rec.Body)
	}
	if p := decodeProblem(t, rec); p.Status != http.StatusTooManyRequests {
		t.Fatalf("problem = %+v", p)
	}
}

func csrfHeaders() map[string]string {
	return map[string]string{
		"Origin":       "http://localhost:8080",
		"X-CSRF-Token": testPrincipal().CSRFToken,
	}
}

func TestThrottleIssuesWrapsRoute(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{Issues: LimitSpec{PerMinute: 60, Burst: 1}})
	s.HandleAuthed("GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues",
		s.ThrottleIssues(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			WriteJSON(w, http.StatusOK, map[string]string{"ok": "1"})
		})))
	url := "http://localhost:8080/api/v1/projects/p1/repos/r1/issues"
	if rec := do(t, s, request(http.MethodGet, url, nil)); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec := do(t, s, request(http.MethodGet, url, nil)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
}

func TestLimitStreamsCapsConcurrentStreamsPerPrincipal(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{MaxStreamsPerPrincipal: 1})
	var once sync.Once
	started, release := make(chan struct{}), make(chan struct{})
	s.HandleAuthed("GET /api/v1/events", s.LimitStreams(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started) })
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusOK)
	})))

	ts := httptest.NewServer(s)
	defer ts.Close()
	go func() {
		resp, err := http.Get(ts.URL + "/api/v1/events")
		if err == nil {
			resp.Body.Close()
		}
	}()
	<-started

	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/events", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second stream: status = %d, want 429 (body %s)", rec.Code, rec.Body)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}

	close(release) // the first stream ends and frees its slot
	deadline := time.Now().Add(2 * time.Second)
	for {
		if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/events", nil)); rec.Code == http.StatusOK {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("slot never returned after the stream ended: status = %d", rec.Code)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestZeroLimitsDisableEveryThrottle(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{})
	// A comparable handler type: disabled pass-throughs return the exact
	// handler they were given, and comparing interface values whose dynamic
	// type is a func panics.
	var h http.Handler = probeHandler{}
	// Disabled limiters are pass-throughs: the handler is returned unchanged.
	if got := s.ThrottleAuth(h); got != h {
		t.Fatal("ThrottleAuth wrapped despite the limit being 0")
	}
	if got := s.ThrottleAssistant(h); got != h {
		t.Fatal("ThrottleAssistant wrapped despite the limit being 0")
	}
	if got := s.ThrottleIssues(h); got != h {
		t.Fatal("ThrottleIssues wrapped despite the limit being 0")
	}
	if got := s.LimitStreams(h); got != h {
		t.Fatal("LimitStreams wrapped despite the limit being 0")
	}
	s.Handle("GET /auth/login", s.ThrottleAuth(h))
	for i := 0; i < 50; i++ {
		if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/auth/login", nil)); rec.Code != http.StatusFound {
			t.Fatalf("request %d throttled with limits at 0: status %d", i+1, rec.Code)
		}
	}
}

type probeHandler struct{}

func (probeHandler) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusFound)
}

func TestThrottlePassesThroughWithoutPrincipal(t *testing.T) {
	// The throttle runs inside RequireAuth, so an anonymous request never
	// reaches it — but the pass-through branch must not panic if a route is
	// ever mounted without auth.
	s, _ := newThrottledTestServer(t, RateLimits{Assistant: LimitSpec{PerMinute: 60, Burst: 1}})
	s.Handle("GET /api/v1/probe", s.ThrottleAssistant(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusFound)
	})))
	for i := 0; i < 3; i++ {
		if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/probe", nil)); rec.Code != http.StatusFound {
			t.Fatalf("request %d: status = %d, want 302 (no principal to key on)", i+1, rec.Code)
		}
	}
}
