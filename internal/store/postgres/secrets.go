package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/secrets"
)

// SecretStore is the control-plane and worker-side adapter over the migration
// 00004 secret tables (secret_metadata, secret_versions, secret_mounts,
// secret_materializations), and it is where ADR-0018's envelope lives: a value
// crosses into Seal inside the write transaction and never appears in a Go
// value that outlives it.
//
// What this package guarantees, and what secrets.go guarantees, split here:
//
//   - internal/secrets owns *key material* and the refusal to decrypt for a
//     caller the allowlists do not name;
//   - this package owns *rows*: that a metadata row and its first version commit
//     together, that a version is never rewritten, that every mutation and every
//     denial leaves an audit_events row, that the journal append is in the same
//     transaction as the change (ADR-0014 § 9), and that no column this code
//     writes could hold a plaintext.
//
// It implements secrets.VersionSource, which is the whole reason the resolver can
// live in the same process as the database connection pool and nowhere else.
type SecretStore struct {
	Pool *pgxpool.Pool
	// Keys is required. A SecretStore without a keyring can read metadata but can
	// write no version, and pretending otherwise would let a misconfigured
	// process accept a rotation it can never decrypt (ADR-0018 D2.3).
	Keys secrets.KeyProvider
}

// Compile-time proof that the store is a legitimate resolver input: the
// VersionSource half is what internal/secrets needs, and the fact that
// *SecretStore satisfies it *without* any method returning plaintext is what
// keeps the boundary honest.
var _ secrets.VersionSource = (*SecretStore)(nil)

// Secret errors. The HTTP layer maps ErrSecretNotFound to the same 404 body a
// missing project produces, because "you may not know this exists" and "it is not
// there" must be indistinguishable (m3-contract C15b).
var (
	ErrSecretNotFound  = errors.New("postgres: secret not found")
	ErrMountNotFound   = errors.New("postgres: secret mount not found")
	ErrSecretForbidden = errors.New("postgres: secret write not allowed")

	// ErrSecretRevoked is a *write* refusal: appending a version to, or revoking,
	// a secret that is already revoked is a conflict, not a no-op. Materializing a
	// revoked version is refused elsewhere, by secrets.Resolver with
	// secrets.ErrRevoked.
	ErrSecretRevoked = errors.New("postgres: secret is revoked")

	// ErrRepositoryNotInProject is a mount naming another project's repository:
	// the declaration would place a value in a checkout this project has no claim
	// on, so it is refused before a row exists (openapi: "a repository of another
	// project is 422").
	ErrRepositoryNotInProject = errors.New("postgres: repository is not in this project")

	// ErrDeliveryUnsupported is ADR-0018 clause 8 at the row boundary:
	// integration_broker is storable as a secret's declared policy and unmountable,
	// so a mount that asks for it is refused rather than quietly rewritten.
	ErrDeliveryUnsupported = errors.New("postgres: secret delivery mode is not implemented")
)

// Secret is a secret_metadata row. There is no field here that could hold a
// value, and no method of this type returns one to a caller that has not already
// been through secrets.Resolver.
type Secret struct {
	ID             string
	OrganizationID string
	ProjectID      string // empty for scope org
	Scope          string
	Slug           string
	Purpose        string
	DeliveryMode   string
	CurrentVersion int
	// Profiles and Templates are allowlists; empty means denied to all
	// (ADR-0018 D3), which is why they are never defaulted to anything.
	Profiles    []string
	Templates   []string
	AuditPolicy string
	CreatedBy   string
	CreatedAt   time.Time
	RotatedAt   *time.Time
	RevokedAt   *time.Time
}

// SecretVersion is the metadata half of one secret_versions row: what a rotation
// response and the audit trail need. Nonce, ciphertext and aad are deliberately
// absent — this type is returned to the API adapter, and the ciphertext column
// must have no path into it (ADR-0018 D1: no read path from internal/api touches
// secret_versions.ciphertext).
type SecretVersion struct {
	SecretID  string
	Version   int
	KeyID     string
	CreatedAt time.Time
}

// SecretMount is a secret_mounts row: a declared placement.
type SecretMount struct {
	ID           string
	ProjectID    string
	SecretID     string
	SecretSlug   string
	DeliveryMode string
	RepositoryID string // empty for env delivery
	RelativePath string // empty for env delivery
	EnvName      string // empty for env_file delivery
	Key          string
	Lifecycle    string
	AllowTracked bool
	CreatedAt    time.Time
}

// SecretMaterialization is a secret_materializations row: the record that a value
// was present at one target on one worker. CleanedAt nil is the finding state —
// the row the worker's startup sweep exists to close.
type SecretMaterialization struct {
	ID            int64
	SecretID      string
	SecretSlug    string
	SecretVersion int
	ProjectID     string
	WorkspaceID   string
	TurnID        string
	WorkerID      string
	// AttemptID is the node_attempt lifecycle's owner (contract § 4 step 4):
	// set exactly when the mount was delivered for an attempt, empty for the
	// turn/workspace arms M2/M3 materialize.
	AttemptID      string
	DeliveryMode   string
	Target         string
	FileMode       int // 0 means env delivery, which has no file
	MaterializedAt time.Time
	CleanedAt      *time.Time
	CleanedBy      string
}

// NewSecret is the create input. Value is the plaintext, and it is the only
// parameter in this package that is decrypted material — it is sealed inside
// CreateSecret's transaction and dropped.
type NewSecret struct {
	Slug         string
	Purpose      string
	DeliveryMode string
	Scope        string // empty means project
	Profiles     []string
	Value        []byte
}

