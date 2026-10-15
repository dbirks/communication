package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
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

// TestServeAuthenticatorFailsClosed guards the M1 wiring stub: until
// internal/api/auth is registered, no request may resolve to a principal, and
// the failure must be the unauthenticated sentinel (401) rather than a
// datastore error (503).
func TestServeAuthenticatorFailsClosed(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "http://localhost:8080/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := serveAuthenticator().Authenticate(req)
	if p != nil {
		t.Fatalf("Authenticate() principal = %v, want nil", p)
	}
	if !errors.Is(err, api.ErrUnauthenticated) {
		t.Errorf("Authenticate() error = %v, want ErrUnauthenticated", err)
	}
}

func TestDBReadinessExpectedSchemaVersion(t *testing.T) {
	var r api.Readiness = dbReadiness{}
	if got := r.ExpectedSchemaVersion(); got != postgres.ExpectedSchemaVersion() {
		t.Errorf("ExpectedSchemaVersion() = %d, want %d", got, postgres.ExpectedSchemaVersion())
	}
}
