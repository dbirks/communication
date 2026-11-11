package api

// The operations overview read and the admin model probe. What these tests
// pin, in the order it is expensive to get wrong:
//
//   - No key can leave the overview route, even though the deployment under
//     test holds three of them. The shape assertions and the leak loop are the
//     test; the fake config is a fully-resolved one, because an unconfigured
//     deployment leaks nothing by construction.
//   - The secret counts are the CALLER's: what a member of one project sees is
//     not what a member of two sees, and one organization-scope secret counted
//     once per project would inflate the number every project adds.
//   - The probe is the organization's library role and nobody else's; its
//     detail is the upstream's own message with the key redacted out of that
//     message; and one kind cannot be probed twice inside ten seconds.
//
// The probe's upstream is a real httptest server. A fake interface would prove
// the routing and nothing else — not the Authorization header, not the
// four-token request body, not the truncation, not the deadline.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
)

// The three keys the deployment under test holds. None may appear in a response
// body or a log line; the probe's Authorization header is the only place any of
// them goes, and the upstream asserts on it from the other side.
const (
	ovChatKey     = "sk-CHAT-key-not-for-echoing"
	ovSpeechKey   = "sk-SPEECH-key-not-for-echoing"
	ovDecisionKey = "sk-JUDGE-key-not-for-echoing"
	ovProbeModel  = "david-birks/qwen3-8-flash-next"
)

// --- the fake world ------------------------------------------------------

// ovStore is one caller-scoped world: which projects each user is in, and what
// the secret and mount reads answer for those projects. It refuses a project
// the caller is not in with the store's own not-found sentinel, which is how
// the membership rule is actually enforced in production.
type ovStore struct {
	mu      sync.Mutex
	visible map[string][]ProjectView
	secrets map[string][]SecretView
	mounts  map[string][]SecretMountView
	calls   []string
	err     error
}

func newOVStore() *ovStore {
	return &ovStore{
		visible: map[string][]ProjectView{},
		secrets: map[string][]SecretView{},
		mounts:  map[string][]SecretMountView{},
	}
}

