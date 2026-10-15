package artifacts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

// Kind values, exactly the artifacts.kind CHECK enum of migration 00004. A
// checkpoint is ADR-0017's captured diff plus manifest stored as an artifact
// rather than through a second mechanism (ADR-0020 D8) — a capture, not a
// recoverability claim (D-024 stays Open).
const (
	KindMarkdown   = "markdown"
	KindImage      = "image"
	KindHTML       = "html"
	KindJSON       = "json"
	KindPatch      = "patch"
	KindArchive    = "archive"
	KindCheckpoint = "checkpoint"
)

// Sensitivity labels (communication-spec/06-collaboration-identity.md), with
// the ADR-0020 D3 consequences: `restricted` is never previewed and its bytes
// need a maintainer, `secret` has no download path in M3 at all — the label
// exists so a policy can be written against it before the mechanism does.
const (
	SensitivityStandard   = "standard"
	SensitivityInternal   = "internal"
	SensitivityRestricted = "restricted"
	SensitivitySecret     = "secret"
)

// Backend names, the artifacts.storage_backend CHECK enum.
const (
	BackendLocal = "local"
	BackendS3    = "s3"
)

// Errors the backends return. Callers map them onto HTTP statuses and problem
// details; nothing here knows about either.
var (
	// ErrNotFound means the object is not in the backend. It is also the
	// answer for "the row says uploading and no bytes were ever written": the
	// backend has no row-level states, only keys.
	ErrNotFound = errors.New("artifacts: object not found")
	// ErrDigestMismatch means bytes exist under a content-addressed key but
	// are not the bytes that key names — tampering, a half-written file or a
	// corrupted volume. Nothing may serve or delete them silently.
	ErrDigestMismatch = errors.New("artifacts: content digest does not match its key")
	// ErrTooLarge refuses an object over the per-kind cap instead of
	// truncating it (ADR-0020 D2: over-limit is a refusal, not a shortened
	// artifact).
	ErrTooLarge = errors.New("artifacts: object exceeds the size limit for its kind")
	// ErrInvalidInput is a rejected Put: an unknown kind, a media type that
	// does not belong to that kind, an id that is not a uuid (keys are built
	// from server-side ids only), or a bad digest.
	ErrInvalidInput = errors.New("artifacts: invalid input")
	// ErrUnsupported marks a method a backend cannot honour, so a caller
	// learns "this backend does not do that" rather than "it failed".
	ErrUnsupported = errors.New("artifacts: operation not supported by this backend")
)

// Ref points at bytes in a backend. It is what a row's storage_backend +
// storage_key + sha256 + size_bytes become after one read: StorageKey is
// opaque to every other layer and is never serialized to a browser
// (docs/m3-contract.md § 2).
type Ref struct {
	// ID is the artifacts.id this bytes object was written for. Presign needs
	// it because a token is bound to one artifact row, not to a key.
	ID string
	// ProjectID is the authorization scope carried through for logging and
	// for key construction; the backend does not authorize with it.
	ProjectID string
	// StorageBackend is "local" or "s3" — per-row in the table, so a
	// deployment can switch backends without migrating bytes (ADR-0020
	// Migration/rollback).
	StorageBackend string
	// StorageKey is the backend-relative, content-addressed key.
	StorageKey string
	// SHA256 is the lowercase hex digest of the object's bytes.
	SHA256 string
	// SizeBytes is the object length.
	SizeBytes int64
	// MediaType is carried on the Ref so a backend can attach it at Put time
	// and a reader can echo it without a second row lookup.
	MediaType string
}

// Input is a Put. Body is streamed and never buffered whole in memory:
// ADR-0020 D1 says so explicitly, and an archive/checkpoint artifact is
// allowed to be tens of megabytes.
type Input struct {
	// ArtifactID is the artifacts.id the bytes are being written for. It may
	// be empty (the worker's two-phase path writes bytes before the row
	// exists is *not* allowed — see Put's doc); Presign always requires it.
	ArtifactID string
	ProjectID  string

	Name        string
	Kind        string
	MediaType   string
	Sensitivity string

	// MaxBytes overrides the per-kind cap for this Put. Zero uses
	// LimitFor(kind); a value above the hard cap is clamped to it.
	MaxBytes int64

	// Body is read to EOF.
	Body io.Reader
}

