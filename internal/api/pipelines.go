package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/pipelines/schema"
)

// The M4 definition surface: pipelines, drafts, published revisions and the
// served schema (docs/m4-contract.md § 2.1 routes 1–16, api/openapi.yaml
// v0.4.0-m4, ADR-0021/0024).
//
// Three rules govern every handler here:
//
//   - Definitions are ORG-scoped. There is no project membership to consult;
//     the store resolves every read through the caller's own organization and
//     answers "not found" for anything outside it, so a cross-tenant pipeline,
//     draft or revision digest is a 404 byte-identical to nonsense
//     (m4-contract § 2.1 route 13).
//   - Revisions are immutable. The only mutation this surface can make to a
//     published row is deprecate, and it touches no run (ADR-0002).
//   - The API never computes a digest or a canonical document. Loader,
//     schema and compiler live behind PipelineDefinitionService; the store
//     persists exactly what that service returned (§ 2.2), so publish and
//     validate cannot disagree with the compiler about what a document means.

// Errors the pipeline handlers understand. Store adapters map their own
// errors onto these so this package stays free of any driver dependency.
var (
	// ErrPipelineNotFound is also the answer to "you may not know this
	// exists": cross-org pipelines, drafts and revision digests all 404.
	ErrPipelineNotFound = errors.New("api: pipeline object not found")
	// ErrPipelineConflict is a unique-constraint clash without a richer
	// conflict body (duplicate slug, colliding version_label).
	ErrPipelineConflict = errors.New("api: pipeline unique constraint violation")
)

// Draft-conflict kinds. They are the § 2.2 publish-time code vocabulary,
// shared between this package and the store adapters that raise them.
const (
	DraftConflictStaleVersion     = "stale_draft_version"
	DraftConflictChangedSinceVal  = "draft_changed_since_validation"
	DraftConflictNotValid         = "draft_not_valid"
	DraftConflictAlreadyPublished = "revision_already_published"
	DraftConflictPublished        = "draft_published"
	DraftConflictSecretLiteral    = "secret_literal_detected"
)

// DraftConflictError is a refused draft mutation that must answer 409 (or
// 422 for the secret-literal block) with the state the loser must adopt
// (DraftConflictProblem, api/openapi.yaml): the winner's version for a CAS
// miss, the existing revision id for a digest collision. A bare 409 would
// send the editor to re-read every field to find the one that moved.
type DraftConflictError struct {
	Kind               string // one of the DraftConflict* kinds
	Detail             string
	DraftID            string
	CurrentVersion     int    // stale_draft_version: the draft's real version
	ExistingRevisionID string // revision_already_published: the live collision
}

func (e *DraftConflictError) Error() string {
	return fmt.Sprintf("api: draft conflict (%s): %s", e.Kind, e.Detail)
}

// PipelineDefinitionService is the validation/publish computation behind
// routes 11–14: the loader rules, the 2020-12 schema pass and the compiler
// (§ 2.2, ADR-0021/0022) run behind Validate, and Export regenerates the
// honest textual form from a canonical document (ADR-0021 § 5: anchors and
// merge keys do not survive canonicalization, so what the author typed is
// not the round-trippable bytes — the regenerated text is).
//
// The serve wave injects an implementation built on internal/pipelines
// {loader, schema, canon, compiler}; tests pass a scripted fake so the HTTP
// layer never re-implements (or drifts from) the compiler.
type PipelineDefinitionService interface {
	// Validate runs loader → schema → compiler over the document and returns
	// the § 2.2 body plus, on a valid pass, the canonical document, both
	// digests and the compiled plan the draft must carry. It refuses only
	// on infrastructure failure — an invalid document is a 200 with the
	// verdict in the body.
	Validate(ctx context.Context, c Caller, documentYAML string) (ValidationOutcome, error)
	// Export renders canonical JSON back to YAML (route 14 and publish's
	// regenerated document_text).
	Export(canonicalDocument json.RawMessage) (string, error)
	// EnvDigest is the pinned CEL declaration-set digest (ADR-0022 § 5)
	// stamped on every publish.
	EnvDigest() string
}

// ValidationOutcome is one validate pass: the response body verbatim, plus
// the compiler output the draft row stores for publish. The digest/plan
// members are set exactly when Body.Valid is true.
type ValidationOutcome struct {
	Body              ValidateResponse
	CanonicalDocument json.RawMessage
	RevisionDigest    string
	CompiledPlan      json.RawMessage
	PlanDigest        string
	DigestScope       string
}

