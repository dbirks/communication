package k8s

import (
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	types "k8s.io/apimachinery/pkg/types"
)

// Credential is one launch-environment entry that was recognised as a secret and
// is therefore delivered as a file instead of a value.
//
// The rule it implements is ADR-0082 Decision 5 and research §2.5: a value in a
// pod spec, in an exec request or in argv is readable by anyone with `get` on the
// object and is copied into API-server request logs, so the plan's credential
// entries — the launcher's OAuth token and per-turn API key (ADR-0040,
// ADR-0059) and the env-mode secret mounts (ADR-0018 D4) — become keys in a
// per-attempt Secret, and the exec re-reads them from the 0600 files the
// initContainer wrote. Nothing here ever puts a value in a pod spec.
type Credential struct {
	// Name is the environment variable the launched agent must see. It doubles
	// as the Secret key and the file name under CredentialDir.
	Name string
	// Value is the secret itself. It is never logged: errors from this package
	// name `Name` only.
	Value []byte
}

// secretKeySuffixes are environment NAMES whose suffix means "this slot holds a
// credential". The list mirrors the pipeline schema's own secret-name rule
// (internal/pipelines/compiler/secrets.go) and is deliberately a copy rather
// than an import: that package belongs to the schema, this one to the launcher.
//
// Over-matching is the safe direction. A mis-classified entry still reaches the
// agent as the same variable — it just arrives as a 0600 file instead of an exec
// argument — whereas an under-classified one travels through the API server in
// plaintext. `HOME`, `PATH`, `TMPDIR`, `XDG_*`, `GIT_AUTHOR_EMAIL` and the
// credential *directory* variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) match
// nothing here.
var secretKeySuffixes = []string{
	"TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE",
	"APIKEY", "API_KEY", "ACCESS_KEY", "SECRET_KEY", "PRIVATE_KEY",
	"SIGNING_KEY", "SESSION_KEY", "ENCRYPTION_KEY", "CLIENT_SECRET",
	"CREDENTIAL", "CREDENTIALS",
}

// tokenValuePrefixes are provider-issued secret shapes whose prefix alone
// identifies the value as a credential, whatever the variable is called
// (the same set the pipeline schema refuses on, reduced to the shapes the
// launchers here actually carry).
var tokenValuePrefixes = []string{
	"sk-ant-", "sk_live_", "sk_test_", "sk-", "ghp_", "gho_", "ghu_", "ghs_",
	"github_pat_", "xoxb-", "xoxp-", "xoxa-", "AKIA", "ASIA", "AIza", "glpat-",
	"npm_", "dckr_pat_", "SG.", "ya29.", "eyJhbGciOi",
}

// SensitiveEnvName reports whether an environment entry must not appear as a
// value in the exec request.
func SensitiveEnvName(name, value string) bool {
	up := strings.ToUpper(strings.TrimSpace(name))
	for _, suffix := range secretKeySuffixes {
		if strings.HasSuffix(up, suffix) || strings.Contains(up, suffix) {
			return true
		}
	}
	v := strings.TrimSpace(value)
	for _, p := range tokenValuePrefixes {
		if strings.HasPrefix(v, p) {
			return true
		}
	}
	return false
}

// SplitEnv divides a launch environment into the entries that may travel in the
// exec request and the credentials that must travel as files.
func SplitEnv(env []string) (plain []string, creds []Credential, err error) {
	for _, kv := range env {
		name, value, ok := strings.Cut(kv, "=")
		if !ok {
			// ProcTransporter would hand this to execve verbatim; an `env`
			// assignment cannot carry a nameless entry, so refuse rather than
			// silently drop a variable the agent needed.
			return nil, nil, fmt.Errorf("sandbox/k8s: launch environment entry %q is not NAME=VALUE", kv)
		}
		if SensitiveEnvName(name, value) {
			if !safeKey.MatchString(name) {
				return nil, nil, fmt.Errorf("sandbox/k8s: credential %q cannot be a Secret key or file name", name)
			}
			creds = append(creds, Credential{Name: name, Value: []byte(value)})
			continue
		}
		plain = append(plain, kv)
	}
	return plain, creds, nil
}

// BuildSecret builds the per-attempt Secret. Its ownerReference is NOT set here:
// the pod's uid only exists after the create, so the caller patches it (see
// OwnerPatch) — which is also why the Secret is created *before* the pod and
// cannot be built with the reference inline.
func BuildSecret(attemptID, namespace string, creds []Credential) (*corev1.Secret, error) {
	name, err := ObjectName(attemptID)
	if err != nil {
		return nil, err
	}
	if namespace == "" {
		return nil, fmt.Errorf("sandbox/k8s: a namespace is required for the attempt Secret")
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				LabelAttempt:   LabelValue(attemptID),
				LabelManagedBy: ManagedByValue,
			},
		},
		// Immutable because the pod reads it once at init and because a Secret
		// that cannot change cannot be swapped under a running attempt.
		Immutable: boolPtr(true),
		Type:      corev1.SecretTypeOpaque,
		Data:      map[string][]byte{},
	}
	for _, c := range creds {
		if !safeKey.MatchString(c.Name) {
			return nil, fmt.Errorf("sandbox/k8s: credential %q cannot be a Secret key or file name", c.Name)
		}
		if _, dup := secret.Data[c.Name]; dup {
			return nil, fmt.Errorf("sandbox/k8s: duplicate credential %q", c.Name)
		}
		if len(c.Value) == 0 {
			// An empty credential is a bug upstream (the launcher's own readers
			// refuse an empty token file); writing it would hand the agent an
			// empty password and a turn that fails opaquely.
			return nil, fmt.Errorf("sandbox/k8s: credential %q is empty", c.Name)
		}
		secret.Data[c.Name] = append([]byte(nil), c.Value...)
	}
	return secret, nil
}

// OwnerPatch is the merge patch that adopts the Secret into the pod, so
// Kubernetes' garbage collector removes the credential object when the attempt
// pod is deleted (ADR-0082 Decision 5, spike S4).
func OwnerPatch(pod *corev1.Pod) ([]byte, error) {
	if pod == nil || pod.UID == "" {
		return nil, fmt.Errorf("sandbox/k8s: an owner reference needs the attempt pod's uid")
	}
	ref := metav1.OwnerReference{
		APIVersion: "v1",
		Kind:       "Pod",
		Name:       pod.Name,
		UID:        pod.UID,
		// Controller=false: the pod does not manage the Secret's lifecycle the way
		// a ReplicaSet manages a Pod, it only owns it for GC.
		Controller: boolPtr(false),
	}
	body, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"ownerReferences": []metav1.OwnerReference{ref}},
	})
	if err != nil {
		return nil, fmt.Errorf("sandbox/k8s: encode owner reference for %s: %w", pod.Name, err)
	}
	return body, nil
}

// OwnerReferencesOf reads the Secret's owners back (used by the tests and by the
// kind script's S4 assertion helper).
func OwnerReferencesOf(secret *corev1.Secret) []metav1.OwnerReference {
	if secret == nil {
		return nil
	}
	return secret.OwnerReferences
}

// PodOwnerRef is the owner reference shape OwnerPatch writes, exposed for tests
// that assert on the value rather than the bytes.
func PodOwnerRef(podName string, uid types.UID) metav1.OwnerReference {
	return metav1.OwnerReference{APIVersion: "v1", Kind: "Pod", Name: podName, UID: uid, Controller: boolPtr(false)}
}
