package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// M4 attempt cadence (docs/m4-contract.md § 4/§ 6): the attempt lease is 30 s
// renewed every 10 s in one statement together with the turn's lease (§ 4
// step 6), the cancel flag is re-read on the renewal-adjacent tick (§ 4 step
// 11), and claims batch against free capacity (§ 4 step 2). RenewInterval,
// ClaimInterval and CancelPoll reuse M2's defaults (turnloop.go).
const (
	DefaultAttemptCapacity      = 1
	MaxAttemptCapacity          = 16 // workers.capacity's CHECK bound (contract § 1)
	DefaultAttemptDrainGrace    = 10 * time.Second
	attemptTerminalWriteTimeout = 10 * time.Second
)

// AttemptConfig tunes the attempt loop; zero values take the defaults.
// Capacity mirrors workers.capacity (§ 4 step 1: the heartbeat publishes it
// so the claim predicate's wr.active_attempts < wr.capacity is real).
type AttemptConfig struct {
	Capacity      int
	ClaimInterval time.Duration
	RenewInterval time.Duration
	CancelPoll    time.Duration
	DrainGrace    time.Duration
}

func (c AttemptConfig) normalise() (AttemptConfig, error) {
	if c.Capacity <= 0 {
		c.Capacity = DefaultAttemptCapacity
	}
	if c.Capacity > MaxAttemptCapacity {
		return c, fmt.Errorf("%w: attempt capacity %d exceeds the %d ceiling (workers.capacity CHECK)",
			ErrInvalidConfig, c.Capacity, MaxAttemptCapacity)
	}
	if c.ClaimInterval <= 0 {
		c.ClaimInterval = DefaultClaimInterval
	}
	if c.RenewInterval <= 0 {
		c.RenewInterval = DefaultRenewInterval
	}
	if c.CancelPoll <= 0 {
		c.CancelPoll = DefaultCancelPoll
	}
	if c.DrainGrace <= 0 {
		c.DrainGrace = DefaultAttemptDrainGrace
	}
	return c, nil
}

// AttemptResult is an executor's honest answer for one attempt. Status is
// one of the four terminal attempt statuses, or "" meaning "the attempt body
// was stopped before it could speak" — the loop then reads its own flags
// (shutdown / cancel-requested / lease loss) to pick the honest terminal.
type AttemptResult struct {
	Status string

	// succeeded payload: exactly what CompleteAttempt takes (the boundary
	// transaction, contract § 4 step 10).
	Outputs       any
	OutputsDigest string
	ArtifactRefs  []any
	Outcome       string
	Checkpoint    AttemptCheckpoint

	// failed payload.
	ErrorClass   string
	Detail       string
	OutputErrors []any

	// cancelled/interrupted payload; empty takes the loop's default reason.
	CancelReason    string
	InterruptReason string
}

// AttemptSink is what an in-flight attempt body may use: fenced journal
// appends and the graceful-stop signal. Stopping closes when drain begins
// ("finish honestly, you have the grace window"); hard stops (lease loss,
// cancel-requested, node deadline) arrive as cancellation of the context
// handed to Execute instead.
type AttemptSink interface {
	AppendEvent(ctx context.Context, ev AttemptEvent) error
	Stopping() <-chan struct{}
}

// AttemptExecutor runs one attempt body. The M4 waves wire one per node kind
// (agent.acp per § 4 step 6, process.exec per step 7, model.chat per step 8,
// artifact.publish per step 9); this wave defines the seam and the honest
// refusal for kinds not yet landed.
type AttemptExecutor interface {
	Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error)
}

// AttemptExecutors routes kinds to executors. A kind with no entry lands on
// refusalExecutor rather than hanging or pretending (contract § 0: kinds land
// incrementally, and § 4 step 14: never claim a capability that has not been
// proven).
type AttemptExecutors map[string]AttemptExecutor

func (m AttemptExecutors) lookup(kind string) AttemptExecutor {
	if e := m[kind]; e != nil {
		return e
	}
	return refusalExecutor{}
}

// refusalExecutor honestly fails any kind it is handed. § 0 names model.chat
// the first sacrifice if the exit gate needs room; a worker running without
// an executor for a claimed kind reports that as a fact, it does not fake a
// success or hold the lease doing nothing.
type refusalExecutor struct{}

var _ AttemptExecutor = refusalExecutor{}

