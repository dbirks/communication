package nono

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SelfTest proves enforcement by *doing it*, and returns what was observed.
//
// It exists because `nono setup --check-only` cannot answer this question. That
// command reports whether Landlock rulesets could be created (Launch.Probe
// records exactly that, and deliberately leaves `Verified=false` with a note
// saying so — M2 established that honesty and it was right). But ADR-0019 D6
// needs a stronger fact before a `required` worker may serve turns: not "the
// kernel accepted a ruleset" but "a child of this process really could not write
// where it was not granted". A seccomp profile, a nested container runtime or a
// Landlock ABI mismatch can all produce a machine where the first is true and the
// second is not.
//
// So the test has two legs, and *both* must answer as predicted:
//
//	a. a granted path is writable — otherwise the child never ran, and a
//	   refusal-only test would pass vacuously on a sandbox that could not exec
//	   at all (the same trap probe C-SILENT found for argv assertions); and
//	b. a path outside every grant is not writable — otherwise the sandbox is
//	   decorative.
//
// The write probe is `sh -c 'echo x > path'` rather than a Go binary because the
// shell's redirection exit status is the observation; and the denied leg inverts
// the assertion (`test ! -w`) so a *successful* write is what makes the command
// fail, which means a broken sandbox cannot report success.
//
// Scratch is created and removed under a caller-supplied root. It must not be
// under `LauncherHome`: a grant overlapping nono's own state root is refused, and
// permanently so (probe C-H1) — self-testing in the wrong directory would poison
// the worker's own launch paths.
type SelfTestResult struct {
	Backend        string
	Version        string
	FilesystemLive bool
	// DeniedPathObserved is the class of the denied check ("worktree-outside-
	// grants"), never the path: this is a security observation about a host
	// directory and the caller may want to journal it.
	DeniedPathObserved string
	GrantsVerified     int
	SelfTestedAt       time.Time
}

// ErrNotEnforced reports a self-test that ran and came back wrong: the sandbox
// exists but did not deny what it was supposed to deny. It is a distinct error so
// a caller can tell "cannot enforce" from "did not check".
var ErrNotEnforced = errors.New("sandbox: enforcement not observed")

