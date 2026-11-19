package worker

// ADR-0085 (in-app agent sign-in, implementation): the worker half of the
// sign-in queue. The control plane inserts a queued `agent_logins` row; this
// loop claims it (FOR UPDATE SKIP LOCKED + lease — the APM-lock idiom), runs
// one launcher's AgentLoginDriver against the worker's own credential volume,
// and reports the link/code plus the outcome back through fenced writes.
//
// The loop's shape is the APM lock loop's: claim, run one at a time with a
// deadline, Drain. On top of that it owns two things the lock loop does not:
// a lease heartbeat that runs while the driver's child is alive (a sign-in
// waits on a human, so it outlives one lease several times over), and the
// periodic status probe whose rows the Settings page reads.
//
// Everything the user could leak through a log line stays out of the logs:
// the loop logs login ids, launcher names and statuses, never a device code,
// a submitted authorization code, a verification URL or a token.

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// agentLoginKillGrace is how long a sign-in child gets to leave on its own
// after SIGTERM before its whole process group is SIGKILLed. The sign-in
// children are node CLIs that spawn their own helpers, so the group — not the
// direct child — is what must not outlive the attempt (the procexec teardown
// idiom, ADR-0085's child is the same kind of tree).
const agentLoginKillGrace = 2 * time.Second

// agentLoginChild is one sign-in child process, exec'd in its own process
// group with an explicit environment (never the worker's). The group dies with
// the child context, so a cancelled or expired sign-in never leaves a harness
// holding the credential directory.
type agentLoginChild struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	stdoutW *os.File

	dead     chan struct{}
	deadOnce sync.Once
	waitOnce sync.Once
	err      error
}

// startAgentLoginChild execs argv (no shell, ever). pipedStdin gives the
// caller the child's stdin; pipedStdout reads its stdout, with stderr merged
// into the same stream when mergeStderr and discarded to /dev/null otherwise.
func startAgentLoginChild(ctx context.Context, argv, env []string, pipedStdin, pipedStdout, mergeStderr bool) (*agentLoginChild, error) {
	if len(argv) == 0 {
		return nil, errors.New("worker: sign-in child requires a command")
	}
	c := &agentLoginChild{
		cmd:  exec.Command(argv[0], argv[1:]...), // argv only — no shell
		dead: make(chan struct{}),
	}
	c.cmd.Env = env
	c.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if pipedStdin {
		w, err := c.cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		c.stdin = w
	}
	if pipedStdout {
		// A real pipe, not cmd.StdoutPipe: stderr has to land in the same
		// stream for Antigravity, whose CLI prints the link on stdout and the
		// failure on stderr.
		pr, pw, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		c.stdout = pr
		c.stdoutW = pw
		c.cmd.Stdout = pw
		if mergeStderr {
			c.cmd.Stderr = pw // the same reader sees both streams
		} else {
			c.cmd.Stderr = nil // /dev/null: the harness's logs are not our output
		}
	}
	if err := c.cmd.Start(); err != nil {
		if c.stdoutW != nil {
			_ = c.stdoutW.Close()
			_ = c.stdout.Close()
		}
		return nil, err
	}
	// The parent's copy of the write end goes away at once: the reader then
	// sees EOF when the child exits instead of hanging on our own descriptor.
	if c.stdoutW != nil {
		_ = c.stdoutW.Close()
		c.stdoutW = nil
	}
	go func() {
		select {
		case <-ctx.Done():
			c.Kill()
		case <-c.dead:
		}
	}()
	return c, nil
}

// markDead releases anyone waiting on the child's death (the reader loop, the
// ctx watchdog).
func (c *agentLoginChild) markDead() { c.deadOnce.Do(func() { close(c.dead) }) }

// reap waits for the child once and closes its stdin.
func (c *agentLoginChild) reap() {
	c.waitOnce.Do(func() {
		if c.stdin != nil {
			_ = c.stdin.Close()
		}
		c.err = c.cmd.Wait()
		if c.stdout != nil {
			_ = c.stdout.Close()
		}
		c.markDead()
	})
}

// Wait reaps the child and answers with its exit error. It does not kill: a
// caller waiting for the CLI to finish on its own uses this.
func (c *agentLoginChild) Wait() error {
	c.reap()
	return c.err
}

// Done closes once the child is gone (or has been killed).
func (c *agentLoginChild) Done() <-chan struct{} { return c.dead }

