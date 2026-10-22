package api

// ADR-0049 part 1: the step-registry HTTP surface. The database behind
// these is fake and answers with the store's own errors, so this file pins
// the wire: statuses, problem bodies, CSRF, the write gate (403 for a
// non-admin), and that the store is never reached for a body the handler
// can refuse. The real-Postgres semantics are
// internal/store/postgres/node_templates_test.go.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const ntURL = "http://localhost:8080/api/v1/node-templates"

// ntTTemplate is a canonical uuid-shaped template id for the usage routes.
const ntTTemplate = "01987a71-3333-7000-8000-abcdef012345"

type ntFakeStore struct {
	list     []NodeTemplateView
	detail   NodeTemplateDetailView
	created  NodeTemplateView
	revision NodeTemplateRevisionCreateResponse
	duped    NodeTemplateView
	err      error
	calls    []string
	lastIn   NodeTemplateCreateInput
	lastRev  NodeTemplateRevisionInput
	// from-node read (ADR-0049 § 6): scripted answer for NodeFromDraft.
	nodeKind   string
	nodeConfig json.RawMessage
	nodeErr    error
}

func (f *ntFakeStore) ListTemplates(context.Context, Caller) ([]NodeTemplateView, error) {
	f.calls = append(f.calls, "list")
	return f.list, f.err
}
func (f *ntFakeStore) GetTemplate(_ context.Context, _ Caller, id string) (NodeTemplateDetailView, error) {
	f.calls = append(f.calls, "get:"+id)
	if f.err != nil {
		return NodeTemplateDetailView{}, f.err
	}
	return f.detail, nil
}
func (f *ntFakeStore) CreateTemplate(_ context.Context, _ Caller, in NodeTemplateCreateInput) (NodeTemplateView, error) {
	f.calls = append(f.calls, "create")
	if f.err != nil {
		return NodeTemplateView{}, f.err
	}
	f.lastIn = in
	return f.created, nil
}
func (f *ntFakeStore) CreateTemplateRevision(_ context.Context, _ Caller, _ string, in NodeTemplateRevisionInput) (NodeTemplateRevisionCreateResponse, error) {
	f.calls = append(f.calls, "revision")
	if f.err != nil {
		return NodeTemplateRevisionCreateResponse{}, f.err
	}
	f.lastRev = in
	return f.revision, nil
}
func (f *ntFakeStore) DuplicateTemplate(_ context.Context, _ Caller, id, _, _ string) (NodeTemplateView, error) {
	f.calls = append(f.calls, "dup:"+id)
	if f.err != nil {
		return NodeTemplateView{}, f.err
	}
	return f.duped, nil
}
func (f *ntFakeStore) RecordDenied(context.Context, Caller, string, string) error {
	f.calls = append(f.calls, "denied")
	return nil
}
func (f *ntFakeStore) Usage(_ context.Context, _ Caller, templateID string) (NodeTemplateUsage, error) {
	f.calls = append(f.calls, "usage:"+templateID)
	if f.err != nil {
		return NodeTemplateUsage{}, f.err
	}
	return NodeTemplateUsage{}, nil
}
func (f *ntFakeStore) NodeFromDraft(_ context.Context, _ Caller, draftID, nodeID string) (string, json.RawMessage, error) {
	f.calls = append(f.calls, "node-from-draft:"+draftID+":"+nodeID)
	return f.nodeKind, f.nodeConfig, f.nodeErr
}

func ntMount(t *testing.T, store *ntFakeStore, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3}, auth, nil)
	RegisterNodeTemplates(s, store)
	return s
}

func ntCaller(isAdmin bool) Authenticator {
	return principalAuth(&Principal{UserID: "u-nt", OrganizationID: "o-1",
		DisplayName: "U", CSRFToken: "csrf-token-value", IsOrgAdmin: isAdmin}, nil)
}

func ntSend(t *testing.T, s *Server, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

func ntNow() time.Time { return time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC) }

func TestNodeTemplateListAndGet(t *testing.T) {
	// list: any org member, next_cursor null, templates array honest.
	store := &ntFakeStore{list: []NodeTemplateView{{
		ID: "t-1", Slug: "a", DisplayName: "A", Kind: "agent.acp", Status: "active",
		LatestRevision: NodeTemplateRevisionSummary{RevisionID: "r-1", RevisionNumber: 1,
			VersionLabel: "1.0.0", RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedAt: ntNow()},
		CreatedAt: ntNow(), UpdatedAt: ntNow(),
	}}}
	s := ntMount(t, store, ntCaller(false))
	rec := ntSend(t, s, http.MethodGet, ntURL, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body)
	}
	var list NodeTemplateListView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if list.NextCursor != nil {
		t.Errorf("next_cursor = %v, want null", *list.NextCursor)
	}
	if len(list.Templates) != 1 || list.Templates[0].UsedInCount != 0 {
		t.Errorf("templates = %+v", list.Templates)
	}

	// get: the detail shape.
	store.detail = NodeTemplateDetailView{
		Template: store.list[0],
		Revisions: []NodeTemplateRevisionView{{RevisionID: "r-1", RevisionNumber: 1,
			VersionLabel: "1.0.0", Parameters: json.RawMessage(`{}`), Config: json.RawMessage(`{}`),
			OutputSchema: json.RawMessage(`{}`), WorkspaceMode: "run_workspace",
			RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedBy: "u-nt", CreatedAt: ntNow()}},
		Usages: []TemplateUsage{},
	}
	rec = ntSend(t, s, http.MethodGet, ntURL+"/t-1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /{id} = %d (%s)", rec.Code, rec.Body)
	}
	var detail NodeTemplateDetailView
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail.Template.ID != "t-1" || len(detail.Revisions) != 1 || len(detail.Usages) != 0 {
		t.Errorf("detail = %+v", detail)
	}
}

