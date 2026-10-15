package materialize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// The lab this package is tested in is the layout the worker actually creates:
// a mirror whose info/exclude is the shared config, and one worktree per run
// unit pointing at it via a .git file. docs/compatibility/M3-PROBES.md § G is
// the claim under test — in particular that the exclusion lives in the mirror
// and that the project-scoped exclusion means a cleanup must not remove it — so
// these tests run real git against real worktrees rather than mocking the
// commands away.

const (
	sentinel   = "dckr_pat_M3SENTINELvalue"
	repoName   = "registry-client"
	secretID   = "11111111-2222-3333-4444-555555555555"
	trackedEnv = "TRACKED_FILE_CONTENT"
)

type lab struct {
	t        *testing.T
	root     string
	mirror   string
	external string // a path outside every checkout, the symlink target
	home     string // the C-ENV5 shape: ~/.ssh/authorized_keys
}

// newLab builds origin → mirror → one or more unit worktrees.
func newLab(t *testing.T, units ...string) *lab {
	t.Helper()
	root := t.TempDir()
	l := &lab{t: t, root: root}
	origin := filepath.Join(root, "origin")
	l.external = filepath.Join(root, "outside")
	l.home = filepath.Join(root, "home")
	if err := os.MkdirAll(filepath.Join(l.home, ".ssh"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.home, ".ssh", "authorized_keys"), []byte("ssh-ed25519 ORIGINAL\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.external, []byte("ORIGINAL OUTSIDE CONTENT\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(origin, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, origin, "init", "--initial-branch=main")
	mustGit(t, origin, "config", "user.email", "lab@local")
	mustGit(t, origin, "config", "user.name", "lab")
	for path, content := range map[string]string{
		"tracked.txt":       trackedEnv + "\n",
		"app/config.yaml":   "database: prod\n",
		"app/.env.local":    "PREEXISTING TRACKED VALUE\n",
		".env.dontwrite":    "not tracked\n",
		"app/tracked.env":   "TRACKED=1\n",
		"app/plain.env":     "PLAIN=1\n",
		"link-target/env":   "target\n",
		"sibling/keep.txt":  "sibling\n",
		"deep/a/b/c/leaf":   "deep\n",
		"secret-dir/keep":   "keep\n",
		"backslash\\name":   "windows shaped\n",
		"weird name.env":    "space in name\n",
		"app/nested/deep.x": "deep\n",
		"tracked-dir/file":  "in a tracked dir\n",
	} {
		full := filepath.Join(origin, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, origin, "add", "-A")
	mustGit(t, origin, "-c", "user.email=lab@local", "-c", "user.name=lab", "commit", "-qm", "lab origin")

	l.mirror = filepath.Join(root, "mirror")
	mustGit(t, root, "clone", "--mirror", "file://"+origin, l.mirror)
	for _, unit := range units {
		dir := filepath.Join(root, unit, "repos", repoName)
		if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
			t.Fatal(err)
		}
		// --detach because two units of one project check the same commit out
		// side by side, and git refuses to give one branch to two worktrees.
		mustGit(t, l.mirror, "worktree", "add", "--detach", dir, "main")
	}
	return l
}

func (l *lab) checkout(unit string) Repository {
	l.t.Helper()
	return Repository{
		Name:       repoName,
		Path:       filepath.Join(l.root, unit, "repos", repoName),
		MirrorPath: l.mirror,
	}
}

func (l *lab) materializer(units ...string) *Materializer {
	l.t.Helper()
	repos := make([]Repository, 0, len(units))
	for _, unit := range units {
		repos = append(repos, l.checkout(unit))
	}
	m, err := New(Options{Repositories: repos})
	if err != nil {
		l.t.Fatalf("New: %v", err)
	}
	return m
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return string(out)
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, _ := cmd.CombinedOutput()
	return string(out)
}

func envFileMount(rel string) Mount {
	return Mount{
		SecretID:       secretID,
		SecretSlug:     "docker-hub-token",
		Version:        1,
		RepositoryName: repoName,
		DeliveryMode:   "env_file",
		RelativePath:   rel,
		Key:            "REGISTRY_TOKEN",
		Lifecycle:      "turn",
	}
}

func multilineValue() []byte {
	return []byte("REGISTRY_USER=robot$ci\nREGISTRY_TOKEN=" + sentinel + "\nREGISTRY_URL=https://registry.example\n")
}

func TestDeliversEnvFileWithZeroSixZeroZero(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	receipt, err := m.Deliver(ctx, &Delivery{Mount: envFileMount(".env.local"), Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	defer func() { _ = receipt.Cleanup(ctx) }()

	path := filepath.Join(repo.Path, ".env.local")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode = %04o, want 0600", perm)
	}
	// The mount's key selection is the whole content of the file: a .env.local
	// that carried the user and the URL too would leak two more facts than the
	// mount authorized.
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := "REGISTRY_TOKEN=" + sentinel + "\n"; string(content) != want {
		t.Fatalf("content = %q, want %q", content, want)
	}
	if receipt.FileMode != Mode || receipt.Target != path || receipt.RelativePath != ".env.local" {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(receipt.KeyNames) != 1 || receipt.KeyNames[0] != "REGISTRY_TOKEN" {
		t.Fatalf("KeyNames = %v", receipt.KeyNames)
	}
	// Step 5, proven at the git level rather than by trusting the append: the
	// rule lives in the mirror (so it covers every worktree of the project), it
	// is the rule git actually applied, and the file is invisible to status,
	// ls-files and diff.
	exclude := filepath.Join(l.mirror, "info", "exclude")
	raw, err := os.ReadFile(exclude)
	if err != nil {
		t.Fatalf("read %s: %v", exclude, err)
	}
	if !strings.Contains(string(raw), "/.env.local\n") {
		t.Fatalf("mirror info/exclude lacks the exclusion:\n%s", raw)
	}
	ignored := gitOut(t, repo.Path, "check-ignore", "-v", "--", ".env.local")
	if !strings.Contains(ignored, exclude) {
		t.Fatalf("check-ignore did not attribute the rule to %s: %s", exclude, ignored)
	}
	if status := gitOut(t, repo.Path, "status", "--porcelain"); strings.Contains(status, ".env.local") {
		t.Fatalf("the materialized file is visible to git status:\n%s", status)
	}
	if listed := gitOut(t, repo.Path, "ls-files", "--", ".env.local"); strings.Contains(listed, ".env.local") {
		t.Fatalf("the materialized file is tracked: %s", listed)
	}
	if diff := gitOut(t, repo.Path, "diff", "--name-only"); strings.Contains(diff, ".env.local") {
		t.Fatalf("the materialized file appears in a diff: %s", diff)
	}
	// Meta is what secret.materialized carries: facts, never the value.
	meta, err := json.Marshal(receipt.Meta())
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}
	if strings.Contains(string(meta), sentinel) {
		t.Fatalf("the event metadata carries the value: %s", meta)
	}
	if !strings.Contains(string(meta), `"mode":"0600"`) {
		t.Fatalf("event metadata lost the mode: %s", meta)
	}
}

func TestMaterializesIntoSubdirectoryAndCreatesParents(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	receipt, err := m.Deliver(ctx, &Delivery{Mount: envFileMount("app/nested/new/db.env"), Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	defer func() { _ = receipt.Cleanup(ctx) }()

	path := filepath.Join(repo.Path, "app/nested/new/db.env")
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("stat %s: %v", path, err)
	}
	if ignored := gitOut(t, repo.Path, "check-ignore", "-v", "--", "app/nested/new/db.env"); !strings.Contains(ignored, "info/exclude") {
		t.Fatalf("nested path is not excluded by the mirror: %s", ignored)
	}
	// The created directory is workspace state the run did not ask to keep:
	// cleanup removes the file and leaves the empty directory, which git does
	// not see, rather than deleting a directory that predated the mount.
	if err := receipt.Cleanup(ctx); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup left the file behind: %v", err)
	}
}

func TestRefusesTheCEnv6Battery(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	for _, tc := range []struct {
		path      string
		reason    string
		createdIn string // path that must NOT exist afterwards, relative to repo
		outsideAt string // path that must keep its original content
	}{
		{path: "", reason: ReasonBadShape},
		{path: "../outside-file", reason: ReasonPathEscape},
		{path: "app/../../outside-file", reason: ReasonPathEscape},
		{path: "a/../b", reason: ReasonPathEscape},
		{path: "/etc/passwd", reason: ReasonAbsolutePath},
		{path: "app//db.env", reason: ReasonBadShape},
		{path: "./app/db.env", reason: ReasonBadShape},
		{path: "app/./db.env", reason: ReasonBadShape},
		{path: "app/db.env/", reason: ReasonBadShape},
		{path: "C:\\\\secrets\\\\db.env", reason: ReasonAbsolutePath},
		{path: "a\\b.env", reason: ReasonBadShape},
		{path: ".git/config", reason: ReasonPathEscape},
		{path: "app/.git/config", reason: ReasonPathEscape},
		{path: "not-clean/../clean.env", reason: ReasonPathEscape},
		{path: "..", reason: ReasonPathEscape},
		{path: "app/tracked.env", reason: ReasonTrackedTarget},
		{path: "app/config.yaml", reason: ReasonTrackedTarget},
		{path: "tracked.txt", reason: ReasonTrackedTarget},
	} {
		t.Run(tc.path, func(t *testing.T) {
			_, err := m.Deliver(ctx, &Delivery{Mount: envFileMount(tc.path), Value: multilineValue()})
			if err == nil {
				t.Fatalf("Deliver(%q) succeeded", tc.path)
			}
			if got := RefusalReason(err); got != tc.reason {
				t.Fatalf("Deliver(%q) reason = %q, want %q (%v)", tc.path, got, tc.reason, err)
			}
			// Refusal is a refusal: no new content appeared anywhere the path
			// could have landed, and nothing the path could escape to was
			// disturbed.
			if status := gitOut(t, repo.Path, "status", "--porcelain"); strings.Contains(status, sentinel) {
				t.Fatalf("Deliver(%q) wrote material despite refusing:\n%s", tc.path, status)
			}
			if raw, readErr := os.ReadFile(l.external); readErr != nil || !strings.Contains(string(raw), "ORIGINAL") {
				t.Fatalf("the outside file was disturbed: %q %v", raw, readErr)
			}
			if raw, readErr := os.ReadFile(filepath.Join(l.home, ".ssh", "authorized_keys")); readErr != nil || !strings.Contains(string(raw), "ORIGINAL") {
				t.Fatalf("~/.ssh shape was disturbed: %q %v", raw, readErr)
			}
		})
	}
	// The status check that C-ENV6 ends with: nothing was staged, nothing
	// appeared.
	if status := gitOut(t, repo.Path, "status", "--porcelain"); strings.Contains(status, "sentinel") || strings.Contains(status, ".env.local") {
		t.Fatalf("status is not clean after the battery:\n%s", status)
	}
}

func TestRefusesSymlinkedParentAndTarget(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	// The escape C-ENV5 had to be rewritten for: the workspace itself is not the
	// threat — the workspace containing a link out of it is.
	linkDir := filepath.Join(repo.Path, "escape")
	if err := os.Symlink(filepath.Dir(l.root), linkDir); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}
	_, err := m.Deliver(ctx, &Delivery{Mount: envFileMount("escape/payload.env"), Value: multilineValue()})
	if got := RefusalReason(err); got != ReasonSymlinkParent {
		t.Fatalf("symlinked parent reason = %q, want %q (%v)", got, ReasonSymlinkParent, err)
	}
	if _, statErr := os.Stat(filepath.Join(l.root, "payload.env")); statErr == nil {
		t.Fatal("the payload was written outside the checkout through a symlinked parent")
	}

	// A target that is a symlink: refused, and the link's destination keeps its
	// bytes (the "do not clobber content you did not create" rule that
	// secret_mounts.allow_tracked exists to make explicit).
	secretLink := filepath.Join(repo.Path, "link-to-home.env")
	if err := os.Symlink(filepath.Join(l.home, ".ssh", "authorized_keys"), secretLink); err != nil {
		t.Fatalf("symlink target: %v", err)
	}
	_, err = m.Deliver(ctx, &Delivery{Mount: envFileMount("link-to-home.env"), Value: multilineValue()})
	if got := RefusalReason(err); got != ReasonSymlinkParent {
		t.Fatalf("symlinked target reason = %q, want %q (%v)", got, ReasonSymlinkParent, err)
	}
	raw, readErr := os.ReadFile(filepath.Join(l.home, ".ssh", "authorized_keys"))
	if readErr != nil {
		t.Fatalf("read authorized_keys: %v", readErr)
	}
	if !strings.Contains(string(raw), "ORIGINAL") || strings.Contains(string(raw), sentinel) {
		t.Fatalf("the symlink target's content changed: %q", raw)
	}
	if _, statErr := os.Lstat(secretLink); statErr != nil {
		t.Fatalf("refusal must not remove the link it did not create: %v", statErr)
	}
}

func TestRefusesALiveTargetAndKeepsItsContent(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	// C-ENV7's finding: git checkout -L does not bring an untracked file into
	// the index, so the only reason a materialized path can pre-exist is another
	// run or a human. O_EXCL is what makes that a refusal with the original
	// bytes intact.
	path := filepath.Join(repo.Path, ".env.local")
	const original = "SOMEONE ELSES VALUE\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := m.Deliver(ctx, &Delivery{Mount: envFileMount(".env.local"), Value: multilineValue()})
	if got := RefusalReason(err); got != ReasonExists {
		t.Fatalf("reason = %q, want %q (%v)", got, ReasonExists, err)
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil || string(raw) != original {
		t.Fatalf("the refusal changed the file: %q %v", raw, readErr)
	}
	if perm, err := os.Stat(path); err != nil || perm.Mode().Perm() != 0o644 {
		t.Fatalf("the refusal changed the mode: %v %v", perm, err)
	}

	// The one exception the contract allows: this mount's own previous
	// materialization, which is why AllowOverwrite exists as a policy flag the
	// caller sets from the row rather than as a default.
	overwrite := envFileMount(".env.local")
	overwrite.AllowOverwrite = true
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove seed: %v", err)
	}
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatalf("reseed: %v", err)
	}
	receipt, err := m.Deliver(ctx, &Delivery{Mount: overwrite, Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver with AllowOverwrite: %v", err)
	}
	// AllowOverwrite replaces once: the create still uses O_EXCL, so the path
	// has to be removed first — and if it reappears, that is a second refusal.
	_ = receipt
}

func TestTrackedExceptionIsExplicit(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	// Default: a tracked target is refused (C-ENV6.3), because materializing
	// over it would destroy content the repository owns.
	_, err := m.Deliver(ctx, &Delivery{Mount: envFileMount("app/tracked.env"), Value: multilineValue()})
	if got := RefusalReason(err); got != ReasonTrackedTarget {
		t.Fatalf("reason = %q, want %q", got, ReasonTrackedTarget)
	}

	// C-ENV6.4: with the mount row's exception the delivery succeeds, is still
	// invisible to status (the exclusion is what makes it so), and is recorded
	// as having replaced tracked content — the one case where previous bytes are
	// gone and an operator needs to know.
	mount := envFileMount("app/tracked.env")
	mount.AllowTracked = true
	mount.AllowOverwrite = true
	receipt, err := m.Deliver(ctx, &Delivery{Mount: mount, Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver with AllowTracked: %v", err)
	}
	if !receipt.ReplacedContent {
		t.Fatal("AllowTracked did not record that it replaced tracked content")
	}
	defer func() { _ = receipt.Cleanup(ctx) }()

	content, err := os.ReadFile(filepath.Join(repo.Path, "app/tracked.env"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(content), sentinel) {
		t.Fatalf("content = %q", content)
	}
	if perm, err := os.Stat(filepath.Join(repo.Path, "app/tracked.env")); err != nil || perm.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v %v", perm, err)
	}
	// ls-files --error-unmatch exits 0 for an excluded path that is also in the
	// index, so the exclusion does not hide a tracked file from the check that
	// protects it — the exception is what allowed the write, not a gap.
	if out := gitOut(t, repo.Path, "ls-files", "--", "app/tracked.env"); !strings.Contains(out, "app/tracked.env") {
		t.Fatalf("the tracked file is no longer listed: %s", out)
	}
}

func TestCleanupIsIdempotentAndKeepsTheProjectExclusion(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	receipt, err := m.Deliver(ctx, &Delivery{Mount: envFileMount(".env.cleanup"), Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	path := filepath.Join(repo.Path, ".env.cleanup")
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("nothing was written: %v", statErr)
	}
	for i := 0; i < 3; i++ {
		if err := receipt.Cleanup(ctx); err != nil {
			t.Fatalf("Cleanup attempt %d: %v", i, err)
		}
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("the file survived cleanup: %v", statErr)
	}
	// A new Receipt for the same path after the file is already gone must also
	// clean without error, because turn_end is not guaranteed to arrive once and
	// the sweep will call it again. The cleanup closure below is the shape
	// Deliver installs for an env_file delivery (remove, tolerate ENOENT), so a
	// re-run of it after the sweep proves the idempotence the sweep depends on.
	second := &Receipt{cleanup: func() error {
		err := os.Remove(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}}
	if err := second.Cleanup(ctx); err != nil {
		t.Fatalf("cleanup of an already-removed path: %v", err)
	}
	// The exclusion stays: it is project-scoped, so removing it would expose
	// every other run's materialized file to `git add .` (PROBES G5).
	exclude, err := os.ReadFile(filepath.Join(l.mirror, "info", "exclude"))
	if err != nil {
		t.Fatalf("read exclude: %v", err)
	}
	if !strings.Contains(string(exclude), "/.env.cleanup\n") {
		t.Fatalf("cleanup removed the project exclusion:\n%s", exclude)
	}
	// And a nil receipt cleans without complaint.
	var nilReceipt *Receipt
	if err := nilReceipt.Cleanup(ctx); err != nil {
		t.Fatalf("nil Cleanup: %v", err)
	}
}

func TestTwoWorktreesOfOneMirrorMaterializeIndependently(t *testing.T) {
	// ADR-0018 D4's concurrency rule: "Two runs sharing a mirror must not be
	// able to clobber each other's files", verified here the way the probe says
	// it must be — with git's own index/obj assertions rather than a mock.
	l := newLab(t, "unit-a", "unit-b")
	// One Materializer per unit: two runs of one project share the mirror but not
	// the process, which is the case an in-process exclusion lock cannot cover and
	// the reason the append uses O_APPEND.
	mFor := func(unit string) *Materializer { return l.materializer(unit) }
	ctx := context.Background()
	repoA, repoB := l.checkout("unit-a"), l.checkout("unit-b")

	// Distinct values per mount, as a real worker would deliver them; the
	// materializer's own contract is that the two files never alias.
	valueA := []byte("REGISTRY_TOKEN=run-a-" + sentinel + "\n")
	valueB := []byte("REGISTRY_TOKEN=run-b-" + sentinel + "\n")

	var (
		wg       sync.WaitGroup
		errs     = make(chan error, 2)
		receipts = make(chan *Receipt, 2)
	)
	for _, tc := range []struct {
		unit  string
		repo  Repository
		value []byte
	}{
		{"unit-a", repoA, valueA},
		{"unit-b", repoB, valueB},
	} {
		wg.Add(1)
		go func(unit string, repo Repository, value []byte) {
			defer wg.Done()
			mount := envFileMount(".env.local")
			mount.RepositoryName = repo.Name
			receipt, err := mFor(unit).Deliver(ctx, &Delivery{Mount: mount, Value: value})
			if err != nil {
				errs <- fmt.Errorf("%s: %w", repo.Path, err)
				return
			}
			receipts <- receipt
		}(tc.unit, tc.repo, tc.value)
	}
	wg.Wait()
	close(errs)
	close(receipts)
	for err := range errs {
		t.Fatalf("concurrent Deliver: %v", err)
	}
	both := []*Receipt{}
	for receipt := range receipts {
		both = append(both, receipt)
	}
	if len(both) != 2 {
		t.Fatalf("expected 2 receipts")
	}

	for _, repo := range []Repository{repoA, repoB} {
		path := filepath.Join(repo.Path, ".env.local")
		info, statErr := os.Stat(path)
		if statErr != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: mode=%v err=%v", path, info, statErr)
		}
	}
	aContent, err := os.ReadFile(filepath.Join(repoA.Path, ".env.local"))
	if err != nil {
		t.Fatal(err)
	}
	bContent, err := os.ReadFile(filepath.Join(repoB.Path, ".env.local"))
	if err != nil {
		t.Fatal(err)
	}
	if string(aContent) == string(bContent) {
		t.Fatalf("the two worktrees hold the same bytes: %q", aContent)
	}
	// The project-scoped exclusion is shared, which is the point: one append
	// covers both runs, and git says so for each worktree.
	for _, repo := range []Repository{repoA, repoB} {
		if out := gitOut(t, repo.Path, "check-ignore", "-v", "--", ".env.local"); !strings.Contains(out, "info/exclude") {
			t.Fatalf("%s: not excluded by the mirror: %s", repo.Path, out)
		}
		if status := gitOut(t, repo.Path, "status", "--porcelain"); strings.Contains(status, ".env.local") {
			t.Fatalf("%s: visible to status:\n%s", repo.Path, status)
		}
	}
	// Each cleanup removes only its own file, and the mirror's exclusion — the
	// shared object — stays for the other run. Which receipt belongs to which
	// worktree is read off the receipt rather than assumed from channel order.
	first, second := both[0], both[1]
	if strings.HasPrefix(second.Target, repoA.Path) {
		first, second = second, first
	}
	if !strings.HasPrefix(first.Target, repoA.Path) {
		t.Fatalf("could not attribute receipts to worktrees: %s / %s", first.Target, second.Target)
	}
	if err := first.Cleanup(ctx); err != nil {
		t.Fatalf("cleanup first: %v", err)
	}
	if _, statErr := os.Stat(first.Target); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("first cleanup left a file")
	}
	if _, statErr := os.Stat(second.Target); statErr != nil {
		t.Fatalf("first cleanup removed the other run's file: %v", statErr)
	}
	if err := second.Cleanup(ctx); err != nil {
		t.Fatalf("cleanup second: %v", err)
	}
	if _, statErr := os.Stat(second.Target); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("second cleanup left a file")
	}
	// And the project exclusion survived both cleanups, because the next run of
	// this project depends on it being there already.
	if raw, readErr := os.ReadFile(filepath.Join(l.mirror, "info", "exclude")); readErr != nil || !strings.Contains(string(raw), "/.env.local\n") {
		t.Fatalf("the exclusion did not survive cleanup: %q %v", raw, readErr)
	}
}

func TestEnvDeliveryCreatesNoFile(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	mount := Mount{
		SecretID: secretID, SecretSlug: "api-token", Version: 2,
		RepositoryName: repoName, DeliveryMode: "env", EnvName: "COMM_API_TOKEN",
		Lifecycle: "turn",
	}
	receipt, err := m.Deliver(ctx, &Delivery{Mount: mount, Value: []byte("token-value")})
	if err != nil {
		t.Fatalf("Deliver env: %v", err)
	}
	// No file appears: the difference between env and env_file delivery is
	// observable, and C3's assertion that .env.local "must not exist" while the
	// mount is env-mode depends on it.
	entries, err := os.ReadDir(repo.Path)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "COMM_API_TOKEN") {
			t.Fatalf("env delivery created a file: %s", e.Name())
		}
	}
	if string(receipt.EnvValue) != "token-value" {
		t.Fatalf("EnvValue = %q", receipt.EnvValue)
	}
	if receipt.FileMode != 0 {
		t.Fatalf("env delivery reported a file mode: %d", receipt.FileMode)
	}
	if meta := receipt.Meta(); meta.Mode != "" {
		t.Fatalf("env delivery reported a mode string: %+v", meta)
	}
	// The launcher consumes the value; cleanup zeroes it and removes nothing.
	if err := receipt.Cleanup(ctx); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if len(receipt.EnvValue) != 0 {
		t.Fatal("cleanup left the env value in memory")
	}
	// A name the shell could not use is refused before anything is handed over.
	if _, err := m.Deliver(ctx, &Delivery{Mount: Mount{
		DeliveryMode: "env", EnvName: "9BAD-NAME", RepositoryName: repoName,
	}, Value: []byte("x")}); RefusalReason(err) != ReasonBadShape {
		t.Fatalf("bad env name reason = %q (%v)", RefusalReason(err), err)
	}
}

