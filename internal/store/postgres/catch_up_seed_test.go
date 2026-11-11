package postgres

// Test-only seeder for the Catch up windows (ADR-0078), built from the seeding
// map in docs/research/2026-11-catch-up-audit.md § 6: the organization comes
// from the migrations, users/projects/pipelines/revisions/runs/nodes/approvals
// are raw SQL with `<clock> - $n::interval`, and every catch-up row goes through
// the store, because the validators live there.
//
// Two rules keep a seeded history honest, and both are asserted by
// catch_up_seed_scenarios_test.go:
//
//   - Every timestamp derives from the `now` the caller passes rather than the
//     database clock, so a fixed `now` yields a fixed story. The interval style
//     is the audit's (`now() - $n::interval`); only its `now()` is the supplied
//     clock, which is the whole point of passing one.
//   - The DEFAULT now() columns audit § 6 lists as "a seeder must override" —
//     runs.created_at, node_executions.created_at, approval_requests.created_at,
//     catchup_work_items.created_at/updated_at, catchup_tour_versions.created_at,
//     catchup_work_item_runs.added_at, pipeline_revisions.published_at,
//     agent_profiles.created_at, memberships.created_at — are written on every
//     path. cuSeedFutureTimestamps fails a seed that let the real clock through.
//
// The seeder also RECORDS what it wrote (w.rows, w.items, w.approvals,
// w.published), and cuSeeded.Expect is computed from that record with the same
// window and membership rules the page uses. The scenario tests then re-derive
// the same numbers with their own SQL, so a seed that drifts from its own
// expectation — a row in the wrong project, a backdate that never landed, an
// item in a project the reader cannot see — fails loudly.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// cuScenario is one Catch up window with a realistic history behind it.
type cuScenario string

const (
	cuWindow15m cuScenario = "15m"
	cuWindow1h  cuScenario = "1h"
	cuWindow1d  cuScenario = "1d"
	cuWindow3d  cuScenario = "3d"
	cuWindow7d  cuScenario = "7d"
)

// window is how far back the scenario's story is meant to be visible.
func (s cuScenario) window() time.Duration {
	switch s {
	case cuWindow15m:
		return 15 * time.Minute
	case cuWindow1h:
		return time.Hour
	case cuWindow1d:
		return 24 * time.Hour
	case cuWindow3d:
		return 3 * 24 * time.Hour
	case cuWindow7d:
		return 7 * 24 * time.Hour
	}
	panic("unknown catch-up scenario " + string(s))
}

// The four logical projects of the fixture team. The reader is a member of the
// first three and of secret-ops NOT at all — the one project whose work must
// never reach their page, whoever seeds it.
const (
	cuPayments  = "payments-api"
	cuWebApp    = "web-app"
	cuInfra     = "infra"
	cuSecretOps = "secret-ops"
)

// cuReaderProjects names the projects the reader belongs to, in a stable order.
func cuReaderProjects() []string { return []string{cuPayments, cuWebApp, cuInfra} }

// cuExpect is what the seeded history should look like from the reader's side
// of the window: the run counts, and the titles the Catch up page is owed.
//
// Each title bucket has exactly one source, mirrored by cuReadBuckets:
//
//	NeedsYou     — a pending approval summary, or a work item awaiting its answer
//	RunningNow   — the title of a run that is still running
//	Shipped      — a work item whose shape is a pull request
//	StillFailing — a work item whose resolution is run_failed
//	Fixed        — an issue that closed merged (the bug story)
//	HeadsUp      — a work item with a must_know beat (auth, a migration, main)
//	Changes      — a pipeline revision published inside the window
//
// The classification is ordered, so every seeded item lands in exactly one.
type cuExpect struct {
	NeedsYou, RunningNow, Shipped, StillFailing, Fixed, HeadsUp, Changes      []string
	Succeeded, Failed, Cancelled, Running, ApprovalsPending, ApprovalsDecided int
}

// cuSeeded is the fixture a scenario test asserts against.
type cuSeeded struct {
	ReaderID, TeammateID string
	Projects             map[string]string // logical name -> project id
	Expect               cuExpect

	// world reaches the scaffolding the assertions need (pipeline ids, the
	// window's cutoff). The exported shape above is the task's API.
	world *cuWorld
}

// cutoff is the moment the scenario's window opens.
func (s cuSeeded) cutoff() time.Time { return s.world.now.Add(-s.world.scenario.window()) }

// projectIDs lists project ids in a stable order for the reads that take arrays.
func (s cuSeeded) visibleIDs() []string { return s.ids(cuReaderProjects()) }

