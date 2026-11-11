package api

// The catch-up BRIEF (ADR-0081): the deterministic answer to "I was away; what
// do I need to know?".
//
// The recap it replaces asked a model to write two sentences out of tour
// TITLES, so most of what a returning engineer needs was never in the input
// (docs/research/2026-11-catch-up-audit.md § 5). ADR-0081's answer is Option C:
// the SERVER assembles the lists — they are facts it already holds — and the
// model is left the one thing a list cannot give, a headline that cites them.
// That split is why everything below is deterministic:
//
//   - every row comes from a membership-scoped store read issued AS THIS
//     CALLER, so a project they are not in contributes nothing, including to
//     `numbers` (ADR-0081 § Security/privacy). There is no 403 anywhere here:
//     naming a foreign project narrows the answer, it never widens it and it
//     never confirms the project exists;
//   - the model is not on this path at all. `headline` ships as
//     {"text":"","state":"unavailable"} and `by_project` as [] until the
//     generator task fills them, and the page renders the sections either way
//     — a fake narrative is worse than none (ADR-0078);
//   - the windows are the closed vocabulary `15m|1h|6h|24h|2d|7d|unseen`, and
//     the row cap FOLLOWS the window (5 / 8 / 10) with the remainder counted in
//     `omitted`, so a 7-day question costs more than a 15-minute one but never
//     costs the page unbounded rows.
//
// The signal rules behind `heads_up` are the SAME ones the tour's importance
// floor runs (assistant.catchUpImportanceSignals, ADR-0078 § Structure and
// importance), reached through one exported face rather than copied: two tables
// that decide "must know" differently would let the page and the tour disagree.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// The closed `heads_up.signal` vocabulary (ADR-0081 § Decision). A row outside
// it is a bug in this file, not a value the client has to survive.
const (
	CatchUpSignalMigration  = "migration"
	CatchUpSignalAuth       = "auth"
	CatchUpSignalDeps       = "deps"
	CatchUpSignalPushToMain = "push_to_main"
	CatchUpSignalSkipped    = "skipped_test"
	CatchUpSignalPublicAPI  = "public_api"
)

// The closed `needs_you.kind` and `changes.kind` vocabularies, likewise.
const (
	CatchUpNeedApproval  = "approval"
	CatchUpNeedQuestion  = "question"
	CatchUpNeedFailedRun = "failed_run"

	CatchUpShippedPR        = "pr"
	CatchUpShippedCommit    = "commit"
	CatchUpShippedRevision  = "workflow_revision"
	CatchUpChangePublished  = "workflow_published"
	CatchUpChangeProfileNew = "profile_created"
	CatchUpChangeProfileEd  = "profile_updated"
	CatchUpChangeMember     = "member_added"
)

// The headline states. This file only ever writes `unavailable`: the generator
// task owns the other two, and the page already has to render a brief whose
// model never answered (ADR-0081 § The model's job).
const (
	CatchUpHeadlineReady       = "ready"
	CatchUpHeadlinePending     = "pending"
	CatchUpHeadlineUnavailable = "unavailable"
)

// catchUpBriefUnseenFallback is how far back `unseen` reaches for a reader with
// no visit stamp at all — the widest window that exists, because "I have never
// been here" is not an invitation to hide six days of work behind a default.
const catchUpBriefUnseenFallback = 7 * 24 * time.Hour

// catchUpBriefWindowKeys is the allowed set in the order the message names it
// (shortest first, then `unseen`), so the 400 and the validation table cannot
// drift apart silently. It is asserted in the tests.
var catchUpBriefWindowKeys = []string{
	CatchUpWindowFifteenMin, CatchUpWindowOneHour, CatchUpWindowSixHour,
	CatchUpWindowDaily, CatchUpWindowTwoDay, CatchUpWindowWeekly,
	CatchUpWindowUnseen,
}

// --- the response (api/openapi.yaml: CatchUpBrief) --------------------

