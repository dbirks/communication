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
	// RunID, NodeExecutionID and AttemptID are M4's run-correlation members
	// (docs/m4-contract.md § 1/§ 3, the domain_events columns of the same
	// names added by migration 00005). Additive per ADR-0014 § 8: an additive
	// member is not a version bump and consumers ignore what they do not
	// know, so every pre-M4 row simply omits them.
	RunID           string `json:"run_id,omitempty"`
	NodeExecutionID string `json:"node_execution_id,omitempty"`
	AttemptID       string `json:"attempt_id,omitempty"`
	Actor           Actor  `json:"actor"`
	TraceID         string `json:"trace_id,omitempty"`
	Payload         any    `json:"payload"`
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
	// RunID, NodeExecutionID and AttemptID scope an event to one run of the
	// M4 execution ledger (docs/m4-contract.md § 1: domain_events gains the
	// three columns, indexed (run_id, global_seq) and (attempt_id, global_seq);
	// GET /api/v1/runs/{runId}/events streams through run_id). The § 3
	// correlation rule: a worker row that touches a node execution sets all
	// three on the journal row, not only in the payload; a control-plane row
	// may carry NodeExecutionID with AttemptID empty because control-plane work
	// creates no attempts (ADR-0023 § 3). Like ConversationID they narrow the
	// stream; ProjectID remains the authorization scope. Additive per
	// ADR-0014 § 8.
	RunID           string
	NodeExecutionID string
	AttemptID       string
	Actor           Actor
	Payload         any
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

// ---------------------------------------------------------------- M3 events

// M3 event types (docs/m3-contract.md § 3; ADR-0017 workspaces, ADR-0018
// secrets, ADR-0019 sandboxed launch, ADR-0020 artifacts). Same rules as M2:
// one journal, every payload is an object carrying project_id plus the ids it
// correlates on, and **no payload carries a secret value, a `.env` body, an
// absolute host path or a prompt** (`05`: "Never include generated `.env`
// content in conversation logs or artifacts"; ADR-0013 Security).
//
// The absolute-path rule has teeth here that are easy to miss: a sandbox grant
// list is a list of host paths, and the ops page has to answer "what did this
// turn actually get?" without leaking topology. So `sandbox.verified.grants`
// names grant *roles* (`workspace_repo`, `mirror_objects_rw`, …) rather than
// the resolved paths — the paths themselves are rows in `workspace_repos`, which
// is the same evidence, readable by anyone entitled to read the workspace, and
// never streamed to a browser (contract deviation D14).
const (
	// Workspace lifecycle (ADR-0017 D3's state machine, one event per edge).
	TypeWorkspacePrepared     = "workspace.prepared"
	TypeWorkspaceCommitted    = "workspace.committed"
	TypeWorkspaceQuarantined  = "workspace.quarantined"
	TypeWorkspaceReleased     = "workspace.released"
	TypeWorkspaceRecoveryLost = "workspace.recovery_lost"

	// Sandbox enforcement (ADR-0019): the row that makes "this turn really ran
	// under `required`" answerable without reading worker logs, and its failure
	// twin, which must be followed by conversation.turn.failed with
	// reason="sandbox_enforcement_failed".
	TypeSandboxVerified          = "sandbox.verified"
	TypeSandboxEnforcementFailed = "sandbox.enforcement_failed"
	// TypeSandboxEgressObserved is ADR-0035's evidence row: the turn is over, the
	// child is gone, and THIS run's own nono audit journal has been read. The
	// `allowlisted:<hosts>` label a run earns can only live here, because
	// sandbox.verified is written before the child exists — the journal is
	// append-only and a run that reached nothing has nothing to have been
	// refused against.
	TypeSandboxEgressObserved = "sandbox.egress_observed"

	// Secret lifecycle. Metadata only at every step — there is no field in any
	// of these structs that could receive a value.
	TypeSecretCreated               = "secret.created"
	TypeSecretVersionAdded          = "secret.version.added"
	TypeSecretPolicyUpdated         = "secret.policy.updated"
	TypeSecretRevoked               = "secret.revoked"
	TypeSecretMaterialized          = "secret.materialized"
	TypeSecretRemoved               = "secret.removed"
	TypeSecretMaterializationFailed = "secret.materialization_failed"

	// Artifacts (ADR-0020) and mirror maintenance (ADR-0010/0017).
	TypeArtifactCreated         = "artifact.created"
	TypeArtifactDeleted         = "artifact.deleted"
	TypeRepositoryMirrorUpdated = "repository.mirror_updated"
)

