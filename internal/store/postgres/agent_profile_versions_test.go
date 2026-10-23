package postgres

// ADR-0058 versioned agent profiles, part 1: the append-only version history
// behind GET /api/v1/agent-profiles/{profileId}/versions and the write paths
// that land a version in the same transaction as the state change.
//
// What is NOT here is not tested — a UNIQUE that only one database can enforce,
// an append that must be invisible on rollback, and the CAS loser — those are the
// database's own answers and the store-level tests below pin the contract around
// them.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// versionHistory reads one profile's version history, oldest first.
func (f *profWFixture) versionHistory(ctx context.Context, profileID string) []AgentProfileVersion {
	rows, err := f.pool.Query(ctx, `
		SELECT v.id::text, v.profile_id::text, v.organization_id::text, v.version,
		       v.snapshot, v.created_by, v.created_at, v.note
		FROM agent_profile_versions v
		WHERE v.profile_id = $1::uuid AND v.organization_id = $2::uuid
		ORDER BY v.version ASC`, profileID, f.orgID)
	if err != nil {
		f.t.Fatalf("read agent profile versions: %v", err)
	}
	defer rows.Close()
	var out []AgentProfileVersion
	for rows.Next() {
		var v AgentProfileVersion
		var snapshot []byte
		if err := rows.Scan(&v.ID, &v.ProfileID, &v.OrganizationID, &v.Version, &snapshot, &v.CreatedBy, &v.CreatedAt, &v.Note); err != nil {
			f.t.Fatalf("scan agent profile version: %v", err)
		}
		v.Snapshot = snapshot
		v.CreatedAt = v.CreatedAt.UTC()
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		f.t.Fatalf("read agent profile versions: %v", err)
	}
	return out
}

// ip names an int pointer for the version token the writes carry.
func ip(i int) *int { return &i }

func TestAgentProfileVersionHistoryAppendsPerWrite(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	profile, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("hist"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	if profile.Version != 1 {
		t.Fatalf("created profile version = %d, want 1", profile.Version)
	}
	versions := f.versionHistory(ctx, profile.ID)
	if len(versions) != 1 {
		t.Fatalf("version history after create = %d, want 1", len(versions))
	}
	if versions[0].Version != 1 || versions[0].ProfileID != profile.ID {
		t.Errorf("history[0] = version %d of %s, want version 1 of %s", versions[0].Version, versions[0].ProfileID, profile.ID)
	}
	if versions[0].Note != nil {
		t.Errorf("create version note = %v, want nil", versions[0].Note)
	}
	snapshot := map[string]any{}
	if err := json.Unmarshal(versions[0].Snapshot, &snapshot); err != nil {
		t.Fatalf("decode create snapshot: %v", err)
	}
	if snapshot["name"] != profile.Name || snapshot["launcher_id"] != "claude" || snapshot["permission_mode"] != "ask" {
		t.Errorf("create snapshot = %v, want the launch descriptor", snapshot)
	}

	// The APM pin lands: exactly one more version (the pin), token bumped to 2.
	digest := "sha256:" + strings.Repeat("a", 64)
	pinned, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
		APMTarget:     ptr("claude"),
		APMLockDigest: ptr(digest),
	})
	if err != nil {
		t.Fatalf("PatchAgentProfileAPM: %v", err)
	}
	if pinned.Version != 2 {
		t.Fatalf("pinned profile version = %d, want 2", pinned.Version)
	}
	versions = f.versionHistory(ctx, profile.ID)
	if len(versions) != 2 {
		t.Fatalf("version history after pin = %d, want 2", len(versions))
	}
	if versions[1].Version != 2 {
		t.Errorf("history[1].version = %d, want 2 (the pin)", versions[1].Version)
	}

	// A second pin under token 2 lands version 3; a write under a stale token
	// (1) refuses and lands nothing.
	second, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
		APMTarget:     ptr("claude"),
		APMLockDigest: ptr("sha256:" + strings.Repeat("b", 64)),
		Version:       ip(2),
	})
	if err != nil {
		t.Fatalf("second patch: %v", err)
	}
	if second.Version != 3 {
		t.Fatalf("second-patched profile version = %d, want 3", second.Version)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
		APMTarget:     ptr("claude"),
		APMLockDigest: ptr("sha256:" + strings.Repeat("c", 64)),
		Version:       ip(1),
	}); !errors.Is(err, ErrProfileVersionConflict) {
		t.Fatalf("stale-version patch err = %v, want ErrProfileVersionConflict", err)
	}
	versions = f.versionHistory(ctx, profile.ID)
	if len(versions) != 3 {
		t.Fatalf("version history after the refused patch = %d, want 3 (nothing landed)", len(versions))
	}
}

