package worker

import (
	"context"
	"time"
)

// M3's persistence and enforcement ports. They live beside TurnStore rather
// than inside it because the turn loop's contract (fencing on a lease triple)
// and the workspace's contract (fencing on a volume identity) are different
// questions with different failure modes: losing a lease means somebody else
// owns the turn; losing a volume means the bytes are gone.

// Volume identity roots M3 measures. The two values are the two storage roots
// the deployment configures (ADR-0017 D1), and probe V5b is the reason they are
// not one: in the lab they sit on one device and differ only by inode, so a
// single measurement would give one identity column the ability to call two
// trees the same volume.
const (
	RootWorkspaces = "workspaces"
	RootRepos      = "repos"
)

// VolumeRecord is one worker_volumes row: what this worker measured at one
// configured root.
type VolumeRecord struct {
	WorkerID string
	RootKind string
	RootPath string
	// StDev and StIno are the raw stat results. They are stored alongside the
	// digest so an operator can re-read the observation without re-measuring —
	// and so a "why does this volume id not match" question has an answer that
	// is not a re-run.
	StDev      uint64
	StIno      uint64
	FSType     string
	VolumeID   string
	ObservedAt time.Time
}

// WorkspaceClaim is the request to create-or-reuse the workspace row for one
// scope. RootPath is the *worker-side* root (which holds meta/ and work/); the
// agent-granted tree is derived by the database as `<root_path>/work` and is not
// something a caller may supply.
type WorkspaceClaim struct {
	OrganizationID string
	ProjectID      string
	ConversationID string
	WorkerID       string
	VolumeID       string
	RootPath       string
	Mode           string // worktree | clone
	// Reason accompanies a `lost` decision into the event; it is an enum value,
	// not free text (a git error quoting a host path must not reach the journal).
	Reason string
}

// Decision kinds ClaimWorkspace can report.
const (
	// DecisionCreated: no live workspace existed; this one is `preparing`.
	DecisionCreated = "created"
	// DecisionReused: the live row's volume matches what the worker measures.
	DecisionReused = "reused"
	// DecisionLost: case 20's honest arm. The old row was marked lost and a new
	// one was created; the caller must emit workspace.recovery_lost and must not
	// claim the prior edits survived.
	DecisionLost = "lost"
	// DecisionQuarantined: a security condition blocks reuse. The turn fails;
	// there is no path where an agent is launched into this tree again.
	DecisionQuarantined = "quarantined"
)

// WorkspaceDecision is ClaimWorkspace's answer.
type WorkspaceDecision struct {
	Kind string
	// WorkspaceID is the row the turn runs against: the newly created one for
	// created/lost, the existing one otherwise.
	WorkspaceID string
	RootPath    string
	State       string
	// ExpectedVolume and FoundVolume are only meaningful for DecisionLost, and
	// they are digests, not paths — case 20's UI has to say "the disk changed"
	// without saying which disk.
	ExpectedVolume string
	FoundVolume    string
}

// WorkspaceRepo is one prepared repository's row material.
type WorkspaceRepo struct {
	RowID          string
	WorkspaceID    string
	OrganizationID string
	ProjectID      string
	RepositoryID   string
	CheckoutPath   string
	MirrorPath     string
	MirrorVolumeID string
	AdminDir       string
	RunRef         string
	BaseCommit     string
	HeadCommit     string
	ModifiedPaths  []string
	ExcludedPaths  []string
}

// ArtifactKind names the two captures M3 proves (ADR-0017 D8). They are worker
// constants rather than event fields: artifacts.artifact.created's schema carries
// a kind string that the control plane validates, internal/events defines no such
// constants, and internal/domain is outside this milestone's boundaries.
const (
	ArtifactKindCheckpoint = "checkpoint"
	ArtifactKindDiff       = "diff"
)

// WorkspaceRepoState is a workspace_repos row as the worker reads it back.// WorkspaceRepoState is the recorded topology of one repository in a workspace,
// read back for capture and for the case-18 cross-project assertion.
type WorkspaceRepoState struct {
	RowID          string
	RepositoryID   string
	ProjectID      string
	OrganizationID string
	CheckoutPath   string
	MirrorPath     string
	MirrorVolumeID string
	AdminDir       string
	RunRef         string
	BaseCommit     string
	HeadCommit     string
	ModifiedPaths  []string
	ExcludedPaths  []string
}

// CommitRecord is what a post-commit observation writes. HeadCommit came from
// reading the ref afterwards, not from the command's exit status (probe P8: a
// commit that printed `packed-refs.lock: Permission denied` succeeded, and
// another exited 128 while looking fine).
type CommitRecord struct {
	RowID          string
	WorkspaceID    string
	OrganizationID string
	ProjectID      string
	RepositoryID   string
	RunRef         string
	HeadCommit     string
	ModifiedPaths  []string
}

