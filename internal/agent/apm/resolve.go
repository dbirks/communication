package apm

// Worker-side APM resolve: turn a package ref into a lock digest plus a
// contents summary, without deploying anything.
//
// Stage answers "is the packaged context a reviewer approved?" by installing
// the pinned ref into a run checkout and comparing sha256(apm.lock.yaml) with
// the recorded digest (ADR-0030 / ADR-0054). Resolve answers "lock this ref
// now" — the same install sequence minus the gate — so the control plane can
// record a lock digest and a contents summary for a profile before any launch
// exists (ADR-0054 Option B, part 1 of the lock-it implementation).
//
// The resolve runs in a caller-owned scratch dir (never a repo checkout, never
// a shared tree): it materializes the profile's apm.yml from the ref, runs the
// resolving install, reads the lock apm wrote, and stops there. Nothing is
// deployed into a run checkout, nothing is excluded, nothing is cleaned up by
// the caller — the caller owns the scratch dir.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Errors a resolve answers with. They are the named failure kinds a caller
// (the worker seam, the later lock dispatch unit) branches on: an un-pinnable
// coordinate, an install the pinned CLI refused, a timeout.
var (
	// ErrResolveInvalidRef reports a package ref that failed the ADR-0030 §3
	// pin grammar. It wraps the parse error so the refusal still names the
	// exact coordinate problem.
	ErrResolveInvalidRef = errors.New("apm: resolve: invalid package ref")
	// ErrResolveFailed reports a resolving install that exited non-zero; the
	// message carries the pinned CLI's stderr tail (bounded, no raw dump).
	ErrResolveFailed = errors.New("apm: resolve failed")
	// ErrResolveTimeout reports the resolve's install was cancelled by the
	// deadline. It wraps context.DeadlineExceeded's kind for errors.Is callers.
	ErrResolveTimeout = errors.New("apm: resolve timed out")
	// ErrResolveWorkDirNotEmpty reports a resolve scratch dir that already holds
	// content. A resolve owns its scratch dir and installs into it; a dir that
	// already carries a previous resolve's lock must be refused, not answered
	// with the stale lock.
	ErrResolveWorkDirNotEmpty = errors.New("apm: resolve work dir is not empty")
)

// contentsCap bounds how many names a resolve summary lists per category. A
// lock summary carries names only; a package with more than this is reported
// with Truncated rather than silently dropped.
const contentsCap = 200

// ResolveRequest is one resolve operation: lock a package ref for a target,
// no deploy.
type ResolveRequest struct {
	// PackageRef is agent_profiles.apm_package_ref. It carries the pin the
	// resolve is asked to lock, in the ADR-0030 §3 grammar
	// (<owner>/<repo>[/<subdir>][#<tag|branch|commit>]).
	PackageRef string
	// Target is the launcher family the package is resolved for
	// (apm.ValidTarget: claude or codex).
	Target string
	// WorkDir is the empty scratch dir the resolve installs into — owned by
	// the caller, never a repo checkout. It must be empty (a missing dir may be
	// created); a resolve refuses a dir that already holds content so a lock
	// from an earlier resolve can never be answered for a different ref.
	WorkDir string
	// Home is the HOME the apm child runs under.
	Home string
	// APMPath overrides the executable (tests, and the vendored path).
	APMPath string
	// Timeout bounds one apm invocation. A hung resolve would otherwise hold
	// a lease doing nothing.
	Timeout time.Duration
}

// Contents is the lock summary a resolve reports: the package's names, by
// category, sorted, capped. It is a summary, not a payload — no lock file body,
// no file paths beyond the names, no prompts or values.
type Contents struct {
	// Skills are the skill names the resolved package deploys (the SKILL.md
	// directories), sorted.
	Skills []string
	// Instructions are the instruction file names the resolved package
	// stages (*.instructions.md, plus the AGENTS/CLAUDE-style instruction
	// files), sorted.
	Instructions []string
	// MCPServers are the MCP server names the resolved package wires up,
	// sorted.
	MCPServers []string
	// Truncated reports that a list hit contentsCap and was cut short.
	Truncated bool
}

// ResolveResult is what a successful resolve produced: the lock digest it
// computed, the pin it resolved to, and the contents summary.
type ResolveResult struct {
	// LockDigest is sha256 of the lockfile bytes apm wrote, in the
	// "sha256:<hex>" form the database column CHECKs — exactly the digest
	// Stage's gate compares against.
	LockDigest string
	// ResolvedRef is the tag/branch the lock resolved (the dependency's
	// resolved_ref).
	ResolvedRef string
	// Commit is the commit the lock resolved to (the dependency's
	// resolved_commit).
	Commit string
	// APMVersion is the apm version that wrote the lock.
	APMVersion string
	// Contents is the names-only summary of the resolved package.
	Contents Contents
}

