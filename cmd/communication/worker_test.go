package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
)

// sandboxMode pins the enforcement axis for tests that are about something
// else. `required` (the production default) consults the host's PATH and
// refuses to start without nono — correct, and asserted by
// TestWorkerOptionsFromEnvRequiredRefusesWithoutNono — but a heartbeat-parsing
// test has no business inheriting that dependency on what the developer (or a
// CI runner) happens to have installed. It is set explicitly rather than left
// unset for the mirror-image reason: an ambient COMMUNICATION_SANDBOX_ENFORCEMENT
// in a developer's shell must not be able to change what these tests assert.
//
// permissive-dev is the mode production reaches only by explicit operator
// configuration (05, ADR-0019 D6). Nothing here lowers the bar for a real
// process: runWorker and runDev still resolve their own environment, and the
// refusal below still bites.
const sandboxMode = "permissive-dev"

// env maps the named variables onto getenv, with "" meaning "unset" and every
// other value returned verbatim. Unlisted names come from the real process
// environment, which is why tests pin what they care about explicitly.
func env(pairs map[string]string) func(string) string {
	return func(k string) string {
		if v, ok := pairs[k]; ok {
			if v == "" {
				return ""
			}
			return v
		}
		return os.Getenv(k)
	}
}

func TestWorkerOptionsFromEnv(t *testing.T) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		t.Skipf("hostname unavailable: %v", err)
	}

	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
	}))
	if err != nil {
		t.Fatalf("workerOptionsFromEnv: %v", err)
	}
	if opts.cfg.Name != hostname {
		t.Errorf("Name = %q, want the hostname %q (COMMUNICATION_WORKER_NAME default)", opts.cfg.Name, hostname)
	}
	if opts.cfg.Heartbeat != 10*time.Second || worker.DefaultHeartbeat != 10*time.Second {
		t.Errorf("Heartbeat = %s (DefaultHeartbeat %s), want the 10s default", opts.cfg.Heartbeat, worker.DefaultHeartbeat)
	}
	if opts.cfg.DrainTimeout != worker.DefaultDrainTimeout {
		t.Errorf("DrainTimeout = %s, want %s", opts.cfg.DrainTimeout, worker.DefaultDrainTimeout)
	}
	if opts.cfg.Hostname != hostname || opts.cfg.Version != version {
		t.Errorf("identity = %+v, want hostname %q version %q", opts.cfg, hostname, version)
	}
}

func TestWorkerOptionsFromEnvOverrides(t *testing.T) {
	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://x",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
		"COMMUNICATION_WORKER_NAME":         " worker-1 ",
		"COMMUNICATION_WORKER_HEARTBEAT":    "250ms",
	}))
	if err != nil {
		t.Fatalf("workerOptionsFromEnv: %v", err)
	}
	if opts.cfg.Name != "worker-1" {
		t.Errorf("Name = %q, want %q (surrounding space trimmed)", opts.cfg.Name, "worker-1")
	}
	if opts.cfg.Heartbeat != 250*time.Millisecond {
		t.Errorf("Heartbeat = %s, want 250ms", opts.cfg.Heartbeat)
	}
}