func (f *ovStore) note(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

func (f *ovStore) callLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

func (f *ovStore) sees(c Caller, projectID string) bool {
	for _, p := range f.visible[c.UserID] {
		if p.ID == projectID {
			return true
		}
	}
	return false
}

func (f *ovStore) ListProjects(_ context.Context, c Caller) ([]ProjectView, error) {
	f.note("projects:" + c.UserID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return append([]ProjectView{}, f.visible[c.UserID]...), nil
}

func (f *ovStore) ListSecrets(_ context.Context, c Caller, projectID string) ([]SecretView, error) {
	f.note("secrets:" + c.UserID + "/" + projectID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.sees(c, projectID) {
		return nil, ErrProjectNotFound
	}
	return append([]SecretView{}, f.secrets[projectID]...), nil
}

func (f *ovStore) ListSecretMounts(_ context.Context, c Caller, projectID string) ([]SecretMountView, error) {
	f.note("mounts:" + c.UserID + "/" + projectID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.sees(c, projectID) {
		return nil, ErrProjectNotFound
	}
	return append([]SecretMountView{}, f.mounts[projectID]...), nil
}

// ovWorkers is the worker registry's liveness-adjusted list.
type ovWorkers struct {
	mu   sync.Mutex
	rows []WorkerView
	err  error
}

func (f *ovWorkers) ListWorkers(context.Context) ([]WorkerView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return append([]WorkerView{}, f.rows...), nil
}

// --- the fixture ---------------------------------------------------------

// fakeClock is the probe limiter's clock, advanced by the test rather than by
// the wall: a ten-second rate limit is not a test anyone may sleep through.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// ovFixture is one server with both ops routes mounted, reading the config
// serve hands in, the caller's own world, and a log the test can read back.
type ovFixture struct {
	srv   *Server
	logs  *bytes.Buffer
	clock *fakeClock
}

// ovFixtureFor wires the routes for one caller. A nil store or worker face is
// the deployment that has no projects or no registry, not a crash.
func ovFixtureFor(t *testing.T, store *ovStore, workers assistantStatusWorkers, deps SystemOverviewDeps, userID string, isOrgAdmin bool) *ovFixture {
	t.Helper()
	if deps.Version == "" {
		deps.Version = "0.0.0-SNAPSHOT-f918881"
	}
	if deps.Replica == "" {
		deps.Replica = "communication-7d9"
	}
	if deps.Heartbeat == 0 {
		// The lab's worker heartbeat: the row must report the window that rule
		// actually applied, and 1200 s × 3 is the contract's 3600.
		deps.Heartbeat = 1200 * time.Second
	}
	if store != nil {
		deps.Projects = store
		deps.Secrets = store
	}
	if workers != nil {
		deps.Workers = workers
	}
	logs := &bytes.Buffer{}
	clock := &fakeClock{t: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}
	deps.now = clock.Now
	s := newTestServerWith(t,
		Config{
			ReplicaName: deps.Replica,
			Version:     deps.Version,
			PublicURL:   "http://localhost:8080",
			Logger:      slog.New(slog.NewTextHandler(logs, nil)),
		},
		nil, fakeReadiness{ver: 30, expected: 30},
		principalAuth(&Principal{
			UserID: userID, OrganizationID: "o-1", DisplayName: userID,
			CSRFToken: prjCSRF, IsOrgAdmin: isOrgAdmin,
		}, nil))
	RegisterSystemOverview(s, NewSystemOverviewService(deps, slog.New(slog.NewTextHandler(logs, nil))))
	return &ovFixture{srv: s, logs: logs, clock: clock}
}

// ovConfig is a fully-resolved deployment: three configured model endpoints and
// no worker-side allowlist, which is what a serve pod actually looks like.
func ovConfig() SystemOverviewDeps {
	return SystemOverviewDeps{
		Chat: AssistantConfig{
			BaseURL: "https://llm-collective.e-gineering.com/v1",
			APIKey:  ovChatKey,
			Model:   ovProbeModel,
		},
		Models: AssistantStatusModels{
			SpeechBaseURL:   "https://llm-collective.e-gineering.com/v1",
			SpeechModel:     "qwen3-asr-1-7b",
			SpeechAPIKey:    ovSpeechKey,
			DecisionBaseURL: "http://judge.internal:8000/v1",
			DecisionModel:   "qwen3-8-decision",
		},
		DecisionAPIKey:  ovDecisionKey,
		IssuerURL:       "https://idp.beluga-wyvern.ts.net",
		ArtifactBackend: "local",
		PreviewHost:     "communication-preview.beluga-wyvern.ts.net",
	}
}

func (f *ovFixture) get(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, f.srv, request(http.MethodGet, "http://localhost:8080"+target, nil))
}

func (f *ovFixture) post(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, f.srv, prjPost(http.MethodPost, target, ""))
}

// modelRow reads one model row out of the overview body by kind.
func (f *ovFixture) modelRow(t *testing.T, kind string) map[string]any {
	t.Helper()
	rec := f.get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusOK {
		t.Fatalf("overview = %d (%s)", rec.Code, rec.Body)
	}
	for _, raw := range decodeBody(t, rec)["models"].([]any) {
		if row := raw.(map[string]any); row["kind"] == kind {
			return row
		}
	}
	t.Fatalf("no %q row in %s", kind, rec.Body)
	return nil
}

// --- the overview read ---------------------------------------------------

// TestSystemOverviewShape pins the contract object member-for-member, and that
// no key, no scheme+path and no credential-shaped string appears anywhere in
// the body.
func TestSystemOverviewShape(t *testing.T) {
	t.Parallel()
	store := newOVStore()
	store.visible["u-1"] = []ProjectView{{ID: "p-1", Slug: "home", Name: "Home"}, {ID: "p-2", Slug: "work", Name: "Work"}}
	// s-org is visible from BOTH projects: the count is distinct rows.
	store.secrets["p-1"] = []SecretView{{ID: "s-org", Slug: "GITHUB_TOKEN", Scope: "org"}, {ID: "s-1", Slug: "DEPLOY", Scope: "project"}}
	store.secrets["p-2"] = []SecretView{{ID: "s-org", Slug: "GITHUB_TOKEN", Scope: "org"}, {ID: "s-2", Slug: "TOKENS", Scope: "project"}, {ID: "s-3", Slug: "WEBHOOK", Scope: "project"}}
	store.mounts["p-1"] = []SecretMountView{{ID: "m-1"}, {ID: "m-2"}}
	store.mounts["p-2"] = []SecretMountView{{ID: "m-2"}, {ID: "m-3"}}
	workers := &ovWorkers{rows: []WorkerView{
		{ID: "01", Name: "worker-a", Status: "online"},
		{ID: "02", Name: "worker-b", Status: "offline"},
		{ID: "03", Name: "worker-c", Status: "draining"},
		{ID: "04", Name: "worker-d", Status: "online"},
	}}
	f := ovFixtureFor(t, store, workers, ovConfig(), "u-1", false)

	rec := f.get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	body := rec.Body.String()

	for _, leak := range []string{ovChatKey, ovSpeechKey, ovDecisionKey, "Bearer", "://", ":8000", "GITHUB_TOKEN"} {
		if strings.Contains(body, leak) {
			t.Errorf("body leaked %q: %s", leak, body)
		}
	}

	view := decodeBody(t, rec)
	prjWantFields(t, secMarshal(t, view), "identity", "models", "secrets", "server", "storage", "workers")
	prjWantFields(t, secMarshal(t, view["server"]), "commit", "replica", "schema_version", "started_at", "version")
	prjWantFields(t, secMarshal(t, view["identity"]), "dev_login", "issuer_host", "provider", "providers")
	prjWantFields(t, secMarshal(t, view["storage"]), "artifact_backend", "preview_host")
	prjWantFields(t, secMarshal(t, view["secrets"]), "mounts", "projects", "secrets")
	prjWantFields(t, secMarshal(t, view["workers"]), "offline", "online", "stale_after_seconds")

	server := view["server"].(map[string]any)
	if server["version"] != "0.0.0-SNAPSHOT-f918881" || server["replica"] != "communication-7d9" {
		t.Errorf("server = %v, want the build api.Config carries", server)
	}
	if server["schema_version"] != float64(30) {
		t.Errorf("schema_version = %v, want the readiness read (30)", server["schema_version"])
	}
	started, ok := server["started_at"].(string)
	if !ok {
		t.Fatalf("started_at = %T, want an RFC3339 string", server["started_at"])
	}
	if _, err := time.Parse(time.RFC3339, started); err != nil {
		t.Errorf("started_at %q is not RFC3339: %v", started, err)
	}

	identity := view["identity"].(map[string]any)
	if identity["provider"] != "oidc" || identity["issuer_host"] != "idp.beluga-wyvern.ts.net" || identity["dev_login"] != false {
		t.Errorf("identity = %v, want oidc / the bare issuer host / dev_login false", identity)
	}
	// A deployment wired the pre-ADR-0083 way (one issuer in the environment,
	// no provider list) still answers `providers` — as the empty list, not null,
	// so the page has one shape to render.
	if provs, ok := identity["providers"].([]any); !ok || len(provs) != 0 {
		t.Errorf("identity.providers = %v, want [] for an env-only deployment", identity["providers"])
	}

	storage := view["storage"].(map[string]any)
	if storage["artifact_backend"] != "local" || storage["preview_host"] != "communication-preview.beluga-wyvern.ts.net" {
		t.Errorf("storage = %v", storage)
	}

	secrets := view["secrets"].(map[string]any)
	if secrets["projects"] != float64(2) || secrets["secrets"] != float64(4) || secrets["mounts"] != float64(3) {
		t.Errorf("secrets = %v, want the 2 projects' 4 distinct secrets and 3 distinct mounts", secrets)
	}

	// `draining` is not online: the pair is capacity, not a status histogram.
	workerRow := view["workers"].(map[string]any)
	if workerRow["online"] != float64(2) || workerRow["offline"] != float64(2) {
		t.Errorf("workers = %v, want 2 online / 2 not", workerRow)
	}
	if workerRow["stale_after_seconds"] != float64(3600) {
		t.Errorf("stale_after_seconds = %v, want heartbeat(1200 s) × 3", workerRow["stale_after_seconds"])
	}

	rows := view["models"].([]any)
	if len(rows) != 4 {
		t.Fatalf("models = %d rows, want assistant/speech/decision/worker_chat", len(rows))
	}
	kinds := make([]string, 0, len(rows))
	byKind := map[string]map[string]any{}
	for _, raw := range rows {
		row := raw.(map[string]any)
		prjWantFields(t, secMarshal(t, row), "configured", "endpoint_host", "key_set", "kind", "label", "model")
		kind := row["kind"].(string)
		kinds = append(kinds, kind)
		byKind[kind] = row
	}
	if want := "assistant,speech,decision,worker_chat"; strings.Join(kinds, ",") != want {
		t.Errorf("model kinds = %v, want %s", kinds, want)
	}
	if chat := byKind["assistant"]; chat["label"] != "Assistant chat" || chat["model"] != ovProbeModel ||
		chat["endpoint_host"] != "llm-collective.e-gineering.com" || chat["key_set"] != true || chat["configured"] != true {
		t.Errorf("assistant row = %v", chat)
	}
	if speech := byKind["speech"]; speech["label"] != "Speech transcription" || speech["configured"] != true ||
		speech["key_set"] != true || speech["model"] != "qwen3-asr-1-7b" {
		t.Errorf("speech row = %v", speech)
	}
	if judge := byKind["decision"]; judge["label"] != "Decision judge" || judge["configured"] != true ||
		judge["key_set"] != true || judge["endpoint_host"] != "judge.internal" {
		t.Errorf("decision row = %v", judge)
	}
	// The worker row on a pod that never saw COMMUNICATION_MODEL_CHAT_*: no
	// model, no host, not configured, and key_set NULL — "this replica cannot
	// see a worker's environment", which is not the claim "no key is set".
	wc := byKind["worker_chat"]
	if wc["label"] != "Workflow model steps" || wc["model"] != "" || wc["endpoint_host"] != "" || wc["configured"] != false {
		t.Errorf("worker_chat row = %v, want the unset-on-this-pod answer", wc)
	}
	if raw, err := json.Marshal(wc); err != nil {
		t.Fatal(err)
	} else if !strings.Contains(string(raw), `"key_set":null`) {
		t.Errorf("worker_chat key_set = %v, want JSON null", wc["key_set"])
	}
}

// TestSystemOverviewIdentityListsProviders is the ADR-0083 gap: a deployment
// that signs people in through COMMUNICATION_OIDC_PROVIDERS_FILE has no
// COMMUNICATION_OIDC_ISSUER, so `issuer_host` was "" and the operations page
// printed “OIDC · no issuer host” over a deployment with three working
// providers. The identity row now carries the list, and `issuer_host` keeps its
// meaning as the first provider's host for readers that predate it.
func TestSystemOverviewIdentityListsProviders(t *testing.T) {
	t.Parallel()
	deps := ovConfig()
	deps.IssuerURL = "" // what serve actually carries under the providers file
	deps.SignInProviders = []SignInProvider{
		{ID: "tailscale", Label: "Tailscale", Issuer: "https://idp.example.ts.net"},
		{ID: "entra", Label: "Microsoft Entra ID", Issuer: "https://login.microsoftonline.com/tenant/v2.0"},
		// An issuer this build cannot parse keeps its row with an empty host:
		// the operator sees the provider they configured and the honest gap.
		{ID: "local", Label: "Single sign-on", Issuer: "not-a-url"},
	}
	f := ovFixtureFor(t, newOVStore(), &ovWorkers{}, deps, "u-1", false)

	rec := f.get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	identity := decodeBody(t, rec)["identity"].(map[string]any)
	prjWantFields(t, secMarshal(t, identity), "dev_login", "issuer_host", "provider", "providers")

	raw, _ := json.Marshal(identity["providers"])
	var rows []SystemOverviewIdentityProvider
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("providers = %s: %v", raw, err)
	}
	want := []SystemOverviewIdentityProvider{
		{ID: "tailscale", Label: "Tailscale", IssuerHost: "idp.example.ts.net"},
		{ID: "entra", Label: "Microsoft Entra ID", IssuerHost: "login.microsoftonline.com"},
		{ID: "local", Label: "Single sign-on", IssuerHost: ""},
	}
	if len(rows) != len(want) {
		t.Fatalf("providers = %s, want %d rows", raw, len(want))
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Errorf("providers[%d] = %+v, want %+v", i, rows[i], want[i])
		}
	}
	// The compatibility member is the FIRST provider's host — the row a
	// pre-ADR-0083 reader prints — and no issuer URL, path or client id rides
	// out with any of this.
	if identity["issuer_host"] != "idp.example.ts.net" {
		t.Errorf("issuer_host = %v, want the first provider's host", identity["issuer_host"])
	}
	body := rec.Body.String()
	for _, leak := range []string{"login.microsoftonline.com/tenant", "not-a-url", ovChatKey, ovDecisionKey} {
		if strings.Contains(body, leak) {
			t.Errorf("body leaked %q: %s", leak, body)
		}
	}
}

