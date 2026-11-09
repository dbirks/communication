package api

// The reader's half of ADR-0078 § Patch artifacts: a run's `patch` artifacts are
// split into hunks that keep the file their own header named, and only the
// caller's own artifacts are ever read. The generator side (what a cited hunk
// becomes) is internal/assistant/catchup_diff_test.go; the bytes themselves are
// the worker's promise, proven in internal/worker/unit_patch_test.go.

import (
	"context"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/assistant"
)

const testPatchDoc = "diff --git a/hello.py b/hello.py\nindex 1..2 100644\n" +
	"--- a/hello.py\n+++ b/hello.py\n@@ -1 +1,2 @@\n print('hi')\n+print('world')\n" +
	"diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+new\n"

func TestCatchUpPatchHunksKeepTheirFile(t *testing.T) {
	hunks := catchUpPatchHunks("patch-app", testPatchDoc)
	if len(hunks) != 2 {
		t.Fatalf("hunks = %d, want the two files' sections: %+v", len(hunks), hunks)
	}
	if hunks[0].File != "hello.py" || !strings.Contains(hunks[0].Lines, "+print('world')") {
		t.Fatalf("hunk 0 = %+v, want hello.py's hunk quoted verbatim", hunks[0])
	}
	if !strings.HasPrefix(hunks[0].Lines, "@@ ") {
		t.Fatalf("hunk 0 lost its @@ header: %q", hunks[0].Lines)
	}
	if hunks[1].File != "notes.md" || !strings.Contains(hunks[1].Lines, "+new") {
		t.Fatalf("hunk 1 = %+v", hunks[1])
	}
	if hunks[0].Bytes != len(hunks[0].Lines) {
		t.Fatalf("Bytes = %d, want the hunk's own length %d", hunks[0].Bytes, len(hunks[0].Lines))
	}
}

// A multi-repository capture marks its sections; the file each hunk names has to
// say which repository it came from, or two `hello.py` hunks are one lie.
func TestCatchUpPatchHunksQualifyAMultiRepositoryDocument(t *testing.T) {
	doc := "# repository web\n" + testPatchDoc + "# repository api\n" +
		"diff --git a/hello.py b/hello.py\nindex 3..4 100644\n--- a/hello.py\n+++ b/hello.py\n@@ -1 +1 @@\n+print('api')\n"
	hunks := catchUpPatchHunks("patch-2-repositories", doc)
	files := make([]string, 0, len(hunks))
	for _, h := range hunks {
		files = append(files, h.File)
	}
	want := []string{"web/hello.py", "web/notes.md", "api/hello.py"}
	if !slices.Equal(files, want) {
		t.Fatalf("files = %v, want %v", files, want)
	}
}

func TestCatchUpPatchHunksAreBounded(t *testing.T) {
	var doc strings.Builder
	for i := 0; i < 4*catchUpGenMaxPatchHunks; i++ {
		doc.WriteString(testPatchDoc)
	}
	if got := len(catchUpPatchHunks("patch-app", doc.String())); got != catchUpGenMaxPatchHunks {
		t.Fatalf("hunks = %d, want the reader's bound of %d", got, catchUpGenMaxPatchHunks)
	}
}

// --- the artifact read ---------------------------------------------------

type patchStoreStub struct {
	views    []ArtifactView
	calledWI []string // "project|conversation" per call, to watch the scoping
}

func (s *patchStoreStub) ListArtifacts(_ context.Context, _ Caller, projectID, conversationID string) ([]ArtifactView, error) {
	s.calledWI = append(s.calledWI, projectID+"|"+conversationID)
	return s.views, nil
}

type patchBytesStub struct{ bodies map[string]string }

func (s patchBytesStub) Open(_ context.Context, ref artifacts.Ref) (io.ReadCloser, int64, error) {
	body, ok := s.bodies[ref.ID]
	if !ok {
		return nil, 0, io.EOF
	}
	rc := io.NopCloser(strings.NewReader(body))
	return rc, int64(len(body)), nil
}

func patchArtView(id, name, kind, state string, runID, convID *string, size int64) ArtifactView {
	return ArtifactView{
		ID: id, ProjectID: "prj-1", Name: name, Kind: kind, State: state,
		RunID: runID, ConversationID: convID, SizeBytes: size,
		MediaType: "text/x-diff", StorageBackend: "local", StorageKey: "k/" + id,
	}
}

func strptr(s string) *string { return &s }

