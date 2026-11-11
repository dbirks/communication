package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/events"
)

// The M2 conversation surface (ADR-0016, api/openapi.yaml "conversations").
//
// Package api knows nothing about SQL: everything below is a view type, a
// validation rule and an interface a store adapter implements. The two things
// this package owns outright are the authorization *shape* (non-member 404 with
// an audit row, viewer 403, controller-only 409 carrying live state) and the
// rule that lease machinery never reaches a browser (ADR-0016 §8).

// Errors the conversation handlers understand. A store adapter maps its own
// errors onto these so this package stays free of any driver dependency.
var (
	// ErrConversationNotFound is also the answer to "you may not know this
	// conversation exists": a non-member gets 404, never 403 (ADR-0016 §8).
	ErrConversationNotFound = errors.New("api: conversation not found")
	// ErrConversationForbidden is a member whose role is too low to write
	// (viewer): 403, since role is not existence information.
	ErrConversationForbidden = errors.New("api: conversation write not allowed")
	// ErrConversationValidation is a well-formed body the contract rejects (an
	// unknown agent profile, an option the agent never offered): 422.
	ErrConversationValidation = errors.New("api: conversation request failed validation")
	// ErrConversationRepositoryNotFound is the answer to a well-formed
	// `repository` list filter naming no repository of the project (ADR-0067):
	// 404, the same answer an absent resource gets everywhere else on this
	// surface. A create body naming such a repository is
	// ErrConversationValidation (422) instead — a body field, not a filter.
	ErrConversationRepositoryNotFound = errors.New("api: conversation repository filter names no repository of this project")
	// ErrConversationBadRequest is the ADR-0068 switch-agent answer to a body
	// field naming no legal value (an agent_profile_id outside the project's
	// profiles): 400. It exists beside ErrConversationValidation (422) because
	// the switch route documents 400 for that refusal while the older routes
	// keep their 422; a store maps its own validation onto this one only for
	// the routes that promised 400.
	ErrConversationBadRequest = errors.New("api: conversation request is a bad request")
)

// ConversationConflictKind values. They are the store's vocabulary and this
// package's problem-type table at once, which is why they are plain strings
// pinned by cnvConflictTypes below rather than an enum the adapter would have
// to translate.
const (
	ConflictControlVersionStale  = "control_version_stale"
	ConflictNotController        = "not_controller"
	ConflictTurnInProgress       = "turn_in_progress"
	ConflictNoActiveTurn         = "no_active_turn"
	ConflictPermissionNotPending = "permission_not_pending"
	ConflictArchived             = "conversation_archived"
)

// ConversationConflict is a refused conversation mutation that must answer 409
// with the state that refused it. A bare 409 would leave the loser of a control
// race unable to learn who won (communication-spec/06 edge cases), so the
// conflict carries the live control row — and the turn in the way when a turn
// is what is in the way.
type ConversationConflict struct {
	Kind           string
	Detail         string
	ConversationID string
	Control        *ConversationControlView
	ActiveTurn     *ConversationTurnView
}

func (c *ConversationConflict) Error() string {
	if c == nil {
		return "api: conversation conflict"
	}
	return fmt.Sprintf("api: conversation conflict (%s): %s", c.Kind, c.Detail)
}

// --- views (api/openapi.yaml schemas) -----------------------------------

// AgentProfileView is the AgentProfile schema. launcher_id is a launch
// descriptor, never a claim that the harness works here
// (docs/compatibility/ACP.md answers that).
type AgentProfileView struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	LauncherID     string    `json:"launcher_id"`
	PermissionMode string    `json:"permission_mode"`
	CreatedAt      time.Time `json:"created_at"`
	// Version is the profile's CURRENT version (ADR-0058, migration 00014): the
	// optimistic-concurrency token the row carries and that writes must echo, and
	// the latest entry of the version history. It is always present — a profile
	// is never versionless — so the UI can render the version glyph without a
	// separate lookup.
	Version int `json:"version"`
	// The APM triple (ADR-0030). Explicit nulls, because "this profile stages no
	// packaged context" is an answer the UI has to be able to tell apart from a
	// field it never read. A ref with no digest is impossible by construction: the
	// store refuses a partial triple and the worker refuses an unverifiable pin.
	APMPackageRef *string `json:"apm_package_ref"`
	APMTarget     *string `json:"apm_target"`
	APMLockDigest *string `json:"apm_lock_digest"`
	// APMContents is the lock's names-only contents summary (ADR-0054): the
	// skills/instructions/MCP names the resolved package deploys, plus the
	// truncation flag. Null while the profile has no resolved lock — the honest
	// "not locked yet", never a fabricated empty list.
	APMContents *AgentProfileContentsView `json:"apm_contents"`
	// Model is the profile's pinned display model (ADR-0068, migration
	// 00023) — the "gpt-5" half of "Codex · gpt-5". Explicit null means the
	// profile names no model: the harness default, the honest state.
	Model *string `json:"model"`
	// APMCollectionPins is the profile's ORDERED attachment list (ADR-0084):
	// [{collection_id, revision}] in attach order, [] when the profile attaches
	// nothing. The order is not decoration — when two attached collections ship
	// one skill name, APM settles it by INSTALL order, so which entry came first
	// is which copy runs. `apm_lock_digest` is the digest of the ONE lock that
	// covers this list plus `apm_package_ref`, so a reader needs the list to know
	// what the digest is a digest OF.
	APMCollectionPins []APMCollectionPin `json:"apm_collections"`
}

// AgentProfileContentsView is the names-only lock summary the API reports
// after a worker-resolved lock (ADR-0054): what the package would deploy, by
// name, and whether the list was cut at the summary cap. It is a lock summary,
// not a payload — no lock file body, no paths beyond the names, no prompts or
// values.
type AgentProfileContentsView struct {
	Skills       []string `json:"skills"`
	Instructions []string `json:"instructions"`
	MCPServers   []string `json:"mcp_servers"`
	// SkillRefs is ADR-0084's per-skill attribution: which dependency of the
	// flattened set owns each deployed skill name, [{skill, from_ref}]. Two
	// attached collections can ship one skill name and APM settles that by INSTALL
	// order rather than by an error, so the app needs the winner named in the
	// record to say "overridden by …" beside the losing entry. Empty for a lock
	// resolved before ADR-0084 and for a single-package pin, where nothing is
	// overridden — that is a fact about the lock, not a missing read.
	SkillRefs []AgentProfileSkillRefView `json:"skill_refs"`
	Truncated bool                       `json:"truncated"`
}