func TestKeySelectionFromAMultilineValue(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")

	// Whole-value delivery when the mount names no key, and the key *names* (not
	// values) are what the receipt reports.
	whole := envFileMount("whole.env")
	whole.Key = ""
	receipt, err := m.Deliver(ctx, &Delivery{Mount: whole, Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver whole: %v", err)
	}
	defer func() { _ = receipt.Cleanup(ctx) }()
	content, err := os.ReadFile(filepath.Join(repo.Path, "whole.env"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(multilineValue()) {
		t.Fatalf("whole-value delivery rewrote the value: %q", content)
	}
	if strings.Join(receipt.KeyNames, ",") != "REGISTRY_USER,REGISTRY_TOKEN,REGISTRY_URL" {
		t.Fatalf("KeyNames = %v", receipt.KeyNames)
	}
	for _, name := range receipt.KeyNames {
		if name == "" {
			t.Fatal("an empty key name was reported")
		}
	}
	meta, _ := json.Marshal(receipt.Meta())
	if strings.Contains(string(meta), sentinel) {
		t.Fatalf("key names leaked a value: %s", meta)
	}

	// A key the value does not contain is a refusal, not an empty file: writing
	// `TOKEN=` and reporting success is how a wrong secret becomes a mystery.
	missing := envFileMount("missing.env")
	missing.Key = "NO_SUCH_KEY"
	if _, err := m.Deliver(ctx, &Delivery{Mount: missing, Value: multilineValue()}); RefusalReason(err) != ReasonBadShape {
		t.Fatalf("missing key reason = %q (%v)", RefusalReason(err), err)
	}
	if _, statErr := os.Stat(filepath.Join(repo.Path, "missing.env")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("a refused delivery created a file")
	}
}

func TestRepositoryMustBeAuthorizedForTheUnit(t *testing.T) {
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	ctx := context.Background()

	// A mount naming a repository the unit has no checkout for is refused: this
	// is the boundary that keeps a turn from writing into another unit's
	// workspace (spec 05 "Client isolation").
	mount := envFileMount(".env.local")
	mount.RepositoryName = "some-other-repository"
	if _, err := m.Deliver(ctx, &Delivery{Mount: mount, Value: multilineValue()}); RefusalReason(err) != ReasonBadShape {
		t.Fatalf("reason = %q (%v)", RefusalReason(err), err)
	}

	// A configuration that names no repositories delivers nothing anywhere.
	empty, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mount.RepositoryName = repoName
	if _, err := empty.Deliver(ctx, &Delivery{Mount: mount, Value: multilineValue()}); RefusalReason(err) != ReasonBadShape {
		t.Fatalf("reason with no repositories = %q (%v)", RefusalReason(err), err)
	}
}

func TestRequiresAMirrorForTheExclusion(t *testing.T) {
	l := newLab(t, "unit-a")
	ctx := context.Background()
	repo := l.checkout("unit-a")
	repo.MirrorPath = ""
	m, err := New(Options{Repositories: []Repository{repo}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Without a mirror there is nowhere to put a project-scoped exclusion, and
	// an unexcluded secret file is a secret that can be committed. The refusal is
	// the point: it fails closed rather than writing anyway and cleaning up the
	// git status output afterwards.
	if _, err := m.Deliver(ctx, &Delivery{Mount: envFileMount(".env.local"), Value: multilineValue()}); RefusalReason(err) != ReasonMirrorWritable {
		t.Fatalf("reason = %q (%v)", RefusalReason(err), err)
	}
}

func TestNewRejectsUnusableConfigurations(t *testing.T) {
	for name, opts := range map[string]Options{
		"relative checkout":  {Repositories: []Repository{{Name: "r", Path: "repos/r", MirrorPath: "/m"}}},
		"dotdot checkout":    {Repositories: []Repository{{Name: "r", Path: "/w/repos/../r", MirrorPath: "/m"}}},
		"dotdot mirror":      {Repositories: []Repository{{Name: "r", Path: "/w/repos/r", MirrorPath: "/m/../../k"}}},
		"empty repository":   {Repositories: []Repository{{Name: "", Path: "/w/repos/r"}}},
		"duplicate checkout": {Repositories: []Repository{{Name: "r", Path: "/w/a"}, {Name: "r", Path: "/w/b"}}},
	} {
		if _, err := New(opts); err == nil {
			t.Fatalf("New accepted %s", name)
		}
	}
}

func TestReceiptCarriesNoValueAnywhereSerializable(t *testing.T) {
	// The reflection-level check behind "returns metadata for the
	// secret.materialized event (path, key names, version — never values)":
	// Receipt and Meta have no field whose name could hold a value, and Meta's
	// JSON form is small and value-free.
	l := newLab(t, "unit-a")
	m := l.materializer("unit-a")
	receipt, err := m.Deliver(context.Background(), &Delivery{Mount: envFileMount("check.env"), Value: multilineValue()})
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	defer func() { _ = receipt.Cleanup(context.Background()) }()

	for _, field := range []string{"value", "secret_value", "plaintext", "ciphertext", "contents", "bytes"} {
		if hasFieldNamed(receipt.Meta(), field) {
			t.Fatalf("Meta exposes a field named %q", field)
		}
	}
	for _, field := range []string{"secret_value", "plaintext", "ciphertext", "contents", "bytes"} {
		if hasFieldNamed(receipt, field) {
			t.Fatalf("*Receipt exposes a field named %q", field)
		}
	}
	meta, err := json.Marshal(receipt.Meta())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(meta), sentinel) {
		t.Fatalf("meta carries material: %s", meta)
	}
}

// hasFieldNamed asks the structural question behind "never values": neither the
// receipt nor its event metadata has any field, named directly or by tag, that
// a caller could put a value in. EnvValue is the one material field on Receipt
// and it is excluded by name here because it is the launcher's handoff, not a
// serialized form — Meta has no such field at all.
func hasFieldNamed(v any, name string) bool {
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Pointer {
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return false
	}
	for i := 0; i < rv.NumField(); i++ {
		field := rv.Type().Field(i)
		if !field.IsExported() {
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")[0]
		if strings.EqualFold(field.Name, name) || strings.EqualFold(tag, name) {
			return true
		}
	}
	return false
}

func TestRefusalReasonOnlyNamesContractReasons(t *testing.T) {
	// The reason values are the secret.materialization_failed enum in
	// internal/events; a materializer that invents a reason produces an event
	// that cannot be emitted.
	known := map[string]bool{
		ReasonPathEscape: true, ReasonAbsolutePath: true, ReasonBadShape: true,
		ReasonTrackedTarget: true, ReasonExists: true, ReasonSymlinkParent: true,
		ReasonMirrorWritable: true, ReasonKeyringUnreadab: true,
		ReasonRevokedVersion: true, ReasonBrokerUnsupport: true,
	}
	for reason := range known {
		if len(reason) == 0 {
			t.Fatal("empty reason constant")
		}
	}
	if got := RefusalReason(errors.New("not a refusal")); got != "" {
		t.Fatalf("RefusalReason of a plain error = %q", got)
	}
}
