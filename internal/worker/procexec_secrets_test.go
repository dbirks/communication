package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/secrets"
)

// Contract § 4 step 4 names no node kind: it says an attempt materializes the
// `node_attempt` arm with secret_materializations.attempt_id set, and § 4 step 7
// says process.exec's env is built from scratch. Both are honoured here at once:
// a mounted value must appear in the *child's* environment and nowhere else.
// The child is `env`, so the captured stdout IS the child environment — a
// stronger claim than reading a struct field.
//
// The other half of the rule is what these files exist to pin: a mount this
// attempt is NOT authorized for is not delivered and is not the attempt's
// failure, while a mount it IS authorized for and that then cannot be
// materialized is. A process.exec claim names no agent profile, and every
// mount's allowlist is written in profile ids (secrets.Resolver denies the
// empty profile outright), so the profile-less attempt is authorized for none —
// see materializeSecrets for why that answer is reached before the materializer
// is asked at all. ProcExec.AttemptProfile is the axis a future claim grows,
// and the seam the authorized-delivery cases below are driven through.

// procExecSecretsStub is a worker.AttemptSecrets that stands in for the
// resolver-backed materializer: it delivers the mount to the profile its
// allowlist names and to no one else, and remembers what it was asked. The
// allowlist is keyed by the request's AgentProfileID exactly as
// secrets.Resolver keys it.
type procExecSecretsStub struct {
	mu        sync.Mutex
	requests  []MaterializeRequest
	repos     []MaterializeRepo
	files     []string
	value     string
	envName   string
	allowlist map[string]bool
	doneCalls int
	err       error
}

func (s *procExecSecretsStub) Materialize(_ context.Context, req MaterializeRequest) (Materialized, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, req)
	if s.err != nil {
		return Materialized{}, s.err
	}
	// The pair the contract fixes: the node_attempt arm only, always naming the
	// attempt whose ledger row it is.
	if req.Lifecycle != LifecycleNodeAttempt || req.AttemptID == "" {
		return Materialized{}, errFake("procExecSecretsStub: request is not a node_attempt delivery")
	}
	if !s.allowlist[req.AgentProfileID] {
		// Not allowlisted: nothing is delivered, which is what "the value is not
		// this unit's" looks like from the worker side.
		return Materialized{}, nil
	}
	out := Materialized{
		Env:   []string{s.envName + "=" + s.value},
		Files: append([]string(nil), s.files...),
		Done: func(context.Context) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.doneCalls++
			return nil
		},
	}
	return out, nil
}

func (s *procExecSecretsStub) ReposForWorkspace(context.Context, string) ([]MaterializeRepo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MaterializeRepo(nil), s.repos...), nil
}

func (s *procExecSecretsStub) snapshot() ([]MaterializeRequest, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MaterializeRequest(nil), s.requests...), s.doneCalls
}

// procExecProfiled points the executor at the profile axis a real claim cannot
// name yet: the attempt is asked as `profile`, so a mount allowlisted for it is
// authorized and any other is not.
func procExecProfiled(f *procExecFixture, profile string) {
	f.proc.AttemptProfile = func(AttemptClaim) string { return profile }
}

// childEnv reads what the launched process actually saw: procexec captures
// stdout to meta/, so with executable=`env` the capture file is the child's
// environment, verbatim.
func childEnv(t *testing.T, f *procExecFixture) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.layout.Meta, "procexec", fakeAttemptID, "stdout.txt"))
	if err != nil {
		t.Fatalf("read the child's captured stdout: %v", err)
	}
	return string(raw)
}

