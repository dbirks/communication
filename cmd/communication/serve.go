package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/integrations/github"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/secrets"
	"github.com/dbirks/communication/internal/store/postgres"
	"github.com/dbirks/communication/ui"
)

const serveUsage = `usage: communication serve

runs the control plane HTTP API and the embedded UI on the same origin
(communication-spec/02-system-architecture.md, ADR-0007, ADR-0012).

environment:
  COMMUNICATION_DATABASE_URL            required, postgres connection string
  COMMUNICATION_LISTEN_ADDR             listen address (default ":8080")
  COMMUNICATION_PUBLIC_URL              required, browser-facing base URL
  COMMUNICATION_REPLICA_NAME            replica id (default: hostname)
  COMMUNICATION_OIDC_ISSUER             required, issuer used for discovery/tokens
  COMMUNICATION_OIDC_BROWSER_ISSUER     issuer prefix browsers are redirected to
  COMMUNICATION_OIDC_CLIENT_ID          required, OAuth2 client id
  COMMUNICATION_OIDC_CLIENT_SECRET      optional; empty means public + PKCE
  COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS  OIDC subjects that become org admins
  COMMUNICATION_COOKIE_SECURE           Secure cookie flag (default "true")
  COMMUNICATION_WORKER_HEARTBEAT        optional; must match the workers' own
                                        heartbeat interval, because it sets how
                                        long a worker may be silent before
                                        GET /api/v1/workers reports it offline
                                        (default "10s", same as worker mode)
  COMMUNICATION_SECRET_KEYRING          envelope-encryption keyring directory
                                        (ADR-0018 D2.2; default "/keyring"). An
                                        explicitly configured but unreadable
                                        keyring is a startup refusal; an absent
                                        default one disables the secret write
                                        routes loudly rather than killing the
                                        replica.
  COMMUNICATION_ARTIFACT_BACKEND        local (default) | s3
  COMMUNICATION_ARTIFACT_ROOT           local artifact root (default
                                        "/var/lib/communication/artifacts");
                                        mounted read-only on a serving replica
  COMMUNICATION_ARTIFACT_S3_ENDPOINT /  inert while BACKEND=local; the S3 pair
  COMMUNICATION_ARTIFACT_S3_BUCKET /    is ADR-0020 D7's conformance backend
  COMMUNICATION_ARTIFACT_S3_ACCESS_KEY /
  COMMUNICATION_ARTIFACT_S3_SECRET_KEY /
  COMMUNICATION_ARTIFACT_S3_REGION /
  COMMUNICATION_ARTIFACT_SPOOL
  COMMUNICATION_PREVIEW_HOST            preview origin host[:port] the preview
                                        routes answer on (any other Host gets
                                        404 — ADR-0020 D6)
  COMMUNICATION_PREVIEW_BASE_URL        prefix of a minted preview_url
  COMMUNICATION_PREVIEW_TOKEN_TTL       requested token lifetime (default 5m,
                                        clamped to 1h by the signer)
  COMMUNICATION_PREVIEW_TOKEN_SECRET    /…_SECRET_FILE
                                        HMAC key for preview and download
                                        tokens. MUST be identical on every
                                        replica (the token is minted behind a
                                        load balancer and verified on any
                                        origin). Unset is a dev default: a
                                        random per-process key, loudly warned
                                        about, so a restart or a second
                                        replica invalidates tokens rather than
                                        the stack silently cross-verifying
                                        nothing.

migrations are applied separately: communication migrate up
`

// Timing knobs for serve. The pool retry window exists so a replica started
// by compose alongside Postgres waits for the database instead of crash
// looping; readiness reports 503 for the whole window, so the load balancer
// keeps it out of rotation.
const (
	dbDialTimeout     = 60 * time.Second
	dbDialInterval    = 2 * time.Second
	shutdownTimeout   = 15 * time.Second
	readHeaderTimeout = 10 * time.Second
)

