package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
)

// The M2 conversation surface: agent profiles, conversations, the single
// controller lock, turns, session bindings and permission prompts
// (ADR-0016, communication-spec/01-domain-model.md,
// 06-collaboration-identity.md "Shared conversation model").
//
// Every type here carries the `Cnv` prefix, and every unexported identifier
// `cnv`, because a second worker writes worker-side store files in this same
// package concurrently: a name clash would be a compile error in code neither
// brief owns.

// Conversation store errors. The HTTP layer maps them onto 404/403/422;
// CnvConflict is its own error type because a 409 must carry state, not just a
// sentence (ADR-0016 §8).
var (
	// ErrConversationNotFound is also the answer to "you may not know this
	// conversation exists" — ADR-0014 §3 and ADR-0016 §8 make a non-member see
	// 404, never 403.
	ErrConversationNotFound = errors.New("postgres: conversation not found")
	// ErrConversationForbidden means the caller may see the conversation but
	// may not write to it (a viewer): 403, and only 403, because role is not
	// existence information.
	ErrConversationForbidden = errors.New("postgres: conversation write not allowed for this role")
	// ErrConversationValidation is a well-formed request the schema would
	// reject (an unknown agent profile, an option the agent never offered): 422.
	ErrConversationValidation = errors.New("postgres: conversation request failed validation")
)

// Conflict kinds (ADR-0016 §2/§5, api/openapi.yaml ConversationConflict). The
// API renders each as its own stable problem type.
const (
	ConflictControlVersionStale  = "control_version_stale"
	ConflictNotController        = "not_controller"
	ConflictTurnInProgress       = "turn_in_progress"
	ConflictNoActiveTurn         = "no_active_turn"
	ConflictPermissionNotPending = "permission_not_pending"
	// ConflictArchived is not in api/openapi.yaml's enumerated conversation
	// problem types: no M2 route archives a conversation, so it is unreachable
	// today. It exists because accepting a prompt into an archived conversation
	// would enqueue work no claim will ever take (the claim filter excludes
	// archived conversations), which is a silent dead end rather than an answer.
	ConflictArchived = "conversation_archived"
)

// CnvConflict is a refused mutation carrying the state that refused it, so the
// loser of a control race learns who won instead of retrying blindly
// (communication-spec/06 edge cases).
type CnvConflict struct {
	Kind           string
	Detail         string
	ConversationID string
	Control        *CnvControl
	ActiveTurn     *CnvTurn
}

func (c *CnvConflict) Error() string {
	if c == nil {
		return "postgres: conversation conflict"
	}
	if c.Detail != "" {
		return fmt.Sprintf("postgres: conversation conflict (%s): %s", c.Kind, c.Detail)
	}
	return fmt.Sprintf("postgres: conversation conflict: %s", c.Kind)
}

// CnvProfile is an agent_profiles row: a launch descriptor, never a capability
// claim (docs/compatibility/ACP.md is the only place capability evidence lives).
type CnvProfile struct {
	ID             string
	OrganizationID string
	Name           string
	LauncherID     string
	PermissionMode string
	CreatedAt      time.Time
	// Version is the profile's CURRENT version (migration 00014, ADR-0058): the
	// optimistic-concurrency token the row carries and that writes must echo, and
	// the latest entry of the version history.
	Version int
	// The APM triple (ADR-0030). "" means the column is NULL, i.e. this profile
	// stages no packaged context — the honest state, not a missing read. A ref
	// with no digest is refused at the write path and again by the worker
	// (workspaces.go's unverifiable-pin rule), so it cannot reach a reader.
	APMPackageRef string
	APMTarget     string
	APMLockDigest string
	// APMLockContents is the names-only lock summary from apm_contents_summary
	// (migration 00013), read back as JSON text; nil while the profile has no
	// resolved lock — the honest "not locked" state, not an empty list.
	APMLockContents *apmLockContentsJSON
}

// CnvControl is the one-row-per-conversation controller lock. UserID is "" for
// kind 'none' — the DB CHECK makes any other shape impossible, and this type
// keeps that agreement rather than re-deriving it.
type CnvControl struct {
	ConversationID string
	Kind           string
	UserID         string
	DisplayName    string
	PreviousUserID string
	// RunAttemptID is populated only when Kind is 'run_attempt': the attempt
	// that holds the conversation as controller (§ 4 step 6). A human taking it
	// is ADR-0016 § 5's takeover, which is why the kind alone is not enough.
	RunAttemptID string
	Version      int
}

// CnvTurn is one prompt plus the agent's whole answer for it. Empty optional
// strings mean NULL in the row (no worker yet, no stop reason yet).
type CnvTurn struct {
	ID                     string
	ConversationID         string
	Status                 string
	Prompt                 string
	SubmittedBy            string
	SubmittedByDisplayName string
	// SubmittedVia is the turn's origin (00017, ADR-0062): human | schedule |
	// issue_trigger | child_run. submitted_by names the human it runs ON
	// BEHALF OF; this says what actually submitted it.
	SubmittedVia      string
	WorkerID          string
	CancelRequestedAt *time.Time
	StopReason        *string
	CreatedAt         time.Time
	StartedAt         *time.Time
	FinishedAt        *time.Time
}

// IsActive reports whether the turn still occupies the conversation
// (conversation_turns_one_active_idx covers exactly these three statuses).
func (t *CnvTurn) IsActive() bool {
	switch t.Status {
	case events.TurnStatusQueued, events.TurnStatusLeased, events.TurnStatusRunning:
		return true
	default:
		return false
	}
}

// CnvBinding is the live agent instance attached to a conversation
// (acp_session_bindings collapsed into one row per launched session, ADR-0016
// §1). AgentCapabilities is the agent's own reported object, verbatim.
type CnvBinding struct {
	ID                string
	ConversationID    string
	WorkerID          string
	WorkerName        string
	LauncherID        string
	LauncherVersion   string
	ACPSessionID      string
	ProtocolVersion   int
	SessionOrigin     string
	AgentCapabilities json.RawMessage
	ConnectedAt       time.Time
	LastSeenAt        time.Time
}

// CnvPermission is a durable ACP prompt awaiting (or carrying) the
// controller's answer.
type CnvPermission struct {
	ID             string
	ConversationID string
	TurnID         string
	Status         string
	ToolTitle      string
	ToolKind       string
	ToolCallID     string
	Options        []events.PermissionOption
	DecidedBy      string
	// DecidedByKind is user | policy (ADR-0039 Option A); user for every row
	// written before the migration (the column defaults to 'user').
	DecidedByKind string
	// DecidedByPolicy names the deciding permission mode (deny,
	// preapproved_within_sandbox); "" unless DecidedByKind is policy.
	DecidedByPolicy  string
	DecisionOptionID string
	RequestedAt      time.Time
	DeadlineAt       *time.Time
	DecidedAt        *time.Time
}

// CnvRunLink is the run node a run-linked conversation was opened for: the
// newest attempt that references the conversation (ADR-0043). NodeID is the
// definition node id node_executions.node_id carries. RunTitle is nil today:
// runs has no title column, and the field exists so the column can be filled
// without another additive schema change.
type CnvRunLink struct {
	RunID           string
	RunTitle        *string
	NodeExecutionID string
	NodeInstanceKey string
	NodeID          *string
	AttemptID       string
	AttemptNumber   int
}

// CnvLinkedRun (ADR-0053) is one run this conversation was handed to:
// runs.source_conversation_id, the forward link complementing run_link's
// reverse direction (a run-linked conversation's RunLink says which run
// opened it; LinkedRuns says which runs a manual thread started). CreatedAt
// is the run's creation — the handoff moment.
type CnvLinkedRun struct {
	RunID     string
	CreatedAt time.Time
}

// CnvConversation is a conversation with its control row, live binding, active
// turn and pending prompts. MyRole is the *caller's* project role, kept so the
// store can be the second authorization gate rather than the only one.
type CnvConversation struct {
	ID                 string
	ProjectID          string
	OrganizationID     string
	MyRole             string
	AgentProfileID     string
	AgentProfileName   string
	LauncherID         string
	Title              string
	Status             string
	CreatedBy          string
	CreatedByDisplay   string
	CreatedAt          time.Time
	UpdatedAt          time.Time
	Control            CnvControl
	ActiveTurn         *CnvTurn
	Binding            *CnvBinding
	PendingPermissions []CnvPermission
	// AgentProfileVersion is the profile version this conversation was created
	// against (ADR-0058, migration 00014): the optimistic-concurrency token the
	// conversation pins its runs to, resolved off the profile's current version
	// at creation. A conversation never re-resolves it; a run sourced from it
	// inherits this pin, and the worker reads the versioned snapshot through it.
	AgentProfileVersion int
	// Origin is "manual" or "run": run iff an attempt references the
	// conversation; RunLink names that attempt's node for deep-linking.
	Origin  string
	RunLink *CnvRunLink
	// LinkedRuns (ADR-0053): the runs this conversation started
	// (runs.source_conversation_id), creation order; nil = none.
	LinkedRuns []CnvLinkedRun
}

// CnvSummary is a list row: enough for a project timeline (who is driving, is
// anyone prompting) and nothing that needs a join the list cannot afford.
type CnvSummary struct {
	ID               string
	ProjectID        string
	AgentProfileID   string
	Title            string
	Status           string
	CreatedBy        string
	CreatedByDisplay string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	Control          CnvControl
	HasActiveTurn    bool
	AgentConnected   bool
	// Origin and RunLink as on CnvConversation (ADR-0043): a list row must say
	// whether it is manual or run-linked without the detail route's joins.
	Origin  string
	RunLink *CnvRunLink
	// RepositoryID/RepositoryName (ADR-0065, run-thread arm): the thread's
	// repository — the first repository bound to its newest live-or-released
	// workspace, else (a thread with no binding of its own) the repository of
	// the run it is linked to. Both empty when neither says one.
	RepositoryID   string
	RepositoryName string
	// LastAgentLine (ADR-0065): the newest agent message chunk rendered to a
	// single preview line (cnvLastAgentLine); empty when the agent has not
	// spoken.
	LastAgentLine string
}

// cnvLastAgentLineMax is the wire cap on a list row's last-line preview, in
// runes, ellipsis included (api/openapi.yaml ConversationSummary.last_agent_line
// maxLength: 160; ADR-0065).
const cnvLastAgentLineMax = 160

// cnvAgentLineKeys are the keys an agent writes its headline under — the one
// sentence of a review, the aim of a plan — in priority order. The search is
// depth-0 (the object's own members) before depth-1 (one nested object, the
// shape of a schema that wraps its answer: `{"plan": {"goal": …}}`), and each
// depth is walked in this key order, so `plan.goal` beats an earlier `title`
// and a top-level `notes` beats a nested `summary` (ADR-0065).
var cnvAgentLineKeys = []string{"summary", "goal", "title", "notes", "reason", "message"}

// cnvAgentLineMaxDepth bounds the breadth-first hunt for "the first string
// anywhere": the answer may sit a container or two down, but a string three
// containers deep is a schema's field, not the line the agent wrote for a
// human, and the raw text is the honest answer (ADR-0065).
const cnvAgentLineMaxDepth = 3

// cnvAgentLineMaxNodes bounds one traversal of one chunk: the walk is a queue,
// and the cap keeps a pathological payload from being paid for on every list
// row. Running out of budget can only answer "no line found", which falls back
// to the raw text — it never invents one.
const cnvAgentLineMaxNodes = 512

// cnvJSONField is one member of a JSON object in the object's own document
// order: the pick below is order-sensitive, and decoding into a map would
// shuffle it.
type cnvJSONField struct {
	key   string
	value json.RawMessage
}

// cnvUnfenceAgentChunk trims a chunk and removes a surrounding ```json / ```
// fence, the shape an agent wraps its structured output in when the model
// talks in markdown. It strips only a fence that *surrounds* the message: a
// ```lang fence, an unclosed fence, or prose after the closing fence is left
// exactly as it arrived, so nothing past the wrapper is invented.
func cnvUnfenceAgentChunk(chunk string) string {
	text := strings.TrimSpace(chunk)
	if !strings.HasPrefix(text, "```") {
		return text
	}
	rest := text[3:]
	newline := strings.IndexByte(rest, '\n')
	if newline < 0 {
		return text // one-line fence: not the wrapper this handles
	}
	if tag := strings.ToLower(strings.TrimSpace(rest[:newline])); tag != "" && tag != "json" && tag != "jsonc" {
		return text // ```go, ```yaml: the body is not an object
	}
	body := strings.TrimSpace(rest[newline+1:])
	if !strings.HasSuffix(body, "```") {
		return text
	}
	return strings.TrimSpace(strings.TrimSuffix(body, "```"))
}

// cnvJSONFields decodes text as EXACTLY one JSON object and returns its members
// in document order. It answers false for anything that is not one object:
// prose, an array, a chunk the worker split mid-object, invalid JSON, `}{`, or
// an object with trailing prose — for all of those the caller renders the raw
// text as it always did.
func cnvJSONFields(text string) ([]cnvJSONField, bool) {
	dec := json.NewDecoder(strings.NewReader(text))
	open, err := dec.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := open.(json.Delim); !ok || delim != '{' {
		return nil, false
	}
	return cnvDecodeObject(dec)
}

func cnvDecodeObject(dec *json.Decoder) ([]cnvJSONField, bool) {
	var out []cnvJSONField
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		out = append(out, cnvJSONField{key: key, value: value})
	}
	if _, err := dec.Token(); err != nil { // consume the closing '}'
		return nil, false
	}
	if dec.More() {
		return nil, false // `}{` or `… } trailing prose`: not one structured output
	}
	return out, true
}