func (refusalExecutor) Execute(_ context.Context, c AttemptClaim, _ AttemptSink) (AttemptResult, error) {
	return AttemptResult{
		Status:     AttemptStatusFailed,
		ErrorClass: ErrorClassInfra,
		Detail: bounded("worker: no executor for node kind "+c.Kind+
			" on this worker (contract § 0: kinds land incrementally)", 512),
	}, nil
}

// AttemptLoop claims and executes pipeline attempts for one worker process
// (docs/m4-contract.md § 4): claim a batch for the free capacity → begin
// fenced → renew attempt+turn on one tick, watch for cancel-requested →
// dispatch the kind's executor → close the attempt honestly in one fenced
// transaction, or write nothing at all once the fence has proved us stale
// (contract § 4 step 10, `12` case 3). Unlike M2's TurnLoop it runs up to
// Capacity attempts concurrently — capacity accounting becomes load-bearing
// the moment attempts exist (ADR-0023 § 4).
//
// It is deliberately not built on the M2 turn claim: conversation_turns
// keeps claiming exactly as before for human-initiated turns, and M4's agent
// turns arrive through the stamped node_attempt_id link (§ 4 step 6), not
// through this loop's claiming (§ 4 step 2).
type AttemptLoop struct {
	cfg   AttemptConfig
	store AttemptStore
	execs AttemptExecutors
	clock Clock
	log   *slog.Logger
	idFn  func() string

	mu     sync.Mutex
	active map[string]*runningAttempt // attempt id → in flight
	stopCh chan struct{}              // closed by Drain: stop claiming
	closed bool

	inflight     atomic.Int64 // attempts in flight, against cfg.Capacity
	running      sync.WaitGroup
	attemptsDone atomic.Int64
}

// AttemptOption customises an AttemptLoop.
type AttemptOption func(*AttemptLoop)

// WithAttemptClock replaces the loop's clock (tests drive cadence).
func WithAttemptClock(c Clock) AttemptOption {
	return func(l *AttemptLoop) {
		if c != nil {
			l.clock = c
		}
	}
}

// WithAttemptLogger replaces the loop logger; nil keeps slog.Default.
func WithAttemptLogger(l *slog.Logger) AttemptOption {
	return func(t *AttemptLoop) {
		if l != nil {
			t.log = l
		}
	}
}

// NewAttemptLoop validates its ports and returns an idle loop. workerID is
// resolved after registration, same shape as NewTurnLoop.
func NewAttemptLoop(cfg AttemptConfig, store AttemptStore, execs AttemptExecutors, workerID func() string, opts ...AttemptOption) (*AttemptLoop, error) {
	if store == nil {
		return nil, errors.New("worker: attempt loop requires a store")
	}
	if workerID == nil {
		return nil, errors.New("worker: attempt loop requires a worker-id provider")
	}
	norm, err := cfg.normalise()
	if err != nil {
		return nil, err
	}
	l := &AttemptLoop{
		cfg:    norm,
		store:  store,
		execs:  execs,
		clock:  realClock{},
		log:    slog.Default(),
		idFn:   workerID,
		active: map[string]*runningAttempt{},
		stopCh: make(chan struct{}),
	}
	for _, o := range opts {
		o(l)
	}
	return l, nil
}

