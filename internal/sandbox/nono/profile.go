package nono

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PinnedVersion is the nono release every capability claim in
// docs/compatibility/ was measured against (ADR-0019 N-a: "version ≠ pinned
// 0.80.0" is an abort, not a warning). Upgrading it means rebuilding the
// worker image and re-running the SANDBOX matrix, which is ADR-0019's
// Migration section, not a runtime decision.
const PinnedVersion = "0.80.0"

// Profile kinds are the ADR-0019 Decision 3 policies plus M4's command
// profile. They are separate files rather than one file and a flag because the
// difference is a security claim: a run under agent-turn must never be able to
// say it denied egress.
const (
	// ProfileAgentTurn enforces filesystem and AF_UNIX and leaves network
	// open, which is the only shape a real Claude/Codex turn can run under
	// (ADR-0019 D3: the harness cannot answer without its model API).
	ProfileAgentTurn = "communication-agent"
	// ProfileEgressDenied is the same filesystem policy plus --block-net, used
	// by the case-13 security gate, which proves egress denial with a
	// command-only run instead of lying about a real turn.
	ProfileEgressDenied = "communication-agent-egress-denied"
	// ProfileCommand is the process.exec policy (docs/m4-contract.md § 4
	// step 5): the same filesystem shape as the agent profile — grants = the
	// run workspace and the per-attempt home — with egress DENIED. A build or
	// test command runs offline against the lab's pre-vendored caches, and a
	// command that needs the network fails honestly rather than widening the
	// profile. It carries --block-net exactly like the case-13 kind, so the
	// egress claim and the recorded digest can never disagree.
	ProfileCommand = "communication-command"
)

// Profile is one Communication-owned nono policy file: where it is, what it
// digests to, and which network claim it carries.
type Profile struct {
	// Kind is ProfileAgentTurn, ProfileEgressDenied or ProfileCommand.
	Kind string
	// Path is the file handed to `nono run -p` (ADR-0009 D4: a path we ship,
	// never `nono profile init`, which cannot author a path-named file (N3),
	// and never bare CLI flags, which silently mix in the built-in default).
	Path string
	// Digest is sha256 of the file bytes, in "sha256:<hex>" form. This is the
	// `SandboxPolicyRef` content identity ADR-0019 D5 asks to be recorded per
	// unit.
	Digest string
	// NetworkEnforced is true only for the egress-denied kinds
	// (ProfileEgressDenied, ProfileCommand). For agent-turn it is false and
	// always stays false: ADR-0019 keeps D-021 Provisional until a domain
	// allowlist is observed from inside a real turn.
	NetworkEnforced bool
	// ProfileVersion is nono's `meta.version` for this file, which is a policy
	// revision, not a nono release.
	ProfileVersion string
}

// profileSource is the profile body. It is authored as a struct + canonical
// marshal rather than a string constant so the digest and the assertions below
// can never drift from the bytes on disk, and so `sandbox_policy` is one
// literal that cannot be edited into `external` by a copy/paste (C-FC2b proved
// no nono surface reveals the difference).
type profileSource struct {
	Schema   string          `json:"$schema,omitempty"`
	Meta     profileMeta     `json:"meta"`
	Extends  string          `json:"extends"`
	Linux    profileLinux    `json:"linux"`
	Security profileSecurity `json:"security"`
	Groups   profileGroups   `json:"groups"`
	FS       profileFS       `json:"filesystem"`
}

type profileMeta struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}

type profileLinux struct {
	// AfUnixMediation is the C7 remedy. nono's default is off, which left
	// /var/run/docker.sock reachable (SANDBOX.md C7, reproduced as probe
	// C-SOCK2 with our own file).
	AfUnixMediation string `json:"af_unix_mediation"`
	// SandboxPolicy is pinned to landlock. `external` is never emitted: it
	// silently un-enforces --block-net (C-FC2) and nothing reveals that it
	// happened (C-FC2b).
	SandboxPolicy string `json:"sandbox_policy"`
}

type profileSecurity struct {
	ProcessInfoMode string `json:"process_info_mode"`
}

type profileGroups struct {
	Exclude []string `json:"exclude"`
}

type profileFS struct {
	// ReadFile is the read-only *single file* list. It exists for one entry
	// and one reason: probe C-GITCFG.
	ReadFile  []string `json:"read_file"`
	WriteFile []string `json:"write_file"`
	Allow     []string `json:"allow"`
}

// policyExternal is named so the refusal below can say what it refuses. It is
// never emitted (C-FC2).
const policyExternal = "external"

