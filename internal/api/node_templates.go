package api

// The node-template ("Step") registry, ADR-0049 part 1 (docs/adr/
// ADR-0049-step-registry-and-folders.md § 3): the org-scoped registry the
// design's Steps page reads. Part 1 ships list/get/create, immutable
// revisions and duplicate; compiler resolution (§ 2) and adopt-drafts
// (§ 5) land in part 2 — the revision endpoint already carries their
// response shape and answers `adopted: []` honestly while the refs table
// is empty.
//
// The same three rules as the pipeline surface (pipelines.go):
//
//   - Templates are ORG-scoped. A template of another organization is the
//     uniform 404, byte-identical to nonsense — its existence never leaks.
//   - Revisions are immutable: there is no mutation route to a revision row;
//     a new version is a new row (ADR-0002's rule, structural).
//   - The API never computes a revision digest. The store canonicalizes the
//     four content members (ADR-0021, scope v1alpha1-canonical-1) so what
//     is pinned is exactly what was published.
//
// Permissions (ADR-0049 § 7): read = any org member (the same visibility
// rule as GET /pipelines); write = the organization's library role, the
// exact IsOrgAdmin gate the pipeline library and agent-profile writes use.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// Errors the node-template handlers understand. The store adapter maps its
// own sentinels onto these; 404 is the invisible-resource answer (house
// style), 409 a slug or version_label clash inside the caller's org.
var (
	ErrNodeTemplateNotFound = errors.New("api: node template not found")
	ErrNodeTemplateConflict = errors.New("api: node template unique constraint violation")
	// ErrNodeTemplateDraftNotValidated is from_node's 400: the draft exists
	// and is visible but has no validated canonical document yet, so there is
	// no node config to copy (ADR-0049 § 6).
	ErrNodeTemplateDraftNotValidated = errors.New("api: draft has no validated canonical document")
)

// ntSemverPattern is 07's semver: the revision's version label, unique per
// template (the database CHECK is the last line, this is the fast one).
var ntSemverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// ntWorkspaceModes are the two pinned per revision (ADR-0049 § 1/Security).
var ntWorkspaceModes = map[string]bool{
	"run_workspace": true,
	"read_only":     true,
}

// ntKindCatalogue is the v1alpha1 kind catalogue: the nine kinds M4 executes
// plus the seven deferred-but-validated ones. A template `kind` outside it
// can never resolve, so create refuses it (400) before the database.
func ntKindCatalogue() map[string]bool {
	m := map[string]bool{}
	for _, k := range compiler.ExecutedKinds() {
		m[k] = true
	}
	for _, k := range compiler.DeferredKinds() {
		m[k] = true
	}
	return m
}

// --- inputs (handler → store) ----------------------------------------------

// NodeTemplateCreateInput is POST /node-templates' body with the handler's
// defaults already applied (version_label 1.0.0, workspace_mode
// run_workspace, output_schema {}).
type NodeTemplateCreateInput struct {
	Slug          string
	DisplayName   string
	Description   string
	Kind          string
	Parameters    json.RawMessage
	Config        json.RawMessage
	OutputSchema  json.RawMessage
	WorkspaceMode string
	VersionLabel  string
}

// NodeTemplateRevisionInput is POST /node-templates/{id}/revisions' body —
// "Edit for all N workflows → version x.y.z" from the UI side. AdoptUsing
// Workflows is part 2's § 5; part 1 stores the revision either way and the
// response's adopted/skipped arrays are honestly empty (the refs table is
// empty until publish writes it).
type NodeTemplateRevisionInput struct {
	Parameters    json.RawMessage
	Config        json.RawMessage
	OutputSchema  json.RawMessage
	WorkspaceMode string
	VersionLabel  string
	AdoptUsing    bool
}

// --- views (store → handler → wire) ------------------------------------------

// NodeTemplateRevisionSummary is NodeTemplate's latest_revision member: the
// identity of the newest revision, never its content.
type NodeTemplateRevisionSummary struct {
	RevisionID     string    `json:"revision_id"`
	RevisionNumber int       `json:"revision_number"`
	VersionLabel   string    `json:"version_label"`
	RevisionDigest string    `json:"revision_digest"`
	CreatedAt      time.Time `json:"created_at"`
}