// secretID is the project the reader may not see.
func (s cuSeeded) secretID() string { return s.Projects[cuSecretOps] }

func (s cuSeeded) ids(names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		id, ok := s.Projects[n]
		if !ok {
			panic("seeded scenario has no project " + n)
		}
		out = append(out, id)
	}
	return out
}

// --- the world ------------------------------------------------------------

type cuWorld struct {
	t        *testing.T
	f        *cnvFixture
	scenario cuScenario
	now      time.Time
	token    string

	reader, teammate string
	projects         map[string]string
	claude           string // the migration-seeded profile, for conversations
	repos            map[string]string
	pipelines        map[string]cuPipeline
	pipelineIDs      []string
	profileIDs       []string
	memberIDs        []string // extra users this world created

	// what was written, in the order it was written — the record Expect is
	// derived from.
	runs      []cuRunRow
	items     []cuItemRow
	approvals []cuApprovalRow
	published []cuPublishRow
}

type cuPipeline struct {
	id          string
	displayName string
	revisionID  string
	digest      string // revision_digest
	planDigest  string
}

type cuRunRow struct {
	project, title, status string
	ago                    time.Duration // finished_at age, else started_at age
}

type cuItemRow struct {
	project, title string
	shape          domain.CatchUpShape
	resolution     domain.CatchUpResolution
	mustKnow       bool
	asks           bool
	ago            time.Duration // the item's updated_at age
}

type cuApprovalRow struct {
	project, summary, state string
	ago                     time.Duration
}

type cuPublishRow struct {
	project, label string
	ago            time.Duration
}

// cuClock is a fixed "now" for a scenario: a round date, so a seeded timestamp
// is readable in a failure message and identical across runs.
func cuClock() time.Time { return time.Date(2026, time.November, 5, 12, 0, 0, 0, time.UTC) }

// cuInterval renders a duration as a PostgreSQL interval literal. Every backdate
// in this file is `<clock> - $n::interval` with one of these as $n, so ages stay
// in the SQL where audit § 6 puts them.
func cuInterval(d time.Duration) string {
	return fmt.Sprintf("%d seconds", int64(d.Round(time.Second)/time.Second))
}

// cuWorldNew builds the team, the four projects and one pipeline per project,
// and registers the teardown. Teardown is registered here (not per insert)
// because it runs LIFO, before cnvFixture's own cleanup, which is the only
// reason the shared fixture never has to know this world existed.
func cuWorldNew(t *testing.T, f *cnvFixture, s cuScenario, now time.Time) *cuWorld {
	t.Helper()
	w := &cuWorld{
		t: t, f: f, scenario: s, now: now,
		token:     migFixtureToken(t),
		reader:    f.alice,
		teammate:  f.bob,
		projects:  map[string]string{},
		pipelines: map[string]cuPipeline{},
		repos:     map[string]string{},
	}
	t.Cleanup(w.delete)

	w.claude = f.profile // 'Claude Code', seeded by migration 00003

	// The reader maintains two projects and contributes to a third; the teammate
	// maintains all of them plus secret-ops, which the reader is not in. A
	// non-member who is not a member of anything would prove nothing about the
	// membership predicate, so secret-ops has a real failure and a real story.
	for _, name := range cuReaderProjects() {
		w.projects[name] = w.project(name, w.reader)
	}
	w.projects[cuSecretOps] = w.project(cuSecretOps, w.teammate)

	w.seedMember(cuPayments, w.reader, "maintainer", 8*24*time.Hour)
	w.seedMember(cuPayments, w.teammate, "maintainer", 8*24*time.Hour)
	w.seedMember(cuWebApp, w.reader, "maintainer", 8*24*time.Hour)
	w.seedMember(cuWebApp, w.teammate, "contributor", 8*24*time.Hour)
	w.seedMember(cuInfra, w.reader, "contributor", 8*24*time.Hour)
	w.seedMember(cuInfra, w.teammate, "maintainer", 8*24*time.Hour)
	w.seedMember(cuSecretOps, w.teammate, "maintainer", 8*24*time.Hour)

	for _, name := range []string{cuPayments, cuWebApp, cuInfra, cuSecretOps} {
		w.repo(name)
		w.mainPipeline(name)
	}
	return w
}

func (w *cuWorld) exec(q string, args ...any) {
	w.t.Helper()
	if _, err := w.f.pool.Exec(testCtx(w.t), q, args...); err != nil {
		w.t.Fatalf("seed exec %q: %v", q, err)
	}
}

