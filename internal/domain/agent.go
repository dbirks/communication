package domain

import (
	"context"
	"time"
)

// AgentLaunchSpec describes how to start one agent process and the scoped
// environment it may see. Adapters translate this into concrete ACP (or
// legacy CLI) launch mechanics; this type carries no SDK types.
type AgentLaunchSpec struct {
	// LauncherID identifies the agent launcher profile (e.g. "claude-acp").
	LauncherID string
	// Executable is the program to run (resolved by the adapter).
	Executable string
	// Args are command-line arguments passed to the executable verbatim.
	Args []string
	// Env is the scoped environment as "KEY=VALUE" entries.
	Env []string
	// WorkDir is the workspace directory the agent runs in.
	WorkDir string
	// AdditionalDirs are extra directories the sandbox may need to expose
	// (e.g. tool caches) beyond WorkDir.
	AdditionalDirs []string
}

// StopReason reports why an agent turn ended.
type StopReason string

// Stop reasons reported by AgentHandle.Prompt.
const (
	StopEndTurn   StopReason = "end_turn"
	StopCancelled StopReason = "cancelled"
	StopMaxTokens StopReason = "max_tokens"
	StopRefusal   StopReason = "refusal"
	StopOther     StopReason = "other"
)

// ConversationEvent is a normalized event observed on an agent conversation,
// independent of the underlying protocol.
//
// Kind is one of: "message_chunk", "thought_chunk", "tool_call",
// "tool_call_update", "plan", "permission_request", "unknown".
type ConversationEvent struct {
	// Seq is a monotonically increasing per-handle sequence number.
	Seq int64
	// Kind is the event category, one of the values listed above.
	Kind string
	// ToolCallID associates tool_call / tool_call_update events.
	ToolCallID string
	// Text carries chunk or summary text where applicable.
	Text string
	// At is when the event was observed.
	At time.Time
}

// AgentHandle is a live conversation with one running agent.
type AgentHandle interface {
	// Prompt sends one user turn and blocks until the turn completes,
	// returning the reason the agent stopped.
	Prompt(ctx context.Context, text string) (StopReason, error)
	// Cancel requests cancellation of the in-flight turn.
	Cancel(ctx context.Context) error
	// Events returns the normalized event stream for this conversation.
	Events() <-chan ConversationEvent
	// Close terminates the agent process and releases resources.
	Close() error
}

// AgentRuntime starts agent processes behind a common interface.
// Implementations are adapters (ACP, compatibility wrappers) and own all
// protocol-specific detail.
type AgentRuntime interface {
	// Start launches an agent per spec and returns a live handle.
	Start(ctx context.Context, spec AgentLaunchSpec) (AgentHandle, error)
}
