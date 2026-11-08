package assistant

// ADR-0078 § Migration: the catch-up tour generator. These tests pin what
// the generator PROMISES: evidence is copied by the server from the block
// (unknown ids dropped), refs are derived from the run's outputs and never
// from the answer, a malformed answer writes NOTHING, a per-run cooldown
// keeps a failing model from being hammered, the per-replica model-call cap
// keeps a fleet of page loads from spending the gateway's whole rate limit, a
// decision without a thread to
// answer it is dropped, and a rewrite inherits the id (and introducing
// version) of every beat whose title survived — the stable-id hinge the
// whole seen-state design hangs on. The store side (the race-safe append,
// the document validation) is already proven against real PostgreSQL in
// internal/store/postgres/catch_up_test.go.

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCatchUpSource serves one candidate list, one facts row and the grouped
// item the facts' key names (the zero CatchUpExistingItem is the store's "no
// piece of work carries that key yet", which is what a first run gets).
type fakeCatchUpSource struct {
	mu          sync.Mutex
	cands       []CatchUpCandidate
	facts       CatchUpRunFacts
	existing    CatchUpExistingItem
	candErr     error
	factsErr    error
	existingErr error
	gotProjects []string
	gotKeys     []string
	calls       int
}

func (s *fakeCatchUpSource) CandidateRuns(_ context.Context, _ Caller, projectIDs []string) ([]CatchUpCandidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gotProjects = projectIDs
	s.calls++
	return s.cands, s.candErr
}

func (s *fakeCatchUpSource) ExistingItem(_ context.Context, _ Caller,
	_, groupKey string) (CatchUpExistingItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gotKeys = append(s.gotKeys, groupKey)
	if s.existingErr != nil {
		return CatchUpExistingItem{}, s.existingErr
	}
	if groupKey == "" || groupKey != s.facts.GroupKey {
		return CatchUpExistingItem{}, nil // the store's "nothing carries that key"
	}
	return s.existing, nil
}

func (s *fakeCatchUpSource) snapshotKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.gotKeys...)
}

func (s *fakeCatchUpSource) RunFacts(_ context.Context, _ Caller, runID string) (CatchUpRunFacts, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.factsErr != nil {
		return CatchUpRunFacts{}, s.factsErr
	}
	f := s.facts
	f.RunID = runID
	return f, nil
}

// fakeCatchUpTourWriter records every tour that survived validation.
type fakeCatchUpTourWriter struct {
	mu     sync.Mutex
	writes []CatchUpTourWrite
	err    error
}

func (w *fakeCatchUpTourWriter) WriteCatchUpTour(_ context.Context, _ Caller, tour CatchUpTourWrite) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return w.err
	}
	w.writes = append(w.writes, tour)
	return nil
}

func (w *fakeCatchUpTourWriter) snapshot() []CatchUpTourWrite {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]CatchUpTourWrite(nil), w.writes...)
}

type catchUpFixture struct {
	gen    *CatchUpGenerator
	model  *fakeNotesModel
	source *fakeCatchUpSource
	writer *fakeCatchUpTourWriter
	clock  *notesClock
}

func newCatchUpFixture(t *testing.T, answer string, cand CatchUpCandidate, facts CatchUpRunFacts) *catchUpFixture {
	t.Helper()
	model := &fakeNotesModel{answer: answer}
	source := &fakeCatchUpSource{cands: []CatchUpCandidate{cand}, facts: facts}
	writer := &fakeCatchUpTourWriter{}
	clock := &notesClock{now: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)}
	gen := NewCatchUpGenerator(CatchUpDeps{
		Model:  model,
		Source: source,
		Writer: writer,
		Now:    clock.Now,
		Spawn:  func(f func()) { f() }, // synchronous: tests watch the pass itself
	})
	if gen == nil {
		t.Fatal("NewCatchUpGenerator returned nil for a fully wired set of deps")
	}
	return &catchUpFixture{gen: gen, model: model, source: source, writer: writer, clock: clock}
}

func catchUpTestCandidate() CatchUpCandidate {
	return CatchUpCandidate{RunID: "run-1", ProjectID: "proj-1"}
}

func catchUpTestFacts() CatchUpRunFacts {
	return CatchUpRunFacts{
		Status: "completed", Workflow: "issue-to-pr", Title: "Fix the flaky checkout test",
		Goal: "Make checkout.spec.ts green", IssueNumber: 42, PRNumber: 7,
		PRURL: "https://github.com/acme/web/pull/7", Branch: "comm/issue-42-checkout",
		Commits: []string{"abc1234567890abcdef1234567890abcdef123456"},
		Nodes: []CatchUpNodeFact{
			{Key: "implement", Status: "succeeded"},
			{Key: "tests", Status: "failed", ErrorClass: "test_failure",
				Error: "2 retries failed on the same timeout"},
		},
		HadCodeRefs: true,
	}
}

