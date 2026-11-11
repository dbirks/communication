package k8s

import (
	"path"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// The pod spec is the security boundary ADR-0082 Decision 2 describes, so these
// are golden assertions on the built object rather than smoke tests: every field
// the ADR names is checked by name, and the ones it does not name (a service-
// account token, a capability, a privilege escalation) are checked to be absent.

func sampleInput() PodInput {
	return PodInput{
		AttemptID:  "9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
		Namespace:  "communication-agents",
		Image:      "ghcr.io/dbirks/communication-worker:0.9.0",
		NodeName:   "talos-agent-1",
		Claim:      "communication-workspaces",
		ClaimPaths: []string{"/data/workspaces", "/data/repos", "/sandbox-policy"},
		LocalPaths: []string{"/sandbox-home", "/sandbox-selftest"},
		// Every launch-environment entry is delivered as a file; the test names
		// the pair a real agent launch always carries plus a credential.
		EnvNames:        []string{"PATH", "HOME", "OPENAI_API_KEY"},
		SandboxHome:     "/sandbox-home",
		SandboxSelfTest: "/sandbox-selftest",
	}
}

func TestObjectNameIsAttemptPrefixedLowercaseTruncated(t *testing.T) {
	for _, tc := range []struct {
		id   string
		want string
	}{
		{"9F2C4D6E-1A2B-4C3D-8E9F-0A1B2C3D4E5F", "att-9f2c4d6e-1a2b-4c"},
		{"41789603709", "att-41789603709"},
		{"  abc_DEF  ", "att-abc-def"},
	} {
		got, err := ObjectName(tc.id)
		if err != nil {
			t.Fatalf("ObjectName(%q): %v", tc.id, err)
		}
		if got != tc.want {
			t.Errorf("ObjectName(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
	if _, err := ObjectName("   "); err == nil {
		t.Error("ObjectName of an empty id returned no error")
	}
}

func TestBuildPodSecurityContextMatchesTheADR(t *testing.T) {
	pod, err := sampleInput().Pod()
	if err != nil {
		t.Fatalf("Pod: %v", err)
	}
	sc := pod.Spec.SecurityContext
	if sc == nil {
		t.Fatal("pod has no SecurityContext")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Error("runAsNonRoot must be true")
	}
	if sc.RunAsUser == nil || *sc.RunAsUser != 10001 {
		t.Errorf("runAsUser = %v, want 10001", sc.RunAsUser)
	}
	if sc.RunAsGroup == nil || *sc.RunAsGroup != 10001 {
		t.Errorf("runAsGroup = %v, want 10001", sc.RunAsGroup)
	}
	if sc.FSGroup == nil || *sc.FSGroup != 10001 {
		t.Errorf("fsGroup = %v, want 10001", sc.FSGroup)
	}
	if sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Errorf("seccompProfile = %+v, want RuntimeDefault", sc.SeccompProfile)
	}
	if pod.Spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Errorf("restartPolicy = %q, want Never", pod.Spec.RestartPolicy)
	}
	if pod.Spec.NodeName != "talos-agent-1" {
		t.Errorf("nodeName = %q, want the worker's node", pod.Spec.NodeName)
	}
	if pod.Spec.AutomountServiceAccountToken == nil || *pod.Spec.AutomountServiceAccountToken {
		t.Error("automountServiceAccountToken must be false: an agent pod gets no identity")
	}
	if pod.Spec.EnableServiceLinks == nil || *pod.Spec.EnableServiceLinks {
		t.Error("enableServiceLinks must be false: service env would describe the platform to the agent")
	}
	if len(pod.Spec.Containers) != 1 {
		t.Fatalf("containers = %d, want exactly one", len(pod.Spec.Containers))
	}
	c := pod.Spec.Containers[0]
	cs := c.SecurityContext
	if cs == nil || cs.AllowPrivilegeEscalation == nil || *cs.AllowPrivilegeEscalation {
		t.Error("container allowPrivilegeEscalation must be false")
	}
	if cs.Capabilities == nil || len(cs.Capabilities.Drop) != 1 || cs.Capabilities.Drop[0] != "ALL" {
		t.Errorf("container capabilities = %+v, want drop [ALL]", cs.Capabilities)
	}
	if cs.SELinuxOptions != nil || cs.AppArmorProfile != nil || cs.ProcMount != nil {
		t.Error("the ADR names no SELinux/AppArmor/proc override; the pod must not grow one here")
	}
}

func TestBuildPodIdentityEntrypointAndVolumes(t *testing.T) {
	pod, err := sampleInput().Pod()
	if err != nil {
		t.Fatalf("Pod: %v", err)
	}
	if got := pod.Name; got != "att-9f2c4d6e-1a2b-4c" {
		t.Errorf("name = %q", got)
	}
	if got := pod.Labels[LabelAttempt]; got != "9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" {
		t.Errorf("%s = %q, want the full attempt id", LabelAttempt, got)
	}
	if got := pod.Labels[LabelManagedBy]; got != ManagedByValue {
		t.Errorf("%s = %q, want %q", LabelManagedBy, got, ManagedByValue)
	}
	c := pod.Spec.Containers[0]
	if strings.Join(c.Command, " ") != "communication pod-wait" {
		t.Errorf("command = %v, want [communication pod-wait]", c.Command)
	}
	if c.Image != "ghcr.io/dbirks/communication-worker:0.9.0" {
		t.Errorf("image = %q", c.Image)
	}
	if c.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Errorf("imagePullPolicy = %q, want IfNotPresent (the kind script loads a local image)", c.ImagePullPolicy)
	}
	if len(pod.Spec.InitContainers) != 1 || pod.Spec.InitContainers[0].Name != InitEnv {
		t.Fatalf("initContainers = %+v, want the environment copy", pod.Spec.InitContainers)
	}
	init := pod.Spec.InitContainers[0]
	script := strings.Join(init.Args, " ")
	for _, want := range []string{
		"umask 077",
		"chmod 700 '" + EnvDir + "'",
		"chmod 600 '" + EnvFilePath("OPENAI_API_KEY") + "'",
		// Each copy reads the Secret projection at `env/<NAME>` and writes the
		// wrapper's directory at the same relative name.
		"cp '" + EnvSourcePath("OPENAI_API_KEY") + "' '" + EnvFilePath("OPENAI_API_KEY") + "'",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("environment init script missing %q:\n%s", want, script)
		}
	}
	// Only the file NAMES may appear: a value in an init script would be a value
	// in the pod spec, which is the leak ADR-0082 Decision 5 closes.
	if strings.Contains(script, "sk-ant-") || strings.Contains(script, "secret-value") {
		t.Errorf("environment init script carries a value:\n%s", script)
	}

	mounts := map[string]corev1.VolumeMount{}
	for _, m := range c.VolumeMounts {
		mounts[m.MountPath] = m
	}
	for _, p := range []string{"/data/workspaces", "/data/repos", "/sandbox-policy"} {
		m, ok := mounts[p]
		if !ok {
			t.Fatalf("agent container does not mount the claim at %s (the plan names that path)", p)
		}
		if m.Name != VolumeWorkspace {
			t.Errorf("mount at %s is volume %q, want the claim", p, m.Name)
		}
		if want := path.Base(p); m.SubPath != want {
			t.Errorf("mount at %s has subPath %q, want %q (the claim holds the root by its own name)", p, m.SubPath, want)
		}
		if m.ReadOnly {
			t.Errorf("mount at %s is read-only: the worker and the agent both write there", p)
		}
	}
	if _, ok := mounts["/sandbox-home"]; !ok {
		t.Error("nono's HOME must be a pod-private directory, not the worker's")
	}
	if m, ok := mounts[AttemptDir]; !ok || m.Name != VolumeAttempt || !m.ReadOnly {
		t.Errorf("attempt emptyDir mount = %+v (ok=%t): the delivered environment is an input, not a scratch directory", m, ok)
	}
	// The Secret projection itself must never reach the agent container: it is
	// `..data` symlinks at a mode the pod did not choose, and the whole point of
	// the copy is that the session reads 0600 regular files or nothing.
	for _, m := range c.VolumeMounts {
		if m.Name == VolumeEnvSrc {
			t.Errorf("agent container mounts the Secret projection at %s: only the init container may read it", m.MountPath)
		}
	}
	vols := map[string]corev1.Volume{}
	for _, v := range pod.Spec.Volumes {
		vols[v.Name] = v
	}
	if v, ok := vols[VolumeWorkspace]; !ok || v.PersistentVolumeClaim == nil || v.PersistentVolumeClaim.ClaimName != "communication-workspaces" {
		t.Errorf("claim volume = %+v", vols[VolumeWorkspace])
	}
	src := vols[VolumeEnvSrc]
	if src.Secret == nil || src.Secret.SecretName != pod.Name {
		t.Errorf("environment source volume does not name the attempt secret: %+v", src.Secret)
	}
	if len(src.Secret.Items) != 3 {
		t.Errorf("environment source volume projects %d items, want exactly the 3 entries the launch carries", len(src.Secret.Items))
	}
	// Every key is projected as `env/<NAME>`, which is the file the wrapper reads;
	// a Secret key cannot carry that path itself (Kubernetes keys forbid `/`), so
	// the projection is what realises the layout.
	projected := map[string]string{}
	for _, it := range src.Secret.Items {
		projected[it.Key] = it.Path
	}
	for _, name := range []string{"PATH", "HOME", "OPENAI_API_KEY"} {
		if want := EnvFileDir + "/" + name; projected[name] != want {
			t.Errorf("secret key %q projects to %q, want %q", name, projected[name], want)
		}
	}
	if src.Secret.DefaultMode == nil || *src.Secret.DefaultMode != secretFileMode {
		t.Errorf("secret defaultMode = %v, want %o (group-read: the init container is not root)", src.Secret.DefaultMode, secretFileMode)
	}
	if v, ok := vols[VolumeAttempt]; !ok || v.EmptyDir == nil {
		t.Errorf("attempt emptyDir missing: %+v", vols)
	}
}

