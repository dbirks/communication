package apm

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The resolve fixture: a realistic apm.lock.yaml per the field list the apm
// research report recorded (lockfile_version, apm_version, dependencies[] with
// resolved_commit/resolved_ref/version/depth/package_type/content_hash/
// skill_subset/target_subset/deployed_files/deployed_file_hashes/source,
// mcp_servers, mcp_configs, mcp_target_servers, lsp_servers).
const resolveLockBody = `lockfile_version: '1'
apm_version: 0.33.0
dependencies:
  - repo_url: mattpocock/skills
    resolved_commit: 24fe0ef7737efae15c87225755e9f6f5965e4888
    resolved_ref: v1.3.1
    version: 1.3.1
    depth: 1
    package_type: git
    content_hash: sha256:127ccf2b1a3f0f9d2b7c
    skill_subset:
      - grill-me
    target_subset:
      - claude
    deployed_files:
      - .claude/skills/grill-me/SKILL.md
      - apm_modules/mattpocock/skills/.apm/instructions/grill-me.instructions.md
    deployed_file_hashes:
      .claude/skills/grill-me/SKILL.md: sha256:aa11bb22cc33dd44ee55ff66778899
    source: github
  - repo_url: mattpocock/skills
    resolved_commit: 984a2c02d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b
    resolved_ref: v1.3.0
    version: 1.3.0
    depth: 1
    package_type: git
    content_hash: sha256:127ccf2b2a3f0f9d2b7c
    skill_subset:
      - grill-me
    target_subset:
      - claude
    deployed_files:
      - .claude/skills/grill-me/SKILL.md
    source: github
mcp_servers:
  - github
  - playwright
mcp_configs: []
mcp_target_servers:
  - claude
lsp_servers: []
deployments: []
`

// writeResolveFakeAPM writes the fake apm the resolve tests run against: it
// appends its argv to a log, writes the fixture lock, and lays out a deployed
// tree with one skill and one instruction file.
func writeResolveFakeAPM(t *testing.T, lockBody string) (bin, logPath string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "apm")
	logPath = filepath.Join(dir, "argv.log")
	script := fmt.Sprintf(`#!/bin/sh
echo "$@" >> '%s'
cat > apm.lock.yaml <<'LOCK'
%sLOCK
mkdir -p apm_modules/mattpocock/skills/.apm/instructions .claude/skills/grill-me
printf '# grill-me\n' > .claude/skills/grill-me/SKILL.md
printf '# instructions\n' > apm_modules/mattpocock/skills/.apm/instructions/grill-me.instructions.md
echo '[+] fake-apm 0.33.0 mattpocock/skills #v1.3.1 @24fe0ef7'
`, logPath, lockBody)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}
	return bin, logPath
}

func writeResolveFakeAPMScript(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "apm")
	script := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake apm: %v", err)
	}
	return bin
}

func writeResolveFakeAPMExit(t *testing.T, code int, stderr string) string {
	return writeResolveFakeAPMScript(t, fmt.Sprintf("printf '%s' %q >&2\nexit %s", stderr, stderr, strconv.Itoa(code)))
}

// resolveRequest builds a resolve against a caller-owned scratch dir.
func resolveRequest(workdir, home, bin, ref string, timeout time.Duration) ResolveRequest {
	return ResolveRequest{
		PackageRef: ref,
		Target:     TargetClaude,
		WorkDir:    workdir,
		Home:       home,
		APMPath:    bin,
		Timeout:    timeout,
	}
}

