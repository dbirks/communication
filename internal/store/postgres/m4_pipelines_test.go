package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// m4_* tests: constraint BEHAVIOUR on a database that actually ran 00005
// (docs/m4-contract.md § 1's table), in the migrate_test.go idiom ADR-0016
// established — every assertion is "this write fails with this code", and a
// write that SUCCEEDS is reported as the bug it is. A green mock proves
// nothing here.

// m4Digest derives a sha256:-prefixed hex digest from a label, so fixture
// digests are distinct where the test needs distinct and identical where it
// needs identical (the double-publish case), without committing secrets or
// random bytes.
func m4Digest(label string) string {
	sum := sha256.Sum256([]byte("communication-m4-fixture/" + label))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func m4Hex(label string) string {
	sum := sha256.Sum256([]byte("communication-m4-fixture/" + label))
	return hex.EncodeToString(sum[:])
}

// m4Fixture seeds everything a run row needs to exist — org, user, project,
// pipeline, one published revision (via the real PipelineStore publish path,
// so the tests exercise the adapter as much as the schema) — plus a live
// worker. Cleanup unwinds children before parents.
type m4Fixture struct {
	pool       *pgxpool.Pool
	pipelines  *PipelineStore
	runs       *RunStore
	orgID      string
	userID     string
	projectID  string
	pipelineID string
	revisionID string
	digest     string // the published revision's revision_digest
	planDigest string
}

func m4Setup(t *testing.T) *m4Fixture {
	t.Helper()
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	return m4SetupShared(t, ctx, pool)
}

// m4SetupShared builds the fixture on an already-opened pool (claim-race
// tests need two stores over the same database).
func m4SetupShared(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *m4Fixture {
	t.Helper()
	token := migFixtureToken(t)
	f := &m4Fixture{
		pool:       pool,
		pipelines:  &PipelineStore{Pool: pool},
		runs:       &RunStore{Pool: pool},
		digest:     m4Digest("rev/" + token),
		planDigest: m4Digest("plan/" + token),
	}
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&f.orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name)
		VALUES ($1, 'm4-user-' || $2) RETURNING id`, f.orgID, token).Scan(&f.userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'm4-proj-' || $2, 'M4 fixture', $3) RETURNING id`, f.orgID, token, f.userID).
		Scan(&f.projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	pipe, err := f.pipelines.CreatePipeline(ctx, f.orgID, f.userID, "m4-pipe-"+token, "M4 pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	f.pipelineID = pipe.ID
	f.revisionID = f.publishRevision(t, ctx, "1.0.0", f.digest)

	t.Cleanup(func() {
		bg := context.Background()
		steps := []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM secret_materializations WHERE attempt_id IN
				(SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = $1)`,
				[]any{f.projectID}},
			{`UPDATE conversation_turns SET node_attempt_id = NULL WHERE node_attempt_id IN
				(SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM run_checkpoints WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM approval_requests WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM pipeline_invocations WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)
			   OR child_run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM attempts WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM node_executions WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM run_idempotency_keys WHERE project_id = $1`, []any{f.projectID}},
			{`DELETE FROM outbox WHERE global_seq IN
				(SELECT global_seq FROM domain_events WHERE run_id IN
					(SELECT id FROM runs WHERE project_id = $1))`,
				[]any{f.projectID}},
			{`DELETE FROM domain_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM run_inputs WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)`,
				[]any{f.projectID}},
			{`DELETE FROM workspaces WHERE project_id = $1`, []any{f.projectID}},
			// runs self-reference through parent_run_id: children first,
			// deepest level first, so no delete ever strands a parent.
			{`DELETE FROM runs WHERE project_id = $1 AND depth = 2`, []any{f.projectID}},
			{`DELETE FROM runs WHERE project_id = $1 AND depth = 1`, []any{f.projectID}},
			{`DELETE FROM runs WHERE project_id = $1 AND depth = 0`, []any{f.projectID}},
			{`DELETE FROM assignments WHERE project_id = $1`, []any{f.projectID}},
			// The draft->revision pointer is circular, so it is cleared
			// before either table can lose its rows.
			{`UPDATE pipeline_drafts SET published_revision_id = NULL WHERE pipeline_id = $1`,
				[]any{f.pipelineID}},
			{`DELETE FROM pipeline_revisions WHERE pipeline_id = $1`, []any{f.pipelineID}},
			{`DELETE FROM pipeline_drafts WHERE pipeline_id = $1`, []any{f.pipelineID}},
			{`DELETE FROM pipelines WHERE id = $1`, []any{f.pipelineID}},
			{`DELETE FROM conversation_turns WHERE conversation_id IN
				(SELECT id FROM conversations WHERE project_id = $1)`, []any{f.projectID}},
			{`DELETE FROM conversations WHERE project_id = $1`, []any{f.projectID}},
			{`DELETE FROM projects WHERE id = $1`, []any{f.projectID}},
			{`DELETE FROM users WHERE id = $1`, []any{f.userID}},
		}
		for _, step := range steps {
			if _, err := pool.Exec(bg, step.sql, step.args...); err != nil {
				t.Errorf("cleanup %q: %v", step.sql, err)
			}
		}
	})
	return f
}

// publishRevision runs the real draft -> validate -> publish path for a
// distinct document and returns the revision id.
func (f *m4Fixture) publishRevision(t *testing.T, ctx context.Context, versionLabel, revisionDigest string) string {
	t.Helper()
	doc := fmt.Sprintf("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# %s\n", revisionDigest)
	canonical := json.RawMessage(fmt.Sprintf(
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, revisionDigest))
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("src/" + revisionDigest), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: canonical, RevisionDigest: revisionDigest,
		CompiledPlan: json.RawMessage(`{"nodes":[]}`),
		PlanDigest:   m4Digest("plan-of/" + revisionDigest),
		Validation:   json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: versionLabel, DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
		PublishedBy: f.userID, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	return rev.ID
}

// m4Worker registers an online worker with the given capacity.
func m4Worker(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string, capacity int) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status, capacity)
		VALUES ('m4-' || $1 || '-' || $2, 'lab', 'contract-test', 'online', $3) RETURNING id`,
		tag, migFixtureToken(t), capacity).Scan(&id); err != nil {
		t.Fatalf("insert worker: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// Unwind the attempt-side references before the row can go: the
		// boundary checkpoints point at attempts, the attempts hold the
		// lease triple, and run affinity points here too.
		if _, err := pool.Exec(bg,
			`DELETE FROM run_checkpoints WHERE attempt_id IN (SELECT id FROM attempts WHERE worker_id = $1)`, id); err != nil {
			t.Errorf("cleanup checkpoints by worker: %v", err)
		}
		if _, err := pool.Exec(bg,
			`UPDATE conversation_turns SET node_attempt_id = NULL WHERE node_attempt_id IN (SELECT id FROM attempts WHERE worker_id = $1)`, id); err != nil {
			t.Errorf("cleanup turn stamps by worker: %v", err)
		}
		if _, err := pool.Exec(bg,
			"DELETE FROM attempts WHERE worker_id = $1", id); err != nil {
			t.Errorf("cleanup attempts by worker: %v", err)
		}
		if _, err := pool.Exec(bg,
			"UPDATE runs SET worker_affinity = NULL, worker_volume_id = NULL WHERE worker_affinity = $1", id); err != nil {
			t.Errorf("clear run affinity by worker: %v", err)
		}
		// Fixture workspaces are pinned to a worker (ADR-0017: one worker per
		// workspace), so the row must go before this worker can.
		if _, err := pool.Exec(bg,
			`DELETE FROM workspace_repos WHERE workspace_id IN (SELECT id FROM workspaces WHERE worker_id = $1)`, id); err != nil {
			t.Errorf("cleanup workspace repos by worker: %v", err)
		}
		if _, err := pool.Exec(bg,
			"DELETE FROM workspaces WHERE worker_id = $1", id); err != nil {
			t.Errorf("cleanup workspaces by worker: %v", err)
		}
		if _, err := pool.Exec(bg, "DELETE FROM workers WHERE id = $1", id); err != nil {
			t.Errorf("cleanup worker: %v", err)
		}
	})
	return id
}

// m4QueuedRun creates a run pinned to the fixture revision and moves it to
// 'running', returning its id (the claim predicate demands r.status =
// 'running').
func (f *m4Fixture) m4QueuedRun(t *testing.T, ctx context.Context, parentRunID string, depth int) string {
	t.Helper()
	run, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID, Depth: depth, ParentRunID: parentRunID,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if _, err := f.runs.SetRunStatus(ctx, run.ID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("start run: %v", err)
	}
	return run.ID
}

// m4WorkerNode seeds a ready worker-kind node execution with one queued
// attempt.
func (f *m4Fixture) m4WorkerNode(t *testing.T, ctx context.Context, runID, key string) (string, string) {
	t.Helper()
	node, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: runID, NodeID: strings.Split(key, "/")[1], Kind: "agent.acp",
		NodeInstanceKey: key, ExecutionLocation: "worker",
	})
	if err != nil {
		t.Fatalf("InsertNodeExecution %s: %v", key, err)
	}
	if _, err := f.runs.SetNodeStatus(ctx, node.ID, NodeStatusInput{Status: "ready"}); err != nil {
		t.Fatalf("ready node %s: %v", key, err)
	}
	attempt, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: node.ID, AttemptNumber: 1})
	if err != nil {
		t.Fatalf("QueueAttempt for %s: %v", key, err)
	}
	return node.ID, attempt.ID
}

