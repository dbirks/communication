package worker

// The node-boundary patch artifact an agent.acp attempt files (ADR-0078
// § Patch artifacts): the attempt's reviewable diff, bounded and scanned by
// the SAME builder the M3 unit capture uses, published through the
// attempt-fenced artifact seams the attempt's other artifacts already ride.
//
// These run the REAL git binary over a real checkout (the thing under test is
// what `git diff` says about the attempt's tree against the commit it started
// from) and a REAL local artifact byte backend; only the fenced row writer is
// faked — with the exact seam postgres.AttemptArtifacts implements, the fake
// attempt claim standing in for the § 4 step 6 machinery the rest of the
// executor would need to reach this line at all.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/artifacts"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// apatchRows is the worker.AttemptArtifactWriter seam: every input that
// reached the fenced writer, in order.
type apatchRows struct {
	mu   sync.Mutex
	in   []AttemptArtifactInput
	err  error
	seen int
}

var _ AttemptArtifactWriter = (*apatchRows)(nil)

func (r *apatchRows) PublishAttemptArtifact(_ context.Context, in AttemptArtifactInput) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen++
	if r.err != nil {
		return "", r.err
	}
	r.in = append(r.in, in)
	return "art-patch-1", nil
}

func (r *apatchRows) all() []AttemptArtifactInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]AttemptArtifactInput(nil), r.in...)
}

// apatchWorkspaces is the § 4 step 3 resolver: one run workspace row with the
// fixture's checkout hanging off it.
type apatchWorkspaces struct {
	ref RunWorkspaceRef
}

func (w apatchWorkspaces) RunWorkspace(context.Context, string) (RunWorkspaceRef, bool, error) {
	if len(w.ref.Repos) == 0 && w.ref.WorkspaceID == "" {
		return RunWorkspaceRef{}, false, nil
	}
	return w.ref, true, nil
}

func apatchClaim() AttemptClaim {
	return AttemptClaim{
		AttemptID: "aaaaaaaa-0000-4000-8000-000000000001", NodeExecutionID: "aaaaaaaa-0000-4000-8000-000000000002",
		RunID: "aaaaaaaa-0000-4000-8000-000000000003", ProjectID: "aaaaaaaa-0000-4000-8000-000000000004",
		OrganizationID: "aaaaaaaa-0000-4000-8000-000000000005", WorkerID: "worker-1", FencingToken: 11,
		NodeID: "implement", Kind: NodeKindAgentACP,
	}
}

func apatchTurn(t *testing.T, f *patchGitFixture, rows AttemptArtifactWriter, wks RunWorkspaceResolver) *AgentTurn {
	t.Helper()
	local, err := artifacts.NewLocal(artifacts.LocalConfig{Root: filepath.Join(f.root, "artifacts")})
	if err != nil {
		t.Fatalf("local artifact backend: %v", err)
	}
	return &AgentTurn{
		WorkspaceRoot: f.root,
		Checkpoints:   wks,
		PatchBytes:    local,
		PatchRows:     rows,
		PatchGit:      &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}},
		Logger:        slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
}

func apatchReadBack(t *testing.T, a *AgentTurn, ref artifacts.Ref) string {
	t.Helper()
	rc, size, err := a.PatchBytes.Open(context.Background(), ref)
	if err != nil {
		t.Fatalf("open patch artifact: %v", err)
	}
	defer func() { _ = rc.Close() }()
	body, err := io.ReadAll(io.LimitReader(rc, size+1))
	if err != nil {
		t.Fatalf("read patch artifact: %v", err)
	}
	return string(body)
}

func apatchResolver(f *patchGitFixture, recordedHead string) apatchWorkspaces {
	return apatchWorkspaces{ref: RunWorkspaceRef{
		WorkspaceID: "aaaaaaaa-0000-4000-8000-000000000006",
		VolumeID:    "vol-1",
		Repos: []BoundaryRepo{{
			RowID: "aaaaaaaa-0000-4000-8000-000000000007", RepositoryID: "repo-app",
			CheckoutPath: f.checkout, RunRef: "refs/communication/run",
			BaseCommit: f.base, RecordedHead: recordedHead,
		}},
	}}
}

