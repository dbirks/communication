package postgres

// Writable agent profiles (ADR-0030): the two writes behind
// POST /api/v1/agent-profiles and PATCH /api/v1/agent-profiles/{profileId}.
//
// The columns already existed (migrations/00003 created the table, 00004 added
// the apm_* columns); what was missing was any way to fill them, which left
// every APM pin in the world either hand-inserted by an operator or absent.
//
// Three rules govern this file:
//
//   - The permission predicate is part of the SQL. agent_profiles is
//     organization-scoped, so *visibility* (list/read) is any member of the
//     organization and *write* is the organization admin — the same fail-closed
//     reading of the library role that api/pipelines.go's requireLibraryRole
//     applies to the shared pipeline library. Create pushes the admin check
//     into the INSERT's WHERE; a non-admin's statement inserts zero rows and
//     answers the not-found sentinel rather than succeeding.
//   - State + its journal row in ONE transaction (ADR-0013/0016): the UPDATE
//     and the agent.profile.updated append share a tx and either can fail.
//   - An APM pin is all three columns or none. internal/agent/apm refuses to
//     launch on a digest mismatch, and the store-side read refuses an
//     unverifiable pin outright (workspaces.go's ProfileAxes read). A half pin
//     written through this API would turn that refusal into a launch-time
//     surprise for somebody else's conversation, so it is a 422 here.
//   - An UNLOCKED pin (ADR-0054 amendment 2) is the ref + target without the
//     digest; the lock flow is what records the digest, and the launch gate
//     refuses an unlocked pin at launch.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/events"
)

// Profile write errors, in the conversation family's shape so api/conversations
// .go's fail mapping stays one switch: not-found is also the answer to "you may
// not know this profile exists" (cross-organization), forbidden means the
// caller may list it but may not write it, validation is a well-formed request
// the columns or the pin rules refuse.
var (
	ErrProfileNotFound   = errors.New("postgres: agent profile not found")
	ErrProfileForbidden  = errors.New("postgres: agent profile write requires the organization's library role")
	ErrProfileConflict   = errors.New("postgres: an agent profile with that name already exists")
	ErrProfileValidation = errors.New("postgres: agent profile request failed validation")
)

// Named 422 codes (ADR-0030). A code is a stable string a client can switch on;
// the prose beside it may change. Adding one is additive, renaming one is not.
const (
	// ProfileCodeNameInvalid: name is empty or over 200 characters.
	ProfileCodeNameInvalid = "profile_name_invalid"
	// ProfileCodeLauncherInvalid: launcher_id breaks the registry grammar.
	ProfileCodeLauncherInvalid = "launcher_id_invalid"
	// ProfileCodeAPMIncomplete: the APM pin is not a legal shape — all three
	// set (locked), just the ref + target (unlocked, ADR-0054 amendment 2), or all
	// three cleared (the clear). A partial pin is refused with this code.
	ProfileCodeAPMIncomplete = "apm_pin_incomplete"
	// ProfileCodeAPMRefInvalid: apm_package_ref is not an apm git dependency.
	ProfileCodeAPMRefInvalid = "apm_package_ref_invalid"
	// ProfileCodeAPMTargetInvalid: apm_target is not claude or codex.
	ProfileCodeAPMTargetInvalid = "apm_target_invalid"
	// ProfileCodeAPMDigestInvalid: apm_lock_digest is not sha256:<64 hex>.
	ProfileCodeAPMDigestInvalid = "apm_lock_digest_invalid"
)

// AgentProfileProblem is a refused profile write that knows *why* in a
// machine-readable way: the sentinel ErrProfileValidation-family error plus the
// ADR-0030 code and the human sentence.
type AgentProfileProblem struct {
	Code    string
	Detail  string
	Wrapped error
}

func (p *AgentProfileProblem) Error() string {
	if p == nil {
		return "postgres: agent profile write refused"
	}
	return fmt.Sprintf("postgres: agent profile write refused (%s): %s", p.Code, p.Detail)
}

// Is lets errors.Is(err, ErrProfileValidation) see through to the sentinel, so
// the HTTP layer maps a coded refusal into the same 422 branch it already has.
func (p *AgentProfileProblem) Is(target error) bool { return target == ErrProfileValidation }

