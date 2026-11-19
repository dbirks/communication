package api

// ADR-0085: the in-app agent sign-in surface. The store is a fake that answers
// with the port's own sentinels, so what this file pins is the WIRE: the route
// set, the admin gate (403 before any store call, on all five routes), the 404
// for a launcher without a driver, the 409s, the code trim and its 400s — and
// the one property that matters more than the rest: the pasted Antigravity
// code never appears in a response body or a log line. The real-Postgres
// semantics (claim/lease, read-and-clear, the one-active index) live in
// internal/store/postgres/agent_logins_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const (
	aagBase       = "http://localhost:8080"
	aagLoginID    = "01987a71-4444-7000-8000-abcdef012345"
	aagSecretCode = "SECRET-AAG-CODE-9138-DO-NOT-LOG"
)

// --- fake store ----------------------------------------------------------

type aagFakeStore struct {
	calls []string

	items    []AgentAccountView
	listErr  error
	created  AgentLoginView
	createEr error
	// lastStart records what reached CreateAgentLogin so the worker_id
	// validation tests can see the handler actually trimmed and passed it.
	lastLauncher string
	lastWorkerID string

	login    AgentLoginView
	getErr   error
	submitEr error
	lastCode string
	cancelEr error
}

func (f *aagFakeStore) ListAgentAccounts(context.Context, Caller) ([]AgentAccountView, error) {
	f.calls = append(f.calls, "list")
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.items, nil
}

func (f *aagFakeStore) CreateAgentLogin(_ context.Context, _ Caller, launcher, workerID string) (AgentLoginView, error) {
	f.calls = append(f.calls, "create:"+launcher)
	f.lastLauncher, f.lastWorkerID = launcher, workerID
	if f.createEr != nil {
		return AgentLoginView{}, f.createEr
	}
	return f.created, nil
}

func (f *aagFakeStore) GetAgentLogin(_ context.Context, _ Caller, id string) (AgentLoginView, error) {
	f.calls = append(f.calls, "get:"+id)
	if f.getErr != nil {
		return AgentLoginView{}, f.getErr
	}
	return f.login, nil
}

func (f *aagFakeStore) SubmitAgentLoginCode(_ context.Context, _ Caller, id, code string) error {
	f.calls = append(f.calls, "code:"+id)
	f.lastCode = code
	return f.submitEr
}

func (f *aagFakeStore) CancelAgentLogin(_ context.Context, _ Caller, id string) error {
	f.calls = append(f.calls, "cancel:"+id)
	return f.cancelEr
}

// --- mount helpers --------------------------------------------------------

func aagMount(t *testing.T, store *aagFakeStore, auth Authenticator, log *slog.Logger) *Server {
	t.Helper()
	if log == nil {
		log = discardLogger()
	}
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: aagBase, Logger: log},
		fakeReadiness{expected: 3}, auth, nil)
	RegisterAgentAccounts(s, store)
	return s
}

func aagAuth(isAdmin bool) Authenticator {
	return principalAuth(&Principal{UserID: "u-aag", OrganizationID: "o-1",
		DisplayName: "U", CSRFToken: "csrf-token-value", IsOrgAdmin: isAdmin}, nil)
}

