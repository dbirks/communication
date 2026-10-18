package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/secrets"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

const workerUsage = `usage: communication worker

runs the execution worker: registers itself in Postgres, heartbeats, marks
itself draining then offline on SIGTERM/SIGINT, and (from M2) claims
conversation turns — leasing them with a fencing token, driving live ACP
agent sessions, streaming the transcript into the journal, and writing honest
terminal states before exit
(communication-spec/02-system-architecture.md, ADR-0001, ADR-0016).

environment:
  COMMUNICATION_DATABASE_URL     required, postgres connection string
  COMMUNICATION_WORKER_NAME      worker identity (default: hostname)
  COMMUNICATION_WORKER_HEARTBEAT heartbeat interval (default "10s")
  COMMUNICATION_WORKER_CAPACITY  concurrent attempts this worker claims and
                                 publishes into workers.capacity (default "1",
                                 max "16" — the workers.capacity CHECK, M4
                                 contract § 4 step 1 and § 6)
  COMMUNICATION_WORKSPACE_ROOT   per-run worktree root
                                 (default "/var/lib/communication/workspaces")
  COMMUNICATION_REPOS_ROOT       per-project mirror root, measured as its own
                                 storage volume (ADR-0017 D5; default
                                 "<workspace root's parent>/repos")
  COMMUNICATION_SANDBOX_ENFORCEMENT  required (default) | permissive-dev |
                                 disabled. "required" refuses to start without
                                 the nono binary rather than launching an
                                 unisolated agent (05, ADR-0019 D6); the other
                                 two are reachable only by explicit
                                 configuration and every event they produce says
                                 so.
  COMMUNICATION_SANDBOX_HOME     nono's own HOME (default
                                 "<workspace root's parent>/sandbox-home"):
                                 worker-owned, never a grant, never derived from
                                 a workspace (probe C-H1's refusal is sticky).
  COMMUNICATION_SANDBOX_POLICY_DIR   where the profile files are written
                                 (default "<workspace root's parent>/sandbox-policy")
  COMMUNICATION_AGENT_EGRESS_ALLOW   ADR-0035: comma-separated hostnames this
                                 worker's agent turns may reach (default
                                 "api.anthropic.com", provisional — the lab turn
                                 decides the set). They are published into the
                                 agent profile's network.allow_domain, so the
                                 policy digest commits to the host set. Set to
                                 "open" for ADR-0019 D3's unrestricted agent
                                 network. A run only reports network:
                                 "allowlisted" once its own audit journal shows a
                                 denial, and no pipeline document can widen this
                                 list — it is worker operator configuration, like
                                 the enforcement mode above.
  COMMUNICATION_AGENT_GIT_NAME / COMMUNICATION_AGENT_GIT_EMAIL
                                 commit identity seeded into each agent home
  COMMUNICATION_SECRET_KEYRING   envelope-encryption keyring directory
                                 (ADR-0018 D2.2; default "/keyring"). The
                                 worker is the only process that materializes
                                 values, so it needs the keyring; a project
                                 with no secrets runs fine without one, and a
                                 mount whose key is missing refuses its turn
                                 loudly (secret.materialization_failed).
  COMMUNICATION_ARTIFACT_BACKEND / COMMUNICATION_ARTIFACT_ROOT /
  COMMUNICATION_ARTIFACT_S3_* / COMMUNICATION_ARTIFACT_SPOOL
                                 the artifact byte backend the worker publishes
                                 to (this process is the single rw writer of
                                 the volume, ADR-0020 D2); same names as serve
  COMMUNICATION_MODEL_CHAT_BASE_URL  OpenAI-compatible server root for model.chat
                                 nodes (e.g. https://api.example.com/v1). THIS IS
                                 AN EGRESS PATH (ADR-0024 Security): node content
                                 leaves the host. Unset means model.chat is not
                                 registered at all and such nodes fail honestly;
                                 the ops page must name the endpoint host when set
  COMMUNICATION_MODEL_CHAT_API_KEY   bearer token for that endpoint. Never from
                                 the pipeline document, never logged
  COMMUNICATION_MODEL_CHAT_MODELS    comma-separated allowlist of model names this
                                 worker will call. An endpoint with no allowlist
                                 forwards arbitrary selectors, so with the base URL
                                 set and no models listed every node is refused
  COMMUNICATION_APM_BINARY       override for the packaged-context binary
                                 (default: apm on PATH, else /opt/apm/apm —
                                 the vendored 0.33.0, ADR-0008 D1). Absent
                                 means profiles that pin packaged context
                                 refuse their turns rather than running a
                                 different agent than configured

migrations are applied separately: communication migrate up
`

// defaultWorkspaceRoot is where per-conversation workspaces live; the
// compose worker mounts a volume there (communication-spec/05 layout).
const defaultWorkspaceRoot = "/var/lib/communication/workspaces"

// workerOptions is the resolved worker configuration.
type workerOptions struct {
	databaseURL   string
	workspaceRoot string
	// reposRoot is the second storage root M3 measures (ADR-0017 D5). It is not
	// derived from workspaceRoot: probe V5b found the lab's workspaces and repos
	// trees share a device and differ only by inode, so a path-prefix relationship
	// would have made one measurement look like two.
	reposRoot string
	// sandboxEnforcement is this worker's configured mode. `required` is the
	// default because 05 defines it as the only mode that may be described as
	// sandboxed; the others are reachable only by explicit configuration, and a
	// worker that could not resolve nono in `required` refuses to run turns rather
	// than falling back.
	sandboxEnforcement domain.EnforcementMode
	// sandboxLauncherHome is nono's own HOME: worker-owned, under neither storage
	// root, and never a grant. Probe C-H1's refusal is permanent for a directory
	// that has ever been nono's HOME while a grant covered it, so this is chosen
	// at startup and never derived from a workspace.
	sandboxLauncherHome string
	// policyDir holds the materialized nono profile files (ADR-0009 D4: -p takes
	// a path, and without one nono mixes in its built-in default profile — the
	// default that writes to /tmp).
	policyDir string
	// sandboxSelfTest is where the startup enforcement self-test creates and
	// removes its two directories. Sibling of the others for the same reason the
	// launcher home is: it is granted rw during the test, so it must not be a tree
	// any workspace grant also covers.
	sandboxSelfTest string
	// agentGit is the commit identity the worker seeds into each agent home and
	// exports to the child. It is configuration rather than inferred: an agent
	// that commits as "root@<container id>" produces history no team can attribute,
	// and probe P6 showed git aborts outright when its config is unreadable, so
	// the value has to be deliberate.
	agentGit acp.GitIdentityEnv
	// attemptCapacity is workers.capacity as this process publishes it (M4
	// contract § 4 step 1): the claim predicate's
	// wr.active_attempts < wr.capacity is only real when the row carries the
	// configured number, so Register/Heartbeat write it and the DB CHECK
	// (1..16, § 6) refuses anything else — the ceiling is validated here so
	// the refusal is a configuration message, not a constraint violation at
	// the first heartbeat.
	attemptCapacity int

	// modelChat is § 4 step 8's egress configuration. Endpoint, allowlist and
	// credential are operator-level by ADR-0024's Security section — the
	// pipeline document chooses a model *name*, never where the content goes,
	// because a pipeline that could name its own endpoint is a pipeline that
	// can exfiltrate a project's content to an attacker's host.
	modelChat modelChatOptions

	cfg worker.Config
}

// modelChatOptions is the parsed COMMUNICATION_MODEL_CHAT_* triple.
type modelChatOptions struct {
	baseURL string
	apiKey  string
	models  []string
}

