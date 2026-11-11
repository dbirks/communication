//go:build kind

// The ADR-0082 cluster spikes. These tests need a real API server, a real kubelet
// and a real kernel — which is the whole point: S1 asks whether Landlock actually
// denies a write inside a pod built the way the launcher builds them, S2 asks
// whether ACP really rides a `pods/exec` stdio pipe through the production
// Transporter, and S4 asks whether the garbage collector really takes the
// per-attempt Secret when the attempt pod goes. None of that is answerable with a
// fake clientset, and none of it should run in CI where there is no cluster, so
// the file is behind the `kind` build tag and scripts/kind/test.sh runs it against
// the cluster it just built.
//
// Configuration comes from the same environment the worker reads (ADR-0082 §8), so
// the script sets one set of variables for both:
//
//	COMMUNICATION_AGENT_NAMESPACE   namespace the attempt pods are created in
//	COMMUNICATION_AGENT_POD_IMAGE   image for them (the worker image)
//	COMMUNICATION_AGENT_POD_NODE    node to pin to (kind has one)
//	COMMUNICATION_AGENT_WORKSPACE_PVC  optional claim under test
//	COMMUNICATION_AGENT_WORKSPACE_PATHS  optional claim paths (CSV, absolute)
//	KUBECONFIG                      the kind cluster's config
package k8s

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
)

const (
	// probeValue is the environment entry S2 carries to the fake adapter. It can
	// only arrive there as a file: the exec request names the entry and nothing
	// else (ADR-0082 Decision 6), so an echo of this exact string in the agent's
	// reply is the proof.
	probeValue  = "kind-probe-s3cr3t"
	rcWaitLimit = 60 * time.Second
)

// kindCluster is the test's view of the cluster: a clientset, an exec factory and
// the launcher config the script configured.
type kindCluster struct {
	cfg       Config
	client    kubernetes.Interface
	executors *RESTExecutors
	// claimUnderTest is set when the script pointed the launcher at a claim, in
	// which case attempts mount the workspace roots the script named.
	claimPaths []string
}

func connectKind(t *testing.T) *kindCluster {
	t.Helper()
	if os.Getenv("KUBECONFIG") == "" && os.Getenv("COMMUNICATION_KIND_KUBECONFIG") == "" {
		t.Fatal("no KUBECONFIG: scripts/kind/test.sh exports it, and these tests have no cluster without it")
	}
	restCfg, err := kindRESTConfig()
	if err != nil {
		t.Fatalf("kubeconfig: %v", err)
	}
	client, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	getenv := os.Getenv
	paths := strings.SplitSeq(strings.TrimSpace(os.Getenv("COMMUNICATION_AGENT_WORKSPACE_PATHS")), ",")
	var claimPaths []string
	for p := range paths {
		if p = strings.TrimSpace(p); p != "" {
			claimPaths = append(claimPaths, p)
		}
	}
	cfg := Config{
		Namespace:       getenv("COMMUNICATION_AGENT_NAMESPACE"),
		Image:           getenv("COMMUNICATION_AGENT_POD_IMAGE"),
		NodeName:        getenv("COMMUNICATION_AGENT_POD_NODE"),
		Claim:           strings.TrimSpace(getenv("COMMUNICATION_AGENT_WORKSPACE_PVC")),
		ClaimPaths:      claimPaths,
		LocalPaths:      []string{"/sandbox-home"},
		SandboxHome:     "/sandbox-home",
		SandboxSelfTest: "/sandbox-selftest",
		PollInterval:    time.Second,
		ReadyTimeout:    300 * time.Second,
		VerifyTimeout:   120 * time.Second,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("launcher config: %v", err)
	}
	return &kindCluster{
		cfg:        cfg,
		client:     client,
		executors:  &RESTExecutors{Client: client, RESTConfig: restCfg},
		claimPaths: claimPaths,
	}
}

