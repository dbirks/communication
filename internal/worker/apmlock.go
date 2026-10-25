package worker

// ADR-0054 amendment 1 (server-side APM lock, implementation): the lock
// request queue's worker half. The control plane (api) is the only writer of
// profile state; a worker is the only process that resolves a package ref, so
// the lock flow is: the control plane inserts a queued `apm_lock_requests` row
// and the worker claims it, resolves it in a sandboxed child of the worker —
// the pinned apm CLI under the apm-resolve sandbox (scratch work dir + scratch
// home rw, package-source egress allowlist, never --block-net), and reports
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
	"path/filepath"
	"sync"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
)

// DefaultAPMLockResolveTimeout bounds one lock resolve. A resolving install
// fetches the package source and APM's registry, so it is the one step of the
// flow that can be slow or hung; the lease a claim takes must not outlive the
// deadline, or a wedged resolve would hold a claim forever.
const DefaultAPMLockResolveTimeout = 5 * time.Minute

// DefaultAPMLockScratchRoot names the directory the APM lock resolve's scratch
// work dir + scratch home are created under: a directory INSIDE the worker-owned
// workspace volume (`<workspace root>/.apm-lock`). The resolve's scratch is a
// sandbox grant, and the grant rules refuse a writable grant under the temp tree
// the sandbox layers by default (probe C-TMP1), so the root may not be the temp
// tree; workspace paths are what agent turns get granted, so a workspace-rooted
// root is grantable. The workspace root's own PARENT is not guaranteed writable
// inside the container (the lab's worker mounts the volume at /workspaces, whose
// parent / is not), which is how the lock loop came to default to a root that
// never came to exist.
func DefaultAPMLockScratchRoot(workspaceRoot string) string {
	return filepath.Join(workspaceRoot, ".apm-lock")
}

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

// APMLockResolveWrap is the worker-supplied launcher wrapper shape for one APM
// lock resolve: it takes the resolving install's argv and the apm child
// environment and returns the exec'd (path, args, env) — the worker answers with
// a nono-sandboxed launch (ADR-0054 §B.2), so the resolve never execs the pinned
// apm CLI as a plain worker child.
type APMLockResolveWrap func(argv []string, env []string) (string, []string, []string, error)

// APMLockResolver is the lock flow's resolve seam from the loop's side: it runs
// one claimed lock's resolve through the worker's sandbox discipline (ADR-0054
// §B.2) and answers plainly when the worker's enforcement mode does not require
// one. The worker implements it with APMSandbox; the plain APMTyper-shaped seam is
// the fallback that answers plainly.
type APMLockResolver interface {
	// Resolve runs one resolve and reports its result.
	Resolve(ctx context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error)
	// Wrap answers one resolve's launcher-wrapper request; nil when the resolve
	// may run plain. The second answer releases the resolve's private sandbox
	// profile dir and must be called once the resolve is over, whatever its
	// outcome (it is a no-op when no policy was materialized).
	Wrap(ctx context.Context, req apm.ResolveRequest) (APMLockResolveWrap, func(), error)
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

	// sandbox runs the claimed lock's resolve through the worker's sandbox
	// discipline (ADR-0054 §B.2). Nil keeps the loop on the plain resolve seam.
	sandbox APMLockResolver
	// scratchRoot is where the resolve's scratch dirs live; empty means the temp
	// tree, which a sandboxed resolve may not grant (probe C-TMP1).
	scratchRoot string

	mu     sync.Mutex
	stopCh chan struct{}
	closed bool

	running sync.WaitGroup

	// cfg tunes the claim cadence; clock drives it (tests inject a fake).
	cfg   APMLockConfig
	clock Clock
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

// WithAPMLockClock replaces the loop's clock (tests drive cadence).
func WithAPMLockClock(c Clock) APMLockOption {
	return func(loop *APMLockLoop) {
		if c != nil {
			loop.clock = c
		}
	}
}

// WithAPMLockSandbox replaces the resolve seam the loop drives; the resolve then
// runs through the worker's sandbox when the enforcement mode requires it
// (ADR-0054 §B.2), and answers plainly when it does not.
func WithAPMLockSandbox(s APMLockResolver) APMLockOption {
	return func(loop *APMLockLoop) {
		if s != nil {
			loop.sandbox = s
		}
	}
}

// WithAPMLockScratchRoot names the directory the resolve's scratch dirs are
// created under. It must live outside the temp tree the sandbox refuses to grant
// (a /tmp grant is denied by omission, probe C-TMP1), so a required-mode resolve
// can never be refused for its own scratch location; the worker wiring defaults
// it to DefaultAPMLockScratchRoot — a directory inside the worker-owned workspace
// volume — overridable via COMMUNICATION_APM_LOCK_SCRATCH for a worker whose
// workspace root is not writable.
func WithAPMLockScratchRoot(dir string) APMLockOption {
	return func(loop *APMLockLoop) {
		if loop != nil {
			loop.scratchRoot = dir
		}
	}
}

// APMLockConfig tunes the lock-claim loop; zero values take the defaults.
type APMLockConfig struct {
	// ClaimInterval is how often the loop scans the due queue while idle — the
	// lock half of the worker family's claim cadence (the turn loop's
	// DefaultClaimInterval: a 1 s poll). The queue is not watched, it is polled,
	// so an idle loop has to keep asking until a row lands or shutdown arrives;
	// without the tick the loop claims once and then parks in its shutdown
	// select forever, and a lock queued after startup is never picked up.
	ClaimInterval time.Duration
}

// normalise fills in the default claim interval.
func (c APMLockConfig) normalise() (APMLockConfig, error) {
	if c.ClaimInterval <= 0 {
		c.ClaimInterval = DefaultClaimInterval
	}
	return c, nil
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
		cfg:      APMLockConfig{},
		clock:    realClock{},
	}
	for _, o := range opts {
		o(l)
	}
	norm, err := l.cfg.normalise()
	if err != nil {
		return nil, err
	}
	l.cfg = norm
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
		// Reserve a running slot under the loop mutex BEFORE claiming: Drain
		// sets closed under the same mutex and only then enters
		// running.Wait, so a reservation made while the loop is not closed
		// can never race a Wait that has started — the WaitGroup is
		// reserved before it can be waited on. An empty or failed claim
		// gives the reservation straight back.
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil
		}
		l.running.Add(1)
		l.mu.Unlock()
		c, ok, err := l.store.ClaimAPMLockRequest(ctx, workerID)
		switch {
		case err != nil:
			l.running.Done()
			if ctx.Err() != nil || l.stopping() {
				return nil
			}
			l.log.Error("apm lock claim failed",
				slog.String("worker_id", workerID), slog.String("error", err.Error()))
		case ok:
			l.log.Info("apm lock claimed",
				slog.String("request_id", c.RequestID),
				slog.String("profile_id", c.ProfileID),
				slog.String("worker_id", c.WorkerID))
			// done wakes the wait below when this resolve settles; waiting on the
			// resolve itself (not only on shutdown) is what lets the loop claim
			// the next lock instead of parking in this select forever. The
			// resolve goroutine owns the reservation: Done lands when it
			// settles, so Drain's running.Wait waits for exactly this resolve.
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer l.running.Done()
				l.run(ctx, c)
			}()
			select {
			case <-done:
				// The resolve has settled: claim the next request right away,
				// without another idle tick.
				continue
			case <-ctx.Done():
				return nil
			case <-l.stopCh:
				return nil
			}
		default:
			l.running.Done()
		}
		// Idle: wait for the next claim tick, shutdown, or stop. The tick is what
		// keeps the queue scanned — without it the loop parks here forever after
		// its first (empty) claim and never picks up a lock queued later.
		timer := l.clock.After(l.cfg.ClaimInterval)
		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		case <-timer:
		}
	}
}

