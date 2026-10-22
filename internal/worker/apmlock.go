package worker

// ADR-0054 amendment 1 (server-side APM lock, implementation): the lock
// request queue's worker half. The control plane (api) is the only writer of
// profile state; a worker is the only process that resolves a package ref, so
// the lock flow is: the control plane inserts a queued `apm_lock_requests` row
// and the worker claims it, resolves it in a sandboxed scratch dir, and reports
// the result back — which the control plane records as the profile's lock
// digest + contents summary and journals `agent.profile.apm_locked`.
//
// The claim idiom is the worker family's own: FOR UPDATE SKIP LOCKED plus a
// lease, the same shape the turn and attempt claims use (ADR-0016 §3, ADR-0023
// §4) — no new transport, no new queue semantics.

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
)

// DefaultAPMLockResolveTimeout bounds one lock resolve. A resolving install
// fetches the package source and APM's registry, so it is the one step of the
// flow that can be slow or hung; the lease a claim takes must not outlive the
// deadline, or a wedged resolve would hold a claim forever.
const DefaultAPMLockResolveTimeout = 5 * time.Minute

// APMLockClaim is one lock request won by APMLockStore.ClaimAPMLockRequest:
// the lease triple (request id, worker id, lease deadline) plus the pin the
// resolve is asked to lock.
type APMLockClaim struct {
	RequestID      string
	ProfileID      string
	OrganizationID string
	PackageRef     string
	Target         string
	WorkerID       string
	LeaseExpiresAt *time.Time
}

// APMLockStore is the lock-request queue's persistence port, implemented by the
// Postgres adapter. The claim is a fenced write in the same sense as a turn or
// attempt lease: a worker that reports on a request it no longer owns is told
// the lease was lost, and a stale owner writes nothing.
type APMLockStore interface {
	// ClaimAPMLockRequest wins at most one due lock request for workerID
	// (FOR UPDATE SKIP LOCKED over the queued/due rows, lease from now +
	// DefaultAPMLockResolveTimeout). The loser of a concurrent claim skips the
	// winner's row instead of waiting for it. No due request → ok=false, nil.
	ClaimAPMLockRequest(ctx context.Context, workerID string) (APMLockClaim, bool, error)

	// CompleteAPMLockRequest closes a claimed lock request in one transaction:
	// on a successful resolve it writes the profile's apm_lock_digest +
	// apm_contents_summary and appends agent.profile.apm_locked (state and
	// journal in one tx, ADR-0013); on a failure it marks the request failed
	// and writes nothing. A report against a lease this worker no longer holds
	// fails with ErrLeaseLost and writes nothing.
	CompleteAPMLockRequest(ctx context.Context, c APMLockClaim, result *apm.ResolveResult, resolveErr error) error
}

// APMLockLoop claims queued APM lock requests and drives the resolve. It is
// the worker-side twin of the turn/attempt loops: claims, runs, closes —
// but a lock is a single short-lived job (one resolve, no transcript), so the
// loop runs one at a time per worker.
type APMLockLoop struct {
	store    APMLockStore
	apm      APMTyper
	workerID func() string
	log      *slog.Logger

	mu     sync.Mutex
	stopCh chan struct{}
	closed bool

	inflight atomic.Int64
	running  sync.WaitGroup
}

// APMLockOption customises the loop.
type APMLockOption func(*APMLockLoop)

// WithAPMLockLogger replaces the loop logger; nil keeps slog.Default.
func WithAPMLockLogger(l *slog.Logger) APMLockOption {
	return func(loop *APMLockLoop) {
		if loop != nil {
			loop.log = l
		}
	}
}

// NewAPMLockLoop validates its ports and returns an idle loop. workerID is
// resolved after registration, same shape as the other loops.
func NewAPMLockLoop(store APMLockStore, apm APMTyper, workerID func() string, opts ...APMLockOption) (*APMLockLoop, error) {
	if store == nil {
		return nil, errors.New("worker: apm lock loop requires a store")
	}
	if workerID == nil {
		return nil, errors.New("worker: apm lock loop requires a worker-id provider")
	}
	l := &APMLockLoop{
		store:    store,
		apm:      apm,
		workerID: workerID,
		log:      slog.Default(),
		stopCh:   make(chan struct{}),
	}
	for _, o := range opts {
		o(l)
	}
	return l, nil
}

// Start runs the lock-claim loop until ctx ends or Drain is called. Each
// claimed request runs its resolve on its own goroutine; Start claims one at a
// time and waits for the previous resolve to settle before claiming the next,
// so a single worker never resolves two locks at once (the queue arbitrates
// between workers).
func (l *APMLockLoop) Start(ctx context.Context) error {
	workerID := l.workerID()
	if workerID == "" {
		return errors.New("worker: apm lock loop started before the worker registered")
	}
	if ctx == nil {
		return errors.New("worker: Start requires a context")
	}
	l.log.Info("apm lock loop starting", slog.String("worker_id", workerID))
	for {
		if l.stopping() || ctx.Err() != nil {
			return nil
		}
		c, ok, err := l.store.ClaimAPMLockRequest(ctx, workerID)
		if err != nil {
			if ctx.Err() != nil || l.stopping() {
				return nil
			}
			l.log.Warn("apm lock claim failed", slog.String("error", err.Error()))
		}
		if ok {
			l.inflight.Add(1)
			go func() {
				defer func() { l.inflight.Add(-1) }()
				l.run(ctx, c)
			}()
			for l.inflight.Load() > 0 {
				select {
				case <-ctx.Done():
					return nil
				case <-l.stopCh:
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		}
	}
}

// run executes one claimed lock: a fresh scratch dir + fresh HOME for the
// resolve child, the seam's Resolve, then the report back through the store.
// The scratch dirs are removed when the resolve is done, whether it succeeded
// or failed — a resolve owns its scratch dir and never leaves content behind.
func (l *APMLockLoop) run(ctx context.Context, c APMLockClaim) {
	l.running.Add(1)
	defer l.running.Done()
	workdir, err := os.MkdirTemp("", "apm-lock-")
	if err != nil {
		l.settle(ctx, c, nil, err)
		return
	}
	defer os.RemoveAll(workdir)
	home, err := os.MkdirTemp("", "apm-lock-home-")
	if err != nil {
		l.settle(ctx, c, nil, err)
		return
	}
	defer os.RemoveAll(home)
	res, err := l.apm.Resolve(ctx, apm.ResolveRequest{
		PackageRef: c.PackageRef,
		Target:     c.Target,
		WorkDir:    workdir,
		Home:       home,
	})
	l.settle(ctx, c, res, err)
}

// settle reports the resolve outcome for one claimed lock. A resolve that did
// not answer (ctx cancelled mid-install) is reported as the failure it is; the
// store writes the failed status and nothing else.
func (l *APMLockLoop) settle(ctx context.Context, c APMLockClaim, res *apm.ResolveResult, err error) {
	if err != nil {
		_ = l.store.CompleteAPMLockRequest(ctx, c, nil, err)
		return
	}
	_ = l.store.CompleteAPMLockRequest(ctx, c, res, nil)
}

// Drain implements the shutdown hook of the worker loop: stop claiming and
// wait for the in-flight resolves to settle before the process exits.
func (l *APMLockLoop) Drain(ctx context.Context) error {
	l.mu.Lock()
	if !l.closed {
		l.closed = true
		close(l.stopCh)
	}
	l.mu.Unlock()
	l.log.Info("apm lock drain: waiting for in-flight resolves")
	done := make(chan struct{})
	go func() {
		l.running.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *APMLockLoop) stopping() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}
