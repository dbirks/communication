package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
)

// The artifact handlers' contract, exercised without a database: status codes,
// the sensitivity role gates, the delivery headers, and what may never appear
// in a response body or a log line. The SQL half (visibility predicate,
// sensitivity filtering in the query, the audit row) is
// internal/store/postgres/artifacts_test.go; the preview origin's *browser*
// behaviour is docs/m3-contract.md case 16's Playwright leg.

const (
	artTestProject        = "11111111-1111-4111-8111-111111111111"
	artTestID             = "33333333-3333-4333-8333-333333333333"
	artTestDigest         = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	artTestKey            = artTestProject + "/json/e3/" + artTestDigest + ".json"
	artPreviewHost        = "preview.localhost:18084"
	artPreviewBase        = "http://preview.localhost:18084"
	artPublicOrigin       = "http://localhost:18080"
	artTestConversationID = "44444444-4444-4444-8444-444444444444"
)

type artFakeStore struct {
	views                map[string]ArtifactView
	lists                map[string][]ArtifactView
	denials              []artDenial
	accesses             []string
	err                  error
	listErr              error
	previewErr           error
	lastListConversation string
}

type artDenial struct {
	projectID, action string
}

func artNewFakeStore() *artFakeStore {
	return &artFakeStore{
		views: map[string]ArtifactView{},
		lists: map[string][]ArtifactView{},
	}
}

func (f *artFakeStore) put(v ArtifactView) {
	if v.ID == "" {
		v.ID = artTestID
	}
	if v.ProjectID == "" {
		v.ProjectID = artTestProject
	}
	f.views[v.ID] = v
	f.lists[v.ProjectID] = append(f.lists[v.ProjectID], v)
}

func (f *artFakeStore) ListArtifacts(ctx context.Context, c Caller, projectID string, conversationID string) ([]ArtifactView, error) {
	f.lastListConversation = conversationID
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.lists[projectID], nil
}

func (f *artFakeStore) GetArtifact(ctx context.Context, c Caller, artifactID string) (ArtifactView, error) {
	if f.err != nil {
		return ArtifactView{}, f.err
	}
	v, ok := f.views[artifactID]
	if !ok {
		return ArtifactView{}, ErrArtifactNotFound
	}
	return v, nil
}

func (f *artFakeStore) ArtifactForPreview(ctx context.Context, artifactID string) (ArtifactView, error) {
	if f.previewErr != nil {
		return ArtifactView{}, f.previewErr
	}
	v, ok := f.views[artifactID]
	if !ok || v.State != "ready" || !artifacts.Previewable(v.Kind, v.Sensitivity) {
		return ArtifactView{}, ErrArtifactNotFound
	}
	return v, nil
}

func (f *artFakeStore) RecordDenied(ctx context.Context, c Caller, projectID, action string) error {
	f.denials = append(f.denials, artDenial{projectID, action})
	return nil
}

// artFakeBytes is an ArtifactBytes over an in-memory map.
type artFakeBytes struct {
	objects map[string][]byte
	err     error
	opened  []string
}

func newArtFakeBytes() *artFakeBytes {
	return &artFakeBytes{objects: map[string][]byte{}}
}

func (b *artFakeBytes) Open(ctx context.Context, ref artifacts.Ref) (io.ReadCloser, int64, error) {
	b.opened = append(b.opened, ref.StorageKey)
	if b.err != nil {
		return nil, 0, b.err
	}
	data, ok := b.objects[ref.StorageKey]
	if !ok {
		return nil, 0, artifacts.ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(data)), int64(len(data)), nil
}

func artTestSigner(t *testing.T) *artifacts.Signer {
	t.Helper()
	signer, err := artifacts.NewSigner(bytes.Repeat([]byte("k"), 32))
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return signer
}

func artNewServer(t *testing.T, store *artFakeStore, bytes_ *artFakeBytes, cfg PreviewConfig, logTo *bytes.Buffer) *Server {
	t.Helper()
	if cfg.Host == "" {
		cfg.Host = artPreviewHost
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = artPreviewBase
	}
	if cfg.Tokens == nil {
		cfg.Tokens = artTestSigner(t)
	}
	cfg.Store = store
	if bytes_ != nil && cfg.Bytes == nil {
		cfg.Bytes = bytes_
	}
	cfg.TTL = artifacts.DefaultTokenTTL
	var log *slog.Logger
	if logTo != nil {
		log = slog.New(slog.NewTextHandler(logTo, nil))
	}
	s := newTestServerWith(t, Config{
		ReplicaName: "api-a", Version: "test", PublicURL: artPublicOrigin, Logger: log,
	}, nil, fakeReadiness{ver: 4, expected: 4}, principalAuth(testPrincipal(), nil))
	RegisterArtifacts(s, store, bytes_, cfg)
	RegisterPreview(s, cfg)
	return s
}