// TestSystemOverviewWorkerChatVisible is the other arm: a deployment that
// shares one environment between serve and its worker shows what it can see —
// the first allowlist entry, the bare host, and a real key_set.
func TestSystemOverviewWorkerChatVisible(t *testing.T) {
	t.Parallel()
	deps := ovConfig()
	set := false
	deps.WorkerChat = WorkerChatConfig{
		BaseURL: "http://collective.internal:8000/v1/",
		Model:   ovProbeModel,
		KeySet:  &set,
	}
	f := ovFixtureFor(t, newOVStore(), &ovWorkers{}, deps, "u-1", false)

	row := f.modelRow(t, "worker_chat")
	if row["model"] != ovProbeModel || row["endpoint_host"] != "collective.internal" {
		t.Errorf("worker_chat row = %v, want the first allowlist entry and the bare host", row)
	}
	if row["key_set"] != false || row["configured"] != true {
		t.Errorf("worker_chat row = %v, want key_set:false (visible, absent) and configured:true", row)
	}

	// A host with no allowlist entry registers no model the worker would run,
	// which is not configured — the checklist's rule, applied to the fourth
	// row for the same reason.
	deps2 := ovConfig()
	deps2.WorkerChat = WorkerChatConfig{BaseURL: "http://collective.internal:8000/v1"}
	f2 := ovFixtureFor(t, newOVStore(), &ovWorkers{}, deps2, "u-1", false)
	if row := f2.modelRow(t, "worker_chat"); row["configured"] != false {
		t.Errorf("worker_chat row = %v, want configured:false with an empty allowlist", row)
	}
}

