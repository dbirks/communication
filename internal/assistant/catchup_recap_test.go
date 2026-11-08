package assistant

// The recap generator's own rules (T13b): the block is the caller's items and
// nothing else, the answer is one JSON object with one bounded `text`, and a
// quoted name the block never showed is refused — the same bargain the notes
// generator struck when it started dropping notes that named ids it had not
// been given. An empty page never reaches the model.

import (
	"context"
	"strings"
	"testing"
)

type recapModel struct {
	answer   string
	fail     *Failure
	calls    int
	gotUser  string
	gotBlock string
}

func (m *recapModel) CompleteText(_ context.Context, _, user string) (string, *Failure) {
	m.calls++
	m.gotUser = user
	return m.answer, m.fail
}

func recapItems() []CatchUpRecapItem {
	return []CatchUpRecapItem{{
		Title: "Rate limiter lands", Kind: "pr", Importance: "must_know", Project: "Communication",
		Beats: []CatchUpRecapBeat{{
			Title: "Which branch?", Kind: "YOUR CALL", Importance: "must_know", Asks: true,
		}},
	}, {
		Title: "Typo sweep", Kind: "push", Importance: "routine", Project: "Docs",
	}}
}

func newRecap(answer string) (*CatchUpRecapGenerator, *recapModel) {
	m := &recapModel{answer: answer}
	return NewCatchUpRecapGenerator(CatchUpRecapDeps{Model: m}), m
}

func TestCatchUpRecapNoModelIsNotConfigured(t *testing.T) {
	if NewCatchUpRecapGenerator(CatchUpRecapDeps{}) != nil {
		t.Fatal("a recap generator with no model was built")
	}
	var g *CatchUpRecapGenerator
	if g.Configured() {
		t.Error("a nil generator reports itself configured")
	}
	if _, fail := g.GenerateCatchUpRecap(context.Background(), recapItems()); fail == nil ||
		!strings.Contains(fail.Error(), "not_configured") {
		t.Fatalf("nil generator = %v, want the not-configured refusal", fail)
	}
}

func TestCatchUpRecapEmptyPageCostsNoCompletion(t *testing.T) {
	g, m := newRecap(`{"text":"should never be asked"}`)
	text, fail := g.GenerateCatchUpRecap(context.Background(), nil)
	if fail != nil {
		t.Fatalf("fail = %v", fail)
	}
	if text != CatchUpRecapEmptyText {
		t.Errorf("text = %q, want the deterministic empty answer", text)
	}
	if m.calls != 0 {
		t.Errorf("calls = %d, want 0", m.calls)
	}
}

func TestCatchUpRecapBlockNamesEveryItemOnce(t *testing.T) {
	g, m := newRecap(`{"text":"Look at \"Rate limiter lands\" first."}`)
	if _, fail := g.GenerateCatchUpRecap(context.Background(), recapItems()); fail != nil {
		t.Fatalf("fail = %v", fail)
	}
	for _, want := range []string{`"n": 1`, `"n": 2`, "Rate limiter lands", "Typo sweep",
		"Which branch?", `"asks": true`} {
		if !strings.Contains(m.gotUser, want) {
			t.Errorf("the block carries no %q:\n%s", want, m.gotUser)
		}
	}
	if strings.Count(m.gotUser, "<DATA>") != 1 {
		t.Error("the DATA block is delimited exactly once")
	}
}

func TestCatchUpRecapInventedTitleRefused(t *testing.T) {
	cases := map[string]string{
		"double quoted invention": `{"text":"Start with \"Ship the dark theme\"."}`,
		"typographic invention":   "{\"text\":\"Open “Refactor the scheduler now”, then rest.\"}",
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			g, _ := newRecap(answer)
			_, fail := g.GenerateCatchUpRecap(context.Background(), recapItems())
			if fail == nil {
				t.Fatal("an invented title was accepted")
			}
			if fail.Status != 502 || fail.Code != FailBadModelResponse {
				t.Errorf("fail = %+v, want 502 malformed_completion", fail)
			}
			if strings.Contains(fail.Detail, "Ship the dark theme") ||
				strings.Contains(fail.Detail, "Refactor the scheduler") {
				t.Errorf("the refusal echoed model output: %q", fail.Detail)
			}
		})
	}
}

