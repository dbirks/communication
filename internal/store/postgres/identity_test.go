package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// idnTestStore migrates the scratch database and returns a store plus a
// cleanup function that removes everything these tests wrote.
// idnTestIssuerPrefix namespaces every issuer used below, so cleanup never
// touches rows another suite wrote into the shared scratch database.
const idnTestIssuerPrefix = "https://idn.test/"

func idnTestStore(t *testing.T) (context.Context, *IdentityStore) {
	t.Helper()
	url := testDatabaseURL(t)
	mustMigrate(t)

	ctx := testCtx(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	// Scope the wipe to the issuer used by the identity tests so a database
	// shared with other suites is left untouched.
	t.Cleanup(func() {
		bg := context.Background()
		var ids []string
		err := pool.QueryRow(bg, `
			SELECT COALESCE(array_agg(u.id::text), '{}')
			FROM users u
			JOIN oidc_identities i ON i.user_id = u.id
			WHERE i.issuer LIKE $1`, idnTestIssuerPrefix+"%").Scan(&ids)
		if err != nil {
			t.Errorf("cleanup select ids: %v", err)
			return
		}
		if len(ids) > 0 {
			if _, err := pool.Exec(bg, `
				DELETE FROM sessions WHERE user_id IN
					(SELECT id FROM users WHERE id::text = ANY($1))`, ids); err != nil {
				t.Errorf("cleanup sessions: %v", err)
			}
		}
		if _, err := pool.Exec(bg,
			`DELETE FROM oidc_identities WHERE issuer LIKE $1`, idnTestIssuerPrefix+"%"); err != nil {
			t.Errorf("cleanup identities: %v", err)
		}
		if len(ids) > 0 {
			if _, err := pool.Exec(bg,
				`DELETE FROM users WHERE id::text = ANY($1)`, ids); err != nil {
				t.Errorf("cleanup users: %v", err)
			}
		}
		if _, err := pool.Exec(bg, `
			DELETE FROM oidc_login_states WHERE state LIKE 'idn-state-%'`); err != nil {
			t.Errorf("cleanup login states: %v", err)
		}
	})
	return ctx, &IdentityStore{Pool: pool}
}

func idnDefaultOrg(t *testing.T, ctx context.Context, s *IdentityStore) Organization {
	t.Helper()
	org, err := s.DefaultOrganization(ctx)
	if err != nil {
		t.Fatalf("DefaultOrganization: %v", err)
	}
	if org.Slug != "default" {
		t.Fatalf("DefaultOrganization slug = %q, want %q", org.Slug, "default")
	}
	return org
}

func TestIdentityDefaultOrganization(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)
	if org.ID == "" || org.Name != "Default organization" {
		t.Errorf("DefaultOrganization = %+v, want id set and name %q", org, "Default organization")
	}
}

func TestIdentityUpsertOIDCUserCreatesThenUpdates(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)

	const issuer, subject = "https://idn.test/first", "subject-create-update"

	first, err := store.UpsertOIDCUser(ctx, org.ID, issuer, subject, "Alice", "alice@example.test", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser (create): %v", err)
	}
	if first.ID == "" || first.DisplayName != "Alice" || first.Email != "alice@example.test" {
		t.Errorf("created user = %+v", first)
	}
	if first.OrganizationID != org.ID {
		t.Errorf("created user organization = %q, want %q", first.OrganizationID, org.ID)
	}
	if first.IsOrgAdmin {
		t.Errorf("created user IsOrgAdmin = true, want false")
	}

	second, err := store.UpsertOIDCUser(ctx, org.ID, issuer, subject, "Alice II", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser (update): %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("second login created user %q, want same id %q", second.ID, first.ID)
	}
	if second.DisplayName != "Alice II" {
		t.Errorf("DisplayName = %q, want %q", second.DisplayName, "Alice II")
	}
	if second.Email != "" {
		t.Errorf("Email = %q, want empty (cleared from NULL column)", second.Email)
	}

	// last_login_at must be set by both logins.
	var loginSets int
	if err := store.Pool.QueryRow(ctx,
		`SELECT count(*) FROM users WHERE id = $1 AND last_login_at IS NOT NULL`, second.ID).
		Scan(&loginSets); err != nil {
		t.Fatalf("last_login_at query: %v", err)
	}
	if loginSets != 1 {
		t.Errorf("last_login_at set = %v rows, want 1", loginSets)
	}

	// Exactly one identity row for the pair.
	var idents int
	if err := store.Pool.QueryRow(ctx,
		`SELECT count(*) FROM oidc_identities WHERE issuer = $1 AND subject = $2`, issuer, subject).
		Scan(&idents); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if idents != 1 {
		t.Errorf("identity rows = %d, want 1", idents)
	}
}

