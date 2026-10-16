package postgres

// The read behind ADR-0023 § 6's `restore_checkpoint` arm, worker side:
// internal/worker.CheckpointRestorer is deliberately store-blind (AGENTS.md's
// dependency rule), so everything the reset needs arrives through a
// BoundaryResolver supplied here. It answers one question — "what does this
// retried attempt have to return to, and where does that live on this
// database's record?" — from rows only:
//
//   * the retried node's COMPILED workspace policy, read from the run's
//     PINNED plan_snapshot (the same immutable source § 4 step 2 hydrates
//     Config from, so a policy that changed after the run started cannot
//     reach a worker);
//   * the last completed boundary's repo_states, i.e. the newest
//     run_checkpoints row that is not this node's own — runtime.RetryPlan's
//     rule restated in SQL, including its tie-break, because the worker must
//     reset to the commit the ENGINE already named in its retry context;
//   * the run's live workspace_repos checkout paths and declared exclusions,
//     which are the only paths a reset may touch (ADR-0017 FC3: paths are
//     rows, never a worker's guess).
//
// Nothing here decides whether the reset is SAFE. That verdict is
// worker.committedBoundary's (every repository provably committed at the
// boundary, hex head, C6d), made from the record this read returns. A read
// that pre-judged it would be a second copy of a rule that already has an
// owner.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/worker"
)

