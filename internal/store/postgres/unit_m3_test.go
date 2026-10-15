package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// Integration tests for the unit-boundary adapters: the secret materializer
// the worker calls before launch, the artifact capturer it calls after the
// terminal write, and the API-side reads over the same rows. These run against
// a real PostgreSQL *and* a real git, because every claim under test is about
// the interaction of the two: that a materialized file lands with its
// exclusion appended through git, that a refusal removes what an earlier mount
// wrote, that the row+event pair for an artifact splits only if the lease
// fence is wrong, and that the redaction hook scrubs values the sink never
// sees. A fake would demonstrate the shape of the Go and none of that.

// u3Fixture wraps secFixture with the on-disk half: a bare mirror, a worktree
// checkout at the workspace's real agent root, a workspace_repos row, and a
// leased turn owned by f.worker.
type u3Fixture struct {
	*secFixture
	root       string // workspaces.root_path, on disk
	agentRoot  string // = root + "/work" (the generated column's rule)
	checkout   string
	mirror     string
	adminDir   string
	baseCommit string
	repoName   string
	convID     string
	turnID     string
	tokenLease int64
}

func u3Setup(t *testing.T) *u3Fixture {
	t.Helper()
	f := &u3Fixture{secFixture: secSetup(t)}

	f.root = t.TempDir()
	f.agentRoot = filepath.Join(f.root, "work")
	mustExec(t, f.pool, `UPDATE workspaces SET root_path = $2 WHERE id = $1::uuid`, f.wsA, f.root)

	// Repository name is "registry-<token>" from secSetup; read it back rather
	// than re-deriving the format.
	mustQuery(t, f.pool, `SELECT name FROM repositories WHERE id = $1::uuid`, f.repoA).Scan(&f.repoName)

	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_AUTHOR_NAME=Lab", "GIT_AUTHOR_EMAIL=lab@invalid",
			"GIT_COMMITTER_NAME=Lab", "GIT_COMMITTER_EMAIL=lab@invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	base := filepath.Join(f.root, "base")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	git(base, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(base, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(base, "add", ".")
	git(base, "commit", "-qm", "seed")
	f.baseCommit = git(base, "rev-parse", "HEAD")

	f.mirror = filepath.Join(f.root, "mirror", f.repoName+".git")
	if err := os.MkdirAll(filepath.Dir(f.mirror), 0o755); err != nil {
		t.Fatal(err)
	}
	git(f.root, "clone", "-q", "--bare", base, f.mirror)

	f.checkout = filepath.Join(f.agentRoot, "repos", f.repoName)
	if err := os.MkdirAll(filepath.Dir(f.checkout), 0o755); err != nil {
		t.Fatal(err)
	}
	git(f.mirror, "worktree", "add", "-q", "--detach", f.checkout, "HEAD")
	f.adminDir = git(f.checkout, "rev-parse", "--absolute-git-dir")

	mustExec(t, f.pool, `
		INSERT INTO workspace_repos
			(workspace_id, repository_id, checkout_path, mirror_path, mirror_volume_id,
			 admin_dir, run_ref, base_commit)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
		f.wsA, f.repoA, f.checkout, f.mirror, "sha256:"+strings.Repeat("b", 64),
		f.adminDir, f.token+"/"+f.repoName, f.baseCommit)

	var conversation string
	mustQuery(t, f.pool, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, 'unit fixture', $3::uuid) RETURNING id::text`,
		f.projA, f.profile, f.alice).Scan(&conversation)
	f.convID = conversation

	// A leased turn owned by the fixture worker. fencing_token > 0 with a live
	// lease satisfies conversation_turn_lease_is_a_triple.
	f.tokenLease = 11
	mustQuery(t, f.pool, `
		INSERT INTO conversation_turns
			(conversation_id, prompt, submitted_by, status, worker_id, lease_expires_at,
			 fencing_token, started_at)
		VALUES ($1::uuid, 'do the thing', $2::uuid, 'running', $3::uuid, now() + interval '1 hour',
		        $4, now())
		RETURNING id::text`, conversation, f.alice, f.worker, f.tokenLease).Scan(&f.turnID)

	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM artifacts WHERE project_id = $1::uuid`, []any{f.projA}},
			{`DELETE FROM worker_volumes WHERE worker_id = $1::uuid`, []any{f.worker}},
			{`DELETE FROM conversation_turns WHERE conversation_id = $1::uuid`, []any{conversation}},
			{`DELETE FROM workspace_repos WHERE workspace_id = $1::uuid`, []any{f.wsA}},
		} {
			if _, err := f.pool.Exec(bg, q.sql, q.args...); err != nil {
				t.Errorf("u3 cleanup %q: %v", q.sql, err)
			}
		}
	})
	return f
}

func (f *u3Fixture) mount(t *testing.T, secret, mode, envName, rel string) SecretMount {
	t.Helper()
	in := NewSecretMount{SecretID: secret, DeliveryMode: mode, EnvName: envName, Lifecycle: "turn"}
	if mode == "env_file" {
		in.RepositoryID = f.repoA
		in.RelativePath = rel
	}
	m, err := f.store.CreateMount(testCtx(t), f.caller(f.alice), f.projA, in)
	if err != nil {
		t.Fatalf("CreateMount(%s): %v", secret, err)
	}
	return m
}

func (f *u3Fixture) request(extra *[]string) worker.MaterializeRequest {
	if extra == nil {
		extra = new([]string)
	}
	return worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkspaceID: f.wsA,
		ConversationID: f.convID, TurnID: f.turnID, WorkerID: f.worker,
		AgentProfileID: f.profile, PolicyDigest: "sha256:" + strings.Repeat("c", 64),
		Repos: []worker.MaterializeRepo{{ID: f.repoA, Name: f.repoName,
			CheckoutPath: f.checkout, MirrorPath: f.mirror}},
		ExtraExclusions: extra,
	}
}

func (f *u3Fixture) unitSecrets() *UnitSecrets {
	return &UnitSecrets{Secrets: f.store, Workspaces: &WorkspaceStore{Pool: f.pool}}
}

func u3Rand(t *testing.T) string {
	t.Helper()
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// countEvents reads the journal for one turn: the events under test all carry
// turn_id in their payload, which is exactly what the API-side reads key on.
func countEvents(t *testing.T, f *u3Fixture, typ string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT count(*) FROM domain_events
		 WHERE type = $1 AND payload->>'turn_id' = $2`, typ, f.turnID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestUnitSecretsMaterializeDeliversRecordsRedactsAndCloses(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	envValue := "envval-" + u3Rand(t)
	fileValue := "API_KEY=token-" + u3Rand(t) + "\nother=tail\n"

	envSec := f.createAs(t, "env", "u3-env-"+f.token, envValue)
	fileSec := f.createAs(t, "env_file", "u3-file-"+f.token, fileValue)
	f.mount(t, envSec.ID, "env", "DEMO_TOKEN", "")
	f.mount(t, fileSec.ID, "env_file", "", "secrets/token.txt")

	var extra []string
	m, err := f.unitSecrets().Materialize(ctx, f.request(&extra))
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(m.Env) != 1 || m.Env[0] != "DEMO_TOKEN="+envValue {
		t.Errorf("env deliveries = %q", m.Env)
	}
	wantFile := filepath.Join(f.checkout, "secrets", "token.txt")
	if len(m.Files) != 1 || m.Files[0] != wantFile {
		t.Fatalf("files = %q, want [%s]", m.Files, wantFile)
	}
	raw, err := os.ReadFile(wantFile)
	if err != nil {
		t.Fatalf("read delivered file: %v", err)
	}
	if string(raw) != fileValue {
		t.Errorf("file content = %q", raw)
	}
	if fi, err := os.Stat(wantFile); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, want 0600", fi.Mode().Perm())
	}
	// The exclusion is *git-visible* through the mirror (the one placement
	// probes G1-G5 found that works for worktrees) and the request's exclusion
	// out-param carried the relative path for the artifact filter.
	exc, err := os.ReadFile(filepath.Join(f.mirror, "info", "exclude"))
	if err != nil || !strings.Contains(string(exc), "/secrets/token.txt") {
		t.Errorf("mirror info/exclude = %q, %v", exc, err)
	}
	if strings.Join(extra, ",") != "secrets/token.txt" {
		t.Errorf("ExtraExclusions = %q", extra)
	}

	// Rows exist, open, and carry the repo-qualified target (contract sync:
	// the deviation that makes the sweep resolvable).
	var open int
	mustQuery(t, f.pool, `
		SELECT count(*) FROM secret_materializations
		 WHERE turn_id = $1::uuid AND cleaned_at IS NULL AND target = $2`,
		f.turnID, f.repoName+"/secrets/token.txt").Scan(&open)
	if open != 1 {
		t.Fatalf("open materialization rows for the file = %d, want 1", open)
	}
	if n := countEvents(t, f, events.TypeSecretMaterialized); n != 2 {
		t.Errorf("secret.materialized events = %d, want 2", n)
	}
	// The journal and the rows hold no plaintext, ever (case 12's invariant,
	// asserted at the closest possible point to the write).
	if dump := secAllText(t, f.pool); strings.Contains(dump, envValue) || strings.Contains(dump, fileValue) {
		t.Fatal("a materialized value reached the database")
	}

	// The redaction hook scrubs the whole value, a KEY=value right-hand side
	// inside a multi-line value, and counts — without this package being the
	// one that decides what the sink does.
	if m.Redact == nil {
		t.Fatal("no redaction hook returned")
	}
	out, n := m.Redact("leaked " + envValue + " and " + "token-x")
	if strings.Contains(out, envValue) {
		t.Errorf("redaction missed the whole env value: %q", out)
	}
	out2, n2 := m.Redact("echo API_KEY=" + strings.TrimPrefix(strings.Split(fileValue, "\n")[0], "API_KEY="))
	if strings.Contains(out2, "API_KEY=token") {
		t.Errorf("redaction missed a KEY=value secret: %q", out2)
	}
	if n+n2 < 1 {
		t.Errorf("redaction counts = %d + %d", n, n2)
	}

	// Done closes rows + journals secret.removed, and only after the *unit*
	// asserted the files gone — here we remove first, exactly as cleanup does.
	for _, path := range m.Files {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Done(ctx); err != nil {
		t.Fatalf("Done: %v", err)
	}
	mustQuery(t, f.pool, `
		SELECT count(*) FROM secret_materializations
		 WHERE turn_id = $1::uuid AND cleaned_at IS NOT NULL AND cleaned_by = 'worker'`,
		f.turnID).Scan(&open)
	if open != 2 {
		t.Errorf("closed rows = %d, want 2", open)
	}
	if n := countEvents(t, f, events.TypeSecretRemoved); n != 2 {
		t.Errorf("secret.removed events = %d, want 2", n)
	}
}

// createAs is f.create with an explicit delivery mode (f.create hardcodes
// env_file and the env arm needs its own mount shape).
func (f *secFixture) createAs(t *testing.T, mode, slug, value string) Secret {
	t.Helper()
	secret, err := f.store.CreateSecret(testCtx(t), f.caller(f.alice), f.projA, NewSecret{
		Slug: slug, Purpose: "unit m3 test " + mode, DeliveryMode: mode,
		Profiles: []string{f.profile}, Value: []byte(value),
	})
	if err != nil {
		t.Fatalf("CreateSecret(%s): %v", slug, err)
	}
	return secret
}

func TestUnitSecretsRefusalRemovesEarlierDeliveries(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	// slug order is the materialize order: "a" delivers first, "b" refuses.
	f.createAs(t, "env_file", "u3-a-"+f.token, "aaaa-value-"+u3Rand(t))
	good, _ := f.store.ListSecrets(ctx, f.caller(f.alice), f.projA)
	var goodID string
	for _, s := range good {
		if strings.HasPrefix(s.Slug, "u3-a-") {
			goodID = s.ID
		}
	}
	f.mount(t, goodID, "env_file", "", "secrets/a.txt")

	bad := f.createAs(t, "env_file", "u3-b-"+f.token, "bbbb-value-"+u3Rand(t))
	f.mount(t, bad.ID, "env_file", "", "secrets/b.txt")
	if _, err := f.store.RevokeSecret(ctx, f.caller(f.alice), f.projA, bad.ID); err != nil {
		t.Fatalf("RevokeSecret: %v", err)
	}

	_, err := f.unitSecrets().Materialize(ctx, f.request(nil))
	if !errors.Is(err, errUnitSecretRefused) {
		t.Fatalf("Materialize error = %v, want errUnitSecretRefused", err)
	}
	if _, err := os.Stat(filepath.Join(f.checkout, "secrets", "a.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the earlier mount survived the later refusal")
	}
	if _, err := os.Stat(filepath.Join(f.checkout, "secrets", "b.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the refused mount wrote a file")
	}
	if n := countEvents(t, f, events.TypeSecretMaterializationFailed); n != 1 {
		t.Errorf("secret.materialization_failed = %d, want 1", n)
	}
	var reason string
	mustQuery(t, f.pool, `
		SELECT payload->>'reason' FROM domain_events
		 WHERE type = 'secret.materialization_failed' AND payload->>'turn_id' = $1`,
		f.turnID).Scan(&reason)
	if reason != events.MaterializationRevokedVersion {
		t.Errorf("reason = %q, want %q", reason, events.MaterializationRevokedVersion)
	}
}

func TestUnitSecretsRefusesUngrantedProfile(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	// The secret grants f.profile2, which is no real profile at all; this
	// unit runs as f.profile. ADR-0018 D3: both allowlist halves must agree.
	s := f.createAs(t, "env", "u3-ungranted-"+f.token, "nope-value-"+u3Rand(t))
	if _, err := f.store.UpdateSecretPolicy(ctx, f.caller(f.alice), f.projA, s.ID,
		NewSecretPolicy{Purpose: s.Purpose, Profiles: []string{f.profile2}, Audit: s.AuditPolicy}); err != nil {
		t.Fatalf("UpdateSecretPolicy: %v", err)
	}
	f.mount(t, s.ID, "env", "NOPE", "")
	if _, err := f.unitSecrets().Materialize(ctx, f.request(nil)); !errors.Is(err, errUnitSecretRefused) {
		t.Fatalf("Materialize error = %v, want refusal", err)
	}
	var reason string
	mustQuery(t, f.pool, `
		SELECT payload->>'reason' FROM domain_events
		 WHERE type = 'secret.materialization_failed' AND payload->>'turn_id' = $1`,
		f.turnID).Scan(&reason)
	if reason != events.MaterializationBadShape {
		t.Errorf("reason = %q", reason)
	}
	if n := countEvents(t, f, events.TypeSecretMaterialized); n != 0 {
		t.Errorf("an ungranted secret materialized %d times", n)
	}
}

func TestUnitSecretsSweepClosesWhatADeadWorkerLeft(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	// Hand-plant the finding state: a file and an open row, as if the process
	// died between the two turns. The target format is the one Materialize
	// writes (repo-qualified), so the sweep is exercised on real inputs.
	rel := "secrets/orphan.txt"
	path := filepath.Join(f.agentRoot, "repos", f.repoName, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("orphan-value-"+u3Rand(t)), 0o600); err != nil {
		t.Fatal(err)
	}
	s := f.createAs(t, "env_file", "u3-orphan-"+f.token, "orphan-value-x")
	var matID int64
	mustQuery(t, f.pool, `
		INSERT INTO secret_materializations
			(secret_id, secret_version, project_id, workspace_id, turn_id, worker_id,
			 delivery_mode, target, file_mode)
		VALUES ($1::uuid, 1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'env_file', $6, 384)
		RETURNING id`,
		s.ID, f.projA, f.wsA, f.turnID, f.worker, f.repoName+"/"+rel).Scan(&matID)

	swept, err := f.unitSecrets().SweepUncleaned(ctx, f.worker)
	if err != nil {
		t.Fatalf("SweepUncleaned: %v", err)
	}
	if swept != 1 {
		t.Fatalf("swept = %d, want 1", swept)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the sweep left the orphan file in place")
	}
	var cleanedBy string
	mustQuery(t, f.pool, `SELECT cleaned_by FROM secret_materializations WHERE id = $1`, matID).Scan(&cleanedBy)
	if cleanedBy != "startup_sweep" {
		t.Errorf("cleaned_by = %q, want startup_sweep", cleanedBy)
	}
	var n int
	mustQuery(t, f.pool, `
		SELECT count(*) FROM domain_events
		 WHERE type = 'secret.removed' AND payload->>'cleaned_by' = 'startup_sweep'`,
	).Scan(&n)
	if n != 1 {
		t.Errorf("startup_sweep secret.removed events = %d, want 1", n)
	}
	// Idempotent: a second sweep has nothing left to find.
	if again, err := f.unitSecrets().SweepUncleaned(ctx, f.worker); err != nil || again != 0 {
		t.Errorf("second sweep = %d, %v", again, err)
	}
}

// ---------------------------------------------------------------- artifacts ---

func u3ArtifactRoot(t *testing.T) string {
	t.Helper()
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.Getenv("HOME")
	}
	dir := filepath.Join(base, "communication-lab", "m3-unit-artifact-tests")
	if strings.HasPrefix(dir, "/tmp/") {
		t.Fatalf("artifact root %q under /tmp is forbidden by ADR-0019 P9", dir)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func (f *u3Fixture) captureReq(kind, name string, content []byte) worker.CaptureRequest {
	return worker.CaptureRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkspaceID: f.wsA,
		ConversationID: f.convID, TurnID: f.turnID, RepositoryID: f.repoA,
		WorkerID: f.worker, FencingToken: f.tokenLease,
		Kind: kind, Name: name, Manifest: []string{"a.go", ".env", "b.go"},
		ExcludedPaths: []string{".env"},
		Content:       content, MediaType: mediaTypeForTest(kind),
	}
}

func mediaTypeForTest(kind string) string {
	switch kind {
	case "html":
		return "text/html"
	case "markdown":
		return "text/markdown"
	default:
		return "application/json"
	}
}

func TestUnitArtifactsPublishesFencesAndDedupes(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	local, err := artifacts.NewLocal(artifacts.LocalConfig{Root: u3ArtifactRoot(t)})
	if err != nil {
		t.Fatal(err)
	}
	ua := &UnitArtifacts{Pool: f.pool, Bytes: local}

	report := []byte("<html><body>deployed</body></html>")
	id, err := ua.Capture(ctx, f.captureReq("html", "report.html", report))
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	var (
		state, backend, key, media string
		redactions                 int
		size                       int64
	)
	mustQuery(t, f.pool, `
		SELECT state, storage_backend, storage_key, media_type, redaction_count, size_bytes
		FROM artifacts WHERE id = $1::uuid`, id).Scan(&state, &backend, &key, &media, &redactions, &size)
	if state != "ready" || backend != "local" || media != "text/html" || size != int64(len(report)) {
		t.Fatalf("artifact row = %q %q %q %q %d", state, backend, key, media, size)
	}
	// The exclusion re-filter counted the dropped manifest entry: this is the
	// "the scanner ran" number ADR-0020 D4 asks for.
	if redactions != 1 {
		t.Errorf("redaction_count = %d, want 1", redactions)
	}
	if n := countEvents(t, f, events.TypeArtifactCreated); n != 1 {
		t.Fatalf("artifact.created events = %d, want 1", n)
	}
	// The event carries the digest and never the storage key.
	var payload string
	mustQuery(t, f.pool, `
		SELECT payload::text FROM domain_events
		 WHERE type = 'artifact.created' AND payload->>'turn_id' = $1`, f.turnID).Scan(&payload)
	if !strings.Contains(payload, `"sha256"`) || strings.Contains(payload, key) {
		t.Errorf("artifact.created payload = %s", payload)
	}

	// The same bytes again: same row (content addressing has to fall out of
	// the schema or a retried capture double-counts storage).
	id2, err := ua.Capture(ctx, f.captureReq("html", "report.html", report))
	if err != nil {
		t.Fatalf("re-Capture: %v", err)
	}
	if id2 != id {
		t.Errorf("retry produced a second row: %s vs %s", id2, id)
	}
	var rows int
	mustQuery(t, f.pool, `SELECT count(*) FROM artifacts WHERE project_id = $1::uuid`, f.projA).Scan(&rows)
	if rows != 1 {
		t.Errorf("artifact rows = %d, want 1", rows)
	}

	// A stale lease publishes nothing: the row and the event live or die on
	// the fence together (ADR-0016 § 9.2).
	_, err = ua.PublishArtifact(ctx, PublishArtifactInput{
		OrganizationID: f.orgID, ProjectID: f.projA, ConversationID: f.convID,
		TurnID: f.turnID, WorkerID: f.worker, FencingToken: f.tokenLease + 1,
		Name: "x.html", Kind: "html", MediaType: "text/html",
		Sensitivity: artifacts.SensitivityStandard,
		Ref:         artifacts.Ref{StorageBackend: "local", StorageKey: "x", SHA256: strings.Repeat("d", 64), SizeBytes: 18},
	})
	if !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("stale-lease publish = %v, want ErrLeaseLost", err)
	}

	// Capture runs *after* the terminal write (deviation D9): the fence must
	// tolerate a completed turn while still naming its owner. A completed
	// turn owned by this worker with this token publishes fine.
	mustExec(t, f.pool, `
		UPDATE conversation_turns SET status = 'completed', finished_at = now(),
		    lease_expires_at = NULL WHERE id = $1::uuid`, f.turnID)
	id3, err := ua.Capture(ctx, f.captureReq("markdown", "notes.md", []byte("# done\n")))
	if err != nil {
		t.Fatalf("post-terminal capture: %v", err)
	}
	if id3 == "" || id3 == id {
		t.Errorf("post-terminal artifact id = %q", id3)
	}
}

