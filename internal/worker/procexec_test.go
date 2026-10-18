package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
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
		// A location the contract refuses is a setup detail (e.g. $HOME itself
		// is under /tmp), not a test failure: skip, as the workspace/git lab
		// helper does.
		t.Skipf("lab scratch location: %v", err)
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

// shScript is the schema's shape for "run this body under sh": a bare
// executable plus its args (configProcessExec declares no argv). The executor
// resolves `sh` on the worker's PATH and execs it directly — argv only, never a
// shell built by one process out of a string.
func shScript(body string) map[string]any {
	return map[string]any{"executable": "sh", "args": []any{"-c", body}}
}

// execArgs is the same shape for a command named by its bare executable.
func execArgs(name string, args ...string) map[string]any {
	list := make([]any, len(args))
	for i, a := range args {
		list[i] = a
	}
	return map[string]any{"executable": name, "args": list}
}

// extraction is outputExtraction in the shape the schema publishes: an object
// with a mode and, for json_from_path, a path beside it.
func extraction(mode string, path ...string) map[string]any {
	ex := map[string]any{"mode": mode}
	if len(path) > 0 {
		ex["path"] = path[0]
	}
	return ex
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
	t.Run("an executable that is not on the worker PATH is unable to start", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
			"executable": "definitely-not-here-9a7c",
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
		res, err := f.proc.Execute(ctx, f.claim(execArgs("sleep", "30")), f.sink)
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
		res, err := f.proc.Execute(ctx, f.claim(execArgs("sleep", "30")), f.sink)
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

// procExecLookPath is the worker's own PATH lookup, asserted from the test
// process — the same search the executor performs.
func procExecLookPath(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s is required on the test process's PATH for this assertion: %v", name, err)
	}
	return path
}

// TestProcExecExecutableResolvedOnPath pins the schema's shape of § 4 step 7:
// the plan names a BARE executable (configProcessExec.executable's pattern
// forbids a separator), the worker resolves it against its own PATH, and the
// arguments are the plan's `args` verbatim. An executable the PATH does not
// carry is the contract's unable-to-start arm — infra, before any child exists —
// never a command that "failed".
func TestProcExecExecutableResolvedOnPath(t *testing.T) {
	t.Run("a bare name on PATH resolves and the exit maps normally", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{"executable": "true"}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded || res.Outcome != "passed" {
			t.Fatalf("res = %+v, want succeeded/passed (`true` found on the worker PATH)", res)
		}
		if code, ok := outputsCode(t, res.Outputs); !ok || code != 0 {
			t.Errorf("exit_code = %v, want 0", res.Outputs)
		}
	})

	t.Run("args reach the command verbatim", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		if err := os.WriteFile(filepath.Join(f.layout.Scratch, "present.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		// `test -e <file>` exits 0 when the argument arrived intact and 1 when it
		// did not — the two arms are what prove args are passed, not dropped or
		// re-parsed by a shell.
		res, err := f.proc.Execute(context.Background(), f.claim(
			execArgs("test", "-e", filepath.Join(f.layout.Scratch, "present.txt"))), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded || res.Outcome != "passed" {
			t.Fatalf("res = %+v, want succeeded/passed (the args arrived)", res)
		}
		res, err = f.proc.Execute(context.Background(), f.claim(
			execArgs("test", "-e", filepath.Join(f.layout.Scratch, "absent.txt"))), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded || res.Outcome != "failed" {
			t.Fatalf("res = %+v, want succeeded/failed (exit 1 is the command's verdict, not infra)", res)
		}
	})

	t.Run("an executable off the PATH is unable to start", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		res, err := f.proc.Execute(context.Background(), f.claim(
			map[string]any{"executable": "m4-helper-that-does-not-exist"}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra (§ 4 step 7's unable-to-start arm)", res)
		}
		if !strings.Contains(res.Detail, "unable to start") || !strings.Contains(res.Detail, "PATH") {
			t.Errorf("detail = %q, want it to name unable to start and the worker PATH", res.Detail)
		}
	})

	t.Run("a path, not a bare name, is refused as a plan bug", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		res, err := f.proc.Execute(context.Background(), f.claim(
			map[string]any{"executable": "/bin/true"}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "bare executable name") {
			t.Fatalf("res = %+v, want the schema pattern's infra refusal", res)
		}
	})

	t.Run("the plan's own env declarations reach the child", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		t.Setenv("COMMUNICATION_TEST_ONLY", "worker-side-only")
		cfg := map[string]any{"executable": "env", "env": map[string]any{"M4_PLAN_VAR": "from-the-plan"}}
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		preview, _ := res.Outputs.(map[string]any)["stdout_preview"].(string)
		if !strings.Contains(preview, "M4_PLAN_VAR=from-the-plan") {
			t.Errorf("the plan's env declaration did not reach the child: %s", preview)
		}
		if strings.Contains(preview, "COMMUNICATION_TEST_ONLY") {
			t.Error("the child inherited the worker's environment (§ 4 step 7)")
		}
	})
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
		cfg["outputExtraction"] = extraction("json_from_stdout")
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
		cfg["outputExtraction"] = extraction("json_from_stdout")
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
		cfg["outputExtraction"] = extraction("json_from_stdout")
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
		cfg["outputExtraction"] = extraction("json_from_path", "../../etc/passwd")
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
		cfg["outputExtraction"] = extraction("json_from_path", filepath.Join(f.layout.Work, "scratch", "result.json"))
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
		AfUnixMediation: "pathname", NetworkEnforced: nono.NetworkDenied, Verified: true,
	}}
	f.proc.Sandbox = fake
	f.proc.SandboxPath = "/bin/echo" // echoes the nono argv and exits 0
	f.proc.Checkpoints = stubCheckpoints{}
	claim := f.claim(map[string]any{"executable": "true"})

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
	if spec.Profile.NetworkEnforced != nono.NetworkDenied {
		t.Error("communication-command must carry its own egress-denied claim (ADR-0035 left this kind on --block-net)")
	}
	if spec.AdapterPath != procExecLookPath(t, "true") {
		t.Errorf("adapter = %q, want the worker-PATH resolution of `true`", spec.AdapterPath)
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
	res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{"executable": "true"}), f.sink)
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
	t.Run("unresolved executable is a binding_error", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		cfg := map[string]any{"executable": map[string]any{
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
		store.queueExec(fakeAttemptID, fakeRunID, execArgs("sleep", "30"))
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

// --- ADR-0026: the command sandbox's tool read grants -----------------------
//
// § 4 step 5 names the workspace a command works ON; ADR-0026 adds the
// directory the program itself lives in, read-only, so the worker's PATH
// lookup and the sandbox's reach cannot disagree (the lab's uniform exit 126).
// The lab's exit-126 → success transition is the live proof; these are the Go
// pins that keep it from regressing, asserted through the same
// recordingSandbox seam that pins the profile kind and the --block-net claim.

// toolReadsFixture is a required-mode launch whose spec is captured without a
// kernel; /bin/echo stands in for nono and exits 0.
func toolReadsFixture(t *testing.T) (*procExecFixture, *recordingSandbox) {
	t.Helper()
	f := newProcExecFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{result: &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion,
		PolicyRef: nono.ProfileCommand, PolicyDigest: "sha256:fake",
		AfUnixMediation: "pathname", NetworkEnforced: nono.NetworkDenied, Verified: true,
	}}
	f.proc.Sandbox = fake
	f.proc.SandboxPath = "/bin/echo"
	f.proc.Checkpoints = stubCheckpoints{}
	return f, fake
}

// prependPATH puts dir first on the WORKER's PATH — the deployment knob
// resolveExecutable documents: the M4 worker image prepends /opt/m4/bin the
// same way, and it is the worker's environment that is searched, never the
// child's.
func prependPATH(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// toolReadsBin is a program directory OUTSIDE every workspace grant, under
// lab scratch (never the temp tree — grant paths refuse it).
func toolReadsBin(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(procExecScratch(t, "toolreads"), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create tool dir: %v", err)
	}
	if err := wsgit.RefuseTempPath(dir); err != nil {
		t.Fatalf("tool dir is not grant-legitimate: %v", err)
	}
	prependPATH(t, dir)
	return dir
}

func toolReadsProgram(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

// toolReadsWant resolves a program path the way commandToolReads does, so the
// assertion names the directory the sandbox is actually handed (/bin prints
// back as /usr/bin on a merged-usr host, and N-d compares path-for-path).
func toolReadsWant(t *testing.T, path string) string {
	t.Helper()
	dir := filepath.Dir(path)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = filepath.Clean(resolved)
	}
	return dir
}

func toolReadsHas(t *testing.T, spec nono.LaunchSpec, want string) {
	t.Helper()
	for _, got := range spec.ToolReads {
		if got == want {
			return
		}
	}
	t.Errorf("ToolReads = %v, want an entry for %s (ADR-0026 § Decision 2)", spec.ToolReads, want)
}

// toolReadsAreDirs pins § Decision 2's granularity as observed: the entries
// are directories, never the resolved program file (the file-level narrowing is
// the ADR's "tighten later" direction, not what shipped in 4fe3f68).
func toolReadsAreDirs(t *testing.T, spec nono.LaunchSpec) {
	t.Helper()
	for _, got := range spec.ToolReads {
		st, err := os.Stat(got)
		if err != nil {
			t.Errorf("tool read %s does not exist: %v", got, err)
			continue
		}
		if !st.IsDir() {
			t.Errorf("tool read %s is not a directory: ADR-0026 grants filepath.Dir() of the resolved program", got)
		}
	}
}

func toolReadsLacks(t *testing.T, spec nono.LaunchSpec, unwanted string) {
	t.Helper()
	for _, got := range spec.ToolReads {
		if got == unwanted {
			t.Errorf("ToolReads = %v, want no entry for %s", spec.ToolReads, unwanted)
			return
		}
	}
}

// toolReadsAreReadOnly scans the argv the real launch would carry: a tool path
// may only ever follow --read. `--allow` (rw) on a program directory is the
// broadening § Decision 3 forbids — Option A's writable copied tool — and N-d
// would refuse it as grant_mismatch. It also pins that no tool path collides
// with a plan grant, which is the two-levels-on-one-path refusal.
func toolReadsAreReadOnly(t *testing.T, spec nono.LaunchSpec) {
	t.Helper()
	argv, err := spec.BuildLaunchArgv()
	if err != nil {
		t.Fatalf("BuildLaunchArgv: %v", err)
	}
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "--" {
			break
		}
		if argv[i] != "--read" && argv[i] != "--allow" {
			continue
		}
		for _, tool := range spec.ToolReads {
			if argv[i+1] != tool {
				continue
			}
			if argv[i] != "--read" {
				t.Errorf("tool path %s was granted %s: tool reads are read-only (ADR-0026 § Decision 3)", tool, argv[i])
			}
			for _, g := range spec.Plan.Grants {
				if g.Path == tool {
					t.Errorf("tool path %s is also workspace grant %s (%s): two levels on one path refuse the launch", tool, g.Role, g.Access())
				}
			}
		}
	}
}

// TestProcExecToolReads is ADR-0026's Decision 2-4 in Go: the resolved
// program's directory, plus its `#!` interpreter's, at read level, deduped and
// skipped when a workspace grant already reaches them.
func TestProcExecToolReads(t *testing.T) {
	t.Run("an executable outside every workspace grant contributes its own directory", func(t *testing.T) {
		dir := toolReadsBin(t, "opt-m4-bin")
		// No `#!` line: the interpreter arm must contribute nothing, so the
		// set is exactly one entry. The kernel could not exec this — that is
		// the point: the grant is computed from what the worker RESOLVED.
		tool := toolReadsProgram(t, dir, "m4-exit.sh", "exit 0\n")
		f, fake := toolReadsFixture(t)
		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("m4-exit.sh")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want the echo stand-in to carry the launch", res)
		}
		spec := fake.lastSpec()
		want := toolReadsWant(t, tool)
		if len(spec.ToolReads) != 1 || spec.ToolReads[0] != want {
			t.Fatalf("ToolReads = %v, want exactly [%s] (ADR-0026 § Decision 2: at most the program and its interpreter)", spec.ToolReads, want)
		}
		// The premise of the whole ADR: this directory is NOT already granted.
		for _, g := range spec.Plan.Grants {
			if inside(g.Path, want) {
				t.Fatalf("the workspace grant %s (%s) already covers %s — the test is not measuring a widening",
					g.Role, g.Path, want)
			}
		}
		toolReadsAreReadOnly(t, spec)
	})

	t.Run("#!/usr/bin/env sh contributes the PATH-resolved interpreter's directory", func(t *testing.T) {
		shPath := procExecLookPath(t, "sh")
		dir := toolReadsBin(t, "env-sh-bin")
		tool := toolReadsProgram(t, dir, "twin.sh", "#!/usr/bin/env sh\nexit 0\n")
		f, fake := toolReadsFixture(t)
		if _, err := f.proc.Execute(context.Background(), f.claim(execArgs("twin.sh")), f.sink); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		spec := fake.lastSpec()
		// `env` itself is never granted; the program whose execution is being
		// granted is the env-resolved one (§ Decision 2).
		toolReadsHas(t, spec, toolReadsWant(t, tool))
		toolReadsHas(t, spec, toolReadsWant(t, shPath))
		if len(spec.ToolReads) > 2 {
			t.Errorf("ToolReads = %v, want at most two entries (ADR-0026 § Decision 2)", spec.ToolReads)
		}
		// `env` itself is not the grant's subject and never a file-level entry:
		// what arrives is the DIRECTORY of the program whose execution is being
		// granted, which is why a host where `env` and `sh` share /usr/bin
		// dedupes to one interpreter grant rather than two.
		toolReadsAreDirs(t, spec)
		toolReadsAreReadOnly(t, spec)
	})

	t.Run("#!/bin/sh contributes that interpreter's directory", func(t *testing.T) {
		dir := toolReadsBin(t, "plain-sh-bin")
		tool := toolReadsProgram(t, dir, "plain.sh", "#!/bin/sh\nexit 0\n")
		f, fake := toolReadsFixture(t)
		if _, err := f.proc.Execute(context.Background(), f.claim(execArgs("plain.sh")), f.sink); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		spec := fake.lastSpec()
		toolReadsHas(t, spec, toolReadsWant(t, tool))
		toolReadsHas(t, spec, toolReadsWant(t, "/bin/sh"))
		toolReadsAreReadOnly(t, spec)
	})

	t.Run("a program already inside a workspace grant is not re-granted", func(t *testing.T) {
		// The checked-out build script's case (§ Decision 4): its parent's
		// ruleset reaches its subtree, and a second, read-level rule on the
		// same path would refuse the launch outright.
		f, fake := toolReadsFixture(t)
		dir := filepath.Join(f.layout.Scratch, "checkedout-bin")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create the in-workspace tool dir: %v", err)
		}
		prependPATH(t, dir)
		tool := toolReadsProgram(t, dir, "build.sh", "#!/bin/sh\nexit 0\n")
		if _, err := f.proc.Execute(context.Background(), f.claim(execArgs("build.sh")), f.sink); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		spec := fake.lastSpec()
		covered := false
		for _, g := range spec.Plan.Grants {
			if inside(g.Path, dir) {
				covered = true
			}
		}
		if !covered {
			t.Fatalf("plan grants %v do not cover %s — the premise of this case is gone", spec.Plan.Grants, dir)
		}
		toolReadsLacks(t, spec, toolReadsWant(t, tool))
		// The interpreter arm still arrives: it sits outside the workspace.
		toolReadsHas(t, spec, toolReadsWant(t, "/bin/sh"))
		toolReadsAreReadOnly(t, spec)
	})

	t.Run("a program the PATH does not resolve contributes no grant", func(t *testing.T) {
		// § Decision 4's fail direction: no grant is computed for a program
		// that is not a regular existing file, and the launch is not widened
		// on a guess.
		f, fake := toolReadsFixture(t)
		dir := filepath.Join(procExecScratch(t, "toolreads"), "empty-bin")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create the empty tool dir: %v", err)
		}
		prependPATH(t, dir)
		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("m4-helper-that-does-not-exist")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want the unable-to-start infra arm", res)
		}
		if fake.calls() != 0 {
			t.Fatalf("Verify calls = %d, want 0 — nothing is launched for an unresolvable command", fake.calls())
		}
	})
}