// Start runs the claim loop until ctx ends or Drain is called. Each claimed
// attempt runs on its own goroutine (the batch is free capacity, § 4 step
// 2); Start itself only ever claims.
func (l *AttemptLoop) Start(ctx context.Context) error {
	workerID := l.idFn()
	if workerID == "" {
		return errors.New("worker: attempt loop started before the worker registered")
	}
	if ctx == nil {
		return errors.New("worker: Start requires a context")
	}
	l.log.Info("attempt loop starting",
		slog.String("worker_id", workerID),
		slog.Int("capacity", l.cfg.Capacity),
		slog.Duration("renew", l.cfg.RenewInterval),
	)
	for {
		if l.stopping() || ctx.Err() != nil {
			return nil
		}
		free := l.cfg.Capacity - int(l.inflight.Load())
		if free > 0 {
			claims, err := l.store.ClaimAttempts(ctx, workerID, free)
			if err != nil {
				if ctx.Err() != nil || l.stopping() {
					return nil
				}
				l.log.Warn("attempt claim failed", slog.String("error", err.Error()))
			}
			for _, c := range claims {
				l.running.Add(1)
				l.inflight.Add(1)
				go l.runAttempt(ctx, c)
			}
			if len(claims) > 0 {
				continue
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		case <-l.clock.After(l.cfg.ClaimInterval):
		}
	}
}

// Drain implements the shutdown hook of the worker loop (§ 4 step 12): stop
// claiming, ask the in-flight attempts to finish honestly within DrainGrace
// (Stopping closes; the executor context does NOT), then hard-cancel the
// stragglers so they close as interrupted{worker_shutdown}. The passed ctx
// is already detached from the run context, as in Worker.Drain.
func (l *AttemptLoop) Drain(ctx context.Context) error {
	l.mu.Lock()
	if !l.closed {
		l.closed = true
		close(l.stopCh)
	}
	active := make([]*runningAttempt, 0, len(l.active))
	for _, rt := range l.active {
		active = append(active, rt)
	}
	l.mu.Unlock()

	l.log.Info("attempt drain: stopping claims",
		slog.Int("in_flight", len(active)),
		slog.Duration("grace", l.cfg.DrainGrace))
	for _, rt := range active {
		rt.requestStop()
	}

	done := make(chan struct{})
	go func() {
		l.running.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-l.clock.After(l.cfg.DrainGrace):
	}

	// Grace spent: the remaining attempts can no longer finish honestly, so
	// stop their bodies and require the interrupted terminal to be written
	// before returning (never orphan a lease the worker can still speak for).
	l.mu.Lock()
	stragglers := make([]*runningAttempt, 0, len(l.active))
	for _, rt := range l.active {
		stragglers = append(stragglers, rt)
	}
	l.mu.Unlock()
	for _, rt := range stragglers {
		rt.cancel()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return errors.New("worker: attempt drain ended before the in-flight attempts wrote their terminal state")
	}
}

// stopping reports whether Drain has begun.
func (l *AttemptLoop) stopping() bool {
	select {
	case <-l.stopCh:
		return true
	default:
		return false
	}
}

// attemptsCompleted reports finished attempts (tests poll it).
func (l *AttemptLoop) attemptsCompleted() int64 { return l.attemptsDone.Load() }

// runningAttempt is one claimed attempt in flight; it owns the flags that
// decide the honest terminal, mirroring runningTurn.
type runningAttempt struct {
	loop  *AttemptLoop
	claim AttemptClaim

	cancel func()

	shutdown        atomic.Bool // drain in progress
	lostLease       atomic.Bool // a fenced write proved this worker is stale
	cancelRequested atomic.Bool // cancel_requested_at observed

	stopCh   chan struct{} // graceful-stop ask (drain); closed once
	stopOnce sync.Once
}

// requestStop asks the executor to finish honestly.
func (rt *runningAttempt) requestStop() {
	rt.shutdown.Store(true)
	rt.stopOnce.Do(func() { close(rt.stopCh) })
}

// noteLeaseLost is the ONE place the silent fence-refusal paths (begin,
// cancel watch, live journal append) record that the store refused this
// worker's fenced write. Contract § 7.1 C4c: the stale owner's refusal must
// be observable in its own log, never a silent stop — logged once per
// attempt at warn with the attempt id and the now-stale fencing token.
func (rt *runningAttempt) noteLeaseLost(write string) {
	if !rt.lostLease.Swap(true) {
		rt.loop.log.Warn("fenced write refused: this worker is the stale owner (lease lost)",
			slog.String("attempt_id", rt.claim.AttemptID),
			slog.Int64("fencing_token", rt.claim.FencingToken),
			slog.String("write", write))
	}
}

// runAttempt executes one claimed attempt end to end and always tries to
// write an honest terminal — unless the fencing token proved us stale, in
// which case writing nothing IS the honest answer (runner.go's rule, ADR-0016
// § 9 obligation 2, contract § 4 step 10).
func (l *AttemptLoop) runAttempt(ctx context.Context, c AttemptClaim) {
	defer func() {
		l.inflight.Add(-1)
		l.running.Done()
		l.attemptsDone.Add(1)
	}()
	base := context.WithoutCancel(ctx)
	actx, acancel := context.WithCancel(base)
	defer acancel()
	if !c.DeadlineAt.IsZero() {
		dctx, dcancel := context.WithDeadline(actx, c.DeadlineAt)
		actx = dctx
		defer dcancel()
	}

	rt := &runningAttempt{loop: l, claim: c, cancel: acancel, stopCh: make(chan struct{})}
	l.mu.Lock()
	l.active[c.AttemptID] = rt
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.active, c.AttemptID)
		l.mu.Unlock()
	}()

	if err := l.store.BeginAttempt(actx, c); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			rt.noteLeaseLost("begin")
			return
		}
		l.log.Error("begin attempt failed", slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		l.closeAttempt(base, rt, AttemptResult{Status: AttemptStatusFailed, ErrorClass: ErrorClassInfra, Detail: bounded(err.Error(), 512)}, nil)
		return
	}

	// Lease renewal: every RenewInterval, fenced, one statement covering
	// attempt+turn (§ 4 step 6). Cancel watch: § 4 step 11's first sighting.
	go l.attemptRenewLoop(actx, base, c, rt)
	go l.attemptCancelWatch(actx, base, c, rt)

	res, execErr := l.execs.lookup(c.Kind).Execute(actx, c, attemptSink{rt: rt})
	l.closeAttempt(base, rt, res, execErr)
}

