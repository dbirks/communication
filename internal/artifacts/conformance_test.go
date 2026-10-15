package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testDir returns a scratch directory that is NOT under /tmp.
//
// t.TempDir() would be the idiomatic choice and it is unusable here: ADR-0019's
// probe C-TMP1 measured that a sandboxed agent can write /tmp, so
// RejectTempRoot refuses a root or spool anywhere under it — a rule that has to
// hold in a test too, or the test would bless exactly the configuration the
// product forbids.
func testDir(t *testing.T, name string) string {
	t.Helper()
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.Getenv("HOME")
	}
	dir := filepath.Join(base, "communication-lab", "m3art-tests", name)
	if strings.HasPrefix(dir, "/tmp/") {
		t.Fatalf("scratch dir %q is under /tmp, which the artifact root must never be", dir)
	}
	cleanup := dir
	t.Cleanup(func() { _ = os.RemoveAll(cleanup) })
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	// Guard against a test-run TMPDIR pointing at /tmp being inherited by the
	// default spool in some other case.
	if got := filepath.Clean(filepath.Dir(dir)); got == "/tmp" {
		t.Fatalf("scratch parent is /tmp")
	}
	return dir
}

// conformanceSuite is ADR-0020 Verification 1 run against any backend. The
// point of a shared suite is that "S3-compatible" means the same observable
// behaviour, so every claim here is about what a caller can see, not about
// which client was used.
type conformanceSuite struct {
	// name appears in failures.
	name string
	// store builds the backend under test.
	store func(t *testing.T) Store
	// tamper overwrites the bytes at a key with different bytes, simulating a
	// corrupted object. Local truncates-and-writes the file; S3 puts a new
	// version of the same key. Both are "the bytes under this key are no
	// longer the bytes the key names".
	tamper func(t *testing.T, s Store, ref Ref, payload []byte)
	// countObjects returns the number of objects under a project prefix, so
	// "a second Put creates no new object" is a measurement.
	countObjects func(t *testing.T, s Store, projectID string) int
	// canStatVerify reports whether Stat on this backend actually hashes the
	// object. It is true for local and false for S3, where a HEAD returns no
	// bytes — an honest per-backend difference stated rather than papered
	// over, and the tampering assertion then runs through Open.
	canStatVerify bool
	// presignFetchable reports whether a Presign URL can be GETted by this
	// test process (true for the real S3 speaker, false for the local
	// backend, whose token URL has no M3 route consuming it yet).
	presignFetchable bool
}

