package domain

import "context"

// NetworkPolicy describes a sandboxed process's network access.
type NetworkPolicy string

// Network policies.
const (
	NetworkDeny     NetworkPolicy = "deny"
	NetworkAllowAll NetworkPolicy = "allow_all"
)

// EnforcementMode is the minimum sandbox enforcement a launch requires.
type EnforcementMode string

// Enforcement modes.
const (
	// EnforceRequired fails closed: Launch must not start the process
	// unless real enforcement is verified.
	EnforceRequired EnforcementMode = "required"
	// EnforcePermissiveDev runs the process with best-effort isolation and
	// reports what could not be enforced. Development use only.
	EnforcePermissiveDev EnforcementMode = "permissive-dev"
	// EnforceDisabled runs the process unsandboxed. Development use only.
	EnforceDisabled EnforcementMode = "disabled"
)

// SandboxPolicy is the declarative isolation policy for one launched
// process.
type SandboxPolicy struct {
	// FSReadOnly lists paths mounted read-only inside the sandbox.
	FSReadOnly []string
	// FSReadWrite lists paths mounted read-write inside the sandbox.
	FSReadWrite []string
	// FSDeny lists paths that must be invisible to the sandboxed process.
	FSDeny []string
	// Network is the process's network access policy.
	Network NetworkPolicy
	// RequiredLevel is the minimum enforcement this launch demands.
	RequiredLevel EnforcementMode
}

// SandboxCapabilities is what a launcher backend can actually enforce, as
// observed by Probe. Verified is true only when the backend has demonstrated
// enforcement in a real probe, never merely because it is configured.
type SandboxCapabilities struct {
	// Backend names the implementation (e.g. "nono", "bwrap", "none").
	Backend string
	// Version is the backend's reported version, if any.
	Version string
	// Filesystem is true when filesystem restrictions are supported.
	Filesystem bool
	// Network is true when network restrictions are supported.
	Network bool
	// Verified is true only when enforcement was actually observed.
	Verified bool
	// Notes carries caveats, warnings and unsupported-policy details.
	Notes []string
}

// CommandSpec is the process to launch under a SandboxPolicy.
type CommandSpec struct {
	// Path is the executable to run.
	Path string
	// Args are command-line arguments passed verbatim (no shell).
	Args []string
	// Env is the process environment as "KEY=VALUE" entries.
	Env []string
	// Dir is the working directory.
	Dir string
}

// ProcessHandle represents a launched sandboxed process.
type ProcessHandle interface {
	// Wait blocks until the process exits.
	Wait() error
	// Kill terminates the process.
	Kill() error
}

// SandboxLauncher starts sandboxed child processes. It launches child
// processes only and never restricts the calling Communication process
// (communication-spec/05-workspaces-security-secrets.md).
//
// In RequiredLevel EnforceRequired mode, Launch must fail closed: if real
// enforcement cannot be verified, it returns an error and does not start the
// process. Claims of sandbox support require observed evidence, never
// configuration alone (communication-spec/12-test-strategy.md).
type SandboxLauncher interface {
	// Probe reports the backend's observed capabilities without launching
	// anything.
	Probe(ctx context.Context) (SandboxCapabilities, error)
	// Launch starts cmd under policy, subject to the policy's required
	// enforcement level.
	Launch(ctx context.Context, policy SandboxPolicy, cmd CommandSpec) (ProcessHandle, error)
}