// SelfTest runs the two legs against a real child and refuses on either
// discrepancy. timeout bounds each exec; a hung child is a failure, not a wait.
func (l *Launcher) SelfTest(ctx context.Context, scratchRoot string, timeout time.Duration) (SelfTestResult, error) {
	res := SelfTestResult{Backend: BackendName, SelfTestedAt: time.Now().UTC()}
	if scratchRoot == "" {
		return res, errors.New("sandbox: self-test needs a scratch root that is not nono's home")
	}
	if err := refuseNonoStateRoot(scratchRoot); err != nil {
		return res, err
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return res, err
	}
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	// The version leg doubles as the binary-presence leg; a self-test that cannot
	// even ask for a version has nothing to report.
	if out, err := l.run(ctx, timeout, "", nonoEnv(l), bin, "--version"); err != nil {
		return res, fmt.Errorf("sandbox: self-test could not run %s --version: %w (%s)", filepath.Base(bin), err, out.ErrLine())
	} else {
		res.Version = parseVersion(out.Machine())
	}

	dir, err := os.MkdirTemp(scratchRoot, "nono-selftest-")
	if err != nil {
		return res, fmt.Errorf("sandbox: self-test scratch under %s: %w", scratchRoot, err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	// MkdirTemp lands 0700 owned by the calling uid, and nono runs its child as
	// that same uid — so the mode is not what the test is about, and tightening it
	// would only hide a real failure behind a permission error from the wrong
	// layer.
	// Two sibling directories under one scratch root: the *granted* one and one
	// that is never named in any flag. They share a parent so a sandbox that
	// happened to allow the parent would also have to allow the sibling — and the
	// denied leg grants only `granted`, which is what makes the sibling a real
	// omission rather than an accident of layout.
	granted := filepath.Join(dir, "granted")
	denied := filepath.Join(dir, "outside")
	if err := os.MkdirAll(granted, 0o700); err != nil {
		return res, fmt.Errorf("sandbox: self-test granted dir: %w", err)
	}
	allowed := filepath.Join(granted, "marker")

	// Leg a: `--allow <dir>` and write inside it. The write *is* the assertion:
	// the child's report is corroborated by the file it left, not taken on trust.
	argv := []string{"run", "-s", "--allow", granted, "--", "/bin/sh", "-c",
		"echo payload > " + allowed + " && echo granted-writable"}
	out, err := l.run(ctx, timeout, granted, nonoEnv(l), append([]string{bin}, argv...)...)
	if err != nil {
		return res, fmt.Errorf("sandbox: the granted-write leg failed, so nothing was proven (a sandbox that cannot exec would pass a denial-only test): %w (%s)", err, out.ErrLine())
	}
	// The child's own report is read from stdout only: nono's chatter belongs to
	// stderr, so a banner or release notice can never be mistaken for the marker.
	if !strings.Contains(out.Machine(), "granted-writable") {
		return res, fmt.Errorf("sandbox: the granted-write leg did not report its write: %s", out.ErrLine())
	}
	if _, err := os.Stat(allowed); err != nil {
		return res, fmt.Errorf("sandbox: the child claimed a write that left no file: %w", err)
	}
	res.GrantsVerified = 1

	// Leg b: a *different* directory under the same root, with the grant narrowed
	// to `allowed` so `denied` is outside it, and the assertion inverted: the child
	// must fail to create its marker.
	if err := os.MkdirAll(denied, 0o700); err != nil {
		return res, fmt.Errorf("sandbox: self-test denied dir: %w", err)
	}
	// The denied directory is created by the worker before the launch and is never
	// named in a flag, so its writability is purely a function of what the sandbox
	// enforces. The cwd stays inside the grant (probe C-CWD: nono refuses a launch
	// whose cwd is outside the grants, and --allow-cwd is never emitted).
	deniedTarget := filepath.Join(denied, "marker")
	argvDeny := []string{"run", "-s", "--allow", granted, "--", "/bin/sh", "-c",
		"if echo payload > " + deniedTarget + " 2>/dev/null; then echo LEAKED; exit 1; fi; echo denied-ok"}
	out, err = l.run(ctx, timeout, granted, nonoEnv(l), append([]string{bin}, argvDeny...)...)
	if err != nil {
		// A non-zero status here needs unpacking: `denied-ok` means the sandbox
		// worked and `sh` exited on some unrelated problem, while `LEAKED` means
		// the write succeeded and the sandbox is decorative.
		if strings.Contains(out.Machine(), "LEAKED") {
			return res, fmt.Errorf("%w: a child under a narrowed grant wrote outside it", ErrNotEnforced)
		}
		return res, fmt.Errorf("sandbox: the denied-write leg errored without reporting: %w (%s)", err, out.ErrLine())
	}
	if strings.Contains(out.Machine(), "LEAKED") {
		return res, fmt.Errorf("%w: a child under a narrowed grant wrote outside it", ErrNotEnforced)
	}
	if !strings.Contains(out.Machine(), "denied-ok") {
		return res, fmt.Errorf("sandbox: the denied-write leg did not reach its assertion: %s", out.ErrLine())
	}
	if _, err := os.Stat(deniedTarget); err == nil {
		// The child's own report is not enough: a write that succeeded while the
		// check printed `denied-ok` is the exact lie this leg exists to catch.
		return res, fmt.Errorf("%w: the denied marker exists on disk despite the child reporting otherwise", ErrNotEnforced)
	}
	res.FilesystemLive = true
	res.DeniedPathObserved = "outside-grants-under-scratch-root"
	return res, nil
}

// refuseNonoStateRoot rejects a scratch root that nono would treat as its own
// protected state root, which is probe C-H1's trap in self-test form: running the
// test with HOME pointing into the granted tree makes nono refuse the grant, and
// the refusal is permanent for that directory.
func refuseNonoStateRoot(path string) error {
	home := os.Getenv("HOME")
	if home == "" {
		return nil
	}
	cleanHome, cleanPath := filepath.Clean(home), filepath.Clean(path)
	if cleanPath == cleanHome || strings.HasPrefix(cleanPath, cleanHome+string(filepath.Separator)) {
		return fmt.Errorf("sandbox: self-test scratch %s is inside $HOME (%s): nono derives its protected state root from HOME and thereafter permanently refuses every grant covering it (probe C-H1)", cleanPath, cleanHome)
	}
	return nil
}

// nonoEnv is the environment for nono's *own* invocations (probe, validate,
// dry-run, self-test). It is not the agent's environment and it carries no
// secret: a helper process that could read the worker's environment could read
// COMMUNICATION_DATABASE_URL. The only additions are nono's own chatter opt-outs
// (see noUpdateCheckEnv).
func nonoEnv(l *Launcher) []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	env := []string{"PATH=" + path}
	if l.Home != "" {
		env = append(env, "HOME="+l.Home)
	}
	return append(env, noUpdateCheckEnv...)
}
