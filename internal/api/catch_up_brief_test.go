package api

// ADR-0081's brief at the HTTP layer: the SHAPE the page indexes into blind
// (every key present, every section an array rather than a null), the CAP that
// follows the window with the remainder counted rather than hidden, the SORT the
// ADR states per section, the window vocabulary including the two new short
// windows and `unseen`, and the 400 an unknown window gets.
//
// The store's own scoping (a project you are not in contributes nothing, with a
// real ledger of runs and gates behind it) is proven against PostgreSQL in
// internal/store/postgres/catch_up_brief_test.go; the fake here exists to pin
// the contract its answers are turned into.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeBrief is a fakeCatchUp WITH the brief reads: the route reaches the brief
// surface through a type assertion on the store it was mounted with, so a test
// that wants the route must hand it a store that has them. Each field is the
// rows that read answers; each *Err is the failure it answers with.
type fakeBrief struct {
	*fakeCatchUp

	lastVisit time.Time
	approvals []CatchUpBriefNeed
	questions []CatchUpBriefNeed
	stuck     []CatchUpBriefNeed
	running   []CatchUpBriefRunning
	broke     []CatchUpBriefBroke
	nodes     []CatchUpBriefRunNode
	revisions []CatchUpBriefShipped
	profiles  []CatchUpBriefChange
	members   []CatchUpBriefChange
	counts    CatchUpBriefNumbers

	visitErr, approvalsErr, questionsErr, stuckErr, runningErr, brokeErr error
	nodesErr, revisionsErr, profilesErr, membersErr, countsErr           error

	gotScope  CatchUpBriefScope
	gotFilter CatchUpBriefFilter
	gotCalls  []string
}

func (f *fakeBrief) note(name string) { f.gotCalls = append(f.gotCalls, name) }

func (f *fakeBrief) CatchUpBriefLastVisit(context.Context, Caller) (time.Time, error) {
	f.note("visit")
	return f.lastVisit, f.visitErr
}

func (f *fakeBrief) CatchUpBriefApprovals(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefNeed, error) {
	f.note("approvals")
	f.gotScope.Projects, f.gotFilter = in.ProjectIDs, in
	return f.approvals, f.approvalsErr
}

func (f *fakeBrief) CatchUpBriefQuestions(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefNeed, error) {
	f.note("questions")
	f.gotFilter = in
	return f.questions, f.questionsErr
}

func (f *fakeBrief) CatchUpBriefStuckRuns(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefNeed, error) {
	f.note("stuck")
	f.gotFilter = in
	return f.stuck, f.stuckErr
}

func (f *fakeBrief) CatchUpBriefRunning(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefRunning, error) {
	f.note("running")
	f.gotFilter = in
	return f.running, f.runningErr
}

func (f *fakeBrief) CatchUpBriefBroke(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefBroke, error) {
	f.note("broke")
	f.gotFilter = in
	return f.broke, f.brokeErr
}

func (f *fakeBrief) CatchUpBriefRunNodes(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefRunNode, error) {
	f.note("nodes")
	f.gotFilter = in
	return f.nodes, f.nodesErr
}

func (f *fakeBrief) CatchUpBriefRevisions(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefShipped, error) {
	f.note("revisions")
	f.gotFilter = in
	return f.revisions, f.revisionsErr
}

func (f *fakeBrief) CatchUpBriefProfiles(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefChange, error) {
	f.note("profiles")
	f.gotFilter = in
	return f.profiles, f.profilesErr
}

func (f *fakeBrief) CatchUpBriefMembers(_ context.Context, _ Caller,
	in CatchUpBriefFilter) ([]CatchUpBriefChange, error) {
	f.note("members")
	f.gotFilter = in
	return f.members, f.membersErr
}

func (f *fakeBrief) CatchUpBriefCounts(_ context.Context, _ Caller,
	in CatchUpBriefFilter) (CatchUpBriefNumbers, error) {
	f.note("counts")
	f.gotFilter = in
	return f.counts, f.countsErr
}

var _ CatchUpBriefStore = (*fakeBrief)(nil)