// cnvJSONKind is a raw value's shape from its first non-space byte: 'o' object,
// 'a' array, 's' string, 'b' bool, 'z' null, 'n' number, 0 when empty.
func cnvJSONKind(raw json.RawMessage) byte {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\n', '\r':
			continue
		case '{':
			return 'o'
		case '[':
			return 'a'
		case '"':
			return 's'
		case 't', 'f':
			return 'b'
		case 'n':
			return 'z'
		default:
			return 'n'
		}
	}
	return 0
}

// cnvAgentLineString returns a raw value's text when it is a string with
// something in it; blank and whitespace-only strings are not a line.
func cnvAgentLineString(raw json.RawMessage) (string, bool) {
	if cnvJSONKind(raw) != 's' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || strings.TrimSpace(s) == "" {
		return "", false
	}
	return s, true
}

// cnvAgentLineKey finds one priority key's text at `depth` container levels
// below the root (0 = this object, 1 = a nested object), in document order.
func cnvAgentLineKey(fields []cnvJSONField, depth int, key string) (string, bool) {
	for _, f := range fields {
		if depth == 0 {
			if f.key == key {
				if s, ok := cnvAgentLineString(f.value); ok {
					return s, true
				}
			}
			continue
		}
		if nested, ok := cnvJSONFields(string(f.value)); ok {
			if s, ok := cnvAgentLineKey(nested, 0, key); ok {
				return s, true
			}
		}
	}
	return "", false
}

// cnvAgentLineFirstString walks the object breadth-first in document order and
// returns the first non-blank string, descending at most maxDepth container
// levels (maxDepth <= 0 = every level, used only to ask "is there any string at
// all?"). Arrays are walked too — an agent's `outputs: ["…"]` is its own prose.
func cnvAgentLineFirstString(fields []cnvJSONField, maxDepth int) (string, bool) {
	type node struct {
		value json.RawMessage
		depth int
	}
	queue := make([]node, 0, len(fields))
	for _, f := range fields {
		queue = append(queue, node{value: f.value, depth: 1})
	}
	for i := 0; i < len(queue) && i < cnvAgentLineMaxNodes; i++ {
		cur := queue[i]
		if s, ok := cnvAgentLineString(cur.value); ok {
			return s, true
		}
		if maxDepth > 0 && cur.depth >= maxDepth {
			continue
		}
		switch cnvJSONKind(cur.value) {
		case 'o':
			nested, ok := cnvJSONFields(string(cur.value))
			if !ok {
				continue
			}
			for _, f := range nested {
				queue = append(queue, node{value: f.value, depth: cur.depth + 1})
			}
		case 'a':
			var items []json.RawMessage
			if err := json.Unmarshal(cur.value, &items); err != nil {
				continue
			}
			for _, item := range items {
				queue = append(queue, node{value: item, depth: cur.depth + 1})
			}
		}
	}
	return "", false
}

// cnvAgentLineScalars renders the top-level scalars of an object with no string
// anywhere — a reviewer's verdict is `approved`, not a sentence — as
// `key: value` pairs joined by ` · `, in document order.
func cnvAgentLineScalars(fields []cnvJSONField) string {
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		switch cnvJSONKind(f.value) {
		case 'b', 'z', 'n':
			parts = append(parts, f.key+": "+strings.TrimSpace(string(f.value)))
		}
	}
	return strings.Join(parts, " · ")
}

// cnvStructuredAgentText returns the words an agent actually chose when one
// transcript chunk is (or is fenced as) a JSON object — the shape a run node
// ends on, because the agent's last message IS its structured output
// (`{"summary": "…", …}`, `{"approved": true, …}`, `{"plan": {"goal": …}}`).
// The answer is, in order:
//
//  1. the first non-blank text under a cnvAgentLineKeys key at depth 0, then at
//     depth 1 (nested objects), each depth in key-priority order;
//  2. else the first string value breadth-first, document order, at most
//     cnvAgentLineMaxDepth containers deep;
//  3. else, when the object holds no string at any depth, its top-level scalars
//     as `key: value · key: value` — `approved: true`, not `{"approved": true,`.
//
// It returns "" — "no better line than the raw text" — when the chunk is not
// one JSON object at all (prose, an unclosed or non-JSON fence, a truncated
// multi-chunk tail, invalid JSON that merely starts with `{`, an array, an
// object whose only strings are too deep to be a headline). The caller then
// renders the raw text as it always did, so a message that merely happens to
// contain a brace is untouched and nothing is invented. The whole message is
// parsed before the first line is taken, so a pretty-printed object is read as
// an object rather than as its opening brace.
func cnvStructuredAgentText(chunk string) string {
	text := cnvUnfenceAgentChunk(chunk)
	// Cheap gate first: only a brace-wrapped body can be an object, and this
	// keeps ordinary prose out of the decoder entirely.
	if !strings.HasPrefix(text, "{") || !strings.HasSuffix(text, "}") {
		return ""
	}
	fields, ok := cnvJSONFields(text)
	if !ok {
		return ""
	}
	for depth := 0; depth <= 1; depth++ {
		for _, key := range cnvAgentLineKeys {
			if s, ok := cnvAgentLineKey(fields, depth, key); ok {
				return s
			}
		}
	}
	if s, ok := cnvAgentLineFirstString(fields, cnvAgentLineMaxDepth); ok {
		return s
	}
	if _, ok := cnvAgentLineFirstString(fields, -1); !ok {
		return cnvAgentLineScalars(fields)
	}
	return ""
}

// cnvLastAgentLine renders one agent transcript chunk as the list row's
// preview: the first non-empty line, trimmed, cut to cnvLastAgentLineMax runes
// with a trailing ellipsis when longer. A chunk that is one JSON object, or one
// such object inside a ```json fence (a run node ending on its structured
// output), is read through cnvStructuredAgentText FIRST — the whole message is
// parsed before a line is taken — so the row shows the agent's summary, its
// nested `plan.goal`, or its `approved: true` verdict instead of
// `{"summary": "…` / `{"approved": true,`. "" (rendered as JSON null by apiNullString) means no
// line: no chunk at all, or only whitespace.
func cnvLastAgentLine(chunk string) string {
	if structured := cnvStructuredAgentText(chunk); structured != "" {
		chunk = structured
	}
	for _, raw := range strings.Split(chunk, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		// Rune-safe cut; the ellipsis counts toward the cap, so a truncated
		// preview is exactly cnvLastAgentLineMax runes.
		if utf8.RuneCountInString(line) > cnvLastAgentLineMax {
			return string([]rune(line)[:cnvLastAgentLineMax-1]) + "…"
		}
		return line
	}
	return ""
}

// CnvStore is the conversation face of the store. Like ProjectStore it is
// stateless — any replica may run it against the same pool.
type CnvStore struct {
	Pool *pgxpool.Pool
}

// --- reads --------------------------------------------------------------

// ListAgentProfiles returns the caller's organization's profiles by name.
// Profiles are organization-scoped (ADR-0016 §1), so no project membership is
// involved; a listing is available to any signed-in user of that organization.
func (s *CnvStore) ListAgentProfiles(ctx context.Context, c Caller) ([]CnvProfile, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+cnvProfileColumns+`, apm_contents_summary
		FROM agent_profiles
		WHERE organization_id = $1::uuid
		ORDER BY name, id`, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list agent profiles: %w", err)
	}
	defer rows.Close()

	out := make([]CnvProfile, 0, 2)
	for rows.Next() {
		var p CnvProfile
		var contents *string
		if err := rows.Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
			&p.PermissionMode, &p.CreatedAt, &p.Version,
			&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest, &contents); err != nil {
			return nil, fmt.Errorf("postgres: scan agent profile: %w", err)
		}
		p.CreatedAt = p.CreatedAt.UTC()
		p.APMLockContents = nil
		if contents != nil {
			var lock apmLockContentsJSON
			if uerr := json.Unmarshal([]byte(*contents), &lock); uerr != nil {
				return nil, fmt.Errorf("postgres: decode apm lock contents: %w", uerr)
			}
			p.APMLockContents = &lock
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read agent profiles: %w", err)
	}
	return out, nil
}

