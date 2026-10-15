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
	"github.com/jackc/pgx/v5/pgxpool"
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
	// replica demands. Current head: 00003, the M2 conversation/control/turn
	// model (ADR-0016), on top of 00002, the event-stream ordering column
	// (ADR-0014 §9). Adding a migration means updating this number on purpose.
	if want != int64(migHeadVersion) {
		t.Errorf("ExpectedSchemaVersion = %d, want %d", want, migHeadVersion)
	}
}

// migHeadVersion is the highest migration this suite expects to find.
const migHeadVersion = 3

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

// ------------------------------------------------------- 00003 (M2) contract
//
// These tests are the M2 half of ADR-0013's rule that a migration is only
// believed once it has been applied: they assert the *invariants* the three M2
// implementation workers are told about — one controller, one live turn, one
// live agent instance, monotonic fencing, honest terminals — as constraint
// behaviour, on a database that 00003 was actually applied to.

// migClaimSQL is the claim statement ADR-0016 pins for the execution worker:
// FOR UPDATE SKIP LOCKED, conversation affinity through the live ACP binding,
// and a fencing token drawn from the sequence at claim time. It lives here as
// much to be read as to be exercised — if this shape changes, the ADR and the
// worker change together.
const migClaimSQL = `
	UPDATE conversation_turns t
	SET status = 'leased',
	    worker_id = w.worker_id,
	    lease_expires_at = now() + make_interval(secs => $2::double precision),
	    fencing_token = nextval('conversation_turn_fencing_seq')
	FROM (
		SELECT c.id AS conversation_id, t2.id AS turn_id, $1::uuid AS worker_id
		FROM conversation_turns t2
		JOIN conversations c ON c.id = t2.conversation_id
		LEFT JOIN acp_session_bindings b
		       ON b.conversation_id = c.id AND b.status = 'connected'
		WHERE t2.status = 'queued'
		  AND c.status <> 'archived'
		  AND (b.worker_id IS NULL OR b.worker_id = $1::uuid)
		ORDER BY t2.created_at, t2.id
		FOR UPDATE OF t2 SKIP LOCKED
		LIMIT 1
	) w
	WHERE t.id = w.turn_id
	RETURNING t.id, t.conversation_id, t.worker_id, t.fencing_token`

// migPgCode reports the PostgreSQL constraint code err failed with, or "" for a
// non-constraint error. Every invariant below is stated as "this write fails
// with this code", so a write that *succeeds* — the real bug — must read
// unmistakably in the failure message.
func migPgCode(t *testing.T, err error) string {
	t.Helper()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	if err != nil {
		return "other: " + err.Error()
	}
	return "nil"
}

// migM2Fixture seeds a project, a user and the seeded Claude Code profile for
// one test, and removes them (and everything hanging off the project) at
// cleanup. Names carry migFixtureToken so two runs against one database cannot
// decide each other's outcome.
func migM2Fixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (projectID, userID, profileID string) {
	t.Helper()
	token := migFixtureToken(t)

	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'm2-user-' || $2) RETURNING id`, orgID, token).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'm2-proj-' || $2, 'M2 fixture', $3) RETURNING id`, orgID, token, userID).
		Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT id FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`,
		orgID).Scan(&profileID); err != nil {
		t.Fatalf("seeded profile 'Claude Code' lookup (migration 00003): %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			"DELETE FROM permission_requests WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)",
			"DELETE FROM acp_session_bindings WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)",
			"DELETE FROM conversation_turns WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)",
			"DELETE FROM conversation_control WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)",
			"DELETE FROM domain_events WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)",
			"DELETE FROM conversations WHERE project_id = $1",
			"DELETE FROM projects WHERE id = $1",
			"DELETE FROM users WHERE id = $1",
		} {
			if _, err := pool.Exec(bg, q, projectID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})
	return projectID, userID, profileID
}

// migM2Conversation inserts a conversation with its controller row (the shape
// createConversation writes) and returns its id.
func migM2Conversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, projectID, userID, profileID, title string) string {
	t.Helper()
	var convID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		projectID, profileID, title, userID).Scan(&convID); err != nil {
		t.Fatalf("insert conversation %q: %v", title, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1, 'human', $2)`, convID, userID); err != nil {
		t.Fatalf("insert control row for %q: %v", title, err)
	}
	return convID
}