func catchUpAnswerJSON(stops string, extra ...string) string {
	head := `{"shape":"pr","title":"Fix the flaky checkout test","summary":"Checkout test made green behind PR #7.",` +
		`"resolution":"branch_ready","reason":"First telling of this run."`
	if len(extra) > 0 {
		head += "," + strings.Join(extra, ",")
	}
	return head + `,"stops":` + stops + `}`
}

func TestCatchUpGenerateCopiesEvidenceTheServerWasShown(t *testing.T) {
	answer := catchUpAnswerJSON(`[{"id":"why-red","title":"The test was red on a timeout","narrative":"The checkout test timed out twice before anyone looked.","kind":"BUG · FOUND","importance":"must_know","evidence_ids":["E2","E99"]}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	writes := f.writer.snapshot()
	if len(writes) != 1 {
		t.Fatalf("writes = %d, want 1", len(writes))
	}
	w := writes[0]
	if len(w.Stops) != 1 || len(w.Stops[0].Evidence) != 1 {
		t.Fatalf("evidence not copied: %+v", w.Stops)
	}
	ev := w.Stops[0].Evidence[0]
	// E2 is the node-error excerpt (E1 is the files excerpt of outputs): the
	// server copied its kind and text; E99 was never in the block and is
	// gone without an error.
	if ev.Type != CatchUpEvidenceKindLog {
		t.Fatalf("evidence type = %q, want log (copied from the excerpt)", ev.Type)
	}
	text, _ := ev.Payload["text"].(string)
	if !strings.Contains(text, "node tests") || !strings.Contains(text, "timeout") {
		t.Fatalf("evidence text = %q, want the cited excerpt copied", text)
	}
	if _, smuggled := ev.Payload["type"]; smuggled {
		t.Fatal("payload carries its own type member")
	}
	// Refs come from the facts, never from the model.
	if len(w.Refs.IssueNumbers) != 1 || w.Refs.IssueNumbers[0] != 42 ||
		len(w.Refs.PRNumbers) != 1 || w.Refs.PRNumbers[0] != 7 ||
		len(w.Refs.CommitSHAs) != 1 || len(w.Refs.RunIDs) != 1 || w.Refs.RunIDs[0] != "run-1" {
		t.Fatalf("refs = %+v, want the run's own outputs", w.Refs)
	}
	if w.Shape != "pr" || w.Resolution != "branch_ready" || w.ExistingID != "" {
		t.Fatalf("header = %+v", w)
	}
}

func TestCatchUpGenerateIgnoresInventedRefs(t *testing.T) {
	// The answer carries members the contract does not have — refs and a PR
	// number of its own. The generator has nowhere to read them, so the
	// write carries ONLY what the run's outputs named.
	answer := catchUpAnswerJSON(
		`[{"id":"a","title":"Beat","narrative":"Narrative.","importance":"routine"}]`,
		`"refs":{"pr_numbers":[9999],"issue_numbers":[9999]}`, `"pr_number":9999`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	w := f.writer.snapshot()[0]
	for _, n := range w.Refs.PRNumbers {
		if n == 9999 {
			t.Fatalf("invented PR number survived into refs: %+v", w.Refs)
		}
	}
	if len(w.Refs.PRNumbers) != 1 || w.Refs.PRNumbers[0] != 7 {
		t.Fatalf("refs = %+v, want only the run's own PR 7", w.Refs)
	}
}

func TestCatchUpGenerateWritesNothingOnMalformedJSON(t *testing.T) {
	for _, raw := range []string{"", "not json at all", `{"shape":"pr"`, `{"shape":"pr"}}`,
		`[{"shape":"pr"},{"shape":"issue"}]`} {
		f := newCatchUpFixture(t, raw, catchUpTestCandidate(), catchUpTestFacts())
		if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err == nil {
			t.Fatalf("malformed answer %q accepted", raw)
		}
		if got := f.writer.snapshot(); len(got) != 0 {
			t.Fatalf("malformed answer %q wrote %d tours, want 0", raw, len(got))
		}
	}
}

// TestCatchUpGenerateRefusesOutsideTheVocabularies pins what a vocabulary
// miss still costs — and what it no longer costs. A stop whose importance is
// a near-miss is dropped (it drives shared ranking); if it was the only
// stop, nothing is written. Shape and resolution, by contrast, are SERVER
// FACTS (the lab's model sometimes omits `resolution` entirely): an invalid
// value there is overridden by the derived one, not a reason to throw a
// complete answer away.
func TestCatchUpGenerateRefusesOutsideTheVocabularies(t *testing.T) {
	badShape := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`,
		fmt.Sprintf(`"shape":"commit"`))
	f := newCatchUpFixture(t, badShape, catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("shape commit: %v, want the server's shape to win", err)
	}
	if w := f.writer.snapshot()[0]; w.Shape != "issue" {
		t.Fatalf("write shape = %q, want the facts' issue (issue #42 names the work)", w.Shape)
	}
	badResolution := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`,
		`"resolution":"shipped"`)
	f1 := newCatchUpFixture(t, badResolution, catchUpTestCandidate(), catchUpTestFacts())
	if err := f1.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("resolution shipped: %v, want the server's resolution to win", err)
	}
	if w := f1.writer.snapshot()[0]; w.Resolution != "open" {
		t.Fatalf("resolution = %q, want the facts' open", w.Resolution)
	}
	// A stop whose importance is a near-miss is dropped; if it was the only
	// stop, nothing is written.
	badImportance := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"important"}]`)
	f2 := newCatchUpFixture(t, badImportance, catchUpTestCandidate(), catchUpTestFacts())
	if err := f2.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err == nil {
		t.Fatal("importance important accepted")
	}
	if got := f2.writer.snapshot(); len(got) != 0 {
		t.Fatalf("vocabulary refusal wrote %d tours, want 0", len(got))
	}
}

