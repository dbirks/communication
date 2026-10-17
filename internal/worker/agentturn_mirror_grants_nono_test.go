package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The lab bug this pins was *observed*, not theoretical: the M4 lab's Claude
// agent reported "fatal: not a git repository" for every git command because
// the attempt-shaped grant set omitted RoleMirrorRead (probe P10: a linked
// worktree's .git file points into the mirror tree, and Landlock kills every
// git command when that read is missing). The unit pins in agentturn_test.go
// prove the plan ASKS for the grants; this measures that the asked-for set
// actually lets `git status` run under a real nono 0.80.0 launch on this
// host's Landlock — 12-test-strategy.md's rule that a mocked green test never
// substitutes for the real protocol/sandbox proof.

// attemptShapedGitStatus prepares a real linked-worktree workspace (mirror +
// worktree add, the § 4 step 3 shape built with real git), assembles the
// attempt grant set exactly as agentturn.go does, launches it under real nono
// and returns the child's exit error plus the marker file paths the shell
// writes to report what git did.
func TestAgentTurnAttemptMirrorGrantsLetRealGitStatusRun(t *testing.T) {
	bin, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono binary required for the real-sandbox run: %v", err)
	}
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skipf("git required: %v", err)
	}
	launcherHome := procExecScratch(t, "agentturn-mirror-launcher")
	launcher := &nono.Launcher{Binary: bin, Home: launcherHome}
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

	base := procExecScratch(t, "agentturn-mirror-nono")
	origin := filepath.Join(base, "origin")
	runGit := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command(gitBin, args...)
		cmd.Dir = dir
		if cmd.Dir == "" {
			cmd.Dir = base
		}
		cmd.Env = []string{"HOME=" + base, "PATH=/usr/local/bin:/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	// Origin with one commit, then the § 4 step 3 shape: mirror clone + linked
	// worktree on the run-scope branch.
	runGit("", "init", "-q", origin)
	if err := os.WriteFile(filepath.Join(origin, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(origin, "-c", "user.name=t", "-c", "user.email=t@invalid", "add", "-A")
	runGit(origin, "-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "-m", "seed")

	wsRoot := filepath.Join(base, "workspaces")
	layout, err := wsgit.LayoutOf(wsRoot, "run", fakeRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.Ensure(""); err != nil {
		t.Fatal(err)
	}
	mirror, err := wsgit.MirrorFor(filepath.Join(base, "repos"), fakeAttemptID, "app")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(mirror.Path), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit("", "clone", "--quiet", "--mirror", origin, mirror.Path)
	checkout := filepath.Join(layout.Repos, "app")
	runGit("", "--git-dir="+mirror.Path, "worktree", "add", "-b", fakeRunID+"/app", checkout, "HEAD")

	// The attempt-shaped plan: the three fixed grants agentturn.go has always
	// carried, plus the mirror axis it now carries, built by the SAME
	// attemptMirrorGrants the executor calls.
	buildPlan := func(withMirror bool) wsgit.LaunchPlan {
		plan := wsgit.LaunchPlan{
			WorkspaceID: "run/" + fakeRunID,
			Layout:      layout,
			Grants: []wsgit.Grant{
				{Role: wsgit.RoleCheckout, Path: layout.Repos},
				{Role: wsgit.RoleScratch, Path: layout.Scratch},
				{Role: wsgit.RoleAgentHome, Path: layout.Home},
			},
			LauncherHome: launcherHome,
			AgentHome:    layout.Home,
			Cwd:          layout.Repos,
		}
		if withMirror {
			g, err := attemptMirrorGrants(layout, []MaterializeRepo{{
				ID: "r1", Name: "app", CheckoutPath: checkout, MirrorPath: mirror.Path,
			}}, false)
			if err != nil {
				t.Fatal(err)
			}
			plan.Grants = append(plan.Grants, g...)
		}
		if err := plan.Check(); err != nil {
			t.Fatalf("plan.Check: %v", err)
		}
		return plan
	}
	prof, err := nono.WriteProfile(filepath.Join(base, "policy"), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	gitStatus := func(plan wsgit.LaunchPlan, marker string) error {
		handle, res, err := launcher.LaunchPlan(context.Background(), nono.LaunchSpec{
			Profile: prof, Plan: plan, LauncherHome: launcherHome,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "git -C " + checkout + " status && touch " + marker},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"},
		})
		if err != nil {
			return err
		}
		if !res.Verified {
			t.Fatal("launched without a verified chain")
		}
		return handle.Wait()
	}

	t.Run("with mirror_read: git status runs", func(t *testing.T) {
		marker := filepath.Join(layout.Scratch, "git-status-ok")
		if err := gitStatus(buildPlan(true), marker); err != nil {
			t.Fatalf("the attempt-shaped grant set could not run git status: %v", err)
		}
		if _, statErr := os.Stat(marker); statErr != nil {
			t.Errorf("git status exited clean but wrote no marker: %v", statErr)
		}
	})
	t.Run("without mirror_read: git status dies (P10's control)", func(t *testing.T) {
		marker := filepath.Join(layout.Scratch, "git-status-no-mirror")
		if err := gitStatus(buildPlan(false), marker); err == nil {
			if _, statErr := os.Stat(marker); statErr == nil {
				t.Fatal("git status SUCCEEDED without the mirror grant: the P10 premise (or this test) is wrong")
			}
		}
		if _, statErr := os.Stat(marker); statErr == nil {
			t.Errorf("git status reported success without the mirror grant: P10 regression")
		}
	})
}
