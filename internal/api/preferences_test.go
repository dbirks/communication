package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakePrefsStore is the in-memory PreferencesStore for the handler tests:
// it remembers the last patch and serves whatever document it is told to.
type fakePrefsStore struct {
	last  UserPreferencesPatch
	gotID string
	doc   UserPreferences
	err   error
}

func (f *fakePrefsStore) GetUserPreferences(ctx context.Context, userID string) (UserPreferences, error) {
	f.gotID = userID
	return f.doc, f.err
}

func (f *fakePrefsStore) PatchUserPreferences(ctx context.Context, userID string,
	in UserPreferencesPatch) (UserPreferences, error) {
	f.gotID = userID
	f.last = in
	return f.doc, f.err
}

func newPrefsTestServer(t *testing.T, store PreferencesStore, auth Authenticator) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, auth)
	RegisterPreferences(s, store)
	return s
}

func prefsRequest(t *testing.T, method, target string, header map[string]string, body string) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = request(method, target, header)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		for k, v := range header {
			r.Header.Set(k, v)
		}
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func TestPreferencesGet(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{doc: DefaultUserPreferences()}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodGet, "http://localhost:8080/api/v1/me/preferences", nil, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	layout := body["layout"].(map[string]any)
	if layout["projects_mode"] != "tree" || layout["ask_placement"] != "sidebar" ||
		layout["show_workflow_folders"] != true {
		t.Fatalf("layout = %v, want the defaults", layout)
	}
	if body["updated_at"] != nil {
		t.Fatalf("updated_at = %v, want null for a never-saved user", body["updated_at"])
	}
	// ADR-0080: the speech switches are part of the defaults a never-saved
	// user sees — auto-send off, browser fallback on.
	asst := body["assistant"].(map[string]any)
	if asst["trust_level"] != "ask_risky" {
		t.Fatalf("trust_level = %v, want the default ask_risky", asst["trust_level"])
	}
	if asst["speech_auto_send"] != false {
		t.Fatalf("speech_auto_send = %v, want the default false", asst["speech_auto_send"])
	}
	if asst["speech_browser_fallback"] != true {
		t.Fatalf("speech_browser_fallback = %v, want the default true", asst["speech_browser_fallback"])
	}
	if store.gotID != oks.UserID {
		t.Fatalf("store got user %q, want the caller's own id %q", store.gotID, oks.UserID)
	}
}

func TestPreferencesGetUnauthenticated(t *testing.T) {
	t.Parallel()
	srv := newPrefsTestServer(t, &fakePrefsStore{}, principalAuth(nil, ErrUnauthenticated))
	rec := do(t, srv, prefsRequest(t, http.MethodGet, "http://localhost:8080/api/v1/me/preferences", nil, ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Status != http.StatusUnauthorized {
		t.Fatalf("problem = %+v", p)
	}
}

func TestPreferencesPatchMergesAndReturnsFullDocument(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	doc := DefaultUserPreferences()
	savedAt := time.Now().UTC()
	doc.UpdatedAt = &savedAt
	store := &fakePrefsStore{doc: doc}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken},
		`{"layout":{"projects_mode":"switcher"},"assistant":{"trust_level":"no_ask"}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["updated_at"] == nil {
		t.Fatal("updated_at is null, want a timestamp after the first save")
	}
	// The patch arrived with only the supplied members; the untouched
	// members and sections decoded as nil.
	if store.last.Layout == nil || *store.last.Layout.ProjectsMode != "switcher" ||
		store.last.Layout.AskPlacement != nil || store.last.Assistant == nil ||
		*store.last.Assistant.TrustLevel != "no_ask" {
		t.Fatalf("store got patch %+v, want only the supplied members", store.last)
	}
}

// ADR-0080's two speech switches travel through the same surface as the trust
// level: they decode, they reach the store, and a non-boolean is the decoder's
// 400 rather than a stored value.
func TestPreferencesPatchSpeechSwitches(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	doc := DefaultUserPreferences()
	doc.Assistant.SpeechAutoSend = true
	doc.Assistant.SpeechBrowserFallback = false
	store := &fakePrefsStore{doc: doc}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken},
		`{"assistant":{"speech_auto_send":true,"speech_browser_fallback":false}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	asst := store.last.Assistant
	if asst == nil || asst.SpeechAutoSend == nil || !*asst.SpeechAutoSend ||
		asst.SpeechBrowserFallback == nil || *asst.SpeechBrowserFallback {
		t.Fatalf("store got patch %+v, want both switches with the sent values", store.last)
	}
	if asst.TrustLevel != nil {
		t.Fatalf("trust_level = %v, want an untouched field", *asst.TrustLevel)
	}
	body := decodeBody(t, rec)
	out := body["assistant"].(map[string]any)
	if out["speech_auto_send"] != true || out["speech_browser_fallback"] != false {
		t.Fatalf("answer assistant = %v, want the saved switches", out)
	}

	for name, patchBody := range map[string]string{
		"not a bool":     `{"assistant":{"speech_auto_send":"yes"}}`,
		"unknown switch": `{"assistant":{"speech_always_loud":true}}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := do(t, srv, prefsRequest(t, http.MethodPatch,
				"http://localhost:8080/api/v1/me/preferences",
				map[string]string{HeaderCSRFToken: oks.CSRFToken}, patchBody))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
			}
		})
	}
}

func TestPreferencesPatchUnknownKeyIs400(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	for name, body := range map[string]string{
		"unknown top-level key":    `{"theme":"dark"}`,
		"unknown layout member":    `{"layout":{"projects_mode":"tree","theme":"dark"}}`,
		"unknown assistant member": `{"assistant":{"trust_level":"no_ask","theme":"dark"}}`,
		"wrong expanded type":      `{"layout":{"expanded":{"p-1":"yes"}}}`,
		"not json":                 `nope`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := do(t, srv, prefsRequest(t, http.MethodPatch,
				"http://localhost:8080/api/v1/me/preferences",
				map[string]string{HeaderCSRFToken: oks.CSRFToken}, body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
			}
			if ct := rec.Header().Get("Content-Type"); ct != ProblemJSON {
				t.Fatalf("content-type = %q, want %s", ct, ProblemJSON)
			}
			var extra struct {
				Problem
				Code string `json:"code"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &extra); err != nil {
				t.Fatalf("decode problem: %v", err)
			}
			if extra.Code != "invalid_preferences" {
				t.Fatalf("code = %q, want invalid_preferences", extra.Code)
			}
		})
	}
}