// PipelineStore is the definition service's persistence face: the methods
// the routes call, each enforcing the caller's ORGANIZATION itself (a row
// of another organization is ErrPipelineNotFound, never a peek) and
// appending its § 3 journal row in the same transaction as its state write
// (pipeline.created, pipeline.draft.updated, pipeline.draft.validated,
// pipeline.revision.published, pipeline.revision.deprecated).
type PipelineStore interface {
	ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
	CreatePipeline(ctx context.Context, c Caller, slug, displayName, description string) (PipelineView, error)
	GetPipeline(ctx context.Context, c Caller, pipelineID string) (PipelineView, error)
	// UpdatePipeline is route 4: metadata only. Nil patch members do not
	// move; it cannot reach a revision, a draft or a run.
	UpdatePipeline(ctx context.Context, c Caller, pipelineID string, in PipelineUpdateInput) (PipelineView, error)
	ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) ([]RevisionSummaryView, error)
	ListPipelineDrafts(ctx context.Context, c Caller, pipelineID string) ([]DraftSummaryView, error)
	// CreateDraft writes the draft from already-materialized bytes: the
	// handler computed SourceSHA256 over exactly the DocumentYAML it sends
	// (clone drafts arrive as the revision's regenerated export), so the
	// hash publish later compares against is the hash of what is stored.
	CreateDraft(ctx context.Context, c Caller, pipelineID string, in DraftCreateInput) (DraftView, error)
	GetDraft(ctx context.Context, c Caller, draftID string) (DraftView, error)
	// ReplaceDraft is PUT under CAS on ExpectedVersion. A published draft or
	// a lost race is a *DraftConflictError carrying the winner's version;
	// the stored metadata.ui is re-resolved from the new document (§ 2.1
	// route 9) inside the adapter.
	ReplaceDraft(ctx context.Context, c Caller, draftID, documentYAML, sourceSHA256 string, expectedVersion int) (DraftView, error)
	// DeleteDraft refuses a published draft with a *DraftConflictError
	// (kind draft_published): it is a revision's audit trail, not
	// discardable material (route 10).
	DeleteDraft(ctx context.Context, c Caller, draftID string) error
	// RecordValidation is route 11's write: status, the body verbatim, and
	// on a valid pass the canonical document, both digests and the plan.
	RecordValidation(ctx context.Context, c Caller, draftID string, in DraftValidationRecord) (DraftView, error)
	// PublishDraft freezes the draft's validated content (route 12): CAS on
	// ExpectedVersion, an org digest collision is a *DraftConflictError of
	// kind revision_already_published carrying the existing revision id, a
	// draft that stopped being valid is kind draft_not_valid — publish
	// never silently revalidates.
	PublishDraft(ctx context.Context, c Caller, draftID string, in DraftPublishInput) (RevisionView, error)
	// GetRevision resolves by revision id OR revision_digest inside the
	// caller's organization (route 13); a digest held only by another org
	// answers ErrPipelineNotFound, byte-identical to a nonsense digest.
	GetRevision(ctx context.Context, c Caller, digestOrID string) (RevisionView, error)
	// DeprecateRevision is route 15: status only; existing runs untouched.
	DeprecateRevision(ctx context.Context, c Caller, revisionID string) (RevisionView, error)
	// RecordDenied writes the audit row for a refused read or mutation of a
	// pipeline-family resource; the adapter resolves the owning project
	// where one exists (audit_events.project_id is nullable — definitions
	// are org-scoped and have none).
	RecordDenied(ctx context.Context, c Caller, resourceID, action string) error
}

// --- inputs (handler → store) ---------------------------------------------

// FolderPatch is the PATCH body's `folder` member (ADR-0049 § 8) in its
// three wire states: absent (the column is untouched), JSON null (cleared)
// and a string (set). A plain *string cannot tell absent from null.
type FolderPatch struct {
	Set   bool
	Clear bool
	Value string
}

// PipelineUpdateInput is the PATCH body reduced to "what moved": nil means
// the member was absent and its column does not change.
type PipelineUpdateInput struct {
	DisplayName *string
	Description *string
	Archived    *bool
	Folder      FolderPatch
}

// DraftCreateInput is a created draft from already-materialized bytes.
type DraftCreateInput struct {
	DocumentYAML string
	SourceKind   string // manual | yaml_import | assistant | clone
	SourceSHA256 string
}

// DraftValidationRecord is one validate pass for the draft row.
type DraftValidationRecord struct {
	Status            string // valid | invalid
	Body              ValidateResponse
	CanonicalDocument json.RawMessage
	RevisionDigest    string
	CompiledPlan      json.RawMessage
	PlanDigest        string
	DigestScope       string
}

// DraftPublishInput is the publish gate's payload: the CAS version, the
// semver label (already defaulted by the handler when the body omitted it),
// the regenerated document_text and the two environment digests.
type DraftPublishInput struct {
	ExpectedVersion int
	VersionLabel    string
	DocumentText    string
	SchemaDigest    string
	CelEnvDigest    string
}

// --- views (api/openapi.yaml schemas) --------------------------------------

// PipelineSummaryView is the PipelineSummary schema: a library row. No
// document bytes ride a list route.
// PipelineSummaryView is one row of the pipeline library list (route 1).
// Folder is ADR-0049 § 8's display group: null = unfiled, computed into
// groups client-side.
type PipelineSummaryView struct {
	ID                   string  `json:"id"`
	Slug                 string  `json:"slug"`
	DisplayName          string  `json:"display_name"`
	Folder               *string `json:"folder"`
	LatestRevisionNumber int     `json:"latest_revision_number"`
	RevisionCount        int     `json:"revision_count"`
	Archived             bool    `json:"archived"`
}

// PipelineListView is the PipelineList envelope.
type PipelineListView struct {
	Pipelines []PipelineSummaryView `json:"pipelines"`
}

// PipelineView is the Pipeline schema: the logical definition plus its
// revision summaries (identity and digests, never bodies). Folder is
// ADR-0049 § 8's display group: null = unfiled.
type PipelineView struct {
	ID                   string                `json:"id"`
	Slug                 string                `json:"slug"`
	DisplayName          string                `json:"display_name"`
	Description          string                `json:"description"`
	Folder               *string               `json:"folder"`
	CreatedBy            string                `json:"created_by"`
	CreatedAt            time.Time             `json:"created_at"`
	LatestRevisionNumber int                   `json:"latest_revision_number"`
	RevisionCount        int                   `json:"revision_count"`
	Archived             bool                  `json:"archived"`
	Revisions            []RevisionSummaryView `json:"revisions"`
}

// RevisionSummaryView is the PipelineRevisionSummary schema: both digests,
// no body (the body is a GET /revisions/{digestOrId} fetch).
type RevisionSummaryView struct {
	RevisionNumber int       `json:"revision_number"`
	VersionLabel   string    `json:"version_label"`
	RevisionDigest string    `json:"revision_digest"`
	PlanDigest     string    `json:"plan_digest"`
	DigestScope    string    `json:"digest_scope"`
	PublishedAt    time.Time `json:"published_at"`
	PublishedBy    string    `json:"published_by"`
	Status         string    `json:"status"`
}

