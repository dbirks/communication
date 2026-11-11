package postgres

// The catch-up BRIEF (ADR-0081) over the SEEDED window histories: the per-window
// integration test of the question the brief exists to answer — "I was away; what
// do I need to know?" — against a realistic team's history rather than against
// hand-written section rows.
//
// The seeder (catch_up_seed_test.go) records what it wrote and computes
// cuSeeded.Expect from that record; catch_up_seed_scenarios_test.go proves the
// ROWS agree with it. This file asks what the assembled brief then does with them:
//
//   - the brief answers the window it was asked for (key, since, until) — every
//     other assertion is meaningless if the interval is wrong;
//   - every section's rows are seeded stories of the reader's own projects, and
//     every seeded story a section exists to tell came back from the store for
//     that interval. The store's answer is captured rather than read out of the
//     response, because a capped section may legitimately drop a title and
//     `omitted` carries only a number;
//   - the arithmetic is recomputed off the ledger the seeder wrote, the caps cut
//     where ADR-0081 says they cut, and a failed pipeline is either still red or
//     fixed at a moment — never both, never neither;
//   - the project the reader is NOT in contributes nothing to any section, number
//     or link, while the teammate who IS in it sees exactly the rows the reader
//     cannot — including the gate only a maintainer may open.
//
// Then the whole brief goes to testdata/catch_up_brief/<window>.golden.json with
// ids, colours, names and timestamps normalised, so that a change in what the page
// is handed has to be a change somebody read (`-update` rewrites it).
//
// Two places where cuExpect and the brief legitimately disagree are marked
// NEEDS_YOU_RULE and HEADS_UP_RULE: Expect is the TOUR's classification (a
// must_know beat, a pending approval somewhere in a visible project), while a
// brief section is the SERVER's answer (a signal its own records name, a gate THIS
// reader may decide). Both are asserted in both directions, not excused.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

// updateBriefGoldens rewrites the normalised goldens:
// `go test ./internal/store/postgres/ -run CatchUpBriefOverSeeded -update`.
var updateBriefGoldens = flag.Bool("update", false,
	"rewrite the normalised catch-up brief goldens in testdata/catch_up_brief")

// cuTestClock is the clock every brief here is assembled at: the fixed one the
// seeder is handed, so a golden's ages are the story's own ages.
var cuTestClock = cuClock()

// cuBriefWindow is the interval each window key answers, restated here rather than
// read from the assembler's table: every assertion below is about that interval,
// and if the two tables ever disagree this test is what says so.
var cuBriefWindow = map[string]time.Duration{
	api.CatchUpWindowFifteenMin: 15 * time.Minute,
	api.CatchUpWindowOneHour:    time.Hour,
	api.CatchUpWindowSixHour:    6 * time.Hour,
	api.CatchUpWindowDaily:      24 * time.Hour,
	api.CatchUpWindowTwoDay:     2 * 24 * time.Hour,
	api.CatchUpWindowWeekly:     7 * 24 * time.Hour,
}

func TestCatchUpBriefOverSeeded(t *testing.T) {
	for _, tc := range cuBriefCases() {
		tc := tc
		t.Run(tc.name(), func(t *testing.T) { cuBriefOverSeed(t, tc) })
	}
}

// cuBriefCase is one seeded history asked with one chip. The 3-day story is asked
// twice, because "since yesterday" and "since this time last week" are the same
// fixture answering different questions — and the wider chip over three days of
// history is exactly where an assembler that ignored `since` would show it.
type cuBriefCase struct {
	scenario cuScenario
	key      string
	// golden is the case whose brief is written out: one file per window, and the
	// 3-day story's own chip is the one its window name describes.
	golden bool
}

func cuBriefCases() []cuBriefCase {
	return []cuBriefCase{
		{cuWindow15m, api.CatchUpWindowFifteenMin, true},
		{cuWindow1h, api.CatchUpWindowOneHour, true},
		{cuWindow1d, api.CatchUpWindowDaily, true},
		{cuWindow3d, api.CatchUpWindowTwoDay, true},
		{cuWindow3d, api.CatchUpWindowWeekly, false},
		{cuWindow7d, api.CatchUpWindowWeekly, true},
	}
}

func (c cuBriefCase) name() string {
	if c.golden {
		return string(c.scenario)
	}
	return string(c.scenario) + "-wider-chip"
}

func (c cuBriefCase) window() time.Duration { return cuBriefWindow[c.key] }

func cuBriefOverSeed(t *testing.T, tc cuBriefCase) {
	t.Helper()
	now := cuTestClock
	win := tc.window()

	f := cnvSetup(t)
	seeded := cuSeed(t, f, tc.scenario, now)
	cuBriefAssign(t, f, seeded)

	pre := &cuBriefCapture{inner: APICatchUpStore{S: cuStore(f)}}
	reader := api.Caller{UserID: seeded.ReaderID, OrganizationID: f.orgID}
	brief, err := api.AssembleCatchUpBrief(testCtx(t), pre, reader,
		api.CatchUpBriefScope{Window: tc.key}, now)
	if err != nil {
		t.Fatalf("assemble the %s brief over the %s history: %v", tc.key, tc.scenario, err)
	}

	world := cuReadBriefWorld(t, f, seeded, now)
	story := cuReadStories(t, seeded)

	cuCheckShape(t, brief, tc.key, now)
	cuCheckChipColours(t, brief)
	cuCheckRunning(t, seeded, brief)
	cuCheckNeedsYou(t, seeded, story, world, win, brief, pre)
	cuCheckShipped(t, story, world, win, brief, pre)
	cuCheckBroke(t, seeded, world, win, brief)
	cuCheckBugStories(t, story, world, win, brief, pre)
	cuCheckHeadsUp(t, story, world, win, brief, pre)
	cuCheckChanges(t, world, story, win, brief, pre)
	cuCheckNumbers(t, seeded, world, tc.key, win, brief)
	cuCheckCaps(t, tc.key, brief, pre)
	cuCheckNoSecretOps(t, world, brief, pre)
	cuCheckTeammate(t, f, seeded, world, tc.key, win, brief)

	if tc.golden {
		cuBriefGolden(t, tc.scenario, brief, now, world)
	}
}

// --- the one row the seeder leaves out --------------------------------------

// cuBriefAssign gives each visible project the pipeline it already runs. The
// seeder inserts runs directly and never assigns; production has no such thing,
// and a pipeline_revisions row belongs to an ORGANIZATION rather than to a
// project, so the assignment is the only thing the revisions read can scope
// itself by (see catchUpBriefRevisionsSQL). Without it the seeded `changes`
// section is empty for a reason no reader ever sees.
func cuBriefAssign(t *testing.T, f *cnvFixture, s cuSeeded) {
	t.Helper()
	for _, name := range cuReaderProjects() {
		p, ok := s.world.pipelines[name]
		if !ok {
			t.Fatalf("the seeded %s world has no pipeline for %s", s.world.scenario, name)
		}
		// The world has one pipeline per project and inserts it once, so the
		// insert either lands or the world is not what this test thinks it is.
		// Assignments carry no unique (project, pipeline) constraint to lean on.
		if _, err := f.pool.Exec(testCtx(t), `
			INSERT INTO assignments (project_id, pipeline_id, pinned_revision_id, created_by)
			SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid
			WHERE NOT EXISTS (SELECT 1 FROM assignments
			                  WHERE project_id = $1::uuid AND pipeline_id = $2::uuid)`,
			s.Projects[name], p.id, p.revisionID, s.TeammateID); err != nil {
			t.Fatalf("assign %s the pipeline it runs: %v", name, err)
		}
		pipe := p.id
		t.Cleanup(func() {
			if _, err := f.pool.Exec(context.Background(),
				`DELETE FROM assignments WHERE pipeline_id = $1::uuid`, pipe); err != nil {
				t.Errorf("clean up the assignment of pipeline %s: %v", pipe, err)
			}
		})
	}
}

// --- the seeded rows, read back ---------------------------------------------

type cuBRun struct {
	id, project, pipeline, title, status, triggeredBy string
	createdAgo                                        float64
	finishedAgo                                       *float64
}

// clockAgo is the brief's own event clock for a run: when it ended if it ended,
// else when it was created — the store's COALESCE (finished_at, created_at).
func (r cuBRun) clockAgo() float64 {
	if r.finishedAgo != nil {
		return *r.finishedAgo
	}
	return r.createdAgo
}

type cuBNode struct {
	project, errorClass string
	ago                 float64
	failed              bool
}

type cuBApproval struct {
	project, summary, state, runTitle string
	ago                               float64
	decidedAgo                        *float64
	roles                             []string
}

type cuBItem struct {
	project, title, summary string
	ago                     float64
}

type cuBMember struct {
	project, name, role string
	ago                 float64
}

// cuBriefWorld is the seeded history as the rows hold it, every age measured from
// the clock the brief was assembled at. None of these reads shares a statement
// with the brief's own: these are the facts, not the answers.
type cuBriefWorld struct {
	visible map[string]bool
	// roles is what the reader may DO in each project, which is what makes a
	// pending gate theirs or somebody else's.
	roles     map[string]string
	runs      []cuBRun
	nodes     []cuBNode
	approvals []cuBApproval
	items     []cuBItem
	members   []cuBMember
	threads   []float64
	// names maps each display name the brief may print to what a reader would call
	// that person, because the fixture's usernames carry a per-run token.
	names map[string]string
	// secretNeedles is everything secret-ops is called and every id it owns.
	secretNeedles []string
}

