package postgres

// ADR-0030 against a real PostgreSQL: the writes, the all-or-nothing APM triple,
// the library role, and the journal rows that must ride the same commit. What is
// NOT here is not tested — a CHECK that only fires in Postgres, a UNIQUE that
// only one database can enforce, and an append that must be invisible on rollback.
//
// The API adapter is the subject, not the raw CnvStore: it is the layer the
// handler talks to, and the coded 422s it hands back are the answer a browser
// sees.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// profWFixture is cnvSetup plus the deletes an agent-profile fixture needs (the
// rows it creates are org-scoped, so the conversation cleanup does not reach them).
type profWFixture struct {
	*cnvFixture
	api api.ProfileStore
	// token names every row this fixture makes, so two runs of the suite against
	// the shared lab database cannot decide each other's outcome.
	token string
}

func profWSetup(t *testing.T) *profWFixture {
	t.Helper()
	f := &profWFixture{cnvFixture: cnvSetup(t), token: migFixtureToken(t)}
	f.api = APIConversationStore{S: f.store}
	// The library role is a column, not a convention: ADR-0012's bootstrap is the
	// only other way to get one, and a fixture that just claimed IsOrgAdmin in the
	// Caller would test nothing about what the API actually asserts.
	if _, err := f.pool.Exec(testCtx(t),
		`UPDATE users SET is_org_admin = true WHERE id = $1::uuid`, f.alice); err != nil {
		t.Fatalf("grant library role: %v", err)
	}
	t.Cleanup(func() {
		ctx := testCtx(t)
		// By token, not by prefix: the lab database is shared and another run's
		// fixture is in it right now.
		profiles := `SELECT id::text FROM agent_profiles WHERE organization_id = $1::uuid AND name LIKE 'profw-' || $2 || '-%'`
		for _, q := range []string{
			`DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE payload->>'profile_id' IN (` + profiles + `))`,
			`DELETE FROM domain_events WHERE payload->>'profile_id' IN (` + profiles + `)`,
			`DELETE FROM agent_profiles WHERE organization_id = $1::uuid AND name LIKE 'profw-' || $2 || '-%'`,
		} {
			if _, err := f.pool.Exec(ctx, q, f.orgID, f.token); err != nil {
				t.Errorf("profile cleanup: %v", err)
			}
		}
	})
	return f
}

func (f *profWFixture) caller(user string, admin bool) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.orgID, IsOrgAdmin: admin}
}

// profWName gives each subtest its own name: the UNIQUE is (organization_id,
// name), so a fixed name would make two runs of the suite collide.
func (f *profWFixture) profWName(suffix string) string {
	return "profw-" + f.token + "-" + suffix
}

func ptr(s string) *string { return &s }

