package apm

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The fake apm is a shell script written into a temp dir and passed through
// StageRequest.APMPath (the existing exec seam). Stage builds apm's env from
// scratch, so the fake is configured by what is embedded in the script, not by
// environment variables: it appends its argv to a log file and writes a lock
// file with bytes the test already knows the digest of.
const fakeLockBody = `lockfileVersion: 1
dependencies:
  apm:
    - id: mattpocock/skills
      source: mattpocock/skills
      ref: v1.3.1
      resolved_commit: 24fe0ef7737efae15c87225755e9f6f5965e4888
`

func digestOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func writeFakeAPM(t *testing.T, lockBody string) (bin, logPath string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "apm")
	logPath = filepath.Join(dir, "argv.log")
	script := fmt.Sprintf(`#!/bin/sh
echo "$@" >> '%s'
cat > apm.lock.yaml <<'LOCK'
%sLOCK
mkdir -p apm_modules/mattpocock/skills .claude/skills/grill-me .agents/skills .codex
printf '# grill-me\n' > .claude/skills/grill-me/SKILL.md
printf '# vendored\n' > apm_modules/mattpocock/skills/README.md
echo '[+] fake-apm 0.34.0 mattpocock/skills #v1.3.1 @24fe0ef7'
`, logPath, lockBody)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}
	return bin, logPath
}

func newCheckout(t *testing.T) (checkout, home string) {
	t.Helper()
	root := t.TempDir()
	checkout = filepath.Join(root, "app")
	home = filepath.Join(root, "home")
	for _, d := range []string{checkout, home, filepath.Join(checkout, ".git", "info")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(checkout, "README.md"), "# app\n")
	return checkout, home
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func stageRequest(checkout, home, bin, ref, digest string) StageRequest {
	return StageRequest{
		Checkout:   checkout,
		Home:       home,
		Target:     TargetClaude,
		PackageRef: ref,
		LockDigest: digest,
		APMPath:    bin,
	}
}

// A checkout that tracks no apm.yml is materialized from the profile's ref,
// installed without --frozen (F2: --frozen refuses to bootstrap a lock), and
// gated on the digest exactly as the frozen path is (APM.md F1).
func TestStageMaterializesManifestWhenCheckoutHasNone(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, logPath := writeFakeAPM(t, fakeLockBody)

	staged, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills#v1.3.1", digestOf(fakeLockBody)))
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if !staged.ManifestGenerated {
		t.Errorf("ManifestGenerated = false, want true")
	}
	if staged.LockDigest != digestOf(fakeLockBody) {
		t.Errorf("LockDigest = %s", staged.LockDigest)
	}
	argv := readFile(t, logPath)
	if strings.Contains(argv, "--frozen") {
		t.Errorf("a checkout with no lock must not be installed --frozen (F2): %s", argv)
	}
	if !strings.Contains(argv, "install --target claude") {
		t.Errorf("argv = %q", argv)
	}

	manifest := readFile(t, filepath.Join(checkout, ManifestFileName))
	if !strings.Contains(manifest, "name: communication-profile-context") ||
		!strings.Contains(manifest, "version: 0.0.0") ||
		!strings.Contains(manifest, "description: ") ||
		!strings.Contains(manifest, "  apm:\n    - mattpocock/skills#v1.3.1\n") {
		t.Errorf("generated manifest does not match the spike shape:\n%s", manifest)
	}

	excluded := readFile(t, filepath.Join(checkout, ".git", "info", "exclude"))
	for _, want := range []string{"apm.yml", "apm.lock.yaml", "apm_modules/", ".claude/skills/"} {
		if !strings.Contains(excluded, want+"\n") {
			t.Errorf("exclusion file missing %q:\n%s", want, excluded)
		}
	}
	for _, p := range []string{"apm.yml", "apm.lock.yaml", "apm_modules"} {
		if !contains(staged.GeneratedPaths, p) {
			t.Errorf("GeneratedPaths %v missing %s", staged.GeneratedPaths, p)
		}
	}
	if _, err := os.Stat(filepath.Join(checkout, "README.md")); err != nil {
		t.Errorf("the repository's own files must be untouched: %v", err)
	}
}

// A moved tag resolves to different bytes, so the digest computed after the
// resolving install differs from the pin and the launch is refused with the
// same error class as the frozen path (probe A5 / case 14).
func TestStageMaterializedDigestMismatchRefuses(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, _ := writeFakeAPM(t, fakeLockBody)
	wrong := "sha256:" + strings.Repeat("0", 64)

	staged, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills#v1.3.1", wrong))
	var mismatch *DigestMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("err = %v (%T), want *DigestMismatch", err, err)
	}
	if staged != nil {
		t.Errorf("a refused launch must not return a staged context")
	}
	if mismatch.Recorded != wrong || mismatch.OnDisk != digestOf(fakeLockBody) || mismatch.Target != TargetClaude {
		t.Errorf("mismatch fields: %+v", mismatch)
	}
	// The generated files are excluded before the gate, so a refused launch
	// still leaves the checkout with no diff.
	excluded := readFile(t, filepath.Join(checkout, ".git", "info", "exclude"))
	if !strings.Contains(excluded, "apm.yml\n") {
		t.Errorf("exclusions must be declared even on a refusal:\n%s", excluded)
	}
}

