// Package sandbox contains the Communication sandbox launcher adapters.
//
// A sandbox adapter launches **child** processes under an isolation policy
// and never applies restrictions (Landlock, seccomp, namespaces, ...) to the
// calling Communication API or worker process itself — those restrictions are
// irreversible for the process that installs them
// (communication-spec/05-workspaces-security-secrets.md "Sandbox backend —
// nono first prototype", decision D-011).
// The contract these adapters implement is domain.SandboxLauncher.
//
// Adapters are interchangeable behind that interface: nono (Linux Landlock)
// is the first prototype, with bubblewrap and OCI backends reserved for later
// comparison (ADR-0003). Observed, host-specific behaviour is recorded in
// docs/compatibility/SANDBOX.md and the exact CLI surface proven by the spike
// lives in docs/compatibility/probes/sandbox/README.md; capability claims must
// always come from a probe that was actually run, never from configuration
// alone (communication-spec/12-test-strategy.md).
//
// Enforcement modes are not a preference ladder: required fails closed and
// refuses to launch when enforcement cannot be verified, permissive-dev runs
// clearly-labelled insecure development executions, and disabled is an
// explicit administrator choice. Falling back from required to unsandboxed is
// forbidden.
package sandbox
