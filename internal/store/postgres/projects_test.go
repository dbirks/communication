package postgres

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// These tests run against a real PostgreSQL (the shared lab instance in its
// own database) because the properties they check — the journal and outbox
// rows committing with the state, the unique constraints behind 409s,
// membership-scoped visibility — are database semantics that a fake cannot
// demonstrate (AGENTS.md: a mocked green test never substitutes for an
// integration test).

func prjFixture(t *testing.T) (*ProjectStore, string) {
	t.Helper()
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	// Repeatable: start from an empty operational state (organizations and
	// the goose version table are left alone).
	if _, err := pool.Exec(ctx, `
		TRUNCATE outbox, domain_events, audit_events, repositories, memberships,
			projects, oidc_identities, sessions, users
		RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	var orgID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM organizations WHERE slug = 'default'`).Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	return &ProjectStore{Pool: pool}, orgID
}

func prjUser(t *testing.T, pool *pgxpool.Pool, orgID, name string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(testCtx(t), `
		INSERT INTO users (organization_id, display_name, email)
		VALUES ($1::uuid, $2, $2 || '@example.test')
		RETURNING id::text`, orgID, name).Scan(&id)
	if err != nil {
		t.Fatalf("insert user %q: %v", name, err)
	}
	return id
}

// prjUsers returns two members of the default organization plus one member of
// a second organization, to prove cross-organization invisibility.
func prjUsers(t *testing.T, store *ProjectStore, orgID string) (a, b, otherOrgID, otherUser string) {
	t.Helper()
	ctx := testCtx(t)
	a = prjUser(t, store.Pool, orgID, "alice")
	b = prjUser(t, store.Pool, orgID, "bob")

	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO organizations (id, slug, name)
		VALUES ('00000000-0000-7000-8000-000000000002', 'second', 'Second organization')
		ON CONFLICT (slug) DO NOTHING`); err != nil {
		t.Fatalf("insert second org: %v", err)
	}
	otherOrgID = "00000000-0000-7000-8000-000000000002"
	otherUser = prjUser(t, store.Pool, otherOrgID, "mallory")
	return
}

func prjCount(t *testing.T, store *ProjectStore, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := store.Pool.QueryRow(testCtx(t), query, args...).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return n
}

func prjCreateProject(t *testing.T, store *ProjectStore, callerID, orgID, name, slug string) Project {
	t.Helper()
	p, err := store.CreateProject(testCtx(t), Caller{UserID: callerID, OrganizationID: orgID}, name, slug, "")
	if err != nil {
		t.Fatalf("CreateProject(%q): %v", name, err)
	}
	return p
}

// TestProjectCreateWritesStateAndJournalInOneTransaction is the M1 journal
// guarantee: project row, maintainer membership, domain_events row and outbox
// row either all exist or none do (communication-spec/09-api-events-data.md).
func TestProjectCreateWritesStateAndJournalInOneTransaction(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)

	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")

	var dbID, dbSlug, dbName, myRole, actorKind, actorID, eventType, payload string
	var version int
	var createdAt time.Time
	err := store.Pool.QueryRow(ctx, `
		SELECT p.id::text, p.slug, p.name, p.version, m.role, p.created_at
		FROM projects p JOIN memberships m ON m.project_id = p.id
		WHERE p.slug = 'widgets' AND m.user_id = $1::uuid`, a).
		Scan(&dbID, &dbSlug, &dbName, &version, &myRole, &createdAt)
	if err != nil {
		t.Fatalf("read back project: %v", err)
	}
	if dbID != p.ID || dbSlug != "widgets" || dbName != "Widgets" {
		t.Errorf("project row = %q/%q/%q, want %q/widgets/Widgets", dbID, dbSlug, dbName, p.ID)
	}
	if version != 1 || myRole != "maintainer" {
		t.Errorf("version=%d role=%q, want 1 maintainer", version, myRole)
	}
	if createdAt.IsZero() {
		t.Error("created_at is zero")
	}

	var eventSeq int64
	err = store.Pool.QueryRow(ctx, `
		SELECT global_seq FROM domain_events
		WHERE project_id = $1::uuid AND type = 'project.created'`, p.ID).
		Scan(&eventSeq)
	if err != nil {
		t.Fatalf("project.created journal row missing: %v", err)
	}
	if err := store.Pool.QueryRow(ctx, `
		SELECT type, actor_kind, actor_id, payload->>'slug'
		FROM domain_events WHERE global_seq = $1`, eventSeq).
		Scan(&eventType, &actorKind, &actorID, &payload); err != nil {
		t.Fatalf("read journal row: %v", err)
	}
	if eventType != events.TypeProjectCreated || actorKind != "human" || actorID != a {
		t.Errorf("journal row = %q/%q/%q", eventType, actorKind, actorID)
	}
	if !strings.Contains(payload, "widgets") {
		t.Errorf("payload = %s, want it to carry the slug", payload)
	}

	var outboxSeq int64
	if err := store.Pool.QueryRow(ctx,
		`SELECT global_seq FROM outbox WHERE global_seq = $1`, eventSeq).Scan(&outboxSeq); err != nil {
		t.Fatalf("outbox row for global_seq %d missing: %v", eventSeq, err)
	}
	if outboxSeq != eventSeq {
		t.Errorf("outbox global_seq = %d, want %d", outboxSeq, eventSeq)
	}
	if n := prjCount(t, store, `SELECT count(*) FROM outbox`); n != 1 {
		t.Errorf("outbox rows = %d, want 1 (one per event)", n)
	}
}

func TestProjectCreateDuplicateSlugIsConflict(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, b, _, _ := prjUsers(t, store, orgID)

	prjCreateProject(t, store, a, orgID, "Widgets", "widgets")

	if _, err := store.CreateProject(ctx, Caller{UserID: b, OrganizationID: orgID}, "Other", "widgets", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("CreateProject duplicate slug error = %v, want ErrConflict", err)
	}
	// A rolled-back create must leave no journal row either.
	if n := prjCount(t, store, `SELECT count(*) FROM domain_events WHERE type = 'project.created'`); n != 1 {
		t.Errorf("project.created rows = %d, want 1 (failed create wrote nothing)", n)
	}
	if n := prjCount(t, store, `SELECT count(*) FROM projects`); n != 1 {
		t.Errorf("projects = %d, want 1", n)
	}
}

func TestProjectInvisibleToNonMemberAndDenialIsAudited(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, b, otherOrgID, mallory := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	stranger := Caller{UserID: b, OrganizationID: orgID}

	if _, err := store.GetProject(ctx, stranger, p.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("GetProject as non-member = %v, want ErrProjectNotFound", err)
	}
	// The answer for "not a member" must be indistinguishable from "no such
	// project", including for a caller in another organization.
	if _, err := store.GetProject(ctx, Caller{UserID: mallory, OrganizationID: otherOrgID}, p.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("GetProject cross-organization = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.GetProject(ctx, stranger, "not-a-uuid"); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("GetProject malformed id = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.ListRepositories(ctx, stranger, p.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("ListRepositories as non-member = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.ListMembers(ctx, stranger, p.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("ListMembers as non-member = %v, want ErrProjectNotFound", err)
	}

	if err := store.RecordDenied(ctx, stranger, p.ID, "project.get"); err != nil {
		t.Fatalf("RecordDenied: %v", err)
	}
	// A malformed project id must still be auditable, without a project ref.
	if err := store.RecordDenied(ctx, Caller{UserID: mallory, OrganizationID: otherOrgID}, "garbage", "project.get"); err != nil {
		t.Fatalf("RecordDenied malformed id: %v", err)
	}

	var outcome, action, actorKind, detail string
	var projectID *string
	err := store.Pool.QueryRow(ctx, `
		SELECT outcome, action, actor_kind, project_id::text, detail::text
		FROM audit_events WHERE actor_id = $1 AND outcome = 'denied'`, b).
		Scan(&outcome, &action, &actorKind, &projectID, &detail)
	if err != nil {
		t.Fatalf("no denied audit row for bob: %v", err)
	}
	if action != "project.get" || outcome != "denied" || actorKind != "human" {
		t.Errorf("audit row = %q/%q/%q", action, outcome, actorKind)
	}
	if projectID == nil || *projectID != p.ID {
		t.Errorf("audit project_id = %v, want %s", projectID, p.ID)
	}
	if !strings.Contains(detail, "project.get") {
		t.Errorf("audit detail = %q, want it to name the action", detail)
	}
	if n := prjCount(t, store, `SELECT count(*) FROM audit_events WHERE project_id IS NULL AND outcome = 'denied'`); n != 1 {
		t.Errorf("audit rows with no project = %d, want 1 (malformed id recorded without a project ref)", n)
	}
}

func TestProjectOrgAdminSeesEveryProjectAsMaintainer(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, admin, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")

	caller := Caller{UserID: admin, OrganizationID: orgID, IsOrgAdmin: true}
	got, err := store.GetProject(ctx, caller, p.ID)
	if err != nil {
		t.Fatalf("GetProject as org admin: %v", err)
	}
	if got.MyRole != "maintainer" {
		t.Errorf("admin MyRole = %q, want maintainer", got.MyRole)
	}
	// An org admin with no membership can still add a repository.
	if _, err := store.AddRepository(ctx, caller, p.ID, "communication",
		"https://github.com/example/communication.git", "main", ""); err != nil {
		t.Errorf("AddRepository as org admin: %v", err)
	}
}

func TestProjectRepositoriesAppendEventsInOrder(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := journalCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}

	for _, name := range []string{"api", "ui"} {
		if _, err := store.AddRepository(ctx, caller, p.ID, name,
			"git@github.com:example/"+name+".git", "main", ""); err != nil {
			t.Fatalf("AddRepository(%q): %v", name, err)
		}
	}

	repos, err := store.ListRepositories(ctx, caller, p.ID)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	if len(repos) != 2 || repos[0].Name != "api" || repos[1].Name != "ui" {
		t.Fatalf("repositories = %+v, want [api ui] ordered by name", repos)
	}
	if repos[0].ProjectID != p.ID || repos[0].DefaultBranch != "main" ||
		repos[0].GitURL != "git@github.com:example/api.git" {
		t.Errorf("repository row = %+v", repos[0])
	}
	if repos[0].CreatedAt.IsZero() || repos[0].CreatedAt.Location() != time.UTC {
		t.Errorf("repository created_at = %v, want UTC", repos[0].CreatedAt)
	}

	// The journal read below happens exactly once, and the gap-safety filter of
	// ADR-0014 §9 says a committed row is only readable after the cluster-wide
	// watermark passes its transaction — a watermark any open write transaction
	// in any other database of the cluster holds back. The SSE reader polls for
	// that; a one-shot assertion has to wait for it explicitly.
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p.ID)
	evs, err := store.EventsAfter(ctx, p.ID, 0, 0)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	if len(evs) != 3 {
		t.Fatalf("events = %d (%v), want project.created + 2 repository.added", len(evs), evs)
	}
	if evs[0].Type != events.TypeProjectCreated {
		t.Errorf("first event = %q, want project.created", evs[0].Type)
	}
	var names []string
	for i, e := range evs[1:] {
		if e.Type != events.TypeRepositoryAdded {
			t.Errorf("event %d type = %q, want repository.added", i+1, e.Type)
		}
		if e.ProjectID != p.ID || e.OrganizationID != orgID {
			t.Errorf("event %d scope = %q/%q, want %q/%q", i, e.ProjectID, e.OrganizationID, p.ID, orgID)
		}
		if e.Actor.Kind != "human" || e.Actor.ID != a {
			t.Errorf("event %d actor = %+v", i, e.Actor)
		}
		if e.EventID == "" || e.SchemaVersion != 1 || e.OccurredAt.IsZero() {
			t.Errorf("event %d envelope = %+v", i, e)
		}
		payload := prjPayloadMap(t, e.Payload)
		if _, ok := payload["repository_id"]; !ok {
			t.Errorf("event %d payload = %v, want repository_id", i, payload)
		}
		names = append(names, prjStringOr(payload["name"]))
	}
	if strings.Join(names, ",") != "api,ui" {
		t.Errorf("repository.added payloads in order = %v, want [api ui]", names)
	}
	for i := 1; i < len(evs); i++ {
		if evs[i].GlobalSeq <= evs[i-1].GlobalSeq {
			t.Fatalf("global_seq not increasing: %d then %d", evs[i-1].GlobalSeq, evs[i].GlobalSeq)
		}
	}
	if n := prjCount(t, store, `SELECT count(*) FROM outbox`); n != 3 {
		t.Errorf("outbox rows = %d, want one per event (3)", n)
	}

	// Replay from a cursor: only what came after it.
	tail, err := store.EventsAfter(ctx, p.ID, evs[1].GlobalSeq, 10)
	if err != nil {
		t.Fatalf("EventsAfter(cursor): %v", err)
	}
	if len(tail) != 1 || tail[0].GlobalSeq != evs[2].GlobalSeq {
		t.Fatalf("tail = %+v, want exactly the last event", tail)
	}
	// A cursor past the end, and a project the caller cannot see, are both empty.
	none, err := store.EventsAfter(ctx, p.ID, evs[2].GlobalSeq, 10)
	if err != nil || len(none) != 0 {
		t.Errorf("EventsAfter(past end) = %v, %v; want empty", none, err)
	}
	other := prjCreateProject(t, store, a, orgID, "Others", "others")
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", other.ID)
	if evs, err := store.EventsAfter(ctx, other.ID, 0, 0); err != nil || len(evs) != 1 || evs[0].Type != events.TypeProjectCreated {
		t.Errorf("EventsAfter(other project) = %v, %v; want only that project's 1 event (no cross-project leak)", evs, err)
	}
	if _, err := store.EventsAfter(ctx, "not-a-uuid", 0, 10); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("EventsAfter malformed id = %v, want ErrProjectNotFound", err)
	}
}

func TestProjectRepositoryDuplicateNameRollsBack(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}

	if _, err := store.AddRepository(ctx, caller, p.ID, "api", "https://host/api.git", "main", ""); err != nil {
		t.Fatalf("first AddRepository: %v", err)
	}
	before := prjCount(t, store, `SELECT count(*) FROM domain_events`)

	if _, err := store.AddRepository(ctx, caller, p.ID, "api", "https://host/other.git", "main", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate repository name error = %v, want ErrConflict", err)
	}
	// The transaction rolled back, so the failed insert appended nothing.
	if after := prjCount(t, store, `SELECT count(*) FROM domain_events`); after != before {
		t.Errorf("domain_events = %d after a failed insert, want unchanged %d", after, before)
	}
	if n := prjCount(t, store, `SELECT count(*) FROM repositories WHERE project_id = $1::uuid`, p.ID); n != 1 {
		t.Errorf("repositories = %d, want 1", n)
	}
	// A failed add must not bump the project version either.
	got, err := store.GetProject(ctx, caller, p.ID)
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}
	if want := 2; got.Version != want { // 1 at create + 1 for the one successful add
		t.Errorf("project version = %d, want %d", got.Version, want)
	}
}

func TestProjectPutMemberGrantsVisibilityToContributor(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, b, _, mallory := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	maintainer := Caller{UserID: a, OrganizationID: orgID}
	contributor := Caller{UserID: b, OrganizationID: orgID}

	if _, err := store.GetProject(ctx, contributor, p.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("before: GetProject as non-member = %v, want ErrProjectNotFound", err)
	}

	member, err := store.PutMember(ctx, maintainer, p.ID, b, "contributor")
	if err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	if member.UserID != b || member.Role != "contributor" || member.DisplayName != "bob" {
		t.Errorf("member = %+v, want {b contributor bob}", member)
	}

	got, err := store.GetProject(ctx, contributor, p.ID)
	if err != nil {
		t.Fatalf("after: GetProject as new member: %v", err)
	}
	if got.MyRole != "contributor" {
		t.Errorf("MyRole = %q, want contributor", got.MyRole)
	}
	// Read-only: a contributor cannot add a repository or change roles...
	if _, err := store.AddRepository(ctx, contributor, p.ID, "ui", "https://host/ui.git", "main", ""); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("AddRepository as contributor = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.PutMember(ctx, contributor, p.ID, b, "maintainer"); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("PutMember as contributor = %v, want ErrProjectNotFound", err)
	}
	// ...but sees the project, its repositories and its members.
	if _, err := store.ListRepositories(ctx, contributor, p.ID); err != nil {
		t.Errorf("ListRepositories as contributor: %v", err)
	}
	members, err := store.ListMembers(ctx, contributor, p.ID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 2 || members[0].DisplayName != "alice" || members[0].Role != "maintainer" ||
		members[1].DisplayName != "bob" || members[1].Role != "contributor" {
		t.Errorf("members = %+v, want [alice maintainer, bob contributor] by display name", members)
	}

	// Upsert, not duplicate insert.
	if _, err := store.PutMember(ctx, maintainer, p.ID, b, "viewer"); err != nil {
		t.Fatalf("PutMember role change: %v", err)
	}
	if n := prjCount(t, store,
		`SELECT count(*) FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`, p.ID, b); n != 1 {
		t.Errorf("memberships for bob = %d, want 1 (upsert)", n)
	}
	if got, err := store.GetProject(ctx, contributor, p.ID); err != nil || got.MyRole != "viewer" {
		t.Errorf("after change: MyRole = %q err = %v, want viewer", got.MyRole, err)
	}
	// A caller from another organization, and an unknown user, are not
	// addable and not distinguishable from a missing project.
	if _, err := store.PutMember(ctx, maintainer, p.ID, mallory, "viewer"); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("PutMember cross-organization = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.PutMember(ctx, maintainer, p.ID, "00000000-0000-7000-8000-0000000000ff", "viewer"); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("PutMember unknown user = %v, want ErrProjectNotFound", err)
	}
	if _, err := store.PutMember(ctx, maintainer, p.ID, b, "owner"); err == nil ||
		errors.Is(err, ErrProjectNotFound) || errors.Is(err, ErrConflict) {
		t.Errorf("PutMember invalid role = %v, want a plain validation error", err)
	}

	// Both membership changes land in the journal.
	var n int
	if err := store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE type = 'project.member.updated'`).Scan(&n); err != nil {
		t.Fatalf("count member events: %v", err)
	}
	if n != 2 {
		t.Errorf("project.member.updated events = %d, want 2", n)
	}
}

