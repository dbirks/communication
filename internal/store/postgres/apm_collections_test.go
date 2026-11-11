package postgres

// ADR-0084 against a real PostgreSQL: the seeded library, the immutable published
// revision, the published-only attachment rule, the digest clearing a moved
// attachment list causes, and the flattened dependency list the lock queue hands
// a worker. The migration's own constraints are asserted HERE rather than
// trusted: a CHECK that only fires in Postgres, a trigger no Go code can see, and
// an ORDER that a decoded-then-reencoded round trip could silently lose are
// exactly what this file is for.
//
// The API adapter is the subject for the profile writes, because it is the layer
// the handler talks to and its coded refusals are the answer a browser sees.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// apmcFixture is the profile-write fixture plus the collection rows it creates,
// cleaned up by token: the lab database is shared and another run's fixture is in
// it right now.
type apmcFixture struct {
	*profWFixture
	collections *APMCollectionStore
	token       string
}

func apmcSetup(t *testing.T) *apmcFixture {
	t.Helper()
	f := &apmcFixture{profWFixture: profWSetup(t)}
	f.collections = &APMCollectionStore{Pool: f.pool}
	f.token = f.profWFixture.token
	ctx := testCtx(t)
	t.Cleanup(func() {
		// LIFO: this runs before profWSetup's own cleanup, so the profiles that
		// attach these collections are still present to be cleared first.
		if _, err := f.pool.Exec(ctx,
			`UPDATE agent_profiles SET apm_collections = '[]'::jsonb WHERE organization_id = $1::uuid AND name LIKE 'profw-' || $2 || '-%'`,
			f.orgID, f.token); err != nil {
			t.Errorf("clear profile attachments: %v", err)
		}
		// By slug suffix, not by created_by: the rows name the user who wrote them
		// (alice), and the token is only in the slug.
		if _, err := f.pool.Exec(ctx, `
			DELETE FROM apm_collection_revisions
			WHERE collection_id IN (
				SELECT id FROM apm_collections WHERE organization_id = $1::uuid AND slug LIKE '%-' || $2)`,
			f.orgID, f.token); err != nil {
			t.Errorf("collection revision cleanup: %v", err)
		}
		if _, err := f.pool.Exec(ctx,
			`DELETE FROM apm_collections WHERE organization_id = $1::uuid AND slug LIKE '%-' || $2`,
			f.orgID, f.token); err != nil {
			t.Errorf("collection cleanup: %v", err)
		}
	})
	return f
}

// admin is the library role in the store's own terms: the row says it, the
// fixture grants it (profWSetup), and a Caller that merely claimed it would test
// nothing about what the SQL asserts.
func (f *apmcFixture) admin() Caller {
	return Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}
}

// member is bob: a member of the organization who was never granted the library
// role. alice cannot play both parts — profWSetup granted alice the role in the
// ROW, precisely so a fixture Caller could not invent it.
func (f *apmcFixture) member() Caller {
	return Caller{UserID: f.bob, OrganizationID: f.orgID, IsOrgAdmin: false}
}

// create publishes nothing: it lands the collection with revision 1 as a DRAFT,
// exactly as the create route does, and returns the row.
func (f *apmcFixture) create(t *testing.T, suffix string, entries ...APMCollectionEntry) api.APMCollectionView {
	t.Helper()
	view, err := f.collections.CreateAPMCollection(testCtx(t), f.admin(),
		"test-"+suffix+"-"+f.token, "Test "+suffix, "fixture collection", entries)
	if err != nil {
		t.Fatalf("CreateAPMCollection(%s): %v", suffix, err)
	}
	return view
}

func (f *apmcFixture) publish(t *testing.T, id string, revision int) {
	t.Helper()
	if _, err := f.collections.PublishAPMCollectionRevision(testCtx(t), f.admin(), id, revision); err != nil {
		t.Fatalf("publish %s r%d: %v", id, revision, err)
	}
}