func cuReadBriefWorld(t *testing.T, f *cnvFixture, s cuSeeded, now time.Time) cuBriefWorld {
	t.Helper()
	ctx := testCtx(t)
	all := append(s.visibleIDs(), s.secretID())
	w := cuBriefWorld{
		visible: map[string]bool{},
		roles:   map[string]string{},
		names:   map[string]string{},
	}
	for _, name := range cuReaderProjects() {
		w.visible[name] = true
	}

	rows, err := f.pool.Query(ctx, `
		SELECT p.name, r.id::text, r.pipeline_id::text, COALESCE (r.title, ''), r.status,
		       COALESCE (r.triggered_by::text, ''),
		       extract (epoch from ($2::timestamptz - r.created_at)),
		       extract (epoch from ($2::timestamptz - r.finished_at))
		FROM runs r JOIN projects p ON p.id = r.project_id
		WHERE r.project_id = ANY ($1::uuid[])
		ORDER BY p.name, r.created_at, r.id`, all, now)
	if err != nil {
		t.Fatalf("read the seeded runs: %v", err)
	}
	for rows.Next() {
		var r cuBRun
		if err := rows.Scan(&r.project, &r.id, &r.pipeline, &r.title, &r.status,
			&r.triggeredBy, &r.createdAgo, &r.finishedAgo); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded runs: %v", err)
		}
		w.runs = append(w.runs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded runs: %v", err)
	}

	rows, err = f.pool.Query(ctx, `
		SELECT p.name, COALESCE (ne.error_class, ''),
		       extract (epoch from ($2::timestamptz - COALESCE (ne.finished_at, ne.created_at))),
		       ne.status = 'failed'
		FROM node_executions ne
		JOIN runs r ON r.id = ne.run_id
		JOIN projects p ON p.id = r.project_id
		WHERE r.project_id = ANY ($1::uuid[])`, all, now)
	if err != nil {
		t.Fatalf("read the seeded nodes: %v", err)
	}
	for rows.Next() {
		var n cuBNode
		if err := rows.Scan(&n.project, &n.errorClass, &n.ago, &n.failed); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded nodes: %v", err)
		}
		w.nodes = append(w.nodes, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded nodes: %v", err)
	}

	rows, err = f.pool.Query(ctx, `
		SELECT p.name, a.summary, a.state, COALESCE (r.title, ''),
		       extract (epoch from ($2::timestamptz - a.created_at)),
		       extract (epoch from ($2::timestamptz - a.decided_at)), a.approver_roles
		FROM approval_requests a
		JOIN projects p ON p.id = a.project_id
		JOIN runs r ON r.id = a.run_id
		WHERE a.project_id = ANY ($1::uuid[])
		ORDER BY a.created_at, a.id`, all, now)
	if err != nil {
		t.Fatalf("read the seeded approvals: %v", err)
	}
	for rows.Next() {
		var a cuBApproval
		if err := rows.Scan(&a.project, &a.summary, &a.state, &a.runTitle, &a.ago,
			&a.decidedAgo, &a.roles); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded approvals: %v", err)
		}
		w.approvals = append(w.approvals, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded approvals: %v", err)
	}

	rows, err = f.pool.Query(ctx, `
		SELECT p.name, w.title, COALESCE (w.summary, ''),
		       extract (epoch from ($2::timestamptz - w.updated_at))
		FROM catchup_work_items w JOIN projects p ON p.id = w.project_id
		WHERE w.project_id = ANY ($1::uuid[])
		ORDER BY w.updated_at DESC, w.id DESC`, all, now)
	if err != nil {
		t.Fatalf("read the seeded work items: %v", err)
	}
	for rows.Next() {
		var it cuBItem
		if err := rows.Scan(&it.project, &it.title, &it.summary, &it.ago); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded work items: %v", err)
		}
		w.items = append(w.items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded work items: %v", err)
	}

	rows, err = f.pool.Query(ctx, `
		SELECT pj.name, u.display_name, m.role,
		       extract (epoch from ($2::timestamptz - m.created_at))
		FROM memberships m
		JOIN projects pj ON pj.id = m.project_id
		JOIN users u ON u.id = m.user_id
		WHERE m.project_id = ANY ($1::uuid[])`, all, now)
	if err != nil {
		t.Fatalf("read the seeded memberships: %v", err)
	}
	for rows.Next() {
		var m cuBMember
		if err := rows.Scan(&m.project, &m.name, &m.role, &m.ago); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded memberships: %v", err)
		}
		w.members = append(w.members, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded memberships: %v", err)
	}

	rows, err = f.pool.Query(ctx, `
		SELECT extract (epoch from ($2::timestamptz - c.updated_at))
		FROM conversations c JOIN projects p ON p.id = c.project_id
		WHERE p.id = ANY ($1::uuid[]) AND c.status <> 'archived'`, s.visibleIDs(), now)
	if err != nil {
		t.Fatalf("read the seeded threads: %v", err)
	}
	for rows.Next() {
		var age float64
		if err := rows.Scan(&age); err != nil {
			rows.Close()
			t.Fatalf("scan the seeded threads: %v", err)
		}
		w.threads = append(w.threads, age)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read the seeded threads: %v", err)
	}

	// The people the brief names by display name — and only the ones this world
	// has, so no other fixture's leftover username can be rewritten by accident.
	if reader := cuDisplayName(t, f, s.ReaderID); reader != "" {
		w.names[reader] = "the reader"
	}
	if teammate := cuDisplayName(t, f, s.TeammateID); teammate != "" {
		w.names[teammate] = "a teammate"
	}
	for _, m := range w.members {
		if m.name == "" {
			continue
		}
		if _, known := w.names[m.name]; known {
			continue // the reader and the teammate are members too
		}
		w.names[m.name] = "a new member"
	}
	for _, name := range cuReaderProjects() {
		w.roles[name] = cuRoleOf(t, f, s.ReaderID, s.Projects[name])
	}
	w.secretNeedles = cuSecretNeedles(t, f, s)
	return w
}

// cuDisplayName reads one person's display name.
func cuDisplayName(t *testing.T, f *cnvFixture, id string) string {
	t.Helper()
	var name string
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT display_name FROM users WHERE id = $1::uuid`, id).Scan(&name); err != nil {
		t.Fatalf("the display name of %s: %v", id, err)
	}
	return name
}

// cuRoleOf is the reader's role in one project — the half of the needs_you rule
// that decides whether a pending gate is theirs to open.
func cuRoleOf(t *testing.T, f *cnvFixture, user, project string) string {
	t.Helper()
	var role string
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT role FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`,
		project, user).Scan(&role); err != nil {
		t.Fatalf("the reader's role in %s: %v", project, err)
	}
	return role
}

