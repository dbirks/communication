package main

import (
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/sandbox/k8s"
	"github.com/dbirks/communication/internal/worker"
)

// ADR-0082 §8's selection is a switch on one variable, and the risk in a switch
// like that is the default case quietly changing shape. These tests pin it: unset
// means the ACP runtime gets exactly the Transporter it got before Kubernetes
// mode existed (nil, which means ProcTransporter), and `kubernetes` cannot be
// half-configured into a working launcher.

type stubTransporter struct{ acp.Transporter }

func TestLauncherTransporterDefaultsToLocal(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
	}))
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	for name, getenv := range map[string]func(string) string{
		"unset":  env(map[string]string{"COMMUNICATION_WORKER_LAUNCHER": ""}),
		"local":  env(map[string]string{"COMMUNICATION_WORKER_LAUNCHER": "local"}),
		" Local": env(map[string]string{"COMMUNICATION_WORKER_LAUNCHER": " Local "}),
	} {
		tr, err := launcherTransporter(opts, getenv, log)
		if err != nil {
			t.Errorf("%s: launcherTransporter: %v", name, err)
			continue
		}
		if tr != nil {
			t.Errorf("%s: launcherTransporter returned %T, want nil (nil is ProcTransporter, today's behaviour)", name, tr)
		}
	}
	if _, err := launcherTransporter(opts, env(map[string]string{"COMMUNICATION_WORKER_LAUNCHER": "pod"}), log); err == nil {
		t.Error("an unknown launcher name must be refused, not treated as local")
	}
}

func TestLauncherTransporterKubernetesRequiresItsConfig(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
	}))
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	// A pod launcher with no namespace/image/node cannot place an attempt pod, and
	// must refuse rather than fall back to execs this worker would not report.
	_, err = launcherTransporter(opts, env(map[string]string{"COMMUNICATION_WORKER_LAUNCHER": "kubernetes"}), log)
	if err == nil {
		t.Fatal("a kubernetes launcher with no configuration started")
	}
	for _, want := range []string{"COMMUNICATION_AGENT_NAMESPACE", "COMMUNICATION_AGENT_POD_IMAGE", "COMMUNICATION_AGENT_POD_NODE"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name the missing %s", err, want)
		}
	}

	cfgEnv := map[string]string{
		"COMMUNICATION_WORKER_LAUNCHER":     "kubernetes",
		"COMMUNICATION_AGENT_NAMESPACE":     "communication-agents",
		"COMMUNICATION_AGENT_POD_IMAGE":     "ghcr.io/dbirks/communication-worker:0.9.0",
		"COMMUNICATION_AGENT_POD_NODE":      "talos-agent-1",
		"COMMUNICATION_AGENT_WORKSPACE_PVC": "communication-workspaces",
	}
	cfg, err := agentPodConfig(opts, env(cfgEnv))
	if err != nil {
		t.Fatalf("agentPodConfig: %v", err)
	}
	// The claim carries what the plan writes through; the sandbox directories do
	// not travel (probe C-H1's refusal is sticky and per-pod).
	want := []string{opts.workspaceRoot, opts.reposRoot, opts.policyDir}
	if !reflect.DeepEqual(cfg.ClaimPaths, want) {
		t.Errorf("claim paths = %v, want the worker's roots %v", cfg.ClaimPaths, want)
	}
	if cfg.Claim != "communication-workspaces" || cfg.Namespace != "communication-agents" || cfg.NodeName != "talos-agent-1" {
		t.Errorf("config = %+v", cfg)
	}
	if cfg.SandboxHome != opts.sandboxLauncherHome || cfg.SandboxSelfTest != opts.sandboxSelfTest {
		t.Errorf("sandbox dirs = %q/%q, want the worker's %q/%q", cfg.SandboxHome, cfg.SandboxSelfTest, opts.sandboxLauncherHome, opts.sandboxSelfTest)
	}
	// The same config reaches the API server only through an in-cluster identity.
	// Off-cluster (this test) that is a refusal with the reason in its name, not a
	// fallback to local execs.
	if _, err := launcherTransporter(opts, env(cfgEnv), log); err == nil {
		t.Fatal("a kubernetes launcher built off-cluster reported success")
	} else if !strings.Contains(err.Error(), "in-cluster") {
		t.Errorf("error %q does not say why pod mode is unavailable", err)
	}
}

func TestAgentTurnRuntimeCarriesTheSelectedTransporter(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	units := &worker.UnitService{}
	opts, err := workerOptionsFromEnv(env(map[string]string{
		"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
		"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
	}))
	if err != nil {
		t.Fatalf("options: %v", err)
	}

	// Default: the field is nil, so acp.Runtime falls back to ProcTransporter —
	// the behaviour every existing worker test depends on.
	turn := newAgentTurn(opts, nil, units, log)
	factory, ok := turn.Spawn.(*acp.Factory)
	if !ok {
		t.Fatalf("Spawn = %T, want *acp.Factory", turn.Spawn)
	}
	if factory.Runtime == nil {
		t.Fatal("the agent.acp runtime is unbound")
	}
	if factory.Runtime.Transporter != nil {
		t.Errorf("default Runtime.Transporter = %T, want nil", factory.Runtime.Transporter)
	}
	if _, ok := factory.Runtime.Transporter.(*k8s.PodTransporter); ok {
		t.Error("the default worker selected a pod transporter")
	}

	// Pod mode: the one transporter the worker resolved at startup is what both
	// session paths launch through — a second runtime that forgot the wiring would
	// run agent attempts locally while the first put them in pods.
	stub := &stubTransporter{}
	opts.agentTransporter = stub
	podTurn := newAgentTurn(opts, nil, units, log)
	podFactory, ok := podTurn.Spawn.(*acp.Factory)
	if !ok {
		t.Fatalf("Spawn = %T, want *acp.Factory", podTurn.Spawn)
	}
	if podFactory.Runtime.Transporter != acp.Transporter(stub) {
		t.Errorf("agent.acp Runtime.Transporter = %v, want the resolved launcher", podFactory.Runtime.Transporter)
	}
}
