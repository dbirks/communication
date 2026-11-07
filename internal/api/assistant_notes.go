package api

// Assistant notes (ADR-0071, docs/design/handoff-repo-chat-nav 3a's
// "ASSISTANT NOTICED" panel and 2e's side-panel note): a store of quiet
// suggestions the assistant generates, per user, that a person can dismiss.
//
// Three routes, all of them reads or one flag:
//
//   - `GET /api/v1/projects/{projectId}/repos/{repositoryId}/notes`: the
//     caller's active notes about one repository of the project.
//   - `GET /api/v1/conversations/{conversationId}/notes`: the same for one
//     thread. Not nested under a project for the reason every other
//     conversation route has: the conversation's own membership is the
//     authorization scope, so a client that knows the thread does not need a
//     project id to ask a question about it.
//   - `POST /api/v1/notes/{noteId}/dismiss`: hide the note. For this user,
//     and only for this user.
//
// What is deliberately absent is the half that writes notes. Step 1 ships the
// store, the contract and dismissal; the generator is step 2 (ADR-0071 Decision 6), so there is no POST here and no tool surface a browser could
// use to write into another user's panel. The store's InsertAssistantNote is
// called by the server's own assistant, never by a route.
//
// Two things make the shape worth an ADR rather than a table and three
// handlers. Dismissal is PER USER, so the row is written for a person and not
// for a scope: a shared note list would let one member's `dismiss` silence
// advice another member needed. And the action is an ALLOWLISTED UNION rather
// than a url or a free-form payload: the assistant is a model that reads text
// it does not control, so what it may propose has to be a closed vocabulary
// the client maps onto a navigation it already has — never a link to follow.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/integrations/github"
)

// The scope vocabulary: what a note is about. `repository` notes are read
// through the repository route (scope_id is a repositories id), `conversation`
// notes through the thread route (scope_id is a conversations id).
const (
	AssistantNoteScopeRepository   = "repository"
	AssistantNoteScopeConversation = "conversation"
)

// The action vocabulary (ADR-0071 § The action union). A note with no action
// is a note that only says something.
const (
	// AssistantNoteActionStartChat opens a new chat in the note's repository
	// with the prompt filled in (design 3a's chat box).
	AssistantNoteActionStartChat = "start_chat"
	// AssistantNoteActionHandOff offers the run-by-hand form (1k) with the
	// named issues filled in.
	AssistantNoteActionHandOff = "hand_off"
	// AssistantNoteActionMakeWorkflow opens the assistant panel on the thread
	// to turn it into a workflow draft (design 2f).
	AssistantNoteActionMakeWorkflow = "make_workflow"
	// AssistantNoteActionOpenRun navigates to a run the note refers to.
	AssistantNoteActionOpenRun = "open_run"
)

// Limits. The tighter of these and the migration's CHECKs is what the surface
// serves; both state the same numbers on purpose, so a row written by an
// older binary cannot be longer than this layer will admit.
const (
	// AssistantNoteTextMaxChars is the one-sentence bound on a note (280, the
	// width of the design's line). It counts characters, not bytes.
	AssistantNoteTextMaxChars = 280
	// AssistantNotesActiveCap is how many active notes one user may hold for
	// one scope: the panel shows three, and the store enforces the same
	// number at insert so the served count is never a truncation.
	AssistantNotesActiveCap = 3
	// AssistantNotePromptMaxChars bounds a start_chat prompt.
	AssistantNotePromptMaxChars = 4000
	// AssistantNoteHandOffMaxIssues bounds a hand_off's issue list to what the
	// run form can fill in at once.
	AssistantNoteHandOffMaxIssues = 20
)

// ErrAssistantNoteNotFound is a note this caller may not act on: no such
// note, one already dismissed or expired, or one that belongs to somebody
// else. The three are the same answer on purpose — `dismiss` must not report
// which of them was wrong, because "not yours" is an existence leak about a
// note another user was shown. The store returns it for an unknown id as
// well, so it is the whole 404.
var ErrAssistantNoteNotFound = errors.New("api: assistant note not found")

// ErrAssistantNoteValidation is a note the store will not write: an over
// long or blank text, a scope outside the vocabulary, an action kind that is
// not one of the four, or an action payload that belongs to a different kind.
// No route can produce it (there is no write route), so it is the generator's
// bug to fix, typed so it stays out of the 500s.
var ErrAssistantNoteValidation = errors.New("api: invalid assistant note")

// ErrAssistantNoteScopeFull is the write guard's refusal: this reader's panel
// already holds AssistantNotesActiveCap active notes, so storing one more
// would push the OLDEST active row out of the table (the cap insert's own
// eviction) — a note the panel may be drawing right now, under a reader whose
// dismiss button is about to 404 against the deleted row (acceptance
// 42339622074 pass-2/pass-5: the per-replica generation cooldown let two
// replicas generate the same (user, scope) and the second generation evicted
// the first). No route answers it: like ErrAssistantNoteValidation it is the
// generator's seam, and a refused write costs the caller nothing — the note
// the guard protects was served before the model was ever asked.
var ErrAssistantNoteScopeFull = errors.New("api: assistant note scope already full")

