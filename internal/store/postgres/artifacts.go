package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/authz"
)

// Artifact reads over the migration-00004 `artifacts` table (ADR-0020 D2/D3,
// docs/m3-contract.md § 1–2). Bytes never appear here: an artifact row is a
// pointer into internal/artifacts, and `storage_key` leaves this package only
// inside a Ref that the byte backend consumes — it is never serialized to a
// browser (m3-contract § 2).
//
// The write path is deliberately absent. An artifact becomes `ready` only in the
// same fenced transaction that appends `artifact.created` (ADR-0016 § 9.2), and
// that belongs to the worker's publish step, not to a reader.

// Artifact is one artifacts row plus the calling user's role in its project.
type Artifact struct {
	ID              string
	OrganizationID  string
	ProjectID       string
	RunID           string
	NodeExecutionID string
	AttemptID       string
	ConversationID  string
	TurnID          string
	WorkerID        string
	Name            string
	Kind            string
	MediaType       string
	SHA256          string
	SizeBytes       int64
	StorageBackend  string
	StorageKey      string
	Sensitivity     string
	State           string
	RedactionCount  int
	CreatedBy       string
	CreatedAt       time.Time
	ReadyAt         *time.Time
	ExpiresAt       *time.Time
	DeletedAt       *time.Time

	// MyRole is the caller's membership role in the artifact's project ('' for
	// an org admin with no membership row, which authz treats as maintainer).
	MyRole string
}

// artArtifactColumns is the row shape of every artifact read below. Ids that
// are NULL are scanned as empty strings, because every consumer of these values
// (events, preview tokens, JSON views) treats "" as absent and a *string per
// column would turn a NULL into a nil-deref somewhere less obvious.
const artArtifactColumns = `
	SELECT a.id::text, a.organization_id::text, a.project_id::text,
	       COALESCE(a.run_id::text, ''), COALESCE(a.node_execution_id::text, ''),
	       COALESCE(a.attempt_id::text, ''), COALESCE(a.conversation_id::text, ''),
	       COALESCE(a.turn_id::text, ''), COALESCE(a.worker_id::text, ''),
	       a.name, a.kind, a.media_type, a.sha256, a.size_bytes,
	       a.storage_backend, a.storage_key, a.sensitivity, a.state,
	       a.redaction_count, a.created_by, a.created_at,
	       a.ready_at, a.expires_at, a.deleted_at`

// The role column comes from the query's FROM, because the two backend reads
// have no caller whose role could be resolved.
const (
	artRoleWithCaller = `, COALESCE(m.role, '')` + artSelectScope
	artRoleNoCaller   = `, '' AS role FROM artifacts a`
)

// artSelectScope is the project predicate, in the query and not in Go
// (09: "Every sensitive query includes project permission predicate, not a
// client-controlled header"; ADR-0014 §3: a caller who is not a member of the
// project may not learn the artifact exists, so no row is returned to them at
// all — and the audit row is written by the handler on that answer).
//
//	$1 caller user id   $2 caller organization   $3 caller is org admin
const artSelectScope = `
	FROM artifacts a
	LEFT JOIN memberships m ON m.project_id = a.project_id AND m.user_id = $1::uuid
	WHERE (a.organization_id = $2::uuid
	       AND ($3::boolean OR m.user_id IS NOT NULL))`

