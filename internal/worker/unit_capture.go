package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/events"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// CaptureOutcome is one repository's unit-boundary capture: what the checkout
// looks like now, per ADR-0017 D8, with the exclusions applied twice (git's own,
// and this code's).
// declaredFiles is what a materializer said it wrote.
func declaredFiles(m *Materialized) []string {
	if m == nil {
		return nil
	}
	return m.Files
}

type CaptureOutcome struct {
	RepositoryID string
	RepoName     string
	// RunRef is the ref the capture read back, so workspace.committed can name
	// what moved without a second query.
	RunRef     string
	HeadCommit string
	BaseCommit string
	Dirty      bool
	Summary    string
	Manifest   []string
	// ArtifactID is empty when no artifact store is wired or the capture was
	// empty; a turn does not fail because an artifact could not be recorded
	// (deviation D9: an M3 failure loses artifacts, not edits).
	ArtifactID string
	// Committed is true when the run ref moved during this unit, which is the
	// only thing that may be called a commit.
	Committed bool
}

// Capture is contract § 4.2 step 6, run at the unit boundary (M3: the end of a
// turn's session, since M4's node boundaries are what define a unit's end).
//
// It is *capture only*. Nothing in this function rehydrates anything, and no
// caller may describe the result as "recoverable" — D-024 stays Open, and
// 12-test-strategy's case-20 "different host" arm asserts only the honest
// workspace.recovery_lost report (ADR-0017 D8).
//
// The post-commit proof is a ref read, never an exit status: probe P8 saw a
// commit that printed `packed-refs.lock: Permission denied` and still succeeded,
// and another whose ref update failed at exit 128 while the command looked fine.
// Capture therefore reads `rev-parse` after the fact and reports what git
// answered.
// BoundaryGit is the capture's read pair, split from *wsgit.Manager so the
// node-boundary capture has one seam to fake and one implementation (the
// manager itself satisfies it; NewReadManager builds the unsandboxed reader
// the process.exec path uses).
type BoundaryGit interface {
	HeadCommit(ctx context.Context, checkout string) (string, error)
	Status(ctx context.Context, checkout string, excluded []string) (wsgit.Summary, error)
}

// CaptureRepo is one checkout's identity at a boundary: where it lives, what
// it was based on, and what was last *recorded* for it ("" when nobody has
// ever captured it). Both the agent path (mapped from wsgit.PreparedRepo) and
// the process.exec boundary (mapped from the run workspace rows) arrive here,
// which is what makes ADR-0023 § 6's "the same capture ... now attached to a
// node boundary" one function rather than two.
type CaptureRepo struct {
	RowID        string
	RepositoryID string
	RepoName     string
	CheckoutPath string
	RunRef       string
	BaseCommit   string
	RecordedHead string
}

// captureRepos is the unit-boundary capture's per-repo read and record, run
// over repos with the declared exclusion set. `record` is the workspace_repos
// writer (nil means read-only capture); it fires under the agent path's rule:
// the run ref moved, or this is the first time anyone read it back. Errors
// return the partial outcomes with the same wrapped messages the turn loop
// has always produced.
func captureRepos(ctx context.Context, git BoundaryGit, excluded []string,
	workspaceID, orgID, projectID string, repos []CaptureRepo,
	record func(context.Context, CommitRecord) error) ([]CaptureOutcome, error) {
	var out []CaptureOutcome
	for i := range repos {
		repo := &repos[i]
		head, err := git.HeadCommit(ctx, repo.CheckoutPath)
		if err != nil {
			// A checkout whose HEAD cannot be read is not "clean": reporting it
			// as such would be the fiction ADR-0017 D8 exists to prevent.
			return out, fmt.Errorf("worker: read HEAD of %s: %w", repo.RepoName, err)
		}
		sum, err := git.Status(ctx, repo.CheckoutPath, excluded)
		if err != nil {
			return out, fmt.Errorf("worker: status of %s: %w", repo.RepoName, err)
		}
		res := CaptureOutcome{
			RepositoryID: repo.RepositoryID, RepoName: repo.RepoName, RunRef: repo.RunRef,
			HeadCommit: head, BaseCommit: repo.BaseCommit,
			Dirty: sum.Dirty, Summary: sum.Summary, Manifest: sum.Paths,
			Committed: head != "" && head != repo.BaseCommit,
		}
		if res.Committed || repo.RecordedHead != head {
			// The run ref moved (or this is the first time anyone read it back):
			// that is the workspace.committed fact, and it is written from the
			// read rather than from a command's status.
			if record != nil && repo.RowID != "" {
				rec := CommitRecord{
					RowID:       repo.RowID,
					WorkspaceID: workspaceID, OrganizationID: orgID, ProjectID: projectID,
					RepositoryID: repo.RepositoryID, RunRef: repo.RunRef, HeadCommit: head,
					ModifiedPaths: sum.Paths,
				}
				if err := record(ctx, rec); err != nil {
					return out, err
				}
			}
			repo.RecordedHead = head
		}
		out = append(out, res)
	}
	return out, nil
}

