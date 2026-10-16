package nono_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// These tests drive the real nono binary against a real prepared workspace.
// There is no fake that can answer the question they ask — whether the
// verification chain passes on a launch that will actually work — and a mocked
// green sandbox test is explicitly not evidence in this repository
// (AGENTS.md, 12-test-strategy.md). They skip when the precondition is absent
// and say which one, rather than passing quietly.

const (
	fixtureProject = "11111111-1111-4111-8111-111111111111"
	fixtureConv    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	fixtureRepo    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type lab struct {
	root       string
	mgr        *wsgit.Manager
	prep       *wsgit.PreparedWorkspace
	vols       map[string]wsgit.Volume
	launcher   string
	origin     string
	otherProj  string
	skipReason string
}

func newLab(t *testing.T) *lab {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git missing: %v", err)
	}
	if _, err := exec.LookPath(nonobin()); err != nil {
		t.Skipf("nono missing: %v", err)
	}
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home for lab scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-sandbox")
	}
	if err := wsgit.RefuseTempPath(base); err != nil {
		t.Skipf("lab scratch %s refused as a workspace root: %v", base, err)
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	// t.Name() of a subtest contains "/", which MkdirTemp rejects as a pattern.
	dir, err := os.MkdirTemp(base, strings.ReplaceAll(t.Name(), "/", "-")+"-")
	if err != nil {
		t.Fatalf("lab scratch under %s: %v", base, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	l := &lab{root: dir, launcher: filepath.Join(dir, "launcher-home")}
	for _, d := range []string{"workspaces", "repos", l.launcher} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// A git identity for the fixture and for the sandboxed commits, kept out of
	// the developer's global config.
	t.Setenv("GIT_AUTHOR_NAME", "communication-test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@communication.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "communication-test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@communication.invalid")

	seed := filepath.Join(dir, "origin")
	runGit(t, "", "init", "-q", "-b", "main", seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("# fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "-A")
	runGit(t, seed, "commit", "-qm", "seed")
	l.origin = "file://" + seed

	mgr, err := wsgit.NewManager(filepath.Join(dir, "workspaces"), filepath.Join(dir, "repos"),
		&wsgit.Runner{Home: l.launcher})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	l.mgr = mgr
	l.vols, err = mgr.Measure()
	if err != nil {
		t.Fatalf("Measure: %v", err)
	}
	l.prep, err = mgr.Prepare(context.Background(), wsgit.PrepareRequest{
		ScopeKind: "conversation", ScopeID: fixtureConv, ProjectID: fixtureProject,
		WorkspaceVolumeID: l.vols[wsgit.RootKindWorkspaces].ID,
		MirrorVolumeID:    l.vols[wsgit.RootKindRepos].ID,
		Repos:             []wsgit.RepoSpec{{RepositoryID: fixtureRepo, Name: "backend", GitURL: l.origin, DefaultBranch: "main"}},
		ExcludedPaths:     []string{".env.test.local"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// A second project's mirror tree, for the cross-project denial assertion
	// (case 11) — the shape the M3 exit gate is about.
	l.otherProj = filepath.Join(dir, "repos", "22222222-2222-4222-8222-222222222222")
	if err := os.MkdirAll(filepath.Join(l.otherProj, "backend.git", "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.otherProj, "backend.git", "objects", "theirs"), []byte("not yours\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The agent's seeded gitconfig: probe P6 makes an unusable HOME fatal for
	// git, so the sandboxed commit needs it inside its own grant.
	cfg := filepath.Join(l.prep.Layout.Home, ".gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = sandboxed agent\n\temail = agent@communication.invalid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return l
}

func nonobin() string {
	if v := os.Getenv("M3_NONO"); v != "" {
		return v
	}
	return "nono"
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-c", "safe.directory=*"}, args...)
	cmd := exec.Command("git", full...) //nolint:gosec // test fixture argv
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (l *lab) plan(t *testing.T) wsgit.LaunchPlan {
	t.Helper()
	p, err := wsgit.Plan(l.prep, wsgit.PlanOptions{WorkspaceID: "ws-fixture", CommitGranted: true, LauncherHome: l.launcher})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return p
}

func (l *lab) profileDir() string { return filepath.Join(l.root, "policies") }

// TestProfileIsAcceptedByNono is N-b against the file we actually ship, plus the
// digest and structural assertions the adapter relies on.
func TestProfileIsAcceptedByNono(t *testing.T) {
	l := newLab(t)
	for _, kind := range []string{nono.ProfileAgentTurn, nono.ProfileEgressDenied} {
		prof, err := nono.WriteProfile(l.profileDir(), kind)
		if err != nil {
			t.Fatalf("WriteProfile(%s): %v", kind, err)
		}
		if err := prof.AssertOwnBytes(); err != nil {
			t.Errorf("profile %s fails our own assertions: %v", kind, err)
		}
		t.Logf("%s: %s (%s)", kind, prof.Digest, prof.Path)

		cmd := exec.Command(nonobin(), "profile", "validate", prof.Path) //nolint:gosec
		cmd.Env = append(os.Environ(), "HOME="+l.launcher)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Errorf("nono rejected the profile we authored (%s): %v\n%s", kind, err, out)
		}
		if !strings.Contains(string(out), "Result: valid") {
			t.Errorf("nono did not report the profile valid (%s): %s", kind, out)
		}
		show := exec.Command(nonobin(), "profile", "show", prof.Path) //nolint:gosec
		show.Env = append(os.Environ(), "HOME="+l.launcher)
		showOut, err := show.CombinedOutput()
		if err != nil {
			t.Errorf("nono profile show failed: %v\n%s", err, showOut)
		}
		if !strings.Contains(string(showOut), "AF_UNIX mediation: Pathname") {
			t.Errorf("profile show does not report Pathname mediation (%s): %s", kind, showOut)
		}
	}
}

// TestProfileTamperIsRefused covers C-FC2b's consequence: nono accepts and hides
// an `external` policy, so the adapter has to catch it from its own bytes.
func TestProfileTamperIsRefused(t *testing.T) {
	l := newLab(t)
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(prof.Path)
	if err != nil {
		t.Fatal(err)
	}
	// The tampering is JSON-aware: the profile is emitted with indentation, and
	// a string replace that happens to miss would make this test pass by
	// proving nothing — the loudest kind of green.
	mutate := []struct {
		name   string
		fn     func(map[string]any)
		expect string
	}{
		{"external policy", func(p map[string]any) { p["linux"].(map[string]any)["sandbox_policy"] = "external" }, "external"},
		{"no af_unix", func(p map[string]any) { p["linux"].(map[string]any)["af_unix_mediation"] = "off" }, "af_unix"},
		{"temp group back in", func(p map[string]any) { p["groups"] = map[string]any{"exclude": []any{}} }, "system_write_linux"},
		{"host-conditional group back in", func(p map[string]any) {
			p["groups"] = map[string]any{"exclude": []any{"system_write_linux", "system_write_macos", "homebrew_linux", "homebrew_macos"}}
		}, "host-conditional"},
		{"undeclared exclusion added", func(p map[string]any) {
			p["groups"] = map[string]any{"exclude": append(nono.ExcludedGroups(), "system_read_linux_core")}
		}, "pinned"},
		{"system git config read dropped", func(p map[string]any) {
			p["filesystem"].(map[string]any)["read_file"] = []any{}
		}, "/etc/gitconfig"},
		{"system git config read widened to an unreviewed file", func(p map[string]any) {
			fs := p["filesystem"].(map[string]any)
			fs["read_file"] = append(fs["read_file"].([]any), "/etc/shadow")
		}, "/etc/shadow"},
		{"device re-grant dropped", func(p map[string]any) { p["filesystem"].(map[string]any)["write_file"] = []any{"/dev/not-there"} }, "/dev/null"},
		{"wrong profile name", func(p map[string]any) { p["meta"].(map[string]any)["name"] = "someone-elses-profile" }, "name"},
		{"no default layer", func(p map[string]any) { p["extends"] = "" }, "extends"},
	}
	for _, tamper := range mutate {
		var body map[string]any
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatalf("the shipped profile does not decode: %v", err)
		}
		tamper.fn(body)
		badBytes, err := json.MarshalIndent(body, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		bad := append(badBytes, '\n')
		if bytes.Equal(bad, data) {
			t.Fatalf("tamper %q produced no change: the mutation is not reaching the file", tamper.name)
		}
		path := filepath.Join(l.root, "tampered-"+strings.ReplaceAll(tamper.name, " ", "-")+".json")
		if err := os.WriteFile(path, bad, 0o444); err != nil {
			t.Fatal(err)
		}
		// The tampered file carries its own digest: with the *original* digest,
		// every tamper is caught by the digest check alone and the specific
		// semantic assertion below never runs. WriteProfile already proves the
		// digest check fires on a changed file; here we want the reason.
		tampered := &nono.Profile{Kind: prof.Kind, Path: path, Digest: nono.DigestProfile(bad), NetworkEnforced: prof.NetworkEnforced}
		if err := tampered.AssertOwnBytes(); err == nil {
			t.Errorf("tampering %s was not refused", tamper.name)
		} else if !strings.Contains(err.Error(), "sandbox:") {
			t.Errorf("tamper %s produced an unexpected error shape: %v", tamper.name, err)
		} else if !strings.Contains(err.Error(), tamper.expect) {
			t.Errorf("tamper %s was refused for the wrong reason (%q not in: %v)", tamper.name, tamper.expect, err)
		}
		// And nono itself must not be trusted to notice: C-FC2b measured that it
		// does not. This assertion records that fact against the current binary.
		if tamper.name == "external policy" {
			cmd := exec.Command(nonobin(), "profile", "validate", path) //nolint:gosec
			cmd.Env = append(os.Environ(), "HOME="+l.launcher)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Logf("note: this nono build DOES reject an external profile (%s): nono's opinion has improved beyond probe C-FC2b", out)
			} else {
				t.Logf("probe C-FC2b re-confirmed: nono validates a profile whose policy is `external` — the adapter's own byte check is the only control")
			}
		}
	}
}

// TestVerifyChainPassesForARealWorkspace is N-a through N-d run end to end on a
// launch that is about to be real, with the grant labels the journal will carry.
func TestVerifyChainPassesForARealWorkspace(t *testing.T) {
	l := newLab(t)
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot establish a sandbox in this environment: %v", err)
	}

	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}
	spec := nono.LaunchSpec{
		Profile: prof, Plan: l.plan(t), LauncherHome: l.launcher,
		AdapterPath: "/bin/sh", AdapterArgs: []string{"-c", "true"},
		AdapterEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
	}
	res, err := launch.Verify(context.Background(), spec)
	if err != nil {
		var f *nono.Failure
		if errors.As(err, &f) {
			t.Fatalf("verification chain failed at %s (%s): %v", f.Stage, f.Reason, f.Err)
		}
		t.Fatalf("Verify: %v", err)
	}
	if !res.Verified {
		t.Fatal("Verify returned no error but Verified=false")
	}
	if res.Version != nono.PinnedVersion {
		t.Errorf("version = %s, want the pinned %s", res.Version, nono.PinnedVersion)
	}
	if res.AfUnixMediation != "pathname" {
		t.Errorf("AF_UNIX mediation = %q", res.AfUnixMediation)
	}
	if res.NetworkEnforced != nono.NetworkAllowlisted {
		t.Errorf("the agent-turn profile claims network=%q: since ADR-0035 its digest commits to the shipped egress allowlist, and a run whose file carries no host set is a different policy (open) with a different digest", res.NetworkEnforced)
	}
	// The profile's claim is not the run's: no audit read has happened, so the
	// only honest report is "open" + not enforced (design A's rule).
	if claim, enforced := res.EgressReport(); enforced || claim != string(nono.NetworkOpen) {
		t.Errorf("EgressReport without an observed denial = (%q, %v), want (%q, false)", claim, enforced, nono.NetworkOpen)
	}
	// The recorded labels must be exactly the plan's, and every one of them must
	// be a role the event schema knows.
	want := strings.Join(l.plan(t).Labels(), ",")
	got := labelsOf(res, l.plan(t))
	if got != want {
		t.Errorf("verified grant labels\n got %s\nwant %s", got, want)
	}
	for _, label := range strings.Split(got, ",") {
		role, access, ok := strings.Cut(label, ":")
		if !ok || !events.ValidGrantRole(role) || !events.ValidGrantAccess(access) {
			t.Errorf("sandbox.verified would carry %q, which the event schema rejects", label)
		}
	}
	t.Logf("verified: %s", res)
}

func labelsOf(res *nono.VerificationResult, plan wsgit.LaunchPlan) string {
	byPath := map[string]string{}
	for _, g := range plan.Grants {
		byPath[filepath.Clean(g.Path)] = g.Label()
	}
	var out []string
	for _, p := range res.GrantedPaths {
		if label, ok := byPath[filepath.Clean(p)]; ok {
			out = append(out, label)
		}
	}
	return strings.Join(sortedStrings(out), ",")
}

func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// newLabNonoWorks asks the binary whether it can enforce here at all, so a host
// without Landlock skips instead of failing the suite with a message about
// grants. The probe's own wording is returned for the skip reason.
func newLabNonoWorks(t *testing.T, l *lab) error {
	t.Helper()
	cmd := exec.Command(nonobin(), "setup", "--check-only", "-v") //nolint:gosec
	cmd.Env = append(os.Environ(), "HOME="+l.launcher)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, firstLineOf(string(out)))
	}
	if !strings.Contains(string(out), "Filesystem ruleset creation verified") {
		return fmt.Errorf("no verified filesystem ruleset: %s", firstLineOf(string(out)))
	}
	return nil
}

func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// TestVerifyChainFailsClosedOnEveryFailOpenShape is the required-mode contract:
// each shape that has been observed to fail open gets an assertion, and each
// assertion is exercised against the real binary.
func TestVerifyChainFailsClosedOnEveryFailOpenShape(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}

	type testCase struct {
		name       string
		mutate     func(*nono.LaunchSpec)
		wantStage  string
		wantReason string
	}
	for _, tc := range []testCase{
		{
			name: "cwd outside the grants",
			// C-CWD: nono will not refuse this in profile mode, so the adapter
			// must, and must say which probe it is refusing on account of.
			mutate:     func(s *nono.LaunchSpec) { s.Plan.Cwd = l.prep.Layout.Meta },
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name: "a grant path that does not exist",
			mutate: func(s *nono.LaunchSpec) {
				s.Plan.Grants = append(s.Plan.Grants, wsgit.Grant{Role: wsgit.RoleScratch, Path: filepath.Join(l.root, "no-such-dir")})
			},
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name: "a /tmp grant",
			mutate: func(s *nono.LaunchSpec) {
				s.Plan.Grants = append(s.Plan.Grants, wsgit.Grant{Role: wsgit.RoleScratch, Path: "/tmp"})
			},
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name:       "nono's HOME inside a grant",
			mutate:     func(s *nono.LaunchSpec) { s.LauncherHome = filepath.Join(l.prep.Layout.Home, "nono") },
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name:       "a deny list under required",
			mutate:     func(s *nono.LaunchSpec) { s.Plan.DeniedPaths = []string{"/etc"} },
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name:       "no grants at all",
			mutate:     func(s *nono.LaunchSpec) { s.Plan.Grants = nil },
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
		{
			name:       "--block-net under the agent-turn profile",
			mutate:     func(s *nono.LaunchSpec) { s.BlockNet = true },
			wantStage:  nono.StageGrantAssert,
			wantReason: "grant_mismatch",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := nono.LaunchSpec{
				Profile: prof, Plan: l.plan(t), LauncherHome: l.launcher,
				AdapterPath: "/bin/sh", AdapterArgs: []string{"-c", "true"},
				AdapterEnv: []string{"PATH=/usr/bin:/bin"},
			}
			tc.mutate(&spec)
			res, err := launch.Verify(context.Background(), spec)
			if err == nil {
				t.Fatalf("the chain accepted a launch it must refuse (%s); verified=%v", tc.name, res.Verified)
			}
			var f *nono.Failure
			if !errors.As(err, &f) {
				t.Fatalf("error is not a *nono.Failure: %T %v", err, err)
			}
			if f.Stage != tc.wantStage || f.Reason != tc.wantReason {
				t.Errorf("refused at %s/%s, want %s/%s (%v)", f.Stage, f.Reason, tc.wantStage, tc.wantReason, f.Err)
			}
			if res.Verified {
				t.Error("a refused chain reported Verified=true")
			}
			if !events.ValidSandboxStage(f.Stage) || !events.ValidSandboxFailureReason(f.Reason) {
				t.Errorf("sandbox.enforcement_failed would carry stage=%q reason=%q, which the schema rejects", f.Stage, f.Reason)
			}
		})
	}
}

// TestSandboxedGitCommitWritesOnlyItsOwnRef is the commit axis measured, not
// assumed: the agent's `git commit` must land on its run ref, must not reach
// another project's mirror or the exclusion file, and must leave the worktree
// HEAD where the commit put it.
//
// This is the behaviour ADR-0017 D4's four-path grant set exists to produce,
// and the reason probe P4/P7/P8 were run: a reflog directory git has not
// pre-created, or an admin dir nobody read back, fails at *commit* time — after
// the agent did the work.
func TestSandboxedGitCommitWritesOnlyItsOwnRef(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	plan := l.plan(t)
	checkout := l.prep.Repos[0].CheckoutPath
	mirror := l.prep.Repos[0].MirrorPath

	// The agent makes a change in its checkout.
	if err := os.WriteFile(filepath.Join(checkout, "agent-edit.txt"), []byte("written before the sandbox\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}
	// One shell doing what an agent's `git add -A && git commit` does, with the
	// agent's HOME applied through the env hop (C-H1c: nono execs directly, so
	// there is no other way to set the child's HOME).
	spec := nono.LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: l.launcher,
		AdapterPath: "/bin/sh",
		AdapterArgs: []string{"-c", "git add -A && git commit -q -m 'sandboxed commit' && git rev-parse HEAD && echo COMMITTED"},
		AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"},
	}
	handle, res, err := launch.LaunchPlan(context.Background(), spec)
	if err != nil {
		var f *nono.Failure
		if errors.As(err, &f) {
			t.Fatalf("launch refused at %s (%s): %v", f.Stage, f.Reason, f.Err)
		}
		t.Fatalf("LaunchPlan: %v", err)
	}
	if !res.Verified {
		t.Error("launched without a verified chain")
	}
	if !res.ChildStarted {
		t.Error("child_started=false after a successful exec: case 13 asks whether a process ever ran")
	}
	waitErr := handle.Wait()
	out := captured(handle)
	stdout, stderr := streamsOf(handle)
	// Both streams are named and an empty one says so: CI run 38759216292 read
	// as "empty child output" when only stdout was empty — git never ran, and
	// the fatal that named the cause (/etc/gitconfig unreadable, probe C-GITCFG)
	// was in the stderr continuation lines of a merged log line.
	t.Logf("child stdout:\n%s\nchild stderr:\n%s\n(wait=%v)", stdout, stderr, waitErr)
	if waitErr != nil {
		t.Fatalf("the sandboxed commit failed: %v\nstdout:\n%s\nstderr:\n%s", waitErr, stdout, stderr)
	}
	if !strings.Contains(out, "COMMITTED") {
		t.Fatalf("the child never reported committing: %s", out)
	}

	// The proof is the ref read afterwards, not the exit status: probe P8 saw a
	// commit that printed `packed-refs.lock: Permission denied` and still
	// succeeded, and another that exited non-zero having done nothing.
	head := runGit(t, "", "--git-dir="+mirror, "rev-parse", "refs/heads/"+fixtureConv+"/backend")
	if len(head) != 40 {
		t.Fatalf("the run ref does not exist after the commit: %q", head)
	}
	if !strings.Contains(out, head) {
		t.Errorf("the child reported HEAD that disagrees with the ref read: ref=%s child=%s", head, firstLineOf(out))
	}
	if got := runGit(t, "", "--git-dir="+mirror, "log", "-1", "--format=%s", head); got != "sandboxed commit" {
		t.Errorf("run ref head message = %q", got)
	}

	t.Run("the reflog exists because the worker pre-created it", func(t *testing.T) {
		logs := filepath.Join(mirror, "logs", "refs", "heads", fixtureConv, "backend")
		data, err := os.ReadFile(logs)
		if err != nil {
			t.Fatalf("no reflog at %s (probe P7: git cannot mkdir through a leaf-only grant): %v", logs, err)
		}
		if !strings.Contains(string(data), "commit:") {
			t.Errorf("reflog does not record the commit: %s", data)
		}
	})

	t.Run("another project's mirror stayed closed", func(t *testing.T) {
		// Case 11's shape: same uid, different project, and the sandbox is what
		// separates them (ADR-0017's own limitation note is explicit that this
		// is not tenant isolation).
		target := filepath.Join(l.otherProj, "backend.git", "objects", "theirs")
		if err := os.WriteFile(filepath.Join(checkout, "probe.sh"), []byte("#!/bin/sh\ncat \""+target+"\"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		spec := nono.LaunchSpec{
			Profile: prof, Plan: plan, LauncherHome: l.launcher,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "cat " + target + " 2>&1; echo rc=$?"},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, _, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			t.Fatalf("launch: %v", err)
		}
		_ = h.Wait()
		got := captured(h)
		if strings.Contains(got, "not yours") {
			t.Errorf("the sandboxed child read another project's mirror: %s", got)
		}
		if !strings.Contains(got, "Permission denied") {
			t.Errorf("expected an EACCES on the cross-project path, got: %s", got)
		}
	})

	t.Run("the metadata sibling is unreachable", func(t *testing.T) {
		metaFile := filepath.Join(l.prep.Layout.Meta, "workspace.json")
		if err := os.WriteFile(metaFile, []byte(`{"worker_id":"w"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		spec := nono.LaunchSpec{
			Profile: prof, Plan: plan, LauncherHome: l.launcher,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "cat " + metaFile + " 2>&1; echo w > " + filepath.Join(l.prep.Layout.Meta, "agent-written") + " 2>&1; ls " + l.prep.Layout.Meta + " 2>&1"},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, _, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			t.Fatalf("launch: %v", err)
		}
		_ = h.Wait()
		got := captured(h)
		if strings.Contains(got, "worker_id") {
			t.Errorf("deviation D13 is false: the sandboxed child read worker metadata through the grant set: %s", got)
		}
		if _, err := os.Stat(filepath.Join(l.prep.Layout.Meta, "agent-written")); err == nil {
			t.Error("the sandboxed child wrote into meta/ — probe C-META's failure is back")
		}
	})

	t.Run("the exclusion file cannot be cleared", func(t *testing.T) {
		// X4's consequence: an agent that could edit <mirror>/info/exclude could
		// un-hide a materialized secret from `git status`.
		spec := nono.LaunchSpec{
			Profile: prof, Plan: plan, LauncherHome: l.launcher,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "echo p >> " + filepath.Join(mirror, "info", "exclude") + " 2>&1; echo rc=$?"},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, _, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			t.Fatalf("launch: %v", err)
		}
		_ = h.Wait()
		if got := captured(h); strings.Contains(got, "rc=0") {
			t.Errorf("the agent appended to the project exclusion file: %s", got)
		}
	})

	t.Run("without the commit grant the same command fails", func(t *testing.T) {
		// The axis is real: commit_granted=false must produce a refusal, not a
		// quieter commit.
		if err := os.WriteFile(filepath.Join(checkout, "second-edit.txt"), []byte("no grant\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		noCommit, err := wsgit.Plan(l.prep, wsgit.PlanOptions{WorkspaceID: "ws-fixture", CommitGranted: false, LauncherHome: l.launcher})
		if err != nil {
			t.Fatalf("Plan without commit: %v", err)
		}
		spec := nono.LaunchSpec{
			Profile: prof, Plan: noCommit, LauncherHome: l.launcher,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "git add -A && git commit -q -m 'should not land' && echo COMMITTED || echo DENIED"},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, res, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			var f *nono.Failure
			if errors.As(err, &f) {
				// Refusing to launch at all is a legitimate outcome for a
				// commit-less plan (the grant set is narrower, and a chain that
				// cannot name the paths git needs must not exec). What may not
				// happen is the commit landing.
				t.Logf("commit-less plan refused before exec at %s (%s): %v", f.Stage, f.Reason, f.Err)
				return
			}
			t.Fatalf("launch: %v", err)
		}
		_ = h.Wait()
		t.Logf("commit-denied chain: %s", res)
		if got := captured(h); strings.Contains(got, "COMMITTED") {
			t.Errorf("a commit landed with commit_granted=false: %s", got)
		}
	})
}

// TestSystemGitConfigIsReadableInsideTheSandbox is probe C-GITCFG's regression.
// CI run 38759216292 failed the commit test above with
//
//	warning: unable to access '/etc/gitconfig': Permission denied
//	fatal: unknown error occurred while reading the configuration files
//
// because git treats a system config file that exists but cannot be read as
// fatal, while one that is merely absent (ENOENT) is skipped. The grant, the
// level it must resolve at, and the child actually reading the file are all
// measured here rather than assumed. A host that ships no such file (the lab's
// Arch host, and the worker image, which installs git without git-lfs — the
// only Debian packaging that writes /etc/gitconfig) has nothing to read, and
// says so instead of passing vacuously.
func TestSystemGitConfigIsReadableInsideTheSandbox(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	if err := prof.AssertOwnBytes(); err != nil {
		t.Fatalf("the shipped profile does not carry the system config read: %v", err)
	}
	plan := l.plan(t)
	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}

	for _, path := range nono.SystemConfigReads() {
		if _, err := os.Stat(path); err != nil {
			t.Logf("%s does not exist on this host (%v): git skips an absent system config file, so there is nothing to read here — the grant exists for hosts that ship the file, which is what the GitHub runner image does via git-lfs's `git lfs install --system`", path, err)
			continue
		}
		// N-d's own view: the rule must resolve read-only and from the profile
		// layer, never as a per-run [user] grant of a wider directory.
		matched := 0
		for _, line := range dryRunRules(t, prof.Path, l.launcher, nono.GrantFlags(plan)) {
			if !strings.Contains(line, path) {
				continue
			}
			matched++
			t.Logf("resolved rule: %s", line)
			if want := "r " + path; !strings.HasPrefix(line, want) {
				t.Errorf("%s resolved as %q, want the read-only grant (%s…): a system file is never writable inside the sandbox", path, line, want)
			}
		}
		if matched == 0 {
			t.Errorf("%s exists on this host but no resolved grant rule names it, so the sandboxed child cannot read it (probe C-GITCFG: git exits 128 on an unreadable-but-present system config)", path)
		}

		spec := nono.LaunchSpec{
			Profile: prof, Plan: plan, LauncherHome: l.launcher,
			AdapterPath: "/bin/sh",
			AdapterArgs: []string{"-c", "cat " + path + " >/dev/null 2>read-err.txt; echo rc=$?; cat read-err.txt"},
			AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, _, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			t.Fatalf("launch: %v", err)
		}
		_ = h.Wait()
		got := captured(h)
		if !strings.Contains(got, "rc=0") {
			t.Errorf("the sandboxed child could not read %s: %s", path, got)
		}
	}
}

// TestSandboxDeniesTheSystemGitConfigWithoutTheGrant is the control that makes
// TestSystemGitConfigIsReadableInsideTheSandbox mean something: the same
// sandboxed `cat` is measured against a policy with the read_file entry and one
// without it, so the passing case cannot be an artifact of the host having left
// /etc/gitconfig world-readable to sandboxed processes anyway. The stripped
// policy is launched by exec'ing nono directly — the adapter itself refuses
// that file (AssertOwnBytes pins the read list), which the negative-control run
// in docs/compatibility/M3-PROBES.md records.
func TestSandboxDeniesTheSystemGitConfigWithoutTheGrant(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	for i, path := range nono.SystemConfigReads() {
		if _, err := os.Stat(path); err != nil {
			t.Logf("%s does not exist on this host (%v): the control has nothing to deny", path, err)
			continue
		}
		prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(prof.Path)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatal(err)
		}
		body["filesystem"].(map[string]any)["read_file"] = []any{}
		stripped, err := json.MarshalIndent(body, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		// One stripped policy per path: the read list carries several files
		// since ADR-0033, and a reused name would hit the sealed 0444 bytes of
		// the previous iteration.
		path0 := filepath.Join(l.root, fmt.Sprintf("no-system-config-read-%d.json", i))
		if err := os.WriteFile(path0, append(stripped, '\n'), 0o444); err != nil {
			t.Fatal(err)
		}

		flags := nono.GrantFlags(l.plan(t))
		for _, tc := range []struct {
			name, profile, want string
		}{
			{"without the profile grant", path0, "rc=1"},
			{"with the profile grant", prof.Path, "rc=0"},
		} {
			args := append([]string{"run", "-s", "-p", tc.profile}, flags...)
			args = append(args, "--", "env", "HOME="+l.prep.Layout.Home, "/bin/sh",
				"-c", "cat "+path+" >/dev/null 2>&1; echo rc=$?")
			cmd := exec.Command(nonobin(), args...) //nolint:gosec // test argv
			cmd.Dir = l.prep.Repos[0].CheckoutPath
			cmd.Env = append(os.Environ(), "HOME="+l.launcher)
			out, err := cmd.CombinedOutput()
			got := string(out) + fmt.Sprintf(" (rc err=%v)", err)
			if !strings.Contains(got, tc.want) {
				t.Errorf("%s: expected %s reading %s inside the sandbox, got: %s", tc.name, tc.want, path, got)
			}
			t.Logf("%s: %s", tc.name, strings.Join(strings.Fields(got), " "))
		}
	}
}

// dryRunRules returns the rule lines a verbose dry-run prints, whitespace
// collapsed. The source-tag regex is the one hostgroups_test.go duplicates on
// purpose, so this measures nono's output rather than the adapter's parser.
func dryRunRules(t *testing.T, profPath, launcherHome string, flags []string) []string {
	t.Helper()
	args := append([]string{"run", "-p", profPath, "-v", "--dry-run"}, flags...)
	args = append(args, "--", "sh", "-c", "true")
	cmd := exec.Command(nonobin(), args...) //nolint:gosec // test argv
	cmd.Env = append(os.Environ(), "HOME="+launcherHome)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("nono verbose dry-run failed: %v\n%s", err, out)
	}
	var rules []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if grantSourceLine.MatchString(line) {
			rules = append(rules, strings.Join(strings.Fields(line), " "))
		}
	}
	return rules
}

// TestEgressDeniedProfileActuallyDenies is the case-13 half of ADR-0019 D3: the
// second profile is not a naming exercise, and the agent-turn profile must not
// be described as enforcing anything about the network.
func TestEgressDeniedProfileActuallyDenies(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}

	// A listener on loopback stands in for "the network": a connect that must
	// fail under --block-net and may succeed without it.
	srv, err := startTestListener()
	if err != nil {
		t.Skipf("cannot open a loopback listener to probe egress with: %v", err)
	}
	defer srv.close()
	// A *child* shell does the connect, and its exit status is what is read.
	// In a non-interactive shell a failed `exec` redirection exits the shell
	// (POSIX: the special builtin's error is fatal), so probing with
	// `exec 3<>… || echo DENIED` in the launched shell itself prints nothing at
	// all — which first read as "egress was not denied" when the sandbox had
	// in fact denied it (`/bin/sh: connect: Permission denied`).
	probe := "bash -c 'exec 3<>/dev/tcp/" + srv.host() + "/" + srv.port() + "' >/dev/null 2>&1 && echo CONNECTED || echo DENIED"

	for _, tc := range []struct {
		kind       string
		blockNet   bool
		wantOpen   bool
		wantClosed bool
	}{
		{kind: nono.ProfileEgressDenied, blockNet: true, wantClosed: true},
		{kind: nono.ProfileAgentTurn, blockNet: false, wantOpen: true},
	} {
		prof, err := nono.WriteProfile(l.profileDir(), tc.kind)
		if err != nil {
			t.Fatal(err)
		}
		spec := nono.LaunchSpec{
			Profile: prof, Plan: l.plan(t), LauncherHome: l.launcher, BlockNet: tc.blockNet,
			AdapterPath: "/bin/sh", AdapterArgs: []string{"-c", probe},
			AdapterEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, res, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			var f *nono.Failure
			if errors.As(err, &f) {
				t.Fatalf("%s launch refused at %s (%s): %v", tc.kind, f.Stage, f.Reason, f.Err)
			}
			t.Fatalf("%s: %v", tc.kind, err)
		}
		_ = h.Wait()
		got := captured(h)
		switch {
		case tc.wantClosed && !strings.Contains(got, "DENIED"):
			t.Errorf("%s: egress was NOT denied (%s) — the case-13 row this profile exists to produce cannot be claimed", tc.kind, got)
		case tc.wantOpen && !strings.Contains(got, "CONNECTED"):
			t.Logf("%s: loopback connect did not succeed under the open profile (%s) — recorded, not asserted: this profile makes no egress claim either way", tc.kind, got)
		}
		if tc.kind == nono.ProfileAgentTurn && res.NetworkEnforced != nono.NetworkAllowlisted {
			t.Errorf("the agent-turn profile reported network=%q, want %q (ADR-0035)", res.NetworkEnforced, nono.NetworkAllowlisted)
		}
		if tc.kind == nono.ProfileEgressDenied && res.NetworkEnforced != nono.NetworkDenied {
			t.Errorf("the egress-denied profile reported network=%q, want %q", res.NetworkEnforced, nono.NetworkDenied)
		}
	}
}

// TestAfUnixSocketIsClosedByTheProfile is SANDBOX.md C7's remedy re-derived
// against the profile this adapter ships, over a socket we own. C7 fell open at
// nono's defaults (the docker socket was reachable), and ADR-0009's remedy —
// a Communication-owned profile with af_unix_mediation=pathname — was listed as
// "applied end-to-end" but never observed. This is that observation.
func TestAfUnixSocketIsClosedByTheProfile(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skipf("curl missing for the socket probe: %v", err)
	}
	sock, err := startUnixListener(l.root)
	if err != nil {
		t.Skipf("cannot open an AF_UNIX listener here: %v", err)
	}
	defer func() { _ = os.Remove(sock.socketPath); sock.close() }()

	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}
	spec := nono.LaunchSpec{
		Profile: prof, Plan: l.plan(t), LauncherHome: l.launcher,
		AdapterPath: "/bin/sh", AdapterArgs: []string{"-c", sock.unixProbeCommand()},
		AdapterEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
	}
	h, _, err := launch.LaunchPlan(context.Background(), spec)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	_ = h.Wait()
	got := captured(h)
	if strings.Contains(got, "unix hello") {
		t.Errorf("AF_UNIX mediation did not close an ungranted socket — the shipped profile is not doing what N-c asserts it does: %s", got)
	}
	t.Logf("sandboxed socket probe: %s", got)
}

// TestSandboxVerifiedPayloadMatchesTheChain keeps the event honest: the payload
// the worker will append is built from the chain's output, so a field that the
// chain cannot fill must not appear filled.
func TestSandboxVerifiedPayloadMatchesTheChain(t *testing.T) {
	l := newLab(t)
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	plan := l.plan(t)
	body, err := nono.ProfileJSON(prof.Kind)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("the profile is not valid JSON: %v", err)
	}
	chain := &nono.VerificationResult{
		NetworkEnforced: prof.NetworkEnforced, EgressHosts: prof.EgressHosts,
	}
	claim, enforced := chain.EgressReport()
	payload := events.SandboxVerifiedPayload{
		ProjectID: fixtureProject, TurnID: "t", WorkspaceID: "w", WorkerID: "k",
		PolicyDigest: prof.Digest, Backend: "nono", BackendVersion: nono.PinnedVersion,
		AfUnixMediation: "pathname", NetworkEnforced: enforced, Network: claim,
		Grants: sandboxGrants(plan), CommitGranted: true, Verified: true,
	}
	if payload.NetworkEnforced {
		t.Error("agent-turn payload claims enforced egress")
	}
	if claim != string(nono.NetworkOpen) {
		t.Errorf("an allowlisted profile with no observed denial reported %q, want %q (ADR-0035: the claim follows the run's audit, never the config)", claim, nono.NetworkOpen)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), l.root) {
		t.Errorf("the payload leaked a host path: %s", raw)
	}
}

func sandboxGrants(plan wsgit.LaunchPlan) []events.SandboxGrant {
	var out []events.SandboxGrant
	for _, g := range plan.EventGrants() {
		out = append(out, events.SandboxGrant{Role: g.Role, Access: g.Access()})
	}
	return out
}

// captured reads a launched process's output through the concrete handle: the
// interface (domain.ProcessHandle) is Wait/Kill only, and these tests are about
// what the child actually printed.
func captured(h domain.ProcessHandle) string {
	p, ok := h.(*nono.Process)
	if !ok {
		return ""
	}
	out := p.Stdout()
	if e := p.Stderr(); e != "" {
		out += "\n[stderr] " + e
	}
	return out
}

// streamsOf returns the child's captured stdout and stderr separately, each
// labelled when it produced nothing, so an empty stream is never mistaken for
// an uncaptured one.
func streamsOf(h domain.ProcessHandle) (string, string) {
	p, ok := h.(*nono.Process)
	if !ok {
		return "<not a *nono.Process>", "<not a *nono.Process>"
	}
	label := func(s string) string {
		if strings.TrimSpace(s) == "" {
			return "<empty>"
		}
		return s
	}
	return label(p.Stdout()), label(p.Stderr())
}

// TestVerifyRefusesAPathNonoDrops is probe C-FC3 turned into a regression test on
// the real binary.
//
// Observed in the live compose lab, verbatim, from `nono run -v --dry-run`:
//
//	WARN  '/repos/DOES-NOT-EXIST' does not exist and will be ignored.
//	INFO  Skipping non-existent path: /repos/DOES-NOT-EXIST
//
// and then the child runs anyway. A grant list that silently loses an entry is
// the worst failure mode this adapter could have: a plan that *looks* correct
// yields a sandbox narrower than the plan claims, and a dropped read grant shows
// up later as a git failure with no trace of the cause. The evidence above is a
// WARN on stderr, which is why N-d asserts against the parsed resolved set rather
// than trusting that the argv it built is the policy nono built.
func TestVerifyRefusesAPathNonoDrops(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot establish a sandbox in this environment: %v", err)
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	plan := l.plan(t)
	// A second read grant on a directory that was never created.
	plan.Grants = append(plan.Grants, wsgit.Grant{
		Role: wsgit.RoleMirrorRead,
		Path: filepath.Join(l.root, "never-created"),
	})

	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}
	_, err = launch.Verify(context.Background(), nono.LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: l.launcher,
		AdapterPath: "/bin/sh", AdapterArgs: []string{"-c", "true"},
		AdapterEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
	})
	if err == nil {
		t.Fatal("Verify accepted a grant set containing a path nono drops with a WARN; N-d is not asserting the resolved set")
	}
	t.Logf("correctly refused: %v", err)
}

// TestShellStartupFilesAreReadableInsideTheSandbox is probe C-BASHRC's
// regression (ADR-0033). A sandboxed pipeline agent attempt reported every
// Bash step as failed because the agent harness starts bash through its
// system startup files and Debian's bash prints
//
//	/bin/bash: /etc/bash.bashrc: Permission denied   (interactive shells)
//	/bin/bash: /etc/profile: Permission denied       (login shells)
//
// on every invocation when they exist but the ruleset cannot read them. The
// shipped policy must let an interactive and a login bash start with no
// startup-file error in the output; the stripped control policy must still
// produce the error, so the passing case measures the grant and not a host
// where bash never looks. Unlike C-GITCFG there is no absent-file excuse
// path: both files exist in the pinned worker image, and a lab host without
// /etc/bash.bashrc says so instead of passing vacuously.
func TestShellStartupFilesAreReadableInsideTheSandbox(t *testing.T) {
	l := newLab(t)
	if err := newLabNonoWorks(t, l); err != nil {
		t.Skipf("nono cannot enforce here: %v", err)
	}
	for _, f := range []string{"/etc/bash.bashrc", "/etc/profile"} {
		if _, err := os.Stat(f); err != nil {
			t.Logf("%s does not exist on this host (%v): bash skips an absent startup file silently, so there is nothing to grant here — the worker image (debian trixie) ships both files, which is where the failure was observed", f, err)
			return
		}
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	if err := prof.AssertOwnBytes(); err != nil {
		t.Fatalf("the shipped profile does not carry the shell startup reads: %v", err)
	}
	launch := &nono.Launcher{Binary: nonobin(), Home: l.launcher}
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"interactive", []string{"-i", "-c", "echo SANDBOXED"}},
		{"login", []string{"-l", "-c", "echo SANDBOXED"}},
	} {
		spec := nono.LaunchSpec{
			Profile: prof, Plan: l.plan(t), LauncherHome: l.launcher,
			AdapterPath: "/bin/bash", AdapterArgs: tc.args,
			AdapterEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin"},
		}
		h, _, err := launch.LaunchPlan(context.Background(), spec)
		if err != nil {
			t.Fatalf("%s launch: %v", tc.name, err)
		}
		_ = h.Wait()
		got := captured(h)
		if !strings.Contains(got, "SANDBOXED") {
			t.Errorf("%s bash did not run the command under the shipped profile: %s", tc.name, got)
		}
		if strings.Contains(got, "Permission denied") {
			t.Errorf("%s bash hit a startup-file denial under the shipped profile (probe C-BASHRC: every shell step of an agent turn looked failed): %s", tc.name, got)
		}
		t.Logf("%s bash under the shipped profile: %s", tc.name, strings.Join(strings.Fields(got), " "))
	}

	// The control: the same interactive bash under the same policy with
	// read_file stripped (launched past AssertOwnBytes by exec'ing nono
	// directly, exactly as TestSandboxDeniesTheSystemGitConfigWithoutTheGrant
	// does) must still print the denial. If it does not, this host's bash
	// never reads the startup file and the assertion above proves nothing.
	data, err := os.ReadFile(prof.Path)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	body["filesystem"].(map[string]any)["read_file"] = []any{}
	stripped, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path0 := filepath.Join(l.root, "no-shell-startup-read.json")
	if err := os.WriteFile(path0, append(stripped, '\n'), 0o444); err != nil {
		t.Fatal(err)
	}
	args := append([]string{"run", "-s", "-p", path0}, nono.GrantFlags(l.plan(t))...)
	args = append(args, "--", "env", "HOME="+l.prep.Layout.Home, "/bin/bash", "-i", "-c", "echo SANDBOXED")
	cmd := exec.Command(nonobin(), args...) //nolint:gosec // test argv
	cmd.Dir = l.prep.Repos[0].CheckoutPath
	cmd.Env = append(os.Environ(), "HOME="+l.launcher)
	out, _ := cmd.CombinedOutput()
	got := string(out)
	if !strings.Contains(got, "/etc/bash.bashrc: Permission denied") {
		t.Errorf("negative control is vacuous: an interactive bash under a read_file-stripped policy did not report the startup denial (observed: %s)", strings.Join(strings.Fields(got), " "))
	} else {
		t.Logf("negative control confirms the denial without the grant: %s", strings.Join(strings.Fields(got), " "))
	}
}
