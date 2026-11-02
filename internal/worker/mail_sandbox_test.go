package worker_test

// ADR-0072 § 12 (docs/adr/ADR-0072-agent-mail.md): on the asked side of an
// agent-mail link, read-only is enforced by the SANDBOX and not by a
// permission mode. The rows this reads are the ones the mail arms write (a
// linked target chat whose answer turn is stamped `ask`), and the guarantee is
// the grant: `workspace_repo` at access `ro`.
//
// Three shapes are pinned here and one is measured against a real kernel in
// mail_sandbox_nono_test.go:
//
//   - an asked turn's plan carries workspace_repo:ro and NO commit axis (a turn
//     that may not edit its repo must not hold the four mirror writes either);
//   - an asked turn whose edits a person approved carries workspace_repo:rw;
//   - an ordinary conversation's plan is unchanged (rw + its commit axis).
//
// The scratch and agent-home grants stay rw in all three: § 12 narrows the
// repository, not the agent's ability to work.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// TestMailRepoAccessReadOnlyRule is the decision itself, before any plan: only
// the asked side that no person has approved runs read-only.
func TestMailRepoAccessReadOnlyRule(t *testing.T) {
	cases := []struct {
		name   string
		access worker.MailRepoAccess
		want   bool
	}{
		{"asked turn", worker.MailRepoAccess{Asked: true}, true},
		{"asked turn, a person approved edits", worker.MailRepoAccess{Asked: true, EditsApproved: true}, false},
		{"normal chat", worker.MailRepoAccess{}, false},
		{"approved verdict in a chat nobody asked", worker.MailRepoAccess{EditsApproved: true}, false},
	}
	for _, c := range cases {
		if got := c.access.ReadOnlyRepo(); got != c.want {
			t.Errorf("%s: ReadOnlyRepo() = %v, want %v", c.name, got, c.want)
		}
	}
}

// unitForPreparedAccess prepares a unit with the given repository access and
// returns it with the spec its launch would have asked nono for.
func unitForPreparedAccess(t *testing.T, repoAccess string) (*worker.Unit, nono.LaunchSpec) {
	t.Helper()
	fx := newUnitFixture(t)
	req := fx.request()
	req.RepoAccess = repoAccess
	unit, err := fx.svc.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if unit.RepoAccess != repoAccess {
		t.Errorf("unit.RepoAccess = %q, want the request's %q recorded", unit.RepoAccess, repoAccess)
	}
	if _, err := unit.Verify(context.Background(), testLauncher()); err != nil {
		t.Fatalf("verify: %v", err)
	}
	specs := fx.sandbox.snapshotSpecs()
	if len(specs) != 1 {
		t.Fatalf("sandbox verifications = %d, want 1", len(specs))
	}
	return unit, specs[0]
}

// grantAccessOf finds the level a plan carries for a role, failing when the
// role appears at more than one level (which would be a plan whose journal
// cannot say what the kernel did).
func grantAccessOf(t *testing.T, plan wsgit.LaunchPlan, role string) (string, int) {
	t.Helper()
	levels := map[string]int{}
	for _, g := range plan.Grants {
		if g.Role == role {
			levels[g.Access()]++
		}
	}
	if len(levels) > 1 {
		t.Fatalf("role %s appears at %d levels (%v): one grant, one level", role, len(levels), levels)
	}
	for level, n := range levels {
		return level, n
	}
	return "", 0
}

func TestAskedTurnPlanMountsTheRepoReadOnly(t *testing.T) {
	unit, spec := unitForPreparedAccess(t, wsgit.AccessReadOnly)

	access, n := grantAccessOf(t, unit.Plan, wsgit.RoleCheckout)
	if n == 0 {
		t.Fatalf("grants = %+v, want a workspace_repo grant", unit.Plan.Grants)
	}
	if access != wsgit.AccessReadOnly {
		t.Errorf("workspace_repo access = %q, want %q (the mount is the read-only guarantee)", access, wsgit.AccessReadOnly)
	}
	if !unit.Plan.RepoReadOnly {
		t.Error("plan.RepoReadOnly false: the plan must record that it narrowed the repository, not just carry a narrower grant")
	}
	// The label the journal carries is the plan's, so this is the row the brief
	// asks proof of: sandbox.verified showing workspace_repo access ro.
	saw := false
	for _, label := range unit.Plan.Labels() {
		if label == wsgit.RoleCheckout+":"+wsgit.AccessReadOnly {
			saw = true
		}
	}
	if !saw {
		t.Errorf("labels = %v, want %s:%s", unit.Plan.Labels(), wsgit.RoleCheckout, wsgit.AccessReadOnly)
	}
	// The commit axis is withheld with the mount: the four mirror writes are how
	// a worktree's contents become a commit.
	for _, role := range []string{wsgit.RoleMirrorObjects, wsgit.RoleMirrorRef, wsgit.RoleMirrorReflog, wsgit.RoleWorktreeAdmin} {
		if _, n := grantAccessOf(t, unit.Plan, role); n != 0 {
			t.Errorf("commit-axis grant %s present on a read-only plan (CommitGranted = %v)", role, unit.Plan.CommitGranted)
		}
	}
	if unit.Plan.CommitGranted {
		t.Error("plan.CommitGranted true on a read-only plan: the journal would claim an axis the launch does not carry")
	}
	// P10: mirror_read stays. A read-only agent still has to be able to read
	// its own repository, which is the whole point of the asked turn.
	if mr, n := grantAccessOf(t, unit.Plan, wsgit.RoleMirrorRead); n == 0 || mr != wsgit.AccessReadOnly {
		t.Errorf("mirror_read = %q/%d, want ro present (without it every git command dies — probe P10)", mr, n)
	}
	// Scratch and HOME keep rw: § 12 narrows the repository, not the workspace.
	if sc, n := grantAccessOf(t, unit.Plan, wsgit.RoleScratch); n == 0 || sc != wsgit.AccessReadWrite {
		t.Errorf("workspace_scratch = %q/%d, want rw present", sc, n)
	}
	if hm, n := grantAccessOf(t, unit.Plan, wsgit.RoleAgentHome); n == 0 || hm != wsgit.AccessReadWrite {
		t.Errorf("workspace_home = %q/%d, want rw present (git aborts on an ungranted HOME — probe P6)", hm, n)
	}

	// And what the plan says is what nono is asked for: the checkout gets
	// --read, not --allow.
	argv, err := spec.BuildVerifyArgv()
	if err != nil {
		t.Fatalf("verify argv: %v", err)
	}
	joined := strings.Join(argv, " ")
	if want := "--read " + checkoutPathOf(t, unit); !strings.Contains(joined, want) {
		t.Errorf("argv = %q,\nwant it to grant the checkout read-only (%s)", joined, want)
	}
	if strings.Contains(joined, "--allow "+checkoutPathOf(t, unit)) {
		t.Errorf("argv grants the checkout read-write: %q", joined)
	}
	// The cwd is the read-only checkout (the agent works in the repo it was
	// asked about). Plan.Check admits that shape only because real nono keeps
	// a cwd inside a read grant — measured in mail_sandbox_nono_test.go.
	if unit.Plan.Cwd != checkoutPathOf(t, unit) {
		t.Errorf("cwd = %q, want the checkout %q", unit.Plan.Cwd, checkoutPathOf(t, unit))
	}
}

