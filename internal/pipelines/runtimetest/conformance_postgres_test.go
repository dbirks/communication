package runtimetest

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/store/postgres"
)

// TestConformance_Postgres runs the SAME suite as TestConformance_MemStore —
// including the boundary rollback arms and the DualInstance subtest —
// against postgres.RuntimeStore on a real database (docs/m4-contract.md § 5,
// § 8; AGENTS.md: a mocked green test never substitutes for the real
// integration layer). There is no in-process state to verify "against":
// pgSession.State hydrates from the ledger rows themselves, so every
// assertion in subtests.go and dual_instance.go reads domain_events,
// node_executions, attempts, approval_requests and run_checkpoints.
func TestConformance_Postgres(t *testing.T) {
	base := os.Getenv("COMMUNICATION_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("COMMUNICATION_TEST_DATABASE_URL not set")
	}
	ConformanceTests(t, conformDatabase(t, base))
}

// conformDatabase creates one throwaway database off the harness URL for a
// whole ConformanceTests invocation; every Open/OpenPair then resets its
// schema and re-migrates, so no subtest inherits rows, sequences or journal
// position from another (the -count=2 isolation claim).
func conformDatabase(t *testing.T, baseURL string) *pgFactory {
	t.Helper()
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("database-name entropy: %v", err)
	}
	name := "communication_conform_" + hex.EncodeToString(b[:])
	conformURL, err := withDatabaseName(baseURL, name)
	if err != nil {
		t.Fatalf("derive conformance database URL: %v", err)
	}
	ctx := context.Background()
	maint, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatalf("connect harness database: %v", err)
	}
	if _, err := maint.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		_ = maint.Close(ctx)
		t.Fatalf("create %s: %v", name, err)
	}
	if err := maint.Close(ctx); err != nil {
		t.Logf("close harness connection: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), baseURL)
		if err != nil {
			t.Errorf("cleanup connect: %v", err)
			return
		}
		defer c.Close(context.Background())
		if _, err := c.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("cleanup drop %s: %v", name, err)
		}
	})
	return &pgFactory{url: conformURL}
}

// withDatabaseName re-points a postgres URL at another database, keeping the
// credentials and every query parameter intact. The name is generated
// lowercase hex, never operator input.
func withDatabaseName(baseURL, dbname string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%q is not a postgres URL", baseURL)
	}
	q := u.Query()
	q.Del("database")
	u.RawQuery = q.Encode()
	u.Path = "/" + dbname
	return u.String(), nil
}

// pgFactory implements Factory (and DualFactory) over postgres.RuntimeStore.
// Identities need no registration: the adapter resolves names to uuids
// through a pure function, so the factory seeds exactly the rows
// RuntimeIdentity(name) says the adapter will reference.
type pgFactory struct {
	url   string
	opens atomic.Int64
}

// Open implements Factory: fresh schema, seeded identities, a published
// revision through the real draft → validate → publish path, a run row
// through the real RunStore, and ONE store instance for one subtest.
func (f *pgFactory) Open(t *testing.T, cfg Config) Session {
	t.Helper()
	env := f.prepare(t, cfg)
	return newPGSession(t, env, env.storeOne)
}

// OpenPair implements DualFactory: the same prepared run inside TWO store
// instances on TWO pools — the two-API-replica shape of contract § 5.
func (f *pgFactory) OpenPair(t *testing.T, cfg Config) (Session, Session) {
	t.Helper()
	env := f.prepare(t, cfg)
	env.poolTwo = env.mustPool(t)
	env.storeTwo = postgres.NewRuntimeStore(env.poolTwo, env.adv)
	env.storeTwo.Now = env.nowFn
	env.storeTwo.Lease = env.lease
	return newPGSession(t, env, env.storeOne), newPGSession(t, env, env.storeTwo)
}

// pgEnv is one prepared conformance run: the shared driven clock, the pools
// and stores, and the two run identities every session agrees on.
type pgEnv struct {
	t     *testing.T
	ctx   context.Context
	url   string
	adv   *runtime.Advancer
	prog  *runtime.Program
	clock sync.Mutex
	now   time.Time
	nowFn func() time.Time
	setAt func(time.Time)
	lease time.Duration

	poolOne, poolTwo   *pgxpool.Pool
	storeOne, storeTwo *postgres.RuntimeStore

	runID    string
	identity map[string]string // seeded name -> uuid
}

