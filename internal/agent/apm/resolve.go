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

// ResolveRequest is one resolve operation: lock a package set for a target,
// no deploy.
type ResolveRequest struct {
	// Deps is the profile's flattened dependency list (ADR-0084). It is what
	// the manifest is rendered from, so the digest this resolve reports covers
	// the whole set — the same list Stage installs, or the gate is a lie.
	// Deps and PackageRef are the two shapes of one pin: PackageRef is the
	// single-ref constructor (the ADR-0030 form) and is exactly
	// Deps: SingleRefDep(ref); when both are set, Deps wins.
	Deps []Dep
	// PackageRef is the one-ref form of Deps, kept as the constructor input it
	// always was.
	PackageRef string
	// Target is the launcher family the package is resolved for
	// (apm.ValidTarget).
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
	// Wrap optionally supplies the launcher wrapper for this resolve. The
	// worker answers with a wrapper that builds a nono-sandboxed launch (ADR-0054
	// §B.2: an untrusted package ref is fetched by the pinned apm CLI in a
	// sandboxed child, never as a plain worker child), so the resolve never execs
	// the binary directly when a sandboxed child is required. The wrapper is
	// invoked with the resolving install's argv and the apm child environment and
	// returns the exec'd (path, args, env): the worker answers with the launch
	// it verified. Nil runs the binary directly (tests, unsandboxed modes), and
	// then the result reports Sandboxed=false.
	Wrap func(argv []string, env []string) (execPath string, execArgs []string, execEnv []string, err error)
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
	// SkillRefs is the per-skill attribution ADR-0084 added: which dependency
	// of the flattened set each skill name came from. Two dependencies can ship
	// one skill name and APM settles that by install order, not by an error, so
	// the attribution is what the UI shows as "overridden by …" — what APM
	// decided, reported rather than reinterpreted. Sorted by skill name.
	SkillRefs []SkillRef
	// Truncated reports that a list hit contentsCap and was cut short.
	Truncated bool
}

// SkillRef is one skill name with the coordinate that deployed it.
type SkillRef struct {
	// Skill is the skill directory name.
	Skill string `json:"skill"`
	// FromRef is the dependency that owns the deployed copy, in the profile's
	// own ref grammar (`owner/repo[/subdir]#<tag|sha>`). "" means the lock
	// named no owning dependency for it — honest, not a guess.
	FromRef string `json:"from_ref"`
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
	// Sandboxed reports whether this resolve ran through the caller's launcher
	// wrapper (a nono-sandboxed child, ADR-0054 §B.2) or directly. The worker
	// supplies the wrapper only under its `required` enforcement mode and the
	// result records the answer honestly — never a green claim about a run that
	// did not happen.
	Sandboxed bool
}

// Resolve locks a package ref and reports the lock digest plus contents. It
// installs into WorkDir (materializing the ref's apm.yml when the scratch dir
// does not carry one), runs the resolving install, reads the lock apm wrote,
// and stops — no deploy, no digest gate, no exclusion bookkeeping.
func Resolve(ctx context.Context, req ResolveRequest) (*ResolveResult, error) {
	if !ValidTarget(req.Target) {
		return nil, fmt.Errorf("apm: resolve target %q is not one of %s", req.Target, targetList())
	}
	deps, err := requestDeps(req.Deps, req.PackageRef)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w: %w", depName(req), ErrResolveInvalidRef, err)
	}
	if len(deps) == 0 {
		return nil, fmt.Errorf("apm: resolve %s: %w: the request names no package", depName(req), ErrResolveInvalidRef)
	}
	parsed := make([]packageRef, 0, len(deps))
	for _, d := range deps {
		p, err := parsePackageRef(d.Ref)
		if err != nil {
			return nil, fmt.Errorf("apm: resolve %s: %w: %w", depName(req), ErrResolveInvalidRef, err)
		}
		parsed = append(parsed, p)
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
	// the minimal manifest for the flattened dependency list, so the install
	// below can resolve it.
	materialized, err := writeManifest(req.WorkDir, deps)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), err)
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
	var execPath string
	var execArgs []string
	var childEnv []string
	if req.Wrap != nil {
		var wrapErr error
		execPath, execArgs, childEnv, wrapErr = req.Wrap(args, apmChildEnv(req.Home))
		if wrapErr != nil {
			return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), wrapErr)
		}
	} else {
		execPath, execArgs, childEnv = bin, args, apmChildEnv(req.Home)
	}
	cmd := exec.CommandContext(cctx, execPath, execArgs...) //nolint:gosec // argv only
	cmd.Dir = req.WorkDir
	cmd.Env = childEnv
	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) || cctx.Err() != nil {
			return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), ErrResolveTimeout)
		}
		return nil, fmt.Errorf("apm: resolve %s: %w: %s", depName(req), ErrResolveFailed, bounded(string(out), 2000))
	}

	lockPath := filepath.Join(req.WorkDir, LockFileName)
	lockDigest, err := LockDigest(lockPath)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: install reported success but the lockfile is unusable: %w", depName(req), err)
	}
	lock, err := parseLockFile(lockPath)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), err)
	}
	if err := assertLockPinsDeps(lock, parsed); err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), err)
	}
	contents, err := collectContents(req.WorkDir, lock)
	if err != nil {
		return nil, fmt.Errorf("apm: resolve %s: %w", depName(req), err)
	}

	return &ResolveResult{
		LockDigest:  lockDigest,
		ResolvedRef: resolvedRef(lock),
		Commit:      resolvedCommit(lock),
		APMVersion:  lock.APMVersion,
		Contents:    contents,
		Sandboxed:   req.Wrap != nil,
	}, nil
}