func TestCatchUpPatchSourceReadsOnlyTheRunsOwnReadyPatches(t *testing.T) {
	run := "run-1"
	other := "run-2"
	conv := "conv-1"
	store := &patchStoreStub{views: []ArtifactView{
		// The run's own patch: read.
		patchArtView("a1", "patch-app", "patch", "ready", strptr(run), nil, 120),
		// Another run's patch: not this story's evidence.
		patchArtView("a2", "patch-app", "patch", "ready", strptr(other), nil, 120),
		// A capture fenced on the run's thread instead of the run row: read,
		// because the caller may open it and it names this run's conversation.
		patchArtView("a3", "patch-thread", "patch", "ready", nil, strptr(conv), 120),
		// Not a patch, and not ready: never opened at all.
		patchArtView("a4", "report.md", "markdown", "ready", strptr(run), nil, 120),
		patchArtView("a5", "patch-half", "patch", "uploading", strptr(run), nil, 120),
		// Over the read bound: refused rather than truncated into a lie.
		patchArtView("a6", "patch-huge", "patch", "ready", strptr(run), nil, 1<<20),
	}}
	src := NewCatchUpPatchSource(store, patchBytesStub{bodies: map[string]string{
		"a1": testPatchDoc, "a2": testPatchDoc, "a3": testPatchDoc,
		"a4": testPatchDoc, "a5": testPatchDoc, "a6": testPatchDoc,
	}})
	patches, err := src.RunPatches(context.Background(), assistant.Caller{UserID: "u1"},
		"prj-1", run, conv)
	if err != nil {
		t.Fatalf("RunPatches: %v", err)
	}
	if len(patches) != 2 {
		t.Fatalf("patches = %d (%+v), want the run's ready patch and its thread's", len(patches), patches)
	}
	for _, p := range patches {
		if !strings.Contains(p.Content, "+print('world')") {
			t.Fatalf("artifact %q arrived without its hunk: %q", p.Name, p.Content)
		}
	}
	if len(store.calledWI) != 1 || store.calledWI[0] != "prj-1|conv-1" {
		t.Fatalf("the read was not the caller's own scoped list: %v", store.calledWI)
	}
	if NewCatchUpPatchSource(nil, patchBytesStub{}) != nil || NewCatchUpPatchSource(store, nil) != nil {
		t.Fatal("a half-wired patch source must be the honest absence, not a nil-method panic")
	}
}

func TestCatchUpRunFactsCarriesTheRunsHunks(t *testing.T) {
	run := "run-1"
	reads := &scriptedRuns{run: RunView{
		RunSummaryView: RunSummaryView{ID: run, Status: "completed", ProjectID: "prj-1"},
	}}
	reader := catchUpReaderFor(reads)
	reader.patches = stubPatchSource{patches: []CatchUpPatch{{Name: "patch-app", Content: testPatchDoc}}}
	facts, err := reader.RunFacts(context.Background(), assistant.Caller{UserID: "u1"}, run)
	if err != nil {
		t.Fatalf("RunFacts: %v", err)
	}
	if len(facts.Diffs) != 2 || facts.Diffs[0].File != "hello.py" {
		t.Fatalf("facts.Diffs = %+v, want the patch split into its two files' hunks", facts.Diffs)
	}
}

type stubPatchSource struct{ patches []CatchUpPatch }

func (s stubPatchSource) RunPatches(context.Context, assistant.Caller, string, string,
	string) ([]CatchUpPatch, error) {
	return s.patches, nil
}

// A patch read that fails costs the tour its hunks and nothing else: the block
// still carries the run's own nodes and thread, exactly as it did before any run
// filed a patch.
func TestCatchUpRunFactsSurvivesAMissingPatchRead(t *testing.T) {
	reads := &scriptedRuns{run: RunView{
		RunSummaryView: RunSummaryView{ID: "run-9", Status: "completed", ProjectID: "prj-1"},
	}}
	reader := catchUpReaderFor(reads)
	reader.patches = failingPatchSource{}
	facts, err := reader.RunFacts(context.Background(), assistant.Caller{UserID: "u1"}, "run-9")
	if err != nil {
		t.Fatalf("a failed patch read must not lose the generation: %v", err)
	}
	if len(facts.Diffs) != 0 {
		t.Fatalf("facts.Diffs = %+v, want none", facts.Diffs)
	}
	if facts.Status != "completed" {
		t.Fatalf("facts lost the run's own facts: %+v", facts)
	}
}

type failingPatchSource struct{}

func (failingPatchSource) RunPatches(context.Context, assistant.Caller, string, string,
	string) ([]CatchUpPatch, error) {
	return nil, context.DeadlineExceeded
}
