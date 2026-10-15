package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// M2 cadence defaults (ADR-0016 §3): a 30 s lease renewed every 10 s, a
// cancel poll no slower than 1 s, and a 300 ms text-coalescing idle window.
const (
	DefaultLeaseTTL      = 30 * time.Second
	DefaultRenewInterval = 10 * time.Second
	DefaultClaimInterval = time.Second
	DefaultCancelPoll    = 500 * time.Millisecond
	DefaultIdleFlush     = 300 * time.Millisecond
	// DefaultQuiesce is how long the runner waits after Prompt returns for
	// trailing stream updates to arrive before closing the transcript, so
	// chunks racing the turn result are not lost.
	DefaultQuiesce = 200 * time.Millisecond
	// DefaultPermissionTTL bounds how long a human prompt stays actionable.
	DefaultPermissionTTL  = 2 * time.Minute
	DefaultPermissionPoll = 500 * time.Millisecond
	// DefaultMaxChunkBytes bounds one conversation.message.agent row; a
	// longer flush is split into ordered chunks.
	DefaultMaxChunkBytes = 8 * 1024
	// DefaultMaxPreviewBytes bounds tool input/output previews in the
	// journal (payloads carry previews only, ADR-0016 §7).
	DefaultMaxPreviewBytes = 512
)

// TurnConfig tunes the loop; zero values take the defaults above.
type TurnConfig struct {
	LeaseTTL        time.Duration
	RenewInterval   time.Duration
	ClaimInterval   time.Duration
	CancelPoll      time.Duration
	IdleFlush       time.Duration
	Quiesce         time.Duration
	PermissionTTL   time.Duration
	PermissionPoll  time.Duration
	MaxChunkBytes   int
	MaxPreviewBytes int

	// AskModeID maps a launcher id to the session mode that makes it send
	// permission requests (the launcher registry's knowledge, injected so
	// this package imports no protocol SDK). It must return "" for
	// launchers with no verified prompting mode; the runner then refuses to
	// run an ask profile on that launcher rather than silently running a
	// never-asks default (docs/compatibility/ACP.md).
	AskModeID func(launcherID string) string
}

func (c TurnConfig) normalise() TurnConfig {
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = DefaultLeaseTTL
	}
	if c.RenewInterval <= 0 {
		c.RenewInterval = DefaultRenewInterval
	}
	if c.ClaimInterval <= 0 {
		c.ClaimInterval = DefaultClaimInterval
	}
	if c.CancelPoll <= 0 {
		c.CancelPoll = DefaultCancelPoll
	}
	if c.IdleFlush <= 0 {
		c.IdleFlush = DefaultIdleFlush
	}
	if c.Quiesce <= 0 {
		c.Quiesce = DefaultQuiesce
	}
	if c.PermissionTTL <= 0 {
		c.PermissionTTL = DefaultPermissionTTL
	}
	if c.PermissionPoll <= 0 {
		c.PermissionPoll = DefaultPermissionPoll
	}
	if c.MaxChunkBytes <= 0 {
		c.MaxChunkBytes = DefaultMaxChunkBytes
	}
	if c.MaxPreviewBytes <= 0 {
		c.MaxPreviewBytes = DefaultMaxPreviewBytes
	}
	if c.AskModeID == nil {
		c.AskModeID = func(string) string { return "" }
	}
	return c
}