func TestNodeTemplateCreate(t *testing.T) {
	body := `{"slug":"security-reviewer","display_name":"Security reviewer","kind":"agent.acp",
		"parameters":{"type":"object","properties":{"focus":{"type":"string"}}},
		"config":{"prompt":"review ${{ params.focus }}"}}`

	// non-admin: 403 before the store is reached (the § 7 gate).
	store := &ntFakeStore{}
	s := ntMount(t, store, ntCaller(false))
	rec := ntSend(t, s, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin POST = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.calls) != 0 {
		t.Errorf("store calls for a 403 = %v, want none", store.calls)
	}

	// admin: 201 with defaults applied (1.0.0, run_workspace, {}).
	store = &ntFakeStore{created: NodeTemplateView{
		ID: "t-1", Slug: "security-reviewer", DisplayName: "Security reviewer",
		Kind: "agent.acp", Status: "active",
		LatestRevision: NodeTemplateRevisionSummary{RevisionID: "r-1", RevisionNumber: 1,
			VersionLabel: "1.0.0", RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedAt: ntNow()},
		CreatedBy: "u-nt", CreatedAt: ntNow(), UpdatedAt: ntNow(),
	}}
	s = ntMount(t, store, ntCaller(true))
	rec = ntSend(t, s, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("admin POST = %d (%s)", rec.Code, rec.Body)
	}
	if store.lastIn.VersionLabel != "1.0.0" || store.lastIn.WorkspaceMode != "run_workspace" ||
		string(store.lastIn.OutputSchema) != "{}" {
		t.Errorf("defaults not applied: %+v", store.lastIn)
	}

	// 400s: the store must never be reached for a refused body.
	bad := map[string]string{
		"slug":         `{"slug":"Bad Slug","display_name":"x","kind":"agent.acp","parameters":{},"config":{}}`,
		"kind":         `{"slug":"ok","display_name":"x","kind":"not.a.kind","parameters":{},"config":{}}`,
		"params":       `{"slug":"ok","display_name":"x","kind":"agent.acp","parameters":[1],"config":{}}`,
		"config":       `{"slug":"ok","display_name":"x","kind":"agent.acp","parameters":{},"config":[1]}`,
		"workspace":    `{"slug":"ok","display_name":"x","kind":"agent.acp","parameters":{},"config":{},"workspace_mode":"both"}`,
		"version":      `{"slug":"ok","display_name":"x","kind":"agent.acp","parameters":{},"config":{},"version_label":"1.0"}`,
		"display_name": `{"slug":"ok","display_name":"","kind":"agent.acp","parameters":{},"config":{}}`,
	}
	before := len(store.calls)
	for name, b := range bad {
		rec := ntSend(t, s, http.MethodPost, ntURL, b)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: POST = %d, want 400 (%s)", name, rec.Code, rec.Body)
		}
		if len(store.calls) > before {
			t.Errorf("%s: store reached: %v", name, store.calls)
		}
		before = len(store.calls)
	}
	if got := len(store.calls); got != 1 {
		t.Errorf("store calls after the 400s = %d, want the one successful create", got)
	}

	// 409 slug clash surfaces as a conflict.
	store.err = ErrNodeTemplateConflict
	rec = ntSend(t, s, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusConflict {
		t.Errorf("conflict POST = %d, want 409 (%s)", rec.Code, rec.Body)
	}

	// 404 is the store's invisible-resource sentinel.
	store.err = ErrNodeTemplateNotFound
	rec = ntSend(t, s, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusNotFound {
		t.Errorf("not-found POST = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

func TestNodeTemplateRevisionAndDuplicate(t *testing.T) {
	revBody := `{"parameters":{"type":"object"},"config":{"prompt":"v2"},
		"version_label":"1.1.0","adopt_using_workflows":true}`

	// revision: non-admin 403, admin 201 with the response envelope.
	store := &ntFakeStore{}
	s := ntMount(t, store, ntCaller(false))
	rec := ntSend(t, s, http.MethodPost, ntURL+"/t-1/revisions", revBody)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin revision = %d, want 403", rec.Code)
	}

	store = &ntFakeStore{revision: NodeTemplateRevisionCreateResponse{
		Revision: NodeTemplateRevisionView{RevisionID: "r-2", RevisionNumber: 2,
			VersionLabel: "1.1.0", Parameters: json.RawMessage(`{}`), Config: json.RawMessage(`{}`),
			OutputSchema: json.RawMessage(`{}`), WorkspaceMode: "run_workspace",
			RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedAt: ntNow()},
		Adopted: []TemplateAdoption{},
		Skipped: []TemplateAdoptionSkipped{},
	}}
	s = ntMount(t, store, ntCaller(true))
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-1/revisions", revBody)
	if rec.Code != http.StatusCreated {
		t.Fatalf("revision POST = %d (%s)", rec.Code, rec.Body)
	}
	var resp NodeTemplateRevisionCreateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Revision.RevisionID != "r-2" || resp.Adopted == nil || resp.Skipped == nil {
		t.Errorf("response = %+v, want revision + honest adopted/skipped arrays", resp)
	}
	if !store.lastRev.AdoptUsing {
		t.Error("adopt_using_workflows not forwarded to the store")
	}

	// a missing version_label is 400 (revisions require it; create defaults it).
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-1/revisions",
		`{"parameters":{},"config":{}}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing version_label = %d, want 400", rec.Code)
	}

	// duplicate: 201 with a content copy (store side), 403/404/409 on the wire.
	store = &ntFakeStore{duped: NodeTemplateView{ID: "t-2", Slug: "copy", DisplayName: "Copy",
		Kind: "agent.acp", Status: "active",
		LatestRevision: NodeTemplateRevisionSummary{RevisionID: "r-9", RevisionNumber: 1,
			VersionLabel: "1.1.0", RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedAt: ntNow()},
		CreatedAt: ntNow(), UpdatedAt: ntNow()}}
	s = ntMount(t, store, ntCaller(true))
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-1/duplicate", `{"slug":"copy","display_name":"Copy"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("duplicate POST = %d (%s)", rec.Code, rec.Body)
	}
	if store.calls[len(store.calls)-1] != "dup:t-1" {
		t.Errorf("store calls = %v", store.calls)
	}
	store.err = ErrNodeTemplateNotFound
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-missing/duplicate", `{"slug":"copy","display_name":"Copy"}`)
	if rec.Code != http.StatusNotFound {
		t.Errorf("foreign duplicate = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	store.err = ErrNodeTemplateConflict
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-1/duplicate", `{"slug":"copy","display_name":"Copy"}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("slug-clash duplicate = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	// malformed body before the gate even matters.
	rec = ntSend(t, s, http.MethodPost, ntURL+"/t-1/duplicate", `{"slug":"Up","display_name":"Copy"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad slug duplicate = %d, want 400", rec.Code)
	}
}

// TestNodeTemplateCreateFromNode is ADR-0049 § 6: the Studio's "also save as
// a reusable step" — kind and config come from the named node, and the
// parameterization starts empty.
func TestNodeTemplateCreateFromNode(t *testing.T) {
	body := `{"slug":"review-step","display_name":"Review step",
		"from_node":{"draft_id":"d-1","node_id":"review"}}`
	store := &ntFakeStore{
		nodeKind: "agent.acp", nodeConfig: json.RawMessage(`{"profile":"p","prompt":"x"}`),
		created: NodeTemplateView{
			ID: "t-1", Slug: "review-step", DisplayName: "Review Step",
			Kind: "agent.acp", Status: "active",
			LatestRevision: NodeTemplateRevisionSummary{RevisionID: "r-1", RevisionNumber: 1,
				VersionLabel: "1.0.0", RevisionDigest: "sha256:" + strings.Repeat("0", 64), CreatedAt: ntNow()},
			CreatedBy: "u-nt", CreatedAt: ntNow(), UpdatedAt: ntNow(),
		},
	}
	s := ntMount(t, store, ntCaller(true))
	rec := ntSend(t, s, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("from_node POST = %d (%s)", rec.Code, rec.Body)
	}
	if got := store.lastIn; got.Kind != "agent.acp" ||
		string(got.Config) != `{"profile":"p","prompt":"x"}` ||
		string(got.Parameters) != `{"type":"object","properties":{}}` ||
		string(got.OutputSchema) != `{"type":"object"}` {
		t.Errorf("from_node did not own the create input: %+v", got)
	}

	// missing members: 400 before the store.
	store2 := &ntFakeStore{}
	s2 := ntMount(t, store2, ntCaller(true))
	rec = ntSend(t, s2, http.MethodPost, ntURL,
		`{"slug":"review-step","display_name":"Review Step","from_node":{"draft_id":"d-1"}}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("from_node without node_id = %d, want 400 (%s)", rec.Code, rec.Body)
	}

	// the honest 400 for an unvalidated draft, and the 404 for an invisible
	// one — both before a template row could exist.
	store3 := &ntFakeStore{nodeErr: ErrNodeTemplateDraftNotValidated}
	s3 := ntMount(t, store3, ntCaller(true))
	rec = ntSend(t, s3, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unvalidated from_node = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	store4 := &ntFakeStore{nodeErr: ErrNodeTemplateNotFound}
	s4 := ntMount(t, store4, ntCaller(true))
	rec = ntSend(t, s4, http.MethodPost, ntURL, body)
	if rec.Code != http.StatusNotFound {
		t.Errorf("invisible from_node draft = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}