func (u *Unit) Capture(ctx context.Context) ([]CaptureOutcome, error) {
	if u == nil {
		return nil, errors.New("worker: no unit to capture")
	}
	repos := make([]CaptureRepo, 0, len(u.Repos))
	for _, repo := range u.Repos {
		repos = append(repos, CaptureRepo{
			RowID: u.rowID(&repo), RepositoryID: repo.RepositoryID, RepoName: repo.Name,
			CheckoutPath: repo.CheckoutPath, RunRef: repo.RunRef,
			BaseCommit: repo.BaseCommit, RecordedHead: repo.HeadCommit,
		})
	}
	out, err := captureRepos(ctx, u.svc.Workspaces, u.ExcludedPaths, u.WorkspaceID,
		u.OrganizationID, u.ProjectID, repos,
		func(ctx context.Context, rec CommitRecord) error { return u.svc.Store.RecordCommit(ctx, rec) })
	for _, res := range out {
		if err := u.captureArtifact(ctx, res); err != nil {
			// An artifact that will not store is a warning and a missing row,
			// never a failed turn: the edits live in git, and failing the turn
			// would trade real work for a bookkeeping entry.
			u.logger.Warn("unit capture could not be published",
				slog.String("repo", res.RepoName), slog.String("error", err.Error()))
		}
		// The unit's own repo rows carry the head the capture read back, so a
		// second capture inside the same unit does not re-record what it just
		// recorded (the old in-place write's rule).
		for i := range u.Repos {
			if u.Repos[i].RepositoryID == res.RepositoryID {
				u.Repos[i].HeadCommit = res.HeadCommit
			}
		}
	}
	return out, err
}

// captureArtifact publishes the checkpoint (the manifest) and, for a dirty
// checkout, the diff summary. Both carry the exclusion set to the store, which
// filters again on its own — ADR-0017 D6 requires the second filter even though
// the first one already ran, because the two fail differently: git's ignore file
// can be edited by anything with write access to the mirror, this code cannot be.
func (u *Unit) captureArtifact(ctx context.Context, res CaptureOutcome) error {
	if u.svc.Artifacts == nil {
		return nil
	}
	if len(res.Manifest) > 0 {
		id, err := u.svc.Artifacts.Capture(ctx, CaptureRequest{
			OrganizationID: u.OrganizationID, ProjectID: u.ProjectID, WorkspaceID: u.WorkspaceID,
			ConversationID: u.ConversationID, TurnID: u.TurnID, RepositoryID: res.RepositoryID,
			WorkerID: u.WorkerID, FencingToken: u.FencingToken,
			Kind:          ArtifactKindCheckpoint,
			Name:          "checkpoint-" + res.RepoName,
			Summary:       res.Summary,
			Manifest:      res.Manifest,
			ExcludedPaths: u.ExcludedPaths,
		})
		if err != nil {
			return err
		}
		res.ArtifactID = id
	}
	// Agent-produced report files become artifacts too (contract § 4.7): the
	// capture rule declares any manifest path with an artifactable extension a
	// candidate. Git exclusion already removed declared secret targets from the
	// manifest, the store filters ExcludedPaths a second time, and the backend
	// refuses anything over the kind's cap — so this loop may stay simple.
	for _, path := range res.Manifest {
		kind, media, ok := artifactKindFor(path)
		if !ok {
			continue
		}
		repo := repoFor(u.Repos, res.RepositoryID)
		content, err := u.readArtifactFile(&repo, path)
		if err != nil {
			u.logger.Warn("capture skipped an artifact candidate",
				slog.String("path", path), slog.String("error", err.Error()))
			continue
		}
		if _, err := u.svc.Artifacts.Capture(ctx, CaptureRequest{
			OrganizationID: u.OrganizationID, ProjectID: u.ProjectID, WorkspaceID: u.WorkspaceID,
			ConversationID: u.ConversationID, TurnID: u.TurnID, RepositoryID: res.RepositoryID,
			WorkerID: u.WorkerID, FencingToken: u.FencingToken,
			Kind: kind, Name: path, Summary: res.Summary,
			Content: content, MediaType: media,
			ExcludedPaths: u.ExcludedPaths,
		}); err != nil {
			return err
		}
	}
	return nil
}

