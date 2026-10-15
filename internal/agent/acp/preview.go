package acp

import (
	"encoding/json"
	"fmt"

	"github.com/coder/acp-go-sdk"
)

// maxToolPreviewBytes bounds what one tool update may contribute to the
// normalized stream. The transcript stores only bounded previews
// (ADR-0016 §7: "tool payloads carry previews only, bounded by the worker,
// always with truncated"); clipping happens twice on purpose — here at the
// protocol edge so a 10 MB rawOutput never crosses the channel, and again in
// the worker when it writes the journal row.
const maxToolPreviewBytes = 2048

// previewValue renders any JSON-ish tool input/output as a bounded one-line
// string. truncated is true when bytes were dropped.
func previewValue(v any, max int) (string, bool) {
	if v == nil {
		return "", false
	}
	var s string
	switch t := v.(type) {
	case string:
		s = t
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return "", false
		}
		s = string(raw)
	}
	return truncateUTF8(s, max)
}

// truncateUTF8 cuts s to at most max bytes without splitting a rune,
// reporting whether it cut anything.
func truncateUTF8(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	cut := max
	for cut > 0 && !isUTF8Start(s[cut]) {
		cut--
	}
	return s[:cut], true
}

func isUTF8Start(b byte) bool { return b&0xC0 != 0x80 }

// toolContentText extracts displayable text from tool call content blocks,
// bounded by max across all blocks (first-wins, truncated flagged by the
// caller's own length check).
func toolContentText(blocks []acp.ToolCallContent, max int) string {
	out := ""
	for _, b := range blocks {
		if b.Content != nil && b.Content.Content.Text != nil {
			out += b.Content.Content.Text.Text
		} else if b.Diff != nil {
			out += fmt.Sprintf("diff %s (+%d bytes)", b.Diff.Path, len(b.Diff.NewText))
		}
		if len(out) >= max {
			break
		}
	}
	if out == "" {
		return ""
	}
	s, _ := truncateUTF8(out, max)
	return s
}