// NewSecretPolicy is the policy replacement: exactly the three editable fields.
type NewSecretPolicy struct {
	Purpose  string
	Profiles []string
	Audit    string
}

// NewSecretMount is the mount declaration.
type NewSecretMount struct {
	SecretID     string
	DeliveryMode string
	RepositoryID string
	RelativePath string
	EnvName      string
	Key          string
	Lifecycle    string
	AllowTracked bool
}

// NewSecretMaterialization is the worker's record of one delivery.
type NewSecretMaterialization struct {
	SecretID       string
	SecretVersion  int
	OrganizationID string
	ProjectID      string
	WorkspaceID    string
	TurnID         string
	WorkerID       string
	// AttemptID stamps the node_attempt arm's owner: the attempt whose process
	// environment or checkout received the value. Empty for a turn-scope
	// delivery, which must not name one (ADR-0018 D1's ownership rule).
	AttemptID    string
	DeliveryMode string
	Target       string
	FileMode     int
}

// --- read paths ----------------------------------------------------------

// ListSecrets returns the metadata rows a project can see: its own project-scope
// secrets plus its organization's org-scope secrets, ordered by slug. Both halves
// are needed — an org-scope secret carries no project_id (secrets_scope_pointer),
// so "what this project may mount" is a two-branch predicate and not a WHERE on
// project_id.
func (s *SecretStore) ListSecrets(ctx context.Context, c Caller, projectID string) ([]Secret, error) {
	project, err := s.visibleProject(ctx, c, projectID, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, secSecretSelect+`
		WHERE (sm.scope = 'project' AND sm.project_id = $1)
		   OR (sm.scope = 'org' AND sm.organization_id = $2 AND sm.project_id IS NULL)
		ORDER BY sm.slug`, projectID, project.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list secrets: %w", err)
	}
	defer rows.Close()
	var out []Secret
	for rows.Next() {
		secret, err := secScanSecret(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, secret)
	}
	return out, rows.Err()
}

// LoadVersion implements secrets.VersionSource: one pinned version, with its
// ciphertext and the policy facts the resolver needs to decide whether to open it.
//
// version 0 means "the current version" — the resolver's pin rule. This is the
// only method in the package that returns ciphertext, and the only way to reach a
// plaintext is to hand the result to secrets.Open with a keyring.
func (s *SecretStore) LoadVersion(ctx context.Context, secretID string, version int) (secrets.StoredVersion, error) {
	if !prjValidUUID(secretID) {
		return secrets.StoredVersion{}, ErrSecretNotFound
	}
	row := s.Pool.QueryRow(ctx, `
		SELECT sm.organization_id::text, COALESCE(sm.project_id::text, ''), sm.scope, sm.slug,
		       sm.delivery_mode, sm.current_version, sm.revoked_at IS NOT NULL,
		       sm.allowed_agent_profile_ids, sm.allowed_node_template_ids,
		       sv.version, sv.key_id, sv.nonce, sv.ciphertext, sv.aad, sv.content_sha256,
		       sv.revoked_at IS NOT NULL
		FROM secret_metadata sm
		JOIN secret_versions sv ON sv.secret_id = sm.id
		WHERE sm.id = $1::uuid AND sv.version = COALESCE(NULLIF($2, 0), sm.current_version)`,
		secretID, version)
	var (
		stored                        secrets.StoredVersion
		nonce, ciphertext             []byte
		versionRevoked, secretRevoked bool
	)
	err := row.Scan(
		&stored.OrganizationID, &stored.ProjectID, &stored.Scope, &stored.Slug,
		&stored.DeliveryMode, &stored.CurrentVersion, &secretRevoked,
		&stored.AllowedAgentProfileIDs, &stored.AllowedNodeTemplateIDs,
		&stored.Version, &stored.Sealed.KeyID, &nonce, &ciphertext,
		&stored.Sealed.AAD, &stored.Sealed.ContentSHA256, &versionRevoked,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return secrets.StoredVersion{}, ErrSecretNotFound
	}
	if err != nil {
		return secrets.StoredVersion{}, fmt.Errorf("postgres: load secret version: %w", err)
	}
	stored.Ref = secrets.VersionRef{SecretID: secretID, Version: stored.Version, Slug: stored.Slug}
	stored.SecretRevoked = secretRevoked
	stored.VersionRevoked = versionRevoked
	stored.Sealed.Nonce = nonce
	stored.Sealed.Ciphertext = ciphertext
	return stored, nil
}

// ListMounts returns a project's declared placements, with the referenced
// secret's slug (a mount names a secret by slug in the YAML surface, and the UI
// has to show which one this is).
func (s *SecretStore) ListMounts(ctx context.Context, c Caller, projectID string) ([]SecretMount, error) {
	if _, err := s.visibleProject(ctx, c, projectID, false); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, secMountSelect+`
		WHERE m.project_id = $1 ORDER BY m.created_at, m.id`, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list secret mounts: %w", err)
	}
	defer rows.Close()
	var out []SecretMount
	for rows.Next() {
		mount, err := secScanMount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, mount)
	}
	return out, rows.Err()
}