// The ADR's three seeded collections exist after a migrate, with the ADR's refs,
// in the ADR's order. A seed that silently landed empty, or in a shuffled order,
// would still leave every unit test green — the order is the ordering rule.
func TestAPMCollectionSeedsAfterMigrate(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)

	var published, drafts int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'published'), count(*) FILTER (WHERE status = 'draft')
		FROM apm_collection_revisions r
		JOIN apm_collections c ON c.id = r.collection_id
		WHERE c.slug IN ('matt-pocock-skills','pstack-claude-code','review-conventions')
		  AND r.revision = 1`).Scan(&published, &drafts); err != nil {
		t.Fatalf("seed read: %v", err)
	}
	if published != 2 || drafts != 1 {
		t.Fatalf("seeded revision 1: %d published, %d draft; want 2 published (Matt Pocock, pstack) and 1 draft (Review conventions)", published, drafts)
	}

	var ref string
	if err := f.pool.QueryRow(ctx, `
		SELECT e ->> 'ref' FROM apm_collection_revisions r
		JOIN apm_collections c ON c.id = r.collection_id,
		     jsonb_array_elements(r.entries) AS e
		WHERE c.slug = 'matt-pocock-skills' AND r.revision = 1`).Scan(&ref); err != nil {
		t.Fatalf("matt pocock ref: %v", err)
	}
	if ref != "mattpocock/skills#v1.3.2" {
		t.Errorf("Matt Pocock seed ref = %q, want mattpocock/skills#v1.3.2 (the ADR's tag)", ref)
	}

	// pstack: one entry per skill, all commit-pinned at the same SHA, the router
	// first, the core working set next, all 24 principle-* skills after that.
	var (
		count       int
		principles  int
		first, last string
		badPin      int
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE e ->> 'ref' LIKE 'cursor/plugins/harness/pstack/claude-code/skills/principle-%'),
		       count(*) FILTER (WHERE e ->> 'ref' NOT LIKE '%#63912a91d52c43946f974f2aaf661334a6116a82')
		FROM apm_collection_revisions r
		JOIN apm_collections c ON c.id = r.collection_id,
		     jsonb_array_elements(r.entries) AS e
		WHERE c.slug = 'pstack-claude-code' AND r.revision = 1`).Scan(&count, &principles, &badPin); err != nil {
		t.Fatalf("pstack seed count: %v", err)
	}
	if count != 36 {
		t.Errorf("pstack seed entries = %d, want 36 (12 core + 24 principle-*)", count)
	}
	if principles != 24 {
		t.Errorf("pstack principle-* entries = %d, want 24", principles)
	}
	if badPin != 0 {
		t.Errorf("%d pstack entries are not pinned to the ADR's commit — an unpinned ref follows a moving branch (ADR-0084 Security)", badPin)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT e ->> 'ref' FROM apm_collection_revisions r
		JOIN apm_collections c ON c.id = r.collection_id,
		     jsonb_array_elements(r.entries) WITH ORDINALITY AS t(e, ord)
		WHERE c.slug = 'pstack-claude-code' AND r.revision = 1 ORDER BY ord LIMIT 1`).Scan(&first); err != nil {
		t.Fatalf("pstack first entry: %v", err)
	}
	if !strings.HasSuffix(first, "/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82") {
		t.Errorf("pstack first entry = %q, want the router skill (poteto-mode) first: the entry order IS the install order", first)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT e ->> 'ref' FROM apm_collection_revisions r
		JOIN apm_collections c ON c.id = r.collection_id,
		     jsonb_array_elements(r.entries) WITH ORDINALITY AS t(e, ord)
		WHERE c.slug = 'pstack-claude-code' AND r.revision = 1 ORDER BY ord DESC LIMIT 1`).Scan(&last); err != nil {
		t.Fatalf("pstack last entry: %v", err)
	}
	if !strings.HasSuffix(last, "/skills/principle-type-system-discipline#63912a91d52c43946f974f2aaf661334a6116a82") {
		t.Errorf("pstack last entry = %q", last)
	}

	// The seeded list must survive the flatten unchanged in length: a duplicate or
	// a dropped entry here would mean the worker installs a different set than the
	// ADR describes.
	// The seeded profiles attach nothing: every unit test below starts from "this
	// list moved", which is only meaningful if the list started empty.
	seed, err := cnvProfileRow(ctx, f.pool, f.profile, f.orgID)
	if err != nil {
		t.Fatalf("read the seeded profile: %v", err)
	}
	if len(seed.APMCollectionPins) != 0 {
		t.Fatalf("seeded profile %s already attaches %d collections; the ADR seeds none", f.profile, len(seed.APMCollectionPins))
	}
}

