package postgres

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/secrets"
	"github.com/dbirks/communication/internal/worker"
)

// Contract § 4 step 4: the `node_attempt` arm of secret_mounts.lifecycle — the
// arm 00004 reserved and 00005 anchored with a foreign key — is finally read by
// somebody. These run against the real database because the claims are database
// claims: that the lifecycle predicate selects the attempt's mounts and only
// those, that the profile allowlist (not the caller's good intentions) decides
// who receives the value, that secret_materializations.attempt_id is the attempt
// that held it, and that cleanup closes the row.

// nodeAttemptSecretFixture is secFixture plus the M4 execution ledger the
// attempt_id foreign key demands: an attempt row is not a uuid a test can
// invent, it is a node execution's run's attempt, and the FK is the point.
type nodeAttemptSecretFixture struct {
	*secFixture
	m4           *m4Fixture
	secretStore  *SecretStore
	units        *UnitSecrets
	attemptID    string
	runID        string
	turnOnlyEnv  string
	attemptEnv   string
	checkoutPath string
	mirrorPath   string
}

func nodeAttemptSecretsSetup(t *testing.T) *nodeAttemptSecretFixture {
	t.Helper()
	f := &nodeAttemptSecretFixture{secFixture: secSetup(t)}
	f.secretStore = f.store // secSetup's store already carries the keyring
	f.units = &UnitSecrets{Secrets: f.secretStore, Workspaces: &WorkspaceStore{Pool: f.pool}}

	// The execution ledger the attempt_id foreign key demands. 00005 anchors
	// attempts to a node execution and its run, so the fixture borrows the M4
	// pipeline fixture (same org, same pool) rather than inventing rows the
	// composite FK would refuse — and taking its cleanup with them.
	ctx := testCtx(t)
	m4 := m4SetupShared(t, ctx, f.pool)
	f.m4 = m4
	runID := m4.m4QueuedRun(t, ctx, "", 0)
	_, attemptID := m4.m4WorkerNode(t, ctx, runID, "/implement")
	f.runID = runID
	f.attemptID = attemptID

	// A checkout for env mounts to ride on (contract § 4.2 step 3's rule: an env
	// mount names no repository, so it rides on the unit's first one).
	f.checkoutPath = t.TempDir()
	f.mirrorPath = t.TempDir()

	f.turnOnlyEnv = "TURN_ONLY_URL"
	f.attemptEnv = "DATABASE_URL"
	return f
}

// declareRefs rewrites the run's PINNED plan_snapshot so that one node names
// these secret references in its config — the compiler's job in production
// (contract § 4 step 4, ADR-0018 D4: the mounts in play for an attempt are the
// ones its node declared). m4QueuedRun pins `{"nodes":[]}`, so nothing is
// declared until a test says so. The pair of nodes mirrors the M4 lab pipeline:
// `plan` (the planner, which declares none) and `implement` (which declares the
// project's one node_attempt mount).
func (f *nodeAttemptSecretFixture) declareRefs(t *testing.T, nodeID string, refs ...string) {
	t.Helper()
	node := func(id string) string {
		if id != nodeID {
			return fmt.Sprintf(`{"id":%q,"scope":"/"}`, id)
		}
		items := make([]string, 0, len(refs))
		for i, r := range refs {
			items = append(items, fmt.Sprintf(
				`{"pointer":"/spec/nodes/0/config/secretRefs/%d","position":"value","literal":%q}`, i, r))
		}
		if len(items) == 0 {
			return fmt.Sprintf(`{"id":%q,"scope":"/"}`, id)
		}
		return fmt.Sprintf(`{"id":%q,"scope":"/","configBindings":[%s]}`, id, strings.Join(items, ","))
	}
	snapshot := `{"nodes":[` + node("plan") + `,` + node("implement") + `]}`
	if _, err := f.pool.Exec(testCtx(t),
		`UPDATE runs SET plan_snapshot = $2::jsonb WHERE id = $1::uuid`, f.runID, snapshot); err != nil {
		t.Fatalf("pin the plan snapshot: %v", err)
	}
}

// planAttempt seeds the lab's OTHER node (`plan`) and returns its attempt id: a
// second attempt in the same project, holding the same mounts available to it,
// is what proves the selection is per node and not per project.
func (f *nodeAttemptSecretFixture) planAttempt(t *testing.T) string {
	t.Helper()
	ctx := testCtx(t)
	_, attemptID := f.m4.m4WorkerNode(t, ctx, f.runID, "/plan")
	return attemptID
}