// A resolve locks a package ref: it materializes the manifest, runs the
// resolving install, reads the lock, and reports digest + contents.
func TestResolveReturnsLockDigestAndContents(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, logPath := writeResolveFakeAPM(t, resolveLockBody)

	res, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 0))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.LockDigest != digestOf(resolveLockBody) {
		t.Errorf("LockDigest = %s, want the digest of the fixture lock %s", res.LockDigest, digestOf(resolveLockBody))
	}
	if res.ResolvedRef != "v1.3.1" {
		t.Errorf("ResolvedRef = %q, want v1.3.1", res.ResolvedRef)
	}
	if res.Commit != "24fe0ef7737efae15c87225755e9f6f5965e4888" {
		t.Errorf("Commit = %q, want 24fe0ef7737efae15c87225755e9f6f5965e4888", res.Commit)
	}
	if res.APMVersion != "0.33.0" {
		t.Errorf("APMVersion = %q, want 0.33.0", res.APMVersion)
	}
	if len(res.Contents.Skills) != 1 || res.Contents.Skills[0] != "grill-me" {
		t.Errorf("Contents.Skills = %v, want [grill-me]", res.Contents.Skills)
	}
	if len(res.Contents.Instructions) != 1 || res.Contents.Instructions[0] != "grill-me.instructions.md" {
		t.Errorf("Contents.Instructions = %v, want [grill-me.instructions.md]", res.Contents.Instructions)
	}
	if len(res.Contents.MCPServers) != 2 || !contains(res.Contents.MCPServers, "github") || !contains(res.Contents.MCPServers, "playwright") {
		t.Errorf("Contents.MCPServers = %v, want [github playwright]", res.Contents.MCPServers)
	}
	if res.Contents.Truncated {
		t.Errorf("Contents.Truncated = true, want false")
	}

	argv := readFile(t, logPath)
	if !strings.Contains(argv, "install --target claude") {
		t.Errorf("argv = %q, want the resolving install", argv)
	}
	if strings.Contains(argv, "--frozen") {
		t.Errorf("a resolve must resolve, not verify: %s", argv)
	}
}

// The digest Resolve reports is the same function Stage's launch gate runs,
// over the same bytes.
func TestResolveLockDigestEqualsStageGate(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, _ := writeResolveFakeAPM(t, resolveLockBody)

	res, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 0))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	onDisk, err := LockDigest(filepath.Join(workdir, LockFileName))
	if err != nil {
		t.Fatalf("LockDigest on the resolve scratch dir: %v", err)
	}
	if res.LockDigest != onDisk || res.LockDigest != digestOf(resolveLockBody) {
		t.Errorf("Resolve.LockDigest = %s, want %s (Stage's gate digest)", res.LockDigest, onDisk)
	}
}

// A ref that cannot be pinned is refused before apm runs.
func TestResolveRefusesUnpinnableRef(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, logPath := writeResolveFakeAPM(t, resolveLockBody)

	_, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills", 0))
	if err == nil {
		t.Fatal("a ref with no #<revision> must refuse the resolve")
	}
	if !errors.Is(err, ErrResolveInvalidRef) {
		t.Fatalf("err = %v, want ErrResolveInvalidRef", err)
	}
	if !strings.Contains(err.Error(), "not pinned") {
		t.Errorf("err = %v, want it to name the pin grammar problem", err)
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("apm must not run for a ref that fails validation: %s", readFile(t, logPath))
	}
}

// A resolving install that hangs past the deadline times out with the named
// resolve error.
func TestResolveTimesOut(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin := writeResolveFakeAPMScript(t, "exec sleep 30")

	start := time.Now()
	_, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 50*time.Millisecond))
	if !errors.Is(err, ErrResolveTimeout) {
		t.Fatalf("err = %v, want ErrResolveTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("the resolve did not time out promptly: %s", elapsed)
	}
}

// A resolving install that the pinned CLI refuses fails with the named error
// carrying the bounded stderr tail.
func TestResolveInstallFailure(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin := writeResolveFakeAPMExit(t, 3, "apm: registry unreachable: github.com is not allowlisted")

	_, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 0))
	if err == nil {
		t.Fatal("a failing install must fail the resolve")
	}
	if !errors.Is(err, ErrResolveFailed) {
		t.Fatalf("err = %v, want ErrResolveFailed", err)
	}
	if !strings.Contains(err.Error(), "registry unreachable") {
		t.Errorf("err = %v, want it to carry the stderr tail", err)
	}
}

