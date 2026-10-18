package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/sandbox"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// CheckResult is one line of the doctor report.
type CheckResult struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

// Status values reported by doctor checks.
const (
	statusOK      = "ok"
	statusMissing = "missing"
	statusWarn    = "warn"
	statusError   = "error"
)

// check runs one doctor probe. External commands must respect the caller's
// context; see toolCheck for the standard 5s timeout.
type check func(ctx context.Context) []CheckResult

// toolCommandTimeout bounds every external command run by doctor.
const toolCommandTimeout = 5 * time.Second

// doctorTools are probed in this order by the tools check. Later milestones
// will extend the registry with further ACP and sandbox checks.
var doctorTools = []string{
	"git", "docker", "podman", "bwrap", "nono", "apm",
	"node", "npx", "claude", "codex", "gemini", "pi",
}

// doctorChecks is the check registry in report order. ACP end-to-end checks
// are opt-in (--acp) and appended afterwards.
var doctorChecks = []struct {
	Name string
	Fn   check
}{
	{"runtime", runtimeCheck},
	{"kernel", kernelCheck},
	{"landlock-lsm", landlockCheck},
	{"tools", toolsCheck},
	{"sandbox:nono", sandboxCheck},
	{"sandbox:nono-tcp-reachability", func(ctx context.Context) []CheckResult {
		return []CheckResult{tcpReachabilityCheck(ctx)}
	}},
	{"claude:oauth-token", claudeOAuthTokenCheck},
}

// stringListFlag collects a repeatable and/or comma-separated flag value.
type stringListFlag []string

func (s *stringListFlag) String() string { return strings.Join(*s, ",") }

func (s *stringListFlag) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			*s = append(*s, part)
		}
	}
	return nil
}

func runDoctor(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOutput := fs.Bool("json", false, "print the report as JSON")
	keep := fs.Bool("keep", false, "keep the disposable ACP test repo and print its path")
	acpCmd := fs.String("acp-cmd", "", "override the ACP launcher executable (requires exactly one --acp id)")
	acpTimeout := fs.Duration("acp-timeout", defaultACPTimeout, "timeout for each --acp end-to-end check")
	var acpIDs stringListFlag
	fs.Var(&acpIDs, "acp", "run an end-to-end ACP check for a launcher id (repeatable or comma-separated: claude,codex)")
	pipelines := fs.Bool("pipelines", false, "run the pipeline-schema/CEL self-check lane (compile the shipped schema, evaluate one expression per allowlisted CEL name, report the cel_env_digest)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	ids, bad := resolveACPIDs(acpIDs, *acpCmd, stderr)
	if bad {
		return 2
	}

	var results []CheckResult
	for _, c := range doctorChecks {
		results = append(results, c.Fn(ctx)...)
	}
	if *pipelines {
		results = append(results, pipelineChecks(ctx)...)
	}
	for _, id := range ids {
		launcher, _ := acp.LookupLauncher(id)
		exe, err := exec.LookPath(*acpCmd)
		if *acpCmd == "" {
			exe, err = exec.LookPath(launcher.Executable)
		}
		if err != nil {
			results = append(results, CheckResult{
				Name:   "acp:" + id,
				Status: statusMissing,
				Detail: fmt.Sprintf("%s not found: %v", firstNonEmpty(*acpCmd, launcher.Executable), err),
			})
			continue
		}
		results = append(results, checkACP(ctx, launcher, exe, *acpTimeout, *keep, stderr))
	}

	// Doctor diagnoses; missing tools are a report, not a failure.
	doctorExit := func() int {
		if code := acpExitCode(results, ids); code != 0 {
			return code
		}
		if *pipelines {
			return pipelinesExitCode(results)
		}
		return 0
	}
	if *jsonOutput {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(struct {
			Version string        `json:"version"`
			Checks  []CheckResult `json:"checks"`
		}{Version: version, Checks: results}); err != nil {
			fmt.Fprintf(stderr, "doctor: %v\n", err)
			return 2
		}
		return doctorExit()
	}

	w := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "communication %s\n\n", version)
	fmt.Fprintf(w, "CHECK\tSTATUS\tDETAIL\n")
	for _, r := range results {
		fmt.Fprintf(w, "%s\t%s\t%s\n", r.Name, r.Status, r.Detail)
	}
	w.Flush()
	return doctorExit()
}

// resolveACPIDs validates and de-duplicates the requested launcher ids.
// bad is true when the flag combination or an id is invalid (exit 2).
func resolveACPIDs(ids stringListFlag, acpCmd string, stderr io.Writer) ([]string, bool) {
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		if _, ok := acp.LookupLauncher(id); !ok {
			known := make([]string, 0)
			for _, l := range acp.KnownLaunchers() {
				known = append(known, l.ID)
			}
			fmt.Fprintf(stderr, "doctor: unknown --acp launcher id %q (known: %s)\n", id, strings.Join(known, ", "))
			return nil, true
		}
		seen[id] = true
		out = append(out, id)
	}
	if acpCmd != "" && len(out) != 1 {
		fmt.Fprintln(stderr, "doctor: --acp-cmd requires exactly one --acp id")
		return nil, true
	}
	return out, false
}

