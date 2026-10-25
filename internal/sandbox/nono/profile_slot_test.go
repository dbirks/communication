package nono

// The lab's failure, in one paragraph. Every sandboxed unit of a worker used to
// materialize its policy at `<policy dir>/<kind>.json` — one file per kind per
// worker — and AssertOwnBytes ran against that path. Two agent turns at once on
// one worker therefore resolved the SAME file: turn B wrote it (a fixed
// `<path>.tmp` renamed over the target) between turn A's write and A's
// assertion, and A's launch died with
//
//	sandbox: profile …/communication-agent.json changed after it was written
//
// (issue2-workbench A6: concurrent code_review attempts closing
// sandbox_enforcement_failed). AssertOwnBytes is the only thing that can prove
// the policy shape — C-FC2b measured that no nono surface reveals an `external`
// policy — so the fix had to be the path, not the check.
//
// These tests are that regression, and they need no nono binary: the question
// they ask is whose file a unit is asserting, which is decided before nono is
// ever exec'd. Run them with -race -count=20.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type unitAttempt struct {
	id    string
	hosts []string
}

var concurrentAttempts = []unitAttempt{
	{"11111111-1111-4111-8111-111111111111", []string{"api.anthropic.com"}},
	{"22222222-2222-4222-8222-222222222222", []string{"api.openai.com", "github.com"}},
	{"33333333-3333-4333-8333-333333333333", []string{"*.example.com"}},
	{"44444444-4444-4444-8444-444444444444", []string{"registry.npmjs.org", "api.anthropic.com"}},
}

// TestConcurrentAttemptsGetTheirOwnProfileFile is the fix stated as a test: N
// attempts on ONE worker materialize N policies — different policies, because
// that is what made the lab's digest mismatch visible — and every one of them
// still digests to the bytes its own writer wrote.
func TestConcurrentAttemptsGetTheirOwnProfileFile(t *testing.T) {
	root := t.TempDir()

	type prepared struct {
		attempt unitAttempt
		slot    *ProfileSlot
		prof    *Profile
		err     error
	}
	out := make(chan prepared, len(concurrentAttempts))
	var writes, asserts sync.WaitGroup
	start := make(chan struct{})
	release := make(chan struct{})

	for _, a := range concurrentAttempts {
		writes.Add(1)
		go func(a unitAttempt) {
			defer writes.Done()
			<-start
			slot, err := OpenProfileSlot(root, a.id)
			if err != nil {
				out <- prepared{attempt: a, err: err}
				return
			}
			prof, err := slot.WriteNetwork(ProfileAgentTurn, NetworkAllowlisted, a.hosts)
			if err != nil {
				_ = slot.Close()
				out <- prepared{attempt: a, slot: slot, err: err}
				return
			}
			out <- prepared{attempt: a, slot: slot, prof: prof}
		}(a)
	}
	// Release every writer at once: an ordering here would hide the race.
	close(start)
	writes.Wait()
	close(out)

	preparedList := make([]prepared, 0, len(concurrentAttempts))
	for p := range out {
		preparedList = append(preparedList, p)
	}
	t.Cleanup(func() {
		for _, p := range preparedList {
			if p.slot != nil {
				_ = p.slot.Close()
			}
		}
	})

	seenPath := map[string]string{}
	seenDigest := map[string]string{}
	seenDir := map[string]string{}
	for _, p := range preparedList {
		if p.err != nil {
			t.Fatalf("attempt %s could not materialize its profile: %v", p.attempt.id, p.err)
		}
		// The assertion that failed on the lab, run AFTER every other attempt
		// has written its own policy. Before this change this is where
		// "changed after it was written" came from.
		if err := p.prof.AssertOwnBytes(); err != nil {
			t.Errorf("attempt %s: %v", p.attempt.id, err)
			continue
		}
		if !filepath.IsAbs(p.prof.Path) {
			t.Errorf("attempt %s: profile path %s is not absolute", p.attempt.id, p.prof.Path)
		}
		if base := filepath.Base(p.prof.Path); base != ProfileAgentTurn+".json" {
			t.Errorf("attempt %s: profile file %s does not keep the per-kind name: the name is not what identifies a unit, the directory is", p.attempt.id, base)
		}
		if other, ok := seenPath[p.prof.Path]; ok {
			t.Errorf("attempt %s and attempt %s share the profile path %s", other, p.attempt.id, p.prof.Path)
		}
		seenPath[p.prof.Path] = p.attempt.id
		dir := filepath.Dir(p.prof.Path)
		if other, ok := seenDir[dir]; ok {
			t.Errorf("attempt %s and attempt %s share the profile directory %s", other, p.attempt.id, dir)
		}
		seenDir[dir] = p.attempt.id
		if filepath.Dir(dir) != root {
			t.Errorf("attempt %s: profile dir %s is not directly under the worker's policy root %s", p.attempt.id, dir, root)
		}
		if !strings.HasPrefix(filepath.Base(dir), "unit-"+sanitizeSlotID(p.attempt.id)) {
			t.Errorf("attempt %s: profile dir %s does not name the unit that owns it", p.attempt.id, dir)
		}
		// The digest is the journal's identity for the policy, so two different
		// policies must not collapse onto one digest.
		if other, ok := seenDigest[p.prof.Digest]; ok && seenDigest[p.prof.Digest] != p.attempt.id {
			t.Errorf("attempt %s and attempt %s recorded the same digest %s for different policies", other, p.attempt.id, p.prof.Digest)
		}
		seenDigest[p.prof.Digest] = p.attempt.id
		assertFileIsItsOwnPolicy(t, p.attempt, p.prof)
		assertProfilePermissions(t, p.prof.Path)
	}

	// And the assertion holds under repetition while the writes interleave: the
	// lab needed concurrency to hit it, so the test does not trust one pass.
	for _, p := range preparedList {
		if p.err != nil {
			continue
		}
		asserts.Add(1)
		go func(p prepared) {
			defer asserts.Done()
			<-release
			if err := p.prof.AssertOwnBytes(); err != nil {
				t.Errorf("attempt %s: its profile changed after all attempts had written: %v", p.attempt.id, err)
			}
			if err := p.slot.Close(); err != nil {
				t.Errorf("attempt %s: closing its profile slot: %v", p.attempt.id, err)
			}
		}(p)
	}
	close(release)
	asserts.Wait()

	// The unit boundary really did remove the files: the policy root is left
	// with no per-attempt directories.
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read policy root: %v", err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("policy root %s still holds %v after every attempt closed", root, names)
	}
}

