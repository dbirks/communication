package postgres

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	neturl "net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMain gives this test binary its own Postgres rather than letting every
// `go test` run share COMMUNICATION_TEST_DATABASE_URL and each other's
// cluster-global transaction watermark (migStartEmbeddedCluster), falling back
// to a per-PID scratch database in the shared cluster, and only then to the
// shared URL itself. Without this, the suite's own TRUNCATE fixtures and the
// transactions the gap-safety tests deliberately hold open corrupt any other
// run overlapping in the same cluster: the events tests' baseline reads come
// back empty while another session pins the snapshot watermark below their
// just-committed row.
func TestMain(m *testing.M) {
	shared := os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if shared != "" {
		if url, stop := migStartEmbeddedCluster(); url != "" {
			if err := os.Setenv("COMMUNICATION_TEST_DATABASE_URL", url); err != nil {
				panic("postgres test isolation: setenv: " + err.Error())
			}
			code := m.Run()
			stop()
			os.Exit(code)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if db, err := migIsolateDatabase(ctx, shared); err == nil {
			if err := os.Setenv("COMMUNICATION_TEST_DATABASE_URL", db.url); err != nil {
				panic("postgres test isolation: setenv: " + err.Error())
			}
			code := m.Run()
			db.drop(shared)
			os.Exit(code)
		}
	}
	os.Exit(m.Run())
}

// migStartEmbeddedCluster boots a throwaway Postgres cluster (initdb into a
// temp dir, started on a free port over a temp-dir socket, trust auth) and
// returns its URL plus a stopper, or "" when the server tools are unusable.
// It exists because the journal reader's gap-safety watermark is not merely
// database-global but CLUSTER-global: one session holding an open writing
// transaction anywhere in the cluster keeps pg_snapshot_xmin behind every
// later commit, so a second `go test` run of this suite (which by design
// holds transactions open for half a second at a time) makes a first run's
// journal reads return nothing — the exact cross-test interference this suite
// suffered. Only a cluster of its own gives each run a watermark no one else
// can pin. Failure to boot is not fatal: the caller falls back to a scratch
// database, then to the shared URL.
func migStartEmbeddedCluster() (string, func()) {
	bin, err := exec.LookPath("initdb")
	if err != nil {
		return "", nil
	}
	pgctl, err := exec.LookPath("pg_ctl")
	if err != nil {
		return "", nil
	}
	dir, err := os.MkdirTemp("", "comm-pgtest-*")
	if err != nil {
		return "", nil
	}
	data := dir + "/data"
	if out, err := exec.Command(bin, "-D", data, "-U", "postgres", "-A", "trust", "--no-sync").CombinedOutput(); err != nil {
		_ = os.RemoveAll(dir)
		_, _ = os.Stderr.WriteString("postgres tests: initdb failed, using the shared database\n" + string(out) + "\n")
		return "", nil
	}
	for port := 30000 + (os.Getpid() % 20000); port < 60000; port++ {
		cmd := exec.Command(pgctl, "-D", data, "-l", dir+"/log", "-o",
			fmt.Sprintf("-p %d -k %s -c listen_addresses=127.0.0.1 -c fsync=off", port, dir),
			"-w", "-t", "30", "start")
		if out, err := cmd.CombinedOutput(); err != nil {
			_ = out
			continue
		}
		url := fmt.Sprintf("postgres://postgres@127.0.0.1:%d/postgres", port)
		return url, func() {
			_ = exec.Command(pgctl, "-D", data, "-m", "immediate", "stop").Run()
			_ = os.RemoveAll(dir)
		}
	}
	_ = os.RemoveAll(dir)
	_, _ = os.Stderr.WriteString("postgres tests: no free port for an embedded cluster, using the shared database\n")
	return "", nil
}

// migTestDatabase is a per-run scratch database; drop is best-effort — an
// undropped database leaves the shared instance no worse than a crashed run
// would, and the next run's PID differs.
type migTestDatabase struct {
	url, name string
}

func migIsolateDatabase(ctx context.Context, sharedURL string) (*migTestDatabase, error) {
	admin, err := pgx.Connect(ctx, sharedURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = admin.Close(ctx) }()
	name := fmt.Sprintf("comm_test_%d", os.Getpid())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		return nil, err
	}
	u, err := neturl.Parse(sharedURL)
	if err != nil {
		return nil, err
	}
	u.Path = "/" + name
	return &migTestDatabase{url: u.String(), name: name}, nil
}

func (d *migTestDatabase) drop(sharedURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, sharedURL)
	if err != nil {
		return
	}
	defer func() { _ = admin.Close(ctx) }()
	// FORCE needs PG13+; terminate first so even older servers see no
	// connected users, then try FORCE and fall back to a plain drop.
	_, _ = admin.Exec(ctx,
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, d.name)
	stmt := "DROP DATABASE IF EXISTS " + pgx.Identifier{d.name}.Sanitize()
	if _, err := admin.Exec(ctx, stmt+" WITH (FORCE)"); err != nil {
		_, _ = admin.Exec(ctx, stmt)
	}
}

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
	// replica demands. See migHeadVersion for what the current head is and why.
	if want != int64(migHeadVersion) {
		t.Errorf("ExpectedSchemaVersion = %d, want %d", want, migHeadVersion)
	}
}

// A migration is only believed once it has been applied. ExpectedSchemaVersion
// reads the embedded filesystem, so the constant here is what makes a migration
// file appearing "by accident" a test failure rather than a silently higher
// version every replica demands. Current head: 00013 (ADR-0054 server-side APM
// lock: apm_contents_summary + the apm_lock_requests queue) on top of
// 00012 (ADR-0056 run triggers: runs.trigger_kind/trigger_ref + the
// issue_triggers table) on top of
// 00011 (ADR-0053 run-from-thread: runs.source_conversation_id + the partial
// linked_runs index) on top of
// 00010 (ADR-0050 assistant v2 tables), 00009 (the ADR-0049
// step-registry tables (node_templates, node_template_revisions,
// pipeline_revision_template_refs) and the pipelines.folder column, on top of
// 00008 (ADR-0046 user preferences), 00007 (the policy-owned permission
// verdicts on the conversation path, ADR-0039 Option A), 00006 (the M6
// schedule-trigger table, ADR-0032), 00005 (M4 pipeline/run/node-execution/
// attempt model, docs/m4-contract.md § 1, ADR-0021..0024), 00004 (M3
// workspace/secret/artifact model, docs/m3-contract.md § 1, ADR-0017..0020),
// 00003 (M2 conversations/control/turns, ADR-0016), 00002 (the event-stream
// ordering column, ADR-0014 §9) and 00001 (M1 core).
const migHeadVersion = 13

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

// ------------------------------------------------------- 00004 (M3) contract
//
// The M3 half of ADR-0013's rule that a migration is only believed once it has
// been applied: every invariant docs/m3-contract.md § 1 promises the three M3
// implementation workers is asserted here as constraint behaviour on a database
// 00004 was actually applied to. A write that *succeeds* is the bug these tests
// exist to catch, so each one states the code it expects (23505 uniqueness,
// 23514 CHECK) and the contract's list is checked off item by item.

// The two volume identities the fixture's worker reports, spelled the way the
// schema requires (`sha256:<64 hex>`). They are literals rather than derived
// values on purpose: a derivation rule that only exists in Go is a rule nobody
// can read off the database, and the whole point of probe V3 is that the *shape*
// of this identity is what an implementation must not get wrong.
var (
	migM3WorkspaceVolumeID = "sha256:" + strings.Repeat("1", 64)
	migM3MirrorVolumeID    = "sha256:" + strings.Repeat("2", 64)
)

