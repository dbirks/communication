package postgres

// The database half of run-workspace preparation (docs/m4-contract.md § 4
// step 3, ADR-0017 per-scope refs, ADR-0023 § 4's one-way affinity door).
//
// Until now nothing wrote the run arm of `workspaces`, so ProcExec had no
// boundary to record and every successful process.exec closed as infra with
// Checkpoints nil (contract deviation D-024's same-volume rule needs a volume
// id that only this row can supply).
//
// Two rules govern this file, copied from m4api.go's discipline:
//
//   - Preparation is ONE transaction. The `workspaces` row and
//     runs.worker_affinity/worker_volume_id commit together or not at all:
//     affinity without a workspace would strand the run on a worker that has
//     no tree, and a workspace without affinity would let a second worker
//     clone a second copy of the same run (contract § 4 step 3's refusal).
//   - A different worker is refused, never accommodated. The answer is the
//     typed ErrRunWorkspaceDifferentWorker plus a `workspace.recovery_lost`
//     row with reason 'different_worker' written in that same transaction —
//     the honest arm case 20 requires, not a silent re-clone.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// RunWorkspaces satisfies worker.RunWorkspaceResolver and writes § 4 step 3.
type RunWorkspaces struct {
	Pool *pgxpool.Pool
}

var _ worker.RunWorkspaceResolver = (*RunWorkspaces)(nil)

// ErrRunWorkspaceDifferentWorker is the refusal of the one-way door: the run
// already belongs to another worker's workspace, so this worker must fail the
// attempt rather than clone a second copy.
var ErrRunWorkspaceDifferentWorker = errors.New("postgres: run workspace belongs to a different worker")