func artView(kind, sensitivity, state, role string) ArtifactView {
	return ArtifactView{
		ID: artTestID, ProjectID: artTestProject,
		Name: "report", Kind: kind, MediaType: artMediaType(kind),
		SHA256: artTestDigest, SizeBytes: 5, Sensitivity: sensitivity, State: state,
		RedactionCount: 0, CreatedBy: "worker", CreatedAt: time.Now().UTC(),
		StorageBackend: "local", StorageKey: artTestKey, MyRole: role,
	}
}

func artMediaType(kind string) string {
	switch kind {
	case "html":
		return "text/html"
	case "image":
		return "image/png"
	default:
		return "application/json"
	}
}

func artRequest(method, target string, hdr map[string]string) *http.Request {
	r := request(method, target, hdr)
	if _, ok := hdr["Origin"]; !ok {
		r.Header.Set("Origin", artPublicOrigin)
	}
	return r
}

// --- listing and metadata ------------------------------------------------

func TestArtifactsRequireASession(t *testing.T) {
	// A server whose authenticator refuses everything, which is what "no
	// session cookie" means once the middleware chain is in play.
	s := newTestServerWith(t, Config{ReplicaName: "api-a", PublicURL: artPublicOrigin,
		Logger: discardLogger()}, nil, fakeReadiness{ver: 4, expected: 4},
		principalAuth(nil, ErrUnauthenticated))
	RegisterArtifacts(s, artNewFakeStore(), newArtFakeBytes(), PreviewConfig{
		Host: artPreviewHost, BaseURL: artPreviewBase, Tokens: artTestSigner(t),
	})
	for _, path := range []string{
		"/api/v1/projects/" + artTestProject + "/artifacts",
		"/api/v1/artifacts/" + artTestID,
		"/api/v1/artifacts/" + artTestID + "/content",
	} {
		rec := do(t, s, request(http.MethodGet, "http://localhost:18080"+path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", path, rec.Code)
		}
	}
}

func TestListArtifactsNonMemberIs404AndAudited(t *testing.T) {
	// Case 15's artifact half at the handler level: a caller the store cannot
	// see any artifacts for gets 404 with an audit row and no metadata.
	store := artNewFakeStore()
	store.listErr = ErrProjectNotFound
	s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)
	rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/projects/"+artTestProject+"/artifacts", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	if len(store.denials) != 1 || store.denials[0].action != "artifact.list" {
		t.Errorf("denials = %+v, want one artifact.list", store.denials)
	}
	if body := rec.Body.String(); strings.Contains(body, artTestKey) || strings.Contains(body, artTestDigest) {
		t.Errorf("the 404 body leaked something: %s", body)
	}
}

