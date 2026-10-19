package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
)

// These run against a real PostgreSQL because everything M2 promises is database
// semantics: a compare-and-swap that only one transaction can win, one active
// turn per conversation enforced by an index rather than by manners, a journal
// read that cannot show a hole, and an interrupted turn that cannot borrow a
// stop reason. A fake would demonstrate the shape of the code and none of it
// (AGENTS.md: a mocked green test never substitutes for an integration test).
//
// Rows are named after the test so two runs against the shared lab database
// cannot decide each other's outcome, and every fixture deletes what it made.

type cnvFixture struct {
	t       *testing.T
	pool    *pgxpool.Pool
	store   *CnvStore
	events  *ProjectStore
	orgID   string
	project string
	profile string
	worker  string
	mallory string
	// extra holds users this fixture created beyond the named ones, so cleanup
	// stays by-id.
	extra []string

	alice    string // maintainer, creator
	bob      string // contributor
	carl     string // viewer
	outsider string // same organization, not a project member
	elseOrg  string // another organization entirely
}

func cnvSetup(t *testing.T) *cnvFixture {
	t.Helper()
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	f := &cnvFixture{t: t, pool: pool, store: &CnvStore{Pool: pool}, events: &ProjectStore{Pool: pool}}
	token := migFixtureToken(t)

	if err := pool.QueryRow(ctx, "SELECT id FROM organizations WHERE slug = 'default'").Scan(&f.orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	f.alice = cnvUser(t, pool, f.orgID, "cnv-alice-"+token)
	f.bob = cnvUser(t, pool, f.orgID, "cnv-bob-"+token)
	f.carl = cnvUser(t, pool, f.orgID, "cnv-carl-"+token)
	f.outsider = cnvUser(t, pool, f.orgID, "cnv-outsider-"+token)

	// A second organization, at the fixed id internal/store/postgres/
	// projects_test.go already uses for it. It is created IF NOT EXISTS and never
	// dropped: an id/slug per test would collide with itself across runs, and a
	// fixture that deletes a shared row can only break the test that runs next.
	const otherOrg = "00000000-0000-7000-8000-000000000002"
	if _, err := pool.Exec(ctx, `
		INSERT INTO organizations (id, slug, name)
		VALUES ($1, 'second', 'Second organization')
		ON CONFLICT (id) DO NOTHING`, otherOrg); err != nil {
		t.Fatalf("insert second org: %v", err)
	}
	f.elseOrg = otherOrg
	mallory := cnvUser(t, pool, otherOrg, "cnv-mallory-"+token)

	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'cnv-proj-' || $2, 'Conversation fixture', $3) RETURNING id`,
		f.orgID, token, f.alice).Scan(&f.project); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	for user, role := range map[string]string{
		f.alice: string(authz.RoleMaintainer),
		f.bob:   string(authz.RoleContributor),
		f.carl:  string(authz.RoleViewer),
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)`,
			f.project, user, role); err != nil {
			t.Fatalf("membership for %s: %v", user, err)
		}
	}
	if err := pool.QueryRow(ctx, `
		SELECT id FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`,
		f.orgID).Scan(&f.profile); err != nil {
		t.Fatalf("seeded profile lookup (migration 00003): %v", err)
	}
	// A live worker: the reconciler's liveness rule reads last_heartbeat_at, and
	// a test that left it at its default would be testing the fixture.
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status, last_heartbeat_at)
		VALUES ('cnv-worker-' || $1, 'lab', 'dev', 'online', now()) RETURNING id::text`,
		token).Scan(&f.worker); err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	f.mallory = mallory

	t.Cleanup(func() { f.delete() })
	return f
}

// delete removes exactly what the fixture created, in dependency order. The
// outbox is first because it references the journal by global_seq, and the
// organization last because a single leftover user would keep it alive — and a
// failed cleanup is reported, because a fixture that leaks rows makes the next
// test's assertions lie.
func (f *cnvFixture) delete() {
	bg := context.Background()
	token := migFixtureToken(f.t)
	conversations := "SELECT id FROM conversations WHERE project_id = $1"
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE conversation_id = ANY(" + conversations + "))", []any{f.project}},
		{"DELETE FROM permission_requests WHERE conversation_id IN (" + conversations + ")", []any{f.project}},
		{"DELETE FROM acp_session_bindings WHERE conversation_id IN (" + conversations + ")", []any{f.project}},
		{"DELETE FROM conversation_turns WHERE conversation_id IN (" + conversations + ")", []any{f.project}},
		{"DELETE FROM conversation_control WHERE conversation_id IN (" + conversations + ")", []any{f.project}},
		{"DELETE FROM domain_events WHERE conversation_id = ANY(" + conversations + ")", []any{f.project}},
		{"DELETE FROM audit_events WHERE project_id = $1", []any{f.project}},
		{"DELETE FROM conversations WHERE project_id = $1", []any{f.project}},
		{"DELETE FROM memberships WHERE project_id = $1", []any{f.project}},
		{"DELETE FROM projects WHERE id = $1", []any{f.project}},
		{"DELETE FROM workers WHERE name = $1", []any{"cnv-worker-" + token}},
		// Users by id, not by name pattern: a LIKE over a shared database deletes
		// whoever else's fixture is running, and their failure would read as mine.
		{"DELETE FROM users WHERE id = ANY($1::uuid[])", []any{append([]string{f.alice, f.bob, f.carl, f.outsider, f.mallory}, f.extra...)}},
	} {
		if _, err := f.pool.Exec(bg, q.sql, q.args...); err != nil {
			f.t.Errorf("cleanup %q: %v", q.sql, err)
		}
	}
}

func cnvUser(t *testing.T, pool *pgxpool.Pool, orgID, name string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(testCtx(t),
		`INSERT INTO users (organization_id, display_name) VALUES ($1::uuid, $2) RETURNING id::text`,
		orgID, name).Scan(&id); err != nil {
		t.Fatalf("insert user %q: %v", name, err)
	}
	return id
}

func (f *cnvFixture) caller(user string) Caller {
	return Caller{UserID: user, OrganizationID: f.orgID}
}

// --- conversation helpers ------------------------------------------------

// cnvCreate starts a conversation as its creator, which is also how it takes
// control: the create path is the one place version 1 comes from.
func (f *cnvFixture) cnvCreate(t *testing.T, user, title, prompt string) CnvConversation {
	t.Helper()
	chat, err := f.store.CreateConversation(testCtx(t), f.caller(user), f.project, f.profile, title, prompt)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	return chat
}

func (f *cnvFixture) ctx() context.Context { return testCtx(f.t) }

func (f *cnvFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(testCtx(t), q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func (f *cnvFixture) queryRow(t *testing.T, q string, args ...any) pgxRow {
	t.Helper()
	return pgxRow{f.pool.QueryRow(testCtx(t), q, args...)}
}

// pgxRow exists so a test can read a row and get one clear failure instead of a
// scan error string.
type pgxRow struct {
	scanner interface{ Scan(dest ...any) error }
}

func (r pgxRow) into(t *testing.T, dest ...any) {
	t.Helper()
	if err := r.scanner.Scan(dest...); err != nil {
		t.Fatalf("scan: %v", err)
	}
}

// cnvSimulateClaim writes what a worker writes when it takes a turn, through the
// same SQL the claim uses (internal/store/postgres/turns.go), so the store is
// tested against the state a real claim produces rather than a hand-drawn one.
func (f *cnvFixture) cnvClaim(t *testing.T, turnID, workerID string, lease time.Duration) int64 {
	t.Helper()
	var token int64
	f.queryRow(t, `
		UPDATE conversation_turns
		SET status = 'leased', worker_id = $2::uuid,
		    lease_expires_at = now() + make_interval(secs => $3::double precision),
		    fencing_token = nextval('conversation_turn_fencing_seq')
		WHERE id = $1::uuid AND status = 'queued'
		RETURNING fencing_token`, turnID, workerID, lease.Seconds()).into(t, &token)
	return token
}

func (f *cnvFixture) cnvRunning(t *testing.T, turnID string) {
	t.Helper()
	f.exec(t, `
		UPDATE conversation_turns SET status = 'running', started_at = now()
		WHERE id = $1::uuid`, turnID)
}

// cnvAttachBinding records the ACP session a worker reported for a conversation.
func (f *cnvFixture) cnvAttachBinding(t *testing.T, conversationID, workerID, sessionID string, caps string) string {
	t.Helper()
	if caps == "" {
		caps = `{"loadSession":true,"promptCapabilities":{"image":true}}`
	}
	var id string
	f.queryRow(t, `
		INSERT INTO acp_session_bindings
			(conversation_id, worker_id, acp_session_id, protocol_version, agent_capabilities,
			 launcher_id, launcher_version, session_origin, status)
		VALUES ($1::uuid, $2::uuid, $3, 1, $4::jsonb, 'claude', '1.2.3', 'new', 'connected')
		RETURNING id::text`, conversationID, workerID, sessionID, caps).into(t, &id)
	f.exec(t, `UPDATE conversations SET status = 'active' WHERE id = $1::uuid`, conversationID)
	return id
}

// cnvAskPermission writes the prompt a worker surfaces when the agent asks, and
// the conversation.permission.requested event that makes it visible.
func (f *cnvFixture) cnvAskPermission(t *testing.T, orgID, projectID, conversationID, turnID, acpRequestID string, deadline time.Duration) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO permission_requests
			(conversation_id, turn_id, acp_request_id, tool_call_id, tool_title, tool_kind, options, deadline_at)
		VALUES ($1::uuid, $2::uuid, $3, 'call-1', 'Write README.md', 'edit',
		        '[{"option_id":"allow_once","label":"Allow once","kind":"allow_once"},
		          {"option_id":"reject_once","label":"Reject","kind":"reject_once"}]'::jsonb,
		        CASE WHEN $4::double precision > 0 THEN now() + make_interval(secs => $4::double precision) END)
		RETURNING id::text`, conversationID, turnID, acpRequestID, deadline.Seconds()).into(t, &id)

	f.exec(t, `
		UPDATE conversation_turns SET status = 'running', started_at = COALESCE(started_at, now())
		WHERE id = $1::uuid AND status = 'leased'`, turnID)
	_, err := f.append(t, events.New{
		Type:           events.TypeConversationPermissionRequested,
		OrganizationID: orgID,
		ProjectID:      projectID,
		ConversationID: conversationID,
		Actor:          events.Actor{Kind: events.ActorKindAgent, ID: "agent"},
		Payload: events.PermissionRequestedPayload{
			ConversationID:      conversationID,
			TurnID:              turnID,
			PermissionRequestID: id,
			Title:               "Write README.md",
			Kind:                "edit",
			ToolCallID:          "call-1",
			Options: []events.PermissionOption{
				{OptionID: "allow_once", Label: "Allow once", Kind: "allow_once"},
				{OptionID: "reject_once", Label: "Reject", Kind: "reject_once"},
			},
		},
	})
	if err != nil {
		t.Fatalf("append permission.requested: %v", err)
	}
	return id
}

