package postgres

// ADR-0058 (versioned agent profiles, part 1): the append-only version history
// behind GET /api/v1/agent-profiles/{profileId}/versions and
// GET /api/v1/agent-profiles/{profileId}/versions/{n}, plus the write-side
// helper that lands one version of a profile in a caller's transaction.
//
// The version token lives on the agent_profiles row itself (migration 00014:
// version int NOT NULL DEFAULT 1, the current version = optimistic-concurrency
// token, amended ADR-0030:62) and the history lives in agent_profile_versions
// (UNIQUE (profile_id, version), one row per version, the snapshot frozen at
// that version, the writer and the note). A write that carries a version the
// row no longer has refuses with ErrProfileVersionConflict instead of
// overwriting somebody else's work; the successful write bumps the token and
// appends the history row in the SAME transaction as the state change, so the
// journal and the history can never disagree.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrAgentProfileVersionNotFound answers a version read that named no such
// version of one profile. The profile itself would have answered not-found
// first (cross-organization profiles are invisible, ADR-0014 §3); this is the
// second arm for "the profile exists and is visible and this version does not".
var ErrAgentProfileVersionNotFound = errors.New("postgres: agent profile version not found")

// AgentProfileVersion is one entry of a profile's version history (ADR-0058):
// the version number, the frozen launch-descriptor snapshot, the writer, the
// optional note and the timestamp. Snapshot is the JSON shape of
// AgentProfileSnapshot — a version is a state, never a delta, because the
// question the history answers is "what did this profile look like when it was
// version n?" and a reader must not have to replay.
type AgentProfileVersion struct {
	ID             string
	ProfileID      string
	OrganizationID string
	Version        int
	Snapshot       []byte
	CreatedBy      string
	CreatedAt      time.Time
	Note           *string
}

// AgentProfileSnapshot is the JSON shape of agent_profile_versions.snapshot.
// It is the profile's launch-descriptor state at one version: the display name,
// the launcher it drove, the permission mode and the APM coordinates — all of
// which are identifiers or references, never secret values (the secret *values*
// live in secret_versions, envelope-encrypted; a profile only ever names the
// secret it may use, which is what the snapshot must never carry).
type AgentProfileSnapshot struct {
	Name           string  `json:"name"`
	LauncherID     string  `json:"launcher_id"`
	PermissionMode string  `json:"permission_mode"`
	APMPackageRef  *string `json:"apm_package_ref"`
	APMTarget      *string `json:"apm_target"`
	APMLockDigest  *string `json:"apm_lock_digest"`
}

// Marshal encodes a snapshot into the JSONB column's bytes.
func (s AgentProfileSnapshot) Marshal() ([]byte, error) {
	return json.Marshal(s)
}

// Write is one profile state transition under ADR-0058: the whole launch
// descriptor the new version freezes, the expected version token (the CAS loser
// answers ErrProfileVersionConflict rather than overwriting), and the audit
// fields.
type AgentProfileWrite struct {
	State           AgentProfileSnapshot
	ExpectedVersion *int
	CreatedBy       string
	Note            *string
}