// TurnLoop claims and executes conversation turns for one worker process:
// claim → ensure live session → stream the transcript fenced on the lease
// triple → honest terminal state (ADR-0016 §3/§6, 02 "Scheduling and
// recovery"). It turns are executed one at a time per process — M2 has no
// capacity accounting, and one-active-turn-per-conversation means parallel
// turns would only interleave transcripts on one database.
type TurnLoop struct {
	cfg   TurnConfig
	store TurnStore
	spawn domain.AgentSessionFactory
	work  WorkspacePrep
	// units is the M3 execution-unit service; nil keeps M2's behaviour
	// (workspace.Prepare, an unsandboxed launch). It is a collaborator rather
	// than a replacement of `work` because a worker started without nono,
	// without volumes or in `disabled` mode still has to run turns, and the
	// difference between those two shapes is configuration, not a code fork.
	units *UnitService
	// liveUnits tracks the live unit per conversation so the turn-end hook can
	// capture and clean it up. Guarded by mu; nil when no unit service is wired.
	liveUnits map[string]*Unit

	clock Clock
	log   *slog.Logger

	// wake is optional journal-traffic notification (LISTEN); nil falls
	// back to pure polling (ADR-0016: "LISTEN/NOTIFY is only a wake-up
	// optimization"). Same shape as postgres.EventWake.Watch.
	wake func(ctx context.Context) (<-chan struct{}, func(), error)

	// idFn resolves this worker's id after registration (the loop starts
	// when the registry row exists).
	idFn func() string

	mu     sync.Mutex
	live   map[string]*liveSession // conversation id → live agent instance
	stopCh chan struct{}           // closed by Drain: stop claiming
	closed bool

	// running tracks the in-flight runTurn for drain.
	running sync.WaitGroup
	cur     atomic.Pointer[runningTurn]

	turnsDone atomic.Int64
}

// TurnOption customises a TurnLoop.
type TurnOption func(*TurnLoop)

// WithUnits runs the loop on M3 execution units: worktrees from project
// mirrors, APM staging, secret materialization and a sandbox-verified launch.
// Passing nil is not a way to run unsandboxed — it is the M2 path, and the
// worker only takes it when the enforcement mode is `disabled`.
func WithUnits(u *UnitService) TurnOption {
	return func(l *TurnLoop) {
		l.units = u
	}
}

// WithTurnClock replaces the loop's clock (tests drive cadence).
func WithTurnClock(c Clock) TurnOption {
	return func(l *TurnLoop) {
		if c != nil {
			l.clock = c
		}
	}
}

// WithTurnLogger replaces the loop logger; nil keeps slog.Default.
func WithTurnLogger(l *slog.Logger) TurnOption {
	return func(t *TurnLoop) {
		if l != nil {
			t.log = l
		}
	}
}

// WithJournalWake wires a wake-up source (postgres.EventWake.Watch) so
// cancel requests and permission decisions are noticed between poll ticks.
func WithJournalWake(watch func(ctx context.Context) (<-chan struct{}, func(), error)) TurnOption {
	return func(l *TurnLoop) { l.wake = watch }
}

// NewTurnLoop validates its ports and returns an idle loop.
func NewTurnLoop(cfg TurnConfig, store TurnStore, spawn domain.AgentSessionFactory, work WorkspacePrep, workerID func() string, opts ...TurnOption) (*TurnLoop, error) {
	if store == nil {
		return nil, errors.New("worker: turn loop requires a store")
	}
	if spawn == nil {
		return nil, errors.New("worker: turn loop requires a session factory")
	}
	if work == nil {
		return nil, errors.New("worker: turn loop requires a workspace preparer")
	}
	if workerID == nil {
		return nil, errors.New("worker: turn loop requires a worker-id provider")
	}
	l := &TurnLoop{
		cfg:    cfg.normalise(),
		store:  store,
		spawn:  spawn,
		work:   work,
		clock:  realClock{},
		log:    slog.Default(),
		idFn:   workerID,
		live:   map[string]*liveSession{},
		stopCh: make(chan struct{}),
	}
	for _, o := range opts {
		o(l)
	}
	return l, nil
}