// runServe implements the "serve" mode. Exit codes: 0 clean shutdown,
// 2 configuration error, 1 runtime error.
func runServe(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" || a == "help" {
			fmt.Fprint(stdout, serveUsage)
			return 0
		}
	}

	databaseURL := os.Getenv("COMMUNICATION_DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(stderr, "COMMUNICATION_DATABASE_URL is not set")
		return 2
	}
	publicURL := os.Getenv("COMMUNICATION_PUBLIC_URL")
	if publicURL == "" {
		fmt.Fprintln(stderr, "COMMUNICATION_PUBLIC_URL is not set")
		return 2
	}
	authCfg, err := auth.ConfigFromEnv()
	if err != nil {
		// The login path cannot work without these, and a replica that starts
		// and then 503s every sign-in is harder to diagnose than one that
		// refuses to start (ADR-0012 §2).
		fmt.Fprintln(stderr, err)
		return 2
	}
	workerHeartbeat, err := serveWorkerHeartbeat(os.Getenv)
	if err != nil {
		// A heartbeat the read side cannot parse would silently fall back to the
		// default window and report live workers as offline.
		fmt.Fprintln(stderr, err)
		return 2
	}
	listenAddr := os.Getenv("COMMUNICATION_LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}
	replica := os.Getenv("COMMUNICATION_REPLICA_NAME")
	if replica == "" {
		if host, err := os.Hostname(); err == nil && host != "" {
			replica = host
		} else {
			replica = "communication"
		}
	}

	// Structured JSON logs on stderr, every record labelled with the replica
	// so interleaved compose logs stay attributable.
	log := slog.New(slog.NewJSONHandler(stderr, nil)).With(slog.String("replica", replica))

	// The M3 surface configuration, resolved before the pool opens so a
	// misconfigured keyring or artifact backend is a startup refusal rather
	// than a route that fails its first request (ADR-0018 D2.3, ADR-0020
	// Consequences: "a mis-mounted artifact root is a readiness failure").
	m3, code := serveM3Config(stderr, log)
	if code != 0 {
		return code
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := openPool(ctx, databaseURL, log)
	if err != nil {
		stop()
		log.Error("database unavailable", slog.String("error", err.Error()))
		return 1
	}
	defer pool.Close()

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		stop()
		log.Error("listen failed", slog.String("addr", listenAddr), slog.String("error", err.Error()))
		return 1
	}

	var webUI fs.FS
	if ui.Built() {
		webUI = ui.Dist()
	}

	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:            pool,
		DatabaseURL:     databaseURL,
		Auth:            authCfg,
		WorkerHeartbeat: workerHeartbeat,
		API: api.Config{
			ReplicaName: replica,
			Version:     version,
			PublicURL:   publicURL,
			Logger:      log,
		},
		Readiness: dbReadiness{pool: pool, url: databaseURL},
		UI:        webUI,
		Logger:    log,
		M3:        m3,
	})
	if err != nil {
		stop()
		log.Error("server configuration failed", slog.String("error", err.Error()))
		return 2
	}
	defer closeStack()

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
	}
	// A graceful shutdown must not wait on SSE streams that only end when their
	// client leaves: closing the wake-up source ends every open stream, which is
	// also how a restarting replica hands its browsers to another replica (they
	// reconnect with Last-Event-ID and lose nothing).
	srv.RegisterOnShutdown(closeStack)

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()
	log.Info("serving",
		slog.String("addr", listenAddr),
		slog.String("public_url", publicURL),
		slog.String("version", version),
		slog.Bool("ui_built", ui.Built()),
	)

	select {
	case err := <-serveErr:
		if err != nil {
			stop()
			log.Error("server stopped", slog.String("error", err.Error()))
			return 1
		}
		return 0
	case <-ctx.Done():
	}

	// Graceful shutdown: drain in-flight requests, then close the pool. The
	// deadline hangs off Background because ctx is already cancelled.
	log.Info("shutting down", slog.String("deadline", shutdownTimeout.String()))
	drainCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(drainCtx); err != nil {
		log.Error("shutdown incomplete", slog.String("error", err.Error()))
		stop()
		return 1
	}
	log.Info("stopped")
	return 0
}

// openPool opens the Postgres pool, retrying every dbDialInterval for up to
// dbDialTimeout so a replica can start alongside a still-initialising
// database. Warnings are one line each and never contain the connection
// string (postgres.Open scrubs it).
func openPool(ctx context.Context, databaseURL string, log *slog.Logger) (*pgxpool.Pool, error) {
	deadline := time.Now().Add(dbDialTimeout)
	for attempt := 1; ; attempt++ {
		pool, err := postgres.Open(ctx, databaseURL)
		if err == nil {
			if attempt > 1 {
				log.Info("database available", slog.Int("attempts", attempt))
			}
			return pool, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if time.Now().After(deadline) {
			return nil, errors.New("database unreachable after " + dbDialTimeout.String())
		}
		log.Warn("waiting for database",
			slog.Int("attempt", attempt),
			slog.String("error", err.Error()),
		)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(dbDialInterval):
		}
	}
}

