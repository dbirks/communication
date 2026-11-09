package worker

// Node-boundary patch filing (ADR-0078 § Patch artifacts). The M3 unit capture
// publishes its reviewable diff at the turn boundary (unit_patch.go); a
// pipeline run's work happens at NODE boundaries — agent.acp attempts (and the
// process.exec commands between them) — and until this file no attempt ever
// filed a patch, so a tour built from a pipeline run had logs and file lists
// but no line of real code to quote.
//
// One artifact per finished attempt, through the ATTEMPT-fenced artifact seams
// (the same pair artifact.publish writes through): the row and its
// artifact.created land in one transaction that proves this worker still owns
// the attempt (ADR-0016 § 9.2), and a stale fence loses the artifact, not the
// turn. The document itself is the unit capture's shared half: the per-repo
// secret scan before assembly (assemblePatch), then the 64 KiB hunk-bound
// cut (wsgit.BoundPatch) — one redaction rule and one size rule for every
// patch artifact the platform files.
//
// The diff base is the commit THIS attempt started from: the head the run's
// workspace row last recorded for the repository (a previous boundary capture
// wrote it), or the run's branch point when nobody has captured that repo yet.
// After a restore_checkpoint retry (ADR-0023 § 6) the tree sits exactly on
// that recorded head, so the same base reads the attempt's own work and
// nothing before it.
//
// Best-effort by D9's rule, which every capture path in this package carries:
// a patch that cannot be read, scanned or written is a WARNING. It runs after
// the attempt's terminal result is decided and can never change it. The
// agent's child processes stay exactly as sandboxed as they were — this is the
// worker's own unsandboxed git read over its own workspace (AGENTS.md: never
// Landlock in the main process).

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// attemptPatchCaptureTimeout bounds one attempt's patch filing on a detached
// context: the attempt is already terminal, so a cancelled run must still be
// able to file its evidence — but not forever.
const attemptPatchCaptureTimeout = 15 * time.Second

// patchNodeRepo is one checkout as a node boundary sees it.
type patchNodeRepo struct {
	RepositoryID string
	RepoName     string
	CheckoutPath string
	// Base is the commit the attempt started from ("" lets the read fall back
	// to HEAD, diff.go's rule for a row that never recorded a base).
	Base string
}

