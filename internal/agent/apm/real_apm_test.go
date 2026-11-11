package apm

// The gated real-APM proof (ADR-0084 § Verification, AGENTS.md: a mocked green
// test never substitutes for a real protocol run).
//
// Everything else in this package installs against fake CLIs, which proves the
// shapes and refuses — it does NOT prove that apm 0.34 actually resolves a
// collection's refs into one lock. This file is the only place in the repo that
// can say so, and it says nothing unless a human turned it on:
//
//	COMMUNICATION_TEST_REAL_APM=1 go test ./internal/agent/apm -run RealAPM -v
//
// with the pinned `apm` on PATH and network access to the package sources. It
// resolves the seeded Matt Pocock collection and the seeded pstack set, logs the
// lock digests and the per-skill attribution, and records the outcome in
// docs/compatibility/APM.md — which stays "UNVERIFIED / not run" until the logged
// evidence is pasted there. A skipped test is not a PASS row; per
// communication-spec/12-test-strategy.md the compatibility table moves only on an
// observed run.

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// realAPMSeed is collection 1 of migration 00033 verbatim: the whole Matt Pocock
// plugin at one tag. The seed and this list disagreeing would mean the app offers
// a bundle the worker cannot install, and the only way to notice is to ask.
var realAPMSeed = []CollectionRevision{
	{CollectionID: "matt-pocock-skills", Slug: "matt-pocock-skills", Revision: 1,
		Entries: []CollectionEntry{{Ref: "mattpocock/skills#v1.3.2"}}},
}

// realAPMPstack is the pstack seed trimmed to the router plus two core skills: a
// 36-clone resolve is the same proof, slower, and every ref is the same shape
// (a per-skill virtual subdirectory of one commit). The FULL list is what a launch
// installs; this is the shape proof, and it says so in the log.
var realAPMPstack = []CollectionRevision{
	{CollectionID: "pstack-claude-code", Slug: "pstack-claude-code", Revision: 1,
		Entries: []CollectionEntry{
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82"},
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"},
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/principle-prove-it-works#63912a91d52c43946f974f2aaf661334a6116a82"},
		}},
}

func skipUnlessRealAPM(t *testing.T) string {
	t.Helper()
	if os.Getenv("COMMUNICATION_TEST_REAL_APM") != "1" {
		t.Skip("real APM resolve is gated: set COMMUNICATION_TEST_REAL_APM=1 with the pinned apm on PATH (docs/compatibility/APM.md records the outcome)")
	}
	path, err := exec.LookPath(Binary)
	if err != nil {
		t.Skipf("`%s` is not on PATH, so the real resolve cannot run: %v", Binary, err)
	}
	out, err := exec.Command(path, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("`%s --version` failed: %v (%s)", path, err, out)
	}
	t.Logf("real apm: %s (this package is pinned against %s)", strings.TrimSpace(string(out)), PinnedVersion)
	return path
}

// Resolving the seeded collection is the shortest path that proves the whole
// chain: the flatten renders the seed, apm installs it, the lock digests, and the
// contents summary names skills with their owning coordinate. A digest is logged
// rather than asserted: it is a fact about upstream content at a tag, and the
// point of recording it is that a LATER run can notice it moved.
func TestRealAPMResolvesTheSeededMattPocockCollection(t *testing.T) {
	bin := skipUnlessRealAPM(t)
	deps, err := FlattenProfile(realAPMSeed, "")
	if err != nil {
		t.Fatalf("the seeded collection does not flatten: %v", err)
	}
	res, err := Resolve(t.Context(), ResolveRequest{
		Deps: deps, Target: TargetClaude, WorkDir: t.TempDir(), Home: t.TempDir(),
		APMPath: bin, Timeout: 8 * time.Minute,
	})
	if err != nil {
		t.Fatalf("real resolve: %v", err)
	}
	t.Logf("lock digest   = %s", res.LockDigest)
	t.Logf("resolved      = %s @ %s (apm %s)", res.ResolvedRef, res.Commit, res.APMVersion)
	t.Logf("skills (%d)   = %s", len(res.Contents.Skills), strings.Join(res.Contents.Skills, " "))
	for _, r := range res.Contents.SkillRefs {
		t.Logf("  %-34s from_ref %s", r.Skill, r.FromRef)
	}
	if res.LockDigest == "" || !strings.HasPrefix(res.LockDigest, "sha256:") {
		t.Fatalf("no usable digest: %q", res.LockDigest)
	}
	if len(res.Contents.Skills) == 0 {
		t.Fatal("the resolve deployed no skills: the seed would be an empty bundle in the app")
	}
	// Every attribution must name a dependency of THIS set: an unattributed skill
	// would mean the app's "overridden by …" line has nothing to point at.
	unattributed := 0
	for _, r := range res.Contents.SkillRefs {
		if r.FromRef == "" {
			unattributed++
		}
	}
	if unattributed > 0 {
		t.Errorf("%d skills carry no from_ref; ADR-0084's attribution is only useful if the lock names the owner", unattributed)
	}
}

// Two collections, one flattened set: the ordering rule and the single digest.
// pstack's per-skill refs are the interesting half — they are virtual
// subdirectories of one commit, so the lock must record one dependency per skill
// and the digest must cover all of them together.
func TestRealAPMResolvesSeededCollectionsIntoOneDigest(t *testing.T) {
	bin := skipUnlessRealAPM(t)
	deps, err := FlattenProfile(seededSet(), "")
	if err != nil {
		t.Fatalf("the two seeded collections do not flatten together: %v", err)
	}
	if len(deps) != 4 {
		t.Fatalf("deps = %v, want 1 + 3 entries", apmRefsForLog(deps))
	}
	// Grammar is all a pre-install check has: a well-formed coordinate that does
	// not exist upstream is refused by the INSTALL, and the digest is never
	// recorded. Logged rather than asserted because the honest statement is which
	// layer refuses what.
	if _, err := NewDep("acme/does-not-exist#v0.0.1", nil); err != nil {
		t.Errorf("a well-formed coordinate refused the grammar check: %v", err)
	}
	res, err := Resolve(t.Context(), ResolveRequest{
		Deps: deps, Target: TargetClaude, WorkDir: t.TempDir(), Home: t.TempDir(),
		APMPath: bin, Timeout: 10 * time.Minute,
	})
	if err != nil {
		t.Fatalf("real multi-collection resolve: %v", err)
	}
	t.Logf("ONE digest over %d packages = %s", len(deps), res.LockDigest)
	t.Logf("skills (%d)", len(res.Contents.Skills))
	owners := map[string][]string{}
	for _, r := range res.Contents.SkillRefs {
		owners[r.FromRef] = append(owners[r.FromRef], r.Skill)
	}
	for ref, skills := range owners {
		t.Logf("  %-92s %d skill(s): %s", ref, len(skills), strings.Join(skills, " "))
	}
	if len(owners) < 2 {
		t.Errorf("only %d owner coordinate(s): a per-skill pstack ref that folded into one dependency would mean the lock did not record the set we rendered", len(owners))
	}
}

func apmRefsForLog(deps []Dep) string { return DepsForLog(deps) }

// seededSet is the two seeded collections as one attach order (Matt Pocock first,
// then pstack): the order the ADR's own examples attach them.
func seededSet() []CollectionRevision {
	set := make([]CollectionRevision, 0, len(realAPMSeed)+len(realAPMPstack))
	set = append(set, realAPMSeed...)
	set = append(set, realAPMPstack...)
	return set
}