// migM3GeneratedColumnCode is the SQLSTATE Postgres 18 raises for an INSERT that
// supplies a value for a GENERATED ALWAYS column — observed literal from
// 00004 on postgres:18.6, not looked up: "ERROR: cannot insert a non-DEFAULT
// value into column \"agent_root\"". Pinned because the refusal is the invariant
// (nobody may record a grant that includes worker-only `meta/`), and a code
// change would mean Postgres stopped refusing it, which is worth noticing.
const migM3GeneratedColumnCode = "428C9"

// migM3Fixture seeds the objects an M3 row hangs off — org, user, project, a
// repository, the seeded Claude Code profile and a registered worker carrying
// volume identity — and removes them plus everything below them at cleanup.
// Names carry migFixtureToken so two runs against one database cannot decide
// each other's outcome.
type migM3Fixture struct {
	orgID, userID, projectID, repoID, profileID, workerID string
}

func migM3FixtureFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool) migM3Fixture {
	t.Helper()
	token := migFixtureToken(t)
	var f migM3Fixture

	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&f.orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'm3-user-' || $2) RETURNING id`, f.orgID, token).Scan(&f.userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'm3-proj-' || $2, 'M3 fixture', $3) RETURNING id`, f.orgID, token, f.userID).
		Scan(&f.projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1, 'm3-repo-' || $2, 'file:///srv/m3/fixtures/backend.git', $3) RETURNING id`,
		f.projectID, token, f.userID).Scan(&f.repoID); err != nil {
		t.Fatalf("insert repository: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT id FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`,
		f.orgID).Scan(&f.profileID); err != nil {
		t.Fatalf("seeded profile 'Claude Code' lookup (migration 00003): %v", err)
	}
	// A worker with volume identity: registration data, not a per-run choice
	// (ADR-0017 D2 as corrected by probe V3/V5b). The workspace rows below name
	// this worker AND the volume identity of the tree they live in, which is
	// measured per storage root — the workspaces root and the mirror root are two
	// rows because they are two trees.
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status,
		                     sandbox_backend, sandbox_version, sandbox_enforcement, sandbox_verified)
		VALUES ('m3-worker-' || $1, 'lab', 'contract-test', 'online',
		        'nono', '0.80.0', 'required', true)
		RETURNING id`, token).Scan(&f.workerID); err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	// (st_dev, st_ino) are the numbers the m3 probe suite actually observed for
	// two named volumes mounted at these paths (p5 V5b), including the fact that
	// the device number is shared and the inode is not.
	for _, root := range []struct {
		kind, path, volumeID string
		ino                  int64
	}{
		{"workspaces", "/workspaces", migM3WorkspaceVolumeID, 19414245},
		{"repos", "/repos", migM3MirrorVolumeID, 19414347},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO worker_volumes (worker_id, root_kind, root_path, st_dev, st_ino, fstype, volume_id)
			VALUES ($1, $2, $3, 30, $4, NULL, $5)`,
			f.workerID, root.kind, root.path, root.ino, root.volumeID); err != nil {
			t.Fatalf("insert worker_volumes %s: %v", root.kind, err)
		}
	}

	t.Cleanup(func() {
		bg := context.Background()
		cleanup := func(sql string, args ...any) {
			if _, err := pool.Exec(bg, sql, args...); err != nil {
				t.Errorf("cleanup %q: %v", sql, err)
			}
		}
		// Every fixture object is reachable from the fixture user, including a
		// sibling project one test inserts itself: keying teardown on that (not on
		// the first project id) is what keeps FK ordering from depending on which
		// test registered its cleanup in what order.
		const owned = `(SELECT id FROM projects WHERE created_by = $1::uuid)`
		cleanup(`DELETE FROM artifacts WHERE project_id IN `+owned+` OR organization_id = $2`, f.userID, f.orgID)
		cleanup(`DELETE FROM secret_materializations WHERE project_id IN `+owned, f.userID)
		cleanup(`DELETE FROM secret_mounts WHERE project_id IN `+owned, f.userID)
		// Org-scope secrets carry no project, so they travel by their creator.
		cleanup(`DELETE FROM secret_versions WHERE secret_id IN
			(SELECT id FROM secret_metadata WHERE project_id IN `+owned+` OR created_by = $1::uuid)`, f.userID)
		cleanup(`DELETE FROM secret_metadata WHERE project_id IN `+owned+` OR created_by = $1::uuid`, f.userID)
		cleanup(`DELETE FROM workspace_repos WHERE workspace_id IN
			(SELECT id FROM workspaces WHERE project_id IN `+owned+`)`, f.userID)
		cleanup(`DELETE FROM workspaces WHERE project_id IN `+owned, f.userID)
		for _, q := range []string{
			`DELETE FROM conversation_control WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id IN ` + owned + `)`,
			`DELETE FROM permission_requests WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id IN ` + owned + `)`,
			`DELETE FROM acp_session_bindings WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id IN ` + owned + `)`,
			`DELETE FROM conversation_turns WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id IN ` + owned + `)`,
			`DELETE FROM domain_events WHERE project_id IN ` + owned,
			`DELETE FROM conversations WHERE project_id IN ` + owned,
			`DELETE FROM repositories WHERE project_id IN ` + owned,
			`DELETE FROM projects WHERE created_by = $1::uuid`,
		} {
			cleanup(q, f.userID)
		}
		cleanup(`DELETE FROM worker_volumes WHERE worker_id = $1`, f.workerID)
		cleanup(`DELETE FROM workers WHERE id = $1`, f.workerID)
		cleanup(`DELETE FROM users WHERE id = $1`, f.userID)
	})
	return f
}

// migM3Conversation creates a conversation with its controller row, since a
// conversation-scoped workspace must point at a real conversation.
func migM3Conversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, f migM3Fixture, title string) string {
	t.Helper()
	var convID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`, f.projectID, f.profileID, title, f.userID).
		Scan(&convID); err != nil {
		t.Fatalf("insert conversation %q: %v", title, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_control (conversation_id, controller_kind, controller_user_id)
		VALUES ($1, 'human', $2)`, convID, f.userID); err != nil {
		t.Fatalf("insert control row for %q: %v", title, err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// Order matters and every statement is checked: a leftover queued turn is
		// visible to *every* claim test in this package (the claim query is FIFO
		// over all conversations), so an ignored error here breaks M2's suite, not
		// just M3's.
		for _, q := range []string{
			"DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE conversation_id = $1)",
			"DELETE FROM secret_materializations WHERE workspace_id IN (SELECT id FROM workspaces WHERE conversation_id = $1)",
			"DELETE FROM workspaces WHERE conversation_id = $1",
			"DELETE FROM permission_requests WHERE conversation_id = $1",
			"DELETE FROM acp_session_bindings WHERE conversation_id = $1",
			"DELETE FROM conversation_turns WHERE conversation_id = $1",
			"DELETE FROM conversation_control WHERE conversation_id = $1",
			"DELETE FROM domain_events WHERE conversation_id = $1",
			"DELETE FROM conversations WHERE id = $1",
		} {
			if _, err := pool.Exec(bg, q, convID); err != nil {
				t.Errorf("conversation cleanup %q: %v", q, err)
			}
		}
	})
	return convID
}