// Store is the artifact byte backend (ADR-0020 D1). Implementations must be
// safe for concurrent use and must never interpret a key as a path the caller
// chose.
type Store interface {
	// Put writes Body and returns the content-addressed Ref. It is idempotent
	// on digest: putting the same bytes twice yields the same StorageKey and
	// creates no second object (conformance-tested). It computes the digest
	// while writing, so callers never have to trust a digest they were given.
	Put(ctx context.Context, in Input) (Ref, error)

	// Open returns a reader over the object and its size. The reader reports
	// ErrDigestMismatch if the bytes disagree with the key while being
	// drained, so a corrupted object cannot be streamed to the end without a
	// visible error; ErrNotFound if the key is absent.
	Open(ctx context.Context, ref Ref) (io.ReadCloser, int64, error)

	// Stat verifies the object exists AND hashes to ref.SHA256 before
	// returning. That hash is the point of Stat: it is the only operation that
	// can tell "immutable by construction" from "a file was edited under us"
	// (ADR-0020 Verification 1).
	Stat(ctx context.Context, ref Ref) (Ref, error)

	// Delete removes the object. It exists for the retention sweep only —
	// dedupe means one key can back several rows, so no user-facing route ever
	// calls it (ADR-0020 Consequences). A missing object is not an error.
	Delete(ctx context.Context, ref Ref) error

	// Presign returns a URL that fetches the object without a session, for at
	// most ttl, plus the expiry it carries. Both backends produce a
	// *controlled* URL rather than a public one: S3 uses a SigV4 presigned
	// GET, the local backend an HMAC over (artifact id, digest, expiry) keyed
	// by a deployment secret (ADR-0020 D1). disposition is the
	// Content-Disposition value the fetcher must serve; "" means inline.
	Presign(ctx context.Context, ref Ref, ttl time.Duration, disposition string) (URL string, ExpiresAt time.Time, err error)
}

// Limits, from ADR-0020 D2's examples (25 MB html/json/patch, 10 MB image).
// The caps exist because an artifact is written by a process that has already
// been given a workspace to write into: a size limit is the cheapest thing
// standing between one runaway report and a full volume.
const (
	limitMarkdown   = 5 << 20
	limitImage      = 10 << 20
	limitHTML       = 25 << 20
	limitJSON       = 25 << 20
	limitPatch      = 25 << 20
	limitArchive    = 50 << 20
	limitCheckpoint = 50 << 20

	// HardLimit is the ceiling no Put may exceed, whatever MaxBytes says.
	HardLimit = limitCheckpoint
)

// LimitFor returns the default byte cap for a kind, or 0 for an unknown kind.
func LimitFor(kind string) int64 {
	switch kind {
	case KindMarkdown:
		return limitMarkdown
	case KindImage:
		return limitImage
	case KindHTML, KindJSON, KindPatch:
		return limitHTML
	case KindArchive, KindCheckpoint:
		return limitArchive
	}
	return 0
}

// ValidKind reports whether k is an artifacts.kind value.
func ValidKind(k string) bool { return LimitFor(k) != 0 }

// ValidSensitivity reports whether s is one of 06's labels.
func ValidSensitivity(s string) bool {
	switch s {
	case SensitivityStandard, SensitivityInternal, SensitivityRestricted, SensitivitySecret:
		return true
	}
	return false
}

// Previewable reports whether an artifact may be handed to the sandboxed
// preview origin at all: self-contained HTML or an image, at `standard` or
// `internal` sensitivity (ADR-0020 D3's table — `restricted` never previews,
// and `secret` has no rendering path).
func Previewable(kind, sensitivity string) bool {
	if sensitivity != SensitivityStandard && sensitivity != SensitivityInternal {
		return false
	}
	return kind == KindHTML || kind == KindImage
}

// mediaTypePattern is a deliberately strict token/subtype pair with an
// optional charset parameter: it is what makes a stored `Content-Type` safe to
// echo in a response header later (no CR, no `;` smuggled into another
// directive, no empty type).
var mediaTypePattern = regexp.MustCompile(
	`^[A-Za-z0-9!#$%&'*+.^_` + "`" + `|~-]+/[A-Za-z0-9!#$%&'*+.^_` + "`" + `|~-]+(;charset=[A-Za-z0-9._+-]+)?$`)

var uuidPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// mediaTypePrefixes is the per-kind allowlist of media-type tops. It is coarse
// on purpose: the sharp edges are handled by UnsafeInline, not by an
// ever-growing enumeration.
var mediaTypePrefixes = map[string][]string{
	KindMarkdown:   {"text/"},
	KindHTML:       {"text/html"},
	KindImage:      {"image/"},
	KindJSON:       {"application/json", "application/"},
	KindPatch:      {"text/"},
	KindArchive:    {"application/", "model/", "chemical/"},
	KindCheckpoint: {"application/", "text/"},
}

// Validate checks the fields a Put depends on, before any bytes are read:
// kind ∈ the table enum, sensitivity ∈ 06's labels, media_type well-formed and
// plausible for the kind, and the ids shaped like the server-generated values
// they must be (the key layout has no other defence).
func (in Input) Validate() error {
	if !ValidKind(in.Kind) {
		return fmt.Errorf("%w: unknown kind %q", ErrInvalidInput, in.Kind)
	}
	if !ValidSensitivity(in.Sensitivity) {
		return fmt.Errorf("%w: unknown sensitivity %q", ErrInvalidInput, in.Sensitivity)
	}
	if !uuidPattern.MatchString(in.ProjectID) {
		return fmt.Errorf("%w: project id %q is not a uuid", ErrInvalidInput, in.ProjectID)
	}
	if in.ArtifactID != "" && !uuidPattern.MatchString(in.ArtifactID) {
		return fmt.Errorf("%w: artifact id %q is not a uuid", ErrInvalidInput, in.ArtifactID)
	}
	if !mediaTypePattern.MatchString(in.MediaType) {
		return fmt.Errorf("%w: media type %q is not a type/subtype", ErrInvalidInput, in.MediaType)
	}
	base := in.MediaType
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	if allowed := mediaTypePrefixes[in.Kind]; !hasAnyPrefix(base, allowed) {
		return fmt.Errorf("%w: media type %q does not belong to kind %q",
			ErrInvalidInput, in.MediaType, in.Kind)
	}
	// `kind=html` is a statement about the bytes, not just a label: an html
	// artifact whose media type is not text/html would be delivered as
	// something else and rendered as something else.
	// Two directions of the same rule: `kind=html` claims the bytes are an HTML
	// document, and a document that is not kind=html may not claim to be one —
	// otherwise a `markdown` artifact carrying text/html would be delivered as
	// html by the content route (which keys on media_type) while the preview
	// gate (which keys on kind) had never vetted it.
	if in.Kind == KindHTML && base != "text/html" {
		return fmt.Errorf("%w: kind html requires text/html, got %q", ErrInvalidInput, in.MediaType)
	}
	if in.Kind != KindHTML && UnsafeInline(base) {
		return fmt.Errorf("%w: kind %q may not carry the inline-renderable media type %q",
			ErrInvalidInput, in.Kind, in.MediaType)
	}
	if in.Body == nil {
		return fmt.Errorf("%w: no body", ErrInvalidInput)
	}
	return nil
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// UnsafeInline lists the media types that must never be rendered by the app
// origin, because they can carry script that runs in the caller's session.
// text/html is ADR-0020 D5's rule; image/svg+xml is the same hazard wearing an
// image type (an <svg> document with an <script> is executed when it is
// navigated to, even from an <img> fallback), so it is downgraded the same way
// and the preview origin keeps its "html only" gate.
func UnsafeInline(mediaType string) bool {
	base := strings.ToLower(mediaType)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	switch strings.TrimSpace(base) {
	case "text/html", "application/xhtml+xml", "image/svg+xml":
		return true
	}
	return false
}

// ExtensionFor maps a media type to the suffix used in a key. The suffix is
// cosmetic — the digest is the identity — but keeping it deterministic is what
// lets an operator read a bucket.
func ExtensionFor(mediaType string) string {
	base := strings.ToLower(mediaType)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = strings.TrimSpace(base[:i])
	}
	switch base {
	case "text/html", "application/xhtml+xml":
		return ".html"
	case "text/markdown":
		return ".md"
	case "text/plain":
		return ".txt"
	case "text/x-diff", "text/patch", "text/x-patch":
		return ".patch"
	case "application/json":
		return ".json"
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/svg+xml":
		return ".svg"
	case "application/gzip", "application/x-gzip":
		return ".gz"
	case "application/zip":
		return ".zip"
	case "application/x-tar":
		return ".tar"
	case "application/x-zstd", "application/zstd":
		return ".zst"
	}
	return ".bin"
}

