package k8s

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"
	corev1client "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/dbirks/communication/internal/agent/acp"
	kexec "k8s.io/client-go/util/exec"
)

// These tests need no cluster: the client is client-go's fake clientset and the
// `pods/exec` streamer is an echo, so what is under test is the launcher's own
// behaviour — the order of its API calls, its refusal rules, and the stdio it
// hands the ACP handle. The real exec is the kind script's job (spike S2).

const verifiedLine = `{"verified":true,"landlock_abi":6,"tcp":true,"detail":"nono 0.80.0"}`

// fakeExecutors records every exec and answers the two the launcher makes.
type fakeExecutors struct {
	mu sync.Mutex

	calls []fakeCall
	// verifyOut / verifyErr are what the in-pod probe prints and returns.
	verifyOut string
	verifyErr error
	// sessionErr is what the session stream reports when it ends; sessionEcho
	// copies stdio while it is open.
	sessionErr  error
	sessionEcho bool
	// sessionStarted is closed once the session exec begins.
	sessionStarted chan struct{}
	once           sync.Once
}

type fakeCall struct {
	namespace string
	pod       string
	command   []string
}

func (f *fakeExecutors) NewExecutor(_ context.Context, namespace, pod string, command []string) (remotecommand.Executor, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{namespace: namespace, pod: pod, command: append([]string(nil), command...)})
	f.mu.Unlock()
	return fakeStream{f: f, pod: pod, command: command}, nil
}

// waitFor records at least n execs, or fails: Start hands the session exec to a
// goroutine, so the call list grows asynchronously and an assertion right after
// Start would be a race rather than a check.
func (f *fakeExecutors) waitFor(t *testing.T, n int) []fakeCall {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if calls := f.recorded(); len(calls) >= n {
			return calls
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("only %d exec(s) were made, want %d", len(f.recorded()), n)
	return nil
}

func (f *fakeExecutors) recorded() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

func (f *fakeExecutors) isVerify(c fakeCall) bool {
	return len(c.command) == len(VerifyCommand) && c.command[0] == VerifyCommand[0] && c.command[1] == VerifyCommand[1]
}

type fakeStream struct {
	f       *fakeExecutors
	pod     string
	command []string
}

func (s fakeStream) Stream(options remotecommand.StreamOptions) error {
	return s.StreamWithContext(context.Background(), options)
}

func (s fakeStream) StreamWithContext(ctx context.Context, options remotecommand.StreamOptions) error {
	if len(s.command) >= 2 && s.command[0] == VerifyCommand[0] && s.command[1] == VerifyCommand[1] {
		if options.Stdout != nil && s.f.verifyOut != "" {
			_, _ = io.WriteString(options.Stdout, s.f.verifyOut)
		}
		return s.f.verifyErr
	}
	s.f.once.Do(func() {
		if s.f.sessionStarted != nil {
			close(s.f.sessionStarted)
		}
	})
	// The echo is the same contract /bin/cat gives ProcTransport's round-trip
	// test: bytes written to stdin come back on stdout until stdin is closed.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if s.f.sessionEcho && options.Stdin != nil && options.Stdout != nil {
			_, _ = io.Copy(options.Stdout, options.Stdin)
		}
	}()
	select {
	case <-done:
		return s.f.sessionErr
	case <-ctx.Done():
		// A real executor returns when its context is cancelled: deleting the pod
		// ends the stream. The fake must not be the one thing that outruns the
		// teardown ladder.
		return ctx.Err()
	}
}

// newFixture builds the transporter over a fake clientset whose pods come up
// Running (the fake client, unlike a cluster, has no kubelet to do that) and
// records the grace periods its deletes asked for.
type newFixture struct {
	client    *fake.Clientset
	executors *fakeExecutors
	graces    []int64
	mu        sync.Mutex
}

var podsResource = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}

