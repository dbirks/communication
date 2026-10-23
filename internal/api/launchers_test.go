package api

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// GET /api/v1/launchers (ADR-0051) pins the contract the profiles UI and
// the Operations capability matrix render from: the four card ids always
// present in order, `registered` from the code registry, capability cells
// exactly as the embedded evidence file records them (never more), and the
// sandbox-verified worker count for registered launchers only.

type lchFakeStore struct {
	mu    sync.Mutex
	count int
	err   error
	calls int
}

func (f *lchFakeStore) CountLaunchWorkers(context.Context) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.count, f.err
}

func (f *lchFakeStore) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func lchServer(t *testing.T, store LauncherStore, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	RegisterLaunchers(s, store)
	return s
}

func lchGet(t *testing.T, s *Server) map[string]any {
	t.Helper()
	rec := do(t, s, request(http.MethodGet, "http://localhost:18080/api/v1/launchers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)
}

func TestLauncherListing(t *testing.T) {
	store := &lchFakeStore{count: 3}
	body := lchGet(t, lchServer(t, store, prjAs("u-1", false)))

	launchers, ok := body["launchers"].([]any)
	if !ok || len(launchers) != 4 {
		t.Fatalf("body = %v, want 4 launchers", body)
	}
	if _, extra := body["items"]; extra {
		t.Error("response carries the {items:[...]} envelope: the C5 contract is {\"launchers\":[...]}")
	}

	ids := []string{}
	byID := map[string]map[string]any{}
	for _, l := range launchers {
		m := l.(map[string]any)
		ids = append(ids, m["id"].(string))
		byID[m["id"].(string)] = m
	}
	want := []string{"claude", "codex", "pi", "antigravity"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids in order = %v, want %v", ids, want)
	}

	// Exactly the Launcher schema — no more, no less.
	fields := prjFields(t, lchMarshal(t, launchers[0]))
	wantFields := []string{"capabilities", "display_name", "id", "registered", "workers_online"}
	if got := strings.Join(fields, ","); got != strings.Join(wantFields, ",") {
		t.Errorf("launcher fields = %v, want %v", fields, wantFields)
	}

	// Registry membership: claude/codex are built-ins, pi is now in the
	// built-in registry (registered), antigravity is a product card id the
	// registry does not know (unregistered → a profile naming it fails closed).
	for id, registered := range map[string]bool{
		"claude": true, "codex": true, "pi": true, "antigravity": false,
	} {
		got := byID[id]["registered"]
		if got != registered {
			t.Errorf("%s registered = %v, want %v", id, got, registered)
		}
		// workers_online: the sandbox-verified live-worker count for
		// registered launchers, 0 for unregistered ones (nothing to run).
		wantCount := 0.0
		if registered {
			wantCount = 3.0
		}
		if got := byID[id]["workers_online"]; got != wantCount {
			t.Errorf("%s workers_online = %v, want %v", id, got, wantCount)
		}
	}

	// Capability cells: exactly the four axes in order, with the verdicts
	// the embedded evidence file records — and nothing it does not record.
	capOrder := []string{"acp_session", "resume", "permission_prompts", "nono_required"}
	assertCaps := func(id string, results map[string]string) {
		t.Helper()
		caps, ok := byID[id]["capabilities"].([]any)
		if !ok || len(caps) != 4 {
			t.Fatalf("%s capabilities = %v, want 4 cells", id, byID[id]["capabilities"])
		}
		for i, c := range caps {
			m := c.(map[string]any)
			if m["capability"] != capOrder[i] {
				t.Errorf("%s capability[%d] = %v, want %s", id, i, m["capability"], capOrder[i])
			}
			wantResult := results[m["capability"].(string)]
			if m["result"] != wantResult {
				t.Errorf("%s/%s result = %v, want %s", id, m["capability"], m["result"], wantResult)
			}
			if wantResult == "not_tested" {
				if m["observed_at"] != nil || m["evidence"] != nil {
					t.Errorf("%s/%s carries observed_at/evidence on not_tested", id, m["capability"])
				}
			} else if m["observed_at"] == nil || m["evidence"] == nil {
				t.Errorf("%s/%s = %s but observed_at/evidence are null", id, m["capability"], m["result"])
			}
		}
	}
	assertCaps("claude", map[string]string{
		"acp_session": "observed", "resume": "observed",
		"permission_prompts": "observed", "nono_required": "observed",
	})
	assertCaps("codex", map[string]string{
		"acp_session": "observed", "resume": "observed",
		"permission_prompts": "observed", "nono_required": "not_tested",
	})
	assertCaps("pi", map[string]string{
		"acp_session": "observed", "resume": "not_tested",
		"permission_prompts": "not_tested", "nono_required": "not_tested",
	})
	for _, id := range []string{"antigravity"} {
		assertCaps(id, map[string]string{
			"acp_session": "not_tested", "resume": "not_tested",
			"permission_prompts": "not_tested", "nono_required": "not_tested",
		})
	}

	// Display names: the registry entry of record for built-ins.
	if got := byID["claude"]["display_name"]; got != "Claude Code ACP adapter" {
		t.Errorf("claude display_name = %v", got)
	}
	if got := byID["pi"]["display_name"]; got != "Pi Coding Agent" {
		t.Errorf("pi display_name = %v", got)
	}

	if store.callCount() != 1 {
		t.Errorf("store called %d times, want 1", store.callCount())
	}

	// No live workers: every registered launcher reads 0, not an error.
	body = lchGet(t, lchServer(t, &lchFakeStore{}, prjAs("u-1", false)))
	launchers = body["launchers"].([]any)
	for _, l := range launchers {
		if got := l.(map[string]any)["workers_online"]; got != 0.0 {
			t.Errorf("workers_online = %v, want 0 with no store rows", got)
		}
	}

	// A store failure is a 500 problem document that does not name the driver.
	rec := do(t, lchServer(t, &lchFakeStore{err: errStoreDown}, prjAs("u-1", false)),
		request(http.MethodGet, "http://localhost:18080/api/v1/launchers", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), errStoreDown.Error()) {
		t.Error("the store error leaked into the response body")
	}

	// No session at all is a 401.
	rec = do(t, lchServer(t, store, AuthenticatorFunc(func(*http.Request) (*Principal, error) {
		return nil, ErrUnauthenticated
	})), request(http.MethodGet, "http://localhost:18080/api/v1/launchers", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous status = %d, want 401", rec.Code)
	}
}

func lchMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
