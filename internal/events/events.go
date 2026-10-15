// Package events defines the durable event envelope shared by the
// `domain_events` journal, the `outbox` and the project SSE stream
// (communication-spec/09-api-events-data.md "Durable event envelope",
// ADR-0014).
//
// The envelope shape is fixed by api/schemas/event-envelope.schema.json and
// the JSON field names here must match it exactly; events_test.go checks them
// against the schema file rather than against a hand-copied list.
//
// M1 modelled only the envelope: a payload was written as JSON and read back
// unmodified. From M2 on the payload shapes of the event types that cross a
// process boundary (control plane -> journal -> worker -> SSE -> browser) are
// modelled here too, so the control plane and the worker emit identical shapes
// rather than each inventing one. Payloads of later milestones (runs, artifacts,
// approvals from pipelines) stay unmodelled until those types are introduced.
package events

import "time"

// Actor is the "who" of an event. Kind is one of ActorKind* and ID is the
// internal id for humans/agents/workers, an integration key for integrations,
// or the literal "system".
type Actor struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Actor kinds allowed by the journal's check constraint and the envelope
// schema's enum.
const (
	ActorKindHuman       = "human"
	ActorKindSystem      = "system"
	ActorKindAgent       = "agent"
	ActorKindIntegration = "integration"
	ActorKindWorker      = "worker"
)

// Human returns the actor for a signed-in user.
func Human(userID string) Actor {
	return Actor{Kind: ActorKindHuman, ID: userID}
}

// ValidActorKind reports whether kind is one of the five journal-legal actor
// kinds.
func ValidActorKind(kind string) bool {
	switch kind {
	case ActorKindHuman, ActorKindSystem, ActorKindAgent, ActorKindIntegration, ActorKindWorker:
		return true
	default:
		return false
	}
}

// Envelope is one journal row (and one SSE `data:` frame).
//
// Optional members are omitted from JSON when empty rather than emitted as
// null, which the schema allows because none of them is required. `payload`
// is required by the schema, so it must never be nil: AppendEvent substitutes
// an empty object.
type Envelope struct {
	EventID        string    `json:"event_id"`
	GlobalSeq      int64     `json:"global_seq"`
	Type           string    `json:"type"`
	SchemaVersion  int       `json:"schema_version"`
	OccurredAt     time.Time `json:"occurred_at"`
	OrganizationID string    `json:"organization_id"`
	ProjectID      string    `json:"project_id,omitempty"`
	ConversationID string    `json:"conversation_id,omitempty"`
	Actor          Actor     `json:"actor"`
	TraceID        string    `json:"trace_id,omitempty"`
	Payload        any       `json:"payload"`
}

// New is the input to AppendEvent: everything the database does not generate
// for itself. event_id, global_seq, schema_version and occurred_at are
// assigned by Postgres defaults and returned in the Envelope.
type New struct {
	Type           string
	OrganizationID string
	ProjectID      string
	// ConversationID scopes an event to one conversation's transcript, which
	// is the same domain_events journal read through
	// GET /api/v1/conversations/{conversationId}/events (ADR-0016). ProjectID
	// must still be set for a conversation event — the project is the
	// authorization scope and the ordering lock; ConversationID narrows the
	// stream, it never replaces it.
	//
	// The writer in internal/store/postgres/events.go lists this column in the
	// journal INSERT, so an append that sets it is readable by the conversation
	// stream; an append that leaves it empty stays out of every conversation
	// stream — correct for project-level events, a silent bug for conversation
	// ones (TestConversationAppendPersistsScopeIsTheObligation).
	//
	// Wake-ups are *not* scoped here: the domain_events_notify trigger from
	// migration 00001 emits pg_notify('communication_events', <global_seq>) for
	// every inserted row, and postgres.EventWake turns that one channel into
	// wake-ups for both the project and the conversation streams. Narrowing the
	// notification would be an optimization, never a correctness requirement —
	// every consumer re-queries the journal by sequence (ADR-0014 §9).
	ConversationID string
	Actor          Actor
	Payload        any
}