// parseModelChatOptions reads and validates the model.chat environment. A bad
// base URL is a startup refusal rather than a per-attempt surprise: an
// operator who typed `api.openai.com/v1` without a scheme meant to configure
// egress, and silently leaving the kind unregistered would hide that.
func parseModelChatOptions(getenv func(string) string) (modelChatOptions, error) {
	var o modelChatOptions
	o.baseURL = strings.TrimRight(strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_BASE_URL")), "/")
	o.apiKey = strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_API_KEY"))
	if raw := strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_MODELS")); raw != "" {
		for _, m := range strings.Split(raw, ",") {
			if m = strings.TrimSpace(m); m != "" {
				o.models = append(o.models, m)
			}
		}
	}
	if o.baseURL == "" {
		return o, nil
	}
	u, err := url.Parse(o.baseURL)
	if err != nil {
		return o, fmt.Errorf("COMMUNICATION_MODEL_CHAT_BASE_URL %q is not a URL: %w", o.baseURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return o, fmt.Errorf("COMMUNICATION_MODEL_CHAT_BASE_URL %q must be an http(s) URL", o.baseURL)
	}
	if u.Host == "" {
		return o, fmt.Errorf("COMMUNICATION_MODEL_CHAT_BASE_URL %q names no host", o.baseURL)
	}
	if u.User != nil {
		return o, errors.New("COMMUNICATION_MODEL_CHAT_BASE_URL must not carry credentials in the URL; use COMMUNICATION_MODEL_CHAT_API_KEY")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return o, fmt.Errorf("COMMUNICATION_MODEL_CHAT_BASE_URL %q must be a server root (no query or fragment)", o.baseURL)
	}
	return o, nil
}

// workerOptionsFromEnv reads and validates the worker environment. getenv is
// injected so parsing is unit-testable without mutating the process env.
func workerOptionsFromEnv(getenv func(string) string) (workerOptions, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	var o workerOptions

	o.databaseURL = getenv("COMMUNICATION_DATABASE_URL")
	if o.databaseURL == "" {
		return o, errors.New("COMMUNICATION_DATABASE_URL is not set")
	}

	o.workspaceRoot = strings.TrimSpace(getenv("COMMUNICATION_WORKSPACE_ROOT"))
	if o.workspaceRoot == "" {
		o.workspaceRoot = defaultWorkspaceRoot
	}
	o.reposRoot = strings.TrimSpace(getenv("COMMUNICATION_REPOS_ROOT"))
	if o.reposRoot == "" {
		// The default is a sibling of the workspace root, not a subdirectory of
		// it: the two trees have different lifetimes (a mirror outlives every
		// conversation that used it) and AssertNothingBut refuses foreign entries
		// in a workspace root, which nesting would guarantee.
		o.reposRoot = filepath.Join(filepath.Dir(o.workspaceRoot), "repos")
	}

	o.sandboxEnforcement = domain.EnforcementMode(strings.TrimSpace(getenv("COMMUNICATION_SANDBOX_ENFORCEMENT")))
	if o.sandboxEnforcement == "" {
		o.sandboxEnforcement = domain.EnforceRequired
	}
	switch o.sandboxEnforcement {
	case domain.EnforceRequired, domain.EnforcePermissiveDev, domain.EnforceDisabled:
	default:
		return o, fmt.Errorf("COMMUNICATION_SANDBOX_ENFORCEMENT %q is not required, permissive-dev or disabled", o.sandboxEnforcement)
	}
	// No silent downgrade: a worker configured for `required` that cannot find
	// nono must fail to start, because the alternative is a fleet that runs
	// unsandboxed while its configuration says otherwise (05: "fails closed
	// rather than starting unisolated").
	if o.sandboxEnforcement == domain.EnforceRequired {
		if _, err := exec.LookPath("nono"); err != nil {
			return o, errors.New("COMMUNICATION_SANDBOX_ENFORCEMENT=required but the nono binary is not on PATH: refusing to start rather than launch an unisolated agent")
		}
	}

	o.sandboxLauncherHome = strings.TrimSpace(getenv("COMMUNICATION_SANDBOX_HOME"))
	if o.sandboxLauncherHome == "" {
		o.sandboxLauncherHome = filepath.Join(filepath.Dir(o.workspaceRoot), "sandbox-home")
	}
	o.policyDir = strings.TrimSpace(getenv("COMMUNICATION_SANDBOX_POLICY_DIR"))
	if o.policyDir == "" {
		o.policyDir = filepath.Join(filepath.Dir(o.workspaceRoot), "sandbox-policy")
	}
	o.sandboxSelfTest = strings.TrimSpace(getenv("COMMUNICATION_SANDBOX_SELFTEST_DIR"))
	if o.sandboxSelfTest == "" {
		o.sandboxSelfTest = filepath.Join(filepath.Dir(o.workspaceRoot), "sandbox-selftest")
	}
	if pathIsUnderRoot(o.workspaceRoot, o.sandboxSelfTest) || pathIsUnderRoot(o.reposRoot, o.sandboxSelfTest) {
		return o, errors.New("COMMUNICATION_SANDBOX_SELFTEST_DIR must not be inside either storage root: the self-test grants it rw, and a workspace root holds foreign entries only during a test run (ADR-0017 D4's AssertNothingBut)")
	}
	if pathIsUnderRoot(o.sandboxLauncherHome, o.sandboxSelfTest) {
		return o, errors.New("COMMUNICATION_SANDBOX_SELFTEST_DIR must not be inside nono's HOME: a grant overlapping nono's protected state root is refused permanently (probe C-H1)")
	}

	// The commit identity. It is validated per-unit rather than here, because the
	// axis that needs it is a profile's commit_granted flag: a worker with no
	// commit-granting profile runs correctly with no identity at all, and refusing
	// to start would make an unstartable worker out of a valid configuration.
	// What is *not* an option is silence: GIT_CONFIG_NOSYSTEM is set and the
	// agent's HOME is its own tree, so an agent that runs `git commit` without a
	// configured identity fails mid-turn with git's own "Please tell me who you
	// are" — a message that reads like an agent bug rather than a missing setting.
	o.agentGit.Name = strings.TrimSpace(getenv("COMMUNICATION_AGENT_GIT_NAME"))
	o.agentGit.Email = strings.TrimSpace(getenv("COMMUNICATION_AGENT_GIT_EMAIL"))

	hostname, hostErr := os.Hostname()

	name := strings.TrimSpace(getenv("COMMUNICATION_WORKER_NAME"))
	if name == "" {
		if hostErr != nil || hostname == "" {
			return o, errors.New("COMMUNICATION_WORKER_NAME is not set and the hostname is unavailable")
		}
		name = hostname
	}

	interval := worker.DefaultHeartbeat
	if raw := strings.TrimSpace(getenv("COMMUNICATION_WORKER_HEARTBEAT")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return o, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT %q is not a duration: %w", raw, err)
		}
		if d <= 0 {
			return o, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT must be positive, got %s", d)
		}
		interval = d
	}

	o.attemptCapacity = worker.DefaultAttemptCapacity
	if raw := strings.TrimSpace(getenv("COMMUNICATION_WORKER_CAPACITY")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return o, fmt.Errorf("COMMUNICATION_WORKER_CAPACITY %q is not a number: %w", raw, err)
		}
		if n < 1 || n > worker.MaxAttemptCapacity {
			return o, fmt.Errorf("COMMUNICATION_WORKER_CAPACITY %d is outside 1..%d (workers.capacity CHECK, M4 contract § 6)", n, worker.MaxAttemptCapacity)
		}
		o.attemptCapacity = n
	}

	mcOpts, mcErr := parseModelChatOptions(getenv)
	if mcErr != nil {
		return o, mcErr
	}
	o.modelChat = mcOpts

	o.cfg = worker.Config{
		Name:         name,
		Hostname:     hostname,
		Version:      version,
		Heartbeat:    interval,
		DrainTimeout: worker.DefaultDrainTimeout,
	}
	return o, nil
}

// workerSchemaCheck compares the applied schema against what this binary
// requires and returns the observed version. current is injectable
// (postgres.SchemaVersion in production) so the refusal is unit-testable: a
// worker must not run against a schema it does not understand, because the
// API and (from M2) the scheduler read the same rows.
//
// A schema *ahead* of this binary is worth only a warning — migrations are
// forward-only, so added columns do not break an older worker — while a schema
// behind it is fatal.
func workerSchemaCheck(ctx context.Context, databaseURL string,
	current func(context.Context, string) (int64, error)) (int64, error) {
	want := postgres.ExpectedSchemaVersion()
	got, err := current(ctx, databaseURL)
	if err != nil {
		return 0, err
	}
	if got < want {
		return got, fmt.Errorf("database schema version %d is behind this binary's %d: run `communication migrate up`", got, want)
	}
	return got, nil
}