// Agent profile writes (ADR-0030): the two rows behind POST/PATCH
// /api/v1/agent-profiles. The names are `agent.profile.*` rather than the
// `agent_profile.*` a reader might expect because the envelope schema's own
// pattern is ^[a-z]+(\.[a-z_]+)+$ — an underscore is legal only *after* the
// first dotted segment, so `agent_profile.created` is a name the journal's
// schema would reject.
const (
	TypeAgentProfileCreated = "agent.profile.created"
	TypeAgentProfileUpdated = "agent.profile.updated"
	// TypeAgentProfileAPMLocked is the server-side lock result (ADR-0054): the
	// worker resolved a package ref into a lock digest and the control plane
	// recorded it, in the same transaction as the profile write. It is the org-
	// scoped twin of agent.profile.updated — the profile has no project, so the
	// journal row carries organization_id alone and project_id stays NULL.
	TypeAgentProfileAPMLocked = "agent.profile.apm_locked"
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
//
// `new` and `resumed` describe how a *binding* (agent.session.connected,
// acp_session_bindings.session_origin) came to exist. `reused` applies only
// to conversation.turn.started: the turn ran on a live session that predates
// the turn, so no new binding — and no new agent.session.connected — was
// created for it. A turn.started origin is therefore the truth about *this
// turn*: `new`/`resumed` when the session was created/restored for this turn
// (matching that binding's agent.session.connected), `reused` when the loop
// kept the previous turn's process alive.
const (
	SessionOriginNew     = "new"
	SessionOriginResumed = "resumed"
	// SessionOriginReused is turn-scoped: the live session survived from an
	// earlier turn; it is never a legal binding origin.
	SessionOriginReused = "reused"
)

// ValidSessionOrigin reports whether origin is a legal binding origin
// (new | resumed). A binding cannot be "reused": a binding row is only
// written when a session is created or restored.
func ValidSessionOrigin(origin string) bool {
	return origin == SessionOriginNew || origin == SessionOriginResumed
}

// ValidTurnSessionOrigin reports whether origin is a legal
// conversation.turn.started session_origin (new | reused | resumed).
func ValidTurnSessionOrigin(origin string) bool {
	return ValidSessionOrigin(origin) || origin == SessionOriginReused
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
	// SessionOrigin is the truth about *this turn*: `new` when the session
	// was created for it, `resumed` when it was restored via session/load
	// for it (both matching that binding's agent.session.connected), and
	// `reused` when the worker kept the previous turn's live process. See
	// SessionOrigin* above (04 "Session reuse semantics").
	SessionOrigin string `json:"session_origin"`
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

// ------------------------------------------------------- M3: workspaces ----

// WorkspaceRepoRef is one repository inside workspace.prepared's `repos`.
//
// It is deliberately not a path. checkout_path, mirror_path and admin_dir live
// in workspace_repos for the worker to build grants from; an event is a
// browser-visible object, and m3-contract § 2 refuses to serialize absolute host
// paths ("absolute host paths are internal topology") — § 3's "no payload
// carries an absolute host path" is the same rule seen from the other side. The
// ref a reader needs to name the branch is here, and it is not a path.
type WorkspaceRepoRef struct {
	RepositoryID string `json:"repository_id"`
	Name         string `json:"name"`
	RunRef       string `json:"run_ref"`
}

// WorkspacePreparedPayload is workspace.prepared: once per workspace, on
// preparing -> ready (ADR-0017 D3). VolumeID is worker_volumes.volume_id for the
// storage root the workspace lives on — the value case 20 compares against the
// worker's current one. It is a digest of (st_dev, st_ino, root path), never a
// hostname and never st_dev alone (probe V3: two different named volumes at one
// path share a device number).
type WorkspacePreparedPayload struct {
	WorkspaceID    string             `json:"workspace_id"`
	ProjectID      string             `json:"project_id"`
	ScopeKind      string             `json:"scope_kind"`
	ConversationID string             `json:"conversation_id,omitempty"`
	RunID          string             `json:"run_id,omitempty"`
	WorkerID       string             `json:"worker_id"`
	VolumeID       string             `json:"volume_id"`
	WorkspaceMode  string             `json:"workspace_mode"`
	Repos          []WorkspaceRepoRef `json:"repos"`
	// BaseCommits maps repository name to the commit the worktree was created
	// at, so a viewer can tell "this run started from 2222222" without a second
	// query. Names, not ids, because the map is for humans reading the stream.
	BaseCommits  map[string]string `json:"base_commits"`
	PolicyDigest string            `json:"policy_digest"`
}

// WorkspaceCommittedPayload is workspace.committed: one per repository, after a
// post-commit ref read. The read is the proof, not the exit status — probe P8
// observed a commit that printed `packed-refs.lock: Permission denied` on stderr
// and still succeeded, and another whose ref update failed with exit 128 while
// the command looked fine (ADR-0017 P8). HeadCommit is what git answered afterwards.
type WorkspaceCommittedPayload struct {
	WorkspaceID  string `json:"workspace_id"`
	ProjectID    string `json:"project_id"`
	RepositoryID string `json:"repository_id"`
	RunRef       string `json:"run_ref"`
	HeadCommit   string `json:"head_commit"`
}

// WorkspaceQuarantinedPayload is workspace.quarantined. There is no free-text
// field here on purpose: the git errors that would explain a quarantine quote
// absolute host paths, and § 3 forbids those in an event. The reason enum is the
// whole story the browser is allowed; the rest is a worker log line.
type WorkspaceQuarantinedPayload struct {
	WorkspaceID string `json:"workspace_id"`
	ProjectID   string `json:"project_id"`
	Reason      string `json:"reason"`
}

// WorkspaceReleasedPayload is workspace.released: cleanup happened.
// ReposPruned is false when the worktrees could not be removed, which leaves the
// mirror holding orphaned admin dirs for the reconciler — an honest number
// beats an implied `git worktree prune` (WORKSPACES.md W6).
type WorkspaceReleasedPayload struct {
	WorkspaceID string `json:"workspace_id"`
	ProjectID   string `json:"project_id"`
	ReposPruned bool   `json:"repos_pruned"`
}

// WorkspaceRecoveryLostPayload is workspace.recovery_lost — case 20's honest arm.
// ExpectedVolumeID is what the workspace row recorded; FoundVolumeID is what the
// worker measures now (empty when the path is simply gone). The UI must render
// this as "prior edits lost, rerun required", never "resumed" (ADR-0017 D2,
// 10's J7 honesty rule).
type WorkspaceRecoveryLostPayload struct {
	WorkspaceID      string `json:"workspace_id"`
	ProjectID        string `json:"project_id"`
	ExpectedVolumeID string `json:"expected_volume_id"`
	FoundVolumeID    string `json:"found_volume_id,omitempty"`
	Reason           string `json:"reason"`
}

// ---------------------------------------------------------- M3: sandbox ----

// SandboxGrant is one entry of sandbox.verified.grants, named by role.
//
// ADR-0019's launch chain is verified against a *resolved* grant list (N-d), and
// the ops page has to show what a turn got. Roles are what makes both readable
// without publishing the host's filesystem: {workspace_repo, rw} says the same
// useful thing as /var/lib/communication/workspaces/<uuid>/work/repos/backend
// and survives the workspace being deleted.
type SandboxGrant struct {
	Role   string `json:"role"`
	Access string `json:"access"`
}

// SandboxVerifiedPayload is sandbox.verified, emitted by the worker after the
// N-a..N-d chain passed for this unit. Verified is a plain bool (never omitted)
// so a reader can assert the field exists and is true rather than inferring it
// from absence. NetworkEnforced=false on an agent-turn profile is the observed
// truth, reported rather than hidden (ADR-0019 D3, D-021 Provisional).
//
// Network is ADR-0035's finer label, in the tri-state vocabulary:
// "denied" (--block-net profile), "allowlisted:<hosts>" (a profile whose digest
// commits to a host set AND whose own audit journal recorded a refusal), or
// "open". The AND is the whole point: an allowlist that was never exercised
// keeps reporting NetworkOpen with NetworkEnforced=false, so no configuration
// default can buy a run an egress claim. An absent Network on an older row means
// exactly "this row predates the label", never "enforced".
type SandboxVerifiedPayload struct {
	ProjectID       string `json:"project_id"`
	TurnID          string `json:"turn_id"`
	WorkspaceID     string `json:"workspace_id"`
	WorkerID        string `json:"worker_id"`
	PolicyDigest    string `json:"policy_digest"`
	Backend         string `json:"backend"`
	BackendVersion  string `json:"backend_version"`
	AfUnixMediation string `json:"af_unix_mediation"`
	NetworkEnforced bool   `json:"network_enforced"`
	// Network is the run-level egress claim (ADR-0035): "open" | "denied" |
	// "allowlisted:<comma-separated hosts>". NetworkEnforced is true exactly when
	// this is "denied" or "allowlisted:…".
	Network       string         `json:"network,omitempty"`
	Grants        []SandboxGrant `json:"grants"`
	CommitGranted bool           `json:"commit_granted"`
	Verified      bool           `json:"verified"`
}

// SandboxEnforcementFailedPayload is sandbox.enforcement_failed: emitted before
// (and instead of) a launch, and always followed by conversation.turn.failed with
// reason="sandbox_enforcement_failed" (ADR-0019 D6). ChildStarted is the field
// that answers 12-test-strategy's case-13 question — "was a process ever exec'd?"
// — and it is false for every stage but runtime. Detail is a bounded, redacted
// diagnostic: any host path inside it must be replaced by its grant role first,
// because the journal is browser-visible.
type SandboxEnforcementFailedPayload struct {
	ProjectID      string `json:"project_id"`
	TurnID         string `json:"turn_id,omitempty"`
	WorkspaceID    string `json:"workspace_id,omitempty"`
	WorkerID       string `json:"worker_id"`
	Stage          string `json:"stage"`
	Reason         string `json:"reason"`
	Backend        string `json:"backend"`
	BackendVersion string `json:"backend_version,omitempty"`
	PolicyDigest   string `json:"policy_digest"`
	Verified       bool   `json:"verified"`
	ChildStarted   bool   `json:"child_started"`
	Detail         string `json:"detail,omitempty"`
}

// EgressAuditStatus values for sandbox.egress_observed. There are exactly two:
// the audit was read, or it was not. "unavailable" is the bounded-failure row —
// a timeout, a missing backend surface, or an unattributable session — and it
// always travels with NetworkOpen/NetworkEnforced=false, because "I could not
// look" is never evidence that an allowlist held (ADR-0035 § 3).
const (
	EgressAuditStatusObserved    = "observed"
	EgressAuditStatusUnavailable = "unavailable"
)

// ValidEgressAuditStatus reports whether status is one of the two spellings.
func ValidEgressAuditStatus(status string) bool {
	switch status {
	case EgressAuditStatusObserved, EgressAuditStatusUnavailable:
		return true
	default:
		return false
	}
}

// SandboxEgressObservedPayload is sandbox.egress_observed: the run's own egress
// audit, read once after its sandboxed child exited (ADR-0035 § 3). Allowed and
// Denied are the counts of the audit journal's network_events; DeniedHosts
// carries hostnames ONLY (never a URL, path or query string — the journal is
// browser-visible and nono's audit target field can carry a glob-URL entry's
// path). Network repeats the run's ADR-0035 label as the audit changed it:
// "allowlisted:<hosts>" only when Status is observed and Denied > 0.
//
// It never fails a turn. A run whose audit could not be read is reported with
// Status="unavailable", Detail naming why (redacted, bounded), and the same
// open/false pair a run with no denials gets — the absence of evidence is not
// evidence of enforcement.
type SandboxEgressObservedPayload struct {
	ProjectID   string `json:"project_id"`
	TurnID      string `json:"turn_id,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	WorkerID    string `json:"worker_id"`
	Backend     string `json:"backend,omitempty"`
	// PolicyDigest is the digest the run launched under, so a reader can tie the
	// label to the host set the profile committed to.
	PolicyDigest string `json:"policy_digest"`
	// SandboxSession is nono's opaque audit session id this was read from — the
	// row a lab operator quotes. Empty when Status is unavailable.
	SandboxSession  string   `json:"sandbox_session,omitempty"`
	Status          string   `json:"status"`
	Network         string   `json:"network"`
	NetworkEnforced bool     `json:"network_enforced"`
	Allowed         int      `json:"allowed"`
	Denied          int      `json:"denied"`
	DeniedHosts     []string `json:"denied_hosts"`
	Detail          string   `json:"detail,omitempty"`
}

// ---------------------------------------------------------- M3: secrets ----

// SecretCreatedPayload is secret.created. There is no field here that could
// receive a value, and the write-only `value` from the API request never reaches
// this struct (ADR-0018 D1: the metadata half of a SecretRef is the half that is
// shareable).
type SecretCreatedPayload struct {
	SecretID               string   `json:"secret_id"`
	ProjectID              string   `json:"project_id"`
	Slug                   string   `json:"slug"`
	Scope                  string   `json:"scope"`
	Purpose                string   `json:"purpose,omitempty"`
	DeliveryMode           string   `json:"delivery_mode"`
	Version                int      `json:"version"`
	AllowedAgentProfileIDs []string `json:"allowed_agent_profile_ids"`
}

// SecretVersionAddedPayload is secret.version.added.
//
// The contract's draft listed content_sha256 here. It is not here: that digest
// exists so a retried write can be recognised as the same write (ADR-0018 names
// it "retry-comparison only, never API-exposed"), and the journal *is* an API —
// streamed to every project member. A digest of a low-entropy secret in a
// viewer-readable event is an offline guessing oracle, so the comparison value
// stays in secret_versions where only the worker's own transaction reads it
// (contract deviation D15).
type SecretVersionAddedPayload struct {
	SecretID        string `json:"secret_id"`
	ProjectID       string `json:"project_id"`
	Version         int    `json:"version"`
	KeyID           string `json:"key_id"`
	PreviousVersion int    `json:"previous_version,omitempty"`
}

// SecretPolicyState is one side of a secret.policy.updated diff: the policy a
// reader had before and the policy it has now. Nothing in it is secret.
type SecretPolicyState struct {
	Purpose                string   `json:"purpose"`
	AuditPolicy            string   `json:"audit_policy"`
	AllowedAgentProfileIDs []string `json:"allowed_agent_profile_ids"`
}

// SecretPolicyUpdatedPayload is secret.policy.updated.
type SecretPolicyUpdatedPayload struct {
	SecretID  string            `json:"secret_id"`
	ProjectID string            `json:"project_id"`
	Before    SecretPolicyState `json:"before"`
	After     SecretPolicyState `json:"after"`
}

// SecretRevokedPayload is secret.revoked. Versions are the ones that became
// unmaterializable, so an in-flight unit that pinned version 3 can be told apart
// from one that never existed (ADR-0018 D2.4).
type SecretRevokedPayload struct {
	SecretID  string `json:"secret_id"`
	ProjectID string `json:"project_id"`
	Versions  []int  `json:"versions"`
	RevokedAt string `json:"revoked_at"`
	RevokedBy string `json:"revoked_by,omitempty"`
}

// SecretMaterializedPayload is secret.materialized — the proof a value was
// present only during the unit authorized to have it, written without the value.
// RelativePath is relative to its repository's checkout root (never absolute),
// EnvName is the variable name for env delivery, and Mode is the file mode as
// humans read it ("0600"); env delivery has no Mode.
type SecretMaterializedPayload struct {
	SecretID       string `json:"secret_id"`
	ProjectID      string `json:"project_id"`
	Slug           string `json:"slug"`
	Version        int    `json:"version"`
	DeliveryMode   string `json:"delivery_mode"`
	RepositoryName string `json:"repository_name,omitempty"`
	RelativePath   string `json:"relative_path,omitempty"`
	EnvName        string `json:"env_name,omitempty"`
	Lifecycle      string `json:"lifecycle"`
	Mode           string `json:"mode,omitempty"`
	WorkspaceID    string `json:"workspace_id"`
	TurnID         string `json:"turn_id,omitempty"`
	PolicyDigest   string `json:"policy_digest"`
}

// SecretRemovedPayload is secret.removed. CleanedBy is who took it away — the
// unit's own defer, the reconciler, or the worker's startup sweep over rows still
// uncleaned — which is the difference between "cleanup works" and "cleanup works
// when nothing crashes".
type SecretRemovedPayload struct {
	SecretID    string `json:"secret_id"`
	ProjectID   string `json:"project_id"`
	Target      string `json:"target"`
	WorkspaceID string `json:"workspace_id"`
	TurnID      string `json:"turn_id,omitempty"`
	CleanedBy   string `json:"cleaned_by"`
}

// SecretMaterializationFailedPayload is secret.materialization_failed, emitted
// before launch (fail-closed: no child, no partial file). Target carries the
// rejected *relative* request, which is how 12-test-strategy's traversal battery
// is reported (a rejected `../../etc/x` is information; a written one is the
// incident).
type SecretMaterializationFailedPayload struct {
	SecretID     string `json:"secret_id"`
	ProjectID    string `json:"project_id"`
	Slug         string `json:"slug"`
	DeliveryMode string `json:"delivery_mode"`
	Target       string `json:"target,omitempty"`
	Reason       string `json:"reason"`
	WorkspaceID  string `json:"workspace_id,omitempty"`
	TurnID       string `json:"turn_id,omitempty"`
	ChildStarted bool   `json:"child_started"`
}

// ------------------------------------------------------- M3: artifacts ----

// ArtifactCreatedPayload is artifact.created, appended in the same fenced
// transaction that flips the row to state='ready' (ADR-0016 § 9.2: an unfenced
// worker publishes nothing). sha256 here is the artifact's content digest — the
// thing the preview and the retention sweep are keyed on — and the row's
// storage_key never appears in any payload.
type ArtifactCreatedPayload struct {
	ArtifactID     string `json:"artifact_id"`
	ProjectID      string `json:"project_id"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	MediaType      string `json:"media_type"`
	SHA256         string `json:"sha256"`
	SizeBytes      int64  `json:"size_bytes"`
	Sensitivity    string `json:"sensitivity"`
	RedactionCount int    `json:"redaction_count"`
	WorkspaceID    string `json:"workspace_id,omitempty"`
	TurnID         string `json:"turn_id,omitempty"`
}

// ArtifactDeletedPayload is artifact.deleted: bytes and row are gone (or the
// sweep's, pending), which is the retention promise `06` asks for.
type ArtifactDeletedPayload struct {
	ArtifactID string `json:"artifact_id"`
	ProjectID  string `json:"project_id"`
	Reason     string `json:"reason"`
}

// RepositoryMirrorUpdatedPayload is repository.mirror_updated: the worker created
// or fetched a project mirror. FromCommit/ToCommit make "the mirror moved under a
// running workspace" visible (ADR-0010 D5's per-project mirror, ADR-0017 D1).
type RepositoryMirrorUpdatedPayload struct {
	ProjectID       string `json:"project_id"`
	RepositoryID    string `json:"repository_id"`
	WorkerID        string `json:"worker_id"`
	MirrorKind      string `json:"mirror_kind"`
	FromCommit      string `json:"from_commit,omitempty"`
	ToCommit        string `json:"to_commit"`
	FetchDurationMS int64  `json:"fetch_duration_ms"`
}

// ------------------------------------------------- ADR-0030: profiles ----

// AgentProfileCreatedPayload is agent.profile.created, appended in the same
// transaction as the profile row. Profiles are organization-scoped and have no
// project, so the row carries organization_id alone and the journal's
// project_id stays NULL (as it does for the org-scoped pipeline library rows).
// An APM ref is a coordinate in public source control, not a secret — the
// absolute-path and secret-value rules still apply verbatim.
type AgentProfileCreatedPayload struct {
	ProfileID  string `json:"profile_id"`
	Name       string `json:"name"`
	LauncherID string `json:"launcher_id"`
	// Version is the profile version this creation landed as (ADR-0058): a new
	// profile always writes version 1, and that version is what its history
	// starts from.
	Version int `json:"version"`
	// PermissionMode is always "ask": the route cannot set it, because
	// preapproved_within_sandbox requires a verified enforced sandbox for the
	// launcher first (04-agent-runtime.md "Permission policy", ADR-0009).
	PermissionMode string `json:"permission_mode"`
}

// AgentProfileUpdatedPayload is agent.profile.updated. It records the whole APM
// triple as it stands after the write — not a diff — because the question the
// row exists to answer is "what was this profile pinned to when it changed?",
// and a reader must not have to replay history to know. Version is the profile
// version this write landed as (ADR-0058): the optimistic-concurrency token the
// row carried before the write (the CAS loser gets a 409 instead of a rewrite) and
// the version the frozen history row for it names.
type AgentProfileUpdatedPayload struct {
	ProfileID     string `json:"profile_id"`
	Version       int    `json:"version"`
	APMPackageRef string `json:"apm_package_ref,omitempty"`
	APMTarget     string `json:"apm_target,omitempty"`
	APMLockDigest string `json:"apm_lock_digest,omitempty"`
	APMPinCleared bool   `json:"apm_pin_cleared"`
}

// AgentProfileAPMLockedPayload is agent.profile.apm_locked: the worker's
// resolve answered for one profile. It carries the identity of the lock (ids,
// digest, ref, commit) and nothing else — never the lock file body, file paths,
// prompts or values (ADR-0054's result-payload rule). The names-only contents
// summary rides on agent_profiles.apm_contents_summary instead, where it is
// display state; this event is the attribution record.
type AgentProfileAPMLockedPayload struct {
	ProfileID     string `json:"profile_id"`
	APMPackageRef string `json:"apm_package_ref,omitempty"`
	APMTarget     string `json:"apm_target,omitempty"`
	APMLockDigest string `json:"apm_lock_digest"`
	ResolvedRef   string `json:"resolved_ref,omitempty"`
	Commit        string `json:"commit,omitempty"`
	APMVersion    string `json:"apm_version,omitempty"`
}

// -------------------------------------------------------- M3 enum values ---

// Workspace scope kinds: the same pair as workspaces.scope_kind. `run` exists so
// M4 does not rename the wire (contract deviation D1).
const (
	WorkspaceScopeConversation = "conversation"
	WorkspaceScopeRun          = "run"
)

// Workspace states, mirroring the workspaces.state CHECK.
const (
	WorkspaceStatePreparing    = "preparing"
	WorkspaceStateReady        = "ready"
	WorkspaceStateQuarantined  = "quarantined"
	WorkspaceStateReleased     = "released"
	WorkspaceStateLost         = "lost"
	WorkspaceModeWorktree      = "worktree"
	WorkspaceModeClone         = "clone"
	QuarantineSecretLeftBehind = "secret_left_behind"
	QuarantineExclusionFailed  = "exclusion_failed"
	QuarantineWorktreeUnusable = "worktree_unusable"
	RecoveryVolumeChanged      = "volume_changed"
	RecoveryPathMissing        = "path_missing"
	RecoveryDifferentWorker    = "different_worker"
)

// Sandbox enforcement stages and reasons (ADR-0019 D2's N-a..N-d chain and D6's
// failure enum). Kept as one list because a reason is only meaningful with the
// stage that produced it.
const (
	SandboxStageProbe        = "probe"
	SandboxStageProfile      = "profile"
	SandboxStagePolicyAssert = "policy_assert"
	SandboxStageGrantAssert  = "grant_assert"
	SandboxStageExec         = "exec"
	SandboxStageRuntime      = "runtime"

	SandboxReasonBinaryMissing           = "binary_missing"
	SandboxReasonLandlockUnavailable     = "landlock_unavailable"
	SandboxReasonFSUnverified            = "fs_unverified"
	SandboxReasonTCPUnverified           = "tcp_unverified"
	SandboxReasonAfUnixNotMediated       = "af_unix_not_mediated"
	SandboxReasonProfileInvalid          = "profile_invalid"
	SandboxReasonGrantMismatch           = "grant_mismatch"
	SandboxReasonTempPathGrant           = "temp_path_grant"
	SandboxReasonCwdNotGranted           = "cwd_not_granted"
	SandboxReasonPolicyDelegationRefused = "policy_delegation_refused"
	SandboxReasonDenyUnsupported         = "deny_unsupported"
	SandboxReasonEgressCheckFailed       = "egress_check_failed"
)

// Grant roles, naming ADR-0017 D4's grant table without naming a path. The
// `mirror_*` roles are the four paths a commit needs and nothing else;
// `harness_credentials` is the one role whose contents are shared mutable state
// between projects on one worker (ADR-0019 D4) and must never be described as
// per-attempt isolation.
const (
	GrantRoleWorkspaceRepo    = "workspace_repo"
	GrantRoleWorkspaceScratch = "workspace_scratch"
	GrantRoleWorkspaceHome    = "workspace_home"
	GrantRoleMirrorRead       = "mirror_read"
	GrantRoleMirrorObjects    = "mirror_objects"
	GrantRoleMirrorRunRefs    = "mirror_run_refs"
	GrantRoleMirrorRunLogs    = "mirror_run_logs"
	GrantRoleMirrorAdminDir   = "mirror_admin_dir"
	GrantRoleHarnessCreds     = "harness_credentials"
	GrantAccessRO             = "ro"
	GrantAccessRW             = "rw"
)

// Materialization failure reasons. absolute_path and bad_shape are the probe's
// additions (p4 C-ENV6's battery produced them; the contract's list had only
// path_escape for both).
const (
	MaterializationPathEscape        = "path_escape"
	MaterializationAbsolutePath      = "absolute_path"
	MaterializationBadShape          = "bad_shape"
	MaterializationTrackedTarget     = "tracked_target"
	MaterializationExists            = "exists"
	MaterializationSymlinkParent     = "symlink_parent"
	MaterializationKeyringUnreadable = "keyring_unreadable"
	MaterializationRevokedVersion    = "revoked_version"
	MaterializationBrokerUnsupported = "broker_unsupported"
	MaterializationMirrorWritable    = "mirror_writable"
)

// Artifact deletion reasons and mirror update kinds.
const (
	ArtifactDeletionExpired   = "expired"
	ArtifactDeletionSwept     = "swept"
	ArtifactDeletionRetention = "retention"
	MirrorKindCreated         = "created"
	MirrorKindFetched         = "fetched"
)

// ValidWorkspaceScopeKind reports whether kind is a legal workspaces.scope_kind.
func ValidWorkspaceScopeKind(kind string) bool {
	return kind == WorkspaceScopeConversation || kind == WorkspaceScopeRun
}

// ValidWorkspaceState reports whether state is one of the five workspaces.state
// values.
func ValidWorkspaceState(state string) bool {
	switch state {
	case WorkspaceStatePreparing, WorkspaceStateReady, WorkspaceStateQuarantined,
		WorkspaceStateReleased, WorkspaceStateLost:
		return true
	default:
		return false
	}
}

// ValidWorkspaceMode reports whether mode is ADR-0010's escape hatch or its
// default — nothing else is a workspace mode.
func ValidWorkspaceMode(mode string) bool {
	return mode == WorkspaceModeWorktree || mode == WorkspaceModeClone
}

// ValidQuarantineReason reports whether reason is one of the three security
// failures that quarantine a workspace. An unknown reason is a bug, not a fourth
// kind of quarantine.
func ValidQuarantineReason(reason string) bool {
	switch reason {
	case QuarantineSecretLeftBehind, QuarantineExclusionFailed, QuarantineWorktreeUnusable:
		return true
	default:
		return false
	}
}

// ValidRecoveryLostReason reports whether reason is one case 20 can report.
func ValidRecoveryLostReason(reason string) bool {
	switch reason {
	case RecoveryVolumeChanged, RecoveryPathMissing, RecoveryDifferentWorker:
		return true
	default:
		return false
	}
}

// ValidSandboxStage reports whether stage names a point in ADR-0019's chain.
func ValidSandboxStage(stage string) bool {
	switch stage {
	case SandboxStageProbe, SandboxStageProfile, SandboxStagePolicyAssert,
		SandboxStageGrantAssert, SandboxStageExec, SandboxStageRuntime:
		return true
	default:
		return false
	}
}

// ValidSandboxFailureReason reports whether reason is in ADR-0019 D6's enum.
func ValidSandboxFailureReason(reason string) bool {
	switch reason {
	case SandboxReasonBinaryMissing, SandboxReasonLandlockUnavailable, SandboxReasonFSUnverified,
		SandboxReasonTCPUnverified, SandboxReasonAfUnixNotMediated, SandboxReasonProfileInvalid,
		SandboxReasonGrantMismatch, SandboxReasonTempPathGrant, SandboxReasonCwdNotGranted,
		SandboxReasonPolicyDelegationRefused, SandboxReasonDenyUnsupported, SandboxReasonEgressCheckFailed:
		return true
	default:
		return false
	}
}

// ValidGrantRole reports whether role is one of ADR-0017 D4's named grants.
func ValidGrantRole(role string) bool {
	switch role {
	case GrantRoleWorkspaceRepo, GrantRoleWorkspaceScratch, GrantRoleWorkspaceHome,
		GrantRoleMirrorRead, GrantRoleMirrorObjects, GrantRoleMirrorRunRefs,
		GrantRoleMirrorRunLogs, GrantRoleMirrorAdminDir, GrantRoleHarnessCreds:
		return true
	default:
		return false
	}
}

// ValidGrantAccess reports whether access is ro or rw: the two things a Landlock
// ruleset can actually say about a path.
func ValidGrantAccess(access string) bool {
	return access == GrantAccessRO || access == GrantAccessRW
}

// ValidMaterializationFailureReason reports whether reason is one the materializer
// can refuse with. Every value means "nothing was written".
func ValidMaterializationFailureReason(reason string) bool {
	switch reason {
	case MaterializationPathEscape, MaterializationAbsolutePath, MaterializationBadShape,
		MaterializationTrackedTarget, MaterializationExists, MaterializationSymlinkParent,
		MaterializationKeyringUnreadable, MaterializationRevokedVersion,
		MaterializationBrokerUnsupported, MaterializationMirrorWritable:
		return true
	default:
		return false
	}
}

// ValidArtifactDeletionReason reports whether reason says why bytes went away.
func ValidArtifactDeletionReason(reason string) bool {
	switch reason {
	case ArtifactDeletionExpired, ArtifactDeletionSwept, ArtifactDeletionRetention:
		return true
	default:
		return false
	}
}

// ValidMirrorKind reports whether kind says whether the mirror was made or moved.
func ValidMirrorKind(kind string) bool {
	return kind == MirrorKindCreated || kind == MirrorKindFetched
}

// ---------------------------------------------------------------- M4 events

// M4 event types (docs/m4-contract.md § 3 rows 1-36; api/openapi.yaml's
// streamRunEvents payload table is the wire contract events_test.go pins
// these against). The run/node/attempt/approval rows are written by the
// advancer, the worker and the reconciler; the pipeline.* and assignment.*
// rows by the definition service. Same rules as M2/M3: every payload is an
// object carrying project_id plus the ids it correlates on, and no payload
// carries a secret value, a prompt body, an absolute host path, a fencing
// token or a lease deadline. CEL failure text is admitted only as
// predicate_error_detail, truncated to 512 bytes and redaction-scanned
// (ADR-0022 Security). The envelope's run_id/node_execution_id/attempt_id
// members (§ 1) are populated on every run-scoped row below.
const (
	// Run lifecycle (§ 3 rows 1-13).
	TypeRunCreated            = "run.created"             // 1
	TypeRunStarted            = "run.started"             // 2
	TypeRunPaused             = "run.paused"              // 3
	TypeRunResumed            = "run.resumed"             // 4
	TypeRunWaitingHuman       = "run.waiting_human"       // 5
	TypeRunRetried            = "run.retried"             // 6
	TypeRunCheckpointSaved    = "run.checkpoint_saved"    // 7
	TypeRunCheckpointRestored = "run.checkpoint_restored" // 8
	TypeRunCompleted          = "run.completed"           // 9
	TypeRunFailed             = "run.failed"              // 10
	TypeRunCancelRequested    = "run.cancel_requested"    // 11
	TypeRunCancelled          = "run.cancelled"           // 12
	TypeRunInterrupted        = "run.interrupted"         // 13

	// Node executions and scopes (§ 3 rows 14-19): control-plane rows; a scope
	// event may carry node_execution_id with attempt_id NULL because
	// control-plane work creates no attempts (ADR-0023 § 3).
	TypeNodeExecutionSkipped   = "node.execution_skipped"
	TypeNodeExecutionCancelled = "node.execution_cancelled"
	TypeNodeScopeStarted       = "node.scope.started"
	TypeNodeScopeIteration     = "node.scope.iteration"
	TypeNodeScopeCompleted     = "node.scope.completed"
	TypeNodeScopeFailed        = "node.scope.failed"

	// Attempts (§ 3 rows 20-25): the worker-side rows, every one written
	// under the fence with all three correlation columns set.
	TypeNodeAttemptStarted        = "node.attempt.started"
	TypeNodeAttemptCompleted      = "node.attempt.completed"
	TypeNodeAttemptFailed         = "node.attempt.failed"
	TypeNodeAttemptInterrupted    = "node.attempt.interrupted"
	TypeNodeAttemptCancelled      = "node.attempt.cancelled"
	TypeNodeAttemptRetryScheduled = "node.attempt.retry_scheduled"

	// Gates (§ 3 rows 26-30). approval.requested reuses the name `09` fixes;
	// it is NOT conversation.permission.requested, which stays the ACP tool
	// prompt (ADR-0023 § 9).
	TypeApprovalRequested = "approval.requested"
	TypeApprovalDecided   = "approval.decided"
	TypeApprovalExpired   = "approval.expired"
	TypeApprovalDenied    = "approval.denied"
	TypeApprovalCancelled = "approval.cancelled"

	// Pipeline library and assignments (§ 3 rows 31-36): API-emitted audit
	// rows. They share the journal but never the run correlation columns.
	TypePipelineCreated            = "pipeline.created"
	TypePipelineDraftUpdated       = "pipeline.draft.updated"
	TypePipelineDraftValidated     = "pipeline.draft.validated"
	TypePipelineDraftCreated       = "pipeline.draft.create"
	TypePipelineRevisionPublished  = "pipeline.revision.published"
	TypePipelineRevisionDeprecated = "pipeline.revision.deprecated"

	TypeAssignmentCreated = "assignment.created"
	TypeAssignmentUpdated = "assignment.updated"

	// Node template registry (ADR-0049): the API-emitted audit rows for the
	// org-scoped step registry, plus the pipeline metadata PATCH row. Like
	// the other definition rows they share the journal but never the run
	// correlation columns; project_id carries the empty string (a template
	// has no project) so a stream reader can still attribute the envelope.
	// The first-segment underscore (node_template.*) is why the envelope
	// `type` pattern admits [a-z_] before the first dot (09's ADR-0049 names
	// are fixed; the pattern only widens, so every existing name still
	// matches).
	TypePipelineUpdate                = "pipeline.update"
	TypeNodeTemplateCreated           = "node_template.create"
	TypeNodeTemplateRevisionPublished = "node_template.revision.publish"
	TypeNodeTemplateDuplicated        = "node_template.duplicate"
)

// ReservedTypeRunOverrideApplied is § 3 row 37: the type name is fixed so M5
// can land it without renaming the wire, and M4 never emits it (ADR-0024 § 3
// — M4's overrides are visible on the attempt row and in run.retried).
const ReservedTypeRunOverrideApplied = "run.override.applied"

// ----------------------------------------------------------- M4: run payloads

// RunCreatedPayload is run.created (§ 3 row 1), appended in the same
// transaction as the run row (POST /runs and the child-run creation
// transaction alike).
type RunCreatedPayload struct {
	ProjectID      string   `json:"project_id"`
	RunID          string   `json:"run_id"`
	PipelineID     string   `json:"pipeline_id"`
	RevisionID     string   `json:"revision_id"`
	RevisionDigest string   `json:"revision_digest"`
	PlanDigest     string   `json:"plan_digest"`
	DigestScope    string   `json:"digest_scope"`
	AssignmentID   string   `json:"assignment_id,omitempty"`
	Depth          int      `json:"depth"`
	ParentRunID    string   `json:"parent_run_id,omitempty"`
	InputNames     []string `json:"input_names"`
	Priority       int      `json:"priority"`
	// SourceConversationID (ADR-0053) names the thread the run was started
	// from; omitted for ordinary runs so pre-ADR-0053 envelopes are
	// byte-identical to the new ones.
	SourceConversationID string `json:"source_conversation_id,omitempty"`
}

// RunStartedPayload is run.started (§ 3 row 2). The repo snapshot names
// commits, never paths (03 step 2).
type RunStartedPayload struct {
	ProjectID             string `json:"project_id"`
	RunID                 string `json:"run_id"`
	WorkerAffinityPresent bool   `json:"worker_affinity_present"`
	RepoSnapshot          []any  `json:"repo_snapshot"`
}

// RunPausedPayload is run.paused (§ 3 row 3): pause stops future scheduling
// only, so the honest payload names what is still in flight.
type RunPausedPayload struct {
	ProjectID        string   `json:"project_id"`
	RunID            string   `json:"run_id"`
	PausedReason     string   `json:"paused_reason"`
	InFlightAttempts []string `json:"in_flight_attempts"`
	RequestedBy      string   `json:"requested_by,omitempty"`
}

// RunResumedPayload is run.resumed (§ 3 row 4); PausedReason is the one
// cleared.
type RunResumedPayload struct {
	ProjectID    string `json:"project_id"`
	RunID        string `json:"run_id"`
	PausedReason string `json:"paused_reason"`
}

// RunWaitingHumanPayload is run.waiting_human (§ 3 row 5), emitted when a
// gate row is inserted. The scope waits, not the run (contract § 5.3).
type RunWaitingHumanPayload struct {
	ProjectID       string    `json:"project_id"`
	RunID           string    `json:"run_id"`
	ApprovalID      string    `json:"approval_id"`
	NodeInstanceKey string    `json:"node_instance_key"`
	DeadlineAt      time.Time `json:"deadline_at"`
	ApproverRoles   []string  `json:"approver_roles"`
}

// RunRetriedPayload is run.retried (§ 3 row 6).
type RunRetriedPayload struct {
	ProjectID         string            `json:"project_id"`
	RunID             string            `json:"run_id"`
	RequestedBy       string            `json:"requested_by"`
	Targets           []string          `json:"targets"`
	InputNames        []string          `json:"input_names"`
	WorkspacePolicies map[string]string `json:"workspace_policies"`
}

// Checkpoint is run.checkpoint_saved's boundary record (§ 3 row 7): digests
// and refs only. No paths — the volume identity is the address (D-009's
// durable boundary, ADR-0023 § 6; D-024 stays Open: same-volume only).
type Checkpoint struct {
	NodeInstanceKey string      `json:"node_instance_key"`
	InputsDigest    string      `json:"inputs_digest"`
	OutputsDigest   string      `json:"outputs_digest"`
	RepoStates      []RepoState `json:"repo_states"`
	ArtifactRefs    []any       `json:"artifact_refs"`
	VolumeID        string      `json:"volume_id"`
}

// RepoState is one repository at a boundary: commits, not paths.
type RepoState struct {
	RepositoryID          string `json:"repository_id"`
	BaseCommit            string `json:"base_commit"`
	HeadCommit            string `json:"head_commit"`
	ModifiedPathsArtifact string `json:"modified_paths_artifact,omitempty"`
}

// RunCheckpointSavedPayload is run.checkpoint_saved (§ 3 row 7), written by
// the worker in the attempt's success transaction (ADR-0023 § 6).
type RunCheckpointSavedPayload struct {
	ProjectID  string     `json:"project_id"`
	RunID      string     `json:"run_id"`
	Checkpoint Checkpoint `json:"checkpoint"`
}

// RunCheckpointRestoredPayload is run.checkpoint_restored (§ 3 row 8):
// emitted ONLY under retry.workspacePolicy: restore_checkpoint — its absence
// beside a retry is what proves the run used continue_workspace.
type RunCheckpointRestoredPayload struct {
	ProjectID       string   `json:"project_id"`
	RunID           string   `json:"run_id"`
	NodeInstanceKey string   `json:"node_instance_key"`
	FromCommit      string   `json:"from_commit"`
	DiscardedPaths  []string `json:"discarded_paths"`
}

// RunCompletedPayload is run.completed (§ 3 row 9). completed means the
// configured acceptance passed (01), not that anything merged.
type RunCompletedPayload struct {
	ProjectID       string         `json:"project_id"`
	RunID           string         `json:"run_id"`
	ResultBindings  map[string]any `json:"result_bindings"`
	ArtifactRefs    []any          `json:"artifact_refs"`
	IterationTotals map[string]int `json:"iteration_totals"`
}

// RunFailedPayload is run.failed (§ 3 row 10). FailedCause names the budget
// when a budget caused it (max_duration_exceeded,
// node_execution_budget_exceeded, child_depth_exceeded,
// expression_eval_budget_exceeded, run_duration_exceeded).
type RunFailedPayload struct {
	ProjectID         string `json:"project_id"`
	RunID             string `json:"run_id"`
	FailedCause       string `json:"failed_cause"`
	ErrorClass        string `json:"error_class"`
	NodeInstanceKey   string `json:"node_instance_key,omitempty"`
	Budget            string `json:"budget,omitempty"`
	EvidenceArtifacts []any  `json:"evidence_artifacts"`
}

// RunCancelRequestedPayload is run.cancel_requested (§ 3 row 11): the API
// flag plus the advancer's cascade (ADR-0023 § 10).
type RunCancelRequestedPayload struct {
	ProjectID   string   `json:"project_id"`
	RunID       string   `json:"run_id"`
	Cascade     bool     `json:"cascade"`
	Children    []string `json:"children"`
	RequestedBy string   `json:"requested_by,omitempty"`
}

// RunCancelledPayload is run.cancelled (§ 3 row 12), emitted once every
// branch is terminal.
type RunCancelledPayload struct {
	ProjectID               string   `json:"project_id"`
	RunID                   string   `json:"run_id"`
	CancelledNodeExecutions []string `json:"cancelled_node_executions"`
	CancelledAttempts       []string `json:"cancelled_attempts"`
}

// RunInterruptedPayload is run.interrupted (§ 3 row 13) — reconciler only,
// never the dead process — with error_class: workspace_lost among its arms
// and no auto-retry (case 20's honest arm).
type RunInterruptedPayload struct {
	ProjectID        string   `json:"project_id"`
	RunID            string   `json:"run_id"`
	Reason           string   `json:"reason"`
	ErrorClass       string   `json:"error_class"`
	NodeInstanceKeys []string `json:"node_instance_keys"`
}

// ---------------------------------------------------------- M4: node payloads

// NodeExecutionSkippedPayload is node.execution_skipped (§ 3 row 14). Reason
// is dependency_skipped, condition_default, case_not_selected or
// for_each_zero_items_body_unreached (the zero-item edge case instead emits
// node.scope.completed with items: 0).
type NodeExecutionSkippedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	Reason          string `json:"reason"`
}

// NodeExecutionCancelledPayload is node.execution_cancelled (§ 3 row 15):
// cascade, on_child_failure_stop or run_cancelled.
type NodeExecutionCancelledPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	Reason          string `json:"reason"`
}

