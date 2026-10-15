package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if u == "" {
		t.Skip("COMMUNICATION_TEST_DATABASE_URL not set")
	}
	return u
}

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func mustMigrate(t *testing.T) string {
	t.Helper()
	url := testDatabaseURL(t)
	if err := Migrate(testCtx(t), url); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return url
}

func TestMigrateIdempotentAndVersion(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)

	// Second run must be a no-op, not an error.
	if err := Migrate(ctx, url); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}

	got, err := SchemaVersion(ctx, url)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	want := ExpectedSchemaVersion()
	if got != want {
		t.Errorf("SchemaVersion = %d, want ExpectedSchemaVersion %d", got, want)
	}
	if want != 1 {
		t.Errorf("ExpectedSchemaVersion = %d, want 1", want)
	}
}

func TestSeedOrganization(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var name string
	err = pool.QueryRow(ctx,
		"SELECT name FROM organizations WHERE slug = 'default'").Scan(&name)
	if err != nil {
		t.Fatalf("seed organization 'default' missing: %v", err)
	}
	if name != "Default organization" {
		t.Errorf("seed org name = %q, want %q", name, "Default organization")
	}
}

func TestDomainEventNotify(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)

	listen, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect listener: %v", err)
	}
	defer listen.Close(ctx)

	if _, err := listen.Exec(ctx, "LISTEN communication_events"); err != nil {
		t.Fatalf("LISTEN: %v", err)
	}

	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}

	var seq int64
	err = pool.QueryRow(ctx, `
		INSERT INTO domain_events (type, organization_id, actor_kind, actor_id)
		VALUES ('project.created', $1, 'human', 'tester')
		RETURNING global_seq`, orgID).Scan(&seq)
	if err != nil {
		t.Fatalf("insert domain_event: %v", err)
	}

	notifyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := listen.WaitForNotification(notifyCtx)
	if err != nil {
		t.Fatalf("WaitForNotification: %v", err)
	}
	if n.Channel != "communication_events" {
		t.Errorf("notification channel = %q, want %q", n.Channel, "communication_events")
	}
	if want := fmt.Sprintf("%d", seq); n.Payload != want {
		t.Errorf("notification payload = %q, want %q", n.Payload, want)
	}
}

func TestOIDCIdentityUniqueIssuerSubject(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	var userID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'dup-subject-user') RETURNING id`, orgID).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO oidc_identities (user_id, issuer, subject)
		VALUES ($1, 'https://idp.test', 'subject-dup')`, userID); err != nil {
		t.Fatalf("insert first identity: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO oidc_identities (user_id, issuer, subject)
		VALUES ($1, 'https://idp.test', 'subject-dup')`, userID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("duplicate (issuer,subject) accepted; err = %v", err)
	}
	if pgErr.Code != "23505" {
		t.Errorf("duplicate (issuer,subject) error code = %s, want 23505", pgErr.Code)
	}
}

func TestMembershipRoleCheckRejectsOwner(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var orgID, userID, projectID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'role-check-user') RETURNING id`, orgID).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'role-check-proj', 'Role check', $2) RETURNING id`,
		orgID, userID).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1, $2, 'owner')`, projectID, userID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("role 'owner' accepted; err = %v", err)
	}
	if pgErr.Code != "23514" {
		t.Errorf("role check error code = %s, want 23514", pgErr.Code)
	}
}
