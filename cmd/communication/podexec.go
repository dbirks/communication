package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// runPodExec is the in-pod launcher of ADR-0082 Decision 6, and the only way a
// process starts inside an attempt pod.
//
//	usage: communication pod-exec --env-dir <dir> [--cwd <dir>] -- <path> [args…]
//
// It exists because of what it does NOT do. The session used to be started with
// `sh -c 'set -e; cd "$1"; shift; exec env -i NAME=value … "$@"'`, and that
// command line is the `command=` query parameters of a `pods/exec` request:
// apiserver audit and kubelet logs record them in full, so every plain
// launch-environment entry — and anything the credential classifier did not
// catch — was written into the cluster's logs. Now the request carries names and
// paths only, the values sit in the per-attempt Secret, and the initContainer has
// already laid them at `env/<NAME>` in a 0700 directory only this pod's uid can
// read. This process reads those files, and execs, so:
//
//   - no value appears in argv, in the exec URL, or in `/proc` of anything but
//     the agent itself (the exec replaces this process, so there is no shell
//     parent left holding the environment either);
//   - the agent's environment is exactly the plan's, built from scratch — the
//     pod's own container environment (a PATH, a HOME, the two sandbox
//     directory variables) is NOT inherited, which is the same rule
//     ProcTransport enforces locally (ADR-0019 D1);
//   - a value reaches the agent byte-for-byte: no `$(cat …)` trailing-newline
//     stripping and no shell quoting anywhere on the path.
//
// It is not a user-facing mode: it runs only inside an attempt pod, created by
// the worker's launcher (internal/sandbox/k8s).
func runPodExec(args []string, stdout, stderr io.Writer) int {
	req, err := parsePodExecArgs(args)
	if err != nil {
		fmt.Fprintf(stderr, "pod-exec: %v\n", err)
		return 2
	}
	env, err := podExecEnv(req.envDir)
	if err != nil {
		fmt.Fprintf(stderr, "pod-exec: %v\n", err)
		return 1
	}
	if req.cwd != "" {
		if err := os.Chdir(req.cwd); err != nil {
			// The plan's cwd is a path the worker verified before it launched, so
			// its absence means the volume it lives on is not what the plan was
			// built against. Refuse rather than run the agent somewhere else.
			fmt.Fprintf(stderr, "pod-exec: working directory %s: %v\n", req.cwd, err)
			return 1
		}
	}
	path, err := resolvePodExecProgram(req.path, env)
	if err != nil {
		fmt.Fprintf(stderr, "pod-exec: %v\n", err)
		return 1
	}
	// The exec replaces this process, so the pod's exec session ends exactly when
	// the agent's does and the agent's exit status is the session's — which is
	// what podTransport.waitProcess reads back as the turn's exit code.
	if err := execProgram(path, req.argv, env); err != nil {
		fmt.Fprintf(stderr, "pod-exec: exec %s: %v\n", path, err)
		return 1
	}
	return 0 // unreachable: execProgram only returns on failure
}

// podExecRequest is the parsed command line.
type podExecRequest struct {
	envDir string
	cwd    string
	path   string
	argv   []string
}

// parsePodExecArgs reads the flags up to `--` and treats everything after it as
// the program and its arguments, so an argument that itself begins with a dash
// (nono's `--allow`, an adapter flag) reaches the child untouched.
func parsePodExecArgs(args []string) (podExecRequest, error) {
	var req podExecRequest
	i := 0
	for ; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		name, value, hasValue := strings.Cut(arg, "=")
		take := func(what string) (string, error) {
			if hasValue {
				return value, nil
			}
			// The separator is not a value: `--env-dir --` is a missing argument,
			// not an environment directory called "--".
			if i+1 >= len(args) || args[i+1] == "--" {
				return "", fmt.Errorf("%s needs a value", what)
			}
			i++
			return args[i], nil
		}
		switch name {
		case "--env-dir":
			v, err := take("--env-dir")
			if err != nil {
				return req, err
			}
			req.envDir = v
		case "--cwd":
			v, err := take("--cwd")
			if err != nil {
				return req, err
			}
			req.cwd = v
		default:
			return req, fmt.Errorf("unknown option %q: usage is pod-exec --env-dir <dir> [--cwd <dir>] -- <path> [args…]", arg)
		}
	}
	if i >= len(args) {
		return req, fmt.Errorf("no `--` separator: usage is pod-exec --env-dir <dir> [--cwd <dir>] -- <path> [args…]")
	}
	rest := args[i+1:]
	if len(rest) == 0 {
		return req, fmt.Errorf("no program after `--`")
	}
	req.path, req.argv = rest[0], rest
	if req.envDir == "" {
		// There is no default worth guessing: the launcher always names the
		// directory, and a wrapper that silently ran with an empty environment
		// would start an agent that fails somewhere far from here.
		return req, fmt.Errorf("--env-dir is required: the launch environment arrives as files, not in argv")
	}
	return req, nil
}

// podExecEnv builds the child's environment from the delivered files. Entries
// the kubelet puts on a projected volume (`..data` and its timestamped parent)
// are skipped; anything else whose name cannot be an environment variable is a
// refusal, because guessing at a name the plan never asked for is how an agent
// ends up running without its API key.
func podExecEnv(dir string) ([]string, error) {
	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read the delivered environment in %s: %w", dir, err)
	}
	env := make([]string, 0, len(dirents))
	for _, de := range dirents {
		name := de.Name()
		if strings.HasPrefix(name, "..") {
			continue
		}
		if de.IsDir() {
			return nil, fmt.Errorf("%s is a directory: an environment entry arrives as one file", name)
		}
		if !podExecName.MatchString(name) {
			return nil, fmt.Errorf("%s is not a usable environment variable name", name)
		}
		value, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
		if i := strings.IndexByte(string(value), 0); i >= 0 {
			// putenv would stop at the byte, so the agent would see a truncated
			// value; a Secret that carried one is a bug worth naming.
			return nil, fmt.Errorf("%s carries a NUL byte at offset %d", name, i)
		}
		env = append(env, name+"="+string(value))
	}
	if len(env) == 0 {
		return nil, fmt.Errorf("no environment entries were delivered in %s", dir)
	}
	return env, nil
}

// resolvePodExecProgram turns the plan's path into something execve can use. An
// absolute path (what the worker's plan always carries, resolved on the worker's
// own filesystem — the same image the pod runs) is used as given; a bare name is
// looked up in the CHILD's PATH, not the wrapper's, so a plan that meant a
// different PATH than the container's gets the program it meant.
func resolvePodExecProgram(name string, env []string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("no program to exec")
	}
	if strings.ContainsRune(name, filepath.Separator) {
		if !filepath.IsAbs(name) {
			return "", fmt.Errorf("program %q must be an absolute path", name)
		}
		return name, nil
	}
	for _, entry := range env {
		value, ok := strings.CutPrefix(entry, "PATH=")
		if !ok {
			continue
		}
		for _, dir := range filepath.SplitList(value) {
			if dir == "" {
				dir = "."
			}
			candidate := filepath.Join(dir, name)
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf("program %q is not on the delivered PATH", name)
}

// podExecName is what a delivered file must be called to count as an
// environment entry: the same shape internal/sandbox/k8s will accept as a Secret
// key, so the two ends of the channel agree by construction.
var podExecName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// execProgram is the syscall seam, so a test can observe the request without
// replacing the test binary's process.
var execProgram = func(path string, argv, env []string) error {
	return syscall.Exec(path, argv, env)
}