// AssistantNoteList is the AssistantNoteList schema: the caller's active
// notes, newest first. Fewer than three rows is normal, zero is the common
// case — the panel in the design draws nothing at all when there is nothing
// to say.
type AssistantNoteList struct {
	Notes []AssistantNoteView `json:"notes"`
}

// AssistantNoteView is the AssistantNote schema: one note as this user sees
// it. The scope is echoed so one client-side cache can key notes by (kind,
// id) without re-deriving it from the route that served it.
type AssistantNoteView struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	ScopeKind string `json:"scope_kind"`
	ScopeID   string `json:"scope_id"`
	// Text is the assistant's own sentence, ≤ 280 characters. It is rendered
	// as text and never as markup.
	Text string `json:"text"`
	// Action is the one thing the note offers, or nil when it offers nothing.
	Action    *AssistantNoteAction `json:"action,omitempty"`
	CreatedAt time.Time            `json:"created_at"`
	// ExpiresAt is the deadline the note was generated with, if any; nil is
	// "no deadline". Expired notes are never served, so a served note's
	// deadline is always in the future.
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// AssistantNoteAction is the AssistantNoteAction schema, a discriminated
// union on `kind`: exactly the payload member its kind names is set. The
// client switches on kind and navigates with a route it already owns; it
// never follows a link the note supplied, because the note is model output
// and model output is data, not instructions (ADR-0071 § The action union).
type AssistantNoteAction struct {
	// Kind is one of AssistantNoteAction*.
	Kind string `json:"kind"`
	// Prompt is start_chat's prefill for the new chat.
	Prompt string `json:"prompt,omitempty"`
	// IssueNumbers is hand_off's issue numbers, GitHub-style and positive.
	IssueNumbers []int `json:"issue_numbers,omitempty"`
	// ConversationID is make_workflow's thread — the conversation the draft
	// workflow will be built from, which the client already has in hand most
	// of the time and which an open_run-style handler never resolves.
	ConversationID string `json:"conversation_id,omitempty"`
	// RunID is open_run's run.
	RunID string `json:"run_id,omitempty"`
}

// AssistantNoteInput is a note to write. It is the generator's seam (step 2),
// not a request body: no route accepts one.
type AssistantNoteInput struct {
	ProjectID string
	UserID    string
	ScopeKind string
	ScopeID   string
	Text      string
	Action    *AssistantNoteAction
	ExpiresAt *time.Time
}

// Validate checks the input the way the store will, and returns
// ErrAssistantNoteValidation wrapped with the field that failed. The store
// re-runs it inside the write so no caller can skip it, and a test can pin
// the rules without a database.
func (in AssistantNoteInput) Validate() error {
	switch in.ScopeKind {
	case AssistantNoteScopeRepository, AssistantNoteScopeConversation:
	default:
		return badNote("scope_kind", fmt.Sprintf("must be %q or %q",
			AssistantNoteScopeRepository, AssistantNoteScopeConversation))
	}
	if !validUUIDString(in.ProjectID) {
		return badNote("project_id", "must be a uuid")
	}
	if !validUUIDString(in.ScopeID) {
		return badNote("scope_id", "must be a uuid")
	}
	if !validUUIDString(in.UserID) {
		return badNote("user_id", "must be a uuid")
	}
	if r := utf8.RuneCountInString(in.Text); r == 0 || r > AssistantNoteTextMaxChars {
		return badNote("text", fmt.Sprintf("must be between 1 and %d characters",
			AssistantNoteTextMaxChars))
	}
	if in.Action != nil {
		if err := in.Action.Validate(); err != nil {
			return err
		}
	}
	// A past expires_at is NOT refused here: it is legal, it is simply never
	// served, and a note generated with a deadline that has already gone by
	// is a row the generator can be tested against rather than an error that
	// loses the note.
	return nil
}