// migM2BareConversation inserts a conversation with no control row, which the
// constraint tests need: a conversation with its controller already present
// cannot tell a CHECK violation from a primary-key violation.
func migM2BareConversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, projectID, userID, profileID, title string) string {
	t.Helper()
	var convID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		projectID, profileID, title, userID).Scan(&convID); err != nil {
		t.Fatalf("insert bare conversation %q: %v", title, err)
	}
	return convID
}

// migM2Worker registers a scratch worker row (a turn's lease must be a real
// workers row, per the FK) and cleans it up.
func migM2Worker(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status)
		VALUES ('m2-' || $1 || '-' || $2, 'lab', 'contract-test', 'online') RETURNING id`,
		tag, migFixtureToken(t)).Scan(&id); err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, "DELETE FROM acp_session_bindings WHERE worker_id = $1", id); err != nil {
			t.Errorf("cleanup bindings: %v", err)
		}
		if _, err := pool.Exec(bg, "DELETE FROM conversation_turns WHERE worker_id = $1", id); err != nil {
			t.Errorf("cleanup turns: %v", err)
		}
		if _, err := pool.Exec(bg, "DELETE FROM workers WHERE id = $1", id); err != nil {
			t.Errorf("cleanup worker: %v", err)
		}
	})
	return id
}

// TestMigrate0003SeededProfiles checks M2 ships two usable profiles rather than
// an empty registry, and that neither claims a sandbox it has not verified:
// both must be 'ask', so every permission prompt still reaches a human
// (communication-spec/04 "Permission policy", ADR-0009).
func TestMigrate0003SeededProfiles(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	rows, err := pool.Query(ctx, `
		SELECT name, launcher_id, permission_mode FROM agent_profiles
		WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default')
		ORDER BY name`)
	if err != nil {
		t.Fatalf("list seeded profiles: %v", err)
	}
	defer rows.Close()

	want := map[string][2]string{
		"Claude Code": {"claude", "ask"},
		"Codex":       {"codex", "ask"},
	}
	got := map[string][2]string{}
	for rows.Next() {
		var name, launcher, mode string
		if err := rows.Scan(&name, &launcher, &mode); err != nil {
			t.Fatalf("scan profile: %v", err)
		}
		got[name] = [2]string{launcher, mode}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read profiles: %v", err)
	}
	if len(got) != len(want) {
		t.Errorf("default-org profiles = %v, want exactly %d", got, len(want))
	}
	for name, w := range want {
		if g, ok := got[name]; !ok {
			t.Errorf("seeded profile %q missing", name)
		} else if g != w {
			t.Errorf("profile %q = %v, want %v (launcher, permission_mode)", name, g, w)
		}
	}
}

// TestMigrate0003ControlSingleController proves 01 invariant 2 — "a conversation
// can never have two simultaneously valid exclusive controllers" — is a DB
// constraint, not an API convention: a second row is a key violation, and every
// disagreement between controller_kind and its pointer is a CHECK violation.
func TestMigrate0003ControlSingleController(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	convID := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "single controller")

	otherID := ""
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		SELECT organization_id, 'm2-other-' || $1 FROM users WHERE id = $2 RETURNING id`,
		migFixtureToken(t), userID).Scan(&otherID); err != nil {
		t.Fatalf("insert second user: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DELETE FROM users WHERE id = $1", otherID); err != nil {
			t.Errorf("cleanup second user: %v", err)
		}
	})

	// Two control rows for one conversation IS "two simultaneous controllers".
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1, 'human', $2::uuid)`, convID, otherID); err == nil {
		t.Error("second controller row accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("second controller row code = %s, want 23505", code)
	}

	// Every disagreement between controller_kind and the pointer it implies is a
	// CHECK violation. Each case states its own statement, since the arguments
	// differ per case and pgx counts them.
	convBad := func(t *testing.T, name, sql string, args ...any) {
		t.Helper()
		conv := migM2BareConversation(t, ctx, pool, projectID, userID, profileID, "control bad "+name)
		all := append([]any{conv}, args...)
		if _, err := pool.Exec(ctx, sql, all...); err == nil {
			t.Errorf("%s: accepted", name)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s: code = %s, want 23514", name, code)
		}
	}
	convBad(t, "human without a user",
		`INSERT INTO conversation_control (conversation_id, controller_kind) VALUES ($1, 'human')`)
	convBad(t, "none with a user",
		`INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id) VALUES ($1, 'none', $2::uuid)`, userID)
	convBad(t, "two pointers populated",
		`INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id, controller_run_attempt_id) VALUES ($1, 'human', $2::uuid, gen_random_uuid())`, userID)
	convBad(t, "run_attempt without an attempt",
		`INSERT INTO conversation_control (conversation_id, controller_kind) VALUES ($1, 'run_attempt')`)
	convBad(t, "unknown kind",
		`INSERT INTO conversation_control (conversation_id, controller_kind) VALUES ($1, 'factory_run')`)
	convBad(t, "version below 1",
		`INSERT INTO conversation_control (conversation_id, controller_kind, version) VALUES ($1, 'none', 0)`)

	// The legal shapes must all insert, or the CHECK is just broken: unheld,
	// human-held with a recorded predecessor (what return-control needs), and the
	// M4 run_attempt shape, which the CHECK must already accommodate.
	for _, ok := range []struct {
		name, sql string
		args      []any
	}{
		{"uncontrolled",
			`INSERT INTO conversation_control (conversation_id, controller_kind) VALUES ($1, 'none')`,
			nil},
		{"human controlled",
			`INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id, previous_controller_user_id)
			 VALUES ($1, 'human', $2::uuid, $2::uuid)`,
			[]any{userID}},
		{"run attempt (M4 shape)",
			`INSERT INTO conversation_control (conversation_id, controller_kind, controller_run_attempt_id)
			 VALUES ($1, 'run_attempt', gen_random_uuid())`,
			nil},
	} {
		conv := migM2BareConversation(t, ctx, pool, projectID, userID, profileID, "control ok "+ok.name)
		args := append([]any{conv}, ok.args...)
		if _, err := pool.Exec(ctx, ok.sql, args...); err != nil {
			t.Errorf("%s: rejected: %v", ok.name, err)
		}
	}
}

// TestMigrate0003ControlCAS checks the version token behaves as an optimistic
// lock: the winning UPDATE matches one row, the loser matches none, and the
// loser changes nothing.
func TestMigrate0003ControlCAS(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	convID := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "control cas")

	var otherID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		SELECT organization_id, 'm2-cas-' || $1 FROM users WHERE id = $2 RETURNING id`,
		migFixtureToken(t), userID).Scan(&otherID); err != nil {
		t.Fatalf("insert challenger: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DELETE FROM users WHERE id = $1", otherID); err != nil {
			t.Errorf("cleanup challenger: %v", err)
		}
	})

	cas := `
		UPDATE conversation_control
		SET controller_kind = 'human', controller_user_id = $2,
		    previous_controller_user_id = COALESCE(controller_user_id, previous_controller_user_id),
		    version = version + 1, updated_at = now()
		WHERE conversation_id = $1 AND version = $3
		RETURNING version`

	// Both callers read version 1 and try to take control; exactly one wins.
	var winner, loser int
	if err := pool.QueryRow(ctx, cas, convID, userID, 1).Scan(&winner); err != nil {
		t.Fatalf("first take-control: %v", err)
	}
	err = pool.QueryRow(ctx, cas, convID, otherID, 1).Scan(&loser)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale-version take-control matched a row (version %d): CAS is not enforced by the WHERE clause", loser)
	}

	var holder string
	var version int
	if err := pool.QueryRow(ctx, `
		SELECT controller_user_id::text, version FROM conversation_control WHERE conversation_id = $1`,
		convID).Scan(&holder, &version); err != nil {
		t.Fatalf("read control: %v", err)
	}
	if holder != userID || version != winner || version != 2 {
		t.Errorf("control = (holder %s, version %d), want (%s, 2) — the loser must not change anything", holder, version, userID)
	}
}

