package postgres

// ADR-0061 (docs/adr/ADR-0061-repository-github-credential.md): a
// repository's GitHub credential. This file owns everything the database
// cannot express as a CHECK: that a `credential_secret_id` names an
// integration_broker secret of the repository's own project (or of the
// project's organization), and that resolving it for an integration consumer
// is audited exactly like a mount delivery is.
//
// The two authorization axes split here the way ADR-0061 draws them:
//
//   - the *reference* rule ("this repository may name this secret") is a
//     store-write rule, checked in prjValidateCredential below and backed by
//     the migration-00016 trigger, so a store bug or a hand-written psql
//     statement cannot plant a cross-tenant reference;
//   - the *delivery* rule is the resolver's: ResolveForIntegration (in
//     internal/secrets) refuses anything that is not an integration_broker
//     secret, refuses revoked rows, and checks the scope axis against the
//     repository row's own project/organization — never against an agent
//     profile, because a broker secret is granted to no profile by design.
//
// The plaintext's itinerary is one function long: secret_versions.ciphertext
// → Resolver → Resolution.Value → the returned string, which the caller (the
// worker's mirror git, or the serve-side issue read) consumes for one call.
// It is never a field of a view, never part of an event or audit detail, and
// — per the ADR's fail-closed rule — a credential that cannot be resolved is
// an error naming the repository, never a silent fall back to anonymous.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/secrets"
)

// Credential errors. ErrRepositoryCredentialInvalid is the reference-rule
// refusal (a create/patch naming a secret it may not name); the HTTP layer
// maps it to 422 `invalid_credential_secret`. ErrRepositoryCredential is the
// resolve-path failure: it names the repository (never the value), and both
// the poller's last_error and the worker's prepare refusal read it as "this
// repository's credential could not be used".
var (
	ErrRepositoryCredentialInvalid = errors.New("postgres: repository credential secret is not valid for this project")
	ErrRepositoryCredential        = errors.New("postgres: repository GitHub credential could not be resolved")
)

// prjValidateCredential checks what migration 00016's trigger enforces, in Go
// and before the write, so the API caller learns *which* rule refused instead
// of which constraint fired. It runs inside the caller's transaction: the
// same read-then-write window the mount declaration closes with
// visibleSecretInTx is closed here the same way.
func prjValidateCredential(ctx context.Context, q prjQuerier, projectID, secretID string) error {
	if !prjValidUUID(secretID) {
		return fmt.Errorf("%w: %s is not a uuid", ErrRepositoryCredentialInvalid, secretID)
	}
	var (
		scope, mode   string
		secretProject *string
		secretOrg     string
		orgID         string
	)
	err := q.QueryRow(ctx, `
		SELECT sm.scope, sm.delivery_mode, sm.project_id::text, sm.organization_id::text,
		       p.organization_id::text
		FROM secret_metadata sm
		JOIN projects p ON p.id = $1::uuid
		WHERE sm.id = $2::uuid`, projectID, secretID).
		Scan(&scope, &mode, &secretProject, &secretOrg, &orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: no such secret", ErrRepositoryCredentialInvalid)
	}
	if err != nil {
		return fmt.Errorf("postgres: check repository credential: %w", err)
	}
	if mode != secrets.DeliveryBrokerLiteral {
		return fmt.Errorf("%w: secret is %s, not integration_broker", ErrRepositoryCredentialInvalid, mode)
	}
	if secretProject != nil {
		if scope != secrets.ScopeProject || *secretProject != projectID {
			return fmt.Errorf("%w: secret belongs to another project", ErrRepositoryCredentialInvalid)
		}
		return nil
	}
	// An org-scope secret (secrets_scope_pointer: no project_id) may only be
	// referenced by a repository whose project lives in the secret's org.
	if scope != secrets.ScopeOrg || secretOrg != orgID {
		return fmt.Errorf("%w: secret does not belong to this project or its organization",
			ErrRepositoryCredentialInvalid)
	}
	return nil
}

// credentialAudit is everything the secret.resolved row may name — metadata
// only, never the value.
type credentialAudit struct {
	organizationID string
	projectID      string
	secretID       string
	repositoryID   string
	repositoryName string
	consumer       string
	version        int
	failure        string // the refusal's sentinel class, never its text
}