// Validate checks the action against the allowlist: a known kind, and only
// the payload that kind owns.
func (a *AssistantNoteAction) Validate() error {
	if a == nil {
		return nil
	}
	switch a.Kind {
	case AssistantNoteActionStartChat:
		if strings.TrimSpace(a.Prompt) == "" {
			return badNote("action.prompt", "start_chat needs a prompt")
		}
		if r := utf8.RuneCountInString(a.Prompt); r > AssistantNotePromptMaxChars {
			return badNote("action.prompt", fmt.Sprintf("must be at most %d characters",
				AssistantNotePromptMaxChars))
		}
		return a.noOtherPayload("prompt")
	case AssistantNoteActionHandOff:
		if len(a.IssueNumbers) == 0 || len(a.IssueNumbers) > AssistantNoteHandOffMaxIssues {
			return badNote("action.issue_numbers", fmt.Sprintf("must hold between 1 and %d numbers",
				AssistantNoteHandOffMaxIssues))
		}
		seen := map[int]bool{}
		for _, n := range a.IssueNumbers {
			if n < 1 {
				return badNote("action.issue_numbers", "issue numbers must be positive")
			}
			if seen[n] {
				return badNote("action.issue_numbers", "issue numbers must be distinct")
			}
			seen[n] = true
		}
		return a.noOtherPayload("issue_numbers")
	case AssistantNoteActionMakeWorkflow:
		if !validUUIDString(a.ConversationID) {
			return badNote("action.conversation_id", "make_workflow needs the conversation's uuid")
		}
		return a.noOtherPayload("conversation_id")
	case AssistantNoteActionOpenRun:
		if !validUUIDString(a.RunID) {
			return badNote("action.run_id", "open_run needs the run's uuid")
		}
		return a.noOtherPayload("run_id")
	default:
		return badNote("action.kind", fmt.Sprintf(
			"must be one of %q, %q, %q or %q",
			AssistantNoteActionStartChat, AssistantNoteActionHandOff,
			AssistantNoteActionMakeWorkflow, AssistantNoteActionOpenRun))
	}
}

// noOtherPayload refuses the members this kind does not own (every member
// except keep is empty), so a model cannot smuggle a prompt into an open_run
// or a second conversation into a hand_off.
func (a *AssistantNoteAction) noOtherPayload(keep string) error {
	members := map[string]string{
		"prompt":          a.Prompt,
		"issue_numbers":   notePresence(len(a.IssueNumbers) > 0),
		"conversation_id": a.ConversationID,
		"run_id":          a.RunID,
	}
	for name, v := range members {
		if name != keep && v != "" {
			return badNote("action."+name, "does not belong to action kind "+a.Kind)
		}
	}
	return nil
}

// notePresence names a slice member "set" or absent, so the payload check
// below has one value type to compare.
func notePresence(set bool) string {
	if set {
		return "set"
	}
	return ""
}

// badNote is ErrAssistantNoteValidation with the offending field named, so a
// generator's test failure says what to fix.
func badNote(field, detail string) error {
	return fmt.Errorf("%w: %s: %s", ErrAssistantNoteValidation, field, detail)
}

// AssistantNotesStore is the datastore the three routes need. Both reads
// authorize the scope inside the store — the repository route's project
// visibility and the thread's own membership — and answer with an empty list
// rather than an error for a caller who may see the scope but holds no notes.
type AssistantNotesStore interface {
	// ListRepositoryNotes returns the caller's active notes for one
	// repository of one project. A project or repository the caller may not
	// see is ErrProjectNotFound.
	ListRepositoryNotes(ctx context.Context, c Caller, projectID, repositoryID string) ([]AssistantNoteView, error)
	// ListConversationNotes returns the caller's active notes for one thread;
	// a thread outside the caller's project is ErrProjectNotFound.
	ListConversationNotes(ctx context.Context, c Caller, conversationID string) ([]AssistantNoteView, error)
	// DismissAssistantNote marks the note dismissed for its owner. A note the
	// caller does not own is ErrAssistantNoteNotFound, and so is one that is
	// gone, dismissed or expired; only the owner's active note changes.
	DismissAssistantNote(ctx context.Context, c Caller, noteID string) error
}

// Every refusal above is audited by the store, not here: the row that says
// "not yours" knows which project the note belonged to and this layer does
// not, and ADR-0014 § 3 wants the denial written against that project. What
// the store cannot resolve (a path id that is not a uuid at all) never reaches
// a row, so there is nothing to audit — the 422 says it plainly instead.

// AssistantNotesTrigger is the generator seam the two list routes call once
// they have answered (ADR-0071 § Decision 6). It is a notification, not a
// request: the caller has already been served, and whatever this does must
// never change that answer or make it wait. A deployment with no assistant
// egress passes nil and the routes are pure reads.
type AssistantNotesTrigger interface {
	// NotesListed reports the notes just served for one scope, so the
	// generator can decide (on its own clock, off this request) whether to
	// produce more. projectID is empty for a conversation scope: the thread
	// names itself and its project is resolved from the thread, never from a
	// path the caller chose.
	NotesListed(ctx context.Context, c Caller, scopeKind, projectID, scopeID string, notes []AssistantNoteView)
}

// AssistantNotesWriter is the generator's store seam: the same
// InsertAssistantNote the server's own assistant calls (there is still no
// write route — ADR-0071 § Decision 5). *postgres.AssistantNotesStore
// implements it; the signature is the store's own.
type AssistantNotesWriter interface {
	InsertAssistantNote(ctx context.Context, in AssistantNoteInput) (AssistantNoteView, error)
}