// Start runs the claim loop until ctx ends or Drain is called. It returns
// nil after a clean stop; it is meant to run on its own goroutine, started
// once the worker registration produced an id.
func (l *TurnLoop) Start(ctx context.Context) error {
	workerID := l.idFn()
	if workerID == "" {
		return errors.New("worker: turn loop started before the worker registered")
	}
	if ctx == nil {
		return errors.New("worker: Start requires a context")
	}
	l.log.Info("turn loop starting",
		slog.String("worker_id", workerID),
		slog.Duration("lease_ttl", l.cfg.LeaseTTL),
		slog.Duration("renew", l.cfg.RenewInterval),
	)
	// Journal wake-ups (cancel/permission decisions) refresh both watches
	// early; without them the ≤1 s polls carry the load.
	wakeCtx, wakeStop := context.WithCancel(ctx)
	defer wakeStop()
	var wakes <-chan struct{}
	if l.wake != nil {
		if ch, stop, err := l.wake(wakeCtx); err == nil {
			wakes = ch
			defer stop()
		} else {
			l.log.Warn("journal wake-up unavailable; polling only", slog.String("error", err.Error()))
		}
	}

	for {
		if l.stopping() {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		default:
		}

		claim, ok, err := l.store.ClaimTurn(ctx, workerID)
		if err != nil {
			if ctx.Err() != nil || l.stopping() {
				return nil
			}
			l.log.Warn("claim failed", slog.String("error", err.Error()))
		} else if ok {
			l.running.Add(1)
			l.runTurn(ctx, claim)
			l.running.Done()
			l.turnsDone.Add(1)
			continue
		}

		// Idle: wait for the next claim tick, a wake-up, or shutdown.
		timer := l.clock.After(l.cfg.ClaimInterval)
		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		case <-timer:
		case <-wakes:
		}
	}
}

// Drain implements the shutdown hook of the M1 worker loop: stop claiming,
// give the in-flight turn a chance to end honestly (ACP cancel), then cancel
// it and require runTurn to have written the interrupted terminal state
// before returning (ADR-0016 §6 "Worker graceful drain", §9 obligation 2).
// The passed ctx is already detached from the run context.
func (l *TurnLoop) Drain(ctx context.Context) error {
	l.mu.Lock()
	if !l.closed {
		l.closed = true
		close(l.stopCh)
	}
	l.mu.Unlock()

	rt := l.cur.Load()
	if rt != nil {
		l.log.Info("drain: cancelling in-flight turn",
			slog.String("turn_id", rt.claim.TurnID), slog.String("reason", "shutdown"))
		rt.shutdown.Store(true)
		if s := rt.sessionLoad(); s != nil {
			s.cancelACP(context.WithoutCancel(ctx))
		}
		rt.cancel()
	}

	done := make(chan struct{})
	go func() {
		l.running.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		return errors.New("worker: drain ended before the in-flight turn wrote its terminal state")
	}

	// Close every live session with an honest disconnected event and mark
	// the conversations idle (ADR-0016 §6).
	l.mu.Lock()
	sessions := make([]*liveSession, 0, len(l.live))
	for _, s := range l.live {
		sessions = append(sessions, s)
	}
	l.live = map[string]*liveSession{}
	l.mu.Unlock()

	for _, s := range sessions {
		l.closeSession(ctx, s, "shutdown")
	}
	return nil
}

// stopping reports whether Drain has begun.
func (l *TurnLoop) stopping() bool {
	select {
	case <-l.stopCh:
		return true
	default:
		return false
	}
}

// Completed turns this loop finished (integration tests poll it).
func (l *TurnLoop) turnsCompleted() int64 { return l.turnsDone.Load() }

// liveSession is one agent instance kept alive across turns for a
// conversation (ADR-0016: one live instance per conversation; the live map
// is this worker's view, acp_session_bindings is the cluster's).
type liveSession struct {
	loop           *TurnLoop
	conversationID string
	handle         domain.AgentSession
	info           domain.SessionInfo
	bindingID      string

	// dead is set once the event stream closed (process gone).
	dead atomic.Bool
	// done is closed when the dispatcher exits.
	done chan struct{}

	// mu guards route/turn swapping: the dispatcher calls route under it,
	// and the runner swaps the sink/turn per turn.
	mu sync.Mutex
	// route receives normalized events for the current turn; nil between
	// turns (updates are dropped — there is no turn to attribute them to).
	route func(domain.ConversationEvent)
	turn  *runningTurn
}

// currentTurn returns the session's in-flight turn, nil between turns.
func (s *liveSession) currentTurn() *runningTurn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.turn
}

// emitEvent is the acp handle callback path: route one normalized event to
// the current turn's sink or drop it.
func (s *liveSession) emitEvent(ev domain.ConversationEvent) {
	s.mu.Lock()
	route := s.route
	s.mu.Unlock()
	if route != nil {
		route(ev)
	}
}

