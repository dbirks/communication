package nono

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	// ProfileAgentTurn enforces filesystem and AF_UNIX and (since ADR-0035)
	// carries the egress allowlist a real Claude/Codex turn runs under —
	// ADR-0019 D3's "network is an axis" with its third value. An agent-turn
	// profile authored with no host list is still the open-network shape.
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
	// ProfileAPMResolve is the policy for an APM lock resolve's sandboxed child
	// (ADR-0054 §B.2): the same filesystem shape as the agent turn — grants are
	// per-run CLI flags, the static shape lives in the file — with the egress
	// axis the resolve must carry, an allowlist of the package-source hosts a
	// pinned ref may be fetched from. A resolve must fetch (never --block-net), so
	// its kind is allowlisted rather than egress-denied; the host set rides in the
	// profile file and therefore in the digest, exactly as ADR-0035 amended for
	// the agent turn.
	ProfileAPMResolve = "communication-apm-resolve"
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
	// NetworkEnforced is the profile's own claim on the egress axis in the
	// ADR-0035 tri-state: NetworkDenied for the egress-denied kinds
	// (ProfileEgressDenied, ProfileCommand), NetworkAllowlisted when the file
	// carries a proxy allowlist, NetworkOpen otherwise. It is committed to the
	// digest, so a recorded policy_digest identifies the host set as well as
	// the file. What a RUN may claim is weaker than what the PROFILE claims:
	// see VerificationResult.EgressReport — a run says "allowlisted" only once
	// its own audit journal shows a denial (design A's rule, docs/design/
	// agent-egress.md), so an allowlist nobody exercised keeps reporting
	// network_enforced=false.
	NetworkEnforced NetworkEnforcement
	// EgressHosts is the allowlist the digest commits to, empty unless
	// NetworkEnforced is NetworkAllowlisted.
	EgressHosts []string
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
	// Network is the ADR-0035 axis. It is a pointer because encoding/json
	// never treats a struct value as empty: absent means the key is not in the
	// file at all, which is the open-network shape (and the shape every
	// pre-ADR-0035 digest had).
	Network *profileNetwork `json:"network,omitempty"`
}