func (w *cuWorld) queryRow(q string, args ...any) string {
	w.t.Helper()
	var out string
	if err := w.f.pool.QueryRow(testCtx(w.t), q, args...).Scan(&out); err != nil {
		w.t.Fatalf("seed query %q: %v", q, err)
	}
	return out
}

// project inserts one project of the organization.
func (w *cuWorld) project(name, createdBy string) string {
	w.t.Helper()
	return w.queryRow(`
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'cu-' || $2 || '-' || $3, $2, $4::uuid)
		RETURNING id::text`, w.f.orgID, name, w.token, createdBy)
}

// repo inserts the project's GitHub repository — the remote a PR number in a run
// output points at (audit § 6 item 2).
func (w *cuWorld) repo(project string) string {
	w.t.Helper()
	if id, ok := w.repos[project]; ok {
		return id
	}
	id := w.queryRow(`
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, 'acme/' || $2, 'https://github.com/acme/' || $2 || '.git', 'main', $3::uuid)
		RETURNING id::text`, w.projects[project], project, w.teammate)
	w.repos[project] = id
	return id
}

// mainPipeline returns the project's pipeline, creating it with its first
// published revision on first use. Runs pin whatever revision is current when
// they are seeded, exactly as the assignment does in production.
func (w *cuWorld) mainPipeline(project string) cuPipeline {
	w.t.Helper()
	if p, ok := w.pipelines[project]; ok {
		return p
	}
	p := cuPipeline{displayName: project + " CI"}
	pipe, err := (&PipelineStore{Pool: w.f.pool}).CreatePipeline(testCtx(w.t), w.f.orgID,
		w.reader, "cu-main-"+w.token+"-"+strings.ReplaceAll(project, ".", "-"), p.displayName,
		"Seeded by the catch-up window fixtures")
	if err != nil {
		w.t.Fatalf("create pipeline for %s: %v", project, err)
	}
	p.id = pipe.ID
	w.pipelineIDs = append(w.pipelineIDs, p.id)
	w.pipelines[project] = p
	p.revisionID, p.digest, p.planDigest = w.publish(p, "1.0.0", 8*24*time.Hour, w.teammate)
	w.pipelines[project] = p
	return p
}

// publish walks the real publish path (draft -> validation -> revision, the way
// m4Fixture does) and then backdates published_at, which the insert path can
// only ever set to now().
func (w *cuWorld) publish(p cuPipeline, label string, publishedAgo time.Duration,
	by string) (id, digest, planDigest string) {
	w.t.Helper()
	ctx := testCtx(w.t)
	ps := &PipelineStore{Pool: w.f.pool}
	digest = m4Digest("cu-rev/" + w.token + "/" + p.displayName + "/" + label)
	planDigest = m4Digest("cu-plan/" + digest)
	doc := fmt.Sprintf("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# %s\n", digest)
	canonical := json.RawMessage(fmt.Sprintf(
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, digest))
	draft, err := ps.CreateDraft(ctx, NewDraft{
		PipelineID: p.id, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("cu-src/" + digest), EditedBy: by,
	})
	if err != nil {
		w.t.Fatalf("create draft %s %s: %v", p.displayName, label, err)
	}
	if _, err := ps.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: canonical, RevisionDigest: digest,
		CompiledPlan: json.RawMessage(`{"nodes":[]}`), PlanDigest: planDigest,
		Validation: json.RawMessage(`[]`),
	}); err != nil {
		w.t.Fatalf("validate draft %s %s: %v", p.displayName, label, err)
	}
	rev, err := ps.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: label, DocumentText: doc,
		SchemaDigest: m4Digest("cu-schema"), CelEnvDigest: m4Digest("cu-celenv"),
		PublishedBy: by, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		w.t.Fatalf("publish %s %s: %v", p.displayName, label, err)
	}
	w.exec(`UPDATE pipeline_revisions SET published_at = $1::timestamptz - $2::interval
	        WHERE id = $3::uuid`, w.now, cuInterval(publishedAgo), rev.ID)
	return rev.ID, digest, planDigest
}

// --- the seeding helpers --------------------------------------------------

