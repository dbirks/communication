//go:build eval

package postgres

// ADR-0081 § Evaluation, the second half: the USEFULNESS eval.
//
// The deterministic tests (catch_up_brief_seed_test.go) prove the brief's lists
// are right. They cannot prove the headline is worth reading, because a headline
// that quotes real titles and breaks no rule can still bury the one thing the
// reader owes. So this file asks the question the ADR says only a model can
// answer — it puts a REAL model in front of the seeded histories, writes the
// headline through the production generator, and has a judge model score it
// against the ADR's rubric.
//
// What is real here, and what is fixed:
//
//   - the history is the seeded one (cuSeed), at the seeder's fixed clock, so a
//     run of this eval is comparable with the run before it;
//   - the brief is the assembled one (api.AssembleCatchUpBrief over the real
//     store), not a hand-written fixture;
//   - the headline comes from assistant's generator through api's own adapter
//     and a real broker built from the eval endpoint, so the prompt, the truth
//     set and the secret gate are the ones the page uses;
//   - the score is a model's opinion, and the pass rule is the ADR's: mean 4.0
//     or better with no criterion at 1.
//
// It is GATED, and skips loudly with the names of what it needed: without a
// model endpoint CI runs the deterministic half alone. Nothing is stored and no
// key is ever printed — the key is read from a file the operator owns and only
// ever reaches a request header.
//
// Run it:
//
//	COMMUNICATION_TEST_DATABASE_URL=… COMMUNICATION_EVAL_BASE_URL=… \
//	COMMUNICATION_EVAL_MODEL=… COMMUNICATION_EVAL_API_KEY_FILE=… \
//	  go test ./internal/store/postgres/ -run CatchUpUsefulnessEval -count=1 -v -timeout 30m
//
// and add `-update-eval` to write the table into docs/testing/catch-up-eval.md.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/assistant"
)

// updateCatchUpEval writes the run's table into the doc under a dated heading;
// without it the eval only prints, so an accidental run cannot rewrite evidence.
var updateCatchUpEval = flag.Bool("update-eval", false,
	"write the catch-up usefulness eval results into docs/testing/catch-up-eval.md")

// The eval's own endpoint names (ADR-0081 § Evaluation). They are deliberately
// NOT the assistant's: an eval that silently graded itself against the
// deployment's own chat endpoint would be measuring the lab's configuration.
const (
	envEvalBaseURL    = "COMMUNICATION_EVAL_BASE_URL"
	envEvalModel      = "COMMUNICATION_EVAL_MODEL"
	envEvalAPIKeyFile = "COMMUNICATION_EVAL_API_KEY_FILE"
	envEvalJudgeModel = "COMMUNICATION_EVAL_JUDGE_MODEL"
)

// cuEvalCallTimeout bounds ONE completion. The broker's own per-call default is
// 30s, which is a browser's patience; a seven-day brief on a reasoning model
// needs more, and nobody is waiting on a page.
const cuEvalCallTimeout = 150 * time.Second

// cuEvalWindow is one chip asked about one seeded history. The 3-day story is
// asked with the 2d chip — the same pair the deterministic brief test runs — so
// the eval grades what the page actually serves rather than a fixture name.
type cuEvalWindow struct {
	scenario cuScenario
	key      string
}

func cuEvalWindows() []cuEvalWindow {
	return []cuEvalWindow{
		{cuWindow15m, api.CatchUpWindowFifteenMin},
		{cuWindow1h, api.CatchUpWindowOneHour},
		{cuWindow1d, api.CatchUpWindowDaily},
		{cuWindow3d, api.CatchUpWindowTwoDay},
		{cuWindow7d, api.CatchUpWindowWeekly},
	}
}

// name is the subtest label: the scenario and the chip, when they differ.
func (w cuEvalWindow) name() string {
	if string(w.scenario) == w.key {
		return w.key
	}
	return w.key + "-" + string(w.scenario)
}

