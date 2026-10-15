package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// gitTimeout bounds one unsandboxed git command. A wedged `git fetch` against
// an unreachable remote would otherwise hold a turn lease forever; the fetch
// timeout is the visible failure the transcript reports instead.
const gitTimeout = 3 * time.Minute

// Runner executes git without a shell. Every worker-side git call goes through
// it so the environment, the identity and the `safe.directory` posture are
// stated once.
type Runner struct {
	// Bin is the git executable; empty means "git" from PATH.
	Bin string
	// Home is the HOME this process's git runs under. Worker-side git never
	// uses an agent's home; it exists so a mounted credential helper or
	// global config is a deliberate choice rather than an inherited accident.
	Home string
	// Identity is the git author/committer used for worker-side commits
	// (mirror maintenance only — the agent commits as itself, with the
	// .gitconfig inside its own home).
	Identity GitIdentity
	// NeutralDir is where a command with no directory of its own runs. The
	// worker's process cwd is *not* a safe default (in dev it is the source
	// checkout), so a bare repository lives here is refused by leaving git's
	// discovery somewhere it finds nothing.
	NeutralDir string
	// LookPath resolves Bin; nil uses exec.LookPath. Test seam.
	LookPath func(string) (string, error)
	// Spawn is the execution seam: it receives the fully-resolved argv plus
	// dir/env and returns the captured streams. nil uses exec.CommandContext.
	// Tests substitute a recorder — no git binary is needed to unit-test the
	// argv, the environment or the ordering rules.
	Spawn func(ctx context.Context, cmd Command) (Result, error)
}

// GitIdentity is a git author/committer pair.
type GitIdentity struct {
	Name  string
	Email string
}

// Command is one prepared git invocation.
type Command struct {
	// Path is the resolved git executable.
	Path string
	// Argv is the git argv (without the executable).
	Argv []string
	// Dir is the working directory ("" = inherit).
	Dir string
	// Env is the process environment, built from scratch — never os.Environ.
	// A worker inherits COMMUNICATION_DATABASE_URL; handing it to a git
	// subprocess (let alone an agent) is exactly the leak ADR-0019 D1 names.
	Env []string
}

// Result is a finished git command. Stdout and Stderr are captured separately
// when the seam supports it; Output() renders what a caller should quote.
type Result struct {
	Stdout string
	Stderr string
}

// Output returns stdout and stderr joined for diagnostics.
func (r Result) Output() string {
	out := strings.TrimSpace(r.Stdout)
	errLine := strings.TrimSpace(r.Stderr)
	switch {
	case out == "":
		return errLine
	case errLine == "":
		return out
	default:
		return out + "\n" + errLine
	}
}

// Error is a failed git command with its bounded output.
type Error struct {
	// Argv is the git argv without the executable, already redacted of
	// URL userinfo.
	Argv []string
	Err  error
	Out  string
}

func (e *Error) Error() string {
	msg := e.Out
	if msg == "" && e.Err != nil {
		msg = e.Err.Error()
	}
	if len(msg) > 400 {
		msg = msg[:400] + "…"
	}
	return fmt.Sprintf("git %s failed: %s", strings.Join(RedactArgs(e.Argv), " "), msg)
}

func (e *Error) Unwrap() error { return e.Err }

// Run executes one git argv in dir and returns its combined output. A non-zero
// exit is reported as *Error so callers can keep the message while checking
// for the specific failure text.
func (r *Runner) Run(ctx context.Context, dir string, argv ...string) (string, error) {
	res, err := r.Exec(ctx, dir, argv...)
	return res.Output(), err
}

// Stdout runs one git command and returns its standard output *untrimmed*.
// Porcelain formats are position-dependent — `git status --porcelain` encodes
// the index/worktree states in the first two columns, so trimming the leading
// space of a " M path" line shifts every path by one character. Anything
// parsed must come from here; only free text should use Run.
func (r *Runner) Stdout(ctx context.Context, dir string, argv ...string) (string, error) {
	res, err := r.Exec(ctx, dir, argv...)
	if err != nil {
		return res.Stdout, err
	}
	return res.Stdout, nil
}

// Lines runs one git command and returns its stdout split into lines, with
// trailing blanks removed. `git status --porcelain -z`, `ls-files -z` and
// `check-ignore -v` all answer with NUL- or newline-separated text, and every
// caller of this wants the list, not the string.
func (r *Runner) Lines(ctx context.Context, dir string, argv ...string) ([]string, error) {
	res, err := r.Exec(ctx, dir, argv...)
	if err != nil {
		return nil, err
	}
	return listLines(res.Stdout), nil
}

