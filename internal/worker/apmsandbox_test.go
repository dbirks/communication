package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// TestAPMSandboxWrapBuildsTheNonoResolveLaunch is the unit half of ADR-0054
// §B.2's sandboxed resolve: under `required`, the worker-supplied wrapper must
// answer the resolve with the nono launch that grants the scratch work dir + the
// scratch home rw, reads the pinned apm binary, allowlists the package source and
// never --block-net (the resolve must fetch).
func TestAPMSandboxWrapBuildsTheNonoResolveLaunch(t *testing.T) {
	// Lab scratch, not t.TempDir: the resolve's scratch work dir + scratch home
	// are sandbox grants (probe C-TMP1 refuses /tmp grants), so a /tmp fixture
	// would be refused before the argv could be asserted.
	workdir := procExecScratch(t, "apmsandbox-wrap-workdir")
	home := procExecScratch(t, "apmsandbox-wrap-home")
	binDir := procExecScratch(t, "apmsandbox-wrap-bin")
	bin := filepath.Join(binDir, "apm")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}

	sbx := &recordingSandbox{}
	s := &APMSandbox{
		Sandbox:      sbx,
		LauncherHome: t.TempDir(),
		PolicyDir:    t.TempDir(),
		SandboxPath:  "/usr/local/bin/nono",
		Enforcement:  domain.EnforceRequired,
		Binary:       bin,
	}
	wrap, err := s.Wrap(context.Background(), apm.ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     apm.TargetClaude,
		WorkDir:    workdir,
		Home:       home,
	})
	if err != nil {
		t.Fatalf("Wrap: %v", err)
	}
	if wrap == nil {
		t.Fatal("under required enforcement the wrapper must exist")
	}
	execPath, execArgs, execEnv, err := wrap([]string{"install", "--target", apm.TargetClaude}, []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		"GIT_TERMINAL_PROMPT=0",
		"TERM=xterm-256color",
	})
	if err != nil {
		t.Fatalf("the resolve wrapper: %v", err)
	}
	if execPath != "/usr/local/bin/nono" {
		t.Errorf("exec path = %q, want the nono binary", execPath)
	}
	joined := strings.Join(execArgs, " ")
	if !strings.Contains(joined, "-p "+sbx.lastSpec().Profile.Path) {
		t.Errorf("argv = %q, want it to name the apm-resolve profile", joined)
	}
	if !strings.Contains(joined, "--allow "+workdir) || !strings.Contains(joined, "--allow "+home) {
		t.Errorf("argv = %q, want rw grants on the scratch work dir and scratch home", joined)
	}
	if !strings.Contains(joined, "--read "+binDir) {
		t.Errorf("argv = %q, want a read grant on the pinned apm binary dir", joined)
	}
	if strings.Contains(joined, "--block-net") {
		t.Errorf("argv = %q carries --block-net: a resolve must fetch, never block (ADR-0054 §B.2)", joined)
	}
	if !strings.Contains(joined, "HOME="+home) {
		t.Errorf("argv = %q, want the launcher env hop to set HOME=%s", joined, home)
	}
	if !strings.Contains(joined, bin+" install --target "+apm.TargetClaude) {
		t.Errorf("argv = %q, want the pinned apm install", joined)
	}
	if strings.Contains(joined, "sk-ant-") || strings.Contains(joined, "ghp_") || strings.Contains(joined, "github_pat_") {
		t.Errorf("argv = %q carries a credential: the resolve launch must be secret-free", joined)
	}

	spec := sbx.lastSpec()
	if spec.Profile.Kind != nono.ProfileAPMResolve {
		t.Errorf("profile kind = %q, want %q", spec.Profile.Kind, nono.ProfileAPMResolve)
	}
	if spec.Profile.NetworkEnforced != nono.NetworkAllowlisted {
		t.Errorf("profile network = %q, want allowlisted", spec.Profile.NetworkEnforced)
	}
	if len(spec.Profile.EgressHosts) == 0 {
		t.Error("the apm-resolve profile must carry an egress allowlist")
	}
	want := []string{"github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"}
	if len(spec.Profile.EgressHosts) != len(want) {
		t.Fatalf("egress hosts = %v, want %v", spec.Profile.EgressHosts, want)
	}
	for _, h := range want {
		found := false
		for _, got := range spec.Profile.EgressHosts {
			if got == h {
				found = true
			}
		}
		if !found {
			t.Errorf("egress host %q missing from %v", h, spec.Profile.EgressHosts)
		}
	}
	if len(spec.ToolReads) == 0 || spec.ToolReads[0] != binDir {
		t.Errorf("tool reads = %v, want [%s]", spec.ToolReads, binDir)
	}
	if spec.BlockNet {
		t.Error("the resolve launch must never carry --block-net")
	}
	if len(execEnv) == 0 {
		t.Error("the launch must carry the launcher environment")
	}
}