// cuEvalScore is one judge answer, and cuEvalRow is one window's line of the
// table. `note` carries the reason a window has no score: a refused headline or
// an answer that was not one JSON object. Both are failures, and both still
// have to appear in the table, because a table that silently drops the window
// that broke is how an eval starts passing.
type cuEvalScore struct {
	needsYou, stillFailing, noInvention, priority, concise int
	why                                                    string
}

func (s cuEvalScore) parts() []int {
	return []int{s.needsYou, s.stillFailing, s.noInvention, s.priority, s.concise}
}

type cuEvalRow struct {
	window   string
	headline string
	score    cuEvalScore
	scored   bool
	note     string
}

// cuEvalJudgeSystem is ADR-0081's rubric, verbatim from the design — the same
// words the orchestrator's brief quotes. It is one literal because the scores
// are only comparable across runs while this text is fixed; editing it is
// editing the yardstick, and every number below the line changes meaning.
const cuEvalJudgeSystem = `You grade a catch-up headline written for an engineer returning after time away. You are given the facts (a JSON brief of what happened) and the headline. Score each criterion 1-5 and answer with exactly one JSON object: {"needs_you":n,"still_failing":n,"no_invention":n,"priority":n,"concise":n,"why":"one sentence"}.
needs_you: 5 if every item waiting on the reader is named or counted correctly (5 also when there are none and the headline doesn't invent any); 1 if one is missed.
still_failing: 5 if anything still failing is mentioned by name (5 when nothing is failing); 1 if missed.
no_invention: 5 if every name, number and claim is supported by the facts; 1 if anything is invented.
priority: 5 if the most important thing (waiting on reader > still broken > shipped > risky > routine) comes first.
concise: 5 if two sentences or fewer, under 280 characters, no filler; lower for padding or greetings.`

// cuEvalCriterionNames is the table's column order, and the order the judge's
// object is read in. A judge answer that renames a key is unparsable rather
// than quietly reordered, so this list only has to agree with the rubric above.
var cuEvalCriterionNames = []string{"needs_you", "still_failing", "no_invention", "priority", "concise"}

func TestCatchUpUsefulnessEval(t *testing.T) {
	cfg, judgeModel, ok := cuEvalGate(t)
	if !ok {
		return
	}
	writer, err := assistant.NewTextOnly(cfg)
	if err != nil {
		t.Fatalf("build the eval %s broker: %v", envEvalModel, err)
	}
	judgeCfg := cfg
	judgeCfg.Model = judgeModel
	judge, err := assistant.NewTextOnly(judgeCfg)
	if err != nil {
		t.Fatalf("build the eval %s judge broker: %v", envEvalJudgeModel, err)
	}
	// The production adapter, not a re-implementation: whatever maps the served
	// brief to the model's block on the page is what maps it here.
	gen := api.NewCatchUpHeadlineGenerator(writer)
	if gen == nil || !gen.Configured() {
		t.Fatalf("the eval built no headline generator from a configured broker")
	}

	windows := cuEvalWindows()
	rows := make([]*cuEvalRow, len(windows))
	for i, w := range windows {
		w := w
		i := i
		t.Run(w.name(), func(t *testing.T) {
			rows[i] = cuEvalOne(t, gen, judge, w)
		})
	}

	// A subtest that died inside the fixture never produced a row; say so in the
	// table instead of printing a shorter one.
	out := make([]cuEvalRow, 0, len(windows))
	for i, w := range windows {
		if rows[i] == nil {
			out = append(out, cuEvalRow{window: w.name(), note: "no result (the window's test aborted)"})
			continue
		}
		out = append(out, *rows[i])
	}
	mean, pass := cuEvalReport(t, out)
	for _, line := range cuEvalTable(cfg.Model, judgeModel, out, mean, pass) {
		t.Log(line)
	}
	if *updateCatchUpEval {
		cuEvalWriteDoc(t, cfg.Model, judgeModel, out, mean, pass)
	}

	// ADR-0081's pass rule, stated once, over every score of every window.
	if !pass {
		t.Errorf("catch-up usefulness eval: mean %.2f over the graded windows, %s", mean,
			cuEvalFailedWindows(out))
	}
}