// runWorker implements the "worker" mode. Exit codes: 0 clean shutdown,
// 2 configuration error, 1 runtime error.
func runWorker(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" || a == "help" {
			fmt.Fprint(stdout, workerUsage)
			return 0
		}
	}

	opts, err := workerOptionsFromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}

	// Structured JSON logs on stderr. The worker package labels every record it
	// writes with the worker name, so the handler adds no identity attribute of
	// its own — serve does the same with "replica".
	log := slog.New(slog.NewJSONHandler(stderr, nil))

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := openPool(ctx, opts.databaseURL, log)
	if err != nil {
		stop()
		log.Error("database unavailable", slog.String("error", err.Error()))
		return 1
	}
	defer pool.Close()

	schema, err := workerSchemaCheck(ctx, opts.databaseURL, postgres.SchemaVersion)
	if err != nil {
		stop()
		log.Error("refusing to start", slog.String("error", err.Error()))
		return 1
	}
	if want := postgres.ExpectedSchemaVersion(); schema > want {
		log.Warn("database schema is newer than this binary",
			slog.Int64("schema_version", schema), slog.Int64("expected_schema_version", want))
	} else {
		log.Info("schema current", slog.Int64("schema_version", schema))
	}

	// The registry publishes this worker's attempt capacity (§ 4 step 1) from
	// the first Register onward, so the claim predicate
	// wr.active_attempts < wr.capacity measures a real number.
	w, err := worker.New(opts.cfg, &postgres.WorkerRegistry{Pool: pool, Capacity: opts.attemptCapacity}, worker.WithLogger(log))
	if err != nil {
		stop()
		log.Error("invalid worker configuration", slog.String("error", err.Error()))
		return 2
	}

	// M2 turn execution (ADR-0016): claims fenced leases, drives one live
	// ACP session per conversation, streams the coalesced transcript, and
	// bridges permission prompts to the durable controller decision. The
	// loop starts only after registration produced a worker id, and Drain
	// runs inside the M1 shutdown path (stop claiming → cancel in-flight
	// turns → honest terminal states) before the offline write.
	wakes := postgres.NewEventWake(opts.databaseURL, log)
	defer wakes.Close()
	if opts.agentGit.Name == "" || opts.agentGit.Email == "" {
		log.Warn("no agent commit identity configured: a turn whose profile grants commits will fail at the agent's own `git commit`",
			slog.String("hint", "set COMMUNICATION_AGENT_GIT_NAME and COMMUNICATION_AGENT_GIT_EMAIL"))
	}
	units, unitsSecrets, sandboxFacts, unitErr := newUnitService(opts, pool, log)
	if unitErr != nil {
		stop()
		log.Error("invalid execution-unit configuration", slog.String("error", unitErr.Error()))
		return 2
	}
	loop, err := worker.NewTurnLoop(
		worker.TurnConfig{AskModeID: acpAskModeID},
		&postgres.TurnStore{Pool: pool},
		&acp.Factory{
			Runtime: &acp.Runtime{Logger: log},
			// RequirePlan is the enforcement axis: with it set, a session whose
			// context carries no verified launch plan is refused by the factory
			// rather than quietly exec'd unsandboxed. There is no path from a
			// sandbox refusal to an exec in `required` mode (ADR-0019 D6), and an
			// interface-level guarantee beats a convention about call order.
			RequirePlan: opts.sandboxEnforcement == domain.EnforceRequired,
		},
		&worker.Workspace{Root: opts.workspaceRoot},
		w.ID,
		worker.WithTurnLogger(log),
		worker.WithJournalWake(wakes.Watch),
		worker.WithUnits(units),
	)
	if err != nil {
		stop()
		log.Error("invalid turn loop configuration", slog.String("error", err.Error()))
		return 2
	}
	// M4 attempt execution (§ 4): the loop claims fenced attempt leases up to
	// the published capacity and dispatches each kind to its executor.
	// process.exec and agent.acp are wired; every other claimed kind lands on
	// the loop's honest refusal until its wave is (contract § 0: kinds land
	// incrementally and an unwired kind is reported, never faked). The
	// agent-turn executor is gated exactly as procexec is: this same loop,
	// behind the registration-time sweep gate, under the worker's own
	// enforcement mode, sharing the drain path (§ 4 step 12).
	attemptStore := &postgres.AttemptStore{Runs: &postgres.RunStore{Pool: pool}}
	// § 4 step 3's database half: the run's workspace row, the volume it lives
	// on and the repository states at the boundary. Both wired executors
	// resolve their checkpoint identity through it, and the decorators below
	// make sure that row exists before either kind launches — a checkpoint
	// naming a tree nobody prepared would be a lie with a uuid in it (D-024).
	runWorkspaces := &postgres.RunWorkspaces{Pool: pool}
	procExec := &worker.ProcExec{
		WorkspaceRoot: opts.workspaceRoot,
		LauncherHome:  opts.sandboxLauncherHome,
		PolicyDir:     opts.policyDir,
		SandboxPath:   nonoPath(),
		Sandbox:       units.Sandbox,
		Enforcement:   opts.sandboxEnforcement,
		GitIdentity:   opts.agentGit,
		Logger:        log,
		Checkpoints:   runWorkspaces,
	}
	// Contract § 4 step 4 names no node kind: a node_attempt mount belongs to the
	// attempt that owns its lifecycle, whichever kind ran. process.exec therefore
	// drives the same adapter as agent.acp — one materializer, one keyring, one
	// ledger (ADR-0018 D4) — and not a second copy of the machinery. Which mounts
	// that attempt may hold is still its own decision: a process.exec claim names
	// no agent profile, so it is authorized for no profile-allowlisted mount and
	// delivers none (worker.ProcExec.materializeSecrets) — the wiring is shared,
	// the authorization is not widened by it.
	procExec.Secrets = unitsSecrets
	agentTurn := newAgentTurn(opts, pool, units, log)
	agentTurn.Checkpoints = runWorkspaces
	// Contract § 4 step 4: the attempt's node_attempt mounts materialize through
	// the same adapter the M3 turn unit drives — one materializer, one keyring,
	// one ledger, and the attempt id the reserved arm was waiting for.
	agentTurn.Secrets = unitsSecrets
	// One preparer shared by both kinds: the run workspace is per run, so two
	// attempts of one run must go through the same door, not two copies of it.
	prepareRunWorkspace := newRunWorkspacePreparer(opts, pool, w.ID, log)
	// artifact.publish needs the same byte backend M3's captures write to; the
	// row writer behind it is fenced on the attempt triple (ADR-0016 § 9.2).
	attemptArtifactBytes, err := artifactBytesFromEnv(false, log)
	if err != nil {
		stop()
		log.Error("invalid artifact byte backend", slog.String("error", err.Error()))
		return 2
	}
	// The M4 exit pipeline's final nodes (§ 4 step 9). Wrapped like the
	// others: a workspace_path publish reads the run tree, so that tree
	// has to exist first even when this worker only publishes.
	//
	// The scan is no longer M3's unit-scoped one. Materialized.Redact
	// knows only what THIS unit materialized, and a publishing attempt
	// materializes nothing — so an attempt whose upstream echoed a
	// node_attempt `env` value into its outputs would have published it
	// verbatim with redaction_count 0 (17ffa32's honest nil). Now the
	// scanner reads secret_materializations for every attempt of the run
	// and re-resolves those versions through the same keyring path the
	// materializer used: what the run ever held is what the artifact is
	// scanned for, and a value that cannot be resolved fails the attempt
	// (sandbox_enforcement_failed) instead of publishing unscanned.
	artifactPublish := worker.AttemptExecutor(&postgres.ArtifactPublishSecretScan{
		Publish: &worker.ArtifactPublish{
			Bytes:      attemptArtifactBytes,
			Rows:       &postgres.AttemptArtifacts{Pool: pool},
			Workspaces: worker.RunWorkspacePaths{WorkspaceRoot: opts.workspaceRoot},
			Logger:     log,
		},
		Values: &postgres.RunSecretValues{Pool: pool, Secrets: unitsSecrets.Secrets},
	})
	// § 4 step 8's model.chat is registered ONLY when an endpoint is configured.
	// With no base URL the kind stays unregistered, so refusalExecutor's honest
	// "no executor for node kind model.chat on this worker" remains the answer —
	// a worker that never promised egress must not quietly start sending content
	// somewhere. When it IS configured the endpoint host is logged once at
	// startup (never the key): this is a new egress path and the operator has to
	// be able to see where it points (ADR-0024 Security).
	var modelChat worker.AttemptExecutor
	if mc := opts.newModelChat(log, pool, unitsSecrets, attemptArtifactBytes); mc != nil {
		modelChat = mc
	}
	// Every wired kind is wrapped twice: the first attempt of a run prepares
	// its workspace on this worker's volume and closes ADR-0023 § 4's one-way
	// affinity door (contract § 4 step 3), and inside that tree a retried
	// attempt whose compiled policy is restore_checkpoint is reset to its
	// boundary before the kind launches (ADR-0023 § 6). continue_workspace —
	// M4's default — passes the second decorator through untouched: no read of
	// git, no reset, no event.
	chain, err := newAttemptChain(opts, pool, prepareRunWorkspace, log)
	if err != nil {
		stop()
		log.Error("invalid checkpoint restore wiring", slog.String("error", err.Error()))
		return 2
	}
	// The startup TCP probe may have found the agent-turn sandbox cannot
	// complete any TCP connect on this host (EPERM under
	// af_unix_mediation=pathname); agent.acp is then left unregistered — the
	// honest refusal model.chat gets with no endpoint — while process.exec,
	// model.chat and artifact.publish keep running (contract § 0: an
	// unclaimed kind is refused, never faked).
	agentExec := worker.AttemptExecutor(agentTurn)
	if !sandboxFacts.AgentTurnsAvailable {
		agentExec = nil
	}
	attemptExecs := newAttemptExecutors(chain, procExec, agentExec, artifactPublish, modelChat)
	attemptLoop, err := worker.NewAttemptLoop(
		worker.AttemptConfig{Capacity: opts.attemptCapacity},
		attemptStore,
		attemptExecs,
		w.ID,
		worker.WithAttemptLogger(log),
	)
	if err != nil {
		stop()
		log.Error("invalid attempt loop configuration", slog.String("error", err.Error()))
		return 2
	}
	registry := &postgres.WorkerRegistry{Pool: pool, Capacity: opts.attemptCapacity}
	w.Registered = func(ctx context.Context, workerID string) {
		// Registration-time writes, in this order and before any claim:
		//
		//  1. the startup sweep over secret_materializations rows this worker
		//     left uncleaned when it last died (ADR-0018 D1: cleanup has to
		//     work when nothing crashes, and a claim before the sweep would
		//     launch a turn next to a value a dead worker left behind);
		//  2. the sandbox columns migration 0004 added — what this worker
		//     actually probed/self-tested, so the ops page can say
		//     "verified" or say so in words that do not (ADR-0019 D5).
		if unitsSecrets != nil {
			swept, err := unitsSecrets.SweepUncleaned(ctx, workerID)
			if err != nil {
				log.Error("secret startup sweep incomplete; holding claims until it is fixed",
					slog.Int("swept", swept), slog.String("error", err.Error()))
				// A failed sweep means a value may still be on disk. Refusing
				// to claim turns is the only answer that is not a claim.
				return
			}
			if swept > 0 {
				log.Warn("startup sweep removed secrets a previous death left behind",
					slog.Int("rows_closed", swept))
			}
		}
		if err := registry.UpdateSandboxState(ctx, workerID, sandboxFacts.Backend,
			sandboxFacts.Version, sandboxFacts.Enforcement, sandboxFacts.Verified,
			sandboxFacts.Notes); err != nil {
			log.Warn("worker sandbox state could not be registered",
				slog.String("error", err.Error()))
		}
		// M4: the attempt loop starts on the far side of the same
		// SweepUncleaned gate — a node attempt may materialize secrets
		// (§ 4 step 4), so it claims only once the promise "no dead
		// worker's values are on this disk" holds. Both loops then share
		// the drain path (§ 4 step 12): claims stop, in-flight bodies get
		// the grace window, and whatever remains writes its own terminal
		// before the offline row.
		go func() {
			if err := attemptLoop.Start(ctx); err != nil {
				log.Warn("attempt loop stopped", slog.String("error", err.Error()))
			}
		}()
		if err := loop.Start(ctx); err != nil {
			log.Warn("turn loop stopped", slog.String("error", err.Error()))
		}
	}
	w.Drain = func(ctx context.Context) error {
		return errors.Join(loop.Drain(ctx), attemptLoop.Drain(ctx))
	}

	log.Info("worker starting",
		slog.String("hostname", opts.cfg.Hostname),
		slog.String("version", version),
		slog.String("heartbeat", opts.cfg.Heartbeat.String()),
	)
	if err := w.Run(ctx); err != nil {
		stop()
		log.Error("worker stopped", slog.String("error", err.Error()))
		return 1
	}
	return 0
}