// NodeScopeStartedPayload is node.scope.started (§ 3 row 16).
type NodeScopeStartedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ScopeKey        string `json:"scope_key"`
	NodeInstanceKey string `json:"node_instance_key"`
	Kind            string `json:"kind"`
	Iteration       int    `json:"iteration,omitempty"`
	Items           int    `json:"items,omitempty"`
}

// NodeScopeIterationPayload is node.scope.iteration (§ 3 row 17): case 7's
// per-iteration evidence and case 8's fan-out accounting. PassWhenResult is
// nil when the iteration failed before a predicate could be evaluated;
// PredicateErrorDetail is the only place CEL text enters the journal,
// bounded and redaction-scanned (ADR-0022 Security).
type NodeScopeIterationPayload struct {
	ProjectID            string `json:"project_id"`
	RunID                string `json:"run_id"`
	ScopeKey             string `json:"scope_key"`
	NodeInstanceKey      string `json:"node_instance_key"`
	Iteration            int    `json:"iteration,omitempty"`
	Items                int    `json:"items,omitempty"`
	PassWhenResult       *bool  `json:"pass_when_result"`
	PredicateErrorDetail string `json:"predicate_error_detail,omitempty"`
}

// NodeScopeCompletedPayload is node.scope.completed (§ 3 row 18); the
// zero-item edge case emits items: 0.
type NodeScopeCompletedPayload struct {
	ProjectID       string         `json:"project_id"`
	RunID           string         `json:"run_id"`
	ScopeKey        string         `json:"scope_key"`
	NodeInstanceKey string         `json:"node_instance_key"`
	Kind            string         `json:"kind"`
	Iterations      int            `json:"iterations,omitempty"`
	Items           int            `json:"items"`
	ResultBindings  map[string]any `json:"result_bindings"`
}