// RestoreBoundary resolves § 6's inputs for one retried attempt. ok=false
// means the run records no boundary at all (its first node): continue
// semantics start clean, and a restore that was asked for with nothing to
// restore to is the arm runtime already refuses with checkpoint_unavailable.
func (s *RunWorkspaces) RestoreBoundary(ctx context.Context, runID, nodeExecutionID string) (worker.RestoreBoundary, bool, error) {
	if s == nil || s.Pool == nil {
		return worker.RestoreBoundary{}, false, errors.New("postgres: restore boundary read has no pool")
	}
	if runID == "" || nodeExecutionID == "" {
		return worker.RestoreBoundary{}, false,
			fmt.Errorf("postgres: restore boundary read needs a run id and a node execution id (run %q node %q)", runID, nodeExecutionID)
	}

	var nodeID, scopeKey, snapshot string
	err := s.Pool.QueryRow(ctx, `
		SELECT ne.node_id, ne.scope_key, COALESCE(r.plan_snapshot, '{}'::jsonb)::text
		FROM node_executions ne JOIN runs r ON r.id = ne.run_id
		WHERE ne.id = $1::uuid AND ne.run_id = $2::uuid`, nodeExecutionID, runID).
		Scan(&nodeID, &scopeKey, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.RestoreBoundary{}, false,
			fmt.Errorf("postgres: node execution %s is not a row of run %s", nodeExecutionID, runID)
	}
	if err != nil {
		return worker.RestoreBoundary{}, false, fmt.Errorf("postgres: read the pinned plan of node %s: %w", nodeExecutionID, err)
	}

	// The policy comes from the pinned snapshot, not the live pipeline. A node
	// with no entry there has no authored policy at all, and the safe answer
	// for an unknown policy is the non-destructive default — a restore invented
	// out of a missing row is exactly the data-loss bug § 6 warns about.
	mode := worker.WorkspacePolicyContinue
	if policy := parsePlanShape([]byte(snapshot)).
		nodeWorkspacePolicy(scopePathNoIndexes(scopeKey), nodeID); policy != "" {
		mode = policy
	}
	b := worker.RestoreBoundary{Mode: mode, Checkouts: map[string]string{}, Excluded: []string{}}
	if mode != worker.WorkspacePolicyRestore {
		// continue_workspace never touches the tree, so nothing else here is
		// read: no checkpoint lookup, no path lookup, no chance to mis-report
		// a boundary the node was not going to use.
		return b, true, nil
	}

	// The last COMPLETED boundary, which is the newest checkpoint of the run
	// that is not this node's own: a retry inherits where the run stood before
	// it, not what its own interrupted attempts wrote (runtime.RetryPlan skips
	// c.NodeExecutionID == row.ID for exactly this reason, and its tie-break
	// prefers the greater node_execution_id, which is what DESC reproduces).
	var (
		repoStatesRaw  []byte
		boundaryWS, ws string
	)
	err = s.Pool.QueryRow(ctx, `
		SELECT rc.repo_states, COALESCE(rc.workspace_id::text, '')
		FROM run_checkpoints rc
		WHERE rc.run_id = $1::uuid AND rc.node_execution_id <> $2::uuid
		ORDER BY rc.created_at DESC, rc.node_execution_id::text DESC
		LIMIT 1`, runID, nodeExecutionID).Scan(&repoStatesRaw, &boundaryWS)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, false, nil
	}
	if err != nil {
		return b, false, fmt.Errorf("postgres: read the last boundary of run %s: %w", runID, err)
	}
	// CheckpointRepoState's json tags ARE the stored shape (contract § 9.1 row
	// 304, ADR-0017 D8): the decode is a read of the wire contract, and the
	// committed/modified_path_count pointers stay nil when no capture ever
	// measured that repository — which the worker must see as nil, never as a
	// clean `false`/`true` promise (§ 6's precondition is proved, not assumed).
	if err := json.Unmarshal(repoStatesRaw, &b.RepoStates); err != nil {
		return b, false, fmt.Errorf("postgres: decode the boundary repo_states of run %s: %w", runID, err)
	}

	// Where those commits live on this database's record: the run's LIVE
	// workspace row (the same state predicate as liveWorkspaceTx — a released
	// or lost workspace's paths are nobody's to reset) and its workspace_repos
	// paths. The boundary's own workspace_id is cross-checked rather than
	// trusted: a checkpoint recorded against a tree this run no longer has is
	// not a boundary this reset may destroy anything for.
	if err := s.Pool.QueryRow(ctx, `
		SELECT id::text FROM workspaces
		WHERE scope_kind = 'run' AND run_id = $1::uuid AND state IN ('preparing','ready','quarantined')`,
		runID).Scan(&ws); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return b, false, fmt.Errorf("postgres: run %s has no live workspace row to restore", runID)
		}
		return b, false, fmt.Errorf("postgres: read the live workspace of run %s: %w", runID, err)
	}
	if boundaryWS != "" && boundaryWS != ws {
		return b, false, fmt.Errorf("postgres: boundary of run %s was recorded in workspace %s, "+
			"but the run now lives in %s: no worktree was reset", runID, boundaryWS, ws)
	}

	rows, err := s.Pool.Query(ctx, `
		SELECT wr.repository_id::text, wr.checkout_path, wr.excluded_paths::text
		FROM workspace_repos wr
		WHERE wr.workspace_id = $1::uuid ORDER BY wr.repository_id::text`, ws)
	if err != nil {
		return b, false, fmt.Errorf("postgres: read the checkouts of workspace %s: %w", ws, err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var repoID, checkout, excludedRaw string
		if err := rows.Scan(&repoID, &checkout, &excludedRaw); err != nil {
			return b, false, fmt.Errorf("postgres: scan workspace_repos of workspace %s: %w", ws, err)
		}
		b.Checkouts[repoID] = checkout
		var excluded []string
		if err := json.Unmarshal([]byte(excludedRaw), &excluded); err != nil {
			return b, false, fmt.Errorf("postgres: decode excluded_paths of repository %s: %w", repoID, err)
		}
		// The exclusion set is flat across repositories because the reset is
		// per checkout and git.MatchPathStyle patterns are relative: a pattern
		// declared for one repository can only ever PROTECT another's files
		// from the clean, never name them for destruction. Over-protection is
		// the safe direction — a discarded_paths list must never claim a file
		// the reset left in place.
		for _, e := range excluded {
			if e != "" && !seen[e] {
				seen[e] = true
				b.Excluded = append(b.Excluded, e)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return b, false, fmt.Errorf("postgres: read the checkouts of workspace %s: %w", ws, err)
	}
	return b, true, nil
}