// A repository that tracks its own manifest keeps the behaviour it had before
// ADR-0030 Amendment 1: --frozen, and nothing written into the exclusion file
// by Stage itself.
func TestStageTrackedManifestStillUsesFrozen(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, logPath := writeFakeAPM(t, fakeLockBody)
	const tracked = "name: app\nversion: 1.2.3\ndescription: tracked by the repo\ndependencies:\n  apm:\n    - mattpocock/skills#v1.3.1\n"
	writeFile(t, filepath.Join(checkout, ManifestFileName), tracked)

	staged, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills#v1.3.1", digestOf(fakeLockBody)))
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if staged.ManifestGenerated {
		t.Errorf("ManifestGenerated = true for a checkout that tracks apm.yml")
	}
	if argv := readFile(t, logPath); !strings.Contains(argv, "install --frozen --target claude") {
		t.Errorf("argv = %q, want the frozen install", argv)
	}
	if got := readFile(t, filepath.Join(checkout, ManifestFileName)); got != tracked {
		t.Errorf("the tracked manifest was rewritten:\n%s", got)
	}
	excludePath := filepath.Join(checkout, ".git", "info", "exclude")
	if _, err := os.Stat(excludePath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Stage must not touch exclusions when the repo owns the manifest (err=%v):\n%s", err, readFile(t, excludePath))
	}
}

// A subdirectory ref (ADR-0030 § 3, APM.md T-tag-5) takes the object form the
// spike documented, not the plain string.
func TestStageMaterializesObjectFormForSubdirRef(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, _ := writeFakeAPM(t, fakeLockBody)

	if _, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills/skills/engineering/ask-matt#v1.3.1", digestOf(fakeLockBody))); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	manifest := readFile(t, filepath.Join(checkout, ManifestFileName))
	for _, want := range []string{"    - git: mattpocock/skills\n", "      ref: v1.3.1\n", "      path: skills/engineering/ask-matt\n"} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q:\n%s", want, manifest)
		}
	}
}

// An unlocked pin — a ref that names a package, no lock digest — is refused at
// the launch gate (ADR-0030's invariant, restated per ADR-0054 amendment 2): there
// is nothing to compare the staged content against, so the refusal must name the
// remedy rather than let an install run unverified.
func TestStageRefusesUnlockedPin(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, logPath := writeFakeAPM(t, fakeLockBody)

	_, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills#v1.3.1", ""))
	if err == nil {
		t.Fatal("a launch with an unlocked pin (ref set, digest empty) must refuse")
	} else if !strings.Contains(err.Error(), "not locked yet") {
		t.Fatalf("err = %v, want the not-locked-yet refusal", err)
	} else if !strings.Contains(err.Error(), "Lock it on the profile") {
		t.Fatalf("err = %v, want the Lock it remedy", err)
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("apm must not run for an unlocked pin: %s", readFile(t, logPath))
	}
}

