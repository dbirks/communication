package assistant

// The deployed exercise's finding F-2 (docs/testing/assistant-exercise-2026-11-11.md):
// nothing the assistant could call listed the caller's agent THREADS, so
// "What did Pi do in the Sandbox project?" was answered "no Pi activity" about
// a project whose two most recent visible artefacts were Pi threads. thread.list
// closes that hole, and these tests pin the four rules that make it safe:
//
//   - it is announced ONLY over a store that answers ThreadListReader, and an
//     unannounced thread.list is unreachable (zero store calls, the same
//     `unknown_tool` refusal an invented name gets);
//   - membership is the read's rule AND the tool's: a thread under a project the
//     caller cannot list contributes no row even if the read ever returned one,
//     and the caller's identity is the one the read is made with;
//   - `launcher` filters through the agent profile behind the thread, and a
//     profile the caller cannot read matches no launcher;
//   - the answer is at most 30 threads, newest first, and its status words are
//     the /threads page's own (finding F-7).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- the fake: the caller's threads, scoped per caller ---------------------

// threadStore answers the thread read with rows keyed by caller, so a test can
// prove the tool asked AS the caller and that a project outside that caller's
// memberships contributes nothing.
type threadStore struct {
	mu sync.Mutex

	projects  json.RawMessage
	profiles  json.RawMessage
	threads   map[string]json.RawMessage
	threadsAs []Caller
	threadsN  int
}

func newThreadStore() *threadStore {
	return &threadStore{
		projects: json.RawMessage(`[{"id":"p-1","name":"Sandbox"},{"id":"p-2","name":"Other"}]`),
		profiles: json.RawMessage(`[{"id":"prof-pi","name":"Pi","launcher_id":"pi"},
			{"id":"prof-claude","name":"Claude Code","launcher_id":"claude"}]`),
		threads: map[string]json.RawMessage{},
	}
}

// withThreads stages the rows ListAgentThreads answers with for one caller.
func (s *threadStore) withThreads(c Caller, rows string) *threadStore {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.threads[c.UserID] = json.RawMessage(rows)
	return s
}

func (s *threadStore) ListProjects(_ context.Context, _ Caller) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.projects, nil
}

func (s *threadStore) ListAgentProfiles(_ context.Context, _ Caller) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profiles, nil
}

func (s *threadStore) ListPipelines(context.Context, Caller) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}
func (s *threadStore) ListProjectRuns(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}
func (s *threadStore) ListRunNodes(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}
func (s *threadStore) ListProjectApprovals(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}
func (s *threadStore) ListPipelineRevisions(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

// ListAgentThreads is the optional face: the cross-project thread list, exactly
// as the route scopes it to the caller it was called with.
func (s *threadStore) ListAgentThreads(_ context.Context, c Caller) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.threadsAs = append(s.threadsAs, c)
	s.threadsN++
	if raw, ok := s.threads[c.UserID]; ok {
		return raw, nil
	}
	return json.RawMessage(`[]`), nil
}

// askedAs reports the callers the thread read saw.
func (s *threadStore) askedAs() []Caller {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Caller(nil), s.threadsAs...)
}

// threadRow is one wire row in the shape GET /api/v1/conversations serves.
func threadRow(id, project, profile, title, status string, active bool, updated string) string {
	return fmt.Sprintf(`{"id":%q,"project_id":%q,"agent_profile_id":%q,"title":%q,"status":%q,`+
		`"has_active_turn":%v,"origin":"manual","updated_at":%q,"created_at":%q}`,
		id, project, profile, title, status, active, updated, updated)
}

// --- announcement ----------------------------------------------------------

// TestThreadListAnnouncedOnlyWhenTheStoreAnswersIt is the honest-degradation
// rule applied to the new read.
func TestThreadListAnnouncedOnlyWhenTheStoreAnswersIt(t *testing.T) {
	plain := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), newFakeStore())
	for _, spec := range plain.toolSpecs() {
		if spec.Function.Name == wireName("thread.list") {
			t.Fatal("thread.list was announced over a store that cannot list threads")
		}
	}
	tr := &turn{b: plain, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("thread.list", nil))
	if len(tr.calls) != 1 || tr.calls[0].OK || tr.calls[0].Reason != "unknown_tool" {
		t.Fatalf("unannounced call = %+v, want the unknown_tool refusal", tr.calls)
	}
	if inner, ok := plain.store.(*fakeStore); ok && inner.count("project.list") != 0 {
		t.Fatal("an unannounced read reached the store")
	}

	briefing := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), newChatStore())
	for _, spec := range briefing.toolSpecs() {
		if spec.Function.Name == wireName("thread.list") {
			t.Fatal("thread.list was announced over a store with only the brief reader")
		}
	}

	store := newThreadStore()
	b := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), store)
	found := ""
	for _, spec := range b.toolSpecs() {
		if spec.Function.Name == wireName("thread.list") {
			found = spec.Function.Description
		}
	}
	if found == "" {
		t.Fatalf("thread.list missing from %v", b.toolSpecs())
	}
	// F-2's wording and F-7's vocabulary: thread, agent, and when to use it.
	for _, want := range []string{"agent threads", "what did", "what threads are running", "Read-only"} {
		if !strings.Contains(found, want) {
			t.Fatalf("the announced description must say %q; it says %q", want, found)
		}
	}
}

