package worker

import (
	"path/filepath"
	"strings"
)

// GitHub push / draft-PR delivery (ADR-0045) on top of the ADR-0040 delivery
// rule: a secret value must reach the agent process through an environment, never
// through the `-- env NAME=value …` argv hop that nono's audit journal records
// verbatim.
//
// ADR-0045 makes an agent whose profile is authorized for a GitHub token able to
// push a branch and open a draft PR. The token arrives through the existing
// SecretRef materialization path (ADR-0018): a secret whose
// `allowed_agent_profile_ids` names the attempt's / turn's profile, delivered
// under the mount's env name. What that path does not do yet is name the token
// for the two environment variables GitHub tooling reads (`GH_TOKEN` /
// `GITHUB_TOKEN`) and does not wire git to the token it just delivered.
//
// Delivery channel (ADR-0040, made structural by this file's execEnv/argvBoundEnv):
// the GitHub token and every other env-delivered secret mount ride the launched
// process's environment (execEnv), never an argv entry the launcher's `env` hop
// renders (argvBoundEnv strips the delivered names from that copy).

var githubTokenEnvNames = []string{"GH_TOKEN", "GITHUB_TOKEN"}

// gitCredentialHelperKey is the git config key naming the credential helper
// that reads a GitHub token from the environment.
const gitCredentialHelperKey = "credential.https://github.com.helper"

// GitPushEnv returns the launch-environment entries that deliver a
// profile-authorized GitHub token and wire git to it: the token under both
// accepted names (GH_TOKEN and GITHUB_TOKEN) and the GIT_CONFIG_* credential
// helper entries that read the token from the environment.
//
// It returns nil when no delivered entry names a GitHub token, so an attempt
// whose profile was never granted one widens nothing. The caller decides where
// the returned entries land — the process environment of the agent (and, through
// it, of the git child processes the agent spawns) — and keeps them out of any
// argv.
func GitPushEnv(delivered []string) []string {
	token := ""
	for _, kv := range delivered {
		name, value, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		for _, n := range githubTokenEnvNames {
			if name == n && value != "" {
				token = value
			}
		}
	}
	if token == "" {
		return nil
	}
	out := make([]string, 0, len(githubTokenEnvNames)+3)
	for _, n := range githubTokenEnvNames {
		out = append(out, n+"="+token)
	}
	out = append(out,
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0="+gitCredentialHelperKey,
		"GIT_CONFIG_VALUE_0=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f",
	)
	return out
}

// GitPushToolEnv returns the GitHub CLI (gh) launch-environment entries that a
// sandboxed agent turn holding a GitHub token needs in order to open a draft PR
// (ADR-0045, follow-up to its 2026-10-20 decision: the product owner decided
// 2026-10-22 to make `gh` part of the worker image so agents can open draft PRs;
// the token machinery itself is ADR-0045's).
//
// The entries are the writable config dir under the agent's HOME — the sandbox
// HOME is the one tree the agent-home grant covers — plus the flags that keep the
// CLI out of interactive prompts and update notifications:
//
//	GH_CONFIG_DIR=<home>/.config/gh   gh writes its config/state here
//	GH_PROMPT_DISABLED=1               no interactive `gh auth login` prompt path
//	GH_NO_UPDATE_NOTIFIER=1           no update check / notifier noise
//
// They travel through the same exec-environment channel GitPushEnv's token wiring
// uses (execEnv into the launch env; the sandboxed path folds them into the
// launcher's process environment that nono passes to the exec'd `env` binary), so
// a config dir or a flag can never reach the launch argv the audit journal
// records verbatim (ADR-0040).
//
// The caller folds this in only when GitPushEnv produced a token block for the
// delivered set, so an attempt whose profile was never granted a GitHub token
// gets no gh configuration at all — the CLI is only ever configured by the same
// authorization that authorized the token.
func GitPushToolEnv(home string) []string {
	if strings.TrimSpace(home) == "" {
		return nil
	}
	return []string{
		"GH_CONFIG_DIR=" + filepath.Join(home, ".config", "gh"),
		"GH_PROMPT_DISABLED=1",
		"GH_NO_UPDATE_NOTIFIER=1",
	}
}

// execEnv folds the launcher's own process environment and the additions that
// deliver launch-time state — the launcher's long-lived token, the GitHub push
// wiring derived from the delivered secret entries, and the delivered secret
// entries themselves — into the one process environment of the launched process.
// Later additions win per name (ADR-0018 D4: an authorized mount outranks launcher
// env, which is why it is applied last) and each name appears once, with the
// winning value (ADR-0040's execve caveat: duplicate names in envp are
// program-dependent, so the mount's value has to be the single one). The result
// is environment only: it is never rendered into argv, because the channel that
// carries a secret value is the launched process's environment.
func execEnv(base []string, additions ...[]string) []string {
	byName := map[string]string{}
	var order []string
	add := func(kv string) {
		name, value, ok := strings.Cut(kv, "=")
		if !ok || value == "" {
			return
		}
		if _, seen := byName[name]; !seen {
			order = append(order, name)
		}
		byName[name] = value
	}
	for _, kv := range base {
		add(kv)
	}
	for _, list := range additions {
		for _, kv := range list {
			add(kv)
		}
	}
	out := make([]string, 0, len(order))
	for _, name := range order {
		out = append(out, name+"="+byName[name])
	}
	return out
}

// argvBoundEnv renders a from-scratch launch environment for the launcher's
// `env NAME=value …` argv hop: the same entries minus the delivered secret
// entries, which reach the launched process through the exec environment instead
// (the plan's Env / the exec env). The subtraction is driven by the delivered set,
// not by a hardcoded credential-name list: whatever a secret mount delivered
// rides the exec channel from here on, and nothing about a secret's name puts it
// on the argv hop that the audit journal records verbatim (ADR-0040).
func argvBoundEnv(execEnv []string, delivered []string) []string {
	drop := map[string]bool{}
	for _, kv := range delivered {
		if name, _, ok := strings.Cut(kv, "="); ok {
			drop[name] = true
		}
	}
	out := make([]string, 0, len(execEnv))
	for _, kv := range execEnv {
		if name, _, ok := strings.Cut(kv, "="); ok && drop[name] {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// hostAllowed reports whether an egress allowlist (normalized hostnames or
// `*.domain` wildcards) admits one host.
func hostAllowed(hosts []string, host string) bool {
	for _, h := range hosts {
		if h == host || h == "*."+host {
			return true
		}
	}
	return false
}
