package assistant

// Assistant handoff §6 (CONTRACT §5): the setup reads. These tests pin the
// announcement rule (an unwired SetupReader keeps its seven tools out of the
// announced set while docs.search, whose corpus is compiled in, stays), each
// tool's payload shape, the argument rule (a missing required arg is a refusal
// with zero reader calls), and the search itself — the copy an operator reads
// has to be findable by the words an operator types.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

// --- the fake setup reader ----------------------------------------------

// fakeSetup answers the seven reader-backed tools with canned payloads and
// records who each call was made as, so the caller-scoping is a proven
// property rather than a comment.
type fakeSetup struct {
	mu      sync.Mutex
	calls   []string
	callers []Caller
	args    map[string]string

	creds     json.RawMessage
	workflows json.RawMessage
	inspect   json.RawMessage
	repo      json.RawMessage
	issues    json.RawMessage
	profiles  json.RawMessage
	scheds    json.RawMessage
	err       error
}

func newFakeSetup() *fakeSetup {
	return &fakeSetup{args: map[string]string{}}
}

func (f *fakeSetup) note(name string, c Caller, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.callers = append(f.callers, c)
	if key != "" {
		f.args[name] = key
	}
	return f.err
}

func (f *fakeSetup) called(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}

func (f *fakeSetup) CredentialList(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.note("credential.list", c, ""); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.creds), nil
}

func (f *fakeSetup) WorkflowList(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.note("workflow.list", c, ""); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.workflows), nil
}

func (f *fakeSetup) WorkflowInspect(_ context.Context, c Caller, pipelineID string) (json.RawMessage, error) {
	if err := f.note("workflow.inspect", c, pipelineID); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.inspect), nil
}

func (f *fakeSetup) RepoCheck(_ context.Context, c Caller, url, credential string) (json.RawMessage, error) {
	if err := f.note("repo.check", c, url+"|"+credential); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.repo), nil
}

func (f *fakeSetup) IssueList(_ context.Context, c Caller, projectID, repositoryID string) (json.RawMessage, error) {
	if err := f.note("issue.list", c, projectID+"|"+repositoryID); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.issues), nil
}

func (f *fakeSetup) ProfileList(_ context.Context, c Caller) (json.RawMessage, error) {
	if err := f.note("profile.list", c, ""); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.profiles), nil
}

func (f *fakeSetup) ScheduleList(_ context.Context, c Caller, projectID string) (json.RawMessage, error) {
	if err := f.note("schedule.list", c, projectID); err != nil {
		return nil, err
	}
	return rawOrEmpty(f.scheds), nil
}

func rawOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`[]`)
	}
	return raw
}

// setupRunner wires a runner with (or without) the setup face.
func setupRunner(t *testing.T, setup SetupReader) *ConversationRunner {
	t.Helper()
	model := newFakeModel(t, step{text: "ok"})
	b := newTestBroker(t, model, newFakeStore())
	return NewConversationRunner(ConversationRunnerDeps{Broker: b, Setup: setup})
}

// execSetup runs one setup read through the runner's read branch (the same
// path execOne takes once the trust gate has let a read through).
func execSetup(t *testing.T, r *ConversationRunner, name string, args map[string]any) execOutcome {
	t.Helper()
	return r.runReadClass(context.Background(), TurnRequest{Caller: testCaller},
		name, toolCall(name, args))
}

// --- announcement --------------------------------------------------------

