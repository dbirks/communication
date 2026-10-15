// Package api — M3 secrets surface.
//
// This file is the whole HTTP shape of ADR-0018's SecretRef: nine routes, every
// one of them metadata. It is worth stating why that is a structural property
// rather than a discipline: the interface below has no method that returns a
// value, no method that returns ciphertext, and no view type with a field a
// value could occupy. The one route that *accepts* a value (`createProjectSecret`
// and `addProjectSecretVersion`) encrypts it inside the store's write transaction
// and then cannot give it back. So the contract's question — "no GET
// /values/{secretId} exists anywhere in the surface, so 'did this endpoint leak'
// cannot arise" — is answered by the type declarations, and `secrets_test.go`
// asserts them rather than trusting the prose.
//
// Authorization follows projects.go exactly: the role question is asked once,
// against the project the path names (authz.CanView/CanManage), and a caller who
// cannot see the project gets 404 plus an audit denial, never a 403 that would
// confirm the project exists. The *secret* axes — which agent profile may hold
// which secret — are not decided here: they are ADR-0018 D3 data, enforced by
// secrets.Resolver on the worker at materialization time.
//
// The oddity in the route table is `POST .../secrets/{secretId}:revoke`. The
// pattern cannot be registered as written (net/http's mux will not match a
// wildcard followed by a literal suffix inside one segment), so the verb is
// parsed out of the path value here — which also means an unknown `:suffix` must
// answer "no endpoint", not "the secret exists and you may not revoke it".
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/authz"
)

// SecretStore is the control-plane store's secret surface as the handlers need
// it. api owns this interface and the view types (dependency rule: adapters
// depend on interfaces, never the reverse), and the shape is deliberately
// asymmetric in one specific way:

//	values go in, metadata comes out.
//
// There is no ReadSecretValue, no ListSecretVersions beyond the metadata's
// current_version, and no []byte anywhere on the read side, because a method
// that could return a value would be the one hole the whole milestone is built
// to close (ADR-0018 D1/D3).
type SecretStore interface {
	// ListSecrets returns the secret_metadata rows a project can see — its own
	// project-scope rows plus its organization's org-scope rows — ordered by
	// slug.
	ListSecrets(ctx context.Context, c Caller, projectID string) ([]SecretView, error)
	// CreateSecret writes secret_metadata and secret_versions v1 in one
	// transaction, encrypting value inside that transaction, and appends
	// secret.created.
	CreateSecret(ctx context.Context, c Caller, projectID string, in SecretCreateInput) (SecretView, error)
	// UpdateSecret replaces purpose, the allowlists and audit_policy and appends
	// secret.policy.updated with the before/after policy.
	UpdateSecret(ctx context.Context, c Caller, projectID, secretID string, in SecretPolicyInput) (SecretView, error)
	// AddSecretVersion appends an immutable version, bumps current_version, sets
	// rotated_at and appends secret.version.added. A retried write whose bytes
	// match the current version's content_sha256 is recognised as the same write
	// and reports the version it already has.
	AddSecretVersion(ctx context.Context, c Caller, projectID, secretID string, value []byte) (SecretVersionView, error)
	// RevokeSecret sets revoked_at on the metadata row and on every version, and
	// appends secret.revoked.
	RevokeSecret(ctx context.Context, c Caller, projectID, secretID string) (SecretView, error)
	// ListSecretMaterializations returns the audit view, newest first.
	ListSecretMaterializations(ctx context.Context, c Caller, projectID, secretID string) ([]SecretMaterializationView, error)
	// ListSecretMounts returns the declared placements.
	ListSecretMounts(ctx context.Context, c Caller, projectID string) ([]SecretMountView, error)
	// CreateSecretMount declares a placement.
	CreateSecretMount(ctx context.Context, c Caller, projectID string, in SecretMountInput) (SecretMountView, error)
	// DeleteSecretMount removes a declaration; it does not revoke the secret.
	DeleteSecretMount(ctx context.Context, c Caller, projectID, mountID string) error
}

// --- views (the serializable half) ---------------------------------------

