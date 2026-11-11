package main

import (
	"bytes"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// pod-wait is the attempt pod's whole surface, so the two things worth pinning are
// that it reports the signal it retired on and — the part a test can prove — that
// it does not return before a signal arrives. An entrypoint that exited on its own
// would end every `pods/exec` session with it, which is the only thing it is for.

func TestWaitForShutdownReportsTheSignal(t *testing.T) {
	for _, sig := range []os.Signal{syscall.SIGTERM, syscall.SIGINT} {
		sigs := make(chan os.Signal, 1)
		var out bytes.Buffer
		done := make(chan int, 1)
		go func() { done <- waitForShutdown(sigs, &out) }()
		sigs <- sig
		select {
		case code := <-done:
			if code != 0 {
				t.Errorf("%v: exit code = %d, want 0 (a retired attempt pod has nothing to fail)", sig, code)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%v: pod-wait did not return after the signal", sig)
		}
		line := out.String()
		if !strings.Contains(line, sig.String()) || strings.Count(line, "\n") != 1 {
			t.Errorf("%v: output = %q, want one line naming the signal", sig, line)
		}
	}
}

func TestWaitForShutdownBlocksUntilSignalled(t *testing.T) {
	sigs := make(chan os.Signal, 1)
	var out bytes.Buffer
	returned := make(chan int, 1)
	go func() { returned <- waitForShutdown(sigs, &out) }()
	select {
	case <-returned:
		t.Fatal("pod-wait returned with no signal: the attempt pod would die between its start and its first exec")
	case <-time.After(200 * time.Millisecond):
	}
	// Release the parked goroutine rather than leak it past the test.
	sigs <- syscall.SIGTERM
	if code := <-returned; code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	if out.Len() == 0 {
		t.Error("the retirement was not reported")
	}
}

// TestPodWaitEntrypointDoesNotReadStdin pins the one place this mode deviates from
// ADR-0082 Decision 2's wording ("exits when stdin closes"): the attempt container
// has no stdin attached, so a mode that read it would see EOF at start and retire
// the pod before the worker's first exec landed. Only a signal may retire it.
func TestPodWaitEntrypointDoesNotReadStdin(t *testing.T) {
	src, err := os.ReadFile("podwait.go")
	if err != nil {
		t.Fatalf("read the entrypoint: %v", err)
	}
	text := string(src)
	for _, forbidden := range []string{"os.Stdin", "io.Copy(", "bufio.New"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("podwait.go touches stdin (%q); only a signal may retire an attempt pod", forbidden)
		}
	}
	for _, want := range []string{"syscall.SIGTERM", "syscall.SIGINT", "signal.Notify"} {
		if !strings.Contains(text, want) {
			t.Errorf("podwait.go does not name %s", want)
		}
	}
}
