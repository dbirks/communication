package api

// ADR-0030: who may write an agent profile, and what a refusal must name. The
// database behind these is fake and answers with the store's own errors, so what
// this file pins is the HTTP surface: status, problem code, CSRF, and that the
// store is never reached for a request the handler can refuse. The real-Postgres
// semantics are internal/store/postgres/m4_agent_profiles_write_test.go.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const profURL = "http://localhost:8080/api/v1/agent-profiles"

// profAdminCaller is the organization's library role (api/pipelines.go's
// requireLibraryRole reads the same flag).
func profAdminCaller(userID string) Authenticator {
	return principalAuth(&Principal{UserID: userID, OrganizationID: "o-1",
		DisplayName: userID, CSRFToken: "csrf-token-value", IsOrgAdmin: true}, nil)
}

func profSend(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(method, target, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

// profDecodeProblemCode reads the 422 document the way a client does: the code
// member, not the prose.
func profDecodeProblemCode(t *testing.T, rec *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var out struct {
		Code   string `json:"code"`
		Type   string `json:"type"`
		Detail string `json:"detail"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode problem: %v (%s)", err, rec.Body)
	}
	if out.Status != rec.Code {
		t.Errorf("problem.status = %d, response = %d", out.Status, rec.Code)
	}
	return out.Code, out.Type
}

func TestCreateAgentProfileAsLibraryRole(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))

	rec := profSend(t, s, http.MethodPost, profURL, map[string]string{
		"name": "Claude Reviewed", "launcher_id": "claude",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /agent-profiles = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var view AgentProfileView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if view.Name != "Claude Reviewed" || view.LauncherID != "claude" {
		t.Errorf("view = %+v, want the submitted name and launcher", view)
	}
	if view.PermissionMode != "ask" {
		t.Errorf("permission_mode = %q, want ask: the route cannot grant auto-approval (ADR-0009)", view.PermissionMode)
	}
	// A new profile stages nothing: the APM triple is NULL, exposed as null, and
	// a client must be able to tell that from a field it never read.
	if view.APMPackageRef != nil || view.APMTarget != nil || view.APMLockDigest != nil {
		t.Errorf("new profile carries an APM pin: %s", rec.Body)
	}
	if len(store.profileCreated) != 1 {
		t.Fatalf("store saw %d creates, want 1", len(store.profileCreated))
	}
}

func TestCreateAgentProfileNeedsLibraryRole(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA)) // signed in, not an org admin

	rec := profSend(t, s, http.MethodPost, profURL, map[string]string{
		"name": "Anyone", "launcher_id": "claude",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST as a plain member = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.profileCreated) != 0 {
		t.Errorf("store saw %d creates; the role check must happen before the write", len(store.profileCreated))
	}
	// ADR-0014 §3: a refused attempt leaves an audit row, org-scoped (no project).
	if len(store.denied) != 1 || store.denied[0].action != "profile.create" || store.denied[0].subject != "" {
		t.Errorf("denials = %+v, want one project-less profile.create row", store.denied)
	}
}

func TestCreateAgentProfileValidation(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantCode string
	}{
		{"blank name", `{"name":"  ","launcher_id":"claude"}`, ProfileCodeNameInvalid},
		{"launcher with a path", `{"name":"x","launcher_id":"claude; rm -rf /"}`, ProfileCodeLauncherBad},
		{"launcher uppercase", `{"name":"x","launcher_id":"Claude"}`, ProfileCodeLauncherBad},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := cnvNewFakeStore()
			s := cnvMount(t, store, nil, profAdminCaller("admin"))
			req := httptest.NewRequest(http.MethodPost, profURL, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://localhost:8080")
			req.Header.Set(HeaderCSRFToken, "csrf-token-value")
			rec := do(t, s, req)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("POST %s = %d, want 422 (%s)", tc.body, rec.Code, rec.Body)
			}
			if code, _ := profDecodeProblemCode(t, rec); code != tc.wantCode {
				t.Errorf("code = %q, want %q", code, tc.wantCode)
			}
			if len(store.profileCreated) != 0 {
				t.Errorf("invalid body reached the store: %+v", store.profileCreated)
			}
		})
	}
}

func TestCreateAgentProfileWithoutCSRF(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	req := httptest.NewRequest(http.MethodPost, profURL, strings.NewReader(`{"name":"x","launcher_id":"claude"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := do(t, s, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST without the CSRF pair = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.profileCreated) != 0 {
		t.Error("store reached before the CSRF gate")
	}
}

func TestPatchAgentProfileAPMTriple(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))

	rec := profSend(t, s, http.MethodPatch, profURL+"/"+cnvTProfile, map[string]string{
		"apm_package_ref": "mattpocock/skills#v1.3.1",
		"apm_target":      "claude",
		"apm_lock_digest": "sha256:" + strings.Repeat("a", 64),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if len(store.profilePatched) != 1 || store.profilePatched[0].profileID != cnvTProfile {
		t.Fatalf("store calls = %+v", store.profilePatched)
	}
	call := store.profilePatched[0]
	if call.packageRef == nil || *call.packageRef != "mattpocock/skills#v1.3.1" {
		t.Errorf("package ref forwarded = %v", call.packageRef)
	}
	if call.target == nil || *call.target != "claude" {
		t.Errorf("target forwarded = %v", call.target)
	}

	// The list view must show the pin, or the write is invisible to the client
	// that made it.
	list := do(t, s, request(http.MethodGet, profURL, nil))
	if list.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", list.Code, list.Body)
	}
	var out struct {
		Items []AgentProfileView `json:"items"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list: %v (%s)", err, list.Body)
	}
	for _, item := range out.Items {
		if item.ID != cnvTProfile {
			continue
		}
		if item.APMPackageRef == nil || *item.APMPackageRef != "mattpocock/skills#v1.3.1" {
			t.Fatalf("list item apm_package_ref = %v, want the pinned ref", item.APMPackageRef)
		}
		if item.APMTarget == nil || *item.APMTarget != "claude" {
			t.Errorf("list item apm_target = %v", item.APMTarget)
		}
		if item.APMLockDigest == nil || !cnvFakeDigestPattern.MatchString(*item.APMLockDigest) {
			t.Errorf("list item apm_lock_digest = %v", item.APMLockDigest)
		}
		return
	}
	t.Fatalf("pinned profile %s missing from %s", cnvTProfile, list.Body)
}

func TestPatchAgentProfileUnlockedPinIsAccepted(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))

	// An unlocked pin — ref + target, no digest — is the legal shape the lock
	// flow exists to serve (ADR-0054 amendment 2): the digest is the operator's to
	// record through Lock it.
	rec := profSend(t, s, http.MethodPatch, profURL+"/"+cnvTProfile, map[string]string{
		"apm_package_ref": "mattpocock/skills#v1.3.1",
		"apm_target":      "claude",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("unlocked PATCH = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view AgentProfileView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.APMPackageRef == nil || *view.APMPackageRef != "mattpocock/skills#v1.3.1" {
		t.Errorf("unlocked view apm_package_ref = %v, want the ref", view.APMPackageRef)
	}
	if view.APMTarget == nil || *view.APMTarget != "claude" {
		t.Errorf("unlocked view apm_target = %v, want claude", view.APMTarget)
	}
	if view.APMLockDigest != nil {
		t.Errorf("unlocked view apm_lock_digest = %v, want null", view.APMLockDigest)
	}
	if view.APMContents != nil {
		t.Errorf("unlocked view apm_contents = %+v, want null", view.APMContents)
	}
}

func TestPatchAgentProfilePartialTripleIsRefused(t *testing.T) {
	// Every partial shape: the whole point of the rule is that no subset of one
	// column without its partner can be written. An UNLOCKED pin is the legal
	// ref + target pair (the digest is optional, ADR-0054 amendment 2), so the
	// partials are the singles and the digest-only shapes.
	for _, body := range []string{
		`{"apm_package_ref":"mattpocock/skills#v1.3.1"}`,
		`{"apm_target":"claude","apm_lock_digest":"sha256:` + strings.Repeat("b", 64) + `"}`,
		`{"apm_lock_digest":"sha256:` + strings.Repeat("b", 64) + `"}`,
	} {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, profAdminCaller("admin"))
		req := httptest.NewRequest(http.MethodPatch, profURL+"/"+cnvTProfile, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://localhost:8080")
		req.Header.Set(HeaderCSRFToken, "csrf-token-value")
		rec := do(t, s, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("PATCH %s = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		if code, typ := profDecodeProblemCode(t, rec); code != ProfileCodeAPMIncomplete ||
			!strings.HasSuffix(typ, "/"+ProfileCodeAPMIncomplete) {
			t.Errorf("code/type = %q/%q, want %q", code, typ, ProfileCodeAPMIncomplete)
		}
		if len(store.profilePatched) != 0 {
			t.Errorf("partial triple reached the store: %+v", store.profilePatched)
		}
	}
}

func TestPatchAgentProfileClearingTheTripleIsAllowed(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))

	for _, body := range []string{`{}`, `{"apm_package_ref":"","apm_target":"","apm_lock_digest":""}`} {
		rec := profSend(t, s, http.MethodPatch, profURL+"/"+cnvTProfile, json.RawMessage(body))
		if rec.Code != http.StatusOK {
			t.Fatalf("PATCH %s = %d, want 200 — clearing all three is legal (%s)", body, rec.Code, rec.Body)
		}
		var view AgentProfileView
		if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if view.APMPackageRef != nil || view.APMTarget != nil || view.APMLockDigest != nil {
			t.Errorf("cleared profile still carries a pin: %s", rec.Body)
		}
	}
}

func TestPatchAgentProfileBadDigestIsNotAFiveHundred(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := profSend(t, s, http.MethodPatch, profURL+"/"+cnvTProfile, map[string]string{
		"apm_package_ref": "mattpocock/skills#v1.3.1",
		"apm_target":      "claude",
		"apm_lock_digest": "sha256:not-hex",
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad digest = %d, want 422, not a CHECK-violation 500 (%s)", rec.Code, rec.Body)
	}
	if code, _ := profDecodeProblemCode(t, rec); code != "apm_lock_digest_invalid" {
		t.Errorf("code = %q", code)
	}
}

func TestPatchAgentProfileRolesAndMissingTargets(t *testing.T) {
	t.Run("member without the library role", func(t *testing.T) {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
		rec := profSend(t, s, http.MethodPatch, profURL+"/"+cnvTProfile, map[string]string{
			"apm_package_ref": "mattpocock/skills#v1.3.1",
			"apm_target":      "claude",
			"apm_lock_digest": "sha256:" + strings.Repeat("c", 64),
		})
		// Profiles are organization-visible, so this is 403 (role), not 404:
		// ADR-0014 §3 reserves 404 for a resource the caller may not learn of.
		if rec.Code != http.StatusForbidden {
			t.Fatalf("PATCH as a member = %d, want 403 (%s)", rec.Code, rec.Body)
		}
		if len(store.denied) != 1 || store.denied[0].action != "profile.update" {
			t.Errorf("denials = %+v, want one profile.update row", store.denied)
		}
	})
	t.Run("unknown profile", func(t *testing.T) {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, profAdminCaller("admin"))
		rec := profSend(t, s, http.MethodPatch, profURL+"/01987a99-9999-7000-8000-abcdef012345",
			map[string]string{
				"apm_package_ref": "mattpocock/skills#v1.3.1",
				"apm_target":      "claude",
				"apm_lock_digest": "sha256:" + strings.Repeat("c", 64),
			})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("PATCH unknown id = %d, want 404 (%s)", rec.Code, rec.Body)
		}
	})
	t.Run("malformed profile id", func(t *testing.T) {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, profAdminCaller("admin"))
		rec := profSend(t, s, http.MethodPatch, profURL+"/not-a-uuid", map[string]string{
			"apm_package_ref": "mattpocock/skills#v1.3.1",
			"apm_target":      "claude",
			"apm_lock_digest": "sha256:" + strings.Repeat("c", 64),
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("PATCH malformed id = %d, want 404 (%s)", rec.Code, rec.Body)
		}
	})
}

// --- ADR-0058: the version-history reads and the restore write -----------

// TestListAgentProfileVersions answers the version history the app-shell's
// version panel renders: one profile's versions, oldest first, in the
// {items:[...]} envelope. The fake answers from the profile's current version,
// so the seeded profile's history is its single version-1 row.
func TestListAgentProfileVersions(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := do(t, s, request(http.MethodGet, profURL+"/"+cnvTProfile+"/versions", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET versions = %d (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Items []AgentProfileVersion `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list: %v (%s)", err, rec.Body)
	}
	if len(out.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(out.Items))
	}
	if out.Items[0].ProfileID != cnvTProfile || out.Items[0].Version != 1 {
		t.Errorf("item = %+v, want version 1 of %s", out.Items[0], cnvTProfile)
	}
}

// TestGetAgentProfileVersion answers one frozen version of one profile, and
// refuses the versions that were never written (ADR-0058: a version is a key
// into the append-only history, not a mutable row).
func TestGetAgentProfileVersion(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))

	rec := do(t, s, request(http.MethodGet, profURL+"/"+cnvTProfile+"/versions/1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET version 1 = %d (%s)", rec.Code, rec.Body)
	}
	var v AgentProfileVersion
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode version: %v (%s)", err, rec.Body)
	}
	if v.ProfileID != cnvTProfile || v.Version != 1 {
		t.Errorf("version = %+v, want version 1 of %s", v, cnvTProfile)
	}
	// A version the profile never carried answers 404, not an empty success.
	rec = do(t, s, request(http.MethodGet, profURL+"/"+cnvTProfile+"/versions/2", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET version 2 = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	// A version number below 1 is refused the same way — never an answer.
	rec = do(t, s, request(http.MethodGet, profURL+"/"+cnvTProfile+"/versions/0", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET version 0 = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// TestRestoreAgentProfileVersion is the "Save as v4" write: restoring version n
// is a new write whose snapshot equals version n's, so the handler answers 200
// with the new version the store landed.
func TestRestoreAgentProfileVersion(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := profSend(t, s, http.MethodPost, profURL+"/"+cnvTProfile+"/versions/1/restore", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST restore = %d (%s)", rec.Code, rec.Body)
	}
	if len(store.restoredVersions) != 1 || store.restoredVersions[0].profileID != cnvTProfile || store.restoredVersions[0].version != 1 {
		t.Fatalf("restores = %+v, want the version-1 restore", store.restoredVersions)
	}
}

// TestRestoreAgentProfileVersionStaleIs409 proves the restore carries the
// optimistic-concurrency token: a stale version refuses with 409 and lands
// nothing (ADR-0058), so the client re-reads the history instead of retrying blind.
func TestRestoreAgentProfileVersionStaleIs409(t *testing.T) {
	store := cnvNewFakeStore()
	store.versionConflict = true
	s := cnvMount(t, store, nil, profAdminCaller("admin"))
	rec := profSend(t, s, http.MethodPost, profURL+"/"+cnvTProfile+"/versions/1/restore", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale restore = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}
