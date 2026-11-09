package assistant

// The DIFF half of the catch-up DATA block (ADR-0078 § Patch artifacts).
//
// A tour could always say what a run did; it could never show a line of it,
// because no server-readable source held a run's diff. The worker now files a
// bounded, secret-scanned `patch` artifact at its unit boundaries, and this file
// is the reader's side of that: the hunks it quotes are copied out of those
// artifacts, numbered as ordinary E-ids, and — when the model cites one — copied
// back out as `{type:"diff", source:<file>, text:<hunk>}` evidence by the same
// server rule that already governs logs. The model never writes a hunk and never
// writes a path; it chooses an id.
//
// What is NOT here: any claim that the patch is the whole change. It is what
// the worker stored, bounded twice (the artifact's own 64 KiB hunk-boundary cap,
// then CatchUpGenMaxDiffHunks × CatchUpGenDiffHunkMaxLines here), and a hunk that
// was clipped says so on its own last line.

import (
	"fmt"
	"sort"
	"strings"
)

// catchUpChooseDiffs picks the hunks the DATA block quotes: at most
// CatchUpGenMaxDiffHunks of them, each bounded by clipCatchUpDiffHunk.
//
// The ordering rule is stated rather than clever. A file the run's OWN words
// already name — the goal, a beat of the tour being rewritten, the thread's tail
// — goes first, because that is the only "this one mattered" signal the server
// holds before a model has answered anything; the rest follow by size, because a
// bigger hunk is more of the change. Ties break on the path, so two generations
// of one run quote the same hunks and a re-told story keeps the proof its reader
// already saw.
func catchUpChooseDiffs(facts CatchUpRunFacts, cand CatchUpCandidate) []CatchUpDiffHunk {
	if len(facts.Diffs) == 0 {
		return nil
	}
	hints := catchUpDiffHints(facts, cand)
	ranked := make([]CatchUpDiffHunk, 0, len(facts.Diffs))
	for _, h := range facts.Diffs {
		if strings.TrimSpace(h.File) == "" || strings.TrimSpace(h.Lines) == "" {
			continue // a hunk with no file to show is the invention this rule exists to stop
		}
		ranked = append(ranked, clipCatchUpDiffHunk(h))
	}
	mentionRank := func(h CatchUpDiffHunk) int {
		if catchUpDiffNamed(hints, h.File) {
			return 0
		}
		return 1
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		ri, rj := mentionRank(ranked[i]), mentionRank(ranked[j])
		if ri != rj {
			return ri < rj
		}
		if ranked[i].Bytes != ranked[j].Bytes {
			return ranked[i].Bytes > ranked[j].Bytes
		}
		return ranked[i].File < ranked[j].File
	})
	if len(ranked) > CatchUpGenMaxDiffHunks {
		ranked = ranked[:CatchUpGenMaxDiffHunks]
	}
	return ranked
}

// catchUpDiffHints is the lowercase text a file name may show up in: the run's
// goal and title, the beats of the tour being rewritten, and the thread's tail.
func catchUpDiffHints(facts CatchUpRunFacts, cand CatchUpCandidate) []string {
	hints := make([]string, 0, 2+len(cand.HeadStops)+len(facts.Lines))
	for _, s := range []string{facts.Goal, facts.Title} {
		if s != "" {
			hints = append(hints, strings.ToLower(s))
		}
	}
	for _, st := range cand.HeadStops {
		if st.Title != "" {
			hints = append(hints, strings.ToLower(st.Title))
		}
	}
	for _, l := range facts.Lines {
		if l.Text != "" {
			hints = append(hints, strings.ToLower(l.Text))
		}
	}
	return hints
}

// catchUpDiffNamed asks whether any hint names the file — by its full path or by
// its last component. A hint saying `hello.py` mentions `work/hello.py`; a hint
// saying only `hello` does not, because a stem substring matches half the tree.
func catchUpDiffNamed(hints []string, file string) bool {
	lower := strings.ToLower(file)
	base := lower
	if i := strings.LastIndexByte(base, '/'); i >= 0 {
		base = base[i+1:]
	}
	for _, hint := range hints {
		if strings.Contains(hint, lower) || (base != lower && strings.Contains(hint, base)) {
			return true
		}
	}
	return false
}

// clipCatchUpDiffHunk bounds one hunk to the line cap AND to the block's own
// per-excerpt character bound, on whole lines both times: a hunk whose counts do
// not add up is a fabricated patch, so the cut never lands inside a line. It
// refreshes Bytes so the size ordering reads on what the block actually quotes,
// and it says what it left out.
func clipCatchUpDiffHunk(h CatchUpDiffHunk) CatchUpDiffHunk {
	lines := strings.Split(strings.TrimRight(h.Lines, "\n"), "\n")
	held := lines
	hidden := 0
	if len(held) > CatchUpGenDiffHunkMaxLines {
		hidden = len(held) - CatchUpGenDiffHunkMaxLines
		held = held[:CatchUpGenDiffHunkMaxLines]
	}
	// The character bound bites only when the line cap left something too big to
	// quote; it drops whole trailing lines and counts those too.
	for len(held) > 1 && len(strings.Join(held, "\n")) > CatchUpGenEvidenceMaxChars {
		held = held[:len(held)-1]
		hidden++
	}
	if hidden > 0 {
		held = append(held, fmt.Sprintf("… (%d more lines not shown)", hidden))
	}
	h.Lines = strings.Join(held, "\n") + "\n"
	h.Bytes = len(h.Lines)
	return h
}
