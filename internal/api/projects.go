package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/authz"
)

// Errors the project handlers understand. A store adapter (see
// internal/store/postgres.APIProjectStore) maps its own errors onto these so
// this package stays free of any driver or database dependency.
var (
	// ErrProjectNotFound is also the answer to "you may not know this project
	// exists": ADR-0014 §3 makes non-members see 404, never 403.
	ErrProjectNotFound = errors.New("api: project not found")
	// ErrProjectConflict is a unique-constraint clash: duplicate project slug
	// in the organization, or duplicate repository name in the project.
	ErrProjectConflict = errors.New("api: unique constraint violation")
	// ErrRepositoryCredentialInvalid is ADR-0061's reference-rule refusal: a
	// credential_secret_id that names no secret, another project's secret, or
	// a secret whose delivery mode is not integration_broker. Handlers answer
	// it with 422 and the typed code `invalid_credential_secret`.
	ErrRepositoryCredentialInvalid = errors.New("api: repository credential secret is not valid for this project")
)

// Caller is the authenticated principal reduced to what project
// authorization needs. Handlers build it from the session Principal, never
// from a header or a path value (communication-spec/06-collaboration-identity
// md: "Project-scoped identity claims cannot be trusted just because an ID is
// present in a URL").
type Caller struct {
	UserID         string
	OrganizationID string
	IsOrgAdmin     bool
}

// ProjectView is the Project schema of api/openapi.yaml. Organization
// membership is implied by authorization and is deliberately not exposed.
type ProjectView struct {
	ID          string    `json:"id"`
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	Version     int       `json:"version"`
	MyRole      string    `json:"my_role"`
}

// RepositoryView is the Repository schema of api/openapi.yaml. Credential is
// derived ("none" | "configured") from the presence of CredentialSecretID —
// the ADR-0061 response never carries the value, and nothing here could: the
// store surface has no read path that returns one.
type RepositoryView struct {
	ID                 string    `json:"id"`
	ProjectID          string    `json:"project_id"`
	Name               string    `json:"name"`
	GitURL             string    `json:"git_url"`
	DefaultBranch      string    `json:"default_branch"`
	CreatedAt          time.Time `json:"created_at"`
	CredentialSecretID *string   `json:"credential_secret_id"`
	Credential         string    `json:"credential"`
}

// MemberView is the Member schema of api/openapi.yaml.
type MemberView struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
}