func aagSend(t *testing.T, s *Server, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", aagBase)
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

func aagProblemDetail(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeProblem(t, rec).Detail
}

// aagLogin is a queued Codex sign-in whose nullable fields are all nil: the
// shape tests read it as "every nullable key is present as null".
func aagLogin() AgentLoginView {
	return AgentLoginView{
		ID: aagLoginID, Launcher: "codex", Status: "awaiting_user",
		NeedsCode: false,
		ExpiresAt: "2026-11-18T10:00:00Z", CreatedAt: "2026-11-18T09:45:00Z",
		UpdatedAt: "2026-11-18T09:45:30Z",
	}
}

func aagAccountItem() AgentAccountView {
	return AgentAccountView{
		WorkerID: "w-1", WorkerName: "worker-eu", Launcher: "codex", State: "signed_out",
	}
}

// --- the admin gate -------------------------------------------------------

// TestAgentAccountAdminGateOnEveryRoute: a non-admin is 403 on all five routes
// and the store is never touched — the gate runs before any query, not after.
func TestAgentAccountAdminGateOnEveryRoute(t *testing.T) {
	routes := []struct {
		method, target, body string
	}{
		{http.MethodGet, "/api/v1/agent-accounts", ""},
		{http.MethodPost, "/api/v1/agent-accounts/codex/logins", ""},
		{http.MethodGet, "/api/v1/agent-logins/" + aagLoginID, ""},
		{http.MethodPost, "/api/v1/agent-logins/" + aagLoginID + "/code", `{"code":"x"}`},
		{http.MethodPost, "/api/v1/agent-logins/" + aagLoginID + "/cancel", ""},
	}
	for _, rt := range routes {
		store := &aagFakeStore{}
		s := aagMount(t, store, aagAuth(false), nil)
		rec := aagSend(t, s, rt.method, rt.target, rt.body)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d (%s), want 403", rt.method, rt.target, rec.Code, rec.Body)
		}
		if got := aagProblemDetail(t, rec); got != "Only organization admins can manage agent sign-ins." {
			t.Errorf("%s %s detail = %q", rt.method, rt.target, got)
		}
		if len(store.calls) != 0 {
			t.Errorf("%s %s touched the store: %v", rt.method, rt.target, store.calls)
		}
	}
}

// TestAgentAccountRoutesRequireSession: with no session every route is 401 —
// HandleAuthed's rule, pinned once for the new mounts.
func TestAgentAccountRoutesRequireSession(t *testing.T) {
	noSession := principalAuth(nil, ErrUnauthenticated)
	s := aagMount(t, &aagFakeStore{}, noSession, nil)
	for _, rt := range [][2]string{
		{http.MethodGet, "/api/v1/agent-accounts"},
		{http.MethodPost, "/api/v1/agent-accounts/codex/logins"},
		{http.MethodGet, "/api/v1/agent-logins/" + aagLoginID},
		{http.MethodPost, "/api/v1/agent-logins/" + aagLoginID + "/code"},
		{http.MethodPost, "/api/v1/agent-logins/" + aagLoginID + "/cancel"},
	} {
		rec := aagSend(t, s, rt[0], rt[1], "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401", rt[0], rt[1], rec.Code)
		}
	}
}

// --- the list ---------------------------------------------------------------

func TestAgentAccountListShape(t *testing.T) {
	store := &aagFakeStore{items: []AgentAccountView{aagAccountItem()}}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-accounts", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body)
	}
	var list map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	items, ok := list["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items = %v, want one row", list["items"])
	}
	row := items[0].(map[string]any)
	for _, key := range []string{"worker_id", "worker_name", "launcher", "state",
		"account_label", "detail", "checked_at", "login"} {
		if _, present := row[key]; !present {
			t.Errorf("AgentAccount row is missing %q (required in openapi): %s", key, rec.Body)
		}
	}
	for _, nullable := range []string{"account_label", "detail", "checked_at", "login"} {
		if row[nullable] != nil {
			t.Errorf("%s = %v, want null", nullable, row[nullable])
		}
	}
}