// GrantModelNote is the measured reason per-run paths are CLI flags and the
// static shape is the profile file.
//
// A profile-file `filesystem.allow` entry resolves to `r+w` and a
// `filesystem.write` entry to `w` alone, and either way it is tagged
// `[profile]` in the verbose dry-run — the same tag nono uses for the grants
// it inherits from `extends: default` (including one for
// /run/systemd/userdb, which no Communication file mentions). A `--allow` CLI
// flag is tagged `[user]`. So N-d's "assert the resolved grant set" is only
// expressible against the CLI flags: they are the part of the policy this
// process computes, and `[user]` is the tag that identifies them. The profile
// file therefore carries the static shape — mediation, policy, temp-group
// exclusion and the device re-grants that exclusion requires — and every
// per-workspace path is a flag.
const GrantModelNote = "static policy in the profile file (mediation, the Landlock pin, the /tmp and host-conditional group exclusions, the device re-grants and the read-only system git config file); per-run grants as CLI flags, asserted by their [user] tag in the verbose dry-run"

// profileVersion is bumped when the body below changes, so a recorded
// policy_digest identifies a policy revision and not just a filename.
// 3.1.0 adds the host-conditional group exclusions CI run 38755314927 proved
// necessary (probe C-HOSTGRP).
// 3.2.0 adds the read-only system git config file CI run 38759216292 proved
// git needs wherever that file exists (probe C-GITCFG).
const profileVersion = "3.2.0"

// systemConfigReads are single system-scoped files the toolchain must be able
// to *read*, granted read-only by the profile file rather than as per-run flags
// (they are host infrastructure, not workspace material, so they belong to the
// static shape — and a `[user]` grant would break N-d's exact-set equality).
//
// /etc/gitconfig is the one CI run 38759216292 died on (probe C-GITCFG): the
// sandboxed `git commit` exited 128 with
//
//	warning: unable to access '/etc/gitconfig': Permission denied   (x3)
//	fatal: unknown error occurred while reading the configuration files
//
// because git treats a system config file that exists but cannot be read as
// fatal, while one that is simply absent (ENOENT) is not. The lab host has no
// /etc/gitconfig at all, and the worker image installs git without git-lfs —
// the only Debian packaging that writes that file (`git lfs install --system`
// in its postinst) — which is why the file exists on the GitHub runner image
// and nowhere this suite had previously run. nono's own
// `system_read_linux_core` group names a fixed list of /etc files and
// /etc/gitconfig is not on it.
//
// The grant is the exact file, never the directory: `--read /etc` would hand
// the agent every system configuration file to read.
var systemConfigReads = []string{"/etc/gitconfig"}

// SystemConfigReads returns the profile's read-only single-file grants, so a
// test can assert the resolved rule against the contract instead of restating
// it inline.
func SystemConfigReads() []string { return append([]string(nil), systemConfigReads...) }

// deviceWrites are the paths the excluded group would otherwise have granted.
//
// C-TMP3 measured the cost of `groups.exclude: [system_write_linux]` — the
// exclusion that closes /tmp, which is the whole point of ADR-0017 D5's temp
// rule — and `/dev/null` stopped being writable, which breaks nearly every
// CLI. So the devices are re-granted explicitly and /tmp is not.
var deviceWrites = []string{"/dev/null", "/dev/zero", "/dev/tty", "/dev/stdout", "/dev/stderr"}

// hostConditionalGroups are nono's default-layer groups whose rules
// materialize only on hosts that happen to carry the paths — and N-d's set
// equality then refuses every launch on those hosts and nobody else's.
// Observed twice, on two different hosts, from the same root cause:
//
//   - CI run 38755314927 (ubuntu-latest): `group:homebrew_linux` resolved
//     `r /home/linuxbrew/.linuxbrew` — Linuxbrew is preinstalled on the
//     runner image — and `grant_assert (grant_mismatch)` refused every launch.
//   - this lab host: `group:user_tools` resolves `r ~/.local/bin`
//     (applications, man, completions) whenever nono's HOME has a ~/.local —
//     reproduced by running the old profile's dry-run with the developer HOME.
//
// The remedy is at the source, not in the assertion: exclude the groups, so
// the resolved list equals exactly what we asked for on ANY host. The deny_*
// groups cannot be excluded (nono marks them required — `profile validate`
// refuses), and deny rules cannot widen a grant anyway. macOS variants are
// excluded so the profile's host independence does not depend on the kernel.
// system_read_linux_core is deliberately NOT excluded: it is the group that
// makes any binary run, it is asserted by name in the allowlist, and its
// rules are system paths, not host userland. The other macOS groups
// (system_read_macos, dangerous_commands_macos) are excluded because this
// product's only claim is the pinned Linux gnu build (docs/compatibility/
// SANDBOX.md), so nothing macOS-shaped is allowed to appear in a resolved
// grant list anywhere; the deny_*_macos groups cannot be excluded (nono
// requires them) but contribute denies, never grants.
var hostConditionalGroups = []string{
	"dangerous_commands_macos",
	"homebrew_linux",
	"homebrew_macos",
	"system_read_macos",
	"system_write_linux",
	"system_write_macos",
	"user_tools",
}

