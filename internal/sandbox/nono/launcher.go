// Package nono implements domain.SandboxLauncher by driving the nono CLI
// (Linux Landlock prototype, D-011 / ADR-0003).
//
// Only child processes are sandboxed: the launcher execs the nono binary and
// never applies Landlock or seccomp to the Communication process
// (communication-spec/05-workspaces-security-secrets.md).
//
// required mode is verify-then-run, because nono's exit status alone is not
// proof of enforcement — see docs/compatibility/SANDBOX.md ("Implications for
// required mode"). Two observed nono behaviours shape this adapter:
//
//   - --sandbox-policy external silently drops nono's own TCP lockdown even
//     when --block-net was requested (finding FC2), so this adapter always
//     pins --sandbox-policy landlock and never emits external.
//   - a working directory outside the grants makes nono exit 1 in
//     non-interactive mode ("CWD access requires --allow-cwd"), so cmd.Dir is
//     validated against the read-write grants up front.
package nono

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox"
)

const (
	// BackendName is the domain.SandboxCapabilities.Backend value.
	BackendName = "nono"

	// policyLandlock is the only --sandbox-policy value this adapter emits.
	// external is forbidden (FC2: it silently un-enforces --block-net) and
	// auto is not accepted in required mode because it can fall back.
	policyLandlock = "landlock"

	// probeTimeout bounds each individual probe command.
	probeTimeout = 5 * time.Second

	// verifyTimeout bounds the pre-launch `nono run --dry-run` check.
	verifyTimeout = 30 * time.Second

	defaultBinary = "nono"

	// afUnixCaveat is recorded in every probe: AF_UNIX connect() mediation is
	// off by default, so a reachable host socket (e.g. /var/run/docker.sock,
	// case C7) is not blocked by the CLI flags used here. Enabling it needs a
	// profile with linux.af_unix_mediation = "pathname".
	afUnixCaveat = "AF_UNIX mediation is off by default in nono: pathname " +
		"socket access (including /var/run/docker.sock) is not blocked by CLI " +
		"flags; requires a profile with linux.af_unix_mediation = \"pathname\" " +
		"(docs/compatibility/SANDBOX.md case C7)"

	// notVerifiedNote explains why Verified stays false.
	notVerifiedNote = "probe reports capabilities only; enforcement proof comes " +
		"from the compatibility probe cases in docs/compatibility/SANDBOX.md"
)

// Launcher launches child processes through the nono CLI. The zero value is
// usable and resolves the binary from PATH.
type Launcher struct {
	// Binary is the nono executable. Empty means exec.LookPath("nono").
	Binary string
	// Home is nono's own HOME for helper invocations (validate, show, dry-run).
	// A workspace launch overrides it per-spec; this field exists for `doctor`,
	// which has no workspace and may legitimately ride the ambient login.
	//
	// It must never point inside a workspace: nono derives its protected state
	// root from HOME and then refuses any grant overlapping it, and that refusal
	// is permanent for the directory (probe C-H1).
	Home string
}

var _ domain.SandboxLauncher = (*Launcher)(nil)

// resolveBinary returns the configured binary or looks it up in PATH.
func (l *Launcher) resolveBinary() (string, error) {
	if l.Binary != "" {
		return l.Binary, nil
	}
	path, err := exec.LookPath(defaultBinary)
	if err != nil {
		return "", fmt.Errorf("%w: %s not found in PATH: %v", sandbox.ErrUnavailable, defaultBinary, err)
	}
	return path, nil
}