// cuBriefServer mounts the whole catch-up surface over a store that also serves
// the brief reads.
func cuBriefServer(t *testing.T, store *fakeBrief) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterCatchUp(s, store, nil)
	return s
}

// cuBriefRows is N rows of one section, only their clocks differing — the
// shape/cap/sort tests are about order and arithmetic, not about prose.
func cuBriefRows(kind string, n int, step time.Duration, base time.Time) []CatchUpBriefNeed {
	out := make([]CatchUpBriefNeed, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, CatchUpBriefNeed{
			Kind: kind, Title: string(rune('a'+i)) + " waiting",
			Project: cuChip(), Link: "/approvals/" + string(rune('a'+i)),
			At: base.Add(time.Duration(i) * step),
		})
	}
	return out
}

func TestCatchUpBriefShapeIsTheContract(t *testing.T) {
	t.Parallel()
	store := &fakeBrief{}
	rec := cuGet(t, cuBriefServer(t, store), cuBase+"/api/v1/catch-up/brief?window=24h")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store", cc)
	}
	body := decodeBody(t, rec)
	for _, key := range []string{"window", "headline", "needs_you", "running_now", "shipped",
		"broke", "heads_up", "changes", "numbers", "by_project", "omitted"} {
		if _, ok := body[key]; !ok {
			t.Errorf("response is missing %q: %s", key, rec.Body)
		}
	}
	// The arrays are arrays even when nothing is in them: the page must not
	// distinguish "empty section" from "section this server does not have".
	for _, key := range []string{"needs_you", "running_now", "shipped", "broke",
		"heads_up", "changes", "by_project"} {
		if _, ok := body[key].([]any); !ok {
			t.Errorf("%s = %v, want an array (never null)", key, body[key])
		}
	}
	if _, ok := body["omitted"].(map[string]any); !ok {
		t.Errorf("omitted = %v, want an object", body["omitted"])
	}
	win, _ := body["window"].(map[string]any)
	for _, key := range []string{"key", "since", "until"} {
		if win[key] == nil {
			t.Errorf("window is missing %q: %v", key, win)
		}
	}
	nums, _ := body["numbers"].(map[string]any)
	runs, _ := nums["runs"].(map[string]any)
	for _, key := range []string{"succeeded", "failed", "cancelled", "running"} {
		if runs[key] == nil {
			t.Errorf("numbers.runs is missing %q: %v", key, runs)
		}
	}
	apps, _ := nums["approvals"].(map[string]any)
	for _, key := range []string{"decided", "pending"} {
		if apps[key] == nil {
			t.Errorf("numbers.approvals is missing %q: %v", key, apps)
		}
	}
	for _, key := range []string{"threads_active", "prs", "commits"} {
		if nums[key] == nil {
			t.Errorf("numbers is missing %q: %v", key, nums)
		}
	}
}

// TestCatchUpBriefHeadlineIsTheHonestPlaceholder pins what this task does NOT do:
// no model is called, so the headline arrives empty with the state that says so,
// and `by_project` arrives as an empty list. An empty `text` with state `ready`
// would be the page telling the reader there was nothing to read.
func TestCatchUpBriefHeadlineIsTheHonestPlaceholder(t *testing.T) {
	t.Parallel()
	rec := cuGet(t, cuBriefServer(t, &fakeBrief{}), cuBase+"/api/v1/catch-up/brief?window=7d")
	body := decodeBody(t, rec)
	head, _ := body["headline"].(map[string]any)
	if head["text"] != "" || head["state"] != "unavailable" {
		t.Errorf("headline = %v, want {\"text\":\"\",\"state\":\"unavailable\"}", head)
	}
	if by, ok := body["by_project"].([]any); !ok || len(by) != 0 {
		t.Errorf("by_project = %v, want an empty array", body["by_project"])
	}
	if strings.Contains(rec.Body.String(), "\"state\":\"ready\"") {
		t.Error("a brief assembled without a model claims a ready headline")
	}
}