// TestSystemOverviewSecretCountsRespectMembership is the count rule proven by
// routing rather than by reading the source: three callers over one world,
// three answers, and the stranger's fan-out never happens at all.
func TestSystemOverviewSecretCountsRespectMembership(t *testing.T) {
	t.Parallel()
	store := newOVStore()
	store.visible["u-member"] = []ProjectView{{ID: "p-1", Slug: "home", Name: "Home"}}
	store.secrets["p-1"] = []SecretView{{ID: "s-1", Slug: "DEPLOY", Scope: "project"}}
	store.mounts["p-1"] = []SecretMountView{{ID: "m-1"}}

	rec := ovFixtureFor(t, store, &ovWorkers{}, ovConfig(), "u-member", false).
		get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	if got := decodeBody(t, rec)["secrets"].(map[string]any); got["projects"] != float64(1) ||
		got["secrets"] != float64(1) || got["mounts"] != float64(1) {
		t.Errorf("member secrets = %v, want 1/1/1", got)
	}

	// A caller in no project: the same world, and the store refuses their read
	// of p-1 with the not-found sentinel. The body must read zeros, not 500 —
	// and the per-project reads must never be attempted for them.
	stranger := ovFixtureFor(t, store, &ovWorkers{}, ovConfig(), "u-stranger", false)
	rec = stranger.get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusOK {
		t.Fatalf("non-member status = %d (%s)", rec.Code, rec.Body)
	}
	if got := decodeBody(t, rec)["secrets"].(map[string]any); got["projects"] != float64(0) ||
		got["secrets"] != float64(0) || got["mounts"] != float64(0) {
		t.Errorf("non-member secrets = %v, want 0/0/0", got)
	}
	for _, call := range store.callLog() {
		if strings.HasPrefix(call, "secrets:u-stranger") || strings.HasPrefix(call, "mounts:u-stranger") {
			t.Errorf("a caller with no projects reached the per-project read: %s", call)
		}
	}

	// Org-scoped secrets: two projects, one shared secret, and the answer is
	// 2 distinct secrets — not 3, which is what a per-project sum would say.
	store.visible["u-admin"] = []ProjectView{{ID: "p-1", Slug: "home", Name: "Home"}, {ID: "p-2", Slug: "work", Name: "Work"}}
	store.secrets["p-2"] = []SecretView{{ID: "s-1", Slug: "DEPLOY", Scope: "org"}, {ID: "s-2", Slug: "WEBHOOK", Scope: "project"}}
	rec = ovFixtureFor(t, store, &ovWorkers{}, ovConfig(), "u-admin", true).
		get(t, "/api/v1/system/overview")
	if got := decodeBody(t, rec)["secrets"].(map[string]any); got["projects"] != float64(2) ||
		got["secrets"] != float64(2) || got["mounts"] != float64(1) {
		t.Errorf("admin secrets = %v, want 2 projects / 2 distinct secrets (s-1 listed twice) / 1 mount", got)
	}
}

