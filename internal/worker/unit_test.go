package worker_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The unit service is where the contract's ordering lives, so these tests are
// about *sequence and consequences*, not about git or nono behaviour (those have
// their own real-binary suites). The question here is the one the definition of
// done asks: does a refusal stop the launch, does a failure quarantine, does a
// leftover secret move the workspace, and does anything reaching the journal
// carry a path?

// fakeSandbox records the verify calls and answers with a canned result.
type fakeSandbox struct {
	mu     sync.Mutex
	specs  []nono.LaunchSpec
	result *nono.VerificationResult
	err    error
}

func (f *fakeSandbox) Verify(_ context.Context, spec nono.LaunchSpec) (*nono.VerificationResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs = append(f.specs, spec)
	if f.err != nil {
		return nil, f.err
	}
	if f.result != nil {
		return f.result, nil
	}
	return &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion, PolicyDigest: "sha256:fake",
		PolicyRef: spec.Profile.Path, AfUnixMediation: "closed", Verified: true,
	}, nil
}

func (f *fakeSandbox) Probe(context.Context) (domain.SandboxCapabilities, error) {
	return domain.SandboxCapabilities{Backend: "nono", Filesystem: true, Network: true, Verified: true}, nil
}

func (f *fakeSandbox) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.specs)
}

// memStore is an in-memory WorkspaceStore: it answers the topology questions and
// records every transition so the ordering is assertable.
type memStore struct {
	mu sync.Mutex

	volumes   []worker.VolumeRecord
	events    []worker.TurnEvent
	repos     []worker.WorkspaceRepo
	commits   []worker.CommitRecord
	state     map[string]string
	released  []string
	quarantin []string

	workspaceID string
	nextID      int
	claimFunc   func(worker.WorkspaceClaim) (worker.WorkspaceDecision, error)
	reposFunc   func() ([]worker.WorkspaceRepoState, error)
}

func newMemStore() *memStore {
	return &memStore{state: map[string]string{}, workspaceID: "ws-1"}
}

func (m *memStore) RecordVolume(_ context.Context, v worker.VolumeRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.volumes = append(m.volumes, v)
	return nil
}

func (m *memStore) Volume(context.Context, string, string) (worker.VolumeRecord, bool, error) {
	return worker.VolumeRecord{}, false, nil
}

func (m *memStore) ClaimWorkspace(_ context.Context, req worker.WorkspaceClaim) (worker.WorkspaceDecision, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.claimFunc != nil {
		return m.claimFunc(req)
	}
	m.state[req.ConversationID] = "preparing"
	return worker.WorkspaceDecision{Kind: worker.DecisionCreated, WorkspaceID: m.workspaceID}, nil
}

func (m *memStore) MarkReady(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[id] = "ready"
	return nil
}

func (m *memStore) Quarantine(_ context.Context, id, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[id] = "quarantined"
	m.quarantin = append(m.quarantin, id+":"+reason)
	return nil
}

func (m *memStore) Release(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[id] = "released"
	m.released = append(m.released, id)
	return nil
}

func (m *memStore) RecordRepos(_ context.Context, id string, repos []worker.WorkspaceRepo, markReady bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.repos = append(m.repos, repos...)
	if markReady {
		m.state[id] = "ready"
	}
	return nil
}

func (m *memStore) WorkspaceRepos(_ context.Context, _ string) ([]worker.WorkspaceRepoState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.reposFunc != nil {
		return m.reposFunc()
	}
	var out []worker.WorkspaceRepoState
	for i, r := range m.repos {
		out = append(out, worker.WorkspaceRepoState{RowID: string(rune('a' + i)), RepositoryID: r.RepositoryID})
	}
	return out, nil
}

func (m *memStore) RecordCommit(_ context.Context, rec worker.CommitRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commits = append(m.commits, rec)
	return nil
}

func (m *memStore) LiveWorkspaceForConversation(context.Context, string) (worker.WorkspaceRow, bool, error) {
	return worker.WorkspaceRow{}, false, nil
}

