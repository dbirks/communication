package nono

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestSystemConfigReadsIsThePinnedFileSet pins the policy builder's read-only
// system-file contract exactly (ADR-0033): the set is closed, every entry is
// a single file under /etc (never /etc wholesale, never a directory), and it
// carries the two shell startup files whose absence failed every Bash step of
// a sandboxed pipeline agent alongside the /etc/gitconfig entry that probe
// C-GITCFG established.
func TestSystemConfigReadsIsThePinnedFileSet(t *testing.T) {
	want := []string{"/etc/gitconfig", "/etc/bash.bashrc", "/etc/profile"}
	got := SystemConfigReads()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("system config reads = %v, want exactly %v: the list is pinned so no system file starts being readable inside the sandbox without a reviewed change (ADR-0033)", got, want)
	}
	for _, f := range got {
		if f != "/etc/"+strings.TrimPrefix(f, "/etc/") || strings.Contains(strings.TrimPrefix(f, "/etc/"), "/") {
			t.Errorf("%q is not a direct single file of /etc: only flat world-readable system files belong here; a directory grant would hand the agent /etc to read (ADR-0026's reasoning applies to /etc too)", f)
		}
	}
}

// TestEveryProfileKindCarriesTheShellStartupReads is the builder-level half of
// ADR-0033: all three shipped kinds share one filesystem block, so the grant
// that fixes an agent turn also covers the command and case-13 profiles, and
// it resolves as single read-only files, never as `--read /etc`-style
// directory flags. `--read <file>` itself is not an option: nono 0.80.0's CLI
// rejects it ("CLI path '/etc/bash.bashrc' is not a directory. Use
// --allow-file for single files"), which is why the grant lives in the
// profile file's filesystem.read_file block like /etc/gitconfig does.
func TestEveryProfileKindCarriesTheShellStartupReads(t *testing.T) {
	for _, kind := range []string{ProfileAgentTurn, ProfileEgressDenied, ProfileCommand, ProfileAPMResolve} {
		data, err := ProfileJSON(kind)
		if err != nil {
			t.Fatalf("ProfileJSON(%s): %v", kind, err)
		}
		var body profileSource
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatalf("profile %s does not parse: %v", kind, err)
		}
		if strings.Join(body.FS.ReadFile, ",") != strings.Join(SystemConfigReads(), ",") {
			t.Errorf("profile %s resolves read_file %v, want the pinned set %v", kind, body.FS.ReadFile, SystemConfigReads())
		}
		for _, f := range body.FS.ReadFile {
			if f == "/etc" || f == "/etc/" || !strings.HasPrefix(f, "/etc/") || strings.Contains(strings.TrimPrefix(f, "/etc/"), "/") {
				t.Errorf("profile %s read_file entry %q is not a flat /etc file: /etc wholesale is never granted (ADR-0033)", kind, f)
			}
		}
		// write_file must never name a system startup file: read-only, always.
		for _, w := range body.FS.WriteFile {
			for _, r := range SystemConfigReads() {
				if w == r {
					t.Errorf("profile %s grants WRITE on %s: a system config/startup file is readable inside the sandbox and never writable (ADR-0033)", kind, r)
				}
			}
		}
		// The rendered profile is the one AssertOwnBytes is asked to bless.
		dir := t.TempDir()
		prof, err := WriteProfile(dir, kind)
		if err != nil {
			t.Fatalf("WriteProfile(%s): %v", kind, err)
		}
		if err := prof.AssertOwnBytes(); err != nil {
			t.Errorf("AssertOwnBytes(%s): %v", kind, err)
		}
		if prof.ProfileVersion != profileVersion {
			t.Errorf("profile %s reports version %s, want %s (the digest identifies a policy revision, so the revision must be bumped with the body)", kind, prof.ProfileVersion, profileVersion)
		}
	}
}

// TestAssertOwnBytesRefusesEtcWholesaleAndUnpinnedFiles is the fail-closed
// direction of the contract: a profile that broadens the read list — by
// naming /etc as an entry or adding a file nobody reviewed — never launches.
func TestAssertOwnBytesRefusesEtcWholesaleAndUnpinnedFiles(t *testing.T) {
	for _, tc := range []struct{ name, file, want string }{
		{"/etc wholesale", "/etc", "not on this adapter's read-only system-file contract"},
		{"unreviewed file", "/etc/shadow", "/etc/shadow"},
		{"startup grant dropped", "", "/etc/bash.bashrc"},
	} {
		dir := t.TempDir()
		prof, err := WriteProfile(dir, ProfileAgentTurn)
		if err != nil {
			t.Fatal(err)
		}
		var body profileSource
		raw, err := os.ReadFile(prof.Path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		if tc.file == "" {
			// Drop the shell startup reads; keep the gitconfig entry, so the
			// refusal names the missing file rather than the list in general.
			body.FS.ReadFile = []string{"/etc/gitconfig"}
		} else {
			body.FS.ReadFile = append([]string{tc.file}, body.FS.ReadFile...)
		}
		bad, err := json.MarshalIndent(body, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(prof.Path, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(prof.Path, append(bad, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		lied := &Profile{Kind: prof.Kind, Path: prof.Path, Digest: DigestProfile(append(bad, '\n')), NetworkEnforced: prof.NetworkEnforced, ProfileVersion: prof.ProfileVersion}
		err = lied.AssertOwnBytes()
		if err == nil {
			t.Errorf("tamper %q was accepted", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("tamper %q refused with %q, want it to name %q", tc.name, err, tc.want)
		}
	}
}