// assertFileIsItsOwnPolicy proves the file on disk is the policy THIS attempt
// asked for — the "each child gets its own file" half, by content rather than
// by path.
func assertFileIsItsOwnPolicy(t *testing.T, a unitAttempt, prof *Profile) {
	t.Helper()
	data, err := os.ReadFile(prof.Path)
	if err != nil {
		t.Fatalf("attempt %s: read back its profile: %v", a.id, err)
	}
	var body profileSource
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("attempt %s: its profile does not parse: %v", a.id, err)
	}
	want, _, err := resolveNetwork(ProfileAgentTurn, NetworkAllowlisted, a.hosts)
	if err != nil {
		t.Fatalf("attempt %s: resolve its own network axis: %v", a.id, err)
	}
	if body.Network == nil {
		t.Fatalf("attempt %s: its profile carries no allowlist while asking for %q", a.id, want)
	}
	if strings.Join(body.Network.AllowDomain, ",") != strings.Join(prof.EgressHosts, ",") {
		t.Errorf("attempt %s: file allows %v, its Profile reports %v", a.id, body.Network.AllowDomain, prof.EgressHosts)
	}
	if len(prof.EgressHosts) == 0 {
		return
	}
	first := prof.EgressHosts[0]
	if !strings.Contains(strings.Join(body.Network.AllowDomain, ","), first) {
		t.Errorf("attempt %s: its file does not carry its own host %q (it holds %v) — a second attempt's policy landed in this unit's path", a.id, first, body.Network.AllowDomain)
	}
}

// assertProfilePermissions states how the new path is protected: the policy
// file is read-only for everyone and its directory is reachable by its owner
// alone, so a sandboxed child with no grant naming that directory cannot read,
// replace or unlink the policy it is being asserted against.
func assertProfilePermissions(t *testing.T, path string) {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat profile %s: %v", path, err)
	}
	if perm := st.Mode().Perm(); perm != 0o444 {
		t.Errorf("profile %s has mode %o, want 0444", path, perm)
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat profile dir: %v", err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Errorf("profile dir %s has mode %o, want 0700 (only its owner may enter it)", filepath.Dir(path), perm)
	}
}

