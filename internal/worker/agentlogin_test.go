package worker

// The agent login loop's unit tests: the claim → run → fenced-report shape,
// the lease heartbeat's code routing, and the status upserts. Drivers here are
// fakes — what is under test is the loop, not the harnesses (those have their
// own files). Postgres claim/lease/fence semantics are the store worker's
// integration tests; this file drives the loop against an in-memory store.

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// finishCall is one recorded FinishAgentLogin.
type finishCall struct {
	claim        AgentLoginClaim
	status       string
	accountLabel string
	errText      string
}

// statusCall is one recorded UpsertAgentAccountStatus.
type statusCall struct {
	workerID     string
	launcher     string
	state        string
	accountLabel string
	detail       string
}

// promptCall is one recorded SetAgentLoginPrompt.
type promptCall struct {
	claim           AgentLoginClaim
	verificationURL string
	userCode        string
	needsCode       bool
}

// fakeAgentLoginStore is an in-memory AgentLoginStore with scripted polls.
type fakeAgentLoginStore struct {
	mu sync.Mutex

	claims     []AgentLoginClaim
	claimErr   error
	claimCalls int

	pollCalls  int
	pollStatus string
	// codeOnPoll delivers a submitted code on the Nth poll (1-based); 0 = never.
	codeOnPoll int
	code       string
	pollErr    error
	pollErrAt  int

	prompts  []promptCall
	finishes []finishCall
	statuses []statusCall
	// polls is a wake channel signalled on every PollAgentLogin.
	polls chan struct{}
}

func newFakeAgentLoginStore() *fakeAgentLoginStore {
	return &fakeAgentLoginStore{pollStatus: AgentLoginAwaitingUser, polls: make(chan struct{}, 64)}
}

func (f *fakeAgentLoginStore) ClaimAgentLogin(ctx context.Context, workerID string, launchers []string) (AgentLoginClaim, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claimCalls++
	if f.claimErr != nil {
		return AgentLoginClaim{}, false, f.claimErr
	}
	if len(f.claims) == 0 {
		return AgentLoginClaim{}, false, nil
	}
	c := f.claims[0]
	f.claims = f.claims[1:]
	if c.WorkerID == "" {
		c.WorkerID = workerID
	}
	return c, true, nil
}

func (f *fakeAgentLoginStore) SetAgentLoginPrompt(ctx context.Context, c AgentLoginClaim, verificationURL, userCode string, needsCode bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = append(f.prompts, promptCall{claim: c, verificationURL: verificationURL, userCode: userCode, needsCode: needsCode})
	return nil
}

func (f *fakeAgentLoginStore) PollAgentLogin(ctx context.Context, c AgentLoginClaim) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pollCalls++
	n := f.pollCalls
	select {
	case f.polls <- struct{}{}:
	default:
	}
	if f.pollErrAt > 0 && n >= f.pollErrAt {
		return f.pollStatus, "", f.pollErr
	}
	code := ""
	if f.codeOnPoll > 0 && n >= f.codeOnPoll && f.code != "" {
		code = f.code
	}
	return f.pollStatus, code, nil
}

func (f *fakeAgentLoginStore) FinishAgentLogin(ctx context.Context, c AgentLoginClaim, status, accountLabel, errText string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finishes = append(f.finishes, finishCall{claim: c, status: status, accountLabel: accountLabel, errText: errText})
	return nil
}

func (f *fakeAgentLoginStore) UpsertAgentAccountStatus(ctx context.Context, workerID, launcher, state, accountLabel, detail string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses = append(f.statuses, statusCall{workerID: workerID, launcher: launcher, state: state, accountLabel: accountLabel, detail: detail})
	return nil
}

// armCodeOnPoll makes the Nth poll (1-based) return the submitted code.
func (f *fakeAgentLoginStore) armCodeOnPoll(n int, code string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codeOnPoll = n
	f.code = code
}

// armPollErr makes every poll from the Nth on answer err.
func (f *fakeAgentLoginStore) armPollErr(n int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pollErrAt = n
	f.pollErr = err
}

func (f *fakeAgentLoginStore) setPollStatus(status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pollStatus = status
}

func (f *fakeAgentLoginStore) pollCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pollCalls
}

func (f *fakeAgentLoginStore) finishCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.finishes)
}

func (f *fakeAgentLoginStore) statusCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.statuses)
}