// ProjectStore is everything the project handlers need from the datastore.
// Every method is expected to enforce the caller's visibility itself — the
// handler cannot be the only gate, because the same store is used by later
// transports — and to return ErrProjectNotFound or ErrProjectConflict for the
// cases named in their doc comments.
type ProjectStore interface {
	ListProjects(ctx context.Context, c Caller) ([]ProjectView, error)
	CreateProject(ctx context.Context, c Caller, name, slug, description string) (ProjectView, error)
	GetProject(ctx context.Context, c Caller, projectID string) (ProjectView, error)
	ListRepositories(ctx context.Context, c Caller, projectID string) ([]RepositoryView, error)
	// AddRepository attaches a remote; credentialSecretID (ADR-0061) is ""
	// for none and must be a same-project (or same-org) integration_broker
	// secret, else ErrRepositoryCredentialInvalid.
	AddRepository(ctx context.Context, c Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (RepositoryView, error)
	// PatchRepositoryCredential sets or clears ("") the ADR-0061 credential.
	PatchRepositoryCredential(ctx context.Context, c Caller, projectID, repositoryID, credentialSecretID string) (RepositoryView, error)
	ListMembers(ctx context.Context, c Caller, projectID string) ([]MemberView, error)
	PutMember(ctx context.Context, c Caller, projectID, userID, role string) (MemberView, error)
	RecordDenied(ctx context.Context, c Caller, projectID, action string) error
}

// Validation limits (the M1 design contract; the tighter of it and
// api/openapi.yaml). Anything the store would reject is rejected here as 422
// so the client learns which field was wrong instead of colliding with a
// database constraint.
const (
	prjMaxNameLen        = 200
	prjMaxDescriptionLen = 2000
	prjMaxSlugLen        = 40
	prjMaxDefaultBranch  = 200
)

var (
	// A slug is lowercase alphanumeric, optionally hyphen-separated, and never
	// begins or ends with a hyphen: that is the derived form of a project name
	// and the only accepted explicit one (ProjectCreate.slug, openapi.yaml —
	// a trailing hyphen here would make a response violate Project.slug).
	prjSlugPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`)
	// A repository name is a single filename-safe path component: the name
	// becomes repos/<name> inside a run workspace
	// (communication-spec/05-workspaces-security-secrets.md), so it may not
	// contain a separator, and "." and ".." are rejected as traversal by the
	// rule quoted there even though the charset alone would allow them.
	prjRepoNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	// Accepted git remotes, verbatim from RepositoryCreate.git_url in
	// api/openapi.yaml: https/ssh URLs, an absolute file:// path, or an scp-style
	// git@host:path.
	prjGitURLPattern = regexp.MustCompile(`^((https|ssh)://[^/\s]+/.+|file:///[^\s]+|git@[^:/\s]+:.+)$`)
)

// RegisterProjects mounts the project, repository and member routes of
// api/openapi.yaml on s. All of them require a session; the mutations
// additionally require X-CSRF-Token, which HandleAuthed installs from the
// pattern's method.
func RegisterProjects(s *Server, store ProjectStore) {
	h := &prjHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/projects", http.HandlerFunc(h.listProjects))
	s.HandleAuthed("POST /api/v1/projects", http.HandlerFunc(h.createProject))
	s.HandleAuthed("GET /api/v1/projects/{projectId}", http.HandlerFunc(h.getProject))
	s.HandleAuthed("GET /api/v1/projects/{projectId}/repos", http.HandlerFunc(h.listRepositories))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/repos", http.HandlerFunc(h.addRepository))
	s.HandleAuthed("PATCH /api/v1/projects/{projectId}/repos/{repositoryId}", http.HandlerFunc(h.patchRepository))
	s.HandleAuthed("GET /api/v1/projects/{projectId}/members", http.HandlerFunc(h.listMembers))
	s.HandleAuthed("PUT /api/v1/projects/{projectId}/members/{userId}", http.HandlerFunc(h.putMember))
}

type prjHandlers struct {
	store ProjectStore
	srv   *Server
}

// --- request bodies -----------------------------------------------------

type prjProjectCreateBody struct {
	Name        string `json:"name"`
	Slug        string `json:"slug,omitempty"`
	Description string `json:"description,omitempty"`
}

type prjRepositoryCreateBody struct {
	Name          string `json:"name"`
	GitURL        string `json:"git_url"`
	DefaultBranch string `json:"default_branch,omitempty"`
	// CredentialSecretID (ADR-0061): absent/null means no credential; a uuid
	// must name a same-project (or same-org) integration_broker secret.
	CredentialSecretID *string `json:"credential_secret_id,omitempty"`
}

// prjRepositoryPatchBody keeps the field as raw JSON so "absent" and "null"
// answer differently: the ADR's one rule is that null CLEARS the credential,
// and a decoded *string would make the two requests the same one. A plain
// json.RawMessage distinguishes them exactly — absent leaves the bytes nil,
// null arrives as the four bytes "null" (a *RawMessage would be set to nil
// for null and collapse the two again).
type prjRepositoryPatchBody struct {
	CredentialSecretID json.RawMessage `json:"credential_secret_id"`
}

type prjMemberPutBody struct {
	Role string `json:"role"`
}

// prjList is the {items:[...]} envelope every collection route returns, so a
// client can always iterate body.items even when it is empty.
type prjList[T any] struct {
	Items T `json:"items"`
}

// --- handlers -----------------------------------------------------------

func (h *prjHandlers) listProjects(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projects, err := h.store.ListProjects(r.Context(), c)
	if err != nil {
		h.fail(w, r, c, "", "project.list", prjNoConflict, err)
		return
	}
	if projects == nil {
		projects = []ProjectView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]ProjectView]{Items: projects})
}

func (h *prjHandlers) createProject(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	var body prjProjectCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		prjInvalid(w, "name is required.")
		return
	}
	if utf8.RuneCountInString(name) > prjMaxNameLen {
		prjInvalid(w, fmt.Sprintf("name must be at most %d characters.", prjMaxNameLen))
		return
	}
	if utf8.RuneCountInString(body.Description) > prjMaxDescriptionLen {
		prjInvalid(w, fmt.Sprintf("description must be at most %d characters.", prjMaxDescriptionLen))
		return
	}
	slug := strings.TrimSpace(body.Slug)
	if slug == "" {
		if slug = prjDeriveSlug(name); slug == "" {
			prjInvalid(w, "could not derive a slug from name; supply one explicitly.")
			return
		}
	} else if !prjSlugPattern.MatchString(slug) {
		prjInvalid(w, "slug must match "+prjSlugPattern.String()+" (at most 40 characters, no leading or trailing hyphen).")
		return
	}

	project, err := h.store.CreateProject(r.Context(), c, name, slug, body.Description)
	if err != nil {
		h.fail(w, r, c, "", "project.create",
			"A project with that slug already exists in your organization.", err)
		return
	}
	WriteJSON(w, http.StatusCreated, project)
}