func TestPreferencesPatchValidationErrorNamesField(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{
		err: &UserPrefsValidationError{
			Field:  "assistant.trust_level",
			Detail: `must be one of "ask_all", "ask_risky" or "no_ask"`,
		},
	}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken},
		`{"assistant":{"trust_level":"yolo"}}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
	}
	var extra struct {
		Problem
		Code  string `json:"code"`
		Field string `json:"field"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &extra); err != nil {
		t.Fatalf("decode problem: %v", err)
	}
	if extra.Code != "invalid_preferences" || extra.Field != "assistant.trust_level" {
		t.Fatalf("problem = %+v, want code invalid_preferences and the field path", extra)
	}
}

func TestPreferencesPatchRequiresCSRF(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{doc: DefaultUserPreferences()}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences", nil,
		`{"layout":{"projects_mode":"switcher"}}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Title != "CSRF Token Invalid" {
		t.Fatalf("problem = %+v, want the CSRF refusal", p)
	}
	if store.last != (UserPreferencesPatch{}) {
		t.Fatalf("store got patch %+v, want none — CSRF runs before the handler", store.last)
	}
}

func TestPreferencesStoreErrorIs500(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{err: errStoreDown}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodGet, "http://localhost:8080/api/v1/me/preferences", nil, ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body)
	}
	rec = do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken}, `{}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body)
	}
}

// empty body round-trip: an empty {} patch is a valid subset (no member
// changed) and still answers 200 with the full document.
func TestPreferencesPatchEmptyBodyIsValid(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{doc: DefaultUserPreferences()}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken}, `{}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
}

// An explicit null under `expanded` is the documented delete: it decodes
// (unlike a wrong type) and reaches the store as a nil value. The store owns
// the deletion itself (TestUserPrefsExpandedNullDeletesKey).
func TestPreferencesPatchExpandedNullIsTheDelete(t *testing.T) {
	t.Parallel()
	oks := testPrincipal()
	store := &fakePrefsStore{doc: DefaultUserPreferences()}
	srv := newPrefsTestServer(t, store, principalAuth(oks, nil))
	rec := do(t, srv, prefsRequest(t, http.MethodPatch,
		"http://localhost:8080/api/v1/me/preferences",
		map[string]string{HeaderCSRFToken: oks.CSRFToken},
		`{"layout":{"expanded":{"p-1":null,"p-2":true}}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if store.last.Layout == nil || store.last.Layout.Expanded == nil {
		t.Fatalf("store got patch %+v, want the expanded map", store.last)
	}
	v, sent := store.last.Layout.Expanded["p-1"]
	if !sent || v != nil {
		t.Fatalf("expanded[p-1] = %v, %t, want a present key with a nil value (the delete)", v, sent)
	}
	if p2 := store.last.Layout.Expanded["p-2"]; p2 == nil || *p2 != true {
		t.Fatalf("expanded[p-2] = %v, want the explicit true", store.last.Layout.Expanded["p-2"])
	}
}
