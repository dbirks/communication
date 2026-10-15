// Package ptr implements RFC 6901 JSON pointers over the submitted document.
// Every diagnostic location is one of these, so the editor can highlight the
// failing field (ADR-0021 § 7).
package ptr

import (
	"strconv"
	"strings"
)

// Pointer is an escaped JSON pointer. The empty Pointer is the document root.
type Pointer string

// Root is the document root pointer.
const Root = Pointer("")

// Child returns the pointer to the named member of a mapping.
func (p Pointer) Child(name string) Pointer {
	return Pointer(string(p) + "/" + escape(name))
}

// Index returns the pointer to the i-th element of an array.
func (p Pointer) Index(i int) Pointer {
	return Pointer(string(p) + "/" + strconv.Itoa(i))
}

// Segments unescapes the pointer into its reference tokens.
func (p Pointer) Segments() []string {
	if p == "" {
		return nil
	}
	parts := strings.Split(string(p)[1:], "/")
	for i, s := range parts {
		parts[i] = unescape(s)
	}
	return parts
}

// String implements fmt.Stringer.
func (p Pointer) String() string { return string(p) }

// IsRoot reports whether the pointer addresses the whole document.
func (p Pointer) IsRoot() bool { return p == "" }

func escape(s string) string {
	s = strings.ReplaceAll(s, "~", "~0")
	return strings.ReplaceAll(s, "/", "~1")
}

func unescape(s string) string {
	s = strings.ReplaceAll(s, "~1", "/")
	return strings.ReplaceAll(s, "~0", "~")
}

// Join appends raw (unescaped) reference tokens.
func Join(base Pointer, raw ...string) Pointer {
	for _, r := range raw {
		base = base.Child(r)
	}
	return base
}
