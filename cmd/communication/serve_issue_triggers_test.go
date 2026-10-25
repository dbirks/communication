package main

// The issue-trigger tick loop's survival contract (ADR-0056 part 2, the
// 2026-10-25 lab's second failure): the loop outlives EVERY pass outcome —
// an error, a panic, a pass that ran long — logging each and beating on. The
// lab's freeze read as "the ticker goroutine exited" precisely because the
// surviving loop was silent; silence is now a defect in its own right, and
// this test pins the loud half next to the never-exit half.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// fakeIssueTick answers a canned script of beats: <0 errors, ==999 panics,
// ==888 runs long (past the tick interval), everything else is the fired
// count. The beat after the script closes done.
type fakeIssueTick struct {
	mu    sync.Mutex
	hits  int
	res   []int
	err   error
	done  chan struct{}
	once  sync.Once
	block chan struct{}
}

func (f *fakeIssueTick) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits
}

func (f *fakeIssueTick) TickIssueTriggers(ctx context.Context, _ time.Time, _ github.IssueLister) (int, error) {
	f.mu.Lock()
	i := f.hits
	f.hits++
	f.mu.Unlock()
	if i < len(f.res) {
		switch f.res[i] {
		case -1:
			if f.err != nil {
				return 0, f.err
			}
			return 0, context.DeadlineExceeded
		case 999:
			panic("canned issue-tick panic")
		case 888:
			select {
			case <-time.After(60 * time.Millisecond):
			case <-ctx.Done():
				return 0, ctx.Err()
			}
			return 0, nil
		}
		if i == len(f.res)-1 {
			f.once.Do(func() { close(f.done) })
		}
		return f.res[i], nil
	}
	return 0, nil
}

func TestRunIssueTriggerTickerSurvivesErrorsPanicsAndLongPasses(t *testing.T) {
	var logs syncBuffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	f := &fakeIssueTick{
		res:  []int{2, -1, 999, 888, 1},
		err:  errors.New("issue trigger 01a173c7: poll cut loose"),
		done: make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	loopDone := make(chan error, 1)
	go func() { loopDone <- runIssueTriggerTicker(ctx, f, github.New(), 5*time.Millisecond, log) }()

	select {
	case <-f.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the loop stopped beating before the canned script ran out (beats=%d, log=%s)", f.calls(), logs.String())
	}
	cancel()
	select {
	case err := <-loopDone:
		if err != nil {
			t.Fatalf("runIssueTriggerTicker returned %v on shutdown, want a clean nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runIssueTriggerTicker did not return after its context ended")
	}

	if hits := f.calls(); hits < 5 {
		t.Errorf("the loop beat only %d times; a failed or panicking pass must not end it (log=%s)", hits, logs.String())
	}
	text := logs.String()
	if !strings.Contains(text, `"msg":"issue triggers fired"`) || !strings.Contains(text, `"runs_created":2`) {
		t.Errorf("want an INFO line naming the fired count, got %s", text)
	}
	if !strings.Contains(text, "issue trigger tick failed") {
		t.Errorf("a failed pass must be logged and retried, got %s", text)
	}
	if !strings.Contains(text, "issue trigger tick panicked") {
		t.Errorf("a panicking pass must be recovered, logged and retried, got %s", text)
	}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		var rec map[string]any
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		m, _ := rec["msg"].(string)
		want := m == "issue trigger tick failed" || m == "issue trigger tick panicked"
		if want && rec["level"] != "WARN" {
			t.Errorf("pass failures must be WARN (%s), got level %v", m, rec["level"])
		}
		if m == "issue triggers fired" {
			if n, ok := rec["runs_created"].(float64); ok && n == 0 {
				t.Errorf("a zero-fire beat must not log INFO: %s", text)
			}
		}
	}
}

func TestRunIssueTriggerTickerNilStoreRefuses(t *testing.T) {
	err := runIssueTriggerTicker(context.Background(), nil, github.New(), time.Minute, nil)
	if err == nil || !strings.Contains(err.Error(), "no store") {
		t.Fatalf("runIssueTriggerTicker(nil) = %v, want a refusal naming the missing store", err)
	}
}