// CatchUpBriefWindow is the window the brief was assembled for. `since`/`until`
// are the interval every section was read against, so a reader can tell what a
// row's absence means: the window asked, the window answered.
type CatchUpBriefWindow struct {
	Key   string    `json:"key"`
	Since time.Time `json:"since"`
	Until time.Time `json:"until"`
}

// CatchUpBriefHeadline is the model's one sentence beside the lists.
// `state` is ready|pending|unavailable; an unavailable headline is an honest
// empty `text`, never a placeholder the page would read as news.
type CatchUpBriefHeadline struct {
	Text  string `json:"text"`
	State string `json:"state"`
}

// CatchUpBriefNeed is one thing that waits on this reader specifically:
// a gate they may decide, a question a beat asked and nobody answered, or one of
// THEIR runs whose pipeline has not succeeded since. Sorted oldest first — the
// longest-waiting item goes first, because it is the one that is blocking
// somebody else.
type CatchUpBriefNeed struct {
	Kind    string             `json:"kind"`
	Title   string             `json:"title"`
	Project CatchUpProjectChip `json:"project"`
	Link    string             `json:"link"`
	At      time.Time          `json:"at"`
	Detail  string             `json:"detail"`
}

// CatchUpBriefRunning is a run in flight as the brief was read. `step` is the
// newest RUNNING node instance, empty when nothing is executing this instant
// (queued, or between nodes) — the page draws that as "queued", never as a
// guessed step.
type CatchUpBriefRunning struct {
	RunID     string             `json:"run_id"`
	Title     string             `json:"title"`
	Project   CatchUpProjectChip `json:"project"`
	StartedAt time.Time          `json:"started_at"`
	Step      string             `json:"step"`
	Link      string             `json:"link"`
}

// CatchUpBriefShippedRef is the label a shipped row carries. These are the
// assistant's own claims harvested out of run outputs, NOT reconciled state
// (ADR-0078 § Decision 6): the UI says "opened" for a PR url and never "merged",
// because nothing here has spoken to GitHub.
type CatchUpBriefShippedRef struct {
	Number int    `json:"number,omitempty"`
	URL    string `json:"url,omitempty"`
	SHA    string `json:"sha,omitempty"`
}

// CatchUpBriefShipped is one piece of work the window produced: a pull request,
// a commit, or a workflow revision that went live.
type CatchUpBriefShipped struct {
	Kind    string                 `json:"kind"`
	Title   string                 `json:"title"`
	Project CatchUpProjectChip     `json:"project"`
	Ref     CatchUpBriefShippedRef `json:"ref"`
	By      string                 `json:"by"`
	At      time.Time              `json:"at"`
	Link    string                 `json:"link"`
}

// CatchUpBriefBroke is one pipeline that failed in the window, grouped per
// (project, pipeline) so five red runs of the same workflow read as one problem
// with a count. `still_failing` is the sentence the old recap could not say: the
// newest run of that pipeline is red. When it is false, `fixed_at` is when the
// first later run went green.
type CatchUpBriefBroke struct {
	Title        string             `json:"title"`
	Project      CatchUpProjectChip `json:"project"`
	Failures     int                `json:"failures"`
	ErrorClass   string             `json:"error_class"`
	StillFailing bool               `json:"still_failing"`
	FixedAt      *time.Time         `json:"fixed_at"`
	Link         string             `json:"link"`
}

// CatchUpBriefHeadsUp is one must-know signal on one piece of work: the same
// rules that raise a tour beat to must_know (auth paths, a migration, a new
// dependency, a push straight to main, skipped tests, the public API spec),
// applied to the window's runs. One row per (item, signal) — an auth change on a
// migration is two rows, because they are two reasons to look.
type CatchUpBriefHeadsUp struct {
	Signal  string             `json:"signal"`
	Title   string             `json:"title"`
	Project CatchUpProjectChip `json:"project"`
	Link    string             `json:"link"`
}

// CatchUpBriefChange is one change to the setup rather than to the code: a
// workflow published, an agent profile created or edited, a member added. Each
// carries its actor where the row records one (memberships do not).
type CatchUpBriefChange struct {
	Kind  string    `json:"kind"`
	Title string    `json:"title"`
	By    string    `json:"by"`
	At    time.Time `json:"at"`
	Link  string    `json:"link"`
}

