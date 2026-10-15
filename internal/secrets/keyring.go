package secrets

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// EnvKeyring names the one place the master key is configured (ADR-0018 D2.3):
// serve and worker both point it at the same keyring, and it is never a value
// that could have been stored in the database it protects.
const EnvKeyring = "COMMUNICATION_SECRET_KEYRING"

// DefaultKeyring is the path api/compose.yaml and worker/compose.yaml mount the
// keyring volume at, so an out-of-the-box stack needs no environment beyond the
// mount.
const DefaultKeyring = "/var/lib/communication/keys"

// dataKeyLen is AES-256-GCM's key length: 32 bytes, derived per version rather
// than stored per version (ADR-0018 D2.2).
const dataKeyLen = 32

// KeyProvider is ADR-0018 D2.5's seam: the file-backed keyring is one provider
// and a KMS is another. It is the only way to turn a row's key_id into keying
// material, and it takes the row identity as an argument because that identity
// is half of what the key is.
//
// Deviation from the ADR's literal signature, `UnwrapDataKey(key_id, wrapped)`:
// migration 00004 has no wrapped-data-key column — secret_versions stores
// key_id, nonce, ciphertext, aad and content_sha256 only — because D2.2 settled
// on deriving each version's data key from the generation's master key. So the
// provider is handed the derivation context instead of a wrapped blob. A KMS
// provider that really wraps keys needs a new column and an ADR, not a new
// method on this interface.
type KeyProvider interface {
	// ActiveKeyID returns the generation new seals use.
	ActiveKeyID(ctx context.Context) (string, error)
	// UnwrapDataKey returns the 32-byte key that seals or opens ref under
	// keyID. An unknown keyID is ErrUnknownKeyID, never a fallback to the
	// active generation: a row written under a key the process cannot name is
	// unreadable, and pretending otherwise would silently rekey rows on read.
	UnwrapDataKey(ctx context.Context, keyID string, ref VersionRef) ([]byte, error)
}

// keyFileName is the keyring file naming scheme the stack's keyring-init writes:
// master-key-vN, one generation per file.
var keyFileName = regexp.MustCompile(`^master-key-v([0-9]{1,9})$`)

// Keyring is the file-backed KeyProvider: a directory of master-key generations,
// read once at startup, with the highest generation active for new seals and
// every generation still able to open the rows written under it.
//
// It is not a cache of plaintexts and it is not a secret store: it holds the
// keys that make the database's ciphertexts readable, which is exactly why the
// database dump is the thing this defends (ADR-0018 Security).
type Keyring struct {
	dir    string
	keys   map[string][]byte
	active string
	ids    []string
}

// LoadKeyring reads every generation in dir. It fails loudly — ErrKeyringUnreadable
// — rather than starting a service that could accept writes it can never read
// back (ADR-0018 D2.3: "missing keyring at startup is a loud failure").
//
// dir must not be reachable by group or other (0700, files 0600): the keyring's
// protection model is the filesystem's, and a world-readable keyring makes the
// envelope encryption decorative. That check is deliberate even though it can be
// worked around by an attacker who already owns the host: ADR-0018 Security says
// outright this is not a tenant boundary.
func LoadKeyring(dir string) (*Keyring, error) {
	if dir == "" {
		return nil, fmt.Errorf("%w: no directory given", ErrKeyringUnreadable)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrKeyringUnreadable, dir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: %s is not a directory", ErrKeyringUnreadable, dir)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return nil, fmt.Errorf("%w: %s is mode %04o, must not be accessible to group or other", ErrKeyringUnreadable, dir, perm)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrKeyringUnreadable, dir, err)
	}
	k := &Keyring{dir: dir, keys: make(map[string][]byte, len(entries))}
	highest := -1
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			// A symlinked generation is how a keyring ends up reading a file
			// nobody intended to publish; the keyring is a flat directory.
			return nil, fmt.Errorf("%w: %s: %s is a directory or symlink, not a key file", ErrKeyringUnreadable, dir, name)
		}
		match := keyFileName.FindStringSubmatch(name)
		if match == nil {
			// Unreadable strays are refused rather than skipped: a skipped file
			// is a lost generation, and "lost" is only tolerable when an
			// operator said so.
			return nil, fmt.Errorf("%w: %s: %s does not match master-key-vN", ErrKeyringUnreadable, dir, name)
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrKeyringUnreadable, filepath.Join(dir, name), err)
		}
		if fi, err := entry.Info(); err == nil {
			if perm := fi.Mode().Perm(); perm&0o077 != 0 {
				return nil, fmt.Errorf("%w: %s is mode %04o, must not be readable by group or other", ErrKeyringUnreadable, filepath.Join(dir, name), perm)
			}
		}
		master, err := parseMasterKey(raw)
		if err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrKeyringUnreadable, filepath.Join(dir, name), err)
		}
		k.keys[name] = master
		k.ids = append(k.ids, name)
		gen, err := strconv.Atoi(match[1])
		if err != nil {
			clear(master)
			return nil, fmt.Errorf("%w: %s: unparsable generation: %v", ErrKeyringUnreadable, name, err)
		}
		if gen > highest {
			highest = gen
			k.active = name
		}
	}
	if len(k.ids) == 0 {
		return nil, fmt.Errorf("%w: %s holds no master-key-vN files", ErrKeyringUnreadable, dir)
	}
	sort.Strings(k.ids)
	return k, nil
}

