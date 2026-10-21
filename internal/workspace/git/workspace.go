package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Manager prepares mirrors, worktrees and exclusions for one worker process.
// It is safe for concurrent use: mirror mutations are serialized per mirror
// (probe G10), and the manager holds no per-workspace state — the persisted
// workspace_repos row is.
type Manager struct {
	// WorkspaceRoot is the `workspaces` storage root (already measured).
	WorkspaceRoot string
	// ReposRoot is the `repos` storage root — the mirror tree (V5b: measured
	// separately from the workspace tree even when they share a device).
	ReposRoot string
	// Git runs the git commands; nil uses a default Runner.
	Git *Runner
	// Locks serializes per-mirror mutations.
	locks *mirrorLocks
}

// NewManager validates the two roots and returns a Manager. Both roots must be
// absolute, `..`-free and outside the temp tree (ADR-0017 D5).
func NewManager(workspaceRoot, reposRoot string, runner *Runner) (*Manager, error) {
	for kind, root := range map[string]string{RootKindWorkspaces: workspaceRoot, RootKindRepos: reposRoot} {
		if err := checkAbsoluteNoDotDot(root); err != nil {
			return nil, fmt.Errorf("workspace: %s root: %w", kind, err)
		}
		if err := RefuseTempPath(root); err != nil {
			return nil, err
		}
	}
	if runner == nil {
		runner = &Runner{}
	}
	return &Manager{WorkspaceRoot: workspaceRoot, ReposRoot: reposRoot, Git: runner, locks: newMirrorLocks()}, nil
}

// NewReadManager returns a Manager for the operations that only ever read a
// checkout — HeadCommit and Status run `git -C <checkout>` and never touch the
// mirror root, which is exactly what a node-boundary capture reads after the
// fact (ADR-0017 D8: the proof is a ref read, never an exit status). The
// boundary capture in internal/worker needs that pair without being handed the
// mirror root, and a Manager whose ReposRoot is empty cannot serve any of the
// mirror-writing operations — Prepare, mirror fetches and Measure all fail on
// the empty root, so the narrowed capability is structural, not a convention.
func NewReadManager(workspaceRoot string) (*Manager, error) {
	if err := checkAbsoluteNoDotDot(workspaceRoot); err != nil {
		return nil, fmt.Errorf("workspace: %s root: %w", RootKindWorkspaces, err)
	}
	if err := RefuseTempPath(workspaceRoot); err != nil {
		return nil, err
	}
	return &Manager{WorkspaceRoot: workspaceRoot, ReposRoot: "", Git: &Runner{}, locks: newMirrorLocks()}, nil
}

// Measure returns the identity of both configured storage roots, keyed by root
// kind. Case 20's honest-loss arm depends on these two being distinct rows.
func (m *Manager) Measure() (map[string]Volume, error) {
	out := make(map[string]Volume, 2)
	for kind, root := range map[string]string{RootKindWorkspaces: m.WorkspaceRoot, RootKindRepos: m.ReposRoot} {
		v, err := MeasureVolume(kind, root)
		if err != nil {
			return nil, err
		}
		out[kind] = v
	}
	return out, nil
}

// RepoSpec is one repository of a project as the caller knows it.
type RepoSpec struct {
	// RepositoryID is the repositories.id — a uuid, used only for the
	// returned row (it never names a directory).
	RepositoryID string
	// Name is the directory component (safeName).
	Name string
	// GitURL is the upstream clone URL (may name a local path).
	GitURL string
	// DefaultBranch is the ref to base the run branch on; empty means the
	// mirror's HEAD.
	DefaultBranch string
	// BaseCommit (ADR-0053) is the pinned starting base for the scope branch:
	// a commit identity the run snapshotted at creation (runs.repo_snapshot)
	// — normally the thread branch's recorded head. Non-empty, the scope
	// branch is created from EXACTLY this commit and a mirror that does not
	// contain it refuses the prepare (infra, never a guess); empty keeps
	// today's default-branch startPoint. An already-existing run ref always
	// resumes from itself, pin or not (ADR-0017 D1).
	BaseCommit string
}

// PreparedRepo is the persisted half of one workspace repository: the four
// paths a policy is built from, plus the ref facts.
type PreparedRepo struct {
	RepositoryID  string
	Name          string
	CheckoutPath  string
	MirrorPath    string
	MirrorVolume  string
	AdminDir      string
	RunRef        string
	BaseCommit    string
	HeadCommit    string
	ExcludedPaths []string
	// MirrorCreated is true when this call built the mirror, false when it
	// fetched an existing one. Drives repository.mirror_updated's mirror_kind.
	MirrorCreated bool
	// FetchDurationMS is the observed fetch/add time, for the same event.
	FetchDurationMS int64
}