func newTransportFixture(t *testing.T) *newFixture {
	t.Helper()
	fx := &newFixture{
		client: fake.NewClientset(),
		executors: &fakeExecutors{
			verifyOut:      verifiedLine,
			sessionEcho:    true,
			sessionStarted: make(chan struct{}),
		},
	}
	fx.client.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		pod, ok := action.(k8stesting.CreateAction).GetObject().(*corev1.Pod)
		if !ok {
			return true, nil, fmt.Errorf("unexpected create object %T", action)
		}
		pod = pod.DeepCopy()
		pod.UID = types.UID("uid-" + pod.Name)
		pod.Status.Phase = corev1.PodRunning
		if err := fx.client.Tracker().Create(podsResource, pod, pod.Namespace); err != nil {
			return true, nil, err
		}
		return true, pod, nil
	})
	fx.client.PrependReactor("delete", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		del, ok := action.(k8stesting.DeleteAction)
		if !ok {
			return false, nil, nil
		}
		if opts := del.GetDeleteOptions(); opts.GracePeriodSeconds != nil {
			fx.mu.Lock()
			fx.graces = append(fx.graces, *opts.GracePeriodSeconds)
			fx.mu.Unlock()
		}
		return false, nil, nil // the default reactor performs the delete
	})
	return fx
}

func (fx *newFixture) deleteGraces() []int64 {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]int64(nil), fx.graces...)
}

