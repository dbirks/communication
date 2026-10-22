// Package apm stages a pinned APM package set into a run checkout before the
// agent launches, and refuses to launch when what is on disk is not what the
// profile recorded.
//
// Staging runs in the worker process, unsandboxed, by design: APM writes into
// the checkout and into whatever HOME it is given (probe A2 observed it creating
// .apm and .cache/apm in the per-run home), and an agent that could choose its
// own context would be able to widen its own sandbox. The context is therefore
// decided and installed *before* the grant set is built, and the paths it
// generates go into the exclusion list so a checkpoint never captures them
// (ADR-0008, ADR-0017 D6).
//
// Two probe findings shape this file, and both argue against the obvious
// implementation:
//
//   - A5: `apm install --frozen` does NOT freeze a local-path dependency. After
//     the upstream package was mutated, the frozen install exited 0, reported
//     "Lockfile presence verified", moved the lock digest, replaced the deployed
//     tree, and put the mutated content live. --frozen verifies the lockfile is
//     present; nothing more.
//   - A5b: the digest moves exactly when package content moves, with and without
//     --frozen alike. So the control that works is comparing sha256(apm.lock.yaml)
//     against the profile's recorded apm_lock_digest before launching, which is
//     what Stage does — and which is why an unmatched digest is a refusal rather
//     than a warning (case 14).
package apm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Binary is the apm executable name; the worker image vendors 0.33.0 at a pinned
// digest (ADR-0008 D1), and the version string a Stage reports is whatever that
// binary answers, never what the Dockerfile intended.
const Binary = "apm"

// PinnedVersion is the apm release the staging behaviour in
// docs/compatibility/M3-PROBES.md § p6 was measured against. Unlike nono's pin
// this is not a hard gate in Stage: apm's absence already aborts, and the probe
// evidence for the digest control is behavioural rather than
// kernel-version-shaped. It is recorded so a mismatch is visible in the log.
const PinnedVersion = "0.33.0"

// Targets are the two APM install targets M3 knows about. A profile records one
// digest per target, because apm keeps a single apm.lock.yaml per checkout:
// probe A3 showed installing the second target into a checkout that already had
// the first *moves* the digest rather than writing a per-target lock, so one
// digest per profile is only meaningful when exactly one target is ever
// installed into a run checkout — which is the case here (a launcher is one
// harness), and is why Target is part of the identity of a StagedContext rather
// than a parameter of a digest.
const (
	TargetClaude = "claude"
	TargetCodex  = "codex"
)

// ValidTarget reports whether t is an apm target M3 will install for.
func ValidTarget(t string) bool { return t == TargetClaude || t == TargetCodex }

// ErrNothingStaged reports a profile with no package reference: the turn runs
// with no packaged context, which is a legitimate configuration (D-020: no
// default MCP/CLI privileges) and is recorded as such rather than faked.
var ErrNothingStaged = errors.New("apm: profile pins no package")

// StageRequest is one staging operation.
type StageRequest struct {
	// Checkout is the run checkout APM installs into — never a shared tree.
	Checkout string
	// Target is the launcher family the packages are staged for.
	Target string
	// PackageRef is agent_profiles.apm_package_ref. Empty means "no packaged
	// context for this profile" and Stage answers ErrNothingStaged.
	PackageRef string
	// LockDigest is agent_profiles.apm_lock_digest, "sha256:<hex>", recorded for
	// this target. It is the launch gate: a moved digest means the packaged
	// context a reviewer approved is not the one about to run.
	LockDigest string
	// Home is the per-attempt HOME (<agent_root>/home), never the worker's.
	// APM.md T4 / probe A2: apm writes .apm and .cache/apm into whatever HOME it
	// gets, which is why the directory exists and why it is deleted with the
	// unit.
	Home string
	// APMPath overrides the executable (tests, and the vendored path).
	APMPath string
	// Timeout bounds one apm invocation. A hung install would otherwise hold a
	// turn lease while doing nothing.
	Timeout time.Duration
}

// StagedContext is what staging produced: the paths to exclude from git and from
// every artifact filter, and the digest that gate passed.
type StagedContext struct {
	Target     string
	PackageRef string
	// LockDigest is the digest now on disk, in "sha256:<hex>" form.
	LockDigest string
	// GeneratedPaths are relative to the checkout: what APM created or rewrote.
	// The worker appends them to the project exclusion set (ADR-0017 D6).
	GeneratedPaths []string
	// ManifestGenerated reports that Stage wrote the checkout's apm.yml itself
	// from the profile's package ref (ADR-0030 Amendment 1) rather than using a
	// manifest the repository tracks. It is recorded so the exclusion pass, the
	// log, and the tests can tell the two staging paths apart.
	ManifestGenerated bool
	// HomePaths are the entries APM created inside the per-attempt HOME. They
	// are recorded for the cleanup assertion rather than for exclusion — the
	// whole HOME is deleted with the unit.
	HomePaths []string
	// Version is apm's reported version.
	Version string
	// Skipped records the reason nothing was staged when nothing was staged.
	Skipped string
}