func TestAgentAccountListEmptyIsNotNull(t *testing.T) {
	for name, items := range map[string][]AgentAccountView{"nil": nil, "empty": {}} {
		store := &aagFakeStore{items: items}
		s := aagMount(t, store, aagAuth(true), nil)
		rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-accounts", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: GET = %d", name, rec.Code)
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"items":[]}` {
			t.Errorf("%s: body = %s, want {\"items\":[]}", name, got)
		}
	}
}

// --- starting a sign-in ------------------------------------------------------

func TestAgentLoginStartShape(t *testing.T) {
	store := &aagFakeStore{created: aagLogin()}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-accounts/antigravity/logins", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d (%s)", rec.Code, rec.Body)
	}
	if store.lastLauncher != "antigravity" || store.lastWorkerID != "" {
		t.Errorf("store saw launcher=%q worker=%q, want antigravity and the any-worker empty id",
			store.lastLauncher, store.lastWorkerID)
	}
	var view map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	for _, key := range []string{"id", "launcher", "worker_id", "status", "verification_url",
		"user_code", "needs_code", "account_label", "error", "expires_at", "created_at", "updated_at"} {
		if _, present := view[key]; !present {
			t.Errorf("AgentLogin is missing %q (required in openapi): %s", key, rec.Body)
		}
	}
	for _, nullable := range []string{"worker_id", "verification_url", "user_code",
		"account_label", "error"} {
		if view[nullable] != nil {
			t.Errorf("%s = %v, want null", nullable, view[nullable])
		}
	}
	if view["needs_code"] != false {
		t.Errorf("needs_code = %v, want false", view["needs_code"])
	}
}

func TestAgentLoginStartBodies(t *testing.T) {
	tests := []struct {
		name, body     string
		wantStatus     int
		wantWorkerID   string
		wantCall       bool
		wantDetailPart string
	}{
		{name: "empty body is any worker", body: "", wantStatus: http.StatusCreated, wantWorkerID: "", wantCall: true},
		{name: "empty object", body: "{}", wantStatus: http.StatusCreated, wantWorkerID: "", wantCall: true},
		{name: "worker id trimmed", body: `{"worker_id":"  w-9  "}`, wantStatus: http.StatusCreated, wantWorkerID: "w-9", wantCall: true},
		{name: "worker id null is any", body: `{"worker_id":null}`, wantStatus: http.StatusCreated, wantWorkerID: "", wantCall: true},
		{name: "unknown field", body: `{"worker_id":"w-9","sudo":true}`, wantStatus: http.StatusBadRequest, wantDetailPart: "not valid JSON"},
		{name: "empty worker id", body: `{"worker_id":""}`, wantStatus: http.StatusBadRequest, wantDetailPart: "between 1 and 200"},
		{name: "blank worker id", body: `{"worker_id":"   "}`, wantStatus: http.StatusBadRequest, wantDetailPart: "between 1 and 200"},
		{name: "over-long worker id", body: `{"worker_id":"` + strings.Repeat("w", 201) + `"}`,
			wantStatus: http.StatusBadRequest, wantDetailPart: "between 1 and 200"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &aagFakeStore{created: aagLogin()}
			s := aagMount(t, store, aagAuth(true), nil)
			rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-accounts/codex/logins", tt.body)
			if rec.Code != tt.wantStatus {
				t.Fatalf("POST = %d (%s), want %d", rec.Code, rec.Body, tt.wantStatus)
			}
			if tt.wantCall {
				if store.lastWorkerID != tt.wantWorkerID {
					t.Errorf("store worker_id = %q, want %q", store.lastWorkerID, tt.wantWorkerID)
				}
			} else {
				if tt.wantDetailPart != "" && !strings.Contains(aagProblemDetail(t, rec), tt.wantDetailPart) {
					t.Errorf("detail = %q, want it to mention %q", aagProblemDetail(t, rec), tt.wantDetailPart)
				}
				if len(store.calls) != 0 {
					t.Errorf("rejected body still reached the store: %v", store.calls)
				}
			}
		})
	}
}

func TestAgentLoginStartUnknownLauncherIs404(t *testing.T) {
	store := &aagFakeStore{}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-accounts/claude/logins", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST = %d, want 404", rec.Code)
	}
	if got := aagProblemDetail(t, rec); got != "No in-app sign-in for that agent." {
		t.Errorf("detail = %q", got)
	}
	if len(store.calls) != 0 {
		t.Errorf("unsupported launcher reached the store: %v", store.calls)
	}
}

func TestAgentLoginStartConflictIs409(t *testing.T) {
	store := &aagFakeStore{createEr: ErrAgentLoginActive}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-accounts/codex/logins", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("POST = %d, want 409", rec.Code)
	}
	if got := aagProblemDetail(t, rec); got != "A sign-in for this agent is already in progress." {
		t.Errorf("detail = %q", got)
	}
}

func TestAgentLoginStartWorkerNotFoundIs404(t *testing.T) {
	store := &aagFakeStore{createEr: ErrAgentLoginNotFound}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-accounts/codex/logins", `{"worker_id":"w-gone"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST = %d, want 404", rec.Code)
	}
}

// --- reading a sign-in -------------------------------------------------------

func TestAgentLoginGet(t *testing.T) {
	login := aagLogin()
	url, code := "https://auth.openai.com/codex/device", "ABCD-EFGH"
	login.VerificationURL, login.UserCode = &url, &code
	store := &aagFakeStore{login: login}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-logins/"+aagLoginID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body)
	}
	if store.calls[0] != "get:"+aagLoginID {
		t.Fatalf("store calls = %v", store.calls)
	}
	body := rec.Body.String()
	for _, want := range []string{`"verification_url":"` + url + `"`, `"user_code":"` + code + `"`} {
		if !strings.Contains(body, want) {
			t.Errorf("body = %s, want it to carry %s", body, want)
		}
	}
	if strings.Contains(body, "submitted_code") {
		t.Errorf("body carries submitted_code: %s", body)
	}
}

