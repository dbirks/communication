package worker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Audit F6: file:// clones are refused by the worker itself, not only by the
// API replica that wrote the row — defence in depth for repositories that
// predate the setting or were migrated in by hand.

// fileGitConv is a fixed conversation id (uuidDir's required shape).
const fileGitConv = "11111111-2222-3333-4444-555555555555"

// recordGit returns a RunGit fake plus the argv of every git command it was
// asked to run. A fake that ever lets a file:// clone through makes the
// recorded argv the evidence.
func recordGit() (func(context.Context, string, ...string) ([]byte, error), *[][]string) {
	var calls [][]string
	return func(_ context.Context, _ string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		return nil, nil
	}, &calls
}

func TestWorkspaceMirrorFileGitURLGated(t *testing.T) {
	for _, tt := range []struct {
		name       string
		allow      bool
		gitURL     string
		wantClone  bool
		wantSubstr string // expected in the note when the clone is refused
	}{
		{"file url allowed", true, "file:///srv/fixtures/app.git", true, ""},
		{"file url refused", false, "file:///srv/fixtures/app.git", false,
			"file:// repository URLs are disabled on this worker; set COMMUNICATION_ALLOW_FILE_GIT_URLS=true for local development"},
		{"https unaffected", false, "https://github.com/example/app.git", true, ""},
		{"ssh unaffected", false, "ssh://git@github.com/example/app.git", true, ""},
		{"scp-style unaffected", false, "git@github.com:example/app.git", true, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			run, calls := recordGit()
			w := &Workspace{Root: root, RunGit: run, AllowFileGitURLs: tt.allow}
			_, notes, err := w.Prepare(context.Background(), fileGitConv, []Repo{
				{ID: "r1", Name: "app", GitURL: tt.gitURL, DefaultBranch: "main"},
			})
			if err != nil {
				t.Fatalf("Prepare: %v", err)
			}
			cloned := len(*calls) == 1 && (*calls)[0][0] == "-c"
			if cloned != tt.wantClone {
				t.Fatalf("git calls = %v, want cloned=%v", *calls, tt.wantClone)
			}
			if tt.wantSubstr == "" {
				if len(notes) != 0 {
					t.Errorf("notes = %q, want none", notes)
				}
				return
			}
			if len(notes) != 1 || !strings.Contains(notes[0], tt.wantSubstr) {
				t.Fatalf("notes = %q, want one naming the disabled setting", notes)
			}
			if !strings.Contains(notes[0], "clone of app from file") {
				t.Errorf("note %q does not read like the other clone-failure notes", notes[0])
			}
		})
	}
}

// A file:// repository mirrored while the flag was on must not be silently
// re-used by a worker that turned it off: the refusal runs before the
// already-mirrored shortcut, and the note names the missing switch.
func TestWorkspaceFileGitURLRefusedEvenWhenMirrored(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, fileGitConv, "repos", "app", ".git")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run, calls := recordGit()
	w := &Workspace{Root: root, RunGit: run}
	_, notes, err := w.Prepare(context.Background(), fileGitConv, []Repo{
		{ID: "r1", Name: "app", GitURL: "file:///srv/fixtures/app.git", DefaultBranch: "main"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(*calls) != 0 {
		t.Errorf("git calls = %v, want none", *calls)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "disabled on this worker") {
		t.Errorf("notes = %q, want the refusal note despite the existing mirror", notes)
	}
}