// ListMaterializations is the audit view for one secret, newest first. It is
// maintainer-only at the HTTP layer: the map of which unit held which secret is
// itself a disclosure surface even with no value in it.
func (s *SecretStore) ListMaterializations(ctx context.Context, c Caller, projectID, secretID string) ([]SecretMaterialization, error) {
	var out []SecretMaterialization
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, _, err := s.visibleSecretInTx(ctx, tx, c, projectID, secretID, false); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
		SELECT mat.id, mat.secret_id::text, sm.slug, mat.secret_version, mat.project_id::text,
		       COALESCE(mat.workspace_id::text, ''), COALESCE(mat.turn_id::text, ''),
		       COALESCE(mat.attempt_id::text, ''), mat.worker_id::text, mat.delivery_mode, mat.target, mat.file_mode,
		       mat.materialized_at, mat.cleaned_at, COALESCE(mat.cleaned_by, '')
		FROM secret_materializations mat
		JOIN secret_metadata sm ON sm.id = mat.secret_id
		WHERE mat.project_id = $1::uuid AND mat.secret_id = $2::uuid
			ORDER BY mat.materialized_at DESC, mat.id DESC`, projectID, secretID)
		if err != nil {
			return fmt.Errorf("postgres: list secret materializations: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var (
				mat   SecretMaterialization
				mode  *int
				clean *time.Time
			)
			if err := rows.Scan(&mat.ID, &mat.SecretID, &mat.SecretSlug, &mat.SecretVersion,
				&mat.ProjectID, &mat.WorkspaceID, &mat.TurnID, &mat.AttemptID, &mat.WorkerID,
				&mat.DeliveryMode, &mat.Target, &mode, &mat.MaterializedAt, &clean, &mat.CleanedBy); err != nil {
				return fmt.Errorf("postgres: scan secret materialization: %w", err)
			}
			if mode != nil {
				mat.FileMode = *mode
			}
			mat.CleanedAt = clean
			out = append(out, mat)
		}
		return rows.Err()
	})
	return out, err
}

// --- the envelope, on the write side -------------------------------------

// CreateSecret writes secret_metadata plus secret_versions v1 in one transaction,
// sealing the value with the keyring between the two statements.
//
// The ordering is the safety property: the row's id and slug have to exist before
// the AAD can be built (they *are* the AAD), so the INSERT and the seal cannot be
// reordered, and a failure after the seal rolls both back. A metadata row with no
// version would be a secret that answers a list and materializes nothing.
//
// A retried create — same slug, byte-identical value — is recognised by
// content_sha256 and reports the row that already exists instead of writing a
// second version (openapi SecretCreate.value). A *different* value under an
// existing slug is a 409: rotation is a different verb.
func (s *SecretStore) CreateSecret(ctx context.Context, c Caller, projectID string, in NewSecret) (Secret, error) {
	if s.Keys == nil {
		return Secret{}, ErrKeyringUnavailable
	}
	scope := in.Scope
	if scope == "" {
		scope = secrets.ScopeProject
	}
	if scope == secrets.ScopeOrg && !c.IsOrgAdmin {
		return Secret{}, fmt.Errorf("%w: an org-scope secret needs organization admin", ErrSecretForbidden)
	}
	// An omitted allowlist means the empty list — denied to every profile
	// (ADR-0018 D3) — never a NULL. The column is NOT NULL and pgx encodes a
	// nil []string as NULL, so normalising here (the store boundary) is what
	// makes every caller safe, including the integration_broker create of
	// ADR-0061, which legitimately names no agent profile at all.
	in.Profiles = secNonNil(in.Profiles)
	digest := hex.EncodeToString(sha256Sum(in.Value))
	var out Secret
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		project, err := secProject(ctx, tx, c, projectID, true)
		if err != nil {
			return err
		}
		if existing, err := secSecretBySlug(ctx, tx, project, scope, in.Slug); err == nil {
			same, err := secVersionMatchesDigest(ctx, tx, existing.ID, existing.CurrentVersion, digest)
			if err != nil {
				return err
			}
			if same {
				// The same write, retried: report the row instead of rotating a
				// secret nobody meant to rotate.
				out = existing
				return secAuditAllowed(ctx, tx, c, project, "secret.create", map[string]any{
					"secret_id": existing.ID, "slug": existing.Slug, "version": existing.CurrentVersion,
					"purpose": existing.Purpose, "delivery_mode": existing.DeliveryMode, "replayed": true,
				})
			}
			return ErrConflict
		} else if !errors.Is(err, ErrSecretNotFound) {
			return err
		}

		var id, createdAt string
		row := tx.QueryRow(ctx, `
			INSERT INTO secret_metadata
				(organization_id, project_id, scope, slug, purpose, delivery_mode, current_version,
				 allowed_agent_profile_ids, allowed_node_template_ids, audit_policy, created_by)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1, $7::uuid[], '{}', 'materialization', $8::uuid)
			RETURNING id::text, created_at::text`,
			project.OrganizationID, secScopeProjectID(scope, projectID), scope, in.Slug, in.Purpose,
			in.DeliveryMode, in.Profiles, c.UserID)
		if err := row.Scan(&id, &createdAt); err != nil {
			if idnUniqueViolation(err) {
				return ErrConflict
			}
			return fmt.Errorf("postgres: create secret: %w", err)
		}
		sealed, err := secrets.Seal(ctx, s.Keys,
			secrets.VersionRef{SecretID: id, Version: 1, Slug: in.Slug}, in.Value)
		if err != nil {
			return err
		}
		if err := secInsertVersion(ctx, tx, id, 1, c.UserID, sealed); err != nil {
			return err
		}
		created, err := secFetchSecret(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type: events.TypeSecretCreated, OrganizationID: project.OrganizationID,
			ProjectID: projectID, Actor: events.Human(c.UserID),
			Payload: events.SecretCreatedPayload{
				SecretID: id, ProjectID: projectID, Slug: in.Slug, Scope: scope,
				Purpose: in.Purpose, DeliveryMode: in.DeliveryMode, Version: 1,
				AllowedAgentProfileIDs: in.Profiles,
			},
		}); err != nil {
			return err
		}
		if err := secAuditAllowed(ctx, tx, c, project, "secret.create", map[string]any{
			"secret_id": id, "slug": in.Slug, "version": 1,
			"purpose": in.Purpose, "delivery_mode": in.DeliveryMode,
		}); err != nil {
			return err
		}
		out = created
		return nil
	})
	return out, err
}

// AddSecretVersion appends an immutable version and moves current_version.
//
// Old versions are never touched: an in-flight unit that pinned version 3
// decrypts version 3 for as long as the keyring holds its generation, which is
// what makes rotation mid-turn safe (ADR-0018 D2). The row lock is what makes the
// version number a fact rather than a race.
func (s *SecretStore) AddSecretVersion(ctx context.Context, c Caller, projectID, secretID string, value []byte) (SecretVersion, error) {
	if s.Keys == nil {
		return SecretVersion{}, ErrKeyringUnavailable
	}
	digest := hex.EncodeToString(sha256Sum(value))
	var out SecretVersion
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		project, secret, err := s.visibleSecret(ctx, c, projectID, secretID, true)
		if err != nil {
			return err
		}
		if secret.RevokedAt != nil {
			return ErrSecretRevoked
		}
		if same, err := secVersionMatchesDigest(ctx, tx, secret.ID, secret.CurrentVersion, digest); err != nil {
			return err
		} else if same {
			// The retry case openapi names: the same bytes reported as the same
			// version, rather than a second immutable row that nobody asked for.
			out = SecretVersion{SecretID: secret.ID, Version: secret.CurrentVersion, CreatedAt: secret.CreatedAt}
			if err := tx.QueryRow(ctx, `SELECT key_id FROM secret_versions WHERE secret_id = $1::uuid AND version = $2`,
				secret.ID, secret.CurrentVersion).Scan(&out.KeyID); err != nil {
				return fmt.Errorf("postgres: read replayed secret version: %w", err)
			}
			return secAuditAllowed(ctx, tx, c, project, "secret.version.add", map[string]any{
				"secret_id": secret.ID, "slug": secret.Slug, "version": out.Version,
				"purpose": secret.Purpose, "delivery_mode": secret.DeliveryMode, "replayed": true,
			})
		}
		next := secret.CurrentVersion + 1
		sealed, err := secrets.Seal(ctx, s.Keys,
			secrets.VersionRef{SecretID: secret.ID, Version: next, Slug: secret.Slug}, value)
		if err != nil {
			return err
		}
		if err := secInsertVersion(ctx, tx, secret.ID, next, c.UserID, sealed); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE secret_metadata SET current_version = $2, rotated_at = now() WHERE id = $1::uuid`,
			secret.ID, next); err != nil {
			return fmt.Errorf("postgres: bump secret version: %w", err)
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type: events.TypeSecretVersionAdded, OrganizationID: project.OrganizationID,
			ProjectID: projectID, Actor: events.Human(c.UserID),
			Payload: events.SecretVersionAddedPayload{
				SecretID: secret.ID, ProjectID: projectID, Version: next,
				KeyID: sealed.KeyID, PreviousVersion: secret.CurrentVersion,
			},
		}); err != nil {
			return err
		}
		if err := secAuditAllowed(ctx, tx, c, project, "secret.version.add", map[string]any{
			"secret_id": secret.ID, "slug": secret.Slug, "version": next, "key_id": sealed.KeyID,
			"previous_version": secret.CurrentVersion, "purpose": secret.Purpose,
			"delivery_mode": secret.DeliveryMode,
		}); err != nil {
			return err
		}
		out = SecretVersion{SecretID: secret.ID, Version: next, KeyID: sealed.KeyID, CreatedAt: time.Now().UTC()}
		return nil
	})
	return out, err
}

