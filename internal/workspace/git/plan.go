package git

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Grant roles are the names a sandbox grant is *reported* by. The role is what
// travels in an event or an API response; the path stays inside the worker
// (contract deviation D14: the journal is streamed to every project member, so
// a resolved grant list — a list of absolute host paths — cannot appear there
// even though the browser is the least of the readers).
//
// The list is ADR-0017 D4's table read as names, plus the two the corrected
// grant shape needs (agent_home, launcher_home).
// The names are internal/events' grant vocabulary, not a private one: the same
// strings go into sandbox.verified.grants, where a test asserts
// events.ValidGrantRole on each (TestRoleVocabularyMatchesTheWire in plan_test.go
// pins the two together so a rename here cannot silently invent a role the
// schema rejects).
const (
	RoleCheckout      = "workspace_repo"      // the run's worktree: rw
	RoleScratch       = "workspace_scratch"   // generated output: rw
	RoleAgentHome     = "workspace_home"      // the agent's HOME + .gitconfig: rw
	RoleMirrorRead    = "mirror_read"         // required by *any* git command (P10)
	RoleMirrorObjects = "mirror_objects"      // commit axis: content-addressed, shared
	RoleMirrorRef     = "mirror_run_refs"     // commit axis: <scope> only
	RoleMirrorReflog  = "mirror_run_logs"     // commit axis: <scope> only
	RoleWorktreeAdmin = "mirror_admin_dir"    // commit axis: this worktree only
	RoleHarnessAuth   = "harness_credentials" // rw: a launcher credential tree (ADR-0019 D4)
)

// Access levels, matching nono's two grant flags.
const (
	AccessReadWrite = "rw"
	AccessReadOnly  = "ro"
)

// Grant is one named sandbox grant. Path is set for the launcher and cleared
// by Redacted, which is what makes it safe to put a grant list in an event.
type Grant struct {
	Role string
	Path string
}

// Access returns the level the role carries. Every role here is rw except the
// two read-only ones, so the mapping is a table and not an argument.
func (g Grant) Access() string {
	switch g.Role {
	case RoleMirrorRead:
		return AccessReadOnly
	default:
		return AccessReadWrite
	}
}

// Label is the event/API form: role + access, never a path.
func (g Grant) Label() string { return g.Role + ":" + g.Access() }

// LaunchPlan is everything a sandboxed launch needs: the grant set, the two
// HOMEs, and the axes the profile chose.
//
// The two HOMEs are the correction C-H1 forces. Handing HOME=<workspace>/home
// to *nono* makes nono refuse its own workspace grant
// ("Refusing to grant '<ws>' … overlaps protected nono state root
// '<ws>/home/.local/state/nono'"), and the trap is sticky: once nono has run
// with HOME=X, every later grant covering X is refused. So:
//
//	nono's own HOME      = LauncherHome (outside every grant, worker-owned)
//	the agent's HOME     = the child's first argv entry (`env HOME=… <adapter>`)
//
// which is C-H1c — the shell-free form, because internal/sandbox/nono execs
// the adapter directly and cannot go through a shell to set it.
type LaunchPlan struct {
	// WorkspaceID / WorkerID tie the record to its rows.
	WorkspaceID string
	// Layout is the tree the grants came from.
	Layout Layout
	// Grants is the resolved set, in a stable order.
	Grants []Grant
	// LauncherHome is nono's own HOME: a worker-owned directory that is never
	// under any workspace and never itself granted.
	LauncherHome string
	// AgentHome is <agent_root>/home — the child's HOME, inside the grants.
	AgentHome string
	// Cwd is the working directory the adapter starts in. It must sit inside
	// one of the rw grants: in profile mode nono does NOT abort on a cwd
	// outside the grants (probe C-CWD), it relocates the child to /, so this
	// rule is the adapter's own, asserted before exec (C-CWD2).
	Cwd string
	// CommitGranted is the ADR-0017 D4 axis. Without it the four mirror
	// writes are absent and the agent's own `git commit` fails.
	CommitGranted bool
	// DeniedPaths are the profile's deny requests. nono has no CLI deny flag
	// and Linux filesystem.deny is point-in-time (probes C-TMP2/C-TMP3), so
	// under `required` this is a configuration error rather than a policy —
	// which is why the plan carries it and the launcher refuses it.
	DeniedPaths []string
}

// Labels returns the event form of the grant set: {role, access} per grant, no
// paths, sorted so a digest over it is stable.
func (p LaunchPlan) Labels() []string {
	out := make([]string, 0, len(p.Grants))
	for _, g := range p.Grants {
		out = append(out, g.Label())
	}
	sort.Strings(out)
	return out
}

// EventGrants is the grant set in the shape sandbox.verified carries.
func (p LaunchPlan) EventGrants() []Grant { return append([]Grant(nil), p.Grants...) }

// Resolved returns the grant set as role=path, for the worker log and the
// nono argv. Never for an event.
func (p LaunchPlan) Resolved() []Grant { return append([]Grant(nil), p.Grants...) }

