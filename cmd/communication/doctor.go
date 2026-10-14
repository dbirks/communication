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
	"runtime"
	"strings"
	"text/tabwriter"
	"time"
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
// will extend the registry with ACP and sandbox checks.
var doctorTools = []string{
	"git", "docker", "podman", "bwrap", "nono", "apm",
	"node", "npx", "claude", "codex", "gemini", "pi",
}

// doctorChecks is the check registry in report order.
var doctorChecks = []struct {
	Name string
	Fn   check
}{
	{"runtime", runtimeCheck},
	{"kernel", kernelCheck},
	{"landlock-lsm", landlockCheck},
	{"tools", toolsCheck},
}

func runDoctor(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOutput := fs.Bool("json", false, "print the report as JSON")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	var results []CheckResult
	for _, c := range doctorChecks {
		results = append(results, c.Fn(ctx)...)
	}

	// Doctor diagnoses; missing tools are a report, not a failure.
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
		return 0
	}

	w := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "communication %s\n\n", version)
	fmt.Fprintf(w, "CHECK\tSTATUS\tDETAIL\n")
	for _, r := range results {
		fmt.Fprintf(w, "%s\t%s\t%s\n", r.Name, r.Status, r.Detail)
	}
	w.Flush()
	return 0
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
