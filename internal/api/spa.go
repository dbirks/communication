package api

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaNotBuiltBody is served instead of an index when no UI bundle exists.
const spaNotBuiltBody = "Communication UI not built; run pnpm --dir ui build"

// immutableCache is the caching policy for content-hashed build assets.
const immutableCache = "public, max-age=31536000, immutable"

// noCache is the caching policy for the SPA shell: clients must revalidate so
// a deploy is picked up immediately.
const noCache = "no-cache"

// spaHandler serves the single-page app from an embedded ui/dist.
//
// Files are served directly when they exist. Unknown paths without a file
// extension fall back to index.html so client-side routing (/projects/abc)
// works; unknown paths with an extension are 404s, because a missing hashed
// asset must never be masked as HTML.
type spaHandler struct {
	fsys    fs.FS // may be nil (UI not embedded in this build)
	hasBoot bool  // the fs contains an index.html
}

func newSPA(ui fs.FS) http.Handler {
	h := &spaHandler{fsys: ui}
	if ui != nil {
		if f, err := ui.Open("index.html"); err == nil {
			h.hasBoot = true
			f.Close()
		}
	}
	return h
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		WriteProblem(w, http.StatusMethodNotAllowed, "Method Not Allowed",
			"The UI is served with GET or HEAD.")
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if !fs.ValidPath(name) || strings.Contains(name, "..") {
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such path.")
		return
	}

	if h.fsys != nil {
		if fi, err := fs.Stat(h.fsys, name); err == nil && !fi.IsDir() {
			h.serveFile(w, r, name)
			return
		}
	}
	if h.fsys == nil || !h.hasBoot {
		// No UI bundle to fall back on: the root explains how to build it.
		if name == "index.html" {
			h.servePlainText(w, r)
			return
		}
		WriteProblem(w, http.StatusNotFound, "Not Found",
			"No such resource, and no UI bundle is embedded.")
		return
	}
	// Client-side route fallback: only for extension-less paths.
	if path.Ext(name) == "" {
		h.serveFile(w, r, "index.html")
		return
	}
	WriteProblem(w, http.StatusNotFound, "Not Found", "No such resource.")
}

// serveFile writes one file from the bundle with the right caching policy.
func (h *spaHandler) serveFile(w http.ResponseWriter, r *http.Request, name string) {
	if name == "index.html" || !strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", noCache)
	} else {
		// Vite emits content-hashed names under /assets/, safe to cache forever.
		w.Header().Set("Cache-Control", immutableCache)
	}
	// ServeFileFS handles If-Modified-Since/Range, Content-Type by extension
	// and the HEAD body suppression.
	http.ServeFileFS(w, r, h.fsys, name)
}

func (h *spaHandler) servePlainText(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", noCache)
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write([]byte(spaNotBuiltBody + "\n"))
}
