package main

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

// runPodWait is an attempt pod's entrypoint (ADR-0082 Decision 2).
//
// It does one thing: stay alive. The pod exists to host `pods/exec` sessions, and
// a container that exits takes the exec's target with it — so the worker would
// have created a pod it cannot talk into. `sleep infinity` would do the same job
// but exits 0 on no signal at all and hides the reason a pod went away; this
// names the signal it was retired by, which is the line an operator reads in
// `kubectl describe pod`.
//
// It deliberately does NOT exit when stdin closes. The container has no stdin
// attached (only the exec sessions do), so an EOF-on-stdin rule would kill every
// attempt pod the moment it started. Termination arrives as SIGTERM from the API
// server when the worker deletes the pod, and SIGTERM is the whole contract.
func runPodWait(stdout, stderr io.Writer) int {
	sigs := make(chan os.Signal, 1)
	// SIGTERM is the graceful deletion signal; SIGINT covers a node draining the
	// pod by hand. Anything else the runtime delivers stays default (terminate),
	// which is the answer we would give anyway.
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigs)
	return waitForShutdown(sigs, stdout)
}

// waitForShutdown is the wait itself, split out so the test can hand it a channel
// instead of signalling this process (which would be caught by every other
// handler in the test binary, including the worker's own).
func waitForShutdown(sigs <-chan os.Signal, stdout io.Writer) int {
	sig := <-sigs
	fmt.Fprintf(stdout, "communication pod-wait: retiring attempt pod on %s\n", sig)
	return 0
}