// M1 event types (communication-spec/09-api-events-data.md, M1 design
// contract). Later milestones add run/conversation/agent types here.
const (
	TypeProjectCreated       = "project.created"
	TypeProjectMemberUpdated = "project.member.updated"
	TypeRepositoryAdded      = "repository.added"
)

// ---------------------------------------------------------------- M2 events

// M2 event types (ADR-0016): the conversation transcript, its controller lock,
// turn lifecycle and ACP session bindings. Every conversation-scoped row also
// carries project_id, so the project stream remains a complete superset.
//
// The transcript is this journal with conversation_id set (not a second table):
// one journal means one gap-safe replay mechanism (ADR-0014 §9) and "restarting
// API pods loses no transcript" is then a property of the existing machinery
// rather than a new promise (communication-spec/11-build-roadmap.md M2 exit).
const (
	// Conversation lifecycle and control.
	TypeConversationCreated            = "conversation.created"
	TypeConversationControlTransferred = "conversation.control.transferred"

	// Transcript content.
	TypeConversationMessageUser  = "conversation.message.user"
	TypeConversationMessageAgent = "conversation.message.agent"
	TypeConversationThought      = "conversation.thought"
	TypeConversationToolCall     = "conversation.tool.call"
	TypeConversationToolUpdate   = "conversation.tool.update"

	// Human decision prompts (spec 09's approval pair, named for the harness).
	TypeConversationPermissionRequested = "conversation.permission.requested"
	TypeConversationPermissionDecided   = "conversation.permission.decided"

	// Turn lifecycle. Exactly one terminal turn event closes a turn:
	// completed, cancelled, failed or interrupted. "interrupted" is the honest
	// one — a lease that expired or a worker that went away, never a success
	// and never "resumed without loss" (02 "Execution recovery semantics").
	TypeConversationTurnStarted     = "conversation.turn.started"
	TypeConversationTurnCompleted   = "conversation.turn.completed"
	TypeConversationTurnCancelled   = "conversation.turn.cancelled"
	TypeConversationTurnFailed      = "conversation.turn.failed"
	TypeConversationTurnInterrupted = "conversation.turn.interrupted"

	// Agent instance attach/detach. Names kept from 09's event list.
	TypeAgentSessionConnected    = "agent.session.connected"
	TypeAgentSessionDisconnected = "agent.session.disconnected"
)

// Controller kinds for conversation_control.controller_kind and the transfer
// payload. Run attempts do not exist in M2, but the kind is reserved now so
// M4 does not rename the wire (01: controller = factory_run | human | none).
const (
	ControllerKindNone       = "none"
	ControllerKindHuman      = "human"
	ControllerKindRunAttempt = "run_attempt"
)

// ValidControllerKind reports whether kind is one of the three kinds the
// control row allows.
func ValidControllerKind(kind string) bool {
	switch kind {
	case ControllerKindNone, ControllerKindHuman, ControllerKindRunAttempt:
		return true
	default:
		return false
	}
}

// Turn statuses (conversation_turns.status). queued -> leased -> running is
// the only forward path to a terminal status; the four terminals are final.
const (
	TurnStatusQueued      = "queued"
	TurnStatusLeased      = "leased"
	TurnStatusRunning     = "running"
	TurnStatusCompleted   = "completed"
	TurnStatusCancelled   = "cancelled"
	TurnStatusFailed      = "failed"
	TurnStatusInterrupted = "interrupted"
)

// ValidTurnStatus reports whether status is one of the seven turn states.
func ValidTurnStatus(status string) bool {
	switch status {
	case TurnStatusQueued, TurnStatusLeased, TurnStatusRunning,
		TurnStatusCompleted, TurnStatusCancelled, TurnStatusFailed, TurnStatusInterrupted:
		return true
	default:
		return false
	}
}

