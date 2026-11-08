package api

// Catch up (ADR-0078, the design handoff's "Catch up" page): the HTTP surface
// over the store an engineer reads when they come back — "what did the agents
// do while I was away?".
//
// Seven routes, and every one of them is scoped by project membership inside
// the store's own statement:
//
//   - `GET  /api/v1/catch-up/items`: the caller's work items, unseen by
//     default, across the projects they name (default: all of them).
//   - `GET  /api/v1/catch-up/items/{itemId}`: one item, its latest tour with a
//     per-stop `seen` flag for THIS reader, the headers of every version, the
//     seen roster and the version this reader last recorded.
//   - `POST /api/v1/catch-up/items/{itemId}/seen`: "I read these beats".
//   - `POST /api/v1/catch-up/seen-all`: "catch me up on everything here".
//   - `POST /api/v1/catch-up/visits` / `GET .../visits/suggestion`: the visit
//     stamp, and the window inferred from the stamps.
//   - `GET  /api/v1/catch-up/recap`: the latest saved narrative, if any.
//   - `POST /api/v1/catch-up/items/{itemId}/stops/{stopId}/reply`: an answer to
//     a beat's question, stored and posted as an ordinary message.
//
// What is deliberately absent is the half that WRITES tours and recaps. The
// generator (ADR-0078 § Migration, the next task) is the server's own assistant
// behind ADR-0034's egress, so there is no `POST /catch-up/recap` here for a
// browser to ask for a model call, and no route at all that could put words
// into a shared tour. A `GET` of a page with no generator behind it is an empty
// list, not a stub narrative.
//
// Two rules this layer keeps for itself, because they are contract rather than
// data:
//
//   - existence never leaks. A work item in a project the caller is not in is
//     the same 404 as a deleted one (ADR-0014 § 3, and the notes' convention),
//     and there is no 403 anywhere on this surface for a private item;
//   - a decision reply is TEXT handed to a conversation, not a gate. It is
//     stored through the catch-up store and then posted through the very
//     `PostMessage` the messages route uses, so the conversation's controller,
//     its one-active-turn rule and its audit stay in one place — a busy agent
//     is the same 409 the thread's own route answers (ADR-0078 § Decision 4).

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Limits this layer enforces before a store is asked. Each number is the same
// one migration 00028 CHECKs and internal/domain/catchup.go states; restating
// it here is what turns "too long" into a 422 naming the field rather than a
// database error surfacing as a 500.
const (
	// CatchUpReplyMaxChars is the length bound on one decision reply — the same
	// 2 000 the catchup_decision_replies CHECK puts on the row, so a reply that
	// is storable is a reply this layer admits.
	CatchUpReplyMaxChars = 2000
	// CatchUpStopIDMaxChars bounds a stop id in a path or a seen payload; stop
	// ids are model-chosen strings, which is why they are not uuids.
	CatchUpStopIDMaxChars = 128
	// CatchUpStopsMax bounds a seen payload the way a tour is bounded: naming
	// more beats than a tour can hold is a client mistake, not a request.
	CatchUpStopsMax = 24
	// CatchUpProjectsMax bounds the projects one request may name. It is a
	// request-shape bound, not a permission: naming a project the caller is not
	// in narrows the result and can never widen it (ADR-0078 § Decision 8).
	CatchUpProjectsMax = 50
)

// The sentinels this layer maps. They mirror internal/domain's so the postgres
// adapter can hand back the same fact with the HTTP layer's own type, the way
// ErrAssistantNoteNotFound mirrors the store's note-not-found.
var (
	// ErrCatchUpNotFound is the one answer for no such work item, a tour that
	// was never written, and an item in a project the caller may not see —
	// ADR-0014 § 3's rule that a refusal must not confirm existence.
	ErrCatchUpNotFound = errors.New("api: catch-up work item not found")
	// ErrCatchUpValidation is a payload the store will not write: a reply with
	// no text, a seen call with no beats, a malformed uuid it still refused.
	ErrCatchUpValidation = errors.New("api: invalid catch-up request")
)

// --- views (api/openapi.yaml schemas) ----------------------------------

