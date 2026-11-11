package worker

// ADR-0084 on the worker side: the launch stager installs the profile's FLATTENED
// collection set — the one list the lock resolver computed its digest over — and
// pi gets a target, honestly labelled as unverified. These use the unit's own APM
// seam (no apm binary, no nono), because what is under test is which dependency
// list reaches apm and which target it reaches it under: a staging that
// flattened differently from the lock would trip the digest gate for reasons
// nobody could read in the log.

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/apm"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// depsCaptureAPM is the APM seam of a unit, recording every staging request.
type depsCaptureAPM struct {
	stageReqs   []apm.StageRequest
	resolveReqs []apm.ResolveRequest
	staged      *apm.StagedContext
	err         error
}

func (a *depsCaptureAPM) Stage(_ context.Context, req apm.StageRequest) (*apm.StagedContext, error) {
	a.stageReqs = append(a.stageReqs, req)
	if a.err != nil {
		return nil, a.err
	}
	if a.staged != nil {
		return a.staged, nil
	}
	return &apm.StagedContext{Target: req.Target, LockDigest: "sha256:" + strings.Repeat("1", 64)}, nil
}

func (a *depsCaptureAPM) Resolve(_ context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error) {
	a.resolveReqs = append(a.resolveReqs, req)
	return &apm.ResolveResult{LockDigest: "sha256:" + strings.Repeat("1", 64)}, nil
}

// stageFixture is a unit with one prepared repository and nothing else: staging is
// the step under test, and a unit that had run the whole prepare chain would prove
// the same thing about the dependency list while depending on nono, git and a
// database.
func stageFixture(axes ProfileAxes, apmSeam *depsCaptureAPM) *Unit {
	return &Unit{
		svc:     &UnitService{APM: apmSeam},
		logger:  slog.New(slog.NewTextHandler(discardWriter{}, nil)),
		Staged:  map[string]*apm.StagedContext{},
		Profile: axes,
		Repos: []wsgit.PreparedRepo{
			{Name: "backend", CheckoutPath: "/workspaces/ws-1/repos/backend", RepositoryID: "repo-1"},
		},
	}
}

const pstackSHA = "63912a91d52c43946f974f2aaf661334a6116a82"

// The staging list IS the lock list: attached collections in attach order, the
// profile's own ref appended last. If this ever stopped matching what
// postgres.CreateAPMLockRequest flattens, the digest gate would be comparing a
// launch against somebody else's dependency set.
func TestUnitStageAPMInstallsTheFlattenedCollectionSet(t *testing.T) {
	capture := &depsCaptureAPM{}
	axes := ProfileAxes{
		AgentProfileID: "p-1",
		LauncherID:     "claude",
		APMTarget:      apm.TargetClaude,
		APMLockDigest:  "sha256:" + strings.Repeat("2", 64),
		APMPackageRef:  "acme/extras#v0.1.0",
		APMCollections: []apm.CollectionRevision{
			{CollectionID: "c-1", Slug: "matt-pocock-skills", Revision: 1,
				Entries: []apm.CollectionEntry{{Ref: "mattpocock/skills#v1.3.2"}}},
			{CollectionID: "c-2", Slug: "pstack-claude-code", Revision: 1,
				Entries: []apm.CollectionEntry{
					{Ref: "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#" + pstackSHA},
					{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#" + pstackSHA, Skills: []string{"how"}},
				}},
		},
	}
	u := stageFixture(axes, capture)
	if err := u.stageAPM(context.Background(), UnitRequest{}); err != nil {
		t.Fatalf("stageAPM: %v", err)
	}
	if len(capture.stageReqs) != 1 {
		t.Fatalf("stage calls = %d, want one per repository", len(capture.stageReqs))
	}
	req := capture.stageReqs[0]
	want := []string{
		"mattpocock/skills#v1.3.2",
		"cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#" + pstackSHA,
		"cursor/plugins/harness/pstack/claude-code/skills/how#" + pstackSHA,
		"acme/extras#v0.1.0",
	}
	if got := apm.RefsOf(req.Deps); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("staged deps =\n%v\nwant\n%v", got, want)
	}
	if len(req.Deps[2].Skills) != 1 || req.Deps[2].Skills[0] != "how" {
		t.Errorf("the skills subset never reached the stage request: %+v", req.Deps[2])
	}
	if req.PackageRef != "" {
		t.Errorf("PackageRef = %q, want empty: Deps is the list now, and setting both would let them disagree", req.PackageRef)
	}
	if req.LockDigest != axes.APMLockDigest {
		t.Errorf("the digest gate is not the profile's: %q", req.LockDigest)
	}
}

