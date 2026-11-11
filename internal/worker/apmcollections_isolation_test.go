package worker

// ADR-0084, 04-agent-runtime.md test 7: two profiles carrying different APM
// collection sets, staged by the SAME worker, must not be able to see one
// another's packaged context.
//
// This is the test that says collection sets are per-run rather than
// per-worker. It earns that name because the two stagings genuinely share the
// things a leak could ride on: one worker process, one pinned apm binary, one
// UnitService, and a HOME that apm writes into by design (probe A2: `.apm` and
// `.cache/apm` land in whatever HOME it is handed). What separates the units is
// only the per-run checkout and the per-attempt HOME, so those are what the
// assertions read back — from the real files on disk, through the real
// Unit.stageAPM path, with a real git checking that each checkout's own
// exclusion file is the one hiding each unit's generated trees.
//
// The fake apm models the two behaviours the isolation claim depends on and
// nothing else: it installs what the *checkout's* manifest names (so a manifest
// written into the wrong tree would show up as the wrong skills), it deploys
// each skill THROUGH the HOME cache (so a shared cache is genuinely on the
// path), and its lock bytes are a function of the deployed set (so a moved or
// swapped digest trips the real gate rather than being asserted away).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

const isoPstackSHA = "63912a91d52c43946f974f2aaf661334a6116a82"

// isoFakeAPMBody is the stand-in for the pinned apm 0.34.0 CLI. Stage builds the
// child environment from scratch, so the fake is configured only by what is in
// the checkout it is run in: it reads the materialized apm.yml, deploys one
// skill directory per dependency for the requested target, and writes a lock
// whose bytes are the deployed list — which is why two collection sets cannot
// share a digest.
const isoFakeAPMBody = `#!/bin/sh
set -e
target=claude
prev=
for a in "$@"; do
  if [ "$prev" = "--target" ]; then target=$a; fi
  prev=$a
done
case "$target" in
  claude) skills=.claude/skills ;;
  codex|agent-skills) skills=.agents/skills ;;
  *) echo "fake-apm: unknown target $target" >&2; exit 2 ;;
esac
cache="$HOME/.cache/apm"
mkdir -p "$cache"
names="$cache/names.txt"
: > "$names"
awk '
  /^    - / && $0 !~ /git:/ { ref = substr($0, 7); sub(/#.*/, "", ref); n = split(ref, p, "/"); print p[n]; next }
  /^      path: / { path = substr($0, 13); n = split(path, p, "/"); print p[n]; next }
' apm.yml >> "$names"
mkdir -p "$skills" apm_modules
while read -r name; do
  [ -n "$name" ] || continue
  mkdir -p "$cache/$name" "$skills/$name" "apm_modules/$name"
  printf '# %s\n' "$name" > "$cache/$name/SKILL.md"
  cp "$cache/$name/SKILL.md" "$skills/$name/SKILL.md"
  printf 'vendored %s\n' "$name" > "apm_modules/$name/README.md"
done < "$names"
{
  printf 'fake-apm-lock 1\n'
  LC_ALL=C sort "$names" | awk '{ printf "  - id: %s\n    deployed: %s/SKILL.md\n", $1, $1 }'
} > apm.lock.yaml
printf '[+] fake-apm 0.34.0 installed %sfor target %s\n' "$(tr '\n' ' ' < "$names")" "$target"
`

// isoDeployedName is the skill directory the fake deploys for one flattened
// dependency: the last path segment of its coordinate, which is how APM names
// what it installs (and, for the cherry-picked subset entries, the skill name
// itself).
func isoDeployedName(dep apm.Dep) string {
	source := strings.SplitN(dep.Ref, "#", 2)[0]
	return filepath.Base(source)
}

// isoLockBody is the exact byte sequence isoFakeAPMBody writes for a deployed
// set, so the profile's recorded digest is the digest the gate will find on
// disk — computed by the test the same way apm computes it, not copied from a
// fixture that might have drifted.
func isoLockBody(names []string) string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	var b strings.Builder
	b.WriteString("fake-apm-lock 1\n")
	for _, n := range sorted {
		fmt.Fprintf(&b, "  - id: %s\n    deployed: %s/SKILL.md\n", n, n)
	}
	return b.String()
}

func isoDigestOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// isoCollectionSet is one profile's attachment plus the skill names it must be
// the only owner of in a checkout.
type isoCollectionSet struct {
	profileID string
	collects  []apm.CollectionRevision
	// deps is the flattened list the set must produce (ADR-0084's one flatten).
	deps []apm.Dep
	// skills are the deployed names, in deploy order.
	skills []string
	// digest is the lock digest the profile records for that set.
	digest string
}

