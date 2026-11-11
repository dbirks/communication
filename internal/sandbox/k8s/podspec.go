// Package k8s is the Kubernetes launcher of ADR-0082 §8: one Pod per agent
// attempt, created by the worker that owns the attempt, with ACP riding the
// stdin/stdout of a `pods/exec` session inside it.
//
// The package holds two kinds of code. `podspec.go` and `secrets.go` are pure
// builders — they turn a launch into API objects and are testable without a
// cluster. `transporter.go` is the one implementation of `acp.Transporter` that
// talks to an API server, and `verify.go` is the in-pod sandbox verdict that
// gates every session (ADR-0019 D6: no verdict, no session).
//
// Nothing here imports the worker or the workspace package: the plan arriving at
// `Start` is the same `acp.LaunchPlan` the turn loop journalled, so what the
// pod runs and what the journal recorded stay one object.
package k8s

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

// Identity labels on every attempt pod (ADR-0082 Decision 2). The attempt label
// carries the full attempt id; the object *name* carries only its first 16
// characters, so the audit trail can name the object without losing the exact
// attempt it belongs to.
const (
	LabelAttempt   = "communication.dev/attempt"
	LabelManagedBy = "app.kubernetes.io/managed-by"
	ManagedByValue = "communication-worker"
)

// Object-naming and layout constants. The names are stable because RBAC, the
// kind script's assertions and the Secret's ownerReference all cite them.
const (
	// NamePrefix and idNameLen give `att-<attemptID-lower-16>`: a lowercase,
	// DNS-1123-safe truncation of the attempt id. 16 hex characters of a v4
	// UUID is 64 bits, so two live attempts on one worker colliding on a name is
	// not a thing that happens; the full id is on the label regardless.
	NamePrefix = "att-"
	idNameLen  = 16

	// ContainerName is the single container in an attempt pod.
	ContainerName = "agent"
	// InitEnv is the one-shot that copies the Secret's files into the 0700
	// attempt emptyDir as 0600 regular files (the home manifest's keyring
	// pattern: a Secret volume exposes `..data` symlinks, and the wrapper that
	// reads the environment should read 0600 files it can trust).
	InitEnv = "env"

	VolumeAttempt   = "communication-attempt"
	VolumeEnvSrc    = "communication-env-src"
	VolumeWorkspace = "communication-workspace"

	// AttemptDir is the emptyDir the initContainer owns; EnvDir is the 0700
	// directory it creates inside it and the in-pod wrapper reads from; and
	// EnvSrcDir is the read-only Secret volume it copies from. The emptyDir is
	// mounted one level up so the 0700 is real: an emptyDir's own root is created
	// by the kubelet, so the mode has to come from a directory this pod's
	// initContainer makes — the home manifest's keyring pattern. EnvFileDir is
	// the directory name each value is delivered under, so every launch-environment
	// entry is the file `env/<NAME>`.
	AttemptDir = "/run/attempt"
	EnvDir     = "/run/attempt/env"
	EnvSrcDir  = "/run/secrets"
	EnvFileDir = "env"

	// AttemptUID is the pod's uid/gid (ADR-0082 Decision 2), the same 10001 the
	// worker image and the home manifests run as.
	AttemptUID = 10001
	AttemptGID = 10001
	AttemptFS  = 10001

	// secretFileMode is the mode on the projected Secret files. It is group-read
	// on purpose: the projection is owned `root:root`, the kubelet only moves its
	// group to the pod's fsGroup, and the initContainer that copies it runs as the
	// attempt uid — so a 0400 here would be unreadable by the one container that
	// has to read it. The volume is a tmpfs that exists only in this attempt pod,
	// and what the agent actually reads is the 0600 copy (envFileMode).
	secretFileMode int32 = 0o440

	// envFileMode is the mode of the delivered copy the wrapper reads.
	envFileMode int32 = 0o600

	// DefaultGracePeriodSeconds is the deletion grace the launcher asks for on a
	// SIGTERM-shaped teardown; SIGKILL-shaped teardown asks for 0.
	DefaultGracePeriodSeconds = int64(5)
)