// TestSharedPolicyFileIsNeverReplacedByAnotherPolicy pins the other half of the
// fix. The old writer renamed a fixed `<path>.tmp` over whatever was at the
// final path, which is how one unit could rewrite a unit that had already
// asserted. A shared directory is still reachable (WriteProfile is exported, and
// `doctor` used it), so it now fails closed instead of last-write-wins.
func TestSharedPolicyFileIsNeverReplacedByAnotherPolicy(t *testing.T) {
	dir := t.TempDir()
	first, err := WriteProfileNetwork(dir, ProfileAgentTurn, NetworkAllowlisted, []string{"api.anthropic.com"})
	if err != nil {
		t.Fatalf("materialize the first policy: %v", err)
	}
	if err := first.AssertOwnBytes(); err != nil {
		t.Fatalf("the first policy does not assert: %v", err)
	}

	if _, err := WriteProfileNetwork(dir, ProfileAgentTurn, NetworkAllowlisted, []string{"api.openai.com"}); err == nil {
		t.Fatal("a second, different policy was written over a unit's asserted policy: that is the lab's bug, and it must be refused")
	} else if !strings.Contains(err.Error(), "already holds a different policy") {
		t.Errorf("err = %v, want it to name the refused replacement", err)
	}

	// The refused write changed nothing: the first unit's file is still the
	// first unit's policy, exactly as it asserted it.
	if err := first.AssertOwnBytes(); err != nil {
		t.Errorf("the asserted policy was disturbed by a refused write: %v", err)
	}

	// The same policy, authored again, is adopted rather than rewritten — same
	// bytes, same digest, no window at all.
	again, err := WriteProfileNetwork(dir, ProfileAgentTurn, NetworkAllowlisted, []string{"api.anthropic.com"})
	if err != nil {
		t.Fatalf("re-materializing an identical policy must succeed: %v", err)
	}
	if again.Digest != first.Digest || again.Path != first.Path {
		t.Errorf("re-materializing the same policy moved it: %s/%s vs %s/%s", again.Path, again.Digest, first.Path, first.Digest)
	}

	// No fixed shared temp name survives (the old `<path>.tmp` was a second
	// shared path), and no partial publication is left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == ProfileAgentTurn+".json.tmp" {
			t.Errorf("the fixed shared temp name %s is back: two writers on one name is how a policy got half-published", e.Name())
		}
		if !strings.HasSuffix(e.Name(), ".json") {
			t.Errorf("unexpected leftover %s: a publish that failed must not litter the policy dir", e.Name())
		}
	}
}

// TestSharedPolicyPathIsWhatBrokeTheLab reproduces the failure itself, with the
// old publication rule spelled out in the test: one shared per-kind path, a
// fixed `<path>.tmp`, and an unconditional rename onto the target. It is here so
// the suite contains the failure and its exact words, not only the fix — and so
// nobody can "simplify" publishProfileBytes back to a rename without a test
// going red.
func TestSharedPolicyPathIsWhatBrokeTheLab(t *testing.T) {
	root := t.TempDir()
	shared := filepath.Join(root, ProfileAgentTurn+".json")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("create the shared policy dir: %v", err)
	}

	// Turn A wrote the shared file the way the adapter used to, and holds the
	// Profile it built from those bytes.
	aHosts := []string{"api.anthropic.com"}
	aBytes, err := ProfileJSONNetwork(ProfileAgentTurn, NetworkAllowlisted, aHosts)
	if err != nil {
		t.Fatalf("render A's policy: %v", err)
	}
	if err := os.WriteFile(shared, aBytes, 0o444); err != nil {
		t.Fatalf("write A's policy at the shared path: %v", err)
	}
	first := &Profile{
		Kind: ProfileAgentTurn, Path: shared, Digest: DigestProfile(aBytes),
		NetworkEnforced: NetworkAllowlisted, EgressHosts: mustHosts(t, aHosts),
		ProfileVersion: profileVersion,
	}
	if err := first.AssertOwnBytes(); err != nil {
		t.Fatalf("the shared file as turn A left it must assert cleanly: %v", err)
	}

	// Turn B: same kind, different policy, same shared path — and the old
	// publish, which replaced whatever was there.
	bBytes, err := ProfileJSONNetwork(ProfileAgentTurn, NetworkAllowlisted, []string{"api.openai.com"})
	if err != nil {
		t.Fatalf("render B's policy: %v", err)
	}
	if err := os.WriteFile(shared+".tmp", bBytes, 0o600); err != nil {
		t.Fatalf("write the old fixed temp name: %v", err)
	}
	if err := os.Rename(shared+".tmp", shared); err != nil {
		t.Fatalf("publish over the shared path: %v", err)
	}

	// Turn A now builds its launch argv, which asserts the file it wrote. This
	// is the lab's failure, in its own words.
	if err := first.AssertOwnBytes(); err == nil {
		t.Fatal("AssertOwnBytes accepted a policy file another unit replaced: either nothing is shared here, or the assertion got weaker")
	} else if !strings.Contains(err.Error(), "changed after it was written") {
		t.Errorf("err = %v, want the lab's `changed after it was written`", err)
	}

	// The same two turns in the shape the adapter uses now: one path each, so
	// there is nothing to collide over.
	slotA, err := OpenProfileSlot(root, "attempt-a")
	if err != nil {
		t.Fatalf("open A's slot: %v", err)
	}
	slotB, err := OpenProfileSlot(root, "attempt-b")
	if err != nil {
		t.Fatalf("open B's slot: %v", err)
	}
	profA, err := slotA.WriteNetwork(ProfileAgentTurn, NetworkAllowlisted, aHosts)
	if err != nil {
		t.Fatalf("write A's policy: %v", err)
	}
	profB, err := slotB.WriteNetwork(ProfileAgentTurn, NetworkAllowlisted, []string{"api.openai.com"})
	if err != nil {
		t.Fatalf("write B's policy: %v", err)
	}
	if profA.Path == profB.Path {
		t.Fatalf("both units got %s: the slot is not private", profA.Path)
	}
	for _, p := range []*Profile{profA, profB} {
		if err := p.AssertOwnBytes(); err != nil {
			t.Errorf("%s did not survive the other unit writing its own policy: %v", p.Path, err)
		}
	}
	_ = slotA.Close()
	_ = slotB.Close()
}

