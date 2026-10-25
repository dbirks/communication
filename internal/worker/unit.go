package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// UnitService is the M3 execution unit: the thing that owns a workspace, stages
// what belongs in it, computes the sandbox policy for it, and captures what the
// agent did.
//
// ADR-0017 D9 defines a unit as "one agent process lifetime bound to one
// workspace". It gets its own type rather than another field on TurnLoop because
// the two have different lifetimes and different failure modes: a turn is a
// database row with a lease, a unit is a directory, a policy and a child
// process. M2 conflated them — a session was handed a workspace path and that
// was the end of it — which is why nothing in M2 could answer "what were this
// process's grants": no object had ever held them.
//
// UnitService also deliberately does *not* journal or exec. Journaling belongs
// to the turn loop, which is the only holder of a lease fence (ADR-0016 § 9: an
// unfenced worker may not write anything), and exec belongs to the ACP runtime,
// which owns the stdio pipes. What lives here is the ordering, which is
// contract § 4.2 and is not reorderable:
//
//	prepare (volumes, mirror, worktree) → stage APM → materialize secrets →
//	build the policy → [verify then launch] → capture → [publish] → clean up
//
// The first three run unsandboxed because they are the worker's own hands; from
// "build the policy" onward, everything the agent does is nono's or a descendant
// of it.
type UnitService struct {
	// Store persists workspace topology.
	Store WorkspaceStore
	// Workspaces is the git topology manager.
	Workspaces *wsgit.Manager
	// Sandbox enforces the policy. An interface so the loop is testable without
	// a kernel; the real implementation is *nono.Launcher.
	Sandbox AgentSandbox
	// Egress optionally reads one finished launch's own egress audit (ADR-0035).
	// It is nil in production and still works, because the nono launcher that IS
	// this worker's Sandbox answers AuditSessionEgress too; the field exists so a
	// test can hand the conversation path an audit it controls, exactly as
	// AgentTurn.Egress does for pipeline attempts.
	Egress EgressAuditor
	// APM stages a profile's packaged context before launch. Nil means no
	// packaged context is in play, which is a configuration (D-020: no default
	// MCP/CLI privileges), not a defect.
	APM APMTyper
	// Secrets materializes mounts. Nil is the same honest "not configured".
	Secrets SecretMaterializer
	// MirrorCredentials resolves a repository's ADR-0061 GitHub credential
	// before the mirror clone/fetch. It is a separate seam from Secrets
	// because it answers a different question ("what does the mirror's git
	// call send") and its plaintext must reach only the mirror's environment.
	// Nil means no resolve is wired: a repository that names a credential
	// then fails its prepare, it does not go anonymous.
	MirrorCredentials MirrorCredentialSource
	// Artifacts publishes the unit-boundary capture. Nil means the capture still
	// runs and still reports: an artifact is a record of work, and the absence of
	// a store must not hide the work itself.
	Artifacts ArtifactCapturer
	// Profiles resolves the axes a unit runs under.
	Profiles ProfileSource
	// LauncherAuth resolves a launcher's declared credential directories. A
	// launcher whose auth directory cannot be found must fail the launch rather
	// than start an agent that cannot log in: docs/compatibility/ACP.md recorded
	// that exact failure (an unreachable credential under a numeric uid) and it
	// presented as an agent problem.
	LauncherAuth func(launcherID string) ([]string, error)
	// PolicyDir is where the nono profile files are materialized.
	PolicyDir string
	// LauncherHome is nono's own HOME: a worker-owned directory under no
	// workspace and under no grant. Probe C-H1's refusal is permanent for a
	// directory that has ever been nono's HOME while a grant covered it, so this
	// one is chosen at startup and never derived from a workspace.
	LauncherHome string
	// ProfileKind selects the network axis (ADR-0019 D3).
	ProfileKind string
	// GitIdentity is seeded into the agent home's .gitconfig and exported to the
	// child, so a sandboxed `git commit` attributes without a global config
	// (probe P6: git aborts outright when its config is unreadable).
	GitIdentity acp.GitIdentityEnv
	// SandboxPath is the nono executable, recorded in the plan so the argv and
	// the process agree.
	SandboxPath string
	// Enforcement is this worker's configured mode. It is a field rather than a
	// per-request value because falling back from `required` is forbidden: a
	// unit can only ever run in the mode the worker was started with.
	Enforcement domain.EnforcementMode
	Logger      *slog.Logger

	profileOnce *profileCache
	memoMu      sync.Mutex
}

// profileCache memoizes the materialized policy file per kind, so a worker writes
// and digests each one once. It is not a verification cache: every launch still
// runs the whole chain, because ADR-0019's suggestion to "cache per (policy
// digest, worker boot)" is about the cost of three nono invocations, and
// Verified is still only ever reported for the unit that earned it.
type profileCache struct {
	mu sync.Mutex
	m  map[string]*nono.Profile
}

func (c *profileCache) do(key string, fn func() (*nono.Profile, error)) (*nono.Profile, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]*nono.Profile{}
	}
	if p, ok := c.m[key]; ok {
		return p, nil
	}
	p, err := fn()
	if err != nil {
		return nil, err
	}
	c.m[key] = p
	return p, nil
}

// AgentSandbox is the seam UnitService consumes. The shape is what a workspace
// plan needs — a profile plus a resolved grant set — which
// domain.SandboxLauncher's plain path lists cannot carry without losing the role
// names the journal is required to report.
type AgentSandbox interface {
	// Verify runs N-a…N-d for one launch and execs nothing.
	Verify(ctx context.Context, spec nono.LaunchSpec) (*nono.VerificationResult, error)
	// Probe reports backend capabilities (N-a's own commands).
	Probe(ctx context.Context) (domain.SandboxCapabilities, error)
}

