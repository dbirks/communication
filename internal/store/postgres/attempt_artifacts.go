package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// AttemptArtifacts is the production worker.AttemptArtifactWriter: the fenced
// row + artifact.created transaction behind artifact.publish (contract § 4
// step 9, ADR-0016 § 9.2, ADR-0020 D2). It is the attempt-shaped sibling of
// UnitArtifacts.PublishArtifact and copies that method's rules verbatim,
// because the rules are not M3's — they are the journal's:
//
//   - The bytes are already in the backend when this runs. Put precedes the
//     row and never the reverse: a `ready` row naming a key that does not
//     exist would 404 from its own handler.
//   - The row and its artifact.created land in ONE transaction under the
//     attempt's fence (id + worker + fencing token, and the attempt still
//     live). "A row exists without its event" is the split ADR-0016 § 9 makes
//     unrepresentable.
//   - A stale triple lands NOTHING and answers with worker.ErrLeaseLost, the
//     same typed error the rest of the attempt loop branches on, so the
//     executor reads it as "I am dead" and does not retry (§ 4 step 10).
//   - Dedupe is the owner-scoped artifacts_run_dedupe_idx (migration 00019,
//     ADR-0020 D2's 2026-10-27 amendment): a retried publish of the same node
//     folds its redaction count into the row the first writer created rather
//     than double-counting storage, while identical bytes in ANOTHER run (or
//     at another node) get their own row — a run's evidence is never
//     re-attributed away from it.
//
// redaction_count is carried through untouched: 0 means "the scanner ran and
// saw nothing", which must stay distinguishable from "the scanner is broken"
// (ADR-0020 D4), so this writer neither invents nor drops the number.
type AttemptArtifacts struct {
	Pool *pgxpool.Pool
}

// Compile-time proof of the seam.
var _ worker.AttemptArtifactWriter = (*AttemptArtifacts)(nil)

// PublishAttemptArtifact implements worker.AttemptArtifactWriter and returns
// the artifact row's id.
func (a *AttemptArtifacts) PublishAttemptArtifact(ctx context.Context, in worker.AttemptArtifactInput) (string, error) {
	if a == nil || a.Pool == nil {
		return "", errors.New("postgres: attempt artifact writer is not wired")
	}
	if in.WorkerID == "" || !prjValidUUID(in.AttemptID) || !prjValidUUID(in.RunID) || in.Ref.StorageKey == "" {
		return "", errors.New("postgres: attempt artifact publish needs an attempt, a run, a worker and bytes already in the backend")
	}
	sensitivity := in.Sensitivity
	if sensitivity == "" {
		sensitivity = artifacts.SensitivityStandard
	}
	if !artifacts.ValidKind(in.Kind) || !artifacts.ValidSensitivity(sensitivity) {
		return "", fmt.Errorf("postgres: artifact kind %q / sensitivity %q is not in the table enum", in.Kind, sensitivity)
	}
	name := in.Name
	if name == "" {
		name = in.Kind + "-" + in.AttemptID
	}
	claim := AttemptClaim{
		RunID: in.RunID, NodeExecutionID: in.NodeExecutionID, AttemptID: in.AttemptID,
		ProjectID: in.ProjectID, OrganizationID: in.OrganizationID,
		WorkerID: in.WorkerID, FencingToken: in.FencingToken,
	}
	var id string
	err := (&RunStore{Pool: a.Pool}).runWithFencedTx(ctx, claim, true, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO artifacts
				(organization_id, project_id, run_id, node_execution_id, attempt_id, worker_id,
				 name, kind, media_type, sha256, size_bytes,
				 storage_backend, storage_key, sensitivity, state, redaction_count, created_by, ready_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4,'')::uuid, $5::uuid, $6::uuid,
			        $7, $8, $9, $10, $11,
			        $12, $13, $14, 'ready', $15, $16, now())
			ON CONFLICT (run_id, node_execution_id, kind, sha256)
			    WHERE attempt_id IS NOT NULL DO UPDATE SET
			    name = EXCLUDED.name,
			    attempt_id = EXCLUDED.attempt_id,
			    worker_id = EXCLUDED.worker_id,
			    redaction_count = artifacts.redaction_count + EXCLUDED.redaction_count
			RETURNING id::text`,
			in.OrganizationID, in.ProjectID, in.RunID, prjCleanUUID(in.NodeExecutionID),
			prjCleanUUID(in.AttemptID), prjCleanUUID(in.WorkerID),
			name, in.Kind, in.MediaType, in.Ref.SHA256, in.Ref.SizeBytes,
			in.Ref.StorageBackend, in.Ref.StorageKey, sensitivity, in.RedactionCount, in.WorkerID,
		).Scan(&id); err != nil {
			return fmt.Errorf("postgres: insert attempt artifact row: %w", err)
		}
		if _, err := runAppendTx(ctx, tx, in.RunID, in.NodeExecutionID, in.AttemptID, RunEvent{
			Type: events.TypeArtifactCreated, ActorKind: events.ActorKindWorker, ActorID: in.WorkerID,
			Payload: events.ArtifactCreatedPayload{
				ArtifactID: id, ProjectID: in.ProjectID, Name: name, Kind: in.Kind,
				MediaType: in.MediaType, SHA256: in.Ref.SHA256, SizeBytes: in.Ref.SizeBytes,
				Sensitivity: sensitivity, RedactionCount: in.RedactionCount,
			},
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return "", attemptErrStaleLease(err)
	}
	return id, nil
}
