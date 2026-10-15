package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRunDevRequiresDatabaseURL(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "http://localhost:18080")
	t.Setenv("COMMUNICATION_WORKER_NAME", "dev-worker")

	var stdout, stderr bytes.Buffer
	if got := runDev(context.Background(), nil, &stdout, &stderr); got != 2 {
		t.Fatalf("runDev() = %d, want 2", got)
	}
	if want := "COMMUNICATION_DATABASE_URL is not set"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want substring %q", stderr.String(), want)
	}
	// Both components validate configuration before touching the database, so
	// dev must have run both — and said what it is while doing so.
	if n := strings.Count(stderr.String(), "COMMUNICATION_DATABASE_URL is not set"); n != 2 {
		t.Errorf("config error reported %d times, want 2 (serve and worker both run)", n)
	}
	if want := "NOT an HA runtime"; !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want the dev-mode banner substring %q", stdout.String(), want)
	}
	if lines := strings.Count(strings.TrimRight(stdout.String(), "\n"), "\n"); lines != 0 {
		t.Errorf("banner must be one line, got %d lines: %q", lines+1, stdout.String())
	}
}

func TestRunDevHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runDev(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runDev(--help) = %d, want 0", got)
	}
	if want := "usage: communication dev"; !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want substring %q", stdout.String(), want)
	}
}

// TestRunDevStopsBothWhenOneComponentDies proves the shared-context wiring.
// serve fails its configuration check immediately, while the worker is validly
// configured against an unreachable database and would otherwise sit in the
// 60s openPool retry window. If the cancelled context reaches the worker, dev
// returns in seconds with the failure instead of hanging.
func TestRunDevStopsBothWhenOneComponentDies(t *testing.T) {
	t.Setenv("COMMUNICATION_DATABASE_URL", "postgres://communication@127.0.0.1:1/communication?sslmode=disable")
	t.Setenv("COMMUNICATION_PUBLIC_URL", "") // serve: config error, exit 2 right away
	t.Setenv("COMMUNICATION_WORKER_NAME", "dev-worker")
	t.Setenv("COMMUNICATION_WORKER_HEARTBEAT", "1s")

	var stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runDev(context.Background(), nil, io.Discard, &stderr)
	}()

	select {
	case got := <-done:
		if got == 0 {
			t.Error("runDev() = 0, want a failure code when a component died")
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("runDev did not return within 20s (openPool retries for %s): a dead component did not stop the other one", dbDialTimeout)
	}

	if want := "database unavailable"; !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want the worker to report it was stopped while waiting for the database (substring %q)", stderr.String(), want)
	}
}

func TestLockedWriterSerialisesWrites(t *testing.T) {
	var buf bytes.Buffer
	w := &lockedWriter{w: &buf}

	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			fmt.Fprintf(w, "line-%d\n", i)
		}(i)
	}
	wg.Wait()

	got := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(got) != 8 {
		t.Fatalf("interleaved writes: %q", buf.String())
	}
	seen := map[string]bool{}
	for _, line := range got {
		if len(line) != len("line-0") || !strings.HasPrefix(line, "line-") {
			t.Errorf("torn write: %q", line)
			continue
		}
		seen[line] = true
	}
	if len(seen) != 8 {
		t.Errorf("wrote %v, want eight intact distinct lines", seen)
	}
}