// NodeScopeFailedPayload is node.scope.failed (§ 3 row 19). FailedCause is
// until_exhausted, child_failed, predicate_error or child_run_failed — an
// indeterminate predicate is a predicate_error that fails the scope at once,
// never counted as false (cost exhaustion reports the class predicate_error
// with the code predicate_cost_exceeded — § 6).
type NodeScopeFailedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ScopeKey        string `json:"scope_key"`
	NodeInstanceKey string `json:"node_instance_key"`
	Kind            string `json:"kind"`
	FailedCause     string `json:"failed_cause"`
	Evidence        []any  `json:"evidence"`
	Iterations      int    `json:"iterations_stopped,omitempty"`
}

// NodeAttemptStartedPayload is node.attempt.started (§ 3 row 20).
// SessionResumed is the single field M4 claims about session behaviour
// (`continue_live` is refused at validate, unsupported_session_mode).
type NodeAttemptStartedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	ErrorClass      string `json:"error_class"`
	WorkerAffinity  bool   `json:"worker_affinity"`
	SandboxVerified bool   `json:"sandbox_verified"`
	SessionResumed  *bool  `json:"session_resumed"`
}

// NodeAttemptCompletedPayload is node.attempt.completed (§ 3 row 21).
// Outputs is the bounded inline copy (≤ 32 KiB, contract § 6); the digest is
// what another process can verify.
type NodeAttemptCompletedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	OutputsDigest   string `json:"outputs_digest"`
	Outputs         any    `json:"outputs"`
	ArtifactRefs    []any  `json:"artifact_refs"`
	CheckpointSaved bool   `json:"checkpoint_saved"`
}

