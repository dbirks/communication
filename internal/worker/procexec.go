package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/secrets"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// NodeKindProcessExec is the § 4 step 7 node kind this executor runs. The
// string is the catalogue name verbatim (attemptport.go's Kind comment); the
// loop routes by it and never interprets it.
const NodeKindProcessExec = "process.exec"

// Contract § 6 caps for process.exec: stdout/stderr are captured IN FULL to
// worker-side files (the bytes outlive the process and await the § 4 step 9
// artifact seam), the inline envelope carries bounded previews, and the whole
// outputs envelope stays under the 32 KiB inline cap or the attempt closes
// invalid_output with outputs_too_large — oversize payloads' real home is a
// kind=json artifact, and a worker that silently truncates the payload is a
// worker inventing outputs.
const (
	procExecExtractionMax = 1 << 20 // json extraction reads at most 1 MiB of source (§ 6)
	procExecPreviewBytes  = 8 << 10 // per-stream preview ceiling inside the envelope
	procExecInlineOutput  = 32 << 10
	procExecKillGrace     = 3 * time.Second
)

// RunWorkspaceRef is the boundary identity process.exec needs and cannot
// invent: the run workspace row, the volume it lives on, and the repository
// states at the boundary (commits, never paths).
type RunWorkspaceRef struct {
	WorkspaceID string
	VolumeID    string
	RepoStates  []CheckpointRepoState
	// Repos is the capture identity of the same repositories — checkout paths,
	// row ids and last-recorded heads — the node-boundary capture reads and
	// records through (procexec_capture.go). Resolvers that do not supply it
	// leave the boundary un-captured, exactly as before this field existed.
	Repos []BoundaryRepo
}

// BoundaryRepo is one run-workspace repository as the boundary capture needs
// it: where the checkout lives on THIS worker's tree, what it was based on,
// and what the store last recorded for it. The store derives it from
// workspace_repos (the rows § 4 step 3 wrote); it is deliberately separate
// from CheckpointRepoState, whose json keys are the published wire shape and
// must not grow path fields.
type BoundaryRepo struct {
	RowID         string
	RepositoryID  string
	CheckoutPath  string
	RunRef        string
	BaseCommit    string
	RecordedHead  string
	RecordedPaths []string
	ExcludedPaths []string
}

// BoundaryCommitRecorder is the optional write half of the run-workspace
// resolver: the process.exec node-boundary capture records the ref it read
// through it, reusing the turn capture's writer (postgres.RunWorkspaces
// delegates to WorkspaceStore.RecordCommit — same row, same event, one
// derivation). A resolver that does not implement it leaves the boundary
// un-captured, which restore_checkpoint already refuses honestly.
type BoundaryCommitRecorder interface {
	RecordBoundaryCommit(ctx context.Context, rec CommitRecord) error
}

// RunWorkspaceResolver is the seam to § 4 step 3 (run workspace preparation).
// It is injected rather than assumed because the workspace row and the
// affinity door are written by the wave that owns that step. Until a worker
// can bind a run workspace, a successful command has no boundary to record,
// and the honest answer is a failed attempt naming the missing step — never a
// checkpoint with an invented volume id (D-024 is same-volume only).
type RunWorkspaceResolver interface {
	RunWorkspace(ctx context.Context, runID string) (RunWorkspaceRef, bool, error)
}

// ProcExec executes process.exec attempts (docs/m4-contract.md § 4 steps 5
// and 7): an argv array and never a shell, cwd refused outside the run
// workspace (ADR-0019 FC3), env built from scratch (adapterEnv's discipline,
// unit.go:537 — nothing inherits from the worker, least of all its
// DATABASE_URL), full stdout/stderr capture under the worker-only meta/ tree,
// and the fixed exit-status mapping the contract pins because two workers
// must not invent it:
//
//	exit 0        ⇒ succeeded, outcome "passed"
//	exit 1…125    ⇒ succeeded, outcome "failed", outputs.exit_code set
//	                (03's execution_status=success / business_outcome=fail —
//	                the exit loop's failure signal as a business fact the
//	                passWhen can read)
//	unable to start                                   ⇒ failed, infra
//	sandbox refuses the launch                        ⇒ failed, sandbox_enforcement_failed
//	Landlock kills the child (SIGSYS)                 ⇒ failed, sandbox_enforcement_failed
//	a command the sandbox denies mid-run (EPERM face) ⇒ failed, infra, denial
//	                in detail (§ 4 step 5: a network-hungry command fails
//	                honestly; the profile is not widened by a worker)
//	killed by the node deadline                       ⇒ failed, timeout
//
// The command runs under the communication-command profile
// (nono.ProfileCommand): filesystem grants = the run workspace + the
// per-attempt home, egress DENIED via the same --block-net lever the case-13
// gate proved. Under `permissive-dev`/`disabled` the same command runs with
// the same from-scratch env, labelled, and a `required` worker has no code
// path to either mode (§ 4 step 14).
type ProcExec struct {
	// WorkspaceRoot is COMMUNICATION_WORKSPACE_ROOT; the run's workspace is
	// <root>/run/<run-id> (wsgit's layout, the M3 D1 tree M4 populates).
	WorkspaceRoot string
	// LauncherHome is nono's own HOME (probe C-H1: never a grant, never
	// derived from a workspace).
	LauncherHome string
	// PolicyDir is where the profile file is materialized (ADR-0009 D4).
	PolicyDir string
	// SandboxPath is the nono executable, recorded in the plan so the argv
	// and the process agree.
	SandboxPath string
	// Sandbox is the verify seam (nil is only reachable in non-required
	// modes, where nothing verifies because nothing may claim).
	Sandbox AgentSandbox
	// Enforcement is this worker's configured mode; a unit can only ever run
	// in the mode the worker was started with.
	Enforcement domain.EnforcementMode
	// GitIdentity is exported to the command (a build step that commits needs
	// it; probe P6's reasoning is unit.adapterEnv's).
	GitIdentity acp.GitIdentityEnv
	Logger      *slog.Logger

	// Checkpoints resolves the run's boundary identity. Nil until the § 4
	// step 3 wave wires it: successes then close as infra, visibly, naming
	// the missing step — a claim about the wiring, not about the command.
	Checkpoints RunWorkspaceResolver

	// Secrets materializes this attempt's `node_attempt` mounts (contract § 4
	// step 4 names no node kind, so the rule is the attempt's, not the agent's):
	// env entries join the from-scratch command environment below, env_file
	// writes land inside the run tree, and the ledger row carries this
	// attempt_id. Same seam and same materializer agent.acp's attempt drives —
	// one materializer per process (ADR-0018 D4), never a second one here.
	// Nil means unwired, which is unit.go's precedent for "nothing
	// materialized", not a refusal of every command attempt.
	Secrets AttemptSecrets

	// AttemptProfile reports the agent profile an attempt holds for secret
	// authorization — ADR-0018 D3's allowlist axis. Process.exec claims name no
	// profile (attemptport.go's AttemptClaim has no such field), so the default
	// is "" and the attempt is authorized for no profile-allowlisted mount.
	// The hook exists so that answer stays a *rule* read from the claim rather
	// than a hard-coded "never": when this kind grows a profile axis, the claim
	// grows the field and this is the line that reads it. Test-wired for the
	// same reason — the authorized-delivery path below is reachable only for an
	// attempt a mount's allowlist names.
	AttemptProfile func(AttemptClaim) string

	// KillGrace bounds SIGTERM→SIGKILL for the process group (§ 4 step 11).
	KillGrace time.Duration

	// BoundaryGit is the node-boundary capture's read seam. Nil builds one
	// unsandboxed read-only manager from WorkspaceRoot at first use — the
	// worker's own git plumbing, the same ADR-0023 § 6 exemption that lets
	// CheckpointRestorer reset a worktree; the launched command stays under
	// nono either way. Tests inject a fake.
	BoundaryGit BoundaryGit

	profileOnce *profileCache
	memoMu      sync.Mutex
	gitOnce     sync.Once
	gitReader   BoundaryGit
	gitErr      error
}

