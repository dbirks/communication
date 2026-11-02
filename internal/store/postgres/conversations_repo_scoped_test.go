package postgres

// ADR-0067 (docs/adr/ADR-0067-repo-scoped-conversations.md): a conversation
// can be BORN bound to one repository of its project, and the project list
// filter says which threads are "in" a repository. Against a real PostgreSQL:
// a create naming a project repository binds it and the first prompt still
// rides turn 1 under the starter's control; the `repository` filter returns
// only that repo's threads (declared binding first, else the ADR-0065
// derivation — the workspace binding, else the linked run); a name the
// project does not have is ErrConversationRepositoryNotFound (404) on the
// filter and ErrConversationValidation (422) on the create body; a foreign
// project's repository is refused twice over (the create's 422 and the
// composite FK of migration 00022); and the declared binding outranks a
// later workspace's checkout.

import (
	"context"
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// crsCreate starts a conversation declared-bound to a repository NAME ("" =
// unbound) and registers a cleanup that removes the thread BEFORE the
// fixture's repositories can be deleted: conversations.repository_id is a
// composite FK (migration 00022), so a repository row is out-referenced by
// its bound threads and a cleanup in the other order fails on the FK.
// Cleanups run LIFO, and this one is registered after clRepository's, so it
// runs first.
func crsCreate(t *testing.T, f *cnvFixture, user, title, prompt, repository string) CnvConversation {
	t.Helper()
	chat, err := f.store.CreateConversation(testCtx(t), f.caller(user), f.project, f.profile, title, prompt, repository)
	if err != nil {
		t.Fatalf("CreateConversation(%q): %v", repository, err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []string{
			`DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE conversation_id = $1)`,
			`DELETE FROM permission_requests WHERE conversation_id = $1`,
			`DELETE FROM acp_session_bindings WHERE conversation_id = $1`,
			`DELETE FROM conversation_turns WHERE conversation_id = $1`,
			`DELETE FROM conversation_control WHERE conversation_id = $1`,
			`DELETE FROM domain_events WHERE conversation_id = $1`,
			`DELETE FROM conversations WHERE id = $1`,
		} {
			if _, err := f.pool.Exec(bg, q, chat.ID); err != nil {
				f.t.Errorf("cleanup conversation %s (%q): %v", chat.ID, q, err)
			}
		}
	})
	return chat
}

// crsForeignRepository inserts a second project of the same organization
// with one repository of the given name and returns the name. Nothing ever
// binds it from inside this fixture (the create path refuses it); the
// composite-FK probe unbinds before its cleanup runs.
func crsForeignRepository(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var other string
	f.queryRow(t, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'cnv-other-' || $2, 'Foreign fixture', $3::uuid) RETURNING id::text`,
		f.orgID, migFixtureToken(t), f.alice).into(t, &other)
	var repo string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		other, name, f.alice).into(t, &repo)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM conversations WHERE repository_id = $1::uuid`, repo); err != nil {
			f.t.Errorf("unbind conversations from foreign repository: %v", err)
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
				f.t.Errorf("cleanup foreign fixture (%q): %v", q, err)
			}
		}
	})
	return name
}

func crsRepositoryID(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var id string
	f.queryRow(t, `SELECT id::text FROM repositories WHERE project_id = $1::uuid AND name = $2`,
		f.project, name).into(t, &id)
	return id
}

// crsList runs the project list with the ADR-0043 + ADR-0067 filters.
func crsList(t *testing.T, f *cnvFixture, user, origin, query, repository string) []CnvSummary {
	t.Helper()
	items, err := f.store.ListConversations(testCtx(t), f.caller(user), f.project, origin, query, repository)
	if err != nil {
		t.Fatalf("ListConversations(origin=%q q=%q repository=%q): %v", origin, query, repository, err)
	}
	return items
}

func crsIDs(items []CnvSummary) map[string]bool {
	out := map[string]bool{}
	for _, it := range items {
		out[it.ID] = true
	}
	return out
}

func crsCount(t *testing.T, f *cnvFixture, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testCtx(t), q, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", q, err)
	}
	return n
}