// cancelACP asks the harness to stop the in-flight turn; safe to call from
// drain with a detached context.
func (s *liveSession) cancelACP(ctx context.Context) {
	if s.dead.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := s.handle.Cancel(ctx); err != nil {
		s.loop.log.Warn("acp cancel failed",
			slog.String("conversation_id", s.conversationID), slog.String("error", err.Error()))
	}
}

// dispatch pumps the handle's normalized event stream to the current turn
// until the process dies (channel close).
func (s *liveSession) dispatch() {
	defer close(s.done)
	for ev := range s.handle.Events() {
		s.emitEvent(ev)
	}
	s.dead.Store(true)
}

// sessionFor returns the conversation's live session, launching (or
// resuming) one when the process is gone. It prepares the workspace first
// (agent cwd = workspace root) and records the binding row.
func (l *TurnLoop) sessionFor(ctx context.Context, c Claim, rt *runningTurn) (*liveSession, error) {
	l.mu.Lock()
	if s := l.live[c.ConversationID]; s != nil && !s.dead.Load() {
		l.mu.Unlock()
		rt.session(s)
		// Honest turn origin: this turn rides a session an earlier turn
		// created — no new binding, no new agent.session.connected (04
		// "Session reuse semantics": continue_live).
		rt.turnOrigin = events.SessionOriginReused
		return s, nil
	}
	l.mu.Unlock()

	repos, err := l.store.ProjectRepos(ctx, c.ProjectID)
	if err != nil {
		return nil, err
	}
	var (
		workDir string
		notes   []string
		unit    *Unit
	)
	if l.units != nil {
		unit, err = l.prepareUnit(ctx, c, repos)
		if err != nil {
			return nil, err
		}
		workDir = unit.WorkDir()
	} else {
		workDir, notes, err = l.work.Prepare(ctx, c.ConversationID, repos)
		if err != nil {
			return nil, err
		}
	}

	modeID := ""
	switch c.PermissionMode {
	case "ask":
		modeID = l.cfg.AskModeID(c.LauncherID)
		if modeID == "" {
			// Fail closed: without a verified prompting mode the adapter's
			// default answers every permission itself — "ask" would be a
			// lie (docs/compatibility/ACP.md: prompting is a mode property).
			return nil, errNoAskMode{launcher: c.LauncherID}
		}
	case "deny", "preapproved_within_sandbox":
		// deny/preapproved are answered by the static policy at the ACP
		// layer; M2's seeded profiles are 'ask'.
	default:
		return nil, errors.New("worker: unknown permission mode " + c.PermissionMode)
	}

	req := domain.SessionRequest{
		LauncherID: c.LauncherID,
		WorkDir:    workDir,
		ModeID:     modeID,
		// Prompts always route to the conversation's *current* turn bridge,
		// consulted through the live map, so the callback installed at
		// launch never pins a finished turn.
		Decider: func(ctx context.Context, p domain.PermissionPrompt) (domain.PermissionChoice, error) {
			l.mu.Lock()
			s := l.live[c.ConversationID]
			l.mu.Unlock()
			if s == nil {
				return domain.PermissionChoice{}, errors.New("worker: permission prompt for an unbound conversation")
			}
			rt := s.currentTurn()
			if rt == nil {
				return domain.PermissionChoice{}, errors.New("worker: permission prompt with no turn in flight")
			}
			return rt.decidePermission(ctx, p)
		},
	}
	// A prior live binding on *this* worker whose process died (restart
	// before the reconciler noticed) is the only thing worth attempting a
	// session/load for; both adapters must have advertised it.
	if prev, ok, err := l.store.ResumableSession(ctx, c.ConversationID, c.WorkerID); err == nil && ok {
		req.LoadSessionID = prev.ACPSessionID
	}

	// The M3 sandbox gate. On this path the launch either gets a verified plan
	// in its context or the session is never created — there is no third branch
	// (ADR-0019 D6: a sandbox refusal fails the turn, it does not fall back).
	//
	// The order is the contract's: prepare → stage → materialize → *verify* →
	// exec. Nothing after this point can run unsandboxed in `required` mode
	// because the factory refuses a missing plan when RequirePlan is set.
	if unit != nil {
		launcher, ok := acp.LookupLauncher(c.LauncherID)
		if !ok {
			return nil, fmt.Errorf("worker: launcher %q is not a known launcher, so no sandbox plan can name its adapter", c.LauncherID)
		}
		ctx, err = l.launchPlanFor(ctx, c, unit, launcher)
		if err != nil {
			return nil, err
		}
	}

	sess, err := l.spawn.NewSession(ctx, req)
	if err != nil {
		return nil, err
	}
	info := sess.Info()

	bindingID, closedPrior, err := l.store.RecordBinding(ctx, c, info)
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	for _, id := range closedPrior {
		l.appendSessionEvent(ctx, c.ConversationID, sessionDisconnectedEvent(c.ConversationID, id, c.WorkerID, "", "replaced"))
	}
	l.appendSessionEvent(ctx, c.ConversationID, sessionConnectedEvent(c, bindingID, info))
	if err := l.store.SetConversationStatus(ctx, c.ConversationID, "active"); err != nil {
		l.log.Warn("conversation status write failed", slog.String("error", err.Error()))
	}

	ls := &liveSession{
		loop:           l,
		conversationID: c.ConversationID,
		handle:         sess,
		info:           info,
		bindingID:      bindingID,
		done:           make(chan struct{}),
	}
	l.mu.Lock()
	if existing := l.live[c.ConversationID]; existing != nil && !existing.dead.Load() {
		l.mu.Unlock()
		_ = sess.Close()
		rt.session(existing)
		rt.turnOrigin = events.SessionOriginReused
		return existing, nil
	}
	l.live[c.ConversationID] = ls
	l.mu.Unlock()
	go ls.dispatch()
	rt.session(ls)
	// The session was created (new) or restored (resumed) *for this turn*,
	// with the matching agent.session.connected just emitted; turn.started
	// says the same word about this turn.
	rt.turnOrigin = info.Origin
	rt.notes = notes
	return ls, nil
}