// NodeTemplateView is the NodeTemplate schema: the template row plus its
// latest revision summary and the § 4 usage count (computed, not stored).
type NodeTemplateView struct {
	ID             string                      `json:"id"`
	Slug           string                      `json:"slug"`
	DisplayName    string                      `json:"display_name"`
	Kind           string                      `json:"kind"`
	Description    string                      `json:"description"`
	Status         string                      `json:"status"`
	LatestRevision NodeTemplateRevisionSummary `json:"latest_revision"`
	UsedInCount    int                         `json:"used_in_count"`
	CreatedBy      string                      `json:"created_by"`
	CreatedAt      time.Time                   `json:"created_at"`
	UpdatedAt      time.Time                   `json:"updated_at"`
}

// NodeTemplateListView is GET /node-templates' envelope. NextCursor is
// null: part 1 lists the whole organization's registry in one page (the
// M4 list idiom, same as /pipelines).
type NodeTemplateListView struct {
	Templates  []NodeTemplateView `json:"templates"`
	NextCursor *string            `json:"next_cursor"`
}

// NodeTemplateRevisionView is the NodeTemplateRevision schema: one
// immutable revision, content included.
type NodeTemplateRevisionView struct {
	RevisionID     string          `json:"revision_id"`
	RevisionNumber int             `json:"revision_number"`
	VersionLabel   string          `json:"version_label"`
	Parameters     json.RawMessage `json:"parameters"`
	Config         json.RawMessage `json:"config"`
	OutputSchema   json.RawMessage `json:"output_schema"`
	WorkspaceMode  string          `json:"workspace_mode"`
	RevisionDigest string          `json:"revision_digest"`
	CreatedBy      string          `json:"created_by"`
	CreatedAt      time.Time       `json:"created_at"`
}

// TemplateUsage is one row of the § 4 query: a workflow whose LATEST
// published revision references this template. UpToDate is true iff it
// references the template's latest revision — the honest signal behind the
// "live status per use" (no invented run states).
type TemplateUsage struct {
	PipelineID          string   `json:"pipeline_id"`
	PipelineSlug        string   `json:"pipeline_slug"`
	PipelineDisplayName string   `json:"pipeline_display_name"`
	RevisionNumber      int      `json:"revision_number"`
	TemplateRevisionID  string   `json:"template_revision_id"`
	NodeIDs             []string `json:"node_ids"`
	UpToDate            bool     `json:"up_to_date"`
}

// NodeTemplateDetailView is GET /node-templates/{id}'s body: the template,
// its full revision history (newest first) and its usages — one query per
// relation, no N+1.
type NodeTemplateDetailView struct {
	Template  NodeTemplateView           `json:"template"`
	Revisions []NodeTemplateRevisionView `json:"revisions"`
	Usages    []TemplateUsage            `json:"usages"`
}

// TemplateAdoption is one § 5 adopted draft (part 2 fills this; part 1
// leaves the array empty — there are no refs to adopt yet).
type TemplateAdoption struct {
	PipelineID   string `json:"pipeline_id"`
	PipelineSlug string `json:"pipeline_slug"`
	DraftID      string `json:"draft_id"`
	DraftVersion int    `json:"draft_version"`
}

// TemplateAdoptionSkipped is a § 5 skip: the pipeline has an open draft the
// adopt flow must never clobber.
type TemplateAdoptionSkipped struct {
	PipelineID string `json:"pipeline_id"`
	Reason     string `json:"reason"`
}

// NodeTemplateRevisionCreateResponse is POST /{id}/revisions' 201 body.
type NodeTemplateRevisionCreateResponse struct {
	Revision NodeTemplateRevisionView  `json:"revision"`
	Adopted  []TemplateAdoption        `json:"adopted"`
	Skipped  []TemplateAdoptionSkipped `json:"skipped"`
}

// NodeTemplateStore is the registry's persistence face: every method
// enforces the caller's organization itself (a foreign template is
// ErrNodeTemplateNotFound) and writes its ADR-0049 § 7 journal row in the
// same transaction as its state write.
type NodeTemplateStore interface {
	ListTemplates(ctx context.Context, c Caller) ([]NodeTemplateView, error)
	GetTemplate(ctx context.Context, c Caller, templateID string) (NodeTemplateDetailView, error)
	CreateTemplate(ctx context.Context, c Caller, in NodeTemplateCreateInput) (NodeTemplateView, error)
	CreateTemplateRevision(ctx context.Context, c Caller, templateID string, in NodeTemplateRevisionInput) (NodeTemplateRevisionCreateResponse, error)
	DuplicateTemplate(ctx context.Context, c Caller, templateID, slug, displayName string) (NodeTemplateView, error)
	// NodeFromDraft (ADR-0049 § 6): the kind and config of one node in a
	// draft's validated canonical document, for from_node create.
	NodeFromDraft(ctx context.Context, c Caller, draftID, nodeID string) (kind string, config json.RawMessage, err error)
	// RecordDenied writes the audit row for a refused read or mutation.
	RecordDenied(ctx context.Context, c Caller, resourceID, action string) error
}