func mustHosts(t *testing.T, allow []string) []string {
	hosts, err := NormalizeEgressHosts(allow)
	if err != nil {
		t.Fatalf("normalize %v: %v", allow, err)
	}
	return hosts
}

// TestProfileSlotCloseRefusesAForeignDir: Close is called on every exit path, so
// it may only ever remove what OpenProfileSlot created.
func TestProfileSlotCloseRefusesAForeignDir(t *testing.T) {
	root := t.TempDir()
	foreign := filepath.Join(root, "workspace-material")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	keep := filepath.Join(foreign, "keep.txt")
	if err := os.WriteFile(keep, []byte("not a profile\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	for _, bad := range []*ProfileSlot{
		{root: root, dir: foreign},
		{root: root, dir: root},
		{root: root, dir: filepath.Join(root, "unit-stray")},
	} {
		if err := bad.Close(); err == nil {
			t.Errorf("Close removed %s, which this adapter did not open as a slot", bad.dir)
		} else if !strings.Contains(err.Error(), "not a profile slot") {
			t.Errorf("Close(%s) err = %v, want it to name the refusal", bad.dir, err)
		}
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("a refused Close disturbed %s: %v", keep, err)
	}
	// A slot is still removable, and twice (every exit path calls Close once;
	// a retry must not turn into an error).
	slot, err := OpenProfileSlot(root, "attempt-1")
	if err != nil {
		t.Fatalf("open slot: %v", err)
	}
	if _, err := slot.Write(ProfileCommand); err != nil {
		t.Fatalf("write command profile: %v", err)
	}
	if err := slot.Close(); err != nil {
		t.Fatalf("close slot: %v", err)
	}
	if err := slot.Close(); err != nil {
		t.Fatalf("closing an already-removed slot: %v", err)
	}
}

// TestOpenProfileSlotRefusesTraversalInUnitID: the unit id arrives from a claim,
// and names a directory the worker then writes a security policy into.
func TestOpenProfileSlotRefusesTraversalInUnitID(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"../../etc/passwd", "..", "", "run/../shadow", "a/b/c", "\x00attempt"} {
		slot, err := OpenProfileSlot(root, id)
		if err != nil {
			t.Fatalf("OpenProfileSlot(%q): %v", id, err)
		}
		dir := slot.Dir()
		if filepath.Dir(dir) != root {
			t.Errorf("unit id %q escaped the policy root: %s", id, dir)
		}
		if strings.Contains(dir, "..") {
			t.Errorf("unit id %q produced a traversing path %s", id, dir)
		}
		if !strings.HasPrefix(filepath.Base(dir), "unit-") {
			t.Errorf("unit id %q produced %s, which is not a slot this adapter would recognize", id, dir)
		}
		if perm := mustStat(t, dir).Mode().Perm(); perm != 0o700 {
			t.Errorf("unit id %q produced a slot dir with mode %o", id, perm)
		}
		// The same id twice: a retried attempt must not find its path taken by
		// the attempt it replaced.
		again, err := OpenProfileSlot(root, id)
		if err != nil {
			t.Fatalf("OpenProfileSlot(%q) a second time: %v", id, err)
		}
		if again.Dir() == dir {
			t.Errorf("unit id %q resolved the same slot twice (%s): an exclusive create cannot be a reuse", id, dir)
		}
		_ = slot.Close()
		_ = again.Close()
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return st
}
