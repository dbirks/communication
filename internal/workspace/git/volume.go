package git

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// Volume is the measured identity of one storage root. ADR-0017 D2 (as
// corrected by probes V3 and V5b) makes this the only answer the worker may
// give to "is this the same disk I wrote that workspace on?":
//
//   - st_dev alone is not an identity. Two *different* docker named volumes
//     mounted at the same path report the same st_dev (V3), so an st_dev-derived
//     id would call a replaced volume the same one and silently reclaim
//     directories that no longer exist.
//   - st_ino is required alongside it: two roots on one device
//     (/workspaces and /repos) measured (dev 30, ino 19522917) and
//     (dev 30, ino 19523019) in the shipped run (V5b), so one identity per
//     *root* — never one per worker — is what the schema records.
//   - the path is in the digest so a root moved to a different mount point is
//     a different volume even when the device and inode coincide.
//
// The stable prefix ("communication-volume-v1") pins the derivation: an id
// computed under a future rule can never be mistaken for one of these.
type Volume struct {
	// RootKind is "workspaces" or "repos" — the two trees M3 measures.
	RootKind string
	// Path is the cleaned absolute root path the identity was measured at.
	Path string
	// StDev and StIno are the raw stat results, kept for the worker_volumes
	// row so the observation can be re-read without re-measuring.
	StDev uint64
	StIno uint64
	// FSType is the filesystem magic name (ext4, overlay, bind…) or "".
	// Empty means "could not be determined" and is stored as NULL: an unknown
	// fstype is information, a guessed one is a lie.
	FSType string
	// ID is the sha256 digest, formatted "sha256:<hex>".
	ID string
}

// volumePrefix is the domain-separation constant of the digest. Changing it is
// changing the meaning of every stored volume_id, i.e. a schema decision.
const volumePrefix = "communication-volume-v1"

// VolumeID derives the digest from the measured triple. Exported so a test can
// pin the derivation, and so the reconciliation code can verify a stored id
// against its own (st_dev, st_ino, path) without re-stat-ing anything.
func VolumeID(stDev, stIno uint64, rootPath string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s",
		volumePrefix, stDev, stIno, filepath.Clean(rootPath))))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// MeasureVolume stats one storage root and returns its identity. The root must
// exist: a missing root is a configuration or mount failure, and reporting it
// as "volume unknown" (the zero Volume) would let a workspace be created
// against nothing.
func MeasureVolume(rootKind, rootPath string) (Volume, error) {
	if rootKind != RootKindWorkspaces && rootKind != RootKindRepos {
		return Volume{}, fmt.Errorf("workspace: unknown storage root kind %q", rootKind)
	}
	if err := checkAbsoluteNoDotDot(rootPath); err != nil {
		return Volume{}, fmt.Errorf("workspace: %s root: %w", rootKind, err)
	}
	st, err := os.Stat(rootPath)
	if err != nil {
		return Volume{}, fmt.Errorf("workspace: %s root %s: %w", rootKind, rootPath, err)
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return Volume{}, fmt.Errorf("workspace: %s root %s: stat returned no unix metadata", rootKind, rootPath)
	}
	if sys.Dev == 0 || sys.Ino == 0 {
		return Volume{}, fmt.Errorf("workspace: %s root %s: measured dev=%d ino=%d", rootKind, rootPath, sys.Dev, sys.Ino)
	}
	clean := filepath.Clean(rootPath)
	return Volume{
		RootKind: rootKind,
		Path:     clean,
		StDev:    uint64(sys.Dev),
		StIno:    uint64(sys.Ino),
		FSType:   fsType(clean),
		ID:       VolumeID(uint64(sys.Dev), uint64(sys.Ino), clean),
	}, nil
}

// Storage-root kinds, matching workspaces.root_kind and worker_volumes.root_kind.
const (
	RootKindWorkspaces = "workspaces"
	RootKindRepos      = "repos"
)

// fsType resolves the filesystem a path lives on from /proc/self/mountinfo,
// choosing the longest (most specific) mount point that prefixes it. Returns
// "" when nothing can be read (no procfs, an unreadable file, a path under no
// listed mount) — callers store that as NULL rather than a guess.
func fsType(path string) string {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	bestPoint, bestType := "", ""
	for _, line := range strings.Split(string(data), "\n") {
		// 40 36 0:37 / /home rw,relatime - ext4 /dev/mapper/... rw
		// fields: 1 id 2 parent 3 major:minor 4 root 5 mount-point 6 opts… - fstype src superopts
		rest, _, found := cut(line, " - ")
		if !found {
			continue
		}
		fstype, _, _ := cut(rest, " ")
		fields := strings.Fields(line)
		if len(fields) < 6 || fstype == "" {
			continue
		}
		point := unescapeMount(fields[4])
		if point != "/" && !strings.HasPrefix(path, point) {
			continue
		}
		if len(point) > len(bestPoint) {
			bestPoint, bestType = point, fstype
		}
	}
	return bestType
}