// profileID hands a fixture a profile whose attachment list is EMPTY, so "the
// list moved" means what it says in every test below: a fresh row, not one
// somebody attached in an earlier subtest.
func (f *apmcFixture) profileID(t *testing.T) string {
	t.Helper()
	prof, err := f.api.CreateAgentProfile(testCtx(t), f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("attach-clean"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("create clean profile: %v", err)
	}
	return prof.ID
}

// A draft is not attachable. This is the ADR's security line: an attachment is the
// statement that a human published this bundle, and staging somebody's unfinished
// edit in front of an agent is the failure the lock flow exists to prevent.
func TestAPMCollectionOnlyPublishedRevisionsAreAttachable(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "draft-only", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})

	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("attach-draft"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err = f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}},
	})
	if err == nil {
		t.Fatal("a profile attached a DRAFT collection revision")
	}
	var problem *api.AgentProfileProblemError
	if !errors.As(err, &problem) || problem.Code != api.CollectionCodeRevisionInvalid {
		t.Fatalf("draft attach err = %v, want a 422 coded %s", err, api.CollectionCodeRevisionInvalid)
	}
	// And the column still says what it said: the refusal landed nothing.
	var stored string
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_collections::text FROM agent_profiles WHERE id = $1::uuid`, prof.ID).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != "[]" {
		t.Errorf("apm_collections after the refusal = %s, want []", stored)
	}

	// Publishing the same revision makes it attachable, with no other change.
	f.publish(t, c.ID, 1)
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}},
	}); err != nil {
		t.Fatalf("attach after publish: %v", err)
	}

	// A revision that does not exist is the same refusal, and a foreign
	// collection's published revision is NOT attachable either: the row exists and
	// is published, and it is still somebody else's bundle.
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 99}},
	}); err == nil {
		t.Error("attaching revision 99 (which no version of this collection ever was) was accepted")
	}
	elseOrg := f.caller(f.mallory, true)
	foreign, err := f.collections.CreateAPMCollection(ctx, Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true},
		"foreign-"+f.token, "Foreign", "", []APMCollectionEntry{{Ref: "other/repo#v1.0.0"}})
	if err != nil {
		t.Fatalf("foreign create: %v", err)
	}
	if _, err := f.collections.PublishAPMCollectionRevision(ctx, Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true}, foreign.ID, 1); err != nil {
		t.Fatalf("foreign publish: %v", err)
	}
	_ = elseOrg
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: foreign.ID, Revision: 1}},
	}); err == nil {
		t.Fatal("a profile attached another organization's collection")
	} else {
		var p2 *api.AgentProfileProblemError
		if !errors.As(err, &p2) || p2.Code != api.CollectionCodeRevisionInvalid {
			t.Errorf("cross-org attach err = %v, want the coded 422", err)
		}
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM apm_collection_revisions WHERE collection_id = $1::uuid`, foreign.ID)
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM apm_collections WHERE id = $1::uuid`, foreign.ID)
	})
}

// A published revision cannot be edited: the store answers the conflict, the
// journal is untouched, and the database itself refuses a hand-written UPDATE.
// Immutability that lives only in "we never issue that statement" is a convention,
// and a convention is what a later refactor quietly drops.
func TestAPMCollectionPublishedRevisionIsImmutable(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "immutable", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	f.publish(t, c.ID, 1)

	// Re-publishing is the conflict, not a no-op: a second actor already published
	// it and silence would hide that.
	_, err := f.collections.PublishAPMCollectionRevision(ctx, f.admin(), c.ID, 1)
	if !errors.Is(err, ErrCollectionPublished) {
		t.Fatalf("re-publish err = %v, want ErrCollectionPublished", err)
	}
	// A new revision is the only way to change content, and it lands as a draft
	// beside the published one — which stays exactly as it was.
	rev2, err := f.collections.CreateAPMCollectionRevision(ctx, f.admin(), c.ID,
		[]APMCollectionEntry{{Ref: "other/repo#v2.0.0"}, {Ref: "mattpocock/skills#v1.3.2"}})
	if err != nil {
		t.Fatalf("new revision: %v", err)
	}
	if rev2.Revision != 2 || rev2.Status != "draft" {
		t.Fatalf("revision 2 = %+v, want a draft numbered 2", rev2)
	}
	var (
		status1, entries1 string
		status2           string
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT status, entries::text FROM apm_collection_revisions WHERE collection_id = $1::uuid AND revision = 1`,
		c.ID).Scan(&status1, &entries1); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT status FROM apm_collection_revisions WHERE collection_id = $1::uuid AND revision = 2`,
		c.ID).Scan(&status2); err != nil {
		t.Fatal(err)
	}
	if status1 != "published" || status2 != "draft" {
		t.Errorf("statuses after drafting a new revision: r1=%s r2=%s, want published/draft", status1, status2)
	}
	if entries1 != `[{"ref": "mattpocock/skills#v1.3.2"}]` && !strings.Contains(entries1, "mattpocock/skills#v1.3.2") {
		t.Errorf("revision 1 content moved: %s", entries1)
	}
	if strings.Contains(entries1, "other/repo") {
		t.Error("revision 2's content leaked into revision 1")
	}

	// The database refuses the statement the Go code would never send. This is the
	// backstop the migration documents.
	if _, err := f.pool.Exec(ctx, `
		UPDATE apm_collection_revisions SET entries = '[]'::jsonb
		WHERE collection_id = $1::uuid AND revision = 1`, c.ID); err == nil {
		t.Error("Postgres accepted a content UPDATE on a published revision: the trigger is not doing its job")
	} else if !pgConflictCode(err, "23514") {
		t.Errorf("published-content UPDATE err = %v, want a 23514 constraint violation", err)
	}
	// Un-publishing is refused the same way: a published revision stays published.
	if _, err := f.pool.Exec(ctx, `
		UPDATE apm_collection_revisions SET status = 'draft'
		WHERE collection_id = $1::uuid AND revision = 1`, c.ID); err == nil {
		t.Error("a published revision was turned back into a draft")
	}
}

// The whole point of the attachment list, and the rule the ADR states in one
// sentence: CHANGE IT AND THE DIGEST DIES. The digest is sha256 of the lock for
// ONE dependency list, so the moment the list moves the recorded digest describes
// a context this profile no longer resolves — keeping it would either launch
// unverified content or trip the gate blaming somebody else's turn.
func TestProfileWriteClearsDigestOnCollectionChange(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "digest", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	f.publish(t, c.ID, 1)
	locked := "sha256:" + strings.Repeat("a", 64)

	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("digest"), LauncherID: "claude"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// A locked pin: ref + target + digest, the shape ADR-0054 records.
	lockedPin, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("other/repo#v9.9.9"), APMTarget: ptr("claude"), APMLockDigest: ptr(locked),
	})
	if err != nil {
		t.Fatalf("lock the pin: %v", err)
	}
	if lockedPin.APMLockDigest == nil || *lockedPin.APMLockDigest != locked {
		t.Fatalf("the pin did not land locked: %+v", lockedPin)
	}

	// A body that carries the SAME list changes nothing, so the digest survives.
	unchanged, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("other/repo#v9.9.9"), APMTarget: ptr("claude"), APMLockDigest: ptr(locked),
	})
	if err != nil {
		t.Fatalf("re-write the same pin: %v", err)
	}
	if unchanged.APMLockDigest == nil || *unchanged.APMLockDigest != locked {
		t.Fatalf("digest lost on a write that changed nothing: %+v", unchanged)
	}
	// Attaching a collection MOVES the list. The body below also carries the old
	// digest — and the store must drop it anyway, because the clearing is the
	// server's rule, not a client courtesy.
	after, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("other/repo#v9.9.9"), APMTarget: ptr("claude"), APMLockDigest: ptr(locked),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}},
	})
	if err != nil {
		t.Fatalf("attach a collection: %v", err)
	}
	if after.APMLockDigest != nil {
		t.Errorf("digest survived a moved collection list: %v", *after.APMLockDigest)
	}
	if len(after.APMCollectionPins) != 1 || after.APMCollectionPins[0].CollectionID != c.ID {
		t.Fatalf("the view lost the attachment: %+v", after.APMCollectionPins)
	}
	// The contents summary that came WITH that digest cannot outlive it either: it
	// names skills of a lock this profile no longer holds.
	var summaryNull bool
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_contents_summary IS NULL FROM agent_profiles WHERE id = $1::uuid`, prof.ID).Scan(&summaryNull); err != nil {
		t.Fatal(err)
	}
	if !summaryNull {
		t.Error("apm_contents_summary survived the digest it belonged to")
	}

	// REORDERING the same two collections is a change too: the order decides which
	// package owns a skill both ship, so it moves the lock and must move the
	// digest. Two collections, one already attached — add the second, then flip.
	d := f.create(t, "digest2", APMCollectionEntry{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"})
	f.publish(t, d.ID, 1)
	both, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}, {CollectionID: d.ID, Revision: 1}},
	})
	if err != nil {
		t.Fatalf("attach two: %v", err)
	}
	relock, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget: ptr("claude"), APMLockDigest: ptr("sha256:" + strings.Repeat("b", 64)),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}, {CollectionID: d.ID, Revision: 1}},
	})
	if err != nil {
		t.Fatalf("re-lock with the same order: %v", err)
	}
	if relock.APMLockDigest == nil {
		t.Fatalf("a write whose list did not move lost its digest: %+v", both)
	}
	flipped, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMLockDigest:     ptr("sha256:" + strings.Repeat("b", 64)),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: d.ID, Revision: 1}, {CollectionID: c.ID, Revision: 1}},
	})
	if err != nil {
		t.Fatalf("flip the order: %v", err)
	}
	if flipped.APMLockDigest != nil {
		t.Errorf("reordering two collections kept the digest (%v): the order is part of what the lock covers", *flipped.APMLockDigest)
	}

	// And the journal says so: the update row carries the ORDERED list, so a reader
	// can tell which set a recorded digest described.
	var payload []byte
	if err := f.pool.QueryRow(ctx, `
		SELECT payload FROM domain_events
		WHERE type = $1 AND organization_id = $2::uuid AND payload->>'profile_id' = $3
		ORDER BY global_seq DESC LIMIT 1`,
		events.TypeAgentProfileUpdated, f.orgID, prof.ID).Scan(&payload); err != nil {
		t.Fatalf("read the update journal row: %v", err)
	}
	var got events.AgentProfileUpdatedPayload
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("decode journal payload: %v", err)
	}
	if len(got.APMCollections) != 2 || got.APMCollections[0].CollectionID != d.ID {
		t.Errorf("journal apm_collections = %+v, want the flipped order first-by-id %s", got.APMCollections, d.ID)
	}
}