// seedRun inserts one run of the project's main pipeline, backdating created_at
// (always 45s before it started), started_at and — for a terminal status only —
// finished_at. runs_terminal_timestamped is the constraint that makes "running"
// a run with no finish rather than a lie about one.
func (w *cuWorld) seedRun(project, title, status string, startedAgo,
	finishedAgo time.Duration, triggeredBy string) string {
	w.t.Helper()
	p := w.mainPipeline(project)
	var ago = startedAgo
	switch status {
	case "completed", "failed", "cancelled", "interrupted":
		ago = finishedAgo
	}
	var id string
	err := w.f.pool.QueryRow(testCtx(w.t), `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  status, failed_cause, title, repository_id, triggered_by,
		                  created_at, started_at, finished_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
		        $7,
		        CASE WHEN $7 IN ('failed','interrupted') THEN $8 ELSE NULL END,
		        $9, $10::uuid, $11::uuid,
		        $12::timestamptz - $13::interval,
		        $12::timestamptz - $14::interval,
		        CASE WHEN $7 IN ('completed','failed','cancelled','interrupted')
		             THEN $12::timestamptz - $15::interval ELSE NULL END)
		RETURNING id::text`,
		w.f.orgID, w.projects[project], p.id, p.revisionID, p.digest, p.planDigest,
		status, "agent_error", title, w.repo(project), cuNullUUID(triggeredBy),
		w.now, cuInterval(ago+45*time.Second), cuInterval(startedAgo),
		cuInterval(finishedAgo)).Scan(&id)
	if err != nil {
		w.t.Fatalf("seed %s run %q: %v", status, title, err)
	}
	w.runs = append(w.runs, cuRunRow{project: project, title: title, status: status, ago: ago})
	return id
}

// seedRoutineRun is filler: a completed run with one succeeded node and nothing
// a returning engineer would stop for.
func (w *cuWorld) seedRoutineRun(project, title string, ago time.Duration) string {
	w.t.Helper()
	run := w.seedRun(project, title, "completed", ago+4*time.Minute, ago, w.teammate)
	w.seedNode(run, "/implement", "succeeded", "", nil, ago)
	return run
}

// seedNode inserts one node execution of a run — the place a failure's
// error_class and a finished run's refs (branch, pr_url, pr_number, commit_sha)
// live, since that is what RunFacts harvests (audit § 6 item 6).
func (w *cuWorld) seedNode(runID, key, status, errorClass string, outputs map[string]any,
	finishedAgo time.Duration) string {
	w.t.Helper()
	raw, err := json.Marshal(outputs)
	if err != nil {
		w.t.Fatalf("encode node outputs for %s: %v", key, err)
	}
	var id string
	err = w.f.pool.QueryRow(testCtx(w.t), `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key, scope_key,
		                             execution_location, status, outputs, error_class,
		                             failed_cause, waiting_reason, attempt_count,
		                             created_at, ready_at, finished_at)
		VALUES ($1::uuid, $2, $3, $4, '/', 'worker', $5,
		        CASE WHEN $6::text = '{}' THEN NULL ELSE $6::jsonb END,
		        NULLIF($7, ''),
		        CASE WHEN $5 = 'failed' THEN NULLIF($7, '') ELSE NULL END,
		        CASE WHEN $5 = 'waiting' THEN 'approval' ELSE NULL END,
		        1,
		        $8::timestamptz - $9::interval,
		        $8::timestamptz - ($9::interval + interval '30 seconds'),
		        CASE WHEN $5 IN ('succeeded','failed','skipped','cancelled','interrupted')
		             THEN $8::timestamptz - $9::interval ELSE NULL END)
		RETURNING id::text`,
		runID, cuNodeID(key), cuNodeKind(key), key, status, string(raw), errorClass,
		w.now, cuInterval(finishedAgo)).Scan(&id)
	if err != nil {
		w.t.Fatalf("seed %s node %s: %v", status, key, err)
	}
	return id
}