func (cs conformanceSuite) run(t *testing.T) {
	t.Helper()
	ctx := context.Background()

	// A fresh project id per subtest, because a shared backend (the S3 one is
	// one client over one bucket for the whole run) would otherwise carry
	// objects from an earlier subtest into a later "how many objects does this
	// project have" assertion.
	projN := 0
	proj := func() string {
		projN++
		return fmt.Sprintf("%08x-1111-4111-8111-%012x", 0xa11ce000+projN, projN)
	}
	const artifactID = "33333333-3333-4333-8333-333333333333"

	payload := []byte("<!doctype html><title>report</title><p>hello from M3</p>")
	wantDigest := fmt.Sprintf("%x", sha256.Sum256(payload))

	t.Run("put_then_open_is_byte_identical", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		ref, err := s.Put(ctx, Input{
			ArtifactID: artifactID, ProjectID: projectA,
			Name: "report.html", Kind: KindHTML, MediaType: "text/html",
			Sensitivity: SensitivityInternal, Body: bytes.NewReader(payload),
		})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		if ref.SHA256 != wantDigest {
			t.Errorf("Put digest = %s, want %s", ref.SHA256, wantDigest)
		}
		if ref.SizeBytes != int64(len(payload)) {
			t.Errorf("Put size = %d, want %d", ref.SizeBytes, len(payload))
		}
		if ref.StorageBackend != cs.expectedBackend() {
			t.Errorf("storage backend = %q, want %q", ref.StorageBackend, cs.expectedBackend())
		}
		wantKey := projectA + "/html/" + wantDigest[:2] + "/" + wantDigest + ".html"
		if ref.StorageKey != wantKey {
			t.Errorf("storage key = %q, want %q", ref.StorageKey, wantKey)
		}
		got, size, err := s.Open(ctx, ref)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer got.Close()
		body, err := io.ReadAll(got)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if !bytes.Equal(body, payload) {
			t.Errorf("round-trip mismatch: %q", body)
		}
		if size != int64(len(payload)) {
			t.Errorf("Open size = %d, want %d", size, len(payload))
		}
	})

	t.Run("second_put_of_same_digest_reuses_the_key", func(t *testing.T) {
		s := cs.store(t)
		projectB := proj()
		in := func() Input {
			return Input{ArtifactID: artifactID, ProjectID: projectB,
				Name: "again.html", Kind: KindHTML, MediaType: "text/html",
				Sensitivity: SensitivityStandard, Body: bytes.NewReader(payload)}
		}
		first, err := s.Put(ctx, in())
		if err != nil {
			t.Fatalf("first Put: %v", err)
		}
		before := cs.countObjects(t, s, projectB)
		second, err := s.Put(ctx, in())
		if err != nil {
			t.Fatalf("second Put: %v", err)
		}
		if first.StorageKey != second.StorageKey {
			t.Errorf("same bytes got two keys: %q then %q", first.StorageKey, second.StorageKey)
		}
		if after := cs.countObjects(t, s, projectB); after != before {
			t.Errorf("re-Put created an object: %d before, %d after", before, after)
		}
	})

	t.Run("content_is_scoped_to_its_project_prefix", func(t *testing.T) {
		projectA, projectB := proj(), proj()
		s := cs.store(t)
		if _, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "a.html", Kind: KindHTML, MediaType: "text/html",
			Sensitivity: SensitivityStandard, Body: bytes.NewReader(payload)}); err != nil {
			t.Fatalf("Put A: %v", err)
		}
		if n := cs.countObjects(t, s, projectB); n != 0 {
			t.Errorf("project %s lists %d objects it never wrote", projectB, n)
		}
		if n := cs.countObjects(t, s, projectA); n != 1 {
			t.Errorf("project %s lists %d objects, want 1", projectA, n)
		}
	})

	t.Run("open_of_a_missing_key_is_not_found", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		key, err := BuildKey(projectA, KindHTML, wantDigest, "text/html")
		if err != nil {
			t.Fatalf("BuildKey: %v", err)
		}
		ref := Ref{ID: artifactID, ProjectID: projectA, StorageBackend: cs.expectedBackend(),
			StorageKey: key, SHA256: wantDigest, SizeBytes: int64(len(payload))}
		if _, _, err := s.Open(ctx, ref); !errors.Is(err, ErrNotFound) {
			t.Errorf("Open missing = %v, want ErrNotFound", err)
		}
		if _, err := s.Stat(ctx, ref); !errors.Is(err, ErrNotFound) {
			t.Errorf("Stat missing = %v, want ErrNotFound", err)
		}
	})

	t.Run("oversize_put_is_refused_not_truncated", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		big := bytes.Repeat([]byte("x"), 4096)
		_, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "big.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityInternal, MaxBytes: 1024, Body: bytes.NewReader(big)})
		if !errors.Is(err, ErrTooLarge) {
			t.Fatalf("oversize Put = %v, want ErrTooLarge", err)
		}
		if n := cs.countObjects(t, s, projectA); n != 0 {
			t.Errorf("a refused Put left %d objects behind", n)
		}
	})

	t.Run("invalid_input_is_refused_before_bytes_are_read", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		cases := []struct {
			name string
			in   Input
		}{
			{"unknown kind", Input{ProjectID: "11111111-1111-4111-8111-111111111111", Kind: "exe", MediaType: "application/octet-stream",
				Sensitivity: SensitivityStandard, Body: strings.NewReader("x")}},
			{"html with the wrong media type", Input{ProjectID: projectA, Kind: KindHTML,
				MediaType: "application/javascript", Sensitivity: SensitivityStandard, Body: strings.NewReader("x")}},
			{"markdown carrying html", Input{ProjectID: projectA, Kind: KindMarkdown,
				MediaType: "text/html", Sensitivity: SensitivityStandard, Body: strings.NewReader("x")}},
			{"unknown sensitivity", Input{ProjectID: projectA, Kind: KindJSON,
				MediaType: "application/json", Sensitivity: "topsecret", Body: strings.NewReader("x")}},
			{"non-uuid project", Input{ProjectID: "../../etc", Kind: KindJSON,
				MediaType: "application/json", Sensitivity: SensitivityStandard, Body: strings.NewReader("x")}},
			{"media type smuggling a header", Input{ProjectID: projectA, Kind: KindJSON,
				MediaType: "application/json\nX-Evil: 1", Sensitivity: SensitivityStandard, Body: strings.NewReader("x")}},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				c.in.ArtifactID = artifactID
				if _, err := s.Put(ctx, c.in); !errors.Is(err, ErrInvalidInput) {
					t.Errorf("Put = %v, want ErrInvalidInput", err)
				}
			})
		}
	})

	t.Run("a_ref_may_not_point_at_another_digest", func(t *testing.T) {
		projectA, projectB := proj(), proj()
		s := cs.store(t)
		ref, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "one.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"n":1}`)})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		other := ref
		other.SHA256 = fmt.Sprintf("%x", sha256.Sum256([]byte(`{"n":2}`)))
		if _, _, err := s.Open(ctx, other); !errors.Is(err, ErrDigestMismatch) {
			t.Errorf("Open with a mismatched digest = %v, want ErrDigestMismatch", err)
		}
		// A key whose project segment disagrees with the ref is the same class
		// of lie.
		liar := ref
		liar.ProjectID = projectB
		if _, err := s.Stat(ctx, liar); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("Stat with a mismatched project = %v, want ErrInvalidInput", err)
		}
	})

	t.Run("tampered_bytes_are_detected", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		ref, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "t.html", Kind: KindHTML, MediaType: "text/html",
			Sensitivity: SensitivityStandard, Body: bytes.NewReader(payload)})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		cs.tamper(t, s, ref, sameLengthDifferentBytes(payload))

		_, _, err = s.Open(ctx, ref)
		if err != nil {
			t.Fatalf("Open after tamper: %v", err)
		}
		// Detection happens as the stream drains, which is as late as a
		// streaming response can notice anything.
		rc, _, err := s.Open(ctx, ref)
		if err != nil {
			t.Fatalf("Open after tamper: %v", err)
		}
		defer rc.Close()
		if _, err := io.Copy(io.Discard, rc); !errors.Is(err, ErrDigestMismatch) {
			t.Errorf("draining tampered bytes = %v, want ErrDigestMismatch", err)
		}
		if cs.canStatVerify {
			if _, err := s.Stat(ctx, ref); !errors.Is(err, ErrDigestMismatch) {
				t.Errorf("Stat after tamper = %v, want ErrDigestMismatch", err)
			}
		}
	})

	t.Run("delete_removes_and_is_idempotent", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		ref, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "gone.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"bye":true}`)})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		if err := s.Delete(ctx, ref); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, _, err := s.Open(ctx, ref); !errors.Is(err, ErrNotFound) {
			t.Errorf("Open after Delete = %v, want ErrNotFound", err)
		}
		if err := s.Delete(ctx, ref); err != nil {
			t.Errorf("second Delete = %v, want nil (the sweep must be re-runnable)", err)
		}
	})

	t.Run("presign", func(t *testing.T) {
		projectA := proj()
		s := cs.store(t)
		ref, err := s.Put(ctx, Input{ArtifactID: artifactID, ProjectID: projectA,
			Name: "signed.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"signed":true}`)})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		url, exp, err := s.Presign(ctx, ref, 2*time.Minute, `attachment; filename="signed.json"`)
		if err != nil {
			t.Fatalf("Presign: %v", err)
		}
		if exp.Before(time.Now().Add(time.Minute)) {
			t.Errorf("expiry %s is not ~2 minutes out", exp)
		}
		if !strings.HasPrefix(url, "http") {
			t.Errorf("presigned url %q is not absolute", url)
		}
		if cs.presignFetchable {
			resp, err := httpGet(url)
			if err != nil {
				t.Fatalf("GET presigned url: %v", err)
			}
			defer resp.body.Close()
			if resp.status != 200 {
				t.Fatalf("presigned GET status = %d, want 200 (%s)", resp.status, resp.snippet)
			}
			if !strings.Contains(resp.snippet, "signed") {
				t.Errorf("presigned GET returned %q", resp.snippet)
			}
		}
		// A tampered signature must not fetch, wherever the URL is served.
		if cs.presignFetchable {
			bad := strings.Replace(url, "X-Amz-Signature=", "X-Amz-Signature=0", 1)
			resp, err := httpGet(bad)
			if err != nil {
				t.Fatalf("GET tampered presigned url: %v", err)
			}
			defer resp.body.Close()
			if resp.status == 200 {
				t.Errorf("a tampered presigned signature fetched the object")
			}
		}
	})

	t.Run("refused_prefix_shape", func(t *testing.T) {
		s := cs.store(t)
		sw, ok := s.(Sweeper)
		if !ok {
			t.Skip("backend is not a Sweeper")
		}
		if err := sw.List(ctx, "../", func(Object) error { return nil }); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("List(..) = %v, want ErrInvalidInput", err)
		}
	})
}

