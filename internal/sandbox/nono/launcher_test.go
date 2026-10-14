package nono

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox"
)

// writeFake installs a fake nono executable for hermetic tests. No real nono
// is required (or allowed) here.
func writeFake(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nono")
	script := "#!/bin/sh\nset -u\n" + body + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake nono: %v", err)
	}
	return path
}

const (
	fakeVersionOK = `case "$1" in
  --version) echo "nono 0.80.0"; exit 0 ;;
esac
`
	fakeSetupOK = `case "$1" in
  setup)
    echo "nono v0.80.0"
    echo "  * Landlock enabled (syscall probe)"
    echo "  * Landlock V6"
    echo "      - Basic filesystem access control"
    echo "      - TCP network filtering"
    echo "  * Linux AF_UNIX mediation: off by default"
    echo "  * Filesystem ruleset creation verified"
    echo "  * TCP network rule support verified"
    exit 0 ;;
esac
`
	fakeSetupFail = `case "$1" in
  setup) echo "nono setup: Landlock unavailable: kernel too old" >&2; exit 1 ;;
esac
`
)

func policy(rw, ro, deny []string, net domain.NetworkPolicy, level domain.EnforcementMode) domain.SandboxPolicy {
	return domain.SandboxPolicy{
		FSReadWrite:   rw,
		FSReadOnly:    ro,
		FSDeny:        deny,
		Network:       net,
		RequiredLevel: level,
	}
}

