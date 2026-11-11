package assistant

// ADR-0081 § Chat tools: the tests for the catch-up read registry.
//
// Four properties are pinned here, and each one is a rule the ADR states rather
// than a behaviour someone might happen to like:
//
//   - an optional read is announced ONLY when the store can answer it, and is
//     unreachable when it is not (a model cannot ask for a brief this
//     deployment does not assemble, and cannot reach one by inventing the wire
//     name either);
//   - the tool schemas are the contract the model reads, so every declared
//     argument is a bounded string and every required key exists;
//   - the two widened list reads respect membership by construction: the fan
//     is the caller's own project.list, so a project the caller is not in is
//     never even asked about;
//   - catchup.brief ships the assembled brief MINUS the two sections a model
//     wrote, keeps each row's app link, and never trades a needs_you row for
//     bytes.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- the fake: the v1 reads, the project fan, and the brief reader ---------

type chatStore struct {
	mu sync.Mutex

	// projects is what project.list answers — the caller's visible projects,
	// which is the membership predicate the two cross-project reads fan over.
	projects json.RawMessage
	// runs and gates are keyed by project id, so a test can prove which
	// projects the tool actually asked about.
	runs  map[string]json.RawMessage
	gates map[string]json.RawMessage

	// brief is the bytes CatchUpBrief hands back; briefWindow/briefCaller
	// record the ONE call the tool made.
	brief       json.RawMessage
	briefWindow string
	briefCaller Caller
	briefCalls  int

	askedRunsFor    []string
	askedGatesFor   []string
	callerOfProject Caller
}

func newChatStore() *chatStore {
	return &chatStore{
		projects: json.RawMessage(`[]`),
		runs:     map[string]json.RawMessage{},
		gates:    map[string]json.RawMessage{},
		brief:    json.RawMessage(`{}`),
	}
}

func (s *chatStore) ListProjects(_ context.Context, c Caller) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.callerOfProject = c
	return s.projects, nil
}

func (s *chatStore) ListProjectRuns(_ context.Context, _ Caller, projectID string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.askedRunsFor = append(s.askedRunsFor, projectID)
	if raw, ok := s.runs[projectID]; ok {
		return raw, nil
	}
	return json.RawMessage(`[]`), nil
}

func (s *chatStore) ListProjectApprovals(_ context.Context, _ Caller, projectID string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.askedGatesFor = append(s.askedGatesFor, projectID)
	if raw, ok := s.gates[projectID]; ok {
		return raw, nil
	}
	return json.RawMessage(`[]`), nil
}

func (s *chatStore) ListPipelines(context.Context, Caller) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

func (s *chatStore) ListRunNodes(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

func (s *chatStore) ListPipelineRevisions(context.Context, Caller, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

func (s *chatStore) ListAgentProfiles(context.Context, Caller) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

// CatchUpBrief is the optional face: what the adapter in internal/api answers
// with AssembleCatchUpBrief's own bytes.
func (s *chatStore) CatchUpBrief(_ context.Context, c Caller, window string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.briefCalls++
	s.briefWindow = window
	s.briefCaller = c
	return s.brief, nil
}

func (s *chatStore) seen() (int, string, Caller) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.briefCalls, s.briefWindow, s.briefCaller
}

func (s *chatStore) runsAsked() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.askedRunsFor...)
}

func (s *chatStore) gatesAsked() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.askedGatesFor...)
}

// runToolOnce runs one registry call directly: these tests are about the read,
// its arguments and its payload, not about a scripted model turn.
func runToolOnce(t *testing.T, b *Broker, name string, args map[string]any) (json.RawMessage, ToolCall) {
	t.Helper()
	if _, known := b.tools[name]; !known {
		t.Fatalf("tool %q is not in the registry", name)
	}
	blob, _ := json.Marshal(args)
	call := toolCallRequest{ID: "call-" + name, Type: "function"}
	call.Function.Name = name
	call.Function.Arguments = string(blob)
	tr := &turn{b: b, ctx: context.Background(), caller: testCaller}
	tr.exec(call)
	if len(tr.results) != 1 {
		t.Fatalf("%s: %d results recorded, want 1", name, len(tr.results))
	}
	out := tr.results[0]
	if !out.call.OK {
		return nil, out.call
	}
	return out.payload, out.call
}

