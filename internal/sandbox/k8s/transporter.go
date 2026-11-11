package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	kexec "k8s.io/client-go/util/exec"

	"github.com/dbirks/communication/internal/agent/acp"
)

// EnvAttemptID is the environment entry the turn loop puts on every agent launch
// (internal/worker/egressaudit.go's egress marker). It is how a Transporter that
// is handed only a launch plan learns which attempt the plan belongs to — the
// same value nono's own audit journal uses to find its session.
const EnvAttemptID = "COMMUNICATION_ATTEMPT_ID"

// Defaults for the two waits Start performs.
const (
	defaultReadyTimeout  = 300 * time.Second
	defaultPollInterval  = 2 * time.Second
	defaultVerifyTimeout = 90 * time.Second
	maxStderrBytes       = 64 * 1024
)

// Config is the launcher's fixed deployment shape: the ADR-0082 §8 selection
// variables plus the paths this worker keeps its workspaces on. It is data, so
// cmd/communication can build it from the environment and the tests can build it
// by hand.
type Config struct {
	// Namespace is COMMUNICATION_AGENT_NAMESPACE.
	Namespace string
	// Image is COMMUNICATION_AGENT_POD_IMAGE — the worker image, the only one
	// carrying nono, Node and the pinned adapters.
	Image string
	// NodeName is COMMUNICATION_AGENT_POD_NODE. It is required: the workspace
	// claim is ReadWriteOnce, so an attempt scheduled anywhere else would sit
	// Pending until its timeout instead of failing honestly here.
	NodeName string
	// Claim is COMMUNICATION_AGENT_WORKSPACE_PVC.
	Claim string
	// ClaimPaths are this worker's roots that live on Claim (workspace root,
	// repos root, policy dir). They are mounted at the same absolute paths.
	ClaimPaths []string
	// LocalPaths are this worker's roots that must NOT be shared with the pod —
	// nono's HOME and the self-test scratch get a private emptyDir at the same
	// path, so probe C-H1's sticky state-root refusal stays inside one attempt.
	LocalPaths []string
	// SandboxHome and SandboxSelfTest are COMMUNICATION_SANDBOX_HOME and
	// COMMUNICATION_SANDBOX_SELFTEST_DIR as this worker sees them. They are both
	// LocalPaths and the two variables the attempt pod is told, because the
	// in-pod probe runs with the container's environment, not the worker's.
	SandboxHome     string
	SandboxSelfTest string

	// ReadyTimeout bounds the wait for the pod to reach Running (ADR-0082: 300s).
	ReadyTimeout time.Duration
	// PollInterval is the pod-status poll. Tests shorten it.
	PollInterval time.Duration
	// VerifyTimeout bounds the in-pod sandbox probe.
	VerifyTimeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.ReadyTimeout <= 0 {
		c.ReadyTimeout = defaultReadyTimeout
	}
	if c.PollInterval <= 0 {
		c.PollInterval = defaultPollInterval
	}
	if c.VerifyTimeout <= 0 {
		c.VerifyTimeout = defaultVerifyTimeout
	}
	return c
}