var conformNames = []string{"alice", "bob", "mallory", WorkerA, WorkerB, WorkerC, "ws1"}

func (f *pgFactory) prepare(t *testing.T, cfg Config) *pgEnv {
	t.Helper()
	ctx := t.Context()
	f.resetSchema(ctx, t)

	env := &pgEnv{t: t, ctx: ctx, url: f.url}
	env.now = cfg.Start
	if env.now.IsZero() {
		env.now = Epoch
	}
	env.nowFn = func() time.Time {
		env.clock.Lock()
		defer env.clock.Unlock()
		return env.now
	}
	env.setAt = func(at time.Time) {
		env.clock.Lock()
		defer env.clock.Unlock()
		env.now = at
	}
	env.lease = DefaultLease
	if cfg.Lease > 0 {
		env.lease = cfg.Lease
	}

	env.prog = preparePlan(t, cfg.Pipeline)
	env.adv = &runtime.Advancer{Prog: env.prog, Deps: cfg.Deps}
	env.poolOne = env.mustPool(t)
	t.Cleanup(func() {
		if env.poolOne != nil {
			env.poolOne.Close()
		}
		if env.poolTwo != nil {
			env.poolTwo.Close()
		}
	})
	env.storeOne = postgres.NewRuntimeStore(env.poolOne, env.adv)
	env.storeOne.Now = env.nowFn
	env.storeOne.Lease = env.lease

	// Deterministic identities (no registry: pure function of the name).
	env.identity = map[string]string{}
	for _, name := range conformNames {
		env.identity[name] = postgres.RuntimeIdentity(name)
	}

	var orgID string
	if err := env.poolOne.QueryRow(ctx, `SELECT id FROM organizations WHERE slug = 'default'`).Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	alice := env.identity["alice"]
	for _, name := range []string{"alice", "bob", "mallory"} {
		if _, err := env.poolOne.Exec(ctx,
			`INSERT INTO users (id, organization_id, display_name) VALUES ($1::uuid, $2::uuid, $3)`,
			env.identity[name], orgID, "conform-"+name); err != nil {
			t.Fatalf("seed user %s: %v", name, err)
		}
	}
	// workers.name is globally unique; the schema reset per Open is what
	// keeps the fixture names free (one conformance run at a time).
	for _, name := range []string{WorkerA, WorkerB, WorkerC} {
		if _, err := env.poolOne.Exec(ctx,
			`INSERT INTO workers (id, name, hostname, version, status) VALUES ($1::uuid, $2, 'lab', 'conformance', 'online')`,
			env.identity[name], name); err != nil {
			t.Fatalf("seed worker %s: %v", name, err)
		}
	}
	n := f.opens.Add(1)
	var projectID string
	if err := env.poolOne.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, $2, 'Conformance', $3::uuid) RETURNING id`,
		orgID, fmt.Sprintf("conform-proj-%d", n), alice).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	// The published revision the run pins, through the real publish path.
	// The compiled plan is the REAL plan the advancer drives (runs.
	// plan_snapshot stays honest); the revision digests are conformance
	// fingerprints — the digest-scope pipeline is the revision slice's own
	// certified concern, not this store's.
	pipelines := &postgres.PipelineStore{Pool: env.poolOne}
	pipe, err := pipelines.CreatePipeline(ctx, orgID, alice, fmt.Sprintf("conform-pipe-%d", n), "Conformance pipe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	planJSON, err := json.Marshal(env.prog.Plan())
	if err != nil {
		t.Fatalf("marshal compiled plan: %v", err)
	}
	docText := fmt.Sprintf("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# %s\n", cfg.Pipeline)
	revDigest, planDigest := conformDigest(fmt.Sprintf("revision-%d", n)), conformDigest(fmt.Sprintf("plan-%d", n))
	draft, err := pipelines.CreateDraft(ctx, postgres.NewDraft{
		PipelineID: pipe.ID, DocumentText: docText, SourceKind: "manual",
		SourceSHA256: conformHex(fmt.Sprintf("source-%d", n)), EditedBy: alice,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := pipelines.RecordValidation(ctx, draft.ID, "valid", postgres.DraftValidation{
		CanonicalDocument: json.RawMessage(fmt.Sprintf(
			`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","name":%q}`, string(cfg.Pipeline))),
		RevisionDigest: revDigest,
		CompiledPlan:   json.RawMessage(planJSON),
		PlanDigest:     planDigest,
		Validation:     json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := pipelines.PublishDraft(ctx, draft.ID, postgres.NewRevision{
		VersionLabel: "1.0.0", DocumentText: docText,
		SchemaDigest: conformDigest("schema"), CelEnvDigest: conformDigest("celenv"),
		PublishedBy: alice, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}

	runs := &postgres.RunStore{Pool: env.poolOne}
	inputs := cfg.Inputs
	if inputs == nil {
		inputs = defaultInputs()
	}
	runInputs := map[string]postgres.RunInput{}
	for name, v := range inputs {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("encode input %q: %v", name, err)
		}
		runInputs[name] = postgres.RunInput{Value: raw, Origin: "submitted"}
	}
	run, created, err := runs.CreateRun(ctx, postgres.NewRun{
		OrganizationID: orgID, ProjectID: projectID,
		PipelineID: pipe.ID, PipelineRevisionID: rev.ID,
		RevisionDigest: revDigest, PlanDigest: planDigest,
		PlanSnapshot: json.RawMessage(planJSON), PoliciesSnapshot: json.RawMessage(`{}`),
		Inputs: runInputs,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !created {
		t.Fatalf("CreateRun reported not-created for a fresh schema")
	}
	env.runID = run.ID

	// The run workspace every checkpoint row points at (run_checkpoints.
	// workspace_id is an FK; ADR-0017's volume identity is a digest).
	if _, err := env.poolOne.Exec(ctx, `
		INSERT INTO workspaces
			(id, organization_id, project_id, scope_kind, run_id, worker_id,
			 volume_id, root_path, state, ready_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'run', $4::uuid, $5::uuid,
		        $6, '/var/lib/communication/conformance/ws1', 'ready', now())`,
		env.identity["ws1"], orgID, projectID, run.ID, env.identity[WorkerA],
		conformDigest("volume")); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	return env
}

// mustPool opens a second pool over the conformance database.
func (e *pgEnv) mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := postgres.Open(e.ctx, e.url)
	if err != nil {
		t.Fatalf("postgres.Open: %v", err)
	}
	return pool
}