var _ AttemptExecutor = (*ProcExec)(nil)

func (p *ProcExec) logger() *slog.Logger {
	if p.Logger != nil {
		return p.Logger
	}
	return slog.Default()
}

func (p *ProcExec) enforcement() domain.EnforcementMode {
	if p.Enforcement == "" {
		return domain.EnforceRequired
	}
	return p.Enforcement
}

func (p *ProcExec) nonoBinary() string {
	if p.SandboxPath != "" {
		return p.SandboxPath
	}
	return "nono"
}

func (p *ProcExec) killGrace() time.Duration {
	if p.KillGrace > 0 {
		return p.KillGrace
	}
	return procExecKillGrace
}

// profile returns the communication-command policy file, materialized once
// per process (the same memo shape UnitService uses for agent-turn; the
// command profile is a third kind, not a variant — its NetworkEnforced claim
// is the file's own, never a launch-time guess).
func (p *ProcExec) profile() (*nono.Profile, error) {
	p.memoMu.Lock()
	if p.profileOnce == nil {
		p.profileOnce = &profileCache{}
	}
	cache := p.profileOnce
	p.memoMu.Unlock()
	if p.PolicyDir == "" {
		return nil, errors.New("worker: no policy directory is configured, so the command profile cannot be materialized (ADR-0009 D4 requires -p <path>)")
	}
	return cache.do(nono.ProfileCommand, func() (*nono.Profile, error) {
		return nono.WriteProfile(p.PolicyDir, nono.ProfileCommand)
	})
}

// procExecSpec is one parsed process.exec config. The Config map is
// executor-owned per kind (attemptport.go); these are the members the canonical
// schema's configProcessExec declares — `executable` + `args` (argv, never a
// shell), `cwd`, `env`, `outputExtraction` — as § 4 step 7 names them.
type procExecSpec struct {
	// executable is the bare name the plan declared (schema pattern
	// ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$): a name to resolve, never a path with
	// separators and never a shell word.
	executable string
	// args are the declared arguments verbatim; bindings were resolved by the
	// control plane before the claim (§ 4 step 14).
	args []string
	// argv is the launch form: `executable` resolved to an absolute path
	// against the worker's own PATH, followed by args. It is what exec.Command
	// receives, so the resolution failure surfaces before any child exists.
	argv []string
	// env holds the config's own `env` declarations as KEY=VALUE, sorted so one
	// plan execs the same environment every run. It joins the from-scratch
	// launch environment; it never *is* one (step 7 forbids os.Environ()).
	env        []string
	cwd        string
	extraction string // none | json_from_stdout | json_from_path
	path       string // json_from_path's file, resolved under work/
}

// execNamePattern is the schema's configProcessExec.executable pattern, restated
// here so a plan that slipped a validator (or a loader that hydrates a snapshot
// written by an older engine) is refused as the plan bug it is instead of being
// LookPath'd — a name containing a separator is a path, and a path is not what
// the schema's `executable` promises.
var execNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

// Execute runs one attempt body. Every refusal names itself; none pretends.
//
// As in AgentTurn.Execute, the wrapper exists only to apply the materializer's
// redaction to what the attempt produced: the values this attempt delivered are
// known to the materializer alone, and neither the terminal result nor any
// journalled payload may carry them (12-test-strategy case 12). The hook travels
// in a per-call variable rather than a field — one *ProcExec serves concurrent
// attempts, so per-attempt state on the struct would race and leak redaction
// from one attempt into another's.
func (p *ProcExec) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	var redact func(string) (string, int)
	res, err := p.executeAttempt(ctx, c, sink, &redact)
	if redact != nil {
		res = redactResult(redact, res)
	}
	return res, err
}