// ProfileAxes are the per-profile settings a unit reads out of the 00004 columns.
// They travel here rather than on domain.AgentProfileRevision because
// internal/domain is outside this milestone's boundaries, and because a sandbox
// axis is worker-side execution detail the domain vocabulary has no reason to
// carry.
type ProfileAxes struct {
	AgentProfileID     string
	Revision           int
	LauncherID         string
	WorkspaceMode      string
	CommitGranted      bool
	SandboxEnforcement domain.EnforcementMode
	APMPackageRef      string
	APMTarget          string
	APMLockDigest      string
	// ExcludedPaths is the project's declared exclusion set (ADR-0017 D6): the
	// secret-mount and APM-staging paths that must never reach a commit or an
	// artifact. It is project-scoped because that is the only scope git honors in
	// a linked-worktree layout (probes X1/X3), which is deviation D3.
	ExcludedPaths []string
}

// ProfileSource reads the axes of the profile revision a conversation is pinned
// to. Pinning is the control plane's job (ADR-0008: a run keeps its revision);
// this is only the read.
type ProfileSource interface {
	ProfileFor(ctx context.Context, conversationID string) (ProfileAxes, error)
}

// UnitRequest is what a unit is created from.
type UnitRequest struct {
	OrganizationID string
	ProjectID      string
	ConversationID string
	TurnID         string
	WorkerID       string
	// LauncherID is the claim's launcher, and the only launcher a unit will
	// resolve credential directories for.
	LauncherID string
	// Axes are the profile settings the unit runs under — including the project's
	// declared exclusion set, which is why it travels with the axes rather than
	// with the repositories (ADR-0017 D6 made exclusions project-scoped).
	Axes ProfileAxes
	// FencingToken is the claim's lease token. It travels to the capture seam
	// because the artifact row and its event land in one transaction that proves
	// the writing worker still owns the turn (ADR-0016 § 9.2), and because
	// capture runs after the terminal write — the triple check, not a status
	// check, is what makes that legal.
	FencingToken int64
	// Repos are the project's repositories, with identities: workspace_repos has
	// an FK to repositories(id) and a name cannot fill it.
	Repos []ProjectRepo
}

// ProjectRepo is one repository with its identity.
type ProjectRepo struct {
	ID            string
	Name          string
	GitURL        string
	DefaultBranch string
	// CredentialSecretID (ADR-0061): non-empty when the repository's mirror
	// clone/fetch must resolve this project's GitHub credential first.
	CredentialSecretID string
}

// MirrorCredentialSource is the ADR-0061 seam between the unit and the
// secret store: it resolves one repository's GitHub credential (consumer
// repo_mirror, fixed by the implementation side of this boundary) to the
// bearer token the mirror's clone/fetch runs with. The returned string is
// material: the unit hands it to exactly one wsgit.RepoSpec, whose Token
// field reaches only the mirror child process's environment — never argv,
// never the worktree, never an error string the loop journals.
type MirrorCredentialSource interface {
	ResolveMirrorCredential(ctx context.Context, repositoryID, workerID string) (string, error)
}

// ErrMirrorCredential is what a prepare refuses with when a repository's
// credential cannot be resolved. It names the repository, never a value.
var ErrMirrorCredential = errors.New("worker: repository GitHub credential could not be resolved")

// mirrorSpec builds one RepoSpec, resolving the ADR-0061 credential when the
// repository names one. Fail closed: an unwired seam or a refused resolve is
// a prepare failure that says which repository, because a mirror cloned
// anonymously against a private repository produces a worse failure (a
// confusing git auth error mid-fetch) and a lie about what was prepared.
// workerID is the audit actor for the resolve (the claim's worker; "" lets
// the store name the process).
func (s *UnitService) mirrorSpec(ctx context.Context, r ProjectRepo, workerID string) (wsgit.RepoSpec, error) {
	spec := wsgit.RepoSpec{RepositoryID: r.ID, Name: r.Name, GitURL: r.GitURL, DefaultBranch: r.DefaultBranch}
	if r.CredentialSecretID == "" {
		return spec, nil
	}
	if s.MirrorCredentials == nil {
		return wsgit.RepoSpec{}, fmt.Errorf("%w: repository %q has a GitHub credential but this worker has no credential resolver wired", ErrMirrorCredential, r.Name)
	}
	token, err := s.MirrorCredentials.ResolveMirrorCredential(ctx, r.ID, workerID)
	if err != nil {
		return wsgit.RepoSpec{}, fmt.Errorf("%w: repository %q: %v", ErrMirrorCredential, r.Name, err)
	}
	spec.Token = token
	return spec, nil
}

// Unit is one execution unit: the workspace, the policy computed for it, and
// what came back.
type Unit struct {
	svc *UnitService

	WorkspaceID    string
	OrganizationID string
	ProjectID      string
	ConversationID string
	TurnID         string
	WorkerID       string
	// FencingToken is the claim's lease token, kept so the unit-boundary
	// capture can publish artifacts under the same fence that wrote the turn's
	// terminal state (ADR-0016 § 9.2).
	FencingToken int64

	Layout wsgit.Layout
	Repos  []wsgit.PreparedRepo
	// Plan is the resolved grant set, the two HOMEs and the cwd.
	Plan wsgit.LaunchPlan
	// Verified is the chain's output; nil until Launch has run.
	Verified *nono.VerificationResult
	// Staged maps repository name to what APM put there.
	Staged map[string]*apm.StagedContext
	// Materialized is the secret hook's answer.
	Materialized *Materialized
	// ExcludedPaths is the unit's full declared set: project set + APM-generated
	// + materialized, deduped and sorted so a digest over it is stable.
	ExcludedPaths []string
	// Profile keeps the axes: capture and cleanup both need commit_granted and
	// the APM target.
	Profile ProfileAxes
	// Enforcement is the mode this unit ran under — recorded, not inferred. A
	// unit that ran with isolation="none" has to be able to prove that about
	// itself from its own record.
	Enforcement domain.EnforcementMode

	// secretFiles lists materialized files for the cleanup assertion.
	secretFiles []string
	// workspaceVolume is the identity the claim was made against, kept for
	// workspace.prepared's readback.
	workspaceVolume string
	// rows maps repository id to its workspace_repos row id, which is what
	// workspace_commits is keyed by.
	rows map[string]string
	// cleanupOnce makes Cleanup idempotent: the turn loop calls it on every exit
	// path (success, failure, cancellation, panic-recovery) and the second call
	// must not double-report a release.
	cleanupOnce sync.Once
	released    bool
	cleanupErr  error
	logger      *slog.Logger
}