func TestCatchUpBriefWindowTable(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	for _, tc := range []struct {
		key    string
		since  time.Duration // how far back the window starts
		capRow int
	}{
		{"15m", 15 * time.Minute, 5},
		{"1h", time.Hour, 5},
		{"6h", 6 * time.Hour, 8},
		{"24h", 24 * time.Hour, 8},
		{"2d", 48 * time.Hour, 10},
		{"7d", 7 * 24 * time.Hour, 10},
	} {
		store := &fakeBrief{}
		brief, err := AssembleCatchUpBrief(context.Background(), store,
			Caller{UserID: testPrincipal().UserID}, CatchUpBriefScope{Window: tc.key}, now)
		if err != nil {
			t.Fatalf("%s: %v", tc.key, err)
		}
		if brief.Window.Key != tc.key {
			t.Errorf("%s: window key = %q", tc.key, brief.Window.Key)
		}
		want := now.Add(-tc.since)
		if d := brief.Window.Since.Sub(want); d > time.Second || d < -time.Second {
			t.Errorf("%s: since = %s, want %s", tc.key, brief.Window.Since, want)
		}
		if !brief.Window.Until.Equal(now.UTC()) {
			t.Errorf("%s: until = %s, want %s", tc.key, brief.Window.Until, now)
		}
		if got := catchUpBriefLimit(tc.key); got != tc.capRow {
			t.Errorf("%s: cap = %d, want %d", tc.key, got, tc.capRow)
		}
		// The interval the store was asked for is the one the response states:
		// a page cannot explain a missing row without trusting both.
		if !store.gotFilter.Since.Equal(brief.Window.Since) ||
			!store.gotFilter.Until.Equal(brief.Window.Until) {
			t.Errorf("%s: store filter = %+v, response window = %+v",
				tc.key, store.gotFilter, brief.Window)
		}
	}
}

// TestCatchUpBriefUnseenWindow is `unseen`'s two arms: the reader's own last
// visit when the store has one, and the widest window when it does not.
func TestCatchUpBriefUnseenWindow(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	last := now.Add(-3 * time.Hour)

	store := &fakeBrief{lastVisit: last}
	brief, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{Window: CatchUpWindowUnseen}, now)
	if err != nil {
		t.Fatalf("unseen: %v", err)
	}
	if !brief.Window.Since.Equal(last) {
		t.Errorf("since = %s, want the last visit %s", brief.Window.Since, last)
	}
	if !store.gotFilter.Since.Equal(last) {
		t.Errorf("store filter = %s, want the last visit", store.gotFilter.Since)
	}

	// A stamp AHEAD of this replica's clock is not a window: a skewed visit row
	// must not answer "nothing happened" by starting after now.
	store = &fakeBrief{lastVisit: now.Add(time.Hour)}
	brief, err = AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{Window: CatchUpWindowUnseen}, now)
	if err != nil {
		t.Fatalf("skewed unseen: %v", err)
	}
	if want := now.Add(-7 * 24 * time.Hour); !brief.Window.Since.Equal(want) {
		t.Errorf("since = %s, want the 7d fallback %s", brief.Window.Since, want)
	}

	store = &fakeBrief{}
	if _, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{}, now); err != nil {
		t.Fatalf("absent window: %v", err)
	}
	if store.gotCalls[0] != "visit" {
		t.Errorf("reads = %v, want the visit stamp first for the default window", store.gotCalls)
	}
}