// append writes a journal row the way a request handler does: in a transaction,
// through the same appender, so the seq/gap behaviour under test is the real one.
func (f *cnvFixture) append(t *testing.T, e events.New) (int64, error) {
	t.Helper()
	ctx := testCtx(t)
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	env, err := AppendEvent(ctx, tx, e)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit append: %v", err)
	}
	return env.GlobalSeq, nil
}

func (f *cnvFixture) orgOf(t *testing.T, projectID string) string {
	t.Helper()
	var org string
	f.queryRow(t, "SELECT organization_id::text FROM projects WHERE id = $1::uuid", projectID).into(t, &org)
	return org
}

func (f *cnvFixture) convOrg(t *testing.T, conversationID string) string {
	t.Helper()
	return f.orgOf(t, f.convProject(t, conversationID))
}

func (f *cnvFixture) convProject(t *testing.T, conversationID string) string {
	t.Helper()
	var p string
	f.queryRow(t, "SELECT project_id::text FROM conversations WHERE id = $1::uuid", conversationID).into(t, &p)
	return p
}

// --- journal reads -------------------------------------------------------

type cnvJournalRow struct {
	globalSeq      int64
	typ            string
	conversationID *string
	payload        []byte
}

func (f *cnvFixture) journalRows(t *testing.T, conversationID string) []cnvJournalRow {
	t.Helper()
	rows, err := f.pool.Query(testCtx(t), `
		SELECT global_seq, type, conversation_id::text, payload::text
		FROM domain_events
		WHERE conversation_id = $1::uuid
		ORDER BY global_seq`, conversationID)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	defer rows.Close()
	var out []cnvJournalRow
	for rows.Next() {
		var r cnvJournalRow
		if err := rows.Scan(&r.globalSeq, &r.typ, &r.conversationID, &r.payload); err != nil {
			t.Fatalf("scan journal row: %v", err)
		}
		out = append(out, r)
	}
	return out
}