// seedApproval inserts one approval request, creating the gate node its UNIQUE
// (node_execution_id) demands. `state` is 'pending' or 'decided'; decided rows
// carry the approver and the moment they answered, which is what puts an
// approval on either side of "you" vs "somebody already handled it".
func (w *cuWorld) seedApproval(runID, project, summary, state string, createdAgo time.Duration,
	decidedBy string) string {
	w.t.Helper()
	// The gate node is 'waiting' with waiting_reason 'approval' — the shape the
	// schema uses for a node a human owes an answer to.
	key := fmt.Sprintf("/approve_gate[%d]", len(w.approvals)+1)
	node := w.seedNode(runID, key, "waiting", "", nil, createdAgo)
	var id string
	err := w.f.pool.QueryRow(testCtx(w.t), `
		INSERT INTO approval_requests (organization_id, project_id, run_id, node_execution_id,
		                               kind, summary, approver_roles, deadline_at, on_timeout,
		                               state, decision, comments, decided_by, decided_at,
		                               created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'pipeline_gate', $5, '{maintainer}',
		        $6::timestamptz - $7::interval + interval '3 days', 'expire',
		        $8,
		        CASE WHEN $8 = 'decided' THEN 'approved' ELSE NULL END,
		        CASE WHEN $8 = 'decided' THEN 'Ship it.' ELSE NULL END,
		        CASE WHEN $8 = 'decided' THEN $9::uuid ELSE NULL END,
		        CASE WHEN $8 = 'decided'
		             THEN $6::timestamptz - $7::interval + interval '10 minutes' ELSE NULL END,
		        $6::timestamptz - $7::interval)
		RETURNING id::text`,
		w.f.orgID, w.projects[project], runID, node, summary, w.now,
		cuInterval(createdAgo), state, cuNullUUID(decidedBy)).Scan(&id)
	if err != nil {
		w.t.Fatalf("seed %s approval %q: %v", state, summary, err)
	}
	w.approvals = append(w.approvals,
		cuApprovalRow{project: project, summary: summary, state: state, ago: createdAgo})
	return id
}

// seedRevision publishes a NEW revision of a project's pipeline inside the
// window — the "the pipeline changed under you" entry (Expect.Changes).
func (w *cuWorld) seedRevision(project, label string, publishedAgo time.Duration,
	by string) string {
	w.t.Helper()
	p := w.mainPipeline(project)
	p.revisionID, p.digest, p.planDigest = w.publish(p, label, publishedAgo, by)
	w.pipelines[project] = p
	w.published = append(w.published,
		cuPublishRow{project: project, label: label, ago: publishedAgo})
	return p.revisionID
}

// seedProfile creates an agent profile — "a new agent joined the team" — with a
// backdated created_at, which the insert path cannot give.
func (w *cuWorld) seedProfile(name, launcher string, createdAgo time.Duration) string {
	w.t.Helper()
	var id string
	err := w.f.pool.QueryRow(testCtx(w.t), `
		INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode)
		VALUES ($1::uuid, $2, $3, 'ask')
		ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id::text`, w.f.orgID, name, launcher).Scan(&id)
	if err != nil {
		w.t.Fatalf("seed profile %q: %v", name, err)
	}
	w.exec(`UPDATE agent_profiles SET created_at = $1::timestamptz - $2::interval
	        WHERE id = $3::uuid`, w.now, cuInterval(createdAgo), id)
	w.profileIDs = append(w.profileIDs, id)
	return id
}