// AgentProfileSkillRefView is one skill name with the coordinate that deployed
// it, in the profile's own ref grammar. `from_ref` is "" when the lock named no
// owning dependency for the skill, which the app renders as unattributed rather
// than as a guess.
type AgentProfileSkillRefView struct {
	Skill   string `json:"skill"`
	FromRef string `json:"from_ref"`
}

// AgentProfileVersion is one entry of a profile's version history (ADR-0058):
// the version number, the frozen launch-descriptor snapshot it carried, the
// writer, the optional note and the timestamp. The version is a key into the
// append-only history — a version is a state, never a delta — and the snapshot
// is the launch-descriptor state (name, launcher, permission mode, the APM
// coordinates), never a secret value: a profile only ever references secrets,
// it does not hold them.
type AgentProfileVersion struct {
	ProfileID string          `json:"profile_id"`
	Version   int             `json:"version"`
	Snapshot  json.RawMessage `json:"snapshot"`
	CreatedBy string          `json:"created_by"`
	CreatedAt time.Time       `json:"created_at"`
	Note      *string         `json:"note,omitempty"`
}

// AgentProfileVersionList is the {items:[...]} envelope the version-history
// routes answer (the same envelope every collection route returns).
type AgentProfileVersionList struct {
	Items []AgentProfileVersion `json:"items"`
}

// APMLockRequestView is the state of one apm_lock_requests row as the API
// answers it: the request id and status a client switches on, plus the bounded
// failure detail when the resolve failed.
type APMLockRequestView struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

// ConversationControlView is the ConversationControl schema. Version is the CAS
// token every control mutation must echo, so it is always present; the nullable
// members are emitted as explicit nulls because the UI distinguishes "nobody is
// driving" from a field it never read.
type ConversationControlView struct {
	Kind           string  `json:"kind"`
	UserID         *string `json:"user_id"`
	DisplayName    *string `json:"display_name"`
	PreviousUserID *string `json:"previous_user_id"`
	Version        int     `json:"version"`
}

// AgentSessionBindingView is the AgentSessionBinding schema: what is attached
// right now, as observed. Capabilities are the agent's own reported object —
// data, not a support claim (communication-spec/04).
type AgentSessionBindingView struct {
	BindingID         string          `json:"binding_id"`
	WorkerID          string          `json:"worker_id"`
	WorkerName        *string         `json:"worker_name"`
	LauncherID        string          `json:"launcher_id"`
	LauncherVersion   string          `json:"launcher_version"`
	ACPSessionID      string          `json:"acp_session_id"`
	ProtocolVersion   int             `json:"protocol_version"`
	SessionOrigin     string          `json:"session_origin"`
	AgentCapabilities json.RawMessage `json:"agent_capabilities"`
	ConnectedAt       time.Time       `json:"connected_at"`
	LastSeenAt        time.Time       `json:"last_seen_at"`
}

// ConversationTurnView is the ConversationTurn schema. lease_expires_at and
// fencing_token are deliberately absent: a browser cannot and must not
// participate in lease arbitration (ADR-0016 §8), so a token a client could use
// to pretend it owns work never leaves the server.
type ConversationTurnView struct {
	ID                     string  `json:"id"`
	ConversationID         string  `json:"conversation_id"`
	Status                 string  `json:"status"`
	Prompt                 string  `json:"prompt,omitempty"`
	SubmittedBy            string  `json:"submitted_by"`
	SubmittedByDisplayName *string `json:"submitted_by_display_name"`
	// SubmittedVia is the turn's origin (ADR-0062): human | schedule |
	// issue_trigger | child_run. An automation turn's submitted_by names the
	// human who authorised the automation, NOT a person who typed this
	// prompt — a transcript renders the author only alongside this kind, or
	// it pretends a human submitted an unattended run's prompt.
	SubmittedVia      string     `json:"submitted_via"`
	WorkerID          *string    `json:"worker_id"`
	CancelRequestedAt *time.Time `json:"cancel_requested_at"`
	StopReason        *string    `json:"stop_reason"`
	CreatedAt         time.Time  `json:"created_at"`
	StartedAt         *time.Time `json:"started_at"`
	FinishedAt        *time.Time `json:"finished_at"`
	// AgentProfileID is the profile this turn ran on, stamped at enqueue
	// (ADR-0068). Rows written before the per-turn profile existed resolve to
	// the conversation's profile — for them that WAS the turn's profile,
	// because nothing could move it until the switch route.
	AgentProfileID   string `json:"agent_profile_id"`
	AgentProfileName string `json:"agent_profile_name"`
	// Model is the profile's pinned display model ("Codex · gpt-5"); explicit
	// null when the profile names none (the harness default is the honest
	// answer, not a missing read).
	Model *string `json:"model"`
}

// PermissionOptionView is the PermissionOption schema — one choice the agent
// offered. A client may echo one, never invent one.
type PermissionOptionView struct {
	OptionID string `json:"option_id"`
	Label    string `json:"label"`
	Kind     string `json:"kind,omitempty"`
}

// PermissionRequestView is the PermissionRequest schema.
type PermissionRequestView struct {
	ID             string                 `json:"id"`
	ConversationID string                 `json:"conversation_id"`
	TurnID         string                 `json:"turn_id"`
	Status         string                 `json:"status"`
	ToolTitle      string                 `json:"tool_title"`
	ToolKind       string                 `json:"tool_kind"`
	ToolCallID     *string                `json:"tool_call_id"`
	Options        []PermissionOptionView `json:"options"`
	DecidedBy      *string                `json:"decided_by"`
	// DecidedByKind is user | policy (ADR-0039 Option A): the policy's
	// permission mode names itself on `decided` rows the controller never saw.
	DecidedByKind    *string    `json:"decided_by_kind"`
	DecidedByPolicy  *string    `json:"decided_by_policy"`
	DecisionOptionID *string    `json:"decision_option_id"`
	RequestedAt      time.Time  `json:"requested_at"`
	DeadlineAt       *time.Time `json:"deadline_at"`
	DecidedAt        *time.Time `json:"decided_at"`
}

// ConversationRunLinkView is the ConversationRunLink schema: the run node a
// run-linked conversation was opened for, taken from the NEWEST attempt that
// references the conversation (ADR-0043). RunTitle is nullable because the
// runs table has no title column yet; NodeID is the definition node id when
// node_executions.node_id carries one.
type ConversationRunLinkView struct {
	RunID           string  `json:"run_id"`
	RunTitle        *string `json:"run_title"`
	NodeExecutionID string  `json:"node_execution_id"`
	NodeInstanceKey string  `json:"node_instance_key"`
	NodeID          *string `json:"node_id"`
	AttemptID       string  `json:"attempt_id"`
	AttemptNumber   int     `json:"attempt_number"`
}

