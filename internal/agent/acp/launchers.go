package acp

import (
	"fmt"
	"os"
	"strings"
)

// Launcher describes one built-in ACP agent launcher: the executable the
// worker spawns and the pinned adapter it was observed at.
//
// These are M0 built-ins only. The authoritative registry moves to worker
// assets (agent launcher registry YAML) per ADR-0007 in a later milestone;
// this package keeps a minimal copy so `communication doctor` can run the M0
// proof-of-concept before worker assets exist.
//
// The Version field records the exact adapter version that was probed in
// docs/compatibility/ACP.md. It is an observation, not a support claim: a
// launcher listed here is not evidence that the adapter works on the current
// host, and nothing in this file may be cited as "all harnesses supported".
type Launcher struct {
	// ID is the stable launcher identifier used by profiles and CLI flags.
	ID string
	// DisplayName is the human-facing agent/harness name.
	DisplayName string
	// Executable is the program resolved from PATH (no shell).
	Executable string
	// Package is the upstream package that provides Executable.
	Package string
	// Version is the probed adapter version from docs/compatibility/ACP.md.
	Version string
	// Args are passed to Executable verbatim.
	Args []string
	// AskModeID is the session mode that makes this adapter send
	// session/request_permission for human review, observed in
	// docs/compatibility/ACP.md ("Permission modes"). Empty means the
	// launcher has no observed prompting mode, so a profile with
	// permission_mode 'ask' cannot be honoured on it and the worker must
	// fail closed rather than run in the adapter's permissive default.
	AskModeID string
	// AuthEnvVars names the environment variables that tell this adapter
	// *where its credentials live* — CLAUDE_CONFIG_DIR, CODEX_HOME. They are
	// declared here rather than read out of the worker's environment because
	// ADR-0019 D4 requires the launch env to be built from scratch, and
	// because "the credential directory is one of these two" is launcher
	// knowledge that belongs in the registry. A name whose VALUE is the
	// credential (the launcher's ApiKeyEnv or OAuthTokenEnv, ADR-0040/0059)
	// is never enumerated as a location: AuthEnvFor excludes it so no worker
	// stats or grants it and it never lands in the sandbox launcher's argv
	// hop, which nono's audit journal records verbatim.
	//
	// What they cost is recorded, not hidden: whatever these point at is a
	// read-write grant (a harness writes into its own config tree mid-turn),
	// so the tree they name is shared mutable state between every conversation
	// that uses this launcher. ADR-0019 Decision 4 owns that consequence and
	// says this record may not be cited as evidence of credential isolation.
	AuthEnvVars []string
	// OAuthTokenEnv, when set, is the environment variable this agent reads a
	// long-lived headless credential from (Claude Code's `claude setup-token`
	// value, ADR-0040). OAuthTokenFileEnv names the operator environment
	// variable holding the PATH to a file with the token, and OAuthTokenPrefix
	// is the value's required prefix (fail-closed validation). Empty means the
	// launcher authenticates through its AuthEnvVars directories only.
	//
	// Delivery rule (ADR-0040): the value is delivered through the sandbox
	// launcher's process environment (nono inherits its own environment into
	// the child) or, unsandboxed, through the child's exec environment —
	// never through argv, the `env NAME=value` hop, a log line, or a journal
	// entry, because nono's audit journal records the argv verbatim.
	OAuthTokenEnv     string
	OAuthTokenFileEnv string
	OAuthTokenPrefix  string
	// ApiKeyEnv names the launch-environment variable the per-turn API key is
	// delivered under (ADR-0040 delivery rule: env only — never argv, never a
	// journalled file). Empty means the launcher takes its key through its
	// AuthEnvVars instead.
	ApiKeyEnv string
	// ApiKeyFileEnv names the operator environment variable holding the PATH
	// to a file with the API key; the worker resolves it at each launch, so a
	// rotated Secret takes effect without a worker restart. Empty means the
	// launcher takes its key from the launch environment as-is.
	ApiKeyFileEnv string
	// ApiKeyPrefix is the required value prefix for a usable API key
	// (fail-closed); empty disables the prefix check.
	ApiKeyPrefix string
	// ApiBaseURL names the operator environment variable holding the per-turn
	// provider base URL written into the agent-home pi models.json ("" writes no
	// per-turn provider config).
	ApiBaseURL string
	// ApiModel names the operator environment variable holding the per-turn
	// provider model id written into the agent-home pi models.json ("" writes no
	// per-turn provider config).
	ApiModel string
	// Notes records observed caveats; never a capability guarantee.
	Notes string
}

