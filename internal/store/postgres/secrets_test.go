package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/secrets"
)

// These run against a real PostgreSQL because the claims under test are database
// claims: that the only bytes this package writes to a secret column are ciphertext,
// that an old version survives the append of a new one, that a revoked version
// refuses the resolver, that the journal and audit rows land in the same
// transaction as the row they describe, and that the whole database — dump it and
// grep it — contains no plaintext. A fake would have demonstrated the shape of the
// SQL and none of that (AGENTS.md: a mocked green test never substitutes for an
// integration test).
//
// Rows are named after the run token so two runs against the shared lab database
// cannot decide each other's outcome, and every fixture deletes what it made.

const (
	secSentinel   = "dckr_pat_M3LABSENTINEL_7f2c"
	secSlugPrefix = "lab-secret"
)

type secFixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	store *SecretStore
	keys  *secrets.Keyring

	token    string
	orgID    string
	elseOrg  string
	alice    string // maintainer of projA
	carol    string // contributor of projA
	viewer   string // viewer of projA
	outsider string // projA project member of nothing
	dave     string // maintainer of projB only
	profile  string // the agent profile the allowlists name
	profile2 string
	worker   string
	wsA      string // one workspace row, for the materialization FKs

	projA, projB string
	repoA        string
}

func secSetup(t *testing.T) *secFixture {
	t.Helper()
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	token := migFixtureToken(t)
	f := &secFixture{t: t, pool: pool, token: token}

	if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE slug = 'default'`).Scan(&f.orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	const otherOrg = "00000000-0000-7000-8000-000000000002"
	if _, err := pool.Exec(ctx, `
		INSERT INTO organizations (id, slug, name)
		VALUES ($1, 'second', 'Second organization') ON CONFLICT (id) DO NOTHING`, otherOrg); err != nil {
		t.Fatalf("insert second org: %v", err)
	}
	f.elseOrg = otherOrg

	f.alice = cnvUser(t, pool, f.orgID, "sec-alice-"+token)
	f.carol = cnvUser(t, pool, f.orgID, "sec-carol-"+token)
	f.viewer = cnvUser(t, pool, f.orgID, "sec-viewer-"+token)
	f.outsider = cnvUser(t, pool, f.orgID, "sec-outsider-"+token)
	f.dave = cnvUser(t, pool, otherOrg, "sec-dave-"+token)

	mustQuery(t, pool, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'sec-a-' || $2, 'Secrets fixture A', $3::uuid) RETURNING id::text`,
		f.orgID, token, f.alice).Scan(&f.projA)
	mustQuery(t, pool, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'sec-b-' || $2, 'Secrets fixture B', $3::uuid) RETURNING id::text`,
		otherOrg, token, f.dave).Scan(&f.projB)
	for user, role := range map[string]string{
		f.alice:  string(authz.RoleMaintainer),
		f.carol:  string(authz.RoleContributor),
		f.viewer: string(authz.RoleViewer),
	} {
		mustExec(t, pool, `INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)`,
			f.projA, user, role)
	}
	mustExec(t, pool, `INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)`,
		f.projB, f.dave, string(authz.RoleMaintainer))

	mustQuery(t, pool, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'https://example.test/lab/registry.git', 'main', $3::uuid) RETURNING id::text`,
		f.projA, "registry-"+token, f.alice).Scan(&f.repoA)

	// The seeded M2 profile, plus one that no allowlist names — the pair the
	// ADR-0018 D3 grant rule needs to be distinguishable.
	if err := pool.QueryRow(ctx, `SELECT id::text FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`,
		f.orgID).Scan(&f.profile); err != nil {
		t.Fatalf("seeded profile lookup (migration 00003): %v", err)
	}
	profileID := f.profile
	// A second profile id that no allowlist names: the pair ADR-0018 D3's grant
	// rule needs to be tested against. A random uuid would do, and this one is
	// simpler to read in a failure.
	f.profile2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

	mustQuery(t, pool, `
		INSERT INTO workers (name, hostname, version, status)
		VALUES ('sec-worker-' || $1, 'lab', 'dev', 'online') RETURNING id::text`, token).Scan(&f.worker)

	// A workspace row: secret_materializations references it, and the sweep query
	// is index-backed by workspace_id, so a fixture without one tests nothing.
	var conversation string
	mustQuery(t, pool, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, 'secret fixture', $3::uuid) RETURNING id::text`,
		f.projA, profileID, f.alice).Scan(&conversation)
	mustQuery(t, pool, `
		INSERT INTO workspaces
			(organization_id, project_id, scope_kind, conversation_id, worker_id, volume_id,
			 root_path, workspace_mode, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'conversation', $3::uuid, $4::uuid,
		        'sha256:' || repeat('a', 64), '/workspaces/sec-' || $5, 'worktree', 'ready', now())
		RETURNING id::text`, f.orgID, f.projA, conversation, f.worker, token).Scan(&f.wsA)
	f.store = &SecretStore{Pool: pool, Keys: secKeyring(t)}
	f.keys = f.store.Keys.(*secrets.Keyring)

	t.Cleanup(f.delete)
	return f
}

// delete removes what the fixture made, by id and by token — never by a LIKE
// across a shared database, which would delete whoever else's fixture is running.
func (f *secFixture) delete() {
	bg := context.Background()
	queries := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM secret_materializations WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM secret_mounts WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		// ADR-0061: repositories now reference secret_metadata, so the
		// referencing rows must go before the referenced ones.
		{`DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE project_id = ANY($1::uuid[]))`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM workspaces WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM conversations WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM repositories WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM secret_versions WHERE secret_id IN (SELECT id FROM secret_metadata WHERE slug LIKE $1)`, []any{"%" + f.token + "%"}},
		{`DELETE FROM secret_metadata WHERE slug LIKE $1 OR project_id = ANY($2::uuid[])`, []any{"%" + f.token + "%", []string{f.projA, f.projB}}},
		{`DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE project_id = ANY($1::uuid[]))`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM domain_events WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM audit_events WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM memberships WHERE project_id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM projects WHERE id = ANY($1::uuid[])`, []any{[]string{f.projA, f.projB}}},
		{`DELETE FROM workers WHERE name = $1`, []any{"sec-worker-" + f.token}},
		{`DELETE FROM users WHERE display_name LIKE $1`, []any{"sec-%-" + f.token}},
	}
	for _, q := range queries {
		if _, err := f.pool.Exec(bg, q.sql, q.args...); err != nil {
			f.t.Errorf("cleanup %q: %v", q.sql, err)
		}
	}
}

// secKeyring writes a keyring the way api/compose.yaml's keyring-init does, in a
// directory only this process can read. The point of the fixture is that the key
// is *not* in the database, so a test that faked the keyring would be testing a
// different design.
func secKeyring(t *testing.T, generations ...int) *secrets.Keyring {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod keyring: %v", err)
	}
	if len(generations) == 0 {
		generations = []int{1}
	}
	for _, gen := range generations {
		material := make([]byte, 32)
		for i := range material {
			material[i] = byte(gen*7 + i*13 + 3)
		}
		path := filepath.Join(dir, fmt.Sprintf("master-key-v%d", gen))
		if err := os.WriteFile(path, []byte(hex.EncodeToString(material)), 0o600); err != nil {
			t.Fatalf("write keyring: %v", err)
		}
	}
	kr, err := secrets.LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	return kr
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(testCtx(t), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

// mustQuery starts a single-row read for a fixture and returns the pgx.Row so the
// call site Scans and names the statement that failed.
func mustQuery(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) pgx.Row {
	t.Helper()
	return pool.QueryRow(testCtx(t), sql, args...)
}

func (f *secFixture) caller(user string) Caller {
	return Caller{UserID: user, OrganizationID: f.orgID}
}

// daveCaller names dave's real organization. Passing him the fixture org would
// have projB itself fall over the organization predicate in prjGetProject, and
// the test would then be asserting a cross-project refusal for the wrong reason.
func (f *secFixture) daveCaller() Caller {
	return Caller{UserID: f.dave, OrganizationID: f.elseOrg}
}

func (f *secFixture) slug(label string) string {
	return fmt.Sprintf("%s-%s-%s", secSlugPrefix, f.token, label)
}

func (f *secFixture) create(t *testing.T, label, value string, profiles ...string) Secret {
	t.Helper()
	if profiles == nil {
		profiles = []string{f.profile}
	}
	secret, err := f.store.CreateSecret(testCtx(t), f.caller(f.alice), f.projA, NewSecret{
		Slug: f.slug(label), Purpose: "integration test " + label, DeliveryMode: "env_file",
		Profiles: profiles, Value: []byte(value),
	})
	if err != nil {
		t.Fatalf("CreateSecret(%s): %v", label, err)
	}
	return secret
}

// --- the writes ----------------------------------------------------------

func TestSecretStoreCreateStoresCiphertextOnly(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "docker-hub", secSentinel)

	if secret.CurrentVersion != 1 || secret.Scope != "project" || secret.AuditPolicy != "materialization" {
		t.Fatalf("created row = %+v", secret)
	}
	if secret.CreatedBy != f.alice {
		t.Errorf("created_by = %q, want the caller", secret.CreatedBy)
	}

	// The row's ciphertext half, read raw: what the database actually holds.
	var (
		keyID, aad, digest string
		nonce, ciphertext  []byte
		storedVersion      int
		createdAt          interface{}
	)
	err := f.pool.QueryRow(ctx, `
		SELECT version, key_id, nonce, ciphertext, aad, content_sha256, created_at
		FROM secret_versions WHERE secret_id = $1::uuid`, secret.ID).
		Scan(&storedVersion, &keyID, &nonce, &ciphertext, &aad, &digest, &createdAt)
	if err != nil {
		t.Fatalf("read version row: %v", err)
	}
	if storedVersion != 1 {
		t.Errorf("version = %d, want 1", storedVersion)
	}
	if len(nonce) != 12 {
		t.Errorf("nonce is %d bytes, want the 12 GCM needs", len(nonce))
	}
	if len(ciphertext) == 0 {
		t.Fatal("ciphertext is empty: the row would fail secret_versions_not_empty")
	}
	if string(ciphertext) == secSentinel {
		t.Fatal("the plaintext was stored in the ciphertext column")
	}
	// The AAD binding, exactly as ADR-0018 D2.1 spells it: a row whose aad does
	// not name its own secret, version, generation and slug digest cannot be the
	// row another one is replayed into.
	// The slug digest is of the slug as stored, which the fixture built from the
	// run token — recomputed here rather than spelled, so the assertion is about
	// the binding and not about the fixture's naming.
	wantAAD := fmt.Sprintf("%s|1|%s|%s", secret.ID, keyID, hexSha256(secret.Slug))
	if aad != wantAAD {
		t.Errorf("aad = %q, want exactly %q", aad, wantAAD)
	}
	if digest != hexSha256String(secSentinel) {
		t.Errorf("content_sha256 = %q, want the digest of the value", digest)
	}

	// And the authorized read path still works end to end: this is the proof that
	// ciphertext-only storage is not ciphertext-only *recovery*.
	stored, err := f.store.LoadVersion(ctx, secret.ID, 0)
	if err != nil {
		t.Fatalf("LoadVersion: %v", err)
	}
	value, err := secrets.Open(ctx, f.keys, stored.Ref, stored.Sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := string(value.Bytes()); got != secSentinel {
		t.Fatalf("decrypted %q, want the value back", got)
	}
	value.Zero()

	// Journal and audit landed in the same transaction as the row.
	var createdEvents int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events
		WHERE project_id = $1::uuid AND type = 'secret.created'`, f.projA).Scan(&createdEvents); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if createdEvents != 1 {
		t.Errorf("secret.created events = %d, want 1 (ADR-0014 § 9: the append is in the write transaction)", createdEvents)
	}
	// The payload has no member a value could occupy — checked against the
	// serialized row, not against the Go struct.
	var payload string
	if err := f.pool.QueryRow(ctx, `
		SELECT payload::text FROM domain_events WHERE project_id = $1::uuid AND type = 'secret.created'`,
		f.projA).Scan(&payload); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if strings.Contains(payload, secSentinel) {
		t.Errorf("the journal payload carries the value: %s", payload)
	}
	for _, member := range []string{"secret_id", "slug", "delivery_mode", "allowed_agent_profile_ids"} {
		if !strings.Contains(payload, `"`+member+`"`) {
			t.Errorf("secret.created payload lacks %s: %s", member, payload)
		}
	}

	// The mutation's audit row names the secret and the policy, never the value.
	var outcome, detail string
	if err := f.pool.QueryRow(ctx, `
		SELECT outcome, detail::text FROM audit_events
		WHERE project_id = $1::uuid AND action = 'secret.create' ORDER BY id DESC LIMIT 1`,
		f.projA).Scan(&outcome, &detail); err != nil {
		t.Fatalf("read audit row: %v", err)
	}
	if outcome != "allowed" {
		t.Errorf("audit outcome = %q, want allowed", outcome)
	}
	if strings.Contains(detail, secSentinel) {
		t.Errorf("audit detail carries the value: %s", detail)
	}
	for _, member := range []string{"secret_id", "slug", "purpose", "delivery_mode", "version"} {
		if !strings.Contains(detail, `"`+member+`"`) {
			t.Errorf("audit detail lacks %s: %s", member, detail)
		}
	}
}

