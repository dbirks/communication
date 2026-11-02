package postgres

// ADR-0071 (docs/adr/ADR-0071-assistant-notes.md): the assistant-notes store,
// against a real PostgreSQL. What is proven here is the data rule, not a
// model. In order: at most api.AssistantNotesActiveCap notes are ACTIVE for
// one user AND one scope, and the overflow is DELETED (a dismissed row would
// still be a row); dismissal is per user, so one member hiding a note changes
// nobody else's panel; expiry is a clock, not a delete; authz is the project's
// own rule (a viewer is a member, a stranger is a stranger, in the
// organization or out of it) and every refusal is audited against the project
// it was refused in; a dismiss by anyone but the owner answers the same "no
// such note" the store's 404 is built from; and the scope check stops a note
// written about a repository of a project that is not the note's.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
)

// anStore is the notes store on the fixture pool.
func anStore(f *cnvFixture) *AssistantNotesStore {
	return &AssistantNotesStore{Pool: f.pool}
}

// anAPI is the api-facing adapter, with the same ProjectStore serve.go hands
// it for audit denials.
func anAPI(f *cnvFixture) APIAssistantNotesStore {
	return APIAssistantNotesStore{S: anStore(f), Denials: &ProjectStore{Pool: f.pool}}
}

// anCaller is the fixture caller as the adapter sees it.
func anCaller(f *cnvFixture, user string) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.orgID}
}

// anRepo attaches a repository to the fixture project. The cleanup registers
// after cnvSetup's, so it runs before it (LIFO): repositories is
// out-referenced by conversations born bound to it.
func anRepo(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file:///srv/' || $2, 'main', $3::uuid) RETURNING id::text`,
		f.project, name, f.alice).into(t, &id)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `UPDATE conversations SET repository_id = NULL WHERE repository_id = $1::uuid`, id); err != nil {
			t.Errorf("unbind conversations from repository %s: %v", name, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM repositories WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup repository %s: %v", name, err)
		}
	})
	return id
}