// LockFileName is the lockfile apm maintains in the checkout.
const LockFileName = "apm.lock.yaml"

// generatedCandidates are the paths APM is observed to write in a checkout
// (probe A1: .claude/, apm_modules/, apm.lock.yaml, .gitignore; A3 shows
// .agents/ for the codex target). Anything that appears and is not on this list
// is reported, because an unaccounted-for generated path is a path that could
// end up in a checkpoint.
var generatedCandidates = []string{
	".claude", ".agents", ".codex", "apm_modules", LockFileName, ".gitignore", "AGENTS.md", "CLAUDE.md",
}

// Stage installs the profile's packages into the checkout and gates the result
// on the recorded digest.
//
// Two checkout shapes, per ADR-0030 Amendment 1 and APM.md F1/F2:
//
//   - The checkout carries its own apm.yml: `apm install --frozen --target <t>`,
//     exactly as before — the repository owns its manifest and its lock.
//   - The checkout carries no apm.yml but the profile pins a package ref: the
//     manifest is materialized from the ref and installed *without* --frozen,
//     because --frozen refuses to bootstrap a lockfile that does not exist yet
//     (F2), and the resolving install is what writes one. The pin stays
//     authoritative because the digest gate below runs either way: the lock
//     records `resolved_commit` (T-tag-2/3/4), so a moved tag moves the digest
//     and the launch is refused with the same DigestMismatch.
//
// The order is deliberate: install first (which is what materializes a lockfile
// for a fresh checkout), then compare, then refuse. There is no arrangement of
// these steps that both proves the tree is the approved one and installs it,
// because A5 showed the install itself can move the digest — so the comparison
// is a *gate on what is now on disk*, not a verification of the install, and the
// honest consequence is recorded in Deviations: a profile that pins a digest
// cannot survive an approved upstream change without an operator re-recording
// it, which is the point.
func Stage(ctx context.Context, req StageRequest) (*StagedContext, error) {
	if req.Checkout == "" || req.Home == "" {
		return nil, errors.New("apm: staging needs a checkout and a per-attempt HOME")
	}
	if !ValidTarget(req.Target) {
		return nil, fmt.Errorf("apm: target %q is not one of %s/%s", req.Target, TargetClaude, TargetCodex)
	}
	if req.PackageRef == "" {
		return &StagedContext{Target: req.Target, Skipped: "no_package_ref"}, ErrNothingStaged
	}
	for _, path := range []string{req.Checkout, req.Home} {
		if !filepath.IsAbs(path) || strings.Contains(path, "..") {
			return nil, fmt.Errorf("apm: %q is not an absolute traversal-free path", path)
		}
	}
	if st, err := os.Stat(req.Home); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("apm: per-attempt HOME %s is not a directory (it is the workspace's home/, created by prepare): %v", req.Home, err)
	}
	if req.LockDigest != "" && !validDigest(req.LockDigest) {
		return nil, fmt.Errorf("apm: recorded lock digest %q is not sha256:<64 hex>", req.LockDigest)
	}

	bin := req.APMPath
	if bin == "" {
		bin = Binary
	}
	homeBefore, err := listDir(req.Home)
	if err != nil {
		return nil, err
	}

	// F1: nothing else in the system turns apm_package_ref into a manifest, so a
	// checkout that tracks no apm.yml is materialized here rather than failing
	// the turn with apm's "No apm.yml found".
	materialized, err := writeManifest(req.Checkout, req.PackageRef)
	if err != nil {
		return nil, err
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := []string{"install", "--frozen", "--target", req.Target}
	if materialized {
		args = []string{"install", "--target", req.Target}
	}

	// The env is built from scratch: APM must not see the worker's environment
	// either, and its HOME is the only HOME in play (probe A1/A2).
	cmd := exec.CommandContext(cctx, bin, args...) //nolint:gosec // argv only
	cmd.Dir = req.Checkout
	cmd.Env = apmChildEnv(req.Home)
	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		return nil, fmt.Errorf("apm %s in %s: %w (%s)",
			strings.Join(args, " "), req.Checkout, runErr, bounded(string(out), 400))
	}

	if materialized {
		// Everything this staging created is the worker's, not the repository's.
		// Name it in git's project exclusion file *before* the digest gate, so
		// even a refused launch leaves no diff behind (APM.md C14b: the staged
		// trees must stay out of the project's tracked surface).
		if err := excludeGenerated(req.Checkout, materializedExclusions(req.Target)); err != nil {
			return nil, err
		}
	}

	lockPath := filepath.Join(req.Checkout, LockFileName)
	onDisk, err := LockDigest(lockPath)
	if err != nil {
		// A successful install that leaves no lockfile is not a frozen install:
		// it is the case-14 failure, and refusing is better than launching a
		// turn whose packaged context nobody recorded.
		return nil, fmt.Errorf("apm: install reported success but the lockfile is unusable: %w", err)
	}
	if req.LockDigest != "" && onDisk != req.LockDigest {
		return nil, &DigestMismatch{Recorded: req.LockDigest, OnDisk: onDisk, Target: req.Target, Checkout: req.Checkout, Output: bounded(string(out), 400)}
	}

	homeAfter, err := listDir(req.Home)
	if err != nil {
		return nil, err
	}
	staged := &StagedContext{
		Target:         req.Target,
		PackageRef:     req.PackageRef,
		LockDigest:     onDisk,
		GeneratedPaths: presentGenerated(req.Checkout),
		HomePaths:      diffNames(homeBefore, homeAfter),
		Version:        firstToken(string(out)),
	}
	if materialized {
		staged.ManifestGenerated = true
		staged.GeneratedPaths = append(staged.GeneratedPaths, ManifestFileName)
	}
	// An unaccounted generated path is not fatal, but it must not be invisible:
	// it would ride into a checkpoint. Report it in the same structure the
	// caller already reads.
	if unexplained := unexplainedGenerated(req.Checkout, staged.GeneratedPaths); len(unexplained) > 0 {
		staged.GeneratedPaths = append(staged.GeneratedPaths, unexplained...)
	}
	return staged, nil
}