// --- request bodies -----------------------------------------------------------

type ntCreateBody struct {
	Slug          string          `json:"slug"`
	DisplayName   string          `json:"display_name"`
	Description   string          `json:"description,omitempty"`
	Kind          string          `json:"kind"`
	Parameters    json.RawMessage `json:"parameters"`
	Config        json.RawMessage `json:"config"`
	OutputSchema  json.RawMessage `json:"output_schema,omitempty"`
	WorkspaceMode string          `json:"workspace_mode,omitempty"`
	VersionLabel  string          `json:"version_label,omitempty"`
	// FromNode is ADR-0049 § 6 ("also save as a reusable step"): the kind and
	// config come from the named node of the named draft's validated
	// canonical document, and the parameterization starts empty.
	FromNode *struct {
		DraftID string `json:"draft_id"`
		NodeID  string `json:"node_id"`
	} `json:"from_node,omitempty"`
}

type ntRevisionBody struct {
	Parameters          json.RawMessage `json:"parameters"`
	Config              json.RawMessage `json:"config"`
	OutputSchema        json.RawMessage `json:"output_schema,omitempty"`
	WorkspaceMode       string          `json:"workspace_mode,omitempty"`
	VersionLabel        string          `json:"version_label"`
	AdoptUsingWorkflows bool            `json:"adopt_using_workflows,omitempty"`
}

type ntDuplicateBody struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
}

// --- handlers ------------------------------------------------------------------

func RegisterNodeTemplates(s *Server, store NodeTemplateStore) {
	h := &ntHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/node-templates", http.HandlerFunc(h.list))
	s.HandleAuthed("POST /api/v1/node-templates", http.HandlerFunc(h.create))
	s.HandleAuthed("GET /api/v1/node-templates/{templateId}", http.HandlerFunc(h.get))
	// The ADR-0049 prose writes `POST /node-templates/{id}:duplicate`; the
	// Go 1.22 ServeMux wildcard must be a whole segment, so the route is
	// the `/duplicate` action-segment the house already uses for
	// /deprecate, /decide and /publish.
	s.HandleAuthed("POST /api/v1/node-templates/{templateId}/revisions", http.HandlerFunc(h.createRevision))
	s.HandleAuthed("POST /api/v1/node-templates/{templateId}/duplicate", http.HandlerFunc(h.duplicate))
}

type ntHandlers struct {
	store NodeTemplateStore
	srv   *Server
}

func (h *ntHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireWriteRole is ADR-0049 § 7's write gate: the organization's library
// role, the exact IsOrgAdmin gate the pipeline library and agent-profile
// writes use. Non-admin → 403 (a member who can read every template still
// cannot create one).
func (h *ntHandlers) requireWriteRole(w http.ResponseWriter, r *http.Request, c Caller) bool {
	if c.IsOrgAdmin {
		return true
	}
	h.log(r).WarnContext(r.Context(), "step registry write denied",
		slog.String("user_id", c.UserID),
		slog.String("request_id", RequestIDFrom(r)))
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Writing the shared step registry requires the organization's library role.")
	return false
}

// ntInvalid is the uniform 400 for a body the handler refuses before the
// store sees it (same shape as plInvalid's contract in pipelines.go).
func ntInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusBadRequest, "Bad Request", detail)
}