// dbReadiness adapts the connection pool to api.Readiness: liveness of the
// datastore comes from the pool, the schema version from a dedicated
// connection so a saturated pool cannot mask a pending migration.
type dbReadiness struct {
	pool *pgxpool.Pool
	url  string
}

// Ping reports whether the datastore is reachable.
func (d dbReadiness) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// SchemaVersion returns the applied migration version, or an error when the
// database cannot be read.
func (d dbReadiness) SchemaVersion(ctx context.Context) (int64, error) {
	return postgres.SchemaVersion(ctx, d.url)
}

// ExpectedSchemaVersion returns the schema version this binary requires.
func (d dbReadiness) ExpectedSchemaVersion() int64 { return postgres.ExpectedSchemaVersion() }

// serveM3 is the resolved M3 configuration for a replica: the keyring (or its
// documented absence), the artifact byte backend *this* process talks to
// (read-only: the worker is the only writer), the preview origin wiring, and
// the pinned policy identity the fleet view reports.
type serveM3 struct {
	Keyring        *secrets.Keyring
	ArtifactBytes  artifacts.Store
	PreviewHost    string
	PreviewBaseURL string
	PreviewTTL     time.Duration
	PreviewSigner  *artifacts.Signer
	PinnedVersion  string
	PolicyDigest   string
}

// serveM3Config resolves the M3 environment. Exit codes follow runServe's own
// rule: 2 for a configuration the operator has to fix.
func serveM3Config(stderr io.Writer, log *slog.Logger) (serveM3, int) {
	var out serveM3
	keyring := keyringFromEnvOrDefault(log)
	if keyring == nil && strings.TrimSpace(os.Getenv(secrets.EnvKeyring)) != "" {
		// Explicitly configured and unreadable: the operator meant to have
		// secrets. Starting anyway would let the API accept secret writes it
		// can never read back — ADR-0018 D2.3 refuses that specifically.
		fmt.Fprintln(stderr, secrets.EnvKeyring+" is set but the keyring there is unreadable")
		return out, 2
	}
	out.Keyring = keyring
	bytes, err := artifactBytesFromEnv(true, log)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return out, 2
	}
	out.ArtifactBytes = bytes
	out.PreviewHost, out.PreviewBaseURL, out.PreviewTTL = previewConfigFromEnv()
	if out.PreviewHost != "" || out.PreviewBaseURL != "" {
		secret := previewTokenSecret(log)
		if len(secret) == 0 {
			fmt.Fprintln(stderr, "preview is configured but its token secret is unreadable")
			return out, 2
		}
		signer, err := artifacts.NewSigner(secret)
		if err != nil {
			fmt.Fprintln(stderr, err.Error())
			return out, 2
		}
		out.PreviewSigner = signer
	}
	pinned, digest, err := pinnedPolicy()
	if err != nil {
		fmt.Fprintln(stderr, "pinned sandbox policy is unreadable:", err)
		return out, 2
	}
	out.PinnedVersion, out.PolicyDigest = pinned, digest
	return out, 0
}

// serveStackDeps is everything a serving replica needs: an open pool, the
// identity configuration and the API/HTTP configuration. It is a struct so a
// test can build the exact handler production runs without opening a socket.
type serveStackDeps struct {
	Pool        *pgxpool.Pool
	DatabaseURL string
	Auth        auth.Config
	API         api.Config
	Readiness   api.Readiness
	UI          fs.FS
	Logger      *slog.Logger

	// WorkerHeartbeat is the workers' heartbeat interval, used only to decide
	// when GET /api/v1/workers reports a silent worker as offline. Zero uses the
	// store default, which matches worker mode's own default.
	WorkerHeartbeat time.Duration

	// M3 is the resolved secret/artifact/preview configuration. The zero value
	// keeps every M1/M2 route working: secrets refuse through the absent
	// keyring, artifacts serve no bytes, and the preview origin stays shut.
	M3 serveM3
}

// serveWorkerHeartbeat reads the same environment variable worker mode uses,
// because the read side's patience has to be derived from the write side's
// cadence: with a 60s heartbeat and the 10s default here, a perfectly healthy
// worker is reported offline after 30s of silence. An unset value is not an
// error — the store default applies.
func serveWorkerHeartbeat(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv("COMMUNICATION_WORKER_HEARTBEAT"))
	if raw == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT %q is not a duration: %w", raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("COMMUNICATION_WORKER_HEARTBEAT must be positive, got %s", d)
	}
	return d, nil
}