// acpExitCode is 1 when any requested acp:* check did not pass; doctor still
// reports 0 for the non-ACP checks, which are informational.
func acpExitCode(results []CheckResult, requested []string) int {
	if len(requested) == 0 {
		return 0
	}
	for _, r := range results {
		if strings.HasPrefix(r.Name, "acp:") && r.Status != statusOK {
			return 1
		}
	}
	return 0
}

func firstNonEmpty(candidates ...string) string {
	for _, c := range candidates {
		if c != "" {
			return c
		}
	}
	return ""
}

// nonoIsolationVerdict is the honest verdict line: a probe reports the
// backend's own claims, it does not prove enforcement, so no stronger claim
// may ever be printed here (communication-spec/05-workspaces-security-secrets.md
// "First security acceptance gate", ADR-0009).
const nonoIsolationVerdict = "verified=false (probe only — enforcement proven by " +
	"sandbox_integration tests, see docs/compatibility/SANDBOX.md)"

// sandboxCheck probes the nono backend. The probe half never claims more
// than it observed; the TCP-reachability half does launch one child under
// the agent profile (tcpReachabilityCheck) because the worker's startup gate
// proves enforcement by running a child, and doctor reports the same gate.
func sandboxCheck(ctx context.Context) []CheckResult {
	const name = "sandbox:nono"
	caps, err := (&nono.Launcher{}).Probe(ctx)
	if errors.Is(err, sandbox.ErrUnavailable) {
		return []CheckResult{{Name: name, Status: statusMissing, Detail: err.Error()}}
	}
	if err != nil {
		return []CheckResult{{Name: name, Status: statusError, Detail: err.Error()}}
	}
	detail := fmt.Sprintf("nono %s; landlock fs=%t net=%t; %s", caps.Version, caps.Filesystem, caps.Network, nonoIsolationVerdict)
	if notes := strings.Join(caps.Notes, "; "); notes != "" {
		detail += "; " + notes
	}
	results := []CheckResult{{Name: name, Status: statusOK, Detail: detail}}
	return results
}

// claudeOAuthTokenCheck reports the ADR-0040 long-lived claude credential
// configuration. It prints only "configured, N chars, prefix ok" (or the
// fault) — never the token value, never the file contents.
func claudeOAuthTokenCheck(ctx context.Context) []CheckResult {
	const name = "claude:oauth-token"
	launcher, ok := acp.LookupLauncher("claude")
	if !ok || launcher.OAuthTokenFileEnv == "" {
		return []CheckResult{{Name: name, Status: statusMissing, Detail: "not configured: the claude launcher authenticates through CLAUDE_CONFIG_DIR only"}}
	}
	file := strings.TrimSpace(os.Getenv(launcher.OAuthTokenFileEnv))
	if file == "" {
		return []CheckResult{{Name: name, Status: statusMissing, Detail: "not configured: " + launcher.OAuthTokenFileEnv + " is unset; the claude launcher authenticates through CLAUDE_CONFIG_DIR only"}}
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return []CheckResult{{Name: name, Status: statusError, Detail: fmt.Sprintf("token file %s cannot be read: %v", file, err)}}
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return []CheckResult{{Name: name, Status: statusError, Detail: fmt.Sprintf("token file %s is empty", file)}}
	}
	if !strings.HasPrefix(tok, launcher.OAuthTokenPrefix) {
		return []CheckResult{{Name: name, Status: statusError, Detail: fmt.Sprintf("token in %s does not start with the %s prefix (value not shown)", file, launcher.OAuthTokenPrefix)}}
	}
	return []CheckResult{{Name: name, Status: statusOK, Detail: fmt.Sprintf("configured, %d chars, prefix ok", len(tok))}}
}

// tcpReachabilityCheck is its own doctor check — a separate name, separate
// line — so the probe-only contract of sandboxCheck (one `sandbox:nono` row,
// verified=false, no stronger claim) is untouched: this row is the worker's
// startup gate reported by the same name, and where it reports ok it has
// actually observed enforcement of one connect, which sandbox:nono must not
// claim.