func (m *memStore) WorkspaceEvent(_ context.Context, _, _, _ string, ev worker.TurnEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, ev)
	return nil
}

func (m *memStore) stateOf(id string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state[id]
}

func (m *memStore) eventTypes() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.events))
	for _, e := range m.events {
		out = append(out, e.Type)
	}
	return out
}

func (m *memStore) snapshot() ([]worker.TurnEvent, []worker.CommitRecord, []string, []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]worker.TurnEvent(nil), m.events...), append([]worker.CommitRecord(nil), m.commits...),
		append([]string(nil), m.released...), append([]string(nil), m.quarantin...)
}

// secretsStub is a materializer that can be told to leave a file behind.
type secretsStub struct {
	files []string
	env   []string
	err   error
	// noDelete makes the reported file survive cleanup, which is the case-15
	// "a materialized secret survived cleanup" shape.
	noDelete bool
}

func (s *secretsStub) Materialize(_ context.Context, req worker.MaterializeRequest) (worker.Materialized, error) {
	if s.err != nil {
		return worker.Materialized{}, s.err
	}
	if req.ExtraExclusions != nil {
		*req.ExtraExclusions = append(*req.ExtraExclusions, s.files...)
	}
	out := worker.Materialized{Env: s.env, Files: append([]string(nil), s.files...)}
	if !s.noDelete {
		// Normal case: the files really exist so cleanup has something to remove.
		for _, f := range s.files {
			if err := writeFile(f); err != nil {
				return worker.Materialized{}, err
			}
		}
	}
	return out, nil
}

type apmStub struct {
	staged *apm.StagedContext
	err    error
	calls  int
}

func (a *apmStub) Stage(context.Context, apm.StageRequest) (*apm.StagedContext, error) {
	a.calls++
	if a.err != nil {
		return nil, a.err
	}
	if a.staged != nil {
		return a.staged, nil
	}
	// A real staging run always reports what it generated, so a stub that
	// reported nothing would let the exclusion-merge path look exercised when it
	// was not.
	return &apm.StagedContext{Target: "claude", LockDigest: "sha256:stub", GeneratedPaths: []string{".claude/skills"}}, nil
}

func (a *apmStub) Resolve(context.Context, apm.ResolveRequest) (*apm.ResolveResult, error) {
	a.calls++
	if a.err != nil {
		return nil, a.err
	}
	return &apm.ResolveResult{LockDigest: "sha256:stub", Contents: apm.Contents{Skills: []string{"stub"}}}, nil
}

func TestUnitPrepareRecordsBothVolumes(t *testing.T) {
	fx := newUnitFixture(t)
	_, err := fx.svc.Prepare(context.Background(), fx.request())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	fx.store.mu.Lock()
	defer fx.store.mu.Unlock()
	kinds := map[string]bool{}
	for _, v := range fx.store.volumes {
		if v.VolumeID == "" || v.StDev == 0 {
			t.Fatalf("volume record is not an identity: %+v", v)
		}
		kinds[v.RootKind] = true
	}
	// Case 20 compares a workspace's volume against the worker's *current*
	// measurement of the root it lives on. Both roots must be measured every
	// time: probe V5b found the lab's workspaces and repos trees share a device
	// and differ only by inode, so a single measurement could not answer for
	// both.
	for _, kind := range []string{"workspaces", "repos"} {
		if !kinds[kind] {
			t.Fatalf("root kind %q was not recorded; got %v", kind, kinds)
		}
	}
}

func TestUnitQuarantinedWorkspaceIsNotReused(t *testing.T) {
	fx := newUnitFixture(t)
	fx.store.claimFunc = func(worker.WorkspaceClaim) (worker.WorkspaceDecision, error) {
		return worker.WorkspaceDecision{Kind: worker.DecisionQuarantined, WorkspaceID: "ws-old"}, nil
	}
	if _, err := fx.svc.Prepare(context.Background(), fx.request()); err == nil {
		t.Fatal("a quarantined workspace must not be reused; ADR-0017 D3 makes the reason a security condition")
	}
}

