// Package acp implements domain.AgentRuntime on top of the ACP
// (Agent Client Protocol) JSON-RPC protocol using
// github.com/coder/acp-go-sdk.
package acp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

// Runtime starts one ACP agent process per conversation and speaks the
// protocol over its stdio pipes.
type Runtime struct {
	// PermissionPolicy decides how session/request_permission is answered.
	PermissionPolicy PermissionPolicy
	// Logger receives protocol diagnostics; nil discards them.
	Logger *slog.Logger
}

var _ domain.AgentRuntime = (*Runtime)(nil)

// Start launches spec.Executable (no shell), performs initialize and
// session/new, and returns a live handle.
func (r *Runtime) Start(ctx context.Context, spec domain.AgentLaunchSpec) (domain.AgentHandle, error) {
	return r.StartWithOptions(ctx, spec, StartOptions{})
}

// StartWithOptions is Start plus session setup options: a prompting mode,
// a session to restore via session/load, and the per-session permission
// decider that overrides the Runtime's static policy.
func (r *Runtime) StartWithOptions(ctx context.Context, spec domain.AgentLaunchSpec, opts StartOptions) (domain.AgentSession, error) {
	if spec.Executable == "" {
		return nil, errors.New("acp: AgentLaunchSpec.Executable is required")
	}
	if spec.WorkDir == "" {
		return nil, errors.New("acp: AgentLaunchSpec.WorkDir is required")
	}

	cmd := exec.CommandContext(ctx, spec.Executable, spec.Args...) //nolint:gosec // launcher argv is governed by the profile, no shell
	cmd.Dir = spec.WorkDir
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

	// No inheritance. Falling back to os.Environ() here handed every launched
	// agent the worker's whole environment, `COMMUNICATION_DATABASE_URL`
	// included (ADR-0019 D1 names this as the leak to close). A launch with no
	// environment is a configuration bug, and the fix is for the caller to say
	// what the child may see — see acp.LaunchEnv for the built-from-scratch
	// form and acp.MinimalEnv for the allowlisted one.
	if spec.Env == nil {
		return nil, fmt.Errorf("acp: launch spec for %s carries no environment: the worker must build it from scratch (acp.LaunchEnv), never inherit os.Environ()", spec.Executable)
	}
	cmd.Env = spec.Env

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
		return nil, fmt.Errorf("acp: start %s: %w", spec.Executable, err)
	}

	policy := r.PermissionPolicy
	if policy == "" {
		policy = PermissionDeny
	}

	h := &handle{
		policy:  policy,
		decider: opts.Decider,
		logger:  r.Logger,
		stderr:  stderr,
		cmd:     cmd,
		stdin:   stdin,
	}
	h.conn = acp.NewClientSideConnection(h, stdin, stdout)
	h.attachProcess(cmd, stdout)

	// The handshake is bounded on the caller's context: the caller may be
	// unbounded (an attempt without a node timeoutSeconds), and a peer that
	// answers no initialize must not be waited out forever (handshakeTimeout).
	hctx, hcancel := context.WithTimeout(ctx, handshakeTimeout)
	defer hcancel()

	if err := h.handshake(hctx, spec, opts); err != nil {
		// Reap the process before reporting failure.
		_ = h.Close()
		return nil, err
	}
	return h, nil
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

// waitDelay bounds cmd.Wait's wait for the stdio copy goroutines once the
// harness process is gone. A grandchild that escaped the process group may
// still hold the stderr pipe; this is the wall that keeps the worker from
// waiting that orphan out forever.
const waitDelay = 10 * time.Second

// handshakeTimeout bounds the initialize + session/load + session/new (+
// set_mode) sequence against a live but unresponsive peer. It runs on the
// caller's context, which on the worker's attempt path carries no deadline
// of its own (a node without timeoutSeconds stamps deadline_at NULL and the
// attempt context is unbounded) — so without this bound a harness that
// starts its process and never answers initialize parks the whole worker:
// the claim loop behind it, the retry claim waiting for its terminal, the
// gate that the run's approval owes its open (worker-stall-2, lab run
// 41921504494: 17 minutes of silence, one "connection closed" at teardown).
// A healthy agent answers in well under a second; 30 s is generous, and
// spending it fails the session honestly so the worker moves on. A var so
// tests drive the bound.
var handshakeTimeout = 30 * time.Second

// maxStderrBytes bounds captured agent stderr to the last 64 KiB.
const maxStderrBytes = 64 * 1024

var _ io.Writer = (*ringBuffer)(nil)