// cuSecretNeedles is every name and id secret-ops holds. A brief that leaks a
// project can do it through a link as easily as through a title, so the scan
// looks for the run ids and the failure causes too, not only the story titles.
func cuSecretNeedles(t *testing.T, f *cnvFixture, s cuSeeded) []string {
	t.Helper()
	ctx := testCtx(t)
	out := []string{"secret-ops", s.secretID()}
	if p, ok := s.world.pipelines[cuSecretOps]; ok {
		out = append(out, p.id, p.displayName, p.revisionID)
	}
	for _, q := range []string{
		`SELECT title, summary FROM catchup_work_items WHERE project_id = $1::uuid`,
		`SELECT COALESCE (title, ''), id::text FROM runs WHERE project_id = $1::uuid`,
		`SELECT COALESCE (failed_cause, ''), id::text FROM runs WHERE project_id = $1::uuid`,
		`SELECT summary, id::text FROM approval_requests WHERE project_id = $1::uuid`,
		`SELECT name, git_url FROM repositories WHERE project_id = $1::uuid`,
		`SELECT title, id::text FROM conversations WHERE project_id = $1::uuid`,
	} {
		rows, err := f.pool.Query(ctx, q, s.secretID())
		if err != nil {
			t.Fatalf("read secret-ops (%q): %v", q, err)
		}
		for rows.Next() {
			var a, b string
			if err := rows.Scan(&a, &b); err != nil {
				rows.Close()
				t.Fatalf("scan secret-ops (%q): %v", q, err)
			}
			for _, v := range []string{a, b} {
				if strings.TrimSpace(v) != "" {
					out = append(out, v)
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("read secret-ops (%q): %v", q, err)
		}
	}
	return cuUniq(out)
}

// --- the seeded story, by title, with its age -------------------------------

// cuBriefStory is one Expect member: a title the page is owed, the project it
// belongs to, and how old the story is AT THE CLOCK. The age is what lets a
// three-day story be checked against a two-day chip.
type cuBriefStory struct {
	title   string
	project string
	ago     time.Duration
}

type cuBriefStories struct {
	needsYou, runningNow, shipped, stillFailing, fixed, headsUp, changes []cuBriefStory
	// known is every title the visible world carries, in any section: the check
	// that a row the brief served is a seeded story at all.
	known map[string]bool
}

// cuReadStories re-reads cuSeeded.Expect with ages attached, out of the records
// the seeder kept. The classification order below IS the seeder's own
// (cuWorld.seeded, mirrored on purpose there too); what this adds is only the
// age, so a membership question can be asked about the chip under test rather
// than about the scenario it was seeded for.
func cuReadStories(t *testing.T, s cuSeeded) cuBriefStories {
	t.Helper()
	out := cuBriefStories{known: map[string]bool{}}
	for _, name := range cuReaderProjects() {
		out.known[name] = true
		if p, ok := s.world.pipelines[name]; ok {
			out.known[p.displayName] = true
		}
	}
	add := func(to *[]cuBriefStory, project, title string, ago time.Duration) {
		if !s.WorldVisible(project) {
			return
		}
		*to = append(*to, cuBriefStory{title: title, project: project, ago: ago})
		out.known[title] = true
	}
	for _, r := range s.world.runs {
		if r.status == "running" {
			add(&out.runningNow, r.project, r.title, r.ago)
		}
	}
	for _, a := range s.world.approvals {
		if a.state == "pending" {
			add(&out.needsYou, a.project, a.summary, a.ago)
		}
	}
	for _, it := range s.world.items {
		switch {
		case it.mustKnow:
			add(&out.headsUp, it.project, it.title, it.ago)
		case it.resolution == "run_failed":
			add(&out.stillFailing, it.project, it.title, it.ago)
		case it.asks, it.resolution == "open", it.resolution == "branch_ready":
			add(&out.needsYou, it.project, it.title, it.ago)
		case it.shape == "issue" && it.resolution == "merged":
			add(&out.fixed, it.project, it.title, it.ago)
		case it.shape == "pr" || it.shape == "push":
			add(&out.shipped, it.project, it.title, it.ago)
		}
	}
	for _, p := range s.world.published {
		add(&out.changes, p.project,
			cuRevisionTitle(s.world.pipelines[p.project].displayName+" "+p.label), p.ago)
	}
	return out
}

func (s cuBriefStory) inside(win time.Duration) bool { return s.ago <= win }

func cuStoryTitles(stories []cuBriefStory, win time.Duration) []string {
	out := []string{}
	for _, st := range stories {
		if st.inside(win) {
			out = append(out, st.title)
		}
	}
	return cuUniqSorted(out)
}

// WorldVisible is the membership question the seeded world answers: is this
// project one of the reader's?
func (s cuSeeded) WorldVisible(project string) bool {
	for _, name := range cuReaderProjects() {
		if name == project {
			return true
		}
	}
	return false
}

// --- shape, window, headline --------------------------------------------------

func cuCheckShape(t *testing.T, brief api.CatchUpBrief, key string, now time.Time) {
	t.Helper()
	if brief.Window.Key != key {
		t.Errorf("window.key = %q, want %q", brief.Window.Key, key)
	}
	if want := now.UTC(); !brief.Window.Until.Equal(want) {
		t.Errorf("window.until = %s, want the supplied clock %s", brief.Window.Until, want)
	}
	if want := now.UTC().Add(-cuBriefWindow[key]); !brief.Window.Since.Equal(want) {
		t.Errorf("window.since = %s, want %s — the %s interval back from the clock",
			brief.Window.Since, want, key)
	}
	// Every section is an array, never null: the page draws "nothing happened" and
	// "no such field" differently (ADR-0081).
	for name, slice := range map[string]any{
		"needs_you": brief.NeedsYou, "running_now": brief.RunningNow, "shipped": brief.Shipped,
		"broke": brief.Broke, "heads_up": brief.HeadsUp, "changes": brief.Changes,
		"by_project": brief.ByProject,
	} {
		if slice == nil {
			t.Errorf("%s is nil: a section the page may not index into", name)
		}
	}
	if brief.Omitted == nil {
		t.Error("omitted is nil, want an empty map")
	}
	// No model is attached on this path, so the headline is the honest absence
	// rather than a sentence the read invented.
	if brief.Headline.State != api.CatchUpHeadlineUnavailable || brief.Headline.Text != "" {
		t.Errorf("headline = %+v, want state %q with empty text and no generator",
			brief.Headline, api.CatchUpHeadlineUnavailable)
	}
}

// cuCheckChipColours is the chip claim ADR-0078 makes out loud — a NULL colour is
// served as the deterministic pick BY PROJECT ID, so two replicas and a rename
// cannot shuffle it: one project must carry one colour in every section, that
// colour must be the domain's own pick for its id, and it must be in the palette.
func cuCheckChipColours(t *testing.T, brief api.CatchUpBrief) {
	t.Helper()
	byID, byName := map[string]string{}, map[string]string{}
	chips := []api.CatchUpProjectChip{}
	for _, n := range brief.NeedsYou {
		chips = append(chips, n.Project)
	}
	for _, r := range brief.RunningNow {
		chips = append(chips, r.Project)
	}
	for _, s := range brief.Shipped {
		chips = append(chips, s.Project)
	}
	for _, b := range brief.Broke {
		chips = append(chips, b.Project)
	}
	for _, h := range brief.HeadsUp {
		chips = append(chips, h.Project)
	}
	for _, c := range chips {
		if c.ID == "" || c.Name == "" {
			t.Errorf("a chip is incomplete: %+v", c)
			continue
		}
		if !domain.ValidCatchUpProjectColor(c.Color) {
			t.Errorf("project %s carries colour %q, outside the palette", c.Name, c.Color)
		}
		if want := domain.CatchUpProjectColorOr(c.ID, ""); c.Color != want {
			t.Errorf("project %s carries colour %q, want the domain's own pick %q for id %s",
				c.Name, c.Color, want, c.ID)
		}
		if seen, ok := byID[c.ID]; ok && seen != c.Color {
			t.Errorf("project %s is drawn %q in one section and %q in another", c.Name, seen, c.Color)
		}
		byID[c.ID] = c.Color
		if seen, ok := byName[c.Name]; ok && seen != c.Color {
			t.Errorf("project %s is drawn %q in one section and %q in another", c.Name, seen, c.Color)
		}
		byName[c.Name] = c.Color
	}
}

// --- running_now --------------------------------------------------------------

func cuCheckRunning(t *testing.T, s cuSeeded, brief api.CatchUpBrief) {
	t.Helper()
	got := []string{}
	for _, r := range brief.RunningNow {
		got = append(got, r.Title)
		if r.RunID == "" || r.Link != "/runs/"+r.RunID {
			t.Errorf("running_now row %q links to %q with run id %q", r.Title, r.Link, r.RunID)
		}
		if !s.WorldVisible(r.Project.Name) || r.Project.ID == "" {
			t.Errorf("running_now row %q carries project %+v", r.Title, r.Project)
		}
	}
	if diff := cuDiffStrings("running_now", cuUniqSorted(s.Expect.RunningNow),
		cuUniqSorted(got)); diff != "" {
		t.Errorf("running_now is not the work the seeded world has in flight:%s", diff)
	}
	for i := 1; i < len(brief.RunningNow); i++ {
		if brief.RunningNow[i].StartedAt.After(brief.RunningNow[i-1].StartedAt) {
			t.Errorf("running_now is not newest first: %q after %q",
				brief.RunningNow[i].Title, brief.RunningNow[i-1].Title)
		}
	}
}

// --- needs_you ----------------------------------------------------------------

func cuCheckNeedsYou(t *testing.T, s cuSeeded, story cuBriefStories, world cuBriefWorld,
	win time.Duration, brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()

	// NEEDS_YOU_RULE: cuExpect.NeedsYou is the TOUR's bucket — "a pending approval
	// summary" anywhere in a visible project. The brief answers a sharper question
	// (ADR-0081: the gates THIS reader may decide — the `approval.decide` rule as a
	// predicate), so the infra gate is the teammate's news and not the reader's,
	// who is only a contributor there. cuCheckTeammate asserts the other half.
	want := []cuNeedKey{}
	mayNotDecide := map[string]bool{}
	for _, a := range world.approvals {
		if a.state != "pending" || !world.visible[a.project] || a.ago > win.Seconds() {
			continue
		}
		if !cuRoleListHas(a.roles, world.roles[a.project]) {
			t.Logf("the %s gate %q waits on %v and the reader is a %q in %s: not needs_you",
				a.project, a.summary, a.roles, world.roles[a.project], a.project)
			mayNotDecide[a.summary] = true
			continue
		}
		want = append(want, cuNeedKey{kind: api.CatchUpNeedApproval, title: a.runTitle,
			detail: a.summary})
	}
	// The questions: a tour beat that asked and was never answered. A work item
	// merely LEFT open asks nobody anything, so Expect's needs-you members that are
	// items are only owed here when a decision sits on one.
	for _, it := range s.world.items {
		if !s.WorldVisible(it.project) || it.ago > win || !it.asks {
			continue
		}
		want = append(want, cuNeedKey{kind: api.CatchUpNeedQuestion, title: it.title})
	}
	// The third kind — the reader's OWN failed run whose pipeline has not gone
	// green since. It is derived rather than assumed, because a fixture where the
	// reader's failure WAS never followed by a green run has to show up here.
	for _, r := range world.runs {
		if !world.visible[r.project] || r.status != "failed" ||
			r.triggeredBy != s.ReaderID || r.clockAgo() > win.Seconds() {
			continue
		}
		if world.greenSince(r) {
			t.Logf("%q failed at −%.0fm and the pipeline went green since: not the reader's to fix",
				r.title, r.clockAgo()/60)
			continue
		}
		want = append(want, cuNeedKey{kind: api.CatchUpNeedFailedRun, title: r.title})
	}

	got := []cuNeedKey{}
	for _, n := range brief.NeedsYou {
		got = append(got, cuNeedKey{kind: n.Kind, title: n.Title})
		switch n.Kind {
		case api.CatchUpNeedApproval, api.CatchUpNeedQuestion, api.CatchUpNeedFailedRun:
		default:
			t.Errorf("needs_you row %q has kind %q outside the ADR-0081 vocabulary", n.Title, n.Kind)
		}
		if !world.visible[n.Project.Name] || n.Project.ID == "" {
			t.Errorf("needs_you row %q carries project %+v", n.Title, n.Project)
		}
		if n.Link == "" {
			t.Errorf("needs_you row %q has nothing to open", n.Title)
		}
		if age := cuBriefSecondsFromNow(cuTestClock, n.At); age < 0 || age > win.Seconds() {
			t.Errorf("needs_you row %q is dated %s (−%.0fm), outside the window",
				n.Title, n.At, age/60)
		}
	}
	if diff := cuDiffNeeds(want, got); diff != "" {
		t.Errorf("needs_you is not what the seeded window waits on:%s", diff)
	}
	// The gate's own words: the row's detail is the approval's summary, which is
	// the only thing that says WHAT the reader is being asked to decide.
	for _, w := range want {
		if w.kind != api.CatchUpNeedApproval {
			continue
		}
		for _, n := range brief.NeedsYou {
			if n.Title == w.title && n.Kind == w.kind && n.Detail != w.detail {
				t.Errorf("needs_you %q detail = %q, want the gate's own summary %q",
					n.Title, n.Detail, w.detail)
			}
		}
	}
	// Oldest first: the thing that has waited longest is the thing somebody else
	// is waiting on.
	for i := 1; i < len(brief.NeedsYou); i++ {
		if brief.NeedsYou[i].At.Before(brief.NeedsYou[i-1].At) {
			t.Errorf("needs_you is not oldest first: %q (%s) after %q (%s)",
				brief.NeedsYou[i].Title, brief.NeedsYou[i].At,
				brief.NeedsYou[i-1].Title, brief.NeedsYou[i-1].At)
		}
	}
	// Every seeded "needs you" story inside the chip came back from the store at
	// all. A gate's story is its summary, which the row carries in `detail` (its
	// `title` is the run the gate is on); an item's story is its title. The gate
	// the reader may not decide is the one documented exception, and
	// cuCheckTeammate proves it is the membership that hides it.
	reached := cuNeedTitles(pre.needsAll())
	for _, n := range pre.needsAll() {
		reached = append(reached, n.Detail)
	}
	for _, st := range cuStoryTitles(story.needsYou, win) {
		if mayNotDecide[st] {
			continue
		}
		if !stringsContain(reached, st) {
			t.Errorf("the seeded story %q waits on the reader but is in no needs_you row the store returned (%v)",
				st, reached)
		}
	}
}

// cuNeedKey is one needs_you row as the test states it: the kind, the title, and
// (for a gate) the summary the reader is asked to approve.
type cuNeedKey struct {
	kind, title, detail string
}

func cuNeedTitles(rows []api.CatchUpBriefNeed) []string {
	out := []string{}
	for _, n := range rows {
		out = append(out, n.Title)
	}
	return out
}

func cuRoleListHas(roles []string, role string) bool {
	for _, r := range roles {
		if r == role {
			return true
		}
	}
	return false
}

func cuDiffNeeds(want, got []cuNeedKey) string {
	line := func(k cuNeedKey) string { return k.kind + " " + k.title }
	w, g := []string{}, []string{}
	for _, k := range want {
		w = append(w, line(k))
	}
	for _, k := range got {
		g = append(g, line(k))
	}
	return cuDiffStrings("needs_you", cuUniqSorted(w), cuUniqSorted(g))
}

// greenSince reports whether a run's own pipeline went green later.
func (w cuBriefWorld) greenSince(r cuBRun) bool {
	for _, later := range w.runs {
		if later.project == r.project && later.pipeline == r.pipeline &&
			later.status == "completed" && later.clockAgo() < r.clockAgo() {
			return true
		}
	}
	return false
}

// --- shipped ------------------------------------------------------------------

func cuCheckShipped(t *testing.T, story cuBriefStories, world cuBriefWorld,
	win time.Duration, brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()

	// Count the refs off the raw envelopes the store returned, on the same key
	// names and with the same bounds the harvest keeps: this is the one path by
	// which a PR number reaches the brief, and nothing a run did not name in its
	// own outputs may appear here.
	want := pre.wantShipped()
	if brief.Numbers.PRs != want.prs {
		t.Errorf("numbers.prs = %d, want the %d distinct pull requests the window's runs named",
			brief.Numbers.PRs, want.prs)
	}
	if brief.Numbers.Commits != want.commits {
		t.Errorf("numbers.commits = %d, want the %d distinct commits the window's runs named",
			brief.Numbers.Commits, want.commits)
	}
	total := len(want.rows) + len(pre.revisions)
	if len(brief.Shipped)+brief.Omitted["shipped"] != total {
		t.Errorf("shipped shows %d and omits %d, want %d (the window's harvested refs plus its %d published workflows)",
			len(brief.Shipped), brief.Omitted["shipped"], total, len(pre.revisions))
	}

	// Every shipped story inside the chip must have come back from the store.
	gotTitles := cuUniqSorted(cuShippedTitles(append(pre.wantRows(), pre.revisions...)))
	for _, st := range cuStoryTitles(story.shipped, win) {
		if !stringsContain(gotTitles, st) {
			t.Errorf("the shipped story %q is in no shipped row the store returned (%v)", st, gotTitles)
		}
	}
	for _, sh := range brief.Shipped {
		if !story.known[sh.Title] {
			t.Errorf("shipped row %q names a story the seeded world never wrote", sh.Title)
		}
		if !world.visible[sh.Project.Name] || sh.Project.ID == "" {
			t.Errorf("shipped row %q carries project %+v", sh.Title, sh.Project)
		}
		if age := cuBriefSecondsFromNow(cuTestClock, sh.At); age < 0 || age > win.Seconds() {
			t.Errorf("shipped row %q is dated %s, outside the window", sh.Title, sh.At)
		}
		switch sh.Kind {
		case api.CatchUpShippedPR:
			if sh.Ref.Number == 0 && sh.Ref.URL == "" {
				t.Errorf("shipped pr row %q names neither a number nor a url", sh.Title)
			}
			if !strings.HasPrefix(sh.Link, "/runs/") {
				t.Errorf("shipped pr row %q links to %q, want the run that named it", sh.Title, sh.Link)
			}
		case api.CatchUpShippedCommit:
			if len(sh.Ref.SHA) < 7 {
				t.Errorf("shipped commit row %q carries sha %q", sh.Title, sh.Ref.SHA)
			}
		case api.CatchUpShippedRevision:
			if sh.Ref.SHA != "" || sh.Ref.Number != 0 || !strings.HasPrefix(sh.Link, "/workflows/") {
				t.Errorf("shipped revision row %q = %+v link %q: a workflow has no code ref",
					sh.Title, sh.Ref, sh.Link)
			}
		default:
			t.Errorf("shipped row %q has kind %q outside the ADR-0081 vocabulary", sh.Title, sh.Kind)
		}
	}
	// A ref is labelled data, not reconciled state (ADR-0078 § Decision 6): the
	// harvest has never spoken to GitHub, so NOTHING in the brief may claim a
	// merge — not a row, not a title, not a headline.
	if strings.Contains(strings.ToLower(cuBriefJSON(t, brief)), "merged") {
		t.Error("the brief claims something merged; the server has not asked GitHub anything")
	}
	for i := 1; i < len(brief.Shipped); i++ {
		if brief.Shipped[i].At.After(brief.Shipped[i-1].At) {
			t.Errorf("shipped is not newest first: %q (%s) after %q (%s)",
				brief.Shipped[i].Title, brief.Shipped[i].At,
				brief.Shipped[i-1].Title, brief.Shipped[i-1].At)
		}
	}
}

func cuShippedTitles(rows []api.CatchUpBriefShipped) []string {
	out := []string{}
	for _, s := range rows {
		out = append(out, s.Title)
	}
	return out
}

// --- broke --------------------------------------------------------------------

// cuBriefBrokeWant is one (project, pipeline) the window proved red, with the two
// answers ADR-0081 exists to give: is it STILL red, and if not, when did it stop
// being red.
type cuBriefBrokeWant struct {
	project, title string
	failures       int
	errorClass     string
	stillFailing   bool
	fixedAgo       *float64
	newestErrorAgo float64
}

func cuWantBroke(t *testing.T, s cuSeeded, world cuBriefWorld,
	win time.Duration) []cuBriefBrokeWant {
	t.Helper()
	seen := map[string]bool{}
	key := func(r cuBRun) string { return r.project + "\x00" + r.pipeline }
	out := []cuBriefBrokeWant{}
	for _, r := range world.runs {
		if !world.visible[r.project] || seen[key(r)] {
			continue
		}
		seen[key(r)] = true
		group := world.runsOf(r.project, r.pipeline)
		want := cuBriefBrokeWant{project: r.project, title: cuPipeName(s, r.project, r.pipeline),
			newestErrorAgo: -1}
		newest := group[0]
		lastFailed := -1.0
		for _, g := range group {
			if g.clockAgo() < newest.clockAgo() {
				newest = g
			}
			if g.status == "failed" && g.clockAgo() <= win.Seconds() {
				want.failures++
				if lastFailed < 0 || g.clockAgo() < lastFailed {
					lastFailed = g.clockAgo()
				}
			}
		}
		if want.failures == 0 {
			continue
		}
		// `still_failing` is the pipeline's NEWEST run over all time, not the
		// window's: last week's red is not the current truth a reader can act on.
		want.stillFailing = newest.status == "failed"
		for _, n := range world.nodes {
			if n.project != r.project || !n.failed || n.errorClass == "" {
				continue
			}
			if want.newestErrorAgo < 0 || n.ago < want.newestErrorAgo {
				want.errorClass, want.newestErrorAgo = n.errorClass, n.ago
			}
		}
		if !want.stillFailing {
			// The first run that went green AFTER the window's last failure: the
			// greenest stamp older than nothing... stated exactly, the EARLIEST
			// completion that is still newer than the last red run.
			var best *float64
			for _, g := range group {
				if g.status != "completed" || g.finishedAgo == nil {
					continue
				}
				if *g.finishedAgo < lastFailed && (best == nil || *g.finishedAgo > *best) {
					v := *g.finishedAgo
					best = &v
				}
			}
			want.fixedAgo = best
		}
		out = append(out, want)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].project < out[j].project })
	return out
}