func cnvTypes(rows []cnvJournalRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%d:%s", r.globalSeq, r.typ))
	}
	return out
}

// --- tests -------------------------------------------------------------

func TestConversationCreateWritesStateAndJournal(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Fix the flaky test", "start with the failing spec")

	if chat.Control.Kind != events.ControllerKindHuman || chat.Control.UserID != f.alice {
		t.Fatalf("control = %+v, want the creator holding it", chat.Control)
	}
	if chat.Control.Version != 1 {
		t.Errorf("control version = %d, want 1: the create is what establishes the lock", chat.Control.Version)
	}
	if chat.ActiveTurn == nil || chat.ActiveTurn.Status != events.TurnStatusQueued {
		t.Errorf("active turn = %+v, want the queued first turn", chat.ActiveTurn)
	}

	rows := f.journalRows(t, chat.ID)
	// ADR-0016 §3 names exactly these two appends for a create with a prompt. A
	// control.transferred event here would be a lie: nobody transferred anything,
	// the creator was holding the lock from the row's first instant.
	want := []string{events.TypeConversationCreated, events.TypeConversationMessageUser}
	got := make([]string, 0, len(rows))
	for _, r := range rows {
		got = append(got, r.typ)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("journal types = %v, want %v", got, want)
	}
	for _, r := range rows {
		if r.conversationID == nil || *r.conversationID != chat.ID {
			t.Errorf("row %d (%s) has conversation_id %v: the transcript scope is written by the appender, not inferred (ADR-0016 §9)",
				r.globalSeq, r.typ, r.conversationID)
		}
	}

	// The first turn is queued and carries neither a worker nor a lease: the API
	// never launches anything (ADR-0016 §3).
	turn := f.read(t, `
		SELECT status, worker_id::text, lease_expires_at, fencing_token, prompt
		FROM conversation_turns WHERE conversation_id = $1::uuid`, chat.ID)
	if turn["status"] != events.TurnStatusQueued {
		t.Errorf("turn status = %v, want queued", turn["status"])
	}
	if turn["worker_id"] != nil || turn["lease_expires_at"] != nil {
		t.Errorf("turn owner = %v / lease %v: a queued turn must be unowned", turn["worker_id"], turn["lease_expires_at"])
	}
	if fmt.Sprint(turn["fencing_token"]) != "0" {
		t.Errorf("fencing_token = %v, want 0 until a claim draws one", turn["fencing_token"])
	}
	if got := fmt.Sprint(turn["prompt"]); got != "start with the failing spec" {
		t.Errorf("prompt = %q, want the text stored verbatim", got)
	}
}

// read renders one row as a map so assertions read as named fields.
func (f *cnvFixture) read(t *testing.T, q string, args ...any) map[string]any {
	t.Helper()
	cols, row := f.readRow(t, q, args...)
	out := map[string]any{}
	for i, c := range cols {
		out[c] = row[i]
	}
	return out
}

func (f *cnvFixture) readRow(t *testing.T, q string, args ...any) ([]string, []any) {
	t.Helper()
	rows, err := f.pool.Query(testCtx(t), q, args...)
	if err != nil {
		t.Fatalf("query %q: %v", q, err)
	}
	defer rows.Close()
	desc := rows.FieldDescriptions()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			t.Fatalf("rows %q: %v", q, err)
		}
		t.Fatalf("query %q returned no rows", q)
	}
	vals, err := rows.Values()
	if err != nil {
		t.Fatalf("values %q: %v", q, err)
	}
	names := make([]string, 0, len(desc))
	for _, d := range desc {
		names = append(names, string(d.Name))
	}
	if rows.Next() {
		t.Fatalf("query %q returned more than one row", q)
	}
	return names, vals
}

// --- visibility and roles -----------------------------------------------

func TestConversationNonMemberCannotSeeIt(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Roadmap", "")
	ctx := f.ctx()

	for name, c := range map[string]Caller{
		"non-member":  f.caller(f.outsider),
		"foreign org": {UserID: f.mallory, OrganizationID: f.elseOrg},
		"org admin":   {UserID: f.mallory, OrganizationID: f.orgID, IsOrgAdmin: true},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := f.store.GetConversation(ctx, c, chat.ID)
			if name == "org admin" {
				if err != nil {
					t.Fatalf("organization admin read = %v, want visible (01: admins bypass project scope)", err)
				}
				return
			}
			if !errors.Is(err, ErrConversationNotFound) {
				t.Fatalf("read = %v, want ErrConversationNotFound (404, never 403)", err)
			}
		})
	}

	// Listing is scoped the same way: the outsider's project list has no rows.
	items, err := f.store.ListConversations(ctx, f.caller(f.outsider), f.project, "", "")
	if !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("list = %v, want the project itself to be invisible", err)
	}
	if items != nil {
		t.Errorf("list returned %d rows for a caller who may not see the project", len(items))
	}
	// The member's list sees it.
	items, err = f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "")
	if err != nil || len(items) != 1 || items[0].ID != chat.ID {
		t.Fatalf("member list = %v / %v", items, err)
	}
}

