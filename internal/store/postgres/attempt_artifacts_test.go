package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/worker"
)

// The artifact.publish writer on a REAL Postgres 18. A mocked green unit test
// never substitutes for this (`12-test-strategy.md`): "a row and its event land
// together under the fence, and a stale triple lands NOTHING" is a statement
// about this database, not about a fake that agrees with me.
//
// The byte backend is deliberately NOT exercised here: Put precedes this call
// (unit_artifacts.go's rule) and is covered by artifacts' own conformance
// suite, so the ref below is a ref a real Put returned, hand-carried. What
// this file proves is the fence, the row and the journal row.

// aaFixture seeds a run whose single worker node has a claimed, live attempt,
// and returns the claim the current owner holds.
func aaFixture(t *testing.T) (*m4Fixture, *AttemptArtifacts, worker.AttemptClaim) {
	t.Helper()
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	f.m4WorkerNode(t, ctx, runID, "/evidence")
	workerID := m4Worker(t, ctx, f.pool, "artifacts", 1)
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%v, %v), want one attempt", claims, err)
	}
	if err := store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	c := claims[0]
	// The adapter's own row must go before the project it hangs off can.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM artifacts WHERE project_id = $1::uuid`, f.projectID); err != nil {
			t.Errorf("cleanup artifacts: %v", err)
		}
	})
	return f, &AttemptArtifacts{Pool: f.pool}, c
}

// aaInput is one publish's material: bytes already in the backend.
func aaInput(f *m4Fixture, c worker.AttemptClaim, body string, redactions int) worker.AttemptArtifactInput {
	sum := sha256.Sum256([]byte(body))
	digest := hex.EncodeToString(sum[:])
	return worker.AttemptArtifactInput{
		OrganizationID: c.OrganizationID, ProjectID: c.ProjectID,
		RunID: c.RunID, NodeExecutionID: c.NodeExecutionID, AttemptID: c.AttemptID,
		WorkerID: c.WorkerID, FencingToken: c.FencingToken,
		Name: "exit-report", Kind: artifacts.KindJSON, MediaType: "application/json",
		Sensitivity: artifacts.SensitivityStandard,
		Ref: artifacts.Ref{
			ProjectID: c.ProjectID, StorageBackend: artifacts.BackendLocal,
			StorageKey: "projects/" + c.ProjectID + "/" + digest,
			SHA256:     digest, SizeBytes: int64(len(body)),
		},
		RedactionCount: redactions,
	}
}