func TestApprovedOrOrdinaryTurnPlanKeepsTheRepoReadWrite(t *testing.T) {
	for _, name := range []string{"approved (rw asked away)", "ordinary conversation"} {
		t.Run(name, func(t *testing.T) {
			unit, spec := unitForPreparedAccess(t, "")
			access, n := grantAccessOf(t, unit.Plan, wsgit.RoleCheckout)
			if n == 0 || access != wsgit.AccessReadWrite {
				t.Errorf("workspace_repo = %q/%d, want rw", access, n)
			}
			if unit.Plan.RepoReadOnly {
				t.Error("plan.RepoReadOnly true: the plan would report a mount it does not have")
			}
			// The profile's commit axis is untouched on an ordinary turn.
			if _, n := grantAccessOf(t, unit.Plan, wsgit.RoleMirrorRef); n == 0 {
				t.Errorf("the commit axis vanished from an ordinary plan: %+v", unit.Plan.Grants)
			}
			argv, err := spec.BuildVerifyArgv()
			if err != nil {
				t.Fatalf("verify argv: %v", err)
			}
			if want := "--allow " + checkoutPathOf(t, unit); !strings.Contains(strings.Join(argv, " "), want) {
				t.Errorf("argv = %q, want the checkout read-write (%s)", strings.Join(argv, " "), want)
			}
		})
	}
}

// checkoutPathOf is the first repository's checkout — the path the plan's cwd
// and its workspace_repo grant name.
func checkoutPathOf(t *testing.T, unit *worker.Unit) string {
	t.Helper()
	if len(unit.Repos) == 0 {
		t.Fatal("the fixture prepared no repository")
	}
	return unit.Repos[0].CheckoutPath
}

// snapshotSpecs reads what the fixture's sandbox was asked to verify. Declared
// here (same package, new method) so the § 12 tests do not have to edit the
// shared fixture for a read.
func (f *fakeSandbox) snapshotSpecs() []nono.LaunchSpec {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]nono.LaunchSpec(nil), f.specs...)
}

// TestPlanCheckRefusesARepoAccessLevelThatWidens is the guard on the new field:
// a grant can be narrowed and never widened, so a caller cannot use
// AccessLevel to make mirror_read writable.
func TestPlanCheckRefusesARepoAccessLevelThatWidens(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	bad := unit.Plan
	bad.Grants = append([]wsgit.Grant(nil), unit.Plan.Grants...)
	for i := range bad.Grants {
		if bad.Grants[i].Role == wsgit.RoleMirrorRead {
			bad.Grants[i].AccessLevel = wsgit.AccessReadWrite
		}
	}
	err := bad.Check()
	if err == nil {
		t.Fatal("Check accepted a grant that asked to widen mirror_read to rw")
	}
	if !strings.Contains(err.Error(), "never widened") {
		t.Errorf("err = %v, want it to name the narrowing-only rule", err)
	}
}

// TestReadOnlyCwdRuleAdmitsOnlyTheRepositoryMount keeps § 12's cwd relaxation
// from becoming a general "read is enough" rule: the asked turn may start
// inside its own read-only repository, and nowhere else that happens to be
// granted read-only.
func TestReadOnlyCwdRuleAdmitsOnlyTheRepositoryMount(t *testing.T) {
	fx := newUnitFixture(t)
	req := fx.request()
	req.RepoAccess = wsgit.AccessReadOnly
	unit, err := fx.svc.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := unit.Plan.Check(); err != nil {
		t.Fatalf("the asked plan (cwd inside its read-only checkout) refused to launch: %v", err)
	}

	insideMirror := unit.Plan
	insideMirror.Cwd = filepath.Join(unit.Repos[0].MirrorPath, "objects")
	err = insideMirror.Check()
	if err == nil {
		t.Fatal("Check admitted a cwd inside mirror_read: § 12 narrowed the repository mount, it did not loosen the cwd rule")
	}
	if !strings.Contains(err.Error(), "outside every grant") {
		t.Errorf("err = %v, want the C-CWD refusal", err)
	}
}
