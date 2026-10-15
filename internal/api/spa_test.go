package api

import (
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAServesFilesAndRoutes(t *testing.T) {
	srv := newTestServer(t, uiFS(), fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))

	t.Run("root serves index.html", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodGet, "http://x/", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "<title>Communication</title>") {
			t.Fatalf("body = %q", rec.Body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("index Cache-Control = %q", got)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
			t.Fatalf("index Content-Type = %q", got)
		}
	})

	t.Run("client-side route falls back to index", func(t *testing.T) {
		for _, p := range []string{"/projects/abc", "/login", "/ops", "/projects/abc/"} {
			rec := do(t, srv, request(http.MethodGet, "http://x"+p, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("%s: status = %d", p, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "<title>Communication</title>") {
				t.Fatalf("%s: body = %q", p, rec.Body)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
				t.Fatalf("%s: Cache-Control = %q", p, got)
			}
		}
	})

	t.Run("hashed assets are immutable", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodGet, "http://x/assets/index-abc123.js", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Fatalf("asset Cache-Control = %q", got)
		}
		if got := rec.Body.String(); got != "console.log(1)" {
			t.Fatalf("asset body = %q", got)
		}
	})

	t.Run("missing asset with extension is 404", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodGet, "http://x/assets/missing.js", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		decodeProblem(t, rec)
	})

	t.Run("real file wins over fallback", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodGet, "http://x/favicon.ico", nil))
		if rec.Code != http.StatusOK || rec.Body.String() != "icon" {
			t.Fatalf("status = %d body = %q", rec.Code, rec.Body)
		}
	})

	t.Run("head reads a file", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodHead, "http://x/projects/abc", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
	})

	t.Run("post to the app shell is not allowed", func(t *testing.T) {
		rec := do(t, srv, request(http.MethodPost, "http://x/projects", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
	})

	t.Run("path traversal is refused", func(t *testing.T) {
		for _, p := range []string{"/../go.mod", "/%2e%2e/go.mod", "/..%2fgo.mod"} {
			rec := do(t, srv, request(http.MethodGet, "http://x"+p, nil))
			if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "module github.com") {
				t.Fatalf("%s leaked a file outside the bundle (body %q)", p, rec.Body)
			}
		}
	})
}

func TestSPAWithoutBundle(t *testing.T) {
	srv := newTestServer(t, nil, fakeReadiness{expected: 1}, nil)
	rec := do(t, srv, request(http.MethodGet, "http://x/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, "Communication UI not built; run pnpm --dir ui build") {
		t.Fatalf("body = %q", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("content-type = %q", ct)
	}
	rec = do(t, srv, request(http.MethodGet, "http://x/projects/abc", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 without a bundle", rec.Code)
	}
}

func TestSPAFSWithoutIndexHTML(t *testing.T) {
	partial := fstest.MapFS{"assets/app-deadbeef.js": &fstest.MapFile{Data: []byte("x")}}
	srv := newTestServer(t, partial, fakeReadiness{expected: 1}, nil)
	if rec := do(t, srv, request(http.MethodGet, "http://x/", nil)); !strings.Contains(rec.Body.String(), "UI not built") {
		t.Fatalf("root without index.html: status %d body %q", rec.Code, rec.Body)
	}
	if rec := do(t, srv, request(http.MethodGet, "http://x/assets/app-deadbeef.js", nil)); rec.Code != http.StatusOK {
		t.Fatalf("existing asset should still serve, got %d", rec.Code)
	}
	if rec := do(t, srv, request(http.MethodGet, "http://x/projects/abc", nil)); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (no index.html to fall back to)", rec.Code)
	}
}
