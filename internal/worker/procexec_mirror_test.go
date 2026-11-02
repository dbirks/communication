package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The lab's diffstat node (run 01a19bab, m4 probe pi-proof): the agent.acp
// attempt's plan carried ADR-0017 D4's mirror axis and its git worked; the
// process.exec attempt's plan did not, and its git died with exit 128 —
// "outside the business-outcome band", infra, with no reason anywhere. A
// linked worktree's .git file points into the bare mirror (objects/refs), so
// without the read grant ANY git command in a worktree workspace dies (probe
// P10). These pins hold the process.exec plan to the agent path's shape:
// mirror_read ro always, and never the commit axis.

// procExecMirrorFixture is a required-mode launch whose spec is captured
// without a kernel, with the § 4 step 3 wiring (workspace row + prepared
// repos) a real worktree workspace would carry.
func procExecMirrorFixture(t *testing.T, repos []MaterializeRepo) (*procExecFixture, *recordingSandbox, string) {
	t.Helper()
	f := newProcExecFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{result: &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion,
		PolicyRef: nono.ProfileCommand, PolicyDigest: "sha256:fake",
		AfUnixMediation: "pathname", NetworkEnforced: nono.NetworkDenied, Verified: true,
	}}
	f.proc.Sandbox = fake
	f.proc.SandboxPath = "/bin/echo" // echoes the nono argv and exits 0
	f.proc.Checkpoints = stubCheckpoints{}
	mirror := filepath.Join(f.root, "repos", "proj", "app.git")
	if err := os.MkdirAll(filepath.Join(mirror, "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mirror, "refs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if repos != nil {
		f.proc.Secrets = &agentSecretsStub{repos: repos}
	}
	return f, fake, mirror
}

// TestProcExecAttemptPlanGrantsTheMirrorReadForWorktreeWorkspaces: the
// process.exec grant set includes wsgit.MirrorGrants' read for every
// prepared repository — same role, same path, same read-only access as the
// agent.acp attempt — and never a commit-axis write.
func TestProcExecAttemptPlanGrantsTheMirrorReadForWorktreeWorkspaces(t *testing.T) {
	f, fake, mirror := procExecMirrorFixture(t, nil)
	f.proc.Secrets = &agentSecretsStub{repos: []MaterializeRepo{{
		ID: "repo-1", Name: "app",
		CheckoutPath: filepath.Join(f.layout.Repos, "app"),
		MirrorPath:   mirror,
	}}}
	res, err := f.proc.Execute(context.Background(), f.claim(execArgs("true")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded via the echo stand-in", res)
	}
	plan := fake.lastSpec().Plan
	if !hasGrant(plan.Grants, wsgit.RoleMirrorRead, mirror) {
		t.Errorf("grants = %+v, want a mirror_read grant on %s (P10: without it every git command in a worktree dies — the lab's diffstat exit 128)", plan.Grants, mirror)
	}
	for _, g := range plan.Grants {
		if g.Role == wsgit.RoleMirrorRead && g.Access() != wsgit.AccessReadOnly {
			t.Errorf("mirror_read access = %q, want %q (the mirror is never rw to a command)", g.Access(), wsgit.AccessReadOnly)
		}
	}
	// process.exec holds no commit axis: the four mirror writes must not
	// ride along, whatever the rows say.
	for _, role := range []string{wsgit.RoleMirrorObjects, wsgit.RoleMirrorRef, wsgit.RoleMirrorReflog, wsgit.RoleWorktreeAdmin} {
		if got := grantPaths(plan.Grants, role); len(got) != 0 {
			t.Errorf("commit-axis grant %s present on a process.exec plan: %v", role, got)
		}
	}
	// The pre-existing shape is untouched.
	if !hasGrant(plan.Grants, wsgit.RoleCheckout, f.layout.Repos) ||
		!hasGrant(plan.Grants, wsgit.RoleScratch, f.layout.Scratch) ||
		!hasGrant(plan.Grants, wsgit.RoleAgentHome, f.layout.Home) {
		t.Errorf("grants = %+v, want the checkout/scratch/home grants unchanged", plan.Grants)
	}
	// The journal says what the kernel was asked for: sandbox.verified
	// carries mirror_read:ro, matching the lab's agent-node row.
	verified := events.SandboxVerifiedPayload{}
	found := false
	for _, ev := range f.sink.events {
		if ev.Type == events.TypeSandboxVerified {
			verified, found = ev.Payload.(events.SandboxVerifiedPayload), true
		}
	}
	if !found {
		t.Fatal("sandbox.verified missing from the journal")
	}
	want := events.SandboxGrant{Role: wsgit.RoleMirrorRead, Access: wsgit.AccessReadOnly}
	saw := false
	for _, g := range verified.Grants {
		if g.Role == want.Role && g.Access == want.Access {
			saw = true
		}
	}
	if !saw {
		t.Errorf("sandbox.verified grants = %+v, want %+v", verified.Grants, want)
	}
}

// TestProcExecAttemptWithoutPreparedReposCarriesNoMirrorGrant: the honest
// degradation the agent path set — no run workspace row or no repos known
// means no mirror grant, visibly, never an invented path.
func TestProcExecAttemptWithoutPreparedReposCarriesNoMirrorGrant(t *testing.T) {
	t.Run("secrets unwired", func(t *testing.T) {
		f, fake, _ := procExecMirrorFixture(t, nil)
		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("true")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want the pre-mirror-axis attempt shape to still succeed", res)
		}
		if got := grantPaths(fake.lastSpec().Plan.Grants, wsgit.RoleMirrorRead); len(got) != 0 {
			t.Errorf("mirror_read granted with no Secrets seam: %v", got)
		}
	})
	t.Run("repository-free workspace", func(t *testing.T) {
		f, fake, _ := procExecMirrorFixture(t, []MaterializeRepo{})
		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("true")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded", res)
		}
		if got := grantPaths(fake.lastSpec().Plan.Grants, wsgit.RoleMirrorRead); len(got) != 0 {
			t.Errorf("mirror_read granted with no prepared repositories: %v", got)
		}
	})
}