func TestBuildArgs(t *testing.T) {
	var l Launcher
	cases := []struct {
		name    string
		policy  domain.SandboxPolicy
		cmd     domain.CommandSpec
		want    []string
		wantErr string
	}{
		{
			name:   "full policy, exact argv and ordering",
			policy: policy([]string{"/work/projA"}, []string{"/opt/tools"}, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:    domain.CommandSpec{Path: "sh", Args: []string{"-c", "echo ok"}},
			want: []string{
				"run", "-s", "--sandbox-policy", "landlock",
				"--allow", "/work/projA",
				"--read", "/opt/tools",
				"--block-net",
				"--", "sh", "-c", "echo ok",
			},
		},
		{
			name:   "multiple grants keep declared order",
			policy: policy([]string{"/work/b", "/work/a"}, []string{"/ro/z", "/ro/y"}, nil, domain.NetworkAllowAll, domain.EnforcePermissiveDev),
			cmd:    domain.CommandSpec{Path: "/bin/true"},
			want: []string{
				"run", "-s", "--sandbox-policy", "landlock",
				"--allow", "/work/b", "--allow", "/work/a",
				"--read", "/ro/z", "--read", "/ro/y",
				"--", "/bin/true",
			},
		},
		{
			name:   "allow_all emits no network flag",
			policy: policy([]string{"/work/a"}, nil, nil, domain.NetworkAllowAll, domain.EnforcePermissiveDev),
			cmd:    domain.CommandSpec{Path: "curl", Args: []string{"-sS", "https://example.com"}},
			want: []string{
				"run", "-s", "--sandbox-policy", "landlock",
				"--allow", "/work/a",
				"--", "curl", "-sS", "https://example.com",
			},
		},
		{
			name:    "paths are cleaned but .. components are never accepted",
			policy:  policy([]string{"/work/a/../a/", "/work/b/.."}, nil, nil, domain.NetworkDeny, domain.EnforcePermissiveDev),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "must not contain ..",
		},
		{
			name:   "trailing slashes and dot components are cleaned",
			policy: policy([]string{"/work/a/", "/work/./b/"}, nil, nil, domain.NetworkDeny, domain.EnforcePermissiveDev),
			cmd:    domain.CommandSpec{Path: "true"},
			want: []string{
				"run", "-s", "--sandbox-policy", "landlock",
				"--allow", "/work/a", "--allow", "/work/b",
				"--block-net",
				"--", "true",
			},
		},
		{
			name:    "relative read-only path rejected",
			policy:  policy([]string{"/work/a"}, []string{"./tools"}, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "must be absolute",
		},
		{
			name:    "relative grant path rejected",
			policy:  policy([]string{"work/projA"}, nil, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "must be absolute",
		},
		{
			name:    "relative read-only path rejected",
			policy:  policy([]string{"/work/a"}, []string{"tools"}, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "FSReadOnly",
		},
		{
			name:    "escaping .. rejected",
			policy:  policy([]string{"/work/../etc"}, nil, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "..",
		},
		{
			name:    "relative escaping path rejected",
			policy:  policy([]string{"../outside"}, nil, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "must be absolute",
		},
		{
			name:    "empty read-write list rejected",
			policy:  policy(nil, []string{"/ro"}, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "FSReadWrite must not be empty",
		},
		{
			name:    "empty command path rejected",
			policy:  policy([]string{"/work/a"}, nil, nil, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "  "},
			wantErr: "command path must not be empty",
		},
		{
			name:    "deny list is fatal in required mode",
			policy:  policy([]string{"/work/a"}, nil, []string{"/work/a/.env"}, domain.NetworkDeny, domain.EnforceRequired),
			cmd:     domain.CommandSpec{Path: "true"},
			wantErr: "deny-list requires a nono profile; not supported in M0",
		},
		{
			name:   "deny list is dropped (not enforced) in permissive-dev",
			policy: policy([]string{"/work/a"}, nil, []string{"/work/a/.env"}, domain.NetworkDeny, domain.EnforcePermissiveDev),
			cmd:    domain.CommandSpec{Path: "true"},
			want: []string{
				"run", "-s", "--sandbox-policy", "landlock",
				"--allow", "/work/a",
				"--block-net",
				"--", "true",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := l.BuildArgs(tc.policy, tc.cmd)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("BuildArgs() = %v, want error containing %q", got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error %q does not contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("BuildArgs() error = %v", err)
			}
			if strings.Join(got, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("argv mismatch\n got: %q\nwant: %q", got, tc.want)
			}
			joined := strings.Join(got, " ")
			if strings.Contains(joined, "external") {
				t.Fatalf("argv must never reference --sandbox-policy external (FC2): %q", joined)
			}
			if !strings.Contains(joined, "--sandbox-policy landlock") {
				t.Fatalf("argv must pin --sandbox-policy landlock: %q", joined)
			}
		})
	}
}

func TestBuildArgsRequiredDenyListIsNotEnforceable(t *testing.T) {
	var l Launcher
	_, err := l.BuildArgs(policy([]string{"/work/a"}, nil, []string{"/work/a/.env"}, domain.NetworkDeny, domain.EnforceRequired),
		domain.CommandSpec{Path: "true"})
	if !errors.Is(err, sandbox.ErrNotEnforceable) {
		t.Fatalf("error = %v, want errors.Is(err, sandbox.ErrNotEnforceable)", err)
	}
}

func TestRequireDirInsideReadWrite(t *testing.T) {
	p := policy([]string{"/work/projA"}, nil, nil, domain.NetworkDeny, domain.EnforceRequired)
	var l Launcher
	_ = l
	if err := requireDirInsideReadWrite(p, "/work/projA"); err != nil {
		t.Fatalf("exact grant: %v", err)
	}
	if err := requireDirInsideReadWrite(p, "/work/projA/sub"); err != nil {
		t.Fatalf("nested grant: %v", err)
	}
	for _, dir := range []string{"", "relative/dir", "/work/projB", "/work/projAa", "/"} {
		if err := requireDirInsideReadWrite(p, dir); err == nil {
			t.Fatalf("dir %q: want error, got nil", dir)
		}
	}
}

func TestProbeReadsSetupCheckOutput(t *testing.T) {
	bin := writeFake(t, fakeVersionOK+fakeSetupOK)
	l := &Launcher{Binary: bin}

	caps, err := l.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if caps.Backend != "nono" {
		t.Fatalf("Backend = %q, want nono", caps.Backend)
	}
	if caps.Version != "0.80.0" {
		t.Fatalf("Version = %q, want 0.80.0", caps.Version)
	}
	if !caps.Filesystem || !caps.Network {
		t.Fatalf("Filesystem/Network = %v/%v, want true/true (caps: %+v)", caps.Filesystem, caps.Network, caps)
	}
	if caps.Verified {
		t.Fatal("Probe must never claim Verified enforcement from configuration alone")
	}
	notes := strings.Join(caps.Notes, " | ")
	if !strings.Contains(notes, "Landlock ABI v6") {
		t.Fatalf("notes missing Landlock ABI version: %q", notes)
	}
	if !strings.Contains(notes, "AF_UNIX") {
		t.Fatalf("notes missing AF_UNIX mediation caveat: %q", notes)
	}
}

func TestProbeWithoutFilesystemVerification(t *testing.T) {
	bin := writeFake(t, fakeVersionOK+`case "$1" in
  setup) echo "  * Landlock V4"; echo "  * TCP network rule support verified"; exit 0 ;;
esac
`)
	caps, err := (&Launcher{Binary: bin}).Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if caps.Filesystem {
		t.Fatalf("Filesystem = true without a verified ruleset report: %+v", caps)
	}
	if !caps.Network {
		t.Fatalf("Network = false although TCP support was verified: %+v", caps)
	}
}

func TestProbeMissingBinaryIsUnavailable(t *testing.T) {
	l := &Launcher{Binary: filepath.Join(t.TempDir(), "definitely-not-here")}
	_, err := l.Probe(context.Background())
	if !errors.Is(err, sandbox.ErrUnavailable) {
		t.Fatalf("error = %v, want errors.Is(err, sandbox.ErrUnavailable)", err)
	}

	if _, err := (&Launcher{Binary: ""}).resolveBinary(); err != nil && !errors.Is(err, sandbox.ErrUnavailable) {
		t.Fatalf("resolveBinary error = %v, want ErrUnavailable wrapper", err)
	}
}

func TestLaunchRequiredRefusesWhenSetupCheckFails(t *testing.T) {
	dir := t.TempDir()
	projA := filepath.Join(dir, "projA")
	if err := os.Mkdir(projA, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(projA, "ran.marker")
	bin := writeFake(t, fakeVersionOK+fakeSetupFail+`echo "fake nono should never get this far: $*" >&2
exit 9
`)
	// The target command would record that it ran. It must never run.
	target := domain.CommandSpec{
		Path: "/bin/sh",
		Args: []string{"-c", "touch " + marker},
		Dir:  projA,
	}
	l := &Launcher{Binary: bin}
	h, err := l.Launch(context.Background(),
		policy([]string{projA}, nil, nil, domain.NetworkDeny, domain.EnforceRequired), target)
	if h != nil {
		t.Fatalf("handle = %v, want nil when required mode refuses", h)
	}
	if !errors.Is(err, sandbox.ErrNotEnforceable) {
		t.Fatalf("error = %v, want errors.Is(err, sandbox.ErrNotEnforceable)", err)
	}
	assertNoMarker(t, marker)
}

func TestLaunchRequiredRefusesWhenDryRunFails(t *testing.T) {
	marker, projA := scratchDir(t)
	bin := writeFake(t, fakeVersionOK+fakeSetupOK+`if [ "$2" = "--dry-run" ] || printf '%s\n' "$@" | grep -q -- '--dry-run'; then
  echo "nono: policy rejected: network restriction cannot be satisfied" >&2
  exit 1
fi
echo "fake nono ran the child (must not happen): $*" >&2
exit 9
`)
	l := &Launcher{Binary: bin}
	h, err := l.Launch(context.Background(),
		policy([]string{projA}, nil, nil, domain.NetworkDeny, domain.EnforceRequired),
		domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "touch " + marker}, Dir: projA})
	if h != nil {
		t.Fatalf("handle = %v, want nil", h)
	}
	if !errors.Is(err, sandbox.ErrNotEnforceable) {
		t.Fatalf("error = %v, want ErrNotEnforceable", err)
	}
	if !strings.Contains(err.Error(), "network restriction cannot be satisfied") {
		t.Fatalf("error must carry the dry-run output, got %v", err)
	}
	assertNoMarker(t, marker)
}

func TestLaunchRequiredPinsPolicyAndNeverFallsBack(t *testing.T) {
	argvPath := filepath.Join(t.TempDir(), "argv.txt")
	marker, projA := scratchDir(t)
	bin := writeFake(t, fakeVersionOK+fakeSetupOK+`if printf '%s\n' "$@" | grep -q -- '--dry-run'; then
  exit 0
fi
printf '%s\n' "$@" > `+argvPath+`
exit 0
`)
	l := &Launcher{Binary: bin}
	spec := domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "touch " + marker}, Dir: projA}
	h, err := l.Launch(context.Background(),
		policy([]string{projA}, []string{"/etc/ssl"}, nil, domain.NetworkDeny, domain.EnforceRequired), spec)
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if err := h.Wait(); err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	raw, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatalf("read recorded argv: %v", err)
	}
	got := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	want := []string{
		"run", "-s", "--sandbox-policy", "landlock",
		"--allow", projA, "--read", "/etc/ssl", "--block-net",
		"--", "/bin/sh", "-c", "touch " + marker,
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv passed to nono mismatch\n got: %q\nwant: %q", got, want)
	}
	// The fake never execs the child, so the target must not have run.
	assertNoMarker(t, marker)
}

func TestLaunchUnknownRequiredLevel(t *testing.T) {
	l := &Launcher{Binary: writeFake(t, fakeVersionOK+fakeSetupOK)}
	h, err := l.Launch(context.Background(),
		policy([]string{"/work/a"}, nil, nil, domain.NetworkDeny, domain.EnforcementMode("yolo")),
		domain.CommandSpec{Path: "true"})
	if h != nil || err == nil {
		t.Fatalf("Launch() = %v, %v; want nil handle and an error", h, err)
	}
	if !strings.Contains(err.Error(), "unknown required level") {
		t.Fatalf("error = %v, want it to mention the unknown level", err)
	}
}

func TestLaunchPermissiveDevFallsBackUnsandboxedAndWarns(t *testing.T) {
	var logs strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(prev)

	marker, projA := scratchDir(t)
	bin := writeFake(t, fakeVersionOK+fakeSetupFail+`exit 9
`)
	l := &Launcher{Binary: bin}
	h, err := l.Launch(context.Background(),
		policy([]string{projA}, nil, nil, domain.NetworkDeny, domain.EnforcePermissiveDev),
		domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "touch " + marker}, Dir: projA})
	if err != nil {
		t.Fatalf("permissive-dev Launch() error = %v", err)
	}
	if err := h.Wait(); err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("target command did not run in permissive-dev fallback: %v", err)
	}
	if !strings.Contains(logs.String(), "UNSANDBOXED permissive-dev execution") {
		t.Fatalf("expected a loud unsandboxed warning, logs:\n%s", logs.String())
	}
}

