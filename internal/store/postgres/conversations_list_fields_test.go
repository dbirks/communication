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

// clRunThread links a conversation to a run of a repository the way the worker
// does (ADR-0053): one published revision, a run whose `repository_id` names
// `repoID`, one ready worker node execution, and a queued attempt stamped with
// the conversation and a turn of it (`attempts_agent_turn_pair` refuses half a
// pair). The thread itself gets NO workspace — that is the shape this proves: a
// run node's thread whose work lives in the RUN's workspace. It returns the run
// id; the cleanup goes in dependency order before the fixture's own delete.
func clRunThread(t *testing.T, f *cnvFixture, conversationID, repoID string) string {
	t.Helper()
	token := migFixtureToken(t) + "/" + conversationID
	var pipe, draft, rev, run string
	f.queryRow(t, `
		INSERT INTO pipelines (organization_id, slug, display_name, created_by)
		VALUES ($1::uuid, 'cl-pipe-' || replace($2, '/', '-'), 'List fixture', $3::uuid)
		RETURNING id::text`, f.orgID, token, f.alice).into(t, &pipe)
	f.queryRow(t, `
		INSERT INTO pipeline_drafts (pipeline_id, document_text, source_sha256, edited_by)
		VALUES ($1::uuid, 'kind: Pipeline', $2, $3::uuid) RETURNING id::text`,
		pipe, m4Hex("draft/"+token), f.alice).into(t, &draft)
	f.queryRow(t, `
		INSERT INTO pipeline_revisions (pipeline_id, draft_id, organization_id,
		                               revision_number, version_label, api_version,
		                               canonical_document, document_text, revision_digest,
		                               compiled_plan, plan_digest, schema_digest,
		                               cel_env_digest, published_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 1, '1.0.0', 'communication.dev/v1alpha1',
		        '{"kind":"Pipeline"}'::jsonb, 'kind: Pipeline', $4, '{"nodes":[]}'::jsonb,
		        $5, $6, $7, $8::uuid) RETURNING id::text`,
		pipe, draft, f.orgID, m4Digest("rev/"+token), m4Digest("plan/"+token),
		m4Digest("schema/"+token), m4Digest("cel/"+token), f.alice).into(t, &rev)
	f.queryRow(t, `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  repository_id, title)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
		        $7::uuid, 'Add saved cards to checkout') RETURNING id::text`,
		f.orgID, f.project, pipe, rev, m4Digest("rev/"+token), m4Digest("plan/"+token),
		repoID).into(t, &run)

	var node string
	f.queryRow(t, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, ready_at)
		VALUES ($1::uuid, 'implement', 'agent.acp', '/implement', 'worker', 'ready', now())
		RETURNING id::text`, run).into(t, &node)
	var turn string
	f.queryRow(t, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by,
		                                status, stop_reason, started_at, finished_at)
		VALUES ($1::uuid, 'implement the issue', $2::uuid, 'completed', 'end_turn',
		        now(), now()) RETURNING id::text`, conversationID, f.alice).into(t, &turn)
	f.exec(t, `
		INSERT INTO attempts (node_execution_id, run_id, attempt_number,
		                      conversation_id, turn_id)
		VALUES ($1::uuid, $2::uuid, 1, $3::uuid, $4::uuid)`, node, run, conversationID, turn)

	t.Cleanup(func() {
		bg := context.Background()
		steps := []struct {
			sql string
			arg string
		}{
			{`UPDATE conversation_turns SET node_attempt_id = NULL WHERE conversation_id = $1`, conversationID},
			{`DELETE FROM attempts WHERE run_id = $1`, run},
			{`DELETE FROM node_executions WHERE run_id = $1`, run},
			{`DELETE FROM runs WHERE id = $1`, run},
			{`DELETE FROM pipeline_revisions WHERE pipeline_id = $1`, pipe},
			{`DELETE FROM pipeline_drafts WHERE pipeline_id = $1`, pipe},
			{`DELETE FROM pipelines WHERE id = $1`, pipe},
		}
		for _, step := range steps {
			if _, err := f.pool.Exec(bg, step.sql, step.arg); err != nil {
				f.t.Errorf("cleanup run-thread %q: %v", step.sql, err)
			}
		}
	})
	return run
}