// cnvConversationScopeSQL resolves a conversation *through* its project: the
// caller must hold a membership in that project or be an organization admin,
// which is what makes conversation existence project-scoped information
// (ADR-0016 §8). $1 caller user, $2 caller organization, $3 org admin.
const cnvConversationScopeSQL = `
	SELECT c.id::text, c.project_id::text, p.organization_id::text,
	       COALESCE(m.role, 'maintainer')
	FROM conversations c
	JOIN projects p ON p.id = c.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE c.id = $4::uuid
	  AND p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// AuthorizeConversation answers the only question the SSE loop needs on every
// delivery and heartbeat: may this caller still see this conversation's
// project? It is deliberately a single indexed read — a per-heartbeat
// GetConversation would join four tables to learn one bit.
func (s *CnvStore) AuthorizeConversation(ctx context.Context, c Caller, conversationID string) (projectID string, err error) {
	if err := prjRequireCaller(c); err != nil {
		return "", err
	}
	projectID, _, _, err = cnvResolveProject(ctx, s.Pool, c, conversationID)
	return projectID, err
}

// cnvResolveProject resolves the conversation's project, organization and the
// caller's role in it, through the membership join.
func cnvResolveProject(ctx context.Context, q prjQuerier, c Caller, conversationID string) (projectID, orgID, role string, err error) {
	if !prjValidUUID(conversationID) {
		return "", "", "", ErrConversationNotFound
	}
	err = q.QueryRow(ctx, cnvConversationScopeSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin, conversationID).
		Scan(new(string), &projectID, &orgID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrConversationNotFound
	}
	if err != nil {
		return "", "", "", fmt.Errorf("postgres: resolve conversation project: %w", err)
	}
	return projectID, orgID, role, nil
}

// cnvConversationSelect reads a conversation with its profile, controller and
// creator name in one statement. The JOIN on conversation_control is inner on
// purpose: createConversation writes both rows in one transaction, so a
// conversation without a controller row is a bug, and reading it as absent
// surfaces that bug instead of hiding it (ADR-0016 §1).
const cnvConversationSelect = `
	SELECT c.id::text, c.project_id::text, p.organization_id::text,
	       COALESCE(m.role, 'maintainer'),
	       c.agent_profile_id::text, ap.name, ap.launcher_id,
	       c.title, c.status, c.created_by::text, COALESCE(cb.display_name, ''),
	       c.created_at, c.updated_at,
	       ctl.controller_kind, COALESCE(ctl.controller_user_id::text, ''),
	       COALESCE(ctr.display_name, ''), COALESCE(ctl.previous_controller_user_id::text, ''),
	       ctl.version
	FROM conversations c
	JOIN projects p ON p.id = c.project_id
	JOIN agent_profiles ap ON ap.id = c.agent_profile_id
	JOIN conversation_control ctl ON ctl.conversation_id = c.id
	LEFT JOIN users cb ON cb.id = c.created_by
	LEFT JOIN users ctr ON ctr.id = ctl.controller_user_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE c.id = $2::uuid
	  AND p.organization_id = $3::uuid
	  AND ($4::boolean OR m.user_id IS NOT NULL)`

// cnvScanConversation reads one row of cnvConversationSelect.
func cnvScanConversation(row interface{ Scan(dest ...any) error }) (CnvConversation, error) {
	var cv CnvConversation
	err := row.Scan(&cv.ID, &cv.ProjectID, &cv.OrganizationID, &cv.MyRole,
		&cv.AgentProfileID, &cv.AgentProfileName, &cv.LauncherID,
		&cv.Title, &cv.Status, &cv.CreatedBy, &cv.CreatedByDisplay,
		&cv.CreatedAt, &cv.UpdatedAt,
		&cv.Control.Kind, &cv.Control.UserID, &cv.Control.DisplayName,
		&cv.Control.PreviousUserID, &cv.Control.Version)
	if err != nil {
		return CnvConversation{}, err
	}
	cv.Control.ConversationID = cv.ID
	cv.CreatedAt = cv.CreatedAt.UTC()
	cv.UpdatedAt = cv.UpdatedAt.UTC()
	return cv, nil
}

// GetConversation reads one conversation with its controller, live binding,
// active turn and pending prompts. A conversation the caller may not see is
// ErrConversationNotFound — the same answer as one that does not exist.
func (s *CnvStore) GetConversation(ctx context.Context, c Caller, conversationID string) (CnvConversation, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvConversation{}, err
	}
	return cnvGetConversation(ctx, s.Pool, c, conversationID)
}

func cnvGetConversation(ctx context.Context, q prjQuerier, c Caller, conversationID string) (CnvConversation, error) {
	cv, err := cnvScanConversation(q.QueryRow(ctx, cnvConversationSelect,
		c.UserID, conversationID, c.OrganizationID, c.IsOrgAdmin))
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvConversation{}, ErrConversationNotFound
	}
	if err != nil {
		return CnvConversation{}, fmt.Errorf("postgres: get conversation: %w", err)
	}
	turn, err := cnvActiveTurn(ctx, q, cv.ID)
	if err != nil {
		return CnvConversation{}, err
	}
	cv.ActiveTurn = turn
	binding, err := cnvLiveBinding(ctx, q, cv.ID)
	if err != nil {
		return CnvConversation{}, err
	}
	cv.Binding = binding
	pending, err := cnvPendingPermissions(ctx, q, cv.ID)
	if err != nil {
		return CnvConversation{}, err
	}
	cv.PendingPermissions = pending
	cv.Origin, cv.RunLink, err = cnvConversationRunLink(ctx, q, cv.ID)
	if err != nil {
		return CnvConversation{}, err
	}
	linked, err := cnvLinkedRuns(ctx, q, cv.ID)
	if err != nil {
		return CnvConversation{}, err
	}
	cv.LinkedRuns = linked
	return cv, nil
}

// cnvLinkedRuns (ADR-0053) reads the forward handoff links: the runs this
// conversation started, creation order. The visibility predicate already ran
// on the conversation row itself (cnvConversationSelect), so every run named
// here is one the caller may also see — the link cannot out-see its thread.
func cnvLinkedRuns(ctx context.Context, q prjQuerier, conversationID string) ([]CnvLinkedRun, error) {
	rows, err := q.Query(ctx, `
		SELECT id::text, created_at FROM runs
		WHERE source_conversation_id = $1::uuid
		ORDER BY created_at, id`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: conversation linked runs: %w", err)
	}
	defer rows.Close()
	out := []CnvLinkedRun{}
	for rows.Next() {
		var l CnvLinkedRun
		if err := rows.Scan(&l.RunID, &l.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan conversation linked run: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// cnvRunLinkByConversationSQL is the single-conversation read of the list's
// LATERAL run link: the newest attempt that references the conversation
// (ADR-0043), with the node it executed.
const cnvRunLinkByConversationSQL = `
	SELECT COALESCE(a.run_id::text, ''), COALESCE(a.id::text, ''), a.attempt_number,
	       COALESCE(ne.id::text, ''), COALESCE(ne.node_instance_key, ''), COALESCE(ne.node_id, '')
	FROM attempts a
	JOIN node_executions ne ON ne.id = a.node_execution_id
	WHERE a.conversation_id = $1::uuid
	ORDER BY a.created_at DESC, a.id DESC
	LIMIT 1`

// cnvConversationRunLink answers the origin question for one conversation:
// "manual" with a nil link when no attempt references it, "run" with the
// newest attempt's run/node otherwise.
func cnvConversationRunLink(ctx context.Context, q prjQuerier, conversationID string) (string, *CnvRunLink, error) {
	var runID, attemptID, nodeExecID, nodeKey, nodeID string
	var attemptNumber int
	err := q.QueryRow(ctx, cnvRunLinkByConversationSQL, conversationID).
		Scan(&runID, &attemptID, &attemptNumber, &nodeExecID, &nodeKey, &nodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "manual", nil, nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("postgres: conversation run link: %w", err)
	}
	var nodeIDPtr *string
	if nodeID != "" {
		nodeIDPtr = &nodeID
	}
	return "run", &CnvRunLink{
		RunID:           runID,
		NodeExecutionID: nodeExecID,
		NodeInstanceKey: nodeKey,
		NodeID:          nodeIDPtr,
		AttemptID:       attemptID,
		AttemptNumber:   attemptNumber,
	}, nil
}

// cnvActiveTurnSQL selects the conversation's non-terminal turn. The partial
// unique index guarantees at most one row, so LIMIT 1 is a statement about the
// index rather than a tolerance for two.
const cnvActiveTurnSQL = `
	SELECT t.id::text, t.conversation_id::text, t.status, t.prompt, t.submitted_by::text,
	       COALESCE(u.display_name, ''), COALESCE(t.worker_id::text, ''),
	       t.cancel_requested_at, t.stop_reason, t.created_at, t.started_at, t.finished_at,
	       t.submitted_via
	FROM conversation_turns t
	LEFT JOIN users u ON u.id = t.submitted_by
	WHERE t.conversation_id = $1::uuid
	  AND t.status IN ('queued', 'leased', 'running')
	ORDER BY t.created_at, t.id
	LIMIT 1`

func cnvScanTurn(row interface{ Scan(dest ...any) error }) (CnvTurn, error) {
	var t CnvTurn
	err := row.Scan(&t.ID, &t.ConversationID, &t.Status, &t.Prompt, &t.SubmittedBy,
		&t.SubmittedByDisplayName, &t.WorkerID,
		&t.CancelRequestedAt, &t.StopReason, &t.CreatedAt, &t.StartedAt, &t.FinishedAt,
		&t.SubmittedVia)
	if err != nil {
		return CnvTurn{}, err
	}
	t.CreatedAt = t.CreatedAt.UTC()
	for _, p := range []*time.Time{t.CancelRequestedAt, t.StartedAt, t.FinishedAt} {
		if p != nil {
			*p = p.UTC()
		}
	}
	return t, nil
}

// cnvActiveTurn returns the conversation's non-terminal turn, or nil.
func cnvActiveTurn(ctx context.Context, q prjQuerier, conversationID string) (*CnvTurn, error) {
	t, err := cnvScanTurn(q.QueryRow(ctx, cnvActiveTurnSQL, conversationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: active turn: %w", err)
	}
	return &t, nil
}

// cnvActiveTurnForUpdate locks the active turn row. Locking it before a
// takeover writes cancel_requested_at means a worker terminalising the turn
// concurrently cannot have its update (or the cancel) silently lost.
func cnvActiveTurnForUpdate(ctx context.Context, tx pgx.Tx, conversationID string) (*CnvTurn, error) {
	row := tx.QueryRow(ctx, `
		SELECT t.id::text, t.conversation_id::text, t.status, t.prompt, t.submitted_by::text,
		       COALESCE(u.display_name, ''), COALESCE(t.worker_id::text, ''),
		       t.cancel_requested_at, t.stop_reason, t.created_at, t.started_at, t.finished_at,
		       t.submitted_via
		FROM conversation_turns t
		LEFT JOIN users u ON u.id = t.submitted_by
		WHERE t.conversation_id = $1::uuid
		  AND t.status IN ('queued', 'leased', 'running')
		ORDER BY t.created_at, t.id
		LIMIT 1
		FOR UPDATE OF t`, conversationID)
	t, err := cnvScanTurn(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock active turn: %w", err)
	}
	return &t, nil
}

const cnvLiveBindingSQL = `
	SELECT b.id::text, b.conversation_id::text, b.worker_id::text, COALESCE(w.name, ''),
	       b.launcher_id, b.launcher_version, b.acp_session_id, b.protocol_version,
	       b.session_origin, b.agent_capabilities, b.connected_at, b.last_seen_at
	FROM acp_session_bindings b
	LEFT JOIN workers w ON w.id = b.worker_id
	WHERE b.conversation_id = $1::uuid
	  AND b.status = 'connected'
	LIMIT 1`

// cnvLiveBinding returns the conversation's connected agent instance, or nil.
func cnvLiveBinding(ctx context.Context, q prjQuerier, conversationID string) (*CnvBinding, error) {
	var b CnvBinding
	err := q.QueryRow(ctx, cnvLiveBindingSQL, conversationID).
		Scan(&b.ID, &b.ConversationID, &b.WorkerID, &b.WorkerName,
			&b.LauncherID, &b.LauncherVersion, &b.ACPSessionID, &b.ProtocolVersion,
			&b.SessionOrigin, &b.AgentCapabilities, &b.ConnectedAt, &b.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: live binding: %w", err)
	}
	if len(b.AgentCapabilities) == 0 {
		b.AgentCapabilities = json.RawMessage(`{}`)
	}
	b.ConnectedAt = b.ConnectedAt.UTC()
	b.LastSeenAt = b.LastSeenAt.UTC()
	return &b, nil
}

const cnvPendingPermissionsSQL = `
	SELECT id::text, conversation_id::text, turn_id::text, status, tool_title, tool_kind,
	       COALESCE(tool_call_id, ''), options, COALESCE(decided_by::text, ''),
	       decided_by_kind, COALESCE(decided_by_policy, ''),
	       COALESCE(decision_option_id, ''), requested_at, deadline_at, decided_at
	FROM permission_requests
	WHERE conversation_id = $1::uuid
	  AND status = 'pending'
	ORDER BY requested_at, id`

// cnvPendingPermissions lists the prompts awaiting an answer, oldest first.
func cnvPendingPermissions(ctx context.Context, q prjQuerier, conversationID string) ([]CnvPermission, error) {
	rows, err := q.Query(ctx, cnvPendingPermissionsSQL, conversationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: pending permissions: %w", err)
	}
	defer rows.Close()

	out := make([]CnvPermission, 0, 2)
	for rows.Next() {
		p, err := cnvScanPermission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read pending permissions: %w", err)
	}
	return out, nil
}

func cnvScanPermission(row interface{ Scan(dest ...any) error }) (CnvPermission, error) {
	var p CnvPermission
	var options []byte
	err := row.Scan(&p.ID, &p.ConversationID, &p.TurnID, &p.Status, &p.ToolTitle, &p.ToolKind,
		&p.ToolCallID, &options, &p.DecidedBy, &p.DecidedByKind, &p.DecidedByPolicy,
		&p.DecisionOptionID,
		&p.RequestedAt, &p.DeadlineAt, &p.DecidedAt)
	if err != nil {
		return CnvPermission{}, fmt.Errorf("postgres: scan permission request: %w", err)
	}
	p.Options, err = cnvParseOptions(options)
	if err != nil {
		return CnvPermission{}, err
	}
	p.RequestedAt = p.RequestedAt.UTC()
	for _, t := range []*time.Time{p.DeadlineAt, p.DecidedAt} {
		if t != nil {
			*t = t.UTC()
		}
	}
	return p, nil
}

// cnvParseOptions decodes the options jsonb the worker wrote. A row whose
// options are not the normalised array is a data bug, and saying so beats
// surfacing a prompt with no buttons to click (ADR-0016 §7).
func cnvParseOptions(raw []byte) ([]events.PermissionOption, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return []events.PermissionOption{}, nil
	}
	var out []events.PermissionOption
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("postgres: permission options %s is not an option array: %w", raw, err)
	}
	if out == nil {
		out = []events.PermissionOption{}
	}
	return out, nil
}

// cnvRunLinkSubquery selects the newest attempt that references a
// conversation (created_at DESC, id DESC as tie-break) with its node
// execution, for the origin/run_link columns (ADR-0043). The attempts row is
// the only proof a conversation is run-linked: the worker writes it when it
// opens the session (attempts_agent_turn_pair).
const cnvRunLinkSubquery = `
		LEFT JOIN LATERAL (
		    SELECT a.run_id, a.id AS attempt_id, a.attempt_number,
		           ne.id AS node_execution_id, ne.node_instance_key, ne.node_id
		    FROM attempts a
		    JOIN node_executions ne ON ne.id = a.node_execution_id
		    WHERE a.conversation_id = c.id
		    ORDER BY a.created_at DESC, a.id DESC
		    LIMIT 1
		) la ON true`

// cnvRepoSubquery selects the thread's repository for the list row
// (ADR-0065): the first repository (checkout-path order, the stable one)
// bound to the conversation's NEWEST workspace row. Every state except
// `lost` counts, exactly as in the run-from-thread head pinning
// (m4api_runs_write.go): a released workspace keeps its binding by design
// (ADR-0017 D1), a lost one's volume is gone. The lateral rides
// workspaces_conversation_idx (migration 00021), so one list
// row pays one index seek, never a scan of the table (ADR-0063).
const cnvRepoSubquery = `
		LEFT JOIN LATERAL (
		    SELECT r.id::text AS repository_id, r.name AS repository_name
		    FROM workspaces w
		    JOIN workspace_repos wr ON wr.workspace_id = w.id
		    JOIN repositories r ON r.id = wr.repository_id
		    WHERE w.conversation_id = c.id
		      AND w.scope_kind = 'conversation'
		      AND w.state IN ('preparing','ready','quarantined','released')
		    ORDER BY w.created_at DESC, w.id DESC, wr.checkout_path
		    LIMIT 1
		) repo ON true`

// cnvRunRepoSubquery is ADR-0065's run-thread arm: a thread a run node
// opened (origin=run) usually owns no conversation-scoped workspace at all —
// the WORK happened in the run's own workspace (ADR-0017) — so its binding is
// empty and the honest repository is the one the linked run works on
// (runs.repository_id, ADR-0060/0064). It rides the run-link lateral's
// `la.run_id`, so it pays the runs primary-key seek plus the repositories
// primary-key seek and nothing else (ADR-0063); a manual thread has no
// `la.run_id`, and for it the lateral is one empty seek.
const cnvRunRepoSubquery = `
		LEFT JOIN LATERAL (
		    SELECT r.id::text AS repository_id, r.name AS repository_name
		    FROM runs ru
		    JOIN repositories r ON r.id = ru.repository_id
		    WHERE ru.id = la.run_id
		    LIMIT 1
		) runrepo ON true`

// cnvLastAgentSubquery selects the newest agent-message chunk of the
// conversation's transcript (ADR-0065): the last `conversation.message.agent`
// journal row by global_seq, the order the transcript itself renders in. The
// chunk is bounded by the worker's MaxChunkBytes at write time; the preview
// line is cut further by cnvLastAgentLine. The lateral rides the partial
// index domain_events_conversation_agent_message_idx (migration 00021):
// a conversation whose agent never spoke is one empty index seek, not a
// backward walk over its whole event stream (ADR-0063).
const cnvLastAgentSubquery = `
		LEFT JOIN LATERAL (
		    SELECT e.payload ->> 'text' AS text
		    FROM domain_events e
		    WHERE e.conversation_id = c.id
		      AND e.type = 'conversation.message.agent'
		    ORDER BY e.global_seq DESC
		    LIMIT 1
		) lastmsg ON true`

// cnvListSummaryExtraColumns are the SELECT arms the two list READS (project
// and cross-project) share for the ADR-0065 fields, and cnvListSummaryExtraJoins
// the LATERALs that feed them. COALESCE + value scan, the same sentinel
// convention as the run-link columns: an empty string means the lateral
// matched nothing. The repository is the workspace binding first and the
// linked run's repository second — a run thread with no binding of its own
// still names where its run works (ADR-0065, run-thread arm).
const cnvListSummaryExtraColumns = `,
		       COALESCE(repo.repository_id, runrepo.repository_id, ''),
		       COALESCE(repo.repository_name, runrepo.repository_name, ''),
		       COALESCE(lastmsg.text, '')`

const cnvListSummaryExtraJoins = cnvRunLinkSubquery + cnvRepoSubquery + cnvRunRepoSubquery + cnvLastAgentSubquery

// cnvListFilters renders the optional list filters. Both are ” = off, so a
// plain list costs one equality-free clause; the q pattern escapes the three
// characters that would otherwise widen it (%, _, and the escape character
// itself), which is why "0%" matches only a title that contains 0%.
func cnvListFilters() string {
	return `
		  AND ($2::text = '' OR (la.attempt_id IS NOT NULL) = ($2::text = 'run'))
		  AND ($3::text = '' OR c.title ILIKE '%' || replace(replace(replace($3::text, '\', '\\'), '%', '\%'), '_', '\_') || '%')`
}

// ListConversations returns a project's conversations newest first, capped at
// 100 (api/openapi.yaml listConversations: no pagination in M2). A project the
// caller may not see is ErrConversationNotFound — the same 404 the rest of the
// project surface gives, so a conversation list cannot probe project existence.
// origin ("" | "manual" | "run") and query (case-insensitive title substring,
// "" = off) are the ADR-0043 filters; the join only ever narrows the list, so
// visibility is exactly the caller's project scope as before.
func (s *CnvStore) ListConversations(ctx context.Context, c Caller, projectID, origin, query string) ([]CnvSummary, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if _, err := prjGetProject(ctx, s.Pool, c, projectID); err != nil {
		return nil, ErrConversationNotFound
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT c.id::text, c.project_id::text, c.agent_profile_id::text, c.title, c.status,
		       c.created_by::text, COALESCE(cb.display_name, ''), c.created_at, c.updated_at,
		       ctl.controller_kind, COALESCE(ctl.controller_user_id::text, ''),
		       COALESCE(ctr.display_name, ''), COALESCE(ctl.previous_controller_user_id::text, ''),
		       ctl.version,
		       EXISTS (
		           SELECT 1 FROM conversation_turns t
		           WHERE t.conversation_id = c.id
		             AND t.status IN ('queued', 'leased', 'running')
		       ),
		       EXISTS (
		           SELECT 1 FROM acp_session_bindings b
		           WHERE b.conversation_id = c.id AND b.status = 'connected'
		       ),
		       COALESCE(la.run_id::text, ''), COALESCE(la.node_execution_id::text, ''),
		       COALESCE(la.node_instance_key, ''), COALESCE(la.node_id, ''),
		       COALESCE(la.attempt_id::text, ''), COALESCE(la.attempt_number, 0)`+
		cnvListSummaryExtraColumns+`
		FROM conversations c
		JOIN conversation_control ctl ON ctl.conversation_id = c.id
		LEFT JOIN users cb ON cb.id = c.created_by
		LEFT JOIN users ctr ON ctr.id = ctl.controller_user_id`+
		cnvListSummaryExtraJoins+`
		WHERE c.project_id = $1::uuid`+cnvListFilters()+`
		ORDER BY c.created_at DESC, c.id DESC
		LIMIT 100`, projectID, origin, query)
	if err != nil {
		return nil, fmt.Errorf("postgres: list conversations: %w", err)
	}
	defer rows.Close()

	out := make([]CnvSummary, 0, 8)
	for rows.Next() {
		var cv CnvSummary
		// The LATERAL join leaves every run-link column NULL for a manual
		// conversation, so they are COALESCEd to ''/0 in the query; an empty
		// attempt id is the "no link" sentinel (pgx v5 scans NULL only into a
		// pointer to a plain type, and this file's style is COALESCE + value).
		var (
			laRunID, laNodeExec, laNodeKey, laNodeID, laAttemptID string
			laAttemptNumber                                       int
			lastAgentChunk                                        string
		)
		if err := rows.Scan(&cv.ID, &cv.ProjectID, &cv.AgentProfileID, &cv.Title, &cv.Status,
			&cv.CreatedBy, &cv.CreatedByDisplay, &cv.CreatedAt, &cv.UpdatedAt,
			&cv.Control.Kind, &cv.Control.UserID, &cv.Control.DisplayName,
			&cv.Control.PreviousUserID, &cv.Control.Version,
			&cv.HasActiveTurn, &cv.AgentConnected,
			&laRunID, &laNodeExec, &laNodeKey, &laNodeID, &laAttemptID, &laAttemptNumber,
			&cv.RepositoryID, &cv.RepositoryName, &lastAgentChunk); err != nil {
			return nil, fmt.Errorf("postgres: scan conversation: %w", err)
		}
		cv.LastAgentLine = cnvLastAgentLine(lastAgentChunk)
		cv.Control.ConversationID = cv.ID
		cv.CreatedAt = cv.CreatedAt.UTC()
		cv.UpdatedAt = cv.UpdatedAt.UTC()
		if laAttemptID != "" {
			var laNodeIDPtr *string
			if laNodeID != "" {
				laNodeIDPtr = &laNodeID
			}
			cv.RunLink = &CnvRunLink{
				RunID:           laRunID,
				NodeExecutionID: laNodeExec,
				NodeInstanceKey: laNodeKey,
				NodeID:          laNodeIDPtr,
				AttemptID:       laAttemptID,
				AttemptNumber:   laAttemptNumber,
			}
			cv.Origin = "run"
		} else {
			cv.Origin = "manual"
		}
		out = append(out, cv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read conversations: %w", err)
	}
	return out, nil
}

// --- write side ---------------------------------------------------------
//
// The write side of the M2 conversation surface (ADR-0016 §2/§3/§5).
//
// What is deliberately *not* here: turn claims, lease renewals and worker
// terminal writes. Those are the execution worker's fenced store files; this
// file owns only what an API replica may change, and every one of those
// mutations is a controller-or-database decision, never a lease decision.

// cnvMaxPromptRunes mirrors conversation_turns.prompt's CHECK (1..65536); the
// handler rejects longer text first so a client names the offending field
// instead of colliding with a constraint.
const cnvMaxPromptRunes = 65536

// CreateConversation writes the conversation, its controller row and — when a
// prompt is supplied — its first queued turn and the journal rows describing
// them, in one transaction (ADR-0016 §2). Nothing is launched here: the turn is
// work for a worker to claim.
//
// The caller becomes the controller at version 1; conversation.created's
// payload carries that version so a viewer's first control mutation has a CAS
// token without a second round trip.
func (s *CnvStore) CreateConversation(ctx context.Context, c Caller, projectID, profileID, title, prompt string) (CnvConversation, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvConversation{}, err
	}
	if strings.TrimSpace(title) == "" {
		return CnvConversation{}, fmt.Errorf("%w: title is required", ErrConversationValidation)
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return CnvConversation{}, fmt.Errorf("postgres: begin create conversation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	project, err := prjGetProject(ctx, tx, c, projectID)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			return CnvConversation{}, ErrConversationNotFound
		}
		return CnvConversation{}, err
	}
	if !cnvMayWrite(c.IsOrgAdmin, authz.Role(project.MyRole)) {
		return CnvConversation{}, ErrConversationForbidden
	}

	profile, err := cnvProfileInOrganization(ctx, tx, profileID, c.OrganizationID)
	if err != nil {
		return CnvConversation{}, err
	}

	if err := LockEventJournal(ctx, tx, project.ID, project.OrganizationID); err != nil {
		return CnvConversation{}, err
	}

	var cv CnvConversation
	cv.ProjectID = project.ID
	cv.OrganizationID = project.OrganizationID
	cv.AgentProfileID = profile.ID
	cv.AgentProfileName = profile.Name
	cv.LauncherID = profile.LauncherID
	cv.MyRole = project.MyRole
	cv.Status = "idle"
	cv.AgentProfileVersion = profile.Version
	if err := tx.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, agent_profile_version, title, status, created_by)
		VALUES ($1::uuid, $2::uuid, $3::int, $4, 'idle', $5::uuid)
		RETURNING id::text, created_at, updated_at`,
		projectID, profileID, profile.Version, title, c.UserID).
		Scan(&cv.ID, &cv.CreatedAt, &cv.UpdatedAt); err != nil {
		return CnvConversation{}, fmt.Errorf("postgres: insert conversation: %w", err)
	}
	// The controller row travels with the conversation in this transaction: the
	// invariant "every conversation has exactly one control row" has no FK to
	// enforce it (that would be a cycle), so it is enforced here and by the
	// inner JOIN in every read (ADR-0016 §1).
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1::uuid, 'human', $2::uuid)`, cv.ID, c.UserID); err != nil {
		return CnvConversation{}, fmt.Errorf("postgres: insert control row: %w", err)
	}
	cv.Control = CnvControl{ConversationID: cv.ID, Kind: events.ControllerKindHuman, UserID: c.UserID, DisplayName: "", Version: 1}
	cv.CreatedAt = cv.CreatedAt.UTC()
	cv.UpdatedAt = cv.UpdatedAt.UTC()

	var turnID string
	if strings.TrimSpace(prompt) != "" {
		if err := tx.QueryRow(ctx, `
			INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
			VALUES ($1::uuid, $2, $3::uuid) RETURNING id::text`,
			cv.ID, prompt, c.UserID).Scan(&turnID); err != nil {
			return CnvConversation{}, fmt.Errorf("postgres: insert first turn: %w", err)
		}
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeConversationCreated,
		OrganizationID: cv.OrganizationID,
		ProjectID:      cv.ProjectID,
		ConversationID: cv.ID,
		Actor:          events.Human(c.UserID),
		Payload: events.ConversationCreatedPayload{
			ConversationID:   cv.ID,
			ProjectID:        cv.ProjectID,
			Title:            title,
			AgentProfileID:   cv.AgentProfileID,
			AgentProfileName: cv.AgentProfileName,
			LauncherID:       cv.LauncherID,
			ControllerUserID: c.UserID,
			ControlVersion:   cv.Control.Version,
		},
	}); err != nil {
		return CnvConversation{}, err
	}

	if turnID != "" {
		if _, err := AppendEvent(ctx, tx, events.New{
			Type:           events.TypeConversationMessageUser,
			OrganizationID: cv.OrganizationID,
			ProjectID:      cv.ProjectID,
			ConversationID: cv.ID,
			Actor:          events.Human(c.UserID),
			Payload: events.MessageUserPayload{
				ConversationID: cv.ID,
				TurnID:         turnID,
				SubmittedBy:    c.UserID,
				Text:           prompt,
			},
		}); err != nil {
			return CnvConversation{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return CnvConversation{}, fmt.Errorf("postgres: commit create conversation: %w", err)
	}
	return cnvGetConversation(ctx, s.Pool, c, cv.ID)
}

// cnvProfileInOrganization resolves the launch profile a conversation will use.
// A profile id that is not one of the caller's organization's profiles is
// ErrConversationValidation (422), not 404: the profile itself is
// organization-visible information and the client named a field it got wrong
// (api/openapi.yaml createConversation).
func cnvProfileInOrganization(ctx context.Context, q prjQuerier, profileID, orgID string) (CnvProfile, error) {
	if !prjValidUUID(profileID) {
		return CnvProfile{}, fmt.Errorf("%w: agent_profile_id must be a uuid", ErrConversationValidation)
	}
	var p CnvProfile
	err := q.QueryRow(ctx, `
		SELECT id::text, organization_id::text, name, launcher_id, permission_mode
		FROM agent_profiles
		WHERE id = $1::uuid AND organization_id = $2::uuid`, profileID, orgID).
		Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID, &p.PermissionMode)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, fmt.Errorf("%w: no such agent profile in your organization", ErrConversationValidation)
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: get agent profile: %w", err)
	}
	return p, nil
}

// cnvMayWrite reports whether a project role may drive a conversation. ADR-0016
// §8 grants conversation writes to contributor and maintainer (M1's CanManage
// is maintainer-only, which is right for repositories and wrong for prompting).
func cnvMayWrite(isOrgAdmin bool, r authz.Role) bool {
	if isOrgAdmin {
		return true
	}
	switch r {
	case authz.RoleMaintainer, authz.RoleContributor:
		return true
	default:
		return false
	}
}

// PostMessage enqueues a turn carrying a prompt and appends
// conversation.message.user in the same transaction (ADR-0016 §3). It never
// waits for the agent: the answer arrives over the conversation stream.
//
// Both refusals are database-backed, not handler discipline:
//   - not the controller  -> CnvConflict{NotController} with the live control row
//   - a turn already active -> the partial unique index raises 23505, which
//     becomes CnvConflict{TurnInProgress} with the turn that is in the way.
func (s *CnvStore) PostMessage(ctx context.Context, c Caller, conversationID, prompt string) (CnvTurn, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvTurn{}, err
	}
	if strings.TrimSpace(prompt) == "" {
		return CnvTurn{}, fmt.Errorf("%w: prompt is required", ErrConversationValidation)
	}

	var (
		turn     CnvTurn
		chat     CnvConversation
		project  string
		org      string
		conflict *CnvConflict
	)
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		chat, project, org, err = cnvWritableConversation(ctx, tx, c, conversationID)
		if err != nil {
			return err
		}
		if conflict = cnvControllerConflict(&chat, c); conflict != nil {
			return conflict
		}
		if chat.Status == "archived" {
			return &CnvConflict{
				Kind:           ConflictArchived,
				Detail:         "The conversation is archived; it takes no further turns.",
				ConversationID: chat.ID,
				Control:        &chat.Control,
			}
		}
		if err := LockEventJournal(ctx, tx, project, org); err != nil {
			return err
		}

		// The lock, not a pre-read, is what makes "at most one active turn"
		// true under a concurrent submit: the loser's INSERT raises 23505.
		existing, err := cnvActiveTurn(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		if existing != nil {
			conflict = &CnvConflict{
				Kind:           ConflictTurnInProgress,
				Detail:         "A turn is already queued or running for this conversation.",
				ConversationID: conversationID,
				Control:        &chat.Control,
				ActiveTurn:     existing,
			}
			return conflict
		}

		err = tx.QueryRow(ctx, `
			INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
			VALUES ($1::uuid, $2, $3::uuid)
			RETURNING id::text`,
			conversationID, prompt, c.UserID).Scan(&turn.ID)
		if err != nil {
			if prjIsConflict(err) {
				// Lost the race for the partial unique index: re-read through a
				// savepoint-free statement so the caller still learns which turn
				// is in the way. The insert failed, so this transaction is still
				// usable for a read of committed data.
				winner, rerr := cnvActiveTurn(ctx, tx, conversationID)
				if rerr != nil {
					return rerr
				}
				conflict = &CnvConflict{
					Kind:           ConflictTurnInProgress,
					Detail:         "A turn is already queued or running for this conversation.",
					ConversationID: conversationID,
					Control:        &chat.Control,
					ActiveTurn:     winner,
				}
				return conflict
			}
			return fmt.Errorf("postgres: insert turn: %w", err)
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type:           events.TypeConversationMessageUser,
			OrganizationID: org,
			ProjectID:      project,
			ConversationID: conversationID,
			Actor:          events.Human(c.UserID),
			Payload: events.MessageUserPayload{
				ConversationID: conversationID,
				TurnID:         turn.ID,
				SubmittedBy:    c.UserID,
				Text:           prompt,
			},
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil && !errors.As(err, &conflict) {
		return CnvTurn{}, err
	}
	if conflict != nil {
		return CnvTurn{}, conflict
	}
	return cnvTurnByID(ctx, s.Pool, turn.ID)
}

// TakeControl moves the exclusive controller lock to the caller by
// compare-and-swap against the version the caller last read (ADR-0016 §2/§5).
//
// Exactly one of two simultaneous callers wins: the control row is locked for
// the update, and a stale version answers CnvConflict{ControlVersionStale}
// carrying the *current* control so the loser adopts the winner instead of
// retrying blindly. Taking control while already the controller is idempotent
// (double-clicking must not burn a token).
//
// Taking control while another human's turn is leased or running sets
// cancel_requested_at on that turn in the same transaction. Control transfers
// immediately; the turn ends when the harness agrees, and the one-active-turn
// index is what stops the new controller prompting before then.
//
// When the displaced holder is a run attempt (controller_kind='run_attempt',
// contract § 5.3 / C9g) the run moves too, in this same transaction: its
// attempt closes interrupted{human_takeover} and the run pauses
// paused_reason='human_takeover', through RuntimeStore so the engine owns those
// semantics. An attempt that already reached its terminal owns no live work, and
// then the takeover is the plain M2 handover with no run change.
func (s *CnvStore) TakeControl(ctx context.Context, c Caller, conversationID string, version int) (CnvConversation, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvConversation{}, err
	}
	return s.transferControl(ctx, c, conversationID, version, events.TransferTaken, false)
}

// ReturnControl hands the lock back to the controller it displaced, when that
// user may still drive the project; otherwise control goes to `none` and any
// contributor can take it (ADR-0016 §5). It never cancels a turn: stopping work
// is CancelTurn's job, so "I stopped the agent" and "I stopped driving" stay
// distinguishable in the transcript.
//
// Only the current controller may return it, so a UI cannot release a lock it
// never held.
//
// Control a human took from a run attempt goes back to that run (§ 5.3): the
// takeover pause is lifted in the same transaction, the conversation's control
// returns to controller_kind='run_attempt' naming the attempt that will actually
// drive next, and what the human did while they held the wheel is handed to it
// as that attempt's retry_context.
func (s *CnvStore) ReturnControl(ctx context.Context, c Caller, conversationID string, version int) (CnvConversation, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvConversation{}, err
	}
	return s.transferControl(ctx, c, conversationID, version, events.TransferReturned, true)
}

// transferControl is the one implementation of both control mutations. The
// differences are exactly two: whether the caller must already hold the lock
// (only when returning), and whether a running turn is asked to stop (only when
// taking).
func (s *CnvStore) transferControl(ctx context.Context, c Caller, conversationID string, version int, reason string, requireHolder bool) (CnvConversation, error) {
	var (
		out      CnvConversation
		conflict *CnvConflict
	)
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		chat, project, org, err := cnvWritableConversation(ctx, tx, c, conversationID)
		if err != nil {
			return err
		}
		holderIsCaller := chat.Control.Kind == events.ControllerKindHuman && chat.Control.UserID == c.UserID
		if requireHolder && !holderIsCaller {
			conflict = cnvNotControllerConflict(&chat)
			return conflict
		}
		// Taking control you already hold is a no-op with a 200: same version,
		// no event, so a double-click cannot burn the CAS token.
		if !requireHolder && holderIsCaller && chat.Control.Version == version {
			out = chat
			return nil
		}
		if chat.Control.Version != version {
			conflict = &CnvConflict{
				Kind:           ConflictControlVersionStale,
				Detail:         fmt.Sprintf("conversation_control.version is %d, not %d.", chat.Control.Version, version),
				ConversationID: conversationID,
				Control:        &chat.Control,
			}
			return conflict
		}

		// Lock the row the mutation is about to change before reading it again:
		// the version just checked cannot move underneath the update, which is
		// what makes the CAS below a real compare-and-swap and not a race that
		// happens to usually work.
		held, err := cnvControlForUpdate(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		if held.Version != version {
			conflict = &CnvConflict{
				Kind:           ConflictControlVersionStale,
				Detail:         fmt.Sprintf("conversation_control.version is %d, not %d.", held.Version, version),
				ConversationID: conversationID,
				Control:        held,
			}
			return conflict
		}

		fromKind, fromUser := held.Kind, held.UserID

		// Returning control gives it back to whoever the current holder
		// displaced, provided they may still drive the project; taking control
		// records the displaced holder so a later return finds its way back.
		toKind, toUser := events.ControllerKindHuman, c.UserID
		previous := held.UserID
		// resumeAttempt/resumeRun name the run attempt this handback returns
		// the wheel to; takeoverAttempt names the one this handover displaces.
		// Both are empty for the human<->human case M2 was built for.
		var takeoverAttempt, resumeAttempt, resumeRun string
		if requireHolder {
			previous = c.UserID
			toKind, toUser = events.ControllerKindNone, ""
			if held.PreviousUserID != "" && cnvUserMayWrite(ctx, tx, held.PreviousUserID, project) {
				toKind, toUser = events.ControllerKindHuman, held.PreviousUserID
			}
			// Contract § 5.3: control that a human took from a run attempt goes
			// BACK to that attempt, not to 'none' — the run is the reason the
			// conversation has a controller at all, and it is paused waiting on
			// exactly this transaction.
			var err error
			if resumeAttempt, resumeRun, err = cnvTakeoverToResume(ctx, tx, conversationID); err != nil {
				return err
			}
			if resumeAttempt != "" {
				toKind, toUser = events.ControllerKindRunAttempt, ""
			}
		} else if held.Kind == events.ControllerKindRunAttempt {
			takeoverAttempt = held.RunAttemptID
		}

		tag, err := tx.Exec(ctx, `
			UPDATE conversation_control
			SET controller_kind = $2,
			    controller_user_id = NULLIF($3, '')::uuid,
			    controller_run_attempt_id = NULLIF($6, '')::uuid,
			    previous_controller_user_id = NULLIF($4, '')::uuid,
			    version = version + 1,
			    acquired_at = now(),
			    updated_at = now()
			WHERE conversation_id = $1::uuid AND version = $5`,
			conversationID, toKind, toUser, previous, version, resumeAttempt)
		if err != nil {
			return fmt.Errorf("postgres: compare-and-swap control: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// Unreachable while holding the row lock; kept because a CAS that
			// silently matched nothing would hand two users the same lock.
			current, rerr := cnvControlForUpdate(ctx, tx, conversationID)
			if rerr != nil {
				return rerr
			}
			conflict = &CnvConflict{
				Kind:           ConflictControlVersionStale,
				Detail:         fmt.Sprintf("conversation_control.version is %d, not %d.", current.Version, version),
				ConversationID: conversationID,
				Control:        current,
			}
			return conflict
		}
		newVersion := version + 1

		if err := LockEventJournal(ctx, tx, project, org); err != nil {
			return err
		}

		// A takeover asks the running turn to stop; a return does not. The turn
		// row is locked first so a worker terminalising it concurrently is either
		// fully before or fully after this write.
		var turnID string
		if !requireHolder {
			active, err := cnvActiveTurnForUpdate(ctx, tx, conversationID)
			if err != nil {
				return err
			}
			if active != nil && (active.Status == events.TurnStatusLeased || active.Status == events.TurnStatusRunning) {
				if _, err := tx.Exec(ctx, `
					UPDATE conversation_turns
					SET cancel_requested_at = COALESCE(cancel_requested_at, now())
					WHERE id = $1::uuid`, active.ID); err != nil {
					return fmt.Errorf("postgres: request cancel on taken-over turn: %w", err)
				}
				turnID = active.ID
			}
		}

		if _, err := AppendEvent(ctx, tx, events.New{
			Type:           events.TypeConversationControlTransferred,
			OrganizationID: org,
			ProjectID:      project,
			ConversationID: conversationID,
			Actor:          events.Human(c.UserID),
			Payload: events.ControlTransferredPayload{
				ConversationID: conversationID,
				TurnID:         turnID,
				FromKind:       fromKind,
				FromUserID:     fromUser,
				ToKind:         toKind,
				ToUserID:       toUser,
				Reason:         reason,
				ControlVersion: newVersion,
			},
		}); err != nil {
			return err
		}
		// The run-side half of the handoff, in this same transaction: control
		// and run state move together or not at all (ADR-0016 § 5).
		if takeoverAttempt != "" {
			if err := cnvRunTakeover(ctx, tx, takeoverAttempt, c.UserID); err != nil {
				return err
			}
		}
		if resumeAttempt != "" {
			if err := cnvRunResumeAfterTakeover(ctx, tx, conversationID, resumeRun, resumeAttempt, c.UserID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil && !errors.As(err, &conflict) {
		return CnvConversation{}, err
	}
	if conflict != nil {
		return CnvConversation{}, conflict
	}
	if out.ID != "" {
		return out, nil
	}
	return cnvGetConversation(ctx, s.Pool, c, conversationID)
}

// CancelTurn asks the agent to stop. Controller only.
//
//   - A `leased`/`running` turn gets cancel_requested_at and is reported as it
//     stands: this response is a request, not proof that the agent stopped, and
//     only a writer holding the current fencing token may close the turn.
//   - A `queued` turn has not started, so cancelling it *is* terminal: it goes
//     straight to `cancelled` with conversation.turn.cancelled appended here.
//   - No active turn is CnvConflict{NoActiveTurn}.
func (s *CnvStore) CancelTurn(ctx context.Context, c Caller, conversationID string) (CnvTurn, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvTurn{}, err
	}
	var (
		out      CnvTurn
		conflict *CnvConflict
	)
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		chat, project, org, err := cnvWritableConversation(ctx, tx, c, conversationID)
		if err != nil {
			return err
		}
		if conflict = cnvControllerConflict(&chat, c); conflict != nil {
			return conflict
		}
		active, err := cnvActiveTurnForUpdate(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		if active == nil {
			conflict = &CnvConflict{
				Kind:           ConflictNoActiveTurn,
				Detail:         "No turn is queued or running for this conversation.",
				ConversationID: conversationID,
				Control:        &chat.Control,
			}
			return conflict
		}
		if err := LockEventJournal(ctx, tx, project, org); err != nil {
			return err
		}
		if active.Status == events.TurnStatusQueued {
			tag, err := tx.Exec(ctx, `
				UPDATE conversation_turns
				SET status = 'cancelled', cancel_requested_at = now(), finished_at = now(),
				    stop_reason = 'cancelled'
				WHERE id = $1::uuid AND status = 'queued'`, active.ID)
			if err != nil {
				return fmt.Errorf("postgres: cancel queued turn: %w", err)
			}
			if tag.RowsAffected() == 0 {
				// A worker claimed it between the lock and here — impossible
				// while the row is locked, but a silent no-op would report a
				// cancellation that did not happen.
				return fmt.Errorf("postgres: cancel queued turn: row changed under the lock")
			}
			if _, err := AppendEvent(ctx, tx, events.New{
				Type:           events.TypeConversationTurnCancelled,
				OrganizationID: org,
				ProjectID:      project,
				ConversationID: conversationID,
				Actor:          events.Human(c.UserID),
				Payload: events.TurnCancelledPayload{
					ConversationID: conversationID,
					TurnID:         active.ID,
					StopReason:     "cancelled",
					RequestedBy:    c.UserID,
				},
			}); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `
				UPDATE conversation_turns
				SET cancel_requested_at = COALESCE(cancel_requested_at, now())
				WHERE id = $1::uuid`, active.ID); err != nil {
				return fmt.Errorf("postgres: request turn cancel: %w", err)
			}
		}
		fresh, err := cnvTurnByID(ctx, tx, active.ID)
		if err != nil {
			return err
		}
		out = fresh
		return nil
	})
	if err != nil && !errors.As(err, &conflict) {
		return CnvTurn{}, err
	}
	if conflict != nil {
		return CnvTurn{}, conflict
	}
	return out, nil
}

// DecidePermission records the controller's answer to a permission prompt,
// durably before it is live: the row moves to `decided` and
// conversation.permission.decided is appended in one transaction, and the
// worker — the only process speaking ACP — translates it into the JSON-RPC
// response (ADR-0016 §5).
//
// option_id must be one the agent actually offered: inventing a permission is
// 422. A prompt that is not pending is 409, so a decision cannot be
// double-spent.
func (s *CnvStore) DecidePermission(ctx context.Context, c Caller, conversationID, requestID, optionID string) (CnvPermission, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvPermission{}, err
	}
	if strings.TrimSpace(optionID) == "" {
		return CnvPermission{}, fmt.Errorf("%w: option_id is required", ErrConversationValidation)
	}

	var (
		out      CnvPermission
		conflict *CnvConflict
	)
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		chat, project, org, err := cnvWritableConversation(ctx, tx, c, conversationID)
		if err != nil {
			return err
		}
		if conflict = cnvControllerConflict(&chat, c); conflict != nil {
			return conflict
		}

		var p CnvPermission
		var options []byte
		var status string
		err = tx.QueryRow(ctx, `
			SELECT id::text, conversation_id::text, turn_id::text, status, tool_title, tool_kind,
			       COALESCE(tool_call_id, ''), options, COALESCE(decided_by::text, ''),
			       decided_by_kind, COALESCE(decided_by_policy, ''),
			       COALESCE(decision_option_id, ''), requested_at, deadline_at, decided_at
			FROM permission_requests
			WHERE id = $1::uuid AND conversation_id = $2::uuid
			FOR UPDATE`, requestID, conversationID).
			Scan(&p.ID, &p.ConversationID, &p.TurnID, &status, &p.ToolTitle, &p.ToolKind,
				&p.ToolCallID, &options, &p.DecidedBy, &p.DecidedByKind, &p.DecidedByPolicy,
				&p.DecisionOptionID,
				&p.RequestedAt, &p.DeadlineAt, &p.DecidedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			// A prompt of another conversation is answered like one that does not
			// exist at all: never a 403 that confirms the id is real.
			return ErrConversationNotFound
		}
		if err != nil {
			return fmt.Errorf("postgres: get permission request: %w", err)
		}
		p.Status = status
		p.Options, err = cnvParseOptions(options)
		if err != nil {
			return err
		}
		if p.Status != events.PermissionStatusPending {
			conflict = &CnvConflict{
				Kind:           ConflictPermissionNotPending,
				Detail:         fmt.Sprintf("The permission request is %s, not pending.", p.Status),
				ConversationID: conversationID,
				Control:        &chat.Control,
			}
			return conflict
		}
		if !cnvOffersOption(p.Options, optionID) {
			return fmt.Errorf("%w: the agent did not offer option_id %q", ErrConversationValidation, optionID)
		}

		if _, err := tx.Exec(ctx, `
			UPDATE permission_requests
			SET status = 'decided', decided_by = $2::uuid, decision_option_id = $3, decided_at = now()
			WHERE id = $1::uuid`, requestID, c.UserID, optionID); err != nil {
			return fmt.Errorf("postgres: decide permission request: %w", err)
		}
		if err := LockEventJournal(ctx, tx, project, org); err != nil {
			return err
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type:           events.TypeConversationPermissionDecided,
			OrganizationID: org,
			ProjectID:      project,
			ConversationID: conversationID,
			Actor:          events.Human(c.UserID),
			Payload: events.PermissionDecidedPayload{
				ConversationID:      conversationID,
				TurnID:              p.TurnID,
				PermissionRequestID: p.ID,
				Status:              events.PermissionStatusDecided,
				DecisionOptionID:    optionID,
				DecidedBy:           c.UserID,
			},
		}); err != nil {
			return err
		}
		p.Status = events.PermissionStatusDecided
		p.DecidedBy = c.UserID
		p.DecisionOptionID = optionID
		now := time.Now().UTC()
		p.DecidedAt = &now
		out = p
		return nil
	})
	if err != nil && !errors.As(err, &conflict) {
		return CnvPermission{}, err
	}
	if conflict != nil {
		return CnvPermission{}, conflict
	}
	return out, nil
}

// cnvOffersOption answers whether the agent offered this option id. The client
// may echo an option, never invent one (api/openapi.yaml PermissionDecision).
func cnvOffersOption(options []events.PermissionOption, optionID string) bool {
	for _, o := range options {
		if o.OptionID == optionID {
			return true
		}
	}
	return false
}

// RecordConversationDenied writes the audit_events row every refused
// conversation attempt leaves behind (ADR-0014 §3, ADR-0016 Security). The
// project is resolved without authorizing it: audit is server-side bookkeeping
// and never answers the client.
func (s *CnvStore) RecordConversationDenied(ctx context.Context, c Caller, conversationID, action string) error {
	if action == "" {
		action = "access denied"
	}
	projectID := ""
	var role string
	if prjValidUUID(conversationID) {
		_ = s.Pool.QueryRow(ctx, `
			SELECT c.project_id::text, COALESCE(m.role, '')
			FROM conversations c
			LEFT JOIN memberships m ON m.project_id = c.project_id AND m.user_id = $2::uuid
			WHERE c.id = $1::uuid`, conversationID, c.UserID).Scan(&projectID, &role)
	}
	detail := fmt.Sprintf(`{"action":%q,"conversation_id":%q,"project_id":%q,"role":%q}`,
		action, conversationID, projectID, role)
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, 'human', $3, $4, 'denied', $5::jsonb)`,
		c.OrganizationID, prjCleanUUID(projectID), c.UserID, action, detail)
	if err != nil {
		return fmt.Errorf("postgres: record conversation denial: %w", err)
	}
	return nil
}

// --- shared write plumbing ----------------------------------------------

// cnvWritableConversation resolves the conversation the caller wants to write
// to, with its control row and project ids, inside the caller's transaction.
// Existence and role are decided by the same statement, so a membership revoked
// between the handler's check and this one changes the answer.
func cnvWritableConversation(ctx context.Context, tx pgx.Tx, c Caller, conversationID string) (chat CnvConversation, projectID, orgID string, err error) {
	chat, err = cnvScanConversation(tx.QueryRow(ctx, cnvConversationSelect,
		c.UserID, conversationID, c.OrganizationID, c.IsOrgAdmin))
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvConversation{}, "", "", ErrConversationNotFound
	}
	if err != nil {
		return CnvConversation{}, "", "", fmt.Errorf("postgres: get conversation for write: %w", err)
	}
	if !cnvMayWrite(c.IsOrgAdmin, authz.Role(chat.MyRole)) {
		return CnvConversation{}, "", "", ErrConversationForbidden
	}
	return chat, chat.ProjectID, chat.OrganizationID, nil
}