// mountPaths is the pod-private directory set: the configured local roots plus
// the two sandbox directories, deduplicated and sorted so the built pod spec is
// deterministic and its golden test is stable.
func (c Config) mountPaths() []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range append(append([]string(nil), c.LocalPaths...), c.SandboxHome, c.SandboxSelfTest) {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// Validate is the startup check cmd/communication runs before it registers: a
// worker configured for Kubernetes mode that cannot name a namespace, an image or
// a node must refuse to start, not create pods that hang unscheduled.
func (c Config) Validate() error {
	var missing []string
	if c.Namespace == "" {
		missing = append(missing, "COMMUNICATION_AGENT_NAMESPACE")
	}
	if c.Image == "" {
		missing = append(missing, "COMMUNICATION_AGENT_POD_IMAGE")
	}
	if c.NodeName == "" {
		missing = append(missing, "COMMUNICATION_AGENT_POD_NODE")
	}
	if len(missing) > 0 {
		return fmt.Errorf("sandbox/k8s: the kubernetes launcher is missing %s; it cannot place an attempt pod, and the worker refuses to start rather than create pods that hang unscheduled", strings.Join(missing, " and "))
	}
	if c.Claim == "" && len(c.ClaimPaths) > 0 {
		// ADR-0082 Decision 4 is a shared-claim design: the attempt pod must
		// resolve the plan's absolute paths the way the worker does. Without the
		// claim it starts with empty directories where the worktree, the mirrors
		// and the policy file belong, and nono silently drops a grant that
		// resolves to nothing (probe C-FC3) — a narrower sandbox reported as the
		// verified one.
		return fmt.Errorf("sandbox/k8s: COMMUNICATION_AGENT_WORKSPACE_PVC is required: the attempt pod mounts %v from that claim at the same paths the verified plan names", c.ClaimPaths)
	}
	return nil
}

// ExecutorFactory builds the `pods/exec` streamer for one command in one pod.
// This is the seam that makes the transporter testable without a cluster: the
// tests inject an echo executor, the worker injects the REST one.
type ExecutorFactory interface {
	NewExecutor(ctx context.Context, namespace, pod string, command []string) (remotecommand.Executor, error)
}

// RESTExecutors is the production ExecutorFactory: WebSocket exec with the SPDY
// fallback client-go still carries for older API servers.
type RESTExecutors struct {
	Client kubernetes.Interface
	// RESTConfig is the in-cluster config (token, CA, API host).
	RESTConfig *rest.Config
}

var _ ExecutorFactory = (*RESTExecutors)(nil)

// NewExecutor builds `POST /api/v1/namespaces/<ns>/pods/<pod>/exec?...` for the
// agent container. The options are supplied per StreamWithContext call, so no
// two execs ever share a stream. Stdin is requested on every exec including the
// probe: `communication pod-verify` never reads it, and an exec that opens a
// stream it does not copy is how client-go itself models "no input".
func (f *RESTExecutors) NewExecutor(_ context.Context, namespace, pod string, command []string) (remotecommand.Executor, error) {
	if f.Client == nil || f.RESTConfig == nil {
		return nil, errors.New("sandbox/k8s: no clientset or rest config to exec through")
	}
	req := f.Client.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: ContainerName,
			Command:   command,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       false,
		}, scheme.ParameterCodec)
	ws, err := remotecommand.NewWebSocketExecutor(f.RESTConfig, "POST", req.URL().String())
	if err != nil {
		return nil, fmt.Errorf("sandbox/k8s: websocket executor for exec on %s: %w", pod, err)
	}
	spdy, err := remotecommand.NewSPDYExecutor(f.RESTConfig, "POST", req.URL())
	if err != nil {
		return nil, fmt.Errorf("sandbox/k8s: spdy executor for exec on %s: %w", pod, err)
	}
	fb, err := remotecommand.NewFallbackExecutor(ws, spdy, fallbackToSPDY)
	if err != nil {
		return nil, fmt.Errorf("sandbox/k8s: fallback executor for exec on %s: %w", pod, err)
	}
	return fb, nil
}

// fallbackToSPDY decides when a failed WebSocket exec may be retried over the
// legacy SPDY protocol. An auth refusal is not a protocol mismatch — SPDY would
// refuse for the same reason and the honest error would be lost — and a non-zero
// exit means the exec already reached the pod.
func fallbackToSPDY(err error) bool {
	if err == nil {
		return false
	}
	if apierrors.IsUnauthorized(err) || apierrors.IsForbidden(err) {
		return false
	}
	var exited kexec.CodeExitError
	if errors.As(err, &exited) {
		return false
	}
	return true
}

// PodTransporter is acp.Transporter over one pod per attempt (ADR-0082
// Decision 2).
//
// Start performs the whole ordered sequence the ADR requires — Secret, Pod,
// ownerReference patch, wait for Running, in-pod verification, then the exec of
// the journalled argv — and refuses at the first step that does not hold. There
// is no path through it that runs a plan in a pod whose verification the worker
// did not read (Decision 3, ADR-0019 D6).
type PodTransporter struct {
	// Client is the worker's in-cluster clientset. Its ServiceAccount holds
	// pods create/get/list/watch/delete, pods/exec create, pods/log get, secrets
	// create/get/delete and events list in Config.Namespace, and nothing else
	// (ADR-0082 Decision 6).
	Client kubernetes.Interface
	Config Config
	// Executors builds the pods/exec streamer.
	Executors ExecutorFactory
	// AttemptID names the attempt a plan belongs to. Nil means
	// AttemptIDFromPlan.
	AttemptID func(acp.LaunchPlan) (string, error)
	// Logger receives launch diagnostics. Values never appear in them: only
	// object names, credential NAMES and exit verdicts.
	Logger *slog.Logger
}