// mountRef is the `project/<slug>` reference the schema's secretRef pattern and
// the compiled config both name a mount by.
func (f *nodeAttemptSecretFixture) mountRef(label string) string {
	return "project/" + f.slug(label)
}

// countEvents reads one event type's row count for the fixture project.
func (f *nodeAttemptSecretFixture) countEvents(t *testing.T, typ string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testCtx(t), `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND type = $2`,
		f.projA, typ).Scan(&n); err != nil {
		t.Fatalf("count %s events: %v", typ, err)
	}
	return n
}

// countMaterializations reads the ledger rows this fixture's project holds.
func (f *nodeAttemptSecretFixture) countMaterializations(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT count(*) FROM secret_materializations WHERE project_id = $1::uuid`, f.projA).
		Scan(&n); err != nil {
		t.Fatalf("count materializations: %v", err)
	}
	return n
}

// mount declares one env placement with the lifecycle under test.
func (f *nodeAttemptSecretFixture) mount(t *testing.T, label, envName, lifecycle string, profiles ...string) {
	t.Helper()
	if profiles == nil {
		profiles = []string{f.profile}
	}
	secret, err := f.secretStore.CreateSecret(testCtx(t), f.caller(f.alice), f.projA, NewSecret{
		Slug: f.slug(label), Purpose: "node_attempt lifecycle test " + label,
		DeliveryMode: "env", Profiles: profiles,
		Value: []byte("value-of-" + label + "-" + f.token),
	})
	if err != nil {
		t.Fatalf("CreateSecret(%s): %v", label, err)
	}
	if _, err := f.secretStore.CreateMount(testCtx(t), f.caller(f.alice), f.projA, NewSecretMount{
		SecretID: secret.ID, DeliveryMode: "env", EnvName: envName, Lifecycle: lifecycle,
	}); err != nil {
		t.Fatalf("CreateMount(%s): %v", label, err)
	}
}

func (f *nodeAttemptSecretFixture) repos() []worker.MaterializeRepo {
	return []worker.MaterializeRepo{{ID: f.repoA, Name: "registry",
		CheckoutPath: f.checkoutPath, MirrorPath: f.mirrorPath}}
}

// TestNodeAttemptSecretsLifecycleSelectsTheArm proves the read is scoped by the
// unit that asks: a turn never sees the attempt's mounts, an attempt sees only
// them, and an unknown lifecycle is a refusal rather than a widening.
func TestNodeAttemptSecretsLifecycleSelectsTheArm(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "attempt-arm", f.attemptEnv, "node_attempt")
	f.mount(t, "turn-arm", f.turnOnlyEnv, "turn")
	f.mount(t, "workspace-arm", "WS_URL", "workspace")

	names := func(mounts []unitMount) []string {
		var out []string
		for _, m := range mounts {
			out = append(out, m.EnvName+"@"+m.Lifecycle)
		}
		return out
	}
	attemptMounts, err := f.secretStore.MountsForUnit(ctx, f.projA, worker.LifecycleNodeAttempt)
	if err != nil {
		t.Fatalf("MountsForUnit(node_attempt): %v", err)
	}
	if len(attemptMounts) != 1 || attemptMounts[0].EnvName != f.attemptEnv {
		t.Fatalf("node_attempt mounts = %v, want exactly the attempt arm", names(attemptMounts))
	}
	turnMounts, err := f.secretStore.MountsForUnit(ctx, f.projA, worker.LifecycleTurn)
	if err != nil {
		t.Fatalf("MountsForUnit(turn): %v", err)
	}
	if len(turnMounts) != 2 {
		t.Fatalf("turn mounts = %v, want the turn and workspace arms and NOT the attempt arm", names(turnMounts))
	}
	for _, m := range turnMounts {
		if m.Lifecycle == "node_attempt" {
			t.Errorf("a turn-scope read returned the attempt arm: %v", names(turnMounts))
		}
	}
	// M3's callers pass no lifecycle at all; "" must mean exactly what "turn"
	// means, or every M2/M3 unit silently changes behaviour.
	defaultMounts, err := f.secretStore.MountsForUnit(ctx, f.projA, "")
	if err != nil {
		t.Fatalf("MountsForUnit(\"\"): %v", err)
	}
	if len(defaultMounts) != len(turnMounts) {
		t.Errorf("default scope returned %d mounts, turn scope %d — M3's behaviour moved",
			len(defaultMounts), len(turnMounts))
	}
	if _, err := f.secretStore.MountsForUnit(ctx, f.projA, "forever"); err == nil ||
		!strings.Contains(err.Error(), "not turn or node_attempt") {
		t.Errorf("unknown lifecycle = %v, want a refusal that names the two scopes", err)
	}
}

// TestNodeAttemptSecretsMaterializeRecordsAndCleansUp is the exit-gate C2
// statement at the row level: the authorized profile's attempt materializes its
// mount, the ledger row carries attempt_id (the reserved arm finally used), and
// the unit's Done hook closes it.
func TestNodeAttemptSecretsMaterializeRecordsAndCleansUp(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "delivered", f.attemptEnv, "node_attempt")
	f.mount(t, "other-arm", f.turnOnlyEnv, "turn")
	f.declareRefs(t, "implement", f.mountRef("delivered"), f.mountRef("other-arm"))

	req := worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	}
	m, err := f.units.Materialize(ctx, req)
	if err != nil {
		t.Fatalf("Materialize(node_attempt): %v", err)
	}
	if len(m.Env) != 1 || !strings.HasPrefix(m.Env[0], f.attemptEnv+"=") {
		t.Fatalf("env = %v, want only the attempt arm's %s", redactedEnvNames(m.Env), f.attemptEnv)
	}
	if !strings.Contains(m.Env[0], f.token) {
		t.Fatal("the delivered value is not the secret's plaintext")
	}
	var storedMode, target, cleanedBy string
	var attemptIDSet, cleaned bool
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(attempt_id::text, '') <> '', delivery_mode, target,
		       COALESCE(cleaned_by, ''), cleaned_at IS NOT NULL
		FROM secret_materializations WHERE project_id = $1::uuid`, f.projA).
		Scan(&attemptIDSet, &storedMode, &target, &cleanedBy, &cleaned); err != nil {
		t.Fatalf("read the materialization row: %v", err)
	}
	if !attemptIDSet {
		t.Error("secret_materializations.attempt_id is NULL: the reserved arm was materialized without naming its owner")
	}
	if storedMode != "env" || target != f.attemptEnv {
		t.Errorf("row = (%s, %s), want (env, %s)", storedMode, target, f.attemptEnv)
	}
	// The event carries the same correlation the row does (§ 3's rule).
	var eventAttempt string
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(attempt_id::text, '') FROM domain_events
		WHERE project_id = $1::uuid AND type = 'secret.materialized'`, f.projA).Scan(&eventAttempt); err != nil {
		t.Fatalf("read the materialized event: %v", err)
	}
	if eventAttempt != f.attemptID {
		t.Errorf("secret.materialized.attempt_id = %q, want %q", eventAttempt, f.attemptID)
	}

	if m.Done == nil {
		t.Fatal("Materialized.Done is nil: the ledger would never close")
	}
	if err := m.Done(ctx); err != nil {
		t.Fatalf("Done: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT cleaned_at IS NOT NULL, COALESCE(cleaned_by, '')
		FROM secret_materializations WHERE project_id = $1::uuid`, f.projA).Scan(&cleaned, &cleanedBy); err != nil {
		t.Fatalf("re-read after cleanup: %v", err)
	}
	if !cleaned || cleanedBy != "worker" {
		t.Errorf("after Done: cleaned=%v cleaned_by=%q, want true/worker", cleaned, cleanedBy)
	}
	var removedEvents int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid AND type = 'secret.removed'`,
		f.projA).Scan(&removedEvents); err != nil {
		t.Fatalf("count removed events: %v", err)
	}
	if removedEvents != 1 {
		t.Errorf("secret.removed events = %d, want one per closed row", removedEvents)
	}
}

// TestNodeAttemptSecretsRefuseUnallowlistedProfilesAndBadRequests pins the two
// ways a node_attempt delivery must NOT happen: the profile axis is the
// resolver's (ADR-0018 D3), and an attempt-scope request with no attempt id is
// refused before it reads anything.
func TestNodeAttemptSecretsRefuseUnallowlistedProfilesAndBadRequests(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "granted", f.attemptEnv, "node_attempt") // allowlisted to f.profile only
	f.declareRefs(t, "implement", f.mountRef("granted"))

	req := worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile2, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	}
	m, err := f.units.Materialize(ctx, req)
	if err == nil {
		t.Fatalf("an unallowlisted profile materialized the mount: %+v", m)
	}
	// The declaration put the mount in play; the allowlist says it is not this
	// profile's to hold. That is the resolver's authorization answer, surfaced
	// unwrapped-but-classified so the worker can skip it (procexec.go,
	// agentturn.go) — not a delivery that was supposed to happen and did not.
	if !errors.Is(err, secrets.ErrNotAuthorized) {
		t.Errorf("Materialize for an unallowlisted profile = %v, want an error wrapping secrets.ErrNotAuthorized", err)
	}
	if len(m.Env) != 0 || len(m.Files) != 0 || m.Done != nil {
		t.Errorf("an unallowlisted profile received a Materialized: %+v", m)
	}
	if failedEvents := f.countEvents(t, "secret.materialization_failed"); failedEvents != 0 {
		t.Errorf("secret.materialization_failed events = %d, want none: a secret this profile was never granted is not a materialization that failed", failedEvents)
	}
	var rows int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM secret_materializations WHERE project_id = $1::uuid`, f.projA).Scan(&rows); err != nil {
		t.Fatalf("count materializations: %v", err)
	}
	if rows != 0 {
		t.Errorf("a refused delivery still recorded %d materialization rows", rows)
	}
	// A node_attempt request that names no attempt would write a row whose
	// lifecycle and owner disagree: refused before the mount read.
	noAttempt := req
	noAttempt.AgentProfileID = f.profile
	noAttempt.AttemptID = ""
	if _, err := f.units.Materialize(ctx, noAttempt); err == nil ||
		!strings.Contains(err.Error(), "requires an attempt id") {
		t.Errorf("node_attempt scope without an attempt id = %v, want a refusal", err)
	}
	// And the mirror image: a turn-scope request may not smuggle an attempt id
	// into the ledger.
	turnWithAttempt := req
	turnWithAttempt.Lifecycle = worker.LifecycleTurn
	if _, err := f.units.Materialize(ctx, turnWithAttempt); err == nil ||
		!strings.Contains(err.Error(), "must not name an attempt id") {
		t.Errorf("turn scope with an attempt id = %v, want a refusal", err)
	}
}