func isoBuildSet(profileID string, collects []apm.CollectionRevision, extraRef string) (isoCollectionSet, error) {
	deps, err := apm.FlattenProfile(collects, extraRef)
	if err != nil {
		return isoCollectionSet{}, err
	}
	names := make([]string, 0, len(deps))
	for _, d := range deps {
		names = append(names, isoDeployedName(d))
	}
	return isoCollectionSet{profileID: profileID, collects: collects, deps: deps, skills: names, digest: isoDigestOf(isoLockBody(names))}, nil
}

// isoMattPocock is the "Matt Pocock" collection: two skills, one repo, tag
// pinned. isoPstack is the pstack collection: two skills out of a deep
// subdirectory, one of them a named subset — the shape whose digest is computed
// over the object-form manifest.
func isoMattPocock(t *testing.T) isoCollectionSet {
	t.Helper()
	set, err := isoBuildSet("p-matt-pocock", []apm.CollectionRevision{{
		CollectionID: "c-matt", Slug: "matt-pocock-skills", Revision: 1,
		Entries: []apm.CollectionEntry{
			{Ref: "mattpocock/skills/skills/grill-me#v1.3.2"},
			{Ref: "mattpocock/skills/skills/tdd#v1.3.2"},
		},
	}}, "")
	if err != nil {
		t.Fatalf("flatten the matt-pocock set: %v", err)
	}
	return set
}

func isoPstack(t *testing.T) isoCollectionSet {
	t.Helper()
	set, err := isoBuildSet("p-pstack", []apm.CollectionRevision{{
		CollectionID: "c-pstack", Slug: "pstack-claude-code", Revision: 1,
		Entries: []apm.CollectionEntry{
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#" + isoPstackSHA},
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#" + isoPstackSHA, Skills: []string{"how"}},
		},
	}}, "")
	if err != nil {
		t.Fatalf("flatten the pstack set: %v", err)
	}
	return set
}

func (s isoCollectionSet) axes() ProfileAxes {
	return ProfileAxes{
		AgentProfileID: s.profileID,
		LauncherID:     "claude",
		APMTarget:      apm.TargetClaude,
		APMLockDigest:  s.digest,
		APMCollections: s.collects,
	}
}

// isoStageUnit is one run's worth of the real staging shape: a real git checkout
// under <root>/work/repos/<name> and the per-attempt HOME at <root>/work/home
// (the ADR-0017 D1 layout stageAPM is handed by prepare). It returns an error
// rather than calling t.Fatalf because the two units are staged concurrently.
func isoStageUnit(svc *UnitService, set isoCollectionSet, root, origin, runID, repoName string) (*Unit, error) {
	work := filepath.Join(root, "work")
	checkout := filepath.Join(work, "repos", repoName)
	home := filepath.Join(work, "home")
	for _, d := range []string{checkout, home} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	if err := isoGitClone(origin, checkout); err != nil {
		return nil, err
	}
	u := &Unit{
		svc:         svc,
		logger:      slog.New(slog.NewTextHandler(discardWriter{}, nil)),
		Staged:      map[string]*apm.StagedContext{},
		Profile:     set.axes(),
		WorkspaceID: runID,
		Layout: wsgit.Layout{
			ScopeKind: "run", ScopeID: runID, Root: root, Work: work,
			Repos: filepath.Join(work, "repos"), Scratch: filepath.Join(work, "scratch"), Home: home,
		},
		Repos: []wsgit.PreparedRepo{
			{Name: repoName, CheckoutPath: checkout, RepositoryID: "repo-" + runID, MirrorPath: origin},
		},
	}
	return u, nil
}

