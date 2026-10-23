package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/secrets"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// NodeKindAgentACP is the § 4 step 6 node kind this executor runs. The string
// is the catalogue name verbatim (attemptport.go's Kind comment); the loop
// routes by it and never interprets it.
const NodeKindAgentACP = "agent.acp"

// interruptReasonKillTimeout is § 3 row 23's process_group_kill_timeout arm:
// the stop signal went out, the ack never came, and the session was retired.
// The store admits the reason (attempt_worker.go's InterruptAttemptOwn); the
// worker package has no constant for it because only this executor's protocol
// knowledge can produce it.
const interruptReasonKillTimeout = "process_group_kill_timeout"

// agent-turn bounds. The inline envelope cap is § 6's (32 KiB, shared with
// process.exec); the extraction bound is the same 1 MiB source cap — an agent
// that streams a megabyte of prose has produced evidence, not outputs.
const (
	agentInlineOutput  = 32 << 10
	agentExtractMax    = 1 << 20
	agentAckGrace      = 10 * time.Second
	agentPumpDrainWait = 2 * time.Second

	// agentConversationBusyPoll is the retry cadence of the
	// ErrAttemptConversationBusy wait: the conversation is a live agent the
	// human is still driving, and its terminal arrives in seconds-to-minutes,
	// so the poll is coarse — the lease renewal loop, not this timer, is what
	// keeps the attempt honest.
	agentConversationBusyPoll = time.Second
)

// The seams the agent.acp body needs beyond the attempt fence. Declared here,
// in the consumer's own words (seams.go's rule): the Postgres implementations
// land with the waves that own those steps, and until they are wired every
// refusal below names the missing step rather than inventing its record.

// AttemptConversation is the § 4 step 6 pair an attempt owns: the conversation
// and its stamped turn row, created in the claim's transaction. The executor
// reads them; it never creates them, because a worker that could enqueue the
// turn outside the claim could enqueue turns the fence never approved.
type AttemptConversation struct {
	ConversationID string
	TurnID         string
}

// ErrAttemptConversationBusy is the claim's stamp seam reporting the
// one-active-turn index (ADR-0016 § 5) refusing the attempt's turn row: the
// conversation still carries a non-terminal turn. In the takeover journey
// (docs/m4-contract.md § 5.3) that turn is the returning controller's own
// human prompt, queued before return-control — not an attempt that owes a
// close. It is a deferral, not a failure: the slot opens when that turn
// reaches its terminal (its worker closes it, or the reconciler's lease arm
// interrupts it), so the attempt waits for the slot with its lease renewing
// instead of the claim failing the node on a writer nobody asked to stop.
var ErrAttemptConversationBusy = errors.New("attempt conversation still carries a non-terminal turn")

// AttemptSessionStore is the binding bookkeeping the session body performs on
// the attempt's conversation: the stamped pair, the stored binding
// resume_if_supported answers against, the connected record, and the honest
// close at the attempt boundary.
type AttemptSessionStore interface {
	// ConversationFor reads this attempt's stamped conversation/turn pair.
	// ok=false is the § 4 step 6 wiring gap, stated as one.
	ConversationFor(ctx context.Context, c AttemptClaim) (AttemptConversation, bool, error)
	// ResumableSession reports the session id a stored binding offers for
	// this conversation on this worker, only when the recorded capabilities
	// advertised loadSession (TurnStore.ResumableSession's rule, verbatim).
	ResumableSession(ctx context.Context, conversationID, workerID string) (domain.SessionInfo, bool, error)
	// RecordBinding closes any stale live binding and inserts this attempt's
	// connected row; closedPrior names what this call closed.
	RecordBinding(ctx context.Context, c AttemptClaim, conversationID string, s domain.SessionInfo) (bindingID string, closedPrior []string, err error)
	// CloseBinding marks this worker's live binding closed for the attempt's
	// conversation and returns the affected ids for eventing.
	CloseBinding(ctx context.Context, conversationID, workerID, reason string) ([]string, error)
}

// AgentProfile is the launcher knowledge an agent.acp attempt needs from the
// pinned agent-profile revision (ADR-0008: a run keeps its revision). The
// worker never invents a launcher from a profile name, and it never chooses a
// prompting mode: those are registry facts read, not derived.
type AgentProfile struct {
	AgentProfileID string
	LauncherID     string
	// PermissionMode is M2's vocabulary: ask | deny |
	// preapproved_within_sandbox. "" means the profile declared none, which
	// the static policy answers and the Decider bridge still events.
	PermissionMode string
	// CommitGranted is the ADR-0017 D4 axis carried into the sandbox plan.
	CommitGranted bool
}

// AgentProfileResolver reads the pinned profile revision an attempt's
// config.profile names. ok=false is "the revision is not resolvable for this
// run" — an honest refusal, never a default launcher.
type AgentProfileResolver interface {
	AgentProfileFor(ctx context.Context, c AttemptClaim, profileName string) (AgentProfile, bool, error)
}

// PermissionVerdict is the node policy's answer to one prompt. OptionKind is
// matched against the prompt's options by KIND, never label or id
// (domain.PermissionOption's rule: observed harness ids disagree with their
// kinds). No match is an honest deny: the bridge returns the ACP cancelled
// outcome and events it, and never fabricates an option.
type PermissionVerdict struct {
	OptionKind string
	DecidedBy  string
}

// PermissionPolicy decides one prompt synchronously from the node's declared
// policy. A nil policy denies everything — fail closed, the same rule the
// adapter's nil-Decider default carries (domain.SessionRequest.Decider).
type PermissionPolicy func(prompt domain.PermissionPrompt) PermissionVerdict

// AgentTurn executes agent.acp attempts (docs/m4-contract.md § 4 steps 4–6,
// 8, 10–12): the run workspace handle, the pinned profile's launcher, the
// fail-closed prompting mode, the permission bridge that answers from the node
// policy and events both halves honestly, session resume answered by the
// binding's existence with fallback deciding what it cannot, ONE prompt turn
// per attempt under the verified sandbox launch, and a boundary that closes
// as infra when the workspace capture seam is unbound — never an invented
// checkpoint (D-024 is same-volume only). It composes the sessionFor sequence
// (turnloop.go:414-557) at attempt scope; it does not reuse the live-session
// map, because § 4 step 14 forbids holding an ACP session across attempts:
// an attempt therefore never claims the `reused` origin — only `new` or
// `resumed`, as the negotiated SessionInfo actually says (commit 9d0e560's
// labelling rule).
type AgentTurn struct {
	// WorkspaceRoot is COMMUNICATION_WORKSPACE_ROOT; the run's workspace is
	// <root>/run/<run-id> — the § 4 step 3 tree this executor consumes and
	// never prepares.
	WorkspaceRoot string
	// LauncherHome is nono's own HOME (probe C-H1: never a grant).
	LauncherHome string
	// PolicyDir materializes the agent-turn profile file (ADR-0009 D4).
	PolicyDir string
	// EgressAllow overrides the agent-turn egress allowlist. Empty means read
	// COMMUNICATION_AGENT_EGRESS_ALLOW, and an unset variable means nono's shipped
	// default (ADR-0035). It is operator configuration: nothing a pipeline can
	// write ever reaches this field.
	EgressAllow []string
	// SandboxPath is the nono executable, so argv and process agree.
	SandboxPath string
	// Sandbox is the verify seam; nil only reaches non-required modes.
	Sandbox AgentSandbox
	// Egress optionally reads one finished launch's own egress audit, which is
	// how an allowlisted agent turn earns ADR-0035's `allowlisted:<hosts>` label.
	// Nil means consult the sandbox backend itself (a real `*nono.Launcher`
	// answers), and a backend with no audit surface journals the run as
	// "audit unavailable" rather than failing it.
	Egress EgressAuditor
	// Enforcement is this worker's mode; a unit can only ever run in the mode
	// the worker was started with (no fallback branch exists, § 4 step 14).
	Enforcement domain.EnforcementMode
	// GitIdentity seeds the agent home and child env (probe P6's reasoning).
	GitIdentity acp.GitIdentityEnv
	// LauncherAuth resolves the launcher's declared credential directories,
	// the same optional hook UnitService carries. Nil launches without auth
	// grants, which the sandbox.verified event reports honestly.
	LauncherAuth func(launcherID string) ([]string, error)

	// Spawn launches one live session; under `required` it receives the
	// verified plan through acp.WithLaunchPlan and nothing reaches an
	// unsandboxed exec, because there is no third branch (ADR-0019 D6).
	Spawn domain.AgentSessionFactory
	// Profiles resolves the pinned agent profile the config names.
	Profiles AgentProfileResolver
	// Sessions is the attempt's binding bookkeeping.
	Sessions AttemptSessionStore
	// AskModeID maps a launcher to its verified prompting mode; "" refuses an
	// ask profile fail-closed rather than running the adapter's never-asks
	// default (docs/compatibility/ACP.md).
	AskModeID func(launcherID string) string
	// Permissions is the node policy answering session/request_permission.
	Permissions PermissionPolicy
	// ModePolicy, when wired, builds the per-attempt decider from the profile mode.
	ModePolicy func(mode string) PermissionPolicy
	// Checkpoints resolves the run workspace boundary identity. Nil until the
	// § 4 step 3 wave wires it; successes then close as infra, visibly,
	// naming the missing step — procexec's rule, same words.
	Checkpoints RunWorkspaceResolver
	// Secrets materializes this attempt's `node_attempt` mounts (contract § 4
	// step 4): env entries land in the agent process environment, env_file
	// writes land in the checkout with the exclusion appended first, and the
	// ledger row carries attempt_id. Same machinery the M3 turn unit uses — one
	// materializer in the process (ADR-0018 D4), not a second one. Nil means no
	// seam is wired, unit.go's precedent for "nothing materialized" rather than
	// a refusal of every attempt.
	Secrets AttemptSecrets

	// AckGrace bounds the wait for the ACP turn to land after session/cancel
	// (§ 4 step 11's grace window); zero takes agentAckGrace.
	AckGrace time.Duration
	// Quiesce is how long trailing stream updates may still arrive after
	// Prompt returns before the final text is read (DefaultQuiesce's rule).
	Quiesce time.Duration
	// ConversationBusyPoll is the retry cadence while the attempt's
	// conversation still carries a non-terminal turn at stamp time
	// (ErrAttemptConversationBusy's wait); zero takes
	// agentConversationBusyPoll.
	ConversationBusyPoll time.Duration
	// Transcript bounds the attempt's transcript rows (chunk size, preview
	// size, idle coalescing). Zero is M2's own cadence — the attempt path is
	// not allowed a different one (§ 4 step 6).
	Transcript TurnConfig
	// Clock drives the sink's idle flush; nil is the wall clock.
	Clock  Clock
	Logger *slog.Logger

	profileOnce *profileCache
	memoMu      sync.Mutex
}