// Kill stops the process group and reaps it: SIGTERM first, SIGKILL for
// whatever refuses to leave inside the grace window. Idempotent, and safe
// after the child already exited.
func (c *agentLoginChild) Kill() {
	c.markDead()
	if c.cmd.Process == nil {
		c.reap()
		return
	}
	pid := c.cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	reaped := make(chan struct{})
	go func() {
		c.reap()
		close(reaped)
	}()
	select {
	case <-reaped:
	case <-time.After(agentLoginKillGrace):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-reaped
	}
}

// Close ends the child's life: the group is killed if it is still running and
// reaped either way. Call it whatever the outcome is.
func (c *agentLoginChild) Close() { c.Kill() }

// Agent login loop cadence defaults. A sign-in is a human-paced job, so the
// claim poll is slower than the turn loop's 1 s tick; the status refresh is
// the 10-minute probe ADR-0085 puts in the worker's contract.
const (
	// DefaultAgentLoginPollInterval is how often an idle loop scans the queue.
	DefaultAgentLoginPollInterval = 2 * time.Second
	// DefaultAgentLoginStatusInterval is how often every launcher's sign-in
	// state is probed and upserted into agent_account_status.
	DefaultAgentLoginStatusInterval = 10 * time.Minute
	// DefaultAgentLoginStatusTimeout bounds one status probe's child.
	DefaultAgentLoginStatusTimeout = 60 * time.Second
	// DefaultAgentLoginLeaseHeartbeat is how often a running sign-in renews
	// its lease (and picks up a submitted code or a cancel).
	DefaultAgentLoginLeaseHeartbeat = 15 * time.Second
	// DefaultAgentLoginCodePollInterval is how often a driver waiting for the
	// user's pasted code checks for one.
	DefaultAgentLoginCodePollInterval = time.Second
	// DefaultAgentLoginReportTimeout bounds the store calls that report an
	// outcome, which must land even while the worker is shutting down.
	DefaultAgentLoginReportTimeout = 15 * time.Second
)

// AgentLoginConfig tunes the sign-in loop; zero values take the defaults.
type AgentLoginConfig struct {
	// PollInterval is the idle claim cadence.
	PollInterval time.Duration
	// StatusInterval is how often every launcher's state is refreshed.
	StatusInterval time.Duration
	// StatusTimeout bounds one status probe.
	StatusTimeout time.Duration
	// LeaseHeartbeat is the lease-renewal cadence while a driver runs.
	LeaseHeartbeat time.Duration
	// CodePollInterval is how often a waiting driver looks for a pasted code.
	CodePollInterval time.Duration
	// ReportTimeout bounds one outcome-reporting store call.
	ReportTimeout time.Duration
}

func (c AgentLoginConfig) normalise() (AgentLoginConfig, error) {
	if c.PollInterval <= 0 {
		c.PollInterval = DefaultAgentLoginPollInterval
	}
	if c.StatusInterval <= 0 {
		c.StatusInterval = DefaultAgentLoginStatusInterval
	}
	if c.StatusTimeout <= 0 {
		c.StatusTimeout = DefaultAgentLoginStatusTimeout
	}
	if c.LeaseHeartbeat <= 0 {
		c.LeaseHeartbeat = DefaultAgentLoginLeaseHeartbeat
	}
	if c.CodePollInterval <= 0 {
		c.CodePollInterval = DefaultAgentLoginCodePollInterval
	}
	if c.ReportTimeout <= 0 {
		c.ReportTimeout = DefaultAgentLoginReportTimeout
	}
	return c, nil
}

// AgentLoginOption customises the sign-in loop.
type AgentLoginOption func(*AgentLoginLoop)

// WithAgentLoginLogger replaces the loop logger; nil keeps slog.Default.
func WithAgentLoginLogger(l *slog.Logger) AgentLoginOption {
	return func(loop *AgentLoginLoop) {
		if loop != nil {
			loop.log = l
		}
	}
}

// WithAgentLoginClock replaces the loop's clock (tests drive cadence).
func WithAgentLoginClock(c Clock) AgentLoginOption {
	return func(loop *AgentLoginLoop) {
		if c != nil {
			loop.clock = c
		}
	}
}

// WithAgentLoginConfig replaces the whole cadence bundle.
func WithAgentLoginConfig(cfg AgentLoginConfig) AgentLoginOption {
	return func(loop *AgentLoginLoop) {
		if loop != nil {
			loop.cfg = cfg
		}
	}
}

