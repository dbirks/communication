package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The process.exec wave: the exit-status mapping of § 4 step 7, the § 6
// output caps, the from-scratch env discipline of unit.go:537-564, the
// communication-command profile wiring, and dispatch/drain through the real
// attempt loop under -race. A mocked green unit test never substitutes for
// the real-sandbox test (procexec_nono_test.go) or the real-Postgres one —
// but it is where the MAPPING is pinned, because the mapping is the part two
// workers must not invent.

const (
	fakeAttemptID = "11111111-1111-1111-1111-111111111111"
	fakeRunID     = "22222222-2222-2222-2222-222222222222"
)

// procExecFixture builds a prepared run workspace (the § 4 step 3 tree) over
// lab scratch — never /tmp, because grant paths refuse the temp tree
// (RefuseTempPath) — and an executor pointed at it.
type procExecFixture struct {
	root   string
	layout wsgit.Layout
	proc   *ProcExec
	sink   *recordingSink
}

// procExecScratch mirrors the lab scratch rule from the unit tests: real
// filesystems outside the temp tree (RefuseTempPath), because a grant to a
// path under /tmp is a grant the sandbox would widen or refuse by itself and
// the test would be measuring the wrong thing.
func procExecScratch(t *testing.T, name string) string {
	t.Helper()
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for lab scratch: %v", err)
		}
		base = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	dir := filepath.Join(base, name, t.Name(), time.Now().Format("150405.000"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create lab scratch: %v", err)
	}
	if err := wsgit.RefuseTempPath(dir); err != nil {
		t.Fatalf("lab scratch location: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// recordingSandbox is the AgentSandbox seam: it captures the exact
// nono.LaunchSpec the executor built (profile kind, the --block-net claim,
// the from-scratch env) without touching a kernel — the real-sandbox proof
// is procexec_nono_test.go.
type recordingSandbox struct {
	mu     sync.Mutex
	specs  []nono.LaunchSpec
	result *nono.VerificationResult
	err    error
}

func (s *recordingSandbox) Verify(_ context.Context, spec nono.LaunchSpec) (*nono.VerificationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.specs = append(s.specs, spec)
	if s.err != nil {
		return nil, s.err
	}
	if s.result != nil {
		return s.result, nil
	}
	return &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion, PolicyDigest: "sha256:fake",
		PolicyRef: spec.Profile.Kind, AfUnixMediation: "pathname",
		NetworkEnforced: spec.Profile.NetworkEnforced, Verified: true,
	}, nil
}

func (s *recordingSandbox) Probe(context.Context) (domain.SandboxCapabilities, error) {
	return domain.SandboxCapabilities{Backend: "nono", Filesystem: true, Network: true, Verified: true}, nil
}

func (s *recordingSandbox) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.specs)
}

func (s *recordingSandbox) lastSpec() nono.LaunchSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.specs[len(s.specs)-1]
}

func newProcExecFixture(t *testing.T, enforcement domain.EnforcementMode) *procExecFixture {
	t.Helper()
	base := procExecScratch(t, "procexec")
	wsRoot := filepath.Join(base, "workspaces")
	layout, err := wsgit.LayoutOf(wsRoot, "run", fakeRunID)
	if err != nil {
		t.Fatalf("LayoutOf: %v", err)
	}
	if err := layout.Ensure(""); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	return &procExecFixture{
		root:   base,
		layout: layout,
		proc: &ProcExec{
			WorkspaceRoot: wsRoot,
			LauncherHome:  filepath.Join(base, "launcher-home"),
			PolicyDir:     filepath.Join(base, "policy"),
			Enforcement:   enforcement,
			Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
			KillGrace:     500 * time.Millisecond,
		},
		sink: &recordingSink{stopping: make(chan struct{})},
	}
}

func (f *procExecFixture) claim(cfg map[string]any) AttemptClaim {
	return AttemptClaim{
		AttemptID: fakeAttemptID, NodeExecutionID: "ne-" + fakeAttemptID,
		RunID: fakeRunID, ProjectID: "p-1", WorkerID: "worker-1", FencingToken: 1,
		NodeID: "task", NodeInstanceKey: "/task", Kind: NodeKindProcessExec,
		AttemptNumber: 1, Config: cfg,
	}
}

