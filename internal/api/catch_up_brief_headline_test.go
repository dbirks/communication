package api

// ADR-0081 § The model's job at the route: the brief's LISTS ship from the read,
// and the headline beside them is `ready` (the cache holds an answer), `pending`
// (this read started the generation in the background) or `unavailable` (no
// model, or the generator refused). The read never waits on a completion and the
// page never gets a placeholder dressed as news.
//
// The generator's own rules — the prompt, the truth set, the one corrective
// re-ask, the secret gate — are pinned in
// internal/assistant/catchup_brief_test.go. What is pinned here is the wiring:
// which state the route answers with, the (reader, window, brief digest) cache,
// the at-most-one-in-flight rule, and by_project re-keyed onto the chips THIS
// read carries.

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// cuHeadlineModel is a fake egress: it answers from a script, may be gated so a
// test can hold a generation open, and records its calls under a mutex because
// the generator runs on a detached background context.
type cuHeadlineModel struct {
	mu      sync.Mutex
	answers []string
	gate    chan struct{} // when non-nil, every call waits for it to close
	calls   int
	users   []string
}

func (m *cuHeadlineModel) CompleteText(ctx context.Context, _, user string) (string, *assistant.Failure) {
	m.mu.Lock()
	m.calls++
	m.users = append(m.users, user)
	m.mu.Unlock()
	if m.gate != nil {
		select {
		case <-m.gate:
		case <-ctx.Done():
			return "", &assistant.Failure{Code: assistant.FailModelTimeout,
				Detail: "the test held the generation open past its deadline", Status: 504}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	i := m.calls - 1
	if i >= len(m.answers) {
		i = len(m.answers) - 1
	}
	if i < 0 {
		return "", &assistant.Failure{Code: assistant.FailBadModelResponse,
			Detail: "the test script has no answer left", Status: 502}
	}
	return m.answers[i], nil
}

func (m *cuHeadlineModel) called() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

// cuBriefServerWith mounts the surface WITH the headline generator.
func cuBriefServerWith(t *testing.T, store *fakeBrief, gen CatchUpHeadlineGenerator) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterCatchUp(s, store, nil, WithCatchUpHeadlineGenerator(gen))
	return s
}

// cuBriefWithWork is a 24h window with rows in three sections across two
// projects: enough that the headline has a story and by_project is owed.
func cuBriefWithWork() *fakeBrief {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	one, two := cuChip(), CatchUpProjectChip{ID: cuOtherID, Name: "Docs", Color: "#222"}
	return &fakeBrief{
		approvals: []CatchUpBriefNeed{{
			Kind: CatchUpNeedApproval, Title: "Rate limiter gate", Project: one,
			Link: "/approvals/a1", At: now.Add(-3 * time.Hour),
		}, {
			Kind: CatchUpNeedApproval, Title: "Release cut gate", Project: two,
			Link: "/approvals/a2", At: now.Add(-1 * time.Hour),
		}},
		broke: []CatchUpBriefBroke{{
			Title: "Release pipeline", Project: one, Failures: 3,
			ErrorClass: "test", StillFailing: true, Link: "/pipelines/rel",
		}},
		nodes: []CatchUpBriefRunNode{{
			RunID: "r1", Title: "Typo sweep", Status: "succeeded", By: "david",
			FinishedAt: now.Add(-2 * time.Hour), Project: two, NodeKey: "open_pr",
			Outputs: []byte(`{"pr_url":"https://example.invalid/1","pr_number":7}`),
		}},
		counts: CatchUpBriefNumbers{
			Runs:      CatchUpBriefRunCounts{Succeeded: 1, Failed: 3},
			Approvals: CatchUpBriefApprovalCounts{Pending: 2},
		},
	}
}

// cuGoodHeadline quotes only titles the brief carries and names the OLDEST
// needs_you row, as the rubric requires.
const cuGoodHeadline = `{"headline":"2 gates wait on you: \"Rate limiter gate\" is the` +
	` oldest, and \"Release pipeline\" is still failing.","by_project":[]}`

const cuQuietSentence = "Quiet stretch: nothing changed in the projects you follow."

// cuBriefGet reads the brief once.
func cuBriefGet(t *testing.T, s *Server, window string) map[string]any {
	t.Helper()
	rec := cuGet(t, s, cuBase+"/api/v1/catch-up/brief?window="+window)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)
}