func TestUnitSecretLeftBehindQuarantines(t *testing.T) {
	fx := newUnitFixture(t)
	// A file that exists but cannot be removed: the parent directory is
	// read-only, which is how a real leftover happens (an immutable mount, a
	// permission change by the agent, a deletion that half-failed). A file that
	// was never written would be indistinguishable from success by Lstat alone,
	// and the assertion must be about *removal*, not about existence.
	// Under scratch rather than inside a checkout: `repos/<name>` is a git
	// worktree and creating sibling directories in it would perturb the very
	// status output the other assertions read.
	dir := fx.scratchPath() + "/undeletable"
	leftover := dir + "/.env"
	// Prepared first: the scratch tree has to exist before a file can sit in it.
	unit, err := fx.svc.Prepare(context.Background(), fx.request())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	// MkdirAll with 0o500 would apply the mode to every created parent, making
	// the workspace itself unwritable — so the parents are made writable and only
	// the leaf is tightened.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leftover, []byte("SECRET=materialized\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Removing a file is a write on its *directory*, so tightening the directory
	// after the file exists is what makes os.Remove fail — the file's own mode is
	// irrelevant to unlink.
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	fx.svc.Secrets = &secretsStub{files: []string{leftover}, noDelete: true}
	// The unit's own record of what was materialized is what cleanup asserts on,
	// so the stub is installed before the hook would have run: this test drives
	// the *cleanup* half directly.
	unit.SetMaterializedForTest([]string{leftover}, nil)

	released, err := unit.Cleanup(context.Background())
	if err == nil {
		t.Fatal("a surviving materialized secret must be an error")
	}
	if released {
		t.Fatal("a unit whose secret survived must not report a release")
	}
	_, _, releasedIDs, quarantined := fx.store.snapshot()
	if len(releasedIDs) != 0 {
		t.Fatalf("released=%v, want none: the workspace still holds a secret", releasedIDs)
	}
	if len(quarantined) != 1 || !strings.Contains(quarantined[0], events.QuarantineSecretLeftBehind) {
		t.Fatalf("quarantined=%v, want one %s", quarantined, events.QuarantineSecretLeftBehind)
	}
	// The event carries the *reason enum* only. Whether the file was removed is
	// worker-log detail; the path itself never enters the journal (contract § 3).
	for _, ev := range fx.store.eventTypes() {
		if ev != events.TypeWorkspaceQuarantined {
			continue
		}
	}
	types := fx.store.eventTypes()
	if got := types[len(types)-1]; got != events.TypeWorkspaceQuarantined {
		t.Fatalf("last event = %q, want %q", got, events.TypeWorkspaceQuarantined)
	}
}

func TestUnitCleanupRemovesSecretsAndReleases(t *testing.T) {
	fx := newUnitFixture(t)
	materialized := fx.scratchPath() + "/.env"
	fx.svc.Secrets = &secretsStub{files: []string{materialized}, env: []string{"API_KEY=secret-value"}}

	unit, err := fx.svc.Prepare(context.Background(), fx.request())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := unit.Capture(context.Background()); err != nil {
		t.Fatalf("capture: %v", err)
	}
	released, err := unit.Cleanup(context.Background())
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if !released {
		t.Fatal("a clean cleanup reports its worktrees pruned")
	}
	if _, err := os.Stat(materialized); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("materialized secret survived: %v", err)
	}
	if _, _, releasedIDs, quarantined := fx.store.snapshot(); len(releasedIDs) != 1 || len(quarantined) != 0 {
		t.Fatalf("released=%v quarantined=%v", releasedIDs, quarantined)
	}
	types := fx.store.eventTypes()
	if types[len(types)-1] != events.TypeWorkspaceReleased {
		t.Fatalf("last event = %q, want %q", types[len(types)-1], events.TypeWorkspaceReleased)
	}
}