type recordingSink struct {
	events   []AttemptEvent
	stopping chan struct{}
}

func (s *recordingSink) AppendEvent(_ context.Context, ev AttemptEvent) error {
	s.events = append(s.events, ev)
	return nil
}
func (s *recordingSink) Stopping() <-chan struct{} { return s.stopping }

func (s *recordingSink) types() []string {
	out := make([]string, 0, len(s.events))
	for _, e := range s.events {
		out = append(out, e.Type)
	}
	return out
}

func shScript(body string) map[string]any {
	return map[string]any{"argv": []any{"/bin/sh", "-c", body}}
}

// TestProcExecExitMapping is the contract § 4 step 7 table, asserted one
// command per row, in no required-mode guise (Enforcement disabled keeps
// the mapping — not the kernel — under test).
func TestProcExecExitMapping(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantStatus  string
		wantOutcome string
		wantClass   string
		wantCode    int64
	}{
		{"exit 0", `exit 0`, AttemptStatusSucceeded, "passed", "", 0},
		{"exit 3", `exit 3`, AttemptStatusSucceeded, "failed", "", 3},
		{"exit 125", `exit 125`, AttemptStatusSucceeded, "failed", "", 125},
		{"exit 126 is OS talk", `exit 126`, AttemptStatusFailed, "", ErrorClassInfra, 0},
		{"exit 127 is OS talk", `exit 127`, AttemptStatusFailed, "", ErrorClassInfra, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newProcExecFixture(t, domain.EnforceDisabled)
			if tc.wantStatus == AttemptStatusSucceeded {
				// § 4 step 3 wired: the boundary this success must write.
				f.proc.Checkpoints = stubCheckpoints{}
			}
			res, err := f.proc.Execute(context.Background(), f.claim(shScript(tc.body)), f.sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != tc.wantStatus {
				t.Fatalf("status = %q (%s), want %q", res.Status, res.Detail, tc.wantStatus)
			}
			if tc.wantOutcome != "" && res.Outcome != tc.wantOutcome {
				t.Errorf("outcome = %q, want %q", res.Outcome, tc.wantOutcome)
			}
			if tc.wantClass != "" && res.ErrorClass != tc.wantClass {
				t.Errorf("error_class = %q, want %q", res.ErrorClass, tc.wantClass)
			}
			if tc.wantCode != 0 {
				if code, ok := outputsCode(t, res.Outputs); !ok || code != tc.wantCode {
					t.Errorf("outputs.exit_code = %v, want %d", res.Outputs, tc.wantCode)
				}
			}
		})
	}
	t.Run("unable to start is infra", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
			"argv": []any{"/definitely/not/here"},
		}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Errorf("res = %+v, want failed/infra (the contract's unable-to-start arm)", res)
		}
	})
	t.Run("deadline is timeout", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		start := time.Now()
		res, err := f.proc.Execute(ctx, f.claim(map[string]any{"argv": []any{"/bin/sleep", "30"}}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassTimeout {
			t.Errorf("res = %+v, want failed/timeout", res)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("deadline arm took %s; the process group was not terminated", d)
		}
	})
	t.Run("cancel reports the process-group ack", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			time.Sleep(150 * time.Millisecond)
			cancel()
		}()
		start := time.Now()
		res, err := f.proc.Execute(ctx, f.claim(map[string]any{"argv": []any{"/bin/sleep", "30"}}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != "" || res.CancelReason != CancelReasonProcessTerminated {
			t.Errorf("res = %+v, want the empty status + process_group_terminated ack", res)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("group kill took %s, not the grace window", d)
		}
	})
}

func outputsCode(t *testing.T, outputs any) (int64, bool) {
	t.Helper()
	m, ok := outputs.(map[string]any)
	if !ok {
		return 0, false
	}
	switch v := m["exit_code"].(type) {
	case int64:
		return v, true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	}
	return 0, false
}