// PodCommand is the attempt pod's entrypoint: it exists only so the pod stays
// alive long enough for `pods/exec` sessions to attach (ADR-0082 Decision 2).
var PodCommand = []string{"communication", "pod-wait"}

// VerifyCommand is the in-pod sandbox probe exec'd before any ACP session
// starts. ADR-0082 Decision 3 names the same fail-closed rule as the worker's
// own startup gate.
var VerifyCommand = []string{"communication", "pod-verify"}

// safePath matches an absolute filesystem path that can be embedded in the
// initContainer's shell script and in a volumeMount without quoting trouble.
// It is deliberately narrower than "a legal POSIX path": a path with a quote,
// a space or a control character in it is refused rather than escaped, because
// this package generates a shell script from these values and the launchers'
// roots are operator configuration, not user input.
var safePath = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)

// safeKey matches a credential file name (an environment-variable name used as
// a Secret key and as a shell word). Secret keys and shell words share this set.
var safeKey = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// PodInput is everything the attempt pod is built from. It is data only: no
// client, no cluster, so the golden assertions in podspec_test can run
// anywhere.
type PodInput struct {
	// AttemptID identifies the attempt this pod exists for.
	AttemptID string
	// Namespace is COMMUNICATION_AGENT_NAMESPACE.
	Namespace string
	// Image is COMMUNICATION_AGENT_POD_IMAGE — the worker image, which is the
	// only image carrying nono, Node and the pinned adapters.
	Image string
	// NodeName is COMMUNICATION_AGENT_POD_NODE: the node holding the workspace
	// PVC. ADR-0082 Decision 4 pins attempts to that node for v1.
	NodeName string
	// Claim is COMMUNICATION_AGENT_WORKSPACE_PVC, the claim the worker's own
	// workspace roots live on. Empty means no shared volume.
	Claim string
	// ClaimPaths are the worker's absolute roots served from Claim. Each is
	// mounted at the SAME absolute path with subPath set to its final element,
	// so every path the verified plan names resolves identically inside the pod
	// (ADR-0082 Decision 4).
	ClaimPaths []string
	// LocalPaths are absolute paths that get a pod-private emptyDir at the same
	// path: nono's HOME and the self-test scratch must NOT be shared with the
	// worker (probe C-H1's refusal is per-state-root and sticky), and a grant
	// path the claim does not cover gets one too so nono never sees a grant that
	// resolves to nothing (probe C-FC3).
	LocalPaths []string
	// SandboxHome and SandboxSelfTest become container environment variables of
	// the same name. They are paths, not credentials, and the in-pod probe needs
	// them: `pods/exec` inherits the container's environment, not the worker's,
	// so `communication pod-verify` would otherwise have to guess where nono's
	// HOME and its scratch root are (ADR-0082 Decision 5's rule is that no
	// *value* of a credential ever appears in a pod spec).
	SandboxHome     string
	SandboxSelfTest string
	// EnvNames are the Secret's data keys — every launch-environment name this
	// launch carries, projected as `env/<NAME>`. Only names ever reach the pod
	// spec: an exec request or a pod spec that carried a value would put the
	// agent's credentials in apiserver audit and kubelet logs (ADR-0082 Decision 6).
	EnvNames []string
	// ExtraLabels joins the pod's labels (nil is fine).
	ExtraLabels map[string]string
	// Command overrides PodCommand. Tests and the kind script use it; the
	// worker never does.
	Command []string
}