// Prepare creates the run's workspace row and claims affinity in the same
// transaction, and is idempotent for the worker that already owns the run.
// repoStates is the caller's boundary state, echoed on the returned ref; the
// per-repository rows themselves (paths, mirrors, admin dirs) are the
// worker's to record through WorkspaceStore.RecordRepos, never invented here,
// because every one of those columns ends up in a sandbox grant (ADR-0017
// FC3).
func (s *RunWorkspaces) Prepare(ctx context.Context, runID, workerID, volumeID string,
	repoStates []worker.CheckpointRepoState) (worker.RunWorkspaceRef, error) {
	if s == nil || s.Pool == nil {
		return worker.RunWorkspaceRef{}, errors.New("postgres: run workspace store has no pool")
	}
	if runID == "" || workerID == "" || volumeID == "" {
		return worker.RunWorkspaceRef{}, errors.New("postgres: incomplete run workspace preparation")
	}
	if !validVolumeID(volumeID) {
		return worker.RunWorkspaceRef{}, fmt.Errorf("postgres: volume id %q is not a sha256 volume identity", volumeID)
	}

	out := worker.RunWorkspaceRef{}
	// refusal is the typed answer the transaction COMMITS and then reports.
	// The event rides the same commit as the refusal it explains (contract § 3),
	// so returning an error out of the tx function would roll the journal row
	// back and case 20 would have nothing to render.
	var refusal error
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var (
			orgID, projectID      string
			affinity, affVolumeID string
			status                string
		)
		// The run row is the lock that serialises every preparer of this run;
		// without it two workers could both see "no affinity" and the second
		// would discover the refusal only as a 23505.
		err := tx.QueryRow(ctx, `
			SELECT organization_id::text, project_id::text,
			       COALESCE(worker_affinity::text, ''), COALESCE(worker_volume_id, ''), status
			FROM runs WHERE id = $1::uuid FOR UPDATE`, runID).
			Scan(&orgID, &projectID, &affinity, &affVolumeID, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRunNotFound
		}
		if err != nil {
			return fmt.Errorf("postgres: lock run %s for workspace preparation: %w", runID, err)
		}

		// Already claimed: either this worker's own door (idempotent reuse) or
		// another worker's (case 20's refusal).
		if affinity != "" {
			if affinity != workerID {
				lostID, lostVolume, lookupErr := s.liveWorkspaceTx(ctx, tx, runID)
				if lookupErr != nil {
					return lookupErr
				}
				if err := s.recoveryLostTx(ctx, tx, runID, lostID, workerID, projectID, lostVolume, volumeID,
					events.RecoveryDifferentWorker); err != nil {
					return err
				}
				refusal = fmt.Errorf("%w: run %s is pinned to worker %s on volume %s, %s asked for it",
					ErrRunWorkspaceDifferentWorker, runID, affinity, affVolumeID, workerID)
				return nil
			}
			if affVolumeID != volumeID {
				// Same worker, different disk: the tree it prepared the run on
				// is gone. The row stays `lost`-candidate for the reconciler;
				// the answer to this caller is still a refusal.
				lostID, lostVolume, lookupErr := s.liveWorkspaceTx(ctx, tx, runID)
				if lookupErr != nil {
					return lookupErr
				}
				if err := s.recoveryLostTx(ctx, tx, runID, lostID, workerID, projectID, lostVolume, volumeID,
					events.RecoveryVolumeChanged); err != nil {
					return err
				}
				refusal = fmt.Errorf("postgres: run %s workspace lives on volume %s, worker %s is now on %s",
					runID, lostVolume, workerID, volumeID)
				return nil
			}
			id, _, err := s.liveWorkspaceTx(ctx, tx, runID)
			if err != nil {
				return err
			}
			if id == "" {
				return fmt.Errorf("postgres: run %s has affinity but no live workspace row", runID)
			}
			states, err := runWorkspaceRepoStates(ctx, tx, id)
			if err != nil {
				return err
			}
			out = worker.RunWorkspaceRef{WorkspaceID: id, VolumeID: volumeID, RepoStates: states}
			return nil
		}

		// The door is open: the worker must have measured its own workspaces
		// root (RecordVolume, M2's prepare) before it can be told where the
		// run lives, and root_path must be LayoutOf's path rather than a guess
		// the sandbox would then grant wrongly.
		var volumeRoot string
		err = tx.QueryRow(ctx, `
			SELECT root_path FROM worker_volumes
			WHERE worker_id = $1::uuid AND root_kind = 'workspaces' AND volume_id = $2`,
			workerID, volumeID).Scan(&volumeRoot)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("postgres: worker %s has no recorded workspaces volume %s (record the volume first)", workerID, volumeID)
		}
		if err != nil {
			return fmt.Errorf("postgres: read volume of worker %s: %w", workerID, err)
		}
		layout, err := wsgit.LayoutOf(volumeRoot, "run", runID)
		if err != nil {
			return fmt.Errorf("postgres: run workspace path for %s: %w", runID, err)
		}

		// The repository states must belong to the run's project: an echo of
		// foreign commit identity is a checkpoint nobody can restore.
		if err := assertProjectRepos(ctx, tx, projectID, repoStates); err != nil {
			return err
		}

		var wsID string
		// agent_root is GENERATED (root_path || '/work'): naming it in an
		// INSERT is a 428C9, which is the database proving the granted tree and
		// the worker-only tree are siblings. The row opens `preparing`; the
		// worker's MarkReady follows once the tree exists on disk.
		err = tx.QueryRow(ctx, `
			INSERT INTO workspaces
				(organization_id, project_id, scope_kind, run_id, worker_id, volume_id, root_path, workspace_mode, state)
			VALUES ($1::uuid, $2::uuid, 'run', $3::uuid, $4::uuid, $5, $6, 'worktree', 'preparing')
			RETURNING id::text`,
			orgID, projectID, runID, workerID, volumeID, layout.Root).Scan(&wsID)
		if err != nil {
			return fmt.Errorf("postgres: create run workspace for %s: %w", runID, err)
		}

		// The one-way door, same statement and predicate as RunStore.SetRunAffinity
		// (runs.go) but inside this transaction.
		tag, err := tx.Exec(ctx, `
			UPDATE runs SET worker_affinity = $2::uuid, worker_volume_id = $3
			WHERE id = $1::uuid AND worker_affinity IS NULL`, runID, workerID, volumeID)
		if err != nil {
			return fmt.Errorf("postgres: set affinity for run %s: %w", runID, err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("postgres: affinity for run %s moved under the workspace preparation: %w", runID, ErrConflict)
		}

		out = worker.RunWorkspaceRef{WorkspaceID: wsID, VolumeID: volumeID, RepoStates: repoStates}
		return nil
	})
	if err != nil {
		return worker.RunWorkspaceRef{}, err
	}
	if refusal != nil {
		return worker.RunWorkspaceRef{}, refusal
	}
	return out, nil
}

// RunWorkspace resolves § 4 step 3 for a run: ok=false until a workspace has
// actually been prepared, after which it names the row and the volume, plus
// the repository states recorded on the workspace (commits, never paths).
func (s *RunWorkspaces) RunWorkspace(ctx context.Context, runID string) (worker.RunWorkspaceRef, bool, error) {
	pool, err := m4Pool(s.Pool, "run workspace resolver")
	if err != nil {
		return worker.RunWorkspaceRef{}, false, err
	}
	if runID == "" {
		return worker.RunWorkspaceRef{}, false, errors.New("postgres: run workspace lookup requires a run id")
	}
	var id, volumeID string
	err = pool.QueryRow(ctx, `
		SELECT id::text, volume_id FROM workspaces
		WHERE scope_kind = 'run' AND run_id = $1::uuid AND state IN ('preparing','ready','quarantined')`,
		runID).Scan(&id, &volumeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.RunWorkspaceRef{}, false, nil
	}
	if err != nil {
		return worker.RunWorkspaceRef{}, false, fmt.Errorf("postgres: run workspace lookup for %s: %w", runID, err)
	}
	states, err := runWorkspaceRepoStates(ctx, pool, id)
	if err != nil {
		return worker.RunWorkspaceRef{}, false, err
	}
	return worker.RunWorkspaceRef{WorkspaceID: id, VolumeID: volumeID, RepoStates: states}, true, nil
}