// WithAgentLoginPollInterval sets the idle claim cadence.
func WithAgentLoginPollInterval(d time.Duration) AgentLoginOption {
	return func(loop *AgentLoginLoop) {
		if loop != nil && d > 0 {
			loop.cfg.PollInterval = d
		}
	}
}

// WithAgentLoginStatusInterval sets the status-refresh cadence.
func WithAgentLoginStatusInterval(d time.Duration) AgentLoginOption {
	return func(loop *AgentLoginLoop) {
		if loop != nil && d > 0 {
			loop.cfg.StatusInterval = d
		}
	}
}

// AgentLoginLoop claims queued agent sign-ins and drives their drivers. Like
// the APM lock loop it runs one job at a time per worker: a sign-in holds a
// terminal-shaped child process and a human in the loop, so two at once on one
// credential volume buys nothing.
type AgentLoginLoop struct {
	store    AgentLoginStore
	drivers  map[string]AgentLoginDriver
	workerID func() string
	log      *slog.Logger

	cfg   AgentLoginConfig
	clock Clock

	mu     sync.Mutex
	stopCh chan struct{}
	closed bool
	// childCancel cancels the context of the sign-in now running; Drain uses
	// it so a shutdown stops the child instead of only stopping claims.
	childCancel context.CancelFunc

	running sync.WaitGroup
}

// NewAgentLoginLoop validates its ports and returns an idle loop. workerID is
// resolved after registration, the same shape as the other loops.
func NewAgentLoginLoop(store AgentLoginStore, drivers map[string]AgentLoginDriver, workerID func() string, opts ...AgentLoginOption) (*AgentLoginLoop, error) {
	if store == nil {
		return nil, errors.New("worker: agent login loop requires a store")
	}
	if workerID == nil {
		return nil, errors.New("worker: agent login loop requires a worker-id provider")
	}
	for name, d := range drivers {
		if d == nil {
			return nil, errors.New("worker: agent login driver " + name + " is nil")
		}
	}
	l := &AgentLoginLoop{
		store:    store,
		drivers:  drivers,
		workerID: workerID,
		log:      slog.Default(),
		stopCh:   make(chan struct{}),
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

// Start refreshes the launcher statuses, then runs the claim loop until ctx
// ends or Drain is called. Every status interval the statuses are refreshed
// again; a claimed sign-in runs to completion before the next claim.
func (l *AgentLoginLoop) Start(ctx context.Context) error {
	workerID := l.workerID()
	if workerID == "" {
		return errors.New("worker: agent login loop started before the worker registered")
	}
	if ctx == nil {
		return errors.New("worker: agent login Start requires a context")
	}
	l.log.Info("agent login loop starting", slog.String("worker_id", workerID))

	// The Settings page reads agent_account_status; a worker that never probed
	// would leave its launchers unread. Probe once before the first claim so
	// the rows exist as soon as the worker is live.
	l.refreshStatuses(ctx, workerID, "")

	nextClaim := l.clock.After(l.cfg.PollInterval)
	nextStatus := l.clock.After(l.cfg.StatusInterval)
claimLoop:
	for {
		if l.stopping() || ctx.Err() != nil {
			return nil
		}
		// Reserve the running slot before claiming, exactly as the APM lock
		// loop does: Drain sets closed under the same mutex and only then
		// enters running.Wait, so a reservation can never race that Wait.
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil
		}
		l.running.Add(1)
		l.mu.Unlock()

		c, ok, err := l.store.ClaimAgentLogin(ctx, workerID, l.launcherIDs())
		switch {
		case err != nil:
			l.running.Done()
			if ctx.Err() != nil || l.stopping() {
				return nil
			}
			l.log.Error("agent login claim failed",
				slog.String("worker_id", workerID), slog.String("error", err.Error()))
		case ok:
			l.log.Info("agent login claimed",
				slog.String("login_id", c.ID),
				slog.String("launcher", c.Launcher),
				slog.String("worker_id", c.WorkerID))
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer l.running.Done()
				l.run(ctx, workerID, c)
			}()
			// One sign-in at a time: the loop waits here instead of claiming,
			// and still services the status refresh while the child runs. When
			// the run settles it claims again straight away, no idle tick.
			for {
				select {
				case <-done:
					continue claimLoop
				case <-ctx.Done():
					return nil
				case <-l.stopCh:
					return nil
				case <-nextStatus:
					l.refreshStatuses(ctx, workerID, "")
					nextStatus = l.clock.After(l.cfg.StatusInterval)
				}
			}
		default:
			l.running.Done()
		}

		select {
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		case <-nextStatus:
			l.refreshStatuses(ctx, workerID, "")
			nextStatus = l.clock.After(l.cfg.StatusInterval)
		case <-nextClaim:
			nextClaim = l.clock.After(l.cfg.PollInterval)
		}
	}
}