var _ acp.Transporter = (*PodTransporter)(nil)

func (t *PodTransporter) log() *slog.Logger {
	if t == nil || t.Logger == nil {
		return slog.Default()
	}
	return t.Logger
}

// Start creates the attempt pod, verifies the sandbox inside it, and execs the
// plan. The returned Transport owns the pod until Close/Signal retires it.
func (t *PodTransporter) Start(ctx context.Context, plan acp.LaunchPlan) (acp.Transport, error) {
	if t == nil {
		return nil, errors.New("sandbox/k8s: nil transporter")
	}
	if plan.Env == nil {
		// The same refusal ProcTransporter makes: an inherited environment would
		// hand the agent the worker's `COMMUNICATION_DATABASE_URL` (ADR-0019 D1).
		return nil, fmt.Errorf("sandbox/k8s: launch spec for %s carries no environment: the worker must build it from scratch (acp.LaunchEnv), never inherit os.Environ()", plan.Path)
	}
	cfg := t.Config.withDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if t.Client == nil {
		return nil, errors.New("sandbox/k8s: the transporter needs a clientset")
	}
	if t.Executors == nil {
		return nil, errors.New("sandbox/k8s: the transporter needs an executor factory")
	}
	nameOf := t.AttemptID
	if nameOf == nil {
		nameOf = AttemptIDFromPlan
	}
	attemptID, err := nameOf(plan)
	if err != nil {
		return nil, err
	}

	plain, creds, err := SplitEnv(plan.Env)
	if err != nil {
		return nil, err
	}
	input := PodInput{
		AttemptID:       attemptID,
		Namespace:       cfg.Namespace,
		Image:           cfg.Image,
		NodeName:        cfg.NodeName,
		Claim:           cfg.Claim,
		ClaimPaths:      cfg.ClaimPaths,
		LocalPaths:      append(cfg.mountPaths(), uncoveredGrantPaths(plan, cfg)...),
		SandboxHome:     cfg.SandboxHome,
		SandboxSelfTest: cfg.SandboxSelfTest,
		CredentialKeys:  credentialNames(creds),
	}

	names := credentialNames(creds)
	log := t.log()
	log.Info("attempt pod launch",
		slog.String("attempt_id", attemptID),
		slog.String("namespace", cfg.Namespace),
		slog.String("node", cfg.NodeName),
		slog.Int("grant_paths", len(input.ClaimPaths)+len(input.LocalPaths)),
		slog.Any("credential_names", names),
	)

	secret, err := BuildSecret(attemptID, cfg.Namespace, creds)
	if err != nil {
		return nil, err
	}
	pod, err := input.Pod()
	if err != nil {
		return nil, err
	}

	// The Secret first: a pod that came up without its credential volume would
	// start an agent that fails mid-turn, and an orphan Secret with no pod is
	// deleted by the cleanup below.
	if _, err := t.Client.CoreV1().Secrets(cfg.Namespace).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		return nil, fmt.Errorf("sandbox/k8s: create attempt secret %s: %w", secret.Name, withoutValues(err, creds))
	}
	createdPod, err := t.Client.CoreV1().Pods(cfg.Namespace).Create(ctx, pod, metav1.CreateOptions{})
	if err != nil {
		t.deleteSecret(ctx, cfg.Namespace, secret.Name)
		return nil, fmt.Errorf("sandbox/k8s: create attempt pod %s: %w", pod.Name, withoutValues(err, creds))
	}
	// ownerReferences need the pod's uid, so they are a patch after both creates
	// (ADR-0082 Decision 5). A failure here is fatal: a Secret that outlives its
	// pod is an orphaned credential blob, which is exactly what the reference
	// exists to prevent.
	patch, err := OwnerPatch(createdPod)
	if err != nil {
		t.retire(ctx, cfg.Namespace, createdPod.Name, secret.Name, 0)
		return nil, err
	}
	if _, err := t.Client.CoreV1().Secrets(cfg.Namespace).Patch(ctx, secret.Name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		t.retire(ctx, cfg.Namespace, createdPod.Name, secret.Name, 0)
		return nil, fmt.Errorf("sandbox/k8s: adopt attempt secret %s into pod %s: %w", secret.Name, createdPod.Name, withoutValues(err, creds))
	}

	// Everything below the pod's existence must retire the pod on the way out.
	fail := func(err error) error {
		t.retire(ctx, cfg.Namespace, createdPod.Name, secret.Name, 0)
		return err
	}

	running, err := t.waitRunning(ctx, cfg, createdPod.Name)
	if err != nil {
		return nil, fail(err)
	}

	if err := t.verifyPod(ctx, cfg, running.Name); err != nil {
		return nil, fail(err)
	}

	command, err := SessionCommand(plan, plain, creds)
	if err != nil {
		return nil, fail(err)
	}

	stdinRead, stdinWrite := io.Pipe()
	stdoutRead, stdoutWrite := io.Pipe()
	capture := newCapture(maxStderrBytes)

	execCtx, cancel := context.WithCancel(ctx)
	tr := &podTransport{
		t:         t,
		namespace: cfg.Namespace,
		pod:       running.Name,
		attemptID: attemptID,
		stdin:     stdinWrite,
		stdout:    stdoutRead,
		stdoutW:   stdoutWrite,
		stderr:    capture,
		done:      make(chan struct{}),
		ctx:       execCtx,
		cancel:    cancel,
	}

	go func() {
		defer close(tr.done)
		err := t.streamToPod(execCtx, cfg.Namespace, running.Name, command, remotecommand.StreamOptions{
			Stdin:  stdinRead,
			Stdout: stdoutWrite,
			Stderr: capture,
			Tty:    false,
		})
		// Hang both ends up whatever the executor said: the client must see EOF
		// on stdout and a write error (not a block) on stdin.
		_ = stdoutWrite.Close()
		_ = stdinRead.Close()
		tr.setExit(mapExit(running.Name, err))
	}()

	log.Info("attempt pod session started",
		slog.String("attempt_id", attemptID),
		slog.String("pod", running.Name),
	)
	return tr, nil
}

