package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The S3 backend's evidence has two halves. Unit tests pin the parts of SigV4
// that a wrong answer makes silently wrong-but-plausible (encoding and
// canonical ordering), and the integration run against a real S3 speaker
// (SeaweedFS, `chrislusf/seaweedfs:4.48`, with signature verification turned
// ON) is the actual authority on the signature: an independent implementation
// either accepts our Authorization header or it does not. A mocked HTTP server
// cannot make that claim, which is why the suite below skips rather than fakes.

func TestSigV4Canonicalization(t *testing.T) {
	// Space is %20 and '~' is untouched — the two places where SigV4 differs
	// from Go's url.QueryEscape, and both change the signature.
	if got, want := URIEncode("a b~c/d", true), "a%20b~c%2Fd"; got != want {
		t.Errorf("URIEncode slash = %q, want %q", got, want)
	}
	if got, want := URIEncode("a b~c/d", false), "a%20b~c/d"; got != want {
		t.Errorf("URIEncode path = %q, want %q", got, want)
	}
	if got, want := URIEncode("key+&=", true), "key%2B%26%3D"; got != want {
		t.Errorf("URIEncode reserved = %q, want %q", got, want)
	}

	// Query params sort by encoded key then value, and a key with several
	// values lists each pair separately.
	q := url.Values{
		"z":     []string{"2"},
		"a":     []string{"2", "1"},
		"B":     []string{"x"},
		"empty": []string{""},
	}
	if got, want := CanonicalQuery(q), "B=x&a=1&a=2&empty=&z=2"; got != want {
		t.Errorf("CanonicalQuery = %q, want %q", got, want)
	}
	if got := CanonicalQuery(nil); got != "" {
		t.Errorf("CanonicalQuery(nil) = %q, want empty", got)
	}

	// The canonical request's shape is fixed by the spec: method, URI, query,
	// headers each on their own line, one blank line, the signed-header list,
	// then the payload hash. Headers are lowercased, trimmed and sorted.
	headers := map[string]string{
		"X-Amz-Date":           "20260101T000000Z",
		"host":                 "example.com",
		"x-amz-content-sha256": EmptyPayloadHash,
		"Content-Type":         "  text/plain  ",
	}
	got := CanonicalRequest("get", "/bucket/key", "a=1", headers, EmptyPayloadHash)
	want := strings.Join([]string{
		"GET",
		"/bucket/key",
		"a=1",
		"content-type:text/plain",
		"host:example.com",
		"x-amz-content-sha256:" + EmptyPayloadHash,
		"x-amz-date:20260101T000000Z",
		"",
		"content-type;host;x-amz-content-sha256;x-amz-date",
		EmptyPayloadHash,
	}, "\n")
	if got != want {
		t.Errorf("CanonicalRequest =\n%q\nwant\n%q", got, want)
	}

	// The string-to-sign is algorithm, stamp, scope, hex(sha256(canonical)).
	sts := StringToSign("canonical", "20260101T000000Z", "20260101/us-east-1/s3/aws4_request")
	sum := sha256.Sum256([]byte("canonical"))
	wantSTS := fmt.Sprintf("AWS4-HMAC-SHA256\n20260101T000000Z\n20260101/us-east-1/s3/aws4_request\n%x", sum)
	if sts != wantSTS {
		t.Errorf("StringToSign =\n%q\nwant\n%q", sts, wantSTS)
	}

	// The derived key is a chain of four HMACs, and its length is sha256's.
	if k := SigningKey("secret", "20260101", "us-east-1"); len(k) != sha256.Size {
		t.Errorf("SigningKey length = %d, want %d", len(k), sha256.Size)
	}
	if a, b := Sign("k1", "AK", "us-east-1", "20260101T000000Z", "c"),
		Sign("k2", "AK", "us-east-1", "20260101T000000Z", "c"); a == b {
		t.Error("different secrets produced the same signature")
	}
	if a, b := Sign("k", "AK", "us-east-1", "20260101T000000Z", "c1"),
		Sign("k", "AK", "us-east-1", "20260101T000000Z", "c2"); a == b {
		t.Error("different canonical requests produced the same signature")
	}
	if a, b := Sign("k", "AK", "us-east-1", "20260101T000000Z", "c"),
		Sign("k", "AK", "eu-west-1", "20260101T000000Z", "c"); a == b {
		t.Error("a different region produced the same signature")
	}
}