// run drives one claimed sign-in: the driver under a context that dies at the
// row's expiry, a lease heartbeat beside it, then the fenced outcome report.
func (l *AgentLoginLoop) run(ctx context.Context, workerID string, c AgentLoginClaim) {
	driver := l.drivers[c.Launcher]
	if driver == nil {
		l.log.Error("agent login has no driver",
			slog.String("login_id", c.ID), slog.String("launcher", c.Launcher))
		l.report(ctx, c, AgentLoginFailed, "", "No sign-in driver is configured for this launcher on this worker.")
		l.refreshStatuses(ctx, workerID, c.Launcher)
		return
	}

	// The attempt gives up at the row's expires_at; the driver's child dies
	// with the context, and the row is finished as expired.
	runCtx, cancel := context.WithDeadline(ctx, c.ExpiresAt)
	s := &agentLoginSession{
		store:       l.store,
		c:           c,
		log:         l.log,
		clock:       l.clock,
		codePoll:    l.cfg.CodePollInterval,
		childCancel: cancel,
		codeWake:    make(chan struct{}, 1),
	}
	l.setChildCancel(cancel)
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		l.heartbeat(runCtx, s)
	}()

	res, err := driver.Login(runCtx, s)
	// Whatever the driver returned, its child is done with: drop the cancel
	// handle and end the heartbeat before touching the store again.
	cancel()
	l.setChildCancel(nil)
	<-hbDone

	switch {
	case s.leaseLost():
		// A fenced-out worker writes nothing: the row belongs to whoever won
		// the lease (or to the reclaim that follows).
		l.log.Warn("agent login lease lost; stopping the sign-in without reporting",
			slog.String("login_id", c.ID), slog.String("launcher", c.Launcher))
		return
	case err == nil:
		l.log.Info("agent login succeeded",
			slog.String("login_id", c.ID),
			slog.String("launcher", c.Launcher),
			slog.String("account_label", res.AccountLabel))
		l.report(ctx, c, AgentLoginSucceeded, res.AccountLabel, "")
		l.refreshStatuses(ctx, workerID, c.Launcher)
		return
	}

	// A driver that stopped because the user cancelled or the attempt expired
	// reports ErrAgentLoginStopped / a context error; both are statuses the
	// row deserves, not failures.
	status := AgentLoginFailed
	text := err.Error()
	switch {
	case s.lastObserved() == AgentLoginCancelled:
		status = AgentLoginCancelled
		text = ""
	case s.lastObserved() == AgentLoginExpired, runCtx.Err() == context.DeadlineExceeded, errors.Is(err, context.DeadlineExceeded):
		status = AgentLoginExpired
		text = "The sign-in attempt expired before it finished."
	case errors.Is(err, ErrAgentLoginStopped), errors.Is(err, context.Canceled):
		status = AgentLoginCancelled
		text = ""
	}
	l.log.Info("agent login finished",
		slog.String("login_id", c.ID),
		slog.String("launcher", c.Launcher),
		slog.String("status", status))
	l.report(ctx, c, status, "", text)
	l.refreshStatuses(ctx, workerID, c.Launcher)
}

// report writes one terminal status. A lost lease here means the row is
// somebody else's now; the write was fenced and the loop moves on.
func (l *AgentLoginLoop) report(ctx context.Context, c AgentLoginClaim, status, accountLabel, errText string) {
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), l.cfg.ReportTimeout)
	defer cancel()
	if err := l.store.FinishAgentLogin(reportCtx, c, status, accountLabel, errText); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			l.log.Warn("agent login report lost the lease",
				slog.String("login_id", c.ID), slog.String("launcher", c.Launcher))
			return
		}
		l.log.Error("agent login report failed",
			slog.String("login_id", c.ID),
			slog.String("launcher", c.Launcher),
			slog.String("error", err.Error()))
	}
}

