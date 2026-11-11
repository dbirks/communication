package api

// ADR-0084: the APM collection library's HTTP surface. The database behind these
// is a fake that answers with the store's own errors, so what this file pins is
// the WIRE: the route set, the statuses, the write gate (403 for a member who can
// read every collection but may not edit one), the named 422 codes, and the 409
// that says a published revision is frozen. The real-Postgres semantics —
// published-only attachments, the immutability trigger, the digest clearing on a
// moved list — are internal/store/postgres/apm_collections_test.go.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const apmcURL = "http://localhost:8080/api/v1/apm-collections"

const apmcCollectionID = "01987a71-4444-7000-8000-abcdef012345"

type apmcFakeStore struct {
	list     []APMCollectionView
	detail   APMCollectionDetailView
	created  APMCollectionView
	revision APMCollectionRevisionView
	err      error
	calls    []string
	lastIn   APMCollectionCreateInput
	lastRev  APMCollectionRevisionInput
	lastPub  int
	pubID    string
}

func (f *apmcFakeStore) ListAPMCollections(context.Context, Caller) ([]APMCollectionView, error) {
	f.calls = append(f.calls, "list")
	if f.err != nil {
		return nil, f.err
	}
	return f.list, nil
}

func (f *apmcFakeStore) GetAPMCollection(_ context.Context, _ Caller, id string) (APMCollectionDetailView, error) {
	f.calls = append(f.calls, "get:"+id)
	if f.err != nil {
		return APMCollectionDetailView{}, f.err
	}
	return f.detail, nil
}

func (f *apmcFakeStore) CreateAPMCollection(_ context.Context, c Caller, in APMCollectionCreateInput) (APMCollectionView, error) {
	f.calls = append(f.calls, "create")
	if !c.IsOrgAdmin {
		return APMCollectionView{}, ErrAPMCollectionForbidden
	}
	f.lastIn = in
	if f.err != nil {
		return APMCollectionView{}, f.err
	}
	return f.created, nil
}

func (f *apmcFakeStore) CreateAPMCollectionRevision(_ context.Context, _ Caller, id string, in APMCollectionRevisionInput) (APMCollectionRevisionView, error) {
	f.calls = append(f.calls, "revision:"+id)
	f.lastRev = in
	if f.err != nil {
		return APMCollectionRevisionView{}, f.err
	}
	return f.revision, nil
}

func (f *apmcFakeStore) PublishAPMCollectionRevision(_ context.Context, _ Caller, id string, revision int) (APMCollectionRevisionView, error) {
	f.calls = append(f.calls, "publish:"+id)
	f.pubID, f.lastPub = id, revision
	if f.err != nil {
		return APMCollectionRevisionView{}, f.err
	}
	return f.revision, nil
}

func (f *apmcFakeStore) RecordDenied(context.Context, Caller, string, string) error {
	f.calls = append(f.calls, "denied")
	return nil
}

func apmcMount(t *testing.T, store *apmcFakeStore, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3}, auth, nil)
	RegisterAPMCollections(s, store)
	return s
}

func apmcCaller(isAdmin bool) Authenticator {
	return principalAuth(&Principal{UserID: "u-apmc", OrganizationID: "o-1",
		DisplayName: "U", CSRFToken: "csrf-token-value", IsOrgAdmin: isAdmin}, nil)
}

func apmcSend(t *testing.T, s *Server, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

// apmcEntry is a real, pinned entry of the seeded shape: a per-skill pstack ref
// from the generated Claude tree, commit-pinned. The grammar test below depends on
// it being accepted, so it is copied from the migration seed rather than invented.
const apmcEntry = "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"

func apmcNow() time.Time { return time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC) }

func apmcSeedView() APMCollectionView {
	return APMCollectionView{
		ID: apmcCollectionID, Slug: "pstack-claude-code", Name: "pstack (Claude Code)",
		Description: "Lauren Tan's pstack, per skill.", CreatedBy: "u-apmc",
		CreatedAt: apmcNow(), UpdatedAt: apmcNow(),
		LatestRevision: &APMCollectionRevisionSummary{
			RevisionID: "01987a71-5555-7000-8000-abcdef012345", Revision: 1, Status: "published",
			Entries:   []APMCollectionEntryView{{Ref: apmcEntry, Skills: []string{}}},
			CreatedAt: apmcNow(),
		},
		PublishedRevisions: 1,
	}
}

