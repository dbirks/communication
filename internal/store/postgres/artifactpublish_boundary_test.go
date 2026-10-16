package postgres

// TestArtifactPublishBoundaryLands is the real-Postgres reproduction of the M4
// lab failure: many `feature-development-deterministic` runs ended
// `failed node_execution_failed:/publish_verified` with NO failed attempt. The
// cause was the executor publishing bytes but carrying no checkpoint boundary,
// so the fenced `CompleteAttempt` refused the success ("completed without a
// checkpoint volume", D-024) — the write failed, the lease lapsed, and the
// reconciler closed the attempt interrupted{lease_expired}. This drives the
// whole § 4 step 9 → step 10 path on a real run with a real prepared workspace
// and asserts the boundary transaction now lands.

import (
	"context"
	"testing"

	"errors"
	"io"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/worker"
)

func TestArtifactPublishBoundaryLands(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)
	// § 4 step 3's prepared tree: the RunWorkspaceExecutor wrapper guarantees
	// this before any publish body runs, so the boundary resolver can name it.
	workerID := m4Worker(t, ctx, f.pool, "pub-boundary", 2)
	volumeID := runWorkspaceVolume(t, ctx, f.pool, workerID, "pub-boundary")
	repoID := runWorkspaceRepo(t, ctx, f.pool, f)
	runs := &RunWorkspaces{Pool: f.pool}
	ref, prepErr := runs.Prepare(ctx, runID, workerID, volumeID,
		[]worker.CheckpointRepoState{{RepositoryID: repoID, BaseCommit: m4Digest("base")}})
	if prepErr != nil {
		t.Fatalf("prepare run workspace: %v", prepErr)
	}
	// This test is the one that writes run_checkpoints rows for the run, and
	// run_checkpoints references workspaces, so it also owns deleting them
	// first — registered last, it runs first (t.Cleanup is LIFO), before the
	// runWorkspaceVolume cleanup above can be blocked by that FK.
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM run_checkpoints WHERE run_id = $1::uuid OR workspace_id = $2::uuid`,
			runID, ref.WorkspaceID)
	})

	nodeID, attemptID := f.m4WorkerNode(t, ctx, runID, "/publish_verified")
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim = (%d, %v), want one", len(claims), err)
	}
	c := claims[0]
	if c.AttemptID != attemptID {
		t.Fatalf("claim %s != queued attempt %s", c.AttemptID, attemptID)
	}
	if err := store.BeginAttempt(ctx, c); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	// The claim carries the compiled node config the executor reads.
	c.NodeID, c.Kind = "publish_verified", worker.NodeKindArtifactPublish
	c.Config = map[string]any{"name": "review-evidence.json", "kind": "json",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{"approved": true}}}

	bytesFake := &pubBoundaryBytes{root: u3ArtifactRoot(t)}
	rowsFake := &AttemptArtifacts{Pool: f.pool}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM artifacts WHERE project_id = $1::uuid`, f.projectID); err != nil {
			t.Errorf("cleanup artifacts: %v", err)
		}
	})
	scan := &ArtifactPublishSecretScan{
		Publish: &worker.ArtifactPublish{Bytes: bytesFake, Rows: rowsFake},
		Values:  &RunSecretValues{Pool: f.pool, Secrets: &SecretStore{Pool: f.pool, Keys: secKeyring(t)}},
	}
	res, err := scan.Execute(ctx, c, nil)
	if err != nil {
		t.Fatalf("scan.Execute: %v", err)
	}
	if res.Status != worker.AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded — the boundary must be bound now",
			res.Status, res.ErrorClass, res.Detail)
	}
	if res.Checkpoint.VolumeID != volumeID {
		t.Fatalf("checkpoint volume = %q, want the run's volume %q", res.Checkpoint.VolumeID, volumeID)
	}

	// The boundary transaction that previously refused (§ 4 step 10).
	if err := store.CompleteAttempt(ctx, c, res.Outputs, res.OutputsDigest, res.ArtifactRefs,
		res.Outcome, res.Checkpoint); err != nil {
		t.Fatalf("CompleteAttempt: %v", err)
	}

	ck := awCount(t, ctx, f, `SELECT count(*) FROM run_checkpoints WHERE run_id = $1::uuid`, runID)
	if ck != 1 {
		t.Errorf("run_checkpoints = %d, want 1 for the succeeded publish", ck)
	}
	var vol string
	if err := f.pool.QueryRow(ctx,
		`SELECT volume_id FROM run_checkpoints WHERE run_id = $1::uuid`, runID).Scan(&vol); err != nil {
		t.Fatalf("read checkpoint volume: %v", err)
	}
	if vol != volumeID {
		t.Errorf("checkpoint volume = %q, want the same-volume identity %q (D-024)", vol, volumeID)
	}
	var nodeStatus string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM node_executions WHERE id = $1::uuid`, nodeID).Scan(&nodeStatus); err != nil {
		t.Fatalf("read node status: %v", err)
	}
	if nodeStatus != "succeeded" {
		t.Errorf("node status = %q, want succeeded", nodeStatus)
	}
	// No interrupted arm for the attempt: the success landed, nothing for the
	// reconciler to close (the lab's symptom).
	if n := awCount(t, ctx, f,
		`SELECT count(*) FROM domain_events WHERE attempt_id = $1::uuid
		   AND type = 'node.attempt.interrupted'`, attemptID); n != 0 {
		t.Errorf("interrupted events = %d, want 0 (the bug closed the attempt interrupted)", n)
	}
	var hasArtifact bool
	if err := f.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM artifacts WHERE run_id = $1::uuid AND kind = $2)`,
		runID, artifacts.KindJSON).Scan(&hasArtifact); err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if !hasArtifact {
		t.Errorf("no artifact row for the published review-evidence.json")
	}
}

// pubBoundaryBytes is the ADR-0020 local byte backend rooted in a temp dir, so
// Put returns a Ref whose sha256/size satisfy artifacts' real CHECKs (the rsv
// fake's placeholder sha256 does not). Only Put is used on the publish path.
type pubBoundaryBytes struct{ root string }

func (b *pubBoundaryBytes) store() (artifacts.Store, error) {
	return artifacts.NewLocal(artifacts.LocalConfig{Root: b.root})
}

func (b *pubBoundaryBytes) Put(ctx context.Context, in artifacts.Input) (artifacts.Ref, error) {
	s, err := b.store()
	if err != nil {
		return artifacts.Ref{}, err
	}
	return s.Put(ctx, in)
}
func (b *pubBoundaryBytes) Open(context.Context, artifacts.Ref) (io.ReadCloser, int64, error) {
	return nil, 0, errors.New("unused")
}
func (b *pubBoundaryBytes) Stat(context.Context, artifacts.Ref) (artifacts.Ref, error) {
	return artifacts.Ref{}, errors.New("unused")
}
func (b *pubBoundaryBytes) Delete(context.Context, artifacts.Ref) error { return errors.New("unused") }
func (b *pubBoundaryBytes) Presign(context.Context, artifacts.Ref, time.Duration, string) (string, time.Time, error) {
	return "", time.Time{}, errors.New("unused")
}
