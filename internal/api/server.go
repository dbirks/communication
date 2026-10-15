package api

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
)

// Config configures an API replica.
type Config struct {
	// ReplicaName identifies this process; returned by /system/health and as
	// the X-Communication-Replica response header (COMMUNICATION_REPLICA_NAME).
	ReplicaName string
	// Version is the binary version, e.g. "0.1.0" or "dev".
	Version string
	// PublicURL is the browser-facing base URL of the deployment
	// (COMMUNICATION_PUBLIC_URL), used for strict origin checks.
	PublicURL string
	// Logger receives access logs and panic traces; nil discards them.
	Logger *slog.Logger
}

// Readiness is the datastore view required by GET /api/v1/system/readiness.
// internal/store/postgres implements it; the API package never imports a
// driver, so tests use a fake.
type Readiness interface {
	// Ping reports whether the datastore is reachable.
	Ping(ctx context.Context) error
	// SchemaVersion returns the migration version currently applied.
	SchemaVersion(ctx context.Context) (int64, error)
	// ExpectedSchemaVersion returns the version this binary requires.
	ExpectedSchemaVersion() int64
}

// Server is one stateless API replica. All state lives in PostgreSQL, so any
// request may land on any replica.
type Server struct {
	cfg     Config
	logger  *slog.Logger
	mux     *http.ServeMux
	ready   Readiness
	auth    Authenticator
	ui      fs.FS
	handler http.Handler
}

// New builds a Server with the system routes registered. ready may be nil
// (readiness then reports not_ready) and ui may be nil (the SPA falls back to
// a "UI not built" notice).
func New(cfg Config, ready Readiness, auth Authenticator, ui fs.FS) *Server {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	s := &Server{cfg: cfg, logger: log, ready: ready, auth: auth, ui: ui}
	s.mux = http.NewServeMux()

	// Unknown API and auth endpoints are problem+json 404s: they must never
	// fall through to the SPA shell.
	notFound := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteProblem(w, http.StatusNotFound, "Not Found",
			fmt.Sprintf("no endpoint %s %s", r.Method, r.URL.Path))
	})
	s.mux.Handle("/api/", notFound)
	s.mux.Handle("/api", notFound)
	s.mux.Handle("/auth/", notFound)
	s.mux.Handle("/auth", notFound)

	// Everything else is the single-page app.
	s.mux.Handle("/", newSPA(ui))

	// Liveness and readiness need no session.
	s.Handle("GET /api/v1/system/health", http.HandlerFunc(s.handleHealth))
	s.Handle("GET /api/v1/system/readiness", http.HandlerFunc(s.handleReadiness))

	s.handler = s.recoverMiddleware(s.requestIDMiddleware(
		s.replicaMiddleware(s.accessLogMiddleware(s.mux))))
	return s
}

// Handle registers a public handler on the internal mux. Patterns use
// net/http.ServeMux method+wildcard syntax, e.g. "GET /api/v1/projects/{projectId}".
func (s *Server) Handle(pattern string, h http.Handler) {
	s.mux.Handle(pattern, h)
}

// HandleAuthed registers a handler that requires a valid session. Mutations
// are additionally CSRF-checked; the method is taken from the pattern prefix
// and, when the pattern names no method, CSRF is still applied (RequireCSRF
// passes safe methods through, so this is defense-in-depth rather than a
// restriction).
func (s *Server) HandleAuthed(pattern string, h http.Handler) {
	if needsCSRF(patternMethod(pattern)) {
		h = RequireCSRF(s.cfg.PublicURL)(h)
	}
	s.Handle(pattern, RequireAuth(s.auth)(h))
}

// ServeHTTP implements http.Handler: the middleware chain in front of the mux.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// patternMethod returns the method prefix of a ServeMux pattern ("" if none).
func patternMethod(pattern string) string {
	i := strings.IndexByte(pattern, ' ')
	if i <= 0 {
		return ""
	}
	return strings.ToUpper(strings.TrimSpace(pattern[:i]))
}

// needsCSRF reports whether a method must carry the CSRF token. Empty means
// "any method", so the guard is installed and decides per request.
func needsCSRF(method string) bool {
	switch method {
	case "", http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
