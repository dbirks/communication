package worker

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// warnCapture is the minimal slog handler the stall-watch tests drive: it
// keeps every warning message so a test can count warnings exactly — the
// "ONE warn, then re-arm only after progress" contract is the behavior under
// test (worker-stall-2).
type warnCapture struct {
	mu    sync.Mutex
	warns []string
}

func (w *warnCapture) Enabled(context.Context, slog.Level) bool { return true }

func (w *warnCapture) Handle(_ context.Context, r slog.Record) error {
	if r.Level < slog.LevelWarn {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.warns = append(w.warns, r.Message)
	return nil
}

func (w *warnCapture) WithAttrs([]slog.Attr) slog.Handler { return w }

func (w *warnCapture) WithGroup(string) slog.Handler { return w }

func (w *warnCapture) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.warns)
}

// TestStallWatchWarnsOnceAndRearmsOnProgress drives the watch with a fake
// clock and a manual tick channel:
//
//  1. progress inside the idle bound → no warning;
//  2. idle past the bound → exactly ONE warning, named, with the idle
//     duration;
//  3. further ticks while still idle → no re-warning (the lab's 17 minutes
//     is one finding, not 34);
//  4. progress resumes → the watch re-arms, and the next idle-out warns
//     again.
func TestStallWatchWarnsOnceAndRearmsOnProgress(t *testing.T) {
	start := time.Date(2026, 11, 4, 22, 19, 53, 0, time.UTC)
	now := start
	tick := make(chan time.Time, 8)
	cap := &warnCapture{}
	w := &stallWatch{
		name:      "turn 01K0FAKE",
		now:       func() time.Time { return now },
		tick:      func() <-chan time.Time { return tick },
		idleBound: 2 * time.Minute,
		dumpMax:   4096,
		log:       slog.New(cap),
	}
	w.lastProgress = now
	w.start()
	defer w.stop()

	// 1. Two minutes minus a second of silence: still inside the bound.
	now = start.Add(2*time.Minute - time.Second)
	w.checkOnce()
	if n := cap.count(); n != 0 {
		t.Fatalf("warning after %s of idle (bound %s): %d", 2*time.Minute-time.Second, w.idleBound, n)
	}

	// 2. Past the bound: exactly one warning, named, with the duration.
	now = start.Add(2 * time.Minute)
	w.checkOnce()
	if n := cap.count(); n != 1 {
		t.Fatalf("warnings after 2m idle = %d, want 1", n)
	}
	if got := cap.warns[0]; !strings.Contains(got, "worker stall: turn 01K0FAKE idle 2m0s") {
		t.Fatalf("warning message = %q, want \"worker stall: turn 01K0FAKE idle 2m0s\" inside it", got)
	}

	// 3. Ten more ticks while still idle: silence is one finding.
	for i := 0; i < 10; i++ {
		now = now.Add(30 * time.Second)
		w.checkOnce()
	}
	if n := cap.count(); n != 1 {
		t.Fatalf("warnings after 6.5m of continued idle = %d, want still 1", n)
	}

	// 4. Progress resumes: while the loop keeps marking, the re-armed watch
	// stays silent.
	for i := 0; i < 5; i++ {
		now = now.Add(30 * time.Second)
		w.mark()
		w.checkOnce()
	}
	if n := cap.count(); n != 1 {
		t.Fatalf("warnings during resumed progress = %d, want still 1", n)
	}
	// 5. Progress stops again: the re-armed watch warns once more.
	for i := 0; i < 5; i++ {
		now = now.Add(30 * time.Second)
		w.checkOnce()
	}
	if n := cap.count(); n != 2 {
		t.Fatalf("warnings after the second idle-out = %d, want 2 (re-armed)", n)
	}
}

// TestStallWatchCheckerLoopRunsAndStops covers the goroutine the loop
// actually runs: a tick through the channel fires one check, and stop
// drains the checker cleanly (no goroutine left behind, no warning after
// stop).
func TestStallWatchCheckerLoopRunsAndStops(t *testing.T) {
	start := time.Now()
	now := start
	tick := make(chan time.Time, 8)
	cap := &warnCapture{}
	w := &stallWatch{
		name:      "attempt claim loop",
		now:       func() time.Time { return now },
		tick:      func() <-chan time.Time { return tick },
		idleBound: time.Second,
		dumpMax:   256,
		log:       slog.New(cap),
	}
	w.lastProgress = now
	w.start()

	now = now.Add(2 * time.Second)
	tick <- time.Now()
	deadline := time.Now().Add(5 * time.Second)
	for cap.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := cap.count(); n != 1 {
		t.Fatalf("warnings through the checker goroutine = %d, want 1", n)
	}

	// stop drains the checker; marks after stop are inert.
	w.stop()
	w.stop() // idempotent
	now = now.Add(10 * time.Second)
	w.mark()
	w.mu.Lock()
	idle := now.Sub(w.lastProgress)
	rearmed := !w.warned
	w.mu.Unlock()
	if rearmed || idle < 10*time.Second {
		t.Fatalf("mark after stop rewrote progress (warned=%v, idle=%s)", w.warned, idle)
	}
}

// TestGoroutineDumpIsBounded pins the dump's byte bound and its
// rune-boundary cut: a dump must never exceed max bytes, whatever the
// process's stack list weighs in at.
func TestGoroutineDumpIsBounded(t *testing.T) {
	for _, max := range []int{64 * 1024, 1024, 64, 8} {
		dump := goroutineDump(max)
		if len(dump) > max {
			t.Fatalf("goroutineDump(%d) returned %d bytes", max, len(dump))
		}
		// The cut must leave valid UTF-8: the dump is stack text, and a cut
		// inside a multi-byte rune would poison the log line.
		for _, r := range dump {
			if r == '\ufffd' {
				t.Fatalf("goroutineDump(%d) contains a replacement rune: cut inside a rune", max)
			}
		}
	}
}
