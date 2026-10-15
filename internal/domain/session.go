package domain

import "context"

// Session types are the worker-side contract for "launch one live ACP
// conversation" (communication-spec/04-agent-runtime.md, ADR-0015,
// ADR-0016 §6). They carry no protocol SDK types: adapters implement
// AgentSessionFactory against this contract and the worker package consumes
// only what is here (AGENTS.md dependency rule).

// PermissionOption is one choice the harness offered for a permission prompt,
// normalised out of the protocol. Kind is the semantic kind (allow_once,
// allow_always, reject_once, ...) — the option the answer echoes back is
// OptionID, but callers must key behaviour on Kind, because observed harness
// ids disagree with their kinds (docs/compatibility/ACP.md: Codex names its
// reject option literally "cancel").
type PermissionOption struct {
	OptionID string
	Label    string
	Kind     string
}

// PermissionPrompt is a harness request to allow an action. The M2 `ask`
// permission mode routes every prompt to the conversation's current
// controller (ADR-0016 §5); the decider below is that bridge.
type PermissionPrompt struct {
	ToolCallID string
	Title      string
	Kind       string
	Options    []PermissionOption
}

// PermissionChoice is the client's answer to a PermissionPrompt. An empty
// OptionID means the request was refused at the protocol level (the ACP
// "cancelled" outcome), which is what a deadline, a rejection with no
// matching option, or a cancelled turn must produce — never a fabricated
// option id.
type PermissionChoice struct {
	OptionID string
}

// PermissionDecider answers permission prompts. It may block until its
// context ends; ctx cancellation means the turn is over and the prompt is
// moot, so the implementation must return quickly and the harness sees the
// cancelled outcome. A returned error also resolves to the cancelled
// outcome.
type PermissionDecider func(ctx context.Context, prompt PermissionPrompt) (PermissionChoice, error)

// SessionRequest is one launch of an ACP conversation.
type SessionRequest struct {
	// LauncherID selects the pinned adapter (the launcher registry key, e.g.
	// "claude").
	LauncherID string
	// WorkDir is the agent's working directory — the prepared per-conversation
	// workspace root (05 layout).
	WorkDir string
	// ModeID switches the session into a prompting mode when non-empty
	// (session/set_mode). It is empty for permission modes that do not need
	// a harness mode, and a session whose prompting mode cannot be set must
	// fail closed, not silently run in the adapter's permissive default
	// (docs/compatibility/ACP.md "Permission modes").
	ModeID string
	// LoadSessionID asks the adapter to restore a previous session id via
	// session/load when the agent advertised loadSession; an empty value or
	// an unadvertised capability means session/new. A failed load is not an
	// error the worker should die on — the factory falls back to a new
	// session and Origin says which happened.
	LoadSessionID string
	// Decider answers session/request_permission for this session's whole
	// lifetime. Nil means the runtime's default policy (deny).
	Decider PermissionDecider
}

// SessionInfo is what was actually negotiated at session setup. It is
// evidence, not a capability claim: AgentCapabilities is the agent's own
// initialize answer as observed (04).
type SessionInfo struct {
	ACPSessionID      string
	ProtocolVersion   int
	AgentCapabilities map[string]any
	LauncherID        string
	LauncherVersion   string
	// Origin is "new" (session/new) or "resumed" (session/load succeeded).
	Origin string
	// ModeID is the prompting mode the session was switched to, "" when none
	// was requested.
	ModeID string
}

// AgentSession is a live agent conversation plus its observed handshake. It
// stays alive across turns on its worker (ADR-0016: one live instance per
// conversation).
type AgentSession interface {
	AgentHandle
	// Info reports the negotiated session facts.
	Info() SessionInfo
}

// AgentSessionFactory launches (or restores) one live session.
type AgentSessionFactory interface {
	NewSession(ctx context.Context, req SessionRequest) (AgentSession, error)
}