// --- membership ------------------------------------------------------------

// TestThreadListIsScopedToTheCaller proves the two halves of the membership
// rule: the read is made with the CALLER's identity, and a thread under a
// project that caller cannot list is dropped even if the read handed it over.
func TestThreadListIsScopedToTheCaller(t *testing.T) {
	visible := newThreadStore()
	visible.withThreads(testCaller, "["+
		threadRow("t-1", "p-1", "prof-pi", "Fix the flaky test", "idle", true, recentAt(240))+"]")
	visible.withThreads(Caller{UserID: "user-2", OrganizationID: "org-1"}, "[]")

	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), visible)
	payload, call := runToolOnce(t, b, "thread.list", nil)
	if !call.OK {
		t.Fatalf("thread.list refused: %+v", call)
	}
	got := rows(payload)
	if len(got) != 1 || field(got[0], "id") != "t-1" {
		t.Fatalf("rows = %s, want the caller's one thread", payload)
	}
	asked := visible.askedAs()
	if len(asked) != 1 || asked[0].UserID != testCaller.UserID {
		t.Fatalf("the thread read ran as %+v, want the caller %+v", asked, testCaller)
	}
	// A second caller is answered from THEIR OWN rows: an empty list, not the
	// first caller's thread.
	other := &turn{b: b, ctx: context.Background(), caller: Caller{UserID: "user-2", OrganizationID: "org-1"}}
	other.exec(toolCall("thread.list", nil))
	if n := len(rows(other.results[0].payload)); n != 0 {
		t.Fatalf("the second caller saw %d rows, want 0 — the read leaked a row across callers", n)
	}

	// And a thread under a project the caller's project list does not name is
	// dropped, named nothing.
	hid := newThreadStore()
	hid.projects = json.RawMessage(`[{"id":"p-1","name":"Sandbox"}]`)
	hid.withThreads(testCaller, "["+
		threadRow("t-1", "p-1", "prof-pi", "Mine", "idle", false, recentAt(240))+","+
		threadRow("t-secret", "p-hidden", "prof-pi", "Not yours", "active", true, recentAt(180))+"]")
	hb := newTestBroker(t, newFakeModel(t, step{text: "x"}), hid)
	payload, call = runToolOnce(t, hb, "thread.list", nil)
	if !call.OK {
		t.Fatalf("thread.list refused: %+v", call)
	}
	if s := string(payload); strings.Contains(s, "t-secret") || strings.Contains(s, "Not yours") {
		t.Fatalf("a thread under an invisible project rode the payload: %s", s)
	}
	if n := len(rows(payload)); n != 1 {
		t.Fatalf("rows = %s, want only the visible project's thread", payload)
	}
}

// --- the launcher filter ---------------------------------------------------

// TestThreadListLauncherFilter is F-2's launcher argument: one agent's threads,
// matched through the agent PROFILE behind each thread (the wire row names a
// profile id, never a launcher), and a profile the caller cannot read matches
// no launcher at all.
func TestThreadListLauncherFilter(t *testing.T) {
	store := newThreadStore()
	store.withThreads(testCaller, "["+
		threadRow("t-pi", "p-1", "prof-pi", "Pi worked here", "idle", false, recentAt(240))+","+
		threadRow("t-claude", "p-1", "prof-claude", "Claude worked here", "active", true, recentAt(180))+","+
		threadRow("t-none", "p-1", "", "No profile", "idle", false, recentAt(120))+","+
		threadRow("t-ghost", "p-1", "prof-gone", "Unreadable profile", "idle", false, recentAt(60))+"]")
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "thread.list", map[string]any{"launcher": "PI"})
	if !call.OK {
		t.Fatalf("thread.list refused: %+v", call)
	}
	got := rows(payload)
	if len(got) != 1 || field(got[0], "id") != "t-pi" {
		t.Fatalf("launcher=PI rows = %s, want only the Pi thread", payload)
	}
	if field(got[0], "agent_profile") != "Pi" || field(got[0], "launcher") != "pi" {
		t.Fatalf("the row names no profile/launcher: %s", payload)
	}
	if !strings.Contains(strings.ToLower(call.Summary), "pi") || !strings.Contains(call.Summary, "threads") {
		t.Fatalf("the transparency line does not name the filter: %q", call.Summary)
	}
	// F-7: the disclosure line says THREAD, the word the /threads page uses.
	if strings.Contains(strings.ToLower(call.Summary), "runs") {
		t.Fatalf("the thread answer's transparency line calls them runs: %q", call.Summary)
	}

	// project_id narrows the same way, and an outside project is an empty
	// answer rather than a name (the 404 rule of the read).
	payload, call = runToolOnce(t, b, "thread.list", map[string]any{"project_id": "p-2"})
	if !call.OK {
		t.Fatalf("thread.list with project_id refused: %+v", call)
	}
	if n := len(rows(payload)); n != 0 {
		t.Fatalf("project p-2 rows = %d, want 0 — no thread of this caller lives there", n)
	}

	// A guessed launcher is a refusal with zero store calls, not an empty list.
	before := len(store.askedAs())
	_, call = runToolOnce(t, b, "thread.list", map[string]any{"launcher": "the Pi agent"})
	if call.OK || call.Reason != "bad_arguments" {
		t.Fatalf("a launcher outside the id shape = %+v, want bad_arguments", call)
	}
	if after := len(store.askedAs()); after != before {
		t.Fatalf("the refused call made %d store reads, want 0", after-before)
	}
}