func cuHeadlineOf(t *testing.T, body map[string]any) (text, state string) {
	t.Helper()
	h, ok := body["headline"].(map[string]any)
	if !ok {
		t.Fatalf("headline is not an object: %v", body["headline"])
	}
	text, _ = h["text"].(string)
	state, _ = h["state"].(string)
	return text, state
}

// cuWaitHeadline polls the brief until the headline leaves `pending` (or the
// clock runs out): the background generation is the design, so a test asserts
// the END state rather than racing it.
func cuWaitHeadline(t *testing.T, s *Server, window, wantState string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var body map[string]any
	var state string
	for time.Now().Before(deadline) {
		body = cuBriefGet(t, s, window)
		_, state = cuHeadlineOf(t, body)
		if state == wantState {
			return body
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("headline state after 5s = %q, want %q (body: %v)", state, wantState, body["headline"])
	return nil
}

// The page's own first read must not wait on the model: the lists are complete
// in that response and the headline says it is on its way.
func TestCatchUpBriefHeadlineIsPendingThenReady(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}, gate: make(chan struct{})}
	store := cuBriefWithWork()
	s := cuBriefServerWith(t, store, NewCatchUpHeadlineGenerator(model))

	body := cuBriefGet(t, s, "24h")
	text, state := cuHeadlineOf(t, body)
	if state != CatchUpHeadlinePending {
		t.Fatalf("first headline state = %q, want pending", state)
	}
	if text != "" {
		t.Errorf("a pending headline carries text %q", text)
	}
	// The sections did not wait for it.
	needs, _ := body["needs_you"].([]any)
	if len(needs) != 2 {
		t.Errorf("needs_you = %v, want the two gates in the first response", body["needs_you"])
	}

	close(model.gate)
	body = cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
	text, _ = cuHeadlineOf(t, body)
	if !strings.Contains(text, "Rate limiter gate") {
		t.Errorf("ready headline = %q", text)
	}
	if model.called() != 1 {
		t.Errorf("model calls = %d, want 1", model.called())
	}
}

// The cache is the reason a page may reload this route on every focus: the same
// brief digest is one completion, and a brief that changed is a new question.
func TestCatchUpBriefHeadlineCacheHitsTheSameDigest(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}}
	store := cuBriefWithWork()
	s := cuBriefServerWith(t, store, NewCatchUpHeadlineGenerator(model))

	cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
	if got := model.called(); got != 1 {
		t.Fatalf("model calls after the first answer = %d, want 1", got)
	}
	// Same reader, same window, same rows: the answer is served from the cache,
	// with no second completion — even though window.since moved with the clock.
	body := cuBriefGet(t, s, "24h")
	text, state := cuHeadlineOf(t, body)
	if state != CatchUpHeadlineReady || !strings.Contains(text, "Rate limiter gate") {
		t.Fatalf("cached headline = %q/%q", text, state)
	}
	if got := model.called(); got != 1 {
		t.Fatalf("model calls on a cache hit = %d, want 1", got)
	}

	// A new gate is a different brief: the digest moves and the headline is
	// regenerated rather than reused under a stale claim.
	store.approvals = append(store.approvals, CatchUpBriefNeed{
		Kind: CatchUpNeedApproval, Title: "Docs rebuild gate", Project: cuChip(),
		Link: "/approvals/a3", At: time.Now().UTC().Add(-10 * time.Minute),
	})
	cuBriefGet(t, s, "24h") // the read that notices the new gate
	cuWaitCalls(t, model, 2)
	cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
}

// A second read while a generation is in flight must not buy a second
// completion for the same digest.
func TestCatchUpBriefHeadlineDoublesUpOnlyOnce(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}, gate: make(chan struct{})}
	s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
	for i := 0; i < 5; i++ {
		_, state := cuHeadlineOf(t, cuBriefGet(t, s, "24h"))
		if state != CatchUpHeadlinePending {
			t.Fatalf("read %d headline state = %q, want pending", i, state)
		}
	}
	// The one generation it did buy is still the only one in flight: the calls
	// counter reaches 1 (the goroutine blocks on the gate after incrementing) and
	// no read behind it adds a second.
	cuWaitCalls(t, model, 1)
	if got := model.called(); got != 1 {
		t.Fatalf("model calls behind five reads = %d, want 1", got)
	}
	close(model.gate)
	cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
	if got := model.called(); got != 1 {
		t.Fatalf("model calls after settling = %d, want 1", got)
	}
}