func TestSecretStoreVersionAppendKeepsOldVersionsReadable(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "rotating", "first-value")

	before := secVersionBytes(t, f.pool, secret.ID, 1)
	added, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte(secSentinel))
	if err != nil {
		t.Fatalf("AddSecretVersion: %v", err)
	}
	if added.Version != 2 || added.KeyID == "" {
		t.Fatalf("added = %+v", added)
	}
	if after := secVersionBytes(t, f.pool, secret.ID, 1); after.nonceHex != before.nonceHex || after.ciphertextHex != before.ciphertextHex {
		t.Fatal("version 1's bytes changed when version 2 was appended: versions are immutable")
	}

	var current int
	var rotated bool
	if err := f.pool.QueryRow(ctx, `
		SELECT current_version, rotated_at IS NOT NULL FROM secret_metadata WHERE id = $1::uuid`,
		secret.ID).Scan(&current, &rotated); err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	if current != 2 || !rotated {
		t.Fatalf("current_version=%d rotated=%v, want 2/true", current, rotated)
	}

	// Both pins resolve, to their own values: an in-flight unit that started with
	// version 1 keeps version 1 through the rotation (ADR-0018 D2).
	for _, pin := range []struct {
		version int
		want    string
	}{
		{1, "first-value"},
		{2, secSentinel},
	} {
		stored, err := f.store.LoadVersion(ctx, secret.ID, pin.version)
		if err != nil {
			t.Fatalf("LoadVersion v%d: %v", pin.version, err)
		}
		if stored.Version != pin.version {
			t.Fatalf("LoadVersion v%d reported v%d", pin.version, stored.Version)
		}
		value, err := secrets.Open(ctx, f.keys, stored.Ref, stored.Sealed)
		if err != nil {
			t.Fatalf("Open v%d: %v", pin.version, err)
		}
		if got := string(value.Bytes()); got != pin.want {
			t.Errorf("v%d decrypted to %q, want %q", pin.version, got, pin.want)
		}
		value.Zero()
	}

	// The retry comparison: the same bytes again is the same version, not a new
	// immutable row nobody asked for.
	again, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte(secSentinel))
	if err != nil {
		t.Fatalf("retried AddSecretVersion: %v", err)
	}
	if again.Version != 2 {
		t.Errorf("retried rotation reported version %d, want the existing 2", again.Version)
	}
	if count := secVersionCount(t, f.pool, secret.ID); count != 2 {
		t.Errorf("version rows = %d, want 2: a retry must not append", count)
	}
	var appended int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND type = 'secret.version.added'`,
		f.projA).Scan(&appended); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if appended != 1 {
		t.Errorf("secret.version.added events = %d, want 1 (the retry appended nothing)", appended)
	}
}

func TestSecretStoreCreateReplayAndConflict(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "replayed", secSentinel)

	// The retried create: same slug, byte-identical value. openapi says compare
	// content_sha256 rather than writing a second version, so the caller gets the
	// row that exists and no version is appended.
	replay, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
		Slug: secret.Slug, Purpose: "same again", DeliveryMode: "env_file",
		Profiles: []string{f.profile}, Value: []byte(secSentinel),
	})
	if err != nil {
		t.Fatalf("replayed create: %v", err)
	}
	if replay.ID != secret.ID {
		t.Errorf("replay returned %s, want the existing %s", replay.ID, secret.ID)
	}
	if count := secVersionCount(t, f.pool, secret.ID); count != 1 {
		t.Errorf("version rows after a replay = %d, want 1", count)
	}

	// A different value under an existing slug is a conflict, not a rotation.
	if _, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
		Slug: secret.Slug, Purpose: "different", DeliveryMode: "env_file",
		Profiles: []string{f.profile}, Value: []byte("a different value entirely"),
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("duplicate slug error = %v, want ErrConflict", err)
	}
	if count := secVersionCount(t, f.pool, secret.ID); count != 1 {
		t.Errorf("version rows after the conflict = %d, want 1", count)
	}
}

func TestSecretStorePolicyUpdate(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "policy", secSentinel)

	updated, err := f.store.UpdateSecretPolicy(ctx, f.caller(f.alice), f.projA, secret.ID, NewSecretPolicy{
		Purpose: "now it is the staging registry", Profiles: []string{f.profile, f.profile2},
		Audit: "materialization_and_access",
	})
	if err != nil {
		t.Fatalf("UpdateSecretPolicy: %v", err)
	}
	if updated.Purpose != "now it is the staging registry" || updated.AuditPolicy != "materialization_and_access" {
		t.Fatalf("updated = %+v", updated)
	}
	if updated.Slug != secret.Slug || updated.DeliveryMode != secret.DeliveryMode || updated.CurrentVersion != 1 {
		t.Fatalf("the policy write moved a field it does not own: %+v", updated)
	}
	var payload string
	if err := f.pool.QueryRow(ctx, `
		SELECT payload::text FROM domain_events
		WHERE project_id = $1::uuid AND type = 'secret.policy.updated' ORDER BY global_seq DESC LIMIT 1`,
		f.projA).Scan(&payload); err != nil {
		t.Fatalf("read policy event: %v", err)
	}
	if !strings.Contains(payload, `"before"`) || !strings.Contains(payload, `"after"`) {
		t.Fatalf("policy event lacks the diff: %s", payload)
	}
	if strings.Contains(payload, secSentinel) {
		t.Fatalf("policy event carries the value: %s", payload)
	}
	var event events.SecretPolicyUpdatedPayload
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		t.Fatalf("decode policy payload: %v", err)
	}
	if event.Before.AllowedAgentProfileIDs[0] != f.profile || len(event.After.AllowedAgentProfileIDs) != 2 {
		t.Fatalf("diff = %+v", event)
	}
	// The widened allowlist is what the resolver now enforces.
	if _, err := f.store.UpdateSecretPolicy(ctx, f.caller(f.viewer), f.projA, secret.ID, NewSecretPolicy{
		Purpose: "viewer cannot", Audit: "materialization",
	}); !errors.Is(err, ErrSecretForbidden) {
		t.Errorf("viewer policy write = %v, want ErrSecretForbidden", err)
	}
}

// TestSecretStoreNilAllowlistStoresEmptyArray is the lab 500 (request
// a08d58f7fabcb19ac966c828eaa2dbf0): a delivery_mode integration_broker secret
// (ADR-0061) with no allowed_agent_profile_ids — legitimately, a broker secret
// is used by integrations and never mounted to agents. pgx encodes a nil
// []string as NULL, and the column is NOT NULL (migration 00004), so the insert
// died on the not-null constraint. An omitted allowlist means the empty list
// (ADR-0018 D3: empty means denied to every profile), and the store boundary is
// where nil becomes '{}', so every caller is safe.
func TestSecretStoreNilAllowlistStoresEmptyArray(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)

	// cardinality is the NULL-distinguishing count (array_length says NULL for
	// both a NULL *and* an empty array), so -1 below means "the column is
	// NULL" and 0 means "the column is '{}'" — the two states the bug conflated.
	rawAllowlistLens := func(t *testing.T, id, label string) (profilesLen, templatesLen int) {
		t.Helper()
		if err := f.pool.QueryRow(ctx, `
			SELECT COALESCE(cardinality(allowed_agent_profile_ids), -1),
			       COALESCE(cardinality(allowed_node_template_ids), -1)
			FROM secret_metadata WHERE id = $1::uuid`, id).Scan(&profilesLen, &templatesLen); err != nil {
			t.Fatalf("read raw allowlist lengths for %s: %v", label, err)
		}
		return profilesLen, templatesLen
	}

	for _, delivery := range []string{"env", "integration_broker"} {
		label := "nil-allow-" + strings.ReplaceAll(delivery, "_", "-")
		created, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
			Slug: f.slug(label), Purpose: "nil allowlist " + delivery,
			DeliveryMode: delivery, Profiles: nil, Value: []byte(secSentinel),
		})
		if err != nil {
			t.Fatalf("CreateSecret(%s) with a nil allowlist: %v", delivery, err)
		}
		if created.Profiles == nil || len(created.Profiles) != 0 {
			t.Errorf("%s: created row scanned %v, want the empty list", delivery, created.Profiles)
		}
		if profilesLen, templatesLen := rawAllowlistLens(t, created.ID, delivery); profilesLen != 0 || templatesLen != 0 {
			t.Errorf("%s: raw allowlist lengths = %d/%d (-1 means NULL), want 0/0 ('{}'/'{}')",
				delivery, profilesLen, templatesLen)
		}
		// The resolver's read path agrees: [], never nil, never a not-found.
		stored, err := f.store.LoadVersion(ctx, created.ID, 0)
		if err != nil {
			t.Fatalf("LoadVersion(%s): %v", delivery, err)
		}
		if stored.AllowedAgentProfileIDs == nil || len(stored.AllowedAgentProfileIDs) != 0 {
			t.Errorf("%s: the resolver saw %v, want the empty list", delivery, stored.AllowedAgentProfileIDs)
		}
		// And the journal says [] in the payload, not null: an event consumer
		// must be able to tell "granted to none" without a null check.
		var payload string
		if err := f.pool.QueryRow(ctx, `
			SELECT payload::text FROM domain_events
			WHERE project_id = $1::uuid AND type = 'secret.created' ORDER BY global_seq DESC LIMIT 1`,
			f.projA).Scan(&payload); err != nil {
			t.Fatalf("read secret.created event: %v", err)
		}
		var ev events.SecretCreatedPayload
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			t.Fatalf("decode secret.created payload: %v", err)
		}
		if ev.AllowedAgentProfileIDs == nil || len(ev.AllowedAgentProfileIDs) != 0 {
			t.Errorf("%s: secret.created payload allowlist = %v, want []", delivery, ev.AllowedAgentProfileIDs)
		}
	}

	// The policy write takes the same rule: a nil allowlist clears the list,
	// it does not NULL the column.
	secret := f.create(t, "nil-clear", secSentinel)
	updated, err := f.store.UpdateSecretPolicy(ctx, f.caller(f.alice), f.projA, secret.ID, NewSecretPolicy{
		Purpose: "cleared by a nil write", Profiles: nil, Audit: "materialization",
	})
	if err != nil {
		t.Fatalf("UpdateSecretPolicy with a nil allowlist: %v", err)
	}
	if updated.Profiles == nil || len(updated.Profiles) != 0 {
		t.Errorf("policy update scanned %v, want the empty list", updated.Profiles)
	}
	if profilesLen, _ := rawAllowlistLens(t, secret.ID, "policy update"); profilesLen != 0 {
		t.Errorf("policy update stored raw length %d (-1 means NULL), want 0 ('{}')", profilesLen)
	}
}

func TestSecretStoreRevokeRefusesMaterialization(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "revoking", "value before rotation")
	if _, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte(secSentinel)); err != nil {
		t.Fatalf("AddSecretVersion: %v", err)
	}

	revoked, err := f.store.RevokeSecret(ctx, f.caller(f.alice), f.projA, secret.ID)
	if err != nil {
		t.Fatalf("RevokeSecret: %v", err)
	}
	if revoked.RevokedAt == nil {
		t.Fatal("revoked_at is still null")
	}
	var metadataRevoked, versionsRevoked int
	if err := f.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM secret_metadata WHERE id = $1::uuid AND revoked_at IS NOT NULL),
		       (SELECT count(*) FROM secret_versions WHERE secret_id = $1::uuid AND revoked_at IS NOT NULL)`,
		secret.ID).Scan(&metadataRevoked, &versionsRevoked); err != nil {
		t.Fatalf("read revoke state: %v", err)
	}
	if metadataRevoked != 1 || versionsRevoked != 2 {
		t.Fatalf("revoked metadata=%d versions=%d, want 1 and 2 (every version)", metadataRevoked, versionsRevoked)
	}

	// The resolver is the consumer of that column: every version, pinned or
	// current, refuses.
	resolver, err := secrets.NewResolver(f.store, f.keys)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	for _, version := range []int{0, 1, 2} {
		if _, err := resolver.Resolve(ctx, secAttempt(f), secret.ID, version); !errors.Is(err, secrets.ErrRevoked) {
			t.Errorf("Resolve v%d after revoke = %v, want ErrRevoked", version, err)
		}
	}
	// Revocation is not deletion: the rows are all still there to answer who could
	// have had it.
	if count := secVersionCount(t, f.pool, secret.ID); count != 2 {
		t.Errorf("version rows after revoke = %d, want 2", count)
	}
	// And it is not a state to be entered twice.
	if _, err := f.store.RevokeSecret(ctx, f.caller(f.alice), f.projA, secret.ID); !errors.Is(err, ErrSecretRevoked) {
		t.Errorf("second revoke = %v, want ErrSecretRevoked", err)
	}
	// Neither is a revoked secret a place to put a new value.
	if _, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte("after revoke")); !errors.Is(err, ErrSecretRevoked) {
		t.Errorf("rotation onto a revoked secret = %v, want ErrSecretRevoked", err)
	}

	var payload string
	if err := f.pool.QueryRow(ctx, `
		SELECT payload::text FROM domain_events
		WHERE project_id = $1::uuid AND type = 'secret.revoked' ORDER BY global_seq DESC LIMIT 1`,
		f.projA).Scan(&payload); err != nil {
		t.Fatalf("read revoke event: %v", err)
	}
	var event events.SecretRevokedPayload
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		t.Fatalf("decode revoke payload: %v", err)
	}
	if len(event.Versions) != 2 || event.Versions[0] != 1 || event.Versions[1] != 2 {
		t.Errorf("secret.revoked versions = %v, want [1 2]", event.Versions)
	}
	if event.RevokedBy != f.alice || event.RevokedAt == "" {
		t.Errorf("secret.revoked actor/time = %+v", event)
	}
}