// BuildKey lays a key out as
// <project-id>/<kind>/<first-2-of-digest>/<digest><ext>
// (ADR-0020 D2). Every segment is server-generated and validated: a caller
// cannot route a write outside its own project prefix because it cannot supply
// a key at all, only bytes and ids. The two-character shard keeps a project's
// objects out of one giant directory listing.
func BuildKey(projectID, kind, sha256hex, mediaType string) (string, error) {
	if !uuidPattern.MatchString(projectID) {
		return "", fmt.Errorf("%w: project id %q is not a uuid", ErrInvalidInput, projectID)
	}
	if !ValidKind(kind) {
		return "", fmt.Errorf("%w: unknown kind %q", ErrInvalidInput, kind)
	}
	if !sha256Pattern.MatchString(sha256hex) {
		return "", fmt.Errorf("%w: digest %q is not 64 hex characters", ErrInvalidInput, sha256hex)
	}
	return path.Join(projectID, kind, sha256hex[:2], sha256hex+ExtensionFor(mediaType)), nil
}

// ParseKey reverses BuildKey, and is strict: a key that does not have exactly
// the shape BuildKey writes is rejected, because that shape is the only thing
// preventing a caller that somehow controls a `storage_key` column value from
// naming an arbitrary object.
func ParseKey(key string) (projectID, kind, sha256hex string, err error) {
	parts := strings.Split(key, "/")
	if len(parts) != 4 || !uuidPattern.MatchString(parts[0]) || !ValidKind(parts[1]) {
		return "", "", "", fmt.Errorf("%w: storage key %q is not <project>/<kind>/<shard>/<digest><ext>",
			ErrInvalidInput, key)
	}
	if len(parts[2]) != 2 || parts[3] == "" {
		return "", "", "", fmt.Errorf("%w: storage key %q is not <project>/<kind>/<shard>/<digest><ext>",
			ErrInvalidInput, key)
	}
	digest := parts[3]
	if i := strings.LastIndexByte(digest, '.'); i > 0 {
		digest = digest[:i]
	}
	if !sha256Pattern.MatchString(digest) || digest[:2] != parts[2] {
		return "", "", "", fmt.Errorf("%w: storage key %q does not carry a self-consistent digest",
			ErrInvalidInput, key)
	}
	return parts[0], parts[1], digest, nil
}

// ValidateRef checks the parts of a Ref that a backend has to trust: the key
// must name the digest it is stored under, and both must be well-formed. It is
// called by every backend operation, not only by Put, because Open/Stat/Delete
// take a Ref that came out of a database row — and a row is attacker-editable
// if the database is.
func ValidateRef(ref Ref) error {
	if ref.StorageKey == "" {
		return fmt.Errorf("%w: empty storage key", ErrInvalidInput)
	}
	projectID, _, digest, err := ParseKey(ref.StorageKey)
	if err != nil {
		return err
	}
	if ref.SHA256 == "" {
		return fmt.Errorf("%w: ref carries no digest", ErrInvalidInput)
	}
	if !sha256Pattern.MatchString(ref.SHA256) {
		return fmt.Errorf("%w: digest %q is not 64 hex characters", ErrInvalidInput, ref.SHA256)
	}
	if digest != ref.SHA256 {
		return fmt.Errorf("%w: key names digest %s but ref claims %s",
			ErrDigestMismatch, digest, ref.SHA256)
	}
	if projectID != ref.ProjectID {
		return fmt.Errorf("%w: key names project %s but ref claims %s",
			ErrInvalidInput, projectID, ref.ProjectID)
	}
	if ref.SizeBytes < 0 {
		return fmt.Errorf("%w: negative size", ErrInvalidInput)
	}
	return nil
}

// HexDigest renders a sha256 digest as the lowercase hex the table CHECK and
// the key layout both use.
func HexDigest(sum []byte) string { return hex.EncodeToString(sum) }

// DefaultTokenTTL is how long a minted preview/download token is good for
// (ADR-0020 D5: "default TTL 5 min").
const DefaultTokenTTL = 5 * time.Minute

// MaxTokenTTL bounds what a caller may ask for. A token authorizes a fetch
// with no session behind it, so "permanent" is not a value the system may
// produce even by configuration accident.
const MaxTokenTTL = time.Hour