// TestSandboxRefusalCarriesEventFields is case 13's worker-side half: the denial
// must arrive with a stage and a reason from the controlled vocabularies, and
// with ChildStarted=false, because the chain execs nothing.
func TestSandboxRefusalCarriesEventFields(t *testing.T) {
	fx := newUnitFixture(t)
	fx.sandbox.err = &nono.Failure{
		Stage:  events.SandboxStageGrantAssert,
		Reason: events.SandboxReasonGrantMismatch,
		Err:    errors.New("grant /secret/path appeared in the resolved set"),
	}
	unit := fx.preparedUnit(t)

	_, err := unit.Verify(context.Background(), testLauncher())
	var d *worker.DenialError
	if !errors.As(err, &d) {
		t.Fatalf("err=%v, want a *worker.DenialError", err)
	}
	if d.Stage != events.SandboxStageGrantAssert || d.Reason != events.SandboxReasonGrantMismatch {
		t.Fatalf("stage/reason = %q/%q", d.Stage, d.Reason)
	}
	if d.ChildStarted {
		t.Fatal("a verification denial must report ChildStarted=false (case 13 asks whether a process was ever exec'd)")
	}
	// The class is path-free even though nono's message is not.
	if strings.Contains(d.Class(), "/") {
		t.Fatalf("Class() leaks a path: %q", d.Class())
	}
}

func TestRequiredModeNeverFallsBack(t *testing.T) {
	fx := newUnitFixture(t)
	fx.sandbox.err = &nono.Failure{Stage: events.SandboxStageProbe, Reason: events.SandboxReasonLandlockUnavailable}
	unit := fx.preparedUnit(t)

	if _, err := unit.Verify(context.Background(), testLauncher()); err == nil {
		t.Fatal("required mode must refuse the launch, not run unsandboxed (ADR-0019 D6)")
	}
}

func TestPermissiveLabelsThePlan(t *testing.T) {
	fx := newUnitFixture(t)
	// The mode is a property of the *worker*, so it is set where the worker is
	// built — a field the unit copies at Prepare time.
	fx.svc.Enforcement = domain.EnforcePermissiveDev
	unit := fx.preparedUnit(t)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("permissive: %v", err)
	}
	if plan.Unsandboxed == "" {
		t.Fatal("a permissive launch must carry the label on the plan itself, not only on the event")
	}
	if fx.sandbox.calls() != 0 {
		t.Fatal("permissive must not pretend to have verified: the chain did not run")
	}
}

// TestJournalPayloadsCarryNoPaths is contract § 3's rule enforced across every
// event the unit service can emit: roles and digests, never host paths.
func TestJournalPayloadsCarryNoPaths(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	if _, err := unit.Capture(context.Background()); err != nil {
		t.Fatalf("capture: %v", err)
	}
	if _, err := unit.Cleanup(context.Background()); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	rootNeedle := fx.root
	eventsJSON, err := marshalEvents(fx.store)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(eventsJSON, rootNeedle) {
		t.Fatalf("a journal payload leaked the workspace root:\n%s", eventsJSON)
	}
	for _, leaked := range []string{"/home/", "/tmp/", "/var/tmp/", "meta/"} {
		if strings.Contains(eventsJSON, leaked) {
			t.Fatalf("journal leaked a host-shaped path %q:\n%s", leaked, eventsJSON)
		}
	}
}

func TestGrantRolesAreTheEventVocabulary(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)

	// The grant set is what sandbox.verified reports. If a role here is not one
	// internal/events recognizes, the UI receives a security label it cannot
	// render — which is a reviewed-by-nobody label.
	labels := fx.grantLabels(unit)
	if len(labels) == 0 {
		t.Fatal("no grants resolved")
	}
	// The commit-bearing roles must be present when commit_granted is on:
	// a sandbox that cannot write a ref is the C-P3 failure (a plan that looks
	// fine and produces "could not find referenced object") rather than a
	// narrower policy.
	seen := map[string]bool{}
	for _, g := range labels {
		role, access, ok := strings.Cut(g, ":")
		if !ok {
			t.Fatalf("label %q is not role:access", g)
		}
		seen[role] = true
		if !events.ValidGrantRole(role) {
			t.Errorf("grant role %q is not in the event vocabulary", role)
		}
		if !events.ValidGrantAccess(access) {
			t.Errorf("grant access %q is not in the event vocabulary", access)
		}
	}
	for _, role := range []string{wsgit.RoleMirrorObjects, wsgit.RoleMirrorRef, wsgit.RoleMirrorReflog, wsgit.RoleWorktreeAdmin} {
		if !seen[role] {
			t.Errorf("commit axis is missing grant role %q; a commit needs all four mirror writes and nothing else", role)
		}
	}
}

