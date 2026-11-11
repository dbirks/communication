package acp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

// The seam ADR-0082 §8 puts under the launcher: the handle may only know
// Transport, so these tests exercise ProcTransporter on its own, and prove a
// Runtime drives an injected Transporter with the plan it was given.

func TestProcTransporterRoundTripsStdio(t *testing.T) {
	tr, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/bin/cat",
		Env:  []string{},
		Dir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := tr.Stdin().Write([]byte("hello transport\n")); err != nil {
		t.Fatalf("stdin write: %v", err)
	}
	line, err := bufio.NewReader(tr.Stdout()).ReadString('\n')
	if err != nil {
		t.Fatalf("stdout read: %v", err)
	}
	if line != "hello transport\n" {
		t.Fatalf("stdout = %q, want %q", line, "hello transport\n")
	}
	// cat exits 0 on stdin EOF: Wait must report that as nil, not an error.
	if err := tr.Stdin().Close(); err != nil {
		t.Fatalf("stdin close: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- tr.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Wait after clean exit = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after stdin EOF")
	}
}

func TestProcTransporterWaitReturnsExitError(t *testing.T) {
	tr, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/bin/sh",
		Args: []string{"-c", "exit 3"},
		Env:  []string{},
		Dir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	err = tr.Wait()
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("Wait = %v, want *exec.ExitError", err)
	}
	if ee.ExitCode() != 3 {
		t.Fatalf("exit code = %d, want 3", ee.ExitCode())
	}
}

func TestProcTransporterCapturesStderr(t *testing.T) {
	tr, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/bin/sh",
		Args: []string{"-c", "printf 'noise to stderr\\n' >&2; exit 0"},
		Env:  []string{},
		Dir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := tr.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	got, err := io.ReadAll(tr.Stderr())
	if err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	if string(got) != "noise to stderr\n" {
		t.Fatalf("Stderr() = %q, want %q", got, "noise to stderr\n")
	}
	// The same bytes are what the handle quotes on failure.
	if ring := stderrRingOf(tr); ring == nil || ring.String() != "noise to stderr\n" {
		t.Fatalf("stderrRingOf = %v, want the captured tail", ring)
	}
}

func TestProcTransporterSignalKillsAndReaps(t *testing.T) {
	tr, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/bin/sleep",
		Args: []string{"30"},
		Env:  []string{},
		Dir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- tr.Wait() }()
	if err := tr.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("Signal: %v", err)
	}
	select {
	case err := <-reaped:
		var ee *exec.ExitError
		if !errors.As(err, &ee) || ee.ExitCode() != -1 {
			t.Fatalf("Wait after SIGKILL = %v, want a killed *exec.ExitError", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wait did not return within 2s of SIGKILL")
	}
}

func TestProcTransporterRejectsAPlanWithNoEnvironment(t *testing.T) {
	_, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/bin/cat",
		Dir:  t.TempDir(),
	})
	// Byte-identical to the message this check carried before the seam existed
	// (ADR-0019 D1): the worker's callers match on it.
	want := "acp: launch spec for /bin/cat carries no environment: the worker must build it from scratch (acp.LaunchEnv), never inherit os.Environ()"
	if err == nil || err.Error() != want {
		t.Fatalf("Start = %v, want %q", err, want)
	}
}

func TestProcTransporterReportsAFailedStart(t *testing.T) {
	_, err := ProcTransporter{}.Start(context.Background(), LaunchPlan{
		Path: "/nonexistent/communication-acp-transport-test",
		Env:  []string{},
		Dir:  t.TempDir(),
	})
	// Same shape as before the seam: cmd.Start's own verdict, wrapped.
	if !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("Start = %v, want a no-such-file verdict", err)
	}
	if !strings.HasPrefix(err.Error(), "acp: start /nonexistent/communication-acp-transport-test: ") {
		t.Fatalf("Start error lost the runtime's wording: %v", err)
	}
}

// fakeTransport is a Transport with ACP pipes and no process: what a pod
// transport will look like from the handle's side.
type fakeTransport struct {
	stdin  *io.PipeWriter
	stdout *io.PipeReader
	stderr *io.PipeReader

	waitCh    chan struct{}
	exitErr   error
	signalMu  sync.Mutex
	signals   []os.Signal
	sigOnce   sync.Once
	closeOnce sync.Once
}

func newFakeTransport() *fakeTransport {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	f := &fakeTransport{
		stdin:  inW,
		stdout: outR,
		stderr: errR,
		waitCh: make(chan struct{}),
	}
	agent := newFakeAgent()
	conn := acp.NewAgentSideConnection(agent, outW, inR)
	agent.bind(conn, outW)
	// The unit ends when the transport is torn down: hang up every pipe the
	// agent side is reading and writing so its loop exits.
	go func() {
		<-f.waitCh
		_ = errW.Close()
		_ = outW.Close()
		_ = inR.Close()
		<-conn.Done()
	}()
	return f
}