// KeyringFromEnv loads the keyring the process was configured with, defaulting
// to the path the compose stack mounts (ADR-0018 D2.3).
func KeyringFromEnv() (*Keyring, error) {
	dir := strings.TrimSpace(os.Getenv(EnvKeyring))
	if dir == "" {
		dir = DefaultKeyring
	}
	return LoadKeyring(dir)
}

// parseMasterKey accepts the hex form api/compose.yaml's keyring-init writes and
// refuses anything that is not exactly one AES-256 key.
func parseMasterKey(raw []byte) ([]byte, error) {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return nil, errors.New("key file is empty")
	}
	master, err := hex.DecodeString(text)
	if err != nil {
		return nil, fmt.Errorf("key file is not hex: %w", err)
	}
	if len(master) != dataKeyLen {
		clear(master)
		return nil, fmt.Errorf("key file holds %d bytes, want %d", len(master), dataKeyLen)
	}
	return master, nil
}

// Dir reports where the keyring was loaded from, for `doctor` and for a startup
// log line that must name the file without naming its contents.
func (k *Keyring) Dir() string { return k.dir }

// KeyIDs lists the generations this keyring can open, sorted, for the
// compatibility matrix and for doctor's "exactly one active generation" check.
func (k *Keyring) KeyIDs() []string {
	out := make([]string, len(k.ids))
	copy(out, k.ids)
	return out
}

// ActiveKeyID implements KeyProvider.
func (k *Keyring) ActiveKeyID(_ context.Context) (string, error) {
	if k.active == "" {
		return "", ErrKeyringUnreadable
	}
	return k.active, nil
}

// MasterKey returns the generation's key material. Exported because a rotation
// pass and the KMS-provider test need to reason about it; deliberately not part
// of KeyProvider, so a caller cannot ask for material without naming a row.
func (k *Keyring) MasterKey(keyID string) ([]byte, error) {
	master, ok := k.keys[keyID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownKeyID, keyID)
	}
	return master, nil
}

// UnwrapDataKey implements KeyProvider by deriving the version's key
// (ADR-0018 D2.2):
//
//	HKDF-SHA256(master_key, "communication/secret/v1/" + secret_id + "/" + version)
//
// The returned slice is the caller's to zero; Envelope does so on every path.
func (k *Keyring) UnwrapDataKey(_ context.Context, keyID string, ref VersionRef) ([]byte, error) {
	master, err := k.MasterKey(keyID)
	if err != nil {
		return nil, err
	}
	if err := ref.Validate(); err != nil {
		return nil, err
	}
	info := DataKeyContext(ref)
	key, err := hkdf.Key(sha256.New, master, nil, info, dataKeyLen)
	if err != nil {
		return nil, fmt.Errorf("secrets: derive data key: %w", err)
	}
	return key, nil
}

// DataKeyContext is the HKDF info string, spelled out in one function so
// internal/secrets has exactly one answer to "what context derived this key"
// (ADR-0018 D2.2). Changing it is changing every existing row's readability, so
// it is a compatibility-table event, not a refactor.
func DataKeyContext(ref VersionRef) string {
	return "communication/secret/v1/" + ref.SecretID + "/" + strconv.Itoa(ref.Version)
}

// Seal encrypts plaintext for ref under keyID and returns exactly the columns
// secret_versions stores. The plaintext buffer is not modified: the caller owns
// zeroing it (Envelope.Seal zeroes only what it copied).
func Seal(ctx context.Context, p KeyProvider, ref VersionRef, plaintext []byte) (Sealed, error) {
	keyID, err := p.ActiveKeyID(ctx)
	if err != nil {
		return Sealed{}, err
	}
	return SealWith(ctx, p, keyID, ref, plaintext)
}