// Validate rejects an input that would build a pod the ADR does not describe,
// or a pod spec that would carry an unquotable path into a shell script.
func (in PodInput) Validate() error {
	if _, err := ObjectName(in.AttemptID); err != nil {
		return err
	}
	if in.Namespace == "" {
		return fmt.Errorf("sandbox/k8s: COMMUNICATION_AGENT_NAMESPACE is required")
	}
	if errs := validation.IsDNS1123Label(in.Namespace); len(errs) > 0 {
		return fmt.Errorf("sandbox/k8s: namespace %q is not a DNS-1123 label: %s", in.Namespace, strings.Join(errs, ", "))
	}
	if in.Image == "" {
		return fmt.Errorf("sandbox/k8s: COMMUNICATION_AGENT_POD_IMAGE is required")
	}
	if err := checkPathList("workspace paths", in.ClaimPaths); err != nil {
		return err
	}
	if err := checkPathList("local paths", in.LocalPaths); err != nil {
		return err
	}
	for _, p := range []struct{ what, value string }{
		{"COMMUNICATION_SANDBOX_HOME", in.SandboxHome},
		{"COMMUNICATION_SANDBOX_SELFTEST_DIR", in.SandboxSelfTest},
	} {
		if p.value == "" {
			continue
		}
		if err := checkPathList(p.what, []string{p.value}); err != nil {
			return err
		}
		if !coveredPath(p.value, append(append([]string{}, in.ClaimPaths...), in.LocalPaths...)) {
			return fmt.Errorf("sandbox/k8s: %s points at %s, which no volume covers: the pod would report a sandbox state that does not exist", p.what, p.value)
		}
	}
	if in.Claim != "" && len(in.ClaimPaths) == 0 {
		return fmt.Errorf("sandbox/k8s: claim %q names no path to mount", in.Claim)
	}
	if in.Claim == "" && len(in.ClaimPaths) > 0 {
		return fmt.Errorf("sandbox/k8s: COMMUNICATION_AGENT_WORKSPACE_PVC is required for the paths %v", in.ClaimPaths)
	}
	if len(in.EnvNames) == 0 {
		return fmt.Errorf("sandbox/k8s: attempt pod for %q carries no launch environment: the plan's env is delivered whole through the per-attempt Secret, so an empty name list means nothing was parsed", in.AttemptID)
	}
	for _, k := range in.EnvNames {
		if !safeKey.MatchString(k) {
			return fmt.Errorf("sandbox/k8s: credential name %q is not a usable file name", k)
		}
	}
	all := append(append(append([]string{}, in.ClaimPaths...), in.LocalPaths...), AttemptDir, EnvSrcDir)
	for _, p := range all {
		for _, q := range all {
			if p != q && pathWithin(q, p) {
				return fmt.Errorf("sandbox/k8s: mount %q sits inside mount %q: the attempt pod would hide one volume behind another", p, q)
			}
		}
	}
	return nil
}

func checkPathList(what string, paths []string) error {
	for _, p := range paths {
		if !safePath.MatchString(p) || !path.IsAbs(p) || path.Clean(p) != p {
			return fmt.Errorf("sandbox/k8s: %s %q is not a clean absolute path of [A-Za-z0-9._/-]: a pod spec and an init script are built from it", what, p)
		}
	}
	return nil
}

// ObjectName is `att-<attemptID-lower-16>`: the name of BOTH the attempt pod and
// its per-attempt Secret (distinct kinds may share a name, and sharing one makes
// the ownerReference relationship obvious in `kubectl get`).
func ObjectName(attemptID string) (string, error) {
	id := strings.ToLower(strings.TrimSpace(attemptID))
	if id == "" {
		return "", fmt.Errorf("sandbox/k8s: an attempt id is required to name the attempt pod")
	}
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	id = strings.Trim(b.String(), "-")
	if id == "" {
		return "", fmt.Errorf("sandbox/k8s: attempt id %q carries no name-safe characters", attemptID)
	}
	if len(id) > idNameLen {
		id = strings.Trim(id[:idNameLen], "-")
	}
	name := NamePrefix + id
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		return "", fmt.Errorf("sandbox/k8s: pod name %q is not a DNS-1123 label: %s", name, strings.Join(errs, ", "))
	}
	return name, nil
}

// LabelValue keeps an attempt id inside the 63-character, alphanumeric-edged
// label-value rule while remaining the full id for any id the store issues
// today (a 36-character UUID fits unchanged).
func LabelValue(attemptID string) string {
	v := strings.ToLower(strings.TrimSpace(attemptID))
	if len(v) <= 63 {
		return v
	}
	return v[:63]
}