// TestMigrate0004WorkerVolumeIdentity checks the two halves of ADR-0017 D2 as
// the m3 probe suite corrected them:
//
//   - The sandbox columns arrived as registration data with honest defaults: an
//     M2-era worker reports backend 'none', enforcement 'disabled', verified
//     false and has NO `worker_volumes` row ("unknown volume" — and no M3
//     workspace may bind to an unknown volume). A column default must never read
//     as a capability.
//   - Volume identity is stored per storage root and is a digest, not a device
//     number. Probe V3 measured two different docker named volumes mounted at
//     one path reporting the SAME st_dev, so a worker that hashed st_dev alone
//     would call a replaced volume the same one and silently reclaim workspaces
//     whose bytes are gone (case 20's honest arm). Probe V5b measured the
//     workspaces root and the mirror root as one device with different inodes,
//     which is why identity is keyed by root rather than held in one column on
//     `workers`.
func TestMigrate0004WorkerVolumeIdentity(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status)
		VALUES ('m3-defaults-' || $1, 'lab', 'contract-test', 'online') RETURNING id`,
		migFixtureToken(t)).Scan(&id); err != nil {
		t.Fatalf("insert an M2-shaped worker: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// Both statements are checked and neither is combined: pgx sends a simple
		// query as one statement, and a cleanup that silently failed would leak a
		// worker row into every later test in this package.
		for _, q := range []string{
			"DELETE FROM worker_volumes WHERE worker_id = $1",
			"DELETE FROM workers WHERE id = $1",
		} {
			if _, err := pool.Exec(bg, q, id); err != nil {
				t.Errorf("cleanup worker %s (%s): %v", id, q, err)
			}
		}
	})

	var backend, enforcement string
	var version *string
	var verified bool
	var notes []byte
	err = pool.QueryRow(ctx, `
		SELECT sandbox_backend, sandbox_enforcement,
		       sandbox_version, sandbox_verified, sandbox_notes
		FROM workers WHERE id = $1`, id).
		Scan(&backend, &enforcement, &version, &verified, &notes)
	if err != nil {
		t.Fatalf("read worker sandbox columns: %v", err)
	}
	if version != nil {
		t.Errorf("an M2-era worker reported sandbox_version %v, want NULL", *version)
	}
	if backend != "none" || enforcement != "disabled" || verified {
		t.Errorf("sandbox defaults = (%s, %s, verified=%v), want (none, disabled, false)", backend, enforcement, verified)
	}
	if string(notes) != "[]" {
		t.Errorf("sandbox_notes default = %s, want []", notes)
	}

	// "Unknown volume" is the absence of a probe, never a placeholder value.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM worker_volumes WHERE worker_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count worker_volumes: %v", err)
	}
	if n != 0 {
		t.Errorf("an un-probing worker has %d worker_volumes rows, want 0 (unknown volume)", n)
	}
	// And the shape ADR-0017 D2 originally drafted must not exist: one identity
	// column on `workers` could only ever name one of the two M3 trees (V5b).
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'workers'
		  AND column_name IN ('volume_id', 'workspace_root', 'repos_root')`).Scan(&n); err != nil {
		t.Fatalf("count workers identity columns: %v", err)
	}
	if n != 0 {
		t.Errorf("workers carries %d single-column volume identity columns, want 0 (identity is per root in worker_volumes)", n)
	}

	// The enforcement enum is a CHECK, not an application convention: a worker
	// that reported "required-ish" would make ADR-0019's fallback debate mute.
	if _, err := pool.Exec(ctx,
		"UPDATE workers SET sandbox_enforcement = 'required-ish' WHERE id = $1", id); err == nil {
		t.Error("sandbox_enforcement 'required-ish' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("sandbox_enforcement code = %s, want 23514", code)
	}

	// ---- worker_volumes: the identity itself.

	probe := `
		INSERT INTO worker_volumes (worker_id, root_kind, root_path, st_dev, st_ino, fstype, volume_id)
		VALUES ($1, $2, $3, $4, $5, 'ext4', $6)`
	if _, err := pool.Exec(ctx, probe, id, "workspaces", "/workspaces", 30, 19414245,
		migM3WorkspaceVolumeID); err != nil {
		t.Fatalf("a legal probe row was rejected: %v", err)
	}
	// A second root of the same worker is a second row, and the mirror root is
	// the same device with a different inode — exactly V5b's measurement.
	if _, err := pool.Exec(ctx, probe, id, "repos", "/repos", 30, 19414347,
		migM3MirrorVolumeID); err != nil {
		t.Fatalf("the mirror root was rejected: %v", err)
	}

	// The identity is a digest of the whole tuple, so the number that V3 showed
	// to be insufficient on its own is not a legal value here. This is the
	// assertion that keeps `st_dev`-only identity from coming back.
	for _, bad := range []struct{ name, volumeID string }{
		{"bare st_dev", "30"},
		{"device and path", "/workspaces:30"},
		{"bare hex digest", strings.Repeat("3", 64)},
		{"wrong prefix", "sha512:" + strings.Repeat("3", 128)},
		{"short digest", "sha256:" + strings.Repeat("3", 63)},
	} {
		if _, err := pool.Exec(ctx, probe, id, "repos", "/repos/other", 30, 19414999, bad.volumeID); err == nil {
			t.Errorf("volume_id %s (%s) accepted", bad.volumeID, bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("volume_id %s (%s) code = %s, want 23514", bad.volumeID, bad.name, code)
		}
	}

	// One identity row per (worker, root kind): a worker that re-probed and got a
	// different volume must not have two claims about the same tree, because the
	// reclaim rule reads exactly one.
	if _, err := pool.Exec(ctx, probe, id, "workspaces", "/workspaces/second", 30, 19414246,
		migM3WorkspaceVolumeID); err == nil {
		t.Error("a second 'workspaces' root for one worker accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate root_kind code = %s, want 23505", code)
	}

	// A replaced volume at the SAME path is a different identity: same worker,
	// same kind, same root_path, different inode ⇒ different volume_id, which is
	// what makes case 20's "different volume" arm observable at all. Proven by
	// letting a second worker report it (two workers may share a disk).
	var other string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status) VALUES ('m3-other-' || $1, 'lab', 'ct', 'online')
		RETURNING id`, migFixtureToken(t)).Scan(&other); err != nil {
		t.Fatalf("insert second worker: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			"DELETE FROM worker_volumes WHERE worker_id = $1",
			"DELETE FROM workers WHERE id = $1",
		} {
			if _, err := pool.Exec(bg, q, other); err != nil {
				t.Errorf("cleanup worker %s (%s): %v", other, q, err)
			}
		}
	})
	if _, err := pool.Exec(ctx, probe, other, "workspaces", "/workspaces", 30, 99999999,
		"sha256:"+strings.Repeat("4", 64)); err != nil {
		t.Errorf("a second worker reporting a different volume at the same path was rejected: %v", err)
	}

	// Paths must be absolute and `..`-free — the same ACL proof rule as every
	// other path column here — and root_kind is a closed enum.
	if _, err := pool.Exec(ctx, probe, other, "repos", "repos/projA", 30, 12,
		"sha256:"+strings.Repeat("5", 64)); err == nil {
		t.Error("relative worker_volumes.root_path accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("relative root_path code = %s, want 23514", code)
	}
	if _, err := pool.Exec(ctx, probe, other, "scratch", "/scratch", 30, 12,
		"sha256:"+strings.Repeat("6", 64)); err == nil {
		t.Error("root_kind 'scratch' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("root_kind code = %s, want 23514", code)
	}
	// st_ino 0 is not a measured inode: an implementation that left it unset
	// rather than stat'ing the root would otherwise look identical to a probe.
	if _, err := pool.Exec(ctx, probe, other, "repos", "/repos", 30, 0,
		"sha256:"+strings.Repeat("7", 64)); err == nil {
		t.Error("st_ino = 0 accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("st_ino = 0 code = %s, want 23514", code)
	}
}

// TestMigrate0004WorkspaceScopePointer is contract § 1's first named invariant:
// a workspace belongs to exactly one of {conversation, run}. M4's run scope must
// already be legal (so it does not rename the wire) and the mixed shapes
// impossible.
func TestMigrate0004WorkspaceScopePointer(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "workspace scope")

	insert := `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id, run_id,
		                        worker_id, volume_id, root_path, state)
		VALUES ($1, $2, $3, $4, $5, $6, $7, '/workspaces/conversation/x', 'preparing')`

	// The conversation shape the M3 worker writes today.
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "conversation", convID, nil,
		f.workerID, migM3WorkspaceVolumeID); err != nil {
		t.Fatalf("conversation-scoped workspace rejected: %v", err)
	}
	// The run shape M4 writes, legal now with no runs table.
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "run", nil, genUUID(),
		f.workerID, migM3WorkspaceVolumeID); err != nil {
		t.Errorf("run-scoped workspace rejected (M4 must not need a migration): %v", err)
	}

	for _, bad := range []struct {
		name      string
		kind      string
		conv, run any
	}{
		{"conversation without a conversation id", "conversation", nil, nil},
		{"run without a run id", "run", nil, nil},
		{"both pointers populated", "conversation", convID, genUUID()},
		{"run kind carrying a conversation", "run", convID, genUUID()},
	} {
		_, err := pool.Exec(ctx, insert, f.orgID, f.projectID, bad.kind, bad.conv, bad.run,
			f.workerID, migM3WorkspaceVolumeID)
		if err == nil {
			t.Errorf("%s: accepted", bad.name)
			continue
		}
		if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s: code = %s, want 23514", bad.name, code)
		}
	}

	// Unknown scope kinds are not a future extension point, they are a typo.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id, volume_id, root_path, state)
		VALUES ($1, $2, 'attempt', gen_random_uuid(), $3, 'sha256:' || repeat('1', 64), '/workspaces/x', 'preparing')`,
		f.orgID, f.projectID, f.workerID); err == nil {
		t.Error("scope_kind 'attempt' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("scope_kind code = %s, want 23514", code)
	}
}