// TestCatchUpBriefCapsAndOmitted: five/eight/ten rows per section by window, and
// the remainder COUNTED — "and N more" is the server's number or it is nothing.
func TestCatchUpBriefCapsAndOmitted(t *testing.T) {
	t.Parallel()
	base := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		key   string
		limit int
	}{
		{"15m", 5}, {"1h", 5}, {"6h", 8}, {"24h", 8}, {"2d", 10}, {"7d", 10},
		{CatchUpWindowUnseen, 10},
	} {
		const rows = 12
		store := &fakeBrief{
			approvals: cuBriefRows(CatchUpNeedApproval, rows, time.Minute, base),
			running:   []CatchUpBriefRunning{},
			broke:     []CatchUpBriefBroke{},
			nodes:     []CatchUpBriefRunNode{},
		}
		for i := 0; i < rows; i++ {
			store.running = append(store.running, CatchUpBriefRunning{
				RunID: cuItemID, Title: "running", Project: cuChip(),
				StartedAt: base.Add(time.Duration(i) * time.Minute), Link: "/runs/" + cuItemID,
			})
			store.broke = append(store.broke, CatchUpBriefBroke{
				Title: "issue-to-pr", Project: cuChip(), Failures: i + 1, Link: "/runs/" + cuItemID,
			})
		}
		brief, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
			CatchUpBriefScope{Window: tc.key}, base.Add(24*time.Hour))
		if err != nil {
			t.Fatalf("%s: %v", tc.key, err)
		}
		for name, got := range map[string]int{
			"needs_you": len(brief.NeedsYou), "running_now": len(brief.RunningNow),
			"broke": len(brief.Broke),
		} {
			if got != tc.limit {
				t.Errorf("%s: %s = %d rows, want the cap %d", tc.key, name, got, tc.limit)
			}
			if brief.Omitted[name] != rows-tc.limit {
				t.Errorf("%s: omitted[%s] = %d, want %d",
					tc.key, name, brief.Omitted[name], rows-tc.limit)
			}
		}
		if _, ok := brief.Omitted["heads_up"]; ok {
			t.Errorf("%s: omitted names a section that cut nothing: %v", tc.key, brief.Omitted)
		}
	}
}

// TestCatchUpBriefSortOrders pins the ADR's rule per section: needs_you OLDEST
// first (the longest-waiting item is the one blocking somebody), the rest NEWEST
// first (a returning reader wants what just happened).
func TestCatchUpBriefSortOrders(t *testing.T) {
	t.Parallel()
	base := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	store := &fakeBrief{
		// Given newest-first on purpose: the assembler must reorder it.
		approvals: cuBriefRows(CatchUpNeedApproval, 3, time.Hour, base.Add(3*time.Hour)),
		questions: []CatchUpBriefNeed{{
			Kind: CatchUpNeedQuestion, Title: "Which branch?", Project: cuChip(),
			Link: "/catch-up/" + cuItemID, At: base.Add(90 * time.Minute),
		}},
		stuck: []CatchUpBriefNeed{{
			Kind: CatchUpNeedFailedRun, Title: "Oldest owed", Project: cuChip(),
			Link: "/runs/z", At: base,
		}},
		running: []CatchUpBriefRunning{
			{RunID: "old", StartedAt: base.Add(time.Hour), Link: "/runs/old"},
			{RunID: "new", StartedAt: base.Add(3 * time.Hour), Link: "/runs/new"},
		},
		nodes: []CatchUpBriefRunNode{
			{RunID: "late", Title: "later work", FinishedAt: base.Add(5 * time.Hour),
				Project: cuChip(), Outputs: json.RawMessage(`{"pr_number":12}`)},
			{RunID: "early", Title: "earlier work", FinishedAt: base.Add(time.Hour),
				Project: cuChip(), Outputs: json.RawMessage(`{"pr_number":9}`)},
		},
		revisions: []CatchUpBriefShipped{{
			Kind: CatchUpShippedRevision, Title: "issue-to-pr v2.0.0", Project: cuChip(),
			At: base.Add(2 * time.Hour), Link: "/workflows/" + cuOtherID,
		}},
		profiles: []CatchUpBriefChange{{
			Kind: CatchUpChangeProfileNew, Title: "Codex created", At: base,
			Link: "/profiles/p1",
		}},
		members: []CatchUpBriefChange{{
			Kind: CatchUpChangeMember, Title: "Bob joined Web", At: base.Add(4 * time.Hour),
			Link: "/p/x/members",
		}},
	}
	brief, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{Window: "24h"}, base.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	if len(brief.NeedsYou) != 5 {
		t.Fatalf("needs_you = %d rows, want all three reads merged", len(brief.NeedsYou))
	}
	for i := 1; i < len(brief.NeedsYou); i++ {
		if brief.NeedsYou[i-1].At.After(brief.NeedsYou[i].At) {
			t.Errorf("needs_you not oldest first: %v", brief.NeedsYou)
			break
		}
	}
	if brief.NeedsYou[0].Title != "Oldest owed" {
		t.Errorf("needs_you[0] = %q, want the run that failed at the oldest clock",
			brief.NeedsYou[0].Title)
	}
	if brief.RunningNow[0].RunID != "new" {
		t.Errorf("running_now[0] = %q, want the newest started", brief.RunningNow[0].RunID)
	}
	if brief.Shipped[0].Title != "later work" {
		t.Errorf("shipped[0] = %q, want the newest finished row first", brief.Shipped[0].Title)
	}
	if brief.Changes[0].Title != "Bob joined Web" {
		t.Errorf("changes[0] = %q, want the newest change first", brief.Changes[0].Title)
	}
	// A published revision is BOTH a shipped row and a change: "it went out" and
	// "the setup moved" are two questions about one event.
	var sawRevision bool
	for _, ch := range brief.Changes {
		if ch.Kind == CatchUpChangePublished {
			sawRevision = true
		}
	}
	if !sawRevision {
		t.Errorf("changes lost the published revision: %v", brief.Changes)
	}
}

