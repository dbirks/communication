package api

// The assistant-notes routes (ADR-0071) at the HTTP layer: the two list
// shapes, the 422s a malformed path id gets before any store is asked, the
// 404 a stranger and a non-owner both get, the 204 a successful dismissal
// answers with, the CSRF gate every mutation here needs, and the action
// union's own rules (a closed vocabulary, exactly the payload its kind owns,
// the same 280-character text bound the table CHECKs).
//
// The store's own behaviour — the cap, per-user dismissal, expiry, the audit
// rows every refusal writes — is proven against real PostgreSQL in
// internal/store/postgres/assistant_notes_test.go; these tests pin the
// contract the store's answers are turned into.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeAssistantNotes is the in-memory AssistantNotesStore: it serves the rows
// the test asks for, answers the sentinels the real store answers with, and
// remembers what the routes asked it for.
type fakeAssistantNotes struct {
	repoNotes  []AssistantNoteView
	convNotes  []AssistantNoteView
	err        error
	dismissErr error

	gotRepo      []string
	gotConv      []string
	dismissCalls []string
	lastCaller   Caller
}

func (f *fakeAssistantNotes) ListRepositoryNotes(ctx context.Context, c Caller,
	projectID, repositoryID string) ([]AssistantNoteView, error) {
	f.lastCaller = c
	f.gotRepo = append(f.gotRepo, projectID+"/"+repositoryID)
	if f.err != nil {
		return nil, f.err
	}
	return f.repoNotes, nil
}

func (f *fakeAssistantNotes) ListConversationNotes(ctx context.Context, c Caller,
	conversationID string) ([]AssistantNoteView, error) {
	f.lastCaller = c
	f.gotConv = append(f.gotConv, conversationID)
	if f.err != nil {
		return nil, f.err
	}
	return f.convNotes, nil
}

func (f *fakeAssistantNotes) DismissAssistantNote(ctx context.Context, c Caller,
	noteID string) error {
	f.lastCaller = c
	f.dismissCalls = append(f.dismissCalls, noteID)
	return f.dismissErr
}

const (
	anProjectID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80"
	anRepoID    = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81"
	anConvID    = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b82"
	anNoteID    = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b83"
)

func newAssistantNotesServer(t *testing.T, store AssistantNotesStore) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterAssistantNotes(s, store)
	return s
}

func anGet(target string) *http.Request {
	return request(http.MethodGet, target, nil)
}

func anDismiss(target string) *http.Request {
	return request(http.MethodPost, target, map[string]string{
		"X-CSRF-Token": testPrincipal().CSRFToken,
	})
}

func anNote(id, text string) AssistantNoteView {
	return AssistantNoteView{
		ID: id, ProjectID: anProjectID,
		ScopeKind: AssistantNoteScopeRepository, ScopeID: anRepoID,
		Text: text, CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
	}
}

func TestAssistantNotesListRepository(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{repoNotes: []AssistantNoteView{
		anNote(anNoteID, "Two runs failed on this branch since lunch."),
	}}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content-type = %q, want json", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store", cc)
	}
	var list AssistantNoteList
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if len(list.Notes) != 1 || list.Notes[0].ID != anNoteID {
		t.Fatalf("notes = %+v, want the one served note", list.Notes)
	}
	body := decodeBody(t, rec)
	notes, ok := body["notes"].([]any)
	if !ok || len(notes) != 1 {
		t.Fatalf("notes member = %T, want a one-item array", body["notes"])
	}
	if store.gotRepo[0] != anProjectID+"/"+anRepoID {
		t.Errorf("store got %q, want the path's project/repository pair", store.gotRepo[0])
	}
	if store.lastCaller.UserID != testPrincipal().UserID {
		t.Errorf("store got caller %q, want the principal", store.lastCaller.UserID)
	}
}

// TestAssistantNotesListEmptyIsAnArray is the panel's rule stated as a
// contract: nothing to say is [], never a missing member a client has to
// distinguish from a bug.
func TestAssistantNotesListEmptyIsAnArray(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, target string }{
		{"repository", "http://localhost:8080/api/v1/projects/" + anProjectID + "/repos/" + anRepoID + "/notes"},
		{"conversation", "http://localhost:8080/api/v1/conversations/" + anConvID + "/notes"},
	} {
		srv := newAssistantNotesServer(t, &fakeAssistantNotes{})
		rec := do(t, srv, anGet(tc.target))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", tc.name, rec.Code, rec.Body)
		}
		if got := strings.TrimSpace(rec.Body.String()); !strings.HasPrefix(got, `{"notes":[]`) {
			t.Errorf("%s: body = %s, want an empty notes array", tc.name, got)
		}
	}
}