func TestAPMCollectionListAndGet(t *testing.T) {
	store := &apmcFakeStore{list: []APMCollectionView{apmcSeedView()}}
	s := apmcMount(t, store, apmcCaller(false))

	rec := apmcSend(t, s, http.MethodGet, apmcURL, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body)
	}
	var list APMCollectionListView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if list.NextCursor != nil {
		t.Errorf("next_cursor = %v, want null", *list.NextCursor)
	}
	if len(list.Collections) != 1 || list.Collections[0].Slug != "pstack-claude-code" {
		t.Fatalf("collections = %+v", list.Collections)
	}
	// The list carries the content, not just an identity: the library page renders
	// entries straight from this response.
	if list.Collections[0].LatestRevision == nil || len(list.Collections[0].LatestRevision.Entries) != 1 {
		t.Errorf("latest_revision = %+v, want the seeded entry", list.Collections[0].LatestRevision)
	}
	if list.Collections[0].PublishedRevisions != 1 {
		t.Errorf("published_revisions = %d, want 1", list.Collections[0].PublishedRevisions)
	}

	store.detail = APMCollectionDetailView{
		Collection: apmcSeedView(),
		Revisions: []APMCollectionRevisionView{{
			RevisionID: "r-2", Revision: 2, Status: "draft",
			Entries: []APMCollectionEntryView{
				{Ref: "mattpocock/skills#v1.3.2", Skills: []string{"grill-me"}},
				{Ref: apmcEntry, Skills: []string{}},
			},
			CreatedBy: "u-apmc", CreatedAt: apmcNow(), UpdatedAt: apmcNow(),
		}},
	}
	rec = apmcSend(t, s, http.MethodGet, apmcURL+"/"+apmcCollectionID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /{id} = %d (%s)", rec.Code, rec.Body)
	}
	var detail APMCollectionDetailView
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if len(detail.Revisions) != 1 || detail.Revisions[0].Status != "draft" {
		t.Fatalf("revisions = %+v", detail.Revisions)
	}
	// `skills` is [] never null on the wire: "the whole package" has to be
	// distinguishable from "a field the app never read".
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	revs := raw["revisions"].([]any)
	first := revs[0].(map[string]any)
	entries := first["entries"].([]any)
	if skills, ok := entries[1].(map[string]any)["skills"].([]any); !ok || len(skills) != 0 {
		t.Errorf("a whole-package entry's skills = %v, want [] (never null)", entries[1])
	}

	// An unknown id is the uniform 404, and the denial is audited.
	store.err = ErrAPMCollectionNotFound
	rec = apmcSend(t, s, http.MethodGet, apmcURL+"/01987a71-9999-7000-8000-abcdef012345", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET unknown = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(strings.Join(store.calls, " "), "denied") {
		t.Errorf("calls = %v, want an audit row for the refused read", store.calls)
	}
}