var _ AttemptExecutor = (*AgentTurn)(nil)

func (a *AgentTurn) logger() *slog.Logger {
	if a.Logger != nil {
		return a.Logger
	}
	return slog.Default()
}

func (a *AgentTurn) enforcement() domain.EnforcementMode {
	if a.Enforcement == "" {
		return domain.EnforceRequired
	}
	return a.Enforcement
}

func (a *AgentTurn) nonoBinary() string {
	if a.SandboxPath != "" {
		return a.SandboxPath
	}
	return "nono"
}

func (a *AgentTurn) ackGrace() time.Duration {
	if a.AckGrace > 0 {
		return a.AckGrace
	}
	return agentAckGrace
}

func (a *AgentTurn) quiesce() time.Duration {
	if a.Quiesce > 0 {
		return a.Quiesce
	}
	return DefaultQuiesce
}

func (a *AgentTurn) busyPoll() time.Duration {
	if a.ConversationBusyPoll > 0 {
		return a.ConversationBusyPoll
	}
	return agentConversationBusyPoll
}

func (a *AgentTurn) askMode(launcherID string) string {
	if a.AskModeID == nil {
		return ""
	}
	return a.AskModeID(launcherID)
}

// profile returns the communication-agent policy file, materialized once per
// process. Since ADR-0035 the agent-turn profile carries an egress allowlist, so
// its NetworkEnforced claim is the worker's own configuration: allowlisted by
// default (nono.DefaultEgressHosts, provisional pending the live turn), open on
// an explicit COMMUNICATION_AGENT_EGRESS_ALLOW=open, and whatever host list the
// operator set otherwise. What the profile *claims* is still not what the run
// gets to *report* — see nono.VerificationResult.EgressReport.
func (a *AgentTurn) profile() (*nono.Profile, error) {
	a.memoMu.Lock()
	if a.profileOnce == nil {
		a.profileOnce = &profileCache{}
	}
	cache := a.profileOnce
	a.memoMu.Unlock()
	if a.PolicyDir == "" {
		return nil, errors.New("worker: no policy directory is configured, so the agent-turn profile cannot be materialized (ADR-0009 D4 requires -p <path>)")
	}
	net, hosts, err := agentEgressAllow(a.EgressAllow)
	if err != nil {
		return nil, err
	}
	return cache.do(nono.ProfileAgentTurn, func() (*nono.Profile, error) {
		return nono.WriteProfileNetwork(a.PolicyDir, nono.ProfileAgentTurn, net, hosts)
	})
}

// agentTurnSpec is one parsed agent.acp config — the members the
// bindingText-path hydration delivers (prompt text + agent profile + session
// mode). Like procExecSpec this map is executor-owned per kind.
type agentTurnSpec struct {
	prompt      string
	profileName string
	sessionMode string // new | resume_if_supported (continue_live is refused)
	fallback    string // new | fail
}

// parseConfig reads the kind-owned config; every shape problem is an honest
// refusal class (infra = plan/loader gap, binding_error = the advancer has
// work left, § 4 step 14).
func (a *AgentTurn) parseConfig(c AttemptClaim) (agentTurnSpec, *AttemptResult) {
	var spec agentTurnSpec
	fail := func(class, detail string) (agentTurnSpec, *AttemptResult) {
		r := failedResult(class, detail)
		return spec, &r
	}
	cfg := c.Config
	if cfg == nil {
		return fail(ErrorClassInfra, "agent.acp attempt carries no config: the claim did not hydrate a plan node")
	}
	pv, ok := cfg["prompt"]
	if !ok {
		return fail(ErrorClassInfra, "agent.acp config has no prompt")
	}
	if isUnresolved(pv) {
		return fail(ErrorClassBindingError, "agent.acp prompt still carries unresolved expression bindings; the bindingText path is hydrated by claim resolution and the advancer resolves expressions — the worker never evaluates them (§ 4 step 14)")
	}
	spec.prompt, _ = pv.(string)
	if spec.prompt == "" {
		return fail(ErrorClassInfra, "agent.acp prompt is empty: an agent turn with nothing to ask is a plan bug, not a no-op")
	}
	nameRaw, has := cfg["profile"]
	if !has {
		if alt, hasAgent := cfg["agent"]; hasAgent {
			if isUnresolved(alt) {
				return fail(ErrorClassBindingError, "agent.acp agent profile carries an unresolved binding")
			}
			spec.profileName, _ = alt.(string)
		}
	} else {
		if isUnresolved(nameRaw) {
			return fail(ErrorClassBindingError, "agent.acp profile carries an unresolved binding")
		}
		spec.profileName, _ = nameRaw.(string)
	}
	if spec.profileName == "" {
		return fail(ErrorClassInfra, "agent.acp config names no agent profile: the launcher is read from the pinned revision, never invented (§ 4 step 6)")
	}
	spec.sessionMode = "new"
	if v, ok := cfg["sessionMode"]; ok {
		if isUnresolved(v) {
			return fail(ErrorClassBindingError, "agent.acp sessionMode carries an unresolved binding")
		}
		m, _ := v.(string)
		switch m {
		case "", "new":
		case "resume_if_supported":
			spec.sessionMode = m
		case "continue_live":
			// Defensive: the compiler blocks this at validate
			// (unsupported_session_mode, ADR-024 § 3). A plan that reached a
			// worker anyway is a routing bug, and holding a live session
			// across attempts is exactly what § 4 step 14 forbids.
			return fail(ErrorClassInfra, "agent.acp sessionMode continue_live reached the worker although the compiler refuses it at validate: a live ACP session may not be held across node executions (ADR-0024 § 3, contract § 4 step 14)")
		default:
			return fail(ErrorClassInfra, fmt.Sprintf("agent.acp sessionMode %q is not new or resume_if_supported (§ 4 step 6)", m))
		}
	}
	spec.fallback = "new"
	if v, ok := cfg["fallback"]; ok {
		if isUnresolved(v) {
			return fail(ErrorClassBindingError, "agent.acp fallback carries an unresolved binding")
		}
		f, _ := v.(string)
		switch f {
		case "", "new":
		case "fail":
			spec.fallback = f
		default:
			return fail(ErrorClassInfra, fmt.Sprintf("agent.acp fallback %q is not new or fail (§ 4 step 6)", f))
		}
	}
	return spec, nil
}

// Execute runs one agent turn. Every refusal names itself; none pretends.
//
// It is a thin wrapper over executeAttempt for one reason: the values this
// attempt materialized are known only to the materializer, and nothing the
// attempt writes — journal payloads or the terminal result — may carry them
// (12-test-strategy case 12). The hook must therefore be applied outside the
// body that owns it, and it is reported through a per-call variable rather than
// a field: one *AgentTurn serves concurrent attempts, so per-attempt state on
// the struct would be both a race and a leak from one attempt into another's
// redaction.
func (a *AgentTurn) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	var redact func(string) (string, int)
	res, err := a.executeAttempt(ctx, c, sink, &redact)
	if redact != nil {
		res = redactResult(redact, res)
	}
	return res, err
}

