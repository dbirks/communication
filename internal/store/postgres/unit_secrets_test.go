package postgres

import (
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

	req := worker.MaterializeRequest{
		OrganizationID: f.orgID, ProjectID: f.projA, WorkerID: f.worker,
		AgentProfileID: f.profile2, AttemptID: f.attemptID,
		Lifecycle: worker.LifecycleNodeAttempt, Repos: f.repos(),
	}
	m, err := f.units.Materialize(ctx, req)
	if err == nil {
		t.Fatalf("an unallowlisted profile materialized the mount: %+v", m)
	}
	if !strings.Contains(err.Error(), "materialization refused") {
		t.Errorf("Materialize for an unallowlisted profile = %v, want the refused-materialization error", err)
	}
	var failedEvents int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events WHERE project_id = $1::uuid
		  AND type = 'secret.materialization_failed'`, f.projA).Scan(&failedEvents); err != nil {
		t.Fatalf("count materialization_failed events: %v", err)
	}
	if failedEvents != 1 {
		t.Errorf("secret.materialization_failed events = %d, want the one refusal ADR-0018 D4 requires", failedEvents)
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
