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

func TestPatchAgentProfilePartialTripleIsRefused(t *testing.T) {
	// Every partial shape: the whole point of the rule is that no subset of two
	// columns can be written, because a ref without a digest stages whatever the
	// upstream points at today (probe A5b) and the worker refuses it at launch.
	for _, body := range []string{
		`{"apm_package_ref":"mattpocock/skills#v1.3.1"}`,
		`{"apm_package_ref":"mattpocock/skills#v1.3.1","apm_target":"claude"}`,
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