// A changed tree files exactly one patch artifact, scoped to the attempt the
// way the attempt's other artifacts are, and the bytes are the reviewable
// diff — the committed edit AND the untracked new file, the same pair the
// unit capture's test pins.
func TestAgentTurnAttemptPatchFilesOneAttemptScopedArtifact(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "hello.py", "print('hello')\nprint('agent edited me')\n")
	f.git(t, "add", "hello.py")
	f.git(t, "commit", "-qm", "the agent's edit")
	writePatchFile(t, f.checkout, "notes/from-agent.md", "# what I did\n")

	rows := &apatchRows{}
	a := apatchTurn(t, f, rows, apatchResolver(f, ""))
	a.captureAttemptPatch(context.Background(), apatchClaim(), []MaterializeRepo{
		{ID: "repo-app", Name: "app", CheckoutPath: f.checkout},
	}, nil)

	published := rows.all()
	if len(published) != 1 {
		t.Fatalf("the attempt filed %d patch artifacts, want exactly one: %+v", len(published), published)
	}
	in := published[0]
	if in.Kind != artifacts.KindPatch || in.MediaType != patchMedia {
		t.Fatalf("kind/media = %q/%q, want patch/%s", in.Kind, in.MediaType, patchMedia)
	}
	if in.Name != "patch-app" {
		t.Fatalf("name = %q, want patch-app (the prepared repository's own name)", in.Name)
	}
	c := apatchClaim()
	for _, want := range []struct {
		field, value string
	}{
		{"organization", in.OrganizationID}, {"project", in.ProjectID},
		{"run", in.RunID}, {"node_execution", in.NodeExecutionID},
		{"attempt", in.AttemptID}, {"worker", in.WorkerID},
	} {
		if want.value == "" {
			t.Fatalf("the patch artifact lost its %s scope", want.field)
		}
	}
	if in.RunID != c.RunID || in.AttemptID != c.AttemptID || in.NodeExecutionID != c.NodeExecutionID {
		t.Fatalf("the patch artifact is scoped to %s/%s/%s, want the claiming attempt",
			in.RunID, in.NodeExecutionID, in.AttemptID)
	}
	if in.FencingToken != c.FencingToken {
		t.Fatalf("the patch artifact published on fencing token %d, want the claim's %d",
			in.FencingToken, c.FencingToken)
	}
	body := apatchReadBack(t, a, in.Ref)
	for _, want := range []string{
		"diff --git a/hello.py b/hello.py",
		"+print('agent edited me')",
		"diff --git a/notes/from-agent.md b/notes/from-agent.md",
		"+# what I did",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("the attempt's patch artifact lacks %q:\n%s", want, body)
		}
	}
}

// The base is the commit THIS attempt started from, not the run's branch
// point: a previous boundary already recorded a head, and the diff against
// that head must show only this attempt's work.
func TestAgentTurnAttemptPatchBasesOnTheRecordedBoundary(t *testing.T) {
	f := newPatchGitFixture(t)
	// An earlier node committed work; the boundary capture recorded that head.
	writePatchFile(t, f.checkout, "earlier.py", "print('an earlier node')\n")
	f.git(t, "add", "earlier.py")
	f.git(t, "commit", "-qm", "an earlier node's commit")
	earlierHead := strings.TrimSpace(f.git(t, "rev-parse", "HEAD"))
	// This attempt's own edit, uncommitted.
	writePatchFile(t, f.checkout, "hello.py", "print('hello')\nprint('this attempt')\n")

	rows := &apatchRows{}
	a := apatchTurn(t, f, rows, apatchResolver(f, earlierHead))
	a.captureAttemptPatch(context.Background(), apatchClaim(), nil, nil)

	published := rows.all()
	if len(published) != 1 {
		t.Fatalf("want one patch artifact, got %d", len(published))
	}
	body := apatchReadBack(t, a, published[0].Ref)
	if !strings.Contains(body, "+print('this attempt')") {
		t.Fatalf("the patch misses this attempt's own edit:\n%s", body)
	}
	if strings.Contains(body, "an earlier node") {
		t.Fatalf("the patch re-quotes a commit that belongs to an earlier boundary:\n%s", body)
	}
}

