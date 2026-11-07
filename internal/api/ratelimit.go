package api

// Request throttling (audit F1/F2, ADR-0077).
//
// Two primitives live here:
//
//   - keyedBucket: an in-memory keyed token bucket (per-IP or per-principal).
//     The map self-limits: idle keys age out, and the map is capped, with the
//     oldest-touched key evicted on overflow, so an attacker spraying keys can
//     never grow it without bound.
//   - keyedSemaphore: a per-key concurrency cap (counting semaphore per
//     principal) used to bound concurrent SSE streams. Entries exist only
//     while a key holds a slot, so the map is bounded by live streams.
//
// Limits are per API replica and deliberately not shared through the
// database: the effective fleet-wide limit is replicas x configured limit,
// which ADR-0077 accepts for now. Every limiter is disabled by a zero
// configured value so tests and the lab opt in explicitly.

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LimitSpec is one token-bucket profile: a sustained rate plus a burst
// capacity. A non-positive PerMinute or Burst disables the limit.
type LimitSpec struct {
	// PerMinute is the sustained refill rate in requests per minute.
	PerMinute int
	// Burst is the bucket capacity: how many requests a fresh key may make
	// back to back before the sustained rate applies.
	Burst int
}

// enabled reports whether this spec throttles anything.
func (s LimitSpec) enabled() bool { return s.PerMinute > 0 && s.Burst > 0 }

// RateLimits groups every throttle profile a replica serves with. The zero
// value disables every limit — production defaults are applied where the
// environment is parsed (cmd/communication serve), not here, so unit tests
// and ad-hoc servers are never throttled by accident.
type RateLimits struct {
	// Auth throttles GET /auth/login and GET /auth/callback per client IP
	// (audit F1: each login is a database write).
	Auth LimitSpec
	// Assistant throttles assistant turns and conversation messages per
	// principal (audit F2: each turn is billed model work).
	Assistant LimitSpec
	// Issues throttles GitHub issue reads per principal (audit F2: one user
	// must not exhaust the shared upstream request budget).
	Issues LimitSpec
	// MaxStreamsPerPrincipal caps concurrent SSE streams per principal; a
	// non-positive value disables the cap.
	MaxStreamsPerPrincipal int
	// TrustedProxyHops is COMMUNICATION_TRUSTED_PROXY_HOPS. With 0 (the
	// default) the client address is always r.RemoteAddr and X-Forwarded-For
	// is ignored. With >=1 the first (leftmost) XFF hop is used as the client
	// address when present — correct only when exactly that many trusted
	// proxies sit in front and own the header (ADR-0077).
	TrustedProxyHops int
}

const (
	// rateLimitMaxKeys caps every keyed bucket's map. Eviction keeps the cap
	// enforced without unbounded scanning.
	rateLimitMaxKeys = 100_000
	// rateLimitIdleTTL is how long an untouched bucket entry survives when
	// the map needs room. A legitimate client refills its bucket well inside
	// this window; evicting an idle key only hands it a fresh burst.
	rateLimitIdleTTL = 10 * time.Minute
	// rateLimitEvictSample bounds eviction cost: map iteration starts at a
	// random key each time, so sampling this many entries approximates the
	// global oldest without an O(n) scan.
	rateLimitEvictSample = 64
	// rateLimitDefaultRetry is the Retry-After advice for the stream cap,
	// which has no token refill to predict.
	rateLimitDefaultRetry = 1 * time.Second
)

// keyedBucket is a token bucket per string key (client IP or principal id).
type keyedBucket struct {
	mu      sync.Mutex
	perSec  float64 // refill tokens per second
	burst   float64 // capacity
	maxKeys int
	idleTTL time.Duration
	now     func() time.Time
	entries map[string]*bucketEntry
}

type bucketEntry struct {
	tokens float64
	// last is the refill point; seen is the last request, used for eviction.
	last time.Time
	seen time.Time
}

