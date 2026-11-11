package apm

// ADR-0084: the flatten is the one function that decides what a profile's
// packaged context IS. These tests are the ADR's own Verification list — order,
// dedupe, skills subsets, the manifest whitelist — plus the two renderings
// (Resolve's scratch install, Stage's launch install) proving the SAME list
// reaches apm in both paths. If those two ever disagreed, the lock digest would
// be computed over one dependency set and the launch gate would compare it
// against another, which is not a bug but a silently inverted safety check.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func col(slug string, rev int, refs ...string) CollectionRevision {
	c := CollectionRevision{CollectionID: slug + "-id", Slug: slug, Revision: rev}
	for _, r := range refs {
		c.Entries = append(c.Entries, CollectionEntry{Ref: r})
	}
	return c
}

// Attach order is the ordering RULE: APM settles a skill name two dependencies
// both ship by install order (the last claimant is the lock's active_owner), so
// "collection 1 then collection 2 then the profile's own ref" is a statement
// about which copy runs, not about how the list is printed.
func TestFlattenProfilePreservesAttachOrder(t *testing.T) {
	matt := col("matt-pocock-skills", 1, "mattpocock/skills#v1.3.2")
	pstack := col("pstack-claude-code", 1,
		"cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82",
		"cursor/plugins/harness/pstack/claude-code/skills/tdd#63912a91d52c43946f974f2aaf661334a6116a82")

	deps, err := FlattenProfile([]CollectionRevision{matt, pstack}, "acme/team-apm#v1.0.0")
	if err != nil {
		t.Fatalf("FlattenProfile: %v", err)
	}
	want := []string{
		"mattpocock/skills#v1.3.2",
		"cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82",
		"cursor/plugins/harness/pstack/claude-code/skills/tdd#63912a91d52c43946f974f2aaf661334a6116a82",
		"acme/team-apm#v1.0.0",
	}
	if got := RefsOf(deps); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("flatten order =\n%v\nwant\n%v", got, want)
	}

	// Reordering the attachments reorders the install: this is the property the
	// UI's "overridden by …" note and the single stored digest both depend on.
	swapped, err := FlattenProfile([]CollectionRevision{pstack, matt}, "acme/team-apm#v1.0.0")
	if err != nil {
		t.Fatalf("FlattenProfile(swapped): %v", err)
	}
	if RefsOf(swapped)[0] != want[1] {
		t.Errorf("swapped order = %v, want pstack first", RefsOf(swapped))
	}
}

// An exact duplicate ref appears once, at its first position: a repeat of the
// same coordinate cannot add a second claim on a skill name, and installing the
// same package twice would make the lock's ownership ledger depend on apm's
// internal de-duplication rather than on what we rendered.
func TestFlattenProfileDedupesExactDuplicateRefsAtFirstPosition(t *testing.T) {
	dup := "mattpocock/skills#v1.3.2"
	deps, err := FlattenProfile([]CollectionRevision{
		col("a", 1, dup, "other/repo#v1.0.0"),
		col("b", 1, dup),
	}, dup)
	if err != nil {
		t.Fatalf("FlattenProfile: %v", err)
	}
	if got := RefsOf(deps); len(got) != 2 || got[0] != dup || got[1] != "other/repo#v1.0.0" {
		t.Fatalf("deduped list = %v, want [mattpocock/skills#v1.3.2 other/repo#v1.0.0]", got)
	}
}

// A skills subset is the object form (`skills:`), and two subsets of one ref are
// not duplicates of each other: each narrows a different set of skills, and APM
// records the subset per dependency (skill_subset in the lock), so both survive
// the flatten and both reach the manifest.
func TestFlattenProfileCarriesSkillSubsets(t *testing.T) {
	ref := "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"
	deps, err := FlattenProfile([]CollectionRevision{{
		CollectionID: "pstack-id", Slug: "pstack-claude-code", Revision: 1,
		Entries: []CollectionEntry{
			{Ref: ref, Skills: []string{"how", "how"}}, // duplicate name inside one entry collapses
			{Ref: "mattpocock/skills#v1.3.2", Skills: []string{"grill-me", "tdd"}},
		},
	}}, "")
	if err != nil {
		t.Fatalf("FlattenProfile: %v", err)
	}
	if len(deps) != 2 {
		t.Fatalf("deps = %v", deps)
	}
	if len(deps[0].Skills) != 1 || deps[0].Skills[0] != "how" {
		t.Errorf("entry 1 subset = %v, want [how] (one name, once)", deps[0].Skills)
	}
	if strings.Join(deps[1].Skills, ",") != "grill-me,tdd" {
		t.Errorf("entry 2 subset = %v", deps[1].Skills)
	}
}