// acpAskModeID resolves the prompting mode for the launcher registry's
// ask-capable launchers (docs/compatibility/ACP.md "Permission modes"); an
// unknown launcher yields "" and the loop refuses the ask mode on it.
func acpAskModeID(launcherID string) string {
	l, ok := acp.LookupLauncher(launcherID)
	if !ok {
		return ""
	}
	return l.AskModeID
}

// newRunWorkspacePreparer is docs/m4-contract.md § 4 step 3's worker half:
// the on-disk tree (wsgit.Manager.Prepare under the `run` scope, the M3 D1
// tree M4 finally populates) and the rows that make it a fact
// (postgres.RunWorkspaces.Prepare's single transaction of `workspaces` row +
// worker_affinity/worker_volume_id, then the workspace_repos paths that every
// sandbox grant is later built from, ADR-0017 FC3).
//
// It is handed to internal/worker as a func because internal/worker must not
// import the store (AGENTS.md's dependency rule); the typed different-worker
// refusal is re-stated as worker.ErrDifferentRunWorkspaceOwner on the way
// out, which is what RunWorkspaceExecutor turns into the attempt's
// workspace.recovery_lost/different_worker detail.
//
// Order and why:
//
//  1. measure + record both storage roots first. RunWorkspaces.Prepare
//     refuses a volume it has no worker_volumes row for, and V5b is the
//     reason the repos root is recorded too (the mirrors live there and a
//     workspace may not bind to an unmeasured volume).
//  2. If the run already has a workspace, the tree was built by whoever owns
//     it — so this call only *checks the door* (Prepare is idempotent for the
//     owning worker on the owning volume and refuses everyone else, journalling
//     the loss). No disk work happens on that path: cloning a second copy of
//     another worker's run is the thing step 3 exists to prevent.
//  3. Otherwise the tree is prepared BEFORE the door is closed, so a git
//     failure (unreachable mirror, bad branch) leaves the run unbound and
//     claimable rather than pinning it to a worker that cannot build it. The
//     row that Prepare leaves behind stays `preparing` — `ready` is only ever
//     written together with the repo rows (ADR-0017 D3), which is step 5.
//  4. RunWorkspaces.Prepare then claims affinity, echoing the commits this
//     prepare observed (it validates they belong to the run's project but
//     records no paths itself — those are RecordRepos' by contract).
//  5. RecordRepos writes the paths and moves the workspace to `ready` in one
//     transaction, so no attempt can resolve a boundary whose tree the rows do
//     not describe. Whether step 5 has anything to do is decided from
//     workspace_repos itself (decideRunWorkspaceRepoRecording), never from the
//     commit states step 4 echoes back — the echo is this call's own input on
//     the arm that created the row, and trusting it is what left run workspaces
//     'preparing' with no repo rows at all.
func newRunWorkspacePreparer(opts workerOptions, pool *pgxpool.Pool, workerID func() string,
	log *slog.Logger) worker.RunWorkspacePreparer {
	mgr, mgrErr := wsgit.NewManager(opts.workspaceRoot, opts.reposRoot, nil)
	workspaces := &postgres.WorkspaceStore{Pool: pool}
	runs := &postgres.RunWorkspaces{Pool: pool}
	repoRead := &postgres.TurnStore{Pool: pool}
	return func(ctx context.Context, c worker.AttemptClaim) error {
		if mgrErr != nil {
			return fmt.Errorf("run workspace roots: %w", mgrErr)
		}
		if c.RunID == "" || c.ProjectID == "" || c.OrganizationID == "" {
			return fmt.Errorf("attempt claim has no run/project/organization id (run %q project %q org %q): the run workspace cannot be resolved", c.RunID, c.ProjectID, c.OrganizationID)
		}
		id := workerID()
		if id == "" {
			return errors.New("worker is not registered yet: a run workspace needs a worker id to bind to")
		}

		vols, err := mgr.Measure()
		if err != nil {
			return fmt.Errorf("measure storage roots: %w", err)
		}
		wsVol, ok := vols[wsgit.RootKindWorkspaces]
		if !ok {
			return errors.New("the workspaces root could not be measured")
		}
		reposVol, ok := vols[wsgit.RootKindRepos]
		if !ok {
			return errors.New("the mirror root could not be measured")
		}
		for _, v := range []wsgit.Volume{wsVol, reposVol} {
			if err := workspaces.RecordVolume(ctx, worker.VolumeRecord{
				WorkerID: id, RootKind: v.RootKind, RootPath: v.Path,
				StDev: v.StDev, StIno: v.StIno, FSType: v.FSType, VolumeID: v.ID,
			}); err != nil {
				return fmt.Errorf("record %s volume of worker %s: %w", v.RootKind, id, err)
			}
		}

		ref, prepared, err := runs.RunWorkspace(ctx, c.RunID)
		if err != nil {
			return fmt.Errorf("look up the workspace of run %s: %w", c.RunID, err)
		}
		if prepared {
			if _, err := runs.Prepare(ctx, c.RunID, id, wsVol.ID, ref.RepoStates); err != nil {
				return runWorkspaceRefusal(err)
			}
			return nil
		}

		repos, err := repoRead.ProjectRepos(ctx, c.ProjectID)
		if err != nil {
			return fmt.Errorf("list repositories of project %s: %w", c.ProjectID, err)
		}
		specs := make([]wsgit.RepoSpec, 0, len(repos))
		for _, r := range repos {
			specs = append(specs, wsgit.RepoSpec{RepositoryID: r.ID, Name: r.Name, GitURL: r.GitURL, DefaultBranch: r.DefaultBranch})
		}
		prep, err := mgr.Prepare(ctx, wsgit.PrepareRequest{
			// The run scope and the run id: <workspaces>/run/<run-id> with work/
			// granted to the attempt and meta/ kept out of every grant
			// (ADR-0017 D4, probe C-GRANT2).
			ScopeKind: "run", ScopeID: c.RunID, ProjectID: c.ProjectID,
			WorkspaceVolumeID: wsVol.ID, MirrorVolumeID: reposVol.ID,
			Repos: specs,
			// ExcludedPaths is deliberately empty: APM-generated and
			// node-attempt-secret trees are § 4 step 4's to declare, and they
			// must reach info/exclude before the first capture, not after.
		})
		if err != nil {
			return fmt.Errorf("prepare the run workspace tree for %s: %w", c.RunID, err)
		}
		states := make([]worker.CheckpointRepoState, 0, len(prep.Repos))
		for _, r := range prep.Repos {
			states = append(states, worker.CheckpointRepoState{
				RepositoryID: r.RepositoryID, BaseCommit: r.BaseCommit, HeadCommit: r.HeadCommit,
			})
		}
		bound, err := runs.Prepare(ctx, c.RunID, id, wsVol.ID, states)
		if err != nil {
			return runWorkspaceRefusal(err)
		}
		// Whether the rows still need writing is a question about
		// workspace_repos, so it is answered from workspace_repos
		// (runWorkspaceRepoState), never from bound.RepoStates: on the arm that
		// created the row, that field is the echo of `states` we just handed
		// Prepare, which records no paths itself. Reading the echo as proof of
		// committed rows made every project with at least one repo skip
		// RecordRepos, and the workspace stayed `preparing` with no authorized
		// checkout forever (live M4 lab evidence).
		seen, err := readRunWorkspaceRepoState(ctx, runs, c.RunID)
		if err != nil {
			return fmt.Errorf("read back the repo rows of run workspace %s: %w", bound.WorkspaceID, err)
		}
		if !seen.exists {
			return fmt.Errorf("the workspace row of run %s (%s) is gone between preparation and the repo rows", c.RunID, bound.WorkspaceID)
		}
		if decideRunWorkspaceRepoRecording(seen) == runWorkspaceRepoAlreadyRecorded {
			// A concurrent attempt of this run finished the same prepare while we
			// were cloning: its rows describe this same tree (the idempotent reuse
			// arm only answers for this worker on this volume), so there is
			// nothing left to record.
			log.Info("run workspace repo rows already recorded by another attempt",
				slog.String("run_id", c.RunID), slog.String("workspace_id", bound.WorkspaceID))
			return nil
		}

		rows := make([]worker.WorkspaceRepo, 0, len(prep.Repos))
		for _, r := range prep.Repos {
			rows = append(rows, worker.WorkspaceRepo{
				WorkspaceID: bound.WorkspaceID, OrganizationID: c.OrganizationID, ProjectID: c.ProjectID,
				RepositoryID: r.RepositoryID, CheckoutPath: r.CheckoutPath, MirrorPath: r.MirrorPath,
				MirrorVolumeID: r.MirrorVolume, AdminDir: r.AdminDir, RunRef: r.RunRef,
				BaseCommit: r.BaseCommit,
			})
		}
		// markReady is unconditional, exactly as M3's unit builder does it
		// (internal/worker/unit.go): the rows and the preparing → ready move are
		// one transaction, and a tree the worker finished preparing is ready
		// even when the project holds no repository at all.
		if err := workspaces.RecordRepos(ctx, bound.WorkspaceID, rows, true); err != nil {
			// A second attempt of the same run can win the race between the
			// lookup above and this write (capacity > 1). Its rows describe the
			// same tree, so the fact this call wanted is already committed.
			if again, err2 := readRunWorkspaceRepoState(ctx, runs, c.RunID); err2 == nil &&
				decideRunWorkspaceRepoRecording(again) == runWorkspaceRepoAlreadyRecorded {
				log.Warn("run workspace repo rows were written by a concurrent attempt",
					slog.String("run_id", c.RunID), slog.String("workspace_id", bound.WorkspaceID),
					slog.String("error", err.Error()))
				return nil
			}
			return fmt.Errorf("record the repositories of run workspace %s: %w", bound.WorkspaceID, err)
		}
		log.Info("run workspace prepared",
			slog.String("run_id", c.RunID), slog.String("workspace_id", bound.WorkspaceID),
			slog.String("worker_id", id), slog.String("volume_id", bound.VolumeID),
			slog.Int("repos", len(rows)))
		return nil
	}
}