func (a *AgentTurn) executeAttempt(ctx context.Context, c AttemptClaim, sink AttemptSink, redactHook *func(string) (string, int)) (AttemptResult, error) {
	spec, refusal := a.parseConfig(c)
	if refusal != nil {
		return *refusal, nil
	}
	if a.Spawn == nil {
		return failedResult(ErrorClassInfra, "agent.acp requires a session factory (spawn.NewSession); none is wired"), nil
	}
	if a.Sessions == nil {
		return failedResult(ErrorClassInfra, "agent.acp requires the attempt session store — the conversation/turn pair and the binding record are contract § 4 step 6, and an executor that skipped them would journal a session that exists in no row"), nil
	}

	prof, refusal := a.resolveProfile(ctx, c, spec.profileName)
	if refusal != nil {
		return *refusal, nil
	}
	// All three recorded modes are enforced the same way: the harness is put
	// into the launcher's prompting mode, and the permissionBridge plus
	// PermissionPolicyFor then answer and journal each prompt (deny →
	// cancelled, preapproved → allow_once with the node_policy decider).
	// Leaving modeID empty would pin the adapter to its never-asks default
	// (docs/compatibility/ACP.md), which sends no session/request_permission
	// at all: a 'deny' profile would then allow every tool call, and a
	// 'preapproved' attempt would journal no per-call verdict (ADR-0036 (a)).
	modeID := ""
	switch prof.PermissionMode {
	case "ask", "deny", "preapproved_within_sandbox":
		modeID = a.askMode(prof.LauncherID)
		if modeID == "" {
			return failedResult(ErrorClassInfra, fmt.Sprintf(
				"agent profile %q requires the prompting permission mode (%s), but launcher %s has no verified prompting mode (docs/compatibility/ACP.md): running its never-asks default would be a lie about review",
				spec.profileName, prof.PermissionMode, prof.LauncherID)), nil
		}
	case "":
		// No recorded mode: agent_profiles.permission_mode is NOT NULL DEFAULT
		// 'ask' (migrations/00003_m2_conversations.sql:57), so no row the
		// resolver can read is empty. Nothing to honour here; static policy
		// answers prompts and the Decider bridge still events them.
	default:
		return failedResult(ErrorClassInfra, "agent profile names unknown permission mode "+prof.PermissionMode), nil
	}
	launcher, lok := acp.LookupLauncher(prof.LauncherID)
	if !lok {
		return failedResult(ErrorClassInfra, fmt.Sprintf(
			"launcher %q for agent profile %q is not a known launcher, so no sandbox plan can name its adapter (docs/compatibility/ACP.md)",
			prof.LauncherID, spec.profileName)), nil
	}

	layout, refusal := a.runWorkspace(c)
	if refusal != nil {
		return *refusal, nil
	}
	homeDir := filepath.Join(layout.Home, "attempts", c.AttemptID)
	tmpDir := filepath.Join(layout.Scratch, "attempts", c.AttemptID)
	for _, dir := range []string{homeDir, tmpDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return failedResult(ErrorClassInfra, "create attempt directory: "+a.redact(err.Error())), nil
		}
	}

	conv, refusal := a.conversationFor(ctx, c)
	if refusal != nil {
		return *refusal, nil
	}

	workspaceID := ""
	if a.Checkpoints != nil {
		if ref, ok, err := a.Checkpoints.RunWorkspace(context.WithoutCancel(ctx), c.RunID); err == nil && ok {
			workspaceID = ref.WorkspaceID
		}
	}

	// ADR-0017 D4 / probe P10: the attempt consumes the § 4 step 3 preparation,
	// so it reads the workspace's repositories back once and uses them twice —
	// for the mirror grants of the launch plan below, and for the secret mounts
	// (materializeSecrets), which already asked this same read.
	repos, refusal := a.attemptRepos(ctx, workspaceID)
	if refusal != nil {
		return *refusal, nil
	}

	// § 4 step 4, in the order the contract fixes: secrets are materialized
	// before the launch, and therefore before any checkpoint capture, so the
	// exclusion that keeps an env_file mount out of the artifact is already in
	// place when the capture reads the tree (ADR-0020 § 6). A refusal here fails
	// the attempt with no child and no partial set (ADR-0018 D4's rule).
	materialized, refusal := a.materializeSecrets(ctx, c, prof, conv, workspaceID, layout, repos)
	if refusal != nil {
		return *refusal, nil
	}
	if materialized != nil {
		defer a.cleanupSecrets(c, materialized, layout)
		if redactHook != nil && materialized.Redact != nil {
			*redactHook = materialized.Redact
			sink = redactingAttemptSink{inner: sink, redact: materialized.Redact}
		}
		// ADR-0045: a GitHub token delivered for this attempt makes push possible
		// — but only while the egress allowlist admits the GitHub hosts. Warn, never
		// claim: the token cannot push until the operator widens
		// COMMUNICATION_AGENT_EGRESS_ALLOW.
		if gitEnv := GitPushEnv(materialized.Env); len(gitEnv) > 0 {
			if net, hosts, err := agentEgressAllow(a.EgressAllow); err == nil && net == nono.NetworkAllowlisted && !hostAllowed(hosts, "github.com") && !hostAllowed(hosts, "api.github.com") {
				a.logger().Warn("the agent holds a GitHub token but the egress allowlist does not admit the GitHub hosts: push will fail, add github.com,api.github.com to COMMUNICATION_AGENT_EGRESS_ALLOW",
					slog.String("attempt_id", c.AttemptID), slog.String("egress_allow", strings.Join(hosts, ",")))
			}
		}
	}

	credDirs, auth, err := a.credentialAuth(launcher)
	if err != nil {
		return failedResult(ErrorClassInfra, "resolve launcher credential directories: "+a.redact(err.Error())), nil
	}
	// ADR-0040: the launcher's long-lived token is read from the operator
	// file at launch time. It rides the sandbox launcher's process
	// environment (or, unsandboxed, the adapter's exec environment) — it
	// must NOT join adapterEnv: that list renders into the `env NAME=value`
	// argv hop, and nono's audit journal records the argv verbatim.
	oauthKV, err := launcher.OAuthTokenKV()
	if err != nil {
		return failedResult(ErrorClassInfra, "resolve launcher long-lived token: "+a.redact(err.Error())), nil
	}
	required := a.enforcement() == domain.EnforceRequired
	// The env-delivered mounts join the child environment here and nowhere else:
	// not the journal, not an artifact, not a log line (seams.go's rule for `env`
	// values, ADR-0018 D4). They go last on purpose — what the platform
	// authorized for this attempt outranks anything the launcher sets for itself —
	// and they travel through the launch environment (SecretEnv), never through
	// the adapter env the launcher's `env` hop renders into argv (ADR-0040).
	delivered := []string(nil)
	if materialized != nil {
		delivered = materialized.Env
	}
	adapterEnv, err := acp.LaunchEnv(acp.EnvRequest{
		Home:    homeDir,
		Scratch: tmpDir,
		// The two HOMEs (probe C-H1): under a sandbox the launcher's `env` hop
		// owns HOME and the argv builder refuses a caller-supplied one.
		OmitHome:    required,
		GitIdentity: a.GitIdentity,
		Auth:        auth,
		SecretEnv:   delivered,
		Extra: []string{
			"COMMUNICATION_RUN_ID=" + c.RunID,
			// The name below is also the egress-audit marker (egressaudit.go):
			// nono records the child's argv in its audit journal, so this one entry
			// is what lets a finished run find ITS OWN session.
			egressMarkerEnv + "=" + c.AttemptID,
			"COMMUNICATION_WORKSPACE_ID=" + workspaceID,
		},
	})
	if err != nil {
		return failedResult(ErrorClassInfra, "build agent environment: "+bounded(err.Error(), 400)), nil
	}

	plan := wsgit.LaunchPlan{
		WorkspaceID: "run/" + c.RunID,
		Layout:      layout,
		Grants: []wsgit.Grant{
			{Role: wsgit.RoleCheckout, Path: layout.Repos},
			{Role: wsgit.RoleScratch, Path: layout.Scratch},
			{Role: wsgit.RoleAgentHome, Path: layout.Home},
		},
		LauncherHome:  a.LauncherHome,
		AgentHome:     homeDir,
		Cwd:           layout.Repos,
		CommitGranted: prof.CommitGranted,
	}
	// ADR-0017 D4 required this plan to carry the mirror axis Plan() documents
	// as never optional: probe P10 measured that ANY git command inside a linked
	// worktree dies with "fatal: not a git repository" unless the mirror is
	// readable (the lab's agent saw exactly this — the worktree .git file
	// pointing into the mirror tree with no grant reaching it), and with the
	// commit axis granted the four mirror writes join too. Same roles, same
	// order, same source wsgit.Plan uses (git.MirrorGrants is the single shape).
	mirrorGrants, err := attemptMirrorGrants(layout, repos, prof.CommitGranted)
	if err != nil {
		return failedResult(ErrorClassInfra, "agent launch plan: "+a.redact(err.Error())), nil
	}
	plan.Grants = append(plan.Grants, mirrorGrants...)
	// M3's credential grant in the attempt shape (ADR-0019 D4): the launcher's
	// declared credential directories join the grant set under the
	// harness_credentials role — the same role, and the same access, the
	// conversation path already grants. Without it the sandbox cannot read
	// the credential tree and the adapter aborts with "Authentication
	// required" (launchplan.go's C-FC3 rule means a missing path here is a
	// refusal, never a silent drop: credentialAuth checked existence).
	for _, dir := range credDirs {
		plan.Grants = append(plan.Grants, wsgit.Grant{Role: wsgit.RoleHarnessAuth, Path: dir})
	}
	if err := plan.Check(); err != nil {
		return failedResult(ErrorClassInfra, "agent launch plan: "+a.redact(err.Error())), nil
	}

	launch, chain, refusal := a.verifyThenPlan(ctx, sink, c, plan, launcher, adapterEnv, delivered, oauthKV, required, workspaceID)
	if refusal != nil {
		return *refusal, nil
	}

	policy := a.Permissions
	if a.ModePolicy != nil {
		policy = a.ModePolicy(prof.PermissionMode)
	}
	req := domain.SessionRequest{
		LauncherID: prof.LauncherID,
		WorkDir:    plan.Cwd,
		ModeID:     modeID,
		Decider:    a.permissionBridge(c, conv, policy, sink),
	}
	// sessionMode: resume_if_supported is answered by the binding's existence
	// (§ 4 step 6); when no resumable binding exists the configured fallback
	// decides, and the answer is recorded in the connected event's origin —
	// nothing claims `resumed` for a session that was not loaded.
	if spec.sessionMode == "resume_if_supported" {
		prev, ok, err := a.Sessions.ResumableSession(ctx, conv.ConversationID, c.WorkerID)
		if err != nil && ctx.Err() == nil {
			a.logger().Warn("agent.acp resumable-session read failed; treating as no binding",
				slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		}
		if ok && prev.ACPSessionID != "" {
			req.LoadSessionID = prev.ACPSessionID
		} else if spec.fallback == "fail" {
			return failedResult(ErrorClassInfra,
				"sessionMode resume_if_supported with fallback: fail, but no resumable binding exists for the attempt's conversation (contract § 4 step 6): the provider cannot resume and the node said fail"), nil
		}
	}

	sess, err := a.Spawn.NewSession(acp.WithLaunchPlan(ctx, launch), req)
	if err != nil {
		if ctx.Err() != nil {
			// A stop signal raced the spawn. No session existed, so no ACP
			// ack is claimable from here either: speak nothing and let the
			// loop's flags name the terminal from the signal it owns.
			return AttemptResult{}, nil
		}
		return failedResult(ErrorClassInfra, "agent session unavailable: "+a.redact(err.Error())), nil
	}
	info := sess.Info()
	if req.LoadSessionID != "" && info.Origin != events.SessionOriginResumed && spec.fallback == "fail" {
		_ = sess.Close()
		return failedResult(ErrorClassInfra, "the provider did not resume the loaded session and the node declared fallback: fail (contract § 4 step 6); continuing on a new session would be a different promise than the one made"), nil
	}

	bindingID, closedPrior, err := a.Sessions.RecordBinding(ctx, c, conv.ConversationID, info)
	if err != nil {
		_ = sess.Close()
		if errors.Is(err, ErrLeaseLost) {
			return AttemptResult{}, nil // the loop's fence decides; write nothing
		}
		return failedResult(ErrorClassInfra, "record session binding: "+a.redact(err.Error())), nil
	}
	for _, id := range closedPrior {
		a.journal(ctx, sink, c, events.TypeAgentSessionDisconnected, events.SessionDisconnectedPayload{
			ConversationID: conv.ConversationID, BindingID: id, WorkerID: c.WorkerID,
			ACPSessionID: info.ACPSessionID, Reason: "replaced",
		})
	}
	a.journal(ctx, sink, c, events.TypeAgentSessionConnected, events.SessionConnectedPayload{
		ConversationID: conv.ConversationID, BindingID: bindingID, WorkerID: c.WorkerID,
		ACPSessionID: info.ACPSessionID, ProtocolVersion: info.ProtocolVersion,
		LauncherID: info.LauncherID, LauncherVersion: info.LauncherVersion,
		SessionOrigin: info.Origin, AgentCapabilities: info.AgentCapabilities,
	})

	// ONE prompt turn per attempt (§ 4 step 14: no session survives the
	// attempt, so no second prompt is structurally available). The stream
	// pump coalesces the final agent text concurrently; a tool call resets
	// the buffer because text before a tool call is not the final answer.
	final := &agentText{}
	transcript := a.attemptTranscript(ctx, c, conv, sink)
	pdone := make(chan struct{})
	go func() {
		defer close(pdone)
		for ev := range sess.Events() {
			final.add(ev)
			transcript.emit(ev)
		}
	}()

	type promptAnswer struct {
		stop domain.StopReason
		err  error
	}
	pproc := make(chan promptAnswer, 1)
	go func() {
		s, perr := sess.Prompt(ctx, spec.prompt)
		pproc <- promptAnswer{s, perr}
	}()

	var stop domain.StopReason
	var promptErr error
	var cancelErr error
	ackTimedOut := false
	stopAsked := false
	select {
	case p := <-pproc:
		stop, promptErr = p.stop, p.err
	case <-ctx.Done():
		// § 4 step 11: send ACP session/cancel, wait the grace window, then
		// retire the session; the ack that never came is what names the
		// terminal process_group_kill_timeout instead of acp_cancel_ack. The
		// write failing IS an ack that never came, so it is captured, not
		// dropped — a cancel nobody received must not close a cancelled.
		cancelErr = sess.Cancel(context.WithoutCancel(ctx))
		select {
		case p := <-pproc:
			stop, promptErr = p.stop, p.err
		case <-time.After(a.ackGrace()):
			ackTimedOut = true
		}
	case <-sink.Stopping():
		// Drain's graceful ask (step 12): stop the harness now and let the
		// in-flight prompt land; the loop's shutdown flag writes the honest
		// interrupted{worker_shutdown} whatever the harness answered.
		stopAsked = true
		cancelErr = sess.Cancel(context.WithoutCancel(ctx))
		p := <-pproc
		stop, promptErr = p.stop, p.err
	}
	// Ask the session before retiring it: did its transport die while this
	// turn was in flight? ACP handles answer (acp.DisconnectReporter); a
	// session that cannot answer is honest absence, not a disconnect.
	discInfo, midTurnDisc := acp.SessionDisconnect(sess)

	_ = sess.Close()
	select {
	case <-pdone:
	case <-time.After(agentPumpDrainWait):
	}
	time.Sleep(a.quiesce())

	ts := turnStop{asked: stopAsked, ackTimedOut: ackTimedOut, cancelFailed: cancelErr != nil}
	res := a.mapTurnOutcome(ctx, stop, promptErr, ts)
	// mapTurnOutcome's default arm answers end_turn with the empty result:
	// extraction owns the answer. The guards keep the drain and cancel arms
	// from ever reaching it.
	endTurn := res.Status == "" && !ts.asked && !ts.ackTimedOut &&
		ctx.Err() == nil && promptErr == nil && stop == domain.StopEndTurn
	if endTurn {
		built, fail := a.attachOutputs(c, spec, prof, final.text())
		if fail != nil {
			// Extraction refused the reply. Before blaming the agent's answer,
			// ask whether there was an answer to blame: a harness whose
			// transport died mid-turn leaves a silence, and ADR-0023 § 7 does
			// not let that silence be reported as invalid_output — the class is
			// reserved for a reply that fails its schema. A completed turn with
			// a bad reply still says invalid_output (the case below).
			if midTurnDisc {
				res = failedResult(ErrorClassInfra, disconnectDetail(discInfo))
			} else {
				res = *fail
			}
		} else {
			built.Checkpoint = a.checkpointFor(ctx, c, spec, prof, built.OutputsDigest)
			if built.Checkpoint.VolumeID == "" {
				// Honest: there is no boundary to write. The turn answered;
				// the engine cannot durably say so. Say which half is missing.
				res = failedResult(ErrorClassInfra,
					"agent turn completed but no run workspace boundary is bound (contract § 4 step 3): a checkpoint requires a workspace row and its volume (D-024 is same-volume only)")
			} else {
				res = built
			}
		}
	}

	// The transcript closes before the attempt speaks its terminal row: the
	// chunks and tool lines are the run's conversation, and a member watching
	// the run page must see them in order under the terminal event.
	a.closeTranscript(ctx, transcript, res.Status == AttemptStatusSucceeded)

	// Retire the binding honestly. A rejected final journal write means the
	// fence already proved us stale: runner.go's abandon rule then skips the
	// binding — the new owner's RecordBinding closes it, ours must not.
	disconnected := "process_exited"
	if stopAsked {
		disconnected = "shutdown"
	}
	// The teardown runs on a detached, bounded context: a cancelled attempt
	// must still be able to say its session went away (runner.go's finish
	// path is the precedent), and a lost fence stops it by refusing the
	// append rather than by a dead stream.
	dctx, dcancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	if a.journal(dctx, sink, c, events.TypeAgentSessionDisconnected, events.SessionDisconnectedPayload{
		ConversationID: conv.ConversationID, BindingID: bindingID, WorkerID: c.WorkerID,
		ACPSessionID: info.ACPSessionID, Reason: disconnected,
	}) {
		if _, cerr := a.Sessions.CloseBinding(dctx, conv.ConversationID, c.WorkerID, disconnected); cerr != nil {
			a.logger().Warn("closing attempt session binding failed",
				slog.String("attempt_id", c.AttemptID), slog.String("error", cerr.Error()))
		}
	}
	// ADR-0035's evidence read. The child is gone now, so this run's own audit
	// journal is complete and only now can an allowlisted profile earn
	// `allowlisted:<hosts>`. It rides the same detached context as the
	// disconnect row — a cancelled attempt still has to say what its sandbox
	// did — under its own 2 s bound, and it can cost a label but never a turn.
	a.journalEgressAudit(dctx, sink, c, workspaceID, chain)
	dcancel()
	return res, nil
}