// catchUpAnswerWithout is the lab's regression verbatim: an answer that
// simply does not carry shape/resolution members, because the model had
// nothing to say about facts it could not see.
func catchUpAnswerWithout(stops string, head ...string) string {
	parts := append([]string{
		`"title":"Fix the flaky checkout test"`,
		`"summary":"Checkout test made green behind PR #7."`,
		`"reason":"First telling of this run."`}, head...)
	return `{` + strings.Join(parts, ",") + `,"stops":` + stops + `}`
}

// TestCatchUpGenerateDerivesResolutionAndShapeWhenOmitted is the resolution
// rule as a server fact: a failed run is run_failed whatever it left, a PR
// ref is open (merge state is not knowable here), branch/commits without a
// PR is branch_ready, and nothing naming code is no_code. The shape follows
// the same refs: issue first, then pr, then push — with `issue` the
// documented last resort when nothing names anything.
func TestCatchUpGenerateDerivesResolutionAndShapeWhenOmitted(t *testing.T) {
	answer := catchUpAnswerWithout(`[{"id":"a","title":"Beat","narrative":"Narrative.","importance":"routine"}]`)
	for _, tc := range []struct {
		name                      string
		mutate                    func(*CatchUpRunFacts)
		wantResolution, wantShape string
	}{
		{"failed run", func(f *CatchUpRunFacts) { f.Status = "failed" }, "run_failed", "issue"},
		{"interrupted run", func(f *CatchUpRunFacts) { f.Status = "interrupted" }, "run_failed", "issue"},
		{"pr only", func(f *CatchUpRunFacts) { f.IssueNumber = 0 }, "open", "pr"},
		{"branch and commits", func(f *CatchUpRunFacts) {
			f.IssueNumber, f.PRNumber, f.PRURL = 0, 0, ""
		}, "branch_ready", "push"},
		{"issue only", func(f *CatchUpRunFacts) {
			f.PRNumber, f.PRURL, f.Branch, f.Commits = 0, "", "", nil
		}, "no_code", "issue"},
		{"nothing at all", func(f *CatchUpRunFacts) {
			f.IssueNumber, f.PRNumber, f.PRURL, f.Branch, f.Commits = 0, 0, "", "", nil
		}, "no_code", "issue"},
		{"issue over pr", nil, "open", "issue"},
	} {
		facts := catchUpTestFacts()
		if tc.mutate != nil {
			tc.mutate(&facts)
		}
		f := newCatchUpFixture(t, answer, catchUpTestCandidate(), facts)
		if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
			t.Fatalf("%s: omitted answer refused: %v", tc.name, err)
		}
		w := f.writer.snapshot()[0]
		if w.Resolution != tc.wantResolution || w.Shape != tc.wantShape {
			t.Fatalf("%s: %q/%q, want %q/%q", tc.name, w.Resolution, w.Shape,
				tc.wantResolution, tc.wantShape)
		}
	}
}