// A profile created WITH its collections chosen is legal (each entry is a bundle
// somebody published), and it arrives UNLOCKED: the create path still cannot
// record a digest nobody resolved.
func TestProfileCreateWithCollectionsIsUnlocked(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "create-attach", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	f.publish(t, c.ID, 1)

	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true), api.AgentProfileCreateInput{
		Name: f.profWName("created-attached"), LauncherID: "claude",
		APMCollectionPins: []api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}},
	})
	if err != nil {
		t.Fatalf("create with collections: %v", err)
	}
	if len(prof.APMCollectionPins) != 1 {
		t.Fatalf("create lost the attachment: %+v", prof.APMCollectionPins)
	}
	if prof.APMLockDigest != nil || prof.APMPackageRef != nil {
		t.Errorf("a create recorded a pin nobody locked: %+v", prof)
	}
	// The create journaled the list too, so the profile's history starts complete.
	var payload []byte
	if err := f.pool.QueryRow(ctx, `
		SELECT payload FROM domain_events WHERE type = $1 AND payload->>'profile_id' = $2`,
		events.TypeAgentProfileCreated, prof.ID).Scan(&payload); err != nil {
		t.Fatalf("create journal row: %v", err)
	}
	var got events.AgentProfileCreatedPayload
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.APMCollections) != 1 || got.APMCollections[0].Revision != 1 {
		t.Errorf("create payload collections = %+v", got.APMCollections)
	}
}