// The quiet case is not a model question at all: the read knows nothing happened
// and says so in the one sentence the design fixed.
func TestCatchUpBriefHeadlineQuietBriefIsReadyWithoutAModel(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{`{"headline":"should never be asked","by_project":[]}`}}
	s := cuBriefServerWith(t, &fakeBrief{}, NewCatchUpHeadlineGenerator(model))
	body := cuBriefGet(t, s, "7d")
	text, state := cuHeadlineOf(t, body)
	if state != CatchUpHeadlineReady {
		t.Fatalf("quiet headline state = %q, want ready", state)
	}
	if text != cuQuietSentence {
		t.Errorf("quiet headline = %q, want the exact sentence", text)
	}
	if by, ok := body["by_project"].([]any); !ok || len(by) != 0 {
		t.Errorf("by_project = %v, want an empty array", body["by_project"])
	}
	if got := model.called(); got != 0 {
		t.Errorf("model calls = %d, want 0", got)
	}
}

// A refused headline is `unavailable` with nothing in `text`, and the sections
// stand on their own: the honest absence, never a placeholder.
func TestCatchUpBriefHeadlineRefusalIsUnavailable(t *testing.T) {
	const invented = `{"headline":"2 gates wait on you: \"Rate limiter gate\" is the` +
		` oldest, and \"Database partitioning\" shipped.","by_project":[]}`
	model := &cuHeadlineModel{answers: []string{invented}}
	s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
	body := cuWaitHeadline(t, s, "24h", CatchUpHeadlineUnavailable)
	text, _ := cuHeadlineOf(t, body)
	if text != "" {
		t.Errorf("unavailable headline carries text %q", text)
	}
	if needs, _ := body["needs_you"].([]any); len(needs) != 2 {
		t.Errorf("needs_you = %v, want the lists to stand without a headline", body["needs_you"])
	}
	if got := model.called(); got != 1 {
		t.Errorf("model calls = %d, want 1 — an invention is refused, not repaired", got)
	}
	// The refusal is cached too: a broken model costs one completion per TTL,
	// not one per page load.
	cuBriefGet(t, s, "24h")
	if got := model.called(); got != 1 {
		t.Errorf("model calls after a cached refusal = %d, want 1", got)
	}
}

// The one re-ask the rubric allows, seen from the route: two completions, then
// the same honest absence.
func TestCatchUpBriefHeadlineOwedDodgerIsUnavailableAfterOneReAsk(t *testing.T) {
	const dodged = `{"headline":"Nothing urgent: \"Typo sweep\" shipped.","by_project":[]}`
	model := &cuHeadlineModel{answers: []string{dodged}}
	s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
	cuWaitHeadline(t, s, "24h", CatchUpHeadlineUnavailable)
	if got := model.called(); got != 2 {
		t.Fatalf("model calls = %d, want the first ask and the one corrective re-ask", got)
	}
}

// by_project is the model's claim about a project; the chip it is drawn against
// is the server's, from this read — so a line keyed on a project the brief no
// longer lists contributes nothing rather than a chip invented from a cached id.
func TestCatchUpBriefHeadlineByProjectCarriesTheBriefsChips(t *testing.T) {
	const withLines = `{"headline":"2 gates wait on you, oldest: \"Rate limiter gate\".","by_project":[` +
		`{"project_id":"` + cuProjectID + `","line":"\"Release pipeline\" is still failing."},` +
		`{"project_id":"` + cuOtherID + `","line":"\"Typo sweep\" opened."},` +
		`{"project_id":"prj-gone","line":"\"Typo sweep\" again."}]}`
	t.Run("kept for a 24h window", func(t *testing.T) {
		model := &cuHeadlineModel{answers: []string{withLines}}
		s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
		body := cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
		by, _ := body["by_project"].([]any)
		if len(by) != 2 {
			t.Fatalf("by_project = %v, want the two projects the brief lists", body["by_project"])
		}
		first, _ := by[0].(map[string]any)
		proj, _ := first["project"].(map[string]any)
		if proj["id"] != cuProjectID || first["line"] == "" {
			t.Errorf("by_project[0] = %v, want the brief's own chip", first)
		}
	})
	t.Run("dropped under 24h", func(t *testing.T) {
		model := &cuHeadlineModel{answers: []string{withLines}}
		s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
		body := cuWaitHeadline(t, s, "6h", CatchUpHeadlineReady)
		if by, _ := body["by_project"].([]any); len(by) != 0 {
			t.Errorf("by_project = %v, want none for a 6-hour window", body["by_project"])
		}
	})
}

