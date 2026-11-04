package postgres

// ADR-0065, structured-output arm (revised): a run node's agent ends on its
// structured output, and the shapes seen on the lab are wider than "a
// top-level `summary`" — a pretty-printed reviewer object, the same object
// inside a ```json fence, an answer wrapped in a nested `plan`, and a verdict
// with no string in it at all. All four are rendered from the row the SAME way
// both list READS serve it, which is what this proves against a real
// PostgreSQL: the row reads the agent's words, never its braces.

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/api"
)

func TestConversationListStructuredLastAgentLine(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	// 1. Reviewer, multi-line: no `summary`, the verdict's own sentence under
	//    `reason`. Before this rule the row printed `{"approved": true,`.
	reviewer := f.cnvCreate(t, f.alice, "Review run", "")
	clAgentMessage(t, f, reviewer.ID,
		"{\n  \"approved\": true,\n  \"findings\": 2,\n  \"reason\": \"The patch is safe.\"\n}")

	// 2. Planner, fenced and nested: the wrapper comes off, then the answer is
	//    read one object down at `plan.goal`.
	planner := f.cnvCreate(t, f.alice, "Plan run", "")
	clAgentMessage(t, f, planner.ID,
		"```json\n{\n  \"plan\": {\n    \"goal\": \"Add a docstring to add() in app.py\"\n  },\n  \"risk\": \"low\"\n}\n```")

	// 3. Verdict with no string anywhere: the object says `approved: true`, so
	//    that is what the row says — nothing is invented for it.
	verdict := f.cnvCreate(t, f.alice, "Gate run", "")
	clAgentMessage(t, f, verdict.ID, `{"approved": true, "blocking": 0, "waived": null}`)

	// 4. A prose thread beside them: an ordinary message, and one that merely
	//    opens with a brace, are untouched by the structured arm.
	prose := f.cnvCreate(t, f.alice, "Prose thread", "")
	clAgentMessage(t, f, prose.ID, "half an object:\n{\"summary\": \"cut off mid obj")

	want := map[string]string{
		reviewer.ID: "The patch is safe.",
		planner.ID:  "Add a docstring to add() in app.py",
		verdict.ID:  "approved: true · blocking: 0 · waived: null",
		prose.ID:    "half an object:",
	}

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	if len(items) != len(want) {
		t.Fatalf("list returned %d rows, want the four threads", len(items))
	}
	for _, cv := range items {
		wantLine, ok := want[cv.ID]
		if !ok {
			t.Fatalf("unexpected conversation %s in the list", cv.ID)
		}
		if cv.LastAgentLine != wantLine {
			t.Errorf("row %s: last_agent_line = %q, want %q", cv.ID, cv.LastAgentLine, wantLine)
		}
		if n := utf8.RuneCountInString(cv.LastAgentLine); n > cnvLastAgentLineMax {
			t.Errorf("row %s: preview is %d runes, over the cap of %d", cv.ID, n, cnvLastAgentLineMax)
		}
	}

	// The cross-project read (ADR-0047, the /threads page) shares the renderer,
	// so the same four rows answer the same four lines there.
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	for id, wantLine := range want {
		v, ok := byView[id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", id)
		}
		if v.LastAgentLine == nil || *v.LastAgentLine != wantLine {
			t.Errorf("cross row %s: last_agent_line = %v, want %q", id, v.LastAgentLine, wantLine)
		}
	}
}

// TestConversationListLastAgentLineNewestChunk pins that the preview is the
// NEWEST chunk read as a whole: a turn that narrates and then ends on its
// structured output shows the summary, and a structured answer that a later
// plain chunk follows shows the plain chunk's line — the journal order decides,
// not which shape renders prettier.
func TestConversationListLastAgentLineNewestChunk(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	endsStructured := f.cnvCreate(t, f.alice, "Ends on the output", "")
	clAgentMessage(t, f, endsStructured.ID, "working through it")
	clAgentMessage(t, f, endsStructured.ID, `{"summary": "Pushed branch feat/cards."}`)

	endsProse := f.cnvCreate(t, f.alice, "Ends on prose", "")
	clAgentMessage(t, f, endsProse.ID, `{"summary": "the structured answer"}`)
	clAgentMessage(t, f, endsProse.ID, "done — and the docs are updated")

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	got := map[string]string{}
	for _, cv := range items {
		got[cv.ID] = cv.LastAgentLine
	}
	if w := "Pushed branch feat/cards."; got[endsStructured.ID] != w {
		t.Errorf("structured-last row: last_agent_line = %q, want %q", got[endsStructured.ID], w)
	}
	if w := "done — and the docs are updated"; got[endsProse.ID] != w {
		t.Errorf("prose-last row: last_agent_line = %q, want %q", got[endsProse.ID], w)
	}
	// Sanity: the cap is a wire contract, and these lines ride inside it.
	for id, line := range got {
		if strings.ContainsRune(line, '\n') {
			t.Errorf("row %s: preview %q carries a newline", id, line)
		}
	}
}

