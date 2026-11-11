package api

// APM collections — the library items of ADR-0084: named, versioned bundles of
// pinned APM refs that an agent profile attaches in an order of its choosing.
//
// The surface is the step registry's shape (node_templates.go) restated for the
// other half of the library:
//
//   - Collections are ORG-scoped. A collection of another organization is the
//     uniform 404; its existence never leaks (ADR-0014 §3).
//   - Revisions are immutable once published: there is no mutation route to a
//     published revision, a new version is a new row, and republishing a
//     published revision is 409 rather than a silent no-op (ADR-0002's rule,
//     which ADR-0084 restates for collections).
//   - Write is the organization's library role — the exact IsOrgAdmin gate the
//     pipeline library, the step registry and the agent-profile writes use.
//
// What a collection is NOT is a package. Upstream APM deleted its
// `.collection.yml` kind in 0.12.0 (research §1), so nothing stored here is a
// format apm reads. A collection is an ordered list of refs the worker FLATTENS
// — apm.FlattenProfile — into the one generated `apm.yml` it installs and the
// one `apm.lock.yaml` whose digest gates the launch (ADR-0030 Amendment 1,
// ADR-0054). One profile, one lock, one digest: the invariant that made the
// single pin trustworthy is the reason a flatten exists instead of N installs.
//
// Every entry ref must already be pinned (a tag or a full commit): the same
// grammar an agent-profile ref is checked against, applied PER ELEMENT, so
// nothing a collection points at can follow a moving branch into an agent's
// context.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
)

// Errors the collection handlers understand. The store adapter maps its own
// sentinels onto these; 404 is the invisible-resource answer (house style), 403
// the visible-but-not-writable one, 409 a slug clash or a mutation aimed at a
// published revision.
var (
	ErrAPMCollectionNotFound  = errors.New("api: apm collection not found")
	ErrAPMCollectionForbidden = errors.New("api: apm collection write not allowed")
	ErrAPMCollectionConflict  = errors.New("api: apm collection slug already exists")
	// ErrAPMCollectionRevisionImmutable answers a write aimed at a revision that
	// is already published: the row is frozen and the caller's premise — that it
	// could still be changed — is false.
	ErrAPMCollectionRevisionImmutable = errors.New("api: that apm collection revision is already published")
	// ErrAPMCollectionValidation covers every named 422 in this file; the code
	// travels inside *APMCollectionProblemError when there is one.
	ErrAPMCollectionValidation = errors.New("api: apm collection request failed validation")
)

// ADR-0084's named codes, beside the ADR-0030 profile codes a client already
// switches on. Adding one is additive, renaming one is not.
const (
	// CollectionCodeSlugInvalid: slug breaks the registry grammar.
	CollectionCodeSlugInvalid = "apm_collection_slug_invalid"
	// CollectionCodeNameInvalid: name is empty or over 200 characters.
	CollectionCodeNameInvalid = "apm_collection_name_invalid"
	// CollectionCodeEntriesInvalid: an entry ref is not a pinned apm git
	// dependency, or a skills subset names an empty skill.
	CollectionCodeEntriesInvalid = "apm_collection_entries_invalid"
	// CollectionCodeRevisionInvalid: a profile attached a revision that is a
	// draft, does not exist, or lives in another organization.
	CollectionCodeRevisionInvalid = "apm_collection_revision_invalid"
)

// apmcSlugPattern is apm_collections.slug's own CHECK: the grammar a launcher id
// uses, so one URL-segment rule covers the library.
var apmcSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// APMCollectionProblemError is a 422 naming its ADR-0084 code, the twin of
// AgentProfileProblemError; it unwraps to ErrAPMCollectionValidation.
type APMCollectionProblemError struct {
	Code   string
	Detail string
}

func (e *APMCollectionProblemError) Error() string {
	if e == nil {
		return "api: apm collection request failed validation"
	}
	return "api: apm collection request failed validation (" + e.Code + "): " + e.Detail
}

