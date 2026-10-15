package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound reports that a requested row does not exist (or has expired,
// which for single-use login state is equivalent).
var ErrNotFound = errors.New("postgres: not found")

// Organization is the tenant every user and project belongs to. M1 seeds a
// single row with slug "default".
type Organization struct {
	ID   string
	Slug string
	Name string
}

// User is an internal identity: the row keyed by an OIDC (issuer, subject)
// pair, never by email.
type User struct {
	ID             string
	OrganizationID string
	DisplayName    string
	Email          string
	IsOrgAdmin     bool
}

// LoginState is one in-flight OIDC Authorization Code + PKCE handshake. It
// lives in the database so a login started on one API replica can complete on
// another (ADR-0012 §6).
type LoginState struct {
	State        string
	CodeVerifier string
	Nonce        string
	ReturnTo     string
	ExpiresAt    time.Time
}

// IdentityStore reads and writes users, OIDC identities, sessions and login
// state. It is safe for concurrent use.
type IdentityStore struct {
	Pool *pgxpool.Pool
}

// idnUserColumns is the users projection returned by every identity query.
// The users.email column is nullable; it is coalesced to the empty string so
// callers never deal with three states of the same field.
const idnUserColumns = `u.id::text, u.organization_id::text, u.display_name,
	COALESCE(u.email, ''), u.is_org_admin`

// DefaultOrganization returns the organization seeded by migration 00001.
// M1 is single-tenant, so login always provisions users into this row.
func (s *IdentityStore) DefaultOrganization(ctx context.Context) (Organization, error) {
	if s == nil || s.Pool == nil {
		return Organization{}, errors.New("postgres: identity store has no pool")
	}
	var org Organization
	err := s.Pool.QueryRow(ctx,
		`SELECT id::text, slug, name FROM organizations WHERE slug = 'default'`).
		Scan(&org.ID, &org.Slug, &org.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Organization{}, fmt.Errorf("postgres: default organization: %w", ErrNotFound)
	}
	if err != nil {
		return Organization{}, fmt.Errorf("postgres: query default organization: %w", err)
	}
	return org, nil
}

// UpsertOIDCUser maps (issuer, subject) to a user, creating the user and its
// identity row on first login and refreshing profile fields afterwards.
//
// makeAdmin can only ever grant is_org_admin: a later login that is not in the
// bootstrap list never revokes an existing admin. The whole mapping runs in
// one transaction; a concurrent first login for the same subject surfaces as a
// unique violation on oidc_identities and is retried once, by which point the
// identity row exists and the update path applies.
func (s *IdentityStore) UpsertOIDCUser(ctx context.Context, orgID, issuer, subject,
	displayName, email string, makeAdmin bool) (User, error) {
	if s == nil || s.Pool == nil {
		return User{}, errors.New("postgres: identity store has no pool")
	}
	if orgID == "" || issuer == "" || subject == "" || displayName == "" {
		return User{}, errors.New("postgres: UpsertOIDCUser requires org, issuer, subject and display name")
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		u, err := s.idnUpsertUser(ctx, orgID, issuer, subject, displayName, email, makeAdmin)
		if err == nil {
			return u, nil
		}
		if !idnUniqueViolation(err) {
			return User{}, err
		}
		lastErr = err
	}
	return User{}, fmt.Errorf("postgres: upsert oidc user %q: %w", subject, lastErr)
}

func (s *IdentityStore) idnUpsertUser(ctx context.Context, orgID, issuer, subject,
	displayName, email string, makeAdmin bool) (u User, err error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, fmt.Errorf("postgres: begin identity upsert: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	// Existing identity: refresh the profile, never demote.
	err = tx.QueryRow(ctx, `
		SELECT `+idnUserColumns+`
		FROM oidc_identities i
		JOIN users u ON u.id = i.user_id
		WHERE i.issuer = $1 AND i.subject = $2`, issuer, subject).
		Scan(&u.ID, &u.OrganizationID, &u.DisplayName, &u.Email, &u.IsOrgAdmin)
	switch {
	case err == nil:
		u, err = idnScanUser("refresh user", tx.QueryRow(ctx, `
			UPDATE users AS u SET
				display_name  = $2,
				email         = $3,
				last_login_at = now(),
				is_org_admin  = is_org_admin OR $4
			WHERE id = $1::uuid
			RETURNING `+idnUserColumns, u.ID, displayName, idnEmailParam(email), makeAdmin))
		if err != nil {
			return User{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return User{}, fmt.Errorf("postgres: commit identity refresh: %w", err)
		}
		return u, nil
	case errors.Is(err, pgx.ErrNoRows):
		// First login for this subject: fall through to insert.
	default:
		return User{}, fmt.Errorf("postgres: look up oidc identity: %w", err)
	}

	u, err = idnScanUser("insert user", tx.QueryRow(ctx, `
		INSERT INTO users AS u (organization_id, display_name, email, is_org_admin, last_login_at)
		VALUES ($1::uuid, $2, $3, $4, now())
		RETURNING `+idnUserColumns, orgID, displayName, idnEmailParam(email), makeAdmin))
	if err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO oidc_identities (user_id, issuer, subject)
		VALUES ($1::uuid, $2, $3)`, u.ID, issuer, subject); err != nil {
		return User{}, fmt.Errorf("postgres: insert oidc identity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, fmt.Errorf("postgres: commit identity insert: %w", err)
	}
	return u, nil
}

// CreateSession stores a session row for sha256(cookie token). The caller
// never passes, and this store never accepts, the raw token.
func (s *IdentityStore) CreateSession(ctx context.Context, tokenHash []byte,
	userID, csrf string, expires time.Time) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: identity store has no pool")
	}
	if len(tokenHash) == 0 || userID == "" || csrf == "" || expires.IsZero() {
		return errors.New("postgres: CreateSession requires token hash, user, csrf and expiry")
	}
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
		VALUES ($1, $2::uuid, $3, $4)`, tokenHash, userID, csrf, expires); err != nil {
		return fmt.Errorf("postgres: create session: %w", err)
	}
	return nil
}

// SessionUser resolves a session token hash to its user and CSRF token.
// Expired or unknown hashes return ErrNotFound. last_seen_at is refreshed at
// most once a minute so a busy browser does not write on every request.
func (s *IdentityStore) SessionUser(ctx context.Context, tokenHash []byte) (User, string, error) {
	if s == nil || s.Pool == nil {
		return User{}, "", errors.New("postgres: identity store has no pool")
	}
	if len(tokenHash) == 0 {
		return User{}, "", ErrNotFound
	}
	var csrf string
	u, err := idnScanUser("session", s.Pool.QueryRow(ctx, `
		SELECT `+idnUserColumns+`, s.csrf_token
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, tokenHash), &csrf)
	if err == nil {
		if _, err := s.Pool.Exec(ctx, `
			UPDATE sessions SET last_seen_at = now()
			WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, tokenHash); err != nil {
			return User{}, "", fmt.Errorf("postgres: touch session: %w", err)
		}
		return u, csrf, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrNotFound
	}
	return User{}, "", err
}

// DeleteSession removes a session at logout. Deleting an unknown hash is not
// an error.
func (s *IdentityStore) DeleteSession(ctx context.Context, tokenHash []byte) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: identity store has no pool")
	}
	if len(tokenHash) == 0 {
		return nil
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash); err != nil {
		return fmt.Errorf("postgres: delete session: %w", err)
	}
	return nil
}