// TestSystemOverviewStoreFailureIsAProblem keeps a broken read from becoming a
// half-truth: no body at all, rather than a zero-filled "0 online" a page would
// render as healthy. The cause stays in the log (ADR-0014 § 2).
func TestSystemOverviewStoreFailureIsAProblem(t *testing.T) {
	t.Parallel()
	store := newOVStore()
	store.err = errStoreDown
	rec := ovFixtureFor(t, store, &ovWorkers{}, ovConfig(), "u-1", false).
		get(t, "/api/v1/system/overview")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if detail := decodeBody(t, rec)["detail"]; strings.Contains(fmt.Sprint(detail), errStoreDown.Error()) {
		t.Errorf("problem detail leaked the store error: %v", detail)
	}
}

// --- the probe -----------------------------------------------------------

// ovUpstream is one httptest model endpoint that records what it was asked and
// answers however the test says.
type ovUpstream struct {
	t      *testing.T
	mu     sync.Mutex
	seen   []ovUpstreamCall
	chatFn func(w http.ResponseWriter, r *http.Request)
	listFn func(w http.ResponseWriter, r *http.Request)
	server *httptest.Server
}

type ovUpstreamCall struct {
	method string
	path   string
	auth   string
	body   string
}

func newOVUpstream(t *testing.T) *ovUpstream {
	t.Helper()
	u := &ovUpstream{t: t}
	u.chatFn = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}
	u.listFn = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen3-asr-1-7b"}]}`))
	}
	u.server = httptest.NewServer(u.handler())
	t.Cleanup(u.server.Close)
	return u
}

func (u *ovUpstream) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		if r.Body != nil {
			body, _ = io.ReadAll(io.LimitReader(r.Body, 1<<20))
		}
		u.mu.Lock()
		u.seen = append(u.seen, ovUpstreamCall{
			method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), body: string(body),
		})
		u.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			u.chatFn(w, r)
		case strings.HasSuffix(r.URL.Path, "/models"):
			u.listFn(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func (u *ovUpstream) url() string { return u.server.URL }

func (u *ovUpstream) calls() []ovUpstreamCall {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]ovUpstreamCall{}, u.seen...)
}

// ovProbeFixture points all three endpoints at one upstream under different
// roots, so a request to the wrong path is visible rather than plausible.
func ovProbeFixture(t *testing.T, u *ovUpstream, userID string, isOrgAdmin bool, tweak func(*SystemOverviewDeps)) *ovFixture {
	t.Helper()
	deps := ovConfig()
	deps.Chat.BaseURL = u.url() + "/v1"
	deps.Models.SpeechBaseURL = u.url() + "/speech/v1"
	deps.Models.DecisionBaseURL = u.url() + "/judge/v1"
	if tweak != nil {
		tweak(&deps)
	}
	return ovFixtureFor(t, newOVStore(), &ovWorkers{}, deps, userID, isOrgAdmin)
}

func TestModelProbeAssistantSendsTheFixedQuestion(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	rec := f.post(t, "/api/v1/system/models/assistant/probe")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["ok"] != true {
		t.Fatalf("probe = %v, want ok (logs: %s)", body, f.logs)
	}
	if body["detail"] != "" {
		t.Errorf("detail = %v, want empty on success", body["detail"])
	}
	if ms, ok := body["latency_ms"].(float64); !ok || ms < 0 {
		t.Errorf("latency_ms = %v, want a non-negative number", body["latency_ms"])
	}

	calls := u.calls()
	if len(calls) != 1 {
		t.Fatalf("upstream calls = %+v, want exactly one", calls)
	}
	call := calls[0]
	if call.method != http.MethodPost || call.path != "/v1/chat/completions" {
		t.Errorf("call = %s %s, want POST /v1/chat/completions", call.method, call.path)
	}
	if call.auth != "Bearer "+ovChatKey {
		t.Errorf("Authorization = %q, want the assistant key, in the header only", call.auth)
	}
	// The whole request: two words, the configured model, four tokens. A system
	// prompt, a tool list or a temperature here is spend the probe has no
	// right to make on the organization's account.
	var sent map[string]any
	if err := json.Unmarshal([]byte(call.body), &sent); err != nil {
		t.Fatalf("request body %q: %v", call.body, err)
	}
	prjWantFields(t, []byte(call.body), "max_tokens", "messages", "model")
	if sent["max_tokens"] != float64(4) || sent["model"] != ovProbeModel {
		t.Errorf("request = %v, want max_tokens 4 and the configured model", sent)
	}
	msgs, _ := sent["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("messages = %v, want the one user turn", sent["messages"])
	}
	if m := msgs[0].(map[string]any); m["role"] != "user" || m["content"] != probePrompt {
		t.Errorf("message = %v, want the user turn that asks for ok", m)
	}
}