func redactedEnvNames(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		out = append(out, name)
	}
	return out
}

var _ = secrets.ErrNotAuthorized

// TestNodeAttemptMountSelectionFollowsTheNodesDeclaration is defect (a) at the
// row level, in the M4 lab's exact shape: ONE node_attempt mount exists in the
// project (allowlisted to the implementer profile), and the project holds two
// attempts — `plan`, whose node config declares no secretRefs, and `implement`,
// whose node declares that very mount. The project is not the unit of selection;
// the node's declared references, read from the run's pinned plan, are.
func TestNodeAttemptMountSelectionFollowsTheNodesDeclaration(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "test-database-url", f.attemptEnv, "node_attempt")
	planAttempt := f.planAttempt(t)

	// A plan snapshot with no entry for the node is not evidence that the node
	// declared nothing: the read refuses rather than silently starving the
	// attempt of secrets its own config named.
	if _, err := f.units.Materialize(ctx, worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	}); err == nil || !strings.Contains(err.Error(), "does not carry") {
		t.Fatalf("materialize against an empty pinned plan = %v, want a refusal that names the plan", err)
	}

	f.declareRefs(t, "implement", f.mountRef("test-database-url"))

	// The planner: zero mounts, with the SAME allowlisted profile the
	// implementer holds — so the only thing that can produce this answer is the
	// node's own declaration.
	mounts, err := f.secretStore.MountsForAttempt(ctx, f.projA, planAttempt)
	if err != nil {
		t.Fatalf("MountsForAttempt(plan): %v", err)
	}
	if len(mounts) != 0 {
		t.Fatalf("the planner node's mounts = %+v, want none: it declares no secretRefs", mounts)
	}
	m, err := f.units.Materialize(ctx, worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile, AttemptID: planAttempt,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	})
	if err != nil {
		t.Fatalf("Materialize(plan attempt): %v", err)
	}
	if len(m.Env) != 0 || len(m.Files) != 0 || m.Redact != nil || m.Done != nil {
		t.Fatalf("the planner materialized a set: %+v", m)
	}
	if n := f.countMaterializations(t); n != 0 {
		t.Errorf("the planner left %d ledger rows", n)
	}
	if n := f.countEvents(t, "secret.materialization_failed"); n != 0 {
		t.Errorf("secret.materialization_failed = %d: the planner's empty declaration is not a failure, and is the M4 lab's C2 blocker", n)
	}

	// The implementer: the mount it declared, and only it.
	mounts, err = f.secretStore.MountsForAttempt(ctx, f.projA, f.attemptID)
	if err != nil {
		t.Fatalf("MountsForAttempt(implement): %v", err)
	}
	if len(mounts) != 1 || mounts[0].EnvName != f.attemptEnv || mounts[0].Scope != "project" {
		t.Fatalf("the implementer node's mounts = %+v, want exactly the declared env arm", mounts)
	}
	got, err := f.units.Materialize(ctx, worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	})
	if err != nil {
		t.Fatalf("Materialize(implement attempt): %v", err)
	}
	if len(got.Env) != 1 || !strings.HasPrefix(got.Env[0], f.attemptEnv+"=") {
		t.Fatalf("implementer env = %v, want the declared %s", redactedEnvNames(got.Env), f.attemptEnv)
	}
	if n := f.countMaterializations(t); n != 1 {
		t.Errorf("ledger rows = %d, want the implementer's one", n)
	}
	if got.Done != nil {
		if err := got.Done(ctx); err != nil {
			t.Fatalf("Done: %v", err)
		}
	}
}