// TestCatchUpBriefRefsComeFromTheOutputs is the shipped section's whole honesty
// argument: the numbers come from the run's own output envelope through the
// generator's harvest, never from prose, and the signals beside them are the
// tour's own floor rules.
func TestCatchUpBriefRefsComeFromTheOutputs(t *testing.T) {
	t.Parallel()
	at := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	store := &fakeBrief{
		nodes: []CatchUpBriefRunNode{{
			RunID: cuItemID, Title: "Ship the rate limiter", Status: "completed", By: "david",
			FinishedAt: at, Project: cuChip(),
			Goal:    "add migrations/00032_ratelimit.sql and a retry",
			NodeKey: "/implement", NodeStatus: "succeeded",
			Outputs: json.RawMessage(`{
				"branch": "comm/42-limiter",
				"pr_url": "https://github.com/acme/web/pull/42",
				"commit_sha": "abc1234567890abcdef1234567890abcdef12345",
				"commits": ["deadbeefcafe1234567890abcdef1234567890ab"]
			}`),
		}, {
			RunID: cuItemID, Title: "Ship the rate limiter", Status: "completed", By: "david",
			FinishedAt: at, Project: cuChip(), NodeKey: "/tests", NodeStatus: "succeeded",
			Outputs: json.RawMessage(`{"pr_number":42}`),
		}, {
			RunID: cuOtherID, Title: "Push straight to main", Status: "completed",
			FinishedAt: at.Add(-time.Hour), Project: cuChip(),
			NodeKey: "/push", NodeStatus: "succeeded",
			Outputs: json.RawMessage(`{"branch":"main","commit_sha":"1111111111111111111111111111111111111111"}`),
		}},
	}
	brief, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{Window: "6h"}, at.Add(time.Hour))
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	var prs, commits []CatchUpBriefShipped
	for _, s := range brief.Shipped {
		switch s.Kind {
		case CatchUpShippedPR:
			prs = append(prs, s)
		case CatchUpShippedCommit:
			commits = append(commits, s)
		}
	}
	// One PR row per RUN that named one (two nodes of one run naming the same PR
	// is still one row); that run's commits ride on the PR row, not rows of their
	// own. The other run named a commit and no PR, which is exactly what its row
	// must say.
	if len(prs) != 1 || len(commits) != 1 || prs[0].Ref.SHA == "" {
		t.Fatalf("shipped = %d rows, want one PR row carrying its commit and one commit row: %+v",
			len(brief.Shipped), brief.Shipped)
	}
	if prs[0].Ref.Number != 42 || prs[0].Ref.URL == "" {
		t.Errorf("pr ref = %+v, want number 42 with the url the run named", prs[0].Ref)
	}
	if brief.Numbers.PRs != 1 {
		t.Errorf("numbers.prs = %d, want the one pull request the window produced",
			brief.Numbers.PRs)
	}
	if brief.Numbers.Commits != 3 {
		t.Errorf("numbers.commits = %d, want the three shas counted", brief.Numbers.Commits)
	}
	signals := map[string]string{}
	for _, h := range brief.HeadsUp {
		signals[h.Signal] = h.Title
	}
	if signals[CatchUpSignalMigration] != "Ship the rate limiter" {
		t.Errorf("heads_up lost the migration signal: %+v", brief.HeadsUp)
	}
	if signals[CatchUpSignalPushToMain] != "Push straight to main" {
		t.Errorf("heads_up lost the push-to-main signal: %+v", brief.HeadsUp)
	}
	for _, h := range brief.HeadsUp {
		if !strings.HasPrefix(h.Link, "/runs/") {
			t.Errorf("heads_up row %q links to %q, want the run it names", h.Signal, h.Link)
		}
	}
}