func (fx *newFixture) transporter(cfg Config) *PodTransporter {
	cfg = cfg.withDefaults()
	cfg.PollInterval = 5 * time.Millisecond
	return &PodTransporter{
		Client:    fx.client,
		Config:    cfg,
		Executors: fx.executors,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func testConfig() Config {
	return Config{
		Namespace:  "communication-agents",
		Image:      "ghcr.io/dbirks/communication-worker:0.9.0",
		NodeName:   "talos-agent-1",
		Claim:      "communication-workspaces",
		ClaimPaths: []string{"/data/workspaces", "/data/repos", "/sandbox-policy"},
		// nono's HOME and the probe scratch are pod-private.
		LocalPaths:      []string{"/sandbox-home"},
		SandboxHome:     "/sandbox-home",
		SandboxSelfTest: "/sandbox-selftest",
	}
}

func testPlan() acp.LaunchPlan {
	return acp.LaunchPlan{
		Path: "/usr/local/bin/nono",
		Args: []string{"run", "-s", "-p", "/sandbox-policy/attempt.json",
			"--allow", "/data/workspaces/run/abc/home",
			"--read", "/data/repos/abc.git",
			"--read", "/home/worker/.claude",
			"--", "env", "TERM=xterm-256color", "COMMUNICATION_ATTEMPT_ID=9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "HOME=/data/workspaces/run/abc/home", "node", "/opt/adapters/pi-acp"},
		Env: []string{
			"PATH=/usr/local/bin:/usr/bin:/bin",
			"HOME=/sandbox-home",
			"CLAUDE_CODE_OAUTH_TOKEN=sk-ant-super-secret-token",
			"OPENAI_API_KEY=sk-collective-super-secret-key",
		},
		Dir: "/data/workspaces/run/abc/repos",
	}
}

func TestPodTransporterCreatesSecretAndPodAndAdoptsTheSecret(t *testing.T) {
	fx := newTransportFixture(t)
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = tr.Close() })

	ns := "communication-agents"
	secret, err := fx.client.CoreV1().Secrets(ns).Get(context.Background(), "att-9f2c4d6e-1a2b-4c", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("attempt secret: %v", err)
	}
	if string(secret.Data["CLAUDE_CODE_OAUTH_TOKEN"]) != "sk-ant-super-secret-token" {
		t.Error("the credential did not reach the Secret intact")
	}
	// The WHOLE launch environment is in the Secret, not only the credential-shaped
	// part of it: the exec request that starts the session carries names, so a
	// plain entry has nowhere else to arrive from.
	if len(secret.Data) != len(testPlan().Env) {
		t.Errorf("secret data keys = %v, want all %d entries of the plan's environment", keysOf(secret.Data), len(testPlan().Env))
	}
	for _, kv := range testPlan().Env {
		name, value, _ := strings.Cut(kv, "=")
		if string(secret.Data[name]) != value {
			t.Errorf("secret key %q = %q, want the plan's value", name, string(secret.Data[name]))
		}
	}
	// The owner reference is a patch after the pod create, and it is what makes
	// Kubernetes GC the credential when the pod goes (spike S4).
	if len(secret.OwnerReferences) != 1 {
		t.Fatalf("ownerReferences = %v, want the attempt pod", secret.OwnerReferences)
	}
	ref := secret.OwnerReferences[0]
	if ref.Kind != "Pod" || ref.Name != "att-9f2c4d6e-1a2b-4c" || ref.UID != types.UID("uid-att-9f2c4d6e-1a2b-4c") {
		t.Errorf("owner reference = %+v", ref)
	}

	pod, err := fx.client.CoreV1().Pods(ns).Get(context.Background(), "att-9f2c4d6e-1a2b-4c", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("attempt pod: %v", err)
	}
	if pod.Spec.NodeName != "talos-agent-1" {
		t.Errorf("pod nodeName = %q", pod.Spec.NodeName)
	}
	if pod.Labels[LabelAttempt] != "9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" {
		t.Errorf("pod attempt label = %q", pod.Labels[LabelAttempt])
	}

	// The grant path the claim does not cover (/home/worker/.claude) got its own
	// volume: nono silently ignores a grant to a path that does not resolve
	// (probe C-FC3), so refusing to mount it would launch a narrower sandbox
	// than the one that was verified.
	mounted := map[string]bool{}
	for _, m := range pod.Spec.Containers[0].VolumeMounts {
		mounted[m.MountPath] = true
	}
	for _, want := range []string{"/home/worker/.claude", "/sandbox-selftest", "/data/workspaces", AttemptDir} {
		if !mounted[want] {
			t.Errorf("attempt pod does not mount %s", want)
		}
	}
	if mounted["/data/repos/../workspaces"] {
		t.Error("paths must be cleaned before they become mounts")
	}

	// The execs, in order: the probe first, then the session.
	calls := fx.executors.waitFor(t, 2)
	if !fx.executors.isVerify(calls[0]) {
		t.Errorf("first exec is not the sandbox probe: %v", calls[0].command)
	}
	if fx.executors.isVerify(calls[1]) {
		t.Errorf("second exec is another probe: %v", calls[1].command)
	}
}

func TestPodTransporterRefusesAPodThatDidNotVerify(t *testing.T) {
	for _, tc := range []struct {
		name       string
		verifyOut  string
		verifyErr  error
		wantReason string
	}{
		{name: "verified false", verifyOut: `{"verified":false,"landlock_abi":0,"tcp":false,"detail":"no landlock"}`, wantReason: "not_verified"},
		{name: "abi too low", verifyOut: `{"verified":true,"landlock_abi":3,"tcp":true,"detail":"v3"}`, wantReason: "landlock_abi_below_v4"},
		{name: "tcp withheld", verifyOut: `{"verified":true,"landlock_abi":6,"tcp":false,"detail":"EPERM"}`, wantReason: "tcp_unreachable"},
		{name: "no verdict at all", verifyOut: "", wantReason: "no_verdict"},
		{name: "probe exec fails", verifyErr: errors.New("connection reset"), wantReason: "exec_failed"},
	} {
		fx := newTransportFixture(t)
		fx.executors.verifyOut = tc.verifyOut
		fx.executors.verifyErr = tc.verifyErr
		_, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
		if err == nil {
			t.Fatalf("%s: Start succeeded; ADR-0082 Decision 3 allows no session in an unverified pod", tc.name)
		}
		var d *acp.Denial
		if !errors.As(err, &d) {
			t.Fatalf("%s: error %v is not an *acp.Denial the worker can journal as sandbox.enforcement_failed", tc.name, err)
		}
		if d.Reason != tc.wantReason {
			t.Errorf("%s: reason = %q, want %q", tc.name, d.Reason, tc.wantReason)
		}
		if d.ChildStarted {
			t.Errorf("%s: no agent process was started", tc.name)
		}
		// The refusal must not leave the pod or its credential behind.
		if _, perr := fx.client.CoreV1().Pods("communication-agents").Get(context.Background(), "att-9f2c4d6e-1a2b-4c", metav1.GetOptions{}); !apierrors.IsNotFound(perr) {
			t.Errorf("%s: attempt pod still exists (%v)", tc.name, perr)
		}
		if _, serr := fx.client.CoreV1().Secrets("communication-agents").Get(context.Background(), "att-9f2c4d6e-1a2b-4c", metav1.GetOptions{}); !apierrors.IsNotFound(serr) {
			t.Errorf("%s: attempt secret still exists (%v)", tc.name, serr)
		}
		// And must not have exec'd the plan.
		for _, c := range fx.executors.recorded() {
			if !fx.executors.isVerify(c) {
				t.Errorf("%s: the plan was exec'd in an unverified pod: %v", tc.name, c.command)
			}
		}
	}
}

func TestPodTransporterRoundTripsStdio(t *testing.T) {
	fx := newTransportFixture(t)
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := tr.Stdin().Write([]byte("hello pod transport\n")); err != nil {
		t.Fatalf("stdin write: %v", err)
	}
	line, err := bufio.NewReader(tr.Stdout()).ReadString('\n')
	if err != nil {
		t.Fatalf("stdout read: %v", err)
	}
	if line != "hello pod transport\n" {
		t.Errorf("stdout = %q, want the echoed line", line)
	}
	if err := tr.Stdin().Close(); err != nil {
		t.Fatalf("stdin close: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- tr.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Wait after a clean exit = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after stdin EOF")
	}
	// The pod outlives the exec that rode it, so Wait must retire it — otherwise
	// every finished attempt leaves a running container holding the workspace.
	waitForPodGone(t, fx.client, "att-9f2c4d6e-1a2b-4c")
}

func TestPodTransporterWaitReportsExitCode(t *testing.T) {
	fx := newTransportFixture(t)
	fx.executors.sessionEcho = false
	fx.executors.sessionErr = kexec.CodeExitError{Err: errors.New("command terminated with exit code 137"), Code: 137}
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	err = tr.Wait()
	if err == nil {
		t.Fatal("Wait reported success for an exec that exited 137")
	}
	var exit *ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("Wait error %v is not an *ExitError", err)
	}
	if exit.Code != 137 {
		t.Errorf("exit code = %d, want 137", exit.Code)
	}
	if !strings.Contains(err.Error(), "att-9f2c4d6e-1a2b-4c") {
		t.Errorf("exit error does not name the pod: %v", err)
	}
}