// ntContentOK is the four-content-member gate: parameters and config are
// required objects, output_schema an object ({} when absent).
func ntContentOK(w http.ResponseWriter, parameters, config, outputSchema json.RawMessage) (json.RawMessage, json.RawMessage, json.RawMessage, bool) {
	var p, c, o any
	if err := json.Unmarshal(parameters, &p); err != nil || p == nil {
		ntInvalid(w, "parameters must be a JSON-schema object.")
		return nil, nil, nil, false
	}
	if _, ok := p.(map[string]any); !ok {
		ntInvalid(w, "parameters must be a JSON-schema object.")
		return nil, nil, nil, false
	}
	if err := json.Unmarshal(config, &c); err != nil || c == nil {
		ntInvalid(w, "config must be a JSON object.")
		return nil, nil, nil, false
	}
	if _, ok := c.(map[string]any); !ok {
		ntInvalid(w, "config must be a JSON object.")
		return nil, nil, nil, false
	}
	if len(outputSchema) == 0 {
		outputSchema = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(outputSchema, &o); err != nil {
		ntInvalid(w, "output_schema must be a JSON object.")
		return nil, nil, nil, false
	}
	if _, ok := o.(map[string]any); !ok {
		ntInvalid(w, "output_schema must be a JSON object.")
		return nil, nil, nil, false
	}
	return parameters, config, outputSchema, true
}

// ntWorkspaceMode applies the default and the two-value gate.
func ntWorkspaceMode(w http.ResponseWriter, mode string) string {
	if mode == "" {
		return "run_workspace"
	}
	if !ntWorkspaceModes[mode] {
		ntInvalid(w, "workspace_mode must be run_workspace or read_only.")
		return ""
	}
	return mode
}

// ntVersionLabel applies the 1.0.0 default and the semver gate.
func ntVersionLabel(w http.ResponseWriter, label string, required bool) string {
	if label == "" {
		if required {
			ntInvalid(w, "version_label is required and must be a semantic version (e.g. 1.0.0).")
			return ""
		}
		return "1.0.0"
	}
	if !ntSemverPattern.MatchString(label) {
		ntInvalid(w, "version_label must be a semantic version (major.minor.patch).")
		return ""
	}
	return label
}

// ntSlug checks the pattern and the display-name bounds in one place.
func ntSlug(w http.ResponseWriter, slug, displayName string) bool {
	if !m4SlugPattern.MatchString(slug) {
		ntInvalid(w, "slug must match "+m4SlugPattern.String()+".")
		return false
	}
	if len(displayName) < 1 || len(displayName) > 200 {
		ntInvalid(w, "display_name is required and must be at most 200 characters.")
		return false
	}
	return true
}

// list is GET /node-templates: any org member, the whole registry.
func (h *ntHandlers) list(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	items, err := h.store.ListTemplates(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, "", err)
		return
	}
	WriteJSON(w, http.StatusOK, NodeTemplateListView{Templates: items})
}

