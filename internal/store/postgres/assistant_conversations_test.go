package postgres

// ADR-0050 part 1: real-PostgreSQL tests for the assistant conversation,
// transcript and change tables (docs/adr/ADR-0050-assistant-v2.md).
// Covers per-user isolation (another user's conversation is the not-found
// sentinel), ordering, append-only behaviour, the undo transition (second
// undo is a 409), and the cascade that deletes a user's transcript with
// the user.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/assistant"
)

// assistantFixture migrates the scratch database and gives the tests one
// pool, two users (owner + stranger) and the store; cleanup deletes
// exactly the rows named by id.
type assistantFixture struct {
	t         *testing.T
	pool      *pgxpool.Pool
	owner     string
	stranger  string
	store     *AssistantConversationStore
	convIDs   []string
	changeIDs []string
}

// assistantMigrateMu serializes the fixtures' Migrate calls: goose is not
// concurrency-safe, and a parallel run that touches the shared scratch
// database mid-migration would otherwise break the fixtures. The test
// bodies stay parallel — every row is keyed on the fixture's own user ids.
var assistantMigrateMu sync.Mutex

func assistantMustMigrate(t *testing.T) {
	t.Helper()
	url := testDatabaseURL(t)
	assistantMigrateMu.Lock()
	defer assistantMigrateMu.Unlock()
	// Retries: another worker's run can reset the shared scratch database
	// mid-migration; a clean DB settles within a second or two.
	for attempt := 1; ; attempt++ {
		err := Migrate(testCtx(t), url)
		if err == nil || attempt >= 3 {
			if err != nil {
				t.Fatalf("Migrate: %v", err)
			}
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func assistantTestFixture(t *testing.T) *assistantFixture {
	t.Helper()
	url := testDatabaseURL(t)
	assistantMustMigrate(t)

	ctx := testCtx(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var orgID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM organizations WHERE slug = 'default'`).Scan(&orgID); err != nil {
		t.Fatalf("default organization: %v", err)
	}
	f := &assistantFixture{t: t, pool: pool, store: &AssistantConversationStore{Pool: pool}}
	for _, name := range []string{"as-owner", "as-stranger"} {
		var id string
		if err := pool.QueryRow(ctx,
			`INSERT INTO users (organization_id, display_name) VALUES ($1::uuid, $2) RETURNING id::text`,
			orgID, name).Scan(&id); err != nil {
			t.Fatalf("insert user %s: %v", name, err)
		}
		if name == "as-owner" {
			f.owner = id
		} else {
			f.stranger = id
		}
	}
	t.Cleanup(func() {
		bg := context.Background()
		for _, id := range f.changeIDs {
			if _, err := pool.Exec(bg, `DELETE FROM assistant_changes WHERE id = $1::uuid`, id); err != nil {
				t.Errorf("cleanup assistant_changes: %v", err)
			}
		}
		for _, id := range f.convIDs {
			if _, err := pool.Exec(bg, `DELETE FROM assistant_conversations WHERE id = $1::uuid`, id); err != nil {
				t.Errorf("cleanup assistant_conversations: %v", err)
			}
		}
		ids := []string{}
		if f.owner != "" {
			ids = append(ids, f.owner)
		}
		ids = append(ids, f.stranger)
		if len(ids) > 0 {
			if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = ANY($1::uuid[])`, ids); err != nil {
				t.Errorf("cleanup users: %v", err)
			}
		}
	})
	return f
}

// addTurn posts one user message and one assistant message to the
// fixture's owner's conversation.
func (f *assistantFixture) addTurn(t *testing.T, convID, text string) {
	t.Helper()
	userPayload, _ := json.Marshal(map[string]any{"kind": "user", "text": text})
	assistantPayload, _ := json.Marshal(map[string]any{
		"kind": "assistant", "answer_markdown": "reply to " + text,
	})
	if _, err := f.store.AddTurnMessages(testCtx(t), f.owner, convID, []api.AssistantMessageInput{
		{Kind: "user", Payload: userPayload},
		{Kind: "assistant", Payload: assistantPayload},
	}); err != nil {
		t.Fatalf("AddTurnMessages: %v", err)
	}
}

func (f *assistantFixture) insertChange(t *testing.T, convID, kind string, undoable bool) string {
	t.Helper()
	var payload []byte
	if undoable {
		payload = []byte(`{"draft_id":"d-1","inverse":{"op":"delete_node","node":"n-1"}}`)
	}
	ch, err := f.store.InsertChange(testCtx(t), f.owner, convID, nil,
		kind, "draft:d-1", "Inserted node `review` after `tests`", payload)
	if err != nil {
		t.Fatalf("InsertChange: %v", err)
	}
	f.changeIDs = append(f.changeIDs, ch.ID)
	return ch.ID
}