// A profile that attaches nothing and pins nothing stages nothing: no apm binary
// required, no error, exactly as before ADR-0084 — D-020's "no packaged context"
// is a legitimate configuration and must stay cheap.
func TestUnitStageAPMStagesNothingForAnUnpinnedProfile(t *testing.T) {
	capture := &depsCaptureAPM{}
	u := stageFixture(ProfileAxes{AgentProfileID: "p-1", LauncherID: "claude"}, capture)
	if err := u.stageAPM(context.Background(), UnitRequest{}); err != nil {
		t.Fatalf("stageAPM: %v", err)
	}
	if len(capture.stageReqs) != 0 {
		t.Errorf("stage calls = %d, want none", len(capture.stageReqs))
	}
	if len(u.Staged) != 0 {
		t.Errorf("staged = %v, want empty", u.Staged)
	}
}

// A collection set with no worker binary is a refusal, not a silent skip: the
// profile promises packaged context and running without it would be a different
// agent than the one configured. The message names the SET, so an operator reading
// a turn failure can tell which profile and which packages.
func TestUnitStageAPMRefusesWithoutTheBinaryForACollectionSet(t *testing.T) {
	u := stageFixture(ProfileAxes{
		AgentProfileID: "p-1", LauncherID: "claude", APMTarget: apm.TargetClaude,
		APMLockDigest: "sha256:" + strings.Repeat("2", 64),
		APMCollections: []apm.CollectionRevision{{
			CollectionID: "c-1", Slug: "matt-pocock-skills", Revision: 1,
			Entries: []apm.CollectionEntry{{Ref: "mattpocock/skills#v1.3.2"}},
		}},
	}, nil)
	u.svc.APM = nil
	err := u.stageAPM(context.Background(), UnitRequest{})
	if err == nil {
		t.Fatal("a collection-pinned profile ran without the apm binary it promises")
	}
	if !strings.Contains(err.Error(), "mattpocock/skills#v1.3.2") {
		t.Errorf("refusal should name the pinned set: %v", err)
	}
}

// A collection whose revision row was deleted underneath the profile is a refusal
// at staging time — the digest would move and the gate would blame the checkout.
func TestUnitStageAPMRefusesAnUnresolvableCollection(t *testing.T) {
	capture := &depsCaptureAPM{}
	u := stageFixture(ProfileAxes{
		AgentProfileID: "p-1", LauncherID: "claude", APMTarget: apm.TargetClaude,
		APMLockDigest: "sha256:" + strings.Repeat("2", 64),
		APMCollections: []apm.CollectionRevision{{
			CollectionID: "c-broken", Slug: "gone", Revision: 4,
			Entries: []apm.CollectionEntry{{Ref: "not a ref at all"}},
		}},
	}, capture)
	if err := u.stageAPM(context.Background(), UnitRequest{}); err == nil {
		t.Fatal("a malformed entry staged happily")
	} else if !strings.Contains(err.Error(), "gone@r4") {
		t.Errorf("the refusal should name the collection and revision: %v", err)
	}
	if len(capture.stageReqs) != 0 {
		t.Error("apm ran despite the unresolvable list")
	}
}

// pi has a target now, and it is agent-skills: without it a pi profile with any
// pin is refused, which is why the collection feature forced the decision
// (research §6). pi READING what lands there is spike A-1 and still UNVERIFIED —
// which is what the staging log says out loud rather than leaving to the reader.
func TestLauncherTargetMapsPiToTheSharedAgentSkillsTree(t *testing.T) {
	if got := launcherTarget("pi"); got != apm.TargetAgentSkills {
		t.Errorf("launcherTarget(pi) = %q, want %q", got, apm.TargetAgentSkills)
	}
	if got := launcherTarget("claude"); got != apm.TargetClaude {
		t.Errorf("launcherTarget(claude) = %q", got)
	}
	if got := launcherTarget("codex"); got != apm.TargetCodex {
		t.Errorf("launcherTarget(codex) = %q", got)
	}
	if got := launcherTarget("copilot"); got != "" {
		t.Errorf("launcherTarget(copilot) = %q, want \"\" (a launcher with no verified target stages nothing and says so)", got)
	}
}