// serveStack builds the HTTP handler for one replica and returns it with a
// function that releases its background resources.
//
// Every route in the M1 and M2 contracts is registered here, and the session
// store is the Authenticator — there is no placeholder left to fail closed
// behind:
//
//	auth.Service              /auth/login, /auth/callback, /auth/logout,
//	                          /api/v1/me, /api/v1/users (and the cookie
//	                          session Authenticator)
//	api.RegisterProjects      projects, repositories, members
//	api.RegisterGitHubIssues  GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues (ADR-0031)
//	api.RegisterEvents        GET /api/v1/projects/{projectId}/events (SSE)
//	api.RegisterConversations agent profiles, conversations, messages, control,
//	                          cancel, permission decisions and
//	                          GET /api/v1/conversations/{id}/events (SSE)
//	api.RegisterWorkers       GET /api/v1/workers
//	api.RegisterPipelines     pipelines, drafts, revisions, publish,
//	                          validate, schemas (docs/m4-contract.md § 2)
//	api.RegisterRuns          runs, node executions, attempts, assignments,
//	                          run events (SSE)
//	api.RegisterApprovals     approval lists, get, decide
//	api.RegisterScheduler     GET /api/v1/system/scheduler
//	postgres.M4Driver         in-process advancer: api.M4Trigger nudges one
//	                          run, the 2 s tick catches dropped triggers,
//	                          one replica at a time under its own advisory
//	                          lock (docs/m4-contract.md § 5)
//	postgres.Reconciler       turn-lease reconciliation, one replica at a time
//	                          under a Postgres advisory lock (ADR-0016 §4)
//
// No database work happens while building: a replica whose database is briefly
// unreachable still serves health and readiness, and the first request that
// needs the identity provider performs discovery (internal/api/auth).
func serveStack(d serveStackDeps) (http.Handler, func(), error) {
	if d.Pool == nil {
		return nil, nil, errors.New("serve: no database pool")
	}
	if err := d.Auth.Validate(); err != nil {
		return nil, nil, err
	}
	log := d.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	identity := &postgres.IdentityStore{Pool: d.Pool}
	authenticator := auth.New(d.Auth, identity, log)

	projectStore := &postgres.ProjectStore{Pool: d.Pool}
	apiProjects := postgres.APIProjectStore{S: projectStore}
	wakes := postgres.NewEventWake(d.DatabaseURL, log)

	conversationStore := &postgres.CnvStore{Pool: d.Pool}
	apiConversations := postgres.APIConversationStore{S: conversationStore}

	handler := api.New(d.API, d.Readiness, authenticator, d.UI)
	authenticator.Register(handler)
	api.RegisterProjects(handler, apiProjects)
	api.RegisterGitHubIssues(handler, apiProjects, github.New())
	api.RegisterEvents(handler, apiProjects,
		postgres.APIEventStream{S: projectStore, Wakes: wakes})
	api.RegisterConversations(handler, apiConversations, apiConversations,
		postgres.APIConversationStream{S: conversationStore, Journal: projectStore, Wakes: wakes})
	api.RegisterWorkers(handler, postgres.APIWorkerStore{
		R:                 &postgres.WorkerRegistry{Pool: d.Pool},
		HeartbeatInterval: d.WorkerHeartbeat,
	})

	// M3 surfaces (docs/m3-contract.md § 2). The mounts are unconditional and
	// the *capability* is conditional: with no keyring the secret write routes
	// refuse through SecretStore.Keys == nil rather than accepting a rotation
	// the process could never decrypt, and with no artifact bytes mounted the
	// content route answers 503 instead of pretending a row has no bytes.
	secretStore := &postgres.SecretStore{Pool: d.Pool, Keys: d.M3.Keyring}
	api.RegisterSecrets(handler, postgres.APISecretStore{S: secretStore}, apiProjects)

	artifactStore := &postgres.ArtifactStore{Pool: d.Pool}
	apiArtifacts := postgres.APIArtifactStore{S: artifactStore, Denials: projectStore}
	preview := api.PreviewConfig{
		Host:    d.M3.PreviewHost,
		BaseURL: d.M3.PreviewBaseURL,
		TTL:     d.M3.PreviewTTL,
		Bytes:   d.M3.ArtifactBytes,
	}
	if d.M3.PreviewSigner != nil {
		preview.Tokens = d.M3.PreviewSigner
	}
	if d.M3.ArtifactBytes == nil {
		preview.Bytes = nil
	}
	preview.Store = apiArtifacts
	api.RegisterArtifacts(handler, apiArtifacts, d.M3.ArtifactBytes, preview)
	if d.M3.PreviewHost != "" {
		api.RegisterPreview(handler, preview)
	}
	api.RegisterWorkspaces(handler, postgres.APIWorkspaceStore{
		S: &postgres.WorkspaceStore{Pool: d.Pool},
	})

	// M4 surfaces (docs/m4-contract.md § 2, § 5's control-plane duties).
	// The runtime adapter owns every run mutation the routes make (§ 5.1);
	// the driver is the same advance on the other side of each trigger AND
	// the polling reconciler for dropped nudges.
	pipelineStore := &postgres.PipelineStore{Pool: d.Pool}
	definitionService, err := postgres.NewPipelineDefinitions()
	if err != nil {
		return nil, nil, err
	}
	runStore := &postgres.RunStore{Pool: d.Pool}
	m4Children := &postgres.M4Children{Runs: runStore}
	m4Runtime := postgres.NewRuntimeStore(d.Pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: m4Children},
	})
	m4Children.Runtime = m4Runtime // the advancer needs the children; the children, the runtime store
	m4Driver := postgres.NewM4Driver(d.Pool, m4Runtime,
		log.With(slog.String("component", "m4-driver")))
	api.RegisterPipelines(handler, postgres.APIPipelineStore{S: pipelineStore}, definitionService)
	api.RegisterRuns(handler,
		postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
		postgres.APIAssignmentStore{S: pipelineStore},
		apiProjects,
		postgres.APIRunEventStream{Journal: projectStore, Wakes: wakes},
		m4Driver.Trigger)
	api.RegisterApprovals(handler, postgres.APIApprovalStore{R: m4Runtime},
		apiProjects, m4Driver.Trigger)
	api.RegisterScheduler(handler, postgres.APISchedulerStore{Pool: d.Pool})
	api.RegisterSandbox(handler,
		postgres.APITurnSandboxStore{Pool: d.Pool},
		postgres.APISystemSandboxStore{
			Pool:                 d.Pool,
			PinnedBackendVersion: d.M3.PinnedVersion,
			PolicyDigest:         d.M3.PolicyDigest,
		})

	// ADR-0020 D6's other half: on the preview host, nothing except /preview/*
	// exists — no SPA shell, no API. The wrapper goes *outside* the assembled
	// stack so an unauthenticated /api/v1 request carrying the preview Host
	// cannot even reach the auth middleware to learn it is being answered.
	stacked := http.Handler(handler)
	if d.M3.PreviewHost != "" {
		stacked = api.PreviewHostOnly(d.M3.PreviewHost)(stacked)
	}

	// The turn-lease reconciler runs on every replica and does work on one: the
	// advisory lock in postgres.Reconciler decides which (ADR-0016 §4). It is
	// started here rather than in a cron container because the deadlines it
	// enforces are this deployment's, and a replica that cannot take the lock
	// simply skips the tick.
	reconcileCtx, stopReconciler := context.WithCancel(context.Background())
	reconciler := postgres.NewReconciler(d.Pool, postgres.ReconcilerConfig{
		Logger:          log.With(slog.String("component", "reconciler")),
		WorkerHeartbeat: d.WorkerHeartbeat,
	})
	go func() {
		ran, err := reconciler.Run(reconcileCtx)
		if err != nil {
			log.Error("turn-lease reconciler stopped",
				slog.Int("passes", ran), slog.String("error", err.Error()))
			return
		}
		log.Info("turn-lease reconciler stopped", slog.Int("passes", ran))
	}()

	// The M4 driver ticks on every replica and advances on one: the same
	// advisory-lock pattern as the reconciler below, its own lock name.
	driverCtx, stopDriver := context.WithCancel(context.Background())
	go func() {
		if err := m4Driver.Run(driverCtx, 2*time.Second); err != nil {
			log.Error("m4 driver stopped", slog.String("error", err.Error()))
			return
		}
		log.Info("m4 driver stopped")
	}()

	var closeOnce sync.Once
	closeStack := func() {
		closeOnce.Do(func() {
			stopReconciler()
			stopDriver()
			wakes.Close()
		})
	}

	return stacked, closeStack, nil
}

// compile-time proof that the OIDC service is usable as the API's
// Authenticator: "serve uses the auth service" means this assignment, not a
// stub that has to be remembered later.
var _ api.Authenticator = (*auth.Service)(nil)