// TestNodeAttemptMountSelectionKeepsTurnScopeUnchanged proves M2/M3's read did
// not move: a turn-scope unit still sees every non-attempt mount of the project,
// declared or not, because no node-level declaration exists for it to consult.
func TestNodeAttemptMountSelectionKeepsTurnScopeUnchanged(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "turn-arm", f.turnOnlyEnv, "turn")
	f.mount(t, "attempt-arm", f.attemptEnv, "node_attempt")
	f.declareRefs(t, "implement") // the implementer declares NOTHING

	turnMounts, err := f.secretStore.MountsForUnit(ctx, f.projA, worker.LifecycleTurn)
	if err != nil {
		t.Fatalf("MountsForUnit(turn): %v", err)
	}
	if len(turnMounts) != 1 || turnMounts[0].EnvName != f.turnOnlyEnv {
		t.Fatalf("turn mounts = %+v, want the turn arm and nothing else", turnMounts)
	}
	m, err := f.units.Materialize(ctx, worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		WorkspaceID: f.wsA, AgentProfileID: f.profile,
		Lifecycle: worker.LifecycleTurn, Repos: f.repos(),
	})
	if err != nil {
		t.Fatalf("Materialize(turn): %v", err)
	}
	if len(m.Env) != 1 || !strings.HasPrefix(m.Env[0], f.turnOnlyEnv+"=") {
		t.Fatalf("turn env = %v, want the turn arm delivered as M3 delivered it", redactedEnvNames(m.Env))
	}
	if n := f.countEvents(t, "secret.materialization_failed"); n != 0 {
		t.Errorf("secret.materialization_failed = %d on the unchanged turn path", n)
	}
	if m.Done != nil {
		if err := m.Done(ctx); err != nil {
			t.Fatalf("Done: %v", err)
		}
	}
}