// profileNetwork is the subset of nono's NetworkConfig this product authors.
// `block` is deliberately absent: egress denial is the --block-net flag on a
// profile whose kind says denied, and block-plus-allowlist is the contradiction
// nono's own parser refuses ("--block-net and --allow-domain are
// contradictory: domain filtering requires proxy mode", measured).
// `deny_domain` is here because nono evaluates it BEFORE the allowlist, so a
// policy that could not express it could not be reviewed as a whole.
type profileNetwork struct {
	AllowDomain []string `json:"allow_domain,omitempty"`
	DenyDomain  []string `json:"deny_domain,omitempty"`
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
	// ReadFile is the read-only *single file* list: system files that exist
	// but must not be writable inside the sandbox (probes C-GITCFG, C-BASHRC).
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
const GrantModelNote = "static policy in the profile file (mediation, the Landlock pin, the /tmp and host-conditional group exclusions, the device re-grants and the read-only system config and shell startup files); per-run grants as CLI flags, asserted by their [user] tag in the verbose dry-run"

// profileVersion is bumped when the body below changes, so a recorded
// policy_digest identifies a policy revision and not just a filename.
// 3.1.0 adds the host-conditional group exclusions CI run 38755314927 proved
// necessary (probe C-HOSTGRP).
// 3.2.0 adds the read-only system git config file CI run 38759216292 proved
// git needs wherever that file exists (probe C-GITCFG).
// 3.3.0 adds the read-only shell startup files that made every shell step of
// a sandboxed pipeline agent fail (probe C-BASHRC, ADR-0033).
// 3.4.0 adds the `network` member: the agent kind is authored with an egress
// allowlist by default, so the policy digest now commits to a host set
// (ADR-0035 amending ADR-0019 D3). The egress-denied kinds keep --block-net as
// a CLI flag and their file shape only changes by version string. (The apm-resolve
// kind added below ships on this same policy revision: the version names the
// policy body, and the new kind is authored from the same builder shape.)
const profileVersion = "3.4.0"

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
// The same class of failure has a second member, measured on 2026-10-16 in
// the worker image (probe C-BASHRC, ADR-0033): a pipeline agent attempt whose
// every Bash step reported failure, because the agent harness starts bash
// with its system startup files and Debian's bash treats a present-but-
// unreadable one as an error it prints on every invocation:
//
//	/bin/bash: /etc/bash.bashrc: Permission denied   (interactive shells)
//	/bin/bash: /etc/profile: Permission denied       (login shells)
//
// /etc/bash.bashrc and /etc/profile are world-readable startup files; the
// `system_read_linux_core` group names a fixed /etc list that contains
// neither (observed: `nono profile groups system_read_linux_core` lists
// passwd/group/nsswitch.conf/hosts/…, not the shell's files — the other
// candidates bash reads, nsswitch.conf and passwd, are already in that
// group, and /etc/inputrc does not exist in the pinned worker image, where
// a missing file is skipped silently). Granting them changed nothing else:
// /etc/shadow stayed denied and /etc stayed unlistable-by-grant.
//
// The grant is the exact file, never the directory: `--read /etc` would hand
// the agent every system configuration file to read.
var systemConfigReads = []string{"/etc/gitconfig", "/etc/bash.bashrc", "/etc/profile"}

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

// resolveNetwork is the one place that decides what a kind's network axis is,
// so a profile's tri-state claim and its bytes cannot disagree. net == "" means
// "the caller had no opinion": the agent kind gets the shipped allowlist and
// the two egress-denied kinds keep --block-net semantics.
func resolveNetwork(kind string, net NetworkEnforcement, allow []string) (NetworkEnforcement, []string, error) {
	switch kind {
	case ProfileAgentTurn, ProfileEgressDenied, ProfileCommand, ProfileAPMResolve:
	default:
		return "", nil, fmt.Errorf("sandbox: unknown profile kind %q (want %s, %s, %s or %s)", kind, ProfileAgentTurn, ProfileEgressDenied, ProfileCommand, ProfileAPMResolve)
	}
	if net == "" {
		if kind == ProfileAgentTurn {
			if len(allow) == 0 {
				allow = DefaultEgressHosts()
			}
			net = NetworkAllowlisted
		} else if kind == ProfileAPMResolve {
			if len(allow) == 0 {
				allow = DefaultAPMEgressHosts()
			}
			net = NetworkAllowlisted
		} else {
			net = NetworkDenied
		}
	}
	switch net {
	case NetworkOpen:
		if len(allow) > 0 {
			return "", nil, fmt.Errorf("sandbox: an open-network policy cannot carry an allowlist (%d host(s) requested): say %q or %q, never both (ADR-0035)", len(allow), NetworkOpen, NetworkAllowlisted)
		}
		if kind != ProfileAgentTurn {
			return "", nil, fmt.Errorf("sandbox: profile %s is an egress-denied policy and cannot be authored with network %q: that would widen a policy whose whole contract is that commands and the case-13 gate have no egress", kind, NetworkOpen)
		}
		return NetworkOpen, nil, nil
	case NetworkAllowlisted:
		if kind != ProfileAgentTurn && kind != ProfileAPMResolve {
			return "", nil, fmt.Errorf("sandbox: profile %s is an egress-denied policy: an allowlist belongs on the agent-turn or apm-resolve kind, and --block-net with --allow-domain is the contradiction nono's own parser refuses (measured: \"--block-net and --allow-domain are contradictory: domain filtering requires proxy mode\")", kind)
		}
		hosts, err := NormalizeEgressHosts(allow)
		if err != nil {
			return "", nil, err
		}
		if len(hosts) == 0 {
			// An empty allowlist is the silent-degradation case: nono's proxy
			// with no grant allows nothing, but an author who wrote the list by
			// accident and got an open profile would never see it. Refuse.
			return "", nil, fmt.Errorf("sandbox: profile %s requested %q with no host: an allowlist that resolves to nothing is a policy nobody can read off the file (ADR-0035)", kind, NetworkAllowlisted)
		}
		return NetworkAllowlisted, hosts, nil
	case NetworkDenied:
		if len(allow) > 0 {
			return "", nil, fmt.Errorf("sandbox: an egress-denied policy cannot carry an allowlist (%d host(s) requested): --block-net and domain filtering are contradictory in nono's own config parser (ADR-0035 keeps the command profile unchanged)", len(allow))
		}
		return NetworkDenied, nil, nil
	default:
		return "", nil, fmt.Errorf("sandbox: unknown network enforcement %q (want %s, %s or %s)", net, NetworkOpen, NetworkAllowlisted, NetworkDenied)
	}
}

func profileBody(kind string, net NetworkEnforcement, allow []string) (profileSource, error) {
	net, hosts, err := resolveNetwork(kind, net, allow)
	if err != nil {
		return profileSource{}, err
	}
	desc := "Communication agent sandbox: filesystem + AF_UNIX enforced, network open (ADR-0019 D3 agent-turn)"
	if kind == ProfileAgentTurn && net == NetworkAllowlisted {
		desc = "Communication agent sandbox: filesystem + AF_UNIX enforced, egress allowlisted through nono's proxy (network.allow_domain; ADR-0035 amending ADR-0019 D3 agent-turn)"
	}
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
		Network: networkBody(net, hosts),
	}, nil
}

