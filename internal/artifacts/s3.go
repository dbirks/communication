package artifacts

import (
	"context"
	"crypto/sha256"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrUnauthorized means the store rejected our credentials or signature. It is
// distinct from ErrNotFound so an operator can tell a broken deployment from a
// missing object (and distinct from a *caller's* 401, which is an API-layer
// concept this package never sees).
var ErrUnauthorized = errors.New("artifacts: the object store rejected our credentials")

// S3Config configures the S3-compatible backend (ADR-0020 D7's contract).
type S3Config struct {
	// Endpoint is the scheme://host[:port] of the S3 speaker, e.g.
	// http://seaweedfs:8333. No path, no credentials, no query.
	Endpoint string
	// Bucket is the one prefix this deployment may write under. ADR-0020 D7
	// forbids credentials broader than one bucket prefix, and forbids us ever
	// listing all buckets, creating one, or touching an ACL.
	Bucket string
	// AccessKey / SecretKey are the deployment's own storage credentials, from
	// the environment — never from a SecretRef, because "a storage credential
	// that can write artifacts cannot be an artifact of the system it stores"
	// (ADR-0020 D7).
	AccessKey string
	SecretKey string
	// Region enters the credential scope. SeaweedFS ignores the value, AWS
	// does not. Default "us-east-1".
	Region string
	// SpoolDir is where Put stages bytes to learn their digest. Required: it
	// must be an absolute, non-temp directory the worker owns (ADR-0019 P9 —
	// a directory a sandboxed agent can write is never trusted as a source of
	// artifact bytes).
	SpoolDir string
	// ForcePathStyle addresses `endpoint/bucket/key` instead of
	// `bucket.endpoint/key`. ADR-0020 D7 asks for virtual-host style, and the
	// lab cannot use it: SeaweedFS on a compose network name has no wildcard
	// DNS, so `m3art-conformance.seaweedfs:8333` does not resolve. It is
	// therefore the default here; virtual-host style is implemented and
	// exercised by the same suite so a real bucket can switch without a code
	// change. (Evidence-forced deviation from ADR-0020 D7, recorded in the M3
	// report.)
	ForcePathStyle bool
	// ServerSideEncryption sends `x-amz-server-side-encryption: AES256`, one of
	// ADR-0020 D7's bucket requirements. It is opt-in because the lab's S3
	// speaker answers such a PUT with `500 InternalError` (observed against
	// chrislusf/seaweedfs:4.48 in the M3 artifact conformance run): a header
	// the store cannot honour must not be sent to it, and a deployment on a
	// store that does honour it turns the flag on.
	ServerSideEncryption bool
	// HTTPClient defaults to a clone of http.DefaultTransport.
	HTTPClient *http.Client
}

// S3 is the S3-compatible backend, speaking the SigV4 REST surface with the
// standard library only (see sigv4.go). Hand-rolling the client is what makes
// ADR-0020 D7's allow-list real: "uses only PutObject, GetObject, HeadObject,
// DeleteObject, ListObjectsV2 and presigned GET" is checkable in six methods,
// whereas an SDK would put `PutObjectAcl`, `ListAllMyBuckets` and every
// `Create*` call one typo away from a production code path.
type S3 struct {
	cfg    S3Config
	scheme string
	host   string
	client *http.Client
	now    func() time.Time
}

var (
	_ Store   = (*S3)(nil)
	_ Sweeper = (*S3)(nil)
)

// bucketNamePattern is S3's naming rule: 3-63 characters of lowercase
// alphanumerics and hyphens, in dot-separated label-like segments. Validating
// it is not pedantry — an invalid name comes back as a confusing
// SecondLevelDomainError or a 301.
var bucketNamePattern = regexp.MustCompile(
	`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

// NewS3 validates cfg. Like NewLocal it does not reach the network: a
// deployment that cannot see its bucket must fail readiness, not startup.
func NewS3(cfg S3Config) (*S3, error) {
	if cfg.Bucket == "" || !bucketNamePattern.MatchString(cfg.Bucket) {
		return nil, fmt.Errorf("%w: bucket %q is not a valid S3 bucket name", ErrInvalidInput, cfg.Bucket)
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("%w: the S3 backend needs an access key and a secret key from the deployment",
			ErrInvalidInput)
	}
	u, err := url.Parse(strings.TrimRight(cfg.Endpoint, "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("%w: endpoint %q is not scheme://host[:port]", ErrInvalidInput, cfg.Endpoint)
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return nil, fmt.Errorf("%w: endpoint %q must be a bare scheme://host[:port]", ErrInvalidInput, cfg.Endpoint)
	}
	if err := RejectTempRoot(cfg.SpoolDir); err != nil {
		return nil, err
	}
	if cfg.SpoolDir == "" || !strings.HasPrefix(cfg.SpoolDir, "/") {
		return nil, fmt.Errorf("%w: S3 spool dir %q must be absolute", ErrInvalidInput, cfg.SpoolDir)
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	client := cfg.HTTPClient
	if client == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.MaxIdleConnsPerHost = 8
		client = &http.Client{Transport: tr} // the per-request context does the timing out
	}
	return &S3{
		cfg:    cfg,
		scheme: u.Scheme,
		host:   u.Host,
		client: client,
		now:    func() time.Time { return time.Now().UTC() },
	}, nil
}

// WithClock replaces the signing clock. Only tests use it: a signature is a
// function of time, and a known-answer test needs a time that is not "now".
func (s *S3) WithClock(now func() time.Time) *S3 {
	s.now = now
	return s
}

// Backend reports the artifacts.storage_backend value rows written here carry.
func (*S3) Backend() string { return BackendS3 }

// objectURL lays out the request target for a key. Both addressing styles are
// signed, so a deployment's choice is configuration rather than code.
func (s *S3) objectURL(key string) (host, uri string, err error) {
	if _, _, _, err := ParseKey(key); err != nil {
		return "", "", err
	}
	if s.cfg.ForcePathStyle {
		return s.host, "/" + s.cfg.Bucket + "/" + URIEncode(key, false), nil
	}
	return s.cfg.Bucket + "." + s.host, "/" + URIEncode(key, false), nil
}

// Put uploads Body. It streams through the same spool as the local backend
// because the object key is the content digest *and* SigV4 signs the payload
// hash: both need the bytes seen once before the request is built. The body is
// never held whole in memory — the spool file is reopened and streamed with a
// known Content-Length.
func (s *S3) Put(ctx context.Context, in Input) (Ref, error) {
	if err := in.Validate(); err != nil {
		return Ref{}, err
	}
	limit := putLimit(in)
	tmpPath, digest, size, err := writeSpool(ctx, s.cfg.SpoolDir, in.Body, limit)
	if err != nil {
		return Ref{}, err
	}
	defer os.Remove(tmpPath)

	key, err := BuildKey(in.ProjectID, in.Kind, digest, in.MediaType)
	if err != nil {
		return Ref{}, err
	}
	f, err := os.Open(tmpPath)
	if err != nil {
		return Ref{}, fmt.Errorf("artifacts: reopen spool: %w", err)
	}
	defer f.Close()

	headers := map[string]string{"content-type": in.MediaType}
	if s.cfg.ServerSideEncryption {
		headers["x-amz-server-side-encryption"] = "AES256"
	}
	resp, err := s.do(ctx, http.MethodPut, key, nil, headers, f, size, digest)
	if err != nil {
		return Ref{}, err
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return Ref{}, s3Error("PutObject", key, resp)
	}
	return Ref{
		ID: in.ArtifactID, ProjectID: in.ProjectID, StorageBackend: BackendS3,
		StorageKey: key, SHA256: digest, SizeBytes: size, MediaType: in.MediaType,
	}, nil
}

// Open downloads the object and verifies the digest as it drains.
//
// Verification happens on read rather than trusting an ETag because an S3 ETag
// is not a SHA-256 (single-part uploads use MD5, multipart uses
// `<md5>-<partcount>`), so it cannot prove what the key claims. The cost —
// hashing every byte served — is the price of a verifiable claim; the
// alternative is trusting the store, which is what content addressing exists
// to avoid.
func (s *S3) Open(ctx context.Context, ref Ref) (io.ReadCloser, int64, error) {
	if err := ValidateRef(ref); err != nil {
		return nil, 0, err
	}
	resp, err := s.do(ctx, http.MethodGet, ref.StorageKey, nil, nil, nil, 0, EmptyPayloadHash)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		defer drain(resp)
		return nil, 0, s3Error("GetObject", ref.StorageKey, resp)
	}
	size := resp.ContentLength
	if h := resp.Header.Get("Content-Length"); h != "" {
		if n, err := strconv.ParseInt(h, 10, 64); err == nil {
			size = n
		}
	}
	if ref.SizeBytes > 0 && size > 0 && size != ref.SizeBytes {
		defer drain(resp)
		return nil, 0, fmt.Errorf("%w: row claims %d bytes, object is %d",
			ErrDigestMismatch, ref.SizeBytes, size)
	}
	return &verifyingReader{rc: resp.Body, h: sha256.New(), want: ref.SHA256}, size, nil
}

// Stat is HeadObject: existence plus size agreement with the row.
//
// It cannot hash, because a HEAD returns no bytes and no S3 header carries our
// digest — so on this backend the tampering assertion is proven through Open's
// stream verification, and Stat proves the weaker, honestly-stated claim
// ("the object exists and is the length the row says"). Conformance asserts
// exactly that per backend.
func (s *S3) Stat(ctx context.Context, ref Ref) (Ref, error) {
	if err := ValidateRef(ref); err != nil {
		return Ref{}, err
	}
	resp, err := s.do(ctx, http.MethodHead, ref.StorageKey, nil, nil, nil, 0, EmptyPayloadHash)
	if err != nil {
		return Ref{}, err
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusNotFound {
		return Ref{}, fmt.Errorf("%w: %s", ErrNotFound, ref.StorageKey)
	}
	if resp.StatusCode != http.StatusOK {
		return Ref{}, s3Error("HeadObject", ref.StorageKey, resp)
	}
	out := ref
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		n, err := strconv.ParseInt(cl, 10, 64)
		if err != nil {
			return Ref{}, fmt.Errorf("artifacts: HeadObject returned Content-Length %q", cl)
		}
		if ref.SizeBytes > 0 && n != ref.SizeBytes {
			return Ref{}, fmt.Errorf("%w: row claims %d bytes, object is %d", ErrDigestMismatch, ref.SizeBytes, n)
		}
		out.SizeBytes = n
	}
	if mt := resp.Header.Get("Content-Type"); mt != "" {
		out.MediaType = mt
	}
	return out, nil
}

// Delete issues DeleteObject. With bucket versioning on (ADR-0020 D7's
// requirement) that writes a delete marker rather than destroying bytes, which
// is deliberate: final retention then belongs to a lifecycle rule the operator
// owns, not to our sweep alone.
func (s *S3) Delete(ctx context.Context, ref Ref) error {
	if err := ValidateRef(ref); err != nil {
		return err
	}
	resp, err := s.do(ctx, http.MethodDelete, ref.StorageKey, nil, nil, nil, 0, EmptyPayloadHash)
	if err != nil {
		return err
	}
	defer drain(resp)
	// A delete of a missing object is reported as success by S3 (204); a 404
	// from a non-conforming speaker is treated the same way so the sweep stays
	// idempotent against a re-run.
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return s3Error("DeleteObject", ref.StorageKey, resp)
	}
	return nil
}

// Presign builds a SigV4 presigned GET — the one presign ADR-0020 D7 allows.
// Only `host` is signed, so a header the fetcher adds cannot break the
// signature, and the URL's only secret is a signature that expires.
func (s *S3) Presign(ctx context.Context, ref Ref, ttl time.Duration, disposition string) (string, time.Time, error) {
	if err := ValidateRef(ref); err != nil {
		return "", time.Time{}, err
	}
	if err := contextErr(ctx); err != nil {
		return "", time.Time{}, err
	}
	// Presigning for a key we would refuse to read is not a thing: ValidateRef
	// above already bound the key to the digest.
	host, uri, err := s.objectURL(ref.StorageKey)
	if err != nil {
		return "", time.Time{}, err
	}
	if s.scheme == "http" && !privateHost(s.host) {
		// A presigned URL is a bearer credential. Over plaintext anyone on the
		// path can replay it inside the expiry window, so http is allowed only
		// against loopback or private names — which is exactly what the lab's
		// compose network is (and why SeaweedFS publishes no host port for its
		// S3 API in the shipped stack).
		return "", time.Time{}, fmt.Errorf(
			"%w: a presigned URL over http requires a loopback or private endpoint, got %q",
			ErrInvalidInput, host)
	}
	when := s.now()
	expiry := ClampTokenTTL(ttl)
	q := url.Values{}
	q.Set("X-Amz-Algorithm", SigV4Algorithm)
	q.Set("X-Amz-Credential", s.cfg.AccessKey+"/"+CredentialScope(when, s.cfg.Region))
	q.Set("X-Amz-Date", AmzStamp(when))
	q.Set("X-Amz-Expires", strconv.FormatInt(int64(expiry.Seconds()), 10))
	q.Set("X-Amz-SignedHeaders", "host")
	if disposition != "" {
		// response-content-disposition is the only response override the
		// contract permits, and it must be inside the signature — an unsigned
		// one would let anyone rewrite the download filename.
		q.Set("response-content-disposition", disposition)
	}
	sig := PresignSignature(s.cfg.SecretKey, s.cfg.AccessKey, s.cfg.Region,
		http.MethodGet, host, uri, q, when)
	q.Set("X-Amz-Signature", sig)

	u := &url.URL{Scheme: s.scheme, Host: host, Path: uri, RawQuery: q.Encode()}
	return u.String(), when.Add(expiry).Truncate(time.Second), nil
}

// List walks the bucket under prefix with ListObjectsV2 (ADR-0020 D7's sweep
// call), following continuation tokens. prefix is always server-supplied (a
// project id), and keys are never user-supplied anywhere in this package.
func (s *S3) List(ctx context.Context, prefix string, fn func(Object) error) error {
	if strings.Contains(prefix, "..") || strings.HasPrefix(prefix, "/") {
		return fmt.Errorf("%w: listing prefix %q", ErrInvalidInput, prefix)
	}
	token := ""
	for {
		q := url.Values{}
		q.Set("list-type", "2")
		q.Set("encoding-type", "url")
		if prefix != "" {
			q.Set("prefix", prefix)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, err := s.doBucket(ctx, q)
		if err != nil {
			return err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		_ = resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("artifacts: read ListObjectsV2 page: %w", readErr)
		}
		if resp.StatusCode != http.StatusOK {
			return decodeS3Error("ListObjectsV2", resp.StatusCode, body)
		}
		var page listBucketResultV2
		if err := xml.Unmarshal(body, &page); err != nil {
			return fmt.Errorf("artifacts: decode ListObjectsV2 page: %w", err)
		}
		for _, c := range page.Contents {
			key := c.Key
			if page.EncodingType == "url" {
				if dec, err := url.QueryUnescape(key); err == nil {
					key = dec
				}
			}
			obj := Object{Key: key, SizeBytes: c.Size}
			if c.LastModified != "" {
				if t, err := time.Parse(time.RFC3339, c.LastModified); err == nil {
					obj.ModTime = t.UTC()
				}
			}
			if err := fn(obj); err != nil {
				return err
			}
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return nil
		}
		token = page.NextContinuationToken
		if err := contextErr(ctx); err != nil {
			return err
		}
	}
}

type listBucketResultV2 struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	Name                  string   `xml:"Bucket"`
	Prefix                string   `xml:"Prefix"`
	EncodingType          string   `xml:"EncodingType"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken"`
	Contents              []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
}

// doBucket sends a bucket-level request (the ListObjectsV2 target has no
// object key, so it cannot go through objectURL).
func (s *S3) doBucket(ctx context.Context, q url.Values) (*http.Response, error) {
	host, uri := s.host, "/"+s.cfg.Bucket
	if !s.cfg.ForcePathStyle {
		host, uri = s.cfg.Bucket+"."+s.host, "/"
	}
	req, err := s.build(ctx, http.MethodGet, host, uri, q, nil, EmptyPayloadHash, nil, 0)
	if err != nil {
		return nil, err
	}
	return s.client.Do(req)
}

// do builds, signs and sends one object request.
func (s *S3) do(ctx context.Context, method, key string, q url.Values, headers map[string]string,
	body io.Reader, size int64, payloadHash string) (*http.Response, error) {
	host, uri, err := s.objectURL(key)
	if err != nil {
		return nil, err
	}
	req, err := s.build(ctx, method, host, uri, q, headers, payloadHash, body, size)
	if err != nil {
		return nil, err
	}
	return s.client.Do(req)
}

// build assembles the request with its SigV4 headers attached.
func (s *S3) build(ctx context.Context, method, host, uri string, q url.Values,
	headers map[string]string, payloadHash string, body io.Reader, size int64) (*http.Request, error) {
	target := s.scheme + "://" + host + uri
	if len(q) > 0 {
		target += "?" + CanonicalQuery(q)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("artifacts: build request: %w", err)
	}
	// The signature covers `host`, so the value on the wire must be exactly
	// the value signed. net/http takes the outbound Host header from req.Host.
	req.Host = host
	req.Header.Set("X-Amz-Date", AmzStamp(s.now()))
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != nil {
		if size < 0 {
			return nil, fmt.Errorf("%w: a streamed body needs a length", ErrInvalidInput)
		}
		req.ContentLength = size
	}
	signed := SignedHeaderMap(host, headers, payloadHash, s.now())
	req.Header.Set("Authorization", RequestAuthorization(
		s.cfg.SecretKey, s.cfg.AccessKey, s.cfg.Region, method, host, uri,
		CanonicalQuery(q), signed, payloadHash, s.now()))
	return req, nil
}

// s3Error turns a non-2xx into an error, mapping 404 onto ErrNotFound so
// callers can tell "absent" from "the store is unhappy" without parsing XML.
func s3Error(op, key string, resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	return fmt.Errorf("%s %s: %w", op, key, decodeS3Error(op, resp.StatusCode, body))
}

// s3ErrorResponse is the S3 REST error document.
type s3ErrorResponse struct {
	XMLName xml.Name `xml:"Error"`
	Code    string   `xml:"Code"`
	Message string   `xml:"Message"`
	Request string   `xml:"RequestId"`
}

// decodeS3Error names the failure without echoing the response body into an
// error string: a body can contain a key from another project, and errors here
// end up in logs.
func decodeS3Error(op string, status int, body []byte) error {
	code := ""
	var doc s3ErrorResponse
	if xml.Unmarshal(body, &doc) == nil {
		code = doc.Code
	}
	switch {
	case status == http.StatusNotFound, code == "NoSuchKey", code == "NoSuchBucket":
		return ErrNotFound
	case status == http.StatusForbidden, code == "SignatureDoesNotMatch",
		code == "AccessDenied", code == "InvalidAccessKeyId":
		return fmt.Errorf("%w: %s http %d (%s)", ErrUnauthorized, op, status, code)
	case status == http.StatusRequestEntityTooLarge, code == "EntityTooLarge":
		return ErrTooLarge
	}
	return fmt.Errorf("%s: http %d (%s)", op, status, code)
}

// drain reads and closes a response body so the connection can be reused,
// bounded so a misbehaving store cannot pin memory.
func drain(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	_ = resp.Body.Close()
}

// privateHost reports loopback and RFC1918-ish names, the only places an
// unsigned-transport presigned URL may be pointed (see Presign).
func privateHost(host string) bool {
	h := host
	if i := strings.LastIndexByte(h, ':'); i > 0 {
		h = h[:i]
	}
	switch {
	case h == "localhost" || strings.HasSuffix(h, ".localhost"),
		strings.HasSuffix(h, ".local"), strings.HasSuffix(h, ".internal"),
		!strings.Contains(h, "."):
		// A single-label name resolves only inside its own network namespace,
		// which is what a compose service name is.
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate()
	}
	for _, p := range []string{"127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
		"172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.",
		"172.28.", "172.29.", "172.30.", "172.31."} {
		if strings.HasPrefix(h, p) {
			return true
		}
	}
	return false
}