// PrepareRequest is one workspace's worth of work.
type PrepareRequest struct {
	// ScopeKind / ScopeID name the tree; ScopeID is a canonical uuid.
	ScopeKind string
	ScopeID   string
	// ProjectID scopes the mirrors (never shared across projects).
	ProjectID string
	// WorkspaceVolumeID / MirrorVolumeID are the worker's current measurements
	// for the two roots; a workspace may not bind to an unmeasured volume.
	WorkspaceVolumeID string
	MirrorVolumeID    string
	// Repos are the project's repositories, in a stable order.
	Repos []RepoSpec
	// ExcludedPaths are the relative paths (per repository) the worker declares
	// must stay out of git: APM-generated trees and materialized secret files.
	// They land in <mirror>/info/exclude (X2) and in workspace_repos.
	// excluded_paths, which the checkpoint and artifact paths filter again.
	ExcludedPaths []string
	// Mode is "worktree" (the default) or "clone" — ADR-0010 D5's escape
	// hatch for an untrusted co-tenant, which clones from the mirror instead
	// of linking to it.
	Mode string
}

// PreparedWorkspace is the outcome of Prepare: the layout plus every repo.
type PreparedWorkspace struct {
	Layout Layout
	Repos  []PreparedRepo
	// WorkspaceVolume is the identity this prepare *observed* for the workspaces
	// root. ADR-0017 D3 requires the claim's volume identity and the current
	// measurement to agree; the only way to know they agreed is to keep the
	// measurement that was compared, because a later re-measure can differ.
	WorkspaceVolume string
	// MirrorVolume is the same for the repos root (probe V5b: the two roots share
	// a device and differ only by inode, so one number cannot stand for both).
	MirrorVolume string
}

// ErrVolumeUnknown reports a prepare request that did not carry a measured
// volume identity for one of the two roots. No M3 workspace may bind to an
// unknown volume (migration 00004's comment on exactly this).
var ErrVolumeUnknown = errors.New("workspace: volume identity not measured")

