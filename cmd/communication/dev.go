package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

const devUsage = `usage: communication dev

runs the control plane (serve) and one execution worker in a single process for
local development. Both read the same environment as they would separately.

This is a convenience orchestration only: one API replica, one worker, no
supervision, no rolling update — explicitly NOT a high-availability runtime
(communication-spec/02-system-architecture.md). Use "communication serve" and
"communication worker" as separate processes everywhere else.

environment:
  the union of "communication serve" and "communication worker" settings;
  COMMUNICATION_DATABASE_URL is required by both
`

const devBanner = "communication dev: one API + one worker in one process — dev convenience only, NOT an HA runtime"

// runDev implements the "dev" mode: serve and worker share the process, the
// environment and one signal context, so the first SIGTERM/SIGINT stops both
// (each performs its own graceful drain). Exit code is the worst of the two.
func runDev(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" || a == "help" {
			fmt.Fprint(stdout, devUsage)
			return 0
		}
	}

	// Two components log into the same streams; without the mutex their JSON
	// records would interleave into garbage (and the race detector would say
	// so in tests).
	out, errOut := &lockedWriter{w: stdout}, &lockedWriter{w: stderr}
	fmt.Fprintln(out, devBanner)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	codes := make(chan int, 2)
	go func() { codes <- runServe(ctx, args, out, errOut) }()
	go func() { codes <- runWorker(ctx, args, out, errOut) }()

	first := <-codes
	if first != 0 {
		// A component that died on its own takes the other one with it: dev
		// mode has no supervision to recover from a half-running stack.
		stop()
	}
	second := <-codes

	if first == 0 && second == 0 {
		return 0
	}
	if first != 0 {
		return first
	}
	return second
}

// lockedWriter serialises writes from the two dev-mode components.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