// verifyPod execs the in-pod sandbox probe and refuses the launch unless it
// returns the verified verdict (ADR-0082 Decision 3).
func (t *PodTransporter) verifyPod(ctx context.Context, cfg Config, pod string) error {
	ctx, cancel := context.WithTimeout(ctx, cfg.VerifyTimeout)
	defer cancel()
	var out bytes.Buffer
	err := t.streamToPod(ctx, cfg.Namespace, pod, VerifyCommand, remotecommand.StreamOptions{
		Stdout: &out,
		Stderr: newCapture(maxStderrBytes),
		Tty:    false,
	})
	if err != nil {
		return denial("pod_verify", "exec_failed", fmt.Sprintf("the attempt pod's sandbox probe could not run: %s", bounded(err.Error(), 512)))
	}
	verdict, perr := ParseVerdict(out.Bytes())
	if perr != nil {
		return denial("pod_verify", "no_verdict", bounded(perr.Error(), 512))
	}
	if cerr := verdict.Check(); cerr != nil {
		t.log().Error("attempt pod refused the launch",
			slog.String("pod", pod),
			slog.Bool("verified", verdict.Verified),
			slog.Int("landlock_abi", verdict.LandlockABI),
			slog.Bool("tcp", verdict.TCP),
			slog.String("detail", bounded(verdict.Detail, 512)),
		)
		return cerr
	}
	t.log().Info("attempt pod enforcement observed",
		slog.String("pod", pod),
		slog.Int("landlock_abi", verdict.LandlockABI),
		slog.Bool("tcp", verdict.TCP),
	)
	return nil
}

// streamToPod runs one exec to completion.
func (t *PodTransporter) streamToPod(ctx context.Context, namespace, pod string, command []string, opts remotecommand.StreamOptions) error {
	executor, err := t.Executors.NewExecutor(ctx, namespace, pod, command)
	if err != nil {
		return err
	}
	return executor.StreamWithContext(ctx, opts)
}

