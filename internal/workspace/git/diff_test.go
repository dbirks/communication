package git

// The patch half of the unit capture (ADR-0078 § Patch artifacts): a
// reviewable unified diff of one checkout against the base the row recorded.
// These run the real git binary for the same reason every other test in this
// package does — the thing under test is what git answers about an actual tree,
// which a fake cannot tell us. BoundPatch's own arm is pure text and is driven
// with a synthetic diff so the hunk-boundary rule is asserted on a shape too
// large to type out.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// newScratchRepo seeds a plain working repository (no mirror, no worktree — a
// patch is read with `git -C <checkout>` and nothing else) with one commit on
// main, and returns its path and that commit's sha: the base a capture names.
func newScratchRepo(t *testing.T, root string) (string, string) {
	t.Helper()
	out, err := exec.Command("git", "--version").CombinedOutput()
	if err != nil {
		t.Skipf("git binary required: %v\n%s", err, out)
	}
	work := filepath.Join(root, "checkout")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, work, "init", "-q", "-b", "main", work)
	run(t, work, "config", "user.name", "communication-test")
	run(t, work, "config", "user.email", "test@communication.invalid")
	writeFile(t, filepath.Join(work, "hello.py"), "print('hello')\n")
	writeFile(t, filepath.Join(work, ".env"), "TOKEN=base-value\n")
	run(t, work, "add", "-A")
	run(t, work, "commit", "-qm", "seed")
	return work, run(t, work, "rev-parse", "HEAD")
}

func patchManager(t *testing.T, root string) *Manager {
	t.Helper()
	setGitIdentity(t)
	m, err := NewManager(filepath.Join(root, "workspaces"), filepath.Join(root, "repos"),
		&Runner{Home: filepath.Join(root, "launcher-home")})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m
}

func TestPatchQuotesCommittedAndUncommittedChanges(t *testing.T) {
	root := labDir(t)
	work, base := newScratchRepo(t, root)
	m := patchManager(t, root)

	// Three shapes of the same edit, because a capture must not depend on which
	// one the agent happened to choose: a committed modification, an
	// uncommitted one, and a brand-new untracked file (which `git diff` alone
	// never shows, and which is how most "the agent wrote the feature" turns
	// actually look).
	writeFile(t, filepath.Join(work, "hello.py"), "print('hello')\nprint('world')\n")
	run(t, work, "add", "hello.py")
	run(t, work, "commit", "-qm", "the committed half")
	writeFile(t, filepath.Join(work, "notes.txt"), "one\n")
	run(t, work, "add", "notes.txt")
	run(t, work, "commit", "-qm", "notes")
	writeFile(t, filepath.Join(work, "left.py"), "left = 1\n")

	patch, err := m.Patch(context.Background(), work, base, nil)
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	for _, want := range []string{
		"diff --git a/hello.py b/hello.py",
		"+print('world')",
		"diff --git a/notes.txt b/notes.txt",
		"+one",
		"diff --git a/left.py b/left.py",
		"new file mode",
		"+left = 1",
	} {
		if !strings.Contains(patch, want) {
			t.Fatalf("the patch lacks %q:\n%s", want, patch)
		}
	}
	// The base's own lines are context, not additions: a patch that quoted the
	// whole file would be a copy, not a diff.
	if strings.Contains(patch, "+print('hello')") {
		t.Fatalf("the patch re-quotes untouched content:\n%s", patch)
	}
	// A host path in a browser-visible artifact is the leak ADR-0020 § 2 names:
	// every path a patch carries is checkout-relative.
	if strings.Contains(patch, work) {
		t.Fatalf("the patch carries the checkout's absolute path:\n%s", patch)
	}
}

