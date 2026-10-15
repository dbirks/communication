package acp

// Launcher describes one built-in ACP agent launcher: the executable the
// worker spawns and the pinned adapter it was observed at.
//
// These are M0 built-ins only. The authoritative registry moves to worker
// assets (agent launcher registry YAML) per ADR-0007 in a later milestone;
// this package keeps a minimal copy so `communication doctor` can run the M0
// proof-of-concept before worker assets exist.
//
// The Version field records the exact adapter version that was probed in
// docs/compatibility/ACP.md. It is an observation, not a support claim: a
// launcher listed here is not evidence that the adapter works on the current
// host, and nothing in this file may be cited as "all harnesses supported".
type Launcher struct {
	// ID is the stable launcher identifier used by profiles and CLI flags.
	ID string
	// DisplayName is the human-facing agent/harness name.
	DisplayName string
	// Executable is the program resolved from PATH (no shell).
	Executable string
	// Package is the upstream package that provides Executable.
	Package string
	// Version is the probed adapter version from docs/compatibility/ACP.md.
	Version string
	// Args are passed to Executable verbatim.
	Args []string
	// AskModeID is the session mode that makes this adapter send
	// session/request_permission for human review, observed in
	// docs/compatibility/ACP.md ("Permission modes"). Empty means the
	// launcher has no observed prompting mode, so a profile with
	// permission_mode 'ask' cannot be honoured on it and the worker must
	// fail closed rather than run in the adapter's permissive default.
	AskModeID string
	// Notes records observed caveats; never a capability guarantee.
	Notes string
}

// knownLaunchers are the M0 built-ins, taken from the rows probed in
// docs/compatibility/ACP.md (date 2026-10-14).
var knownLaunchers = []Launcher{
	{
		ID:          "claude",
		DisplayName: "Claude Code ACP adapter",
		Executable:  "claude-agent-acp",
		Package:     "@agentclientprotocol/claude-agent-acp",
		Version:     "0.90.0",
		AskModeID:   "default",
		Notes: "probed at protocolVersion 1 with loadSession advertised; auth rides the " +
			"ambient claude CLI login; adapter default mode auto never sends " +
			"session/request_permission (docs/compatibility/ACP.md)",
	},
	{
		ID:          "codex",
		DisplayName: "Codex ACP adapter",
		Executable:  "codex-acp",
		Package:     "@agentclientprotocol/codex-acp",
		Version:     "2.2.2",
		AskModeID:   "read-only",
		Notes: "probed at protocolVersion 1 with loadSession advertised; auth rode the " +
			"existing codex-cli login; adapter default mode agent never sends " +
			"session/request_permission (docs/compatibility/ACP.md)",
	},
}

// KnownLaunchers returns the built-in M0 launcher entries in report order.
// The result is a copy; callers may not mutate the registry.
func KnownLaunchers() []Launcher {
	return append([]Launcher(nil), knownLaunchers...)
}

// LookupLauncher resolves a launcher id (e.g. "claude"). ok is false for an
// unknown id.
func LookupLauncher(id string) (Launcher, bool) {
	for _, l := range knownLaunchers {
		if l.ID == id {
			return l, true
		}
	}
	return Launcher{}, false
}