// SaveLoginState records a started OIDC handshake with its expiry.
func (s *IdentityStore) SaveLoginState(ctx context.Context, st LoginState) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: identity store has no pool")
	}
	if st.State == "" || st.CodeVerifier == "" || st.Nonce == "" || st.ExpiresAt.IsZero() {
		return errors.New("postgres: incomplete login state")
	}
	returnTo := st.ReturnTo
	if returnTo == "" {
		returnTo = "/"
	}
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO oidc_login_states (state, code_verifier, nonce, return_to, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		st.State, st.CodeVerifier, st.Nonce, returnTo, st.ExpiresAt); err != nil {
		return fmt.Errorf("postgres: save login state: %w", err)
	}
	return nil
}

// TakeLoginState consumes a login handshake: the DELETE ... RETURNING makes
// replay of the same state impossible, and an expired row is indistinguishable
// from a missing one.
func (s *IdentityStore) TakeLoginState(ctx context.Context, state string) (LoginState, error) {
	if s == nil || s.Pool == nil {
		return LoginState{}, errors.New("postgres: identity store has no pool")
	}
	if state == "" {
		return LoginState{}, ErrNotFound
	}
	var st LoginState
	err := s.Pool.QueryRow(ctx, `
		DELETE FROM oidc_login_states
		WHERE state = $1 AND expires_at > now()
		RETURNING state, code_verifier, nonce, return_to, expires_at`, state).
		Scan(&st.State, &st.CodeVerifier, &st.Nonce, &st.ReturnTo, &st.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoginState{}, fmt.Errorf("postgres: login state: %w", ErrNotFound)
	}
	if err != nil {
		return LoginState{}, fmt.Errorf("postgres: take login state: %w", err)
	}
	return st, nil
}

// PurgeExpired removes expired sessions and unconsumed login states.
func (s *IdentityStore) PurgeExpired(ctx context.Context) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: identity store has no pool")
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`); err != nil {
		return fmt.Errorf("postgres: purge sessions: %w", err)
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM oidc_login_states WHERE expires_at <= now()`); err != nil {
		return fmt.Errorf("postgres: purge login states: %w", err)
	}
	return nil
}

// ListOrgUsers returns the members of an organization ordered by display name.
func (s *IdentityStore) ListOrgUsers(ctx context.Context, orgID string) ([]User, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: identity store has no pool")
	}
	if orgID == "" {
		return nil, errors.New("postgres: ListOrgUsers requires an organization id")
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+idnUserColumns+`
		FROM users u
		WHERE u.organization_id = $1::uuid
		ORDER BY lower(u.display_name), u.id`, orgID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list organization users: %w", err)
	}
	defer rows.Close()

	var out []User
	for rows.Next() {
		u, err := idnScanUser("list users", rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: list organization users: %w", err)
	}
	return out, nil
}

// idnScanner is satisfied by pgx rows and by a single-row QueryRow result.
type idnScanner interface {
	Scan(dest ...any) error
}

// idnScanUser scans the leading idnUserColumns into a User, forwarding any
// trailing destinations (a session's csrf_token) in the same pass.
func idnScanUser(what string, row idnScanner, extra ...any) (User, error) {
	var u User
	dest := make([]any, 0, 5+len(extra))
	dest = append(dest, &u.ID, &u.OrganizationID, &u.DisplayName, &u.Email, &u.IsOrgAdmin)
	dest = append(dest, extra...)
	if err := row.Scan(dest...); err != nil {
		return User{}, idnWrapScan(what, err)
	}
	return u, nil
}

func idnWrapScan(what string, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, pgx.ErrNoRows):
		return err
	default:
		return fmt.Errorf("postgres: scan %s: %w", what, err)
	}
}

// idnEmailParam maps the empty display email to SQL NULL: users.email is
// nullable because the IdP may not release the claim.
func idnEmailParam(email string) any {
	if email == "" {
		return nil
	}
	return email
}

// idnUniqueViolation reports a 23505 constraint violation.
func idnUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}