func profileRefused(code, detail string) error {
	return &AgentProfileProblem{Code: code, Detail: detail, Wrapped: ErrProfileValidation}
}

// cnvProfileColumns is the agent_profiles read list, shared by every select in
// this package so a new column lands in one place. COALESCE keeps the three
// nullable apm columns plain strings here (NULL and "" mean the same thing: this
// profile stages no packaged context); the API layer re-nulls them.
const cnvProfileColumns = `id::text, organization_id::text, name, launcher_id,
	permission_mode, created_at,
	COALESCE(apm_package_ref, ''), COALESCE(apm_target, ''), COALESCE(apm_lock_digest, '')`

// cnvProfileRow reads one profile scoped to the caller's organization: a profile
// in somebody else's organization answers not-found, never a peek
// (ADR-0014 §3). It is the shared precondition read for PATCH, which needs the
// current row to decide what "set the triple" means.
func cnvProfileRow(ctx context.Context, q prjQuerier, profileID, orgID string) (CnvProfile, error) {
	if !prjValidUUID(profileID) {
		return CnvProfile{}, ErrProfileNotFound
	}
	var p CnvProfile
	err := q.QueryRow(ctx, `
		SELECT `+cnvProfileColumns+`
		FROM agent_profiles
		WHERE id = $1::uuid AND organization_id = $2::uuid`, profileID, orgID).
		Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
			&p.PermissionMode, &p.CreatedAt,
			&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, ErrProfileNotFound
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: get agent profile: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()
	return p, nil
}

// --- validation ---------------------------------------------------------

// cnvLauncherPattern is agent_profiles.launcher_id's own CHECK.
var cnvLauncherPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// cnvDigestPattern is agent_profiles.apm_lock_digest's own CHECK. Checked here
// so a malformed digest is a 422 with a named code rather than a 23514 that the
// handler would have to render as a 500.
var cnvDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// validAgentProfileName is the length BETWEEN 1 AND 200 CHECK. Characters are
// unrestricted on purpose — the seeded names are "Claude Code" and "Codex", and
// a profile name is display text, not a slug.
func validAgentProfileName(s string) bool { return len(strings.TrimSpace(s)) >= 1 && len(s) <= 200 }

// ValidAPMPackageRef reports whether ref is an apm git dependency string of the
// shape docs/compatibility/APM.md's "Git-tag sources" spike proved on apm
// 0.33.0: `<owner>/<repo>[/<virtual-subdirectory>][#<ref>]`.
//
// The `#<ref>` part is required, which is stricter than apm: without it apm
// resolves whatever the default branch points at today, and the recorded lock
// digest would then be a pin on nothing. A tag is fine (`…#v1.3.1`), a branch is
// fine, a full commit sha is the strongest of the three; the subdirectory form is
// how one skill out of a multi-skill repo is selected (T-tag-5), and it persists
// in both apm.yml and the lock, so per-run `--frozen` staging replays it.
func ValidAPMPackageRef(ref string) bool {
	if ref == "" || strings.ContainsAny(ref, " \t\n") {
		return false
	}
	path, name, pinned := strings.Cut(ref, "#")
	if !pinned || name == "" {
		return false
	}
	segments := strings.Split(path, "/")
	if len(segments) < 2 {
		return false
	}
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	// A ref is a git ref name; the characters git refuses are enough here.
	return !strings.HasPrefix(name, "-") && !strings.HasSuffix(name, "/") &&
		!strings.Contains(name, "..") && !strings.ContainsAny(name, "~^:{}\\")
}

