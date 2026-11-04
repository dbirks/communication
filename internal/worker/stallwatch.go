package worker

import (
	"bytes"
	"log/slog"
	"runtime/pprof"
	"sync"
	"time"
)

// Stall-watch cadence (worker-stall-2, lab run 41921504494): the worker sat
// silent for 17 minutes behind an in-flight turn whose ACP peer was alive
// but unresponsive — the claim loops idled on their ticks, the lease
// renewals kept succeeding, and no log line existed that said a claimed
// turn was doing nothing. The watch answers that question: it is a pure
// diagnostic (it never fails a turn), and its one job is to make a parked
// worker greppable in minutes instead of hours.

const (
	// stallCheckInterval is how often the watch asks "did any loop
	// progress".
	stallCheckInterval = 30 * time.Second
	// stallIdleBound is how long a loop may go without progress before the
	// worker says so.
	stallIdleBound = 2 * time.Minute
	// stallDumpMaxBytes bounds the goroutine dump carried by one stall
	// warning: enough for the parked stacks, bounded for the log.
	stallDumpMaxBytes = 64 * 1024
)

// stallWatch is one named loop's progress observer: the loop calls mark()
// each time it completes an iteration (or, for an in-flight turn, each time
// the stream moves); the checker asks every stallCheckInterval whether the
// mark is older than stallIdleBound, and if so logs ONE
// "worker stall: <loop> idle <dur>" with the process's goroutine dump. It
// re-arms only after progress resumes, so a parked loop warns once — loudly
// — and does not re-warn every tick (worker-stall-2: 17 minutes of silence
// is one finding, not 34).
//
// The check is wall-clock and the dump is stack-only (pprof debug=2: no
// arguments, no environment values), so the warning cannot carry a secret
// the stack does not already hold by name.
type stallWatch struct {
	name      string
	now       func() time.Time
	tick      func() <-chan time.Time
	idleBound time.Duration
	dumpMax   int
	log       *slog.Logger

	mu           sync.Mutex
	lastProgress time.Time
	warned       bool
	stopped      bool

	stopCh chan struct{}
	done   chan struct{}
}

// newStallWatch builds a watch for one named loop. log falls back to
// slog.Default; the production cadence is the package constants above.
func newStallWatch(name string, log *slog.Logger) *stallWatch {
	if log == nil {
		log = slog.Default()
	}
	now := time.Now
	return &stallWatch{
		name:         name,
		now:          now,
		tick:         func() <-chan time.Time { return time.After(stallCheckInterval) },
		idleBound:    stallIdleBound,
		dumpMax:      stallDumpMaxBytes,
		log:          log,
		lastProgress: now(),
	}
}

// mark records loop progress. It re-arms the watch: after a stall warning,
// the next mark silences the re-warning until the loop idles out again.
func (w *stallWatch) mark() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	w.lastProgress = w.now()
	if w.warned {
		w.warned = false
	}
}

// start runs the checker goroutine. One start per watch; the loop that owns
// it defers stop.
func (w *stallWatch) start() {
	w.stopCh = make(chan struct{})
	w.done = make(chan struct{})
	go func() {
		defer close(w.done)
		for {
			select {
			case <-w.stopCh:
				return
			case <-w.tick():
			}
			w.checkOnce()
		}
	}()
}

// checkOnce asks the idle question once. The decision and the emit are one
// critical section, so a concurrent call (the checker goroutine and a test,
// or two ticks in flight) can never emit the one-time warning twice; the
// dump is rendered inside the section, which is what bounds the window.
func (w *stallWatch) checkOnce() {
	w.mu.Lock()
	idle := w.now().Sub(w.lastProgress)
	if w.warned || w.stopped || idle < w.idleBound {
		w.mu.Unlock()
		return
	}
	w.warned = true
	dump := goroutineDump(w.dumpMax)
	w.mu.Unlock()
	w.log.Warn("worker stall: "+w.name+" idle "+idle.Round(time.Second).String(),
		slog.String("goroutine_dump", dump))
}

// stop ends the checker. Idempotent; safe to call from the loop's exit
// path. It waits for the checker to be out of checkOnce so a stop never
// races the one-time warning.
func (w *stallWatch) stop() {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.stopped = true
	stopCh, done := w.stopCh, w.done
	w.mu.Unlock()
	if stopCh == nil {
		return // never started
	}
	close(stopCh)
	<-done
}

// goroutineDump renders the process's stack list (pprof debug=2: stacks
// only — no goroutine arguments, so no secret value rides the dump)
// bounded to max bytes on a rune boundary.
func goroutineDump(max int) string {
	p := pprof.Lookup("goroutine")
	if p == nil {
		return ""
	}
	var buf bytes.Buffer
	if err := p.WriteTo(&buf, 2); err != nil {
		return ""
	}
	b := buf.Bytes()
	if len(b) <= max {
		return string(b)
	}
	b = b[:max]
	// Cut on a rune boundary: the dump is stack text, and a cut inside a
	// multi-byte rune would put a replacement character in the log line.
	for len(b) > 0 && b[len(b)-1]&0xC0 == 0x80 {
		b = b[:len(b)-1]
	}
	return string(b)
}