func (p *ProcExec) executeAttempt(ctx context.Context, c AttemptClaim, sink AttemptSink, redactHook *func(string) (string, int)) (AttemptResult, error) {
	spec, refusal := p.parseConfig(c)
	if refusal != nil {
		return *refusal, nil
	}
	if p.WorkspaceRoot == "" {
		return failedResult(ErrorClassInfra, "process.exec requires a configured workspace root"), nil
	}
	if !uuidDir.MatchString(c.RunID) || !uuidDir.MatchString(c.AttemptID) {
		return failedResult(ErrorClassInfra, "process.exec run/attempt ids must be uuids: workspace paths are built from them"), nil
	}
	layout, err := wsgit.LayoutOf(p.WorkspaceRoot, "run", c.RunID)
	if err != nil {
		return failedResult(ErrorClassInfra, "process.exec workspace scope: "+p.redact(err.Error())), nil
	}
	// § 4 step 3 owns workspace preparation (the workspaces row, the affinity
	// door, the mirror/worktree materialization). This executor consumes that
	// tree and never creates it — a missing tree is a wiring fact, stated as
	// one, not an agent failure.
	for _, dir := range []string{layout.Work, layout.Repos, layout.Scratch, layout.Home} {
		if st, serr := os.Stat(dir); serr != nil || !st.IsDir() {
			return failedResult(ErrorClassInfra, fmt.Sprintf(
				"run workspace is not prepared under %s (contract § 4 step 3)", p.redact(layout.Work))), nil
		}
	}
	if err := layout.AssertNothingBut(); err != nil {
		return failedResult(ErrorClassInfra, p.redact(err.Error())), nil
	}

	// Per-attempt home and temp inside the granted tree (§ 4 step 5's
	// "filesystem grants = the run workspace + the per-attempt home/"), and
	// the capture tree OUTSIDE every grant: meta/ is worker-only, so a command
	// cannot rewrite the bytes that record what it did.
	homeDir := filepath.Join(layout.Home, "attempts", c.AttemptID)
	tmpDir := filepath.Join(layout.Scratch, "attempts", c.AttemptID)
	capDir := filepath.Join(layout.Meta, "procexec", c.AttemptID)
	for _, dir := range []string{homeDir, tmpDir, capDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return failedResult(ErrorClassInfra, "create attempt directory: "+p.redact(err.Error())), nil
		}
	}

	// The schema text says an empty cwd means the run workspace ROOT, but the
	// executor deliberately defaults to scratch/: probe C-CWD requires the cwd
	// to sit inside an rw grant, and an rw grant on layout.Work itself would
	// let a command delete, rename or replace the granted children beneath it
	// (rm -rf work/repos, or swap the checkout for a symlink) — a sandbox
	// widening the per-child grants never allowed. Reconciling the schema
	// text with this default needs an ADR; until then the default is scratch/.
	cwd, err := p.resolveUnderWork(layout.Work, spec.cwd, layout.Scratch)
	if err != nil { // ADR-0019 FC3's escape refusal, before anything runs.
		return failedResult(ErrorClassInfra, p.redact(err.Error())), nil
	}
	if spec.extraction == "json_from_path" {
		spec.path, err = p.resolveUnder(layout.Work, cwd, spec.path)
		if err != nil {
			return failedResult(ErrorClassInfra, "output path: "+p.redact(err.Error())), nil
		}
	}

	plan := wsgit.LaunchPlan{
		WorkspaceID: "run/" + c.RunID,
		Layout:      layout,
		Grants: []wsgit.Grant{
			{Role: wsgit.RoleCheckout, Path: layout.Repos},
			{Role: wsgit.RoleScratch, Path: layout.Scratch},
			{Role: wsgit.RoleAgentHome, Path: layout.Home},
		},
		LauncherHome: p.LauncherHome,
		AgentHome:    homeDir,
		Cwd:          cwd,
	}
	if err := plan.Check(); err != nil {
		return failedResult(ErrorClassInfra, "command launch plan: "+p.redact(err.Error())), nil
	}

	// The run workspace row is what makes a mount target authorizable: its
	// repositories come from § 4 step 3's preparation, and an attempt never
	// invents a checkout path to write a secret into.
	workspaceID := ""
	if p.Checkpoints != nil {
		if ref, ok, err := p.Checkpoints.RunWorkspace(context.WithoutCancel(ctx), c.RunID); err == nil && ok {
			workspaceID = ref.WorkspaceID
		}
	}

	// § 4 step 4 runs in the contract's order: materialize, then verify, then
	// launch — so a mount that cannot be delivered means no child process and no
	// partial set (ADR-0018 D4), and nothing sandboxed ever ran holding a value
	// the ledger does not record.
	materialized, refusal := p.materializeSecrets(ctx, c, workspaceID, layout)
	if refusal != nil {
		return *refusal, nil
	}
	if materialized != nil {
		defer p.cleanupSecrets(c, materialized, layout)
		if redactHook != nil && materialized.Redact != nil {
			*redactHook = materialized.Redact
			sink = redactingAttemptSink{inner: sink, redact: materialized.Redact}
		}
	}

	required := p.enforcement() == domain.EnforceRequired
	adapterEnv, err := acp.LaunchEnv(acp.EnvRequest{
		Home:    homeDir,
		Scratch: tmpDir,
		// The two HOMEs (probe C-H1): under a sandbox the launcher's `env` hop
		// owns HOME and the argv builder refuses a caller-supplied one;
		// without a sandbox there is no hop, so HOME comes from here.
		OmitHome:    required,
		GitIdentity: p.GitIdentity,
		Extra:       []string{"COMMUNICATION_RUN_ID=" + c.RunID, "COMMUNICATION_ATTEMPT_ID=" + c.AttemptID},
	})
	if err != nil {
		return failedResult(ErrorClassInfra, "build command environment: "+bounded(err.Error(), 400)), nil
	}
	// The env-delivered mounts join that from-scratch environment here and nowhere
	// else — not the journal, not a log line, not the capture files (seams.go's
	// rule for `env` values, ADR-0018 D4). Appended last, so what the platform
	// authorized for this attempt outranks anything LaunchEnv sets for itself; the
	// from-scratch discipline (§ 4 step 7, never os.Environ()) is what makes
	// "this is the command's whole environment" a true statement afterwards.
	// The plan's own `env` declarations join next, then the mounts the platform
	// authorized for this attempt — so an authorized value outranks the pipeline
	// text, and neither of them is os.Environ(): the from-scratch discipline of
	// § 4 step 7 is what makes "this is the command's whole environment" a true
	// statement afterwards, and nothing here reaches the journal, a log line, or
	// the capture files (seams.go's rule for `env` values, ADR-0018 D4).
	adapterEnv = append(adapterEnv, spec.env...)
	if materialized != nil {
		adapterEnv = append(adapterEnv, materialized.Env...)
	}

	path, args, env := spec.argv[0], spec.argv[1:], adapterEnv
	if required {
		res, refusal := p.verifyThenWrap(ctx, sink, c, plan, spec, adapterEnv)
		if refusal != nil {
			return *refusal, nil
		}
		path, args, env = p.nonoBinary(), res.argv, p.nonoLauncherEnv()
	}

	outcome, startErr := p.run(ctx, path, args, env, cwd, capDir)
	if startErr != nil {
		return failedResult(ErrorClassInfra, "unable to start "+filepath.Base(spec.argv[0])+": "+p.redact(startErr.Error())), nil
	}

	res := p.classify(ctx, spec, outcome, required)
	if res.Status != AttemptStatusSucceeded {
		return res, nil
	}
	built, fail := p.buildOutputs(spec, outcome, capDir, res)
	if fail != nil {
		return *fail, nil
	}
	// ADR-0023 § 6: the checkpoint row is "the same capture ... already
	// produce[d] for a turn, now attached to a node boundary" — and 05's
	// checkpoint policy saves repo HEAD/base refs and the dirty manifest at
	// EVERY successful node boundary. A command that committed (or dirtied)
	// the tree must therefore be captured here, before the boundary record is
	// resolved, or every restore_checkpoint retry of this run refuses forever.
	p.captureBoundary(ctx, c, materialized)
	built.Checkpoint = p.checkpointFor(ctx, c, spec, built.OutputsDigest)
	if built.Checkpoint.VolumeID == "" {
		// Honest: there is no boundary to write. The command passed; the
		// engine cannot durably say so. Say which half is missing.
		return failedResult(ErrorClassInfra, fmt.Sprintf(
			"command succeeded (exit %d) but no run workspace boundary is bound (contract § 4 step 3): a checkpoint requires a workspace row and its volume (D-024 is same-volume only)", outcome.code)), nil
	}
	return built, nil
}

// launchRefusal carries the verify chain's honest "do not launch" answer.
type wrappedLaunch struct {
	argv []string
}