func TestLaunchDisabledRunsDirectly(t *testing.T) {
	var logs strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(prev)

	marker, projA := scratchDir(t)
	l := &Launcher{Binary: writeFake(t, `echo "fake nono must not be called in disabled mode" >&2
exit 9
`)}
	h, err := l.Launch(context.Background(),
		policy(nil, nil, nil, domain.NetworkAllowAll, domain.EnforceDisabled),
		domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "touch " + marker}, Dir: projA})
	if err != nil {
		t.Fatalf("disabled Launch() error = %v", err)
	}
	if err := h.Wait(); err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("target command did not run in disabled mode: %v", err)
	}
	if !strings.Contains(logs.String(), "unsandboxed") {
		t.Fatalf("expected an unsandboxed warning in disabled mode, logs:\n%s", logs.String())
	}
}

func TestProcessCapturesOutputAndKillAfterExitFails(t *testing.T) {
	l := &Launcher{Binary: writeFake(t, `echo to-stdout
echo to-stderr >&2
exit 0
`)}
	h, err := l.launchDirect(context.Background(), domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "echo hi"}})
	if err != nil {
		t.Fatalf("launchDirect() error = %v", err)
	}
	if err := h.Wait(); err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	p := h.(*Process)
	if got := p.Stdout(); !strings.Contains(got, "hi") {
		t.Fatalf("Stdout() = %q, want it to contain hi", got)
	}
	if got := p.ExitCode(); got != 0 {
		t.Fatalf("ExitCode() = %d, want 0", got)
	}
	if err := h.Wait(); err != nil {
		t.Fatalf("second Wait() error = %v, want replayed nil", err)
	}
	if err := p.Kill(); err == nil {
		t.Fatal("Kill() after exit: want error, got nil")
	}
}

func TestProcessExitCodePropagates(t *testing.T) {
	l := &Launcher{}
	h, err := l.launchDirect(context.Background(), domain.CommandSpec{Path: "/bin/sh", Args: []string{"-c", "echo boom >&2; exit 3"}})
	if err != nil {
		t.Fatalf("launchDirect() error = %v", err)
	}
	err = h.Wait()
	if err == nil {
		t.Fatal("Wait() = nil, want exit error")
	}
	if code := h.(*Process).ExitCode(); code != 3 {
		t.Fatalf("ExitCode() = %d, want 3", code)
	}
	if !strings.Contains(h.(*Process).Stderr(), "boom") {
		t.Fatalf("Stderr() = %q, want it to contain boom", h.(*Process).Stderr())
	}
}

func scratchDir(t *testing.T) (marker, projA string) {
	t.Helper()
	projA = filepath.Join(t.TempDir(), "projA")
	if err := os.Mkdir(projA, 0o755); err != nil {
		t.Fatalf("mkdir projA: %v", err)
	}
	return filepath.Join(projA, "ran.marker"), projA
}

func assertNoMarker(t *testing.T, marker string) {
	t.Helper()
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target command ran (marker %s exists, stat err %v); required mode must not launch it", marker, err)
	}
}