// The whitelist is applied PER ELEMENT. A joined-string check is what a hostile
// profile value threads through: a newline or a quote inside one ref of a list
// closes the YAML scalar it lands in and writes an attacker's manifest lines
// into a checkout. Refusing per element, before rendering, is the whole control.
func TestFlattenProfileRefusesEveryRefTheGrammarRefuses(t *testing.T) {
	bad := []struct {
		name, ref string
	}{
		{"no revision", "mattpocock/skills"},
		{"empty revision", "mattpocock/skills#"},
		{"newline", "mattpocock/skills#v1.3.2\n      - evil/repo#main"},
		{"quote", `mattpocock/skills#v1.3"2`},
		{"space", "mattpocock/skills#v1.3.2 v2"},
		{"traversal", "mattpocock/../etc/skills#v1.3.2"},
		{"one segment", "mattpocock#v1.3.2"},
		{"two hashes", "mattpocock/skills#v1.3.2#x"},
	}
	for _, tc := range bad {
		_, err := FlattenProfile([]CollectionRevision{col("a", 1, tc.ref)}, "")
		if err == nil {
			t.Errorf("%s: FlattenProfile(%q) = nil error, want a refusal", tc.name, tc.ref)
			continue
		}
		if !errors.Is(err, ErrFlattenRef) {
			t.Errorf("%s: err = %v, want it to wrap ErrFlattenRef", tc.name, err)
		}
		if _, err := NewDep(tc.ref, nil); err == nil {
			t.Errorf("%s: NewDep(%q) accepted a ref FlattenProfile refuses", tc.name, tc.ref)
		}
	}
	// A skill name goes through the same whitelist: it is rendered as a YAML list
	// item, so it can close its scalar exactly like a ref can.
	if _, err := NewDep("owner/repo#v1.0.0", []string{"ok", "bad name"}); err == nil {
		t.Error("NewDep accepted a skill name with a space")
	}
	if _, err := NewDep("owner/repo#v1.0.0", []string{""}); err == nil {
		t.Error("NewDep accepted an empty skill name")
	}
}

// A profile that attaches nothing and pins nothing stages nothing — and that is
// the D-020 default ("no packaged context"), not an error.
func TestFlattenProfileEmptyIsLegal(t *testing.T) {
	deps, err := FlattenProfile(nil, "")
	if err != nil || len(deps) != 0 {
		t.Fatalf("FlattenProfile(nil, \"\") = %v, %v; want empty, nil", deps, err)
	}
	if got := SingleRefDep(""); got != nil {
		t.Errorf("SingleRefDep(\"\") = %v, want nil (no ref, no dep)", got)
	}
	one := SingleRefDep("  mattpocock/skills#v1.3.1 ")
	if len(one) != 1 || one[0].Ref != "mattpocock/skills#v1.3.1" {
		t.Errorf("SingleRefDep = %+v, want the trimmed single ref", one)
	}
}