// materializeSecrets is contract § 4 step 4 at process.exec scope: the
// node_attempt mounts this attempt is authorized to hold, delivered before the
// command launches, never half a set (ADR-0018 D4).
//
// Which mounts those are is decided HERE, before the materializer is asked,
// because for a process.exec attempt the answer is structural. A process.exec
// claim carries no agent profile, so p.agentProfile reports ""; every mount's
// allowlist is keyed by profile id and the resolver denies the empty profile
// outright (internal/secrets/resolver.go:231's `a.AgentProfileID == "" ||
// !slices.Contains(allowed, …)` → secrets.ErrNotAuthorized; ADR-0018 D3's
// "empty means denied to all", and an empty allowlist denies too). So a
// profile-less attempt is authorized for *no* node_attempt mount, and the
// contract's distinction — a mount that is not this attempt's is simply not
// delivered, only a mount that is this attempt's and then fails is an attempt
// failure — is applied as:
//
//   - no profile: nothing is asked for. Materialize is not called, so nothing is
//     delivered, nothing is recorded as materialized, and no
//     secret.materialization_failed is journalled for a delivery nobody claimed.
//     The command runs exactly as it did before this kind had a secrets seam;
//   - a profile, and the materializer answers secrets.ErrNotAuthorized: the same
//     skip, recognised on the error's type rather than its text;
//   - a profile, and any other failure: the attempt fails as infra, naming step
//     4 and carrying no path (the reason is journalled by the materializer in
//     its own transaction).
//
// Delivering a value whose allowlist is written in profile ids to an unprofiled
// command would be the leak; refusing the *delivery* while running the command
// is the boundary. PolicyDigest is left empty for the agentturn reason: under
// `required` the policy is verified at step 5, after materialization, and a
// digest claimed here would be a promise about a launch not yet checked.
func (p *ProcExec) materializeSecrets(ctx context.Context, c AttemptClaim, workspaceID string, layout wsgit.Layout) (*Materialized, *AttemptResult) {
	if p.Secrets == nil {
		return nil, nil
	}
	profile := p.agentProfile(c)
	if profile == "" {
		p.logger().Debug("no node_attempt mount is deliverable to this attempt: it holds no agent profile",
			slog.String("attempt_id", c.AttemptID), slog.String("project_id", c.ProjectID))
		return nil, nil
	}
	// The checkouts a mount may target are § 4 step 3's, never this executor's
	// guess: no workspace row, no repos, and an attempt with no authorized root
	// delivers nothing rather than writing into a directory the database never
	// named.
	repos, err := p.Secrets.ReposForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, ptrResult(failedResult(ErrorClassInfra,
			"read the run workspace's repositories for node_attempt secret mounts: "+p.redact(err.Error())))
	}
	var extra []string
	m, err := p.Secrets.Materialize(ctx, MaterializeRequest{
		OrganizationID: c.OrganizationID, ProjectID: c.ProjectID,
		WorkspaceID: workspaceID, WorkerID: c.WorkerID,
		AttemptID: c.AttemptID, AgentProfileID: profile,
		Lifecycle: LifecycleNodeAttempt,
		Repos:     repos,
		// This executor captures stdout/stderr and a json extraction only — it
		// builds no tree artifact, so nothing here consumes the exclusion list.
		// It is still passed: an env_file mount written into the run tree must
		// reach whoever captures that tree next, and the materializer's
		// reporting should not depend on which kind asked (ADR-0017 D6).
		ExtraExclusions: &extra,
	})
	if err != nil {
		if errors.Is(err, secrets.ErrNotAuthorized) {
			// A mount that is not this attempt's: not delivered, and nothing
			// recorded as materialized for it (step 4). The command is not the
			// one that failed to be authorized, so it does not fail for it.
			p.logger().Debug("node_attempt mount is not authorized for this attempt: delivering nothing",
				slog.String("attempt_id", c.AttemptID), slog.String("project_id", c.ProjectID))
			return nil, nil
		}
		// The reason is already journalled by the materializer in its own
		// transaction; the attempt's detail names the step and carries no path.
		return nil, ptrResult(failedResult(ErrorClassInfra,
			"node_attempt secret materialization refused (contract § 4 step 4): the reason is in secret.materialization_failed"))
	}
	if len(m.Env) == 0 && len(m.Files) == 0 && m.Done == nil {
		// No node_attempt mount applies — the ordinary case, and nothing to
		// clean up or redact.
		return nil, nil
	}
	// An env_file write outside this run's tree is a materializer bug, and the
	// command must not launch on it: the sandbox grants the run workspace, so a
	// file elsewhere is a value in a tree this attempt's grants do not cover.
	for _, file := range m.Files {
		if !inside(layout.Work, file) {
			return nil, ptrResult(failedResult(ErrorClassInfra,
				"a node_attempt secret was materialized outside the run workspace (contract § 4 step 4): refusing to launch"))
		}
	}
	return &m, nil
}

// agentProfile reports the agent profile this attempt holds for secret
// authorization. A process.exec claim names none, so the answer is "" — and
// "" is denied every mount (see materializeSecrets). The hook is the extension
// point the claim must grow, not this executor's invention.
func (p *ProcExec) agentProfile(c AttemptClaim) string {
	if p.AttemptProfile == nil {
		return ""
	}
	return p.AttemptProfile(c)
}

// cleanupSecrets runs at the attempt boundary — env deliveries included, whose
// ledger row must close even though no file was written — in M3's order:
// assert the files gone, *then* journal secret.removed, so "cleanup happened"
// and "the journal says so" are one claim. The teardown outlives a cancelled
// or killed attempt (defer + WithoutCancel): a value must not survive because
// its process was interrupted, and § 4 step 11's SIGKILL is exactly the case
// where a child dies without clearing its own environment's footprint.
//
// A file that cannot be removed is logged, never journalled — the path names
// where a secret lives and attempts.detail is browser-visible. The uncleaned
// row is left standing, which is the finding the worker's startup sweep exists
// to close (ADR-0018 D1).
func (p *ProcExec) cleanupSecrets(c AttemptClaim, m *Materialized, layout wsgit.Layout) {
	if m == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 10*time.Second)
	defer cancel()
	for _, file := range m.Files {
		if !inside(layout.Work, file) {
			p.logger().Error("refusing to remove a materialized secret outside the run workspace",
				slog.String("attempt_id", c.AttemptID), slog.String("path", file))
			continue
		}
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			p.logger().Error("materialized node_attempt secret survived attempt cleanup",
				slog.String("attempt_id", c.AttemptID), slog.String("path", file),
				slog.String("error", err.Error()))
		}
	}
	if m.Done != nil {
		if err := m.Done(ctx); err != nil {
			p.logger().Warn("secret.removed could not be journalled for the attempt",
				slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		}
	}
}
func (p *ProcExec) verifyThenWrap(ctx context.Context, sink AttemptSink, c AttemptClaim, plan wsgit.LaunchPlan, spec procExecSpec, adapterEnv []string) (*wrappedLaunch, *AttemptResult) {
	if p.Sandbox == nil {
		r := failedResult(ErrorClassSandboxEnforcementFail,
			"enforcement is required but no sandbox backend is configured: refusing to exec unsandboxed (ADR-0019 D6, no fallback exists)")
		return nil, &r
	}
	prof, err := p.profile()
	if err != nil {
		r := failedResult(ErrorClassSandboxEnforcementFail, "materialize the command profile: "+p.redact(err.Error()))
		return nil, &r
	}
	nspec := nono.LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: p.LauncherHome,
		AdapterPath: spec.argv[0], AdapterArgs: spec.argv[1:], AdapterEnv: adapterEnv,
		// § 4 step 5's grant set is the workspace the command works ON; the
		// program it IS needs its own read (which is what nono's Landlock
		// ruleset pairs with exec). A resolved path outside the granted tree —
		// a lab fixture under /opt, a vendored toolchain — was otherwise
		// reachable by the worker's own lookup and unreachable by the sandbox,
		// which is exactly the 126 (found, could not execute) this fills.
		ToolReads: commandToolReads(plan, spec.argv[0]),
		BlockNet:  true, // the command profile IS the egress-denied claim (§ 4 step 5)
	}
	res, verr := p.Sandbox.Verify(ctx, nspec)
	if verr != nil {
		if ctx.Err() != nil {
			// The stop signal (deadline/cancel/drain) arrived DURING the
			// verification chain and killed a probe helper. Reporting that
			// as a sandbox refusal would be a lie nobody made: the honest
			// word is the stop arm itself.
			r := p.classify(ctx, spec, procExecOutcome{}, true)
			return nil, &r
		}
		p.journal(ctx, sink, c, events.TypeSandboxEnforcementFailed, p.enforcementFailedPayload(c, res, verr))
		msg := "sandbox refused the launch"
		var f *nono.Failure
		if errors.As(verr, &f) && f.ChildStarted {
			msg = "sandbox killed the launched process"
		}
		r := failedResult(ErrorClassSandboxEnforcementFail, msg+": "+p.redact(verr.Error()))
		return nil, &r
	}
	argv, berr := nspec.BuildLaunchArgv()
	if berr != nil {
		p.journal(ctx, sink, c, events.TypeSandboxEnforcementFailed, p.enforcementFailedPayload(c, res, berr))
		r := failedResult(ErrorClassSandboxEnforcementFail, "launch argv: "+p.redact(berr.Error()))
		return nil, &r
	}
	p.journal(ctx, sink, c, events.TypeSandboxVerified, p.verifiedPayload(c, plan, res))
	return &wrappedLaunch{argv: argv}, nil
}