// --- the gate ------------------------------------------------------------

// cuEvalGate skips unless the eval's endpoint AND the test database are both
// set, naming exactly what is missing. A set-but-unusable value is NOT a skip:
// an eval that skipped over a typo would be reported as "not run" by the next
// reader and as "green" by this one.
func cuEvalGate(t *testing.T) (assistant.Config, string, bool) {
	t.Helper()
	var missing []string
	base := strings.TrimRight(strings.TrimSpace(os.Getenv(envEvalBaseURL)), "/")
	model := strings.TrimSpace(os.Getenv(envEvalModel))
	keyFile := strings.TrimSpace(os.Getenv(envEvalAPIKeyFile))
	judge := strings.TrimSpace(os.Getenv(envEvalJudgeModel))
	if base == "" {
		missing = append(missing, envEvalBaseURL)
	}
	if model == "" {
		missing = append(missing, envEvalModel)
	}
	if keyFile == "" {
		missing = append(missing, envEvalAPIKeyFile)
	}
	if os.Getenv("COMMUNICATION_TEST_DATABASE_URL") == "" {
		missing = append(missing, "COMMUNICATION_TEST_DATABASE_URL")
	}
	if len(missing) > 0 {
		t.Skip("catch-up usefulness eval skipped; not set: " + strings.Join(missing, ", "))
		return assistant.Config{}, "", false
	}
	raw, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatalf("%s names %q, which cannot be read: %v", envEvalAPIKeyFile, keyFile, err)
	}
	key := strings.TrimSpace(string(raw))
	if key == "" {
		t.Fatalf("%s names %q, which is empty", envEvalAPIKeyFile, keyFile)
	}
	if judge == "" {
		judge = model
	}
	return assistant.Config{
		BaseURL: base,
		APIKey:  key,
		Model:   model,
		Timeout: cuEvalCallTimeout,
	}, judge, true
}

// --- one window ----------------------------------------------------------

