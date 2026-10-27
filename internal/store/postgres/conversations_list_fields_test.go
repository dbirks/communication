package postgres

// ADR-0065 (docs/adr/ADR-0065-conversation-list-repository-and-last-line.md):
// the three fields `ConversationSummary` gains — `repository_id`,
// `repository_name` and `last_agent_line` — proven against a real PostgreSQL:
// a repo-bound thread names its repository (the checkout-path-first one of
// its newest live-or-released workspace), an unbound or lost-workspace thread
// names none, a silent agent yields no line, and a long line is cut to one
// preview line of at most 160 runes, ellipsis included. Both list READS (the
// project-scoped one and ADR-0047's cross-project one) answer the same view,
// so both are asserted here.

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// clRepository inserts one project repository row and returns its id.
func clRepository(t *testing.T, f *cnvFixture, name string) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, $2, 'file://' || $2, 'main', $3::uuid) RETURNING id::text`,
		f.project, name, f.alice).into(t, &id)
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM repositories WHERE id = $1`, id); err != nil {
			f.t.Errorf("cleanup repository %s: %v", id, err)
		}
	})
	return id
}

// clWorkspace inserts one conversation-scoped workspace for `f.worker` in
// the given state and returns its id. The one-live-per-conversation index
// (workspaces_one_live_per_conversation_idx) means a thread gets exactly one
// PREPARING/READY/QUARANTINED workspace; `released`/`lost` history may
// follow. Cleanups run before the fixture's (registered after it), so
// workspace_repos goes first.
func clWorkspace(t *testing.T, f *cnvFixture, conversationID, state string) string {
	t.Helper()
	var ws string
	f.queryRow(t, `
		INSERT INTO workspaces (organization_id, project_id, scope_kind, conversation_id,
		                        worker_id, volume_id, root_path, state, ready_at)
		VALUES ($1::uuid, $2::uuid, 'conversation', $3::uuid, $4::uuid, $5, $6, $7,
		        CASE WHEN $7 IN ('ready','quarantined','released','lost') THEN now() END)
		RETURNING id::text`,
		f.orgID, f.project, conversationID, f.worker, rsVolume,
		"/tmp/cnv-list-"+migFixtureToken(t)+"/"+conversationID+"/"+state, state).into(t, &ws)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM workspace_repos WHERE workspace_id = $1`, ws); err != nil {
			f.t.Errorf("cleanup workspace_repos of %s: %v", ws, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workspaces WHERE id = $1`, ws); err != nil {
			f.t.Errorf("cleanup workspace %s: %v", ws, err)
		}
	})
	return ws
}