// The rendered manifest is what apm installs, so the shape is the contract:
// the plain string form for a whole package, the object form whenever a virtual
// subdirectory or a skills subset has to persist into the lock (APM.md T-tag-5
// is the evidence that both survive --frozen replay in that form).
func TestDepsManifestYAMLRendersEveryForm(t *testing.T) {
	deps, err := FlattenProfile([]CollectionRevision{
		col("matt-pocock-skills", 1, "mattpocock/skills#v1.3.2"),
		{
			CollectionID: "pstack-id", Slug: "pstack-claude-code", Revision: 1,
			Entries: []CollectionEntry{
				{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"},
				{Ref: "acme/skills#v2.0.0", Skills: []string{"review-conventions"}},
			},
		},
	}, "acme/extras#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	if err != nil {
		t.Fatalf("FlattenProfile: %v", err)
	}
	got, err := depsManifestYAML(deps)
	if err != nil {
		t.Fatalf("depsManifestYAML: %v", err)
	}
	t.Log("\n" + got)
	wantLines := []string{
		"    - mattpocock/skills#v1.3.2",
		"    - git: cursor/plugins",
		"      ref: 63912a91d52c43946f974f2aaf661334a6116a82",
		"      path: harness/pstack/claude-code/skills/how",
		"    - git: acme/skills",
		"      ref: v2.0.0",
		"      skills:",
		"        - review-conventions",
		"    - acme/extras#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}
	for _, line := range wantLines {
		if !strings.Contains(got, line) {
			t.Errorf("manifest is missing the line %q", line)
		}
	}
	if !strings.HasPrefix(got, "# Generated by the communication worker") {
		t.Error("manifest lost its provenance header: a reader in the checkout must know who wrote it")
	}
	// Order in the file is order in the list. The revision is the part of a
	// coordinate that survives every rendering (string form keeps `#rev`, object
	// form writes it on its own `ref:` line), so the sequence of revisions is what
	// proves the list reached the file in the order the user attached it.
	at := -1
	for _, ref := range RefsOf(deps) {
		_, rev, _ := strings.Cut(ref, "#")
		i := strings.Index(got[0:], rev)
		if i < 0 {
			t.Fatalf("manifest never names the revision of %s", ref)
		}
		if i < at {
			t.Errorf("manifest renders %s out of order", ref)
		}
		at = i
	}
	// An empty list renders nothing rather than a manifest with an empty
	// dependencies block, which apm would install as "no context" silently.
	if _, err := depsManifestYAML(nil); err == nil {
		t.Error("depsManifestYAML(nil) = nil error, want a refusal")
	}
}

// Both install paths must materialize the SAME list from the same profile axes:
// the lock digest is only a gate on the launch if the launch installs what the
// lock resolved. One fake apm, two scratch trees, one byte-identical manifest.
func TestResolveAndStageRenderTheSameMultiDepManifest(t *testing.T) {
	deps, err := FlattenProfile([]CollectionRevision{
		col("matt-pocock-skills", 1, "mattpocock/skills#v1.3.2"),
		{
			CollectionID: "pstack-id", Slug: "pstack-claude-code", Revision: 1,
			Entries: []CollectionEntry{
				{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82", Skills: []string{"how"}},
			},
		},
	}, "acme/extras#v0.1.0")
	if err != nil {
		t.Fatalf("FlattenProfile: %v", err)
	}

	resolveDir, resolveHome := t.TempDir(), t.TempDir()
	// Stage installs into a run checkout, which means a git tree: the exclusion
	// pass that keeps the generated files out of a checkpoint refuses a directory
	// that is not one (APM.md C14b), so the fixture is the real shape.
	stageDir, stageHome := newCheckout(t)
	// The fake CLI answers the multi-dep lock the way apm does: three
	// dependencies, each owning one skill, in install order.
	bin, logPath := writeManifestFakeAPM(t, multiDepLockBody)

	if _, err := Resolve(t.Context(), ResolveRequest{
		Deps: deps, Target: TargetClaude, WorkDir: resolveDir, Home: resolveHome, APMPath: bin, Timeout: 30 * time.Second,
	}); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	// The digest the resolve just reported is the one the profile would carry, so
	// Stage's gate passes on it — which is the point: ONE list, ONE lock, ONE
	// digest, whatever number of packages the set names.
	staged, err := Stage(t.Context(), StageRequest{
		Checkout: stageDir, Target: TargetClaude, Deps: deps,
		LockDigest: digestOf(multiDepLockBody), Home: stageHome, APMPath: bin,
	})
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if !staged.ManifestGenerated {
		t.Error("Stage reported it did not materialize the manifest")
	}
	if staged.LockDigest != digestOf(multiDepLockBody) {
		t.Errorf("staged digest = %s", staged.LockDigest)
	}
	if got := RefsOf(staged.Deps); len(got) != 3 {
		t.Errorf("staged deps = %v, want the three flattened packages", got)
	}

	a, aerr := os.ReadFile(filepath.Join(resolveDir, ManifestFileName))
	b, berr := os.ReadFile(filepath.Join(stageDir, ManifestFileName))
	if aerr != nil || berr != nil {
		t.Fatalf("read manifests: %v / %v", aerr, berr)
	}
	if string(a) != string(b) {
		t.Errorf("the resolve and the stage materialized different manifests:\n%s\n---\n%s", a, b)
	}
	if !strings.Contains(string(a), "skills:") {
		t.Error("the subset never reached the manifest; the lock would resolve the whole package")
	}
	// Exactly one of the three needs the object form (the entry carrying a skills
	// subset, which also names a virtual subdirectory); the two whole-package refs
	// stay in the plain string form, byte-identical to what a pre-ADR-0084 profile
	// of the same ref rendered.
	listLines := strings.Count(string(a), "\n    - ")
	object := strings.Count(string(a), "\n    - git:")
	if object != 1 {
		t.Errorf("object-form entries = %d, want 1; manifest:\n%s", object, a)
	}
	if plain := listLines - object; plain != 2 {
		t.Errorf("string-form entries = %d, want 2", plain)
	}
	argv, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(argv), "install --target claude") {
		t.Errorf("fake apm argv = %s, want a resolving install for both paths", argv)
	}
}

// The single-ref constructor is the ADR-0030 shape: a caller that knows one
// apm_package_ref must produce exactly the manifest it produced before
// collections existed, byte for byte, so no pre-ADR-0084 profile changes meaning.
func TestSingleRefConstructorMatchesTheLegacyRendering(t *testing.T) {
	dir := t.TempDir()
	created, err := writeManifest(dir, SingleRefDep("mattpocock/skills#v1.3.1"))
	if err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	if !created {
		t.Fatal("writeManifest reported it wrote nothing")
	}
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFileName))
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if !strings.Contains(body, "    - mattpocock/skills#v1.3.1\n") {
		t.Errorf("single-ref manifest =\n%s", body)
	}
	if strings.Contains(body, "git:") {
		t.Error("a plain ref rendered in object form; the pre-ADR-0084 shape changed")
	}
	// FlattenProfile of no collections plus the same ref is the same one dep.
	deps, err := FlattenProfile(nil, "mattpocock/skills#v1.3.1")
	if err != nil {
		t.Fatal(err)
	}
	if len(deps) != 1 || deps[0].Ref != "mattpocock/skills#v1.3.1" {
		t.Errorf("FlattenProfile(nil, ref) = %+v", deps)
	}
}