// TestCatchUpGenerateServerFactsBeatUnfoundedClaims pins the other half:
// the model's value is used only when the facts back the exact claim the
// word makes. merged is believed on a real PR ref (merge state is unknowable
// — the claim is not refutable), refused without one; no fate word outranks
// a run the facts say ended failed; and shape needs the ref it names.
func TestCatchUpGenerateServerFactsBeatUnfoundedClaims(t *testing.T) {
	stops := `[{"id":"a","title":"Beat","narrative":"Narrative.","importance":"routine"}]`
	// merged on a PR that exists: the server cannot verify it either way.
	f := newCatchUpFixture(t, catchUpAnswerJSON(stops, `"resolution":"merged"`, `"shape":"issue"`),
		catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("merged on a PR: %v", err)
	}
	if w := f.writer.snapshot()[0]; w.Resolution != "merged" || w.Shape != "issue" {
		t.Fatalf("write = %q/%q, want merged (unrefutable on PR #7) and issue (ref exists)",
			w.Resolution, w.Shape)
	}
	// merged with no PR anywhere: an invented fate loses to the facts.
	facts := catchUpTestFacts()
	facts.PRNumber, facts.PRURL = 0, ""
	f = newCatchUpFixture(t, catchUpAnswerJSON(stops, `"resolution":"merged"`),
		catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("merged without a PR: %v", err)
	}
	if w := f.writer.snapshot()[0]; w.Resolution != "branch_ready" {
		t.Fatalf("resolution = %q, want the facts' branch_ready", w.Resolution)
	}
	// run_failed claimed on a run that completed: the run's own status wins.
	f = newCatchUpFixture(t, catchUpAnswerJSON(stops, `"resolution":"run_failed"`),
		catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("run_failed on a completed run: %v", err)
	}
	if w := f.writer.snapshot()[0]; w.Resolution != "open" {
		t.Fatalf("resolution = %q, want the facts' open", w.Resolution)
	}
	// shape push with no code refs: unfounded, and the last-resort issue wins.
	facts = catchUpTestFacts()
	facts.IssueNumber, facts.PRNumber, facts.PRURL, facts.Branch, facts.Commits = 0, 0, "", "", nil
	f = newCatchUpFixture(t, catchUpAnswerJSON(stops, `"shape":"push"`, `"resolution":"no_code"`),
		catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("push with no code: %v", err)
	}
	if w := f.writer.snapshot()[0]; w.Shape != "issue" || w.Resolution != "no_code" {
		t.Fatalf("write = %q/%q, want the last-resort issue beside no_code", w.Shape, w.Resolution)
	}
}

func (m *fakeNotesModel) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func TestCatchUpPassHonoursPerRunCooldown(t *testing.T) {
	answer := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), catchUpTestFacts())
	caller := Caller{UserID: "u1", OrganizationID: "o1"}
	f.gen.Pass(context.Background(), caller, nil)
	f.gen.Pass(context.Background(), caller, nil) // same instant: cooldown holds
	if calls := f.model.callCount(); calls != 1 {
		t.Fatalf("model calls = %d, want 1 across the cooldown", calls)
	}
	f.clock.Advance(CatchUpGenCooldown + time.Minute)
	f.gen.Pass(context.Background(), caller, nil)
	if calls := f.model.callCount(); calls != 2 {
		t.Fatalf("model calls = %d, want 2 after the cooldown expired", calls)
	}
	// A FAILING model is not hammered either: the attempt spent the cooldown
	// whether or not a tour came out of it.
	f.model.mu.Lock()
	f.model.answer = "garbage"
	f.model.mu.Unlock()
	f.clock.Advance(CatchUpGenCooldown + time.Minute)
	f.gen.Pass(context.Background(), caller, nil)
	f.gen.Pass(context.Background(), caller, nil)
	if calls := f.model.callCount(); calls != 3 {
		t.Fatalf("failing model calls = %d, want exactly one per cooldown window", calls)
	}
}

func TestCatchUpPassCapsGenerationsPerPass(t *testing.T) {
	answer := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), catchUpTestFacts())
	f.source.mu.Lock()
	f.source.cands = []CatchUpCandidate{
		{RunID: "r1", ProjectID: "p1"}, {RunID: "r2", ProjectID: "p1"},
		{RunID: "r3", ProjectID: "p1"}, {RunID: "r4", ProjectID: "p1"},
	}
	f.source.mu.Unlock()
	f.gen.Pass(context.Background(), Caller{}, []string{"p1"})
	if got := len(f.writer.snapshot()); got != CatchUpGenMaxPerPass {
		t.Fatalf("wrote %d tours, want at most %d per pass", got, CatchUpGenMaxPerPass)
	}
	if projects := f.source.gotProjects; len(projects) != 1 || projects[0] != "p1" {
		t.Fatalf("candidate read lost the caller's project scope: %v", projects)
	}
}