// RevisionSummaryListView is the PipelineRevisionSummaryList envelope.
type RevisionSummaryListView struct {
	Revisions []RevisionSummaryView `json:"revisions"`
}

// RevisionView is the full immutable PipelineRevision record. DocumentText
// is the YAML REGENERATED from CanonicalDocument — the author's bytes are
// not stored on the revision, because canonicalization is one-way and only
// the regenerated form re-canonicalizes to RevisionDigest (ADR-021 § 5).
type RevisionView struct {
	ID                string          `json:"id"`
	PipelineID        string          `json:"pipeline_id"`
	DraftID           *string         `json:"draft_id"`
	RevisionNumber    int             `json:"revision_number"`
	VersionLabel      string          `json:"version_label"`
	APIVersion        string          `json:"api_version"`
	CanonicalDocument json.RawMessage `json:"canonical_document"`
	DocumentText      string          `json:"document_text"`
	UILayout          json.RawMessage `json:"ui_layout"`
	RevisionDigest    string          `json:"revision_digest"`
	DigestScope       string          `json:"digest_scope"`
	CompiledPlan      json.RawMessage `json:"compiled_plan"`
	PlanDigest        string          `json:"plan_digest"`
	SchemaDigest      string          `json:"schema_digest"`
	CelEnvDigest      string          `json:"cel_env_digest"`
	Status            string          `json:"status"`
	PublishedBy       string          `json:"published_by"`
	PublishedAt       time.Time       `json:"published_at"`
}

// DraftSummaryView is the DraftSummary schema.
type DraftSummaryView struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updated_at"`
	EditedBy  string    `json:"edited_by"`
}

// DraftSummaryListView is the DraftSummaryList envelope.
type DraftSummaryListView struct {
	Drafts []DraftSummaryView `json:"drafts"`
}

// DraftView is the Draft schema: the only mutable pipeline object.
// Validation is the last POST /validate body verbatim (null when never
// validated) so an editor reload repaints without revalidating.
type DraftView struct {
	ID                  string          `json:"id"`
	PipelineID          string          `json:"pipeline_id"`
	Status              string          `json:"status"`
	DocumentYAML        string          `json:"document_yaml"`
	SourceKind          string          `json:"source_kind"`
	SourceSHA256        string          `json:"source_sha256"`
	UILayout            json.RawMessage `json:"ui_layout"`
	Validation          json.RawMessage `json:"validation"`
	DigestScope         string          `json:"digest_scope"`
	RevisionDigest      *string         `json:"revision_digest"`
	PlanDigest          *string         `json:"plan_digest"`
	PublishedRevisionID *string         `json:"published_revision_id"`
	Version             int             `json:"version"`
	EditedBy            string          `json:"edited_by"`
	CreatedAt           time.Time       `json:"created_at"`
	UpdatedAt           time.Time       `json:"updated_at"`
	// CanonicalDocument travels for publish's Export (the regenerated
	// document_text) and is never public — the Draft schema serves the
	// author's bytes and the last validation body, not compiler output.
	CanonicalDocument json.RawMessage `json:"-"`
}

// ValidateError is one § 2.2 finding. Source is loader|schema|compiler and
// the three are ordered, not merged; the codes are a public contract.
type ValidateError struct {
	Code             string  `json:"code"`
	Source           string  `json:"source"`
	Message          string  `json:"message"`
	InstanceLocation *string `json:"instance_location"`
	SchemaLocation   *string `json:"schema_location"`
	Hint             string  `json:"hint,omitempty"`
}

// ValidateResponse is the § 2.2 validate body: the verdict, both digests on
// success, the sorted findings, and the notes tooling must surface.
type ValidateResponse struct {
	Valid          bool            `json:"valid"`
	RevisionDigest *string         `json:"revision_digest"`
	PlanDigest     *string         `json:"plan_digest"`
	DigestScope    string          `json:"digest_scope"`
	Errors         []ValidateError `json:"errors"`
	Notes          []string        `json:"notes"`
}

// --- validation limits -------------------------------------------------------

const (
	// m4MaxDraftBytes is the draft document cap: the loader refuses
	// document_too_large before the DB CHECK on pipeline_drafts ever sees
	// the row (§ 6; the CHECK is 262144 too).
	m4MaxDraftBytes = 262144
	// m4MaxValidateErrors is the § 6 response cap: at most 200 errors, then
	// truncated with notes += ['errors_truncated'] (a 2 000-error list is a
	// browser outage).
	m4MaxValidateErrors = 200
)