func (f *fakeAgentLoginStore) lastFinish() finishCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.finishes) == 0 {
		return finishCall{}
	}
	return f.finishes[len(f.finishes)-1]
}

// fakeAgentLoginDriver is a loop-side AgentLoginDriver: its Login runs an
// injected function against the real session, its Status answers plainly.
type fakeAgentLoginDriver struct {
	state     AgentAccountState
	statusErr error
	login     func(context.Context, AgentLoginSession) (AgentLoginResult, error)

	mu          sync.Mutex
	statusCalls int
	loginCalls  int
}

func (d *fakeAgentLoginDriver) Login(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
	d.mu.Lock()
	d.loginCalls++
	d.mu.Unlock()
	if d.login == nil {
		return AgentLoginResult{}, errors.New("fake driver has no login script")
	}
	return d.login(ctx, s)
}

func (d *fakeAgentLoginDriver) Status(ctx context.Context) (AgentAccountState, error) {
	d.mu.Lock()
	d.statusCalls++
	d.mu.Unlock()
	if d.statusErr != nil {
		return AgentAccountState{}, d.statusErr
	}
	return d.state, nil
}

func quietLoginLogger() AgentLoginOption {
	return WithAgentLoginLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func fastLoginConfig() AgentLoginConfig {
	return AgentLoginConfig{
		PollInterval:     10 * time.Millisecond,
		StatusInterval:   time.Hour,
		StatusTimeout:    2 * time.Second,
		LeaseHeartbeat:   10 * time.Millisecond,
		CodePollInterval: 10 * time.Millisecond,
		ReportTimeout:    2 * time.Second,
	}
}

func testClaim(ttl time.Duration) AgentLoginClaim {
	return AgentLoginClaim{
		ID:             "login-1",
		OrganizationID: "org-1",
		Launcher:       "codex",
		WorkerID:       "worker-1",
		ExpiresAt:      time.Now().Add(ttl),
	}
}

// loopRuns starts the loop and returns it plus a shutdown helper.
func loopRuns(t *testing.T, store AgentLoginStore, drivers map[string]AgentLoginDriver, cfg AgentLoginConfig) *AgentLoginLoop {
	t.Helper()
	loop, err := NewAgentLoginLoop(store, drivers, func() string { return "worker-1" },
		quietLoginLogger(), WithAgentLoginConfig(cfg))
	if err != nil {
		t.Fatalf("NewAgentLoginLoop: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		_ = loop.Drain(context.Background())
		cancel()
	})
	go func() { _ = loop.Start(ctx) }()
	return loop
}

// TestAgentLoginLoopStatusesAtStart is ADR-0085's "the worker writes
// agent_account_status at registration": every launcher with a driver is
// probed before the first claim, so the Settings page has rows to read.
func TestAgentLoginLoopStatusesAtStart(t *testing.T) {
	store := newFakeAgentLoginStore()
	codex := &fakeAgentLoginDriver{state: AgentAccountState{State: AgentAccountSignedIn, AccountLabel: "dev@example.com"}}
	agy := &fakeAgentLoginDriver{statusErr: errors.New("antigravity: no answer")}
	loop := loopRuns(t, store, map[string]AgentLoginDriver{"codex": codex, "antigravity": agy}, fastLoginConfig())

	waitFor(t, "both launcher statuses", func() bool { return store.statusCount() >= 2 })

	var gotUnknown bool
	for _, s := range store.statuses {
		if s.workerID != "worker-1" {
			t.Fatalf("status written for worker %q, want worker-1", s.workerID)
		}
		switch s.launcher {
		case "codex":
			if s.state != AgentAccountSignedIn || s.accountLabel != "dev@example.com" {
				t.Errorf("codex status = %q/%q", s.state, s.accountLabel)
			}
		case "antigravity":
			// A probe that failed is recorded as unknown with the reason — the
			// page must not read a hole as "signed out".
			if s.state != AgentAccountUnknown || !strings.HasPrefix(s.detail, "Couldn't check the sign-in: ") {
				t.Errorf("antigravity status = %q/%q", s.state, s.detail)
			}
			gotUnknown = true
		}
	}
	if !gotUnknown {
		t.Fatal("no unknown status recorded for the failing probe")
	}
	_ = loop
}

// TestAgentLoginLoopSucceedsAndRestoresPrompt covers the happy path from the
// loop's side: the prompt the driver publishes lands in the store, the finish
// carries the driver's label, and the status is refreshed after the attempt.
func TestAgentLoginLoopSucceedsAndRestoresPrompt(t *testing.T) {
	store := newFakeAgentLoginStore()
	driver := &fakeAgentLoginDriver{
		state: AgentAccountState{State: AgentAccountSignedIn, AccountLabel: "dev@example.com"},
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			if err := s.Prompt(ctx, AgentLoginPrompt{VerificationURL: "https://auth.openai.com/codex/device", UserCode: "ABCD-EFGH"}); err != nil {
				return AgentLoginResult{}, err
			}
			return AgentLoginResult{AccountLabel: "dev@example.com"}, nil
		},
	}
	store.claims = []AgentLoginClaim{testClaim(30 * time.Second)}
	loopRuns(t, store, map[string]AgentLoginDriver{"codex": driver}, fastLoginConfig())

	waitFor(t, "the succeeded finish", func() bool { return store.finishCount() >= 1 })
	f := store.lastFinish()
	if f.status != AgentLoginSucceeded || f.accountLabel != "dev@example.com" || f.errText != "" {
		t.Fatalf("finish = %+v", f)
	}
	if f.claim.ID != "login-1" {
		t.Fatalf("finish claim = %q", f.claim.ID)
	}
	if len(store.prompts) != 1 || store.prompts[0].userCode != "ABCD-EFGH" {
		t.Fatalf("prompts = %+v", store.prompts)
	}
	// The initial probe plus the post-attempt refresh of this launcher.
	waitFor(t, "the post-attempt status refresh", func() bool { return store.statusCount() >= 2 })
}

