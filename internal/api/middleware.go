package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
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
// context and on the response.
func (s *Server) requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get(HeaderRequestID))
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(HeaderRequestID, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
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
