package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
)

func preparedForPlan(t *testing.T) (*Manager, *PreparedWorkspace, string) {
	t.Helper()
	m, root := newTestManager(t)
	url := newOrigin(t, root, "backend")
	vols := measure(t, m)
	prep, err := m.Prepare(context.Background(), PrepareRequest{
		ScopeKind: "conversation", ScopeID: testConvA, ProjectID: testProjectA,
		WorkspaceVolumeID: vols[RootKindWorkspaces].ID, MirrorVolumeID: vols[RootKindRepos].ID,
		Repos:         []RepoSpec{{RepositoryID: testConvC, Name: "backend", GitURL: url, DefaultBranch: "main"}},
		ExcludedPaths: []string{".env.test.local"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	return m, prep, filepath.Join(root, "launcher-state")
}

// TestPlanGrantShape is the ADR-0017 D4 table rendered as argv material, and
// the D13 promise: the meta/ sibling is reachable by no grant, because the
// grant set names agent_root's three children rather than agent_root.
func TestPlanGrantShape(t *testing.T) {
	_, prep, launcherHome := preparedForPlan(t)
	plan, err := Plan(prep, PlanOptions{WorkspaceID: "ws-1", CommitGranted: true, LauncherHome: launcherHome})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	roles := map[string]Grant{}
	for _, g := range plan.Grants {
		roles[g.Role] = g
	}
	for _, want := range []string{
		RoleCheckout, RoleScratch, RoleAgentHome, RoleMirrorRead,
		RoleMirrorObjects, RoleMirrorRef, RoleMirrorReflog, RoleWorktreeAdmin,
	} {
		if _, ok := roles[want]; !ok {
			t.Errorf("commit-granted plan is missing role %s; got %v", want, plan.Labels())
		}
	}

	t.Run("meta is reachable by no grant", func(t *testing.T) {
		// D13: the ADR's sentence was "never mounted"; the mechanism that makes
		// it true is that `--allow <dir>` is recursive, so the plan names the
		// three children of agent_root and the meta/ sibling is never inside any
		// of them.
		meta := prep.Layout.Meta
		for _, g := range plan.Grants {
			if covers(g.Path, meta) {
				t.Errorf("grant %s (%s) covers the metadata root %s — a recursive grant on agent_root or the workspace root would let an agent rewrite worker.lock/prepare.lock and the exclusion file", g.Role, g.Path, meta)
			}
			if covers(g.Path, launcherHome) {
				t.Errorf("grant %s covers nono's own HOME %s (probe C-H1: that poison is sticky)", g.Role, launcherHome)
			}
		}
		if !covers(prep.Layout.Work, meta) && covers(launcherHome, prep.Layout.Work) {
			t.Errorf("launcher home %s contains the agent root %s", launcherHome, prep.Layout.Work)
		}
		if covers(prep.Layout.Work, launcherHome) {
			t.Errorf("launcher home %s is inside the granted work tree %s — nono would refuse the whole plan (probe C-H1)", launcherHome, prep.Layout.Work)
		}
	})

	t.Run("commit axis adds exactly the four mirror writes", func(t *testing.T) {
		noCommit, err := Plan(prep, PlanOptions{WorkspaceID: "ws-1", LauncherHome: launcherHome})
		if err != nil {
			t.Fatalf("Plan without commit: %v", err)
		}
		var added []string
		have := map[string]bool{}
		for _, g := range noCommit.Grants {
			have[g.Role] = true
		}
		for _, g := range plan.Grants {
			if !have[g.Role] {
				added = append(added, g.Label())
			}
		}
		want := []string{
			"mirror_objects:rw", "mirror_run_refs:rw", "mirror_run_logs:rw", "mirror_admin_dir:rw",
		}
		if strings.Join(sortedCopy(added), ",") != strings.Join(sortedCopy(want), ",") {
			t.Errorf("commit_granted added %v, want exactly %v (ADR-0017 D4)", added, want)
		}
		// And the mirror itself is read-only without it, which is why the read
		// grant is never optional (probe P10).
		if roles[RoleMirrorRead].Access() != AccessReadOnly {
			t.Errorf("mirror_read access = %s, want ro", roles[RoleMirrorRead].Access())
		}
	})

	t.Run("the four writes are scoped to this run only", func(t *testing.T) {
		repo := prep.Repos[0]
		checks := map[string]string{
			RoleMirrorObjects: filepath.Join(repo.MirrorPath, "objects"),
			RoleMirrorRef:     filepath.Join(repo.MirrorPath, "refs", "heads", testConvA),
			RoleMirrorReflog:  filepath.Join(repo.MirrorPath, "logs", "refs", "heads", testConvA),
			RoleWorktreeAdmin: repo.AdminDir,
		}
		for role, want := range checks {
			g := roles[role]
			if g.Path != want {
				t.Errorf("%s = %s, want %s", role, g.Path, want)
			}
		}
		// P4's failure shape: another run's ref must NOT be covered.
		otherRef := filepath.Join(repo.MirrorPath, "refs", "heads", testConvB)
		if covers(roles[RoleMirrorRef].Path, otherRef) {
			t.Errorf("the run-ref grant reaches another conversation's refs at %s (probe P4 measured this being denied, which is the point)", otherRef)
		}
		// X4 measured <mirror>/info being unreachable with the mirror read-only
		// for *writes*; reading the exclusion list is not a secret, but clearing
		// it is the escape, so the rule is that no read-write grant reaches it.
		info := filepath.Join(repo.MirrorPath, "info")
		for _, g := range plan.Grants {
			if g.Access() == AccessReadWrite && covers(g.Path, info) {
				t.Errorf("read-write grant %s reaches <mirror>/info, which holds the exclusion file an agent could clear: %s", g.Role, g.Path)
			}
		}
	})

	t.Run("labels carry no paths", func(t *testing.T) {
		for _, label := range plan.Labels() {
			if strings.Contains(label, "/") {
				t.Errorf("grant label %q contains a path (deviation D14: the journal is read by every project member)", label)
			}
		}
	})
}

func TestPlanCheckRefusals(t *testing.T) {
	_, prep, launcherHome := preparedForPlan(t)
	good, err := Plan(prep, PlanOptions{WorkspaceID: "ws-1", CommitGranted: true, LauncherHome: launcherHome})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}

	t.Run("cwd outside the grants", func(t *testing.T) {
		bad := good
		bad.Cwd = prep.Layout.Meta
		err := bad.Check()
		if err == nil {
			t.Fatal("a cwd inside meta/ (outside every grant) was accepted")
		}
		// C-CWD: nono does not refuse this in profile mode; it moves the child
		// to /. The refusal has to come from us.
		if !strings.Contains(err.Error(), "C-CWD") {
			t.Errorf("refusal should cite probe C-CWD, got: %v", err)
		}
	})

	t.Run("launcher home inside a grant", func(t *testing.T) {
		bad := good
		bad.LauncherHome = filepath.Join(prep.Layout.Home, "nono-state")
		if err := bad.Check(); err == nil || !strings.Contains(err.Error(), "C-H1") {
			t.Errorf("a launcher home covered by a grant must be refused citing C-H1, got: %v", err)
		}
	})

	t.Run("missing grant path", func(t *testing.T) {
		bad := good
		bad.Grants = append([]Grant{{Role: RoleCheckout, Path: filepath.Join(prep.Layout.Repos, "gone")}}, bad.Grants...)
		if err := bad.Check(); err == nil || !strings.Contains(err.Error(), "C-FC3") {
			t.Errorf("a grant path that does not exist must be refused citing C-FC3, got: %v", err)
		}
	})

	t.Run("empty grant set", func(t *testing.T) {
		bad := good
		bad.Grants = nil
		if err := bad.Check(); err == nil {
			t.Error("an empty grant set was accepted; nono exits 1 on zero grants (C-FC1), so this must never reach it")
		}
	})

	t.Run("denied paths", func(t *testing.T) {
		bad := good
		bad.DeniedPaths = []string{"/etc"}
		if err := bad.Check(); err == nil || !strings.Contains(err.Error(), "D4") {
			t.Errorf("a deny request must be refused under required mode citing deviation D4, got: %v", err)
		}
	})

	t.Run("temp-tree grant", func(t *testing.T) {
		dir := labDir(t)
		trap := filepath.Join(dir, "trap")
		if err := os.MkdirAll(trap, 0o755); err != nil {
			t.Fatal(err)
		}
		bad := good
		bad.Grants = append([]Grant{{Role: RoleScratch, Path: "/tmp/communication-agent"}}, bad.Grants...)
		_ = trap
		if err := bad.Check(); err == nil || !strings.Contains(err.Error(), "temp tree") {
			t.Errorf("a /tmp grant must be refused (probe P9/N1: nono exits 0 with enforcement silently absent), got: %v", err)
		}
	})
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// TestRoleVocabularyMatchesTheWire pins this package's grant role names to the
// event schema's. They are the same strings in two places by construction —
// sandbox.verified.grants carries exactly what Plan computed — and a rename on
// one side would otherwise put a role the schema rejects (or, worse, silently
// means nothing) into every project's journal.
func TestRoleVocabularyMatchesTheWire(t *testing.T) {
	_, prep, launcherHome := preparedForPlan(t)
	// A harness credential tree is a real directory before it can be granted
	// (C-FC3: nono silently ignores a grant that does not resolve, so a
	// configured-but-missing credential dir must be refused, not passed on).
	harness := filepath.Join(prep.Layout.Meta, "harness")
	if err := os.MkdirAll(harness, 0o700); err != nil {
		t.Fatal(err)
	}
	plan, err := Plan(prep, PlanOptions{WorkspaceID: "ws-1", CommitGranted: true, LauncherHome: launcherHome, HarnessCredentialDirs: []string{harness}})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(plan.Grants) == 0 {
		t.Fatal("no grants")
	}
	for _, g := range plan.Grants {
		if !events.ValidGrantRole(g.Role) {
			t.Errorf("role %q is not in events' grant vocabulary: the journal would carry a role the schema does not know", g.Role)
		}
		if !events.ValidGrantAccess(g.Access()) {
			t.Errorf("role %q reports access %q, which the schema does not allow", g.Role, g.Access())
		}
	}
}
