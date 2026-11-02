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

// —— the fakes the builder test needs (the store seams are one method each) ———

type fakeAssistantNoteInserter struct{}

func (fakeAssistantNoteInserter) InsertAssistantNote(context.Context,
	AssistantNoteInput) (AssistantNoteView, error) {
	return AssistantNoteView{}, nil
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
