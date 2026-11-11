package acp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Transport carries one ACP session's stdio and outlives every turn on it.
// Today there is exactly one implementation, `procTransport`: the local child
// process this worker execs itself. ADR-0082 §8 adds a pod-shaped one in
// internal/sandbox/k8s, where the same four pipes belong to a pod created for
// this attempt, `Wait` blocks until that pod ends and `Signal` deletes it.
//
// The handle is written against this interface and nothing else: it never sees
// an *exec.Cmd, so it cannot grow a local-process assumption that a pod
// transport would have to fake.
type Transport interface {
	// Stdin is the agent's stdin: the ACP request stream the client writes.
	Stdin() io.WriteCloser
	// Stdout is the agent's stdout: the ACP response stream the client reads.
	Stdout() io.Reader
	// Stderr is the agent's stderr as bytes. A transport that captures it
	// boundedly (the local one does) hands the handle the same capture
	// through stderrRingOf so handle.Stderr() can quote it on failure; this
	// reader is never consumed by the ACP path.
	Stderr() io.Reader
	// Wait blocks until the agent process/pod has ended and returns its exit
	// verdict (nil for a clean exit). It is called once, by the reap
	// goroutine in handle.attachProcess.
	Wait() error
	// Signal is the terminate ladder's rung: SIGTERM first, SIGKILL for a
	// harness that ignores it. The local transport signals the whole process
	// group; a pod transport implements the same request as deleting the pod.
	Signal(sig os.Signal) error
	// Close releases the transport's own stdio handles without waiting for
	// the agent to end. The local transport's descriptors are owned by
	// cmd.Wait (which closes them as it reaps), so the session path does not
	// call this; it exists for transports whose pipes need hanging up.
	Close() error
}

// Transporter starts one launch and hands back the stdio it produced.
//
// Required mode must not be able to return a Transport whose sandbox was never
// verified (ADR-0019 D6: no fallback) — the plan arriving here is the same
// object the turn loop verified and journalled, and a future pod transport
// takes its verification from the pod that ran it.
type Transporter interface {
	Start(ctx context.Context, plan LaunchPlan) (Transport, error)
}

// ProcTransporter starts the plan as a local child process. It is exactly the
// code this package used to run inline in Runtime.StartWithOptions, moved
// behind the seam; a nil Runtime.Transporter means this one, so every existing
// caller is unchanged.
type ProcTransporter struct{}

var (
	_ Transporter = ProcTransporter{}
	_ Transporter = (*ProcTransporter)(nil)
)

// Start execs plan.Path with plan.Args in plan.Dir under plan.Env and returns
// the pipes. Only Path, Args, Env and Dir of the plan reach the kernel: the
// sandbox fields (Verified, Unsandboxed) are the journal's business, and the
// plan is journalled before it gets here.
func (ProcTransporter) Start(ctx context.Context, plan LaunchPlan) (Transport, error) {
	// No inheritance. Falling back to os.Environ() here handed every launched
	// agent the worker's whole environment, `COMMUNICATION_DATABASE_URL`
	// included (ADR-0019 D1 names this as the leak to close). A launch with no
	// environment is a configuration bug, and the fix is for the caller to say
	// what the child may see — see acp.LaunchEnv for the built-from-scratch
	// form and acp.MinimalEnv for the allowlisted one.
	if plan.Env == nil {
		return nil, fmt.Errorf("acp: launch spec for %s carries no environment: the worker must build it from scratch (acp.LaunchEnv), never inherit os.Environ()", plan.Path)
	}

	cmd := exec.CommandContext(ctx, plan.Path, plan.Args...) //nolint:gosec // launcher argv is governed by the profile, no shell
	cmd.Dir = plan.Dir
	// The harness runs in its own process group (pid == pgid). A closed stdio
	// is not a dead harness: an agent that dies mid-turn usually leaves
	// orphaned descendants holding the stderr pipe, and cmd.Wait waits on the
	// copied descriptor until that pipe sees EOF — so a signal aimed at the
	// direct process alone leaves Wait (and therefore handle.Close, and the
	// worker's turn loop behind it) parked forever (lab run 41789603709). The
	// teardown ladder in handle.waitProcess signals this group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// WaitDelay is the backstop for the same wedge in the case a descendant
	// escaped the group (setsid) and still holds a pipe: it bounds how long
	// cmd.Wait may wait for the copy goroutines after the process itself is
	// gone, so the reap can never outlive a deadline.
	cmd.WaitDelay = waitDelay

	cmd.Env = plan.Env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stdout pipe: %w", err)
	}
	stderr := newRingBuffer(maxStderrBytes)
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("acp: start %s: %w", plan.Path, err)
	}

	return &procTransport{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

// procTransport is Transport over a local child process.
type procTransport struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr *ringBuffer

	closeOnce sync.Once
}