// PermissionStatus* are permission_requests.status values.
const (
	PermissionStatusPending   = "pending"
	PermissionStatusDecided   = "decided"
	PermissionStatusExpired   = "expired"
	PermissionStatusCancelled = "cancelled"
)

// ValidPermissionStatus reports whether status is a legal permission state.
func ValidPermissionStatus(status string) bool {
	switch status {
	case PermissionStatusPending, PermissionStatusDecided,
		PermissionStatusExpired, PermissionStatusCancelled:
		return true
	default:
		return false
	}
}

// SessionOrigin* records how an ACP session came to exist (04 "Session reuse
// semantics"). A resume that fails is recorded as a new session; M2 never
// claims a silent resume.
const (
	SessionOriginNew     = "new"
	SessionOriginResumed = "resumed"
)

// ValidSessionOrigin reports whether origin is a legal binding origin.
func ValidSessionOrigin(origin string) bool {
	return origin == SessionOriginNew || origin == SessionOriginResumed
}

// BindingStatus* are acp_session_bindings.status values. 'closed' is the
// terminal state after a graceful shutdown or drain; 'disconnected' is the
// state the reconciler records when a lease expired or a worker vanished.
const (
	BindingStatusConnected    = "connected"
	BindingStatusDisconnected = "disconnected"
	BindingStatusClosed       = "closed"
)

// ValidBindingStatus reports whether status is a legal binding state.
func ValidBindingStatus(status string) bool {
	switch status {
	case BindingStatusConnected, BindingStatusDisconnected, BindingStatusClosed:
		return true
	default:
		return false
	}
}

// TransferReason* are the reasons a control transfer is recorded with
// (communication-spec/06 "Human takeover sequence").
const (
	// TransferTaken: a human seized control from another human or from none.
	TransferTaken = "taken"
	// TransferReturned: a human released control back to the previous
	// controller (or to none).
	TransferReturned = "returned"
	// TransferLostLease: the reconciler revoked control because its worker
	// stopped proving it was alive.
	TransferLostLease = "lost_lease"
)

// ValidTransferReason reports whether reason is one of the M2 reasons.
func ValidTransferReason(reason string) bool {
	switch reason {
	case TransferTaken, TransferReturned, TransferLostLease:
		return true
	default:
		return false
	}
}

// InterruptReason* are why a turn was interrupted rather than reported.
const (
	// InterruptLeaseExpired: the reconciler found an expired lease.
	InterruptLeaseExpired = "lease_expired"
	// InterruptWorkerGone: the worker's heartbeat went stale, so no process is
	// left to report the outcome.
	InterruptWorkerGone = "worker_gone"
	// InterruptShutdown: the worker drained or stopped on purpose and marked
	// its own running turns honestly before exiting.
	InterruptShutdown = "shutdown"
)

// ValidInterruptReason reports whether reason is one of the M2 reasons.
func ValidInterruptReason(reason string) bool {
	switch reason {
	case InterruptLeaseExpired, InterruptWorkerGone, InterruptShutdown:
		return true
	default:
		return false
	}
}

// PermissionOption is one choice an agent offered for a permission prompt,
// normalised from the ACP request. The option_id is what the API's decision
// body echoes back, so the worker can answer the harness verbatim.
type PermissionOption struct {
	OptionID string `json:"option_id"`
	Label    string `json:"label"`
	// Kind is the ACP option kind (allow_once, reject_once, ...) as observed.
	// Empty when the harness did not label the option.
	Kind string `json:"kind,omitempty"`
}

// ConversationCreatedPayload is conversation.created, appended in the same
// transaction as the conversation and control rows.
type ConversationCreatedPayload struct {
	ConversationID   string `json:"conversation_id"`
	ProjectID        string `json:"project_id"`
	Title            string `json:"title"`
	AgentProfileID   string `json:"agent_profile_id"`
	AgentProfileName string `json:"agent_profile_name"`
	LauncherID       string `json:"launcher_id"`
	ControllerUserID string `json:"controller_user_id"`
	// ControlVersion is conversation_control.version as created (1), so a
	// viewer's first take-control/return-control has a CAS token to send.
	ControlVersion int `json:"control_version"`
}