// Prepare runs contract § 4.2 steps 1 through 4 and returns a unit that has
// launched nothing.
//
// A failure is always visible in two places — a transcript note *and* a
// workspaces.state transition. M2's "clone failed, keep chatting" survives only
// for a conversation with no repositories, and a `ready` workspace never
// silently lacks one.
func (s *UnitService) Prepare(ctx context.Context, req UnitRequest) (*Unit, error) {
	if s == nil {
		return nil, errors.New("worker: no unit service")
	}
	if s.Workspaces == nil || s.Store == nil {
		return nil, errors.New("worker: the unit service needs a workspace manager and a store")
	}
	if req.ConversationID == "" || req.ProjectID == "" || req.WorkerID == "" {
		return nil, errors.New("worker: a unit request needs a conversation, a project and a worker")
	}
	log := s.logger()
	// The launcher always comes from the request, never from the stored axes.
	// A profile revision naming a different launcher than the control plane
	// claimed for *this* turn would otherwise put one launcher's credential
	// directories, and one launcher's auth environment, onto another launcher's
	// process — a failure with no visible cause.
	req.Axes.LauncherID = req.LauncherID
	// ADR-0019 D6's ceiling, applied in the one direction it runs: a profile may
	// ask for *less* isolation than the worker provides and gets it (that is what
	// `permissive-dev` is for, and every event from such a unit says so), but a
	// profile that asks for more than the worker can give gets the worker's mode
	// and a recorded refusal rather than a negotiation.
	//
	// The reason the ceiling is the *worker* is that the mode is a property of the
	// host — whether nono exists, whether Landlock is live — and a database row
	// cannot make an unverifiable machine verifiable. Silently honoring a profile's
	// `required` on a `disabled` worker would report a security guarantee that the
	// process could not keep.
	if asked := req.Axes.SandboxEnforcement; asked != "" && asked != s.enforcement() {
		if rankEnforcement(asked) > rankEnforcement(s.enforcement()) {
			log.Warn("agent profile requests stronger sandbox enforcement than this worker provides; the worker's configured mode is the ceiling",
				slog.String("agent_profile_id", req.Axes.AgentProfileID),
				slog.String("profile_requests", string(asked)),
				slog.String("worker_mode", string(s.enforcement())))
		}
		req.Axes.SandboxEnforcement = s.enforcement()
	}

	vols, err := s.Workspaces.Measure()
	if err != nil {
		return nil, fmt.Errorf("worker: measure storage roots: %w", err)
	}
	wsVol, ok := vols[wsgit.RootKindWorkspaces]
	if !ok {
		return nil, errors.New("worker: the workspaces root could not be measured")
	}
	reposVol, ok := vols[wsgit.RootKindRepos]
	if !ok {
		return nil, errors.New("worker: the mirror root could not be measured")
	}
	// Both roots are recorded on every unit prepare (cheap, and it keeps
	// observed_at honest). V5b is the reason there are two: in the lab they share
	// a device and differ only by inode, so one measurement could only ever have
	// answered for one of them, and case 20 asks about both.
	for _, v := range []wsgit.Volume{wsVol, reposVol} {
		if err := s.Store.RecordVolume(ctx, VolumeRecord{
			WorkerID: req.WorkerID, RootKind: v.RootKind, RootPath: v.Path,
			StDev: v.StDev, StIno: v.StIno, FSType: v.FSType, VolumeID: v.ID,
		}); err != nil {
			return nil, err
		}
	}

	mode, err := normalizeMode(req.Axes.WorkspaceMode)
	if err != nil {
		return nil, err
	}
	decision, err := s.Store.ClaimWorkspace(ctx, WorkspaceClaim{
		OrganizationID: req.OrganizationID, ProjectID: req.ProjectID,
		ConversationID: req.ConversationID, WorkerID: req.WorkerID,
		VolumeID: wsVol.ID, RootPath: filepath.Join(wsVol.Path, req.ConversationID),
		Mode: mode,
		// Case 20's reportable reason: the row is moving to `lost` because the
		// volume identity changed. There is no free-text field in that event, so
		// the enum is the whole story the browser is allowed.
		Reason: events.RecoveryVolumeChanged,
	})
	if err != nil {
		return nil, err
	}
	switch decision.Kind {
	case DecisionQuarantined:
		// A quarantined workspace is not reusable by definition (ADR-0017 D3):
		// the reason it was quarantined is a security condition, and launching
		// an agent back into that tree is the bug rather than the workaround.
		return nil, fmt.Errorf("worker: workspace %s is quarantined and cannot be reused", decision.WorkspaceID)
	case DecisionLost:
		// Case 20's honest arm: the prior edits are gone, the row says so, and
		// nothing here may be described as a resume.
		if err := s.Store.WorkspaceEvent(ctx, req.OrganizationID, req.ProjectID, req.ConversationID, TurnEvent{
			Type: events.TypeWorkspaceRecoveryLost, ActorKind: events.ActorKindWorker, ActorID: req.WorkerID,
			Payload: events.WorkspaceRecoveryLostPayload{
				WorkspaceID: decision.WorkspaceID, ProjectID: req.ProjectID,
				ExpectedVolumeID: decision.ExpectedVolume, FoundVolumeID: decision.FoundVolume,
				Reason: events.RecoveryVolumeChanged,
			},
		}); err != nil {
			log.Warn("workspace.recovery_lost could not be journalled", slog.String("error", err.Error()))
		}
	}

	specs := make([]wsgit.RepoSpec, 0, len(req.Repos))
	for _, r := range req.Repos {
		spec, err := s.mirrorSpec(ctx, r, req.WorkerID)
		if err != nil {
			return nil, err
		}
		specs = append(specs, spec)
	}
	prep, err := s.Workspaces.Prepare(ctx, wsgit.PrepareRequest{
		ScopeKind: "conversation", ScopeID: req.ConversationID, ProjectID: req.ProjectID,
		WorkspaceVolumeID: wsVol.ID, MirrorVolumeID: reposVol.ID,
		Mode: mode, Repos: specs, ExcludedPaths: req.Axes.ExcludedPaths,
	})
	if err != nil {
		// Whatever row exists stays `preparing`: `ready` is the claim that the
		// tree is what the rows say it is.
		if len(req.Repos) == 0 {
			// No repositories at all: this is the one shape M2's lenience
			// survives in, and it is reported as a note by the caller.
			return nil, fmt.Errorf("worker: prepare workspace: %w", err)
		}
		return nil, fmt.Errorf("worker: prepare workspace for project %s: %w", req.ProjectID, err)
	}

	unit := &Unit{
		svc:         s,
		WorkspaceID: decision.WorkspaceID, OrganizationID: req.OrganizationID,
		ProjectID: req.ProjectID, ConversationID: req.ConversationID,
		TurnID: req.TurnID, WorkerID: req.WorkerID,
		FencingToken: req.FencingToken,
		Layout:       prep.Layout, Repos: prep.Repos, Staged: map[string]*apm.StagedContext{},
		workspaceVolume: prep.WorkspaceVolume,
		Profile:         req.Axes,
		Enforcement:     s.enforcement(), logger: log,
	}

	// A commit-granting profile with no configured identity is a refusal, not a
	// warning: the four mirror-write grants say the agent *may* write a ref, and
	// with GIT_CONFIG_NOSYSTEM set and the agent's HOME being its own tree there
	// is no other identity source, so the turn would die on git's "Please tell me
	// who you are" after the workspace had already been claimed and evented.
	// Refusing here costs a `preparing` row instead.
	if req.Axes.CommitGranted && (s.GitIdentity.Name == "" || s.GitIdentity.Email == "") {
		// Deliberately not quarantined: the tree is sound, the *configuration* is
		// wrong, and ADR-0017 D3's quarantine reasons are all security conditions about
		// a workspace. It stays `preparing`, which is the state that means "this is not
		// usable and the rows know it".
		return nil, fmt.Errorf("worker: profile %s grants commits but COMMUNICATION_AGENT_GIT_NAME/EMAIL are unset: the agent's own `git commit` would fail with no global config to inherit (probe P6)", req.Axes.AgentProfileID)
	}
	// The agent's HOME needs its git identity seeded before anything can commit
	// in there (probe P6), and before APM runs (probe A2: apm writes into HOME).
	if err := s.Workspaces.SeedAgentHome(unit.Layout.Home, wsgit.GitIdentity{
		Name: s.GitIdentity.Name, Email: s.GitIdentity.Email,
	}); err != nil {
		return unit, err
	}

	if err := unit.stageAPM(ctx, req); err != nil {
		return unit, err
	}
	if err := unit.materializeSecrets(ctx, req); err != nil {
		return unit, err
	}
	// The exclusion set is now complete: whatever APM generated and whatever the
	// secret materializer wrote has to be in <mirror>/info/exclude *before* the
	// agent's first commit, because an exclusion established afterwards missed a
	// capture (ADR-0017 D6).
	if err := unit.declareLateExclusions(ctx); err != nil {
		return unit, err
	}
	unit.ExcludedPaths = mergePaths(req.Axes.ExcludedPaths, unit.stagedPaths(), unit.secretRelative())
	if err := unit.rebuildPlan(); err != nil {
		return unit, err
	}

	rows := make([]WorkspaceRepo, 0, len(prep.Repos))
	for _, r := range prep.Repos {
		rows = append(rows, WorkspaceRepo{
			WorkspaceID: unit.WorkspaceID, OrganizationID: unit.OrganizationID, ProjectID: unit.ProjectID,
			RepositoryID: r.RepositoryID, CheckoutPath: r.CheckoutPath, MirrorPath: r.MirrorPath,
			MirrorVolumeID: r.MirrorVolume, AdminDir: r.AdminDir, RunRef: r.RunRef,
			BaseCommit: r.BaseCommit, ExcludedPaths: unit.ExcludedPaths,
		})
	}
	// The rows and the `preparing → ready` move are one transaction: a workspace
	// that is ready without its repo rows would be the "ready workspace that
	// silently lacks a repo" the contract forbids.
	if err := s.Store.RecordRepos(ctx, unit.WorkspaceID, rows, true); err != nil {
		return unit, err
	}
	// The row ids come back from the read, because workspace_commits references
	// workspace_repos(id) and a worker that guessed them would fail the commit
	// record silently at exactly the boundary where it matters.
	persisted, err := s.Store.WorkspaceRepos(ctx, unit.WorkspaceID)
	if err != nil {
		return unit, err
	}
	unit.rows = map[string]string{}
	for _, row := range persisted {
		unit.rows[row.RepositoryID] = row.RowID
	}
	return unit, nil
}

