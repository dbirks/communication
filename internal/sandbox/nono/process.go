package nono

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// maxCapture bounds how much child output the handle keeps in memory. Agent
// output can be large; the sandbox adapter only needs the tail for
// diagnostics and test assertions.
const maxCapture = 64 << 10

// waitDelay bounds how long Wait blocks after the direct child exits: nono's
// supervisor may leave grandchildren holding the copied stdout/stderr pipes
// open.
const waitDelay = 5 * time.Second

// Process is a launched child process and implements domain.ProcessHandle.
// Callers holding the concrete type can also inspect captured output.
type Process struct {
	cmd    *exec.Cmd
	stdout *capture
	stderr *capture

	mu      sync.Mutex
	started bool
	waited  bool
	err     error
}

var _ domain.ProcessHandle = (*Process)(nil)

// startProcess execs argv (argv[0] is the program) with spec's Dir and Env.
// No shell is used. The returned error is the exec/startup error; once a
// Process is returned, its exit status is read through Wait.
func startProcess(ctx context.Context, spec domain.CommandSpec, argv []string) (*Process, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = spec.Dir
	if len(spec.Env) > 0 {
		cmd.Env = spec.Env
	}
	cmd.WaitDelay = waitDelay

	p := &Process{cmd: cmd, stdout: newCapture(), stderr: newCapture()}
	cmd.Stdout = p.stdout
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", argv[0], err)
	}
	p.started = true
	return p, nil
}

// Wait blocks until the process exits and returns its exit error. It is
// idempotent: later calls replay the same result.
func (p *Process) Wait() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.waited {
		return p.err
	}
	err := p.cmd.Wait()
	// A context cancellation surfaces as a kill; keep the exec error so
	// callers can still tell non-zero exit from success.
	p.waited, p.err = true, err
	return err
}

// Kill terminates the direct child. Under nono the child is the nono
// supervisor, which tears its sandboxed process down with it; killing does not
// wait for the exit status — call Wait afterwards.
func (p *Process) Kill() error {
	p.mu.Lock()
	started := p.started
	done := p.waited
	p.mu.Unlock()
	if !started {
		return fmt.Errorf("kill: process was never started")
	}
	if done {
		return fmt.Errorf("kill: process already exited")
	}
	return p.cmd.Process.Kill()
}

// Stdout returns the captured (tail of) standard output.
func (p *Process) Stdout() string { return p.stdout.String() }

// Stderr returns the captured (tail of) standard error.
func (p *Process) Stderr() string { return p.stderr.String() }

// ExitCode returns the process exit code, or -1 when it is not yet available
// (Wait must have returned first).
func (p *Process) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.waited || p.cmd.ProcessState == nil {
		return -1
	}
	return p.cmd.ProcessState.ExitCode()
}

// capture is a bounded, lock-free-enough concurrent writer that retains the
// last max bytes written to it.
type capture struct {
	mu      sync.Mutex
	buf     []byte
	dropped int
}

func newCapture() *capture { return &capture{} }

func (c *capture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p...)
	if len(c.buf) > maxCapture {
		excess := len(c.buf) - maxCapture
		c.dropped += excess
		c.buf = append(c.buf[:0], c.buf[excess:]...)
	}
	return len(p), nil
}

func (c *capture) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := string(c.buf)
	if c.dropped > 0 {
		out = fmt.Sprintf("[... %d bytes truncated ...]\n%s", c.dropped, out)
	}
	return out
}

var _ io.Writer = (*capture)(nil)
