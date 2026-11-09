package worker

// The patch artifact a unit capture publishes (ADR-0078 § Patch artifacts):
// one `patch` artifact per capture, the unified diff of the run's workspace
// against the attempt's base, bounded at a hunk boundary, and scanned by the
// unit's own materialized-secret hook before a byte reaches the store.
//
// These run the REAL git binary over a real checkout — the thing under test is
// what `git diff` says about an actual tree, which a fake Summary could only
// assert about itself (AGENTS.md: a mocked green test never substitutes for a
// real integration test). Only the artifact store is faked, and it is faked
// with the exact seam the production capturer implements.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// patchCapturer is the worker.ArtifactCapturer seam: every CaptureRequest that
// reached the store, in order.
type patchCapturer struct {
	mu   sync.Mutex
	reqs []CaptureRequest
	err  error
}

var _ ArtifactCapturer = (*patchCapturer)(nil)

func (c *patchCapturer) Capture(_ context.Context, req CaptureRequest) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return "", c.err
	}
	c.reqs = append(c.reqs, req)
	return fmt.Sprintf("art-%d", len(c.reqs)), nil
}

func (c *patchCapturer) byKind(kind string) []CaptureRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []CaptureRequest
	for _, r := range c.reqs {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

// patchGitFixture is a real checkout plus the commit a capture would call its
// base. It lives outside $TMPDIR by choice: `t.TempDir()` is under /tmp, which
// the workspace package refuses as a workspace root, and a test that had to
// fake the root would stop testing the read the contract cares about.
type patchGitFixture struct {
	checkout string
	base     string
	root     string
}

func newPatchGitFixture(t *testing.T) *patchGitFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git binary required: %v", err)
	}
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for lab scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	if err := wsgit.RefuseTempPath(base); err != nil {
		t.Skipf("lab scratch location: %v", err)
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, t.Name()+"-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	work := filepath.Join(root, "checkout")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &patchGitFixture{checkout: work, root: root}
	f.git(t, "init", "-q", "-b", "main", work)
	f.git(t, "config", "user.name", "communication-test")
	f.git(t, "config", "user.email", "test@communication.invalid")
	writePatchFile(t, work, "hello.py", "print('hello')\n")
	f.git(t, "add", "-A")
	f.git(t, "commit", "-qm", "seed")
	f.base = strings.TrimSpace(f.git(t, "rev-parse", "HEAD"))
	return f
}

func (f *patchGitFixture) git(t *testing.T, argv ...string) string {
	t.Helper()
	cmd := exec.Command("git", argv...) //nolint:gosec // test fixture argv
	cmd.Dir = f.checkout
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=communication-test", "GIT_AUTHOR_EMAIL=test@communication.invalid",
		"GIT_COMMITTER_NAME=communication-test", "GIT_COMMITTER_EMAIL=test@communication.invalid",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", argv, err, out)
	}
	return string(out)
}

func writePatchFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func patchUnit(svc *UnitService) *Unit {
	return &Unit{
		svc:            svc,
		WorkspaceID:    "ws-1",
		OrganizationID: "org-1",
		ProjectID:      "prj-1",
		ConversationID: "conv-1",
		TurnID:         "turn-1",
		WorkerID:       "worker-1",
		FencingToken:   7,
		logger:         slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
}

func patchSvc(store ArtifactCapturer, git *wsgit.Manager) *UnitService {
	return &UnitService{Artifacts: store, Workspaces: git}
}

func TestUnitCapturePatchesStoresOneReviewablePatch(t *testing.T) {
	f := newPatchGitFixture(t)
	// The agent's turn: one committed edit, one untracked new file.
	writePatchFile(t, f.checkout, "hello.py", "print('hello')\nprint('world')\n")
	f.git(t, "add", "hello.py")
	f.git(t, "commit", "-qm", "the greeting")
	writePatchFile(t, f.checkout, "greet/__init__.py", "def greet():\n    return 'hi'\n")

	store := &patchCapturer{}
	mgr := &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}}
	u := patchUnit(patchSvc(store, mgr))
	u.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: f.checkout}}

	outcomes := []CaptureOutcome{{
		RepositoryID: "repo-app", RepoName: "app", BaseCommit: f.base,
		Dirty: true, Manifest: []string{"greet/__init__.py", "hello.py"},
		Summary: "2 tracked/untracked path(s) differ from the run branch",
	}}
	id, err := u.capturePatches(context.Background(), outcomes)
	if err != nil {
		t.Fatalf("capturePatches: %v", err)
	}
	if id == "" {
		t.Fatal("a changed tree published no patch artifact")
	}
	patches := store.byKind(ArtifactKindPatch)
	if len(patches) != 1 {
		t.Fatalf("a capture published %d patch artifacts, want exactly one: %+v", len(patches), patches)
	}
	req := patches[0]
	if req.MediaType != "text/x-diff" {
		t.Fatalf("media type = %q, want text/x-diff", req.MediaType)
	}
	if req.Name != "patch-app" {
		t.Fatalf("name = %q, want patch-app", req.Name)
	}
	// Same visibility and project scoping as the checkpoint artifact: the same
	// ids, the same fence.
	for _, want := range []struct{ field, value string }{
		{"organization", req.OrganizationID}, {"project", req.ProjectID},
		{"workspace", req.WorkspaceID}, {"conversation", req.ConversationID},
		{"turn", req.TurnID}, {"worker", req.WorkerID},
	} {
		if want.value == "" {
			t.Fatalf("the patch artifact lost its %s scope", want.field)
		}
	}
	if req.FencingToken != 7 {
		t.Fatalf("the patch artifact published on fencing token %d, want the unit's 7", req.FencingToken)
	}
	body := string(req.Content)
	for _, want := range []string{
		"diff --git a/hello.py b/hello.py",
		"+print('world')",
		"diff --git a/greet/__init__.py b/greet/__init__.py",
		"+    return 'hi'",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("the patch artifact lacks %q:\n%s", want, body)
		}
	}
	// A tree that says nothing new against its base publishes no patch: the
	// artifact is the change, not the turn.
	fresh := newPatchGitFixture(t)
	store2 := &patchCapturer{}
	u2 := patchUnit(patchSvc(store2, &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}}))
	u2.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: fresh.checkout}}
	if id, err := u2.capturePatches(context.Background(), []CaptureOutcome{{
		RepositoryID: "repo-app", RepoName: "app", BaseCommit: fresh.base,
	}}); err != nil || id != "" {
		t.Fatalf("an unchanged tree published %q, err %v", id, err)
	}
	if got := store2.byKind(ArtifactKindPatch); len(got) != 0 {
		t.Fatalf("an unchanged tree published %+v", got)
	}
}

func TestUnitCapturePatchesTruncatesAtAHunkBoundary(t *testing.T) {
	f := newPatchGitFixture(t)
	// Wide rather than tall: hundreds of new files each with a full hunk, so the
	// cut has somewhere to land that is a section or hunk boundary. (The
	// single-giant-hunk shape is what wsgit.BoundPatch's own test pins.)
	for i := 1; i <= 400; i++ {
		var b strings.Builder
		for l := 1; l <= 80; l++ {
			fmt.Fprintf(&b, "func%d_line%d()\n", i, l)
		}
		writePatchFile(t, f.checkout, fmt.Sprintf("gen/file%03d.py", i), b.String())
	}

	store := &patchCapturer{}
	mgr := &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}}
	u := patchUnit(patchSvc(store, mgr))
	u.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: f.checkout}}
	outcomes := []CaptureOutcome{{RepositoryID: "repo-app", RepoName: "app", BaseCommit: f.base,
		Dirty: true, Manifest: []string{"gen/file001.py"}}}
	if _, err := u.capturePatches(context.Background(), outcomes); err != nil {
		t.Fatalf("capturePatches: %v", err)
	}
	patches := store.byKind(ArtifactKindPatch)
	if len(patches) != 1 {
		t.Fatalf("want one patch artifact, got %d", len(patches))
	}
	body := string(patches[0].Content)
	if len(body) > patchArtifactMaxBytes {
		t.Fatalf("the artifact is %d bytes, over the %d bound", len(body), patchArtifactMaxBytes)
	}
	if !strings.Contains(body, "(truncated,") {
		t.Fatalf("a bound artifact carries no truncation note:\n%s…", body[:400])
	}
	if !strings.HasSuffix(body, "\n") {
		t.Fatal("the bounded artifact does not end on a line boundary")
	}
	// The note is the artifact's last line, and the line under it is a whole
	// hunk's last line — never a hunk cut in half.
	noteLines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if !strings.HasPrefix(noteLines[len(noteLines)-1], "\u2026 (truncated,") {
		t.Fatalf("the truncation note is not the last line: %q", noteLines[len(noteLines)-1])
	}
	last := noteLines[len(noteLines)-2]
	if !strings.HasPrefix(last, "+") && !strings.HasPrefix(last, "-") && !strings.HasPrefix(last, " ") {
		t.Fatalf("the artifact ends on %q, not on a hunk's last line", last)
	}
	// Every hunk header that survived still has its full new-side count: the
	// cut never lands inside a hunk.
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		if !strings.HasPrefix(l, "@@ -") {
			continue
		}
		fields := strings.Fields(strings.SplitN(strings.TrimPrefix(l, "@@ "), "@@", 2)[0])
		if len(fields) != 2 {
			continue
		}
		newSide := strings.Split(fields[1], ",")
		if len(newSide) != 2 {
			continue
		}
		want := 0
		fmt.Sscanf(newSide[1], "%d", &want)
		seen := 0
		for j := i + 1; j < len(lines); j++ {
			nxt := lines[j]
			if nxt == "" || strings.HasPrefix(nxt, "@@ ") || strings.HasPrefix(nxt, "diff --git ") ||
				strings.HasPrefix(nxt, "…") {
				break
			}
			seen++
		}
		if seen != want {
			t.Fatalf("hunk %q kept %d of %d lines — the diff was clipped mid-hunk", l, seen, want)
		}
	}
}