func TestS3ConfigValidation(t *testing.T) {
	base := S3Config{
		Endpoint: "http://127.0.0.1:8333", Bucket: "communication-artifacts",
		AccessKey: "AK", SecretKey: "secret", SpoolDir: "/var/lib/communication/spool",
	}
	if _, err := NewS3(base); err != nil {
		t.Fatalf("a good config must build: %v", err)
	}
	cases := map[string]func(*S3Config){
		"no endpoint":         func(c *S3Config) { c.Endpoint = "" },
		"endpoint with path":  func(c *S3Config) { c.Endpoint = "http://h:8333/s3" },
		"endpoint with creds": func(c *S3Config) { c.Endpoint = "http://u:p@h:8333" },
		"endpoint with query": func(c *S3Config) { c.Endpoint = "http://h:8333?x=1" },
		"no bucket":           func(c *S3Config) { c.Bucket = "" },
		"uppercase bucket":    func(c *S3Config) { c.Bucket = "Artifacts" },
		"bucket too short":    func(c *S3Config) { c.Bucket = "ab" },
		"no access key":       func(c *S3Config) { c.AccessKey = "" },
		"no secret key":       func(c *S3Config) { c.SecretKey = "" },
		"temp spool":          func(c *S3Config) { c.SpoolDir = "/tmp/spool" },
		"relative spool":      func(c *S3Config) { c.SpoolDir = "spool" },
		"empty spool":         func(c *S3Config) { c.SpoolDir = "" },
	}
	for name, mutate := range cases {
		cfg := base
		mutate(&cfg)
		if _, err := NewS3(cfg); err == nil {
			t.Errorf("%s: NewS3 succeeded, want an error", name)
		} else if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: NewS3 error = %v, want ErrInvalidInput", name, err)
		}
	}
}

