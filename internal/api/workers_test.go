package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// GET /api/v1/workers is a small read-only surface, so these tests pin what the
// UI's /ops page depends on: the contracted field set, an array that is empty
// rather than null, no internal error text, and 401 for an anonymous caller.
// The liveness rule behind `status` belongs to the store and is proven against
// a real database in internal/store/postgres/worker_registry_test.go.

type evtFakeWorkers struct {
	mu      sync.Mutex
	workers []WorkerView
	err     error
	calls   int
}

func (f *evtFakeWorkers) ListWorkers(context.Context) ([]WorkerView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.workers, f.err
}

func (f *evtFakeWorkers) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func wklServer(t *testing.T, store WorkerStore, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	RegisterWorkers(s, store)
	return s
}

func TestWorkersListing(t *testing.T) {
	started, err := time.Parse(time.RFC3339, "2026-10-14T17:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	store := &evtFakeWorkers{workers: []WorkerView{{
		ID: "01987a6d-0000-7000-8000-000000000001", Name: "worker-a", Hostname: "host-a",
		Version: "0.1.0", Status: "online", StartedAt: started, LastHeartbeatAt: started.Add(time.Second),
	}}}

	rec := do(t, wklServer(t, store, prjAs("u-1", false)),
		request(http.MethodGet, "http://localhost:18080/api/v1/workers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	items, ok := body["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("body = %v, want one item", body)
	}
	// Exactly the Worker schema of api/openapi.yaml — no more, no less.
	fields := prjFields(t, wklMarshal(t, items[0]))
	want := []string{"hostname", "id", "last_heartbeat_at", "name", "started_at", "status", "version"}
	if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
		t.Errorf("worker fields = %v, want %v", got, want)
	}
	if got := items[0].(map[string]any)["started_at"]; got != "2026-10-14T17:00:00Z" {
		t.Errorf("started_at = %v, want RFC 3339 UTC", got)
	}
	if store.callCount() != 1 {
		t.Errorf("store called %d times, want 1", store.callCount())
	}

	// Empty must be [], not null, so a client can always iterate.
	rec = do(t, wklServer(t, &evtFakeWorkers{}, prjAs("u-1", false)),
		request(http.MethodGet, "http://localhost:18080/api/v1/workers", nil))
	if got := strings.TrimSpace(rec.Body.String()); got != `{"items":[]}` {
		t.Errorf("empty body = %s, want {\"items\":[]}", got)
	}

	// A store failure is a 500 problem document that does not name the driver.
	rec = do(t, wklServer(t, &evtFakeWorkers{err: errStoreDown}, prjAs("u-1", false)),
		request(http.MethodGet, "http://localhost:18080/api/v1/workers", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), errStoreDown.Error()) {
		t.Error("the store error leaked into the response body")
	}

	// Authenticated but not project-scoped: no CSRF (it is a read), no
	// membership, and no session at all is a 401.
	rec = do(t, wklServer(t, store, AuthenticatorFunc(func(*http.Request) (*Principal, error) {
		return nil, ErrUnauthenticated
	})), request(http.MethodGet, "http://localhost:18080/api/v1/workers", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous status = %d, want 401", rec.Code)
	}
}

func wklMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