// --- announcement and schemas ---------------------------------------------

// TestCatchUpBriefAnnouncedOnlyWhenTheStoreAnswersIt is the honest-degradation
// rule of ADR-0034 applied to a new read: the tool is announced when the store
// carries CatchUpBriefReader, and when it does not the tool is BOTH unannounced
// and unreachable — the same `unknown_tool` refusal an invented name gets, with
// zero store calls, so an answer cannot tell the two apart.
func TestCatchUpBriefAnnouncedOnlyWhenTheStoreAnswersIt(t *testing.T) {
	model := newFakeModel(t, step{text: "quiet"})
	plain := newTestBroker(t, model, newFakeStore())
	if len(plain.toolSpecs()) != len(toolOrder) {
		t.Fatalf("announced = %d, want the six v1 reads (%d) with no brief store wired",
			len(plain.toolSpecs()), len(toolOrder))
	}
	for _, spec := range plain.toolSpecs() {
		if spec.Function.Name == wireName("catchup.brief") {
			t.Fatal("catchup.brief was announced over a store that cannot assemble a brief")
		}
	}
	tr := &turn{b: plain, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("catchup.brief", map[string]any{"window": "24h"}))
	if len(tr.calls) != 1 || tr.calls[0].OK || tr.calls[0].Reason != "unknown_tool" {
		t.Fatalf("unannounced call = %+v, want the unknown_tool refusal", tr.calls)
	}
	if inner, ok := plain.store.(*fakeStore); ok && inner.count("project.list") != 0 {
		t.Fatal("an unannounced read reached the store")
	}

	briefing := newTestBroker(t, newFakeModel(t, step{text: "quiet"}), newChatStore())
	found := ""
	for _, spec := range briefing.toolSpecs() {
		if spec.Function.Name == wireName("catchup.brief") {
			found = spec.Function.Description
		}
	}
	if found == "" {
		t.Fatalf("catchup.brief missing from %v", briefing.toolSpecs())
	}
	if !strings.Contains(found, "what did I miss") || !strings.Contains(found, "Read-only") {
		t.Fatalf("the announced description does not tell the model when to use it: %q", found)
	}
}

// TestReadRegistryTablesAgree pins the three tables that must never drift: the
// registry, the announcement order (plus its optional tail), and the closed
// class table the trust gate reads. A read announced without a class row is a
// call the runner refuses; a class row with no registry entry is a name nobody
// can serve.
func TestReadRegistryTablesAgree(t *testing.T) {
	reg := toolRegistry()
	for _, name := range announcedToolOrder(newChatStore()) {
		if _, ok := reg[name]; !ok {
			t.Errorf("%s is announced but has no registry entry", name)
		}
		class, known := ClassOf(name)
		if !known {
			t.Errorf("%s has no row in the closed class table", name)
			continue
		}
		if class != ClassRead {
			t.Errorf("%s is announced as a read but classified %v", name, class)
		}
	}
	for _, name := range optionalToolOrder {
		if _, ok := reg[name]; !ok {
			t.Errorf("optional tool %s has no registry entry", name)
		}
	}
	if wire, err := toolWireMap(announcedToolOrder(newChatStore())); err != nil {
		t.Fatalf("toolWireMap: %v", err)
	} else if regName, ok := wire[wireName("catchup.brief")]; !ok || regName != "catchup.brief" {
		t.Fatalf("catchup.brief has no wire name (got %q, %v)", regName, ok)
	}
}