// The per-replica global cap (ADR-0078 § Migration, Trigger note): the
// sidebar badge made the list read hot on every page, so the per-run
// cooldown alone still let a lab full of page loads spend the gateway's rate
// limit. Generation now spends at most MaxModelCallsPerWindow model calls
// per CatchUpGenModelCallWindow for the whole replica, a cap that refuses a
// pass logs one line, and a cap of 0 turns generation off entirely.
func TestCatchUpPassHonoursGlobalModelCallCap(t *testing.T) {
	answer := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`)
	model := &fakeNotesModel{answer: answer}
	source := &fakeCatchUpSource{facts: catchUpTestFacts(), cands: []CatchUpCandidate{
		{RunID: "r1", ProjectID: "p1"}, {RunID: "r2", ProjectID: "p1"},
		{RunID: "r3", ProjectID: "p1"}, {RunID: "r4", ProjectID: "p1"},
	}}
	writer := &fakeCatchUpTourWriter{}
	clock := &notesClock{now: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)}
	var logs bytes.Buffer
	perWindow := 2
	gen := NewCatchUpGenerator(CatchUpDeps{
		Model: model, Source: source, Writer: writer,
		Now:                    clock.Now,
		Spawn:                  func(f func()) { f() },
		Log:                    slog.New(slog.NewTextHandler(&logs, nil)),
		Cooldown:               2 * time.Minute, // per-run floor below the cap window
		MaxModelCallsPerWindow: &perWindow,
	})
	if gen == nil {
		t.Fatal("nil generator for fully wired deps")
	}
	// One pass over four eligible runs: the pass CAP would allow two, the
	// window cap allows two — both hold at two model calls.
	gen.Pass(context.Background(), Caller{}, nil)
	if calls := model.callCount(); calls != 2 {
		t.Fatalf("model calls = %d, want 2 under a cap of 2", calls)
	}
	// A second pass inside the same window spends nothing more, however many
	// fresh page loads (visits) schedule it.
	gen.Pass(context.Background(), Caller{}, nil)
	gen.Pass(context.Background(), Caller{}, nil)
	if calls := model.callCount(); calls != 2 {
		t.Fatalf("model calls = %d, want still 2 inside the window", calls)
	}
	if !strings.Contains(logs.String(), "skipped by the model-call cap") {
		t.Fatalf("cap skip logged nothing:\n%s", logs.String())
	}
	// Past the window the budget refills — up to the cap again, not all at once.
	clock.Advance(CatchUpGenModelCallWindow + time.Minute)
	gen.Pass(context.Background(), Caller{}, nil)
	if calls := model.callCount(); calls != 4 {
		t.Fatalf("model calls = %d, want 2 more after the window rolled", calls)
	}
}

func TestCatchUpModelCallCapZeroDisablesGeneration(t *testing.T) {
	answer := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`)
	model := &fakeNotesModel{answer: answer}
	source := &fakeCatchUpSource{facts: catchUpTestFacts(),
		cands: []CatchUpCandidate{{RunID: "r1", ProjectID: "p1"}}}
	writer := &fakeCatchUpTourWriter{}
	var logs bytes.Buffer
	off := 0
	gen := NewCatchUpGenerator(CatchUpDeps{
		Model: model, Source: source, Writer: writer,
		Spawn:                  func(f func()) { f() },
		Log:                    slog.New(slog.NewTextHandler(&logs, nil)),
		MaxModelCallsPerWindow: &off,
	})
	if gen == nil {
		t.Fatal("nil generator for fully wired deps")
	}
	// The visit trigger must not even read candidates, let alone call the
	// model — 0 is the deployment saying "generate nothing at all".
	gen.CatchUpVisitRecorded(context.Background(), Caller{}, nil)
	gen.Pass(context.Background(), Caller{}, nil)
	if calls := model.callCount(); calls != 0 {
		t.Fatalf("model calls = %d, want 0 with the cap at zero", calls)
	}
	if got := len(writer.snapshot()); got != 0 {
		t.Fatalf("writes = %d, want 0 with the cap at zero", got)
	}
	if !strings.Contains(logs.String(), "skipped by the model-call cap") {
		t.Fatalf("a disabled cap logged nothing:\n%s", logs.String())
	}
}