// TestProcExecSecretsEnvMountReachesTheChildProcess is the C2 shape at
// process.exec scope: the mount this attempt is authorized for is in the
// command's environment, and the delivery was asked for with the attempt
// identity the ledger row needs.
func TestProcExecSecretsEnvMountReachesTheChildProcess(t *testing.T) {
	const secretValue = "postgres://lab:secret@db.internal:5432/delivery"

	t.Run("an authorized mount is in the child environment", func(t *testing.T) {
		// Nothing inherits from the worker (§ 4 step 7's rule), so a variable the
		// test process carries must NOT show up in the child's env — the mount
		// is added to the from-scratch env, not to os.Environ().
		t.Setenv("COMMUNICATION_TEST_ONLY", "worker-side-only")
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-implementer")
		stub := &procExecSecretsStub{
			envName: "DATABASE_URL", value: secretValue,
			allowlist: map[string]bool{"m4-implementer": true},
			repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
		}
		f.proc.Secrets = stub

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded", res)
		}
		got := childEnv(t, f)
		if !strings.Contains(got, "DATABASE_URL="+secretValue) {
			t.Errorf("the authorized command's environment lacks the mounted value; child env = %s", redactedEnvList(got))
		}
		if strings.Contains(got, "COMMUNICATION_TEST_ONLY") {
			t.Errorf("the child inherited the worker's environment: %s", redactedEnvList(got))
		}

		reqs, doneCalls := stub.snapshot()
		if len(reqs) != 1 {
			t.Fatalf("materialize calls = %d, want one per attempt", len(reqs))
		}
		if reqs[0].AttemptID != fakeAttemptID {
			t.Errorf("request attempt id = %q, want %q (secret_materializations.attempt_id)", reqs[0].AttemptID, fakeAttemptID)
		}
		if reqs[0].WorkspaceID != "ws-stub" {
			t.Errorf("request workspace = %q, want the § 4 step 3 workspace row's id", reqs[0].WorkspaceID)
		}
		if len(reqs[0].Repos) != 1 || reqs[0].Repos[0].Name != "registry" {
			t.Errorf("request repos = %v, want the workspace's prepared checkouts", reqs[0].Repos)
		}
		if reqs[0].ConversationID != "" || reqs[0].TurnID != "" {
			t.Errorf("request conversation/turn = %q/%q, want empty: a process.exec node is not a conversation (contract § 4 step 8)",
				reqs[0].ConversationID, reqs[0].TurnID)
		}
		if reqs[0].AgentProfileID != "m4-implementer" {
			t.Errorf("request profile = %q, want the profile the attempt is authorized as", reqs[0].AgentProfileID)
		}
		if doneCalls != 1 {
			t.Errorf("cleanup Done calls = %d, want 1 at the attempt boundary", doneCalls)
		}
	})

	t.Run("a mount allowlisted for another profile is not delivered", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-reviewer")
		stub := &procExecSecretsStub{
			envName: "DATABASE_URL", value: secretValue,
			allowlist: map[string]bool{"m4-implementer": true},
			repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
		}
		f.proc.Secrets = stub

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded (a mount that is not this unit's is not the command's failure)", res)
		}
		if strings.Contains(childEnv(t, f), "DATABASE_URL") {
			t.Errorf("a mount allowlisted for another profile reached the child environment: %s", redactedEnvList(childEnv(t, f)))
		}
		reqs, doneCalls := stub.snapshot()
		if len(reqs) != 1 {
			t.Fatalf("materialize calls = %d, want the attempt to ask once regardless", len(reqs))
		}
		if reqs[0].AttemptID != fakeAttemptID {
			t.Errorf("request attempt id = %q, want %q", reqs[0].AttemptID, fakeAttemptID)
		}
		if doneCalls != 0 {
			t.Errorf("cleanup ran for a unit that materialized nothing")
		}
	})
}