// networkBody renders the file's `network` member, or nil for the absent
// (open / flag-only-denied) shape. hosts is the canonical list resolveNetwork
// already validated, so the bytes and the tri-state claim are one computation.
func networkBody(net NetworkEnforcement, hosts []string) *profileNetwork {
	if net != NetworkAllowlisted || len(hosts) == 0 {
		return nil
	}
	return &profileNetwork{AllowDomain: append([]string(nil), hosts...)}
}

// ProfileJSON renders the canonical bytes of a policy file. Exported because
// `communication doctor` prints the digest it is about to launch under, and
// two renderings that disagree would make that number meaningless.
func ProfileJSON(kind string) ([]byte, error) {
	return ProfileJSONNetwork(kind, "", nil)
}

// ProfileJSONNetwork renders the canonical bytes of a policy file with an
// explicit network axis ("" = the kind's default). Exported alongside
// ProfileJSON for the same reason: the worker writes these bytes, `doctor`
// prints their digest, and two renderings that disagree would make that number
// meaningless.
func ProfileJSONNetwork(kind string, net NetworkEnforcement, allow []string) ([]byte, error) {
	body, err := profileBody(kind, net, allow)
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
//
// dir must be PRIVATE to one execution unit — a temp dir, or an
// OpenProfileSlot. The file name is one per kind, so a shared dir is one file
// for every unit that uses it, and a second unit's write used to land on top of
// the first unit's asserted bytes (see ProfileSlot for what that broke on the
// lab). It cannot any more: publishing refuses to replace a foreign policy
// rather than overwriting it, so a shared dir now fails closed.
func WriteProfile(dir, kind string) (*Profile, error) {
	return WriteProfileNetwork(dir, kind, "", nil)
}

// WriteProfileNetwork materializes a policy file with an explicit network axis
// (ADR-0035): net "" takes the kind default, NetworkOpen authors the agent kind
// with no `network` member at all, and NetworkAllowlisted commits `allow` to the
// file — and therefore to the digest. Only the worker's own configuration ever
// reaches this (COMMUNICATION_AGENT_EGRESS_ALLOW); a pipeline document cannot,
// because an agent must not choose which hosts it may talk to.
//
// The file name is still one per kind: the digest, not the path, is what
// identifies the policy a unit ran under — which is precisely why the
// DIRECTORY must be per-unit (OpenProfileSlot) and not a shared policy dir.
func WriteProfileNetwork(dir, kind string, net NetworkEnforcement, allow []string) (*Profile, error) {
	return writeProfileNetwork(dir, kind, net, allow)
}

// writeProfileNetwork is the one materializer: the shared-name path and a unit's
// private slot produce the same bytes, the same publish rule and the same
// Profile, so a digest recorded for a slot launch identifies exactly the policy
// a shared-dir launch of the same kind and axis would have produced.
func writeProfileNetwork(dir, kind string, net NetworkEnforcement, allow []string) (*Profile, error) {
	if dir == "" {
		return nil, fmt.Errorf("sandbox: no directory to write profile %s into", kind)
	}
	net, hosts, err := resolveNetwork(kind, net, allow)
	if err != nil {
		return nil, err
	}
	data, err := ProfileJSONNetwork(kind, net, hosts)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("sandbox: create profile dir %s: %w", dir, err)
	}
	path, err := publishProfileBytes(dir, kind, data)
	if err != nil {
		return nil, err
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
		NetworkEnforced: net, EgressHosts: hosts,
		ProfileVersion: profileVersion,
	}, nil
}