// workspaceReposFacts is everything the preparer needs to know about a run
// workspace's repo rows — read from the store, where the rows either exist or
// they do not, rather than from the commit states Prepare echoes back.
type workspaceReposFacts struct {
	exists      bool // a live workspace row for the run
	rowsWritten bool // workspace_repos has at least one row for it
	ready       bool // the row is already in state 'ready'
}

type runWorkspaceRepoAction int

const (
	// runWorkspaceRepoRecord: write the prepared paths into workspace_repos and
	// take the row to 'ready' in the same transaction.
	runWorkspaceRepoRecord runWorkspaceRepoAction = iota
	// runWorkspaceRepoAlreadyRecorded: somebody (this call's earlier attempt, or
	// a concurrent one on the same worker) already did. Cheap no-op.
	runWorkspaceRepoAlreadyRecorded
)

// decideRunWorkspaceRepoRecording is the whole fix for the run workspaces that
// stayed 'preparing' forever: the decision is made ONLY from what the store
// reports about workspace_repos. It deliberately takes no commit-state
// argument, because the `RunWorkspaceRef.RepoStates` that Prepare returns on
// the arm that created the row is the caller's own input echoed back — with a
// repo in the project it was always non-empty, and the preparer read that
// echo as "rows already written" and returned before RecordRepos.
func decideRunWorkspaceRepoRecording(f workspaceReposFacts) runWorkspaceRepoAction {
	if f.rowsWritten || f.ready {
		return runWorkspaceRepoAlreadyRecorded
	}
	return runWorkspaceRepoRecord
}

// readRunWorkspaceRepoState asks the database the question above.
func readRunWorkspaceRepoState(ctx context.Context, runs *postgres.RunWorkspaces, runID string) (workspaceReposFacts, error) {
	exists, rowsWritten, ready, err := runs.RunWorkspaceRepoState(ctx, runID)
	if err != nil {
		return workspaceReposFacts{}, err
	}
	return workspaceReposFacts{exists: exists, rowsWritten: rowsWritten, ready: ready}, nil
}

// runWorkspaceRefusal restates the store's typed one-way-door refusal in the
// worker's own vocabulary, so internal/worker can recognise it without
// importing the store. Everything else passes through untouched.
func runWorkspaceRefusal(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, postgres.ErrRunWorkspaceDifferentWorker) {
		return fmt.Errorf("%w: %v", worker.ErrDifferentRunWorkspaceOwner, err)
	}
	return err
}

