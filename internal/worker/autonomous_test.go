package worker

// ADR-0069 gating tests: `autonomous_within_sandbox` is the never-asks
// launcher's (pi's) only honest mode — it launches WITHOUT a prompting mode
// but ONLY under `required` enforcement — while `ask`/`deny`/
// `preapproved_within_sandbox` stay fail-closed on launcher pi. Also pins
// P5 on this path: the attempt's agent home carries models.json + the
// settings pin (base URL + model, no key), and the key rides the launch
// plan's process environment, never the argv `env` hop (ADR-0040).

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

// piProfile moves the fixture's pinned profile onto launcher pi with a mode.
func (f *agentTurnFixture) piProfile(mode string) {
	prof := f.turn.Profiles.(*profilesStub)
	prof.mu.Lock()
	prof.prof = AgentProfile{AgentProfileID: "pi-implementer", LauncherID: "pi", PermissionMode: mode}
	prof.mu.Unlock()
}

func (f *agentTurnFixture) profileMode(mode string) {
	prof := f.turn.Profiles.(*profilesStub)
	prof.mu.Lock()
	prof.prof.PermissionMode = mode
	prof.mu.Unlock()
}

// TestAgentTurnPiAutonomousRunsUnderRequired proves the positive arm: pi +
// autonomous_within_sandbox under `required` reaches the verified launch —
// with NO prompting mode (modeID "" is the mode's claim, not a bug), the
// provider config in the attempt home, and the key in the process
// environment only (never the argv hop the audit journal records verbatim).
func TestAgentTurnPiAutonomousRunsUnderRequired(t *testing.T) {
	t.Setenv("COMMUNICATION_PI_BASE_URL", "https://llm-collective.e-gineering.com/v1")
	t.Setenv("COMMUNICATION_PI_MODEL", "david-birks/qwen3-8-27b")
	keyFile := filepath.Join(t.TempDir(), "llm-api-key")
	const keyValue = "sk-Pi-Autonomous-Test-Key-Never-Argv"
	if err := os.WriteFile(keyFile, []byte(keyValue+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COMMUNICATION_PI_API_KEY_FILE", keyFile)

	f := newAgentTurnFixture(t, domain.EnforceRequired)
	f.turn.Sandbox = &recordingSandbox{}
	f.turn.SandboxPath = "/usr/local/bin/nono"
	f.piProfile("autonomous_within_sandbox")
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded (pi + autonomous under required runs)", res)
	}
	if got := f.spawn.lastReq().ModeID; got != "" {
		t.Errorf("ModeID = %q, want empty: autonomous runs the never-asks default on purpose (ADR-0069)", got)
	}
	if f.turn.Sandbox.(*recordingSandbox).calls() != 1 {
		t.Error("the sandbox verification must still gate the launch (no verify, no spawn)")
	}

	// P5: the attempt's own agent home carries the provider config.
	models := filepath.Join(f.layout.Home, "attempts", fakeAttemptID, ".pi", "agent", "models.json")
	raw, err := os.ReadFile(models)
	if err != nil {
		t.Fatalf("the attempt home carries no models.json (P5): %v", err)
	}
	body := string(raw)
	if !strings.Contains(body, "llm-collective.e-gineering.com") || !strings.Contains(body, "david-birks/qwen3-8-27b") {
		t.Errorf("models.json misses base URL or model:\n%s", body)
	}
	if strings.Contains(body, keyValue) {
		t.Error("the API key VALUE landed in models.json — ADR-0040/0059 violation")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(models), "settings.json")); err != nil {
		t.Errorf("no settings.json provider pin: pi would default to api.openai.com: %v", err)
	}

	// The key rides the launch process environment (ADR-0040's channel) and
	// never the adapter argv `env` hop.
	plan, ok := f.spawn.lastCtxPlan()
	if !ok {
		t.Fatal("spawn received no verified launch plan")
	}
	if !containsExact(plan.Env, "OPENAI_API_KEY="+keyValue) {
		t.Errorf("plan.Env lacks the API key entry: %v", plan.Env)
	}
	argv, argvErr := f.turn.Sandbox.(*recordingSandbox).lastArgv()
	if argvErr != nil {
		t.Fatalf("BuildLaunchArgv: %v", argvErr)
	}
	if strings.Contains(strings.Join(argv, " "), keyValue) {
		t.Error("the key value entered the launch argv — nono's audit journal records argv verbatim")
	}
}