// TestProcExecUnableToStartDetailCarriesStderrTail: git 128 can still happen
// (a corrupt object store, a refused safe.directory, an unreadable gitfile).
// The band alone was diagnosable for nobody, so the attempt detail now names
// git's own last words — host roots redacted, bounded, and secret-swept by
// the same redactResult that already covers every other detail.
func TestProcExecUnableToStartDetailCarriesStderrTail(t *testing.T) {
	f := newProcExecFixture(t, domain.EnforceDisabled)
	f.proc.Checkpoints = stubCheckpoints{}
	body := `echo 'fatal: not a git repository: object directory is unreadable' >&2; exit 128`
	res, err := f.proc.Execute(context.Background(), f.claim(shScript(body)), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("res = %+v, want failed/infra", res)
	}
	if !strings.Contains(res.Detail, "object directory is unreadable") {
		t.Errorf("detail = %q, want git's stderr tail in it", res.Detail)
	}
	if !strings.Contains(res.Detail, "exited 128") {
		t.Errorf("detail = %q, want the exit code kept beside the tail", res.Detail)
	}

	// The tail is redacted like every other surface: the workspace root
	// never rides into the attempt detail.
	f2 := newProcExecFixture(t, domain.EnforceDisabled)
	f2.proc.Checkpoints = stubCheckpoints{}
	body2 := `echo "fatal: cannot open ` + filepath.Join(f2.proc.WorkspaceRoot, "work/repos/app/objects") + `" >&2; exit 128`
	res2, err := f2.proc.Execute(context.Background(), f2.claim(shScript(body2)), f2.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if strings.Contains(res2.Detail, f2.proc.WorkspaceRoot) {
		t.Errorf("detail leaks the workspace root: %q", res2.Detail)
	}
	if !strings.Contains(res2.Detail, "<host-root>") {
		t.Errorf("detail = %q, want the <host-root> redaction in the tail", res2.Detail)
	}
}

// TestProcExecUnderRealNonoGitRunsInWorktreeWithMirrorGrant is the real
// kernel proof of the fix: a process.exec command built by the executor —
// grants assembled exactly as executeAttempt now assembles them — runs
// `git status` in a real linked worktree under real nono 0.80.0 on this
// host's Landlock. The agent path's control pair (no mirror_read: git dies)
// lives in agentturn_mirror_grants_nono_test.go; this pins that the
// process.exec shape is the one that lets git live.
func TestProcExecUnderRealNonoGitRunsInWorktreeWithMirrorGrant(t *testing.T) {
	bin, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono binary required for the real-sandbox run: %v", err)
	}
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skipf("git required: %v", err)
	}
	f := newProcExecFixture(t, domain.EnforceRequired)
	launcher := &nono.Launcher{Binary: bin, Home: procExecScratch(t, "procexec-mirror-launcher")}
	caps, err := launcher.Probe(context.Background())
	if err != nil {
		t.Skipf("nono probe: %v", err)
	}
	if caps.Version != nono.PinnedVersion {
		t.Skipf("nono %s pinned, host has %s", nono.PinnedVersion, caps.Version)
	}
	if !caps.Filesystem {
		t.Skipf("no observed Landlock filesystem support (%v): nothing may depend on an unproven sandbox", caps.Notes)
	}
	f.proc.Sandbox = launcher
	f.proc.SandboxPath = bin
	f.proc.Checkpoints = stubCheckpoints{}

	base := f.root
	runGit := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command(gitBin, args...)
		if dir != "" {
			cmd.Dir = dir
		}
		cmd.Env = []string{"HOME=" + base, "PATH=/usr/local/bin:/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	// The § 4 step 3 shape built with real git: origin, mirror clone, linked
	// worktree on the run-scope branch.
	origin := filepath.Join(base, "origin")
	runGit("", "init", "-q", origin)
	if err := os.WriteFile(filepath.Join(origin, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(origin, "-c", "user.name=t", "-c", "user.email=t@invalid", "add", "-A")
	runGit(origin, "-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "-m", "seed")
	mirror := filepath.Join(base, "repos", "proj", "app.git")
	if err := os.MkdirAll(filepath.Dir(mirror), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit("", "clone", "--quiet", "--mirror", origin, mirror)
	checkout := filepath.Join(f.layout.Repos, "app")
	runGit("", "--git-dir="+mirror, "worktree", "add", "-b", fakeRunID+"/app", checkout, "HEAD")

	f.proc.Secrets = &agentSecretsStub{repos: []MaterializeRepo{{
		ID: "repo-1", Name: "app", CheckoutPath: checkout, MirrorPath: mirror,
	}}}

	marker := filepath.Join(f.layout.Scratch, "procexec-git-status-ok")
	res, err := f.proc.Execute(context.Background(), f.claim(shScript(
		"git -C "+checkout+" status && touch "+marker)), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want the sandboxed command's git status to run under the executor-built grant set", res)
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Errorf("git status exited clean but wrote no marker: %v", statErr)
	}
	// And the journal recorded the grant the kernel enforced.
	sawMirrorRead := false
	for _, ev := range f.sink.events {
		if v, ok := ev.Payload.(events.SandboxVerifiedPayload); ok {
			for _, g := range v.Grants {
				if g.Role == wsgit.RoleMirrorRead && g.Access == wsgit.AccessReadOnly {
					sawMirrorRead = true
				}
			}
		}
	}
	if !sawMirrorRead {
		t.Error("sandbox.verified did not record the mirror_read grant the real launch carried")
	}
}
