package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// EnvAPMEgressAllow is the worker-owned APM-resolve egress allowlist: the
// comma-separated list of hostnames the apm-resolve profile publishes into
// `network.allow_domain` (ADR-0054 §B.2's worker-config allowlist, a sibling of
// ADR-0035's COMMUNICATION_AGENT_EGRESS_ALLOW, worker-level only — no pipeline
// document or agent profile ever names the hosts a resolve may fetch from).
const EnvAPMEgressAllow = "COMMUNICATION_APM_EGRESS_ALLOW"

// APMSandbox resolves APM lock requests for the worker (ADR-0054 §B.2): the
// resolve's pinned apm CLI execs through the worker's sandbox when the worker's
// enforcement mode requires it, and answers plainly when it does not. It is the
// worker half of the lock flow's sandbox discipline — the same N-a…N-d chain a
// command or agent launch runs, applied to a resolve instead of a unit — so a
// package ref that is about to be fetched never runs as a plain worker child.
type APMSandbox struct {
	// Sandbox is the verify seam (nil is only reachable in non-required modes,
	// where nothing verifies because nothing may claim).
	Sandbox AgentSandbox
	// LauncherHome is nono's own HOME (probe C-H1: never a grant).
	LauncherHome string
	// PolicyDir is where the profile file is materialized (ADR-0009 D4).
	PolicyDir string
	// SandboxPath is the nono executable, so argv and process agree.
	SandboxPath string
	// Enforcement is this worker's mode; a lock resolve may only run
	// sandboxed when it is required.
	Enforcement domain.EnforcementMode
	// EgressAllow overrides the apm-resolve egress allowlist. Empty means read
	// the environment, and an unset variable means the shipped package-source
	// allowlist. Operator configuration only: never pipeline or UI data.
	EgressAllow []string
	// Binary is the pinned apm executable (the vendored path, or the
	// COMMUNICATION_APM_BINARY override). Empty means apm.Binary.
	Binary string
	// Timeout bounds one resolve install. A hung resolve would otherwise hold
	// a lease doing nothing.
	Timeout time.Duration
	// Logger replaces the resolve logger; nil keeps slog.Default.
	Logger *slog.Logger

	profileOnce *profileCache
	memoMu      sync.Mutex
}

var _ APMLockResolver = (*APMSandbox)(nil)

// Wrap answers one resolve's launcher-wrapper request. Under the worker's
// `required` enforcement it returns the wrapper that builds the apm-resolve
// sandboxed launch; under any other mode it returns nil, which makes the resolve
// run plain and report Sandboxed=false. A required resolve that cannot be
// sandboxed fails the wrapper with the named error instead of answering.
func (s *APMSandbox) Wrap(ctx context.Context, req apm.ResolveRequest) (APMLockResolveWrap, error) {
	if s.enforcement() != domain.EnforceRequired {
		return nil, nil
	}
	if s.Sandbox == nil {
		return nil, errors.New("apm resolve could not be sandboxed: enforcement is required but no sandbox backend is configured (ADR-0019 D6, no fallback exists)")
	}
	return func(argv []string, env []string) (string, []string, []string, error) {
		return s.launchResolve(ctx, req, argv, env)
	}, nil
}

// Resolve runs one APM lock resolve through this worker's sandbox discipline
// (ADR-0054 §B.2): under `required` the pinned apm CLI execs inside a nono
// sandboxed child with the resolve's scratch work dir + scratch home granted rw
// and the package source allowlisted (never --block-net, which would stop the
// fetch the resolve exists to make); under any other mode it resolves plainly and
// reports the result with Sandboxed=false.
func (s *APMSandbox) Resolve(ctx context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error) {
	if s.enforcement() != domain.EnforceRequired {
		// The worker's mode does not demand a sandboxed resolve: answer plainly,
		// and let the result record that the resolve did not run sandboxed.
		return apm.Resolve(ctx, req)
	}
	wrap, err := s.Wrap(ctx, req)
	if err != nil {
		return nil, err
	}
	if wrap == nil {
		return nil, errors.New("apm resolve could not be sandboxed: the enforcement is required but no launcher wrapper could be built")
	}
	if s.Binary != "" {
		if req.APMPath == "" {
			req.APMPath = s.Binary
		}
		if req.Timeout == 0 {
			req.Timeout = s.Timeout
		}
	}
	req.Wrap = wrap
	return apm.Resolve(ctx, req)
}