// TestToolArgSchemasAreSelfConsistent is the brief's "tool schemas validate"
// case: every declared argument is a bounded string with a description the
// model can act on, every required key is one that exists, and each schema
// marshals as a JSON object the endpoint will accept.
func TestToolArgSchemasAreSelfConsistent(t *testing.T) {
	for _, name := range announcedToolOrder(newChatStore()) {
		tl := toolRegistry()[name]
		for key, prop := range tl.props {
			schema, ok := prop.(map[string]any)
			if !ok {
				t.Errorf("%s.%s: property is %#v, want an object schema", name, key, prop)
				continue
			}
			if schema["type"] != "string" {
				t.Errorf("%s.%s: type = %v, want string", name, key, schema["type"])
			}
			if desc, _ := schema["description"].(string); strings.TrimSpace(desc) == "" {
				t.Errorf("%s.%s: no description for the model to read", name, key)
			}
			if max, _ := schema["maxLength"].(int); max > 200 {
				t.Errorf("%s.%s: maxLength %d exceeds the registry bound", name, key, max)
			}
		}
		for _, key := range tl.require {
			if _, ok := tl.props[key]; !ok {
				t.Errorf("%s requires %q, which it does not declare", name, key)
			}
		}
	}

	// ADR-0081's shape change, stated as the shape: project_id is optional on
	// both list reads now, and catchup.brief takes a window and nothing else.
	reg := toolRegistry()
	for _, name := range []string{"run.list", "approval.pending"} {
		if len(reg[name].require) != 0 {
			t.Errorf("%s still requires %v; ADR-0081 made project_id optional", name, reg[name].require)
		}
	}
	if _, ok := reg["run.list"].props["since"]; !ok {
		t.Error("run.list declares no since argument")
	}
	if _, ok := reg["run.list"].props["status"]; !ok {
		t.Error("run.list declares no status argument")
	}
	window, _ := reg["catchup.brief"].props["window"].(map[string]any)
	if window == nil {
		t.Fatal("catchup.brief declares no window argument")
	}
	if desc, _ := window["description"].(string); !strings.Contains(desc, "unseen") {
		t.Errorf("catchup.brief.window does not name its default: %q", desc)
	}
}

// TestRunListAndBriefRefuseArgumentsOutsideTheirVocabulary is the `validate`
// hook: a guessed window or status is a refusal with zero store calls, never an
// empty list a model would report as a quiet week.
func TestRunListAndBriefRefuseArgumentsOutsideTheirVocabulary(t *testing.T) {
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), newChatStore())
	for _, call := range []struct {
		tool string
		args map[string]any
	}{
		{"catchup.brief", map[string]any{"window": "8d"}},
		{"run.list", map[string]any{"status": "green"}},
		{"run.list", map[string]any{"since": "yesterday"}},
	} {
		tl := b.tools[call.tool]
		blob, _ := json.Marshal(call.args)
		if _, err := parseArgs(tl, string(blob)); err == nil {
			t.Errorf("%s %v: an out-of-vocabulary argument parsed clean", call.tool, call.args)
		}
	}
	// And the refusal makes no store call at all.
	tr := &turn{b: b, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("catchup.brief", map[string]any{"window": "3 days"}))
	if len(tr.calls) != 1 || tr.calls[0].Reason != "bad_arguments" {
		t.Fatalf("calls = %+v, want one bad_arguments refusal", tr.calls)
	}
	if _, _, caller := b.store.(*chatStore).seen(); caller != (Caller{}) {
		t.Fatal("a refused argument reached the store")
	}
}

// --- catchup.brief --------------------------------------------------------