// ResolveRepositoryCredential returns the current plaintext of the repository's
// GitHub credential to an in-process integration consumer
// (secrets.ConsumerRepoMirror or secrets.ConsumerIssueRead).
//
// Authorization is the repository row: the caller names a repository, this
// read names the secret THAT row references, and nothing here accepts a
// caller-supplied secret id. actorID is who the audit row names (the worker
// id for a mirror prepare, "system" for the serve-side issue reads); it is
// audit text, not an authorization input.
//
// Every outcome reaches audit_events with action 'secret.resolved' and the
// consumer in the detail — allowed on success, denied with the refusal's
// sentinel class on failure. The returned error is ErrRepositoryCredential
// naming the repository; a value only ever comes back from a resolve that was
// successfully audited, which is what "fail closed" has to mean here.
func (s *SecretStore) ResolveRepositoryCredential(ctx context.Context, repositoryID, consumer, actorID string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", errors.New("postgres: secret store has no pool")
	}
	if !prjValidUUID(repositoryID) {
		return "", fmt.Errorf("%w: repository id is not a uuid", ErrRepositoryCredential)
	}
	var (
		repoID, name, projectID, orgID string
		credID                         *string
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT r.id::text, r.name, r.project_id::text, p.organization_id::text, r.credential_secret_id
		FROM repositories r
		JOIN projects p ON p.id = r.project_id
		WHERE r.id = $1::uuid`, repositoryID).
		Scan(&repoID, &name, &projectID, &orgID, &credID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("%w: repository %s is gone", ErrRepositoryCredential, repositoryID)
	}
	if err != nil {
		return "", fmt.Errorf("postgres: read repository credential row: %w", err)
	}
	audit := credentialAudit{
		organizationID: orgID, projectID: projectID,
		repositoryID: repoID, repositoryName: name, consumer: consumer,
	}
	if credID == nil || *credID == "" {
		// The caller asked to resolve a credential the row does not have.
		// This is a wiring bug, not an anonymous fallback: naming it loudly
		// is what keeps "never silently anonymous" a fact rather than a hope.
		return "", fmt.Errorf("%w: repository %q has no GitHub credential configured",
			ErrRepositoryCredential, name)
	}
	audit.secretID = *credID

	token, resolveErr := s.openRepositoryCredential(ctx, *credID, audit)
	if resolveErr == nil {
		audit.version = token.version
	} else {
		audit.failure = credentialFailureClass(resolveErr)
	}
	if aerr := s.recordCredentialAudit(ctx, audit, actorID, resolveErr == nil); aerr != nil {
		if resolveErr == nil {
			// A use that cannot be audited did not happen: hand back nothing.
			return "", aerr
		}
	}
	if resolveErr != nil {
		return "", resolveErr
	}
	return token.token, nil
}

// credentialResult carries the plaintext plus the version the resolver opened
// (the audit row names the version, never the value).
type credentialResult struct {
	token   string
	version int
}

// openRepositoryCredential is the one decrypt: resolver built from this
// store's own VersionSource half and keyring, authorization asserted exactly
// the way UnitSecrets asserts it (the role question was answered by the row
// this was reached through, not by an agent profile).
func (s *SecretStore) openRepositoryCredential(ctx context.Context, secretID string, audit credentialAudit) (credentialResult, error) {
	if s.Keys == nil {
		return credentialResult{}, fmt.Errorf("%w: repository %q: the keyring is not configured here",
			ErrRepositoryCredential, audit.repositoryName)
	}
	resolver, err := secrets.NewResolver(s, s.Keys)
	if err != nil {
		return credentialResult{}, fmt.Errorf("%w: repository %q: %v",
			ErrRepositoryCredential, audit.repositoryName, err)
	}
	res, err := resolver.ResolveForIntegration(ctx, secrets.IntegrationRequest{
		RepositoryID: audit.repositoryID, RepositoryName: audit.repositoryName,
		ProjectID: audit.projectID, OrganizationID: audit.organizationID,
		Consumer: audit.consumer,
	}, secretID)
	if err != nil {
		// Name the repository and keep the resolver's sentinel in the chain
		// (the audit class below and every errors.Is caller read it) — while
		// the *text* stays this side of the value: %v of the wrapped error
		// carries the secret id and refusal class, never a plaintext.
		return credentialResult{}, fmt.Errorf("%w: repository %q: %w",
			ErrRepositoryCredential, audit.repositoryName, err)
	}
	defer res.Value.Zero()
	return credentialResult{token: string(res.Value.Bytes()), version: res.Version}, nil
}

// credentialFailureClass is the audit detail's honest one-word answer: which
// sentinel refused, never the refusal's text (the same rule
// resolveFailureReason follows for materialization events).
func credentialFailureClass(err error) string {
	switch {
	case errors.Is(err, secrets.ErrRevoked):
		return "revoked"
	case errors.Is(err, secrets.ErrDeliveryUnsupported):
		return "not_a_broker_secret"
	case errors.Is(err, secrets.ErrNotAuthorized):
		return "not_authorized"
	case errors.Is(err, secrets.ErrUnknownKeyID), errors.Is(err, secrets.ErrKeyringUnreadable),
		errors.Is(err, secrets.ErrDecrypt):
		return "keyring"
	case errors.Is(err, ErrSecretNotFound):
		return "secret_gone"
	default:
		return "unresolvable"
	}
}

// recordCredentialAudit writes the secret.resolved row ADR-0061's Security
// section promises. actor_kind is 'system' with the calling actor id: this is
// the platform using a credential on the team's behalf, not a human's action
// and not an agent's (a broker secret never reaches an agent).
func (s *SecretStore) recordCredentialAudit(ctx context.Context, a credentialAudit, actorID string, allowed bool) error {
	outcome := "denied"
	if allowed {
		outcome = "allowed"
	}
	detailMap := map[string]any{
		"secret_id":       a.secretID,
		"repository_id":   a.repositoryID,
		"repository_name": a.repositoryName,
		"consumer":        a.consumer,
	}
	if allowed {
		detailMap["version"] = a.version
	} else {
		detailMap["failure"] = a.failure
	}
	detail, err := prjPayloadJSON(detailMap)
	if err != nil {
		return err
	}
	if actorID == "" {
		actorID = "system"
	}
	_, err = s.Pool.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, $2::uuid, 'system', $3, 'secret.resolved', $4, $5::jsonb)`,
		a.organizationID, prjCleanUUID(a.projectID), actorID, outcome, detail)
	if err != nil {
		return fmt.Errorf("postgres: record secret.resolved audit: %w", err)
	}
	return nil
}

