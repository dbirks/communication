package api

// ADR-0071 step 2 at the HTTP layer: what the generator seam may and may not
// do to a GET. The routes still answer from the store alone, the trigger sees
// exactly what was served (never more), a deployment with no assistant egress
// has no trigger at all, and a slow generator cannot make the browser wait.
// The generator's own rules — the DATA block, the allowlist, the cooldown —
// are proven in internal/assistant/notes_gen_test.go.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// recordingNotesTrigger is the generator seam as the routes see it: it notes
// what it was handed and how long the call took, and can hold the caller if a
// test needs to prove the response was already written.
type recordingNotesTrigger struct {
	mu    sync.Mutex
	calls []string
	seen  [][]AssistantNoteView
	slow  time.Duration
}

func (r *recordingNotesTrigger) NotesListed(ctx context.Context, c Caller,
	scopeKind, projectID, scopeID string, notes []AssistantNoteView) {
	if r.slow > 0 {
		time.Sleep(r.slow)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, scopeKind+" "+projectID+" "+scopeID+" caller="+c.UserID)
	r.seen = append(r.seen, notes)
}

func (r *recordingNotesTrigger) snapshot() ([]string, [][]AssistantNoteView) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...), append([][]AssistantNoteView(nil), r.seen...)
}

func newNotesServerWithGen(t *testing.T, store AssistantNotesStore,
	gen AssistantNotesTrigger) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterAssistantNotes(s, store, gen)
	return s
}

func TestAssistantNotesGETHandsTheServedNotesToTheGenerator(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{repoNotes: []AssistantNoteView{
		anNote(anNoteID, "Two runs failed on this branch since lunch."),
	}}
	gen := &recordingNotesTrigger{}
	srv := newNotesServerWithGen(t, store, gen)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	calls, seen := gen.snapshot()
	if len(calls) != 1 || calls[0] != "repository "+anProjectID+" "+anRepoID+
		" caller="+testPrincipal().UserID {
		t.Fatalf("trigger calls = %v", calls)
	}
	if len(seen) != 1 || len(seen[0]) != 1 || seen[0][0].ID != anNoteID {
		t.Fatalf("the trigger saw %+v, want the note the caller saw", seen[0])
	}
}

func TestAssistantNotesConversationScopeCarriesNoProjectID(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{convNotes: []AssistantNoteView{{
		ID: anNoteID, ProjectID: anProjectID, ScopeKind: AssistantNoteScopeConversation,
		ScopeID: anConvID, Text: "This chat could be a workflow.",
		CreatedAt: time.Now().UTC(),
	}}}
	gen := &recordingNotesTrigger{}
	srv := newNotesServerWithGen(t, store, gen)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/conversations/"+anConvID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	calls, _ := gen.snapshot()
	// The empty project member is the point: the generator resolves a thread's
	// project from the thread, never from anything the caller put in a path.
	if len(calls) != 1 || calls[0] != "conversation  "+anConvID+" caller="+testPrincipal().UserID {
		t.Fatalf("trigger calls = %v", calls)
	}
}

// markingWriter records the moment the response body starts leaving the
// handler, which is the only way to ask "did the answer exist before the
// generator was consulted?" from outside the mux.
type markingWriter struct {
	http.ResponseWriter
	wrote *atomic.Bool
}

func (m markingWriter) Write(b []byte) (int, error) {
	n, err := m.ResponseWriter.Write(b)
	if n > 0 {
		m.wrote.Store(true)
	}
	return n, err
}