// TestNodeAttemptMountSelectionNotAllowlistedRefusesWithoutJournaling is defect
// (b): a mount the node DID declare, for a profile that is not on its allowlist,
// answers with the resolver's own refusal — wrapped, so the worker's skip rule
// (procexec.go, agentturn.go) can find it — and writes no
// secret.materialization_failed, because nothing that was supposed to be
// delivered failed to be.
func TestNodeAttemptMountSelectionNotAllowlistedRefusesWithoutJournaling(t *testing.T) {
	f := nodeAttemptSecretsSetup(t)
	ctx := testCtx(t)
	f.mount(t, "declined", f.attemptEnv, "node_attempt") // allowlisted to f.profile only
	f.declareRefs(t, "implement", f.mountRef("declined"))

	// In play: declared, so it is asked about.
	mounts, err := f.secretStore.MountsForAttempt(ctx, f.projA, f.attemptID)
	if err != nil {
		t.Fatalf("MountsForAttempt: %v", err)
	}
	if len(mounts) != 1 {
		t.Fatalf("mounts = %+v, want the declared one in play", mounts)
	}

	m, err := f.units.Materialize(ctx, worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile2, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	})
	if !errors.Is(err, secrets.ErrNotAuthorized) {
		t.Fatalf("Materialize for a non-allowlisted profile = %v, want an error wrapping secrets.ErrNotAuthorized", err)
	}
	if len(m.Env) != 0 || len(m.Files) != 0 || m.Done != nil {
		t.Errorf("the refused unit still received a Materialized: %+v", m)
	}
	if n := f.countEvents(t, "secret.materialization_failed"); n != 0 {
		t.Errorf("secret.materialization_failed = %d, want none (the false finding that bricked the lab's planner)", n)
	}
	if n := f.countMaterializations(t); n != 0 {
		t.Errorf("ledger rows = %d, want none", n)
	}
}