// CatchUpBriefRunCounts and CatchUpBriefApprovalCounts are the numbers block:
// the arithmetic the old recap had no access to. Terminal statuses count runs
// that FINISHED in the window; `running` is a present-tense stock, the same set
// `running_now` lists.
type CatchUpBriefRunCounts struct {
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Cancelled int `json:"cancelled"`
	Running   int `json:"running"`
}

type CatchUpBriefApprovalCounts struct {
	Decided int `json:"decided"`
	Pending int `json:"pending"`
}

type CatchUpBriefNumbers struct {
	Runs          CatchUpBriefRunCounts      `json:"runs"`
	Approvals     CatchUpBriefApprovalCounts `json:"approvals"`
	ThreadsActive int                        `json:"threads_active"`
	PRs           int                        `json:"prs"`
	Commits       int                        `json:"commits"`
}

// CatchUpBriefProjectLine is the model's per-project line; it is produced only
// for a 24h-or-longer window with activity in two or more projects, and this
// file always serves an empty list (the generator task fills it).
type CatchUpBriefProjectLine struct {
	Project CatchUpProjectChip `json:"project"`
	Line    string             `json:"line"`
}

// CatchUpBrief is GET /catch-up/brief. Every section is an array — never null,
// because the page renders "nothing happened" and "no such field" differently —
// and `omitted` counts the rows the window's cap did not show, so "and N more"
// is the server's number rather than a client's guess about a list it cannot
// see the end of.
type CatchUpBrief struct {
	Window     CatchUpBriefWindow        `json:"window"`
	Headline   CatchUpBriefHeadline      `json:"headline"`
	NeedsYou   []CatchUpBriefNeed        `json:"needs_you"`
	RunningNow []CatchUpBriefRunning     `json:"running_now"`
	Shipped    []CatchUpBriefShipped     `json:"shipped"`
	Broke      []CatchUpBriefBroke       `json:"broke"`
	HeadsUp    []CatchUpBriefHeadsUp     `json:"heads_up"`
	Changes    []CatchUpBriefChange      `json:"changes"`
	Numbers    CatchUpBriefNumbers       `json:"numbers"`
	ByProject  []CatchUpBriefProjectLine `json:"by_project"`
	Omitted    map[string]int            `json:"omitted"`
}

// newCatchUpBrief is the empty brief: the shape the client may index into
// unconditionally before any read has succeeded.
func newCatchUpBrief() CatchUpBrief {
	return CatchUpBrief{
		Headline:   CatchUpBriefHeadline{State: CatchUpHeadlineUnavailable},
		NeedsYou:   []CatchUpBriefNeed{},
		RunningNow: []CatchUpBriefRunning{},
		Shipped:    []CatchUpBriefShipped{},
		Broke:      []CatchUpBriefBroke{},
		HeadsUp:    []CatchUpBriefHeadsUp{},
		Changes:    []CatchUpBriefChange{},
		ByProject:  []CatchUpBriefProjectLine{},
		Omitted:    map[string]int{},
	}
}

// --- the store seam ---------------------------------------------------

// CatchUpBriefScope is one reader's question: the window they named and the
// projects they narrowed to. An empty ProjectIDs is "every project I belong to",
// never "everything" — the store intersects it with their own memberships.
type CatchUpBriefScope struct {
	Window   string
	Projects []string
}

// CatchUpBriefFilter is the scope with its interval resolved. The store reads
// take [Since, Until) so a brief assembled twice in one window says the same
// thing, and a row whose clock is exactly `Until` belongs to the next answer.
type CatchUpBriefFilter struct {
	ProjectIDs []string
	Since      time.Time
	Until      time.Time
}