func TestListArtifactsConversationFilter(t *testing.T) {
	// The design handoff's thread-rail ask (W3): `?conversation_id=` narrows
	// the project's artifact list to one thread's artifacts. Three halves live
	// here: a malformed uuid is a 400 before the store is called, a well-formed
	// one is forwarded to the store, and a conversation the store answers
	// not-found for is the 404 the rest of the invisible-resource answers use —
	// never an empty list that would confirm the project exists.
	store := artNewFakeStore()
	store.lists[artTestProject] = []ArtifactView{artView("markdown", "standard", "ready", "maintainer")}
	s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)

	rec := do(t, s, artRequest(http.MethodGet,
		"http://localhost:18080/api/v1/projects/"+artTestProject+"/artifacts?conversation_id="+artTestConversationID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET ?conversation_id=<thread> = %d (%s)", rec.Code, rec.Body)
	}
	if got := store.lastListConversation; got != artTestConversationID {
		t.Errorf("store received conversation %q, want %q", got, artTestConversationID)
	}
	var listed ArtifactList
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode ArtifactList: %v", err)
	}
	if len(listed.Artifacts) != 1 || listed.Artifacts[0].Name != "report" {
		t.Errorf("listed = %+v, want the one thread artifact", listed.Artifacts)
	}

	rec = do(t, s, artRequest(http.MethodGet,
		"http://localhost:18080/api/v1/projects/"+artTestProject+"/artifacts?conversation_id=not-a-uuid", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("GET ?conversation_id=not-a-uuid = %d, want 400", rec.Code)
	}
	if prob := decodeProblem(t, rec); !strings.Contains(prob.Detail, "invalid_conversation_id") {
		t.Errorf("detail = %q, want it to name invalid_conversation_id", prob.Detail)
	}

	store.listErr = ErrArtifactNotFound
	rec = do(t, s, artRequest(http.MethodGet,
		"http://localhost:18080/api/v1/projects/"+artTestProject+"/artifacts?conversation_id="+artTestConversationID, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET ?conversation_id=<thread> for an invisible thread = %d, want 404", rec.Code)
	}
	if len(store.denials) != 1 || store.denials[0].action != "artifact.list" {
		t.Errorf("denials = %+v, want one artifact.list", store.denials)
	}
}

func TestArtifactSerializationNeverCarriesStorageKey(t *testing.T) {
	store := artNewFakeStore()
	store.put(artView("json", "standard", "ready", "maintainer"))
	s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)

	rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	raw := rec.Body.String()
	for _, forbidden := range []string{"storage_key", "storage_backend", artTestKey, "my_role"} {
		if strings.Contains(raw, forbidden) {
			t.Errorf("the artifact body contains %q: %s", forbidden, raw)
		}
	}
	// Required members of the Artifact schema, so a rename cannot slip through
	// unnoticed.
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range []string{"id", "project_id", "name", "kind", "media_type", "sha256",
		"size_bytes", "sensitivity", "state", "redaction_count", "created_by", "created_at"} {
		if _, ok := body[k]; !ok {
			t.Errorf("Artifact body is missing %q", k)
		}
	}
	for _, k := range []string{"run_id", "node_execution_id", "attempt_id", "conversation_id",
		"turn_id", "worker_id"} {
		if v, ok := body[k]; !ok || v != nil {
			t.Errorf("%s = %v, want an explicit null", k, v)
		}
	}
}

func TestPreviewURLIsATemplateOnlyForPreviewableArtifacts(t *testing.T) {
	cases := []struct {
		kind, sensitivity, state, want string
	}{
		{"html", "standard", "ready", artPreviewBase + "/preview/{token}"},
		{"html", "internal", "ready", artPreviewBase + "/preview/{token}"},
		{"image", "standard", "ready", artPreviewBase + "/preview/{token}"},
		{"html", "restricted", "ready", ""},
		{"html", "secret", "ready", ""},
		{"json", "standard", "ready", ""},
		{"html", "standard", "uploading", ""},
	}
	for _, c := range cases {
		store := artNewFakeStore()
		v := artView(c.kind, c.sensitivity, c.state, "maintainer")
		v.ID = fmt.Sprintf("33333333-3333-4333-8333-%012d", len(c.kind)+len(c.sensitivity))
		store.put(v)
		s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)
		rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+v.ID, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s/%s/%s status = %d", c.kind, c.sensitivity, c.state, rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		got, present := body["preview_url"]
		if c.want == "" {
			if present {
				t.Errorf("%s/%s/%s carries preview_url %v, want absent", c.kind, c.sensitivity, c.state, got)
			}
			continue
		}
		if got != c.want {
			t.Errorf("%s/%s/%s preview_url = %v, want %q", c.kind, c.sensitivity, c.state, got, c.want)
		}
		if strings.Contains(fmt.Sprint(got), "token=") || strings.Count(fmt.Sprint(got), ".") > 3 {
			t.Errorf("preview_url looks like it carries a live token: %v", got)
		}
	}
}

func TestRestrictedMetadataNeedsAMaintainer(t *testing.T) {
	for _, tc := range []struct {
		role, sensitivity string
		want              int
	}{
		{"viewer", "restricted", http.StatusForbidden},
		{"contributor", "restricted", http.StatusForbidden},
		{"maintainer", "restricted", http.StatusOK},
		{"viewer", "secret", http.StatusForbidden},
		{"maintainer", "secret", http.StatusOK},
		{"viewer", "internal", http.StatusOK},
	} {
		store := artNewFakeStore()
		store.put(artView("json", tc.sensitivity, "ready", tc.role))
		s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)
		rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID, nil))
		if rec.Code != tc.want {
			t.Errorf("%s reading %s metadata = %d, want %d (%s)",
				tc.role, tc.sensitivity, rec.Code, tc.want, rec.Body)
		}
		if tc.want == http.StatusForbidden && len(store.denials) == 0 {
			t.Errorf("a forbidden metadata read wrote no audit row")
		}
	}
}