// resolveProfile reads the launcher knowledge from the pinned profile
// revision; every gap is an infra refusal naming the seam, not a default.
func (a *AgentTurn) resolveProfile(ctx context.Context, c AttemptClaim, name string) (AgentProfile, *AttemptResult) {
	if a.Profiles == nil {
		return AgentProfile{}, ptrResult(failedResult(ErrorClassInfra,
			"agent.acp requires an agent-profile source: the launcher is read from the pinned revision (contract § 4 step 6), never guessed from the profile name"))
	}
	prof, ok, err := a.Profiles.AgentProfileFor(ctx, c, name)
	if err != nil {
		if ctx.Err() != nil {
			return AgentProfile{}, ptrResult(failedResult(ErrorClassInfra, "agent profile lookup interrupted: "+a.redact(err.Error())))
		}
		return AgentProfile{}, ptrResult(failedResult(ErrorClassInfra, "read agent profile "+name+": "+a.redact(err.Error())))
	}
	if !ok || prof.LauncherID == "" {
		return AgentProfile{}, ptrResult(failedResult(ErrorClassInfra, fmt.Sprintf(
			"agent profile %q is not resolvable for this run (the revision is pinned, ADR-0008): no launcher can be named for it", name)))
	}
	return prof, nil
}

// runWorkspace is the § 4 step 3 tree this executor consumes and never
// creates — a missing tree is a wiring fact, stated as one.
func (a *AgentTurn) runWorkspace(c AttemptClaim) (wsgit.Layout, *AttemptResult) {
	if a.WorkspaceRoot == "" {
		return wsgit.Layout{}, ptrResult(failedResult(ErrorClassInfra, "agent.acp requires a configured workspace root"))
	}
	if !uuidDir.MatchString(c.RunID) || !uuidDir.MatchString(c.AttemptID) {
		return wsgit.Layout{}, ptrResult(failedResult(ErrorClassInfra, "agent.acp run/attempt ids must be uuids: workspace paths are built from them"))
	}
	layout, err := wsgit.LayoutOf(a.WorkspaceRoot, "run", c.RunID)
	if err != nil {
		return wsgit.Layout{}, ptrResult(failedResult(ErrorClassInfra, "agent.acp workspace scope: "+a.redact(err.Error())))
	}
	for _, dir := range []string{layout.Work, layout.Repos, layout.Scratch, layout.Home} {
		if st, serr := os.Stat(dir); serr != nil || !st.IsDir() {
			return wsgit.Layout{}, ptrResult(failedResult(ErrorClassInfra, fmt.Sprintf(
				"run workspace is not prepared under %s (contract § 4 step 3)", a.redact(layout.Work))))
		}
	}
	if err := layout.AssertNothingBut(); err != nil {
		return wsgit.Layout{}, ptrResult(failedResult(ErrorClassInfra, a.redact(err.Error())))
	}
	return layout, nil
}