// SecretView is openapi's Secret: a secret_metadata row, the half of a SecretRef
// that may be shared with a client. Field set and JSON names are pinned against
// api/openapi.yaml by TestSecretViewsMatchOpenAPISchemas, because a member
// invented here is a member the UI was not told about — and a member named
// `value` here would be the bug this whole file exists to prevent.
type SecretView struct {
	ID        string `json:"id"`
	Slug      string `json:"slug"`
	Scope     string `json:"scope"`
	Purpose   string `json:"purpose"`
	Delivery  string `json:"delivery_mode"`
	CurrentVS int    `json:"current_version"`
	// Profiles is an allowlist; empty means denied to every profile, and the
	// UI has to be able to tell "granted to none" from "not yet configured",
	// so it is serialized as [] rather than omitted.
	Profiles  []string   `json:"allowed_agent_profile_ids"`
	Audit     string     `json:"audit_policy"`
	CreatedAt time.Time  `json:"created_at"`
	RotatedAt *time.Time `json:"rotated_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

// SecretListView is openapi's SecretList.
type SecretListView struct {
	Secrets []SecretView `json:"secrets"`
}

// SecretVersionView is openapi's SecretVersionInfo: what addProjectSecretVersion
// returns. No nonce, no ciphertext, no content_sha256 — the digest is
// retry-comparison only and "never API-exposed" (ADR-0018), and the journal is an
// API.
type SecretVersionView struct {
	SecretID  string    `json:"secret_id"`
	Version   int       `json:"version"`
	KeyID     string    `json:"key_id"`
	CreatedAt time.Time `json:"created_at"`
}

// SecretMaterializationView is openapi's SecretMaterialization: one
// secret_materializations row. CleanedAt nil is a finding, not a formatting
// choice — it is the row the worker's startup sweep exists to close.
type SecretMaterializationView struct {
	ID             int64      `json:"id"`
	SecretID       string     `json:"secret_id"`
	Slug           string     `json:"slug"`
	SecretVersion  int        `json:"secret_version"`
	WorkspaceID    *string    `json:"workspace_id"`
	TurnID         *string    `json:"turn_id"`
	WorkerID       string     `json:"worker_id"`
	Delivery       string     `json:"delivery_mode"`
	Target         string     `json:"target"`
	FileMode       *int       `json:"file_mode"`
	MaterializedAt time.Time  `json:"materialized_at"`
	CleanedAt      *time.Time `json:"cleaned_at"`
	CleanedBy      *string    `json:"cleaned_by"`
}

// SecretMaterializationListView is openapi's SecretMaterializationList.
type SecretMaterializationListView struct {
	Materializations []SecretMaterializationView `json:"materializations"`
}

// SecretMountView is openapi's SecretMount: a declared placement. Paths here are
// the declared *relative* path, never a resolved one — root_path and
// checkout_path are worker-side topology and do not cross this boundary
// (ADR-0017 D4).
type SecretMountView struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"project_id"`
	SecretID     string    `json:"secret_id"`
	SecretSlug   string    `json:"secret_slug"`
	Delivery     string    `json:"delivery_mode"`
	RepositoryID *string   `json:"repository_id"`
	RelativePath *string   `json:"relative_path"`
	EnvName      *string   `json:"env_name"`
	Key          *string   `json:"key"`
	Lifecycle    string    `json:"lifecycle"`
	AllowTracked bool      `json:"allow_tracked"`
	CreatedAt    time.Time `json:"created_at"`
}

// SecretMountListView is openapi's SecretMountList.
type SecretMountListView struct {
	SecretMounts []SecretMountView `json:"secret_mounts"`
}

// --- inputs -------------------------------------------------------------

// SecretCreateInput is the validated SecretCreate body. Value exists here and
// nowhere on the way out; the handler zeroes the buffer it holds as soon as the
// store has returned.
type SecretCreateInput struct {
	Slug         string
	Purpose      string
	DeliveryMode string
	Scope        string
	Profiles     []string
	Value        []byte
}

// SecretPolicyInput is the validated SecretUpdate body: exactly the three fields
// the schema names. Slug, scope, delivery_mode and current_version are absent
// because they are not editable through this verb.
type SecretPolicyInput struct {
	Purpose  string
	Profiles []string
	Audit    string
}