// unescapeMount decodes the octal escapes mountinfo uses in path fields
// (\040 == space, \011 == tab, \012 == newline, \134 == backslash).
func unescapeMount(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			var n int
			if _, err := fmt.Sscanf(s[i+1:i+4], "%3d", &n); err == nil && n > 0 && n < 128 {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func cut(s, sep string) (before, after string, found bool) {
	if i := strings.Index(s, sep); i >= 0 {
		return s[:i], s[i+len(sep):], true
	}
	return s, "", false
}

// TempPathPrefixes are the directories nono's always-layered `default` profile
// grants write access to (probes C-TMP1/C-TMP3, ADR-0017 D5). Placing a
// workspace, mirror, HOME or materialized secret under one of them means
// "denied by omission" is false there, so the rule is absolute: those paths
// are never ours.
var TempPathPrefixes = []string{"/tmp", "/var/tmp", "/dev/shm"}

// RefuseTempPath reports whether a workspace- or grant-bound path lives under
// a world-writable temp directory. It is a *configuration* error, not a
// warning: the caller must not launch, and must say why.
func RefuseTempPath(path string) error {
	clean := filepath.Clean(path)
	for _, prefix := range TempPathPrefixes {
		if clean == prefix || strings.HasPrefix(clean, prefix+string(filepath.Separator)) {
			return fmt.Errorf("workspace: path %s is under %s, which the sandbox backend grants write access to by default (probe C-TMP1): workspaces, mirrors, homes and materialized secrets must live outside the temp tree", path, prefix)
		}
	}
	return nil
}

var (
	// uuidText is the canonical uuid form — the only shape allowed to name a
	// scope directory, so nothing read from the database can traverse.
	uuidText = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	// safeName bounds directory components taken from repository names.
	safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// CheckScopeID validates a conversation or run id used as a path component.
func CheckScopeID(id string) error {
	if !uuidText.MatchString(id) {
		return fmt.Errorf("workspace: scope id %q is not a canonical uuid", id)
	}
	return nil
}

// CheckName validates a repository name used as a directory component.
func CheckName(name string) error {
	if !safeName.MatchString(name) {
		return fmt.Errorf("workspace: repository name %q is not a safe directory name", name)
	}
	return nil
}

// checkAbsoluteNoDotDot is the same rule the workspace_repos and workspaces
// CHECK constraints enforce (contract § 1): a grant path that is relative or
// that walks upward is not an ACL proof.
// checkRefName rejects anything a git ref cannot be: a branch name arrives
// from a repositories.default_branch column, which is team-editable text, so
// it is validated before it is ever interpolated into a refspec.
func checkRefName(name string) error {
	if name == "" {
		return fmt.Errorf("workspace: empty git ref name")
	}
	if strings.HasPrefix(name, "-") || strings.ContainsAny(name, " ~^:?*[\\") || strings.Contains(name, "..") {
		return fmt.Errorf("workspace: %q is not a usable git ref name", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".lock") {
			return fmt.Errorf("workspace: %q is not a usable git ref name", name)
		}
	}
	if strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".") || name == "@" {
		return fmt.Errorf("workspace: %q is not a usable git ref name", name)
	}
	return nil
}

func checkAbsoluteNoDotDot(p string) error {
	if p == "" {
		return fmt.Errorf("path is empty")
	}
	if !filepath.IsAbs(p) {
		return fmt.Errorf("path %q is not absolute", p)
	}
	for _, part := range strings.Split(p, string(filepath.Separator)) {
		if part == ".." {
			return fmt.Errorf("path %q contains ..", p)
		}
	}
	if strings.Contains(p, "//") {
		return fmt.Errorf("path %q contains an empty component", p)
	}
	if filepath.Clean(p) != p {
		return fmt.Errorf("path %q is not cleaned (got %q)", p, filepath.Clean(p))
	}
	return nil
}

// CheckGrantPath validates a path that is about to become a sandbox grant:
// absolute, `..`-free, cleaned, outside the temp tree, and existing. The last
// one is load-bearing — probe C-FC3 showed nono silently *ignores* a grant
// path that does not exist, so a typo would produce a launch with a hole in
// it rather than an error.
func CheckGrantPath(p string) error {
	if err := checkAbsoluteNoDotDot(p); err != nil {
		return err
	}
	if err := RefuseTempPath(p); err != nil {
		return err
	}
	if _, err := os.Lstat(p); err != nil {
		return fmt.Errorf("workspace: grant path %s does not exist (nono silently ignores an unresolvable grant, probe C-FC3): %w", p, err)
	}
	return nil
}