// TestProcExecExtractPathRelativeToCwd is the live-lab regression: the twin's
// test node runs `cargo`-style tooling that writes build/test-result.json
// inside its own working directory, and outputExtraction.path must be read
// from that same directory, not from the workspace root. It also pins the
// deliberate default: with NO cwd the command runs in scratch/ (an rw grant
// on the workspace root would let a command remove its own granted trees —
// see the comment at the default-cwd line), and no plan ever grants
// layout.Work itself.
func TestProcExecExtractPathRelativeToCwd(t *testing.T) {
	const body = `mkdir -p build && printf '{"verdict":"pass"}' > build/out.json && pwd > ran-here.txt`

	t.Run("with no cwd the command runs in scratch/ and extracts from there", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		cfg := shScript(body)
		cfg["outputExtraction"] = extraction("json_from_path", "build/out.json")
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want the cwd-relative build/out.json extracted", res)
		}
		if got := res.Outputs.(map[string]any)["verdict"]; got != "pass" {
			t.Fatalf("outputs = %#v, want the JSON from scratch/build/out.json", res.Outputs)
		}
		raw, err := os.ReadFile(filepath.Join(f.layout.Scratch, "ran-here.txt"))
		if err != nil {
			t.Fatalf("the command ran somewhere other than scratch/: %v", err)
		}
		if got := strings.TrimSpace(string(raw)); got != f.layout.Scratch {
			t.Errorf("command cwd = %s, want %s (default cwd is scratch/, not the root)", got, f.layout.Scratch)
		}
		if _, err := os.Stat(filepath.Join(f.layout.Work, "ran-here.txt")); err == nil {
			t.Error("the default cwd still writes to the workspace root")
		}
	})

	t.Run("the plan never grants the workspace root itself", func(t *testing.T) {
		f, fake := toolReadsFixture(t)
		res, err := f.proc.Execute(context.Background(), f.claim(shScript(`exit 0`)), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want the stand-in launch to succeed", res)
		}
		spec := fake.lastSpec()
		if spec.Plan.Cwd != f.layout.Scratch {
			t.Errorf("plan cwd = %s, want the scratch/ default %s", spec.Plan.Cwd, f.layout.Scratch)
		}
		for _, g := range spec.Plan.Grants {
			if g.Path == f.layout.Work {
				t.Fatalf("plan grants the workspace root %s (%s): an rw grant on work/ lets a command remove its own granted children", g.Path, g.Role)
			}
		}
	})

	t.Run("explicit cwd is honoured by the command and the extraction alike", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		checkout := filepath.Join(f.layout.Repos, "app")
		if err := os.MkdirAll(checkout, 0o700); err != nil {
			t.Fatal(err)
		}
		cfg := shScript(body)
		cfg["cwd"] = "repos/app"
		cfg["outputExtraction"] = extraction("json_from_path", "build/out.json")
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want build/out.json read under repos/app", res)
		}
		if got := res.Outputs.(map[string]any)["verdict"]; got != "pass" {
			t.Fatalf("outputs = %#v, want the JSON from repos/app/build/out.json", res.Outputs)
		}
		if _, err := os.Stat(filepath.Join(checkout, "build", "out.json")); err != nil {
			t.Errorf("the command wrote outside its checkout: %v", err)
		}
		if _, err := os.Stat(filepath.Join(f.layout.Work, "build", "out.json")); err == nil {
			t.Error("extraction still resolved against the workspace root, not the cwd")
		}
	})

	t.Run("a cwd-relative path still cannot escape the workspace", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		if err := os.MkdirAll(filepath.Join(f.layout.Repos, "app"), 0o700); err != nil {
			t.Fatal(err)
		}
		cfg := shScript(`exit 0`)
		cfg["cwd"] = "repos/app"
		cfg["outputExtraction"] = extraction("json_from_path", "../../../../../../etc/passwd")
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "escapes") {
			t.Fatalf("res = %+v, want an infra refusal naming the FC3 escape", res)
		}
	})

	t.Run("a cwd-relative path inside the workspace is accepted", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		checkout := filepath.Join(f.layout.Repos, "app")
		if err := os.MkdirAll(checkout, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(f.layout.Scratch, "sibling.json"), []byte(`{"verdict":"approve"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		cfg := shScript(`exit 0`)
		cfg["cwd"] = "repos/app"
		cfg["outputExtraction"] = extraction("json_from_path", "../../scratch/sibling.json")
		res, err := f.proc.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want ../../scratch/sibling.json read as inside the granted tree", res)
		}
		if got := res.Outputs.(map[string]any)["verdict"]; got != "approve" {
			t.Errorf("outputs = %#v, want the sibling JSON merged in", res.Outputs)
		}
	})
}