// profWCountEvents counts this profile's journal rows of one type. It reads the
// payload's profile_id rather than a scope column because an org-scoped row has
// project_id NULL by design (ADR-0030: profiles have no project).
func profWCountEvents(t *testing.T, f *profWFixture, ctx context.Context, typ, profileID string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events
		WHERE type = $1 AND organization_id = $2::uuid AND payload->>'profile_id' = $3`,
		typ, f.orgID, profileID).Scan(&n); err != nil {
		t.Fatalf("count %s events: %v", typ, err)
	}
	return n
}

// profWEventOrder returns the journal order of this profile's event types, which
// is the only way to prove the append rode the same transaction as the write.
func profWEventOrder(t *testing.T, f *profWFixture, ctx context.Context, profileID string) []string {
	t.Helper()
	rows, err := f.pool.Query(ctx, `
		SELECT type FROM domain_events
		WHERE organization_id = $1::uuid AND payload->>'profile_id' = $2
		ORDER BY global_seq`, f.orgID, profileID)
	if err != nil {
		t.Fatalf("read profile journal: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var typ string
		if err := rows.Scan(&typ); err != nil {
			t.Fatalf("scan event type: %v", err)
		}
		out = append(out, typ)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read profile journal: %v", err)
	}
	return out
}

func profWHasType(types []string, want string) bool {
	for _, t := range types {
		if t == want {
			return true
		}
	}
	return false
}

func profJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		return "<unmarshalable>"
	}
	return string(raw)
}

func TestAgentProfileCreateAndPatchAPMTriple(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	name := f.profWName("triple")

	// --- create: the row exists, permission_mode is 'ask', nothing is pinned.
	profile, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: name, LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	if profile.PermissionMode != "ask" {
		t.Errorf("permission_mode = %q, want ask (ADR-0009: no verified sandbox, no auto-approval)", profile.PermissionMode)
	}
	if profile.APMPackageRef != nil || profile.APMTarget != nil || profile.APMLockDigest != nil {
		t.Errorf("a new profile must stage nothing, got %s", profJSON(t, profile))
	}
	var mode string
	if err := f.pool.QueryRow(ctx,
		`SELECT permission_mode FROM agent_profiles WHERE id = $1::uuid`, profile.ID).Scan(&mode); err != nil {
		t.Fatalf("read back profile: %v", err)
	}
	if mode != "ask" {
		t.Errorf("column permission_mode = %q", mode)
	}
	// The journal row is part of the create, not a later projection of it.
	if n := profWCountEvents(t, f, ctx, events.TypeAgentProfileCreated, profile.ID); n != 1 {
		t.Errorf("agent.profile.created rows = %d, want 1", n)
	}
	if types := profWEventOrder(t, f, ctx, profile.ID); !profWHasType(types, events.TypeAgentProfileCreated) {
		t.Errorf("journal = %v, want the create row present", types)
	}
	// The create row carries no project: profiles are organization-scoped, and a
	// NULL project_id is what keeps them off every project's stream.
	var projectNull bool
	if err := f.pool.QueryRow(ctx, `
		SELECT project_id IS NULL FROM domain_events
		WHERE type = $1 AND payload->>'profile_id' = $2 LIMIT 1`,
		events.TypeAgentProfileCreated, profile.ID).Scan(&projectNull); err != nil {
		t.Fatalf("read create row scope: %v", err)
	}
	if !projectNull {
		t.Error("agent.profile.created carried a project_id")
	}

	// --- patch the full triple: the pin lands and the list view shows it.
	digest := "sha256:" + strings.Repeat("a", 64)
	patched, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID,
		api.AgentProfileAPMPatch{
			APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
			APMTarget:     ptr("claude"),
			APMLockDigest: ptr(digest),
		})
	if err != nil {
		t.Fatalf("PatchAgentProfileAPM: %v", err)
	}
	if patched.APMPackageRef == nil || *patched.APMPackageRef != "mattpocock/skills#v1.3.1" {
		t.Fatalf("patched view = %s", profJSON(t, patched))
	}
	items, err := f.api.ListAgentProfiles(ctx, f.caller(f.bob, false))
	if err != nil {
		t.Fatalf("ListAgentProfiles: %v", err)
	}
	var seen *api.AgentProfileView
	for i := range items {
		if items[i].ID == profile.ID {
			seen = &items[i]
		}
	}
	if seen == nil {
		t.Fatalf("created profile missing from the list")
	}
	if seen.APMPackageRef == nil || *seen.APMPackageRef != "mattpocock/skills#v1.3.1" ||
		seen.APMTarget == nil || *seen.APMTarget != "claude" ||
		seen.APMLockDigest == nil || *seen.APMLockDigest != digest {
		t.Errorf("list view does not expose the pin: %s", profJSON(t, *seen))
	}
	// --- clearing all three returns the profile to staging nothing.
	cleared, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID,
		api.AgentProfileAPMPatch{})
	if err != nil {
		t.Fatalf("clearing the triple: %v", err)
	}
	if cleared.APMPackageRef != nil || cleared.APMTarget != nil || cleared.APMLockDigest != nil {
		t.Errorf("cleared profile still pinned: %s", profJSON(t, cleared))
	}
	var nulls int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM agent_profiles
		WHERE id = $1::uuid AND apm_package_ref IS NULL AND apm_target IS NULL AND apm_lock_digest IS NULL`,
		profile.ID).Scan(&nulls); err != nil || nulls != 1 {
		t.Errorf("columns after clearing: found=%d err=%v, want the triple NULL", nulls, err)
	}
	if n := profWCountEvents(t, f, ctx, events.TypeAgentProfileUpdated, profile.ID); n != 2 {
		t.Errorf("agent.profile.updated rows = %d, want 2 (pin + clear)", n)
	}
	// The clearing row must say it cleared, or the journal cannot answer "what
	// was this profile pinned to?" without replaying history.
	var clearedFlag bool
	if err := f.pool.QueryRow(ctx, `
		SELECT payload->>'apm_pin_cleared' = 'true' FROM domain_events
		WHERE type = 'agent.profile.updated' AND payload->>'profile_id' = $1
		ORDER BY global_seq DESC LIMIT 1`, profile.ID).Scan(&clearedFlag); err != nil {
		t.Fatalf("read latest update payload: %v", err)
	}
	if !clearedFlag {
		t.Error("the clearing agent.profile.updated row does not record apm_pin_cleared")
	}
}