// UpdateSecretPolicy replaces the editable policy and appends secret.policy.updated
// with the before/after. slug, scope, delivery_mode and current_version are not
// parameters here because they are not editable through this verb: a slug is what
// a mount names, and a version only moves by appending one.
func (s *SecretStore) UpdateSecretPolicy(ctx context.Context, c Caller, projectID, secretID string, in NewSecretPolicy) (Secret, error) {
	var out Secret
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		project, before, err := s.visibleSecret(ctx, c, projectID, secretID, true)
		if err != nil {
			return err
		}
		if before.RevokedAt != nil {
			return ErrSecretRevoked
		}
		// Same rule as CreateSecret: a nil allowlist clears the list, it does not
		// NULL the column.
		in.Profiles = secNonNil(in.Profiles)
		if _, err := tx.Exec(ctx, `
			UPDATE secret_metadata
			   SET purpose = $2, allowed_agent_profile_ids = $3::uuid[], audit_policy = $4
			 WHERE id = $1::uuid`,
			secretID, in.Purpose, in.Profiles, in.Audit); err != nil {
			return fmt.Errorf("postgres: update secret policy: %w", err)
		}
		after, err := secFetchSecret(ctx, tx, secretID)
		if err != nil {
			return err
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type: events.TypeSecretPolicyUpdated, OrganizationID: project.OrganizationID,
			ProjectID: projectID, Actor: events.Human(c.UserID),
			Payload: events.SecretPolicyUpdatedPayload{
				SecretID: secretID, ProjectID: projectID,
				Before: secPolicyState(before), After: secPolicyState(after),
			},
		}); err != nil {
			return err
		}
		if err := secAuditAllowed(ctx, tx, c, project, "secret.update", map[string]any{
			"secret_id": secretID, "slug": after.Slug, "version": after.CurrentVersion,
			"purpose": after.Purpose, "delivery_mode": after.DeliveryMode,
		}); err != nil {
			return err
		}
		out = after
		return nil
	})
	return out, err
}

