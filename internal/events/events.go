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
// from absence. NetworkEnforced=false on the agent-turn profile is the observed
// truth, reported rather than hidden (ADR-0019 D3, D-021 Provisional).
type SandboxVerifiedPayload struct {
	ProjectID       string         `json:"project_id"`
	TurnID          string         `json:"turn_id"`
	WorkspaceID     string         `json:"workspace_id"`
	WorkerID        string         `json:"worker_id"`
	PolicyDigest    string         `json:"policy_digest"`
	Backend         string         `json:"backend"`
	BackendVersion  string         `json:"backend_version"`
	AfUnixMediation string         `json:"af_unix_mediation"`
	NetworkEnforced bool           `json:"network_enforced"`
	Grants          []SandboxGrant `json:"grants"`
	CommitGranted   bool           `json:"commit_granted"`
	Verified        bool           `json:"verified"`
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