func TestAssistantNotesListConversation(t *testing.T) {
	t.Parallel()
	note := anNote(anNoteID, "Plan → implement → review. This could be a workflow.")
	note.ScopeKind = AssistantNoteScopeConversation
	note.ScopeID = anConvID
	note.Action = &AssistantNoteAction{Kind: AssistantNoteActionMakeWorkflow, ConversationID: anConvID}
	store := &fakeAssistantNotes{convNotes: []AssistantNoteView{note}}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/conversations/"+anConvID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	notes := body["notes"].([]any)
	if len(notes) != 1 {
		t.Fatalf("notes = %v, want one", notes)
	}
	view := notes[0].(map[string]any)
	action, ok := view["action"].(map[string]any)
	if !ok {
		t.Fatalf("action = %T, want the union object", view["action"])
	}
	if action["kind"] != AssistantNoteActionMakeWorkflow ||
		action["conversation_id"] != anConvID {
		t.Errorf("action = %v, want make_workflow with the thread's id", action)
	}
	// The members this kind does not own are absent, not null-and-empty: a
	// client switching on kind must not see a payload from another kind.
	for _, member := range []string{"prompt", "issue_numbers", "run_id"} {
		if _, present := action[member]; present {
			t.Errorf("action carries %q, which make_workflow does not own: %v", member, action)
		}
	}
	if _, present := view["dismissed_at"]; present {
		t.Errorf("view exposes dismissed_at: %v", view)
	}
	if store.gotConv[0] != anConvID {
		t.Errorf("store got conversation %q, want the path id", store.gotConv[0])
	}
}