// checkAPMPin validates one write of the triple. All three absent means "this
// profile stages no packaged context" and is legal; a ref plus a target with no
// digest is an UNLOCKED pin (ADR-0054 amendment 2) and is legal too — the
// operator records the digest by locking, which is the only way the content is
// resolved and checked; anything else is a half pin and is refused with
// apm_pin_incomplete.
//
// Why the rule is here rather than only at launch: internal/agent/apm's Stage
// compares sha256(apm.lock.yaml) against the recorded digest, and the worker's
// profile read refuses an unlocked pin outright (workspaces.go's unlocked-pin
// rule, restated at the launch gate in stage.go). A pin written without a digest
// would therefore be accepted by the API and then make every conversation using
// that profile fail to launch — a delayed, anonymous refusal for the next reader
// instead of an immediate, named one for the writer.
func checkAPMPin(ref, target, digest *string) error {
	hasRef := ref != nil && *ref != ""
	hasTarget := target != nil && *target != ""
	hasDigest := digest != nil && *digest != ""
	switch {
	case !hasRef && !hasTarget && !hasDigest:
		return nil // the clear: staging nothing
	case hasRef && hasTarget && hasDigest:
		// Locked: the operator recorded a digest for this exact ref + target.
	case hasRef && hasTarget:
		// Unlocked (ADR-0054 amendment 2): the ref and the target are the pin,
		// the digest is the operator's to record through the lock flow.
	default:
		return profileRefused(ProfileCodeAPMIncomplete,
			"an apm pin is either all three set (locked) or just the ref and target (unlocked); a partial pin is refused.")
	}
	if !ValidAPMPackageRef(*ref) {
		return profileRefused(ProfileCodeAPMRefInvalid,
			"apm_package_ref must be an apm git dependency: <owner>/<repo>[/<skill-subdirectory>][#<tag|branch|commit>] — a ref with no #<ref> cannot be pinned.")
	}
	if !apm.ValidTarget(*target) {
		return profileRefused(ProfileCodeAPMTargetInvalid,
			fmt.Sprintf("apm_target must be one of %s/%s; internal/agent/apm installs for nothing else.",
				apm.TargetClaude, apm.TargetCodex))
	}
	if hasDigest && !cnvDigestPattern.MatchString(*digest) {
		return profileRefused(ProfileCodeAPMDigestInvalid,
			"apm_lock_digest must be sha256:<64 lowercase hex> — the sha256 of the apm.lock.yaml the operator recorded.")
	}
	return nil
}

// --- writes -------------------------------------------------------------

// cnvPool refuses with a plain error rather than a nil-deref panic when the
// store was built without a pool (the same rule m4Pool enforces for M4).
func (s *CnvStore) cnvPool() (*pgxpool.Pool, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: CnvStore has no pool")
	}
	return s.Pool, nil
}