// ConversationLinkedRunView is the ConversationLinkedRun schema (ADR-0053):
// one run this conversation was handed to — the forward link, complementing
// the run_link's reverse direction. CreatedAt is the handoff moment.
type ConversationLinkedRunView struct {
	RunID     string    `json:"run_id"`
	CreatedAt time.Time `json:"created_at"`
}

// ConversationChatAgentView is the ConversationChatAgent schema (ADR-0068):
// one entry of the derived "agents in this chat" list — a profile, its
// display model, and the 1-based turn ordinals (conversation creation order)
// it ran consecutively. A profile switched away from and back appears twice,
// because the ranges describe the transcript, not a per-profile aggregate.
type ConversationChatAgentView struct {
	AgentProfileID   string  `json:"agent_profile_id"`
	AgentProfileName string  `json:"agent_profile_name"`
	Model            *string `json:"model"`
	FirstTurn        int     `json:"first_turn"`
	LastTurn         int     `json:"last_turn"`
	TurnCount        int     `json:"turn_count"`
}

// ConversationView is the Conversation schema.
type ConversationView struct {
	ID                 string                   `json:"id"`
	ProjectID          string                   `json:"project_id"`
	AgentProfileID     string                   `json:"agent_profile_id"`
	AgentProfileName   string                   `json:"agent_profile_name"`
	LauncherID         string                   `json:"launcher_id"`
	Title              string                   `json:"title"`
	Status             string                   `json:"status"`
	CreatedBy          string                   `json:"created_by"`
	CreatedByDisplay   *string                  `json:"created_by_display_name"`
	CreatedAt          time.Time                `json:"created_at"`
	UpdatedAt          time.Time                `json:"updated_at"`
	Control            ConversationControlView  `json:"control"`
	ActiveTurn         *ConversationTurnView    `json:"active_turn"`
	AgentSession       *AgentSessionBindingView `json:"agent_session"`
	PendingPermissions []PermissionRequestView  `json:"pending_permissions"`
	// Origin is "manual" or "run": run iff an attempt references the
	// conversation; RunLink names that attempt's node for deep-linking.
	Origin  string                   `json:"origin"`
	RunLink *ConversationRunLinkView `json:"run_link"`
	// LinkedRuns (ADR-0053): the runs this thread was handed to (forward
	// link), creation order; empty when none.
	LinkedRuns []ConversationLinkedRunView `json:"linked_runs"`
	// AgentProfileID names the profile the NEXT turn runs on (ADR-0068):
	// only the controller moves it, only between turns. AgentProfileModel is
	// that profile's pinned display model (explicit null when it names none).
	AgentProfileModel *string `json:"agent_profile_model"`
	// Agents (ADR-0068): the derived "agents in this chat" list with turn
	// ranges, transcript order; empty for a conversation with no turns.
	Agents []ConversationChatAgentView `json:"agents"`
	// RepositoryName (ADR-0067) is the repository this thread was born
	// bound to, or null when unbound. The list row has carried the same
	// resolution since ADR-0065; the detail carries it so the composer's
	// @-menu (ADR-0072 § 9) can offer the project's OTHER repositories.
	RepositoryName *string `json:"repository_name"`
	// RepositoryID (ADR-0067 amendment) is the DECLARED binding behind the
	// name above — conversations.repository_id as stored, null when unbound.
	// The name answers the whole three-arm derivation; the id answers only
	// the declared arm, and it is what the WORKS IN switcher's tick and the
	// `conversation.scope_changed` journal row correlate on.
	RepositoryID *string `json:"repository_id"`
	// LinkedChats (ADR-0072): the agent-mail links on this conversation,
	// either direction, newest first; empty when the project's agent-mail
	// setting has never produced a link here.
	LinkedChats []ConversationLinkView `json:"linked_chats"`
}

// ConversationMailAskView is the ConversationMailAsk schema: the accepted
// composer @-ask (ADR-0072 § 9) — the link it created and the linked chat
// it opened. The answer rides the journal back to this conversation exactly
// as for an agent-dispatched ask; this response is only the acceptance.
type ConversationMailAskView struct {
	LinkID           string `json:"link_id"`
	ToConversationID string `json:"to_conversation_id"`
	Repo             string `json:"repo"`
	Question         string `json:"question"`
	State            string `json:"state"`
}

// ConversationLinkView is the ConversationLink schema: one agent-mail link
// (ADR-0072) as the chat's side panel and mail card read it. Direction is
// from THIS conversation's point of view: "outgoing" = this chat asked, "in"
// = this chat was asked. Question/answer are the stored texts (answer is
// null until the link is answered; reason is set only when it failed).
type ConversationLinkView struct {
	ID                string                    `json:"id"`
	Direction         string                    `json:"direction"` // outgoing | incoming
	RepoName          string                    `json:"repo_name"`
	State             string                    `json:"state"` // asked | answered | failed | expired
	Question          string                    `json:"question"`
	Answer            *string                   `json:"answer"`
	Reason            *string                   `json:"reason"`
	OtherConversation ConversationLinkOtherView `json:"other_conversation"`
	LauncherID        string                    `json:"launcher_id"`
	CreatedAt         time.Time                 `json:"created_at"`
	AnsweredAt        *time.Time                `json:"answered_at"`
}

// ConversationLinkOtherView is the linked chat the row points at: enough to
// render the row and the `open chat ›` link (id, title, live status).
type ConversationLinkOtherView struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// ConversationSummaryView is the ConversationSummary schema: the project
// timeline row. It carries the controller and two booleans and none of the
// joins the detail route pays for.
type ConversationSummaryView struct {
	ID               string                  `json:"id"`
	ProjectID        string                  `json:"project_id"`
	AgentProfileID   string                  `json:"agent_profile_id"`
	Title            string                  `json:"title"`
	Status           string                  `json:"status"`
	CreatedBy        string                  `json:"created_by"`
	CreatedByDisplay *string                 `json:"created_by_display_name"`
	CreatedAt        time.Time               `json:"created_at"`
	UpdatedAt        time.Time               `json:"updated_at"`
	Control          ConversationControlView `json:"control"`
	HasActiveTurn    bool                    `json:"has_active_turn"`
	AgentConnected   bool                    `json:"agent_connected"`
	// Origin and RunLink as on ConversationView (ADR-0043): a list row must
	// say whether it is manual or run-linked without the detail route's joins.
	Origin  string                   `json:"origin"`
	RunLink *ConversationRunLinkView `json:"run_link"`
	// RepositoryID/RepositoryName (ADR-0065): the thread's repository — the
	// first repository bound to its newest live-or-released workspace, else
	// the repository of the run it is linked to (a run node's thread has no
	// binding of its own; the work is in the run's workspace). Both null when
	// neither says one.
	RepositoryID   *string `json:"repository_id"`
	RepositoryName *string `json:"repository_name"`
	// LastAgentLine (ADR-0065, amended): the newest agent transcript row
	// rendered to one preview line — first non-empty line, trimmed, ≤ 160 chars
	// with an ellipsis when cut. A row that is one JSON object, pretty-printed
	// and/or inside a ```json fence (the structured output a run node's agent
	// ends on) is parsed whole and read as its own words instead of its braces:
	// the first non-blank string under `summary`/`goal`/`title`/`notes`/
	// `reason`/`message` at depth 0 then depth 1 (`plan.goal` included), else
	// the first string breadth-first up to three containers deep, else — with no
	// string anywhere — its top-level scalars as `key: value · key: value`
	// (`approved: true`). Anything else, and whatever line was chosen, then takes
	// the plain rule. Rendered by the store (cnvLastAgentLine); null when the
	// agent has not spoken.
	LastAgentLine *string `json:"last_agent_line"`
}

