package compiler

import (
	"regexp"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Secret literal detection (ADR-0021 § 3 invariant 5, Security; contract § 2.2
// and § 7 C13c).
//
// The spike `secret-literal-in-config` proved a schema cannot express "this
// string is not a credential": `config.env` values are `bindingOrString`
// (§ 9.1 row 13), so any string — including `postgres://u:p@h/d` — passes every
// schema in the repository. The compiler's detector is therefore the boundary,
// and its answer is a BLOCK, not a note.
//
// Two rules govern this file. First, the SAME detector serves every caller: the
// compile-time walk (policy.go secretLiterals) and the redaction scan
// (SecretLiteralValues) both ask detectSecretLiteral, so no response can be
// redacted against a rule the compiler did not apply. Second, nothing here ever
// returns the value: it returns a SHAPE — "credential-bearing URL" — because
// the diagnostic message is echoed to a browser and stored in the draft's
// validation record (ADR-0021 Security: "the product must not echo a value that
// a secret scanner flags").

// credentialURL matches scheme://user:password@host — the canonical inline
// connection secret (DATABASE_URL, REDIS_URL, a DSN in an argument).
var credentialURL = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]{1,31}://[^/?#\s]*:[^/?@\s]+@`)

// embeddedCredential matches a password/API-key assignment inside a DSN, a
// query string or a flag value: `Password=x`, `api_key: x`, `--access-token=x`.
var embeddedCredential = regexp.MustCompile(
	`(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[=:]\s*[^\s;&,"']+`)

// secretKeySuffixes are environment/field NAMES that mean "this slot holds a
// credential". The match is on the upper-cased name's suffix, so
// `APP_PASSWORD`, `stripe_api_key` and `TOKEN` all read the same way. A bare
// `KEY`/`SECRET` word inside prose is not enough — that is what makes this
// narrow enough not to become a false-positive engine.
var secretKeySuffixes = []string{
	"TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE",
	"APIKEY", "API_KEY", "ACCESS_KEY", "SECRET_KEY", "PRIVATE_KEY",
	"SIGNING_KEY", "SESSION_KEY", "ENCRYPTION_KEY", "CLIENT_SECRET",
	"CREDENTIALS",
}

// tokenPrefixes are provider-issued secret shapes whose mere prefix identifies
// the string as a credential. Length is bounded with them so ordinary words
// that start the same way ("sk-etch-knife") are not refused.
var tokenPrefixes = []string{
	"sk-ant-", "sk_live_", "sk_test_", "sk-", "ghp_", "gho_", "ghu_", "ghs_",
	"github_pat_", "xoxb-", "xoxp-", "xoxa-", "AKIA", "ASIA", "AIza", "glpat-",
	"npm_", "dckr_pat_", "SG.", "sony_", "ya29.", "eyJhbGciOi",
}

// pemPrivateKeyMarker is unmistakable and worth its own rule.
const pemPrivateKeyMarker = "PRIVATE KEY-----"

// envLikeNames are the config maps whose keys are variable names, i.e. the
// places a secret-shaped NAME means the author meant a credential.
func envLikeName(name string) bool {
	switch strings.ToLower(name) {
	case "env", "environment", "extraenv", "secretsenv", "variables":
		return true
	}
	return false
}

// secretShapedKey reports whether a map key names a credential slot.
func secretShapedKey(key string) bool {
	up := strings.ToUpper(strings.TrimSpace(key))
	up = strings.NewReplacer("-", "_", " ", "_", ".", "_").Replace(up)
	if up == "DATABASE_URL" || up == "DB_URL" || up == "DSN" || up == "CONNECTION_STRING" {
		return true
	}
	for _, s := range secretKeySuffixes {
		if strings.HasSuffix(up, s) {
			return true
		}
	}
	return false
}

// placeholderValues are the non-secret strings authors legitimately put in a
// credential slot: booleans, mode switches and empty configuration. They are
// exempt from the name-shaped rule only, never from the URL/token rules.
var placeholderValues = map[string]bool{
	"": true, "true": true, "false": true, "none": true, "null": true,
	"optional": true, "required": true, "enabled": true, "disabled": true,
	"yes": true, "no": true, "on": true, "off": true, "1": true, "0": true,
	"string": true, "object": true, "pass": true, "fail": true, "error": true,
	"skipped": true, "strict": true, "lax": true, "auto": true, "manual": true,
}

// detectSecretLiteral decides whether a string VALUE is a literal credential.
// It returns a human-readable SHAPE (never the value) and whether the value is
// secret-shaped. key is the map key the value sits under ("" for a bare string
// in a sequence or scalar slot); envLike says whether that key lives in an
// env-style map.
//
// A binding (${{ … }}) is a reference, not a literal, and is exempt: text
// positions containing secrets.* are refused by the binding rules in
// policy.go, and value positions are recorded as plan secretRefs.
func detectSecretLiteral(key, value string, envLike bool) (string, bool) {
	if strings.Contains(value, "${{") || value == "" {
		return "", false
	}
	if strings.Contains(value, pemPrivateKeyMarker) {
		return "PEM private key", true
	}
	if credentialURL.MatchString(value) {
		return "URL with inline credentials", true
	}
	if embeddedCredential.MatchString(value) {
		return "inline credential assignment", true
	}
	if len(value) >= 16 && !strings.ContainsAny(value, " \t\n") {
		for _, p := range tokenPrefixes {
			if strings.HasPrefix(value, p) {
				return "provider token with prefix " + p + "…", true
			}
		}
	}
	if envLike || secretShapedKey(key) {
		if secretShapedKey(key) && !placeholderValues[strings.ToLower(strings.TrimSpace(value))] &&
			len(strings.TrimSpace(value)) >= 8 {
			return "value written into a secret-shaped field", true
		}
	}
	return "", false
}

// SecretLiteralValues returns every literal the detector flags anywhere in a
// loaded document, so callers can strip the exact substrings from other
// error text (schema messages quote offending scalars, ADR-0021 Security).
// The result is sorted and deduplicated.
func SecretLiteralValues(doc loader.Document) []string {
	root, ok := doc.Value.(canonValue)
	if !ok {
		return nil
	}
	var out []string
	var walkFn func(v canonValue, key string, envLike bool)
	walkFn = func(v canonValue, key string, envLike bool) {
		switch t := v.(type) {
		case map[string]canonValue:
			for k, sub := range t {
				walkFn(sub, k, envLikeName(k) || (envLike && secretShapedKey(k)))
			}
		case []canonValue:
			for _, sub := range t {
				walkFn(sub, key, false)
			}
		case string:
			if _, hit := detectSecretLiteral(key, t, envLike); hit {
				out = append(out, t)
			}
		}
	}
	walkFn(root, "", false)
	sort.Strings(out)
	return dedupe(out)
}

// detectLiteralSecret asks the shared detector about a config string found at
// pointer p, deriving the map key and whether the map is env-like from the
// pointer itself — the same question SecretLiteralValues asks of the tree.
func detectLiteralSecret(p ptr.Pointer, value string) (string, bool) {
	key, envLike := lastSegment(p)
	return detectSecretLiteral(key, value, envLike)
}

// lastSegment is the map key a pointer's final segment names; the walk uses it
// to ask the detector the same question SecretLiteralValues asks.
func lastSegment(p ptr.Pointer) (string, bool) {
	segs := p.Segments()
	if len(segs) == 0 {
		return "", false
	}
	key := segs[len(segs)-1]
	envLike := len(segs) >= 2 && envLikeName(segs[len(segs)-2])
	return key, envLike || envLikeName(key)
}
