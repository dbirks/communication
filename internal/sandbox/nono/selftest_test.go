package nono

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSelfTestPassesOnRealNono(t *testing.T) {
	base := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".cache", "communication-lab", "go-sandbox")
	}
	root := filepath.Join(base, "selftest", time.Now().Format("150405.000"))
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	home := filepath.Join(root, "launcher-home")
	os.MkdirAll(home, 0o700)
	t.Setenv("HOME", filepath.Join(root, "ambient-home"))
	os.MkdirAll(filepath.Join(root, "ambient-home"), 0o700)

	l := &Launcher{Home: home}
	res, err := l.SelfTest(context.Background(), root, 30*time.Second)
	if err != nil {
		t.Fatalf("self-test: %v", err)
	}
	if !res.FilesystemLive || res.GrantsVerified != 1 {
		t.Fatalf("result: %+v", res)
	}
	t.Logf("observed backend=%s version=%s", res.Backend, res.Version)
}

func TestSelfTestRefusesHomeScratch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	l := &Launcher{}
	if _, err := l.SelfTest(context.Background(), filepath.Join(home, "x"), time.Second); err == nil {
		t.Fatal("expected the C-H1 refusal")
	} else {
		t.Logf("refused: %v", err)
	}
}
