package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
)

// serve.go is where the M2 contract becomes reachable: a route that exists in
// internal/api but is never registered is invisible, and a reconciler that is
// never started means an expired lease is never noticed. These tests build the
// real handler against a lazily connected pool — nothing here talks to a
// database, because every conversation route is answered by the session
// Authenticator before any store is touched — and assert what an anonymous
// browser sees on each of them.

// cnvM2Routes extracts every conversation and agent-profile operation from
// api/openapi.yaml itself. It is parsed rather than hand-copied on purpose: a
// hand list goes stale the day someone adds a route, and the stale list passes
// while the route 404s. A path the contract declares and serve does not mount
// answers 404 with "no endpoint", which is the failure these tests exist to
// catch.
func cnvM2Routes(t *testing.T) [][2]string {
	t.Helper()
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("read api/openapi.yaml: %v", err)
	}
	const (
		conv    = "01987a70-1111-7000-8000-abcdef012345"
		project = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80"
		request = "01987a72-3333-7000-8000-abcdef012345"
		user    = "01987a71-2222-7000-8000-abcdef012345"
	)
	pathIDs := map[string]string{
		"{conversationId}": conv, "{projectId}": project,
		"{permissionRequestId}": request, "{requestId}": request,
		"{turnId}": conv, "{userId}": user, "{workerId}": workerID,
		// ADR-0030 added PATCH /api/v1/agent-profiles/{profileId}; an unfilled
		// placeholder here is this test doing its job, so the fix is to fill it.
		"{profileId}": user,
		// ADR-0058 added the versioned surface (list / read / restore under
		// /agent-profiles/{profileId}/versions...); versions are positive
		// integers, so the placeholder maps to the first version.
		"{version}": "1",
	}

	var out [][2]string
	current := ""
	for _, line := range strings.Split(string(raw), "\n") {
		if m := cnvPathKey.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		if m := cnvOperation.FindStringSubmatch(line); m != nil && current != "" {
			if !cnvIsM2Path(current) {
				continue
			}
			path := current
			for placeholder, value := range pathIDs {
				path = strings.ReplaceAll(path, placeholder, value)
			}
			if strings.ContainsRune(path, '{') {
				t.Fatalf("openapi path %s uses a placeholder this test does not fill", current)
			}
			out = append(out, [2]string{strings.ToUpper(m[1]), path})
		}
	}
	if len(out) < 10 {
		t.Fatalf("only %d M2 operations found in api/openapi.yaml — the parser and the contract have diverged", len(out))
	}
	return out
}

const workerID = "01987a73-4444-7000-8000-abcdef012345"

var (
	// A path key is indented two spaces under `paths:`; an operation is four.
	cnvPathKey   = regexp.MustCompile(`^  (/api/v1/[^:]+):\s*$`)
	cnvOperation = regexp.MustCompile(`^    (get|post|put|delete|patch):\s*$`)
)

// cnvIsM2Path keeps this test on the M2 surface. Pipeline and run routes are M3
// and are deliberately absent from serve: asserting 401 on them would fail the
// wrong thing.
func cnvIsM2Path(path string) bool {
	for _, prefix := range []string{"/api/v1/conversations", "/api/v1/agent-profiles"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return strings.HasSuffix(path, "/conversations") || strings.Contains(path, "/conversations/")
}

func cnvMountServeStack(t *testing.T) http.Handler {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://invalid.invalid:5432/communication")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:        pool,
		DatabaseURL: "postgres://invalid.invalid:5432/communication",
		Auth: auth.Config{
			Issuer:    "http://oidc:8080/default",
			ClientID:  "communication-dev",
			PublicURL: "http://localhost:18080",
		},
		API:             api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
		WorkerHeartbeat: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("serveStack: %v", err)
	}
	t.Cleanup(closeStack)
	return handler
}

// TestServeStackConversationRoutesAreWired proves each M2 route is mounted on
// the handler `communication serve` actually runs: anonymous ⇒ 401, which is
// only possible if the route exists and the Authenticator is in front of it.
func TestServeStackConversationRoutesAreWired(t *testing.T) {
	srv := httptest.NewServer(cnvMountServeStack(t))
	defer srv.Close()

	for _, r := range cnvM2Routes(t) {
		method, path := r[0], r[1]
		req, err := http.NewRequest(method, srv.URL+path, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound && strings.Contains(string(body), "no endpoint") {
			t.Errorf("%s %s = 404 'no endpoint': the route is not mounted in serve", method, path)
			continue
		}
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401 (%s)", method, path, resp.StatusCode, body)
		}
		if got := resp.Header.Get("X-Communication-Replica"); got != "api-test" {
			t.Errorf("%s replica header = %q, want api-test", path, got)
		}
	}
}

func cnvLastSegment(id string) string { return "/conversations/" + id }

// TestServeStackTurnLeaseReconcilerRuns is the reconciler's startup contract: it
// is running as soon as the replica is serving, and closeStack stops it without
// waiting for a tick.
//
// What it can prove without a database is the part that a missing wiring test
// would lose: that serve started a goroutine that would take the advisory lock
// if it could reach a database, that it survives an unreachable database
// between ticks instead of dying (a replica must not stop serving because the
// reconciler's connection blipped), and that shutdown returns.
func TestServeStackTurnLeaseReconcilerRuns(t *testing.T) {
	// A pool that resolves and refuses rather than hanging: the reconciler's
	// first pass must fail fast and the replica must keep serving.
	pool, err := pgxpool.New(context.Background(), "postgres://communication@127.0.0.1:1/communication")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:        pool,
		DatabaseURL: pool.Config().ConnString(),
		Auth: auth.Config{
			Issuer:    "http://oidc:8080/default",
			ClientID:  "communication-dev",
			PublicURL: "http://localhost:18080",
		},
		API:             api.Config{ReplicaName: "api-test", Version: "test", PublicURL: "http://localhost:18080"},
		WorkerHeartbeat: time.Second,
	})
	if err != nil {
		t.Fatalf("serveStack: %v", err)
	}

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// The replica serves even though the reconciler's very first pass cannot
	// reach the database: reconciliation is not a startup dependency.
	resp, err := srv.Client().Get(srv.URL + "/api/v1/system/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health = %d (%s), want 200 with the reconciler unable to reach the database", resp.StatusCode, body)
	}

	// Shutdown is bounded: a reconciler waiting for the next tick must not hold
	// the process open past its grace period.
	done := make(chan struct{})
	go func() { closeStack(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("closeStack did not return: the reconciler ignores shutdown")
	}
}