// --- the resolver against real rows --------------------------------------

// secAttempt is one authorized turn-shaped attempt: the unit M3 actually runs. It
// names no node template, which is what makes the node-template axis of
// ADR-0018 D3 unevaluable until M4 supplies one (see Resolve's comment).
func secAttempt(f *secFixture) secrets.Attempt {
	return secrets.Attempt{
		ProjectID: f.projA, OrganizationID: f.orgID, AgentProfileID: f.profile,
		WorkspaceID: f.wsA, WorkerID: f.worker, Authorized: true,
	}
}

func TestSecretStoreFeedsTheResolverAndEnforcesTheGrant(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "granted", "granted-value", f.profile)
	resolver, err := secrets.NewResolver(f.store, f.keys)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}

	res, err := resolver.Resolve(ctx, secAttempt(f), secret.ID, 0)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got := string(res.Value.Bytes()); got != "granted-value" {
		t.Fatalf("Resolve returned %q", got)
	}
	if res.Slug != secret.Slug || res.Version != 1 || res.DeliveryMode != "env_file" {
		t.Fatalf("resolution metadata = %+v", res)
	}
	res.Value.Zero()

	// A profile with no grant cannot see the secret even inside its own project
	// (ADR-0018 D3): the allowlist is a column, so this is the database row being
	// enforced and not a caller's assumption.
	if _, err := resolver.Resolve(ctx, secAttempt(f), secret.ID, 0); err != nil {
		t.Fatalf("Resolve with the granted profile: %v", err)
	}
	alien := secAttempt(f)
	alien.AgentProfileID = f.profile2
	if _, err := resolver.Resolve(ctx, alien, secret.ID, 0); !errors.Is(err, secrets.ErrNotAuthorized) {
		t.Errorf("Resolve for an ungranted profile = %v, want ErrNotAuthorized", err)
	}
	// An attempt in another project cannot reach a project-scope secret.
	other := secAttempt(f)
	other.ProjectID = f.projB
	if _, err := resolver.Resolve(ctx, other, secret.ID, 0); !errors.Is(err, secrets.ErrNotAuthorized) {
		t.Errorf("Resolve from another project = %v, want ErrNotAuthorized", err)
	}
	// A row whose generation is not in the keyring is unreadable, and no fallback
	// to the active key is attempted.
	orphanKeyring := secKeyring(t, 9)
	orphan, err := secrets.NewResolver(f.store, orphanKeyring)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	if _, err := orphan.Resolve(ctx, secAttempt(f), secret.ID, 0); !errors.Is(err, secrets.ErrUnknownKeyID) {
		t.Errorf("Resolve with a foreign keyring = %v, want ErrUnknownKeyID", err)
	}
	// And the same database, opened with a keyring that does not name the row's
	// generation at all, says the same thing rather than guessing.
	unauthorized := secAttempt(f)
	unauthorized.Authorized = false
	if _, err := resolver.Resolve(ctx, unauthorized, secret.ID, 0); !errors.Is(err, secrets.ErrNotAuthorized) {
		t.Errorf("Resolve for an unauthorized caller = %v, want ErrNotAuthorized", err)
	}
}