func TestAssistantConversationCreateAndIsolation(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)

	conv, err := f.store.CreateConversation(ctx, f.owner)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	f.convIDs = append(f.convIDs, conv.ID)
	if conv.Title != nil || conv.LastMessageAt != nil {
		t.Fatalf("fresh conversation = %+v, want nil title and last_message_at", conv)
	}

	// The owner sees it.
	got, err := f.store.GetConversation(ctx, f.owner, conv.ID)
	if err != nil || got.ID != conv.ID {
		t.Fatalf("owner GetConversation = %+v, %v", got, err)
	}
	// The stranger gets the not-found sentinel — never 403, never the row.
	if _, err := f.store.GetConversation(ctx, f.stranger, conv.ID); !errors.Is(err, api.ErrAssistantConversationNotFound) {
		t.Fatalf("stranger GetConversation err = %v, want the not-found sentinel", err)
	}
	list, next, err := f.store.ListConversations(ctx, f.stranger, 50, api.AssistantListCursor{})
	if err != nil || next != "" {
		t.Fatalf("stranger ListConversations = %v, %q, %v", list, next, err)
	}
	if len(list) != 0 {
		t.Fatalf("stranger listed %d conversations, want 0", len(list))
	}
	// A stranger's post into the owner's conversation stores nothing.
	userPayload, _ := json.Marshal(map[string]any{"kind": "user", "text": "sneak"})
	if _, err := f.store.AddTurnMessages(ctx, f.stranger, conv.ID,
		[]api.AssistantMessageInput{{Kind: "user", Payload: userPayload}}); !errors.Is(err, api.ErrAssistantConversationNotFound) {
		t.Fatalf("stranger AddTurnMessages err = %v, want the not-found sentinel", err)
	}
}

func TestAssistantConversationOrderingAndTitle(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)

	a, _ := f.store.CreateConversation(ctx, f.owner)
	b, _ := f.store.CreateConversation(ctx, f.owner)
	c, _ := f.store.CreateConversation(ctx, f.owner)
	f.convIDs = append(f.convIDs, a.ID, b.ID, c.ID)

	f.addTurn(t, a.ID, "the first user message sets the title; this one is padded past the cap "+
		strings.Repeat("x", 30))
	time.Sleep(5 * time.Millisecond) // last_message_at is a distinct instant
	f.addTurn(t, b.ID, "b message")

	// b was messaged after a, so b sorts first; a is second; c (never
	// messaged) sorts last among the fixture's rows only if its id is
	// newer — assert the two timed rows and that c is absent from the
	// timed ordering's front.
	list, _, err := f.store.ListConversations(ctx, f.owner, 50, api.AssistantListCursor{})
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	var timed []string
	seenC := false
	for _, row := range list {
		if row.ID == a.ID || row.ID == b.ID {
			timed = append(timed, row.ID)
		}
		if row.ID == c.ID {
			seenC = true
		}
	}
	if len(timed) != 2 || timed[0] != b.ID || timed[1] != a.ID {
		t.Fatalf("timed ordering = %v, want [b a]", timed)
	}
	if !seenC {
		t.Fatalf("never-messaged conversation c missing from the list")
	}

	// The first user message set the title, clipped to 80 chars.
	title := *list[1].Title
	if len([]rune(title)) > 80 {
		t.Fatalf("title = %d runes, want at most 80", len([]rune(title)))
	}
	// c keeps a NULL title.
	for _, row := range list {
		if row.ID == c.ID && row.Title != nil {
			t.Fatalf("never-messaged conversation has title %q", *row.Title)
		}
	}
}

