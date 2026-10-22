package worker

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
)

// fakeAPMLockStore records the claims and completions a loop makes against it.
type fakeAPMLockStore struct {
	mu         sync.Mutex
	claim      APMLockClaim
	claimed    bool
	claimErr   error
	last       APMLockClaim
	lastResult *apm.ResolveResult
	lastErr    error
}

func (f *fakeAPMLockStore) ClaimAPMLockRequest(ctx context.Context, workerID string) (APMLockClaim, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = f.claim
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
	return nil
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
		ResolvedRef: "v1.3.1", Commit: "abc123", APMVersion: "0.33.0",
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