// newKeyedBucket returns nil when the spec disables the limit.
func newKeyedBucket(spec LimitSpec, maxKeys int, idleTTL time.Duration, now func() time.Time) *keyedBucket {
	if !spec.enabled() {
		return nil
	}
	if maxKeys <= 0 {
		maxKeys = rateLimitMaxKeys
	}
	if idleTTL <= 0 {
		idleTTL = rateLimitIdleTTL
	}
	if now == nil {
		now = time.Now
	}
	return &keyedBucket{
		perSec:  float64(spec.PerMinute) / 60,
		burst:   float64(spec.Burst),
		maxKeys: maxKeys,
		idleTTL: idleTTL,
		now:     now,
		entries: make(map[string]*bucketEntry),
	}
}

// allow consumes one token for key, reporting whether the request passes and,
// when it does not, how long until a token is available.
func (b *keyedBucket) allow(key string) (bool, time.Duration) {
	if b == nil {
		return true, 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	e := b.entries[key]
	if e == nil {
		b.evictForRoom(now)
		e = &bucketEntry{tokens: b.burst, last: now, seen: now}
		b.entries[key] = e
	} else {
		if el := now.Sub(e.last); el > 0 {
			e.tokens += el.Seconds() * b.perSec
			if e.tokens > b.burst {
				e.tokens = b.burst
			}
			e.last = now
		}
		e.seen = now
	}
	if e.tokens >= 1 {
		e.tokens--
		return true, 0
	}
	missing := 1 - e.tokens
	return false, time.Duration(math.Ceil(missing / b.perSec * float64(time.Second)))
}

// evictForRoom frees one map slot for an imminent insert. Called with mu
// held. It first drops sampled entries idle past the TTL; if the map is still
// full it drops the oldest-touched sampled entry.
func (b *keyedBucket) evictForRoom(now time.Time) {
	if len(b.entries) < b.maxKeys {
		return
	}
	oldestKey := ""
	var oldest time.Time
	first := true
	n := 0
	for k, e := range b.entries {
		if n >= rateLimitEvictSample {
			break
		}
		n++
		if now.Sub(e.seen) > b.idleTTL {
			delete(b.entries, k)
			continue
		}
		if first || e.seen.Before(oldest) {
			oldestKey, oldest, first = k, e.seen, false
		}
	}
	if len(b.entries) >= b.maxKeys && !first {
		delete(b.entries, oldestKey)
	}
}

// keyedSemaphore caps how many concurrent holders a key may have. Entries
// exist only while a key holds at least one slot, so the map cannot outgrow
// the number of live streams.
type keyedSemaphore struct {
	mu     sync.Mutex
	max    int
	counts map[string]int
}

// newKeyedSemaphore returns nil when max disables the cap.
func newKeyedSemaphore(max int) *keyedSemaphore {
	if max <= 0 {
		return nil
	}
	return &keyedSemaphore{max: max, counts: make(map[string]int)}
}

// acquire takes one slot for key, returning the release func. release is
// non-nil only when ok is true and is safe to call exactly once.
func (l *keyedSemaphore) acquire(key string) (release func(), ok bool) {
	if l == nil {
		return func() {}, true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.counts[key] >= l.max {
		return nil, false
	}
	l.counts[key]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.counts[key]--; l.counts[key] <= 0 {
				delete(l.counts, key)
			}
		})
	}, true
}

// limiters groups the per-server limiter instances; nil fields disable the
// corresponding throttle.
type limiters struct {
	auth      *keyedBucket
	assistant *keyedBucket
	issues    *keyedBucket
	streams   *keyedSemaphore
	hops      int
}

func newLimiters(cfg RateLimits) limiters {
	return limiters{
		auth:      newKeyedBucket(cfg.Auth, rateLimitMaxKeys, rateLimitIdleTTL, nil),
		assistant: newKeyedBucket(cfg.Assistant, rateLimitMaxKeys, rateLimitIdleTTL, nil),
		issues:    newKeyedBucket(cfg.Issues, rateLimitMaxKeys, rateLimitIdleTTL, nil),
		streams:   newKeyedSemaphore(cfg.MaxStreamsPerPrincipal),
		hops:      cfg.TrustedProxyHops,
	}
}