func TestAssistantMessagesOrderingAndPaging(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)
	conv, _ := f.store.CreateConversation(ctx, f.owner)
	f.convIDs = append(f.convIDs, conv.ID)

	for i := 1; i <= 5; i++ {
		f.addTurn(t, conv.ID, fmt.Sprintf("turn %d", i))
	}
	// 10 rows: user/assistant alternating.
	all, _, err := f.store.ListMessages(ctx, f.owner, conv.ID, 50, api.AssistantListCursor{})
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(all) != 10 {
		t.Fatalf("messages = %d, want 10", len(all))
	}
	if all[0].Kind != "user" || all[1].Kind != "assistant" {
		t.Fatalf("first rows = %s, %s, want user then assistant", all[0].Kind, all[1].Kind)
	}
	if len(all[0].Payload) == 0 || !json.Valid(all[0].Payload) {
		t.Fatalf("payload not valid json: %s", all[0].Payload)
	}

	// Page of 3: the first page is turns 1..3, the cursor walks forward.
	page1, next, err := f.store.ListMessages(ctx, f.owner, conv.ID, 3, api.AssistantListCursor{})
	if err != nil || len(page1) != 3 || next == "" {
		t.Fatalf("page 1 = %d rows, next %q, %v", len(page1), next, err)
	}
	cursor, err := api.ParseAssistantListCursor(next)
	if err != nil {
		t.Fatalf("ParseAssistantListCursor(%q): %v", next, err)
	}
	page2, _, err := f.store.ListMessages(ctx, f.owner, conv.ID, 3, cursor)
	if err != nil || len(page2) != 3 {
		t.Fatalf("page 2 = %d rows, %v", len(page2), err)
	}
	if page1[2].ID == page2[0].ID {
		t.Fatalf("cursor re-included the boundary row")
	}
	if page1[0].ID != all[0].ID || page2[0].ID != all[3].ID {
		t.Fatalf("pages drifted from the full ordering")
	}
	// The stranger cannot page the owner's transcript: the EXISTS
	// predicate answers an empty page, not an error and not a row.
	strangerList, _, err := f.store.ListMessages(ctx, f.stranger, conv.ID, 3, api.AssistantListCursor{})
	if err != nil || len(strangerList) != 0 {
		t.Fatalf("stranger listed %d rows, %v; want 0", len(strangerList), err)
	}

	// RecentMessages is newest-first and bounded.
	recent, err := f.store.RecentMessages(ctx, f.owner, conv.ID, 3)
	if err != nil || len(recent) != 3 {
		t.Fatalf("RecentMessages = %d rows, %v", len(recent), err)
	}
	if recent[0].ID != all[9].ID {
		t.Fatalf("recent[0] = %s, want the newest row %s", recent[0].ID, all[9].ID)
	}
}

func TestAssistantChangesUndoTransition(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)
	conv, _ := f.store.CreateConversation(ctx, f.owner)
	f.convIDs = append(f.convIDs, conv.ID)

	caller := assistant.Caller{UserID: f.owner, OrganizationID: "org-1"}
	undoable := f.insertChange(t, conv.ID, "draft_edit", true)
	notUndoable := f.insertChange(t, conv.ID, "run_retry", false)

	// List: open shows both, the payload itself is never returned.
	changes, err := f.store.ListChanges(ctx, f.owner, conv.ID, "open")
	if err != nil || len(changes) != 2 {
		t.Fatalf("ListChanges(open) = %d rows, %v", len(changes), err)
	}
	for _, ch := range changes {
		if ch.ID == undoable && !ch.Undoable {
			t.Fatalf("undoable change reported undoable=false")
		}
		if ch.ID == notUndoable && ch.UndoneAt != nil {
			t.Fatalf("fresh change has undone_at")
		}
	}

	// Undo the undoable one: the seam is UndoNotWired in the fixture store,
	// so the inverse refuses and the row stays open.
	if _, err := f.store.UndoChange(ctx, caller, undoable); !errors.Is(err, api.ErrAssistantChangeNotUndoable) {
		t.Fatalf("UndoChange err = %v, want not-undoable (UndoNotWired seam)", err)
	}
	got, err := f.store.ListChanges(ctx, f.owner, conv.ID, "open")
	if err != nil || len(got) != 2 {
		t.Fatalf("after failed undo, open changes = %d, %v; want still 2", len(got), err)
	}

	// The no-payload change is not undoable too.
	if _, err := f.store.UndoChange(ctx, caller, notUndoable); !errors.Is(err, api.ErrAssistantChangeNotUndoable) {
		t.Fatalf("UndoChange(no payload) err = %v, want not-undoable", err)
	}

	// A change the stranger owns is not found for the owner's caller.
	strChange, err := f.store.InsertChange(ctx, f.stranger, conv.ID, nil, "navigate",
		"/inbox", "Navigated to the inbox", nil)
	if err != nil {
		t.Fatalf("stranger InsertChange: %v", err)
	}
	f.changeIDs = append(f.changeIDs, strChange.ID)
	if _, err := f.store.UndoChange(ctx, caller, strChange.ID); !errors.Is(err, api.ErrAssistantChangeNotFound) {
		t.Fatalf("UndoChange(stranger's) err = %v, want not-found", err)
	}

	// A wired Undoer: the transition is one transaction — undone_at is
	// set and a second undo is the already-undone error (409 at the
	// route).
	wired := &AssistantConversationStore{Pool: f.pool, Undoer: fakeUndoer{}}
	_, err = wired.UndoChange(ctx, caller, undoable)
	if err != nil {
		t.Fatalf("UndoChange with wired undoer: %v", err)
	}
	row, err := f.store.ListChanges(ctx, f.owner, conv.ID, "undone")
	if err != nil || len(row) != 1 || row[0].ID != undoable {
		t.Fatalf("undone list = %v, %v; want just the undone change", row, err)
	}
	if row[0].UndoneAt == nil {
		t.Fatalf("undone change has no undone_at")
	}
	if _, err := wired.UndoChange(ctx, caller, undoable); !errors.Is(err, api.ErrAssistantChangeAlreadyUndone) {
		t.Fatalf("second undo err = %v, want already-undone (the route's 409)", err)
	}

	// undo-all: the no-payload open change reports not_undoable; a fresh
	// undoable change reports failed (the fixture store wires no Undoer,
	// which fails closed); one failure never blocks the next.
	fresh := f.insertChange(t, conv.ID, "draft_edit", true)
	results, err := f.store.UndoAll(ctx, caller, conv.ID)
	if err != nil {
		t.Fatalf("UndoAll: %v", err)
	}
	statuses := map[string]string{}
	for _, r := range results {
		statuses[r.ChangeID] = r.Status
	}
	if len(results) != 2 || statuses[notUndoable] != "not_undoable" {
		t.Fatalf("undo-all results = %v, want not_undoable for %s and one more row",
			results, notUndoable)
	}
	if statuses[fresh] != "failed" {
		t.Fatalf("unwired undo status = %q, want failed", statuses[fresh])
	}
}