func (w cuBriefWorld) runsOf(project, pipeline string) []cuBRun {
	out := []cuBRun{}
	for _, r := range w.runs {
		if r.project == project && r.pipeline == pipeline {
			out = append(out, r)
		}
	}
	return out
}

func cuPipeName(s cuSeeded, project, pipeID string) string {
	if p, ok := s.world.pipelines[project]; ok && p.id == pipeID {
		return p.displayName
	}
	return ""
}

func cuCheckBroke(t *testing.T, s cuSeeded, world cuBriefWorld, win time.Duration,
	brief api.CatchUpBrief) {
	t.Helper()
	want := cuWantBroke(t, s, world, win)
	got := map[string]api.CatchUpBriefBroke{}
	for _, b := range brief.Broke {
		got[b.Project.Name] = b
		if b.FixedAt != nil && b.StillFailing {
			t.Errorf("broke %q is still failing AND fixed at %s — the pair is a contradiction",
				b.Title, b.FixedAt)
		}
		if b.Failures < 1 {
			t.Errorf("broke %q counts %d failures", b.Title, b.Failures)
		}
		if !world.visible[b.Project.Name] {
			t.Errorf("broke %q carries project %+v", b.Title, b.Project)
		}
		if !strings.HasPrefix(b.Link, "/runs/") && !strings.HasPrefix(b.Link, "/workflows/") {
			t.Errorf("broke %q links to %q", b.Title, b.Link)
		}
	}
	if len(want) != len(brief.Broke) {
		t.Errorf("broke has %d rows, want %d — one per (project, pipeline) that failed in the window: %+v",
			len(brief.Broke), len(want), want)
	}
	for _, w := range want {
		b, ok := got[w.project]
		if !ok {
			t.Errorf("broke lost the failed %s pipeline %q (%d failures)",
				w.project, w.title, w.failures)
			continue
		}
		if b.Title != w.title {
			t.Errorf("broke %q is titled %q, want the workflow it groups (%q)",
				b.Project.Name, b.Title, w.title)
		}
		if b.Failures != w.failures {
			t.Errorf("broke %q counts %d failures, want the window's %d red runs of that workflow",
				b.Project.Name, b.Failures, w.failures)
		}
		if b.StillFailing != w.stillFailing {
			t.Errorf("broke %q still_failing = %v, want %v (the newest run of that workflow)",
				b.Project.Name, b.StillFailing, w.stillFailing)
		}
		if b.ErrorClass != w.errorClass {
			t.Errorf("broke %q error_class = %q, want %q (the newest failed node's own class)",
				b.Project.Name, b.ErrorClass, w.errorClass)
		}
		switch {
		case w.stillFailing && b.FixedAt != nil:
			t.Errorf("broke %q is still red and carries fixed_at %s", b.Project.Name, *b.FixedAt)
		case (w.fixedAgo == nil) != (b.FixedAt == nil):
			t.Errorf("broke %q fixed_at = %v, want %v", b.Project.Name, b.FixedAt, w.fixedAgo)
		case w.fixedAgo != nil:
			if at := cuBriefSecondsFromNow(cuTestClock, *b.FixedAt); at != *w.fixedAgo {
				t.Errorf("broke %q fixed_at is −%.0fm, want −%.0fm (the first green run after the window's last failure)",
					b.Project.Name, at/60, *w.fixedAgo/60)
			}
		}
	}
	// A pipeline still red is the row the reader opens first.
	for i := 1; i < len(brief.Broke); i++ {
		if brief.Broke[i].StillFailing && !brief.Broke[i-1].StillFailing {
			t.Errorf("broke lists the still-red %q behind a workflow that recovered",
				brief.Broke[i].Title)
		}
	}
}