// ControlTransferredPayload is conversation.control.transferred. from/to are
// kind+id pairs because the controller is not always a user (01).
type ControlTransferredPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id,omitempty"`
	FromKind       string `json:"from_kind"`
	FromUserID     string `json:"from_user_id,omitempty"`
	ToKind         string `json:"to_kind"`
	ToUserID       string `json:"to_user_id,omitempty"`
	Reason         string `json:"reason"`
	// ControlVersion is the version the transfer produced, i.e. the CAS token
	// the new controller must send on its next control mutation.
	ControlVersion int `json:"control_version"`
}

// MessageUserPayload is conversation.message.user: the prompt the controller
// submitted. It is the turn's prompt, so the transcript and the queued work
// can never disagree.
type MessageUserPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	SubmittedBy    string `json:"submitted_by"`
	Text           string `json:"text"`
}

// MessageAgentPayload is conversation.message.agent: one readable chunk of the
// agent's answer. The worker coalesces token-level updates into these chunks
// (09: "worker may batch/coalesce to reduce DB costs, while preserving
// readable transcript order"), so ChunkSeq orders chunks within one turn and
// Truncated marks a chunk the worker had to cut.
type MessageAgentPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	ChunkSeq       int    `json:"chunk_seq"`
	Text           string `json:"text"`
	Truncated      bool   `json:"truncated"`
	// Final marks the last chunk of a completed turn's answer.
	Final bool `json:"final"`
}

// ThoughtPayload is conversation.thought: agent reasoning surfaced by the
// harness. Some harnesses stream thoughts verbatim; treat Text as a chunk and
// never as evidence of what the agent did (only tool calls are).
type ThoughtPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	ChunkSeq       int    `json:"chunk_seq"`
	Text           string `json:"text"`
	Truncated      bool   `json:"truncated"`
}

// ToolCallPayload is conversation.tool.call: a tool invocation the agent
// announced. InputPreview is a bounded, redacted rendering for humans — the
// journal never stores a full tool payload or a secret (ADR-0013 Security).
type ToolCallPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	ToolCallID     string `json:"tool_call_id"`
	Title          string `json:"title"`
	Kind           string `json:"kind,omitempty"`
	Status         string `json:"status"`
	InputPreview   string `json:"input_preview,omitempty"`
	Truncated      bool   `json:"truncated"`
}

// ToolUpdatePayload is conversation.tool.update: a status change for a tool
// call already on screen. UpdateSeq orders updates for one call within a turn.
type ToolUpdatePayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	ToolCallID     string `json:"tool_call_id"`
	Status         string `json:"status"`
	Title          string `json:"title,omitempty"`
	OutputPreview  string `json:"output_preview,omitempty"`
	Truncated      bool   `json:"truncated"`
	UpdateSeq      int    `json:"update_seq"`
}

// PermissionRequestedPayload is conversation.permission.requested. Only the
// current controller may answer it (06), and DeadlineAt is when the offer
// stops being actionable — a prompt must not hang forever (04).
type PermissionRequestedPayload struct {
	ConversationID      string             `json:"conversation_id"`
	TurnID              string             `json:"turn_id"`
	PermissionRequestID string             `json:"permission_request_id"`
	ToolCallID          string             `json:"tool_call_id,omitempty"`
	Title               string             `json:"title"`
	Kind                string             `json:"kind,omitempty"`
	Options             []PermissionOption `json:"options"`
	DeadlineAt          string             `json:"deadline_at,omitempty"`
}