// --- the store interfaces handlers call ---------------------------------

// ConversationStore is everything the conversation handlers need from the
// datastore. Every method enforces the caller's visibility itself — the handler
// cannot be the only gate, because the same store backs later transports — and
// answers ErrConversationNotFound, ErrConversationForbidden,
// ErrConversationValidation or *ConversationConflict for the cases named in
// api/openapi.yaml.
type ConversationStore interface {
	// ListConversations returns the project's conversations; origin ("" | "manual" | "run")
	// and query (case-insensitive title substring, "" = off) are the ADR-0043
	// filters and are validated by the handler before they reach the store;
	// repository (ADR-0067) is a repository NAME of the project ("" = off),
	// syntax-validated by the handler and resolved by the store — a name the
	// project does not have answers ErrConversationRepositoryNotFound.
	ListConversations(ctx context.Context, c Caller, projectID, origin, query, repository string) ([]ConversationSummaryView, error)
	// CreateConversation starts a thread; repository (ADR-0067, "" = unbound)
	// is the project repository the thread is born bound to — a name the
	// project does not have answers ErrConversationValidation (422).
	CreateConversation(ctx context.Context, c Caller, projectID, agentProfileID, title, prompt, repository string) (ConversationView, error)
	GetConversation(ctx context.Context, c Caller, conversationID string) (ConversationView, error)
	PostMessage(ctx context.Context, c Caller, conversationID, prompt string) (ConversationTurnView, error)
	// AskRepoMail is the composer @-ask (ADR-0072 § 9): the conversation's
	// controller asks the agent of another project repository a question.
	// It creates the linked target chat through the same arm the worker's
	// DispatchMail uses — read-only target, depth 1, per-chat cap, asked_by
	// the caller — and journals conversation.mail.asked with an empty
	// `turn_id` (no agent turn asked; a person did). Refusals: mail off or
	// a non-controller is ErrConversationForbidden (403), a repository the
	// project does not have is ErrConversationBadRequest (400), the cap and
	// the depth rule are ErrConversationValidation (422).
	AskRepoMail(ctx context.Context, c Caller, conversationID, repoName, question string) (ConversationMailAskView, error)
	TakeControl(ctx context.Context, c Caller, conversationID string, version int) (ConversationView, error)
	ReturnControl(ctx context.Context, c Caller, conversationID string, version int) (ConversationView, error)
	CancelTurn(ctx context.Context, c Caller, conversationID string) (ConversationTurnView, error)
	DecidePermission(ctx context.Context, c Caller, conversationID, requestID, optionID string) (PermissionRequestView, error)
	// SwitchAgent sets the profile the NEXT turn runs on (ADR-0068). Only the
	// human controller, only between turns: a non-controller (or a role that
	// cannot write) is ErrConversationForbidden, a conversation with a queued/
	// leased/running turn is a *ConversationConflict (turn_in_progress), and a
	// profile outside the project's organization is ErrConversationBadRequest.
	// On success conversation.agent.switched is journalled and the fresh
	// conversation view (including the derived agents list) is returned.
	SwitchAgent(ctx context.Context, c Caller, conversationID, agentProfileID string) (ConversationView, error)
	// ChangeScope sets the repository the thread works in (ADR-0067
	// amendment): repositoryID is a project repository id, or "" for the
	// whole project (null). Same authorization as sending a turn — the
	// human controller (a non-controller is a *ConversationConflict, a role
	// that cannot write is ErrConversationForbidden) — and a repository the
	// conversation's project does not have is ErrConversationValidation
	// (422, repository_not_in_project; a foreign id leaks nothing). On
	// success conversation.scope_changed is journalled with the from/to ids
	// and the fresh conversation view is returned.
	ChangeScope(ctx context.Context, c Caller, conversationID, repositoryID string) (ConversationView, error)
	// AuthorizeConversation answers the one question an open stream must keep
	// asking: may this caller still see this conversation's project?
	AuthorizeConversation(ctx context.Context, c Caller, conversationID string) (projectID string, err error)
	// RecordDenied audits a refused attempt against a conversation.
	RecordDenied(ctx context.Context, c Caller, conversationID, action string) error
	// RecordProjectDenied audits a refused attempt on a project-scoped
	// conversation route (list, create), where there is no conversation to name
	// yet and the project id is all the route has. Without it a non-member
	// probing /projects/{id}/conversations would leave no trace at all, which is
	// precisely the probing ADR-0014 §3 wants visible.
	RecordProjectDenied(ctx context.Context, c Caller, projectID, action string) error
}

// cnvTarget names what a refused attempt was aimed at, and why. Exactly one of
// the two ids is set by any route: the project-scoped routes have a project id
// and no conversation, the conversation-scoped routes have the reverse.
type cnvTarget struct {
	action         string
	projectID      string
	conversationID string
}

func cnvAtConversation(action, conversationID string) cnvTarget {
	return cnvTarget{action: action, conversationID: conversationID}
}

func cnvAtProject(action, projectID string) cnvTarget {
	return cnvTarget{action: action, projectID: projectID}
}

// ConversationEventStream is the journal read behind the conversation SSE
// route. It is the conversation-scoped twin of EventStream, and the same
// wake-up-is-a-hint rule applies: the handler always re-queries by sequence.
type ConversationEventStream interface {
	ConversationEventsAfter(ctx context.Context, c Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error)
	Watch(ctx context.Context) (<-chan struct{}, func(), error)
}