// Under required with no sandbox backend the wrapper must fail closed with the
// named error, never answer plainly.
func TestAPMSandboxWrapRequiredWithoutSandboxFailsClosed(t *testing.T) {
	s := &APMSandbox{LauncherHome: t.TempDir(), PolicyDir: t.TempDir(), Enforcement: domain.EnforceRequired}
	if _, err := s.Wrap(context.Background(), apm.ResolveRequest{}); err == nil {
		t.Fatal("a required resolve must fail closed when no sandbox backend is configured")
	} else if !strings.Contains(err.Error(), "apm resolve could not be sandboxed") {
		t.Errorf("err = %v, want it to name the could-not-be-sandboxed refusal", err)
	}
}

// Under a mode that does not require a sandboxed resolve the wrapper is nil and
// the resolve answers plainly.
func TestAPMSandboxWrapNotRequiredAnswersPlainly(t *testing.T) {
	s := &APMSandbox{LauncherHome: t.TempDir(), PolicyDir: t.TempDir(), Enforcement: domain.EnforceDisabled}
	wrap, err := s.Wrap(context.Background(), apm.ResolveRequest{})
	if err != nil || wrap != nil {
		t.Fatalf("wrap = %v, err = %v, want nil/nil under a non-required mode", wrap, err)
	}
}