// A deployment with no egress keeps the route: the lists, and `unavailable`.
func TestCatchUpBriefHeadlineWithoutAGeneratorIsUnavailable(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}}
	if NewCatchUpHeadlineGenerator(nil) != nil {
		t.Error("a headline generator was built with no model")
	}
	if BuildCatchUpHeadlineGenerator(CatchUpHeadlineDeps{}) != nil {
		t.Error("a headline generator was built with no broker")
	}
	s := cuBriefServerWith(t, cuBriefWithWork(), nil)
	body := cuBriefGet(t, s, "24h")
	if _, state := cuHeadlineOf(t, body); state != CatchUpHeadlineUnavailable {
		t.Errorf("headline state = %q, want unavailable", state)
	}
	if got := model.called(); got != 0 {
		t.Errorf("model calls = %d, want 0", got)
	}
}

// The cache's own arithmetic, with a clock the test turns: a fresh entry is
// reused, an in-flight one is never doubled, and the TTL re-opens the key.
func TestCatchUpBriefHeadlineCacheExpiry(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}}
	hs := newCatchUpBriefHeadlines(NewCatchUpHeadlineGenerator(model), nil)
	hs.now = func() time.Time { return now }
	brief := cuHeadlineBriefForCache()
	c := Caller{UserID: "user-1"}

	key := catchUpHeadlineKey(c, brief)
	entry, start := hs.begin(key, now)
	if !start {
		t.Fatal("the first read of a key did not take it")
	}
	if entry.state != CatchUpHeadlinePending {
		t.Errorf("a taken key is %q, want pending", entry.state)
	}
	if got := model.called(); got != 0 {
		t.Errorf("begin() called the model (%d); only generate() may", got)
	}
	// A second read while the generation is still open takes the same entry and
	// buys nothing: this is the "at most one in-flight per key" rule.
	briefA := brief
	hs.attachHeadline(context.Background(), c, &briefA)
	if briefA.Headline.State != CatchUpHeadlinePending {
		t.Errorf("in-flight headline state = %q, want pending", briefA.Headline.State)
	}
	if _, again := hs.begin(key, now); again {
		t.Error("an in-flight key was handed to a second generation")
	}
	if got := model.called(); got != 0 {
		t.Errorf("model calls behind an in-flight key = %d, want 0", got)
	}
	// An answer lands; the next read inside the TTL is served from the cache.
	hs.settle(entry, assistant.CatchUpHeadline{Text: "answered"}, nil, "24h")
	briefB := brief
	hs.attachHeadline(context.Background(), c, &briefB)
	if briefB.Headline.State != CatchUpHeadlineReady || briefB.Headline.Text != "answered" {
		t.Fatalf("cached headline = %+v, want the ready answer", briefB.Headline)
	}
	if got := model.called(); got != 0 {
		t.Errorf("model calls on a cached answer = %d, want 0", got)
	}
	// Past the TTL the key re-opens, and the stale text is gone with it.
	now = now.Add(CatchUpHeadlineCacheTTL + time.Second)
	briefC := brief
	hs.attachHeadline(context.Background(), c, &briefC)
	if briefC.Headline.State != CatchUpHeadlinePending || briefC.Headline.Text != "" {
		t.Errorf("post-TTL headline = %+v, want a fresh pending", briefC.Headline)
	}
	cuWaitCalls(t, model, 1)

	// A different reader is a different key: nobody else's sentence, and nobody
	// else's project names either (ADR-0081 § Security/privacy).
	if catchUpHeadlineKey(Caller{UserID: "user-2"}, brief) == catchUpHeadlineKey(c, brief) {
		t.Error("two readers share a headline key")
	}
}