func TestPodTransporterSignalDeletesThePod(t *testing.T) {
	fx := newTransportFixture(t)
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := tr.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM: %v", err)
	}
	if graces := fx.deleteGraces(); len(graces) != 1 || graces[0] != 5 {
		t.Errorf("SIGTERM deleted with graces %v, want [5]", graces)
	}
	waitForPodGone(t, fx.client, "att-9f2c4d6e-1a2b-4c")

	// The next rung must still be served: the ladder asks for SIGKILL when the
	// first deletion did not land in time.
	if err := tr.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("SIGKILL: %v", err)
	}
	if graces := fx.deleteGraces(); len(graces) != 2 || graces[1] != 0 {
		t.Errorf("SIGKILL deleted with graces %v, want [5 0]", graces)
	}
	// An arbitrary signal has no pod-shaped meaning, and saying so beats pretending.
	if err := tr.Signal(syscall.SIGUSR1); err == nil {
		t.Error("SIGUSR1 reported success; a pod transport cannot deliver it")
	}
	// The Secret goes with the pod by GC, so the transport never deletes it
	// directly on the happy path — but the owner reference is in place.
	secret, serr := fx.client.CoreV1().Secrets("communication-agents").Get(context.Background(), "att-9f2c4d6e-1a2b-4c", metav1.GetOptions{})
	if serr == nil && len(secret.OwnerReferences) == 0 {
		t.Error("GC cannot collect a Secret with no owner reference")
	}
}

