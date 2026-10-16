package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// TestRunSecretValues covers § 4 step 9's scan input: the values a run's
// attempts were handed, read back out of secret_materializations and re-resolved
// through the real keyring path. The correlation is the whole point — a value
// materialized for run A must not be pulled into run B's scan, and a value run B
// holds must not leak into run A's artifact either. Fixtures use the real
// CreateSecret/AddSecretVersion write path, so the resolver decrypts a real
// secret_versions row rather than a test's own encoding of one.

const rsvSentinel = "ghp_rsvSentinelValue0123456789abcdef"

// rsvFixture is an m4 run-fixture plus the secret write path and one worker.
type rsvFixture struct {
	f        *m4Fixture
	store    *SecretStore
	workerID string
	profile  string
	slug     func(string) string
}

func rsvSetup(t *testing.T) *rsvFixture {
	t.Helper()
	ctx := testCtx(t)
	f := m4Setup(t)
	// The m4 fixture's user created the project; the secret write path asks the
	// role question, so give it the maintainer membership the API would have.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
		f.projectID, f.userID, "maintainer"); err != nil {
		t.Fatalf("grant maintainer: %v", err)
	}
	var profile string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`,
		f.orgID).Scan(&profile); err != nil {
		t.Fatalf("seeded profile lookup (migration 00003): %v", err)
	}
	x := &rsvFixture{
		f:        f,
		store:    &SecretStore{Pool: f.pool, Keys: secKeyring(t)},
		workerID: m4Worker(t, ctx, f.pool, "rsv", 2),
		profile:  profile,
		slug:     func(label string) string { return "rsv-" + migFixtureToken(t) + "-" + label },
	}
	// The m4 cleanup unwinds runs and attempts but not the secret rows this test
	// writes through the real path, and projects.id is referenced by
	// secret_metadata — so this fixture's own teardown runs first (LIFO).
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			`DELETE FROM secret_materializations WHERE project_id = $1`,
			`DELETE FROM secret_mounts WHERE project_id = $1`,
			`DELETE FROM secret_versions WHERE secret_id IN
				(SELECT id FROM secret_metadata WHERE project_id = $1)`,
			`DELETE FROM secret_metadata WHERE project_id = $1`,
			`DELETE FROM memberships WHERE project_id = $1`,
		} {
			if _, err := f.pool.Exec(bg, q, f.projectID); err != nil {
				t.Errorf("secret cleanup %q: %v", q, err)
			}
		}
	})
	return x
}

// run plants one root run with a worker-executed node and a queued attempt, and
// returns (runID, attemptID). The shapes are the minimum § 4 step 2/5 rows a
// materialization can name; attempts stay queued so no lease constraint fires.
func (x *rsvFixture) run(t *testing.T, label string) (string, string) {
	t.Helper()
	ctx := testCtx(t)
	f := x.f
	var runID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb)
		RETURNING id`, f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest, f.planDigest).
		Scan(&runID); err != nil {
		t.Fatalf("insert run %s: %v", label, err)
	}
	var conversation string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, 'rsv', $3::uuid) RETURNING id`,
		f.projectID, x.profile, f.userID).Scan(&conversation); err != nil {
		t.Fatalf("insert conversation %s: %v", label, err)
	}
	var turn string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
		VALUES ($1::uuid, 'rsv fixture turn', $2::uuid) RETURNING id`, conversation, f.userID).
		Scan(&turn); err != nil {
		t.Fatalf("insert turn %s: %v", label, err)
	}
	var nodeID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, ready_at)
		VALUES ($1::uuid, 'work_' || $2, 'agent.acp', '/work_' || $2, 'worker', 'ready', now())
		RETURNING id`, runID, label).Scan(&nodeID); err != nil {
		t.Fatalf("insert node execution %s: %v", label, err)
	}
	var attemptID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number, turn_id, conversation_id)
		VALUES ($1::uuid, $2::uuid, 1, $3::uuid, $4::uuid) RETURNING id`,
		nodeID, runID, turn, conversation).Scan(&attemptID); err != nil {
		t.Fatalf("insert attempt %s: %v", label, err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE conversation_turns SET node_attempt_id = $1::uuid WHERE id = $2::uuid`,
		attemptID, turn); err != nil {
		t.Fatalf("stamp attempt turn %s: %v", label, err)
	}
	return runID, attemptID
}

// deliver materializes `value` for one attempt through the real write path: a
// secret created and sealed by SecretStore, a version on it, and the
// node_attempt ledger row RecordMaterialization produces.
func (x *rsvFixture) deliver(t *testing.T, label, value, attemptID string) string {
	t.Helper()
	ctx := testCtx(t)
	f := x.f
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID}
	secret, err := x.store.CreateSecret(ctx, caller, f.projectID, NewSecret{
		Slug: x.slug(label), Purpose: "run secret scan fixture", DeliveryMode: "env",
		Profiles: []string{x.profile}, Value: []byte(value),
	})
	if err != nil {
		t.Fatalf("CreateSecret(%s): %v", label, err)
	}
	if _, err := x.store.RecordMaterialization(ctx, NewSecretMaterialization{
		SecretID: secret.ID, SecretVersion: secret.CurrentVersion,
		OrganizationID: f.orgID, ProjectID: f.projectID, WorkerID: x.workerID,
		AttemptID: attemptID, DeliveryMode: "env", Target: "RSV_" + strings.ToUpper(label),
	}, events.SecretMaterializedPayload{
		SecretID: secret.ID, ProjectID: f.projectID, Slug: secret.Slug,
		Version: secret.CurrentVersion, DeliveryMode: "env", EnvName: "RSV_" + strings.ToUpper(label),
		Lifecycle: "node_attempt", PolicyDigest: m4Digest("policy/" + label),
	}); err != nil {
		t.Fatalf("record materialization %s: %v", label, err)
	}
	return secret.ID
}

func TestRunSecretValuesReturnsRunAValuesAndNotRunBs(t *testing.T) {
	x := rsvSetup(t)
	ctx := testCtx(t)
	runA, attemptA := x.run(t, "a")
	runB, attemptB := x.run(t, "b")
	x.deliver(t, "alpha", rsvSentinel, attemptA)
	x.deliver(t, "beta", "ghp_rsvOtherRunValue-fedcba9876543210", attemptB)

	scanner := &RunSecretValues{Pool: x.f.pool, Secrets: x.store}
	values, err := scanner.Values(ctx, runA)
	if err != nil {
		t.Fatalf("Values(run A): %v", err)
	}
	if len(values) != 1 {
		t.Fatalf("Values(run A) returned %d values, want exactly the one attempt of run A held: %q",
			len(values), firstRunes(values))
	}
	if string(values[0]) != rsvSentinel {
		t.Errorf("Values(run A) resolved the wrong version: %q", string(values[0]))
	}
	// Run B holds a different value; the scan must not import it, and must not
	// import run A's either when asked about B.
	others, err := scanner.Values(ctx, runB)
	if err != nil {
		t.Fatalf("Values(run B): %v", err)
	}
	if len(others) != 1 || string(others[0]) == rsvSentinel {
		t.Fatalf("Values(run B) = %q, want only run B's own value (cross-run leak or wrong pin)",
			firstRunes(others))
	}
	// A run with no materialization at all is a fact, not a failure.
	emptyRun, _ := x.run(t, "c")
	none, err := scanner.Values(ctx, emptyRun)
	if err != nil || len(none) != 0 {
		t.Fatalf("Values(run with no mounts) = %d values, err %v; want none", len(none), err)
	}
	// The hook the executor consumes counts the replacement.
	redact, wipe, err := scanner.Redactor(ctx, runA)
	if err != nil {
		t.Fatalf("Redactor(run A): %v", err)
	}
	defer wipe()
	if redact == nil {
		t.Fatal("Redactor(run A) is nil, want a hook over run A's materialized value")
	}
	text, count := redact(`{"token":"` + rsvSentinel + `"}`)
	if count != 1 || strings.Contains(text, rsvSentinel) {
		t.Errorf("hook returned count %d, %q, want 1 with the value replaced", count, text)
	}
	if !strings.Contains(text, "[REDACTED]") {
		t.Errorf("no marker in the redacted text: %q", text)
	}
	// The value never appears in what the scan reports back to the attempt.
	if strings.Contains(text, "ghp_rsv") {
		t.Errorf("a fragment of the value survived the scan: %q", text)
	}
}

// TestRunSecretValuesUnresolvableFailsThePublishAttempt proves the fail-closed
// half of § 4 step 9: a value the ledger names but the keyring cannot open must
// stop the publish, not degrade it. The scan runs against a foreign keyring
// (secrets_test.go's orphan pattern), so the resolve refuses exactly the way a
// rotated-away key would in production, and the executor's byte backend records
// whether a Put ever happened.
func TestRunSecretValuesUnresolvableFailsThePublishAttempt(t *testing.T) {
	x := rsvSetup(t)
	ctx := testCtx(t)
	runID, attemptID := x.run(t, "orphan")
	x.deliver(t, "gamma", rsvSentinel, attemptID)

	scanner := &RunSecretValues{Pool: x.f.pool, Secrets: &SecretStore{Pool: x.f.pool, Keys: secKeyring(t, 9)}}
	if _, err := scanner.Values(ctx, runID); err == nil {
		t.Fatal("Values resolved a version whose key the keyring does not hold")
	}

	bytesFake := &rsvBytesFake{}
	rowsFake := &rsvRowsFake{}
	scan := &ArtifactPublishSecretScan{
		Publish: &worker.ArtifactPublish{Bytes: bytesFake, Rows: rowsFake, Checkpoints: rsvBoundary{}},
		Values:  scanner,
	}
	res, err := scan.Execute(ctx, rsvClaim(runID, map[string]any{
		"name": "leak.json", "kind": "json",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{"token": "not-the-secret"}},
	}), nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != worker.AttemptStatusFailed {
		t.Fatalf("status = %s, want failed (an unscanned artifact may never publish)", res.Status)
	}
	if res.ErrorClass != worker.ErrorClassSandboxEnforcementFail {
		t.Errorf("error_class = %q, want %q (ADR-0023 § 7's sandbox/secret arm)",
			res.ErrorClass, worker.ErrorClassSandboxEnforcementFail)
	}
	if len(bytesFake.puts) != 0 || len(rowsFake.calls) != 0 {
		t.Fatalf("puts=%d rows=%d, want 0 and 0: the scan precedes Put", len(bytesFake.puts), len(rowsFake.calls))
	}
	if strings.Contains(res.Detail, rsvSentinel) || len(res.Detail) > 512 {
		t.Errorf("attempt detail is unsafe or oversized: %q", res.Detail)
	}

	// And with the right keyring the same run publishes with the value replaced
	// and counted: the count is real, not the placeholder 0 of 17ffa32.
	scan.Values = &RunSecretValues{Pool: x.f.pool, Secrets: x.store}
	res, err = scan.Execute(ctx, rsvClaim(runID, map[string]any{
		"name": "leak.json", "kind": "json",
		"from": map[string]any{"mode": "output_json",
			"value": map[string]any{"token": rsvSentinel}},
	}), nil)
	if err != nil {
		t.Fatalf("Execute with the real keyring: %v", err)
	}
	if res.Status != worker.AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if len(bytesFake.puts) != 1 {
		t.Fatalf("puts = %d, want 1", len(bytesFake.puts))
	}
	if strings.Contains(string(bytesFake.puts[0].body), rsvSentinel) {
		t.Errorf("the run's secret reached published bytes: %s", bytesFake.puts[0].body)
	}
	if rowsFake.calls[0].RedactionCount != 1 {
		t.Errorf("row redaction_count = %d, want 1 (ADR-0020 D4)", rowsFake.calls[0].RedactionCount)
	}
}

func rsvClaim(runID string, cfg map[string]any) worker.AttemptClaim {
	return worker.AttemptClaim{
		AttemptID: "attempt-1", NodeExecutionID: "node-exec-1", RunID: runID,
		ProjectID: "project-1", OrganizationID: "org-1", WorkerID: "worker-1",
		FencingToken: 7, NodeID: "publish_verified", NodeInstanceKey: "/publish_verified",
		Kind: worker.NodeKindArtifactPublish, AttemptNumber: 1, Config: cfg,
	}
}

func firstRunes(values [][]byte) string {
	parts := make([]string, 0, len(values))
	for _, v := range values {
		r := []rune(string(v))
		if len(r) > 8 {
			r = r[:8]
		}
		parts = append(parts, string(r))
	}
	return strings.Join(parts, ",")
}

// --- fakes for the publish path (bytes and rows only) --------------------

type rsvPut struct {
	in   artifacts.Input
	body []byte
}

type rsvBytesFake struct{ puts []rsvPut }

var _ artifacts.Store = (*rsvBytesFake)(nil)

func (f *rsvBytesFake) Put(_ context.Context, in artifacts.Input) (artifacts.Ref, error) {
	body, err := io.ReadAll(in.Body)
	if err != nil {
		return artifacts.Ref{}, err
	}
	f.puts = append(f.puts, rsvPut{in: in, body: body})
	return artifacts.Ref{ProjectID: in.ProjectID, StorageBackend: "memory",
		StorageKey: "k", SHA256: fmt.Sprintf("%x", len(body)), SizeBytes: int64(len(body)),
		MediaType: in.MediaType}, nil
}

func (f *rsvBytesFake) Open(context.Context, artifacts.Ref) (io.ReadCloser, int64, error) {
	return nil, 0, errors.New("rsv test: unused")
}
func (f *rsvBytesFake) Stat(context.Context, artifacts.Ref) (artifacts.Ref, error) {
	return artifacts.Ref{}, errors.New("rsv test: unused")
}
func (f *rsvBytesFake) Delete(context.Context, artifacts.Ref) error {
	return errors.New("rsv test: unused")
}
func (f *rsvBytesFake) Presign(context.Context, artifacts.Ref, time.Duration, string) (string, time.Time, error) {
	return "", time.Time{}, errors.New("rsv test: unused")
}

type rsvRowsFake struct{ calls []worker.AttemptArtifactInput }

var _ worker.AttemptArtifactWriter = (*rsvRowsFake)(nil)

func (f *rsvRowsFake) PublishAttemptArtifact(_ context.Context, in worker.AttemptArtifactInput) (string, error) {
	f.calls = append(f.calls, in)
	return "artifact-rsv", nil
}

// rsvBoundary is a stub § 4 step 3 boundary resolver: this file tests the
// secret scan, and its fake run carries no `workspaces` row, so the pool-backed
// RunWorkspaces the scan would otherwise wire would correctly refuse (no
// boundary bound) and bury the scan assertion under an infra detail. In the real
// worker path the RunWorkspaceExecutor wrapper prepares the run tree before
// publish, so a boundary always exists by § 4 step 9; the stub reproduces that
// precondition without dragging workspace preparation into a scan test.
type rsvBoundary struct{}

var _ worker.RunWorkspaceResolver = rsvBoundary{}

func (rsvBoundary) RunWorkspace(context.Context, string) (worker.RunWorkspaceRef, bool, error) {
	return worker.RunWorkspaceRef{WorkspaceID: "ws-rsv-1", VolumeID: "sha256:vol-rsv-1"}, true, nil
}