// CatchUpProjectChip is the project a piece of work lives in, as the page draws
// it. `color` is never empty: a project whose `color` column is NULL is served
// with the deterministic palette pick by project id (domain.CatchUpProjectColor),
// so a chip cannot shuffle between replicas or after a rename, and a chosen
// colour is never overridden.
type CatchUpProjectChip struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// CatchUpRefsView is what the work touched. These are the assistant's own
// claims about the repository, and this deployment does not sync with GitHub
// (ADR-0078 § Decision 6): nothing here promises the PR is still open.
type CatchUpRefsView struct {
	IssueNumbers []int    `json:"issue_numbers,omitempty"`
	PRNumbers    []int    `json:"pr_numbers,omitempty"`
	CommitSHAs   []string `json:"commit_shas,omitempty"`
	RunIDs       []string `json:"run_ids,omitempty"`
}

// CatchUpListItemView is one row of the list. `updated` is the badge that means
// "the story moved since you read it" (the reader has a seen row at an OLDER
// tour version), which is why it cannot be derived from `unseen_stops` alone;
// `importance` is the top importance of the beats in the latest tour, and
// ranking is shared — the same for every member of the project.
type CatchUpListItemView struct {
	ID          string             `json:"id"`
	Project     CatchUpProjectChip `json:"project"`
	Shape       string             `json:"shape"`
	Title       string             `json:"title"`
	Summary     string             `json:"summary"`
	Resolution  string             `json:"resolution"`
	Refs        CatchUpRefsView    `json:"refs"`
	Updated     bool               `json:"updated"`
	UnseenStops int                `json:"unseen_stops"`
	TotalStops  int                `json:"total_stops"`
	Importance  string             `json:"importance"`
	UpdatedAt   time.Time          `json:"updated_at"`
	CreatedAt   time.Time          `json:"created_at"`
}

// CatchUpItemList is the CatchUpItemList schema. `items` is always an array;
// `total_unseen` counts the items still owed (which is `len(items)` unless the
// caller asked for `include_seen`, and is the badge the navigation draws) and
// `oldest_unseen_at` is how far back the backlog reaches — null when there is
// none, because "nothing is waiting" and "the oldest thing is 4 hours old" are
// different answers.
type CatchUpItemList struct {
	Items          []CatchUpListItemView `json:"items"`
	TotalUnseen    int                   `json:"total_unseen"`
	OldestUnseenAt *time.Time            `json:"oldest_unseen_at"`
}

// CatchUpStopView is one beat of the story, with the two facts THIS reader
// needs beside it: `added_in_version`, so a beat the story grew last week is
// tellable from one it grew today, and `seen`, which is the store's rule
// rendered (a beat is read when this reader has a seen row whose recorded tour
// version is at least the version that introduced it).
//
// `evidence` is the model's own object with the server's `type` winning; no
// member of it is a url this layer follows, and nothing here re-reads a
// narrative as an instruction (ADR-0078 § Decision 7).
type CatchUpStopView struct {
	ID             string               `json:"id"`
	Title          string               `json:"title"`
	Narrative      string               `json:"narrative"`
	Kind           string               `json:"kind,omitempty"`
	Importance     string               `json:"importance"`
	AddedInVersion int                  `json:"added_in_version"`
	Seen           bool                 `json:"seen"`
	Evidence       []map[string]any     `json:"evidence,omitempty"`
	Decision       *CatchUpDecisionView `json:"decision,omitempty"`
}

// CatchUpDecisionView is the one thing a beat may ask. Its options are strings,
// not actions, and answering it authorizes nothing — which is exactly why this
// is not an approval gate (ADR-0078 § Decision 4).
type CatchUpDecisionView struct {
	Prompt    string   `json:"prompt"`
	Options   []string `json:"options"`
	AllowText bool     `json:"allow_text"`
}

// CatchUpTourView is the newest version of a story.
type CatchUpTourView struct {
	Version   int               `json:"version"`
	Reason    string            `json:"reason"`
	CreatedAt time.Time         `json:"created_at"`
	Stops     []CatchUpStopView `json:"stops"`
}