func TestCatchUpDecisionSurvivesOnlyWithAThread(t *testing.T) {
	decision := `"decision":{"prompt":"Should this have gone to stable or latest?","options":["stable","latest"],"allow_text":true}`
	answer := catchUpAnswerJSON(fmt.Sprintf(
		`[{"id":"a","title":"T","narrative":"N.","importance":"worth_a_look",%s}]`, decision))

	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	if w := f.writer.snapshot()[0]; w.Stops[0].Decision != nil {
		t.Fatal("decision survived a work item with no conversation")
	}

	cand := catchUpTestCandidate()
	cand.ConversationID = "conv-1"
	if err := f.gen.GenerateRun(context.Background(), Caller{}, cand); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	writes := f.writer.snapshot()
	d := writes[len(writes)-1].Stops[0].Decision
	if d == nil || d.Prompt == "" || len(d.Options) != 2 || !d.AllowText {
		t.Fatalf("decision not kept with a thread to answer it: %+v", writes[len(writes)-1].Stops[0])
	}
	// A decision with too many options is dropped whole (the domain refuses
	// 5 options; the generator must not hand one over).
	bigAnswer := catchUpAnswerJSON(fmt.Sprintf(
		`[{"id":"a","title":"T","narrative":"N.","importance":"routine","decision":{"prompt":"P","options":["a","b","c","d","e"],"allow_text":false}}]`))
	f2 := newCatchUpFixture(t, bigAnswer, cand, catchUpTestFacts())
	if err := f2.gen.GenerateRun(context.Background(), Caller{}, cand); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	if f2.writer.snapshot()[0].Stops[0].Decision != nil {
		t.Fatal("5-option decision survived")
	}
}

func TestCatchUpStableIdsAcrossARewrite(t *testing.T) {
	// The item's tour head carries "auth-fix" (introduced at v1) and a beat
	// the rewrite drops. The answer repeats the auth beat with different
	// case and spacing — and a model-chosen id of its own — plus one new
	// beat. The auth beat must KEEP its id and its introducing version; the
	// new beat is stamped at the new version (TourHead+1 = 3).
	cand := CatchUpCandidate{
		RunID: "run-1", ProjectID: "proj-1", ItemID: "item-9", TourHead: 2,
		ConversationID: "conv-1",
		HeadStops: []CatchUpExistingStop{
			{ID: "auth-fix", Title: "Auth fix landed", AddedInVersion: 1},
			{ID: "gone-beat", Title: "A beat the rewrite drops", AddedInVersion: 2},
		},
	}
	answer := catchUpAnswerJSON(`[` +
		`{"id":"totally-different","title":"  AUTH fix  landed ","narrative":"It still holds.","importance":"must_know"},` +
		`{"id":"new-beat","title":"Follow-up landed on main","narrative":"A commit straight to main.","importance":"must_know"}` +
		`]`)
	f := newCatchUpFixture(t, answer, cand, catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, cand); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	w := f.writer.snapshot()[0]
	if w.ExistingID != "item-9" {
		t.Fatalf("rewrite must revise the existing item, got %q", w.ExistingID)
	}
	if len(w.Stops) != 2 {
		t.Fatalf("stops = %d, want 2", len(w.Stops))
	}
	old, fresh := w.Stops[0], w.Stops[1]
	if old.ID != "auth-fix" || old.AddedInVersion != 1 {
		t.Fatalf("title-matched stop lost its id/version: %+v", old)
	}
	if fresh.ID != "new-beat" || fresh.AddedInVersion != 3 {
		t.Fatalf("new stop not stamped at the new version: %+v", fresh)
	}
}

func TestCatchUpStopIDSanitizing(t *testing.T) {
	for _, in := range []string{"", "   ", "auth/../etc", "Auth · Fix 💥 landed"} {
		got := sanitizeCatchUpStopID(in)
		if len(got) > CatchUpGenStopIDMaxChars {
			t.Fatalf("id %q not bounded: %q", in, got)
		}
		if strings.ContainsAny(got, "/ \\  \t") || got != strings.ToLower(got) {
			t.Fatalf("id %q sanitized to unsafe %q", in, got)
		}
	}
	if got := sanitizeCatchUpStopID("Bug/Fix: auth"); got != "bug-fix-auth" {
		t.Fatalf("sanitize = %q, want bug-fix-auth", got)
	}
}

func TestCatchUpNilGeneratorIsTheHonestAbsence(t *testing.T) {
	deps := CatchUpDeps{
		Model:  &fakeNotesModel{answer: "{}"},
		Source: &fakeCatchUpSource{},
		Writer: &fakeCatchUpTourWriter{},
	}
	if g := NewCatchUpGenerator(deps); g == nil {
		t.Fatal("fully wired deps returned nil")
	} else {
		g.CatchUpVisitRecorded(context.Background(), Caller{}, nil) // must not panic
	}
	deps.Model = nil
	if g := NewCatchUpGenerator(deps); g != nil {
		t.Fatal("no model must mean no generator")
	}
	deps = CatchUpDeps{Model: &fakeNotesModel{}, Source: nil, Writer: &fakeCatchUpTourWriter{}}
	if g := NewCatchUpGenerator(deps); g != nil {
		t.Fatal("no reader must mean no generator")
	}
	deps = CatchUpDeps{Model: &fakeNotesModel{}, Source: &fakeCatchUpSource{}, Writer: nil}
	if g := NewCatchUpGenerator(deps); g != nil {
		t.Fatal("no writer must mean no generator")
	}
	var nilGen *CatchUpGenerator
	nilGen.CatchUpVisitRecorded(context.Background(), Caller{}, nil) // trigger on nil: no-op
	nilGen.Pass(context.Background(), Caller{}, nil)
	if err := nilGen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != ErrNotConfigured {
		t.Fatalf("nil generator GenerateRun = %v, want ErrNotConfigured", err)
	}
}