// TestAPMSandboxWrapAcceptsWorkspaceRootScratch pins the apm-resolve sandbox
// grant rule for the default resolve scratch root: the resolve's scratch work
// dir + scratch home live under a workspace root (the worker defaults them to
// <workspace root>/.apm-lock), and the sandbox accepts a writable grant there —
// workspace paths are what agent turns get granted — while refusing one under
// the temp tree the sandbox layers by default (probe C-TMP1).
func TestAPMSandboxWrapAcceptsWorkspaceRootScratch(t *testing.T) {
	base := procExecScratch(t, "apmsandbox-wsroot")
	wsRoot := filepath.Join(base, "workspaces")
	scratchRoot := filepath.Join(wsRoot, ".apm-lock")
	if err := os.MkdirAll(scratchRoot, 0o700); err != nil {
		t.Fatalf("create the workspace-rooted resolve scratch root: %v", err)
	}
	workdir := filepath.Join(scratchRoot, "apm-lock-0123456789")
	home := filepath.Join(scratchRoot, "apm-lock-home-0123456789")
	for _, d := range []string{workdir, home} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatalf("create the resolve scratch dir %s: %v", d, err)
		}
	}
	binDir := procExecScratch(t, "apmsandbox-wsroot-bin")
	bin := filepath.Join(binDir, "apm")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}

	sbx := &recordingSandbox{}
	s := &APMSandbox{
		Sandbox:      sbx,
		LauncherHome: t.TempDir(),
		PolicyDir:    t.TempDir(),
		SandboxPath:  "/usr/local/bin/nono",
		Enforcement:  domain.EnforceRequired,
		Binary:       bin,
	}
	ctx := context.Background()
	wrap, err := s.Wrap(ctx, apm.ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     apm.TargetClaude,
		WorkDir:    workdir,
		Home:       home,
	})
	if err != nil {
		t.Fatalf("Wrap under the workspace-rooted scratch root: %v", err)
	}
	if wrap == nil {
		t.Fatal("under required enforcement the wrapper must exist")
	}
	execPath, execArgs, execEnv, err := wrap([]string{"install", "--target", apm.TargetClaude}, []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		"GIT_TERMINAL_PROMPT=0",
		"TERM=xterm-256color",
	})
	if err != nil {
		t.Fatalf("the resolve wrapper: %v", err)
	}
	if execPath != "/usr/local/bin/nono" {
		t.Errorf("exec path = %q, want the nono binary", execPath)
	}
	joined := strings.Join(execArgs, " ")
	if !strings.Contains(joined, "-p "+sbx.lastSpec().Profile.Path) {
		t.Errorf("argv = %q, want it to name the apm-resolve profile", joined)
	}
	if !strings.Contains(joined, "--allow "+workdir) || !strings.Contains(joined, "--allow "+home) {
		t.Errorf("argv = %q, want rw grants on the workspace-rooted scratch work dir and scratch home", joined)
	}
	if !strings.Contains(joined, "--read "+binDir) {
		t.Errorf("argv = %q, want a read grant on the pinned apm binary dir", joined)
	}
	if strings.Contains(joined, "--block-net") {
		t.Errorf("argv = %q carries --block-net: a resolve must fetch, never block (ADR-0054 §B.2)", joined)
	}
	if !strings.Contains(joined, "HOME="+home) {
		t.Errorf("argv = %q, want the launcher env hop to set HOME=%s", joined, home)
	}
	if !strings.Contains(joined, bin+" install --target "+apm.TargetClaude) {
		t.Errorf("argv = %q, want the pinned apm install", joined)
	}
	if strings.Contains(joined, "sk-ant-") || strings.Contains(joined, "ghp_") || strings.Contains(joined, "github_pat_") {
		t.Errorf("argv = %q carries a credential: the resolve launch must be secret-free", joined)
	}

	for _, g := range sbx.lastSpec().Plan.Grants {
		if err := wsgit.RefuseTempPath(g.Path); err != nil {
			t.Errorf("resolve grant %s (%s) is refused: %v", g.Path, g.Role, err)
		}
	}
	if len(execEnv) == 0 {
		t.Error("the launch must carry the launcher environment")
	}
}

// TestAPMSandboxWrapResolvesSymlinkedApmBinary pins the apm-exec fix: the
// worker image ships the pinned apm as /usr/local/bin/apm -> /opt/apm/apm (a
// PyInstaller onedir bundle, apm + _internal/), and Landlock checks exec/read
// on the RESOLVED target, so the resolve wrapper must resolve the binary before
// building the launch — exec the resolved path and grant read on the resolved
// binary's directory (/opt/apm, which holds _internal/), never on the symlink's
// own directory.
func TestAPMSandboxWrapResolvesSymlinkedApmBinary(t *testing.T) {
	base := procExecScratch(t, "apmsandbox-symlink")
	realDir := filepath.Join(base, "opt", "apm")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatalf("create the real apm bundle dir: %v", err)
	}
	real := filepath.Join(realDir, "apm")
	if err := os.WriteFile(real, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write the real apm binary: %v", err)
	}
	binDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("create the bin dir: %v", err)
	}
	bin := filepath.Join(binDir, "apm")
	if err := os.Symlink(real, bin); err != nil {
		t.Skipf("symlink to the apm binary unsupported here: %v", err)
	}
	workdir := procExecScratch(t, "apmsandbox-symlink-workdir")
	home := procExecScratch(t, "apmsandbox-symlink-home")

	sbx := &recordingSandbox{}
	s := &APMSandbox{
		Sandbox:      sbx,
		LauncherHome: t.TempDir(),
		PolicyDir:    t.TempDir(),
		SandboxPath:  "/usr/local/bin/nono",
		Enforcement:  domain.EnforceRequired,
		Binary:       bin,
	}
	wrap, err := s.Wrap(context.Background(), apm.ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     apm.TargetClaude,
		WorkDir:    workdir,
		Home:       home,
	})
	if err != nil {
		t.Fatalf("Wrap: %v", err)
	}
	if wrap == nil {
		t.Fatal("under required enforcement the wrapper must exist")
	}
	execPath, execArgs, execEnv, err := wrap([]string{"install", "--target", apm.TargetClaude}, []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		"GIT_TERMINAL_PROMPT=0",
		"TERM=xterm-256color",
	})
	if err != nil {
		t.Fatalf("the resolve wrapper: %v", err)
	}
	if execPath != "/usr/local/bin/nono" {
		t.Errorf("exec path = %q, want the nono binary", execPath)
	}
	joined := strings.Join(execArgs, " ")
	if !strings.Contains(joined, "--read "+realDir) {
		t.Errorf("argv = %q, want a read grant on the resolved apm dir %q", joined, realDir)
	}
	if strings.Contains(joined, "--read "+binDir) {
		t.Errorf("argv = %q, want no read grant on the symlink dir %q", joined, binDir)
	}
	if !strings.Contains(joined, real+" install --target "+apm.TargetClaude) {
		t.Errorf("argv = %q, want the pinned apm install via the resolved path", joined)
	}
	spec := sbx.lastSpec()
	if len(spec.ToolReads) == 0 || spec.ToolReads[0] != realDir {
		t.Errorf("tool reads = %v, want [%s]", spec.ToolReads, realDir)
	}
	if len(execEnv) == 0 {
		t.Error("the launch must carry the launcher environment")
	}
}

