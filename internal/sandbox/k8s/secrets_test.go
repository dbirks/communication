package k8s

import (
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestEnvFilesDeliversEveryEntryAsAFile(t *testing.T) {
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=/data/workspaces/run/abc/home/attempts/9f2c4d6e",
		"XDG_CONFIG_HOME=/data/workspaces/run/abc/home/attempts/9f2c4d6e/.config",
		"TMPDIR=/data/workspaces/run/abc/scratch/attempts/9f2c4d6e/tmp",
		"TERM=xterm-256color",
		"GIT_AUTHOR_EMAIL=worker@communication.invalid",
		"COMMUNICATION_ATTEMPT_ID=9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
		"CLAUDE_CONFIG_DIR=/home/worker/.claude",
		// The two ADR-0040/ADR-0059 channels, plus an ADR-0018 env-mode mount.
		"CLAUDE_CODE_OAUTH_TOKEN=sk-ant-secret-token-value",
		"OPENAI_API_KEY=sk-collective-key",
		"ACME_GATEWAY_PASSWORD=hunter2",
	}
	files, err := EnvFiles(env)
	if err != nil {
		t.Fatalf("EnvFiles: %v", err)
	}
	// Every entry is delivered, not just the credential-shaped ones: the exec
	// request must carry no value at all, so there is no plain half left to send.
	if len(files) != len(env) {
		t.Errorf("entries = %d, want all %d of the plan's environment", len(files), len(env))
	}
	got := map[string]string{}
	for _, f := range files {
		got[f.Name] = string(f.Value)
	}
	for _, name := range []string{"PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "TERM", "GIT_AUTHOR_EMAIL", "COMMUNICATION_ATTEMPT_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ACME_GATEWAY_PASSWORD"} {
		v, ok := got[name]
		if !ok {
			t.Errorf("%s was not delivered", name)
			continue
		}
		if want := strings.TrimPrefix(lookup(env, name), name+"="); v != want {
			t.Errorf("%s value = %q, want the plan's bytes", name, v)
		}
	}
	// The classification survives as the redaction/logging rule: what an operator
	// may see named, and what an empty value would make a bug.
	wantSensitive := []string{"ACME_GATEWAY_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"}
	if creds := CredentialNames(files); strings.Join(creds, ",") != strings.Join(wantSensitive, ",") {
		t.Errorf("credential names = %v, want %v (sorted, values never named)", creds, wantSensitive)
	}
	// A credential *directory* is a location: delivered like everything else, but
	// not one an error string has to scrub.
	for _, f := range files {
		if f.Name == "CLAUDE_CONFIG_DIR" && f.Sensitive {
			t.Error("CLAUDE_CONFIG_DIR names a path, not a secret")
		}
	}
}

func lookup(env []string, name string) string {
	for _, kv := range env {
		if strings.HasPrefix(kv, name+"=") {
			return kv
		}
	}
	return ""
}

func TestEnvFilesRefusesWhatTheChildCannotGetBack(t *testing.T) {
	cases := []struct {
		name string
		env  []string
		want string
	}{
		{"bare name", []string{"PATH"}, "not NAME=VALUE"},
		{"name with a space", []string{"MY TOKEN=secret"}, "Secret key or file name"},
		{"name with a slash", []string{"acme/api=secret"}, "Secret key or file name"},
		{"name that is not an identifier", []string{"CLAUDE.HOME=/x"}, "environment variable name"},
		{"repeated name", []string{"PATH=/bin", "PATH=/usr/bin"}, "repeats"},
		{"empty credential", []string{"ACME_TOKEN="}, "is empty"},
		{"no environment at all", nil, "empty"},
	}
	for _, tc := range cases {
		if _, err := EnvFiles(tc.env); err == nil {
			t.Errorf("%s: EnvFiles accepted it", tc.name)
		} else if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not mention %q", tc.name, err, tc.want)
		}
	}
	// An empty plain entry is the plan's own business (a variable set to nothing),
	// and the attempt pod must be able to carry it.
	files, err := EnvFiles([]string{"PATH=/bin", "ACME_FEATURE="})
	if err != nil {
		t.Fatalf("an empty plain value must be deliverable: %v", err)
	}
	if len(files) != 2 || files[1].Value == nil || string(files[1].Value) != "" {
		t.Errorf("entries = %+v, want ACME_FEATURE delivered as an empty file", files)
	}
}

func TestSensitiveEnvNameShapeRules(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        bool
	}{
		{"CLAUDE_CODE_OAUTH_TOKEN", "", true},
		{"OPENAI_API_KEY", "", true},
		{"GH_TOKEN", "", true},
		{"DB_PASSWORD", "", true},
		{"stripe_api_key", "", true},
		// The value rule catches a credential under a neutral name.
		{"COMMUNICATION_GATEWAY", "ghp_abcdefghijklmnopqrstuvwxyz", true},
		{"PATH", "/usr/bin", false},
		{"HOME", "/home/agent", false},
		{"CLAUDE_CONFIG_DIR", "/home/worker/.claude", false},
		{"GIT_AUTHOR_EMAIL", "worker@communication.invalid", false},
		{"TERM", "xterm-256color", false},
		{"TMPDIR", "/tmp/x", false},
	} {
		if got := SensitiveEnvName(tc.name, tc.value); got != tc.want {
			t.Errorf("SensitiveEnvName(%q, %q) = %t, want %t", tc.name, tc.value, got, tc.want)
		}
	}
}

