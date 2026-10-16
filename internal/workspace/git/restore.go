package git

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// commitObjectID is the only shape a restore target may have. The value comes
// from a run_checkpoints.repo_states row (a `rev-parse` read, ADR-0017 D8), so
// anything else — a ref name, a flag, an empty string — is a corrupted or
// invented boundary, and argv safety is not a reason to hand git a word it
// could interpret.
var commitObjectID = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// RestoreRequest names one checkout, the commit its branch must return to, and
// the declared exclusions that the reset must neither destroy nor report
// (ADR-0023 § 6's restore_checkpoint arm over ADR-0017 D6's exclusion set).
type RestoreRequest struct {
	// Checkout is the worktree's absolute path.
	Checkout string
	// HeadCommit is checkpoint.head_commit for this repository: the last
	// completed boundary's commit identity.
	HeadCommit string
	// Excluded is the workspace's declared exclusion set. An excluded path is
	// invisible to `git status` and survives `git clean -fd` (no -x), so it is
	// never a discarded path.
	Excluded []string
}

// RestoreReport is what one unsandboxed reset changed, measured rather than
// claimed: DiscardedPaths is the disclosure the run.checkpoint_restored event
// carries, and HeadBefore/HeadAfter are two ref reads around the reset.
type RestoreReport struct {
	HeadBefore     string
	HeadAfter      string
	DiscardedPaths []string
}

// ErrRestoreRefused reports a restore that stopped BEFORE touching the tree.
// Every refusal in this file is of that kind: a reset whose boundary it cannot
// verify, or whose tree it cannot prove clean afterwards, destroys work the ADR
// does not license it to destroy (C6d: a destructive default would be a data-loss
// bug wearing a feature badge).
var ErrRestoreRefused = errors.New("workspace: checkpoint restore refused")

// RestoreToBoundary returns one checkout's branch to a recorded boundary,
// unsandboxed, in the worker process (ADR-0023 § 6: the worker performs this
// itself, before launching anything, and no sandbox policy covers it).
//
// The order is refusal-first, destroy-second:
//
//  1. the target must be a hex object id that THIS checkout can resolve to a
//     commit — an unresolvable boundary is refused, never guessed at;
//  2. a checkout holding a nested repository (a submodule, or an untracked dir
//     with its own .git) is refused outright: `git clean` needs `-ff` to remove
//     it and `git reset` does not reach inside it, and ADR-0023 § 6 says nothing
//     about submodules, so this code does not decide the question by deleting
//     somebody's work;
//  3. the discarded set is measured (status --porcelain + diff --name-only
//     against the boundary), then `reset --hard` and `clean -fd` run;
//  4. the outcome is proven by reading the ref and the tree again — probe P8's
//     rule that an exit status is not evidence — and a tree that is still dirty
//     is reported as a failure, not as a restore.
func (m *Manager) RestoreToBoundary(ctx context.Context, req RestoreRequest) (RestoreReport, error) {
	var rep RestoreReport
	if m == nil || m.Git == nil {
		return rep, fmt.Errorf("%w: no git runner is configured", ErrRestoreRefused)
	}
	if req.Checkout == "" {
		return rep, fmt.Errorf("%w: no checkout directory", ErrRestoreRefused)
	}
	if err := checkAbsoluteNoDotDot(req.Checkout); err != nil {
		return rep, fmt.Errorf("%w: checkout path: %v", ErrRestoreRefused, err)
	}
	if !commitObjectID.MatchString(req.HeadCommit) {
		return rep, fmt.Errorf("%w: boundary %q is not a hex commit identity: nothing was reset",
			ErrRestoreRefused, Redact(req.HeadCommit))
	}
	target, err := m.resolveCommit(ctx, req.Checkout, req.HeadCommit)
	if err != nil {
		return rep, err
	}
	before, err := m.HeadCommit(ctx, req.Checkout)
	if err != nil {
		return rep, fmt.Errorf("%w: %v", ErrRestoreRefused, err)
	}

	// A checkout holding a nested repository is refused rather than cleaned:
	// `git clean -fd` skips it (it needs -ff), `git reset --hard` does not reach
	// inside it, and ADR-0023 § 6 says nothing about submodules. That question
	// is not this code's to decide by deletion.
	nested, err := m.nestedRepos(req.Checkout)
	if err != nil {
		return rep, fmt.Errorf("%w: %v", ErrRestoreRefused, err)
	}
	if len(nested) > 0 {
		return rep, fmt.Errorf("%w: %s holds nested repositories (%s); ADR-0023 § 6 does not define restore "+
			"semantics for them, so nothing was reset", ErrRestoreRefused, req.Checkout, strings.Join(nested, ", "))
	}

	discarded, err := m.discardedPaths(ctx, req.Checkout, target, req.Excluded)
	if err != nil {
		return rep, err
	}
	rep.HeadBefore, rep.DiscardedPaths = before, discarded

	if _, err := m.Git.Stdout(ctx, req.Checkout, "reset", "--hard", target); err != nil {
		return rep, fmt.Errorf("workspace: checkpoint reset in %s to %s: %w", req.Checkout, target, err)
	}
	if _, err := m.Git.Stdout(ctx, req.Checkout, "clean", "-fd"); err != nil {
		return rep, fmt.Errorf("workspace: untracked clean in %s after reset: %w", req.Checkout, err)
	}

	after, err := m.HeadCommit(ctx, req.Checkout)
	if err != nil {
		return rep, fmt.Errorf("workspace: head after checkpoint reset in %s: %w", req.Checkout, err)
	}
	rep.HeadAfter = after
	if after != target {
		return rep, fmt.Errorf("workspace: %s is at %s after restore, want %s", req.Checkout, after, target)
	}
	leftover, err := m.discardedPaths(ctx, req.Checkout, target, req.Excluded)
	if err != nil {
		return rep, err
	}
	if len(leftover) > 0 {
		return rep, fmt.Errorf("workspace: %s still differs from boundary %s after restore: %s",
			req.Checkout, target, strings.Join(leftover, ", "))
	}
	return rep, nil
}