// SealWith is Seal with the generation named, which is what a rotation pass
// needs and what a test uses to write under an old generation.
func SealWith(ctx context.Context, p KeyProvider, keyID string, ref VersionRef, plaintext []byte) (Sealed, error) {
	if err := ref.Validate(); err != nil {
		return Sealed{}, err
	}
	if plaintext == nil {
		return Sealed{}, fmt.Errorf("secrets: refuse to seal a nil plaintext: an empty secret is an empty byte slice")
	}
	aad, err := ref.AAD(keyID)
	if err != nil {
		return Sealed{}, err
	}
	key, err := p.UnwrapDataKey(ctx, keyID, ref)
	if err != nil {
		return Sealed{}, err
	}
	defer clear(key)
	if len(key) != dataKeyLen {
		return Sealed{}, fmt.Errorf("secrets: provider returned a %d-byte data key, want %d", len(key), dataKeyLen)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return Sealed{}, fmt.Errorf("secrets: aes: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Sealed{}, fmt.Errorf("secrets: gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return Sealed{}, fmt.Errorf("secrets: nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, []byte(aad))
	return Sealed{
		KeyID:         keyID,
		Nonce:         nonce,
		Ciphertext:    ciphertext,
		AAD:           aad,
		ContentSHA256: hex.EncodeToString(sha256Sum(plaintext)),
	}, nil
}

// Open decrypts a stored version and returns it as a *Value: the caller gets
// the bytes and the obligation to zero them, and nothing that could be put in a
// response body.
//
// The aad column is checked against the row identity before the tag is even
// attempted, because the two failures mean different things to an operator: a
// mismatched aad is a moved or edited row, a failed tag is a wrong key.
func Open(ctx context.Context, p KeyProvider, ref VersionRef, sealed Sealed) (*Value, error) {
	if err := ref.Validate(); err != nil {
		return nil, err
	}
	want, err := ref.AAD(sealed.KeyID)
	if err != nil {
		return nil, err
	}
	if sealed.AAD != want {
		return nil, fmt.Errorf("secrets: aad does not match this row: stored %q, expected %q: %w", sealed.AAD, want, ErrDecrypt)
	}
	if len(sealed.Nonce) == 0 || len(sealed.Ciphertext) == 0 {
		return nil, fmt.Errorf("secrets: empty nonce or ciphertext: %w", ErrDecrypt)
	}
	key, err := p.UnwrapDataKey(ctx, sealed.KeyID, ref)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("secrets: aes: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secrets: gcm: %w", err)
	}
	if len(sealed.Nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("secrets: nonce is %d bytes, want %d: %w", len(sealed.Nonce), gcm.NonceSize(), ErrDecrypt)
	}
	plain, err := gcm.Open(nil, sealed.Nonce, sealed.Ciphertext, []byte(want))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrDecrypt, err)
	}
	return &Value{buf: plain, ref: ref}, nil
}

// Sealed is one secret_versions row's worth of ciphertext material. It is safe
// to log, to store and to return: it holds no plaintext, and ContentSHA256 is a
// digest of the value, not the value (ADR-0018 D2.5).
type Sealed struct {
	KeyID         string
	Nonce         []byte
	Ciphertext    []byte
	AAD           string
	ContentSHA256 string
}

// Rewrap re-seals an existing version under the provider's active generation and
// reports whether anything changed. It is the rotation hook (ADR-0018 D2.4): a
// bounded forward pass calls it per row, and the caller writes the new
// ciphertext back.
//
// The intermediate plaintext is zeroed here rather than handed to the caller, so
// a rewrap cannot leak material by accident. Rewrapping a row that is already
// under the active key is a no-op: the pass is idempotent, which is what makes
// "an interrupted rewrap resumes" true.
func Rewrap(ctx context.Context, p KeyProvider, ref VersionRef, sealed Sealed) (Sealed, bool, error) {
	active, err := p.ActiveKeyID(ctx)
	if err != nil {
		return Sealed{}, false, err
	}
	if sealed.KeyID == active {
		return sealed, false, nil
	}
	value, err := Open(ctx, p, ref, sealed)
	if err != nil {
		return Sealed{}, false, err
	}
	defer value.Zero()
	next, err := SealWith(ctx, p, active, ref, value.Bytes())
	if err != nil {
		return Sealed{}, false, fmt.Errorf("secrets: rewrap %s v%d: %w", ref.SecretID, ref.Version, err)
	}
	return next, true, nil
}