// anForeignRepo attaches a repository to a SECOND project of the organization
// that none of the fixture's users is a member of, and returns its id. It is
// the cross-project scope the insert guard must refuse.
func anForeignRepo(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var other, repo string
	f.queryRow(t, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'an-other-' || $2, 'Assistant notes foreign fixture', $3::uuid) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.alice).into(t, &other)
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		other, name, f.alice).into(t, &repo)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM assistant_notes WHERE project_id = $1::uuid`, other); err != nil {
			t.Errorf("cleanup notes of the foreign project: %v", err)
		}
		if _, err := f.pool.Exec(bg, `UPDATE conversations SET repository_id = NULL WHERE repository_id = $1::uuid`, repo); err != nil {
			t.Errorf("unbind conversations from the foreign repository: %v", err)
		}
		for _, q := range []string{
			`DELETE FROM repositories WHERE id = $1::uuid`,
			`DELETE FROM memberships WHERE project_id = $1::uuid`,
			`DELETE FROM projects WHERE id = $1::uuid`,
		} {
			arg := repo
			if q != `DELETE FROM repositories WHERE id = $1::uuid` {
				arg = other
			}
			if _, err := f.pool.Exec(bg, q, arg); err != nil {
				t.Errorf("cleanup foreign fixture (%q): %v", q, err)
			}
		}
	})
	return repo
}

// anChat starts a conversation on the fixture store and returns its id: the
// second scope kind.
func anChat(t *testing.T, f *cnvFixture, user, title string) string {
	t.Helper()
	chat, err := f.store.CreateConversation(f.ctx(), f.caller(user), f.project, f.profile,
		title, "ADR-0071 fixture prompt", "")
	if err != nil {
		t.Fatalf("CreateConversation(%q): %v", title, err)
	}
	return chat.ID
}

// anNotesCleanup removes every note row these tests write. It registers after
// cnvSetup's cleanup, so it runs first (LIFO): users and projects are
// out-referenced by their notes.
func anNotesCleanup(t *testing.T, f *cnvFixture) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `
			DELETE FROM assistant_notes
			WHERE project_id = $1::uuid
			   OR user_id = ANY($2::uuid[])`,
			f.project,
			[]string{f.alice, f.bob, f.carl, f.outsider, f.mallory}); err != nil {
			t.Errorf("cleanup assistant notes: %v", err)
		}
		if _, err := f.pool.Exec(bg,
			`DELETE FROM audit_events WHERE action LIKE 'assistant\_note.%' AND project_id = $1::uuid`,
			f.project); err != nil {
			t.Errorf("cleanup assistant note audit rows: %v", err)
		}
	})
}

// anInsert writes one note (no deadline) and returns its id.
func anInsert(t *testing.T, f *cnvFixture, user, scopeKind, scopeID, text string) string {
	t.Helper()
	note, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: user, ScopeKind: scopeKind, ScopeID: scopeID, Text: text,
	})
	if err != nil {
		t.Fatalf("InsertAssistantNote(%q): %v", text, err)
	}
	if note.ID == "" {
		t.Fatalf("InsertAssistantNote(%q) returned an empty id", text)
	}
	return note.ID
}

// anInsertAt writes one note with an explicit deadline, straight through the
// input path — so the store's own admission of a already-stale horizon is the
// thing under test, not a fixture's opinion about it.
func anInsertAt(t *testing.T, f *cnvFixture, user, scopeKind, scopeID, text string,
	expiresAt *time.Time) string {
	t.Helper()
	note, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: user, ScopeKind: scopeKind, ScopeID: scopeID,
		Text: text, ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("InsertAssistantNote(%q, expires=%v): %v", text, formatAnTime(expiresAt), err)
	}
	return note.ID
}

func formatAnTime(t *time.Time) string {
	if t == nil {
		return "never"
	}
	return t.Format(time.RFC3339)
}

func anListRepo(t *testing.T, f *cnvFixture, user, project, repo string) ([]api.AssistantNoteView, error) {
	t.Helper()
	return anAPI(f).ListRepositoryNotes(f.ctx(), anCaller(f, user), project, repo)
}

func anListChat(t *testing.T, f *cnvFixture, user, chat string) ([]api.AssistantNoteView, error) {
	t.Helper()
	return anAPI(f).ListConversationNotes(f.ctx(), anCaller(f, user), chat)
}

func anDismiss(t *testing.T, f *cnvFixture, user, note string) error {
	t.Helper()
	return anAPI(f).DismissAssistantNote(f.ctx(), anCaller(f, user), note)
}

func anTexts(items []api.AssistantNoteView) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Text)
	}
	return out
}

func anCount(t *testing.T, f *cnvFixture, q string, args ...any) int {
	t.Helper()
	var n int
	f.queryRow(t, q, args...).into(t, &n)
	return n
}

// TestAssistantNotesCapDropsOldest is the cap: five notes for one user and
// scope leave three ACTIVE, newest first, and the two that went are GONE — a
// dismissed row would still be a row.
func TestAssistantNotesCapDropsOldest(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-cap")

	for i := 1; i <= 5; i++ {
		anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "note "+string(rune('0'+i)))
	}

	items, err := anListRepo(t, f, f.alice, f.project, repo)
	if err != nil {
		t.Fatalf("ListRepositoryNotes: %v", err)
	}
	if len(items) != api.AssistantNotesActiveCap {
		t.Fatalf("active notes = %d %v, want %d", len(items), anTexts(items), api.AssistantNotesActiveCap)
	}
	want := []string{"note 5", "note 4", "note 3"}
	if got := anTexts(items); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("active notes = %v, want %v (newest first)", got, want)
	}
	if n := anCount(t, f, `SELECT count(*) FROM assistant_notes WHERE scope_id = $1::uuid`, repo); n != 3 {
		t.Errorf("rows for the scope = %d, want 3 — the overflow is dropped, not flagged", n)
	}
	for _, text := range []string{"note 1", "note 2"} {
		if n := anCount(t, f, `SELECT count(*) FROM assistant_notes WHERE text = $1`, text); n != 0 {
			t.Errorf("%q survives as %d rows, want 0", text, n)
		}
	}
}

// TestAssistantNotesCapIsPerUserAndScope: the cap does not leak across either
// axis. Three (user, scope) pairs of four notes each keep their own newest.
func TestAssistantNotesCapIsPerUserAndScope(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repoA := anRepo(t, f, "an-cap-a")
	repoB := anRepo(t, f, "an-cap-b")
	chat := anChat(t, f, f.alice, "an-cap-chat")

	type bucket struct{ user, kind, scope, tag string }
	buckets := []bucket{
		{f.alice, api.AssistantNoteScopeRepository, repoA, "repo-a-alice"},
		{f.bob, api.AssistantNoteScopeRepository, repoA, "repo-a-bob"},
		{f.alice, api.AssistantNoteScopeRepository, repoB, "repo-b-alice"},
		{f.alice, api.AssistantNoteScopeConversation, chat, "chat-alice"},
	}
	for _, b := range buckets {
		for i := 1; i <= 4; i++ {
			anInsert(t, f, b.user, b.kind, b.scope, b.tag+" "+string(rune('0'+i)))
		}
	}
	for _, b := range buckets {
		var (
			items []api.AssistantNoteView
			err   error
		)
		switch b.kind {
		case api.AssistantNoteScopeRepository:
			items, err = anListRepo(t, f, b.user, f.project, b.scope)
		case api.AssistantNoteScopeConversation:
			items, err = anListChat(t, f, b.user, b.scope)
		}
		if err != nil {
			t.Fatalf("list %s: %v", b.tag, err)
		}
		want := []string{b.tag + " 4", b.tag + " 3", b.tag + " 2"}
		if got := anTexts(items); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s notes = %v, want %v", b.tag, got, want)
		}
	}
}

// TestAssistantNotesDismissIsPerUser is the dismissal half of "per user, can
// be dismissed": the owner's list loses the note, the row survives with
// dismissed_at set, and nobody else's list changes.
func TestAssistantNotesDismissIsPerUser(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-dismiss")

	hers := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "alice one")
	kept := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "alice two")
	bobs := anInsert(t, f, f.bob, api.AssistantNoteScopeRepository, repo, "bob one")

	if err := anDismiss(t, f, f.alice, hers); err != nil {
		t.Fatalf("DismissAssistantNote(owner): %v", err)
	}

	items, err := anListRepo(t, f, f.alice, f.project, repo)
	if err != nil {
		t.Fatalf("ListRepositoryNotes(alice): %v", err)
	}
	if got := anTexts(items); strings.Join(got, ",") != "alice two" {
		t.Fatalf("alice's notes = %v, want only the undismissed one", got)
	}
	if items[0].ID != kept {
		t.Errorf("surviving note = %s, want %s", items[0].ID, kept)
	}
	// Inactive, not deleted: the row is kept for the record with dismissed_at
	// set — which is what ADR-0071's "the panel is transient, the claim is
	// not" means in SQL.
	if n := anCount(t, f,
		`SELECT count(*) FROM assistant_notes WHERE id = $1::uuid AND dismissed_at IS NOT NULL`, hers); n != 1 {
		t.Fatalf("dismissed row count = %d, want 1 with dismissed_at set", n)
	}
	// A second dismiss is not a second success: the note is no longer one the
	// caller can act on, and the answer for that is the 404's sentinel.
	if err := anDismiss(t, f, f.alice, hers); !errors.Is(err, api.ErrAssistantNoteNotFound) {
		t.Errorf("re-dismiss error = %v, want api.ErrAssistantNoteNotFound", err)
	}
	// Bob never saw alice's note, and alice's dismiss did not spend his.
	bobItems, err := anListRepo(t, f, f.bob, f.project, repo)
	if err != nil {
		t.Fatalf("ListRepositoryNotes(bob): %v", err)
	}
	if got := anTexts(bobItems); strings.Join(got, ",") != "bob one" {
		t.Fatalf("bob's notes = %v, want his own note untouched by alice's dismissal", got)
	}
	if bobItems[0].ID != bobs {
		t.Errorf("bob's note id = %s, want %s", bobItems[0].ID, bobs)
	}
}

// TestAssistantNotesExpiry is the third way a note stops being active: the
// clock. An expired row stays (it is the generator's own ledger), it simply
// stops answering a list; a note with a future deadline is served WITH that
// deadline; and an undated one is served with a null expires_at rather than a
// invented horizon.
func TestAssistantNotesExpiry(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-expiry")

	// Already stale when written: admitted (it is legal SQL and an honest
	// record), never served.
	expired := anInsertAt(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "already stale",
		ptrTime(time.Now().Add(-time.Hour)))
	live := anInsertAt(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "still in time",
		ptrTime(time.Now().Add(time.Hour)))
	quiet := anInsertAt(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "no deadline", nil)

	items, err := anListRepo(t, f, f.alice, f.project, repo)
	if err != nil {
		t.Fatalf("ListRepositoryNotes: %v", err)
	}
	got := map[string]api.AssistantNoteView{}
	for _, it := range items {
		got[it.ID] = it
	}
	if _, served := got[expired]; served {
		t.Errorf("an expired note was served: %+v", got[expired])
	}
	liveNote, ok := got[live]
	if !ok {
		t.Fatalf("live note missing from %v", anTexts(items))
	}
	if liveNote.ExpiresAt == nil || liveNote.ExpiresAt.Before(time.Now().Add(time.Minute)) {
		t.Errorf("live note expires_at = %v, want the future deadline back", liveNote.ExpiresAt)
	}
	quietNote, ok := got[quiet]
	if !ok {
		t.Fatalf("undated note missing from %v", anTexts(items))
	}
	if quietNote.ExpiresAt != nil {
		t.Errorf("undated note serves expires_at = %v, want null", quietNote.ExpiresAt)
	}
	if n := anCount(t, f, `SELECT count(*) FROM assistant_notes WHERE id = $1::uuid`, expired); n != 1 {
		t.Errorf("expired row count = %d, want 1 — expiry hides a note, it does not delete it", n)
	}
	// An expired note is also not dismissible: there is nothing left to hide,
	// and claiming success would be a lie about a write that did not happen.
	if err := anDismiss(t, f, f.alice, expired); !errors.Is(err, api.ErrAssistantNoteNotFound) {
		t.Errorf("dismiss(expired) error = %v, want api.ErrAssistantNoteNotFound", err)
	}
}

// TestAssistantNotesAuthz is the project's own rule: a member reads (a viewer
// included), a stranger in the organization and a stranger out of it both get
// the same error, for both scopes, and each refusal lands in the audit log
// against the project it was aimed at.
func TestAssistantNotesAuthz(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-authz")
	chat := anChat(t, f, f.alice, "an-authz-chat")
	anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "alice's note")
	anInsert(t, f, f.carl, api.AssistantNoteScopeRepository, repo, "carl's note")
	anInsert(t, f, f.bob, api.AssistantNoteScopeConversation, chat, "bob's chat note")

	// A viewer is a member: the note list is a read, and it is per user.
	viewerItems, err := anListRepo(t, f, f.carl, f.project, repo)
	if err != nil {
		t.Fatalf("viewer ListRepositoryNotes: %v", err)
	}
	if got := anTexts(viewerItems); strings.Join(got, ",") != "carl's note" {
		t.Errorf("viewer saw %v, want only their own notes", got)
	}
	// A member with nothing of their own reads an empty list, not an error.
	if items, err := anListRepo(t, f, f.bob, f.project, repo); err != nil || len(items) != 0 {
		t.Errorf("member with no notes = %v / %v, want an empty list", anTexts(items), err)
	}
	// The conversation scope serves its own project's member.
	items, err := anListChat(t, f, f.bob, chat)
	if err != nil {
		t.Fatalf("member ListConversationNotes: %v", err)
	}
	if got := anTexts(items); strings.Join(got, ",") != "bob's chat note" {
		t.Errorf("conversation notes = %v, want the member's own note", got)
	}

	denialsBefore := anCount(t, f,
		`SELECT count(*) FROM audit_events WHERE project_id = $1::uuid AND outcome = 'denied'`, f.project)
	foreign := anForeignRepo(t, f, "an-authz-foreign")

	for _, user := range []string{f.outsider, f.mallory} {
		if _, err := anListRepo(t, f, user, f.project, repo); !errors.Is(err, api.ErrProjectNotFound) {
			t.Errorf("%s: ListRepositoryNotes error = %v, want api.ErrProjectNotFound", user, err)
		}
		if _, err := anListChat(t, f, user, chat); !errors.Is(err, api.ErrProjectNotFound) {
			t.Errorf("%s: ListConversationNotes error = %v, want api.ErrProjectNotFound", user, err)
		}
		// The note id is real, the note is not theirs.
		theirs := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "not yours")
		if err := anDismiss(t, f, user, theirs); !errors.Is(err, api.ErrAssistantNoteNotFound) {
			t.Errorf("%s: dismiss error = %v, want api.ErrAssistantNoteNotFound", user, err)
		}
		// A repository of a project they hold no membership in at all is the
		// same 404: the scope read cannot resolve the pair.
		if _, err := anListRepo(t, f, user, f.project, foreign); !errors.Is(err, api.ErrProjectNotFound) {
			t.Errorf("%s: foreign repository list error = %v, want api.ErrProjectNotFound", user, err)
		}
	}

	// Four list refusals and two dismiss refusals: every one of them audited.
	if n := anCount(t, f,
		`SELECT count(*) FROM audit_events WHERE project_id = $1::uuid AND outcome = 'denied'
		   AND action LIKE 'assistant\_note.%'`, f.project); n < 6 {
		t.Errorf("audited note denials = %d, want at least 6 (before: %d)", n, denialsBefore)
	}
}

// TestAssistantNotesDismissByNonOwner is the 404's store half: another MEMBER
// of the same project — somebody who can see the repository and nothing about
// the note — is told the note does not exist, the owner's note stays active,
// and the attempt is audited.
func TestAssistantNotesDismissByNonOwner(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-owner")

	hers := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "alice only")
	if err := anDismiss(t, f, f.bob, hers); !errors.Is(err, api.ErrAssistantNoteNotFound) {
		t.Fatalf("non-owner dismiss error = %v, want api.ErrAssistantNoteNotFound", err)
	}
	items, err := anListRepo(t, f, f.alice, f.project, repo)
	if err != nil || len(items) != 1 || items[0].ID != hers {
		t.Fatalf("owner's list after a stranger's dismiss = %v / %v, want the note still active",
			anTexts(items), err)
	}
	if n := anCount(t, f, `SELECT count(*) FROM assistant_notes WHERE id = $1::uuid AND dismissed_at IS NULL`,
		hers); n != 1 {
		t.Fatalf("non-owner dismiss changed the row (count = %d), want it still active", n)
	}
	if n := anCount(t, f,
		`SELECT count(*) FROM audit_events WHERE project_id = $1::uuid AND action = 'assistant_note.dismiss'
		   AND outcome = 'denied' AND actor_id = $2`, f.project, f.bob); n != 1 {
		t.Errorf("audit rows for the non-owner dismiss = %d, want 1", n)
	}
	// An id that stops naming a note is the same answer.
	random := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "to be deleted")
	if err := anDismiss(t, f, f.alice, random); err != nil {
		t.Fatalf("owner dismiss: %v", err)
	}
	f.exec(t, `DELETE FROM assistant_notes WHERE id = $1::uuid`, random)
	if err := anDismiss(t, f, f.alice, random); !errors.Is(err, api.ErrAssistantNoteNotFound) {
		t.Errorf("dismiss of a gone note = %v, want api.ErrAssistantNoteNotFound", err)
	}
	// ...and it writes no audit row: alice's own successful dismiss above was
	// not a denial, and the gone-note refusal names no project, so nothing of
	// hers belongs in the ledger. A caller-chosen uuid must not be able to put
	// one there.
	if n := anCount(t, f,
		`SELECT count(*) FROM audit_events WHERE action = 'assistant_note.dismiss'
		   AND outcome = 'denied' AND actor_id = $1`, f.alice); n != 0 {
		t.Errorf("audit rows for a note that never existed = %d, want 0", n)
	}
}

// TestAssistantNotesScopeGuard stops a note written about a repository of
// another project, and refuses the scope vocabulary the CHECK would reject —
// in both directions, since the note's project and the scope's project have
// to be the same row.
func TestAssistantNotesScopeGuard(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	foreign := anForeignRepo(t, f, "an-foreign")
	repo2 := anRepo(t, f, "an-scope-repo")
	chat := anChat(t, f, f.alice, "an-scope-chat")

	_, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: foreign, Text: "wrong project",
	})
	if !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Fatalf("cross-project scope insert error = %v, want api.ErrAssistantNoteValidation", err)
	}
	if n := anCount(t, f, `SELECT count(*) FROM assistant_notes WHERE scope_id = $1::uuid`, foreign); n != 0 {
		t.Errorf("foreign scope has %d rows, want 0", n)
	}
	// The same mismatch the other way round: a repository id is not a
	// conversation, so the kind and the id have to agree as well as the
	// project.
	if _, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeConversation, ScopeID: repo2, Text: "wrong kind back",
	}); !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Errorf("repository id as a conversation scope = %v, want api.ErrAssistantNoteValidation", err)
	}
	if _, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: "project", ScopeID: f.project, Text: "not a scope",
	}); !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Errorf("unknown scope_kind = %v, want api.ErrAssistantNoteValidation", err)
	}
	// A non-uuid id is a validation error, not a driver error.
	if _, err := anStore(f).InsertAssistantNote(f.ctx(), api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: "storefront", Text: "by name",
	}); !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Errorf("non-uuid scope_id = %v, want api.ErrAssistantNoteValidation", err)
	}
	// And the conversation scope does work when the pair is honest.
	id := anInsert(t, f, f.alice, api.AssistantNoteScopeConversation, chat, "right pair")
	items, err := anListChat(t, f, f.alice, chat)
	if err != nil || len(items) != 1 || items[0].ID != id {
		t.Fatalf("conversation scope list = %v / %v, want the note just written", anTexts(items), err)
	}
}

// TestAssistantNotesStoredText: the write path trims, the table CHECKs the
// trim, the bound counts characters, and the action round-trips through jsonb
// as the same allowlisted union.
func TestAssistantNotesStoredText(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-text")
	ctx := f.ctx()

	tooLong := strings.Repeat("y", api.AssistantNoteTextMaxChars+1)
	if _, err := anStore(f).InsertAssistantNote(ctx, api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: repo, Text: tooLong,
	}); !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Errorf("%d-char note error = %v, want api.ErrAssistantNoteValidation", len(tooLong), err)
	}
	if _, err := anStore(f).InsertAssistantNote(ctx, api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: repo,
		Text: strings.Repeat("é", api.AssistantNoteTextMaxChars),
	}); err != nil {
		t.Errorf("%d characters (%d bytes) refused: %v",
			api.AssistantNoteTextMaxChars,
			len(strings.Repeat("é", api.AssistantNoteTextMaxChars)), err)
	}
	if _, err := anStore(f).InsertAssistantNote(ctx, api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: repo, Text: "  \n ",
	}); !errors.Is(err, api.ErrAssistantNoteValidation) {
		t.Errorf("blank note error = %v, want api.ErrAssistantNoteValidation", err)
	}

	padded, err := anStore(f).InsertAssistantNote(ctx, api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: repo, Text: "  padded  ",
	})
	if err != nil {
		t.Fatalf("padded note: %v", err)
	}
	if padded.Text != "padded" {
		t.Errorf("returned text = %q, want the trimmed %q", padded.Text, "padded")
	}
	var stored string
	f.queryRow(t, `SELECT "text" FROM assistant_notes WHERE id = $1::uuid`, padded.ID).into(t, &stored)
	if stored != "padded" {
		t.Errorf("stored text = %q, want %q — the table CHECKs that it is trimmed", stored, "padded")
	}

	// The action survives the round trip as the union it was.
	if _, err := anStore(f).InsertAssistantNote(ctx, api.AssistantNoteInput{
		ProjectID: f.project, UserID: f.alice,
		ScopeKind: api.AssistantNoteScopeRepository, ScopeID: repo, Text: "hand these off",
		Action: &api.AssistantNoteAction{Kind: api.AssistantNoteActionHandOff, IssueNumbers: []int{421, 7}},
	}); err != nil {
		t.Fatalf("hand_off note: %v", err)
	}
	items, err := anListRepo(t, f, f.alice, f.project, repo)
	if err != nil || len(items) == 0 {
		t.Fatalf("list after valid writes = %v / %v", anTexts(items), err)
	}
	var action *api.AssistantNoteAction
	for _, it := range items {
		if it.Action != nil {
			action = it.Action
		}
	}
	if action == nil || action.Kind != api.AssistantNoteActionHandOff ||
		len(action.IssueNumbers) != 2 || action.IssueNumbers[0] != 421 {
		t.Errorf("stored action = %+v, want hand_off with issue_numbers [421,7]", action)
	}
	// A note with no action is a note that only says something.
	var noAction int
	for _, it := range items {
		if it.Action == nil {
			noAction++
		}
	}
	if noAction == 0 {
		t.Errorf("every stored note carries an action, want at least one that does not")
	}
}

// TestAssistantNotesCorruptActionFailsTheRead is the read half of the
// allowlist: a row whose action is not the union (here: an object with a
// member no kind owns) is corruption, and the list refuses to serve a
// half-read action a client could act on.
func TestAssistantNotesCorruptActionFailsTheRead(t *testing.T) {
	f := cnvSetup(t)
	anNotesCleanup(t, f)
	repo := anRepo(t, f, "an-corrupt")
	id := anInsert(t, f, f.alice, api.AssistantNoteScopeRepository, repo, "went wrong")
	f.exec(t, `UPDATE assistant_notes SET action = '{"kind":"open_run","prompt":"smuggled"}'::jsonb
		WHERE id = $1::uuid`, id)
	if _, err := anListRepo(t, f, f.alice, f.project, repo); err == nil {
		t.Fatalf("corrupt action served, want the read to fail")
	} else if !strings.Contains(err.Error(), "assistant note action") {
		t.Errorf("error = %v, want it to name the action", err)
	}
	// An action that is not an object at all is UNREPRESENTABLE: migration
	// 00027's jsonb_typeof CHECK refuses the write, so a hand-edited row
	// cannot even hold a link to follow. That refusal is the assertion.
	_, err := f.pool.Exec(f.ctx(),
		`UPDATE assistant_notes SET action = '"http://example.com"'::jsonb WHERE id = $1::uuid`, id)
	if err == nil {
		t.Fatalf("a non-object action was stored, want the jsonb_typeof CHECK to refuse it")
	}
	if !strings.Contains(err.Error(), "assistant_notes_action_check") {
		t.Errorf("non-object action error = %v, want the CHECK to be named", err)
	}
	// The corrupt row is still the row that poisons the read.
	if _, err := anListRepo(t, f, f.alice, f.project, repo); err == nil {
		t.Errorf("the smuggled action served after the failed update, want the read to fail")
	}
}