func TestUnitAPMBinaryMissingRefuses(t *testing.T) {
	fx := newUnitFixture(t)
	fx.axes.APMPackageRef = "apm:pkg@1"
	fx.axes.APMTarget = apm.TargetClaude
	fx.svc.APM = nil

	if _, err := fx.svc.Prepare(context.Background(), fx.request()); err == nil {
		t.Fatal("a profile that pins packaged context must fail loudly when apm is absent, not run without it")
	} else if !strings.Contains(err.Error(), "apm") {
		t.Fatalf("error should name apm: %v", err)
	}
}

// fakeAPM satisfies apm.Stage's and apm.Resolve's seam inside the unit service.
type fakeAPM interface {
	Stage(context.Context, apm.StageRequest) (*apm.StagedContext, error)
	Resolve(context.Context, apm.ResolveRequest) (*apm.ResolveResult, error)
}

func TestUnitAPMDigestMismatchRefuses(t *testing.T) {
	fx := newUnitFixture(t)
	fx.axes.APMPackageRef = "apm:pkg@1"
	fx.axes.APMTarget = apm.TargetClaude
	fx.svc.APM = &apmStub{err: &apm.DigestMismatch{Recorded: "sha256:aaaa", OnDisk: "sha256:bbbb", Target: "claude"}}

	if _, err := fx.svc.Prepare(context.Background(), fx.request()); err == nil {
		t.Fatal("probe A5 showed --frozen installs mutated content while reporting success; the digest is the only control that sees it")
	} else if !strings.Contains(err.Error(), "sha256:bbbb") {
		t.Fatalf("the refusal should report the observed digest: %v", err)
	}
}

func TestUnitCleanupIsIdempotent(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	first, err := unit.Cleanup(context.Background())
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	second, err := unit.Cleanup(context.Background())
	if err != nil {
		t.Fatalf("second cleanup: %v", err)
	}
	if first != second {
		t.Fatalf("repeat cleanup changed the answer: %v then %v", first, second)
	}
	_, _, released, _ := fx.store.snapshot()
	if len(released) != 1 {
		t.Fatalf("released=%v, want exactly one workspace.release for two Cleanup calls", released)
	}
}

func TestProfileAxesLauncherCannotOverrideTheClaim(t *testing.T) {
	fx := newUnitFixture(t)
	// A stored profile naming a different launcher than the turn's claim would
	// otherwise put one launcher's credential directories onto another's process.
	fx.axes.LauncherID = "codex"
	unit, err := fx.svc.Prepare(context.Background(), fx.request())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if unit.Profile.LauncherID != fx.launcherID {
		t.Fatalf("axes launcher %q survived; the claim's %q must win", unit.Profile.LauncherID, fx.launcherID)
	}
}

