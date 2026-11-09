package git

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The patch half of a unit capture. `Status` answers the bookkeeping question
// (how many paths differ, is the tree dirty) and `Summary.Diff` is its
// `--stat` line; neither is a *reviewable* diff. ADR-0078 § Patch artifacts
// needs one place in the tree that says what actually changed, and the only
// honest place to read it is the same unsandboxed `git -C <checkout>` read the
// capture already runs (AGENTS.md: the worker's own git plumbing is never put
// under Landlock; the agent's child processes are).
//
// This is capture-only like every other read here (ADR-0017 D8, D-024 stays
// Open): a patch artifact records what the tree said at one boundary. Nothing
// in this file re-applies, stages or commits anything.

// Patch is one checkout's unified diff against a base, bounded to a byte cap at
// a hunk boundary. The counts are the counts of the FULL diff — a reader told
// "42 files, 5 118 lines total, this is the first 64 KiB" can judge the
// truncation, which a clipped blob cannot.
type Patch struct {
	Text string
	// Files counts the `diff --git` sections of the full diff.
	Files int
	// Lines counts the lines of the full diff.
	Lines int
	// Truncated is true when Text holds fewer bytes than the whole diff.
	Truncated bool
}

// patchNewFileMaxBytes bounds what one untracked file contributes to a patch:
// an agent that dropped a 40 MB vendored blob into the tree must not make the
// capture read it all. Over the bound the file is named, not quoted.
const patchNewFileMaxBytes = 64 << 10

// Patch renders one checkout's unified diff against baseCommit: everything the
// tree now says that the base did not, whether the agent committed it, staged
// it or left it in the working tree (`git diff <base>` compares the base commit
// to the working tree, so a moved ref and an uncommitted edit both show up),
// plus a new-file section for each untracked path.
//
// The excluded set is applied twice on purpose (ADR-0017 D6): once as git
// pathspecs, and once here in Go, because the exclusion file lives in the
// mirror's admin directory — editable by anything with write access to it —
// while this filter is code. An excluded path therefore contributes nothing to
// the returned text even if git's ignore state moved under the capture.
//
// An empty baseCommit falls back to HEAD, which is the honest reading of "what
// changed in this attempt" for a capture whose row never recorded a base.
func (m *Manager) Patch(ctx context.Context, checkout string, baseCommit string, excluded []string) (string, error) {
	raw, err := m.trackedPatch(ctx, checkout, baseCommit, excluded)
	if err != nil {
		return "", err
	}
	fresh, err := m.untrackedPatch(ctx, checkout, excluded)
	if err != nil {
		// The tracked half is already the security-relevant reading of the
		// tree; a `ls-files` that will not run degrades the patch to
		// modifications-only rather than losing the whole diff.
		fresh = "(new files unread: " + Redact(err.Error()) + ")\n"
	}
	return raw + fresh, nil
}

// trackedPatch is `git diff <base>` with the exclusion set as pathspecs, then
// filtered again in Go.
func (m *Manager) trackedPatch(ctx context.Context, checkout string, baseCommit string, excluded []string) (string, error) {
	argv := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "--no-renames"}
	if base := strings.TrimSpace(baseCommit); base != "" && !strings.HasPrefix(base, "-") {
		argv = append(argv, base)
	} else {
		argv = append(argv, "HEAD")
	}
	argv = append(argv, "--", ".")
	for _, spec := range excludePathspecs(excluded) {
		argv = append(argv, spec)
	}
	out, err := m.Git.Stdout(ctx, checkout, argv...)
	if err != nil {
		return "", fmt.Errorf("workspace: diff of %s: %w", checkout, err)
	}
	return filterPatch(out, excluded), nil
}