// TestS3PresignRefusesPlaintextToAPublicHost keeps the "presigned URL is a
// bearer credential" rule honest: over http to somewhere routable, a
// man-on-path replays it inside the TTL. The lab's compose network is private,
// which is the only reason http works there.
func TestS3PresignRefusesPlaintextToAPublicHost(t *testing.T) {
	spool := testDir(t, "s3-presign-spool")
	public, err := NewS3(S3Config{
		Endpoint: "http://s3.example.com", Bucket: "communication-artifacts",
		AccessKey: "AK", SecretKey: "secret", SpoolDir: spool,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	ref := testRef(t)
	if _, _, err := public.Presign(context.Background(), ref, time.Minute, ""); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("http presign to a public host = %v, want ErrInvalidInput", err)
	}
	private, err := NewS3(S3Config{
		Endpoint: "http://seaweedfs:8333", Bucket: "communication-artifacts",
		AccessKey: "AK", SecretKey: "secret", SpoolDir: spool, ForcePathStyle: true,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	u, exp, err := private.Presign(context.Background(), ref, time.Minute, `attachment; filename="a.json"`)
	if err != nil {
		t.Fatalf("presign to a private host: %v", err)
	}
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	q := parsed.Query()
	for _, k := range []string{"X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires",
		"X-Amz-SignedHeaders", "X-Amz-Signature", "response-content-disposition"} {
		if q.Get(k) == "" {
			t.Errorf("presigned url is missing %s (%s)", k, u)
		}
	}
	if q.Get("X-Amz-SignedHeaders") != "host" {
		t.Errorf("SignedHeaders = %q, want host", q.Get("X-Amz-SignedHeaders"))
	}
	if !exp.After(time.Now()) {
		t.Errorf("expiry %s is in the past", exp)
	}
	if !strings.HasPrefix(parsed.Path, "/communication-artifacts/") {
		t.Errorf("path-style target = %q", parsed.Path)
	}
	// Virtual-host style addresses the bucket as a DNS label instead.
	vhost, err := NewS3(S3Config{
		Endpoint: "https://s3.example.com", Bucket: "communication-artifacts",
		AccessKey: "AK", SecretKey: "secret", SpoolDir: spool,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	uu, _, err := vhost.Presign(context.Background(), ref, time.Minute, "")
	if err != nil {
		t.Fatalf("https presign: %v", err)
	}
	if !strings.HasPrefix(uu, "https://communication-artifacts.s3.example.com/") {
		t.Errorf("virtual-host presign = %q", uu)
	}
}

// TestS3SpeaksSigV4ToAServerThatChecks is the unit-level proof that a request
// we sign carries everything a verifier needs — and, via a server that refuses
// anything but a recomputed signature, that the signature is consistent with
// the canonical request the server reconstructed from the wire. The real
// cross-implementation authority remains TestS3ConformanceAgainstSeaweedFS.
func TestS3SpeaksSigV4ToAServerThatChecks(t *testing.T) {
	var seen []string
	var stored []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		// Verify like a real S3 speaker does: read the credential scope and the
		// signed-header list out of the Authorization header, recompute the
		// canonical request from exactly those headers as they arrived on the
		// wire, and refuse if the signature does not follow. A dropped header,
		// a rewritten host or a mis-ordered query all land here.
		want := verifyLikeASpeaker(t, r)
		if auth == "" || !strings.HasSuffix(auth, want[strings.LastIndex(want, "=")+1:]) {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `<Error><Code>SignatureDoesNotMatch</Code></Error>`)
			return
		}
		seen = append(seen, r.Method+" "+r.URL.Path+" payload="+r.Header.Get("X-Amz-Content-Sha256"))
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			stored = body
			w.Header().Set("ETag", `"d400c4743e55e2f3373b4c7ed5f4ba0b"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			_, _ = w.Write(stored)
		case http.MethodHead:
			w.Header().Set("Content-Length", fmt.Sprint(len(stored)))
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()

	spool := testDir(t, "s3-spool")
	s, err := NewS3(S3Config{
		Endpoint: srv.URL, Bucket: "communication-artifacts", AccessKey: "AK", SecretKey: "secret",
		SpoolDir: spool, ForcePathStyle: true, ServerSideEncryption: true,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	ctx := context.Background()
	const project = "11111111-1111-4111-8111-111111111111"
	body := []byte(`{"checked":true}`)
	ref, err := s.Put(ctx, Input{ArtifactID: "33333333-3333-4333-8333-333333333333",
		ProjectID: project, Name: "c.json", Kind: KindJSON, MediaType: "application/json",
		Sensitivity: SensitivityStandard, Body: bytes.NewReader(body)})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got, want := ref.SHA256, fmt.Sprintf("%x", sha256.Sum256(body)); got != want {
		t.Errorf("Put digest = %s, want %s", got, want)
	}
	rc, _, err := s.Open(ctx, ref)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("Open returned %q", got)
	}
	if _, err := s.Stat(ctx, ref); err != nil {
		t.Errorf("Stat: %v", err)
	}
	if err := s.Delete(ctx, ref); err != nil {
		t.Errorf("Delete: %v", err)
	}
	// The PUT must have signed the *payload* digest, not the empty one — the
	// difference is what makes the header meaningful.
	wantPut := "PUT /communication-artifacts/" + ref.StorageKey +
		" payload=" + fmt.Sprintf("%x", sha256.Sum256(body))
	found := false
	for _, l := range seen {
		if l == wantPut {
			found = true
		}
	}
	if !found {
		t.Errorf("no PUT carried the payload digest; saw %v", seen)
	}
}

// verifyLikeASpeaker recomputes the Authorization value for a request from the
// wire. It parses SignedHeaders rather than assuming a set, which is the point:
// whatever the client believed it signed must be what the server reads back.
func verifyLikeASpeaker(t *testing.T, r *http.Request) string {
	t.Helper()
	auth := r.Header.Get("Authorization")
	m := reAuthorization.FindStringSubmatch(auth)
	if m == nil {
		return ""
	}
	cred, signedList, gotSig := m[1], m[2], m[3]
	parts := strings.Split(cred, "/")
	if len(parts) != 5 || parts[3] != "s3" {
		return ""
	}
	accessKey, dateStamp, region := parts[0], parts[1], parts[2]
	amz := r.Header.Get("X-Amz-Date")
	if amz[:8] != dateStamp {
		return ""
	}
	headers := map[string]string{}
	for _, name := range strings.Split(signedList, ";") {
		if name == "host" {
			headers["host"] = r.Host
			continue
		}
		headers[name] = r.Header.Get(name)
	}
	// The payload hash the client declared is the one it signed; the point of
	// this check is the signature, not the body (body integrity is asserted by
	// the digest round-trip elsewhere).
	payload := r.Header.Get("X-Amz-Content-Sha256")
	cr := CanonicalRequest(r.Method, r.URL.Path, CanonicalQuery(r.URL.Query()), headers, payload)
	sig := Sign("secret", accessKey, region, amz, cr)
	if gotSig != sig {
		return fmt.Sprintf("Signature=%s-mismatch", sig)
	}
	return fmt.Sprintf("Signature=%s", sig)
}

var reAuthorization = regexp.MustCompile(
	`Credential=(?P<cred>[^,/]+/[0-9]{8}/[^/]+/s3/aws4_request),\s*SignedHeaders=(?P<signed>[^,]+),\s*Signature=(?P<sig>[0-9a-f]{64})`)

// flipByte changes the first hex digit of a signature so the value keeps its
// length and loses its validity.
func flipByte(s string) string {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= '0' && c <= '9' {
			return s[:i] + string("0123456789"[int(c-'0'+1)%10]) + s[i+1:]
		}
	}
	return s + "0"
}

func mustAmzTime(t *testing.T, stamp string) time.Time {
	t.Helper()
	when, err := time.Parse(timeFormatAMZ, stamp)
	if err != nil {
		t.Fatalf("bad X-Amz-Date %q: %v", stamp, err)
	}
	return when
}

func testRef(t *testing.T) Ref {
	t.Helper()
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("x")))
	key, err := BuildKey("11111111-1111-4111-8111-111111111111", KindJSON, digest, "application/json")
	if err != nil {
		t.Fatalf("BuildKey: %v", err)
	}
	return Ref{ID: "33333333-3333-4333-8333-333333333333",
		ProjectID: "11111111-1111-4111-8111-111111111111", StorageBackend: BackendS3,
		StorageKey: key, SHA256: digest, SizeBytes: 1}
}

// s3TestEnv is the lab's S3 speaker. Nothing here has a default: an
// unset variable skips the suite rather than passing it vacuously
// (AGENTS.md: a mocked green test never substitutes for a real one).
func s3TestEnv(t *testing.T) (S3Config, func()) {
	t.Helper()
	endpoint := os.Getenv("COMMUNICATION_TEST_S3_ENDPOINT")
	access := os.Getenv("COMMUNICATION_TEST_S3_ACCESS_KEY")
	secret := os.Getenv("COMMUNICATION_TEST_S3_SECRET_KEY")
	bucket := os.Getenv("COMMUNICATION_TEST_S3_BUCKET")
	if endpoint == "" || access == "" || secret == "" || bucket == "" {
		t.Skip("COMMUNICATION_TEST_S3_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET} not set " +
			"(start SeaweedFS: docker compose -p m3art --profile s3 up -d seaweedfs)")
	}
	spool := testDir(t, "s3-conformance-spool")
	cfg := S3Config{
		Endpoint: endpoint, Bucket: bucket, AccessKey: access, SecretKey: secret,
		Region: "us-east-1", SpoolDir: spool,
		ForcePathStyle: true,
		// SSE-AES256 is ADR-0020 D7's bucket requirement. Whether the speaker
		// honours the header is itself a measured fact, so it is settable:
		// COMMUNICATION_TEST_S3_SSE=0 turns it off and the run says so.
		ServerSideEncryption: os.Getenv("COMMUNICATION_TEST_S3_SSE") == "1",
	}
	probe, err := NewS3(cfg)
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	// The speaker must actually be reachable and must actually verify
	// signatures; an anonymous-friendly gateway would let the whole suite pass
	// on garbage, so the run refuses to proceed on one.
	signed, err := NewS3(cfg)
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	if err := ensureBucket(t, signed, bucket); err != nil {
		t.Fatalf("provision bucket: %v", err)
	}
	if err := storeVerifiesSignatures(context.Background(), endpoint, bucket); err != nil {
		t.Fatalf("precondition: %v", err)
	}
	if _, err := signed.Stat(context.Background(), testRef(t)); err != nil && !errors.Is(err, ErrNotFound) {
		t.Fatalf("precondition: the configured credentials are not accepted: %v", err)
	}
	_ = probe
	return cfg, func() {}
}

// storeVerifiesSignatures is the precondition that makes every other assertion
// in this file mean something: an unsigned PUT to a real bucket must be
// refused, and a *signed* PUT must be accepted. Without both, "our SigV4 works"
// is unfalsifiable — a gateway that ignores Authorization entirely (which is
// SeaweedFS's default with no identities file: observed in this lab, where an
// unsigned put to the same key answered 200) would accept anything and the
// suite would pass on a broken signer.
func storeVerifiesSignatures(ctx context.Context, endpoint, bucket string) error {
	anon, err := http.NewRequestWithContext(ctx, http.MethodPut,
		endpoint+"/"+bucket+"/sigv4-precondition.txt", strings.NewReader("x"))
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(anon)
	if err != nil {
		return fmt.Errorf("anonymous PUT did not reach the store: %w", err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	if resp.StatusCode < 400 {
		return fmt.Errorf("the S3 gateway accepted an UNSIGNED put (http %d): signature verification is off "+
			"— give SeaweedFS an identities file at -s3.config", resp.StatusCode)
	}
	return nil
}

// ensureBucket models the operator's provisioning step (`put-bucket`), which
// the product code is forbidden to call (ADR-0020 D7 prohibits any Create*
// call). It exists only so the conformance suite has somewhere to write, and
// it is a bucket-level PUT signed the same way every other request is.
func ensureBucket(t *testing.T, s *S3, bucket string) error {
	t.Helper()
	ctx := context.Background()
	uri := "/" + bucket
	host := s.host
	if !s.cfg.ForcePathStyle {
		host, uri = bucket+"."+s.host, "/"
	}
	req, err := s.build(ctx, http.MethodPut, host, uri, nil, nil, EmptyPayloadHash, nil, 0)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("create-bucket did not reach the store: %w", err)
	}
	defer drain(resp)
	// BucketAlreadyOwnedByYou / 400 / 409 all mean "it exists", which is the
	// fact we needed.
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusConflict {
		return fmt.Errorf("create-bucket: http %d", resp.StatusCode)
	}
	return nil
}

func TestS3ConformanceAgainstSeaweedFS(t *testing.T) {
	cfg, _ := s3TestEnv(t)
	s, err := NewS3(cfg)
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	cs := conformanceSuite{
		name: "s3",
		store: func(t *testing.T) Store {
			// One backend for the whole run: the suite is project-id-scoped and
			// cleans up after itself, so a fresh client per subtest would only
			// hide connection-reuse bugs.
			return s
		},
		tamper: func(t *testing.T, st Store, ref Ref, payload []byte) {
			rawPut(t, s, ref.StorageKey, payload)
		},
		countObjects: func(t *testing.T, st Store, projectID string) int {
			n := 0
			if err := s.List(context.Background(), projectID, func(Object) error {
				n++
				return nil
			}); err != nil {
				t.Fatalf("list: %v", err)
			}
			return n
		},
		// A HEAD carries no bytes, so Stat on S3 proves existence and size, not
		// content. The tampering assertion is proven through Open's digest
		// check, which is the honest per-backend difference.
		canStatVerify:    false,
		presignFetchable: true,
	}
	cs.run(t)

	t.Run("presigned_get_carries_no_credential_header", func(t *testing.T) {
		ref, err := s.Put(context.Background(), Input{
			ArtifactID: "33333333-3333-4333-8333-333333333333",
			ProjectID:  "55555555-5555-4555-8555-555555555555",
			Name:       "signed.json", Kind: KindJSON, MediaType: "application/json",
			Sensitivity: SensitivityStandard, Body: strings.NewReader(`{"presign":1}`),
		})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		u, _, err := s.Presign(context.Background(), ref, time.Minute, "")
		if err != nil {
			t.Fatalf("Presign: %v", err)
		}
		req, err := http.NewRequest(http.MethodGet, u, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Cookie", "communication_session=must-be-ignored")
		resp, err := s.client.Do(req)
		if err != nil {
			t.Fatalf("presigned GET: %v", err)
		}
		defer drain(resp)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("presigned GET status = %d, want 200", resp.StatusCode)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		if !strings.Contains(string(body), "presign") {
			t.Errorf("presigned GET body = %q", body)
		}
	})

	// The signature must be what authorizes the read, on a key that exists —
	// otherwise a store that answers 404 before checking would look like a pass.
	t.Run("wrong_secret_is_rejected_not_ignored", func(t *testing.T) {
		const project = "66666666-6666-4666-8666-666666666666"
		ref, err := s.Put(context.Background(), Input{ArtifactID: "33333333-3333-4333-8333-333333333333",
			ProjectID: project, Name: "secret-check.json", Kind: KindJSON,
			MediaType: "application/json", Sensitivity: SensitivityStandard,
			Body: strings.NewReader(`{"exists":true}`)})
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		if _, err := s.Stat(context.Background(), ref); err != nil {
			t.Fatalf("Stat with the right secret: %v", err)
		}
		bad := cfg
		bad.SecretKey = cfg.SecretKey[:len(cfg.SecretKey)-4] + "AAAA"
		b, err := NewS3(bad)
		if err != nil {
			t.Fatalf("NewS3: %v", err)
		}
		if _, err := b.Stat(context.Background(), ref); !errors.Is(err, ErrUnauthorized) {
			t.Errorf("Stat with a wrong secret = %v, want ErrUnauthorized", err)
		}
		if _, _, err := b.Open(context.Background(), ref); !errors.Is(err, ErrUnauthorized) {
			t.Errorf("Open with a wrong secret = %v, want ErrUnauthorized", err)
		}
		// A valid signature over a *different* payload must not be accepted:
		// same URL, one character changed in the signature.
		u, _, err := s.Presign(context.Background(), ref, time.Minute, "")
		if err != nil {
			t.Fatalf("Presign: %v", err)
		}
		i := strings.Index(u, "X-Amz-Signature=")
		mangled := u[:i+len("X-Amz-Signature=")] + flipByte(u[i+len("X-Amz-Signature="):])
		resp, err := httpGet(mangled)
		if err != nil {
			t.Fatalf("GET mangled presigned url: %v", err)
		}
		defer resp.body.Close()
		if resp.status == http.StatusOK {
			t.Errorf("the store served an object through a mangled presigned signature")
		}
	})

	// Clean up everything this run wrote, so the pinned image and the named
	// volume stay reusable without a prune.
	t.Cleanup(func() {
		ctx := context.Background()
		var keys []Object
		_ = s.List(ctx, "", func(o Object) error { keys = append(keys, o); return nil })
		for _, o := range keys {
			digest := o.Key[strings.LastIndex(o.Key, "/")+1:]
			if i := strings.Index(digest, "."); i > 0 {
				digest = digest[:i]
			}
			if !sha256Pattern.MatchString(digest) {
				continue
			}
			_ = s.Delete(ctx, Ref{ProjectID: o.Key[:strings.Index(o.Key, "/")],
				StorageBackend: BackendS3, StorageKey: o.Key, SHA256: digest})
		}
		t.Logf("cleaned %d conformance objects", len(keys))
	})
}

// rawPut overwrites an existing key with different bytes, which is how the
// suite simulates a corrupted object on a store our own Put refuses to
// overwrite (the key names the digest, so new bytes would need a new key).
func rawPut(t *testing.T, s *S3, key string, payload []byte) {
	t.Helper()
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	resp, err := s.do(context.Background(), http.MethodPut, key, nil,
		map[string]string{"content-type": "text/html"}, bytes.NewReader(payload),
		int64(len(payload)), sum)
	if err != nil {
		t.Fatalf("raw put: %v", err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("raw put: http %d", resp.StatusCode)
	}
}