// TestConversationListRunThreadRepository is ADR-0065's run-thread arm on a
// real PostgreSQL: a thread a run node opened has no conversation-scoped
// workspace, so its repository comes from the linked run (runs.repository_id →
// repositories.name) and the row says `tally`, not nothing. A thread that DOES
// have a binding keeps it (the binding is the thread's own fact and wins), and
// a lost binding — the volume is gone — falls back to the run rather than
// going blank. The same renderer serves both list READS.
func TestConversationListRunThreadRepository(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	repoTally := clRepository(t, f, "tally")
	repoAcme := clRepository(t, f, "acme-api")

	// 1. Run thread, no binding of its own: the run's repository, and the
	//    agent's structured output read as its summary, not its braces.
	runOnly := f.cnvCreate(t, f.alice, "Run thread", "")
	clRunThread(t, f, runOnly.ID, repoTally)
	clAgentMessage(t, f, runOnly.ID,
		`{"summary": "The repo already had a full Node.js CLI; I extended it.", "changed": ["cmd/main.go"]}`)

	// 2. Thread bound AND run-linked: the thread's own binding wins — the
	//    fallback is a fallback, not an override.
	boundAndRun := f.cnvCreate(t, f.alice, "Bound and run-linked", "")
	boundWS := clWorkspace(t, f, boundAndRun.ID, "ready")
	clWorkspaceRepo(t, f, boundWS, repoAcme, "/srv/agent/work/repos/acme-api")
	clRunThread(t, f, boundAndRun.ID, repoTally)

	// 3. Lost binding, live run: the volume is gone, so the run's repository
	//    is what is true.
	lostAndRun := f.cnvCreate(t, f.alice, "Lost binding, run-linked", "")
	lostWS := clWorkspace(t, f, lostAndRun.ID, "lost")
	clWorkspaceRepo(t, f, lostWS, repoAcme, "/srv/agent/work/repos/acme-api")
	clRunThread(t, f, lostAndRun.ID, repoTally)

	// 4. Manual thread on a repository-less run: neither fact names one, so
	//    the row stays null — the fallback invents nothing.
	plain := f.cnvCreate(t, f.alice, "Plain thread", "")

	items, err := f.store.ListConversations(ctx, f.caller(f.bob), f.project, "", "")
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	byID := map[string]CnvSummary{}
	for _, item := range items {
		byID[item.ID] = item
	}
	if len(items) != 4 {
		t.Fatalf("list returned %d rows, want the four threads", len(items))
	}
	check := func(id, wantRepo string) {
		t.Helper()
		cv, ok := byID[id]
		if !ok {
			t.Fatalf("conversation %s missing from the list", id)
		}
		if wantRepo == "" {
			if cv.RepositoryID != "" || cv.RepositoryName != "" {
				t.Errorf("row %s: repository = (%q, %q), want none", id, cv.RepositoryID, cv.RepositoryName)
			}
			return
		}
		if cv.RepositoryName != wantRepo {
			t.Errorf("row %s: repository_name = %q, want %q", id, cv.RepositoryName, wantRepo)
		}
		if cv.RepositoryID == "" {
			t.Errorf("row %s: repository_id is empty beside name %q", id, cv.RepositoryName)
		}
	}
	check(runOnly.ID, "tally")
	check(boundAndRun.ID, "acme-api")
	check(lostAndRun.ID, "tally")
	check(plain.ID, "")

	// The fallback is exactly what ADR-0043 says the row is: a run thread.
	if byID[runOnly.ID].Origin != "run" || byID[runOnly.ID].RunLink == nil {
		t.Errorf("run row is origin %q with link %v, want run with its run_link",
			runOnly.ID, byID[runOnly.ID].Origin)
	}
	wantLine := "The repo already had a full Node.js CLI; I extended it."
	if byID[runOnly.ID].LastAgentLine != wantLine {
		t.Errorf("run row last_agent_line = %q, want %q", byID[runOnly.ID].LastAgentLine, wantLine)
	}

	// The cross-project read shares the SQL shape, so it answers the same
	// repository for the same rows (ADR-0047 + ADR-0065).
	xp := APICrossProjectStore{Pool: f.pool}
	views, _, err := xp.ListVisibleConversations(ctx,
		api.Caller{UserID: f.bob, OrganizationID: f.orgID}, 50, "")
	if err != nil {
		t.Fatalf("ListVisibleConversations: %v", err)
	}
	byView := map[string]api.ConversationSummaryView{}
	for _, v := range views {
		byView[v.ID] = v
	}
	for _, tc := range []struct {
		id, want string
	}{{runOnly.ID, "tally"}, {boundAndRun.ID, "acme-api"}, {lostAndRun.ID, "tally"}, {plain.ID, ""}} {
		v, ok := byView[tc.id]
		if !ok {
			t.Fatalf("cross-project list misses conversation %s", tc.id)
		}
		switch {
		case tc.want == "" && v.RepositoryName != nil:
			t.Errorf("cross row %s: repository_name = %q, want null", tc.id, *v.RepositoryName)
		case tc.want != "" && (v.RepositoryName == nil || *v.RepositoryName != tc.want):
			t.Errorf("cross row %s: repository_name = %v, want %q", tc.id, v.RepositoryName, tc.want)
		}
	}
}