// sameLengthDifferentBytes is what a tampering test needs: same length,
// different content, so the *digest* is the only signal a backend can use. A
// different-length payload would be caught by the cheaper size check and the
// test would pass for the wrong reason.
func sameLengthDifferentBytes(payload []byte) []byte {
	out := make([]byte, len(payload))
	for i := range payload {
		out[i] = payload[len(payload)-1-i] ^ 0xff
	}
	return out
}

func (cs conformanceSuite) expectedBackend() string {
	switch cs.name {
	case "s3":
		return BackendS3
	default:
		return BackendLocal
	}
}

// httpGet is a tiny GET helper for the presign assertions.
type httpReply struct {
	status   int
	body     io.ReadCloser
	snippet  string
	header   map[string]string
	noCookie bool
}

func httpGet(url string) (*httpReply, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	snip, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return &httpReply{
		status:  resp.StatusCode,
		body:    nopCloser{io.MultiReader(bytes.NewReader(snip), resp.Body)},
		snippet: string(snip),
		header:  flattenHeader(resp.Header),
	}, nil
}

type nopCloser struct{ io.Reader }

func (nopCloser) Close() error { return nil }

func flattenHeader(h map[string][]string) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		if len(v) > 0 {
			out[k] = strings.Join(v, ",")
		}
	}
	return out
}