// newAgentTurn assembles the agent.acp executor (contract § 4 steps 4–6, 8,
// 10–12) on the same seams the § 4 step 6 wave owns: the attempt session
// store and the pinned agent-profile read are the Postgres implementations,
// the permission verdict is the node policy built per attempt from the
// resolved profile's permission mode, and the spawn is the SAME acp factory
// shape the M2 loop drives — RequirePlan set under `required`, so a session
// whose context carries no verified launch plan is refused by the factory
// rather than exec'd unsandboxed (ADR-0019 D6, no third branch). The sandbox
// verifier, launcher-credential dirs and nono path are procexec's, so the
// two kinds measure the same backend. Checkpoints is bound by the caller now
// that the § 4 step 3 run-workspace wave has landed: a completed turn records
// the workspace and volume actually prepared for its run, never an invented
// volume (D-024), and the RunWorkspaceExecutor wrapper refuses the attempt
// outright when that workspace belongs to another worker.
func newAgentTurn(opts workerOptions, pool *pgxpool.Pool, units *worker.UnitService, log *slog.Logger) *worker.AgentTurn {
	return &worker.AgentTurn{
		WorkspaceRoot: opts.workspaceRoot,
		LauncherHome:  opts.sandboxLauncherHome,
		PolicyDir:     opts.policyDir,
		SandboxPath:   nonoPath(),
		Sandbox:       units.Sandbox,
		Enforcement:   opts.sandboxEnforcement,
		GitIdentity:   opts.agentGit,
		LauncherAuth:  launcherCredentialDirs,
		Spawn: &acp.Factory{
			Runtime:     &acp.Runtime{Logger: log},
			RequirePlan: opts.sandboxEnforcement == domain.EnforceRequired,
		},
		Profiles:   &postgres.AgentProfiles{Pool: pool},
		Sessions:   &postgres.AttemptSessions{Runs: &postgres.RunStore{Pool: pool}},
		AskModeID:  acpAskModeID,
		ModePolicy: postgres.PermissionPolicyFor,
		Logger:     log,
	}
}

// afUnixRemediation is the remediation sentence the EPERM finding names, and
// it is the one a runbook can act on: no fallback exists, so the only options
// are the kernel knob or an operator-approved ADR the owner has not decided.
const afUnixRemediation = "set kernel.yama.ptrace_scope<=1 on the node, or an operator-approved AF_UNIX mediation fallback (not yet available, ADR pending)"

// ptraceScopeValue reads /proc/sys/kernel/yama/ptrace_scope when readable. The
// EPERM finding is a kernel fact, and the log line names it so an operator on
// the node can confirm the cause in one command.
func ptraceScopeValue() string {
	data, err := os.ReadFile("/proc/sys/kernel/yama/ptrace_scope")
	if err != nil {
		return "unreadable"
	}
	return strings.TrimSpace(string(data))
}

// sandboxRegistration is what this worker can honestly write into the
// workers.sandbox_* columns after its startup gate. The zero value ("none",
// unverified) is the honest default for a mode that probed nothing.
type sandboxRegistration struct {
	Backend     string
	Version     string
	Enforcement string
	Verified    bool
	Notes       []string
	// TCPReachability is the agent-turn TCP-reachability probe's
	// classification (nono.TCPProbeOK / TCPProbeEperm / TCPProbeOther) and
	// TCPDetail its verbatim child report; both are empty when the probe did
	// not run (modes that do not launch the agent profile).
	TCPReachability string
	TCPDetail       string
	// AgentTurnsAvailable is false when the startup probe found that the
	// agent-turn sandbox cannot complete ANY TCP connect on this host
	// (EPERM under af_unix_mediation=pathname — seccomp-notify connect
	// mediation the kernel cannot inspect). runWorker then leaves the
	// agent.acp executor unregistered: an honest refusal beats a turn that
	// dies "Unable to connect to API (EPERM)" and journals an infra error.
	AgentTurnsAvailable bool
}

// newUnitService assembles the M3 execution-unit service from worker options
// and reports the secret materializer (so the registration callback can run
// the startup sweep through the same wiring the units use) and the sandbox
// facts the gate observed.
//
// The two storage roots are validated here rather than by the caller because the
// refusal has to happen before the worker registers: a worker that comes online
// and then fails every turn because its mirror root is inside its workspace root
// (which AssertNothingBut would reject on every prepare) advertises a capability
// it does not have.
func newUnitService(opts workerOptions, pool *pgxpool.Pool, log *slog.Logger) (*worker.UnitService, *postgres.UnitSecrets, sandboxRegistration, error) {
	facts := sandboxRegistration{
		Backend: "none", Enforcement: string(opts.sandboxEnforcement), Verified: false,
	}
	workMgr, err := wsgit.NewManager(opts.workspaceRoot, opts.reposRoot, nil)
	if err != nil {
		return nil, nil, facts, fmt.Errorf("workspace roots: %w", err)
	}
	for dir, why := range map[string]string{
		opts.sandboxLauncherHome: "nono's HOME must exist and be worker-owned",
		opts.policyDir:           "the profile directory must exist before a policy can be written",
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, nil, facts, fmt.Errorf("%s (%s): %w", why, dir, err)
		}
		if err := wsgit.CheckGrantPath(dir); err != nil {
			return nil, nil, facts, fmt.Errorf("%s: %w", why, err)
		}
	}
	// The launcher home must not sit under either storage root: a grant covering
	// nono's own HOME is refused by nono itself, and the refusal is *sticky* —
	// once nono has run with HOME=X, every later grant covering X is refused
	// (probe C-H1). Placing it under a workspace would poison the workspace for
	// every subsequent unit on this worker, which is why this is checked at
	// startup rather than discovered mid-turn.
	for _, root := range []string{opts.workspaceRoot, opts.reposRoot} {
		if pathIsUnderRoot(root, opts.sandboxLauncherHome) {
			return nil, nil, facts, fmt.Errorf("nono's HOME %s is inside the storage root %s: any grant covering the root would be refused permanently (probe C-H1)", opts.sandboxLauncherHome, root)
		}
	}
	nano := &nono.Launcher{Binary: nonoPath(), Home: opts.sandboxLauncherHome}
	// The startup gate. Probe alone cannot serve as this gate: `nono setup
	// --check-only` reports whether Landlock rulesets could be *created*, and
	// Launch.Probe deliberately never sets Verified (M2 recorded that honesty,
	// and a probe that claims enforcement it did not observe would be worse than
	// one that refuses). A `required` worker therefore has to prove enforcement by
	// running a child, which is what SelfTest does — and its own negative control
	// (selftest_negative_test.go) shows a sandbox that does not deny is refused
	// rather than credited.
	//
	// The scratch root is a *third* directory, not the launcher home and not a
	// storage root: a grant under either would either trip C-H1's permanent
	// refusal or leave self-test debris inside a tree AssertNothingBut inspects.
	if opts.sandboxEnforcement == domain.EnforceRequired {
		caps, err := nano.Probe(context.Background())
		if err != nil {
			return nil, nil, facts, fmt.Errorf("sandbox probe: %w", err)
		}
		if !caps.Filesystem {
			return nil, nil, facts, fmt.Errorf("sandbox reports no Landlock filesystem support (%s): required mode refuses to start", strings.Join(caps.Notes, "; "))
		}
		selfRoot := opts.sandboxSelfTest
		if err := os.MkdirAll(selfRoot, 0o700); err != nil {
			return nil, nil, facts, fmt.Errorf("sandbox self-test scratch %s: %w", selfRoot, err)
		}
		observed, err := nano.SelfTest(context.Background(), selfRoot, 30*time.Second)
		if err != nil {
			return nil, nil, facts, fmt.Errorf("sandbox enforcement self-test: %w", err)
		}
		log.Info("sandbox enforcement observed before serving turns",
			slog.String("backend", observed.Backend),
			slog.String("backend_version", observed.Version),
			slog.Bool("filesystem_live", observed.FilesystemLive))
		facts = sandboxRegistration{
			Backend: observed.Backend, Version: observed.Version,
			Enforcement: string(opts.sandboxEnforcement), Verified: true,
			Notes: caps.Notes, AgentTurnsAvailable: true,
		}
		// The second startup gate, for the same class of silent failure the
		// filesystem self-test cannot see: a host where Landlock is fully
		// enforced yet the agent profile's AF_UNIX mediation (af_unix_
		// mediation = "pathname", seccomp-notify on connect) cannot inspect
		// the child's sockaddr, so every TCP connect from the child — even a
		// localhost one nono explicitly opened with --open-port — fails
		// EPERM. Measured on a live Talos node with
		// kernel.yama.ptrace_scope = 2 (docs/compatibility/SANDBOX.md): a
		// real agent turn retried for ~4 minutes, then failed "Unable to
		// connect to API (EPERM)" with 0 network_events in nono's audit. The
		// probe under the exact agent profile a turn launches only WITHHOLDS
		// a claim — it weakens nothing.
		tcp, perr := nano.TCPConnectSelfTest(context.Background(), selfRoot, 30*time.Second)
		switch {
		case perr != nil:
			facts.AgentTurnsAvailable = false
			facts.TCPReachability = nono.TCPProbeOther
			facts.TCPDetail = perr.Error()
			log.Error("agent turns withheld: the agent-turn TCP-reachability probe could not be run",
				slog.String("af_unix_mediation", "pathname"),
				slog.String("kernel.yama.ptrace_scope", ptraceScopeValue()),
				slog.String("error", perr.Error()),
				slog.String("remediation", "make the probe runnable (nono and node on the worker image, scratch outside HOME) and restart; agent.acp stays unclaimed until it reports ok"),
			)
		case !tcp.OK && tcp.Classification == nono.TCPProbeEperm:
			facts.AgentTurnsAvailable = false
			facts.TCPReachability = tcp.Classification
			facts.TCPDetail = tcp.Detail
			log.Error("agent turns withheld: the agent-turn sandbox cannot complete ANY TCP connect (seccomp-notify connect mediation unavailable)",
				slog.String("af_unix_mediation", "pathname"),
				slog.String("errno", tcp.Errno),
				slog.String("kernel.yama.ptrace_scope", ptraceScopeValue()),
				slog.String("detail", tcp.Detail),
				slog.String("remediation", afUnixRemediation),
			)
		case !tcp.OK:
			facts.AgentTurnsAvailable = false
			facts.TCPReachability = tcp.Classification
			facts.TCPDetail = tcp.Detail
			log.Error("agent turns withheld: the agent-turn TCP-reachability probe reported an unmeasured shape",
				slog.String("af_unix_mediation", "pathname"),
				slog.String("classification", tcp.Classification),
				slog.String("errno", tcp.Errno),
				slog.String("kernel.yama.ptrace_scope", ptraceScopeValue()),
				slog.String("detail", tcp.Detail),
				slog.String("remediation", "the measured outcomes are ok or EPERM (docs/compatibility/SANDBOX.md); report the verbatim detail before deciding anything"),
			)
		default:
			facts.TCPReachability = tcp.Classification
			log.Info("agent-turn TCP reachability observed before serving turns",
				slog.Int("port", tcp.Port),
				slog.String("profile_digest", tcp.ProfileDigest),
			)
		}
	}
	// The M3 seams: secrets resolve and materialize through the store-owned
	// adapter (the worker package never holds plaintext — the seam returns
	// paths, env entries, and a redaction black box), artifacts publish through
	// the byte backend this process writes (rw here: the worker is the single
	// writer of the artifact volume, ADR-0020 D2), and packaged context stages
	// with the vendored apm binary if the image carries one.
	keyring := keyringFromEnvOrDefault(log)
	if keyring == nil && strings.TrimSpace(os.Getenv(secrets.EnvKeyring)) != "" {
		return nil, nil, facts, fmt.Errorf("%s is set but the keyring there is unreadable", secrets.EnvKeyring)
	}
	artifactBytes, err := artifactBytesFromEnv(false, log)
	if err != nil {
		return nil, nil, facts, err
	}
	unitStore := &postgres.WorkspaceStore{Pool: pool}
	secretStore := &postgres.SecretStore{Pool: pool, Keys: keyring}
	unitsSecrets := &postgres.UnitSecrets{Secrets: secretStore, Workspaces: unitStore}
	svc := &worker.UnitService{
		Store:        unitStore,
		Workspaces:   workMgr,
		Sandbox:      nano,
		SandboxPath:  nonoPath(),
		Profiles:     &postgres.ProfileReader{Pool: pool},
		LauncherHome: opts.sandboxLauncherHome,
		PolicyDir:    opts.policyDir,
		GitIdentity:  opts.agentGit,
		Enforcement:  opts.sandboxEnforcement,
		LauncherAuth: launcherCredentialDirs,
		Logger:       log,
		Secrets:      unitsSecrets,
		Artifacts: &postgres.UnitArtifacts{
			Pool:  pool,
			Bytes: artifactBytes,
		},
	}
	// APM is an interface field: a nil *APMStager assigned to it would make
	// `svc.APM == nil` false and turn "no binary" into a panic-shaped refusal
	// instead of the documented one, so it is set only when it exists.
	if stager := apmStager(log); stager != nil {
		svc.APM = stager
	}
	return svc, unitsSecrets, facts, nil
}