func TestAPMCollectionCreateRequiresTheLibraryRole(t *testing.T) {
	body := `{"slug":"team-conventions","name":"Team conventions","description":"ours",
		"entries":[{"ref":"` + apmcEntry + `","skills":["how"],"note":"the router"}]}`

	// A member can read the library and may not edit it: 403, before the store.
	store := &apmcFakeStore{}
	s := apmcMount(t, store, apmcCaller(false))
	rec := apmcSend(t, s, http.MethodPost, apmcURL, body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin POST = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.calls) != 0 {
		t.Errorf("store calls for a 403 = %v, want none", store.calls)
	}

	// The admin's create reaches the store with the entries in order and the note
	// attached — the ordered list IS the bundle, so nothing may reorder it here.
	store.created = apmcSeedView()
	s = apmcMount(t, store, apmcCaller(true))
	rec = apmcSend(t, s, http.MethodPost, apmcURL, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("admin POST = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if store.lastIn.Slug != "team-conventions" || store.lastIn.Name != "Team conventions" {
		t.Errorf("create input = %+v", store.lastIn)
	}
	if len(store.lastIn.Entries) != 1 || store.lastIn.Entries[0].Ref != apmcEntry ||
		store.lastIn.Entries[0].Note != "the router" || len(store.lastIn.Entries[0].Skills) != 1 {
		t.Errorf("entries = %+v", store.lastIn.Entries)
	}
}

// Every entry ref must already be pinned. An unpinned ref would follow a moving
// branch into an agent's context, and the lock digest — the one control that
// proves what ran — would be a digest of whatever upstream looked like that hour
// (ADR-0084 Security, ADR-0030 §3).
func TestAPMCollectionCreateRefusesAnUnpinnedRef(t *testing.T) {
	for _, tc := range []struct{ name, ref string }{
		{"branch-less ref", "mattpocock/skills"},
		{"empty revision", "mattpocock/skills#"},
		// The literal newline a hostile ref must survive JSON decoding to become
		// what it is: a value that closes its YAML scalar and writes a second
		// dependency line. JSON-escaped here so DecodeJSON hands the handler the
		// real bytes rather than refusing the body.
		{"newline escape", "mattpocock/skills#v1.3.2\\n      - evil/repo#main"},
		{"quote", "mattpocock/skills#v1.3\\\"2"},
		{"traversal", "mattpocock/../etc/skills#v1.3.2"},
	} {
		body := `{"slug":"ref-check","name":"N","entries":[{"ref":"` + tc.ref + `"}]}`
		store := &apmcFakeStore{}
		s := apmcMount(t, store, apmcCaller(true))
		rec := apmcSend(t, s, http.MethodPost, apmcURL, body)
		if rec.Code == http.StatusCreated || rec.Code == http.StatusForbidden {
			t.Fatalf("%s: POST = %d, want a refusal (%s)", tc.name, rec.Code, rec.Body)
		}
		var problem struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
			t.Fatalf("%s: decode problem: %v (%s)", tc.name, err, rec.Body)
		}
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: POST = %d, want the named 422 (%s)", tc.name, rec.Code, rec.Body)
		}
		if problem.Code != CollectionCodeEntriesInvalid {
			t.Errorf("%s: code = %q, want %q (%s)", tc.name, problem.Code, CollectionCodeEntriesInvalid, rec.Body)
		}
		if len(store.calls) != 0 {
			t.Errorf("%s: the store was reached (%v) for a body the handler refuses", tc.name, store.calls)
		}
	}
}

