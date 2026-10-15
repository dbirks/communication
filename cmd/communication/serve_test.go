package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
	"github.com/dbirks/communication/internal/store/postgres"
)

func TestRunServeRequiresDatabaseURL(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")

	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	if want := "COMMUNICATION_DATABASE_URL is not set"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

func TestRunServeRequiresPublicURL(t *testing.T) {
	// No connection is attempted: configuration is validated before the pool
	// is opened, so this stays hermetic (no database required).
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "")

	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	if want := "COMMUNICATION_PUBLIC_URL is not set"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

func TestRunServeHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runServe(--help) = %d, want 0", got)
	}
	if want := "usage: communication serve"; !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want substring %q", stdout.String(), want)
	}
}

// TestRunServeRequiresOIDCConfig guards the M1 wiring: a replica that cannot
// ever complete a login must say so at startup instead of serving a login page
// that 503s forever.
func TestRunServeRequiresOIDCConfig(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_OIDC_ISSUER", "")
	t.Setenv("COMMUNICATION_OIDC_CLIENT_ID", "")

	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	for _, want := range []string{"COMMUNICATION_OIDC_ISSUER", "COMMUNICATION_OIDC_CLIENT_ID"} {
		if !strings.Contains(stderr.String(), want) {
			t.Errorf("stderr = %q, want it to name %s", stderr.String(), want)
		}
	}
}

// TestServeStackRoutesAreWired builds the real handler against a lazily
// connected pool (nothing here ever reaches a database: every route below is
// answered before session lookup, or by the 401 that precedes it) and proves
// that auth, projects, events and workers are all mounted on the same server
// serve runs.
func TestServeStackRoutesAreWired(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://invalid.invalid:5432/communication")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:        pool,
		DatabaseURL: "postgres://invalid.invalid:5432/communication",
		Auth: auth.Config{
			Issuer:    "http://oidc:8080/default",
			ClientID:  "communication-dev",
			PublicURL: "http://localhost:18080",
		},
		API: api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
	})
	if err != nil {
		t.Fatalf("serveStack: %v", err)
	}
	defer closeStack()

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// An anonymous request must be refused by the session Authenticator on
	// every contracted route — the old placeholder behavior ("only health is
	// mounted") would show up as a 404 instead.
	for _, path := range []string{
		"/api/v1/me",
		"/api/v1/users",
		"/api/v1/projects",
		"/api/v1/projects/01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80/repos",
		"/api/v1/projects/01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80/events",
		"/api/v1/workers",
	} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401 (%s)", path, resp.StatusCode, body)
		}
		if got := resp.Header.Get("X-Communication-Replica"); got != "api-test" {
			t.Errorf("GET %s replica header = %q, want api-test", path, got)
		}
	}

	// The public surface answers without a session.
	resp, err := http.Get(srv.URL + "/api/v1/system/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "api-test") {
		t.Errorf("health = %d %s, want 200 naming the replica", resp.StatusCode, body)
	}

	// A login attempt is mounted (it reaches OIDC discovery, which cannot
	// succeed against this issuer, and must fail as a 503 rather than a 404).
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       20 * time.Second,
	}
	resp, err = client.Get(srv.URL + "/auth/login")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		t.Error("GET /auth/login = 404, want the mounted handler (503 while the issuer is unreachable)")
	}
}

// TestServeStackRejectsUnusableAuthConfig: the same clear error serve prints at
// startup, without an environment to set.
func TestServeStackRejectsUnusableAuthConfig(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://invalid.invalid:5432/communication")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if _, _, err := serveStack(serveStackDeps{Pool: pool, Auth: auth.Config{PublicURL: "http://x"}}); err == nil {
		t.Fatal("serveStack accepted an issuerless auth config")
	}
	if _, _, err := serveStack(serveStackDeps{Auth: auth.Config{
		Issuer: "http://oidc:8080/default", ClientID: "c", PublicURL: "http://x",
	}}); err == nil {
		t.Fatal("serveStack accepted a poolless stack")
	}
}

// TestServeWorkerHeartbeat: the workers listing's liveness window comes from the
// same variable worker mode uses, so a deployment that slows heartbeats does
// not start reporting healthy workers offline. Unset means "use the store
// default", and a typo must be a startup error rather than a silent default.
func TestServeWorkerHeartbeat(t *testing.T) {
	for _, tt := range []struct {
		raw     string
		want    time.Duration
		wantErr string
	}{
		{"", 0, ""},
		{"   ", 0, ""},
		{"45s", 45 * time.Second, ""},
		{"ten seconds", 0, "is not a duration"},
		{"0s", 0, "must be positive"},
		{"-5s", 0, "must be positive"},
	} {
		got, err := serveWorkerHeartbeat(func(string) string { return tt.raw })
		if tt.wantErr == "" {
			if err != nil || got != tt.want {
				t.Errorf("COMMUNICATION_WORKER_HEARTBEAT=%q -> %s, %v; want %s, no error", tt.raw, got, err, tt.want)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
			t.Errorf("COMMUNICATION_WORKER_HEARTBEAT=%q -> error %v, want it to contain %q", tt.raw, err, tt.wantErr)
		}
	}

	// A bad value is a configuration error at startup, not a degraded listing.
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_OIDC_ISSUER", "http://oidc:8080/default")
	t.Setenv("COMMUNICATION_OIDC_CLIENT_ID", "communication-dev")
	t.Setenv("COMMUNICATION_WORKER_HEARTBEAT", "ten seconds")
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runServe() = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), "COMMUNICATION_WORKER_HEARTBEAT") {
		t.Errorf("stderr = %q, want it to name COMMUNICATION_WORKER_HEARTBEAT", stderr.String())
	}
}

func TestDBReadinessExpectedSchemaVersion(t *testing.T) {
	var r api.Readiness = dbReadiness{}
	if got := r.ExpectedSchemaVersion(); got != postgres.ExpectedSchemaVersion() {
		t.Errorf("ExpectedSchemaVersion() = %d, want %d", got, postgres.ExpectedSchemaVersion())
	}
}
