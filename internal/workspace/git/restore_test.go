package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// restoreRepo seeds a checkout with `boundary` as its first commit and one
// commit on top, and returns the boundary's object id plus the runner that
// owns every git call the restore itself makes.
func restoreRepo(t *testing.T) (m *Manager, checkout, boundary string) {
	t.Helper()
	requireGit(t)
	d := t.TempDir()
	checkout = filepath.Join(d, "work")
	if err := os.MkdirAll(checkout, 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(d, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	r := &Runner{Home: home, Identity: GitIdentity{Name: "restore-test", Email: "restore@communication.invalid"}}
	m = &Manager{Git: r}
	run(t, checkout, "init", "-q", "-b", "main", checkout)
	writeFile(t, filepath.Join(checkout, "app.txt"), "line one\n")
	writeFile(t, filepath.Join(checkout, "keep.txt"), "keep\n")
	run(t, checkout, "add", "-A")
	run(t, checkout, "commit", "-qm", "boundary")
	boundary = run(t, checkout, "rev-parse", "HEAD")
	// The interrupted attempt: a commit the boundary does not have, an edited
	// tracked file, and an untracked file.
	writeFile(t, filepath.Join(checkout, "app.txt"), "line one edited\n")
	writeFile(t, filepath.Join(checkout, "notes.txt"), "scratch from the dead attempt\n")
	run(t, checkout, "add", "-A")
	run(t, checkout, "commit", "-qm", "work the retry must not inherit")
	writeFile(t, filepath.Join(checkout, "app.txt"), "edited again, uncommitted\n")
	writeFile(t, filepath.Join(checkout, "junk.log"), "untracked\n")
	return m, checkout, boundary
}

// TestRestoreToBoundaryResetsAndDiscards is ADR-0023 § 6's destructive arm
// measured on a real repository: HEAD returns to the boundary, the dirty
// paths are gone from disk, and the report names exactly them.
func TestRestoreToBoundaryResetsAndDiscards(t *testing.T) {
	m, checkout, boundary := restoreRepo(t)
	ctx := context.Background()

	rep, err := m.RestoreToBoundary(ctx, RestoreRequest{Checkout: checkout, HeadCommit: boundary})
	if err != nil {
		t.Fatalf("RestoreToBoundary: %v", err)
	}
	if rep.HeadAfter != boundary {
		t.Errorf("HeadAfter = %s, want boundary %s", rep.HeadAfter, boundary)
	}
	if rep.HeadBefore == boundary {
		t.Errorf("HeadBefore = %s, want the interrupted attempt's commit", rep.HeadBefore)
	}
	want := []string{"app.txt", "junk.log", "notes.txt"}
	if !slices.Equal(rep.DiscardedPaths, want) {
		t.Errorf("DiscardedPaths = %v, want %v", rep.DiscardedPaths, want)
	}
	// The tree says the same thing: app.txt is back to the boundary's bytes
	// and the untracked files are gone.
	if got := mustRead(t, filepath.Join(checkout, "app.txt")); got != "line one\n" {
		t.Errorf("app.txt after restore = %q, want the boundary's bytes", got)
	}
	for _, gone := range []string{"notes.txt", "junk.log"} {
		if _, err := os.Stat(filepath.Join(checkout, gone)); !os.IsNotExist(err) {
			t.Errorf("%s survived the restore (stat err %v), want it discarded", gone, err)
		}
	}
	if _, err := os.Stat(filepath.Join(checkout, "keep.txt")); err != nil {
		t.Errorf("keep.txt: committed content must survive the clean: %v", err)
	}
	// And the tree is provably clean against the boundary afterwards.
	if out := runOK(t, checkout, "status", "--porcelain"); out != "" {
		t.Errorf("git status after restore = %q, want clean", out)
	}
}

// TestRestoreToBoundaryIdempotent proves the retry of a restore does not
// invent a second loss: with nothing dirty and HEAD already at the boundary,
// the reset is a no-op that reports no discarded paths.
func TestRestoreToBoundaryIdempotent(t *testing.T) {
	m, checkout, boundary := restoreRepo(t)
	ctx := context.Background()
	if _, err := m.RestoreToBoundary(ctx, RestoreRequest{Checkout: checkout, HeadCommit: boundary}); err != nil {
		t.Fatalf("first restore: %v", err)
	}
	rep, err := m.RestoreToBoundary(ctx, RestoreRequest{Checkout: checkout, HeadCommit: boundary})
	if err != nil {
		t.Fatalf("second restore: %v", err)
	}
	if len(rep.DiscardedPaths) != 0 {
		t.Errorf("second restore DiscardedPaths = %v, want none", rep.DiscardedPaths)
	}
	if rep.HeadAfter != boundary {
		t.Errorf("HeadAfter = %s, want %s", rep.HeadAfter, boundary)
	}
}

// TestRestoreToBoundarySparesExclusions is ADR-0017 D6's exclusion set under a
// destructive command: a declared path is neither reported as discarded nor
// removed from disk, because `clean -fd` without -x leaves ignored files.
func TestRestoreToBoundarySparesExclusions(t *testing.T) {
	m, checkout, boundary := restoreRepo(t)
	ctx := context.Background()
	// info/exclude is the project-scoped exclusion file ADR-0017 D6 puts in the
	// mirror; in a plain init'd repo it is the checkout's own, and git honors
	// it for both status and clean without any config.
	writeFile(t, filepath.Join(checkout, ".git", "info", "exclude"), ".env\n")
	writeFile(t, filepath.Join(checkout, ".env"), "SECRET=materialized\n")

	rep, err := m.RestoreToBoundary(ctx, RestoreRequest{
		Checkout: checkout, HeadCommit: boundary, Excluded: []string{".env"},
	})
	if err != nil {
		t.Fatalf("RestoreToBoundary: %v", err)
	}
	if slices.Contains(rep.DiscardedPaths, ".env") {
		t.Errorf("DiscardedPaths = %v, want the declared exclusion filtered out", rep.DiscardedPaths)
	}
	if _, err := os.Stat(filepath.Join(checkout, ".env")); err != nil {
		t.Errorf("declared exclusion .env was destroyed: %v", err)
	}
}

// TestRestoreToBoundaryRefusesWithoutTouching covers the refusals that must
// leave the tree byte-identical: a boundary that is not a hex commit, one this
// checkout cannot resolve, and a checkout holding a nested repository (whose
// semantics ADR-0023 § 6 never defines).
func TestRestoreToBoundaryRefusesWithoutTouching(t *testing.T) {
	for _, tc := range []struct {
		name   string
		commit string
		nested bool
	}{
		{name: "ref name is not a commit", commit: "main"},
		{name: "empty commit", commit: ""},
		{name: "hex but unreachable", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"},
		{name: "nested repository", commit: "boundary", nested: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, checkout, boundary := restoreRepo(t)
			want := tc.commit
			if want == "boundary" {
				want = boundary
			}
			if tc.nested {
				vendor := filepath.Join(checkout, "vendor")
				if err := os.MkdirAll(vendor, 0o755); err != nil {
					t.Fatal(err)
				}
				run(t, vendor, "init", "-q", "-b", "main", vendor)
				writeFile(t, filepath.Join(vendor, "own.txt"), "not ours\n")
			}
			before := runOK(t, checkout, "rev-parse", "HEAD")
			statusBefore := runOK(t, checkout, "status", "--porcelain", "--untracked-files=all")

			_, err := m.RestoreToBoundary(context.Background(), RestoreRequest{
				Checkout: checkout, HeadCommit: want,
			})
			if !errors.Is(err, ErrRestoreRefused) {
				t.Fatalf("error = %v, want ErrRestoreRefused", err)
			}
			if got := runOK(t, checkout, "rev-parse", "HEAD"); got != before {
				t.Errorf("refusal moved HEAD %s -> %s: %v", before, got, err)
			}
			if got := runOK(t, checkout, "status", "--porcelain", "--untracked-files=all"); got != statusBefore {
				t.Errorf("refusal changed the tree:\nbefore %q\nafter  %q\nerr %v", statusBefore, got, err)
			}
			if !strings.Contains(err.Error(), "nothing was reset") && !tc.nested {
				t.Errorf("refusal detail = %q, want it to say nothing was reset", err.Error())
			}
		})
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
