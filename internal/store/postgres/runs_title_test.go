package postgres

// TestRunTitle*: ADR-0064 (docs/adr/ADR-0064-run-title-and-repository.md)
// against a real PostgreSQL — every title source is proven on the row, not
// on a mock: a direct start keeps `RunCreate.title`, a thread start takes the
// conversation's own title, an issue-trigger fire takes the fetched GitHub
// issue title (clamped to the 200-character column bound, never lost with the
// run), and a hand start that names an issue records the fire's own
// {kind: issue, ref: owner/repo#n} pair plus the assignment's repository and
// no trigger_id. An unnamed run stays honestly null — no backfill guesses.
// The projection, the project list and the cross-project page (ADR-0047) all
// serve title / repository_id / repository_name.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
)

// rtRepository inserts one repository of the fixture's project and returns
// its id (seeded the plain way the ADR-0060 tests use).
func rtRepository(t *testing.T, f *m4Fixture, name, gitURL string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING id::text`,
		f.projectID, name, gitURL, f.userID).Scan(&id); err != nil {
		t.Fatalf("insert repository %s: %v", name, err)
	}
	return id
}

// rtConversation inserts one thread (with its own agent profile) and returns
// its id.
func rtConversation(t *testing.T, f *m4Fixture, title string) string {
	t.Helper()
	ctx := testCtx(t)
	var profile string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO agent_profiles (organization_id, name, launcher_id)
		VALUES ($1::uuid, 'rt-profile-' || substr(md5(random()::text), 1, 8), 'codex')
		RETURNING id::text`, f.orgID).Scan(&profile); err != nil {
		t.Fatalf("insert agent profile: %v", err)
	}
	// The profile lives in the shared default org, outside the project the
	// fixture teardown unwinds: register it so that teardown deletes it too
	// (an uncleaned row breaks TestMigrate0003SeededProfiles on the next
	// -count iteration).
	f.rtProfileIDs = append(f.rtProfileIDs, profile)
	var id string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING id::text`,
		f.projectID, profile, title, f.userID).Scan(&id); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	return id
}

// rtRun creates one run through the API write adapter and returns the view.
func rtRun(t *testing.T, f *m4Fixture, in api.RunCreateInput) api.RunView {
	t.Helper()
	in.RequestSHA = m4Hex("body/" + in.Key)
	if in.TriggeredBy == "" {
		in.TriggeredBy = f.userID
	}
	view, created, err := m4RunsWriteStore(f).CreateRun(testCtx(t), m4RunsWriteCaller(f), in)
	if err != nil {
		t.Fatalf("CreateRun(%s): %v", in.Key, err)
	}
	if !created {
		t.Fatalf("CreateRun(%s): first creation reported created=false", in.Key)
	}
	return view
}

// TestRunTitleDirectStart is ADR-0064's base pair: a direct start with a
// title stores exactly it and projects it; a start without one stores NULL
// and projects null — nothing is invented from the pipeline's name.
func TestRunTitleDirectStart(t *testing.T) {
	f := m4Setup(t)

	named := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, PipelineRevisionID: f.revisionID,
		Key: "title-direct-named", Title: "Add saved cards to checkout",
	})
	if named.Title == nil || *named.Title != "Add saved cards to checkout" {
		t.Errorf("titled create projected Title = %v, want the given banner", named.Title)
	}
	unnamed := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, PipelineRevisionID: f.revisionID,
		Key: "title-direct-unnamed",
	})
	if unnamed.Title != nil {
		t.Errorf("untitled create projected Title = %q, want null — an unnamed run may not name itself", *unnamed.Title)
	}

	// The read paths re-answer the stored row, both ways.
	caller := m4RunsWriteCaller(f)
	store := m4RunsWriteStore(f)
	got, err := store.GetRun(testCtx(t), caller, named.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if got.Title == nil || *got.Title != "Add saved cards to checkout" {
		t.Errorf("GetRun Title = %v, want the stored banner", got.Title)
	}
	rows, err := store.ListProjectRuns(testCtx(t), caller, f.projectID)
	if err != nil {
		t.Fatalf("ListProjectRuns: %v", err)
	}
	titles := map[string]*string{}
	for _, row := range rows {
		titles[row.ID] = row.Title
	}
	if v := titles[named.ID]; v == nil || *v != "Add saved cards to checkout" {
		t.Errorf("list row Title = %v, want the stored banner", v)
	}
	if v, ok := titles[unnamed.ID]; !ok || v != nil {
		t.Errorf("list row of the unnamed run Title = %v, want null", v)
	}
}

// TestRunTitleFromThread proves the source arm: the thread's OWN
// conversation title is the run's banner — it outranks a body-supplied
// title, and the start stays a 'thread' trigger.
func TestRunTitleFromThread(t *testing.T) {
	f := m4Setup(t)
	conv := rtConversation(t, f, "Design the checkout cards step")

	view := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, PipelineRevisionID: f.revisionID,
		Key: "title-thread", Title: "outranked by the thread",
		Source: &api.RunSourceInput{ConversationID: conv},
	})
	if view.Title == nil || *view.Title != "Design the checkout cards step" {
		t.Errorf("thread run Title = %v, want the conversation's own title", view.Title)
	}
	if view.Trigger == nil || view.Trigger.Kind != "thread" {
		t.Errorf("thread run trigger = %+v, want kind thread — a title does not change how the run started", view.Trigger)
	}
}

// TestRunTitleHandIssueStart proves the `RunCreate.issue` arm at the store:
// the run records the fire's own pair {kind: issue, ref: owner/repo#<n>}
// (ADR-0056 grammar) with the caller's title and the assignment's
// repository, and NO trigger_id — no issue_triggers row fired this.
func TestRunTitleHandIssueStart(t *testing.T) {
	f := m4Setup(t)
	repoID := rtRepository(t, f, "web", "https://github.com/acme/web.git")
	as, err := f.pipelines.CreateAssignment(testCtx(t), NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 1,
		CreatedBy: f.userID, RepositoryID: repoID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}

	view := rtRun(t, f, api.RunCreateInput{
		ProjectID:    f.projectID,
		AssignmentID: as.ID,
		Key:          "title-hand-issue",
		Title:        "Add saved cards to checkout",
		RepositoryID: repoID,
		Issue:        &api.RunIssueInput{Number: 42, Repository: "acme/web"},
	})
	if view.Trigger == nil || view.Trigger.Kind != "issue" {
		t.Fatalf("hand issue start trigger = %+v, want kind issue", view.Trigger)
	}
	if view.Trigger.Ref == nil || *view.Trigger.Ref != "acme/web#42" {
		t.Errorf("trigger.ref = %v, want acme/web#42 — the fire's grammar, not a new one", view.Trigger.Ref)
	}
	if view.Title == nil || *view.Title != "Add saved cards to checkout" {
		t.Errorf("Title = %v, want the caller's banner", view.Title)
	}
	if view.RepositoryID == nil || *view.RepositoryID != repoID {
		t.Errorf("repository_id = %v, want the assignment's repository %s", view.RepositoryID, repoID)
	}
	// The row itself, not just the projection: ADR-0062's author reads follow
	// trigger_id, so a hand start must not fake one.
	var triggerID string
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT COALESCE(trigger_id::text, '') FROM runs WHERE id = $1::uuid`,
		view.ID).Scan(&triggerID); err != nil {
		t.Fatalf("read trigger_id: %v", err)
	}
	if triggerID != "" {
		t.Errorf("runs.trigger_id = %s, want NULL — no issue_triggers row fired this run", triggerID)
	}
}

