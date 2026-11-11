// Package acp implements domain.AgentRuntime on top of the ACP
// (Agent Client Protocol) JSON-RPC protocol using
// github.com/coder/acp-go-sdk.
package acp

import (
	"context"
	"errors"
	"log/slog"
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
	// Transporter starts the launch and owns the stdio the protocol rides.
	// Nil means ProcTransporter{} — a local child process, which is every
	// caller today (ADR-0082 §8). A pod-shaped Transporter is what Kubernetes
	// mode injects here, so nothing below this line may assume a local pid.
	Transporter Transporter
}

var _ domain.AgentRuntime = (*Runtime)(nil)

// transporterOrDefault is the seam's default: a nil Transporter launches the
// plan as a local child process, which is what every caller built before
// ADR-0082 §8 and what they build still.
func (r *Runtime) transporterOrDefault() Transporter {
	if r.Transporter == nil {
		return ProcTransporter{}
	}
	return r.Transporter
}

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

	// The spec is the plan by the time it reaches here: Factory.NewSession has
	// already preferred the verified sandbox plan over the registry argv, so
	// what the transport execs is the object the turn loop journalled. The
	// Transporter owns everything below the exec — environment, process group,
	// pipes (ADR-0082 §8).
	transporter := r.transporterOrDefault()
	tr, err := transporter.Start(ctx, LaunchPlan{
		Path: spec.Executable,
		Args: spec.Args,
		Env:  spec.Env,
		Dir:  spec.WorkDir,
	})
	if err != nil {
		return nil, err
	}

	policy := r.PermissionPolicy
	if policy == "" {
		policy = PermissionDeny
	}

	h := &handle{
		policy:    policy,
		decider:   opts.Decider,
		logger:    r.Logger,
		stderr:    stderrRingOf(tr),
		transport: tr,
		stdin:     tr.Stdin(),
	}
	h.conn = acp.NewClientSideConnection(h, tr.Stdin(), tr.Stdout())
	h.attachProcess(tr)

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
