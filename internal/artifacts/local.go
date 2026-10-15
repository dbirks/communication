package artifacts

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// LocalConfig configures the dev/lab backend: a directory that the worker
// mounts read-write and every API replica mounts read-only (compose.yml's
// `artifacts` volume, ADR-0020 D2).
type LocalConfig struct {
	// Root is the artifact root, e.g. /artifacts. Absolute, `..`-free and not
	// a temp directory — see RejectTempRoot for why that is a rule and not a
	// style preference.
	Root string
	// SpoolDir defaults to <Root>/.spool. It must live on the same filesystem
	// as Root so Put's rename is atomic; a separate spool on another filesystem
	// would turn the rename into a copy with a window in which two processes
	// see two different states.
	SpoolDir string
	// ReadOnly is what an API replica sets, because its mount is `ro`: a
	// write attempt must answer "this backend cannot write" rather than
	// discovering EROFS three syscalls deep.
	ReadOnly bool
	// BaseURL and Signer are what Presign needs; either missing makes Presign
	// return ErrUnsupported rather than mint a URL nobody can check.
	BaseURL string
	Signer  *Signer
}

// Local is the content-addressed filesystem backend.
type Local struct {
	root     string
	spoolDir string
	readOnly bool
	baseURL  string
	signer   *Signer
}

var _ Store = (*Local)(nil)

// NewLocal validates cfg and returns a backend. It does not create the root: a
// deployment that expects an existing volume must fail loudly when it is not
// mounted (ADR-0020 Consequences: "a mis-mounted replica is a readiness
// failure, not a runtime 500"), so availability is checked by the caller via
// Stat/health rather than assumed here.
func NewLocal(cfg LocalConfig) (*Local, error) {
	if cfg.Root == "" {
		return nil, fmt.Errorf("%w: no artifact root", ErrInvalidInput)
	}
	if !path.IsAbs(cfg.Root) {
		return nil, fmt.Errorf("%w: artifact root %q is not absolute", ErrInvalidInput, cfg.Root)
	}
	if err := RejectTempRoot(cfg.Root); err != nil {
		return nil, err
	}
	spool := cfg.SpoolDir
	if spool == "" {
		spool = path.Join(cfg.Root, ".spool")
	}
	if err := RejectTempRoot(spool); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path.Clean(spool), path.Clean(cfg.Root)+"/") && path.Clean(spool) != path.Clean(cfg.Root) {
		return nil, fmt.Errorf("%w: spool dir %q is outside the artifact root %q",
			ErrInvalidInput, spool, cfg.Root)
	}
	return &Local{
		root:     path.Clean(cfg.Root),
		spoolDir: path.Clean(spool),
		readOnly: cfg.ReadOnly,
		baseURL:  strings.TrimRight(cfg.BaseURL, "/"),
		signer:   cfg.Signer,
	}, nil
}

// tempRoots are the directories a sandboxed agent can write into (probe
// C-TMP1/C-TMP3 in docs/compatibility/M3-PROBES.md: nono's default layered
// profile grants /tmp write, and denying it at profile level does not beat the
// default). An artifact root or spool anywhere under one of them would mean a
// file the agent could have planted is later trusted as a published artifact,
// which is the ADR-0019 P9/N1 prohibition restated for bytes.
var tempRoots = []string{"/tmp", "/var/tmp", "/dev/shm"}

// RejectTempRoot reports whether p is, or is under, one of those directories.
func RejectTempRoot(p string) error {
	clean := path.Clean(p)
	for _, t := range tempRoots {
		if clean == t || strings.HasPrefix(clean, t+"/") {
			return fmt.Errorf("%w: %q is under %s, which a sandboxed agent can write (ADR-0019 P9)",
				ErrInvalidInput, p, t)
		}
	}
	if strings.Contains(p, "..") {
		return fmt.Errorf("%w: %q contains a traversal segment", ErrInvalidInput, p)
	}
	return nil
}

// Backend reports the artifacts.storage_backend value rows written against
// this store must carry.
func (*Local) Backend() string { return BackendLocal }

