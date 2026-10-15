package ptr_test

import (
	"testing"

	"github.com/dbirks/communication/internal/pipelines/ptr"
)

func TestRoot(t *testing.T) {
	if !ptr.Root.IsRoot() || string(ptr.Root) != "" {
		t.Fatal("Root must be the empty pointer")
	}
	if len(ptr.Root.Segments()) != 0 {
		t.Fatal("root has segments")
	}
	if (ptr.Pointer("/")).IsRoot() {
		t.Fatal(`"/" is not root`)
	}
}

func TestChildAndIndex(t *testing.T) {
	p := ptr.Root.Child("spec").Child("nodes").Index(3).Child("config").Child("prompt")
	if got := p.String(); got != "/spec/nodes/3/config/prompt" {
		t.Fatalf("got %q", got)
	}
	if p.Index(-1) != "/spec/nodes/3/config/prompt/-1" {
		t.Fatalf("negative index pointer: %s", p.Index(-1))
	}
}

// TestRFC6901Escaping is the whole reason ptr exists: a diagnostic must
// survive a member name containing / or ~ and come back out of Segments()
// unchanged, or the editor highlights the wrong field (ADR-0021 § 7).
func TestRFC6901Escaping(t *testing.T) {
	cases := []struct {
		name    string
		escaped string
	}{
		{"plain", "plain"},
		{"a/b", "a~1b"},
		{"~tilde", "~0tilde"},
		{"~/both", "~0~1both"},
		{"", ""},
		{"m~n/o~0p", "m~0n~1o~00p"}, // both tildes escape; the slash becomes ~1
	}
	for _, c := range cases {
		p := ptr.Root.Child(c.name)
		if string(p) != "/"+c.escaped {
			t.Fatalf("Child(%q) = %s, want /%s", c.name, p, c.escaped)
		}
		segs := p.Segments()
		if len(segs) != 1 || segs[0] != c.name {
			t.Fatalf("Segments round-trip broke %q → %s → %q", c.name, p, segs)
		}
	}
	// A path with two tricky names stays addressable end to end.
	deep := ptr.Root.Child("metadata").Child("ui/x").Child("a~b").Child("0")
	if deep.String() != "/metadata/ui~1x/a~0b/0" {
		t.Fatalf("deep = %s", deep)
	}
	want := []string{"metadata", "ui/x", "a~b", "0"}
	got := deep.Segments()
	if len(got) != len(want) {
		t.Fatalf("segments = %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("segment %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestJoin(t *testing.T) {
	p := ptr.Join(ptr.Root, "spec", "nodes", "a/b", "0")
	if p != "/spec/nodes/a~1b/0" {
		t.Fatalf("Join = %s", p)
	}
	if p2 := ptr.Join("/spec", "x"); p2 != "/spec/x" {
		t.Fatalf("Join on a base = %s", p2)
	}
	if p3 := ptr.Join("/spec"); p3 != "/spec" {
		t.Fatalf("Join with no tokens changed the base: %s", p3)
	}
}

// TestPointerOrderIsStable: diag.List orders by pointer string; the exact
// byte order is what makes the validate response reproducible (contract § 2.2).
func TestPointerOrderIsStable(t *testing.T) {
	as := ptr.Root.Child("b")
	bs := ptr.Root.Child("a")
	if !(bs < as) {
		t.Fatal("pointer ordering must be byte order")
	}
}

// FuzzPointerRoundTrip: every member name a diagnostic can point at must
// survive Child→Segments intact, or the editor highlights the wrong field.
func FuzzPointerRoundTrip(f *testing.F) {
	for _, s := range []string{"a", "a/b", "~", "~1", "~0", "", "///", "~~~", "\x00", "ünïcode"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		p := ptr.Root.Child(name)
		segs := p.Segments()
		if len(segs) != 1 || segs[0] != name {
			t.Fatalf("round trip broke %q → %s → %q", name, p, segs)
		}
		// Two-level pointers must not fuse or split.
		p2 := p.Child(name)
		if got := p2.Segments(); len(got) != 2 || got[0] != name || got[1] != name {
			t.Fatalf("two-level round trip broke %q: %s → %q", name, p2, got)
		}
	})
}
