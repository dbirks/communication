package nono_test

// Portability of the resolved grant set (probe C-HOSTGRP, CI run 38755314927).
//
// N-d asserts that the resolved grant set equals the requested one, which is
// only portable if the set nono layers in by itself is the same on every
// host. It was not: on the GitHub runner the default profile's
// `group:homebrew_linux` resolved `r /home/linuxbrew/.linuxbrew` (Linuxbrew is
// preinstalled on ubuntu-latest) and `required` mode refused every launch,
// while the same binary refused nothing on the lab host because the path does
// not exist there. The same class reproduces here with `group:user_tools`,
// which resolves ~/.local/* whenever nono's HOME has one — so "host-conditional
// default group" is a property of the group, not of Linuxbrew, and the fix is
// to exclude the whole class in the shipped profile rather than widen the
// source allowlist.
//
// These tests prove the two halves of that claim:
//
//   - every group nono's own default profile composes is either excluded by us
//     or explicitly declared, so nothing can materialize on an unseen host; and
//   - the resolved grant list of a real verbose dry-run, executed against the
//     *developer* HOME (the hostile configuration that makes host-conditional
//     rules appear on this machine), contains no `group:` source outside the
//     declared set — with a negative control showing the pre-fix exclusion
//     list really does leak `group:user_tools` wherever this host can.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
)

// defaultProfileGroups parses the group list out of `nono profile show
// default` ("Security groups:" followed by indented names).
func defaultProfileGroups(t *testing.T, home string) []string {
	t.Helper()
	cmd := exec.Command(nonobin(), "profile", "show", "default") //nolint:gosec
	cmd.Env = append(os.Environ(), "HOME="+home)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("nono profile show default: %v", err)
	}
	var groups []string
	inList := false
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "Security groups:") {
			inList = true
			continue
		}
		if !inList {
			continue
		}
		name := strings.TrimSpace(line)
		if name == "" || !strings.HasPrefix(line, "  ") || strings.Contains(line, ":") {
			inList = false
			continue
		}
		groups = append(groups, name)
	}
	if len(groups) == 0 {
		t.Fatalf("no Security groups parsed from:\n%s", out)
	}
	return groups
}