func TestSetupToolsAnnouncedOnlyWithReader(t *testing.T) {
	announced := func(r *ConversationRunner) map[string]bool {
		out := map[string]bool{}
		for _, spec := range r.allToolSpecs() {
			out[r.decodeName(spec.Function.Name)] = true
		}
		return out
	}
	bare := announced(setupRunner(t, nil))
	for _, name := range []string{"credential.list", "workflow.list", "workflow.inspect",
		"repo.check", "issue.list", "profile.list", "schedule.list"} {
		if bare[name] {
			t.Errorf("nil SetupReader announced %s; the honest-degradation rule keeps it unannounced", name)
		}
	}
	// docs.search answers from the compiled-in corpus, so it is announced
	// either way — a "how do I…" question is answerable on every deployment.
	if !bare["docs.search"] {
		t.Error("docs.search must be announced even without a SetupReader")
	}

	wired := announced(setupRunner(t, newFakeSetup()))
	for _, name := range []string{"credential.list", "workflow.list", "workflow.inspect",
		"repo.check", "issue.list", "profile.list", "schedule.list", "docs.search"} {
		if !wired[name] {
			t.Errorf("a wired SetupReader did not announce %s", name)
		}
	}
	// Every announced name is in the closed table: the table is the registry's
	// source of truth, so a tool outside it cannot be registered at all.
	for name := range wired {
		if _, known := ClassOf(name); !known {
			t.Errorf("%s is announced but not in the closed tool table", name)
		}
	}
}

func TestSetupReadClassesAreAllReads(t *testing.T) {
	for name := range setupReadTools {
		class, known := ClassOf(name)
		if !known {
			t.Errorf("%s is a setup read but has no row in the closed table", name)
			continue
		}
		if class != ClassRead {
			t.Errorf("%s is class %v; every setup tool is a read", name, class)
		}
	}
}

// --- each tool's payload --------------------------------------------------

func TestSetupReadPayloadsAndCallerScoping(t *testing.T) {
	setup := newFakeSetup()
	setup.creds = json.RawMessage(`[{"name":"github-token","kind":"github","scope":"org","used_by":["feature-delivery"]}]`)
	setup.workflows = json.RawMessage(`[{"id":"pl-1","slug":"issue-to-pr","name":"Issue to PR","latest_revision":3,"sample":true,"assigned_to":["feature-delivery"]}]`)
	setup.inspect = json.RawMessage(`{"pipeline":{"id":"pl-1"},"revisions":[{"revision":3}],"assignments":[{"project":"feature-delivery"}]}`)
	setup.repo = json.RawMessage(`{"repo":"acme/app","reachable":true,"default_branch":"main","can_push":true,"credential":"github-token"}`)
	setup.issues = json.RawMessage(`[{"number":12,"title":"Fix the flake","state":"open"}]`)
	setup.profiles = json.RawMessage(`[{"id":"ap-1","name":"Codex","launcher":"codex","version":2}]`)
	setup.scheds = json.RawMessage(`[{"id":"sc-1","cron":"0 6 * * 1-5","enabled":true,"next_run_at":"2026-11-16T06:00:00Z"}]`)
	r := setupRunner(t, setup)

	cases := []struct {
		name     string
		args     map[string]any
		contains string
	}{
		{"credential.list", nil, `"used_by":["feature-delivery"]`},
		{"workflow.list", nil, `"latest_revision":3`},
		{"workflow.inspect", map[string]any{"pipeline_id": "pl-1"}, `"revisions"`},
		{"repo.check", map[string]any{"url": "https://github.com/acme/app.git"}, `"can_push":true`},
		{"issue.list", map[string]any{"project_id": "p-1", "repository_id": "r-1"}, `"number":12`},
		{"profile.list", nil, `"launcher":"codex"`},
		{"schedule.list", map[string]any{"project_id": "p-1"}, `"cron":"0 6 * * 1-5"`},
	}
	for _, tc := range cases {
		out := execSetup(t, r, tc.name, tc.args)
		if !out.call.OK {
			t.Fatalf("%s: ok=false reason=%s", tc.name, out.call.Reason)
		}
		if !strings.Contains(string(out.payload), tc.contains) {
			t.Errorf("%s payload = %s, want it to carry %s", tc.name, out.payload, tc.contains)
		}
		if out.call.Summary == "" {
			t.Errorf("%s carried no transparency summary", tc.name)
		}
		if !setup.called(tc.name) {
			t.Errorf("%s did not reach the reader", tc.name)
		}
	}
	for _, c := range setup.callers {
		if c != testCaller {
			t.Fatalf("a setup read ran as %+v, want the turn's caller %+v", c, testCaller)
		}
	}
	if got := setup.args["workflow.inspect"]; got != "pl-1" {
		t.Errorf("workflow.inspect passed %q as the pipeline id", got)
	}
	if got := setup.args["repo.check"]; got != "https://github.com/acme/app.git|" {
		t.Errorf("repo.check passed %q (url|credential)", got)
	}
	if got := setup.args["schedule.list"]; got != "p-1" {
		t.Errorf("schedule.list passed %q as the project id", got)
	}
}