// closeSession closes a live session's binding honestly and terminates the
// process.
func (l *TurnLoop) closeSession(ctx context.Context, s *liveSession, reason string) {
	ids, err := l.store.CloseBinding(ctx, s.conversationID, s.loop_workerID(), reason)
	if err != nil {
		l.log.Warn("closing session binding failed",
			slog.String("conversation_id", s.conversationID), slog.String("error", err.Error()))
	} else {
		for _, id := range ids {
			l.appendSessionEvent(ctx, s.conversationID, sessionDisconnectedEvent(s.conversationID, id, s.loop_workerID(), s.info.ACPSessionID, reason))
		}
	}
	l.mu.Lock()
	if l.live[s.conversationID] == s {
		delete(l.live, s.conversationID)
	}
	l.mu.Unlock()
	if err := l.store.SetConversationStatus(ctx, s.conversationID, "idle"); err != nil {
		l.log.Warn("conversation idle write failed", slog.String("error", err.Error()))
	}
	if err := s.handle.Close(); err != nil {
		l.log.Warn("agent process close", slog.String("error", err.Error()))
	}
}

// loop_workerID caches the loop's identity for session bookkeeping.
func (s *liveSession) loop_workerID() string {
	return s.loop.idFn()
}

// appendSessionEvent appends a conversation-scoped session event. These are
// not turn-scoped (no lease triple exists around them), which is why the
// store exposes a separate unfenced-but-scoped append (ADR-0016 §9
// obligation 2 covers turn-scoped writes).
func (l *TurnLoop) appendSessionEvent(ctx context.Context, conversationID string, ev TurnEvent) {
	if err := l.store.AppendConversationEvent(ctx, conversationID, ev); err != nil {
		l.log.Warn("session event append failed",
			slog.String("conversation_id", conversationID), slog.String("error", err.Error()))
	}
}

// errNoAskMode reports an ask profile on a launcher with no verified
// prompting mode.
type errNoAskMode struct{ launcher string }

func (e errNoAskMode) Error() string {
	return "worker: permission mode ask needs a prompting mode for launcher " + e.launcher + "; none is verified (docs/compatibility/ACP.md)"
}
