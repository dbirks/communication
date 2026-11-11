package k8s

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	types "k8s.io/apimachinery/pkg/types"
)

// envVarName is what the child can actually read back as a variable: the POSIX
// identifier shape, narrower than safeKey (which a Secret key and a file name
// also have to satisfy).
var envVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// EnvFile is one launch-environment entry, delivered to the attempt pod as the
// file `env/<NAME>` rather than as a value in a request.
//
// The rule it implements is ADR-0082 Decision 5 and research §2.5, applied to
// the whole environment instead of the credential-shaped part of it: a value in
// a pod spec, in an exec request or in argv is readable by anyone with `get` on
// the object and is copied into API-server request logs. The exec that starts a
// session is a URL whose `command=` query parameters apiserver audit records in
// full, so an `env -i PATH=… HOME=…` script leaked every plain entry there, and
// the split into "plain may travel, credential must not" was only ever as safe
// as that classification. Now nothing travels but names: every value is a key in
// the per-attempt Secret, and the in-pod wrapper (`communication pod-exec`,
// Decision 6) re-reads them from the 0600 files the initContainer wrote.
// Nothing here ever puts a value in a pod spec, an exec request or an argv.
type EnvFile struct {
	// Name is the environment variable the launched agent must see. It doubles
	// as the Secret key and the file name under EnvDir.
	Name string
	// Value is the entry itself. It is never logged: errors from this package
	// name `Name` only, and credential-shaped values are redacted (withoutValues).
	Value []byte
	// Sensitive records that this entry looked like a credential under the
	// rules below, which decides two things: whether an empty value is a bug
	// worth refusing, and whether the value is redacted from error strings.
	Sensitive bool
}

// secretKeySuffixes are environment NAMES whose suffix means "this slot holds a
// credential". The list mirrors the pipeline schema's own secret-name rule
// (internal/pipelines/compiler/secrets.go) and is deliberately a copy rather
// than an import: that package belongs to the schema, this one to the launcher.
//
// The classification no longer decides *delivery* — every entry is delivered as
// a file — it decides redaction and the empty-value refusal. Over-matching stays
// the safe direction: a mis-classified entry only loses redaction, whereas an
// under-classified one prints a secret into the journal and any error that
// carries it.
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

// SensitiveEnvName reports whether an environment entry's VALUE must never be
// echoed into a log line or an error string.
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

// EnvFiles turns the whole launch environment into the entries of the
// per-attempt Secret.
//
// Every entry is delivered as a file, so every name must be usable as a Secret
// key and as a file name; an entry with no `=` is refused rather than silently
// dropped (ProcTransport would hand a nameless entry to execve, and an
// environment assignment cannot carry one). Duplicate names are refused: the
// Secret can hold each key once, and a plan that set PATH twice is a plan nobody
// understands.
func EnvFiles(env []string) ([]EnvFile, error) {
	files := make([]EnvFile, 0, len(env))
	seen := make(map[string]struct{}, len(env))
	for _, kv := range env {
		name, value, ok := strings.Cut(kv, "=")
		if !ok {
			return nil, fmt.Errorf("sandbox/k8s: launch environment entry %q is not NAME=VALUE", kv)
		}
		if !safeKey.MatchString(name) {
			return nil, fmt.Errorf("sandbox/k8s: launch environment name %q cannot be a Secret key or file name", name)
		}
		if !envVarName.MatchString(name) {
			// A file named `CLAUDE.HOME` would project fine and then be a variable
			// no child could read back, so the rule is the shell's, not the
			// volume's: internal/worker's pod-exec wrapper refuses the same names.
			return nil, fmt.Errorf("sandbox/k8s: launch environment name %q is not an environment variable name", name)
		}
		if _, dup := seen[name]; dup {
			return nil, fmt.Errorf("sandbox/k8s: launch environment name %q repeats", name)
		}
		seen[name] = struct{}{}
		sensitive := SensitiveEnvName(name, value)
		if sensitive && value == "" {
			// An empty credential is a bug upstream (the launcher's own readers
			// refuse an empty token file); writing it would hand the agent an
			// empty password and a turn that fails opaquely.
			return nil, fmt.Errorf("sandbox/k8s: credential %q is empty", name)
		}
		files = append(files, EnvFile{Name: name, Value: []byte(value), Sensitive: sensitive})
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("sandbox/k8s: the launch environment is empty: every attempt pod is configured from its files, so there is nothing to deliver")
	}
	return files, nil
}

// EnvFileNames is the projected name set: the Secret's keys and the pod's file
// list, sorted so the built pod spec is deterministic.
func EnvFileNames(files []EnvFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Name)
	}
	sort.Strings(out)
	return out
}

// CredentialNames is the loggable half of the environment: the names that read
// as credentials, never their values.
func CredentialNames(files []EnvFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		if f.Sensitive {
			out = append(out, f.Name)
		}
	}
	sort.Strings(out)
	return out
}

// BuildSecret builds the per-attempt Secret. Its ownerReference is NOT set here:
// the pod's uid only exists after the create, so the caller patches it (see
// OwnerPatch) — which is also why the Secret is created *before* the pod and
// cannot be built with the reference inline.
//
// The data key is the entry's NAME, and the pod projects every key into the
// volume's `env/` directory — the `env/<NAME>` file layout the in-pod wrapper
// reads (EnvSourcePath, EnvFilePath). A key could not carry that path itself:
// Kubernetes Secret keys must match `[-._a-zA-Z0-9]+`, and `/` is not in the set.
func BuildSecret(attemptID, namespace string, files []EnvFile) (*corev1.Secret, error) {
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
	for _, f := range files {
		if !safeKey.MatchString(f.Name) {
			return nil, fmt.Errorf("sandbox/k8s: credential %q cannot be a Secret key or file name", f.Name)
		}
		if _, dup := secret.Data[f.Name]; dup {
			return nil, fmt.Errorf("sandbox/k8s: duplicate credential %q", f.Name)
		}
		if len(f.Value) == 0 && SensitiveEnvName(f.Name, string(f.Value)) {
			// Derived from the name and value again rather than from f.Sensitive,
			// so a hand-built list cannot smuggle an empty password past the rule.
			return nil, fmt.Errorf("sandbox/k8s: credential %q is empty", f.Name)
		}
		// The bytes are copied verbatim: the projection writes them as file
		// content with no shell expansion and no `$(cat …)` trailing-newline
		// stripping, so a value reaching the agent is byte-for-byte what the
		// plan carried.
		secret.Data[f.Name] = append([]byte(nil), f.Value...)
	}
	return secret, nil
}

// withoutValues rewrites an API error so a launch value it happened to echo (a
// patch that included the Secret's body, say) cannot reach a log or an attempt
// detail. Names survive; values do not. Every value is redacted now that every
// entry is delivered as a file, with two carve-outs that keep the diagnostic
// useful: a credential-shaped value is always scrubbed, a plain one only when it
// is long enough that scrubbing cannot mangle the sentence (replacing a `1` or a
// `/usr/bin` wherever it appears would erase the error itself).
func withoutValues(err error, files []EnvFile) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	for _, f := range files {
		if len(f.Value) == 0 || (!f.Sensitive && len(f.Value) < 8) {
			continue
		}
		msg = strings.ReplaceAll(msg, string(f.Value), "<redacted>")
	}
	return errors.New(bounded(msg, 1024))
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
