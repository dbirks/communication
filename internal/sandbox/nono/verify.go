package nono

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dbirks/communication/internal/sandbox"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// VerificationResult is what N-a…N-d establish for one launch, and what the
// `sandbox.verified` event is allowed to say (ADR-0019 D5: `Verified=true` only
// when the whole chain passed *for this unit* — a cached "the host looked good
// once" note is not a proof, which is why Probe keeps returning Verified=false).
type VerificationResult struct {
	// Backend and Version come from N-a.
	Backend string
	Version string
	// PolicyRef is the profile kind + content digest actually handed to nono.
	PolicyRef    string
	PolicyDigest string
	// AfUnixMediation is the N-c assertion's observed value.
	AfUnixMediation string
	// NetworkEnforced is the profile's own claim, never a guess: false for the
	// agent-turn policy, which is the whole point of having two names.
	NetworkEnforced bool
	// GrantedPaths are the `[user]` grants nono echoed back at N-d — the
	// resolved set, not the requested one (FC3's silent-drop guard).
	GrantedPaths []string
	// GrantLabels is the event-safe form ({role, access} pairs, no paths).
	GrantLabels []string
	// ObservedGroups are the non-`[user]` grant sources that were allowed.
	ObservedGroups []string
	// ChildStarted is true once a process has been exec'd. Verify never sets it
	// (it execs nothing); LaunchPlan does, and the enforcement-failed event
	// reads it from here.
	ChildStarted bool
	// Verified is true only when every step passed.
	Verified bool
	// Stage and Reason say where a failed chain stopped.
	Stage  string
	Reason string
}

// Failure is a chain abort. It carries the stage/reason pair the
// `sandbox.enforcement_failed` event needs, so the worker never has to guess
// after the fact.
type Failure struct {
	Stage  string
	Reason string
	Err    error
	// ChildStarted is true only once exec has happened, per ADR-0019 D6's rule
	// that the event says whether a child was ever launched.
	ChildStarted bool
}

func (f *Failure) Error() string {
	return fmt.Sprintf("sandbox %s failed (%s): %v", f.Stage, f.Reason, f.Err)
}
func (f *Failure) Unwrap() error { return f.Err }

// Verification stages and reasons, from ADR-0019 Decision 6.
const (
	StageProbe        = "probe"
	StageProfile      = "profile"
	StagePolicyAssert = "policy_assert"
	StageGrantAssert  = "grant_assert"
	StageExec         = "exec"
	StageRuntime      = "runtime"
)