// profileSlotPrefix names the private directory OpenProfileSlot creates. It is
// a prefix and not the whole name because a unit id alone is not proof of
// uniqueness (two workers may share a policy root, and a crashed attempt leaves
// its id behind); the random suffix MkdirTemp appends is what makes the path
// unpredictable, and openedSlots is what makes it provably ours.
const profileSlotPrefix = "unit-"

// openedSlots records the slot directories THIS process created. Close consults
// it, so cleanup can never remove a directory it did not open — the pattern check
// alone would be satisfied by a stray `unit-whatever` the worker or an operator
// made in the same root, and "cleanup removed the wrong tree" is not a failure
// mode worth having in the code that owns sandbox policy files.
var (
	slotsMu     sync.Mutex
	openedSlots = map[string]struct{}{}
)

func recordSlot(dir string) {
	slotsMu.Lock()
	defer slotsMu.Unlock()
	openedSlots[dir] = struct{}{}
}

func forgetSlot(dir string) bool {
	slotsMu.Lock()
	defer slotsMu.Unlock()
	if _, ok := openedSlots[dir]; !ok {
		return false
	}
	delete(openedSlots, dir)
	return true
}

// ProfileSlot is ONE execution unit's private policy directory: a fresh 0700
// directory under the worker's policy root, named for the unit that owns it,
// holding the fixed per-kind file name `nono run -p` is handed.
//
// Why this type exists. The adapter used to materialize each kind once per
// worker process at `<policy dir>/<kind>.json` and memoize it, which assumed one
// unit per path per process. Concurrent turns broke that: two attempts on one
// worker resolved the same file, and the second write replaced the bytes the
// first had already handed to AssertOwnBytes, so the first launch died with
//
//	sandbox: profile …/communication-agent.json changed after it was written
//
// (lab: issue2-workbench A6, two agent turns at once, code_review attempts
// closing sandbox_enforcement_failed). The assertion is the only thing that
// proves the policy shape (C-FC2b: no nono surface reveals `external`), so the
// file it runs against must be unshareable rather than the check being relaxed.
//
// Protection: the directory is created by MkdirTemp (exclusive: O_EXCL on the
// directory, and a name nobody can predict), is 0700 and owned by the worker,
// and never enters a launch grant set — the agent's sandbox has no rule naming
// it, so no sandboxed child can read, replace or unlink a policy file. The file
// inside is created without clobbering (publishProfileBytes). Close removes the
// slot at the unit boundary; a slot left by a crashed worker holds nothing but
// public policy bytes in a directory only the worker can enter.
//
// nono does not require a fixed profile name or location — the path is an
// argument (`-p <path>`, ADR-0009 D4) and `meta.name` inside the file is what
// identifies the kind — so the per-attempt directory keeps both the shipped
// file name and the digest identity unchanged.
type ProfileSlot struct {
	root string
	dir  string

	// mu guards closed so a second Close (an attempt loop that retries its
	// cleanup, or a deferred Close plus an explicit one) is a no-op rather than
	// a refusal built from its own success.
	mu     sync.Mutex
	closed bool
}

// OpenProfileSlot creates a private policy directory for one execution unit
// (attempt id, turn id, resolve id) under root. The id is sanitized and bounded
// so it can name a directory and nothing else; uniqueness comes from the random
// suffix, so two units never resolve the same path even with the same id.
func OpenProfileSlot(root, unitID string) (*ProfileSlot, error) {
	if root == "" {
		return nil, fmt.Errorf("sandbox: no policy root to open a private profile directory in (ADR-0009 D4 requires -p <path>)")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("sandbox: create profile root %s: %w", root, err)
	}
	dir, err := os.MkdirTemp(root, profileSlotPrefix+sanitizeSlotID(unitID)+"-")
	if err != nil {
		return nil, fmt.Errorf("sandbox: open private profile dir under %s: %w", root, err)
	}
	// MkdirTemp creates 0700; the chmod makes that an asserted fact of this
	// package rather than an assumption about the standard library, and a dir
	// that cannot be sealed is removed rather than used.
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("sandbox: seal private profile dir %s: %w", dir, err)
	}
	recordSlot(dir)
	return &ProfileSlot{root: root, dir: dir}, nil
}

