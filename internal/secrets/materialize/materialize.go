// Package materialize writes authorized secrets into a workspace checkout, as
// files with mode 0600 or as environment entries, and nothing else.
//
// Authority: ADR-0018 D4 (the ordered procedure this file implements), spec 05
// ("env_file delivery is a workspace materialization, not an env-source"), and
// the observed git behaviour recorded in docs/compatibility/M3-PROBES.md § G.
// The probe's throwaway materializer is the reference implementation for the
// validation battery and the C-ENV6 reason strings.
//
// The order of the checks is the contract, so it is restated here once:
//
//  1. relative_path is relative and contains no "..";
//  2. the authorized root is <workspace>/repos/<repository>, the parent chain is
//     checked for symlinks, and realpath of the parent must still be under that
//     root;
//  3. the target path must not already exist as a symlink;
//  4. git ls-files refuses a tracked target (C-ENV6.3-4) unless the mount row
//     carries the explicit allow_tracked exception;
//  5. the project-scoped exclusion is ensured BEFORE the write: the mirror
//     resolves to the same <git common dir> for every worktree of a project, so
//     <mirror>/info/exclude is the one place that covers the checkout and every
//     later checkout, without touching the agent-owned shared .git/config
//     (PROBES G3/G4/G5). It is a hard precondition, not a post-write tidy-up;
//  6. create with O_CREAT|O_EXCL, mode 0600; EEXIST on a live path is a refusal
//     that leaves the original bytes untouched;
//  7. delete the file on turn end, and leave the exclusion in place: it is
//     project-scoped and one entry covering a basename excludes that name in
//     every other worktree of the project too.
//
// What this package must never do is be the thing that decides whether a
// principal may have a value: that is authz + secrets.Resolver. It receives a
// value that has already been authorized and a path that has already been
// pinned, and its job is to make the write safe against the filesystem being
// hostile — a symlink pointing at ~/.ssh, a tracked file whose content would be
// lost, a parent that is not what it appears to be, an agent that can read
// .git/config.
package materialize

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Errors and refusal reasons. The reason values are exactly the
// secret.materialization_failed.payload.reason enum in internal/events, so a
// failure the materializer reports is a failure the event envelope can carry
// without inventing a reason (m3-contract § 4.2).
var (
	// ErrRefused is every validation refusal: never a panic, and never a
	// partially written file.
	ErrRefused = errors.New("materialize: refused")

	ReasonPathEscape      = "path_escape"
	ReasonAbsolutePath    = "absolute_path"
	ReasonBadShape        = "bad_shape"
	ReasonTrackedTarget   = "tracked_target"
	ReasonExists          = "exists"
	ReasonSymlinkParent   = "symlink_parent"
	ReasonMirrorWritable  = "mirror_writable"
	ReasonKeyringUnreadab = "keyring_unreadable"
	ReasonRevokedVersion  = "revoked_version"
	ReasonBrokerUnsupport = "broker_unsupported"
)

// Refusal is a validation failure with the enum reason attached, so the worker
// can emit secret.materialization_failed with the reason verbatim.
type Refusal struct {
	Reason string
	Path   string // the relative path as asked for, never a value
	Err    error
}

func (r *Refusal) Error() string {
	return fmt.Sprintf("materialize: refuse %s (%s): %v", r.Path, r.Reason, r.Err)
}

func (r *Refusal) Unwrap() error { return r.Err }

func refuse(reason, path string, err error) error {
	return &Refusal{Reason: reason, Path: path, Err: fmt.Errorf("%w: %v", ErrRefused, err)}
}

// RefusalReason extracts the contract enum value from any error, returning ""
// when the failure was not a validation refusal (an I/O or git error), which
// the caller should report as its own kind of failure.
func RefusalReason(err error) string {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Reason
	}
	return ""
}

// Mode is the file mode this package will create, 0600 — reported as the
// materialized event's file_mode column and asserted by the tests.
const Mode = 0o600