// Prepare creates or reuses the workspace tree and one linked worktree per
// repository, in the order ADR-0017 D4 states:
//
//	mirror create-or-fetch → git worktree add -b <scope>/<name> →
//	read the real admin dir back (`rev-parse --absolute-git-dir`, G1b/G1c) →
//	pre-create <mirror>/logs/refs/heads/<scope>/ (P7) →
//	establish exclusions in <mirror>/info/exclude (X2/X4) →
//	declare the tree's shape (AssertNothingBut, C-GRANT2).
//
// It is idempotent: a re-run on a killed attempt reuses the existing worktree
// rather than failing on `already registered`, because a killed prepare can
// leave a half-added worktree behind and the next attempt must not be wedged.
func (m *Manager) Prepare(ctx context.Context, req PrepareRequest) (*PreparedWorkspace, error) {
	if req.WorkspaceVolumeID == "" || req.MirrorVolumeID == "" {
		return nil, ErrVolumeUnknown
	}
	mode := req.Mode
	if mode == "" {
		mode = "worktree"
	}
	if mode != "worktree" && mode != "clone" {
		return nil, fmt.Errorf("workspace: mode %q is not worktree or clone", mode)
	}
	layout, err := LayoutOf(m.WorkspaceRoot, req.ScopeKind, req.ScopeID)
	if err != nil {
		return nil, err
	}
	if err := layout.Ensure(""); err != nil {
		return nil, err
	}
	if err := layout.AssertNothingBut(); err != nil {
		return nil, err
	}

	// The identities the caller presented are echoed back rather than
	// re-measured: the claim was made against *these* numbers, and a
	// workspace.prepared event carrying a digest from a later measurement would
	// compare volumes that were never compared (probe V3: two named volumes can
	// share a device, so the digest is the only thing that identifies which one).
	out := &PreparedWorkspace{Layout: layout, WorkspaceVolume: req.WorkspaceVolumeID, MirrorVolume: req.MirrorVolumeID}
	for _, spec := range req.Repos {
		repo, err := m.prepareRepo(ctx, req, layout, spec, mode)
		if err != nil {
			return nil, err
		}
		out.Repos = append(out.Repos, *repo)
	}
	if err := layout.AssertNothingBut(); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Manager) prepareRepo(ctx context.Context, req PrepareRequest, layout Layout, spec RepoSpec, mode string) (*PreparedRepo, error) {
	mirror, err := MirrorFor(m.ReposRoot, req.ProjectID, spec.Name)
	if err != nil {
		return nil, err
	}
	mirror.VolumeID = req.MirrorVolumeID
	checkout := filepath.Join(layout.Repos, spec.Name)
	started := time.Now()

	var mirrorCreated bool
	err = m.locks.withMirror(mirror.Path, func() error {
		created, ferr := m.ensureMirror(ctx, mirror, spec)
		if ferr != nil {
			return ferr
		}
		mirrorCreated = created
		if ferr := linkRefNamespace(ctx, m.Git, mirror, req.ScopeID); ferr != nil {
			return ferr
		}
		if ferr := m.ensureCheckout(ctx, mirror, req.ScopeID, spec, checkout, mode); ferr != nil {
			return ferr
		}
		return declareExclusions(ctx, m.Git, mirror, checkout, req.ExcludedPaths)
	})
	if err != nil {
		return nil, err
	}

	// The admin dir is read back, never constructed. Probe G1: two worktrees
	// of one repository get `worktrees/backend` and `worktrees/backend1`, and
	// G1b falsified the mechanism ADR-0017 D4 named (`git worktree list
	// --porcelain` emitted no `gitdir:` line at all on git 2.56.0 and 2.39.5).
	// G1c confirms `rev-parse --absolute-git-dir` and the worktree's own .git
	// file agree, so that is the read-back — and if it ever answers nothing,
	// the commit grant would have no path to name (the failure C-P3 measured),
	// which is why an empty answer is fatal here rather than empty.
	adminDir, err := m.Git.Stdout(ctx, checkout, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return nil, fmt.Errorf("workspace: read back the git dir of %s: %w", checkout, err)
	}
	adminDir = strings.TrimSpace(firstLine(adminDir))
	if err := checkAbsoluteNoDotDot(adminDir); err != nil {
		return nil, fmt.Errorf("workspace: admin dir of %s: %w", checkout, err)
	}
	base, err := m.Git.Stdout(ctx, checkout, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("workspace: base commit of %s: %w", checkout, err)
	}
	head, err := m.Git.Stdout(ctx, checkout, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("workspace: head commit of %s: %w", checkout, err)
	}
	// The exclusion set for the row is the declared set, which
	// declareExclusions has already proven git honors (per path, with
	// `check-ignore -q`) — an exclusion git does not honor is a failed prepare
	// (ADR-0017 D3's `exclusion_failed`), never a row claiming protection that
	// is not there.
	excluded := declared(req.ExcludedPaths)
	return &PreparedRepo{
		RepositoryID:    spec.RepositoryID,
		Name:            spec.Name,
		CheckoutPath:    checkout,
		MirrorPath:      mirror.Path,
		MirrorVolume:    req.MirrorVolumeID,
		AdminDir:        adminDir,
		RunRef:          req.ScopeID + "/" + spec.Name,
		BaseCommit:      strings.TrimSpace(firstLine(base)),
		HeadCommit:      strings.TrimSpace(firstLine(head)),
		ExcludedPaths:   excluded,
		MirrorCreated:   mirrorCreated,
		FetchDurationMS: time.Since(started).Milliseconds(),
	}, nil
}