// DigestMismatch is the launch gate refusing. It is a type rather than a string
// because the caller must be able to tell "the packaged context changed" from
// "apm is broken", and because the event it produces (case 14) names the
// profile revision rather than the filesystem.
type DigestMismatch struct {
	Recorded string
	OnDisk   string
	Target   string
	Checkout string
	Output   string
}

func (e *DigestMismatch) Error() string {
	return fmt.Sprintf("apm: %s lock digest on disk (%s) is not the one the profile pinned (%s) — refusing to launch: --frozen does not freeze content, it verifies the lockfile is present (probe A5), so a moved digest means the packaged context a reviewer approved is not the one about to run", e.Target, e.OnDisk, e.Recorded)
}

// LockDigest is sha256 of the lockfile bytes, in the "sha256:<hex>" form the
// database column CHECKs.
func LockDigest(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", fmt.Errorf("apm: %s is empty", path)
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func presentGenerated(checkout string) []string {
	var out []string
	for _, rel := range generatedCandidates {
		if _, err := os.Lstat(filepath.Join(checkout, rel)); err == nil {
			out = append(out, rel)
		}
	}
	return out
}

// unexplainedGenerated lists paths that exist in the checkout and are not
// git-tracked and not already accounted for. It is a shallow sweep (one level,
// no recursion into the repo's own tree) on purpose: the goal is to notice a new
// top-level artifact APM started writing, not to re-implement git status.
func unexplainedGenerated(checkout string, known []string) []string {
	knownSet := map[string]bool{".git": true}
	for _, k := range known {
		knownSet[k] = true
	}
	entries, err := os.ReadDir(checkout)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if knownSet[name] || strings.HasPrefix(name, ".git") {
			continue
		}
		// Anything apm wrote has an mtime after the checkout was prepared; a
		// repository's own files do not. Rather than guess, only report entries
		// that are directories named like a tool cache or a lockfile-shaped file.
		if e.IsDir() && (strings.HasSuffix(name, "_modules") || strings.HasPrefix(name, ".")) ||
			(!e.IsDir() && strings.HasPrefix(name, "apm.")) {
			out = append(out, name)
		}
	}
	return out
}

func listDir(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("apm: read %s: %w", dir, err)
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out, nil
}

func diffNames(before, after []string) []string {
	have := map[string]bool{}
	for _, b := range before {
		have[b] = true
	}
	var out []string
	for _, a := range after {
		if !have[a] {
			out = append(out, a)
		}
	}
	return out
}

func validDigest(d string) bool {
	if !strings.HasPrefix(d, "sha256:") || len(d) != len("sha256:")+64 {
		return false
	}
	for _, r := range d[len("sha256:"):] {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		default:
			return false
		}
	}
	return true
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// apmChildEnv builds the child environment apm runs under: a scratch HOME, no
// worker environment in play, no git attribution.
func apmChildEnv(home string) []string {
	return []string{
		"PATH=" + envOr("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		// No GIT_AUTHOR_*: apm does not commit, and a package that shells out to
		// git must fail loudly rather than attribute to a human.
		"GIT_TERMINAL_PROMPT=0",
		"TERM=xterm-256color",
	}
}

func bounded(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func firstToken(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	return strings.Fields(s)[0]
}