// Delivery is one authorized write of one already-resolved secret.
type Delivery struct {
	// Mount is the pin: where the value goes and what it is called.
	Mount Mount
	// Repository is the authorized checkout the write happens in.
	Repository Repository
	// Value is the plaintext. It lives here only between Resolve and the
	// write; Cleanup zeroes it, and no serialized form of Delivery exists
	// because there is nothing safe to serialize it into.
	Value []byte
}

// Repository names one checkout the unit is authorized to write into, plus the
// mirror whose info/exclude carries the project-scoped exclusion.
type Repository struct {
	// Name is the repository name; it must match the mount's repository.
	Name string
	// Path is the absolute worktree path — the authorized root for this write.
	Path string
	// MirrorPath is the absolute path of the bare mirror shared by every
	// worktree of this project.
	MirrorPath string
}

// Mount is the row-shaped pin the materializer was given. It mirrors
// 00004's secret_mounts columns so the caller can pass the row through without
// a translation layer inventing defaults.
type Mount struct {
	SecretID   string
	SecretSlug string
	Version    int
	// RepositoryName is which authorized checkout the path is relative to.
	RepositoryName string
	// DeliveryMode is env or env_file. integration_broker never reaches here:
	// secrets.Resolver refuses it (ADR-0018 clause 8).
	DeliveryMode string
	// RelativePath is the path inside the checkout, for env_file. It is what
	// gets excluded, validated and created — never an absolute path.
	RelativePath string
	// EnvName is the environment variable name, for env.
	EnvName string
	// Key optionally extracts one key from a multi-line value.
	Key string
	// Lifecycle is turn, workspace or node_attempt (00004's CHECK arms).
	// node_attempt is M4's: the mount one attempt owns, recorded against
	// secret_materializations.attempt_id and removed at the attempt boundary
	// rather than the turn's (ADR-0018 D1, contract § 4 step 4). The
	// materializer itself treats all three identically — its job is the write,
	// the lifecycle is whose lifetime the value is bound to, and it is the
	// caller that owns a boundary.
	Lifecycle string
	// AllowTracked is the mount row's explicit policy exception (C-ENV6.4).
	AllowTracked bool
	// AllowOverwrite is the second policy exception: a mount re-materializing
	// over the file it owns (its own checkpoint) rather than onto something new.
	AllowOverwrite bool
}

// Options configures a Materializer.
type Options struct {
	// Repositories are the checkouts the unit is authorized to write into. An
	// empty set means this unit has nothing to materialize into, which is a
	// valid configuration and not an error.
	Repositories []Repository
	// RunGit, when set, replaces the git invocations — the seam every test in
	// this package uses to script tracked-state answers, and the same seam
	// internal/worker uses for the real thing.
	RunGit func(ctx context.Context, dir string, args ...string) ([]byte, error)
}

// Materializer writes deliveries for one unit. It holds no secrets and no keys;
// it is a filesystem procedure with a git dependency.
type Materializer struct {
	repos  map[string]Repository
	runGit func(ctx context.Context, dir string, args ...string) ([]byte, error)
	// excludeLocks serializes info/exclude appends per mirror, because
	// concurrent deliveries of the same basename in one project would otherwise
	// interleave a read-modify-write on a file two worktrees share.
	excludeLocks map[string]*sync.Mutex
	mu           sync.Mutex
}