// declared normalizes a declared exclusion set: deduped, sorted, no empty or
// absolute/traversal entries (those are refused earlier by declareExclusions,
// so seeing one here would be a caller bug worth recording).
func declared(paths []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range paths {
		p = strings.TrimSuffix(strings.TrimSpace(p), "/")
		if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "..") || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// ensureMirror creates <repos root>/<project>/<name>.git with
// `git clone --mirror` or fetches into it. It never runs `gc` (ADR-0010 D6:
// no mirror maintenance inside an attempt).
func (m *Manager) ensureMirror(ctx context.Context, mirror Mirror, spec RepoSpec) (bool, error) {
	if _, err := os.Stat(filepath.Join(mirror.Path, "HEAD")); err == nil {
		// `--git-dir` is not decoration: `git fetch <mirror> <refspec>` from
		// anywhere else means "fetch *from* the mirror into the repository at
		// the current directory", which is what git said when this was tried
		// from the worker's own checkout — `fatal: refusing to fetch into
		// branch 'refs/heads/main' checked out at …`.
		if err := m.pinFetchRefspec(ctx, mirror.Path); err != nil {
			return false, err
		}
		out, err := m.Git.Run(ctx, "", "--git-dir="+mirror.Path, "fetch", "--quiet", "--prune", "origin")
		if err != nil {
			return false, fmt.Errorf("workspace: fetch mirror %s: %w (%s)", mirror.Path, err, Redact(out))
		}
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("workspace: inspect mirror %s: %w", mirror.Path, err)
	}
	if spec.GitURL == "" {
		return false, fmt.Errorf("workspace: mirror %s does not exist and repository %q has no clone URL", mirror.Path, spec.Name)
	}
	if err := os.MkdirAll(filepath.Dir(mirror.Path), 0o755); err != nil {
		return false, fmt.Errorf("workspace: create %s: %w", filepath.Dir(mirror.Path), err)
	}
	// A half-written mirror (killed clone) must not be reused: git reports it
	// as an existing repository while every ref inside it is missing.
	if st, err := os.Stat(mirror.Path); err == nil && st.IsDir() {
		if err := os.RemoveAll(mirror.Path); err != nil {
			return false, fmt.Errorf("workspace: clear half-written mirror %s: %w", mirror.Path, err)
		}
	}
	if _, err := m.Git.Run(ctx, "", "clone", "--quiet", "--mirror", spec.GitURL, mirror.Path); err != nil {
		return false, fmt.Errorf("workspace: create mirror %s from %s: %w", mirror.Path, Redact(spec.GitURL), err)
	}
	if err := m.pinFetchRefspec(ctx, mirror.Path); err != nil {
		return false, err
	}
	return true, nil
}

// mirrorFetchRefspec is the refspec that keeps a mirror refresh from eating
// the run branches.
//
// `git clone --mirror` (ADR-0017 D1's wording) sets `remote.origin.mirror=true`
// with refspec `+refs/*:refs/*`, and `git fetch --prune` (D2's update path)
// then deletes every ref the remote does not have — including
// `refs/heads/<conversation>/<repo>`, the branch D4 hands the agent as its
// commit grant. The first time this was exercised the second prepare pruned
// the first run's branch out from under its own worktree and `rev-parse HEAD`
// died with "ambiguous argument 'HEAD': unknown revision". So the mirror
// refresh owns refs/remotes/origin/* and nothing else; prune reaches no
// further than that namespace, and the run namespace is invisible to it.
const mirrorFetchRefspec = "+refs/heads/*:refs/remotes/origin/*"

func (m *Manager) pinFetchRefspec(ctx context.Context, mirrorPath string) error {
	if _, err := m.Git.Run(ctx, "", "--git-dir="+mirrorPath, "config", "--replace-all",
		"remote.origin.fetch", mirrorFetchRefspec); err != nil {
		return fmt.Errorf("workspace: pin the fetch refspec on mirror %s: %w", mirrorPath, err)
	}
	// An absent key makes `config --unset` exit 3, which is the steady state
	// rather than a failure; re-reading is cheaper than parsing git's stderr.
	if _, err := m.Git.Run(ctx, "", "--git-dir="+mirrorPath, "config", "--unset", "remote.origin.mirror"); err == nil {
		return nil
	}
	if _, err := m.Git.Stdout(ctx, "", "--git-dir="+mirrorPath, "config", "--get", "remote.origin.mirror"); err == nil {
		return fmt.Errorf("workspace: mirror %s still has remote.origin.mirror set, which would let a prune delete the run branches", mirrorPath)
	}
	return nil
}

// linkRefNamespace pre-creates the two per-scope directories a confined
// commit needs. P7 is the reflog half (git creates reflog dirs lazily and
// cannot mkdir through a leaf-only grant); the refs half is the same failure
// shape one commit later.
func linkRefNamespace(ctx context.Context, r *Runner, mirror Mirror, scopeID string) error {
	if err := CheckScopeID(scopeID); err != nil {
		return err
	}
	for _, dir := range []string{mirror.RefsDir(scopeID), mirror.LogsRefDir(scopeID)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("workspace: pre-create %s: %w", dir, err)
		}
	}
	return nil
}