// resetSchema makes the database fresh: drop the public schema (and the
// goose version table with it) and replay every migration. A conformance
// Open never inherits rows, sequences or journal position.
func (f *pgFactory) resetSchema(ctx context.Context, t *testing.T) {
	t.Helper()
	conn, err := pgx.Connect(ctx, f.url)
	if err != nil {
		t.Fatalf("conformance database unreachable: %v", err)
	}
	_, err = conn.Exec(ctx, `
		DROP TABLE IF EXISTS goose_db_version CASCADE;
		DROP SCHEMA IF EXISTS public CASCADE;
		CREATE SCHEMA public`)
	if closeErr := conn.Close(ctx); closeErr != nil {
		t.Logf("close reset connection: %v", closeErr)
	}
	if err != nil {
		t.Fatalf("reset schema: %v", err)
	}
	if err := postgres.Migrate(ctx, f.url); err != nil {
		t.Fatalf("migrate conformance schema: %v", err)
	}
}

// pgSession is one conformance run inside the Postgres store. It implements
// AtomicBoundary: the boundary commits or rolls back as one Postgres
// transaction — the rollback arm is asserted against a real ROLLBACK.
//
// The session keeps a DISPLAY-ONLY state view for the harness's
// pointer-stable assertions (subtests hold an *Approval across Decide
// calls). The view is rebuilt from hydrated rows after every operation and
// every read — it is a projection of the ledger, not the store's truth: the
// store itself keeps nothing (runtimestore.go), and the view has no
// authority to answer a Transact. Seeded identity uuids render back as the
// harness names so fenced-worker assertions read as "worker-a".
type pgSession struct {
	t      *testing.T
	env    *pgEnv
	rs     *postgres.RuntimeStore
	runID  string
	view   *runtime.State
	names  map[string]string // uuid -> seeded name (display only)
	closed bool
}