// attemptRepos reads the run workspace's prepared repositories back once per
// attempt (the same authorized read the secret mounts use — the rows § 4 step 3
// wrote, never a path inferred from the layout). No Secrets seam or no run
// workspace means no repos are known, and therefore no mirror grants: the
// attempt shape degrades to what it was before ADR-0017 D4 was wired here,
// visibly, rather than inventing a path.
func (a *AgentTurn) attemptRepos(ctx context.Context, workspaceID string) ([]MaterializeRepo, *AttemptResult) {
	if a.Secrets == nil || workspaceID == "" {
		return nil, nil
	}
	repos, err := a.Secrets.ReposForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, ptrResult(failedResult(ErrorClassInfra,
			"read the run workspace's repositories for the attempt grant set: "+a.redact(err.Error())))
	}
	return repos, nil
}

// attemptMirrorGrants builds the per-repository mirror grant axis for the
// attempt-shaped plan from the workspace_repos rows. The roles and their order
// are git.MirrorGrants' — the same source wsgit.Plan consumes — so the two
// shapes cannot drift. The admin dir the commit axis needs is not a row the
// attempt reads (MaterializeRepo carries four paths, not five), so it is read
// back the way probe G1c validated: the worktree's own `.git` file agrees with
// `rev-parse --absolute-git-dir`, and a read that cannot answer fails the plan
// rather than dropping the grant (C-FC3: a silently missing grant is the bug
// this whole axis exists to close).
func attemptMirrorGrants(layout wsgit.Layout, repos []MaterializeRepo, commitGranted bool) ([]wsgit.Grant, error) {
	var out []wsgit.Grant
	for _, repo := range repos {
		if repo.MirrorPath == "" {
			continue
		}
		adminDir := ""
		if commitGranted {
			dir, err := worktreeAdminDir(repo.CheckoutPath)
			if err != nil {
				return nil, err
			}
			adminDir = dir
		}
		out = append(out, wsgit.MirrorGrants(layout.ScopeID, repo.MirrorPath, adminDir, commitGranted)...)
	}
	return out, nil
}

// worktreeAdminDir reads the linked worktree's git dir from its `.git` file
// (G1c's read-back; the admin dir is never constructed — probe G1 measured the
// `worktrees/<name>1` collision-suffix form a second worktree gets).
func worktreeAdminDir(checkoutPath string) (string, error) {
	if checkoutPath == "" {
		return "", fmt.Errorf("workspace: cannot read back the git dir of a checkout with no path")
	}
	raw, err := os.ReadFile(filepath.Join(checkoutPath, ".git"))
	if err != nil {
		return "", fmt.Errorf("workspace: read back the git dir of %s: %w", checkoutPath, err)
	}
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(raw)), "\n", 2)[0])
	target, ok := strings.CutPrefix(line, "gitdir:")
	if !ok {
		return "", fmt.Errorf("workspace: %s/.git is not a linked-worktree gitfile", checkoutPath)
	}
	adminDir := filepath.Clean(strings.TrimSpace(target))
	if !filepath.IsAbs(adminDir) {
		adminDir = filepath.Clean(filepath.Join(checkoutPath, adminDir))
	}
	return adminDir, nil
}

// materializeSecrets is contract § 4 step 4 at attempt scope: the same
// SecretMaterializer the M3 turn unit drives, asked for the `node_attempt` arm
// only, with the attempt id that the ledger row must carry. The repositories a
// mount may target are read from the workspace § 4 step 3 prepared — an attempt
// never invents a checkout path.
//
// PolicyDigest is deliberately empty: under `required` the policy is not
// verified until step 5, and a digest claimed at step 4 would be a promise about
// a launch that has not been checked yet. The event reports it empty, which is
// the same honest answer M3's non-required modes give.
func (a *AgentTurn) materializeSecrets(ctx context.Context, c AttemptClaim, prof AgentProfile, conv AttemptConversation, workspaceID string, layout wsgit.Layout, repos []MaterializeRepo) (*Materialized, *AttemptResult) {
	if a.Secrets == nil {
		return nil, nil
	}
	var extra []string
	m, err := a.Secrets.Materialize(ctx, MaterializeRequest{
		OrganizationID: c.OrganizationID, ProjectID: c.ProjectID,
		WorkspaceID: workspaceID, ConversationID: conv.ConversationID,
		// The attempt's own stamped turn (§ 4 step 6) is the turn scope the
		// secret events name; a materializer that left it empty would journal
		// an attempt delivery as an ownerless one.
		TurnID: conv.TurnID, WorkerID: c.WorkerID,
		AgentProfileID:  prof.AgentProfileID,
		AttemptID:       c.AttemptID,
		Lifecycle:       LifecycleNodeAttempt,
		Repos:           repos,
		ExtraExclusions: &extra,
	})
	if err != nil {
		if errors.Is(err, secrets.ErrNotAuthorized) {
			// A mount this attempt's node declared but its profile was never
			// granted: not this attempt's to have, so nothing is delivered and
			// nothing is recorded for it (contract § 4 step 4). The attempt is not
			// the one that failed to be authorized, so it does not fail for it —
			// the same skip process.exec already made.
			a.logger().Debug("node_attempt mount is not authorized for this attempt: delivering nothing",
				slog.String("attempt_id", c.AttemptID), slog.String("project_id", c.ProjectID))
			return nil, nil
		}
		// The reason is already in the journal (secret.materialization_failed,
		// written by the materializer in its own transaction); the attempt's
		// detail says only that the mount was refused, with no path in it.
		return nil, ptrResult(failedResult(ErrorClassInfra,
			"node_attempt secret materialization refused (contract § 4 step 4): the reason is in secret.materialization_failed"))
	}
	if len(m.Env) == 0 && len(m.Files) == 0 && m.Done == nil {
		// No node_attempt mount applies — the ordinary case, and nothing to
		// clean up or redact.
		return nil, nil
	}
	// An env_file write outside this run's tree is a materializer bug, and the
	// attempt that noticed it must not launch on it: refuse rather than hand a
	// secret to a process whose grants do not cover the file it was written into.
	for _, file := range m.Files {
		if !inside(layout.Work, file) {
			return nil, ptrResult(failedResult(ErrorClassInfra,
				"a node_attempt secret was materialized outside the run workspace (contract § 4 step 4): refusing to launch"))
		}
	}
	return &m, nil
}

// cleanupSecrets runs at the attempt boundary: the value leaves the checkout and
// the ledger closes, in that order (M3's rule — assert the file is gone, *then*
// journal secret.removed, so "cleanup happened" and "the journal says so" are
// one claim). The teardown outlives a cancelled attempt: a value must not
// survive because its process was interrupted.
//
// A file that cannot be removed is logged, never journalled: the path names
// where a secret lives and the journal is browser-visible. The uncleaned row is
// then left standing, which is exactly the finding the worker's startup sweep
// exists to close (ADR-0018 D1).
func (a *AgentTurn) cleanupSecrets(c AttemptClaim, m *Materialized, layout wsgit.Layout) {
	if m == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 10*time.Second)
	defer cancel()
	for _, file := range m.Files {
		if !inside(layout.Work, file) {
			a.logger().Error("refusing to remove a materialized secret outside the run workspace",
				slog.String("attempt_id", c.AttemptID), slog.String("path", file))
			continue
		}
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			a.logger().Error("materialized node_attempt secret survived attempt cleanup",
				slog.String("attempt_id", c.AttemptID), slog.String("path", file),
				slog.String("error", err.Error()))
		}
	}
	if m.Done != nil {
		if err := m.Done(ctx); err != nil {
			a.logger().Warn("secret.removed could not be journalled for the attempt",
				slog.String("attempt_id", c.AttemptID), slog.String("error", err.Error()))
		}
	}
}

