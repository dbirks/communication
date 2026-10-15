package secrets

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- keyring fixtures ----------------------------------------------------

// newKeyring writes a keyring directory the way api/compose.yaml's keyring-init
// does (a 0700 directory of hex master-key-vN files at mode 0600) so every test
// in this file exercises the same on-disk shape the stack produces, rather than
// an idealized one.
func newKeyring(t *testing.T, generations ...int) *Keyring {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod keyring dir: %v", err)
	}
	writeGenerations(t, dir, generations...)
	kr, err := LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring(%s): %v", dir, err)
	}
	return kr
}

func writeGenerations(t *testing.T, dir string, generations ...int) {
	t.Helper()
	for _, gen := range generations {
		material := make([]byte, dataKeyLen)
		if _, err := rand.Read(material); err != nil {
			t.Fatalf("rand: %v", err)
		}
		path := filepath.Join(dir, fmt.Sprintf("master-key-v%d", gen))
		if err := os.WriteFile(path, []byte(hex.EncodeToString(material)), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
}

func testRef() VersionRef {
	return VersionRef{SecretID: "11111111-2222-3333-4444-555555555555", Version: 1, Slug: "docker-hub-pull"}
}

func secretValue() []byte {
	return []byte("dckr_pat_SENTINEL_value_never_stored_in_clear_text")
}

// --- keyring -------------------------------------------------------------

func TestKeyringLoadsComposeLayout(t *testing.T) {
	kr := newKeyring(t, 1)
	if got := kr.KeyIDs(); len(got) != 1 || got[0] != "master-key-v1" {
		t.Fatalf("KeyIDs() = %v, want [master-key-v1]", got)
	}
	active, err := kr.ActiveKeyID(context.Background())
	if err != nil || active != "master-key-v1" {
		t.Fatalf("ActiveKeyID() = %q, %v", active, err)
	}
	if kr.Dir() == "" {
		t.Fatal("Dir() is empty: doctor needs to name the keyring it loaded")
	}
}

func TestKeyringActiveIsHighestGeneration(t *testing.T) {
	// A rotation pass leaves v2 present while v1 must still open old rows, so
	// "highest generation is active" is the rule that makes D2.4's
	// interrupted-rewrap-resumes true without a config field naming the active
	// generation.
	kr := newKeyring(t, 1, 2, 3)
	active, err := kr.ActiveKeyID(context.Background())
	if err != nil || active != "master-key-v3" {
		t.Fatalf("ActiveKeyID() = %q, %v; want master-key-v3", active, err)
	}
	if _, err := kr.MasterKey("master-key-v1"); err != nil {
		t.Fatalf("old generation must stay readable: %v", err)
	}
}

func TestKeyringRefusesUnusableLayouts(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, dir string)
	}{
		{"group-readable dir", func(t *testing.T, dir string) {
			writeGenerations(t, dir, 1)
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{"world-readable key file", func(t *testing.T, dir string) {
			writeGenerations(t, dir, 1)
			if err := os.Chmod(filepath.Join(dir, "master-key-v1"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"empty keyring", func(*testing.T, string) {}},
		{"stray file", func(t *testing.T, dir string) {
			writeGenerations(t, dir, 1)
			if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"short key", func(t *testing.T, dir string) {
			if err := os.WriteFile(filepath.Join(dir, "master-key-v1"), []byte("00112233"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"non-hex key", func(t *testing.T, dir string) {
			if err := os.WriteFile(filepath.Join(dir, "master-key-v1"), []byte(strings.Repeat("zz", dataKeyLen)), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"symlinked generation", func(t *testing.T, dir string) {
			outside := filepath.Join(t.TempDir(), "real-key")
			if err := os.WriteFile(outside, []byte(strings.Repeat("ab", dataKeyLen)), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(dir, "master-key-v1")); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Chmod(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			tc.setup(t, dir)
			_, err := LoadKeyring(dir)
			if !errors.Is(err, ErrKeyringUnreadable) {
				t.Fatalf("LoadKeyring() error = %v, want ErrKeyringUnreadable", err)
			}
		})
	}
}

func TestKeyringFromEnvUsesEnvNotDatabase(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeGenerations(t, dir, 1)
	t.Setenv(EnvKeyring, dir)
	kr, err := KeyringFromEnv()
	if err != nil {
		t.Fatalf("KeyringFromEnv: %v", err)
	}
	if kr.Dir() != dir {
		t.Fatalf("loaded from %s, want %s", kr.Dir(), dir)
	}
	t.Setenv(EnvKeyring, filepath.Join(dir, "does-not-exist"))
	if _, err := KeyringFromEnv(); !errors.Is(err, ErrKeyringUnreadable) {
		t.Fatalf("missing keyring error = %v, want ErrKeyringUnreadable (ADR-0018 D2.3 is a loud startup failure)", err)
	}
}

func TestUnwrapDataKeyIsPerVersionAndRefusesUnknownGeneration(t *testing.T) {
	kr := newKeyring(t, 1)
	ctx := context.Background()
	ref := testRef()

	k1, err := kr.UnwrapDataKey(ctx, "master-key-v1", ref)
	if err != nil {
		t.Fatalf("UnwrapDataKey: %v", err)
	}
	defer clear(k1)
	if len(k1) != dataKeyLen {
		t.Fatalf("data key length = %d, want %d", len(k1), dataKeyLen)
	}
	// Same row, same key: derivation must be a function of the row, not of the
	// call. A random data key per seal would make rewrap's idempotence test
	// meaningless and would not be recoverable from the keyring at all.
	again, err := kr.UnwrapDataKey(ctx, "master-key-v1", ref)
	if err != nil {
		t.Fatalf("UnwrapDataKey again: %v", err)
	}
	defer clear(again)
	if string(k1) != string(again) {
		t.Fatal("deriving the same version's key twice produced different keys")
	}
	// Different version, different key: this is what makes a v1 ciphertext
	// unreadable as v2 even though both rows name the same generation.
	v2, err := kr.UnwrapDataKey(ctx, "master-key-v1", VersionRef{SecretID: ref.SecretID, Version: 2, Slug: ref.Slug})
	if err != nil {
		t.Fatalf("UnwrapDataKey v2: %v", err)
	}
	defer clear(v2)
	if string(v2) == string(k1) {
		t.Fatal("v1 and v2 share a data key: ADR-0018 D2.2 derives one per version")
	}
	if _, err := kr.UnwrapDataKey(ctx, "master-key-v9", ref); !errors.Is(err, ErrUnknownKeyID) {
		t.Fatalf("unknown generation error = %v, want ErrUnknownKeyID", err)
	}
	if _, err := kr.UnwrapDataKey(ctx, "master-key-v1", VersionRef{SecretID: "not-a-uuid", Version: 1, Slug: "s"}); !errors.Is(err, ErrBadRef) {
		t.Fatal("a malformed ref must not derive anything")
	}
	// The context string is the ADR's, verbatim apart from the separator: a test
	// on it is a test that a future refactor did not silently rekey everything.
	if got := DataKeyContext(ref); got != "communication/secret/v1/"+ref.SecretID+"/1" {
		t.Fatalf("DataKeyContext() = %q", got)
	}
}

// --- envelope ------------------------------------------------------------

func TestSealOpenRoundTrip(t *testing.T) {
	kr := newKeyring(t, 1)
	ctx := context.Background()
	ref := testRef()
	plaintext := secretValue()

	sealed, err := Seal(ctx, kr, ref, plaintext)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if string(sealed.Ciphertext) == string(plaintext) {
		t.Fatal("ciphertext equals plaintext")
	}
	if strings.Contains(string(sealed.Ciphertext), "SENTINEL") ||
		strings.Contains(sealed.AAD, "SENTINEL") ||
		strings.Contains(sealed.ContentSHA256, "SENTINEL") {
		t.Fatal("the value appears somewhere in the sealed row")
	}
	if sealed.KeyID != "master-key-v1" {
		t.Fatalf("KeyID = %q", sealed.KeyID)
	}
	if sealed.AAD != ref.SecretID+"|1|master-key-v1|"+slugDigest(ref.Slug) {
		t.Fatalf("AAD = %q", sealed.AAD)
	}
	if sealed.ContentSHA256 != hex.EncodeToString(sha256Sum(plaintext)) {
		t.Fatalf("ContentSHA256 = %q, want the sha256 of the value", sealed.ContentSHA256)
	}
	value, err := Open(ctx, kr, ref, sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := string(value.Bytes()); got != string(plaintext) {
		t.Fatalf("round trip = %q, want %q", got, plaintext)
	}
	// A second seal of the same plaintext under the same key differs: the nonce
	// is random, so a dump cannot reveal "these two rows held the same secret"
	// by comparing ciphertexts.
	other, err := Seal(ctx, kr, ref, plaintext)
	if err != nil {
		t.Fatalf("Seal again: %v", err)
	}
	if string(other.Ciphertext) == string(sealed.Ciphertext) || string(other.Nonce) == string(sealed.Nonce) {
		t.Fatal("two seals of one value produced identical bytes: the nonce is not random")
	}
}

func TestOpenRefusesEveryOtherRowsBytes(t *testing.T) {
	kr := newKeyring(t, 1)
	ctx := context.Background()
	plaintext := secretValue()
	ref := testRef()
	sealed, err := Seal(ctx, kr, ref, plaintext)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	// The four moves that a database-level attacker has: another version of the
	// same secret, another secret, an edited aad column, and edited ciphertext.
	t.Run("other version", func(t *testing.T) {
		if _, err := Open(ctx, kr, VersionRef{SecretID: ref.SecretID, Version: 2, Slug: ref.Slug}, sealed); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("other secret", func(t *testing.T) {
		other := VersionRef{SecretID: "99999999-2222-3333-4444-555555555555", Version: 1, Slug: ref.Slug}
		if _, err := Open(ctx, kr, other, sealed); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("other slug", func(t *testing.T) {
		other := VersionRef{SecretID: ref.SecretID, Version: 1, Slug: "renamed-slug"}
		if _, err := Open(ctx, kr, other, sealed); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt: the slug digest is bound into the tag", err)
		}
	})
	t.Run("edited aad column", func(t *testing.T) {
		tampered := sealed
		tampered.AAD = ref.SecretID + "|2|master-key-v1|" + slugDigest(ref.Slug)
		if _, err := Open(ctx, kr, ref, tampered); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("edited ciphertext", func(t *testing.T) {
		tampered := sealed
		tampered.Ciphertext = append([]byte(nil), sealed.Ciphertext...)
		tampered.Ciphertext[len(tampered.Ciphertext)-1] ^= 0x01
		if _, err := Open(ctx, kr, ref, tampered); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("edited nonce", func(t *testing.T) {
		tampered := sealed
		tampered.Nonce = append([]byte(nil), sealed.Nonce...)
		tampered.Nonce[0] ^= 0xff
		if _, err := Open(ctx, kr, ref, tampered); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("empty nonce", func(t *testing.T) {
		tampered := sealed
		tampered.Nonce = nil
		if _, err := Open(ctx, kr, ref, tampered); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("error = %v, want ErrDecrypt", err)
		}
	})
	t.Run("unknown generation", func(t *testing.T) {
		// A row whose key file was deleted is unreadable, and must not fall back
		// to the active generation (D2.2: key_id names the generation).
		orphan := sealed
		orphan.KeyID = "master-key-v7"
		orphan.AAD = ref.SecretID + "|1|master-key-v7|" + slugDigest(ref.Slug)
		if _, err := Open(ctx, kr, ref, orphan); !errors.Is(err, ErrUnknownKeyID) {
			t.Fatalf("error = %v, want ErrUnknownKeyID", err)
		}
	})
}

func TestOpenRefusesForeignKeyring(t *testing.T) {
	// The whole point of a master key outside the database: two processes holding
	// the same dump decrypt nothing for each other.
	home := newKeyring(t, 1)
	elsewhere := newKeyring(t, 1)
	ctx := context.Background()
	ref := testRef()
	sealed, err := Seal(ctx, home, ref, secretValue())
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := Open(ctx, elsewhere, ref, sealed); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("error = %v, want ErrDecrypt", err)
	}
}

func TestRotationRewrapsAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeGenerations(t, dir, 1)
	kr, err := LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	ctx := context.Background()
	ref := testRef()
	plaintext := secretValue()
	old, err := SealWith(ctx, kr, "master-key-v1", ref, plaintext)
	if err != nil {
		t.Fatalf("SealWith v1: %v", err)
	}

	// An operator adds master-key-v2 to the keyring and restarts; the rotation
	// pass then walks the old rows (ADR-0018 D2.4).
	writeGenerations(t, dir, 2)
	rotated, err := LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring after rotation: %v", err)
	}
	if active, _ := rotated.ActiveKeyID(ctx); active != "master-key-v2" {
		t.Fatalf("active = %q after rotation", active)
	}
	// Old rows still open under the old key, from the rotated keyring too.
	if _, err := Open(ctx, rotated, ref, old); err != nil {
		t.Fatalf("pre-rotation row must stay readable: %v", err)
	}

	next, changed, err := Rewrap(ctx, rotated, ref, old)
	if err != nil {
		t.Fatalf("Rewrap: %v", err)
	}
	if !changed {
		t.Fatal("Rewrap reported no change under a superseded generation")
	}
	if next.KeyID != "master-key-v2" {
		t.Fatalf("rewrapped under %q, want master-key-v2", next.KeyID)
	}
	value, err := Open(ctx, rotated, ref, next)
	if err != nil {
		t.Fatalf("Open rewrapped: %v", err)
	}
	if got := string(value.Bytes()); got != string(plaintext) {
		t.Fatalf("rewrapped value = %q", got)
	}
	// Idempotence is what makes "an interrupted rewrap resumes" true.
	if _, changed, err := Rewrap(ctx, rotated, ref, next); err != nil || changed {
		t.Fatalf("Rewrap of a current row: changed=%v err=%v", changed, err)
	}
	// And a rewrap that has not happened yet still reads, so the pass can run
	// while the service is serving.
	if _, err := Open(ctx, rotated, ref, old); err != nil {
		t.Fatalf("pre-rotation row after rewrap: %v", err)
	}
}

func TestRewrapZeroesTheIntermediatePlaintext(t *testing.T) {
	// Rewrap is the one path that decrypts *and* re-encrypts inside this
	// package, so it is the path where a forgotten clear() would leave material
	// reachable in a core dump or a heap profile. The observable claim is
	// narrow: the returned Resolution/Sealed holds no plaintext and the value
	// Rewrap opened is not reachable by the caller.
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeGenerations(t, dir, 1, 2)
	kr, err := LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	ctx := context.Background()
	ref := testRef()
	old, err := SealWith(ctx, kr, "master-key-v1", ref, secretValue())
	if err != nil {
		t.Fatalf("SealWith: %v", err)
	}
	next, changed, err := Rewrap(ctx, kr, ref, old)
	if err != nil || !changed {
		t.Fatalf("Rewrap: changed=%v err=%v", changed, err)
	}
	if strings.Contains(string(next.Ciphertext), "SENTINEL") {
		t.Fatal("the rewrapped ciphertext contains the value")
	}
	// The only handle on the intermediate is the *Value Rewrap opened
	// internally, which is not returned; asserting on the public surface is what
	// a caller can actually rely on.
	value, err := Open(ctx, kr, ref, next)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	value.Zero()
	if len(value.Bytes()) != 0 {
		t.Fatal("Zero left a length")
	}
}

// --- Value: the "cannot be serialized" guarantee -------------------------

func TestValueRefusesEverySerializationPath(t *testing.T) {
	ref := testRef()
	value := NewValue(ref, []byte("super-secret-value"))

	if _, err := value.MarshalJSON(); !errors.Is(err, ErrValueNotSerializable) {
		t.Fatalf("MarshalJSON error = %v, want ErrValueNotSerializable", err)
	}
	// The realistic leak: a response struct that carries a value. This is the
	// structural reason "no route returns a value" needs no endpoint audit —
	// the encoder itself fails.
	type leaky struct {
		Slug  string `json:"slug"`
		Value *Value `json:"value"`
	}
	if out, err := marshalToString(leaky{Slug: "s", Value: value}); err == nil {
		t.Fatalf("json.Marshal on a struct holding a value succeeded: %s", out)
	}
	// And the log-line leak: every verb, including the ones that would print
	// bytes.
	for _, format := range []string{"%v", "%s", "%q", "%x", "%#v", "%+v", "%d"} {
		out := fmt.Sprintf(format, value)
		if strings.Contains(out, "super-secret") || strings.Contains(out, "7375706572") {
			t.Fatalf("fmt.Sprintf(%q) leaked: %s", format, out)
		}
	}
	if value.String() == "" || strings.Contains(value.String(), "super") {
		t.Fatalf("String() = %q", value.String())
	}
	if got := string(value.Bytes()); !strings.Contains(got, "super") {
		t.Fatalf("Bytes() must still hand the plaintext to the caller, got %q", got)
	}
	if value.Len() != len("super-secret-value") {
		t.Fatalf("Len() = %d", value.Len())
	}
	value.Zero()
	if value.Bytes() != nil {
		t.Fatal("Zero left the buffer reachable")
	}
	// A nil *Value must not panic: the resolver returns nil on refusal and
	// callers deferring Close/Zero on it are normal.
	var nilValue *Value
	nilValue.Zero()
	if nilValue.Bytes() != nil || nilValue.Len() != 0 || nilValue.String() == "" {
		t.Fatal("nil *Value must behave as an empty value")
	}
	if _, err := nilValue.MarshalJSON(); !errors.Is(err, ErrValueNotSerializable) {
		t.Fatalf("nil *Value MarshalJSON error = %v, want ErrValueNotSerializable", err)
	}
}

// --- small helpers -------------------------------------------------------

func marshalToString(v any) (string, error) {
	var buf strings.Builder
	if err := json.NewEncoder(&buf).Encode(v); err != nil {
		return "", err
	}
	return buf.String(), nil
}
