package acp

// ADR-0059 gap P5 closed (ADR-0069): the per-turn provider config the pi
// launcher documents must actually reach the agent home, and the API key must
// NOT — the file references it by $OPENAI_API_KEY environment interpolation
// only (ADR-0040's channel is the launch process environment). These tests
// pin the rendered bytes, the settings pin (measured load-bearing: pi without
// defaultProvider/defaultModel resolves to the ambient openai provider), the
// merge rules, and the fail-closed shapes.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	providerTestBase  = "https://llm-collective.e-gineering.com/v1"
	providerTestModel = "david-birks/qwen3-8-27b"
	// providerTestKey is a value that must appear NOWHERE on disk.
	providerTestKey = "sk-ColLeCtIvE-Must-Never-Land-In-A-File"
)

func piProviderEnv(t *testing.T) {
	t.Helper()
	t.Setenv("COMMUNICATION_PI_BASE_URL", providerTestBase)
	t.Setenv("COMMUNICATION_PI_MODEL", providerTestModel)
	t.Setenv("OPENAI_API_KEY", providerTestKey)
}

func TestPiWriteProviderConfigDeliversBaseAndModelWithoutTheKey(t *testing.T) {
	piProviderEnv(t)
	l, ok := LookupLauncher("pi")
	if !ok {
		t.Fatal("launcher pi is not registered")
	}
	home := t.TempDir()
	path, err := l.WriteProviderConfig(home)
	if err != nil {
		t.Fatalf("WriteProviderConfig: %v", err)
	}
	if want := filepath.Join(home, ".pi", "agent", "models.json"); path != want {
		t.Fatalf("models path = %q, want %q", path, want)
	}

	rawModels, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read models.json: %v", err)
	}
	models := string(rawModels)
	if !strings.Contains(models, providerTestBase) {
		t.Errorf("models.json carries no base URL:\n%s", models)
	}
	if !strings.Contains(models, providerTestModel) {
		t.Errorf("models.json carries no model id:\n%s", models)
	}
	// The key is referenced by environment interpolation only.
	var doc struct {
		Providers map[string]struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
			Models  []struct {
				ID string `json:"id"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rawModels, &doc); err != nil {
		t.Fatalf("models.json is not valid JSON: %v\n%s", err, models)
	}
	p, ok := doc.Providers["pi-collective"]
	if !ok {
		t.Fatalf("models.json registers no pi-collective provider:\n%s", models)
	}
	if p.BaseURL != providerTestBase {
		t.Errorf("baseUrl = %q, want %q", p.BaseURL, providerTestBase)
	}
	if p.APIKey != "$OPENAI_API_KEY" {
		t.Errorf("apiKey = %q, want the $OPENAI_API_KEY interpolation, never a value", p.APIKey)
	}
	if len(p.Models) != 1 || p.Models[0].ID != providerTestModel {
		t.Errorf("models = %+v, want the one configured id", p.Models)
	}

	// The settings pin is what makes pi START on that provider (host
	// observation 2026-10-24: without it pi resolves to the ambient openai
	// provider and reaches api.openai.com instead of the configured base).
	rawSettings, err := os.ReadFile(filepath.Join(home, ".pi", "agent", "settings.json"))
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	var settings map[string]any
	if err := json.Unmarshal(rawSettings, &settings); err != nil {
		t.Fatalf("settings.json is not valid JSON: %v", err)
	}
	if settings["defaultProvider"] != "pi-collective" {
		t.Errorf("defaultProvider = %v, want pi-collective", settings["defaultProvider"])
	}
	if settings["defaultModel"] != providerTestModel {
		t.Errorf("defaultModel = %v, want %q", settings["defaultModel"], providerTestModel)
	}

	// The whole agent home, walked: the key value appears in no file.
	filepath.WalkDir(home, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		if strings.Contains(string(b), providerTestKey) {
			t.Errorf("%s carries the API key value — ADR-0040/0059 violation", p)
		}
		return nil
	})
}

func TestPiWriteProviderConfigUnsetWritesNothing(t *testing.T) {
	t.Setenv("COMMUNICATION_PI_BASE_URL", "")
	t.Setenv("COMMUNICATION_PI_MODEL", "")
	l, _ := LookupLauncher("pi")
	home := t.TempDir()
	path, err := l.WriteProviderConfig(home)
	if err != nil || path != "" {
		t.Fatalf("unset provider env = (%q, %v), want the documented no-provider-config pass", path, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".pi")); !os.IsNotExist(err) {
		t.Errorf("no provider config configured, yet .pi exists under the agent home: %v", err)
	}
}

func TestPiWriteProviderConfigPartialEnvFailsClosed(t *testing.T) {
	t.Setenv("COMMUNICATION_PI_BASE_URL", providerTestBase)
	t.Setenv("COMMUNICATION_PI_MODEL", "")
	l, _ := LookupLauncher("pi")
	if _, err := l.WriteProviderConfig(t.TempDir()); err == nil {
		t.Fatal("a base URL with no model must fail closed, not launch pi onto the ambient provider")
	}
}

func TestPiWriteProviderConfigMergesAndNeverClobbers(t *testing.T) {
	piProviderEnv(t)
	l, _ := LookupLauncher("pi")
	home := t.TempDir()
	dir := filepath.Join(home, ".pi", "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// An apm-staged settings.json keeps its own keys; the provider pin joins.
	if err := os.WriteFile(filepath.Join(dir, "settings.json"),
		[]byte(`{"theme":"dark","defaultProvider":"someone-else"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.WriteProviderConfig(home); err != nil {
		t.Fatalf("merge write: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("settings.json not JSON after merge: %v", err)
	}
	if settings["theme"] != "dark" {
		t.Errorf("merge destroyed an unrelated key: %s", raw)
	}
	if settings["defaultProvider"] != "pi-collective" {
		t.Errorf("the worker's provider pin did not win: %s", raw)
	}

	// A file that is not a JSON object is a refusal, never an overwrite.
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.WriteProviderConfig(home); err == nil {
		t.Fatal("unparseable models.json must refuse the launch, not be clobbered")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "models.json")); string(b) != "not json" {
		t.Errorf("the refused-over file was modified anyway: %s", b)
	}
}

func TestNonProviderLaunchersWriteNoProviderConfig(t *testing.T) {
	for _, id := range []string{"claude", "codex"} {
		l, ok := LookupLauncher(id)
		if !ok {
			t.Fatalf("launcher %s missing", id)
		}
		piProviderEnv(t) // even with pi's env set, other launchers write nothing
		home := t.TempDir()
		path, err := l.WriteProviderConfig(home)
		if err != nil || path != "" {
			t.Errorf("%s: WriteProviderConfig = (%q, %v), want the no-config pass", id, path, err)
		}
		entries, _ := os.ReadDir(home)
		if len(entries) != 0 {
			t.Errorf("%s wrote into the agent home: %v", id, entries)
		}
	}
}

func TestProviderEgressHostDerivesFromTheConfiguredBaseURL(t *testing.T) {
	piProviderEnv(t)
	l, _ := LookupLauncher("pi")
	if l.AgentConfigDir != ".pi/agent" {
		t.Fatalf("pi AgentConfigDir = %q, want .pi/agent (pi's documented agent dir under HOME)", l.AgentConfigDir)
	}
	if got := l.ApiModelsJSON(); got == "" {
		t.Fatal("ApiModelsJSON renders nothing with both env vars set")
	}
}