// TestProcExecSecretsUnauthorizedMountIsSkipped is the distinction the contract
// draws and the lab depends on: a mount the attempt is not authorized for is
// simply not delivered — nothing is recorded as materialized for it, and the
// command runs — while a mount it IS authorized for that then fails to
// materialize is the attempt's failure. A process.exec claim names no profile,
// and every node_attempt mount's allowlist is written in profile ids, so a
// profile-less attempt is authorized for none of them.
func TestProcExecSecretsUnauthorizedMountIsSkipped(t *testing.T) {
	const secretValue = "test-database-url-sentinel-value"

	// allowlisted is the M4 lab project's shape: one node_attempt mount, granted
	// to the m4-implementer profile and to no one else.
	newStub := func() *procExecSecretsStub {
		return &procExecSecretsStub{
			envName: "DATABASE_URL", value: secretValue,
			allowlist: map[string]bool{"m4-implementer": true},
			repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
		}
	}

	t.Run("a profile-less attempt is never offered the mount", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		stub := newStub()
		f.proc.Secrets = stub // AttemptProfile unwired: the claim names no profile.

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded: an unauthorized mount is not this command's failure", res)
		}
		got := childEnv(t, f)
		if strings.Contains(got, "DATABASE_URL") {
			t.Errorf("an unauthorized mount reached the child: %s", redactedEnvList(got))
		}
		if strings.Contains(got, secretValue) {
			t.Errorf("the mounted value reached the child environment of an unauthorized attempt")
		}
		reqs, doneCalls := stub.snapshot()
		if len(reqs) != 0 {
			t.Errorf("materialize calls = %d, want 0: nothing is delivered and nothing is recorded as materialized for a mount this attempt may not hold", len(reqs))
		}
		if doneCalls != 0 {
			t.Errorf("cleanup Done calls = %d, want 0 (nothing was materialized to close)", doneCalls)
		}
	})

	t.Run("a typed authorization denial skips the mount", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-doc-writer")
		stub := newStub()
		// The other shape of the same answer: a materializer that reports the
		// resolver's sentinel rather than deciding nothing. Recognition is by
		// error TYPE, never by message text.
		stub.err = fmt.Errorf("materialize DATABASE_URL: %w", secrets.ErrNotAuthorized)
		f.proc.Secrets = stub

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded (not authorized ≠ not deliverable by the worker)", res)
		}
		if strings.Contains(childEnv(t, f), "DATABASE_URL") {
			t.Errorf("a denied mount reached the child: %s", redactedEnvList(childEnv(t, f)))
		}
		if _, done := stub.snapshot(); done != 0 {
			t.Errorf("cleanup ran for a delivery that never happened")
		}
	})

	t.Run("an authorized mount that fails to materialize fails the attempt", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-implementer")
		stub := newStub()
		// This attempt IS allowlisted; the failure is the keyring, not the
		// allowlist. That is ADR-0018 D4's fail-closed arm: no child, no
		// partial set.
		stub.err = errFake("secret keyring is unreadable")
		f.proc.Secrets = stub

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra (the attempt's own mount could not be delivered)", res)
		}
		if _, statErr := os.Stat(filepath.Join(f.layout.Meta, "procexec", fakeAttemptID, "stdout.txt")); statErr == nil {
			t.Error("a refused mount still launched a command")
		}
		if strings.Contains(res.Detail, "/") {
			t.Errorf("the failure detail carries a path: %q", res.Detail)
		}
	})
}

// TestProcExecSecretsCleanupRunsOnSuccessAndOnFailure is contract § 4 step 4's
// second half: the value's lifetime is the attempt's, so the ledger closes and
// the file goes away whether the command passed, failed on its own terms, or
// could not be exec'd at all.
func TestProcExecSecretsCleanupRunsOnSuccessAndOnFailure(t *testing.T) {
	const secretValue = "a-lab-sentinel-value-long-enough"

	newSeeded := func(t *testing.T) (*procExecFixture, *procExecSecretsStub, string) {
		t.Helper()
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-implementer")
		// An env_file mount: the stub reports a real path inside the run tree,
		// which is what the cleanup assertion is about.
		file := filepath.Join(f.layout.Repos, "registry", "secrets", "token")
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatalf("seed mount dir: %v", err)
		}
		if err := os.WriteFile(file, []byte(secretValue), 0o600); err != nil {
			t.Fatalf("seed mount file: %v", err)
		}
		stub := &procExecSecretsStub{
			envName: "LAB_SENTINEL", value: secretValue,
			files:     []string{file},
			allowlist: map[string]bool{"m4-implementer": true},
			repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
		}
		f.proc.Secrets = stub
		return f, stub, file
	}

	t.Run("a passing command still cleans up", func(t *testing.T) {
		f, stub, file := newSeeded(t)
		res, err := f.proc.Execute(context.Background(), f.claim(shScript(`exit 0`)), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		if _, statErr := os.Stat(file); !os.IsNotExist(statErr) {
			t.Errorf("the materialized secret survived a passing attempt: %v", statErr)
		}
		if _, done := stub.snapshot(); done != 1 {
			t.Errorf("cleanup Done calls = %d, want 1", done)
		}
	})

	t.Run("a business-failing command still cleans up", func(t *testing.T) {
		f, stub, file := newSeeded(t)
		// exit 3 is the mapping's succeeded/outcome=failed arm — the attempt
		// ends, so the mount ends with it.
		res, err := f.proc.Execute(context.Background(), f.claim(shScript(`exit 3`)), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded with a business fail", res)
		}
		if _, statErr := os.Stat(file); !os.IsNotExist(statErr) {
			t.Errorf("the materialized secret survived a failing command: %v", statErr)
		}
		if _, done := stub.snapshot(); done != 1 {
			t.Errorf("cleanup Done calls = %d, want 1", done)
		}
	})

	t.Run("a command that cannot start still cleans up", func(t *testing.T) {
		f, stub, file := newSeeded(t)
		// The mount is delivered first (§ 4 step 4 precedes § 4 step 7), and then
		// execve itself fails on a file that is +x but is no executable image —
		// the launch-side unable-to-start arm, which no PATH lookup can predict.
		bad := filepath.Join(f.layout.Scratch, "not-an-image")
		if err := os.WriteFile(bad, []byte("this is not an executable image\x00\x01"), 0o755); err != nil {
			t.Fatalf("write the unloadable executable: %v", err)
		}
		res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
			"argv": []any{bad},
		}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra", res)
		}
		if _, statErr := os.Stat(file); !os.IsNotExist(statErr) {
			t.Errorf("the materialized secret survived an attempt that never launched: %v", statErr)
		}
		if _, done := stub.snapshot(); done != 1 {
			t.Errorf("cleanup Done calls = %d, want 1", done)
		}
	})
}