// Put streams the body to a spool file, learns its digest, and renames it into
// the content-addressed key. The rename is the atomic step: a reader either
// sees the complete object or sees nothing, never a half-written report —
// which is why the staging file is not simply written in place.
func (l *Local) Put(ctx context.Context, in Input) (Ref, error) {
	if err := in.Validate(); err != nil {
		return Ref{}, err
	}
	if l.readOnly {
		return Ref{}, fmt.Errorf("%w: this replica mounts the artifact root read-only", ErrUnsupported)
	}
	limit := putLimit(in)
	tmpPath, digest, size, err := writeSpool(ctx, l.spoolDir, in.Body, limit)
	if err != nil {
		return Ref{}, err
	}
	defer os.Remove(tmpPath) // no-op once the rename succeeded

	key, err := BuildKey(in.ProjectID, in.Kind, digest, in.MediaType)
	if err != nil {
		return Ref{}, err
	}
	dst, err := l.resolve(key)
	if err != nil {
		return Ref{}, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return Ref{}, fmt.Errorf("artifacts: create object dir: %w", err)
	}
	ref := Ref{
		ID: in.ArtifactID, ProjectID: in.ProjectID, StorageBackend: BackendLocal,
		StorageKey: key, SHA256: digest, SizeBytes: size, MediaType: in.MediaType,
	}
	if existing, err := os.Stat(dst); err == nil && existing.Mode().IsRegular() {
		// Idempotent on digest: same content, same key, no second object. The
		// size is re-checked so a key that somehow points at other bytes is
		// reported instead of quietly reused.
		if existing.Size() != size {
			return Ref{}, fmt.Errorf("%w: %s exists with size %d, Put wrote %d",
				ErrDigestMismatch, key, existing.Size(), size)
		}
		return ref, nil
	}
	// Objects are written read-only (0444): the same bytes can back several
	// rows, so no writer may hold a handle that lets it rewrite them in place,
	// and a tamper becomes an unlink-and-recreate rather than an append.
	if err := os.Chmod(tmpPath, 0o444); err != nil {
		return Ref{}, fmt.Errorf("artifacts: make object read-only: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		if errors.Is(err, os.ErrExist) {
			// Concurrent Put of the same content: the other writer won, and
			// the bytes are identical by construction.
			return ref, nil
		}
		return Ref{}, fmt.Errorf("artifacts: publish object: %w", err)
	}
	return ref, nil
}

func putLimit(in Input) int64 {
	limit := LimitFor(in.Kind)
	if in.MaxBytes > 0 && in.MaxBytes < limit {
		limit = in.MaxBytes
	}
	if limit > HardLimit {
		limit = HardLimit
	}
	return limit
}

// Open returns the object, wrapped so that draining it verifies the digest.
// A mismatch surfaces as ErrDigestMismatch from the final Read, which for an
// HTTP handler means a truncated response — the honest failure, since headers
// cannot be retracted after the first byte.
func (l *Local) Open(ctx context.Context, ref Ref) (io.ReadCloser, int64, error) {
	if err := ValidateRef(ref); err != nil {
		return nil, 0, err
	}
	p, err := l.resolve(ref.StorageKey)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, fmt.Errorf("%w: %s", ErrNotFound, ref.StorageKey)
		}
		return nil, 0, fmt.Errorf("artifacts: open object: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, fmt.Errorf("artifacts: stat object: %w", err)
	}
	if !st.Mode().IsRegular() {
		_ = f.Close()
		return nil, 0, fmt.Errorf("%w: %s is not a regular file", ErrNotFound, ref.StorageKey)
	}
	if ref.SizeBytes > 0 && st.Size() != ref.SizeBytes {
		_ = f.Close()
		return nil, 0, fmt.Errorf("%w: row claims %d bytes, object is %d",
			ErrDigestMismatch, ref.SizeBytes, st.Size())
	}
	return &verifyingReader{rc: f, h: sha256.New(), want: ref.SHA256}, st.Size(), nil
}

// Stat hashes the object and compares it to the digest the key names.
func (l *Local) Stat(ctx context.Context, ref Ref) (Ref, error) {
	if err := ValidateRef(ref); err != nil {
		return Ref{}, err
	}
	p, err := l.resolve(ref.StorageKey)
	if err != nil {
		return Ref{}, err
	}
	got, size, err := hashFile(ctx, p)
	if err != nil {
		return Ref{}, err
	}
	if got != ref.SHA256 {
		return Ref{}, fmt.Errorf("%w: %s holds %s", ErrDigestMismatch, ref.StorageKey, got)
	}
	out := ref
	out.SizeBytes = size
	return out, nil
}

// Delete removes the object (retention sweep only — see Store.Delete).
func (l *Local) Delete(ctx context.Context, ref Ref) error {
	if err := ValidateRef(ref); err != nil {
		return err
	}
	if l.readOnly {
		return fmt.Errorf("%w: this replica mounts the artifact root read-only", ErrUnsupported)
	}
	p, err := l.resolve(ref.StorageKey)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("artifacts: delete object: %w", err)
	}
	// Leaving empty shard directories behind is harmless; removing them is
	// tidy, and a failed removal changes nothing about correctness.
	_ = os.Remove(filepath.Dir(p))
	return nil
}