// NodeAttemptFailedPayload is node.attempt.failed (§ 3 row 22).
type NodeAttemptFailedPayload struct {
	ProjectID         string     `json:"project_id"`
	RunID             string     `json:"run_id"`
	NodeInstanceKey   string     `json:"node_instance_key"`
	AttemptNumber     int        `json:"attempt_number"`
	ErrorClass        string     `json:"error_class"`
	Detail            string     `json:"detail"`
	OutputErrors      []any      `json:"output_errors"`
	NextAttemptNumber int        `json:"next_attempt_number,omitempty"`
	ScheduledAt       *time.Time `json:"scheduled_at"`
}

// NodeAttemptInterruptedPayload is node.attempt.interrupted (§ 3 row 23).
// Reason is lease_expired, worker_gone, worker_shutdown,
// process_group_kill_timeout or human_takeover — reconciler rows for the
// first two, the worker closing its own attempt honestly for the last three,
// and never a claim of resume-without-loss.
type NodeAttemptInterruptedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	Reason          string `json:"reason"`
}

// NodeAttemptCancelledPayload is node.attempt.cancelled (§ 3 row 24). Reason
// is acp_cancel_ack, process_group_terminated or before_claim.
type NodeAttemptCancelledPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	NodeInstanceKey string `json:"node_instance_key"`
	AttemptNumber   int    `json:"attempt_number"`
	Reason          string `json:"reason"`
}

