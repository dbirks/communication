package nono

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/dbirks/communication/internal/domain"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// LaunchSpec is one sandboxed launch: a profile, a resolved grant set, and the
// program to exec inside it.
//
// It is the M3 shape of ADR-0019 Decision 1's chain, and it replaces the
// `domain.SandboxPolicy` form for workspace launches because that struct cannot
// name what a workspace launch actually needs: which paths are *roles*, which
// HOME belongs to nono, and which belongs to the agent (C-H1's two HOMEs). The
// M2 path (BuildArgs from a domain.SandboxPolicy) stays for `doctor`, which has
// no workspace to reason about.
type LaunchSpec struct {
	// Profile is the already-materialized policy file (WriteProfile output).
	Profile *Profile
	// Plan is the resolved grant set from internal/workspace/git.
	Plan wsgit.LaunchPlan
	// LauncherHome is nono's own HOME. It is never a grant and never under a
	// workspace (C-H1: the refusal it triggers is sticky for the workspace).
	LauncherHome string
	// AdapterPath and AdapterArgs are the program to exec *inside* the
	// sandbox — the ACP adapter executable and its argv.
	AdapterPath string
	AdapterArgs []string
	// AdapterEnv is the environment for the adapter, applied through the
	// `env` hop. It is built from scratch by the worker; nothing is inherited
	// from the worker process.
	AdapterEnv []string
	// BlockNet adds --block-net. Only the egress-denied profile should ask.
	BlockNet bool
	// ToolReads are read-only grants for the *program* the sandbox is asked to
	// exec, as opposed to the workspace it works on. A process.exec command is
	// resolved from the worker's PATH (exec.LookPath), and a helper that lives
	// outside the workspace tree — the lab's /opt/m4/bin fixtures, a vendored
	// toolchain under /usr/local/share — is unreachable under Landlock unless
	// its own directory is granted, which is what `nono run` answers with
	// exit 126 (found, but not executable). Entries are the absolute
	// directories of the resolved executable and of the interpreter named by
	// its `#!` line; they carry read (which nono's Landlock ruleset pairs with
	// exec) and never write, and they are asserted as [user] rules by N-d like
	// every other per-launch grant.
	ToolReads []string
}

// BuildLaunchArgv renders the silent (real) argv: `run -s -p <path> <grants>
// [--block-net] -- env <KV…> <adapter> <args…>`.
//
// Two probe findings shape it:
//
//   - `-s` and the verbose dry-run are mutually exclusive (C-SILENT: the
//     silent argv prints 0 lines), so the verification argv is built by
//     BuildVerifyArgv and never by stripping a flag from this one.
//   - nono execs the program directly, so the agent's HOME cannot be set the
//     way `compose.harness.yml` sets it; C-H1c's `-- env HOME=… <argv>` hop is
//     the shell-free way to apply a per-run HOME to the child without ever
//     handing that path to nono as its own HOME.
func (s LaunchSpec) BuildLaunchArgv() ([]string, error) {
	return s.argv(false)
}

// BuildVerifyArgv renders N-d's argv: the same grants, `-v --dry-run`, and no
// `-s`, so the merged grant list is actually printed.
func (s LaunchSpec) BuildVerifyArgv() ([]string, error) {
	return s.argv(true)
}