func TestModelProbeSpeechChecksTheModelList(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	if rec := f.post(t, "/api/v1/system/models/speech/probe"); decodeBody(t, rec)["ok"] != true {
		t.Fatalf("speech probe = %s, want ok", rec.Body)
	}
	calls := u.calls()
	if len(calls) != 1 || calls[0].method != http.MethodGet || calls[0].path != "/speech/v1/models" {
		t.Fatalf("calls = %+v, want one GET /speech/v1/models", calls)
	}
	if calls[0].auth != "Bearer "+ovSpeechKey {
		t.Errorf("Authorization = %q, want the speech key", calls[0].auth)
	}
	if calls[0].body != "" {
		t.Errorf("speech probe sent a body (%q): it reads the model list, it does not upload audio", calls[0].body)
	}

	// The endpoint answers, and the model the deployment names is not on it:
	// the contract's failure answer, in its own words.
	u.listFn = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"some-other-model"}]}`))
	}
	f.clock.Advance(11 * time.Second)
	body := decodeBody(t, f.post(t, "/api/v1/system/models/speech/probe"))
	if body["ok"] != false {
		t.Fatalf("probe = %v, want ok:false when the configured model is not listed", body)
	}
	if body["detail"] != `model "qwen3-asr-1-7b" is not currently available` {
		t.Errorf("detail = %v", body["detail"])
	}
}

func TestModelProbeRefusalCarriesTheUpstreamMessageOnly(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	// A gateway-style error envelope that echoes the key back inside the
	// message and again in a header: the message is the answer, the key is
	// redacted out of it, and the header is never read.
	u.chatFn = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Debug-Echo", "Bearer "+ovChatKey)
		_, _ = w.Write([]byte(`{"error":{"message":"model \"qwen-nope\" is not currently available (key ` +
			ovChatKey + ` accepted)","type":"invalid_request_error"}}`))
	}
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	rec := f.post(t, "/api/v1/system/models/assistant/probe")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["ok"] != false {
		t.Fatalf("probe = %v, want ok:false against an error envelope", body)
	}
	detail, _ := body["detail"].(string)
	if !strings.HasPrefix(detail, `model "qwen-nope" is not currently available`) {
		t.Errorf("detail = %q, want the upstream's own message", detail)
	}
	if strings.Contains(detail, "\n") || strings.Contains(detail, "  ") {
		t.Errorf("detail = %q, want one collapsed line", detail)
	}

	// The leak check, on both surfaces the contract names.
	out := rec.Body.String() + "\n" + f.logs.String()
	for _, leak := range []string{ovChatKey, ovSpeechKey, ovDecisionKey, "Bearer ", "X-Debug-Echo"} {
		if strings.Contains(out, leak) {
			t.Errorf("probe output leaked %q:\n%s", leak, out)
		}
	}
	if !strings.Contains(f.logs.String(), "[redacted]") {
		t.Errorf("logs = %s, want the echoed key redacted rather than repeated", f.logs.String())
	}
}

func TestModelProbeTruncatesALongUpstreamMessage(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	u.chatFn = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><body>" + strings.Repeat("gateway detail ", 80) + "</body></html>"))
	}
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	detail, _ := decodeBody(t, f.post(t, "/api/v1/system/models/assistant/probe"))["detail"].(string)
	if r := []rune(detail); len(r) > probeDetailMaxChars {
		t.Errorf("detail = %d chars, want at most %d", len(r), probeDetailMaxChars)
	}
	if detail == "" {
		t.Error("detail is empty: a 502 with an unparseable body still owes the reader a sentence")
	}
}

func TestModelProbeDecisionUsesTheJudgesOwnKey(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	if rec := f.post(t, "/api/v1/system/models/decision/probe"); decodeBody(t, rec)["ok"] != true {
		t.Fatalf("decision probe = %s, want ok", rec.Body)
	}
	calls := u.calls()
	if len(calls) != 1 || calls[0].path != "/judge/v1/chat/completions" {
		t.Fatalf("calls = %+v, want one POST to the judge's root", calls)
	}
	if calls[0].auth != "Bearer "+ovDecisionKey {
		t.Errorf("Authorization = %q, want the judge's key: one process's endpoint must not silently become another's", calls[0].auth)
	}
}

func TestModelProbeRequiresTheLibraryRole(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	member := ovProbeFixture(t, u, "u-member", false, nil)

	rec := member.post(t, "/api/v1/system/models/assistant/probe")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if calls := u.calls(); len(calls) != 0 {
		t.Errorf("upstream calls = %+v, want a refused probe to send nothing", calls)
	}
	// The admin reading the same route is the point of the difference.
	admin := ovProbeFixture(t, u, "u-admin", true, nil)
	if rec := admin.post(t, "/api/v1/system/models/assistant/probe"); rec.Code != http.StatusOK {
		t.Fatalf("admin probe = %d (%s)", rec.Code, rec.Body)
	}
}