// NodeAttemptRetryScheduledPayload is node.attempt.retry_scheduled (§ 3 row
// 25): case 5's visible half — the backoff landing time is persisted, not
// recomputed from a memory.
type NodeAttemptRetryScheduledPayload struct {
	ProjectID         string    `json:"project_id"`
	RunID             string    `json:"run_id"`
	NodeInstanceKey   string    `json:"node_instance_key"`
	AttemptNumber     int       `json:"attempt_number"`
	NextAttemptNumber int       `json:"next_attempt_number"`
	ErrorClass        string    `json:"error_class"`
	DelaySeconds      int       `json:"delay_seconds"`
	ScheduledAt       time.Time `json:"scheduled_at"`
}

// ---------------------------------------------------------- M4: approval payloads

// ApprovalRequestedPayload is approval.requested (§ 3 row 26). The summary is
// digested, never copied: a gate summary may embed another node's output and
// the journal is readable by every project member; the full text is a
// GET /approvals/{approvalId} fetch.
type ApprovalRequestedPayload struct {
	ProjectID       string    `json:"project_id"`
	RunID           string    `json:"run_id"`
	ApprovalID      string    `json:"approval_id"`
	NodeInstanceKey string    `json:"node_instance_key"`
	SummaryDigest   string    `json:"summary_digest"`
	ArtifactRefs    []any     `json:"artifact_refs"`
	DeadlineAt      time.Time `json:"deadline_at"`
	OnTimeout       string    `json:"on_timeout"`
	ApproverRoles   []string  `json:"approver_roles"`
	ApproverUserIDs []string  `json:"approver_user_ids"`
}

