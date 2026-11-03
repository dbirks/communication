package api

// Contract tests for the ADR-0067 amendment route — PATCH
// /api/v1/conversations/{conversationId}: the WORKS IN switcher's write. The
// handler's own job is the body shape (repository_id a uuid or null, the
// 422 invalid_repository_id for junk) and the status mapping; the database
// semantics (controller lock, project scoping of the id, the
// conversation.scope_changed journal row) are proven against a real
// PostgreSQL in internal/store/postgres/conversation_scope_test.go.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The fake store's repository ids (conversations_test.go's cnvNewFakeStore
// answers them off f.repoIDs).
const (
	cnvFakeRepoAcmeAPI = "01987a72-aaaa-7000-8000-abcdef000001"
	cnvFakeRepoZeta    = "01987a72-aaaa-7000-8000-abcdef000002"
)

func cnvPatchScope(t *testing.T, s *Server, userID, conversationID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch,
		"http://localhost:8080/api/v1/conversations/"+conversationID, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

// The controller moves the thread into one of the project's repositories:
// 200 with the moved binding echoed, and the body reaches the store verbatim.
func TestConversationScopeChangeByController(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))

	rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, map[string]string{"repository_id": cnvFakeRepoZeta})
	if rec.Code != http.StatusOK {
		t.Fatalf("scope change by the controller = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view ConversationView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode conversation: %v", err)
	}
	if view.RepositoryID == nil || *view.RepositoryID != cnvFakeRepoZeta {
		t.Errorf("view repository_id = %v, want the zeta repository id", view.RepositoryID)
	}
	if len(store.scoped) != 1 || store.scoped[0].conversationID != cnvTConv || store.scoped[0].repositoryID != cnvFakeRepoZeta {
		t.Errorf("store saw %+v, want one scope change of %s to %s", store.scoped, cnvTConv, cnvFakeRepoZeta)
	}
}

// null — and an absent field, the same JSON fact — is the whole project:
// the binding goes null, and the store is told with "" as the create route
// tells it "no repository".
func TestConversationScopeChangeToWholeProject(t *testing.T) {
	for name, body := range map[string]any{
		"null":   map[string]any{"repository_id": nil},
		"absent": map[string]any{},
	} {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))

		rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d, want 200 (%s)", name, rec.Code, rec.Body)
		}
		var view ConversationView
		if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
			t.Fatalf("%s: decode conversation: %v", name, err)
		}
		if view.RepositoryID != nil {
			t.Errorf("%s: view repository_id = %v, want null", name, view.RepositoryID)
		}
		if len(store.scoped) != 1 || store.scoped[0].repositoryID != "" {
			t.Errorf("%s: store saw %+v, want one scope change to the whole project (\"\")", name, store.scoped)
		}
	}
}

// A well-formed uuid that is not one of the project's repositories is the
// store's 422 — answered identically for every foreign id so a probe leaks
// nothing about who else has it.
func TestConversationScopeChangeForeignRepository422(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	foreign := "01987a72-9999-7000-8000-abcdef000003"
	rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, map[string]string{"repository_id": foreign})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("foreign repository = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "repository_not_in_project") {
		t.Errorf("422 body = %s, want the repository_not_in_project code", rec.Body)
	}
	if len(store.scoped) != 0 {
		t.Errorf("a foreign repository reached the store write: %+v", store.scoped)
	}
}

// The body's malformed shapes are refused before any store call — the same
// 422 the create route's `repository` field answers, naming the field.
func TestConversationScopeChangeMalformedBody(t *testing.T) {
	for _, body := range []any{
		map[string]string{"repository_id": "not-a-uuid"},
		map[string]string{"repository_id": ""},
	} {
		store := cnvNewFakeStore()
		s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
		rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("body %v = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), "invalid_repository_id") {
			t.Errorf("body %v: %s, want the invalid_repository_id code", body, rec.Body)
		}
		if len(store.scoped) != 0 {
			t.Errorf("a malformed body reached the store: %+v", store.scoped)
		}
	}
}

// Same authorization as sending a turn: the one driving who moves.
func TestConversationScopeChangeNonController409(t *testing.T) {
	store := cnvNewFakeStore()
	store.controller = cnvTUserA // the caller below is UserB; Alice holds the wheel
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	rec := cnvPatchScope(t, s, cnvTUserB, cnvTConv, map[string]string{"repository_id": cnvFakeRepoZeta})
	if rec.Code != http.StatusConflict {
		t.Fatalf("non-controller scope change = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "Alice holds the controller lock") {
		t.Errorf("409 body = %s, want it to name the controller", rec.Body)
	}
	if len(store.scoped) != 0 {
		t.Errorf("a non-controller reached the store write: %+v", store.scoped)
	}
}

func TestConversationScopeChangeViewerRole403(t *testing.T) {
	store := cnvNewFakeStore()
	store.myRole = "viewer"
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, map[string]string{"repository_id": cnvFakeRepoZeta})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer scope change = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

// A non-member gets the conversation's 404 — and the audit row the surface
// records before the 404 goes out (ADR-0014 §3).
func TestConversationScopeChangeNonMember404(t *testing.T) {
	store := cnvNewFakeStore()
	store.authFails = true
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPatchScope(t, s, cnvTUserA, cnvTConv, map[string]string{"repository_id": cnvFakeRepoZeta})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-member scope change = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if len(store.denied) == 0 || store.denied[0].subject != cnvTConv {
		t.Errorf("denied = %+v, want an audit row for the conversation", store.denied)
	}
}