var (
	m4SlugPattern = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,127}$`)
	// Revision digests are accepted in the {digestOrId} slot alongside uuids;
	// anything else cannot be a digest and reads as one (404), never a query.
	m4DigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// RegisterPipelines mounts routes 1–16 (definitions, drafts, revisions,
// schema). Mutations pass through HandleAuthed's CSRF gate; the library
// routes check the library role inside the handler.
func RegisterPipelines(s *Server, store PipelineStore, defs PipelineDefinitionService) {
	h := &plHandlers{store: store, defs: defs, srv: s}
	s.HandleAuthed("GET /api/v1/pipelines", http.HandlerFunc(h.listPipelines))
	s.HandleAuthed("POST /api/v1/pipelines", http.HandlerFunc(h.createPipeline))
	s.HandleAuthed("GET /api/v1/pipelines/{pipelineId}", http.HandlerFunc(h.getPipeline))
	s.HandleAuthed("PATCH /api/v1/pipelines/{pipelineId}", http.HandlerFunc(h.updatePipeline))
	s.HandleAuthed("GET /api/v1/pipelines/{pipelineId}/revisions", http.HandlerFunc(h.listRevisions))
	s.HandleAuthed("GET /api/v1/pipelines/{pipelineId}/drafts", http.HandlerFunc(h.listDrafts))
	s.HandleAuthed("POST /api/v1/pipelines/{pipelineId}/drafts", http.HandlerFunc(h.createDraft))
	s.HandleAuthed("GET /api/v1/drafts/{draftId}", http.HandlerFunc(h.getDraft))
	s.HandleAuthed("PUT /api/v1/drafts/{draftId}", http.HandlerFunc(h.putDraft))
	s.HandleAuthed("DELETE /api/v1/drafts/{draftId}", http.HandlerFunc(h.deleteDraft))
	s.HandleAuthed("POST /api/v1/drafts/{draftId}/validate", http.HandlerFunc(h.validateDraft))
	s.HandleAuthed("POST /api/v1/drafts/{draftId}/publish", http.HandlerFunc(h.publishDraft))
	s.HandleAuthed("GET /api/v1/revisions/{digestOrId}", http.HandlerFunc(h.getRevision))
	s.HandleAuthed("GET /api/v1/revisions/{revisionId}/document", http.HandlerFunc(h.getRevisionDocument))
	s.HandleAuthed("POST /api/v1/revisions/{revisionId}/deprecate", http.HandlerFunc(h.deprecateRevision))
	s.HandleAuthed("GET /api/v1/schemas/pipeline-v1alpha1", http.HandlerFunc(h.getSchema))
}

type plHandlers struct {
	store PipelineStore
	defs  PipelineDefinitionService
	srv   *Server
}

// --- request bodies ----------------------------------------------------------

type plPipelineCreateBody struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name,omitempty"`
	Description string `json:"description,omitempty"`
}

// plPipelineUpdateBody is PipelineUpdate: pointer members distinguish
// "absent" from "set to empty/false"; folder is a raw message so JSON
// null (clear) is distinguishable from absent (untouched); minProperties 1
// is checked below.
type plPipelineUpdateBody struct {
	DisplayName *string          `json:"display_name,omitempty"`
	Description *string          `json:"description,omitempty"`
	Archived    *bool            `json:"archived,omitempty"`
	Folder      *json.RawMessage `json:"folder,omitempty"`
}

// plDraftCreateBody is DraftCreate: exactly one member, enforced here
// because min/maxProperties on the wire says 422, not "first one wins".
type plDraftCreateBody struct {
	DocumentYAML   *string `json:"document_yaml,omitempty"`
	FromRevisionID *string `json:"from_revision_id,omitempty"`
}

type plDraftPutBody struct {
	DocumentYAML string `json:"document_yaml"`
	Version      int    `json:"version"`
}

type plDraftPublishBody struct {
	Version      int    `json:"version"`
	VersionLabel string `json:"version_label,omitempty"`
}

// --- handlers ----------------------------------------------------------------

// listPipelines is route 1. The library is ordered by slug
// (api/openapi.yaml listPipelines); the store's row order is not the
// contract's, so the handler sorts rather than trusting it.
func (h *plHandlers) listPipelines(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.store.ListPipelines(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, "", "pipeline.list", err)
		return
	}
	if items == nil {
		items = []PipelineSummaryView{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Slug < items[j].Slug })
	WriteJSON(w, http.StatusOK, PipelineListView{Pipelines: items})
}

// createPipeline is route 2: the logical definition only — no revision, no
// run. Library role; a duplicate slug in the organization is 409.
func (h *plHandlers) createPipeline(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireLibraryRole(w, r, c, "pipeline.create") {
		return
	}
	var body plPipelineCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !m4SlugPattern.MatchString(body.Slug) {
		plInvalid(w, "slug must match "+m4SlugPattern.String()+".")
		return
	}
	if len(body.DisplayName) > 200 {
		plInvalid(w, "display_name must be at most 200 characters.")
		return
	}
	if len(body.Description) > 2000 {
		plInvalid(w, "description must be at most 2000 characters.")
		return
	}
	pipe, err := h.store.CreatePipeline(r.Context(), c, body.Slug, body.DisplayName, body.Description)
	if err != nil {
		h.fail(w, r, c, "", "pipeline.create", err)
		return
	}
	if pipe.Revisions == nil {
		pipe.Revisions = []RevisionSummaryView{}
	}
	WriteJSON(w, http.StatusCreated, pipe)
}

func (h *plHandlers) getPipeline(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	pipelineID := r.PathValue("pipelineId")
	pipe, err := h.store.GetPipeline(r.Context(), c, pipelineID)
	if err != nil {
		h.fail(w, r, c, pipelineID, "pipeline.get", err)
		return
	}
	if pipe.Revisions == nil {
		pipe.Revisions = []RevisionSummaryView{}
	}
	WriteJSON(w, http.StatusOK, pipe)
}