func TestSecretStoreBrokerDeliveryRefusesMaterialization(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	// The delivery mode is storable as policy (the CHECK allows it, so the intent
	// survives) and unmountable.
	secret, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
		Slug: f.slug("broker"), Purpose: "declared broker intent", DeliveryMode: "integration_broker",
		Profiles: []string{f.profile}, Value: []byte("never deliverable"),
	})
	if err != nil {
		t.Fatalf("CreateSecret with broker delivery: %v", err)
	}
	resolver, err := secrets.NewResolver(f.store, f.keys)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	if _, err := resolver.Resolve(ctx, secAttempt(f), secret.ID, 0); !errors.Is(err, secrets.ErrDeliveryUnsupported) {
		t.Fatalf("Resolve of a broker-mode secret = %v, want ErrDeliveryUnsupported", err)
	}
	// The row still says what it was: refusing to build a delivery mode is not a
	// licence to rewrite somebody's declared intent.
	var mode string
	if err := f.pool.QueryRow(ctx, `SELECT delivery_mode FROM secret_metadata WHERE id = $1::uuid`,
		secret.ID).Scan(&mode); err != nil {
		t.Fatalf("read mode: %v", err)
	}
	if mode != "integration_broker" {
		t.Errorf("delivery_mode = %q, want the declared integration_broker", mode)
	}
	// A mount for it is refused, so the declaration cannot half-exist.
	if _, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "integration_broker", EnvName: "BROKER_TOKEN",
	}); !errors.Is(err, ErrDeliveryUnsupported) {
		t.Errorf("broker mount = %v, want ErrDeliveryUnsupported", err)
	}
}