// TestCatchUpBriefOmittedCountsBeyondTheCap: the numbers block is the window's
// arithmetic, not the page's — cutting a section to the cap must not shrink the
// count beside it.
func TestCatchUpBriefOmittedCountsBeyondTheCap(t *testing.T) {
	t.Parallel()
	at := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	var nodes []CatchUpBriefRunNode
	for i := 0; i < 12; i++ {
		nodes = append(nodes, CatchUpBriefRunNode{
			RunID: cuItemID + string(rune('a'+i)), Title: "work", Status: "completed",
			FinishedAt: at.Add(time.Duration(i) * time.Minute), Project: cuChip(),
			NodeKey: "/implement", Outputs: json.RawMessage(`{"pr_number":` + itoaTest(i+1) + `}`),
		})
	}
	store := &fakeBrief{nodes: nodes, counts: CatchUpBriefNumbers{Runs: CatchUpBriefRunCounts{
		Succeeded: 12,
	}}}
	brief, err := AssembleCatchUpBrief(context.Background(), store, Caller{},
		CatchUpBriefScope{Window: "1h"}, at.Add(time.Hour))
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	if len(brief.Shipped) != 5 {
		t.Errorf("shipped = %d rows, want the 1h cap of 5", len(brief.Shipped))
	}
	if brief.Omitted["shipped"] != 7 {
		t.Errorf("omitted[shipped] = %d, want 7", brief.Omitted["shipped"])
	}
	if brief.Numbers.PRs != 12 {
		t.Errorf("numbers.prs = %d, want all twelve the window produced", brief.Numbers.PRs)
	}
	if brief.Numbers.Runs.Succeeded != 12 {
		t.Errorf("numbers.runs.succeeded = %d, want the store's 12 untouched",
			brief.Numbers.Runs.Succeeded)
	}
}

func TestCatchUpBriefRouteWindows(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		query string
		want  string
	}{
		{"fifteen minutes", "?window=15m", "15m"},
		{"one hour", "?window=1h", "1h"},
		{"six hours", "?window=6h", "6h"},
		{"a day", "?window=24h", "24h"},
		{"two days", "?window=2d", "2d"},
		{"a week", "?window=7d", "7d"},
		{"unseen", "?window=unseen", "unseen"},
		{"absent is unseen", "", "unseen"},
	} {
		store := &fakeBrief{}
		rec := cuGet(t, cuBriefServer(t, store), cuBase+"/api/v1/catch-up/brief"+tc.query)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d (%s)", tc.name, rec.Code, rec.Body)
			continue
		}
		if got := decodeBody(t, rec)["window"].(map[string]any)["key"]; got != tc.want {
			t.Errorf("%s: window key = %v, want %s", tc.name, got, tc.want)
		}
	}
}

// TestCatchUpBriefUnknownWindowIsAFourHundred: ADR-0081 names the windows, and a
// request outside them is a client that has not read the list. The answer says
// what may be asked, in the body rather than only in the document.
func TestCatchUpBriefUnknownWindowIsAFourHundred(t *testing.T) {
	t.Parallel()
	store := &fakeBrief{}
	srv := cuBriefServer(t, store)
	for _, bad := range []string{"5m", "30m", "3d", "week", "yesterday", "24H"} {
		rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/brief?window="+bad)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("window=%s: status = %d, want 400 (%s)", bad, rec.Code, rec.Body)
			continue
		}
		p := decodeProblem(t, rec)
		for _, want := range []string{"15m", "1h", "6h", "24h", "2d", "7d", "unseen"} {
			if !strings.Contains(p.Detail, want) {
				t.Errorf("window=%s: detail %q omits the allowed key %q", bad, p.Detail, want)
			}
		}
	}
	if len(store.gotCalls) != 0 {
		t.Errorf("a refused window reached the store: %v", store.gotCalls)
	}
}

