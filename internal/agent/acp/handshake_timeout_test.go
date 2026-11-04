package acp

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// TestHandshakeBoundedAgainstSilentPeer is worker-stall-2 at the protocol
// level: the harness starts its process, answers nothing at initialize, and
// stays alive. The worker's attempt path calls StartWithOptions on a
// context with no deadline of its own, so the handshake is the only thing
// that can bound the wait — before the bound, one such peer parked the
// whole worker for 17 minutes (lab run 41921504494). The bound must fail
// the session honestly, on the caller's clock, and reap the process.
func TestHandshakeBoundedAgainstSilentPeer(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "silent-acp.sh")
	content := `#!/bin/bash
exec 2>/dev/null
read -r line   # initialize arrives; never answer it
sleep 300
`
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}

	old := handshakeTimeout
	handshakeTimeout = 300 * time.Millisecond
	defer func() { handshakeTimeout = old }()

	rt := &Runtime{PermissionPolicy: PermissionDeny}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	sess, err := rt.StartWithOptions(ctx, domain.AgentLaunchSpec{
		Executable: "/bin/bash",
		Args:       []string{script},
		Env:        []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		WorkDir:    dir,
	}, StartOptions{})
	elapsed := time.Since(start)
	if err == nil {
		_ = sess.Close()
		t.Fatalf("StartWithOptions = no error against a peer that answers no initialize")
	}
	// The bound is the handshake's 300 ms plus the bounded teardown ladder
	// (its first rung is a ≤5 s EOF wait) that reaps the killed group; the
	// point under test is that the call RETURNS, in seconds, instead of
	// waiting out the 300 s the peer would otherwise have to answer.
	if elapsed > 20*time.Second {
		t.Fatalf("StartWithOptions took %s: the silent peer must fail the handshake at its bound, not wait it out", elapsed)
	}
	t.Logf("handshake failed after %s: %v", elapsed.Round(time.Millisecond), err)
}
