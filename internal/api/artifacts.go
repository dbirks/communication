package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/authz"
)

// Artifact routes (ADR-0020 D3/D5, docs/m3-contract.md § 2, api/openapi.yaml's
// `artifacts` tag). Three rules shape everything below:
//
//   - Metadata is the index, never the backend. `storage_key` and the absolute
//     paths behind it are not serialized to a browser (m3-contract § 2), which
//     is why ArtifactView marks them `json:"-"` rather than omitting them in
//     each handler — a per-handler rule is a rule someone forgets.
//   - Sensitivity gates bytes, not just rows (ADR-0020 D3): contributor for
//     standard/internal, maintainer for restricted, and `secret` has no
//     download path in M3 at all.
//   - There is no PUT, PATCH or DELETE anywhere under /artifacts: rows are
//     immutable and content-addressed, so a retry is the same row.
//
// Rendering artifact HTML is not this origin's job. `/content` downgrades
// `text/html` (and `image/svg+xml`, same hazard) to `text/plain` with
// `Content-Disposition: attachment`, and the only place artifact script can
// even be offered to a browser is the preview origin
// (`internal/api/artifact_preview.go`, ADR-0020 D6).

// Errors the artifact handlers understand. The store adapter maps its own
// errors onto these so this package keeps its no-driver rule.
var (
	// ErrArtifactNotFound is also the answer to "you may not know this exists":
	// a non-member gets 404 plus an audit row, never a 403 that would confirm
	// the project or artifact is real (`12-test-strategy` case 15).
	ErrArtifactNotFound = errors.New("api: artifact not found")
	// ErrArtifactForbidden is a member whose role does not reach this
	// sensitivity level (403).
	ErrArtifactForbidden = errors.New("api: artifact is not available at your project role")
	// ErrArtifactNotReady is a row whose bytes are not in a servable state
	// (uploading, orphan, deleted). Handlers answer 404 for it: an
	// intermediate state is not information a browser needs, and a token
	// cannot be traded for a half-written artifact.
	ErrArtifactNotReady = errors.New("api: artifact bytes are not available")
)

// ArtifactView is the Artifact schema of api/openapi.yaml. The three
// backend-only fields are exported for the adapter and tagged `json:"-"`:
// a test asserts the serialized form never carries them.
type ArtifactView struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`

	RunID           *string `json:"run_id"`
	NodeExecutionID *string `json:"node_execution_id"`
	AttemptID       *string `json:"attempt_id"`
	ConversationID  *string `json:"conversation_id"`
	TurnID          *string `json:"turn_id"`
	WorkerID        *string `json:"worker_id"`

	Name        string `json:"name"`
	Kind        string `json:"kind"`
	MediaType   string `json:"media_type"`
	SHA256      string `json:"sha256"`
	SizeBytes   int64  `json:"size_bytes"`
	Sensitivity string `json:"sensitivity"`
	State       string `json:"state"`

	RedactionCount int        `json:"redaction_count"`
	CreatedBy      string     `json:"created_by"`
	CreatedAt      time.Time  `json:"created_at"`
	ReadyAt        *time.Time `json:"ready_at"`
	ExpiresAt      *time.Time `json:"expires_at"`
	DeletedAt      *time.Time `json:"deleted_at"`

	// PreviewURL is the *template* `…/preview/{token}`; the token is minted by
	// POST /artifacts/{id}/preview-token, never embedded here, because a URL
	// with a live token lands in browser history and proxy logs (ADR-0020 D5).
	// Absent when the caller may not mint one.
	PreviewURL *string `json:"preview_url,omitempty"`

	// StorageBackend and StorageKey locate the bytes. Never serialized.
	StorageBackend string `json:"-"`
	StorageKey     string `json:"-"`
	// MyRole is the caller's role in the artifact's project, which the
	// handlers use to decide preview/mint eligibility. Never serialized.
	MyRole string `json:"-"`
}

// ArtifactList is the ArtifactList schema: `{"artifacts":[…]}`.
type ArtifactList struct {
	Artifacts []ArtifactView `json:"artifacts"`
}

// PreviewTokenResponse is the PreviewToken schema. `token` is writeOnly in the
// OpenAPI document — it is the credential, and it appears in this response and
// nowhere else: not an event, not a log line, not a second API field.
type PreviewTokenResponse struct {
	ArtifactID string    `json:"artifact_id"`
	Token      string    `json:"token,omitempty"`
	PreviewURL string    `json:"preview_url"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// ArtifactStore is what the artifact handlers need from the datastore. Every