func (p *ProcExec) verifiedPayload(c AttemptClaim, plan wsgit.LaunchPlan, res *nono.VerificationResult) events.SandboxVerifiedPayload {
	grants := make([]events.SandboxGrant, 0, len(plan.Grants))
	for _, g := range plan.Grants {
		grants = append(grants, events.SandboxGrant{Role: g.Role, Access: g.Access()})
	}
	workspaceID := ""
	if p.Checkpoints != nil {
		if ref, ok, err := p.Checkpoints.RunWorkspace(context.Background(), c.RunID); err == nil && ok {
			workspaceID = ref.WorkspaceID
		}
	}
	network, enforced := res.EgressReport()
	return events.SandboxVerifiedPayload{
		ProjectID: c.ProjectID, WorkspaceID: workspaceID, WorkerID: c.WorkerID,
		PolicyDigest: res.PolicyDigest, Backend: res.Backend, BackendVersion: res.Version,
		AfUnixMediation: res.AfUnixMediation, NetworkEnforced: enforced, Network: network,
		Grants: grants, CommitGranted: false, Verified: res.Verified,
	}
}

func (p *ProcExec) enforcementFailedPayload(c AttemptClaim, res *nono.VerificationResult, cause error) events.SandboxEnforcementFailedPayload {
	stage, reason := "launch", "enforcement_failed"
	var f *nono.Failure
	if errors.As(cause, &f) {
		stage, reason = f.Stage, f.Reason
	}
	payload := events.SandboxEnforcementFailedPayload{
		ProjectID: c.ProjectID, WorkerID: c.WorkerID,
		Stage: stage, Reason: reason, Detail: p.redact(cause.Error()),
	}
	if res != nil {
		payload.Backend, payload.BackendVersion = res.Backend, res.Version
		payload.PolicyDigest, payload.ChildStarted = res.PolicyDigest, res.ChildStarted
		payload.Verified = res.Verified
	}
	return payload
}

// journal best-effort appends one attempt-scoped event; a lost fence has
// already flagged the loop, and the ctx cancel classifies the outcome.
func (p *ProcExec) journal(ctx context.Context, sink AttemptSink, c AttemptClaim, typ string, payload any) {
	if err := sink.AppendEvent(ctx, AttemptEvent{Type: typ, Payload: payload}); err != nil {
		p.logger().Warn("process.exec journal append failed",
			slog.String("attempt_id", c.AttemptID), slog.String("type", typ), slog.String("error", err.Error()))
	}
}

// parseConfig reads the kind-owned config; every shape problem is an honest
// refusal class (infra = plan/loader gap, binding_error = the advancer has
// work left, § 4 step 14).
func (p *ProcExec) parseConfig(c AttemptClaim) (procExecSpec, *AttemptResult) {
	var spec procExecSpec
	fail := func(class, detail string) (procExecSpec, *AttemptResult) {
		r := failedResult(class, detail)
		return spec, &r
	}
	cfg := c.Config
	if cfg == nil {
		return fail(ErrorClassInfra, "process.exec attempt carries no config: the claim did not hydrate a plan node")
	}
	// `executable` is the schema's only required member. A whole `argv` is
	// accepted for exactly one thing: the in-repo real-sandbox proofs of
	// procexec_nono_test.go, which hand the executor an argv directly. Nothing
	// in this repository *produces* the key in a claim (grep `"argv"`: the
	// compiler, the advancer and the claim hydration never name it) and
	// canonical validation rejects it at publish time, so a claim carrying it is
	// a hand-built one, not a pipeline's. Its target is resolved by the same
	// lookup as `executable`, so "not runnable" is the same infra refusal.
	rawExec, hasExec := cfg["executable"]
	rawArgv, hasArgv := cfg["argv"]
	switch {
	case hasExec:
		if isUnresolved(rawExec) {
			return fail(ErrorClassBindingError, "process.exec executable still carries an unresolved expression binding; the advancer resolves bindings — the worker never evaluates them (§ 4 step 14)")
		}
		name, ok := rawExec.(string)
		if !ok || name == "" {
			return fail(ErrorClassInfra, "process.exec executable is not a non-empty string")
		}
		if !execNamePattern.MatchString(name) {
			return fail(ErrorClassInfra, fmt.Sprintf(
				"process.exec executable %q is not a bare executable name: the schema's pattern is ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ — a name to resolve, never a path and never a shell word", p.redact(name)))
		}
		spec.executable = name
		resolved, rerr := p.resolveExecutable(name)
		if rerr != nil {
			// § 4 step 7's unable-to-start arm, answered before the fork: a name
			// the worker cannot find is an infra refusal (a plan/deployment gap),
			// never a command that "failed".
			return fail(ErrorClassInfra, "unable to start "+name+": "+p.redact(rerr.Error()))
		}
		spec.argv = append(spec.argv, resolved)
		if v, ok := cfg["args"]; ok {
			if isUnresolved(v) {
				return fail(ErrorClassBindingError, "process.exec args still carry unresolved expression bindings; the advancer resolves bindings — the worker never evaluates them (§ 4 step 14)")
			}
			list, ok := anyList(v)
			if !ok {
				return fail(ErrorClassInfra, "process.exec args is not a list")
			}
			for i, el := range list {
				s, ok := el.(string)
				if !ok {
					return fail(ErrorClassInfra, fmt.Sprintf("process.exec args[%d] is not a string (argv is data for one execve, never a shell to expand)", i))
				}
				// An empty argument is legal argv (`--msg=` with ""); only a
				// non-string (a plan's null left in place) is a shape error.
				spec.args = append(spec.args, s)
			}
			spec.argv = append(spec.argv, spec.args...)
		}
	case hasArgv:
		if isUnresolved(rawArgv) {
			return fail(ErrorClassBindingError, "process.exec argv still carries unresolved expression bindings; the advancer resolves bindings — the worker never evaluates them (§ 4 step 14)")
		}
		list, ok := anyList(rawArgv)
		if !ok || list == nil {
			return fail(ErrorClassInfra, "process.exec argv is not a list")
		}
		if len(list) == 0 {
			return fail(ErrorClassInfra, "process.exec argv is empty: there is nothing to exec, and an empty command is a plan bug, not a no-op")
		}
		for i, el := range list {
			s, ok := el.(string)
			if !ok || s == "" {
				return fail(ErrorClassInfra, fmt.Sprintf("process.exec argv[%d] is not a non-empty string (argv only, never a shell)", i))
			}
			spec.argv = append(spec.argv, s)
		}
		spec.executable = spec.argv[0]
		spec.args = append(spec.args, spec.argv[1:]...)
		resolved, rerr := p.resolveExecutable(spec.argv[0])
		if rerr != nil {
			return fail(ErrorClassInfra, "unable to start "+filepath.Base(spec.argv[0])+": "+p.redact(rerr.Error()))
		}
		spec.argv[0] = resolved
	default:
		return fail(ErrorClassInfra, "process.exec config has no executable: the claim's plan node declared none (schema configProcessExec requires one)")
	}
	if v, ok := cfg["cwd"]; ok {
		if isUnresolved(v) {
			return fail(ErrorClassBindingError, "process.exec cwd carries an unresolved binding")
		}
		spec.cwd, _ = v.(string)
	}
	if v, ok := cfg["env"]; ok {
		if isUnresolved(v) {
			return fail(ErrorClassBindingError, "process.exec env carries an unresolved binding")
		}
		decl, ok := v.(map[string]any)
		if !ok {
			return fail(ErrorClassInfra, "process.exec env is not a map of string values")
		}
		keys := make([]string, 0, len(decl))
		for k := range decl {
			keys = append(keys, k)
		}
		sort.Strings(keys) // one plan, one deterministic environment
		for _, k := range keys {
			if k == "" {
				return fail(ErrorClassInfra, "process.exec env has an empty key")
			}
			s, ok := decl[k].(string)
			if !ok {
				return fail(ErrorClassInfra, fmt.Sprintf("process.exec env[%s] is not a string", k))
			}
			spec.env = append(spec.env, k+"="+s)
		}
	}
	if v, ok := cfg["outputExtraction"]; ok {
		if isUnresolved(v) {
			return fail(ErrorClassBindingError, "process.exec outputExtraction carries an unresolved binding")
		}
		// The schema declares an object, { mode, path }. The bare mode string is
		// the shape a hand-built claim has always used; both mean the same thing
		// and both are read — but a reader that understood only the string would
		// run every published json_from_path node as `none`, silently.
		switch ex := v.(type) {
		case string:
			spec.extraction = ex
		case map[string]any:
			spec.extraction, _ = ex["mode"].(string)
			if pv, ok := ex["path"]; ok {
				if isUnresolved(pv) {
					return fail(ErrorClassBindingError, "process.exec output path carries an unresolved binding")
				}
				spec.path, _ = pv.(string)
			}
		default:
			return fail(ErrorClassInfra, "process.exec outputExtraction is neither the schema's object nor a mode string")
		}
	}
	if spec.extraction == "" {
		spec.extraction = "none"
	}
	switch spec.extraction {
	case "none", "json_from_stdout", "json_from_path":
	default:
		return fail(ErrorClassInfra, fmt.Sprintf("process.exec outputExtraction %q is not none | json_from_stdout | json_from_path (§ 4 step 7)", spec.extraction))
	}
	if spec.extraction == "json_from_path" && spec.path == "" {
		// Legacy shape: the path beside the mode rather than inside it.
		pv, ok := cfg["path"]
		if !ok {
			pv, ok = cfg["outputPath"]
		}
		if ok {
			if isUnresolved(pv) {
				return fail(ErrorClassBindingError, "process.exec output path carries an unresolved binding")
			}
			spec.path, _ = pv.(string)
		}
		if spec.path == "" {
			return fail(ErrorClassInfra, "json_from_path requires a path")
		}
	}
	return spec, nil
}