func TestBuildPodCarriesSandboxDirsButNeverSecrets(t *testing.T) {
	pod, err := sampleInput().Pod()
	if err != nil {
		t.Fatalf("Pod: %v", err)
	}
	env := map[string]string{}
	for _, e := range pod.Spec.Containers[0].Env {
		env[e.Name] = e.Value
	}
	if env["COMMUNICATION_SANDBOX_HOME"] != "/sandbox-home" {
		t.Errorf("COMMUNICATION_SANDBOX_HOME = %q: the in-pod probe runs with the container's environment, not the worker's", env["COMMUNICATION_SANDBOX_HOME"])
	}
	if env["COMMUNICATION_SANDBOX_SELFTEST_DIR"] != "/sandbox-selftest" {
		t.Errorf("COMMUNICATION_SANDBOX_SELFTEST_DIR = %q", env["COMMUNICATION_SANDBOX_SELFTEST_DIR"])
	}
	if len(env) != 2 {
		t.Errorf("the attempt container carries %d environment variables %v; the session's are built from scratch at exec time", len(env), env)
	}
}

func TestPodInputValidateRefusesTheUnshapable(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*PodInput)
		want   string
	}{
		{"no namespace", func(in *PodInput) { in.Namespace = "" }, "COMMUNICATION_AGENT_NAMESPACE"},
		{"no image", func(in *PodInput) { in.Image = "" }, "COMMUNICATION_AGENT_POD_IMAGE"},
		{"no attempt id", func(in *PodInput) { in.AttemptID = "" }, "attempt id is required"},
		{"claim without paths", func(in *PodInput) { in.ClaimPaths = nil }, "names no path"},
		{"paths without a claim", func(in *PodInput) { in.Claim = "" }, "COMMUNICATION_AGENT_WORKSPACE_PVC"},
		{"path with a quote", func(in *PodInput) { in.LocalPaths = []string{"/sandbox'; reboot"} }, "not a clean absolute path"},
		{"nested mounts", func(in *PodInput) {
			in.ClaimPaths = []string{"/data", "/data/workspaces", "/sandbox-policy"}
		}, "sits inside mount"},
		{"delivered-environment mount shadowed", func(in *PodInput) {
			in.LocalPaths = []string{"/sandbox-home", "/sandbox-selftest", EnvDir}
		}, "sits inside mount"},
		{"bad credential name", func(in *PodInput) { in.EnvNames = []string{"BAD NAME"} }, "usable file name"},
		{"no environment names", func(in *PodInput) { in.EnvNames = nil }, "carries no launch environment"},
		{"sandbox home off volume", func(in *PodInput) { in.SandboxHome = "/nowhere" }, "no volume covers"},
	} {
		in := sampleInput()
		tc.mutate(&in)
		err := in.Validate()
		if err == nil {
			t.Errorf("%s: Validate returned no error", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not mention %q", tc.name, err, tc.want)
		}
	}
}

func TestLocalVolumeNamesAreUniqueAndDNSLabels(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range []string{"/sandbox-home", "/sandbox_selftest", "/home/worker/.claude", "/data/x/y"} {
		n := localVolumeName(p)
		if seen[n] {
			t.Fatalf("volume name %q collides (path %s)", n, p)
		}
		seen[n] = true
		if len(n) > 63 {
			t.Errorf("volume name %q exceeds 63 characters", n)
		}
		for _, r := range n {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
				t.Errorf("volume name %q carries %q", n, r)
			}
		}
	}
}