// TestConversationStreamScopeForForeignConversationIsNotFound is the forged-id
// case from ADR-0016 Security: a real conversation id that the caller may not
// see must answer exactly like a nonexistent one, and must never leak the
// project id — not even through a journal read.
func TestConversationStreamScopeForForeignConversationIsNotFound(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Private", "prompt")

	ctx := f.ctx()
	if _, err := f.store.AuthorizeConversation(ctx, f.caller(f.outsider), chat.ID); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("AuthorizeConversation = %v, want ErrConversationNotFound", err)
	}
	if _, err := f.store.AuthorizeConversation(ctx, f.caller(f.mallory), chat.ID); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("foreign organization = %v, want ErrConversationNotFound", err)
	}
	// A malformed id is the same answer, not a driver error.
	if _, err := f.store.AuthorizeConversation(ctx, f.caller(f.alice), "not-a-uuid"); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("malformed id = %v, want ErrConversationNotFound", err)
	}
	if got, err := f.store.AuthorizeConversation(ctx, f.caller(f.bob), chat.ID); err != nil || got != f.project {
		t.Errorf("member scope = %q / %v, want the owning project %s", got, err, f.project)
	}

	stream := APIConversationStream{S: f.store, Journal: f.events}
	if _, err := stream.ConversationEventsAfter(ctx, api.Caller{UserID: f.outsider, OrganizationID: f.orgID}, chat.ID, 0, 50); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("stream read as an outsider = %v, want ErrConversationNotFound", err)
	}
	if _, err := stream.ConversationEventsAfter(ctx, api.Caller{UserID: f.alice, OrganizationID: f.orgID}, "zzzz", 0, 50); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("stream read with a malformed id = %v, want ErrConversationNotFound", err)
	}
}

func TestViewerMayReadButNeverWrite(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Viewer check", "")
	ctx := f.ctx()
	carl := f.caller(f.carl)

	if _, err := f.store.GetConversation(ctx, carl, chat.ID); err != nil {
		t.Fatalf("viewer read = %v, want 200-equivalent", err)
	}
	if _, err := f.store.ListConversations(ctx, carl, f.project, "", ""); err != nil {
		t.Fatalf("viewer list = %v", err)
	}

	writes := map[string]func() error{
		"message":        func() error { _, err := f.store.PostMessage(ctx, carl, chat.ID, "hello?"); return err },
		"take-control":   func() error { _, err := f.store.TakeControl(ctx, carl, chat.ID, chat.Control.Version); return err },
		"return-control": func() error { _, err := f.store.ReturnControl(ctx, carl, chat.ID, chat.Control.Version); return err },
		"cancel":         func() error { _, err := f.store.CancelTurn(ctx, carl, chat.ID); return err },
		"create": func() error {
			_, err := f.store.CreateConversation(ctx, carl, f.project, f.profile, "x", "")
			return err
		},
	}
	for name, fn := range writes {
		if err := fn(); !errors.Is(err, ErrConversationForbidden) {
			t.Errorf("viewer %s = %v, want ErrConversationForbidden (403)", name, err)
		}
	}

	// And the refusal did not move anything: the conversation is exactly as
	// Alice left it.
	after, err := f.store.GetConversation(ctx, f.caller(f.alice), chat.ID)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if after.Control.UserID != f.alice || after.Control.Version != 1 || after.ActiveTurn != nil {
		t.Errorf("state after viewer attempts = %+v, want it untouched", after.Control)
	}
}

// --- control: the compare-and-swap --------------------------------------

func TestControlTakeVersionConflict(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Control race", "")
	ctx := f.ctx()

	// Bob sends the version he read before Alice's create landed the row he is
	// now looking at — i.e. a stale one.
	_, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 41)
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.Kind != ConflictControlVersionStale {
		t.Fatalf("stale take = %v, want control_version_stale", err)
	}
	if cf.Control == nil || cf.Control.UserID != f.alice || cf.Control.Version != 1 {
		t.Errorf("conflict carried control %+v, want the winner's row so the loser can adopt it", cf.Control)
	}

	// Bob's correct CAS wins, once.
	got, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1)
	if err != nil {
		t.Fatalf("take with the current version = %v", err)
	}
	if got.Control.UserID != f.bob || got.Control.Version != 2 {
		t.Fatalf("control after take = %+v, want bob at version 2", got.Control)
	}
	if got.Control.PreviousUserID != f.alice {
		t.Errorf("previous controller = %q, want alice", got.Control.PreviousUserID)
	}

	// Alice's stale attempt now fails against version 2 and says so.
	_, err = f.store.TakeControl(ctx, f.caller(f.alice), chat.ID, 1)
	if !errors.As(err, &cf) || cf.Kind != ConflictControlVersionStale {
		t.Fatalf("second stale take = %v, want control_version_stale", err)
	}

	// A third member (carl, a viewer) is refused before the CAS is ever tried:
	// role is checked first, so a viewer never learns who currently holds the
	// lock by watching which version errors.
	if _, err := f.store.TakeControl(ctx, f.caller(f.carl), chat.ID, 2); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("viewer take = %v, want forbidden", err)
	}
}

// TestControlTakeIsIdempotentForTheHolder is what makes a browser retry safe.
func TestControlTakeIsIdempotentForTheHolder(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Retry safety", "")
	ctx := f.ctx()

	for i := 0; i < 3; i++ {
		got, err := f.store.TakeControl(ctx, f.caller(f.alice), chat.ID, 1)
		if err != nil {
			t.Fatalf("retry %d = %v", i, err)
		}
		if got.Control.Version != 1 || got.Control.UserID != f.alice {
			t.Fatalf("retry %d left control %+v", i, got.Control)
		}
	}
	var appends int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.control.transferred'`, chat.ID).into(t, &appends)
	if appends != 0 {
		t.Errorf("control.transferred rows = %d, want 0: a no-op must not rewrite history", appends)
	}
}