// --- heads_up -----------------------------------------------------------------

// HEADS_UP_RULE. cuExpect.HeadsUp is the TOUR's must_know floor: the seeded
// scenarios raise a beat by hand, from the story the work tells. The brief's
// `heads_up` is the SAME signal table the tour's floor runs
// (assistant.catchUpImportanceSignals), applied to what the server holds — the
// window's runs AND its work items (ADR-0081 § Decision) — and several seeded
// must_know stories name no pattern that table matches. The rows the records do
// support, each with why, are asserted below:
//
//   - push_to_main: the lint pin's run names branch "main" AND a commit — the
//     rule's guard, not the word "main" in a title;
//   - migration: the backfill's item text carries db/migrations/00042_add_ledger.sql;
//   - deps: the pgx bump's item text carries go.mod.
//
// The rest are the honest limits of the surface, asserted rather than ignored —
// and cuCheckHeadsUp proves each of them still REACHES the reader as a shipped or
// a changes row: SameSite=Strict is prose about a cookie flag with no path in it;
// the quarantined test names its skip in an output key rather than in text the
// rules read; and a new member has no key in the closed signal vocabulary at all,
// because ADR-0081 put member_added in `changes` instead.
// cuCheckBugStories ties the two tour buckets that are about FAILURE back to the
// rows behind them: an item that says a bug was found and fixed has to have its
// fix in the shipped section (ADR-0078 § Grouping folds found→fixed into one
// story, and a brief that showed only the red half would re-tell a bug that is
// gone), and an item that says work is still failing has to have a red — or, for
// a run somebody stopped on purpose, a cancelled — run of its own inside the chip.
func cuCheckBugStories(t *testing.T, story cuBriefStories, world cuBriefWorld,
	win time.Duration, brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()
	shipped := cuShippedTitles(append(pre.wantRows(), pre.revisions...))
	for _, st := range story.fixed {
		if !st.inside(win) {
			continue
		}
		if !stringsContain(shipped, st.title) {
			t.Errorf("the fixed bug story %q has no shipped row carrying its fix (%v)", st.title, shipped)
		}
	}
	for _, st := range story.stillFailing {
		if !st.inside(win) {
			continue
		}
		red, stopped := false, false
		for _, r := range world.runs {
			if r.project != st.project || r.title != st.title {
				continue
			}
			switch r.status {
			case "failed":
				red = red || r.clockAgo() <= win.Seconds()
			case "cancelled", "interrupted":
				stopped = stopped || r.clockAgo() <= win.Seconds()
			}
		}
		if !red && !stopped {
			t.Errorf("the still_failing story %q (%s) has no failed or cancelled run of its own inside the window",
				st.title, st.project)
		}
		if !red {
			t.Logf("%q stopped short rather than failing: its item is run_failed, its run was cancelled",
				st.title)
		}
	}
}

func cuExpectedHeadsUp(story cuBriefStories, win time.Duration) []string {
	named := map[string]string{
		"Pin the shared lint config on main": api.CatchUpSignalPushToMain,
		"Backfill the ledger accounts":       api.CatchUpSignalMigration,
		"Bump pgx to v5.9":                   api.CatchUpSignalDeps,
	}
	out := []string{}
	for _, st := range story.headsUp {
		if !st.inside(win) {
			continue
		}
		if signal, ok := named[st.title]; ok {
			out = append(out, signal+":"+st.title)
		}
	}
	return cuUniqSorted(out)
}

func cuCheckHeadsUp(t *testing.T, story cuBriefStories, world cuBriefWorld, win time.Duration,
	brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()
	got := []string{}
	for _, h := range brief.HeadsUp {
		got = append(got, h.Signal+":"+h.Title)
		switch h.Signal {
		case api.CatchUpSignalMigration, api.CatchUpSignalAuth, api.CatchUpSignalDeps,
			api.CatchUpSignalPushToMain, api.CatchUpSignalSkipped, api.CatchUpSignalPublicAPI:
		default:
			t.Errorf("heads_up row %q carries signal %q outside the ADR-0081 vocabulary",
				h.Title, h.Signal)
		}
		if !story.known[h.Title] {
			t.Errorf("heads_up row %q names a story the seeded world never wrote", h.Title)
		}
		if !world.visible[h.Project.Name] || h.Project.ID == "" {
			t.Errorf("heads_up row %q carries project %+v", h.Title, h.Project)
		}
		if h.Link == "" {
			t.Errorf("heads_up row %q has nothing to open", h.Title)
		}
	}
	seen := map[string]bool{}
	for _, g := range got {
		if seen[g] {
			t.Errorf("heads_up lists %q twice: one row per (item, signal) is the rule", g)
		}
		seen[g] = true
	}
	// The items half of the section is only as good as the read behind it: every
	// work item the chip holds must have come back, whatever the rules then said
	// about it.
	cameBack := cuUniqSorted(cuItemTitles(pre.items))
	for _, it := range world.items {
		if !world.visible[it.project] || it.ago > win.Seconds() {
			continue
		}
		if !stringsContain(cameBack, it.title) {
			t.Errorf("the seeded work item %q (%s) is missing from the brief's item read",
				it.title, it.project)
		}
	}
	if diff := cuDiffStrings("heads_up", cuExpectedHeadsUp(story, win), cuUniqSorted(got)); diff != "" {
		t.Errorf("heads_up is not the signals the seeded records carry:%s", diff)
	}

	// Nothing must_know may simply fail to arrive: every seeded must_know story
	// inside the chip reaches the reader somewhere in this brief.
	reaches := cuUniqSorted(append(
		cuShippedTitles(append(pre.wantRows(), pre.revisions...)),
		cuChangeTitles(pre.wantChanges())...))
	for _, it := range pre.items {
		reaches = append(reaches, it.Title)
	}
	joined := false
	for _, ch := range brief.Changes {
		if ch.Kind == api.CatchUpChangeMember {
			joined = true
		}
	}
	for _, st := range story.headsUp {
		if !st.inside(win) {
			continue
		}
		// The new member is the one must_know story that cannot travel under its
		// own title: ADR-0081 puts member_added in `changes`, where the row names
		// the person from the memberships table rather than the item.
		if st.title == "A new member joined infra" {
			if win >= 30*time.Hour && !joined {
				t.Errorf("the seeded new member joined %s 30h ago and reaches the reader neither as a signal nor as a change row",
					st.project)
			}
			continue
		}
		if !stringsContain(reaches, st.title) {
			t.Errorf("the seeded must_know story %q (%s, −%.0fm) reaches the reader nowhere in this brief",
				st.title, st.project, st.ago.Minutes())
		}
	}
}