// TestMigrate0005SchemaShape proves 00005 applied its structural changes on
// top of 00001-00004 rather than merely reporting success: the widened M2/M3
// tables gained exactly the promised columns and the new tables exist.
func TestMigrate0005SchemaShape(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	tables := []string{"pipelines", "pipeline_drafts", "pipeline_revisions", "assignments",
		"runs", "run_inputs", "node_executions", "attempts", "run_checkpoints",
		"approval_requests", "pipeline_invocations", "run_idempotency_keys"}
	for _, tbl := range tables {
		var exists bool
		if err := pool.QueryRow(ctx,
			"SELECT to_regclass($1) IS NOT NULL", "public."+tbl).Scan(&exists); err != nil {
			t.Fatalf("check table %s: %v", tbl, err)
		}
		if !exists {
			t.Errorf("table %s missing after 00005", tbl)
		}
	}
	columns := []struct{ table, column string }{
		{"conversation_turns", "node_attempt_id"},
		{"workers", "capacity"},
		{"workers", "active_attempts"},
		{"domain_events", "run_id"},
		{"domain_events", "node_execution_id"},
		{"domain_events", "attempt_id"},
		{"pipeline_drafts", "published_revision_id"},
	}
	for _, c := range columns {
		var exists bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM pg_attribute
				WHERE attrelid = $1::regclass AND attname = $2 AND attnum > 0)`,
			c.table, c.column).Scan(&exists); err != nil {
			t.Fatalf("check column %s.%s: %v", c.table, c.column, err)
		}
		if !exists {
			t.Errorf("column %s.%s missing after 00005", c.table, c.column)
		}
	}
	// ADR-0018's reserved lifecycle finally has a unit to attach to.
	var fk bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pg_constraint
			WHERE conname = 'secret_materializations_attempt_fk')`).Scan(&fk); err != nil {
		t.Fatalf("check secret_materializations FK: %v", err)
	}
	if !fk {
		t.Error("secret_materializations_attempt_fk missing: node_attempt lifecycle is unanchored")
	}
}