// ListArtifacts returns the project's `ready` artifacts the caller's role may
// see, newest first (api/openapi.yaml listProjectArtifacts). An empty
// conversationID answers the project-wide list; a set one answers the
// artifacts of that one conversation (see the thread filter below).
//
// The sensitivity table (ADR-0020 D3) is applied **here**, in SQL:
//
//	standard | internal   → every member
//	restricted | secret   → maintainers and org admins only
//
// and a `secret` row additionally disappears from listing *entirely* — the
// label exists so the policy has a place to grow, and listing it would be the
// leak the label is meant to prevent. Filtering after the query would make the
// answer depend on which handler remembered to call which helper.
//
// The optional conversationID is the thread filter the thread-rail redesign
// asks for (docs/design/handoff-app-shell/gaps/threads.md, W3): it names the
// conversation whose artifacts are wanted — the rows its own turns captured
// plus the rows its started runs captured (`runs.source_conversation_id`,
// ADR-0053) — and it resolves first, so a conversation the caller may not see
// is the same invisible answer as a project they may not see: not-found, never
// an empty list that would confirm the project exists (`12-test-strategy`
// case 15).
func (s *ArtifactStore) ListArtifacts(ctx context.Context, c Caller, projectID string, conversationID string) ([]Artifact, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if !prjValidUUID(projectID) {
		return nil, ErrProjectNotFound
	}
	// The project itself is the gate for the collection route: a non-member must
	// hear 404 (plus an audit row), not "200, here is an empty list", which
	// would confirm the project exists (`12-test-strategy` case 15).
	if _, err := prjGetProject(ctx, s.Pool, c, projectID); err != nil {
		return nil, err
	}
	// The thread filter must resolve through the same project-scoped predicate
	// as the list itself. A conversation that is unknown, in another project, or
	// invisible to the caller answers not-found here (the handler maps it to the
	// not-found sentinel and audits the denial); a conversation that resolved is
	// a real answer, even when it turns out to hold no artifacts yet.
	if conversationID != "" {
		if !prjValidUUID(conversationID) {
			return nil, ErrArtifactNotFound
		}
		convProject, _, _, err := cnvResolveProject(ctx, s.Pool, c, conversationID)
		if err != nil {
			return nil, ErrArtifactNotFound
		}
		// The thread must be *this* project's thread: a conversation that exists
		// but belongs to another project is not this list's subject, and the
		// not-found answer covers that too.
		if convProject != projectID {
			return nil, ErrArtifactNotFound
		}
	}
	var rows pgx.Rows
	var err error
	if conversationID == "" {
		rows, err = s.Pool.Query(ctx, `
		`+artArtifactColumns+artRoleWithCaller+`
		  AND a.project_id = $4::uuid
		  AND a.state = 'ready'
		  AND a.sensitivity <> 'secret'
		  AND (a.sensitivity <> 'restricted'
		       OR $3::boolean OR m.role = 'maintainer')
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT $5`,
			c.UserID, c.OrganizationID, c.IsOrgAdmin, projectID, artListLimit)
	} else {
		rows, err = s.Pool.Query(ctx, `
		`+artArtifactColumns+artRoleWithCaller+`
		  AND a.project_id = $4::uuid
		  AND a.state = 'ready'
		  AND a.sensitivity <> 'secret'
		  AND (a.sensitivity <> 'restricted'
		       OR $3::boolean OR m.role = 'maintainer')
		  AND (a.conversation_id = $5::uuid
		       OR a.run_id IN (
		           SELECT r.id FROM runs r
		           WHERE r.source_conversation_id = $5::uuid
		       ))
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT $6`,
			c.UserID, c.OrganizationID, c.IsOrgAdmin, projectID, conversationID, artListLimit)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: list artifacts: %w", err)
	}
	defer rows.Close()
	return artScanArtifacts(rows)
}

// GetArtifact reads one artifact by id. ErrArtifactNotFound is also the answer
// for "you are not a member of its project"; the caller's role comes back on
// the row so the caller can distinguish "may see metadata" from "may have
// bytes" without a second query.
func (s *ArtifactStore) GetArtifact(ctx context.Context, c Caller, artifactID string) (Artifact, error) {
	if err := prjRequireCaller(c); err != nil {
		return Artifact{}, err
	}
	if !prjValidUUID(artifactID) {
		return Artifact{}, ErrArtifactNotFound
	}
	return artQueryArtifact(ctx, s.Pool, artifactQueryArgs(c, artifactID))
}

// ArtifactForPreview reads one artifact by id for the preview origin, where the
// caller is not a session but a signature. It exists as its own method because
// it must *not* carry a Caller: a preview fetch has no user, and a code path
// that asked for one would either fail or pretend.
//
// Only a `ready`, previewable artifact is returned — a `restricted` or `secret`
// row answers not-found even though a token existed for it, so a token minted
// before a sensitivity change cannot outlive that change.
func (s *ArtifactStore) ArtifactForPreview(ctx context.Context, artifactID string) (Artifact, error) {
	if !prjValidUUID(artifactID) {
		return Artifact{}, ErrArtifactNotFound
	}
	var a Artifact
	err := s.Pool.QueryRow(ctx, `
		`+artArtifactColumns+artRoleNoCaller+`
		  WHERE a.id = $1::uuid
		  AND a.state = 'ready'
		  AND a.sensitivity IN ('standard', 'internal')
		  AND a.kind IN ('html', 'image')`,
		artifactID).Scan(artScanArtifactDest(&a)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return Artifact{}, ErrArtifactNotFound
	}
	if err != nil {
		return Artifact{}, fmt.Errorf("postgres: read artifact for preview: %w", err)
	}
	return artFinish(a), nil
}

// ArtifactStore reads artifact metadata and nothing else: bytes belong to
// internal/artifacts, and the write path belongs to the worker's fenced
// publish. A stateless replica can run it against the same pool (ADR-0014).
type ArtifactStore struct {
	Pool *pgxpool.Pool
}