// CatchUpTourHeaderView is one version of a tour without its beats: the "why
// did this change" line beside an UPDATED badge.
type CatchUpTourHeaderView struct {
	Version   int       `json:"version"`
	Reason    string    `json:"reason"`
	StopCount int       `json:"stop_count"`
	CreatedAt time.Time `json:"created_at"`
}

// CatchUpSeenByView is one name in the "2 of 4 have seen this" roster: readers
// who have finished the LATEST version. It is a presence indicator inside a
// project whose members already see each other's commits and threads, and it
// lists readers rather than non-readers (ADR-0078 § Security/privacy).
type CatchUpSeenByView struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	SeenAt time.Time `json:"seen_at"`
}

// CatchUpItemView is one work item as its reader sees it. `latest` is null for
// an item whose tour has not been written — it exists, and it has no story to
// read — and `you_saw_version` is null for a reader who has never marked a beat,
// which is what makes "new to you" and "UPDATED" two different badges.
type CatchUpItemView struct {
	ID             string                  `json:"id"`
	Project        CatchUpProjectChip      `json:"project"`
	Shape          string                  `json:"shape"`
	Title          string                  `json:"title"`
	Summary        string                  `json:"summary"`
	Resolution     string                  `json:"resolution"`
	Refs           CatchUpRefsView         `json:"refs"`
	SourceRunID    *string                 `json:"source_run_id"`
	ConversationID *string                 `json:"conversation_id"`
	Latest         *CatchUpTourView        `json:"latest"`
	History        []CatchUpTourHeaderView `json:"history"`
	SeenBy         []CatchUpSeenByView     `json:"seen_by"`
	YouSawVersion  *int                    `json:"you_saw_version"`
	UnseenStops    int                     `json:"unseen_stops"`
	TotalStops     int                     `json:"total_stops"`
	CreatedAt      time.Time               `json:"created_at"`
	UpdatedAt      time.Time               `json:"updated_at"`
}

// CatchUpRecapView is the cached per-visit narrative. It is the generator's
// saved answer, not a route that asks a model: generation is the next task.
type CatchUpRecapView struct {
	Text       string    `json:"text"`
	WrittenAt  time.Time `json:"written_at"`
	Window     string    `json:"window"`
	ProjectIDs []string  `json:"project_ids"`
}

// CatchUpVisitSuggestion is the window the page should open with, inferred from
// this reader's own visit history rather than a hard-coded 24 hours. `window`
// is null for a reader with fewer than two visits — two visits are the first
// moment at which an interval exists.
type CatchUpVisitSuggestion struct {
	Window        *string `json:"window"`
	VisitsPerWeek float64 `json:"visits_per_week"`
}

// CatchUpSeenBody is the `seen` request: which tour version the reader was
// looking at, and which beats of it they actually looked at. The store reads
// the ids out of that version rather than trusting this list, so an id that is
// not in it marks nothing.
type CatchUpSeenBody struct {
	Version int      `json:"version"`
	StopIDs []string `json:"stop_ids"`
}

// CatchUpSeenAllBody is the `seen-all` request. No `projects` member is "every
// project I belong to", not "everything".
type CatchUpSeenAllBody struct {
	Projects []string `json:"projects,omitempty"`
}

// CatchUpReplyBody is one answer to a beat's question: the chosen option or the
// text the reader typed. Both are the same string to this layer.
type CatchUpReplyBody struct {
	Text string `json:"text"`
}

// CatchUpReplyResult is the 202 of a decision reply. `conversation_id` and
// `turn_id` are null when the work has no thread to answer into: the reply is
// stored and goes nowhere, which the surface must show as a dead end rather
// than as "sent" (ADR-0078 § Consequences).
type CatchUpReplyResult struct {
	ReplyID        string  `json:"reply_id"`
	ConversationID *string `json:"conversation_id"`
	TurnID         *string `json:"turn_id"`
}

// --- the store seams the handlers call ---------------------------------