// Verify runs N-a through N-d for one launch and returns nothing but the
// verdict: it never execs the adapter. A returned *Failure names the stage that
// stopped the chain, which is what the enforcement-failed event carries.
//
// The four steps are four commands, not one, because each of them has been
// observed to be unable to substitute for another:
//
//	N-a  nono --version / setup --check-only   (does the backend work at all)
//	N-b  nono profile validate <path>          (is our file parseable)
//	N-c  nono profile show <path>              (AF_UNIX mediation; the dry-run
//	      prints no AF_UNIX line at all — probe C-AFU2, grep count 0)
//	N-d  nono run -p … -v --dry-run            (the resolved grant set; only
//	      meaningful without -s — probe C-SILENT)
func (l *Launcher) Verify(ctx context.Context, spec LaunchSpec) (*VerificationResult, error) {
	res := &VerificationResult{Backend: BackendName}
	if spec.Profile != nil {
		res.PolicyRef = spec.Profile.Kind
		res.PolicyDigest = spec.Profile.Digest
		res.NetworkEnforced = spec.Profile.NetworkEnforced
	}
	res.GrantLabels = spec.Plan.Labels()

	// ---- N-a: probe -------------------------------------------------------
	caps, err := l.Probe(ctx)
	if err != nil {
		return res, &Failure{Stage: StageProbe, Reason: probeFailureReason(err), Err: err}
	}
	res.Version = caps.Version
	if caps.Version != PinnedVersion {
		return res, &Failure{Stage: StageProbe, Reason: "binary_version_mismatch",
			Err: fmt.Errorf("nono is version %s but %s is pinned: capability claims in docs/compatibility/ are per-version, so an upgrade is a worker image rebuild plus a re-run of the SANDBOX matrix (ADR-0019 Migration), not a runtime decision", caps.Version, PinnedVersion)}
	}
	if !caps.Filesystem {
		return res, &Failure{Stage: StageProbe, Reason: "fs_unverified", Err: fmt.Errorf("required mode needs verified filesystem isolation and the probe did not observe it: %s", strings.Join(caps.Notes, "; "))}
	}
	if spec.BlockNet && !caps.Network {
		return res, &Failure{Stage: StageProbe, Reason: "tcp_unverified", Err: fmt.Errorf("this launch demands denied egress and the probe did not observe TCP network rule support: %s", strings.Join(caps.Notes, "; "))}
	}

	// ---- N-b: validate the profile we authored ----------------------------
	if spec.Profile == nil {
		return res, &Failure{Stage: StageProfile, Reason: "profile_invalid", Err: fmt.Errorf("no policy file to validate (ADR-0009 D4: -p <path>, never CLI flags alone)")}
	}
	if err := spec.Profile.AssertOwnBytes(); err != nil {
		// Before asking nono anything: C-FC2b proved nono accepts and hides an
		// `external` policy, so nono's opinion is not the first line of defence.
		return res, &Failure{Stage: StageProfile, Reason: "profile_invalid", Err: err}
	}
	bin, err := l.resolveBinary()
	if err != nil {
		return res, &Failure{Stage: StageProfile, Reason: "binary_missing", Err: err}
	}
	if out, err := l.run(ctx, probeTimeout, "", l.launcherEnv(spec), bin, "profile", "validate", spec.Profile.Path); err != nil {
		return res, &Failure{Stage: StageProfile, Reason: "profile_invalid", Err: fmt.Errorf("nono profile validate refused our policy file: %v (%s)", err, firstLine(out))}
	}

	// ---- N-c: assert AF_UNIX mediation ------------------------------------
	showOut, err := l.run(ctx, probeTimeout, "", l.launcherEnv(spec), bin, "profile", "show", spec.Profile.Path)
	if err != nil {
		return res, &Failure{Stage: StagePolicyAssert, Reason: "profile_invalid", Err: fmt.Errorf("nono profile show failed on our policy file: %v (%s)", err, firstLine(showOut))}
	}
	mediation, ok := afUnixMediation(showOut)
	if !ok {
		return res, &Failure{Stage: StagePolicyAssert, Reason: "af_unix_not_mediated", Err: fmt.Errorf("`nono profile show` printed no AF_UNIX mediation line at all, so nothing proves the mediation the policy asks for: %s", onelineList(showOut))}
	}
	res.AfUnixMediation = mediation
	if mediation != "pathname" {
		return res, &Failure{Stage: StagePolicyAssert, Reason: "af_unix_not_mediated", Err: fmt.Errorf("profile reports AF_UNIX mediation %q, want pathname (SANDBOX.md C7 fell open at the defaults; probe N4/C-SOCK2 proved pathname closes the docker socket)", mediation)}
	}

	// ---- N-d: assert the resolved grant set -------------------------------
	verifyArgv, err := spec.BuildVerifyArgv()
	if err != nil {
		return res, &Failure{Stage: StageGrantAssert, Reason: "grant_mismatch", Err: err}
	}
	// The dry-run's own cwd must be inside the grants (Plan.Check already
	// proved the cwd is grantable), so N-d measures the same filesystem view
	// the real launch will get.
	dry, err := l.run(ctx, verifyTimeout, spec.Plan.Cwd, l.launcherEnv(spec), append([]string{bin}, verifyArgv...)...)
	if err != nil {
		return res, &Failure{Stage: StageGrantAssert, Reason: "grant_mismatch", Err: fmt.Errorf("nono run -v --dry-run refused the policy before exec: %v (%s)", err, firstLine(dry))}
	}
	parsed, err := parseGrants(dry)
	if err != nil {
		return res, &Failure{Stage: StageGrantAssert, Reason: "grant_mismatch", Err: err}
	}
	if err := assertGrants(spec.Plan, parsed); err != nil {
		return res, &Failure{Stage: StageGrantAssert, Reason: "grant_mismatch", Err: err}
	}
	for _, g := range parsed {
		if g.source == sourceUser {
			res.GrantedPaths = append(res.GrantedPaths, g.path)
		}
	}
	res.ObservedGroups = grantSources(parsed)
	res.Verified = true
	return res, nil
}

