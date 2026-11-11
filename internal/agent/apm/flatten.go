package apm

// Flattening a profile's collections into one dependency list (ADR-0084).
//
// A profile used to pin exactly one package. ADR-0084 amends that: a profile
// attaches an ORDERED list of APM collections, each of which is an ordered
// list of pinned refs (optionally narrowed to a skill subset), and the
// profile's own `apm_package_ref` survives as "extra packages" appended last.
// One profile therefore still produces one `apm.yml`, one `apm.lock.yaml` and
// one `apm_lock_digest` — the invariant ADR-0030 §3 and ADR-0054 are built on.
//
// The order is load-bearing, not cosmetic: APM resolves a name shipped by two
// dependencies by INSTALL ORDER (the last claimant becomes the lock's
// `active_owner`), so the attach order a user chose in the app is what decides
// which package's copy of a skill wins. Nothing here reinterprets that: the
// flatten preserves the order, and `collectContents` reports the attribution
// the lock recorded (§ "Ordering rule" of ADR-0084).
//
// This is the ONE flatten. The lock resolver (resolve.go) and the launch
// stager (stage.go) both render through it, because a digest computed over a
// different dep list than the one a launch installs would turn the launch gate
// into a coin flip.

import (
	"errors"
	"fmt"
	"strings"
)

// ErrFlattenRef reports a flattened dependency whose ref the ADR-0030 §3
// grammar refuses. The flatten refuses rather than rendering: every ref here
// lands in a YAML scalar written into a checkout.
var ErrFlattenRef = errors.New("apm: flattened package ref is invalid")

// Dep is one dependency of a flattened profile: the pinned coordinate plus the
// optional skill subset the collection entry cherry-picked.
type Dep struct {
	// Ref is `<owner>/<repo>[/<virtual-subdirectory>]#<tag|full-sha>`.
	Ref string `json:"ref"`
	// Skills narrows the dep to these skill names (APM's object-form
	// `skills:`). Empty means the whole package.
	Skills []string `json:"skills,omitempty"`
}

// CollectionEntry is one entry of a collection revision — the stored shape
// (apm_collection_revisions.entries) minus the note, which never reaches a
// manifest.
type CollectionEntry struct {
	Ref    string
	Skills []string
}

// CollectionRevision is one attached collection at the exact revision the
// profile pinned. The caller resolves the entries (the store reads them from
// apm_collection_revisions); the flatten never queries anything.
type CollectionRevision struct {
	CollectionID string
	Slug         string
	Revision     int
	Entries      []CollectionEntry
}

// Identity names the attachment in a message: the slug when one was resolved,
// the id otherwise.
func (c CollectionRevision) Identity() string {
	if c.Slug != "" {
		return fmt.Sprintf("%s@r%d", c.Slug, c.Revision)
	}
	return fmt.Sprintf("%s@r%d", c.CollectionID, c.Revision)
}

// FlattenProfile builds the dependency list of one profile: every attached
// collection's entries in attach order, then the profile's own extra ref.
//
// Rules (ADR-0084 § Model / § Flattening):
//
//   - order is preserved exactly: collection 1's entries, then collection 2's,
//     then the profile's own ref last;
//   - an exact duplicate ref appears ONCE, at its FIRST position — a later
//     repeat of a coordinate adds nothing, so it is dropped rather than
//     re-installed under a second ownership claim;
//   - a skills subset survives as the dep's Skills (the manifest's object
//     form); two entries of one ref with different subsets are not duplicates
//     and both stay, in order;
//   - every ref is validated per element, never as one joined string, so a
//     hostile entry cannot smuggle a newline into the rendered YAML.
//
// An empty result is legal and means "this profile stages nothing" (the caller
// answers ErrNothingStaged / skips staging exactly as it does today).
func FlattenProfile(collections []CollectionRevision, extraRef string) ([]Dep, error) {
	var deps []Dep
	seen := map[string]int{}
	add := func(ref string, skills []string, from string) error {
		dep, err := NewDep(ref, skills)
		if err != nil {
			return fmt.Errorf("%s: %w", from, err)
		}
		if _, dup := seen[dep.Ref]; dup {
			return nil // first position wins (documented above)
		}
		seen[dep.Ref] = len(deps)
		deps = append(deps, dep)
		return nil
	}
	for _, c := range collections {
		if c.CollectionID == "" && c.Slug == "" {
			return nil, fmt.Errorf("apm: flatten: a collection attachment carries neither id nor slug: %w", ErrFlattenRef)
		}
		for _, e := range c.Entries {
			if err := add(e.Ref, e.Skills, "collection "+c.Identity()); err != nil {
				return nil, err
			}
		}
	}
	if strings.TrimSpace(extraRef) != "" {
		if err := add(extraRef, nil, "profile apm_package_ref"); err != nil {
			return nil, err
		}
	}
	return deps, nil
}

// NewDep validates one dependency coordinate and returns it in the shape the
// manifest renders. The grammar is ADR-0030 §3's unchanged — parsePackageRef is
// the strict one (it demands a `#<revision>` and whitelists every character per
// segment), and it is applied PER ELEMENT, which is what ADR-0084 requires of a
// list. postgres.ValidAPMPackageRef is the same rule's statement on the write
// side; the two agree because both refuse an un-pinned coordinate.
func NewDep(ref string, skills []string) (Dep, error) {
	raw := strings.TrimSpace(ref)
	parsed, err := parsePackageRef(raw)
	if err != nil {
		return Dep{}, fmt.Errorf("%w: %s", ErrFlattenRef, err)
	}
	out := Dep{Ref: parsed.canonical()}
	if len(skills) == 0 {
		return out, nil
	}
	seenSkill := map[string]bool{}
	for _, s := range skills {
		name := strings.TrimSpace(s)
		if name == "" {
			return Dep{}, fmt.Errorf("skill subset of %q carries an empty name: %w", out.Ref, ErrFlattenRef)
		}
		if err := checkRefChars(name); err != nil {
			return Dep{}, fmt.Errorf("skill subset of %q: %w", out.Ref, err)
		}
		if seenSkill[name] {
			continue
		}
		seenSkill[name] = true
		out.Skills = append(out.Skills, name)
	}
	return out, nil
}

// canonical rebuilds the validated ref from its parsed parts, so the string
// that reaches the manifest is the one the parser accepted (no surrounding
// whitespace, one `#`).
func (r packageRef) canonical() string {
	if r.Subdir == "" {
		return r.Source + "#" + r.Revision
	}
	return r.Source + "/" + r.Subdir + "#" + r.Revision
}

// RefsOf is the flat coordinate list, in order (logs, digests over the pin,
// the API's dep view).
func RefsOf(deps []Dep) []string {
	out := make([]string, 0, len(deps))
	for _, d := range deps {
		out = append(out, d.Ref)
	}
	return out
}

// DepsForLog names a dependency set in a message: the coordinates in install
// order, bounded so a 200-entry bundle cannot become an unbounded log line.
func DepsForLog(deps []Dep) string {
	refs := RefsOf(deps)
	if len(refs) == 0 {
		return "(no packages)"
	}
	joined := strings.Join(refs, ", ")
	if len(joined) > 400 {
		return joined[:400] + "…"
	}
	return joined
}

// SingleRefDep is the ADR-0030 single-package constructor: one
// agent_profiles.apm_package_ref, no collections, no subset. Every caller that
// knew one ref keeps knowing one ref through this.
func SingleRefDep(ref string) []Dep {
	if strings.TrimSpace(ref) == "" {
		return nil
	}
	return []Dep{{Ref: strings.TrimSpace(ref)}}
}