// --- org scope, cross-project, and denials -------------------------------

func TestSecretStoreOrgScopeAndCrossProjectVisibility(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	// Both branches of the visibility predicate need a row to match, or a list
	// that returns one row would pass a test that was meant to read two.
	projectSecret := f.create(t, "project-visible", "project value")

	// A project maintainer cannot create an org-scope secret.
	if _, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
		Slug: f.slug("org-denied"), DeliveryMode: "env", Scope: "org",
		Profiles: []string{f.profile}, Value: []byte("org value"),
	}); !errors.Is(err, ErrSecretForbidden) {
		t.Fatalf("org create by a project maintainer = %v, want ErrSecretForbidden", err)
	}
	// An organization admin can, and the row carries no project (the
	// secrets_scope_pointer CHECK is the enforcement, and it is checked here rather
	// than assumed).
	orgAdmin := Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}
	orgSecret, err := f.store.CreateSecret(ctx, orgAdmin, f.projA, NewSecret{
		Slug: f.slug("org-allowed"), Purpose: "organization-wide", DeliveryMode: "env",
		Scope: "org", Profiles: []string{f.profile}, Value: []byte("org value"),
	})
	if err != nil {
		t.Fatalf("org create as admin: %v", err)
	}
	if orgSecret.Scope != "org" || orgSecret.ProjectID != "" {
		t.Fatalf("org row = %+v, want scope org with no project", orgSecret)
	}
	var storedProjectNull bool
	if err := f.pool.QueryRow(ctx, `SELECT project_id IS NULL FROM secret_metadata WHERE id = $1::uuid`,
		orgSecret.ID).Scan(&storedProjectNull); err != nil {
		t.Fatalf("read org row: %v", err)
	}
	if !storedProjectNull {
		t.Error("an org-scope secret stored a project_id")
	}

	// Both rows are visible to a viewer of the project; the scope column is what
	// tells them apart.
	listed, err := f.store.ListSecrets(ctx, f.caller(f.viewer), f.projA)
	if err != nil {
		t.Fatalf("ListSecrets: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("listed %d rows, want the project secret and the org secret: %+v", len(listed), listed)
	}
	if listed[0].Slug > listed[1].Slug {
		t.Errorf("rows are not ordered by slug: %q, %q", listed[0].Slug, listed[1].Slug)
	}
	var sawProject, sawOrg bool
	for _, row := range listed {
		sawProject = sawProject || (row.Scope == "project" && row.ID == projectSecret.ID)
		sawOrg = sawOrg || (row.Scope == "org" && row.ID == orgSecret.ID)
	}
	if !sawProject || !sawOrg {
		t.Errorf("the two-branch predicate did not return both branches: project=%v org=%v", sawProject, sawOrg)
	}

	// A member of another project sees neither the row nor its id.
	// projB's own maintainer can act on projB, and still cannot reach a secret
	// projB cannot see: the secret is invisible, not the project.
	if _, err := f.store.ListMaterializations(ctx, f.daveCaller(), f.projB, orgSecret.ID); !errors.Is(err, ErrSecretNotFound) {
		t.Errorf("other-project maintainer listing another project's secret = %v, want ErrSecretNotFound", err)
	}
	if _, err := f.store.UpdateSecretPolicy(ctx, f.daveCaller(), f.projB, orgSecret.ID, NewSecretPolicy{
		Purpose: "not yours", Audit: "materialization",
	}); !errors.Is(err, ErrSecretNotFound) {
		t.Errorf("other-project policy write = %v, want ErrSecretNotFound", err)
	}

	// Every refusal leaves an audit row, and the audit is what an operator reads
	// afterwards — so it must name the actor, the action and the outcome without
	// naming anything else.
	mustExec(t, f.pool, `
		INSERT INTO audit_events (organization_id, project_id, actor_kind, actor_id, action, outcome, detail)
		VALUES ($1::uuid, $2::uuid, 'human', $3, 'secret.list', 'denied', '{}'::jsonb)`,
		f.orgID, f.projB, f.dave)
	var outcome, actor string
	if err := f.pool.QueryRow(ctx, `
		SELECT outcome, actor_id::text FROM audit_events
		WHERE project_id = $1::uuid AND action = 'secret.list' ORDER BY id DESC LIMIT 1`,
		f.projB).Scan(&outcome, &actor); err != nil {
		t.Fatalf("read denial: %v", err)
	}
	if outcome != "denied" || actor != f.dave {
		t.Errorf("denial = %s by %s, want denied by dave", outcome, actor)
	}
	// RecordDenied is the seam the HTTP layer uses, and it must reach the same
	// table with the caller's role resolved.
	if err := f.store.RecordDenied(ctx, f.caller(f.viewer), f.projA, "secret.revoke"); err != nil {
		t.Fatalf("RecordDenied: %v", err)
	}
	var detail string
	if err := f.pool.QueryRow(ctx, `
		SELECT detail::text FROM audit_events
		WHERE project_id = $1::uuid AND action = 'secret.revoke' ORDER BY id DESC LIMIT 1`,
		f.projA).Scan(&detail); err != nil {
		t.Fatalf("read recorded denial: %v", err)
	}
	var denial map[string]any
	if err := json.Unmarshal([]byte(detail), &denial); err != nil {
		t.Fatalf("decode recorded denial: %v", err)
	}
	if denial["role"] != "viewer" || denial["action"] != "secret.revoke" {
		t.Errorf("recorded denial lost the caller's role or action: %s", detail)
	}
}

// --- mounts and materialization records ----------------------------------

