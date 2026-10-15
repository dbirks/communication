// Package ui embeds the built Communication web UI (ui/dist, built by Vite)
// into the single communication binary so `serve` and `dev` can serve the
// SPA same-origin with the API (ADR-0007).
package ui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the embedded UI build as a filesystem rooted at ui/dist.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		// Impossible: "dist" is the embed prefix.
		panic(err)
	}
	return sub
}

// Built reports whether dist contains a real UI build (index.html) rather
// than only the committed placeholder.
func Built() bool {
	_, err := dist.ReadFile("dist/index.html")
	return err == nil
}
