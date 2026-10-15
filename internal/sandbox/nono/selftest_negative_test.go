package nono

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestSelfTestFailsWhenEnforcementIsAbsent replaces nono with a shim that just
// execs the child with no sandbox at all. If the self-test still passes, it is
// vacuous and the startup gate built on it is theater.
func TestSelfTestFailsWhenEnforcementIsAbsent(t *testing.T) {
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".cache", "communication-lab", "go-sandbox")
	}
	root := filepath.Join(base, "selftest-negative", time.Now().Format("150405.000"))
	os.MkdirAll(root, 0o700)
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("HOME", filepath.Join(root, "ambient-home"))
	os.MkdirAll(filepath.Join(root, "ambient-home"), 0o700)

	shim := filepath.Join(root, "fake-non")
	// A rewrite of `nono run … -- <cmd>` that keeps only the command after `--`,
	// i.e. exactly what a backend with no enforcement would do. The loop, not a
	// fixed shift count, because a shift count that drifted would quietly turn
	// this negative control into an exec failure and "pass" for the wrong reason.
	body := "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--\" ]; then shift; break; fi\n  shift\ndone\nexec \"$@\"\n"
	if err := os.WriteFile(shim, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	l := &Launcher{Binary: shim, Home: filepath.Join(root, "launcher-home")}
	_, err := l.SelfTest(context.Background(), root, 20*time.Second)
	if err == nil {
		t.Fatal("SELF-TEST IS VACUOUS: an unsandboxed child passed an enforcement test")
	}
	t.Logf("correctly refused: %v", err)
}