// ProfileStore reads the agent profiles the caller's organization may launch,
// and (ADR-0030) writes their identity and their APM pin. Writes are the
// organization's library role — the same predicate api/pipelines.go applies to
// the shared pipeline library — and the store re-checks it in its own SQL.
type ProfileStore interface {
	ListAgentProfiles(ctx context.Context, c Caller) ([]AgentProfileView, error)
	CreateAgentProfile(ctx context.Context, c Caller, in AgentProfileCreateInput) (AgentProfileView, error)
	PatchAgentProfileAPM(ctx context.Context, c Caller, profileID string, in AgentProfileAPMPatch) (AgentProfileView, error)
	// Usage is GET /api/v1/agent-profiles/{profileId}/usage: the workflows
	// that reference this profile, from the latest published revision plus
	// the open drafts (the app-shell's Used-by panel; read-only, any org
	// member, org-scoped in the store's SQL, invisible subject → 404).
	Usage(ctx context.Context, c Caller, profileID string) (AgentProfileUsage, error)
	// CreateAPMLockRequest is POST /api/v1/agent-profiles/{profileId}/apm/lock:
	// the control-plane half of the server-side lock (ADR-0054). It queues a
	// worker-side resolve and answers 202 with the new request's id.
	CreateAPMLockRequest(ctx context.Context, c Caller, profileID string) (APMLockRequestView, error)
	// GetAPMLockRequest is GET /api/v1/agent-profiles/{profileId}/apm/lock: the
	// latest lock request status for one profile.
	GetAPMLockRequest(ctx context.Context, c Caller, profileID string) (APMLockRequestView, error)
	// ListAgentProfileVersions is GET /api/v1/agent-profiles/{profileId}/versions
	// (ADR-0058): the profile's version history, oldest first, for the app-shell's
	// version panel. Read-only; any member of the owning organization may ask, the
	// answer is the caller's own organization's history only, invisible subject →
	// 404.
	ListAgentProfileVersions(ctx context.Context, c Caller, profileID string) ([]AgentProfileVersion, error)
	// GetAgentProfileVersion is GET /api/v1/agent-profiles/{profileId}/versions/{version}:
	// one frozen version of one profile (ADR-0058). The version is a key into the
	// append-only history, not a mutable row; a version no profile carried answers
	// not-found.
	GetAgentProfileVersion(ctx context.Context, c Caller, profileID string, version int) (AgentProfileVersion, error)
	// RestoreAgentProfileVersion is POST /api/v1/agent-profiles/{profileId}/versions/{version}/restore
	// (ADR-0058): "restore version n" is a new write whose snapshot equals version n's
	// snapshot and lands as the profile's next version — history is append-only, so a
	// restore gains a version rather than rewriting one. The write carries the caller's
	// current optimistic token, so a concurrent write between the read and the write
	// refuses with ErrProfileVersionConflict instead of silently overwriting.
	RestoreAgentProfileVersion(ctx context.Context, c Caller, profileID string, version int) (AgentProfileView, int, error)
}

// Validation limits, the tighter of api/openapi.yaml and the schema CHECKs.
const (
	cnvMaxTitleLen  = 200
	cnvMaxPromptLen = 65536
	cnvMaxOptionLen = 200
	// cnvMaxMailRepoLen / cnvMaxMailQuestionLen are the conversation_links
	// CHECKs (migration 00026) the composer @-ask (`mail_to`) must respect:
	// the target repository name and the question are stored verbatim.
	cnvMaxMailRepoLen     = 200
	cnvMaxMailQuestionLen = 4096
)

// RegisterConversations mounts the conversation, turn, control, permission and
// transcript-stream routes of api/openapi.yaml on s, and RegisterAgentProfiles
// mounts the profile listing they need. Mutations require the CSRF/Origin pair
// HandleAuthed installs from the pattern's method.
func RegisterConversations(s *Server, store ConversationStore, profiles ProfileStore, stream ConversationEventStream) {
	h := &cnvHandlers{store: store, profiles: profiles, srv: s}
	if profiles != nil {
		s.HandleAuthed("GET /api/v1/agent-profiles", http.HandlerFunc(h.listProfiles))
		// ADR-0030: profiles are writable by the organization's library role.
		s.HandleAuthed("POST /api/v1/agent-profiles", http.HandlerFunc(h.createProfile))
		s.HandleAuthed("PATCH /api/v1/agent-profiles/{profileId}", http.HandlerFunc(h.patchProfile))
		// The app-shell's Used-by panel (design handoff W5): the workflows
		// that reference this profile, from the latest published revision plus
		// the open drafts.
		s.HandleAuthed("GET /api/v1/agent-profiles/{profileId}/usage", http.HandlerFunc(h.getProfileUsage))
		s.HandleAuthed("POST /api/v1/agent-profiles/{profileId}/apm/lock", http.HandlerFunc(h.postAgentProfileAPMLock))
		s.HandleAuthed("GET /api/v1/agent-profiles/{profileId}/apm/lock", http.HandlerFunc(h.getAgentProfileAPMLock))
		// ADR-0058 versioned agent profiles: the version history reads.
		s.HandleAuthed("GET /api/v1/agent-profiles/{profileId}/versions", http.HandlerFunc(h.listAgentProfileVersions))
		s.HandleAuthed("GET /api/v1/agent-profiles/{profileId}/versions/{version}", http.HandlerFunc(h.getAgentProfileVersion))
		// ADR-0058 versioned agent profiles: "restore version n" is a new write
		// whose snapshot equals version n's (the design's "Save as v4").
		s.HandleAuthed("POST /api/v1/agent-profiles/{profileId}/versions/{version}/restore", http.HandlerFunc(h.restoreProfileVersion))
	}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/conversations", http.HandlerFunc(h.listConversations))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/conversations", http.HandlerFunc(h.createConversation))
	s.HandleAuthed("GET /api/v1/conversations/{conversationId}", http.HandlerFunc(h.getConversation))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/messages", http.HandlerFunc(h.postMessage))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/take-control", http.HandlerFunc(h.takeControl))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/return-control", http.HandlerFunc(h.returnControl))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/cancel", http.HandlerFunc(h.cancel))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/switch-agent", http.HandlerFunc(h.switchAgent))
	s.HandleAuthed("PATCH /api/v1/conversations/{conversationId}", http.HandlerFunc(h.changeScope))
	s.HandleAuthed("POST /api/v1/conversations/{conversationId}/permissions/{requestId}", http.HandlerFunc(h.decidePermission))
	if stream != nil {
		registerConversationEvents(s, h, stream, evtProductionTiming())
	}
}

type cnvHandlers struct {
	store    ConversationStore
	profiles ProfileStore
	srv      *Server
}

