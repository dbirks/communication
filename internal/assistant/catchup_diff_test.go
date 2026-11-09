package assistant

// The DIFF excerpts in the catch-up block (ADR-0078 § Patch artifacts): the
// hunks the worker filed as `patch` artifacts are numbered like every other
// excerpt, the model may cite them and nothing else, and the server copies a
// cited hunk into evidence with the FILE it came from — a path the model never
// had to write, because it arrived with the excerpt.
//
// The tests below are the three halves of that promise: a cited diff becomes
// `{type:"diff", source:<file>, text:<hunk>}`; an uncited or invented id
// becomes nothing; and the block stays bounded (three hunks, sixty lines each,
// the run's own words deciding which) however many hunks the read handed over.

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func diffHunk(file string, lines int) CatchUpDiffHunk {
	var b strings.Builder
	fmt.Fprintf(&b, "@@ -1,%d +1,%d @@\n", lines, lines)
	for i := 1; i <= lines; i++ {
		fmt.Fprintf(&b, "+%s line %d\n", file, i)
	}
	return CatchUpDiffHunk{File: file, Lines: b.String(), Bytes: b.Len()}
}

func diffFacts(hunks ...CatchUpDiffHunk) CatchUpRunFacts {
	f := catchUpTestFacts()
	f.Diffs = hunks
	return f
}