// A checkout that tracks its own apm.yml owns its context: Stage never overwrites
// it, whatever the profile attaches. That is the pre-ADR-0084 rule and the
// flatten does not weaken it — a list is still not permission to clobber a
// repository's manifest.
func TestWriteManifestNeverOverwritesATrackedManifest(t *testing.T) {
	dir := t.TempDir()
	mine := "name: my-repo-context\nversion: 9.9.9\ndependencies:\n  apm: []\n"
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	created, err := writeManifest(dir, []Dep{{Ref: "evil/repo#v1.0.0"}})
	if err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	if created {
		t.Fatal("writeManifest overwrote a manifest the checkout tracks")
	}
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFileName))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != mine {
		t.Errorf("tracked manifest changed:\n%s", raw)
	}
}

// multiDepLockBody is what a resolving install of a three-package set reports:
// one row per dependency, each owning its skill, in install order — the shape
// ADR-0084's attribution reads (research §1's `deployments`/`skill_subset`
// ledger, expressed in the dependency rows the fake can write).
const multiDepLockBody = `lockfile_version: '1'
apm_version: 0.34.0
dependencies:
  - repo_url: mattpocock/skills
    resolved_commit: 24fe0ef7737efae15c87225755e9f6f5965e4888
    resolved_ref: v1.3.2
    depth: 1
    package_type: git
    skill_subset:
      - grill-me
    deployed_files:
      - .claude/skills/grill-me/SKILL.md
  - repo_url: cursor/plugins
    virtual_path: harness/pstack/claude-code/skills/how
    resolved_commit: 63912a91d52c43946f974f2aaf661334a6116a82
    resolved_ref: 63912a91d52c43946f974f2aaf661334a6116a82
    depth: 1
    package_type: git
    skill_subset:
      - how
    deployed_files:
      - .claude/skills/how/SKILL.md
  - repo_url: acme/extras
    resolved_commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    resolved_ref: v0.1.0
    depth: 1
    package_type: git
    skill_subset:
      - grill-me
    deployed_files:
      - .claude/skills/grill-me/SKILL.md
mcp_servers: []
`

// writeManifestFakeAPM is the multi-dependency sibling of the resolve tests'
// fake: it lays out every skill the lock claims, so collectContents sees the
// deployed tree the real install would have produced.
func writeManifestFakeAPM(t *testing.T, lockBody string) (bin, logPath string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "apm")
	logPath = filepath.Join(dir, "argv.log")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> '" + logPath + "'\n" +
		"cat > apm.lock.yaml <<'LOCK'\n" + lockBody + "LOCK\n" +
		"mkdir -p .claude/skills/grill-me .claude/skills/how\n" +
		"printf '# grill-me\\n' > .claude/skills/grill-me/SKILL.md\n" +
		"printf '# how\\n' > .claude/skills/how/SKILL.md\n" +
		"echo '[+] fake-apm 0.34.0 3 package(s) integrated'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}
	return bin, logPath
}