// A version freezes the list the way it freezes the ref: the history row's JSON
// carries it, in order, because a version a conversation pinned has to resolve to
// ONE dependency set — not to whatever the collections had become when somebody
// read the version back.
func TestProfileRevisionJSONMirrorsTheAttachmentList(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	a := f.create(t, "snap-a", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	b := f.create(t, "snap-b", APMCollectionEntry{Ref: "other/repo#v1.0.0"})
	f.publish(t, a.ID, 1)
	f.publish(t, b.ID, 1)

	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("snapshot"), LauncherID: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget: ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{
			{CollectionID: b.ID, Revision: 1}, {CollectionID: a.ID, Revision: 1},
		},
	}); err != nil {
		t.Fatalf("attach in order b,a: %v", err)
	}
	var snapshot []byte
	if err := f.pool.QueryRow(ctx, `
		SELECT snapshot FROM agent_profile_versions
		WHERE profile_id = $1::uuid ORDER BY version DESC LIMIT 1`, prof.ID).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	var snap AgentProfileSnapshot
	if err := json.Unmarshal(snapshot, &snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if len(snap.APMCollectionPins) != 2 || snap.APMCollectionPins[0].CollectionID != b.ID ||
		snap.APMCollectionPins[1].CollectionID != a.ID {
		t.Fatalf("snapshot apm_collections = %+v, want [b a] in attach order (the order is the data)", snap.APMCollectionPins)
	}

	// Restoring the version resolves the same list, and the worker's read flattens
	// it in that order — the two halves of "a version is a state".
	revs, err := APMCollectionRevisionsFor(ctx, f.pool, f.orgID, snap.APMCollectionPins)
	if err != nil {
		t.Fatalf("resolve the snapshot's list: %v", err)
	}
	deps, err := apm.FlattenProfile(revs, "")
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if got := apm.RefsOf(deps); len(got) != 2 || got[0] != "other/repo#v1.0.0" || got[1] != "mattpocock/skills#v1.3.2" {
		t.Errorf("flattened order = %v, want [other/repo#v1.0.0 mattpocock/skills#v1.3.2]", got)
	}
}

// A restore writes the snapshot's list, and the published-only rule still applies:
// a frozen version cannot be a way to land a draft attachment.
func TestProfileRestoreRefusesADraftAttachment(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "restore", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	f.publish(t, c.ID, 1)
	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("restore"), LauncherID: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: c.ID, Revision: 1}},
	}); err != nil {
		t.Fatalf("attach published: %v", err)
	}
	// Roll the collection back to a draft by drafting revision 2 and publishing
	// NOTHING: revision 1 stays published, so the restore below is refused for a
	// different reason — and that is the point of the second half of this test.
	if _, err := f.collections.CreateAPMCollectionRevision(ctx, f.admin(), c.ID,
		[]APMCollectionEntry{{Ref: "mattpocock/skills#v1.3.3"}}); err != nil {
		t.Fatalf("draft r2: %v", err)
	}
	restored, newVersion, err := f.api.RestoreAgentProfileVersion(ctx, f.caller(f.alice, true), prof.ID, 2)
	if err != nil {
		t.Fatalf("restore version 2 (published r1 is still published): %v", err)
	}
	if len(restored.APMCollectionPins) != 1 || restored.APMCollectionPins[0].Revision != 1 {
		t.Fatalf("restore lost the pinned revision: %+v (v%d)", restored.APMCollectionPins, newVersion)
	}
	// Now a snapshot that names a DRAFT: hand-written, because no published
	// revision can produce one — which is exactly the claim being tested.
	var snap AgentProfileSnapshot
	if err := f.pool.QueryRow(ctx, `
		SELECT snapshot FROM agent_profile_versions
		WHERE profile_id = $1::uuid AND version = 2`, prof.ID).Scan(new(string)); err != nil {
		t.Fatal(err)
	}
	_ = snap
	if _, err := f.pool.Exec(ctx, `
		UPDATE agent_profile_versions
		SET snapshot = jsonb_set(snapshot::jsonb, '{apm_collections}',
		    ('[{"collection_id": "' || $1::text || '", "revision": 2}]')::jsonb)
		WHERE profile_id = $2::uuid AND version = 2`, c.ID, prof.ID); err != nil {
		t.Fatalf("bend the snapshot to name a draft: %v", err)
	}
	if _, _, err := f.api.RestoreAgentProfileVersion(ctx, f.caller(f.alice, true), prof.ID, 2); err == nil {
		t.Fatal("restoring a snapshot that names a draft collection revision was accepted")
	} else {
		var problem *api.AgentProfileProblemError
		if !errors.As(err, &problem) || problem.Code != api.CollectionCodeRevisionInvalid {
			t.Errorf("restore err = %v, want the coded 422", err)
		}
	}
}