// TestAgentLoginLoopLeaseLostStopsDriverWithoutFinish is the fenced-worker
// rule: a store that says ErrLeaseLost stops the child, and a worker that no
// longer holds the row writes nothing — not even a terminal status.
func TestAgentLoginLoopLeaseLostStopsDriverWithoutFinish(t *testing.T) {
	store := newFakeAgentLoginStore()
	stopped := make(chan struct{})
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			// Wait for the heartbeat's first poll, then have the store refuse.
			waitForSignal(t, store.polls, "the first heartbeat poll")
			store.armPollErr(store.pollCount()+1, ErrLeaseLost)
			<-ctx.Done()
			close(stopped)
			return AgentLoginResult{}, ctx.Err()
		},
	}
	store.claims = []AgentLoginClaim{testClaim(30 * time.Second)}
	loopRuns(t, store, map[string]AgentLoginDriver{"codex": driver}, fastLoginConfig())

	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("the driver's child was not stopped after the lease was lost")
	}
	// Give a late report any chance to land before asserting it did not.
	time.Sleep(100 * time.Millisecond)
	if n := store.finishCount(); n != 0 {
		t.Fatalf("%d finishes written after the lease was lost, want none: %+v", n, store.finishes)
	}
}

// TestAgentLoginLoopHeartbeatCodeReachesWaitCode is the reason every
// PollAgentLogin goes through one helper: the heartbeat's poll can be the one
// that reads-and-clears the user's submitted code, and a code it swallows is a
// sign-in that hangs until it expires.
func TestAgentLoginLoopHeartbeatCodeReachesWaitCode(t *testing.T) {
	store := newFakeAgentLoginStore()
	got := make(chan string, 1)
	cfg := fastLoginConfig()
	cfg.LeaseHeartbeat = 50 * time.Millisecond
	// WaitCode's own poll is slow on purpose: only the heartbeat can be the
	// poll that brings the code back.
	cfg.CodePollInterval = 5 * time.Second
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			waitForSignal(t, store.polls, "a heartbeat poll")
			// The next poll is the waiting driver's own; the one after it is
			// the heartbeat's, and that is the one that must carry the code.
			store.armCodeOnPoll(store.pollCount()+3, "4/hidden-auth-code")
			code, err := s.WaitCode(ctx)
			if err != nil {
				return AgentLoginResult{}, err
			}
			got <- code
			return AgentLoginResult{AccountLabel: "Google account"}, nil
		},
	}
	store.claims = []AgentLoginClaim{{ID: "login-agy", Launcher: "antigravity", WorkerID: "worker-1", ExpiresAt: time.Now().Add(30 * time.Second)}}
	loopRuns(t, store, map[string]AgentLoginDriver{
		"antigravity": driver,
		"codex":       &fakeAgentLoginDriver{},
	}, cfg)

	select {
	case code := <-got:
		if code != "4/hidden-auth-code" {
			t.Fatalf("WaitCode returned %q", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the code returned by a heartbeat poll never reached WaitCode")
	}
	waitFor(t, "the succeeded finish", func() bool { return store.finishCount() >= 1 })
	if f := store.lastFinish(); f.status != AgentLoginSucceeded {
		t.Fatalf("finish = %+v", f)
	}
}

// TestAgentLoginLoopCancelledIsNotAFailure covers the user's cancel: the row
// goes to cancelled with no error sentence, not to failed.
func TestAgentLoginLoopCancelledIsNotAFailure(t *testing.T) {
	store := newFakeAgentLoginStore()
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			store.setPollStatus(AgentLoginCancelled)
			stopped, err := s.Stopped(ctx)
			if err != nil {
				return AgentLoginResult{}, err
			}
			if !stopped {
				return AgentLoginResult{}, errors.New("Stopped said false for a cancelled row")
			}
			return AgentLoginResult{}, ErrAgentLoginStopped
		},
	}
	store.claims = []AgentLoginClaim{testClaim(30 * time.Second)}
	loopRuns(t, store, map[string]AgentLoginDriver{"codex": driver}, fastLoginConfig())

	waitFor(t, "the cancelled finish", func() bool { return store.finishCount() >= 1 })
	if f := store.lastFinish(); f.status != AgentLoginCancelled || f.errText != "" {
		t.Fatalf("finish = %+v", f)
	}
}