// kindRESTConfig reads the cluster the script built. It shells out to kubectl for
// the JSON form of the kubeconfig rather than importing client-go's clientcmd:
// this file is a test, it runs on one host, and the alternative would put a new
// module (and its transitive flag package) into the binary's dependency graph for
// thirty lines of parsing.
func kindRESTConfig() (*rest.Config, error) {
	raw, err := exec.Command("kubectl", "config", "view", "--raw", "-o", "json", "--minify").Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl config view --raw: %w", err)
	}
	var doc struct {
		Clusters []struct {
			Cluster struct {
				Server                   string `json:"server"`
				CertificateAuthority     string `json:"certificate-authority"`
				CertificateAuthorityData string `json:"certificate-authority-data"`
				InsecureSkipTLSVerify    bool   `json:"insecure-skip-tls-verify"`
			} `json:"cluster"`
		} `json:"clusters"`
		Users []struct {
			User struct {
				ClientCertificate     string `json:"client-certificate"`
				ClientCertificateData string `json:"client-certificate-data"`
				ClientKey             string `json:"client-key"`
				ClientKeyData         string `json:"client-key-data"`
				Token                 string `json:"token"`
			} `json:"user"`
		} `json:"users"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("decode kubeconfig: %w", err)
	}
	if len(doc.Clusters) != 1 || doc.Clusters[0].Cluster.Server == "" {
		return nil, fmt.Errorf("kubeconfig names %d clusters; --minify should have left exactly one", len(doc.Clusters))
	}
	if len(doc.Users) != 1 {
		return nil, fmt.Errorf("kubeconfig names %d users, want one", len(doc.Users))
	}
	cluster, user := doc.Clusters[0].Cluster, doc.Users[0].User
	cfg := &rest.Config{Host: cluster.Server}
	// The `-data` fields of a kubeconfig are base64; rest.TLSClientConfig's
	// CAData/CertData/KeyData are the bytes themselves (clientcmd decodes on
	// load), so decoding here is the difference between a certificate and a PEM
	// parse error.
	caPEM, err := decodeKubeData(cluster.CertificateAuthorityData)
	if err != nil {
		return nil, fmt.Errorf("cluster certificate authority: %w", err)
	}
	certPEM, err := decodeKubeData(user.ClientCertificateData)
	if err != nil {
		return nil, fmt.Errorf("client certificate: %w", err)
	}
	keyPEM, err := decodeKubeData(user.ClientKeyData)
	if err != nil {
		return nil, fmt.Errorf("client key: %w", err)
	}
	switch {
	case cluster.InsecureSkipTLSVerify:
		cfg.TLSClientConfig.Insecure = true
	case len(caPEM) > 0 || cluster.CertificateAuthority != "":
		cfg.TLSClientConfig.CAData = caPEM
		cfg.TLSClientConfig.CAFile = cluster.CertificateAuthority
	default:
		return nil, fmt.Errorf("kubeconfig cluster %s offers no certificate authority and no insecure-skip-tls-verify: refusing to talk to it over an unpinned TLS connection", cluster.Server)
	}
	switch {
	case len(certPEM) > 0 && len(keyPEM) > 0:
		cfg.TLSClientConfig.CertData = certPEM
		cfg.TLSClientConfig.KeyData = keyPEM
	case user.ClientCertificate != "" && user.ClientKey != "":
		cfg.TLSClientConfig.CertFile = user.ClientCertificate
		cfg.TLSClientConfig.KeyFile = user.ClientKey
	case user.Token != "":
		cfg.BearerToken = user.Token
	default:
		return nil, fmt.Errorf("kubeconfig user offers no client certificate and no token: the spikes cannot authenticate to %s", cluster.Server)
	}
	return cfg, nil
}

// decodeKubeData turns a kubeconfig `*-data` field into its bytes, and an absent
// field into nothing.
func decodeKubeData(raw string) ([]byte, error) {
	if raw == "" {
		return nil, nil
	}
	out, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("base64: %w", err)
	}
	return out, nil
}

// newAttemptPlan builds the launch the spikes run. The program is the same binary
// these tests are compiled into, the environment is the one the worker would build
// (built from scratch — nothing here inherits os.Environ()), and the probe value is
// carried the way a credential is: as a Secret entry named but never quoted in the
// exec request.
func newAttemptPlan(program string, args []string, extraEnv ...string) (acp.LaunchPlan, string) {
	attemptID := kindAttemptID()
	env := append([]string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=/tmp",
		"TERM=xterm-256color",
		EnvAttemptID + "=" + attemptID,
		// Credential-shaped on purpose: this is the entry class the ADR is about.
		"SECRET=" + probeValue,
	}, extraEnv...)
	return acp.LaunchPlan{Path: program, Args: args, Env: env, Dir: "/tmp"}, attemptID
}

func kindAttemptID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// TestKindAttemptPodVerifies is spike S1: one attempt pod, built by the launcher's
// own builders and started by the launcher's own Start, and the in-pod probe's
// verdict read back. A pass is the cluster saying out loud that a child inside a
// RuntimeDefault, drop-ALL, uid-10001 pod was DENIED a write and still completed a
// TCP connect — which is the fact the whole pod launcher rests on and no unit test
// can supply.
func TestKindAttemptPodVerifies(t *testing.T) {
	k := connectKind(t)
	ctx := context.Background()
	tr := &PodTransporter{
		Client:    k.client,
		Executors: k.executors,
		Config:    k.cfg,
		Logger:    slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
	// The session is the pod-wait entrypoint, so the pod stays ours until Close:
	// what Start already required is the verified verdict, and what this asserts
	// next is the same verdict read from the pod's own stdout.
	plan, attemptID := newAttemptPlan("/usr/local/bin/communication", []string{"pod-wait"})
	transport, err := tr.Start(ctx, plan)
	if err != nil {
		t.Fatalf("Start (which runs the in-pod probe before it returns): %v", err)
	}
	t.Cleanup(func() { _ = transport.Close() })

	name, err := ObjectName(attemptID)
	if err != nil {
		t.Fatalf("object name: %v", err)
	}
	out := &bytes.Buffer{}
	err = tr.streamToPod(ctx, k.cfg.Namespace, name, VerifyCommand, remotecommand.StreamOptions{
		Stdout: out,
		Stderr: &bytes.Buffer{},
		Tty:    false,
	})
	if err != nil {
		t.Fatalf("pod-verify in %s: %v\n%s", name, err, out)
	}
	t.Logf("attempt pod %s verdict: %s", name, strings.TrimSpace(out.String()))
	verdict, err := ParseVerdict(out.Bytes())
	if err != nil {
		t.Fatalf("verdict: %v (raw %q)", err, out.String())
	}
	if err := verdict.Check(); err != nil {
		t.Fatalf("the attempt pod refused itself: %v", err)
	}
	if !verdict.Verified || !verdict.TCP || verdict.LandlockABI < MinLandlockABI {
		t.Fatalf("verdict is not enforcement: %s", verdict)
	}
	t.Logf("S1 PASS: %s", verdict)
}

// TestKindACPHandshake is spike S2: a real ACP handshake — initialize, session/new,
// a prompt turn with a streamed reply — over the stdio of a `pods/exec` session,
// driven by the production client (acp.Runtime) against the production pod
// Transporter, with the agent side answered by `communication acp-echo` inside the
// attempt pod. The reply must carry the probe value, which reached the pod as a
// Secret file and nowhere near the exec request.
func TestKindACPHandshake(t *testing.T) {
	k := connectKind(t)
	ctx := context.Background()
	tr := &PodTransporter{
		Client:    k.client,
		Executors: k.executors,
		Config:    k.cfg,
		Logger:    slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
	rt := &acp.Runtime{Transporter: tr, PermissionPolicy: acp.PermissionDeny}

	plan, attemptID := newAttemptPlan("", nil)
	plan.Path = "/usr/local/bin/communication"
	plan.Args = []string{"acp-echo"}
	// The two variables the echo itself needs, delivered like every other entry:
	// as files, named but not quoted in the exec request.
	plan.Env = append(plan.Env, "COMMUNICATION_ACP_ECHO=1", "COMMUNICATION_ACP_ECHO_PROBE="+probeValue)

	// Through the runtime, so the handshake, the framing and the event channel are
	// the ones a turn actually uses.
	sess, err := rt.StartWithOptions(ctx, domain.AgentLaunchSpec{
		LauncherID: "kind-acp-echo",
		Executable: plan.Path,
		Args:       plan.Args,
		Env:        plan.Env,
		WorkDir:    plan.Dir,
	}, acp.StartOptions{})
	if err != nil {
		t.Fatalf("acp handshake through pods/exec: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })

	info := sess.Info()
	if info.ACPSessionID == "" {
		t.Error("session/new returned no session id")
	}
	if info.ProtocolVersion != 1 {
		t.Errorf("negotiated protocol version = %d, want 1", info.ProtocolVersion)
	}
	t.Logf("S2 handshake: session=%s protocol=%d", info.ACPSessionID, info.ProtocolVersion)

	events := map[string][]string{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range sess.Events() {
			events[ev.Kind] = append(events[ev.Kind], ev.Text)
		}
	}()

	const prompt = "hello from kind"
	reason, err := sess.Prompt(ctx, prompt)
	if err != nil {
		t.Fatalf("prompt turn: %v", err)
	}
	if err := sess.Close(); err != nil {
		t.Logf("session close reported: %v", err)
	}
	<-done

	if reason != domain.StopEndTurn {
		t.Errorf("stop reason = %q, want %q", reason, domain.StopEndTurn)
	}
	var reply string
	for _, chunk := range events["message_chunk"] {
		if strings.Contains(chunk, acpEchoMarker) {
			reply = chunk
		}
	}
	if reply == "" {
		t.Fatalf("no agent message carried the echo's marker; chunks=%v kinds=%v", events["message_chunk"], eventKinds(events))
	}
	if !strings.Contains(reply, prompt) {
		t.Errorf("the reply did not carry the prompt through the pipe: %q", reply)
	}
	if !strings.Contains(reply, probeValue) {
		t.Errorf("the reply did not carry the delivered environment back: %q", reply)
	}
	t.Logf("S2 PASS: %q", reply)

	// The pod the session ran in is the attempt pod, and the launcher retired it.
	waitPodGone(t, k, attemptID)
}

// acpEchoMarker is the fixed prefix `communication acp-echo` gives every reply
// (cmd/communication/acpecho.go).
const acpEchoMarker = "acp-echo"

// TestKindAttemptObjectsAreGarbageCollected is spike S4: the per-attempt Secret is
// adopted by the attempt pod, and nothing but the garbage collector is asked to
// remove it. The launcher deletes both objects itself on a normal teardown, so this
// test creates the pair, proves the ownerReference is the pod's, deletes the POD
// only, and then waits for the Secret to disappear on its own.
func TestKindAttemptObjectsAreGarbageCollected(t *testing.T) {
	k := connectKind(t)
	ctx := context.Background()
	attemptID := kindAttemptID()
	secretName, err := ObjectName(attemptID)
	if err != nil {
		t.Fatalf("object name: %v", err)
	}
	files, err := EnvFiles([]string{"PATH=/usr/local/bin:/bin", "HOME=/tmp", "SECRET=" + probeValue})
	if err != nil {
		t.Fatalf("EnvFiles: %v", err)
	}
	secret, err := BuildSecret(attemptID, k.cfg.Namespace, files)
	if err != nil {
		t.Fatalf("BuildSecret: %v", err)
	}
	if _, err := k.client.CoreV1().Secrets(k.cfg.Namespace).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create secret: %v", err)
	}
	pod, err := PodInput{
		AttemptID:       attemptID,
		Namespace:       k.cfg.Namespace,
		Image:           k.cfg.Image,
		NodeName:        k.cfg.NodeName,
		LocalPaths:      k.cfg.mountPaths(),
		SandboxHome:     k.cfg.SandboxHome,
		SandboxSelfTest: k.cfg.SandboxSelfTest,
		EnvNames:        EnvFileNames(files),
		// The pod does nothing but hold: this spike is about who deletes it.
		Command: []string{"communication", "pod-wait"},
	}.Pod()
	if err != nil {
		t.Fatalf("Pod: %v", err)
	}
	created, err := k.client.CoreV1().Pods(k.cfg.Namespace).Create(ctx, pod, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("create pod: %v", err)
	}
	t.Cleanup(func() {
		_ = k.client.CoreV1().Pods(k.cfg.Namespace).Delete(context.WithoutCancel(context.Background()), created.Name, metav1.DeleteOptions{})
		_ = k.client.CoreV1().Secrets(k.cfg.Namespace).Delete(context.WithoutCancel(context.Background()), secret.Name, metav1.DeleteOptions{})
	})
	patch, err := OwnerPatch(created)
	if err != nil {
		t.Fatalf("OwnerPatch: %v", err)
	}
	adopted, err := k.client.CoreV1().Secrets(k.cfg.Namespace).Patch(ctx, secret.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		t.Fatalf("adopt secret: %v", err)
	}
	refs := OwnerReferencesOf(adopted)
	if len(refs) != 1 || refs[0].Kind != "Pod" || refs[0].UID != created.UID {
		t.Fatalf("secret ownerReferences = %+v, want the attempt pod", refs)
	}
	t.Logf("S4: secret %s adopted by pod %s/%s", secret.Name, created.UID, created.Name)

	// The pod goes; the launcher is not asked to clean up after it.
	if err := k.client.CoreV1().Pods(k.cfg.Namespace).Delete(ctx, created.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatalf("delete pod: %v", err)
	}
	waitPodGone(t, k, attemptID)
	// The Secret's name is the pod's: one pair in `kubectl get` (ADR-0082
	// Decision 5), which is also what makes this wait readable in a transcript.
	if secret.Name != secretName {
		t.Fatalf("secret name %q, want the pod's name %q", secret.Name, secretName)
	}
	waitSecretGone(t, k, secret.Name)
	t.Logf("S4 PASS: the garbage collector took the Secret with the pod")
}

// ------------------------------------------------------------------ helpers --

// waitPodGone waits out the pod's deletion, grace included, and reports what is
// left if it does not go.
func waitPodGone(t *testing.T, k *kindCluster, attemptID string) {
	t.Helper()
	name, err := ObjectName(attemptID)
	if err != nil {
		t.Fatalf("object name: %v", err)
	}
	deadline := time.Now().Add(rcWaitLimit)
	var last string
	for time.Now().Before(deadline) {
		pod, err := k.client.CoreV1().Pods(k.cfg.Namespace).Get(context.Background(), name, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			return
		case err != nil:
			last = err.Error()
		default:
			last = fmt.Sprintf("phase=%s deletionTimestamp=%v", pod.Status.Phase, pod.DeletionTimestamp)
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("attempt pod %s survived %s of deletion: %s\nlast events: %s", name, rcWaitLimit, last, k.describePod(context.Background(), k.cfg.Namespace, name))
}

// waitSecretGone is the S4 assertion: an owner-referenced Secret with no live owner
// must not outlive it.
func waitSecretGone(t *testing.T, k *kindCluster, secretName string) {
	t.Helper()
	deadline := time.Now().Add(rcWaitLimit)
	var last string
	for time.Now().Before(deadline) {
		_, err := k.client.CoreV1().Secrets(k.cfg.Namespace).Get(context.Background(), secretName, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			return
		case err != nil:
			last = err.Error()
		default:
			last = "still readable"
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("secret %s survived %s after its owner pod was deleted: %s", secretName, rcWaitLimit, last)
}

func (k *kindCluster) describePod(ctx context.Context, namespace, name string) string {
	events, err := k.client.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Pod,involvedObject.name=" + name,
	})
	if err != nil || events == nil {
		return "no events (" + fmt.Sprint(err) + ")"
	}
	var parts []string
	for _, e := range events.Items {
		parts = append(parts, e.Reason+": "+e.Message)
	}
	return strings.Join(parts, " | ")
}

func eventKinds(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