// TestMigrate0004WorkspacePathsAndState proves root_path is an ACL proof
// (absolute, `..`-free), that state and ready_at agree, and that a workspace's
// volume is the worker's own — the columns case 20's honest loss report reads.
func TestMigrate0004WorkspacePathsAndState(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "workspace paths")

	for _, path := range []string{"workspaces/conversation/x", "/workspaces/conversation/../y",
		"/workspaces//..", "~/workspaces"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
			                        worker_id, volume_id, root_path, state)
			VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, 'preparing')`,
			f.orgID, f.projectID, convID, f.workerID, path); err == nil {
			t.Errorf("root_path %q accepted", path)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("root_path %q code = %s, want 23514", path, code)
		}
	}

	// A 'ready' workspace without ready_at is a workspace that claims a path on
	// disk nobody timestamped; a 'preparing' one with it is the same lie reversed.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), '/workspaces/conversation/ready-lie', 'ready', NULL)`,
		f.orgID, f.projectID, convID, f.workerID); err == nil {
		t.Error("ready workspace without ready_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("ready without ready_at code = %s, want 23514", code)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), '/workspaces/conversation/preparing', 'preparing')`,
		f.orgID, f.projectID, convID, f.workerID); err != nil {
		t.Fatalf("insert preparing workspace: %v", err)
	}
	tag, err := pool.Exec(ctx, `
		UPDATE workspaces SET ready_at = now() WHERE project_id = $1 AND state = 'preparing'`,
		f.projectID)
	if err == nil {
		t.Error("preparing workspace with ready_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("preparing with ready_at code = %s, want 23514", code)
	} else if tag.RowsAffected() != 0 {
		t.Errorf("rejected UPDATE reported %d rows affected", tag.RowsAffected())
	}

	// volume_id is NOT NULL: a workspace that cannot name its disk cannot later
	// claim it was reclaimed from the same one.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state)
		VALUES ($1, $2, 'conversation', $3, $4, NULL, '/workspaces/conversation/novol', 'preparing')`,
		f.orgID, f.projectID, convID, f.workerID); err == nil {
		t.Error("workspace with NULL volume_id accepted")
	} else if code := migPgCode(t, err); code != "23502" {
		t.Errorf("NULL volume_id code = %s, want 23502", code)
	}

	// workspace_mode is the ADR-0010 escape hatch and nothing else.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, workspace_mode, state)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), '/workspaces/conversation/mode', 'symlink', 'preparing')`,
		f.orgID, f.projectID, convID, f.workerID); err == nil {
		t.Error("workspace_mode 'symlink' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("workspace_mode code = %s, want 23514", code)
	}
}

// TestMigrate0004OneLiveWorkspacePerConversation is contract § 1's 23505 case:
// two live workspaces means two agent processes in two checkouts of one scope.
// The index is partial over the live set, so `released` frees the slot and the
// history stays.
func TestMigrate0004OneLiveWorkspacePerConversation(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "workspace live")

	insert := `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, 'ready', now())`
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, convID, f.workerID,
		"/workspaces/conversation/"+convID); err != nil {
		t.Fatalf("insert first live workspace: %v", err)
	}
	for _, state := range []string{"preparing", "ready", "quarantined"} {
		// ready_at is set for every state that requires it, so what fires here is
		// the partial UNIQUE and not the state/timestamp CHECK.
		_, err := pool.Exec(ctx, `
			INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
			                        worker_id, volume_id, root_path, state, ready_at)
			VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, $6,
			        CASE WHEN $6 = 'preparing' THEN NULL ELSE now() END)`,
			f.orgID, f.projectID, convID, f.workerID, "/workspaces/conversation/second-"+state, state)
		if err == nil {
			t.Errorf("second live workspace in state %q accepted", state)
			continue
		}
		if code := migPgCode(t, err); code != "23505" {
			t.Errorf("second live workspace (%s) code = %s, want 23505", state, code)
		}
	}

	// Releasing makes room, and the released row survives as evidence.
	if _, err := pool.Exec(ctx, `
		UPDATE workspaces SET state = 'released', released_at = now()
		WHERE project_id = $1 AND conversation_id = $2`, f.projectID, convID); err != nil {
		t.Fatalf("release workspace: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, convID, f.workerID,
		"/workspaces/conversation/"+convID+"-second"); err != nil {
		t.Errorf("workspace after release rejected: %v", err)
	}
	var total, live int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM workspaces WHERE conversation_id = $1`, convID).Scan(&total); err != nil {
		t.Fatalf("count workspaces: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM workspaces WHERE conversation_id = $1
		  AND state IN ('preparing','ready','quarantined')`, convID).Scan(&live); err != nil {
		t.Fatalf("count live workspaces: %v", err)
	}
	if total != 2 || live != 1 {
		t.Errorf("workspaces = %d total / %d live, want 2 total / 1 live (a released workspace is history)", total, live)
	}

	// A run scope is a different scope: the conversation index must not bind it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, run_id, worker_id, volume_id, root_path, state)
		VALUES ($1, $2, 'run', gen_random_uuid(), $3, 'sha256:' || repeat('1', 64), '/workspaces/run/one', 'preparing')`,
		f.orgID, f.projectID, f.workerID); err != nil {
		t.Errorf("run-scoped workspace alongside a released conversation one rejected: %v", err)
	}
}

// TestMigrate0004WorkspaceRepos pins the per-repository topology table: one row
// per workspace × repository, and the paths ADR-0017 D4 refuses to construct
// (admin_dir included, because git's own naming is not derivable — and, per
// probe G1b, not readable from `git worktree list --porcelain` either on git
// 2.56.0, so it comes from `rev-parse --absolute-git-dir`). Every path here ends
// up in a sandbox grant, so absolute-and-`..`-free is a constraint, and the
// mirror lives on its own volume identity (probe V5b).
func TestMigrate0004WorkspaceRepos(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "workspace repos")
	var wsID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, 'ready', now()) RETURNING id`,
		f.orgID, f.projectID, convID, f.workerID, "/workspaces/conversation/"+convID).
		Scan(&wsID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	insert := `
		INSERT INTO workspace_repos (workspace_id, repository_id, checkout_path, mirror_path,
		                             mirror_volume_id, admin_dir, run_ref, base_commit)
		VALUES ($1, $2, '/workspaces/conversation/' || $3 || '/work/repos/backend',
		        '/repos/' || $4 || '/backend.git', $5,
		        '/repos/' || $4 || '.git/worktrees/backend1', $3 || '/backend',
		        '2222222222222222222222222222222222222222')`
	if _, err := pool.Exec(ctx, insert, wsID, f.repoID, convID, f.projectID,
		migM3MirrorVolumeID); err != nil {
		t.Fatalf("insert workspace_repo: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, wsID, f.repoID, convID, f.projectID,
		migM3MirrorVolumeID); err == nil {
		t.Error("second workspace_repo for the same (workspace, repository) accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate workspace_repo code = %s, want 23505", code)
	}

	// The mirror's volume is named per repository row because it is a different
	// tree from the workspace (V5b): "my worktree is intact but the mirror is
	// gone" must be reportable, and a shape that cannot hold both cannot.
	for _, bad := range []struct {
		name     string
		checkout string
		mirror   string
		volume   any
		adminDir string
		want     string
	}{
		{"relative mirror path", "/workspaces/conversation/" + convID + "/work/repos/backend", "repos/x/backend.git", migM3MirrorVolumeID, "/repos/x.git/worktrees/backend", "23514"},
		{"traversal in checkout", "/workspaces/conversation/" + convID + "/work/../meta", "/repos/x/backend.git", migM3MirrorVolumeID, "/repos/x.git/worktrees/backend", "23514"},
		{"relative admin dir", "/workspaces/conversation/" + convID + "/work/repos/backend", "/repos/x/backend.git", migM3MirrorVolumeID, "repos/x.git/worktrees/backend", "23514"},
		{"empty mirror volume", "/workspaces/conversation/" + convID + "/work/repos/backend", "/repos/x/backend.git", nil, "/repos/x.git/worktrees/backend", "23502"},
		{"st_dev-only mirror volume", "/workspaces/conversation/" + convID + "/work/repos/backend", "/repos/x/backend.git", "30", "/repos/x.git/worktrees/backend", "23514"},
	} {
		// One CHECK-constrained INSERT per arm against the (workspace, repository)
		// pair already inserted above: a CHECK or NOT NULL violation fires while
		// the tuple is built, i.e. before the unique index is consulted, so the
		// expected code is the shape problem and never an incidental 23505 — and
		// if the shape *were* legal this arm would fail on 23505 instead, which is
		// reported rather than accepted.
		_, err := pool.Exec(ctx, `
			INSERT INTO workspace_repos (workspace_id, repository_id, checkout_path, mirror_path,
			                             mirror_volume_id, admin_dir, run_ref, base_commit)
			VALUES ($1, $2, $3, $4, $5, $6, 'other-scope/backend',
			        '2222222222222222222222222222222222222222')`,
			wsID, f.repoID, bad.checkout, bad.mirror, bad.volume, bad.adminDir)
		if err == nil {
			t.Errorf("%s: accepted", bad.name)
			continue
		}
		if code := migPgCode(t, err); code != bad.want {
			t.Errorf("%s code = %s, want %s", bad.name, code, bad.want)
		}
	}

	// The manifests are the checkpoint's inputs; a missing one would be an
	// unprovable "what changed", so both default to an empty array, never NULL.
	var modified, excluded string
	if err := pool.QueryRow(ctx, `
		SELECT modified_paths::text, excluded_paths::text FROM workspace_repos
		WHERE workspace_id = $1 AND repository_id = $2`, wsID, f.repoID).
		Scan(&modified, &excluded); err != nil {
		t.Fatalf("read workspace_repo manifests: %v", err)
	}
	if modified != "[]" || excluded != "[]" {
		t.Errorf("manifest defaults = (%s, %s), want ([], [])", modified, excluded)
	}
}

// TestMigrate0004WorkspaceGrantLayout is the schema's answer to probe C-META:
// `nono --allow <dir>` is recursive, so a workspace layout that puts worker-only
// state (`meta/`) under the granted directory leaks it — the sandboxed child
// both read meta/workspace.json and wrote meta/agent-written. The layout here
// grants `<root>/work` and keeps `meta/` a sibling of it, and `agent_root` is a
// GENERATED column so no writer can record any other shape.
func TestMigrate0004WorkspaceGrantLayout(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "grant layout")

	root := "/workspaces/conversation/" + convID
	var id, agentRoot string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, 'preparing')
		RETURNING id, agent_root`, f.orgID, f.projectID, convID, f.workerID, root).
		Scan(&id, &agentRoot); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if want := root + "/work"; agentRoot != want {
		t.Errorf("agent_root = %q, want %q (the grant must exclude <root>/meta)", agentRoot, want)
	}

	// The derivation is the database's, not a convention in one worker: the
	// column reports as generated, so an INSERT that names it is refused.
	var generated, expression string
	if err := pool.QueryRow(ctx, `
		SELECT is_generated, generation_expression FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'agent_root'`).
		Scan(&generated, &expression); err != nil {
		t.Fatalf("read agent_root generation: %v", err)
	}
	if generated != "ALWAYS" || !strings.Contains(expression, "/work") {
		t.Errorf("agent_root is_generated = %q expression = %q, want ALWAYS … '/work'", generated, expression)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, agent_root, state)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5,
		        '/workspaces', 'preparing')`,
		f.orgID, f.projectID, convID, f.workerID, root+"-two"); err == nil {
		t.Error("supplying agent_root by hand was accepted (meta/ could be inside the grant)")
	} else if code := migPgCode(t, err); code != migM3GeneratedColumnCode {
		t.Errorf("supplying agent_root code = %s, want %s", code, migM3GeneratedColumnCode)
	}

	// Root and grant move together: a relayout re-derives the grant rather than
	// leaving a stale one behind (a stale grant is a directory the sandbox still
	// reaches after the worker stopped calling it the workspace).
	if _, err := pool.Exec(ctx, `UPDATE workspaces SET root_path = $2 WHERE id = $1`,
		id, root+"-moved"); err != nil {
		t.Fatalf("relocate workspace root: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT agent_root FROM workspaces WHERE id = $1`, id).Scan(&agentRoot); err != nil {
		t.Fatalf("read relocated agent_root: %v", err)
	}
	if want := root + "-moved/work"; agentRoot != want {
		t.Errorf("agent_root after relayout = %q, want %q", agentRoot, want)
	}
}