// cnvControllerConflict is the shared controller-only refusal: a non-controller
// gets 409 carrying the current control, never 403, because "who is driving" is
// state the client is entitled to see (ADR-0016 §8).
func cnvControllerConflict(chat *CnvConversation, c Caller) *CnvConflict {
	if chat.Control.Kind == events.ControllerKindHuman && chat.Control.UserID == c.UserID {
		return nil
	}
	return cnvNotControllerConflict(chat)
}

func cnvNotControllerConflict(chat *CnvConversation) *CnvConflict {
	who := "nobody"
	if chat.Control.UserID != "" {
		who = chat.Control.DisplayName
		if who == "" {
			who = chat.Control.UserID
		}
	}
	return &CnvConflict{
		Kind:           ConflictNotController,
		Detail:         fmt.Sprintf("%s holds the controller lock; only the controller may do this.", who),
		ConversationID: chat.ID,
		Control:        &chat.Control,
	}
}

// cnvControlForUpdate re-reads the control row under a row lock. The lock is
// taken on conversation_control alone (no join), because FOR UPDATE over a join
// would also lock the controller's users row — work other writers contend with
// for no reason. The display name is a separate unlocked read.
func cnvControlForUpdate(ctx context.Context, tx pgx.Tx, conversationID string) (*CnvControl, error) {
	var ctl CnvControl
	err := tx.QueryRow(ctx, `
		SELECT conversation_id::text, controller_kind, COALESCE(controller_user_id::text, ''),
		       COALESCE(previous_controller_user_id::text, ''),
		       COALESCE(controller_run_attempt_id::text, ''), version
		FROM conversation_control
		WHERE conversation_id = $1::uuid
		FOR UPDATE`, conversationID).
		Scan(&ctl.ConversationID, &ctl.Kind, &ctl.UserID, &ctl.PreviousUserID,
			&ctl.RunAttemptID, &ctl.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrConversationNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock control row: %w", err)
	}
	if ctl.UserID != "" {
		if err := tx.QueryRow(ctx,
			`SELECT display_name FROM users WHERE id = $1::uuid`, ctl.UserID).Scan(&ctl.DisplayName); err != nil {
			return nil, fmt.Errorf("postgres: control holder display name: %w", err)
		}
	}
	return &ctl, nil
}