// A tree that says nothing new against its base files nothing: the clean run
// stays artifact-free rather than storing an empty document pretending to be
// evidence.
func TestAgentTurnAttemptPatchQuietWhenNothingChanged(t *testing.T) {
	f := newPatchGitFixture(t)
	rows := &apatchRows{}
	a := apatchTurn(t, f, rows, apatchResolver(f, ""))
	a.captureAttemptPatch(context.Background(), apatchClaim(), nil, nil)
	if got := rows.all(); len(got) != 0 {
		t.Fatalf("an unchanged tree filed %+v, want nothing", got)
	}
}

// A materialized secret the agent cat'd into a tracked file must not reach the
// artifact — the unit capture's scanner, applied to the attempt's own
// materialized values, with the count riding the row (12-test-strategy case
// 12's invariant).
func TestAgentTurnAttemptPatchRedactsAPlantedSecret(t *testing.T) {
	f := newPatchGitFixture(t)
	const secret = "ghp_plantedsecretvalue00000000000000000000"
	writePatchFile(t, f.checkout, "leak.py", "TOKEN = \""+secret+"\"\n")

	rows := &apatchRows{}
	a := apatchTurn(t, f, rows, apatchResolver(f, ""))
	a.captureAttemptPatch(context.Background(), apatchClaim(), nil, &Materialized{
		Env:   []string{"TOKEN=" + secret},
		Files: []string{filepath.Join(f.checkout, ".env.mount")},
		Redact: func(text string) (string, int) {
			n := strings.Count(text, secret)
			return strings.ReplaceAll(text, secret, "[REDACTED]"), n
		},
	})
	published := rows.all()
	if len(published) != 1 {
		t.Fatalf("want one patch artifact, got %d", len(published))
	}
	if published[0].RedactionCount != 1 {
		t.Fatalf("redaction_count = %d, want the scan's 1", published[0].RedactionCount)
	}
	body := apatchReadBack(t, a, published[0].Ref)
	if strings.Contains(body, secret) {
		t.Fatalf("the artifact stored the planted secret verbatim:\n%s", body)
	}
	if !strings.Contains(body, "[REDACTED]") {
		t.Fatalf("the artifact holds no redaction marker:\n%s", body)
	}
	// The mount itself stayed out of the diff (the boundary exclusion set the
	// checkpoint capture already declares).
	if strings.Contains(body, ".env.mount") {
		t.Fatalf("the materialized mount leaked into the patch:\n%s", body)
	}
}

// A patch artifact wider than the bound is cut at a hunk boundary with the
// truncation note — the shared BoundPatch rule the unit capture's test pins
// line by line; here it is enough that the attempt path enforces the cap.
func TestAgentTurnAttemptPatchHonoursTheSizeBound(t *testing.T) {
	f := newPatchGitFixture(t)
	for i := 1; i <= 400; i++ {
		var b strings.Builder
		for l := 1; l <= 80; l++ {
			fmt.Fprintf(&b, "filler%03d_line%d()\n", i, l)
		}
		writePatchFile(t, f.checkout, filepath.Join("gen", fmt.Sprintf("file%03d.py", i)), b.String())
	}
	rows := &apatchRows{}
	a := apatchTurn(t, f, rows, apatchResolver(f, ""))
	a.captureAttemptPatch(context.Background(), apatchClaim(), nil, nil)
	published := rows.all()
	if len(published) != 1 {
		t.Fatalf("want one patch artifact, got %d", len(published))
	}
	body := apatchReadBack(t, a, published[0].Ref)
	if len(body) > patchArtifactMaxBytes {
		t.Fatalf("the artifact is %d bytes, over the %d bound", len(body), patchArtifactMaxBytes)
	}
	if !strings.Contains(body, "(truncated,") {
		t.Fatal("a bound artifact carries no truncation note")
	}
}