// SecretMountInput is the validated SecretMountCreate body.
type SecretMountInput struct {
	SecretID     string
	DeliveryMode string
	RepositoryID string
	RelativePath string
	EnvName      string
	Key          string
	Lifecycle    string
	AllowTracked bool
}

// --- errors -------------------------------------------------------------

var (
	// ErrSecretConflict is a slug collision, a write against a revoked secret, or
	// a mount that duplicates a placement. It joins to the same sentinel
	// projects.go uses so the problem document is produced by one code path.
	ErrSecretConflict = errors.New("api: secret conflict")

	// ErrSecretDeliveryUnsupported is ADR-0018 clause 8 surfacing as a 422: the
	// requested delivery mode is declared and unbuilt, so a mount that would
	// silently degrade to env delivery is refused instead.
	ErrSecretDeliveryUnsupported = errors.New("api: secret delivery mode is not implemented")

	// ErrSecretForbidden is the store refusing a write the role does not allow.
	// The handler gate normally answers first; this exists so a store-side refusal
	// is a 403 rather than a 500 that hides a real authorization difference.
	ErrSecretForbidden = errors.New("api: secret write not allowed")

	// ErrSecretPlacementInvalid is a mount the database will not accept: notably a
	// repository belonging to another project, which openapi names as 422 rather
	// than 404 because the repository exists and simply is not this project's.
	ErrSecretPlacementInvalid = errors.New("api: secret placement is not valid for this project")

	// ErrValueNotSerializable is what an encoder reports when something tries to
	// marshal a value that arrived write-only. It is api's own copy of the rule
	// internal/secrets enforces on decrypted material: this package never holds
	// plaintext long enough to decrypt anything, but the one place a value does
	// appear (a request body) must not be able to become a response body.
	ErrValueNotSerializable = errors.New("api: a write-only secret value cannot be serialized")
)

// --- registration -------------------------------------------------------

// RegisterSecrets mounts the nine secret and secret-mount routes of
// api/openapi.yaml on s. projects is needed because the role gate is the
// project's, not the secret's: every route here resolves its caller against the
// path's project, and a denial is audited through the same store seam
// projects.go uses.
func RegisterSecrets(s *Server, store SecretStore, projects ProjectStore) {
	h := &secHandlers{secrets: store, projects: projects, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/secrets", http.HandlerFunc(h.listSecrets))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/secrets", http.HandlerFunc(h.createSecret))
	s.HandleAuthed("PUT /api/v1/projects/{projectId}/secrets/{secretId}", http.HandlerFunc(h.updateSecret))
	// ":revoke" shares this pattern; see secHandlers.secretByID.
	s.HandleAuthed("POST /api/v1/projects/{projectId}/secrets/{secretId}", http.HandlerFunc(h.postSecretByID))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/secrets/{secretId}/versions", http.HandlerFunc(h.addSecretVersion))
	s.HandleAuthed("GET /api/v1/projects/{projectId}/secrets/{secretId}/materializations", http.HandlerFunc(h.listMaterializations))
	s.HandleAuthed("GET /api/v1/projects/{projectId}/secret-mounts", http.HandlerFunc(h.listMounts))
	s.HandleAuthed("POST /api/v1/projects/{projectId}/secret-mounts", http.HandlerFunc(h.createMount))
	s.HandleAuthed("DELETE /api/v1/projects/{projectId}/secret-mounts/{mountId}", http.HandlerFunc(h.deleteMount))
}

type secHandlers struct {
	secrets  SecretStore
	projects ProjectStore
	srv      *Server
}

// --- request bodies -----------------------------------------------------

type secCreateBody struct {
	Slug     string   `json:"slug"`
	Purpose  string   `json:"purpose,omitempty"`
	Delivery string   `json:"delivery_mode"`
	Scope    string   `json:"scope,omitempty"`
	Profiles []string `json:"allowed_agent_profile_ids,omitempty"`
	// Value is writeOnly in the schema.
	Value *secValue `json:"value,omitempty"`
}