// A resolve refuses a work dir that already holds content: a second resolve
// into the same dir would keep the previous resolve's apm.lock.yaml and answer
// with the stale lock for a different ref.
func TestResolveRefusesNonEmptyWorkDir(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "stale.txt"), []byte("stale"), 0o644); err != nil {
		t.Fatalf("seed work dir: %v", err)
	}
	home := t.TempDir()
	bin, logPath := writeResolveFakeAPM(t, resolveLockBody)

	_, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 0))
	if err == nil {
		t.Fatal("a resolve into a work dir that is not empty must refuse")
	}
	if !errors.Is(err, ErrResolveWorkDirNotEmpty) {
		t.Fatalf("err = %v, want ErrResolveWorkDirNotEmpty", err)
	}
	if _, statErr := os.Stat(logPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("apm must not run for a non-empty work dir: %s", readFile(t, logPath))
	}
}

// A resolve whose install wrote a lock that did not pin the requested ref
// fails with the named resolve error.
func TestResolveLockMustPinRequestedRef(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, _ := writeResolveFakeAPM(t, resolveLockBody)

	_, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v9.9.9", 0))
	if err == nil {
		t.Fatal("a resolve whose lock resolved another ref must fail")
	}
	if !errors.Is(err, ErrResolveFailed) {
		t.Fatalf("err = %v, want ErrResolveFailed", err)
	}
	if !strings.Contains(err.Error(), "lock does not pin the requested ref") {
		t.Errorf("err = %v, want it to name the ref mismatch", err)
	}
}

// Lock parsing reads a realistic apm.lock.yaml document from its bytes.
func TestParseLock(t *testing.T) {
	lock, err := parseLock([]byte(resolveLockBody))
	if err != nil {
		t.Fatalf("parseLock: %v", err)
	}
	if lock.APMVersion != "0.33.0" {
		t.Errorf("APMVersion = %q, want 0.33.0", lock.APMVersion)
	}
	if len(lock.Dependencies) != 2 {
		t.Fatalf("len(Dependencies) = %d, want 2", len(lock.Dependencies))
	}
	first := lock.Dependencies[0]
	if first.RepoURL != "mattpocock/skills" || first.ResolvedRef != "v1.3.1" || first.ResolvedCommit != "24fe0ef7737efae15c87225755e9f6f5965e4888" {
		t.Errorf("first dependency = %+v", first)
	}
	if first.Version != "1.3.1" || first.Depth != 1 || first.PackageType != "git" {
		t.Errorf("first dependency scalars = %+v", first)
	}
	if first.ContentHash != "sha256:127ccf2b1a3f0f9d2b7c" {
		t.Errorf("first dependency content_hash = %q", first.ContentHash)
	}
	if len(first.SkillSubset) != 1 || first.SkillSubset[0] != "grill-me" {
		t.Errorf("first dependency skill_subset = %v", first.SkillSubset)
	}
	if len(first.TargetSubset) != 1 || first.TargetSubset[0] != "claude" {
		t.Errorf("first dependency target_subset = %v", first.TargetSubset)
	}
	if len(first.DeployedFiles) != 2 {
		t.Errorf("first dependency deployed_files = %v", first.DeployedFiles)
	}
	if first.DeployedFileHashes[".claude/skills/grill-me/SKILL.md"] == "" {
		t.Errorf("first dependency deployed_file_hashes = %v", first.DeployedFileHashes)
	}
	if len(lock.MCPServers) != 2 || !contains(lock.MCPServers, "github") {
		t.Errorf("MCPServers = %v", lock.MCPServers)
	}
}