func TestSetupReadRefusesBadArguments(t *testing.T) {
	setup := newFakeSetup()
	r := setupRunner(t, setup)
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"workflow.inspect", map[string]any{}},               // pipeline_id is required
		{"schedule.list", map[string]any{"project_id": " "}}, // blank is not an answer
		{"repo.check", map[string]any{}},                     // url is required
		{"issue.list", map[string]any{"project_id": "p-1"}},
		{"docs.search", map[string]any{}},
		{"profile.list", map[string]any{"project_id": "p-1"}}, // not a prop of this tool
	} {
		out := execSetup(t, r, tc.name, tc.args)
		if out.call.OK || out.call.Reason != "bad_arguments" {
			t.Errorf("%s %+v = ok=%v reason=%q, want the bad_arguments refusal",
				tc.name, tc.args, out.call.OK, out.call.Reason)
		}
	}
	if len(setup.calls) != 0 {
		t.Errorf("a refused call reached the store: %v", setup.calls)
	}
}

func TestSetupReadErrorReasonsAreTheClosedOnes(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{ErrNotFound, "not_found"},
		{ErrForbidden, "forbidden"},
		{errors.New("store is down"), "unavailable"},
	} {
		setup := newFakeSetup()
		setup.err = tc.err
		out := execSetup(t, setupRunner(t, setup), "profile.list", nil)
		if out.call.OK || out.call.Reason != tc.want {
			t.Errorf("reader error %v gave ok=%v reason=%q, want %q",
				tc.err, out.call.OK, out.call.Reason, tc.want)
		}
		if out.payload != nil {
			t.Errorf("a refused read carried a payload: %s", out.payload)
		}
	}
}

func TestSetupReadWithoutReaderRefuses(t *testing.T) {
	out := execSetup(t, setupRunner(t, nil), "credential.list", nil)
	if out.call.OK || out.call.Reason != "unknown_tool" {
		t.Errorf("credential.list with no reader = ok=%v reason=%q, want the unknown_tool refusal",
			out.call.OK, out.call.Reason)
	}
}

// TestSetupReadsGoThroughTheTrustGate pins that the new names are reads in the
// one sense that matters at the gate: no trust level asks before one.
func TestSetupReadsGoThroughTheTrustGate(t *testing.T) {
	for _, level := range []TrustLevel{TrustAskAll, TrustAskRisky, TrustNoAsk} {
		if level.Gates(ClassRead) {
			t.Errorf("%s gates a read; only changes and judge-flagged calls ever ask", level)
		}
	}
}

// --- docs.search ----------------------------------------------------------