func TestCatchUpDataBlockBoundsAndTruth(t *testing.T) {
	// Every citable line is clipped, and the block must carry the excerpt
	// ids exactly as catchUpDataBlock numbered them — the prompt's whole
	// citation rule rests on that agreement.
	long := strings.Repeat("x", 4000)
	facts := catchUpTestFacts()
	facts.Lines = nil
	for i := 0; i < 40; i++ {
		facts.Lines = append(facts.Lines, ChatLine{Author: fmt.Sprintf("a%d", i), Text: long})
	}
	block, truth, err := catchUpDataBlock(facts, catchUpTestCandidate())
	if err != nil {
		t.Fatal(err)
	}
	if len(block) > catchUpGenDataMaxBytes+2000 {
		t.Fatalf("block unbounded: %d bytes", len(block))
	}
	for id := range truth.excerpts {
		if !strings.Contains(block, `"`+id+`"`) {
			t.Fatalf("truth id %s not in the block that was sent", id)
		}
	}
	if _, ok := truth.excerpts["E1"]; !ok {
		t.Fatal("the outputs excerpt is missing from the truth set")
	}
	if got := truth.excerpts["E1"]; got.Kind != CatchUpEvidenceKindFiles ||
		!strings.Contains(got.Text, "comm/issue-42-checkout") || !strings.Contains(got.Text, "#7") {
		t.Fatalf("outputs excerpt = %+v, want the branch and PR named", got)
	}
}

// TestCatchUpRewriteOfAGroupedItem is the grouping promise end to end inside
// the generator: a run whose refs name issue 42 finds the item that the FIRST
// run on issue 42 wrote, is asked to rewrite THAT story, and writes back
// version 2 with the old beats' identities intact and only the genuinely new
// beat stamped as added. This is what makes the UI's ADDED tags and UPDATED
// badge mean "the same piece of work moved" rather than "two pieces of work".
func TestCatchUpRewriteOfAGroupedItem(t *testing.T) {
	cand := CatchUpCandidate{RunID: "run-2", ProjectID: "proj-1"}
	facts := catchUpTestFacts()
	facts.GroupKey = "issue:repo-1:42"
	head := CatchUpExistingItem{
		ItemID: "item-9", ConversationID: "conv-work", TourHead: 1,
		HeadReason: "First telling of the failed run.",
		HeadStops: []CatchUpExistingStop{
			{ID: "why-red", Title: "The test was red on a timeout",
				Kind: "BUG \u00b7 FOUND", Importance: "must_know", AddedInVersion: 1},
			{ID: "dropped", Title: "A beat the rewrite leaves behind",
				Kind: "routine", Importance: "routine", AddedInVersion: 1},
		},
	}
	// The rewrite keeps "The test was red on a timeout" (a beat whose title
	// survived is the SAME beat: its id and its introducing version come from
	// the head) and adds the fix, which is the only ADDED stop.
	answer := catchUpAnswerJSON(`[`+
		`{"id":"why-red-again","title":"The test was red on a timeout","narrative":"Still the cause: the fixture outlived its token.","importance":"must_know"},`+
		`{"id":"fix-landed","title":"The fix landed in PR #7","narrative":"The second run shipped the retry guard.","importance":"must_know"}`+
		`]`, `"reason":"Fix landed after the failed run."`)
	f := newCatchUpFixture(t, answer, cand, facts)
	f.source.mu.Lock()
	f.source.existing = head
	f.source.mu.Unlock()

	if err := f.gen.GenerateRun(context.Background(), Caller{}, cand); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	w := f.writer.snapshot()[0]
	if w.GroupKey != "issue:repo-1:42" {
		t.Errorf("write lost the group key: %q", w.GroupKey)
	}
	if w.ExistingID != "item-9" {
		t.Errorf("ExistingID = %q, want the grouped item the reader is already reading", w.ExistingID)
	}
	if w.ConversationID != "conv-work" {
		t.Errorf("ConversationID = %q, want the thread the work was born in", w.ConversationID)
	}
	if w.Reason != "Fix landed after the failed run." {
		t.Errorf("reason = %q, want what changed since version 1", w.Reason)
	}
	if len(w.Stops) != 2 {
		t.Fatalf("stops = %+v, want the carried beat and the new one", w.Stops)
	}
	if w.Stops[0].ID != "why-red" || w.Stops[0].AddedInVersion != 1 {
		t.Errorf("carried stop lost its identity: %+v", w.Stops[0])
	}
	if w.Stops[1].ID != "fix-landed" || w.Stops[1].AddedInVersion != 2 {
		t.Errorf("new stop not ADDED at version 2: %+v", w.Stops[1])
	}

	// The prompt showed the previous tour by TITLE, KIND and IMPORTANCE — and
	// not its prose, which is the difference between carrying a story forward
	// and paraphrasing oneself.
	_, user, _ := f.model.snapshot()
	for _, want := range []string{`"previous_tour"`, "The test was red on a timeout",
		"must_know", "First telling of the failed run."} {
		if !strings.Contains(user, want) {
			t.Errorf("prompt block is missing %q:\n%s", want, user)
		}
	}
	if strings.Contains(user, "outlived its token") {
		t.Error("the previous tour's narrative rode into the prompt")
	}
}