// launcherEnv is nono's own environment — deliberately not the adapter's.
//
// The HOME here is the one C-H1 is about: nono's state root is derived from it
// (HOME/.local/state/nono), and a grant overlapping that root is refused —
// permanently for that directory. So nono gets a worker-owned launcher home,
// the agent gets HOME=<workspace>/home through the env hop, and the two never
// name the same tree.
func (l *Launcher) launcherEnv(spec LaunchSpec) []string {
	home := spec.LauncherHome
	if home == "" {
		home = l.Home
	}
	if home == "" {
		return nil // inherit: only reachable on the doctor path, which has no workspace
	}
	return []string{
		"PATH=" + envOrDefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
	}
}

// grantEntry is one printed rule from the verbose dry-run.
type grantEntry struct {
	level  string // "r+w", "r", "w", "sock", "net", "scope"
	path   string
	source string // "user", "profile", or "group:<name>"
}

const (
	sourceUser    = "user"
	sourceProfile = "profile"
)

// grantLine matches the rule lines `nono run -v --dry-run` prints, e.g.
//
//	 r+w  /workspace/work/repos (dir) [user]
//	  r   /usr/bin (dir) [group:system_read_linux_core]
//	sock  /run/systemd/userdb [profile]  (directory grant — direct child sockets only)
var grantLine = regexp.MustCompile(`^\s*(r\+w|=r\+w|rw|r\+?w|=w|r|sock|net|scope)\s+(\S+)(?:\s+\((?:dir|file)\))?\s+\[([^\]]+)\]`)

func parseGrants(out string) ([]grantEntry, error) {
	var grants []grantEntry
	for _, line := range strings.Split(out, "\n") {
		m := grantLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		grants = append(grants, grantEntry{level: normalizeLevel(m[1]), path: m[2], source: m[3]})
	}
	// C-ND's fail-closed rule: zero parsed grants must be an abort, never an
	// empty-set match. C-SILENT is the shape this catches — a silent argv
	// prints nothing, and an assertion that only checks "every printed grant is
	// in my set" passes vacuously against no output at all.
	userCount := 0
	for _, g := range grants {
		if g.source == sourceUser {
			userCount++
		}
	}
	if userCount == 0 {
		return nil, fmt.Errorf("the verbose dry-run printed %d grant rules and 0 of them [user]: refusing to treat an empty grant list as a match (probe C-SILENT measured the silent argv printing 0 lines, which makes a set-inclusion assertion vacuously green)", len(grants))
	}
	return grants, nil
}

// grantSources lists the distinct non-user rule sources that contributed, which
// the ops page shows next to the grant list: "which groups did nono layer in".
func grantSources(got []grantEntry) []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range got {
		if g.source == sourceUser || seen[g.source] {
			continue
		}
		seen[g.source] = true
		out = append(out, g.source)
	}
	return out
}

func normalizeLevel(in string) string {
	switch strings.TrimPrefix(in, "=") {
	case "r+w", "rw":
		return "r+w"
	case "w":
		return "w"
	case "r":
		return "r"
	default:
		return in
	}
}