// TestAssistantNotesScopeKindVocabulary pins the two names the union serves:
// the same strings migration 00027 CHECKs.
func TestAssistantNotesScopeKindVocabulary(t *testing.T) {
	t.Parallel()
	if AssistantNoteScopeRepository != "repository" || AssistantNoteScopeConversation != "conversation" {
		t.Errorf("scope vocabulary = %q/%q, must match the table's CHECK",
			AssistantNoteScopeRepository, AssistantNoteScopeConversation)
	}
	want := []string{"start_chat", "hand_off", "make_workflow", "open_run"}
	got := []string{AssistantNoteActionStartChat, AssistantNoteActionHandOff,
		AssistantNoteActionMakeWorkflow, AssistantNoteActionOpenRun}
	for i := range want {
		if want[i] != got[i] {
			t.Errorf("action kind %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestAssistantNotesActionValidation(t *testing.T) {
	t.Parallel()
	ok := func(a *AssistantNoteAction) {
		t.Helper()
		if err := a.Validate(); err != nil {
			t.Errorf("Validate(%+v) = %v, want it admitted", *a, err)
		}
	}
	refused := func(name string, a *AssistantNoteAction) {
		t.Helper()
		err := a.Validate()
		if !errors.Is(err, ErrAssistantNoteValidation) {
			t.Errorf("%s: Validate error = %v, want ErrAssistantNoteValidation", name, err)
			return
		}
		if !strings.Contains(err.Error(), "action") {
			t.Errorf("%s: error %q does not name the field", name, err)
		}
	}

	ok(&AssistantNoteAction{Kind: AssistantNoteActionStartChat, Prompt: "Why did this fail twice?"})
	ok(&AssistantNoteAction{Kind: AssistantNoteActionHandOff, IssueNumbers: []int{421, 7}})
	ok(&AssistantNoteAction{Kind: AssistantNoteActionMakeWorkflow, ConversationID: anConvID})
	ok(&AssistantNoteAction{Kind: AssistantNoteActionOpenRun, RunID: anNoteID})

	refused("unknown kind", &AssistantNoteAction{Kind: "close_everything"})
	refused("empty kind", &AssistantNoteAction{})
	refused("start_chat without a prompt", &AssistantNoteAction{Kind: AssistantNoteActionStartChat})
	refused("start_chat with a long prompt", &AssistantNoteAction{
		Kind: AssistantNoteActionStartChat, Prompt: strings.Repeat("p", AssistantNotePromptMaxChars+1)})
	refused("hand_off with no issues", &AssistantNoteAction{Kind: AssistantNoteActionHandOff})
	refused("hand_off with zero", &AssistantNoteAction{Kind: AssistantNoteActionHandOff, IssueNumbers: []int{0}})
	refused("hand_off with a repeat", &AssistantNoteAction{Kind: AssistantNoteActionHandOff, IssueNumbers: []int{3, 3}})
	refused("hand_off with too many", &AssistantNoteAction{
		Kind: AssistantNoteActionHandOff, IssueNumbers: intsUpTo(AssistantNoteHandOffMaxIssues + 1)})
	refused("make_workflow without a thread", &AssistantNoteAction{Kind: AssistantNoteActionMakeWorkflow})
	refused("make_workflow with a name", &AssistantNoteAction{
		Kind: AssistantNoteActionMakeWorkflow, ConversationID: "the-ones-vs-celtics"})
	refused("open_run without a run", &AssistantNoteAction{Kind: AssistantNoteActionOpenRun})
	// A payload from another kind does not ride along, in either direction.
	refused("open_run with a prompt", &AssistantNoteAction{
		Kind: AssistantNoteActionOpenRun, RunID: anNoteID, Prompt: "smuggled"})
	refused("make_workflow with a run", &AssistantNoteAction{
		Kind: AssistantNoteActionMakeWorkflow, ConversationID: anConvID, RunID: anNoteID})
	refused("hand_off with a run", &AssistantNoteAction{
		Kind: AssistantNoteActionHandOff, IssueNumbers: []int{1}, RunID: anNoteID})
	refused("start_chat with issues", &AssistantNoteAction{
		Kind: AssistantNoteActionStartChat, Prompt: "hi", IssueNumbers: []int{1}})
}

func TestAssistantNoteInputValidation(t *testing.T) {
	t.Parallel()
	base := func() AssistantNoteInput {
		return AssistantNoteInput{
			ProjectID: anProjectID, UserID: anNoteID, ScopeID: anRepoID,
			ScopeKind: AssistantNoteScopeRepository, Text: "Two runs failed since lunch.",
		}
	}
	if err := base().Validate(); err != nil {
		t.Fatalf("Validate(good input) = %v", err)
	}
	refused := func(name string, want string, mutate func(*AssistantNoteInput)) {
		t.Helper()
		in := base()
		mutate(&in)
		err := in.Validate()
		if !errors.Is(err, ErrAssistantNoteValidation) {
			t.Errorf("%s: error = %v, want ErrAssistantNoteValidation", name, err)
			return
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%s: error = %q, want it to name %q", name, err, want)
		}
	}
	refused("blank text", "text", func(in *AssistantNoteInput) { in.Text = "" })
	refused("long text", "text", func(in *AssistantNoteInput) {
		in.Text = strings.Repeat("长", AssistantNoteTextMaxChars+1)
	})
	refused("unknown scope", "scope_kind", func(in *AssistantNoteInput) { in.ScopeKind = "organization" })
	refused("bad project", "project_id", func(in *AssistantNoteInput) { in.ProjectID = "northwind" })
	refused("bad scope id", "scope_id", func(in *AssistantNoteInput) { in.ScopeID = "storefront" })
	refused("bad user", "user_id", func(in *AssistantNoteInput) { in.UserID = "dana" })
	refused("bad action", "action.kind", func(in *AssistantNoteInput) {
		in.Action = &AssistantNoteAction{Kind: "whatever"}
	})

	// A past deadline is admitted: it is legal, simply never served, and a
	// generator must be able to write (and be tested on) a note that was
	// already stale when it was produced.
	past := time.Now().Add(-time.Hour)
	in := base()
	in.ExpiresAt = &past
	if err := in.Validate(); err != nil {
		t.Errorf("Validate(past expires_at) = %v, want it admitted", err)
	}
}

// TestAssistantNotesTextBoundIsCharactersNotBytes is the 280 rule the table
// and this layer agree on: a sentence of 280 multi-byte characters is one
// sentence, and 281 is not.
func TestAssistantNotesTextBoundIsCharactersNotBytes(t *testing.T) {
	t.Parallel()
	in := AssistantNoteInput{
		ProjectID: anProjectID, UserID: anNoteID, ScopeID: anRepoID,
		ScopeKind: AssistantNoteScopeConversation,
	}
	in.Text = strings.Repeat("é", AssistantNoteTextMaxChars)
	if err := in.Validate(); err != nil {
		t.Errorf("%d characters (%d bytes) refused: %v",
			AssistantNoteTextMaxChars, len(in.Text), err)
	}
	in.Text += "x"
	if err := in.Validate(); !errors.Is(err, ErrAssistantNoteValidation) {
		t.Errorf("%d characters error = %v, want ErrAssistantNoteValidation",
			AssistantNoteTextMaxChars+1, err)
	}
}

func TestAssistantNotesDismiss(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, anDismiss("http://localhost:8080/api/v1/notes/"+anNoteID+"/dismiss"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Errorf("204 carried a body: %q", rec.Body.String())
	}
	if len(store.dismissCalls) != 1 || store.dismissCalls[0] != anNoteID {
		t.Errorf("store got %v, want the one path id", store.dismissCalls)
	}
	if store.lastCaller.UserID != testPrincipal().UserID {
		t.Errorf("store got caller %q, want the principal — dismissal is per user",
			store.lastCaller.UserID)
	}
}

// TestAssistantNotesDismissIsNeverToldWhy is the leak rule: a note that is
// somebody else's, already gone, or never there are one answer, and it is
// 404 — a 403 would confirm another user was advised.
func TestAssistantNotesDismissIsNeverToldWhy(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{dismissErr: ErrAssistantNoteNotFound}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, anDismiss("http://localhost:8080/api/v1/notes/"+anNoteID+"/dismiss"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if p.Status != http.StatusNotFound || !strings.Contains(p.Detail, "not yours") {
		t.Errorf("problem = %+v, want a 404 that says both halves", p)
	}
	if strings.Contains(strings.ToLower(p.Detail), "forbidden") ||
		strings.Contains(p.Detail, "another user") {
		t.Errorf("problem %q discloses more than \"no such note\"", p.Detail)
	}
}

func TestAssistantNotesScopeAuthzIsFourOhFour(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, target string
		store        *fakeAssistantNotes
	}{
		{"repository", "http://localhost:8080/api/v1/projects/" + anProjectID + "/repos/" + anRepoID + "/notes",
			&fakeAssistantNotes{err: ErrProjectNotFound}},
		{"conversation", "http://localhost:8080/api/v1/conversations/" + anConvID + "/notes",
			&fakeAssistantNotes{err: ErrProjectNotFound}},
	} {
		srv := newAssistantNotesServer(t, tc.store)
		rec := do(t, srv, anGet(tc.target))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404 (body %s)", tc.name, rec.Code, rec.Body)
		}
		// The answer is the shared one: no ids, no shape, no count. A caller
		// who guessed the project right and the membership wrong learns the
		// same nothing as one who guessed both wrong.
		body := strings.TrimSpace(rec.Body.String())
		p := decodeProblem(t, rec)
		if p.Status != http.StatusNotFound || p.Title != "Not Found" {
			t.Errorf("%s: problem = %+v, want the shared 404", tc.name, p)
		}
		for _, id := range []string{anProjectID, anRepoID, anConvID} {
			if strings.Contains(body, id) {
				t.Errorf("%s: 404 body %q echoes %s", tc.name, body, id)
			}
		}
	}
}

func TestAssistantNotesMalformedIDsAre422(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{}
	srv := newAssistantNotesServer(t, store)
	for _, target := range []string{
		"http://localhost:8080/api/v1/projects/not-a-uuid/repos/" + anRepoID + "/notes",
		"http://localhost:8080/api/v1/projects/" + anProjectID + "/repos/storefront/notes",
		"http://localhost:8080/api/v1/conversations/the-ones-vs-celtics/notes",
	} {
		rec := do(t, srv, anGet(target))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("GET %s: status = %d, want 422 (body %s)", target, rec.Code, rec.Body)
		}
	}
	if len(store.gotRepo)+len(store.gotConv) != 0 {
		t.Errorf("store was asked %v times before validation, want 0",
			len(store.gotRepo)+len(store.gotConv))
	}
	// A malformed note id is refused the same way, and never reaches a write.
	rec := do(t, srv, anDismiss("http://localhost:8080/api/v1/notes/all-the-notes/dismiss"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("dismiss status = %d, want 422 (body %s)", rec.Code, rec.Body)
	}
	if len(store.dismissCalls) != 0 {
		t.Errorf("dismiss reached the store (%v), want it refused here", store.dismissCalls)
	}
}

func TestAssistantNotesStoreFailureIsFiveHundred(t *testing.T) {
	t.Parallel()
	srv := newAssistantNotesServer(t, &fakeAssistantNotes{err: errStoreDown})
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "pool:") {
		t.Errorf("500 body %q leaks the store error", rec.Body.String())
	}
}

// TestAssistantNotesRoutesNeedASession proves the mounts went through
// HandleAuthed rather than Handle: the answer for an anonymous caller is the
// 401 the rest of the surface gives, and no store is consulted.
func TestAssistantNotesRoutesNeedASession(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{}
	srv := newTestServerWith(t,
		Config{ReplicaName: "replica-a", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1},
		principalAuth(nil, ErrUnauthenticated))
	RegisterAssistantNotes(srv, store)
	for _, r := range []*http.Request{
		anGet("http://localhost:8080/api/v1/projects/" + anProjectID + "/repos/" + anRepoID + "/notes"),
		anGet("http://localhost:8080/api/v1/conversations/" + anConvID + "/notes"),
		anDismiss("http://localhost:8080/api/v1/notes/" + anNoteID + "/dismiss"),
	} {
		rec := do(t, srv, r)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401 (body %s)", r.Method, r.URL.Path, rec.Code, rec.Body)
		}
	}
	if len(store.gotRepo)+len(store.gotConv)+len(store.dismissCalls) != 0 {
		t.Error("anonymous requests reached the store")
	}
}