// Verify computes the argv, runs N-a…N-d, and returns what the runtime should
// exec. It never execs: the stdio pipes belong to the ACP runtime, and a sandbox
// adapter that owned them could not be tested without a harness.
//
// On refusal the returned error is a *DenialError carrying the stage and reason
// the sandbox.enforcement_failed event needs. Nothing runs unsandboxed as a
// result of a refusal, in any mode.
func (u *Unit) Verify(ctx context.Context, launcher acp.Launcher) (acp.LaunchPlan, error) {
	if u == nil {
		return acp.LaunchPlan{}, errors.New("worker: no unit")
	}
	// ADR-0040: the launcher's long-lived token is read from the operator
	// file at launch time. It rides nono's own process environment under a
	// sandbox (or, unsandboxed, the adapter's exec environment) and never
	// the adapterEnv `env NAME=value` argv hop, which nono's audit journal
	// records verbatim. A misconfigured file fails the turn closed.
	kv, err := launcher.OAuthTokenKV()
	if err != nil {
		return acp.LaunchPlan{}, err
	}
	if u.Enforcement == domain.EnforceDisabled || u.Enforcement == domain.EnforcePermissiveDev {
		// The two configured non-required modes are still explicit about what
		// they are: isolation="none" rides every event about them (05).
		return u.plainPlan(launcher, string(u.Enforcement), kv), nil
	}
	spec, err := u.launchSpec(launcher)
	if err != nil {
		return acp.LaunchPlan{}, &DenialError{Stage: events.SandboxStageGrantAssert, Reason: denialReason(err), Message: err.Error()}
	}
	res, verr := u.svc.Sandbox.Verify(ctx, spec)
	if verr != nil {
		var f *nono.Failure
		if errors.As(verr, &f) {
			return acp.LaunchPlan{}, &DenialError{
				Stage: f.Stage, Reason: f.Reason, Message: f.Error(),
				PolicyDigest: digestOr(res), ChildStarted: f.ChildStarted,
			}
		}
		return acp.LaunchPlan{}, &DenialError{
			Stage: events.SandboxStageGrantAssert, Reason: events.SandboxReasonGrantMismatch,
			Message: verr.Error(), PolicyDigest: digestOr(res),
		}
	}
	u.Verified = res
	argv, err := spec.BuildLaunchArgv()
	if err != nil {
		return acp.LaunchPlan{}, &DenialError{Stage: events.SandboxStageGrantAssert, Reason: events.SandboxReasonGrantMismatch, Message: err.Error(), PolicyDigest: res.PolicyDigest}
	}
	bin := u.svc.nonoBinary()
	env := u.svc.launcherNonoEnv()
	if kv != "" {
		// The token reaches the child because nono inherits its own process
		// environment into the sandboxed child (ADR-0040); argv carries no
		// secrets and the audit journal records argv verbatim.
		env = append(env, kv)
	}
	if u.Materialized != nil {
		// ADR-0040: the env-delivered secret mounts ride the launched process's
		// environment (execEnv), never the argv `env` hop the audit journal
		// records verbatim; GitPushEnv derives the GitHub token wiring from the
		// delivered entries. Later additions win, so an authorized mount outranks
		// launcher env (ADR-0018 D4).
		gitEnv := GitPushEnv(u.Materialized.Env)
		env = execEnv(env, gitEnv, u.Materialized.Env)
		if len(gitEnv) > 0 {
			// ADR-0045 follow-up (2026-10-22, product owner decision): the GitHub CLI
			// the agent execs as its child needs a writable config dir under the
			// agent's HOME plus the non-interactive flags — same exec-environment
			// channel, and only for attempts that delivered a token.
			env = execEnv(env, GitPushToolEnv(u.Plan.AgentHome))
		}
	}
	return acp.LaunchPlan{
		Path:     bin,
		Args:     argv,
		Env:      env,
		Dir:      u.Plan.Cwd,
		Verified: verification(res, u.Plan),
	}, nil
}