// TestMigrate0005DraftConstraints proves the draft is bounded where the
// contract says it is (256 KiB document, closed status enum) and that the
// real publish path refuses a stale CAS and a non-valid draft.
func TestMigrate0005DraftConstraints(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_drafts (pipeline_id, document_text, source_sha256, edited_by)
		VALUES ($1, repeat('x', 262145), $2, $3)`,
		f.pipelineID, m4Hex("oversize"), f.userID); err == nil {
		t.Error("draft with a 256 KiB + 1 byte document accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("oversize document code = %s, want 23514", code)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_drafts (pipeline_id, document_text, source_sha256, edited_by, status)
		VALUES ($1, 'kind: Pipeline', $2, $3, 'promoted')`,
		f.pipelineID, m4Hex("bad-status"), f.userID); err == nil {
		t.Error("draft with an out-of-vocabulary status accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("bad status code = %s, want 23514", code)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_drafts (pipeline_id, document_text, source_sha256, edited_by)
		VALUES ($1, '', $2, $3)`,
		f.pipelineID, m4Hex("empty-doc"), f.userID); err == nil {
		t.Error("empty draft document accepted (length bound is BETWEEN 1 AND …)")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("empty document code = %s, want 23514", code)
	}

	// Publish requires the draft to be at status='valid' and at the CAS
	// version the caller last saw.
	fresh, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: "kind: Pipeline\n",
		SourceSHA256: m4Hex("cas-src"), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.PublishDraft(ctx, fresh.ID, NewRevision{
		VersionLabel: "1.0.0", DocumentText: "kind: Pipeline\n",
		SchemaDigest: m4Digest("s"), CelEnvDigest: m4Digest("c"),
		PublishedBy: f.userID, ExpectedDraftVersion: 1,
	}); !errors.Is(err, ErrDraftNotPublishable) {
		t.Errorf("publish of an unvalidated draft = %v, want ErrDraftNotPublishable", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, fresh.ID, "valid", DraftValidation{
		CanonicalDocument: json.RawMessage(`{"kind":"Pipeline"}`),
		RevisionDigest:    m4Digest("cas-rev"),
		CompiledPlan:      json.RawMessage(`{"nodes":[]}`),
		PlanDigest:        m4Digest("cas-plan"),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	if _, err := f.pipelines.PublishDraft(ctx, fresh.ID, NewRevision{
		VersionLabel: "2.5.1", DocumentText: "kind: Pipeline\n",
		SchemaDigest: m4Digest("s"), CelEnvDigest: m4Digest("c"),
		PublishedBy: f.userID, ExpectedDraftVersion: 11,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("publish with a stale CAS version = %v, want ErrConflict", err)
	}
	// Replacing the document on the now-published fixture draft is refused:
	// published drafts are immutable.
	pub := f.publishedDraftID(t, ctx)
	if _, err := f.pipelines.ReplaceDraftDocument(ctx, pub, "kind: Pipeline\n# edited\n",
		m4Hex("after-publish"), nil, 99, f.userID); !errors.Is(err, ErrConflict) {
		t.Errorf("edit of a published draft = %v, want ErrConflict", err)
	}
}

// publishedDraftID finds the fixture's published draft (the publish path
// leaves exactly one per revision).
func (f *m4Fixture) publishedDraftID(t *testing.T, ctx context.Context) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		SELECT id FROM pipeline_drafts
		WHERE pipeline_id = $1::uuid AND status = 'published' LIMIT 1`, f.pipelineID).Scan(&id); err != nil {
		t.Fatalf("find published draft: %v", err)
	}
	return id
}