func (s LaunchSpec) argv(verify bool) ([]string, error) {
	if s.Profile == nil {
		return nil, fmt.Errorf("sandbox: no profile materialized: refusing to launch with CLI flags alone (ADR-0009 D4 — nono mixes its built-in default profile in otherwise)")
	}
	if err := s.Profile.AssertOwnBytes(); err != nil {
		return nil, err
	}
	if err := s.Plan.Check(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(s.AdapterPath) == "" {
		return nil, fmt.Errorf("sandbox: no adapter executable to launch")
	}
	if s.LauncherHome == "" {
		return nil, fmt.Errorf("sandbox: nono's own HOME is unset; a launch that gives nono the agent's HOME refuses its own workspace grant (probe C-H1)")
	}

	args := []string{"run"}
	if verify {
		// C-SILENT: with -s this prints nothing, and an assertion against empty
		// output passes vacuously.
		args = append(args, "-v", "--dry-run")
	} else {
		args = append(args, "-s")
	}
	args = append(args, "-p", s.Profile.Path)
	// --sandbox-policy is pinned in the profile file, not repeated as a flag:
	// the flag and the file are two sources of truth, and C-FC2b showed no
	// nono surface reveals which one lost. `external` is never emitted from
	// either (FC2).
	for _, g := range s.Plan.Grants {
		// Every grant path must exist. FC3: nono silently ignores a grant that
		// does not resolve, so a typo would quietly narrow the policy.
		if _, err := os.Stat(g.Path); err != nil {
			return nil, fmt.Errorf("sandbox: grant %s (%s) is not usable: %w (probe C-FC3: nono silently ignores an unresolvable grant path, which would launch a narrower sandbox than the one that was verified)", g.Role, g.Path, err)
		}
		flag := "--allow"
		if g.Access() == wsgit.AccessReadOnly {
			flag = "--read"
		}
		args = append(args, flag, g.Path)
	}
	// The program's own directory, and its interpreter's, are read grants:
	// they buy exec, never write. FC3's rule applies here too — an
	// unresolvable path is a grant nono silently drops, so it is refused
	// before the launch rather than becoming a 126 inside the sandbox.
	for _, p := range s.ToolReads {
		if err := wsgit.CheckGrantPath(p); err != nil {
			return nil, fmt.Errorf("sandbox: tool read grant %s is not usable: %w (probe C-FC3: nono silently ignores an unresolvable grant path, which would launch a narrower sandbox than the one that was verified)", p, err)
		}
		args = append(args, "--read", p)
	}
	// --block-net is emitted only under a profile whose own recorded identity
	// says egress is denied (ADR-0019 D3: network is an axis with two names,
	// so a run can never be both), and a profile that says it MUST carry the
	// flag: the command profile cannot be launched with the network open any
	// more than the case-13 profile can.
	switch {
	case s.BlockNet && !s.Profile.NetworkEnforced:
		return nil, fmt.Errorf("sandbox: --block-net under profile %s would make an egress claim the recorded policy digest does not describe: use an egress-denied profile (%s or %s) (ADR-0019 D3: network is an axis with two names, so a run can never be both)", s.Profile.Kind, ProfileEgressDenied, ProfileCommand)
	case s.BlockNet:
		args = append(args, "--block-net")
	case s.Profile.NetworkEnforced:
		return nil, fmt.Errorf("sandbox: profile %s is an egress-denied policy but the launch did not request --block-net: launching it without the flag would silently widen the recorded policy", s.Profile.Kind)
	}
	// --allow-cwd is never emitted (C-CWD3: it is a grant, not an assertion —
	// with it, a launch directory outside the intended set became readable).
	// The cwd is inside a real rw grant, which Plan.Check enforces.

	args = append(args, "--", "env")
	for _, kv := range s.AdapterEnv {
		if strings.HasPrefix(kv, "HOME=") {
			return nil, fmt.Errorf("sandbox: HOME is applied by the launcher's env hop, not by the caller's env list, so nono's HOME and the agent's HOME cannot be confused (probe C-H1)")
		}
		if !strings.Contains(kv, "=") {
			return nil, fmt.Errorf("sandbox: adapter env entry %q is not KEY=VALUE", kv)
		}
		args = append(args, kv)
	}
	args = append(args, "HOME="+s.Plan.AgentHome)
	args = append(args, s.AdapterPath)
	return append(args, s.AdapterArgs...), nil
}

// GrantFlags is the grant set alone, as the flags that would carry it. The
// journal reports Labels; this exists for `doctor` to print what a workspace
// *would* be handed, and for the tests that assert the shape without a
// profile.
func GrantFlags(plan wsgit.LaunchPlan) []string {
	var out []string
	for _, g := range plan.Grants {
		flag := "--allow"
		if g.Access() == wsgit.AccessReadOnly {
			flag = "--read"
		}
		out = append(out, flag, g.Path)
	}
	return out
}

// LaunchPlan verifies the chain (N-a…N-d) and then execs the plan. It is the
// M3 entry point; `Launch` (the domain.SandboxLauncher path) stays for the
// doctor shape, which has no workspace to build grants from.
//
// There is no path through this function that runs the adapter without the
// verification having passed for *this* call: a probe says the backend can
// enforce, only the chain says this process went out under this policy
// (ADR-0009 D4). A failure returns the *Failure so the caller can journal the
// stage and reason, and it never falls back to an unsandboxed run —
// `permissive-dev` and `disabled` are configured modes, not recovery paths.
func (l *Launcher) LaunchPlan(ctx context.Context, spec LaunchSpec) (domain.ProcessHandle, *VerificationResult, error) {
	res, verr := l.Verify(ctx, spec)
	if verr != nil {
		var f *Failure
		if errors.As(verr, &f) {
			return nil, res, f
		}
		return nil, res, &Failure{Stage: StageGrantAssert, Reason: "grant_mismatch", Err: verr}
	}
	argv, err := spec.BuildLaunchArgv()
	if err != nil {
		return nil, res, &Failure{Stage: StageExec, Reason: "grant_mismatch", Err: err}
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return nil, res, &Failure{Stage: StageExec, Reason: "binary_missing", Err: err}
	}
	handle, err := startProcess(ctx, domain.CommandSpec{
		// nono's own environment: never the worker's, and never the agent's
		// HOME (C-H1's sticky refusal).
		Env: l.launcherEnv(spec),
		Dir: spec.Plan.Cwd,
	}, append([]string{bin}, argv...))
	if err != nil {
		return handle, res, &Failure{Stage: StageExec, Reason: "landlock_unavailable", Err: err, ChildStarted: false}
	}
	// From here a child exists, which is the distinction ADR-0019 D6's
	// child_started field exists to make: "we refused to start it" and "it died
	// after exec" are different failures and the ops page must not conflate
	// them.
	res.ChildStarted = true
	return handle, res, nil
}