// clWorkspaceRepo binds a repository to a workspace under checkout_path, the
// shape the worker writes at prepare (ADR-0017 D3).
func clWorkspaceRepo(t *testing.T, f *cnvFixture, workspaceID, repoID, checkoutPath string) {
	t.Helper()
	f.exec(t, `
		INSERT INTO workspace_repos (workspace_id, repository_id, mirror_volume_id,
		                             checkout_path, mirror_path, admin_dir, run_ref,
		                             base_commit)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
		workspaceID, repoID, rsVolume, checkoutPath,
		"/tmp/cnv-list-mirror.git", "/tmp/cnv-list-mirror.git/worktrees/x",
		"conversation/"+checkoutPath, strings.Repeat("0", 40))
}

// clAgentMessage journals one conversation.message.agent chunk, the shape
// the worker's turn sink appends (internal/worker/sink.go).
func clAgentMessage(t *testing.T, f *cnvFixture, conversationID, text string) {
	t.Helper()
	if _, err := f.append(t, events.New{
		Type: events.TypeConversationMessageAgent, OrganizationID: f.orgID,
		ProjectID: f.project, ConversationID: conversationID,
		Actor: events.Actor{Kind: events.ActorKindAgent, ID: "agent"},
		Payload: events.MessageAgentPayload{
			ConversationID: conversationID, TurnID: "00000000-0000-7000-8000-000000000099",
			ChunkSeq: 1, Text: text,
		},
	}); err != nil {
		t.Fatalf("append agent message: %v", err)
	}
}

func TestConversationListRepositoryAndLastLine(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	repoA := clRepository(t, f, "acme-api")
	repoB := clRepository(t, f, "zeta")

	// 1. Repo bound, agent spoke: TWO repositories on one live workspace —
	//    the checkout-path-first one wins, deterministically. The chunk
	//    opens with a blank line and padded text: the preview is the first
	//    NON-EMPTY line, trimmed; later lines are not the preview.
	bound := f.cnvCreate(t, f.alice, "Bound thread", "")
	boundWS := clWorkspace(t, f, bound.ID, "ready")
	clWorkspaceRepo(t, f, boundWS, repoB, "/srv/agent/work/repos/zeta")
	clWorkspaceRepo(t, f, boundWS, repoA, "/srv/agent/work/repos/acme-api")
	clAgentMessage(t, f, bound.ID, "\n   I pushed the fix. \nsecond line ignored")

	// 2. Released workspace, agent silent: the binding survives the release
	//    (ADR-0017 D1), and no line is invented for an agent that never
	//    spoke.
	released := f.cnvCreate(t, f.alice, "Released and silent", "")
	releasedWS := clWorkspace(t, f, released.ID, "released")
	clWorkspaceRepo(t, f, releasedWS, repoB, "/srv/agent/work/repos/zeta")

	// 3. Unbound but talking: no workspace, so no repository — the two
	//    fields are independent.
	unbound := f.cnvCreate(t, f.alice, "No workspace here", "")
	clAgentMessage(t, f, unbound.ID, "no repo, but the agent spoke")

	// 4. Lost workspace: the volume is gone, so its binding must not be
	//    shown (the run-from-thread head rule). This thread also carries
	//    the long, multi-byte first line pinning the truncation: at most
	//    160 RUNES, ellipsis included, cut on a rune boundary.
	lost := f.cnvCreate(t, f.alice, "Lost workspace, long line", "")
	lostWS := clWorkspace(t, f, lost.ID, "lost")
	clWorkspaceRepo(t, f, lostWS, repoA, "/srv/agent/work/repos/acme-api")
	longLine := strings.Repeat("héllo — ", 40) // 280 runes, more bytes
	clAgentMessage(t, f, lost.ID, longLine+"\nlater lines")
	wantTruncated := string([]rune(longLine)[:cnvLastAgentLineMax-1]) + "…"

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	byID := map[string]CnvSummary{}
	for _, item := range items {
		byID[item.ID] = item
	}
	if len(items) != 4 || len(byID) != 4 {
		t.Fatalf("list returned %d rows, want the four threads", len(items))
	}

	check := func(id, wantRepo, wantLine string) {
		t.Helper()
		cv, ok := byID[id]
		if !ok {
			t.Fatalf("conversation %s missing from the list", id)
		}
		if wantRepo == "" {
			if cv.RepositoryID != "" || cv.RepositoryName != "" {
				t.Errorf("row %s: repository = (%q, %q), want none", id, cv.RepositoryID, cv.RepositoryName)
			}
		} else {
			if cv.RepositoryName != wantRepo {
				t.Errorf("row %s: repository_name = %q, want %q", id, cv.RepositoryName, wantRepo)
			}
			if cv.RepositoryID == "" {
				t.Errorf("row %s: repository_id is empty beside name %q", id, cv.RepositoryName)
			}
		}
		if cv.LastAgentLine != wantLine {
			t.Errorf("row %s: last_agent_line = %q, want %q", id, cv.LastAgentLine, wantLine)
		}
	}
	check(bound.ID, "acme-api", "I pushed the fix.")
	check(released.ID, "zeta", "")
	check(unbound.ID, "", "no repo, but the agent spoke")
	check(lost.ID, "", wantTruncated)
	if n := utf8.RuneCountInString(byID[lost.ID].LastAgentLine); n != cnvLastAgentLineMax {
		t.Errorf("truncated line is %d runes, want exactly %d", n, cnvLastAgentLineMax)
	}

	// The cross-project list (ADR-0047, the Threads page's read) answers the
	// same three fields from the same SQL shape — one shared scan.
	xp := APICrossProjectStore{Pool: f.pool}
	views, next, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	if next != "" {
		t.Errorf("next cursor = %q, want one page", next)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	if len(views) != 4 {
		t.Fatalf("cross-project list returned %d rows, want the four threads", len(views))
	}
	checkView := func(id, wantRepo, wantLine string) {
		t.Helper()
		v, ok := byView[id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", id)
		}
		switch {
		case wantRepo == "" && v.RepositoryName != nil:
			t.Errorf("cross row %s: repository_name = %q, want null", id, *v.RepositoryName)
		case wantRepo != "" && (v.RepositoryName == nil || *v.RepositoryName != wantRepo):
			t.Errorf("cross row %s: repository_name = %v, want %q", id, v.RepositoryName, wantRepo)
		}
		if wantRepo != "" && v.RepositoryID == nil {
			t.Errorf("cross row %s: repository_id is null beside a name", id)
		}
		if wantLine == "" {
			if v.LastAgentLine != nil {
				t.Errorf("cross row %s: last_agent_line = %q, want null", id, *v.LastAgentLine)
			}
		} else if v.LastAgentLine == nil || *v.LastAgentLine != wantLine {
			t.Errorf("cross row %s: last_agent_line = %v, want %q", id, v.LastAgentLine, wantLine)
		}
	}
	checkView(bound.ID, "acme-api", "I pushed the fix.")
	checkView(released.ID, "zeta", "")
	checkView(unbound.ID, "", "no repo, but the agent spoke")
	checkView(lost.ID, "", wantTruncated)
}

// TestCnvLastAgentLine pins the renderer alone (no database): first non-empty
// line, trimmed, ≤ cnvLastAgentLineMax runes with the ellipsis counted inside
// the cap, cut on a rune boundary; "" = no line at all.
func TestCnvLastAgentLine(t *testing.T) {
	cases := []struct {
		name, chunk, want string
	}{
		{"empty", "", ""},
		{"whitespace only", "  \n\t\n", ""},
		{"skips blank leading lines", "\n\n real line \nmore", "real line"},
		{"trims the line", "  padded text \t", "padded text"},
		{"carriage returns", "line one\r\nline two", "line one"},
		{"exactly the cap", strings.Repeat("a", cnvLastAgentLineMax), strings.Repeat("a", cnvLastAgentLineMax)},
		{"one over the cap", strings.Repeat("a", cnvLastAgentLineMax+1),
			strings.Repeat("a", cnvLastAgentLineMax-1) + "…"},
		{"rune boundary", strings.Repeat("é", cnvLastAgentLineMax+1),
			strings.Repeat("é", cnvLastAgentLineMax-1) + "…"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cnvLastAgentLine(tc.chunk)
			if got != tc.want {
				t.Errorf("cnvLastAgentLine(%q) = %q, want %q", tc.chunk, got, tc.want)
			}
			if n := utf8.RuneCountInString(got); n > cnvLastAgentLineMax {
				t.Errorf("preview is %d runes, over the cap of %d", n, cnvLastAgentLineMax)
			}
		})
	}
}