// run executes one nono helper command with a timeout and returns its
// combined output. No shell is involved.
func (l *Launcher) run(ctx context.Context, timeout time.Duration, dir string, env []string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, args[0], args[1:]...)
	cmd.Dir = dir
	if len(env) > 0 {
		cmd.Env = env
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Probe reports nono's observed capabilities from `nono --version` and
// `nono setup --check-only -v`. Verified is deliberately always false: Probe
// reports what the backend claims to support, it does not prove enforcement.
func (l *Launcher) Probe(ctx context.Context) (domain.SandboxCapabilities, error) {
	caps := domain.SandboxCapabilities{Backend: BackendName}

	bin, err := l.resolveBinary()
	if err != nil {
		return caps, err
	}

	out, err := l.run(ctx, probeTimeout, "", nil, bin, "--version")
	if err != nil {
		return caps, fmt.Errorf("%w: %s --version failed: %v (%s)",
			sandbox.ErrUnavailable, filepath.Base(bin), err, firstLine(out))
	}
	caps.Version = parseVersion(out)

	check, err := l.run(ctx, probeTimeout, "", nil, bin, "setup", "--check-only", "-v")
	caps.Notes = append(caps.Notes, notesFromCheckOutput(check)...)
	if err != nil {
		return caps, fmt.Errorf("%w: %s setup --check-only failed: %v (%s)",
			sandbox.ErrNotEnforceable, filepath.Base(bin), err, firstLine(check))
	}

	caps.Filesystem = reportsFilesystemSupport(check)
	caps.Network = reportsNetworkSupport(check)
	if !caps.Filesystem {
		caps.Notes = append(caps.Notes, "check output does not report verified Landlock filesystem support")
	}
	if !caps.Network {
		caps.Notes = append(caps.Notes, "check output does not report verified Landlock TCP network support")
	}
	caps.Verified = false
	caps.Notes = append(caps.Notes, notVerifiedNote)
	return caps, nil
}

// versionRe matches nono's `--version` line, e.g. "nono 0.80.0".
var versionRe = regexp.MustCompile(`([vV]?)\d+\.\d+(?:\.\d+)?`)

func parseVersion(out string) string {
	m := versionRe.FindString(strings.TrimSpace(out))
	return strings.TrimPrefix(m, "v")
}

// abiRe matches nono's Landlock ABI line, e.g. "Landlock V6".
var abiRe = regexp.MustCompile(`(?i)Landlock\s+V(\d+)`)

// notesFromCheckOutput extracts the Landlock ABI version and the AF_UNIX
// mediation status from `nono setup --check-only -v` output.
func notesFromCheckOutput(out string) []string {
	var notes []string
	if m := abiRe.FindStringSubmatch(out); m != nil {
		notes = append(notes, "Landlock ABI v"+m[1]+" reported by nono setup --check-only")
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(strings.ToLower(line), "af_unix mediation") {
			notes = append(notes, afUnixCaveat+" (reported: "+strings.Join(strings.Fields(line), " ")+")")
			return notes
		}
	}
	notes = append(notes, afUnixCaveat)
	return notes
}

// reportsFilesystemSupport is true only when the check output states that
// Landlock filesystem rulesets were actually created/verified.
func reportsFilesystemSupport(out string) bool {
	lower := strings.ToLower(out)
	return strings.Contains(lower, "filesystem ruleset creation verified")
}

// reportsNetworkSupport is true only when the check output states that Landlock
// TCP network rule support was verified.
func reportsNetworkSupport(out string) bool {
	lower := strings.ToLower(out)
	return strings.Contains(lower, "tcp network rule support verified")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// BuildArgs renders the nono argv for a policy and command. It is pure and
// exported so the flag surface is unit-testable without the binary.
//
// The result is `run -s --sandbox-policy landlock` plus one --allow per
// FSReadWrite, one --read per FSReadOnly, --block-net when the network policy
// is deny, then `--`, the command path and its arguments. --sandbox-policy
// external is never emitted (FC2).
//
// nono has no CLI deny flag (docs/compatibility/probes/sandbox/README.md):
// FSDeny entries are a configuration error under EnforceRequired and are
// dropped (with a note logged by Launch) otherwise.
func (l *Launcher) BuildArgs(policy domain.SandboxPolicy, cmd domain.CommandSpec) ([]string, error) {
	return l.buildArgs(policy, cmd)
}

// buildArgs is the shared implementation; verifyFlags are inserted after the
// policy flags and before `--` (used for --dry-run).
func (l *Launcher) buildArgs(policy domain.SandboxPolicy, cmd domain.CommandSpec, verifyFlags ...string) ([]string, error) {
	if len(policy.FSReadWrite) == 0 {
		return nil, fmt.Errorf("sandbox policy: FSReadWrite must not be empty: nono grants read-write workspace paths only, and a launch with no writable grant cannot run an agent")
	}
	if strings.TrimSpace(cmd.Path) == "" {
		return nil, fmt.Errorf("sandbox policy: command path must not be empty")
	}

	rw, err := absolutePaths(policy.FSReadWrite)
	if err != nil {
		return nil, fmt.Errorf("FSReadWrite: %w", err)
	}
	ro, err := absolutePaths(policy.FSReadOnly)
	if err != nil {
		return nil, fmt.Errorf("FSReadOnly: %w", err)
	}
	deny, err := absolutePaths(policy.FSDeny)
	if err != nil {
		return nil, fmt.Errorf("FSDeny: %w", err)
	}
	if len(deny) > 0 && policy.RequiredLevel == domain.EnforceRequired {
		return nil, fmt.Errorf("FSDeny: %w: deny-list requires a nono profile; not supported in M0 (%d paths cannot be enforced by CLI flags)",
			sandbox.ErrNotEnforceable, len(deny))
	}

	args := []string{"run", "-s", "--sandbox-policy", policyLandlock}
	for _, dir := range rw {
		args = append(args, "--allow", dir)
	}
	for _, dir := range ro {
		args = append(args, "--read", dir)
	}
	if policy.Network == domain.NetworkDeny {
		args = append(args, "--block-net")
	}
	args = append(args, verifyFlags...)
	args = append(args, "--", cmd.Path)
	return append(args, cmd.Args...), nil
}

// absolutePaths validates and cleans a grant list. Every entry must already be
// absolute and must not contain a .. component, either before or after
// filepath.Clean: nono silently ignores grant paths that do not resolve
// (finding FC3), so a path that walks upward is treated as a configuration
// error rather than something to be normalised away.
func absolutePaths(paths []string) ([]string, error) {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			return nil, fmt.Errorf("empty path")
		}
		if !filepath.IsAbs(p) {
			return nil, fmt.Errorf("%q: sandbox grant paths must be absolute", p)
		}
		for _, part := range strings.Split(p, string(filepath.Separator)) {
			if part == ".." {
				return nil, fmt.Errorf("%q: sandbox grant paths must not contain .. (neither before nor after filepath.Clean)", p)
			}
		}
		cleaned := filepath.Clean(p)
		for _, part := range strings.Split(cleaned, string(filepath.Separator)) {
			if part == ".." {
				return nil, fmt.Errorf("%q: sandbox grant paths must not contain .. after filepath.Clean", p)
			}
		}
		out = append(out, cleaned)
	}
	return out, nil
}