// TestProcExecSecretsFileOutsideTheRunTreeRefusesTheLaunch is the guard an
// ungranted write deserves: a materializer bug that lands a value outside the
// tree the sandbox grants must stop the attempt rather than launch on it.
func TestProcExecSecretsFileOutsideTheRunTreeRefusesTheLaunch(t *testing.T) {
	f := newProcExecFixture(t, domain.EnforceDisabled)
	f.proc.Checkpoints = stubCheckpoints{}
	procExecProfiled(f, "m4-implementer")
	outside := filepath.Join(f.root, "elsewhere", "token")
	if err := os.MkdirAll(filepath.Dir(outside), 0o700); err != nil {
		t.Fatalf("seed outside dir: %v", err)
	}
	if err := os.WriteFile(outside, []byte("value"), 0o600); err != nil {
		t.Fatalf("seed outside file: %v", err)
	}
	f.proc.Secrets = &procExecSecretsStub{
		envName: "LAB_SENTINEL", value: "value", files: []string{outside},
		allowlist: map[string]bool{"m4-implementer": true},
		repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
	}
	res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed {
		t.Fatalf("res = %+v, want failed", res)
	}
	// The refusal must not become a second bug: the file that was written
	// outside the grants is left exactly where it is (removing a path the run
	// does not own is not this attempt's authority), and it is reported.
	if _, statErr := os.Stat(outside); statErr != nil {
		t.Errorf("cleanup removed a file outside the run workspace: %v", statErr)
	}
	if strings.Contains(res.Detail, "elsewhere") {
		t.Errorf("the detail names the escaped path: %q", res.Detail)
	}
}

// redactedEnvList keeps a failing child-env dump from printing the very values
// the test is about: names only.
func redactedEnvList(envText string) []string {
	out := make([]string, 0, 32)
	for _, line := range strings.Split(envText, "\n") {
		name, _, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out = append(out, name+"=<elided>")
	}
	return out
}