// ensureCheckout adds the linked worktree (or, in clone mode, a standalone
// clone from the mirror) on the per-scope branch.
func (m *Manager) ensureCheckout(ctx context.Context, mirror Mirror, scopeID string, spec RepoSpec, checkout, mode string) error {
	if _, err := os.Stat(filepath.Join(checkout, ".git")); err == nil {
		return nil // already prepared: an earlier attempt (or a restart) did it
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("workspace: inspect %s: %w", checkout, err)
	}
	if err := os.MkdirAll(filepath.Dir(checkout), 0o755); err != nil {
		return fmt.Errorf("workspace: create %s: %w", filepath.Dir(checkout), err)
	}
	runRef := scopeID + "/" + spec.Name
	// Does this conversation already have a run branch? A *released* workspace
	// keeps its refs by design (ADR-0017 D1: the run ref persists so the next turn
	// on the same conversation continues from what the last one committed), so on
	// the second turn of any conversation the branch exists and the worktree does
	// not. `worktree add -b` cannot express that and fails with
	// "fatal: a branch named '<run-ref>' already exists", which means every
	// resumed conversation would be permanently unpreparable — a bug visible only
	// on turn two, and therefore only against a real store.
	//
	// `rev-parse --verify` is the read; the branch is either there or not, and a
	// refusal to guess is the same rule that makes startPoint reject a
	// branch-name heuristic.
	existing, hasRunRef := m.refCommit(ctx, mirror, "refs/heads/"+runRef)

	base := existing
	if !hasRunRef {
		if spec.BaseCommit != "" {
			// ADR-0053's pinned base: the run snapshotted this commit identity
			// at creation and it never moves. The mirror must contain it —
			// thread refs are local mirror state (mirrorFetchRefspec never
			// fetches them), so on another worker's fresh mirror the honest
			// answer is a named refusal, never a silent fall-back to the
			// default branch (that would move the pinned base).
			if _, ok := m.refCommit(ctx, mirror, spec.BaseCommit); !ok {
				return fmt.Errorf("workspace: pinned base commit %s for %s is not present in mirror %s (it came from a thread branch this worker does not own); the run refuses rather than move its base (ADR-0053)",
					shortSHA(spec.BaseCommit), spec.Name, mirror.Path)
			}
			base = spec.BaseCommit
		} else {
			resolved, err := m.startPoint(ctx, mirror, spec)
			if err != nil {
				return err
			}
			base = resolved
		}
	}
	if mode == "clone" {
		if _, err := m.Git.Run(ctx, "", "clone", "--quiet", "--no-local", mirror.Path, checkout); err != nil {
			return fmt.Errorf("workspace: clone %s from mirror: %w", checkout, err)
		}
		if hasRunRef {
			// A clone-mode workspace was removed with its branch still in the
			// mirror; cloning then checking out the existing branch is the only
			// way to resume without inventing a second history.
			if _, err := m.Git.Run(ctx, checkout, "checkout", "-q", runRef); err != nil {
				return fmt.Errorf("workspace: resume run branch %s in cloned %s: %w", runRef, checkout, err)
			}
			return nil
		}
		if _, err := m.Git.Run(ctx, checkout, "checkout", "-q", "-b", runRef, base); err != nil {
			return fmt.Errorf("workspace: create run branch %s: %w", runRef, err)
		}
		return nil
	}
	// `--git-dir` on the mirror is what makes worktree add work from a bare
	// repository; the alternative (`git -C <mirror> worktree add`) is the same
	// command, but the explicit form is what the probes recorded.
	//
	// `-b <ref>` only when the ref does not already exist. `git worktree add
	// <path> <existing-branch>` checks that branch out in the new worktree, which
	// is the resume; passing `-b` for a name that exists is the failure above.
	args := []string{"--git-dir=" + mirror.Path, "worktree", "add", "-q"}
	if hasRunRef {
		args = append(args, checkout, runRef)
	} else {
		args = append(args, "-b", runRef, checkout, base)
	}
	if _, err := m.Git.Run(ctx, "", args...); err != nil {
		return fmt.Errorf("workspace: add worktree %s on %s: %w", checkout, runRef, err)
	}
	return nil
}

// refCommit reads one ref out of a mirror and reports both its commit and whether
// it exists at all. The two-valued return is the point: an empty string cannot
// distinguish "no such ref" from "a ref whose value we failed to read", and the
// caller is choosing between creating a branch and resuming one.
func (m *Manager) refCommit(ctx context.Context, mirror Mirror, ref string) (string, bool) {
	out, err := m.Git.Stdout(ctx, "", "--git-dir="+mirror.Path, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return "", false
	}
	commit := strings.TrimSpace(firstLine(out))
	if commit == "" {
		return "", false
	}
	return commit, true
}

// shortSHA abbrevates a commit id for a refusal message: the full identity is
// what the journal carries (PreparedRepo / the error), the short form is the
// human half of "which commit".
func shortSHA(sha string) string {
	if len(sha) >= 7 {
		return sha[:7]
	}
	return sha
}

