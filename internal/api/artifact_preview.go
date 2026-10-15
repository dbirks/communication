package api

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
)

// The sandboxed HTML preview origin (ADR-0020 D6, `12-test-strategy` case 16).
//
// Two independent mechanisms keep an artifact's script away from a session:
// the *origin* (a different hostname, so the browser carries no
// `localhost` cookie to `preview.localhost`) and CSP `sandbox` (an opaque
// origin, so the document cannot reach the app's DOM, storage or
// localStorage even if a future deployment collapses the hostname difference).
// Neither one is a trick that the other can undo, which is the reason M3 ships
// both.
//
// The headers below are the contract, quoted in order from ADR-0020 D6:
//
//	Content-Security-Policy: sandbox
//	Content-Security-Policy: default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'
//	X-Content-Type-Options: nosniff
//	Content-Disposition: inline
//	Referrer-Policy: no-referrer
//	Cache-Control: no-store
//	Cross-Origin-Opener-Policy: same-origin
//	Cross-Origin-Resource-Policy: same-origin
//
// Two CSP headers are intentional: `sandbox` is what makes the document an
// opaque origin, and the second one is what stops it loading anything else out
// of the network. `Sandbox:` (the Fetch Metadata header) is not used — CSP
// `sandbox` is the mechanism, applied on the document.
//
// Range requests are refused here (ADR-0020 Security): partial rendering of an
// untrusted document buys nothing and a byte-range oracle is one more thing to
// reason about.

// previewHandlers serves one route: GET /preview/{token}.
type previewHandlers struct {
	host   string
	tokens PreviewTokens
	store  PreviewStore
	bytes  ArtifactBytes
	srv    *Server
}