// CommitAgentProfileWrite lands one version of one profile inside the caller's
// transaction: it reads the profile's current version, refuses a stale expected
// token, writes the state, bumps agent_profiles.version to the new version and
// appends the version row — state and history in ONE transaction (ADR-0013), so
// after the commit the token and the history can never disagree.
//
// The returned version is the one that was written; the caller decides whether
// it is a create's version 1, a patch's bumped version or a restore's re-write of
// an older snapshot (a restore is just a new write whose snapshot equals the
// version it restores — history is append-only, so it gains a new row).
func CommitAgentProfileWrite(ctx context.Context, q prjQuerier, profileID, orgID string, w AgentProfileWrite) (CnvProfile, int, error) {
	var p CnvProfile
	err := q.QueryRow(ctx, `
		SELECT id::text, organization_id::text, name, launcher_id, permission_mode, created_at, version,
		       COALESCE(apm_package_ref, ''), COALESCE(apm_target, ''), COALESCE(apm_lock_digest, '')
		FROM agent_profiles
		WHERE id = $1::uuid AND organization_id = $2::uuid`, profileID, orgID).
		Scan(&p.ID, &p.OrganizationID, &p.Name, &p.LauncherID, &p.PermissionMode, &p.CreatedAt, &p.Version,
			&p.APMPackageRef, &p.APMTarget, &p.APMLockDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return CnvProfile{}, 0, ErrProfileNotFound
	}
	if err != nil {
		return CnvProfile{}, 0, fmt.Errorf("postgres: read agent profile for version write: %w", err)
	}
	p.CreatedAt = p.CreatedAt.UTC()

	if w.ExpectedVersion != nil && *w.ExpectedVersion != p.Version {
		return CnvProfile{}, 0, ErrProfileVersionConflict
	}
	newVersion := p.Version + 1
	snapshot, err := w.State.Marshal()
	if err != nil {
		return CnvProfile{}, 0, fmt.Errorf("postgres: encode agent profile version snapshot: %w", err)
	}
	if _, err := q.Exec(ctx, `
		UPDATE agent_profiles
		SET version = $1, name = $2, launcher_id = $3, permission_mode = $4,
		    apm_package_ref = $5, apm_target = $6, apm_lock_digest = $7
		WHERE id = $8::uuid AND organization_id = $9::uuid AND version = $10::int`,
		newVersion, w.State.Name, w.State.LauncherID, w.State.PermissionMode,
		apmNullToAny(w.State.APMPackageRef), apmNullToAny(w.State.APMTarget), apmNullToAny(w.State.APMLockDigest),
		profileID, orgID, p.Version); err != nil {
		return CnvProfile{}, 0, fmt.Errorf("postgres: write agent profile version %d: %w", newVersion, err)
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO agent_profile_versions
			(profile_id, organization_id, version, snapshot, created_by, created_at, note)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, now(), $6)`,
		profileID, orgID, newVersion, snapshot, w.CreatedBy, w.Note); err != nil {
		return CnvProfile{}, 0, fmt.Errorf("postgres: append agent profile version %d: %w", newVersion, err)
	}
	p.Version = newVersion
	p.Name = w.State.Name
	p.LauncherID = w.State.LauncherID
	p.PermissionMode = w.State.PermissionMode
	p.APMPackageRef = apmAnyToStr(w.State.APMPackageRef)
	p.APMTarget = apmAnyToStr(w.State.APMTarget)
	p.APMLockDigest = apmAnyToStr(w.State.APMLockDigest)
	return p, newVersion, nil
}

// apmNullToAny converts a nullable APm coordinate into the ""-means-NULL
// encoding the agent_profiles columns use, or nil for JSON null.
func apmNullToAny(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

// apmAnyToStr converts a ""-means-NULL coordinate back into the nullable twin.
func apmAnyToStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// apmAnyToPtr converts a ""-means-NULL coordinate into the nullable twin.
func apmAnyToPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ListAgentProfileVersions answers GET /api/v1/agent-profiles/{profileId}/versions:
// every version of one profile, oldest first, for the app-shell's version
// history panel. Visible to any member of the owning organization (the listing
// is not a write), invisible to everybody else (cross-organization → not-found).
func (s *CnvStore) ListAgentProfileVersions(ctx context.Context, c Caller, profileID string) ([]AgentProfileVersion, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if !prjValidUUID(profileID) {
		return nil, ErrProfileNotFound
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT v.id::text, v.profile_id::text, v.organization_id::text, v.version,
		       v.snapshot, v.created_by, v.created_at, v.note
		FROM agent_profile_versions v
		WHERE v.profile_id = $1::uuid AND v.organization_id = $2::uuid
		ORDER BY v.version ASC`, profileID, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list agent profile versions: %w", err)
	}
	defer rows.Close()
	var out []AgentProfileVersion
	for rows.Next() {
		var v AgentProfileVersion
		var snapshot []byte
		if err := rows.Scan(&v.ID, &v.ProfileID, &v.OrganizationID, &v.Version,
			&snapshot, &v.CreatedBy, &v.CreatedAt, &v.Note); err != nil {
			return nil, fmt.Errorf("postgres: scan agent profile version: %w", err)
		}
		v.Snapshot = snapshot
		v.CreatedAt = v.CreatedAt.UTC()
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read agent profile versions: %w", err)
	}
	return out, nil
}