// tcpReachabilityCheck runs the worker's own agent-turn TCP probe (the same
// classification, the same remediation sentence) and reports it.
func tcpReachabilityCheck(ctx context.Context) CheckResult {
	// Scratch lives under os.TempDir, outside $HOME: nono's state root derives
	// from HOME, and the launcher's HOME is a sibling of the scratch so no
	// grant overlaps it (probe C-H1).
	const name = "sandbox:nono-tcp-reachability"
	if _, err := exec.LookPath("nono"); err != nil {
		return CheckResult{Name: name, Status: statusMissing, Detail: "no nono binary on PATH: the agent-turn TCP probe cannot be run"}
	}
	base, err := os.MkdirTemp(os.TempDir(), "communication-doctor-nonotcp-")
	if err != nil {
		return CheckResult{Name: name, Status: statusError, Detail: fmt.Sprintf("scratch under %s: %v", os.TempDir(), err)}
	}
	defer func() { _ = os.RemoveAll(base) }()
	launcherHome := filepath.Join(base, "launcher-home")
	scratch := filepath.Join(base, "scratch")
	for _, d := range []string{launcherHome, scratch} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return CheckResult{Name: name, Status: statusError, Detail: fmt.Sprintf("scratch %s: %v", d, err)}
		}
	}
	res, err := (&nono.Launcher{Home: launcherHome}).TCPConnectSelfTest(ctx, scratch, 30*time.Second)
	if err != nil {
		return CheckResult{Name: name, Status: statusError, Detail: fmt.Sprintf("probe could not be run: %v", err)}
	}
	detail := fmt.Sprintf("agent profile af_unix_mediation=pathname; classification=%s; kernel.yama.ptrace_scope=%s", res.Classification, ptraceScopeValue())
	status := statusOK
	if !res.OK {
		status = statusError
		detail += "; " + afUnixRemediation
	}
	return CheckResult{Name: name, Status: status, Detail: detail + "; " + res.Detail}
}

func runtimeCheck(_ context.Context) []CheckResult {
	return []CheckResult{{
		Name:   "runtime",
		Status: statusOK,
		Detail: fmt.Sprintf("go %s %s/%s", runtime.Version(), runtime.GOOS, runtime.GOARCH),
	}}
}

func kernelCheck(_ context.Context) []CheckResult {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return []CheckResult{{
			Name:   "kernel",
			Status: statusWarn,
			Detail: fmt.Sprintf("cannot read /proc/sys/kernel/osrelease: %v", err),
		}}
	}
	return []CheckResult{{
		Name:   "kernel",
		Status: statusOK,
		Detail: strings.TrimSpace(string(data)),
	}}
}

// landlockLSMPath exposes the active Linux Security Modules list.
const landlockLSMPath = "/sys/kernel/security/lsm"

func landlockCheck(_ context.Context) []CheckResult {
	data, err := os.ReadFile(landlockLSMPath)
	if err != nil {
		return []CheckResult{{
			Name:   "landlock-lsm",
			Status: statusWarn,
			Detail: fmt.Sprintf("cannot read %s: %v", landlockLSMPath, err),
		}}
	}
	list := strings.TrimSpace(string(data))
	for _, lsm := range strings.Split(list, ",") {
		if strings.TrimSpace(lsm) == "landlock" {
			// Presence in the LSM list is not proof of enforcement;
			// verifying enforcement requires a real sandbox test
			// (communication-spec/12-test-strategy.md).
			return []CheckResult{{
				Name:   "landlock-lsm",
				Status: statusOK,
				Detail: "landlock listed in active LSMs (enforcement not yet verified)",
			}}
		}
	}
	return []CheckResult{{
		Name:   "landlock-lsm",
		Status: statusWarn,
		Detail: fmt.Sprintf("landlock not in active LSMs (%s)", list),
	}}
}

func toolsCheck(ctx context.Context) []CheckResult {
	var results []CheckResult
	for _, name := range doctorTools {
		results = append(results, toolCheck(ctx, name))
	}
	return results
}

// toolCheck resolves one executable and probes `<name> --version` with a
// bounded timeout. It never goes through a shell.
func toolCheck(ctx context.Context, name string) CheckResult {
	res := CheckResult{Name: "tool:" + name}

	path, err := exec.LookPath(name)
	if errors.Is(err, exec.ErrNotFound) {
		res.Status = statusMissing
		res.Detail = "not found in PATH"
		return res
	}
	if err != nil {
		res.Status = statusError
		res.Detail = fmt.Sprintf("lookpath: %v", err)
		return res
	}

	cctx, cancel := context.WithTimeout(ctx, toolCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, path, "--version")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Run(); err != nil {
		res.Status = statusWarn
		if cctx.Err() == context.DeadlineExceeded {
			res.Detail = fmt.Sprintf("%s: --version timed out after %s", path, toolCommandTimeout)
		} else {
			res.Detail = fmt.Sprintf("%s: %v", path, err)
		}
		return res
	}

	res.Status = statusOK
	res.Detail = fmt.Sprintf("%s: %s", path, firstNonEmptyLine(buf.String()))
	return res
}

func firstNonEmptyLine(s string) string {
	sc := bufio.NewScanner(strings.NewReader(s))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			return line
		}
	}
	return ""
}