func newPGSession(t *testing.T, env *pgEnv, rs *postgres.RuntimeStore) *pgSession {
	t.Helper()
	s := &pgSession{t: t, env: env, rs: rs, runID: env.runID, names: map[string]string{}}
	for name, uuid := range env.identity {
		s.names[uuid] = name
	}
	return s
}

func (s *pgSession) BoundaryIsAtomic() bool     { return true }
func (s *pgSession) RunID() string              { return s.runID }
func (s *pgSession) Store() runtime.Store       { return s.rs }
func (s *pgSession) Program() *runtime.Program  { return s.env.prog }
func (s *pgSession) Now() time.Time             { return s.env.nowFn() }
func (s *pgSession) SetNow(at time.Time)        { s.env.setAt(at) }
func (s *pgSession) Advance() error             { return s.rs.Advance(s.env.ctx, s.runID) }
func (s *pgSession) NextDue() (time.Time, bool) { return s.rs.NextDue(s.env.ctx, s.runID) }

func (s *pgSession) Claim(workerID string) (*runtime.Attempt, error) {
	a, err := s.rs.Claim(s.env.ctx, s.runID, workerID)
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, nil
	}
	s.refresh()
	for _, v := range s.view.Attempts {
		if v.ID == a.ID {
			return v, nil
		}
	}
	s.t.Fatalf("claimed attempt %s is not in the ledger's own row set", a.ID)
	return nil, nil
}

func (s *pgSession) Start(attemptID, workerID string, token int64) error {
	err := s.rs.Start(s.env.ctx, s.runID, attemptID, workerID, token)
	s.refresh()
	return err
}

func (s *pgSession) Renew(attemptID, workerID string, token int64) error {
	err := s.rs.Renew(s.env.ctx, s.runID, attemptID, workerID, token)
	s.refresh()
	return err
}

func (s *pgSession) Complete(attemptID, workerID string, token int64, c Completion) error {
	err := s.rs.Complete(s.env.ctx, s.runID, attemptID, workerID, token,
		c.Outputs, c.OutputsDigest, c.ArtifactRefs, c.Outcome, c.Checkpoint)
	s.refresh()
	return err
}

func (s *pgSession) Fail(attemptID, workerID string, token int64, class, detail string) error {
	err := s.rs.Fail(s.env.ctx, s.runID, attemptID, workerID, token, class, detail, nil)
	s.refresh()
	return err
}

func (s *pgSession) Interrupt(attemptID, reason string) error {
	err := s.rs.Interrupt(s.env.ctx, s.runID, attemptID, reason)
	s.refresh()
	return err
}

func (s *pgSession) ReconcileLeases() error {
	err := s.rs.ReconcileLeases(s.env.ctx, s.runID)
	s.refresh()
	return err
}

func (s *pgSession) ReconcileDeadlines() error {
	err := s.rs.ReconcileDeadlines(s.env.ctx, s.runID)
	s.refresh()
	return err
}

func (s *pgSession) InterruptWorkspaceLost() error {
	err := s.rs.InterruptWorkspaceLost(s.env.ctx, s.runID)
	s.refresh()
	return err
}

func (s *pgSession) Decide(d GateDecision) error {
	err := s.rs.Decide(s.env.ctx, s.runID, d.ApprovalID, d.Decision, d.Comments, d.Decider, d.Version, d.Authorize)
	s.refresh()
	return err
}

func (s *pgSession) Retry(requestedBy string, targets []string, overrides map[string]any) error {
	err := s.rs.Retry(s.env.ctx, s.runID, requestedBy, targets, overrides)
	s.refresh()
	return err
}

func (s *pgSession) State(t *testing.T) *runtime.State {
	t.Helper()
	s.refresh()
	return s.view
}