// WorkspaceRow is the workspaces row the turn loop re-attaches to.
type WorkspaceRow struct {
	ID             string
	OrganizationID string
	ProjectID      string
	WorkerID       string
	VolumeID       string
	RootPath       string
	AgentRoot      string
	Mode           string
	State          string
}

// WorkspaceStore is the worker's persistence face for ADR-0017's topology.
type WorkspaceStore interface {
	// RecordVolume upserts this worker's measured identity for one root. It
	// runs at startup and before any workspace claim.
	RecordVolume(ctx context.Context, v VolumeRecord) error
	// Volume reads a recorded identity; ok=false means never measured, which
	// the contract reads as "unknown volume" and refuses to bind to.
	Volume(ctx context.Context, workerID, rootKind string) (VolumeRecord, bool, error)
	// ClaimWorkspace creates or returns the live workspace row, deciding
	// created/reused/lost/quarantined in one transaction.
	ClaimWorkspace(ctx context.Context, req WorkspaceClaim) (WorkspaceDecision, error)
	// MarkReady moves preparing -> ready.
	MarkReady(ctx context.Context, workspaceID string) error
	// Quarantine blocks reuse for a security reason; reason is an enum.
	Quarantine(ctx context.Context, workspaceID, reason string) error
	// Release records that cleanup happened.
	Release(ctx context.Context, workspaceID string) error
	// RecordRepos writes the per-repository rows, optionally marking the
	// workspace ready in the same transaction.
	RecordRepos(ctx context.Context, workspaceID string, repos []WorkspaceRepo, markReady bool) error
	// WorkspaceRepos reads them back.
	WorkspaceRepos(ctx context.Context, workspaceID string) ([]WorkspaceRepoState, error)
	// RecordCommit writes the post-commit ref read and manifest, appending
	// workspace.committed in the same transaction.
	RecordCommit(ctx context.Context, rec CommitRecord) error
	// LiveWorkspaceForConversation reads the row a session re-attaches to.
	LiveWorkspaceForConversation(ctx context.Context, conversationID string) (WorkspaceRow, bool, error)
	// WorkspaceEvent appends one workspace-scoped journal event.
	WorkspaceEvent(ctx context.Context, organizationID, projectID, conversationID string, ev TurnEvent) error
}

// UnitSandbox is the sandbox seam the execution unit uses to launch a process.
// The concrete implementation lives in internal/sandbox/*; the loop consumes
// this so a workspace, a policy and a child process can be tested against a
// fake that says "verified" without a kernel.
type UnitSandbox interface {
	// Verify runs the pre-launch assertion chain for one unit and returns the
	// argv to exec. A returned error means: do not launch.
	Verify(ctx context.Context, req SandboxRequest) (SandboxLaunch, error)
}

// SandboxRequest carries the resolved grant plan plus the command to run under
// it. Plan is opaque here so this package does not import the workspace
// package's types into the loop.
type SandboxRequest struct {
	WorkspaceID string
	TurnID      string
	ProjectID   string
	WorkerID    string
	// PlanRef identifies the resolved grant set for the log; the concrete plan
	// travels inside LaunchFn's closure.
	ProfileMode   string // required | permissive-dev | disabled
	CommitGranted bool
	// AdapterPath and AdapterArgs are the command to wrap.
	AdapterPath string
	AdapterArgs []string
	AdapterEnv  []string
	// Dir is the working directory to hand the sandboxed child.
	Dir string
	// EgressDenied selects the case-13 profile instead of the agent profile.
	EgressDenied bool
}

// SandboxLaunch is the outcome of a verification chain: what to exec, and what
// to journal about it.
type SandboxLaunch struct {
	// Path/Args/Env/Dir replace the request's when a sandbox wraps the
	// command; in `disabled` mode they are the command itself and Isolation is
	// "none".
	Path      string
	Args      []string
	Env       []string
	Dir       string
	Isolation string // "sandbox" | "none"
	// Verified is true only when the full chain passed for this unit.
	Verified bool
	// PolicyDigest, Backend, BackendVersion, AfUnixMediation, NetworkEnforced
	// and GrantLabels are the event payload material.
	PolicyDigest    string
	Backend         string
	BackendVersion  string
	AfUnixMediation string
	NetworkEnforced bool
	GrantLabels     []string
	// Stage and Reason describe a refusal (sandbox.enforcement_failed) and are
	// empty on success.
	Stage  string
	Reason string
	// ChildStarted is true only when a wrapped process was actually exec'd.
	ChildStarted bool
}