// cnvRunTakeover is contract § 5.3's run half of a takeover, applied inside the
// caller's transaction: the attempt is interrupted{human_takeover} and its run
// pauses with that reason, through RuntimeStore so the engine owns the
// semantics (pause first, then interrupt, journal once).
//
// Fencing rule: an attempt that already reached its terminal owns no live work
// to cancel, so taking over its conversation is plain M2 behaviour and changes
// no run row. A run already terminal is skipped for the same reason — there is
// nothing left to pause.
func cnvRunTakeover(ctx context.Context, tx pgx.Tx, attemptID, actor string) error {
	if attemptID == "" {
		return nil
	}
	var runID string
	var live bool
	err := tx.QueryRow(ctx, `
		SELECT a.run_id::text,
		       a.status IN ('queued', 'leased', 'running')
		         AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
		FROM attempts a
		JOIN runs r ON r.id = a.run_id
		WHERE a.id = $1::uuid`, attemptID).Scan(&runID, &live)
	if errors.Is(err, pgx.ErrNoRows) {
		// The control row pointed at no attempt: a hand-seeded row, not a run.
		return nil
	}
	if err != nil {
		return fmt.Errorf("postgres: resolve run attempt %s for takeover: %w", attemptID, err)
	}
	if !live {
		return nil
	}
	// The worker still standing must learn to stop the harness: ADR-0016 § 5
	// makes cancel_requested_at the signal it polls, and only that worker knows
	// whether the ACP session answered session/cancel — the interrupted terminal
	// below is the run's word, never the turn's. Stamped BEFORE the engine's
	// close so the hydrate inside HumanTakeoverTx carries the flag on the row it
	// writes back.
	if _, err := tx.Exec(ctx, `
		UPDATE attempts SET cancel_requested_at = COALESCE(cancel_requested_at, now())
		WHERE id = $1::uuid`, attemptID); err != nil {
		return fmt.Errorf("postgres: cancel-request taken-over attempt %s: %w", attemptID, err)
	}
	return takeoverRuntime().HumanTakeoverTx(ctx, tx, runID, attemptID, actor)
}