// TestTwoCollectionSetsStageIntoIsolatedCheckouts is the whole claim: staged
// concurrently, in one worker, profile A gets its skills and only its skills,
// profile B gets its own, neither checkout nor either HOME ever carries the
// other's name, each unit's digest is its own, each checkout's git exclusions
// are declared in that checkout, and a third unit re-staging A's set on top of
// B's HOME picks up nothing from B.
func TestTwoCollectionSetsStageIntoIsolatedCheckouts(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("the per-checkout exclusion assertions run a real git: %v", err)
	}
	origin, err := isoSeedOrigin(t.TempDir())
	if err != nil {
		t.Fatalf("seed the origin repository: %v", err)
	}
	bin, err := isoWriteFakeAPM(t.TempDir())
	if err != nil {
		t.Fatalf("write the fake apm: %v", err)
	}
	// ONE worker: one UnitService, one stager, one binary — the two runs below
	// are two units of it, exactly as two concurrent turns are.
	svc := &UnitService{APM: &APMStager{Binary: bin, Timeout: time.Minute}}

	setA, setB := isoMattPocock(t), isoPstack(t)
	root := t.TempDir()

	type outcome struct {
		unit *Unit
		err  error
	}
	outcomes := make([]outcome, 2)
	var wg sync.WaitGroup
	for i, set := range []isoCollectionSet{setA, setB} {
		wg.Add(1)
		go func(i int, set isoCollectionSet) {
			defer wg.Done()
			u, err := isoStageUnit(svc, set, filepath.Join(root, fmt.Sprintf("run-%d", i)), origin,
				fmt.Sprintf("00000000-0000-4000-8000-00000000000%d", i), "backend")
			if err != nil {
				outcomes[i] = outcome{err: err}
				return
			}
			outcomes[i] = outcome{unit: u, err: u.stageAPM(context.Background(), UnitRequest{})}
		}(i, set)
	}
	wg.Wait()

	unitA, unitB := outcomes[0].unit, outcomes[1].unit
	for i, err := range []error{outcomes[0].err, outcomes[1].err} {
		if err != nil {
			t.Fatalf("stageAPM for unit %c: %v", 'A'+i, err)
		}
	}
	if unitA == nil || unitB == nil {
		t.Fatal("both units staged")
	}
	checkoutA, checkoutB := unitA.Repos[0].CheckoutPath, unitB.Repos[0].CheckoutPath
	homeA, homeB := unitA.Layout.Home, unitB.Layout.Home

	// 1. Each checkout holds its own skills and none of the other's, in the
	//    target's tree and in any other tree apm might have written.
	isoWantOnlySkills(t, "checkout A", checkoutA, setA.skills, setB.skills)
	isoWantOnlySkills(t, "checkout B", checkoutB, setB.skills, setA.skills)

	// 2. Neither per-attempt HOME carries the other profile's skill names: what
	//    apm cached in A's HOME is A's, and the same on B's side.
	isoWantNoNamesUnder(t, "home A", homeA, setB.skills)
	isoWantNoNamesUnder(t, "home B", homeB, setA.skills)

	// 3. The digests are the profiles' own, they differ, and the staged record
	//    agrees with the lock actually on disk in each checkout.
	digestA, err := apm.LockDigest(filepath.Join(checkoutA, apm.LockFileName))
	if err != nil {
		t.Fatalf("read A's lock: %v", err)
	}
	digestB, err := apm.LockDigest(filepath.Join(checkoutB, apm.LockFileName))
	if err != nil {
		t.Fatalf("read B's lock: %v", err)
	}
	if digestA == digestB {
		t.Fatalf("two different collection sets produced one lock digest %s", digestA)
	}
	for _, tc := range []struct {
		label    string
		unit     *Unit
		set      isoCollectionSet
		onDisk   string
		other    string
		checkout string
	}{
		{"A", unitA, setA, digestA, digestB, checkoutA},
		{"B", unitB, setB, digestB, digestA, checkoutB},
	} {
		staged := tc.unit.Staged[tc.unit.Repos[0].Name]
		if staged == nil {
			t.Fatalf("unit %s recorded nothing staged", tc.label)
		}
		if staged.LockDigest != tc.set.digest || tc.onDisk != tc.set.digest {
			t.Errorf("unit %s digest: staged=%s on-disk=%s profile=%s — one digest, three readers",
				tc.label, staged.LockDigest, tc.onDisk, tc.set.digest)
		}
		if staged.LockDigest == tc.other {
			t.Errorf("unit %s carried the other profile's digest", tc.label)
		}
		if got := apm.RefsOf(staged.Deps); strings.Join(got, ",") != strings.Join(apm.RefsOf(tc.set.deps), ",") {
			t.Errorf("unit %s staged %v, want its own flattened set %v", tc.label, got, apm.RefsOf(tc.set.deps))
		}
		// The manifest is the profile's, not a merge of both sets: this is where
		// a shared-cache or shared-manifest leak would first be visible.
		manifest := isoReadFile(t, filepath.Join(tc.checkout, apm.ManifestFileName))
		if !strings.Contains(manifest, "communication-profile-context") {
			t.Errorf("unit %s did not stage from a materialized manifest:\n%s", tc.label, manifest)
		}
		for _, other := range []isoCollectionSet{setA, setB} {
			if other.profileID == tc.set.profileID {
				continue
			}
			for _, ref := range apm.RefsOf(other.deps) {
				if strings.Contains(manifest, ref) {
					t.Errorf("unit %s's manifest names %s, which belongs to %s:\n%s", tc.label, ref, other.profileID, manifest)
				}
			}
		}
	}

	// 4. Git exclusions: each checkout declares ITS OWN generated paths, in its
	//    own exclusion file, and nothing of the other's.
	for _, tc := range []struct {
		label    string
		unit     *Unit
		checkout string
	}{
		{"A", unitA, checkoutA},
		{"B", unitB, checkoutB},
	} {
		isoCheckExclusions(t, tc.label, tc.unit, tc.checkout)
	}

	// 5. Re-staging A afterwards — into a fresh checkout that inherits B's HOME,
	//    i.e. the worst shared state available (a cache directory full of B's
	//    deployed skills) — must reproduce A alone.
	unitA2, err := isoStageUnit(svc, setA, filepath.Join(root, "run-a-restage"), origin,
		"00000000-0000-4000-8000-000000000099", "backend")
	if err != nil {
		t.Fatalf("prepare the re-staged unit: %v", err)
	}
	unitA2.Profile.APMLockDigest = setA.digest
	unitA2.Layout.Home = homeB // the shared agent HOME, on purpose
	if err := unitA2.stageAPM(context.Background(), UnitRequest{}); err != nil {
		t.Fatalf("re-stage A after B: %v", err)
	}
	restaged := unitA2.Repos[0].CheckoutPath
	isoWantOnlySkills(t, "re-staged A checkout", restaged, setA.skills, setB.skills)
	// B's cache survives in that shared HOME (nothing deleted it), which is
	// exactly why the assertion above matters: the cache is on disk, and it did
	// not become A's context.
	if _, err := os.Stat(filepath.Join(homeB, ".cache", "apm", setB.skills[0], "SKILL.md")); err != nil {
		t.Errorf("the fake's cache entry for %s vanished from the shared HOME: %v", setB.skills[0], err)
	}
	if got, err := apm.LockDigest(filepath.Join(restaged, apm.LockFileName)); err != nil {
		t.Fatalf("read the re-staged lock: %v", err)
	} else if got != setA.digest {
		t.Errorf("re-staging A after B produced digest %s, want A's own %s", got, setA.digest)
	}
}