// CatchUpListFilter is the parsed `GET /catch-up/items` query. A nil `Since` is
// no lower bound and an empty `ProjectIDs` is "every project I belong to"; both
// are the store's own NULL-vs-empty-array distinction, which is why the parse
// keeps them apart instead of collapsing them.
type CatchUpListFilter struct {
	ProjectIDs  []string
	Since       *time.Time
	IncludeSeen bool
}

// CatchUpReplyRecord is the stored reply as the route reads it back.
// ConversationID is the store's copy — taken from the work item at write time,
// never from the caller — and it is the only reason this route dares to post
// (ADR-0078 § Decision 4).
type CatchUpReplyRecord struct {
	ID             string
	StopID         string
	Text           string
	ConversationID *string
}

// CatchUpStore is the catch-up surface's datastore. Every method authorizes the
// caller's own project membership inside its own statement and answers
// ErrCatchUpNotFound for a work item the caller may not be told about; the
// refusals are audited where the refusal is the only row that knows which
// project it refused — the store, not this layer.
type CatchUpStore interface {
	// ListCatchUpItems is the caller's page: their unseen work items across the
	// projects they name (intersected with what they may see).
	ListCatchUpItems(ctx context.Context, c Caller, f CatchUpListFilter) (CatchUpItemList, error)
	// GetCatchUpItem is one item with its latest tour (per-stop seen flags for
	// this caller), its version history, its seen roster and the version this
	// reader last recorded.
	GetCatchUpItem(ctx context.Context, c Caller, itemID string) (CatchUpItemView, error)
	// MarkCatchUpStopsSeen records that this caller viewed these beats of this
	// tour version. Nothing at all happens for a version or an id that is not
	// there, which is ErrCatchUpNotFound rather than a silent success.
	MarkCatchUpStopsSeen(ctx context.Context, c Caller, itemID string, version int, stopIDs []string) error
	// MarkAllCatchUpSeen catches this caller up on these projects and reports
	// nothing but its own failure: the button's answer is 204 either way.
	MarkAllCatchUpSeen(ctx context.Context, c Caller, projectIDs []string) error
	// RecordCatchUpVisit stamps one visit. A visit is a fact about a reader, so
	// it needs no project and no membership.
	RecordCatchUpVisit(ctx context.Context, c Caller) error
	// RecentCatchUpVisits returns this caller's visits, newest first, bounded.
	RecentCatchUpVisits(ctx context.Context, c Caller) ([]time.Time, error)
	// LatestCatchUpRecap is this caller's newest saved recap whose project
	// coverage touches the named projects (empty = any recap), or
	// ErrCatchUpNotFound when there is no such row.
	LatestCatchUpRecap(ctx context.Context, c Caller, projectIDs []string) (CatchUpRecapView, error)
	// CatchUpStopQuestion is the one thing the reply route needs from a beat:
	// the question its newest version asks, or ErrCatchUpNotFound for no such
	// item, no such beat, or a beat that asked nothing.
	CatchUpStopQuestion(ctx context.Context, c Caller, itemID, stopID string) (*CatchUpDecisionView, error)
	// InsertCatchUpDecisionReply stores the text on a stop that asked, and hands
	// back the conversation it belongs to. It does NOT post it.
	InsertCatchUpDecisionReply(ctx context.Context, c Caller, itemID, stopID, text string) (CatchUpReplyRecord, error)
}

// CatchUpConversationPoster is the half of a decision reply that reaches the
// agent runtime: exactly the `PostMessage` the messages route calls
// (internal/api/conversations.go), taken as its own seam rather than the whole
// ConversationStore so this file cannot accidentally re-implement the
// conversation's rules. Controller lock, one active turn, permission mode and
// audit stay behind it, and its errors are mapped the way cnvHandlers.fail
// maps them below.
type CatchUpConversationPoster interface {
	PostMessage(ctx context.Context, c Caller, conversationID, prompt string) (ConversationTurnView, error)
}

// --- registration -----------------------------------------------------