// New validates the configuration. Every repository path must be absolute and
// free of "..": an authorized root that is itself relative or symlinked upward
// would make every downstream check meaningless.
func New(opts Options) (*Materializer, error) {
	m := &Materializer{
		repos:        make(map[string]Repository, len(opts.Repositories)),
		excludeLocks: make(map[string]*sync.Mutex),
		runGit:       opts.RunGit,
	}
	if m.runGit == nil {
		m.runGit = runGit
	}
	for _, repo := range opts.Repositories {
		switch {
		case repo.Name == "":
			return nil, errors.New("materialize: repository name is empty")
		case !filepath.IsAbs(repo.Path):
			return nil, fmt.Errorf("materialize: repository %s path %q is not absolute", repo.Name, repo.Path)
		case strings.Contains(repo.Path, ".."):
			return nil, fmt.Errorf("materialize: repository %s path %q contains ..", repo.Name, repo.Path)
		case repo.MirrorPath != "" && (!filepath.IsAbs(repo.MirrorPath) || strings.Contains(repo.MirrorPath, "..")):
			return nil, fmt.Errorf("materialize: repository %s mirror path %q is unusable", repo.Name, repo.MirrorPath)
		}
		if _, dup := m.repos[repo.Name]; dup {
			return nil, fmt.Errorf("materialize: repository %s is authorized twice", repo.Name)
		}
		m.repos[repo.Name] = Repository{
			Name:       repo.Name,
			Path:       filepath.Clean(repo.Path),
			MirrorPath: filepath.Clean(repo.MirrorPath),
		}
	}
	return m, nil
}

// Deliver writes one delivery and returns the metadata for the
// secret.materialized event. On error nothing is written: the file is not
// created, the exclusion is not necessarily rolled back (exclusions are
// additive and project-scoped, and an unused exclusion harms nothing), and the
// value is zeroed.
func (m *Materializer) Deliver(ctx context.Context, d *Delivery) (*Receipt, error) {
	if d == nil {
		return nil, errors.New("materialize: nil delivery")
	}
	repo, ok := m.repos[d.Mount.RepositoryName]
	if !ok {
		return nil, refuse(ReasonBadShape, d.Mount.RelativePath,
			fmt.Errorf("repository %q is not authorized for this unit", d.Mount.RepositoryName))
	}
	d.Repository = repo

	switch d.Mount.DeliveryMode {
	case "env":
		return m.deliverEnv(ctx, d)
	case "env_file":
		return m.deliverFile(ctx, d)
	default:
		return nil, refuse(ReasonBadShape, d.Mount.RelativePath,
			fmt.Errorf("delivery mode %q cannot be materialized", d.Mount.DeliveryMode))
	}
}

// deliverEnv hands the value back to the launcher as an env entry. The contract's
// "a file is created with mode 0600" is about env_file; for env there is
// deliberately no file, because a secret that lands in the process environment
// is visible to every child the agent spawns anyway and pretending otherwise
// would add a file to the workspace for no benefit (spec 05's env-vs-env_file
// asymmetry).
func (m *Materializer) deliverEnv(ctx context.Context, d *Delivery) (*Receipt, error) {
	if err := validEnvName(d.Mount.EnvName); err != nil {
		return nil, refuse(ReasonBadShape, d.Mount.EnvName, err)
	}
	value, keys, err := selectKey(d.Value, d.Mount.Key)
	if err != nil {
		return nil, refuse(ReasonBadShape, d.Mount.EnvName, err)
	}
	receipt := &Receipt{
		DeliveryMode:   "env",
		Target:         d.Mount.EnvName,
		EnvName:        d.Mount.EnvName,
		EnvValue:       value,
		KeyNames:       keys,
		SecretID:       d.Mount.SecretID,
		SecretSlug:     d.Mount.SecretSlug,
		Version:        d.Mount.Version,
		Lifecycle:      lifecycle(d.Mount),
		RepositoryName: d.Mount.RepositoryName,
	}
	// The value aliases the caller's buffer (or one line inside it): a second copy
	// in memory would double what a heap dump can reveal, so cleanup zeroes the
	// one buffer and drops every reference to it.
	receipt.cleanup = func() error {
		clear(value)
		clear(d.Value)
		d.Value = nil
		receipt.EnvValue = nil
		return nil
	}
	return receipt, nil
}