// TestConcurrentControlTakeHasExactlyOneWinner is the ADR-0016 §3 claim: two
// requests, one CAS winner, and the loser is told who won.
func TestConcurrentControlTakeHasExactlyOneWinner(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Two humans, one turn", "")
	// Hand control to a third party so neither racer already holds it.
	ctx := f.ctx()
	if _, err := f.store.TakeControl(ctx, f.caller(f.outsider), chat.ID, 1); err == nil {
		t.Fatalf("a non-member must not be able to take control at all")
	}
	if _, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1); err != nil {
		t.Fatalf("setup: bob takes control: %v", err)
	}
	// Both racers now read version 2 and both aim at it.
	version := 2

	type outcome struct {
		who string
		err error
	}
	start := make(chan struct{})
	results := make(chan outcome, 2)
	for _, who := range []string{f.alice, f.secondRacer(t)} {
		user := who
		go func() {
			<-start
			_, err := f.store.TakeControl(context.Background(), f.caller(user), chat.ID, version)
			results <- outcome{user, err}
		}()
	}
	close(start)

	var cf *CnvConflict
	oneWon := false
	for i := 0; i < 2; i++ {
		r := <-results
		switch {
		case r.err == nil:
			if oneWon {
				t.Fatalf("two callers both took control of %s", chat.ID)
			}
			oneWon = true
		case errors.As(r.err, &cf) && cf.Kind == ConflictControlVersionStale:
			if cf.Control == nil || cf.Control.Version != version+1 {
				t.Errorf("loser %s got control %+v, want the winner's version %d", r.who, cf.Control, version+1)
			}
		default:
			t.Fatalf("loser %s got %v, want a version conflict", r.who, r.err)
		}
	}
	if !oneWon {
		t.Fatalf("nobody won: %+v", results)
	}

	// The winner holds it, and the audit trail records the transfer exactly once.
	chat2, err := f.store.GetConversation(ctx, f.caller(f.alice), chat.ID)
	if err != nil {
		t.Fatalf("read after race: %v", err)
	}
	if chat2.Control.Version != 3 {
		t.Errorf("final control version = %d, want 3 (one takeover after the setup take)", chat2.Control.Version)
	}
}

// secondRacer creates another contributor in this project. The foreign-
// organization user cannot serve: a member of one organization may not hold a
// seat in another project, and the schema says so.
func (f *cnvFixture) secondRacer(t *testing.T) string {
	t.Helper()
	user := cnvUser(t, f.pool, f.orgID, "cnv-dana-"+migFixtureToken(t))
	f.exec(t, `INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'contributor')`,
		f.project, user)
	f.extra = append(f.extra, user)
	return user
}

func TestReturnControlHandsBackToTheDisplacedHolder(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Hand back", "")
	ctx := f.ctx()

	// ADR-0016 §3: "return-control gives control to previous_controller_user_id
	// if that user is still a contributor/maintainer of the project; otherwise
	// control goes to none", and a successful mutation "sets
	// previous_controller_user_id from the holder it displaced". Applied to one
	// conversation in full, that is a hand-back, and then a hand-back of the
	// hand-back — the ADR's wording is what the store implements, verbatim.
	if _, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1); err != nil {
		t.Fatalf("bob takes: %v", err)
	}
	got, err := f.store.ReturnControl(ctx, f.caller(f.bob), chat.ID, 2)
	if err != nil {
		t.Fatalf("bob returns: %v", err)
	}
	if got.Control.UserID != f.alice || got.Control.Version != 3 {
		t.Fatalf("control after return = %+v, want alice at version 3", got.Control)
	}
	if got.Control.Kind != events.ControllerKindHuman {
		t.Fatalf("kind = %q, want human: alice is still a maintainer", got.Control.Kind)
	}

	// Returning when nobody was displaced (the creator never lost the lock) is
	// the 'otherwise' branch: kind 'none', and the schema CHECK makes a 'none'
	// row with a user pointer impossible rather than discouraged.
	fresh := f.cnvCreate(t, f.alice, "Created and left", "")
	got, err = f.store.ReturnControl(ctx, f.caller(f.alice), fresh.ID, 1)
	if err != nil {
		t.Fatalf("creator returns: %v", err)
	}
	if got.Control.Kind != events.ControllerKindNone || got.Control.UserID != "" {
		t.Fatalf("control = %+v, want kind none with no user pointer", got.Control)
	}
	if got.Control.Version != 2 {
		t.Errorf("version = %d, want 2: returning still moves the CAS token", got.Control.Version)
	}
	// And a conversation with no controller cannot have its control returned.
	if _, err := f.store.ReturnControl(ctx, f.caller(f.alice), fresh.ID, 2); err == nil {
		var cf *CnvConflict
		if !errors.As(err, &cf) || cf.Kind != ConflictNotController {
			t.Fatalf("return with no controller = %v, want not_controller", err)
		}
	}
}

// TestReturnControlToRemovedMemberGoesNone is the edge case the ADR's "if that
// user is still a contributor/maintainer" clause exists for: the displaced
// holder was deleted from the project while the holder was driving.
func TestReturnControlToRemovedMemberGoesNone(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "The holder who left", "")
	ctx := f.ctx()
	if _, err := f.store.TakeControl(ctx, f.caller(f.bob), chat.ID, 1); err != nil {
		t.Fatalf("bob takes: %v", err)
	}
	f.exec(t, `DELETE FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`,
		f.project, f.alice)

	got, err := f.store.ReturnControl(ctx, f.caller(f.bob), chat.ID, 2)
	if err != nil {
		t.Fatalf("bob returns after alice left the project: %v", err)
	}
	if got.Control.Kind != events.ControllerKindNone || got.Control.UserID != "" {
		t.Fatalf("control = %+v, want none: a removed member must not be handed the lock back", got.Control)
	}

	// Every transfer in this conversation is in the transcript, in order, and
	// each carries who it went to — the audit trail is the story of the lock.
	types := cnvTypes(f.journalRows(t, chat.ID))
	if !strings.Contains(strings.Join(types, ","), events.TypeConversationControlTransferred) {
		t.Fatalf("journal = %v, want a control transfer", types)
	}
	rows := f.journalRows(t, chat.ID)
	last := rows[len(rows)-1]
	var payload events.ControlTransferredPayload
	if err := json.Unmarshal(last.payload, &payload); err != nil {
		t.Fatalf("decode transfer payload %s: %v", last.payload, err)
	}
	if payload.ToKind != events.ControllerKindNone || payload.Reason != events.TransferReturned {
		t.Errorf("payload = %+v, want to_kind none, reason returned", payload)
	}
}