// knownLaunchers are the M0 built-ins, taken from the rows probed in
// docs/compatibility/ACP.md (date 2026-10-14).
var knownLaunchers = []Launcher{
	{
		ID:          "claude",
		DisplayName: "Claude Code ACP adapter",
		Executable:  "claude-agent-acp",
		Package:     "@agentclientprotocol/claude-agent-acp",
		Version:     "0.90.0",
		AskModeID:   "default",
		AuthEnvVars: []string{"CLAUDE_CONFIG_DIR"},
		// ADR-0040: long-lived headless credential. The operator mounts a
		// Secret key at COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE; the worker reads
		// it at each launch and hands it to the agent as
		// CLAUDE_CODE_OAUTH_TOKEN without ever putting it in argv.
		OAuthTokenEnv:     "CLAUDE_CODE_OAUTH_TOKEN",
		OAuthTokenFileEnv: "COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE",
		OAuthTokenPrefix:  "sk-ant-oat",
		Notes: "probed at protocolVersion 1 with loadSession advertised; auth rides the " +
			"ambient claude CLI login; adapter default mode auto never sends " +
			"session/request_permission (docs/compatibility/ACP.md)",
	},
	{
		ID:          "codex",
		DisplayName: "Codex ACP adapter",
		Executable:  "codex-acp",
		Package:     "@agentclientprotocol/codex-acp",
		Version:     "2.2.2",
		AskModeID:   "read-only",
		AuthEnvVars: []string{"CODEX_HOME"},
		Notes: "probed at protocolVersion 1 with loadSession advertised; auth rode the " +
			"existing codex-cli login; adapter default mode agent never sends " +
			"session/request_permission (docs/compatibility/ACP.md)",
	},
	{
		// pi — ACP today runs through the community `pi-acp` adapter, which
		// spawns `pi --mode rpc` and bridges ACP JSON-RPC 2.0 over stdio to pi's
		// own JSONL RPC dialect; the native `pi --mode acp` mode does not exist in
		// any released pi (installed 1.1.0, npm latest 1.4.0, upstream main all
		// validate `--mode` against text|json|rpc — PRs #241/#836 proposing ACP
		// were closed unmerged and the changelog never mentions ACP). The adapter
		// entry point is therefore the executable this launcher names.
		ID:          "pi",
		DisplayName: "Pi Coding Agent",
		Executable:  "pi-acp",
		Package:     "pi-acp",
		Version:     "0.0.34",
		// No observed prompting mode yet (no permission round-trip run against
		// the adapter): fail closed per ADR-0019 D6 rather than run in a
		// permissive default.
		AskModeID:     "",
		AuthEnvVars:   []string{"OPENAI_API_KEY"},
		ApiKeyEnv:     "OPENAI_API_KEY",
		ApiKeyFileEnv: "COMMUNICATION_PI_API_KEY_FILE",
		ApiKeyPrefix:  "",
		ApiBaseURL:    "COMMUNICATION_PI_BASE_URL",
		ApiModel:      "COMMUNICATION_PI_MODEL",
		Notes:         "ACP adapter pi-acp@0.0.34 spawns `pi --mode rpc`; pi native ACP mode not shipped. Auth: OpenAI-compatible provider key from COMMUNICATION_PI_API_KEY_FILE via OPENAI_API_KEY; per-turn provider config from COMMUNICATION_PI_BASE_URL + COMMUNICATION_PI_MODEL written into the agent home models.json.",
	},
}

// KnownLaunchers returns the built-in M0 launcher entries in report order.
// The result is a copy; callers may not mutate the registry.
func KnownLaunchers() []Launcher {
	return append([]Launcher(nil), knownLaunchers...)
}

// LookupLauncher resolves a launcher id (e.g. "claude"). ok is false for an
// unknown id.
func LookupLauncher(id string) (Launcher, bool) {
	for _, l := range knownLaunchers {
		if l.ID == id {
			return l, true
		}
	}
	return Launcher{}, false
}