// The attribution ADR-0084 owes the UI: `grill-me` is shipped by BOTH
// mattpocock/skills and acme/extras, and APM settles it by install order — the
// LAST claimant wins. collectContents must report the winner (acme/extras), not
// the first claimant and not both, because what APM decided is what the agent
// actually gets, and the app's "overridden by …" line is only true if it names
// the copy that runs.
func TestResolveAttributesEachSkillToItsWinningDependency(t *testing.T) {
	workdir, home := t.TempDir(), t.TempDir()
	bin, _ := writeManifestFakeAPM(t, multiDepLockBody)
	res, err := Resolve(t.Context(), ResolveRequest{
		Deps: []Dep{
			{Ref: "mattpocock/skills#v1.3.2"},
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82", Skills: []string{"how"}},
			{Ref: "acme/extras#v0.1.0"},
		},
		Target: TargetClaude, WorkDir: workdir, Home: home, APMPath: bin, Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	owners := map[string]string{}
	for _, r := range res.Contents.SkillRefs {
		owners[r.Skill] = r.FromRef
	}
	if got := owners["grill-me"]; got != "acme/extras#v0.1.0" {
		t.Errorf("grill-me from_ref = %q, want acme/extras#v0.1.0 (the last claimant owns it)", got)
	}
	if got := owners["how"]; got != "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82" {
		t.Errorf("how from_ref = %q, want the virtual-subdirectory coordinate", got)
	}
	if names := strings.Join(res.Contents.Skills, ","); names != "grill-me,how" {
		t.Errorf("skills = %s", names)
	}
}

// A resolve asked to lock a set refuses a lock that never pinned one of the
// requested revisions: recording a digest for a dependency that silently dropped
// out of the graph would report a package as locked that no agent will get.
func TestResolveRefusesALockThatDroppedADependency(t *testing.T) {
	workdir, home := t.TempDir(), t.TempDir()
	bin, _ := writeManifestFakeAPM(t, multiDepLockBody)
	_, err := Resolve(t.Context(), ResolveRequest{
		Deps: []Dep{
			{Ref: "mattpocock/skills#v1.3.2"},
			{Ref: "acme/extras#v9.9.9"}, // the lock answers v0.1.0
		},
		Target: TargetClaude, WorkDir: workdir, Home: home, APMPath: bin, Timeout: 30 * time.Second,
	})
	if err == nil {
		t.Fatal("resolve accepted a lock that never pinned acme/extras#v9.9.9")
	}
	if !errors.Is(err, ErrResolveFailed) {
		t.Errorf("err = %v, want it to wrap ErrResolveFailed", err)
	}
	if !strings.Contains(err.Error(), "v9.9.9") {
		t.Errorf("err = %v, want it to name the dropped revision", err)
	}
}

// pi's target is a NAME, not a claim: agent-skills is admissible as a pin and the
// exclusions name the tree it writes, while every doc keeps the consuming side as
// spike A-1. This pins the shape so a later "just make pi work" change cannot
// quietly redefine what the constant installs.
func TestAgentSkillsTargetStagesTheSharedTree(t *testing.T) {
	if !ValidTarget(TargetAgentSkills) {
		t.Fatal("agent-skills must be a lockable target: pi profiles pin it (ADR-0084)")
	}
	if got := materializedExclusions(TargetAgentSkills); !contains(got, ".agents/skills/") {
		t.Errorf("exclusions for agent-skills = %v, want the shared skills tree", got)
	}
	if ex := materializedExclusions(TargetAgentSkills); contains(ex, ".codex/") {
		t.Errorf("agent-skills must not exclude .codex/ (that is the codex target's marker): %v", ex)
	}
	if _, err := Stage(t.Context(), StageRequest{
		Checkout: t.TempDir(), Target: "made-up-target", Deps: SingleRefDep("owner/repo#v1.0.0"),
		LockDigest: "sha256:" + strings.Repeat("0", 64), Home: t.TempDir(),
	}); err == nil || !strings.Contains(err.Error(), "claude/codex/agent-skills") {
		t.Errorf("unknown target refusal = %v, want it to name all three targets", err)
	}
}