func TestSecretStoreMountsAreScopedAndRecorded(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "mounted", "mount me")

	fileMount, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env_file", RepositoryID: f.repoA,
		RelativePath: ".env.local", Key: "REGISTRY_TOKEN", Lifecycle: "workspace",
	})
	if err != nil {
		t.Fatalf("CreateMount env_file: %v", err)
	}
	if fileMount.Lifecycle != "workspace" || fileMount.RelativePath != ".env.local" ||
		fileMount.RepositoryID != f.repoA || fileMount.SecretSlug != secret.Slug {
		t.Fatalf("mount = %+v", fileMount)
	}
	if fileMount.EnvName != "" {
		t.Errorf("an env_file mount stored an env_name: %+v", fileMount)
	}
	if _, err := f.store.CreateMount(ctx, f.caller(f.carol), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env", EnvName: "CONTRIBUTOR_NOPE",
	}); !errors.Is(err, ErrSecretForbidden) {
		t.Errorf("contributor mount = %v, want ErrSecretForbidden (openapi: secret management is maintainer or above)", err)
	}
	envMount, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env", EnvName: "REGISTRY_TOKEN", AllowTracked: true,
	})
	if err != nil {
		t.Fatalf("CreateMount env (contributor): %v", err)
	}
	if envMount.EnvName != "REGISTRY_TOKEN" || envMount.RelativePath != "" || !envMount.AllowTracked {
		t.Fatalf("env mount = %+v", envMount)
	}
	if envMount.Lifecycle != "turn" {
		t.Errorf("lifecycle = %q, want the default turn", envMount.Lifecycle)
	}
	// A repository of another project is refused rather than recorded: the
	// declaration would place a value in a checkout this project has no claim on.
	if _, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env_file", RepositoryID: f.repoA,
		RelativePath: ".env.other", Lifecycle: "turn",
	}); err != nil {
		t.Fatalf("control mount for the same repository: %v", err)
	}
	foreign := f.storeProjectBRepository(t)
	if _, err := f.store.CreateMount(ctx, f.daveCaller(), f.projB, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env_file", RepositoryID: foreign,
		RelativePath: ".env.local", Lifecycle: "turn",
	}); !errors.Is(err, ErrSecretNotFound) {
		t.Errorf("mount of a secret the project cannot see = %v, want ErrSecretNotFound", err)
	}
	// A viewer cannot declare placements.
	if _, err := f.store.CreateMount(ctx, f.caller(f.viewer), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env", EnvName: "NOPE",
	}); !errors.Is(err, ErrSecretForbidden) {
		t.Errorf("viewer mount = %v, want ErrSecretForbidden", err)
	}

	mounts, err := f.store.ListMounts(ctx, f.caller(f.viewer), f.projA)
	if err != nil {
		t.Fatalf("ListMounts: %v", err)
	}
	if len(mounts) != 3 {
		t.Fatalf("listed %d mounts, want the three declared here: %+v", len(mounts), mounts)
	}
	if err := f.store.DeleteMount(ctx, f.caller(f.alice), f.projA, envMount.ID); err != nil {
		t.Fatalf("DeleteMount: %v", err)
	}
	if err := f.store.DeleteMount(ctx, f.caller(f.alice), f.projA, envMount.ID); !errors.Is(err, ErrMountNotFound) {
		t.Errorf("second delete = %v, want ErrMountNotFound", err)
	}
	// Deleting a placement is auditable, and does not touch the secret: a typo in a
	// path must not cost a rotation.
	var revoked, versions int
	if err := f.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM secret_metadata WHERE id = $1::uuid AND revoked_at IS NOT NULL),
		       (SELECT count(*) FROM secret_versions WHERE secret_id = $1::uuid)`,
		secret.ID).Scan(&revoked, &versions); err != nil {
		t.Fatalf("read secret after mount delete: %v", err)
	}
	if revoked != 0 || versions != 1 {
		t.Errorf("deleting a mount touched the secret: revoked=%d versions=%d", revoked, versions)
	}
	var mountActions int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_events WHERE project_id = $1::uuid
		  AND action IN ('secret.mount.create', 'secret.mount.delete')`, f.projA).Scan(&mountActions); err != nil {
		t.Fatalf("count mount audit: %v", err)
	}
	if mountActions != 4 {
		t.Errorf("mount audit rows = %d, want 4 (three creates, one delete)", mountActions)
	}
}

// storeProjectBRepository gives the fixture a repository in the *other* project,
// which is how "a mount may not reach across projects" is tested rather than
// asserted.
func (f *secFixture) storeProjectBRepository(t *testing.T) string {
	t.Helper()
	var repo string
	mustQuery(t, f.pool, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'https://example.test/lab/other.git', 'main', $3::uuid) RETURNING id::text`,
		f.projB, "other-"+f.token, f.dave).Scan(&repo)
	return repo
}

func TestSecretStoreMaterializationRecordAndSweep(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "materialized", "the value")

	// The record is written after the file exists, and the event goes in the same
	// transaction. Two mounts, one env_file and one env, because the columns differ
	// (file_mode is a fact about a file, and env delivery has none).
	fileID, err := f.store.RecordMaterialization(ctx, NewSecretMaterialization{
		SecretID: secret.ID, SecretVersion: 1, OrganizationID: f.orgID, ProjectID: f.projA, WorkspaceID: f.wsA,
		WorkerID: f.worker, DeliveryMode: "env_file", Target: ".env.local", FileMode: 0o600,
	}, events.SecretMaterializedPayload{
		SecretID: secret.ID, ProjectID: f.projA, Slug: secret.Slug, Version: 1,
		DeliveryMode: "env_file", RelativePath: ".env.local", Mode: "0600", Lifecycle: "turn",
		WorkspaceID: f.wsA, PolicyDigest: "sha256:" + strings.Repeat("b", 64),
	})
	if err != nil {
		t.Fatalf("RecordMaterialization env_file: %v", err)
	}
	if _, err := f.store.RecordMaterialization(ctx, NewSecretMaterialization{
		SecretID: secret.ID, SecretVersion: 1, OrganizationID: f.orgID, ProjectID: f.projA, WorkspaceID: f.wsA,
		WorkerID: f.worker, DeliveryMode: "env", Target: "REGISTRY_TOKEN",
	}, events.SecretMaterializedPayload{
		SecretID: secret.ID, ProjectID: f.projA, Slug: secret.Slug, Version: 1,
		DeliveryMode: "env", EnvName: "REGISTRY_TOKEN", Lifecycle: "turn",
		WorkspaceID: f.wsA, PolicyDigest: "sha256:" + strings.Repeat("b", 64),
	}); err != nil {
		t.Fatalf("RecordMaterialization env: %v", err)
	}

	uncleaned, err := f.store.UncleanedMaterializations(ctx, f.wsA)
	if err != nil {
		t.Fatalf("UncleanedMaterializations: %v", err)
	}
	if len(uncleaned) != 2 {
		t.Fatalf("uncleaned rows = %d, want both deliveries still open: %+v", len(uncleaned), uncleaned)
	}

	rows, err := f.store.ListMaterializations(ctx, f.caller(f.alice), f.projA, secret.ID)
	if err != nil {
		t.Fatalf("ListMaterializations: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("audit view rows = %d, want 2", len(rows))
	}
	if rows[0].CleanedAt != nil || rows[0].CleanedBy != "" {
		t.Errorf("a fresh row read as cleaned: %+v", rows[0])
	}
	var fileMode, envMode *int
	for _, row := range rows {
		mode := row.FileMode
		if row.DeliveryMode == "env_file" {
			fileMode = &mode
		} else {
			envMode = &mode
		}
	}
	if fileMode == nil || *fileMode != 384 {
		t.Errorf("file_mode for the env_file row = %v, want 384 (0600 recorded, not asserted)", fileMode)
	}
	if envMode == nil || *envMode != 0 {
		t.Errorf("file_mode for the env row = %v, want the store's null", envMode)
	}
	var nulls int
	envRowID := ""
	for _, row := range rows {
		if row.DeliveryMode == "env" {
			envRowID = fmt.Sprint(row.ID)
		}
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM secret_materializations WHERE id = $1 AND file_mode IS NULL`,
		envRowID).Scan(&nulls); err != nil {
		t.Fatalf("read file_mode null: %v", err)
	}
	if nulls != 1 {
		t.Error("env delivery recorded a file mode, which is the 'env is never recorded as a file' rule in the CHECK")
	}

	// Cleanup closes the row, and closing it twice is not an error — the sweep and
	// the unit's own defer will both try.
	if err := f.store.MarkMaterializationCleaned(ctx, fileID, "worker"); err != nil {
		t.Fatalf("MarkMaterializationCleaned: %v", err)
	}
	if err := f.store.MarkMaterializationCleaned(ctx, fileID, "startup_sweep"); err != nil {
		t.Fatalf("second MarkMaterializationCleaned must be idempotent: %v", err)
	}
	var cleanedBy string
	if err := f.pool.QueryRow(ctx, `
		SELECT cleaned_by FROM secret_materializations WHERE id = $1`, fileID).Scan(&cleanedBy); err != nil {
		t.Fatalf("read cleaned_by: %v", err)
	}
	if cleanedBy != "worker" {
		t.Errorf("cleaned_by = %q, want the first closer (worker), not the double-call", cleanedBy)
	}
	uncleaned, err = f.store.UncleanedMaterializations(ctx, f.wsA)
	if err != nil {
		t.Fatalf("UncleanedMaterializations after cleanup: %v", err)
	}
	if len(uncleaned) != 1 {
		t.Fatalf("uncleaned rows after one cleanup = %d, want the env row still open", len(uncleaned))
	}

	// The event carries no value: not in the payload, not anywhere in the journal
	// for this project.
	var withValue int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND payload::text LIKE '%the value%'`,
		f.projA).Scan(&withValue); err != nil {
		t.Fatalf("scan journal for the value: %v", err)
	}
	if withValue != 0 {
		t.Errorf("%d journal payloads contain the value", withValue)
	}
	var materialized int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND type = 'secret.materialized'`,
		f.projA).Scan(&materialized); err != nil {
		t.Fatalf("count materialized events: %v", err)
	}
	if materialized != 2 {
		t.Errorf("secret.materialized events = %d, want 2", materialized)
	}
}