func TestPodTransporterWaitAfterSignalDoesNotHang(t *testing.T) {
	// The handle's ladder is: SIGTERM, wait, SIGKILL, bounded reap. A transport
	// whose Wait only returned when the stream ended naturally would park the
	// worker's turn loop behind a pod that is already deleted (the exact wedge
	// that stopped the lab's worker in run 41789603709).
	fx := newTransportFixture(t)
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- tr.Wait() }()
	if err := tr.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("SIGKILL: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after the pod was deleted")
	}
}

func TestPodTransporterCloseIsIdempotentAndRetiresThePod(t *testing.T) {
	fx := newTransportFixture(t)
	tr, err := fx.transporter(testConfig()).Start(context.Background(), testPlan())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := tr.Close(); err != nil {
			t.Fatalf("Close #%d: %v", i+1, err)
		}
	}
	if graces := fx.deleteGraces(); len(graces) != 1 {
		t.Errorf("Close deleted %d times, want one deletion", len(graces))
	}
	waitForPodGone(t, fx.client, "att-9f2c4d6e-1a2b-4c")
}

func TestPodTransporterWaitsForRunningAndSurfacesEvents(t *testing.T) {
	fx := newTransportFixture(t)
	// A pod that never starts: the fake client keeps it Pending, as a cluster with
	// an unsatisfiable claim would.
	fx.client.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		pod := action.(k8stesting.CreateAction).GetObject().(*corev1.Pod).DeepCopy()
		pod.UID = types.UID("uid-" + pod.Name)
		pod.Status.Phase = corev1.PodPending
		if err := fx.client.Tracker().Create(podsResource, pod, pod.Namespace); err != nil {
			return true, nil, err
		}
		return true, pod, nil
	})
	if err := fx.client.Tracker().Add(&corev1.Event{
		ObjectMeta: metav1.ObjectMeta{Name: "att-ev", Namespace: "communication-agents"},
		InvolvedObject: corev1.ObjectReference{
			Kind: "Pod", Name: "att-9f2c4d6e-1a2b-4c", Namespace: "communication-agents",
		},
		Reason:  "FailedMount",
		Type:    "Warning",
		Message: `unable to attach data of volume communication-workspaces`,
	}); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	cfg := testConfig()
	cfg.ReadyTimeout = 60 * time.Millisecond
	cfg.PollInterval = 5 * time.Millisecond
	_, err := fx.transporter(cfg).Start(context.Background(), testPlan())
	if err == nil {
		t.Fatal("Start succeeded on a pod that never ran")
	}
	var d *acp.Denial
	if !errors.As(err, &d) {
		t.Fatalf("error %v is not an *acp.Denial", err)
	}
	if d.Reason != "timeout" {
		t.Errorf("reason = %q, want timeout", d.Reason)
	}
	if !strings.Contains(d.Message, "FailedMount") {
		t.Errorf("the refusal does not surface the pod's events, so an operator has nothing to read: %s", d.Message)
	}
	waitForPodGone(t, fx.client, "att-9f2c4d6e-1a2b-4c")
}

func TestPodTransporterRefusesAMissingPlan(t *testing.T) {
	fx := newTransportFixture(t)
	tr := fx.transporter(testConfig())

	// No environment is the ADR-0019 D1 leak, refused the same way the local
	// transport refuses it.
	if _, err := tr.Start(context.Background(), acp.LaunchPlan{Path: "nono", Dir: "/x"}); err == nil {
		t.Error("a plan with no environment must be refused")
	} else if !strings.Contains(err.Error(), "never inherit os.Environ()") {
		t.Errorf("environment refusal reads %q", err)
	}

	// A plan with no attempt identity cannot be named, and an anonymous pod is an
	// unauditable one.
	orphan := testPlan()
	var kept []string
	for _, a := range orphan.Args {
		if strings.HasPrefix(a, EnvAttemptID+"=") {
			continue
		}
		kept = append(kept, a)
	}
	orphan.Args = kept
	orphan.Dir = "/data/workspaces/run/abc/repos"
	if _, err := tr.Start(context.Background(), orphan); err == nil {
		t.Error("a plan with no attempt id must be refused rather than named at random")
	}

	// A config that cannot place a pod fails before any API call.
	broken := testConfig()
	broken.NodeName = ""
	if _, err := fx.transporter(broken).Start(context.Background(), testPlan()); err == nil {
		t.Error("a launcher with no node name must refuse to start a pod")
	} else if !strings.Contains(err.Error(), "COMMUNICATION_AGENT_POD_NODE") {
		t.Errorf("error %q does not name the missing variable", err)
	}
	if len(fx.executors.recorded()) != 0 {
		t.Error("the refused configs still reached the API")
	}
}