// A pi profile whose target column is empty resolves its target from the launcher,
// and the staging records that the consuming half is unverified: a green turn must
// never read as "pi supports staged skills".
func TestUnitStageAPMForPiNamesTheUnverifiedHalf(t *testing.T) {
	logs := &bytes.Buffer{}
	capture := &depsCaptureAPM{}
	u := stageFixture(ProfileAxes{
		AgentProfileID: "p-pi", LauncherID: "pi",
		APMLockDigest: "sha256:" + strings.Repeat("2", 64),
		APMPackageRef: "mattpocock/skills#v1.3.2",
	}, capture)
	u.logger = slog.New(slog.NewTextHandler(logs, nil))
	if err := u.stageAPM(context.Background(), UnitRequest{}); err != nil {
		t.Fatalf("stageAPM: %v", err)
	}
	if len(capture.stageReqs) != 1 || capture.stageReqs[0].Target != apm.TargetAgentSkills {
		t.Fatalf("stage requests = %+v, want the agent-skills target resolved from the launcher", capture.stageReqs)
	}
	out := logs.String()
	if !strings.Contains(out, "UNVERIFIED") || !strings.Contains(out, "spike A-1") {
		t.Errorf("the staging log must record that pi reading .agents/skills is unverified, got:\n%s", out)
	}
}

// The lock loop resolves the SAME flattened list it was handed on the claim, so the
// digest the control plane records belongs to the set the operator looked at — and
// a claim queued before ADR-0084 (deps empty, the single ref set) still resolves
// the one package it always did.
func TestAPMLockLoopResolvesTheClaimedList(t *testing.T) {
	claim := APMLockClaim{
		RequestID: "lock-1", ProfileID: "p-1", OrganizationID: "o-1",
		Deps: []apm.Dep{
			{Ref: "mattpocock/skills#v1.3.2"},
			{Ref: "cursor/plugins/harness/pstack/claude-code/skills/how#" + pstackSHA, Skills: []string{"how"}},
		},
		Target: apm.TargetClaude, WorkerID: "w-1",
	}
	resolve := &fakeAPMTyper{result: &apm.ResolveResult{LockDigest: "sha256:" + strings.Repeat("3", 64)}}
	loop, err := NewAPMLockLoop(&fakeAPMLockStore{claimed: true, claim: claim}, resolve,
		func() string { return "w-1" },
		WithAPMLockLogger(slog.New(slog.NewTextHandler(discardWriter{}, nil))))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loop.apmResolve(context.Background(), claim, t.TempDir(), t.TempDir()); err != nil {
		t.Fatalf("apmResolve: %v", err)
	}
	got := apm.RefsOf(resolve.request.Deps)
	if len(got) != 2 || got[1] != "cursor/plugins/harness/pstack/claude-code/skills/how#"+pstackSHA {
		t.Errorf("resolved deps = %v, want the claimed list in order", got)
	}
	if skills := resolve.request.Deps[1].Skills; len(skills) != 1 || skills[0] != "how" {
		t.Errorf("the skills subset never reached the resolve: %+v", resolve.request.Deps[1])
	}

	legacy := APMLockClaim{RequestID: "lock-2", ProfileID: "p-2", OrganizationID: "o-1",
		PackageRef: "mattpocock/skills#v1.3.1", Target: apm.TargetClaude, WorkerID: "w-1"}
	if _, err := loop.apmResolve(context.Background(), legacy, t.TempDir(), t.TempDir()); err != nil {
		t.Fatalf("apmResolve(legacy claim): %v", err)
	}
	if resolve.request.PackageRef != "mattpocock/skills#v1.3.1" {
		t.Errorf("a pre-ADR-0084 claim lost its ref: %+v", resolve.request)
	}
}