// redactingAttemptSink applies the materializer's black box to every payload an
// attempt journals — an agent that `cat`s its own secret into its reply must not
// put the value in the transcript (12-test-strategy case 12). The redaction runs
// on the serialized payload, so a value that cannot be represented inside the
// JSON shape it arrived in is left alone rather than corrupting the event.
type redactingAttemptSink struct {
	inner  AttemptSink
	redact func(text string) (string, int)
}

func (r redactingAttemptSink) AppendEvent(ctx context.Context, ev AttemptEvent) error {
	if r.inner == nil {
		return nil
	}
	ev.Payload = redactPayload(r.redact, ev.Payload)
	return r.inner.AppendEvent(ctx, ev)
}

func (r redactingAttemptSink) Stopping() <-chan struct{} {
	if r.inner == nil {
		return nil
	}
	return r.inner.Stopping()
}

// redactResult applies the same black box to what the attempt returns: the
// boundary row's outputs and detail are as browser-visible as its events.
func redactResult(redact func(string) (string, int), res AttemptResult) AttemptResult {
	if redact == nil {
		return res
	}
	if res.Detail != "" {
		res.Detail, _ = redact(res.Detail)
	}
	if res.Outputs != nil {
		res.Outputs = redactPayload(redact, res.Outputs)
	}
	return res
}

// redactPayload redacts a structured payload through its JSON form. A payload
// that will not round-trip is returned untouched: a secret that survives an
// un-redactable shape is a lesser failure than journaling a corrupted event, and
// the value is never in the shape's keys anyway.
func redactPayload(redact func(string) (string, int), payload any) any {
	if redact == nil || payload == nil {
		return payload
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return payload
	}
	text, n := redact(string(raw))
	if n == 0 || text == string(raw) {
		return payload
	}
	var back any
	if err := json.Unmarshal([]byte(text), &back); err != nil {
		return payload
	}
	return back
}

// conversationForReady stamps the attempt's conversation/turn pair, waiting
// out the one-active-turn refusal. ADR-0016 § 5 is the rule this wait exists
// for: "Nobody may send a second prompt before that terminal event, and the
// DB will not allow one (one-active-turn index)" — and in the takeover
// journey (m4-contract § 5.3) the turn holding the slot is the returning
// controller's own human prompt, queued before return-control. The retry
// claim therefore WAITS for the slot instead of failing the node: that turn
// reaches its terminal on its own (its worker closes it, or the reconciler's
// lease arm interrupts it), and every poll re-derives the whole stamp under
// the attempt fence. The attempt lease keeps renewing under the wait — the
// renewal statement touches zero turn rows until the stamp lands — and a stop
// signal, a lost lease or a dead worker exits the wait the way the rest of
// the attempt body exits: ctx done here, nothing fenced written, the
// reconciler re-derives.
func (a *AgentTurn) conversationForReady(ctx context.Context, c AttemptClaim) (AttemptConversation, bool, error) {
	conv, ok, err := a.Sessions.ConversationFor(ctx, c)
	if err == nil || !errors.Is(err, ErrAttemptConversationBusy) {
		return conv, ok, err
	}
	a.logger().Info("attempt conversation still carries a non-terminal turn; the retry claim waits for its terminal",
		slog.String("attempt_id", c.AttemptID),
		slog.String("detail", a.redact(err.Error())))
	for errors.Is(err, ErrAttemptConversationBusy) {
		tick := time.After(a.busyPoll())
		if a.Clock != nil {
			tick = a.Clock.After(a.busyPoll())
		}
		select {
		case <-ctx.Done():
			return AttemptConversation{}, false,
				fmt.Errorf("%w: the attempt stopped before the slot opened (%v)", ErrAttemptConversationBusy, ctx.Err())
		case <-tick:
		}
		conv, ok, err = a.Sessions.ConversationFor(ctx, c)
		if err != nil && !errors.Is(err, ErrAttemptConversationBusy) {
			return AttemptConversation{}, false, err
		}
	}
	return conv, ok, err
}

func (a *AgentTurn) conversationFor(ctx context.Context, c AttemptClaim) (AttemptConversation, *AttemptResult) {
	conv, ok, err := a.conversationForReady(ctx, c)
	if err != nil {
		return AttemptConversation{}, ptrResult(failedResult(ErrorClassInfra, "read attempt conversation: "+a.redact(err.Error())))
	}
	if !ok || conv.ConversationID == "" {
		return AttemptConversation{}, ptrResult(failedResult(ErrorClassInfra,
			"attempt conversation/turn is not stamped (contract § 4 step 6): the conversation and its turn are created in the claim's transaction, and an executor that invented them outside it would leak turns the fence never approved"))
	}
	return conv, nil
}

// verifyThenPlan is ADR-0019's chain in the attempt shape: under `required`
// the launch either gets a verified plan in its context or nothing runs
// (sandbox_enforcement_failed, journalled — there is no fallback branch);
// non-required modes run the adapter directly and LABEL themselves. The
// agent-turn profile carries network_enforced=false and stays labelled that
// way (M3's label, § 4 step 5).
func (a *AgentTurn) verifyThenPlan(ctx context.Context, sink AttemptSink, c AttemptClaim, plan wsgit.LaunchPlan, launcher acp.Launcher, adapterEnv []string, delivered []string, oauthKV string, required bool, workspaceID string) (acp.LaunchPlan, *nono.VerificationResult, *AttemptResult) {
	if !required {
		// Unsandboxed: the token and the env-delivered mounts join the child's
		// real exec environment — an environment, not argv (ADR-0040).
		env := adapterEnv
		if oauthKV != "" {
			env = append(append([]string{}, adapterEnv...), oauthKV)
		}
		if gitEnv := GitPushEnv(delivered); len(gitEnv) > 0 {
			env = append(env, gitEnv...)
			// ADR-0045 follow-up (2026-10-22, product owner decision): the GitHub CLI
			// the agent execs as its child needs a writable config dir under the
			// agent's HOME plus the non-interactive flags — same exec-environment
			// channel, and only for attempts that delivered a token.
			env = append(env, GitPushToolEnv(plan.AgentHome)...)
		}
		return acp.LaunchPlan{
			Path: launcher.Executable, Args: launcher.Args, Env: env, Dir: plan.Cwd,
			Unsandboxed: string(a.enforcement()),
		}, nil, nil
	}
	if a.Sandbox == nil {
		r := failedResult(ErrorClassSandboxEnforcementFail,
			"enforcement is required but no sandbox backend is configured: refusing to launch an agent unsandboxed (ADR-0019 D6, no fallback exists)")
		return acp.LaunchPlan{}, nil, &r
	}
	prof, err := a.profile()
	if err != nil {
		r := failedResult(ErrorClassSandboxEnforcementFail, "materialize the agent-turn profile: "+a.redact(err.Error()))
		return acp.LaunchPlan{}, nil, &r
	}
	spec := nono.LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: a.LauncherHome,
		AdapterPath: launcher.Executable, AdapterArgs: launcher.Args, AdapterEnv: argvBoundEnv(adapterEnv, delivered),
		// BlockNet stays false: egress denial is the COMMAND profile's claim;
		// the agent-turn profile reports network_enforced=false honestly.
	}
	res, verr := a.Sandbox.Verify(ctx, spec)
	if verr != nil {
		if ctx.Err() != nil {
			// The stop signal arrived during the chain; reporting that as a
			// sandbox refusal would be a lie nobody made (procexec's rule).
			r := failedResult(ErrorClassInfra, "launch interrupted during sandbox verification")
			return acp.LaunchPlan{}, nil, &r
		}
		a.journal(ctx, sink, c, events.TypeSandboxEnforcementFailed, a.enforcementFailedPayload(c, workspaceID, res, verr))
		msg := "sandbox refused the agent launch"
		var f *nono.Failure
		if errors.As(verr, &f) && f.ChildStarted {
			msg = "sandbox killed the launched agent"
		}
		r := failedResult(ErrorClassSandboxEnforcementFail, msg+": "+a.redact(verr.Error()))
		return acp.LaunchPlan{}, res, &r
	}
	argv, berr := spec.BuildLaunchArgv()
	if berr != nil {
		a.journal(ctx, sink, c, events.TypeSandboxEnforcementFailed, a.enforcementFailedPayload(c, workspaceID, res, berr))
		r := failedResult(ErrorClassSandboxEnforcementFail, "agent launch argv: "+a.redact(berr.Error()))
		return acp.LaunchPlan{}, res, &r
	}
	a.journal(ctx, sink, c, events.TypeSandboxVerified, a.verifiedPayload(c, workspaceID, plan, res))
	// ADR-0040: the token rides nono's own process environment (nono
	// inherits it into the child). It never enters argv: BuildLaunchArgv
	// puts only the adapterEnv hop there, and the audit journal records
	// that argv verbatim.
	env := a.nonoLauncherEnv()
	if oauthKV != "" {
		env = append(env, oauthKV)
	}
	// ADR-0045 / ADR-0040: a GitHub token delivered by a secret mount joins this
	// process environment — the same place the launcher's long-lived token rides —
	// and never the argv `env` hop, whose verbatim recording is the audit journal
	// (ADR-0040). The exec'd process is the `env` binary from the argv, so the
	// entries here reach the agent and its git children without touching argv; the
	// merge dedupes so each name appears once with the authorized value (ADR-0018
	// D4: an authorized mount outranks launcher env, which is why it goes last).
	gitEnv := GitPushEnv(delivered)
	env = execEnv(env, gitEnv, delivered)
	// ADR-0045 follow-up (2026-10-22, product owner decision): the GitHub CLI the
	// agent execs as its child (`gh pr create --draft …`) needs a writable config
	// dir under the agent's HOME plus the non-interactive flags. Same exec-
	// environment channel, and only for attempts that delivered a token.
	if len(gitEnv) > 0 {
		env = execEnv(env, GitPushToolEnv(plan.AgentHome))
	}
	return acp.LaunchPlan{
		Path: a.nonoBinary(), Args: argv, Env: env, Dir: plan.Cwd,
		Verified: verification(res, plan),
	}, res, nil
}