// Every unwired seam is the honest pre-patch state, quiet rather than loud:
// no byte backend, no row writer, no run-workspace seam, or no workspace row
// at all — none of them may panic, none may claim an artifact.
func TestAgentTurnAttemptPatchUnwiredIsQuiet(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "hello.py", "print('edited')\n")
	c := apatchClaim()

	noBytes := apatchTurn(t, f, &apatchRows{}, apatchResolver(f, ""))
	noBytes.PatchBytes = nil
	noBytes.captureAttemptPatch(context.Background(), c, nil, nil)

	rows := &apatchRows{}
	noRows := apatchTurn(t, f, rows, apatchResolver(f, ""))
	noRows.PatchRows = nil
	noRows.captureAttemptPatch(context.Background(), c, nil, nil)

	if got := rows.all(); len(got) != 0 {
		t.Fatalf("an unwired writer still saw %+v", got)
	}
	noResolver := &AgentTurn{PatchBytes: noBytes.PatchBytes, PatchRows: rows, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	noResolver.captureAttemptPatch(context.Background(), c, nil, nil)
	if got := rows.all(); len(got) != 0 {
		t.Fatalf("without the § 4 step 3 resolver the attempt filed %+v", got)
	}
	lost := &AgentTurn{Checkpoints: apatchWorkspaces{}, PatchBytes: noBytes.PatchBytes, PatchRows: rows, Logger: noRows.Logger}
	lost.captureAttemptPatch(context.Background(), c, nil, nil)
	if got := rows.all(); len(got) != 0 {
		t.Fatalf("a run with no workspace row filed %+v", got)
	}
}

// A refusing writer (a stale fence, an offline row transaction) is a warning:
// captureAttemptPatch returns nothing at all, so there is literally no channel
// through which a lost artifact could become a failed attempt (D9).
func TestAgentTurnAttemptPatchRowRefusalOnlyWarns(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "hello.py", "print('refused')\n")
	rows := &apatchRows{err: errors.New("lease lost")}
	var logs strings.Builder
	a := apatchTurn(t, f, rows, apatchResolver(f, ""))
	a.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	a.captureAttemptPatch(context.Background(), apatchClaim(), nil, nil)
	if rows.seen != 1 {
		t.Fatalf("the writer was called %d times, want the one attempt", rows.seen)
	}
	if !strings.Contains(logs.String(), "publishing the artifact row failed") {
		t.Fatalf("the refusal went unlogged:\n%s", logs.String())
	}
}

// The process.exec half of the same rule: the command node's boundary capture
// files its patch beside the checkpoint row it already writes.
func TestProcExecBoundaryPatchFilesTheArtifact(t *testing.T) {
	f := newPatchGitFixture(t)
	writePatchFile(t, f.checkout, "build.txt", "generated by the command\n")

	local, err := artifacts.NewLocal(artifacts.LocalConfig{Root: filepath.Join(f.root, "artifacts")})
	if err != nil {
		t.Fatal(err)
	}
	rows := &apatchRows{}
	p := &ProcExec{
		WorkspaceRoot: f.root,
		BoundaryGit:   &wsgit.Manager{Git: &wsgit.Runner{Home: filepath.Join(f.root, "home")}},
		PatchBytes:    local,
		PatchRows:     rows,
		Logger:        slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
	ref := RunWorkspaceRef{
		WorkspaceID: "aaaaaaaa-0000-4000-8000-000000000006",
		Repos: []BoundaryRepo{{
			RowID: "r", RepositoryID: "repo-app", CheckoutPath: f.checkout, BaseCommit: f.base,
		}},
	}
	p.captureBoundaryPatch(context.Background(), apatchClaim(), ref, nil, nil)
	published := rows.all()
	if len(published) != 1 {
		t.Fatalf("the command boundary filed %d artifacts, want one", len(published))
	}
	body := apatchReadBack(t, &AgentTurn{PatchBytes: local}, published[0].Ref)
	if !strings.Contains(body, "+generated by the command") {
		t.Fatalf("the command's edit is not in its patch:\n%s", body)
	}
}