// RevokeSecret stamps revoked_at on the metadata row and on every version, then
// appends secret.secret.revoked. Revocation is not deletion: 06 asks for an
// auditable history, and a revoked row still shows who could have had it. A unit
// already running keeps whatever it was launched with — nothing here can take a
// file out of a process's memory, which is why D2.4 is written as a refusal to
// materialize rather than as an invalidation.
func (s *SecretStore) RevokeSecret(ctx context.Context, c Caller, projectID, secretID string) (Secret, error) {
	var out Secret
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		project, secret, err := s.visibleSecret(ctx, c, projectID, secretID, true)
		if err != nil {
			return err
		}
		if secret.RevokedAt != nil {
			return ErrSecretRevoked
		}
		if _, err := tx.Exec(ctx, `
			UPDATE secret_metadata SET revoked_at = now() WHERE id = $1::uuid`, secretID); err != nil {
			return fmt.Errorf("postgres: revoke secret: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE secret_versions SET revoked_at = now() WHERE secret_id = $1::uuid AND revoked_at IS NULL`,
			secretID); err != nil {
			return fmt.Errorf("postgres: revoke secret versions: %w", err)
		}
		versions, err := secVersionNumbers(ctx, tx, secretID)
		if err != nil {
			return err
		}
		revoked, err := secFetchSecret(ctx, tx, secretID)
		if err != nil {
			return err
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type: events.TypeSecretRevoked, OrganizationID: project.OrganizationID,
			ProjectID: projectID, Actor: events.Human(c.UserID),
			Payload: events.SecretRevokedPayload{
				SecretID: secretID, ProjectID: projectID, Versions: versions,
				RevokedAt: revoked.RevokedAt.UTC().Format(time.RFC3339), RevokedBy: c.UserID,
			},
		}); err != nil {
			return err
		}
		if err := secAuditAllowed(ctx, tx, c, project, "secret.revoke", map[string]any{
			"secret_id": secretID, "slug": revoked.Slug, "version": revoked.CurrentVersion,
			"purpose": revoked.Purpose, "delivery_mode": revoked.DeliveryMode, "versions": versions,
		}); err != nil {
			return err
		}
		out = revoked
		return nil
	})
	return out, err
}

// --- mounts --------------------------------------------------------------

// CreateMount declares a placement. The shape rules are the ones mounts_shape
// enforces, checked here first so the client hears which field was wrong rather
// than which constraint fired; the filesystem rules are the worker's, because
// "relative to what" has no answer until a workspace exists (ADR-0018 D4).
func (s *SecretStore) CreateMount(ctx context.Context, c Caller, projectID string, in NewSecretMount) (SecretMount, error) {
	var out SecretMount
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		project, err := secProject(ctx, tx, c, projectID, true)
		if err != nil {
			return err
		}
		if in.DeliveryMode == secrets.DeliveryBrokerLiteral {
			return ErrDeliveryUnsupported
		}
		// The secret must be one this project can see — the same predicate the
		// resolver applies at materialization time, applied at declaration so a
		// mount cannot name a secret its project would be refused for.
		if _, _, err := s.visibleSecretInTx(ctx, tx, c, projectID, in.SecretID, false); err != nil {
			return err
		}
		if in.DeliveryMode == secrets.DeliveryEnvFile {
			var one int
			if err := tx.QueryRow(ctx,
				`SELECT 1 FROM repositories WHERE id = $1::uuid AND project_id = $2::uuid`,
				in.RepositoryID, projectID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
				return ErrRepositoryNotInProject
			} else if err != nil {
				return fmt.Errorf("postgres: check mount repository: %w", err)
			}
		}
		lifecycle := in.Lifecycle
		if lifecycle == "" {
			lifecycle = "turn"
		}
		var id string
		err = tx.QueryRow(ctx, `
			INSERT INTO secret_mounts
				(project_id, secret_id, delivery_mode, repository_id, relative_path, env_name,
				 "key", lifecycle, allow_tracked)
			VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9)
			RETURNING id::text`,
			projectID, in.SecretID, in.DeliveryMode, secNullUUID(in.RepositoryID),
			secNullString(in.RelativePath), secNullString(in.EnvName), secNullString(in.Key),
			lifecycle, in.AllowTracked).Scan(&id)
		if err != nil {
			return fmt.Errorf("postgres: create secret mount: %w", err)
		}
		mount, err := secFetchMount(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := secAuditAllowed(ctx, tx, c, project, "secret.mount.create", map[string]any{
			"mount_id": id, "secret_id": in.SecretID, "slug": mount.SecretSlug,
			"delivery_mode": in.DeliveryMode, "target": secMountTarget(mount),
			"lifecycle": lifecycle, "allow_tracked": in.AllowTracked,
		}); err != nil {
			return err
		}
		out = mount
		return nil
	})
	return out, err
}

// DeleteMount removes a declaration and stops it being honoured on the *next*
// launch. It does not revoke the secret: those are different mistakes, and
// conflating them means a typo in a path costs a rotation.
func (s *SecretStore) DeleteMount(ctx context.Context, c Caller, projectID, mountID string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		project, err := secProject(ctx, tx, c, projectID, true)
		if err != nil {
			return err
		}
		if !prjValidUUID(mountID) {
			return ErrMountNotFound
		}
		var secretID, slug, delivery, target string
		err = tx.QueryRow(ctx, `
			DELETE FROM secret_mounts
			 WHERE id = $1::uuid AND project_id = $2::uuid
			   RETURNING secret_id::text,
			             (SELECT slug FROM secret_metadata WHERE id = secret_mounts.secret_id),
			             delivery_mode,
			             COALESCE(relative_path, env_name, '')`,
			mountID, projectID).Scan(&secretID, &slug, &delivery, &target)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMountNotFound
		}
		if err != nil {
			return fmt.Errorf("postgres: delete secret mount: %w", err)
		}
		return secAuditAllowed(ctx, tx, c, project, "secret.mount.delete", map[string]any{
			"mount_id": mountID, "secret_id": secretID, "slug": slug,
			"delivery_mode": delivery, "target": target,
		})
	})
}