// updatePipeline is route 4: metadata only. This route cannot reach a
// revision, a draft or a run (ADR-0002). Library role.
func (h *plHandlers) updatePipeline(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	pipelineID := r.PathValue("pipelineId")
	if !h.requireLibraryRole(w, r, c, "pipeline.update") {
		return
	}
	var body plPipelineUpdateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.DisplayName == nil && body.Description == nil && body.Archived == nil && body.Folder == nil {
		plInvalid(w, "at least one of display_name, description, archived or folder is required.")
		return
	}
	var folder FolderPatch
	if body.Folder != nil {
		if string(*body.Folder) == "null" {
			folder.Clear = true
		} else {
			var s string
			if err := json.Unmarshal(*body.Folder, &s); err != nil {
				plInvalid(w, "folder must be a string or null (null clears it).")
				return
			}
			if len(s) < 1 || len(s) > 200 {
				plInvalid(w, "folder must be 1 to 200 characters.")
				return
			}
			folder.Set, folder.Value = true, s
		}
	}
	if body.DisplayName != nil && len(*body.DisplayName) > 200 {
		plInvalid(w, "display_name must be at most 200 characters.")
		return
	}
	if body.Description != nil && len(*body.Description) > 2000 {
		plInvalid(w, "description must be at most 2000 characters.")
		return
	}
	pipe, err := h.store.UpdatePipeline(r.Context(), c, pipelineID, PipelineUpdateInput{
		DisplayName: body.DisplayName, Description: body.Description, Archived: body.Archived,
		Folder: folder,
	})
	if err != nil {
		h.fail(w, r, c, pipelineID, "pipeline.update", err)
		return
	}
	if pipe.Revisions == nil {
		pipe.Revisions = []RevisionSummaryView{}
	}
	WriteJSON(w, http.StatusOK, pipe)
}

func (h *plHandlers) listRevisions(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	pipelineID := r.PathValue("pipelineId")
	items, err := h.store.ListPipelineRevisions(r.Context(), c, pipelineID)
	if err != nil {
		h.fail(w, r, c, pipelineID, "pipeline.revision.list", err)
		return
	}
	if items == nil {
		items = []RevisionSummaryView{}
	}
	WriteJSON(w, http.StatusOK, RevisionSummaryListView{Revisions: items})
}

func (h *plHandlers) listDrafts(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	pipelineID := r.PathValue("pipelineId")
	items, err := h.store.ListPipelineDrafts(r.Context(), c, pipelineID)
	if err != nil {
		h.fail(w, r, c, pipelineID, "pipeline.draft.list", err)
		return
	}
	if items == nil {
		items = []DraftSummaryView{}
	}
	WriteJSON(w, http.StatusOK, DraftSummaryListView{Drafts: items})
}

// createDraft is route 7: a new draft from {document_yaml} or a clone of a
// published revision. Either way the server records source_sha256 over the
// exact bytes it stores — the same hash validate/publish compare against,
// which is what makes draft_changed_since_validation a fact, not a guess.
func (h *plHandlers) createDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	pipelineID := r.PathValue("pipelineId")
	var body plDraftCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	hasDoc := body.DocumentYAML != nil && *body.DocumentYAML != ""
	hasClone := body.FromRevisionID != nil && *body.FromRevisionID != ""
	if hasDoc == hasClone {
		plInvalid(w, "exactly one of document_yaml or from_revision_id is required.")
		return
	}

	in := DraftCreateInput{}
	if hasDoc {
		if len(*body.DocumentYAML) > m4MaxDraftBytes {
			plInvalid(w, fmt.Sprintf("document_too_large: the document must be at most %d bytes.", m4MaxDraftBytes))
			return
		}
		in.DocumentYAML = *body.DocumentYAML
		in.SourceKind = "manual"
		in.SourceSHA256 = m4SHA256([]byte(in.DocumentYAML))
	} else {
		// A clone seeds from the revision's canonical document, exported
		// (regenerated) — the author's original bytes are not the
		// round-trippable form (ADR-0021 § 5).
		rev, err := h.store.GetRevision(r.Context(), c, *body.FromRevisionID)
		if err != nil {
			h.fail(w, r, c, pipelineID, "pipeline.draft.create", err)
			return
		}
		text, err := h.defs.Export(rev.CanonicalDocument)
		if err != nil {
			h.serverError(w, r, pipelineID, "pipeline.draft.create", err)
			return
		}
		in.DocumentYAML = text
		in.SourceKind = "clone"
		in.SourceSHA256 = m4SHA256([]byte(text))
	}

	draft, err := h.store.CreateDraft(r.Context(), c, pipelineID, in)
	if err != nil {
		h.fail(w, r, c, pipelineID, "pipeline.draft.create", err)
		return
	}
	w.Header().Set("Location", "/api/v1/drafts/"+draft.ID)
	WriteJSON(w, http.StatusCreated, normalizeDraftView(draft))
}

func (h *plHandlers) getDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	draftID := r.PathValue("draftId")
	draft, err := h.store.GetDraft(r.Context(), c, draftID)
	if err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.get", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeDraftView(draft))
}

// putDraft is route 9: a full document replacement under CAS. A stale
// version is 409 stale_draft_version carrying the winner's version — two
// open editor tabs must not silently overwrite each other.
func (h *plHandlers) putDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	draftID := r.PathValue("draftId")
	var body plDraftPutBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.DocumentYAML == "" {
		plInvalid(w, "document_yaml is required.")
		return
	}
	if len(body.DocumentYAML) > m4MaxDraftBytes {
		plInvalid(w, fmt.Sprintf("document_too_large: the document must be at most %d bytes.", m4MaxDraftBytes))
		return
	}
	if body.Version < 1 {
		plInvalid(w, "version must be at least 1.")
		return
	}
	draft, err := h.store.ReplaceDraft(r.Context(), c, draftID, body.DocumentYAML,
		m4SHA256([]byte(body.DocumentYAML)), body.Version)
	if err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.put", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeDraftView(draft))
}

// deleteDraft is route 10: discard an unpublished draft; a published one is
// the audit trail of a live revision and refuses with 409.
func (h *plHandlers) deleteDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	draftID := r.PathValue("draftId")
	if err := h.store.DeleteDraft(r.Context(), c, draftID); err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validateDraft is route 11. valid:true and valid:false are BOTH 200 — the