// PermissionDecidedPayload is conversation.permission.decided: the human answer
// (status decided) or the reason the request closed without one (expired,
// cancelled), which is why Outcome is not simply the decision.
type PermissionDecidedPayload struct {
	ConversationID      string `json:"conversation_id"`
	TurnID              string `json:"turn_id"`
	PermissionRequestID string `json:"permission_request_id"`
	// Status is decided | expired | cancelled.
	Status           string `json:"status"`
	DecisionOptionID string `json:"decision_option_id,omitempty"`
	DecidedBy        string `json:"decided_by,omitempty"`
}

// TurnStartedPayload is conversation.turn.started, written by the worker that
// won the claim. FencingToken is the token every subsequent write from that
// worker must present (02: "stale owners' writes are rejected").
type TurnStartedPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	WorkerID       string `json:"worker_id"`
	FencingToken   int64  `json:"fencing_token"`
	BindingID      string `json:"binding_id,omitempty"`
	ACPSessionID   string `json:"acp_session_id,omitempty"`
	SessionOrigin  string `json:"session_origin"`
}

// TurnCompletedPayload is conversation.turn.completed.
type TurnCompletedPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	WorkerID       string `json:"worker_id"`
	FencingToken   int64  `json:"fencing_token"`
	// StopReason is the harness's ACP stopReason verbatim (end_turn, ...).
	StopReason string `json:"stop_reason,omitempty"`
}

// TurnCancelledPayload is conversation.turn.cancelled: the turn stopped because
// a human asked it to (a cancel, or a takeover that requested one).
type TurnCancelledPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	WorkerID       string `json:"worker_id"`
	FencingToken   int64  `json:"fencing_token"`
	StopReason     string `json:"stop_reason,omitempty"`
	// RequestedBy is the user whose POST /cancel or /take-control set
	// cancel_requested_at, so the transcript names who stopped the work.
	RequestedBy string `json:"requested_by,omitempty"`
}

// TurnFailedPayload is conversation.turn.failed: the agent or harness reported
// an error. Message is a bounded diagnostic; it must never contain a prompt or
// a secret (ADR-0013).
type TurnFailedPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	WorkerID       string `json:"worker_id"`
	FencingToken   int64  `json:"fencing_token"`
	StopReason     string `json:"stop_reason,omitempty"`
	Message        string `json:"message,omitempty"`
}

// TurnInterruptedPayload is conversation.turn.interrupted — the honest terminal
// state. It is emitted by the reconciler or by a shutting-down worker, never
// implies the work resumed, and carries no stop reason because nothing reported
// one (migration 00003 enforces that pairing).
type TurnInterruptedPayload struct {
	ConversationID string `json:"conversation_id"`
	TurnID         string `json:"turn_id"`
	WorkerID       string `json:"worker_id,omitempty"`
	FencingToken   int64  `json:"fencing_token,omitempty"`
	Reason         string `json:"reason"`
}

// SessionConnectedPayload is agent.session.connected.
type SessionConnectedPayload struct {
	ConversationID  string `json:"conversation_id"`
	BindingID       string `json:"binding_id"`
	WorkerID        string `json:"worker_id"`
	ACPSessionID    string `json:"acp_session_id"`
	ProtocolVersion int    `json:"protocol_version"`
	LauncherID      string `json:"launcher_id"`
	LauncherVersion string `json:"launcher_version"`
	SessionOrigin   string `json:"session_origin"`
	// AgentCapabilities is the agent's own capability object as observed at
	// initialize. It is data, not a support claim (04).
	AgentCapabilities map[string]any `json:"agent_capabilities,omitempty"`
}

// SessionDisconnectedPayload is agent.session.disconnected. Reason is a short
// machine-readable cause ("shutdown", "lease_expired", "process_exited", ...).
type SessionDisconnectedPayload struct {
	ConversationID string `json:"conversation_id"`
	BindingID      string `json:"binding_id"`
	WorkerID       string `json:"worker_id"`
	ACPSessionID   string `json:"acp_session_id,omitempty"`
	Reason         string `json:"reason"`
}