// TestMigrate0003OneActiveTurnPerConversation proves the DB, not the API, makes
// "never two prompts into one running turn" true: a second non-terminal turn is
// a unique violation (the API maps it to 409), and a terminal one frees the slot
// because the index is partial over the live set.
func TestMigrate0003OneActiveTurnPerConversation(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	workerID := migM2Worker(t, ctx, pool, "active")

	insertTurn := `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, $2, $3)`

	// Queued blocks queued.
	queued := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "turn queued")
	if _, err := pool.Exec(ctx, insertTurn, queued, "first", userID); err != nil {
		t.Fatalf("insert first queued turn: %v", err)
	}
	if _, err := pool.Exec(ctx, insertTurn, queued, "second", userID); err == nil {
		t.Error("second queued turn accepted: conversation_turns_one_active_idx is not enforced")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("second queued turn code = %s, want 23505", code)
	}

	// Running blocks queued: the case a takeover races against.
	live := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "turn running")
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_turns
			(conversation_id, prompt, submitted_by, status, worker_id, lease_expires_at, fencing_token, started_at)
		VALUES ($1, 'running', $2, 'running', $3, now() + interval '30 seconds',
		        nextval('conversation_turn_fencing_seq'), now())`,
		live, userID, workerID); err != nil {
		t.Fatalf("insert running turn: %v", err)
	}
	if _, err := pool.Exec(ctx, insertTurn, live, "competing", userID); err == nil {
		t.Error("competing turn accepted while another was running")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("competing turn code = %s, want 23505", code)
	}

	// Terminal first, slot free — and the history survives.
	convID := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "turn reuse")
	if _, err := pool.Exec(ctx, insertTurn, convID, "one", userID); err != nil {
		t.Fatalf("insert turn: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE conversation_turns
		SET status = 'completed', finished_at = now(), stop_reason = 'end_turn'
		WHERE conversation_id = $1`, convID); err != nil {
		t.Fatalf("complete turn: %v", err)
	}
	if _, err := pool.Exec(ctx, insertTurn, convID, "two", userID); err != nil {
		t.Errorf("queued turn after a completed one rejected: %v", err)
	}
	var total int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM conversation_turns WHERE conversation_id = $1`, convID).Scan(&total); err != nil {
		t.Fatalf("count turns: %v", err)
	}
	if total != 2 {
		t.Errorf("turn history = %d rows, want 2 (a completed turn is never displaced)", total)
	}
}

// TestMigrate0003ClaimQuery runs the contract's claim statement end to end: it
// leases a queued turn, refuses to cross another worker's live affinity, and
// draws a strictly greater fencing token on every acquisition (01 invariant 3).
func TestMigrate0003ClaimQuery(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	mine := migM2Worker(t, ctx, pool, "claim-mine")
	theirs := migM2Worker(t, ctx, pool, "claim-theirs")

	// Free conversation: claimable by anyone.
	free := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "claim free")
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, 'claim me', $2)`, free, userID); err != nil {
		t.Fatalf("insert free turn: %v", err)
	}

	// Bound conversation: a live agent instance on `theirs` pins its turns to it.
	bound := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "claim bound")
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, 'not for you', $2)`, bound, userID); err != nil {
		t.Fatalf("insert bound turn: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO acp_session_bindings (conversation_id, worker_id, acp_session_id, protocol_version, launcher_id)
		VALUES ($1, $2, 'sess-theirs', 1, 'claude')`, bound, theirs); err != nil {
		t.Fatalf("bind conversation to %s: %v", theirs, err)
	}

	type claimed struct {
		turn, conv, worker string
		token              int64
	}
	claim := func(worker string) (claimed, bool) {
		var c claimed
		err := pool.QueryRow(ctx, migClaimSQL, worker, 30).
			Scan(&c.turn, &c.conv, &c.worker, &c.token)
		if errors.Is(err, pgx.ErrNoRows) {
			return claimed{}, false
		}
		if err != nil {
			t.Fatalf("claim for %s: %v", worker, err)
		}
		return c, true
	}

	got, ok := claim(mine)
	if !ok {
		t.Fatal("worker claimed nothing although a free conversation had a queued turn")
	}
	if got.conv != free {
		t.Errorf("claimed conversation %s, want the unbound conversation %s (affinity crossed)", got.conv, free)
	}
	if got.worker != mine {
		t.Errorf("claim recorded worker %s, want %s", got.worker, mine)
	}
	if got.token <= 0 {
		t.Fatalf("claim drew fencing_token %d, want > 0", got.token)
	}

	// Affinity: the other worker cannot take the bound conversation's turn.
	if extra, ok := claim(mine); ok && extra.conv == bound {
		t.Errorf("worker %s claimed a turn of a conversation bound to live worker %s", mine, theirs)
	} else if ok {
		t.Errorf("worker %s unexpectedly claimed conversation %s", mine, extra.conv)
	}
	if other, ok := claim(theirs); !ok {
		t.Error("the affinity worker claimed nothing: a conversation's live worker must be able to take its own turns")
	} else if other.conv != bound {
		t.Errorf("bound worker claimed conversation %s, want %s", other.conv, bound)
	} else if other.token <= got.token {
		t.Errorf("second claim token %d <= first %d; want strictly monotonic", other.token, got.token)
	}

	// A live lease is a full triple: dropping the deadline (or the owner) while
	// leased is impossible, because the reconciler must always have something to
	// compare against.
	if _, err := pool.Exec(ctx,
		"UPDATE conversation_turns SET lease_expires_at = NULL WHERE id = $1", got.turn); err == nil {
		t.Error("leased turn with NULL lease_expires_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("NULL lease_expires_at code = %s, want 23514", code)
	}
	if _, err := pool.Exec(ctx,
		"UPDATE conversation_turns SET fencing_token = 0 WHERE id = $1", got.turn); err == nil {
		t.Error("leased turn with fencing_token 0 accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("leased fencing_token 0 code = %s, want 23514", code)
	}
	// A queued turn owns nothing; that is what distinguishes an unclaimed turn
	// from a leased one without reading any other column.
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by, worker_id)
		VALUES ($1, 'queued with owner', $2, $3)`, free, userID, mine); err == nil {
		t.Error("queued turn carrying a worker_id accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("queued-with-owner code = %s, want 23514", code)
	}

	// Terminal statuses are honest about when they happened, and 'interrupted'
	// never borrows a harness stop reason.
	if _, err := pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'completed', finished_at = NULL, lease_expires_at = now()
		WHERE id = $1`, got.turn); err == nil {
		t.Error("completed turn without finished_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("completed without finished_at code = %s, want 23514", code)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'interrupted', finished_at = now(), stop_reason = 'end_turn'
		WHERE id = $1`, got.turn); err == nil {
		t.Error("interrupted turn carrying a stop_reason accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("interrupted with stop_reason code = %s, want 23514", code)
	}
}

// TestMigrate0003OneLiveBindingPerConversation proves the affinity anchor: one
// connected ACP session per conversation, with closed history kept.
func TestMigrate0003OneLiveBindingPerConversation(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	convID := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "bindings")
	workerID := migM2Worker(t, ctx, pool, "binding")

	insert := `
		INSERT INTO acp_session_bindings
			(conversation_id, worker_id, acp_session_id, protocol_version, launcher_id, session_origin)
		VALUES ($1, $2, $3, 1, 'claude', $4)`
	if _, err := pool.Exec(ctx, insert, convID, workerID, "session-a", "new"); err != nil {
		t.Fatalf("insert first binding: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, convID, workerID, "session-b", "new"); err == nil {
		t.Fatal("second connected binding accepted: one live agent instance is not enforced")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Fatalf("second binding code = %s, want 23505", code)
	}

	// Closing the live row makes room, and the closed row stays as evidence.
	if _, err := pool.Exec(ctx, `
		UPDATE acp_session_bindings SET status = 'closed', disconnected_at = now()
		WHERE conversation_id = $1 AND acp_session_id = 'session-a'`, convID); err != nil {
		t.Fatalf("close first binding: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, convID, workerID, "session-b", "resumed"); err != nil {
		t.Fatalf("binding after close rejected: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM acp_session_bindings WHERE conversation_id = $1`, convID).Scan(&n); err != nil {
		t.Fatalf("count bindings: %v", err)
	}
	if n != 2 {
		t.Errorf("binding history = %d rows, want 2 (closed bindings are evidence)", n)
	}

	// The end of a binding is recorded, always.
	if _, err := pool.Exec(ctx, `
		UPDATE acp_session_bindings SET status = 'disconnected'
		WHERE conversation_id = $1 AND acp_session_id = 'session-b'`, convID); err == nil {
		t.Error("disconnected binding without disconnected_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("disconnected without disconnected_at code = %s, want 23514", code)
	}

	// The claim query reads exactly one live binding per conversation; if two
	// rows could be 'connected' the affinity predicate would be a coin flip.
	var live string
	if err := pool.QueryRow(ctx, `
		SELECT worker_id::text FROM acp_session_bindings
		WHERE conversation_id = $1 AND status = 'connected'`, convID).Scan(&live); err != nil {
		t.Fatalf("read live binding: %v", err)
	}
	if live != workerID {
		t.Errorf("live binding worker = %s, want %s", live, workerID)
	}
}

// TestMigrate0003PermissionDecisionShape checks that a decided row IS a decision
// and an unanswered close is not, so the UI cannot render an approval nobody gave.
func TestMigrate0003PermissionDecisionShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)
	convID := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "permissions")

	var turnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, 'permission turn', $2) RETURNING id`, convID, userID).Scan(&turnID); err != nil {
		t.Fatalf("insert turn: %v", err)
	}

	insert := `
		INSERT INTO permission_requests (conversation_id, turn_id, acp_request_id, tool_title, tool_kind, options, deadline_at)
		VALUES ($1, $2, 'rpc-1', 'Write internal/api/projects.go', 'edit',
		        '[{"option_id":"allow_once","label":"Allow once","kind":"allow_once"}]'::jsonb,
		        now() + interval '5 minutes')`
	if _, err := pool.Exec(ctx, insert, convID, turnID); err != nil {
		t.Fatalf("insert pending permission request: %v", err)
	}

	// A decision needs a decider and an option; either alone is a fabrication.
	for _, bad := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE permission_requests SET status = 'decided', decided_at = now() WHERE turn_id = $1 AND acp_request_id = 'rpc-1'`, []any{turnID}},
		{`UPDATE permission_requests SET status = 'decided', decision_option_id = 'allow_once' WHERE turn_id = $1 AND acp_request_id = 'rpc-1'`, []any{turnID}},
		{`UPDATE permission_requests SET status = 'expired', decided_by = $2::uuid WHERE turn_id = $1 AND acp_request_id = 'rpc-1'`, []any{turnID, userID}},
	} {
		if _, err := pool.Exec(ctx, bad.sql, bad.args...); err == nil {
			t.Errorf("decision-shape violation accepted: %s", bad.sql)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("decision-shape code = %s, want 23514 (%s)", code, bad.sql)
		}
	}

	// Closing without an answer is the honest path and must be legal.
	if _, err := pool.Exec(ctx, `
		UPDATE permission_requests SET status = 'expired'
		WHERE turn_id = $1 AND acp_request_id = 'rpc-1'`, turnID); err != nil {
		t.Errorf("expiring an unanswered request rejected: %v", err)
	}

	// Recording the decision needs both halves of the answer and the row's own
	// identity — turn id plus the harness's request id.
	if _, err := pool.Exec(ctx, `
		UPDATE permission_requests
		SET status = 'decided', decided_by = $2::uuid, decision_option_id = 'allow_once', decided_at = now()
		WHERE turn_id = $1 AND acp_request_id = 'rpc-1'`, turnID, userID); err != nil {
		t.Fatalf("record decision: %v", err)
	}

	// One ACP request id per turn: an answer cannot be split across rows.
	if _, err := pool.Exec(ctx, `
		INSERT INTO permission_requests (conversation_id, turn_id, acp_request_id, tool_title)
		VALUES ($1, $2, 'rpc-1', 'Write it again')`, convID, turnID); err == nil {
		t.Error("duplicate acp_request_id for one turn accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate acp_request_id code = %s, want 23505", code)
	}

	// Only one unanswered request per turn may be pending for the same tool call,
	// and the pending scan the controller's UI reads must be index-backed.
	var pending int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM permission_requests WHERE conversation_id = $1 AND status = 'pending'`,
		convID).Scan(&pending); err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if pending != 0 {
		t.Errorf("pending prompts = %d after the only one was decided, want 0", pending)
	}
}

// TestMigrate0003TranscriptJournal proves the transcript really is the shared
// journal: conversation-scoped rows land in domain_events, replay in
// global_seq order through the gap-safety filter the project stream uses, and
// never leak into another conversation's stream (ADR-0016, ADR-0014 §9).
func TestMigrate0003TranscriptJournal(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	projectID, userID, profileID := migM2Fixture(t, ctx, pool)

	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT organization_id::text FROM projects WHERE id = $1", projectID).Scan(&orgID); err != nil {
		t.Fatalf("read conversation org: %v", err)
	}
	first := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "transcript")
	second := migM2Conversation(t, ctx, pool, projectID, userID, profileID, "other transcript")

	for _, seq := range []int{1, 2, 3} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO domain_events (type, organization_id, project_id, conversation_id, actor_kind, actor_id, payload)
			VALUES ('conversation.message.agent', $1::uuid, $2::uuid, $3::uuid, 'worker', 'contract-test',
			        jsonb_build_object('conversation_id', $3::text, 'chunk_seq', $4::int, 'text', 'chunk'))`,
			orgID, projectID, first, seq); err != nil {
			t.Fatalf("append transcript row: %v", err)
		}
	}

	replay := func(conv string) []int64 {
		var out []int64
		rows, err := pool.Query(ctx, `
			SELECT e.global_seq FROM domain_events e
			WHERE e.conversation_id = $1::uuid
			  AND e.global_seq > 0
			  AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
			ORDER BY e.global_seq LIMIT 100`, conv)
		if err != nil {
			t.Fatalf("replay transcript for %s: %v", conv, err)
		}
		defer rows.Close()
		for rows.Next() {
			var s int64
			if err := rows.Scan(&s); err != nil {
				t.Fatalf("scan transcript row: %v", err)
			}
			out = append(out, s)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("read transcript rows: %v", err)
		}
		return out
	}

	got := replay(first)
	if len(got) != 3 {
		t.Fatalf("transcript replay returned %d rows (%v), want the 3 appended", len(got), got)
	}
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("transcript replay is not ordered by global_seq: %v", got)
		}
	}
	if other := replay(second); len(other) != 0 {
		t.Errorf("unrelated conversation replayed %d rows (%v), want 0 — conversation_id is the stream's scope", len(other), other)
	}

	// The index the stream needs exists with the right key columns.
	var def string
	if err := pool.QueryRow(ctx, `
		SELECT indexdef FROM pg_indexes
		WHERE tablename = 'domain_events' AND indexname = 'domain_events_conversation_seq_idx'`).
		Scan(&def); err != nil {
		t.Fatalf("domain_events_conversation_seq_idx missing: %v", err)
	}
	if !strings.Contains(def, "conversation_id") || !strings.Contains(def, "global_seq") {
		t.Errorf("transcript index = %s, want key (conversation_id, global_seq)", def)
	}

	// And the project stream still sees conversation events: project_id is set
	// on every one, so the project timeline is a superset (ADR-0016).
	var shared int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1 AND conversation_id = $2`,
		projectID, first).Scan(&shared); err != nil {
		t.Fatalf("count project-visible transcript rows: %v", err)
	}
	if shared != 3 {
		t.Errorf("project stream sees %d conversation rows, want 3", shared)
	}

	// Show the plan for the record: the scoped read must be index-driven.
	plan := ""
	prows, err := pool.Query(ctx, `
		EXPLAIN (COSTS OFF) SELECT global_seq FROM domain_events e
		WHERE e.conversation_id = $1::uuid AND e.global_seq > 0
		  AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
		ORDER BY e.global_seq LIMIT 100`, first)
	if err != nil {
		t.Fatalf("explain transcript read: %v", err)
	}
	for prows.Next() {
		var line string
		if err := prows.Scan(&line); err != nil {
			break
		}
		plan += line + "\n"
	}
	prows.Close()
	t.Logf("transcript read plan:\n%s", plan)
}