// Pod builds the attempt pod: one container running the pod-wait entrypoint, no
// service-account token, no service links, no capabilities, and the credential
// initContainer in front of it.
func (in PodInput) Pod() (*corev1.Pod, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	name, err := ObjectName(in.AttemptID)
	if err != nil {
		return nil, err
	}
	command := in.Command
	if len(command) == 0 {
		command = PodCommand
	}

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: in.Namespace,
			Labels:    in.labels(),
		},
		Spec: corev1.PodSpec{
			// One attempt, one pod, never restarted: a restart would run a second
			// agent under an already-answered attempt (ADR-0082 Decision 2).
			RestartPolicy:                 corev1.RestartPolicyNever,
			NodeName:                      in.NodeName,
			AutomountServiceAccountToken:  boolPtr(false),
			EnableServiceLinks:            boolPtr(false),
			TerminationGracePeriodSeconds: int64Ptr(DefaultGracePeriodSeconds),
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot: boolPtr(true),
				RunAsUser:    int64Ptr(AttemptUID),
				RunAsGroup:   int64Ptr(AttemptGID),
				FSGroup:      int64Ptr(AttemptFS),
				SeccompProfile: &corev1.SeccompProfile{
					// RuntimeDefault is what the research §1 shows to allow the
					// landlock + seccomp syscalls nono needs.
					Type: corev1.SeccompProfileTypeRuntimeDefault,
				},
			},
			InitContainers: []corev1.Container{in.envInit()},
			Containers: []corev1.Container{{
				Name:            ContainerName,
				Image:           in.Image,
				ImagePullPolicy: corev1.PullIfNotPresent,
				Command:         command,
				Env:             in.env(),
				SecurityContext: &corev1.SecurityContext{
					AllowPrivilegeEscalation: boolPtr(false),
					Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
				},
				VolumeMounts: in.agentMounts(),
			}},
			Volumes: in.volumes(),
		},
	}
	return pod, nil
}

// secretName is the pod name; an unnameable attempt id yields no volume secret
// and Validate has already refused that input.
func (in PodInput) secretName() string {
	name, err := ObjectName(in.AttemptID)
	if err != nil {
		return ""
	}
	return name
}

// env is the container environment: the two sandbox directory variables, and
// nothing else. The session's own environment is built from scratch by the exec
// script (SessionCommand), which is why the pod spec carries no PATH or HOME.
func (in PodInput) env() []corev1.EnvVar {
	var out []corev1.EnvVar
	if in.SandboxHome != "" {
		out = append(out, corev1.EnvVar{Name: "COMMUNICATION_SANDBOX_HOME", Value: in.SandboxHome})
	}
	if in.SandboxSelfTest != "" {
		out = append(out, corev1.EnvVar{Name: "COMMUNICATION_SANDBOX_SELFTEST_DIR", Value: in.SandboxSelfTest})
	}
	return out
}

func (in PodInput) labels() map[string]string {
	labels := map[string]string{
		LabelAttempt:   LabelValue(in.AttemptID),
		LabelManagedBy: ManagedByValue,
	}
	for k, v := range in.ExtraLabels {
		labels[k] = v
	}
	return labels
}

func (in PodInput) volumes() []corev1.Volume {
	vols := []corev1.Volume{
		{
			Name: VolumeAttempt,
			VolumeSource: corev1.VolumeSource{
				// The 0700 is put on the directory inside this volume by the
				// initContainer; see AttemptDir.
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		},
		{
			Name: VolumeEnvSrc,
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					// The Secret carries the pod's own name (BuildSecret below), so
					// the two objects are one pair in `kubectl get`.
					SecretName:  in.secretName(),
					DefaultMode: int32Ptr(secretFileMode),
					Items:       secretItems(in.EnvNames),
				},
			},
		},
	}
	if in.Claim != "" {
		vols = append(vols, corev1.Volume{
			Name: VolumeWorkspace,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: in.Claim},
			},
		})
	}
	for _, p := range in.LocalPaths {
		vols = append(vols, corev1.Volume{
			Name: localVolumeName(p),
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		})
	}
	return vols
}

// secretItems lists exactly the launch-environment names, each projected into
// the volume's `env/` directory: a Secret volume that projected the whole Secret
// unchecked would put its keys wherever the kubelet chose, and the wrapper needs
// one directory it can enumerate.
func secretItems(names []string) []corev1.KeyToPath {
	items := make([]corev1.KeyToPath, 0, len(names))
	for _, n := range names {
		items = append(items, corev1.KeyToPath{Key: n, Path: EnvFileDir + "/" + n})
	}
	return items
}