// Resolve locks a package ref and reports the lock digest plus contents. It
// installs into WorkDir (materializing the ref's apm.yml when the scratch dir
// does not carry one), runs the resolving install, reads the lock apm wrote,
// and stops — no deploy, no digest gate, no exclusion bookkeeping.
func Resolve(ctx context.Context, req ResolveRequest) (*ResolveResult, error) {
	if !ValidTarget(req.Target) {
		return nil, fmt.Errorf("apm: resolve target %q is not one of %s/%s", req.Target, TargetClaude, TargetCodex)
	}
	parsed, err := parsePackageRef(req.PackageRef)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w: %w", req.PackageRef, ErrResolveInvalidRef, err)
	}
	if req.WorkDir == "" || !filepath.IsAbs(req.WorkDir) || strings.Contains(req.WorkDir, "..") {
		return nil, fmt.Errorf("apm: resolve work dir %q is not an absolute traversal-free path", req.WorkDir)
	}
	st, statErr := os.Stat(req.WorkDir)
	switch {
	case statErr == nil:
		if !st.IsDir() {
			return nil, fmt.Errorf("apm: resolve work dir %s is not a directory", req.WorkDir)
		}
		entries, readErr := os.ReadDir(req.WorkDir)
		if readErr != nil {
			return nil, fmt.Errorf("apm: resolve work dir %s: %v", req.WorkDir, readErr)
		}
		if len(entries) > 0 {
			return nil, fmt.Errorf("apm: resolve work dir %s is not empty: %w", req.WorkDir, ErrResolveWorkDirNotEmpty)
		}
	case errors.Is(statErr, os.ErrNotExist):
		if mkErr := os.MkdirAll(req.WorkDir, 0o755); mkErr != nil {
			return nil, fmt.Errorf("apm: resolve work dir %s: %v", req.WorkDir, mkErr)
		}
	default:
		return nil, fmt.Errorf("apm: resolve work dir %s: %v", req.WorkDir, statErr)
	}
	if req.Home == "" || !filepath.IsAbs(req.Home) || strings.Contains(req.Home, "..") {
		return nil, fmt.Errorf("apm: resolve home %q is not an absolute traversal-free path", req.Home)
	}
	if st, err := os.Stat(req.Home); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("apm: resolve home %s is not a directory (it is the scratch home the apm child runs under): %v", req.Home, err)
	}

	// The shared materialization: a scratch dir that carries no apm.yml gets
	// the minimal manifest for the ref, so the install below can resolve.
	materialized, err := writeManifest(req.WorkDir, req.PackageRef)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", req.PackageRef, err)
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := []string{"install", "--target", req.Target}
	if !materialized {
		args = []string{"install", "--frozen", "--target", req.Target}
	}

	// The env is built from scratch exactly as Stage builds it: the apm child
	// sees no worker environment and its HOME is the only HOME in play.
	bin := req.APMPath
	if bin == "" {
		bin = Binary
	}
	cmd := exec.CommandContext(cctx, bin, args...) //nolint:gosec // argv only
	cmd.Dir = req.WorkDir
	cmd.Env = apmChildEnv(req.Home)
	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) || cctx.Err() != nil {
			return nil, fmt.Errorf("apm: resolve %s: %w", req.PackageRef, ErrResolveTimeout)
		}
		return nil, fmt.Errorf("apm: resolve %s: %w: %s", req.PackageRef, ErrResolveFailed, bounded(string(out), 2000))
	}

	lockPath := filepath.Join(req.WorkDir, LockFileName)
	lockDigest, err := LockDigest(lockPath)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: install reported success but the lockfile is unusable: %w", req.PackageRef, err)
	}
	lock, err := parseLockFile(lockPath)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", req.PackageRef, err)
	}
	if err := assertLockPinsRef(lock, parsed.Revision); err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", req.PackageRef, err)
	}
	contents, err := collectContents(req.WorkDir, lock)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", req.PackageRef, err)
	}

	return &ResolveResult{
		LockDigest:  lockDigest,
		ResolvedRef: resolvedRef(lock),
		Commit:      resolvedCommit(lock),
		APMVersion:  lock.APMVersion,
		Contents:    contents,
	}, nil
}

// assertLockPinsRef refuses a resolve whose lock did not pin the ref it was
// asked to lock. A resolving install that answered a different revision (or
// none) means the lock digest about to be reported describes a context the
// caller never asked to lock; fail with the named resolve error instead of
// answering.
func assertLockPinsRef(lock *lockfile, want string) error {
	got := resolvedRef(lock)
	if want == "" || got == want {
		return nil
	}
	return fmt.Errorf("apm: lock does not pin the requested ref %s (resolved %s): %w", want, got, ErrResolveFailed)
}