// secUpdateBody carries Value as a raw probe field, not as policy: a PUT whose
// body contains `value` is a 400 with a message naming the verb the caller
// meant, and DecodeJSON's DisallowUnknownFields would otherwise report it as an
// anonymous "unknown field" 400.
type secUpdateBody struct {
	Purpose  *string   `json:"purpose"`
	Profiles *[]string `json:"allowed_agent_profile_ids"`
	Audit    *string   `json:"audit_policy"`
	Value    *string   `json:"value,omitempty"`
}

type secVersionBody struct {
	Value *secValue `json:"value"`
}

// secValue is a write-only secret value as it arrives on the wire.
//
// It exists because []byte in encoding/json means base64, and openapi's
// SecretVersionCreate.value is a plain string; decoding one as the other would
// turn every rotation into a 400. UnmarshalJSON takes a copy of the decoded
// string that this package owns and can zero, which is as far as Go lets the
// rule reach: the decoder's own intermediate string is not zeroable, and no
// amount of typing changes that. What is guaranteed here is that nothing on the
// response side can serialize it back out, and that the buffer handed to the
// store is one the handler can destroy.
type secValue []byte

func (v *secValue) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	*v = secValue(s)
	return nil
}

// MarshalJSON refuses, so a value cannot survive being put in a response struct
// even by accident.
func (v secValue) MarshalJSON() ([]byte, error) {
	return nil, ErrValueNotSerializable
}

// Len reports the length without exposing material, so a test or a log line can
// say "there was one" without saying what.
func (v secValue) Len() int { return len(v) }

// String refuses: the fmt path is the one that would otherwise put a value in a
// log line through a %v on a struct that happens to hold one.
func (v secValue) String() string { return "[redacted secret]" }

// Zero destroys the copy this package owns.
func (v *secValue) Zero() {
	if v == nil {
		return
	}
	clear(*v)
	*v = nil
}

type secMountBody struct {
	SecretID     string  `json:"secret_id"`
	Delivery     string  `json:"delivery_mode"`
	RepositoryID *string `json:"repository_id,omitempty"`
	RelativePath *string `json:"relative_path,omitempty"`
	EnvName      *string `json:"env_name,omitempty"`
	Key          *string `json:"key,omitempty"`
	Lifecycle    *string `json:"lifecycle,omitempty"`
	AllowTracked bool    `json:"allow_tracked,omitempty"`
}

