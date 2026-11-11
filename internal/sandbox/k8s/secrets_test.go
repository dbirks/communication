package k8s

import (
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestSplitEnvSeparatesCredentialsFromLocations(t *testing.T) {
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
	plain, creds, err := SplitEnv(env)
	if err != nil {
		t.Fatalf("SplitEnv: %v", err)
	}
	if len(plain) != 8 {
		t.Errorf("plain = %d entries %v, want the 8 non-credential entries", len(plain), plain)
	}
	got := map[string]string{}
	for _, c := range creds {
		got[c.Name] = string(c.Value)
	}
	if len(got) != 3 {
		t.Fatalf("credentials = %v, want the token, the key and the password", got)
	}
	if got["CLAUDE_CODE_OAUTH_TOKEN"] != "sk-ant-secret-token-value" {
		t.Errorf("token value was altered: %q", got["CLAUDE_CODE_OAUTH_TOKEN"])
	}
	// A credential *directory* is a location, not a secret: it stays in the exec
	// environment, or the launcher would be pointed at nothing.
	for _, name := range []string{"CLAUDE_CONFIG_DIR", "PATH", "HOME", "COMMUNICATION_ATTEMPT_ID", "GIT_AUTHOR_EMAIL"} {
		found := false
		for _, kv := range plain {
			if strings.HasPrefix(kv, name+"=") {
				found = true
			}
		}
		if !found {
			t.Errorf("%s must stay a plain entry (it names a path or an id, not a secret)", name)
		}
	}
	for _, name := range []string{"CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ACME_GATEWAY_PASSWORD"} {
		for _, kv := range plain {
			if strings.HasPrefix(kv, name+"=") {
				t.Errorf("%s leaked into the plain environment", name)
			}
		}
	}
}

func TestSplitEnvRefusesWhatTheChildCannotGetBack(t *testing.T) {
	if _, _, err := SplitEnv([]string{"PATH"}); err == nil {
		t.Error("a bare name (no =) must be refused: it would silently vanish from the child's environment")
	}
	// An env name that cannot be a file name cannot be delivered as a file, so it
	// must not be quietly classified as one.
	if _, _, err := SplitEnv([]string{"MY TOKEN=secret"}); err == nil {
		t.Error("a credential name that is not a usable file name must be refused")
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
	secret, err := BuildSecret("9F2C4D6E-1A2B-4C3D-8E9F-0A1B2C3D4E5F", "communication-agents", []Credential{
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
		t.Errorf("data keys = %v, want exactly the two credentials", keysOf(secret.Data))
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
	if _, err := BuildSecret("abc", "ns", []Credential{{Name: "TOKEN", Value: nil}}); err == nil {
		t.Error("an empty credential must be refused, not delivered as an empty password")
	}
	if _, err := BuildSecret("abc", "ns", []Credential{{Name: "bad name", Value: []byte("x")}}); err == nil {
		t.Error("a malformed credential name must be refused")
	}
	if _, err := BuildSecret("abc", "ns", []Credential{{Name: "TOKEN", Value: []byte("a")}, {Name: "TOKEN", Value: []byte("b")}}); err == nil {
		t.Error("a duplicate credential must be refused")
	}
	if _, err := BuildSecret("", "ns", nil); err == nil {
		t.Error("an unnamed attempt must be refused")
	}
	if _, err := BuildSecret("abc", "", nil); err == nil {
		t.Error("no namespace must be refused")
	}
	// No credentials at all is legal: not every launch carries one.
	s, err := BuildSecret("abc", "ns", nil)
	if err != nil {
		t.Fatalf("a launch with no credentials: %v", err)
	}
	if len(s.Data) != 0 {
		t.Errorf("empty credential set produced data %v", keysOf(s.Data))
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
