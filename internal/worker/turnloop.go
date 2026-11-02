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

	// mail is the agent-mail port (ADR-0072): nil unless the store speaks
	// it (the real postgres.TurnStore does once migration 00026 is applied;
	// a fake that does not simply never dispatches). Resolved by a type
	// assertion in NewTurnLoop so no worker wiring names it.
	mail MailPort
	// mailBox is the ADR-0072 § 12 read of a conversation's asked-side state.
	// Resolved by the same kind of type assertion as `mail` (a store that does
	// not speak it leaves every workspace read-write, which is what a worker
	// before migration 00026 has always done).
	mailBox MailSandboxPort

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

// WithMail overrides the agent-mail port (ADR-0072). Tests inject a fake;
// production relies on the store assertion in NewTurnLoop.
func WithMail(m MailPort) TurnOption {
	return func(l *TurnLoop) { l.mail = m }
}

// WithMailSandbox overrides the § 12 read-only state reader. Tests inject it;
// production relies on the store assertion in NewTurnLoop.
func WithMailSandbox(p MailSandboxPort) TurnOption {
	return func(l *TurnLoop) { l.mailBox = p }
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
	if m, ok := store.(MailPort); ok {
		l.mail = m
	}
	if p, ok := store.(MailSandboxPort); ok {
		l.mailBox = p
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
	// profileID is the agent profile this instance was launched on
	// (ADR-0068). A turn that claims a different profile must not ride this
	// process: the profile is the launcher, permission and packaged-context
	// decision, and a live instance carries all three from its launch.
	profileID string

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
		// ADR-0068: continue_live reuse is a same-profile decision. The
		// controller switched the conversation's agent since this process
		// launched, so the switch is honored here — honestly, by closing the
		// old instance (binding closed, agent.session.disconnected journalled,
		// conversation moved to idle) and falling through to a NEW session on
		// the new profile in the SAME prepared workspace/branch.
		if s.profileID == c.AgentProfileID || c.AgentProfileID == "" {
			l.mu.Unlock()
			rt.session(s)
			// Honest turn origin: this turn rides a session an earlier turn
			// created — no new binding, no new agent.session.connected (04
			// "Session reuse semantics": continue_live).
			rt.turnOrigin = events.SessionOriginReused
			return s, nil
		}
		stale := s
		l.mu.Unlock()
		l.closeSession(ctx, stale, "agent_switched")
		l.mu.Lock()
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
	// ADR-0072 § 12: on the asked side of an agent-mail link, read-only is a
	// filesystem rule decided BEFORE the launch rather than a prompt that may
	// never come. The store answers it; a store that cannot (§ 12's port is
	// optional) leaves the workspace read-write exactly as it always was, and an
	// `ask` turn on a never-asks launcher keeps failing closed under ADR-0069 —
	// a missing read can only ever cost a turn, never widen a sandbox.
	repoAccess, err := l.mailRepoAccess(ctx, c)
	if err != nil {
		return nil, err
	}
	readOnlyRepo := repoAccess.ReadOnlyRepo()
	if l.units != nil {
		unit, err = l.prepareUnit(ctx, c, repos, readOnlyRepo)
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
	// The mount is the guarantee only if there is a sandbox to hold it. A turn
	// that reached here with no unit has no repository grant to narrow, so the
	// § 12 arm does not apply to it and nothing is claimed about it.
	if readOnlyRepo && unit == nil {
		readOnlyRepo = false
	}

	// `ask`, `deny` and `preapproved_within_sandbox` all need the launcher's
	// prompting mode: the harness must actually send session/request_permission
	// for any verdict to be produced — the turn's permission bridge answers
	// `ask` with the human, and `deny`/`preapproved_within_sandbox` with the
	// profile's policy immediately (decidePermission, ADR-0039 Option A: the
	// policy verdict is a durable `decided` row naming the policy). Leaving
	// modeID empty would pin the adapter to its never-asks default
	// (docs/compatibility/ACP.md), which sends no session/request_permission
	// at all, so a policy conversation would silently allow every tool call
	// (ADR-0036 (a)) and journal no verdict (preapproved).
	modeID := ""
	switch c.PermissionMode {
	case "ask":
		// ADR-0072 § 12 is the arm that changed here. Where the launcher has a
		// verified prompting mode, `ask` stays exactly as it was — and on the
		// asked side it is now the SECOND layer, because the repository is also
		// mounted read-only. Where the launcher has none (pi, ADR-0069), there is
		// nothing to prompt with, and a turn whose read-only is a mount rather
		// than a promise has no review claim to make: it runs the never-asks
		// default, which is what `autonomous_within_sandbox` says. That word is
		// only honest over a real boundary, so the same `required` gate the
		// autonomous arm below applies is checked here too; without it the turn
		// fails closed rather than running never-asks under an unenforced
		// read-only label.
		modeID = l.cfg.AskModeID(c.LauncherID)
		if modeID != "" {
			break
		}
		if !readOnlyRepo {
			// Fail closed: without a verified prompting mode the adapter's
			// default answers every permission itself — the recorded mode
			// would be a lie (docs/compatibility/ACP.md: prompting is a
			// mode property).
			return nil, errNoAskMode{launcher: c.LauncherID, mode: c.PermissionMode}
		}
		if err := l.requireRequiredSandbox(c.LauncherID); err != nil {
			return nil, err
		}
		// The transcript says what the launch is, because the stamped mode no
		// longer does: no prompt will ever arrive on this launcher.
		notes = append(notes, "this chat is answering another chat's mail: its repository is mounted read-only in the sandbox, and it runs without asking because the sandbox is the boundary (ADR-0072 § 12). A person's approval lifts the mount to read-write.")
	case "deny", "preapproved_within_sandbox":
		modeID = l.cfg.AskModeID(c.LauncherID)
		if modeID == "" {
			// Fail closed, as above: these modes claim a policy verdict, and a
			// launcher that sends no prompt produces none to record.
			return nil, errNoAskMode{launcher: c.LauncherID, mode: c.PermissionMode}
		}
	case "autonomous_within_sandbox":
		// ADR-0069: the never-asks launcher's only honest mode. modeID stays
		// empty — the adapter's never-asks default IS what this mode says it
		// runs, and the mode makes no review claim: no prompt, no verdict
		// row, and the journal/UI wording is "runs without asking; the
		// sandbox is the boundary". That sentence is only true when the
		// launch really runs inside a verified nono sandbox: on this path
		// that is the unit's `required` enforcement chain (launchPlanFor →
		// Unit.Verify, ADR-0019 D6 — an unverified launch fails the turn,
		// there is no fallback branch). A loop without the unit service, or
		// a worker configured below `required`, has no boundary to point at
		// and refuses before any spawn.
		if err := l.requireRequiredSandbox(c.LauncherID); err != nil {
			return nil, err
		}
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
	if prev, ok, err := l.store.ResumableSession(ctx, c.ConversationID, c.WorkerID, c.AgentProfileID); err == nil && ok {
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
		// A harness that will not start without a sign-in is not a workspace
		// failure: say which component refused, in words a reader cannot
		// mistake for the repository's git address (launchfailure.go).
		return nil, describeLaunchFailure(c.LauncherID, err)
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
		profileID:      c.AgentProfileID,
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

// errNoAskMode reports a profile whose recorded permission mode needs a
// prompting mode, on a launcher that has none verified. mode names the
// recorded mode so the failure is honest about which one was refused.
type errNoAskMode struct {
	launcher string
	mode     string
}

func (e errNoAskMode) Error() string {
	mode := e.mode
	if mode == "" {
		mode = "ask"
	}
	return "worker: permission mode " + mode + " needs a prompting mode for launcher " + e.launcher + "; none is verified (docs/compatibility/ACP.md)"
}

// requireRequiredSandbox is the one gate every never-asks launch passes: the
// boundary the mode points at must be the unit path's verified `required`
// chain, or there is nothing to be honest about (ADR-0069). ADR-0072 § 12's
// asked-side turn on a never-asks launcher runs under that same sentence, so it
// passes under this same check rather than a copy of it.
func (l *TurnLoop) requireRequiredSandbox(launcherID string) error {
	if l.units == nil {
		return errAutonomousWithoutSandbox{launcher: launcherID, mode: "none (no unit service)"}
	}
	if mode := l.units.enforcement(); mode != domain.EnforceRequired {
		return errAutonomousWithoutSandbox{launcher: launcherID, mode: string(mode)}
	}
	return nil
}

// mailRepoAccess reads the ADR-0072 § 12 state of a conversation. A loop whose
// store cannot answer it gets "ordinary conversation", which is the shape this
// path had before the § 12 arm existed: read-write grants, and an `ask` turn
// that fails closed on a never-asks launcher.
func (l *TurnLoop) mailRepoAccess(ctx context.Context, c Claim) (MailRepoAccess, error) {
	if l.mailBox == nil {
		return MailRepoAccess{}, nil
	}
	access, err := l.mailBox.MailRepoAccess(ctx, c)
	if err != nil {
		return MailRepoAccess{}, fmt.Errorf("worker: read the agent-mail state of turn %s: %w", c.TurnID, err)
	}
	return access, nil
}

// errAutonomousWithoutSandbox reports an autonomous_within_sandbox profile on
// a worker that has no enforced sandbox to be its boundary (ADR-0069). The
// mode deliberately makes no review claim, so the refusal names the missing
// sandbox, not a missing prompt.
type errAutonomousWithoutSandbox struct {
	launcher string
	mode     string
}

func (e errAutonomousWithoutSandbox) Error() string {
	return "worker: permission mode autonomous_within_sandbox is only honest under sandbox enforcement \"required\" (ADR-0069); launcher " + e.launcher + " runs on a worker with enforcement " + e.mode + ", so the attempt is refused"
}