// TestAgentProfileVersionRestore writes version n's snapshot as a new version:
// the restore is a new write whose snapshot equals version n's, and history is
// append-only, so the restored state is readable again as a NEW version.
func TestAgentProfileVersionRestore(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	profile, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("restore"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
		APMTarget:     ptr("claude"),
		APMLockDigest: ptr(digest),
	}); err != nil {
		t.Fatalf("PatchAgentProfileAPM: %v", err)
	}
	restored, newVersion, err := f.api.RestoreAgentProfileVersion(ctx, f.caller(f.alice, true), profile.ID, 1)
	if err != nil {
		t.Fatalf("RestoreAgentProfileVersion: %v", err)
	}
	if newVersion != 3 {
		t.Fatalf("restore landed version %d, want 3 (create v1 + pin v2 + restore v3)", newVersion)
	}
	if restored.Version != 3 {
		t.Fatalf("restored view version = %d, want 3", restored.Version)
	}
	v3, err := f.api.GetAgentProfileVersion(ctx, f.caller(f.bob, false), profile.ID, 3)
	if err != nil {
		t.Fatalf("GetAgentProfileVersion(3): %v", err)
	}
	snapshot := map[string]any{}
	if err := json.Unmarshal(v3.Snapshot, &snapshot); err != nil {
		t.Fatalf("decode restored snapshot: %v", err)
	}
	if snapshot["name"] != profile.Name {
		t.Errorf("restored snapshot = %v, want the restored-to state (version %d)", snapshot, 1)
	}
	// History is append-only: version 1 still answers, unchanged.
	v1, err := f.api.GetAgentProfileVersion(ctx, f.caller(f.bob, false), profile.ID, 1)
	if err != nil {
		t.Fatalf("GetAgentProfileVersion(1): %v", err)
	}
	snapshot1 := map[string]any{}
	if err := json.Unmarshal(v1.Snapshot, &snapshot1); err != nil {
		t.Fatalf("decode v1 snapshot: %v", err)
	}
	if snapshot1["name"] != profile.Name {
		t.Errorf("v1 snapshot = %v, want the original create state", snapshot1)
	}
}

// TestAgentProfileVersionCrossOrgInvisible proves the history answers not-found
// for a profile the caller cannot see at all (ADR-0014 §3), not just for versions
// that were never written.
func TestAgentProfileVersionCrossOrgInvisible(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	other, err := f.store.CreateAgentProfile(ctx, Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true},
		f.profWName("cross"), "claude")
	if err != nil {
		t.Fatalf("CreateAgentProfile in the other organization: %v", err)
	}
	versions, err := f.store.ListAgentProfileVersions(ctx, Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}, other.ID)
	if err != nil {
		t.Fatalf("ListAgentProfileVersions: %v", err)
	}
	if len(versions) != 0 {
		t.Errorf("other organization's history = %v, want none", versions)
	}
	if _, err := f.store.GetAgentProfileVersion(ctx, Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}, other.ID, 1); !errors.Is(err, ErrAgentProfileVersionNotFound) {
		t.Errorf("cross-org GetAgentProfileVersion err = %v, want ErrAgentProfileVersionNotFound", err)
	}
	if _, _, err := f.store.RestoreAgentProfileVersion(ctx, Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}, other.ID, 1); !errors.Is(err, ErrAgentProfileVersionNotFound) {
		t.Errorf("cross-org restore err = %v, want ErrAgentProfileVersionNotFound", err)
	}
	if _, err := f.store.GetAgentProfileVersion(ctx, Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true}, other.ID, 1); err != nil {
		t.Errorf("the owning organization must still read its own version: %v", err)
	}
	// The fixture's own cleanup covers the owning organization; this profile
	// lives in the other one, so drop it here.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(ctx, `DELETE FROM agent_profile_versions WHERE profile_id = $1::uuid`, other.ID); err != nil {
			t.Errorf("cross-org version cleanup: %v", err)
		}
		if _, err := f.pool.Exec(ctx, `DELETE FROM agent_profiles WHERE id = $1::uuid`, other.ID); err != nil {
			t.Errorf("cross-org profile cleanup: %v", err)
		}
	})
}