// The read seams the DATA block is built from. Every one of them is an
// existing route's store method, taken as an interface here because api owns
// its seams and the generator must not see more than the browser can.
type (
	assistantNotesRunReader interface {
		ListProjectRunsFiltered(ctx context.Context, c Caller, projectID string, f RunListFilter) ([]RunSummaryView, error)
	}
	assistantNotesPipelineReader interface {
		ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
	}
	assistantNotesRepoReader interface {
		ListRepositories(ctx context.Context, c Caller, projectID string) ([]RepositoryView, error)
	}
	assistantNotesThreadReader interface {
		GetConversation(ctx context.Context, c Caller, conversationID string) (ConversationView, error)
	}
)

// AssistantNotesGenDeps is step 2's wiring: the model client, the reads the
// factual summary is built from, and the store the notes are written to.
type AssistantNotesGenDeps struct {
	// Broker is the assistant's egress (ADR-0034). nil, or an unconfigured
	// one, means no generation — the routes stay pure reads.
	Broker    *assistant.Broker
	Notes     AssistantNotesWriter
	Runs      assistantNotesRunReader
	Pipelines assistantNotesPipelineReader
	Repos     assistantNotesRepoReader
	// Lister + Credentials are the ADR-0031/0061 issue read, the same pair
	// the repository's issues route uses: open issues live in GitHub, and
	// this generator is not about to invent a mirror.
	Lister      github.IssueLister
	Credentials RepositoryCredentialResolver
	// Threads resolves a conversation's own project (the conversation route
	// has no project id in its path) and Chats is the caller-checked
	// transcript read the chat summary is folded from.
	Threads assistantNotesThreadReader
	Chats   assistant.ChatTranscriptReader
	Logger  *slog.Logger
}

// BuildAssistantNotesGenerator returns the trigger, or nil when this
// deployment cannot generate: no egress triple, no store, or none of the reads.
// A nil trigger is the honest absence, not a failure — the same answer the ask
// route gives with 503 assistant_not_configured, minus the error, because here
// the feature being absent changes nothing the caller asked for.
func BuildAssistantNotesGenerator(deps AssistantNotesGenDeps) AssistantNotesTrigger {
	log := deps.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	// The broker's nil-ness IS the deployment's answer: BuildAssistantBroker
	// returns nil when the egress triple is unset, and a notes turn needs no
	// store handle, only the endpoint (CompleteText is a text-only call).
	if deps.Broker == nil || deps.Notes == nil || deps.Runs == nil ||
		deps.Repos == nil || deps.Threads == nil || deps.Chats == nil {
		return nil
	}
	reader := &assistantNotesReader{
		runs: deps.Runs, pipelines: deps.Pipelines, repos: deps.Repos,
		lister: deps.Lister, creds: deps.Credentials,
		chats: deps.Chats, log: log,
	}
	g := assistant.NewNotesGenerator(assistant.NotesDeps{
		Model:    deps.Broker,
		Reader:   reader,
		Writer:   &assistantNotesWriter{store: deps.Notes},
		Projects: &assistantNotesProjectResolver{threads: deps.Threads},
		// Dismissals is deliberately unwired: honouring it needs a read of
		// dismissed rows, which no route serves and no store method exists
		// for (the generator says so in its own log line).
		Log: log,
	})
	if g == nil {
		return nil
	}
	return &assistantNotesTrigger{gen: g, log: log}
}

// assistantNotesTrigger carries api's Caller and views across the package
// boundary (assistant may not import api, so the conversion lives here).
type assistantNotesTrigger struct {
	gen *assistant.NotesGenerator
	log *slog.Logger
	// store is the routes' own list read, attached by RegisterAssistantNotes
	// (the builder is handed the writer, not the reader, and serve.go wires
	// the two separately). It is what lets the write guard below ask "is this
	// reader's panel already full?" through the same authorized read the
	// browser itself gets an answer from.
	store AssistantNotesStore
}

// noteWriteGuardKey keys the per-generation guard into the context. The
// generation runs on context.WithoutCancel of this request — values survive —
// which is how the guard reaches assistantNotesWriter.WriteNote without the
// assistant package (which may not import api) knowing anything about it.
type noteWriteGuardKey struct{}

// noteWriteGuard is the anti-eviction seam: before the generator stores
// another note, the guard re-reads the caller's ACTIVE notes through the
// routes' own store. At the cap, the write is refused — because inserting a
// fourth note deletes the oldest active one, and that oldest row may be a
// note the panel served and the reader is about to act on. The cooldown that
// normally keeps one (user, scope) to one generation lives in each replica's
// memory (ADR-0071 § Storage, ADR-0077's per-replica stance), so two replicas
// asked at the same moment CAN both finish; this read is the check they
// share.
type noteWriteGuard struct {
	store     AssistantNotesStore
	caller    Caller
	scopeKind string
	projectID string
	scopeID   string
	log       *slog.Logger
}