func TestAgentLoginGetMalformedIDIs404WithoutStore(t *testing.T) {
	store := &aagFakeStore{}
	s := aagMount(t, store, aagAuth(true), nil)
	for _, id := range []string{"not-a-uuid", strings.Repeat("0", 36)} {
		rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-logins/"+id, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET /%s = %d, want 404", id, rec.Code)
		}
		if got := aagProblemDetail(t, rec); got != "No such sign-in." {
			t.Errorf("GET /%s detail = %q", id, got)
		}
	}
	if len(store.calls) != 0 {
		t.Fatalf("malformed ids reached the store: %v", store.calls)
	}
}

func TestAgentLoginGetNotFoundIs404(t *testing.T) {
	store := &aagFakeStore{getErr: ErrAgentLoginNotFound}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-logins/"+aagLoginID, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET = %d, want 404", rec.Code)
	}
	if got := aagProblemDetail(t, rec); got != "No such sign-in." {
		t.Errorf("detail = %q", got)
	}
}

// --- pasting the code back ----------------------------------------------------

func TestAgentLoginCodeTrimAndAccept(t *testing.T) {
	store := &aagFakeStore{}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code",
		`{"code":"  `+aagSecretCode+`\n"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST code = %d (%s), want 202", rec.Code, rec.Body)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("202 body = %q, want empty", rec.Body.String())
	}
	if store.lastCode != aagSecretCode {
		t.Errorf("store code = %q, want the trimmed value", store.lastCode)
	}
}

func TestAgentLoginCodeBoundaries(t *testing.T) {
	// 2048 is legal, 2049 is not (AgentLoginCode maxLength).
	for _, n := range []int{2048, 2049} {
		store := &aagFakeStore{}
		s := aagMount(t, store, aagAuth(true), nil)
		rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code",
			`{"code":"`+strings.Repeat("k", n)+`"}`)
		want := http.StatusAccepted
		if n > 2048 {
			want = http.StatusBadRequest
		}
		if rec.Code != want {
			t.Fatalf("len %d: POST code = %d (%s), want %d", n, rec.Code, rec.Body, want)
		}
	}
}

func TestAgentLoginCodeBadRequests(t *testing.T) {
	tests := []struct{ name, body string }{
		{"missing body", ""},
		{"missing code", `{}`},
		{"empty code", `{"code":""}`},
		{"whitespace code", `{"code":"   \t\n "}`},
		{"unknown field", `{"code":"abc","extra":1}`},
		{"not json", `code=abc`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &aagFakeStore{}
			s := aagMount(t, store, aagAuth(true), nil)
			rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("POST code = %d, want 400", rec.Code)
			}
			if len(store.calls) != 0 {
				t.Errorf("bad body reached the store: %v", store.calls)
			}
		})
	}
}

func TestAgentLoginCodeStateConflictIs409(t *testing.T) {
	store := &aagFakeStore{submitEr: ErrAgentLoginState}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code", `{"code":"abc"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("POST code = %d, want 409", rec.Code)
	}
	if got := aagProblemDetail(t, rec); got != "This sign-in isn't waiting for a code." {
		t.Errorf("detail = %q", got)
	}
}

func TestAgentLoginCodeNotFoundIs404(t *testing.T) {
	store := &aagFakeStore{submitEr: ErrAgentLoginNotFound}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code", `{"code":"abc"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST code = %d, want 404", rec.Code)
	}
}