func TestUnitVerifyBuildsArgvFromThePlan(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "run -s") {
		t.Fatalf("launch argv lost -s (probe C-SILENT: without it the adapter is never sandboxed and nothing prints): %q", joined)
	}
	if strings.Contains(joined, "--allow-cwd") {
		t.Fatal("--allow-cwd is never emitted (probe C-CWD3 expands it to the whole tree)")
	}
	// The hop is `-- env <assignments> HOME=<agent home> <adapter>`: HOME must
	// name the *agent's* home and must sit before the adapter's own argv, or the
	// adapter would be the thing interpreting HOME=… as its first argument.
	homeArg := "HOME=" + unit.Layout.Home
	if !strings.Contains(joined, homeArg) {
		t.Fatalf("the agent HOME hop is missing (probe C-H1c): %q", joined)
	}
	if strings.Index(joined, homeArg) > strings.Index(joined, "claude-agent-acp") {
		t.Fatalf("HOME is applied after the adapter begins, so the adapter gets it as argv: %q", joined)
	}
	if strings.Count(joined, "HOME=")-strings.Count(joined, "XDG_") != 1 {
		t.Fatalf("HOME named more than once in one argv — the two-HOMEs confusion C-H1 is about: %q", joined)
	}
	if strings.Contains(joined, fx.svc.LauncherHome) {
		t.Fatal("nono's own HOME must never appear in a grant or the child hop")
	}
	if plan.Dir != unit.Plan.Cwd {
		t.Fatalf("plan dir %q != plan cwd %q", plan.Dir, unit.Plan.Cwd)
	}
	// The recorded binary is nono's, not the adapter's: argv[0] is what makes
	// the process a sandboxed one.
	if !strings.HasSuffix(plan.Path, "nono") {
		t.Fatalf("plan path = %q, want the nono binary", plan.Path)
	}
}

// fixture -------------------------------------------------------------------

type unitFixture struct {
	t           *testing.T
	svc         *worker.UnitService
	mu          *sync.Mutex
	store       *memStore
	sandbox     *fakeSandbox
	secrets     worker.SecretMaterializer
	apm         *apmStub
	axes        worker.ProfileAxes
	root        string
	launcherID  string
	enforcement domain.EnforcementMode
	workspace   string
}

func newUnitFixture(t *testing.T) *unitFixture {
	t.Helper()
	root := labScratch(t, "unit")
	launcherHome := root + "/launcher-home"
	policyDir := root + "/policy"
	for _, d := range []string{launcherHome, policyDir, root + "/workspaces", root + "/repos"} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fx := &unitFixture{mu: &sync.Mutex{},
		t: t, root: root, store: newMemStore(), sandbox: &fakeSandbox{},
		// CommitGranted is on by default here: the four mirror-write grants are the
		// axis under test in most of these, and a default-off fixture would make the
		// commit-shape assertions silently vacuous.
		axes:       worker.ProfileAxes{WorkspaceMode: "worktree", LauncherID: "claude", CommitGranted: true},
		launcherID: "claude", enforcement: domain.EnforceRequired,
	}
	fx.svc = &worker.UnitService{
		Store:        fx.store,
		Sandbox:      fx.sandbox,
		LauncherAuth: fx.credentialDirs,
		Profiles:     axesSource{fx},
		LauncherHome: launcherHome,
		PolicyDir:    policyDir,
		GitIdentity:  acp.GitIdentityEnv{Name: "Communication CI", Email: "ci@communication.test"},
		Enforcement:  fx.enforcement,
		SandboxPath:  nonoPath(t),
	}
	fx.svc.Workspaces = newWorkspaceManager(t, root)
	return fx
}