// startPoint resolves the commit a run bases on, in the order ADR-0017 D2
// allows: the fetched remote-tracking branch, then a ref the mirror already
// had (a mirror that was just cloned has refs/heads/*), and never a guess.
// With no configured default branch the mirror's own HEAD is the answer.
func (m *Manager) startPoint(ctx context.Context, mirror Mirror, spec RepoSpec) (string, error) {
	candidates := []string(nil)
	if spec.DefaultBranch != "" {
		if err := checkRefName(spec.DefaultBranch); err != nil {
			return "", fmt.Errorf("workspace: repository %q: %w", spec.Name, err)
		}
		candidates = append(candidates,
			"refs/remotes/origin/"+spec.DefaultBranch+"^{commit}",
			"refs/heads/"+spec.DefaultBranch+"^{commit}")
	}
	for _, cand := range candidates {
		out, err := m.Git.Stdout(ctx, "", "--git-dir="+mirror.Path, "rev-parse", "--verify", "--quiet", cand)
		if err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out), nil
		}
	}
	if spec.DefaultBranch != "" {
		return "", fmt.Errorf("workspace: mirror %s has no branch %q to base %s on (ADR-0017 D2 refuses a branch-name guess)", mirror.Path, spec.DefaultBranch, spec.Name)
	}
	// No configured default: follow the mirror's HEAD, which git set from the
	// remote's default branch at clone time.
	sym, err := m.Git.Stdout(ctx, "", "--git-dir="+mirror.Path, "symbolic-ref", "--quiet", "HEAD")
	if err != nil {
		return "", fmt.Errorf("workspace: mirror %s has neither a default branch nor a HEAD to base %s on", mirror.Path, spec.Name)
	}
	head := strings.TrimSpace(strings.TrimSuffix(sym, "\n"))
	for _, cand := range []string{"refs/remotes/origin/" + strings.TrimPrefix(head, "refs/heads/") + "^{commit}", head + "^{commit}"} {
		out, err := m.Git.Stdout(ctx, "", "--git-dir="+mirror.Path, "rev-parse", "--verify", "--quiet", cand)
		if err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out), nil
		}
	}
	return "", fmt.Errorf("workspace: mirror %s HEAD %s does not resolve to a commit for %s", mirror.Path, head, spec.Name)
}

// declareExclusions appends the declared exclusion set to the mirror's shared
// exclude file and confirms git honors it. An exclusion that git does not
// honor is the one security failure a workspace can have quietly, so it is
// fatal and reported as `exclusion_failed` (ADR-0017 D3's quarantine reason).
//
// Appending is idempotent and the file is sorted-deduped on write, so a
// million prepares do not grow it.
// dropTracked removes from `paths` every path the checkout tracks (git's own
// answer, not our guess: `ls-files --error-unmatch`, exit 0 means tracked).
func dropTracked(ctx context.Context, r *Runner, checkout string, paths []string) ([]string, error) {
	keep := make([]string, 0, len(paths))
	for _, p := range paths {
		if _, err := r.Run(ctx, checkout, "ls-files", "--error-unmatch", "--", p); err == nil {
			continue
		}
		keep = append(keep, p)
	}
	return keep, nil
}

func declareExclusions(ctx context.Context, r *Runner, mirror Mirror, checkout string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	uniq := map[string]bool{}
	var want []string
	for _, p := range paths {
		if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
			return fmt.Errorf("workspace: exclusion %q is not a safe relative path", p)
		}
		if !uniq[p] {
			uniq[p] = true
			want = append(want, p)
		}
	}
	sort.Strings(want)

	// A path the repository *tracks* cannot be hidden by an exclude file: git
	// ignores exclusions for tracked content, and `check-ignore` will honestly
	// report "not ignored" — so declaring one would fail the whole prepare at
	// the confirmation step below. APM's apm.lock.yaml is exactly this case: it
	// must be committed to pin a context, and `install --frozen` rewrites it in
	// place (apm 0.33 probe A5). The real guarantee for a tracked file — that
	// the packaged bytes are the pinned bytes — is the profile's lock-digest
	// gate at staging time, not an exclude; and a rewritten lock lands on the
	// run ref, the unit's own scratch lineage, never on main. Tracked paths
	// are therefore dropped from the declaration set.
	if kept, err := dropTracked(ctx, r, checkout, want); err != nil {
		return err
	} else {
		want = kept
	}
	if len(want) == 0 {
		return nil
	}

	file := mirror.InfoExclude()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return fmt.Errorf("workspace: create %s: %w", filepath.Dir(file), err)
	}
	existing := map[string]bool{}
	if data, err := os.ReadFile(file); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			existing[strings.TrimSuffix(strings.TrimSpace(line), "/")] = true
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("workspace: read %s: %w", file, err)
	}
	var add []string
	for _, p := range want {
		if !existing[p] {
			add = append(add, p)
		}
	}
	if len(add) > 0 {
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return fmt.Errorf("workspace: open %s: %w", file, err)
		}
		var sb strings.Builder
		for _, p := range add {
			sb.WriteString(p)
			sb.WriteString("\n")
		}
		if _, err := f.WriteString(sb.String()); err != nil {
			_ = f.Close()
			return fmt.Errorf("workspace: append %s: %w", file, err)
		}
		if err := f.Close(); err != nil {
			return fmt.Errorf("workspace: close %s: %w", file, err)
		}
	}

	// Confirm it took, per path, in the checkout that will hold it. Probes
	// X1/X3 are the history: writing to the wrong file "succeeds" completely
	// and hides nothing.
	for _, p := range want {
		if _, err := r.Run(ctx, checkout, "check-ignore", "-q", p); err != nil {
			return fmt.Errorf("workspace: %s is not ignored in %s after declaring it in %s (probes X1/X3): %w", p, checkout, file, err)
		}
	}
	return nil
}