func TestIdentityUpsertDistinctSubjectsAndIssuers(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)

	a, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/two", "bob", "Bob", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser bob: %v", err)
	}
	b, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/two", "carol", "Carol", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser carol: %v", err)
	}
	if a.ID == b.ID {
		t.Fatalf("different subjects mapped to the same user %q", a.ID)
	}
	// Same subject under a different issuer is a different identity (ADR-0012).
	c, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/three", "bob", "Bob Elsewhere", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser cross-issuer bob: %v", err)
	}
	if c.ID == a.ID {
		t.Errorf("same subject under a different issuer reused user %q", a.ID)
	}

	users, err := store.ListOrgUsers(ctx, org.ID)
	if err != nil {
		t.Fatalf("ListOrgUsers: %v", err)
	}
	seen := map[string]bool{}
	for _, u := range users {
		seen[u.ID] = true
	}
	for _, want := range []string{a.ID, b.ID, c.ID} {
		if !seen[want] {
			t.Errorf("ListOrgUsers missing user %s (got %d rows)", want, len(users))
		}
	}
	for i := 1; i < len(users); i++ {
		prev, next := strings.ToLower(users[i-1].DisplayName), strings.ToLower(users[i].DisplayName)
		if prev > next {
			t.Fatalf("ListOrgUsers not ordered case-insensitively by display name: %v", users)
		}
	}
}

func TestIdentityAdminFlagOnlyEverSet(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)
	const issuer, subject = "https://idn.test/admin", "admin-subject"

	u, err := store.UpsertOIDCUser(ctx, org.ID, issuer, subject, "Admin", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser (non-admin): %v", err)
	}
	if u.IsOrgAdmin {
		t.Fatalf("first login IsOrgAdmin = true, want false")
	}
	u, err = store.UpsertOIDCUser(ctx, org.ID, issuer, subject, "Admin", "", true)
	if err != nil {
		t.Fatalf("UpsertOIDCUser (admin): %v", err)
	}
	if !u.IsOrgAdmin {
		t.Fatalf("bootstrap admin login did not set IsOrgAdmin")
	}
	// A later login that is not in the bootstrap list must not demote.
	u, err = store.UpsertOIDCUser(ctx, org.ID, issuer, subject, "Admin Renamed", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser (post-admin): %v", err)
	}
	if !u.IsOrgAdmin {
		t.Errorf("IsOrgAdmin was revoked; it must only ever be set")
	}
	if u.DisplayName != "Admin Renamed" {
		t.Errorf("DisplayName = %q, want %q (profile must still refresh)", u.DisplayName, "Admin Renamed")
	}
}

func TestIdentitySessionLifecycle(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)
	user, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/sessions", "sess", "Sess", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser: %v", err)
	}

	hash := func(s string) []byte { sum := sha256.Sum256([]byte(s)); return sum[:] }
	live := hash("idn-live-token")

	if err := store.CreateSession(ctx, live, user.ID, "csrf-live", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	got, csrf, err := store.SessionUser(ctx, live)
	if err != nil {
		t.Fatalf("SessionUser: %v", err)
	}
	if got.ID != user.ID || csrf != "csrf-live" {
		t.Fatalf("SessionUser = (%+v, %q), want user %s and csrf csrf-live", got, csrf, user.ID)
	}

	// Expired sessions are never returned.
	expired := hash("idn-expired-token")
	if err := store.CreateSession(ctx, expired, user.ID, "csrf-expired", time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("CreateSession (expired): %v", err)
	}
	if _, _, err := store.SessionUser(ctx, expired); !errors.Is(err, ErrNotFound) {
		t.Errorf("SessionUser(expired) err = %v, want ErrNotFound", err)
	}
	// Unknown tokens behave the same way.
	if _, _, err := store.SessionUser(ctx, hash("idn-unknown-token")); !errors.Is(err, ErrNotFound) {
		t.Errorf("SessionUser(unknown) err = %v, want ErrNotFound", err)
	}

	// PurgeExpired drops the expired row but keeps the live one.
	if err := store.PurgeExpired(ctx); err != nil {
		t.Fatalf("PurgeExpired: %v", err)
	}
	var remaining int
	if err := store.Pool.QueryRow(ctx,
		`SELECT count(*) FROM sessions WHERE token_hash = $1`, expired).Scan(&remaining); err != nil {
		t.Fatalf("count expired session: %v", err)
	}
	if remaining != 0 {
		t.Errorf("PurgeExpired left %d expired session rows", remaining)
	}

	// Logout deletes the row; a second resolve is ErrNotFound, a second delete
	// is not an error.
	if err := store.DeleteSession(ctx, live); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, _, err := store.SessionUser(ctx, live); !errors.Is(err, ErrNotFound) {
		t.Errorf("SessionUser(after delete) err = %v, want ErrNotFound", err)
	}
	if err := store.DeleteSession(ctx, live); err != nil {
		t.Errorf("DeleteSession (already gone): %v", err)
	}
}