// deliverFile runs steps 1-6 and 7's precondition for env_file.
func (m *Materializer) deliverFile(ctx context.Context, d *Delivery) (*Receipt, error) {
	repo := d.Repository
	rel, err := validateRelative(d.Mount.RelativePath)
	if err != nil {
		return nil, err
	}
	d.Mount.RelativePath = rel

	root, err := filepath.EvalSymlinks(repo.Path)
	if err != nil {
		return nil, refuse(ReasonBadShape, rel, fmt.Errorf("authorized root is not resolvable: %w", err))
	}
	parent, err := m.resolveParent(root, rel)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(parent, filepath.Base(rel))
	// Step 3 refuses a symlinked target only. A *regular* file at the target is
	// step 6's problem, not step 3's: for a tracked path the file always exists,
	// and refusing it here would report "exists" where the honest answer is
	// "tracked".
	if fi, err := os.Lstat(target); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
		// The case C-ENV5 had to be rewritten for: a link pointing at ~/.ssh is
		// never followed, written through, or removed.
		return nil, refuse(ReasonSymlinkParent, rel, errors.New("target exists as a symlink"))
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, refuse(ReasonBadShape, rel, fmt.Errorf("cannot inspect target: %w", err))
	}

	// Step 4: tracked-state refusal, with the mount row's explicit exception.
	tracked, err := m.isTracked(ctx, repo, rel)
	if err != nil {
		return nil, err
	}
	if tracked && !d.Mount.AllowTracked {
		return nil, refuse(ReasonTrackedTarget, rel, errors.New("git ls-files lists the target: materializing over a tracked file would destroy content"))
	}

	// Step 5, before the write: the exclusion must already hold.
	if err := m.ensureExcluded(ctx, repo, rel); err != nil {
		return nil, err
	}

	value, keys, err := selectKey(d.Value, d.Mount.Key)
	if err != nil {
		return nil, refuse(ReasonBadShape, rel, err)
	}
	replaced, err := m.writeOnceThenOnce(target, rel, value, d.Mount, tracked)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			// Step 6: the bytes already there are not ours to replace. Either
			// nothing authorized an overwrite, or something recreated the path
			// between the one remove and the one retry — which is the race the
			// "refuse a second time" clause exists to lose loudly.
			return nil, refuse(ReasonExists, rel, errors.New("target exists and no policy authorized replacing it"))
		}
		return nil, fmt.Errorf("materialize: write %s: %w", rel, err)
	}
	receipt := &Receipt{
		DeliveryMode:    "env_file",
		Target:          target,
		RelativePath:    rel,
		KeyNames:        keys,
		FileMode:        Mode,
		SecretID:        d.Mount.SecretID,
		SecretSlug:      d.Mount.SecretSlug,
		Version:         d.Mount.Version,
		Lifecycle:       lifecycle(d.Mount),
		RepositoryName:  d.Mount.RepositoryName,
		ReplacedContent: replaced,
	}
	// Step 7's half of the contract: remove the file this receipt created and
	// nothing else — never the exclusion, never a directory, never a file another
	// run owns.
	receipt.cleanup = func() error {
		if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("materialize: remove %s: %w", rel, err)
		}
		clear(value)
		clear(d.Value)
		d.Value = nil
		return nil
	}
	return receipt, nil
}

// Receipt is the metadata the worker publishes as secret.materialized. It
// carries no value: the env arm's EnvValue is the only material field, and it is
// the launcher's to consume, zero on Cleanup, and never a JSON field.
type Receipt struct {
	DeliveryMode   string
	Target         string
	RelativePath   string
	EnvName        string
	EnvValue       []byte
	KeyNames       []string
	FileMode       int
	SecretID       string
	SecretSlug     string
	Version        int
	Lifecycle      string
	RepositoryName string
	// ReplacedContent records that the write destroyed bytes that were already
	// at the path — which, given the policy flags, means either a tracked file
	// under the mount's allow_tracked exception or this mount's own previous
	// materialization. Audit-relevant: it is the one case where content the
	// workspace owned is gone.
	ReplacedContent bool

	// cleaned reports whether Cleanup has run, so a second call is a no-op
	// instead of a second removal attempt.
	cleaned bool

	cleanup func() error
}