func TestReturnControlByNonHolderIsRefused(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Not yours to return", "")
	ctx := f.ctx()
	_, err := f.store.ReturnControl(ctx, f.caller(f.bob), chat.ID, 1)
	var cf *CnvConflict
	if !errors.As(err, &cf) || cf.Kind != ConflictNotController {
		t.Fatalf("return by non-holder = %v, want not_controller", err)
	}
	if cf.Control == nil || cf.Control.UserID != f.alice {
		t.Errorf("conflict control = %+v, want the current holder named", cf.Control)
	}
}

// --- transcript journal reads -------------------------------------------

// TestConversationTranscriptIsOrderedCompleteAndSharedWithTheProjectStream is
// ADR-0016 §9 obligation 2 proven on rows rather than in prose: one journal, one
// cursor, and the conversation stream is a projection of the project stream —
// so a client holding a transcript cursor can resume it after a reconnect and
// cannot use it to read another conversation's rows.
func TestConversationTranscriptIsOrderedCompleteAndSharedWithTheProjectStream(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Two prompts", "first")
	ctx := f.ctx()

	// Finish the first turn the way a worker would, then let the controller ask
	// again: the transcript is the interleaving of human and agent rows, in the
	// order the journal committed them.
	turn1 := f.mustActiveTurn(t, chat.ID)
	f.cnvClaim(t, turn1, f.worker, time.Hour)
	f.cnvRunning(t, turn1)
	f.exec(t, `
		UPDATE conversation_turns SET status = 'completed', finished_at = now(), stop_reason = 'end_turn'
		WHERE id = $1::uuid`, turn1)
	if _, err := f.append(t, events.New{
		Type: events.TypeConversationTurnCompleted, OrganizationID: f.orgID,
		ProjectID: f.project, ConversationID: chat.ID,
		Actor:   events.Actor{Kind: events.ActorKindAgent, ID: "agent"},
		Payload: events.TurnCompletedPayload{ConversationID: chat.ID, TurnID: turn1, StopReason: "end_turn"},
	}); err != nil {
		t.Fatalf("append completed: %v", err)
	}
	second, err := f.store.PostMessage(ctx, f.caller(f.alice), chat.ID, "second")
	if err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	// A second conversation in the same project: its rows must not appear on this
	// transcript, and must not shift its cursor.
	other := f.cnvCreate(t, f.alice, "The other one", "unrelated")

	all, err := f.events.EventsAfter(ctx, f.project, 0, 500)
	if err != nil {
		t.Fatalf("project stream: %v", err)
	}
	transcript, err := f.events.VisibleConversationEventsAfter(ctx, f.caller(f.bob), chat.ID, 0, 500)
	if err != nil {
		t.Fatalf("transcript: %v", err)
	}
	if len(transcript) == 0 {
		t.Fatal("transcript is empty: the writer is not populating conversation_id")
	}

	// The transcript is a subsequence of the project stream, in the same cursor
	// order — no re-sorting, no separate numbering.
	pos := -1
	for _, e := range transcript {
		found := false
		for i := pos + 1; i < len(all); i++ {
			if all[i].GlobalSeq == e.GlobalSeq {
				found = true
				pos = i
				break
			}
		}
		if !found {
			t.Fatalf("transcript row %d (%s) is not in the project stream at a later position", e.GlobalSeq, e.Type)
		}
		if e.ConversationID != chat.ID {
			t.Errorf("transcript row %d carries conversation %q", e.GlobalSeq, e.ConversationID)
		}
	}
	// Nothing from the other conversation leaked in.
	for _, e := range transcript {
		if e.Type == events.TypeConversationCreated && e.ConversationID != chat.ID {
			t.Errorf("foreign row on this transcript: %+v", e)
		}
	}

	// The cursor resumes: everything after the second prompt's row, and only that.
	var afterSecond int64
	for _, e := range transcript {
		if e.Type == events.TypeConversationMessageUser {
			afterSecond = e.GlobalSeq
		}
	}
	tail, err := f.events.VisibleConversationEventsAfter(ctx, f.caller(f.bob), chat.ID, afterSecond, 500)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	for _, e := range tail {
		if e.GlobalSeq <= afterSecond {
			t.Fatalf("resume replayed cursor %d at or below %d", e.GlobalSeq, afterSecond)
		}
	}
	// A cursor from the *other* conversation is just an integer: it filters by
	// sequence within this conversation's scope, which is exactly why the scope
	// predicate has to be part of the same statement.
	foreign, err := f.events.VisibleConversationEventsAfter(ctx, f.caller(f.bob), other.ID, transcript[0].GlobalSeq, 500)
	if err != nil {
		t.Fatalf("foreign transcript: %v", err)
	}
	for _, e := range foreign {
		if e.ConversationID != other.ID {
			t.Errorf("other conversation's stream carried %q", e.ConversationID)
		}
	}
	if len(foreign) >= len(all) {
		t.Errorf("foreign transcript returned %d rows, want a subset of the %d-row project stream", len(foreign), len(all))
	}
	// The second prompt is durable and ordered after the first turn's completion.
	if second.ID == turn1 {
		t.Errorf("the second prompt reused the first turn's id")
	}
	types := cnvTypes(f.journalRows(t, chat.ID))
	joined := strings.Join(types, " ")
	if !strings.Contains(joined, events.TypeConversationTurnCompleted) ||
		!strings.Contains(joined, events.TypeConversationMessageUser) {
		t.Fatalf("transcript types = %v, want the interleaved turns", types)
	}
	lastUser := strings.LastIndex(joined, events.TypeConversationMessageUser)
	if lastUser < strings.Index(joined, events.TypeConversationTurnCompleted) {
		t.Errorf("transcript order = %v, want the second prompt after the first turn closed", types)
	}
}