// -------------------------------------------------------------------- m3api ---

func TestM3APIStoreReads(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)

	// The worker's registered sandbox state + one volume row, read back
	// through the fleet view.
	reg := &WorkerRegistry{Pool: f.pool}
	if err := reg.UpdateSandboxState(ctx, f.worker, "nono", "0.80.0", "required", true,
		[]string{"self-test:landlock+seccomp"}); err != nil {
		t.Fatalf("UpdateSandboxState: %v", err)
	}
	mustExec(t, f.pool, `
		INSERT INTO worker_volumes (worker_id, root_kind, root_path, st_dev, st_ino, fstype, volume_id)
		VALUES ($1::uuid, 'workspaces', $2, 66, 77, 'ext4', $3)
		ON CONFLICT (worker_id, root_kind) DO UPDATE SET volume_id = EXCLUDED.volume_id`,
		f.worker, f.root, "sha256:"+strings.Repeat("d", 64))

	ws := APIWorkspaceStore{S: &WorkspaceStore{Pool: f.pool}}
	items, err := ws.ListWorkspaces(ctx, f.apiCaller(f.alice, false), f.projA)
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(items) != 1 || items[0].ID != f.wsA {
		t.Fatalf("workspaces = %+v", items)
	}
	if len(items[0].Repos) != 1 || items[0].Repos[0].RunRef != f.token+"/"+f.repoName {
		t.Errorf("repo views = %+v", items[0].Repos)
	}
	// The outsider predicate: an invisible project answers the uniform
	// not-found, never an empty 200 that confirms the project exists.
	_, err = ws.ListWorkspaces(ctx, f.apiCaller(f.outsider, false), f.projA)
	if !errors.Is(err, api.ErrWorkspaceNotFound) {
		t.Errorf("outsider ListWorkspaces err = %v, want ErrWorkspaceNotFound", err)
	}

	mustExec(t, f.pool, `
		UPDATE workspace_repos SET modified_paths = '["a.go"]'::jsonb,
		       excluded_paths = '[".env"]'::jsonb, head_commit = 'beef' WHERE workspace_id = $1::uuid`,
		f.wsA)
	status, err := ws.GetWorkspaceRepoStatus(ctx, f.apiCaller(f.viewer, false), f.wsA, f.repoA)
	if err != nil {
		t.Fatalf("GetWorkspaceRepoStatus: %v", err)
	}
	if !status.Dirty || strings.Join(status.ModifiedPaths, ",") != "a.go" || status.MyRole != "viewer" {
		t.Errorf("status = %+v", status)
	}

	// The turn sandbox read: a journaled sandbox.verified becomes the view.
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type: events.TypeSandboxVerified, OrganizationID: f.orgID, ProjectID: f.projA,
		Actor: events.Actor{Kind: events.ActorKindWorker, ID: f.worker},
		Payload: events.SandboxVerifiedPayload{
			TurnID: f.turnID, WorkspaceID: f.wsA, WorkerID: f.worker,
			Backend: "nono", BackendVersion: "0.80.0", PolicyDigest: "sha256:" + strings.Repeat("e", 64),
			Verified: true, NetworkEnforced: false, AfUnixMediation: "denied",
			Grants: []events.SandboxGrant{{Role: "workspace", Access: "rw"}},
		},
	}); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	sb := APITurnSandboxStore{Pool: f.pool}
	view, err := sb.GetTurnSandbox(ctx, f.apiCaller(f.alice, false), f.turnID)
	if err != nil {
		t.Fatalf("GetTurnSandbox: %v", err)
	}
	if !view.Verified || view.Backend != "nono" || view.Enforcement == nil || *view.Enforcement != "required" {
		t.Errorf("turn sandbox view = %+v", view)
	}
	if len(view.Grants) != 1 || view.Grants[0].Role != "workspace" {
		t.Errorf("grants = %+v", view.Grants)
	}
	if _, err := sb.GetTurnSandbox(ctx, f.apiCaller(f.outsider, false), f.turnID); !errors.Is(err, api.ErrTurnSandboxNotFound) {
		t.Errorf("outsider GetTurnSandbox err = %v, want ErrTurnSandboxNotFound", err)
	}

	sys := APISystemSandboxStore{Pool: f.pool, PinnedBackendVersion: "0.80.0", PolicyDigest: "sha256:" + strings.Repeat("f", 64)}
	workers, err := sys.ListWorkerSandbox(ctx)
	if err != nil {
		t.Fatalf("ListWorkerSandbox: %v", err)
	}
	var found *api.WorkerSandboxStatusView
	for i := range workers {
		if workers[i].WorkerID == f.worker {
			found = &workers[i]
		}
	}
	if found == nil || found.Backend != "nono" || !found.Verified || len(found.Volumes) != 1 {
		t.Errorf("fleet view = %+v", found)
	}
	pinned, digest := sys.Deployment()
	if pinned != "0.80.0" || !strings.HasPrefix(digest, "sha256:") {
		t.Errorf("deployment = %q %q", pinned, digest)
	}
}

// secAllText dumps every text-ish column of the journal and the secret tables
// so "no plaintext in the database" is a grep, not a belief. (It lives beside
// the plaintext-absence test in secrets_test.go conceptually; the existing one
// covers the write path, this one covers the materialization path's events.)
func secAllText(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var b strings.Builder
	var payload string
	if err := pool.QueryRow(testCtx(t), `
		SELECT COALESCE(string_agg(payload::text, E'\n'), '') FROM domain_events`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	b.WriteString(payload)
	if err := pool.QueryRow(testCtx(t), `
		SELECT COALESCE(string_agg(target, E'\n'), '') FROM secret_materializations`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	b.WriteString(payload)
	return b.String()
}

// apiCaller names a real user of the fixture organization; the postgres-side
// Caller mirrors internal/api.Caller without importing the auth plumbing.
func (f *u3Fixture) apiCaller(user string, admin bool) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.orgID, IsOrgAdmin: admin}
}