// CatchUpBriefRunNode is one node execution of one in-window run, beside the
// run and project it happened under. `Outputs` is the raw output envelope: the
// refs a shipped row names are harvested from it by THIS package
// (catchUpHarvestOutputs — the generator's own reader), because a number that
// only ever came from a model is not a fact the server may repeat.
type CatchUpBriefRunNode struct {
	RunID       string
	Title       string
	Status      string
	By          string
	StartedAt   time.Time
	FinishedAt  time.Time
	Project     CatchUpProjectChip
	NodeKey     string
	NodeStatus  string
	ErrorClass  string
	FailedCause string
	Goal        string
	Outputs     []byte
}

// CatchUpBriefStore is the brief's read surface. Every method scopes itself to
// the caller's project memberships inside its own statement — the same rule the
// ADR-0078 reads follow — so the brief cannot see a project the caller cannot.
type CatchUpBriefStore interface {
	// CatchUpBriefLastVisit is the reader's newest catch-up visit (zero time
	// when there is none), which is where the `unseen` window starts.
	CatchUpBriefLastVisit(ctx context.Context, c Caller) (time.Time, error)
	// CatchUpBriefApprovals is the gates still PENDING that THIS caller may
	// decide (the designated-approver rule of ADR-0014/`approval.pending`),
	// opened inside the window, oldest first.
	CatchUpBriefApprovals(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefNeed, error)
	// CatchUpBriefQuestions is the tour beats that asked something and have no
	// reply yet, addressed to a reader of this caller's projects.
	CatchUpBriefQuestions(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefNeed, error)
	// CatchUpBriefStuckRuns is the caller's own failed runs whose pipeline has
	// no later success — the failure they may not know is still true.
	CatchUpBriefStuckRuns(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefNeed, error)
	// CatchUpBriefRunning is the work in flight (queued or running), newest
	// started first, each with the node instance executing right now.
	CatchUpBriefRunning(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefRunning, error)
	// CatchUpBriefBroke is the window's failed runs grouped per
	// (project, pipeline) with its count, newest error class, whether it is
	// STILL failing, and when a later run proved it fixed.
	CatchUpBriefBroke(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefBroke, error)
	// CatchUpBriefRunNodes is the window's runs with their node executions and
	// raw output envelopes: the shipped section and the heads-up signals are
	// both read out of it, newest finished first.
	CatchUpBriefRunNodes(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefRunNode, error)
	// CatchUpBriefRevisions is the pipeline revisions published in the window,
	// scoped to the projects that have the pipeline assigned.
	CatchUpBriefRevisions(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefShipped, error)
	// CatchUpBriefProfiles is the agent profiles created or edited in the
	// window, each with its actor.
	CatchUpBriefProfiles(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefChange, error)
	// CatchUpBriefMembers is who joined a project in the window.
	CatchUpBriefMembers(ctx context.Context, c Caller, f CatchUpBriefFilter) ([]CatchUpBriefChange, error)
	// CatchUpBriefCounts is the numbers block, minus prs/commits, which are
	// counted from the harvested refs so the number and the section cannot
	// disagree about what a PR is.
	CatchUpBriefCounts(ctx context.Context, c Caller, f CatchUpBriefFilter) (CatchUpBriefNumbers, error)
}

// --- the assembler ----------------------------------------------------