// artifactKindFor is the capture rule's extension table: what an agent wrote
// that may be *shown* becomes an artifact; source edits stay in git (the
// checkpoint manifest already names them). Only the renderable documentation
// kinds are candidates — an arbitrary source file as an artifact would make the
// artifact list a second, weaker git.
func artifactKindFor(path string) (kind, media string, ok bool) {
	ext := path[strings.LastIndexByte(path, '.')+1:]
	switch strings.ToLower(ext) {
	case "html", "htm":
		return "html", "text/html", true
	case "md", "markdown":
		return "markdown", "text/markdown", true
	default:
		return "", "", false
	}
}

// repoFor finds the prepared repo by id; capture already iterated it, so the
// zero value only happens if the caller lied about the id.
func repoFor(repos []wsgit.PreparedRepo, id string) wsgit.PreparedRepo {
	for _, r := range repos {
		if r.RepositoryID == id {
			return r
		}
	}
	return wsgit.PreparedRepo{}
}

// artifactMaxRead bounds what capture will read from a checkout before handing
// bytes to the store: the store's own per-kind cap is the authority (it refuses
// rather than truncates); this only stops a capture from buffering a monster.
const artifactMaxRead = 32 << 20

func (u *Unit) readArtifactFile(repo *wsgit.PreparedRepo, rel string) ([]byte, error) {
	if repo.CheckoutPath == "" || rel == "" || strings.Contains(rel, "..") {
		return nil, errors.New("capture: candidate is not a checkout-relative path")
	}
	f, err := os.Open(filepath.Join(repo.CheckoutPath, filepath.FromSlash(rel)))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("capture: candidate is not a regular file")
	}
	if info.Size() > artifactMaxRead {
		return nil, errors.New("capture: candidate exceeds the capture read bound")
	}
	return io.ReadAll(f)
}

// rowID finds the workspace_repos row for a prepared repo. The store keys
// commits by row id, and the ids arrive with WorkspaceRepos.
func (u *Unit) rowID(repo *wsgit.PreparedRepo) string {
	if id, ok := u.rows[repo.RepositoryID]; ok {
		return id
	}
	return ""
}

// Cleanup is contract § 4.2 step 8, and it runs whether the turn completed,
// failed, was cancelled or was interrupted: the three things it prevents are
// secret exposure, cross-run interference, and a mirror full of stale admin dirs
// — none of which cares why the turn ended.
//
// The order is the one that makes a leftover impossible to miss: secrets first
// (and their removal is *asserted*, not assumed), then the agent home, then the
// worktree. A failure to remove a secret quarantines the workspace and reports
// it; pretending cleanup succeeded when it did not is the failure mode ADR-0017
// D7 refuses ("a failed cleanup moves the workspace to quarantined rather than
// silently deleting it").
func (u *Unit) Cleanup(ctx context.Context) (released bool, err error) {
	if u == nil {
		return false, nil
	}
	u.cleanupOnce.Do(func() { u.released, u.cleanupErr = u.cleanup(ctx) })
	return u.released, u.cleanupErr
}

func (u *Unit) cleanup(ctx context.Context) (bool, error) {
	log := u.logger

	// 1. materialized secrets, with the assertion.
	leftover := u.removeSecrets(ctx)
	if leftover != nil {
		if err := u.svc.Store.Quarantine(ctx, u.WorkspaceID, events.QuarantineSecretLeftBehind); err != nil {
			log.Error("a materialized secret survived cleanup and the workspace could not be quarantined",
				slog.String("workspace_id", u.WorkspaceID), slog.String("error", err.Error()))
		}
		_ = u.svc.Store.WorkspaceEvent(ctx, u.OrganizationID, u.ProjectID, u.ConversationID, TurnEvent{
			Type: events.TypeWorkspaceQuarantined, ActorKind: events.ActorKindWorker, ActorID: u.WorkerID,
			Payload: events.WorkspaceQuarantinedPayload{
				WorkspaceID: u.WorkspaceID, ProjectID: u.ProjectID,
				Reason: events.QuarantineSecretLeftBehind,
			},
		})
		// The worktrees stay: pruning a tree that still holds a secret would
		// trade one exposure for the appearance of having handled it. The error
		// is returned as well as journalled — a caller that only read the event
		// stream would otherwise have to notice the quarantine itself, and the
		// turn loop's exit path is not a reader.
		return false, leftover
	}
	// The removal is asserted gone; now close the ledger. Done writes the
	// secret_materializations cleanup and journals secret.removed — the pair
	// that distinguishes "cleanup happened" from "cleanup is claimed". A unit
	// whose hook fails leaves uncleaned rows, which is the *finding* state the
	// startup sweep exists to close, not a silent pass.
	if u.Materialized != nil && u.Materialized.Done != nil {
		if err := u.Materialized.Done(ctx); err != nil {
			log.Warn("secret.removed could not be journalled",
				slog.String("workspace_id", u.WorkspaceID), slog.String("error", err.Error()))
		}
	}

	// 2. the per-attempt home: APM's state, the harness caches, the seeded
	// .gitconfig. All of it is throwaway by construction (ADR-0008), and
	// deleting it is what makes the next attempt's HOME somebody else's problem
	// in the good sense.
	if err := os.RemoveAll(u.Layout.Home); err != nil {
		log.Warn("the agent home could not be removed", slog.String("error", err.Error()))
	}

	// 3. worktrees, then prune (WORKSPACES.md W6). ReposPruned is reported
	// rather than implied: a false here means the mirror keeps orphaned admin
	// dirs for the reconciler, and an honest number beats a claim nobody checked.
	pruned := u.svc.Workspaces.RemoveWorktrees(ctx, u.Layout, u.Repos)
	if err := u.svc.Store.Release(ctx, u.WorkspaceID); err != nil {
		log.Warn("workspace.release could not be recorded", slog.String("error", err.Error()))
	}

	if err := u.svc.Store.WorkspaceEvent(ctx, u.OrganizationID, u.ProjectID, u.ConversationID, TurnEvent{
		Type: events.TypeWorkspaceReleased, ActorKind: events.ActorKindWorker, ActorID: u.WorkerID,
		Payload: events.WorkspaceReleasedPayload{
			WorkspaceID: u.WorkspaceID, ProjectID: u.ProjectID, ReposPruned: pruned,
		},
	}); err != nil {
		log.Warn("workspace.released could not be journalled", slog.String("error", err.Error()))
	}
	return pruned, nil
}