// ClampTokenTTL bounds a requested token lifetime to [1 minute, MaxTokenTTL],
// so a mis-set configuration shortens a token rather than lengthening it past
// the point where "short-lived" still means anything. The API's preview-token
// route and both backends' Presign share it, so "5 minutes unless configured
// shorter" is one rule instead of two.
func ClampTokenTTL(ttl time.Duration) time.Duration {
	switch {
	case ttl <= 0:
		ttl = DefaultTokenTTL
	case ttl > MaxTokenTTL:
		ttl = MaxTokenTTL
	}
	if ttl < time.Minute {
		ttl = time.Minute
	}
	return ttl
}

// SanitizeFilename makes an artifact's `name` safe to put in a
// Content-Disposition header. The name is metadata chosen by whoever published
// the artifact, so it is not trusted with a header (ADR-0020 Security: "no
// path separators, no control characters").
func SanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f:
			b.WriteRune('_')
		case r == '"' || r == '/' || r == '\\':
			b.WriteRune('_')
		case r > 0x7f:
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), " .")
	if out == "" || out == "." || out == ".." {
		out = "artifact"
	}
	if len(out) > 128 {
		out = out[:128]
	}
	return out
}

// writeSpool streams r into a 0600 file under dir, hashing as it goes, and
// refuses anything over limit.
//
// Why a spool at all: Put has to know the digest before it can name the object
// (the key is the digest), and it must not hold the body in memory. Both
// backends therefore stream to disk/pipe first — the local one renames the
// spool file into place, the S3 one uploads it with a payload hash it can now
// sign with. The spool directory is a configured root, never a temp directory:
// ADR-0019's probe C-TMP1/TMP3 measured that a sandboxed agent can write
// /tmp, and 05's threat model means a file an agent could have planted must
// never be trusted as an artifact later.
func writeSpool(ctx context.Context, dir string, r io.Reader, limit int64) (tmpPath, digest string, size int64, err error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", 0, fmt.Errorf("artifacts: create spool dir: %w", err)
	}
	name, err := spoolName()
	if err != nil {
		return "", "", 0, err
	}
	tmpPath = path.Join(dir, name)
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", "", 0, fmt.Errorf("artifacts: open spool file: %w", err)
	}
	// Any failure after this point must remove the partial file: a half
	// written spool is a disk leak that no row will ever reclaim.
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	h := sha256.New()
	// limit+1 so an oversized body is detected without reading it all.
	n, cpErr := copyCtx(ctx, io.MultiWriter(f, h), io.LimitReader(r, limit+1))
	if cpErr != nil {
		err = cpErr
		return "", "", 0, err
	}
	if n > limit {
		err = fmt.Errorf("%w: %d bytes exceeds the limit of %d", ErrTooLarge, n, limit)
		return "", "", 0, err
	}
	if err = f.Sync(); err != nil {
		return "", "", 0, fmt.Errorf("artifacts: sync spool file: %w", err)
	}
	if err = f.Close(); err != nil {
		return "", "", 0, fmt.Errorf("artifacts: close spool file: %w", err)
	}
	return tmpPath, HexDigest(h.Sum(nil)), n, nil
}

// spoolName returns a name that cannot collide between concurrent Puts and
// cannot be guessed by a process sharing the filesystem.
func spoolName() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("artifacts: spool randomness: %w", err)
	}
	now := time.Now().UTC().UnixNano()
	return fmt.Sprintf(".put-%d-%s", now, hex.EncodeToString(b[:])), nil
}

// copyCtx is io.Copy with a ctx for cancellation, so a client hanging up on a
// 50 MB upload stops the write instead of finishing it.
func copyCtx(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, 32*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		nr, er := src.Read(buf)
		if nr > 0 {
			nw, ew := dst.Write(buf[:nr])
			if nw > 0 {
				total += int64(nw)
			}
			if ew != nil {
				return total, ew
			}
			if nr != nw {
				return total, io.ErrShortWrite
			}
		}
		if er != nil {
			if errors.Is(er, io.EOF) {
				return total, nil
			}
			return total, er
		}
	}
}

// Object is one listing entry for a sweep.
type Object struct {
	Key       string
	SizeBytes int64
	ModTime   time.Time
}

// Sweeper is the extra capability the reconciler's orphan sweep needs — walking
// the bytes under a server-supplied prefix to find objects no row points at.
// It is deliberately not part of Store: the interface handed to a browser-facing
// handler should not offer listing at all (09: no metadata leak, no
// client-supplied keys).
type Sweeper interface {
	List(ctx context.Context, prefix string, fn func(Object) error) error
}