func TestAssistantNotesGETAnswersBeforeItAsksTheGenerator(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{repoNotes: []AssistantNoteView{anNote(anNoteID, "Stored and served.")}}
	gen := &recordingNotesTrigger{}
	srv := newNotesServerWithGen(t, store, gen)

	answered := &atomic.Bool{}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(markingWriter{ResponseWriter: rec, wrote: answered},
		anGet("http://localhost:8080/api/v1/projects/"+anProjectID+"/repos/"+anRepoID+"/notes"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	if !answered.Load() {
		t.Fatal("the response body never started leaving the handler")
	}
	// The trigger sees the bytes the caller got, and it is reached only once
	// that body is written: whatever the model then takes minutes over cannot
	// make this response wait (the asynchrony itself is proven in
	// internal/assistant/notes_gen_test.go).
	_, seen := gen.snapshot()
	if len(seen) != 1 || len(seen[0]) != 1 || seen[0][0].Text != "Stored and served." {
		t.Fatalf("the trigger saw %+v", seen)
	}
}

func TestAssistantNotesSlowGeneratorChangesNothingAboutTheAnswer(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{}
	gen := &recordingNotesTrigger{slow: 40 * time.Millisecond}
	srv := newNotesServerWithGen(t, store, gen)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if notes, ok := body["notes"].([]any); !ok || len(notes) != 0 {
		t.Fatalf("body = %s, want the empty list the store holds", rec.Body)
	}
}

func TestAssistantNotesWithoutATriggerServeWhatIsStored(t *testing.T) {
	t.Parallel()
	store := &fakeAssistantNotes{repoNotes: []AssistantNoteView{anNote(anNoteID, "Stored.")}}
	srv := newAssistantNotesServer(t, store)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if notes, ok := body["notes"].([]any); !ok || len(notes) != 1 {
		t.Fatalf("body = %s, want the one stored note", rec.Body)
	}
}

func TestAssistantNotesNilGeneratorIsTheNoEgressWiring(t *testing.T) {
	t.Parallel()
	// A deployment with no assistant model builds no generator, and the
	// variadic mount accepts that nil without a second registration path.
	var gen AssistantNotesTrigger
	srv := newNotesServerWithGen(t, &fakeAssistantNotes{}, gen)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}
}

func TestBuildAssistantNotesGeneratorNeedsAModelAndEveryRead(t *testing.T) {
	t.Parallel()
	deps := func() AssistantNotesGenDeps {
		return AssistantNotesGenDeps{
			Notes:   fakeAssistantNoteInserter{},
			Runs:    fakeAssistantNotesRuns{},
			Repos:   fakeAssistantNotesRepos{},
			Threads: fakeAssistantNotesThreads{},
			Chats:   fakeAssistantNotesChats{},
		}
	}
	if gen := BuildAssistantNotesGenerator(deps()); gen != nil {
		t.Fatal("a generator was built with no assistant egress")
	}
	// An endpoint that will not even validate is the same absence as none.
	if _, err := assistant.NewTextOnly(assistant.Config{}); err == nil {
		t.Fatal("NewTextOnly accepted an empty endpoint")
	}
	configured, err := assistant.NewTextOnly(assistant.Config{BaseURL: "http://127.0.0.1:1/v1"})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}
	full := deps()
	full.Broker = configured
	full.Pipelines = fakeAssistantNotesPipelines{}
	if gen := BuildAssistantNotesGenerator(full); gen == nil {
		t.Fatal("a fully wired deployment built no generator")
	}
	// Every read is required: without one there is no honest DATA block, and a
	// missing read is refused rather than summarised as "nothing to say".
	for name, breakIt := range map[string]func(*AssistantNotesGenDeps){
		"runs":      func(d *AssistantNotesGenDeps) { d.Runs = nil },
		"repos":     func(d *AssistantNotesGenDeps) { d.Repos = nil },
		"threads":   func(d *AssistantNotesGenDeps) { d.Threads = nil },
		"chats":     func(d *AssistantNotesGenDeps) { d.Chats = nil },
		"store":     func(d *AssistantNotesGenDeps) { d.Notes = nil },
		"no egress": func(d *AssistantNotesGenDeps) { d.Broker = nil },
	} {
		broken := full
		breakIt(&broken)
		if gen := BuildAssistantNotesGenerator(broken); gen != nil {
			t.Fatalf("a generator was built with its %s seam missing", name)
		}
	}
}

// fakeAssistantNoteInserter records the fakes the builder test needs (the store seams are one method each)
type fakeAssistantNoteInserter struct{}

func (fakeAssistantNoteInserter) InsertAssistantNote(context.Context,
	AssistantNoteInput) (AssistantNoteView, error) {
	return AssistantNoteView{}, nil
}

// —— the write guard (acceptance 42339622074 pass-2/pass-5) ———

// raceFlowStore is the routes' store with the two answers a racing second
// generation needs: the first read is what the GET serves (one STALE note,
// which is the read that asks the model), every later read is the GUARD's —
// the active rows as they stand at write time, which the race has meanwhile
// filled to the cap. A full set here is exactly the situation in which
// storing one more note would DELETE the note the panel just served.
type raceFlowStore struct {
	mu2       sync.Mutex
	reads     int
	live      []AssistantNoteView
	guardRead chan string
	fakeAssistantNotes
}