// TestProcExecEnvMountSentinelNeverRidesTheLaunchArgv is the ADR-0040 guard at
// process.exec: a fake env-delivered secret mount whose value is a unique
// sentinel must ride the launched process's exec environment — never the argv
// the launcher's `env` hop would render into a sandboxed launch.
func TestProcExecEnvMountSentinelNeverRidesTheLaunchArgv(t *testing.T) {
	const sentinel = "sentinel-procexec-unsandboxed-77e4d2"

	t.Run("unsandboxed: the sentinel rides the exec environment, never argv", func(t *testing.T) {
		f := newProcExecFixture(t, domain.EnforceDisabled)
		f.proc.Checkpoints = stubCheckpoints{}
		procExecProfiled(f, "m4-implementer")
		f.proc.Secrets = &procExecSecretsStub{
			envName: "DATABASE_URL", value: sentinel,
			allowlist: map[string]bool{"m4-implementer": true},
			repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
		}

		res, err := f.proc.Execute(context.Background(), f.claim(execArgs("env")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded", res)
		}
		got := childEnv(t, f)
		if !strings.Contains(got, "DATABASE_URL="+sentinel) {
			t.Fatalf("the env-delivered secret must ride the exec environment, got %s", redactedEnvList(got))
		}
	})
}

// TestProcExecEnvMountSentinelUnderRealNonoStaysInTheExecEnv is the ADR-0040
// guard on the sandboxed arm of process.exec, and it is a REAL launch: the fake
// resolver delivers an env-mounted secret whose value is a unique sentinel, the
// command reads it back through the environment, and the sentinel must then be
// absent from the launch argv and from every file of the nono audit journal for
// the session the launch produced.
func TestProcExecEnvMountSentinelUnderRealNonoStaysInTheExecEnv(t *testing.T) {
	const sentinel = "sentinel-procexec-sandboxed-84bd3e"

	f := realProcExec(t)
	f.proc.Checkpoints = stubCheckpoints{}
	procExecProfiled(f, "m4-implementer")
	f.proc.Secrets = &procExecSecretsStub{
		envName: "SENTINEL_SECRET", value: sentinel,
		allowlist: map[string]bool{"m4-implementer": true},
		repos:     []MaterializeRepo{{ID: "repo-1", Name: "registry"}},
	}

	res, err := f.proc.Execute(context.Background(), f.claim(map[string]any{
		"argv": []any{"/bin/sh", "-c", `printf "%s" "$SENTINEL_SECRET" > seen.txt`},
		"cwd":  f.layout.Scratch,
	}), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	got, rerr := os.ReadFile(filepath.Join(f.layout.Scratch, "seen.txt"))
	if rerr != nil {
		t.Fatalf("the sandboxed command never wrote its output: %v", rerr)
	}
	if string(got) != sentinel {
		t.Fatalf("the sandboxed child did not receive the env-delivered secret through real nono: seen.txt = %q", got)
	}

	// ADR-0040: the sentinel must not be anywhere the launch argv or the audit
	// journal can carry it — the argv is what `nono audit` records verbatim.
	ctx := context.Background()
	marker := egressMarker(fakeAttemptID)
	listCmd := exec.CommandContext(ctx, f.launcher.Binary, "audit", "list", "--json", "--recent", "50")
	listCmd.Dir = f.proc.LauncherHome
	listCmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + f.proc.LauncherHome}
	var listBuf bytes.Buffer
	listCmd.Stdout, listCmd.Stderr = &listBuf, &listBuf
	if err := listCmd.Run(); err != nil {
		t.Fatalf("nono audit list: %v: %s", err, listBuf.String())
	}
	var entries []struct {
		SessionID string   `json:"session_id"`
		Command   []string `json:"command"`
	}
	if err := json.Unmarshal(listBuf.Bytes(), &entries); err != nil {
		t.Fatalf("parse the audit listing: %v", err)
	}
	own := -1
	for i := range entries {
		for _, arg := range entries[i].Command {
			if arg == marker {
				own = i
			}
		}
	}
	if own < 0 {
		t.Fatalf("no audited session carries the launch marker %q: %s", marker, listBuf.String())
	}
	for _, arg := range entries[own].Command {
		if strings.Contains(arg, sentinel) {
			t.Fatalf("the env-delivered secret value reached the launch argv the audit journal records verbatim: %q", arg)
		}
	}
	if strings.Contains(listBuf.String(), sentinel) {
		t.Fatalf("the env-delivered secret value reached the audit listing: %s", listBuf.String())
	}
	sessionID := entries[own].SessionID

	auditCmd := exec.CommandContext(ctx, f.launcher.Binary, "audit", "show", sessionID, "--json")
	auditCmd.Dir = f.proc.LauncherHome
	auditCmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + f.proc.LauncherHome}
	var auditBuf bytes.Buffer
	auditCmd.Stdout, auditCmd.Stderr = &auditBuf, &auditBuf
	if err := auditCmd.Run(); err != nil {
		t.Fatalf("nono audit show: %v: %s", err, auditBuf.String())
	}
	if strings.Contains(auditBuf.String(), sentinel) {
		t.Fatalf("the env-delivered secret value reached the nono audit journal: %s", auditBuf.String())
	}

	// The audit journal is nono's own state dir under the launcher's home
	// ($XDG_STATE_HOME/nono/audit, default <home>/.local/state/nono/audit).
	auditDir := filepath.Join(f.proc.LauncherHome, ".local", "state", "nono", "audit")
	var auditFiles []string
	walkErr := filepath.WalkDir(auditDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		auditFiles = append(auditFiles, path)
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk the nono audit journal dir %s: %v", auditDir, walkErr)
	}
	for _, file := range auditFiles {
		raw, rerr := os.ReadFile(file)
		if rerr != nil {
			t.Fatalf("read the audit journal file %s: %v", file, rerr)
		}
		if strings.Contains(string(raw), sentinel) {
			t.Fatalf("the env-delivered secret value reached the nono audit journal at %s: %s", file, raw)
		}
	}
}