// Exec prepares and runs one git command, returning the raw result.
func (r *Runner) Exec(ctx context.Context, dir string, argv ...string) (Result, error) {
	cmd, err := r.Prepare(ctx, dir, argv...)
	if err != nil {
		return Result{}, err
	}
	run := r.Spawn
	if run == nil {
		run = defaultRun
	}
	out, runErr := run(ctx, cmd)
	res := Result{Stdout: out.Stdout, Stderr: out.Stderr}
	if runErr != nil {
		var ee *Error
		if errors.As(runErr, &ee) {
			if res.Stderr == "" {
				res.Stderr = ee.Out
			}
			return res, runErr
		}
		// A seam that returns a bare error gets the same wrapper the default
		// seam produces, so callers can depend on *Error unconditionally.
		if res.Stderr == "" {
			res.Stderr = res.Stdout
		}
		return res, &Error{Argv: cmd.Argv, Err: runErr, Out: res.Stderr}
	}
	return res, nil
}

// Prepare resolves the executable and builds the environment. Exposed so a
// test can assert the env is built from scratch and the identity flags are
// present, without executing anything.
func (r *Runner) Prepare(ctx context.Context, dir string, argv ...string) (Command, error) {
	if len(argv) == 0 {
		return Command{}, errors.New("workspace: git command is empty")
	}
	if ctx == nil {
		return Command{}, errors.New("workspace: git command requires a context")
	}
	bin := r.Bin
	if bin == "" {
		bin = "git"
	}
	look := r.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return Command{}, fmt.Errorf("workspace: %s not found: %w", bin, err)
	}
	full := append([]string{"-c", "safe.directory=*"}, argv...)
	// An empty dir must NOT mean "the worker's cwd": during development that
	// is the repository this code lives in, and a `git fetch` there would
	// write into the developer's own clone. NeutralDir is the escape hatch.
	if dir == "" {
		dir = r.NeutralDir
		if dir == "" {
			dir = "/"
		}
	}
	cmd := Command{Path: path, Dir: dir, Env: r.env()}
	// Identity flags are per-command rather than a config file so a
	// worker-side commit needs no writable HOME at all.
	if r.Identity.Name != "" {
		cmd.Env = append(cmd.Env, "GIT_AUTHOR_NAME="+r.Identity.Name, "GIT_COMMITTER_NAME="+r.Identity.Name)
	}
	if r.Identity.Email != "" {
		cmd.Env = append(cmd.Env, "GIT_AUTHOR_EMAIL="+r.Identity.Email, "GIT_COMMITTER_EMAIL="+r.Identity.Email)
	}
	cmd.Argv = full
	return cmd, nil
}

// env builds the git process environment from scratch: PATH, HOME, the
// locale, and the no-prompt/no-advice flags. Nothing inherited.
func (r *Runner) env() []string {
	home := r.Home
	if home == "" {
		home = os.Getenv("HOME")
	}
	env := []string{
		"PATH=" + envOrDefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
		"HOME=" + home,
		// No LC_ALL: git's porcelain formats are locale-independent, and
		// naming a locale the container does not have makes libc complain on
		// every invocation.
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ADVICE=0",
	}
	if home != "" {
		env = append(env,
			"XDG_CONFIG_HOME="+home+"/.config",
			"XDG_CACHE_HOME="+home+"/.cache",
			"XDG_DATA_HOME="+home+"/.local/share",
			"XDG_STATE_HOME="+home+"/.local/state",
		)
	}
	return env
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// defaultRun is the production seam: exec git with the prepared argv.
func defaultRun(ctx context.Context, c Command) (Result, error) {
	cctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	prog := c.Path
	if prog == "" {
		prog = "git"
	}
	//nolint:gosec // argv only, never a shell
	cmd := exec.CommandContext(cctx, prog, c.Argv...)
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		return res, &Error{Argv: c.Argv, Err: err, Out: strings.TrimSpace(stderr.String())}
	}
	return res, nil
}

// Redact strips userinfo from any URL-looking argument, so a repository row
// that carries credentials cannot leak them into a transcript, an event or a
// log line through a git error message.
func Redact(s string) string {
	if i := strings.Index(s, "://"); i >= 0 {
		rest := s[i+3:]
		if j := strings.IndexAny(rest, "@/"); j >= 0 && rest[j] == '/' {
			return s[:i+3] + rest[j+1:]
		}
	}
	return s
}

// RedactArgs applies Redact to every argument.
func RedactArgs(argv []string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = Redact(a)
	}
	return out
}