// GetAgentProfileVersion answers GET /api/v1/agent-profiles/{profileId}/versions/{version}:
// one frozen version of one profile. The version is a key into the history, not
// a mutable row; a version that no profile carried answers not-found.
func (s *CnvStore) GetAgentProfileVersion(ctx context.Context, c Caller, profileID string, version int) (AgentProfileVersion, error) {
	if err := prjRequireCaller(c); err != nil {
		return AgentProfileVersion{}, err
	}
	if !prjValidUUID(profileID) || version < 1 {
		return AgentProfileVersion{}, ErrAgentProfileVersionNotFound
	}
	var v AgentProfileVersion
	var snapshot []byte
	err := s.Pool.QueryRow(ctx, `
		SELECT v.id::text, v.profile_id::text, v.organization_id::text, v.version,
		       v.snapshot, v.created_by, v.created_at, v.note
		FROM agent_profile_versions v
		WHERE v.profile_id = $1::uuid AND v.organization_id = $2::uuid AND v.version = $3::int`,
		profileID, c.OrganizationID, version).
		Scan(&v.ID, &v.ProfileID, &v.OrganizationID, &v.Version, &snapshot, &v.CreatedBy, &v.CreatedAt, &v.Note)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AgentProfileVersion{}, ErrAgentProfileVersionNotFound
		}
		return AgentProfileVersion{}, fmt.Errorf("postgres: get agent profile version: %w", err)
	}
	v.Snapshot = snapshot
	v.CreatedAt = v.CreatedAt.UTC()
	return v, nil
}

// RestoreAgentProfileVersion is the write behind POST
// /api/v1/agent-profiles/{profileId}/versions/{version}/restore (ADR-0058):
// "restore version n" is a new write whose snapshot equals version n's snapshot
// and lands as the profile's next version — history is append-only, so the
// restore gains a version rather than rewriting one, and the version it restored
// from stays readable as the state the new version froze.
//
// The restore carries the caller's current optimistic token (the same CAS the
// patch path applies, ADR-0058): it reads the version's snapshot, asks to write
// it under the token the profile row currently holds, and CommitAgentProfileWrite
// refuses with ErrProfileVersionConflict when a concurrent write moved the token
// in between — the client then re-reads the history instead of retrying blind.
func (s *CnvStore) RestoreAgentProfileVersion(ctx context.Context, c Caller, profileID string, version int) (CnvProfile, int, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvProfile{}, 0, err
	}
	if !prjValidUUID(profileID) || version < 1 {
		return CnvProfile{}, 0, ErrAgentProfileVersionNotFound
	}
	var v AgentProfileVersion
	var snapshot []byte
	err := s.Pool.QueryRow(ctx, `
		SELECT v.id::text, v.profile_id::text, v.organization_id::text, v.version,
		       v.snapshot, v.created_by, v.created_at, v.note
		FROM agent_profile_versions v
		WHERE v.profile_id = $1::uuid AND v.organization_id = $2::uuid AND v.version = $3::int`,
		profileID, c.OrganizationID, version).
		Scan(&v.ID, &v.ProfileID, &v.OrganizationID, &v.Version, &snapshot, &v.CreatedBy, &v.CreatedAt, &v.Note)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CnvProfile{}, 0, ErrAgentProfileVersionNotFound
		}
		return CnvProfile{}, 0, fmt.Errorf("postgres: get agent profile version for restore: %w", err)
	}
	var state AgentProfileSnapshot
	if err := json.Unmarshal(snapshot, &state); err != nil {
		return CnvProfile{}, 0, fmt.Errorf("postgres: decode agent profile version snapshot: %w", err)
	}
	var current CnvProfile
	if err := s.Pool.QueryRow(ctx, `
		SELECT version FROM agent_profiles
		WHERE id = $1::uuid AND organization_id = $2::uuid`, profileID, c.OrganizationID).Scan(&current.Version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CnvProfile{}, 0, ErrProfileNotFound
		}
		return CnvProfile{}, 0, fmt.Errorf("postgres: read agent profile version for restore: %w", err)
	}
	p, newVersion, err := CommitAgentProfileWrite(ctx, s.Pool, profileID, c.OrganizationID, AgentProfileWrite{
		State:           state,
		ExpectedVersion: &current.Version,
		CreatedBy:       c.UserID,
		Note:            nil,
	})
	if err != nil {
		return CnvProfile{}, 0, err
	}
	return p, newVersion, nil
}