// requireDirInsideReadWrite enforces the nono "CWD access requires --allow-cwd"
// gotcha: when running under nono the working directory must already sit inside
// one of the read-write grants.
func requireDirInsideReadWrite(policy domain.SandboxPolicy, dir string) error {
	if strings.TrimSpace(dir) == "" {
		return fmt.Errorf("sandbox launch: cmd.Dir must be set to a directory inside FSReadWrite when running under nono (nono refuses a working directory outside the grants)")
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("sandbox launch: cmd.Dir %q must be absolute", dir)
	}
	dir = filepath.Clean(dir)
	for _, root := range policy.FSReadWrite {
		root = filepath.Clean(root)
		if dir == root || strings.HasPrefix(dir, root+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("sandbox launch: cmd.Dir %q is not inside any FSReadWrite grant %v (nono exits 1: CWD access requires --allow-cwd)", dir, policy.FSReadWrite)
}

// Launch starts cmd under policy. It never falls back to an unsandboxed run
// once required-mode verification has begun.
func (l *Launcher) Launch(ctx context.Context, policy domain.SandboxPolicy, cmd domain.CommandSpec) (domain.ProcessHandle, error) {
	switch policy.RequiredLevel {
	case domain.EnforceRequired:
		return l.launchRequired(ctx, policy, cmd)
	case domain.EnforcePermissiveDev:
		return l.launchPermissive(ctx, policy, cmd)
	case domain.EnforceDisabled:
		slog.Warn("unsandboxed execution: sandbox policy disabled by administrator",
			"backend", BackendName, "path", cmd.Path, "mode", string(policy.RequiredLevel))
		return l.launchDirect(ctx, cmd)
	default:
		return nil, fmt.Errorf("sandbox launch: unknown required level %q (want %s, %s or %s)",
			string(policy.RequiredLevel), domain.EnforceRequired, domain.EnforcePermissiveDev, domain.EnforceDisabled)
	}
}

// launchRequired verifies then runs. Any failed step aborts before exec.
func (l *Launcher) launchRequired(ctx context.Context, policy domain.SandboxPolicy, cmd domain.CommandSpec) (domain.ProcessHandle, error) {
	caps, err := l.Probe(ctx)
	if err != nil {
		return nil, errors.Join(
			fmt.Errorf("%w: required mode could not verify %s: %v", sandbox.ErrNotEnforceable, BackendName, err),
			err,
		)
	}
	if !caps.Filesystem {
		return nil, fmt.Errorf("%w: required mode needs verified filesystem isolation but %s reports filesystem=%v (version %q, notes: %s)",
			sandbox.ErrNotEnforceable, BackendName, caps.Filesystem, caps.Version, strings.Join(caps.Notes, "; "))
	}
	if policy.Network == domain.NetworkDeny && !caps.Network {
		return nil, fmt.Errorf("%w: required mode denies network but %s reports network=%v (version %q, notes: %s)",
			sandbox.ErrNotEnforceable, BackendName, caps.Network, caps.Version, strings.Join(caps.Notes, "; "))
	}

	if err := requireDirInsideReadWrite(policy, cmd.Dir); err != nil {
		return nil, err
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return nil, err
	}

	// Second verification gate: ask nono itself to validate the resolved
	// policy without executing the command.
	dry, err := l.buildArgs(policy, cmd, "--dry-run")
	if err != nil {
		return nil, err
	}
	out, err := l.run(ctx, verifyTimeout, cmd.Dir, cmd.Env, append([]string{bin}, dry...)...)
	if err != nil {
		return nil, errors.Join(
			fmt.Errorf("%w: %s run --dry-run refused the policy before launch: %v\noutput: %s",
				sandbox.ErrNotEnforceable, BackendName, err, strings.TrimSpace(out)),
			err,
		)
	}

	args, err := l.buildArgs(policy, cmd)
	if err != nil {
		return nil, err
	}
	return l.start(ctx, bin, cmd, args)
}

// launchPermissive runs under nono when the probe works and clearly-labelled
// insecure execution when it does not.
func (l *Launcher) launchPermissive(ctx context.Context, policy domain.SandboxPolicy, cmd domain.CommandSpec) (domain.ProcessHandle, error) {
	caps, err := l.Probe(ctx)
	if err != nil {
		slog.Warn("UNSANDBOXED permissive-dev execution",
			"backend", BackendName, "path", cmd.Path, "reason", err.Error(),
			"isolation", "none", "mode", string(policy.RequiredLevel))
		return l.launchDirect(ctx, cmd)
	}
	if len(policy.FSDeny) > 0 {
		slog.Warn("permissive-dev sandbox ignores FSDeny entries: nono has no CLI deny flag, a profile is required",
			"backend", BackendName, "paths", len(policy.FSDeny), "mode", string(policy.RequiredLevel))
	}
	if !caps.Filesystem || !caps.Network {
		slog.Warn("permissive-dev execution with unverified backend capabilities",
			"backend", BackendName, "path", cmd.Path, "filesystem", caps.Filesystem,
			"network", caps.Network, "notes", strings.Join(caps.Notes, "; "))
	}
	if err := requireDirInsideReadWrite(policy, cmd.Dir); err != nil {
		return nil, err
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return nil, err
	}
	args, err := l.buildArgs(policy, cmd)
	if err != nil {
		return nil, err
	}
	return l.start(ctx, bin, cmd, args)
}

// start launches `bin args...` as a child process. The Communication process
// itself is never restricted.
func (l *Launcher) start(ctx context.Context, bin string, cmd domain.CommandSpec, args []string) (domain.ProcessHandle, error) {
	argv := append([]string{bin}, args...)
	return startProcess(ctx, cmd, argv)
}

// launchDirect runs the command with no sandbox at all.
func (l *Launcher) launchDirect(ctx context.Context, cmd domain.CommandSpec) (domain.ProcessHandle, error) {
	if strings.TrimSpace(cmd.Path) == "" {
		return nil, fmt.Errorf("sandbox launch: command path must not be empty")
	}
	return startProcess(ctx, cmd, append([]string{cmd.Path}, cmd.Args...))
}