func (a *AgentTurn) verifiedPayload(c AttemptClaim, workspaceID string, plan wsgit.LaunchPlan, res *nono.VerificationResult) events.SandboxVerifiedPayload {
	grants := make([]events.SandboxGrant, 0, len(plan.Grants))
	for _, g := range plan.Grants {
		grants = append(grants, events.SandboxGrant{Role: g.Role, Access: g.Access()})
	}
	network, enforced := res.EgressReport()
	return events.SandboxVerifiedPayload{
		ProjectID: c.ProjectID, WorkspaceID: workspaceID, WorkerID: c.WorkerID,
		PolicyDigest: res.PolicyDigest, Backend: res.Backend, BackendVersion: res.Version,
		AfUnixMediation: res.AfUnixMediation, NetworkEnforced: enforced, Network: network,
		Grants: grants, CommitGranted: plan.CommitGranted, Verified: res.Verified,
	}
}

func (a *AgentTurn) enforcementFailedPayload(c AttemptClaim, workspaceID string, res *nono.VerificationResult, cause error) events.SandboxEnforcementFailedPayload {
	stage, reason := "launch", "enforcement_failed"
	var f *nono.Failure
	if errors.As(cause, &f) {
		stage, reason = f.Stage, f.Reason
	}
	payload := events.SandboxEnforcementFailedPayload{
		ProjectID: c.ProjectID, WorkspaceID: workspaceID, WorkerID: c.WorkerID,
		Stage: stage, Reason: reason, Detail: a.redact(cause.Error()),
	}
	if res != nil {
		payload.Backend, payload.BackendVersion = res.Backend, res.Version
		payload.PolicyDigest, payload.ChildStarted = res.PolicyDigest, res.ChildStarted
		payload.Verified = res.Verified
	}
	return payload
}

// permissionBridge is the Decider installed on the session: the node policy
// answers every prompt synchronously, and BOTH the request and the answer are
// journalled as the reused M2 conversation.permission.* pair (§ 3's reuse
// list) — an honest deny is visible, not a silent no.
func (a *AgentTurn) permissionBridge(c AttemptClaim, conv AttemptConversation, policy PermissionPolicy, sink AttemptSink) domain.PermissionDecider {
	var seq atomic.Int64
	return func(ctx context.Context, p domain.PermissionPrompt) (domain.PermissionChoice, error) {
		if ctx.Err() != nil {
			// The turn is over; the prompt is moot and the harness sees the
			// cancelled outcome (domain.PermissionDecider's rule).
			return domain.PermissionChoice{}, ctx.Err()
		}
		options := make([]events.PermissionOption, 0, len(p.Options))
		for _, o := range p.Options {
			options = append(options, events.PermissionOption{OptionID: o.OptionID, Label: o.Label, Kind: o.Kind})
		}
		requestID := fmt.Sprintf("attempt-%s-permission-%d", safeKey(c.AttemptID), seq.Add(1))
		a.journal(ctx, sink, c, events.TypeConversationPermissionRequested, events.PermissionRequestedPayload{
			ConversationID: conv.ConversationID, TurnID: conv.TurnID,
			PermissionRequestID: requestID, ToolCallID: p.ToolCallID,
			Title: bounded(p.Title, 200), Kind: p.Kind, Options: options,
		})
		verdict := PermissionVerdict{}
		if policy != nil {
			verdict = policy(p)
		}
		chosen := ""
		if verdict.OptionKind != "" {
			for _, o := range p.Options {
				if o.Kind == verdict.OptionKind {
					chosen = o.OptionID
					break
				}
			}
		}
		status := events.PermissionStatusDecided
		if chosen == "" {
			// Denied: no option was chosen and none is fabricated — the ACP
			// cancelled outcome, evented as a close-without-decision because
			// `decided` with no option would claim consent nobody gave.
			status = events.PermissionStatusCancelled
		}
		a.journal(ctx, sink, c, events.TypeConversationPermissionDecided, events.PermissionDecidedPayload{
			ConversationID: conv.ConversationID, TurnID: conv.TurnID,
			PermissionRequestID: requestID, Status: status,
			DecisionOptionID: chosen, DecidedBy: verdict.DecidedBy,
		})
		return domain.PermissionChoice{OptionID: chosen}, nil
	}
}

// turnStop carries the stop-arm facts mapTurnOutcome cannot infer: whether
// drain asked (stopAsked) and whether the harness never acked the cancel
// (ackTimedOut).
type turnStop struct {
	asked        bool
	ackTimedOut  bool
	cancelFailed bool // the session/cancel write itself failed — nothing reached the harness
}

// mapTurnOutcome is the attempt-loop analogue of mapOutcome: the honest word,
// not the convenient one. Order matters — the loop's stop arms outrank the
// harness's answer, and a harness that stopped itself without a request has a
// story the attempt never agreed to tell.
func (a *AgentTurn) mapTurnOutcome(ctx context.Context, stop domain.StopReason, promptErr error, ts turnStop) AttemptResult {
	switch {
	case ts.asked && ts.ackTimedOut:
		// Drain asked and the harness never answered: the loop's shutdown flag
		// closes with interrupted{worker_shutdown}, the § 4 step 12 word.
		return AttemptResult{}
	case ts.ackTimedOut:
		// § 4 step 11: the cancel went out, the ack never came — the honest
		// terminal is interrupted, not a cancelled claiming an ack.
		return AttemptResult{Status: AttemptStatusInterrupted, InterruptReason: interruptReasonKillTimeout}
	case ts.asked:
		// Drain: whatever the harness says, we are leaving; the loop's flag
		// names the reason (M2's mapOutcome precedence, mirrored).
		return AttemptResult{}
	case ctx.Err() == context.DeadlineExceeded:
		return failedResult(ErrorClassTimeout, "node deadline exceeded mid-turn; the ACP session was cancelled")
	case ts.cancelFailed && ctx.Err() == context.Canceled:
		// The loop asked, but session/cancel never reached the harness — no
		// notification, no ack. Claiming acp_cancel_ack would be a lie about
		// a write that failed, so the honest terminal is the interrupt the
		// teardown's process-group kill owns (§ 4 step 11).
		return AttemptResult{Status: AttemptStatusInterrupted, InterruptReason: interruptReasonKillTimeout}
	case ctx.Err() == context.Canceled:
		// Remote cancel-requested or lease loss arrived here; the loop's flags
		// choose the terminal. What this executor knows is that session/cancel
		// was answered with a cancelled turn — that IS the ack (§ 4 step 11).
		return AttemptResult{CancelReason: CancelReasonACPAck}
	case promptErr != nil:
		// The session died or errored mid-turn with no stop request: honest
		// infra, exactly M2's mapOutcome failed arm. A death the adapter
		// proved was a disconnect is named for what it is — the reason rides
		// the detail, because "the agent said nothing" and "the agent was
		// killed" are different stories for the retry that follows.
		if info, ok := acp.DisconnectInfoOf(promptErr); ok {
			return failedResult(ErrorClassInfra, disconnectDetail(info))
		}
		return failedResult(ErrorClassInfra, "agent session failed mid-turn: "+bounded(promptErr.Error(), 400))
	case stop == domain.StopRefusal:
		return failedResult(ErrorClassAgentError, "agent refused the prompt turn (ACP stopReason refusal)")
	case stop == domain.StopMaxTokens:
		return failedResult(ErrorClassAgentError, "agent turn ended at the model token limit: a truncated answer is not an outputs envelope")
	case stop == domain.StopCancelled:
		return failedResult(ErrorClassAgentError, "agent reported a cancelled turn with no stop request from the attempt loop")
	case stop == domain.StopOther:
		return failedResult(ErrorClassAgentError, "agent stopped with reason \"other\"; no honest outputs envelope can be built from it")
	default:
		// end_turn: the attempt stopped for no reason the loop owns. Whether
		// it SPEAKS is decided by structured-output extraction, which only
		// Execute can judge (it holds the coalesced final text) — the empty
		// result here is the caller's branch marker, not a terminal.
		return AttemptResult{}
	}
}