func (f *fakeTransport) Stdin() io.WriteCloser { return f.stdin }
func (f *fakeTransport) Stdout() io.Reader     { return f.stdout }
func (f *fakeTransport) Stderr() io.Reader     { return f.stderr }

func (f *fakeTransport) Wait() error {
	<-f.waitCh
	return f.exitErr
}

func (f *fakeTransport) Signal(sig os.Signal) error {
	f.signalMu.Lock()
	f.signals = append(f.signals, sig)
	f.signalMu.Unlock()
	// Deleting the pod is the pod-shaped SIGTERM: the unit is gone.
	f.sigOnce.Do(func() { close(f.waitCh) })
	return nil
}

func (f *fakeTransport) Close() error {
	f.closeOnce.Do(func() {
		_ = f.stdin.Close()
		f.sigOnce.Do(func() { close(f.waitCh) })
	})
	return nil
}

var _ Transport = (*fakeTransport)(nil)

// fakeTransporter records the plan it was asked to start.
type fakeTransporter struct {
	mu      sync.Mutex
	calls   int
	plan    LaunchPlan
	tr      *fakeTransport
	started chan struct{}
	err     error
}

func (f *fakeTransporter) Start(_ context.Context, plan LaunchPlan) (Transport, error) {
	f.mu.Lock()
	f.calls++
	f.plan = plan
	tr := f.tr
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if tr == nil {
		tr = newFakeTransport()
		f.mu.Lock()
		f.tr = tr
		f.mu.Unlock()
	}
	select {
	case <-f.started:
	default:
		close(f.started)
	}
	return tr, nil
}

func (f *fakeTransporter) recorded() (int, LaunchPlan) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, f.plan
}

var _ Transporter = (*fakeTransporter)(nil)

// TestRuntimeStartsThePlanThroughTheTransporter is the seam proof: a Runtime
// with an injected Transporter never execs anything, and what it hands the
// Transporter is the launch it was asked for.
func TestRuntimeStartsThePlanThroughTheTransporter(t *testing.T) {
	tt := &fakeTransporter{started: make(chan struct{})}
	rt := &Runtime{PermissionPolicy: PermissionDeny, Transporter: tt}
	env := []string{"HOME=" + t.TempDir()}
	dir := t.TempDir()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sess, err := rt.Start(ctx, domain.AgentLaunchSpec{
		LauncherID: "claude",
		Executable: "/usr/lib/communication/pod-transport",
		Args:       []string{"--mode", "ask"},
		WorkDir:    dir,
		Env:        env,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = sess.Close() }()

	calls, plan := tt.recorded()
	if calls != 1 {
		t.Fatalf("Transporter.Start calls = %d, want 1", calls)
	}
	if plan.Path != "/usr/lib/communication/pod-transport" || !reflect.DeepEqual(plan.Args, []string{"--mode", "ask"}) || plan.Dir != dir || !reflect.DeepEqual(plan.Env, env) {
		t.Fatalf("Transporter.Start plan = %+v, want the launch spec's path/args/dir/env", plan)
	}
	// The handshake rode the fake transport's stdio, so the session is real.
	h, ok := sess.(*handle)
	if !ok {
		t.Fatalf("session type %T", sess)
	}
	if h.SessionID() != fakeSessionID {
		t.Fatalf("session = %q, want %q", h.SessionID(), fakeSessionID)
	}
	if _, err := h.Prompt(ctx, "hello"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}

	// Close runs the teardown ladder on the Transport, not on a pid.
	if err := h.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	h.transport.(*fakeTransport).signalMu.Lock()
	defer h.transport.(*fakeTransport).signalMu.Unlock()
	if len(h.transport.(*fakeTransport).signals) == 0 {
		t.Fatal("teardown never asked the transport to signal")
	}
	select {
	case <-h.exited:
	case <-time.After(2 * time.Second):
		t.Fatal("transport was never reaped after Close")
	}
}

// TestRuntimeTransporterFailurePropagates: a transport that will not start is
// the session's failure, unchanged in shape by the seam.
func TestRuntimeTransporterFailurePropagates(t *testing.T) {
	boom := errors.New("acp: pod never scheduled")
	rt := &Runtime{Transporter: &fakeTransporter{err: boom, started: make(chan struct{})}}
	_, err := rt.Start(context.Background(), domain.AgentLaunchSpec{
		Executable: "/bin/cat",
		WorkDir:    t.TempDir(),
		Env:        []string{},
	})
	if !errors.Is(err, boom) {
		t.Fatalf("Start = %v, want %v", err, boom)
	}
}

// TestRuntimeNilTransporterIsTheLocalOne documents the default every existing
// caller relies on.
func TestRuntimeNilTransporterIsTheLocalOne(t *testing.T) {
	rt := &Runtime{}
	if got := rt.transporterOrDefault(); got != (ProcTransporter{}) {
		t.Fatalf("default transporter = %#v, want ProcTransporter{}", got)
	}
}