// --- changes ------------------------------------------------------------------

func cuCheckChanges(t *testing.T, world cuBriefWorld, story cuBriefStories,
	win time.Duration, brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()
	want := cuStoryTitles(story.changes, win) // rendered "<workflow> v<label>"
	// The people who joined: derived off the memberships table (the reader's and
	// the teammate's own rows are eight days old, so no window holds them), with
	// the store's own rendering of one — the joiner is the subject of the row and
	// `memberships` records no inviter to name instead.
	for _, m := range world.members {
		if !world.visible[m.project] || m.ago > win.Seconds() {
			continue
		}
		want = append(want, m.name+" joined "+m.project+" as "+m.role)
	}
	got := cuChangeTitles(brief.Changes)
	if diff := cuDiffStrings("changes", cuUniqSorted(want), cuUniqSorted(got)); diff != "" {
		t.Errorf("changes is not what the seeded world did to the setup:%s", diff)
	}
	for _, ch := range brief.Changes {
		switch ch.Kind {
		case api.CatchUpChangePublished, api.CatchUpChangeProfileNew, api.CatchUpChangeProfileEd,
			api.CatchUpChangeMember:
		default:
			t.Errorf("changes row %q has kind %q outside the ADR-0081 vocabulary", ch.Title, ch.Kind)
		}
		if age := cuBriefSecondsFromNow(cuTestClock, ch.At); age < 0 || age > win.Seconds() {
			t.Errorf("changes row %q is dated %s, outside the window", ch.Title, ch.At)
		}
	}
	for i := 1; i < len(brief.Changes); i++ {
		if brief.Changes[i].At.After(brief.Changes[i-1].At) {
			t.Errorf("changes is not newest first: %q after %q",
				brief.Changes[i].Title, brief.Changes[i-1].Title)
		}
	}
	// A published workflow is a change AND a shipped row — "it went live" and "the
	// setup moved" are two questions a reader asks about one event.
	for _, rev := range pre.revisions {
		if !stringsContain(got, rev.Title) {
			t.Errorf("the published workflow %q shipped but is not a change row (%v)", rev.Title, got)
		}
	}
	// The seeded world's new profile is an agent_profiles row with no
	// agent_profile_versions row behind it (the seeder writes it by hand), and
	// `changes` reads versions because that is the only table that records WHO
	// moved a profile. So it is honestly absent rather than credited to nobody —
	// the check below is what keeps that statement true if a seed ever starts
	// publishing versions.
	for _, ch := range brief.Changes {
		if ch.Kind == api.CatchUpChangeProfileNew || ch.Kind == api.CatchUpChangeProfileEd {
			t.Errorf("changes row %q (%s) appeared without an agent_profile_versions row behind it",
				ch.Title, ch.Kind)
		}
	}
}

// cuRevisionTitle is how the brief renders a published workflow: the seeded Expect
// carries "<workflow> <label>", the row carries "<workflow> v<label>".
func cuRevisionTitle(expectTitle string) string {
	i := strings.LastIndexByte(expectTitle, ' ')
	if i < 0 {
		return expectTitle
	}
	return expectTitle[:i] + " v" + expectTitle[i+1:]
}

func cuItemTitles(items []api.CatchUpBriefItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Title)
	}
	return out
}

func cuChangeTitles(rows []api.CatchUpBriefChange) []string {
	out := []string{}
	for _, c := range rows {
		out = append(out, c.Title)
	}
	return out
}

// --- numbers ------------------------------------------------------------------

func cuCheckNumbers(t *testing.T, s cuSeeded, world cuBriefWorld, key string,
	win time.Duration, brief api.CatchUpBrief) {
	t.Helper()
	// Recomputed off the ledger, with the store's own clock rules: a terminal run
	// is counted when it FINISHED, the live set is a stock as of now (the same
	// predicate running_now lists), a gate is decided when somebody answered it and
	// pending while nobody has.
	want := api.CatchUpBriefNumbers{}
	live := map[string]bool{"queued": true, "preparing": true, "running": true}
	for _, r := range world.runs {
		if !world.visible[r.project] {
			continue
		}
		switch {
		case live[r.status]:
			want.Runs.Running++
		case r.status == "completed" && r.clockAgo() <= win.Seconds():
			want.Runs.Succeeded++
		case r.status == "failed" && r.clockAgo() <= win.Seconds():
			want.Runs.Failed++
		// ADR-0081's numbers block has no key for `interrupted`; the store counts it
		// with `cancelled` — both read as "ended without finishing".
		case (r.status == "cancelled" || r.status == "interrupted") &&
			r.clockAgo() <= win.Seconds():
			want.Runs.Cancelled++
		}
	}
	for _, a := range world.approvals {
		if !world.visible[a.project] {
			continue
		}
		if a.state == "pending" {
			want.Approvals.Pending++
		}
		if a.state == "decided" && a.decidedAgo != nil && *a.decidedAgo <= win.Seconds() {
			want.Approvals.Decided++
		}
	}
	for _, age := range world.threads {
		if age <= win.Seconds() {
			want.ThreadsActive++
		}
	}
	if brief.Numbers.Runs != want.Runs {
		t.Errorf("numbers.runs = %+v, want %+v recomputed off the seeded ledger for the %s window",
			brief.Numbers.Runs, want.Runs, key)
	}
	if brief.Numbers.Approvals != want.Approvals {
		t.Errorf("numbers.approvals = %+v, want %+v", brief.Numbers.Approvals, want.Approvals)
	}
	if brief.Numbers.ThreadsActive != want.ThreadsActive {
		t.Errorf("numbers.threads_active = %d, want %d (live threads the window touched)",
			brief.Numbers.ThreadsActive, want.ThreadsActive)
	}
	if win != s.world.scenario.window() {
		return // a wider chip than the story: Expect's numbers are for its own window
	}
	// And the same arithmetic as the story the seeder recorded, from the other side
	// of the fixture. `pending` is the one pair that answers two different
	// questions — the brief counts every gate still open, the seeder counts the
	// gates opened inside the window — so it is asserted as the floor it is, and
	// the seeded windows happen to coincide.
	e := s.Expect
	pairs := []struct {
		name    string
		got     int
		want    int
		floorOK bool
	}{
		{"runs.succeeded", brief.Numbers.Runs.Succeeded, e.Succeeded, false},
		{"runs.failed", brief.Numbers.Runs.Failed, e.Failed, false},
		{"runs.cancelled", brief.Numbers.Runs.Cancelled, e.Cancelled, false},
		{"runs.running", brief.Numbers.Runs.Running, e.Running, false},
		{"approvals.decided", brief.Numbers.Approvals.Decided, e.ApprovalsDecided, false},
		{"approvals.pending", brief.Numbers.Approvals.Pending, e.ApprovalsPending, true},
	}
	for _, p := range pairs {
		switch {
		case p.floorOK && p.got < p.want:
			t.Errorf("numbers.%s = %d, want at least the window's %d", p.name, p.got, p.want)
		case p.floorOK:
			t.Logf("numbers.approvals.pending = %d against the seeded window's %d: a stock is not a window count",
				p.got, p.want)
		case p.got != p.want:
			t.Errorf("numbers.%s = %d, want %d (what the seeded window holds)", p.name, p.got, p.want)
		}
	}
}

// --- caps ---------------------------------------------------------------------