func TestCatchUpCitedDiffBecomesDiffEvidence(t *testing.T) {
	facts := diffFacts(diffHunk("checkout/spec.ts", 4), diffHunk("docs/plan.md", 3))
	// E1 is the code-refs (files) excerpt of the outputs; the two hunks are E2
	// and E3. The answer cites the spec hunk and an id the block never held.
	answer := catchUpAnswerJSON(`[{"id":"the-fix","title":"The spec stopped retrying","narrative":"The retry loop is gone from the spec itself.","kind":"FIXED","importance":"must_know","evidence_ids":["E2","E77"]}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	w := f.writer.snapshot()[0]
	if len(w.Stops) != 1 {
		t.Fatalf("stops = %+v", w.Stops)
	}
	ev := w.Stops[0].Evidence
	if len(ev) != 1 {
		t.Fatalf("evidence = %+v, want the one cited hunk copied and E77 dropped", ev)
	}
	if ev[0].Type != CatchUpEvidenceKindDiff {
		t.Fatalf("evidence type = %q, want %q", ev[0].Type, CatchUpEvidenceKindDiff)
	}
	if got, _ := ev[0].Payload["source"].(string); got != "checkout/spec.ts" {
		t.Fatalf("evidence source = %q, want the hunk's own file", got)
	}
	text, _ := ev[0].Payload["text"].(string)
	if !strings.Contains(text, "@@ -1,4 +1,4 @@") || !strings.Contains(text, "+checkout/spec.ts line 4") {
		t.Fatalf("evidence text = %q, want the hunk copied whole", text)
	}
	if _, smuggled := ev[0].Payload["type"]; smuggled {
		t.Fatal("the payload carries its own type member")
	}
}

func TestCatchUpUncitedDiffWritesNoEvidence(t *testing.T) {
	facts := diffFacts(diffHunk("checkout/spec.ts", 4))
	answer := catchUpAnswerJSON(`[{"id":"the-fix","title":"The spec stopped retrying","narrative":"The retry loop is gone.","kind":"FIXED","importance":"must_know","evidence_ids":["E1"]}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	ev := f.writer.snapshot()[0].Stops[0].Evidence
	if len(ev) != 1 || ev[0].Type != CatchUpEvidenceKindFiles {
		t.Fatalf("evidence = %+v, want only the cited files excerpt: an uncited hunk writes no diff", ev)
	}
	for _, e := range ev {
		if e.Type == CatchUpEvidenceKindDiff {
			t.Fatalf("an uncited hunk reached the tour as diff evidence: %+v", e)
		}
	}
}

// A model that invents a diff id gets nothing, and the answer still writes: the
// citation is the model's, the excerpt is the server's.
func TestCatchUpInventedDiffIdIsDropped(t *testing.T) {
	facts := diffFacts(diffHunk("checkout/spec.ts", 4))
	answer := catchUpAnswerJSON(`[{"id":"the-fix","title":"The spec stopped retrying","narrative":"Gone.","kind":"FIXED","importance":"routine","evidence_ids":["E9"]}]`)
	f := newCatchUpFixture(t, answer, catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	if ev := f.writer.snapshot()[0].Stops[0].Evidence; len(ev) != 0 {
		t.Fatalf("an id outside the block produced evidence: %+v", ev)
	}
}

func TestCatchUpBlockBoundsTheHunksItQuotes(t *testing.T) {
	facts := diffFacts(
		diffHunk("a.ts", 3), diffHunk("b.ts", 5), diffHunk("c.ts", 7),
		diffHunk("d.ts", 9), diffHunk("e.ts", 11),
	)
	f := newCatchUpFixture(t, catchUpAnswerJSON(
		`[{"id":"s","title":"A beat","narrative":"A narrative.","importance":"routine"}]`),
		catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	block := f.model.user
	if got := strings.Count(block, `"kind": "diff"`); got > CatchUpGenMaxDiffHunks {
		t.Fatalf("the block quotes %d diff excerpts, over the %d bound", got, CatchUpGenMaxDiffHunks)
	}
	// Largest first: the two biggest hunks (e.ts 11, d.ts 9) made the cut, and
	// the three smallest did not.
	for _, want := range []string{"e.ts", "d.ts", "c.ts"} {
		if !strings.Contains(block, want) {
			t.Fatalf("the block dropped %q while the cap leaves room for the largest hunks:\n%s", want, block)
		}
	}
	for _, gone := range []string{"a.ts", "b.ts"} {
		if strings.Contains(block, gone) {
			t.Fatalf("the block quoted %q, a smaller hunk than the ones it kept:\n%s", gone, block)
		}
	}
}

func TestCatchUpBlockPrefersAFileTheRunNames(t *testing.T) {
	facts := diffFacts(diffHunk("src/auth/token.ts", 2), diffHunk("vendor/big.ts", 400))
	facts.Goal = "Rotate the signing key in src/auth/token.ts"
	f := newCatchUpFixture(t, catchUpAnswerJSON(
		`[{"id":"s","title":"A beat","narrative":"A narrative.","importance":"routine"}]`),
		catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	block := f.model.user
	atName, atVendor := strings.Index(block, "src/auth/token.ts"), strings.Index(block, "vendor/big.ts")
	if atName < 0 {
		t.Fatalf("the file the run named is not in the block:\n%s", block)
	}
	if atVendor >= 0 && atVendor < atName {
		t.Fatalf("the bigger hunk outranked the file the run named:\n%s", block)
	}
}

// A hunk over the line cap is clipped ON WHOLE LINES and says so: the reader of
// the evidence sees the note, so a bounded quote is never mistaken for the
// change.
func TestCatchUpClippedHunkSaysItWasClipped(t *testing.T) {
	h := clipCatchUpDiffHunk(diffHunk("big.ts", CatchUpGenDiffHunkMaxLines+50))
	lines := strings.Split(strings.TrimRight(h.Lines, "\n"), "\n")
	if len(lines) != CatchUpGenDiffHunkMaxLines+1 {
		t.Fatalf("the clipped hunk holds %d lines, want the cap plus the note", len(lines))
	}
	// The fixture's hunk is one header line plus cap+50 content lines, and the
	// cap holds sixty of them: the note counts the sixty-first content line too.
	wantHidden := len(strings.Split(strings.TrimRight(diffHunk("big.ts", CatchUpGenDiffHunkMaxLines+50).Lines, "\n"), "\n")) - CatchUpGenDiffHunkMaxLines
	if !strings.HasPrefix(lines[len(lines)-1], fmt.Sprintf("… (%d more lines not shown)", wantHidden)) {
		t.Fatalf("the clip note is %q", lines[len(lines)-1])
	}
	if !strings.HasPrefix(lines[0], "@@ ") {
		t.Fatalf("the clip lost the hunk header: %q", lines[0])
	}
}

// The block's total cap still trims excerpts from the end; the diffs are
// numbered first, so a byte-tight block loses transcript lines before it loses
// the only reviewable evidence it had.
func TestCatchUpByteCapKeepsTheDiffs(t *testing.T) {
	facts := diffFacts(diffHunk("keep.ts", 30))
	facts.Lines = make([]ChatLine, 0, CatchUpGenMaxLines)
	for i := 0; i < CatchUpGenMaxLines; i++ {
		facts.Lines = append(facts.Lines, ChatLine{
			Author: "agent", Text: strings.Repeat("a long thread line ", 12),
		})
	}
	f := newCatchUpFixture(t, catchUpAnswerJSON(
		`[{"id":"s","title":"A beat","narrative":"A narrative.","importance":"routine"}]`),
		catchUpTestCandidate(), facts)
	if err := f.gen.GenerateRun(context.Background(), Caller{}, catchUpTestCandidate()); err != nil {
		t.Fatalf("GenerateRun: %v", err)
	}
	if !strings.Contains(f.model.user, "keep.ts") {
		t.Fatalf("the byte cap dropped the run's only hunk while a thread tail survived:\n%s",
			f.model.user)
	}
}