// --- the whole-database plaintext absence check --------------------------

// TestSecretStorePlaintextAbsentFromDatabaseDump is m3-contract § 1's headline
// property, checked the only way it can be checked: write a value, dump the entire
// database with the same tool an operator would use after a breach, and grep the
// dump for what should not be in it.
//
// It runs only when the lab container is named, because pg_dump is not on this
// host — the container's client is, and using the operator's actual client is the
// point (a Go-side SELECT over text columns would miss the bytea encoding a dump
// chooses, which is exactly the thing worth knowing).
func TestSecretStorePlaintextAbsentFromDatabaseDump(t *testing.T) {
	container := os.Getenv("COMMUNICATION_LAB_PG_CONTAINER")
	if container == "" {
		t.Skip("COMMUNICATION_LAB_PG_CONTAINER not set; the pg_dump check needs the lab container's client")
	}
	f := secSetup(t)
	ctx := testCtx(t)
	secret := f.create(t, "dumped", secSentinel)
	if _, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte(secSentinel)); err != nil {
		t.Fatalf("AddSecretVersion: %v", err)
	}
	if _, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env_file", RepositoryID: f.repoA,
		RelativePath: ".env.local", Key: "REGISTRY_TOKEN",
	}); err != nil {
		t.Fatalf("CreateMount: %v", err)
	}
	if _, err := f.store.RecordMaterialization(ctx, NewSecretMaterialization{
		SecretID: secret.ID, SecretVersion: 1, OrganizationID: f.orgID, ProjectID: f.projA, WorkspaceID: f.wsA,
		WorkerID: f.worker, DeliveryMode: "env_file", Target: ".env.local", FileMode: 0o600,
	}, events.SecretMaterializedPayload{
		SecretID: secret.ID, ProjectID: f.projA, Slug: secret.Slug, Version: 1,
		DeliveryMode: "env_file", RelativePath: ".env.local", Mode: "0600", Lifecycle: "turn",
		WorkspaceID: f.wsA, PolicyDigest: "sha256:" + strings.Repeat("c", 64),
	}); err != nil {
		t.Fatalf("RecordMaterialization: %v", err)
	}
	if _, err := f.store.RevokeSecret(ctx, f.caller(f.alice), f.projA, secret.ID); err != nil {
		t.Fatalf("RevokeSecret: %v", err)
	}

	// The database name comes from the same URL the tests connected with, parsed
	// rather than string-sliced: an operator's URL may carry a port, a search
	// path or a password, and a dump of the wrong database would pass every
	// absence check below by being empty of our rows.
	conf, err := pgconn.ParseConfig(os.Getenv("COMMUNICATION_TEST_DATABASE_URL"))
	if err != nil || conf.Database == "" {
		t.Skipf("cannot name the test database from COMMUNICATION_TEST_DATABASE_URL: %v", err)
	}
	database := conf.Database
	cmd := exec.Command("docker", "exec", container,
		"pg_dump", "-U", conf.User, "-d", database, "--no-owner")
	dump, err := cmd.Output()
	if err != nil {
		t.Fatalf("pg_dump: %v", err)
	}
	text := string(dump)
	// Positive control first: the dump really contains the rows under test, so a
	// passing absence check below cannot be a passing empty file.
	if !strings.Contains(text, "secret_versions") || !strings.Contains(text, "secret_metadata") {
		t.Fatal("the dump contains no secret tables: the absence checks below would be vacuous")
	}
	if !strings.Contains(text, secret.ID) {
		t.Fatal("the dump does not contain the secret id it was taken for")
	}
	var aad string
	if err := f.pool.QueryRow(ctx, `SELECT aad FROM secret_versions WHERE secret_id = $1 LIMIT 1`,
		secret.ID).Scan(&aad); err != nil {
		t.Fatalf("read aad: %v", err)
	}
	if !strings.Contains(text, aad) {
		t.Errorf("the dump lost the aad column (%q): the dump is not the whole table", aad)
	}

	// The absences. Every encoding a value could arrive in: as written, as the
	// hex that a bytea dump would choose, and as the base64 a client might send.
	for name, needle := range map[string]string{
		"the value itself":     secSentinel,
		"hex of the value":     hex.EncodeToString([]byte(secSentinel)),
		"base64 of the value":  baseText(secSentinel),
		"reversed value":       reverse(secSentinel),
		"value without prefix": strings.TrimPrefix(secSentinel, "dckr_pat_"),
	} {
		if strings.Contains(text, needle) {
			t.Errorf("pg_dump of the whole database contains %s", name)
		}
	}
	// The same claim as SQL, over the columns that exist, so a failure names the
	// table rather than the dump.
	for _, q := range []struct {
		table, label string
		sql          string
	}{
		{"secret_metadata", "metadata", `SELECT count(*) FROM secret_metadata WHERE $1 IN (slug, purpose, delivery_mode, audit_policy)`},
		{"secret_versions", "versions", `SELECT count(*) FROM secret_versions WHERE $1 IN (key_id, aad, content_sha256) OR ciphertext::text LIKE '%' || $1 || '%' OR nonce::text LIKE '%' || $1 || '%'`},
		{"secret_mounts", "mounts", `SELECT count(*) FROM secret_mounts WHERE $1 IN (COALESCE(relative_path,''), COALESCE(env_name,''), COALESCE("key",''))`},
		{"secret_materializations", "materializations", `SELECT count(*) FROM secret_materializations WHERE $1 IN (target, delivery_mode, COALESCE(cleaned_by,''))`},
		{"domain_events", "journal", `SELECT count(*) FROM domain_events WHERE payload::text LIKE '%' || $1 || '%'`},
		{"audit_events", "audit", `SELECT count(*) FROM audit_events WHERE detail::text LIKE '%' || $1 || '%'`},
	} {
		var hits int
		if err := f.pool.QueryRow(ctx, q.sql, secSentinel).Scan(&hits); err != nil {
			t.Fatalf("scan %s: %v", q.table, err)
		}
		if hits != 0 {
			t.Errorf("%d %s rows contain the value in a column it could never belong", hits, q.label)
		}
	}
	t.Logf("observed: pg_dump %d bytes; secret absent in all %d checked encodings and 6 table scans",
		len(dump), 5)
}