// --- request bodies -----------------------------------------------------

type cnvCreateBody struct {
	AgentProfileID string `json:"agent_profile_id"`
	Title          string `json:"title"`
	Prompt         string `json:"prompt,omitempty"`
	// Repository (ADR-0067) is an optional project repository NAME: the
	// conversation is born bound to it. Absent or "" is unbound, the pre-0067
	// shape.
	Repository string `json:"repository,omitempty"`
}

type cnvMessageBody struct {
	Prompt string `json:"prompt"`
	// MailTo (ADR-0072 § 9) is an optional project repository NAME. Set, the
	// prompt is not this chat's next turn but a question for the agent of
	// that repository: the person-initiated composer @-ask, dispatched
	// through the same mail machinery the worker drives.
	MailTo string `json:"mail_to,omitempty"`
}

type cnvControlBody struct {
	Version int `json:"version"`
}

type cnvPermissionBody struct {
	OptionID string `json:"option_id"`
}

type cnvSwitchAgentBody struct {
	AgentProfileID string `json:"agent_profile_id"`
}

// cnvScopeBody is PATCH /api/v1/conversations/{id} (ADR-0067 amendment): the
// repository the thread works in. nil (absent or JSON null) is the whole
// project — unbound; a value must be one of the project's repository ids.
type cnvScopeBody struct {
	RepositoryID *string `json:"repository_id"`
}

// --- handlers -----------------------------------------------------------

func (h *cnvHandlers) listProfiles(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.profiles.ListAgentProfiles(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, cnvTarget{action: "profile.list"}, err)
		return
	}
	if items == nil {
		items = []AgentProfileView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]AgentProfileView]{Items: items})
}

func (h *cnvHandlers) listConversations(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	// ADR-0043 list filters. Both are optional; an invalid value is a 400 in
	// the file's usual problem shape before any store call, so a bad request
	// cannot even probe visibility.
	origin := r.URL.Query().Get("origin")
	if origin != "" && origin != "manual" && origin != "run" {
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_origin: origin must be 'manual' or 'run'.")
		return
	}
	query := r.URL.Query().Get("q")
	if len(query) > 200 {
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_query: q must be at most 200 characters.")
		return
	}
	// ADR-0067: a repository filter must at least be a repository name this
	// app could ever have created — the projects.go pattern AND the same
	// "."/".." traversal refusal addRepository applies — so a syntactic junk
	// value is the same 400 the other filters raise, before any lookup. A
	// well-formed name the project does not have is the store's 404.
	repository := r.URL.Query().Get("repository")
	if repository != "" && (repository == "." || repository == ".." || !prjRepoNamePattern.MatchString(repository)) {
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_repository: repository must be a repository name (1-100 characters of [A-Za-z0-9._-]).")
		return
	}
	items, err := h.store.ListConversations(r.Context(), c, projectID, origin, query, repository)
	if err != nil {
		h.fail(w, r, c, cnvAtProject("conversation.list", projectID), err)
		return
	}
	if items == nil {
		items = []ConversationSummaryView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]ConversationSummaryView]{Items: items})
}

func (h *cnvHandlers) createConversation(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")

	var body cnvCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		cnvInvalid(w, "title is required.")
		return
	}
	if utf8.RuneCountInString(title) > cnvMaxTitleLen {
		cnvInvalid(w, fmt.Sprintf("title must be at most %d characters.", cnvMaxTitleLen))
		return
	}
	if !validUUID(body.AgentProfileID) {
		cnvInvalid(w, "agent_profile_id must be a uuid.")
		return
	}
	prompt := body.Prompt
	if strings.TrimSpace(prompt) != "" && utf8.RuneCountInString(prompt) > cnvMaxPromptLen {
		cnvInvalid(w, fmt.Sprintf("prompt must be at most %d characters.", cnvMaxPromptLen))
		return
	}
	// ADR-0067: the declared repository is a body field, so a malformed name
	// is 422 like every other body refusal here; a well-formed name the
	// project does not have is the store's 422 too ("no such repository"),
	// the same answer an unknown profile gets.
	repository := strings.TrimSpace(body.Repository)
	if repository != "" && (repository == "." || repository == ".." || !prjRepoNamePattern.MatchString(repository)) {
		cnvInvalid(w, "repository must be a repository name (1-100 characters of [A-Za-z0-9._-]).")
		return
	}

	chat, err := h.store.CreateConversation(r.Context(), c, projectID, body.AgentProfileID, title, prompt, repository)
	if err != nil {
		h.fail(w, r, c, cnvAtProject("conversation.create", projectID), err)
		return
	}
	WriteJSON(w, http.StatusCreated, chat)
}

func (h *cnvHandlers) getConversation(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	chat, err := h.store.GetConversation(r.Context(), c, conversationID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.get", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

func (h *cnvHandlers) postMessage(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvMessageBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		cnvInvalid(w, "prompt is required.")
		return
	}
	if utf8.RuneCountInString(body.Prompt) > cnvMaxPromptLen {
		cnvInvalid(w, fmt.Sprintf("prompt must be at most %d characters.", cnvMaxPromptLen))
		return
	}

	// ADR-0072 § 9: `mail_to` set turns this post into a composer @-ask —
	// the question goes to the agent of another project repository, and NO
	// turn is queued on this conversation. The store arm creates the linked
	// chat exactly as the worker's dispatch does.
	if mailTo := strings.TrimSpace(body.MailTo); mailTo != "" {
		h.postMailAsk(w, r, c, conversationID, mailTo, body.Prompt)
		return
	}

	turn, err := h.store.PostMessage(r.Context(), c, conversationID, body.Prompt)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.message", conversationID), err)
		return
	}
	// 202, not 201: the prompt is durable, the answer is not, and nothing here
	// waits for the agent (ADR-0016 §3).
	w.Header().Set("Location", "/api/v1/conversations/"+conversationID)
	WriteJSON(w, http.StatusAccepted, turn)
}

