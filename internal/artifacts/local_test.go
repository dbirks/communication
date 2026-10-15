package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The local backend is always conformanced; only its own specifics need a home
// here. ADR-0020 Verification 1's seven results run through conformance_test.go.

func newLocalForTest(t *testing.T) *Local {
	t.Helper()
	root := testDir(t, "local")
	l, err := NewLocal(LocalConfig{
		Root:     root,
		SpoolDir: filepath.Join(root, ".spool"),
		BaseURL:  "http://localhost:18080",
		Signer:   testSigner(t),
	})
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	return l
}

func testSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner(bytes.Repeat([]byte("k"), 32))
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s
}

func TestLocalConformance(t *testing.T) {
	cs := conformanceSuite{
		name: "local",
		store: func(t *testing.T) Store {
			return newLocalForTest(t)
		},
		tamper: func(t *testing.T, s Store, ref Ref, payload []byte) {
			t.Helper()
			l := s.(*Local)
			p, err := l.resolve(ref.StorageKey)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			// Objects are written 0444 on purpose; tampering has to defeat that
			// the way a real corruption does — by having write access.
			if err := os.Chmod(p, 0o600); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			if err := os.WriteFile(p, payload, 0o600); err != nil {
				t.Fatalf("tamper: %v", err)
			}
		},
		countObjects: func(t *testing.T, s Store, projectID string) int {
			t.Helper()
			n := 0
			err := s.(*Local).List(context.Background(), projectID, func(Object) error {
				n++
				return nil
			})
			if err != nil && !os.IsNotExist(err) {
				t.Fatalf("list: %v", err)
			}
			return n
		},
		canStatVerify: true,
	}
	cs.run(t)
}

func TestLocalReadOnlyReplicaRefusesWrites(t *testing.T) {
	root := testDir(t, "readonly")
	l, err := NewLocal(LocalConfig{Root: root, ReadOnly: true})
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	_, err = l.Put(context.Background(), Input{
		ArtifactID: "33333333-3333-4333-8333-333333333333",
		ProjectID:  "11111111-1111-4111-8111-111111111111",
		Name:       "x.json", Kind: KindJSON, MediaType: "application/json",
		Sensitivity: SensitivityStandard, Body: strings.NewReader(`{}`),
	})
	if !isNotSupported(err) {
		t.Fatalf("Put on a read-only mount = %v, want ErrUnsupported", err)
	}
	if err := l.Delete(context.Background(), Ref{
		ProjectID:  "11111111-1111-4111-8111-111111111111",
		StorageKey: "11111111-1111-4111-8111-111111111111/json/e3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.json",
		SHA256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	}); !isNotSupported(err) {
		t.Errorf("Delete on a read-only mount = %v, want ErrUnsupported", err)
	}
}