// anyList accepts both the JSON-hydrated ([]any) and the Go-native ([]string)
// array: the claim's Config is hydrated from the run's plan snapshot, while a
// caller inside this process (a test, a hand-built claim) hands over typed
// slices.
func anyList(v any) ([]any, bool) {
	switch t := v.(type) {
	case []any:
		return t, true
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out, true
	default:
		return nil, false
	}
}

// resolveExecutable turns the plan's bare name into the absolute path
// exec.Command requires by searching the WORKER process's own PATH
// (exec.LookPath). That is the deployment's knob: the M4 worker image mounts its
// helper at /opt/m4/bin and prepends it to the worker's PATH, so the name
// resolves exactly where the operator installed it while the plan stays
// portable across hosts. It is the worker's environment that is searched, not
// the child's — the child's environment is built from scratch (§ 4 step 7) and
// is neither this lookup's input nor its output.
func (p *ProcExec) resolveExecutable(name string) (string, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s is not runnable from the worker PATH: %w", name, err)
	}
	return path, nil
}

// isUnresolved recognizes the marker claim hydration leaves for bindings
// whose expression ids belong to the advancer (§ 4 step 14: a worker that
// could evaluate them is a worker that could lie about routing).
func isUnresolved(v any) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	flag, _ := m["$unresolved"].(bool)
	return flag
}

// resolveUnderWork keeps a configured path inside the run workspace
// (ADR-0019 FC3): a relative path joins under work/, an absolute one must
// already be under it, and symlinks resolve before the check so a link
// cannot carry a command out of the tree the grants describe. An empty value
// falls back to def (which may be "" when there is no default).
func (p *ProcExec) resolveUnderWork(work, value, def string) (string, error) {
	if value == "" {
		return def, nil
	}
	return p.resolveUnder(work, work, value)
}

// resolveUnder joins a relative value under base (an absolute value is taken
// as written) and then applies ADR-0019 FC3's containment check against the
// run workspace root, so a path that walks out of the granted tree is refused
// no matter which directory it started from.
func (p *ProcExec) resolveUnder(root, base, value string) (string, error) {
	candidate := value
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(base, value)
	}
	clean := filepath.Clean(candidate)
	inner := root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		inner = real
	}
	check := clean
	if real, err := filepath.EvalSymlinks(clean); err == nil {
		check = real
	}
	if check != inner && !strings.HasPrefix(check, inner+string(filepath.Separator)) {
		return "", fmt.Errorf("%s escapes the run workspace (ADR-0019 FC3)", p.redact(clean))
	}
	return clean, nil
}

// procExecOutcome is one finished command's honest record.
type procExecOutcome struct {
	code      int // -1 when killed by a signal
	signal    int // the killing signal, 0 when exited normally
	stdoutLen int64
	stderrLen int64
	stdoutPre []byte
	stderrPre []byte
}