// allowedGroups is the N-d source allowlist. The deny_* and
// dangerous_commands groups are read-path rules from the layered default
// profile; system_read_linux_core is the one that makes any binary run. A new
// group appearing in the resolved list is a signal to look at it, not something
// to pass through.
var allowedGroups = map[string]bool{
	"group:system_read_linux_core":   true,
	"group:deny_credentials":         true,
	"group:deny_shell_history":       true,
	"group:deny_shell_configs":       true,
	"group:deny_keychains_linux":     true,
	"group:deny_macos_private":       true,
	"group:dangerous_commands":       true,
	"group:dangerous_commands_linux": true,
	// The profile's own layer: it carries the mediation settings and the
	// device re-grants, and nothing else, because per-run paths are flags.
	sourceProfile: true,
}

// deviceGrants are the paths the profile file itself is allowed to contribute.
var deviceGrants = map[string]bool{}

func init() {
	for _, p := range append(append([]string(nil), deviceWrites...), profileAllows...) {
		deviceGrants[p] = true
	}
	// /proc/self/fd resolves to the child's own numbered directory.
	deviceGrants["/proc/self/fd"] = true
}

// nonoInjectedGrants are rules tagged `[profile]` that nono adds itself, which
// our profile never names. Observed on nono 0.80.0 in the verbose dry-run:
// enabling af_unix_mediation contributes a read and a `sock` rule for
// /run/systemd/userdb (the user/group database socket) even though no
// Communication profile mentions the path.
//
// They are allowed because of what they are, not because they appeared: both
// name a system socket directory and neither can name a workspace path, so
// nothing an agent could read or write is added by them. The list is exact
// rather than prefix-matched so a *new* injected rule still stops the launch —
// the whole purpose of asserting the resolved grant set is to notice when the
// sandbox is not the one that was recorded.
var nonoInjectedGrants = map[string]bool{
	"/run/systemd/userdb": true,
}

// assertGrants is N-d's actual content: the resolved set must be the intended
// set, path-for-path and level-for-level.
func assertGrants(plan wsgit.LaunchPlan, got []grantEntry) error {
	want := map[string]string{} // path -> level
	for _, g := range plan.Grants {
		level := "r+w"
		if g.Access() == wsgit.AccessReadOnly {
			level = "r"
		}
		want[filepath.Clean(g.Path)] = level
	}
	seen := map[string]string{}
	var unknown []string
	for _, g := range got {
		if g.source != sourceUser {
			if !allowedGroups[g.source] && !strings.HasPrefix(g.source, "group:deny_") {
				return fmt.Errorf("the resolved grant list contains a rule from source %q (%s %s), which is not on the allowlist of policy sources this adapter understands: %w", g.source, g.level, g.path, sandbox.ErrGrantSource)
			}
			if g.source == sourceProfile && !isDeviceGrant(g.path) && !nonoInjectedGrants[filepath.Clean(g.path)] {
				return fmt.Errorf("the profile layer contributes a grant it should not (%s %s): per-run paths are CLI flags, so a [profile] rule outside the device re-grants and the observed nono-injected sockets means the policy file and the launcher have diverged", g.level, g.path)
			}
			continue
		}
		clean := filepath.Clean(g.path)
		level, ok := want[clean]
		if !ok {
			unknown = append(unknown, g.level+" "+clean)
			continue
		}
		if level != g.level {
			return fmt.Errorf("grant %s resolved as %s but the plan asked for %s: the sandbox the child gets is not the sandbox that was recorded", clean, g.level, level)
		}
		seen[clean] = g.level
	}
	if len(unknown) > 0 {
		return fmt.Errorf("the resolved grant list contains %d rule(s) the plan never asked for (%s): refusing to launch a sandbox wider than the policy that will be recorded for it", len(unknown), strings.Join(unknown, ", "))
	}
	var missing []string
	for path, level := range want {
		if seen[path] != level {
			missing = append(missing, level+" "+path)
		}
	}
	if len(missing) > 0 {
		// FC3: nono silently ignores a grant path that does not resolve. A
		// missing rule is that bug, or a dropped --allow, and either way the
		// child would come up narrower (or wider) than recorded.
		return fmt.Errorf("the resolved grant list is missing %d rule(s) the plan asked for (%s) — probe FC3's silent drop, or a flag that never reached nono", len(missing), strings.Join(missing, ", "))
	}
	// No temp-tree grant, whatever its source: the layered default profile
	// hands /tmp to every sandbox (C-TMP1/C-TMP3), which is why the shipped
	// profile excludes system_write_linux and why a grant naming a temp prefix
	// is an abort rather than a note.
	for _, g := range got {
		if g.level != "r+w" && g.level != "w" {
			continue
		}
		if isTempPath(g.path) {
			return fmt.Errorf("a writable grant to %s appears in the resolved list (source %s): /tmp, /var/tmp and /dev/shm are not workspace material and nono's default layer grants them by itself (probes P9/N1/C-TMP1)", g.path, g.source)
		}
	}
	return nil
}