// waitRunning blocks until the pod reports Running, its node refuses to run it,
// or the deadline passes. On failure it attaches the pod's own events, because a
// pending pod's real reason (no such node, claim not bindable, image missing) is
// only ever in the event record.
func (t *PodTransporter) waitRunning(ctx context.Context, cfg Config, pod string) (*corev1.Pod, error) {
	deadline := time.Now().Add(cfg.ReadyTimeout)
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()
	var last *corev1.Pod
	var lastErr error
	for {
		p, err := t.Client.CoreV1().Pods(cfg.Namespace).Get(ctx, pod, metav1.GetOptions{})
		if err == nil {
			last = p
			switch p.Status.Phase {
			case corev1.PodRunning:
				return p, nil
			case corev1.PodSucceeded, corev1.PodFailed:
				return nil, denial("pod_wait", "pod_terminated",
					fmt.Sprintf("attempt pod %s ended in phase %s before the session started: %s", pod, p.Status.Phase, t.describe(ctx, cfg.Namespace, pod, p)))
			}
		} else if apierrors.IsNotFound(err) {
			return nil, denial("pod_wait", "pod_missing", fmt.Sprintf("attempt pod %s disappeared while the worker waited for it to start", pod))
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return nil, denial("pod_wait", "interrupted", fmt.Sprintf("waiting for attempt pod %s to start: %v", pod, ctx.Err()))
		case <-ticker.C:
		}
		if !time.Now().Before(deadline) {
			detail := t.describe(ctx, cfg.Namespace, pod, last)
			if lastErr != nil {
				detail = lastErr.Error() + "; " + detail
			}
			return nil, denial("pod_wait", "timeout",
				fmt.Sprintf("attempt pod %s was not Running within %s: %s", pod, cfg.ReadyTimeout, detail))
		}
	}
}

// describe summarises why a pod is not running: container waiting states plus the
// pod's events. No secret ever reaches these strings — the API server's own
// messages do not carry launch values.
func (t *PodTransporter) describe(ctx context.Context, namespace, podName string, pod *corev1.Pod) string {
	var parts []string
	if pod != nil {
		if pod.Status.Message != "" {
			parts = append(parts, "message: "+pod.Status.Message)
		}
		if pod.Status.Reason != "" {
			parts = append(parts, "reason: "+pod.Status.Reason)
		}
		for _, cs := range pod.Status.InitContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				parts = append(parts, fmt.Sprintf("initContainer %s: %s %s", cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message))
			}
		}
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				parts = append(parts, fmt.Sprintf("container %s: %s %s", cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message))
			}
		}
	}
	events, err := t.Client.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Pod,involvedObject.name=" + podName,
	})
	if err == nil && events != nil {
		for _, e := range events.Items {
			parts = append(parts, fmt.Sprintf("%s: %s %s", e.Reason, e.Type, e.Message))
		}
	}
	if len(parts) == 0 {
		return "no pod status or events reported"
	}
	return bounded(strings.Join(parts, "; "), 1024)
}

// retire deletes the attempt pod and, when the ownerReference may never have
// landed, the Secret too. Both are best-effort and never mask the caller's error.
// retire runs on a context detached from the launch's own: the reason a launch
// fails is often that its context is already gone, and a cancelled context must
// not be allowed to leave an attempt pod running with a credential volume behind.
func (t *PodTransporter) retire(caller context.Context, namespace, pod, secret string, grace int64) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(caller), 30*time.Second)
	defer cancel()
	t.deletePod(ctx, namespace, pod, grace)
	t.deleteSecret(ctx, namespace, secret)
}

func (t *PodTransporter) deletePod(ctx context.Context, namespace, pod string, grace int64) error {
	opts := metav1.DeleteOptions{}
	if grace >= 0 {
		opts.GracePeriodSeconds = int64Ptr(grace)
	}
	err := t.Client.CoreV1().Pods(namespace).Delete(ctx, pod, opts)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		t.log().Warn("attempt pod deletion failed",
			slog.String("pod", pod), slog.String("error", bounded(err.Error(), 512)))
	}
	return err
}

func (t *PodTransporter) deleteSecret(ctx context.Context, namespace, secret string) {
	err := t.Client.CoreV1().Secrets(namespace).Delete(ctx, secret, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		t.log().Warn("attempt secret deletion failed",
			slog.String("secret", secret), slog.String("error", bounded(err.Error(), 512)))
	}
}