func (e *APMCollectionProblemError) Unwrap() error { return ErrAPMCollectionValidation }

// --- inputs (handler → store) -------------------------------------------

// APMCollectionEntry is one ordered entry of a collection revision: a pinned
// apm git dependency, the optional skill subset it cherry-picks, and the note
// that tells a reader why it is in the bundle.
type APMCollectionEntry struct {
	Ref    string   `json:"ref"`
	Skills []string `json:"skills,omitempty"`
	Note   string   `json:"note,omitempty"`
}

// APMCollectionCreateInput is POST /apm-collections' body: identity plus the
// revision-1 entries. Revision 1 lands a DRAFT (ADR-0084): creating a collection
// does not make it attachable, publishing does.
type APMCollectionCreateInput struct {
	Slug        string
	Name        string
	Description string
	Entries     []APMCollectionEntry
}

// APMCollectionRevisionInput is POST /apm-collections/{id}/revisions' body: "save
// as a new revision". It creates a draft and never touches the revision it was
// drafted from.
type APMCollectionRevisionInput struct {
	Entries []APMCollectionEntry
}

// APMCollectionPin is one profile attachment: a collection and the EXACT
// revision frozen on the profile. Freezing the revision rather than "latest" is
// what keeps a profile revision replayable (ADR-0058) and lets a collection gain
// a revision without moving a running profile's digest.
type APMCollectionPin struct {
	CollectionID string `json:"collection_id"`
	Revision     int    `json:"revision"`
}

// --- views (store → handler → wire) -------------------------------------

// APMCollectionEntryView is one entry on the wire. `skills` is [] (never null)
// when the entry takes the whole package, so the app never confuses "the whole
// package" with "a field I never read".
type APMCollectionEntryView struct {
	Ref    string   `json:"ref"`
	Skills []string `json:"skills"`
	Note   string   `json:"note,omitempty"`
}

// APMCollectionRevisionSummary is a collection row's latest_revision: identity,
// status and content, so the library list needs no second round trip.
type APMCollectionRevisionSummary struct {
	RevisionID string                   `json:"revision_id"`
	Revision   int                      `json:"revision"`
	Status     string                   `json:"status"`
	Entries    []APMCollectionEntryView `json:"entries"`
	CreatedAt  time.Time                `json:"created_at"`
}

// APMCollectionView is the APMCollection schema.
type APMCollectionView struct {
	ID          string    `json:"id"`
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	// LatestRevision is the newest revision row, draft OR published: what a
	// collection currently IS. Null only for a collection with no revision at
	// all, which the create path cannot produce.
	LatestRevision *APMCollectionRevisionSummary `json:"latest_revision"`
	// PublishedRevisions counts the revisions a profile may attach. Computed,
	// not stored: the number the app shows beside "attach" is the number the
	// write path will actually accept.
	PublishedRevisions int `json:"published_revisions"`
}

// APMCollectionListView is GET /apm-collections' envelope. NextCursor is null:
// one organization's library in one page (the house list idiom, as /pipelines).
type APMCollectionListView struct {
	Collections []APMCollectionView `json:"collections"`
	NextCursor  *string             `json:"next_cursor"`
}

// APMCollectionRevisionView is one revision, content included.
type APMCollectionRevisionView struct {
	RevisionID string                   `json:"revision_id"`
	Revision   int                      `json:"revision"`
	Status     string                   `json:"status"`
	Entries    []APMCollectionEntryView `json:"entries"`
	CreatedBy  string                   `json:"created_by"`
	CreatedAt  time.Time                `json:"created_at"`
	UpdatedAt  time.Time                `json:"updated_at"`
}

// Summary projects a revision into the list shape.
func (r APMCollectionRevisionView) Summary() APMCollectionRevisionSummary {
	return APMCollectionRevisionSummary{
		RevisionID: r.RevisionID, Revision: r.Revision, Status: r.Status,
		Entries: r.Entries, CreatedAt: r.CreatedAt,
	}
}