// TestCatchUpFirstTellingHasNoPreviousTour pins the other half: a run whose
// group key names nothing yet is told as the first story, so no previous tour
// rides in the block, no stop claims an older version, and the run is
// generated against its own key.
func TestCatchUpFirstTellingHasNoPreviousTour(t *testing.T) {
	cand := CatchUpCandidate{RunID: "run-1", ProjectID: "proj-1"}
	facts := catchUpTestFacts()
	facts.GroupKey = "issue:repo-1:42"
	answer := catchUpAnswerJSON(
		`[{"id":"a","title":"Beat","narrative":"Narrative.","importance":"routine"}]`)
	f := newCatchUpFixture(t, answer, cand, facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, cand); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	if keys := f.source.snapshotKeys(); len(keys) != 1 || keys[0] != "issue:repo-1:42" {
		t.Fatalf("group lookups = %v, want the run's own key", keys)
	}
	w := f.writer.snapshot()[0]
	if w.ExistingID != "" {
		t.Errorf("ExistingID = %q, want a new item", w.ExistingID)
	}
	if w.Stops[0].AddedInVersion != 1 {
		t.Errorf("first telling stamped version %d, want 1", w.Stops[0].AddedInVersion)
	}
	_, user, _ := f.model.snapshot()
	if strings.Contains(user, `\"previous_tour\"`) {
		t.Errorf("a first telling carried a previous tour:\n%s", user)
	}
}

// TestCatchUpRunWithoutRefsKeepsItsOwnItem is the identity rule for the run
// that names no number: its key IS itself, so no other run's story is
// rewritten and the item stays its own piece of work.
func TestCatchUpRunWithoutRefsKeepsItsOwnItem(t *testing.T) {
	facts := catchUpTestFacts()
	facts.IssueNumber, facts.PRNumber, facts.PRURL, facts.Branch = 0, 0, "", ""
	facts.HadCodeRefs = false
	facts.GroupKey = "run:run-7"
	answer := catchUpAnswerJSON(
		`[{"id":"a","title":"Beat","narrative":"Narrative.","importance":"routine"}]`)
	f := newCatchUpFixture(t, answer, CatchUpCandidate{RunID: "run-7", ProjectID: "p"}, facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{},
		CatchUpCandidate{RunID: "run-7", ProjectID: "p"}); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	w := f.writer.snapshot()[0]
	if w.GroupKey != "run:run-7" {
		t.Errorf("group key = %q, want the run itself", w.GroupKey)
	}
	if len(w.Refs.IssueNumbers) != 0 || len(w.Refs.PRNumbers) != 0 {
		t.Errorf("refs named numbers the run never produced: %+v", w.Refs)
	}
}

func TestCatchUpPromptNamesTheRules(t *testing.T) {
	system, user := CatchUpGenPrompt(`{"run":{"run":"r"}}`)
	for _, want := range []string{"must_know", "auth or security", "data migration",
		"public API", "new dependency", "tests weakened", "straight to the main branch",
		"approved plan", "found", "cause", "untrusted", "Never invent"} {
		if !strings.Contains(strings.ToLower(system), strings.ToLower(want)) {
			t.Fatalf("system prompt is missing %q", want)
		}
	}
	if !strings.Contains(user, "<DATA>") {
		t.Fatal("user turn does not quote the DATA block")
	}
	// The answer shape round-trips through encoding/json at least as far as
	// our strict parse: an unknown member must be IGNORED (the invented-refs
	// rule), not crash the decoder.
	raw := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`, `"totally_new_member":1`)
	if _, err := ParseCatchUpAnswer(raw); err != nil {
		t.Fatalf("unknown member refused instead of ignored: %v", err)
	}
}