// TestMigrate0005DoublePublishRejected is the 09 rule "Published revision
// hash unique in organization" on a database that ran 00005: publishing a
// byte-identical document twice in one org is refused, via the adapter and
// via raw SQL, and the same digest in ANOTHER org is fine (the index is
// org-scoped, not global).
func TestMigrate0005DoublePublishRejected(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)

	// A second pipeline, same organization, same canonical document: the
	// publish must fail with ErrConflict (the API turns that into 409
	// revision_already_published carrying the existing revision id).
	other, err := f.pipelines.CreatePipeline(ctx, f.orgID, f.userID, "m4-twin-"+migFixtureToken(t), "twin", "")
	if err != nil {
		t.Fatalf("CreatePipeline twin: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		f.pool.Exec(bg, `DELETE FROM pipeline_drafts WHERE pipeline_id = $1::uuid`, other.ID)
		f.pool.Exec(bg, `DELETE FROM pipelines WHERE id = $1::uuid`, other.ID)
	})
	doc := "apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n"
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: other.ID, DocumentText: doc, SourceSHA256: m4Hex("twin-src"), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft twin: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: json.RawMessage(fmt.Sprintf(
			`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, f.digest)),
		RevisionDigest: f.digest, // the fixture revision's digest, verbatim
		CompiledPlan:   json.RawMessage(`{"nodes":[]}`),
		PlanDigest:     f.planDigest,
	}); err != nil {
		t.Fatalf("RecordValidation twin: %v", err)
	}
	if _, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "1.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("s"), CelEnvDigest: m4Digest("c"),
		PublishedBy: f.userID, ExpectedDraftVersion: 1,
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("double publish accepted; err = %v, want ErrConflict", err)
	}
	// The schema-level fact, independently of the adapter:
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_revisions
			(pipeline_id, draft_id, organization_id, revision_number, version_label,
			 api_version, canonical_document, document_text, revision_digest,
			 compiled_plan, plan_digest, schema_digest, cel_env_digest, published_by)
		VALUES ($1::uuid, (SELECT id FROM pipeline_drafts WHERE pipeline_id = $1::uuid LIMIT 1),
		        $2::uuid, 42, '9.9.9', 'communication.dev/v1alpha1', '{}'::jsonb, 'x', $3,
		        '{}'::jsonb, $4, $5, $6, $7::uuid)`,
		f.pipelineID, f.orgID, f.digest, f.planDigest, m4Digest("s"), m4Digest("c"), f.userID); err == nil {
		t.Fatal("duplicate (organization_id, revision_digest) accepted by the DB")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("double publish code = %s, want 23505", code)
	}

	// Second revision_number on the SAME pipeline: also 23505 (there is no
	// update path, so re-numbering cannot be an implicit overwrite).
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO pipeline_revisions
			(pipeline_id, draft_id, organization_id, revision_number, version_label,
			 api_version, canonical_document, document_text, revision_digest,
			 compiled_plan, plan_digest, schema_digest, cel_env_digest, published_by)
		VALUES ($1::uuid, (SELECT id FROM pipeline_drafts WHERE pipeline_id = $1::uuid LIMIT 1),
		        $2::uuid, 1, '7.7.7', 'communication.dev/v1alpha1', '{}'::jsonb, 'x', $3,
		        '{}'::jsonb, $4, $5, $6, $7::uuid)`,
		f.pipelineID, f.orgID, m4Digest("rev-number-clash"), m4Digest("p2"), m4Digest("s"), m4Digest("c"), f.userID); err == nil {
		t.Error("duplicate (pipeline_id, revision_number) accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate revision_number code = %s, want 23505", code)
	}
}

// TestMigrate0005ControlPlaneNeverLeased is the CHECK named by ADR-0023 § 3:
// control-plane work that cannot occupy a lease, enforced by Postgres for
// both the INSERT and the state move, on leased AND running.
func TestMigrate0005ControlPlaneNeverLeased(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	runID := f.m4QueuedRun(t, ctx, "", 0)

	for _, status := range []string{"leased", "running"} {
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
			                             execution_location, status, ready_at)
			VALUES ($1::uuid, 'check_gate', 'condition', '/check_gate', 'control_plane', $2, now())`,
			runID, status); err == nil {
			t.Errorf("control_plane node inserted with status=%s", status)
		} else if code := migPgCode(t, err); code != "23514" {
			t.Errorf("control_plane insert %s code = %s, want 23514", status, code)
		}
	}
	// The state move from a legal row is refused too (this is the advancer's
	// actual failure mode).
	var nodeID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, ready_at)
		VALUES ($1::uuid, 'check_gate', 'condition', '/check_gate', 'control_plane', 'ready', now())
		RETURNING id`, runID).Scan(&nodeID); err != nil {
		t.Fatalf("insert control_plane node ready: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE node_executions SET status = 'leased', ready_at = now() WHERE id = $1`, nodeID); err == nil {
		t.Error("control_plane node moved to leased")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("control_plane update code = %s, want 23514", code)
	}
	// And the store names the same refusal before Postgres is reached.
	if _, err := f.runs.SetNodeStatus(ctx, nodeID, NodeStatusInput{Status: "running"}); err == nil ||
		!strings.Contains(err.Error(), "control_plane_never_leased") {
		t.Errorf("SetNodeStatus(running) on a control-plane node = %v, want the named refusal", err)
	}
	// Worker-kind rows may still lease: the CHECK is about the location, not
	// about the status vocabulary.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, ready_at)
		VALUES ($1::uuid, 'implement', 'agent.acp', '/implement', 'worker', 'leased', now())`,
		runID); err != nil {
		t.Errorf("worker-kind leased node refused: %v", err)
	}
	// Terminal node without finished_at: 23514.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, finished_at)
		VALUES ($1::uuid, 'x1', 'process.exec', '/x1', 'worker', 'succeeded', NULL)`,
		runID); err == nil {
		t.Error("succeeded node without finished_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("terminal node without finished_at code = %s, want 23514", code)
	}
	// Non-pending without ready_at: 23514.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, ready_at)
		VALUES ($1::uuid, 'x2', 'process.exec', '/x2', 'worker', 'ready', NULL)`,
		runID); err == nil {
		t.Error("ready node without ready_at accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("ready without ready_at code = %s, want 23514", code)
	}
	// The loop/fan-out identity: two rows for one key in one run.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status)
		VALUES ($1::uuid, 'review', 'agent.acp', '/build_until_verified[2]/review', 'worker', 'pending')`,
		runID); err != nil {
		t.Fatalf("insert first scoped node: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status)
		VALUES ($1::uuid, 'review', 'agent.acp', '/build_until_verified[2]/review', 'worker', 'pending')`,
		runID); err == nil {
		t.Error("two node executions for /build_until_verified[2]/review accepted")
	} else if code := migPgCode(t, err); code != "23505" {
		t.Errorf("duplicate node_instance_key code = %s, want 23505", code)
	}
	// Key grammar: a positional index disguised as a key, and a bad node_id.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status)
		VALUES ($1::uuid, 'review', 'agent.acp', 'implement', 'worker', 'pending')`,
		runID); err == nil {
		t.Error("node_instance_key without the leading path shape accepted")
	} else if code := migPgCode(t, err); code != "23514" {
		t.Errorf("bad node_instance_key code = %s, want 23514", code)
	}
}