// method enforces the caller's project visibility itself, in SQL (09: "Every
// sensitive query includes project permission predicate"), and answers with
// the sentinel errors above.
type ArtifactStore interface {
	ListArtifacts(ctx context.Context, c Caller, projectID string) ([]ArtifactView, error)
	GetArtifact(ctx context.Context, c Caller, artifactID string) (ArtifactView, error)
	RecordDenied(ctx context.Context, c Caller, projectID, action string) error
}

// ArtifactBytes is the slice of internal/artifacts a handler needs. Taking the
// narrow interface rather than an artifacts.Store keeps the download path from
// acquiring Put/Delete/Presign by accident.
type ArtifactBytes interface {
	Open(ctx context.Context, ref artifacts.Ref) (io.ReadCloser, int64, error)
}

// PreviewTokens mints and checks the HMAC'd single-artifact tokens
// (artifacts.Signer is the implementation; an interface keeps the handlers
// testable without key material).
type PreviewTokens interface {
	Sign(t artifacts.Token) (string, error)
	Verify(token string, now time.Time) (artifacts.Token, error)
}

// PreviewConfig wires the preview origin.
type PreviewConfig struct {
	// Host is the preview origin's host[:port] (COMMUNICATION_PREVIEW_HOST,
	// e.g. "preview.localhost:18084"). Requests arriving on any other Host are
	// refused with 404: this binary answers preview documents on one hostname
	// only, because a *hostname* difference is what removes the session cookie
	// (ADR-0020 D6).
	Host string
	// BaseURL is what a minted preview_url is prefixed with
	// (COMMUNICATION_PREVIEW_BASE_URL, e.g. http://preview.localhost:18084).
	BaseURL string
	// TTL is the requested token lifetime, clamped by artifacts.ClampTokenTTL.
	TTL time.Duration
	// Tokens, Store and Bytes do the work; Store.ArtifactForPreview is the
	// token-authorized read, and Bytes is the artifact backend.
	Tokens PreviewTokens
	Store  PreviewStore
	Bytes  ArtifactBytes
}

// PreviewStore is the preview origin's datastore need. It deliberately takes
// no Caller: whoever arrives here has already been authorized by a signature,
// and a method that wanted a user would either fail or invent one.
type PreviewStore interface {
	ArtifactForPreview(ctx context.Context, artifactID string) (ArtifactView, error)
}

// RegisterArtifacts mounts the artifact routes of api/openapi.yaml on s.
// store may not be nil; bytes may be nil, in which case `/content` answers 503
// rather than pretending an artifact has no bytes (ADR-0020 Consequences: a
// mis-mounted artifact root is a readiness problem, and a handler that
// silently 404s would hide it).
func RegisterArtifacts(s *Server, store ArtifactStore, bytes ArtifactBytes, preview PreviewConfig) {
	h := &artHandlers{
		store:   store,
		bytes:   bytes,
		tokens:  preview.Tokens,
		host:    preview.Host,
		baseURL: trimTrailingSlash(preview.BaseURL),
		ttl:     preview.TTL,
		srv:     s,
	}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/artifacts", http.HandlerFunc(h.listArtifacts))
	s.HandleAuthed("GET /api/v1/artifacts/{artifactId}", http.HandlerFunc(h.getArtifact))
	s.HandleAuthed("GET /api/v1/artifacts/{artifactId}/content", http.HandlerFunc(h.getArtifactContent))
	s.HandleAuthed("POST /api/v1/artifacts/{artifactId}/preview-token", http.HandlerFunc(h.createPreviewToken))
}

// RegisterPreview mounts the preview origin's handler on the same Server. The
// route is not an /api/v1 operation on purpose: a path under /api/v1 would
// share the app's cookie scope, and the whole isolation is that it does not.
//
// See PreviewHostOnly for the other half of the origin rule.
func RegisterPreview(s *Server, cfg PreviewConfig) {
	h := &previewHandlers{
		host:   cfg.Host,
		tokens: cfg.Tokens,
		store:  cfg.Store,
		bytes:  cfg.Bytes,
		srv:    s,
	}
	s.Handle("GET /preview/{token}", http.HandlerFunc(h.serve))
	s.Handle("GET /preview/", http.HandlerFunc(h.refuse))
}