// TestAgentLoginCodeNeverLeaks is ADR-0085's privacy contract: the submitted
// code appears in no response body and no log line, on the accepted path and
// on every refusal path (the refusal bodies and the access/error logs are the
// two channels a code could escape through).
func TestAgentLoginCodeNeverLeaks(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	submit := func(store *aagFakeStore, body string) *httptest.ResponseRecorder {
		logs.Reset()
		s := aagMount(t, store, aagAuth(true), log)
		return aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/code", body)
	}
	cases := []struct {
		name  string
		store *aagFakeStore
		body  string
	}{
		{"accepted", &aagFakeStore{}, `{"code":"  ` + aagSecretCode + ` "}`},
		{"state 409", &aagFakeStore{submitEr: ErrAgentLoginState}, `{"code":"` + aagSecretCode + `"}`},
		{"not found 404", &aagFakeStore{submitEr: ErrAgentLoginNotFound}, `{"code":"` + aagSecretCode + `"}`},
		{"store 500", &aagFakeStore{submitEr: errStoreDown}, `{"code":"` + aagSecretCode + `"}`},
		{"oversized 400", &aagFakeStore{}, `{"code":"` + aagSecretCode + strings.Repeat("k", 2048) + `"}`},
		{"unknown field 400", &aagFakeStore{}, `{"code":"` + aagSecretCode + `","x":1}`},
		{"bad uuid 404", &aagFakeStore{}, `{"code":"` + aagSecretCode + `"}`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			rec := submit(tt.store, tt.body)
			if strings.Contains(rec.Body.String(), aagSecretCode) {
				t.Errorf("response body leaks the code: %s", rec.Body)
			}
			if strings.Contains(logs.String(), aagSecretCode) {
				t.Errorf("logs leak the code: %s", logs.String())
			}
		})
	}
}

// --- cancelling ----------------------------------------------------------------

func TestAgentLoginCancel(t *testing.T) {
	store := &aagFakeStore{}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/cancel", "")
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST cancel = %d (%s), want 202", rec.Code, rec.Body)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("202 body = %q, want empty", rec.Body.String())
	}
	if store.calls[0] != "cancel:"+aagLoginID {
		t.Fatalf("store calls = %v", store.calls)
	}
}

func TestAgentLoginCancelNotFoundIs404(t *testing.T) {
	store := &aagFakeStore{cancelEr: ErrAgentLoginNotFound}
	s := aagMount(t, store, aagAuth(true), nil)
	rec := aagSend(t, s, http.MethodPost, "/api/v1/agent-logins/"+aagLoginID+"/cancel", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST cancel = %d, want 404", rec.Code)
	}
}

// --- store failures -------------------------------------------------------------

func TestAgentAccountStoreErrorIs500WithRequestID(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	store := &aagFakeStore{listErr: errStoreDown}
	s := aagMount(t, store, aagAuth(true), log)
	rec := aagSend(t, s, http.MethodGet, "/api/v1/agent-accounts", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET = %d, want 500", rec.Code)
	}
	if got := aagProblemDetail(t, rec); !strings.Contains(got, "request id") {
		t.Errorf("detail = %q, want the request-id sentence", got)
	}
	if !strings.Contains(logs.String(), errStoreDown.Error()) {
		t.Errorf("the store error was not logged: %s", logs.String())
	}
}

// --- route coverage ---------------------------------------------------------------

// TestAgentAccountRoutesAreDocumented is the contract guard for this surface,
// the same two-way check TestCatchUpRoutesAreDocumented runs for its own
// paths: the patterns registered in agent_accounts.go and the operations
// api/openapi.yaml declares under /agent-accounts and /agent-logins are one
// set, in both directions.
func TestAgentAccountRoutesAreDocumented(t *testing.T) {
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi document: %v", err)
	}
	documented := map[string]bool{}
	var current string
	for _, line := range strings.Split(string(raw), "\n") {
		if m := regexp.MustCompile(`^  (/api/v1/[^:]*):$`).FindStringSubmatch(line); m != nil {
			current = ""
			if strings.HasPrefix(m[1], "/api/v1/agent-accounts") ||
				strings.HasPrefix(m[1], "/api/v1/agent-logins") {
				current = m[1]
			}
			continue
		}
		if current == "" {
			continue
		}
		if m := regexp.MustCompile(`^    (get|post|put|patch|delete):$`).FindStringSubmatch(line); m != nil {
			documented[strings.ToUpper(m[1])+" "+current] = true
		}
	}
	registered := m4RegisteredPatterns(t, "agent_accounts.go")
	if len(registered) != 5 {
		t.Fatalf("agent_accounts.go registers %d routes, want the 5 ADR-0085 mounts: %v",
			len(registered), aagKeysOf(registered))
	}
	m4SetEqual(t, "openapi.yaml's agent sign-in paths vs the registered patterns", documented, registered)
}

func aagKeysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