// TestAgentLoginLoopExpired covers the row's own deadline: the driver is
// stopped at expires_at and the row is finished as expired.
func TestAgentLoginLoopExpired(t *testing.T) {
	store := newFakeAgentLoginStore()
	cfg := fastLoginConfig()
	cfg.LeaseHeartbeat = time.Hour // the deadline, not the lease, ends this one
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			<-ctx.Done()
			return AgentLoginResult{}, ctx.Err()
		},
	}
	store.claims = []AgentLoginClaim{testClaim(120 * time.Millisecond)}
	loopRuns(t, store, map[string]AgentLoginDriver{"codex": driver}, cfg)

	waitFor(t, "the expired finish", func() bool { return store.finishCount() >= 1 })
	if f := store.lastFinish(); f.status != AgentLoginExpired || f.errText == "" {
		t.Fatalf("finish = %+v", f)
	}
}

// TestAgentLoginLoopFailedCarriesTheSentence is the driver-error path: the
// sentence the driver returns is the sentence the user reads.
func TestAgentLoginLoopFailedCarriesTheSentence(t *testing.T) {
	store := newFakeAgentLoginStore()
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			return AgentLoginResult{}, errors.New("Codex sign-in failed: access denied")
		},
	}
	store.claims = []AgentLoginClaim{testClaim(30 * time.Second)}
	loopRuns(t, store, map[string]AgentLoginDriver{"codex": driver}, fastLoginConfig())

	waitFor(t, "the failed finish", func() bool { return store.finishCount() >= 1 })
	if f := store.lastFinish(); f.status != AgentLoginFailed || f.errText != "Codex sign-in failed: access denied" {
		t.Fatalf("finish = %+v", f)
	}
}

// TestAgentLoginLoopDrainStopsTheRunningSignIn is the shutdown contract: Drain
// stops claiming AND stops the child, and waits for its report.
func TestAgentLoginLoopDrainStopsTheRunningSignIn(t *testing.T) {
	store := newFakeAgentLoginStore()
	inLogin := make(chan struct{})
	ctxSawCancel := make(chan struct{})
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			close(inLogin)
			<-ctx.Done()
			close(ctxSawCancel)
			return AgentLoginResult{}, ctx.Err()
		},
	}
	store.claims = []AgentLoginClaim{testClaim(time.Hour)}
	loop, err := NewAgentLoginLoop(store, map[string]AgentLoginDriver{"codex": driver},
		func() string { return "worker-1" }, quietLoginLogger(), WithAgentLoginConfig(fastLoginConfig()))
	if err != nil {
		t.Fatalf("NewAgentLoginLoop: %v", err)
	}
	startCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = loop.Start(startCtx) }()

	select {
	case <-inLogin:
	case <-time.After(3 * time.Second):
		t.Fatal("the claimed sign-in never started")
	}
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer drainCancel()
	if err := loop.Drain(drainCtx); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	select {
	case <-ctxSawCancel:
	case <-time.After(time.Second):
		t.Fatal("Drain did not stop the running sign-in")
	}
	// The cancelled attempt is reported, not left dangling for the lease to
	// expire and another worker to reclaim.
	if f := store.lastFinish(); store.finishCount() == 0 || f.status != AgentLoginCancelled {
		t.Fatalf("finish after drain = %+v (count %d)", store.finishes, store.finishCount())
	}
}