// RegisterCatchUp mounts the ADR-0078 surface. `poster` may be nil on a
// deployment with no conversation store wired, which is not this repository's
// shape but is the honest degradation: a reply is then stored and answered
// 202 with a null conversation, the same dead end a work item with no thread
// already has.
func RegisterCatchUp(s *Server, store CatchUpStore, poster CatchUpConversationPoster) {
	h := &catchUpHandlers{store: store, messages: poster, srv: s}
	s.HandleAuthed("GET /api/v1/catch-up/items", http.HandlerFunc(h.listItems))
	s.HandleAuthed("GET /api/v1/catch-up/items/{itemId}", http.HandlerFunc(h.getItem))
	s.HandleAuthed("POST /api/v1/catch-up/items/{itemId}/seen", http.HandlerFunc(h.markSeen))
	s.HandleAuthed("POST /api/v1/catch-up/seen-all", http.HandlerFunc(h.markAllSeen))
	s.HandleAuthed("POST /api/v1/catch-up/visits", http.HandlerFunc(h.recordVisit))
	s.HandleAuthed("GET /api/v1/catch-up/visits/suggestion", http.HandlerFunc(h.visitSuggestion))
	s.HandleAuthed("GET /api/v1/catch-up/recap", http.HandlerFunc(h.recap))
	s.HandleAuthed("POST /api/v1/catch-up/items/{itemId}/stops/{stopId}/reply",
		http.HandlerFunc(h.postReply))
}

type catchUpHandlers struct {
	store    CatchUpStore
	messages CatchUpConversationPoster
	srv      *Server
}

// --- handlers ---------------------------------------------------------

func (h *catchUpHandlers) listItems(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.items.list"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	f, ok := h.parseListFilter(w, r)
	if !ok {
		return
	}
	list, err := h.store.ListCatchUpItems(r.Context(), c, f)
	if err != nil {
		h.fail(w, r, action, err)
		return
	}
	if list.Items == nil {
		list.Items = []CatchUpListItemView{}
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, list)
}

func (h *catchUpHandlers) getItem(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.item.read"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	itemID := r.PathValue("itemId")
	if !validUUIDString(itemID) {
		catchUpInvalid(w, "itemId must be a uuid.")
		return
	}
	item, err := h.store.GetCatchUpItem(r.Context(), c, itemID)
	if err != nil {
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, item)
}