func TestUnitCapturePatchesRedactsAPlantedSecret(t *testing.T) {
	f := newPatchGitFixture(t)
	// The agent cat'd the materialized mount into a tracked file. Git's exclusion
	// set hides the mount itself, not what the agent copied out of it, so this is
	// the case the redaction scanner exists for (12-test-strategy case 12).
	const secret = "ghp_plantedsecretvalue00000000000000000000"
	writePatchFile(t, f.checkout, "leak.py", "TOKEN = \""+secret+"\"\n")

	store := &patchCapturer{}
	mgr := &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}}
	u := patchUnit(patchSvc(store, mgr))
	u.Materialized = &Materialized{
		Env:   []string{"TOKEN=" + secret},
		Files: []string{filepath.Join(f.checkout, ".env.test.local")},
		Redact: func(text string) (string, int) {
			// The seam's own contract, stated in seams.go: replace every
			// occurrence of a value this unit materialized, and count.
			n := strings.Count(text, secret)
			return strings.ReplaceAll(text, secret, "[REDACTED]"), n
		},
	}
	u.ExcludedPaths = []string{".env.test.local"}
	u.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: f.checkout}}
	outcomes := []CaptureOutcome{{RepositoryID: "repo-app", RepoName: "app", BaseCommit: f.base,
		Dirty: true, Manifest: []string{"leak.py"}}}
	if _, err := u.capturePatches(context.Background(), outcomes); err != nil {
		t.Fatalf("capturePatches: %v", err)
	}
	patches := store.byKind(ArtifactKindPatch)
	if len(patches) != 1 {
		t.Fatalf("want one patch artifact, got %d", len(patches))
	}
	body := string(patches[0].Content)
	if strings.Contains(body, secret) {
		t.Fatalf("the artifact stored the planted secret verbatim:\n%s", body)
	}
	if !strings.Contains(body, "[REDACTED]") {
		t.Fatalf("the artifact holds no redaction marker:\n%s", body)
	}
}

// A capture with no artifact store publishes nothing and says nothing: the rule
// every other capture path in this package already carries.
func TestUnitCapturePatchesWithoutAStoreIsSilent(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "hello.py", "print('no store')\n")
	u := patchUnit(&UnitService{Workspaces: &wsgit.Manager{Git: &wsgit.Runner{Home: f.root}}})
	u.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: f.checkout}}
	if id, err := u.capturePatches(context.Background(),
		[]CaptureOutcome{{RepositoryID: "repo-app", RepoName: "app", BaseCommit: f.base}}); err != nil || id != "" {
		t.Fatalf("a capture with no store published %q, err %v", id, err)
	}
}

// The store refusing is a warning, not a failed capture: the patch call returns
// the error the caller logs and never touches the checkpoint's own outcome.
func TestUnitCapturePatchesReportsStoreRefusal(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "hello.py", "print('refused')\n")
	store := &patchCapturer{err: errors.New("backend offline")}
	mgr := &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}}
	u := patchUnit(patchSvc(store, mgr))
	u.Repos = []wsgit.PreparedRepo{{RepositoryID: "repo-app", Name: "app", CheckoutPath: f.checkout}}
	if _, err := u.capturePatches(context.Background(),
		[]CaptureOutcome{{RepositoryID: "repo-app", RepoName: "app", BaseCommit: f.base}}); err == nil {
		t.Fatal("a refused artifact store went unreported")
	}
}