func TestPatchSubtractsDeclaredExclusionsTwice(t *testing.T) {
	root := labDir(t)
	work, base := newScratchRepo(t, root)
	m := patchManager(t, root)

	// A tracked `.env` and a directory under `build/`: what the worker declared
	// excluded must leave no trace in the patch, and the second filter is the
	// one that holds when git's ignore state moved under the capture (ADR-0017
	// D6) — so this fixture keeps the paths TRACKED, which is the case git's own
	// exclusion machinery does not hide on its own.
	writeFile(t, filepath.Join(work, ".env"), "TOKEN=base-value\nTOKEN_SECRET=s3cr3t-token-value\n")
	if err := os.MkdirAll(filepath.Join(work, "build"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(work, "build", "gen.go"), "package main\n")
	writeFile(t, filepath.Join(work, "hello.py"), "print('changed')\n")

	patch, err := m.Patch(context.Background(), work, base,
		[]string{".env", "build/"})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if !strings.Contains(patch, "+print('changed')") {
		t.Fatalf("the included path lost its hunk:\n%s", patch)
	}
	for _, forbidden := range []string{".env", "build/gen.go", "s3cr3t-token-value"} {
		if strings.Contains(patch, forbidden) {
			t.Fatalf("the patch carries the excluded path or value %q:\n%s", forbidden, patch)
		}
	}
}

// TestPatchIgnoresNothingWhenBaseIsUnknown pins the fallback: a capture whose
// row never recorded a base reads against HEAD, which is "what this attempt
// changed", not "everything ever".
func TestPatchIgnoresNothingWhenBaseIsUnknown(t *testing.T) {
	root := labDir(t)
	work, base := newScratchRepo(t, root)
	m := patchManager(t, root)
	writeFile(t, filepath.Join(work, "hello.py"), "print('later')\n")

	patch, err := m.Patch(context.Background(), work, "", nil)
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if !strings.Contains(patch, "+print('later')") {
		t.Fatalf("an empty base did not read against HEAD:\n%s", patch)
	}
	if strings.Contains(patch, base) {
		t.Fatalf("the base sha leaked into the patch text:\n%s", patch)
	}
}

// syntheticDiff is a diff with `files` sections of `hunks` hunks each, every
// hunk `lines` long — a shape the truncation test can measure exactly.
func syntheticDiff(files, hunks, lines int) string {
	var b strings.Builder
	for f := 1; f <= files; f++ {
		fmt.Fprintf(&b, "diff --git a/f%d.go b/f%d.go\nindex 1111111..2222222 100644\n", f, f)
		fmt.Fprintf(&b, "--- a/f%d.go\n+++ b/f%d.go\n", f, f)
		for h := 1; h <= hunks; h++ {
			fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", h*lines, lines, h*lines, lines)
			for l := 0; l < lines; l++ {
				fmt.Fprintf(&b, "+func%d_%d_%d()\n", f, h, l)
			}
		}
	}
	return b.String()
}

func TestBoundPatchCutsAtHunkBoundaries(t *testing.T) {
	const capBytes = 64 << 10
	full := syntheticDiff(40, 5, 40)
	if len(full) <= capBytes {
		t.Fatalf("the fixture is not over the bound: %d bytes", len(full))
	}
	bound := BoundPatch(full, capBytes)
	if !bound.Truncated {
		t.Fatal("a diff over the bound was not marked truncated")
	}
	if len(bound.Text) > capBytes {
		t.Fatalf("the bounded patch is %d bytes over a %d cap", len(bound.Text), capBytes)
	}
	note := fmt.Sprintf("… (truncated, %d files, %d lines total)\n", bound.Files, bound.Lines)
	if !strings.HasSuffix(bound.Text, note) {
		t.Fatalf("the patch does not end with its own measure %q:\n%s", note, bound.Text)
	}
	if bound.Files != 40 {
		t.Fatalf("the note names %d files of a 40-file diff", bound.Files)
	}
	// The rule: every hunk that survived is whole. A `@@ -a,b +c,d @@` header
	// inside the artifact must be followed by exactly d new-side lines, so a
	// reader can never be shown a hunk whose counts do not add up.
	lines := strings.Split(bound.Text, "\n")
	for i, l := range lines {
		if !strings.HasPrefix(l, "@@ -") {
			continue
		}
		want := hunkNewCount(t, l)
		seen := 0
		for j := i + 1; j < len(lines); j++ {
			next := lines[j]
			if next == "" || strings.HasPrefix(next, "@@ ") || strings.HasPrefix(next, "diff --git ") ||
				strings.HasPrefix(next, "…") {
				break
			}
			seen++
		}
		if seen != want {
			t.Fatalf("hunk %q kept %d of %d lines: the patch was cut mid-hunk\n%s", l, seen, want, bound.Text)
		}
	}
	// And it is a prefix of the whole, never a rewrite of it.
	if body := strings.TrimSuffix(bound.Text, note); !strings.HasPrefix(full, body) {
		t.Fatalf("the bounded patch is not a prefix of the diff it came from:\n%s", body)
	}
}

// hunkNewCount reads the new-side line count out of a `@@ -a,b +c,d @@` header.
func hunkNewCount(t *testing.T, header string) int {
	t.Helper()
	inner := strings.TrimPrefix(header, "@@ ")
	parts := strings.Fields(strings.SplitN(inner, "@@", 2)[0])
	if len(parts) != 2 {
		t.Fatalf("hunk header %q is not `-a,b +c,d`", header)
	}
	newSide := strings.Split(parts[1], ",")
	if len(newSide) != 2 {
		t.Fatalf("hunk header %q has no new-side count", header)
	}
	n, err := strconv.Atoi(newSide[1])
	if err != nil {
		t.Fatalf("hunk header %q: %v", header, err)
	}
	return n
}

func TestBoundPatchLeavesSmallDiffsAlone(t *testing.T) {
	small := syntheticDiff(1, 1, 3)
	bound := BoundPatch(small, 64<<10)
	if bound.Truncated || bound.Text != small {
		t.Fatalf("a diff under the bound was rewritten: truncated=%v text=%q", bound.Truncated, bound.Text)
	}
	if bound.Files != 1 {
		t.Fatalf("file count = %d, want 1", bound.Files)
	}
}

// filterPatch is the Go-side second filter on its own: the case git's pathspecs
// already honored, expressed as text, so a change to the exclusion set cannot
// be the only thing between a secret and an artifact.
func TestFilterPatchDropsWholeSections(t *testing.T) {
	diff := "diff --git a/.env b/.env\nindex 1..2 100644\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-TOKEN=base-value\n+TOKEN_SECRET=s3cr3t-token-value\n" +
		"diff --git a/build/gen.go b/build/gen.go\nnew file mode 100644\n--- /dev/null\n+++ b/build/gen.go\n@@ -0,0 +1 @@\n+package main\n" +
		"diff --git a/hello.py b/hello.py\nindex 3..4 100644\n--- a/hello.py\n+++ b/hello.py\n@@ -1 +1 @@\n-print(\"a\")\n+print(\"b\")\n"
	out := filterPatch(diff, []string{".env", "build"})
	if strings.Contains(out, "s3cr3t-token-value") || strings.Contains(out, "build/gen.go") {
		t.Fatalf("the excluded sections survived the filter:\n%s", out)
	}
	if !strings.Contains(out, "+print(\"b\")") {
		t.Fatalf("the kept section lost its hunk:\n%s", out)
	}
}