func TestIdentitySessionLastSeenThrottle(t *testing.T) {
	ctx, store := idnTestStore(t)
	org := idnDefaultOrg(t, ctx, store)
	user, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/seen", "seen", "Seen", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser: %v", err)
	}
	hash := func(s string) []byte { sum := sha256.Sum256([]byte(s)); return sum[:] }
	tok := hash("idn-seen-token")
	if err := store.CreateSession(ctx, tok, user.ID, "csrf-seen", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	var first, second time.Time
	if err := store.Pool.QueryRow(ctx,
		`SELECT last_seen_at FROM sessions WHERE token_hash = $1`, tok).Scan(&first); err != nil {
		t.Fatalf("read last_seen_at: %v", err)
	}
	if _, _, err := store.SessionUser(ctx, tok); err != nil {
		t.Fatalf("SessionUser: %v", err)
	}
	if err := store.Pool.QueryRow(ctx,
		`SELECT last_seen_at FROM sessions WHERE token_hash = $1`, tok).Scan(&second); err != nil {
		t.Fatalf("re-read last_seen_at: %v", err)
	}
	if !second.Equal(first) {
		t.Errorf("last_seen_at refreshed on a hot request: %v -> %v", first, second)
	}

	// Backdate it and the next request must refresh it.
	if _, err := store.Pool.Exec(ctx,
		`UPDATE sessions SET last_seen_at = now() - interval '2 minutes' WHERE token_hash = $1`, tok); err != nil {
		t.Fatalf("backdate last_seen_at: %v", err)
	}
	if _, _, err := store.SessionUser(ctx, tok); err != nil {
		t.Fatalf("SessionUser (stale): %v", err)
	}
	if err := store.Pool.QueryRow(ctx,
		`SELECT last_seen_at FROM sessions WHERE token_hash = $1`, tok).Scan(&second); err != nil {
		t.Fatalf("read last_seen_at again: %v", err)
	}
	if !second.After(first) {
		t.Errorf("last_seen_at after 2 stale minutes = %v, want newer than %v", second, first)
	}
}

func TestIdentityTakeLoginStateIsSingleUse(t *testing.T) {
	ctx, store := idnTestStore(t)
	state := "idn-state-single-use"
	if err := store.SaveLoginState(ctx, LoginState{
		State: state, CodeVerifier: "verifier", Nonce: "nonce",
		ReturnTo: "/projects", ExpiresAt: time.Now().Add(10 * time.Minute),
	}); err != nil {
		t.Fatalf("SaveLoginState: %v", err)
	}

	got, err := store.TakeLoginState(ctx, state)
	if err != nil {
		t.Fatalf("TakeLoginState: %v", err)
	}
	if got.CodeVerifier != "verifier" || got.Nonce != "nonce" || got.ReturnTo != "/projects" {
		t.Errorf("TakeLoginState = %+v", got)
	}
	if _, err := store.TakeLoginState(ctx, state); !errors.Is(err, ErrNotFound) {
		t.Errorf("replay err = %v, want ErrNotFound", err)
	}
	if _, err := store.TakeLoginState(ctx, "idn-state-never-saved"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown state err = %v, want ErrNotFound", err)
	}
	if err := store.SaveLoginState(ctx, LoginState{
		State: "idn-state-expired", CodeVerifier: "v", Nonce: "n", ReturnTo: "/",
		ExpiresAt: time.Now().Add(-time.Second),
	}); err != nil {
		t.Fatalf("SaveLoginState (expired): %v", err)
	}
	if _, err := store.TakeLoginState(ctx, "idn-state-expired"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired state err = %v, want ErrNotFound", err)
	}
	if err := store.SaveLoginState(ctx, LoginState{
		State: "idn-state-default-return", CodeVerifier: "v", Nonce: "n",
		ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("SaveLoginState (empty return_to): %v", err)
	}
	if st, err := store.TakeLoginState(ctx, "idn-state-default-return"); err != nil || st.ReturnTo != "/" {
		t.Errorf("empty ReturnTo stored as (%q, %v), want \"/\"", st.ReturnTo, err)
	}
}

func TestIdentityPurgeExpiredRemovesStaleStates(t *testing.T) {
	ctx, store := idnTestStore(t)
	for i, exp := range []time.Time{time.Now().Add(-time.Minute), time.Now().Add(time.Hour)} {
		if err := store.SaveLoginState(ctx, LoginState{
			State: fmt.Sprintf("idn-state-purge-%d", i), CodeVerifier: "v", Nonce: "n",
			ReturnTo: "/", ExpiresAt: exp,
		}); err != nil {
			t.Fatalf("SaveLoginState %d: %v", i, err)
		}
	}
	if err := store.PurgeExpired(ctx); err != nil {
		t.Fatalf("PurgeExpired: %v", err)
	}
	if _, err := store.TakeLoginState(ctx, "idn-state-purge-0"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired state survived PurgeExpired (err=%v)", err)
	}
	if _, err := store.TakeLoginState(ctx, "idn-state-purge-1"); err != nil {
		t.Errorf("live state was purged: %v", err)
	}
}