// TestAgentLoginLoopNeverLogsCredentials guards the ADR-0085 privacy rule on
// the loop's own lines: a code that passes through it must not reach the log.
func TestAgentLoginLoopNeverLogsCredentials(t *testing.T) {
	store := newFakeAgentLoginStore()
	var buf syncWriter
	log := slog.New(slog.NewTextHandler(&buf, nil))
	driver := &fakeAgentLoginDriver{
		login: func(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
			if err := s.Prompt(ctx, AgentLoginPrompt{VerificationURL: "https://accounts.google.com/o/oauth2/auth?code_challenge=CHALLENGE", NeedsCode: true}); err != nil {
				return AgentLoginResult{}, err
			}
			if _, err := s.WaitCode(ctx); err != nil {
				return AgentLoginResult{}, err
			}
			return AgentLoginResult{AccountLabel: "Google account"}, nil
		},
	}
	store.claims = []AgentLoginClaim{{ID: "login-2", Launcher: "antigravity", WorkerID: "worker-1", ExpiresAt: time.Now().Add(30 * time.Second)}}
	store.armCodeOnPoll(1, "4/SUPERSECRETCODE")
	loop, err := NewAgentLoginLoop(store, map[string]AgentLoginDriver{"antigravity": driver},
		func() string { return "worker-1" }, WithAgentLoginLogger(log), WithAgentLoginConfig(fastLoginConfig()))
	if err != nil {
		t.Fatalf("NewAgentLoginLoop: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = loop.Start(ctx) }()

	waitFor(t, "the succeeded finish", func() bool { return store.finishCount() >= 1 })
	if text := buf.String(); strings.Contains(text, "SUPERSECRETCODE") || strings.Contains(text, "CHALLENGE") {
		t.Fatalf("the log carries credential material: %s", text)
	}
}

// waitForSignal waits for a fake-store wake signal with a test watchdog.
func waitForSignal(t *testing.T, ch chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// syncWriter is a locked log sink.
type syncWriter struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *syncWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// fakeAgentLoginSession is the driver-test stand-in for the loop's session: it
// plays the user, pasting a code and cancelling on the test's schedule.
type fakeAgentLoginSession struct {
	started time.Time

	// code is what WaitCode returns after codeDelay; stopped turns Stopped
	// true after stopAfter. Zero delays mean "immediately" for the code and
	// "never" for the cancel.
	code         string
	codeErr      error
	codeDelay    time.Duration
	stopAfter    time.Duration
	promptErr    error
	closeWaitErr error

	mu     sync.Mutex
	prompt *AgentLoginPrompt
	calls  []string
}

func newFakeAgentLoginSession() *fakeAgentLoginSession {
	return &fakeAgentLoginSession{started: time.Now(), stopAfter: time.Hour}
}

func (f *fakeAgentLoginSession) Prompt(ctx context.Context, p AgentLoginPrompt) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := p
	f.prompt = &cp
	f.calls = append(f.calls, "prompt")
	if f.promptErr != nil {
		return f.promptErr
	}
	return nil
}

func (f *fakeAgentLoginSession) WaitCode(ctx context.Context) (string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, "wait")
	f.mu.Unlock()
	delay := f.codeDelay
	if f.codeErr != nil {
		time.Sleep(delay)
		return "", f.codeErr
	}
	select {
	case <-time.After(delay):
		return f.code, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (f *fakeAgentLoginSession) Stopped(ctx context.Context) (bool, error) {
	return time.Since(f.started) >= f.stopAfter, nil
}

func (f *fakeAgentLoginSession) promptCopy() *AgentLoginPrompt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.prompt
}

// writeFakeBinary drops an executable script into dir and returns its path.
// The sign-in children are CLI invocations, so the fakes are bash scripts that
// print the observed wire shapes (the acp_disconnect_test.go idiom).
func writeFakeBinary(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}
