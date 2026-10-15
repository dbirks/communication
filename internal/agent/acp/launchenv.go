package acp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// envAllowlist is the set of names a launched agent may inherit *by name* when
// the worker has not built an explicit environment for it.
//
// The pre-M3 behaviour was `cmd.Env = os.Environ()` (internal/agent/acp
// runtime.go), which handed the agent the worker's whole environment —
// `COMMUNICATION_DATABASE_URL` included. ADR-0019 D1 names that as the leak to
// close, and a deny-list is the wrong shape for it: the worker's environment
// grows with every integration, so the leak would reappear with each one. This
// list is the allowlist form of the same rule — anything not named here is
// invisible to a child process, and adding an entry is a deliberate act.
var envAllowlist = []string{
	"PATH",
	"LANG",
	"LC_ALL",
	"TERM",
	"NODE_OPTIONS",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
}

// envDirPrefixes are inherited only when they point under the effective HOME,
// which the caller controls; a stray XDG_CONFIG_HOME in the worker's environment
// would otherwise hand the agent the worker's own config tree.
var envDirPrefixes = []string{"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"}

// MinimalEnv builds a child environment from the worker's own environment,
// filtered to the allowlist. Auth variables a launcher declares
// (Launcher.AuthEnvVars) are appended when the worker supplies their values;
// they are never picked up implicitly, because "which variable names matter" is
// registry knowledge (ADR-0019 D4).
//
// An explicitly-built launch environment (worker.LaunchEnv) is preferred
// everywhere the worker knows the workspace; this exists for the paths that do
// not — `communication doctor`, which launches an adapter with no workspace at
// all and legitimately rides the ambient harness login.
func MinimalEnv(authVars []string) []string {
	out := make([]string, 0, len(envAllowlist)+len(authVars))
	home := os.Getenv("HOME")
	for _, name := range envAllowlist {
		if v := os.Getenv(name); v != "" {
			out = append(out, name+"="+v)
		}
	}
	for _, name := range envDirPrefixes {
		v := os.Getenv(name)
		if v == "" || (home != "" && !strings.HasPrefix(v, home)) {
			continue
		}
		out = append(out, name+"="+v)
	}
	for _, kv := range authVars {
		if strings.Contains(kv, "=") {
			out = append(out, kv)
		}
	}
	return out
}

// EnvRequest is an explicitly built agent environment: the values a sandboxed
// turn needs and nothing else. Every field is optional; the derived ones
// (XDG_*, HOME) are placed under Home so the agent's state is inside the grant
// that covers it.
type EnvRequest struct {
	// Home is the agent's HOME — <agent_root>/home under a workspace. It is
	// applied here rather than by the caller so a launch cannot accidentally
	// hand the agent the *worker's* HOME, and under a sandbox it is applied by
	// the launcher's `env` hop instead (probe C-H1), which is why LaunchEnv
	// refuses a Home that is empty.
	Home string
	// OmitHome leaves `HOME` out of the returned list while still placing the
	// XDG directories under it.
	//
	// It exists because of the two HOMEs (probe C-H1). Under a sandbox the agent's
	// HOME is applied by the launcher's `env HOME=…` hop, which is the *only*
	// place that knows both paths; if the caller also named HOME here, the two
	// could disagree and the child would take whichever the exec order decides.
	// The launcher therefore refuses a caller-supplied HOME (see
	// nono.LaunchSpec.BuildLaunchArgv), and a sandboxed worker sets this flag so
	// the refusal can never fire on a mistake that is structurally prevented.
	// Without a sandbox there is no hop, so the flag stays false and HOME is the
	// grant-shaping value.
	OmitHome bool
	// Path is the child's PATH; empty uses the worker's, or a fixed default.
	Path string
	// GitIdentity is written as GIT_AUTHOR_*/GIT_COMMITTER_* so a sandboxed
	// `git commit` can attribute without a global config file beyond the seeded
	// one in Home.
	GitIdentity GitIdentityEnv
	// Auth are the launcher's declared credential-location variables, as
	// "NAME=value" — resolved by the caller from the registry, never by
	// scanning the environment.
	Auth []string
	// SecretEnv holds `env`-mode secret entries resolved for this unit
	// (ADR-0018 D4). They arrive here, in the launch environment, and are never
	// written into a file the journal can see.
	SecretEnv []string
	// Scratch is the unit's writable temp root, granted rw alongside Home. It sets
	// TMPDIR. Empty falls back to a `tmp` sibling of Home.
	//
	// This is not a convenience: the agent-turn profile deliberately excludes
	// nono's `system_write_linux` group, because that group is what makes the
	// default profile write-grant /tmp (probe C-TMP1/C-TMP3 — and C-TMP2 shows a
	// profile-level deny cannot beat the layered grant, so the only way to refuse
	// /tmp is not to ask for it). A harness that then tries to mkdir under /tmp
	// fails: Claude Code aborts at session/new with
	//   EACCES: permission denied, mkdir '/tmp/claude-1000'
	// Pointing TMPDIR inside the grants gives it a real temp directory and keeps
	// the /tmp refusal intact — which also satisfies ADR-0008's per-attempt
	// isolation better than a shared /tmp ever did.
	Scratch string
	// Extra is anything else the caller must set (e.g. APM's own hints). Names
	// colliding with the fields above lose.
	Extra []string
}