// fileNodePatch reads each repository's diff against the attempt's base and
// files the attempt's ONE patch artifact. It never fails its caller: every
// refusal path ends in a log line and no artifact, which is the pre-patch
// state the tours already handle. bytes or rows nil is the honest "this
// worker files no attempt patches" and is silent, not a warning.
func fileNodePatch(ctx context.Context, log *slog.Logger, git PatchReader,
	bytesStore artifacts.Store, rows AttemptArtifactWriter,
	redact func(text string) (string, int), c AttemptClaim, excluded []string, repos []patchNodeRepo,
) {
	if bytesStore == nil || rows == nil || len(repos) == 0 {
		return
	}
	if git == nil {
		log.Warn("node-boundary patch: no git reader is wired; the attempt files no patch",
			slog.String("attempt_id", c.AttemptID))
		return
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), attemptPatchCaptureTimeout)
	defer cancel()

	diffs := make([]patchRepoDiff, 0, len(repos))
	for _, r := range repos {
		if strings.TrimSpace(r.CheckoutPath) == "" {
			continue
		}
		raw, err := git.Patch(cctx, r.CheckoutPath, r.Base, excluded)
		if err != nil {
			// The whole artifact is dropped, not half of it: a patch missing a
			// repository would silently tell the tour "nothing else moved".
			log.Warn("node-boundary patch: the diff read failed; the attempt files no patch",
				slog.String("attempt_id", c.AttemptID),
				slog.String("repository", r.RepoName), slog.String("error", err.Error()))
			return
		}
		diffs = append(diffs, patchRepoDiff{
			RepositoryID: r.RepositoryID, RepoName: r.RepoName, Raw: raw,
		})
	}
	assembled, ok := assemblePatch(redact, diffs)
	if !ok {
		return // the tree says nothing the base did not: a true answer, no artifact
	}
	if assembled.Redactions > 0 {
		// The unit capture's rule, kept out loud: the store's redaction_count
		// can count THIS one, and a reader must still be able to tell "the
		// scanner ran and fired" from "there was nothing to find" (ADR-0020 D4).
		log.Warn("the patch artifact was redacted before storage",
			slog.String("name", assembled.Name), slog.Int("redactions", assembled.Redactions))
	}
	bound := wsgit.BoundPatch(assembled.Document, patchArtifactMaxBytes)
	if bound.Truncated {
		log.Warn("the patch artifact is bounded at a hunk boundary",
			slog.String("attempt_id", c.AttemptID), slog.String("name", assembled.Name),
			slog.Int("files", bound.Files), slog.Int("lines", bound.Lines),
			slog.Int("bytes", len(bound.Text)))
	}
	ref, err := bytesStore.Put(cctx, artifacts.Input{
		ProjectID:   c.ProjectID,
		Name:        artifacts.SanitizeFilename(assembled.Name),
		Kind:        artifacts.KindPatch,
		MediaType:   patchMedia,
		Sensitivity: artifacts.SensitivityStandard,
		MaxBytes:    artifacts.LimitFor(artifacts.KindPatch),
		Body:        bytes.NewReader([]byte(bound.Text)),
	})
	if err != nil {
		log.Warn("node-boundary patch: putting the artifact bytes failed",
			slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		return
	}
	id, err := rows.PublishAttemptArtifact(cctx, AttemptArtifactInput{
		OrganizationID:  c.OrganizationID,
		ProjectID:       c.ProjectID,
		RunID:           c.RunID,
		NodeExecutionID: c.NodeExecutionID,
		AttemptID:       c.AttemptID,
		WorkerID:        c.WorkerID,
		FencingToken:    c.FencingToken,
		Name:            assembled.Name,
		Kind:            artifacts.KindPatch,
		MediaType:       patchMedia,
		Sensitivity:     artifacts.SensitivityStandard,
		Ref:             ref,
		RedactionCount:  assembled.Redactions,
	})
	if err != nil {
		// Includes ErrLeaseLost: the fence proved us stale, the object stays
		// unreferenced for the orphan sweep — artifact.publish's designed
		// outcome, not a leak.
		log.Warn("node-boundary patch: publishing the artifact row failed",
			slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		return
	}
	log.Debug("node-boundary patch filed",
		slog.String("attempt_id", c.AttemptID), slog.String("artifact_id", id),
		slog.String("name", assembled.Name), slog.Int("files", bound.Files))
}

// attemptPatchRepos maps the run workspace's boundary rows onto the patch
// read: the base is the commit this attempt started from, and the display name
// prefers the prepared repository's own name over the row id.
func attemptPatchRepos(refRepos []BoundaryRepo, names map[string]string) []patchNodeRepo {
	repos := make([]patchNodeRepo, 0, len(refRepos))
	for _, r := range refRepos {
		if strings.TrimSpace(r.CheckoutPath) == "" {
			continue
		}
		base := strings.TrimSpace(r.RecordedHead)
		if base == "" {
			base = r.BaseCommit
		}
		name := names[r.RepositoryID]
		if name == "" {
			name = r.RepositoryID
		}
		repos = append(repos, patchNodeRepo{
			RepositoryID: r.RepositoryID, RepoName: name, CheckoutPath: r.CheckoutPath, Base: base,
		})
	}
	return repos
}

// captureAttemptPatch files this agent.acp attempt's patch artifact once the
// attempt has its terminal result. It is called on EVERY completion —
// success and failure alike, because an attempt that died mid-edit is exactly
// the story the tour must quote. No byte backend, no row writer, no run
// workspace row or no repositories means no git workspace to diff: the
// pre-patch state, silent by the fileNodePatch rule.
func (a *AgentTurn) captureAttemptPatch(ctx context.Context, c AttemptClaim,
	mounts []MaterializeRepo, materialized *Materialized,
) {
	if a == nil || a.PatchBytes == nil || a.PatchRows == nil || a.Checkpoints == nil {
		return
	}
	ref, ok, err := a.Checkpoints.RunWorkspace(context.WithoutCancel(ctx), c.RunID)
	if err != nil || !ok || len(ref.Repos) == 0 {
		return
	}
	git, err := a.patchGit()
	if err != nil {
		a.logger().Warn("agent turn boundary patch could not open the git reader",
			slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		return
	}
	redact := a.PatchRedact
	if redact == nil && materialized != nil {
		redact = materialized.Redact
	}
	names := make(map[string]string, len(mounts))
	for _, m := range mounts {
		names[m.ID] = m.Name
	}
	fileNodePatch(ctx, a.logger(), git, a.PatchBytes, a.PatchRows, redact, c,
		attemptBoundaryExclusions(ref.Repos, materialized), attemptPatchRepos(ref.Repos, names))
}

// patchGit resolves the attempt patch's reader: the injected seam in tests,
// otherwise one unsandboxed read-only manager built once from this worker's
// configured workspace root — the same argument and the same construction
// ProcExec's and ModelChat's boundaryGit carry.
func (a *AgentTurn) patchGit() (PatchReader, error) {
	if a.PatchGit != nil {
		return a.PatchGit, nil
	}
	a.patchGitOnce.Do(func() {
		var m *wsgit.Manager
		m, a.patchGitErr = wsgit.NewReadManager(a.WorkspaceRoot)
		if m != nil {
			a.patchGitReader = m
		}
	})
	return a.patchGitReader, a.patchGitErr
}

// captureBoundaryPatch files this process.exec attempt's patch artifact from
// the boundary capture's own reads. Same base, same exclusions, same fences as
// the agent path: a command node that edited the tree leaves the same kind of
// reviewable evidence the tour needs. Best-effort by procexec_capture's own
// docblock rule — the command's outcome was decided before this ran.
func (p *ProcExec) captureBoundaryPatch(ctx context.Context, c AttemptClaim,
	ref RunWorkspaceRef, excluded []string, materialized *Materialized,
) {
	if p == nil || p.PatchBytes == nil || p.PatchRows == nil || len(ref.Repos) == 0 {
		return
	}
	git, err := p.boundaryGit()
	if err != nil {
		p.logger().Warn("process.exec boundary patch could not open the git reader",
			slog.String("attempt_id", c.AttemptID), slog.String("error", p.redact(err.Error())))
		return
	}
	reader, ok := git.(PatchReader)
	if !ok {
		// A BoundaryGit fake (or an older manager) that renders no diff: the
		// boundary keeps its checkpoint and files no patch — the pre-patch
		// state, stated once rather than guessed at.
		p.logger().Debug("process.exec boundary: the git reader renders no patch",
			slog.String("attempt_id", c.AttemptID))
		return
	}
	var redact func(string) (string, int)
	if materialized != nil {
		redact = materialized.Redact
	}
	fileNodePatch(ctx, p.logger(), reader, p.PatchBytes, p.PatchRows, redact, c,
		excluded, attemptPatchRepos(ref.Repos, nil))
}