func cuCheckCaps(t *testing.T, key string, brief api.CatchUpBrief, pre *cuBriefCapture) {
	t.Helper()
	limit := cuBriefCap(key)
	sections := []struct {
		name  string
		shown int
		total int // -1: the total is assembled inside the assembler, not by this test
	}{
		{"needs_you", len(brief.NeedsYou), len(pre.needsAll())},
		{"running_now", len(brief.RunningNow), len(pre.running)},
		{"shipped", len(brief.Shipped), len(pre.wantShipped().rows) + len(pre.revisions)},
		{"broke", len(brief.Broke), -1},
		{"heads_up", len(brief.HeadsUp), -1},
		{"changes", len(brief.Changes), len(pre.wantChanges())},
	}
	for _, sec := range sections {
		if sec.total >= 0 {
			want := sec.total
			if want > limit {
				want = limit
			}
			if sec.shown != want {
				t.Errorf("%s shows %d rows, want %d (the cap is %d over %d rows)",
					sec.name, sec.shown, want, limit, sec.total)
			}
			omitted := sec.total - limit
			if omitted < 0 {
				omitted = 0
			}
			if got := brief.Omitted[sec.name]; got != omitted {
				t.Errorf("omitted[%s] = %d, want %d (the rows the cap cut from %d)",
					sec.name, got, omitted, sec.total)
			}
			continue
		}
		// broke and heads_up are folded together inside the assembler, so this test
		// cannot count their pre-cap rows — but the seeded window holds well under
		// the smallest cap for both, so any number in `omitted` there is a row that
		// vanished with no receipt.
		if got := brief.Omitted[sec.name]; got != 0 {
			t.Errorf("omitted[%s] = %d, want 0: the seeded window holds less than the cap of %d",
				sec.name, got, limit)
		}
	}
	for name := range brief.Omitted {
		switch name {
		case "needs_you", "running_now", "shipped", "broke", "heads_up", "changes":
		default:
			t.Errorf("omitted counts a section that has no rows: %q", name)
		}
	}
	// ADR-0081's own example is what the widest window is for: a busy week shows ten
	// shipped rows and says how many it left out.
	if key == api.CatchUpWindowWeekly {
		total := len(pre.wantShipped().rows) + len(pre.revisions)
		if len(brief.Shipped) != 10 {
			t.Errorf("shipped shows %d rows, want the 10-row cap over %d", len(brief.Shipped), total)
		}
		if brief.Omitted["shipped"] != total-10 {
			t.Errorf("omitted.shipped = %d, want the %d rows the cap cut from %d",
				brief.Omitted["shipped"], total-10, total)
		}
	}
}

// --- the project the reader is not in -----------------------------------------

func cuCheckNoSecretOps(t *testing.T, world cuBriefWorld, brief api.CatchUpBrief,
	pre *cuBriefCapture) {
	t.Helper()
	blob := cuBriefJSON(t, brief) + pre.allJSON(t)
	for _, needle := range world.secretNeedles {
		if needle == "" {
			continue
		}
		if strings.Contains(blob, needle) {
			t.Errorf("secret-ops reached the reader's brief: the value %q appears in it", needle)
			return
		}
	}
}

// cuCheckTeammate proves that the reader's blanks are a membership answer rather
// than an empty world: the same read, same clock, same chip, as a teammate — who
// IS in secret-ops and IS a maintainer of infra — holds exactly the rows the
// reader cannot have.
func cuCheckTeammate(t *testing.T, f *cnvFixture, s cuSeeded, world cuBriefWorld,
	key string, win time.Duration, readerBrief api.CatchUpBrief) {
	t.Helper()
	store := APICatchUpStore{S: cuStore(f)}
	asTeammate := api.Caller{UserID: s.TeammateID, OrganizationID: f.orgID}
	team, err := api.AssembleCatchUpBrief(testCtx(t), store, asTeammate,
		api.CatchUpBriefScope{Window: key}, cuTestClock)
	if err != nil {
		t.Fatalf("assemble the teammate's %s brief: %v", key, err)
	}
	// secret-ops is seeded in every window (a real failure, five minutes ago, by
	// this reader's teammate), so their own answer has to name it.
	if !strings.Contains(cuBriefJSON(t, team), "Rotate the deploy credentials") {
		t.Errorf("the teammate's %s brief lost secret-ops, which they are in:\n%s",
			key, cuBriefJSON(t, team))
	}
	if strings.Contains(cuBriefJSON(t, readerBrief), "Rotate the deploy credentials") {
		t.Errorf("the reader's %s brief named secret-ops work", key)
	}
	// The gate whose approver_roles the reader does not hold — pending infra is a
	// maintainer's gate and the reader is a contributor there. Derived rather than
	// named, so a fixture that stops seeding it stops claiming it.
	gate := ""
	for _, a := range world.approvals {
		if a.state == "pending" && world.visible[a.project] && a.ago <= win.Seconds() &&
			!cuRoleListHas(a.roles, world.roles[a.project]) {
			gate = a.summary
		}
	}
	if gate == "" {
		t.Logf("%s: no pending gate in this world waits on a role the reader does not hold", key)
	} else {
		if !cuHasNeed(team.NeedsYou, gate) {
			t.Errorf("the teammate holds the role the %s gate waits on and was not told about it: %+v",
				gate, team.NeedsYou)
		}
		if cuHasNeed(readerBrief.NeedsYou, gate) {
			t.Errorf("the reader was told about %q, a gate their role may not decide", gate)
		}
	}
	// Everything the reader is asked about, the teammate — who can see a superset
	// of the projects — is asked about too: the difference between the two briefs
	// is exactly the project they are not in, never a different question. Failed
	// runs are the exception by construction: that row is addressed to whoever
	// started the run, which is the point of the section.
	for _, n := range readerBrief.NeedsYou {
		if n.Kind == api.CatchUpNeedFailedRun {
			continue
		}
		seen := false
		for _, m := range team.NeedsYou {
			if m.Title == n.Title {
				seen = true
			}
		}
		if !seen {
			t.Errorf("the reader is told about %q and the teammate, who sees everything the reader does, is not",
				n.Title)
		}
	}
}

func cuHasNeed(rows []api.CatchUpBriefNeed, detail string) bool {
	for _, n := range rows {
		if n.Detail == detail {
			return true
		}
	}
	return false
}

// --- the capture: what the store returned before the cap ----------------------

// cuBriefCapture is the store with a notebook. The assembler trims every section
// to the window's cap and counts the rest into `omitted`, so a seeded story the cap
// dropped is invisible in the response — and it still has to have come back from
// the store, or `omitted` is counting something other than what it says.
type cuBriefCapture struct {
	inner api.CatchUpBriefStore

	gates     []api.CatchUpBriefNeed
	questions []api.CatchUpBriefNeed
	stuck     []api.CatchUpBriefNeed
	running   []api.CatchUpBriefRunning
	nodes     []api.CatchUpBriefRunNode
	revisions []api.CatchUpBriefShipped
	broke     []api.CatchUpBriefBroke
	profiles  []api.CatchUpBriefChange
	members   []api.CatchUpBriefChange
	items     []api.CatchUpBriefItem
	numbers   api.CatchUpBriefNumbers
	visit     time.Time
}

var (
	_ api.CatchUpBriefStore     = (*cuBriefCapture)(nil)
	_ api.CatchUpBriefItemStore = (*cuBriefCapture)(nil)
)

func (c *cuBriefCapture) CatchUpBriefLastVisit(ctx context.Context,
	cl api.Caller) (time.Time, error) {
	at, err := c.inner.CatchUpBriefLastVisit(ctx, cl)
	c.visit = at
	return at, err
}