// Cleanup removes what Deliver created and zeroes what it held. It is idempotent
// (step 7 plus "turn_end is not guaranteed to arrive once", which makes
// double-cleanup normal rather than exceptional), it never removes a file it did
// not create, and it never touches the exclusion entry: exclusions are
// project-scoped and shared by every worktree, so removing one entry from a
// finished run's cleanup would expose every other run's secrets (PROBES G5).
func (r *Receipt) Cleanup(ctx context.Context) error {
	_ = ctx
	if r == nil || r.cleanup == nil {
		return nil
	}
	if r.cleaned {
		return nil
	}
	r.cleaned = true
	return r.cleanup()
}

// Meta returns exactly the fields secret.materialized carries. Kept as a method
// rather than a struct field so the worker builds the payload from data that is
// already validated to be value-free.
type Meta struct {
	SecretID       string   `json:"secret_id"`
	Slug           string   `json:"slug"`
	Version        int      `json:"version"`
	DeliveryMode   string   `json:"delivery_mode"`
	RepositoryName string   `json:"repository_name,omitempty"`
	RelativePath   string   `json:"relative_path,omitempty"`
	EnvName        string   `json:"env_name,omitempty"`
	Mode           string   `json:"mode"`
	KeyNames       []string `json:"key_names"`
	Lifecycle      string   `json:"lifecycle"`
}

// Meta reports the event-shaped metadata for this receipt.
func (r *Receipt) Meta() Meta {
	return Meta{
		SecretID:       r.SecretID,
		Slug:           r.SecretSlug,
		Version:        r.Version,
		DeliveryMode:   r.DeliveryMode,
		RepositoryName: r.RepositoryName,
		RelativePath:   r.RelativePath,
		EnvName:        r.EnvName,
		// Mode is the file mode as the event spells it ("0600"), and empty for
		// env delivery, where there is no file to have a mode — a "0000" in the
		// journal would read like a broken create rather than no create at all.
		Mode:      modeString(r.FileMode),
		KeyNames:  append([]string(nil), r.KeyNames...),
		Lifecycle: r.Lifecycle,
	}
}

func modeString(mode int) string {
	if mode == 0 {
		return ""
	}
	return fmt.Sprintf("%04o", mode)
}