// --- bytes ---------------------------------------------------------------

func TestArtifactContentDowngradesHTMLToAnAttachment(t *testing.T) {
	body := []byte("<!doctype html><script>document.cookie</script>")
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = body
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)

	rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	hdr := rec.Header()
	if ct := hdr.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("Content-Type = %q, want the html downgrade", ct)
	}
	if cd := hdr.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("Content-Disposition = %q, want attachment", cd)
	}
	if hdr.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("nosniff missing")
	}
	if !bytes.Contains(rec.Body.Bytes(), body) {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestArtifactContentServesOtherTypesInline(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte(`{"ok":true}`)
	store.put(artView("json", "internal", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "inline;") {
		t.Errorf("Content-Disposition = %q", cd)
	}
}

func TestArtifactContentRoleGateFollowsTheSensitivityTable(t *testing.T) {
	cases := []struct {
		role, sensitivity string
		want              int
	}{
		{"viewer", "standard", http.StatusForbidden},
		{"contributor", "standard", http.StatusOK},
		{"contributor", "internal", http.StatusOK},
		{"contributor", "restricted", http.StatusForbidden},
		{"maintainer", "restricted", http.StatusOK},
		{"maintainer", "secret", http.StatusForbidden}, // no download path at all
		{"viewer", "secret", http.StatusForbidden},
	}
	for _, c := range cases {
		store, b := artNewFakeStore(), newArtFakeBytes()
		b.objects[artTestKey] = []byte("x")
		store.put(artView("json", c.sensitivity, "ready", c.role))
		s := artNewServer(t, store, b, PreviewConfig{}, nil)
		rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
		if rec.Code != c.want {
			t.Errorf("%s downloading %s = %d, want %d", c.role, c.sensitivity, rec.Code, c.want)
		}
		if c.want == http.StatusForbidden && len(b.opened) != 0 {
			t.Errorf("a refused download still opened the byte backend")
		}
		if c.want == http.StatusForbidden && len(store.denials) == 0 {
			t.Errorf("a refused download wrote no audit row")
		}
	}
}

func TestArtifactContentRefusesNonReadyRows(t *testing.T) {
	for _, state := range []string{"uploading", "orphan", "deleted"} {
		store, b := artNewFakeStore(), newArtFakeBytes()
		b.objects[artTestKey] = []byte("bytes exist, but the row says otherwise")
		store.put(artView("json", "standard", state, "maintainer"))
		s := artNewServer(t, store, b, PreviewConfig{}, nil)
		rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("state %s = %d, want 404", state, rec.Code)
		}
		if len(b.opened) != 0 {
			t.Errorf("state %s served bytes", state)
		}
	}
}

func TestArtifactContentReportsByteBackendFailuresHonestly(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.err = artifacts.ErrDigestMismatch
	store.put(artView("json", "standard", "ready", "maintainer"))
	var log bytes.Buffer
	s := artNewServer(t, store, b, PreviewConfig{}, &log)
	rec := do(t, s, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(log.String(), "digest_mismatch=true") {
		t.Errorf("a digest mismatch was not logged as one: %s", log.String())
	}
	if strings.Contains(rec.Body.String(), "digest") {
		t.Errorf("the internal reason reached the client: %s", rec.Body)
	}

	store2, b2 := artNewFakeStore(), newArtFakeBytes()
	b2.err = errors.New("dial tcp: connection refused")
	store2.put(artView("json", "standard", "ready", "maintainer"))
	s2 := artNewServer(t, store2, b2, PreviewConfig{}, nil)
	rec2 := do(t, s2, artRequest(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
	if rec2.Code != http.StatusInternalServerError {
		t.Errorf("a backend outage = %d, want 500", rec2.Code)
	}
}

func TestArtifactContentNeedsNoCSRFButMintingDoes(t *testing.T) {
	store := artNewFakeStore()
	store.put(artView("html", "standard", "ready", "maintainer"))
	s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)

	// GET is a safe method: no CSRF header required.
	rec := do(t, s, request(http.MethodGet, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/content", nil))
	if rec.Code == http.StatusForbidden {
		t.Errorf("a GET was CSRF-refused")
	}
	// POST is not.
	rec = do(t, s, request(http.MethodPost, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/preview-token", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST without a CSRF token = %d, want 403", rec.Code)
	}
	rec = do(t, s, request(http.MethodPost, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/preview-token",
		map[string]string{"X-CSRF-Token": "wrong"}))
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST with a wrong CSRF token = %d, want 403", rec.Code)
	}
}

// --- preview tokens ------------------------------------------------------

func TestPreviewTokenMintSucceedsAndIsAudited(t *testing.T) {
	store := artNewFakeStore()
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)
	rec := do(t, s, artRequest(http.MethodPost, "http://localhost:18080/api/v1/artifacts/"+artTestID+"/preview-token",
		map[string]string{"X-CSRF-Token": testPrincipal().CSRFToken}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	var out PreviewTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ArtifactID != artTestID {
		t.Errorf("artifact_id = %q", out.ArtifactID)
	}
	if !strings.HasPrefix(out.PreviewURL, artPreviewBase+"/preview/") {
		t.Errorf("preview_url = %q, want the preview origin", out.PreviewURL)
	}
	if strings.HasPrefix(out.PreviewURL, artPublicOrigin) {
		t.Errorf("preview_url is on the app origin, which would carry the session cookie")
	}
	if !out.ExpiresAt.After(time.Now().Add(4 * time.Minute)) {
		t.Errorf("expires_at = %s, want ~5 minutes out", out.ExpiresAt)
	}
	if out.Token == "" {
		t.Error("no token in the mint response")
	}
	if len(store.denials) != 0 {
		t.Errorf("a successful mint was recorded as a denial: %+v", store.denials)
	}
}

func TestPreviewTokenMintGate(t *testing.T) {
	cases := []struct {
		kind, sensitivity, state, role string
		want                           int
	}{
		{"html", "standard", "ready", "contributor", http.StatusOK},
		{"html", "internal", "ready", "maintainer", http.StatusOK},
		{"html", "standard", "ready", "viewer", http.StatusForbidden},
		{"html", "restricted", "ready", "maintainer", http.StatusForbidden},
		{"html", "secret", "ready", "maintainer", http.StatusForbidden},
		{"json", "standard", "ready", "maintainer", http.StatusForbidden},
		{"html", "standard", "uploading", "maintainer", http.StatusForbidden},
		{"html", "standard", "ready", "", http.StatusNotFound}, // not a member at all
	}
	for _, c := range cases {
		store := artNewFakeStore()
		v := artView(c.kind, c.sensitivity, c.state, c.role)
		if c.role == "" {
			// The store's stand-in for "you may not know this exists".
			v.MyRole = ""
			store.views[v.ID] = v
		} else {
			store.put(v)
		}
		s := artNewServer(t, store, newArtFakeBytes(), PreviewConfig{}, nil)
		rec := do(t, s, artRequest(http.MethodPost,
			"http://localhost:18080/api/v1/artifacts/"+artTestID+"/preview-token",
			map[string]string{"X-CSRF-Token": testPrincipal().CSRFToken}))
		if c.role == "" {
			store.views[artTestID] = ArtifactView{} // force the not-found path
			rec = do(t, s, artRequest(http.MethodPost,
				"http://localhost:18080/api/v1/artifacts/44444444-4444-4444-8444-444444444444/preview-token",
				map[string]string{"X-CSRF-Token": testPrincipal().CSRFToken}))
		}
		if rec.Code != c.want {
			t.Errorf("%s/%s/%s as %s = %d, want %d (%s)", c.kind, c.sensitivity, c.state,
				c.role, rec.Code, c.want, rec.Body)
		}
	}
}

// --- the preview origin --------------------------------------------------

func artMintToken(t *testing.T, artifactID, digest string, exp time.Time) string {
	t.Helper()
	signer := artTestSigner(t)
	tok, err := signer.Sign(artifacts.Token{
		Scope: artifacts.ScopePreview, ArtifactID: artifactID, SHA256: digest, ExpiresAt: exp,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return tok
}

func TestPreviewOriginServesTheSandboxHeaderSet(t *testing.T) {
	doc := []byte("<!doctype html><title>p</title><script>document.cookie</script>")
	store, b := artNewFakeStore(), newArtFakeBytes()
	v := artView("html", "standard", "ready", "contributor")
	key := v.StorageKey
	b.objects[key] = doc
	v.StorageKey = key
	store.put(v)
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))

	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	rec := do(t, s, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	hdr := rec.Header()
	// Both CSP headers must be present (a single-header assertion would pass if
	// one overwrote the other).
	csps := hdr.Values("Content-Security-Policy")
	joined := strings.Join(csps, " || ")
	if !strings.Contains(joined, "sandbox") {
		t.Errorf("no `sandbox` CSP in %q", joined)
	}
	if strings.Contains(joined, "allow-same-origin") {
		t.Errorf("the sandbox CSP widened itself: %q", joined)
	}
	if !strings.Contains(joined, "default-src 'none'") {
		t.Errorf("no default-src 'none' in %q", joined)
	}
	for name, want := range map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Content-Disposition":          "inline",
		"Referrer-Policy":              "no-referrer",
		"Cache-Control":                "no-store",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Content-Type":                 "text/html; charset=utf-8",
	} {
		if got := hdr.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if cookies := hdr.Values("Set-Cookie"); len(cookies) != 0 {
		t.Errorf("the preview origin set cookies: %v", cookies)
	}
	if !bytes.Contains(rec.Body.Bytes(), doc) {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestPreviewOriginIsHostGated(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html><script>x</script></html>")
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))

	// The app origin must not serve it — otherwise the document is same-origin
	// with the session, which is case 16's whole failure mode.
	rec := do(t, s, request(http.MethodGet, artPublicOrigin+"/preview/"+tok, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("app origin = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), ProblemJSON) {
		t.Errorf("the app origin answered %s, want problem+json (never the SPA shell)",
			rec.Header().Get("Content-Type"))
	}
	// And the preview origin serves only previews.
	withGuard := PreviewHostOnly(artPreviewHost)(s)
	for _, path := range []string{"/", "/api/v1/me", "/assets/index.js", "/favicon.ico"} {
		req := httptest.NewRequest(http.MethodGet, artPreviewBase+path, nil)
		req.Host = artPreviewHost
		rec := do(t, withGuard, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("preview origin %s = %d, want 404", path, rec.Code)
		}
	}
	// The same guard leaves the app origin alone.
	req := httptest.NewRequest(http.MethodGet, artPublicOrigin+"/api/v1/me", nil)
	req.Header.Set("Cookie", "communication_session=x")
	if rec := do(t, withGuard, req); rec.Code == http.StatusNotFound {
		t.Errorf("the guard refused an app-origin api request: %s", rec.Body)
	}
}

func TestPreviewTokenFailures(t *testing.T) {
	t.Helper()
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html></html>")
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)

	other, err := artifacts.NewSigner(bytes.Repeat([]byte("x"), 32))
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	badScope, err := other.Sign(artifacts.Token{Scope: artifacts.ScopeDownload,
		ArtifactID: artTestID, SHA256: artTestDigest, ExpiresAt: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	cases := []struct {
		name, token string
		want        int
	}{
		{"expired", artMintToken(t, artTestID, artTestDigest, time.Now().Add(-time.Minute)), http.StatusUnauthorized},
		{"wrong key", artMintTokenWith(t, other, artTestID, artTestDigest, time.Now().Add(time.Minute)), http.StatusUnauthorized},
		{"download scope used as preview", badScope, http.StatusUnauthorized},
		// A valid signature naming an artifact that has no previewable row is
		// refused too; whether the answer is 401 or 404 only ever tells someone
		// who already holds a minted token, which is why the detail is the same
		// "No such artifact." either way.
		{"re-pointed at another artifact", artMintToken(t,
			"99999999-9999-9999-8999-999999999999", artTestDigest, time.Now().Add(time.Minute)), http.StatusNotFound},
		{"wrong digest", artMintToken(t, artTestID,
			fmt.Sprintf("%064d", 7), time.Now().Add(time.Minute)), http.StatusUnauthorized},
		{"garbage", "not-a-token", http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+c.token, nil)
			req.Host = artPreviewHost
			rec := do(t, s, req)
			if rec.Code != c.want {
				t.Errorf("status = %d, want %d (%s)", rec.Code, c.want, rec.Body)
			}
			if len(b.opened) != 0 {
				t.Errorf("the byte backend was opened for a rejected token")
			}
			b.opened = nil
		})
	}
}

func artMintTokenWith(t *testing.T, signer *artifacts.Signer, artifactID, digest string, exp time.Time) string {
	t.Helper()
	tok, err := signer.Sign(artifacts.Token{Scope: artifacts.ScopePreview,
		ArtifactID: artifactID, SHA256: digest, ExpiresAt: exp})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return tok
}

func TestPreviewStripsACookieAndServesNothingNew(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html></html>")
	store.put(artView("html", "standard", "ready", "contributor"))
	var log bytes.Buffer
	s := artNewServer(t, store, b, PreviewConfig{}, &log)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))

	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	req.Header.Set("Cookie", "communication_session=stolen; other=1")
	rec := do(t, s, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(rec.Header().Values("Set-Cookie")) != 0 {
		t.Error("the preview origin set a cookie")
	}
	if !strings.Contains(log.String(), "stripped a cookie") {
		t.Errorf("a cookie on a preview request was not noticed: %s", log.String())
	}
	if strings.Contains(log.String(), "stolen") {
		t.Errorf("the cookie value reached the log: %s", log.String())
	}
}

func TestPreviewRefusesRangeRequests(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html>0123456789</html>")
	store.put(artView("html", "standard", "ready", "contributor"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))
	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	req.Header.Set("Range", "bytes=0-10")
	rec := do(t, s, req)
	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Errorf("status = %d, want 416", rec.Code)
	}
	if len(b.opened) != 0 {
		t.Error("a ranged preview opened the byte backend")
	}
}

func TestPreviewCannotOutliveASensitivityChange(t *testing.T) {
	// A token minted while the artifact was `standard` must stop working once
	// the row says `restricted`, because the preview read re-checks the row.
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html>secret-ish</html>")
	v := artView("html", "restricted", "ready", "maintainer")
	store.put(v)
	s := artNewServer(t, store, b, PreviewConfig{}, nil)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))
	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	rec := do(t, s, req)
	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 401/404 (body %s)", rec.Code, rec.Body)
	}
}

// --- the surface that must stay absent -----------------------------------

// TestArtifactRoutesAreReadOnlyAndNothingElse keeps m3-contract § 2's
// "deliberately absent" list enforced: no PUT/PATCH/DELETE on artifacts (they
// are immutable), no browser route that renders artifact script, and no
// storage_key in any answer.
func TestArtifactRoutesAreReadOnlyAndNothingElse(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("x")
	store.put(artView("json", "standard", "ready", "maintainer"))
	s := artNewServer(t, store, b, PreviewConfig{}, nil)

	base := "http://localhost:18080/api/v1/artifacts/" + artTestID
	for _, m := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodPost} {
		target := base
		if m == http.MethodPost {
			// The one documented POST is the preview-token mint; everything
			// else under the id must be a 404/405.
			target = base + "/content"
		}
		rec := do(t, s, artRequest(m, target, map[string]string{"X-CSRF-Token": testPrincipal().CSRFToken}))
		if rec.Code == http.StatusOK || rec.Code == http.StatusCreated {
			t.Errorf("%s %s = %d, want a refusal", m, target, rec.Code)
		}
	}
	for _, path := range []string{"/render", "/view", "/html", "/raw", "/preview"} {
		rec := do(t, s, artRequest(http.MethodGet, base+path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (a rendering route must not exist)", path, rec.Code)
		}
	}
}

// TestAccessLogNeverPrintsAPreviewToken is the log half of case 16: the token
// is a bearer credential that lives in the path, so the access log line must
// name the route, not the credential.
func TestAccessLogNeverPrintsAPreviewToken(t *testing.T) {
	store, b := artNewFakeStore(), newArtFakeBytes()
	b.objects[artTestKey] = []byte("<html></html>")
	store.put(artView("html", "standard", "ready", "contributor"))
	var log bytes.Buffer
	s := artNewServer(t, store, b, PreviewConfig{}, &log)
	tok := artMintToken(t, artTestID, artTestDigest, time.Now().Add(time.Minute))

	req := httptest.NewRequest(http.MethodGet, artPreviewBase+"/preview/"+tok, nil)
	req.Host = artPreviewHost
	req.Header.Set("Cookie", "communication_session=session-value")
	do(t, s, req)

	out := log.String()
	if strings.Contains(out, tok) {
		t.Errorf("the access log printed the preview token: %s", out)
	}
	if !strings.Contains(out, "path=/preview/:token") {
		t.Errorf("the access log did not redact the path: %s", out)
	}
	for _, forbidden := range []string{"session-value", "Cookie", "communication_session"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("the access log contains %q: %s", forbidden, out)
		}
	}
}