// TestConversationListJSONTailLastAgentLine pins the round-11 defect against
// the real read: the worker's chunk cap (DefaultMaxChunkBytes) splits a run
// node's structured output mid-blob, so the NEWEST agent chunk is its tail.
// The row must say `structured output` — never the blob's punctuation, the
// `"]}}` the list printed.
func TestConversationListJSONTailLastAgentLine(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	chunkedPlan := f.cnvCreate(t, f.alice, "run 01a1a4f5 /plan attempt 1", "")
	clAgentMessage(t, f, chunkedPlan.ID,
		`{`+"\n"+`  "plan": {`+"\n"+`    "goal": "Add saved cards to checkout",`+"\n"+`    "steps": [`+"\n"+`      "implement",`+"\n"+`      "test"`+"\n"+`    ]`+"\n"+`  }`+"\n")
	clAgentMessage(t, f, chunkedPlan.ID,
		"\n"+`  "files": ["a.ts",`+"\n"+`    "b.ts"]}}`)

	bareTail := f.cnvCreate(t, f.alice, "run 01a1a4f5 /review attempt 2", "")
	clAgentMessage(t, f, bareTail.ID, "\n"+`"]}}`)

	want := map[string]string{
		chunkedPlan.ID: "structured output",
		bareTail.ID:    "structured output",
	}

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	for _, cv := range items {
		if w, ok := want[cv.ID]; ok && cv.LastAgentLine != w {
			t.Errorf("row %s: last_agent_line = %q, want %q", cv.ID, cv.LastAgentLine, w)
		}
		if n := utf8.RuneCountInString(cv.LastAgentLine); n > cnvLastAgentLineMax {
			t.Errorf("row %s: preview is %d runes, over the cap of %d", cv.ID, n, cnvLastAgentLineMax)
		}
	}

	// The /threads page read shares the renderer, so the same tails answer the
	// same line there.
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	for id, w := range want {
		v, ok := byView[id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", id)
		}
		if v.LastAgentLine == nil || *v.LastAgentLine != w {
			t.Errorf("cross row %s: last_agent_line = %v, want %q", id, v.LastAgentLine, w)
		}
	}
}

// TestCnvLastAgentLineCutStringValue pins the round-12 defect against the
// renderer alone (no database): a cut that leaves a JSON string value's OWN
// body as the newest chunk — the model's output ending mid-string, or the
// worker's chunk cap splitting the blob — must show the value the way the
// string holds it: the \n, \t, \", \\ and \uXXXX escapes RESOLVED, every run
// of whitespace collapsed to one space, one line — never the raw
// `documented.\n- Keep …` the list printed.
func TestCnvLastAgentLineCutStringValue(t *testing.T) {
	cases := []struct {
		name, chunk, want string
	}{
		{"newline escape decodes and collapses",
			`Fix hello.py so it is documented.\n- Keep the existing API`,
			"Fix hello.py so it is documented. - Keep the existing API"},
		{"tab escape decodes to one space", `step one\tstep two`, "step one step two"},
		{"escaped quotes decode",
			`Keep the \"usage\" section short`,
			`Keep the "usage" section short`},
		{"escaped backslash decodes",
			`Keep C:\\temp out of the diff`,
			`Keep C:\temp out of the diff`},
		{"unicode escape decodes",
			`Fix caf\u00e9 handling in the reader`,
			"Fix café handling in the reader"},
		{"mixed whitespace collapses to single spaces",
			"  padded\\tline\\nand   more  ",
			"padded line and more"},
		{"cut mid-escape: a lone trailing backslash drops out",
			"Keep the docstring\\",
			"Keep the docstring"},
		{"cut mid \\u escape drops the broken tail",
			`Keep the caf\u00`,
			"Keep the caf"},
		{"value opens the chunk when the cut landed on its quote",
			`"Fix hello.py so it is documented.\n- Keep the API`,
			"Fix hello.py so it is documented. - Keep the API"},
		{"decoded value is still capped at the rune cap",
			"start " + strings.Repeat("x", 300) + `\nend`,
			"start " + strings.Repeat("x", 153) + "…"},
		// Ordinary prose never carried a JSON escape, so it stays untouched —
		// the escape is the mark that says "this is a string's body".
		{"plain prose last line unchanged", "just a plain prose line", "just a plain prose line"},
		{"prose with a colon stays prose", "note: keep the API", "note: keep the API"},
		// A tail that still carries the document's structure keeps the
		// round-11 word — the decode answers only string content ALONE.
		{"structure tail still says structured output",
			`  "files": ["a.ts"]}}`,
			"structured output"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cnvLastAgentLine(tc.chunk)
			if got != tc.want {
				t.Errorf("cnvLastAgentLine(%q) = %q, want %q", tc.chunk, got, tc.want)
			}
			if n := utf8.RuneCountInString(got); n > cnvLastAgentLineMax {
				t.Errorf("preview is %d runes, over the cap of %d", n, cnvLastAgentLineMax)
			}
		})
	}
}