// heartbeat renews the lease for as long as the driver runs. Every poll also
// carries whatever the user did meanwhile (a pasted code, a cancel), and a
// poll that returns ErrLeaseLost stops the sign-in child on the spot.
func (l *AgentLoginLoop) heartbeat(ctx context.Context, s *agentLoginSession) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.clock.After(l.cfg.LeaseHeartbeat):
		}
		status, err := s.poll(ctx)
		if err != nil {
			if errors.Is(err, ErrLeaseLost) {
				return
			}
			if ctx.Err() != nil {
				return
			}
			l.log.Warn("agent login lease heartbeat failed",
				slog.String("login_id", s.c.ID),
				slog.String("launcher", s.c.Launcher),
				slog.String("error", err.Error()))
			continue
		}
		switch status {
		case AgentLoginCancelled, AgentLoginExpired:
			// The driver learns through Stopped/WaitCode; the row is finished
			// by the loop, so the heartbeat has nothing left to renew.
			return
		}
	}
}

// refreshStatuses probes one launcher (all of them when only is "") and writes
// this worker's view into agent_account_status. A probe that did not answer is
// recorded as unknown with the reason, never skipped: the Settings page must
// distinguish "this worker never looked" from "looking failed".
func (l *AgentLoginLoop) refreshStatuses(ctx context.Context, workerID, only string) {
	launchers := make([]string, 0, len(l.drivers))
	for name := range l.drivers {
		if only != "" && name != only {
			continue
		}
		launchers = append(launchers, name)
	}
	sort.Strings(launchers)
	for _, name := range launchers {
		driver := l.drivers[name]
		probeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), l.cfg.StatusTimeout)
		st, err := driver.Status(probeCtx)
		cancel()
		if err != nil {
			st = AgentAccountState{
				State:  AgentAccountUnknown,
				Detail: "Couldn't check the sign-in: " + err.Error(),
			}
		}
		upCtx, upCancel := context.WithTimeout(context.WithoutCancel(ctx), l.cfg.ReportTimeout)
		if err := l.store.UpsertAgentAccountStatus(upCtx, workerID, name, st.State, st.AccountLabel, st.Detail); err != nil {
			l.log.Warn("agent account status upsert failed",
				slog.String("worker_id", workerID),
				slog.String("launcher", name),
				slog.String("error", err.Error()))
		} else {
			l.log.Info("agent account status refreshed",
				slog.String("worker_id", workerID),
				slog.String("launcher", name),
				slog.String("state", st.State),
				slog.String("account_label", st.AccountLabel))
		}
		upCancel()
	}
}

// Drain implements the worker loop shutdown hook: stop claiming, stop the
// sign-in child, and wait for it to report, bounded by ctx.
func (l *AgentLoginLoop) Drain(ctx context.Context) error {
	l.mu.Lock()
	cancel := l.childCancel
	if !l.closed {
		l.closed = true
		close(l.stopCh)
	}
	l.mu.Unlock()
	if cancel != nil {
		l.log.Info("agent login drain: stopping the in-flight sign-in")
		cancel()
	}
	l.log.Info("agent login drain: waiting for the in-flight sign-in")
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

func (l *AgentLoginLoop) stopping() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

func (l *AgentLoginLoop) setChildCancel(cancel context.CancelFunc) {
	l.mu.Lock()
	l.childCancel = cancel
	l.mu.Unlock()
}

// agentLoginSession is the driver-side view of one claimed sign-in. It owns
// the single funnel through which every PollAgentLogin answer passes: a
// submitted code is stashed as soon as any poll — the driver's own or the
// lease heartbeat's — brings it back, so a code can never be consumed by the
// heartbeat and lost to a driver waiting in WaitCode.
type agentLoginSession struct {
	store    AgentLoginStore
	c        AgentLoginClaim
	log      *slog.Logger
	clock    Clock
	codePoll time.Duration

	// childCancel stops the running sign-in the moment a store call says the
	// lease is gone.
	childCancel context.CancelFunc

	// codeMu guards the stashed codes; codeWake wakes a waiting driver.
	codeMu   sync.Mutex
	codes    []string
	codeWake chan struct{}

	mu         sync.Mutex
	lastStatus string
	lost       bool
}

// poll is the ONE route to PollAgentLogin. It renews the lease and folds any
// submitted code into the stash; callers never see a raw code.
func (s *agentLoginSession) poll(ctx context.Context) (status string, err error) {
	status, code, err := s.store.PollAgentLogin(ctx, s.c)
	s.mu.Lock()
	if errors.Is(err, ErrLeaseLost) {
		if !s.lost {
			s.lost = true
			s.log.Warn("agent login lease lost; stopping the sign-in child",
				slog.String("login_id", s.c.ID), slog.String("launcher", s.c.Launcher))
			if s.childCancel != nil {
				s.childCancel()
			}
		}
		s.mu.Unlock()
		return status, ErrLeaseLost
	}
	if err == nil && status != "" {
		s.lastStatus = status
	}
	s.mu.Unlock()
	if err != nil {
		return status, err
	}
	if code != "" {
		s.stashCode(code)
		// The code itself is never logged: it is the user's credential.
		s.log.Info("agent login code received from the app",
			slog.String("login_id", s.c.ID), slog.String("launcher", s.c.Launcher))
	}
	return status, nil
}

func (s *agentLoginSession) stashCode(code string) {
	s.codeMu.Lock()
	s.codes = append(s.codes, code)
	s.codeMu.Unlock()
	select {
	case s.codeWake <- struct{}{}:
	default: // a waiting driver will take every stashed code
	}
}

func (s *agentLoginSession) takeCode() string {
	s.codeMu.Lock()
	defer s.codeMu.Unlock()
	if len(s.codes) == 0 {
		return ""
	}
	code := s.codes[0]
	s.codes = s.codes[1:]
	return code
}

func (s *agentLoginSession) leaseLost() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lost
}