// An empty entry list is legal: that is the empty, editable starter collection
// ADR-0084 seeds, and refusing it would refuse the thing a team starts from.
func TestAPMCollectionCreateAcceptsAnEmptyBundle(t *testing.T) {
	store := &apmcFakeStore{created: apmcSeedView()}
	s := apmcMount(t, store, apmcCaller(true))
	rec := apmcSend(t, s, http.MethodPost, apmcURL, `{"slug":"review-conventions","name":"Review conventions","entries":[]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST empty bundle = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if store.lastIn.Entries != nil && len(store.lastIn.Entries) != 0 {
		t.Errorf("entries = %+v, want none", store.lastIn.Entries)
	}
}

func TestAPMCollectionRevisionAndPublish(t *testing.T) {
	store := &apmcFakeStore{revision: APMCollectionRevisionView{
		RevisionID: "r-3", Revision: 3, Status: "draft",
		Entries:   []APMCollectionEntryView{{Ref: "mattpocock/skills#v1.3.2", Skills: []string{}}},
		CreatedBy: "u-apmc", CreatedAt: apmcNow(), UpdatedAt: apmcNow(),
	}}
	s := apmcMount(t, store, apmcCaller(true))

	rec := apmcSend(t, s, http.MethodPost, apmcURL+"/"+apmcCollectionID+"/revisions",
		`{"entries":[{"ref":"mattpocock/skills#v1.3.2"}]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST revisions = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if len(store.lastRev.Entries) != 1 || store.lastRev.Entries[0].Ref != "mattpocock/skills#v1.3.2" {
		t.Errorf("revision input = %+v", store.lastRev)
	}
	var created APMCollectionRevisionView
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Status != "draft" {
		t.Errorf("a new revision is %q, want draft: creating is not publishing", created.Status)
	}

	store.revision.Status = "published"
	rec = apmcSend(t, s, http.MethodPost, apmcURL+"/"+apmcCollectionID+"/revisions/3/publish", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("publish = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if store.lastPub != 3 || store.pubID != apmcCollectionID {
		t.Errorf("publish call = %s/%d", store.pubID, store.lastPub)
	}

	// Publishing an already-published revision is 409 with the remedy named:
	// there is no route that edits a published revision, and a client that tries
	// must be told to draft a new one rather than left to guess.
	store.err = ErrAPMCollectionRevisionImmutable
	rec = apmcSend(t, s, http.MethodPost, apmcURL+"/"+apmcCollectionID+"/revisions/1/publish", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("republish = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "new revision") {
		t.Errorf("409 body = %s, want it to name the remedy", rec.Body)
	}

	// A malformed revision is not-found, not a 400: it names no row.
	store.err = nil
	before := len(store.calls)
	rec = apmcSend(t, s, http.MethodPost, apmcURL+"/"+apmcCollectionID+"/revisions/zero/publish", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("bad revision = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if len(store.calls) != before+1 || !strings.Contains(store.calls[len(store.calls)-1], "denied") {
		t.Errorf("calls after a malformed publish = %v, want only the audit row", store.calls)
	}
}

// A slug clash is the store's 409, and it must not arrive as a 500.
func TestAPMCollectionConflictMaps(t *testing.T) {
	store := &apmcFakeStore{err: ErrAPMCollectionConflict}
	s := apmcMount(t, store, apmcCaller(true))
	rec := apmcSend(t, s, http.MethodPost, apmcURL, `{"slug":"pstack-claude-code","name":"dupe","entries":[]}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("clash = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}

// A body that is not JSON is a 400 with the store untouched — the same rule every
// other write surface states, and the reason DecodeJSON's strictness matters.
func TestAPMCollectionBadBodyIsFourHundred(t *testing.T) {
	store := &apmcFakeStore{}
	s := apmcMount(t, store, apmcCaller(true))
	rec := apmcSend(t, s, http.MethodPost, apmcURL, `{"slug":"x",`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if len(store.calls) != 0 {
		t.Errorf("calls = %v, want none", store.calls)
	}
	// An unknown member is refused too: a body cannot smuggle a status or an id.
	rec = apmcSend(t, s, http.MethodPost, apmcURL, `{"slug":"ok","name":"N","entries":[],"status":"published"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown member = %d, want 400 (%s)", rec.Code, rec.Body)
	}
}

// A mutation without the CSRF pair never reaches a handler.
func TestAPMCollectionWriteNeedsCSRF(t *testing.T) {
	store := &apmcFakeStore{}
	s := apmcMount(t, store, apmcCaller(true))
	req := httptest.NewRequest(http.MethodPost, apmcURL, strings.NewReader(`{"slug":"x","name":"N","entries":[]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := do(t, s, req)
	if rec.Code == http.StatusCreated || rec.Code == http.StatusOK {
		t.Fatalf("unprotected POST = %d, want a CSRF refusal (%s)", rec.Code, rec.Body)
	}
	if len(store.calls) != 0 {
		t.Errorf("calls = %v, want none", store.calls)
	}
}

// A store error nobody named is a 500 with the refusal logged, not a 200 with a
// zero-valued body: an empty collection printed as success would be the worst
// possible answer.
func TestAPMCollectionUnknownErrorIsFiveHundred(t *testing.T) {
	store := &apmcFakeStore{err: context.DeadlineExceeded}
	s := apmcMount(t, store, apmcCaller(false))
	rec := apmcSend(t, s, http.MethodGet, apmcURL, "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("store failure = %d, want 500 (%s)", rec.Code, rec.Body)
	}
}

// --- the profile side of ADR-0084 on the wire ---------------------------
//
// The attachment list is only worth having if the PIN VIEW carries it: the app
// renders "which bundles, in which order" from GET /agent-profiles, and a client
// that cannot see the list cannot know what apm_lock_digest is a digest of. The
// double below embeds the conversation fixture's store and overrides the three
// profile methods the ADR changed, so the fake answers the way the real store
// answers — including the digest clearing, which is the store's rule and must not
// be simulated as a client courtesy.

type apmcProfileStore struct {
	*cnvFakeStore
	patched []AgentProfileAPMPatch
}

func (f *apmcProfileStore) PatchAgentProfileAPM(_ context.Context, c Caller, profileID string, in AgentProfileAPMPatch) (AgentProfileView, error) {
	if !apmPinComplete(in) {
		return AgentProfileView{}, &AgentProfileProblemError{Code: ProfileCodeAPMIncomplete,
			Detail: "an apm pin is either the set plus the target (plus a digest), or all cleared"}
	}
	p := f.findProfile(profileID)
	if p == nil {
		return AgentProfileView{}, ErrProfileNotFound
	}
	if !c.IsOrgAdmin {
		return AgentProfileView{}, ErrProfileForbidden
	}
	set := func(dst **string, v *string) {
		if v == nil || *v == "" {
			*dst = nil
			return
		}
		cp := *v
		*dst = &cp
	}
	set(&p.APMPackageRef, in.APMPackageRef)
	set(&p.APMTarget, in.APMTarget)
	moved := false
	if in.APMCollectionPins != nil {
		moved = !samePins(p.APMCollectionPins, *in.APMCollectionPins)
		p.APMCollectionPins = append([]APMCollectionPin(nil), *in.APMCollectionPins...)
		if p.APMCollectionPins == nil {
			p.APMCollectionPins = []APMCollectionPin{}
		}
	}
	if in.APMLockDigest != nil && !moved {
		set(&p.APMLockDigest, in.APMLockDigest)
	} else if moved {
		// The store's rule, restated: a moved list drops the digest it described,
		// whatever the body carried beside it.
		p.APMLockDigest = nil
		p.APMContents = nil
	}
	p.Version++
	f.patched = append(f.patched, in)
	return *p, nil
}

func (f *apmcProfileStore) CreateAgentProfile(ctx context.Context, c Caller, in AgentProfileCreateInput) (AgentProfileView, error) {
	view, err := f.cnvFakeStore.CreateAgentProfile(ctx, c, in)
	if err != nil {
		return view, err
	}
	view.APMCollectionPins = append([]APMCollectionPin{}, in.APMCollectionPins...)
	if view.APMCollectionPins == nil {
		view.APMCollectionPins = []APMCollectionPin{}
	}
	for i := range f.cnvFakeStore.profiles {
		if f.cnvFakeStore.profiles[i].ID == view.ID {
			f.cnvFakeStore.profiles[i].APMCollectionPins = view.APMCollectionPins
		}
	}
	return view, nil
}

func (f *apmcProfileStore) ListAgentProfiles(_ context.Context, _ Caller) ([]AgentProfileView, error) {
	return f.cnvFakeStore.profiles, nil
}

// apmcProfileMount mounts the conversation + profile routes over an arbitrary
// profile store, which is how the real wiring mounts them over
// postgres.APIConversationStore. cnvMount takes the concrete fixture; the double
// below needs the same routes with a different store.
func apmcProfileMount(t *testing.T, store ProfileStore, auth Authenticator) *Server {
	t.Helper()
	conversations, ok := store.(ConversationStore)
	if !ok {
		t.Fatalf("the profile double must answer the conversation surface too, got %T", store)
	}
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3}, auth, nil)
	RegisterConversations(s, conversations, store, &cnvFakeStream{})
	return s
}

func samePins(a, b []APMCollectionPin) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

const apmcOtherCollection = "01987a71-6666-7000-8000-abcdef012345"

// apmcProfileID is a uuid-shaped profile id: PATCH validates the id before it
// reads anything, so a "p-1" fixture id would answer its not-found and test the
// guard instead of the write.
const apmcProfileID = "01987a71-7777-7000-8000-abcdef012345"

// A profile may be created with its collections chosen, and the create still
// cannot record a digest: the view says "unlocked", which is what the launch gate
// will refuse at until an operator locks the flattened set.
func TestAgentProfileCreateCarriesAttachments(t *testing.T) {
	// The double stands in for the store adapter, which is the layer the handler
	// talks to: RegisterConversations takes one value for both the conversation and
	// the profile surface, and the embedded fixture answers the rest.
	profiles := &apmcProfileStore{cnvFakeStore: cnvNewFakeStore()}
	s := apmcProfileMount(t, profiles, profAdminCaller("u-admin"))

	rec := apmcSend(t, s, http.MethodPost, "/api/v1/agent-profiles",
		`{"name":"Claude with pstack","launcher_id":"claude","apm_collections":[{"collection_id":"`+apmcCollectionID+`","revision":1}]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d (%s)", rec.Code, rec.Body)
	}
	var view AgentProfileView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.APMCollectionPins) != 1 || view.APMCollectionPins[0].Revision != 1 {
		t.Fatalf("apm_collections = %+v, want the one attachment", view.APMCollectionPins)
	}
	if view.APMLockDigest != nil {
		t.Errorf("a create recorded a digest: %v", *view.APMLockDigest)
	}
	if len(profiles.patched) != 0 {
		t.Error("create went through the patch path")
	}
}

// A malformed attachment is refused before the store sees the body: a revision of
// 0 or a collection_id that is not an id cannot be a published revision of
// anything, and a write that would ask the database to decide that is a wasted
// round trip and a worse message.
func TestAgentProfileAttachmentShapeIsRefusedEarly(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"zero revision", `{"apm_target":"claude","apm_collections":[{"collection_id":"` + apmcCollectionID + `","revision":0}]}`},
		{"not an id", `{"apm_target":"claude","apm_collections":[{"collection_id":"p-1","revision":1}]}`},
		{"attached twice", `{"apm_target":"claude","apm_collections":[{"collection_id":"` + apmcCollectionID + `","revision":1},{"collection_id":"` + apmcCollectionID + `","revision":2}]}`},
	} {
		profiles := &apmcProfileStore{cnvFakeStore: cnvNewFakeStore()}
		profiles.profiles = []AgentProfileView{{
			ID: apmcProfileID, Name: "Claude Code", LauncherID: "claude", PermissionMode: "ask",
			Version: 1, APMCollectionPins: []APMCollectionPin{},
		}}
		s := apmcProfileMount(t, profiles, profAdminCaller("u-admin"))
		rec := apmcSend(t, s, http.MethodPatch, "/api/v1/agent-profiles/"+apmcProfileID, tc.body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: PATCH = %d, want the named 422 (%s)", tc.name, rec.Code, rec.Body)
		}
		var problem struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
			t.Fatal(err)
		}
		if problem.Code != CollectionCodeRevisionInvalid {
			t.Errorf("%s: code = %q, want %q", tc.name, problem.Code, CollectionCodeRevisionInvalid)
		}
		if len(profiles.patched) != 0 {
			t.Errorf("%s: the store was reached for a body the handler refuses", tc.name)
		}
	}
}

// The pin view is the whole story: `apm_collections` in attach order beside the
// single `apm_lock_digest` that covers them, and the per-skill attribution the
// lock reported. A client that sees the digest without the list cannot know what
// it pins — which is the whole reason both are on one object.
func TestAgentProfilePinViewCarriesTheWholePin(t *testing.T) {
	profiles := &apmcProfileStore{cnvFakeStore: cnvNewFakeStore()}
	ref := "acme/extras#v0.1.0"
	digest := "sha256:" + strings.Repeat("a", 64)
	profiles.profiles = []AgentProfileView{{
		ID: apmcProfileID, Name: "Claude Code", LauncherID: "claude", PermissionMode: "ask", Version: 3,
		APMPackageRef: &ref, APMTarget: strPtr("claude"), APMLockDigest: &digest,
		APMCollectionPins: []APMCollectionPin{
			{CollectionID: apmcCollectionID, Revision: 2},
			{CollectionID: apmcOtherCollection, Revision: 1},
		},
		APMContents: &AgentProfileContentsView{
			Skills: []string{"grill-me", "how"},
			SkillRefs: []AgentProfileSkillRefView{
				{Skill: "grill-me", FromRef: "acme/extras#v0.1.0"},
				{Skill: "how", FromRef: apmcEntry},
			},
		},
	}}
	s := apmcProfileMount(t, profiles, cnvCaller("alice"))
	rec := apmcSend(t, s, http.MethodGet, "/api/v1/agent-profiles", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body)
	}
	var raw struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(raw.Items) != 1 {
		t.Fatalf("items = %d", len(raw.Items))
	}
	item := raw.Items[0]
	pins, ok := item["apm_collections"].([]any)
	if !ok || len(pins) != 2 {
		t.Fatalf("apm_collections = %v, want the two attachments", item["apm_collections"])
	}
	first := pins[0].(map[string]any)
	if first["collection_id"] != apmcCollectionID || first["revision"] != float64(2) {
		t.Errorf("first attachment = %v, want {collection_id: %s, revision: 2}", first, apmcCollectionID)
	}
	contents, ok := item["apm_contents"].(map[string]any)
	if !ok {
		t.Fatalf("apm_contents = %v", item["apm_contents"])
	}
	refs, ok := contents["skill_refs"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("skill_refs = %v, want the two attributions", contents["skill_refs"])
	}
	grill := refs[0].(map[string]any)
	if grill["skill"] != "grill-me" || grill["from_ref"] != ref {
		t.Errorf("skill_refs[0] = %v, want grill-me owned by %s", grill, ref)
	}
}

// The clearing is the server's, not a client courtesy: a body that carries a
// digest ALONGSIDE a moved list gets the digest dropped. The double above restates
// the store's rule, and this is the wire proof that the handler hands the list to
// the store at all — a handler that dropped the field would leave the digest
// standing over a list nobody wrote.
func TestAgentProfilePatchMovedListDropsTheDigest(t *testing.T) {
	profiles := &apmcProfileStore{cnvFakeStore: cnvNewFakeStore()}
	ref := "acme/extras#v0.1.0"
	target := "claude"
	locked := "sha256:" + strings.Repeat("a", 64)
	profiles.profiles = []AgentProfileView{{
		ID: apmcProfileID, Name: "Claude Code", LauncherID: "claude", PermissionMode: "ask", Version: 1,
		APMPackageRef: &ref, APMTarget: &target, APMLockDigest: &locked,
		APMCollectionPins: []APMCollectionPin{},
	}}
	s := apmcProfileMount(t, profiles, profAdminCaller("u-admin"))
	rec := apmcSend(t, s, http.MethodPatch, "/api/v1/agent-profiles/"+apmcProfileID,
		`{"apm_collections":[{"collection_id":"`+apmcCollectionID+`","revision":1}],"apm_lock_digest":"`+locked+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH = %d (%s)", rec.Code, rec.Body)
	}
	var view AgentProfileView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.APMLockDigest != nil {
		t.Errorf("the digest survived a moved list: %v", *view.APMLockDigest)
	}
	if len(view.APMCollectionPins) != 1 {
		t.Errorf("apm_collections = %+v", view.APMCollectionPins)
	}
	if len(profiles.patched) != 1 || profiles.patched[0].APMCollectionPins == nil ||
		len(*profiles.patched[0].APMCollectionPins) != 1 {
		t.Fatalf("the handler never handed the list to the store: %+v", profiles.patched)
	}
	if profiles.patched[0].APMPackageRef != nil {
		t.Error("a list-only body arrived at the store as a request to clear the ref")
	}
}
