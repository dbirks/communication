package worker

// The process.exec half of ADR-0023 § 6's boundary rule: the checkpoint row
// carries "the same capture ADR-0017 D8 already produces for a turn, now
// attached to a node boundary". Until this file that sentence was only true
// for agent.acp — unit_capture's Capture ran at a turn's end and wrote
// workspace_repos.head_commit/modified_paths, while a process.exec completion
// recorded whatever the rows happened to say, which after prepare is nothing:
// every boundary after a command node read back `committed: null`, and
// restore_checkpoint ("Allowed only when every repo in the run is at a
// committed state at that boundary") refused forever — the deterministic twin
// of lab live18.
//
// The capture here is the agent path's function (captureRepos), the same
// fields (head_commit, committed, modified_path_count — the 12cb433 wire
// keys), and the same exclusions (ADR-0017 D6, and ADR-0018's rule that
// materialized secret paths never enter a checkpoint). Like the turn loop it
// is capture-only: nothing is rehydrated and no recoverability is claimed
// (D-024 stays Open).
//
// Failure honesty: a capture that cannot read git or cannot write its row is
// a WARNING here, never a failed attempt. The command succeeded; downgrading
// that to infra would change retriability for a bookkeeping read, and the
// boundary simply stays un-captured — the pre-existing state, one the engine
// already reports truthfully through restore_checkpoint's refusal.

import (
	"context"
	"log/slog"
	"strings"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// captureBoundary records the run workspace's repository state at this
// completed process.exec attempt, through the same read + writer the agent
// path uses. It is best-effort by the docblock's rule and returns whether it
// wrote anything (callers do not branch on it; the checkpointFor re-read does,
// inside the resolver's own rows).
func (p *ProcExec) captureBoundary(ctx context.Context, c AttemptClaim, materialized *Materialized) {
	if p.Checkpoints == nil {
		return
	}
	ref, ok, err := p.Checkpoints.RunWorkspace(context.WithoutCancel(ctx), c.RunID)
	if err != nil || !ok || len(ref.Repos) == 0 {
		return
	}
	rec, ok := p.Checkpoints.(BoundaryCommitRecorder)
	if !ok {
		// A resolver without the write half (an older wiring, a test stub):
		// the boundary stays un-captured, the honest pre-existing state.
		p.logger().Debug("run workspace resolver records no boundary captures",
			slog.String("attempt_id", c.AttemptID))
		return
	}
	git, err := p.boundaryGit()
	if err != nil {
		p.logger().Warn("process.exec boundary capture could not open the git reader",
			slog.String("attempt_id", c.AttemptID), slog.String("error", p.redact(err.Error())))
		return
	}
	repos := make([]CaptureRepo, 0, len(ref.Repos))
	for _, r := range ref.Repos {
		if strings.TrimSpace(r.CheckoutPath) == "" {
			continue
		}
		repos = append(repos, CaptureRepo{
			RowID: r.RowID, RepositoryID: r.RepositoryID, RepoName: r.RepositoryID,
			CheckoutPath: r.CheckoutPath, RunRef: r.RunRef,
			BaseCommit: r.BaseCommit, RecordedHead: r.RecordedHead,
			RecordedPaths: r.RecordedPaths,
		})
	}
	if len(repos) == 0 {
		return
	}
	excluded := p.boundaryExclusions(ref.Repos, materialized)
	if _, err := captureRepos(ctx, git, excluded, ref.WorkspaceID, c.OrganizationID, c.ProjectID,
		repos, rec.RecordBoundaryCommit); err != nil {
		// Warning, never a failed attempt: see the docblock. The states the
		// boundary record resolves afterwards are whatever the rows truthfully
		// hold — including un-captured, which restore_checkpoint refuses.
		p.logger().Warn("process.exec boundary capture failed; the boundary stays un-captured",
			slog.String("attempt_id", c.AttemptID), slog.String("error", p.redact(err.Error())))
	}
}

// boundaryGit is the capture's reader: the injected seam in tests, otherwise
// one unsandboxed read-only manager built once from this worker's configured
// workspace root. Worker-owned git plumbing is explicitly unsandboxed
// (checkpointrestore.go's § 6 argument); the launched command stays under
// nono either way, and AGENTS.md forbids restricting this process regardless.
func (p *ProcExec) boundaryGit() (BoundaryGit, error) {
	if p.BoundaryGit != nil {
		return p.BoundaryGit, nil
	}
	p.gitOnce.Do(func() {
		var m *wsgit.Manager
		m, p.gitErr = wsgit.NewReadManager(p.WorkspaceRoot)
		if m != nil {
			p.gitReader = m
		}
	})
	return p.gitReader, p.gitErr
}

// boundaryExclusions is the capture's declared set for a command boundary:
// the per-repository exclusions the rows carry (ADR-0017 D6) plus THIS
// attempt's materialized secret trees, made checkout-relative exactly as
// Unit.secretRelative does it — ADR-0018's contract that materialized paths
// are excluded from checkpoints, which for process.exec matters because the
// deferred secret cleanup runs AFTER the boundary is captured.
func (p *ProcExec) boundaryExclusions(refRepos []BoundaryRepo, m *Materialized) []string {
	sets := make([][]string, 0, len(refRepos)+1)
	for _, r := range refRepos {
		sets = append(sets, r.ExcludedPaths)
	}
	if m != nil {
		var rel []string
		for _, file := range m.Files {
			// Same rule as Unit.secretRelative: inside a checkout it joins that
			// repo's exclusion set; outside every checkout it is kept as-is for
			// the store's second filter (mergePaths drops absolute spellings,
			// which no per-repository exclusion can express).
			rel = append(rel, file)
			for _, r := range refRepos {
				if inside(r.CheckoutPath, file) {
					rel[len(rel)-1] = strings.TrimPrefix(file, r.CheckoutPath+"/")
					break
				}
			}
		}
		sets = append(sets, rel)
	}
	return mergePaths(sets...)
}
