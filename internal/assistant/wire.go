package assistant

import (
	"fmt"
	"strings"
)

// The OpenAI chat-completions wire accepts only function names matching
// [A-Za-z0-9_-]{1,64} (the collective answers 400 on anything else), while the
// registry, events, audit records and API bodies keep the dotted names. The
// encoding lives at the wire boundary only: toolSpecs encodes, exec decodes
// back through the map built from the same registry, never by reverse string
// replace.

// wireName encodes one registry tool name into a legal OpenAI function name:
// every char outside [A-Za-z0-9_-] becomes "_" (project.list -> project_list).
func wireName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// toolWireMap maps each encoded wire name back to its registry name and fails
// loudly if two registry names collide on one wire name or a wire name exceeds
// the 64-char limit. It must be built at registry construction so a bad
// process never reaches the wire.
func toolWireMap() (map[string]string, error) {
	byWire := make(map[string]string, len(toolOrder))
	for _, name := range toolOrder {
		w := wireName(name)
		if len(w) > 64 {
			return nil, fmt.Errorf("assistant: wire tool name %q exceeds 64 chars", w)
		}
		if prev, dup := byWire[w]; dup {
			return nil, fmt.Errorf("assistant: tools %q and %q encode to the same wire name %q", prev, name, w)
		}
		byWire[w] = name
	}
	return byWire, nil
}