func (h *catchUpHandlers) markSeen(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.item.seen"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	itemID := r.PathValue("itemId")
	if !validUUIDString(itemID) {
		catchUpInvalid(w, "itemId must be a uuid.")
		return
	}
	var body CatchUpSeenBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Version < 1 {
		catchUpInvalid(w, "version must be 1 or higher (the tour version you were reading).")
		return
	}
	ids, ok := h.parseStopIDs(w, body.StopIDs)
	if !ok {
		return
	}
	if err := h.store.MarkCatchUpStopsSeen(r.Context(), c, itemID, body.Version, ids); err != nil {
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *catchUpHandlers) markAllSeen(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.seen.all"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	// An absent body is "everything I belong to", which is the button's own
	// meaning; a body that is there must be a JSON object it can read.
	var body CatchUpSeenAllBody
	if err := DecodeJSON(r, &body); err != nil && !errors.Is(err, ErrBodyEmpty) {
		h.badRequest(w, r, err)
		return
	}
	projects, ok := h.parseProjectIDs(w, body.Projects, "projects")
	if !ok {
		return
	}
	if err := h.store.MarkAllCatchUpSeen(r.Context(), c, projects); err != nil {
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *catchUpHandlers) recordVisit(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.visit.record"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	if err := h.store.RecordCatchUpVisit(r.Context(), c); err != nil {
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *catchUpHandlers) visitSuggestion(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.visit.suggestion"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	visits, err := h.store.RecentCatchUpVisits(r.Context(), c)
	if err != nil {
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, catchUpSuggestion(visits, time.Now()))
}

func (h *catchUpHandlers) recap(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.recap.read"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	// A recap is one row per reader (ADR-0078 § Decision 1) whose `project_ids`
	// say what it covered, so `projects` here is an OVERLAP filter rather than
	// a scope: the newest recap that touches any project on the reader's screen.
	// A reader who names a project they are not in is not told — the answer is
	// the same as the answer for "no recap that covers these yet".
	projects, ok := h.parseProjectIDs(w, r.URL.Query()["projects"], "projects")
	if !ok {
		return
	}
	recap, err := h.store.LatestCatchUpRecap(r.Context(), c, projects)
	if err != nil {
		if errors.Is(err, ErrCatchUpNotFound) {
			// A problem, not an empty string: the page has to tell "the
			// generator has never written you a recap" apart from a recap that
			// says nothing.
			WriteProblem(w, http.StatusNotFound, "Not Found",
				"No saved recap for you yet.")
			return
		}
		h.fail(w, r, action, err)
		return
	}
	if recap.ProjectIDs == nil {
		recap.ProjectIDs = []string{}
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, recap)
}

// postReply answers a beat's question. The text is stored, then handed —
// unchanged — to the conversation the WORK ITEM names. Order matters: the
// record is written first so a thread that refuses (a busy agent, a lost
// controller) still leaves the answer the human gave, which is a fact about
// this project whether or not an agent ever read it.
func (h *catchUpHandlers) postReply(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.stop.reply"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	itemID, stopID := r.PathValue("itemId"), r.PathValue("stopId")
	if !validUUIDString(itemID) {
		catchUpInvalid(w, "itemId must be a uuid.")
		return
	}
	stopID = strings.TrimSpace(stopID)
	if n := utf8.RuneCountInString(stopID); n == 0 || n > CatchUpStopIDMaxChars {
		catchUpInvalid(w, fmt.Sprintf("stopId must be between 1 and %d characters.",
			CatchUpStopIDMaxChars))
		return
	}
	var body CatchUpReplyBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	text := strings.TrimSpace(body.Text)
	if n := utf8.RuneCountInString(text); n == 0 || n > CatchUpReplyMaxChars {
		catchUpInvalid(w, fmt.Sprintf("text must be between 1 and %d characters.",
			CatchUpReplyMaxChars))
		return
	}

	// The stop must be in the item's newest tour and must have asked something.
	// A caller who cannot see the item, a tour with no such beat and a beat with
	// no decision are one 404: none of them is an answer this route may give,
	// and none of them confirms that the item exists.
	decision, err := h.store.CatchUpStopQuestion(r.Context(), c, itemID, stopID)
	if err != nil {
		h.fail(w, r, action, err)
		return
	}
	if decision == nil {
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"No such question on this work item.")
		return
	}
	// A question with no free-text box only takes one of its own answers; that
	// is the model's rule for the beat, not this layer's preference, and it is
	// checked BEFORE the write so a refused reply stores nothing.
	if !decision.AllowText && !catchUpIsOption(decision.Options, text) {
		catchUpInvalid(w, "text must be one of this question's options.")
		return
	}

	record, err := h.store.InsertCatchUpDecisionReply(r.Context(), c, itemID, stopID, text)
	if err != nil {
		h.fail(w, r, action, err)
		return
	}
	out := CatchUpReplyResult{ReplyID: record.ID, ConversationID: record.ConversationID}
	if record.ConversationID != nil && h.messages != nil {
		turn, err := h.messages.PostMessage(r.Context(), c, *record.ConversationID, record.Text)
		if err != nil {
			// The reply row stands; the delivery did not go out. The page says
			// so rather than reporting a send that never happened.
			h.failMessage(w, r, action, err)
			return
		}
		turnID := turn.ID
		out.TurnID = &turnID
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusAccepted, out)
}

// --- parsing ----------------------------------------------------------

// parseListFilter turns the query string into the store's filter, and answers
// the 422s itself: a malformed project id, an `since` that is not RFC 3339 and
// an `include_seen` that is not a bool are all caller mistakes, and none of
// them may reach a store as a driver error.
func (h *catchUpHandlers) parseListFilter(w http.ResponseWriter, r *http.Request) (CatchUpListFilter, bool) {
	q := r.URL.Query()
	var f CatchUpListFilter
	projects, ok := h.parseProjectIDs(w, q["projects"], "projects")
	if !ok {
		return f, false
	}
	f.ProjectIDs = projects
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		since, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			catchUpInvalid(w, "since must be an RFC 3339 timestamp.")
			return f, false
		}
		utc := since.UTC()
		f.Since = &utc
	}
	if raw := strings.TrimSpace(q.Get("include_seen")); raw != "" {
		seen, err := strconv.ParseBool(raw)
		if err != nil {
			catchUpInvalid(w, "include_seen must be a boolean.")
			return f, false
		}
		f.IncludeSeen = seen
	}
	return f, true
}

