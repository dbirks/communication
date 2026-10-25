package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
)

// Errors returned by the project store. Callers map these to HTTP statuses;
// everything else is an infrastructure failure worth logging.
var (
	// ErrProjectNotFound means the project does not exist, or the caller may
	// not be told that it does: the two cases return the same error so that
	// project existence never leaks across membership (ADR-0014 §3).
	ErrProjectNotFound = errors.New("postgres: project not found")

	// ErrConflict means a unique constraint stopped the write — a duplicate
	// project slug in the organization or a duplicate repository name in the
	// project.
	ErrConflict = errors.New("postgres: unique constraint violation")
)

// Caller identifies the human on the other side of a store call. It carries
// no secrets and is never built from client-supplied ids: the API layer fills
// it from the authenticated principal.
type Caller struct {
	UserID         string
	OrganizationID string
	IsOrgAdmin     bool
}

// Project is a project plus the calling user's role in it (MyRole). An
// organization admin with no explicit membership is reported as maintainer,
// matching Project.my_role in api/openapi.yaml.
type Project struct {
	ID             string
	OrganizationID string
	Slug           string
	Name           string
	Description    string
	CreatedAt      time.Time
	Version        int
	MyRole         string
}

// Repository is a git remote attached to a project.
type Repository struct {
	ID            string
	ProjectID     string
	Name          string
	GitURL        string
	DefaultBranch string
	CreatedAt     time.Time
	// CredentialSecretID is the ADR-0061 GitHub credential: the
	// integration_broker secret this repository's clone/fetch/issue reads
	// resolve through. Empty means none — anonymous, today's default.
	CredentialSecretID string
}

// Member is a project membership with the member's display name resolved.
type Member struct {
	UserID      string
	DisplayName string
	Role        string
}

// ProjectStore reads and writes projects, repositories and memberships and
// appends the journal rows that accompany every one of those writes. It is
// stateless: any replica may run it against the same pool (ADR-0014).
type ProjectStore struct {
	Pool *pgxpool.Pool
}

// prjQuerier is the narrow shape ProjectStore needs: *pgxpool.Pool and pgx.Tx
// both satisfy it, so one read path serves both the standalone case and the
// case where the read happens inside a write transaction.
type prjQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// prjProjectSelect is the shared visibility-scoped project read. $1 is the
// caller's user id (the membership join), $2 the caller's organization and $3
// whether the caller is an organization admin, which lets an admin see every
// project in the organization without holding a membership.
const prjProjectSelect = `
	SELECT p.id, p.organization_id, p.slug, p.name, p.description, p.created_at, p.version,
	       COALESCE(m.role, 'maintainer')
	FROM projects p
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// prjProjectSelectOne is the same read narrowed to one project id ($4).
const prjProjectSelectOne = prjProjectSelect + `
	  AND p.id = $4::uuid`

const prjRepositorySelect = `
	SELECT id, project_id::text, name, git_url, default_branch, created_at,
	       COALESCE(credential_secret_id::text, '')
	FROM repositories
	WHERE project_id = $1::uuid
	ORDER BY name, id`

const prjMemberSelect = `
	SELECT m.user_id::text, u.display_name, m.role
	FROM memberships m
	JOIN users u ON u.id = m.user_id
	WHERE m.project_id = $1::uuid
	ORDER BY u.display_name, m.user_id`

// ListProjects returns the projects the caller may see in their
// organization — everything for an org admin, otherwise only where they hold
// a membership — newest first (api/openapi.yaml listProjects).
func (s *ProjectStore) ListProjects(ctx context.Context, c Caller) ([]Project, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, prjProjectSelect+`
	ORDER BY p.created_at DESC, p.id DESC`, c.UserID, c.OrganizationID, c.IsOrgAdmin)
	if err != nil {
		return nil, fmt.Errorf("postgres: list projects: %w", err)
	}
	defer rows.Close()

	out := make([]Project, 0, 8)
	for rows.Next() {
		p, err := prjScanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read projects: %w", err)
	}
	return out, nil
}

// CreateProject inserts the project, makes the creator its maintainer and
// appends the project.created journal row — in one transaction, so a
// half-created project (or a project with no event) cannot exist. A duplicate
// slug in the organization is ErrConflict.
func (s *ProjectStore) CreateProject(ctx context.Context, c Caller, name, slug, description string) (Project, error) {
	if err := prjRequireCaller(c); err != nil {
		return Project{}, err
	}
	if strings.TrimSpace(name) == "" {
		return Project{}, errors.New("postgres: CreateProject requires a name")
	}
	if slug == "" {
		return Project{}, errors.New("postgres: CreateProject requires a slug")
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Project{}, fmt.Errorf("postgres: begin create project: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p Project
	p.OrganizationID = c.OrganizationID
	p.MyRole = string(authz.RoleMaintainer)
	err = tx.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, description, created_by)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid)
		RETURNING id, slug, name, description, created_at, version`,
		c.OrganizationID, slug, name, description, c.UserID).
		Scan(&p.ID, &p.Slug, &p.Name, &p.Description, &p.CreatedAt, &p.Version)
	if err != nil {
		if prjIsConflict(err) {
			return Project{}, ErrConflict
		}
		return Project{}, fmt.Errorf("postgres: insert project: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()

	if _, err := tx.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')`, p.ID, c.UserID); err != nil {
		return Project{}, fmt.Errorf("postgres: insert creator membership: %w", err)
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeProjectCreated,
		OrganizationID: c.OrganizationID,
		ProjectID:      p.ID,
		Actor:          events.Human(c.UserID),
		Payload:        map[string]any{"project_id": p.ID, "slug": p.Slug, "name": p.Name},
	}); err != nil {
		return Project{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Project{}, fmt.Errorf("postgres: commit create project: %w", err)
	}
	return p, nil
}