// liveWorkspaceTx reads the run's live workspace row FOR UPDATE inside the
// caller's transaction. Empty id means there is none yet.
func (s *RunWorkspaces) liveWorkspaceTx(ctx context.Context, tx pgx.Tx, runID string) (workspaceID, volumeID string, err error) {
	err = tx.QueryRow(ctx, `
		SELECT id::text, volume_id FROM workspaces
		WHERE scope_kind = 'run' AND run_id = $1::uuid AND state IN ('preparing','ready','quarantined')
		FOR UPDATE`, runID).Scan(&workspaceID, &volumeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("postgres: lock workspace of run %s: %w", runID, err)
	}
	return workspaceID, volumeID, nil
}

// recoveryLostTx appends workspace.recovery_lost for a run that cannot be
// recovered on this worker/volume, inside the refusal's transaction.
//
// It is stated ONCE per run: the journal row is the fact "prior edits are
// lost, rerun required", and a scheduler that retries the wrong worker every
// tick would otherwise bury it. An existing row of the type is left alone.
func (s *RunWorkspaces) recoveryLostTx(ctx context.Context, tx pgx.Tx, runID, workspaceID, workerID, projectID,
	expectedVolume, foundVolume, reason string) error {
	if !events.ValidRecoveryLostReason(reason) {
		return fmt.Errorf("postgres: recovery lost reason %q is not reportable", reason)
	}
	var already bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM domain_events WHERE run_id = $1::uuid AND type = $2)`,
		runID, events.TypeWorkspaceRecoveryLost).Scan(&already); err != nil {
		return fmt.Errorf("postgres: look up recovery_lost of run %s: %w", runID, err)
	}
	if already {
		return nil
	}
	// Actor: the worker that asked and was refused (00005's correlation rule —
	// a control-plane-ish refusal still has an actor id, and the run row is
	// resolved FROM runs inside runAppendTx).
	_, err := runAppendTx(ctx, tx, runID, "", "", RunEvent{
		Type:      events.TypeWorkspaceRecoveryLost,
		ActorKind: events.ActorKindWorker,
		ActorID:   workerID,
		Payload: events.WorkspaceRecoveryLostPayload{
			WorkspaceID:      workspaceID,
			ProjectID:        projectID,
			ExpectedVolumeID: expectedVolume,
			FoundVolumeID:    foundVolume,
			Reason:           reason,
		},
	})
	return err
}

// runWorkspaceRepoStates reads workspace_repos back as commit identity.
func runWorkspaceRepoStates(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}, workspaceID string) ([]worker.CheckpointRepoState, error) {
	rows, err := q.Query(ctx, `
		SELECT repository_id::text, base_commit, COALESCE(head_commit, '')
		FROM workspace_repos WHERE workspace_id = $1::uuid ORDER BY repository_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("postgres: read workspace %s repo states: %w", workspaceID, err)
	}
	defer rows.Close()
	var out []worker.CheckpointRepoState
	for rows.Next() {
		var st worker.CheckpointRepoState
		if err := rows.Scan(&st.RepositoryID, &st.BaseCommit, &st.HeadCommit); err != nil {
			return nil, fmt.Errorf("postgres: scan workspace %s repo state: %w", workspaceID, err)
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// assertProjectRepos refuses repository ids the run's project does not own.
func assertProjectRepos(ctx context.Context, tx pgx.Tx, projectID string, states []worker.CheckpointRepoState) error {
	for _, st := range states {
		if st.RepositoryID == "" {
			return errors.New("postgres: checkpoint repo state without a repository id")
		}
		var owned bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM repositories WHERE id = $1::uuid AND project_id = $2::uuid)`,
			st.RepositoryID, projectID).Scan(&owned); err != nil {
			return fmt.Errorf("postgres: check repository %s ownership: %w", st.RepositoryID, err)
		}
		if !owned {
			return fmt.Errorf("postgres: repository %s is not in project %s: %w", st.RepositoryID, projectID, ErrConflict)
		}
	}
	return nil
}

// validVolumeID is the cheap mirror of the workspaces.volume_id CHECK.
func validVolumeID(v string) bool {
	const prefix = "sha256:"
	if !strings.HasPrefix(v, prefix) || len(v) != len(prefix)+64 {
		return false
	}
	for _, r := range v[len(prefix):] {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