// launchResolve builds the sandboxed launch for one resolve install: the
// apm-resolve profile, the resolve's scratch work dir + scratch home as rw grants,
// the pinned apm binary's directory as a read grant, and the package-source
// egress allowlist — then returns the exec tuple the resolve execs. The launch
// goes through the full verify chain (N-a…N-d) and refuses to return a wrapper
// whose launch could not be verified, so a resolve can never be answered by a
// launch the worker did not verify.
func (s *APMSandbox) launchResolve(ctx context.Context, req apm.ResolveRequest, argv []string, env []string) (string, []string, []string, error) {
	installArgs := argv
	bin := req.APMPath
	if bin == "" {
		bin = apm.Binary
	}
	if s.Binary != "" {
		bin = s.Binary
	}
	binPath, err := exec.LookPath(bin)
	if err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: the pinned apm binary %q is not runnable: %w", bin, err)
	}
	// The lab's real-image resolve died with `WARN apm lock resolve failed … error: "apm: resolve failed: env: '/usr/local/bin/apm': Permission denied"`:
	// the worker image ships the pinned apm as a symlink (/usr/local/bin/apm ->
	// /opt/apm/apm) and apm 0.34 is a PyInstaller onedir bundle (apm + _internal/),
	// and Landlock checks exec/read on the RESOLVED target, so a grant on the
	// symlink's own directory (/usr/local/bin) never reached /opt/apm/apm nor its
	// libraries, and the exec came back Permission denied. Resolve before the
	// launch is built: the launch execs the resolved path and the tool-read grant
	// covers the resolved binary's directory tree (/opt/apm, which holds _internal/),
	// the same base system-read set the agent-turn kind grants (/usr, /lib, the
	// CA bundle, /etc/resolv.conf — via the default layer the apm-resolve profile
	// extends) for whatever the apm bootstrap reads at startup.
	resolved, err := filepath.EvalSymlinks(binPath)
	if err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: the pinned apm binary %q does not resolve: %w", bin, err)
	}
	binPath = filepath.Clean(resolved)
	prof, err := s.profile()
	if err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: materializing the apm-resolve policy: %w", err)
	}
	spec := nono.LaunchSpec{
		Profile: prof,
		Plan: wsgit.LaunchPlan{
			// The resolve has no run workspace to bind: the grants it asks for
			// are the scratch work dir and the scratch home alone.
			Grants: []wsgit.Grant{
				{Role: wsgit.RoleScratch, Path: req.WorkDir},
				{Role: wsgit.RoleAgentHome, Path: req.Home},
			},
			LauncherHome:  s.LauncherHome,
			AgentHome:     req.Home,
			Cwd:           req.WorkDir,
			CommitGranted: false,
		},
		LauncherHome: s.LauncherHome,
		AdapterPath:  binPath,
		AdapterArgs:  installArgs,
		AdapterEnv:   adapterEnvForLaunch(env),
		ToolReads:    []string{filepath.Dir(binPath)},
		BlockNet:     false, // a resolve must fetch: never --block-net (ADR-0054 §B.2)
	}
	if err := spec.Plan.Check(); err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: the resolve launch plan is not grantable: %w", err)
	}
	if _, err := s.Sandbox.Verify(ctx, spec); err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: the sandbox verification refused the resolve launch: %w", err)
	}
	launchArgv, err := spec.BuildLaunchArgv()
	if err != nil {
		return "", nil, nil, fmt.Errorf("apm resolve could not be sandboxed: the resolve launch argv: %w", err)
	}
	return s.sandboxBinary(), launchArgv, s.nonoLauncherEnv(), nil
}

// apmEgressAllow resolves the apm-resolve egress allowlist: the field if it
// was set, else the environment, else the shipped package-source allowlist.
func (s *APMSandbox) apmEgressAllow() ([]string, error) {
	configured := s.EgressAllow
	if len(configured) == 0 {
		if raw, ok := os.LookupEnv(EnvAPMEgressAllow); ok && strings.TrimSpace(raw) != "" {
			configured = strings.Split(raw, ",")
		}
	}
	if len(configured) == 0 {
		return nono.DefaultAPMEgressHosts(), nil
	}
	hosts, err := nono.NormalizeEgressHosts(configured)
	if err != nil {
		return nil, fmt.Errorf("worker: %s: %w", EnvAPMEgressAllow, err)
	}
	if len(hosts) == 0 {
		return nil, fmt.Errorf("worker: %s names no host: an apm resolve must allowlist the package source", EnvAPMEgressAllow)
	}
	return hosts, nil
}

// apmEgressAllowHosts is the allowlist the memoized apm-resolve profile was
// materialized with; the memo caches by kind and the allowlist is fixed per
// worker boot, so recomputing on a cache miss is the honest shape.
func (s *APMSandbox) apmEgressAllowHosts() []string {
	hosts, err := s.apmEgressAllow()
	if err != nil {
		return nil
	}
	return hosts
}

// profile materializes the apm-resolve policy file once per process, memoized
// per kind like the unit service does for the agent-turn and command kinds.
func (s *APMSandbox) profile() (*nono.Profile, error) {
	s.memoMu.Lock()
	if s.profileOnce == nil {
		s.profileOnce = &profileCache{}
	}
	cache := s.profileOnce
	s.memoMu.Unlock()
	return cache.do(nono.ProfileAPMResolve, func() (*nono.Profile, error) {
		return nono.WriteProfileNetwork(s.PolicyDir, nono.ProfileAPMResolve, nono.NetworkAllowlisted, s.apmEgressAllowHosts())
	})
}

func (s *APMSandbox) enforcement() domain.EnforcementMode {
	if s.Enforcement == "" {
		return domain.EnforceRequired
	}
	return s.Enforcement
}

func (s *APMSandbox) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// sandboxBinary is the nono executable the resolve's launch runs under.
func (s *APMSandbox) sandboxBinary() string {
	if s.SandboxPath != "" {
		return s.SandboxPath
	}
	return "nono"
}

// nonoLauncherEnv is nono's own environment for the resolve's launch — never the
// apm child env and never os.Environ(): the HOME here is what nono derives its
// protected state root from (probe C-H1), and the apm child gets HOME=<agent
// home> through the launcher's env hop.
func (s *APMSandbox) nonoLauncherEnv() []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	home := s.LauncherHome
	if home == "" {
		return []string{"PATH=" + path}
	}
	return []string{
		"PATH=" + path,
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
	}
}

// adapterEnvForLaunch turns the apm child environment into the launch env KVs:
// HOME is applied by the launcher's env hop (BuildLaunchArgv appends
// HOME=<agent home> after the KVs and refuses a caller-supplied HOME), so the
// child env's HOME entry is dropped here and the hop's HOME=<agent home> carries
// the resolve's scratch home.
func adapterEnvForLaunch(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "HOME=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}
