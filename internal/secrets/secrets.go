// Package secrets is Communication's secret material: envelope encryption with
// a master key that lives outside the database, the Resolver that hands a
// decrypted value to one in-process caller, and the rules that decide whether
// that caller is allowed to have it.
//
// Authority: ADR-0018 (SecretRef materialization and envelope encryption) and
// communication-spec/05-workspaces-security-secrets.md § "Secrets / credentials
// design". The persistence shape is migration 00004; docs/m3-contract.md § 1/§ 4
// is the concrete surface this package is built against.
//
// Two rules are load-bearing here and are enforced by the types, not by
// convention:
//
//  1. No byte of plaintext ever leaves this package inside a struct that could
//     be serialized. The only carrier of plaintext is *Value, which refuses
//     json.Marshal, refuses fmt, and zeroes itself (Value, below). The API
//     surface has no read-value route at all (ADR-0018 D3), so the *way* a
//     value can reach a caller is a function return — never a field.
//  2. Encryption is envelope encryption keyed on the row, not on a caller's
//     good intentions: a data key is derived per secret version (ADR-0018 D2.2)
//     and the GCM additional-data binds secret id, version, key generation and
//     the slug digest (D2.1), so a ciphertext cannot be replayed into another
//     row, another version or another secret.
//
// What this does NOT claim (ADR-0018 Security): it is not tenant isolation, it
// is not secrecy after an agent has read a materialized file, and it is not
// integrity of use — serve and worker both hold the keyring, so the boundary
// this package defends is the database dump, the HTTP surface, the journal and
// artifacts.
package secrets

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Errors every caller of this package has to be able to name.
var (
	// ErrUnknownKeyID is a refused decrypt, never a guess (ADR-0018 D2.2:
	// "key_id names the master-key generation"; the row names the file, and a
	// file that is not in the keyring means the key is gone or the row is not
	// ours).
	ErrUnknownKeyID = errors.New("secrets: unknown key generation")

	// ErrRevoked refuses a materialization of a revoked secret or version
	// (ADR-0018 D2.4). A unit already running keeps what it was launched with:
	// revocation reaches processes through the next materialization, never
	// through memory.
	ErrRevoked = errors.New("secrets: secret version is revoked")

	// ErrDeliveryUnsupported is ADR-0018 clause 8: integration_broker is
	// declared in the schema and built by nobody in M3, so asking for it must
	// fail rather than silently degrade into env delivery.
	ErrDeliveryUnsupported = errors.New("secrets: delivery mode is not implemented")

	// ErrKeyringUnreadable is the loud startup failure ADR-0018 D2.3 asks for:
	// no keyring means no service, not a silent decrypt error.
	ErrKeyringUnreadable = errors.New("secrets: keyring is unreadable")

	// ErrNotAuthorized means this attempt may not have this secret. It carries
	// no reason text beyond the axis that refused, because the axes are
	// policy data and a log line must not become an oracle for what a project
	// was denied.
	ErrNotAuthorized = errors.New("secrets: attempt is not authorized for this secret")

	// ErrValueNotSerializable is what encoding/json gets when something tries
	// to marshal a decrypted value (Value.MarshalJSON). It is the reason the
	// error text exists: a handler that embeds a value in a response body
	// should fail loudly at the encode, not quietly publish the secret.
	ErrValueNotSerializable = errors.New("secrets: a decrypted secret value cannot be serialized")

	// ErrBadRef is a malformed row identity: a secret id that is not a uuid, a
	// version below 1, or an empty slug. Every one of those means the caller
	// built the reference from unvalidated data, and an AAD built from garbage
	// binds nothing.
	ErrBadRef = errors.New("secrets: malformed secret version reference")

	// ErrDecrypt is the one answer a failed open gives: the bytes are not
	// these bytes under this key. The underlying cause is wrapped for the log
	// (which the caller must not print to a client).
	ErrDecrypt = errors.New("secrets: decryption failed")
)

// VersionRef names the exact row a ciphertext belongs to. It is the AAD input
// (ADR-0018 D2.1) and the data-key derivation context (D2.2) at once, which is
// why it is one type rather than three arguments that could be passed in the
// wrong order.
type VersionRef struct {
	// SecretID is the secret_metadata id, canonical lowercase uuid text.
	SecretID string
	// Version is the secret_versions version, 1-based.
	Version int
	// Slug is the secret's slug — bound by digest, never by value: the slug is
	// already project-visible information, and the digest is what stops a
	// ciphertext being moved between two secrets in one project.
	Slug string
}

// Validate rejects the refs that would silently produce a binding AAD.
func (r VersionRef) Validate() error {
	if r.Version < 1 {
		return fmt.Errorf("%w: version %d", ErrBadRef, r.Version)
	}
	if !isCanonicalUUID(r.SecretID) {
		return fmt.Errorf("%w: secret id is not a canonical uuid", ErrBadRef)
	}
	if r.Slug == "" || len(r.Slug) > maxSlugLen || stringsContain(r.Slug, 0) {
		return fmt.Errorf("%w: slug is empty, too long or contains a NUL", ErrBadRef)
	}
	return nil
}

