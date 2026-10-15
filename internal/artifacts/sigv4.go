package artifacts

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// SigV4Algorithm is the only signing algorithm this client speaks.
const SigV4Algorithm = "AWS4-HMAC-SHA256"

// UnsignedPayload is the hashed-payload value a presigned URL declares: the
// requester has no body, and the signature is what authorizes rather than a
// digest of nothing.
const UnsignedPayload = "UNSIGNED-PAYLOAD"

// EmptyPayloadHash is sha256("") — the payload hash of a bodyless request
// (GET, HEAD, DELETE). Every SigV4 request must name its payload hash, which
// is why an artifact PUT can use the real digest: we spooled the bytes first.
const EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const (
	sigV4Service      = "s3"
	sigV4Request      = "aws4_request"
	timeFormatAMZ     = "20060102T150405Z"
	timeFormatCompact = "20060102"
)

// AmzStamp renders the X-Amz-Date / credential-scope timestamp.
func AmzStamp(t time.Time) string { return t.UTC().Format(timeFormatAMZ) }

// CredentialScope is the "<date>/<region>/s3/aws4_request" string that appears
// in both the credential and the string-to-sign.
func CredentialScope(t time.Time, region string) string {
	if region == "" {
		region = "us-east-1"
	}
	return t.UTC().Format(timeFormatCompact) + "/" + region + "/" + sigV4Service + "/" + sigV4Request
}

// URIEncode percent-encodes everything outside RFC 3986's unreserved set. It
// is used instead of url.QueryEscape because SigV4's canonical form differs from
// Go's default escaping in exactly two ways that matter: space becomes %20 and
// not '+', and '~' is left alone. Getting either wrong changes the signature.
//
// encodeSlash is true for query values and false for path segments, where the
// separator must survive.
func URIEncode(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// CanonicalQuery renders query parameters the way SigV4 demands: sorted by
// encoded key (then value), each pair `k=v` with both halves URI-encoded,
// joined by '&'.
func CanonicalQuery(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(q))
	for k, vs := range q {
		ek := URIEncode(k, true)
		for _, v := range vs {
			pairs = append(pairs, ek+"="+URIEncode(v, true))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

// CanonicalRequest is the first half of the signature:
//
//	METHOD \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n \n
//	SignedHeaders \n HashedPayload
//
// CanonicalURI must already be encoded and must keep its '/' separators. The
// trailing blank line after the headers is part of the format, not decoration.
func CanonicalRequest(method, canonicalURI, canonicalQuery string, headers map[string]string,
	payloadHash string) string {
	norm := make(map[string]string, len(headers))
	names := make([]string, 0, len(headers))
	for k, v := range headers {
		lk := strings.ToLower(k)
		norm[lk] = canonicalHeaderValue(v)
		if _, dup := norm[lk]; dup {
			names = names[:len(names)] // a repeated name is the same header
		}
	}
	names = names[:0]
	for k := range norm {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString(strings.ToUpper(method))
	b.WriteByte('\n')
	b.WriteString(canonicalURI)
	b.WriteByte('\n')
	b.WriteString(canonicalQuery)
	b.WriteByte('\n')
	for _, n := range names {
		b.WriteString(n)
		b.WriteByte(':')
		b.WriteString(norm[n])
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	b.WriteString(strings.Join(names, ";"))
	b.WriteByte('\n')
	b.WriteString(payloadHash)
	return b.String()
}

// SignedHeaderNames returns the ';' joined list CanonicalRequest computes.
func SignedHeaderNames(headers map[string]string) string {
	seen := make(map[string]struct{}, len(headers))
	names := make([]string, 0, len(headers))
	for k := range headers {
		lk := strings.ToLower(k)
		if _, dup := seen[lk]; dup {
			continue
		}
		seen[lk] = struct{}{}
		names = append(names, lk)
	}
	sort.Strings(names)
	return strings.Join(names, ";")
}

// canonicalHeaderValue trims a header value the way SigV4 requires: leading
// and trailing whitespace removed, and runs of internal whitespace collapsed to
// a single space (a multi-value header is joined with ", " before it gets here).
func canonicalHeaderValue(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return strings.Join(strings.Fields(v), " ")
}

// StringToSign is the second half: the algorithm, the timestamp, the scope and
// the digest of the canonical request.
func StringToSign(canonicalRequest, amzDate, credentialScope string) string {
	sum := sha256.Sum256([]byte(canonicalRequest))
	return SigV4Algorithm + "\n" + amzDate + "\n" + credentialScope + "\n" + hex.EncodeToString(sum[:])
}

// SigningKey derives the per-day, per-region, per-service key:
//
//	kDate    = HMAC("AWS4" + secret, date)
//	kRegion  = HMAC(kDate, region)
//	kService = HMAC(kRegion, "s3")
//	kSigning = HMAC(kService, "aws4_request")
func SigningKey(secret, dateStamp, region string) []byte {
	k := []byte("AWS4" + secret)
	k = hmacSHA256(k, dateStamp)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, sigV4Service)
	return hmacSHA256(k, sigV4Request)
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// Sign is the whole derivation for one (canonical request, timestamp) pair.
// It is exported only inside the module and is the function the known-answer
// tests pin.
func Sign(secret, accessKey, region, amzDate, canonicalRequest string) string {
	scope := amzDate[:8] + "/" + region + "/" + sigV4Service + "/" + sigV4Request
	sts := StringToSign(canonicalRequest, amzDate, scope)
	sum := hmacSHA256(SigningKey(secret, amzDate[:8], region), sts)
	return hex.EncodeToString(sum)
}

// SignedHeaderMap is the header set an ordinary (non-presigned) request signs:
// host, the date, the payload hash, plus whatever the operation needs.
func SignedHeaderMap(host string, extra map[string]string, payloadHash string, when time.Time) map[string]string {
	signed := map[string]string{
		"host":                 host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           AmzStamp(when),
	}
	for k, v := range extra {
		signed[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	return signed
}

// RequestAuthorization computes the full Authorization header value for a
// signed request.
func RequestAuthorization(secret, accessKey, region, method, host, canonicalURI, canonicalQuery string,
	headers map[string]string, payloadHash string, when time.Time) string {
	amz := AmzStamp(when)
	cr := CanonicalRequest(method, canonicalURI, canonicalQuery, headers, payloadHash)
	sig := Sign(secret, accessKey, region, amz, cr)
	return fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		SigV4Algorithm, accessKey, CredentialScope(when, region), SignedHeaderNames(headers), sig)
}

// PresignSignature computes the X-Amz-Signature value for a presigned URL. The
// signed-header set is `host` alone (AWS requires it and nothing else for a
// query-authenticated GET), and the payload hash is the UNSIGNED-PAYLOAD
// literal, which is what makes a bodyless presign stable across clients that
// add headers of their own.
func PresignSignature(secret, accessKey, region, method, host, canonicalURI string,
	query url.Values, when time.Time) string {
	q := url.Values{}
	for k, vs := range query {
		for _, v := range vs {
			q.Add(k, v)
		}
	}
	q.Del("X-Amz-Signature") // the signature never signs itself
	headers := map[string]string{"host": host}
	cr := CanonicalRequest(method, canonicalURI, CanonicalQuery(q), headers, UnsignedPayload)
	return Sign(secret, accessKey, region, AmzStamp(when), cr)
}