// apmStager resolves the packaged-context seam. A binary the image does not
// carry leaves the seam nil — and a profile that then pins a package refuses
// its turns (unit.stageAPM), because running without the packaged context the
// profile promises is running a different agent than the one configured.
func apmStager(log *slog.Logger) worker.APMTyper {
	binary := strings.TrimSpace(os.Getenv("COMMUNICATION_APM_BINARY"))
	if binary == "" {
		if found, err := exec.LookPath("apm"); err == nil {
			binary = found
		} else if _, err := os.Stat("/opt/apm/apm"); err == nil {
			binary = "/opt/apm/apm"
		}
	}
	if binary == "" {
		log.Warn("no apm binary on PATH or at /opt/apm/apm: profiles that pin packaged context will refuse their turns",
			slog.Bool("apm_staging_available", false))
		return nil
	}
	return &worker.APMStager{Binary: binary, Timeout: 2 * time.Minute}
}

// launcherCredentialDirs resolves the credential directories a launcher declares
// (ADR-0019 D4). It reads the variables the launcher itself names, so a launcher
// whose auth lives somewhere the operator did not configure is a startup refusal
// rather than an agent that cannot log in — the failure docs/compatibility/ACP.md
// already documented as looking like an agent bug.
func launcherCredentialDirs(launcherID string) ([]string, error) {
	launcher, ok := acp.LookupLauncher(launcherID)
	if !ok {
		return nil, fmt.Errorf("unknown launcher %q", launcherID)
	}
	var out []string
	for _, kv := range acp.AuthEnvFromOS(launcher) {
		_, value, _ := strings.Cut(kv, "=")
		out = append(out, value)
	}
	return out, nil
}

// nonoPath resolves the sandbox binary once, so the recorded plan and the
// probed backend are the same program. LookPath rather than a configured path
// keeps the container image in charge of which build this is (worker/Dockerfile
// pins it by SHA-256); a configured path would let an operator point a
// `required` worker at anything.
func nonoPath() string {
	path, err := exec.LookPath("nono")
	if err != nil {
		return "nono"
	}
	return path
}

// pathIsUnderRoot reports whether candidate sits strictly below root. Both
// arguments are cleaned first so a trailing slash or a `./` cannot make a path
// that is inside look like one that is not.
func pathIsUnderRoot(root, candidate string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(candidate) {
		return false
	}
	root, candidate = filepath.Clean(root), filepath.Clean(candidate)
	return strings.HasPrefix(candidate, root+string(filepath.Separator))
}