// TestModelProbeCSRFAndAuthAreTheRoutesTheyAreEverywhere: the probe is a POST,
// so the CSRF guard applies before the role check, and an anonymous request is
// 401 rather than a 403 that names the role.
func TestModelProbeCSRFAndAuthAreTheSameAsEveryMutation(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	member := ovProbeFixture(t, u, "u-member", false, nil)

	noToken := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/system/models/assistant/probe", nil)
	noToken.Header.Set("Origin", "http://localhost:8080")
	if rec := do(t, member.srv, noToken); rec.Code != http.StatusForbidden {
		t.Errorf("csrf-less probe = %d, want 403 (%s)", rec.Code, rec.Body)
	}

	anonymous := newTestServerWith(t,
		Config{ReplicaName: "r", Version: "1", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{}, principalAuth(nil, ErrUnauthenticated))
	RegisterSystemOverview(anonymous, NewSystemOverviewService(ovConfig(), nil))
	rec := do(t, anonymous, request(http.MethodPost, "http://localhost:8080/api/v1/system/models/assistant/probe", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous probe = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	rec = do(t, anonymous, request(http.MethodGet, "http://localhost:8080/api/v1/system/overview", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous overview = %d, want 401", rec.Code)
	}
}

func TestModelProbeIsOncePerKindPerTenSeconds(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	f := ovProbeFixture(t, u, "u-admin", true, nil)

	if rec := f.post(t, "/api/v1/system/models/assistant/probe"); rec.Code != http.StatusOK {
		t.Fatalf("first probe = %d (%s)", rec.Code, rec.Body)
	}
	// A different kind is a different bucket.
	if rec := f.post(t, "/api/v1/system/models/speech/probe"); rec.Code != http.StatusOK {
		t.Fatalf("speech probe = %d (%s)", rec.Code, rec.Body)
	}
	rec := f.post(t, "/api/v1/system/models/assistant/probe")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second assistant probe = %d, want 429 (%s)", rec.Code, rec.Body)
	}
	if retry := rec.Header().Get("Retry-After"); retry == "" {
		t.Error("the 429 carried no Retry-After")
	}
	if got := len(u.calls()); got != 2 {
		t.Errorf("upstream calls = %d, want the refused probe to have sent nothing", got)
	}

	// Past the window the bucket refills and the same kind answers again.
	f.clock.Advance(11 * time.Second)
	if rec := f.post(t, "/api/v1/system/models/assistant/probe"); rec.Code != http.StatusOK {
		t.Fatalf("probe after the window = %d (%s)", rec.Code, rec.Body)
	}
}

// TestModelProbeRefusalsDistinguishUnknownFromUnconfigured pins the two refusals
// the page must not confuse: an unknown kind is the client's error (400), a kind
// this deployment never configured is a result (200 ok:false) that names the
// variable to set, and `worker_chat` is neither probeable nor reachable here.
func TestModelProbeRefusalsDistinguishUnknownFromUnconfigured(t *testing.T) {
	t.Parallel()
	u := newOVUpstream(t)
	f := ovProbeFixture(t, u, "u-admin", true, func(d *SystemOverviewDeps) {
		d.Chat.BaseURL = ""
		d.Models.DecisionBaseURL = ""
		d.Models.DecisionModel = ""
	})

	rec := f.post(t, "/api/v1/system/models/nope/probe")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if detail := decodeProblem(t, f.post(t, "/api/v1/system/models/nope/probe")).Detail; !strings.Contains(detail, "assistant") {
		t.Errorf("problem detail = %q, want it to name the probeable kinds", detail)
	}

	body := decodeBody(t, f.post(t, "/api/v1/system/models/assistant/probe"))
	if body["ok"] != false {
		t.Fatalf("probe = %v, want ok:false for an endpoint nobody configured", body)
	}
	if detail, _ := body["detail"].(string); !strings.Contains(detail, "COMMUNICATION_ASSISTANT_BASE_URL") {
		t.Errorf("detail = %q, want it to name the variable that fixes it", detail)
	}

	rec = f.post(t, "/api/v1/system/models/worker_chat/probe")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("worker_chat probe = %d, want 400: this replica holds neither its endpoint nor its key (%s)", rec.Code, rec.Body)
	}
	if got := len(u.calls()); got != 0 {
		t.Errorf("upstream calls = %d, want no egress for a refusal or an unconfigured kind", got)
	}
}

// TestModelProbeDeadlineIsTheReplicasOwn checks that a probe which cannot get an
// answer gives up on the server's clock, not the browser's: the deadline is the
// route's, the failure is a result, and the line names the host.
func TestModelProbeDeadlineIsTheReplicasOwn(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	wedged := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		<-release
	}))
	t.Cleanup(func() {
		close(release)
		wedged.Close()
	})

	deps := ovConfig()
	deps.Chat.BaseURL = wedged.URL + "/v1"
	deps.ProbeTimeout = 60 * time.Millisecond
	f := ovFixtureFor(t, newOVStore(), &ovWorkers{}, deps, "u-admin", true)

	rec := f.post(t, "/api/v1/system/models/assistant/probe")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["ok"] != false {
		t.Fatalf("probe = %v, want ok:false against a wedged endpoint", body)
	}
	detail, _ := body["detail"].(string)
	host := strings.TrimPrefix(wedged.URL, "http://")
	if before, _, _ := strings.Cut(host, ":"); !strings.Contains(detail, before) {
		t.Errorf("detail = %q, want the host the probe could not reach", detail)
	}
	if strings.Contains(detail, wedged.URL+"/v1") {
		t.Errorf("detail = %q, want the host and not the full URL", detail)
	}
}