// ---------------------------------------------------------------------------
// the exec command
// ---------------------------------------------------------------------------

// SessionCommand renders the argv `pods/exec` runs for the session.
//
// The shape is `sh -c <script> <name> <cwd> <path> <args…>` because the exec has
// to do three things the API cannot ask for directly: change directory, install
// an environment built from scratch, and exec the plan so the shell is replaced
// rather than left as the agent's parent. `env -C` would cover the first two on
// GNU coreutils, but not the third's credential substitution below, and the argv
// would then have to carry the values.
//
// The credential entries are the reason for the script: their VALUES never enter
// the exec request — the API server would log them — only the `cat` of the 0600
// file the initContainer wrote does, inside the pod, at exec time.
func SessionCommand(plan acp.LaunchPlan, plain []string, creds []Credential) ([]string, error) {
	if plan.Path == "" {
		return nil, errors.New("sandbox/k8s: the launch plan names no executable")
	}
	if strings.HasPrefix(plan.Path, "-") {
		// `env` would read it as a flag. The plan's path is nono's, resolved by
		// the worker; a flag-shaped one is a bug, not a launch.
		return nil, fmt.Errorf("sandbox/k8s: launch path %q looks like a flag", plan.Path)
	}
	if plan.Dir == "" {
		return nil, fmt.Errorf("sandbox/k8s: the launch plan carries no working directory")
	}
	if !safePath.MatchString(plan.Dir) {
		return nil, fmt.Errorf("sandbox/k8s: working directory %q cannot be used in the exec script", plan.Dir)
	}

	var b strings.Builder
	b.WriteString("set -e\ncd \"$1\"\nshift\nexec env -i")
	for _, kv := range plain {
		name, _, ok := strings.Cut(kv, "=")
		if !ok || name == "" {
			return nil, fmt.Errorf("sandbox/k8s: launch environment entry %q is not NAME=VALUE", kv)
		}
		fmt.Fprintf(&b, " %s", shQuote(kv))
	}
	for _, c := range creds {
		if !safeKey.MatchString(c.Name) {
			return nil, fmt.Errorf("sandbox/k8s: credential %q cannot be an environment name", c.Name)
		}
		// The single quotes inside the double quotes are literal: the pod's shell
		// expands the command substitution, and `env` receives one already
		// substituted assignment. A trailing newline is stripped by the shell, so
		// a token file with one still yields the same value the worker read.
		fmt.Fprintf(&b, " %s=\"$(cat '%s')\"", c.Name, path.Join(CredentialDir, c.Name))
	}
	// "$@" is now <path> <args…>; the plan's argv needs no quoting because it
	// never passes through this shell — it is the exec's argument vector.
	b.WriteString(" \"$@\"\n")

	argv := []string{"sh", "-c", b.String(), "communication-agent", plan.Dir, plan.Path}
	return append(argv, plan.Args...), nil
}

// shQuote quotes one word for POSIX sh.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// credentialNames is the loggable half of a credential list.
func credentialNames(creds []Credential) []string {
	out := make([]string, 0, len(creds))
	for _, c := range creds {
		out = append(out, c.Name)
	}
	sort.Strings(out)
	return out
}

// grantFlag names the argv flags that carry a sandbox grant path.
var grantFlags = map[string]bool{"--allow": true, "--read": true}

// uncoveredGrantPaths returns the plan's grant paths that no configured mount
// covers, so each gets a pod-private emptyDir.
//
// This is a correctness rule, not a convenience: nono silently ignores a grant
// whose path does not resolve (probe C-FC3), so a plan that grants the launcher's
// credential directory would launch a narrower sandbox in the pod than the one
// the worker verified. A pod-private directory at that path makes the grant
// real, and ADR-0040/ADR-0059's environment channel is what authenticates the
// launcher there — the worker's own credential tree never travels to the pod.
func uncoveredGrantPaths(plan acp.LaunchPlan, cfg Config) []string {
	covered := append(append([]string(nil), cfg.ClaimPaths...), cfg.mountPaths()...)
	covered = append(covered, CredentialVolumeDir)
	var out []string
	seen := map[string]bool{}
	var found []string
	for i := 0; i+1 < len(plan.Args); i++ {
		if !grantFlags[plan.Args[i]] {
			continue
		}
		p := plan.Args[i+1]
		if !path.IsAbs(p) || !safePath.MatchString(p) || coveredPath(p, covered) || seen[p] {
			continue
		}
		seen[p] = true
		found = append(found, p)
	}
	sort.Strings(found)
	// Collapse nesting: one mount at an ancestor covers every grant under it, and
	// two mounts on the same tree would hide each other (the builder refuses the
	// pair, so the launcher would fail the attempt over a shape that is legal in
	// argv — a launcher's own credential directory inside another launcher's).
	for _, p := range found {
		if coveredPath(p, out) {
			continue
		}
		out = append(out, p)
	}
	return out
}