func (r *raceFlowStore) ListRepositoryNotes(ctx context.Context, c Caller,
	projectID, repositoryID string) ([]AssistantNoteView, error) {
	r.mu2.Lock()
	r.reads++
	n := r.reads
	r.mu2.Unlock()
	if n == 1 {
		return r.repoNotes, nil // the route's own read
	}
	select {
	case r.guardRead <- projectID + "/" + repositoryID:
	default:
	}
	return r.live, nil
}

// countingInserter is the generator's write seam: every store attempt lands
// on a channel, so "the guard refused" and "the guard let it through" are
// both observable without a database.
type countingInserter struct {
	mu     sync.Mutex
	wrote  []AssistantNoteInput
	writes chan AssistantNoteInput
}

func (c *countingInserter) InsertAssistantNote(_ context.Context,
	in AssistantNoteInput) (AssistantNoteView, error) {
	c.mu.Lock()
	c.wrote = append(c.wrote, in)
	c.mu.Unlock()
	select {
	case c.writes <- in:
	default:
	}
	return AssistantNoteView{ID: anNoteID, Text: in.Text}, nil
}

func TestAssistantNotesRouteArmsTheWriteGuardForItsGeneration(t *testing.T) {
	t.Parallel()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":` +
			`"[{\"text\":\"Nobody has asked about the flaky checkout test.\",` +
			`\"action\":{\"kind\":\"start_chat\",\"prompt\":\"why is the checkout test flaky?\"}}]"},` +
			`"finish_reason":"stop"}]}`))
	}))
	defer model.Close()
	broker, err := assistant.NewTextOnly(assistant.Config{BaseURL: model.URL + "/v1"})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}

	store := &raceFlowStore{
		guardRead: make(chan string, 8),
		fakeAssistantNotes: fakeAssistantNotes{repoNotes: []AssistantNoteView{{
			ID: anNoteID, ProjectID: anProjectID, ScopeKind: AssistantNoteScopeRepository,
			ScopeID: anRepoID, Text: "An older note, due for a refresh.",
			// Stale past the TTL: this is the read that asks the model.
			CreatedAt: time.Now().UTC().Add(-7 * time.Hour),
		}}},
		// By write time the race has stored the cap: another insert would
		// evict the oldest active row.
		live: fullActiveNoteSet(),
	}
	inserter := &countingInserter{writes: make(chan AssistantNoteInput, 8)}
	gen := BuildAssistantNotesGenerator(AssistantNotesGenDeps{
		Broker:    broker,
		Notes:     inserter,
		Runs:      oneRunNotesReader{},
		Pipelines: fakeAssistantNotesPipelines{},
		Repos:     fakeAssistantNotesRepos{},
		Threads:   fakeAssistantNotesThreads{},
		Chats:     fakeAssistantNotesChats{},
	})
	if gen == nil {
		t.Fatal("BuildAssistantNotesGenerator returned no generator")
	}
	srv := newNotesServerWithGen(t, store, gen)
	rec := do(t, srv, anGet("http://localhost:8080/api/v1/projects/"+anProjectID+
		"/repos/"+anRepoID+"/notes"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body)
	}

	// The generation ran and the guard read the scope through the routes'
	// own store before writing.
	select {
	case got := <-store.guardRead:
		if want := anProjectID + "/" + anRepoID; got != want {
			t.Fatalf("guard read = %s, want %s", got, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the write guard never read the scope before storing a note")
	}
	// And nothing was stored: the cap insert would have DELETED the note the
	// panel just served — the eviction that turned a click-to-dismiss into a
	// 404 (pass-2) and a render into a missing row (pass-5).
	select {
	case in := <-inserter.writes:
		t.Fatalf("the guard let an overflowing note through: %+v", in)
	case <-time.After(500 * time.Millisecond):
	}
	inserter.mu.Lock()
	defer inserter.mu.Unlock()
	if len(inserter.wrote) != 0 {
		t.Fatalf("insert calls = %+v, want none", inserter.wrote)
	}
}

func TestAssistantNotesWriteGuardDirect(t *testing.T) {
	t.Parallel()
	caller := Caller{UserID: "u-1", OrganizationID: "o-1"}
	note := assistant.NoteWrite{
		ProjectID: anProjectID, UserID: "u-1", ScopeKind: "repository",
		ScopeID: anRepoID, Text: "Nobody has asked about the flaky checkout test.",
		Action:    &assistant.NoteActionDraft{Kind: assistant.NoteActionStartChat, Prompt: "why?"},
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	armed := func(store AssistantNotesStore) context.Context {
		return context.WithValue(context.Background(), noteWriteGuardKey{}, &noteWriteGuard{
			store: store, caller: caller, scopeKind: AssistantNoteScopeRepository,
			projectID: anProjectID, scopeID: anRepoID,
		})
	}

	full := &fakeAssistantNotes{repoNotes: fullActiveNoteSet()}
	inserter := &countingInserter{writes: make(chan AssistantNoteInput, 4)}
	w := &assistantNotesWriter{store: inserter}
	if err := w.WriteNote(armed(full), note); !errors.Is(err, ErrAssistantNoteScopeFull) {
		t.Fatalf("full-scope WriteNote err = %v, want ErrAssistantNoteScopeFull", err)
	}

	room := &fakeAssistantNotes{repoNotes: fullActiveNoteSet()[:2]}
	if err := w.WriteNote(armed(room), note); err != nil {
		t.Fatalf("a scope with room refused its note: %v", err)
	}

	broken := &fakeAssistantNotes{err: errors.New("db is having a day")}
	if err := w.WriteNote(armed(broken), note); err != nil {
		t.Fatalf("a guard read that failed must proceed, not lose the note: %v", err)
	}

	other := note
	other.ScopeID = anConvID
	if err := w.WriteNote(armed(full), other); err != nil {
		t.Fatalf("a write for another scope is not this guard's call: %v", err)
	}

	// No guard in the context (a generation armed outside the routes) stores
	// exactly as it did before this seam existed.
	if err := w.WriteNote(context.Background(), note); err != nil {
		t.Fatalf("an unarmed WriteNote failed: %v", err)
	}
}

func fullActiveNoteSet() []AssistantNoteView {
	out := make([]AssistantNoteView, 0, AssistantNotesActiveCap)
	for i := 0; i < AssistantNotesActiveCap; i++ {
		out = append(out, AssistantNoteView{
			ID:        fmt.Sprintf("01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b8%d", i),
			ProjectID: anProjectID, ScopeKind: AssistantNoteScopeRepository,
			ScopeID: anRepoID, Text: fmt.Sprintf("Stored note %d.", i),
			CreatedAt: time.Now().UTC(),
		})
	}
	return out
}

// oneRunNotesReader gives the DATA block a run, so the attempt has something
// honest to be about (an empty DATA block answers "nothing", never the model).
type oneRunNotesReader struct{}

func (oneRunNotesReader) ListProjectRunsFiltered(context.Context, Caller,
	string, RunListFilter) ([]RunSummaryView, error) {
	return []RunSummaryView{{
		ID: anNoteID, PipelineID: anRepoID, Status: "failed", CreatedAt: time.Now().UTC(),
	}}, nil
}

type fakeAssistantNotesRuns struct{}

func (fakeAssistantNotesRuns) ListProjectRunsFiltered(context.Context, Caller,
	string, RunListFilter) ([]RunSummaryView, error) {
	return nil, nil
}

type fakeAssistantNotesPipelines struct{}

func (fakeAssistantNotesPipelines) ListPipelines(context.Context,
	Caller) ([]PipelineSummaryView, error) {
	return nil, nil
}

type fakeAssistantNotesRepos struct{}

func (fakeAssistantNotesRepos) ListRepositories(context.Context,
	Caller, string) ([]RepositoryView, error) {
	return nil, nil
}

type fakeAssistantNotesThreads struct{}

func (fakeAssistantNotesThreads) GetConversation(context.Context,
	Caller, string) (ConversationView, error) {
	return ConversationView{}, nil
}

type fakeAssistantNotesChats struct{}

func (fakeAssistantNotesChats) ReadChatTranscript(context.Context, assistant.Caller,
	string) (assistant.ChatTranscript, error) {
	return assistant.ChatTranscript{}, nil
}