// RemoveWorktrees releases a workspace's checkouts: `worktree remove --force`
// then `prune`, proven not to disturb another live run by W6. It returns false
// (never an error) when a worktree could not be removed, which the caller
// reports as workspace.released with repos_pruned=false rather than pretending.
func (m *Manager) RemoveWorktrees(ctx context.Context, layout Layout, repos []PreparedRepo) bool {
	ok := true
	for _, repo := range repos {
		if err := m.locks.withMirror(repo.MirrorPath, func() error {
			if _, err := m.Git.Run(ctx, "", "--git-dir="+repo.MirrorPath, "worktree", "remove", "--force", repo.CheckoutPath); err != nil {
				return err
			}
			_, _ = m.Git.Run(ctx, "", "--git-dir="+repo.MirrorPath, "worktree", "prune")
			return nil
		}); err != nil {
			ok = false
		}
	}
	// A clone-mode checkout has no worktree registration; removing the
	// directory is the whole of it.
	if entries, err := os.ReadDir(layout.Repos); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				if err := os.RemoveAll(filepath.Join(layout.Repos, e.Name())); err != nil {
					ok = false
				}
			}
		}
	}
	return ok
}

// PruneMirrors asks each mirror to drop registrations whose worktree directory
// is gone. Called after a crash, where the directory was deleted out from
// under the registration (WORKSPACES.md W6).
func (m *Manager) PruneMirrors(ctx context.Context, mirrors []string) {
	for _, mirror := range mirrors {
		_ = m.locks.withMirror(mirror, func() error {
			_, err := m.Git.Run(ctx, "", "--git-dir="+mirror, "worktree", "prune")
			return err
		})
	}
}

// HeadCommit reads a repository's current commit unsandboxed, after the unit
// ended. ADR-0017's P8 rule makes this read the proof a commit landed — an
// exit status is not, because the probe observed a *successful* commit print
// `packed-refs.lock: Permission denied` and a *failed* one look fine.
func (m *Manager) HeadCommit(ctx context.Context, checkout string) (string, error) {
	out, err := m.Git.Stdout(ctx, checkout, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("workspace: head commit of %s: %w", checkout, err)
	}
	return strings.TrimSpace(firstLine(out)), nil
}

// Status reports the dirty summary and modified-path manifest of one checkout,
// with the excluded set subtracted twice over: git already hides excluded
// paths, and ADR-0017 D6 requires the declared exclusions to be filtered again
// in code, because a git-level exclusion must never be the only thing standing
// between a `.env` and an artifact.
func (m *Manager) Status(ctx context.Context, checkout string, excluded []string) (Summary, error) {
	out, err := m.Git.Stdout(ctx, checkout, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		return Summary{}, fmt.Errorf("workspace: status of %s: %w", checkout, err)
	}
	drop := map[string]bool{}
	for _, e := range excluded {
		drop[strings.TrimSuffix(e, "/")] = true
	}
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		path := strings.TrimSpace(line[3:])
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		if path == "" {
			continue
		}
		if drop[filepath.ToSlash(filepath.Clean(path))] || drop[strings.TrimSuffix(path, "/")] {
			continue
		}
		paths = append(paths, filepath.ToSlash(path))
	}
	sort.Strings(paths)
	diff, err := m.Git.Stdout(ctx, checkout, "diff", "--stat", "--no-color")
	if err != nil {
		// The manifest above is already the security-relevant half; a diff
		// that will not render is reported, not hidden.
		diff = "(diff unavailable: " + Redact(err.Error()) + ")"
	}
	return Summary{
		Dirty:   len(paths) > 0 || strings.TrimSpace(diff) != "",
		Raw:     strings.TrimSpace(out),
		Paths:   paths,
		Summary: fmt.Sprintf("%d tracked/untracked path(s) differ from the run branch", len(paths)),
		Diff:    strings.TrimSpace(diff),
	}, nil
}