func isDeviceGrant(p string) bool {
	clean := filepath.Clean(p)
	if deviceGrants[clean] {
		return true
	}
	// /proc/<pid>/fd is what /proc/self/fd resolves to in the printed list.
	if base := filepath.Base(clean); base == "fd" {
		parent := filepath.Base(filepath.Dir(clean))
		if strings.Count(clean, "/") == 3 && strings.HasPrefix(clean, "/proc/") && allDigits(parent) {
			return true
		}
	}
	return false
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// envOrDefault reads the worker's own environment for a value the launcher
// must not invent. Only PATH-shaped infrastructure is read this way; the
// adapter's environment is built by the worker and never inherited.
func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func isTempPath(p string) bool {
	clean := filepath.Clean(p)
	for _, prefix := range []string{"/tmp", "/var/tmp", "/dev/shm"} {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return true
		}
	}
	return false
}

// afUnixMediation extracts the N-c value. The string appears only in
// `nono profile show` output (probe C-AFU2: the verbose dry-run printed no
// AF_UNIX line at all), which is why N-c and N-d are different commands.
func afUnixMediation(out string) (string, bool) {
	re := regexp.MustCompile(`(?i)AF_UNIX mediation:\s*(\S+)`)
	if m := re.FindStringSubmatch(out); m != nil {
		return strings.ToLower(m[1]), true
	}
	return "", false
}

func (r *VerificationResult) String() string {
	if r == nil {
		return "sandbox:verification<none>"
	}
	return fmt.Sprintf("sandbox: verified=%v backend=%s/%s policy=%s@%s af_unix=%s network_enforced=%v grants=%d",
		r.Verified, r.Backend, r.Version, r.PolicyRef, shortDigest(r.PolicyDigest), r.AfUnixMediation, r.NetworkEnforced, len(r.GrantedPaths))
}

func shortDigest(d string) string {
	if len(d) <= 12 {
		return d
	}
	return d[:12]
}

func onelineList(s string) []string {
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		if f := strings.Join(strings.Fields(line), " "); f != "" {
			out = append(out, f)
		}
	}
	if len(out) > 12 {
		out = append(out[:12], fmt.Sprintf("… (%d more lines)", len(out)-12))
	}
	return out
}

// probeFailureReason maps a Probe error onto ADR-0019 D6's reason enum, so the
// event never carries a Go sentence where a controlled value belongs.
func probeFailureReason(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "not found in path"), strings.Contains(msg, "no such file"):
		return "binary_missing"
	case strings.Contains(msg, "tcp"):
		return "tcp_unverified"
	case strings.Contains(msg, "not enforceable"), strings.Contains(msg, "filesystem"):
		return "fs_unverified"
	default:
		return "landlock_unavailable"
	}
}

// policyRef is the recorded identity of a policy: kind + content digest, the
// form SandboxPolicyRef takes in a unit's journal (ADR-0019 D5).
func policyRef(p *Profile) string {
	if p == nil {
		return ""
	}
	return p.Kind + "@" + p.Digest
}