// ExcludedGroups returns the group names the shipped profile removes from the
// default layer. Exported because the portability test asserts the resolved
// grant list against this list, and a test that restated it inline would
// assert a copy rather than the contract.
func ExcludedGroups() []string { return append([]string(nil), hostConditionalGroups...) }

// profileAllows are the read-write system paths the toolchain needs that are
// not covered by the read-only system groups. /proc/self/fd is what a process
// uses to talk about its own stdio; /dev/pts is how Node detects a terminal.
var profileAllows = []string{"/proc/self/fd", "/dev/pts"}

func profileBody(kind string) (profileSource, error) {
	switch kind {
	case ProfileAgentTurn, ProfileEgressDenied, ProfileCommand:
	default:
		return profileSource{}, fmt.Errorf("sandbox: unknown profile kind %q (want %s, %s or %s)", kind, ProfileAgentTurn, ProfileEgressDenied, ProfileCommand)
	}
	desc := "Communication agent sandbox: filesystem + AF_UNIX enforced, network open (ADR-0019 D3 agent-turn)"
	if kind == ProfileEgressDenied {
		desc = "Communication agent sandbox: filesystem + AF_UNIX + egress denied (ADR-0019 D3 agent-turn-egress-denied; case 13's gate only)"
	}
	if kind == ProfileCommand {
		desc = "Communication command sandbox: filesystem + AF_UNIX + egress denied (M4 contract § 4 step 5; the process.exec policy — commands run offline against pre-vendored caches)"
	}
	return profileSource{
		Meta:    profileMeta{Name: kind, Version: profileVersion, Description: desc},
		Extends: "default",
		Linux:   profileLinux{AfUnixMediation: "pathname", SandboxPolicy: policyLandlock},
		Security: profileSecurity{
			// C9b: process *existence* stays visible even isolated; this is the
			// strongest setting nono offers, not a claim of invisibility.
			ProcessInfoMode: "isolated",
		},
		Groups: profileGroups{Exclude: ExcludedGroups()},
		FS: profileFS{
			ReadFile:  append([]string(nil), systemConfigReads...),
			WriteFile: append([]string(nil), deviceWrites...),
			Allow:     append([]string(nil), profileAllows...),
		},
	}, nil
}

// ProfileJSON renders the canonical bytes of a policy file. Exported because
// `communication doctor` prints the digest it is about to launch under, and
// two renderings that disagree would make that number meaningless.
func ProfileJSON(kind string) ([]byte, error) {
	body, err := profileBody(kind)
	if err != nil {
		return nil, err
	}
	// json.Marshal emits struct fields in declaration order, so the output is
	// stable for a given source; no map is involved anywhere in this type.
	out, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("sandbox: encode profile %s: %w", kind, err)
	}
	return append(out, '\n'), nil
}

// DigestProfile is the content identity of arbitrary policy bytes.
func DigestProfile(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// WriteProfile materializes a policy file under dir and returns its identity.
//
// This is where ADR-0009 D4's "a profile we ship" lives at runtime. A
// repository asset would be the natural home (ADR-0019 D5 names
// worker/sandbox/profiles/) and is outside this package's boundary, so the
// worker writes the bytes it can prove and records the digest; the digest, not
// the filename, is what a unit's journal cites. Writing is atomic-ish on
// purpose: the file is 0444 under a 0700 directory owned by the worker, and a
// partially written profile makes `nono run` fail closed (C-MISSING/N6), which
// is the right direction for a failure.
func WriteProfile(dir, kind string) (*Profile, error) {
	if dir == "" {
		return nil, fmt.Errorf("sandbox: no directory to write profile %s into", kind)
	}
	data, err := ProfileJSON(kind)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("sandbox: create profile dir %s: %w", dir, err)
	}
	path := filepath.Join(dir, kind+".json")
	tmp := path + ".tmp"
	// 0600 for the temp file: an agent must never get a window on a policy
	// file mid-write, and the final file is world-readable only because it
	// contains nothing secret.
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return nil, fmt.Errorf("sandbox: write profile %s: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("sandbox: publish profile %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o444); err != nil {
		return nil, fmt.Errorf("sandbox: seal profile %s: %w", path, err)
	}
	// The bytes on disk are re-read and re-digested, because the assertion
	// chain below runs against this digest and a torn write would otherwise be
	// a policy nobody measured.
	onDisk, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("sandbox: read back profile %s: %w", path, err)
	}
	if got := DigestProfile(onDisk); got != DigestProfile(data) {
		return nil, fmt.Errorf("sandbox: profile %s digests to %s, expected %s", path, got, DigestProfile(data))
	}
	return &Profile{
		Kind: kind, Path: path, Digest: DigestProfile(onDisk),
		NetworkEnforced: kind == ProfileEgressDenied || kind == ProfileCommand,
		ProfileVersion:  profileVersion,
	}, nil
}