// APMCollectionDetailView is GET /apm-collections/{id}'s body: the collection and
// its FULL revision history, newest first — the version panel a collection's
// page reads, same shape as the profile version history.
type APMCollectionDetailView struct {
	Collection APMCollectionView           `json:"collection"`
	Revisions  []APMCollectionRevisionView `json:"revisions"`
}

// APMCollectionStore is the library's persistence face: every method enforces
// the caller's organization itself (a foreign collection is
// ErrAPMCollectionNotFound) and journals its own writes.
type APMCollectionStore interface {
	ListAPMCollections(ctx context.Context, c Caller) ([]APMCollectionView, error)
	GetAPMCollection(ctx context.Context, c Caller, collectionID string) (APMCollectionDetailView, error)
	CreateAPMCollection(ctx context.Context, c Caller, in APMCollectionCreateInput) (APMCollectionView, error)
	CreateAPMCollectionRevision(ctx context.Context, c Caller, collectionID string, in APMCollectionRevisionInput) (APMCollectionRevisionView, error)
	PublishAPMCollectionRevision(ctx context.Context, c Caller, collectionID string, revision int) (APMCollectionRevisionView, error)
	// RecordDenied writes the audit row for a refused read or mutation.
	RecordDenied(ctx context.Context, c Caller, collectionID, action string) error
}

// --- request bodies ----------------------------------------------------

type apmcCreateBody struct {
	Slug        string               `json:"slug"`
	Name        string               `json:"name"`
	Description string               `json:"description,omitempty"`
	Entries     []APMCollectionEntry `json:"entries"`
}

type apmcRevisionBody struct {
	Entries []APMCollectionEntry `json:"entries"`
}

// --- handlers ----------------------------------------------------------

// RegisterAPMCollections mounts ADR-0084's library surface.
func RegisterAPMCollections(s *Server, store APMCollectionStore) {
	if store == nil {
		return
	}
	h := &apmcHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/apm-collections", http.HandlerFunc(h.list))
	s.HandleAuthed("POST /api/v1/apm-collections", http.HandlerFunc(h.create))
	s.HandleAuthed("GET /api/v1/apm-collections/{collectionId}", http.HandlerFunc(h.get))
	s.HandleAuthed("POST /api/v1/apm-collections/{collectionId}/revisions", http.HandlerFunc(h.createRevision))
	s.HandleAuthed("POST /api/v1/apm-collections/{collectionId}/revisions/{revision}/publish", http.HandlerFunc(h.publishRevision))
}

type apmcHandlers struct {
	store APMCollectionStore
	srv   *Server
}