func TestConversationCreateInRepositoryAndListFilter(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()
	clRepository(t, f, "acme-api")
	clRepository(t, f, "zeta")

	// 1. Declared binding, with the first message: born scoped to acme-api,
	//    prompt queued as turn 1 under the starter's control.
	boundA := crsCreate(t, f, f.alice, "Chat in storefront", "add a docstring", "acme-api")
	// 2. Declared binding by a different member, no prompt.
	boundB := crsCreate(t, f, f.bob, "zeta threads repo", "", "zeta")
	// 3. ADR-0065 derivation only: never declared, but its workspace checked
	//    out zeta — the filter reuses the same chain, so it counts as "in" zeta.
	derived := f.cnvCreate(t, f.alice, "Worked in zeta", "")
	derivedWS := clWorkspace(t, f, derived.ID, "ready")
	clWorkspaceRepo(t, f, derivedWS, crsRepositoryID(t, f, "zeta"), "/srv/agent/work/repos/zeta")
	// 4. Neither: unbound and workspace-less.
	unbound := f.cnvCreate(t, f.bob, "Project-wide chatter", "")

	if n := crsCount(t, f, `
		SELECT count(*) FROM conversations
		WHERE id = $1::uuid AND repository_id = $2::uuid`, boundA.ID, crsRepositoryID(t, f, "acme-api")); n != 1 {
		t.Errorf("create named a repository but conversations.repository_id is not it")
	}
	// The first message is turn 1 under the starter, exactly as an unbound
	// create leaves it: queued, submitted_by = the starter, and journalled.
	if n := crsCount(t, f, `
		SELECT count(*) FROM conversation_turns
		WHERE conversation_id = $1::uuid AND prompt = 'add a docstring'
		  AND submitted_by = $2::uuid AND status = 'queued'`, boundA.ID, f.alice); n != 1 {
		t.Errorf("turn-1 rows = %d, want the prompt queued under the starter", n)
	}
	if n := crsCount(t, f, `
		SELECT count(*) FROM domain_events
		WHERE conversation_id = $1::uuid AND type = 'conversation.message.user'`, boundA.ID); n != 1 {
		t.Errorf("conversation.message.user rows = %d, want the journal entry for the first prompt", n)
	}
	// The starter holds control at version 1 (the create path's own rule,
	// unchanged by the binding) — the same control row an unbound create
	// writes, which TestCreateConversation already pins on the route.
	// The filter returns only that repo's threads — the declared binding, and
	// for threads without one the ADR-0065 derivation.
	inA := crsIDs(crsList(t, f, f.bob, "", "", "acme-api"))
	if len(inA) != 1 || !inA[boundA.ID] {
		t.Errorf("filter acme-api = %v, want exactly the declared-bound thread", inA)
	}
	inZ := crsIDs(crsList(t, f, f.bob, "", "", "zeta"))
	if len(inZ) != 2 || !inZ[boundB.ID] || !inZ[derived.ID] {
		t.Errorf("filter zeta = %v, want the declared-bound and the workspace-derived threads", inZ)
	}
	all := crsList(t, f, f.bob, "", "", "")
	if len(all) != 4 {
		t.Fatalf("unfiltered list = %d rows, want all four threads", len(all))
	}
	for _, cv := range all {
		switch cv.ID {
		case boundA.ID:
			// The declared binding serves the list row BEFORE any workspace
			// or run exists — this is what the repo page navigates to right
			// after Start, and its feed row must already say where it lives.
			if cv.RepositoryName != "acme-api" || cv.RepositoryID == "" {
				t.Errorf("declared-bound row repository = (%q, %q), want acme-api", cv.RepositoryID, cv.RepositoryName)
			}
		case unbound.ID:
			if cv.RepositoryID != "" || cv.RepositoryName != "" {
				t.Errorf("unbound row repository = (%q, %q), want none", cv.RepositoryID, cv.RepositoryName)
			}
		}
	}

	// The filter composes with the ADR-0043 filters rather than replacing them.
	if got := crsIDs(crsList(t, f, f.bob, "run", "", "zeta")); len(got) != 0 {
		t.Errorf("filter zeta + origin=run = %v, want empty (neither zeta thread is run-opened)", got)
	}
	if got := crsIDs(crsList(t, f, f.bob, "", "storefront", "acme-api")); len(got) != 1 || !got[boundA.ID] {
		t.Errorf("title q + repository = %v, want the one matching thread", got)
	}

	// The cross-project read (ADR-0047) shares the SQL shape, so a declared
	// binding answers there too.
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	found := false
	for _, v := range views {
		if v.ID == boundA.ID {
			found = true
			if v.RepositoryName == nil || *v.RepositoryName != "acme-api" {
				t.Errorf("cross-project row repository = %v, want acme-api", v.RepositoryName)
			}
		}
	}
	if !found {
		t.Errorf("cross-project list misses the declared-bound conversation")
	}
}

