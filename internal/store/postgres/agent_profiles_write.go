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
	// ErrProfileVersionConflict is ADR-0058's optimistic-concurrency refusal: a
	// profile write carried a version the profile's row no longer has, so the
	// write must not land and the caller must re-read the version history.
	ErrProfileVersionConflict = errors.New("postgres: agent profile version conflict")
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
	// ProfileCodeModelInvalid: model (ADR-0068) is over the 200-character
	// column CHECK.
	ProfileCodeModelInvalid = "profile_model_invalid"
	// ProfileCodePermissionModeInvalid: the snapshot's permission mode is not
	// one of the recorded modes, or it is autonomous_within_sandbox while the
	// profile row's sandbox_enforcement is not `required` — the mode's whole
	// claim is that the sandbox is the boundary (ADR-0069), so the pair is
	// refused at the write, not discovered at launch (mirrors the DB CHECKs
	// from migration 00025).
	ProfileCodePermissionModeInvalid = "permission_mode_invalid"
	// ProfileCodeLauncherNeedsOperator: the requested launcher's registry entry
	// has no verified prompting mode, so the only mode its profile can honestly
	// carry is autonomous_within_sandbox (ADR-0069 + its 2026-11-11 amendment),
	// and declaring that mode is the operator's action — a caller without the
	// organization's admin role is refused rather than handed a profile whose
	// every turn fails closed at launch.
	ProfileCodeLauncherNeedsOperator = "launcher_needs_operator"
)

// The launch axes' column defaults (migrations 00003/00004), named here so the
// create path and the API handler agree on what "the request resolved nothing"
// means. `ask` is still the mode a prompting launcher gets.
const (
	ProfileModeAsk                     = "ask"
	ProfileModeAutonomousWithinSandbox = "autonomous_within_sandbox"
	ProfileSandboxEnforcementRequired  = "required"
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

// agentProfilePermissionModes is the Go restatement of migration 00003/00025's
// permission_mode CHECK — the four recorded modes of 04 "Permission policy"
// plus ADR-0069's autonomous_within_sandbox. The HTTP surface never lets a
// request body choose among them (the create path writes the `ask` column
// default); the one write that DOES move a mode is a version restore, and
// that path checks here so the refusal carries a code, not a database error.
var agentProfilePermissionModes = map[string]bool{
	"ask":                        true,
	"preapproved_within_sandbox": true,
	"deny":                       true,
	"autonomous_within_sandbox":  true,
}

// checkAgentProfilePermissionMode states ADR-0069's pair rule: the mode must
// be recorded, and autonomous_within_sandbox is only ever honest beside
// sandbox_enforcement `required`. Migration 00025 enforces both again in the
// database; a refusal that never reaches Postgres names the code.
func checkAgentProfilePermissionMode(mode, sandboxEnforcement string) error {
	if !agentProfilePermissionModes[mode] {
		return profileRefused(ProfileCodePermissionModeInvalid,
			"permission_mode must be one of ask, preapproved_within_sandbox, deny, autonomous_within_sandbox.")
	}
	if mode == "autonomous_within_sandbox" && sandboxEnforcement != "required" {
		return profileRefused(ProfileCodePermissionModeInvalid,
			"autonomous_within_sandbox requires the profile's sandbox_enforcement to be 'required': the mode claims the sandbox is the boundary, and this profile does not have one (ADR-0069).")
	}
	return nil
}

// cnvProfileColumns is the agent_profiles read list, shared by every select in
// this package so a new column lands in one place. COALESCE keeps the nullable
// apm columns and the ADR-0068 model plain strings here (NULL and "" mean the
// same thing: this profile stages no packaged context / names no model); the
// API layer re-nulls them. apm_collections (ADR-0084) is read as JSON TEXT
// because the ordered attachment list is a value the row type carries decoded —
// the order is the data, so it must survive the read exactly as stored.
const cnvProfileColumns = `id::text, organization_id::text, name, launcher_id,
	permission_mode, created_at, version,
	COALESCE(apm_package_ref, ''), COALESCE(apm_target, ''), COALESCE(apm_lock_digest, ''),
	COALESCE(model, ''), COALESCE(apm_collections, '[]'::jsonb)::text`

// scanCnvProfileColumns reads one row of cnvProfileColumns into p. The
// attachment list is decoded HERE rather than at each call site so one malformed
// column cannot be silently ignored by the fourth of five readers, and so the
// order the database stored is the order every reader sees.
func scanCnvProfileColumns(row pgx.Row, p *CnvProfile) error {
	var pinsText string
	if err := row.Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
		&p.PermissionMode, &p.CreatedAt, &p.Version,
		&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest, &p.Model, &pinsText); err != nil {
		return err
	}
	return decodeCnvProfilePins(p, pinsText)
}