// removeSecrets deletes every file the materializer reported and then *checks*:
// the report is what was asked for, the re-stat is what is true. A file that
// cannot be removed, or that reappears, is the quarantine condition.
func (u *Unit) removeSecrets(ctx context.Context) error {
	// The materializer's own report is the list, not the unit's copy of it: if a
	// hook wrote a file it never declared, the declaration is what gets asserted
	// and the undeclared file would survive silently. The unit keeps its own list
	// only for the case where the hook reported nothing it wrote.
	targets := append([]string(nil), u.secretFiles...)
	targets = append(targets, declaredFiles(u.Materialized)...)
	if len(targets) == 0 {
		return nil
	}
	var problems []string
	for _, file := range targets {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			problems = append(problems, file)
			continue
		}
		if _, err := os.Lstat(file); err == nil {
			problems = append(problems, file)
		}
	}
	u.secretFiles = nil
	if len(problems) > 0 {
		// The paths go to the log, never to the journal: they name where a secret
		// lives, and the journal is browser-visible (contract § 3).
		u.logger.Error("materialized secrets survived cleanup",
			slog.String("workspace_id", u.WorkspaceID), slog.Any("files", problems))
		return fmt.Errorf("worker: %d materialized file(s) survived cleanup", len(problems))
	}
	return nil
}

// QuarantineOnFailure is the failure-path counterpart to Cleanup: when a unit
// fails in a way that says something about the tree's safety rather than about
// the prompt, the workspace stops being reusable. `reason` is one of the three
// enums the event schema allows; anything else is a programming error and
// reported as one instead of inventing a fourth kind of quarantine.
func (u *Unit) QuarantineOnFailure(ctx context.Context, kind string) error {
	reason := quarantineReason(kind)
	if reason == "" {
		return fmt.Errorf("worker: quarantine kind %q is not one the event schema allows", kind)
	}
	if err := u.svc.Store.Quarantine(ctx, u.WorkspaceID, reason); err != nil {
		return err
	}
	return u.svc.Store.WorkspaceEvent(ctx, u.OrganizationID, u.ProjectID, u.ConversationID, TurnEvent{
		Type: events.TypeWorkspaceQuarantined, ActorKind: events.ActorKindWorker, ActorID: u.WorkerID,
		Payload: events.WorkspaceQuarantinedPayload{
			WorkspaceID: u.WorkspaceID, ProjectID: u.ProjectID, Reason: reason,
		},
	})
}

// stagedPathsFor is the apm-side helper the exclusion merge needs, kept as a
// method so a caller cannot pass a checkout's staged set into the wrong repo's
// exclusion list.
func (u *Unit) stagedPathsFor(name string) []string {
	staged, ok := u.Staged[name]
	if !ok || staged == nil {
		return nil
	}
	return append([]string(nil), staged.GeneratedPaths...)
}

// DigestStaged is the APM lock digest of one repository, for the case-14
// stability assertion: two turns on the same profile revision must report the
// same value, and a value that moved says the packaged context moved with it
// (probe A5: --frozen does not freeze content).
func (u *Unit) DigestStaged(name string) string {
	staged, ok := u.Staged[name]
	if !ok || staged == nil {
		return ""
	}
	return staged.LockDigest
}

var (
	_ = apm.TargetClaude
	_ = strings.TrimSpace
)