// AttemptIDFromPlan finds the attempt a plan belongs to.
//
// The Transporter seam is handed only a launch plan (ADR-0082 §8), so the id
// comes from the plan itself: the worker stamps COMMUNICATION_ATTEMPT_ID on every
// agent launch, and every attempt's HOME is <workspace>/home/attempts/<id>.
// Without either there is nothing to name the pod by, and an anonymous pod is an
// unauditable one — that is a refusal, not a generated name.
func AttemptIDFromPlan(plan acp.LaunchPlan) (string, error) {
	candidates := append(append([]string(nil), plan.Env...), plan.Args...)
	for _, kv := range candidates {
		name, value, ok := strings.Cut(kv, "=")
		if ok && name == EnvAttemptID && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), nil
		}
	}
	if parts := strings.Split(path.Clean(plan.Dir), "/"); len(parts) >= 2 {
		for i := 0; i+1 < len(parts); i++ {
			if parts[i] == "attempts" && parts[i+1] != "" {
				return parts[i+1], nil
			}
		}
	}
	return "", fmt.Errorf("sandbox/k8s: the launch plan carries no %s and no attempts/<id> working directory, so the attempt pod cannot be named or audited", EnvAttemptID)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// podTransport is acp.Transport over one exec session in one attempt pod.
type podTransport struct {
	t         *PodTransporter
	namespace string
	pod       string
	attemptID string

	stdin   *io.PipeWriter // the client's write end
	stdout  *io.PipeReader // the client's read end
	stdoutW *io.PipeWriter
	stderr  *capture

	done      chan struct{}
	exitErrMu sync.Mutex
	exitErr   error

	ctx    context.Context
	cancel context.CancelFunc

	closeOnce sync.Once
}

var _ acp.Transport = (*podTransport)(nil)

func (p *podTransport) Stdin() io.WriteCloser { return p.stdin }
func (p *podTransport) Stdout() io.Reader     { return p.stdout }

// Stderr returns the captured stderr so far. It is a snapshot, exactly as the
// process transport's is: the capture is what a failure quotes, so a reader that
// consumed the live stream would take those bytes away.
func (p *podTransport) Stderr() io.Reader { return bytes.NewReader(p.stderr.snapshot()) }

func (p *podTransport) setExit(err error) {
	p.exitErrMu.Lock()
	defer p.exitErrMu.Unlock()
	p.exitErr = err
}

// Wait blocks until the exec stream ends and returns its verdict, shaped like
// ProcTransport's so the handle's failure text reads the same in either mode.
// The pod outlives the exec that rode it, so retiring the stream retires the
// attempt's pod — the Secret goes with it by ownerReference GC (S4).
func (p *podTransport) Wait() error {
	<-p.done
	p.deletePodNow(0)
	err := p.exitError()
	if err != nil {
		p.t.log().Debug("attempt pod session ended",
			slog.String("pod", p.pod), slog.String("error", bounded(err.Error(), 512)))
	}
	return err
}

func (p *podTransport) exitError() error {
	p.exitErrMu.Lock()
	defer p.exitErrMu.Unlock()
	return p.exitErr
}