// PreviewHostOnly completes ADR-0020 D6's second half from the other side: when
// a request arrives on the preview host, nothing except /preview/* exists — the
// SPA shell and every API route are absent there. A ServeMux cannot match on
// Host, so this is a listener-level wrapper, and mounting it is required
// configuration for the preview origin rather than an option: the shell it
// suppresses is a same-origin document containing the app's own script.
func PreviewHostOnly(host string) func(http.Handler) http.Handler {
	return (&previewHandlers{host: host}).originOnly
}

type artHandlers struct {
	store   ArtifactStore
	bytes   ArtifactBytes
	tokens  PreviewTokens
	host    string
	baseURL string
	ttl     time.Duration
	srv     *Server
}

func (h *artHandlers) listArtifacts(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	list, err := h.store.ListArtifacts(r.Context(), c, projectID)
	if err != nil {
		h.fail(w, r, c, projectID, "artifact.list", err)
		return
	}
	for i := range list {
		list[i].PreviewURL = h.previewTemplate(list[i])
	}
	if list == nil {
		list = []ArtifactView{}
	}
	WriteJSON(w, http.StatusOK, ArtifactList{Artifacts: list})
}

func (h *artHandlers) getArtifact(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	artifactID := r.PathValue("artifactId")
	view, err := h.store.GetArtifact(r.Context(), c, artifactID)
	if err != nil {
		h.fail(w, r, c, "", "artifact.get", err)
		return
	}
	// `restricted` and `secret` metadata belong to a maintainer; a viewer who
	// can see the project but not this row gets 403 (they are allowed to know
	// the project has artifacts; ADR-0020 D3 decides what they may learn).
	if !artMaySeeMetadata(view, c) {
		h.denied(w, r, c, view.ProjectID, "artifact.get")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Your project role does not reach this artifact's sensitivity label.")
		return
	}
	view.PreviewURL = h.previewTemplate(view)
	WriteJSON(w, http.StatusOK, view)
}