func (h *prjHandlers) getProject(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	project, err := h.store.GetProject(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "project.get", prjNoConflict, err)
		return
	}
	WriteJSON(w, http.StatusOK, project)
}

func (h *prjHandlers) listRepositories(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	repos, err := h.store.ListRepositories(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "repository.list", prjNoConflict, err)
		return
	}
	if repos == nil {
		repos = []RepositoryView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]RepositoryView]{Items: repos})
}

func (h *prjHandlers) addRepository(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	var body prjRepositoryCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	// Validation runs before the visibility check: an invalid body is the
	// client's mistake and says nothing about whether the project exists.
	if !prjRepoNamePattern.MatchString(body.Name) {
		prjInvalid(w, "repository name must match "+prjRepoNamePattern.String()+".")
		return
	}
	if body.Name == "." || body.Name == ".." {
		prjInvalid(w, "repository name must not be . or ..")
		return
	}
	if !prjGitURLPattern.MatchString(body.GitURL) {
		prjInvalid(w, "git_url must be https://, ssh://, git@host:path or file://.")
		return
	}
	branch := strings.TrimSpace(body.DefaultBranch)
	if branch == "" {
		branch = "main"
	}
	if utf8.RuneCountInString(branch) > prjMaxDefaultBranch {
		prjInvalid(w, fmt.Sprintf("default_branch must be at most %d characters.", prjMaxDefaultBranch))
		return
	}

	if !h.requireManage(w, r, c, projectID, "repository.add") {
		return
	}
	credentialSecretID := ""
	if body.CredentialSecretID != nil {
		credentialSecretID = strings.TrimSpace(*body.CredentialSecretID)
		if credentialSecretID != "" && !validUUIDString(credentialSecretID) {
			prjCredentialProblem(w, "credential_secret_id must be a uuid naming an integration_broker secret of this project.")
			return
		}
	}
	repo, err := h.store.AddRepository(r.Context(), c, projectID, body.Name, body.GitURL, branch, credentialSecretID)
	if err != nil {
		if errors.Is(err, ErrRepositoryCredentialInvalid) {
			prjCredentialProblem(w, "credential_secret_id must name an integration_broker secret of this project or its organization.")
			return
		}
		h.fail(w, r, c, projectID, "repository.add",
			fmt.Sprintf("A repository named %q already exists in this project.", body.Name), err)
		return
	}
	WriteJSON(w, http.StatusCreated, repo)
}

// patchRepository is ADR-0061 Decision 3's patch verb: the one mutable
// repository field today is the GitHub credential. `credential_secret_id`
// is required in the body — a uuid sets it, null clears it — because a
// patch that named nothing would silently answer 200 for a request whose
// author meant to change something. Maintainer only, same gate as add.
func (h *prjHandlers) patchRepository(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	repositoryID := r.PathValue("repositoryId")
	if !validUUIDString(repositoryID) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such repository in this project.")
		return
	}
	var body prjRepositoryPatchBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if len(body.CredentialSecretID) == 0 {
		prjInvalid(w, "credential_secret_id is required: a uuid to set it, null to clear it.")
		return
	}
	credentialSecretID := ""
	if raw := strings.TrimSpace(string(body.CredentialSecretID)); raw != "null" {
		var s string
		if err := json.Unmarshal([]byte(raw), &s); err != nil || !validUUIDString(s) {
			prjCredentialProblem(w, "credential_secret_id must be a uuid naming an integration_broker secret of this project, or null to clear it.")
			return
		}
		credentialSecretID = s
	}
	if !h.requireManage(w, r, c, projectID, "repository.update") {
		return
	}
	repo, err := h.store.PatchRepositoryCredential(r.Context(), c, projectID, repositoryID, credentialSecretID)
	if err != nil {
		switch {
		case errors.Is(err, ErrRepositoryCredentialInvalid):
			prjCredentialProblem(w, "credential_secret_id must name an integration_broker secret of this project or its organization.")
		case errors.Is(err, ErrProjectNotFound):
			h.denied(w, r, c, projectID, "repository.update", "no such repository in this project")
			WriteProblem(w, http.StatusNotFound, "Not Found", "No such repository in this project.")
		default:
			h.fail(w, r, c, projectID, "repository.update", prjNoConflict, err)
		}
		return
	}
	WriteJSON(w, http.StatusOK, repo)
}