func TestProjectEventsAfterTruncatesToLimit(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := journalCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}
	for _, name := range []string{"one", "two", "three"} {
		if _, err := store.AddRepository(ctx, caller, p.ID, name, "https://host/"+name+".git", "", ""); err != nil {
			t.Fatalf("AddRepository(%q): %v", name, err)
		}
	}
	// Same one-shot read, same gate: the four rows this test just committed are
	// readable as soon as the cluster watermark passes them.
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p.ID)
	page, err := store.EventsAfter(ctx, p.ID, 0, 2)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	if len(page) != 2 || page[0].Type != events.TypeProjectCreated {
		t.Fatalf("page = %+v, want the first two events oldest-first", page)
	}
	// default_branch '' falls back to main in the store.
	repos, err := store.ListRepositories(ctx, caller, p.ID)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	if len(repos) != 3 || repos[0].DefaultBranch != "main" {
		t.Errorf("repositories = %+v, want 3 with default_branch main", repos)
	}
	// Every journal row is schema-valid JSON: the envelope's required members
	// are present when the row is marshalled from what we read back.
	raw, err := json.Marshal(page[1])
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	for _, want := range []string{`"event_id"`, `"global_seq"`, `"type"`, `"schema_version"`,
		`"occurred_at"`, `"organization_id"`, `"project_id"`, `"actor"`, `"payload"`, `"kind"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("envelope JSON %s missing %s", raw, want)
		}
	}
}

// TestProjectAPIStoreConversionDrivesTheHandlers checks the adapter that lets
// package api use this store without importing it: view conversion plus the
// sentinel errors the HTTP layer switches on.
func TestProjectAPIStoreConversionDrivesTheHandlers(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, b, _, _ := prjUsers(t, store, orgID)
	adapter := APIProjectStore{S: store}
	maintainer := api.Caller{UserID: a, OrganizationID: orgID}
	stranger := api.Caller{UserID: b, OrganizationID: orgID}

	created, err := adapter.CreateProject(ctx, maintainer, "Widgets", "widgets", "Widget incubator")
	if err != nil {
		t.Fatalf("adapter.CreateProject: %v", err)
	}
	if created.ID == "" || created.Slug != "widgets" || created.MyRole != "maintainer" || created.Version != 1 {
		t.Errorf("view = %+v", created)
	}
	if _, err := adapter.CreateProject(ctx, stranger, "Clash", "widgets", ""); !errors.Is(err, api.ErrProjectConflict) {
		t.Errorf("duplicate slug through adapter = %v, want api.ErrProjectConflict", err)
	}
	if _, err := adapter.GetProject(ctx, stranger, created.ID); !errors.Is(err, api.ErrProjectNotFound) {
		t.Errorf("non-member through adapter = %v, want api.ErrProjectNotFound", err)
	}
	repo, err := adapter.AddRepository(ctx, maintainer, created.ID, "api", "https://host/api.git", "main", "")
	if err != nil {
		t.Fatalf("adapter.AddRepository: %v", err)
	}
	if repo.ProjectID != created.ID || repo.ID == "" {
		t.Errorf("repository view = %+v", repo)
	}
	repos, err := adapter.ListRepositories(ctx, maintainer, created.ID)
	if err != nil || len(repos) != 1 || repos[0].Name != "api" {
		t.Errorf("adapter.ListRepositories = %v, %v", repos, err)
	}
	member, err := adapter.PutMember(ctx, maintainer, created.ID, b, "viewer")
	if err != nil || member.UserID != b || member.Role != "viewer" {
		t.Errorf("adapter.PutMember = %+v, %v", member, err)
	}
	members, err := adapter.ListMembers(ctx, maintainer, created.ID)
	if err != nil || len(members) != 2 {
		t.Errorf("adapter.ListMembers = %v, %v", members, err)
	}
	if err := adapter.RecordDenied(ctx, stranger, created.ID, "project.get"); err != nil {
		t.Errorf("adapter.RecordDenied: %v", err)
	}
	if n := prjCount(t, store, `SELECT count(*) FROM audit_events WHERE outcome = 'denied'`); n != 1 {
		t.Errorf("denied audit rows = %d, want 1", n)
	}
	projects, err := adapter.ListProjects(ctx, maintainer)
	if err != nil || len(projects) != 1 || projects[0].ID != created.ID {
		t.Errorf("adapter.ListProjects = %v, %v", projects, err)
	}

	// A store with no pool is a wiring bug, reported as an error rather than
	// a panic.
	if _, err := (APIProjectStore{}).ListProjects(ctx, maintainer); err == nil {
		t.Error("APIProjectStore without a pool reported no error")
	}
}

func prjPayloadMap(t *testing.T, payload any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("payload %s is not a JSON object: %v", raw, err)
	}
	return m
}

func prjStringOr(v any) string {
	s, _ := v.(string)
	return s
}

// --- ADR-0086: the project's default agent profile -----------------------

// prjSeedProfile inserts one agent profile in an organization and returns its
// id. The name is unique per call because agent_profiles enforces
// UNIQUE (organization_id, name).
func prjSeedProfile(t *testing.T, store *ProjectStore, orgID, label string) string {
	t.Helper()
	var id string
	if err := store.Pool.QueryRow(testCtx(t), `
		INSERT INTO agent_profiles (organization_id, name, launcher_id)
		VALUES ($1::uuid, $2, 'claude') RETURNING id::text`, orgID, label+" "+genUUID()).Scan(&id); err != nil {
		t.Fatalf("insert agent profile %q: %v", label, err)
	}
	return id
}

// prjSetDefault moves only the ADR-0086 default: id set, id clear (nil with the
// named flag), version CAS.
func prjSetDefault(t *testing.T, store *ProjectStore, c Caller, projectID, id string, version int) (Project, error) {
	t.Helper()
	var profile *string
	if id != "" {
		profile = &id
	}
	return store.SetProjectSettings(testCtx(t), c, projectID, ProjectSettings{
		DefaultAgentProfileSet: true,
		DefaultAgentProfileID:  profile,
	}, version)
}

// prjDefaultEvents reads the project.default_agent.changed rows of one project
// oldest first, past the journal's readable horizon.
func prjDefaultEvents(t *testing.T, store *ProjectStore, projectID string) []events.Envelope {
	t.Helper()
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid AND e.type = $2",
		projectID, events.TypeProjectDefaultAgentChanged)
	page, err := store.EventsAfter(journalCtx(t), projectID, 0, 0)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	out := make([]events.Envelope, 0, len(page))
	for _, e := range page {
		if e.Type == events.TypeProjectDefaultAgentChanged {
			out = append(out, e)
		}
	}
	return out
}

// TestProjectDefaultAgentSetClearAndJournal is ADR-0086's write path against a
// real Postgres: the read returns the id AND the joined name, the write is
// journaled in the same transaction with the old and the new value, JSON null
// clears, and ON DELETE SET NULL makes a deleted profile read as "no default".
func TestProjectDefaultAgentSetClearAndJournal(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}

	// A new project has no default, and the read says so with a nil, not a "".
	if p.DefaultAgentProfileID != nil || p.DefaultAgentProfileName != nil {
		t.Fatalf("new project default = %v/%v, want NULL/NULL", p.DefaultAgentProfileID, p.DefaultAgentProfileName)
	}

	profile := prjSeedProfile(t, store, orgID, "Claude Default")
	got, err := prjSetDefault(t, store, caller, p.ID, profile, 1)
	if err != nil {
		t.Fatalf("set default: %v", err)
	}
	if got.Version != 2 {
		t.Errorf("version = %d, want 2 (one bump for one write)", got.Version)
	}
	if got.DefaultAgentProfileID == nil || *got.DefaultAgentProfileID != profile {
		t.Errorf("default id = %v, want %s", got.DefaultAgentProfileID, profile)
	}
	if got.DefaultAgentProfileName == nil || *got.DefaultAgentProfileName !=
		storeName(t, store, profile) {
		t.Errorf("default name = %v, want the joined profile name", got.DefaultAgentProfileName)
	}

	// The journal row exists, is human-acted, and carries both ids.
	rows := prjDefaultEvents(t, store, p.ID)
	if len(rows) != 1 {
		t.Fatalf("default-agent journal rows = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.Actor.Kind != "human" || row.Actor.ID != a {
		t.Errorf("event actor = %+v, want the maintainer as a human", row.Actor)
	}
	payload := prjPayloadMap(t, row.Payload)
	if payload["project_id"] != p.ID {
		t.Errorf("payload project_id = %v, want %s", payload["project_id"], p.ID)
	}
	if payload["default_agent_profile_id"] != profile {
		t.Errorf("payload new id = %v, want %s", payload["default_agent_profile_id"], profile)
	}
	if prev, ok := payload["previous_default_agent_profile_id"]; !ok || prev != nil {
		t.Errorf("payload previous id = %v (present=%v), want an explicit JSON null", prev, ok)
	}
	if payload["actor_user_id"] != a {
		t.Errorf("payload actor_user_id = %v, want %s (ADR-0086 § 4)", payload["actor_user_id"], a)
	}

	// JSON null clears it, and the second journal row says what it used to be.
	cleared, err := prjSetDefault(t, store, caller, p.ID, "", 2)
	if err != nil {
		t.Fatalf("clear default: %v", err)
	}
	if cleared.DefaultAgentProfileID != nil || cleared.DefaultAgentProfileName != nil {
		t.Errorf("cleared default = %v/%v, want NULL/NULL", cleared.DefaultAgentProfileID, cleared.DefaultAgentProfileName)
	}
	rows = prjDefaultEvents(t, store, p.ID)
	if len(rows) != 2 {
		t.Fatalf("default-agent journal rows = %d, want 2", len(rows))
	}
	payload = prjPayloadMap(t, rows[1].Payload)
	if got := prjStringOr(payload["previous_default_agent_profile_id"]); got != profile {
		t.Errorf("payload previous id = %v, want %s", payload["previous_default_agent_profile_id"], profile)
	}
	if next, ok := payload["default_agent_profile_id"]; !ok || next != nil {
		t.Errorf("payload new id = %v (present=%v), want an explicit JSON null", next, ok)
	}

	// ON DELETE SET NULL: deleting the profile the project named leaves the
	// project reading "no default" rather than a dangling id or a refused delete.
	reset, err := prjSetDefault(t, store, caller, p.ID, profile, 3)
	if err != nil {
		t.Fatalf("set default again: %v", err)
	}
	if reset.DefaultAgentProfileID == nil {
		t.Fatal("default is NULL before the delete")
	}
	if _, err := store.Pool.Exec(ctx, `DELETE FROM agent_profiles WHERE id = $1::uuid`, profile); err != nil {
		t.Fatalf("delete the profile: %v (want ON DELETE SET NULL, not a refused delete)", err)
	}
	after, err := store.GetProject(ctx, caller, p.ID)
	if err != nil {
		t.Fatalf("GetProject after the profile delete: %v", err)
	}
	if after.DefaultAgentProfileID != nil || after.DefaultAgentProfileName != nil {
		t.Errorf("default after the profile delete = %v/%v, want NULL/NULL",
			after.DefaultAgentProfileID, after.DefaultAgentProfileName)
	}
}

// storeName reads a profile's stored name, so the joined-name assertion is the
// database's answer and not the test's own string.
func storeName(t *testing.T, store *ProjectStore, profileID string) string {
	t.Helper()
	var name string
	if err := store.Pool.QueryRow(testCtx(t),
		`SELECT name FROM agent_profiles WHERE id = $1::uuid`, profileID).Scan(&name); err != nil {
		t.Fatalf("read profile name: %v", err)
	}
	return name
}

// TestProjectDefaultAgentRefusedCases pins what the write refuses and what it
// leaves behind: a profile of another organization, a malformed id and a stale
// version each answer without touching the row, and the API adapter maps the
// first two onto api.ErrAgentProfileInvalid and the third onto the 409 sentinel.
func TestProjectDefaultAgentRefusedCases(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, otherOrgID, otherUser := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}
	foreign := prjSeedProfile(t, store, otherOrgID, "Their profile")

	for _, tt := range []struct {
		name string
		id   string
		want error
	}{
		{"another organization's profile", foreign, ErrInvalidAgentProfile},
		{"an id that names nothing", "00000000-0000-7000-8000-0000000000ff", ErrInvalidAgentProfile},
		{"a malformed id", "not-a-uuid", ErrInvalidAgentProfile},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := prjSetDefault(t, store, caller, p.ID, tt.id, 1); !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
			// Nothing moved: the version is the create's 1 and there is no default.
			cur, err := store.GetProject(ctx, caller, p.ID)
			if err != nil {
				t.Fatalf("GetProject: %v", err)
			}
			if cur.Version != 1 || cur.DefaultAgentProfileID != nil {
				t.Errorf("project after the refusal = version %d default %v, want 1/NULL",
					cur.Version, cur.DefaultAgentProfileID)
			}
		})
	}
	if n := prjCount(t, store,
		`SELECT count(*) FROM domain_events WHERE type = $1`, events.TypeProjectDefaultAgentChanged); n != 0 {
		t.Errorf("journal rows for refused writes = %d, want 0", n)
	}

	// A stale version is the same 409 sentinel the mail setting uses, and a
	// non-member gets the same not-found answer as every other project read.
	mine := prjSeedProfile(t, store, orgID, "Ours")
	if _, err := prjSetDefault(t, store, caller, p.ID, mine, 99); !errors.Is(err, ErrConflict) {
		t.Errorf("stale version err = %v, want ErrConflict", err)
	}
	stranger := Caller{UserID: otherUser, OrganizationID: otherOrgID}
	if _, err := prjSetDefault(t, store, stranger, p.ID, mine, 1); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("other organization's caller err = %v, want ErrProjectNotFound", err)
	}

	// The adapter maps the store's refusals onto the sentinels package api
	// switches on: 400 invalid_agent_profile and the 409.
	adapter := APIProjectStore{S: store}
	maintainer := api.Caller{UserID: a, OrganizationID: orgID}
	_, err := adapter.SetProjectSettings(ctx, maintainer, p.ID, api.ProjectSettingsPatch{
		DefaultAgentProfileSet: true,
		DefaultAgentProfileID:  &foreign,
	}, 1)
	if !errors.Is(err, api.ErrAgentProfileInvalid) {
		t.Errorf("adapter foreign profile err = %v, want api.ErrAgentProfileInvalid", err)
	}
	if _, err := adapter.SetProjectSettings(ctx, maintainer, p.ID,
		api.ProjectSettingsPatch{}, 1); err == nil {
		t.Error("adapter accepted a patch that names no setting, want an error")
	}
}

// TestProjectSettingsMailOnlyPatchStillWorks is ADR-0086's compatibility rule:
// the old body (agent_mail_enabled + version) still moves the switch, still
// bumps the version once, and still appends no journal row — while a body that
// names both settings moves both in the one write.
func TestProjectSettingsMailOnlyPatchStillWorks(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Widgets", "widgets")
	caller := Caller{UserID: a, OrganizationID: orgID}

	on := true
	got, err := store.SetProjectSettings(ctx, caller, p.ID,
		ProjectSettings{AgentMailEnabled: &on}, 1)
	if err != nil {
		t.Fatalf("mail-only patch: %v", err)
	}
	if !got.AgentMailEnabled || got.Version != 2 {
		t.Errorf("after the mail-only patch: enabled=%v version=%d, want true/2", got.AgentMailEnabled, got.Version)
	}
	if got.DefaultAgentProfileID != nil {
		t.Errorf("default = %v, want NULL: a body that did not name it left it alone", got.DefaultAgentProfileID)
	}
	if n := prjCount(t, store,
		`SELECT count(*) FROM domain_events WHERE type = $1`, events.TypeProjectDefaultAgentChanged); n != 0 {
		t.Errorf("journal rows for a mail-only patch = %d, want 0 (the setting is read where it is enforced)", n)
	}

	// Both settings, one body, one version bump.
	profile := prjSeedProfile(t, store, orgID, "Both")
	off := false
	both, err := store.SetProjectSettings(ctx, caller, p.ID, ProjectSettings{
		AgentMailEnabled:       &off,
		DefaultAgentProfileSet: true,
		DefaultAgentProfileID:  &profile,
	}, 2)
	if err != nil {
		t.Fatalf("both-settings patch: %v", err)
	}
	if both.AgentMailEnabled || both.DefaultAgentProfileID == nil || *both.DefaultAgentProfileID != profile {
		t.Errorf("after both: mail=%v default=%v, want false/%s", both.AgentMailEnabled, both.DefaultAgentProfileID, profile)
	}
	if both.Version != 3 {
		t.Errorf("version after one body that moved two settings = %d, want 3 (one bump)", both.Version)
	}
	if rows := prjDefaultEvents(t, store, p.ID); len(rows) != 1 {
		t.Errorf("journal rows = %d, want 1", len(rows))
	}

	// A patch that names nothing is a store-level wiring bug, not a write.
	if _, err := store.SetProjectSettings(ctx, caller, p.ID, ProjectSettings{}, 3); err == nil {
		t.Error("SetProjectSettings accepted a body that names no setting")
	}
}