// TestConversationListCutStringValueLastAgentLine pins the same rule on the
// real reads: a plan node whose output ended INSIDE its `goal` string leaves
// the newest chunk as the value's own body — the run's row shows the plan
// decoded (one line, single spaces), not the literal `\n` the round-12
// review saw under `run 01a1a58e /plan attempt 1`. A prose thread beside it
// keeps its plain line.
func TestConversationListCutStringValueLastAgentLine(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	planCut := f.cnvCreate(t, f.alice, "run 01a1a58e /plan attempt 1", "")
	clAgentMessage(t, f, planCut.ID,
		`{"plan": {"goal": "Rewrite hello.py so it is doc`)
	clAgentMessage(t, f, planCut.ID,
		`umented.\n- Keep the existing API\n- Add unit tests for the ne`)

	prose := f.cnvCreate(t, f.alice, "Plain thread", "")
	clAgentMessage(t, f, prose.ID, "just a plain prose line")

	want := map[string]string{
		planCut.ID: "umented. - Keep the existing API - Add unit tests for the ne",
		prose.ID:   "just a plain prose line",
	}

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	for _, cv := range items {
		wantLine, ok := want[cv.ID]
		if !ok {
			t.Fatalf("unexpected conversation %s in the list", cv.ID)
		}
		if cv.LastAgentLine != wantLine {
			t.Errorf("row %s: last_agent_line = %q, want %q", cv.ID, cv.LastAgentLine, wantLine)
		}
		if strings.ContainsRune(cv.LastAgentLine, '\n') {
			t.Errorf("row %s: preview %q carries a newline", cv.ID, cv.LastAgentLine)
		}
		if n := utf8.RuneCountInString(cv.LastAgentLine); n > cnvLastAgentLineMax {
			t.Errorf("row %s: preview is %d runes, over the cap of %d", cv.ID, n, cnvLastAgentLineMax)
		}
	}

	// The /threads page read shares the renderer, so the cut value answers
	// the same decoded line there.
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	for id, wantLine := range want {
		v, ok := byView[id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", id)
		}
		if v.LastAgentLine == nil || *v.LastAgentLine != wantLine {
			t.Errorf("cross row %s: last_agent_line = %v, want %q", id, v.LastAgentLine, wantLine)
		}
	}
}