// CreateAgentProfile inserts a launch descriptor. permission_mode is not a
// parameter: 'ask' is the only mode a profile with no verified enforced sandbox
// may have (04-agent-runtime.md "Permission policy", ADR-0009), and the column
// default supplies it. The APM triple is not a parameter either — a new profile
// stages nothing until a PATCH records a verified pin, so the create path cannot
// write a pin nobody has digested yet.
//
// The admin check is the INSERT's WHERE clause: a caller who is not an
// organization admin matches zero rows and gets ErrProfileForbidden out of the
// zero-row branch below, not a row.
func (s *CnvStore) CreateAgentProfile(ctx context.Context, c Caller, name, launcherID string) (CnvProfile, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvProfile{}, err
	}
	if !validAgentProfileName(name) {
		return CnvProfile{}, profileRefused(ProfileCodeNameInvalid, "name is required and must be at most 200 characters.")
	}
	if !cnvLauncherPattern.MatchString(launcherID) {
		return CnvProfile{}, profileRefused(ProfileCodeLauncherInvalid,
			"launcher_id must match ^[a-z0-9][a-z0-9_-]{0,63}$ (a registry id, not a command line).")
	}
	pool, err := s.cnvPool()
	if err != nil {
		return CnvProfile{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: begin create agent profile: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p CnvProfile
	err = tx.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id)
		SELECT $1::uuid, $2, $3
		WHERE $4::boolean
		RETURNING `+cnvProfileColumns,
		c.OrganizationID, strings.TrimSpace(name), launcherID, c.IsOrgAdmin).
		Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
			&p.PermissionMode, &p.CreatedAt,
			&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, ErrProfileForbidden
	}
	if m4UniqueViolation(err) {
		// UNIQUE (organization_id, name): the name is taken, not the caller.
		return CnvProfile{}, ErrProfileConflict
	}
	if pgConflictCode(err, "23514") {
		return CnvProfile{}, profileRefused(ProfileCodeLauncherInvalid,
			"name and launcher_id were refused by the profile's own column constraints.")
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: insert agent profile: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentProfileCreated,
		OrganizationID: p.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentProfileCreatedPayload{
			ProfileID:      p.ID,
			Name:           p.Name,
			LauncherID:     p.LauncherID,
			PermissionMode: p.PermissionMode,
		},
	}); err != nil {
		return CnvProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: commit create agent profile: %w", err)
	}
	return p, nil
}

// PatchAgentProfileAPM writes the APM triple — and only the triple. It never
// touches permission_mode, the launcher, or any other axis: those are separate
// decisions with separate evidence, and a route that could quietly move the
// sandbox axis while "attaching a skills package" would be the easy way to widen
// an agent's grant set without anyone reading a diff.
//
// A nil pointer means "this write does not carry the column", and checkAPMPin
// refuses any partial triple, so the two legal calls are all three values and
// all three nil-or-empty (the clear).
func (s *CnvStore) PatchAgentProfileAPM(ctx context.Context, c Caller, profileID string, ref, target, digest *string) (CnvProfile, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvProfile{}, err
	}
	if err := checkAPMPin(ref, target, digest); err != nil {
		return CnvProfile{}, err
	}
	pool, err := s.cnvPool()
	if err != nil {
		return CnvProfile{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: begin patch agent profile: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The visibility read is also what separates 404 from 403: a profile in
	// another organization does not exist for this caller at all, while one in
	// this organization is list-visible and the failure is a missing role.
	if _, err := cnvProfileRow(ctx, tx, profileID, c.OrganizationID); err != nil {
		return CnvProfile{}, err
	}
	if !c.IsOrgAdmin {
		return CnvProfile{}, ErrProfileForbidden
	}

	null := func(v *string) any {
		if v == nil || *v == "" {
			return nil
		}
		return *v
	}
	var p CnvProfile
	var contents *string
	// The library-role predicate is part of the UPDATE's own WHERE ($7): the write
	// refuses rather than trusting the caller to have checked, because every other
	// writer in this package is a future caller too.
	//
	// apm_contents_summary rides the same write as apm_lock_digest: a pin that is
	// unlocked or cleared leaves both null, so a digest (and the names-only
	// contents summary that came with it) can never survive a ref/target change.
	err = tx.QueryRow(ctx, `
		UPDATE agent_profiles
		SET apm_package_ref = $1, apm_target = $2, apm_lock_digest = $3, apm_contents_summary = $4
		WHERE id = $5::uuid AND organization_id = $6::uuid AND $7::boolean
		RETURNING `+cnvProfileColumns+", apm_contents_summary",
		null(ref), null(target), null(digest), nil,
		profileID, c.OrganizationID, c.IsOrgAdmin).
		Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
			&p.PermissionMode, &p.CreatedAt,
			&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest, &contents)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, ErrProfileForbidden
	}
	if pgConflictCode(err, "23514") {
		// A CHECK violation means the validation above and the column's own rule
		// disagreed — still a 422 naming the field, never a 500.
		return CnvProfile{}, profileRefused(ProfileCodeAPMDigestInvalid,
			"the APM triple was refused by the profile's own column constraints.")
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: patch agent profile apm: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()
	p.APMLockContents = nil
	if contents != nil {
		var lock apmLockContentsJSON
		if uerr := json.Unmarshal([]byte(*contents), &lock); uerr != nil {
			return CnvProfile{}, fmt.Errorf("postgres: decode apm lock contents: %w", uerr)
		}
		p.APMLockContents = &lock
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentProfileUpdated,
		OrganizationID: p.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentProfileUpdatedPayload{
			ProfileID:     p.ID,
			APMPackageRef: p.APMPackageRef,
			APMTarget:     p.APMTarget,
			APMLockDigest: p.APMLockDigest,
			// The pin is cleared when nothing is left set — recorded so a reader
			// can tell "this profile now stages nothing" from "the digest moved".
			APMPinCleared: p.APMPackageRef == "",
		},
	}); err != nil {
		return CnvProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: commit patch agent profile: %w", err)
	}
	return p, nil
}

// pgConflictCode reports a SQLSTATE anywhere in err's chain. The database's own
// CHECK/unique constraints are the backstop below the validations above: a
// violation is still a refused request, never a 500 that echoes a constraint
// name.
func pgConflictCode(err error, code string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == code
}