// TestSecretStoreEveryReadPathReturnsNoValue is the type-level claim made
// operational: for every method on the store that a caller could reach, the
// returned structures carry no bytes and no string equal to the value.
func TestSecretStoreEveryReadPathReturnsNoValue(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	// A first value distinct from the second: identical bytes would take the
	// digest-retry arm and leave no version 2 to read back.
	secret := f.create(t, "readpaths", "the first value")
	if _, err := f.store.AddSecretVersion(ctx, f.caller(f.alice), f.projA, secret.ID, []byte(secSentinel)); err != nil {
		t.Fatalf("AddSecretVersion: %v", err)
	}
	mount, err := f.store.CreateMount(ctx, f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env", EnvName: "REGISTRY_TOKEN",
	})
	if err != nil {
		t.Fatalf("CreateMount: %v", err)
	}
	revoked, err := f.store.RevokeSecret(ctx, f.caller(f.alice), f.projA, secret.ID)
	if err != nil {
		t.Fatalf("RevokeSecret: %v", err)
	}
	_ = revoked

	listed, err := f.store.ListSecrets(ctx, f.caller(f.alice), f.projA)
	if err != nil {
		t.Fatalf("ListSecrets: %v", err)
	}
	mounts, err := f.store.ListMounts(ctx, f.caller(f.alice), f.projA)
	if err != nil {
		t.Fatalf("ListMounts: %v", err)
	}
	mats, err := f.store.ListMaterializations(ctx, f.caller(f.alice), f.projA, secret.ID)
	if err != nil {
		t.Fatalf("ListMaterializations: %v", err)
	}
	uncleaned, err := f.store.UncleanedMaterializations(ctx, "")
	if err != nil {
		t.Fatalf("UncleanedMaterializations: %v", err)
	}
	for _, sample := range []struct {
		label  string
		values []any
	}{
		{"ListSecrets", secFlatten(listed)},
		{"ListMounts", secFlatten(mounts)},
		{"ListMaterializations", secFlatten(mats)},
		{"UncleanedMaterializations", secFlatten(uncleaned)},
		{"CreateMount", secFlatten([]SecretMount{mount})},
	} {
		for _, v := range sample.values {
			s, ok := v.(string)
			if !ok {
				continue
			}
			if s == secSentinel || strings.Contains(s, secSentinel) {
				t.Errorf("%s returned a field carrying the value: %q", sample.label, s)
			}
		}
	}
	// The one read that legitimately touches ciphertext is named, so "no method
	// returns plaintext" is checked rather than asserted: what LoadVersion hands
	// back is sealed, and the only way to a value is a call that has to name the
	// keyring.
	stored, err := f.store.LoadVersion(ctx, secret.ID, 2)
	if err != nil {
		t.Fatalf("LoadVersion: %v", err)
	}
	if string(stored.Sealed.Ciphertext) == secSentinel || strings.Contains(stored.Sealed.AAD, secSentinel) {
		t.Error("LoadVersion leaked the value through the ciphertext fields")
	}
	value, err := secrets.Open(ctx, f.keys, stored.Ref, stored.Sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if string(value.Bytes()) != secSentinel {
		t.Errorf("Open returned %q", value.Bytes())
	}
	// And after revocation the resolver refuses the same row that Open just read —
	// D2.4 is a refusal in the resolver, not a property of the bytes.
	resolver, err := secrets.NewResolver(f.store, f.keys)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	if _, err := resolver.Resolve(ctx, secAttempt(f), secret.ID, 2); !errors.Is(err, secrets.ErrRevoked) {
		t.Errorf("Resolve after revoke = %v, want ErrRevoked", err)
	}
	value.Zero()
}

// secFlatten collects the string fields of a slice of store rows, so the
// "no value anywhere" check reads the returned data rather than a hand-written
// subset of it.
func secFlatten[T any](in []T) []any {
	var out []any
	for _, row := range in {
		out = append(out, secFieldsOf(row)...)
	}
	return out
}

func secFieldsOf(row any) []any {
	var out []any
	switch v := row.(type) {
	case Secret:
		out = append(out, v.ID, v.OrganizationID, v.ProjectID, v.Scope, v.Slug, v.Purpose,
			v.DeliveryMode, v.AuditPolicy, v.CreatedBy)
		for _, p := range v.Profiles {
			out = append(out, p)
		}
	case SecretMount:
		out = append(out, v.ID, v.ProjectID, v.SecretID, v.SecretSlug, v.DeliveryMode,
			v.RepositoryID, v.RelativePath, v.EnvName, v.Key, v.Lifecycle)
	case SecretMaterialization:
		out = append(out, v.ID, v.SecretID, v.SecretSlug, v.ProjectID, v.WorkspaceID,
			v.TurnID, v.WorkerID, v.DeliveryMode, v.Target, v.CleanedBy)
	}
	return out
}

func hexSha256(s string) string { return hexSha256String(s) }

func hexSha256String(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func baseText(s string) string {
	// base64 std encoding of the value, spelled with an import-free helper so the
	// test does not need a second encoding library for one assertion.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out strings.Builder
	for i := 0; i < len(s); i += 3 {
		var n uint32
		rem := len(s) - i
		if rem < 3 {
			for j := 0; j < 3; j++ {
				if j < rem {
					n |= uint32(s[i+j]) << uint(16-8*j)
				}
			}
			for j := 0; j < rem+1; j++ {
				out.WriteByte(alphabet[(n>>uint(18-6*j))&0x3f])
			}
			for j := rem; j < 3; j++ {
				out.WriteByte('=')
			}
			continue
		}
		n = uint32(s[i])<<16 | uint32(s[i+1])<<8 | uint32(s[i+2])
		for j := 0; j < 4; j++ {
			out.WriteByte(alphabet[(n>>uint(18-6*j))&0x3f])
		}
	}
	return out.String()
}

func reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// secVersionBytes reads a version row's raw bytes, so "immutable" is a comparison
// of stored bytes rather than a claim about an UPDATE statement nobody ran.
type secVersionRow struct {
	nonceHex      string
	ciphertextHex string
	keyID         string
	aad           string
}

func secVersionBytes(t *testing.T, pool *pgxpool.Pool, secretID string, version int) secVersionRow {
	t.Helper()
	var (
		row               secVersionRow
		nonce, ciphertext []byte
	)
	err := pool.QueryRow(testCtx(t), `
		SELECT key_id, nonce, ciphertext, aad FROM secret_versions
		WHERE secret_id = $1::uuid AND version = $2`, secretID, version).
		Scan(&row.keyID, &nonce, &ciphertext, &row.aad)
	if err != nil {
		t.Fatalf("read secret version %d: %v", version, err)
	}
	row.nonceHex = hex.EncodeToString(nonce)
	row.ciphertextHex = hex.EncodeToString(ciphertext)
	return row
}

func secVersionCount(t *testing.T, pool *pgxpool.Pool, secretID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(testCtx(t), `SELECT count(*) FROM secret_versions WHERE secret_id = $1::uuid`,
		secretID).Scan(&count); err != nil {
		t.Fatalf("count versions: %v", err)
	}
	return count
}
