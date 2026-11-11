package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// envFile writes one delivered environment entry and returns the directory.
func envFile(t *testing.T, name, value string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return dir
}

func TestPodExecEnvReadsTheDeliveredFiles(t *testing.T) {
	dir := envFile(t, "PATH", "/usr/local/bin:/usr/bin:/bin")
	for name, value := range map[string]string{
		"HOME":    "/data/workspaces/run/abc/home",
		"SECRET":  "s3cr3t",
		"TOKEN":   "sk-ant-token\n",
		"QUOTED":  `a "b" $c 'd' ; echo gone`,
		"MULTI":   "line1\nline2\n",
		"EMPTY":   "",
		"..dataX": "no",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	env, err := podExecEnv(dir)
	if err != nil {
		t.Fatalf("podExecEnv: %v", err)
	}
	got := strings.Join(env, "\n")
	// Values arrive byte-for-byte: no shell, so no trailing-newline stripping and
	// no quoting to undo. This is the whole reason the credential files could not
	// stay a `$(cat …)` in a shell script.
	for _, want := range []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"SECRET=s3cr3t",
		"TOKEN=sk-ant-token\n",
		`QUOTED=a "b" $c 'd' ; echo gone`,
		"MULTI=line1\nline2\n",
		"EMPTY=",
	} {
		if !strings.Contains("\n"+got+"\n", "\n"+want+"\n") && !strings.Contains(got, want) {
			t.Errorf("entry %q did not survive the read:\n%s", want, got)
		}
	}

	// The kubelet's own dot-entries are skipped, not turned into variables.
	if strings.Contains(got, "..") {
		t.Errorf("a volume dot-entry became a variable:\n%s", got)
	}
}