// seedMember adds a person to a project and backdates the join, so "a new
// member" is a fact about the window rather than about when the test ran.
func (w *cuWorld) seedMember(project, user, role string, joinedAgo time.Duration) {
	w.t.Helper()
	w.exec(`
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		w.projects[project], user, role)
	w.exec(`UPDATE memberships SET created_at = $1::timestamptz - $2::interval
	        WHERE project_id = $3::uuid AND user_id = $4::uuid`,
		w.now, cuInterval(joinedAgo), w.projects[project], user)
}

// cuNewUser creates a person in the organization and registers their teardown —
// by id, never by name pattern, the rule cnvUser follows.
func (w *cuWorld) cuNewUser(name string) string {
	w.t.Helper()
	id := w.queryRow(`
		INSERT INTO users (organization_id, display_name)
		VALUES ($1::uuid, $2) RETURNING id::text`, w.f.orgID, name+"-"+w.token)
	w.memberIDs = append(w.memberIDs, id)
	return id
}

// cuNewConversation inserts a manual conversation (control row included, the way
// crossproject_test does). A decision beat only survives with a thread to answer
// in, which is why an asks=true story needs one — and both rows are backdated,
// because a thread that began after the story it holds is the drift the clock
// check below looks for.
func (w *cuWorld) cuNewConversation(project, title, by string, ago time.Duration) string {
	w.t.Helper()
	id := w.queryRow(`
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by,
		                           created_at, updated_at)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid,
		        $5::timestamptz - $6::interval, $5::timestamptz - $6::interval)
		RETURNING id::text`,
		w.projects[project], w.claude, title, by, w.now, cuInterval(ago))
	w.exec(`INSERT INTO conversation_control (conversation_id, controller_kind,
	                                        controller_user_id, acquired_at, updated_at)
	        VALUES ($1::uuid, 'human', $2::uuid, $3::timestamptz - $4::interval,
	                $3::timestamptz - $4::interval)`, id, by, w.now, cuInterval(ago))
	return id
}

// --- catch-up rows through the store --------------------------------------

type cuItemSpec struct {
	project    string
	by         string // the author: must be a member of `project`
	title      string
	summary    string
	shape      domain.CatchUpShape
	resolution domain.CatchUpResolution
	ago        time.Duration
	runID      string // claimed by the tour version, "" = work no single run owns
	refPRs     []int
	refCommits []string
	refs       []string // issue numbers rendered into the summary, kept simple
	importance domain.CatchUpImportance
	kind       string // the beat's kind label (FOUND / CAUSE / FIXED / MIGRATION ...)
	decision   *domain.CatchUpDecision
	convID     string
}

// seedItem writes one work item and the tour version that tells it — through the
// store, never raw SQL, so the item obeys the same validators the generator
// obeys — and then backdates the four timestamps audit § 6 says a seeder must
// override: the item's created_at/updated_at (updated_at IS the window clock),
// the version's created_at (compared against runs.finished_at by the candidate
// read) and the claim's added_at.
func (w *cuWorld) seedItem(in cuItemSpec) string {
	w.t.Helper()
	importance := in.importance
	if importance == "" {
		importance = domain.CatchUpImportanceRoutine
	}
	summary := in.summary
	if summary == "" {
		summary = "Seeded catch-up fixture for the " + string(w.scenario) + " window."
	}
	shape := in.shape
	if shape == "" {
		shape = domain.CatchUpShapePR
	}
	resolution := in.resolution
	if resolution == "" {
		resolution = domain.CatchUpResolutionMerged
	}
	by := in.by
	if by == "" {
		by = w.reader
	}
	item := domain.CatchUpWorkItem{
		ProjectID: w.projects[in.project], Shape: shape, Title: in.title, Summary: summary,
		Resolution: resolution,
		Refs: domain.CatchUpRefs{
			PRNumbers: in.refPRs, CommitSHAs: in.refCommits, RunIDs: in.refs,
		},
	}
	if run := in.runID; run != "" {
		item.SourceRunID = &run
	}
	if conv := in.convID; conv != "" {
		item.ConversationID = &conv
	}
	stops := []domain.CatchUpStop{{
		ID: "the-work", Title: in.title, Kind: in.kind, Importance: importance,
		Narrative: summary, Decision: in.decision,
	}}
	if len(in.refPRs) > 0 {
		stops = append(stops, cuStop("refs", "evidence", domain.CatchUpImportanceRoutine, 0))
	}

	written := cuItemLike(w.t, w.f, by, item)
	// The generator's path claims the run it tells; the thread's path tells work
	// no single run owns (ADR-0078 § Grouping), which is what a still-running
	// piece of work or an ask without a run behind it is.
	if in.runID == "" {
		cuAppend(w.t, w.f, by, written, "The story as it stands now.", stops...)
	} else {
		cuAppendRun(w.t, w.f, by, written, in.runID, "The story as it stands now.", stops...)
	}
	w.exec(`
		UPDATE catchup_work_items SET created_at = $1::timestamptz - $2::interval,
		                              updated_at = $1::timestamptz - $2::interval
		WHERE id = $3::uuid`, w.now, cuInterval(in.ago), written)
	w.exec(`
		UPDATE catchup_tour_versions SET created_at = $1::timestamptz - $2::interval
		WHERE work_item_id = $3::uuid`, w.now, cuInterval(in.ago), written)
	w.exec(`
		UPDATE catchup_work_item_runs SET added_at = $1::timestamptz - $2::interval
		WHERE work_item_id = $3::uuid`, w.now, cuInterval(in.ago), written)

	mustKnow := false
	asks := false
	for _, s := range stops {
		if s.Importance == domain.CatchUpImportanceMustKnow {
			mustKnow = true
		}
		if s.Decision != nil {
			asks = true
		}
	}
	w.items = append(w.items, cuItemRow{
		project: in.project, title: in.title, shape: shape, resolution: resolution,
		mustKnow: mustKnow, asks: asks, ago: in.ago,
	})
	return written
}

// cuItemLike is cuItem from catch_up_test.go with the project and the fields the
// window scenarios need: that helper is pinned to the fixture's own project.
func cuItemLike(t *testing.T, f *cnvFixture, user string, in domain.CatchUpWorkItem) string {
	t.Helper()
	item, err := cuStore(f).UpsertWorkItem(testCtx(t), f.caller(user), in)
	if err != nil {
		t.Fatalf("upsert seeded work item %q: %v", in.Title, err)
	}
	if item.ID == "" {
		t.Fatalf("upsert seeded work item %q returned no id — is %s a member?", in.Title, user)
	}
	return item.ID
}

// --- what was written, read back as an expectation -------------------------

// seeded computes the fixture's own account of the window: everything the world
// inserted that is (a) in a project the reader belongs to and (b) inside the
// scenario's window. The classification order below is cuBucketSQL's, mirrored
// on purpose — the scenario test then checks that the rows agree with it.
func (w *cuWorld) seeded() cuSeeded {
	win := w.scenario.window()
	visible := map[string]bool{}
	for _, name := range cuReaderProjects() {
		visible[name] = true
	}

	var exp cuExpect
	for _, r := range w.runs {
		if !visible[r.project] || r.ago > win {
			continue
		}
		switch r.status {
		case "completed":
			exp.Succeeded++
		case "failed":
			exp.Failed++
		case "cancelled":
			exp.Cancelled++
		case "running":
			exp.Running++
			exp.RunningNow = append(exp.RunningNow, r.title)
		case "waiting_human": // an approval's run: counted under approvals, not here
		default:
			w.t.Errorf("seeded run %q has status %q the expectation cannot count", r.title, r.status)
		}
	}
	for _, a := range w.approvals {
		if !visible[a.project] || a.ago > win {
			continue
		}
		switch a.state {
		case "pending":
			exp.ApprovalsPending++
			exp.NeedsYou = append(exp.NeedsYou, a.summary)
		case "decided":
			exp.ApprovalsDecided++
		}
	}
	for _, it := range w.items {
		if !visible[it.project] || it.ago > win {
			continue
		}
		switch {
		case it.mustKnow:
			exp.HeadsUp = append(exp.HeadsUp, it.title)
		case it.resolution == domain.CatchUpResolutionRunFailed:
			exp.StillFailing = append(exp.StillFailing, it.title)
		case it.asks:
			exp.NeedsYou = append(exp.NeedsYou, it.title)
		case it.resolution == domain.CatchUpResolutionOpen ||
			it.resolution == domain.CatchUpResolutionBranchReady:
			exp.NeedsYou = append(exp.NeedsYou, it.title)
		case it.shape == domain.CatchUpShapeIssue &&
			it.resolution == domain.CatchUpResolutionMerged:
			exp.Fixed = append(exp.Fixed, it.title)
		case it.shape == domain.CatchUpShapePR || it.shape == domain.CatchUpShapePush:
			exp.Shipped = append(exp.Shipped, it.title)
		default:
			w.t.Errorf("seeded work item %q falls in no expectation bucket", it.title)
		}
	}
	for _, p := range w.published {
		if !visible[p.project] || p.ago > win {
			continue
		}
		exp.Changes = append(exp.Changes, w.pipelines[p.project].displayName+" "+p.label)
	}
	sortStrings(&exp)
	return cuSeeded{
		ReaderID: w.reader, TeammateID: w.teammate,
		Projects: copyProjects(w.projects), Expect: exp, world: w,
	}
}

// storyTitles is the same window filter applied to the work items alone: what the
// membership-scoped list read is owed, and the only thing it can be owed — a run
// title, an approval summary or a published revision has no story until a tour
// tells it.
func (w *cuWorld) storyTitles() []string {
	win := w.scenario.window()
	visible := map[string]bool{}
	for _, name := range cuReaderProjects() {
		visible[name] = true
	}
	out := []string{}
	for _, it := range w.items {
		if visible[it.project] && it.ago <= win {
			out = append(out, it.title)
		}
	}
	sort.Strings(out)
	return out
}

// fingerprintScope is the id array the fingerprint's pipeline- and profile-shaped
// reads take: pipelines and profiles share the same parameter, and both lists are
// ids only this world made.
func (w *cuWorld) fingerprintScope() []string {
	out := append([]string{}, w.pipelineIDs...)
	return append(out, w.profileIDs...)
}

func sortStrings(e *cuExpect) {
	for _, s := range []*[]string{
		&e.NeedsYou, &e.RunningNow, &e.Shipped, &e.StillFailing,
		&e.Fixed, &e.HeadsUp, &e.Changes,
	} {
		sort.Strings(*s)
	}
}

func copyProjects(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// --- teardown -------------------------------------------------------------

// delete removes what this world made, children before parents. Every name is
// derived from w.token, and the deletes are by id, so a concurrent fixture in
// the same tree cannot be reached by them.
func (w *cuWorld) delete() {
	bg := context.Background()
	projects := make([]string, 0, len(w.projects))
	for _, name := range []string{cuPayments, cuWebApp, cuInfra, cuSecretOps} {
		if id, ok := w.projects[name]; ok {
			projects = append(projects, id)
		}
	}
	runs := "SELECT id FROM runs WHERE project_id = ANY($1::uuid[])"
	steps := []struct {
		sql  string
		args []any
	}{
		{"DELETE FROM approval_requests WHERE run_id IN (" + runs + ")", []any{projects}},
		// pgx binds by placeholder number, so a statement that names $1 twice still
		// takes one argument.
		{"DELETE FROM pipeline_invocations WHERE run_id IN (" + runs + ")" +
			" OR child_run_id IN (" + runs + ")", []any{projects}},
		{"DELETE FROM run_inputs WHERE run_id IN (" + runs + ")", []any{projects}},
		{"DELETE FROM attempts WHERE run_id IN (" + runs + ")", []any{projects}},
		{"DELETE FROM node_executions WHERE run_id IN (" + runs + ")", []any{projects}},
		{"DELETE FROM conversation_control WHERE conversation_id IN" +
			" (SELECT id FROM conversations WHERE project_id = ANY($1::uuid[]))", []any{projects}},
		{"DELETE FROM conversations WHERE project_id = ANY($1::uuid[])", []any{projects}},
		{"DELETE FROM runs WHERE project_id = ANY($1::uuid[])", []any{projects}},
		// The draft -> revision pointer is circular, exactly as in m4Fixture's
		// teardown, so it is cleared before either table can lose a row.
		{"UPDATE pipeline_drafts SET published_revision_id = NULL" +
			" WHERE pipeline_id = ANY($1::uuid[])", []any{w.pipelineIDs}},
		{"DELETE FROM pipeline_revisions WHERE pipeline_id = ANY($1::uuid[])",
			[]any{w.pipelineIDs}},
		{"DELETE FROM pipeline_drafts WHERE pipeline_id = ANY($1::uuid[])", []any{w.pipelineIDs}},
		{"DELETE FROM pipelines WHERE id = ANY($1::uuid[])", []any{w.pipelineIDs}},
		{"DELETE FROM repositories WHERE project_id = ANY($1::uuid[])", []any{projects}},
		{"DELETE FROM memberships WHERE project_id = ANY($1::uuid[])", []any{projects}},
		{"DELETE FROM projects WHERE id = ANY($1::uuid[])", []any{projects}},
		{"DELETE FROM agent_profiles WHERE id = ANY($1::uuid[])", []any{w.profileIDs}},
		{"DELETE FROM users WHERE id = ANY($1::uuid[])", []any{w.memberIDs}},
	}
	for _, s := range steps {
		if len(s.args) > 0 {
			if list, ok := s.args[0].([]string); ok && len(list) == 0 {
				continue
			}
		}
		if _, err := w.f.pool.Exec(bg, s.sql, s.args...); err != nil {
			w.t.Errorf("seed cleanup %q: %v", s.sql, err)
		}
	}
}

// --- small shared shapes --------------------------------------------------

// cuNullUUID turns "" into a NULL for an `$n::uuid` parameter.
func cuNullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// cuNodeID derives the node_id column from an instance key: the last path
// segment, iteration suffix removed, in the shape the CHECK demands.
func cuNodeID(key string) string {
	segs := strings.Split(strings.TrimPrefix(key, "/"), "/")
	last := segs[len(segs)-1]
	if i := strings.IndexByte(last, '['); i >= 0 {
		last = last[:i]
	}
	return strings.NewReplacer("-", "_", ".", "_").Replace(last)
}

// cuNodeKind is a catalogue name for a seeded node, from the set the other
// store tests already use.
func cuNodeKind(key string) string {
	switch cuNodeID(key) {
	case "approve_gate", "check_gate":
		return "condition"
	case "invoke":
		return "pipeline.invoke"
	default:
		return "agent.acp"
	}
}

// cuOutputs is a readable way to write a node's outputs at a call site.
func cuOutputs(kv ...any) map[string]any {
	out := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		out[fmt.Sprint(kv[i])] = kv[i+1]
	}
	return out
}

// cuAsk is the one stop shape the Catch up page treats as a question: a beat
// with a decision, which only survives on an item that has a thread (audit § 6
// item 8; internal/api/catch_up.go Asks = st.Decision != nil).
func cuAsk(prompt string, options ...string) *domain.CatchUpDecision {
	return &domain.CatchUpDecision{Prompt: prompt, Options: options, AllowText: true}
}