// The real resolve against a pinned public package (lab-gated per the apm
// research report): the lock digest for mattpocock/skills#v1.3.1 must equal the
// digest the launch gate already pins, and #v1.3.0 must resolve to a different
// one (APM.md T-tag-3 / T-tag-4).
func TestResolveRealLockDigest(t *testing.T) {
	if os.Getenv("COMMUNICATION_APM_REAL") != "1" {
		t.Skip("COMMUNICATION_APM_REAL not set: the real apm resolve is lab-gated")
	}
	bin, err := exec.LookPath("apm")
	if err != nil {
		t.Skipf("apm on PATH required for the real resolve: %v", err)
	}
	workDir1 := t.TempDir()
	home := t.TempDir()

	res, err := Resolve(t.Context(), ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     TargetClaude,
		WorkDir:    workDir1,
		Home:       home,
		APMPath:    bin,
		Timeout:    5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("Resolve(mattpocock/skills#v1.3.1): %v", err)
	}
	want := "sha256:f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33"
	if res.LockDigest != want {
		t.Errorf("Resolve(mattpocock/skills#v1.3.1).LockDigest = %s, want %s", res.LockDigest, want)
	}

	workDir2 := t.TempDir()
	res2, err := Resolve(t.Context(), ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.0",
		Target:     TargetClaude,
		WorkDir:    workDir2,
		Home:       home,
		APMPath:    bin,
		Timeout:    5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("Resolve(mattpocock/skills#v1.3.0): %v", err)
	}
	if res2.LockDigest == res.LockDigest {
		t.Errorf("Resolve(mattpocock/skills#v1.3.0).LockDigest = %s, want a different digest", res2.LockDigest)
	}
}

// A resolve that runs through the caller's launcher wrapper execs the wrapper's
// answer (the worker answers with a nono-sandboxed launch) and reports the run
// as sandboxed.
func TestResolveRunsThroughTheLauncherWrapper(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, logPath := writeResolveFakeAPM(t, resolveLockBody)

	var gotArgv, gotEnv []string
	wrap := func(argv []string, env []string) (string, []string, []string, error) {
		gotArgv, gotEnv = argv, env
		return bin, argv, env, nil
	}
	res, err := Resolve(t.Context(), ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     TargetClaude,
		WorkDir:    workdir,
		Home:       home,
		APMPath:    bin,
		Timeout:    0,
		Wrap:       wrap,
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !res.Sandboxed {
		t.Error("a resolve that ran through the wrapper must report Sandboxed=true")
	}
	if strings.Join(gotArgv, " ") != "install --target claude" {
		t.Errorf("wrapper argv = %v, want the resolving install", gotArgv)
	}
	if gotEnv[0] != "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" && !strings.HasPrefix(gotEnv[0], "PATH=") {
		t.Errorf("wrapper env = %v, want the from-scratch apm child env", gotEnv)
	}
	if !strings.Contains(readFile(t, logPath), "install --target claude") {
		t.Errorf("the wrapper answer was not exec'd: %s", readFile(t, logPath))
	}
}

// A wrapper that refuses fails the resolve; the answer it would have given is
// never exec'd.
func TestResolveWrapperRefusalFailsTheResolve(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, _ := writeResolveFakeAPM(t, resolveLockBody)
	wrapErr := errFakeWrap
	res, err := Resolve(t.Context(), ResolveRequest{
		PackageRef: "mattpocock/skills#v1.3.1",
		Target:     TargetClaude,
		WorkDir:    workdir,
		Home:       home,
		APMPath:    bin,
		Timeout:    0,
		Wrap:       func(argv []string, env []string) (string, []string, []string, error) { return "", nil, nil, wrapErr },
	})
	if err == nil {
		t.Fatal("a refusing wrapper must fail the resolve")
	}
	if res != nil {
		t.Errorf("a failed resolve must not report a result: %+v", res)
	}
}

// Without a wrapper the resolve runs the binary directly and reports the run as
// not sandboxed (the tests' and unsandboxed modes' honest answer).
func TestResolveWithoutWrapperReportsNotSandboxed(t *testing.T) {
	workdir := t.TempDir()
	home := t.TempDir()
	bin, _ := writeResolveFakeAPM(t, resolveLockBody)
	res, err := Resolve(t.Context(), resolveRequest(workdir, home, bin, "mattpocock/skills#v1.3.1", 0))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Sandboxed {
		t.Error("a resolve without a wrapper must report Sandboxed=false")
	}
}

// errFakeWrap is the error a test wrapper refuses with.
var errFakeWrap = errors.New("apm: resolve wrapper refused the install")