// TestProcExecOutputsAreBoundedAndScratchEnv pins the § 6 envelope caps and
// the ADR-0019 D1 leak class: nothing from the worker's environment reaches
// the command, the envelope carries exit_code + previews + digests under
// 32 KiB, and an oversize payload refuses with the § 6 named code rather
// than being truncated into a lie.
func TestProcExecOutputsAreBoundedAndScratchEnv(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://worker-secret@db/communication")

	t.Run("stdout json is extracted", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		cfg := shScript(`printf '{"score":7}'`)
		cfg["outputExtraction"] = "json_from_stdout"
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		outs := res.Outputs.(map[string]any)
		if got, ok := outs["score"].(json.Number); !ok || got.String() != "7" {
			t.Errorf("score = %#v, want 7 (integers stay integers)", outs["score"])
		}
		if code, ok := outputsCode(t, outs); !ok || code != 0 {
			t.Errorf("exit_code = %v, want 0", outs["exit_code"])
		}
		raw, _ := json.Marshal(res.Outputs)
		if !strings.HasPrefix(res.OutputsDigest, "sha256:") || len(res.OutputsDigest) != 71 {
			t.Errorf("outputs_digest %q is not a sha256 identity", res.OutputsDigest)
		}
		_ = raw
	})

	t.Run("invalid json is invalid_output evidence", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		cfg := shScript(`printf 'not json at all'`)
		cfg["outputExtraction"] = "json_from_stdout"
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output", res)
		}
		if len(res.OutputErrors) == 0 {
			t.Error("invalid_output must carry output_errors evidence (01 invariant 4)")
		}
	})

	t.Run("oversize envelope refuses with the § 6 code", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		// One valid JSON object with a 40 KiB value: even with the previews
		// dropped the envelope cannot fit the 32 KiB inline cap, and the
		// honest § 6 answer is outputs_too_large — never a truncation.
		cfg := shScript(`printf '{"a":"'; dd if=/dev/zero bs=1 count=40000 2>/dev/null | tr '\0' 'x'; printf '"}'`)
		cfg["outputExtraction"] = "json_from_stdout"
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output", res)
		}
		raw, _ := json.Marshal(res.OutputErrors)
		if !strings.Contains(string(raw), "outputs_too_large") {
			t.Errorf("output_errors = %s, want the outputs_too_large code (§ 6)", raw)
		}
	})

	t.Run("environment is built from scratch", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		res, err := f.proc.Execute(context.Background(), f.claim(shScript(`env | sort`)), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("status = %q (%s)", res.Status, res.Detail)
		}
		preview, _ := res.Outputs.(map[string]any)["stdout_preview"].(string)
		if strings.Contains(preview, "worker-secret") || strings.Contains(preview, "COMMUNICATION_DATABASE_URL") {
			t.Fatal("the worker's DATABASE_URL reached the command environment (ADR-0019 D1's leak)")
		}
		if !strings.Contains(preview, "PATH=") {
			t.Errorf("from-scratch env lacks PATH: %s", preview)
		}
	})

	t.Run("output path escaping the workspace is refused", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		cfg := shScript(`exit 0`)
		cfg["outputExtraction"] = "json_from_path"
		cfg["path"] = "../../etc/passwd"
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "escapes") {
			t.Fatalf("res = %+v, want an infra refusal naming the FC3 escape", res)
		}
	})

	t.Run("json_from_path reads inside the workspace", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		if err := os.WriteFile(filepath.Join(f.layout.Scratch, "result.json"), []byte(`{"verdict":"approve"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		cfg := shScript(`exit 0`)
		cfg["outputExtraction"] = "json_from_path"
		cfg["path"] = filepath.Join(f.layout.Work, "scratch", "result.json")
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		if got := res.Outputs.(map[string]any)["verdict"]; got != "approve" {
			t.Errorf("outputs = %#v, want the path JSON merged in", res.Outputs)
		}
	})

	t.Run("capture lives outside every grant", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		if _, err := f.proc.Execute(context.Background(), f.claim(shScript(`echo hi`)), f.sink); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(f.layout.Meta, "procexec", fakeAttemptID, "stdout.txt")); err != nil {
			t.Errorf("stdout capture belongs under meta/ (worker-only, never granted): %v", err)
		}
	})
}

// TestProcExecRequiredUsesTheCommandProfile asserts the wiring the contract
// pins: verify-then-launch under communication-command with egress denied,
// and an honest sandbox_enforcement_failed — journalled — when the chain
// refuses. The exec target is /bin/echo echoing the built argv, so the
// mapping and profile ride through the REAL argv builder while the kernel
// claim stays where it belongs: the real-sandbox integration test.
func TestProcExecRequiredUsesTheCommandProfile(t *testing.T) {
	f := newProcExecFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{result: &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion,
		PolicyRef: nono.ProfileCommand, PolicyDigest: "sha256:fake",
		AfUnixMediation: "pathname", NetworkEnforced: true, Verified: true,
	}}
	f.proc.Sandbox = fake
	f.proc.SandboxPath = "/bin/echo" // echoes the nono argv and exits 0
	f.proc.Checkpoints = stubCheckpoints{}
	claim := f.claim(map[string]any{"argv": []any{"/bin/true"}})

	res, err := f.proc.Execute(context.Background(), claim, f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded via the echo stand-in", res)
	}
	if fake.calls() != 1 {
		t.Fatalf("Verify calls = %d, want 1 (no verify, no exec — ADR-0019)", fake.calls())
	}
	spec := fake.lastSpec()
	if spec.Profile.Kind != nono.ProfileCommand {
		t.Errorf("profile kind = %q, want %q", spec.Profile.Kind, nono.ProfileCommand)
	}
	if !spec.BlockNet {
		t.Error("the command profile must launch with --block-net (§ 4 step 5: egress denied)")
	}
	if !spec.Profile.NetworkEnforced {
		t.Error("communication-command must carry its own NetworkEnforced claim")
	}
	if spec.AdapterPath != "/bin/true" {
		t.Errorf("adapter = %q", spec.AdapterPath)
	}
	types := strings.Join(f.sink.types(), ",")
	if !strings.Contains(types, events.TypeSandboxVerified) {
		t.Errorf("sandbox.verified missing from the journal: %s", types)
	}
	verified := f.sink.events[0].Payload.(events.SandboxVerifiedPayload)
	if !verified.NetworkEnforced || !verified.Verified {
		t.Errorf("verified payload understates the chain: %+v", verified)
	}
	for _, g := range verified.Grants {
		if !events.ValidGrantRole(g.Role) {
			t.Errorf("grant role %q is not the event vocabulary", g.Role)
		}
	}
}

func TestProcExecRequiredRefusalIsHonestAndJournalled(t *testing.T) {
	f := newProcExecFixture(t, domain.EnforceRequired)
	f.proc.Sandbox = &recordingSandbox{err: &nono.Failure{
		Stage: "grant_assert", Reason: "grant_mismatch", Err: errors.New("resolved grant set is not the recorded one"),
	}}
	f.proc.SandboxPath = "/bin/echo"
	res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{"argv": []any{"/bin/true"}}), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassSandboxEnforcementFail {
		t.Fatalf("res = %+v, want failed/sandbox_enforcement_failed", res)
	}
	types := strings.Join(f.sink.types(), ",")
	if !strings.Contains(types, events.TypeSandboxEnforcementFailed) {
		t.Errorf("sandbox.enforcement_failed missing: %s", types)
	}
	if strings.Contains(res.Detail, f.root) {
		t.Errorf("detail leaked host paths: %s", res.Detail)
	}
}

func TestProcExecRefusesUnpreparedWorkspaceAndBadConfig(t *testing.T) {
	t.Run("workspace not prepared is an infra wiring fact", func(t *testing.T) {
		base := procExecScratch(t, "procexec-unprepared")
		p := &ProcExec{WorkspaceRoot: filepath.Join(base, "workspaces"), Enforcement: domain.EnforceDisabled,
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
		res, err := p.Execute(context.Background(), AttemptClaim{
			AttemptID: fakeAttemptID, RunID: fakeRunID, Kind: NodeKindProcessExec,
			Config: shScript(`exit 0`),
		}, &recordingSink{stopping: make(chan struct{})})
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "step 3") {
			t.Fatalf("res = %+v, want the infra refusal naming § 4 step 3", res)
		}
	})
	t.Run("unresolved argv is a binding_error", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		cfg := map[string]any{"argv": map[string]any{
			"$unresolved": true, "expr_ids": []any{"e1"},
		}}
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassBindingError {
			t.Fatalf("res = %+v, want failed/binding_error", res)
		}
	})
}

// TestProcExecDispatchAndDrainThroughLoop runs the REAL attempt loop with
// the REAL executor under -race: process.exec claims are routed to
// ProcExec (not the refusal executor), terminal writes land complete, and
// drain stops a running command's process group and closes the attempt
// with interrupted{worker_shutdown} — § 4 step 12.
func TestProcExecDispatchAndDrainThroughLoop(t *testing.T) {
	f := newProcExecFixture(t, domain.EnforceDisabled)
	f.proc.Checkpoints = stubCheckpoints{}

	t.Run("dispatch to the executor, boundary written complete", func(t *testing.T) {
		store := newFakeAttemptStore(2)
		store.queueExec(fakeAttemptID, fakeRunID, shScript(`echo dispatched`))
		l, err := NewAttemptLoop(fastAttemptConfig(2), store, AttemptExecutors{NodeKindProcessExec: f.proc},
			func() string { return "worker-1" },
			WithAttemptLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
		if err != nil {
			t.Fatalf("NewAttemptLoop: %v", err)
		}
		startLoop(t, l)
		waitFor(t, "attempt completed", func() bool {
			_, active, _ := store.counts()
			return active == 0 && len(store.writeLog()) > 0 &&
				strings.Contains(strings.Join(store.writeLog(), "\n"), "complete "+fakeAttemptID)
		})
		snap := store.snapshot(fakeAttemptID)
		if snap.status != AttemptStatusSucceeded || snap.outcome != "passed" {
			t.Fatalf("attempt = (%s, %s, %s), want succeeded/passed", snap.status, snap.outcome, snap.detail)
		}
		if snap.checkpoint == nil || snap.checkpoint.VolumeID != "vol-stub" {
			t.Fatalf("checkpoint = %+v, want the bound volume", snap.checkpoint)
		}
		if !strings.Contains(strings.Join(store.writeLog(), "\n"), "begin "+fakeAttemptID) {
			t.Error("BeginAttempt skipped: leased→running must be fenced before Execute")
		}
	})

	t.Run("drain stops the group and writes the honest terminal", func(t *testing.T) {
		store := newFakeAttemptStore(1)
		store.queueExec(fakeAttemptID, fakeRunID, map[string]any{"argv": []any{"/bin/sleep", "30"}})
		l, err := NewAttemptLoop(fastAttemptConfig(1), store, AttemptExecutors{NodeKindProcessExec: f.proc},
			func() string { return "worker-1" },
			WithAttemptLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
		if err != nil {
			t.Fatalf("NewAttemptLoop: %v", err)
		}
		runCtx, cancelRun := context.WithCancel(context.Background())
		defer cancelRun()
		started := make(chan struct{})
		go func() {
			close(started)
			if err := l.Start(runCtx); err != nil {
				t.Errorf("Start: %v", err)
			}
		}()
		<-started
		waitFor(t, "sleep claimed and running", func() bool {
			return store.snapshot(fakeAttemptID).status == AttemptStatusRunning
		})
		drainCtx, cancelDrain := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancelDrain()
		if err := l.Drain(drainCtx); err != nil {
			t.Fatalf("Drain: %v", err)
		}
		snap := store.snapshot(fakeAttemptID)
		if snap.status != AttemptStatusInterrupted {
			t.Fatalf("status = %s, want interrupted (never a lease orphaned while the worker can speak)", snap.status)
		}
		if snap.detail != InterruptReasonWorkerShutdown {
			t.Errorf("interrupt reason = %q, want %q", snap.detail, InterruptReasonWorkerShutdown)
		}
		if _, active, _ := store.counts(); active != 0 {
			t.Errorf("active_attempts = %d after drain, want 0", active)
		}
	})
}

// stubCheckpoints is the § 4 step 3 seam in its wired shape.
type stubCheckpoints struct{}

func (stubCheckpoints) RunWorkspace(context.Context, string) (RunWorkspaceRef, bool, error) {
	return RunWorkspaceRef{
		WorkspaceID: "ws-stub", VolumeID: "vol-stub",
		RepoStates: []CheckpointRepoState{{RepositoryID: "r1", BaseCommit: "aaa", HeadCommit: "bbb"}},
	}, true, nil
}