// run execs argv in its own process group, captures full stdout/stderr to
// worker-side files, and terminates the GROUP when the attempt context stops
// (§ 4 step 11: cancel-requested, deadline and drain all arrive as ctx). The
// SIGTERM goes to the group first — the grace window belongs to the command;
// SIGKILL catches what refuses to leave. Under nono the direct child is the
// supervisor, which tears its sandboxed process down with it (nono/process.go),
// so the group kill plus supervisor teardown is the process_group_terminated
// ack § 4 step 11 names.
func (p *ProcExec) run(ctx context.Context, path string, args, env []string, cwd, capDir string) (procExecOutcome, error) {
	var out procExecOutcome
	stdoutPath := filepath.Join(capDir, "stdout.txt")
	stderrPath := filepath.Join(capDir, "stderr.txt")
	stdoutF, err := os.Create(stdoutPath)
	if err != nil {
		return out, fmt.Errorf("capture stdout: %w", err)
	}
	defer func() { _ = stdoutF.Close() }()
	stderrF, err := os.Create(stderrPath)
	if err != nil {
		return out, fmt.Errorf("capture stderr: %w", err)
	}
	defer func() { _ = stderrF.Close() }()

	cmd := exec.Command(path, args...) // argv only — no shell, ever
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdout = stdoutF // real files, not pipes: the bytes are the capture
	cmd.Stderr = stderrF
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		return out, err
	}

	done := make(chan struct{})
	watchdog := make(chan struct{})
	go func() {
		defer close(watchdog)
		select {
		case <-done:
			return
		case <-ctx.Done():
		}
		pid := cmd.Process.Pid
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(p.killGrace()):
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
	waitErr := cmd.Wait()
	close(done)
	<-watchdog

	if st := cmd.ProcessState; st != nil {
		out.code = st.ExitCode()
		if !st.Exited() {
			if ws, ok := st.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				out.signal = int(ws.Signal())
			}
		}
	}
	out.stdoutLen, _ = fileSize(stdoutPath)
	out.stderrLen, _ = fileSize(stderrPath)
	out.stdoutPre = headBytes(stdoutPath, procExecPreviewBytes)
	out.stderrPre = headBytes(stderrPath, procExecPreviewBytes)
	// A wait error after a start is exit-status data for classify(); only a
	// never-started command is a run failure, and that returned early above.
	_ = waitErr
	return out, nil
}

func fileSize(path string) (int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func headBytes(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, n)
	read, _ := io.ReadFull(f, buf)
	return buf[:read]
}

// classify maps the finished command onto the contract's fixed vocabulary
// (§ 4 step 7). Order matters: the loop's cancellation arms outrank the
// command's own exit — a command we stopped has no exit story to tell.
func (p *ProcExec) classify(ctx context.Context, spec procExecSpec, out procExecOutcome, sandboxed bool) AttemptResult {
	switch ctx.Err() {
	case context.DeadlineExceeded:
		return failedResult(ErrorClassTimeout, fmt.Sprintf(
			"node deadline exceeded while running %s (process group terminated)", filepath.Base(spec.argv[0])))
	case context.Canceled:
		// Stop signals all arrive here (drain, cancel-requested, lease loss);
		// the loop's flags choose the terminal. What this executor knows is
		// that the group went down: that IS the ack (§ 4 step 11).
		return AttemptResult{CancelReason: CancelReasonProcessTerminated}
	}
	if out.signal != 0 {
		if out.signal == int(syscall.SIGSYS) && sandboxed {
			return failedResult(ErrorClassSandboxEnforcementFail, fmt.Sprintf(
				"sandbox killed %s on a denied operation (SIGSYS)", filepath.Base(spec.argv[0])))
		}
		return failedResult(ErrorClassInfra, fmt.Sprintf(
			"%s terminated by signal %d without a stop request", filepath.Base(spec.argv[0]), out.signal))
	}
	switch {
	case out.code == 0:
		return AttemptResult{Status: AttemptStatusSucceeded, Outcome: "passed"}
	case out.code >= 1 && out.code <= 125:
		// § 4 step 5's twin rule: a command the sandbox BLOCKED (a denied
		// connect) is an infra failure with the denial in detail, not a
		// business "failed" an until-loop would read as a verdict. The marker
		// scan is deliberately narrow: kernel EPERM/EACCES text, in the first
		// preview block, under a profile that denies egress.
		if sandboxed && sandboxDenialMarker(out.stderrPre) {
			return failedResult(ErrorClassInfra, fmt.Sprintf(
				"sandbox denied %s (exit %d): %s — the command profile denies egress by design (§ 4 step 5); a worker does not widen it",
				filepath.Base(spec.argv[0]), out.code, bounded(string(out.stderrPre), 320)))
		}
		return AttemptResult{Status: AttemptStatusSucceeded, Outcome: "failed"}
	default:
		// 126+ (not-executable, not-found, shell-internal) is "unable to
		// start"-class even though the kernel ran the parent: 1–125 is where
		// authored commands speak, 126+ is the OS talking.
		return failedResult(ErrorClassInfra, fmt.Sprintf(
			"%s exited %d, outside the business-outcome band 1..125 (§ 4 step 7: unable-to-start class)",
			filepath.Base(spec.argv[0]), out.code))
	}
}

var sandboxDenialMarkers = []string{
	"operation not permitted", "permission denied", "eperm", "eacces", "landlock",
}