// Presign mints a download-scope token for the artifact and lays out a URL on
// the app origin (ADR-0020 D1: a *controlled* signed download in both
// backends, so the API surface never has to know which one is configured).
//
// Which route consumes that token is a deployment question M3 does not answer:
// the frozen M3 surface in api/openapi.yaml exposes browser bytes only through
// the session-authenticated `GET /api/v1/artifacts/{artifactId}/content`, and
// adding a `?token=` credential to it would be an API change needing its own
// ADR, not an implementation detail. What is verified here is the token itself
// — scope, digest binding, expiry, key rotation — which is the security
// property ADR-0020 asks for.
func (l *Local) Presign(ctx context.Context, ref Ref, ttl time.Duration, disposition string) (string, time.Time, error) {
	if err := ValidateRef(ref); err != nil {
		return "", time.Time{}, err
	}
	if l.signer == nil || l.baseURL == "" {
		return "", time.Time{}, fmt.Errorf("%w: local Presign needs a BaseURL and a Signer", ErrUnsupported)
	}
	if ref.ID == "" {
		return "", time.Time{}, fmt.Errorf("%w: a token is bound to an artifact id, and this ref has none",
			ErrInvalidInput)
	}
	if err := contextErr(ctx); err != nil {
		return "", time.Time{}, err
	}
	exp := time.Now().UTC().Add(ClampTokenTTL(ttl)).Truncate(time.Second)
	tok, err := l.signer.Sign(Token{
		Scope: ScopeDownload, ArtifactID: ref.ID, SHA256: ref.SHA256, ExpiresAt: exp,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	q := "?token=" + tok
	if disposition != "" {
		q += "&disposition=" + strings.ReplaceAll(disposition, " ", "%20")
	}
	return l.baseURL + "/api/v1/artifacts/" + ref.ID + "/content" + q, exp, nil
}

// resolve maps a validated key onto a path under the root and proves the
// result is still under the root after cleaning — belt-and-braces behind
// ParseKey, because the cost of being wrong here is reading another project's
// bytes.
func (l *Local) resolve(key string) (string, error) {
	if _, _, _, err := ParseKey(key); err != nil {
		return "", err
	}
	p := path.Join(l.root, filepath.ToSlash(key))
	if !strings.HasPrefix(p, l.root+"/") {
		return "", fmt.Errorf("%w: key %q escapes the artifact root", ErrInvalidInput, key)
	}
	return p, nil
}

// hashFile streams a file through sha256 with ctx cancellation.
func hashFile(ctx context.Context, p string) (digest string, size int64, err error) {
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", 0, fmt.Errorf("%w: %s", ErrNotFound, p)
		}
		return "", 0, fmt.Errorf("artifacts: open for hashing: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := copyCtx(ctx, h, f)
	if err != nil {
		return "", 0, err
	}
	return HexDigest(h.Sum(nil)), n, nil
}

// verifyingReader reports ErrDigestMismatch once the stream is drained, which
// is as late as a streaming response can honestly notice anything.
type verifyingReader struct {
	rc   io.ReadCloser
	h    hash.Hash
	want string
}

func (v *verifyingReader) Read(p []byte) (int, error) {
	n, err := v.rc.Read(p)
	if n > 0 {
		_, _ = v.h.Write(p[:n])
	}
	if errors.Is(err, io.EOF) {
		if got := HexDigest(v.h.Sum(nil)); got != v.want {
			return n, fmt.Errorf("%w: stream holds %s, key claims %s", ErrDigestMismatch, got, v.want)
		}
	}
	return n, err
}

func (v *verifyingReader) Close() error { return v.rc.Close() }

// contextErr reports ctx's failure, if any.
func contextErr(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// List walks the artifact root under prefix (Sweeper). A directory that cannot
// be read is reported rather than skipped: an orphan sweep that silently misses
// half the tree would "reclaim" nothing and look like it did.
func (l *Local) List(ctx context.Context, prefix string, fn func(Object) error) error {
	if strings.Contains(prefix, "..") || strings.HasPrefix(prefix, "/") {
		return fmt.Errorf("%w: listing prefix %q", ErrInvalidInput, prefix)
	}
	base := l.root
	if prefix != "" {
		base = path.Join(l.root, filepath.ToSlash(prefix))
		if !strings.HasPrefix(base, l.root+"/") {
			return fmt.Errorf("%w: prefix %q escapes the artifact root", ErrInvalidInput, prefix)
		}
	}
	return filepath.Walk(base, func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err := contextErr(ctx); err != nil {
			return err
		}
		if info.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		key, err := filepath.Rel(l.root, p)
		if err != nil {
			return err
		}
		// The spool is ours, not an artifact: listing it would make the sweep
		// try to reclaim files that are mid-Put.
		if strings.HasPrefix(filepath.ToSlash(key), ".spool/") {
			return nil
		}
		return fn(Object{Key: filepath.ToSlash(key), SizeBytes: info.Size(), ModTime: info.ModTime().UTC()})
	})
}