func TestWorkerOptionsFromEnvRejectsBadConfig(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "no database",
			env:  map[string]string{"COMMUNICATION_DATABASE_URL": ""},
			want: "COMMUNICATION_DATABASE_URL is not set",
		},
		{
			name: "heartbeat not a duration",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":        "postgres://x",
				"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
				"COMMUNICATION_WORKER_HEARTBEAT":    "ten seconds",
			},
			want: "COMMUNICATION_WORKER_HEARTBEAT",
		},
		{
			name: "heartbeat zero",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":        "postgres://x",
				"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
				"COMMUNICATION_WORKER_HEARTBEAT":    "0s",
			},
			want: "must be positive",
		},
		{
			name: "heartbeat negative",
			env: map[string]string{
				"COMMUNICATION_DATABASE_URL":        "postgres://x",
				"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
				"COMMUNICATION_WORKER_HEARTBEAT":    "-5s",
			},
			want: "must be positive",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := workerOptionsFromEnv(env(tt.env)); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("workerOptionsFromEnv() error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

// TestWorkerOptionsFromEnvRequiredRefusesWithoutNono is the fail-closed
// assertion for the default mode. With COMMUNICATION_SANDBOX_ENFORCEMENT unset
// the worker is in `required`, and `required` without the nono binary is a
// startup refusal rather than a downgrade (05: "fails closed rather than
// starting unisolated"; ADR-0019 D6). The empty PATH makes the test say what it
// means everywhere: it asserts the same thing on a laptop that has nono
// installed and on a runner that does not, because what is under test is the
// worker's own search path — not the host's.
func TestWorkerOptionsFromEnvRequiredRefusesWithoutNono(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // nothing resolvable, nono least of all

	// "" is the default (i.e. required) and "required" is the explicit form of
	// the same decision; both must refuse.
	for _, raw := range []string{"", string(domain.EnforceRequired)} {
		name := raw
		if name == "" {
			name = "unset-default"
		}
		t.Run("mode="+name, func(t *testing.T) {
			opts, err := workerOptionsFromEnv(env(map[string]string{
				"COMMUNICATION_DATABASE_URL":        "postgres://x",
				"COMMUNICATION_SANDBOX_ENFORCEMENT": raw,
				"COMMUNICATION_WORKER_NAME":         "no-nono-worker",
			}))
			if err == nil {
				t.Fatalf("workerOptionsFromEnv(mode=%q) = nil error, want a refusal to start unsandboxed", raw)
			}
			if opts.sandboxEnforcement != domain.EnforceRequired {
				t.Errorf("resolved mode = %q, want %q (required must be the default, and stays the mode even when it cannot be honoured)",
					opts.sandboxEnforcement, domain.EnforceRequired)
			}
			for _, want := range []string{"COMMUNICATION_SANDBOX_ENFORCEMENT=required", "nono", "refusing to start"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("refusal = %q, want substring %q", err, want)
				}
			}
		})
	}
}

// TestWorkerOptionsFromEnvNonRequiredModesStartWithoutNono is the other half of
// the same contract: PATH decides `required` and nothing else. The two
// non-required modes are reachable only by naming them, so naming one is the
// whole opt-in — which is why the tests about parsing and heartbeats above set
// one explicitly instead of relying on the host.
func TestWorkerOptionsFromEnvNonRequiredModesStartWithoutNono(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	for _, mode := range []domain.EnforcementMode{domain.EnforcePermissiveDev, domain.EnforceDisabled} {
		t.Run(string(mode), func(t *testing.T) {
			opts, err := workerOptionsFromEnv(env(map[string]string{
				"COMMUNICATION_DATABASE_URL":        "postgres://x",
				"COMMUNICATION_SANDBOX_ENFORCEMENT": string(mode),
				"COMMUNICATION_WORKER_NAME":         "no-nono-worker",
			}))
			if err != nil {
				t.Fatalf("workerOptionsFromEnv(%s): %v", mode, err)
			}
			if opts.sandboxEnforcement != mode {
				t.Errorf("mode = %q, want %q", opts.sandboxEnforcement, mode)
			}
		})
	}

	// And the axis is closed: it is not a free-text field a typo can slide into.
	if _, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://x",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": "probably",
		"COMMUNICATION_WORKER_NAME":         "typo-worker",
	})); err == nil || !strings.Contains(err.Error(), "COMMUNICATION_SANDBOX_ENFORCEMENT") {
		t.Fatalf("workerOptionsFromEnv(unknown mode) error = %v, want a refusal naming the variable", err)
	}
}

func TestRunWorkerRequiresDatabaseURL(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "")

	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runWorker() = %d, want 2", got)
	}
	if want := "COMMUNICATION_DATABASE_URL is not set"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

func TestRunWorkerRejectsBadHeartbeat(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication")
	t.Setenv("COMMUNICATION_SANDBOX_ENFORCEMENT", sandboxMode)
	t.Setenv("COMMUNICATION_WORKER_HEARTBEAT", "1x")

	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runWorker() = %d, want 2 (no connection is attempted for a config error)", got)
	}
	if want := "COMMUNICATION_WORKER_HEARTBEAT"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
}

// TestRunWorkerRequiredRefusesWithoutNono exercises the same refusal through
// the process entrypoint: exit 2 (configuration), nothing started, and the
// message written for the operator.
func TestRunWorkerRequiredRefusesWithoutNono(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@postgres:5432/communication")
	t.Setenv("COMMUNICATION_SANDBOX_ENFORCEMENT", "") // the required default
	t.Setenv("COMMUNICATION_WORKER_NAME", "no-nono-worker")

	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runWorker() = %d, want 2 (a sandbox refusal is a configuration refusal); stderr %q", got, stderr.String())
	}
	if want := "refusing to start"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want nothing (the worker refused before doing anything)", stdout.String())
	}
}

func TestRunWorkerHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runWorker(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runWorker(--help) = %d, want 0", got)
	}
	if want := "usage: communication worker"; !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want substring %q", stdout.String(), want)
	}
}

func TestWorkerSchemaCheck(t *testing.T) {
	ctx := context.Background()
	want := postgres.ExpectedSchemaVersion()

	run := func(got int64, err error) func(context.Context, string) (int64, error) {
		return func(context.Context, string) (int64, error) { return got, err }
	}

	// Current schema: accepted.
	if got, err := workerSchemaCheck(ctx, "postgres://x", run(want, nil)); err != nil || got != want {
		t.Errorf("workerSchemaCheck(current) = (%d, %v), want (%d, nil)", got, err, want)
	}

	// Behind: refuses, and tells the operator how to fix it.
	got, err := workerSchemaCheck(ctx, "postgres://x", run(want-1, nil))
	if err == nil {
		t.Fatal("workerSchemaCheck(behind) error = nil, want a refusal")
	}
	if got != want-1 {
		t.Errorf("workerSchemaCheck(behind) version = %d, want %d", got, want-1)
	}
	for _, phrase := range []string{fmt.Sprintf("version %d is behind", want-1), "communication migrate up"} {
		if !strings.Contains(err.Error(), phrase) {
			t.Errorf("workerSchemaCheck(behind) error = %q, want substring %q", err, phrase)
		}
	}

	// Ahead: accepted (forward-only migrations), but reported back so the
	// caller can warn.
	if got, err := workerSchemaCheck(ctx, "postgres://x", run(want+1, nil)); err != nil || got != want+1 {
		t.Errorf("workerSchemaCheck(ahead) = (%d, %v), want (%d, nil)", got, err, want+1)
	}

	// Unreadable schema version propagates.
	sentinel := errors.New("boom")
	if _, err := workerSchemaCheck(ctx, "postgres://x", run(0, sentinel)); !errors.Is(err, sentinel) {
		t.Errorf("workerSchemaCheck(error) error = %v, want the wrapped store error", err)
	}
}

// TestWorkerCapacityEnv covers the M4 knob: default 1, explicit values 1..16,
// and the CHECK bound named in the refusal (COMMUNICATION_WORKER_CAPACITY;
// M4 contract § 4 step 1, § 6). The number is validated HERE because a
// worker that starts and then dies at its first heartbeat over a 23514 has
// advertised a capability it cannot hold.
func TestWorkerCapacityEnv(t *testing.T) {
	base := map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://x",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
	}
	with := func(kv map[string]string) map[string]string {
		out := map[string]string{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range kv {
			out[k] = v
		}
		return out
	}

	opts, err := workerOptionsFromEnv(env(with(nil)))
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if opts.attemptCapacity != worker.DefaultAttemptCapacity {
		t.Errorf("default capacity = %d, want %d", opts.attemptCapacity, worker.DefaultAttemptCapacity)
	}
	opts, err = workerOptionsFromEnv(env(with(map[string]string{"COMMUNICATION_WORKER_CAPACITY": " 4 "})))
	if err != nil {
		t.Fatalf("capacity 4: %v", err)
	}
	if opts.attemptCapacity != 4 {
		t.Errorf("capacity = %d, want 4", opts.attemptCapacity)
	}
	for _, bad := range []struct{ raw, want string }{
		{"0", "outside 1..16"},
		{"17", "outside 1..16"},
		{"three", "not a number"},
	} {
		if _, err := workerOptionsFromEnv(env(with(map[string]string{"COMMUNICATION_WORKER_CAPACITY": bad.raw}))); err == nil || !strings.Contains(err.Error(), bad.want) {
			t.Errorf("capacity %q error = %v, want substring %q", bad.raw, err, bad.want)
		}
	}
}