// setClock replaces every bucket's clock; tests drive refill and eviction
// deterministically.
func (l *limiters) setClock(now func() time.Time) {
	for _, b := range []*keyedBucket{l.auth, l.assistant, l.issues} {
		if b != nil {
			b.mu.Lock()
			b.now = now
			b.mu.Unlock()
		}
	}
}

// ThrottleAuth limits GET /auth/login and GET /auth/callback per client IP
// (audit F1). Behind the default config (no trusted proxy) the key is
// r.RemoteAddr's host; an over-limit request is answered 429 problem+json
// with Retry-After. Returns h unchanged when the limit is disabled.
func (s *Server) ThrottleAuth(h http.Handler) http.Handler {
	if s.limits.auth == nil {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientKey(r, s.limits.hops)
		if ok, retry := s.limits.auth.allow(key); !ok {
			writeRateLimited(w, retry, "Too many authentication attempts from this client; retry later.")
			return
		}
		h.ServeHTTP(w, r)
	})
}

// ThrottleAssistant limits assistant turns (POST /assistant/ask,
// /assistant/draft-proposals and conversation messages) per principal
// (audit F2: every turn is billed model work). Must run inside
// HandleAuthed, where the principal is resolved; without one it passes
// through — RequireAuth already rejected such a request.
func (s *Server) ThrottleAssistant(h http.Handler) http.Handler {
	return s.throttlePrincipal(s.limits.assistant, h, "assistant requests")
}

// ThrottleIssues limits GitHub issue reads per principal (audit F2: the
// upstream budget is shared per egress IP). Same placement rule as
// ThrottleAssistant.
func (s *Server) ThrottleIssues(h http.Handler) http.Handler {
	return s.throttlePrincipal(s.limits.issues, h, "GitHub issue requests")
}

func (s *Server) throttlePrincipal(b *keyedBucket, h http.Handler, what string) http.Handler {
	if b == nil {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			h.ServeHTTP(w, r)
			return
		}
		if allowed, retry := b.allow(p.UserID); !allowed {
			writeRateLimited(w, retry, "Too many "+what+"; retry later.")
			return
		}
		h.ServeHTTP(w, r)
	})
}

// LimitStreams caps concurrent SSE streams per principal (audit F2: each
// stream is a goroutine, two tickers and repeated authz queries). The slot
// is held for the life of the stream. Must run inside HandleAuthed.
func (s *Server) LimitStreams(h http.Handler) http.Handler {
	if s.limits.streams == nil {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			h.ServeHTTP(w, r)
			return
		}
		release, ok := s.limits.streams.acquire(p.UserID)
		if !ok {
			writeRateLimited(w, rateLimitDefaultRetry, "Too many concurrent event streams; close one and retry.")
			return
		}
		defer release()
		h.ServeHTTP(w, r)
	})
}

// writeRateLimited answers 429 with the API's problem+json envelope plus a
// Retry-After header in whole seconds (minimum 1).
func writeRateLimited(w http.ResponseWriter, retryAfter time.Duration, detail string) {
	secs := int64(math.Ceil(retryAfter.Seconds()))
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
	WriteProblem(w, http.StatusTooManyRequests, "Too Many Requests", detail)
}

// clientKey resolves the throttling key for an unauthenticated request. With
// hops <= 0 (the default) X-Forwarded-For is never trusted — a client could
// otherwise spray free keys past the bucket. With hops >= 1 the first
// (leftmost) XFF entry is used when present, which is the client address
// only when exactly that many trusted proxies front the replica and own the
// header (ADR-0077).
func clientKey(r *http.Request, hops int) string {
	addr := r.RemoteAddr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		addr = h
	}
	if hops <= 0 {
		return addr
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if s := strings.TrimSpace(part); s != "" {
				return s
			}
		}
	}
	return addr
}