// validateRelative is step 1: relative, no "..", no NUL, no empty segments, and
// a shape the exclusion can be written for. It mirrors the probe's C-ENV6
// battery exactly, including the two shapes that are neither absolute nor
// escaping (leading slash is absolute; "a//b" and "a/./b" are bad shapes).
func validateRelative(rel string) (string, error) {
	if rel == "" {
		return "", refuse(ReasonBadShape, rel, errors.New("path is empty"))
	}
	if strings.ContainsRune(rel, 0) {
		return "", refuse(ReasonBadShape, rel, errors.New("path contains a NUL"))
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return "", refuse(ReasonAbsolutePath, rel, errors.New("path must be relative"))
	}
	windowsAbsolute := len(rel) >= 3 && rel[1] == ':' && (rel[2] == '\\' || rel[2] == '/')
	if windowsAbsolute {
		return "", refuse(ReasonAbsolutePath, rel, errors.New("path must be relative"))
	}
	for _, seg := range strings.Split(rel, "/") {
		switch seg {
		case "":
			return "", refuse(ReasonBadShape, rel, errors.New("empty path segment"))
		case ".":
			return "", refuse(ReasonBadShape, rel, errors.New("'.' segment is not allowed"))
		case "..":
			return "", refuse(ReasonPathEscape, rel, errors.New("'..' segment escapes the authorized root"))
		}
		if strings.Contains(seg, `\`) {
			return "", refuse(ReasonBadShape, rel, errors.New("backslash in a path segment"))
		}
	}
	if strings.HasPrefix(rel, ".git/") || rel == ".git" || strings.Contains(rel, "/.git/") {
		// Writing into the gitdir is how C-ENV2 (a credential in a
		// world-writable shared config) happens, so the path language excludes
		// it rather than relying on the caller to pick a nicer name.
		return "", refuse(ReasonPathEscape, rel, errors.New("path reaches the git directory"))
	}
	// The probe recorded a path Clean() would rewrite as needs_cleaning: two
	// readers (this package and git's ignore matcher) that disagree about the
	// spelling of a path is how an exclusion silently stops applying, so an
	// unnormalized path is refused rather than quietly normalized.
	if got := filepath.ToSlash(filepath.Join("/", rel)); got != "/"+rel {
		return "", refuse(ReasonBadShape, rel, errors.New("path is not in clean form"))
	}
	return filepath.ToSlash(rel), nil
}

// resolveParent performs step 2 in its two required halves: no component of the
// parent chain may be a symlink, and the realpath of the parent must still sit
// under the authorized root. It walks what exists, creates what does not, and
// then re-resolves — checking the chain and then trusting a parent that a
// concurrent writer could have replaced with a link would be the check that
// passes in a test and fails in a race.
func (m *Materializer) resolveParent(root, rel string) (string, error) {
	dir := filepath.Dir(rel)
	if dir == "." {
		dir = ""
	}
	steps := []string{}
	if dir != "" && dir != "." {
		steps = strings.Split(dir, "/")
	}
	walked := root
	for _, seg := range steps {
		walked = filepath.Join(walked, seg)
		fi, err := os.Lstat(walked)
		switch {
		case err == nil && fi.Mode()&fs.ModeSymlink != 0:
			return "", refuse(ReasonSymlinkParent, rel, fmt.Errorf("%s is a symlink", walked))
		case err != nil && !errors.Is(err, fs.ErrNotExist):
			return "", refuse(ReasonBadShape, rel, fmt.Errorf("cannot inspect %s: %w", walked, err))
		case err != nil:
			// Nothing below here exists yet.
			if err := os.MkdirAll(walked, 0o755); err != nil {
				return "", refuse(ReasonBadShape, rel, fmt.Errorf("cannot create %s: %w", walked, err))
			}
		}
	}
	parent := root
	if dir != "" {
		parent = filepath.Join(root, dir)
	}
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", refuse(ReasonBadShape, rel, fmt.Errorf("parent directory is not resolvable: %w", err))
	}
	if !under(resolved, root) {
		return "", refuse(ReasonPathEscape, rel, fmt.Errorf("parent resolves to %s, outside the authorized root", resolved))
	}
	return resolved, nil
}

// isTracked answers step 4 with `git ls-files --error-unmatch`.
func (m *Materializer) isTracked(ctx context.Context, repo Repository, rel string) (bool, error) {
	_, err := m.runGit(ctx, repo.Path, "ls-files", "--error-unmatch", "--", rel)
	if err == nil {
		return true, nil
	}
	var ge *GitError
	if errors.As(err, &ge) && ge.ExitCode == 1 {
		// ls-files --error-unmatch exits 1 for "not in the index", which is the
		// answer we wanted, not a failure.
		return false, nil
	}
	return false, fmt.Errorf("materialize: tracked check for %s: %w", rel, err)
}

// ensureExcluded is step 5, and it is the one procedure in this package that
// touches anything outside the checkout: it appends to <mirror>/info/exclude and
// then asks git to confirm the rule actually applies.
//
// It appends rather than rewriting, because the file is shared by every worktree
// of the project and a rewrite could drop another run's rule; and it confirms
// with `git check-ignore -v` rather than trusting that writing the file was
// enough, because the three placements PROBES G1-G5 tested differ in which of
// them git consults at all, and a wrong placement is an invisible failure that
// ends in a secret inside a commit.
func (m *Materializer) ensureExcluded(ctx context.Context, repo Repository, rel string) error {
	if repo.MirrorPath == "" {
		return refuse(ReasonMirrorWritable, rel, errors.New("no mirror path: the exclusion has nowhere to live, and an unexcluded secret can be committed"))
	}
	mu := m.lockFor(repo.MirrorPath)
	mu.Lock()
	defer mu.Unlock()

	// The worktree's own gitdir is authoritative for what git reads; the mirror
	// is where it lives for every worktree of the project. Resolve rather than
	// assume the layout (PROBES G2).
	excludePath := filepath.Join(repo.MirrorPath, "info", "exclude")
	if err := os.MkdirAll(filepath.Dir(excludePath), 0o755); err != nil {
		return refuse(ReasonMirrorWritable, rel, fmt.Errorf("cannot create the mirror's info directory: %w", err))
	}
	pattern := "/" + rel
	if err := appendUnique(excludePath, pattern); err != nil {
		return refuse(ReasonMirrorWritable, rel, fmt.Errorf("cannot append to %s: %w", excludePath, err))
	}
	// --no-index because a tracked path is never "ignored" as far as the index is
	// concerned, and a policy exception for a tracked target must still be
	// verifiable at the pattern level (PROBES G1's note on the host arm).
	out, err := m.runGit(ctx, repo.Path, "check-ignore", "--no-index", "-v", "--", rel)
	if err != nil {
		var ge *GitError
		if errors.As(err, &ge) && ge.ExitCode == 1 {
			return refuse(ReasonMirrorWritable, rel, fmt.Errorf("%s does not exclude %s (git check-ignore says it is not ignored)", excludePath, rel))
		}
		return fmt.Errorf("materialize: exclusion check for %s: %w", rel, err)
	}
	if !bytes.Contains(out, []byte("info/exclude")) {
		// A rule from somewhere else (an agent's .gitignore, a global ignore)
		// that happens to match is not the exclusion this procedure guarantees.
		return refuse(ReasonMirrorWritable, rel, fmt.Errorf("%s is ignored by a rule that is not in %s: %s", rel, excludePath, strings.TrimSpace(string(out))))
	}
	return nil
}

// writeOnceThenOnce is step 6: create with O_CREAT|O_EXCL, and on EEXIST remove
// and create exactly once more — the one allowance ADR-0018 D4 makes for that
// row's own previous materialization or its own tracked target. A second EEXIST
// is a refusal, because the path is being recreated under us.
func (m *Materializer) writeOnceThenOnce(target, rel string, value []byte, mount Mount, tracked bool) (bool, error) {
	err := writeFileExclusive(target, value)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return false, err
	}
	if !(mount.AllowOverwrite || (mount.AllowTracked && tracked)) {
		return false, err
	}
	if rmErr := os.Remove(target); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
		return false, rmErr
	}
	if err := writeFileExclusive(target, value); err != nil {
		return false, err
	}
	return true, nil
}

// lockFor returns the per-mirror append lock.
func (m *Materializer) lockFor(path string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	lock, ok := m.excludeLocks[path]
	if !ok {
		lock = &sync.Mutex{}
		m.excludeLocks[path] = lock
	}
	return lock
}

// appendUnique adds pattern unless the file already contains that exact line.
func appendUnique(path, pattern string) error {
	// O_APPEND, not SeekEnd: two workers of one project (which share a mirror by
	// construction, PROBES G5) race here routinely, and O_APPEND is the one
	// ordering POSIX guarantees for concurrent small writes. The in-process mutex
	// below keeps a single worker's own deliveries from duplicating the read.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	for _, line := range lines {
		if strings.TrimSpace(line) == pattern {
			return nil
		}
	}
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		if _, err := f.WriteString("\n"); err != nil {
			return err
		}
	}
	_, err = f.WriteString(pattern + "\n")
	return err
}

// writeFileExclusive is step 6: O_CREAT|O_EXCL at 0600, with the content written
// before the mode is relied on. No chmod: the mode is set at create, which is the
// only ordering in which an attacker with a racing path cannot win.
func writeFileExclusive(path string, value []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, Mode)
	if err != nil {
		return err
	}
	written, werr := f.Write(value)
	cerr := f.Close()
	switch {
	case werr != nil:
		_ = os.Remove(path)
		return werr
	case cerr != nil:
		_ = os.Remove(path)
		return cerr
	case written != len(value):
		_ = os.Remove(path)
		return fmt.Errorf("wrote %d of %d bytes", written, len(value))
	}
	return nil
}

// selectKey applies the mount's key selection. A multi-line value with a Key
// asked for yields that one key's line, because the mount said so — and the
// reported key names are what the event carries, never the content.
func selectKey(value []byte, key string) ([]byte, []string, error) {
	if key == "" {
		return value, keyNames(value), nil
	}
	line, ok := lookupKey(value, key)
	if !ok {
		return nil, nil, fmt.Errorf("value has no %s= entry to extract", key)
	}
	return []byte(key + "=" + line + "\n"), []string{key}, nil
}

// keyNames lists the KEY= names in a dotenv-shaped value. Names are metadata
// (they are what the mount already declares); values never leave here.
func keyNames(value []byte) []string {
	var names []string
	for _, line := range strings.Split(string(value), "\n") {
		name, _, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(strings.TrimPrefix(name, "export "))
		if validEnvName(name) != nil {
			continue
		}
		names = append(names, name)
	}
	return names
}

// lookupKey finds one KEY=value line's value.
func lookupKey(value []byte, key string) (string, bool) {
	for _, line := range strings.Split(string(value), "\n") {
		name, rest, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		if strings.TrimSpace(strings.TrimPrefix(name, "export ")) == key {
			return strings.TrimSpace(rest), true
		}
	}
	return "", false
}

// validEnvName enforces the [A-Za-z_][A-Za-z0-9_]* shape the SecretMount
// openapi schema requires, so a mount that would produce an entry the shell
// cannot name is refused here rather than at launch.
func validEnvName(name string) error {
	if name == "" {
		return errors.New("env name is empty")
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		ok := c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (i > 0 && c >= '0' && c <= '9')
		if !ok {
			return fmt.Errorf("env name %q is not [A-Za-z_][A-Za-z0-9_]*", name)
		}
	}
	return nil
}

// under reports whether path is path or below root, on cleaned absolute paths.
func under(path, root string) bool {
	if path == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	return strings.HasPrefix(path, prefix)
}

// lifecycle defaults a missing mount lifecycle to turn, the mode that fails
// closed fastest: an unclaimed file is removed at turn end rather than kept.
// node_attempt passes through unchanged — it is the arm M4 finally materializes
// (contract § 4 step 4), and the receipt's lifecycle is what the audit event
// reports, so an attempt mount must never be labelled a turn's.
func lifecycle(m Mount) string {
	if m.Lifecycle == "" {
		return "turn"
	}
	return m.Lifecycle
}

// GitError is a non-zero git exit. Callers branch on ExitCode because for these
// two git commands an exit status is an answer, not a failure: ls-files exits 1
// for "not tracked" and check-ignore exits 1 for "not ignored".
type GitError struct {
	Args     []string
	ExitCode int
	Stderr   string
}

func (g *GitError) Error() string {
	return fmt.Sprintf("git %s exited %d: %s", strings.Join(g.Args, " "), g.ExitCode, strings.TrimSpace(g.Stderr))
}

func runGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code := exit.ExitCode()
		return stdout.Bytes(), &GitError{Args: args, ExitCode: code, Stderr: stderr.String()}
	}
	if err != nil {
		return stdout.Bytes(), fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return stdout.Bytes(), nil
}