// isoCheckExclusions proves the exclusion half per checkout: the paths the unit
// staged are named by git's own ignore machinery, and `git check-ignore -v`
// attributes that to THIS checkout's info/exclude — so a checkout is hiding its
// own generated trees, not reading somebody else's declaration. A staged path
// that git still reports as untracked would be a path riding into a checkpoint.
func isoCheckExclusions(t *testing.T, label string, unit *Unit, checkout string) {
	t.Helper()
	excludePath := filepath.Join(checkout, ".git", "info", "exclude")
	contents := isoReadExclusions(t, excludePath)
	for _, want := range []string{apm.ManifestFileName, apm.LockFileName, "apm_modules/", ".claude/skills/"} {
		if !strings.Contains(contents, want+"\n") {
			t.Errorf("checkout %s: exclusion file %s missing %q", label, excludePath, want)
		}
	}
	staged := unit.Staged[unit.Repos[0].Name]
	if staged == nil {
		t.Fatalf("checkout %s: nothing staged to exclude", label)
	}
	// The exclusions are in gitignore form (`apm_modules/`, `.claude/skills/`), so
	// what has to be provably ignored is the FILES staging wrote: the top-level
	// directory a run left behind is not itself matched by a subtree pattern, and
	// checking only the directories would let a file outside the excluded subtree
	// pass unnoticed. One real file per generated path, plus the two lock-shaped
	// files, is the set a checkpoint would capture.
	for _, rel := range staged.GeneratedPaths {
		for _, probe := range isoProbesFor(checkout, rel) {
			src := isoCheckIgnore(t, checkout, probe)
			if src != excludePath {
				t.Errorf("checkout %s: %s is ignored by %s, not by this checkout's own %s", label, probe, src, excludePath)
			}
		}
	}
	// The skill files themselves are inside the excluded trees; git must not see
	// any of them, in either checkout, even though they are real untracked files.
	status, err := isoGitRun(checkout, "status", "--porcelain")
	if err != nil {
		t.Fatalf("checkout %s: git status: %v", label, err)
	}
	if strings.TrimSpace(status) != "" {
		t.Errorf("checkout %s: staging left a diff visible to git:\n%s", label, status)
	}
}