// TestAgentProfileAPMRefusals proves the three refusals ADR-0030 exists for
// happen in the database layer, not only in a handler: a partial triple, a
// malformed digest, and a caller without the library role. A caller that skipped
// the HTTP layer (a future CLI, a future worker-side write) must not be able to
// land a half pin either.
func TestAgentProfileAPMRefusals(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("refusals"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	digest := "sha256:" + strings.Repeat("d", 64)

	t.Run("partial triple", func(t *testing.T) {
		for _, in := range []api.AgentProfileAPMPatch{
			{APMPackageRef: ptr("mattpocock/skills#v1.3.1")},
			{APMTarget: ptr("claude"), APMLockDigest: ptr(digest)},
			{APMLockDigest: ptr(digest)},
		} {
			err := func() error {
				_, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, in)
				return err
			}()
			if err == nil {
				t.Fatalf("partial triple %+v was accepted", in)
			}
			var problem *api.AgentProfileProblemError
			if !errors.As(err, &problem) {
				t.Fatalf("err = %v (%T), want a coded 422", err, err)
			}
			if problem.Code != ProfileCodeAPMIncomplete {
				t.Errorf("code = %q, want %q", problem.Code, ProfileCodeAPMIncomplete)
			}
			if !errors.Is(err, api.ErrProfileValidation) {
				t.Errorf("err = %v, must unwrap to api.ErrProfileValidation so the handler maps it 422", err)
			}
		}
	})

	t.Run("malformed digest is a refusal, not a constraint error", func(t *testing.T) {
		// The column's own CHECK (sha256:<64 hex) would raise 23514 and the
		// handler would render a 500. The store must name it instead.
		for _, bad := range []string{"sha256:nope", "0" + digest[1:], "sha256:" + strings.Repeat("A", 64), "sha512:" + strings.Repeat("a", 128)} {
			_, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
				api.AgentProfileAPMPatch{APMPackageRef: ptr("mattpocock/skills#v1.3.1"), APMTarget: ptr("claude"), APMLockDigest: ptr(bad)})
			var pgErr interface{ SQLState() string }
			if errors.As(err, &pgErr) {
				t.Fatalf("digest %q reached the database as SQLSTATE %s; it must be refused first", bad, pgErr.SQLState())
			}
			var problem *api.AgentProfileProblemError
			if !errors.As(err, &problem) {
				t.Fatalf("digest %q: err = %v (%T), want a coded 422", bad, err, err)
			}
			if problem.Code != ProfileCodeAPMDigestInvalid {
				t.Errorf("digest %q: code = %q, want %q", bad, problem.Code, ProfileCodeAPMDigestInvalid)
			}
		}
	})

	t.Run("unsupported target and unpinnable ref", func(t *testing.T) {
		_, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
			api.AgentProfileAPMPatch{APMPackageRef: ptr("mattpocock/skills#v1.3.1"), APMTarget: ptr("cursor"), APMLockDigest: ptr(digest)})
		var problem *api.AgentProfileProblemError
		if !errors.As(err, &problem) || problem.Code != ProfileCodeAPMTargetInvalid {
			t.Errorf("cursor target: err = %v, want code %q", err, ProfileCodeAPMTargetInvalid)
		}
		// No #<ref> means apm resolves the default branch: nothing this row could
		// ever pin, so it is refused rather than recorded.
		for _, ref := range []string{"mattpocock/skills", "mattpocock", "owner/repo#", "a/b#c d"} {
			_, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
				api.AgentProfileAPMPatch{APMPackageRef: ptr(ref), APMTarget: ptr("claude"), APMLockDigest: ptr(digest)})
			if !errors.As(err, &problem) || problem.Code != ProfileCodeAPMRefInvalid {
				t.Errorf("ref %q: err = %v, want code %q", ref, err, ProfileCodeAPMRefInvalid)
			}
		}
		if !ValidAPMPackageRef("mattpocock/skills/skills/engineering/ask-matt#v1.3.1") {
			t.Error("the virtual-subdirectory form (APM.md T-tag-5) must be a valid ref")
		}
	})

	t.Run("the library role is enforced in the store", func(t *testing.T) {
		// Not handler discipline: the same call with IsOrgAdmin false must fail at
		// the SQL level, and the row must not move.
		_, err := f.store.PatchAgentProfileAPM(ctx,
			Caller{UserID: f.bob, OrganizationID: f.orgID, IsOrgAdmin: false}, prof.ID,
			ptr("mattpocock/skills#v1.3.1"), ptr("claude"), ptr(digest))
		if !errors.Is(err, ErrProfileForbidden) {
			t.Fatalf("non-admin store patch err = %v, want ErrProfileForbidden", err)
		}
		_, err = f.store.CreateAgentProfile(ctx,
			Caller{UserID: f.bob, OrganizationID: f.orgID, IsOrgAdmin: false}, f.profWName("ghost"), "claude")
		if !errors.Is(err, ErrProfileForbidden) {
			t.Fatalf("non-admin store create err = %v, want ErrProfileForbidden", err)
		}
		var n int
		if err := f.pool.QueryRow(ctx,
			`SELECT count(*) FROM agent_profiles WHERE name = $1`, f.profWName("ghost")).Scan(&n); err != nil || n != 0 {
			t.Errorf("ghost profile rows = %d (err %v), want 0 — the INSERT's WHERE must insert nothing", n, err)
		}
	})

	t.Run("another organization's profile does not exist", func(t *testing.T) {
		_, err := f.api.PatchAgentProfileAPM(ctx,
			api.Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true}, prof.ID,
			api.AgentProfileAPMPatch{APMPackageRef: ptr("mattpocock/skills#v1.3.1"), APMTarget: ptr("claude"), APMLockDigest: ptr(digest)})
		if !errors.Is(err, api.ErrProfileNotFound) {
			t.Fatalf("cross-org patch err = %v, want not-found (never a peek)", err)
		}
	})

	t.Run("duplicate name in the organization", func(t *testing.T) {
		name := f.profWName("dupe")
		if _, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
			api.AgentProfileCreateInput{Name: name, LauncherID: "claude"}); err != nil {
			t.Fatalf("first create: %v", err)
		}
		_, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
			api.AgentProfileCreateInput{Name: name, LauncherID: "codex"})
		if !errors.Is(err, api.ErrProfileConflict) {
			t.Fatalf("duplicate create err = %v, want ErrProfileConflict", err)
		}
	})

	// Nothing above may have moved the pin, or a "refusal" that wrote anyway
	// would read as a pass.
	var ref *string
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_package_ref FROM agent_profiles WHERE id = $1::uuid`, prof.ID).Scan(&ref); err != nil {
		t.Fatalf("read back ref: %v", err)
	}
	if ref != nil {
		t.Errorf("ref = %q after refusals, want NULL", *ref)
	}
	if n := profWCountEvents(t, f, ctx, events.TypeAgentProfileUpdated, prof.ID); n != 0 {
		t.Errorf("agent.profile.updated rows = %d after refusals, want 0 — a refused write must not journal", n)
	}
}

// TestAgentProfileAPMUnlockedPin is the lab's blocker fixed at the source: an
// UNLOCKED pin (ref + target, no digest) is accepted, the digest alone is a
// partial pin, and changing the ref on a locked profile clears the digest and
// the contents summary in the same write.
func TestAgentProfileAPMUnlockedPin(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("unlocked"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	ref := "mattpocock/skills#v1.3.1"

	// Unlocked: the ref and the target travel, the digest does not — legal.
	unlocked, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
		api.AgentProfileAPMPatch{APMPackageRef: ptr(ref), APMTarget: ptr("claude")})
	if err != nil {
		t.Fatalf("unlocked pin refused: %v", err)
	}
	if unlocked.APMPackageRef == nil || *unlocked.APMPackageRef != ref ||
		unlocked.APMTarget == nil || *unlocked.APMTarget != "claude" ||
		unlocked.APMLockDigest != nil || unlocked.APMContents != nil {
		t.Errorf("unlocked pin view = %s", profJSON(t, unlocked))
	}

	// The digest alone is a partial pin, not a pin.
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
		api.AgentProfileAPMPatch{APMLockDigest: ptr("sha256:" + strings.Repeat("e", 64))}); err == nil {
		t.Fatal("a digest without a ref must be refused as a partial pin")
	} else {
		var problem *api.AgentProfileProblemError
		if !errors.As(err, &problem) || problem.Code != ProfileCodeAPMIncomplete {
			t.Errorf("digest-only pin: err = %v, want %q", err, ProfileCodeAPMIncomplete)
		}
	}

	// Locked, then re-pinned at another ref: the digest and the contents clear in
	// the same write — a digest for another ref must never survive.
	digest := "sha256:" + strings.Repeat("a", 64)
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
		api.AgentProfileAPMPatch{APMPackageRef: ptr(ref), APMTarget: ptr("claude"), APMLockDigest: ptr(digest)}); err != nil {
		t.Fatalf("locked pin: %v", err)
	}
	items, err := f.api.ListAgentProfiles(ctx, f.caller(f.alice, true))
	if err != nil {
		t.Fatalf("ListAgentProfiles: %v", err)
	}
	var seen *api.AgentProfileView
	for i := range items {
		if items[i].ID == prof.ID {
			seen = &items[i]
		}
	}
	if seen == nil || seen.APMLockDigest == nil || *seen.APMLockDigest != digest {
		t.Fatalf("locked pin view = %+v", seen)
	}
	otherRef := "mattpocock/skills#v1.3.0"
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID,
		api.AgentProfileAPMPatch{APMPackageRef: ptr(otherRef), APMTarget: ptr("claude")}); err != nil {
		t.Fatalf("ref change: %v", err)
	}
	items, err = f.api.ListAgentProfiles(ctx, f.caller(f.alice, true))
	if err != nil {
		t.Fatalf("ListAgentProfiles: %v", err)
	}
	for i := range items {
		if items[i].ID == prof.ID {
			seen = &items[i]
		}
	}
	if seen == nil || seen.APMLockDigest != nil || seen.APMContents != nil {
		t.Errorf("after the ref change: digest=%v contents=%+v, want both cleared", seen.APMLockDigest, seen.APMContents)
	}
}

// TestAgentProfileWriteFeedsTheWorkerRead is the point of the whole feature: a
// pin written through the API must be the pin the worker stages, and the rule the
// API enforces (all three or none) must be exactly the rule the worker's read
// already enforces. It runs ProfileFor over a real conversation.
func TestAgentProfileWriteFeedsTheWorkerRead(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)

	// A conversation on the organization's seeded profile, so the profile read is
	// the same join the worker uses.
	chat, err := f.store.CreateConversation(ctx,
		Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true},
		f.project, f.profile, "profw pinning", "")
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	// Registered now so it runs FIRST (t.Cleanup is LIFO) and before profWSetup's
	// profile delete, which an open conversation would block on the FK.
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			"DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE conversation_id = $1::uuid)",
			"DELETE FROM domain_events WHERE conversation_id = $1::uuid",
			"DELETE FROM conversation_control WHERE conversation_id = $1::uuid",
			"DELETE FROM conversation_turns WHERE conversation_id = $1::uuid",
			"DELETE FROM conversations WHERE id = $1::uuid",
		} {
			if _, err := f.pool.Exec(bg, q, chat.ID); err != nil {
				t.Errorf("conversation cleanup: %v", err)
			}
		}
		// And the shared seeded profile goes back to staging nothing.
		if _, err := f.pool.Exec(bg, `
			UPDATE agent_profiles SET apm_package_ref = NULL, apm_target = NULL, apm_lock_digest = NULL
			WHERE id = $1::uuid`, f.profile); err != nil {
			t.Errorf("restore seeded profile: %v", err)
		}
	})

	reader := &ProfileReader{Pool: f.pool}
	digest := "sha256:" + strings.Repeat("9", 64)
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), f.profile,
		api.AgentProfileAPMPatch{
			APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
			APMTarget:     ptr("claude"),
			APMLockDigest: ptr(digest),
		}); err != nil {
		t.Fatalf("patch seeded profile: %v", err)
	}

	axes, err := reader.ProfileFor(ctx, chat.ID)
	if err != nil {
		t.Fatalf("ProfileFor: %v", err)
	}
	if axes.APMPackageRef != "mattpocock/skills#v1.3.1" || axes.APMTarget != "claude" || axes.APMLockDigest != digest {
		t.Fatalf("worker axes = %+v, want the triple the API wrote", axes)
	}

	// The same row with the digest removed behind the API's back is exactly the
	// state ADR-0030 refuses to let the API create: the worker read rejects it, so
	// a profile in that shape would be a conversation that cannot launch. This is
	// the equivalence the API's 422 exists to preserve.
	if _, err := f.pool.Exec(ctx,
		`UPDATE agent_profiles SET apm_lock_digest = NULL WHERE id = $1::uuid`, f.profile); err != nil {
		t.Fatalf("simulate a half pin: %v", err)
	}
	if _, err := reader.ProfileFor(ctx, chat.ID); err == nil {
		t.Fatal("the worker read accepted a ref with no digest; the API's refusal would be theatre")
	} else if !strings.Contains(err.Error(), "not locked yet") {
		t.Errorf("refusal err = %v, want the not-locked-yet sentence", err)
	}

	// Clearing the triple through the API makes the profile launchable again.
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), f.profile,
		api.AgentProfileAPMPatch{}); err != nil {
		t.Fatalf("clear seeded profile: %v", err)
	}
	axes, err = reader.ProfileFor(ctx, chat.ID)
	if err != nil {
		t.Fatalf("ProfileFor after clearing: %v", err)
	}
	if axes.APMPackageRef != "" || axes.APMLockDigest != "" {
		t.Errorf("cleared profile still stages: %+v", axes)
	}
}