// AssembleCatchUpBrief answers one reader's question with the server's own
// facts. It issues one bounded read per section (plus the visit stamp for
// `unseen`), folds them into the ADR's shape, orders each section by the rule
// the ADR states for it, and cuts it to the window's cap while counting what it
// cut. No model is asked anything on this path.
func AssembleCatchUpBrief(ctx context.Context, store CatchUpBriefStore,
	c Caller, window CatchUpBriefScope, now time.Time) (CatchUpBrief, error) {
	if store == nil {
		return CatchUpBrief{}, errors.New("api: the catch-up brief has no store")
	}
	key := strings.TrimSpace(window.Window)
	if key == "" {
		key = CatchUpWindowUnseen
	}
	cut, known := catchUpRecapWindows[key]
	if !known {
		return CatchUpBrief{}, fmt.Errorf("%w: window must be one of %s",
			ErrCatchUpValidation, strings.Join(catchUpBriefWindowKeys, ", "))
	}
	until := now.UTC()
	since := until.Add(-cut)
	if key == CatchUpWindowUnseen {
		last, err := store.CatchUpBriefLastVisit(ctx, c)
		if err != nil {
			return CatchUpBrief{}, err
		}
		since = until.Add(-catchUpBriefUnseenFallback)
		if !last.IsZero() && last.Before(until) {
			since = last.UTC()
		}
	}
	f := CatchUpBriefFilter{ProjectIDs: window.Projects, Since: since, Until: until}

	brief := newCatchUpBrief()
	brief.Window = CatchUpBriefWindow{Key: key, Since: since, Until: until}
	limit := catchUpBriefLimit(key)

	needs, err := store.CatchUpBriefApprovals(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	qs, err := store.CatchUpBriefQuestions(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	needs = append(needs, qs...)
	stuck, err := store.CatchUpBriefStuckRuns(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	needs = append(needs, stuck...)
	// Oldest first: ADR-0081's reason is the reader's, not a sort key — the
	// thing that has waited longest is the thing somebody else is waiting on.
	sort.SliceStable(needs, func(i, j int) bool {
		if !needs[i].At.Equal(needs[j].At) {
			return needs[i].At.Before(needs[j].At)
		}
		return needs[i].Link < needs[j].Link
	})
	brief.NeedsYou = catchUpBriefCut(&brief, "needs_you", needs, limit)

	running, err := store.CatchUpBriefRunning(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	sort.SliceStable(running, func(i, j int) bool {
		if !running[i].StartedAt.Equal(running[j].StartedAt) {
			return running[i].StartedAt.After(running[j].StartedAt)
		}
		return running[i].RunID < running[j].RunID
	})
	brief.RunningNow = catchUpBriefCut(&brief, "running_now", running, limit)

	nodes, err := store.CatchUpBriefRunNodes(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	shipped, heads := harvestCatchUpBriefNodes(nodes)

	revisions, err := store.CatchUpBriefRevisions(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	shipped = append(shipped, revisions...)
	sort.SliceStable(shipped, func(i, j int) bool {
		if !shipped[i].At.Equal(shipped[j].At) {
			return shipped[i].At.After(shipped[j].At)
		}
		return shipped[i].Link < shipped[j].Link
	})
	brief.Shipped = catchUpBriefCut(&brief, "shipped", shipped, limit)
	brief.HeadsUp = catchUpBriefCut(&brief, "heads_up", heads, limit)

	broke, err := store.CatchUpBriefBroke(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	sort.SliceStable(broke, func(i, j int) bool {
		// A pipeline still red is the more urgent row at the same clock; the
		// order within the rest is newest-failure-first, which the store gives
		// and a stable sort keeps.
		if broke[i].StillFailing != broke[j].StillFailing {
			return broke[i].StillFailing
		}
		return false
	})
	brief.Broke = catchUpBriefCut(&brief, "broke", broke, limit)

	profiles, err := store.CatchUpBriefProfiles(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	members, err := store.CatchUpBriefMembers(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	changes := append(profiles, members...)
	// The published revisions are `changes` too — the same rows that shipped as
	// workflow_revision, because "it shipped" and "the setup changed" are two
	// different questions a returning reader asks about one event.
	for _, rev := range revisions {
		changes = append(changes, CatchUpBriefChange{
			Kind: CatchUpChangePublished, Title: rev.Title, By: rev.By, At: rev.At, Link: rev.Link,
		})
	}
	sort.SliceStable(changes, func(i, j int) bool {
		if !changes[i].At.Equal(changes[j].At) {
			return changes[i].At.After(changes[j].At)
		}
		return changes[i].Link < changes[j].Link
	})
	brief.Changes = catchUpBriefCut(&brief, "changes", changes, limit)

	numbers, err := store.CatchUpBriefCounts(ctx, c, f)
	if err != nil {
		return CatchUpBrief{}, err
	}
	brief.Numbers = numbers
	// The two counts the page can only learn from the refs themselves are taken
	// from the FULL harvest, not from the rows the cap left standing: "3 shown,
	// 11 more" still means fourteen.
	brief.Numbers.PRs = countCatchUpBriefPRs(shipped)
	brief.Numbers.Commits = countCatchUpBriefCommits(shipped)
	return brief, nil
}

// catchUpBriefLimit is the window's row cap: ADR-0081's table, stated as a
// lookup so the caps cannot vary by section by accident.
func catchUpBriefLimit(window string) int {
	switch window {
	case CatchUpWindowFifteenMin, CatchUpWindowOneHour:
		return 5
	case CatchUpWindowSixHour, CatchUpWindowDaily:
		return 8
	default: // 2d, 7d and unseen: the widest answer the surface will give.
		return 10
	}
}

// catchUpBriefCut is the cap and its receipt: the rows beyond it are counted in
// `omitted` under the section's own name, which is what lets the page say "and
// N more" about a list it never received.
func catchUpBriefCut[T any](brief *CatchUpBrief, section string, rows []T, limit int) []T {
	if rows == nil {
		return []T{}
	}
	if len(rows) > limit {
		if brief.Omitted == nil {
			brief.Omitted = map[string]int{}
		}
		brief.Omitted[section] = len(rows) - limit
		return rows[:limit]
	}
	return rows
}

// harvestCatchUpBriefNodes folds each in-window run's node rows into the two
// sections that read the same envelope: the shipped refs (through the
// generator's own harvest, so a ref here is the same ref the tour would cite)
// and the must-know signals over the run's facts text. Runs are already newest
// first, and both sections keep that order.
func harvestCatchUpBriefNodes(nodes []CatchUpBriefRunNode) ([]CatchUpBriefShipped,
	[]CatchUpBriefHeadsUp) {
	shipped := []CatchUpBriefShipped{}
	heads := []CatchUpBriefHeadsUp{}

	byRun := map[string][]CatchUpBriefRunNode{}
	order := []string{}
	for _, n := range nodes {
		if _, seen := byRun[n.RunID]; !seen {
			order = append(order, n.RunID)
		}
		byRun[n.RunID] = append(byRun[n.RunID], n)
	}
	for _, runID := range order {
		rs := byRun[runID]
		first := rs[0]
		facts := assistant.CatchUpRunFacts{
			RunID: runID, Title: first.Title, Goal: first.Goal, Status: first.Status,
			StartedBy: first.By,
		}
		seenSignal := map[string]bool{}
		for _, n := range rs {
			facts.Nodes = append(facts.Nodes, assistant.CatchUpNodeFact{
				Key: n.NodeKey, Status: n.NodeStatus, ErrorClass: n.ErrorClass, Error: n.FailedCause,
			})
			// The refs come from the output envelope alone: this is the one
			// path by which a number reaches the brief, and it is the same
			// harvest the tour's DATA block uses (catch_up_gen.go).
			catchUpHarvestOutputs(n.Outputs, &facts)
		}
		if facts.PRURL != "" || facts.PRNumber > 0 {
			ref := CatchUpBriefShippedRef{Number: facts.PRNumber, URL: facts.PRURL}
			shipped = append(shipped, CatchUpBriefShipped{
				Kind: CatchUpShippedPR, Title: catchUpBriefRunTitle(first), Project: first.Project,
				Ref: ref, By: first.By, At: first.FinishedAt.UTC(),
				Link: "/runs/" + runID,
			})
		}
		for _, sha := range facts.Commits {
			shipped = append(shipped, CatchUpBriefShipped{
				Kind: CatchUpShippedCommit, Title: catchUpBriefRunTitle(first), Project: first.Project,
				Ref: CatchUpBriefShippedRef{SHA: sha}, By: first.By, At: first.FinishedAt.UTC(),
				Link: "/runs/" + runID,
			})
		}
		for _, signal := range assistant.CatchUpHeadUpSignals(facts) {
			if seenSignal[signal] {
				continue // one row per (item, signal) — ADR-0081
			}
			seenSignal[signal] = true
			heads = append(heads, CatchUpBriefHeadsUp{
				Signal: signal, Title: catchUpBriefRunTitle(first),
				Project: first.Project, Link: "/runs/" + runID,
			})
		}
	}
	return shipped, heads
}

// countCatchUpBriefShipped is the numbers block's PR and commit count: the
// distinct refs harvested from the window's own runs, NOT the rows the cap left
// on the page — a reader who sees "3 shown, 11 more" still gets eleven as the
// count. Deduplicated by the same identity the row carries (a url, a number, a
// sha) so two runs of one issue-to-pr workflow do not count the PR twice.
func countCatchUpBriefPRs(shipped []CatchUpBriefShipped) int {
	seen := map[string]bool{}
	var n int
	for _, s := range shipped {
		if s.Kind != CatchUpShippedPR {
			continue
		}
		id := s.Ref.URL
		if id == "" {
			id = fmt.Sprintf("#%d/%s", s.Ref.Number, s.Project.ID)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		n++
	}
	return n
}

func countCatchUpBriefCommits(shipped []CatchUpBriefShipped) int {
	seen := map[string]bool{}
	var n int
	for _, s := range shipped {
		if s.Kind != CatchUpShippedCommit {
			continue
		}
		sha := strings.ToLower(s.Ref.SHA)
		if sha == "" || seen[sha] {
			continue
		}
		seen[sha] = true
		n++
	}
	return n
}

func catchUpBriefRunTitle(n CatchUpBriefRunNode) string {
	if strings.TrimSpace(n.Title) != "" {
		return n.Title
	}
	return n.NodeKey
}

// --- the route --------------------------------------------------------

// brief answers GET /api/v1/catch-up/brief. It is a pure read: no visit is
// stamped, no generation is scheduled, and no model is called — the sidebar and
// the page may ask it as often as they like, which is exactly why the recap's
// POST stays throttled while this GET is not.
func (h *catchUpHandlers) brief(w http.ResponseWriter, r *http.Request) {
	const action = "catchup.brief.read"
	c, ok := h.caller(w, r, action)
	if !ok {
		return
	}
	scope, ok := h.parseBriefScope(w, r)
	if !ok {
		return
	}
	store, ok := h.store.(CatchUpBriefStore)
	if !ok {
		// The deployment mounted catch-up without the brief reads. That is the
		// honest absence: a 501 naming the gap, never an empty brief a reader
		// would trust as "nothing happened while you were away".
		WriteProblem(w, http.StatusNotImplemented, "Not Implemented",
			"This deployment serves no catch-up brief store.")
		return
	}
	out, err := AssembleCatchUpBrief(r.Context(), store, c, scope, time.Now())
	if err != nil {
		if errors.Is(err, ErrCatchUpValidation) {
			WriteProblem(w, http.StatusUnprocessableEntity, "Validation Failed",
				catchUpSentinelDetail(err, ErrCatchUpValidation))
			return
		}
		h.fail(w, r, action, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, out)
}

// parseBriefScope reads `window` and `projects`. An unknown window is a 400
// listing the allowed keys (ADR-0081 § Windows): it is a request the surface
// has no meaning for at all, not a payload it could have validated field by
// field. An absent window is `unseen` — the page's own default question.
func (h *catchUpHandlers) parseBriefScope(w http.ResponseWriter, r *http.Request) (CatchUpBriefScope, bool) {
	var scope CatchUpBriefScope
	projects, ok := h.parseProjectIDs(w, r.URL.Query()["projects"], "projects")
	if !ok {
		return scope, false
	}
	scope.Projects = projects
	key := strings.TrimSpace(r.URL.Query().Get("window"))
	if key == "" {
		key = CatchUpWindowUnseen
	}
	if _, known := catchUpRecapWindows[key]; !known {
		WriteProblem(w, http.StatusBadRequest, "Invalid Window",
			"window must be one of "+strings.Join(catchUpBriefWindowKeys, ", ")+".")
		return scope, false
	}
	scope.Window = key
	return scope, true
}
