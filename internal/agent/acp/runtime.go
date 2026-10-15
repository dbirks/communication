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

	if err := h.handshake(ctx, spec, opts); err != nil {
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

// maxStderrBytes bounds captured agent stderr to the last 64 KiB.
const maxStderrBytes = 64 * 1024

var _ io.Writer = (*ringBuffer)(nil)
