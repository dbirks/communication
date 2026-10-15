package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
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
	// Pinned, not derived from the filesystem: a migration file appearing by
	// accident must fail here rather than silently raise the version every
	// replica demands. Current head: 00002, the event-stream ordering column
	// (ADR-0014 §9). Adding a migration means updating this number on purpose.
	if want != int64(migHeadVersion) {
		t.Errorf("ExpectedSchemaVersion = %d, want %d", want, migHeadVersion)
	}
}

// migHeadVersion is the highest migration this suite expects to find.
const migHeadVersion = 2

// TestMigration0002EventOrdering proves the gap-safety column exists with the
// default the reader relies on, rather than merely that goose reported 2.
func TestMigration0002EventOrdering(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var typ, def string
	var notNull bool
	err = pool.QueryRow(ctx, `
		SELECT format_type(a.atttypid, a.atttypmod),
		       COALESCE((SELECT pg_get_expr(d.adbin, d.adrelid)
		                 FROM pg_attrdef d
		                 WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum), ''),
		       a.attnotnull
		FROM pg_attribute a
		WHERE a.attrelid = 'domain_events'::regclass AND a.attname = 'tx_id'`).
		Scan(&typ, &def, &notNull)
	if err != nil {
		t.Fatalf("domain_events.tx_id missing: %v", err)
	}
	if typ != "xid8" {
		t.Errorf("tx_id type = %q, want xid8", typ)
	}
	if !notNull {
		t.Error("tx_id is nullable; a row the reader cannot attribute must not be possible")
	}
	if !strings.Contains(def, "pg_current_xact_id") {
		t.Errorf("tx_id default = %q, want pg_current_xact_id()", def)
	}

	// A plain insert must land with the writing transaction's id, which is what
	// makes the reader's pg_snapshot_xmin comparison meaningful.
	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	var same bool
	err = pool.QueryRow(ctx, `
		INSERT INTO domain_events (type, organization_id, actor_kind, actor_id)
		VALUES ('project.created', $1, 'human', 'migrate-test')
		RETURNING tx_id = pg_current_xact_id()`, orgID).Scan(&same)
	if err != nil {
		t.Fatalf("insert with tx_id default: %v", err)
	}
	if !same {
		t.Error("tx_id did not record the inserting transaction")
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

// migFixtureToken makes a fixture row unique per run, so a suite that leaves a
// row behind (or a database that already holds one) cannot decide the outcome
// of the next run: these tests assert on constraint behaviour, and a second
// `go test -p 1 ./...` against the same database must say the same thing as
// the first. t.Cleanup then removes what was inserted.
func migFixtureToken(t *testing.T) string {
	t.Helper()
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

func TestOIDCIdentityUniqueIssuerSubject(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Cleanup callbacks run LIFO after the test function returns, so the pool
	// must be closed by a callback too — a plain defer would beat the fixture
	// cleanups below and close the pool out from under them.
	t.Cleanup(pool.Close)

	const issuer = "https://mig.test"
	subject := "subject-dup-" + migFixtureToken(t)

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
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, `DELETE FROM oidc_identities WHERE user_id = $1`, userID); err != nil {
			t.Errorf("cleanup identities: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup users: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO oidc_identities (user_id, issuer, subject)
		VALUES ($1, $2, $3)`, userID, issuer, subject); err != nil {
		t.Fatalf("insert first identity: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO oidc_identities (user_id, issuer, subject)
		VALUES ($1, $2, $3)`, userID, issuer, subject)
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
	t.Cleanup(pool.Close)

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
	slug := "role-check-proj-" + migFixtureToken(t)
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, $2, 'Role check', $3) RETURNING id`,
		orgID, slug, userID).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, `DELETE FROM memberships WHERE project_id = $1`, projectID); err != nil {
			t.Errorf("cleanup memberships: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM projects WHERE id = $1`, projectID); err != nil {
			t.Errorf("cleanup project: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup user: %v", err)
		}
	})

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