// --- materialization records (worker-side) -------------------------------

// RecordMaterialization inserts the row that proves a value was present, and is
// called by the worker *after* the file exists: a record of a write that did not
// happen would be worse than no record. It takes no value and no ciphertext; the
// caller has already written the file and reports only where.
//
// The event is appended in the same transaction, so a crash between the file's
// creation and this insert leaves a live path with no row — which is what the
// reconciler's filesystem sweep is for, and the reason the event exists separately
// from the row at all (ADR-0018 D1).
func (s *SecretStore) RecordMaterialization(ctx context.Context, in NewSecretMaterialization, payload events.SecretMaterializedPayload) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO secret_materializations
				(secret_id, secret_version, project_id, workspace_id, turn_id, worker_id,
				 attempt_id, delivery_mode, target, file_mode)
			VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
			        $7::uuid, $8, $9, $10)
			RETURNING id`,
			in.SecretID, in.SecretVersion, in.ProjectID, secNullUUID(in.WorkspaceID),
			secNullUUID(in.TurnID), in.WorkerID, secNullUUID(in.AttemptID),
			in.DeliveryMode, in.Target,
			secNullFileMode(in.FileMode)).Scan(&id)
		if err != nil {
			return fmt.Errorf("postgres: record secret materialization: %w", err)
		}
		if _, err := AppendEvent(ctx, tx, events.New{
			Type: events.TypeSecretMaterialized, OrganizationID: in.OrganizationID,
			ProjectID: in.ProjectID, AttemptID: in.AttemptID,
			Actor:   events.Actor{Kind: events.ActorKindWorker, ID: in.WorkerID},
			Payload: payload,
		}); err != nil {
			return err
		}
		return nil
	})
	return id, err
}

// MarkMaterializationCleaned closes a row and is the difference between "cleanup
// works" and "cleanup works when nothing crashes": the startup sweep over rows
// still uncleaned calls it with cleaned_by='startup_sweep' after removing a file a
// dead worker left behind.
func (s *SecretStore) MarkMaterializationCleaned(ctx context.Context, id int64, cleanedBy string) error {
	tag, err := s.Pool.Exec(ctx, `
		UPDATE secret_materializations SET cleaned_at = now(), cleaned_by = $2
		 WHERE id = $1 AND cleaned_at IS NULL`, id, cleanedBy)
	if err != nil {
		return fmt.Errorf("postgres: mark secret materialization cleaned: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Either the row is gone or it was already closed: both are the state the
		// caller wanted, and an idempotent sweep must not fail on the second pass.
		return nil
	}
	return nil
}

// UncleanedMaterializations is the startup sweep's query, index-backed by
// secret_materializations_uncleaned_idx. Rows come back with the fields a caller
// needs to remove the file (target, worker, workspace) and nothing else.
func (s *SecretStore) UncleanedMaterializations(ctx context.Context, workspaceID string) ([]SecretMaterialization, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT mat.id, mat.secret_id::text, sm.slug, mat.secret_version, mat.project_id::text,
		       COALESCE(mat.workspace_id::text, ''), COALESCE(mat.turn_id::text, ''),
		       COALESCE(mat.attempt_id::text, ''), mat.worker_id::text, mat.delivery_mode, mat.target, mat.file_mode,
		       mat.materialized_at
		FROM secret_materializations mat
		JOIN secret_metadata sm ON sm.id = mat.secret_id
		WHERE mat.cleaned_at IS NULL AND ($1 = '' OR mat.workspace_id::text = $1)
		ORDER BY mat.materialized_at`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list uncleaned materializations: %w", err)
	}
	defer rows.Close()
	var out []SecretMaterialization
	for rows.Next() {
		var (
			mat  SecretMaterialization
			mode *int
		)
		if err := rows.Scan(&mat.ID, &mat.SecretID, &mat.SecretSlug, &mat.SecretVersion,
			&mat.ProjectID, &mat.WorkspaceID, &mat.TurnID, &mat.AttemptID, &mat.WorkerID,
			&mat.DeliveryMode, &mat.Target, &mode, &mat.MaterializedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan uncleaned materialization: %w", err)
		}
		if mode != nil {
			mat.FileMode = *mode
		}
		out = append(out, mat)
	}
	return out, rows.Err()
}

// --- authorization and shared plumbing -----------------------------------

// ErrKeyringUnavailable is what a SecretStore with no Keys answers, so a
// misconfigured process cannot accept a write it could never read back.
var ErrKeyringUnavailable = errors.New("postgres: secret keyring is not configured")

func (s *SecretStore) inTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	if s.Pool == nil {
		return errors.New("postgres: SecretStore has no pool")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit transaction: %w", err)
	}
	return nil
}

// visibleProject resolves the path's project and the caller's role in it. manage
// is what every secret mutation and the materialization view needs; a caller who
// cannot see the project gets ErrProjectNotFound, which the HTTP layer renders as
// the same 404 body a missing project produces.
func (s *SecretStore) visibleProject(ctx context.Context, c Caller, projectID string, manage bool) (Project, error) {
	project, err := prjGetProject(ctx, s.Pool, c, projectID)
	if err != nil {
		return Project{}, err
	}
	if err := secRoleGate(c, project.MyRole, manage); err != nil {
		return Project{}, err
	}
	return project, nil
}