func TestPodExecEnvRefusesWhatItCannotDeliver(t *testing.T) {
	if _, err := podExecEnv(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("a missing delivery directory must be refused")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "TOKEN"), []byte("a\x00b"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := podExecEnv(dir); err == nil || !strings.Contains(err.Error(), "NUL") {
		t.Errorf("a NUL byte in a value must be refused, got %v", err)
	}
	if _, err := podExecEnv(t.TempDir()); err == nil || !strings.Contains(err.Error(), "no environment entries") {
		t.Errorf("an empty delivery directory must be refused, got %v", err)
	}
	// A name that could not be a variable is a refusal rather than a surprise: the
	// launcher will not deliver one (EnvFiles refuses it), so if one appears the
	// directory is not ours and guessing at it is how an agent runs with no key.
	bad := t.TempDir()
	for _, name := range []string{"WEIRD!", "CLAUDE.HOME", "a b"} {
		if err := os.WriteFile(filepath.Join(bad, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := podExecEnv(bad); err == nil || !strings.Contains(err.Error(), "not a usable environment variable name") {
			t.Errorf("name %q: error %v does not refuse an unusable name", name, err)
		}
		os.Remove(filepath.Join(bad, name))
	}
	if err := os.Mkdir(filepath.Join(bad, "SUBDIR"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := podExecEnv(bad); err == nil || !strings.Contains(err.Error(), "one file") {
		t.Errorf("a directory entry: error %v does not refuse it", err)
	}
}

func TestParsePodExecArgsStopsAtTheSeparator(t *testing.T) {
	req, err := parsePodExecArgs([]string{"--env-dir", "/run/attempt/env", "--cwd", "/data/workspaces/run/abc", "--", "/usr/local/bin/nono", "run", "--allow", "/data/workspaces/run/abc/home"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if req.envDir != "/run/attempt/env" || req.cwd != "/data/workspaces/run/abc" {
		t.Errorf("request = %+v", req)
	}
	// The plan's own flags — including the leading dashes nono needs — are the
	// child's argv, not this command's options.
	if got := strings.Join(req.argv, " "); got != "/usr/local/bin/nono run --allow /data/workspaces/run/abc/home" {
		t.Errorf("argv = %q", got)
	}
	// `=` form and a value that looks like a flag.
	req, err = parsePodExecArgs([]string{"--env-dir=/run/attempt/env", "--cwd", "--", "sh"})
	if err == nil && req.cwd != "--" {
		t.Errorf("cwd = %q, want the literal next argument", req.cwd)
	}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"no separator", []string{"--env-dir", "/e", "sh"}, "unknown option"},
		{"nothing but flags", []string{"--env-dir", "/e"}, "no `--` separator"},
		{"nothing after it", []string{"--env-dir", "/e", "--"}, "no program"},
		{"no env dir", []string{"--", "sh"}, "--env-dir is required"},
		{"unknown option", []string{"--allow", "/x", "--", "sh"}, "unknown option"},
		{"missing value", []string{"--env-dir", "--", "sh"}, "needs a value"},
	} {
		if _, err := parsePodExecArgs(tc.args); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %v does not mention %q", tc.name, err, tc.want)
		}
	}
}

func TestResolvePodExecProgramUsesTheChildPath(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "agent")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := resolvePodExecProgram("agent", []string{"PATH=" + dir})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != script {
		t.Errorf("resolved %q, want %q", got, script)
	}
	// An absolute path is used as given, whatever PATH says.
	if got, err := resolvePodExecProgram("/usr/local/bin/nono", nil); err != nil || got != "/usr/local/bin/nono" {
		t.Errorf("absolute path: %q %v", got, err)
	}
	// A relative path with a separator is refused: it would resolve differently
	// depending on the cwd the wrapper is about to change to.
	if _, err := resolvePodExecProgram("./agent", []string{"PATH=" + dir}); err == nil {
		t.Error("a relative path with a separator must be refused")
	}
	// A name on a PATH it was not given is a refusal, not a lookup against the
	// wrapper's own PATH.
	if _, err := resolvePodExecProgram("agent", []string{"PATH=/nonexistent"}); err == nil {
		t.Error("a program missing from the delivered PATH must be refused")
	}
	// And with no PATH at all, nothing is findable.
	if _, err := resolvePodExecProgram("agent", []string{"HOME=/tmp"}); err == nil {
		t.Error("a bare program name with no delivered PATH must be refused")
	}
}

// TestPodExecStartsTheChildForReal runs the command the way the pod's exec does —
// in a separate process, through the flag parsing, past the exec syscall — and
// reads what the child actually saw. The wrapper's own environment carries a
// variable the plan never named: if it reached the child, the agent would be
// running with the pod's environment rather than its own (ADR-0019 D1, the rule
// ProcTransport enforces locally and `env -i` enforced here).
func TestPodExecStartsTheChildForReal(t *testing.T) {
	if os.Getenv("COMMUNICATION_POD_EXEC_CHILD") == "1" {
		// The request arrives in the environment rather than the command line:
		// Go's own flag parser eats any `--x` before the test body runs, and this
		// process's arguments are its business, not pod-exec's.
		var args []string
		if raw := os.Getenv("COMMUNICATION_POD_EXEC_ARGS"); raw != "" {
			args = strings.Split(raw, "\n")
		}
		os.Exit(runPodExec(args, os.Stdout, os.Stderr))
	}
	dir := envFile(t, "PATH", "/usr/bin:/bin")
	home := t.TempDir()
	for name, value := range map[string]string{
		"HOME":   home,
		"SECRET": "s3cr3t",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cwd := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("locate the test binary: %v", err)
	}
	// `/usr/bin/env` prints the child's environment, which is the fact under test.
	sawEnv := runPodExecChild(t, exe, "--env-dir", dir, "--cwd", cwd, "--", "/usr/bin/env")
	for _, want := range []string{"SECRET=s3cr3t\n", "HOME=" + home + "\n", "PATH=/usr/bin:/bin\n"} {
		if !strings.Contains(sawEnv, want) {
			t.Errorf("the child did not get %q:\n%s", strings.TrimRight(want, "\n"), sawEnv)
		}
	}
	// The wrapper's own environment is the pod's, and the agent may not see it.
	for _, leak := range []string{"COMMUNICATION_POD_EXEC_CHILD", "GOPATH=", "GOFLAGS=", "HOME=/root"} {
		if strings.Contains(sawEnv, leak) {
			t.Errorf("the child inherited %q from the wrapper:\n%s", leak, sawEnv)
		}
	}
	sawCwd := runPodExecChild(t, exe, "--env-dir", dir, "--cwd", cwd, "--", "/bin/pwd")
	if got := strings.TrimSpace(sawCwd); got != filepath.Clean(cwd) {
		t.Errorf("child cwd = %q, want %q", got, cwd)
	}
	// An argument that begins with a dash reaches the child, not the parser: this
	// is what lets the plan's own nono flags (`--allow`, `--read`) survive.
	echoed := runPodExecChild(t, exe, "--env-dir", dir, "--", "/bin/echo", "--cwd", "escaped")
	if got := strings.TrimSpace(echoed); got != "--cwd escaped" {
		t.Errorf("child argv after `--` = %q", got)
	}
	// A program that is not on the delivered PATH fails the exec rather than
	// falling back to the wrapper's PATH — and says so on stderr with no value in it.
	out, errCode := runPodExecChildStatus(t, exe, "--env-dir", dir, "--", "definitely-not-on-path")
	if errCode == 0 {
		t.Errorf("a missing program started anyway:\n%s", out)
	}
	if !strings.Contains(out, "definitely-not-on-path") || strings.Contains(out, "s3cr3t") {
		t.Errorf("the refusal names the wrong thing: %q", out)
	}
}

func runPodExecChild(t *testing.T, exe string, args ...string) string {
	t.Helper()
	out, code := runPodExecChildStatus(t, exe, args...)
	if code != 0 {
		t.Fatalf("pod-exec child exited %d:\n%s", code, out)
	}
	return out
}

func runPodExecChildStatus(t *testing.T, exe string, args ...string) (string, int) {
	t.Helper()
	// Only the harness's own flags go on the command line; the pod-exec request
	// travels in the environment (see the child branch above).
	cmd := exec.Command(exe, "-test.run=TestPodExecStartsTheChildForReal")
	cmd.Env = append(os.Environ(), "COMMUNICATION_POD_EXEC_CHILD=1", "COMMUNICATION_POD_EXEC_ARGS="+strings.Join(args, "\n"))
	out, err := cmd.CombinedOutput()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("start the pod-exec child: %v\n%s", err, out)
	}
	return string(out), code
}