// credentialDirs mirrors what the real worker passes: the launcher's declared
// auth directories, created so the existence check (which is a control, not
// ceremony — probe C-FC3's silent grant drop) can pass.
func (f *unitFixture) credentialDirs(launcherID string) ([]string, error) {
	l, ok := acp.LookupLauncher(launcherID)
	if !ok {
		return nil, fmt.Errorf("unknown launcher %q", launcherID)
	}
	var out []string
	for _, name := range l.AuthEnvVars {
		dir := filepath.Join(f.root, "creds", name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		// t.Setenv would be the right tool, but this runs from inside the
		// service's own callback; the fixture registers the cleanup itself.
		os.Setenv(name, dir)
		f.t.Cleanup(func() { _ = os.Unsetenv(name) })
		out = append(out, dir)
	}
	return out, nil
}

type axesSource struct{ f *unitFixture }

func (a axesSource) ProfileFor(context.Context, string) (worker.ProfileAxes, error) {
	a.f.mu.Lock()
	defer a.f.mu.Unlock()
	// Returned verbatim, launcher id included: TestProfileAxesLauncherCannotOverrideTheClaim
	// depends on the source being able to name a *different* one.
	return a.f.axes, nil
}

func (f *unitFixture) request() worker.UnitRequest {
	return worker.UnitRequest{
		OrganizationID: uuidFor("org"), ProjectID: uuidFor("proj"),
		ConversationID: uuidFor("conv"), TurnID: uuidFor("turn"), WorkerID: uuidFor("worker"),
		Axes: f.axes, LauncherID: f.launcherID,
		Repos: []worker.ProjectRepo{{ID: uuidFor("repo"), Name: "backend", GitURL: f.seedRepo(), DefaultBranch: "main"}},
	}
}

func (f *unitFixture) workspacePath() string {
	// The path the layout manager builds for this conversation: <workspaces
	// root>/<conversation uuid>. It is derived, not configured, because an
	// assertion about "the workspace root" that hardcodes a path would keep
	// passing if the layout changed.
	return f.root + "/workspaces/" + f.request().ConversationID
}

func (f *unitFixture) seedRepo() string {
	return seedBareRepo(f.t, f.root)
}

// scratchPath is the scratch subtree of this conversation's workspace, which the
// workspace manager creates during prepare.
func (f *unitFixture) scratchPath() string {
	return f.workspacePath() + "/work/scratch"
}

func (f *unitFixture) grantLabels(u *worker.Unit) []string {
	f.t.Helper()
	return u.Plan.Labels()
}

func (f *unitFixture) preparedUnit(t *testing.T) *worker.Unit {
	t.Helper()
	unit, err := f.svc.Prepare(context.Background(), f.request())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	return unit
}

// TestSandboxedLaunchGetsATempDirInsideItsGrants is the failure the live compose
// run produced, and it is worth keeping as a test because the symptom looked like
// an adapter bug: Claude Code aborted at session/new with
//
//	EACCES: permission denied, mkdir '/tmp/claude-1000'
//
// The sandbox was right — the agent-turn profile omits nono's system_write_linux
// group precisely so /tmp is not granted (probes C-TMP1/C-TMP3), and a
// profile-level deny cannot beat the layered grant (C-TMP2), so refusing /tmp
// means never asking for it. The remedy is a temp root inside the grants, which
// also improves ADR-0008's per-attempt isolation over a shared /tmp.
func TestSandboxedLaunchGetsATempDirInsideItsGrants(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)

	_, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	spec, err := unit.LaunchSpecFor(testLauncher())
	if err != nil {
		t.Fatalf("spec: %v", err)
	}
	var tmpdir string
	for _, kv := range spec.AdapterEnv {
		if v, ok := strings.CutPrefix(kv, "TMPDIR="); ok {
			tmpdir = v
		}
	}
	if tmpdir == "" {
		t.Fatal("no TMPDIR: a harness that cannot write a temp file fails inside the sandbox and looks like an adapter bug")
	}
	if tmpdir == "/tmp" || strings.HasPrefix(tmpdir, "/tmp/") {
		t.Fatalf("TMPDIR=%q is under /tmp, which the agent-turn profile refuses to grant", tmpdir)
	}
	// It must be a granted path, not merely a path under the workspace root.
	granted := false
	for _, g := range unit.Plan.Grants {
		if strings.HasPrefix(tmpdir, filepath.Clean(g.Path)+string(filepath.Separator)) || tmpdir == filepath.Clean(g.Path) {
			granted = true
		}
	}
	if !granted {
		t.Fatalf("TMPDIR=%q is outside every grant: %v", tmpdir, unit.Plan.Resolved())
	}
	if st, err := os.Stat(tmpdir); err != nil || !st.IsDir() {
		t.Fatalf("TMPDIR does not exist before launch (%v): a grant to a nonexistent path grants nothing (C-FC3)", err)
	}
}