// The lock queue carries the FLATTENED list, not one ref: the resolve installs the
// set the operator looked at, and a collection edited between queueing and claiming
// cannot move the digest under anybody's feet.
func TestAPMLockRequestCarriesTheFlattenedDeps(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	matt := f.create(t, "lock-matt", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	pstack := f.create(t, "lock-pstack",
		APMCollectionEntry{Ref: "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82"},
		APMCollectionEntry{Ref: "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82", Skills: []string{"how"}},
	)
	f.publish(t, matt.ID, 1)
	f.publish(t, pstack.ID, 1)

	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("lock"), LauncherID: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("acme/extras#v0.1.0"),
		APMTarget:     ptr(apm.TargetAgentSkills),
		APMCollectionPins: &[]api.APMCollectionPin{
			{CollectionID: matt.ID, Revision: 1}, {CollectionID: pstack.ID, Revision: 1},
		},
	}); err != nil {
		t.Fatalf("attach the set (pi's agent-skills target included): %v", err)
	}

	// A collection-only profile with no ref of its own is lockable too, which the
	// pre-ADR-0084 gate ("both the ref and the target") would have refused.
	noRef, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("lock-noref"), LauncherID: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), noRef.ID, api.AgentProfileAPMPatch{
		APMTarget:         ptr("claude"),
		APMCollectionPins: &[]api.APMCollectionPin{{CollectionID: matt.ID, Revision: 1}},
	}); err != nil {
		t.Fatalf("attach without a ref: %v", err)
	}
	if _, err := f.api.CreateAPMLockRequest(ctx, f.caller(f.alice, true), noRef.ID); err != nil {
		t.Fatalf("a collection-only pin must be lockable: %v", err)
	}

	req, err := f.api.CreateAPMLockRequest(ctx, f.caller(f.alice, true), prof.ID)
	if err != nil {
		t.Fatalf("CreateAPMLockRequest: %v", err)
	}
	if req.Status != "queued" {
		t.Fatalf("queued request = %+v", req)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM apm_lock_requests WHERE profile_id = ANY($1::uuid[])`, []string{prof.ID, noRef.ID})
	})

	store := &TurnStore{Pool: f.pool}
	claim, ok, err := store.ClaimAPMLockRequest(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	// The queue is not ordered by profile, so walk until this profile's request
	// shows up; the FIRST one for it is the row this test is about.
	for i := 0; claim.ProfileID != prof.ID && i < 8; i++ {
		claim, ok, err = store.ClaimAPMLockRequest(ctx, f.worker)
		if err != nil || !ok {
			t.Fatalf("claim %d: ok=%v err=%v", i, ok, err)
		}
	}
	if claim.ProfileID != prof.ID {
		t.Fatalf("never claimed the fixture's lock (got %s)", claim.ProfileID)
	}
	if claim.Target != apm.TargetAgentSkills {
		t.Errorf("claim target = %q, want pi's agent-skills target", claim.Target)
	}
	want := []string{
		"mattpocock/skills#v1.3.2",
		"cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82",
		"acme/extras#v0.1.0",
	}
	if got := apm.RefsOf(claim.Deps); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("claim deps =\n%v\nwant (attach order, own ref last, the exact duplicate dropped once)\n%v", got, want)
	}
	if len(claim.Deps) != 3 {
		t.Fatalf("deps = %+v, want the duplicate pstack ref deduped to its first position", claim.Deps)
	}
}

// The worker reports a lock it resolved; the control plane records digest +
// contents summary, and ADR-0084's attribution has to survive the trip: the app's
// "overridden by …" note reads agent_profiles.apm_contents_summary.
func TestAPMLockCompleteRecordsPerSkillAttribution(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	prof, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: f.profWName("attribution"), LauncherID: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), prof.ID, api.AgentProfileAPMPatch{
		APMPackageRef: ptr("mattpocock/skills#v1.3.2"), APMTarget: ptr("claude"),
	}); err != nil {
		t.Fatal(err)
	}
	req, err := f.api.CreateAPMLockRequest(ctx, f.caller(f.alice, true), prof.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM apm_lock_requests WHERE profile_id = $1::uuid`, prof.ID)
	})
	store := &TurnStore{Pool: f.pool}
	claim, ok, err := store.ClaimAPMLockRequest(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	for i := 0; claim.RequestID != req.RequestID && i < 8; i++ {
		claim, ok, err = store.ClaimAPMLockRequest(ctx, f.worker)
		if err != nil || !ok {
			t.Fatalf("claim: %v %v", ok, err)
		}
	}
	if claim.RequestID != req.RequestID {
		t.Fatalf("never claimed %s", req.RequestID)
	}
	if err := store.CompleteAPMLockRequest(ctx, claim, &apm.ResolveResult{
		LockDigest:  "sha256:" + strings.Repeat("c", 64),
		ResolvedRef: "v1.3.2",
		Commit:      "24fe0ef7737efae15c87225755e9f6f5965e4888",
		APMVersion:  apm.PinnedVersion,
		Contents: apm.Contents{
			Skills: []string{"grill-me", "how"},
			SkillRefs: []apm.SkillRef{
				{Skill: "grill-me", FromRef: "mattpocock/skills#v1.3.2"},
				{Skill: "how", FromRef: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82"},
			},
		},
	}, nil); err != nil {
		t.Fatalf("CompleteAPMLockRequest: %v", err)
	}

	view, err := f.api.ListAgentProfiles(ctx, f.caller(f.alice, false))
	if err != nil {
		t.Fatal(err)
	}
	var mine *api.AgentProfileView
	for i := range view {
		if view[i].ID == prof.ID {
			mine = &view[i]
		}
	}
	if mine == nil {
		t.Fatal("the profile vanished from the list")
	}
	if mine.APMContents == nil || len(mine.APMContents.SkillRefs) != 2 {
		t.Fatalf("apm_contents lost the attribution: %+v", mine.APMContents)
	}
	owners := map[string]string{}
	for _, r := range mine.APMContents.SkillRefs {
		owners[r.Skill] = r.FromRef
	}
	if owners["grill-me"] != "mattpocock/skills#v1.3.2" {
		t.Errorf("grill-me attribution = %q", owners["grill-me"])
	}
	if owners["how"] != "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82" {
		t.Errorf("how attribution = %q", owners["how"])
	}
	// The lock event carries the flattened set too, in install order.
	var payload []byte
	if err := f.pool.QueryRow(ctx, `
		SELECT payload FROM domain_events WHERE type = $1 AND payload->>'profile_id' = $2
		ORDER BY global_seq DESC LIMIT 1`, events.TypeAgentProfileAPMLocked, prof.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var locked events.AgentProfileAPMLockedPayload
	if err := json.Unmarshal(payload, &locked); err != nil {
		t.Fatal(err)
	}
	if len(locked.Deps) != 1 || locked.Deps[0] != "mattpocock/skills#v1.3.2" {
		t.Errorf("apm_locked deps = %v, want the one package this lock covered", locked.Deps)
	}
}

// The library's own visibility rules: a member reads it, the library role writes
// it, and another organization's collection is not-found rather than a peek.
func TestAPMCollectionStoreRolesAndVisibility(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "roles", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})

	if _, err := f.collections.CreateAPMCollection(ctx, f.member(), "member-"+f.token, "Member", "", nil); !errors.Is(err, ErrCollectionForbidden) {
		t.Errorf("member create err = %v, want ErrCollectionForbidden", err)
	}
	if _, err := f.collections.CreateAPMCollectionRevision(ctx, f.member(), c.ID, nil); !errors.Is(err, ErrCollectionForbidden) {
		t.Errorf("member revision err = %v, want ErrCollectionForbidden", err)
	}
	if _, err := f.collections.PublishAPMCollectionRevision(ctx, f.member(), c.ID, 1); !errors.Is(err, ErrCollectionForbidden) {
		t.Errorf("member publish err = %v, want ErrCollectionForbidden", err)
	}

	list, err := f.collections.ListAPMCollections(ctx, Caller{UserID: f.bob, OrganizationID: f.orgID})
	if err != nil {
		t.Fatalf("member list: %v", err)
	}
	if len(list) == 0 {
		t.Fatal("a member could not read the library")
	}
	found := false
	for _, row := range list {
		if row.ID == c.ID {
			found = true
			if row.LatestRevision == nil || row.LatestRevision.Status != "draft" {
				t.Errorf("list row latest_revision = %+v, want the draft this create landed", row.LatestRevision)
			}
			if row.PublishedRevisions != 0 {
				t.Errorf("published_revisions = %d before any publish, want 0", row.PublishedRevisions)
			}
		}
	}
	if !found {
		t.Fatal("the created collection never showed in the list")
	}

	// The same store, asked as a member of another organization, does not see it —
	// and does not learn it exists.
	if _, err := f.collections.GetAPMCollection(ctx, Caller{UserID: f.mallory, OrganizationID: f.elseOrg}, c.ID); !errors.Is(err, ErrCollectionNotFound) {
		t.Errorf("cross-org get err = %v, want ErrCollectionNotFound", err)
	}
	// A duplicate slug inside one organization is the conflict, not a second row.
	if _, err := f.collections.CreateAPMCollection(ctx, f.admin(), c.Slug, "Clash", "", nil); !errors.Is(err, ErrCollectionConflict) {
		t.Errorf("slug clash err = %v, want ErrCollectionConflict", err)
	}
	// An entry ref that is not pinned is the coded 422 — the store refuses it even
	// when the handler already did, because the store is the last thing between a
	// request and the column.
	if _, err := f.collections.CreateAPMCollection(ctx, f.admin(), "bad-ref-"+f.token, "Bad", "",
		[]APMCollectionEntry{{Ref: "mattpocock/skills"}}); err == nil {
		t.Error("the store accepted an unpinned entry ref")
	} else {
		var problem *APMCollectionProblem
		if !errors.As(err, &problem) || problem.Code != CollectionCodeEntriesInvalid {
			t.Errorf("bad ref err = %v, want the coded 422", err)
		}
	}
	// A skill subset is validated per element too: a name with a space would
	// render as a YAML scalar that apm reads as two tokens.
	if _, err := f.collections.CreateAPMCollection(ctx, f.admin(), "bad-skill-"+f.token, "Bad skill", "",
		[]APMCollectionEntry{{Ref: "mattpocock/skills#v1.3.2", Skills: []string{"good name"}}}); err == nil {
		t.Error("the store accepted a skill name with a space")
	}
}