// postMailAsk is the `mail_to` arm of the message route (ADR-0072 § 9). The
// bounds mirror the conversation_links CHECKs the ask must fit; the rest —
// the setting, the controller lock, the project's repositories, the cap and
// the depth rule — is the store's answer, rendered like every other route:
// a repository the project does not have is 400 (the caller named a thing
// that does not exist in this project's scope — the same split the switch-
// agent route follows between "you sent junk" and "you sent a real name of
// nothing"); mail off and a non-controller are 403 identity refusals; the
// per-chat cap and the depth rule are 422.
func (h *cnvHandlers) postMailAsk(w http.ResponseWriter, r *http.Request, c Caller, conversationID, mailTo, question string) {
	if utf8.RuneCountInString(mailTo) > cnvMaxMailRepoLen {
		cnvInvalid(w, fmt.Sprintf("mail_to must be at most %d characters.", cnvMaxMailRepoLen))
		return
	}
	if utf8.RuneCountInString(question) > cnvMaxMailQuestionLen {
		cnvInvalid(w, fmt.Sprintf("a mail question must be at most %d characters.", cnvMaxMailQuestionLen))
		return
	}
	ask, err := h.store.AskRepoMail(r.Context(), c, conversationID, mailTo, question)
	if err != nil {
		target := cnvAtConversation("conversation.mail", conversationID)
		if errors.Is(err, ErrConversationBadRequest) {
			// Not h.fail: that 400 arm names the switch route's field
			// (`invalid_agent_profile`); the store's sentence already names
			// `mail_to` and the repository it could not find.
			h.denied(w, r, c, target, "no repository named by mail_to in this project")
			WriteProblem(w, http.StatusBadRequest, "Bad Request",
				cnvSentinelDetail(err, ErrConversationBadRequest))
			return
		}
		h.fail(w, r, c, target, err)
		return
	}
	// 202 like the prompt arm: the ask is durable, the answer is not. The
	// Location names the created resource — the linked chat the ask opened.
	w.Header().Set("Location", "/api/v1/conversations/"+ask.ToConversationID)
	WriteJSON(w, http.StatusAccepted, ask)
}

func (h *cnvHandlers) takeControl(w http.ResponseWriter, r *http.Request) {
	h.controlMutation(w, r, "conversation.take-control", h.store.TakeControl)
}

func (h *cnvHandlers) returnControl(w http.ResponseWriter, r *http.Request) {
	h.controlMutation(w, r, "conversation.return-control", h.store.ReturnControl)
}

// controlMutation is both control routes: the bodies, the validation, the 409
// rendering and the response are identical, and the only difference between
// taking and returning is which state the store requires.
func (h *cnvHandlers) controlMutation(w http.ResponseWriter, r *http.Request, action string, fn func(context.Context, Caller, string, int) (ConversationView, error)) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvControlBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	// version >= 1 is conversation_control's own CHECK; saying 422 here keeps a
	// client that never read a control row from looking like it lost a race.
	if body.Version < 1 {
		cnvInvalid(w, "version must be at least 1.")
		return
	}

	chat, err := fn(r.Context(), c, conversationID, body.Version)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation(action, conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

func (h *cnvHandlers) cancel(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	turn, err := h.store.CancelTurn(r.Context(), c, conversationID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.cancel", conversationID), err)
		return
	}
	// A cancellation is a request, not a stop: 202 because the turn is still
	// non-terminal whenever a worker has to notice (ADR-0016 §5).
	WriteJSON(w, http.StatusAccepted, turn)
}

// switchAgent sets the profile the NEXT turn runs on (ADR-0068). The body is
// one field; both of its malformed shapes are refused before any store call —
// a non-uuid id is 400 here, and a well-formed id that is not one of the
// project's profiles is the store's 400 (invalid_agent_profile), the same
// split the file's other routes follow between "you sent junk" and "you sent
// a real id of nothing". Everything else (403 not the controller, 409 mid-
// turn, 409 archived) is the store's answer, rendered by fail().
func (h *cnvHandlers) switchAgent(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvSwitchAgentBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !validUUID(body.AgentProfileID) {
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_agent_profile: agent_profile_id must be a uuid.")
		return
	}

	chat, err := h.store.SwitchAgent(r.Context(), c, conversationID, body.AgentProfileID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.switch-agent", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

// changeScope moves the thread's repository scope (ADR-0067 amendment): the
// WORKS IN switcher's write. The body carries one field — repository_id, a
// project repository id or null for the whole project. A malformed uuid is
// refused before any store call (422 invalid_repository_id, the same split
// this file's create route follows for its `repository` field: a body that
// names junk is a 422, not a 400); a well-formed id the conversation's
// project does not have is the store's 422 (repository_not_in_project).
// Everything else — 403 not a writer, 409 not the controller, 409 archived —
// is the store's answer, rendered by fail().
func (h *cnvHandlers) changeScope(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")

	var body cnvScopeBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	repositoryID := ""
	if body.RepositoryID != nil {
		repositoryID = *body.RepositoryID
		if !validUUID(repositoryID) {
			cnvInvalid(w, "invalid_repository_id: repository_id must be a uuid or null.")
			return
		}
	}

	chat, err := h.store.ChangeScope(r.Context(), c, conversationID, repositoryID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.scope", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, chat)
}

func (h *cnvHandlers) decidePermission(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	conversationID := r.PathValue("conversationId")
	requestID := r.PathValue("requestId")

	var body cnvPermissionBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if strings.TrimSpace(body.OptionID) == "" {
		cnvInvalid(w, "option_id is required.")
		return
	}
	if utf8.RuneCountInString(body.OptionID) > cnvMaxOptionLen {
		cnvInvalid(w, fmt.Sprintf("option_id must be at most %d characters.", cnvMaxOptionLen))
		return
	}
	if !validUUID(requestID) {
		h.denied(w, r, c, cnvAtConversation("conversation.permission", conversationID), "malformed permission id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such permission request.")
		return
	}

	permission, err := h.store.DecidePermission(r.Context(), c, conversationID, requestID, body.OptionID)
	if err != nil {
		h.fail(w, r, c, cnvAtConversation("conversation.permission", conversationID), err)
		return
	}
	WriteJSON(w, http.StatusOK, permission)
}

// --- shared plumbing ----------------------------------------------------

func (h *cnvHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, cnvTarget{action: "no action"}, errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// fail maps a conversation store error onto the HTTP contract. Order matters:
// a conflict is checked first because it is the widest case, and a non-member
// answer always writes the audit row before the 404 goes out (ADR-0014 §3).
func (h *cnvHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, target cnvTarget, err error) {
	var conflict *ConversationConflict
	if errors.As(err, &conflict) {
		h.denied(w, r, c, target, conflict.Kind)
		cnvWriteConflict(w, conflict)
		return
	}
	switch {
	case errors.Is(err, ErrConversationRepositoryNotFound):
		h.denied(w, r, c, target, "no such repository in this project")
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"No such repository in this project.")
	case errors.Is(err, ErrConversationNotFound):
		h.denied(w, r, c, target, "no such conversation, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such conversation.")
	case errors.Is(err, ErrConversationForbidden):
		h.denied(w, r, c, target, "the caller may not make this conversation change")
		// The stored sentence names the reason the caller is denied (a viewer
		// role, or a non-controller on the ADR-0068 switch route). When the
		// store wrapped the sentinel with one, forward it; the bare sentinel
		// keeps the role sentence the surface has always answered with.
		detail := "Your project role is read-only; a contributor is required to change a conversation."
		if wrapped := cnvSentinelDetail(err, ErrConversationForbidden); wrapped != "" {
			detail = wrapped
		}
		WriteProblem(w, http.StatusForbidden, "Forbidden", detail)
	case errors.Is(err, ErrConversationBadRequest):
		// ADR-0068: the switch route's "not one of this project's agent
		// profiles" (and any malformed id the store still saw) answers 400
		// naming the field, the same forwarding the 422 does.
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"invalid_agent_profile: "+cnvSentinelDetail(err, ErrConversationBadRequest))
	case errors.Is(err, ErrConversationValidation):
		cnvInvalid(w, cnvValidationDetail(err))
	default:
		h.serverError(w, r, target, err)
	}
}

// cnvSentinelDetail turns a wrapped sentinel error into the detail text
// written beside it ("only the controller may switch…", "agent_profile_id is
// not one of this project's agent profiles"). The store names the offending
// value or holder and that naming is the point, so the text after the
// sentinel is forwarded; a bare sentinel answers "" and the caller picks its
// own generic line.
func cnvSentinelDetail(err, sentinel error) string {
	text := err.Error()
	prefix := sentinel.Error()
	if i := strings.Index(text, prefix); i >= 0 {
		text = text[i+len(prefix):]
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), ":"))
}

// cnvValidationDetail turns a wrapped ErrConversationValidation into the 422
// detail the client needs. The store names the offending value (which option an
// agent never offered, which profile is not in the organization) and that
// naming is the whole point of a 422, so the text after the sentinel is
// forwarded; anything else is replaced by a generic line rather than echoed.
func cnvValidationDetail(err error) string {
	text := err.Error()
	prefix := ErrConversationValidation.Error()
	if i := strings.Index(text, prefix); i >= 0 {
		text = text[i+len(prefix):]
	}
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), ":"))
	text = strings.TrimSpace(text)
	if text == "" {
		return "The request is not valid for this conversation."
	}
	return text
}