// untrackedPatch quotes the paths `git status` would call untracked (and that
// git's own ignore rules do NOT already hide) as new-file sections. They are
// not in `git diff`, and an agent that answered a task by writing a new file
// would otherwise have produced an empty patch — which is exactly the fiction
// ADR-0078's patch artifact exists to close.
//
// The section is assembled here rather than through `git diff --no-index`
// because that form prints the caller's own path spelling in its header: an
// absolute checkout path inside a browser-visible artifact is a host-path leak,
// and `ls-files --others` answers with checkout-relative slashes.
func (m *Manager) untrackedPatch(ctx context.Context, checkout string, excluded []string) (string, error) {
	out, err := m.Git.Stdout(ctx, checkout, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return "", fmt.Errorf("workspace: untracked paths of %s: %w", checkout, err)
	}
	var b strings.Builder
	for _, line := range strings.Split(out, "\n") {
		path := filepath.ToSlash(strings.TrimSpace(line))
		if path == "" || dropPath(path, excluded) {
			continue
		}
		writeNewFilePatch(ctx, &b, checkout, path)
	}
	return b.String(), nil
}

// writeNewFilePatch appends one `+++ b/<path>` section. A file that is not
// regular, not readable, or bigger than patchNewFileMaxBytes is named with a
// `\ No newline`-style comment line instead of quoted: the patch says the path
// appeared without pretending to carry content it did not read.
func writeNewFilePatch(_ context.Context, b *strings.Builder, checkout, path string) {
	fmt.Fprintf(b, "diff --git a/%s b/%s\nnew file mode %s\n--- /dev/null\n+++ b/%s\n",
		path, path, modeFor(filepath.Join(checkout, path)), path)
	content, size, ok := readPatchFile(filepath.Join(checkout, path))
	if !ok {
		fmt.Fprintf(b, "@@ -0,0 +0,0 @@\n# (not quoted: %d bytes over the patch read bound, or not a regular file)\n", size)
		return
	}
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	fmt.Fprintf(b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteString("+" + line + "\n")
	}
}

// readPatchFile returns a file's text when it is a regular file under the read
// bound that does not look binary. Binary content in a unified diff is noise
// the truncation rule cannot bound meaningfully, and the manifest already
// names the path.
func readPatchFile(absolute string) (string, int, bool) {
	info, err := os.Stat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		return "", 0, false
	}
	if info.Size() > patchNewFileMaxBytes {
		return "", int(info.Size()), false
	}
	content, err := os.ReadFile(absolute)
	if err != nil {
		return "", int(info.Size()), false
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return "", int(info.Size()), false
	}
	return string(content), int(info.Size()), true
}

// modeFor is the file's octet mode as git would spell it in a new-file header,
// with the only distinction that matters for a reader being executable or not.
func modeFor(absolute string) string {
	info, err := os.Stat(absolute)
	if err == nil && info.Mode().Perm()&0o111 != 0 {
		return "100755"
	}
	return "100644"
}

// excludePathspecs turns a declared exclusion set into git exclude pathspecs.
// `literal` is deliberate: these are paths, not patterns, and a set containing
// `reports/2026` must not be read as a glob.
func excludePathspecs(excluded []string) []string {
	var out []string
	for _, e := range excluded {
		e = strings.TrimPrefix(strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(e)), "./"), "/")
		if e == "" || strings.Contains(e, "..") {
			continue
		}
		out = append(out, ":(exclude,literal)"+strings.TrimSuffix(e, "/"))
	}
	return out
}

// dropPath is the Go-side half of the second filter: exact or directory match,
// slash-normalized, the same rule the artifact store's own re-filter applies.
func dropPath(path string, excluded []string) bool {
	path = strings.TrimPrefix(filepath.ToSlash(path), "./")
	for _, e := range excluded {
		e = strings.TrimPrefix(strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(e)), "./"), "/")
		if e == "" {
			continue
		}
		e = strings.TrimSuffix(e, "/")
		if path == e || strings.HasPrefix(path, e+"/") {
			return true
		}
	}
	return false
}

// filterPatch drops whole file sections whose path is excluded. Sections are
// delimited by git's own `diff --git` header; anything before the first header
// (a warning line, say) is kept, because dropping it would hide the reason a
// half of the diff is missing.
func filterPatch(diff string, excluded []string) string {
	if len(excluded) == 0 || diff == "" {
		return diff
	}
	var keep strings.Builder
	inDropped := false
	for _, line := range strings.SplitAfter(diff, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			inDropped = dropPath(patchHeaderPath(line), excluded)
		}
		if !inDropped {
			keep.WriteString(line)
		}
	}
	return keep.String()
}

