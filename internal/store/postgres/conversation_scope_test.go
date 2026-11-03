package postgres

// ADR-0067 amendment (docs/adr/ADR-0067-repo-scoped-conversations.md
// "Amendment: scope can change"): the controller may move a conversation's
// repository scope through the update route — a project repository, or null
// for the whole project — and the move journals conversation.scope_changed
// with the from/to ids and actor, in the same transaction as the column
// write. Against a real PostgreSQL: the binding lands and the detail read
// echoes it; a foreign project's repository and any other unknown id are
// ErrConversationValidation (422 repository_not_in_project), answered
// identically so a probe leaks nothing; null unbinds; the same write is an
// idempotent no-op; and the same authorization as sending a turn refuses the
// viewer, the non-member and the non-controller.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/events"
)

// cscRepo inserts one repository of the fixture's project and returns its id,
// with a cleanup that unbinds any conversation before the row goes (the
// composite FK of migration 00022 out-references bound threads).
func cscRepo(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		f.project, name, f.alice).into(t, &id)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg,
			`UPDATE conversations SET repository_id = NULL WHERE repository_id = $1::uuid`, id); err != nil {
			f.t.Errorf("unbind conversations from repository (%s): %v", id, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM repositories WHERE id = $1::uuid`, id); err != nil {
			f.t.Errorf("cleanup repository %s: %v", id, err)
		}
	})
	return id
}

// cscScopeEvent reads the conversation.scope_changed rows the fixture's
// conversation carries, oldest first, decoded.
func cscScopeEvents(t *testing.T, f *cnvFixture, conversationID string) []events.ScopeChangedPayload {
	t.Helper()
	var out []events.ScopeChangedPayload
	for _, row := range f.journalRows(t, conversationID) {
		if row.typ != events.TypeConversationScopeChanged {
			continue
		}
		var p events.ScopeChangedPayload
		if err := json.Unmarshal(row.payload, &p); err != nil {
			t.Fatalf("decode scope_changed payload: %v", err)
		}
		out = append(out, p)
	}
	return out
}

func cscBoundRepository(t *testing.T, f *cnvFixture, conversationID string) string {
	t.Helper()
	var id string
	f.queryRow(t,
		"SELECT COALESCE(repository_id::text, '') FROM conversations WHERE id = $1::uuid",
		conversationID).into(t, &id)
	return id
}

func TestConversationScopeChangeByController(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	repoB := cscRepo(t, f, "scope-beta")
	chat := f.cnvCreate(t, f.alice, "cnv scope change", "")

	// Into one of the project's repositories.
	out, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoA)
	if err != nil {
		t.Fatalf("ChangeScope into a project repository: %v", err)
	}
	if cscBoundRepository(t, f, chat.ID) != repoA {
		t.Fatalf("conversations.repository_id = %q, want %s", cscBoundRepository(t, f, chat.ID), repoA)
	}
	if out.RepositoryID != repoA || out.RepositoryName != "scope-alpha" {
		t.Errorf("detail read = %s/%q, want the alpha repository", out.RepositoryID, out.RepositoryName)
	}

	// The journal row: actor, from (null — the thread was unbound) and to.
	rows := cscScopeEvents(t, f, chat.ID)
	if len(rows) != 1 {
		t.Fatalf("%d scope_changed rows, want 1", len(rows))
	}
	ev := rows[0]
	if ev.ConversationID != chat.ID || ev.ActorUserID != f.alice {
		t.Errorf("scope_changed = %+v, want actor alice on %s", ev, chat.ID)
	}
	if ev.FromRepositoryID != nil || ev.FromRepositoryName != nil {
		t.Errorf("from = %v/%v, want nulls (the thread was unbound)",
			ev.FromRepositoryID, ev.FromRepositoryName)
	}
	if ev.ToRepositoryID == nil || *ev.ToRepositoryID != repoA ||
		ev.ToRepositoryName == nil || *ev.ToRepositoryName != "scope-alpha" {
		t.Errorf("to = %v/%v, want %s/scope-alpha", ev.ToRepositoryID, ev.ToRepositoryName, repoA)
	}

	// To the OTHER repository: the from/to pairs move with the binding.
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoB); err != nil {
		t.Fatalf("ChangeScope to the beta repository: %v", err)
	}
	if cscBoundRepository(t, f, chat.ID) != repoB {
		t.Fatalf("binding = %s, want %s", cscBoundRepository(t, f, chat.ID), repoB)
	}
	rows = cscScopeEvents(t, f, chat.ID)
	if len(rows) != 2 {
		t.Fatalf("%d scope_changed rows after the second move, want 2", len(rows))
	}
	if rows[1].FromRepositoryID == nil || *rows[1].FromRepositoryID != repoA ||
		rows[1].ToRepositoryID == nil || *rows[1].ToRepositoryID != repoB {
		t.Errorf("second row from/to = %v/%v, want %s → %s",
			rows[1].FromRepositoryID, rows[1].ToRepositoryID, repoA, repoB)
	}

	// Null is the whole project: the binding goes NULL and the event's to
	// pair says so (a pre-ADR-0067 row reads exactly this way).
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, ""); err != nil {
		t.Fatalf("ChangeScope to the whole project: %v", err)
	}
	if bound := cscBoundRepository(t, f, chat.ID); bound != "" {
		t.Fatalf("binding after unbind = %q, want empty", bound)
	}
	rows = cscScopeEvents(t, f, chat.ID)
	if len(rows) != 3 || rows[2].ToRepositoryID != nil || rows[2].ToRepositoryName != nil {
		t.Fatalf("want a third row with null to-pair, got %+v", rows)
	}
}

func TestConversationScopeChangeIsIdempotent(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	chat := f.cnvCreate(t, f.alice, "cnv scope idempotent", "")

	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoA); err != nil {
		t.Fatalf("first ChangeScope: %v", err)
	}
	// Moving to the scope the thread already has: no write, no event —
	// the double-click rule.
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoA); err != nil {
		t.Fatalf("repeated ChangeScope: %v", err)
	}
	if rows := cscScopeEvents(t, f, chat.ID); len(rows) != 1 {
		t.Fatalf("%d scope_changed rows after the no-op, want 1", len(rows))
	}
	// The same holds for the whole project on an already-unbound thread.
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, ""); err != nil {
		t.Fatalf("ChangeScope to null on an unbound thread: %v", err)
	}
	chat2 := f.cnvCreate(t, f.alice, "cnv scope idempotent two", "")
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat2.ID, ""); err != nil {
		t.Fatalf("ChangeScope to null: %v", err)
	}
	if rows := cscScopeEvents(t, f, chat2.ID); len(rows) != 0 {
		t.Fatalf("no-op unbind journaled %d rows, want none", len(rows))
	}
}

// A repository the conversation's project does not have is 422, answered
// identically for a foreign project's repository and for an id that is no
// repository row anywhere — the probe leaks nothing about who else has it.
func TestConversationScopeChangeForeignAndUnknown(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	chat := f.cnvCreate(t, f.alice, "cnv scope foreign", "")

	// A well-formed id of another project's repository.
	var other string
	f.queryRow(t, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'csc-other-' || $2, 'Scope foreign fixture', $3::uuid) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.alice).into(t, &other)
	var foreign string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		other, "scope-foreign", f.alice).into(t, &foreign)
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			`DELETE FROM repositories WHERE project_id = $1::uuid`,
			`DELETE FROM memberships WHERE project_id = $1::uuid`,
			`DELETE FROM projects WHERE id = $1::uuid`,
		} {
			if _, err := f.pool.Exec(bg, q, other); err != nil {
				f.t.Errorf("cleanup foreign fixture (%q): %v", q, err)
			}
		}
	})

	for name, target := range map[string]string{
		"foreign project's repository":    foreign,
		"an id that is no repository row": "01987a72-9999-7000-8000-abcdef000003",
	} {
		if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, target); !errors.Is(err, ErrConversationValidation) {
			t.Errorf("%s: err = %v, want ErrConversationValidation", name, err)
		} else if !strings.Contains(err.Error(), "repository_not_in_project") {
			t.Errorf("%s: err = %v, want the repository_not_in_project code", name, err)
		}
		if bound := cscBoundRepository(t, f, chat.ID); bound != "" {
			t.Errorf("%s: the refusal wrote binding %q", name, bound)
		}
	}
	// The project's own repository still lands afterwards.
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoA); err != nil {
		t.Fatalf("ChangeScope after the refusals: %v", err)
	}
	if rows := cscScopeEvents(t, f, chat.ID); len(rows) != 1 {
		t.Fatalf("the refusals journaled %d rows; only the landed move may journal", len(rows))
	}
}

// The route's authorization, proven at the database: the viewer's 403, the
// non-member's 404, and the non-controller's 409 carrying the live control —
// the same three answers sending a turn gives.
func TestConversationScopeChangeAuthz(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	chat := f.cnvCreate(t, f.alice, "cnv scope authz", "")

	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.carl), chat.ID, repoA); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("viewer: err = %v, want ErrConversationForbidden", err)
	}
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.outsider), chat.ID, repoA); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("non-member: err = %v, want ErrConversationNotFound", err)
	}
	var conflict *CnvConflict
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.bob), chat.ID, repoA); !errors.As(err, &conflict) || conflict.Kind != ConflictNotController {
		t.Errorf("non-controller: err = %v, want *CnvConflict not_controller", err)
	}
	// Nobody but the controller may touch the column.
	if bound := cscBoundRepository(t, f, chat.ID); bound != "" {
		t.Errorf("the refusals wrote binding %q", bound)
	}
	if rows := cscScopeEvents(t, f, chat.ID); len(rows) != 0 {
		t.Errorf("the refusals journaled %d rows, want none", len(rows))
	}
}

// An archived thread takes no scope change either: the same 409 PostMessage
// gives, naming the state that refused it.
func TestConversationScopeChangeArchived(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	chat := f.cnvCreate(t, f.alice, "cnv scope archived", "")
	f.exec(t, "UPDATE conversations SET status = 'archived' WHERE id = $1", chat.ID)

	var conflict *CnvConflict
	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, repoA); !errors.As(err, &conflict) || conflict.Kind != ConflictArchived {
		t.Errorf("archived: err = %v, want *CnvConflict conversation_archived", err)
	}
}

// The event's from-pair reads the row's own repositories name, so the
// transcript's "moved this chat to <repo>" can print names, never ids — and
// a binding set through the CREATE route (by name) carries the same name
// into the event.
func TestConversationScopeChangeNamesFromCreateBinding(t *testing.T) {
	f := cnvSetup(t)
	repoA := cscRepo(t, f, "scope-alpha")
	chat, err := f.store.CreateConversation(testCtx(t), f.caller(f.alice), f.project, f.profile,
		"cnv scope from create", "", "scope-alpha")
	if err != nil {
		t.Fatalf("CreateConversation bound to scope-alpha: %v", err)
	}
	if chat.RepositoryID != repoA {
		t.Fatalf("create binding id = %s, want %s", chat.RepositoryID, repoA)
	}

	if _, err := f.store.ChangeScope(testCtx(t), f.caller(f.alice), chat.ID, ""); err != nil {
		t.Fatalf("ChangeScope to the whole project: %v", err)
	}
	if got := chat.RepositoryName; got != "scope-alpha" {
		t.Errorf("create binding name = %q, want scope-alpha", got)
	}
	rows := cscScopeEvents(t, f, chat.ID)
	if len(rows) != 1 || rows[0].FromRepositoryName == nil || *rows[0].FromRepositoryName != "scope-alpha" ||
		rows[0].FromRepositoryID == nil || *rows[0].FromRepositoryID != repoA {
		t.Fatalf("scope_changed = %+v, want from scope-alpha (%s)", rows, repoA)
	}
}
