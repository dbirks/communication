package git

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Layout names the two trees of one workspace (ADR-0017 D1 as corrected by
// probe C-META, contract deviation D13):
//
//	<root>/                       worker-only, NEVER in a grant
//	  meta/                       workspace.json, staging ledgers
//	<root>/work/                  the ONE recursive grant ("agent_root")
//	  repos/<name>/               linked worktree, branch <scope-id>/<name>
//	  scratch/                    generated output, never tracked
//	  home/                       the agent's HOME, 0700 (probes P6 / C-H1c)
//
// `nono --allow <dir>` is recursive, so a grant on the *root* would hand the
// agent meta/ — which is exactly what C-META observed (the sandboxed child read
// meta/workspace.json and wrote meta/agent-written under that shape). meta/ is
// therefore a sibling of the granted tree, and workspaces.agent_root is a
// GENERATED database column so no writer can record any other shape.
type Layout struct {
	// ScopeKind is "conversation" or "run"; ScopeID the canonical uuid.
	ScopeKind string
	ScopeID   string
	// Root is <workspace root>/<scope-kind>/<scope-id>.
	Root string
	// Meta is Root/meta — worker-only.
	Meta string
	// Work is Root/work — the only directory ever granted recursively, and
	// the value workspaces.agent_root derives to.
	Work string
	// Repos, Scratch and Home are its three children.
	Repos   string
	Scratch string
	Home    string
}

// LayoutOf names the tree for one scope without creating anything.
func LayoutOf(workspaceRoot, scopeKind, scopeID string) (Layout, error) {
	if scopeKind != "conversation" && scopeKind != "run" {
		return Layout{}, fmt.Errorf("workspace: scope kind %q is not conversation or run", scopeKind)
	}
	if err := CheckScopeID(scopeID); err != nil {
		return Layout{}, err
	}
	if err := checkAbsoluteNoDotDot(workspaceRoot); err != nil {
		return Layout{}, fmt.Errorf("workspace: root: %w", err)
	}
	if err := RefuseTempPath(workspaceRoot); err != nil {
		return Layout{}, err
	}
	root := filepath.Join(workspaceRoot, scopeKind, scopeID)
	return Layout{
		ScopeKind: scopeKind,
		ScopeID:   scopeID,
		Root:      root,
		Meta:      filepath.Join(root, "meta"),
		Work:      filepath.Join(root, "work"),
		Repos:     filepath.Join(root, "work", "repos"),
		Scratch:   filepath.Join(root, "work", "scratch"),
		Home:      filepath.Join(root, "work", "home"),
	}, nil
}

// AssertNothingBut is the check the corrected grant shape requires: the grant
// is `Work` (which covers repos/, scratch/ and home/), so anything else that
// ever appeared in that directory would be granted too. C-GRANT2 is the
// measurement that omission alone keeps meta/ out; this is the guard that
// keeps it true as the layout grows.
func (l Layout) AssertNothingBut() error {
	entries, err := os.ReadDir(l.Work)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("workspace: inspect %s: %w", l.Work, err)
	}
	for _, e := range entries {
		switch e.Name() {
		case "repos", "scratch", "home":
		default:
			return fmt.Errorf("workspace: %s contains %q, which is not one of the three children the grant shape accounts for (repos, scratch, home)", l.Work, e.Name())
		}
	}
	return nil
}

// Ensure creates the layout: meta/ (0755, worker-owned), work/ and its three
// children, and home/ at 0700 seeded with a git identity.
//
// home/ is not tidiness. Probe P6: with HOME outside the grants, git aborts on
// `~/.gitconfig` with `fatal: unknown error occurred while reading the
// configuration files` even when `-c user.name/-c user.email` are passed — so
// an agent that runs any git command needs a HOME *inside* its own grants.
// APM (ADR-0008 T4) is the second reason: it writes ~/.apm and ~/.cache/apm
// into whatever HOME it is given.
func (l Layout) Ensure(gitConfig string) error {
	for _, dir := range []string{l.Meta, l.Work, l.Repos, l.Scratch} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("workspace: create %s: %w", dir, err)
		}
	}
	if err := os.MkdirAll(l.Home, 0o700); err != nil {
		return fmt.Errorf("workspace: create %s: %w", l.Home, err)
	}
	if err := os.Chmod(l.Home, 0o700); err != nil {
		return fmt.Errorf("workspace: chmod %s: %w", l.Home, err)
	}
	cfg := filepath.Join(l.Home, ".gitconfig")
	if _, err := os.Stat(cfg); os.IsNotExist(err) {
		if gitConfig == "" {
			gitConfig = "[user]\n\tname = communication-agent\n\temail = agent@communication.invalid\n"
		}
		if err := os.WriteFile(cfg, []byte(gitConfig), 0o600); err != nil {
			return fmt.Errorf("workspace: seed %s: %w", cfg, err)
		}
	} else if err != nil {
		return fmt.Errorf("workspace: stat %s: %w", cfg, err)
	}
	return nil
}

