package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

// Header names used by the API.
const (
	// HeaderRequestID carries the correlation id for a request.
	HeaderRequestID = "X-Request-ID"
	// HeaderReplica identifies the API replica that answered.
	HeaderReplica = "X-Communication-Replica"
	// HeaderCSRFToken carries the session CSRF token on browser mutations.
	HeaderCSRFToken = "X-CSRF-Token"
)

type requestIDKey struct{}

// RequestIDFrom returns the correlation id stored by the middleware chain.
func RequestIDFrom(r *http.Request) string {
	if id, ok := r.Context().Value(requestIDKey{}).(string); ok {
		return id
	}
	return ""
}

// maxRequestIDLen is the longest client-supplied X-Request-ID the server will
// adopt (audit F4). A correlator id has no business being longer than this, and
// an unbounded one is reflected onto every response and into every access-log
// line, which turns a free header into log and header amplification.
const maxRequestIDLen = 64

// validRequestID reports whether s is a safe correlation id to echo: 1..64
// characters of [A-Za-z0-9._-]. Anything else (empty, too long, whitespace,
// control characters, quotes, a header-injection payload) is discarded and a
// fresh id is generated instead.
func validRequestID(s string) bool {
	if s == "" || len(s) > maxRequestIDLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// newRequestID returns 32 hex characters (16 random bytes).
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is unrecoverable; fall back to a time-derived id
		// rather than crashing the server.
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b[:])
}