// ApprovalDecidedPayload is approval.decided (§ 3 row 27). CommentsPresent is
// the honest boolean: the comment body is not journal material.
type ApprovalDecidedPayload struct {
	ProjectID       string `json:"project_id"`
	RunID           string `json:"run_id"`
	ApprovalID      string `json:"approval_id"`
	Decision        string `json:"decision"`
	CommentsPresent bool   `json:"comments_present"`
	Version         int    `json:"version"`
	DecidedBy       string `json:"decided_by"`
}

// ApprovalExpiredPayload is approval.expired (§ 3 row 28): the reconciler
// pass-2 arm; re_requested marks the exactly-once second gate.
type ApprovalExpiredPayload struct {
	ProjectID   string `json:"project_id"`
	RunID       string `json:"run_id"`
	ApprovalID  string `json:"approval_id"`
	OnTimeout   string `json:"on_timeout"`
	ReRequested bool   `json:"re_requested"`
}

// ApprovalDeniedPayload is approval.denied (§ 3 row 29): approver_lost_access,
// not_a_designated_approver, already_decided or run_terminal.
type ApprovalDeniedPayload struct {
	ProjectID  string `json:"project_id"`
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Reason     string `json:"reason"`
}

// ApprovalCancelledPayload is approval.cancelled (§ 3 row 30): run_cancelled
// or superseded.
type ApprovalCancelledPayload struct {
	ProjectID  string `json:"project_id"`
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Reason     string `json:"reason"`
}

// ------------------------------------------------- M4: pipeline library payloads

// PipelineCreatedPayload is § 3 row 31.
type PipelineCreatedPayload struct {
	ProjectID  string `json:"project_id"`
	PipelineID string `json:"pipeline_id"`
	Slug       string `json:"slug"`
}

// PipelineDraftUpdatedPayload is § 3 row 32 — the audit trail for editor
// churn: hashes and versions, never the document body.
type PipelineDraftUpdatedPayload struct {
	ProjectID    string `json:"project_id"`
	DraftID      string `json:"draft_id"`
	Version      int    `json:"version"`
	SourceSHA256 string `json:"source_sha256"`
	EditedBy     string `json:"edited_by"`
	Kind         string `json:"kind"`
}

// PipelineDraftValidatedPayload is § 3 row 33: codes only, so the journal
// records *what* failed without cloning the editor's payload.
type PipelineDraftValidatedPayload struct {
	ProjectID      string   `json:"project_id"`
	DraftID        string   `json:"draft_id"`
	Valid          bool     `json:"valid"`
	RevisionDigest string   `json:"revision_digest,omitempty"`
	PlanDigest     string   `json:"plan_digest,omitempty"`
	ErrorCount     int      `json:"error_count"`
	ErrorCodes     []string `json:"error_codes"`
}