// verdict is in the body; the status code answers "was the request
// serviceable at all". The § 6 error cap is enforced here, not trusted from
// the validator, because a 2 000-error list is a browser outage regardless of
// which layer produced it.
func (h *plHandlers) validateDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	draftID := r.PathValue("draftId")
	draft, err := h.store.GetDraft(r.Context(), c, draftID)
	if err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.validate", err)
		return
	}
	outcome, err := h.defs.Validate(r.Context(), c, draft.DocumentYAML)
	if err != nil {
		h.serverError(w, r, draftID, "pipeline.draft.validate", err)
		return
	}
	body := capValidateErrors(outcome.Body)
	status := "invalid"
	if body.Valid {
		status = "valid"
	}
	if _, err := h.store.RecordValidation(r.Context(), c, draftID, DraftValidationRecord{
		Status:            status,
		Body:              body,
		CanonicalDocument: outcome.CanonicalDocument,
		RevisionDigest:    outcome.RevisionDigest,
		CompiledPlan:      outcome.CompiledPlan,
		PlanDigest:        outcome.PlanDigest,
		DigestScope:       outcome.DigestScope,
	}); err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.validate", err)
		return
	}
	WriteJSON(w, http.StatusOK, body)
}

// publishDraft is route 12. Four gates, each with its own refusal, and no
// silent revalidate anywhere:
//
//  1. the draft's CURRENT validation must be valid (draft_not_valid — or,
//     when the blocking class is a secret literal, the 422 whose response
//     names the location and the shape but never the value, ADR-0021 Security);
//  2. the carried version must match (stale_draft_version with the winner);
//  3. the caller must hold the library role (403);
//  4. the document's revision_digest must not already be published in the
//     organization (revision_already_published with the existing revision id).
//
// The source_sha256 identity is structural, not checked twice: ReplaceDraft
// clears validation and digests with the document, so a draft still at
// status='valid' is valid AT ITS CURRENT source_sha256 by construction.
func (h *plHandlers) publishDraft(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	draftID := r.PathValue("draftId")
	if !h.requireLibraryRole(w, r, c, "pipeline.draft.publish") {
		return
	}
	var body plDraftPublishBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Version < 1 {
		plInvalid(w, "version must be at least 1.")
		return
	}
	if body.VersionLabel != "" && !m4SemverPattern.MatchString(body.VersionLabel) {
		plInvalid(w, "version_label must be a semver X.Y.Z.")
		return
	}

	draft, err := h.store.GetDraft(r.Context(), c, draftID)
	if err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.publish", err)
		return
	}
	if draft.Status != "valid" {
		h.refuseUnpublishable(w, r, draft)
		return
	}
	if draft.Version != body.Version {
		m4WriteDraftConflict(w, &DraftConflictError{
			Kind: DraftConflictStaleVersion, DraftID: draft.ID, CurrentVersion: draft.Version,
			Detail: fmt.Sprintf("draft version is %d, not %d.", draft.Version, body.Version),
		})
		return
	}
	if draft.RevisionDigest != nil && *draft.RevisionDigest != "" {
		if existing, err := h.store.GetRevision(r.Context(), c, *draft.RevisionDigest); err == nil {
			m4WriteDraftConflict(w, &DraftConflictError{
				Kind: DraftConflictAlreadyPublished, DraftID: draft.ID,
				ExistingRevisionID: existing.ID,
				Detail: fmt.Sprintf("a revision with this document's digest is already published (%s).",
					existing.ID),
			})
			return
		} else if !errors.Is(err, ErrPipelineNotFound) {
			h.fail(w, r, c, draftID, "pipeline.draft.publish", err)
			return
		}
	}

	versionLabel := body.VersionLabel
	if versionLabel == "" {
		// The server assigns the next label for the revision number
		// (DraftPublish, api/openapi.yaml): N.0.0 where N is the number the
		// revision will take.
		pipe, err := h.store.GetPipeline(r.Context(), c, draft.PipelineID)
		if err != nil {
			h.fail(w, r, c, draftID, "pipeline.draft.publish", err)
			return
		}
		versionLabel = fmt.Sprintf("%d.0.0", pipe.LatestRevisionNumber+1)
	}
	documentText, err := h.defs.Export(draft.CanonicalDocument)
	if err != nil {
		h.serverError(w, r, draftID, "pipeline.draft.publish", err)
		return
	}

	rev, err := h.store.PublishDraft(r.Context(), c, draftID, DraftPublishInput{
		ExpectedVersion: body.Version,
		VersionLabel:    versionLabel,
		DocumentText:    documentText,
		SchemaDigest:    schema.Digest(),
		CelEnvDigest:    h.defs.EnvDigest(),
	})
	if err != nil {
		h.fail(w, r, c, draftID, "pipeline.draft.publish", err)
		return
	}
	w.Header().Set("Location", "/api/v1/revisions/"+rev.ID)
	WriteJSON(w, http.StatusCreated, normalizeRevisionView(rev))
}

// refuseUnpublishable answers a publish of a not-valid draft: the secret
// literal block is its own 422 (its location and shape are safe to say; the
// value never is), everything else is the draft_not_valid 409.
func (h *plHandlers) refuseUnpublishable(w http.ResponseWriter, r *http.Request, draft DraftView) {
	if draft.Status == "published" {
		m4WriteDraftConflict(w, &DraftConflictError{
			Kind: DraftConflictPublished, DraftID: draft.ID,
			Detail: "this draft is already published and immutable.",
		})
		return
	}
	for _, e := range draftValidateErrors(draft.Validation) {
		if e.Code == DraftConflictSecretLiteral {
			m4SecretLiteralProblem(w,
				fmt.Sprintf("a secret-shaped literal sits at %s; move it to a secret reference. "+
					"The value is never quoted (ADR-0021 Security).", m4DerefOr(e.InstanceLocation, "an unresolved location")))
			return
		}
	}
	m4WriteDraftConflict(w, &DraftConflictError{
		Kind: DraftConflictNotValid, DraftID: draft.ID,
		Detail: "the draft's current validation is not valid; validate it again after editing.",
	})
}