// The real-sandbox proof for the APM lock resolve under ADR-0054 §B.2: the
// pinned apm CLI runs the resolving install inside a real nono sandboxed child —
// rw grants on the resolve's scratch work dir + scratch home, read grant on the
// pinned apm binary, the package-source egress allowlist, never --block-net —
// and the lock digest it answers with is the one the launch gate pins. Lab-gated
// like the other real-nono proofs (procexec_nono_test.go, ADR-0019): a skip requires
// a missing precondition (binary, pinned version, observed Landlock support),
// never the outcome.
func TestAPMSandboxRealResolveUnderNono(t *testing.T) {
	if os.Getenv("COMMUNICATION_APM_REAL") != "1" {
		t.Skip("COMMUNICATION_APM_REAL not set: the real apm resolve under nono is lab-gated")
	}
	ctx := context.Background()
	bin, err := exec.LookPath("nono")
	if err != nil {
		t.Skipf("nono binary required for the real-sandbox resolve: %v", err)
	}
	launcher := &nono.Launcher{Binary: bin, Home: procExecScratch(t, "apmsandbox-real-launcher")}
	caps, err := launcher.Probe(ctx)
	if err != nil {
		t.Skipf("nono probe: %v", err)
	}
	if caps.Version != nono.PinnedVersion {
		t.Skipf("nono %s pinned, host has %s", nono.PinnedVersion, caps.Version)
	}
	if !caps.Filesystem {
		t.Skipf("no observed Landlock filesystem support (%v): the § 0 rule is that nothing depends on a sandbox this host did not show", caps.Notes)
	}
	apmBin, err := exec.LookPath("apm")
	if err != nil {
		t.Skipf("apm on PATH required for the real resolve: %v", err)
	}

	t.Run("required real resolve answers the pinned lock digest sandboxed", func(t *testing.T) {
		s := &APMSandbox{
			Sandbox:      launcher,
			LauncherHome: procExecScratch(t, "apmsandbox-real-launcher-home"),
			PolicyDir:    t.TempDir(),
			SandboxPath:  bin,
			Enforcement:  domain.EnforceRequired,
			Binary:       apmBin,
			Timeout:      5 * time.Minute,
		}
		workdir := procExecScratch(t, "apmsandbox-real-workdir")
		home := procExecScratch(t, "apmsandbox-real-home")
		res, err := s.Resolve(ctx, apm.ResolveRequest{
			PackageRef: "mattpocock/skills#v1.3.1",
			Target:     apm.TargetClaude,
			WorkDir:    workdir,
			Home:       home,
			Timeout:    5 * time.Minute,
		})
		if err != nil {
			t.Fatalf("APMSandbox.Resolve(mattpocock/skills#v1.3.1) under real nono: %v", err)
		}
		want := "sha256:f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33"
		if res.LockDigest != want {
			t.Errorf("APMSandbox.Resolve(mattpocock/skills#v1.3.1).LockDigest = %s, want %s", res.LockDigest, want)
		}
		if !res.Sandboxed {
			t.Error("the real resolve must run through the sandboxed launcher wrapper")
		}
	})

	t.Run("an apm-resolve allowlist without the package-source hosts refuses the resolve", func(t *testing.T) {
		s := &APMSandbox{
			Sandbox:      launcher,
			LauncherHome: procExecScratch(t, "apmsandbox-real-launcher-home"),
			PolicyDir:    t.TempDir(),
			SandboxPath:  bin,
			Enforcement:  domain.EnforceRequired,
			Binary:       apmBin,
			Timeout:      5 * time.Minute,
			EgressAllow:  []string{"example.com"},
		}
		workdir := procExecScratch(t, "apmsandbox-real-workdir")
		home := procExecScratch(t, "apmsandbox-real-home")
		res, err := s.Resolve(ctx, apm.ResolveRequest{
			PackageRef: "mattpocock/skills#v1.3.1",
			Target:     apm.TargetClaude,
			WorkDir:    workdir,
			Home:       home,
			Timeout:    5 * time.Minute,
		})
		if err == nil {
			t.Fatalf("APMSandbox.Resolve(mattpocock/skills#v1.3.1) with an allowlist that has no GitHub hosts must fail, got result %+v", res)
		}
		if res != nil {
			t.Errorf("a refused resolve must answer no result: %+v", res)
		}
	})

	// The apm-exec fix, proven against the real image: a resolve launched
	// through a SYMLINK to the apm binary must exec the RESOLVED path and grant
	// read on the resolved binary's directory (/opt/apm), not on the symlink's
	// own dir (the lab's `env: '/usr/local/bin/apm': Permission denied).
	t.Run("a symlinked apm resolves through to the resolved binary dir", func(t *testing.T) {
		binDir := procExecScratch(t, "apmsandbox-real-symlink-bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatalf("create the symlink bin dir: %v", err)
		}
		bin := filepath.Join(binDir, "apm")
		if err := os.Symlink(apmBin, bin); err != nil {
			t.Skipf("symlink to the apm binary unsupported here: %v", err)
		}
		s := &APMSandbox{
			Sandbox:      launcher,
			LauncherHome: procExecScratch(t, "apmsandbox-real-launcher-home"),
			PolicyDir:    t.TempDir(),
			SandboxPath:  launcher.Binary,
			Enforcement:  domain.EnforceRequired,
			Binary:       bin,
			Timeout:      5 * time.Minute,
		}
		workdir := procExecScratch(t, "apmsandbox-real-workdir")
		home := procExecScratch(t, "apmsandbox-real-home")
		res, err := s.Resolve(ctx, apm.ResolveRequest{
			PackageRef: "mattpocock/skills#v1.3.1",
			Target:     apm.TargetClaude,
			WorkDir:    workdir,
			Home:       home,
			Timeout:    5 * time.Minute,
		})
		if err != nil {
			t.Fatalf("APMSandbox.Resolve(mattpocock/skills#v1.3.1) through a symlinked apm: %v", err)
		}
		want := "sha256:f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33"
		if res.LockDigest != want {
			t.Errorf("APMSandbox.Resolve(mattpocock/skills#v1.3.1) through a symlinked apm: LockDigest = %s, want %s", res.LockDigest, want)
		}
		if !res.Sandboxed {
			t.Error("the resolve through the symlink must run through the sandboxed launcher wrapper")
		}
	})
}