// GetProject reads one project with the caller's role in it. A project the
// caller cannot see — including one that exists in another organization and
// one the caller simply is not a member of — is ErrProjectNotFound, the same
// answer as a project that does not exist at all.
func (s *ProjectStore) GetProject(ctx context.Context, c Caller, projectID string) (Project, error) {
	if err := prjRequireCaller(c); err != nil {
		return Project{}, err
	}
	return prjGetProject(ctx, s.Pool, c, projectID)
}

// prjGetProject runs the visibility-scoped read on q (pool or open tx).
func prjGetProject(ctx context.Context, q prjQuerier, c Caller, projectID string) (Project, error) {
	if !prjValidUUID(projectID) {
		return Project{}, ErrProjectNotFound
	}
	var p Project
	err := q.QueryRow(ctx, prjProjectSelectOne,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, projectID).
		Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.Name, &p.Description,
			&p.CreatedAt, &p.Version, &p.MyRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrProjectNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("postgres: get project: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()
	return p, nil
}

// ListRepositories reads a project's repositories ordered by name. Callers
// who cannot see the project get ErrProjectNotFound.
func (s *ProjectStore) ListRepositories(ctx context.Context, c Caller, projectID string) ([]Repository, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if _, err := s.GetProject(ctx, c, projectID); err != nil {
		return nil, err
	}
	return prjListRepositories(ctx, s.Pool, projectID)
}

func prjListRepositories(ctx context.Context, q prjQuerier, projectID string) ([]Repository, error) {
	rows, err := q.Query(ctx, prjRepositorySelect, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list repositories: %w", err)
	}
	defer rows.Close()

	out := make([]Repository, 0, 4)
	for rows.Next() {
		var r Repository
		if err := rows.Scan(&r.ID, &r.ProjectID, &r.Name, &r.GitURL, &r.DefaultBranch, &r.CreatedAt,
			&r.CredentialSecretID); err != nil {
			return nil, fmt.Errorf("postgres: scan repository: %w", err)
		}
		r.CreatedAt = r.CreatedAt.UTC()
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read repositories: %w", err)
	}
	return out, nil
}

// AddRepository attaches a git remote to a project and appends the
// repository.added journal row in the same transaction. Only callers who can
// manage the project reach the insert: the read and the write share the
// transaction, so a membership revoked between the handler's check and this
// one cannot sneak a repository in. A duplicate name within the project is
// ErrConflict. credentialSecretID (ADR-0061) is "" for none; a non-empty one
// is validated against the project before the insert (ErrRepositoryCredential
// Invalid otherwise), and the migration-00016 trigger backs the same rule at
// the row.
func (s *ProjectStore) AddRepository(ctx context.Context, c Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (Repository, error) {
	if err := prjRequireCaller(c); err != nil {
		return Repository{}, err
	}
	if strings.TrimSpace(name) == "" || strings.TrimSpace(gitURL) == "" {
		return Repository{}, errors.New("postgres: AddRepository requires a name and git_url")
	}
	if defaultBranch == "" {
		defaultBranch = "main"
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Repository{}, fmt.Errorf("postgres: begin add repository: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	project, err := prjGetProject(ctx, tx, c, projectID)
	if err != nil {
		return Repository{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(project.MyRole)) {
		// Same answer as "no such project": a member who cannot manage must
		// learn nothing more than that this call is not available to them.
		// Handlers turn this into 403 before reaching here; the check is
		// defence-in-depth, not the only gate.
		return Repository{}, ErrProjectNotFound
	}
	if credentialSecretID != "" {
		if err := prjValidateCredential(ctx, tx, projectID, credentialSecretID); err != nil {
			return Repository{}, err
		}
	}

	var repo Repository
	err = tx.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by, credential_secret_id)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid, NULLIF($6, '')::uuid)
		RETURNING id, project_id::text, name, git_url, default_branch, created_at,
		          COALESCE(credential_secret_id::text, '')`,
		projectID, name, gitURL, defaultBranch, c.UserID, credentialSecretID).
		Scan(&repo.ID, &repo.ProjectID, &repo.Name, &repo.GitURL, &repo.DefaultBranch, &repo.CreatedAt,
			&repo.CredentialSecretID)
	if err != nil {
		if prjIsConflict(err) {
			return Repository{}, ErrConflict
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23514" &&
			strings.Contains(pgErr.Message, "credential") {
			// The migration-00016 trigger refused what the Go check above
			// raced past (a concurrent policy change): the same typed answer,
			// not a 500.
			return Repository{}, fmt.Errorf("%w: %s", ErrRepositoryCredentialInvalid, pgErr.Message)
		}
		return Repository{}, fmt.Errorf("postgres: insert repository: %w", err)
	}
	repo.CreatedAt = repo.CreatedAt.UTC()

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeRepositoryAdded,
		OrganizationID: project.OrganizationID,
		ProjectID:      projectID,
		Actor:          events.Human(c.UserID),
		// The payload carries everything a browser needs to render the addition
		// without refetching, which is what the envelope schema's
		// repository.added example shows (api/schemas/event-envelope.schema.json).
		Payload: map[string]any{
			"repository_id":  repo.ID,
			"name":           repo.Name,
			"git_url":        repo.GitURL,
			"default_branch": repo.DefaultBranch,
		},
	}); err != nil {
		return Repository{}, err
	}

	if err := prjBumpProject(ctx, tx, projectID); err != nil {
		return Repository{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Repository{}, fmt.Errorf("postgres: commit add repository: %w", err)
	}
	return repo, nil
}

// ListMembers reads a project's memberships ordered by display name.
func (s *ProjectStore) ListMembers(ctx context.Context, c Caller, projectID string) ([]Member, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if _, err := s.GetProject(ctx, c, projectID); err != nil {
		return nil, err
	}
	return prjListMembers(ctx, s.Pool, projectID)
}

func prjListMembers(ctx context.Context, q prjQuerier, projectID string) ([]Member, error) {
	rows, err := q.Query(ctx, prjMemberSelect, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list members: %w", err)
	}
	defer rows.Close()

	out := make([]Member, 0, 4)
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.DisplayName, &m.Role); err != nil {
			return nil, fmt.Errorf("postgres: scan member: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read members: %w", err)
	}
	return out, nil
}

// PutMember upserts (projectID, userID) with role and appends the
// project.member.updated journal row in one transaction. The target must be a
// user in the caller's organization: an unknown user, a user from another
// organization and an unknown project are all ErrProjectNotFound, so the
// endpoint cannot be used to probe the directory. M1 never removes a
// membership.
func (s *ProjectStore) PutMember(ctx context.Context, c Caller, projectID, userID, role string) (Member, error) {
	if err := prjRequireCaller(c); err != nil {
		return Member{}, err
	}
	if !authz.ValidRole(role) {
		return Member{}, fmt.Errorf("postgres: PutMember role %q is not assignable", role)
	}
	if !prjValidUUID(userID) {
		return Member{}, ErrProjectNotFound
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Member{}, fmt.Errorf("postgres: begin put member: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	project, err := prjGetProject(ctx, tx, c, projectID)
	if err != nil {
		return Member{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(project.MyRole)) {
		return Member{}, ErrProjectNotFound
	}

	var member Member
	member.UserID = userID
	member.Role = role
	err = tx.QueryRow(ctx, `
		SELECT display_name FROM users WHERE id = $1::uuid AND organization_id = $2::uuid`,
		userID, c.OrganizationID).Scan(&member.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return Member{}, ErrProjectNotFound
	}
	if err != nil {
		return Member{}, fmt.Errorf("postgres: look up target user: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		projectID, userID, role); err != nil {
		return Member{}, fmt.Errorf("postgres: upsert membership: %w", err)
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeProjectMemberUpdated,
		OrganizationID: project.OrganizationID,
		ProjectID:      projectID,
		Actor:          events.Human(c.UserID),
		Payload:        map[string]any{"project_id": projectID, "user_id": userID, "role": role},
	}); err != nil {
		return Member{}, err
	}

	if err := prjBumpProject(ctx, tx, projectID); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, fmt.Errorf("postgres: commit put member: %w", err)
	}
	return member, nil
}

// RecordDenied writes an audit_events row with outcome 'denied' for an
// attempt the handler refused. It is deliberately independent of the refused
// transaction — a denial that was rolled back with its request still happened
// — and it never references a project id it cannot parse, so probing with
// garbage still lands as a readable audit row rather than a driver error.
func (s *ProjectStore) RecordDenied(ctx context.Context, c Caller, projectID, action string) error {
	if action == "" {
		action = "access denied"
	}
	detail := fmt.Sprintf(`{"action":%q,"project_id":%q}`, action, projectID)
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, 'human', $3, $4, 'denied', $5::jsonb)`,
		c.OrganizationID, prjCleanUUID(projectID), c.UserID, action, detail)
	if err != nil {
		return fmt.Errorf("postgres: record denial: %w", err)
	}
	return nil
}

// prjBumpProject advances the project's optimistic-concurrency token.
// api/openapi.yaml: "version increments on every project mutation".
func prjBumpProject(ctx context.Context, tx pgx.Tx, projectID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE projects SET version = version + 1, updated_at = now() WHERE id = $1::uuid`,
		projectID); err != nil {
		return fmt.Errorf("postgres: bump project version: %w", err)
	}
	return nil
}

func prjScanProject(rows interface{ Scan(dest ...any) error }) (Project, error) {
	var p Project
	if err := rows.Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.Name, &p.Description,
		&p.CreatedAt, &p.Version, &p.MyRole); err != nil {
		return Project{}, fmt.Errorf("postgres: scan project: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()
	return p, nil
}

func prjRequireCaller(c Caller) error {
	if c.UserID == "" || c.OrganizationID == "" {
		return errors.New("postgres: caller must be identified")
	}
	return nil
}

// prjIsConflict reports whether err is a unique (or exclusion) constraint
// violation, the only database error this package translates into a 4xx.
func prjIsConflict(err error) bool {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code == "23505" || pg.Code == "23P01"
	}
	return false
}

// prjValidUUID reports whether s is a canonical 8-4-4-4-12 hex uuid. Invalid
// ids are answered like unknown ones (not found) instead of being sent to the
// driver, which would fail with a syntax error and read as a server bug.
func prjValidUUID(s string) bool {
	const hexDigits = "0123456789abcdefABCDEF"
	want := []int{8, 4, 4, 4, 12}
	if len(s) != 36 {
		return false
	}
	i := 0
	for part, n := range want {
		if part > 0 {
			if s[i] != '-' {
				return false
			}
			i++
		}
		if i+n > len(s) {
			return false
		}
		for j := i; j < i+n; j++ {
			if !strings.ContainsRune(hexDigits, rune(s[j])) {
				return false
			}
		}
		i += n
	}
	return i == len(s)
}

// prjCleanUUID returns s lowercased when it is a uuid and "" otherwise, so a
// caller-supplied id can be handed to a ::uuid cast without risking a
// syntax-error failure in the middle of an insert.
func prjCleanUUID(s string) string {
	if !prjValidUUID(s) {
		return ""
	}
	return strings.ToLower(s)
}

// APIProjectStore exposes a *ProjectStore as internal/api's ProjectStore
// interface. The dependency rule (adapters depend on interfaces, never the
// reverse) means package api must not import this package, so the conversion
// lives here: api owns the view types and sentinel errors, this adapter turns
// them into and out of the store's own types. Wiring it into a Server happens
// in cmd/communication.
type APIProjectStore struct {
	S *ProjectStore
}

// The compile-time checks that the adapter really satisfies the interface the
// handlers depend on.
var (
	_ api.ProjectStore = APIProjectStore{}
	_ api.ProjectStore = (*APIProjectStore)(nil)
)

func (a APIProjectStore) pool() (*ProjectStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APIProjectStore has no pool")
	}
	return a.S, nil
}

// prjAPICaller translates the API caller into the store caller.
func prjAPICaller(c api.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// prjAPIErr maps a store error onto the sentinel errors the HTTP layer
// switches on. Unmapped errors pass through and become 500s.
func prjAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrProjectNotFound):
		return fmt.Errorf("%w: %w", api.ErrProjectNotFound, err)
	case errors.Is(err, ErrConflict):
		return fmt.Errorf("%w: %w", api.ErrProjectConflict, err)
	case errors.Is(err, ErrRepositoryCredentialInvalid):
		return fmt.Errorf("%w: %w", api.ErrRepositoryCredentialInvalid, err)
	default:
		return err
	}
}

// ListProjects implements api.ProjectStore.
func (a APIProjectStore) ListProjects(ctx context.Context, c api.Caller) ([]api.ProjectView, error) {
	s, err := a.pool()
	if err != nil {
		return nil, err
	}
	projects, err := s.ListProjects(ctx, prjAPICaller(c))
	if err != nil {
		return nil, prjAPIErr(err)
	}
	out := make([]api.ProjectView, 0, len(projects))
	for _, p := range projects {
		out = append(out, prjAPIProject(p))
	}
	return out, nil
}

// CreateProject implements api.ProjectStore.
func (a APIProjectStore) CreateProject(ctx context.Context, c api.Caller, name, slug, description string) (api.ProjectView, error) {
	s, err := a.pool()
	if err != nil {
		return api.ProjectView{}, err
	}
	p, err := s.CreateProject(ctx, prjAPICaller(c), name, slug, description)
	if err != nil {
		return api.ProjectView{}, prjAPIErr(err)
	}
	return prjAPIProject(p), nil
}

// GetProject implements api.ProjectStore.
func (a APIProjectStore) GetProject(ctx context.Context, c api.Caller, projectID string) (api.ProjectView, error) {
	s, err := a.pool()
	if err != nil {
		return api.ProjectView{}, err
	}
	p, err := s.GetProject(ctx, prjAPICaller(c), projectID)
	if err != nil {
		return api.ProjectView{}, prjAPIErr(err)
	}
	return prjAPIProject(p), nil
}

// ListRepositories implements api.ProjectStore.
func (a APIProjectStore) ListRepositories(ctx context.Context, c api.Caller, projectID string) ([]api.RepositoryView, error) {
	s, err := a.pool()
	if err != nil {
		return nil, err
	}
	repos, err := s.ListRepositories(ctx, prjAPICaller(c), projectID)
	if err != nil {
		return nil, prjAPIErr(err)
	}
	out := make([]api.RepositoryView, 0, len(repos))
	for _, r := range repos {
		out = append(out, prjAPIRepository(r))
	}
	return out, nil
}

// AddRepository implements api.ProjectStore. credentialSecretID "" means no
// ADR-0061 credential.
func (a APIProjectStore) AddRepository(ctx context.Context, c api.Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (api.RepositoryView, error) {
	s, err := a.pool()
	if err != nil {
		return api.RepositoryView{}, err
	}
	r, err := s.AddRepository(ctx, prjAPICaller(c), projectID, name, gitURL, defaultBranch, credentialSecretID)
	if err != nil {
		return api.RepositoryView{}, prjAPIErr(err)
	}
	return prjAPIRepository(r), nil
}

// PatchRepositoryCredential implements api.ProjectStore: set (uuid text) or
// clear ("") a repository's GitHub credential.
func (a APIProjectStore) PatchRepositoryCredential(ctx context.Context, c api.Caller, projectID, repositoryID, credentialSecretID string) (api.RepositoryView, error) {
	s, err := a.pool()
	if err != nil {
		return api.RepositoryView{}, err
	}
	r, err := s.PatchRepositoryCredential(ctx, prjAPICaller(c), projectID, repositoryID, credentialSecretID)
	if err != nil {
		return api.RepositoryView{}, prjAPIErr(err)
	}
	return prjAPIRepository(r), nil
}

// ListMembers implements api.ProjectStore.
func (a APIProjectStore) ListMembers(ctx context.Context, c api.Caller, projectID string) ([]api.MemberView, error) {
	s, err := a.pool()
	if err != nil {
		return nil, err
	}
	members, err := s.ListMembers(ctx, prjAPICaller(c), projectID)
	if err != nil {
		return nil, prjAPIErr(err)
	}
	out := make([]api.MemberView, 0, len(members))
	for _, m := range members {
		out = append(out, prjAPIMember(m))
	}
	return out, nil
}

// PutMember implements api.ProjectStore.
func (a APIProjectStore) PutMember(ctx context.Context, c api.Caller, projectID, userID, role string) (api.MemberView, error) {
	s, err := a.pool()
	if err != nil {
		return api.MemberView{}, err
	}
	m, err := s.PutMember(ctx, prjAPICaller(c), projectID, userID, role)
	if err != nil {
		return api.MemberView{}, prjAPIErr(err)
	}
	return prjAPIMember(m), nil
}

// RecordDenied implements api.ProjectStore.
func (a APIProjectStore) RecordDenied(ctx context.Context, c api.Caller, projectID, action string) error {
	s, err := a.pool()
	if err != nil {
		return err
	}
	return s.RecordDenied(ctx, prjAPICaller(c), projectID, action)
}

func prjAPIProject(p Project) api.ProjectView {
	return api.ProjectView{
		ID:          p.ID,
		Slug:        p.Slug,
		Name:        p.Name,
		Description: p.Description,
		CreatedAt:   p.CreatedAt,
		Version:     p.Version,
		MyRole:      p.MyRole,
	}
}

func prjAPIRepository(r Repository) api.RepositoryView {
	view := api.RepositoryView{
		ID:            r.ID,
		ProjectID:     r.ProjectID,
		Name:          r.Name,
		GitURL:        r.GitURL,
		DefaultBranch: r.DefaultBranch,
		CreatedAt:     r.CreatedAt,
		Credential:    "none",
	}
	if r.CredentialSecretID != "" {
		cred := r.CredentialSecretID
		view.CredentialSecretID = &cred
		view.Credential = "configured"
	}
	return view
}

func prjAPIMember(m Member) api.MemberView {
	return api.MemberView{UserID: m.UserID, DisplayName: m.DisplayName, Role: m.Role}
}