// Mirror is one project's mirror: <repos root>/<project id>/<name>.git.
//
// It is per PROJECT and never shared across projects (ADR-0010 D3): the
// mirror's object pool is shared mutable state, so a shared mirror would make
// one project's object writes visible inside another project's repository.
type Mirror struct {
	// ProjectID is the uuid the directory is named by — the isolation key.
	ProjectID string
	// Name is the repository name (a safe directory component).
	Name string
	// Path is the absolute mirror directory.
	Path string
	// VolumeID is the identity of the storage root the mirror lives on
	// (root_kind = repos). Recorded per workspace_repos.mirror_volume_id
	// because probe V5b measured the mirror tree and the workspace tree to
	// share a device and differ in inode.
	VolumeID string
}

// MirrorFor names a project mirror. Nothing is created.
func MirrorFor(reposRoot, projectID, name string) (Mirror, error) {
	if err := CheckScopeID(projectID); err != nil {
		return Mirror{}, fmt.Errorf("workspace: mirror: %w", err)
	}
	if err := CheckName(name); err != nil {
		return Mirror{}, err
	}
	if err := checkAbsoluteNoDotDot(reposRoot); err != nil {
		return Mirror{}, fmt.Errorf("workspace: repos root: %w", err)
	}
	if err := RefuseTempPath(reposRoot); err != nil {
		return Mirror{}, err
	}
	return Mirror{
		ProjectID: projectID,
		Name:      name,
		Path:      filepath.Join(reposRoot, projectID, name+".git"),
	}, nil
}

// InfoExclude returns the mirror's shared exclude file — the ONLY place a
// linked-worktree layout honors an exclusion (probes X1/X2/X3: a per-worktree
// $(git-dir)/info/exclude is ignored, and the documented per-worktree route
// extensions.worktreeConfig broke every git command in the layout).
//
// Its scope is the project, so an exclusion the worker writes here applies to
// every run of that project (contract deviation D3) and the agent can never
// edit it, because the mirror is granted read-only (probe X4).
func (m Mirror) InfoExclude() string { return filepath.Join(m.Path, "info", "exclude") }

// LogsRefDir is the reflog directory git needs before it will write a ref in
// a confined commit (probe P7: without it, `unable to create directory for
// …/logs/refs/heads/<scope>/<name>: No such file or directory`).
func (m Mirror) LogsRefDir(scopeID string) string {
	return filepath.Join(m.Path, "logs", "refs", "heads", scopeID)
}

// RefsDir is the per-scope ref namespace a commit grant names.
func (m Mirror) RefsDir(scopeID string) string {
	return filepath.Join(m.Path, "refs", "heads", scopeID)
}

// mirrorLocks serializes `git worktree add` per mirror. Probe G10 measured
// that six parallel `git worktree add -b` against one mirror on git 2.39.5
// (the worker image's git) succeeded only 1–3 times out of 6, failing with
// `could not lock config file <mirror>/config: File exists`; G10b showed
// serializing the adds is sufficient on both git versions. A per-mirror mutex
// is that serialization — a lockfile would only add a stale-lock failure mode
// for the same guarantee within one worker process.
type mirrorLocks struct {
	mu    sync.Mutex
	byKey map[string]*sync.Mutex
}

func newMirrorLocks() *mirrorLocks {
	return &mirrorLocks{byKey: map[string]*sync.Mutex{}}
}

// withMirror runs fn while holding the mirror's lock.
func (l *mirrorLocks) withMirror(path string, fn func() error) error {
	l.mu.Lock()
	lock, ok := l.byKey[path]
	if !ok {
		lock = &sync.Mutex{}
		l.byKey[path] = lock
	}
	l.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	return fn()
}

// ExclusionDigest is the manifest digest recorded per workspace repo: the
// sorted exclusion set hashed, so two workspaces of one project can be shown
// to have been prepared under the same policy without storing paths.
func ExclusionDigest(paths []string) string {
	sorted := append([]string(nil), paths...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}
