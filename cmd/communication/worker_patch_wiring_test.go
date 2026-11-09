package main

// The wiring proof for ADR-0078 § Patch artifacts. internal/worker owns the
// patch itself — the diff base, the secret scan, the hunk-bound cut, the
// attempt fence (attempt_patch.go and its own tests) — and internal/worker
// can only prove what it does WHEN the seams are bound. What it cannot see is
// that this binary ever binds them, which is exactly how live pipeline runs
// ended up filing logs and file lists with no diff to quote: the filing code
// existed, the two executors that do the work had nil seams, and a nil seam is
// internal/worker's silent "this worker files no attempt patches".
//
// So this test pins the one thing the binary owns: with an artifact backend
// configured, BOTH work kinds — agent.acp and process.exec — end up holding
// non-nil patch seams, and they are the SAME instance pair artifact.publish
// writes through. One byte backend, one attempt-fenced row writer, one run's
// evidence. The negative leg matters as much: with no backend the executor
// keeps whatever it was built with rather than being un-configured under it.

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

// artifactScratchRoot makes a writable, NON-temporary artifact root: an agent
// can write /tmp, so artifacts.NewLocal refuses it (ADR-0019 P9) and the
// production constructor this test drives must be given a root the production
// worker could actually have been configured with. Same scratch convention as
// the other cmd/communication artifact tests.
func artifactScratchRoot(t *testing.T) string {
	t.Helper()
	scratch := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if scratch == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for artifact scratch: %v", err)
		}
		scratch = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(scratch, t.Name()+"-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

func TestAttemptPatchWiring(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	t.Setenv("COMMUNICATION_ARTIFACT_BACKEND", artifacts.BackendLocal)
	t.Setenv("COMMUNICATION_ARTIFACT_ROOT", artifactScratchRoot(t))

	// The same construction runWorker performs, and the same production row
	// writer: no pool here because this asserts wiring, not a transaction.
	bytesStore, err := artifactBytesFromEnv(false, log)
	if err != nil {
		t.Fatalf("artifact byte backend: %v", err)
	}
	if bytesStore == nil {
		t.Fatal("artifactBytesFromEnv returned a nil store for a configured backend")
	}
	rows := &postgres.AttemptArtifacts{}

	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
	}))
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	units := &worker.UnitService{} // the zero service: wiring reads fields, never calls
	agentTurn := newAgentTurn(opts, nil, units, log)
	if agentTurn == nil {
		t.Fatal("newAgentTurn returned nil")
	}
	procExec := &worker.ProcExec{
		WorkspaceRoot: opts.workspaceRoot,
		LauncherHome:  opts.sandboxLauncherHome,
		PolicyDir:     opts.policyDir,
		Enforcement:   opts.sandboxEnforcement,
		GitIdentity:   opts.agentGit,
		Logger:        log,
	}
	// The construction sites must not pre-bind these: the § 4 wave that owns
	// the artifact backend owns the patch seams too, so there is one pair.
	if agentTurn.PatchBytes != nil || agentTurn.PatchRows != nil ||
		procExec.PatchBytes != nil || procExec.PatchRows != nil {
		t.Fatal("patch seams bound before the artifact backend is wired")
	}

	wireAttemptPatches(bytesStore, rows, procExec, agentTurn)

	kinds := []struct {
		name  string
		bytes artifacts.Store
		rows  worker.AttemptArtifactWriter
	}{
		{"agent.acp", agentTurn.PatchBytes, agentTurn.PatchRows},
		{"process.exec", procExec.PatchBytes, procExec.PatchRows},
	}
	for _, k := range kinds {
		if k.bytes == nil || k.rows == nil {
			t.Fatalf("%s patch seams are nil: the attempt would file no patch artifact (ADR-0078)", k.name)
		}
		if k.bytes != bytesStore {
			t.Errorf("%s patch byte backend = %v, want the store artifact.publish uses", k.name, k.bytes)
		}
		if k.rows != worker.AttemptArtifactWriter(rows) {
			t.Errorf("%s patch row writer = %v, want the fenced writer artifact.publish uses", k.name, k.rows)
		}
		if _, ok := k.rows.(*postgres.AttemptArtifacts); !ok {
			t.Errorf("%s patch rows = %T, want *postgres.AttemptArtifacts", k.name, k.rows)
		}
	}
	// One writer for the worker: two instances would be two chances to
	// disagree about the fence a run's evidence is published under.
	if agentTurn.PatchRows != procExec.PatchRows {
		t.Error("agent.acp and process.exec file patches through different row writers")
	}
}

// TestWireAttemptPatchesWithoutByteBackend is the honest pre-patch state: no
// byte backend means no artifact to file, and the executors must not be left
// holding a half-configured pair (a writer with no bytes would put nothing and
// still journal a row naming no key).
func TestWireAttemptPatchesWithoutByteBackend(t *testing.T) {
	rows := &postgres.AttemptArtifacts{}
	agentTurn := &worker.AgentTurn{}
	procExec := &worker.ProcExec{}
	wireAttemptPatches(nil, rows, procExec, agentTurn)
	wireAttemptPatches(mustStore(t), nil, procExec, agentTurn)
	if agentTurn.PatchBytes != nil || agentTurn.PatchRows != nil ||
		procExec.PatchBytes != nil || procExec.PatchRows != nil {
		t.Error("a nil seam was installed anyway: the worker now claims a patch backend it cannot use")
	}
}

func mustStore(t *testing.T) artifacts.Store {
	t.Helper()
	store, err := artifacts.NewLocal(artifacts.LocalConfig{Root: artifactScratchRoot(t)})
	if err != nil {
		t.Fatalf("local artifact backend: %v", err)
	}
	return store
}