var (
	// secret slug: SecretCreate.slug's pattern, verbatim. A mount names a secret
	// by slug, so a slug that drifts from the schema would put an unusable name
	// in a placement the API accepted.
	secSlugPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$`)
	// env name: SecretMountCreate.env_name names a variable, never a path, and
	// the materializer refuses anything the shell cannot name (a mount that would
	// produce such a name is refused at create, where the caller can still hear
	// about it).
	secEnvNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	// key name inside a multi-line value: the same charset, because the mount's
	// `key` is matched against `KEY=` lines.
	secKeyNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	// A declared relative path. The materializer validates the same shape again
	// against the real filesystem — a CHECK and an API pattern cannot see a
	// symlink, which is why the rule is written twice (ADR-0018 D4 clause 1).
	secRelativePathPattern = regexp.MustCompile(`^[^/\000][^/]*$`)
)

const (
	secMaxSlugLen    = 128
	secMaxPurposeLen = 512
	secMaxValueLen   = 65536
	// secretIDRevokeSuffix is the sub-resource the openapi path
	// /api/v1/projects/{projectId}/secrets/{secretId}:revoke names.
	secretIDRevokeSuffix = ":revoke"
)

// --- handlers -----------------------------------------------------------

func (h *secHandlers) listSecrets(w http.ResponseWriter, r *http.Request) {
	const action = "secret.list"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if _, ok := h.requireRole(w, r, c, projectID, action, false); !ok {
		return
	}
	secrets, err := h.secrets.ListSecrets(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return
	}
	if secrets == nil {
		secrets = []SecretView{}
	}
	WriteJSON(w, http.StatusOK, SecretListView{Secrets: secrets})
}

func (h *secHandlers) createSecret(w http.ResponseWriter, r *http.Request) {
	const action = "secret.create"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	var body secCreateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	slug := strings.TrimSpace(body.Slug)
	switch {
	case slug == "":
		secInvalid(w, "slug is required.")
		return
	case len(slug) > secMaxSlugLen || !secSlugPattern.MatchString(slug):
		secInvalid(w, "slug must match "+secSlugPattern.String()+" and be at most 128 characters.")
		return
	}
	if len(body.Purpose) > secMaxPurposeLen {
		secInvalid(w, "purpose must be at most 512 characters.")
		return
	}
	// The enum in SecretCreate is narrower than Secret.delivery_mode: a create
	// that asked for integration_broker would be a secret with no deliverable
	// placement (ADR-0018 clause 8), and 400 is what the schema says.
	switch body.Delivery {
	case "env", "env_file":
	case "integration_broker":
		secInvalid(w, "delivery_mode integration_broker is declared but unbuilt: no secret may be created with it.")
		return
	default:
		secInvalid(w, "delivery_mode must be env or env_file.")
		return
	}
	switch body.Scope {
	case "", "project":
	case "org":
		if !c.IsOrgAdmin {
			h.denied(w, r, c, projectID, action, "an org-scope secret needs organization admin")
			WriteProblem(w, http.StatusForbidden, "Forbidden", "Creating an org-scope secret requires organization admin.")
			return
		}
	default:
		secInvalid(w, "scope must be project or org.")
		return
	}
	if body.Value == nil {
		secInvalid(w, "value is required.")
		return
	}
	value := []byte(*body.Value)
	defer body.Value.Zero()
	if len(value) == 0 {
		secInvalid(w, "value must not be empty.")
		return
	}
	if len(value) > secMaxValueLen {
		secInvalid(w, "value must be at most 65536 bytes.")
		return
	}
	for _, profile := range body.Profiles {
		if !validUUIDString(profile) {
			secInvalid(w, "allowed_agent_profile_ids must be uuids.")
			return
		}
	}
	in := SecretCreateInput{
		Slug:         slug,
		Purpose:      body.Purpose,
		DeliveryMode: body.Delivery,
		Scope:        body.Scope,
		Profiles:     append([]string(nil), body.Profiles...),
		Value:        value,
	}
	created, err := h.secrets.CreateSecret(r.Context(), c, projectID, in)
	if err == nil {
		// Location names the row (openapi's Location header for 201). The path it
		// points at has no GET — the resource is metadata-only — but the
		// identifier and the project it belongs to are the client's due.
		w.Header().Set("Location", "/api/v1/projects/"+projectID+"/secrets/"+created.ID)
		WriteJSON(w, http.StatusCreated, created)
		return
	}
	h.fail(w, r, c, projectID, action, "A secret with that slug already exists here.", err)
}

func (h *secHandlers) updateSecret(w http.ResponseWriter, r *http.Request) {
	const action = "secret.update"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	secretID, ok := h.pathUUID(w, r, "secretId")
	if !ok {
		return
	}
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	var body secUpdateBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Value != nil {
		// 400 rather than 422, because this is the one case the contract names as
		// a bad request instead of a bad value: "I meant to rotate" and "I meant
		// to rename" must not be the same request, and silently dropping the
		// field would make them one (m3-contract § 3, C15b).
		WriteProblem(w, http.StatusBadRequest, "Invalid Request Body",
			"A value cannot be set through this endpoint; rotate with POST /secrets/"+secretID+"/versions.")
		return
	}
	if body.Purpose == nil || body.Profiles == nil || body.Audit == nil {
		secInvalid(w, "purpose, allowed_agent_profile_ids and audit_policy are all required.")
		return
	}
	if len(*body.Purpose) > secMaxPurposeLen {
		secInvalid(w, "purpose must be at most 512 characters.")
		return
	}
	switch *body.Audit {
	case "materialization", "materialization_and_access":
	default:
		secInvalid(w, "audit_policy must be materialization or materialization_and_access.")
		return
	}
	for _, profile := range *body.Profiles {
		if !validUUIDString(profile) {
			secInvalid(w, "allowed_agent_profile_ids must be uuids.")
			return
		}
	}
	updated, err := h.secrets.UpdateSecret(r.Context(), c, projectID, secretID, SecretPolicyInput{
		Purpose:  *body.Purpose,
		Profiles: append([]string(nil), *body.Profiles...),
		Audit:    *body.Audit,
	})
	if err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return
	}
	WriteJSON(w, http.StatusOK, updated)
}

// postSecretByID dispatches the two POST verbs that share a path segment:
// `.../secrets/{id}:revoke` and — for anything else — nothing, because there is
// no POST to a bare secret id in the surface.
func (h *secHandlers) postSecretByID(w http.ResponseWriter, r *http.Request) {
	raw, ok := h.pathSegment(w, r, "secretId")
	if !ok {
		return
	}
	id, suffix, known := strings.Cut(raw, ":")
	if !known || suffix != strings.TrimPrefix(secretIDRevokeSuffix, ":") {
		// Answer as if the sub-resource did not exist: confirming that a secret
		// id is real while refusing the verb would leak the id namespace.
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such endpoint.")
		return
	}
	r.SetPathValue("secretId", id)
	h.revokeSecret(w, r)
}

func (h *secHandlers) revokeSecret(w http.ResponseWriter, r *http.Request) {
	const action = "secret.revoke"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	secretID, ok := h.pathUUID(w, r, "secretId")
	if !ok {
		return
	}
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	revoked, err := h.secrets.RevokeSecret(r.Context(), c, projectID, secretID)
	if err != nil {
		h.fail(w, r, c, projectID, action, "That secret is already revoked.", err)
		return
	}
	WriteJSON(w, http.StatusOK, revoked)
}

func (h *secHandlers) addSecretVersion(w http.ResponseWriter, r *http.Request) {
	const action = "secret.version.add"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	secretID, ok := h.pathUUID(w, r, "secretId")
	if !ok {
		return
	}
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	var body secVersionBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if body.Value == nil {
		secInvalid(w, "value is required.")
		return
	}
	value := []byte(*body.Value)
	defer body.Value.Zero()
	if len(value) == 0 {
		secInvalid(w, "value must not be empty.")
		return
	}
	if len(value) > secMaxValueLen {
		secInvalid(w, "value must be at most 65536 bytes.")
		return
	}
	added, err := h.secrets.AddSecretVersion(r.Context(), c, projectID, secretID, value)
	if err != nil {
		h.fail(w, r, c, projectID, action, "That secret cannot take a new version.", err)
		return
	}
	WriteJSON(w, http.StatusCreated, added)
}

func (h *secHandlers) listMaterializations(w http.ResponseWriter, r *http.Request) {
	const action = "secret.materialization.list"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	secretID, ok := h.pathUUID(w, r, "secretId")
	if !ok {
		return
	}
	// Maintainer, not viewer: the materialization map says which unit held which
	// secret where, and openapi names that "itself a disclosure surface".
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	rows, err := h.secrets.ListSecretMaterializations(r.Context(), c, projectID, secretID)
	if err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return
	}
	if rows == nil {
		rows = []SecretMaterializationView{}
	}
	WriteJSON(w, http.StatusOK, SecretMaterializationListView{Materializations: rows})
}

func (h *secHandlers) listMounts(w http.ResponseWriter, r *http.Request) {
	const action = "secret.mount.list"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if _, ok := h.requireRole(w, r, c, projectID, action, false); !ok {
		return
	}
	mounts, err := h.secrets.ListSecretMounts(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return
	}
	if mounts == nil {
		mounts = []SecretMountView{}
	}
	WriteJSON(w, http.StatusOK, SecretMountListView{SecretMounts: mounts})
}

func (h *secHandlers) createMount(w http.ResponseWriter, r *http.Request) {
	const action = "secret.mount.create"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	var body secMountBody
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !validUUIDString(body.SecretID) {
		secInvalid(w, "secret_id must be a uuid.")
		return
	}
	switch body.Delivery {
	case "env", "env_file":
	case "integration_broker":
		// 422, not 400: the shape is well-formed and the *policy* is what M3
		// cannot honour (ADR-0018 clause 8).
		h.denied(w, r, c, projectID, action, "integration_broker delivery is declared but not implemented")
		WriteProblem(w, http.StatusUnprocessableEntity, "Unprocessable Entity",
			"delivery_mode integration_broker is not implemented; no mount may declare it yet.")
		return
	default:
		secInvalid(w, "delivery_mode must be env or env_file.")
		return
	}
	lifecycle := "turn"
	if body.Lifecycle != nil {
		lifecycle = *body.Lifecycle
	}
	switch lifecycle {
	case "turn", "workspace":
	case "node_attempt":
		// Accepted, not reinterpreted: the column's CHECK allows it and nothing
		// honours it before M4's attempts exist. Silently rewriting it to turn
		// would make a declaration mean something its author did not say
		// (contract deviation D9).
	default:
		secInvalid(w, "lifecycle must be turn, workspace or node_attempt.")
		return
	}
	in := SecretMountInput{
		SecretID:     body.SecretID,
		DeliveryMode: body.Delivery,
		Lifecycle:    lifecycle,
		AllowTracked: body.AllowTracked,
	}
	if body.Key != nil {
		if !secKeyNamePattern.MatchString(*body.Key) {
			secInvalid(w, "key must match "+secKeyNamePattern.String()+".")
			return
		}
		in.Key = *body.Key
	}
	// The same two-branch shape check mounts_shape enforces in SQL, done here so
	// the client hears which field was wrong instead of which constraint fired.
	switch body.Delivery {
	case "env":
		if body.EnvName == nil {
			secInvalid(w, "env_name is required for env delivery.")
			return
		}
		if !secEnvNamePattern.MatchString(*body.EnvName) {
			secInvalid(w, "env_name must match "+secEnvNamePattern.String()+".")
			return
		}
		if body.RelativePath != nil || body.RepositoryID != nil {
			secInvalid(w, "env delivery takes no relative_path or repository_id.")
			return
		}
		in.EnvName = *body.EnvName
	case "env_file":
		if body.RepositoryID == nil {
			secInvalid(w, "repository_id is required for env_file delivery.")
			return
		}
		if !validUUIDString(*body.RepositoryID) {
			secInvalid(w, "repository_id must be a uuid.")
			return
		}
		if body.EnvName != nil {
			secInvalid(w, "env_file delivery takes no env_name.")
			return
		}
		if body.RelativePath == nil {
			secInvalid(w, "relative_path is required for env_file delivery.")
			return
		}
		if reason := relativePathRefusal(*body.RelativePath); reason != "" {
			secInvalid(w, "relative_path must be relative with no '..' segment, no leading '/' and no empty segment ("+reason+").")
			return
		}
		in.RepositoryID = *body.RepositoryID
		in.RelativePath = *body.RelativePath
	}
	created, err := h.secrets.CreateSecretMount(r.Context(), c, projectID, in)
	if err != nil {
		h.fail(w, r, c, projectID, action, "That placement cannot be declared.", err)
		return
	}
	w.Header().Set("Location", "/api/v1/projects/"+projectID+"/secret-mounts/"+created.ID)
	WriteJSON(w, http.StatusCreated, created)
}

func (h *secHandlers) deleteMount(w http.ResponseWriter, r *http.Request) {
	const action = "secret.mount.delete"
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	mountID, ok := h.pathUUID(w, r, "mountId")
	if !ok {
		return
	}
	if _, ok := h.requireRole(w, r, c, projectID, action, true); !ok {
		return
	}
	if err := h.secrets.DeleteSecretMount(r.Context(), c, projectID, mountID); err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- shared plumbing ----------------------------------------------------

const secNoConflict = "The request conflicts with existing state."

// requireRole answers the project's role question for a secret route. manage is
// what every mutation and the materialization view needs; everything else is
// viewer. A caller who cannot see the project gets 404 and an audit denial, which
// is the same shape projects.go gives so a secret route cannot become an oracle
// for which projects exist.
func (h *secHandlers) requireRole(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string, manage bool) (authz.Role, bool) {
	project, err := h.projects.GetProject(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, action, secNoConflict, err)
		return "", false
	}
	role := authz.Role(project.MyRole)
	if manage {
		if authz.CanManage(c.IsOrgAdmin, role) {
			return role, true
		}
	} else if authz.CanView(c.IsOrgAdmin, role) {
		return role, true
	}
	h.denied(w, r, c, projectID, action, "the project is not visible to you")
	if !authz.CanView(c.IsOrgAdmin, role) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
		return "", false
	}
	WriteProblem(w, http.StatusForbidden, "Forbidden",
		"Your project role is read-only; a maintainer is required.")
	return "", false
}

func (h *secHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, reason string) {
	if err := h.projects.RecordDenied(r.Context(), c, projectID, action); err != nil {
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

func (h *secHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, projectID, action, conflictDetail string, err error) {
	switch {
	case errors.Is(err, ErrSecretDeliveryUnsupported):
		WriteProblem(w, http.StatusUnprocessableEntity, "Unprocessable Entity",
			"That delivery mode is not implemented and no placement may use it.")
	case errors.Is(err, ErrSecretPlacementInvalid):
		WriteProblem(w, http.StatusUnprocessableEntity, "Unprocessable Entity",
			"That placement cannot be declared in this project.")
	case errors.Is(err, ErrSecretForbidden):
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Your project role is read-only; a maintainer is required.")
	case errors.Is(err, ErrSecretConflict), errors.Is(err, ErrProjectConflict):
		WriteProblem(w, http.StatusConflict, "Conflict", conflictDetail)
	case errors.Is(err, ErrProjectNotFound):
		h.denied(w, r, c, projectID, action, "no such project or secret, or it is not visible to you")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such project.")
	default:
		h.serverError(w, r, projectID, action, err)
	}
}

func (h *secHandlers) serverError(w http.ResponseWriter, r *http.Request, projectID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "secret store failure",
		slog.String("action", action),
		slog.String("project_id", projectID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	// A store error names tables and connection details; the client gets the
	// request id to quote instead. It must never be echoed even for a secret
	// route, where an error string could in principle carry an input value.
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *secHandlers) badRequest(w http.ResponseWriter, r *http.Request, err error) {
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

func (h *secHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

func (h *secHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

var _ = io.Discard

// pathUUID reads a path segment that must be a canonical uuid. A malformed one is
// 404 rather than 400: an id that is not a uuid cannot name a row, and the
// difference between "your id was malformed" and "no such row" is worth nothing
// to a client and something to an enumerator.
func (h *secHandlers) pathUUID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := r.PathValue(name)
	if !validUUIDString(value) {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such resource.")
		return "", false
	}
	return value, true
}

func (h *secHandlers) pathSegment(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := r.PathValue(name)
	if value == "" {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such resource.")
		return "", false
	}
	return value, true
}

// relativePathRefusal names why a declared path is not a legal relative path, or
// "" when it is. The materializer refuses the same shapes again at use against the
// filesystem; this is the half that can be answered before a workspace exists.
func relativePathRefusal(rel string) string {
	switch {
	case rel == "":
		return "empty"
	case len(rel) > 1024:
		return "too long"
	case strings.IndexByte(rel, 0) >= 0:
		return "contains a NUL"
	case strings.HasPrefix(rel, "/"):
		return "absolute"
	case strings.Contains(rel, `\`):
		return "contains a backslash"
	}
	for _, seg := range strings.Split(rel, "/") {
		switch seg {
		case "":
			return "empty segment"
		case ".", "..":
			return "'.' or '..' segment"
		}
	}
	if rel == "." || rel == ".." {
		return "'.' or '..'"
	}
	return ""
}

// secInvalid is the field-level refusal, named the way projects.go names its
// own: a request that decodes but asks for something the schema forbids is 422,
// and the 400s in this file are only for bodies that do not decode at all (or,
// in one case, decode into a field that must not be there).
func secInvalid(w http.ResponseWriter, detail string) {
	WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed", detail)
}

// validUUIDString is the local uuid shape check. api must not import
// internal/secrets (the crypto package has no business in the HTTP layer), and a
// non-uuid id can never name a row, so the check belongs here.
func validUUIDString(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range []byte(s) {
		switch {
		case i == 8 || i == 13 || i == 18 || i == 23:
			if c != '-' {
				return false
			}
		case (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'):
		default:
			return false
		}
	}
	return true
}