// TestMigrate0004SecretsScopePointer is contract § 1's named invariant, and the
// one whose failure would be a disclosure: an org-scope secret pointing at a
// project (or a project-scope secret with nothing to scope it to) makes "which
// projects may read this" a question with two answers.
func TestMigrate0004SecretsScopePointer(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)

	// A second project in the same organization, so slug scoping is tested
	// against a real sibling rather than an assumption.
	var otherProject string
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'm3-proj-b-' || $2, 'M3 sibling', $3) RETURNING id`,
		f.orgID, migFixtureToken(t), f.userID).Scan(&otherProject); err != nil {
		t.Fatalf("insert sibling project: %v", err)
	}
	// delivery_mode has no default on purpose: ADR-0018 clause 8 refuses a
	// delivery mode nobody chose, so every insert below states one.
	insert := `
		INSERT INTO secret_metadata (organization_id, project_id, scope, slug, delivery_mode, created_by)
		VALUES ($1, $2, $3, $4, 'env_file', $5)`
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "project", "database-url", f.userID); err != nil {
		t.Fatalf("project-scope secret rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, f.orgID, nil, "org", "harness-token", f.userID); err != nil {
		t.Fatalf("org-scope secret rejected: %v", err)
	}

	for _, bad := range []struct {
		name      string
		projectID any
		scope     string
		slug      string
	}{
		{"org scope with a project", f.projectID, "org", "leaky-org"},
		{"project scope without a project", nil, "project", "orphan-project"},
	} {
		if _, err := pool.Exec(ctx, insert, f.orgID, bad.projectID, bad.scope, bad.slug, f.userID); err == nil {
			t.Errorf("%s: accepted", bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s: code = %s, want 23514", bad.name, code)
		}
	}

	// The two slug indexes are scoped, not org-wide: the M3 exit fixtures plant
	// the same slug in two projects, and an org-wide UNIQUE would reject that.
	if _, err := pool.Exec(ctx, insert, f.orgID, otherProject, "project", "database-url", f.userID); err != nil {
		t.Errorf("the same slug in a sibling project rejected: %v — secret_metadata_project_slug_idx is not project-scoped", err)
	}
	if _, err := pool.Exec(ctx, insert, f.orgID, nil, "org", "harness-token", f.userID); err == nil {
		t.Error("duplicate org-scope slug accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate org slug code = %s, want 23505", code)
	}
	// An org-scope slug and a project slug may share a name; the partial
	// predicates are what make that legal.
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "project", "harness-token", f.userID); err != nil {
		t.Errorf("project slug colliding with an org slug rejected: %v", err)
	}

	// delivery_mode / audit_policy / current_version are CHECKs, and the empty
	// allowlist means "denied to all", so it must be present, not absent.
	var allowed []string
	if err := pool.QueryRow(ctx, `
		SELECT allowed_agent_profile_ids FROM secret_metadata
		WHERE project_id = $1 AND slug = 'database-url'`, f.projectID).Scan(&allowed); err != nil {
		t.Fatalf("read allowlist: %v", err)
	}
	if len(allowed) != 0 {
		t.Errorf("empty allowlist = %v, want no members (empty means denied to all)", allowed)
	}
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "unbounded", "bad-scope", f.userID); err == nil {
		t.Error("secret scope 'unbounded' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("secret scope code = %s, want 23514", code)
	}
}

// TestMigrate0004NoPlaintextColumnAnywhere is the structural half of ADR-0018
// D1: it is not enough that no API route returns a value, no *column* may be
// able to hold one. It reads the schema rather than trusting the file, so a
// later migration that adds `secret_metadata.value text` fails here.
func TestMigrate0004NoPlaintextColumnAnywhere(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	rows, err := pool.Query(ctx, `
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND (table_name LIKE 'secret%' OR table_name LIKE '%workspace%' OR table_name = 'domain_events')
		  AND lower(column_name) ~ '(^|_)(value|plaintext|cleartext|raw|password|passphrase|secret_value|env_body)($|_)'
		ORDER BY table_name, column_name`)
	if err != nil {
		t.Fatalf("scan for plaintext-shaped columns: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var table, column, datatype string
		if err := rows.Scan(&table, &column, &datatype); err != nil {
			t.Fatalf("scan column row: %v", err)
		}
		t.Errorf("column %s.%s (%s) could hold a plaintext secret", table, column, datatype)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read column rows: %v", err)
	}

	// And the ciphertext column is where the bytes are, so its name says so.
	var ctType string
	if err := pool.QueryRow(ctx, `
		SELECT format_type(atttypid, atttypmod) FROM pg_attribute
		WHERE attrelid = 'secret_versions'::regclass AND attname = 'ciphertext'`).Scan(&ctType); err != nil {
		t.Fatalf("secret_versions.ciphertext missing: %v", err)
	}
	if ctType != "bytea" {
		t.Errorf("secret_versions.ciphertext = %s, want bytea", ctType)
	}
}

// TestMigrate0004SecretVersionShape asserts the envelope-encrypted row cannot
// exist in a half state: an empty ciphertext is indistinguishable from a failed
// write, a wrong-size nonce cannot be AES-GCM, and a version below 1 is not a
// version.
func TestMigrate0004SecretVersionShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	var secretID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO secret_metadata (organization_id, project_id, scope, slug, delivery_mode, created_by)
		VALUES ($1, $2, 'project', 'versioned', 'env', $3) RETURNING id`, f.orgID, f.projectID, f.userID).
		Scan(&secretID); err != nil {
		t.Fatalf("insert secret metadata: %v", err)
	}

	insert := `
		INSERT INTO secret_versions (secret_id, version, key_id, nonce, ciphertext, aad, content_sha256, created_by)
		VALUES ($1, $2, 'gen-1', decode($3, 'hex'), decode($4, 'hex'), $5,
		        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', $6)`
	nonce12 := strings.Repeat("ab", 12)
	if _, err := pool.Exec(ctx, insert, secretID, 1, nonce12, "2cf24dba5fb0a30e26e83b2ac5b9e29e",
		secretID+"|1|gen-1", f.userID); err != nil {
		t.Fatalf("legal secret_version rejected: %v", err)
	}

	// The same bytes as version 2 are legal (versions are immutable history, and
	// rotation of an unchanged value is not itself a violation).
	if _, err := pool.Exec(ctx, insert, secretID, 2, nonce12, "2cf24dba5fb0a30e26e83b2ac5b9e29e",
		secretID+"|2|gen-1", f.userID); err != nil {
		t.Errorf("second version rejected: %v", err)
	}
	for _, bad := range []struct {
		name              string
		version           int
		nonce, ciphertext string
	}{
		{"empty ciphertext", 3, nonce12, ""},
		{"8-byte nonce", 4, strings.Repeat("ab", 8), "2cf24dba5fb0a30e26e83b2ac5b9e29e"},
		{"16-byte nonce", 5, strings.Repeat("ab", 16), "2cf24dba5fb0a30e26e83b2ac5b9e29e"},
	} {
		if _, err := pool.Exec(ctx, insert, secretID, bad.version, bad.nonce, bad.ciphertext,
			secretID+"|"+strconv.Itoa(bad.version)+"|gen-1", f.userID); err == nil {
			t.Errorf("%s: accepted", bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s: code = %s, want 23514", bad.name, code)
		}
	}
	if _, err := pool.Exec(ctx, insert, secretID, 0, nonce12, "2cf24dba5fb0a30e26e83b2ac5b9e29e",
		secretID+"|0|gen-1", f.userID); err == nil {
		t.Error("version 0 accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("version 0 code = %s, want 23514", code)
	}
	// A version is a key into (secret_id, version): a replay of the same pair is
	// a key violation, not an UPDATE of immutable history.
	if _, err := pool.Exec(ctx, insert, secretID, 1, nonce12, "2cf24dba5fb0a30e26e83b2ac5b9e29e",
		secretID+"|1|gen-1", f.userID); err == nil {
		t.Error("duplicate (secret_id, version) accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate version code = %s, want 23505", code)
	}
}

// TestMigrate0004MountShape is contract § 1's named invariant for placement: a
// mount says how a value arrives, exactly one way, into a path git cannot
// mistake for a tracked file. `..`, an absolute path and a `//` are refused by
// constraint before the worker's stricter filesystem check ever runs.
func TestMigrate0004MountShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	var secretID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO secret_metadata (organization_id, project_id, scope, slug, delivery_mode, created_by)
		VALUES ($1, $2, 'project', 'mountable', 'env_file', $3) RETURNING id`,
		f.orgID, f.projectID, f.userID).Scan(&secretID); err != nil {
		t.Fatalf("insert secret metadata: %v", err)
	}

	insert := `
		INSERT INTO secret_mounts (project_id, secret_id, delivery_mode, repository_id, relative_path, env_name)
		VALUES ($1, $2, $3, $4, $5, $6)`
	if _, err := pool.Exec(ctx, insert, f.projectID, secretID, "env_file", f.repoID,
		".env.test.local", nil); err != nil {
		t.Fatalf("legal env_file mount rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, f.projectID, secretID, "env", nil, nil,
		"TEST_DATABASE_URL"); err != nil {
		t.Fatalf("legal env mount rejected: %v", err)
	}

	for _, bad := range []struct {
		name                      string
		mode, repo, path, envName any
	}{
		{"env naming a path", "env", nil, ".env.test.local", "TEST_DATABASE_URL"},
		{"env without a name", "env", nil, nil, nil},
		{"env_file without a repository", "env_file", nil, ".env.test.local", nil},
		{"env_file without a path", "env_file", f.repoID, nil, nil},
		{"env_file with an absolute path", "env_file", f.repoID, "/etc/passwd", nil},
		{"env_file with a traversal", "env_file", f.repoID, "../../etc/x", nil},
		{"env_file with an empty segment", "env_file", f.repoID, ".env//x", nil},
	} {
		if _, err := pool.Exec(ctx, insert, f.projectID, secretID, bad.mode, bad.repo, bad.path, bad.envName); err == nil {
			t.Errorf("%s: accepted", bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("%s: code = %s, want 23514", bad.name, code)
		}
	}

	// integration_broker is declared but not buildable in M3, and placement rows
	// for it are refused outright (ADR-0018 clause 8 puts the refusal in code
	// with a message naming M3's scope; the constraint refuses a *placement*).
	if _, err := pool.Exec(ctx, insert, f.projectID, secretID, "integration_broker", nil, nil, nil); err == nil {
		t.Error("integration_broker mount accepted by mounts_shape")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("integration_broker mount code = %s, want 23514", code)
	}

	// lifecycle accepts the M4 value it must not honour yet, and rejects one
	// nobody named.
	for _, life := range []struct {
		value string
		ok    bool
	}{
		{"turn", true}, {"workspace", true}, {"node_attempt", true}, {"forever", false},
	} {
		_, err := pool.Exec(ctx, `
			INSERT INTO secret_mounts (project_id, secret_id, delivery_mode, env_name, lifecycle)
			VALUES ($1, $2, 'env', 'LIFECYCLE_PROBE', $3)`, f.projectID, secretID, life.value)
		if life.ok && err != nil {
			t.Errorf("lifecycle %q rejected: %v", life.value, err)
		}
		if !life.ok && err == nil {
			t.Errorf("lifecycle %q accepted", life.value)
		}
	}

	// A mount into a repository of another project is refused by FK *identity*:
	// the repository must belong to the project's own set, which the API checks
	// (09). Here we assert the DB does not let a mount point at a foreign row it
	// cannot see — i.e. repository_id is a real FK.
	if _, err := pool.Exec(ctx, insert, f.projectID, secretID, "env_file",
		"00000000-0000-0000-0000-000000000000", ".env.x", nil); err == nil {
		t.Error("mount pointing at a nonexistent repository accepted")
	} else if code := migPgCode(t, err); code != "23503" {
		t.Errorf("foreign repository code = %s, want 23503", code)
	}
}

// TestMigrate0004MaterializationCleanupShape proves the "present only during the
// unit" record cannot be half-written: cleanup is a who+when pair, and the
// uncleaned sweep the worker starts with is index-backed.
func TestMigrate0004MaterializationCleanupShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)
	convID := migM3Conversation(t, ctx, pool, f, "materialization")
	var wsID, secretID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1, $2, 'conversation', $3, $4, 'sha256:' || repeat('1', 64), $5, 'ready', now()) RETURNING id`,
		f.orgID, f.projectID, convID, f.workerID, "/workspaces/conversation/"+convID).
		Scan(&wsID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO secret_metadata (organization_id, project_id, scope, slug, delivery_mode, created_by)
		VALUES ($1, $2, 'project', 'materialized', 'env_file', $3) RETURNING id`,
		f.orgID, f.projectID, f.userID).Scan(&secretID); err != nil {
		t.Fatalf("insert secret metadata: %v", err)
	}

	var turnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1, 'materialize for me', $2) RETURNING id`, convID, f.userID).
		Scan(&turnID); err != nil {
		t.Fatalf("insert turn: %v", err)
	}

	var matID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO secret_materializations
			(secret_id, secret_version, project_id, workspace_id, turn_id, worker_id, delivery_mode, target, file_mode)
		VALUES ($1, 1, $2, $3, $4::uuid, $5, 'env_file', '.env.test.local', 384) RETURNING id`,
		secretID, f.projectID, wsID, turnID, f.workerID).Scan(&matID)
	if err != nil {
		t.Fatalf("insert materialization: %v", err)
	}
	// turn_id is not an FK in M3 (the column exists so M4 does not rename it), so
	// it must at least be uuid-shaped — a text junk value would be unjoinable.
	var isUUID bool
	if err := pool.QueryRow(ctx, `
		SELECT turn_id::text ~ '^[0-9a-f]{8}-' FROM secret_materializations WHERE id = $1`, matID).
		Scan(&isUUID); err != nil {
		t.Fatalf("read materialization turn_id: %v", err)
	}
	if !isUUID {
		t.Error("materialization turn_id is not uuid-shaped")
	}

	if _, err := pool.Exec(ctx, `
		UPDATE secret_materializations SET cleaned_by = 'gardener' WHERE id = $1`, matID); err == nil {
		t.Error("cleaned_by 'gardener' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("unknown cleaned_by code = %s, want 23514", code)
	}
	// The honest path: removed by the unit's own defer, with a timestamp. Note
	// what the schema does NOT say: `cleaned_at` and `cleaned_by` are two columns,
	// so "a cleanup claim names its actor" is a store-layer obligation (the only
	// writers are the three named here), not a CHECK — asserted by the sweep code,
	// not by a constraint, and recorded as such rather than quietly asserted.
	if _, err := pool.Exec(ctx, `
		UPDATE secret_materializations SET cleaned_at = now(), cleaned_by = 'worker' WHERE id = $1`, matID); err != nil {
		t.Errorf("honest cleanup record rejected: %v", err)
	}

	var indexDef string
	if err := pool.QueryRow(ctx, `
		SELECT indexdef FROM pg_indexes
		WHERE tablename = 'secret_materializations' AND indexname = 'secret_materializations_uncleaned_idx'`).
		Scan(&indexDef); err != nil {
		t.Fatalf("uncleaned sweep index missing: %v", err)
	}
	if !strings.Contains(indexDef, "workspace_id") || !strings.Contains(indexDef, "cleaned_at IS NULL") {
		t.Errorf("sweep index = %s, want (workspace_id) WHERE cleaned_at IS NULL", indexDef)
	}
}

// TestMigrate0004ArtifactsShape pins the artifact row that makes case 16 and
// case 12 answerable: a sha256 that is a sha256, no bytes without a state, and
// one row per (project, kind, digest) so a retried Put cannot double-count.
func TestMigrate0004ArtifactsShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)

	digest := strings.Repeat("a", 64)
	insert := `
		INSERT INTO artifacts (organization_id, project_id, name, kind, media_type, sha256,
		                       size_bytes, storage_backend, storage_key, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, 12, 'local', $7, 'worker')`
	key := "projects/" + f.projectID + "/html/aa/report.html"
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "report.html", "html",
		"text/html", digest, key); err != nil {
		t.Fatalf("legal artifact rejected: %v", err)
	}
	// Same bytes again = same row: the retry path ADR-0020 D2 depends on.
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "report.html", "html",
		"text/html", digest, key); err == nil {
		t.Error("duplicate (project_id, kind, sha256) accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate artifact code = %s, want 23505", code)
	}
	// Another kind is another artifact of the same bytes (a checkpoint companion
	// object and its manifest), so the UNIQUE is not (project, digest).
	if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "manifest.json", "json",
		"application/json", digest, "projects/x/json/aa/manifest.json"); err != nil {
		t.Errorf("same digest under another kind rejected: %v", err)
	}

	for _, bad := range []struct{ name, sha string }{
		{"uppercase hex", strings.Repeat("A", 64)},
		{"short hex", strings.Repeat("a", 63)},
		{"non hex", strings.Repeat("z", 64)},
	} {
		if _, err := pool.Exec(ctx, insert, f.orgID, f.projectID, "x.md", "markdown",
			"text/markdown", bad.sha, "k"); err == nil {
			t.Errorf("artifacts.sha256 %s accepted", bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("artifacts.sha256 %s code = %s, want 23514", bad.name, code)
		}
	}

	// A `ready` artifact must be the fenced transaction's work; the default state
	// is `uploading` precisely so a row written without that transaction is a
	// sweep target, never a served object.
	var state string
	var redaction int
	if err := pool.QueryRow(ctx, `
		SELECT state, redaction_count FROM artifacts
		WHERE project_id = $1 AND name = 'report.html'`, f.projectID).Scan(&state, &redaction); err != nil {
		t.Fatalf("read artifact state: %v", err)
	}
	if state != "uploading" {
		t.Errorf("new artifact state = %q, want uploading (no route serves bytes for it until a fenced Put flips it)", state)
	}
	if redaction != 0 {
		t.Errorf("redaction_count = %d, want 0 (ADR-0020 gate 5: a legitimately clean artifact counts nothing)", redaction)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE artifacts SET state = 'published' WHERE project_id = $1 AND name = 'report.html'`,
		f.projectID); err == nil {
		t.Error("artifact state 'published' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("artifact state code = %s, want 23514", code)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE artifacts SET size_bytes = -1 WHERE project_id = $1 AND name = 'report.html'`,
		f.projectID); err == nil {
		t.Error("negative size_bytes accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("negative size_bytes code = %s, want 23514", code)
	}
	// 'secret' exists in the enum so the label is available before the policy
	// that fills it — and M3 gives it no download path (ADR-0020 D3).
	if _, err := pool.Exec(ctx, `
		UPDATE artifacts SET sensitivity = 'secret' WHERE project_id = $1 AND name = 'report.html'`,
		f.projectID); err != nil {
		t.Errorf("sensitivity 'secret' rejected: %v", err)
	}

	// The three scans the reconciler and the retention pass need exist.
	for _, idx := range []struct{ name, want string }{
		{"artifacts_sweep_idx", "state = 'uploading'"},
		{"artifacts_expiry_idx", "expires_at"},
		{"artifacts_sha256_idx", "sha256"},
	} {
		var def string
		if err := pool.QueryRow(ctx, `
			SELECT indexdef FROM pg_indexes WHERE tablename = 'artifacts' AND indexname = $1`,
			idx.name).Scan(&def); err != nil {
			t.Errorf("%s missing: %v", idx.name, err)
			continue
		}
		if !strings.Contains(def, idx.want) {
			t.Errorf("%s = %s, want it to cover %s", idx.name, def, idx.want)
		}
	}
}

// TestMigrate0004AgentProfileColumns checks the M3 profile axes arrived with
// fail-closed defaults: workspace_mode worktree, sandbox_enforcement required,
// commit not granted, no APM lock, and no mounts. A default that read "permissive"
// would make the whole milestone's honesty claim depend on a missed UPDATE.
func TestMigrate0004AgentProfileColumns(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := migM3FixtureFor(t, ctx, pool)

	var workspaceMode, enforcement, apmTarget, apmDigest, pkgRef *string
	var commitGranted bool
	var mounts []string
	err = pool.QueryRow(ctx, `
		SELECT workspace_mode, sandbox_enforcement, commit_granted, apm_package_ref,
		       apm_target, apm_lock_digest, secret_mount_ids
		FROM agent_profiles WHERE id = $1`, f.profileID).
		Scan(&workspaceMode, &enforcement, &commitGranted, &pkgRef, &apmTarget, &apmDigest, &mounts)
	if err != nil {
		t.Fatalf("read seeded profile's M3 columns: %v", err)
	}
	if workspaceMode == nil || *workspaceMode != "worktree" {
		t.Errorf("workspace_mode = %v, want worktree (D-008)", workspaceMode)
	}
	if enforcement == nil || *enforcement != "required" {
		t.Errorf("sandbox_enforcement = %v, want required", enforcement)
	}
	if commitGranted {
		t.Error("commit_granted = true by default, want false (the grant is a decision, ADR-0017 D4)")
	}
	if pkgRef != nil || apmTarget != nil || apmDigest != nil {
		t.Errorf("APM columns preset on a seeded profile: %v/%v/%v, want all NULL", pkgRef, apmTarget, apmDigest)
	}
	if len(mounts) != 0 {
		t.Errorf("secret_mount_ids = %v, want empty", mounts)
	}

	for _, bad := range []struct{ name, digest string }{
		{"bare hex", strings.Repeat("f", 64)},
		{"wrong prefix", "sha512:" + strings.Repeat("f", 64)},
		{"short digest", "sha256:" + strings.Repeat("f", 63)},
	} {
		if _, err := pool.Exec(ctx,
			"UPDATE agent_profiles SET apm_lock_digest = $2 WHERE id = $1", f.profileID, bad.digest); err == nil {
			t.Errorf("apm_lock_digest %s accepted (%s)", bad.digest, bad.name)
			continue
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("apm_lock_digest %s code = %s, want 23514", bad.name, code)
		}
	}
	if _, err := pool.Exec(ctx, `
		UPDATE agent_profiles SET apm_lock_digest = $2, apm_target = 'claude' WHERE id = $1`,
		f.profileID, "sha256:"+strings.Repeat("f", 64)); err != nil {
		t.Errorf("legal apm_lock_digest rejected: %v", err)
	}
	if _, err := pool.Exec(ctx,
		"UPDATE agent_profiles SET apm_target = 'cursor' WHERE id = $1", f.profileID); err == nil {
		t.Error("apm_target 'cursor' accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("apm_target code = %s, want 23514", code)
	}
	// NULL stays legal: a profile that stages no APM package must not invent one.
	if _, err := pool.Exec(ctx,
		"UPDATE agent_profiles SET apm_lock_digest = NULL, apm_target = NULL WHERE id = $1", f.profileID); err != nil {
		t.Errorf("NULL apm_lock_digest rejected: %v", err)
	}
	// The seeded profiles still refuse every prompt: M3 added sandbox columns,
	// it did not unlock permission_mode (ADR-0016 § 10 gates that on an observed
	// Verified=true launch, which no test has produced yet).
	var permissionMode string
	if err := pool.QueryRow(ctx,
		"SELECT permission_mode FROM agent_profiles WHERE id = $1", f.profileID).Scan(&permissionMode); err != nil {
		t.Fatalf("read permission_mode: %v", err)
	}
	if permissionMode != "ask" {
		t.Errorf("seeded profile permission_mode = %q, want ask", permissionMode)
	}
}

// genUUID returns a fresh uuid for the columns M4 will own (run ids, attempt
// ids), which must be legal today and unpopulated by M3 code. Generated here
// rather than by gen_random_uuid() so a test never needs a connection just to
// name a placeholder scope.
func genUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