// prjCredentialProblem is the 422 with the `invalid_credential_secret` code
// (the ADR-0030 convention the github issue route established: the `type`
// URI ends in the code and `code` repeats it, so clients switch on `code`).
func prjCredentialProblem(w http.ResponseWriter, detail string) {
	ghiProblem(w, http.StatusUnprocessableEntity, "invalid_credential_secret",
		"Invalid Credential Secret", detail)
}

func (h *prjHandlers) listMembers(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	members, err := h.store.ListMembers(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "member.list", prjNoConflict, err)
		return
	}
	if members == nil {
		members = []MemberView{}
	}
	WriteJSON(w, http.StatusOK, prjList[[]MemberView]{Items: members})
}

func (h *prjHandlers) putMember(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	userID := r.PathValue("userId")

	var body prjMemberPutBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !authz.ValidRole(body.Role) {
		prjInvalid(w, "role must be maintainer, contributor or viewer.")
		return
	}
	if !h.requireManage(w, r, c, projectID, "member.put") {
		return
	}
	member, err := h.store.PutMember(r.Context(), c, projectID, userID, body.Role)
	if err != nil {
		h.fail(w, r, c, projectID, "member.put", prjNoConflict, err)
		return
	}
	WriteJSON(w, http.StatusOK, member)
}

// --- shared plumbing ----------------------------------------------------

// caller extracts the store Caller from the authenticated principal.
// RequireAuth has already rejected anonymous requests, so a missing
// principal here means a middleware bug and answers 500 rather than leaking a
// zero-valued caller into an authorization decision.
func (h *prjHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// requireManage answers a mutation against a project the caller may not
// manage. Not being able to see the project at all is a 404 (no existence
// leak); seeing it but not managing it is a 403. Both write an audit row.
func (h *prjHandlers) requireManage(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string) bool {
	project, err := h.store.GetProject(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, prjNoConflict, err)
		return false
	}
	role := authz.Role(project.MyRole)
	if authz.CanManage(c.IsOrgAdmin, role) {
		return true
	}
	h.denied(w, r, c, projectID, action, "the project is not visible to you")
	if !authz.CanView(c.IsOrgAdmin, role) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
		return false
	}
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is read-only; a maintainer is required.")
	return false
}

// fail maps a store error onto the HTTP contract: 404 for unknown or
// inaccessible projects (plus an audit row), 409 for a unique clash — whose
// user-facing explanation only the calling route knows — and 500 for
// anything else.
func (h *prjHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, conflictDetail string, err error) {
	switch {
	case errors.Is(err, ErrProjectConflict):
		WriteProblem(w, http.StatusConflict, "Conflict", conflictDetail)
	case errors.Is(err, ErrProjectNotFound):
		h.denied(w, r, c, projectID, action, "no such project, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
	default:
		h.serverError(w, r, projectID, action, err)
	}
}

// prjNoConflict is the conflict detail for routes that cannot produce a
// conflict; a conflict there is reported as a plain 409.
const prjNoConflict = "The request conflicts with existing state."

// denied records a refused attempt. A failure to record it is logged but must
// not change the answer the client gets — the request is denied either way.
func (h *prjHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, reason string) {
	if err := h.store.RecordDenied(r.Context(), c, projectID, action); err != nil {
		h.log(r).ErrorContext(r.Context(), "could not write audit denial",
			slog.String("action", action),
			slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		return
	}
	h.log(r).WarnContext(r.Context(), "access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("project_id", projectID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *prjHandlers) serverError(w http.ResponseWriter, r *http.Request, projectID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "project store failure",
		slog.String("action", action),
		slog.String("project_id", projectID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	// The store error may name tables and connection details; the client gets
	// the request id to quote instead.
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *prjHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
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

func (h *prjHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// prjInvalid writes the 422 problem+json every validation failure shares.
func prjInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// prjDeriveSlug turns a project name into a URL-safe slug: lowercased, runs of
// non-alphanumeric characters collapsed to a single '-', trimmed, at most 40
// characters (api/openapi.yaml createProject). An empty result means the name
// contained nothing sluggable.
func prjDeriveSlug(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case !prevDash:
			b.WriteByte('-')
			prevDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > prjMaxSlugLen {
		slug = strings.Trim(slug[:prjMaxSlugLen], "-")
	}
	return slug
}