// TestCnvLastAgentLineMidStructureSlice pins the round-12 defect against the
// renderer alone (no database): the worker's chunk cap can split a run
// node's structured output so that the NEWEST chunk opens INSIDE a string
// value — a slice that starts in the middle of one string and runs on into
// the next object — `unchanged."}, {"id": 2, …`. The preview must decide
// that structurally (string literals stripped, what is left is bare JSON
// structure), not by a list of shapes, and must never print the slice's
// punctuation: the row says `structured output`.
func TestCnvLastAgentLineMidStructureSlice(t *testing.T) {
	cases := []struct {
		name, chunk, want string
	}{
		// The exact slice the round-12 review saw under
		// `run 01a1a81d /plan attempt 1`.
		{"the exact mid-slice",
			`'return a + b' unchanged."}, {"id": 2, "file": "app/...`,
			"structured output"},
		{"mid-slice running into the next object",
			`'return a + b' unchanged."}, {"id": 2, "file": "app/checkout.ts", "why": "reuse"`,
			"structured output"},
		// The cap cut a pretty-printed value across lines: the value's closing
		// quote sits on its own line before the container closes.
		{"mid-slice of a pretty-printed value",
			"   unchanged.\n  \"},\n  {\"id\": 2, \"file\": \"app/",
			"structured output"},
		// A slice of a top-level array of strings: no container of its own, the
		// quotes hug the commas.
		{"mid-slice of a string array",
			`ayout", "app/b.ts", "app/c.ts"`,
			"structured output"},
		// The shapes the earlier rounds pinned, beside the slice, so the
		// structural decision reads as one rule: the whole object is read as
		// the agent's words, every partial slice says what it is.
		{"whole object still reads its summary",
			`{"summary": "Pushed branch feat/cards."}`, "Pushed branch feat/cards."},
		{"tail still says structured output", `  "files": ["a.ts", "b.ts"]}}`, "structured output"},
		{"head still says structured output", `{"plan": [{"id": 1,`, "structured output"},
		// Plain prose that merely carries quotes and braces in ordinary
		// sentences is untouched — the structural decision must not reach for
		// it. A quote that hugs a letter or a digit is the sentence's own
		// quoting, not the document's.
		{"prose with quotes and braces stays",
			`Keep "return a + b" as-is; the {core} stays.`,
			`Keep "return a + b" as-is; the {core} stays.`},
		{"prose quoting numbers stays",
			`Port "5432, 5433" opened during the migration`,
			`Port "5432, 5433" opened during the migration`},
		{"prose about a plan stays",
			`the plan {steps} were "a" then "b"`,
			`the plan {steps} were "a" then "b"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cnvLastAgentLine(tc.chunk)
			if got != tc.want {
				t.Errorf("cnvLastAgentLine(%q) = %q, want %q", tc.chunk, got, tc.want)
			}
			if n := utf8.RuneCountInString(got); n > cnvLastAgentLineMax {
				t.Errorf("preview is %d runes, over the cap of %d", n, cnvLastAgentLineMax)
			}
			// The defect itself: no JSON punctuation may ever reach the row.
			for _, leaked := range []string{"\"}", "{\"", `}, `} {
				if strings.Contains(got, leaked) {
					t.Errorf("preview %q leaks JSON punctuation %q", got, leaked)
				}
			}
		})
	}
}

// TestConversationListMidSliceLastAgentLine pins the same rule on the real
// reads: a plan node whose structured output the worker's chunk cap split
// mid-value, so the newest agent chunk is the mid-slice — it starts inside
// the first step's summary string and runs on into the next object (the
// round-12 row printed `'return a + b' unchanged."}, {"id": 2, "file":` under
// the run's title). The list says `structured output` in both the project
// read and the /threads read; a prose thread beside it keeps its line.
func TestConversationListMidSliceLastAgentLine(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	midSlice := f.cnvCreate(t, f.alice, "run 01a1a81d /plan attempt 1", "")
	clAgentMessage(t, f, midSlice.ID,
		`{`+"\n"+`  "plan": [`+"\n"+`    {"id": 1, "summary": "Keep the '`)
	clAgentMessage(t, f, midSlice.ID,
		`'return a + b' unchanged."}, {"id": 2, "file": "app/checkout.ts", "why": "reuse the saved card"}`+"\n"+`  ]`+"\n"+`}`)

	prose := f.cnvCreate(t, f.alice, "Plain thread", "")
	clAgentMessage(t, f, prose.ID, `Keep "return a + b" as-is; the {core} stays.`)

	want := map[string]string{
		midSlice.ID: "structured output",
		prose.ID:    `Keep "return a + b" as-is; the {core} stays.`,
	}

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	for _, cv := range items {
		w, ok := want[cv.ID]
		if !ok {
			t.Fatalf("unexpected conversation %s in the list", cv.ID)
		}
		if cv.LastAgentLine != w {
			t.Errorf("row %s: last_agent_line = %q, want %q", cv.ID, cv.LastAgentLine, w)
		}
		if n := utf8.RuneCountInString(cv.LastAgentLine); n > cnvLastAgentLineMax {
			t.Errorf("row %s: preview is %d runes, over the cap of %d", cv.ID, n, cnvLastAgentLineMax)
		}
	}

	// The /threads page read shares the renderer, so the same mid-slice
	// answers the same muted line there.
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	for id, w := range want {
		v, ok := byView[id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", id)
		}
		if v.LastAgentLine == nil || *v.LastAgentLine != w {
			t.Errorf("cross row %s: last_agent_line = %v, want %q", id, v.LastAgentLine, w)
		}
	}
}