// attemptRenewLoop mirrors renewLoop: a rejected renewal is the
// authoritative word that we are stale.
func (l *AttemptLoop) attemptRenewLoop(tctx, base context.Context, c AttemptClaim, rt *runningAttempt) {
	for {
		select {
		case <-tctx.Done():
			return
		case <-l.clock.After(l.cfg.RenewInterval):
		}
		ctx, cancel := context.WithTimeout(base, l.cfg.RenewInterval)
		err := l.store.RenewAttempt(ctx, c)
		cancel()
		if errors.Is(err, ErrLeaseLost) {
			l.log.Warn("attempt lease lost; stopping all writes for the attempt",
				slog.String("attempt_id", c.AttemptID))
			rt.lostLease.Store(true)
			rt.cancel()
			return
		}
		if err != nil {
			l.log.Warn("attempt lease renewal failed (retrying next tick)",
				slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		}
	}
}

// attemptCancelWatch mirrors cancelWatch: it re-reads the attempt's cancel
// flag (written by the advancer's cascade or the reconciler's deadline pass)
// and forwards the first sighting to the executor. The grace window between
// "ask" and "kill" belongs to the process group / ACP session the executor
// owns (§ 4 step 11), so the forwarding here is the stop signal, not the
// kill.
func (l *AttemptLoop) attemptCancelWatch(tctx, _ context.Context, c AttemptClaim, rt *runningAttempt) {
	for {
		at, ok, err := l.store.CancelRequestedAttempt(tctx, c)
		switch {
		case errors.Is(err, ErrLeaseLost):
			rt.noteLeaseLost("cancel_watch")
			rt.cancel()
			return
		case err != nil:
			if tctx.Err() != nil {
				return
			}
		case ok && !at.IsZero():
			if !rt.cancelRequested.Swap(true) {
				l.log.Info("cancel requested; stopping the attempt body",
					slog.String("attempt_id", c.AttemptID),
					slog.String("requested_at", at.UTC().Format(time.RFC3339)))
				rt.cancel()
			}
			return
		}
		select {
		case <-tctx.Done():
			return
		case <-l.clock.After(l.cfg.CancelPoll):
		}
	}
}

// closeAttempt maps the executor's answer and the loop's flags onto exactly
// one fenced terminal write — modelled on mapOutcome: the honest word, not
// the convenient one.
func (l *AttemptLoop) closeAttempt(base context.Context, rt *runningAttempt, res AttemptResult, execErr error) {
	c := rt.claim
	switch {
	case rt.lostLease.Load():
		// Somebody else owns the attempt now; writing nothing is the honest
		// answer (runner.go:83-86's abandon rule).
		return

	case res.Status == AttemptStatusSucceeded:
		l.fenced(base, rt, func(ctx context.Context) error {
			return l.store.CompleteAttempt(ctx, c, res.Outputs, res.OutputsDigest,
				nzAny(res.ArtifactRefs), res.Outcome, res.Checkpoint)
		})

	case res.Status == AttemptStatusFailed:
		class := res.ErrorClass
		if class == "" {
			class = ErrorClassInfra // attempts_failed_has_class: a class is mandatory
		}
		l.fenced(base, rt, func(ctx context.Context) error {
			return l.store.FailAttempt(ctx, c, class, bounded(res.Detail, 512), nzAny(res.OutputErrors))
		})

	case res.Status == AttemptStatusCancelled:
		l.cancelOwn(base, rt, res.CancelReason)

	case res.Status == AttemptStatusInterrupted:
		// The executor's protocol word outranks the loop's flags: when the
		// ACP cancel never came back acked, § 4 step 11 names the honest
		// terminal interrupted{process_group_kill_timeout}, not a cancelled
		// claiming an ack nobody received.
		l.interruptOwn(base, rt, res.InterruptReason)

	case rt.cancelRequested.Load():
		// The cancel is why the body stopped; the reason naming belongs to
		// the executor's protocol knowledge (§ 4 step 11), defaulting to the
		// ack we did receive: the body stopped.
		l.cancelOwn(base, rt, res.CancelReason)

	case rt.shutdown.Load():
		// We are leaving; the body could not finish inside the grace. The
		// honest word is interrupted{worker_shutdown} (§ 4 step 12).
		l.interruptOwn(base, rt, firstString(res.InterruptReason, InterruptReasonWorkerShutdown))

	case execErr != nil:
		class := ErrorClassInfra
		if errors.Is(execErr, context.DeadlineExceeded) {
			class = ErrorClassTimeout // § 4 step 7's deadline arm
		}
		l.fenced(base, rt, func(ctx context.Context) error {
			return l.store.FailAttempt(ctx, c, class, bounded(execErr.Error(), 512), nil)
		})

	default:
		// An executor that returns nothing honest is itself the failure.
		l.fenced(base, rt, func(ctx context.Context) error {
			return l.store.FailAttempt(ctx, c, ErrorClassInfra,
				"worker: executor for kind "+c.Kind+" returned no honest terminal", nil)
		})
	}
}

// cancelOwn closes a cancel-requested attempt as cancelled (§ 4 step 11);
// the ack-reasoning that distinguishes acp_cancel_ack from the timeout arm
// arrives with the executors that own the processes.
func (l *AttemptLoop) cancelOwn(base context.Context, rt *runningAttempt, reason string) {
	c := rt.claim
	l.fenced(base, rt, func(ctx context.Context) error {
		return l.store.CancelAttemptOwn(ctx, c, firstString(reason, CancelReasonACPAck))
	})
}

// interruptOwn is the worker's honest shutdown close (§ 4 step 12).
func (l *AttemptLoop) interruptOwn(base context.Context, rt *runningAttempt, reason string) {
	c := rt.claim
	l.fenced(base, rt, func(ctx context.Context) error {
		return l.store.InterruptAttemptOwn(ctx, c, firstString(reason, InterruptReasonWorkerShutdown))
	})
}

// fenced performs one terminal write on a detached, bounded context; a
// rejected fence flips the lost-lease flag and stops, per runner.go:183-188:
// a newer owner has already spoken for this attempt.
func (l *AttemptLoop) fenced(base context.Context, rt *runningAttempt, write func(ctx context.Context) error) {
	if rt.lostLease.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(base, attemptTerminalWriteTimeout)
	defer cancel()
	if err := write(ctx); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			l.log.Warn("attempt terminal write rejected: lease lost",
				slog.String("attempt_id", rt.claim.AttemptID))
			rt.lostLease.Store(true)
			return
		}
		// The lease will expire and the reconciler will close it as
		// interrupted — the visible outcome is preserved, the guess is ours
		// to log (§ 5.4 pass 1).
		l.log.Error("attempt terminal write failed",
			slog.String("attempt_id", rt.claim.AttemptID), slog.String("error", err.Error()))
	}
}

// attemptSink gives one in-flight attempt body fenced journal writes and the
// drain's graceful-stop signal.
type attemptSink struct{ rt *runningAttempt }

func (s attemptSink) AppendEvent(ctx context.Context, ev AttemptEvent) error {
	if s.rt.lostLease.Load() {
		return ErrLeaseLost
	}
	if err := s.rt.loop.store.AppendAttemptEvent(ctx, s.rt.claim, ev); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			// A fenced append failed while the attempt was live: we are
			// stale — stop the body like runner.go:96-101's sink does.
			s.rt.noteLeaseLost("journal_append")
			s.rt.cancel()
		}
		return err
	}
	return nil
}

func (s attemptSink) Stopping() <-chan struct{} { return s.rt.stopCh }

func nzAny(in []any) []any {
	if in == nil {
		return []any{}
	}
	return in
}

func firstString(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