// visibleSecret resolves the secret inside a caller's transaction, with the
// project it was reached through. The FOR UPDATE lock is taken only on the write
// path: a read that locks a row it is not about to change is how a list request
// and a rotation serialize against each other for no reason.
func (s *SecretStore) visibleSecret(ctx context.Context, c Caller, projectID, secretID string, manage bool) (Project, Secret, error) {
	var (
		project Project
		secret  Secret
	)
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		project, secret, err = s.visibleSecretInTx(ctx, tx, c, projectID, secretID, manage)
		return err
	})
	return project, secret, err
}

func (s *SecretStore) visibleSecretInTx(ctx context.Context, tx pgx.Tx, c Caller, projectID, secretID string, manage bool) (Project, Secret, error) {
	project, err := secProject(ctx, tx, c, projectID, manage)
	if err != nil {
		return Project{}, Secret{}, err
	}
	if !prjValidUUID(secretID) {
		return Project{}, Secret{}, ErrSecretNotFound
	}
	query := secSecretSelect + `
		WHERE sm.id = $1::uuid
		  AND ((sm.scope = 'project' AND sm.project_id = $2)
		    OR (sm.scope = 'org' AND sm.organization_id = $3 AND sm.project_id IS NULL))`
	args := []any{secretID, projectID, project.OrganizationID}
	if manage {
		query += ` FOR UPDATE OF sm`
	}
	secret, err := secFetchSecretWhere(ctx, tx, query, args...)
	if err != nil {
		return Project{}, Secret{}, err
	}
	return project, secret, nil
}

// secProject resolves the path's project inside tx and applies the role gate, so
// every write statement below inherits both the visibility predicate and the lock
// ordering.
func secProject(ctx context.Context, q prjQuerier, c Caller, projectID string, manage bool) (Project, error) {
	project, err := prjGetProject(ctx, q, c, projectID)
	if err != nil {
		return Project{}, err
	}
	if err := secRoleGate(c, project.MyRole, manage); err != nil {
		return Project{}, err
	}
	return project, nil
}

// secRoleGate is the store's own copy of the authorization rule. The HTTP layer
// checks the same thing first, and that is the point: a caller who reached the
// store by another route — a future worker endpoint, a test, a bug — gets the same
// answer, because the predicate lives in the query path rather than in the handler.
func secRoleGate(c Caller, myRole string, manage bool) error {
	role := authz.Role(myRole)
	if manage {
		if authz.CanManage(c.IsOrgAdmin, role) {
			return nil
		}
		return ErrSecretForbidden
	}
	if authz.CanView(c.IsOrgAdmin, role) {
		return nil
	}
	return ErrProjectNotFound
}

// RecordDenied writes the audit row every refused secret attempt leaves behind.
// Project-scoped (a secret's audit trail belongs to the project whose path named
// it), and never an answer to the client.
func (s *SecretStore) RecordDenied(ctx context.Context, c Caller, projectID, action string) error {
	if action == "" {
		action = "secret access denied"
	}
	detail := fmt.Sprintf(`{"action":%q,"project_id":%q,"role":%q}`, action, projectID, "")
	role := ""
	if prjValidUUID(projectID) {
		_ = s.Pool.QueryRow(ctx, `
			SELECT COALESCE(m.role, '')
			FROM memberships m WHERE m.project_id = $1::uuid AND m.user_id = $2::uuid`,
			projectID, c.UserID).Scan(&role)
	}
	detail = fmt.Sprintf(`{"action":%q,"project_id":%q,"role":%q}`, action, projectID, role)
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, 'human', $3, $4, 'denied', $5::jsonb)`,
		c.OrganizationID, prjCleanUUID(projectID), c.UserID, action, detail)
	if err != nil {
		return fmt.Errorf("postgres: record secret denial: %w", err)
	}
	return nil
}

// secAuditAllowed is the mutation half of ADR-0018 D3's audit rule: every secret
// change leaves a row whose detail is {secret_id, version, slug, purpose,
// delivery_mode} — and, because the detail is assembled from metadata the caller
// had to name in the first place, has no way to receive a value.
func secAuditAllowed(ctx context.Context, tx pgx.Tx, c Caller, project Project, action string, detail map[string]any) error {
	payload, err := prjPayloadJSON(detail)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, $2::uuid, 'human', $3, $4, 'allowed', $5::jsonb)`,
		project.OrganizationID, project.ID, c.UserID, action, payload)
	if err != nil {
		return fmt.Errorf("postgres: record secret audit: %w", err)
	}
	return nil
}

// --- SQL helpers ---------------------------------------------------------

const secSecretSelect = `
	SELECT sm.id::text, sm.organization_id::text, COALESCE(sm.project_id::text, ''), sm.scope,
	       sm.slug, sm.purpose, sm.delivery_mode, sm.current_version,
	       sm.allowed_agent_profile_ids, sm.allowed_node_template_ids, sm.audit_policy,
	       sm.created_by::text, sm.created_at, sm.rotated_at, sm.revoked_at
	FROM secret_metadata sm`

const secMountSelect = `
	SELECT m.id::text, m.project_id::text, m.secret_id::text, sm.slug, m.delivery_mode,
	       COALESCE(m.repository_id::text, ''), COALESCE(m.relative_path, ''),
	       COALESCE(m.env_name, ''), COALESCE(m."key", ''), m.lifecycle, m.allow_tracked,
	       m.created_at
	FROM secret_mounts m
	JOIN secret_metadata sm ON sm.id = m.secret_id`