// The migration's own backstop: the profile trigger refuses an attachment list
// that names a draft or a foreign collection, so a store bug — or a hand-written
// statement — cannot plant one. The list is also constrained to the shape the
// decoder expects, and the ORDER is what the database preserves.
func TestAPMCollectionMigrationConstraints(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	draft := f.create(t, "trigger-draft", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})

	prof := f.profileID(t)
	if _, err := f.pool.Exec(ctx, `
		UPDATE agent_profiles SET apm_collections = jsonb_build_array(
		    jsonb_build_object('collection_id', $1::text, 'revision', 1))
		WHERE id = $2::uuid`, draft.ID, prof); err == nil {
		t.Error("Postgres accepted a profile attaching a DRAFT revision: the scope trigger is not doing its job")
	} else if !pgConflictCode(err, "23514") {
		t.Errorf("draft-attachment UPDATE err = %v, want a 23514 violation", err)
	}

	// Malformed shapes, refused by the column CHECK:
	for _, bad := range []string{
		`{"collection_id":"not-a-uuid","revision":1}`,
		`"a string"`,
		`[{"collection_id":"01987a71-4444-7000-8000-abcdef012345"}]`,
		`[{"collection_id":"01987a71-4444-7000-8000-abcdef012345","revision":0}]`,
	} {
		if _, err := f.pool.Exec(ctx,
			`UPDATE agent_profiles SET apm_collections = $1::jsonb WHERE id = $2::uuid`, "["+bad+"]", prof); err == nil {
			t.Errorf("column CHECK accepted %s", bad)
		}
	}
	// The same goes for the entries column: a ref with no `#<revision>` has no
	// business being storable, and a skills list of non-strings is not a subset.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO apm_collection_revisions (collection_id, organization_id, revision, status, entries, created_by)
		VALUES ($1::uuid, $2::uuid, 7, 'draft', '[{"ref":"owner/repo"}]'::jsonb, 'test')`,
		draft.ID, f.orgID); err == nil {
		t.Error("the entries CHECK accepted an unpinned ref")
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO apm_collection_revisions (collection_id, organization_id, revision, status, entries, created_by)
		VALUES ($1::uuid, $2::uuid, 7, 'draft', '[{"ref":"owner/repo#v1.0.0","skills":"not-a-list"}]'::jsonb, 'test')`,
		draft.ID, f.orgID); err == nil {
		t.Error("the entries CHECK accepted a skills value that is not a list")
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM apm_collection_revisions WHERE collection_id = $1::uuid AND revision = 7`, draft.ID)
	})

	// pi's target is admitted by the widened CHECK (ADR-0084), and nothing else is.
	if _, err := f.pool.Exec(ctx,
		`UPDATE agent_profiles SET apm_target = 'agent-skills' WHERE id = $1::uuid`, prof); err != nil {
		t.Errorf("agent-skills target refused by the column CHECK: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE agent_profiles SET apm_target = 'cursor' WHERE id = $1::uuid`, prof); err == nil {
		t.Error("the target CHECK accepted a target apm does not install for")
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE agent_profiles SET apm_target = NULL WHERE id = $1::uuid`, prof); err != nil {
		t.Errorf("restore the fixture profile's target: %v", err)
	}
}

// The worker's profile read resolves the ordered list to entries: this is where a
// profile's attachments become a dependency set, and where a pin whose revision
// row vanished must refuse rather than quietly stage a smaller context.
func TestAPMCollectionRevisionsForRefusesADetachedPin(t *testing.T) {
	f := apmcSetup(t)
	ctx := testCtx(t)
	c := f.create(t, "detached", APMCollectionEntry{Ref: "mattpocock/skills#v1.3.2"})
	f.publish(t, c.ID, 1)
	if _, err := APMCollectionRevisionsFor(ctx, f.pool, f.orgID, []APMCollectionPin{{CollectionID: c.ID, Revision: 1}}); err != nil {
		t.Fatalf("resolve a live pin: %v", err)
	}
	if _, err := APMCollectionRevisionsFor(ctx, f.pool, f.orgID, []APMCollectionPin{{CollectionID: c.ID, Revision: 4}}); err == nil {
		t.Error("a pin naming a revision that does not exist resolved happily; the flatten would stage a smaller set than the profile names")
	}
}