// parseProjectIDs accepts the csv form and the repeated form
// (`projects=a&projects=b`), and refuses anything that is not a uuid. The
// result is what the store INTERSECTS with the caller's own membership, which
// is the reason a malformed id is refused here rather than passed down: the
// store's answer to a foreign project is "nothing", and its answer to junk must
// not be.
func (h *catchUpHandlers) parseProjectIDs(w http.ResponseWriter, values []string, field string) ([]string, bool) {
	var out []string
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			s := strings.TrimSpace(part)
			if s == "" {
				continue
			}
			if !validUUIDString(s) {
				catchUpInvalid(w, fmt.Sprintf("%s must be a comma-separated list of uuids.", field))
				return nil, false
			}
			out = append(out, s)
		}
	}
	if len(out) > CatchUpProjectsMax {
		catchUpInvalid(w, fmt.Sprintf("at most %d projects may be named per request.", CatchUpProjectsMax))
		return nil, false
	}
	return out, true
}

// parseStopIDs is the seen payload's own bound: a beat list must name something,
// at most a tour's worth of beats, and every id is the model's string, not a
// uuid. Duplicates collapse: marking one beat read twice is one fact.
func (h *catchUpHandlers) parseStopIDs(w http.ResponseWriter, ids []string) ([]string, bool) {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		s := strings.TrimSpace(id)
		if n := utf8.RuneCountInString(s); n == 0 || n > CatchUpStopIDMaxChars {
			catchUpInvalid(w, fmt.Sprintf("stop_ids must each be between 1 and %d characters.",
				CatchUpStopIDMaxChars))
			return nil, false
		}
		if seen[s] {
			continue
		}
		seen[s], out = true, append(out, s)
	}
	if len(out) == 0 {
		catchUpInvalid(w, "stop_ids must name at least one beat of the tour.")
		return nil, false
	}
	if len(out) > CatchUpStopsMax {
		catchUpInvalid(w, fmt.Sprintf("stop_ids may name at most %d beats.", CatchUpStopsMax))
		return nil, false
	}
	return out, true
}

// --- the visit window --------------------------------------------------

// The three windows the page can open with. They are the design's, and the
// inference below is deliberately coarse: it is choosing a default, not
// reporting a measurement.
const (
	CatchUpWindowDaily  = "24h"
	CatchUpWindowTwoDay = "2d"
	CatchUpWindowWeekly = "7d"
)

// catchUpSuggestion infers the window from the reader's own visit
// stamps, newest first as the store returns them. Fewer than two visits is no
// interval at all, so `window` is null and the UI keeps whatever it was told to
// use; from there the median gap decides: a daily-ish reader gets 24h, someone
// back every couple of days gets 2d, and a weekly-or-rarer reader gets 7d
// rather than a window that hides most of what they missed.
func catchUpSuggestion(visits []time.Time, now time.Time) CatchUpVisitSuggestion {
	perWeek := visitsPerWeek(visits, now)
	if len(visits) < 2 {
		return CatchUpVisitSuggestion{Window: nil, VisitsPerWeek: perWeek}
	}
	ordered := append([]time.Time(nil), visits...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].After(ordered[j]) })
	gaps := make([]time.Duration, 0, len(ordered)-1)
	for i := 1; i < len(ordered); i++ {
		gap := ordered[i-1].Sub(ordered[i])
		if gap < 0 {
			gap = 0
		}
		gaps = append(gaps, gap)
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i] < gaps[j] })
	median := gaps[len(gaps)/2]
	name := CatchUpWindowWeekly
	switch {
	case median < 36*time.Hour:
		name = CatchUpWindowDaily
	case median <= 4*24*time.Hour:
		name = CatchUpWindowTwoDay
	}
	return CatchUpVisitSuggestion{Window: &name, VisitsPerWeek: perWeek}
}