var _ Transport = (*procTransport)(nil)

func (t *procTransport) Stdin() io.WriteCloser { return t.stdin }
func (t *procTransport) Stdout() io.Reader     { return t.stdout }

// Stderr returns the captured stderr tail so far, as a reader. It is a
// snapshot of the bounded ring rather than the live pipe: the ring is what the
// agent's stderr is written into (and what handle.Stderr() quotes), so a
// reader that consumed the pipe would take bytes away from the capture.
func (t *procTransport) Stderr() io.Reader {
	return bytes.NewReader(t.stderr.snapshot())
}

// stderrRing is how the handle reaches that same capture; see stderrRingOf.
func (t *procTransport) stderrRing() *ringBuffer { return t.stderr }

// Wait reaps the process and hangs up the stdout pipe. Closing stdout after
// Wait is the SDK's documented order; doing it here keeps the transport the
// only place that knows which descriptor the pipe was.
func (t *procTransport) Wait() error {
	err := t.cmd.Wait()
	_ = t.stdout.Close()
	return err
}

// Signal sends sig to the harness's whole process group and, as the
// direct-process fallback, to the harness itself: a harness that re-parented
// itself out of the group is still the process we must retire, and a pid the
// kernel has already reused answers ESRCH, which means the group is already
// gone.
func (t *procTransport) Signal(sig os.Signal) error {
	p := t.cmd.Process
	if p == nil {
		return nil
	}
	var firstErr error
	if ss, ok := sig.(syscall.Signal); ok {
		if err := syscall.Kill(-p.Pid, ss); err != nil {
			if !errors.Is(err, syscall.ESRCH) {
				firstErr = err
			}
		}
	}
	if err := p.Signal(sig); err != nil {
		if !errors.Is(err, syscall.ESRCH) && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Close hangs up the pipes once and does not wait for the child: cmd.Wait owns
// the child's reap and closes the descriptors it created.
func (t *procTransport) Close() error {
	var err error
	t.closeOnce.Do(func() {
		if t.stdout != nil {
			_ = t.stdout.Close()
		}
		if t.stdin != nil {
			err = t.stdin.Close()
		}
	})
	return err
}

// stderrRingOf returns the bounded stderr capture behind a transport, if it
// keeps one. A transport without a capture (a test double, a future pod whose
// logs come from elsewhere) leaves handle.Stderr() reporting "" exactly as the
// process-less test handles do today.
func stderrRingOf(t Transport) *ringBuffer {
	if c, ok := t.(interface{ stderrRing() *ringBuffer }); ok {
		return c.stderrRing()
	}
	return nil
}

// ringBuffer is a bounded, mutex-guarded byte buffer that keeps the most
// recent bytes written to it. It is used to capture agent stderr without
// unbounded growth.
type ringBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newRingBuffer(maxBytes int) *ringBuffer {
	return &ringBuffer{max: maxBytes}
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if over := len(r.buf) - r.max; over > 0 {
		r.buf = append(r.buf[:0], r.buf[over:]...)
	}
	return len(p), nil
}

func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// snapshot copies the bytes retained so far.
func (r *ringBuffer) snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]byte(nil), r.buf...)
}

// waitDelay bounds cmd.Wait's wait for the stdio copy goroutines once the
// harness process is gone. A grandchild that escaped the process group may
// still hold the stderr pipe; this is the wall that keeps the worker from
// waiting that orphan out forever.
const waitDelay = 10 * time.Second

// maxStderrBytes bounds captured agent stderr to the last 64 KiB.
const maxStderrBytes = 64 * 1024

var _ io.Writer = (*ringBuffer)(nil)