// resolveCommit verifies the boundary names a commit THIS checkout can reach and
// returns the resolved object id, so the reset and the post-check compare the
// exact string git uses.
func (m *Manager) resolveCommit(ctx context.Context, checkout, rev string) (string, error) {
	out, err := m.Git.Stdout(ctx, checkout, "rev-parse", "--verify", rev+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("%w: boundary %s does not resolve to a commit in %s: nothing was reset",
			ErrRestoreRefused, Redact(rev), checkout)
	}
	return strings.TrimSpace(firstLine(out)), nil
}

// discardedPaths measures what a reset to target would destroy: the worktree's
// status (tracked edits, staged entries and untracked files) unioned with every
// path that differs from the boundary itself. Declared exclusions are subtracted
// — Status already filters them twice per ADR-0017 D6 and `clean -fd` without -x
// leaves them, so they are neither destroyed nor reported.
func (m *Manager) discardedPaths(ctx context.Context, checkout, target string, excluded []string) ([]string, error) {
	drop := map[string]bool{}
	for _, e := range excluded {
		drop[strings.TrimSuffix(filepath.ToSlash(filepath.Clean(e)), "/")] = true
	}
	status, err := m.Status(ctx, checkout, excluded)
	if err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, p := range status.Paths {
		set[p] = true
	}
	out, err := m.Git.Stdout(ctx, checkout, "diff", "--name-only", target)
	if err != nil {
		return nil, fmt.Errorf("workspace: diff of %s against boundary %s: %w", checkout, target, err)
	}
	for _, line := range strings.Split(out, "\n") {
		p := filepath.ToSlash(strings.TrimSpace(line))
		if p == "" || drop[p] {
			continue
		}
		set[p] = true
	}
	var paths []string
	for p := range set {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths, nil
}

// nestedRepos reports directories inside the checkout that carry their own .git
// (a submodule, or an untracked clone), excluding the checkout's own gitdir.
func (m *Manager) nestedRepos(checkout string) ([]string, error) {
	var found []string
	if _, err := os.Stat(filepath.Join(checkout, ".gitmodules")); err == nil {
		found = append(found, ".gitmodules")
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("workspace: reading %s: %w", checkout, err)
	}
	err := filepath.WalkDir(checkout, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable subtree is not a licence to destroy it.
			return err
		}
		rel, rerr := filepath.Rel(checkout, p)
		if rerr != nil {
			return rerr
		}
		if rel == "." {
			return nil // the checkout directory itself
		}
		if rel == ".git" {
			// Its own gitdir (a directory) or its worktree pointer file — in
			// the first case, do not walk inside it.
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			found = append(found, filepath.ToSlash(filepath.Dir(rel)))
			return fs.SkipDir
		}
		if !d.IsDir() && d.Name() == ".git" {
			found = append(found, filepath.ToSlash(filepath.Dir(rel)))
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("workspace: scanning %s for nested repositories: %w", checkout, err)
	}
	sort.Strings(found)
	return found, nil
}