func (s *agentLoginSession) lastObserved() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastStatus
}

// Prompt publishes the link (and, for Codex, the device code) and moves the
// row to awaiting_user.
func (s *agentLoginSession) Prompt(ctx context.Context, p AgentLoginPrompt) error {
	err := s.store.SetAgentLoginPrompt(ctx, s.c, p.VerificationURL, p.UserCode, p.NeedsCode)
	s.mu.Lock()
	if errors.Is(err, ErrLeaseLost) {
		if !s.lost {
			s.lost = true
			if s.childCancel != nil {
				s.childCancel()
			}
		}
		s.mu.Unlock()
		return ErrLeaseLost
	}
	if err == nil {
		s.lastStatus = AgentLoginAwaitingUser
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	s.log.Info("agent login prompt published",
		slog.String("login_id", s.c.ID),
		slog.String("launcher", s.c.Launcher),
		slog.Bool("needs_code", p.NeedsCode),
		slog.Bool("has_code", p.UserCode != ""))
	return nil
}

// WaitCode blocks until a submitted code arrives (from this call's own poll or
// from the lease heartbeat), the user cancels, the attempt expires, or ctx
// ends.
func (s *agentLoginSession) WaitCode(ctx context.Context) (string, error) {
	for {
		if code := s.takeCode(); code != "" {
			return code, nil
		}
		status, err := s.poll(ctx)
		if err != nil {
			return "", err
		}
		if code := s.takeCode(); code != "" {
			return code, nil
		}
		switch status {
		case AgentLoginCancelled, AgentLoginExpired:
			return "", ErrAgentLoginStopped
		}
		select {
		case <-s.codeWake:
		case <-ctx.Done():
			return "", ctx.Err()
		case <-s.clock.After(s.codePoll):
		}
	}
}

// Stopped reports whether the sign-in is over from the user's side: cancelled,
// expired, or no longer ours.
func (s *agentLoginSession) Stopped(ctx context.Context) (bool, error) {
	status, err := s.poll(ctx)
	if err != nil {
		if errors.Is(err, ErrLeaseLost) {
			return true, nil
		}
		return false, err
	}
	switch status {
	case AgentLoginCancelled, AgentLoginExpired:
		return true, nil
	}
	return false, nil
}

// agentLoginSecretRe matches the query/flag forms whose value is credential
// material: an authorization code, an OAuth state, a PKCE challenge, a
// client secret or a token. The value runs to the next delimiter.
var agentLoginSecretRe = regexp.MustCompile(`(?i)(code|state|secret|token|challenge|key)=([^&;\s"'<>\\]*)`)

// agentLoginRedactText turns child output that is about to become a
// user-visible error sentence into text that carries no credential: every
// code=/state=/code_challenge=/token=-shaped value and every occurrence of the
// submitted code itself becomes an ellipsis.
func agentLoginRedactText(s string, secrets ...string) string {
	s = agentLoginSecretRe.ReplaceAllString(s, "${1}=…")
	for _, secret := range secrets {
		if len(secret) < 4 {
			continue
		}
		s = strings.ReplaceAll(s, secret, "…")
	}
	return s
}

// launcherIDs are the launchers this loop has a driver for, sorted; the claim
// only takes sign-ins for these.
func (l *AgentLoginLoop) launcherIDs() []string {
	ids := make([]string, 0, len(l.drivers))
	for id := range l.drivers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