// cnvTakeoverToResume answers return-control's new question: did a human take
// this conversation away from a run attempt that is still waiting for it back?
// The ledger is the record — the attempt this conversation belongs to, already
// interrupted, on a run paused for exactly that reason — because
// conversation_control has a user column for previous holders and cannot name
// an attempt. Returns ("", "") for every conversation M2's rules cover.
func cnvTakeoverToResume(ctx context.Context, tx pgx.Tx, conversationID string) (string, string, error) {
	var attemptID, runID string
	err := tx.QueryRow(ctx, `
		SELECT a.id::text, a.run_id::text
		FROM attempts a
		JOIN runs r ON r.id = a.run_id
		WHERE a.conversation_id = $1::uuid
		  AND a.status = 'interrupted'
		  AND r.status = 'paused' AND r.paused_reason = 'human_takeover'
		ORDER BY a.finished_at DESC NULLS LAST
		LIMIT 1`, conversationID).Scan(&attemptID, &runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("postgres: resolve takeover to resume for conversation %s: %w", conversationID, err)
	}
	return attemptID, runID, nil
}

// cnvRunResumeAfterTakeover lifts the pause and hands the recorded intervention
// to the next attempt (§ 5.3: "return-control resumes it with the recorded
// intervention as the next attempt's retry_context"). What the human did while
// they drove is read from the turn rows, never from a memory, so a control
// plane that restarted mid-takeover still says what actually happened.
func cnvRunResumeAfterTakeover(ctx context.Context, tx pgx.Tx,
	conversationID, runID, attemptID, returningUser string) error {
	interruptedAt, err := cnvAttemptFinishedAt(ctx, tx, attemptID)
	if err != nil {
		return err
	}
	intervention, err := cnvTakeoverIntervention(ctx, tx, conversationID, interruptedAt)
	if err != nil {
		return err
	}
	intervention["returned_by"] = returningUser
	intervention["reason"] = takeoverReasonName()
	if err := takeoverRuntime().ResumeFromHumanTakeoverTx(ctx, tx, runID, attemptID, returningUser, intervention); err != nil {
		return err
	}
	return cnvRepointControl(ctx, tx, conversationID, attemptID)
}