// isoWantOnlySkills asserts the tree evidence: every expected skill directory is
// present, and neither the other set's names nor its cache-shaped directories
// appear anywhere in the tree.
func isoWantOnlySkills(t *testing.T, label, checkout string, want, absent []string) {
	t.Helper()
	found := map[string]bool{}
	for _, target := range []string{".claude/skills", ".agents/skills", ".codex/skills"} {
		entries, err := os.ReadDir(filepath.Join(checkout, target))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("%s: read %s: %v", label, target, err)
		}
		for _, e := range entries {
			found[target+"/"+e.Name()] = true
		}
	}
	for _, name := range want {
		if !found[".claude/skills/"+name] {
			t.Errorf("%s: staged skill %s is missing, found %v", label, name, sortedKeys(found))
		}
	}
	isoWantNoNamesUnder(t, label, checkout, absent)
}

func isoWantNoNamesUnder(t *testing.T, label, dir string, names []string) {
	t.Helper()
	var seen []string
	if err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}
		for _, name := range names {
			if rel == name || strings.HasPrefix(rel, name+string(filepath.Separator)) ||
				strings.Contains(rel, string(filepath.Separator)+name+string(filepath.Separator)) ||
				strings.HasSuffix(rel, string(filepath.Separator)+name) {
				seen = append(seen, rel)
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("%s: walk %s: %v", label, dir, err)
	}
	if len(seen) > 0 {
		t.Errorf("%s: the other profile's skills are present under %s: %v", label, dir, seen)
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// --- fixture plumbing: a real git, a real fake apm -------------------------

func isoWriteFakeAPM(dir string) (string, error) {
	bin := filepath.Join(dir, "apm")
	if err := os.WriteFile(bin, []byte(isoFakeAPMBody), 0o755); err != nil {
		return "", err
	}
	return bin, nil
}

// isoSeedOrigin is a bare repository with one commit on main: the checkouts
// staged below are real clones of it, so `git status` and `git check-ignore`
// answer about the tree the worker actually stages into.
func isoSeedOrigin(dir string) (string, error) {
	bare := filepath.Join(dir, "seed.git")
	work := filepath.Join(dir, "seed-work")
	for _, d := range []string{bare, work} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return "", err
		}
	}
	if _, err := isoGitRun(bare, "init", "--bare", "--initial-branch=main"); err != nil {
		return "", err
	}
	if _, err := isoGitRun(work, "init", "--initial-branch=main"); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("# seed\n"), 0o644); err != nil {
		return "", err
	}
	for _, args := range [][]string{{"add", "README.md"}, {"commit", "-m", "seed"}, {"remote", "add", "origin", bare}, {"push", "origin", "main"}} {
		if _, err := isoGitRun(work, args...); err != nil {
			return "", err
		}
	}
	return bare, nil
}

func isoGitClone(origin, dest string) error {
	_, err := isoGitRun("", "clone", "-q", origin, dest)
	return err
}

// isoGitRun runs one git command with no dependence on the developer's config or
// identity: a fixture that worked only on a configured machine would make every
// exclusion assertion here about the operator.
func isoGitRun(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Iso", "GIT_AUTHOR_EMAIL=iso@communication.test",
		"GIT_COMMITTER_NAME=Iso", "GIT_COMMITTER_EMAIL=iso@communication.test",
		"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=*")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// isoProbesFor turns one generated path into the files under it that git must
// not see: the path itself when it is a file, else every file directly beneath
// it (recursively, but only as far as staging goes — a generated tree is two
// levels deep by probe A1).
func isoProbesFor(checkout, rel string) []string {
	if st, err := os.Lstat(filepath.Join(checkout, rel)); err == nil && !st.IsDir() {
		return []string{rel}
	}
	var out []string
	_ = filepath.WalkDir(filepath.Join(checkout, rel), func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // an unreadable entry is git's to complain about
		}
		if r, relErr := filepath.Rel(checkout, path); relErr == nil {
			out = append(out, r)
		}
		return nil
	})
	if len(out) == 0 {
		return []string{rel}
	}
	return out
}

// isoCheckIgnore returns the absolute path of the ignore source git attributes
// <rel> to, or an error if git does not consider it ignored at all.
func isoCheckIgnore(t *testing.T, checkout, rel string) string {
	t.Helper()
	out, err := isoGitRun(checkout, "check-ignore", "-v", rel)
	if err != nil {
		t.Fatalf("checkout %s: git considers %s NOT ignored (err %v): %s", checkout, rel, err, out)
	}
	field := strings.Fields(strings.TrimRight(out, "\n"))
	if len(field) < 2 {
		t.Fatalf("checkout %s: unreadable check-ignore output for %s: %q", checkout, rel, out)
	}
	src := strings.Split(field[0], ":")[0]
	if !filepath.IsAbs(src) {
		src = filepath.Join(checkout, src)
	}
	return filepath.Clean(src)
}

func isoReadExclusions(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the checkout's git exclusion file %s: %v", path, err)
	}
	return string(data)
}

func isoReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
