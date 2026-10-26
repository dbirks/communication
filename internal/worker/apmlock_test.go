package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
)

// fakeAPMLockStore records the claims and completions a loop makes against it.
type fakeAPMLockStore struct {
	mu          sync.Mutex
	claim       APMLockClaim
	claimed     bool
	claimErr    error
	last        APMLockClaim
	lastResult  *apm.ResolveResult
	lastErr     error
	claims      int
	completions int
	// queue holds locks queued behind the scripted claim; each one is armed
	// as the scripted claim only once the previous one completes.
	queue []APMLockClaim
	// passWake and settleWake are optional test wake signals (nil in tests
	// that don't wait on them): passWake pings once per claim pass and
	// settleWake pings once per completion, so a test can synchronise on the
	// loop's real claim/report steps instead of sleeping and re-reading the
	// counters and hoping the loop is parked.
	passWake   chan struct{}
	settleWake chan struct{}
}

// wakeSignal makes a coalescing non-blocking send on a test wake channel;
// a nil channel (a test that doesn't wait) is ignored.
func wakeSignal(ch chan struct{}) {
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// waitSignal waits for a wake signal. The signals are emitted synchronously
// by the fakes as the very last step of a pass/completion, so a correct run
// never reaches the watchdog — it exists only to turn a lost signal into a
// test failure instead of a hang.
func waitSignal(t *testing.T, ch chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(30 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func (f *fakeAPMLockStore) ClaimAPMLockRequest(ctx context.Context, workerID string) (APMLockClaim, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = f.claim
	f.claims++
	defer wakeSignal(f.passWake)
	if f.claimed {
		f.claimed = false
		return f.claim, true, f.claimErr
	}
	return f.claim, false, nil
}

func (f *fakeAPMLockStore) CompleteAPMLockRequest(ctx context.Context, c APMLockClaim, result *apm.ResolveResult, resolveErr error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = c
	f.lastResult = result
	f.lastErr = resolveErr
	f.completions++
	// A completed claim releases the next queued lock, so the loop has to
	// claim again to pick it up.
	if len(f.queue) > 0 {
		f.claim = f.queue[0]
		f.queue = f.queue[1:]
		f.claimed = true
	}
	wakeSignal(f.settleWake)
	return nil
}

// armClaim makes the next claim the scripted one, so a test can queue a claim
// after the loop has already gone idle.
func (f *fakeAPMLockStore) armClaim() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claimed = true
}

// fakeAPMTyper is an APMTyper whose Resolve records its request and answers with
// the scripted outcome, so the loop's resolve/report wiring is testable without
// an apm binary.
type fakeAPMTyper struct {
	mu      sync.Mutex
	request apm.ResolveRequest
	result  *apm.ResolveResult
	err     error
}

func (f *fakeAPMTyper) Stage(ctx context.Context, req apm.StageRequest) (*apm.StagedContext, error) {
	return nil, errors.New("apm: stage not under test")
}

func (f *fakeAPMTyper) Resolve(ctx context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.request = req
	return f.result, f.err
}

func TestAPMLockLoopResolvesAndReportsSuccess(t *testing.T) {
	store := &fakeAPMLockStore{claimed: true, claim: APMLockClaim{
		RequestID: "lock-1", ProfileID: "p-1", OrganizationID: "o-1",
		PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1",
	}}
	resolve := &fakeAPMTyper{result: &apm.ResolveResult{
		LockDigest:  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ResolvedRef: "v1.3.1", Commit: "abc123", APMVersion: "0.34.0",
		Contents: apm.Contents{Skills: []string{"engineering"}, Instructions: []string{"AGENTS.md"}, MCPServers: []string{"memory"}},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, resolve, func() string { return "w-1" })
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		done := store.lastResult != nil
		store.mu.Unlock()
		if done {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.lastErr != nil {
		t.Fatalf("resolve error = %v, want nil", store.lastErr)
	}
	if store.lastResult == nil {
		t.Fatal("the loop never reported a resolve result")
	}
	if store.last.RequestID != "lock-1" {
		t.Errorf("completed request = %q, want lock-1", store.last.RequestID)
	}
	if got := resolve.request.PackageRef; got != "mattpocock/skills#v1.3.1" {
		t.Errorf("resolve package ref = %q, want the pinned ref", got)
	}
}

func TestAPMLockLoopReportsResolveFailure(t *testing.T) {
	store := &fakeAPMLockStore{claimed: true, claim: APMLockClaim{
		RequestID: "lock-2", ProfileID: "p-2", OrganizationID: "o-1",
		PackageRef: "mattpocock/skills#v9.9.9", Target: apm.TargetCodex, WorkerID: "w-1",
	}}
	resolve := &fakeAPMTyper{err: apm.ErrResolveFailed}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, resolve, func() string { return "w-1" })
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		failed := store.lastErr != nil
		store.mu.Unlock()
		if failed {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.lastErr == nil {
		t.Fatal("a failed resolve was never reported")
	}
	if store.lastResult != nil {
		t.Errorf("failure path reported a result: %+v", store.lastResult)
	}
}

func TestAPMLockLoopIdlesWithoutClaims(t *testing.T) {
	store := &fakeAPMLockStore{claimed: false}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, &fakeAPMTyper{}, func() string { return "w-1" })
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	cancel()
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
}

// TestAPMLockLoopPollsAfterIdleClaim is the regression test for the lab's stuck
// queue: the loop must keep scanning the due queue on its claim tick after its
// first (empty) claim, or a lock queued after startup is never picked up.
//
// The loop's claim cadence is wall-clock ticks, so counting claim passes while
// a real 1 s tick runs underneath is a race the test can never win: a scheduling
// stall longer than the tick (trivially had under -cpu 1 plus CPU load) lets the
// loop take a second pass before the test arms the queue, blowing up the
// "exactly one pass before arming" precondition. The test therefore drives the
// loop's clock with the package's fake clock — a second pass is only possible
// when the test itself delivers the tick — and waits on the fake store's
// per-pass / per-completion wake signals, so every assertion lands on a real
// loop state rather than on a wall-clock guess. No timing is asserted here at
// all: only "the tick wakes another claim, and that claim takes the queued lock".
func TestAPMLockLoopPollsAfterIdleClaim(t *testing.T) {
	store := &fakeAPMLockStore{
		claimed:    false,
		passWake:   make(chan struct{}, 1),
		settleWake: make(chan struct{}, 1),
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	clock := newFakeClock()
	l, err := NewAPMLockLoop(store, &fakeAPMTyper{}, func() string { return "w-1" }, WithAPMLockClock(clock))
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()

	// First pass: nothing due. Wait for the claim itself to land; with the fake
	// clock no second pass can happen until this test ticks, so the pass count
	// read below is deterministic, not a race against a real timer.
	waitSignal(t, store.passWake, "the first claim pass")
	store.mu.Lock()
	passes := store.claims
	store.mu.Unlock()
	if passes != 1 {
		t.Fatalf("claim passes = %d, want 1 before arming", passes)
	}

	// Now something is queued: the next poll tick must claim it. The tick is
	// delivered only once the loop is parked in its idle select (fakeClock.tick
	// waits for the After request), and armClaim happened before the tick, so
	// this is exactly the "queued after startup" case the lab hit.
	store.mu.Lock()
	store.claim = APMLockClaim{RequestID: "lock-1", ProfileID: "p-1", OrganizationID: "o-1", PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1"}
	store.mu.Unlock()
	store.armClaim()
	clock.tick(t)
	// The claimed lock's report back through the store — the loop's own
	// completion signal, not a counter the test guesses at.
	waitSignal(t, store.settleWake, "the queued lock's completion")
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.last.RequestID != "lock-1" {
		t.Fatalf("never claimed the queued lock: last claim = %+v", store.last)
	}
	if store.completions != 1 {
		t.Fatalf("completions = %d, want 1 (only the queued lock may be completed)", store.completions)
	}
}

// TestAPMLockLoopClaimsConsecutiveLocks is the regression test for the stuck
// loop: after a claimed lock settles, the loop must claim the next queued lock
// immediately (its wait only ever woke on shutdown before), so two locks
// queued one after the other are both claimed and completed without a Drain in
// between.
func TestAPMLockLoopClaimsConsecutiveLocks(t *testing.T) {
	store := &fakeAPMLockStore{
		claimed: true,
		claim: APMLockClaim{
			RequestID: "lock-a", ProfileID: "p-1", OrganizationID: "o-1",
			PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1",
		},
		queue: []APMLockClaim{{
			RequestID: "lock-b", ProfileID: "p-2", OrganizationID: "o-1",
			PackageRef: "mattpocock/skills#v1.3.2", Target: apm.TargetCodex, WorkerID: "w-1",
		}},
	}
	resolve := &fakeAPMTyper{result: &apm.ResolveResult{
		LockDigest:  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ResolvedRef: "v1.3.2",
	}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, resolve, func() string { return "w-1" })
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	// Wait for BOTH locks to complete; neither claim nor completion is driven
	// by a Drain, which only happens after both are done.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		done := store.completions >= 2
		store.mu.Unlock()
		if done {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.completions != 2 {
		t.Fatalf("completions = %d, want 2 (both queued locks claimed and completed)", store.completions)
	}
	if store.lastErr != nil {
		t.Fatalf("resolve error = %v, want nil", store.lastErr)
	}
	if store.lastResult == nil {
		t.Fatal("the loop never reported a resolve result")
	}
	if store.last.RequestID != "lock-b" {
		t.Fatalf("last completed request = %q, want lock-b", store.last.RequestID)
	}
}

// fakeAPMLockResolver is the APMLockResolver the loop drives: it answers the
// wrapper question (nil here, so the loop resolves plainly through the APM seam)
// and records what it was asked.
type fakeAPMLockResolver struct {
	wrapCalls int
	result    *apm.ResolveResult
	err       error
}

func (f *fakeAPMLockResolver) Resolve(ctx context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error) {
	return f.result, f.err
}

func (f *fakeAPMLockResolver) Wrap(ctx context.Context, req apm.ResolveRequest) (APMLockResolveWrap, func(), error) {
	f.wrapCalls++
	return nil, func() {}, f.err
}

// TestAPMLockLoopResolvesThroughTheSandboxResolver pins the ADR-0054 §B.2 wiring
// from the loop's side: a claimed lock resolves through the worker-supplied
// resolver, which answers the wrapper question, and the resolve it drove carried
// the scratch work dir + scratch home.
func TestAPMLockLoopResolvesThroughTheSandboxResolver(t *testing.T) {
	store := &fakeAPMLockStore{claimed: true, claim: APMLockClaim{
		RequestID: "lock-3", ProfileID: "p-1", OrganizationID: "o-1",
		PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1",
	}}
	resolve := &fakeAPMTyper{result: &apm.ResolveResult{LockDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}
	sandbox := &fakeAPMLockResolver{result: &apm.ResolveResult{LockDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, resolve, func() string { return "w-1" },
		WithAPMLockSandbox(sandbox), WithAPMLockScratchRoot(t.TempDir()))
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		done := store.lastResult != nil
		store.mu.Unlock()
		if done {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.lastErr != nil {
		t.Fatalf("resolve error = %v, want nil", store.lastErr)
	}
	if sandbox.wrapCalls != 1 {
		t.Errorf("sandbox wrapper answers = %d, want 1 (the loop asks the resolver)", sandbox.wrapCalls)
	}
	if resolve.request.Wrap != nil {
		t.Error("resolve wrapped = ..., want nil (the resolver answered plainly)")
	}
	if resolve.request.WorkDir == "" || resolve.request.Home == "" {
		t.Errorf("resolve workdir/home not carried: %q %q", resolve.request.WorkDir, resolve.request.Home)
	}
}

// TestDefaultAPMLockScratchRoot pins the APM lock resolve scratch root's
// default: a directory INSIDE the worker-owned workspace volume
// (<workspace root>/.apm-lock), which the apm-resolve sandbox grants accept —
// workspace paths are what agent turns get granted, and a writable grant under
// the temp tree the sandbox layers by default is refused by omission (probe
// C-TMP1) — rather than the workspace root's parent, which is not writable
// inside the container.
func TestDefaultAPMLockScratchRoot(t *testing.T) {
	for _, tc := range []struct{ root, want string }{
		{"/var/lib/communication/workspaces", "/var/lib/communication/workspaces/.apm-lock"},
		{"/workspaces", "/workspaces/.apm-lock"},
		{"/ws/", "/ws/.apm-lock"},
	} {
		if got := DefaultAPMLockScratchRoot(tc.root); got != tc.want {
			t.Errorf("DefaultAPMLockScratchRoot(%q) = %q, want %q", tc.root, got, tc.want)
		}
	}
}

// TestAPMLockLoopResolveScratchIsFreshAndCleaned pins the resolve's scratch
// shape from the loop's side: the claimed resolve runs in a fresh subdirectory
// under the loop's scratch root and removes it once the resolve settles — a
// resolve owns its scratch dir and never leaves content behind, so the next
// resolve starts from an empty one again.
func TestAPMLockLoopResolveScratchIsFreshAndCleaned(t *testing.T) {
	root := t.TempDir()
	store := &fakeAPMLockStore{claimed: true, claim: APMLockClaim{
		RequestID: "lock-4", ProfileID: "p-1", OrganizationID: "o-1",
		PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1",
	}}
	resolve := &fakeAPMTyper{result: &apm.ResolveResult{LockDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	l, err := NewAPMLockLoop(store, resolve, func() string { return "w-1" }, WithAPMLockScratchRoot(root))
	if err != nil {
		t.Fatalf("NewAPMLockLoop: %v", err)
	}
	go func() { _ = l.Start(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		done := store.lastResult != nil
		store.mu.Unlock()
		if done {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if err := l.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.lastErr != nil {
		t.Fatalf("resolve error = %v, want nil", store.lastErr)
	}
	if resolve.request.WorkDir == "" || resolve.request.Home == "" {
		t.Fatalf("resolve workdir/home not carried: %q %q", resolve.request.WorkDir, resolve.request.Home)
	}
	for _, p := range []string{resolve.request.WorkDir, resolve.request.Home} {
		if !strings.HasPrefix(p, root+string(filepath.Separator)) {
			t.Errorf("resolve path %q is not under the scratch root %q", p, root)
		}
	}
	if resolve.request.WorkDir == resolve.request.Home {
		t.Errorf("resolve workdir %q and home %q must be distinct", resolve.request.WorkDir, resolve.request.Home)
	}
	if _, err := os.Stat(resolve.request.WorkDir); !os.IsNotExist(err) {
		t.Errorf("resolve workdir %q was not removed after the resolve: %v", resolve.request.WorkDir, err)
	}
	if _, err := os.Stat(resolve.request.Home); !os.IsNotExist(err) {
		t.Errorf("resolve home %q was not removed after the resolve: %v", resolve.request.Home, err)
	}
}
