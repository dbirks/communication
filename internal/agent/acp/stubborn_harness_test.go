package acp

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// TestCloseRetiresAHarnessThatOutlivesItsOwnPipe is the lab-41789603709
// sequence at the protocol level: the harness finishes its handshake, closes
// its stdio while a turn is open, ignores SIGTERM, and an orphaned grandchild
// keeps the stderr pipe open. Close must retire the whole process group and
// return within its ladder — the pre-fix ladder killed only the direct
// process, cmd.Wait then waited on the stderr copier for an EOF the orphan
// would never give, and every caller of Close (the worker's turn loop
// included) parked forever behind it.
func TestCloseRetiresAHarnessThatOutlivesItsOwnPipe(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "stubborn-acp.sh")
	content := `#!/bin/bash
trap '' TERM
read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"stubborn","version":"0.1"}}}'
read -r line
echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"stubborn-session"}}'
# session/prompt arrives now; never answer, never exit. The grandchild
# inherits the stderr pipe and keeps it open past the harness's own death.
sleep 300 &
wait
`
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}

	rt := &Runtime{PermissionPolicy: PermissionDeny}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	sess, err := rt.StartWithOptions(ctx, domain.AgentLaunchSpec{
		Executable: "/bin/bash",
		Args:       []string{script},
		Env:        []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		WorkDir:    dir,
	}, StartOptions{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	h := sess.(*handle)

	started := time.Now()
	waitErr := h.Close()
	if elapsed := time.Since(started); elapsed > 60*time.Second {
		t.Fatalf("Close took %s: the teardown ladder must bound itself instead of waiting on a peer that will never answer again", elapsed)
	}
	// The ladder only reaches SIGKILL when the group ignored SIGTERM — this
	// child does, so the wait error is the SIGKILL word, and the reap
	// goroutine must have closed `exited` (a zombie the worker would keep).
	if waitErr == nil {
		t.Fatalf("Close = nil error, want the SIGKILL word: the group was signalled and killed")
	}
	select {
	case <-h.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the harness process was not reaped after Close")
	}
}