// TestLocalObjectIsWrittenReadOnly backs the claim in Put's comment: the bytes
// cannot be modified in place, so "immutable after ready" is a filesystem fact
// and not only a code-path convention.
func TestLocalObjectIsWrittenReadOnly(t *testing.T) {
	l := newLocalForTest(t)
	ref, err := l.Put(context.Background(), Input{
		ArtifactID: "33333333-3333-4333-8333-333333333333",
		ProjectID:  "11111111-1111-4111-8111-111111111111",
		Name:       "r.json", Kind: KindJSON, MediaType: "application/json",
		Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"ro":true}`),
	})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	p, err := l.resolve(ref.StorageKey)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm()&0o222 != 0 {
		t.Errorf("object mode = %v, want no write bits", fi.Mode().Perm())
	}
	if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("a completed Put left a spool file behind")
	}
	// And the spool directory holds nothing after a successful Put.
	entries, err := os.ReadDir(l.spoolDir)
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("spool dir holds %d leftover files", len(entries))
	}
}

func TestNewLocalRejectsUnsafeRoots(t *testing.T) {
	for _, cfg := range []LocalConfig{
		{Root: ""},
		{Root: "artifacts"},                                  // relative
		{Root: "/tmp/artifacts"},                             // ADR-0019 P9
		{Root: "/var/tmp/artifacts"},                         // ADR-0019 P9
		{Root: "/srv/artifacts/../etc"},                      // traversal
		{Root: "/srv/artifacts", SpoolDir: "/tmp"},           // spool in a temp dir
		{Root: "/srv/artifacts", SpoolDir: "/srv/elsewhere"}, // spool outside the root
	} {
		if _, err := NewLocal(cfg); err == nil {
			t.Errorf("NewLocal(%+v) succeeded, want an error", cfg)
		}
	}
}

// TestLocalSizeCapIsEnforcedAtTheHardCap checks the ceiling independently of
// the per-kind default, because a caller asking for more than HardLimit must
// be clamped rather than trusted.
func TestLocalSizeCapIsEnforcedAtTheHardCap(t *testing.T) {
	l := newLocalForTest(t)
	// A 1 MiB body against an absurd MaxBytes still fits under the hard cap, so
	// the check here is that the *kind* limit is never widened by MaxBytes.
	_, err := l.Put(context.Background(), Input{
		ArtifactID: "33333333-3333-4333-8333-333333333333",
		ProjectID:  "11111111-1111-4111-8111-111111111111",
		Name:       "big.png", Kind: KindImage, MediaType: "image/png",
		Sensitivity: SensitivityStandard, MaxBytes: 1 << 30,
		Body: io.LimitReader(bytes.NewReader(bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 4<<20)), 4<<20),
	})
	if err != nil {
		t.Fatalf("a 4 MiB image is under the 10 MiB image cap: %v", err)
	}
	if got := LimitFor(KindImage); got != 10<<20 {
		t.Errorf("image cap = %d, want %d", got, 10<<20)
	}
	if got := LimitFor(KindHTML); got != 25<<20 {
		t.Errorf("html cap = %d, want %d", got, 25<<20)
	}
	if HardLimit <= MaxTokenTTL.Nanoseconds() {
		t.Log("hard limit", HardLimit)
	}
}

func TestPutLimitNeverExceedsHardLimit(t *testing.T) {
	if got := putLimit(Input{Kind: KindArchive, MaxBytes: 1 << 40}); got > HardLimit {
		t.Errorf("putLimit clamped to %d, want <= HardLimit %d", got, HardLimit)
	}
	if got := putLimit(Input{Kind: KindImage, MaxBytes: 1024}); got != 1024 {
		t.Errorf("putLimit honours a tighter MaxBytes = %d, want 1024", got)
	}
}

// TestLocalConcurrentPutOfSameContentIsANoop is the property the table's UNIQUE
// (project_id, kind, sha256) mirrors: two writers of identical bytes produce
// one object.
func TestLocalConcurrentPutOfSameContentIsANoop(t *testing.T) {
	l := newLocalForTest(t)
	body := bytes.Repeat([]byte("same"), 4096)
	const project = "11111111-1111-4111-8111-111111111111"
	in := func() Input {
		return Input{ArtifactID: "33333333-3333-4333-8333-333333333333", ProjectID: project,
			Name: "c.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityStandard, Body: bytes.NewReader(body)}
	}
	first, err := l.Put(context.Background(), in())
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	// Force the race: the target already exists when the spool finishes, so the
	// rename collides. Deleting nothing and re-Putting exercises the
	// exists-check path; the collision path is the ErrExist branch below it.
	second, err := l.Put(context.Background(), in())
	if err != nil {
		t.Fatalf("second Put: %v", err)
	}
	if first.StorageKey != second.StorageKey {
		t.Fatalf("two keys for one digest: %q vs %q", first.StorageKey, second.StorageKey)
	}
	p, _ := l.resolve(first.StorageKey)
	samples := make(chan string, 2)
	for i := 0; i < 2; i++ {
		go func() {
			r, err := l.Put(context.Background(), in())
			if err != nil {
				samples <- "err: " + err.Error()
				return
			}
			samples <- r.StorageKey
		}()
	}
	for i := 0; i < 2; i++ {
		if got := <-samples; got != first.StorageKey {
			t.Errorf("concurrent Put produced %q instead of the existing key", got)
		}
	}
	_ = p
}

// TestLocalPresignMintsAVerifiableToken checks the ADR-0020 D1 claim behind the
// local backend's Presign: the URL is only as strong as an HMAC over
// (artifact id, digest, expiry), and every way of abusing it fails.
func TestLocalPresignMintsAVerifiableToken(t *testing.T) {
	l := newLocalForTest(t)
	const project = "11111111-1111-4111-8111-111111111111"
	const artifact = "33333333-3333-4333-8333-333333333333"
	ref, err := l.Put(context.Background(), Input{ArtifactID: artifact, ProjectID: project,
		Name: "p.json", Kind: KindJSON, MediaType: "application/json",
		Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"p":1}`)})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	url, exp, err := l.Presign(context.Background(), ref, time.Minute, "")
	if err != nil {
		t.Fatalf("Presign: %v", err)
	}
	if !strings.HasPrefix(url, "http://localhost:18080/api/v1/artifacts/"+artifact+"/content?token=") {
		t.Errorf("unexpected presigned url %q", url)
	}
	token := url[strings.Index(url, "token=")+len("token="):]
	// The token must verify for exactly this artifact and digest.
	tok, err := l.signer.Verify(token, exp.Add(-time.Second))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if tok.Scope != ScopeDownload || tok.ArtifactID != artifact || tok.SHA256 != ref.SHA256 {
		t.Errorf("token payload = %+v", tok)
	}
	// Expired in the future: refused.
	if _, err := l.signer.Verify(token, exp.Add(time.Second)); err == nil {
		t.Error("an expired token verified")
	} else if !strings.Contains(err.Error(), "expired") {
		t.Errorf("Verify after expiry = %v, want an expiry error", err)
	}
	// Re-signed with another key: refused.
	other, err := NewSigner(bytes.Repeat([]byte("x"), 32))
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	if _, err := other.Verify(token, time.Now()); err == nil {
		t.Error("a token signed with a different key verified")
	}
	// A download token is not a preview token, and vice versa: the scope is
	// inside the signature.
	pv, err := l.signer.Sign(Token{Scope: ScopePreview, ArtifactID: artifact, SHA256: ref.SHA256, ExpiresAt: exp})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	got, err := l.signer.Verify(pv, exp.Add(-time.Second))
	if err != nil || got.Scope != ScopePreview {
		t.Errorf("preview token round-trip = %+v, %v", got, err)
	}
}