// maxSlugLen matches secret_metadata.slug's practical bound in
// api/openapi.yaml (SecretCreate.slug maxLength 128).
const maxSlugLen = 128

// AAD returns the additional-authenticated-data text for this ref under keyID:
// `secret_id||version||key_id||sha256(slug)` (ADR-0018 D2.1), stored verbatim
// in secret_versions.aad so the binding is auditable without decrypting.
//
// The form is fixed and documented rather than incidental: a later change to
// the separator or the digest is a schema-compatibility event, because every
// existing row's aad has to keep verifying.
func (r VersionRef) AAD(keyID string) (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	if keyID == "" || stringsContain(keyID, 0) {
		return "", fmt.Errorf("%w: key id is empty or contains a NUL", ErrBadRef)
	}
	return fmt.Sprintf("%s|%d|%s|%s", r.SecretID, r.Version, keyID, slugDigest(r.Slug)), nil
}

// slugDigest is the sha256 of the slug, hex. It is not a secret: the slug is
// listed by the API. It is what makes "which secret did this ciphertext
// belong to" part of the AEAD tag.
func slugDigest(slug string) string {
	return hex.EncodeToString(sha256Sum([]byte(slug)))
}

// sha256Sum is the hash behind the slug digest and behind content comparison
// (ADR-0018 D2.5: a retry whose bytes differ from the recorded content_sha256
// is a different write). One helper so "what did we hash" is greppable.
func sha256Sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

// stringsContain reports whether s contains the given byte. Written by hand
// because strings.ContainsRune(s, 0) reads like a typo and is not one.
func stringsContain(s string, b byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return true
		}
	}
	return false
}

// isCanonicalUUID accepts the 8-4-4-4-12 hex form. Duplicated here (and in
// internal/api and internal/store/postgres) deliberately: this package must not
// import either of them, and a binding derived from a malformed id is a binding
// that silently does nothing.
func isCanonicalUUID(s string) bool {
	const hexDigits = "0123456789abcdefABCDEF-"
	if len(s) != 36 {
		return false
	}
	groups := []int{8, 4, 4, 4, 12}
	pos := 0
	for g, n := range groups {
		if g > 0 {
			if pos >= len(s) || s[pos] != '-' {
				return false
			}
			pos++
		}
		if pos+n > len(s) {
			return false
		}
		for j := pos; j < pos+n; j++ {
			if !strings.ContainsRune(hexDigits, rune(s[j])) {
				return false
			}
		}
		pos += n
	}
	return pos == len(s)
}

// Value is a decrypted secret, handed to an in-process caller and to nobody
// else. It is deliberately not a string or a []byte field on some struct:
//
//   - json.Marshal on it (or on anything that embeds it) returns
//     ErrValueNotSerializable, so an accidental `WriteJSON(w, resp)` carrying a
//     value fails at the encoder rather than publishing the secret;
//   - fmt prints a redaction marker for every verb, so `log.Info("%v", v)` and
//     `%s` both say `[redacted]` instead of the value;
//   - Zero overwrites the buffer, and the Resolver zeroes a value it will not
//     return.
//
// Bytes is the accessor: callers that need the plaintext (the materializer
// writing one file, the launcher building one Env entry) take it, and the
// compiler makes them say so.
type Value struct {
	buf []byte
	ref VersionRef
}

// NewValue wraps plaintext for return. It copies nothing: the caller hands over
// ownership and must not keep using buf afterwards.
func NewValue(ref VersionRef, buf []byte) *Value {
	return &Value{buf: buf, ref: ref}
}

// Bytes returns the plaintext. It is the only way to read a Value, and the
// returned slice aliases the buffer: mutating or zeroing it destroys the value.
func (v *Value) Bytes() []byte {
	if v == nil {
		return nil
	}
	return v.buf
}

// Len reports the length without exposing material.
func (v *Value) Len() int {
	if v == nil {
		return 0
	}
	return len(v.buf)
}

// Ref names the row the value came from — the safe half of what a materialized
// file records.
func (v *Value) Ref() VersionRef { return v.ref }

// Zero overwrites the buffer. A value that has been written to a file or into
// a child's environment has done its job; the caller that still holds one owns
// the obligation to zero it.
func (v *Value) Zero() {
	if v == nil {
		return
	}
	clear(v.buf)
	v.buf = nil
}

// String refuses to print material (it also satisfies fmt.Stringer).
func (v *Value) String() string { return "[redacted secret]" }

// GoString does the same for %#v.
func (v *Value) GoString() string { return "&secrets.Value{[redacted]}" }

// Format is the belt to String/GoString's braces: it handles every verb,
// including %q and %x, so no formatting path reaches the buffer.
func (v *Value) Format(s fmt.State, verb rune) {
	_, _ = io.WriteString(s, "[redacted secret]")
	_ = verb
}

// MarshalJSON refuses. This is the structural half of "no route returns a
// value": there is no encoder path from a decrypted secret to a response body.
func (v *Value) MarshalJSON() ([]byte, error) {
	return nil, ErrValueNotSerializable
}

// WriteTo is deliberately absent: if a Value implemented io.WriterTo, a future
// `json.NewEncoder(w).Encode(struct{V *Value})` would have an escape hatch.