// patchHeaderPath reads b/<path> out of a `diff --git a/x b/x` header. A header
// git wrote with a quoted or renamed path yields "" and the section is kept —
// keeping a section is the conservative direction when the parse is unsure,
// because git's own pathspec filter already ran.
func patchHeaderPath(header string) string {
	const marker = " b/"
	head := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(header), "diff --git a/"), "\n")
	i := strings.LastIndex(head, marker)
	if i < 0 {
		return ""
	}
	return head[i+len(marker):]
}

// BoundPatch clips a unified diff to maxBytes AT A HUNK BOUNDARY and reports
// what the whole diff held. A mid-hunk clip would be a fabricated diff — the
// line counts would not add up and the reader could not tell — so the cut only
// ever lands between complete hunks, and a file section whose hunks do not fit
// is left out whole.
func BoundPatch(text string, maxBytes int) Patch {
	files, lines := countPatchLines(text)
	if maxBytes <= 0 || len(text) <= maxBytes {
		return Patch{Text: text, Files: files, Lines: lines}
	}
	// The marker's own bytes are charged to the cap: the artifact the store
	// gets is the one that fits, note and all.
	marker := fmt.Sprintf("… (truncated, %d files, %d lines total)\n", files, lines)
	remaining := maxBytes - len(marker)
	if remaining < 0 {
		remaining = 0
	}
	var out strings.Builder
	for _, section := range splitPatchSections(text) {
		if len(section.body) <= remaining {
			out.WriteString(section.body)
			remaining -= len(section.body)
			continue
		}
		// The cut lands here, between hunks: the largest run of this section's
		// leading hunks that still fits, then the note.
		out.WriteString(sectionFit(section, remaining))
		break
	}
	return Patch{Text: out.String() + marker, Files: files, Lines: lines, Truncated: true}
}

type patchSection struct {
	header string // index lines before the first hunk
	hunks  []string
	body   string
}

// splitPatchSections cuts a diff into per-file sections at `diff --git`
// headers. Leading text before the first header rides on the first section.
func splitPatchSections(text string) []patchSection {
	var sections []patchSection
	current := patchSection{}
	started := false
	for _, line := range strings.SplitAfter(text, "\n") {
		if strings.HasPrefix(line, "diff --git ") && started {
			sections = append(sections, current)
			current = patchSection{}
		}
		if strings.HasPrefix(line, "diff --git ") {
			started = true
		}
		if strings.HasPrefix(line, "@@") {
			current.hunks = append(current.hunks, line)
			continue
		}
		if len(current.hunks) == 0 {
			current.header += line
		} else {
			current.hunks[len(current.hunks)-1] += line
		}
	}
	if current.header != "" || len(current.hunks) > 0 {
		sections = append(sections, current)
	}
	for i := range sections {
		sections[i].body = sections[i].header + strings.Join(sections[i].hunks, "")
	}
	return sections
}

// sectionFit is the largest run of a section's leading hunks that fits the
// remaining budget, with its header. The section header is charged to the
// budget too: a patch that reports a file it did not have room for is the
// fabrication this function exists to avoid.
func sectionFit(s patchSection, budget int) string {
	if len(s.header) > budget {
		return ""
	}
	out := s.header
	used := len(out)
	for _, h := range s.hunks {
		if used+len(h) > budget {
			break
		}
		out += h
		used += len(h)
	}
	return out
}

// countPatchLines counts `diff --git` sections and total lines, on the whole
// text — these are the numbers the truncation note quotes.
func countPatchLines(text string) (files, lines int) {
	if text == "" {
		return 0, 0
	}
	lines = strings.Count(text, "\n")
	if !strings.HasSuffix(text, "\n") {
		lines++
	}
	return strings.Count(text, "\ndiff --git ") + boolToInt(strings.HasPrefix(text, "diff --git ")), lines
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