// AssertOwnBytes is the *only* mechanism that can prove the policy shape, and
// it is worth being blunt about why. C-FC2b measured that `profile validate`
// accepts a profile whose sandbox_policy is `external`, that `profile show`
// output is identical for landlock and external once its own path echo is
// dropped, and that the verbose dry-run rule list is identical too. ADR-0019
// D2's "never emit external" therefore cannot be delegated to nono: the
// adapter checks the file it wrote, before handing it over, and says which
// check failed.
func (p *Profile) AssertOwnBytes() error {
	data, err := os.ReadFile(p.Path)
	if err != nil {
		return fmt.Errorf("sandbox: profile %s is unreadable: %w", p.Path, err)
	}
	if got := DigestProfile(data); got != p.Digest {
		return fmt.Errorf("sandbox: profile %s changed after it was written (%s, expected %s)", p.Path, got, p.Digest)
	}
	var body profileSource
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return fmt.Errorf("sandbox: profile %s does not parse as our own schema: %w", p.Path, err)
	}
	if body.Meta.Name != p.Kind {
		return fmt.Errorf("sandbox: profile %s names %q, expected %q", p.Path, body.Meta.Name, p.Kind)
	}
	if body.Linux.SandboxPolicy != policyLandlock {
		return fmt.Errorf("sandbox: profile %s has sandbox_policy %q: `%s` is never acceptable (C-FC2 measured a child reaching the network under external while --block-net was requested, and no nono surface reveals it)",
			p.Path, body.Linux.SandboxPolicy, policyExternal)
	}
	if body.Linux.AfUnixMediation != "pathname" {
		return fmt.Errorf("sandbox: profile %s has af_unix_mediation %q, want pathname (SANDBOX.md C7 fell open at the defaults)", p.Path, body.Linux.AfUnixMediation)
	}
	if body.Extends != "default" {
		return fmt.Errorf("sandbox: profile %s extends %q; the system read groups come from the default layer and re-listing them by hand is how a path silently stops being granted", p.Path, body.Extends)
	}
	if !containsString(body.Groups.Exclude, "system_write_linux") {
		return fmt.Errorf("sandbox: profile %s does not exclude system_write_linux, which is the group that hands every sandboxed child write access to /tmp (probe C-TMP1/C-TMP3)", p.Path)
	}
	for _, group := range hostConditionalGroups {
		if !containsString(body.Groups.Exclude, group) {
			return fmt.Errorf("sandbox: profile %s does not exclude the host-conditional group %s: its rules materialize only on hosts carrying the paths (CI observed group:homebrew_linux granting /home/linuxbrew/.linuxbrew on ubuntu-latest), and N-d's set equality then refuses every launch on those hosts (probe C-HOSTGRP)", p.Path, group)
		}
	}
	for _, group := range body.Groups.Exclude {
		if !containsString(hostConditionalGroups, group) {
			return fmt.Errorf("sandbox: profile %s excludes group %q, which is not on this adapter's exclusion contract: the exclude list is pinned, so an exclusion nobody reviewed cannot silently narrow the sandbox", p.Path, group)
		}
	}
	for _, dev := range deviceWrites {
		if !containsString(body.FS.WriteFile, dev) {
			return fmt.Errorf("sandbox: profile %s excludes system_write_linux without re-granting %s, and every CLI the agent runs needs it (probe C-TMP3)", p.Path, dev)
		}
	}
	for _, f := range systemConfigReads {
		if !containsString(body.FS.ReadFile, f) {
			return fmt.Errorf("sandbox: profile %s does not grant read access to %s: git treats a system config file that exists but is unreadable as fatal (`fatal: unknown error occurred while reading the configuration files`, exit 128) rather than skipping it the way it skips an absent one, so a host that ships that file fails every sandboxed git command (probe C-GITCFG, CI run 38759216292)", p.Path, f)
		}
	}
	for _, f := range body.FS.ReadFile {
		if !containsString(systemConfigReads, f) {
			return fmt.Errorf("sandbox: profile %s reads %q, which is not on this adapter's read-only system-file contract: the list is pinned so no system file starts being readable inside the sandbox without a reviewed change", p.Path, f)
		}
	}
	return nil
}

func containsString(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