func (h *apmcHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireWriteRole is ADR-0084's write gate: the organization's library role,
// the gate node_templates.go calls requireWriteRole and agent_profiles.go states
// in its 403 prose. Non-admin → 403: a member who can read every collection
// still cannot edit one.
func (h *apmcHandlers) requireWriteRole(w http.ResponseWriter, r *http.Request, c Caller) bool {
	if c.IsOrgAdmin {
		return true
	}
	h.log(r).WarnContext(r.Context(), "apm collection write denied",
		slog.String("user_id", c.UserID),
		slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Writing the shared APM collection library requires the organization's library role.")
	return false
}

func (h *apmcHandlers) list(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.store.ListAPMCollections(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, "apm-collection.list", err)
		return
	}
	if items == nil {
		items = []APMCollectionView{}
	}
	WriteJSON(w, http.StatusOK, APMCollectionListView{Collections: items})
}

func (h *apmcHandlers) get(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	id := r.PathValue("collectionId")
	if !validUUID(id) {
		h.denied(w, r, c, id, "apm-collection.get", "malformed collection id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such APM collection.")
		return
	}
	detail, err := h.store.GetAPMCollection(r.Context(), c, id)
	if err != nil {
		h.fail(w, r, c, "apm-collection.get", err)
		return
	}
	if detail.Revisions == nil {
		detail.Revisions = []APMCollectionRevisionView{}
	}
	if detail.Collection.LatestRevision != nil && len(detail.Revisions) > 0 &&
		len(detail.Collection.LatestRevision.Entries) == 0 {
		summary := detail.Revisions[0].Summary()
		detail.Collection.LatestRevision = &summary
	}
	WriteJSON(w, http.StatusOK, detail)
}

func (h *apmcHandlers) create(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	var body apmcCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 200 {
		apmcProblem(w, CollectionCodeNameInvalid, "name is required and must be at most 200 characters.")
		return
	}
	if len(body.Description) > 2000 {
		apmcProblem(w, CollectionCodeNameInvalid, "description must be at most 2000 characters.")
		return
	}
	if !apmcSlugPattern.MatchString(body.Slug) {
		apmcProblem(w, CollectionCodeSlugInvalid,
			"slug must match ^[a-z0-9][a-z0-9_-]{0,63}$ — it is a URL segment, never a display name.")
		return
	}
	entries, ok := apmcEntries(w, body.Entries)
	if !ok {
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	view, err := h.store.CreateAPMCollection(r.Context(), c, APMCollectionCreateInput{
		Slug: body.Slug, Name: body.Name, Description: body.Description, Entries: entries,
	})
	if err != nil {
		h.fail(w, r, c, "apm-collection.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, view)
}

func (h *apmcHandlers) createRevision(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	id := r.PathValue("collectionId")
	var body apmcRevisionBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	entries, ok := apmcEntries(w, body.Entries)
	if !ok {
		return
	}
	if !validUUID(id) {
		h.denied(w, r, c, id, "apm-collection.revision.create", "malformed collection id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such APM collection.")
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	view, err := h.store.CreateAPMCollectionRevision(r.Context(), c, id, APMCollectionRevisionInput{Entries: entries})
	if err != nil {
		h.fail(w, r, c, "apm-collection.revision.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, view)
}

func (h *apmcHandlers) publishRevision(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	id := r.PathValue("collectionId")
	revision, err := strconv.Atoi(r.PathValue("revision"))
	if !validUUID(id) || err != nil || revision < 1 {
		h.denied(w, r, c, id, "apm-collection.revision.publish", "malformed collection id or revision")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such APM collection revision.")
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	view, err := h.store.PublishAPMCollectionRevision(r.Context(), c, id, revision)
	if err != nil {
		h.fail(w, r, c, "apm-collection.revision.publish", err)
		return
	}
	WriteJSON(w, http.StatusOK, view)
}

// apmcEntries is the entry-list gate. An empty list is legal — the empty,
// editable starter of ADR-0084's seed is exactly that — but every ref in a
// non-empty list must be a pinned apm git dependency, checked PER ELEMENT:
// apm.ValidatePackageRef is the worker's own grammar, so the refusal the API
// answers and the refusal the flatten answers are the same refusal.
func apmcEntries(w http.ResponseWriter, entries []APMCollectionEntry) ([]APMCollectionEntry, bool) {
	out := make([]APMCollectionEntry, 0, len(entries))
	for i, e := range entries {
		ref := strings.TrimSpace(e.Ref)
		if err := apm.ValidatePackageRef(ref); err != nil {
			apmcProblem(w, CollectionCodeEntriesInvalid,
				"entry "+strconv.Itoa(i+1)+": "+err.Error()+
					" — a ref with no #<tag|full-commit> follows a moving branch and cannot be pinned (ADR-0084 Security).")
			return nil, false
		}
		clean := APMCollectionEntry{Ref: ref, Note: strings.TrimSpace(e.Note)}
		for _, s := range e.Skills {
			name := strings.TrimSpace(s)
			if name == "" {
				apmcProblem(w, CollectionCodeEntriesInvalid,
					"entry "+strconv.Itoa(i+1)+": a skills subset cannot name an empty skill.")
				return nil, false
			}
			clean.Skills = append(clean.Skills, name)
		}
		out = append(out, clean)
	}
	return out, true
}

// apmcProblemTitle derives the stable problem title from the stable code, the
// rule profProblemTitle states for the profile surface.
func apmcProblemTitle(code string) string {
	switch code {
	case CollectionCodeSlugInvalid:
		return "Invalid Collection Slug"
	case CollectionCodeNameInvalid:
		return "Invalid Collection Name"
	case CollectionCodeEntriesInvalid:
		return "Invalid Collection Entries"
	case CollectionCodeRevisionInvalid:
		return "Collection Revision Not Attachable"
	default:
		return "Validation Failed"
	}
}

// apmcProblem writes the 422 every collection refusal shares, in the profile
// surface's shape: a Problem document, an ADR-0084 `code` and the matching
// stable `type` URI. The code is the contract; the prose beside it may change.
func apmcProblem(w http.ResponseWriter, code, detail string) {
	profProblemStatus(w, http.StatusUnprocessableEntity, code, apmcProblemTitle(code), detail)
}

// fail maps a collection store error onto the HTTP contract: 404 outside the
// caller's organization (with the audit row ADR-0014 §3 asks for), 403 without
// the library role, 409 for a taken slug or a mutation aimed at a published
// revision, and the named 422 for every coded refusal.
func (h *apmcHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, action string, err error) {
	var problem *APMCollectionProblemError
	if errors.As(err, &problem) {
		apmcProblem(w, problem.Code, problem.Detail)
		return
	}
	switch {
	case errors.Is(err, ErrAPMCollectionNotFound):
		h.denied(w, r, c, pathCollectionID(r), action, "no such apm collection, or it is not in your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such APM collection.")
	case errors.Is(err, ErrAPMCollectionForbidden):
		h.denied(w, r, c, pathCollectionID(r), action, "the library role is required")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Editing an APM collection requires the organization's library role.")
	case errors.Is(err, ErrAPMCollectionConflict):
		h.denied(w, r, c, pathCollectionID(r), action, "an apm collection with that slug already exists")
		WriteProblem(w, http.StatusConflict, "Conflict",
			"Your organization already has an APM collection with that slug.")
	case errors.Is(err, ErrAPMCollectionRevisionImmutable):
		// ADR-0084: a published revision is frozen. The conflict names the
		// remedy, because "you cannot edit that" with no next step is the
		// refusal a client works around.
		h.denied(w, r, c, pathCollectionID(r), action, "that revision is published and frozen")
		WriteProblem(w, http.StatusConflict, "Conflict",
			"A published APM collection revision cannot be edited; create a new revision instead.")
	default:
		h.serverError(w, r, action, err)
	}
}

func pathCollectionID(r *http.Request) string { return r.PathValue("collectionId") }

func (h *apmcHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, collectionID, action, reason string) {
	if h.store != nil {
		if err := h.store.RecordDenied(r.Context(), c, collectionID, action); err != nil {
			h.log(r).ErrorContext(r.Context(), "could not write audit denial",
				slog.String("action", action),
				slog.String("collection_id", collectionID),
				slog.String("request_id", RequestIDFrom(r)),
				slog.Any("error", err))
			return
		}
	}
	h.log(r).WarnContext(r.Context(), "apm collection access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("collection_id", collectionID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *apmcHandlers) serverError(w http.ResponseWriter, r *http.Request, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "apm collection request failed",
		slog.String("action", action),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The APM collection request could not be completed.")
}

func (h *apmcHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.Default()
}

func (h *apmcHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	WriteProblem(w, http.StatusBadRequest, "Bad Request", "The request body is not valid JSON: "+err.Error())
}