// requestIDMiddleware adopts or generates X-Request-ID and puts it in the
// context and on the response. A client value is adopted only when it is a sane
// correlator (see validRequestID); otherwise it is dropped and replaced, so the
// header can never be used to inflate responses or access logs (audit F4).
func (s *Server) requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get(HeaderRequestID))
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set(HeaderRequestID, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// App-origin security headers (audit F5). The strong isolation headers
// (sandboxed CSP, COOP/CORP, no-referrer) belong to the preview origin and are
// set by artifact_preview.go, and artifact *content* responses set their own
// delivery headers in artifacts.go; this middleware is the backstop for
// everything else the app origin serves: the SPA shell, its hashed assets,
// API JSON and problem+json errors.
//
// The response writer is shared, so ordering is what implements "never
// override a handler": this middleware runs before the handler, and a handler
// that sets one of these names itself (Set replaces the value; the preview
// origin is skipped by path outright) wins.
const (
	// appCSPBaseTemplate is the policy with the frame-src sources left to the
	// deployment. Every directive is justified in appCSP below.
	appCSPBaseTemplate = "default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		"font-src 'self' data:; " +
		"connect-src 'self'; " +
		"frame-src %s; " +
		"frame-ancestors 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'; " +
		"object-src 'none'"

	// hstsMaxAgeOneYear is one year of "always speak TLS to this origin".
	hstsMaxAgeOneYear = "max-age=31536000"
)

// appCSP assembles the Content-Security-Policy for the app origin. previewOrigin
// ("" when unset) is the artifact preview origin, which the SPA frames.
//
// Measured against the real build (pnpm --dir ui build, then grep over
// ui/dist/index.html and ui/dist/assets/*.js|css):
//
//   - default-src 'self' — anything not named below is same-origin only.
//   - script-src 'self' — index.html loads /assets/index-*.js as an external
//     module and has no inline script; the bundle contains no eval( or
//     new Function, so 'unsafe-eval' is deliberately absent.
//   - style-src 'self' 'unsafe-inline' — Tailwind's stylesheet ships as an
//     external /assets/*.css, but React (and react-flow in the pipeline
//     studio) writes inline style attributes and injects <style> rules at
//     runtime, which the browser rejects without 'unsafe-inline'. Inline CSS
//     cannot execute script under this policy (script-src has no inline).
//   - img-src 'self' data: blob: — icons/images are same-origin, and the
//     bundle creates blob: object URLs for client-side downloads.
//   - font-src 'self' data: — the fonts are self-hosted woff/woff2 emitted
//     under /assets (@font-face URLs are all /assets/...); no CDN font faces.
//   - connect-src 'self' — apiFetch() and every EventSource are same-origin
//     paths (the Vite dev server proxies /api and /auth to keep it that way).
//   - frame-src 'self' [preview origin] — the artifact preview iframe points at
//     the preview hostname (ADR-0020 D6). Without an explicit frame-src it
//     would fall back to default-src 'self' and previews would break, so the
//     configured preview origin is added here and nowhere else.
//   - frame-ancestors 'none' — nothing may frame the app (audit F5's
//     clickjacking leg; X-Frame-Options is the legacy echo).
//   - base-uri 'self' — a foreign <base> could otherwise rewrite every
//     relative URL the shell requests.
//   - form-action 'self' — the SPA's <form>s submit to same-origin handlers
//     only.
//   - object-src 'none' — no plugin content, full stop.
func appCSP(previewOrigin string) string {
	frames := "'self'"
	if origin := normalizeOrigin(previewOrigin); origin != "" {
		frames = "'self' " + origin
	}
	return fmt.Sprintf(appCSPBaseTemplate, frames)
}

// securityHeaders sets the app-origin response headers and leaves the preview
// origin's response headers to artifact_preview.go.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	csp := appCSP(s.cfg.PreviewOrigin)
	hsts := ""
	if s.cfg.HSTS {
		hsts = hstsMaxAgeOneYear
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /preview/* is a different origin's document (same binary, different
		// hostname). Its handler sets a sandboxed CSP with Add, so a second CSP
		// header on the same response would intersect the two policies and
		// silently narrow what a preview may render; the preview set is
		// therefore left exactly as artifact_preview.go writes it (audit F5
		// explicitly excludes it). HSTS for that origin is the proxy's job.
		if isPreviewPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		// microphone=(self) is the app's dictation feature: the assistant mic
		// drives the Web Speech API (ui/src/lib/speech.ts), which needs the
		// top-level document to be allowed to capture audio. camera and
		// geolocation are granted to nobody, including this origin.
		h.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)")
		if hsts != "" {
			h.Set("Strict-Transport-Security", hsts)
		}
		next.ServeHTTP(w, r)
	})
}

// Security-header configuration environment (read here rather than in
// cmd/communication so the header set is correct wherever a Server is built;
// both are optional and both keep the audit's defaults).
const (
	// EnvPreviewBaseURL is the preview origin's URL prefix — the same
	// COMMUNICATION_PREVIEW_BASE_URL serve.go mints preview_url from. Its origin
	// is what the SPA's artifact-preview iframe points at, so it has to appear
	// in the app CSP's frame-src or previews stop rendering (ADR-0020 D6).
	EnvPreviewBaseURL = "COMMUNICATION_PREVIEW_BASE_URL"
	// EnvHSTS turns Strict-Transport-Security on ("1"). It is off by default
	// because TLS terminates at the proxy, and an app origin ever reached over
	// plain http must not be told to pin itself to https.
	EnvHSTS = "COMMUNICATION_HSTS"
)

// withSecurityEnvDefaults fills the security fields Config leaves unset from the
// environment. An explicit field always wins, so a caller that knows better
// never has to clear an env var.
func withSecurityEnvDefaults(cfg Config) Config {
	if cfg.PreviewOrigin == "" {
		cfg.PreviewOrigin = normalizeOrigin(os.Getenv(EnvPreviewBaseURL))
	}
	if !cfg.HSTS {
		cfg.HSTS = strings.TrimSpace(os.Getenv(EnvHSTS)) == "1"
	}
	return cfg
}

// normalizeOrigin returns the lowercased scheme://host of an absolute URL, or of
// https://<raw> when raw names only a host[:port]; "" when neither reads as an
// origin. The scheme-less guess is https because a bare host in production is
// TLS-terminated upstream; a lab that runs plain http sets the full URL.
func normalizeOrigin(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	if !strings.Contains(v, "://") {
		v = "https://" + strings.Trim(v, "/")
	}
	return originOf(v)
}

// isPreviewPath reports the preview origin's path space, including the bare
// /preview/ route that refuses unknown methods.
func isPreviewPath(p string) bool {
	return p == "/preview" || strings.HasPrefix(p, "/preview/")
}

// replicaMiddleware labels every response with the replica that served it.
func (s *Server) replicaMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(HeaderReplica, s.cfg.ReplicaName)
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the response status and size for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(p)
	r.bytes += n
	return n, err
}

// Unwrap exposes the underlying ResponseWriter to http.NewResponseController.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// Flush passes flushing through to the connection. SSE handlers (project
// event streams) assert http.Flusher directly, so the recorder must not
// swallow it.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// accessLogMiddleware logs one line per request. It never logs cookies,
// Authorization headers or the query string of /auth/ paths, which carry
// session and OIDC one-time values.
func (s *Server) accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		defer func() {
			if rec.status == 0 {
				// The handler panicked (or never wrote). A panic is still
				// unwinding towards the recovery middleware, which answers 500.
				if p := recover(); p != nil {
					rec.status = http.StatusInternalServerError
					logAccess(s.logger, r, rec, time.Since(start))
					panic(p)
				}
				rec.status = http.StatusOK
			}
			logAccess(s.logger, r, rec, time.Since(start))
		}()
		next.ServeHTTP(rec, r)
	})
}

func logAccess(log *slog.Logger, r *http.Request, rec *statusRecorder, dur time.Duration) {
	path := r.URL.Path
	// A preview token authorizes a fetch with no session behind it, and it
	// lives in the path, so the path is logged as the route and never as the
	// credential (ADR-0020 Security: the token "never appears in an access log
	// line for the preview origin", which `12-test-strategy` case 16 asserts).
	if path == "/preview" || strings.HasPrefix(path, "/preview/") {
		path = "/preview/:token"
	}
	attrs := []any{
		"method", r.Method,
		"path", path,
		"status", rec.status,
		"duration_ms", float64(dur.Microseconds()) / 1000,
		"bytes", rec.bytes,
		"request_id", RequestIDFrom(r),
		"remote", r.RemoteAddr,
	}
	// The query string of an auth callback contains state/code one-time
	// values; never log it (nor anything else under /auth/).
	if r.URL.RawQuery != "" && !strings.HasPrefix(r.URL.Path, "/auth/") {
		attrs = append(attrs, "query", r.URL.RawQuery)
	}
	level := slog.LevelInfo
	switch {
	case rec.status >= 500:
		level = slog.LevelError
	case rec.status >= 400:
		level = slog.LevelWarn
	}
	log.Log(r.Context(), level, "http request", attrs...)
}

// recoverMiddleware turns a panic in any handler into a 500 problem+json
// response and logs the stack.
func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				s.logger.ErrorContext(r.Context(), "panic recovered",
					slog.Any("panic", p),
					slog.String("path", r.URL.Path),
					slog.String("stack", string(debug.Stack())))
				WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
					"The server encountered an unexpected error. Use the request id when reporting it.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// RequireAuth rejects requests without a valid session and stores the
// resolved Principal in the request context.
func RequireAuth(auth Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if auth == nil {
				WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
					"No session; sign in at /auth/login.")
				return
			}
			p, err := auth.Authenticate(r)
			switch {
			case errors.Is(err, ErrUnauthenticated) || (err == nil && p == nil):
				WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
					"A valid session is required. Sign in at /auth/login.")
				return
			case err != nil:
				// The authenticator could not decide (e.g. database down):
				// this is not the client's fault, so answer 503, not 401.
				WriteProblem(w, http.StatusServiceUnavailable, "Authentication Unavailable",
					"The server could not verify the session. Try again shortly.")
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}
}

// RequireCSRF defends browser mutations against cross-site request forgery
// (communication-spec/06-collaboration-identity.md: "CSRF protection for
// browser mutations, strict origin checks"). GET/HEAD/OPTIONS requests pass
// through untouched; the double-submit token is compared in constant time and
// an Origin header, when present, must name this server.
func RequireCSRF(publicURL string) func(http.Handler) http.Handler {
	expected := originOf(publicURL)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
				next.ServeHTTP(w, r)
				return
			}
			p, ok := PrincipalFrom(r.Context())
			if !ok {
				WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
					"A valid session is required.")
				return
			}
			token := r.Header.Get(HeaderCSRFToken)
			if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(p.CSRFToken)) != 1 {
				WriteProblem(w, http.StatusForbidden, "CSRF Token Invalid",
					"Missing or incorrect "+HeaderCSRFToken+" header.")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				self := selfOrigin(r)
				if !sameOrigin(origin, expected) && !sameOrigin(origin, self) {
					WriteProblem(w, http.StatusForbidden, "Origin Rejected",
						"Request origin is not allowed for state-changing requests.")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// selfOrigin reconstructs scheme://host as the browser saw it, trusting
// X-Forwarded-Proto (first value) because the load balancer terminates TLS.
func selfOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i >= 0 {
			fwd = fwd[:i]
		}
		if fwd = strings.TrimSpace(strings.ToLower(fwd)); fwd != "" {
			scheme = fwd
		}
	}
	host := r.Host
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// originOf returns the lowercased scheme://host of an absolute URL, or "".
func originOf(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}

func sameOrigin(got, want string) bool {
	g := originOf(got)
	return g != "" && want != "" && strings.EqualFold(g, want)
}