func (s *pgSession) Events(t *testing.T) []pevents.Record {
	t.Helper()
	s.refresh()
	return snapshot(s.view.Events)
}

// refresh re-hydrates the run from the ledger and merges it INTO the view's
// existing row pointers (identity is the uuid; subtests keep pointers from
// an earlier read and expect them to carry the current row). This is a
// read-back of the committed truth — the dual-instance convergence check in
// dual_instance.go compares two independently refreshed views.
func (s *pgSession) refresh() {
	st, err := s.rs.Read(s.env.ctx, s.runID)
	if err != nil {
		s.t.Fatalf("hydrate run %s: %v", s.runID, err)
	}
	s.display(st)
	if s.view == nil {
		s.view = st
		return
	}
	*s.view.Run = *st.Run
	s.view.Nodes = mergeNodes(s.view.Nodes, st.Nodes)
	s.view.Attempts = mergeAttempts(s.view.Attempts, st.Attempts)
	s.view.Approvals = mergeApprovals(s.view.Approvals, st.Approvals)
	s.view.Checkpoints = st.Checkpoints
	s.view.Invocations = st.Invocations
	s.view.Events = st.Events
}

// mergeNodes copies fresh values into the pointers the harness already holds
// and keeps the fresh order, so both a pointer kept from an old State(t)
// read and the row set itself always speak the current ledger state.
func mergeNodes(view, fresh []*runtime.NodeExecution) []*runtime.NodeExecution {
	byID := map[string]*runtime.NodeExecution{}
	for _, v := range view {
		byID[v.ID] = v
	}
	out := make([]*runtime.NodeExecution, 0, len(fresh))
	for _, f := range fresh {
		if old, ok := byID[f.ID]; ok {
			*old = *f
			out = append(out, old)
			continue
		}
		out = append(out, f)
	}
	return out
}

func mergeAttempts(view, fresh []*runtime.Attempt) []*runtime.Attempt {
	byID := map[string]*runtime.Attempt{}
	for _, v := range view {
		byID[v.ID] = v
	}
	out := make([]*runtime.Attempt, 0, len(fresh))
	for _, f := range fresh {
		if old, ok := byID[f.ID]; ok {
			*old = *f
			out = append(out, old)
			continue
		}
		out = append(out, f)
	}
	return out
}

func mergeApprovals(view, fresh []*runtime.Approval) []*runtime.Approval {
	byID := map[string]*runtime.Approval{}
	for _, v := range view {
		byID[v.ID] = v
	}
	out := make([]*runtime.Approval, 0, len(fresh))
	for _, f := range fresh {
		if old, ok := byID[f.ID]; ok {
			*old = *f
			out = append(out, old)
			continue
		}
		out = append(out, f)
	}
	return out
}

// display renders seeded identity uuids back as the harness's names (the
// fence still lives on the uuid — this projection is what lets a test read
// "worker-a" off an attempt row).
func (s *pgSession) display(st *runtime.State) {
	if name, ok := s.names[st.Run.WorkerAffinity]; ok {
		st.Run.WorkerAffinity = name
	}
	for _, a := range st.Attempts {
		if name, ok := s.names[a.WorkerID]; ok {
			a.WorkerID = name
		}
	}
	for _, ap := range st.Approvals {
		if name, ok := s.names[ap.DecidedBy]; ok {
			ap.DecidedBy = name
		}
	}
	for i, c := range st.Checkpoints {
		if name, ok := s.names[c.WorkerID]; ok {
			c.WorkerID = name
		}
		if name, ok := s.names[c.WorkspaceID]; ok {
			c.WorkspaceID = name
		}
		st.Checkpoints[i] = c
	}
}

// conformDigest derives a § 1 CHECK-shaped sha256: digest from a label.
func conformDigest(label string) string {
	sum := sha256.Sum256([]byte("runtimetest-conformance/" + label))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// conformHex is conformDigest without the prefix, for the bare-hex CHECKs.
func conformHex(label string) string {
	sum := sha256.Sum256([]byte("runtimetest-conformance/" + label))
	return hex.EncodeToString(sum[:])
}