// TestAttemptArtifactsPublishCurrentFence is the happy path of contract § 4
// step 9: the row lands `ready` with the attempt's correlation ids and the
// scanner's count, and artifact.created rides in the SAME transaction.
func TestAttemptArtifactsPublishCurrentFence(t *testing.T) {
	ctx := testCtx(t)
	f, rows, c := aaFixture(t)

	id, err := rows.PublishAttemptArtifact(ctx, aaInput(f, c, `{"evidence":"ok"}`, 0))
	if err != nil {
		t.Fatalf("PublishAttemptArtifact: %v", err)
	}
	if !prjValidUUID(id) {
		t.Fatalf("artifact id %q is not a uuid", id)
	}
	var name, kind, state, sens, media, runID, nodeID, attemptID, workerID, createdBy string
	var redactions int
	var size int64
	var key, sha, backend string
	var ready bool
	if err := f.pool.QueryRow(ctx, `
		SELECT name, kind, media_type, state, sensitivity, sha256, size_bytes,
		       storage_backend, storage_key, redaction_count, created_by,
		       run_id::text, node_execution_id::text, attempt_id::text, worker_id::text,
		       ready_at IS NOT NULL
		FROM artifacts WHERE id = $1::uuid`, id).
		Scan(&name, &kind, &media, &state, &sens, &sha, &size, &backend, &key,
			&redactions, &createdBy, &runID, &nodeID, &attemptID, &workerID, &ready); err != nil {
		t.Fatalf("read artifact row: %v", err)
	}
	if state != "ready" || !ready {
		t.Errorf("artifact state = %q ready_at set = %v, want ready/true (ADR-0020 D2: never serve an uploading row)", state, ready)
	}
	if runID != c.RunID || nodeID != c.NodeExecutionID || attemptID != c.AttemptID || workerID != c.WorkerID {
		t.Errorf("correlation columns = (%s, %s, %s, %s), want (%s, %s, %s, %s)",
			runID, nodeID, attemptID, workerID, c.RunID, c.NodeExecutionID, c.AttemptID, c.WorkerID)
	}
	if name != "exit-report" || kind != artifacts.KindJSON || media != "application/json" ||
		sens != artifacts.SensitivityStandard {
		t.Errorf("artifact identity = (%q, %q, %q, %q)", name, kind, media, sens)
	}
	if redactions != 0 {
		t.Errorf("redaction_count = %d, want the scanner's 0 kept as 0 (ADR-0020 D4)", redactions)
	}
	if size != int64(len(`{"evidence":"ok"}`)) || key == "" || backend != artifacts.BackendLocal {
		t.Errorf("bytes columns = (%d, %q, %q)", size, key, backend)
	}
	if createdBy != c.WorkerID {
		t.Errorf("created_by = %q, want the owning worker %q", createdBy, c.WorkerID)
	}

	// One artifact.created, correlated to the same triple, actor = the worker.
	var evType, actorKind, actorID, evRun, evNode, evAttempt string
	if err := f.pool.QueryRow(ctx, `
		SELECT type, actor_kind, actor_id, run_id::text, node_execution_id::text, attempt_id::text
		FROM domain_events WHERE type = 'artifact.created' AND attempt_id = $1::uuid`, c.AttemptID).
		Scan(&evType, &actorKind, &actorID, &evRun, &evNode, &evAttempt); err != nil {
		t.Fatalf("artifact.created was not appended in the publish transaction: %v", err)
	}
	if evType != "artifact.created" || actorKind != "worker" || actorID != c.WorkerID {
		t.Errorf("event = (%s, %s, %s)", evType, actorKind, actorID)
	}
	if evRun != c.RunID || evNode != c.NodeExecutionID || evAttempt != c.AttemptID {
		t.Errorf("event correlation = (%s, %s, %s), want the attempt triple", evRun, evNode, evAttempt)
	}
	var payloadArtifact string
	if err := f.pool.QueryRow(ctx,
		`SELECT payload->>'artifact_id' FROM domain_events
		  WHERE type = 'artifact.created' AND attempt_id = $1::uuid`, c.AttemptID).
		Scan(&payloadArtifact); err != nil {
		t.Fatalf("read event payload: %v", err)
	}
	if payloadArtifact != id {
		t.Errorf("event artifact_id = %q, want the row's id %q", payloadArtifact, id)
	}
	// The storage key is never in a payload (ADR-0020: the journal is public).
	var keyLeaks int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid AND payload::text LIKE $2`,
		c.AttemptID, "%"+key+"%").Scan(&keyLeaks); err != nil {
		t.Fatalf("scan payload: %v", err)
	}
	if keyLeaks != 0 {
		t.Errorf("the storage key leaked into %d event payloads", keyLeaks)
	}
}

// TestAttemptArtifactsStaleFenceLandsNothing is `12` case 3 for this writer: a
// token the re-claim rotated answers with the loop's typed "I am dead" error
// and writes neither row nor event.
func TestAttemptArtifactsStaleFenceLandsNothing(t *testing.T) {
	ctx := testCtx(t)
	f, rows, c := aaFixture(t)

	stolen := c
	stolen.FencingToken = c.FencingToken + 1
	artifactsBefore := awCount(t, ctx, f, `SELECT count(*) FROM artifacts WHERE run_id = $1::uuid`, c.RunID)
	eventsBefore := awCount(t, ctx, f,
		`SELECT count(*) FROM domain_events WHERE type = 'artifact.created' AND attempt_id = $1::uuid`, c.AttemptID)

	if _, err := rows.PublishAttemptArtifact(ctx, aaInput(f, stolen, `{"evidence":"stale"}`, 3)); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("publish on a stale token = %v, want worker.ErrLeaseLost", err)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM artifacts WHERE run_id = $1::uuid`, c.RunID); n != artifactsBefore {
		t.Errorf("stale publish inserted artifacts rows: %d -> %d", artifactsBefore, n)
	}
	if n := awCount(t, ctx, f,
		`SELECT count(*) FROM domain_events WHERE type = 'artifact.created' AND attempt_id = $1::uuid`, c.AttemptID); n != eventsBefore {
		t.Errorf("stale publish appended events: %d -> %d", eventsBefore, n)
	}

	// A different owner on the same token is the same refusal.
	byOwner := c
	byOwner.WorkerID = strings.Repeat("0", 36)
	if _, err := rows.PublishAttemptArtifact(ctx, aaInput(f, byOwner, `{"evidence":"other"}`, 0)); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("publish by a non-owner = %v, want worker.ErrLeaseLost", err)
	}

	// And a terminal attempt is not "live" even for its own last owner.
	if _, err := f.pool.Exec(ctx, `
		UPDATE attempts SET status = 'cancelled', finished_at = now() WHERE id = $1::uuid`, c.AttemptID); err != nil {
		t.Fatalf("close the attempt: %v", err)
	}
	if _, err := rows.PublishAttemptArtifact(ctx, aaInput(f, c, `{"evidence":"late"}`, 0)); !errors.Is(err, worker.ErrLeaseLost) {
		t.Fatalf("publish after the attempt closed = %v, want worker.ErrLeaseLost", err)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM artifacts WHERE run_id = $1::uuid`, c.RunID); n != artifactsBefore {
		t.Errorf("refused publishes left %d artifacts rows, want %d", n, artifactsBefore)
	}
}

// TestAttemptArtifactsRetryDedupes proves ADR-0020 D2's content addressing
// survives a retried attempt: the same bytes under the same fence are ONE row,
// with the two scans' redaction counts folded together.
func TestAttemptArtifactsRetryDedupes(t *testing.T) {
	ctx := testCtx(t)
	f, rows, c := aaFixture(t)

	first, err := rows.PublishAttemptArtifact(ctx, aaInput(f, c, `{"same":true}`, 1))
	if err != nil {
		t.Fatalf("first publish: %v", err)
	}
	second, err := rows.PublishAttemptArtifact(ctx, aaInput(f, c, `{"same":true}`, 2))
	if err != nil {
		t.Fatalf("retried publish: %v", err)
	}
	if first != second {
		t.Errorf("retried publish created %s beside %s", second, first)
	}
	if n := awCount(t, ctx, f, `SELECT count(*) FROM artifacts WHERE id = $1::uuid`, first); n != 1 {
		t.Errorf("artifacts rows for the retried digest = %d, want 1", n)
	}
	var redactions int
	if err := f.pool.QueryRow(ctx,
		`SELECT redaction_count FROM artifacts WHERE id = $1::uuid`, first).Scan(&redactions); err != nil {
		t.Fatal(err)
	}
	if redactions != 3 {
		t.Errorf("redaction_count = %d after a 1 + a 2, want the counts folded to 3", redactions)
	}
}