// Signal is the handle's teardown ladder. A pod cannot be signalled through the
// API the way a process can — `pods/exec` hands back no pid to signal and the
// session's process lives under nono inside the pod — so the ladder's two rungs
// are the two deletion graces ADR-0082 allows: SIGTERM means "hang up stdin and
// let the pod drain for 5s", SIGKILL means "take 0s".
func (p *podTransport) Signal(sig os.Signal) error {
	_ = p.stdin.Close()
	var err error
	if ss, ok := sig.(syscall.Signal); ok {
		switch ss {
		case syscall.SIGTERM:
			err = p.deletePodNow(DefaultGracePeriodSeconds)
		case syscall.SIGKILL:
			err = p.deletePodNow(0)
		default:
			return fmt.Errorf("sandbox/k8s: the pod transport can retire a session only by deleting its pod; signal %v has no equivalent (ADR-0082 Decision 2)", sig)
		}
	} else {
		return fmt.Errorf("sandbox/k8s: the pod transport can retire a session only by deleting its pod; signal %v has no equivalent (ADR-0082 Decision 2)", sig)
	}
	// A deleted pod ends its exec streams on the API server's side; hanging up
	// ours here is what makes Wait return without waiting for that round trip,
	// so the handle's bounded reap is bounded in this mode too (the wedge that
	// stood the lab's worker still in run 41789603709).
	if p.cancel != nil {
		p.cancel()
	}
	return err
}

// Close hangs up the pipes and deletes the pod. The Secret goes by GC.
func (p *podTransport) Close() error {
	var err error
	p.closeOnce.Do(func() {
		_ = p.stdin.Close()
		_ = p.stdoutW.Close()
		err = p.deletePodNow(DefaultGracePeriodSeconds)
		if p.cancel != nil {
			p.cancel()
		}
	})
	return err
}

// deletePodNow deletes the attempt pod. The teardown ladder may ask twice
// (SIGTERM then SIGKILL) and the second, harder request must still be served,
// so there is no once-guard here — Close's once-guard is the idempotent one.
// It runs on a context detached from the session's, because the reason for the
// teardown is usually that the session's context is already gone.
func (p *podTransport) deletePodNow(grace int64) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(p.ctx), 30*time.Second)
	defer cancel()
	return p.t.deletePod(ctx, p.namespace, p.pod, grace)
}

// ---------------------------------------------------------------------------
// bounded capture + exit mapping
// ---------------------------------------------------------------------------

// exitCodeCause is how client-go's exec protocol reports a non-zero exit: an
// exec.CodeExitError whose message names the code. Nothing else carries one.

// ExitError is the pod-shaped sibling of *exec.ExitError: it names the attempt
// pod as well as the code, because in this mode the thing that exited was reached
// through an API server and an operator needs both identities.
type ExitError struct {
	Pod  string
	Code int
	Err  error
}

func (e *ExitError) Error() string {
	if e == nil {
		return "sandbox/k8s: <nil> exit"
	}
	msg := fmt.Sprintf("sandbox/k8s: %s exited with code %d", e.Pod, e.Code)
	if e.Err != nil && e.Err.Error() != "" {
		msg += ": " + e.Err.Error()
	}
	return msg
}

func (e *ExitError) Unwrap() error { return e.Err }

// ExitCode lets errors.As reach the code the same way *exec.ExitError's does.
func (e *ExitError) ExitCode() int { return e.Code }

// mapExit turns the executor's error into an ExitError when the exec reported a
// non-zero exit, and passes anything else (an upgrade refusal, a 500, a cancelled
// stream) through unchanged — an error that is not an exit must not be relabelled
// as one.
func mapExit(pod string, err error) error {
	if err == nil {
		return nil
	}
	var ce kexec.CodeExitError
	if errors.As(err, &ce) {
		return &ExitError{Pod: pod, Code: ce.ExitStatus(), Err: ce.Err}
	}
	return err
}

// withoutValues rewrites an API error so a credential value it happened to echo
// (a patch that included the Secret's body, say) cannot reach a log or an
// attempt detail. Names survive; values do not.
func withoutValues(err error, creds []Credential) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	for _, c := range creds {
		if len(c.Value) > 0 {
			msg = strings.ReplaceAll(msg, string(c.Value), "<redacted>")
		}
	}
	return errors.New(bounded(msg, 1024))
}

// capture is a bounded, mutex-guarded tail of what a stream wrote. It mirrors the
// acp package's own ring so a pod transport can quote stderr without importing
// an unexported type.
type capture struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newCapture(maxBytes int) *capture { return &capture{max: maxBytes} }

func (c *capture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p...)
	if over := len(c.buf) - c.max; over > 0 {
		c.buf = append(c.buf[:0], c.buf[over:]...)
	}
	return len(p), nil
}

func (c *capture) snapshot() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buf...)
}

func bounded(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