// --- the cap and the order -------------------------------------------------

// TestThreadListCapsAtThirtyNewestFirst is the cap the tool documents: 34 rows
// in, 30 out, and the 30 are the NEWEST.
func TestThreadListCapsAtThirtyNewestFirst(t *testing.T) {
	var parts []string
	for i := 0; i < 34; i++ {
		parts = append(parts, threadRow(fmt.Sprintf("t-%02d", i), "p-1", "prof-pi",
			fmt.Sprintf("Thread %02d", i), "idle", false,
			fmt.Sprintf("2026-11-%02dT%02d:00:00Z", 1+i%9, i%24)))
	}
	store := newThreadStore()
	store.withThreads(testCaller, "["+strings.Join(parts, ",")+"]")
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "thread.list", nil)
	if !call.OK {
		t.Fatalf("thread.list refused: %+v", call)
	}
	got := rows(payload)
	if len(got) != threadRowCap {
		t.Fatalf("rows = %d, want the documented cap (%d): %s", len(got), threadRowCap, payload)
	}
	for i := 1; i < len(got); i++ {
		prev, _ := parseRowTime(field(got[i-1], "updated_at"))
		next, _ := parseRowTime(field(got[i], "updated_at"))
		if next.After(prev) {
			t.Fatalf("rows are not newest first: row %d (%s) is after row %d (%s)",
				i, field(got[i], "updated_at"), i-1, field(got[i-1], "updated_at"))
		}
	}
	// The payload is one thread list, not a dump: 30 rows of seven short fields
	// must stay inside the registry's own byte cap unmarked.
	if truncated := strings.Contains(string(payload), `"truncated"`); truncated {
		t.Fatalf("a capped thread list was byte-cut anyway: %s", payload)
	}
}

// --- the status vocabulary (finding F-7) -----------------------------------

// TestThreadListStatusWordsAreTheThreadsPageVocabulary pins the words the answer
// may use: the /threads page's own (running / queued / idle / interrupted /
// completed), never a run state — and `queued` is the row with a turn still
// waiting, which is what the page draws under LIVE.
func TestThreadListStatusWordsAreTheThreadsPageVocabulary(t *testing.T) {
	store := newThreadStore()
	store.withThreads(testCaller, "["+
		threadRow("t-live", "p-1", "prof-pi", "Attached session", "active", true, recentAt(240))+","+
		threadRow("t-wait", "p-1", "prof-pi", "Turn queued", "idle", true, recentAt(210))+","+
		threadRow("t-open", "p-1", "prof-pi", "Open, nothing running", "idle", false, recentAt(180))+","+
		threadRow("t-lost", "p-1", "prof-pi", "Worker gone", "disconnected", false, recentAt(120))+","+
		threadRow("t-done", "p-1", "prof-pi", "Wrapped up", "archived", false, recentAt(60))+"]")
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "thread.list", map[string]any{"since": "24h"})
	if !call.OK {
		t.Fatalf("thread.list refused: %+v", call)
	}
	want := map[string]string{
		"t-live": "running", "t-wait": "queued", "t-open": "idle",
		"t-lost": "interrupted", "t-done": "completed",
	}
	seen := map[string]string{}
	for _, row := range rows(payload) {
		seen[field(row, "id")] = field(row, "status")
	}
	for id, word := range want {
		if seen[id] != word {
			t.Errorf("thread %s status = %q, want %q (the /threads page's word)", id, seen[id], word)
		}
	}
	for _, forbidden := range []string{"succeeded", "waiting_human", "preparing", "failed"} {
		if strings.Contains(string(payload), forbidden) {
			t.Errorf("the thread payload carries the run state %q (F-7: a thread is not a run): %s",
				forbidden, payload)
		}
	}
	// The project name rides the row: "what did Pi do in Sandbox" is answered
	// with the project the thread lives under, not a uuid.
	for _, row := range rows(payload) {
		if field(row, "project") != "Sandbox" {
			t.Errorf("thread %s names no project: %s", field(row, "id"), row)
		}
	}
}