func (h *artHandlers) getArtifactContent(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	artifactID := r.PathValue("artifactId")
	view, err := h.store.GetArtifact(r.Context(), c, artifactID)
	if err != nil {
		h.fail(w, r, c, "", "artifact.content", err)
		return
	}
	if view.State != "ready" {
		// Never bytes for an uploading/orphan/deleted row (m3-contract § 2),
		// and never a state lesson for the caller: it is a 404.
		h.denied(w, r, c, view.ProjectID, "artifact.content")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
		return
	}
	if !artMayDownload(view, c) {
		h.denied(w, r, c, view.ProjectID, "artifact.content")
		if errors.Is(err, ErrArtifactForbidden) {
			WriteProblem(w, http.StatusForbidden, "Forbidden",
				"Your project role does not reach this artifact's sensitivity label.")
			return
		}
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"This artifact's sensitivity label has no download path.")
		return
	}
	if h.bytes == nil {
		h.serverError(w, r, view.ProjectID, "artifact.content",
			errors.New("api: no artifact byte backend is configured"))
		return
	}
	ref := artifacts.Ref{
		ID: view.ID, ProjectID: view.ProjectID, StorageBackend: view.StorageBackend,
		StorageKey: view.StorageKey, SHA256: view.SHA256, SizeBytes: view.SizeBytes,
		MediaType: view.MediaType,
	}
	rc, size, err := h.bytes.Open(r.Context(), ref)
	if err != nil {
		h.bytesFailure(w, r, c, view, err)
		return
	}
	defer rc.Close()

	hdr := w.Header()
	// `nosniff` always: a stored media type that disagrees with the bytes must
	// not be allowed to become a renderer by sniffing (ADR-0020 D5).
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Cache-Control", "no-store")
	if artUnsafeToRender(view.MediaType) {
		// A download link must never be a renderer (m3-contract § 2).
		hdr.Set("Content-Type", "text/plain; charset=utf-8")
		hdr.Set("Content-Disposition", `attachment; filename="`+artFilename(view)+`"`)
		hdr.Set("X-Content-Type-Options", "nosniff")
	} else {
		hdr.Set("Content-Type", view.MediaType)
		hdr.Set("Content-Disposition", `inline; filename="`+artFilename(view)+`"`)
	}
	if size > 0 {
		hdr.Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil {
		// Headers are already on the wire; the only honest signal left is that
		// the body stops short, plus a log line a test can point at.
		h.log(r).WarnContext(r.Context(), "artifact stream ended early",
			slog.String("artifact_id", view.ID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
	}
}

func (h *artHandlers) createPreviewToken(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	artifactID := r.PathValue("artifactId")
	view, err := h.store.GetArtifact(r.Context(), c, artifactID)
	if err != nil {
		h.fail(w, r, c, "", "artifact.preview_token", err)
		return
	}
	if view.State != "ready" || !artMayMintPreview(view, c) {
		h.denied(w, r, c, view.ProjectID, "artifact.preview_token")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Preview tokens are minted for standard or internal HTML and images only.")
		return
	}
	if h.tokens == nil || h.baseURL == "" {
		h.serverError(w, r, view.ProjectID, "artifact.preview_token",
			errors.New("api: no preview token signer or preview base URL is configured"))
		return
	}
	exp := time.Now().UTC().Add(artifacts.ClampTokenTTL(h.ttl)).Truncate(time.Second)
	token, err := h.tokens.Sign(artifacts.Token{
		Scope: artifacts.ScopePreview, ArtifactID: view.ID, SHA256: view.SHA256, ExpiresAt: exp,
	})
	if err != nil {
		h.serverError(w, r, view.ProjectID, "artifact.preview_token", err)
		return
	}
	// Minting is an access and is audited as one, even though the token is what
	// later authorizes the fetch (ADR-0020 D5, 06's download-authorization
	// rule). The audit row names the artifact, never the token.
	h.auditAccess(r, c, view, "artifact.preview_token")

	WriteJSON(w, http.StatusOK, PreviewTokenResponse{
		ArtifactID: view.ID,
		Token:      token,
		PreviewURL: h.baseURL + "/preview/" + token,
		ExpiresAt:  exp,
	})
}

// previewTemplate renders the preview_url *template*: the URL with the literal
// `{token}` placeholder, per openapi's Artifact.preview_url. A live token here
// would be a credential in a browser history entry.
func (h *artHandlers) previewTemplate(v ArtifactView) *string {
	if h.baseURL == "" || !artifacts.Previewable(v.Kind, v.Sensitivity) || v.State != "ready" {
		return nil
	}
	// The template itself carries no secret, so it is shown to anyone who may
	// see the metadata; the *token* is where the role gate bites.
	t := h.baseURL + "/preview/{token}"
	return &t
}

// bytesFailure keeps a backend failure out of the client's face while keeping
// it visible in the log: a digest mismatch is a corrupted volume, a not-found
// is an orphan, and neither is the caller's error to read.
func (h *artHandlers) bytesFailure(w http.ResponseWriter, r *http.Request, c Caller, view ArtifactView, err error) {
	switch {
	case errors.Is(err, artifacts.ErrNotFound), errors.Is(err, artifacts.ErrDigestMismatch):
		// The row promises bytes that the backend cannot produce honestly.
		// That is 404 to the caller (09: no bytes for a row that is not there)
		// and an error to the log, because it means the sweep or the volume is
		// wrong.
		h.log(r).ErrorContext(r.Context(), "artifact bytes unavailable",
			slog.String("artifact_id", view.ID),
			slog.String("project_id", view.ProjectID),
			slog.Bool("digest_mismatch", errors.Is(err, artifacts.ErrDigestMismatch)),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
	default:
		h.serverError(w, r, view.ProjectID, "artifact.content", err)
	}
}

// --- shared plumbing (mirrors the projects/conversations handlers) --------

func (h *artHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.serverError(w, r, "", "no action", errors.New("api: no principal in context"))
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// fail maps a store error onto the HTTP contract: 404 (plus an audit row) for
// anything the caller may not see, 403 for a role that does not reach the
// sensitivity label, 500 for everything else.
func (h *artHandlers) fail(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string, err error) {
	switch {
	case errors.Is(err, ErrArtifactForbidden):
		h.denied(w, r, c, projectID, action)
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Your project role does not reach this artifact's sensitivity label.")
	case errors.Is(err, ErrArtifactNotReady):
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
	case errors.Is(err, ErrArtifactNotFound), errors.Is(err, ErrProjectNotFound):
		h.denied(w, r, c, projectID, action)
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
	default:
		h.serverError(w, r, projectID, action, err)
	}
}

// denied records a refused attempt. A failure to record it must not change the
// answer — the request is denied either way (ADR-0014 § 3).
func (h *artHandlers) denied(w http.ResponseWriter, r *http.Request, c Caller, projectID, action string) {
	h.recordAudit(r, c, projectID, action, true)
}

// auditAccess records a *successful* sensitive access (a minted preview token),
// which 06 asks for as its own event: "who looked", not only "who was allowed
// to".
func (h *artHandlers) auditAccess(r *http.Request, c Caller, view ArtifactView, action string) {
	h.recordAudit(r, c, view.ProjectID, action, false)
}

func (h *artHandlers) recordAudit(r *http.Request, c Caller, projectID, action string, denied bool) {
	if denied {
		if err := h.store.RecordDenied(r.Context(), c, projectID, action); err != nil {
			h.log(r).ErrorContext(r.Context(), "could not write audit denial",
				slog.String("action", action),
				slog.String("project_id", projectID),
				slog.String("request_id", RequestIDFrom(r)),
				slog.Any("error", err))
			return
		}
	}
	h.log(r).WarnContext(r.Context(), "artifact access",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("project_id", projectID),
		slog.Bool("denied", denied),
		slog.String("request_id", RequestIDFrom(r)))
}

func (h *artHandlers) serverError(w http.ResponseWriter, r *http.Request, projectID, action string, err error) {
	h.log(r).ErrorContext(r.Context(), "artifact store failure",
		slog.String("action", action),
		slog.String("project_id", projectID),
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *artHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// ADR-0020 D3's table, in one place, delegating to internal/authz so the role
// algebra is the same one the rest of the API uses.

func artMaySeeMetadata(v ArtifactView, c Caller) bool {
	role := authz.Role(v.MyRole)
	// ADR-0020 D3: `restricted` and `secret` metadata belong to a maintainer.
	// A member's *listing* still shows a restricted row (name, kind, size,
	// sensitivity — never a storage pointer), which is why this gate is on the
	// single-artifact read and not on the list.
	switch v.Sensitivity {
	case artifacts.SensitivityStandard, artifacts.SensitivityInternal:
		return authz.CanView(c.IsOrgAdmin, role)
	default:
		return authz.CanManage(c.IsOrgAdmin, role)
	}
}

func artMayDownload(v ArtifactView, c Caller) bool {
	if v.State != "ready" {
		return false
	}
	role := authz.Role(v.MyRole)
	switch v.Sensitivity {
	case artifacts.SensitivityStandard, artifacts.SensitivityInternal:
		// Contributor and above (m3-contract § 2's role gate on /content).
		return artCanContribute(c.IsOrgAdmin, role)
	case artifacts.SensitivityRestricted:
		return authz.CanManage(c.IsOrgAdmin, role)
	default:
		// "secret" has no download path in M3 for anyone (ADR-0020 D3).
		return false
	}
}

func artMayMintPreview(v ArtifactView, c Caller) bool {
	if v.State != "ready" {
		return false
	}
	if !artifacts.Previewable(v.Kind, v.Sensitivity) {
		return false
	}
	return artCanContribute(c.IsOrgAdmin, authz.Role(v.MyRole))
}

// artCanContribute is "contributor or above": authz has no such predicate yet
// (M2 gave contributor no read-only-project powers of its own), so it is
// spelled here rather than stretched into authz for one route.
func artCanContribute(isOrgAdmin bool, role authz.Role) bool {
	if isOrgAdmin {
		return true
	}
	return role == authz.RoleMaintainer || role == authz.RoleContributor
}

// artUnsafeToRender is internal/artifacts' judgement that a media type can run
// script when rendered; the app origin serves such artifacts as text/plain.
func artUnsafeToRender(mediaType string) bool { return artifacts.UnsafeInline(mediaType) }

// artFilename is the artifact's name made safe for a Content-Disposition
// header: the name is author-supplied metadata and is never trusted with a
// header (ADR-0020 Security).
func artFilename(v ArtifactView) string {
	return artifacts.SanitizeFilename(v.Name)
}

func trimTrailingSlash(s string) string {
	for len(s) > 1 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
