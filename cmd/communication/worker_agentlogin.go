package main

// ADR-0085: the worker's in-app sign-in drivers. A driver is registered only
// when this worker can actually run that sign-in against a credential volume:
// Codex needs CODEX_HOME (the launcher's credential directory, ADR-0019 D4)
// and the bundled codex CLI; Antigravity needs COMMUNICATION_ANTIGRAVITY_HOME
// (ADR-0086) and the `antigravity` binary. A launcher with no driver simply has
// no row on the Settings → Agent accounts tab for this worker.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/worker"
)

// defaultCodexCLI is the codex entry point codex-acp bundles in the worker
// image (worker/Dockerfile installs @agentclientprotocol/codex-acp globally).
const defaultCodexCLI = "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex/bin/codex.js"

// agentLoginDrivers builds the sign-in drivers this worker can run.
func agentLoginDrivers(scratchRoot string) map[string]worker.AgentLoginDriver {
	drivers := map[string]worker.AgentLoginDriver{}
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}

	if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
		cli := strings.TrimSpace(os.Getenv("COMMUNICATION_CODEX_CLI"))
		if cli == "" {
			cli = defaultCodexCLI
		}
		if _, err := os.Stat(cli); err == nil {
			if node, err := exec.LookPath("node"); err == nil {
				drivers["codex"] = &worker.CodexLoginDriver{
					Command: []string{node, cli},
					Env:     []string{"PATH=" + path, "HOME=" + codexHome, "CODEX_HOME=" + codexHome},
					Timeout: 16 * time.Minute,
				}
			}
		}
	}

	if agyHome := strings.TrimSpace(os.Getenv("COMMUNICATION_ANTIGRAVITY_HOME")); agyHome != "" {
		if bin, err := exec.LookPath("antigravity"); err == nil {
			scratch := filepath.Join(scratchRoot, ".agent-login")
			_ = os.MkdirAll(scratch, 0o700)
			drivers["antigravity"] = &worker.AntigravityLoginDriver{
				Command:    []string{bin},
				Env:        antigravityEnv(path, agyHome),
				ScratchDir: scratch,
			}
		}
	}
	return drivers
}

// antigravityEnv is the Antigravity child's whole environment: HOME and the XDG
// roots under the persistent Antigravity home, so the login and the launcher
// read and write the same credential tree.
func antigravityEnv(path, home string) []string {
	return []string{
		"PATH=" + path,
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
	}
}