// TestCnvLastAgentLine pins the renderer alone (no database): first non-empty
// line, trimmed, ≤ cnvLastAgentLineMax runes with the ellipsis counted inside
// the cap, cut on a rune boundary; "" = no line at all. The JSON arms are the
// run-node shape: an agent whose last message IS its structured output reads
// as its own summary, never as braces.
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
		// --- the structured-output shape (ADR-0065, run threads) ---------
		{"summary wins", `{"summary": "Pushed branch feat/cards.", "files": ["a.ts"]}`, "Pushed branch feat/cards."},
		{"summary beats goal", `{"goal": "the goal", "summary": "the summary"}`, "the summary"},
		{"goal when no summary", `{"goal": "Add saved cards to checkout", "changed": 2}`, "Add saved cards to checkout"},
		{"first string when neither", `{"count": 3, "notes": "two files touched", "other": "next"}`, "two files touched"},
		{"nested strings do not count", `{"result": {"summary": "nested"}, "notes": "outer"}`, "outer"},
		{"blank summary falls through", `{"summary": "   ", "goal": "real goal"}`, "real goal"},
		{"pretty-printed object", "{\n  \"summary\": \"Multi line object.\",\n  \"ok\": true\n}", "Multi line object."},
		{"summary keeps its own lines", `{"summary": "first line\nsecond line"}`, "first line"},
		{"no top-level string keeps the raw text", `{"count": 3, "ok": true}`, `{"count": 3, "ok": true}`},
		{"prose with a brace inside", `he said {yes} to the plan`, "he said {yes} to the plan"},
		{"fenced json is still prose", "```json\n{\"summary\": \"hidden\"}\n```", "```json"},
		{"json array is not an object", `["one", "two"]`, `["one", "two"]`},
		{"truncated chunk keeps the raw text", `{"summary": "cut off mid obj`, `{"summary": "cut off mid obj`},
		{"trailing prose after the object", `{"summary": "x"} done`, `{"summary": "x"} done`},
		{"leading blank lines around the object", "\n {\"goal\": \"padded\"} ", "padded"},
		{"empty object keeps the raw text", `{}`, `{}`},
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