// TestAssistantNotesDismissNeedsCSRF is the mutation half of the same gate.
func TestAssistantNotesDismissNeedsCSRF(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, request(http.MethodPost,
		"http://localhost:8080/api/v1/notes/"+anNoteID+"/dismiss", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	if len(store.dismissCalls) != 0 {
		t.Errorf("a CSRF-less dismiss reached the store (%v)", store.dismissCalls)
	}
}

// TestAssistantNotesActionJSONRoundTrip is the wire shape of the union: one
// kind, only its own member, and nothing else — the client-side mirror of
// what Validate admits, and what openapi.yaml's oneOf describes.
func TestAssistantNotesActionJSONRoundTrip(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, want string
		action     AssistantNoteAction
	}{
		{"start_chat", `{"kind":"start_chat","prompt":"why?"}`,
			AssistantNoteAction{Kind: AssistantNoteActionStartChat, Prompt: "why?"}},
		{"hand_off", `{"kind":"hand_off","issue_numbers":[421,7]}`,
			AssistantNoteAction{Kind: AssistantNoteActionHandOff, IssueNumbers: []int{421, 7}}},
		{"make_workflow", `{"kind":"make_workflow","conversation_id":"` + anConvID + `"}`,
			AssistantNoteAction{Kind: AssistantNoteActionMakeWorkflow, ConversationID: anConvID}},
		{"open_run", `{"kind":"open_run","run_id":"` + anNoteID + `"}`,
			AssistantNoteAction{Kind: AssistantNoteActionOpenRun, RunID: anNoteID}},
	} {
		raw, err := json.Marshal(tc.action)
		if err != nil {
			t.Fatalf("%s: marshal: %v", tc.name, err)
		}
		if string(raw) != tc.want {
			t.Errorf("%s: json = %s, want %s", tc.name, raw, tc.want)
		}
		var back AssistantNoteAction
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&back); err != nil {
			t.Fatalf("%s: decode: %v", tc.name, err)
		}
		if err := back.Validate(); err != nil {
			t.Errorf("%s: round-tripped action invalid: %v", tc.name, err)
		}
	}
}

func intsUpTo(n int) []int {
	out := make([]int, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, i)
	}
	return out
}