// cnvConflictTypes maps a conflict kind onto the stable problem type and title
// api/openapi.yaml ConversationConflict documents.
var cnvConflictTypes = map[string](struct{ typ, title string }){
	ConflictControlVersionStale:  {"https://communication.dev/errors/control-version-stale", "Control Version Stale"},
	ConflictNotController:        {"https://communication.dev/errors/not-controller", "Not the Controller"},
	ConflictTurnInProgress:       {"https://communication.dev/errors/turn-in-progress", "Turn In Progress"},
	ConflictNoActiveTurn:         {"https://communication.dev/errors/no-active-turn", "No Active Turn"},
	ConflictPermissionNotPending: {"https://communication.dev/errors/permission-not-pending", "Permission Not Pending"},
	ConflictArchived:             {"https://communication.dev/errors/conversation-archived", "Conversation Archived"},
}

// cnvWriteConflict writes the ConversationConflictProblem schema: a Problem plus
// the current control row (and the blocking turn when there is one). The UI is
// required to adopt the returned control rather than retry blindly, which is
// only possible if the answer carries it (ADR-0016 §9 obligation 3).
func cnvWriteConflict(w http.ResponseWriter, conflict *ConversationConflict) {
	typ, title := "https://communication.dev/errors/conversation-conflict", "Conversation Conflict"
	if t, ok := cnvConflictTypes[conflict.Kind]; ok {
		typ, title = t.typ, t.title
	}
	status := http.StatusConflict
	detail := conflict.Detail
	if detail == "" {
		detail = "The request conflicts with the conversation's current state."
	}
	control := conflict.Control
	if control == nil {
		control = &ConversationControlView{Kind: events.ControllerKindNone, Version: 0}
	}
	body := struct {
		Type           string                   `json:"type"`
		Title          string                   `json:"title"`
		Status         int                      `json:"status"`
		Detail         string                   `json:"detail,omitempty"`
		ConversationID string                   `json:"conversation_id"`
		Control        *ConversationControlView `json:"control"`
		ActiveTurn     *ConversationTurnView    `json:"active_turn,omitempty"`
	}{typ, title, status, detail, conflict.ConversationID, control, conflict.ActiveTurn}

	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// denied records a refused attempt. A failure to record it is logged but never
// changes the answer: the request is denied either way.
func (h *cnvHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, target cnvTarget, reason string) {
	var err error
	switch {
	case target.conversationID != "":
		err = h.store.RecordDenied(r.Context(), c, target.conversationID, target.action)
	case target.projectID != "":
		err = h.store.RecordProjectDenied(r.Context(), c, target.projectID, target.action)
	}
	if err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", target.action),
			slog.String("conversation_id", target.conversationID),
			slog.String("project_id", target.projectID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "conversation access denied",
		slog.String("action", target.action),
		slog.String("user_id", c.UserID),
		slog.String("conversation_id", target.conversationID),
		slog.String("project_id", target.projectID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *cnvHandlers) serverError(w http.ResponseWriter, r *http.Request, target cnvTarget, err error) {
	h.log(r).ErrorContext(r.Context(), "conversation store failure",
		slog.String("action", target.action),
		slog.String("conversation_id", target.conversationID),
		slog.String("project_id", target.projectID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *cnvHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
	h.log(r).WarnContext(r.Context(), "rejected request body",
		slog.String("path", r.URL.Path),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
}

func (h *cnvHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// cnvInvalid writes the 422 problem+json every validation failure shares.
func cnvInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// validUUID reports whether s is a canonical 8-4-4-4-12 uuid. Path and body ids
// are validated before they reach a store so a malformed id answers 404/422
// rather than a driver syntax error.
func validUUID(s string) bool {
	const hexDigits = "0123456789abcdefABCDEF"
	want := []int{8, 4, 4, 4, 12}
	if len(s) != 36 {
		return false
	}
	i := 0
	for part, n := range want {
		if part > 0 {
			if s[i] != '-' {
				return false
			}
			i++
		}
		if i+n > len(s) {
			return false
		}
		for j := i; j < i+n; j++ {
			if !strings.ContainsRune(hexDigits, rune(s[j])) {
				return false
			}
		}
		i += n
	}
	return i == len(s)
}

// cnvNullString renders "" as a JSON null, which is how the schema's
// `type: ["string","null"]` members are expressed by a Go string.
func cnvNullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// cnvNullTime renders a nil *time.Time as null (encoding/json already does that)
// but normalises the zone so a response never claims a local offset.
func cnvNullTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}