func TestSessionCommandCarriesNamesAndPathsOnly(t *testing.T) {
	cmd, err := SessionCommand(testPlan())
	if err != nil {
		t.Fatalf("SessionCommand: %v", err)
	}
	// The shape ADR-0082 Decision 6 names: the in-pod wrapper, the directory its
	// environment was delivered to, the working directory, and then the plan's own
	// argv after a `--` that ends the wrapper's flag parsing.
	want := []string{
		"communication", "pod-exec",
		"--env-dir", EnvDir,
		"--cwd", "/data/workspaces/run/abc/repos",
		"--", "/usr/local/bin/nono",
	}
	if got := cmd[:len(want)]; strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("argv head = %q, want %q", got, want)
	}
	// Everything after it is the plan's argv, verbatim: the grant paths and the
	// `env` hop the worker journalled are what the pod runs.
	if got := strings.Join(cmd[len(want):], " "); got != strings.Join(testPlan().Args, " ") {
		t.Errorf("argv tail = %q, want the plan's args", got)
	}
	// No value from the environment is anywhere in it — not the credentials, and
	// not the plain entries the `sh -c` script used to put on the command line.
	joined := strings.Join(cmd, "\n")
	for _, kv := range testPlan().Env {
		_, value, _ := strings.Cut(kv, "=")
		if value != "" && strings.Contains(joined, value) {
			t.Errorf("the exec request carries an environment value (%q):\n%s", value, joined)
		}
	}
}