func (h *plHandlers) getRevision(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	seg := r.PathValue("digestOrId")
	// A segment that is neither a uuid nor a well-formed digest cannot
	// resolve anywhere; it gets the same 404 as a digest of another org, so
	// the route is not a probe surface.
	if !validUUID(seg) && !m4DigestPattern.MatchString(seg) {
		h.denied(w, r, c, seg, "pipeline.revision.get", "malformed revision id or digest")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such revision.")
		return
	}
	rev, err := h.store.GetRevision(r.Context(), c, seg)
	if err != nil {
		h.fail(w, r, c, seg, "pipeline.revision.get", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeRevisionView(rev))
}

// getRevisionDocument is route 14: the honest textual form, regenerated
// from the canonical document so a download-and-republish round trip
// canonicalizes to the same digest.
func (h *plHandlers) getRevisionDocument(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	revisionID := r.PathValue("revisionId")
	if f := r.URL.Query().Get("format"); f != "" && f != "yaml" {
		plInvalid(w, "format must be yaml.")
		return
	}
	rev, err := h.store.GetRevision(r.Context(), c, revisionID)
	if err != nil {
		h.fail(w, r, c, revisionID, "pipeline.revision.document", err)
		return
	}
	text, err := h.defs.Export(rev.CanonicalDocument)
	if err != nil {
		h.serverError(w, r, revisionID, "pipeline.revision.document", err)
		return
	}
	w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, text)
}

// deprecateRevision is route 15: a signal to humans, never an execution
// kill switch — existing runs keep their pinned revision (ADR-0002).
func (h *plHandlers) deprecateRevision(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	revisionID := r.PathValue("revisionId")
	if !h.requireLibraryRole(w, r, c, "pipeline.revision.deprecate") {
		return
	}
	rev, err := h.store.DeprecateRevision(r.Context(), c, revisionID)
	if err != nil {
		h.fail(w, r, c, revisionID, "pipeline.revision.deprecate", err)
		return
	}
	WriteJSON(w, http.StatusOK, normalizeRevisionView(rev))
}