// Dir is the slot's directory: the only place this unit's policy files live.
func (s *ProfileSlot) Dir() string {
	if s == nil {
		return ""
	}
	return s.dir
}

// Write materializes kind inside the slot.
func (s *ProfileSlot) Write(kind string) (*Profile, error) {
	return s.WriteNetwork(kind, "", nil)
}

// WriteNetwork materializes kind inside the slot with an explicit network axis
// (the same resolution WriteProfileNetwork performs, so a slot profile and a
// shared one of the same kind digest identically).
func (s *ProfileSlot) WriteNetwork(kind string, net NetworkEnforcement, allow []string) (*Profile, error) {
	if s == nil || s.dir == "" {
		return nil, fmt.Errorf("sandbox: no profile slot to write %s into", kind)
	}
	return writeProfileNetwork(s.dir, kind, net, allow)
}

// Close removes the slot and everything in it. It removes only a directory this
// process opened as a slot (openedSlots) and that still sits where and how such
// a directory sits — the guard is what makes a deferred Close safe to call on
// every exit path, and it is why a mistake cannot turn cleanup into an rm of
// somebody else's tree. A slot already gone is not an error (Close is
// idempotent).
func (s *ProfileSlot) Close() error {
	if s == nil || s.dir == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	base := filepath.Base(s.dir)
	if s.dir == s.root || filepath.Dir(s.dir) != s.root || !strings.HasPrefix(base, profileSlotPrefix) || !forgetSlot(s.dir) {
		return fmt.Errorf("sandbox: refusing to remove %s: not a profile slot this adapter opened under %s", s.dir, s.root)
	}
	if err := os.RemoveAll(s.dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Put the record back: the dir may still be there, and a later Close (the
		// attempt loop retries its cleanup) must be able to finish the job.
		recordSlot(s.dir)
		return fmt.Errorf("sandbox: remove profile slot %s: %w", s.dir, err)
	}
	s.closed = true
	return nil
}

// sanitizeSlotID keeps a unit id inside the character set a directory name may
// carry: separators, traversal, dots and control characters all become dashes,
// so an id that arrived from a claim can name a slot and nothing else. A dot is
// replaced rather than allowed because it is how `.` and `..` are spelled, and a
// bounded name is how a claim cannot make the worker build a path longer than
// the filesystem's per-element limit.
func sanitizeSlotID(id string) string {
	const maxLen = 64
	var b strings.Builder
	for _, r := range id {
		if b.Len() >= maxLen {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		out = "unknown"
	}
	return out
}

// publishProfileBytes makes `data` the content of <dir>/<kind>.json without ever
// replacing a file that is already there.
//
// The bytes land in a uniquely named temp file (so a half-written policy is
// never visible at the final path — C-MISSING/N6's fail-closed direction) and
// are published with os.Link, which is atomic and refuses an existing target.
// The old shape wrote a fixed `<path>.tmp` and renamed it over the target, which
// is how one turn could replace another turn's asserted policy: the fixed temp
// name was shared too, and the rename was unconditional.
//
// A refusal is honoured only when the file already there digests to the very
// same bytes — the same policy, authored by somebody else — and is otherwise an
// error naming the conflict. Two units wanting two different policies at one
// path is a shared-path bug, and last-write-wins is the failure this closes.
func publishProfileBytes(dir, kind string, data []byte) (string, error) {
	path := filepath.Join(dir, kind+".json")
	tmp, err := os.CreateTemp(dir, kind+".json.write-*")
	if err != nil {
		// No temp file here (some filesystems refuse them to this process):
		// the exclusive create below is the same no-clobber guarantee, minus
		// atomic visibility.
		return publishProfileDirect(dir, kind, data)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("sandbox: write profile %s: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("sandbox: sync profile %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("sandbox: close profile %s: %w", path, err)
	}
	// 0400 until the bytes are complete and synced; world-readable only
	// afterwards, and only because a policy file contains nothing secret.
	if err := os.Chmod(tmpName, 0o444); err != nil {
		return "", fmt.Errorf("sandbox: seal profile %s: %w", path, err)
	}
	if err := os.Link(tmpName, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return path, adoptExistingProfile(path, data)
		}
		return publishProfileDirect(dir, kind, data)
	}
	return path, nil
}

// publishProfileDirect is the no-hard-links shape of the same rule: O_EXCL
// create, so the writer either owns a brand-new file or adopts/refuses an
// existing one, and never truncates a policy another unit may be holding.
func publishProfileDirect(dir, kind string, data []byte) (string, error) {
	path := filepath.Join(dir, kind+".json")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return path, adoptExistingProfile(path, data)
		}
		return "", fmt.Errorf("sandbox: create profile %s: %w", path, err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("sandbox: write profile %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("sandbox: sync profile %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("sandbox: close profile %s: %w", path, err)
	}
	// Explicit chmod: OpenFile's mode passes through the process umask, and a
	// worker running with a private umask must not produce a policy file the
	// tooling cannot read.
	if err := os.Chmod(path, 0o444); err != nil {
		return "", fmt.Errorf("sandbox: seal profile %s: %w", path, err)
	}
	return path, nil
}

// adoptExistingProfile is the only way an existing policy file is ever used: by
// proving it is the same policy, never by overwriting it.
func adoptExistingProfile(path string, data []byte) error {
	onDisk, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("sandbox: profile %s exists but is unreadable: %w", path, err)
	}
	if got := DigestProfile(onDisk); got != DigestProfile(data) {
		return fmt.Errorf("sandbox: profile %s already holds a different policy (%s, expected %s): this adapter never replaces a policy file another unit may have asserted. Each execution unit materializes its policy in its own directory (OpenProfileSlot) — one shared path for two concurrent units is what let a second unit's write land between a first unit's write and its digest assertion", path, got, DigestProfile(data))
	}
	return nil
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
			return fmt.Errorf("sandbox: profile %s does not grant read access to %s: system tools treat a file that exists but cannot be read as an error, not as an absent file — git exits 128 on an unreadable /etc/gitconfig (probe C-GITCFG, CI run 38759216292) and bash prints `/etc/bash.bashrc: Permission denied` on every shell it starts when its system startup file is unreadable, which failed every shell step of a sandboxed pipeline agent (probe C-BASHRC, ADR-0033). A host that ships the file fails every sandboxed command that reads it", p.Path, f)
		}
	}
	for _, f := range body.FS.ReadFile {
		if !containsString(systemConfigReads, f) {
			return fmt.Errorf("sandbox: profile %s reads %q, which is not on this adapter's read-only system-file contract: the list is pinned so no system file starts being readable inside the sandbox without a reviewed change", p.Path, f)
		}
	}
	// The egress axis is asserted against the same bytes as everything else:
	// the tri-state on the Profile is a claim about this file, and ADR-0035 puts
	// the host set inside the digest precisely so a run cannot describe a network
	// policy the recorded digest does not carry.
	switch p.NetworkEnforced {
	case NetworkAllowlisted:
		if body.Network == nil {
			return fmt.Errorf("sandbox: profile %s claims egress %q but carries no `network` member: the host set lives in the file, so the digest and the claim would disagree (ADR-0035)", p.Path, NetworkAllowlisted)
		}
		if !equalStrings(body.Network.AllowDomain, p.EgressHosts) {
			return fmt.Errorf("sandbox: profile %s allows %v but the Profile reports %v: the allowlist is canonicalized (sorted, deduped) at authoring time, so a file whose list differs from the claim was not written by this adapter", p.Path, body.Network.AllowDomain, p.EgressHosts)
		}
		if len(body.Network.DenyDomain) > 0 {
			return fmt.Errorf("sandbox: profile %s carries deny_domain %v, which this adapter never authors: a deny that beats the allowlist (nono evaluates it first) has to be a reviewed change to the shipped shape, not a stray field", p.Path, body.Network.DenyDomain)
		}
	default:
		if body.Network != nil {
			return fmt.Errorf("sandbox: profile %s carries a `network` member while its claim is %q: an egress policy that is not in the Profile's tri-state is an egress policy nobody reviewed (ADR-0035)", p.Path, p.NetworkEnforced)
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