// create is POST /node-templates: the template row and its revision 1 in
// one transaction (store side), 201 with the full NodeTemplate.
func (h *ntHandlers) create(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	var body ntCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	// ADR-0049 § 6 ("also save as a reusable step"): from_node owns the
	// kind and the config — they come from the named node of the named
	// draft's validated canonical document — and the parameterization starts
	// empty ({} parameters schema, output_schema {"type":"object"}) so the
	// first revision's behaviour is byte-identical to the inline node.
	if body.FromNode != nil {
		if body.FromNode.DraftID == "" || body.FromNode.NodeID == "" {
			ntInvalid(w, "from_node requires draft_id and node_id.")
			return
		}
		kind, config, err := h.store.NodeFromDraft(r.Context(), c, body.FromNode.DraftID, body.FromNode.NodeID)
		if err != nil {
			h.failFromNode(w, r, c, err)
			return
		}
		body.Kind = kind
		body.Config = config
		if len(body.Parameters) == 0 {
			body.Parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		if len(body.OutputSchema) == 0 {
			body.OutputSchema = json.RawMessage(`{"type":"object"}`)
		}
	}
	if !ntSlug(w, body.Slug, body.DisplayName) {
		return
	}
	if body.Kind == "" {
		ntInvalid(w, "kind is required — the implemented kind the template wraps.")
		return
	}
	if !ntKindCatalogue()[body.Kind] {
		ntInvalid(w, "kind "+body.Kind+" is not in the v1alpha1 catalogue.")
		return
	}
	if len(body.Description) > 2000 {
		ntInvalid(w, "description must be at most 2000 characters.")
		return
	}
	params, config, outSchema, ok := ntContentOK(w, body.Parameters, body.Config, body.OutputSchema)
	if !ok {
		return
	}
	workspaceMode := ntWorkspaceMode(w, body.WorkspaceMode)
	if workspaceMode == "" {
		return
	}
	versionLabel := ntVersionLabel(w, body.VersionLabel, false)
	if versionLabel == "" {
		return
	}
	view, err := h.store.CreateTemplate(r.Context(), c, NodeTemplateCreateInput{
		Slug:          body.Slug,
		DisplayName:   body.DisplayName,
		Description:   body.Description,
		Kind:          body.Kind,
		Parameters:    params,
		Config:        config,
		OutputSchema:  outSchema,
		WorkspaceMode: workspaceMode,
		VersionLabel:  versionLabel,
	})
	if err != nil {
		h.fail(w, r, c, "", err)
		return
	}
	WriteJSON(w, http.StatusCreated, view)
}

// get is GET /node-templates/{id}: the template, its full revision history
// and its usages.
func (h *ntHandlers) get(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	templateID := r.PathValue("templateId")
	detail, err := h.store.GetTemplate(r.Context(), c, templateID)
	if err != nil {
		h.fail(w, r, c, templateID, err)
		return
	}
	WriteJSON(w, http.StatusOK, detail)
}

// createRevision is POST /{id}/revisions: the immutable revision N+1
// ("Edit for all"). A version_label the template already carries is 409.
func (h *ntHandlers) createRevision(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	templateID := r.PathValue("templateId")
	var body ntRevisionBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	params, config, outSchema, ok2 := ntContentOK(w, body.Parameters, body.Config, body.OutputSchema)
	if !ok2 {
		return
	}
	workspaceMode := ntWorkspaceMode(w, body.WorkspaceMode)
	if workspaceMode == "" {
		return
	}
	versionLabel := ntVersionLabel(w, body.VersionLabel, true)
	if versionLabel == "" {
		return
	}
	resp, err := h.store.CreateTemplateRevision(r.Context(), c, templateID, NodeTemplateRevisionInput{
		Parameters:    params,
		Config:        config,
		OutputSchema:  outSchema,
		WorkspaceMode: workspaceMode,
		VersionLabel:  versionLabel,
		AdoptUsing:    body.AdoptUsingWorkflows,
	})
	if err != nil {
		h.fail(w, r, c, templateID, err)
		return
	}
	WriteJSON(w, http.StatusCreated, resp)
}

// duplicate is POST /{id}/duplicate: a NEW template whose revision 1 is a
// content copy of the source's latest revision.
func (h *ntHandlers) duplicate(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	if !h.requireWriteRole(w, r, c) {
		return
	}
	templateID := r.PathValue("templateId")
	var body ntDuplicateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !ntSlug(w, body.Slug, body.DisplayName) {
		return
	}
	view, err := h.store.DuplicateTemplate(r.Context(), c, templateID, body.Slug, body.DisplayName)
	if err != nil {
		h.fail(w, r, c, templateID, err)
		return
	}
	WriteJSON(w, http.StatusCreated, view)
}

// failFromNode maps a from_node read failure onto the HTTP contract: a draft
// or node the caller cannot see is the uniform 404 (with audit row), an
// unvalidated draft the honest 400.
func (h *ntHandlers) failFromNode(w http.ResponseWriter, r *http.Request, c Caller, err error) {
	switch {
	case errors.Is(err, ErrNodeTemplateNotFound):
		h.denied(w, r, c, "", "no such object, or it is not visible to your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such object.")
	case errors.Is(err, ErrNodeTemplateDraftNotValidated):
		ntInvalid(w, "The draft has no validated document yet; validate it first, then save the step from its node.")
	default:
		h.serverError(w, r, "", "node_template.store", err)
	}
}

// fail maps a registry-store error onto the HTTP contract: a cross-org or
// unknown template is the uniform 404 with an audit row, a bare unique
// clash (slug or version_label) a plain 409.
func (h *ntHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, resourceID string, err error) {
	switch {
	case errors.Is(err, ErrNodeTemplateNotFound):
		h.denied(w, r, c, resourceID, "no such object, or it is not visible to your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such object.")
	case errors.Is(err, ErrNodeTemplateConflict):
		WriteProblem(w, http.StatusConflict, "Conflict",
			"The request conflicts with existing state (a slug or version_label already exists).")
	default:
		h.serverError(w, r, resourceID, "node_template.store", err)
	}
}

func (h *ntHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, resourceID, reason string) {
	if err := h.store.RecordDenied(r.Context(), c, resourceID, "node_template.get"); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("user_id", c.UserID),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "step registry access denied",
		slog.String("user_id", c.UserID),
		slog.String("resource_id", resourceID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *ntHandlers) serverError(w http.ResponseWriter, r *http.Request, resourceID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "step registry store failure",
		slog.String("action", action),
		slog.String("resource_id", resourceID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *ntHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (h *ntHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
	ntInvalid(w, "The request body is not valid JSON: "+err.Error())
}
