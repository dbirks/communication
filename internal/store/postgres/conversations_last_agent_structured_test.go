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

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "")
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

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "")
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