func (c *cuBriefCapture) CatchUpBriefApprovals(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	out, err := c.inner.CatchUpBriefApprovals(ctx, cl, f)
	c.gates = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefQuestions(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	out, err := c.inner.CatchUpBriefQuestions(ctx, cl, f)
	c.questions = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefStuckRuns(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	out, err := c.inner.CatchUpBriefStuckRuns(ctx, cl, f)
	c.stuck = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefRunning(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefRunning, error) {
	out, err := c.inner.CatchUpBriefRunning(ctx, cl, f)
	c.running = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefBroke(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefBroke, error) {
	out, err := c.inner.CatchUpBriefBroke(ctx, cl, f)
	c.broke = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefRunNodes(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefRunNode, error) {
	out, err := c.inner.CatchUpBriefRunNodes(ctx, cl, f)
	c.nodes = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefRevisions(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefShipped, error) {
	out, err := c.inner.CatchUpBriefRevisions(ctx, cl, f)
	c.revisions = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefProfiles(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefChange, error) {
	out, err := c.inner.CatchUpBriefProfiles(ctx, cl, f)
	c.profiles = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefMembers(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefChange, error) {
	out, err := c.inner.CatchUpBriefMembers(ctx, cl, f)
	c.members = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefWorkItems(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefItem, error) {
	out, err := c.inner.(api.CatchUpBriefItemStore).CatchUpBriefWorkItems(ctx, cl, f)
	c.items = out
	return out, err
}

func (c *cuBriefCapture) CatchUpBriefCounts(ctx context.Context, cl api.Caller,
	f api.CatchUpBriefFilter) (api.CatchUpBriefNumbers, error) {
	out, err := c.inner.CatchUpBriefCounts(ctx, cl, f)
	c.numbers = out
	return out, err
}

func (c *cuBriefCapture) needsAll() []api.CatchUpBriefNeed {
	out := append([]api.CatchUpBriefNeed{}, c.gates...)
	out = append(out, c.questions...)
	return append(out, c.stuck...)
}

// cuBriefHarvest is the pre-cap shipped section this file expects, built off the
// run rows the store returned, with the distinct ref counts the numbers block
// owes. The assembler holds the same harvest behind an unexported function; the
// test re-derives it from the seeded envelopes rather than trusting the answer it
// is checking.
type cuBriefHarvest struct {
	rows []api.CatchUpBriefShipped
	// prs and commits are the DISTINCT refs behind those rows: the numbers block
	// counts refs, the section counts rows, and ADR-0081 says they are the same
	// fact stated twice.
	prs, commits int
}

func (c *cuBriefCapture) wantShipped() cuBriefHarvest {
	byRun := map[string][]api.CatchUpBriefRunNode{}
	order := []string{}
	for _, n := range c.nodes {
		if _, seen := byRun[n.RunID]; !seen {
			order = append(order, n.RunID)
		}
		byRun[n.RunID] = append(byRun[n.RunID], n)
	}
	out := cuBriefHarvest{}
	seenPR, seenSHA := map[string]bool{}, map[string]bool{}
	for _, runID := range order {
		rs := byRun[runID]
		title := strings.TrimSpace(rs[0].Title)
		if title == "" {
			title = rs[0].NodeKey
		}
		url, number, shas := "", 0, []string{}
		for _, n := range rs {
			u, num, list := cuEnvelopeRefs(n.Outputs)
			if u != "" && url == "" {
				url = u
			}
			if num != 0 && number == 0 {
				number = num
			}
			shas = append(shas, list...)
		}
		if len(shas) > 8 {
			shas = shas[:8] // the harvest's own bound, so the two counts cannot diverge
		}
		if url != "" || number > 0 {
			out.rows = append(out.rows, api.CatchUpBriefShipped{
				Kind: api.CatchUpShippedPR, Title: title,
				Ref: api.CatchUpBriefShippedRef{Number: number, URL: url},
			})
			id := url
			if id == "" {
				id = fmt.Sprintf("#%d", number)
			}
			if !seenPR[id] {
				seenPR[id] = true
				out.prs++
			}
		}
		hasPR := url != "" || number > 0
		for _, sha := range shas {
			// A PR run's commits ride on its PR row; only a run with no PR gets
			// commit rows of its own.
			if !hasPR {
				out.rows = append(out.rows, api.CatchUpBriefShipped{
					Kind: api.CatchUpShippedCommit, Title: title,
					Ref: api.CatchUpBriefShippedRef{SHA: sha},
				})
			}
			key := strings.ToLower(sha)
			if !seenSHA[key] {
				seenSHA[key] = true
				out.commits++
			}
		}
	}
	return out
}

func (c *cuBriefCapture) wantRows() []api.CatchUpBriefShipped { return c.wantShipped().rows }

// wantChanges is the pre-cap changes section: the profiles and members the store
// read, plus the published workflows the assembler folds in a second time.
func (c *cuBriefCapture) wantChanges() []api.CatchUpBriefChange {
	out := append([]api.CatchUpBriefChange{}, c.profiles...)
	out = append(out, c.members...)
	for _, rev := range c.revisions {
		out = append(out, api.CatchUpBriefChange{
			Kind: api.CatchUpChangePublished, Title: rev.Title, By: rev.By, At: rev.At, Link: rev.Link,
		})
	}
	return out
}

// allJSON is every row the store returned for this read, as one string to scan
// for a project the caller may not see.
func (c *cuBriefCapture) allJSON(t *testing.T) string {
	t.Helper()
	parts := []any{c.gates, c.questions, c.stuck, c.running, c.wantRows(), c.revisions,
		c.broke, c.profiles, c.members, c.items, c.numbers}
	var sb strings.Builder
	for _, p := range parts {
		sb.WriteString(cuBriefJSON(t, p))
	}
	return sb.String()
}

// cuEnvelopeRefs reads the pull request and the commit shas one output envelope
// names, on the key names the harvest reads. The seeded envelopes are flat, so
// this stays a flat read: anything the seeded world writes into `outputs` is
// covered here, and a nested envelope is not something the fixture produces.
func cuEnvelopeRefs(raw []byte) (url string, number int, shas []string) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", 0, nil
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", 0, nil
	}
	for k, v := range obj {
		switch value := v.(type) {
		case string:
			switch strings.ToLower(k) {
			case "pr_url", "pull_request_url", "pr", "pull_url":
				if url == "" && strings.HasPrefix(value, "http") {
					url = value
				}
			case "commit_sha", "sha", "head_sha", "commit":
				if len(value) >= 7 && len(value) <= 64 {
					shas = append(shas, value)
				}
			}
		case float64:
			n := int(value)
			if n <= 0 {
				continue
			}
			switch strings.ToLower(k) {
			case "pr_number", "pull_request_number", "pull_request":
				number = n
			}
		}
	}
	return url, number, shas
}

func cuBriefJSON(t *testing.T, v any) string {
	t.Helper()
	blob, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal the brief for scanning: %v", err)
	}
	return string(blob)
}

// --- the golden ---------------------------------------------------------------

var (
	goldenUUID  = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	goldenStamp = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`)
	goldenColor = regexp.MustCompile(`#[0-9a-f]{6}`)
	// goldenChipColor is one project chip: the colour line always follows the name
	// line, because the chip's fields are ordered id, name, color.
	goldenChipColor = regexp.MustCompile(`(?m)("name": "([^"]*)",(\s*)"color": ")#[0-9a-f]{6}(")`)
)

// cuBriefGolden writes the brief as the story it tells: every uuid becomes the
// token it earns on first appearance, every timestamp an age at the fixed clock,
// every colour and display name what a reader would call it. Two seeds of one
// window then have to write the same bytes — and a human has to read the result
// before it is committed.
func cuBriefGolden(t *testing.T, scenario cuScenario, brief api.CatchUpBrief,
	now time.Time, world cuBriefWorld) {
	t.Helper()
	path := filepath.Join("testdata", "catch_up_brief", string(scenario)+".golden.json")
	got := cuBriefNormalise(t, brief, now, world)
	if *updateBriefGoldens {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(got+"\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		t.Logf("rewrote %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("no golden at %s — run with -update, read what it says, and commit it", path)
	}
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	cuDiffLines(t, path, strings.TrimSuffix(string(want), "\n"), got)
}

func cuBriefNormalise(t *testing.T, brief api.CatchUpBrief, now time.Time,
	world cuBriefWorld) string {
	t.Helper()
	blob, err := json.MarshalIndent(brief, "", "  ")
	if err != nil {
		t.Fatalf("marshal the brief for the golden: %v", err)
	}
	out := string(blob)
	// A chip's colour is derived from its project id (domain.CatchUpProjectColorOr),
	// and the id is a fresh uuid every run, so the VALUE is only stable within one
	// seed: tokenising it by value would make the golden depend on which random
	// uuid came first. Each colour is therefore written as the project it belongs
	// to — and cuCheckChipColours is the assertion that a project has exactly one.
	out = goldenChipColor.ReplaceAllString(out, `${1}<colour of ${2}>${4}`)
	// Longest name first, so one username that is another's prefix cannot be
	// half-rewritten.
	names := make([]string, 0, len(world.names))
	for name := range world.names {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	for _, name := range names {
		out = strings.ReplaceAll(out, name, world.names[name])
	}
	out = goldenStamp.ReplaceAllStringFunc(out, func(stamp string) string {
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			t.Errorf("unparsable timestamp %q in the brief", stamp)
			return stamp
		}
		return cuBriefAge(now, at)
	})
	tokens := map[string]string{}
	out = goldenUUID.ReplaceAllStringFunc(out, func(id string) string {
		if tok, ok := tokens[id]; ok {
			return tok
		}
		tok := fmt.Sprintf("<id%d>", len(tokens)+1)
		tokens[id] = tok
		return tok
	})
	if left := goldenColor.FindString(out); left != "" {
		t.Errorf("a palette colour reached the golden unattributed: %s", left)
	}
	return out
}

// cuBriefAge is a timestamp the way the window sees it: "-9m" is nine minutes
// before the clock the brief was assembled at. A "+" would be a row from the
// future, which is the drift the seeder's own clock check hunts.
func cuBriefAge(now, at time.Time) string {
	d := now.Sub(at)
	if d == 0 {
		return "now"
	}
	sign := "-"
	if d < 0 {
		sign, d = "+", -d
	}
	var out string
	for _, u := range []struct {
		name string
		size time.Duration
	}{{"d", 24 * time.Hour}, {"h", time.Hour}, {"m", time.Minute}, {"s", time.Second}} {
		n := int(d / u.size)
		if n <= 0 {
			continue
		}
		d -= time.Duration(n) * u.size
		out += fmt.Sprintf("%d%s", n, u.name)
	}
	if out == "" {
		out = "0s"
	}
	return sign + out
}

func cuBriefSecondsFromNow(now, at time.Time) float64 { return now.Sub(at).Seconds() }

// cuBriefCap is ADR-0081's row cap per window: 5 for an hour or less, 8 for 6h and
// 24h, 10 for 2d, 7d and unseen.
func cuBriefCap(key string) int {
	switch key {
	case api.CatchUpWindowFifteenMin, api.CatchUpWindowOneHour:
		return 5
	case api.CatchUpWindowSixHour, api.CatchUpWindowDaily:
		return 8
	default:
		return 10
	}
}

func cuDiffLines(t *testing.T, path, want, got string) {
	t.Helper()
	wl, gl := strings.Split(want, "\n"), strings.Split(got, "\n")
	shown := 0
	report := func(format string, args ...any) {
		if shown >= 12 {
			return
		}
		shown++
		t.Errorf(format, args...)
		if shown == 12 {
			t.Errorf("%s: further differences suppressed", path)
		}
	}
	for i := range wl {
		switch {
		case i >= len(gl):
			report("%s line %d: the golden has %q and the brief has nothing", path, i+1, wl[i])
		case wl[i] != gl[i]:
			report("%s line %d:\n  golden: %s\n  brief:  %s", path, i+1, wl[i], gl[i])
		}
	}
	for i := len(wl); i < len(gl); i++ {
		report("%s line %d: the brief has %q and the golden nothing", path, i+1, gl[i])
	}
}

// --- small shared helpers -----------------------------------------------------

func cuUniqSorted(in []string) []string { return cuUniq(cuSorted(in)) }

func cuSorted(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}

func cuUniq(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func stringsContain(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
