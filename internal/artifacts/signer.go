package artifacts

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Token scopes separate the two kinds of controlled URL this system mints, so
// a download token can never be replayed as a preview token (or the reverse)
// even with the same deployment key. ADR-0020 Consequences names this
// explicitly: "separate purpose string, same custody".
const (
	// ScopeDownload authorizes a byte fetch on the app origin.
	ScopeDownload = "dl"
	// ScopePreview authorizes one render on the sandboxed preview origin.
	ScopePreview = "pv"
)

// Token errors. Callers map them onto 401 on the preview origin
// (docs/m3-contract.md § 2: "An expired token is 401 on the preview origin; a
// token re-signed for a different artifact id is refused there too").
var (
	// ErrTokenMalformed is any structurally invalid token, including one whose
	// scope is not one of the two known scopes.
	ErrTokenMalformed = errors.New("artifacts: preview token is malformed")
	// ErrTokenSignature is a signature check failure — a token minted with a
	// different key, or edited in transit.
	ErrTokenSignature = errors.New("artifacts: preview token signature is invalid")
	// ErrTokenExpired is a token past its exp.
	ErrTokenExpired = errors.New("artifacts: preview token has expired")
)

// Token is the payload a signature covers. Everything in it is checked on
// verify: binding the digest is what stops a token for artifact A being
// re-pointed at artifact B by someone who can only read the URL (ADR-0020
// Security: "tokens carry the artifact digest, so a token cannot be
// re-pointed at another row").
type Token struct {
	Scope      string
	ArtifactID string
	SHA256     string
	ExpiresAt  time.Time
}

// tokenVersion prefixes every token so a future key rotation or format change
// is a distinguishable thing rather than a signature mismatch.
const tokenVersion = "v1"

// Signer mints and checks controlled-URL tokens: HMAC-SHA256 over a canonical
// string, keyed by a deployment secret (ADR-0020 D1: the local backend's
// Presign and the API's preview tokens are the same mechanism, so the API
// never has to know which backend is configured).
//
// A Signer is safe for concurrent use and holds the only copy of the key worth
// having: it is never serialized, never logged, and its String method says
// nothing about it.
type Signer struct {
	key []byte
}

// NewSigner returns a Signer for secret, which must be at least 32 bytes of
// deployment-generated key material. Anything shorter is refused rather than
// silently weakened — a 4-character "secret" would make the offline guessing
// of a preview token (which authorizes a fetch with no session at all) a real
// attack rather than a theoretical one.
func NewSigner(secret []byte) (*Signer, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("artifacts: signing secret must be at least 32 bytes, got %d", len(secret))
	}
	key := make([]byte, len(secret))
	copy(key, secret)
	return &Signer{key: key}, nil
}

// canonical renders the payload the MAC covers. The separator is ".", which
// none of the members may contain: scope is an enum, the artifact id is a
// uuid, the digest is hex, and exp is decimal seconds — so the encoding is
// unambiguous without any escaping.
func (t Token) canonical() (string, error) {
	if t.Scope != ScopeDownload && t.Scope != ScopePreview {
		return "", fmt.Errorf("%w: unknown token scope %q", ErrTokenMalformed, t.Scope)
	}
	if !uuidPattern.MatchString(t.ArtifactID) {
		return "", fmt.Errorf("%w: token artifact id %q is not a uuid", ErrTokenMalformed, t.ArtifactID)
	}
	if !sha256Pattern.MatchString(t.SHA256) {
		return "", fmt.Errorf("%w: token digest is not 64 hex characters", ErrTokenMalformed)
	}
	if t.ExpiresAt.IsZero() {
		return "", fmt.Errorf("%w: token has no expiry", ErrTokenMalformed)
	}
	return strings.Join([]string{
		tokenVersion, t.Scope, t.ArtifactID, t.SHA256,
		strconv.FormatInt(t.ExpiresAt.UTC().Unix(), 10),
	}, "."), nil
}

// Sign returns the compact token string: <payload-b64url>.<mac-b64url>.
func (s *Signer) Sign(t Token) (string, error) {
	canonical, err := t.canonical()
	if err != nil {
		return "", err
	}
	mac := s.mac(canonical)
	return base64.RawURLEncoding.EncodeToString([]byte(canonical)) + "." +
		base64.RawURLEncoding.EncodeToString(mac), nil
}

// mac is domain-separated by scope: the key that signs downloads is never used
// as-is over a preview payload.
func (s *Signer) mac(canonical string) []byte {
	h := hmac.New(sha256.New, s.key)
	h.Write([]byte("communication/artifact-token/"))
	h.Write([]byte(canonical))
	return h.Sum(nil)
}

// Verify checks the signature and expiry, and returns the payload. now is a
// parameter rather than a time.Now() call so tests (and the two-replica
// acceptance run, where replicas may drift a second) can pin it.
func (s *Signer) Verify(token string, now time.Time) (Token, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 {
		return Token{}, ErrTokenMalformed
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Token{}, ErrTokenMalformed
	}
	want, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Token{}, ErrTokenMalformed
	}
	canonical := string(raw)
	if got := s.mac(canonical); subtle.ConstantTimeCompare(got, want) != 1 {
		return Token{}, ErrTokenSignature
	}
	fields := strings.Split(canonical, ".")
	if len(fields) != 5 || fields[0] != tokenVersion {
		return Token{}, ErrTokenMalformed
	}
	exp, err := strconv.ParseInt(fields[4], 10, 64)
	if err != nil {
		return Token{}, ErrTokenMalformed
	}
	t := Token{
		Scope:      fields[1],
		ArtifactID: fields[2],
		SHA256:     fields[3],
		ExpiresAt:  time.Unix(exp, 0).UTC(),
	}
	if _, err := t.canonical(); err != nil {
		return Token{}, err
	}
	if !now.Before(t.ExpiresAt) {
		return t, ErrTokenExpired
	}
	return t, nil
}