func sandboxDenialMarker(stderrPreview []byte) bool {
	s := strings.ToLower(string(stderrPreview))
	for _, m := range sandboxDenialMarkers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// buildOutputs assembles the validated envelope: engine facts first, the
// extracted business payload merged under them, everything under the § 6
// inline cap. Engine keys win: a command that prints exit_code does not get
// to redefine what exited (§ 4 step 7's whole point).
func (p *ProcExec) buildOutputs(spec procExecSpec, out procExecOutcome, capDir string, base AttemptResult) (AttemptResult, *AttemptResult) {
	outputs := map[string]any{
		"exit_code":      int64(out.code),
		"stdout_bytes":   out.stdoutLen,
		"stderr_bytes":   out.stderrLen,
		"stdout_preview": string(out.stdoutPre),
		"stderr_preview": string(out.stderrPre),
	}
	switch spec.extraction {
	case "none":
	case "json_from_stdout":
		val, oerr := extractJSON(filepath.Join(capDir, "stdout.txt"), "stdout")
		if oerr != nil {
			r := invalidOutput(*oerr)
			return AttemptResult{}, &r
		}
		mergeExtracted(outputs, val)
	case "json_from_path":
		val, oerr := extractJSON(spec.path, spec.path)
		if oerr != nil {
			r := invalidOutput(*oerr)
			return AttemptResult{}, &r
		}
		mergeExtracted(outputs, val)
	}
	outputs["exit_code"] = int64(out.code)

	raw, err := json.Marshal(outputs)
	if len(raw) > procExecInlineOutput || err != nil {
		// Drop previews before declaring the envelope oversize: previews are
		// convenience, the extracted payload is the contract.
		delete(outputs, "stdout_preview")
		delete(outputs, "stderr_preview")
		raw, err = json.Marshal(outputs)
		if err != nil || len(raw) > procExecInlineOutput {
			r := AttemptResult{
				Status:     AttemptStatusFailed,
				ErrorClass: ErrorClassInvalidOutput,
				Detail:     bounded(fmt.Sprintf("outputs envelope is %d bytes over the 32 KiB inline cap (§ 6); it must travel as a kind=json artifact (§ 4 step 9)", len(raw)), 512),
				OutputErrors: []any{map[string]any{
					"code": "outputs_too_large", "message": "outputs exceeded the inline cap",
				}},
			}
			return AttemptResult{}, &r
		}
	}
	base.Outputs = outputs
	base.OutputsDigest = "sha256:" + sha256Hex(raw)
	base.ArtifactRefs = []any{}
	return base, nil
}

// extractJSON reads a JSON extraction source under the § 6 1 MiB source cap.
// The bytes are the capture file's — written by the worker's own pipes, so
// the command cannot have rewritten them after it exited.
func extractJSON(path, label string) (any, *string) {
	st, err := os.Stat(path)
	if err != nil {
		msg := fmt.Sprintf("%s: unreadable extraction source: %v", label, err)
		return nil, &msg
	}
	if st.Size() > procExecExtractionMax {
		msg := fmt.Sprintf("%s: extraction source is %d bytes, over the 1 MiB inline bound (§ 6); it must travel as an artifact", label, st.Size())
		return nil, &msg
	}
	data, err := os.ReadFile(path)
	if err != nil {
		msg := fmt.Sprintf("%s: read extraction source: %v", label, err)
		return nil, &msg
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber() // integers stay integers into outputs and digests
	var val any
	if err := dec.Decode(&val); err != nil {
		msg := fmt.Sprintf("%s: extracted stdout/stderr is not valid JSON: %v", label, err)
		return nil, &msg
	}
	if dec.More() {
		msg := fmt.Sprintf("%s: extraction source carries trailing content after one JSON value", label)
		return nil, &msg
	}
	return val, nil
}

func mergeExtracted(outputs map[string]any, val any) {
	if m, ok := val.(map[string]any); ok {
		for k, v := range m {
			outputs[k] = v
		}
		return
	}
	outputs["json"] = val
}

func invalidOutput(detail string) AttemptResult {
	return AttemptResult{
		Status:     AttemptStatusFailed,
		ErrorClass: ErrorClassInvalidOutput,
		Detail:     bounded(detail, 512),
		OutputErrors: []any{map[string]any{
			"code":    "invalid_json",
			"message": bounded(detail, 400),
		}},
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// redact replaces host roots with a fixed word and bounds the line: grant
// paths never reach the journal or attempts.detail (deviation D14's rule,
// unit.go's discipline).
func (p *ProcExec) redact(s string) string {
	for _, root := range []string{p.WorkspaceRoot, p.LauncherHome, p.PolicyDir} {
		if root != "" {
			s = strings.ReplaceAll(s, root, "<host-root>")
		}
	}
	return bounded(s, 512)
}

// nonoLauncherEnv is nono's own environment, never the command's and never
// os.Environ(): the HOME here is what nono derives its protected state root
// from (probe C-H1). Same construction as UnitService.launcherNonoEnv — the
// one named variable (PATH) it may read is read by name, nothing else.
func (p *ProcExec) nonoLauncherEnv() []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	home := p.LauncherHome
	if home == "" {
		return []string{"PATH=" + path}
	}
	return []string{
		"PATH=" + path,
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_DATA_HOME=" + filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(home, ".local", "state"),
	}
}

// checkpointFor fills the boundary record. A missing/unbound workspace is
// reported by the caller as the honest infra refusal it is.
func (p *ProcExec) checkpointFor(ctx context.Context, c AttemptClaim, spec procExecSpec, outputsDigest string) AttemptCheckpoint {
	if p.Checkpoints == nil {
		return AttemptCheckpoint{}
	}
	ref, ok, err := p.Checkpoints.RunWorkspace(ctx, c.RunID)
	if err != nil || !ok || ref.WorkspaceID == "" || ref.VolumeID == "" {
		return AttemptCheckpoint{}
	}
	// The plan's own words, not the resolved ones: `executable`+`args` are what
	// the run's snapshot declared and they are host-portable, while argv[0] is a
	// path on this volume. The digest identifies the inputs the boundary was
	// taken over, and two workers resolving one plan must agree on it.
	inputs, err := json.Marshal(map[string]any{
		"executable": spec.executable, "args": spec.args,
		"cwd": spec.cwd, "extraction": spec.extraction, "path": spec.path,
	})
	if err != nil {
		return AttemptCheckpoint{}
	}
	return AttemptCheckpoint{
		InputsDigest:  "sha256:" + sha256Hex(inputs),
		OutputsDigest: outputsDigest,
		RepoStates:    ref.RepoStates,
		WorkspaceID:   ref.WorkspaceID,
		VolumeID:      ref.VolumeID,
		WorkerID:      c.WorkerID,
	}
}

func failedResult(class, detail string) AttemptResult {
	return AttemptResult{Status: AttemptStatusFailed, ErrorClass: class, Detail: bounded(detail, 512)}
}

// commandToolReads is § 4 step 5's missing half: the grant set the contract
// names is the workspace the command works ON, and nothing in it names the
// directory the program itself lives in. Under Landlock that difference is an
// exit 126 — `nono` found the file the worker's own PATH lookup resolved and
// could not execute it, which classify() reports as the unable-to-start class.
//
// The grant is the resolved executable's directory and, when the program is a
// script, the directory of the interpreter its `#!` line names — nothing else,
// and never a write: read is the level nono's Landlock ruleset pairs with exec
// (observed: --read /opt/m4/bin made m4-exit.sh runnable, egress unchanged).
// Paths are symlink-resolved, because nono resolves them too and N-d compares
// path-for-path: `--read /bin` is printed back as `r /usr/bin (dir) [user]`,
// and a want-list naming /bin would then be "missing" while /usr/bin was
// "never asked for".
//
// A program already inside a workspace grant (a checked-out build script) is
// skipped: the parent's ruleset covers its subtree, and re-granting it read
// would put two levels on one path and refuse the launch.
func commandToolReads(plan wsgit.LaunchPlan, argv0 string) []string {
	if argv0 == "" {
		return nil
	}
	if !filepath.IsAbs(argv0) {
		if resolved, err := exec.LookPath(argv0); err == nil {
			argv0 = resolved
		}
	}
	progs := []string{argv0}
	if interp, ok := shebangInterpreter(argv0); ok {
		progs = append(progs, interp)
	}

	var out []string
	seen := map[string]bool{}
	for _, prog := range progs {
		if prog == "" || !fileExists(prog) {
			continue
		}
		dir := filepath.Dir(prog)
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			dir = filepath.Clean(resolved)
		}
		if seen[dir] {
			continue
		}
		if coveredByGrant(plan, dir) {
			continue
		}
		seen[dir] = true
		out = append(out, dir)
	}
	return out
}

// coveredByGrant reports whether path already sits inside one of the plan's
// grants, in which case its ruleset reaches it.
func coveredByGrant(plan wsgit.LaunchPlan, path string) bool {
	for _, g := range plan.Grants {
		if g.Path != "" && inside(g.Path, path) {
			return true
		}
	}
	return false
}

// shebangInterpreter reads the `#!` line of a script and names the program the
// kernel would exec. `#!/usr/bin/env python3` is answered by the env-resolved
// program, because that is the file whose execution is being granted; a bare
// `#!/bin/sh` names /bin/sh itself. Binary executables (no `#!`) report false.
func shebangInterpreter(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 256)
	n, _ := io.ReadFull(f, buf)
	line, _, ok := strings.Cut(string(buf[:n]), "\n")
	if !ok && n < 2 {
		return "", false
	}
	head, rest, _ := strings.Cut(line, "\r")
	if !strings.HasPrefix(strings.TrimSpace(head), "#!") {
		return "", false
	}
	_ = rest
	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(head), "#!")))
	if len(fields) == 0 {
		return "", false
	}
	interp := fields[0]
	if filepath.Base(interp) == "env" && len(fields) > 1 {
		name := fields[len(fields)-1]
		if strings.HasPrefix(name, "-") {
			return "", false
		}
		if resolved, err := exec.LookPath(name); err == nil {
			return resolved, true
		}
		return "", false
	}
	if !filepath.IsAbs(interp) {
		resolved, err := exec.LookPath(interp)
		if err != nil {
			return "", false
		}
		interp = resolved
	}
	return interp, true
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}