// getSchema is route 16: the served schema verbatim ($id and all) so the UI
// never bundles a copy that can drift from the compiler's (ADR-0021 § 7).
// Session required, no membership — the schema is public structure, not
// tenant content.
func (h *plHandlers) getSchema(w http.ResponseWriter, r *http.Request) {
	if _, ok := PrincipalFrom(r.Context()); !ok {
		h.serverError(w, r, "", "pipeline.schema", errors.New("api: no principal in context"))
		return
	}
	raw := schema.JSON()
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// --- shared plumbing ----------------------------------------------------------

func (h *plHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireLibraryRole is the `01` matrix row "Publish shared pipeline
// revision". The organization-wide library role has no column of its own in
// this schema yet, so the fail-closed reading is enforced: only an
// organization admin holds it today, and widening it is an additive change
// to this one predicate (reported as a deviation).
func (h *plHandlers) requireLibraryRole(w http.ResponseWriter, r *http.Request, c Caller, action string) bool {
	if c.IsOrgAdmin {
		return true
	}
	h.log(r).WarnContext(r.Context(), "library role denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Publishing or editing the shared pipeline library requires the organization's library role.")
	return false
}

// fail maps a definition-store error onto the HTTP contract: the typed
// draft conflicts render their problem bodies (the loser must see the
// winner, not re-guess), a cross-org or unknown object is the uniform 404
// with an audit row, and a bare unique clash is a plain 409.
func (h *plHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action string, err error) {
	var conflict *DraftConflictError
	if errors.As(err, &conflict) {
		if conflict.DraftID == "" {
			conflict.DraftID = resourceID
		}
		h.denied(w, r, c, resourceID, action, conflict.Kind)
		switch conflict.Kind {
		case DraftConflictSecretLiteral:
			m4SecretLiteralProblem(w, conflict.Detail)
		default:
			m4WriteDraftConflict(w, conflict)
		}
		return
	}
	switch {
	case errors.Is(err, ErrPipelineNotFound):
		h.denied(w, r, c, resourceID, action, "no such object, or it is not visible to your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such object.")
	case errors.Is(err, ErrPipelineConflict):
		WriteProblem(w, http.StatusConflict, "Conflict",
			"The request conflicts with existing state (a unique name, label or digest already exists).")
	default:
		h.serverError(w, r, resourceID, action, err)
	}
}

// denied records a refused attempt; the recording itself failing must not
// change the answer the client gets.
func (h *plHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, resourceID, action, reason string) {
	if err := h.store.RecordDenied(r.Context(), c, resourceID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action),
			slog.String("resource_id", resourceID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "pipeline access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("resource_id", resourceID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *plHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "pipeline store failure",
		slog.String("action", action),
		slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *plHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (h *plHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
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

// plInvalid writes the 422 problem+json every body-validation failure shares.
func plInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// m4SemverPattern is the version_label grammar (^\d+\.\d+\.\d+$).
var m4SemverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// m4SHA256 is the lowercase hex of the bytes — source_sha256 and
// request_sha256 are both exactly this over the bytes the server received.
func m4SHA256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func m4DerefOr(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

func m4OrEmptyJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}

func m4OrEmptyJSONArray(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("[]")
	}
	return raw
}

func m4OrNULL(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

// normalizeDraftView / normalizeRevisionView make the openapi "empty array
// or object, never null" shape rules true regardless of what an adapter
// returned, so one forgetful adapter cannot send the UI a null to crash on.
func normalizeDraftView(d DraftView) DraftView {
	d.UILayout = m4OrEmptyJSON(d.UILayout)
	if len(d.Validation) == 0 {
		d.Validation = json.RawMessage("null")
	}
	return d
}

func normalizeRevisionView(r RevisionView) RevisionView {
	r.UILayout = m4OrEmptyJSON(r.UILayout)
	r.CanonicalDocument = m4OrEmptyJSON(r.CanonicalDocument)
	r.CompiledPlan = m4OrEmptyJSON(r.CompiledPlan)
	return r
}

// capValidateErrors enforces the § 6 response cap in the API layer: at most
// 200 findings, then truncation is a note the tooling must surface.
func capValidateErrors(body ValidateResponse) ValidateResponse {
	if body.Errors == nil {
		body.Errors = []ValidateError{}
	}
	if body.Notes == nil {
		body.Notes = []string{}
	}
	if len(body.Errors) > m4MaxValidateErrors {
		body.Errors = body.Errors[:m4MaxValidateErrors]
		body.Notes = append(body.Notes, "errors_truncated")
	}
	return body
}

// draftValidateErrors decodes a draft's stored validation body far enough to
// scan its codes; unreadable JSON simply yields no findings (the draft's
// status is the gate, this only enriches the refusal).
func draftValidateErrors(raw json.RawMessage) []ValidateError {
	if len(raw) == 0 {
		return nil
	}
	var body ValidateResponse
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	return body.Errors
}

// m4SecretLiteralProblem writes the publish gate's invariant-5 refusal (m4
// contract § 2.2 + § 7.1 C13c): the 422 carries the § 2.2 code the validate
// endpoint already returns for the same finding — `secret_literal_detected`
// — as a stable `code` member beside the matching `type` URI, so a client
// switches on the code rather than parsing prose or the URI tail. The body
// names the location and the shape and NEVER the literal (ADR-0021 Security).
func m4SecretLiteralProblem(w http.ResponseWriter, detail string) {
	m4WriteTypedProblemExtra(w, http.StatusUnprocessableEntity, "secret-literal-detected",
		"Secret Literal Detected", detail, struct {
			Code string `json:"code"`
		}{Code: DraftConflictSecretLiteral})
}

// m4WriteTypedProblem writes a problem+json whose type member is the stable
// errors:// URI of the named code — the § 2 convention of "detail-embedded
// code" made machine-readable the way the rest of this API already does it
// (ConversationConflictProblem), and the extra members (if any) ride beside
// the four Problem fields.
func m4WriteTypedProblem(w http.ResponseWriter, status int, code, title, detail string) {
	m4WriteTypedProblemExtra(w, status, code, title, detail, nil)
}

func m4WriteTypedProblemExtra(w http.ResponseWriter, status int, code, title, detail string, extra any) {
	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if extra != nil {
		_ = json.NewEncoder(w).Encode(m4MergeProblem("https://communication.dev/errors/"+code,
			title, status, detail, extra))
		return
	}
	_ = json.NewEncoder(w).Encode(Problem{
		Type:   "https://communication.dev/errors/" + code,
		Title:  title,
		Status: status,
		Detail: detail,
	})
}

// m4ProblemOverlay merges the four Problem fields with a conflict body's
// extra members into one JSON object (the extra struct may not redefine the
// Problem fields; if it does, the Problem wins, as the schema requires).
func m4MergeProblem(typ, title string, status int, detail string, extra any) json.RawMessage {
	base := map[string]any{
		"type":   typ,
		"title":  title,
		"status": status,
	}
	if detail != "" {
		base["detail"] = detail
	}
	if extra != nil {
		raw, err := json.Marshal(extra)
		if err == nil {
			var over map[string]any
			if json.Unmarshal(raw, &over) == nil {
				for k, v := range over {
					if k != "type" && k != "title" && k != "status" {
						base[k] = v
					}
				}
			}
		}
	}
	out, err := json.Marshal(base)
	if err != nil {
		return json.RawMessage(`{"type":"about:blank","status":` + fmt.Sprint(status) + `}`)
	}
	return out
}

// m4WriteDraftConflict renders the DraftConflictProblem schema: a Problem
// plus what the draft is now (current_version for a CAS miss,
// existing_revision_id for a digest collision) so the editor recovers by
// re-reading, never by guessing.
func m4WriteDraftConflict(w http.ResponseWriter, conflict *DraftConflictError) {
	code := strings.ReplaceAll(conflict.Kind, "_", "-")
	title := m4DraftConflictTitles[conflict.Kind]
	if title == "" {
		title = "Draft Conflict"
	}
	detail := conflict.Detail
	if detail == "" {
		detail = "The request conflicts with the draft's current state."
	}
	extra := struct {
		DraftID            string  `json:"draft_id"`
		CurrentVersion     int     `json:"current_version,omitempty"`
		ExistingRevisionID *string `json:"existing_revision_id,omitempty"`
	}{DraftID: conflict.DraftID, CurrentVersion: conflict.CurrentVersion}
	if conflict.ExistingRevisionID != "" {
		id := conflict.ExistingRevisionID
		extra.ExistingRevisionID = &id
	}
	m4WriteTypedProblemExtra(w, http.StatusConflict, code, title, detail, extra)
}

var m4DraftConflictTitles = map[string]string{
	DraftConflictStaleVersion:     "Draft Version Stale",
	DraftConflictChangedSinceVal:  "Draft Changed Since Validation",
	DraftConflictNotValid:         "Draft Not Valid",
	DraftConflictAlreadyPublished: "Revision Already Published",
	DraftConflictPublished:        "Draft Already Published",
}