// TestExecRequestURLCarriesNoLaunchValue is the same rule asserted on the request
// the launcher actually sends: `pods/exec` puts its argv in the URL's query, and
// apiserver audit records the URL, so the URL is the leak surface (ADR-0082
// Decision 6). The plan below carries a secret named SECRET, value s3cr3t.
func TestExecRequestURLCarriesNoLaunchValue(t *testing.T) {
	fx := newTransportFixture(t)
	plan := testPlan()
	plan.Env = append(plan.Env, "SECRET=s3cr3t")

	files, err := EnvFiles(plan.Env)
	if err != nil {
		t.Fatalf("EnvFiles: %v", err)
	}
	cmd, err := SessionCommand(plan)
	if err != nil {
		t.Fatalf("SessionCommand: %v", err)
	}

	rc, err := rest.RESTClientFor(&rest.Config{
		Host:                 "http://127.0.0.1:8080",
		GroupVersion:         &corev1.SchemeGroupVersion,
		NegotiatedSerializer: scheme.Codecs.WithoutConversion(),
	})
	if err != nil {
		t.Fatalf("rest client for the exec url: %v", err)
	}
	factory := &RESTExecutors{Client: clientsetWithRESTClient{Interface: fx.client, rc: rc}, RESTConfig: &rest.Config{Host: "http://127.0.0.1:8080"}}
	rawURL, err := factory.ExecRequestURL("communication-agents", "att-9f2c4d6e-1a2b-4c", cmd)
	if err != nil {
		t.Fatalf("ExecRequestURL: %v", err)
	}
	decoded := rawURL
	if unescaped, err := url.QueryUnescape(rawURL); err == nil {
		decoded = unescaped
	}
	for _, needle := range []string{"s3cr3t", "sk-ant-super-secret-token", "sk-collective-super-secret-key"} {
		if strings.Contains(decoded, needle) {
			t.Errorf("the exec request carries the value %q:\n%s", needle, decoded)
		}
	}
	// What it does carry: the wrapper, the delivery directory, and the plan's own
	// program. Anything else in the query is kubelet plumbing.
	for _, needle := range []string{"pod-exec", "--env-dir", "--cwd", EnvDir, "command="} {
		if !strings.Contains(decoded, needle) {
			t.Errorf("the exec request lost %q:\n%s", needle, decoded)
		}
	}
	// And the Secret holds what the request does not, under the name, at the
	// `env/<NAME>` path the pod projects.
	secret, err := BuildSecret("9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "communication-agents", files)
	if err != nil {
		t.Fatalf("BuildSecret: %v", err)
	}
	if string(secret.Data["SECRET"]) != "s3cr3t" {
		t.Errorf("secret data = %v, want the plan's SECRET value", keysOf(secret.Data))
	}
	pod, err := PodInput{
		AttemptID: "9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", Namespace: "communication-agents",
		Image: "img", NodeName: "n", Claim: "c", ClaimPaths: []string{"/data/workspaces"},
		SandboxHome: "/sandbox-home", SandboxSelfTest: "/sandbox-selftest",
		LocalPaths: []string{"/sandbox-home", "/sandbox-selftest"},
		EnvNames:   EnvFileNames(files),
	}.Pod()
	if err != nil {
		t.Fatalf("Pod: %v", err)
	}
	projected := map[string]string{}
	for _, v := range pod.Spec.Volumes {
		if v.Secret == nil {
			continue
		}
		for _, it := range v.Secret.Items {
			projected[it.Key] = it.Path
		}
	}
	if projected["SECRET"] != EnvFileDir+"/SECRET" {
		t.Errorf("secret key SECRET projects to %q, want the file env/SECRET", projected["SECRET"])
	}
	if got := EnvFilePath("SECRET"); got != "/run/attempt/env/SECRET" {
		t.Errorf("the wrapper reads %q, want /run/attempt/env/SECRET", got)
	}
	// The pod spec itself stays clean too: it references the Secret by name.
	if strings.Contains(fmt.Sprint(pod.Spec), "s3cr3t") {
		t.Error("the pod spec carries a launch value")
	}
}

// clientsetWithRESTClient gives the fake clientset a REST client real enough to
// build a request URL with — the fake's own CoreV1().RESTClient() is nil, and the
// URL is exactly the thing under test.
type clientsetWithRESTClient struct {
	kubernetes.Interface
	rc rest.Interface
}

func (c clientsetWithRESTClient) CoreV1() corev1client.CoreV1Interface {
	return coreV1WithRESTClient{CoreV1Interface: c.Interface.CoreV1(), rc: c.rc}
}

type coreV1WithRESTClient struct {
	corev1client.CoreV1Interface
	rc rest.Interface
}

func (c coreV1WithRESTClient) RESTClient() rest.Interface { return c.rc }

func TestSessionCommandRefusesAnUnusablePlan(t *testing.T) {
	for _, tc := range []struct {
		name string
		plan acp.LaunchPlan
		want string
	}{
		{"no path", acp.LaunchPlan{Dir: "/x"}, "names no executable"},
		{"flag-shaped path", acp.LaunchPlan{Path: "-lc", Dir: "/x"}, "looks like a flag"},
		{"no cwd", acp.LaunchPlan{Path: "nono"}, "no working directory"},
		{"cwd the exec request cannot carry", acp.LaunchPlan{Path: "nono", Dir: "/work; rm -rf /"}, "cannot be carried"},
		{"cwd with a space", acp.LaunchPlan{Path: "nono", Dir: "/work dirs/abc"}, "cannot be carried"},
	} {
		if _, err := SessionCommand(tc.plan); err == nil {
			t.Errorf("%s: SessionCommand accepted the plan", tc.name)
		} else if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not mention %q", tc.name, err, tc.want)
		}
	}
}

func waitForPodGone(t *testing.T, client *fake.Clientset, name string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, err := client.CoreV1().Pods("communication-agents").Get(context.Background(), name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("attempt pod %s still exists after the transport retired it", name)
}

func commandsOf(calls []fakeCall) []string {
	out := make([]string, 0, len(calls))
	for _, c := range calls {
		out = append(out, strings.Join(c.command, " "))
	}
	return out
}