// launchSpec assembles the nono launch: profile, plan, the two HOMEs, and the
// adapter argv with its environment.
// DomainLaunch converts the unit's resolved plan into the neutral launch shape
// the ACP runtime consumes. Kept as a method so the mapping from grant roles to
// journal labels lives in one file.
func (u *Unit) launchSpec(launcher acp.Launcher) (nono.LaunchSpec, error) {
	if u.svc.Sandbox == nil {
		return nono.LaunchSpec{}, errors.New("worker: no sandbox backend configured while enforcement is required")
	}
	prof, err := u.svc.profile()
	if err != nil {
		return nono.LaunchSpec{}, err
	}
	env, err := u.adapterEnv(launcher)
	if err != nil {
		return nono.LaunchSpec{}, err
	}
	// The argv-bound half of the ADR-0040 rule: the adapter env the launcher's
	// `env` hop renders into argv carries no delivered secret entry — the
	// delivered mounts ride the exec environment (the plan's Env) instead.
	delivered := []string(nil)
	if u.Materialized != nil {
		delivered = u.Materialized.Env
	}
	return nono.LaunchSpec{
		Profile: prof, Plan: u.Plan, LauncherHome: u.svc.LauncherHome,
		AdapterPath: launcher.Executable, AdapterArgs: launcher.Args, AdapterEnv: argvBoundEnv(env, delivered),
	}, nil
}

// adapterEnv is the agent's environment, built from scratch.
//
// This is the leak ADR-0019 D1 names: the pre-M3 runtime fell back to
// os.Environ(), which handed every launched agent the worker's environment —
// `COMMUNICATION_DATABASE_URL` included. Nothing here inherits.
func (u *Unit) adapterEnv(launcher acp.Launcher) ([]string, error) {
	auth, err := u.svc.credentialEnv(launcher)
	if err != nil {
		return nil, err
	}
	var secretEnv []string
	if u.Materialized != nil {
		secretEnv = u.Materialized.Env
	}
	extra := []string{"COMMUNICATION_WORKSPACE_ID=" + u.WorkspaceID}
	if u.TurnID != "" {
		// The conversation path's egress-audit marker (ADR-0035, ADR-0036's
		// coverage row): nono records the child's argv in its audit journal, so
		// this entry is what lets a finished turn find ITS OWN session rather than
		// the newest one on the worker. The pipeline attempt carries the same
		// evidence as COMMUNICATION_ATTEMPT_ID (agentturn.go).
		extra = append(extra, egressTurnMarker(u.TurnID))
	}
	env, err := acp.LaunchEnv(acp.EnvRequest{
		Home:    u.Layout.Home,
		Scratch: u.Layout.Scratch,
		// Under a sandbox the launcher's `env HOME=…` hop owns HOME; naming it
		// here too is exactly the confusion C-H1 is about, and nono's argv
		// builder refuses a caller-supplied HOME outright. Without a sandbox
		// there is no hop, so HOME has to come from here.
		OmitHome:    u.hopsHome(),
		GitIdentity: u.svc.GitIdentity,
		Auth:        auth,
		SecretEnv:   secretEnv,
		Extra:       extra,
	})
	if err != nil {
		return nil, err
	}
	return env, nil
}