// TestCatchUpBriefAnswersTheWindowItWasGivenAndShipsThePageBrief is the ADR's
// "the same JSON without a headline": the window goes to the assembler, the
// model's own two sections never come back, and the rows keep the app links
// that make them openable.
func TestCatchUpBriefAnswersTheWindowItWasGivenAndShipsThePageBrief(t *testing.T) {
	store := newChatStore()
	store.brief = json.RawMessage(`{
	  "window": {"key": "24h", "since": "2026-11-10T09:00:00Z", "until": "2026-11-11T09:00:00Z"},
	  "headline": {"text": "A model's sentence", "state": "ready"},
	  "needs_you": [{"kind":"approval","title":"Ship the ledger fix","project":{"id":"01JP","name":"Ledger","color":"#123"},"link":"/approvals/01JGATE","at":"2026-11-10T10:00:00Z","detail":"gate on run 01JR"}],
	  "running_now": [{"run_id":"01JR2","title":"Backfill nightly","project":{"id":"01JQ","name":"Docs","color":"#456"},"started_at":"2026-11-11T08:00:00Z","step":"implement","link":"/runs/01JR2"}],
	  "shipped": [],
	  "broke": [{"title":"release-flow","project":{"id":"01JQ","name":"Docs","color":"#456"},"failures":3,"error_class":"test","still_failing":true,"fixed_at":null,"link":"/runs/01JR3"}],
	  "heads_up": [],
	  "changes": [],
	  "numbers": {"runs":{"succeeded":4,"failed":3,"cancelled":0,"running":1},"approvals":{"decided":1,"pending":1},"threads_active":2,"prs":4,"commits":9},
	  "by_project": [{"project":{"id":"01JQ","name":"Docs","color":"#456"},"line":"a per-project line"}],
	  "omitted": {"shipped": 4}
	}`)
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "catchup.brief", map[string]any{"window": "24h"})
	if !call.OK {
		t.Fatalf("catchup.brief refused: %+v", call)
	}
	if calls, window, caller := store.seen(); calls != 1 || window != "24h" || caller != testCaller {
		t.Fatalf("brief reads = %d window %q caller %+v", calls, window, caller)
	}
	body := string(payload)
	for _, forbidden := range []string{"headline", "by_project", "A model's sentence", "per-project line"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("the payload still carries the model-written %q: %s", forbidden, body)
		}
	}
	for _, want := range []string{
		`"key":"24h"`, "Ship the ledger fix", "release-flow", `"commits":9`, `"still_failing":true`,
		"/approvals/01JGATE", "/runs/01JR2", `"omitted":{"shipped":4}`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("payload missing %s: %s", want, body)
		}
	}
	if call.Summary != "Read the 24h catch-up brief" {
		t.Errorf("summary = %q, want the window the brief answered", call.Summary)
	}

	// The rows' links become jump buttons, in the ADR's priority order, and
	// every one of them is a route the allowlist admits — which is what
	// routes.go's /approvals/{id} pattern is here for. The tour deep link's
	// ?stop= anchor is a page-local detail and is dropped to the page itself.
	tr := &turn{b: b, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("catchup.brief", map[string]any{"window": "1h"}))
	var hrefs []string
	for _, l := range tr.links {
		hrefs = append(hrefs, l.Href)
	}
	joined := strings.Join(hrefs, " ")
	for _, want := range []string{"/approvals/01JGATE", "/runs/01JR3", "/runs/01JR2"} {
		if !strings.Contains(joined, want) {
			t.Errorf("no jump button for %s: %v", want, hrefs)
		}
	}
	if len(hrefs) == 0 || hrefs[0] != "/approvals/01JGATE" {
		t.Errorf("the first button must be the row the reader owes: %v", hrefs)
	}

	// Empty window means `unseen`: the question the page asks by default.
	store2 := newChatStore()
	store2.brief = store.brief
	b2 := newTestBroker(t, newFakeModel(t, step{text: "x"}), store2)
	if _, call := runToolOnce(t, b2, "catchup.brief", nil); !call.OK {
		t.Fatalf("the default window was refused: %+v", call)
	}
	if _, window, _ := store2.seen(); window != "unseen" {
		t.Fatalf("default window = %q, want unseen", window)
	}
}