// depName is the resolve's identity in a message: the flattened list when
// there is one, else the single ref the caller named.
func depName(req ResolveRequest) string {
	if len(req.Deps) > 0 {
		return bounded(strings.Join(RefsOf(req.Deps), ", "), 400)
	}
	return req.PackageRef
}

// assertLockPinsDeps refuses a resolve whose lock did not pin the refs it was
// asked to lock. A resolving install that answered a different revision (or
// none) means the lock digest about to be reported describes a context the
// caller never asked to lock; fail with the named resolve error instead of
// answering. With a list (ADR-0084) EVERY requested revision must appear among
// the lock's resolved pins — a dependency that silently dropped out of the
// graph would otherwise be recorded as locked.
func assertLockPinsDeps(lock *lockfile, want []packageRef) error {
	for _, w := range want {
		if w.Revision == "" {
			continue
		}
		found := false
		for i := range lock.Dependencies {
			d := &lock.Dependencies[i]
			if d.ResolvedRef == w.Revision || d.ResolvedCommit == w.Revision {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("apm: lock does not pin the requested ref %s (resolved %s/%s): %w",
				w.Revision, resolvedRef(lock), resolvedCommit(lock), ErrResolveFailed)
		}
	}
	return nil
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
	VirtualPath        string            `yaml:"virtual_path"`
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

// identity is the dependency's coordinate in the profile's own ref grammar —
// the `from_ref` a lock summary attributes a skill to. A lock records repo_url,
// virtual_path and resolved_ref separately; joining them back into the shape
// the user typed is what makes the attribution readable.
func (d *lockDependency) identity() string {
	coord := strings.TrimSuffix(d.RepoURL, "/")
	if vp := strings.Trim(d.VirtualPath, "/"); vp != "" {
		coord += "/" + vp
	}
	switch rev := d.ResolvedRef; {
	case rev != "":
		return coord + "#" + rev
	case d.ResolvedCommit != "":
		return coord + "#" + d.ResolvedCommit
	default:
		return coord
	}
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
//
// The per-skill `from_ref` (ADR-0084) comes from the lock, not the tree: each
// dependency lists the files it deployed, so a skill's owning dependency is the
// LAST dependency in lock order that names that skill's SKILL.md. Lock order is
// install order, and install order is what APM's `active_owner` settles on, so
// this reports the winner rather than every claimant — which is the difference
// between surfacing APM's rule and silently inventing our own.
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
	owners := skillOwners(lock)
	refs := make([]SkillRef, 0, len(skills))
	for name := range skills {
		refs = append(refs, SkillRef{Skill: name, FromRef: owners[name]})
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].Skill < refs[j].Skill })

	skillsOut, skillsTrunc := sortedNames(skills, contentsCap)
	instructionsOut, instructionsTrunc := sortedNames(instructions, contentsCap)
	mcpOut, mcpTrunc := sortedNames(mcp, contentsCap)
	if len(refs) > contentsCap {
		refs = refs[:contentsCap]
	}
	return Contents{
		Skills:       skillsOut,
		Instructions: instructionsOut,
		MCPServers:   mcpOut,
		SkillRefs:    refs,
		Truncated:    skillsTrunc || instructionsTrunc || mcpTrunc,
	}, nil
}

// skillOwners maps each deployed skill name to the dependency that owns its
// deployed copy, by walking the lock's dependencies in order (last claimant
// wins; see collectContents). A dependency that recorded no deployed_files
// contributes nothing here — its skill_subsets are names without locators, and
// guessing which of them landed would be a claim, not an observation.
func skillOwners(lock *lockfile) map[string]string {
	owners := map[string]string{}
	for i := range lock.Dependencies {
		d := &lock.Dependencies[i]
		for _, f := range d.DeployedFiles {
			if name, ok := skillNameOfPath(f); ok {
				owners[name] = d.identity()
			}
		}
	}
	return owners
}

// skillNameOfPath is the skill directory a deployed SKILL.md path names:
// `.claude/skills/grill-me/SKILL.md` (or the apm_modules/ twin) → "grill-me".
func skillNameOfPath(p string) (string, bool) {
	segs := strings.Split(strings.ReplaceAll(p, string(filepath.Separator), "/"), "/")
	for i := 1; i < len(segs); i++ {
		if segs[i-1] == "skills" && segs[i] != "" {
			if segs[len(segs)-1] == "SKILL.md" {
				return segs[i], true
			}
			return "", false
		}
	}
	return "", false
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