// run executes one claimed lock: a fresh scratch dir + fresh HOME for the
// resolve child, the resolver's Resolve (which runs the resolve through the
// worker's sandbox under ADR-0054 §B.2 when the mode requires it), then the
// report back through the store.
// The scratch dirs are removed when the resolve is done, whether it succeeded
// or failed — a resolve owns its scratch dir and never leaves content behind.
func (l *APMLockLoop) run(ctx context.Context, c APMLockClaim) {
	workdir, err := os.MkdirTemp(l.scratchRoot, "apm-lock-")
	if err != nil {
		l.settle(ctx, c, nil, err)
		return
	}
	defer os.RemoveAll(workdir)
	home, err := os.MkdirTemp(l.scratchRoot, "apm-lock-home-")
	if err != nil {
		l.settle(ctx, c, nil, err)
		return
	}
	defer os.RemoveAll(home)
	res, err := l.apmResolve(ctx, c, workdir, home)
	l.settle(ctx, c, res, err)
}

// apmResolve drives one claimed lock's resolve. The control plane owns the
// queue and the report; the worker owns the exec, which — under its required
// enforcement mode — runs through the sandboxed launcher wrapper (ADR-0054 §B.2),
// never as a plain worker child. Under a mode that does not require a sandboxed
// resolve the loop keeps the plain seam and the result reports Sandboxed=false.
func (l *APMLockLoop) apmResolve(ctx context.Context, c APMLockClaim, workdir, home string) (*apm.ResolveResult, error) {
	req := apm.ResolveRequest{
		PackageRef: c.PackageRef,
		Target:     c.Target,
		WorkDir:    workdir,
		Home:       home,
		Timeout:    DefaultAPMLockResolveTimeout,
	}
	if l.sandbox != nil {
		wrap, closePolicy, err := l.sandbox.Wrap(ctx, req)
		// The resolve owns the private profile dir its launch names, and the
		// scratch dirs above are removed the same way: nothing about one claimed
		// lock outlives the lock.
		defer closePolicy()
		if err != nil {
			return nil, err
		}
		if wrap != nil {
			req.Wrap = wrap
		}
	}
	return l.apm.Resolve(ctx, req)
}

// settle reports the resolve outcome for one claimed lock. A resolve that did
// not answer (ctx cancelled mid-install) is reported as the failure it is; the
// store writes the failed status and nothing else.
func (l *APMLockLoop) settle(ctx context.Context, c APMLockClaim, res *apm.ResolveResult, err error) {
	if err != nil {
		l.log.Warn("apm lock resolve failed",
			slog.String("request_id", c.RequestID),
			slog.String("profile_id", c.ProfileID),
			slog.String("error", err.Error()))
		_ = l.store.CompleteAPMLockRequest(ctx, c, nil, err)
		return
	}
	l.log.Info("apm lock resolve completed",
		slog.String("request_id", c.RequestID),
		slog.String("profile_id", c.ProfileID),
		slog.Bool("sandboxed", res != nil && res.Sandboxed))
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