// Check the plan is launchable, before anything is exec'd:
//
//   - every grant path is absolute, `..`-free, outside the temp tree and
//     exists (C-FC3: nono silently ignores a grant that does not resolve);
//   - the cwd sits inside an rw grant (C-CWD: in profile mode nono relocates
//     the child to / instead of refusing, so a wrong cwd is a silently broken
//     turn, not a failed launch);
//   - nono's own HOME is not covered by any grant (C-H1's sticky trap);
//   - the agent HOME is covered by one (P6: git aborts otherwise).
func (p LaunchPlan) Check() error {
	if len(p.Grants) == 0 {
		return fmt.Errorf("workspace: launch plan has no grants; refusing to launch a sandbox with an empty allowlist")
	}
	seen := map[string]bool{}
	for _, g := range p.Grants {
		if g.Role == "" {
			return fmt.Errorf("workspace: grant with no role at %s", g.Path)
		}
		if seen[g.Path] {
			continue
		}
		seen[g.Path] = true
		if err := CheckGrantPath(g.Path); err != nil {
			return fmt.Errorf("workspace: grant %s (%s): %w", g.Role, g.Path, err)
		}
	}
	if p.Cwd == "" {
		return fmt.Errorf("workspace: launch plan has no working directory")
	}
	if err := insideAny(p.Cwd, p.rwPaths()); err != nil {
		return fmt.Errorf("workspace: cwd %s is outside every read-write grant; in profile mode nono does not refuse this, it moves the child to / (probe C-CWD), so the turn would fail confusingly: %w", p.Cwd, err)
	}
	if err := insideAny(p.AgentHome, p.rwPaths()); err != nil {
		return fmt.Errorf("workspace: agent home %s is outside the read-write grants; git aborts on an ungranted HOME (probe P6): %w", p.AgentHome, err)
	}
	if p.LauncherHome != "" {
		for _, g := range p.Grants {
			if covers(g.Path, p.LauncherHome) {
				return fmt.Errorf("workspace: nono's own HOME %s is inside the %s grant %s: nono refuses a grant that overlaps its own state root, and once it has run with that HOME every later grant covering it is refused (probe C-H1)", p.LauncherHome, g.Role, g.Path)
			}
		}
	}
	if len(p.DeniedPaths) > 0 {
		return fmt.Errorf("workspace: %d denied path(s) requested; the sandbox backend has no deny mechanism that holds under `required` (probes C-TMP2/C-TMP3, contract deviation D4), so absence-of-grant is the only rule: refusing to launch", len(p.DeniedPaths))
	}
	return nil
}

func (p LaunchPlan) rwPaths() []string {
	var out []string
	for _, g := range p.Grants {
		if g.Access() == AccessReadWrite {
			out = append(out, g.Path)
		}
	}
	return out
}

// Plan builds the launch plan for a prepared workspace.
//
// The grant set is the *narrow* shape (probes C-GRANT/C-GRANT2), which is what
// keeps meta/ out by omission: the three children of agent_root are named
// individually, and a fourth child would have to be named here to be reached.
// commit adds exactly ADR-0017 D4's four mirror writes — objects, this scope's
// refs, this scope's reflog, this worktree's admin dir — and nothing else:
// P4 measured another run's ref write being denied under this set while the
// identical unsandboxed command succeeded, and X4 measured <mirror>/info being
// unreachable with the mirror read-only.
func Plan(prep *PreparedWorkspace, opts PlanOptions) (LaunchPlan, error) {
	if prep == nil {
		return LaunchPlan{}, fmt.Errorf("workspace: nothing prepared")
	}
	if opts.WorkspaceID == "" {
		return LaunchPlan{}, fmt.Errorf("workspace: launch plan needs the workspace id")
	}
	plan := LaunchPlan{
		WorkspaceID:   opts.WorkspaceID,
		Layout:        prep.Layout,
		AgentHome:     prep.Layout.Home,
		LauncherHome:  opts.LauncherHome,
		CommitGranted: opts.CommitGranted,
		DeniedPaths:   opts.DeniedPaths,
	}
	add := func(role, path string) {
		plan.Grants = append(plan.Grants, Grant{Role: role, Path: path})
	}
	add(RoleScratch, prep.Layout.Scratch)
	add(RoleAgentHome, prep.Layout.Home)

	// cwd: the first checkout, or scratch for a repository-free workspace.
	if len(prep.Repos) > 0 {
		plan.Cwd = prep.Repos[0].CheckoutPath
	} else {
		plan.Cwd = prep.Layout.Scratch
	}

	for _, repo := range prep.Repos {
		add(RoleCheckout, repo.CheckoutPath)
		// P10: any git command in a linked worktree dies with
		// `fatal: gitfile does not point to a valid repository` unless the
		// mirror itself is readable. This grant is never optional.
		add(RoleMirrorRead, repo.MirrorPath)
		if !opts.CommitGranted {
			continue
		}
		scope := prep.Layout.ScopeID
		add(RoleMirrorObjects, filepath.Join(repo.MirrorPath, "objects"))
		add(RoleMirrorRef, filepath.Join(repo.MirrorPath, "refs", "heads", scope))
		add(RoleMirrorReflog, filepath.Join(repo.MirrorPath, "logs", "refs", "heads", scope))
		add(RoleWorktreeAdmin, repo.AdminDir)
	}
	for _, rw := range opts.HarnessCredentialDirs {
		add(RoleHarnessAuth, rw)
	}
	return plan, plan.Check()
}

// PlanOptions are the profile axes and runtime paths Plan needs.
type PlanOptions struct {
	WorkspaceID   string
	CommitGranted bool
	// LauncherHome is nono's own HOME: checked against the grants, never one.
	LauncherHome          string
	HarnessCredentialDirs []string
	DeniedPaths           []string
}

func insideAny(path string, roots []string) error {
	clean := filepath.Clean(path)
	for _, root := range roots {
		if covers(root, clean) {
			return nil
		}
	}
	return fmt.Errorf("not inside %v", roots)
}

// covers reports whether root is, or contains, path.
func covers(root, path string) bool {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	if root == "/" {
		return true
	}
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}