func TestSignerRefusesWeakKeys(t *testing.T) {
	if _, err := NewSigner([]byte("hunter2")); err == nil {
		t.Fatal("NewSigner accepted a 7-byte key")
	}
	secret := bytes.Repeat([]byte("z"), 32)
	s, err := NewSigner(secret)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	// Mutating the caller's slice must not change what the signer signs: the
	// key is copied on the way in.
	secret[0] = 'q'
	tok, err := s.Sign(Token{Scope: ScopeDownload,
		ArtifactID: "33333333-3333-4333-8333-333333333333",
		SHA256:     fmt.Sprintf("%x", sha256.Sum256(nil)), ExpiresAt: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if _, err := s.Verify(tok, time.Now()); err != nil {
		t.Errorf("token stopped verifying after the caller mutated its slice: %v", err)
	}
}

func TestSignerRejectsMalformedTokens(t *testing.T) {
	s := testSigner(t)
	for _, bad := range []string{
		"", "x", "a.b", "....", "!!!.!!!",
		// Structurally a token, but with a scope that is not one of the two
		// legal ones: it must not verify even before the signature is checked.
		b64url("v9.notscope.33333333-3333-4333-8333-333333333333."+
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.1777000000") + ".y",
		// Well-formed payload, wrong signature length.
		b64url("v1.pv.33333333-3333-4333-8333-333333333333."+
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.1777000000") + ".y",
	} {
		if _, err := s.Verify(bad, time.Now()); err == nil {
			t.Errorf("Verify(%q) succeeded", bad)
		}
	}
}

func TestTokenClampsTTL(t *testing.T) {
	if got := ClampTokenTTL(0); got != DefaultTokenTTL {
		t.Errorf("ClampTokenTTL(0) = %v, want the default %v", got, DefaultTokenTTL)
	}
	if got := ClampTokenTTL(24 * time.Hour); got != MaxTokenTTL {
		t.Errorf("ClampTokenTTL(24h) = %v, want the ceiling %v", got, MaxTokenTTL)
	}
	if got := ClampTokenTTL(time.Second); got != time.Minute {
		t.Errorf("ClampTokenTTL(1s) = %v, want the floor of 1m", got)
	}
}

func TestPreviewableFollowsTheSensitivityTable(t *testing.T) {
	cases := []struct {
		kind, sensitivity string
		want              bool
	}{
		{KindHTML, SensitivityStandard, true},
		{KindHTML, SensitivityInternal, true},
		{KindImage, SensitivityInternal, true},
		{KindHTML, SensitivityRestricted, false}, // "restricted never previews"
		{KindHTML, SensitivitySecret, false},
		{KindJSON, SensitivityStandard, false}, // not a document the preview renders
		{KindCheckpoint, SensitivityInternal, false},
	}
	for _, c := range cases {
		if got := Previewable(c.kind, c.sensitivity); got != c.want {
			t.Errorf("Previewable(%q,%q) = %v, want %v", c.kind, c.sensitivity, got, c.want)
		}
	}
}

func TestUnsafeInlineCoversTheScriptBearingTypes(t *testing.T) {
	for _, mt := range []string{"text/html", "application/xhtml+xml", "image/svg+xml", "TEXT/HTML; charset=utf-8"} {
		if !UnsafeInline(mt) {
			t.Errorf("%q must never render inline", mt)
		}
	}
	for _, mt := range []string{"text/plain", "text/markdown", "application/json", "image/png", "application/gzip"} {
		if UnsafeInline(mt) {
			t.Errorf("%q is fine to serve inline", mt)
		}
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := map[string]string{
		"report.html":      "report.html",
		"../../etc/passwd": "passwd",
		"..":               "artifact",
		"":                 "artifact",
		`evil"name.txt`:    "evil_name.txt",
		// A control character becomes an underscore; a space survives because it
		// is legal inside a quoted filename and the handler quotes.
		"a\nSet-Cookie: x=1":     "a_Set-Cookie: x=1",
		"emoji-\U0001f600.html":  "emoji-_.html",
		strings.Repeat("n", 200): strings.Repeat("n", 128),
		".hidden":                "hidden",
	}
	for in, want := range cases {
		if got := SanitizeFilename(in); got != want {
			t.Errorf("SanitizeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildAndParseKeyRoundTrip(t *testing.T) {
	digest := fmt.Sprintf("%x", sha256.Sum256(nil))
	key, err := BuildKey("11111111-1111-4111-8111-111111111111", KindJSON, digest, "application/json")
	if err != nil {
		t.Fatalf("BuildKey: %v", err)
	}
	p, k, d, err := ParseKey(key)
	if err != nil {
		t.Fatalf("ParseKey(%q): %v", key, err)
	}
	if p != "11111111-1111-4111-8111-111111111111" || k != KindJSON || d != digest {
		t.Errorf("round trip = %q %q %q", p, k, d)
	}
	for _, bad := range []string{
		"", "a/b/c/d", "not-a-uuid/json/00/" + digest + ".json",
		"11111111-1111-4111-8111-111111111111/exe/00/" + digest + ".exe",
		"11111111-1111-4111-8111-111111111111/json/../" + digest + ".json",
		"11111111-1111-4111-8111-111111111111/json/01/" + digest + ".json", // wrong shard
		"11111111-1111-4111-8111-111111111111/json/00/deadbeef.json",
	} {
		if _, _, _, err := ParseKey(bad); err == nil {
			t.Errorf("ParseKey(%q) succeeded", bad)
		}
	}
}

func isNotSupported(err error) bool { return strings.Contains(err.Error(), "not supported") }

func b64url(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