// TestRunTitleIssueFireAndClamp drives the real issue-trigger fire (the
// itFixture's own poll path, fake GitHub and all): the fetched issue title is
// the run's banner, and a GitHub title over the 200-character column bound
// (GitHub allows 259) is stored truncated on the rune boundary — the run is
// never lost over the length of its banner.
func TestRunTitleIssueFireAndClamp(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{},
		json.RawMessage(`{"prompt":"Fix {{issue.number}}"}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	createdAt := trigger.CreatedAt

	long := "Rebuild the checkout flow so saved cards work on every device, locale and payment provider — " +
		strings.Repeat("and it goes ", 10) // over 200 runes, under GitHub's own 259 cap
	if n := len([]rune(long)); n <= maxRunTitleLen || n > 259 {
		t.Fatalf("fixture title is %d runes; the clamp arm needs one in (%d, 259]", n, maxRunTitleLen)
	}

	short := itWireIssue{Number: 7, Title: "Add saved cards to checkout", Body: "please", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/7",
		CreatedAt: createdAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: createdAt.Add(2 * time.Hour).Format(time.RFC3339)}
	tall := itWireIssue{Number: 9, Title: long, Body: "long", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/9",
		CreatedAt: createdAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: createdAt.Add(2 * time.Hour).Format(time.RFC3339)}
	lister := newITIssueLister([]itWireIssue{short, tall}, nil)
	defer lister.Close()

	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 2 {
		t.Fatalf("TickIssueTriggers = (%d, %v), want two fires", fired, err)
	}

	var title, repo string
	if err := f.pool.QueryRow(ctx, `
		SELECT title, repository_id::text FROM runs WHERE trigger_ref = 'octo/widgets#7'`).
		Scan(&title, &repo); err != nil {
		t.Fatalf("read the fired run for issue 7: %v", err)
	}
	if title != "Add saved cards to checkout" {
		t.Errorf("issue-fired run title = %q, want the fetched GitHub title verbatim", title)
	}
	if repo != f.repository {
		t.Errorf("issue-fired run repository_id = %s, want the trigger's repository %s", repo, f.repository)
	}

	var clamped string
	if err := f.pool.QueryRow(ctx, `
		SELECT title FROM runs WHERE trigger_ref = 'octo/widgets#9'`).Scan(&clamped); err != nil {
		t.Fatalf("read the fired run for the over-long title: %v", err)
	}
	if len([]rune(clamped)) != maxRunTitleLen {
		t.Errorf("clamped title is %d runes, want exactly %d", len([]rune(clamped)), maxRunTitleLen)
	}
	if !strings.HasPrefix(clamped, "Rebuild the checkout flow") {
		t.Errorf("clamped title lost its head: %q", clamped)
	}
}

// TestRunTitleCrossProjectRows proves the ADR-0047 page carries the ADR-0064
// fields: title, repository_id and the batch-resolved repository_name — and
// nulls all three for a row the server never named.
func TestRunTitleCrossProjectRows(t *testing.T) {
	f := m4Setup(t)
	ctx := testCtx(t)
	repoID := rtRepository(t, f, "web", "https://github.com/acme/web.git")
	as, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 1,
		CreatedBy: f.userID, RepositoryID: repoID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	named := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID, Key: "xp-named",
		Title: "Ship the cards banner", RepositoryID: repoID,
	})
	unnamed := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, PipelineRevisionID: f.revisionID, Key: "xp-unnamed",
	})

	xp := APICrossProjectStore{Pool: f.pool}
	views, next, err := xp.ListVisibleRuns(ctx, m4RunsWriteCaller(f), api.CrossProjectRunsFilter{Limit: 50})
	if err != nil {
		t.Fatalf("ListVisibleRuns: %v", err)
	}
	if next != "" {
		t.Errorf("next_cursor = %q on a one-page fixture", next)
	}
	byID := map[string]api.CrossProjectRunView{}
	for _, v := range views {
		byID[v.ID] = v
	}
	nv, ok := byID[named.ID]
	if !ok {
		t.Fatalf("named run %s missing from the page", named.ID)
	}
	if nv.Title == nil || *nv.Title != "Ship the cards banner" {
		t.Errorf("cross-project row Title = %v, want the stored banner", nv.Title)
	}
	if nv.RepositoryID == nil || *nv.RepositoryID != repoID {
		t.Fatalf("cross-project row repository_id = %v, want %s", nv.RepositoryID, repoID)
	}
	if nv.RepositoryName == nil || *nv.RepositoryName != "web" {
		t.Errorf("cross-project row repository_name = %v, want the batch-resolved name", nv.RepositoryName)
	}
	uv, ok := byID[unnamed.ID]
	if !ok {
		t.Fatalf("unnamed run %s missing from the page", unnamed.ID)
	}
	if uv.Title != nil || uv.RepositoryID != nil || uv.RepositoryName != nil {
		t.Errorf("unnamed cross-project row = title %v repo %v/%v, want all null",
			uv.Title, uv.RepositoryID, uv.RepositoryName)
	}
}

// TestRunTitleProjectionOnlyWhenNamed pins the projection rule that
// repository_name is null exactly when repository_id is (m4RunSummary is the
// single project both the list and the page share).
func TestRunTitleProjectionOnlyWhenNamed(t *testing.T) {
	f := m4Setup(t)
	ctx := testCtx(t)
	repoID := rtRepository(t, f, "atlas", "https://github.com/acme/atlas.git")
	as, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, MaxConcurrentRuns: 1,
		CreatedBy: f.userID, RepositoryID: repoID,
	})
	if err != nil {
		t.Fatalf("CreateAssignment: %v", err)
	}
	// The handler resolves the repo-scoped assignment's repository into the
	// store input before the create (ADR-0060's precedence); this is the
	// projection test, so the input arrives as the route 22 handler sends it.
	view := rtRun(t, f, api.RunCreateInput{
		ProjectID: f.projectID, AssignmentID: as.ID, Key: "proj-named-repo",
		RepositoryID: repoID,
	})
	if view.Title != nil {
		t.Errorf("untitled run Title = %q, want null", *view.Title)
	}
	// A repo-scoped assignment names the run's repository even when the run
	// itself carries no title (the ADR-0060 precedence, now readable).
	if view.RepositoryID == nil || *view.RepositoryID != repoID {
		t.Fatalf("repository_id = %v, want %s", view.RepositoryID, repoID)
	}
	rows, err := m4RunsWriteStore(f).ListProjectRuns(ctx, m4RunsWriteCaller(f), f.projectID)
	if err != nil {
		t.Fatalf("ListProjectRuns: %v", err)
	}
	for _, row := range rows {
		if row.ID != view.ID {
			continue
		}
		if row.RepositoryName == nil || *row.RepositoryName != "atlas" {
			t.Errorf("list row repository_name = %v, want atlas", row.RepositoryName)
		}
		if row.RepositoryID == nil && row.RepositoryName != nil {
			t.Error("repository_name served with a null repository_id — the pair is null together")
		}
	}
}