func (g *noteWriteGuard) logger() *slog.Logger {
	if g != nil && g.log != nil {
		return g.log
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// appliesTo reports whether one write belongs to the (user, scope) this guard
// was scheduled for. A write for any other pair is the generator's bug, not
// this guard's call to make.
func (g *noteWriteGuard) appliesTo(n assistant.NoteWrite) bool {
	return n.UserID == g.caller.UserID &&
		assistantNoteScopeKind(n.ScopeKind) == g.scopeKind &&
		n.ScopeID == g.scopeID
}

// scopeIsFull asks the routes' own read whether the reader already holds the
// panel's cap of active notes. The answer is best-effort by contract: a read
// that fails is reported and the caller proceeds, because losing a note is
// cheaper than losing the panel to a transient store hiccup.
func (g *noteWriteGuard) scopeIsFull(ctx context.Context) (bool, error) {
	var (
		notes []AssistantNoteView
		err   error
	)
	if g.scopeKind == AssistantNoteScopeConversation {
		notes, err = g.store.ListConversationNotes(ctx, g.caller, g.scopeID)
	} else {
		notes, err = g.store.ListRepositoryNotes(ctx, g.caller, g.projectID, g.scopeID)
	}
	if err != nil {
		return false, err
	}
	return len(notes) >= AssistantNotesActiveCap, nil
}

func (t *assistantNotesTrigger) NotesListed(ctx context.Context, c Caller,
	scopeKind, projectID, scopeID string, notes []AssistantNoteView) {
	// The newest served note is the freshness evidence: a scope whose newest
	// row is inside the TTL was generated recently enough. An empty list is
	// the zero time, which is never fresh.
	var newest time.Time
	for _, n := range notes {
		if n.CreatedAt.After(newest) {
			newest = n.CreatedAt
		}
	}
	if t.store != nil {
		// The value survives the generator's context.WithoutCancel — which is
		// exactly the window in which the eviction this guard prevents would
		// otherwise happen.
		ctx = context.WithValue(ctx, noteWriteGuardKey{}, &noteWriteGuard{
			store: t.store, caller: c, scopeKind: scopeKind,
			projectID: projectID, scopeID: scopeID, log: t.log,
		})
	}
	t.gen.NotesListed(ctx, assistant.Caller{UserID: c.UserID,
		OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin},
		assistant.NoteScope{Kind: scopeKind, ProjectID: projectID, ScopeID: scopeID},
		newest, len(notes))
}

// assistantNotesWriter stores one generated note through the store's own
// insert, which re-checks every rule below independently.
type assistantNotesWriter struct {
	store AssistantNotesWriter
}

func (w *assistantNotesWriter) WriteNote(ctx context.Context, n assistant.NoteWrite) error {
	// The write guard, when this generation came from a route that armed one:
	// a new note is never allowed to push a served note out of the reader's
	// panel (ErrAssistantNoteScopeFull's doc names the failure it prevents).
	if g, ok := ctx.Value(noteWriteGuardKey{}).(*noteWriteGuard); ok && g != nil && g.appliesTo(n) {
		full, err := g.scopeIsFull(ctx)
		if err != nil {
			// The guard could not ask. Proceeding costs at most the rare
			// eviction; refusing on a store hiccup would cost the reader
			// their notes, and the insert itself is still the store's one
			// validated statement.
			g.logger().Warn("assistant notes: write guard could not read the scope; storing anyway",
				slog.String("scope_id", n.ScopeID), slog.String("error", err.Error()))
		} else if full {
			return fmt.Errorf("%w: %s %s already holds %d active notes",
				ErrAssistantNoteScopeFull, n.ScopeKind, n.ScopeID, AssistantNotesActiveCap)
		}
	}
	_, err := w.store.InsertAssistantNote(ctx, AssistantNoteInput{
		ProjectID: n.ProjectID,
		UserID:    n.UserID,
		ScopeKind: assistantNoteScopeKind(n.ScopeKind),
		ScopeID:   n.ScopeID,
		Text:      n.Text,
		Action:    assistantNoteAction(n.Action),
		ExpiresAt: &n.ExpiresAt,
	})
	return err
}

func assistantNoteScopeKind(kind string) string {
	switch kind {
	case assistant.NoteScopeRepository:
		return AssistantNoteScopeRepository
	case assistant.NoteScopeConversation:
		return AssistantNoteScopeConversation
	default:
		// The union has no third member; the insert's own validation refuses it.
		return kind
	}
}

func assistantNoteAction(a *assistant.NoteActionDraft) *AssistantNoteAction {
	if a == nil {
		return nil
	}
	return &AssistantNoteAction{
		Kind:           assistantNoteActionKind(a.Kind),
		Prompt:         a.Prompt,
		IssueNumbers:   a.IssueNumbers,
		ConversationID: a.ConversationID,
		RunID:          a.RunID,
	}
}

func assistantNoteActionKind(kind string) string {
	switch kind {
	case assistant.NoteActionStartChat:
		return AssistantNoteActionStartChat
	case assistant.NoteActionHandOff:
		return AssistantNoteActionHandOff
	case assistant.NoteActionMakeWorkflow:
		return AssistantNoteActionMakeWorkflow
	case assistant.NoteActionOpenRun:
		return AssistantNoteActionOpenRun
	default:
		return kind
	}
}

// assistantNotesProjectResolver answers the one question the conversation
// route cannot: which project is this thread in. It is the caller-checked
// conversation read, so a thread the caller cannot see produces no project and
// therefore no notes — the generator never gets further than the panel did.
type assistantNotesProjectResolver struct {
	threads assistantNotesThreadReader
}

func (r *assistantNotesProjectResolver) ProjectOfConversation(ctx context.Context,
	c assistant.Caller, conversationID string) (string, error) {
	view, err := r.threads.GetConversation(ctx, Caller{UserID: c.UserID,
		OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}, conversationID)
	if err != nil {
		return "", err
	}
	return view.ProjectID, nil
}

// assistantNotesReader folds a scope's rows into the generator's factual
// summary. Every read is issued AS THE CALLER; every failure that is not a
// missing scope degrades to "that section says nothing" rather than losing the
// panel's generation, because a spent GitHub budget is not a reason a
// repository cannot have notes.
type assistantNotesReader struct {
	runs      assistantNotesRunReader
	pipelines assistantNotesPipelineReader
	repos     assistantNotesRepoReader
	lister    github.IssueLister
	creds     RepositoryCredentialResolver
	chats     assistant.ChatTranscriptReader
	log       *slog.Logger
}

func (r *assistantNotesReader) ReadRepoFacts(ctx context.Context, c assistant.Caller,
	projectID, repositoryID string) (assistant.NoteRepoFacts, error) {
	caller := apiNotesCaller(c)
	facts := assistant.NoteRepoFacts{}
	repos, err := r.repos.ListRepositories(ctx, caller, projectID)
	if err != nil {
		return assistant.NoteRepoFacts{}, err
	}
	var gitURL string
	// Whether the ROW names a credential, read off the same view the name and
	// the remote came from — the route's own rule (github_issues.go resolves one
	// only `if repo.CredentialSecretID != nil`), and the reason the two reads
	// cannot drift into asking the same tracker a different way.
	var credentialConfigured bool
	for _, repo := range repos {
		if repo.ID == repositoryID {
			facts.Repository = repo.Name
			gitURL = repo.GitURL
			credentialConfigured = repo.CredentialSecretID != nil && *repo.CredentialSecretID != ""
			break
		}
	}
	runs, err := r.runs.ListProjectRunsFiltered(ctx, caller, projectID,
		RunListFilter{RepositoryID: repositoryID})
	if err != nil {
		return assistant.NoteRepoFacts{}, err
	}
	names := map[string]string{}
	if r.pipelines != nil {
		if pipes, perr := r.pipelines.ListPipelines(ctx, caller); perr == nil {
			for _, p := range pipes {
				if p.DisplayName != "" {
					names[p.ID] = p.DisplayName
				} else {
					names[p.ID] = p.Slug
				}
			}
		} else {
			r.log.Warn("assistant notes: workflow names unavailable",
				slog.String("error", perr.Error()))
		}
	}
	for _, run := range runs {
		if len(facts.Runs) >= assistant.NoteGenMaxRuns {
			break
		}
		if run.RepositoryID != nil && *run.RepositoryID != repositoryID {
			continue
		}
		facts.Runs = append(facts.Runs, assistant.NoteRunFact{
			ID:           run.ID,
			Workflow:     names[run.PipelineID],
			Title:        derefString(run.Title),
			Status:       run.Status,
			FailureClass: derefString(run.FailedCause),
			FailingStep:  failingStep(run),
			Age:          noteAge(run.CreatedAt),
		})
	}
	facts.Issues = r.openIssues(ctx, caller, repositoryID, gitURL, credentialConfigured)
	return facts, nil
}

// openIssues reads the repository's open issues where the issues route would:
// the same remote parse, the same per-repository credential, and the same
// silence when any of it fails. A non-GitHub remote is not a note problem — it
// is a repository with no tracker here.
func (r *assistantNotesReader) openIssues(ctx context.Context, c Caller,
	repositoryID, gitURL string, credentialConfigured bool) []assistant.NoteIssueFact {
	if r.lister == nil || strings.TrimSpace(gitURL) == "" {
		return nil
	}
	repo, err := github.ParseRepository(gitURL)
	if err != nil {
		return nil
	}
	// The route's rule, restated here because the generator must not see more
	// of the tracker than the page does: anonymous when the repository names no
	// credential, and NOTHING rather than an anonymous pretence when it names
	// one that will not open (that is a private tracker, and reading it
	// anonymously answers "not found" about issues the reader can see).
	//
	// Asking the resolver unconditionally was its own bug: the store refuses a
	// row that carries no credential — loudly, as the wiring fault it is for a
	// credentialed read — so every public repository without one lost its
	// tracker from the DATA block, and a repository with no runs then had
	// nothing to be about at all. No notes, and no log line to say why.
	token := ""
	if credentialConfigured {
		if r.creds == nil {
			r.log.Warn("assistant notes: this deployment cannot resolve the issue credential",
				slog.String("repository_id", repositoryID))
			return nil
		}
		got, cerr := r.creds.ResolveRepositoryCredential(ctx, repositoryID, ghConsumerIssueRead, c.UserID)
		if cerr != nil {
			r.log.Warn("assistant notes: issue credential unavailable",
				slog.String("repository_id", repositoryID), slog.String("error", cerr.Error()))
			return nil
		}
		token = got
	}
	issues, err := r.lister.ListIssues(ctx, repo, github.IssueQuery{State: github.StateOpen}, token)
	if err != nil {
		r.log.Warn("assistant notes: open issues unavailable",
			slog.String("repository_id", repositoryID), slog.String("error", err.Error()))
		return nil
	}
	out := make([]assistant.NoteIssueFact, 0, assistant.NoteGenMaxIssues)
	for _, is := range issues {
		if len(out) >= assistant.NoteGenMaxIssues {
			break
		}
		if is.Number < 1 {
			continue
		}
		out = append(out, assistant.NoteIssueFact{Number: is.Number, Title: is.Title})
	}
	return out
}

func (r *assistantNotesReader) ReadChatFacts(ctx context.Context, c assistant.Caller,
	conversationID string) (assistant.NoteChatFacts, error) {
	transcript, err := r.chats.ReadChatTranscript(ctx, c, conversationID)
	if err != nil {
		return assistant.NoteChatFacts{}, err
	}
	facts := assistant.NoteChatFacts{
		ConversationID: conversationID,
		Conversation:   transcript.Title,
		Repository:     transcript.RepoName,
	}
	for _, line := range transcript.Lines {
		if len(facts.Lines) >= assistant.NoteGenMaxLines {
			break
		}
		facts.Lines = append(facts.Lines, assistant.ChatLine{Author: line.Author, Text: line.Text})
	}
	return facts, nil
}

// failingStep names the run's first failed top-level step, from the progress
// strip the run list already carries (ADR-0070) — never a per-run node read, so
// one summary is a bounded number of statements whatever the repository holds.
func failingStep(run RunSummaryView) string {
	if run.Progress == nil {
		return ""
	}
	for _, step := range run.Progress.Steps {
		if step.State == RunStepFailed {
			return step.NodeID
		}
	}
	return ""
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// apiNotesCaller carries a caller across the assistant boundary (the two
// Caller types are the same three fields; internal/assistant may not import
// this package, so it has its own copy).
func apiNotesCaller(c assistant.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// noteAge renders how long ago a run began, coarsely: the model needs "3h", not
// a timestamp it cannot compare against its own clock.
func noteAge(at time.Time) string {
	if at.IsZero() {
		return "unknown"
	}
	d := time.Since(at)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// RegisterAssistantNotes mounts the three ADR-0071 routes. `gen` is optional:
// with a trigger, a GET whose scope has no fresh generation schedules one in
// the background (and still answers immediately with what is stored); without
// one, the routes are the pure reads step 1 shipped.
func RegisterAssistantNotes(s *Server, store AssistantNotesStore, gen ...AssistantNotesTrigger) {
	h := &assistantNoteHandlers{store: store, srv: s}
	for _, g := range gen {
		if g != nil {
			h.gen = g
			break
		}
	}
	// The generator's builder never sees the routes' store (serve.go hands
	// the two separately), so the write guard's read is attached here: an
	// api trigger registered without this would generate with the guard
	// disarmed, which is the pre-fix behaviour the seam exists to end.
	if bt, ok := h.gen.(*assistantNotesTrigger); ok {
		bt.store = store
	}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/repos/{repositoryId}/notes",
		http.HandlerFunc(h.listRepoNotes))
	s.HandleAuthed("GET /api/v1/conversations/{conversationId}/notes",
		http.HandlerFunc(h.listConversationNotes))
	s.HandleAuthed("POST /api/v1/notes/{noteId}/dismiss",
		http.HandlerFunc(h.dismiss))
}

type assistantNoteHandlers struct {
	store AssistantNotesStore
	srv   *Server
	// gen is nil on a deployment with no assistant egress.
	gen AssistantNotesTrigger
}

func (h *assistantNoteHandlers) listRepoNotes(w http.ResponseWriter, r *http.Request) {
	const action = "assistant_note.repository.list"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	projectID, repoID := r.PathValue("projectId"), r.PathValue("repositoryId")
	if !validUUIDString(projectID) {
		assistantNoteInvalid(w, "projectId must be a uuid.")
		return
	}
	if !validUUIDString(repoID) {
		assistantNoteInvalid(w, "repositoryId must be a uuid.")
		return
	}
	notes, err := h.store.ListRepositoryNotes(r.Context(), c, projectID, repoID)
	if err != nil {
		h.fail(w, r, projectID, action, err)
		return
	}
	h.serve(w, notes)
	h.trigger(r.Context(), c, AssistantNoteScopeRepository, projectID, repoID, notes)
}

func (h *assistantNoteHandlers) listConversationNotes(w http.ResponseWriter, r *http.Request) {
	const action = "assistant_note.conversation.list"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	convID := r.PathValue("conversationId")
	if !validUUIDString(convID) {
		assistantNoteInvalid(w, "conversationId must be a uuid.")
		return
	}
	notes, err := h.store.ListConversationNotes(r.Context(), c, convID)
	if err != nil {
		// The thread names its own project, which is the id the store audited
		// the refusal against; the handler has nothing to add.
		h.fail(w, r, "", action, err)
		return
	}
	h.serve(w, notes)
	// No project id travels: the conversation route's own rule is that the
	// thread is the scope, so the generator resolves the project from the
	// thread rather than from anything the caller put in a path.
	h.trigger(r.Context(), c, AssistantNoteScopeConversation, "", convID, notes)
}

func (h *assistantNoteHandlers) dismiss(w http.ResponseWriter, r *http.Request) {
	const action = "assistant_note.dismiss"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	noteID := r.PathValue("noteId")
	if !validUUIDString(noteID) {
		assistantNoteInvalid(w, "noteId must be a uuid.")
		return
	}
	if err := h.store.DismissAssistantNote(r.Context(), c, noteID); err != nil {
		if errors.Is(err, ErrAssistantNoteNotFound) {
			// The four cases are one answer, and the store has already
			// audited the only one of them that names a project: an attempt on
			// a note that exists and is not the caller's. A guess at an id that
			// was never a note writes nothing, because there is no project to
			// audit against and a caller-chosen uuid does not belong in the
			// ledger.
			WriteProblem(w, http.StatusNotFound, "Not Found",
				"No such note, or it is not yours to dismiss.")
			return
		}
		h.fail(w, r, "", action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// trigger hands the served answer to the generator. It runs after the response
// is written and cannot change it: the GET never blocks on a model, and a
// generation that goes wrong costs the caller nothing (ADR-0071 § Decision 6).
func (h *assistantNoteHandlers) trigger(ctx context.Context, c Caller,
	scopeKind, projectID, scopeID string, notes []AssistantNoteView) {
	if h.gen == nil {
		return
	}
	h.gen.NotesListed(ctx, c, scopeKind, projectID, scopeID, notes)
}

// serve answers the two list routes. `notes` is always an array, never null:
// the panel's own rule is "render nothing when there is nothing", and a
// client should not have to distinguish an absent member from an empty one.
func (h *assistantNoteHandlers) serve(w http.ResponseWriter, notes []AssistantNoteView) {
	if notes == nil {
		notes = []AssistantNoteView{}
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, AssistantNoteList{Notes: notes})
}

func (h *assistantNoteHandlers) caller(w http.ResponseWriter, r *http.Request,
	action string) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.srv.logger.ErrorContext(r.Context(), "assistant notes: no principal in context",
			"action", action)
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"No principal in context.")
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// fail maps a store error onto the contract: a scope the caller may not read
// is the 404 every other project route gives (the store wrote the audit row),
// and anything else is a 500 whose only handle is the request id. The 422 for
// a malformed path id never reaches here — it is refused before the store is
// asked, which is why no `Caller` crosses into this function: nothing on this
// surface decides authorization here.
func (h *assistantNoteHandlers) fail(w http.ResponseWriter, r *http.Request,
	projectID, action string, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound), errors.Is(err, ErrAssistantNoteNotFound):
		// The store already wrote the ADR-0014 § 3 denial against the project
		// it resolved the scope in.
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such notes scope.")
	default:
		h.srv.logger.ErrorContext(r.Context(), "assistant notes: store failure",
			"action", action,
			"project_id", projectID,
			"request_id", RequestIDFrom(r),
			"error", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The server could not complete the request. Use the request id when reporting it.")
	}
}

// assistantNoteInvalid is the 422 a malformed path id gets.
func assistantNoteInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}