// newModelChat builds § 4 step 8's model.chat executor, or nil when this
// worker has no endpoint: unregistered means refusalExecutor stays honest
// about there being no executor here, which is the truth an operator who
// configured no egress wants to read in an attempt detail.
//
// The credential and the allowlist come from the environment only (see
// modelChatOptions): the pipeline document contributes a model *name*, and a
// node that could name its own endpoint would be a node that can exfiltrate a
// project's content anywhere. The API key is never logged — only whether one
// is set — and only the endpoint host is named at startup.
func (o workerOptions) newModelChat(log *slog.Logger, pool *pgxpool.Pool, unitsSecrets *postgres.UnitSecrets, artifactBytes artifacts.Store) worker.AttemptExecutor {
	if o.modelChat.baseURL == "" {
		log.Info("model.chat is not configured on this worker: no COMMUNICATION_MODEL_CHAT_BASE_URL, so the kind is not registered and its nodes fail with the worker's honest refusal (contract § 4 step 8)")
		return nil
	}
	chat := &worker.ModelChat{
		BaseURL: o.modelChat.baseURL,
		APIKey:  o.modelChat.apiKey,
		Models:  o.modelChat.models,
		Logger:  log,
	}
	// The node-boundary capture seam, wired exactly like process.exec's
	// procExec above: the same run-workspace store (the run's boundary
	// identity, § 4 step 3) and the same workspace root process.exec's
	// boundaryGit is built from. Without it checkpointFor answers an empty
	// record and the store's boundary transaction refuses the completion
	// (D-024 is same-volume only), so every successful model.chat node would
	// fail its terminal write — the kind's own code refuses honestly instead.
	chat.Checkpoints = &postgres.RunWorkspaces{Pool: pool}
	chat.WorkspaceRoot = o.workspaceRoot
	// § 4 step 8's over-cap branch: a completion above the 32 KiB inline cap
	// travels as a kind=json artifact, so model.chat gets the SAME byte backend
	// and the SAME fenced row writer artifact.publish is given — one door for
	// both kinds, and a spill that is un-wired stays the honest
	// outputs_too_large refusal rather than a clipped answer.
	if artifactBytes != nil {
		chat.Bytes = artifactBytes
		chat.Rows = &postgres.AttemptArtifacts{Pool: pool}
	} else {
		log.Warn("model.chat has no artifact byte backend: an over-cap completion will fail with outputs_too_large instead of spilling to a kind=json artifact (contract § 4 step 8)")
	}
	log.Info("model.chat egress is configured against this endpoint (new egress path, ADR-0024 Security)",
		slog.String("endpoint", chat.EndpointHost()),
		slog.String("base_url_path", mustURLPath(o.modelChat.baseURL)),
		slog.String("allowed_models", strings.Join(o.modelChat.models, ",")),
		slog.Bool("api_key_set", o.modelChat.apiKey != ""))
	if len(o.modelChat.models) == 0 {
		log.Warn("model.chat has an endpoint but no COMMUNICATION_MODEL_CHAT_MODELS allowlist: every node will be refused by name, which is the fail-closed default",
			slog.String("endpoint", chat.EndpointHost()))
	}
	if unitsSecrets == nil {
		// No secret store on this worker means no run can have materialized a
		// value, so the scan has nothing to look for (artifact.publish reaches
		// the same conclusion through the same seam).
		return chat
	}
	return &modelChatSecretScan{
		Chat:   chat,
		Values: &postgres.RunSecretValues{Pool: pool, Secrets: unitsSecrets.Secrets},
	}
}

func mustURLPath(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Path
}

// modelChatSecretScan is § 4 step 8's redaction gate: the same run-scoped
// scanner artifact.publish uses (postgres.RunSecretValues reads
// secret_materializations for every attempt of the run), applied to the request
// body instead of artifact bytes. It wraps rather than configures for
// ArtifactPublishSecretScan's reason — the Redact seam takes no context and no
// claim, and a scan that cannot be built must fail the attempt rather than
// report zero. ADR-0018's rule is stricter here than for an artifact: a flagged
// body is refused before a single byte leaves the process, not redacted and
// sent.
type modelChatSecretScan struct {
	Chat   *worker.ModelChat
	Values *postgres.RunSecretValues
}

var _ worker.AttemptExecutor = (*modelChatSecretScan)(nil)

func (s *modelChatSecretScan) Execute(ctx context.Context, c worker.AttemptClaim, sink worker.AttemptSink) (worker.AttemptResult, error) {
	if s == nil || s.Chat == nil {
		return worker.AttemptResult{Status: worker.AttemptStatusFailed,
			ErrorClass: worker.ErrorClassInfra,
			Detail:     modelChatDetail("model.chat: the executor is not wired (contract § 4 step 8)")}, nil
	}
	if s.Values == nil {
		return worker.AttemptResult{Status: worker.AttemptStatusFailed,
			ErrorClass: worker.ErrorClassSandboxEnforcementFail,
			Detail: modelChatDetail("model.chat: no run secret scanner is wired on this worker, so the request " +
				"body would leave the host unscanned; refusing to send anything (ADR-0024 Security)")}, nil
	}
	redact, wipe, err := s.Values.Redactor(ctx, c.RunID)
	if err != nil {
		return worker.AttemptResult{Status: worker.AttemptStatusFailed,
			ErrorClass: worker.ErrorClassSandboxEnforcementFail,
			Detail: modelChatDetail("model.chat: the run's secret scan could not be built from the " +
				"materialization ledger, so no request was sent (contract § 4 step 8): " + err.Error())}, nil
	}
	defer wipe()

	return s.Chat.WithRedact(redact).Execute(ctx, c, sink)
}

// modelChatDetail keeps an attempt detail inside attempts.detail's 512-byte
// CHECK (00005) without importing worker's unexported helper.
func modelChatDetail(s string) string {
	const max = 512
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}

// ---------------------------------------------------------- § 6 restore chain

// attemptChain is the fixed decorator order every launchable node kind
// travels on this worker:
//
//	RunWorkspaceExecutor{Prepare, Inner: CheckpointRestorer{Inner: <kind>}}
//
// The order is not cosmetic. ADR-0023 § 6's reset happens *before* anything
// launches, and only inside a tree § 4 step 3 prepared — so the preparer must
// run first and the reset must land between it and the kind's exec/launch.
// One chain value is shared by every kind for the same reason the preparer is
// shared: the boundary a retried attempt inherits is a fact about the run, and
// two copies of the resolver would be two chances to disagree about it.
type attemptChain struct {
	prepare  worker.RunWorkspacePreparer
	boundary worker.BoundaryResolver
	git      worker.RestoreGit
	log      *slog.Logger
}

// wrap nests the two decorators around one kind's executor.
func (c attemptChain) wrap(inner worker.AttemptExecutor) worker.AttemptExecutor {
	return &worker.RunWorkspaceExecutor{
		Prepare: c.prepare,
		Logger:  c.log,
		Inner: &worker.CheckpointRestorer{
			Inner:    inner,
			Boundary: c.boundary,
			Git:      c.git,
			Logger:   c.log,
		},
	}
}

// newAttemptChain wires the chain for one worker: § 4 step 3's preparer,
// § 6's boundary read (postgres — the store type stops here, per AGENTS.md's
// dependency rule), and the git half (wsgit.Manager, running UNSANDBOXED in
// this process, which is what § 6 means and what AGENTS.md requires: no
// Landlock ever wraps the worker's own git plumbing).
//
// A git manager this worker cannot build (a refused root path) is NOT a boot
// failure: the restorer reports the missing seam on the attempts that asked
// for restore_checkpoint and continue_workspace — M4's default, 100 % of the
// runs today — keeps running exactly as it did before this arm existed.
func newAttemptChain(opts workerOptions, pool *pgxpool.Pool, prepare worker.RunWorkspacePreparer,
	log *slog.Logger) (attemptChain, error) {
	mgr, err := wsgit.NewManager(opts.workspaceRoot, opts.reposRoot, nil)
	if err != nil {
		log.Warn("checkpoint restore has no git manager: restore_checkpoint attempts will be refused, "+
			"continue_workspace is unaffected", slog.String("error", err.Error()))
		return attemptChain{prepare: prepare, boundary: newBoundaryResolver(pool), log: log}, nil
	}
	return attemptChain{prepare: prepare, boundary: newBoundaryResolver(pool), git: mgr, log: log}, nil
}

// newBoundaryResolver adapts the store's read to internal/worker's func seam.
func newBoundaryResolver(pool *pgxpool.Pool) worker.BoundaryResolver {
	runs := &postgres.RunWorkspaces{Pool: pool}
	return func(ctx context.Context, c worker.AttemptClaim) (worker.RestoreBoundary, bool, error) {
		return runs.RestoreBoundary(ctx, c.RunID, c.NodeExecutionID)
	}
}

// newAttemptExecutors routes every wired kind through the same chain, so no
// kind can be added later that skips the reset it must not skip, and no kind
// is wrapped by a second, drifting copy of it.
//
// artifact.publish is wrapped like the rest on purpose: a retried publish that
// its author marked restore_checkpoint publishes what the BOUNDARY holds, not
// what the interrupted attempt left in the tree. model.chat registers only
// when an endpoint is configured — a worker that never promised egress must
// not quietly start sending content somewhere (ADR-0024 Security).
func newAttemptExecutors(chain attemptChain, procExec, agentTurn, artifactPublish, modelChat worker.AttemptExecutor) worker.AttemptExecutors {
	execs := worker.AttemptExecutors{
		worker.NodeKindProcessExec:     chain.wrap(procExec),
		worker.NodeKindArtifactPublish: chain.wrap(artifactPublish),
	}
	// agent.acp registers only when the worker's startup gate passed its
	// agent-turn TCP-reachability probe; a nil agentTurn leaves the kind
	// unregistered and refusalExecutor honest about it (the EPERM case,
	// docs/compatibility/SANDBOX.md) — same shape as model.chat.
	if agentTurn != nil {
		execs[worker.NodeKindAgentACP] = chain.wrap(agentTurn)
	}
	if modelChat != nil {
		execs[worker.NodeKindModelChat] = chain.wrap(modelChat)
	}
	return execs
}