// OAuthTokenFile returns the configured long-lived token file for this
// launcher, or "" when the launcher uses no token file or none is configured.
func (l Launcher) OAuthTokenFile() string {
	if l.OAuthTokenEnv == "" {
		return ""
	}
	return strings.TrimSpace(os.Getenv(l.OAuthTokenFileEnv))
}

// OAuthTokenKV loads the launcher's long-lived authentication token from the
// operator-configured file at launch time (a rotated Secret file takes effect
// without a worker restart) and returns it as one "NAME=value" entry, or ""
// and nil when the launcher uses no token or none is configured.
//
// ADR-0040: a misconfigured file fails the launch closed. Every error message
// names the file and the fault and never the value — these errors are
// journalled into attempt detail, where a token must never appear.
func (l Launcher) OAuthTokenKV() (string, error) {
	if l.OAuthTokenEnv == "" {
		return "", nil
	}
	file := l.OAuthTokenFile()
	if file == "" {
		return "", nil
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("agent %s: %s is set to %s but the file cannot be read: %v", l.ID, l.OAuthTokenFileEnv, file, err)
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return "", fmt.Errorf("agent %s: %s is set to %s but the file is empty", l.ID, l.OAuthTokenFileEnv, file)
	}
	if !strings.HasPrefix(tok, l.OAuthTokenPrefix) {
		return "", fmt.Errorf("agent %s: %s (file %s) does not hold a usable token: the value must start with %q — value not shown", l.ID, l.OAuthTokenEnv, file, l.OAuthTokenPrefix)
	}
	return l.OAuthTokenEnv + "=" + tok, nil
}

// ApiKeyFile returns the configured API-key file path for this launcher, or
// "" when the launcher takes its API key from the launch environment directly.
func (l Launcher) ApiKeyFile() string {
	return strings.TrimSpace(os.Getenv(l.ApiKeyFileEnv))
}

// ApiKeyKV resolves this launcher's per-turn API key from the operator-configured
// file (the launcher's ApiKeyFileEnv, e.g. COMMUNICATION_PI_API_KEY_FILE) and
// returns it as one "NAME=value" launch-environment entry, or "" and nil when
// the launcher takes no API key or none is configured.
//
// ADR-0040 (delivery rule, mirrored for API keys): the value is delivered through
// the sandbox launcher's process environment (nono inherits its own environment
// into the child) or, unsandboxed, through the child's exec environment — never
// through argv, the `env NAME=value` hop, a log line, or a journal entry, because
// the audit journal records argv verbatim. Errors name the file and the fault and
// never the value — these errors are journalled into attempt detail, where a key
// must never appear.
func (l Launcher) ApiKeyKV() (string, error) {
	if l.ApiKeyFileEnv == "" {
		return "", nil
	}
	file := l.ApiKeyFile()
	if file == "" {
		return "", nil
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("agent %s: %s is set to %s but the file cannot be read: %v", l.ID, l.ApiKeyFileEnv, file, err)
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return "", fmt.Errorf("agent %s: %s is set to %s but the file is empty", l.ID, l.ApiKeyFileEnv, file)
	}
	if l.ApiKeyPrefix != "" && !strings.HasPrefix(tok, l.ApiKeyPrefix) {
		return "", fmt.Errorf("agent %s: %s (file %s) does not hold a usable key: the value must start with %q — value not shown", l.ID, l.ApiKeyEnv, file, l.ApiKeyPrefix)
	}
	return l.ApiKeyEnv + "=" + tok, nil
}

// ApiModelsJSON renders the per-turn provider config (models.json-style) for
// the launcher's configured provider — base URL + model — or "" when the
// launcher writes no per-turn provider config. The API key itself is referenced
// by environment-variable interpolation in the rendered document, so the key
// never lands in a file the worker or the journal can see.
func (l Launcher) ApiModelsJSON() string {
	baseURL := strings.TrimSpace(os.Getenv(l.ApiBaseURL))
	model := strings.TrimSpace(os.Getenv(l.ApiModel))
	if baseURL == "" || model == "" {
		return ""
	}
	return fmt.Sprintf(`{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "pi-collective": {
      "name": "Pi Collective",
      "baseUrl": %q,
      "api": "openai-completions",
      "apiKey": "$%s",
      "models": [
        { "id": %q }
      ]
    }
  }
}
`, baseURL, l.ApiKeyEnv, model)
}