// ResolveMirrorCredential implements the worker's mirror-credential seam
// (internal/worker.MirrorCredentialSource): the same store resolve with the
// consumer fixed to repo_mirror by this side of the boundary, so a worker
// cannot ask to be somebody else's integration.
func (u *UnitSecrets) ResolveMirrorCredential(ctx context.Context, repositoryID, workerID string) (string, error) {
	if u == nil || u.Secrets == nil {
		return "", errors.New("postgres: unit secrets materializer is not wired")
	}
	return u.Secrets.ResolveRepositoryCredential(ctx, repositoryID, secrets.ConsumerRepoMirror, workerID)
}

// PatchRepositoryCredential sets or clears a repository's GitHub credential
// (ADR-0061 Decision 3: "create/patch accept credential_secret_id; null
// clears"). credentialSecretID is the post-validation value: "" clears the
// column. A repository of another project is indistinguishable from one that
// never existed (ErrProjectNotFound), and a caller who cannot manage the
// project gets the same answer AddRepository gives.
func (s *ProjectStore) PatchRepositoryCredential(ctx context.Context, c Caller, projectID, repositoryID, credentialSecretID string) (Repository, error) {
	if err := prjRequireCaller(c); err != nil {
		return Repository{}, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Repository{}, fmt.Errorf("postgres: begin patch repository credential: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	project, err := prjGetProject(ctx, tx, c, projectID)
	if err != nil {
		return Repository{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(project.MyRole)) {
		return Repository{}, ErrProjectNotFound
	}
	if credentialSecretID != "" {
		if err := prjValidateCredential(ctx, tx, projectID, credentialSecretID); err != nil {
			return Repository{}, err
		}
	}
	var repo Repository
	err = tx.QueryRow(ctx, `
		UPDATE repositories
		   SET credential_secret_id = NULLIF($3, '')::uuid
		 WHERE id = $1::uuid AND project_id = $2::uuid
		RETURNING id, project_id::text, name, git_url, default_branch, created_at,
		          COALESCE(credential_secret_id::text, '')`,
		prjCleanUUID(repositoryID), projectID, credentialSecretID).
		Scan(&repo.ID, &repo.ProjectID, &repo.Name, &repo.GitURL, &repo.DefaultBranch, &repo.CreatedAt,
			&repo.CredentialSecretID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Repository{}, ErrProjectNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23514" &&
			strings.Contains(pgErr.Message, "credential") {
			return Repository{}, fmt.Errorf("%w: %s", ErrRepositoryCredentialInvalid, pgErr.Message)
		}
		return Repository{}, fmt.Errorf("postgres: patch repository credential: %w", err)
	}
	repo.CreatedAt = repo.CreatedAt.UTC()
	if err := prjBumpProject(ctx, tx, projectID); err != nil {
		return Repository{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Repository{}, fmt.Errorf("postgres: commit patch repository credential: %w", err)
	}
	return repo, nil
}