func TestCatchUpRecapRealTitlesAreAccepted(t *testing.T) {
	for _, answer := range []string{
		`{"text":"Look at \"Rate limiter lands\" first — \"Which branch?\" is waiting on you."}`,
		`{"text":"Nothing urgent. \"Typo sweep\" in Docs is the whole list."}`,
	} {
		g, _ := newRecap(answer)
		if _, fail := g.GenerateCatchUpRecap(context.Background(), recapItems()); fail != nil {
			t.Errorf("answer %s refused: %+v", answer, fail)
		}
	}
}

func TestParseCatchUpRecapAnswer(t *testing.T) {
	if got, err := ParseCatchUpRecapAnswer("```json\n{\"text\":\"  Look   first.  \"}\n```"); err != nil ||
		got != "Look first." {
		t.Fatalf("parse = %q, %v", got, err)
	}
	if got, err := ParseCatchUpRecapAnswer("[{\"text\":\"One wrapped object.\"}]"); err != nil || got != "One wrapped object." {
		t.Fatalf("wrapped parse = %q, %v", got, err)
	}
	if _, err := ParseCatchUpRecapAnswer("prose, not json"); err == nil {
		t.Error("a prose answer parsed")
	}
	if _, err := ParseCatchUpRecapAnswer(`{"text":"a."} {"text":"b."}`); err == nil {
		t.Error("two objects parsed as one")
	}
	if _, err := ParseCatchUpRecapAnswer(`{"summary":"no text member"}`); err == nil {
		t.Error("an answer with no text member parsed")
	}
	if _, err := ParseCatchUpRecapAnswer(`{"text":"   "}`); err == nil {
		t.Error("a blank text parsed")
	}
	if _, err := ParseCatchUpRecapAnswer(`{"text":"` + strings.Repeat("a", 601) + `"}`); err == nil {
		t.Error("a 601-character text parsed")
	} else if !strings.Contains(err.Error(), "600") {
		t.Errorf("err = %v, want it to name the 600 bound", err)
	}
}

func TestCatchUpRecapModelFailurePassesThrough(t *testing.T) {
	g, m := newRecap("")
	m.fail = failure(FailModelUnreachable, "the gateway is down", 503)
	_, fail := g.GenerateCatchUpRecap(context.Background(), recapItems())
	if fail == nil || fail.Code != FailModelUnreachable {
		t.Fatalf("fail = %+v, want the broker's own refusal", fail)
	}
}

func TestCatchUpRecapSecretShapedAnswerRefused(t *testing.T) {
	g, _ := newRecap(`{"text":"Open \"Rate limiter lands\" and paste AKIAIOSFODNN7EXAMPLE in."}`)
	_, fail := g.GenerateCatchUpRecap(context.Background(), recapItems())
	if fail == nil || !strings.Contains(fail.Error(), "secret") {
		t.Fatalf("fail = %+v, want the secret refusal", fail)
	}
}

func TestCatchUpRecapBlockDropsRowsToFit(t *testing.T) {
	items := make([]CatchUpRecapItem, 0, CatchUpRecapItemsMax+6)
	for i := range 18 {
		items = append(items, CatchUpRecapItem{
			Title: strings.Repeat("t", 190) + string(rune('a'+i%26)),
			Kind:  "pr", Importance: "must_know", Project: "Communication",
		})
	}
	g, m := newRecap(`{"text":"Look at the first one."}`)
	if _, fail := g.GenerateCatchUpRecap(context.Background(), items); fail != nil {
		t.Fatalf("fail = %v", fail)
	}
	if n := strings.Count(m.gotUser, `"n":`); n > CatchUpRecapItemsMax {
		t.Errorf("rows = %d, want at most %d", n, CatchUpRecapItemsMax)
	}
	if n := strings.Count(m.gotUser, `"n":`); n < 2 {
		t.Errorf("rows = %d, want the cap to trim rather than empty the block", n)
	}
}