// The digest is over the brief with the model's halves removed: an answer can
// never be the key that fetches itself.
func TestCatchUpBriefDigestIgnoresTheModelOwnAnswer(t *testing.T) {
	base := cuHeadlineBriefForCache()
	answered := base
	answered.Headline = CatchUpBriefHeadline{Text: "a headline", State: CatchUpHeadlineReady}
	answered.ByProject = []CatchUpBriefProjectLine{{Project: cuChip(), Line: "a line"}}
	if string(catchUpBriefDigest(base)) != string(catchUpBriefDigest(answered)) {
		t.Error("the digest covers the headline or by_project, so an answer could invalidate itself")
	}
	// The read's clock is not part of the question either: two page loads one
	// second apart are the same brief, or nothing would ever be cached.
	shifted := base
	shifted.Window.Until = shifted.Window.Until.Add(time.Second)
	shifted.Window.Since = shifted.Window.Since.Add(time.Second)
	if string(catchUpBriefDigest(base)) != string(catchUpBriefDigest(shifted)) {
		t.Error("the digest covers window.since/until, so no two reads ever share a key")
	}
	// The window key, and any row at all, DO move it.
	narrowed := base
	narrowed.Window.Key = "7d"
	if string(catchUpBriefDigest(base)) == string(catchUpBriefDigest(narrowed)) {
		t.Error("two windows share a digest")
	}
	grew := base
	grew.NeedsYou = append(append([]CatchUpBriefNeed(nil), base.NeedsYou...), CatchUpBriefNeed{
		Kind: CatchUpNeedApproval, Title: "One more gate", Project: cuChip()})
	if string(catchUpBriefDigest(base)) == string(catchUpBriefDigest(grew)) {
		t.Error("an added row left the digest alone")
	}
}

func cuHeadlineBriefForCache() CatchUpBrief {
	brief := newCatchUpBrief()
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	brief.Window = CatchUpBriefWindow{Key: "24h", Since: now.Add(-24 * time.Hour), Until: now}
	brief.NeedsYou = []CatchUpBriefNeed{{
		Kind: CatchUpNeedApproval, Title: "Rate limiter gate", Project: cuChip(),
		Link: "/approvals/a1", At: now.Add(-3 * time.Hour),
	}}
	return brief
}

// The generator's refusal of secret-shaped output must reach the route as
// `unavailable`: what the model made up is not shown, and the detail carries no
// echo of it.
func TestCatchUpBriefHeadlineSecretAnswerIsUnavailable(t *testing.T) {
	const leaky = `{"headline":"2 gates wait on you, oldest: \"Rate limiter gate\".` +
		` token=abc123456789","by_project":[]}`
	model := &cuHeadlineModel{answers: []string{leaky}}
	s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
	body := cuWaitHeadline(t, s, "24h", CatchUpHeadlineUnavailable)
	if text, _ := cuHeadlineOf(t, body); strings.Contains(text, "token") {
		t.Errorf("the refused headline reached the page: %q", text)
	}
}

// The DATA the generator is handed is the brief the route served: same rows,
// same window, and the same titles the reader will see quoted back.
func TestCatchUpBriefHeadlineDataIsTheServedBrief(t *testing.T) {
	model := &cuHeadlineModel{answers: []string{cuGoodHeadline}}
	s := cuBriefServerWith(t, cuBriefWithWork(), NewCatchUpHeadlineGenerator(model))
	cuWaitHeadline(t, s, "24h", CatchUpHeadlineReady)
	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.users) != 1 {
		t.Fatalf("user messages = %d, want 1", len(model.users))
	}
	user := model.users[0]
	for _, want := range []string{
		"\"key\": \"24h\"", "Rate limiter gate", "Release cut gate", "Release pipeline",
		"Typo sweep", `"still_failing": true`, `"id": "N1"`, `"id": "B1"`, `"id": "S1"`,
	} {
		if !strings.Contains(user, want) {
			t.Errorf("the DATA block is missing %q:\n%s", want, user)
		}
	}
	for _, banned := range []string{"/approvals/a1", "https://example.invalid"} {
		if strings.Contains(user, banned) {
			t.Errorf("the DATA block carries %q: links and refs are not the headline's to cite", banned)
		}
	}
}

// cuWaitCalls waits for the generator to have been asked N times: the
// generation is a background goroutine, so its call count is eventual.
func cuWaitCalls(t *testing.T, m *cuHeadlineModel, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := m.called(); got >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("model calls = %d after 5s, want %d", m.called(), want)
}
