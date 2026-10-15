// Package canon implements ADR-0021 § 5 (canonical form) and § 6 (the two
// digests). It is pure: it never touches the database, the network or a
// workspace, so the same document always produces the same bytes here as in
// the CLI that prints a revision digest.
package canon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// DigestScope versions the canonicalization rule itself (ADR-0021 § 6). It is
// stored on every revision row: if these rules ever change, old digests stay
// verifiable and the change needs an ADR.
const DigestScope = "v1alpha1-canonical-1"

// Value is a JSON value tree as the loader produces it: map[string]Value,
// []Value, string, bool, int64, float64, nil.
type Value = any

// Map is the canonical spelling of a JSON object. It is an alias so a document
// the loader produced and one a test wrote are the same type.
type Map = map[string]Value

// Canonicalize returns the canonical bytes of v: every string and key
// NFC-normalized, object keys sorted by UTF-8 byte order, arrays in document
// order, no insignificant whitespace (ADR-0021 § 5).
//
// It does not delete metadata.ui — use CanonicalizeDocument for the bytes that
// carry a revision_digest.
func Canonicalize(v Value) ([]byte, error) {
	var out []byte
	if err := encode(&out, normalize(v)); err != nil {
		return nil, err
	}
	return out, nil
}

// CanonicalizeDocument canonicalizes a pipeline document with the metadata.ui
// subtree deleted: UI layout is served, never digested (ADR-0021 § 5).
func CanonicalizeDocument(doc map[string]Value) ([]byte, error) {
	return Canonicalize(WithoutUI(doc))
}

// WithoutUI returns a copy of doc with metadata.ui removed; the input is not
// modified.
func WithoutUI(doc map[string]Value) map[string]Value {
	meta, ok := doc["metadata"].(map[string]Value)
	if !ok {
		return doc
	}
	if _, has := meta["ui"]; !has {
		return doc
	}
	out := make(map[string]Value, len(doc))
	for k, v := range doc {
		out[k] = v
	}
	stripped := make(map[string]Value, len(meta))
	for k, v := range meta {
		if k != "ui" {
			stripped[k] = v
		}
	}
	out["metadata"] = stripped
	return out
}

// Digest renders ADR-0021 § 6's digest form over bytes: "sha256:" + lowercase hex.
func Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// DigestValue canonicalizes v and digests the bytes.
func DigestValue(v Value) (string, error) {
	b, err := Canonicalize(v)
	if err != nil {
		return "", err
	}
	return Digest(b), nil
}

// DigestDocument digests a document in the form that becomes its
// revision_digest.
func DigestDocument(doc map[string]Value) (string, error) {
	b, err := CanonicalizeDocument(doc)
	if err != nil {
		return "", err
	}
	return Digest(b), nil
}

// normalize applies NFC to every string key and value, recursively.
func normalize(v Value) Value {
	switch t := v.(type) {
	case map[string]Value:
		out := make(map[string]Value, len(t))
		for k, val := range t {
			out[norm.NFC.String(k)] = normalize(val)
		}
		return out
	case []Value:
		out := make([]Value, len(t))
		for i, val := range t {
			out[i] = normalize(val)
		}
		return out
	case string:
		return norm.NFC.String(t)
	default:
		return v
	}
}

func encode(out *[]byte, v Value) error {
	switch t := v.(type) {
	case nil:
		*out = append(*out, "null"...)
	case bool:
		if t {
			*out = append(*out, "true"...)
		} else {
			*out = append(*out, "false"...)
		}
	case string:
		encodeString(out, t)
	// `int` and `int64` encode identically; the loader emits int64, and a hand
	// built tree may emit int. Accepting both keeps the digest the same.
	case int:
		*out = strconv.AppendInt(*out, int64(t), 10)
	case int32:
		*out = strconv.AppendInt(*out, int64(t), 10)
	case int64:
		*out = strconv.AppendInt(*out, t, 10)
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return fmt.Errorf("canon: non-finite number %v", t)
		}
		// ADR-0021 § 5 names Go's shortest round-trip float form, and the reason
		// full RFC 8785 number rewriting was rejected is that encoding/json
		// already gives it. So encoding/json *is* the number rule: delegating to
		// it keeps this byte-identical to what a browser or the store sees
		// (AppendFloat with 'g' would write 1e+15 where json writes
		// 1000000000000000, and two honest encoders would then disagree in a
		// digest).
		n, err := json.Marshal(t)
		if err != nil {
			return fmt.Errorf("canon: cannot encode number %v: %w", t, err)
		}
		*out = append(*out, n...)
	case json.Number:
		*out = append(*out, t.String()...)
	case map[string]Value:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys) // Go string order is UTF-8 byte order
		*out = append(*out, '{')
		for i, k := range keys {
			if i > 0 {
				*out = append(*out, ',')
			}
			encodeString(out, k)
			*out = append(*out, ':')
			if err := encode(out, t[k]); err != nil {
				return err
			}
		}
		*out = append(*out, '}')
	case []Value:
		*out = append(*out, '[')
		for i, val := range t {
			if i > 0 {
				*out = append(*out, ',')
			}
			if err := encode(out, val); err != nil {
				return err
			}
		}
		*out = append(*out, ']')
	default:
		return fmt.Errorf("canon: unsupported value type %T", v)
	}
	return nil
}

// encodeString writes a JSON string. The escape set is fixed so the bytes do
// not depend on a marshalling library's policy choices (Go's default encoder
// HTML-escapes <, > and &, which would make identity depend on that policy).
func encodeString(out *[]byte, s string) {
	*out = append(*out, '"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == '"':
			*out = append(*out, '\\', '"')
		case r == '\\':
			*out = append(*out, '\\', '\\')
		case r == '\n':
			*out = append(*out, '\\', 'n')
		case r == '\r':
			*out = append(*out, '\\', 'r')
		case r == '\t':
			*out = append(*out, '\\', 't')
		case r < 0x20:
			*out = append(*out, fmt.Sprintf("\\u%04x", r)...)
		case r == 0x2028, r == 0x2029:
			// encoding/json escapes these two; matching it is the whole point of
			// the float rule above, and a JSON text-splitting tool breaks on a
			// literal U+2028 inside a string.
			*out = append(*out, fmt.Sprintf("\\u%04x", r)...)
		default:
			*out = append(*out, s[i:i+size]...)
		}
		i += size
	}
	*out = append(*out, '"')
}