// hopsHome reports whether the launcher will apply the agent's HOME itself.
func (u *Unit) hopsHome() bool {
	return u.Enforcement == domain.EnforceRequired && u.svc.Sandbox != nil
}

// plainPlan is the non-required-mode plan: the adapter itself, with the same
// from-scratch environment, labelled with the mode so nothing can read the turn
// as sandboxed.
func (u *Unit) plainPlan(launcher acp.Launcher, mode string, oauthKV string) acp.LaunchPlan {
	env, err := u.adapterEnv(launcher)
	if err != nil {
		// A broken credential configuration in a *non-required* mode is the
		// mode's whole purpose: the operator asked for the run anyway, and the
		// label says it ran with nothing.
		env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + u.Layout.Home}
		u.logger.Warn("adapter environment could not be built for an unsandboxed launch",
			slog.String("mode", mode), slog.String("error", err.Error()))
	}
	if oauthKV != "" {
		// Unsandboxed (ADR-0040): the token joins the adapter's real exec
		// environment — an environment, not argv.
		env = append(env, oauthKV)
	}
	if u.Materialized != nil {
		// ADR-0045 / ADR-0040: the GitHub token wiring and the env-delivered mounts
		// join the exec environment; the unsandboxed plan carries no argv hop.
		gitEnv := GitPushEnv(u.Materialized.Env)
		env = execEnv(env, gitEnv, u.Materialized.Env)
		if len(gitEnv) > 0 {
			// ADR-0045 follow-up (2026-10-22, product owner decision): the GitHub CLI
			// the agent execs as its child needs a writable config dir under the
			// agent's HOME plus the non-interactive flags — same exec-environment
			// channel, and only for attempts that delivered a token.
			env = execEnv(env, GitPushToolEnv(u.Layout.Home))
		}
	}
	return acp.LaunchPlan{
		Path: launcher.Executable, Args: launcher.Args, Env: env, Dir: u.Plan.Cwd,
		Unsandboxed: mode,
	}
}

// LaunchSpecFor exposes the resolved nono launch for `communication doctor` and
// for tests that want to inspect the argv without exec'ing it.
func (u *Unit) LaunchSpecFor(launcher acp.Launcher) (nono.LaunchSpec, error) {
	return u.launchSpec(launcher)
}

// WorkDir is the cwd for the launched adapter: the first checkout, or scratch
// when the project has no repository. Never the workspace root, and never the
// agent root: under a sandbox the root's *parent* contains meta/, and probe
// C-CWD showed a cwd outside the grants silently relocating the child to /
// rather than refusing the launch.
func (u *Unit) WorkDir() string { return u.Plan.Cwd }

// rebuildPlan recomputes the grant set. It exists because the credential
// directories and the exclusion set are not known at topology time, and because
// a plan built from assumptions about a tree is exactly what probe C-FC3's
// silent grant-drop punishes: every path in it is checked to exist here, before
// anything is launched.
func (u *Unit) rebuildPlan() error {
	dirs, err := u.svc.credentialDirs(u.Profile.LauncherID)
	if err != nil {
		return err
	}
	plan, err := wsgit.Plan(&wsgit.PreparedWorkspace{Layout: u.Layout, Repos: u.Repos}, wsgit.PlanOptions{
		WorkspaceID: u.WorkspaceID, CommitGranted: u.Profile.CommitGranted,
		LauncherHome: u.svc.LauncherHome, HarnessCredentialDirs: dirs,
	})
	if err != nil {
		return fmt.Errorf("worker: resolve the sandbox grant set for workspace %s: %w", u.WorkspaceID, err)
	}
	u.Plan = plan
	return nil
}

// stageAPM is contract § 4.2 step 2, per repository.
//
// A digest mismatch refuses rather than warns: probe A5 showed
// `apm install --frozen` will put mutated content live while reporting that the
// lockfile is present, so the recorded digest is the only control that sees it —
// and case 14 is the test that says so out loud.
func (u *Unit) stageAPM(ctx context.Context, req UnitRequest) error {
	if u.Profile.APMPackageRef == "" {
		return nil // no packaged context for this profile (D-020)
	}
	if u.svc.APM == nil {
		return fmt.Errorf("worker: profile %s pins apm_package_ref=%s but this worker has no apm binary configured: refusing to run a turn without the context the profile promises", u.Profile.AgentProfileID, u.Profile.APMPackageRef)
	}
	target := u.Profile.APMTarget
	if target == "" {
		target = launcherTarget(u.Profile.LauncherID)
	}
	if !apm.ValidTarget(target) {
		return fmt.Errorf("worker: profile %s has apm target %q, which is not an apm target", u.Profile.AgentProfileID, target)
	}
	for i := range u.Repos {
		repo := &u.Repos[i]
		staged, err := u.svc.APM.Stage(ctx, apm.StageRequest{
			Checkout: repo.CheckoutPath, Target: target,
			PackageRef: u.Profile.APMPackageRef, LockDigest: u.Profile.APMLockDigest,
			Home: u.Layout.Home,
		})
		switch {
		case errors.Is(err, apm.ErrNothingStaged):
			continue
		case err != nil:
			return fmt.Errorf("worker: stage apm context into %s: %w", repo.Name, err)
		}
		u.Staged[repo.Name] = staged
	}
	return nil
}