// TestAgentTurnPiAutonomousRefusesWithoutRequiredSandbox pins the honest
// half of the claim: without `required` enforcement there is no boundary, so
// the attempt is refused before anything is verified or spawned.
func TestAgentTurnPiAutonomousRefusesWithoutRequiredSandbox(t *testing.T) {
	for _, mode := range []domain.EnforcementMode{domain.EnforcePermissiveDev, domain.EnforceDisabled} {
		f := newAgentTurnFixture(t, mode)
		f.piProfile("autonomous_within_sandbox")
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "autonomous_within_sandbox") ||
			!strings.Contains(res.Detail, "required") {
			t.Errorf("%s: res = %+v, want the ADR-0069 refusal naming the mode and required", mode, res)
		}
		if f.spawn.calls() != 0 {
			t.Errorf("%s: spawned %d sessions on the refused arm", mode, f.spawn.calls())
		}
	}
}

// TestAgentTurnPiPromptingModesStayFailClosed keeps the old honesty: the
// prompting modes refuse on launcher pi at ANY enforcement level —
// ADR-0069 gave pi a mode of its own, it did not unlock review claims.
func TestAgentTurnPiPromptingModesStayFailClosed(t *testing.T) {
	for _, mode := range []string{"ask", "deny", "preapproved_within_sandbox"} {
		f := newAgentTurnFixture(t, domain.EnforceRequired)
		f.turn.Sandbox = &recordingSandbox{}
		f.turn.SandboxPath = "/usr/local/bin/nono"
		f.piProfile(mode)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "prompting mode") {
			t.Errorf("%s: res = %+v, want the fail-closed prompting refusal (docs/compatibility/ACP.md)", mode, res)
		}
		if f.spawn.calls() != 0 {
			t.Errorf("%s: spawned %d sessions on the refused arm", mode, f.spawn.calls())
		}
	}
}

// TestAgentTurnClaudeAutonomousStillRequiresThePromptingArmsUntouched guards
// that the switch edit changed nothing for a prompting-capable launcher: a
// claude profile still asks the registry for its prompting mode on the
// prompting modes, and autonomous remains launcher-agnostic (it launches
// without a mode by design; the sandbox, not the launcher, is the claim).
func TestAgentTurnAutonomousLaunchesWithoutPromptingModeForAnyLauncher(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	f.turn.Sandbox = &recordingSandbox{}
	f.turn.SandboxPath = "/usr/local/bin/nono"
	f.profileMode("autonomous_within_sandbox") // fixture launcher is claude
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v", res)
	}
	if got := f.spawn.lastReq().ModeID; got != "" {
		t.Errorf("ModeID = %q, want empty under autonomous for any launcher", got)
	}
}

func containsExact(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}

// TestPolicyOptionKindsAutonomous pins the defensive conversation arm: if a
// prompt arrives under autonomous_within_sandbox, the mode answers with an
// allow option (decided_by_policy names the MODE, never a person — the
// boundary claim stays the sandbox's). deny/preapproved are unchanged; `ask`
// and unknown modes reach no policy kinds at all (a human owns ask; an
// unknown mode falls to the honest cancelled close).
func TestPolicyOptionKindsAutonomous(t *testing.T) {
	allow := []string{"allow_once", "allow_always"}
	cases := map[string][]string{
		"deny":                       {"reject_once", "reject_always"},
		"preapproved_within_sandbox": allow,
		"autonomous_within_sandbox":  allow,
		"ask":                        nil,
		"yolo":                       nil,
	}
	for mode, want := range cases {
		got := policyOptionKinds(mode)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("policyOptionKinds(%q) = %v, want %v", mode, got, want)
		}
	}
}
