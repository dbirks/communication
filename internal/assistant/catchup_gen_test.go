package assistant

// ADR-0078 § Migration: the catch-up tour generator. These tests pin what
// the generator PROMISES: evidence is copied by the server from the block
// (unknown ids dropped), refs are derived from the run's outputs and never
// from the answer, a malformed answer writes NOTHING, a per-run cooldown
// keeps a failing model from being hammered, a decision without a thread to
// answer it is dropped, and a rewrite inherits the id (and introducing
// version) of every beat whose title survived — the stable-id hinge the
// whole seen-state design hangs on. The store side (the race-safe append,
// the document validation) is already proven against real PostgreSQL in
// internal/store/postgres/catch_up_test.go.

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCatchUpSource serves one candidate list and one facts row.
type fakeCatchUpSource struct {
	mu          sync.Mutex
	cands       []CatchUpCandidate
	facts       CatchUpRunFacts
	candErr     error
	factsErr    error
	gotProjects []string
	calls       int
}

func (s *fakeCatchUpSource) CandidateRuns(_ context.Context, _ Caller, projectIDs []string) ([]CatchUpCandidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gotProjects = projectIDs
	s.calls++
	return s.cands, s.candErr
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

func TestCatchUpGenerateRefusesOutsideTheVocabularies(t *testing.T) {
	badShape := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"routine"}]`,
		fmt.Sprintf(`"shape":"commit"`))
	f := newCatchUpFixture(t, badShape, catchUpTestCandidate(), catchUpTestFacts())
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err == nil {
		t.Fatal("shape commit accepted")
	}
	// A stop whose importance is a near-miss is dropped; if it was the only
	// stop, nothing is written.
	badImportance := catchUpAnswerJSON(`[{"id":"a","title":"T","narrative":"N.","importance":"important"}]`)
	f2 := newCatchUpFixture(t, badImportance, catchUpTestCandidate(), catchUpTestFacts())
	if err := f2.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err == nil {
		t.Fatal("importance important accepted")
	}
	if got := f2.writer.snapshot(); len(got) != 0 {
		t.Fatalf("vocabulary refusal wrote %d tours", len(got))
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
		g.CatchUpItemsListed(context.Background(), Caller{}, nil) // must not panic
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
	nilGen.CatchUpItemsListed(context.Background(), Caller{}, nil) // trigger on nil: no-op
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
	block, truth, err := catchUpDataBlock(facts)
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