// materializeSecrets is contract § 4.2 step 3.
func (u *Unit) materializeSecrets(ctx context.Context, req UnitRequest) error {
	if u.svc.Secrets == nil {
		return nil
	}
	var extra []string
	repos := make([]MaterializeRepo, 0, len(u.Repos))
	for _, r := range u.Repos {
		repos = append(repos, MaterializeRepo{ID: r.RepositoryID, Name: r.Name,
			CheckoutPath: r.CheckoutPath, MirrorPath: r.MirrorPath})
	}
	m, err := u.svc.Secrets.Materialize(ctx, MaterializeRequest{
		OrganizationID: u.OrganizationID, ProjectID: u.ProjectID, WorkspaceID: u.WorkspaceID,
		ConversationID: u.ConversationID, TurnID: u.TurnID, WorkerID: u.WorkerID,
		AgentProfileID: u.Profile.AgentProfileID, Repos: repos, ExtraExclusions: &extra,
		PolicyDigest: u.policyDigest(),
		// A turn is not an attempt: the node_attempt arm stays unread here and
		// is materialized by the attempt that owns it (contract § 4 step 4).
		// M2/M3 behaviour is otherwise byte-for-byte unchanged.
		Lifecycle: LifecycleTurn,
	})
	if err != nil {
		return fmt.Errorf("worker: materialize secrets for workspace %s: %w", u.WorkspaceID, err)
	}
	u.Materialized = &m
	u.secretFiles = m.Files
	return nil
}

// declareLateExclusions pushes the paths that only became known after the tree
// was prepared — APM's generated trees (probe A6: they are git-visible until the
// exclusion file names them) and the materialized secret files — into each
// repository's project exclusion file.
func (u *Unit) declareLateExclusions(ctx context.Context) error {
	late := mergePaths(u.stagedPaths(), u.secretRelative())
	if len(late) == 0 {
		return nil
	}
	for i := range u.Repos {
		repo := &u.Repos[i]
		// A secret materialized at an absolute path outside this checkout is not
		// this repository's exclusion; the artifact filter still sees it through
		// Unit.ExcludedPaths, which is the second line of defence ADR-0017 D6
		// requires regardless of git.
		local := make([]string, 0, len(late))
		for _, p := range late {
			if strings.HasPrefix(p, "/") {
				continue
			}
			local = append(local, p)
		}
		if len(local) == 0 {
			continue
		}
		if _, err := u.svc.Workspaces.DeclareExclusions(ctx, repo, local); err != nil {
			return fmt.Errorf("worker: declare exclusions for %s: %w", repo.Name, err)
		}
	}
	return nil
}

// stagedPaths are APM's generated paths, relative to their checkout, so they can
// join the exclusion set.
func (u *Unit) stagedPaths() []string {
	var out []string
	for _, staged := range u.Staged {
		out = append(out, staged.GeneratedPaths...)
	}
	return out
}

// secretRelative is where the materialized files sit relative to their checkout.
// A path outside every checkout is kept as-is: it belongs to the scratch tree,
// and the exclusion set is per-repository, so it is the *artifact* filter that
// has to see it (ADR-0017 D6's second line of defence is not repository-scoped).
func (u *Unit) secretRelative() []string {
	var out []string
	for _, file := range u.secretFiles {
		rel := file
		for _, r := range u.Repos {
			if inside(r.CheckoutPath, file) {
				rel = strings.TrimPrefix(file, r.CheckoutPath+"/")
				break
			}
		}
		out = append(out, rel)
	}
	return out
}

// DenialError is a sandbox refusal carrying the event fields. The turn loop maps
// it onto sandbox.enforcement_failed and then onto
// conversation.turn.failed{reason: "sandbox_enforcement_failed"} — never
// `interrupted`, and never a fallback run (ADR-0019 D6).
type DenialError struct {
	Stage        string
	Reason       string
	Message      string
	PolicyDigest string
	ChildStarted bool
}

func (e *DenialError) Error() string {
	return fmt.Sprintf("worker: sandbox %s refused the launch (%s): %s", e.Stage, e.Reason, e.Message)
}

// ProfileDigestFor reads back the digest of the policy this worker would launch
// under, without running any nono command. `communication doctor` prints it next
// to the verdict so an operator can tell which policy file a green check
// describes.
func (s *UnitService) ProfileDigestFor(kind string) (string, error) {
	if kind == "" {
		kind = s.kind()
	}
	prof, err := s.materializeProfile(kind)
	if err != nil {
		return "", err
	}
	return prof.Digest, nil
}

// profile returns this worker's policy file for its configured kind, writing it
// if this process has not yet done so.
func (s *UnitService) profile() (*nono.Profile, error) {
	return s.cache().do(s.kind(), func() (*nono.Profile, error) { return s.materializeProfile(s.kind()) })
}

// cache returns the profile memo, initializing it on first use. The field is
// unexported and the struct is built with a literal by cmd/communication, so a
// lazily-created memo is the only shape that cannot be nil at the point of use —
// and a panic inside a launch path is a worse failure than a mutex allocation.
func (s *UnitService) cache() *profileCache {
	s.memoMu.Lock()
	defer s.memoMu.Unlock()
	if s.profileOnce == nil {
		s.profileOnce = &profileCache{}
	}
	return s.profileOnce
}

func (s *UnitService) materializeProfile(kind string) (*nono.Profile, error) {
	if s.PolicyDir == "" {
		return nil, errors.New("worker: no policy directory is configured, so no profile file can be materialized (ADR-0009 D4 requires -p <path>: with CLI flags alone, nono mixes its built-in default profile in, and that default is what writes /tmp)")
	}
	return nono.WriteProfile(s.PolicyDir, kind)
}

func (s *UnitService) kind() string {
	if s.ProfileKind != "" {
		return s.ProfileKind
	}
	return nono.ProfileAgentTurn
}

func (s *UnitService) enforcement() domain.EnforcementMode {
	if s.Enforcement == "" {
		return domain.EnforceRequired
	}
	return s.Enforcement
}