// scanCnvProfileColumnsWithContents reads cnvProfileColumns plus the trailing
// apm_contents_summary column the two lock-aware selects append.
func scanCnvProfileColumnsWithContents(row pgx.Row, p *CnvProfile) error {
	var (
		pinsText string
		contents *string
	)
	if err := row.Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID,
		&p.PermissionMode, &p.CreatedAt, &p.Version,
		&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest, &p.Model, &pinsText, &contents); err != nil {
		return err
	}
	if err := decodeCnvProfilePins(p, pinsText); err != nil {
		return err
	}
	p.APMLockContents = nil
	if contents != nil {
		var lock apmLockContentsJSON
		if uerr := json.Unmarshal([]byte(*contents), &lock); uerr != nil {
			return fmt.Errorf("postgres: decode apm lock contents: %w", uerr)
		}
		p.APMLockContents = &lock
	}
	return nil
}

func decodeCnvProfilePins(p *CnvProfile, pinsText string) error {
	pins, err := DecodeAPMCollectionPins([]byte(pinsText))
	if err != nil {
		return err
	}
	p.APMCollectionPins = pins
	return nil
}

// cnvProfileRow reads one profile scoped to the caller's organization: a profile
// in somebody else's organization answers not-found, never a peek
// (ADR-0014 §3). It is the shared precondition read for PATCH, which needs the
// current row to decide what "set the triple" means — and, since ADR-0084, what
// "the attachment list changed" means.
func cnvProfileRow(ctx context.Context, q prjQuerier, profileID, orgID string) (CnvProfile, error) {
	if !prjValidUUID(profileID) {
		return CnvProfile{}, ErrProfileNotFound
	}
	var p CnvProfile
	err := scanCnvProfileColumns(q.QueryRow(ctx, `
		SELECT `+cnvProfileColumns+`
		FROM agent_profiles
		WHERE id = $1::uuid AND organization_id = $2::uuid`, profileID, orgID), &p)
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
// 0.34.0: `<owner>/<repo>[/<virtual-subdirectory>][#<ref>]`.
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
//
// ADR-0084 widens "pins packaged context" from `apm_package_ref` to
// "`apm_package_ref` OR an attached collection": a profile whose context is three
// collections and no ref of its own still needs a target (which tree apm installs
// into is not inferable from a list) and still may not carry a digest without one.
// `collections` is the list THIS write leaves on the row — the caller has already
// merged the absent-means-nothing rule, so the check sees the resulting state.
func checkAPMPin(ref, target, digest *string, collections []APMCollectionPin) error {
	hasRef := ref != nil && *ref != ""
	hasTarget := target != nil && *target != ""
	hasDigest := digest != nil && *digest != ""
	hasPins := hasRef || len(collections) > 0
	switch {
	case !hasPins && !hasTarget && !hasDigest:
		return nil // the clear: staging nothing
	case hasPins && hasTarget && hasDigest:
		// Locked: the operator recorded a digest for this exact set + target.
	case hasPins && hasTarget:
		// Unlocked (ADR-0054 amendment 2): the set and the target are the pin,
		// the digest is the operator's to record through the lock flow.
	default:
		return profileRefused(ProfileCodeAPMIncomplete,
			"an apm pin is either all of (ref or collections) + target + digest (locked) or just the set and the target (unlocked); a partial pin is refused.")
	}
	// ADR-0084: a profile whose context is a collection set and no ref of its own
	// is a complete pin, so the ref grammar is checked when a ref is present —
	// always the same grammar, never a weaker one.
	if hasRef && !ValidAPMPackageRef(*ref) {
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

// CreateAgentProfile inserts a launch descriptor. The APM triple is not a
// parameter — a new profile stages nothing until a PATCH records a verified pin,
// so the create path cannot write a pin nobody has digested yet.
//
// permissionMode/sandboxEnforcement are the launch axes the SERVER resolved
// (ADR-0069 amendment 2026-11-11): "" means "write nothing, take the column
// default" — `ask` and `required`, what a prompting launcher gets and the only
// mode an unverified launcher may have (04-agent-runtime.md "Permission policy",
// ADR-0009). autonomous_within_sandbox arrives only from the API's own
// resolution for a launcher with no verified prompting mode; no request body
// names either axis (DecodeJSON refuses unknown fields), and the pair rule is
// checked here as well as by migration 00025's CHECK. A mode other than `ask`
// additionally requires the caller to BE the organization admin in the store's
// own terms (launcher_needs_operator), so no future caller can thread an
// operator-declared mode through a non-admin caller.
//
// The admin check is the INSERT's WHERE clause: a caller who is not an
// organization admin matches zero rows and gets ErrProfileForbidden out of the
// zero-row branch below, not a row.
func (s *CnvStore) CreateAgentProfile(ctx context.Context, c Caller, name, launcherID, model, permissionMode, sandboxEnforcement string) (CnvProfile, error) {
	return s.CreateAgentProfileAttached(ctx, c, name, launcherID, model, permissionMode, sandboxEnforcement, nil)
}

// CreateAgentProfileAttached is the create path with ADR-0084's attachment list:
// nil means "this body named no collections", which is the pre-ADR-0084 create
// byte for byte. A non-nil list is validated against the database BEFORE the row
// is inserted — every entry a PUBLISHED revision of one of this organization's
// collections — because a profile created attaching a draft would be a profile
// whose staged content nobody published, which is the exact thing ADR-0084's
// published-only rule exists to refuse.
//
// What a create still cannot do is record a DIGEST: an attachment arrives
// UNLOCKED (ADR-0054 amendment 2), and the launch gate refuses it until an
// operator locks the flattened set. That is the honest state, not a half pin.
func (s *CnvStore) CreateAgentProfileAttached(ctx context.Context, c Caller, name, launcherID, model, permissionMode, sandboxEnforcement string, collections []APMCollectionPin) (CnvProfile, error) {
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
	if len(model) > 200 {
		return CnvProfile{}, profileRefused(ProfileCodeModelInvalid, "model must be at most 200 characters.")
	}
	mode, enforcement := permissionMode, sandboxEnforcement
	if mode == "" {
		mode = ProfileModeAsk
	}
	if enforcement == "" {
		enforcement = ProfileSandboxEnforcementRequired
	}
	if err := checkAgentProfilePermissionMode(mode, enforcement); err != nil {
		return CnvProfile{}, err
	}
	if mode != ProfileModeAsk && !c.IsOrgAdmin {
		return CnvProfile{}, profileRefused(ProfileCodeLauncherNeedsOperator,
			"This launcher has no verified prompting mode, so its profile runs as autonomous_within_sandbox — a mode only the organization's admin (the operator) may declare (ADR-0069).")
	}
	pool, err := s.cnvPool()
	if err != nil {
		return CnvProfile{}, err
	}
	// The attachments are checked against the collections themselves, not against
	// the profile: the rule is about what exists and is published, and refusing
	// before the INSERT is one less thing for the transaction to undo.
	var collectionsJSON []byte
	if collections != nil {
		if err := checkProfileAPMCollections(ctx, pool, c.OrganizationID, collections); err != nil {
			return CnvProfile{}, err
		}
		if collectionsJSON, err = ValidateAPMCollectionPins(collections); err != nil {
			return CnvProfile{}, err
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: begin create agent profile: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p CnvProfile
	// COALESCE, not NULLIF: the two axes are NOT NULL columns with defaults, and
	// an explicit NULL in the SELECT list would violate the NOT NULL constraint
	// instead of falling back to the default. $8 is ADR-0084's attachment list,
	// JSON text or nothing — '[]' when the create attached no collections.
	err = scanCnvProfileColumns(tx.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id, model, permission_mode, sandbox_enforcement, apm_collections)
		SELECT $1::uuid, $2, $3, NULLIF($4, ''), COALESCE(NULLIF($6, ''), 'ask'), COALESCE(NULLIF($7, ''), 'required'),
		       COALESCE($8::jsonb, '[]'::jsonb)
		WHERE $5::boolean
		RETURNING `+cnvProfileColumns,
		c.OrganizationID, strings.TrimSpace(name), launcherID, strings.TrimSpace(model), c.IsOrgAdmin,
		permissionMode, sandboxEnforcement, jsonTextOrNil(collectionsJSON)), &p)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, ErrProfileForbidden
	}
	if m4UniqueViolation(err) {
		// UNIQUE (organization_id, name): the name is taken, not the caller.
		return CnvProfile{}, ErrProfileConflict
	}
	if pgConflictCode(err, "23514") {
		// Three authors can refuse a profile row with 23514: the profile's own
		// column CHECKs, migration 00033's attachment-shape CHECK, and its
		// attachment-scope trigger. To the caller they are the same refusal.
		if collections != nil {
			return CnvProfile{}, profileRefused(CollectionCodeRevisionInvalid,
				"the apm collection attachments were refused: every attachment must name a published revision of one of your organization's collections, attached once (ADR-0084).")
		}
		return CnvProfile{}, profileRefused(ProfileCodeLauncherInvalid,
			"name and launcher_id were refused by the profile's own column constraints.")
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: insert agent profile: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()

	// ADR-0058: the create lands version 1, frozen as the first entry of the
	// history (the backfill migration 00014 did the same for pre-versioning
	// rows), and the token on the row is 1.
	var snapshot []byte
	snap := AgentProfileSnapshot{
		Name:              p.Name,
		LauncherID:        p.LauncherID,
		PermissionMode:    p.PermissionMode,
		Model:             apmAnyToPtr(p.Model),
		APMCollectionPins: p.APMCollectionPins,
	}
	snapshot, err = snap.Marshal()
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: encode agent profile version snapshot: %w", err)
	}
	// The version row records the mode in its snapshot like any other write; when
	// the mode is the operator-declared one, the note says WHY, so a reader of
	// the history can tell "an admin chose autonomous_within_sandbox for a
	// never-asks launcher" from a row that arrived through the seed/SQL route.
	var versionNote *string
	if mode != ProfileModeAsk {
		note := fmt.Sprintf(
			"created with permission_mode %q and sandbox_enforcement %q: the server resolved both from the launcher registry, never from the request body (ADR-0069 amendment 2026-11-11)",
			mode, enforcement)
		versionNote = &note
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_profile_versions
			(profile_id, organization_id, version, snapshot, created_by, created_at, note)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, now(), $6)`,
		p.ID, p.OrganizationID, p.Version, snapshot, c.UserID, versionNote); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: append agent profile version %d: %w", p.Version, err)
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentProfileCreated,
		OrganizationID: p.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentProfileCreatedPayload{
			ProfileID:      p.ID,
			Name:           p.Name,
			LauncherID:     p.LauncherID,
			Version:        p.Version,
			PermissionMode: p.PermissionMode,
			APMCollections: collectionPinPayloads(p.APMCollectionPins),
		},
	}); err != nil {
		return CnvProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: commit create agent profile: %w", err)
	}
	return p, nil
}

// PatchAgentProfileAPM writes the APM triple and the model pin — and only
// those. It never
// touches permission_mode, the launcher, or any other axis: those are separate
// decisions with separate evidence, and a route that could quietly move the
// sandbox axis while "attaching a skills package" would be the easy way to widen
// an agent's grant set without anyone reading a diff.
//
// The write lands on the version the caller saw (the row's current version,
// ADR-0058's optimistic-concurrency token): a write whose expectedVersion is
// stale answers ErrProfileVersionConflict and lands nothing, and a write that
// lands bumps the token and appends its version row in the same transaction.
//
// A nil pointer means "this write does not carry the column", and checkAPMPin
// refuses any partial triple, so the two legal calls are all three values and
// all three nil-or-empty (the clear). Model (ADR-0068) follows the same
// nil-means-absent rule with a twist: absent leaves the current pin alone,
// "" clears it, a value sets it — the model is a single column, not a triple.
func (s *CnvStore) PatchAgentProfileAPM(ctx context.Context, c Caller, profileID string, ref, target, digest *string, expectedVersion *int, model *string) (CnvProfile, error) {
	return s.PatchAgentProfileAPMPinned(ctx, c, profileID, ref, target, digest, expectedVersion, model, nil)
}

// PatchAgentProfileAPMPinned is the profile write with ADR-0084's attachment
// list. `collections` follows the SAME absent-means-nothing rule as the rest of
// the body: nil leaves the stored list alone, a non-nil slice (including an
// empty one, which is the clear) replaces it.
//
// Two rules make the list safe to write beside the triple:
//
//   - every entry must name a PUBLISHED revision of one of this organization's
//     collections (checkProfileAPMCollections). A draft is somebody's unfinished
//     edit; staging one in front of an agent is what the lock flow exists to
//     prevent.
//   - CHANGING the list clears apm_lock_digest, exactly as changing the ref does
//     (ADR-0054). The digest is sha256 of the lock for ONE dependency list; the
//     moment the list moves, the recorded digest describes a context this profile
//     no longer resolves, and keeping it would either launch unverified content
//     or trip the gate with a message that blames somebody else. A write that
//     carries a digest beside a changed list gets the digest dropped, not stored:
//     the clearing is the server's rule, not a client courtesy.
func (s *CnvStore) PatchAgentProfileAPMPinned(ctx context.Context, c Caller, profileID string, ref, target, digest *string, expectedVersion *int, model *string, collections *[]APMCollectionPin) (CnvProfile, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvProfile{}, err
	}
	// The precondition read moves ahead of the pin rule, because the rule is about
	// the resulting row: an absent attachment list means "keep the stored one", and
	// only the row knows what that is.
	p0, err := cnvProfileRow(ctx, s.Pool, profileID, c.OrganizationID)
	if err != nil {
		return CnvProfile{}, err
	}
	// The pin rule reads the RESULTING row, not the body: an absent member keeps
	// the stored value, and since ADR-0084 a collection list is packaged context
	// whether or not the body also names a ref. Checking the body's raw pointers
	// instead would refuse a list-only write against a profile that already carries
	// a ref and a target — which is the ordinary way to edit a bundle list.
	pinnedAfter := p0.APMCollectionPins
	if collections != nil {
		pinnedAfter = *collections
	}
	eff := func(cur string, carried *string) *string {
		if carried != nil {
			return carried
		}
		keep := cur
		return &keep
	}
	effRef, effTarget, effDigest := eff(p0.APMPackageRef, ref), eff(p0.APMTarget, target), eff(p0.APMLockDigest, digest)
	if collections != nil && !EqualAPMCollectionPins(*collections, p0.APMCollectionPins) {
		// The same clearing rule the write below applies, evaluated before it: the
		// digest a moved list leaves behind is not part of the shape question.
		empty := ""
		effDigest = &empty
	}
	// The pre-ADR-0084 half-pin rule survives the widening: a body that arrives
	// with a DIGEST and no pin member of its own is not recording a lock, it is
	// guessing one. Whether the row already had a ref is beside the point — the
	// digest an operator recorded arrives with the set it describes.
	if digest != nil && *digest != "" && ref == nil && target == nil && collections == nil {
		return CnvProfile{}, profileRefused(ProfileCodeAPMIncomplete,
			"a digest arrives with the pin it locks (the ref, the target, or an attached collection); a digest on its own is a partial pin.")
	}
	if err := checkAPMPin(effRef, effTarget, effDigest, pinnedAfter); err != nil {
		return CnvProfile{}, err
	}
	if collections != nil {
		if _, err := ValidateAPMCollectionPins(*collections); err != nil {
			return CnvProfile{}, err
		}
	}
	if model != nil && len(*model) > 200 {
		return CnvProfile{}, profileRefused(ProfileCodeModelInvalid, "model must be at most 200 characters.")
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
	p, err := cnvProfileRow(ctx, tx, profileID, c.OrganizationID)
	if err != nil {
		return CnvProfile{}, err
	}
	if !c.IsOrgAdmin {
		return CnvProfile{}, ErrProfileForbidden
	}

	// ADR-0058 optimistic concurrency: the expected version is the token the
	// caller last saw; a write carrying a version the row no longer has refuses
	// with ErrProfileVersionConflict instead of overwriting the winner's version.
	if expectedVersion != nil && *expectedVersion != p.Version {
		return CnvProfile{}, ErrProfileVersionConflict
	}

	null := func(v *string) any {
		if v == nil || *v == "" {
			return nil
		}
		return *v
	}
	// A model-only write (ADR-0068: the body carries `model` and none of the
	// triple) moves the model column and NOTHING else. The old contract — all
	// three triple members absent is the clear — stands for every other body,
	// including `{}` and `{"version":n}`; this arm exists so setting a display
	// model cannot silently stage down a locked profile. An attachment write is
	// APM state too, so a body that carries one is never "model-only".
	apmCarried := ref != nil || target != nil || digest != nil || collections != nil || model == nil
	switch {
	case ref == nil && target == nil && digest == nil && collections != nil:
		// A body that carries ONLY the attachment list is not a statement about the
		// triple: an operator editing which bundles a profile attaches did not say
		// "and forget the extra package ref, the target and the lock too". The
		// triple stays as the row has it, and the digest question below is decided
		// by the list alone.
		pkg, targ, dig := p.APMPackageRef, p.APMTarget, p.APMLockDigest
		ref, target, digest = &pkg, &targ, &dig
	case !apmCarried:
		ref, target, digest = nil, nil, nil
		pkg, targ, dig := p.APMPackageRef, p.APMTarget, p.APMLockDigest
		ref, target, digest = &pkg, &targ, &dig
	}
	// The attachment list's own arm: validate what the body carried against the
	// collections, then ask the question that decides the digest.
	var collectionsJSON []byte
	collectionsChanged := false
	if collections != nil {
		if err := checkProfileAPMCollections(ctx, tx, c.OrganizationID, *collections); err != nil {
			return CnvProfile{}, err
		}
		raw, verr := ValidateAPMCollectionPins(*collections)
		if verr != nil {
			return CnvProfile{}, verr
		}
		collectionsJSON = raw
		collectionsChanged = !EqualAPMCollectionPins(*collections, p.APMCollectionPins)
		if collectionsChanged {
			// The digest dies with the list it described (see the method doc).
			digest = nil
		}
	}
	// The write's own WHERE carries the library-role predicate and the version
	// CAS token: the write refuses rather than trusting the caller to have
	// checked, because every other writer in this package is a future caller too.
	//
	// apm_contents_summary rides the same write as apm_lock_digest: a pin that is
	// unlocked or cleared leaves both null, so a digest (and the names-only
	// contents summary that came with it) can never survive a ref/target change.
	carryTriple := apmCarried
	err = scanCnvProfileColumnsWithContents(tx.QueryRow(ctx, `
		UPDATE agent_profiles
		SET apm_package_ref = $1, apm_target = $2, apm_lock_digest = $3,
		    apm_contents_summary = CASE WHEN $10::boolean THEN $4 ELSE apm_contents_summary END,
		    model = CASE WHEN $8::boolean THEN NULLIF($9, '') ELSE model END,
		    apm_collections = CASE WHEN $11::boolean THEN $12::jsonb ELSE apm_collections END,
		    version = version + 1
		WHERE id = $5::uuid AND organization_id = $6::uuid AND version = $7::int
		RETURNING `+cnvProfileColumns+", apm_contents_summary",
		null(ref), null(target), null(digest), nil,
		profileID, c.OrganizationID, p.Version,
		model != nil, modelOrEmpty(model), carryTriple,
		collections != nil, jsonTextOrNil(collectionsJSON)), &p)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, ErrProfileForbidden
	}
	if pgConflictCode(err, "23514") {
		// A CHECK violation means the validation above and the column's own rule
		// disagreed — still a 422 naming the field, never a 500.
		if collections != nil {
			return CnvProfile{}, profileRefused(CollectionCodeRevisionInvalid,
				"the apm collection attachments were refused by the profile's own constraints: every attachment must name a published revision of one of your organization's collections, attached once (ADR-0084).")
		}
		return CnvProfile{}, profileRefused(ProfileCodeAPMDigestInvalid,
			"the APM triple was refused by the profile's own column constraints.")
	}
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: patch agent profile apm: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()

	// ADR-0058: the patch lands a version — the bumped token and its history row
	// ride the same transaction as the UPDATE and the event below. The snapshot is
	// the profile's whole launch descriptor at the new version (the fields the
	// patch did not move are the row's own current ones, already read back via
	// RETURNING), so a version records state, never a delta. The attachment list is
	// part of that state for the same reason the ref is: a version a conversation
	// pinned must resolve to ONE dependency set, not to whatever the collections
	// had become when somebody read the version back.
	snap := AgentProfileSnapshot{
		Name:              p.Name,
		LauncherID:        p.LauncherID,
		PermissionMode:    p.PermissionMode,
		APMPackageRef:     apmAnyToPtr(p.APMPackageRef),
		APMTarget:         apmAnyToPtr(p.APMTarget),
		APMLockDigest:     apmAnyToPtr(p.APMLockDigest),
		Model:             apmAnyToPtr(p.Model),
		APMCollectionPins: p.APMCollectionPins,
	}
	snapshot, err := snap.Marshal()
	if err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: encode agent profile version snapshot: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_profile_versions
			(profile_id, organization_id, version, snapshot, created_by, created_at, note)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, now(), $6)`,
		p.ID, c.OrganizationID, p.Version, snapshot, c.UserID, nil); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: append agent profile version %d: %w", p.Version, err)
	}

	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentProfileUpdated,
		OrganizationID: p.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentProfileUpdatedPayload{
			ProfileID:     p.ID,
			Version:       p.Version,
			APMPackageRef: p.APMPackageRef,
			APMTarget:     p.APMTarget,
			APMLockDigest: p.APMLockDigest,
			// The pin is cleared when THIS write carried the triple and left
			// nothing set — recorded so a reader can tell "this profile now
			// stages nothing" from "the digest moved". A model-only write
			// (ADR-0068) never claims a clear it did not perform. With
			// ADR-0084 the list counts too: a profile that still attaches a
			// collection stages something, whatever its ref column says.
			APMPinCleared:  carryTriple && p.APMPackageRef == "" && len(p.APMCollectionPins) == 0,
			Model:          apmAnyToPtr(p.Model),
			APMCollections: collectionPinPayloads(p.APMCollectionPins),
		},
	}); err != nil {
		return CnvProfile{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CnvProfile{}, fmt.Errorf("postgres: commit patch agent profile: %w", err)
	}
	return p, nil
}

// modelOrEmpty renders the carried model pin for the CASE arm above: the
// "carried" flag decides whether the column moves at all, so this only has to
// keep NULLIF(”,”)-able text out of the nil case.
func modelOrEmpty(m *string) string {
	if m == nil {
		return ""
	}
	return *m
}

// jsonTextOrNil hands a jsonb parameter to pgx as JSON TEXT (which pgx encodes
// into the jsonb parameter) or as a genuine SQL NULL — an empty byte slice would
// arrive as the jsonb value "" , which is not nothing, it is a parse error.
func jsonTextOrNil(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

// pgConflictCode reports a SQLSTATE anywhere in err's chain. The database's own
// CHECK/unique constraints are the backstop below the validations above: a
// violation is still a refused request, never a 500 that echoes a constraint
// name.
func pgConflictCode(err error, code string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == code
}