// disconnectDetail is the honest sentence for a session that went away
// before its turn ended. ADR-0023 § 7 keeps the classes apart: invalid_output
// is a reply that fails its JSON Schema, and here there is no reply — the
// harness died. The class is infra, the word this executor already uses for a
// dead agent (a dead agent is not an agent verdict), and § 7 leaves infra
// retriable by default, so a crashing harness costs an attempt, not the node.
func disconnectDetail(info acp.DisconnectInfo) string {
	reason := strings.TrimSpace(info.Reason)
	if reason == "" {
		reason = "unobserved"
	}
	detail := "agent session disconnected before the turn ended (" + reason
	if ev := strings.TrimSpace(info.Detail); ev != "" {
		detail += ": " + bounded(ev, 240)
	}
	detail += ") — the ACP turn never completed, so there is no reply for the output schema to judge; invalid_output is reserved for a reply that violates its schema (ADR-0023 § 7)"
	return bounded(detail, 512)
}

// ptrResult lifts a value refusal into the pointer the parse helpers return.
func ptrResult(r AttemptResult) *AttemptResult { return &r }

// attachOutputs is the end_turn arm of the outcome table: JSON in, envelope
// out, or the honest invalid_output evidence the extraction failed. The
// engine validates the document against the node's schema at Complete
// (§ 4 step 6, ADR-0022 § 4 rule 2); this executor emits parsed JSON or
// evidence, never a schema verdict it cannot compute.
func (a *AgentTurn) attachOutputs(c AttemptClaim, spec agentTurnSpec, prof AgentProfile, text string) (AttemptResult, *AttemptResult) {
	val, bad := extractStructuredOutput(text)
	if bad != nil {
		r := invalidOutput(*bad)
		return AttemptResult{}, &r
	}
	raw, err := json.Marshal(val)
	if err != nil {
		r := invalidOutput("outputs are not re-encodable JSON: " + err.Error())
		return AttemptResult{}, &r
	}
	if len(raw) > agentInlineOutput {
		r := AttemptResult{
			Status:     AttemptStatusFailed,
			ErrorClass: ErrorClassInvalidOutput,
			Detail:     bounded(fmt.Sprintf("agent outputs envelope is %d bytes over the 32 KiB inline cap (§ 6); it must travel as a kind=json artifact (§ 4 step 9)", len(raw)), 512),
			OutputErrors: []any{map[string]any{
				"code": "outputs_too_large", "message": "outputs exceeded the inline cap",
			}},
		}
		return AttemptResult{}, &r
	}
	return AttemptResult{
		Status:        AttemptStatusSucceeded,
		Outputs:       val,
		OutputsDigest: "sha256:" + sha256Hex(raw),
		ArtifactRefs:  []any{},
		Outcome:       "passed",
	}, nil
}

// extractStructuredOutput is § 4 step 6's structuredOutput extraction, held
// to what the worker may claim: the node's output schema travels with the
// pinned plan and the ENGINE validates at Complete, so this executor emits
// parsed JSON or invalid_output evidence — never a schema verdict it cannot
// compute. Accepts the whole reply, one fenced json block, or the outermost
// brace-balanced object inside prose (C7's realistic agents narrate).
func extractStructuredOutput(text string) (any, *string) {
	s := strings.TrimSpace(text)
	if s == "" {
		msg := "agent turn produced no text to extract structured outputs from (01 invariant 4: a succeeded attempt HAS outputs)"
		return nil, &msg
	}
	if len(s) > agentExtractMax {
		msg := fmt.Sprintf("agent reply is %d bytes, over the 1 MiB extraction bound (§ 6); it must travel as an artifact", len(s))
		return nil, &msg
	}
	candidates := []string{s}
	if m := fencedJSONRe.FindAllStringSubmatch(s, -1); len(m) > 0 {
		candidates = append(candidates, m[len(m)-1][1]) // the LAST block is the final answer
	}
	if i, j := strings.IndexByte(s, '{'), strings.LastIndexByte(s, '}'); i >= 0 && j > i {
		candidates = append(candidates, s[i:j+1])
	}
	for _, cand := range candidates {
		dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(cand)))
		dec.UseNumber() // integers stay integers into outputs and digests
		var val any
		if err := dec.Decode(&val); err != nil || dec.More() {
			continue
		}
		if _, isObject := val.(map[string]any); !isObject {
			msg := fmt.Sprintf("agent reply parsed as JSON but is not an object (%s); the node output schema is an object (01 invariant 4)", jsonKind(val))
			return nil, &msg
		}
		return val, nil
	}
	msg := "agent reply is not a JSON object; structuredOutput extraction failed (§ 4 step 6) and the engine's schema validation never got a document to judge"
	return nil, &msg
}

var fencedJSONRe = regexp.MustCompile("(?s)```(?:json)?\\s*(\\{.*?\\})\\s*```")

func jsonKind(v any) string {
	switch v.(type) {
	case []any:
		return "array"
	case string:
		return "string"
	case bool:
		return "boolean"
	case json.Number:
		return "number"
	}
	return "non-object"
}

// checkpointFor fills the boundary record. A missing/unbound workspace is
// reported by the caller as the honest infra refusal it is.
func (a *AgentTurn) checkpointFor(ctx context.Context, c AttemptClaim, spec agentTurnSpec, prof AgentProfile, outputsDigest string) AttemptCheckpoint {
	if a.Checkpoints == nil {
		return AttemptCheckpoint{}
	}
	ref, ok, err := a.Checkpoints.RunWorkspace(ctx, c.RunID)
	if err != nil || !ok || ref.WorkspaceID == "" || ref.VolumeID == "" {
		return AttemptCheckpoint{}
	}
	inputs, err := json.Marshal(map[string]any{
		"prompt": spec.prompt, "profile": spec.profileName, "launcher": prof.LauncherID,
		"sessionMode": spec.sessionMode, "fallback": spec.fallback,
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

// journal best-effort appends one attempt-scoped event and reports whether it
// landed; a rejected append has already flagged the loop (attemptSink's
// ErrLeaseLost path), and the caller uses the word to decide the binding
// teardown it may no longer speak.
func (a *AgentTurn) journal(ctx context.Context, sink AttemptSink, c AttemptClaim, typ string, payload any) bool {
	if err := sink.AppendEvent(ctx, AttemptEvent{Type: typ, Payload: payload}); err != nil {
		a.logger().Warn("agent.acp journal append failed",
			slog.String("attempt_id", c.AttemptID), slog.String("type", typ), slog.String("error", err.Error()))
		return false
	}
	return true
}

// agentText coalesces the final agent message for structured-output
// extraction. A tool_call (or update) RESETS the buffer: text before a tool
// call is narration, and the final answer is what streamed after the last
// one (sink.go's transcript ordering seen from the outputs side).
type agentText struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (t *agentText) add(ev domain.ConversationEvent) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch ev.Kind {
	case "message_chunk":
		t.buf.WriteString(ev.Text)
	case "tool_call", "tool_call_update":
		t.buf.Reset()
	default:
		// permission_request is bridged durably by the Decider; thought,
		// plan and unknown kinds are not message text (04).
	}
}

func (t *agentText) text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

// nonoLauncherEnv is nono's own environment, never the agent's and never
// os.Environ() (probe C-H1; unit.go's and procexec.go's same construction).
// credentialAuth is unit.go's credentialDirs/credentialEnv pair in the
// attempt shape: it resolves the launcher's declared credential directories
// and renders the NAME=value entries LaunchEnv's Auth field consumes.
// The distinction is the bug this closes: EnvRequest.Auth takes "NAME=value"
// pairs, and a bare directory path is dropped silently by its collision
// builder — the adapter then launches with no CLAUDE_CONFIG_DIR and aborts
// with "Authentication required". Existence is verified before the launch
// (probe C-FC3's silent-drop class), exactly as the conversation path does.
func (a *AgentTurn) credentialAuth(launcher acp.Launcher) (dirs []string, authEnv []string, err error) {
	if a.LauncherAuth == nil {
		return nil, nil, nil
	}
	dirs, err = a.LauncherAuth(launcher.ID)
	if err != nil {
		return nil, nil, err
	}
	byDir := map[string]string{}
	for _, kv := range acp.AuthEnvFromOS(launcher) {
		name, value, _ := strings.Cut(kv, "=")
		byDir[value] = name
	}
	for _, dir := range dirs {
		if st, serr := os.Stat(dir); serr != nil || !st.IsDir() {
			return dirs, nil, fmt.Errorf("agent.acp: launcher %q declares a credential directory at %s that is not usable: %v", launcher.ID, dir, serr)
		}
		name, ok := byDir[dir]
		if !ok {
			return dirs, nil, fmt.Errorf("agent.acp: launcher %q needs one of %v set to a credential directory, and %s is not named by any of them", launcher.ID, launcher.AuthEnvVars, dir)
		}
		authEnv = append(authEnv, name+"="+dir)
	}
	return dirs, authEnv, nil
}

func (a *AgentTurn) nonoLauncherEnv() []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	home := a.LauncherHome
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

// redact replaces host roots with a fixed word and bounds the line: grant
// paths never reach the journal or attempts.detail (D14's rule).
func (a *AgentTurn) redact(s string) string {
	for _, root := range []string{a.WorkspaceRoot, a.LauncherHome, a.PolicyDir} {
		if root != "" {
			s = strings.ReplaceAll(s, root, "<host-root>")
		}
	}
	return bounded(s, 512)
}