func TestDocsSearchFindsTheHowToForItsOwnWords(t *testing.T) {
	cases := []struct {
		query string
		title string
	}{
		{"how do I add a repo", "Add a repository"},
		{"how do I add a project?", "Add a project"},
		{"where do I put a github token", "Add a GitHub token"},
		{"assign a workflow to a project", "Assign a workflow to a project"},
		{"start a run", "Start a run"},
		{"approve a gate", "Approve a gate"},
		{"decision model", "Set up the decision model"},
		{"speech dictation mic", "Set up speech (dictation)"},
		{"cron schedule", "Schedules"},
		{"agent profile", "Agent profiles"},
	}
	for _, tc := range cases {
		hits := searchHowTo(tc.query)
		if len(hits) == 0 {
			t.Fatalf("searchHowTo(%q) found nothing", tc.query)
		}
		if got := hits[0]["title"]; got != tc.title {
			var titles []string
			for _, h := range hits {
				titles = append(titles, h["title"].(string))
			}
			t.Errorf("searchHowTo(%q) top hit = %v, want %q", tc.query, got, tc.title)
		}
	}
}

func TestDocsSearchPayloadShape(t *testing.T) {
	r := setupRunner(t, nil)
	out := execSetup(t, r, "docs.search", map[string]any{"query": "how do I add a repo"})
	if !out.call.OK {
		t.Fatalf("docs.search: ok=false reason=%s", out.call.Reason)
	}
	var hits []map[string]any
	if err := json.Unmarshal(out.payload, &hits); err != nil {
		t.Fatalf("payload is not an array of objects: %v (%s)", err, out.payload)
	}
	if len(hits) == 0 || len(hits) > 3 {
		t.Fatalf("payload carried %d rows, want 1..3", len(hits))
	}
	for _, h := range hits {
		if len(h) != 3 {
			t.Errorf("row %v has %d members, want exactly title, path, excerpt", h, len(h))
		}
		for _, key := range []string{"title", "path", "excerpt"} {
			s, ok := h[key].(string)
			if !ok || s == "" {
				t.Errorf("row %v has no string %q", h, key)
			}
		}
		if e, _ := h["excerpt"].(string); len(e) > howtoMaxExcerpt {
			t.Errorf("excerpt is %d chars, over the %d bound", len(e), howtoMaxExcerpt)
		}
		if p, _ := h["path"].(string); !strings.HasPrefix(p, "howto/") || !strings.HasSuffix(p, ".md") {
			t.Errorf("path = %q, want an embedded howto/*.md path", p)
		}
	}
}

// TestDocsSearchCorpusIsShortAndPlain is the curator's own rule: the payload
// cap makes a long doc useless to the model, so every page fits under 25 lines.
func TestDocsSearchCorpusIsShortAndPlain(t *testing.T) {
	docs := loadHowto()
	if len(docs) < 8 || len(docs) > 10 {
		t.Fatalf("the corpus carries %d docs, want 8..10", len(docs))
	}
	for _, d := range docs {
		if d.title == "" || d.body == "" {
			t.Errorf("%s has no title or no body", d.path)
		}
		if n := strings.Count(d.body, "\n") + 1; n > 24 {
			t.Errorf("%s is %d lines of body, over the ≤25-line rule", d.path, n)
		}
	}
}

func TestDocsSearchUnknownQuestionSaysNothingRatherThanGuessing(t *testing.T) {
	hits := searchHowTo("quilt tartan waggon")
	if len(hits) != 0 {
		t.Fatalf("the corpus answered a question it has no page for: %v", hits)
	}
	out := execSetup(t, setupRunner(t, nil), "docs.search", map[string]any{"query": "quilt tartan waggon"})
	if !out.call.OK || strings.TrimSpace(string(out.payload)) != "[]" {
		t.Errorf("an unmatched question gave ok=%v payload %s, want an empty array", out.call.OK, out.payload)
	}
}

func TestHowtoTermsDropsTheQuestionWords(t *testing.T) {
	terms := howtoTerms("How do I add a repository please?")
	joined := strings.Join(terms, " ")
	if strings.Contains(joined, "how") || strings.Contains(joined, "please") {
		t.Errorf("terms kept a function word: %v", terms)
	}
	if len(terms) != 2 || terms[0] != "add" || terms[1] != "repository" {
		t.Errorf("terms = %v, want [add repository]", terms)
	}
}