// cuEvalOne seeds the history, assembles the brief, asks for the headline and
// grades it. Every failure is a t.Errorf and a table row, never a Fatalf, so one
// bad window cannot hide the other four's scores.
func cuEvalOne(t *testing.T, gen api.CatchUpHeadlineGenerator, judge *assistant.Broker,
	w cuEvalWindow) *cuEvalRow {
	t.Helper()
	row := &cuEvalRow{window: w.name()}
	now := cuTestClock

	f := cnvSetup(t)
	seeded := cuSeed(t, f, w.scenario, now)
	cuBriefAssign(t, f, seeded)

	reader := api.Caller{UserID: seeded.ReaderID, OrganizationID: f.orgID}
	brief, err := api.AssembleCatchUpBrief(testCtx(t), APICatchUpStore{S: cuStore(f)}, reader,
		api.CatchUpBriefScope{Window: w.key}, now)
	if err != nil {
		row.note = fmt.Sprintf("assemble the brief: %v", err)
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}
	if len(brief.NeedsYou)+len(brief.RunningNow)+len(brief.Shipped)+
		len(brief.Broke)+len(brief.HeadsUp)+len(brief.Changes) == 0 {
		// The quiet case: the server writes that headline ITSELF, without a
		// completion (assistant.CatchUpHeadlineQuietText). Grading a string
		// literal would be a pass nobody earned, so an empty window is an error —
		// and it says so in the table instead of scoring five fives.
		row.note = "the assembled brief has no sections at all"
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(cancel)
	head, err := gen.GenerateCatchUpHeadline(ctx, brief)
	if err != nil {
		// A refusal IS the honest outcome the page would show (headline state
		// `unavailable`, lists alone) — and a window whose headline the checks
		// refused is not a useful one, so it fails the eval rather than passing
		// by saying nothing.
		row.note = fmt.Sprintf("the generator refused the headline: %v", err)
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}
	row.headline = head.Text

	facts, err := cuEvalFacts(brief)
	if err != nil {
		row.note = fmt.Sprintf("the brief could not be handed to the judge: %v", err)
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}
	user := "FACTS:\n" + facts + "\n\nHEADLINE:\n" + head.Text
	raw, fail := judge.CompleteText(ctx, cuEvalJudgeSystem, user)
	if fail != nil {
		row.note = fmt.Sprintf("the judge call failed: %v", fail)
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}
	score, err := cuParseJudgeAnswer(raw)
	if err != nil {
		row.note = fmt.Sprintf("the judge's answer was not the one object it was asked for: %v", err)
		t.Errorf("%s: %s", row.window, row.note)
		return row
	}
	row.score, row.scored = score, true
	return row
}

// cuEvalFacts is the brief as the judge sees it: the same JSON the page gets,
// with the model's own half cut out. `headline` is removed rather than blanked,
// so the judge is never shown the string it is grading inside the facts it is
// supposed to grade against; `by_project` goes with it, for the same reason —
// it is the model's prose too.
func cuEvalFacts(brief api.CatchUpBrief) (string, error) {
	brief.Headline = api.CatchUpBriefHeadline{}
	brief.ByProject = []api.CatchUpBriefProjectLine{}
	blob, err := json.MarshalIndent(brief, "", " ")
	if err != nil {
		return "", err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(blob, &doc); err != nil {
		return "", err
	}
	delete(doc, "headline")
	delete(doc, "by_project")
	out, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// --- the judge's answer ---------------------------------------------------

// cuParseJudgeAnswer reads the judge's reply: one JSON object, the five criteria
// each present exactly once as an integer in 1..5, plus `why`. A surrounding code
// fence is tolerated — it is wrapping, not content, and the generator's own
// parser accepts it — and nothing else is: no prose around it, no second object,
// no missing key, no score of 0 or 6, no string where a number belongs.
//
// The alternative is to guess a score out of an unparsable answer, and a guess is
// not evidence.
func cuParseJudgeAnswer(raw string) (cuEvalScore, error) {
	s, err := cuEvalUnwrapFence(strings.TrimSpace(raw))
	if err != nil {
		return cuEvalScore{}, err
	}
	// A judge that talks around its object is still graded: take the outermost
	// {...} and turn raw newlines into spaces (the second eval run lost two
	// windows to leading prose and to a raw newline inside "why"). The scores
	// themselves are still parsed strictly below.
	if i, j := strings.Index(s, "{"), strings.LastIndex(s, "}"); i >= 0 && j > i {
		s = s[i : j+1]
	}
	s = strings.NewReplacer("\r\n", " ", "\n", " ").Replace(s)
	dec := json.NewDecoder(strings.NewReader(s))
	dec.DisallowUnknownFields()
	var a struct {
		NeedsYou     *int    `json:"needs_you"`
		StillFailing *int    `json:"still_failing"`
		NoInvention  *int    `json:"no_invention"`
		Priority     *int    `json:"priority"`
		Concise      *int    `json:"concise"`
		Why          *string `json:"why"`
	}
	if err := dec.Decode(&a); err != nil {
		return cuEvalScore{}, fmt.Errorf("%v (%s)", err, cuEvalExcerpt(raw))
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return cuEvalScore{}, fmt.Errorf("the judge sent more than one object (%s)", cuEvalExcerpt(raw))
	}
	if a.NeedsYou == nil || a.StillFailing == nil || a.NoInvention == nil ||
		a.Priority == nil || a.Concise == nil {
		return cuEvalScore{}, fmt.Errorf("the judge's object is missing a criterion (%s)", cuEvalExcerpt(raw))
	}
	out := cuEvalScore{
		needsYou: *a.NeedsYou, stillFailing: *a.StillFailing, noInvention: *a.NoInvention,
		priority: *a.Priority, concise: *a.Concise,
	}
	for name, v := range map[string]int{
		"needs_you": out.needsYou, "still_failing": out.stillFailing,
		"no_invention": out.noInvention, "priority": out.priority, "concise": out.concise,
	} {
		if v < 1 || v > 5 {
			return cuEvalScore{}, fmt.Errorf("the judge scored %s %d, outside 1 to 5", name, v)
		}
	}
	if a.Why != nil {
		out.why = strings.Join(strings.Fields(*a.Why), " ")
	}
	if out.why == "" {
		// The rubric asks for a sentence; an absent one is not evidence of
		// anything, and the table shows the gap rather than inventing prose.
		out.why = "(the judge gave no reason)"
	}
	return out, nil
}

// cuEvalUnwrapFence removes ONE surrounding ``` or ```json fence and reports
// anything else that is not the object itself.
func cuEvalUnwrapFence(s string) (string, error) {
	if s == "" {
		return "", errors.New("the judge answered nothing")
	}
	if !strings.HasPrefix(s, "```") {
		return s, nil
	}
	body, ok := strings.CutPrefix(s, "```")
	if !ok {
		return "", errors.New("the judge's fence never opened")
	}
	nl := strings.IndexByte(body, '\n')
	if nl < 0 {
		return "", errors.New("the judge's fenced answer has no body")
	}
	lead := strings.TrimSpace(body[:nl])
	if lead != "" && lead != "json" && lead != "JSON" {
		return "", fmt.Errorf("the judge's fence is labelled %q, not json", lead)
	}
	body = strings.TrimSpace(body[nl+1:])
	if !strings.HasSuffix(body, "```") {
		return "", errors.New("the judge's fenced answer never closes")
	}
	return strings.TrimSpace(strings.TrimSuffix(body, "```")), nil
}

// cuEvalExcerpt is the bounded, one-line echo of what the judge actually sent:
// the diagnosis for an unparsable answer, with control characters flattened so a
// wall of newlines cannot inflate a log line.
func cuEvalExcerpt(raw string) string {
	s := strings.Join(strings.Fields(raw), " ")
	if s == "" {
		return "the answer was empty"
	}
	const max = 200
	if len(s) > max {
		return "the answer began: '" + s[:max] + "…'"
	}
	return "the answer began: '" + s + "'"
}

// --- the pass rule, the table, the doc ------------------------------------

// cuEvalReport applies ADR-0081's rule: the mean over every graded criterion of
// every window is 4.0 or better, and NO single criterion sits at 1. An ungraded
// window (refused headline, unparsable judge) fails the run: "not scored" is not
// "scored well".
func cuEvalReport(t *testing.T, rows []cuEvalRow) (float64, bool) {
	t.Helper()
	var sum, n int
	pass := true
	for _, r := range rows {
		if !r.scored {
			pass = false
			continue
		}
		for i, v := range r.score.parts() {
			if v == 1 {
				t.Errorf("%s: the judge scored %s at 1 — the rule allows no criterion at 1 (%s)",
					r.window, cuEvalCriterionNames[i], r.score.why)
				pass = false
			}
			sum += v
			n++
		}
	}
	mean := 0.0
	if n > 0 {
		mean = float64(sum) / float64(n)
	}
	if n == 0 {
		return mean, false
	}
	if mean < 4.0 {
		pass = false
	}
	return mean, pass
}

func cuEvalFailedWindows(rows []cuEvalRow) string {
	var bad []string
	for _, r := range rows {
		if !r.scored {
			bad = append(bad, r.window+" unscored ("+r.note+")")
			continue
		}
		for i, v := range r.score.parts() {
			if v == 1 {
				bad = append(bad, fmt.Sprintf("%s scored 1 on %s", r.window, cuEvalCriterionNames[i]))
			}
		}
	}
	if len(bad) == 0 {
		return "no failing window"
	}
	return strings.Join(bad, "; ")
}

// cuEvalTable is the markdown the doc keeps and the test prints: one row per
// window, the headline verbatim, then the five scores and the judge's sentence.
func cuEvalTable(model, judgeModel string, rows []cuEvalRow, mean float64, pass bool) []string {
	out := []string{
		"| window | headline | needs_you | still_failing | no_invention | priority | concise | why |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	}
	for _, r := range rows {
		cells := []string{r.window, cuEvalCell(r.headline)}
		if r.scored {
			for _, v := range r.score.parts() {
				cells = append(cells, fmt.Sprintf("%d", v))
			}
			cells = append(cells, cuEvalCell(r.score.why))
		} else {
			note := r.note
			if note == "" {
				note = "no result"
			}
			cells = append(cells, "—", "—", "—", "—", "—", cuEvalCell("NOT SCORED: "+note))
		}
		out = append(out, "| "+strings.Join(cells, " | ")+" |")
	}
	verdict := "FAIL"
	if pass {
		verdict = "PASS"
	}
	out = append(out, "",
		fmt.Sprintf("Model `%s`, judge `%s`; mean %.2f over %d graded scores; rule: mean ≥ 4.0 with no criterion at 1 — **%s**.",
			model, judgeModel, mean, cuEvalGraded(rows), verdict))
	return out
}

func cuEvalGraded(rows []cuEvalRow) int {
	n := 0
	for _, r := range rows {
		if r.scored {
			n += len(r.score.parts())
		}
	}
	return n
}

// cuEvalCell keeps a headline or a judge's sentence inside one table cell: no
// pipes, no newlines, nothing that would break the row a human reads.
func cuEvalCell(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	s = strings.ReplaceAll(s, "|", "\\|")
	if s == "" {
		return "—"
	}
	return s
}

// cuEvalDocPath is the evidence file, from the test's own working directory.
func cuEvalDocPath() string {
	return filepath.Join("..", "..", "..", "docs", "testing", "catch-up-eval.md")
}

const (
	cuEvalResultsBegin = "<!-- catch-up-eval:results:start -->"
	cuEvalResultsEnd   = "<!-- catch-up-eval:results:end -->"
)

// cuEvalWriteDoc puts this run's table into the doc under a dated heading, newest
// first, and keeps every older run beneath it: the ADR's evidence rule is that a
// reader can see the scores change, so a run that overwrote the previous one
// would hide a regression instead of recording it.
func cuEvalWriteDoc(t *testing.T, model, judgeModel string, rows []cuEvalRow, mean float64, pass bool) {
	t.Helper()
	path := cuEvalDocPath()
	existing, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s (it holds the method and the results markers; create it before running -update-eval): %v", path, err)
	}
	text := string(existing)
	i := strings.Index(text, cuEvalResultsBegin)
	j := strings.Index(text, cuEvalResultsEnd)
	if i < 0 || j < 0 || j < i {
		t.Fatalf("%s is missing the %s / %s result markers", path, cuEvalResultsBegin, cuEvalResultsEnd)
	}
	section := "## Run " + time.Now().UTC().Format("2006-01-02 15:04") + " UTC — model `" + model +
		"`, judge `" + judgeModel + "`\n\n" +
		strings.Join(cuEvalTable(model, judgeModel, rows, mean, pass), "\n") + "\n"
	// The runs already recorded between the markers, kept verbatim beneath this one.
	older := strings.TrimSpace(text[i+len(cuEvalResultsBegin) : j])
	if older != "" {
		section += "\n" + older + "\n"
	}
	rewritten := text[:i+len(cuEvalResultsBegin)] + "\n\n" + section + text[j:]
	if err := os.WriteFile(path, []byte(rewritten), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	t.Logf("wrote the eval table into %s", path)
}