func TestCatchUpBriefProjectFilter(t *testing.T) {
	t.Parallel()
	store := &fakeBrief{}
	srv := cuBriefServer(t, store)

	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/brief?window=1h&projects="+cuProjectID+","+cuOtherID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	if len(store.gotScope.Projects) != 2 {
		t.Errorf("projects = %v, want both ids handed to the store", store.gotScope.Projects)
	}
	// Naming a project the caller is not in is NOT a 403 anywhere on this
	// surface: the store intersects it with membership and the answer is simply
	// the narrower one.
	for _, calls := range store.gotCalls {
		if calls == "" {
			t.Error("an empty read name reached the fake")
		}
	}

	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/brief?projects=not-a-uuid")
	if p := cuMustProblem(t, rec, http.StatusUnprocessableEntity); !strings.Contains(p.Detail,
		"projects") {
		t.Errorf("detail = %q, want it to name projects", p.Detail)
	}
}

func TestCatchUpBriefStoreFailureIsAFiveHundred(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		query string
		store *fakeBrief
	}{
		{"visit", "?window=unseen", &fakeBrief{visitErr: errors.New("pool down")}},
		{"approvals", "?window=6h", &fakeBrief{approvalsErr: errors.New("pool down")}},
		{"questions", "?window=6h", &fakeBrief{questionsErr: errors.New("pool down")}},
		{"stuck", "?window=6h", &fakeBrief{stuckErr: errors.New("pool down")}},
		{"running", "?window=6h", &fakeBrief{runningErr: errors.New("pool down")}},
		{"nodes", "?window=6h", &fakeBrief{nodesErr: errors.New("pool down")}},
		{"revisions", "?window=6h", &fakeBrief{revisionsErr: errors.New("pool down")}},
		{"broke", "?window=6h", &fakeBrief{brokeErr: errors.New("pool down")}},
		{"profiles", "?window=6h", &fakeBrief{profilesErr: errors.New("pool down")}},
		{"members", "?window=6h", &fakeBrief{membersErr: errors.New("pool down")}},
		{"counts", "?window=6h", &fakeBrief{countsErr: errors.New("pool down")}},
	} {
		rec := cuGet(t, cuBriefServer(t, tc.store), cuBase+"/api/v1/catch-up/brief"+tc.query)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s: status = %d, want 500 (%s)", tc.name, rec.Code, rec.Body)
		}
	}
}

// TestCatchUpBriefWithoutTheStoreIsHonestAboutAbsence: a deployment that mounted
// catch-up without the brief reads says so. An empty brief would be a lie — the
// reader cannot tell "nobody worked" from "this server cannot look".
func TestCatchUpBriefWithoutTheStoreIsHonestAboutAbsence(t *testing.T) {
	t.Parallel()
	srv := cuServer(t, &fakeCatchUp{}, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/brief?window=6h")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "catch-up brief") {
		t.Errorf("problem = %s, want it to name the missing store", rec.Body)
	}
}

// TestCatchUpBriefAssembleValidatesTheWindowItself: the assembler is also the
// chat tool's path (ADR-0081 § Chat tools), so it refuses a bad window rather
// than trusting that a handler already checked.
func TestCatchUpBriefAssembleValidatesTheWindowItself(t *testing.T) {
	t.Parallel()
	_, err := AssembleCatchUpBrief(context.Background(), &fakeBrief{}, Caller{},
		CatchUpBriefScope{Window: "fortnight"}, time.Now())
	if !errors.Is(err, ErrCatchUpValidation) {
		t.Fatalf("err = %v, want ErrCatchUpValidation", err)
	}
	for _, want := range []string{"15m", "unseen"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to list %q", err, want)
		}
	}
	if _, err := AssembleCatchUpBrief(context.Background(), nil, Caller{},
		CatchUpBriefScope{Window: "1h"}, time.Now()); err == nil {
		t.Error("a nil store assembled a brief instead of failing")
	}
}

func itoaTest(n int) string {
	raw, err := json.Marshal(n)
	if err != nil {
		panic(err)
	}
	return string(raw)
}