// Errors of the artifact reads.
var (
	// ErrArtifactNotFound is "no such artifact", and also "such an artifact
	// may exist and you may not know it": the same answer either way
	// (ADR-0014 § 3).
	ErrArtifactNotFound = errors.New("postgres: artifact not found")
	// ErrArtifactForbidden means the caller may know the artifact exists but
	// may not have what they asked for — the role/sensitivity gate of
	// ADR-0020 D3's table.
	ErrArtifactForbidden = errors.New("postgres: artifact is not downloadable at your project role")
	// ErrArtifactNotReady means the row exists but its bytes are not in a
	// servable state (uploading, orphan or deleted).
	ErrArtifactNotReady = errors.New("postgres: artifact bytes are not available")
)

func artQueryArtifact(ctx context.Context, q *pgxpool.Pool, args []any) (Artifact, error) {
	var a Artifact
	err := q.QueryRow(ctx, `
		`+artArtifactColumns+artRoleWithCaller+`
		  AND a.id = $4::uuid`, args...).Scan(artScanArtifactDest(&a)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return Artifact{}, ErrArtifactNotFound
	}
	if err != nil {
		return Artifact{}, fmt.Errorf("postgres: read artifact: %w", err)
	}
	return artFinish(a), nil
}

// artifactQueryArgs builds the shared $1..$3 of artSelectScope plus $4.
func artifactQueryArgs(c Caller, artifactID string) []any {
	return []any{c.UserID, c.OrganizationID, c.IsOrgAdmin, artifactID}
}

func artScanArtifacts(rows pgx.Rows) ([]Artifact, error) {
	var out []Artifact
	for rows.Next() {
		var a Artifact
		if err := rows.Scan(artScanArtifactDest(&a)...); err != nil {
			return nil, fmt.Errorf("postgres: scan artifact: %w", err)
		}
		out = append(out, artFinish(a))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read artifacts: %w", err)
	}
	return out, nil
}

// artScanArtifactDest returns the destination list matching
// artArtifactColumns' column order.
func artScanArtifactDest(a *Artifact) []any {
	return []any{
		&a.ID, &a.OrganizationID, &a.ProjectID, &a.RunID, &a.NodeExecutionID,
		&a.AttemptID, &a.ConversationID, &a.TurnID, &a.WorkerID,
		&a.Name, &a.Kind, &a.MediaType, &a.SHA256, &a.SizeBytes,
		&a.StorageBackend, &a.StorageKey, &a.Sensitivity, &a.State,
		&a.RedactionCount, &a.CreatedBy, &a.CreatedAt,
		&a.ReadyAt, &a.ExpiresAt, &a.DeletedAt, &a.MyRole,
	}
}

func artFinish(a Artifact) Artifact {
	a.CreatedAt = a.CreatedAt.UTC()
	if a.ReadyAt != nil {
		t := a.ReadyAt.UTC()
		a.ReadyAt = &t
	}
	if a.ExpiresAt != nil {
		t := a.ExpiresAt.UTC()
		a.ExpiresAt = &t
	}
	if a.DeletedAt != nil {
		t := a.DeletedAt.UTC()
		a.DeletedAt = &t
	}
	return a
}

// artListLimit bounds a page. The contract's pagination rule is "every list
// query carries a project predicate and a limit"; the UI page is smaller than
// the diagnostic one because a script asked for them both.
const artListLimit = 200

// CanDownload is ADR-0020 D3's role gate as a pure function, so the store, the
// API and a test can all ask the same question of the same inputs.
//
//	standard, internal   → contributor and above
//	restricted           → maintainer only
//	secret               → nobody: M3 has no download path for it at all
func (a Artifact) CanDownload(isOrgAdmin bool) bool {
	if a.State != "ready" {
		return false
	}
	role := authz.Role(a.MyRole)
	switch a.Sensitivity {
	case "standard", "internal":
		return authz.CanManage(isOrgAdmin, role) || role == authz.RoleContributor
	case "restricted":
		return authz.CanManage(isOrgAdmin, role)
	default: // "secret", and anything unknown, is refused rather than guessed
		return false
	}
}

// CanMintPreview is the preview-token half of the same table: contributor and
// above, and only for a sensitivity the preview origin is allowed to render.
func (a Artifact) CanMintPreview(isOrgAdmin bool) bool {
	if a.State != "ready" {
		return false
	}
	if a.Sensitivity != "standard" && a.Sensitivity != "internal" {
		return false
	}
	if a.Kind != "html" && a.Kind != "image" {
		return false
	}
	role := authz.Role(a.MyRole)
	return authz.CanManage(isOrgAdmin, role) || role == authz.RoleContributor
}

// artCleanArtifactID lowercases a uuid or returns "", so a probe with garbage
// still produces a legible audit row instead of a cast error.
func artCleanArtifactID(s string) string {
	if !prjValidUUID(s) {
		return ""
	}
	return strings.ToLower(s)
}