// visitsPerWeek counts the visit stamps no more than seven days old — the
// number a reader can check against their own history. The window above is the
// default it implies; this is the evidence, and a stamp ahead of this replica's
// clock (a skewed replica, a clock step) counts as a visit rather than being
// dropped.
func visitsPerWeek(visits []time.Time, now time.Time) float64 {
	const week = 7 * 24 * time.Hour
	var n int
	for _, v := range visits {
		if d := now.Sub(v); d <= week {
			n++
		}
	}
	return float64(n)
}

// --- reply helpers -----------------------------------------------------

func catchUpIsOption(options []string, text string) bool {
	for _, o := range options {
		if strings.TrimSpace(o) == text {
			return true
		}
	}
	return false
}

// --- plumbing ---------------------------------------------------------

func (h *catchUpHandlers) caller(w http.ResponseWriter, r *http.Request,
	action string) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.srv.logger.ErrorContext(r.Context(), "catch up: no principal in context",
			"action", action)
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"No principal in context.")
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// fail maps a store error onto the contract. A work item the caller may not see
// and one that is gone are one 404 (ADR-0014 § 3), a payload the store will not
// write is a 422 naming the field, and everything else is a 500 whose only
// handle is the request id.
func (h *catchUpHandlers) fail(w http.ResponseWriter, r *http.Request, action string, err error) {
	switch {
	case errors.Is(err, ErrCatchUpNotFound), errors.Is(err, ErrProjectNotFound):
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"No such catch-up work item, or it is not yours to read.")
	case errors.Is(err, ErrCatchUpValidation):
		WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed",
			catchUpSentinelDetail(err, ErrCatchUpValidation))
	default:
		h.srv.logger.ErrorContext(r.Context(), "catch up: store failure",
			"action", action,
			"request_id", RequestIDFrom(r),
			"error", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The server could not complete the request. Use the request id when reporting it.")
	}
}

// failMessage maps a conversation refusal the way the messages route does
// (cnvHandlers.fail): the conflict carries the live control row and the blocking
// turn, because a client that is told "the agent is busy" has to be able to show
// who is busy rather than retry blind (ADR-0016 § 9 obligation 3). The reply row
// is already written when this runs, and it stays written.
func (h *catchUpHandlers) failMessage(w http.ResponseWriter, r *http.Request, action string, err error) {
	var conflict *ConversationConflict
	if errors.As(err, &conflict) {
		cnvWriteConflict(w, conflict)
		return
	}
	switch {
	case errors.Is(err, ErrConversationNotFound):
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"The reply was stored, but its conversation is gone.")
	case errors.Is(err, ErrConversationForbidden):
		detail := "Your project role is read-only; a contributor is required to change a conversation."
		if wrapped := cnvSentinelDetail(err, ErrConversationForbidden); wrapped != "" {
			detail = wrapped
		}
		WriteProblem(w, http.StatusForbidden, "Forbidden", detail)
	case errors.Is(err, ErrConversationValidation):
		cnvInvalid(w, cnvValidationDetail(err))
	default:
		h.srv.logger.ErrorContext(r.Context(), "catch up: conversation post failed",
			"action", action,
			"request_id", RequestIDFrom(r),
			"error", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The reply was stored, but it could not be posted. Use the request id when reporting it.")
	}
}

func (h *catchUpHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
}

// catchUpInvalid is the 422 every malformed input on this surface gets.
func catchUpInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// catchUpSentinelDetail forwards the store's own naming after its sentinel
// ("stop_ids: not a uuid"), which is the whole value of a 422; a bare sentinel
// gets a generic line rather than an empty detail.
func catchUpSentinelDetail(err, sentinel error) string {
	text := err.Error()
	if i := strings.Index(text, sentinel.Error()); i >= 0 {
		text = text[i+len(sentinel.Error()):]
	}
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), ":"))
	if text == "" {
		return "The request is not valid for this work item."
	}
	return text
}