func (s *UnitService) credentialDirs(launcherID string) ([]string, error) {
	if s.LauncherAuth == nil {
		return nil, nil
	}
	dirs, err := s.LauncherAuth(launcherID)
	if err != nil {
		return nil, err
	}
	// Every declared credential directory must exist before it can be granted:
	// probe C-FC3's silent drop means a missing one would come back as a sandbox
	// that merely cannot log in, which docs/compatibility/ACP.md already
	// documented as confusing (it looked like an agent bug).
	for _, dir := range dirs {
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return nil, fmt.Errorf("worker: launcher %q declares a credential directory at %s that is not usable: %v", launcherID, dir, err)
		}
	}
	return dirs, nil
}

func (s *UnitService) credentialEnv(launcher acp.Launcher) ([]string, error) {
	if len(launcher.AuthEnvVars) == 0 {
		return nil, nil
	}
	dirs, err := s.credentialDirs(launcher.ID)
	if err != nil {
		return nil, err
	}
	byDir := map[string]string{}
	for _, kv := range acp.AuthEnvFromOS(launcher) {
		name, value, _ := strings.Cut(kv, "=")
		byDir[value] = name
	}
	var out []string
	for _, dir := range dirs {
		name, ok := byDir[dir]
		if !ok {
			// The directory exists as a grant target but the variable the
			// launcher needs is not set to it. Refusing is right only in
			// required mode; the caller decides, so this returns the fact.
			return nil, fmt.Errorf("worker: launcher %q needs one of %v set to a credential directory, and %s is not named by any of them", launcher.ID, launcher.AuthEnvVars, dir)
		}
		out = append(out, name+"="+dir)
	}
	return out, nil
}

// launcherNonoEnv is nono's own environment, which is not the adapter's: the
// HOME here is what nono derives its protected state root from, and a grant
// overlapping that root is refused permanently (probe C-H1). It is built from
// scratch too, because the worker's environment has no business being visible to
// a subprocess that can write a policy file.
func (s *UnitService) launcherNonoEnv() []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	home := s.LauncherHome
	if home == "" {
		home = os.Getenv("HOME")
	}
	env := []string{"PATH=" + path}
	if home != "" {
		env = append(env,
			"HOME="+home,
			"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
			"XDG_CACHE_HOME="+filepath.Join(home, ".cache"),
			"XDG_DATA_HOME="+filepath.Join(home, ".local", "share"),
			"XDG_STATE_HOME="+filepath.Join(home, ".local", "state"),
		)
	}
	return env
}

func (s *UnitService) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// nonoBinary is the exec path recorded in the plan: the adapter's own resolved
// binary, which the launcher reports so the plan and the process agree.
func (s *UnitService) nonoBinary() string {
	if s.SandboxPath != "" {
		return s.SandboxPath
	}
	return "nono"
}

// verification translates the chain's output into the runtime's neutral shape,
// with the plan's role names attached.
func verification(res *nono.VerificationResult, plan wsgit.LaunchPlan) *acp.Verification {
	if res == nil {
		return nil
	}
	claim, enforced := res.EgressReport()
	return &acp.Verification{
		Backend: res.Backend, BackendVersion: res.Version,
		PolicyRef: res.PolicyRef, PolicyDigest: res.PolicyDigest,
		AfUnixMediation: res.AfUnixMediation,
		// The profile's tri-state claim and the run's evidence-backed claim travel
		// separately on purpose (ADR-0035): the first is what the digest commits
		// to, the second is what the journal may say.
		NetworkEnforcement: string(res.NetworkEnforced), EgressHosts: append([]string(nil), res.EgressHosts...),
		NetworkClaim: claim, NetworkEnforced: enforced,
		GrantLabels: plan.Labels(), CommitGranted: plan.CommitGranted,
	}
}

// helpers

func mergePaths(sets ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, set := range sets {
		for _, p := range set {
			p = strings.TrimSuffix(strings.TrimSpace(p), "/")
			if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "..") || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func inside(root, path string) bool {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// launcherTarget maps a launcher id to the apm target it installs packages for.
// The mapping is explicit rather than derived from the id's shape because a new
// launcher whose name does not contain its family would silently stage nothing.
func launcherTarget(launcherID string) string {
	switch launcherID {
	case "claude":
		return apm.TargetClaude
	case "codex":
		return apm.TargetCodex
	default:
		return ""
	}
}

func digestOr(res *nono.VerificationResult) string {
	if res == nil {
		return ""
	}
	return res.PolicyDigest
}

func denialReason(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "credential directory"):
		return events.SandboxReasonBinaryMissing
	case strings.Contains(msg, "profile"):
		return events.SandboxReasonProfileInvalid
	default:
		return events.SandboxReasonGrantMismatch
	}
}

var (
	_ = filepath.Join
	_ = sort.Strings
	_ = apm.TargetClaude
)

// Class is the failure's short, path-free identity, for the journal's bounded
// Detail field. nono's own messages quote grant paths, and those paths are
// worker-host facts the browser-visible stream must not carry (contract § 3):
// the roles in the plan already say what the path was for.
func (e *DenialError) Class() string {
	if e.Reason == "" {
		return e.Stage
	}
	return e.Stage + ":" + e.Reason
}

// SetMaterializedForTest records what a secret hook wrote, for tests that drive
// the cleanup half without running the materializer (which belongs to another
// worker's slice). It is exported rather than reached through an unexported field
// so the *only* way a test can fabricate the state is through a name that says it
// is fabricated; nothing on a production path calls it.
func (u *Unit) SetMaterializedForTest(files, env []string) {
	u.secretFiles = append([]string(nil), files...)
	u.Materialized = &Materialized{Files: append([]string(nil), files...), Env: append([]string(nil), env...)}
}

// rankEnforcement orders the modes so "stronger" is a comparison rather than a
// switch at every call site. `disabled` < `permissive-dev` < `required`, with an
// unknown mode ranked above `required` so an unrecognized value can never be the
// one a downgrade silently selects.
func rankEnforcement(m domain.EnforcementMode) int {
	switch m {
	case domain.EnforceDisabled:
		return 0
	case domain.EnforcePermissiveDev:
		return 1
	case domain.EnforceRequired:
		return 2
	default:
		return 3
	}
}