// --- the config hand-offs this route depends on --------------------------

// TestWorkerChatConfigFromEnv pins the one new environment read: the FIRST
// allowlist entry (not the last, not the list), the trailing slash trimmed off
// the root, key_set visible-and-false with a root but no key, and key_set NULL
// when this pod cannot see the question at all.
func TestWorkerChatConfigFromEnv(t *testing.T) {
	t.Parallel()
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if got := WorkerChatConfigFromEnv(get); got.BaseURL != "" || got.Model != "" || got.KeySet != nil {
		t.Errorf("unset = %+v, want the zero answer with key_set unknown", got)
	}

	env["COMMUNICATION_MODEL_CHAT_BASE_URL"] = "http://collective.internal:8000/v1/"
	env["COMMUNICATION_MODEL_CHAT_MODELS"] = " david-birks/qwen3-8-flash-next , other/one "
	got := WorkerChatConfigFromEnv(get)
	if got.BaseURL != "http://collective.internal:8000/v1" {
		t.Errorf("BaseURL = %q, want the trailing slash trimmed", got.BaseURL)
	}
	if got.Model != ovProbeModel {
		t.Errorf("Model = %q, want the first allowlist entry", got.Model)
	}
	if got.KeySet == nil || *got.KeySet != false {
		t.Errorf("KeySet = %v, want a visible, absent key reported as false", got.KeySet)
	}

	env["COMMUNICATION_MODEL_CHAT_API_KEY"] = "anything-at-all"
	if got = WorkerChatConfigFromEnv(get); got.KeySet == nil || *got.KeySet != true {
		t.Errorf("KeySet = %v, want true once a key is set", got.KeySet)
	}
}

// TestArtifactBackendName keeps the storage row honest about a backend that does
// not name itself, rather than defaulting the display to "local". The named
// case is a stand-in for the S3 backend (the real one wants a volume this test
// has no business creating, and the whole function does is read the name).
func TestArtifactBackendName(t *testing.T) {
	t.Parallel()
	if got := ArtifactBackendName(nil); got != "" {
		t.Errorf("no backend = %q, want \"\"", got)
	}
	if got := ArtifactBackendName(unnamedStore{}); got != "" {
		t.Errorf("a backend that does not name itself = %q, want \"\"", got)
	}
	if got := ArtifactBackendName(namedStore{}); got != artifacts.BackendS3 {
		t.Errorf("named backend = %q, want %q", got, artifacts.BackendS3)
	}
}

// unnamedStore satisfies artifacts.Store without naming itself: the case the
// empty answer is for.
type unnamedStore struct{}

func (unnamedStore) Put(context.Context, artifacts.Input) (artifacts.Ref, error) {
	return artifacts.Ref{}, artifacts.ErrUnsupported
}
func (unnamedStore) Open(context.Context, artifacts.Ref) (io.ReadCloser, int64, error) {
	return nil, 0, artifacts.ErrUnsupported
}
func (unnamedStore) Stat(context.Context, artifacts.Ref) (artifacts.Ref, error) {
	return artifacts.Ref{}, artifacts.ErrUnsupported
}
func (unnamedStore) Delete(context.Context, artifacts.Ref) error { return artifacts.ErrUnsupported }
func (unnamedStore) Presign(context.Context, artifacts.Ref, time.Duration, string) (string, time.Time, error) {
	return "", time.Time{}, artifacts.ErrUnsupported
}

// namedStore is the same store that does name itself.
type namedStore struct{ unnamedStore }

func (namedStore) Backend() string { return artifacts.BackendS3 }

// TestOverviewRoutesAreMounted proves the closed surface by routing: the two
// patterns RegisterSystemOverview installs answer, and the sub-route a leak-shaped
// follow-on would plausibly have does not exist.
func TestOverviewRoutesAreMountedAndNothingElseIs(t *testing.T) {
	t.Parallel()
	f := ovFixtureFor(t, newOVStore(), &ovWorkers{}, ovConfig(), "u-1", true)
	for _, route := range [][2]string{
		{http.MethodGet, "/api/v1/system/overview"},
		{http.MethodPost, "/api/v1/system/models/assistant/probe"},
	} {
		rec := do(t, f.srv, request(route[0], "http://localhost:8080"+route[1], nil))
		if strings.Contains(rec.Body.String(), "no endpoint") {
			t.Errorf("%s %s is not mounted", route[0], route[1])
		}
	}
	for _, target := range []string{"/api/v1/system/overview/secrets", "/api/v1/system/models/assistant"} {
		rec := do(t, f.srv, request(http.MethodGet, "http://localhost:8080"+target, nil))
		if !strings.Contains(rec.Body.String(), "no endpoint") {
			t.Errorf("%s answered; the surface is closed by routing, not by comment: %s", target, rec.Body)
		}
	}
}
