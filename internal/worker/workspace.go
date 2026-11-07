package worker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// Workspace prepares the per-conversation working directory described by
// communication-spec/05-workspaces-security-secrets.md:
//
//	<root>/<conversationId>/
//	  repos/<name>/   shallow clones of the project repositories
//	  scratch/        generated documents, temporary outputs
//	  meta/           worker-only metadata (never agent content)
//
// The agent runs with cwd = the workspace root, so it sees every repo of
// the project side by side. A repository that cannot be cloned is reported
// as a transcript note by the caller — it must not fail the turn, because
// many prompts need no repository at all.
type Workspace struct {
	// Root is COMMUNICATION_WORKSPACE_ROOT; conversations live in one
	// directory named by their (immutable) conversation id.
	Root string

	// RunGit executes one git command; nil uses exec.CommandContext. It is
	// the test seam — no git binary is required to unit-test layout logic.
	RunGit func(ctx context.Context, dir string, args ...string) ([]byte, error)

	// AllowFileGitURLs (audit F6) admits `file://` repository clones. Default
	// false: a file:// URL makes this worker read an arbitrary path it can
	// reach on this host, which only makes sense when the host is the single
	// developer who owns the projects. Sourced from the worker's own
	// COMMUNICATION_ALLOW_FILE_GIT_URLS (the same variable the API replica
	// reads), so a deployment must say it twice on purpose.
	AllowFileGitURLs bool
}

// refuseFileGitURL is the workspace note a disabled worker answers a file://
// repository with. Clone failures are notes, not launch failures (this file's
// contract: "failures are visible, not fatal"), so the refusal reads like the
// other notes and names the exact switch that lifts it.
func refuseFileGitURL(label, gitURL string) string {
	return fmt.Sprintf("clone of %s from %s refused: %s", label, redactURL(gitURL), wsgit.FileGitURLRefusal)
}

var (
	// uuidDir guards path construction: a conversation id must be exactly
	// the canonical uuid text, so nothing from the database can traverse.
	uuidDir = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)
	// safeRepoName restricts repository names used as directory components.
	safeRepoName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// Prepare creates (or reuses) the conversation workspace and returns its
// path plus human-readable notes for every repository that failed to
// mirror. Re-running is cheap: existing clones are left alone (later
// milestones add worktree/checkpoint management here).
func (w *Workspace) Prepare(ctx context.Context, conversationID string, repos []Repo) (string, []string, error) {
	if w.Root == "" {
		return "", nil, errors.New("worker: workspace root is not configured")
	}
	if !uuidDir.MatchString(conversationID) {
		return "", nil, fmt.Errorf("worker: conversation id %q is not a uuid", conversationID)
	}
	dir := filepath.Join(w.Root, conversationID)
	for _, sub := range []string{"", "repos", "scratch", "meta"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return "", nil, fmt.Errorf("worker: workspace %s: %w", sub, err)
		}
	}
	// meta/ is the worker's own note-taking space; keep a stable marker so
	// an operator can map a directory back to its conversation.
	if err := os.WriteFile(filepath.Join(dir, "meta", "conversation_id"), []byte(conversationID+"\n"), 0o644); err != nil {
		return "", nil, fmt.Errorf("worker: workspace meta: %w", err)
	}

	var notes []string
	for _, r := range repos {
		note := w.mirror(ctx, dir, r)
		if note != "" {
			notes = append(notes, note)
		}
	}
	return dir, notes, nil
}

// mirror clones one repository shallowly onto its default branch unless the
// checkout already exists, returning "" on success or the transcript note
// on failure (05: failures are visible, not fatal).
func (w *Workspace) mirror(ctx context.Context, root string, r Repo) string {
	label := r.Name
	if !safeRepoName.MatchString(r.Name) {
		return fmt.Sprintf("repository name %q is not a safe directory name; not mirrored", r.Name)
	}
	if !w.AllowFileGitURLs && strings.HasPrefix(r.GitURL, "file://") {
		// Defence in depth (audit F6): even a row written while the server
		// setting was on — or migrated in by hand — is not cloned unless this
		// worker was told to allow it too. Checked before the stat so a
		// previously-allowed clone is not silently re-used by a worker that
		// turned the flag off.
		return refuseFileGitURL(label, r.GitURL)
	}
	dir := filepath.Join(root, "repos", r.Name)
	if st, err := os.Stat(filepath.Join(dir, ".git")); err == nil && st.IsDir() {
		return "" // already mirrored for this conversation
	}
	run := w.RunGit
	if run == nil {
		run = defaultRunGit
	}
	args := []string{"-c", "core.autocrlf=false", "-c", "credential.helper=",
		"clone", "--depth", "1", "--single-branch", r.GitURL, dir}
	// default_branch is metadata about the upstream default; --single-branch
	// already checks out exactly that HEAD. Pinning it here would fight the
	// mirror when the branch was renamed upstream.
	if out, err := run(ctx, "", args...); err != nil {
		// Leave no half-clone behind for the agent to stumble into.
		removeAllQuiet(dir)
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Sprintf("clone of %s from %s failed: %s", label, redactURL(r.GitURL), bounded(msg, 300))
	}
	return ""
}

// defaultRunGit runs git without a shell; git refuses to operate on
// repositories owned by another uid, so the -c safe.directory escape keeps
// shared lab workspaces usable without weakening anything else.
func defaultRunGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	full := append([]string{"-c", "safe.directory=*"}, args...)
	cmd := exec.CommandContext(ctx, "git", full...) //nolint:gosec // argv only, no shell
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

// redactURL strips any userinfo from a git URL so credentials pasted into
// a repository row never reach the transcript.
func redactURL(raw string) string {
	if i := strings.Index(raw, "://"); i >= 0 {
		rest := raw[i+3:]
		if j := strings.IndexAny(rest, "@/"); j >= 0 && rest[j] == '/' {
			return raw[:i+3] + rest[j+1:]
		}
	}
	return raw
}

func removeAllQuiet(dir string) { _ = os.RemoveAll(dir) }