// TestCatchUpBriefByteCapNeverCutsNeedsYou is the ladder: a brief wider than the
// tool's budget loses the tail of its lowest-priority sections first, counts
// every loss in `omitted`, and still names all of what the reader owes.
func TestCatchUpBriefByteCapNeverCutsNeedsYou(t *testing.T) {
	store := newChatStore()
	var needs, changes []string
	for i := 0; i < 10; i++ {
		needs = append(needs, fmt.Sprintf(
			`{"kind":"approval","title":"Owed item %02d · %s","project":{"id":"01J%02d","name":"Ledger","color":"#123"},"link":"/approvals/01JOW%02d","at":"2026-11-10T10:00:00Z","detail":"%s"}`,
			i, strings.Repeat("n", 200), i, i, strings.Repeat("d", 200)))
		changes = append(changes, fmt.Sprintf(
			`{"kind":"workflow_published","title":"Routine change %02d · %s","by":"alice","at":"2026-11-10T10:00:00Z","link":"/workflows/01JCH%02d"}`,
			i, strings.Repeat("c", 200), i))
	}
	store.brief = json.RawMessage(fmt.Sprintf(`{
	  "window": {"key": "7d", "since": "2026-11-04T09:00:00Z", "until": "2026-11-11T09:00:00Z"},
	  "headline": {"text": "", "state": "unavailable"},
	  "needs_you": [%s], "running_now": [], "shipped": [], "broke": [], "heads_up": [],
	  "changes": [%s],
	  "numbers": {"runs":{"succeeded":0,"failed":0,"cancelled":0,"running":0},"approvals":{"decided":0,"pending":10},"threads_active":0,"prs":0,"commits":0},
	  "by_project": [], "omitted": {}
	}`, strings.Join(needs, ","), strings.Join(changes, ",")))
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "catchup.brief", map[string]any{"window": "7d"})
	if !call.OK {
		t.Fatalf("catchup.brief refused: %+v", call)
	}
	if len(payload) > maxCatchUpChatResultBytes {
		t.Fatalf("payload is %d bytes, over the %d cap", len(payload), maxCatchUpChatResultBytes)
	}
	var body struct {
		NeedsYou []map[string]any `json:"needs_you"`
		Changes  []map[string]any `json:"changes"`
		Omitted  map[string]int   `json:"omitted"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("the capped payload is not the brief object any more: %v", err)
	}
	if len(body.NeedsYou) != 10 {
		t.Fatalf("needs_you rows = %d, want all 10 (the ladder never cuts what the reader owes)", len(body.NeedsYou))
	}
	if len(body.Changes) >= 10 {
		t.Fatalf("changes kept %d rows while the payload was over budget", len(body.Changes))
	}
	if body.Omitted["changes"] != 10-len(body.Changes) {
		t.Fatalf("omitted = %v, want the count of the rows the cap cut", body.Omitted)
	}
}

// TestCatchUpBriefRefusesAMalformedAssembly: a store that answers with
// something that is not the brief object is an unavailable read, not a payload
// the model is asked to narrate.
func TestCatchUpBriefRefusesAMalformedAssembly(t *testing.T) {
	store := newChatStore()
	store.brief = json.RawMessage(`"not the brief"`)
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)
	turn := &turn{b: b, ctx: context.Background(), caller: testCaller}
	turn.exec(toolCall("catchup.brief", map[string]any{}))
	if len(turn.calls) != 1 || turn.calls[0].OK || turn.calls[0].Reason != "unavailable" {
		t.Fatalf("calls = %+v, want one unavailable refusal", turn.calls)
	}
	if len(turn.links) != 0 {
		t.Fatalf("a refused read produced %d links", len(turn.links))
	}
}

// --- run.list / approval.pending across projects --------------------------

// TestRunListAcrossProjectsRespectsMembership is ADR-0081's security line at
// the tool layer: the fan is the caller's own project.list, so the project the
// caller is NOT a member of is never asked about and never named. The fake
// holds runs for that project precisely so the test fails if the tool ever
// widens its fan beyond the caller's memberships.
func TestRunListAcrossProjectsRespectsMembership(t *testing.T) {
	store := newChatStore()
	store.projects = json.RawMessage(`[
	  {"id":"01JMINE","slug":"mine","name":"Mine","my_role":"member"},
	  {"id":"01JMINE2","slug":"mine2","name":"Mine Two","my_role":"maintainer"}]`)
	store.runs["01JMINE"] = json.RawMessage(`[{"id":"r-1","project_id":"01JMINE","status":"completed","title":"Ship the ledger","created_at":"2026-11-11T08:00:00Z","finished_at":"2026-11-11T09:00:00Z"}]`)
	store.runs["01JMINE2"] = json.RawMessage(`[{"id":"r-2","project_id":"01JMINE2","status":"failed","failed_cause":"tests red","created_at":"2026-11-11T07:00:00Z","finished_at":"2026-11-11T07:30:00Z"}]`)
	store.runs["01JFOREIGN"] = json.RawMessage(`[{"id":"r-9","project_id":"01JFOREIGN","status":"failed","title":"Secret Plans","created_at":"2026-11-11T09:30:00Z"}]`)
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "run.list", nil)
	if !call.OK {
		t.Fatalf("run.list refused: %+v", call)
	}
	body := string(payload)
	if strings.Contains(body, "01JFOREIGN") || strings.Contains(body, "Secret Plans") {
		t.Fatalf("a non-member project's run reached the model: %s", body)
	}
	for _, want := range []string{"r-1", "r-2", `"project":"Mine"`, `"project":"Mine Two"`} {
		if !strings.Contains(body, want) {
			t.Errorf("payload missing %s: %s", want, body)
		}
	}
	for _, asked := range store.runsAsked() {
		if asked == "01JFOREIGN" {
			t.Fatal("run.list asked the store about a project the caller is not in")
		}
	}
	if !strings.HasPrefix(call.Summary, "Listed 2 runs across the caller's projects") {
		t.Errorf("summary = %q", call.Summary)
	}
	// The newest row leads: r-1 finished at 09:00, r-2 at 07:30.
	var ranked []map[string]any
	if err := json.Unmarshal(payload, &ranked); err != nil {
		t.Fatalf("payload is not a row array: %v", err)
	}
	if len(ranked) != 2 || field(ranked[0], "id") != "r-1" {
		t.Fatalf("rows = %s, want r-1 newest first", payload)
	}
	// And each row earned a jump button through the allowlist.
	brief := &turn{b: b, ctx: context.Background(), caller: testCaller}
	brief.exec(toolCall("run.list", nil))
	if len(brief.links) != 2 {
		t.Fatalf("links = %v, want one per run row", brief.links)
	}
}

func TestRunListSinceAndStatusAndRowCap(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	stamp := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339Nano) }

	store := newChatStore()
	store.projects = json.RawMessage(`[{"id":"p-1","name":"One"}]`)
	var built []string
	push := func(id, status string, ago time.Duration) {
		built = append(built, fmt.Sprintf(
			`{"id":%q,"project_id":"p-1","status":%q,"created_at":%q,"finished_at":%q}`,
			id, status, stamp(ago), stamp(ago)))
	}
	push("green", "completed", 30*time.Minute)
	push("red", "failed", 20*time.Minute)
	push("stopped", "cancelled", 10*time.Minute)
	push("killed", "interrupted", 5*time.Minute)
	push("live", "running", 1*time.Minute)
	push("ancient", "completed", 3*24*time.Hour)
	// Enough rows to prove the cap and the order, not just the filters.
	for i := 0; i < 60; i++ {
		push(fmt.Sprintf("bulk-%02d", i), "failed", time.Duration(i+40)*time.Hour)
	}
	store.runs["p-1"] = json.RawMessage("[" + strings.Join(built, ",") + "]")
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	// since: a window key, and an RFC 3339 timestamp, answer the same question.
	for _, since := range []string{"1h", stamp(time.Hour)} {
		payload, call := runToolOnce(t, b, "run.list", map[string]any{"since": since})
		if !call.OK {
			t.Fatalf("since=%s refused: %+v", since, call)
		}
		ids := string(payload)
		for _, want := range []string{"green", "red", "stopped", "killed", "live"} {
			if !strings.Contains(ids, fmt.Sprintf("%q", want)) {
				t.Errorf("since=%s dropped %s: %s", since, want, ids)
			}
		}
		if strings.Contains(ids, "ancient") {
			t.Errorf("since=%s kept a run outside the window: %s", since, ids)
		}
	}

	// status: the four words the tool documents, each mapped onto the stored
	// statuses (succeeded is the ADR's word for completed; interrupted counts
	// with cancelled; running is the brief's live set).
	cases := []struct {
		status   string
		want     []string
		dontWant []string
	}{
		{"succeeded", []string{"green"}, []string{"red", "live", "killed"}},
		{"failed", []string{"red"}, []string{"green", "stopped", "live"}},
		{"cancelled", []string{"stopped", "killed"}, []string{"green", "red", "live"}},
		{"running", []string{"live"}, []string{"green", "red", "killed"}},
	}
	for _, tc := range cases {
		payload, call := runToolOnce(t, b, "run.list", map[string]any{"status": tc.status})
		if !call.OK {
			t.Fatalf("status=%s refused: %+v", tc.status, call)
		}
		ids := string(payload)
		for _, want := range tc.want {
			if !strings.Contains(ids, fmt.Sprintf("%q", want)) {
				t.Errorf("status=%s dropped %s: %s", tc.status, want, ids)
			}
		}
		for _, not := range tc.dontWant {
			if strings.Contains(ids, fmt.Sprintf("%q", not)) {
				t.Errorf("status=%s kept %s: %s", tc.status, not, ids)
			}
		}
	}

	// The cap: 66 rows in, 50 out, newest first.
	payload, call := runToolOnce(t, b, "run.list", nil)
	if !call.OK {
		t.Fatalf("run.list refused: %+v", call)
	}
	var kept []map[string]any
	if err := json.Unmarshal(payload, &kept); err != nil {
		t.Fatalf("payload is not a row array: %v", err)
	}
	if len(kept) != runRowCap {
		t.Fatalf("rows = %d, want the cap %d", len(kept), runRowCap)
	}
	if field(kept[0], "id") != "live" {
		t.Fatalf("newest row = %q, want live", field(kept[0], "id"))
	}
	for i := 1; i < len(kept); i++ {
		if runClock(kept[i-1]).Before(runClock(kept[i])) {
			t.Fatalf("row %d (%s) is older than row %d (%s): not newest first",
				i, field(kept[i], "id"), i-1, field(kept[i-1], "id"))
		}
	}

	// A project_id still answers through the project route's own read.
	if _, call := runToolOnce(t, b, "run.list", map[string]any{"project_id": "p-1"}); !call.OK {
		t.Fatalf("run.list with a project_id refused: %+v", call)
	}
	if asked := store.runsAsked(); asked[len(asked)-1] != "p-1" {
		t.Fatalf("last run read = %q, want the project the caller named", asked[len(asked)-1])
	}
}

// TestApprovalPendingAcrossProjects is the same membership rule on the gates:
// every project the caller belongs to contributes its pending gates, decided
// ones never do, and a foreign project is not asked.
func TestApprovalPendingAcrossProjects(t *testing.T) {
	store := newChatStore()
	store.projects = json.RawMessage(`[
	  {"id":"p-1","name":"One","my_role":"member"},
	  {"id":"p-2","name":"Two","my_role":"maintainer"}]`)
	store.gates["p-1"] = json.RawMessage(`[
	  {"id":"g-1","project_id":"p-1","run_id":"r-1","state":"pending","summary":"merge to main"},
	  {"id":"g-2","project_id":"p-1","state":"decided","decision":"approved","summary":"already decided"}]`)
	store.gates["p-2"] = json.RawMessage(`[{"id":"g-3","project_id":"p-2","state":"pending","summary":"deploy"}]`)
	store.gates["p-foreign"] = json.RawMessage(`[{"id":"g-9","project_id":"p-foreign","state":"pending","summary":"invisible"}]`)
	b := newTestBroker(t, newFakeModel(t, step{text: "x"}), store)

	payload, call := runToolOnce(t, b, "approval.pending", nil)
	if !call.OK {
		t.Fatalf("approval.pending refused: %+v", call)
	}
	body := string(payload)
	for _, want := range []string{"g-1", "g-3", `"project":"One"`, `"project":"Two"`, "deploy"} {
		if !strings.Contains(body, want) {
			t.Errorf("payload missing %s: %s", want, body)
		}
	}
	for _, not := range []string{"g-2", "g-9", "invisible", "already decided"} {
		if strings.Contains(body, not) {
			t.Errorf("payload carried %q: %s", not, body)
		}
	}
	for _, asked := range store.gatesAsked() {
		if asked == "p-foreign" {
			t.Fatal("approval.pending asked about a project outside the caller's list")
		}
	}
	if !strings.HasPrefix(call.Summary, "Listed 2 pending approvals across the caller's projects") {
		t.Errorf("summary = %q", call.Summary)
	}
	// A gate inside a run still links to that run; the one without a run links
	// to Today, which is where pending gates are listed (routes_test.go pins
	// the single-project form of this rule).
	tr := &turn{b: b, ctx: context.Background(), caller: testCaller}
	tr.exec(toolCall("approval.pending", nil))
	var hrefs []string
	for _, l := range tr.links {
		hrefs = append(hrefs, l.Href)
	}
	if len(hrefs) != 2 || hrefs[0] != "/runs/r-1" || hrefs[1] != "/" {
		t.Fatalf("links = %v, want [/runs/r-1 /]", hrefs)
	}
}

// --- the prompt line ------------------------------------------------------

// TestCatchUpPromptLineIsInBothSystemPrompts: ADR-0081's whole point is that a
// "what did I miss" question is answered from the assembled brief, and the
// model only does that if the fixed rules tell it to. Both chat surfaces carry
// the line — the one-shot ask and the conversation runner.
func TestCatchUpPromptLineIsInBothSystemPrompts(t *testing.T) {
	const line = "- For catch-up questions, call catchup.brief first, then answer from it: " +
		"what waits on them first, then what is broken, then what shipped; use exact titles and counts."
	for name, prompt := range map[string]string{"ask": systemPrompt, "conversation": conversationSystemPrompt} {
		if !strings.Contains(prompt, line) {
			t.Errorf("%s system prompt is missing the catch-up rule:\n%s", name, prompt)
		}
		if got := strings.Count(prompt, "catchup.brief first"); got != 1 {
			t.Errorf("%s system prompt names catchup.brief first %d times, want the one line", name, got)
		}
	}
}

// TestCatchUpWindowTableIsAdR0081Vocabulary: the tool's window table and the
// assembler's must stay the seven words the ADR states. This package cannot
// import internal/api to compare the two maps, so the list is pinned here
// against the ADR itself, in the order it names them.
func TestCatchUpWindowTableIsAdR0081Vocabulary(t *testing.T) {
	want := []string{"15m", "1h", "6h", "24h", "2d", "7d", "unseen"}
	if strings.Join(catchUpWindowKeys, "|") != strings.Join(want, "|") {
		t.Fatalf("catchUpWindowKeys = %v, want %v", catchUpWindowKeys, want)
	}
	if len(catchUpWindows) != len(want) {
		t.Fatalf("the window table holds %d keys, want %d", len(catchUpWindows), len(want))
	}
	for _, key := range want {
		if _, ok := catchUpWindows[key]; !ok {
			t.Errorf("window %q has no span", key)
		}
	}
	// run.list's documented status words are the ADR's four, and each maps onto
	// at least one stored run status.
	for _, key := range runStatusKeys {
		if len(runStatusAliases[key]) == 0 {
			t.Errorf("status %q maps to no stored run status", key)
		}
	}
}