// Summary is one checkout's captured state at a unit boundary (ADR-0017 D8:
// capture only, no recoverability claim — D-024 stays Open).
type Summary struct {
	Dirty   bool
	Summary string
	Paths   []string
	Raw     string
	Diff    string
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func listLines(s string) []string {
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		if t := strings.TrimSpace(line); t != "" {
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

// DeclareExclusions adds paths to a repository's project exclusion file after
// the tree already exists.
//
// It exists because two of the paths that must be excluded are not knowable at
// topology time: APM only reveals what it generated once it has run (probe A6:
// the generated paths are git-visible until the exclusion file names them), and
// a materialized secret is written between prepare and launch. Calling this is
// therefore part of the pre-launch sequence, not a correction afterwards —
// an exclusion established after the agent's first commit is an exclusion that
// missed one capture.
//
// It returns the repository's full declared set, so the caller's row records
// what git honors rather than what one caller asked for.
func (m *Manager) DeclareExclusions(ctx context.Context, repo *PreparedRepo, paths []string) ([]string, error) {
	if repo == nil {
		return nil, fmt.Errorf("workspace: no prepared repository to declare exclusions for")
	}
	// The mirror identity comes from the prepared row, not from re-deriving it
	// from the layout: a row written by an earlier attempt is the authority on
	// which mirror this worktree links to, and writing the exclusion into a
	// different one would exclude nothing while reporting that it did.
	mirror := Mirror{Name: repo.Name, Path: repo.MirrorPath, VolumeID: repo.MirrorVolume}
	if err := CheckGrantPath(mirror.Path); err != nil {
		return nil, fmt.Errorf("workspace: exclusion target for %s: %w", repo.Name, err)
	}
	if _, err := os.Stat(filepath.Join(mirror.Path, "HEAD")); err != nil {
		return nil, fmt.Errorf("workspace: exclusion target %s is not a repository: %w", mirror.Path, err)
	}
	if err := m.locks.withMirror(mirror.Path, func() error {
		return declareExclusions(ctx, m.Git, mirror, repo.CheckoutPath, paths)
	}); err != nil {
		return nil, err
	}
	declared := mergeDeclared(repo.ExcludedPaths, paths)
	repo.ExcludedPaths = declared
	return declared, nil
}

// SeedAgentHome writes the agent HOME's git identity and returns the file path.
//
// The per-attempt HOME is created 0700 by Ensure and is where APM puts its state
// (probe A2), where the harnesses put theirs, and where git looks for its
// configuration. Probe P6 is the reason this is not optional: with an unreadable
// or absent HOME git aborts every command with
// `fatal: unknown error occurred while reading the configuration files`, so a
// turn would fail in a way that looks like an agent bug.
//
// Identity only — no credential helper, no includes, nothing that could reach a
// path outside the home. The env form (GIT_AUTHOR_*) is set too, so a home that
// gets wiped mid-unit still attributes commits instead of failing.
func (m *Manager) SeedAgentHome(home string, id GitIdentity) error {
	if err := CheckGrantPath(home); err != nil {
		return fmt.Errorf("workspace: agent home: %w", err)
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("workspace: create agent home %s: %w", home, err)
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return fmt.Errorf("workspace: tighten agent home %s: %w", home, err)
	}
	if id.Name == "" || id.Email == "" {
		// No identity configured: leave the file alone rather than writing an
		// empty [user] section, which git reads as "no identity" and refuses to
		// commit with. The seeded config is a convenience; the env vars are the
		// guarantee.
		return nil
	}
	body := fmt.Sprintf("[user]\n\tname = %s\n\temail = %s\n", sanitizeConfigValue(id.Name), sanitizeConfigValue(id.Email))
	file := filepath.Join(home, ".gitconfig")
	if existing, err := os.ReadFile(file); err == nil && strings.Contains(string(existing), "[user]") {
		return nil // someone (or an earlier attempt) already seeded it
	}
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		return fmt.Errorf("workspace: seed %s: %w", file, err)
	}
	return nil
}

// sanitizeConfigValue keeps a name or email from breaking out of a git config
// value. The values come from worker configuration, not from a user, but a
// quoted newline in a name would otherwise be an injection into a file the
// agent can read.
func sanitizeConfigValue(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, `"`, "'")
	return strings.TrimSpace(s)
}

func mergeDeclared(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, set := range [][]string{a, b} {
		for _, p := range set {
			p = strings.TrimSuffix(strings.TrimSpace(p), "/")
			if p == "" || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}