// TestProfileExcludesEveryHostConditionalDefaultGroup is the composition-level
// half of C-HOSTGRP: for every group nono's default profile layers in, the
// shipped profile either removes it or the adapter declares it by name. A new
// group arriving in a future default profile (or a renamed one) that is neither
// excluded nor declared fails this test rather than first failing a launch on
// some other host.
func TestProfileExcludesEveryHostConditionalDefaultGroup(t *testing.T) {
	l := newLab(t)

	excluded := map[string]bool{}
	for _, g := range nono.ExcludedGroups() {
		excluded[g] = true
	}
	declared := map[string]bool{}
	for _, s := range nono.DeclaredGrantSources() {
		if name, ok := strings.CutPrefix(s, "group:"); ok {
			declared[name] = true
		}
	}

	// The shipped profile's exclude list must literally equal the contract
	// list, or the composition argument above is about a file nobody ships.
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(prof.Path)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Groups struct {
			Exclude []string `json:"exclude"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	if strings.Join(body.Groups.Exclude, ",") != strings.Join(nono.ExcludedGroups(), ",") {
		t.Fatalf("shipped exclude list %v != contract %v", body.Groups.Exclude, nono.ExcludedGroups())
	}

	for _, group := range defaultProfileGroups(t, l.launcher) {
		// deny_* groups cannot be excluded (nono marks them required and
		// `profile validate` refuses), and they contribute deny rules, never
		// grants — assertGrants admits them by prefix.
		if excluded[group] || declared[group] || strings.HasPrefix(group, "deny_") {
			continue
		}
		t.Errorf("default-profile group %q is neither excluded nor declared: its rules could materialize on a host this lab does not have, and N-d would then refuse every launch there (probe C-HOSTGRP)", group)
	}
}

// grantSourceLine matches the trailing [source] tag of a verbose dry-run rule
// line (same shape as the adapter's own parser; duplicated on purpose so this
// test measures nono's output rather than the parser's opinion of it).
var grantSourceLine = regexp.MustCompile(`^\s*(?:r\+w|rw|=w|r|sock|net|scope)\s+\S+.*\[([^\]]+)\]`)

func observedGrantSources(t *testing.T, profPath, home, readPath string) []string {
	t.Helper()
	cmd := exec.Command(nonobin(), "run", "-p", profPath, "-v", "--dry-run", "--read", readPath, "--", "sh", "-c", "true") //nolint:gosec
	cmd.Env = append(os.Environ(), "HOME="+home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("nono verbose dry-run failed: %v\n%s", err, out)
	}
	var sources []string
	for _, line := range strings.Split(string(out), "\n") {
		if m := grantSourceLine.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil {
			sources = append(sources, m[1])
		}
	}
	return sources
}

// declaredSourceSet is every [tag] a resolved rule may legitimately carry:
// the adapter's declared sources plus the [user] grants of the dry-run itself.
func declaredSourceSet() map[string]bool {
	allowed := map[string]bool{"user": true}
	for _, s := range nono.DeclaredGrantSources() {
		allowed[s] = true
	}
	return allowed
}

func isDeclaredSource(allowed map[string]bool, s string) bool {
	return allowed[s] || strings.HasPrefix(s, "group:deny_")
}

// TestResolvedGrantListHasNoUndeclaredGroupSource is the runtime half of
// C-HOSTGRP: a real verbose dry-run of the shipped profile, executed with the
// developer's own HOME, resolves only declared sources — and the pre-fix
// profile is shown by negative control to leak one on exactly that host.
func TestResolvedGrantListHasNoUndeclaredGroupSource(t *testing.T) {
	l := newLab(t)
	realHome, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no user home to run the hostile-HOME dry-run from: %v", err)
	}
	prof, err := nono.WriteProfile(l.profileDir(), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	allowed := declaredSourceSet()

	sources := observedGrantSources(t, prof.Path, realHome, l.root)
	seen := map[string]bool{}
	for _, s := range sources {
		seen[s] = true
		if !isDeclaredSource(allowed, s) {
			t.Errorf("resolved grant list carries source %q, which this adapter never declared (probe C-HOSTGRP: host-conditional default groups must be excluded in the profile, not allowlisted): sources seen = %v", s, sources)
		}
	}
	for _, g := range nono.ExcludedGroups() {
		if seen["group:"+g] {
			t.Errorf("excluded group %q still contributed a rule", g)
		}
	}
	if !seen["group:system_read_linux_core"] {
		t.Errorf("the shipped profile resolved without system_read_linux_core, which every binary needs; sources seen = %v", sources)
	}
	t.Logf("resolved sources under hostile HOME: %v", sortedKeys(seen))

	// Negative control: the pre-fix exclusion list (system_write_linux only).
	// group:user_tools resolves whenever the real HOME has ~/.local/bin — on
	// this lab host it does; where it does not, the control reports the
	// unobservable condition rather than pretending to have run.
	if _, err := os.Stat(filepath.Join(realHome, ".local", "bin")); err != nil {
		t.Logf("negative control not observable on this host (%v): the assertions above still pin the shipped profile", err)
		return
	}
	var old map[string]any
	data, err := os.ReadFile(prof.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &old); err != nil {
		t.Fatal(err)
	}
	old["groups"] = map[string]any{"exclude": []any{"system_write_linux"}}
	bad, err := json.MarshalIndent(old, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(l.root, "prefix-profile.json")
	if err := os.WriteFile(path, append(bad, '\n'), 0o444); err != nil {
		t.Fatal(err)
	}
	oldSources := observedGrantSources(t, path, realHome, l.root)
	leaked := false
	for _, s := range oldSources {
		if s != "user" && !isDeclaredSource(allowed, s) {
			leaked = true
			t.Logf("negative control confirms the pre-fix profile leaks source %q under HOME=%s", s, realHome)
		}
	}
	if !leaked {
		t.Errorf("negative control is vacuous: the pre-fix exclusion list leaked no undeclared source even though %s exists (observed: %v)", filepath.Join(realHome, ".local", "bin"), oldSources)
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