func TestBuildSecretHoldsOnlyTheLaunchNeeds(t *testing.T) {
	secret, err := BuildSecret("9F2C4D6E-1A2B-4C3D-8E9F-0A1B2C3D4E5F", "communication-agents", []EnvFile{
		{Name: "OPENAI_API_KEY", Value: []byte("sk-collective-key")},
		{Name: "CLAUDE_CODE_OAUTH_TOKEN", Value: []byte("sk-ant-token\n")},
	})
	if err != nil {
		t.Fatalf("BuildSecret: %v", err)
	}
	if secret.Name != "att-9f2c4d6e-1a2b-4c" {
		t.Errorf("name = %q", secret.Name)
	}
	if secret.Namespace != "communication-agents" {
		t.Errorf("namespace = %q", secret.Namespace)
	}
	if len(secret.Data) != 2 {
		t.Errorf("data keys = %v, want exactly the two entries", keysOf(secret.Data))
	}
	// The key is the entry's name: the `env/<NAME>` file layout is the pod's
	// projection (see BuildPodIdentityEntrypointAndVolumes), because a Kubernetes
	// Secret key may not contain a `/`.
	for _, name := range []string{"OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"} {
		if _, ok := secret.Data[name]; !ok {
			t.Errorf("secret has no key %q (keys: %v)", name, keysOf(secret.Data))
		}
	}
	if secret.Immutable == nil || !*secret.Immutable {
		t.Error("the per-attempt secret must be immutable: it is written once and read once")
	}
	if secret.Type != corev1.SecretTypeOpaque {
		t.Errorf("type = %q", secret.Type)
	}
	if string(secret.Data["CLAUDE_CODE_OAUTH_TOKEN"]) != "sk-ant-token\n" {
		t.Error("the value must reach the file exactly as the launcher read it")
	}
	if len(secret.OwnerReferences) != 0 {
		t.Error("the pod's uid does not exist yet at build time; the owner reference is a patch")
	}
	if got := secret.Labels[LabelAttempt]; got != "9f2c4d6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" {
		t.Errorf("%s label = %q", LabelAttempt, got)
	}
}

func TestBuildSecretRefusesEmptyAndMalformedCredentials(t *testing.T) {
	if _, err := BuildSecret("abc", "ns", []EnvFile{{Name: "TOKEN", Value: nil}}); err == nil {
		t.Error("an empty credential must be refused, not delivered as an empty password")
	}
	if _, err := BuildSecret("abc", "ns", []EnvFile{{Name: "bad name", Value: []byte("x")}}); err == nil {
		t.Error("a malformed credential name must be refused")
	}
	if _, err := BuildSecret("abc", "ns", []EnvFile{{Name: "TOKEN", Value: []byte("a")}, {Name: "TOKEN", Value: []byte("b")}}); err == nil {
		t.Error("a duplicate credential must be refused")
	}
	if _, err := BuildSecret("", "ns", nil); err == nil {
		t.Error("an unnamed attempt must be refused")
	}
	if _, err := BuildSecret("abc", "", nil); err == nil {
		t.Error("no namespace must be refused")
	}
	// An empty entry set is constructible at this layer even though EnvFiles
	// refuses it: the builder's contract is "these bytes under these keys".
	s, err := BuildSecret("abc", "ns", nil)
	if err != nil {
		t.Fatalf("a launch with no entries: %v", err)
	}
	if len(s.Data) != 0 {
		t.Errorf("empty entry set produced data %v", keysOf(s.Data))
	}
}

func TestOwnerPatchAdoptsTheSecretIntoThePod(t *testing.T) {
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "att-abc", Namespace: "ns", UID: types.UID("11111111-2222-3333-4444-555555555555")}}
	patch, err := OwnerPatch(pod)
	if err != nil {
		t.Fatalf("OwnerPatch: %v", err)
	}
	var body struct {
		Metadata struct {
			OwnerReferences []metav1.OwnerReference `json:"ownerReferences"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(patch, &body); err != nil {
		t.Fatalf("patch is not JSON: %v (%s)", err, patch)
	}
	refs := body.Metadata.OwnerReferences
	if len(refs) != 1 {
		t.Fatalf("ownerReferences = %d, want 1: %s", len(refs), patch)
	}
	got := refs[0]
	if got.APIVersion != "v1" || got.Kind != "Pod" {
		t.Errorf("owner apiVersion/kind = %q/%q, want v1/Pod", got.APIVersion, got.Kind)
	}
	if got.Name != "att-abc" || got.UID != pod.UID {
		t.Errorf("owner name/uid = %q/%q, want the pod's", got.Name, got.UID)
	}
	if got.Controller != nil && *got.Controller {
		t.Error("a pod is not the Secret's controller; the reference is for GC only")
	}
	// The patch must not smuggle a data section: a merge patch that touched
	// .data would rewrite the credential.
	if strings.Contains(string(patch), `"data"`) {
		t.Errorf("patch touches data: %s", patch)
	}
	if _, err := OwnerPatch(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "att-abc"}}); err == nil {
		t.Error("an owner reference without a uid must be refused, not written as a dangling owner")
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