// GitIdentityEnv is the commit attribution a sandboxed agent gets. It is a
// struct so the same values feed both the environment and the seeded
// <home>/.gitconfig (probe P6: git aborts outright on an ungranted config).
type GitIdentityEnv struct {
	Name  string
	Email string
}

// LaunchEnv renders the explicit environment for one agent process.
//
// It is built from scratch — there is no call to os.Environ() in this function
// beyond reading PATH when the caller did not supply one, and that read is of a
// single named variable rather than the whole environment.
func LaunchEnv(req EnvRequest) ([]string, error) {
	if req.Home == "" {
		return nil, ErrNoAgentHome
	}
	if !filepath.IsAbs(req.Home) {
		return nil, ErrNoAgentHome
	}
	path := req.Path
	if path == "" {
		path = os.Getenv("PATH")
	}
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	home := filepath.Clean(req.Home)
	out := []string{
		"PATH=" + path,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		// Both adapters are Node CLIs; a missing TERM makes some libraries
		// assume "dumb", which is harmless here, but an *inherited* TERM from
		// the worker's terminal is not. This is the value we choose instead.
		"TERM=xterm-256color",
		"GIT_TERMINAL_PROMPT=0",
		// The seeded .gitconfig under Home carries the identity too; the env
		// form wins, and having both means a workspace whose home was wiped
		// still attributes commits rather than failing mid-turn.
		"GIT_CONFIG_NOSYSTEM=1",
	}
	if !req.OmitHome {
		out = append(out, "HOME="+home)
	}
	// TMPDIR is the harness's own temp root and must exist *before* the child
	// runs: nono grants by path, and granting a directory that does not exist yet
	// means the mkdir inside the sandbox has no write permission on its parent
	// (probe C-FC3's silent-drop class — a grant to a nonexistent path is a grant
	// to nothing).
	tmpRoot := req.Scratch
	if tmpRoot == "" {
		tmpRoot = home
	}
	if err := os.MkdirAll(filepath.Join(tmpRoot, "tmp"), 0o700); err != nil {
		return nil, fmt.Errorf("acp: create the unit's TMPDIR: %w", err)
	}
	out = append(out, "TMPDIR="+filepath.Join(tmpRoot, "tmp"))
	if req.GitIdentity.Name != "" {
		out = append(out, "GIT_AUTHOR_NAME="+req.GitIdentity.Name, "GIT_COMMITTER_NAME="+req.GitIdentity.Name)
	}
	if req.GitIdentity.Email != "" {
		out = append(out, "GIT_AUTHOR_EMAIL="+req.GitIdentity.Email, "GIT_COMMITTER_EMAIL="+req.GitIdentity.Email)
	}
	seen := map[string]bool{}
	for _, kv := range out {
		seen[strings.SplitN(kv, "=", 2)[0]] = true
	}
	appendUnique := func(kvs []string) {
		for _, kv := range kvs {
			name, _, ok := strings.Cut(kv, "=")
			if !ok || seen[name] || name == "HOME" {
				continue
			}
			seen[name] = true
			out = append(out, kv)
		}
	}
	// Order matters for the collision rule above: Extra is applied last and
	// loses to everything, so a secret named PATH cannot replace the
	// launcher's, and a workspace HOME cannot be overridden by a mount.
	appendUnique(req.Auth)
	appendUnique(req.SecretEnv)
	appendUnique(req.Extra)
	return out, nil
}

// AuthEnvFor resolves a launcher's declared credential variables against a
// source environment, returning "NAME=value" only for names that are actually
// set. A declared auth var that is absent is not an error here: whether the
// launcher can run without it is the sandbox planner's question, and the answer
// differs per launcher (ADR-0019 D4's credential custody gap).
func AuthEnvFor(l Launcher, env []string) []string {
	if len(l.AuthEnvVars) == 0 {
		return nil
	}
	want := map[string]bool{}
	for _, name := range l.AuthEnvVars {
		want[name] = true
	}
	have := map[string]string{}
	for _, kv := range env {
		name, value, ok := strings.Cut(kv, "=")
		if ok && want[name] && value != "" {
			have[name] = value
		}
	}
	var out []string
	for _, name := range l.AuthEnvVars {
		if v, ok := have[name]; ok {
			out = append(out, name+"="+v)
		}
	}
	return out
}

// AuthEnvFromOS reads the declared auth variables out of the worker's own
// environment. It is the only place this package looks at the process
// environment by design: the *values* are locations the operator configured
// (compose.harness.yml mounts), and the *names* come from the registry.
func AuthEnvFromOS(l Launcher) []string { return AuthEnvFor(l, os.Environ()) }

// WithLaunchPlan binds a verified launch plan to a context: the way the turn
// loop hands the argv it journalled to the session factory without widening
// domain.SessionRequest (internal/domain is outside this milestone's
// boundaries, and the plan is worker-side plumbing, not protocol contract).
type launchPlanKey struct{}

func WithLaunchPlan(ctx context.Context, p LaunchPlan) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, launchPlanKey{}, p)
}

// LaunchPlanFromContext reports the bound plan, if any.
func LaunchPlanFromContext(ctx context.Context) (LaunchPlan, bool) {
	p, ok := ctx.Value(launchPlanKey{}).(LaunchPlan)
	return p, ok && p.Path != ""
}