func secScanSecret(row pgx.Row) (Secret, error) {
	var (
		secret Secret
		err    error
	)
	err = row.Scan(&secret.ID, &secret.OrganizationID, &secret.ProjectID, &secret.Scope,
		&secret.Slug, &secret.Purpose, &secret.DeliveryMode, &secret.CurrentVersion,
		&secret.Profiles, &secret.Templates, &secret.AuditPolicy, &secret.CreatedBy,
		&secret.CreatedAt, &secret.RotatedAt, &secret.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Secret{}, ErrSecretNotFound
	}
	if err != nil {
		return Secret{}, fmt.Errorf("postgres: scan secret: %w", err)
	}
	secret.CreatedAt = secret.CreatedAt.UTC()
	if secret.RotatedAt != nil {
		utc := secret.RotatedAt.UTC()
		secret.RotatedAt = &utc
	}
	if secret.RevokedAt != nil {
		utc := secret.RevokedAt.UTC()
		secret.RevokedAt = &utc
	}
	if secret.Profiles == nil {
		secret.Profiles = []string{}
	}
	if secret.Templates == nil {
		secret.Templates = []string{}
	}
	return secret, nil
}

func secScanMount(row pgx.Row) (SecretMount, error) {
	var (
		mount SecretMount
		err   error
	)
	err = row.Scan(&mount.ID, &mount.ProjectID, &mount.SecretID, &mount.SecretSlug,
		&mount.DeliveryMode, &mount.RepositoryID, &mount.RelativePath, &mount.EnvName,
		&mount.Key, &mount.Lifecycle, &mount.AllowTracked, &mount.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SecretMount{}, ErrMountNotFound
	}
	if err != nil {
		return SecretMount{}, fmt.Errorf("postgres: scan secret mount: %w", err)
	}
	mount.CreatedAt = mount.CreatedAt.UTC()
	return mount, nil
}

func secFetchSecret(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (Secret, error) {
	return secScanSecret(q.QueryRow(ctx, secSecretSelect+` WHERE sm.id = $1::uuid`, id))
}

func secFetchSecretWhere(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, query string, args ...any) (Secret, error) {
	return secScanSecret(q.QueryRow(ctx, query, args...))
}

func secFetchMount(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (SecretMount, error) {
	return secScanMount(q.QueryRow(ctx, secMountSelect+` WHERE m.id = $1::uuid`, id))
}

func secSecretBySlug(ctx context.Context, tx pgx.Tx, project Project, scope, slug string) (Secret, error) {
	if scope == secrets.ScopeOrg {
		return secFetchSecretWhere(ctx, tx, secSecretSelect+`
			WHERE sm.scope = 'org' AND sm.organization_id = $1::uuid AND sm.slug = $2`,
			project.OrganizationID, slug)
	}
	return secFetchSecretWhere(ctx, tx, secSecretSelect+`
		WHERE sm.scope = 'project' AND sm.project_id = $1::uuid AND sm.slug = $2`,
		project.ID, slug)
}

func secInsertVersion(ctx context.Context, tx pgx.Tx, secretID string, version int, createdBy string, sealed secrets.Sealed) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO secret_versions
			(secret_id, version, key_id, nonce, ciphertext, aad, content_sha256, created_by)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid)`,
		secretID, version, sealed.KeyID, sealed.Nonce, sealed.Ciphertext, sealed.AAD,
		sealed.ContentSHA256, createdBy)
	if err != nil {
		return fmt.Errorf("postgres: insert secret version: %w", err)
	}
	return nil
}

func secVersionMatchesDigest(ctx context.Context, tx pgx.Tx, secretID string, version int, digest string) (bool, error) {
	var stored string
	err := tx.QueryRow(ctx, `
		SELECT content_sha256 FROM secret_versions WHERE secret_id = $1::uuid AND version = $2`,
		secretID, version).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("postgres: compare secret content digest: %w", err)
	}
	return stored == digest, nil
}

func secVersionNumbers(ctx context.Context, tx pgx.Tx, secretID string) ([]int, error) {
	rows, err := tx.Query(ctx, `
		SELECT version FROM secret_versions WHERE secret_id = $1::uuid ORDER BY version`, secretID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list secret versions: %w", err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("postgres: scan secret version: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func secPolicyState(s Secret) events.SecretPolicyState {
	return events.SecretPolicyState{
		Purpose: s.Purpose, AuditPolicy: s.AuditPolicy,
		AllowedAgentProfileIDs: secNonNil(s.Profiles),
	}
}

func secNonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

// secScopeProjectID encodes secrets_scope_pointer in Go: an org-scope secret
// carries no project, and passing the project id for one would be a CHECK
// violation at best and a cross-project disclosure at worst.
func secScopeProjectID(scope, projectID string) any {
	if scope == secrets.ScopeOrg {
		return nil
	}
	return prjCleanUUID(projectID)
}

func secNullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func secNullUUID(s string) any {
	if s == "" {
		return nil
	}
	return prjCleanUUID(s)
}

// secNullFileMode records the mode that was actually created (384 == 0600), or
// null for env delivery — which is the difference between "a file with a wrong
// mode" and "no file", and the whole content of case 12/C12a's assertion.
func secNullFileMode(mode int) any {
	if mode == 0 {
		return nil
	}
	return mode
}

func secMountTarget(mount SecretMount) string {
	if mount.RelativePath != "" {
		return mount.RelativePath
	}
	return mount.EnvName
}

// sha256Sum is local rather than imported from internal/secrets: this digest
// exists only to compare a retried write against the row it would have created,
// and the store must be able to do that without importing the crypto package's
// material-bearing helpers.
func sha256Sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}
