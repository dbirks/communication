package worker

import (
	"context"
	"errors"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// This file defines what the M2 turn-execution loop consumes. Everything is
// an interface or a plain struct so the loop is testable with fakes and no
// store type leaks into execution semantics (AGENTS.md dependency rule);
// *postgres.TurnStore implements TurnStore.

// ErrLeaseLost reports that a fenced write did not land because this
// process is not the current owner of the turn (ADR-0016 §3: "zero rows
// means the worker lost the turn and must stop writing, not renew harder").
// It is the loop's signal to stop touching the turn entirely — the honest
// terminal state is then somebody else's to write.
var ErrLeaseLost = errors.New("worker: lease lost (fencing token no longer current)")

// Claim is one turn won by ClaimTurn: the lease triple (turn id, worker id,
// fencing token) plus everything needed to run it without re-reading
// mutable state.
type Claim struct {
	TurnID         string
	ConversationID string
	ProjectID      string
	OrganizationID string
	WorkerID       string
	FencingToken   int64

	Prompt      string
	SubmittedBy string

	// LauncherID and PermissionMode come from the conversation's agent
	// profile; ModeID resolution (which session mode makes a launcher ask)
	// is the launcher registry's knowledge, injected via Config.AskModeID.
	LauncherID     string
	PermissionMode string // ask | preapproved_within_sandbox | deny
}

// TurnEvent is one journal append made on behalf of a turn or conversation.
type TurnEvent struct {
	Type      string
	ActorKind string
	ActorID   string
	Payload   any
}

// TurnOutcome closes a turn. Exactly one of the four terminal statuses is
// reported, with the harness's stop reason only when the harness reported
// one — an interrupted turn has no stop reason by construction (migration
// 00003 conversation_turn_interrupted_unreasoned).
type TurnOutcome struct {
	Status      string // completed | cancelled | failed | interrupted
	StopReason  string
	Reason      string // interrupted only: shutdown | ...
	Message     string // failed only: bounded diagnostic
	RequestedBy string // cancelled only: who asked
}

// PermissionOpen creates one durable permission prompt. Deadline is when
// the offer stops being actionable.
type PermissionOpen struct {
	ACPRequestID string
	ToolCallID   string
	Title        string
	Kind         string
	Options      []events.PermissionOption
	Deadline     time.Time
}

// PermissionState is the durable answer to a prompt: pending until the API
// (a decision) or the worker (expiry/cancel) settles it.
type PermissionState struct {
	Status    string // pending | decided | expired | cancelled
	OptionID  string
	DecidedBy string
}

// Repo is one project repository to mirror into the conversation workspace.
type Repo struct {
	// ID is repositories.id. M2 did not need it (a clone is addressed by URL);
	// M3 must, because workspace_repos has an FK to repositories(id) and a
	// repository *name* cannot fill a uuid column — and guessing one from the
	// name would be a topology record nobody could verify.
	ID            string
	Name          string
	GitURL        string
	DefaultBranch string
	// CredentialSecretID (ADR-0061) is non-empty when the repository has a
	// GitHub credential the mirror clone/fetch must resolve; it names the
	// secret, never a value.
	CredentialSecretID string
}

// TurnStore is the loop's persistence port, implemented by
// *postgres.TurnStore. Every method whose name takes a Claim must fail with
// ErrLeaseLost when the (turn, worker, fencing token) triple is not the
// current one (ADR-0016 §9 obligation 2), and must write nothing in that
// case — fail closed, not partially.
type TurnStore interface {
	// ClaimTurn wins at most one queued turn (FOR UPDATE SKIP LOCKED,
	// conversation affinity through the live ACP binding).
	ClaimTurn(ctx context.Context, workerID string) (Claim, bool, error)
	// RenewLease extends the deadline; ErrLeaseLost when the triple no
	// longer matches.
	RenewLease(ctx context.Context, c Claim) error
	// BeginTurn moves leased→running and appends conversation.turn.started
	// and conversation.message.user in the same transaction.
	BeginTurn(ctx context.Context, c Claim, bindingID string, s domain.SessionInfo) error
	// AppendTurnEvent is the fenced journal append used for every
	// transcript write made on behalf of a turn.
	AppendTurnEvent(ctx context.Context, c Claim, ev TurnEvent) error
	// AppendConversationEvent appends a conversation-scoped event that
	// belongs to no turn (agent.session.connected/disconnected).
	AppendConversationEvent(ctx context.Context, conversationID string, ev TurnEvent) error
	// CancelRequested reads this turn's cancel flag; ErrLeaseLost when the
	// triple is stale.
	CancelRequested(ctx context.Context, c Claim) (time.Time, bool, error)
	// ControllerUser resolves the current controller for the cancelled-by
	// attribution; "" when control is held by none.
	ControllerUser(ctx context.Context, conversationID string) (string, bool, error)
	// FinishTurn writes the terminal row and the matching terminal event,
	// fenced on the triple.
	FinishTurn(ctx context.Context, c Claim, o TurnOutcome) error

	// OpenPermission inserts a pending prompt and appends
	// conversation.permission.requested, fenced on the triple.
	OpenPermission(ctx context.Context, c Claim, p PermissionOpen) (permissionID string, err error)
	// PermissionState reads the durable decision (polled/LISTENed by the
	// loop; no fencing — reading is safe for any owner).
	PermissionState(ctx context.Context, permissionID string) (PermissionState, error)
	// ClosePermission expires or cancels a still-pending prompt and appends
	// the decided event; returns the final state and whether this call
	// closed it (a decided row is never rewritten).
	ClosePermission(ctx context.Context, c Claim, permissionID, status string) (PermissionState, bool, error)
	// DecidePermissionByPolicy records a still-pending prompt as `decided` by
	// the turn's permission policy (ADR-0039 Option A): the row carries
	// decided_by_kind='policy' + the policy name and the chosen option, and
	// the decided event names the policy as the decider. Returns the final
	// state and whether this call decided it (a decided row is never
	// rewritten).
	DecidePermissionByPolicy(ctx context.Context, c Claim, permissionID, optionID, policy string) (PermissionState, bool, error)

	// ProjectRepos lists a project's repositories for workspace prep.
	ProjectRepos(ctx context.Context, projectID string) ([]Repo, error)

	// WorkspaceEvent appends a workspace-scoped journal event on this turn's
	// fence. It is separate from AppendTurnEvent because the subject is a
	// workspace, not a conversation transcript: workspace.prepared and
	// sandbox.verified carry grant roles and digest facts that a browser has no
	// business rendering as message content, and because several of them
	// (workspace.released, workspace.quarantined) can legitimately be written
	// after the turn has reached its terminal state.
	WorkspaceEvent(ctx context.Context, c Claim, ev TurnEvent) error

	// RecordBinding closes any stale live binding for the conversation and
	// inserts the new connected row; closedPrior lists the ids whose
	// bindings this call closed (so the loop can event them).
	RecordBinding(ctx context.Context, c Claim, s domain.SessionInfo) (bindingID string, closedPrior []string, err error)
	// ResumableSession returns the session id of a live binding this worker
	// lost its process for (worker restart before the reconciler noticed),
	// only when the recorded capabilities advertised loadSession.
	ResumableSession(ctx context.Context, conversationID, workerID string) (domain.SessionInfo, bool, error)
	// CloseBinding marks this worker's live binding closed and returns the
	// affected ids for eventing.
	CloseBinding(ctx context.Context, conversationID, workerID, reason string) ([]string, error)
	// SetConversationStatus moves idle/active/disconnected as sessions come
	// and go.
	SetConversationStatus(ctx context.Context, conversationID, status string) error
}

// WorkspacePrep prepares the per-conversation working directory before a
// session launches and reports human-readable notes (clone failures) for the
// transcript — never fatal unless the directory itself cannot exist
// (communication-spec/05 layout: repos/<name>/, scratch/, meta/).
type WorkspacePrep interface {
	Prepare(ctx context.Context, conversationID string, repos []Repo) (workDir string, notes []string, err error)
}
