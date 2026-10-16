package acp

import (
	"errors"
	"fmt"
)

// ErrNoAgentHome reports a launch request with no agent HOME, which is not a
// detail: git aborts on an ungranted or unset HOME (probe P6 —
// `fatal: unknown error occurred while reading the configuration files`), so a
// launch environment without one would produce a turn that fails confusingly
// instead of a launch that fails honestly.
var ErrNoAgentHome = errors.New("acp: an explicit absolute agent HOME is required")

// ErrNoLaunchPlan reports a session request that arrived with no verified
// launch plan on a factory configured to demand one. It is the fail-closed half
// of the sandbox seam: without it, a plumbing mistake (a workspace prepared but
// no plan attached) would silently fall back to launching the adapter
// unsandboxed, which is the outcome ADR-0019 forbids.
var ErrNoLaunchPlan = errors.New("acp: this worker requires a verified sandbox launch plan for every session")

// LaunchPlan is the argv and environment a session process is really exec'd
// with, once the sandbox has had its say about it.
//
// It exists because the launch that reaches the kernel is not the launch the
// launcher registry describes: under ADR-0019 the worker wraps the adapter in
// `nono run -s -p <policy> <grants> -- env HOME=… <adapter> <args…>`, so the
// executable becomes nono and the argv grows. The runtime execs the plan
// verbatim and does not know a sandbox is involved, which is what keeps this
// package's dependency rule intact — it imports neither the sandbox adapters
// nor the workspace package (AGENTS.md).
//
// The turn loop computes the plan, verifies it, and journals it *before*
// attaching it here, so what the journal says and what the kernel saw are the
// same object.
type LaunchPlan struct {
	// Path and Args are what to exec: nono plus its argv under a sandbox, or
	// the adapter itself in a configured `disabled` mode.
	Path string
	Args []string
	// Env is the environment for that exec. Whoever builds the plan builds it
	// from scratch: the pre-M3 fallback of inheriting os.Environ() handed the
	// agent the worker's entire environment, `COMMUNICATION_DATABASE_URL`
	// included (ADR-0019 D1 names this as the leak to close).
	Env []string
	// Dir is the working directory. Under a sandbox it must sit inside one of
	// the read-write grants — probe C-CWD: in profile mode nono does not refuse
	// a cwd outside the grants, it relocates the child to `/`, so a wrong Dir
	// is a confusingly broken turn rather than a failed launch.
	Dir string
	// Verified is non-nil only when the sandbox verification chain passed for
	// this launch. The distinction is ADR-0009's: a *probe* says the backend
	// can enforce things; only a per-unit chain says this process went out
	// under this policy.
	Verified *Verification
	// Unsandboxed records an explicit `disabled`/`permissive-dev` choice,
	// which every event about it must label isolation="none"
	// (communication-spec/05). It is a string rather than a bool because the
	// mode name is what the ops page shows.
	Unsandboxed string
}

// Verification is the per-unit result of a sandbox verification chain, in the
// neutral shape the sandbox adapters fill in.
type Verification struct {
	Backend        string
	BackendVersion string
	// PolicyRef and PolicyDigest identify the policy content, per ADR-0019 D5.
	// A filename identifies nothing: the digest is what a unit's journal cites.
	PolicyRef    string
	PolicyDigest string
	// AfUnixMediation is the asserted value, from `nono profile show` (probe
	// C-AFU2: the verbose dry-run prints no AF_UNIX line at all, so the two
	// assertions cannot share a command).
	AfUnixMediation string
	// NetworkEnforcement is the *profile's* claim on the egress axis in the
	// ADR-0035 tri-state: "open", "allowlisted" or "denied". It is a string and
	// not a bool because the middle value is a real state a bool cannot name, and
	// it is the profile's claim, not the run's: what this run may report is the
	// pair below, and an allowlist whose audit showed no refusal keeps reporting
	// open / false (D-021 stays Provisional until the lab turn earns it).
	NetworkEnforcement string
	// EgressHosts is the allowlist committed to the profile digest.
	EgressHosts []string
	// NetworkClaim is what THIS run is allowed to report, in ADR-0035's
	// vocabulary: "open" | "denied" | "allowlisted:<hosts>". A run whose audit
	// journal recorded no refusal reports "open" even under an allowlisted
	// profile — the claim follows the evidence, never the configuration.
	NetworkClaim string
	// NetworkEnforced is the run-level bool the journal has always carried: true
	// only when NetworkClaim is "denied" or "allowlisted:…".
	NetworkEnforced bool
	// GrantLabels is the event-safe grant set: {role, access} pairs. Resolved
	// paths never appear in an event (contract deviation D14 — the journal is
	// streamed to every project member, and the browser is the least of its
	// readers).
	GrantLabels []string
	// CommitGranted is the ADR-0017 D4 axis as actually launched, so a journal
	// reader can tell a refused commit from an unconfigured one.
	CommitGranted bool
}

// Denial is a sandbox that refused to start. It is an error, and the turn loop
// maps it onto sandbox.enforcement_failed with the same stage/reason pair.
type Denial struct {
	Stage        string
	Reason       string
	Message      string
	PolicyDigest string
	Backend      string
	// ChildStarted is true only when a process was exec'd and then failed,
	// because ADR-0019 D6's event distinguishes "we never got there" from "it
	// died", and 12-test-strategy's case 13 asks exactly that question.
	ChildStarted bool
}

func (d *Denial) Error() string {
	if d == nil {
		return "acp: <nil> denial"
	}
	return fmt.Sprintf("acp: sandbox %s refused the launch (%s): %s", d.Stage, d.Reason, d.Message)
}