// Org-scoped draft edits carry a NULL project id: the runner pins
// ProjectID to nil when the draft service cannot name a project (an
// empty-string uuid would fail this insert against real Postgres; the
// fakes hide it). This test records such a row, reads the column back
// and undoes it.
func TestAssistantChangeDraftEditNullProjectID(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)
	conv, err := f.store.CreateConversation(ctx, f.owner)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	f.convIDs = append(f.convIDs, conv.ID)

	ch, err := f.store.InsertChange(ctx, f.owner, conv.ID, nil, "draft_edit",
		"draft:d-1", "Inserted node `review` after `tests`",
		[]byte(`{"draft_id":"d-1","inverse":{"op":"delete_node","node":"review"}}`))
	if err != nil {
		t.Fatalf("InsertChange(nil project): %v", err)
	}
	f.changeIDs = append(f.changeIDs, ch.ID)
	if !ch.Undoable || ch.UndoneAt != nil {
		t.Fatalf("fresh change = %+v, want undoable and open", ch)
	}

	// The NULL survives into the column — an "" uuid would have errored.
	var stored *string
	if err := f.pool.QueryRow(ctx,
		`SELECT project_id FROM assistant_changes WHERE id = $1::uuid`, ch.ID).
		Scan(&stored); err != nil {
		t.Fatalf("read back project_id: %v", err)
	}
	if stored != nil {
		t.Fatalf("project_id = %q, want NULL (org-scoped draft)", *stored)
	}

	// The undo: wired inverse op + the undone_at stamp in one transaction.
	caller := assistant.Caller{UserID: f.owner, OrganizationID: "org-1"}
	wired := &AssistantConversationStore{Pool: f.pool, Undoer: fakeUndoer{}}
	if _, err := wired.UndoChange(ctx, caller, ch.ID); err != nil {
		t.Fatalf("UndoChange: %v", err)
	}
	undone, err := f.store.ListChanges(ctx, f.owner, conv.ID, "undone")
	if err != nil || len(undone) != 1 || undone[0].ID != ch.ID {
		t.Fatalf("undone list = %v, %v; want just this change", undone, err)
	}
	if undone[0].UndoneAt == nil {
		t.Fatalf("undone change has no undone_at")
	}
}

// fakeUndoer is the part-2-shaped seam test: the inverse op succeeds.
type fakeUndoer struct{}

func (fakeUndoer) UndoChange(ctx context.Context, c assistant.Caller, changeID string, payload json.RawMessage) error {
	return nil
}

func TestAssistantConversationCascadeOnUserDelete(t *testing.T) {
	t.Parallel()
	f := assistantTestFixture(t)
	ctx := testCtx(t)
	conv, _ := f.store.CreateConversation(ctx, f.owner)
	f.convIDs = append(f.convIDs, conv.ID)
	f.addTurn(t, conv.ID, "to be cascaded")
	f.insertChange(t, conv.ID, "draft_edit", true)

	if _, err := f.pool.Exec(ctx, `DELETE FROM users WHERE id = $1::uuid`, f.owner); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var convs, messages, changes int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM assistant_conversations WHERE id = $1::uuid`, conv.ID).Scan(&convs); err != nil {
		t.Fatalf("count convs: %v", err)
	}
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM assistant_messages WHERE conversation_id = $1::uuid`, conv.ID).Scan(&messages); err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM assistant_changes WHERE conversation_id = $1::uuid`, conv.ID).Scan(&changes); err != nil {
		t.Fatalf("count changes: %v", err)
	}
	if convs != 0 || messages != 0 || changes != 0 {
		t.Fatalf("cascade left convs=%d messages=%d changes=%d, want 0/0/0",
			convs, messages, changes)
	}
	// The fixture's user cleanup must not try to delete the owner again.
	f.owner = ""
}