// TestConversationAppendPersistsScopeIsTheObligation: ADR-0016 §9 puts the
// journal writer on the hook for persisting conversation_id, because the column
// has existed since migration 00001 with no writer populating it. An append that
// dropped it would keep every other read correct and make the transcript
// permanently, silently empty — which is why this asserts the column, not the
// stream.
func TestConversationAppendPersistsScopeIsTheObligation(t *testing.T) {
	f := cnvSetup(t)
	chat := f.cnvCreate(t, f.alice, "Scope is written", "prompt")

	var n int
	f.queryRow(t, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = ANY($2::text[])`,
		chat.ID, []string{events.TypeConversationCreated, events.TypeConversationMessageUser}).into(t, &n)
	if n != 2 {
		t.Fatalf("conversation-scoped rows = %d, want 2 (created + message.user)", n)
	}
	// And a project-only event keeps a null scope, so the two kinds stay
	// distinguishable in one journal instead of being conflated by a writer that
	// filled the column with something convenient.
	if _, err := f.append(t, events.New{
		Type: events.TypeProjectMemberUpdated, OrganizationID: f.orgID, ProjectID: f.project,
		Actor:   events.Human(f.alice),
		Payload: map[string]any{"project_id": f.project, "user_id": f.bob, "role": "contributor"},
	}); err != nil {
		t.Fatalf("append project event: %v", err)
	}
	var scoped struct{ total, nulls int }
	f.queryRow(t, `
		SELECT count(*), count(conversation_id) FROM domain_events
		WHERE project_id = $1::uuid AND type = 'project.member.updated'`, f.project).
		into(t, &scoped.total, &scoped.nulls)
	if scoped.total != 1 || scoped.nulls != 0 {
		t.Errorf("project.member.updated rows = %+v, want one row with a null conversation scope", scoped)
	}
	// A malformed scope is a programming error, not a silently-null row.
	if _, err := f.append(t, events.New{
		Type: events.TypeConversationMessageAgent, OrganizationID: f.orgID,
		ProjectID: f.project, ConversationID: "not-a-uuid",
		Actor:   events.Actor{Kind: events.ActorKindAgent, ID: "agent"},
		Payload: events.MessageAgentPayload{ConversationID: "not-a-uuid", Text: "x"},
	}); err == nil {
		t.Errorf("append accepted a malformed conversation id")
	} else if !strings.Contains(err.Error(), "uuid") {
		t.Errorf("append error = %v, want it to name the bad id", err)
	}
	// The failed append wrote nothing at all.
	var after int
	f.queryRow(t, `SELECT count(*) FROM domain_events WHERE conversation_id = $1::uuid`, chat.ID).into(t, &after)
	if after != 2 {
		t.Errorf("journal rows after a rejected append = %d, want the 2 the create wrote", after)
	}
}

// --- ADR-0043: origin and run_link ---------------------------------------

// TestConversationListOriginAndRunLink proves the ADR-0043 contract against a
// real database: a conversation no attempt references is "manual" with a null
// link; the moment an attempt names it, the list and the single read both say
// "run" and point at the NEWEST referencing attempt's run/node. The origin
// filter narrows the list, and q is a case-insensitive substring that treats
// the LIKE metacharacters as literals.
func TestConversationListOriginAndRunLink(t *testing.T) {
	f := cnvSetup(t)
	m := m4Setup(t)
	ctx := f.ctx()

	manual := f.cnvCreate(t, f.alice, "Manual chat", "")
	// The % is deliberate: q must match it literally, so the title carries one.
	runChat := f.cnvCreate(t, f.alice, "Release % please", "")

	// A real run of a published revision in the conversation's own project:
	// the run table has no title column, so run_title stays null end to end.
	token := migFixtureToken(t)
	pipe, err := m.pipelines.CreatePipeline(ctx, f.orgID, f.alice, "cnv-run-pipe-"+token, "Run pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	// Publish a revision on OUR pipeline, not m.pipelineID: the m4 fixture's
	// cleanup deletes its own pipeline by that id and a swapped pointer would
	// leave the original pipeline behind, breaking the shared fixture's users
	// teardown.
	revDigest := m4Digest("cnv-run/" + token)
	doc := "apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# " + revDigest + "\n"
	canonical := json.RawMessage(fmt.Sprintf(
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, revDigest))
	draft, err := m.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: pipe.ID, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("src/" + revDigest), EditedBy: f.alice,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := m.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: canonical, RevisionDigest: revDigest,
		CompiledPlan: json.RawMessage(`{"nodes":[]}`),
		PlanDigest:   m4Digest("plan-of/" + revDigest),
		Validation:   json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := m.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
		PublishedBy: f.alice, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	revID := rev.ID
	run, _, err := m.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.project, PipelineID: pipe.ID,
		PipelineRevisionID: revID, RevisionDigest: m.digest, PlanDigest: m.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.alice,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	node, attempt1 := m.m4WorkerNode(t, ctx, run.ID, "/review")
	if _, err := m.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: node, AttemptNumber: 2}); err != nil {
		t.Fatalf("QueueAttempt 2: %v", err)
	}
	// attempts_agent_turn_pair requires both halves: each attempt is stamped
	// with the run chat's conversation AND one of its turns, the way the
	// worker's ConversationFor seam writes the pair.
	stamp := func(attemptID string) {
		var turnID string
		f.queryRow(t, `
			INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
			VALUES ($1, 'run pair turn', $2) RETURNING id::text`, runChat.ID, f.alice).into(t, &turnID)
		f.exec(t, `UPDATE attempts SET conversation_id = $1::uuid, turn_id = $2::uuid
			WHERE id = $3::uuid`, runChat.ID, turnID, attemptID)
		f.exec(t, `UPDATE conversation_turns SET node_attempt_id = $1::uuid
			WHERE id = $2::uuid`, attemptID, turnID)
		// The one-active-turn index: finish the turn so the next pair can
		// queue a fresh one in the same conversation.
		f.exec(t, `UPDATE conversation_turns SET status = 'completed', stop_reason = 'end_turn',
			started_at = now(), finished_at = now() WHERE id = $1::uuid`, turnID)
	}
	stamp(attempt1)
	var attempt2 string
	f.queryRow(t, `SELECT id::text FROM attempts WHERE node_execution_id = $1::uuid AND attempt_number = 2`, node).into(t, &attempt2)
	stamp(attempt2)

	// The runs this test made belong to f.project, which the cnv fixture
	// deletes; this cleanup (registered last, so it runs first) clears the
	// reference chain before the conversations themselves go.
	t.Cleanup(func() {
		bg := context.Background()
		runsSub := `(SELECT id FROM runs WHERE project_id = $1)`
		steps := []struct {
			sql  string
			args []any
		}{
			{`UPDATE conversation_turns SET node_attempt_id = NULL WHERE conversation_id = $1`, []any{runChat.ID}},
			{`DELETE FROM outbox WHERE global_seq IN
				(SELECT global_seq FROM domain_events WHERE run_id IN ` + runsSub + `)`, []any{f.project}},
			{`DELETE FROM domain_events WHERE run_id IN ` + runsSub, []any{f.project}},
			{`DELETE FROM run_checkpoints WHERE run_id IN ` + runsSub, []any{f.project}},
			{`DELETE FROM attempts WHERE run_id IN ` + runsSub, []any{f.project}},
			{`DELETE FROM node_executions WHERE run_id IN ` + runsSub, []any{f.project}},
			{`DELETE FROM runs WHERE project_id = $1`, []any{f.project}},
			{`UPDATE pipeline_drafts SET published_revision_id = NULL WHERE pipeline_id = $1`, []any{pipe.ID}},
			{`DELETE FROM pipeline_revisions WHERE pipeline_id = $1`, []any{pipe.ID}},
			{`DELETE FROM pipeline_drafts WHERE pipeline_id = $1`, []any{pipe.ID}},
			{`DELETE FROM pipelines WHERE id = $1`, []any{pipe.ID}},
		}
		for _, step := range steps {
			if _, err := m.pool.Exec(bg, step.sql, step.args...); err != nil {
				f.t.Errorf("cleanup %q: %v", step.sql, err)
			}
		}
	})

	assertLink := func(got *CnvRunLink, where string) {
		t.Helper()
		if got == nil {
			t.Fatalf("%s: run_link is nil, want the newest attempt's run/node", where)
		}
		if got.RunID != run.ID || got.NodeExecutionID != node ||
			got.NodeInstanceKey != "/review" || got.NodeID == nil || *got.NodeID != "review" ||
			got.AttemptID != attempt2 || got.AttemptNumber != 2 {
			t.Errorf("%s: run_link = %+v, want run %s node %s attempt 2 (%s)",
				where, got, run.ID, node, attempt2)
		}
		if got.RunTitle != nil {
			t.Errorf("%s: run_title = %q, want null (runs has no title column)", where, *got.RunTitle)
		}
	}

	list := func(origin, query string) map[string]CnvSummary {
		t.Helper()
		items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, origin, query)
		if err != nil {
			t.Fatalf("list(origin=%q, q=%q) = %v", origin, query, err)
		}
		out := make(map[string]CnvSummary, len(items))
		for _, item := range items {
			out[item.ID] = item
		}
		return out
	}

	// Unfiltered: both rows, and each says the right thing.
	both := list("", "")
	if len(both) != 2 {
		t.Fatalf("list = %d rows, want the two created conversations", len(both))
	}
	if got := both[manual.ID]; got.Origin != "manual" || got.RunLink != nil {
		t.Errorf("manual conversation: origin=%q run_link=%+v, want manual/nil", got.Origin, got.RunLink)
	}
	if got := both[runChat.ID]; got.Origin != "run" {
		t.Errorf("run-linked conversation: origin = %q, want run", got.Origin)
	} else {
		assertLink(got.RunLink, "list")
	}

	// origin filter: each side of the split sees exactly its own rows.
	if got := list("manual", ""); len(got) != 1 || got[manual.ID].Origin != "manual" {
		t.Errorf("origin=manual = %+v, want only the manual conversation", got)
	}
	if got := list("run", ""); len(got) != 1 || got[runChat.ID].Origin != "run" {
		t.Errorf("origin=run = %+v, want only the run-linked conversation", got)
	}

	// q is case-insensitive and literal: uppercase + the % must match; a
	// literal underscore must not act as a wildcard.
	if got := list("", "RELEASE % PLEASE"); len(got) != 1 || got[runChat.ID].ID != runChat.ID {
		t.Errorf(`q="RELEASE %% PLEASE" = %+v, want the run-linked row`, got)
	}
	if got := list("", "p_lease"); len(got) != 0 {
		t.Errorf(`q="p_lease" = %+v, want no row: _ is escaped, not a wildcard`, got)
	}
	if got := list("", "manual chat"); len(got) != 1 || got[manual.ID].ID != manual.ID {
		t.Errorf(`q="manual chat" = %+v, want the manual conversation`, got)
	}

	// The single-conversation read agrees with the list.
	got, err := f.store.GetConversation(ctx, f.caller(f.bob), manual.ID)
	if err != nil || got.Origin != "manual" || got.RunLink != nil {
		t.Errorf("GetConversation(manual) = %+v / %v, want manual with a nil link", got, err)
	}
	got, err = f.store.GetConversation(ctx, f.caller(f.bob), runChat.ID)
	if err != nil || got.Origin != "run" {
		t.Fatalf("GetConversation(run) = %+v / %v, want run", got, err)
	}
	assertLink(got.RunLink, "single read")
}