// cnvRepointControl names the attempt that will actually drive the
// conversation now that the pause is lifted: the newly queued one, read back
// from the rows the resume just wrote. The interrupted attempt is the
// controller the CAS handed back (ADR-0016 § 5's "previous holder"), but it is
// terminal, and § 4 step 6 gives the next attempt the wheel when it claims —
// this just makes the control row tell the truth in between.
func cnvRepointControl(ctx context.Context, tx pgx.Tx, conversationID, oldAttemptID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE conversation_control
		SET controller_run_attempt_id = COALESCE((
			SELECT newer.id FROM attempts newer
			JOIN attempts older ON older.id = $2::uuid
			  AND newer.node_execution_id = older.node_execution_id
			WHERE newer.status = 'queued'
			ORDER BY newer.attempt_number DESC
			LIMIT 1), controller_run_attempt_id)
		WHERE conversation_id = $1::uuid AND controller_kind = 'run_attempt'`,
		conversationID, oldAttemptID)
	if err != nil {
		return fmt.Errorf("postgres: hand conversation %s control to the resumed attempt: %w", conversationID, err)
	}
	return nil
}

// takeoverReasonName is the reason string retry_context carries, mirroring the
// engine's paused_reason so the two halves spell the handoff identically.
func takeoverReasonName() string { return "human_takeover" }

// cnvAttemptFinishedAt reads the moment the takeover closed the attempt, which
// is the moment the human's own turns begin.
func cnvAttemptFinishedAt(ctx context.Context, tx pgx.Tx, attemptID string) (time.Time, error) {
	var at time.Time
	err := tx.QueryRow(ctx, `SELECT coalesce(finished_at, now()) FROM attempts WHERE id = $1::uuid`,
		attemptID).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("postgres: read takeover time for attempt %s: %w", attemptID, err)
	}
	return at, nil
}

// cnvTakeoverIntervention collects the human's prompts from the moment the
// attempt lost control: the attempt's own turns carry node_attempt_id and are
// the agent's transcript, not the intervention, so they are excluded by
// construction rather than by timestamp arithmetic.
func cnvTakeoverIntervention(ctx context.Context, tx pgx.Tx, conversationID string, since time.Time) (map[string]any, error) {
	rows, err := tx.Query(ctx, `
		SELECT prompt, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		FROM conversation_turns
		WHERE conversation_id = $1::uuid AND node_attempt_id IS NULL AND created_at > $2
		ORDER BY created_at, id`, conversationID, since)
	if err != nil {
		return nil, fmt.Errorf("postgres: read takeover turns for conversation %s: %w", conversationID, err)
	}
	defer rows.Close()
	var turns []any
	for rows.Next() {
		var prompt, at string
		if err := rows.Scan(&prompt, &at); err != nil {
			return nil, fmt.Errorf("postgres: scan takeover turn: %w", err)
		}
		turns = append(turns, map[string]any{"prompt": prompt, "at": at})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read takeover turns: %w", err)
	}
	if turns == nil {
		turns = []any{}
	}
	return map[string]any{"turns": turns, "turn_count": len(turns)}, nil
}

// cnvUserMayWrite answers return-control's question: may the user we would hand
// the lock to still drive this project? It is a membership read, not a
// visibility read — an organization admin with no membership is not a
// controller candidate, because control is granted by CAS, not by rank.
func cnvUserMayWrite(ctx context.Context, q prjQuerier, userID, projectID string) bool {
	var mayWrite bool
	err := q.QueryRow(ctx, `
		SELECT role IN ('maintainer', 'contributor')
		FROM memberships
		WHERE user_id = $1::uuid AND project_id = $2::uuid`, userID, projectID).Scan(&mayWrite)
	if err != nil {
		// No row, or an unreadable one, means the same thing: control goes to none.
		return false
	}
	return mayWrite
}

// cnvTurnByID reads one turn back as the API sees it (display name included).
func cnvTurnByID(ctx context.Context, q prjQuerier, turnID string) (CnvTurn, error) {
	t, err := cnvScanTurn(q.QueryRow(ctx, `
		SELECT t.id::text, t.conversation_id::text, t.status, t.prompt, t.submitted_by::text,
		       COALESCE(u.display_name, ''), COALESCE(t.worker_id::text, ''),
		       t.cancel_requested_at, t.stop_reason, t.created_at, t.started_at, t.finished_at,
		       t.submitted_via
		FROM conversation_turns t
		LEFT JOIN users u ON u.id = t.submitted_by
		WHERE t.id = $1::uuid`, turnID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvTurn{}, ErrConversationNotFound
	}
	if err != nil {
		return CnvTurn{}, fmt.Errorf("postgres: get turn: %w", err)
	}
	return t, nil
}

// inTx runs fn inside a transaction, committing on a nil error and rolling back
// otherwise. CnvConflict is an error, so a refused mutation rolls back exactly
// like a failed one — a conflict never leaves a partial write behind.
func (s *CnvStore) inTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit transaction: %w", err)
	}
	return nil
}

// Conflict reports whether err is a conversation conflict the handler must
// render as a 409 with state, exposing the payload so callers need not import
// the concrete type.
func Conflict(err error) (kind, detail, conversationID string, control *CnvControl, activeTurn *CnvTurn, ok bool) {
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf == nil {
		return "", "", "", nil, nil, false
	}
	return cf.Kind, cf.Detail, cf.ConversationID, cf.Control, cf.ActiveTurn, true
}

// --- adapter ------------------------------------------------------------
// APIConversationStore is the HTTP-facing face of the conversation store.
type APIConversationStore struct {
	S *CnvStore
}

var (
	_ api.ConversationStore = APIConversationStore{}
	_ api.ConversationStore = (*APIConversationStore)(nil)
	_ api.ProfileStore      = APIConversationStore{}
	_ api.ProfileStore      = (*APIConversationStore)(nil)
)

func (a APIConversationStore) store() (*CnvStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APIConversationStore has no pool")
	}
	return a.S, nil
}

// cnvAPIErr maps a store error onto the sentinel errors the HTTP layer switches
// on. A *CnvConflict is translated field by field rather than wrapped, because
// the 409 body must carry the live control row (ADR-0016 §9 obligation 3): the
// UI adopts what it is handed instead of retrying blindly.
func cnvAPIErr(err error) error {
	if err == nil {
		return nil
	}
	var cf *CnvConflict
	if errors.As(err, &cf) {
		return &api.ConversationConflict{
			Kind:           cf.Kind,
			Detail:         cnvConflictDetail(cf),
			ConversationID: cf.ConversationID,
			Control:        cnvAPIControlPtr(cf.Control),
			ActiveTurn:     cnvAPITurnPtr(cf.ActiveTurn, false),
		}
	}
	switch {
	case errors.Is(err, ErrConversationNotFound):
		return fmt.Errorf("%w: %w", api.ErrConversationNotFound, err)
	case errors.Is(err, ErrConversationForbidden):
		return fmt.Errorf("%w: %w", api.ErrConversationForbidden, err)
	case errors.Is(err, ErrConversationValidation):
		return fmt.Errorf("%w: %w", api.ErrConversationValidation, err)
	default:
		return err
	}
}

// cnvConflictDetail prefers the store's human sentence; the kind alone would
// tell a client that it lost without telling it to whom.
func cnvConflictDetail(cf *CnvConflict) string {
	if cf.Detail != "" {
		return cf.Detail
	}
	return "The request conflicts with the conversation's current state."
}

// ListAgentProfiles implements api.ProfileStore.
func (a APIConversationStore) ListAgentProfiles(ctx context.Context, c api.Caller) ([]api.AgentProfileView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	profiles, err := s.ListAgentProfiles(ctx, prjAPICaller(c))
	if err != nil {
		return nil, cnvAPIErr(err)
	}
	out := make([]api.AgentProfileView, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, cnvProfileView(p))
	}
	return out, nil
}

// ListConversations implements api.ConversationStore, forwarding the
// ADR-0043 origin and q filters unchanged.
func (a APIConversationStore) ListConversations(ctx context.Context, c api.Caller, projectID, origin, query string) ([]api.ConversationSummaryView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	chats, err := s.ListConversations(ctx, prjAPICaller(c), projectID, origin, query)
	if err != nil {
		return nil, cnvAPIErr(err)
	}
	out := make([]api.ConversationSummaryView, 0, len(chats))
	for _, cv := range chats {
		out = append(out, cnvAPISummary(cv))
	}
	return out, nil
}

// cnvAPISummary maps one list row onto the ConversationSummary schema. Both
// list READS (this project-scoped one and ADR-0047's cross-project one)
// answer the same schema, so they map through this one function — the ADR-0065
// members are null exactly when the row carries nothing.
func cnvAPISummary(cv CnvSummary) api.ConversationSummaryView {
	return api.ConversationSummaryView{
		ID:               cv.ID,
		ProjectID:        cv.ProjectID,
		AgentProfileID:   cv.AgentProfileID,
		Title:            cv.Title,
		Status:           cv.Status,
		CreatedBy:        cv.CreatedBy,
		CreatedByDisplay: apiNullString(cv.CreatedByDisplay),
		CreatedAt:        cv.CreatedAt,
		UpdatedAt:        cv.UpdatedAt,
		Control:          cnvAPIControl(cv.Control),
		HasActiveTurn:    cv.HasActiveTurn,
		AgentConnected:   cv.AgentConnected,
		Origin:           cv.Origin,
		RunLink:          cnvAPIRunLink(cv.RunLink),
		RepositoryID:     apiNullString(cv.RepositoryID),
		RepositoryName:   apiNullString(cv.RepositoryName),
		LastAgentLine:    apiNullString(cv.LastAgentLine),
	}
}

// CreateConversation implements api.ConversationStore.
func (a APIConversationStore) CreateConversation(ctx context.Context, c api.Caller, projectID, agentProfileID, title, prompt string) (api.ConversationView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationView{}, err
	}
	cv, err := s.CreateConversation(ctx, prjAPICaller(c), projectID, agentProfileID, title, prompt)
	if err != nil {
		return api.ConversationView{}, cnvAPIErr(err)
	}
	return cnvAPIConversation(cv), nil
}

// GetConversation implements api.ConversationStore.
func (a APIConversationStore) GetConversation(ctx context.Context, c api.Caller, conversationID string) (api.ConversationView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationView{}, err
	}
	cv, err := s.GetConversation(ctx, prjAPICaller(c), conversationID)
	if err != nil {
		return api.ConversationView{}, cnvAPIErr(err)
	}
	return cnvAPIConversation(cv), nil
}

// AuthorizeConversation implements api.ConversationStore.
func (a APIConversationStore) AuthorizeConversation(ctx context.Context, c api.Caller, conversationID string) (string, error) {
	s, err := a.store()
	if err != nil {
		return "", err
	}
	projectID, err := s.AuthorizeConversation(ctx, prjAPICaller(c), conversationID)
	if err != nil {
		return "", cnvAPIErr(err)
	}
	return projectID, nil
}

// RecordDenied implements api.ConversationStore.
func (a APIConversationStore) RecordDenied(ctx context.Context, c api.Caller, conversationID, action string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	return s.RecordConversationDenied(ctx, prjAPICaller(c), conversationID, action)
}

// RecordProjectDenied implements api.ConversationStore for the project-scoped
// conversation routes: a non-member probing /projects/{id}/conversations leaves
// the same kind of audit row a non-member probing the project itself leaves
// (ADR-0014 §3), because the refusal is about the same membership.
func (a APIConversationStore) RecordProjectDenied(ctx context.Context, c api.Caller, projectID, action string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	return (&ProjectStore{Pool: s.Pool}).RecordDenied(ctx, prjAPICaller(c), projectID, action)
}

// PostMessage implements api.ConversationStore. The prompt is echoed here (and
// only here plus getConversation's active_turn): a list response never carries
// transcript text (api/openapi.yaml ConversationTurn.prompt).
func (a APIConversationStore) PostMessage(ctx context.Context, c api.Caller, conversationID, prompt string) (api.ConversationTurnView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationTurnView{}, err
	}
	turn, err := s.PostMessage(ctx, prjAPICaller(c), conversationID, prompt)
	if err != nil {
		return api.ConversationTurnView{}, cnvAPIErr(err)
	}
	return cnvAPITurn(turn, true), nil
}

// TakeControl implements api.ConversationStore.
func (a APIConversationStore) TakeControl(ctx context.Context, c api.Caller, conversationID string, version int) (api.ConversationView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationView{}, err
	}
	cv, err := s.TakeControl(ctx, prjAPICaller(c), conversationID, version)
	if err != nil {
		return api.ConversationView{}, cnvAPIErr(err)
	}
	return cnvAPIConversation(cv), nil
}

// ReturnControl implements api.ConversationStore.
func (a APIConversationStore) ReturnControl(ctx context.Context, c api.Caller, conversationID string, version int) (api.ConversationView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationView{}, err
	}
	cv, err := s.ReturnControl(ctx, prjAPICaller(c), conversationID, version)
	if err != nil {
		return api.ConversationView{}, cnvAPIErr(err)
	}
	return cnvAPIConversation(cv), nil
}

// CancelTurn implements api.ConversationStore.
func (a APIConversationStore) CancelTurn(ctx context.Context, c api.Caller, conversationID string) (api.ConversationTurnView, error) {
	s, err := a.store()
	if err != nil {
		return api.ConversationTurnView{}, err
	}
	turn, err := s.CancelTurn(ctx, prjAPICaller(c), conversationID)
	if err != nil {
		return api.ConversationTurnView{}, cnvAPIErr(err)
	}
	// A cancel response shows who is blocked, not what they asked: the prompt
	// text is transcript content and this route has no reason to repeat it.
	return cnvAPITurn(turn, false), nil
}

// DecidePermission implements api.ConversationStore.
func (a APIConversationStore) DecidePermission(ctx context.Context, c api.Caller, conversationID, requestID, optionID string) (api.PermissionRequestView, error) {
	s, err := a.store()
	if err != nil {
		return api.PermissionRequestView{}, err
	}
	p, err := s.DecidePermission(ctx, prjAPICaller(c), conversationID, requestID, optionID)
	if err != nil {
		return api.PermissionRequestView{}, cnvAPIErr(err)
	}
	return cnvAPIPermission(p), nil
}

// APIConversationStream exposes one conversation's transcript rows, and the
// shared wake-up source, through internal/api's SSE handler.
type APIConversationStream struct {
	S       *CnvStore
	Journal *ProjectStore
	Wakes   *EventWake
}

var (
	_ api.ConversationEventStream = APIConversationStream{}
	_ api.ConversationEventStream = (*APIConversationStream)(nil)
)

// ConversationEventsAfter implements api.ConversationEventStream behind the
// caller's project membership: an invisible conversation is
// ErrConversationNotFound, so neither the stream nor a forged cursor can probe
// it (ADR-0014 Security).
func (a APIConversationStream) ConversationEventsAfter(ctx context.Context, c api.Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if a.Journal == nil || a.Journal.Pool == nil {
		return nil, errors.New("postgres: conversation stream has no pool")
	}
	out, err := a.Journal.VisibleConversationEventsAfter(ctx, prjAPICaller(c), conversationID, afterSeq, limit)
	if err != nil {
		return nil, cnvAPIErr(err)
	}
	return out, nil
}

// Watch implements api.ConversationEventStream. Without a wake-up source the
// handler falls back to polling, which is correct but sleepier.
func (a APIConversationStream) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	if a.Wakes == nil {
		return nil, func() {}, nil
	}
	return a.Wakes.Watch(ctx)
}

// --- conversions --------------------------------------------------------

// apiNullString renders "" as a JSON null, the schema's `["string","null"]`.
func apiNullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func cnvAPIControl(c CnvControl) api.ConversationControlView {
	return api.ConversationControlView{
		Kind:           c.Kind,
		UserID:         apiNullString(c.UserID),
		DisplayName:    apiNullString(c.DisplayName),
		PreviousUserID: apiNullString(c.PreviousUserID),
		Version:        c.Version,
	}
}

func cnvAPIControlPtr(c *CnvControl) *api.ConversationControlView {
	if c == nil {
		return nil
	}
	out := cnvAPIControl(*c)
	return &out
}

// cnvAPITurn converts a turn for the wire. withPrompt is true only on the two
// routes allowed to echo transcript text; a fencing token, a lease deadline and
// a worker-as-arbiter are not in this type at all, so they cannot leak by
// accident (ADR-0016 §8).
func cnvAPITurn(t CnvTurn, withPrompt bool) api.ConversationTurnView {
	out := api.ConversationTurnView{
		ID:                     t.ID,
		ConversationID:         t.ConversationID,
		Status:                 t.Status,
		SubmittedBy:            t.SubmittedBy,
		SubmittedByDisplayName: apiNullString(t.SubmittedByDisplayName),
		SubmittedVia:           t.SubmittedVia,
		WorkerID:               apiNullString(t.WorkerID),
		CancelRequestedAt:      t.CancelRequestedAt,
		StopReason:             t.StopReason,
		CreatedAt:              t.CreatedAt,
		StartedAt:              t.StartedAt,
		FinishedAt:             t.FinishedAt,
	}
	if withPrompt {
		out.Prompt = t.Prompt
	}
	return out
}

func cnvAPITurnPtr(t *CnvTurn, withPrompt bool) *api.ConversationTurnView {
	if t == nil {
		return nil
	}
	out := cnvAPITurn(*t, withPrompt)
	return &out
}

func cnvAPIBinding(b *CnvBinding) *api.AgentSessionBindingView {
	if b == nil {
		return nil
	}
	caps := b.AgentCapabilities
	if len(caps) == 0 {
		caps = []byte(`{}`)
	}
	return &api.AgentSessionBindingView{
		BindingID:         b.ID,
		WorkerID:          b.WorkerID,
		WorkerName:        apiNullString(b.WorkerName),
		LauncherID:        b.LauncherID,
		LauncherVersion:   b.LauncherVersion,
		ACPSessionID:      b.ACPSessionID,
		ProtocolVersion:   b.ProtocolVersion,
		SessionOrigin:     b.SessionOrigin,
		AgentCapabilities: caps,
		ConnectedAt:       b.ConnectedAt,
		LastSeenAt:        b.LastSeenAt,
	}
}

func cnvAPIPermission(p CnvPermission) api.PermissionRequestView {
	options := make([]api.PermissionOptionView, 0, len(p.Options))
	for _, o := range p.Options {
		options = append(options, api.PermissionOptionView{OptionID: o.OptionID, Label: o.Label, Kind: o.Kind})
	}
	if options == nil {
		options = []api.PermissionOptionView{}
	}
	return api.PermissionRequestView{
		ID:               p.ID,
		ConversationID:   p.ConversationID,
		TurnID:           p.TurnID,
		Status:           p.Status,
		ToolTitle:        p.ToolTitle,
		ToolKind:         p.ToolKind,
		ToolCallID:       apiNullString(p.ToolCallID),
		Options:          options,
		DecidedBy:        apiNullString(p.DecidedBy),
		DecidedByKind:    apiNullString(p.DecidedByKind),
		DecidedByPolicy:  apiNullString(p.DecidedByPolicy),
		DecisionOptionID: apiNullString(p.DecisionOptionID),
		RequestedAt:      p.RequestedAt,
		DeadlineAt:       p.DeadlineAt,
		DecidedAt:        p.DecidedAt,
	}
}

func cnvAPIConversation(cv CnvConversation) api.ConversationView {
	pending := make([]api.PermissionRequestView, 0, len(cv.PendingPermissions))
	for _, p := range cv.PendingPermissions {
		pending = append(pending, cnvAPIPermission(p))
	}
	if pending == nil {
		pending = []api.PermissionRequestView{}
	}
	linked := make([]api.ConversationLinkedRunView, 0, len(cv.LinkedRuns))
	for _, l := range cv.LinkedRuns {
		linked = append(linked, api.ConversationLinkedRunView{RunID: l.RunID, CreatedAt: l.CreatedAt})
	}
	return api.ConversationView{
		ID:               cv.ID,
		ProjectID:        cv.ProjectID,
		AgentProfileID:   cv.AgentProfileID,
		AgentProfileName: cv.AgentProfileName,
		LauncherID:       cv.LauncherID,
		Title:            cv.Title,
		Status:           cv.Status,
		CreatedBy:        cv.CreatedBy,
		CreatedByDisplay: apiNullString(cv.CreatedByDisplay),
		CreatedAt:        cv.CreatedAt,
		UpdatedAt:        cv.UpdatedAt,
		Control:          cnvAPIControl(cv.Control),
		// getConversation's active_turn echoes the prompt: the UI must be able to
		// show what is in flight, and this route is one of the two the schema
		// names as allowed to (api/openapi.yaml ConversationTurn.prompt).
		ActiveTurn:         cnvAPITurnPtr(cv.ActiveTurn, true),
		AgentSession:       cnvAPIBinding(cv.Binding),
		PendingPermissions: pending,
		Origin:             cv.Origin,
		RunLink:            cnvAPIRunLink(cv.RunLink),
		LinkedRuns:         linked,
	}
}

// cnvAPIRunLink turns the store's run link into the ConversationRunLink
// schema. RunTitle stays nil: runs has no title column (ADR-0043 left it
// nullable on purpose), and an empty string would read as a real title.
func cnvAPIRunLink(l *CnvRunLink) *api.ConversationRunLinkView {
	if l == nil {
		return nil
	}
	return &api.ConversationRunLinkView{
		RunID:           l.RunID,
		NodeExecutionID: l.NodeExecutionID,
		NodeInstanceKey: l.NodeInstanceKey,
		NodeID:          l.NodeID,
		AttemptID:       l.AttemptID,
		AttemptNumber:   l.AttemptNumber,
	}
}

// --- agent profile writes (ADR-0030) ------------------------------------

// cnvProfileView turns a row into the AgentProfile schema. The three apm columns
// are NULL-or-value in the database and ""-or-value in the row type, so the
// nulls are restored here rather than leaking "" as if it were a target. The
// lock summary is null while the profile has no resolved lock; a locked one
// carries the names-only contents (ADR-0054).
func cnvProfileView(p CnvProfile) api.AgentProfileView {
	null := func(v string) *string {
		if v == "" {
			return nil
		}
		return &v
	}
	view := api.AgentProfileView{
		ID:             p.ID,
		Name:           p.Name,
		LauncherID:     p.LauncherID,
		PermissionMode: p.PermissionMode,
		CreatedAt:      p.CreatedAt,
		Version:        p.Version,
		APMPackageRef:  null(p.APMPackageRef),
		APMTarget:      null(p.APMTarget),
		APMLockDigest:  null(p.APMLockDigest),
	}
	if p.APMLockContents != nil {
		contents := &api.AgentProfileContentsView{
			Skills:       p.APMLockContents.Skills,
			Instructions: p.APMLockContents.Instructions,
			MCPServers:   p.APMLockContents.MCPServers,
			Truncated:    p.APMLockContents.Truncated,
		}
		view.APMContents = contents
	}
	return view
}

// cnvProfileAPIErr translates the profile store's errors into the api sentinels
// the handler maps. A coded refusal keeps its code: it is the part of the answer
// a client switches on, and dropping it here would leave the prose as the only
// machine-readable signal.
func cnvProfileAPIErr(err error) error {
	if err == nil {
		return nil
	}
	var problem *AgentProfileProblem
	if errors.As(err, &problem) {
		return &api.AgentProfileProblemError{Code: problem.Code, Detail: problem.Detail}
	}
	switch {
	case errors.Is(err, ErrProfileNotFound):
		return fmt.Errorf("%w: %w", api.ErrProfileNotFound, err)
	case errors.Is(err, ErrProfileForbidden):
		return fmt.Errorf("%w: %w", api.ErrProfileForbidden, err)
	case errors.Is(err, ErrProfileConflict):
		return fmt.Errorf("%w: %w", api.ErrProfileConflict, err)
	case errors.Is(err, ErrProfileVersionConflict):
		return fmt.Errorf("%w: %w", api.ErrProfileVersionConflict, err)
	case errors.Is(err, ErrProfileValidation):
		return fmt.Errorf("%w: %w", api.ErrProfileValidation, err)
	default:
		return err
	}
}

// CreateAgentProfile implements api.ProfileStore.
func (a APIConversationStore) CreateAgentProfile(ctx context.Context, c api.Caller, in api.AgentProfileCreateInput) (api.AgentProfileView, error) {
	s, err := a.store()
	if err != nil {
		return api.AgentProfileView{}, err
	}
	profile, err := s.CreateAgentProfile(ctx, prjAPICaller(c), in.Name, in.LauncherID)
	if err != nil {
		return api.AgentProfileView{}, cnvProfileAPIErr(err)
	}
	return cnvProfileView(profile), nil
}

// PatchAgentProfileAPM implements api.ProfileStore.
func (a APIConversationStore) PatchAgentProfileAPM(ctx context.Context, c api.Caller, profileID string, in api.AgentProfileAPMPatch) (api.AgentProfileView, error) {
	s, err := a.store()
	if err != nil {
		return api.AgentProfileView{}, err
	}
	profile, err := s.PatchAgentProfileAPM(ctx, prjAPICaller(c), profileID,
		in.APMPackageRef, in.APMTarget, in.APMLockDigest, in.Version)
	if err != nil {
		return api.AgentProfileView{}, cnvProfileAPIErr(err)
	}
	return cnvProfileView(profile), nil
}

// CreateAPMLockRequest implements api.ProfileStore: POST
// /api/v1/agent-profiles/{profileId}/apm/lock. It queues the resolve — the
// worker is the only process that can run it (ADR-0054 Option B) — and the
// caller gets the 202 with the new request's id.
func (a APIConversationStore) CreateAPMLockRequest(ctx context.Context, c api.Caller, profileID string) (api.APMLockRequestView, error) {
	s, err := a.store()
	if err != nil {
		return api.APMLockRequestView{}, err
	}
	req, err := s.CreateAPMLockRequest(ctx, prjAPICaller(c), profileID)
	if err != nil {
		return api.APMLockRequestView{}, cnvProfileAPIErr(err)
	}
	return api.APMLockRequestView{RequestID: req.RequestID, Status: req.Status, Error: req.Error}, nil
}

// GetAPMLockRequest implements api.ProfileStore: GET
// /api/v1/agent-profiles/{profileId}/apm/lock — the latest lock request status.
func (a APIConversationStore) GetAPMLockRequest(ctx context.Context, c api.Caller, profileID string) (api.APMLockRequestView, error) {
	s, err := a.store()
	if err != nil {
		return api.APMLockRequestView{}, err
	}
	req, err := s.GetAPMLockRequest(ctx, prjAPICaller(c), profileID)
	if err != nil {
		return api.APMLockRequestView{}, cnvProfileAPIErr(err)
	}
	return api.APMLockRequestView{RequestID: req.RequestID, Status: req.Status, Error: req.Error}, nil
}

// ListAgentProfileVersions implements api.ProfileStore: GET
// /api/v1/agent-profiles/{profileId}/versions — the profile's version history,
// oldest first (ADR-0058).
func (a APIConversationStore) ListAgentProfileVersions(ctx context.Context, c api.Caller, profileID string) ([]api.AgentProfileVersion, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	items, err := s.ListAgentProfileVersions(ctx, prjAPICaller(c), profileID)
	if err != nil {
		return nil, err
	}
	out := make([]api.AgentProfileVersion, 0, len(items))
	for i := range items {
		out = append(out, api.AgentProfileVersion{
			ProfileID: items[i].ProfileID,
			Version:   items[i].Version,
			Snapshot:  items[i].Snapshot,
			CreatedBy: items[i].CreatedBy,
			CreatedAt: items[i].CreatedAt,
			Note:      items[i].Note,
		})
	}
	return out, nil
}

// GetAgentProfileVersion implements api.ProfileStore: GET
// /api/v1/agent-profiles/{profileId}/versions/{version} — one frozen version
// (ADR-0058).
func (a APIConversationStore) GetAgentProfileVersion(ctx context.Context, c api.Caller, profileID string, version int) (api.AgentProfileVersion, error) {
	s, err := a.store()
	if err != nil {
		return api.AgentProfileVersion{}, err
	}
	v, err := s.GetAgentProfileVersion(ctx, prjAPICaller(c), profileID, version)
	if err != nil {
		return api.AgentProfileVersion{}, err
	}
	return api.AgentProfileVersion{
		ProfileID: v.ProfileID,
		Version:   v.Version,
		Snapshot:  v.Snapshot,
		CreatedBy: v.CreatedBy,
		CreatedAt: v.CreatedAt,
		Note:      v.Note,
	}, nil
}

// RestoreAgentProfileVersion implements api.ProfileStore: POST
// /api/v1/agent-profiles/{profileId}/versions/{version}/restore — "restore version n"
// is a new write whose snapshot equals version n's (ADR-0058). It lands as the
// profile's next version, under the caller's current optimistic token.
func (a APIConversationStore) RestoreAgentProfileVersion(ctx context.Context, c api.Caller, profileID string, version int) (api.AgentProfileView, int, error) {
	s, err := a.store()
	if err != nil {
		return api.AgentProfileView{}, 0, err
	}
	profile, newVersion, err := s.RestoreAgentProfileVersion(ctx, prjAPICaller(c), profileID, version)
	if err != nil {
		return api.AgentProfileView{}, 0, err
	}
	return cnvProfileView(profile), newVersion, nil
}