// TestConversationRepositoryFilterUnknownAndForeign covers both refusals the
// brief names: a name the project does not have is the filter's 404 sentinel
// and the create body's 422 sentinel — including when the name exists in
// ANOTHER project, which must be the same answer, never a bind.
func TestConversationRepositoryFilterUnknownAndForeign(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()
	foreign := crsForeignRepository(t, f, "elsewhere")

	if _, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", "no-such-repo"); !errors.Is(err, ErrConversationRepositoryNotFound) {
		t.Errorf("list filter no-such-repo err = %v, want ErrConversationRepositoryNotFound", err)
	}
	if _, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "", foreign); !errors.Is(err, ErrConversationRepositoryNotFound) {
		t.Errorf("list filter on another project's repository = %v, want ErrConversationRepositoryNotFound", err)
	}

	if _, err := f.store.CreateConversation(ctx, f.caller(f.alice), f.project, f.profile,
		"x", "", "no-such-repo"); !errors.Is(err, ErrConversationValidation) {
		t.Errorf("create with an unknown repository err = %v, want ErrConversationValidation", err)
	}
	if _, err := f.store.CreateConversation(ctx, f.caller(f.alice), f.project, f.profile,
		"x", "", foreign); !errors.Is(err, ErrConversationValidation) {
		t.Errorf("create bound to another project's repository err = %v, want ErrConversationValidation", err)
	}

	// The composite FK (migration 00022) is the second gate: a writer that
	// skipped the store's resolution cannot bind a foreign repository.
	bound := crsCreate(t, f, f.alice, "fk probe", "", "")
	var foreignID string
	if err := f.pool.QueryRow(ctx, `
		SELECT r.id::text FROM repositories r
		JOIN projects p ON p.id = r.project_id
		WHERE r.name = $1 AND p.id <> $2::uuid`, foreign, f.project).Scan(&foreignID); err != nil {
		t.Fatalf("resolve foreign repository: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversations SET repository_id = $1::uuid WHERE id = $2::uuid`, foreignID, bound.ID); err == nil {
		t.Errorf("composite FK accepted a cross-project repository binding")
		_, _ = f.pool.Exec(ctx, `UPDATE conversations SET repository_id = NULL WHERE id = $1::uuid`, bound.ID)
	}
}

// TestConversationRepoScopedAuthz is the membership gate: a non-member gets
// the same 404 sentinel as anywhere else on this surface, filtered or not,
// and cannot create in the project at all — the repository filter and the
// repository binding are reads/writes of the project, not of the repository.
func TestConversationRepoScopedAuthz(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()
	clRepository(t, f, "acme-api")
	bound := crsCreate(t, f, f.alice, "Chat in storefront", "", "acme-api")

	if _, err := f.store.ListConversations(ctx, f.caller(f.outsider), f.project, "", "", "acme-api"); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("outsider list filter err = %v, want ErrConversationNotFound (404)", err)
	}
	if _, err := f.store.CreateConversation(ctx, f.caller(f.outsider), f.project, f.profile,
		"sneak in", "", "acme-api"); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("outsider create err = %v, want ErrConversationNotFound (404)", err)
	}
	// A non-member's probe must not have disturbed the creator's binding.
	if n := crsCount(t, f, `
		SELECT count(*) FROM conversations
		WHERE id = $1::uuid AND repository_id = $2::uuid`, bound.ID, crsRepositoryID(t, f, "acme-api")); n != 1 {
		t.Errorf("creator's own binding vanished or changed after an outsider's attempt")
	}
	// A viewer may read the filtered list but not create in the repo.
	if items, err := f.store.ListConversations(ctx, f.caller(f.carl), f.project, "", "", "acme-api"); err != nil || len(items) != 1 {
		t.Errorf("viewer filtered list = %d rows err %v, want the one bound thread", len(items), err)
	}
	if _, err := f.store.CreateConversation(ctx, f.caller(f.carl), f.project, f.profile,
		"viewer chat", "", "acme-api"); !errors.Is(err, ErrConversationForbidden) {
		t.Errorf("viewer create err = %v, want ErrConversationForbidden (403)", err)
	}
}

// TestConversationRepositoryBindingPrecedence pins the chain: a thread
// DECLARED for acme-api whose newest workspace checked out zeta still counts
// as "in" acme-api — the declared binding is "which repo was this opened
// FOR", which no later volume fact amends (ADR-0067), and it rides the same
// repository_name the run-thread arm already uses.
func TestConversationRepositoryBindingPrecedence(t *testing.T) {
	f := cnvSetup(t)
	clRepository(t, f, "acme-api")
	clRepository(t, f, "zeta")
	bound := crsCreate(t, f, f.alice, "Declared acme, worked zeta", "", "acme-api")
	ws := clWorkspace(t, f, bound.ID, "ready")
	clWorkspaceRepo(t, f, ws, crsRepositoryID(t, f, "zeta"), "/srv/agent/work/repos/zeta")

	if got := crsIDs(crsList(t, f, f.bob, "", "", "acme-api")); len(got) != 1 || !got[bound.ID] {
		t.Errorf("filter acme-api = %v, want the declared-bound thread despite its zeta workspace", got)
	}
	if got := crsIDs(crsList(t, f, f.bob, "", "", "zeta")); len(got) != 0 {
		t.Errorf("filter zeta = %v, want the declared binding to outrank the checkout", got)
	}
	for _, cv := range crsList(t, f, f.bob, "", "", "") {
		if cv.ID == bound.ID && cv.RepositoryName != "acme-api" {
			t.Errorf("row repository_name = %q, want the declared acme-api", cv.RepositoryName)
		}
	}
}