// resolvedRef is the tag/branch the lock resolved to, from its first
// dependency that recorded one.
func resolvedRef(lock *lockfile) string {
	for i := range lock.Dependencies {
		if lock.Dependencies[i].ResolvedRef != "" {
			return lock.Dependencies[i].ResolvedRef
		}
	}
	return ""
}

// resolvedCommit is the commit the lock resolved to, from its first
// dependency that recorded one.
func resolvedCommit(lock *lockfile) string {
	for i := range lock.Dependencies {
		if lock.Dependencies[i].ResolvedCommit != "" {
			return lock.Dependencies[i].ResolvedCommit
		}
	}
	return ""
}

// lockDependency is one entry of apm.lock.yaml's dependencies list — the
// subset the resolve reads: what the pin resolved to, what it content-hashed,
// and what it deployed.
type lockDependency struct {
	RepoURL            string            `yaml:"repo_url"`
	ResolvedCommit     string            `yaml:"resolved_commit"`
	ResolvedRef        string            `yaml:"resolved_ref"`
	Version            string            `yaml:"version"`
	Depth              int               `yaml:"depth"`
	PackageType        string            `yaml:"package_type"`
	ContentHash        string            `yaml:"content_hash"`
	SkillSubset        []string          `yaml:"skill_subset"`
	TargetSubset       []string          `yaml:"target_subset"`
	DeployedFiles      []string          `yaml:"deployed_files"`
	DeployedFileHashes map[string]string `yaml:"deployed_file_hashes"`
	Source             string            `yaml:"source"`
}

// lockfile is the subset of apm.lock.yaml the resolve reads (APM.md's
// lockfile shape, ADR-0054's field list). Fields the resolve does not need are
// left out: yaml's default decode ignores the rest.
type lockfile struct {
	LockfileVersion  string           `yaml:"lockfile_version"`
	APMVersion       string           `yaml:"apm_version"`
	Dependencies     []lockDependency `yaml:"dependencies"`
	MCPServers       []string         `yaml:"mcp_servers"`
	MCPConfigs       []string         `yaml:"mcp_configs"`
	MCPTargetServers []string         `yaml:"mcp_target_servers"`
	LSPServers       []string         `yaml:"lsp_servers"`
}

// parseLockFile reads and decodes the lockfile apm wrote into the resolve's
// scratch dir.
func parseLockFile(path string) (*lockfile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseLock(data)
}

// parseLock decodes an apm.lock.yaml document into the subset the resolve
// reads. Unknown keys (deployments and friends) are ignored.
func parseLock(data []byte) (*lockfile, error) {
	lock := &lockfile{}
	if err := yaml.Unmarshal(data, lock); err != nil {
		return nil, fmt.Errorf("apm: parse %s: %w", LockFileName, err)
	}
	return lock, nil
}

// collectContents derives the names-only summary from the deployed tree the
// install just wrote and the lock's MCP server names.
func collectContents(workdir string, lock *lockfile) (Contents, error) {
	skills := map[string]bool{}
	instructions := map[string]bool{}
	mcp := map[string]bool{}
	if err := filepath.WalkDir(workdir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if name == "SKILL.md" {
			parent := filepath.Dir(path)
			grandparent := filepath.Dir(parent)
			if filepath.Base(grandparent) == "skills" {
				skills[filepath.Base(parent)] = true
			}
			return nil
		}
		if strings.HasSuffix(name, ".instructions.md") || name == "AGENTS.md" || name == "CLAUDE.md" {
			instructions[name] = true
		}
		return nil
	}); err != nil {
		return Contents{}, err
	}
	for _, name := range lock.MCPServers {
		if name != "" {
			mcp[name] = true
		}
	}

	skillsOut, skillsTrunc := sortedNames(skills, contentsCap)
	instructionsOut, instructionsTrunc := sortedNames(instructions, contentsCap)
	mcpOut, mcpTrunc := sortedNames(mcp, contentsCap)
	return Contents{
		Skills:       skillsOut,
		Instructions: instructionsOut,
		MCPServers:   mcpOut,
		Truncated:    skillsTrunc || instructionsTrunc || mcpTrunc,
	}, nil
}

// sortedNames returns the set's keys sorted, capped at cap; the second return
// reports whether the list was longer than the cap and had to be cut.
func sortedNames(set map[string]bool, cap int) ([]string, bool) {
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	sort.Strings(names)
	truncated := len(names) > cap
	if truncated {
		names = names[:cap]
	}
	return names, truncated
}