// A ref that cannot be pinned is refused before apm is ever run.
func TestStageRefusesUnparsableRefWhenManifestNeeded(t *testing.T) {
	checkout, home := newCheckout(t)
	bin, logPath := writeFakeAPM(t, fakeLockBody)

	if _, err := Stage(t.Context(), stageRequest(checkout, home, bin, "mattpocock/skills", digestOf(fakeLockBody))); err == nil {
		t.Fatal("a ref with no #<revision> must refuse the launch")
	} else if !strings.Contains(err.Error(), "not pinned") {
		t.Errorf("err = %v", err)
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("apm must not run for a ref that fails validation: %s", readFile(t, logPath))
	}
	if _, err := os.Stat(filepath.Join(checkout, ManifestFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("no manifest may be written for a rejected ref")
	}
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

func TestParsePackageRef(t *testing.T) {
	for _, tc := range []struct {
		in           string
		want         packageRef
		errSubstring string
	}{
		{in: "mattpocock/skills#v1.3.1", want: packageRef{Source: "mattpocock/skills", Revision: "v1.3.1"}},
		{in: " mattpocock/skills/skills/engineering/ask-matt#v1.3.1 ", want: packageRef{Source: "mattpocock/skills", Subdir: "skills/engineering/ask-matt", Revision: "v1.3.1"}},
		{in: "owner/repo#deadbeef", want: packageRef{Source: "owner/repo", Revision: "deadbeef"}},
		{in: "mattpocock/skills", errSubstring: "not pinned"},
		{in: "mattpocock/skills#", errSubstring: "not pinned"},
		{in: "skills#v1", errSubstring: "<owner>/<repo>"},
		{in: "", errSubstring: "empty package ref"},
		{in: "owner/repo#a#b", errSubstring: "more than one #"},
		{in: "owner/repo#v1 `touch pwned`", errSubstring: "not allowed"},
		{in: "owner/repo#v1\nevil: true", errSubstring: "not allowed"},
		{in: "owner/repo/../secrets#v1", errSubstring: "traversal"},
	} {
		got, err := parsePackageRef(tc.in)
		if tc.errSubstring != "" {
			if err == nil || !strings.Contains(err.Error(), tc.errSubstring) {
				t.Errorf("parsePackageRef(%q) err = %v, want one containing %q", tc.in, err, tc.errSubstring)
			}
			continue
		}
		if err != nil {
			t.Errorf("parsePackageRef(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("parsePackageRef(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
	}
}

func TestExcludeGeneratedAppendsOnceAndCreatesFile(t *testing.T) {
	checkout := t.TempDir()
	if err := os.MkdirAll(filepath.Join(checkout, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(checkout, ".git", "info", "exclude"), "/.idea/\n")
	for i := 0; i < 2; i++ {
		if err := excludeGenerated(checkout, materializedExclusions(TargetCodex)); err != nil {
			t.Fatalf("excludeGenerated pass %d: %v", i, err)
		}
	}
	got := readFile(t, filepath.Join(checkout, ".git", "info", "exclude"))
	if !strings.HasPrefix(got, "/.idea/\n") {
		t.Errorf("existing entries were rewritten:\n%s", got)
	}
	for _, want := range []string{"apm.yml", "apm.lock.yaml", "apm_modules/", ".agents/skills/", ".codex/"} {
		if strings.Count(got, want) != 1 {
			t.Errorf("entry %q appears %d times, want 1:\n%s", want, strings.Count(got, want), got)
		}
	}
	if strings.Contains(got, ".claude/skills/") {
		t.Errorf("codex staging must not exclude the claude tree:\n%s", got)
	}
}

// The worker's checkouts are linked worktrees of a shared mirror, so the file
// git consults is the *common* gitdir's info/exclude — the same file
// internal/workspace/git declares into. Proven against a real git.
func TestGitExclusionFileResolvesWorktreeCommonDir(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	origin := filepath.Join(root, "origin")
	runGit(t, gitBin, origin, "init", "-q", "-b", "main", origin)
	writeFile(t, filepath.Join(origin, "README.md"), "# app\n")
	runGit(t, gitBin, origin, "-c", "user.email=a@b", "-c", "user.name=a", "add", "-A")
	runGit(t, gitBin, origin, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "seed")
	work := filepath.Join(root, "work")
	runGit(t, gitBin, origin, "worktree", "add", "-q", "-b", "run", work, "HEAD")

	file, err := gitExclusionFile(work)
	if err != nil {
		t.Fatalf("gitExclusionFile: %v", err)
	}
	if want := filepath.Join(origin, ".git", "info", "exclude"); file != want {
		t.Fatalf("exclusion file = %s, want the common dir's %s", file, want)
	}
	if err := excludeGenerated(work, materializedExclusions(TargetClaude)); err != nil {
		t.Fatalf("excludeGenerated: %v", err)
	}
	// A tracked path stays visible: exclusion files do not apply to tracked
	// content, which is why the manifest is generated only for checkouts that
	// do not track one.
	ignored := exec.Command(gitBin, "-C", work, "check-ignore", "-q", "apm.yml")
	if err := ignored.Run(); err != nil {
		t.Errorf("git check-ignore says apm.yml is not ignored: %v", err)
	}
	status := exec.Command(gitBin, "-C", work, "status", "--porcelain")
	out, err := status.CombinedOutput()
	if err != nil {
		t.Fatalf("git status: %v (%s)", err, out)
	}
	if strings.TrimSpace(string(out)) != "" {
		t.Errorf("staging left a diff in the worktree:\n%s", out)
	}
}

func runGit(t *testing.T, bin, dir string, args ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, args...) //nolint:gosec // test fixture
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v (%s)", args, err, out)
	}
}
