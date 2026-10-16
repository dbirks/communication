package main

// syncBuffer backs a slog test logger whose writer is shared between the
// goroutines under test (reconciler, driver, ticker loops writing log lines)
// and the test goroutine reading the captured output. A bare bytes.Buffer is
// not safe for that: -race flags bytes.(*Buffer).String() against the
// handler's bytes.(*Buffer).grow(). All access goes through mu.

import (
	"bytes"
	"sync"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