// PipelineRevisionPublishedPayload is § 3 row 34 — 09's name, kept. Every
// digest is a § 1 CHECK shape: these are the values a run pins (ADR-0002).
type PipelineRevisionPublishedPayload struct {
	ProjectID      string `json:"project_id"`
	PipelineID     string `json:"pipeline_id"`
	RevisionID     string `json:"revision_id"`
	RevisionNumber int    `json:"revision_number"`
	VersionLabel   string `json:"version_label"`
	RevisionDigest string `json:"revision_digest"`
	PlanDigest     string `json:"plan_digest"`
	DigestScope    string `json:"digest_scope"`
	SchemaDigest   string `json:"schema_digest"`
	CelEnvDigest   string `json:"cel_env_digest"`
}

// PipelineRevisionDeprecatedPayload is § 3 row 35: the digest pins WHICH
// revision, so the journal survives a later publish shadowing the id.
type PipelineRevisionDeprecatedPayload struct {
	ProjectID      string `json:"project_id"`
	RevisionID     string `json:"revision_id"`
	RevisionDigest string `json:"revision_digest"`
}

// PipelineUpdatePayload is the ADR-0049 folder row: the metadata-only
// PATCH /pipelines/{id} appends it when `folder` changed (set or cleared).
// ProjectID is empty — a pipeline definition is org-scoped and has no
// project. ChangedFields names the body members that moved (ADR-0049 § 7:
// the detail carries `folder` when it changed; the list shape lets the
// route's other metadata members ride the same row without a new type).
type PipelineUpdatePayload struct {
	ProjectID     string   `json:"project_id"`
	PipelineID    string   `json:"pipeline_id"`
	ChangedFields []string `json:"changed_fields"`
}

// NodeTemplateCreatedPayload is ADR-0049 § 7's node_template.create — the
// template row and its revision 1 land in one transaction, and the row
// names both (the revision id through the created revision's digest
// identity would be a lie before the insert, so the slug pins the created
// content and version_label names it).
type NodeTemplateCreatedPayload struct {
	ProjectID    string `json:"project_id"`
	TemplateID   string `json:"template_id"`
	Slug         string `json:"slug"`
	VersionLabel string `json:"version_label"`
}

// NodeTemplateRevisionPublishedPayload is ADR-0049 § 7's
// node_template.revision.publish — "Edit for all N" from the UI side. The
// digest is the canonicalization of the revision's four content members
// (ADR-0021 scope v1alpha1-canonical-1), so the journal row is verifiable
// without re-reading the content.
type NodeTemplateRevisionPublishedPayload struct {
	ProjectID      string `json:"project_id"`
	TemplateID     string `json:"template_id"`
	RevisionID     string `json:"revision_id"`
	RevisionNumber int    `json:"revision_number"`
	VersionLabel   string `json:"version_label"`
	RevisionDigest string `json:"revision_digest"`
}

// PipelineDraftCreatedPayload is ADR-0049 § 5: the adopt-via-draft flow's
// journal row — one per adopted pipeline draft, written in the same
// transaction as the revision row it adopts from. Reason is "template_adopt"
// (a hand-authored draft has no such row; this journal row carries the
// reason). ProjectID is empty — a pipeline definition is org-scoped.
type PipelineDraftCreatedPayload struct {
	ProjectID    string `json:"project_id"`
	PipelineID   string `json:"pipeline_id"`
	DraftID      string `json:"draft_id"`
	Reason       string `json:"reason,omitempty"`
	TemplateID   string `json:"template_id,omitempty"`
	VersionLabel string `json:"version_label,omitempty"`
}

// NodeTemplateDuplicatedPayload is ADR-0049 § 7's node_template.duplicate:
// a NEW template whose revision 1 copies the source's latest revision
// (content-identical, hence same digest — the row keeps the source id so
// the copy's provenance survives without a second query).
type NodeTemplateDuplicatedPayload struct {
	ProjectID          string `json:"project_id"`
	TemplateID         string `json:"template_id"`
	SourceTemplateID   string `json:"source_template_id"`
	Slug               string `json:"slug"`
	SourceTemplateSlug string `json:"source_template_slug"`
}

// -------------------------------------------------------- M4: assignment payloads

// AssignmentCreatedPayload is § 3 row 36: the pin plus the ceilings, the
// whole M4 assignment (channels and promotes stay M6).
type AssignmentCreatedPayload struct {
	ProjectID         string         `json:"project_id"`
	AssignmentID      string         `json:"assignment_id"`
	PipelineID        string         `json:"pipeline_id"`
	PinnedRevisionID  string         `json:"pinned_revision_id"`
	RevisionDigest    string         `json:"revision_digest"`
	MaxConcurrentRuns int            `json:"max_concurrent_runs"`
	BudgetOverrides   map[string]any `json:"budget_overrides"`
}

// AssignmentUpdatedPayload is § 3 row 36: the created shape plus the
// before{}/after{} snapshot of only the changed members.
type AssignmentUpdatedPayload struct {
	ProjectID         string         `json:"project_id"`
	AssignmentID      string         `json:"assignment_id"`
	PipelineID        string         `json:"pipeline_id"`
	PinnedRevisionID  string         `json:"pinned_revision_id"`
	RevisionDigest    string         `json:"revision_digest"`
	MaxConcurrentRuns int            `json:"max_concurrent_runs"`
	BudgetOverrides   map[string]any `json:"budget_overrides"`
	Before            map[string]any `json:"before"`
	After             map[string]any `json:"after"`
}

// ------------------------------------------------------------ M6: schedules

// TypeScheduleFired is M6's trigger audit row (ADR-0032 § 4): one per
// schedule slot that created a run, appended in the transaction that advances
// the schedule row, correlated to the run it started (domain_events.run_id).
// A slot that was refused — assignment at its concurrency ceiling, disabled
// assignment, a failed create — writes nothing: the absence of a row is the
// honest record, and the tick's log line carries the reason.
const TypeScheduleFired = "schedule.fired"

// ScheduleFiredPayload is schedule.fired's shape. Per § 3's rules it is an
// object carrying project_id plus the ids it correlates on, and nothing else:
// the inputs a fire submitted are on the run's run_inputs rows, never copied
// here (an input can be pointed at a secret), and the fired slot travels as
// scheduled_for — the wall-clock minute the cron expression named, which is
// what distinguishes a late fire from an on-time one.
type ScheduleFiredPayload struct {
	ProjectID    string    `json:"project_id"`
	ScheduleID   string    `json:"schedule_id"`
	AssignmentID string    `json:"assignment_id"`
	RunID        string    `json:"run_id"`
	CronExpr     string    `json:"cron_expr"`
	ScheduledFor time.Time `json:"scheduled_for"`
	// LateFireCount is how many cron slots between the previous next_run_at
	// and this one were skipped rather than backfilled (ADR-0032 § 4: a
	// replica that was down for a day fires once for the latest slot). 0 is
	// the on-time answer.
	LateFireCount int `json:"late_fire_count"`
}

// ------------------------------------------------------------ M6: issue triggers

// TypeIssueTriggerFired is part 2's trigger audit row (ADR-0056 § 5): one per
// issue that created a run, appended in the fire transaction that also advanced
// the issue trigger's cursor. Like schedule.fired it is the honest record of a
// fire that happened; the refusal paths (assignment disabled at fire time,
// ceiling full) write nothing and the tick's log line carries the reason.
const TypeIssueTriggerFired = "issue_trigger.fired"

// IssueTriggerFiredPayload is issue_trigger.fired's shape. Per § 3's rules it
// is an object carrying project_id plus the ids it correlates on, and nothing
// else: the trigger's inputs are on the run's run_inputs rows, never copied
// here (an input can be pointed at a secret), and the fired issue travels as
// issue_number plus issue_url — the number is the idempotency key's suffix and
// the url is what an operator clicks to open the issue; the issue BODY never
// rides the journal (ADR-0021 Security).
type IssueTriggerFiredPayload struct {
	ProjectID    string `json:"project_id"`
	TriggerID    string `json:"trigger_id"`
	AssignmentID string `json:"assignment_id"`
	RunID        string `json:"run_id"`
	IssueNumber  int    `json:"issue_number"`
	IssueURL     string `json:"issue_url"`
}