// TestThreadListLinksOpenTheThreadPage is the jump row: a thread result carries
// its own link at /threads/<id> — the row field the model reads AND the href the
// surface draws — and that path is on the route allowlist, so a hit cannot
// become a link to a page that does not exist.
func TestThreadListLinksOpenTheThreadPage(t *testing.T) {
	store := newThreadStore()
	store.withThreads(testCaller, "["+
		threadRow("t-1", "p-1", "prof-pi", "Fix the flaky test", "idle", false, recentAt(240))+"]")
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)
	tr := &turn{b: b, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("thread.list", nil))
	if len(tr.links) != 1 {
		t.Fatalf("links = %+v, want the one thread page", tr.links)
	}
	if got, want := tr.links[0].Href, "/threads/t-1"; got != want {
		t.Fatalf("link = %q, want %q", got, want)
	}
	if !strings.Contains(tr.links[0].Label, "Fix the flaky test") {
		t.Fatalf("the jump row is not labelled with the thread: %q", tr.links[0].Label)
	}
	// The payload row names the same destination the button performs.
	var payload []map[string]any
	if err := json.Unmarshal(tr.results[0].payload, &payload); err != nil {
		t.Fatalf("payload is not a row array: %s", tr.results[0].payload)
	}
	if len(payload) != 1 || field(payload[0], "link") != "/threads/t-1" {
		t.Fatalf("the row carries no link: %s", tr.results[0].payload)
	}
}

// TestThreadListRefusesAnUnavailableRead keeps the honest absence: a replica
// whose thread read failed answers `unavailable` with no rows, and the model is
// left able to say it could not look.
func TestThreadListRefusesAnUnavailableRead(t *testing.T) {
	store := &unavailableThreadStore{threadStore: newThreadStore()}
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)
	_, call := runToolOnce(t, b, "thread.list", nil)
	if call.OK || call.Reason != "unavailable" {
		t.Fatalf("call = %+v, want the unavailable refusal", call)
	}
}

// unavailableThreadStore is threadStore with a lost thread read.
type unavailableThreadStore struct{ *threadStore }

func (s *unavailableThreadStore) ListAgentThreads(context.Context, Caller) (json.RawMessage, error) {
	return nil, fmt.Errorf("postgres: list visible conversations: connection lost")
}

// --- the registry tables ---------------------------------------------------

// TestThreadListIsInEveryRegistryTable pins the closed class row and the wire
// name, and that the read never gates: a thread list is a read the trust level
// has no say about.
func TestThreadListIsInEveryRegistryTable(t *testing.T) {
	if _, ok := toolRegistry()["thread.list"]; !ok {
		t.Fatal("thread.list has no registry entry")
	}
	class, known := ClassOf("thread.list")
	if !known {
		t.Fatal("thread.list has no row in the closed class table")
	}
	if class != ClassRead {
		t.Fatalf("thread.list is %v, want ClassRead", class)
	}
	for _, level := range []TrustLevel{TrustAskAll, TrustAskRisky, TrustNoAsk} {
		if level.Gates(class) {
			t.Fatalf("thread.list gates at %s; a read never does", level)
		}
	}
	// A store that answers the thread read and nothing else optional announces
	// the six v1 reads plus thread.list — no borrowed catchup.brief.
	// A store that answers the thread read and nothing else optional announces
	// the six v1 reads plus thread.list — no borrowed catchup.brief.
	if got := announcedToolOrder(newThreadStore()); len(got) != len(toolOrder)+1 || got[len(got)-1] != "thread.list" {
		t.Fatalf("announced order = %v, want the six v1 reads plus thread.list", got)
	}
	if _, err := toolWireMap(announcedToolOrder(newThreadStore())); err != nil {
		t.Fatalf("toolWireMap: %v", err)
	}
}

// recentAt is a timestamp the given number of minutes before now, so a
// fixture row always sits inside the tool's `since` window (24h) whatever day
// the suite runs on — the rows were once dated literally and the suite broke
// the day after they were written.
func recentAt(minutesAgo int) string {
	return time.Now().UTC().Add(-time.Duration(minutesAgo) * time.Minute).Format(time.RFC3339)
}