// TestNewAgentTurnWiring pins the § 4 agent.acp dispatch's construction: the
// seams are the Postgres implementations, the spawn is the same
// plan-required ACP factory shape the M2 turn loop runs (RequirePlan tracks
// the worker's enforcement mode — with it set, a session whose context
// carries no verified launch plan is refused by the factory rather than
// exec'd unsandboxed, ADR-0019 D6), and the permission verdict comes from the
// per-attempt node policy factory. No real ACP execution is claimed here:
// this asserts wiring, and the adapters stay image-only until the lab proves
// them (§ 7's exit, docs/compatibility/ACP.md).
func TestNewAgentTurnWiring(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	units := &worker.UnitService{} // the zero service: wiring reads fields, never calls

	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": sandboxMode,
	}))
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	turn := newAgentTurn(opts, nil, units, log)
	if turn == nil {
		t.Fatal("newAgentTurn returned nil")
	}
	if turn.Sessions == nil || turn.Profiles == nil || turn.Spawn == nil {
		t.Fatalf("unbound seams: sessions=%v profiles=%v spawn=%v", turn.Sessions, turn.Profiles, turn.Spawn)
	}
	if _, ok := turn.Sessions.(*postgres.AttemptSessions); !ok {
		t.Errorf("Sessions = %T, want *postgres.AttemptSessions", turn.Sessions)
	}
	if _, ok := turn.Profiles.(*postgres.AgentProfiles); !ok {
		t.Errorf("Profiles = %T, want *postgres.AgentProfiles", turn.Profiles)
	}
	factory, ok := turn.Spawn.(*acp.Factory)
	if !ok {
		t.Fatalf("Spawn = %T, want *acp.Factory", turn.Spawn)
	}
	if factory.RequirePlan {
		t.Error("RequirePlan set under permissive-dev: the flag tracks the worker's mode, nothing else")
	}
	opts.sandboxEnforcement = domain.EnforceRequired
	turn = newAgentTurn(opts, nil, units, log)
	factory, _ = turn.Spawn.(*acp.Factory)
	if !factory.RequirePlan {
		t.Error("RequirePlan unset under required mode: an unsandboxed session would be reachable (ADR-0019 D6)")
	}
	if turn.ModePolicy == nil {
		t.Fatal("ModePolicy unbound: prompts would answer without the node policy")
	}
	if v := turn.ModePolicy("deny")(promptWithKind("reject_once")); v.OptionKind != "reject_once" || v.DecidedBy == "" {
		t.Errorf("deny verdict = %+v, want the reject option under a named decider", v)
	}
	if turn.AskModeID == nil || turn.AskModeID("no-such-launcher") != "" {
		t.Error("AskModeID must resolve the registry and yield \"\" for unknown launchers")
	}
	if turn.WorkspaceRoot != opts.workspaceRoot || turn.LauncherHome != opts.sandboxLauncherHome ||
		turn.PolicyDir != opts.policyDir || turn.Enforcement != opts.sandboxEnforcement {
		t.Error("agent turn did not inherit the worker's roots/mode")
	}
	if turn.Checkpoints != nil {
		t.Error("Checkpoints wired: the § 4 step 3 wave owns that seam, and a completed turn must close as infra naming the unbound boundary (procexec's rule, same words)")
	}
}

func promptWithKind(kind string) domain.PermissionPrompt {
	return domain.PermissionPrompt{Options: []domain.PermissionOption{{OptionID: "o1", Kind: kind}}}
}

// TestDecideRunWorkspaceRepoRecording is the run-workspace bug's unit gate: the
// preparer decides whether to write workspace_repos from what the store reports
// about those rows, and the decision takes NO commit-state argument at all —
// Prepare's RunWorkspaceRef.RepoStates is the caller's own input echoed back on
// the arm that created the row, so it is non-empty for every project with a
// repository. Trusting that echo is what skipped RecordRepos and left each run
// workspace 'preparing' with no authorized checkout.
func TestDecideRunWorkspaceRepoRecording(t *testing.T) {
	for _, tc := range []struct {
		name string
		f    workspaceReposFacts
		want runWorkspaceRepoAction
	}{
		{"fresh prepare has no rows yet", workspaceReposFacts{exists: true}, runWorkspaceRepoRecord},
		{"concurrent attempt wrote them", workspaceReposFacts{exists: true, rowsWritten: true, ready: true}, runWorkspaceRepoAlreadyRecorded},
		{"rows without ready still counts as recorded", workspaceReposFacts{exists: true, rowsWritten: true}, runWorkspaceRepoAlreadyRecorded},
		{"already ready", workspaceReposFacts{exists: true, ready: true}, runWorkspaceRepoAlreadyRecorded},
		{"no workspace row at all", workspaceReposFacts{}, runWorkspaceRepoRecord},
	} {
		if got := decideRunWorkspaceRepoRecording(tc.f); got != tc.want {
			t.Errorf("%s: decideRunWorkspaceRepoRecording(%+v) = %v, want %v", tc.name, tc.f, got, tc.want)
		}
	}
}