// EnvSourcePath is the `env/<NAME>` file the Secret projection writes, under
// EnvSrcDir.
func EnvSourcePath(name string) string {
	return EnvSrcDir + "/" + EnvFileDir + "/" + name
}

// EnvFilePath is the `env/<NAME>` file the in-pod wrapper (`communication
// pod-exec`, ADR-0082 Decision 6) reads: the initContainer's 0600 copy under the
// 0700 EnvDir.
func EnvFilePath(name string) string {
	return EnvDir + "/" + name
}

// agentMounts is the agent container's view: the credential emptyDir plus one
// mount per shared root (same absolute path, subPath = final element) and one
// per pod-private path.
func (in PodInput) agentMounts() []corev1.VolumeMount {
	mounts := []corev1.VolumeMount{{
		Name:      VolumeAttempt,
		MountPath: AttemptDir,
		// Read-only: the agent's environment is an input, and a session that could
		// rewrite its own delivered values could rewrite the next exec's view of
		// them.
		ReadOnly: true,
	}}
	for _, p := range in.ClaimPaths {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      VolumeWorkspace,
			MountPath: p,
			SubPath:   path.Base(p),
		})
	}
	for _, p := range in.LocalPaths {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      localVolumeName(p),
			MountPath: p,
		})
	}
	return mounts
}

// envInit is the home manifest's keyring pattern: copy the projected Secret
// files into the 0700 attempt directory as 0600 regular files, so nothing in the
// launch path reads through a `..data` symlink and so the delivered environment
// is a set of files the agent's own uid owns. The name list is the only thing
// rendered into the script — never a value.
func (in PodInput) envInit() corev1.Container {
	return corev1.Container{
		Name:            InitEnv,
		Image:           in.Image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Command:         []string{"sh", "-ec"},
		Args:            []string{envCopyScript(in.EnvNames)},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             boolPtr(true),
			RunAsUser:                int64Ptr(AttemptUID),
			RunAsGroup:               int64Ptr(AttemptGID),
			AllowPrivilegeEscalation: boolPtr(false),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: VolumeEnvSrc, MountPath: EnvSrcDir, ReadOnly: true},
			{Name: VolumeAttempt, MountPath: AttemptDir},
		},
	}
}

// envCopyScript is the initContainer body. It fails (non-zero) on a missing
// file: a launch whose environment did not arrive must not start an agent that
// will fail confusingly mid-turn. It names files only — a value never passes
// through this shell.
func envCopyScript(names []string) string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	var b strings.Builder
	b.WriteString("set -e\numask 077\n")
	fmt.Fprintf(&b, "mkdir -p '%s'\nchmod 700 '%s'\n", EnvDir, EnvDir)
	for _, n := range sorted {
		fmt.Fprintf(&b, "cp '%s' '%s'\n", EnvSourcePath(n), EnvFilePath(n))
		fmt.Fprintf(&b, "chmod %o '%s'\n", envFileMode, EnvFilePath(n))
	}
	return b.String()
}

// localVolumeName derives a DNS-1123 volume name from an absolute path.
func localVolumeName(p string) string {
	name := "local-" + strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(p, "/"))
	for strings.Contains(name, "--") {
		name = strings.ReplaceAll(name, "--", "-")
	}
	name = strings.Trim(name, "-")
	if len(name) > 63 {
		name = strings.Trim(name[:63], "-")
	}
	return name
}

// pathWithin reports whether child sits under parent (both clean, absolute).
func pathWithin(parent, child string) bool {
	if parent == "/" {
		return child != "/"
	}
	return strings.HasPrefix(child, parent+"/")
}

// coveredPath reports whether p sits at or under one of roots.
func coveredPath(p string, roots []string) bool {
	for _, r := range roots {
		if p == r || pathWithin(r, p) {
			return true
		}
	}
	return false
}

func boolPtr(b bool) *bool    { return &b }
func int32Ptr(i int32) *int32 { return &i }
func int64Ptr(i int64) *int64 { return &i }