// tokenErrors maps token failures onto the answer the contract pins: 401 on the
// preview origin, with no hint about which check failed beyond "it is not
// valid" (a minted token is the only credential here, and explaining why one
// failed helps nobody who does not already have a valid one).
func (h *previewHandlers) serve(w http.ResponseWriter, r *http.Request) {
	log := h.log(r)
	if !h.hostMatches(r) {
		// The app origin does not serve previews at all — the SPA shell would
		// otherwise answer this path with index.html, which is exactly the
		// "same origin" bug case 16 exists to catch.
		h.refuse(w, r)
		return
	}
	// A preview document has no session and must never inherit one. Cookies
	// are host-scoped so the browser sends none; deleting the header here is
	// the belt that catches a deployment where that stops being true (a shared
	// wildcard cookie jar, a mis-set Domain, a proxy that adds one).
	if cookie := r.Header.Get("Cookie"); cookie != "" {
		r.Header.Del("Cookie")
		log.WarnContext(r.Context(), "stripped a cookie from a preview request",
			slog.String("host", r.Host),
			slog.String("request_id", RequestIDFrom(r)))
	}
	if r.Header.Get("Authorization") != "" {
		r.Header.Del("Authorization")
	}
	if r.Header.Get("Range") != "" {
		w.Header().Set("Accept-Ranges", "none")
		WriteProblem(w, http.StatusRequestedRangeNotSatisfiable, "Range Not Satisfiable",
			"The preview origin does not serve partial documents.")
		return
	}
	if h.tokens == nil || h.store == nil || h.bytes == nil {
		h.serverError(w, r, errors.New("api: preview origin is missing its signer, store or byte backend"))
		return
	}

	token, err := h.tokens.Verify(r.PathValue("token"), time.Now().UTC())
	if err != nil {
		// Expired and invalid are the same answer with the same shape, and the
		// distinction is only ever useful to whoever already holds the token.
		status := http.StatusUnauthorized
		title := "Preview Token Invalid"
		if errors.Is(err, artifacts.ErrTokenExpired) {
			title = "Preview Token Expired"
		}
		log.WarnContext(r.Context(), "refused a preview token",
			slog.String("reason", err.Error()),
			slog.String("request_id", RequestIDFrom(r)))
		h.previewProblem(w, status, title, "This preview URL is not valid.")
		return
	}
	if token.Scope != artifacts.ScopePreview {
		h.previewProblem(w, http.StatusUnauthorized, "Preview Token Invalid",
			"This preview URL is not valid.")
		return
	}

	view, err := h.store.ArtifactForPreview(r.Context(), token.ArtifactID)
	if err != nil {
		if errors.Is(err, ErrArtifactNotFound) {
			h.previewProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
			return
		}
		h.serverError(w, r, err)
		return
	}
	// The token carries the digest, and the row must still agree with it. This
	// is the check that makes "a token cannot be re-pointed at another row"
	// true even after a retention sweep and a re-Put of different bytes under
	// the same artifact id.
	if view.SHA256 != token.SHA256 || view.State != "ready" {
		h.previewProblem(w, http.StatusUnauthorized, "Preview Token Invalid",
			"This preview URL is not valid.")
		return
	}
	if !artifacts.Previewable(view.Kind, view.Sensitivity) {
		// A sensitivity change outranks a previously minted token.
		h.previewProblem(w, http.StatusForbidden, "Forbidden",
			"This artifact cannot be previewed.")
		return
	}

	rc, size, err := h.bytes.Open(r.Context(), artifacts.Ref{
		ID: view.ID, ProjectID: view.ProjectID, StorageBackend: view.StorageBackend,
		StorageKey: view.StorageKey, SHA256: view.SHA256, SizeBytes: view.SizeBytes,
		MediaType: view.MediaType,
	})
	if err != nil {
		if errors.Is(err, artifacts.ErrNotFound) || errors.Is(err, artifacts.ErrDigestMismatch) {
			h.previewProblem(w, http.StatusNotFound, "Not Found", "No such artifact.")
			return
		}
		h.serverError(w, r, err)
		return
	}
	defer rc.Close()

	hhdr := w.Header()
	// The document is untrusted content, so the header set is the ADR's list
	// verbatim; see the file comment for what each one is for.
	hhdr.Add("Content-Security-Policy", "sandbox")
	hhdr.Add("Content-Security-Policy", "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'")
	hhdr.Set("X-Content-Type-Options", "nosniff")
	hhdr.Set("Content-Disposition", "inline")
	hhdr.Set("Referrer-Policy", "no-referrer")
	hhdr.Set("Cache-Control", "no-store")
	hhdr.Set("Cross-Origin-Opener-Policy", "same-origin")
	hhdr.Set("Cross-Origin-Resource-Policy", "same-origin")
	hhdr.Set("X-Content-Type-Options", "nosniff")
	if view.MediaType == "text/html" {
		hhdr.Set("Content-Type", "text/html; charset=utf-8")
	} else {
		hhdr.Set("Content-Type", view.MediaType)
	}
	if size > 0 {
		hhdr.Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil {
		log.WarnContext(r.Context(), "preview stream ended early",
			slog.String("artifact_id", view.ID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
	}
}

// refuse answers the preview host's everything-else case, and the app host's
// /preview/* case, with the same 404 problem+json — never with the SPA shell.
func (h *previewHandlers) refuse(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, http.StatusNotFound, "Not Found", "no endpoint "+r.Method+" "+r.URL.Path)
}

// originOnly completes ADR-0020 D6's second half: on the preview host, nothing
// but /preview/* exists. Without it a mis-routed request would reach the SPA
// shell, which is a same-origin document with the app's script in it — a much
// better target than an artifact.
func (h *previewHandlers) originOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.hostMatches(r) && !strings.HasPrefix(r.URL.Path, "/preview/") && r.URL.Path != "/preview" {
			WriteProblem(w, http.StatusNotFound, "Not Found", "The preview origin serves previews only.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// hostMatches compares the Host header to the configured preview host,
// case-insensitively and with the port optional (a request arriving as
// `Preview.LocalHost` or `preview.localhost` behind a proxy is the same
// origin to a browser, and cookie scope follows the hostname, not its case).
func (h *previewHandlers) hostMatches(r *http.Request) bool {
	if h.host == "" {
		return false
	}
	want := strings.ToLower(h.host)
	got := strings.ToLower(r.Host)
	if got == want {
		return true
	}
	if i := strings.LastIndexByte(got, ':'); i > 0 && !strings.Contains(want, ":") {
		got = got[:i]
	}
	return got == want
}

// previewProblem writes the preview origin's errors. They are problem+json for
// consistency, and carry no artifact metadata: a 404 here must not confirm
// that the artifact id in the token was real.
func (h *previewHandlers) previewProblem(w http.ResponseWriter, status int, title, detail string) {
	WriteProblem(w, status, title, detail)
}

func (h *previewHandlers) serverError(w http.ResponseWriter, r *http.Request, err error) {
	h.log(r).ErrorContext(r.Context(), "preview failure",
		slog.String("request_id", RequestIDFrom(r)),
		slog.Any("error", err))
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not complete the request. Use the request id when reporting it.")
}

func (h *previewHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
