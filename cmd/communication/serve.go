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
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/api/auth"
	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/assistant"
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
  COMMUNICATION_PIPELINE_SCHEDULER      "on" (default) | "off" — ADR-0023's
                                        rollback switch for THIS replica. With
                                        "off" the M4 pipeline engine does not
                                        start here: the run/approval routes
                                        carry no advancer trigger and the
                                        driver's backstop tick never runs, so a
                                        run POSTed to this replica stays
                                        "queued" and a replica with the flag on
                                        advances it (docs/m4-contract.md
                                        § 7.1 C14c). Reads, SSE, M2
                                        conversations and M3 surfaces are
                                        untouched. Any other value is a startup
                                        refusal. Scope note: the M4 *attempt
                                        claimer* lives in worker mode
                                        (internal/worker's attempt loop) and is
                                        NOT switched off by this serve-side
                                        variable — a run stays queued because
                                        no replica advances it into claimable
                                        attempts, not because claims were
                                        disabled. Case-insensitive.
  COMMUNICATION_SCHEDULE_TICK           schedule-tick interval (default "30s",
                                        ADR-0032). How often this replica
                                        checks the schedules table for rows
                                        that are due; the tick starts only
                                        when the pipeline engine starts, so
                                        COMMUNICATION_PIPELINE_SCHEDULER=off
                                        also stops it. Must parse as a Go
                                        duration and be positive.
  COMMUNICATION_SESSION_PURGE_INTERVAL  expired-session purge interval
                                        (default "10m", audit F1). How often
                                        this replica deletes expired sessions
                                        and unconsumed OIDC login states —
                                        rows the 12h session TTL and the 10m
                                        state TTL already made dead, so the
                                        tables stop growing forever. "0"
                                        disables the tick (only defensible
                                        when something else purges). Every
                                        replica may run it: the deletes are
                                        idempotent, see
                                        IdentityStore.PurgeExpired. Failures
                                        are logged, never fatal. Must parse
                                        as a Go duration; negative or
                                        unparseable is a startup refusal.
  COMMUNICATION_SERVER_READ_TIMEOUT     http.Server ReadTimeout: deadline to
                                        read one request INCLUDING its body
                                        (default "60s", audit F3). Safe for
                                        SSE: it never bounds the response
                                        write side, and a stream's GET has no
                                        body to drip. Positive Go duration;
                                        anything else is a startup refusal.
  COMMUNICATION_SERVER_IDLE_TIMEOUT     http.Server IdleTimeout: how long a
                                        keep-alive connection may sit between
                                        requests (default "120s", audit F3).
                                        Before this knob existed it fell back
                                        to the 10s ReadHeaderTimeout. Positive
                                        Go duration; anything else is a
                                        startup refusal. WriteTimeout stays
                                        unset on purpose — it would kill SSE
                                        streams (see newServeServer).
  COMMUNICATION_CATCHUP_GEN_COOLDOWN    ADR-0078 catch-up tour generator's
                                        per-RUN floor between two model
                                        attempts (default "10m"). How long a
                                        finished run must sit before opening
                                        the page asks the model about it
                                        again. A Go duration; 0, a negative
                                        value and unparseable text all fall
                                        back to the default rather than
                                        refusing startup — this knob protects
                                        a model from a page-load storm, and a
                                        typo in it costs a slower retry, not
                                        a wrong answer.
  COMMUNICATION_CATCHUP_GEN_PER_10M     ADR-0078 catch-up tour generator's
                                        VISIT budget: at most this many
                                        generation model calls per ten
                                        minutes from the replica's person-
                                        triggered passes (default "6"). The
                                        per-run cooldown guards one run; this
                                        guards the model gateway from the
                                        whole replica — a lab full of page
                                        loads spent its rate limit and 429'd
                                        the assistant and the agents. "0"
                                        disables catch-up generation
                                        entirely. A whole number; negative
                                        and unparseable text fall back to the
                                        default rather than refusing startup,
                                        the same hammer-guard rule as above.
  COMMUNICATION_CATCHUP_SWEEP_PER_10M   ADR-0078 § Trigger: the completion
                                        sweep's OWN per-replica model-call
                                        budget, separate from
                                        COMMUNICATION_CATCHUP_GEN_PER_10M so
                                        background sweeping can never starve
                                        a person opening Catch up (the lab's
                                        shared purse let a sweep spend the
                                        gateway's whole rate limit and push a
                                        live assistant turn past its bound).
                                        Default "3" per ten minutes; "0"
                                        disables the sweep's model calls while
                                        the visit trigger keeps generating (a
                                        visit budget of 0 is the knob that
                                        means "generate nothing at all").
                                        Negative and unparseable fall back to
                                        the default, never a startup refusal —
                                        the same hammer-guard rule as above.
  COMMUNICATION_CATCHUP_GEN_SWEEP       ADR-0078 § Trigger: how often this
                                        replica's completion sweep looks for
                                        runs that finished without anybody
                                        opening the Catch up page (default
                                        "2m"; TASK T13 — "when a run finishes,
                                        write its tour", not only when a
                                        person asks). One goroutine per
                                        replica; the sweep spends its OWN
                                        COMMUNICATION_CATCHUP_SWEEP_PER_10M
                                        budget and the SAME per-run cooldown
                                        as a visit pass, and the tour write
                                        is idempotent on the run claim, so two
                                        replicas sweeping the same beat tell
                                        the story once. "0" disables the sweep
                                        (the visit trigger keeps working).
                                        Negative and unparseable fall back to
                                        the default, never a startup refusal —
                                        the family rule of the two knobs
                                        above.
  COMMUNICATION_OIDC_ISSUER             required UNLESS
                                        COMMUNICATION_OIDC_PROVIDERS_FILE names
                                        a list; issuer used for discovery/tokens
  COMMUNICATION_OIDC_BROWSER_ISSUER     issuer prefix browsers are redirected to
  COMMUNICATION_OIDC_CLIENT_ID          required UNLESS
                                        COMMUNICATION_OIDC_PROVIDERS_FILE names
                                        a list; OAuth2 client id
  COMMUNICATION_OIDC_CLIENT_SECRET      optional; empty means public + PKCE
  COMMUNICATION_OIDC_PROVIDERS_FILE     optional path (ADR-0083) to a YAML list
                                        of identity providers — tsidp, Entra ID
                                        and generic side by side, each with its
                                        own client_secret_file. When it is set,
                                        the sign-in page offers one button per
                                        provider, and the three variables above
                                        stop being required. An Entra provider
                                        with no allowed_tenants, a client secret
                                        written in the file itself, or a
                                        duplicate provider id is a startup
                                        refusal. The file is read once, at boot.
  COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS  OIDC subjects that become org admins;
                                        with a provider list, the
                                        provider:subject form also works
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

  COMMUNICATION_ASSISTANT_BASE_URL      OpenAI-compatible server root for the
                                        in-app assistant (ADR-0034). UNSET means
                                        the assistant is absent: POST
                                        /api/v1/assistant/ask answers 503
                                        assistant_not_configured and the palette
                                        stays jump-only. NOTE: setting it makes
                                        THIS replica egress app content to a third
                                        party (the question, the route on screen
                                        and the caller-visible rows a read tool
                                        returns); an operator who must not let
                                        content leave the host leaves it unset.
                                        Must be an http(s) root with no credentials,
                                        query or fragment — anything else is a
                                        startup refusal.
  COMMUNICATION_ASSISTANT_API_KEY       /…_API_KEY_FILE
                                        bearer token for that endpoint. Never
                                        logged, never placed in a prompt; the _FILE
                                        form is trimmed of trailing whitespace.
  COMMUNICATION_ASSISTANT_MODEL         model name to send (default
                                        "qwen3-8-27b", ADR-0034).
  COMMUNICATION_ASSISTANT_TIMEOUT       per-model-call deadline for the
                                        assistant (Go duration, e.g. "120s";
                                        default 30s). The assistant's tool
                                        loop calls the model several times
                                        per turn, and a reasoning model under
                                        load can take longer than 30s on a
                                        single call. There is no separate
                                        turn-level deadline: a turn is bounded
                                        by per-call timeout x model calls, so
                                        raising this lengthens a slow turn
                                        instead of racing it. Unparseable or
                                        non-positive is a startup refusal.
  COMMUNICATION_DECISION_BASE_URL       OpenAI-compatible server root for the
                                        assistant's decision model (ADR-0079):
                                        the judge the "Ask when it looks risky"
                                        trust level consults before every tool
                                        call. UNSET (or no _MODEL) means there is
                                        no judge: the fixed ADR-0050 class table
                                        decides, which asks MORE, never less, and
                                        the setup checklist reports "No decision
                                        model". Like the chat model, setting it
                                        egresses bounded tool arguments to a third
                                        party; must be an http(s) root with no
                                        credentials, query or fragment — a
                                        malformed one is reported as "no judge"
                                        on the status row rather than refusing to
                                        boot, because the gate falls back to the
                                        table either way.
  COMMUNICATION_DECISION_API_KEY        /…_API_KEY_FILE
                                        bearer token for the judge. Never logged,
                                        never placed in a prompt; the _FILE form
                                        is trimmed of trailing whitespace.
  COMMUNICATION_DECISION_MODEL          model name the judge sends (required
                                        with the base URL for the judge to count
                                        as configured).
  COMMUNICATION_DECISION_TIMEOUT        per-decision deadline (Go duration, e.g.
                                        "2s"; default 4s). A judge that is slow
                                        is a judge that is DOWN: a draft edit or
                                        risky call waits for the human rather
                                        than stalling the turn, and a read runs.
                                        Unparseable or non-positive is a startup
                                        refusal, like the assistant's timeout.
  COMMUNICATION_SPEECH_BASE_URL         OpenAI-compatible server root for
                                        server-side dictation (ADR-0080). UNSET
                                        (or no model) means the feature is
                                        absent: POST /api/v1/assistant/transcriptions
                                        answers 503 speech_not_configured and the
                                        mic falls back to the browser's own speech
                                        service. NOTE: pressing the mic makes this
                                        replica send that recording to this
                                        endpoint; audio is never stored, logged or
                                        written to disk.
  COMMUNICATION_SPEECH_API_KEY          /…_API_KEY_FILE
                                        bearer token for the speech endpoint
                                        (optional — an endpoint with no token
                                        needs neither). Never logged; the _FILE
                                        form is trimmed of trailing whitespace.
  COMMUNICATION_SPEECH_MODEL            model name forwarded as the form field
                                        "model" (e.g. "qwen3-asr-1-7b"). Base URL
                                        and model together are what count as
                                        configured.
                                        (e.g. "qwen3-asr-1-7b"). Base URL and
                                        model together are what count as
                                        configured.
  COMMUNICATION_RATE_AUTH_PER_MIN       sustained /auth/login + /auth/callback
                                        requests per minute per client IP
                                        (default 10; 0 disables the limit,
                                        ADR-0077).
  COMMUNICATION_RATE_AUTH_BURST         burst capacity for that bucket
                                        (default 20).
  COMMUNICATION_RATE_ASSISTANT_PER_MIN  sustained assistant turns / messages
                                        per minute per principal (default 30;
                                        0 disables, ADR-0077).
  COMMUNICATION_RATE_ASSISTANT_BURST    burst capacity for that bucket
                                        (default 10).
  COMMUNICATION_RATE_ISSUES_PER_MIN     sustained GitHub issue reads per
                                        minute per principal (default 60;
                                        0 disables, ADR-0077).
  COMMUNICATION_RATE_ISSUES_BURST       burst capacity for that bucket
                                        (default 30).
  COMMUNICATION_RATE_MAX_STREAMS        max concurrent SSE streams per
                                        principal (default 16; 0 disables,
                                        ADR-0077).
  COMMUNICATION_TRUSTED_PROXY_HOPS      0 (default) means the client address
                                        is always the peer address and
                                        X-Forwarded-For is ignored. Set to the
                                        exact number of trusted proxies in
                                        front (e.g. 1 behind one LB) to key
                                        the auth throttle on the first
                                        X-Forwarded-For hop instead — larger
                                        than reality is forgeable, smaller
                                        mislabels the peer (ADR-0077).
                                        Non-negative integers only; anything
                                        else is a startup refusal.

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

// Audit F3's two additional http.Server deadlines and audit F1's purge
// cadence, with the defaults the audit recommends.
const (
	envServerReadTimeout     = "COMMUNICATION_SERVER_READ_TIMEOUT"
	envServerIdleTimeout     = "COMMUNICATION_SERVER_IDLE_TIMEOUT"
	defaultServerReadTimeout = 60 * time.Second
	defaultServerIdleTimeout = 120 * time.Second

	envSessionPurgeInterval     = "COMMUNICATION_SESSION_PURGE_INTERVAL"
	defaultSessionPurgeInterval = 10 * time.Minute

	// envCatchUpGenCooldown overrides the catch-up tour generator's per-RUN
	// cooldown (assistant.CatchUpGenCooldown, ten minutes). Unlike the serve
	// ticks above, a value this process cannot read is NOT a startup refusal:
	// the cooldown is a hammer-guard, not a correctness contract, so 0, a
	// negative number and unparseable text all fall back to the default.
	envCatchUpGenCooldown = "COMMUNICATION_CATCHUP_GEN_COOLDOWN"

	// envCatchUpGenPer10M is the catch-up generator's VISIT-trigger cap on
	// generation model calls per assistant.CatchUpGenModelCallWindow
	// (ten minutes). Same never-refuse rule as the cooldown: it is a
	// hammer-guard. Unset, negative or unparseable fall back to the shipped
	// default (assistant.CatchUpGenMaxModelCallsPerWindow); 0 is the one
	// reading that means something, and it means "generate nothing".
	envCatchUpGenPer10M = "COMMUNICATION_CATCHUP_GEN_PER_10M"

	// envCatchUpSweepPer10M is the completion sweep's OWN per-replica
	// model-call budget, deliberately separate from the visit cap: the lab's
	// acceptance 42570366079 watched one shared purse let the sweep spend the
	// gateway's whole rate limit and push a live assistant turn past its
	// bound, so background sweeping now draws its own smaller allowance and a
	// person opening Catch up is never starved by the backlog. Same
	// never-refuse hammer-guard rule; 0 means "no background generation",
	// which is NOT the same as the visit knob's 0 ("no generation at all").
	envCatchUpSweepPer10M = "COMMUNICATION_CATCHUP_SWEEP_PER_10M"

	// envCatchUpGenSweep is how often the serve-side completion sweep tick
	// looks for terminal runs that were never told (ADR-0078 § Trigger).
	// defaultCatchUpGenSweep is its shipped cadence; 0 is the one literal that
	// means something besides a cadence — "no sweep, the visit trigger only".
	envCatchUpGenSweep      = "COMMUNICATION_CATCHUP_GEN_SWEEP"
	defaultCatchUpGenSweepT = 2 * time.Minute
)

// serveServerTimeout parses one of the http.Server deadline variables with
// the same rule as every other serve duration: unset is the default, an
// unparseable or non-positive value is a startup refusal naming the
// variable, never a silent fallback — an operator who typed a timeout wrong
// means to change the timeout.
func serveServerTimeout(getenv func(string) string, name string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s %q is not a duration: %w", name, raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s must be positive, got %s", name, d)
	}
	return d, nil
}

// serveSessionPurgeInterval reads COMMUNICATION_SESSION_PURGE_INTERVAL
// (audit F1). Unlike the other serve durations, 0 is legal and means
// "disable the purge tick" — an operator who purges from cron or another
// process must be able to turn the in-process loop off without inventing a
// huge interval. Negative and unparseable remain startup refusals.
func serveSessionPurgeInterval(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(envSessionPurgeInterval))
	if raw == "" {
		return defaultSessionPurgeInterval, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s %q is not a duration: %w", envSessionPurgeInterval, raw, err)
	}
	if d < 0 {
		return 0, fmt.Errorf("%s must be positive, or 0 to disable, got %s", envSessionPurgeInterval, d)
	}
	return d, nil
}

// serveCatchUpGenCooldown reads COMMUNICATION_CATCHUP_GEN_COOLDOWN for the
// catch-up tour generator wired below. Unset, 0, negative or unparseable is
// the generator's own default (ten minutes): the knob exists so a lab that
// runs a real model can retry a failed generation inside a test's bounded
// wait, and a deployment that typos it keeps the shipped guard rather than
// refusing to start — the worst outcome of a mistyped hammer-guard is a
// slower retry, never a wrong answer.
func serveCatchUpGenCooldown(getenv func(string) string) time.Duration {
	raw := strings.TrimSpace(getenv(envCatchUpGenCooldown))
	if raw == "" {
		return assistant.CatchUpGenCooldown
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return assistant.CatchUpGenCooldown
	}
	return d
}

// serveCatchUpGenPer10M reads COMMUNICATION_CATCHUP_GEN_PER_10M for the
// catch-up generator's VISIT budget above. Unset, negative or unparseable is
// the generator's own default (six calls per ten minutes); "0" is the
// deliberate off switch — a deployment that wants tours from no model says so
// with zero, not with a typo. Never a startup refusal, the
// cooldown's own rule: the worst outcome of a mistyped hammer-guard is the
// shipped guard, never a wrong answer.
func serveCatchUpGenPer10M(getenv func(string) string) int {
	raw := strings.TrimSpace(getenv(envCatchUpGenPer10M))
	if raw == "" {
		return assistant.CatchUpGenMaxModelCallsPerWindow
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return assistant.CatchUpGenMaxModelCallsPerWindow
	}
	return n
}

// serveCatchUpSweepPer10M reads COMMUNICATION_CATCHUP_SWEEP_PER_10M for the
// completion sweep's OWN per-replica budget. The family rule of every other
// catch-up knob: unset, negative or unparseable is the generator's own default
// (assistant.CatchUpGenMaxSweepCallsPerWindow — three per ten minutes); "0"
// is the deliberate off switch for BACKGROUND generation only — the visit
// trigger keeps its own budget and keeps generating. Never a startup refusal.
func serveCatchUpSweepPer10M(getenv func(string) string) int {
	raw := strings.TrimSpace(getenv(envCatchUpSweepPer10M))
	if raw == "" {
		return assistant.CatchUpGenMaxSweepCallsPerWindow
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return assistant.CatchUpGenMaxSweepCallsPerWindow
	}
	return n
}

// serveCatchUpGenSweep reads COMMUNICATION_CATCHUP_GEN_SWEEP: how often this
// replica's completion sweep runs (ADR-0078 § Trigger). The family rule of
// the other two catch-up knobs — unset, negative and unparseable fall back to
// the 2m default, never a startup refusal — with the one deliberate
// exception the purge tick also honours: 0 means "do not start the tick", the
// deployment keeping the visit trigger alone. A mistyped cadence costs a
// slower tour at worst, which is not a reason to refuse to serve.
func serveCatchUpGenSweep(getenv func(string) string) time.Duration {
	raw := strings.TrimSpace(getenv(envCatchUpGenSweep))
	if raw == "" {
		return defaultCatchUpGenSweepT
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return defaultCatchUpGenSweepT
	}
	return d // 0 is the honest "no sweep"
}

// catchUpPatchSource wires the tour generator's diff reader (ADR-0078
// § Patch artifacts) onto the artifact list and byte backend the API routes
// already serve. It is one call wide so the wiring itself is testable: a
// deployment with an artifact byte backend gets a non-nil source, and one
// without gets nil — the builder's own rule that an absent source means tours
// without diff excerpts, never invented hunks.
func catchUpPatchSource(store postgres.APIArtifactStore, bytes artifacts.Store) api.CatchUpPatchSource {
	return api.NewCatchUpPatchSource(store, bytes)
}

// newServeServer builds the process's http.Server. ReadTimeout bounds only
// reading a request (headers + body), which is safe for SSE: the long-lived
// part of a stream is the response, and a stream GET finishes reading its
// (empty) body at once. IdleTimeout now bounds keep-alive connections
// explicitly instead of inheriting Go's ReadHeaderTimeout fallback. WriteTimeout
// is deliberately NOT set: it applies to the whole response write, so a
// global value would kill every SSE stream that outlives it (audit F3 names
// http.ResponseController.SetWriteDeadline inside the streaming handlers as
// the place for per-response write deadlines; none is set here).
func newServeServer(handler http.Handler, onShutdown func(), readTimeout, idleTimeout time.Duration) *http.Server {
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		// WriteTimeout intentionally absent — see above.
	}
	srv.RegisterOnShutdown(onShutdown)
	return srv
}

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
	pipelineSchedulerOff, err := servePipelineScheduler(os.Getenv)
	if err != nil {
		// A typo in ADR-0023's rollback switch must not decide the deployment's
		// behaviour by accident: refuse to start and name the variable.
		fmt.Fprintln(stderr, err)
		return 2
	}
	scheduleTick, err := serveScheduleTick(os.Getenv)
	if err != nil {
		// A tick cadence the process cannot parse must be a startup refusal,
		// not a silent fallback to the default: the operator chose it.
		fmt.Fprintln(stderr, err)
		return 2
	}
	issueTriggerTick, err := serveIssueTriggerTick(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	sessionPurge, err := serveSessionPurgeInterval(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	readTimeout, err := serveServerTimeout(os.Getenv, envServerReadTimeout, defaultServerReadTimeout)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	idleTimeout, err := serveServerTimeout(os.Getenv, envServerIdleTimeout, defaultServerIdleTimeout)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	assistantCfg, err := serveAssistantConfig(os.Getenv)
	if err != nil {
		// ADR-0034 gives serve a new egress site, so the endpoint it points at is
		// validated at startup with the worker's own rules: an operator who typed
		// an unusable URL meant to configure egress, and silently running with no
		// assistant would hide that. An unset base URL is not an error — it is the
		// feature being absent.
		fmt.Fprintln(stderr, err)
		return 2
	}
	decisionCfg, err := serveDecisionConfig(os.Getenv)
	if err != nil {
		// ADR-0079's judge is a second egress site, so the one thing an
		// operator can get wrong that would silently change what humans are
		// asked about — how long they wait — is refused at startup with the
		// assistant's own rule. An unusable BASE_URL is not: it means no judge.
		fmt.Fprintln(stderr, err)
		return 2
	}
	// The catch-up generator's per-run cooldown: never a startup refusal, so
	// there is no error to handle here (see serveCatchUpGenCooldown). Its
	// per-replica global cap follows the same rule (see serveCatchUpGenPer10M),
	// and so does the completion sweep's own budget (see
	// serveCatchUpSweepPer10M).
	catchUpGenCooldown := serveCatchUpGenCooldown(os.Getenv)
	catchUpGenPer10M := serveCatchUpGenPer10M(os.Getenv)
	catchUpSweepPer10M := serveCatchUpSweepPer10M(os.Getenv)
	catchUpGenSweep := serveCatchUpGenSweep(os.Getenv)
	rateLimits, err := serveRateLimits(os.Getenv)
	if err != nil {
		// A throttle the process cannot parse must be a startup refusal, not a
		// silently unthrottled replica (same rule as every other serve knob).
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

	// Audit F6: file:// git URLs are a server-wide opt-in (see
	// api.AllowFileGitURLsFromEnv); an unparseable value refuses startup.
	allowFileGitURLs, allowFileGitErr := api.AllowFileGitURLsFromEnv(os.Getenv)
	if allowFileGitErr != nil {
		fmt.Fprintln(stderr, allowFileGitErr)
		return 2
	}
	handler, closeStack, err := serveStack(serveStackDeps{
		Pool:                 pool,
		DatabaseURL:          databaseURL,
		Auth:                 authCfg,
		WorkerHeartbeat:      workerHeartbeat,
		PipelineSchedulerOff: pipelineSchedulerOff,
		ScheduleTick:         scheduleTick,
		IssueTriggerTick:     issueTriggerTick,
		SessionPurgeInterval: sessionPurge,
		CatchUpGenCooldown:   catchUpGenCooldown,
		CatchUpGenPer10M:     &catchUpGenPer10M,
		CatchUpSweepPer10M:   &catchUpSweepPer10M,
		CatchUpGenSweep:      catchUpGenSweep,
		API: api.Config{
			ReplicaName:      replica,
			Version:          version,
			PublicURL:        publicURL,
			Logger:           log,
			AllowFileGitURLs: allowFileGitURLs,
			Limits:           rateLimits,
		},
		Readiness:       dbReadiness{pool: pool, url: databaseURL},
		UI:              webUI,
		Logger:          log,
		M3:              m3,
		Assistant:       assistantCfg,
		AssistantStatus: serveAssistantStatusConfig(os.Getenv),
		WorkerChat:      api.WorkerChatConfigFromEnv(os.Getenv),
		Decision:        decisionCfg,
		Speech:          serveSpeechConfig(os.Getenv),
	})
	if err != nil {
		stop()
		log.Error("server configuration failed", slog.String("error", err.Error()))
		return 2
	}
	defer closeStack()

	srv := newServeServer(handler, closeStack, readTimeout, idleTimeout)
	// A graceful shutdown must not wait on SSE streams that only end when their
	// client leaves: closing the wake-up source ends every open stream, which is
	// also how a restarting replica hands its browsers to another replica (they
	// reconnect with Last-Event-ID and lose nothing).

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

	// PipelineSchedulerOff is COMMUNICATION_PIPELINE_SCHEDULER=off resolved
	// (servePipelineScheduler). With it set this replica runs no M4 engine: no
	// advancer trigger on the run/approval routes and no driver backstop tick,
	// so writes still land and reads still serve while the run stays 'queued'
	// for another replica (ADR-0023 Migration/rollback, contract § 7.1 C14c).
	// Worker mode's attempt claim loop is a different process and unaffected.
	PipelineSchedulerOff bool

	// m4DriverRunner overrides the M4 driver loop; nil means production's
	// driver.Run at the 2 s tick. It exists so a test can observe whether the
	// stack started the advancer at all without a database to advance against.
	m4DriverRunner func(ctx context.Context) error

	// ScheduleTick is COMMUNICATION_SCHEDULE_TICK resolved
	// (serveScheduleTick): how often the ADR-0032 schedule ticker checks for
	// due rows. Zero means the 30 s default.
	ScheduleTick time.Duration

	// IssueTriggerTick is COMMUNICATION_ISSUE_TRIGGER_TICK resolved
	// (serveIssueTriggerTick): how often the ADR-0056 part-2 issue-trigger
	// poll tick fires due triggers. Zero means the 60 s default.
	IssueTriggerTick time.Duration

	// issueTriggerTickRunner overrides the issue-trigger ticker loop; nil
	// means production's runIssueTriggerTicker over a postgres.IssueTriggerStore.
	issueTriggerTickRunner func(ctx context.Context) error

	// Assistant is the resolved COMMUNICATION_ASSISTANT_* egress triple
	// (serveAssistantConfig). The zero value keeps the feature absent: the ask
	// route answers 503 assistant_not_configured and the palette stays jump-only
	// (ADR-0034 Migration/rollback: unset = feature absent).
	Assistant serveAssistant

	// AssistantStatus is the resolved second/third model endpoint config
	// (COMMUNICATION_SPEECH_BASE_URL/_MODEL/_API_KEY[_FILE] and
	// COMMUNICATION_DECISION_BASE_URL/_MODEL) that the assistant's §2 setup
	// checklist reports. It is a plain config hand-off, not a client: nothing
	// here calls those endpoints, and the speech key is only ever read to
	// answer "is a key set". A distinct name from the assistant's own triple
	// on purpose — one process's endpoint must not silently become
	// another's (serveAssistantConfig's rule, applied verbatim).
	AssistantStatus api.AssistantStatusModels

	// Speech is the resolved COMMUNICATION_SPEECH_* triple
	// (serveSpeechConfig): ADR-0080's transcription egress, which
	// POST /api/v1/assistant/transcriptions forwards recordings to. The zero
	// value keeps the feature absent: the route answers 503
	// speech_not_configured and the mic falls back to the browser (ADR-0080
	// Migration/rollback: unset = browser speech only).
	Speech api.SpeechConfig

	// Decision is the resolved COMMUNICATION_DECISION_* quad
	// (serveDecisionConfig): ADR-0079's decision model, the judge the
	// "ask when it looks risky" trust level consults before every assistant
	// tool call. The zero value means no judge: ADR-0050's fixed class table
	// decides, the setup checklist reports "No decision model", and
	// unsetting these variables returns every caller to the table
	// (ADR-0079 Migration/rollback).
	Decision serveDecision

	// WorkerChat is the resolved COMMUNICATION_MODEL_CHAT_* triple as THIS
	// process sees it (api.WorkerChatConfigFromEnv), for the ops overview's
	// fourth model row. The serve pod normally carries none of those variables
	// — the worker owns that egress — and then the row reads
	// `configured: false, key_set: null`, which the page says "set on the
	// worker". It is a config hand-off, not a client: nothing here opens a
	// connection, and the key is only ever read to answer "is one set".
	WorkerChat api.WorkerChatConfig

	// scheduleTickRunner overrides the schedule ticker loop; nil means
	// production's runScheduleTicker over a postgres.ScheduleStore. Like
	// m4DriverRunner, it exists so a test can observe whether the stack
	// started the ticker at all without a database to tick against.
	scheduleTickRunner func(ctx context.Context) error

	// SessionPurgeInterval is COMMUNICATION_SESSION_PURGE_INTERVAL resolved
	// (serveSessionPurgeInterval): how often this replica deletes expired
	// sessions and unconsumed login states (audit F1). Unlike ScheduleTick,
	// zero HERE means "do not start the tick": runServe resolves the 10 min
	// default before building the stack, so the zero value that every stack
	// test carries is an explicit off, not a surprise 10-minute timer on an
	// unreachable pool.
	SessionPurgeInterval time.Duration

	// sessionPurgeRunner overrides the purge ticker loop; nil means
	// production's runSessionPurger over the stack's own IdentityStore.
	sessionPurgeRunner func(ctx context.Context) error

	// CatchUpGenCooldown is COMMUNICATION_CATCHUP_GEN_COOLDOWN resolved
	// (serveCatchUpGenCooldown): the ADR-0078 tour generator's per-RUN floor
	// between two model attempts. Zero means the generator's own default (ten
	// minutes), so every stack test that never names the variable keeps the
	// shipped cadence; the lab shortens it to retry a failed generation inside
	// one acceptance run's bounded wait.
	CatchUpGenCooldown time.Duration

	// CatchUpGenPer10M is COMMUNICATION_CATCHUP_GEN_PER_10M resolved
	// (serveCatchUpGenPer10M): the ADR-0078 tour generator's VISIT-trigger cap
	// on generation model calls per ten minutes. A pointer so the zero-value
	// stack every existing test carries means "nobody said
	// anything" (the generator's own default of six), while an explicit 0 —
	// which runServe resolves — means "generate nothing at all".
	CatchUpGenPer10M *int

	// CatchUpSweepPer10M is COMMUNICATION_CATCHUP_SWEEP_PER_10M resolved
	// (serveCatchUpSweepPer10M): the completion sweep's OWN per-replica
	// model-call budget, independent of the visit cap above — the sweep
	// exhausting it never starves a Catch up visit, and vice versa. A pointer
	// for the same reason: the zero-value stack means "nobody said anything"
	// (the sweep's own default of three), an explicit 0 means "no background
	// generation".
	CatchUpSweepPer10M *int

	// CatchUpGenSweep is COMMUNICATION_CATCHUP_GEN_SWEEP resolved
	// (serveCatchUpGenSweep): how often this replica's completion sweep tells
	// the runs that finished untoured (ADR-0078 § Trigger). Like
	// SessionPurgeInterval, zero HERE means "do not start the tick" — runServe
	// resolves the 2m default before building the stack, so the zero value
	// every stack test carries is an explicit off, not a surprise timer on an
	// unreachable pool.
	CatchUpGenSweep time.Duration

	// catchUpGenSweepRunner overrides the completion-sweep tick loop; nil
	// means production's runCatchUpGenSweeper over the built generator. It
	// exists so a test can observe whether the stack started the sweep at all
	// without a database or a model to sweep against.
	catchUpGenSweepRunner func(ctx context.Context) error
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

// envPipelineScheduler is ADR-0023 Migration/rollback's feature flag: the M4
// engine is configuration, never a schema revert.
const envPipelineScheduler = "COMMUNICATION_PIPELINE_SCHEDULER"

// servePipelineScheduler reads COMMUNICATION_PIPELINE_SCHEDULER. Empty or "on"
// means the engine runs on this replica (a fresh install's default);
// "off" is ADR-0023's rollback arm. Anything else is a startup refusal rather
// than a silent fallback: an operator who typos the rollback switch and gets a
// replica that quietly kept advancing runs would learn about it from the
// database, not from the log (same rule as COMMUNICATION_WORKER_HEARTBEAT).
func servePipelineScheduler(getenv func(string) string) (off bool, err error) {
	raw := strings.TrimSpace(getenv(envPipelineScheduler))
	switch strings.ToLower(raw) {
	case "", "on":
		return false, nil
	case "off":
		return true, nil
	default:
		return false, fmt.Errorf("%s %q is not \"on\" or \"off\"", envPipelineScheduler, raw)
	}
}

// startPipelineDriver is the whole decision the flag makes on a serve replica:
// does the in-process M4 advancer run here? One function so the routes' trigger
// and the driver's ticker can never disagree about the answer, and so both arms
// are assertable without a database.
func startPipelineDriver(schedulerOff bool) bool { return !schedulerOff }

// envScheduleTick and serveScheduleTick are ADR-0032's tick cadence: a
// duration, defaulted, and refused when unparseable or non-positive for the
// same reason COMMUNICATION_WORKER_HEARTBEAT is — a scheduler whose operator
// typo silently changed its cadence is discovered from missed (or doubled)
// fires, which is the worst place to learn it.
const envScheduleTick = "COMMUNICATION_SCHEDULE_TICK"

// defaultScheduleTick is ADR-0032's cadence: minute-granular cron firing a
// 30 s late is invisible; a 30 s tick keeps at most two replicas' claims
// from racing on the same due row for long.
const defaultScheduleTick = 30 * time.Second

func serveScheduleTick(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(envScheduleTick))
	if raw == "" {
		return defaultScheduleTick, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s %q is not a duration: %w", envScheduleTick, raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s must be positive, got %s", envScheduleTick, d)
	}
	return d, nil
}

// envIssueTriggerTick and serveIssueTriggerTick are ADR-0056 part 2's tick
// cadence: how often the issue-trigger poll pass fires due triggers. The
// default is the ADR's own 60 s, the same minute-granularity family the schedule
// tick sits in; a tick cadence the process cannot parse is a startup refusal,
// not a silent fallback to the default — an operator who typed it wrong must
// not quietly change the poll's cadence.
const envIssueTriggerTick = "COMMUNICATION_ISSUE_TRIGGER_TICK"

// defaultIssueTriggerTick is ADR-0056 part 2's poll cadence: a trigger whose
// cursor is NULL or older than this is due.
const defaultIssueTriggerTick = 60 * time.Second

func serveIssueTriggerTick(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(envIssueTriggerTick))
	if raw == "" {
		return defaultIssueTriggerTick, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s %q is not a duration: %w", envIssueTriggerTick, raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s must be positive, got %s", envIssueTriggerTick, d)
	}
	return d, nil
}

// serveRateLimits resolves the ADR-0077 throttle family (audit F1/F2):
// COMMUNICATION_RATE_* plus COMMUNICATION_TRUSTED_PROXY_HOPS. A value of 0
// disables that specific limit (the lab sets them all to 0 so the e2e suites,
// which drive these routes hard from one IP and one principal, never see a
// 429). Anything unparseable or negative is a startup refusal: a limiter the
// operator mistyped is exactly the kind of knob that must not silently fall
// back to a different number.
func serveRateLimits(getenv func(string) string) (api.RateLimits, error) {
	out := api.RateLimits{
		Auth:      api.LimitSpec{PerMinute: 10, Burst: 20},
		Assistant: api.LimitSpec{PerMinute: 30, Burst: 10},
		Issues:    api.LimitSpec{PerMinute: 60, Burst: 30},
	}
	out.MaxStreamsPerPrincipal = 16
	read := func(name string, dst *int) error {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			return nil
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			return fmt.Errorf("%s %q is not a non-negative integer", name, raw)
		}
		*dst = v
		return nil
	}
	for _, target := range []struct {
		name string
		dst  *int
	}{
		{"COMMUNICATION_RATE_AUTH_PER_MIN", &out.Auth.PerMinute},
		{"COMMUNICATION_RATE_AUTH_BURST", &out.Auth.Burst},
		{"COMMUNICATION_RATE_ASSISTANT_PER_MIN", &out.Assistant.PerMinute},
		{"COMMUNICATION_RATE_ASSISTANT_BURST", &out.Assistant.Burst},
		{"COMMUNICATION_RATE_ISSUES_PER_MIN", &out.Issues.PerMinute},
		{"COMMUNICATION_RATE_ISSUES_BURST", &out.Issues.Burst},
		{"COMMUNICATION_RATE_MAX_STREAMS", &out.MaxStreamsPerPrincipal},
		{"COMMUNICATION_TRUSTED_PROXY_HOPS", &out.TrustedProxyHops},
	} {
		if err := read(target.name, target.dst); err != nil {
			return out, err
		}
	}
	return out, nil
}

// envAssistantTimeout is the per-model-call deadline for the assistant's
// egress (the broker's Config.Timeout, defaulting to assistant.DefaultTimeout
// when left zero). It is per CALL, not per turn: the ADR-0050 conversation
// runner and the ask route share one broker and there is no turn-level
// deadline above them, so a multi-step turn simply takes up to
// timeout x model-calls rather than racing a shorter envelope.
const envAssistantTimeout = "COMMUNICATION_ASSISTANT_TIMEOUT"

// serveAssistant is the parsed COMMUNICATION_ASSISTANT_* triple (ADR-0034).
// Separate names from the worker's COMMUNICATION_MODEL_CHAT_* on purpose: one
// process's endpoint and cost budget must not silently become another's.
type serveAssistant struct {
	BaseURL string
	APIKey  string
	Model   string
	// Timeout is the per-model-call deadline; zero means the broker's
	// assistant.DefaultTimeout applies.
	Timeout time.Duration
}

// serveAssistantConfig resolves the assistant's egress. An unset base URL is
// not a failure — it is the honest absence, and the ask route says so. A set but
// malformed one is a startup refusal, with the worker's rules applied verbatim
// (http(s) root, no credentials in the URL). The key is read from
// COMMUNICATION_ASSISTANT_API_KEY or its _FILE and is never logged: no line here
// prints it, and the broker only ever puts it in a request header.
func serveAssistantConfig(getenv func(string) string) (serveAssistant, error) {
	var out serveAssistant
	if raw := strings.TrimSpace(getenv("COMMUNICATION_ASSISTANT_MODEL")); raw != "" {
		out.Model = raw
	} else {
		out.Model = assistant.DefaultModel
	}
	out.BaseURL = strings.TrimRight(strings.TrimSpace(getenv("COMMUNICATION_ASSISTANT_BASE_URL")), "/")
	if raw := strings.TrimSpace(getenv(envAssistantTimeout)); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return out, fmt.Errorf("%s %q is not a duration: %w", envAssistantTimeout, raw, err)
		}
		if d <= 0 {
			return out, fmt.Errorf("%s must be positive, got %s", envAssistantTimeout, d)
		}
		out.Timeout = d
	}
	out.APIKey = strings.TrimSpace(getenv("COMMUNICATION_ASSISTANT_API_KEY"))
	if file := strings.TrimSpace(getenv("COMMUNICATION_ASSISTANT_API_KEY_FILE")); out.APIKey == "" && file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return out, fmt.Errorf("COMMUNICATION_ASSISTANT_API_KEY_FILE %q is unreadable: %v", file, err)
		}
		out.APIKey = string(trimSecret(raw))
	}
	if err := (assistant.Config{BaseURL: out.BaseURL}).Validate(); err != nil {
		return out, err
	}
	return out, nil
}

// serveAssistantStatusConfig resolves the second and third model endpoints
// the assistant's setup checklist (§2) reports: speech (ADR-0080) and the
// decision judge (ADR-0079). It performs no validation — a malformed URL is
// not a startup refusal here, it is `configured: false` on the status row,
// because this config never opens a connection (the transcription and judge
// clients own their own endpoint validation in their own tasks) and refuse to
// boot over a typo the operator can see on the settings page would be the
// louder wrong answer. The key follows the assistant's rule exactly: from
// _API_KEY, else the trimmed contents of _API_KEY_FILE; never logged, and
// read here only to answer "is a key set".
func serveAssistantStatusConfig(getenv func(string) string) api.AssistantStatusModels {
	out := api.AssistantStatusModels{
		SpeechBaseURL:   strings.TrimSpace(getenv("COMMUNICATION_SPEECH_BASE_URL")),
		SpeechModel:     strings.TrimSpace(getenv("COMMUNICATION_SPEECH_MODEL")),
		DecisionBaseURL: strings.TrimSpace(getenv("COMMUNICATION_DECISION_BASE_URL")),
		DecisionModel:   strings.TrimSpace(getenv("COMMUNICATION_DECISION_MODEL")),
	}
	out.SpeechAPIKey = strings.TrimSpace(getenv("COMMUNICATION_SPEECH_API_KEY"))
	if out.SpeechAPIKey == "" {
		if file := strings.TrimSpace(getenv("COMMUNICATION_SPEECH_API_KEY_FILE")); file != "" {
			if raw, err := os.ReadFile(file); err == nil {
				out.SpeechAPIKey = string(trimSecret(raw))
			}
		}
	}
	return out
}

// serveSpeechConfig resolves ADR-0080's transcription egress: the
// COMMUNICATION_SPEECH_* triple. It mirrors serveAssistantConfig's rules and is
// read from the same three variables the § 2 status row reports (one env read
// each, so a _API_KEY_FILE is never opened twice for one boot):
//
//   - the base URL is a server root, trailing slash trimmed, because the
//     client appends /audio/transcriptions to it;
//   - the key comes from COMMUNICATION_SPEECH_API_KEY or, when that is empty,
//     the trimmed contents of COMMUNICATION_SPEECH_API_KEY_FILE. It only ever
//     reaches one request header — never a log line, a problem body or the
//     status read, which reduces it to a `key_set` bool;
//   - an unset base URL or model is not a failure: it is the honest absence,
//     and the route says so with 503 speech_not_configured. A malformed URL is
//     deliberately not a startup refusal here either — unlike the chat model
//     the speech endpoint takes no traffic until someone presses the mic, and
//     serveAssistantStatusConfig already documents that a typo belongs on the
//     settings page (as configured: false / a 502), not in a refused boot.
func serveSpeechConfig(getenv func(string) string) api.SpeechConfig {
	out := api.SpeechConfig{
		BaseURL: strings.TrimRight(strings.TrimSpace(getenv("COMMUNICATION_SPEECH_BASE_URL")), "/"),
		Model:   strings.TrimSpace(getenv("COMMUNICATION_SPEECH_MODEL")),
	}
	out.APIKey = strings.TrimSpace(getenv("COMMUNICATION_SPEECH_API_KEY"))
	if out.APIKey == "" {
		if file := strings.TrimSpace(getenv("COMMUNICATION_SPEECH_API_KEY_FILE")); file != "" {
			if raw, err := os.ReadFile(file); err == nil {
				out.APIKey = string(trimSecret(raw))
			}
		}
	}
	return out
}

// envDecisionTimeout is ADR-0079's per-decision deadline.
const envDecisionTimeout = "COMMUNICATION_DECISION_TIMEOUT"

// serveDecision is the resolved COMMUNICATION_DECISION_* quad (ADR-0079):
// the judge the "ask when it looks risky" level consults before every tool
// call.
type serveDecision struct {
	BaseURL string
	APIKey  string
	Model   string
	// Timeout is the per-decision deadline; zero means the judge's own
	// assistant.DefaultDecisionTimeout (4s) applies. A judge that is slow is a
	// judge that is DOWN, so this stays short by design: the gate falls back to
	// the fixed class table rather than stalling a turn.
	Timeout time.Duration
}

// serveDecisionConfig reads the decision-model quad with the assistant's rules
// mirrored verbatim: the base URL is a trailing-slash-trimmed server root, the
// key comes from _API_KEY or (when that is empty) the trimmed contents of
// _API_KEY_FILE, and the key only ever reaches one request header — never a
// log line, a problem body or the § 2 status row, which reduces it to a
// `key_set` bool.
//
// Unlike the chat model, an unusable base URL is NOT a startup refusal here: it
// is a judge that does not count as configured, which ADR-0079 answers with the
// fixed table (asks more, never less) and the setup checklist reports honestly.
// A malformed TIMEOUT is a refusal, because it is a typo about how long a
// human waits, not about which endpoint answers.
func serveDecisionConfig(getenv func(string) string) (serveDecision, error) {
	out := serveDecision{
		BaseURL: strings.TrimRight(strings.TrimSpace(getenv("COMMUNICATION_DECISION_BASE_URL")), "/"),
		Model:   strings.TrimSpace(getenv("COMMUNICATION_DECISION_MODEL")),
	}
	if raw := strings.TrimSpace(getenv(envDecisionTimeout)); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return out, fmt.Errorf("%s %q is not a duration: %w", envDecisionTimeout, raw, err)
		}
		if d <= 0 {
			return out, fmt.Errorf("%s must be positive, got %s", envDecisionTimeout, d)
		}
		out.Timeout = d
	}
	out.APIKey = strings.TrimSpace(getenv("COMMUNICATION_DECISION_API_KEY"))
	if out.APIKey == "" {
		if file := strings.TrimSpace(getenv("COMMUNICATION_DECISION_API_KEY_FILE")); out.APIKey == "" && file != "" {
			raw, err := os.ReadFile(file)
			if err != nil {
				return out, fmt.Errorf("COMMUNICATION_DECISION_API_KEY_FILE %q is unreadable: %v", file, err)
			}
			out.APIKey = string(trimSecret(raw))
		}
	}
	return out, nil
}

// decisionEndpointHost is the host half of a decision-model base URL for one
// log line: scheme, path, query and any userinfo a key could hide in are all
// dropped, exactly like the § 2 status row's `endpoint_host`.
func decisionEndpointHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "the decision model"
	}
	return u.Host
}

// scheduleTicker is the slice of the schedule store the ticker loop needs —
// one method, so the loop's logging and cancellation are unit-testable
// against a recorder instead of a database.
type scheduleTicker interface {
	TickSchedules(ctx context.Context, now time.Time) (int, error)
}

// runScheduleTicker is ADR-0032's serve-side tick: every `every`, fire what
// is due. A failed tick is logged and retried next beat (the due-row claim
// is idempotent, so a retry cannot double-fire); fired runs are logged at
// INFO only when there were runs, so a healthy idle replica stays quiet.
func runScheduleTicker(ctx context.Context, st scheduleTicker, every time.Duration, log *slog.Logger) error {
	if st == nil {
		return errors.New("serve: schedule ticker has no store")
	}
	if every <= 0 {
		every = defaultScheduleTick
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			n, err := st.TickSchedules(ctx, time.Now())
			if err != nil {
				log.ErrorContext(ctx, "schedule tick failed; retrying next tick",
					slog.String("error", err.Error()))
				continue
			}
			if n > 0 {
				log.InfoContext(ctx, "schedules fired",
					slog.Int("runs_created", n), slog.String("every", every.String()))
			}
		}
	}
}

// sessionPurger is the slice of the identity store the purge loop needs —
// one method, so the loop's logging and cancellation are unit-testable
// against a recorder instead of a database.
type sessionPurger interface {
	PurgeExpired(ctx context.Context) error
}

// runSessionPurger is audit F1's retention tick: every `every`, delete the
// sessions and OIDC login states whose TTLs have already expired. A failed
// purge is logged and retried next beat (the deletes are idempotent, so a
// retry cannot double-delete); a panicked pass is recovered for the same
// reason runIssueTriggerTicker recovers — a loop that dies quietly turns a
// bounded churn into unbounded table growth, which is the exact failure the
// tick exists to prevent. Errors are never fatal: a purge failure means the
// database is having a day, not that this replica should stop serving.
func runSessionPurger(ctx context.Context, p sessionPurger, every time.Duration, log *slog.Logger) error {
	if p == nil {
		return errors.New("serve: session purger has no store")
	}
	if every <= 0 {
		every = defaultSessionPurgeInterval
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.WarnContext(ctx, "session purge panicked; retrying next tick",
							slog.Any("panic", r),
							slog.String("stack", string(debug.Stack())))
					}
				}()
				if err := p.PurgeExpired(ctx); err != nil {
					log.ErrorContext(ctx, "session purge failed; retrying next tick",
						slog.String("error", err.Error()))
				}
			}()
		}
	}
}

// issueTriggerTicker is the slice of the issue-trigger store the serve-side
// tick loop needs — one method, so the loop's logging and cancellation are
// unit-testable against a recorder instead of a database.
type issueTriggerTicker interface {
	TickIssueTriggers(ctx context.Context, now time.Time, lister github.IssueLister) (int, error)
}

// runIssueTriggerTicker is ADR-0056 part 2's serve-side tick: every `every`,
// fire the due issue triggers. A failed tick is logged at WARN and retried
// next beat (the due-row claim is idempotent, so a retry cannot double-fire);
// a tick that PANICS is recovered, logged and retried too — the loop outlives
// everything a pass can do, because a poller that died quietly is exactly how
// the 2026-10-25 lab read as "the trigger stopped polling" (the second
// failure's real story was a silent ceiling deferral, fixed in the store; the
// recover here is the guarantee that no future cause can end this loop while
// serve runs). Fired runs are logged at INFO only when there were runs, so a
// healthy idle replica stays quiet. Same shape as runScheduleTicker, which is
// why it lives beside it.
func runIssueTriggerTicker(ctx context.Context, st issueTriggerTicker, lister github.IssueLister, every time.Duration, log *slog.Logger) error {
	if st == nil {
		return errors.New("serve: issue trigger ticker has no store")
	}
	if every <= 0 {
		every = defaultIssueTriggerTick
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.WarnContext(ctx, "issue trigger tick panicked; retrying next tick",
							slog.Any("panic", r),
							slog.String("stack", string(debug.Stack())))
					}
				}()
				n, err := st.TickIssueTriggers(ctx, time.Now(), lister)
				if err != nil {
					log.WarnContext(ctx, "issue trigger tick failed; retrying next tick",
						slog.String("error", err.Error()))
					return
				}
				if n > 0 {
					log.InfoContext(ctx, "issue triggers fired",
						slog.Int("runs_created", n), slog.String("every", every.String()))
				}
			}()
		}
	}
}

// catchUpSweeper is the slice of the catch-up generator the completion-sweep
// tick needs — one method, so the loop's logging and cancellation are
// unit-testable against a recorder instead of a database or a model.
type catchUpSweeper interface {
	CatchUpCompletionSweep(ctx context.Context)
}

// runCatchUpGenSweeper is ADR-0078 § Trigger's serve-side tick: every
// `every`, tell the runs that finished untoured. The sweep itself never
// returns an error (a generation failure is the pass's own logged business,
// and the model-call cap is a logged skip), so what this loop owns is the
// beat and the survival: a sweep that PANICS is recovered, logged and
// retried next beat, for the runSessionPurger reason — a loop that died
// quietly turns "nobody opened the page" back into "runs get no tours", the
// exact gap the tick exists to close. Cancellation is a clean return; the
// pass holds the tick's own context, so closeStack drains it.
func runCatchUpGenSweeper(ctx context.Context, sw catchUpSweeper, every time.Duration, log *slog.Logger) error {
	if sw == nil {
		return errors.New("serve: catch-up sweeper has no generator")
	}
	if every <= 0 {
		every = defaultCatchUpGenSweepT
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.WarnContext(ctx, "catch-up sweep panicked; retrying next tick",
							slog.Any("panic", r),
							slog.String("stack", string(debug.Stack())))
					}
				}()
				sw.CatchUpCompletionSweep(ctx)
			}()
		}
	}
}

// m4RunTrigger returns the advancer trigger the run and approval routes fire
// after a state write, or nil on a replica where the engine is off. A nil
// trigger is legal by api.M4Trigger's own contract (the write is complete
// without it); here it is not merely a latency choice but the C14c guarantee
// that an off replica never advances a run itself.
func m4RunTrigger(drv *postgres.M4Driver, schedulerOff bool) api.M4Trigger {
	if schedulerOff || drv == nil {
		return nil
	}
	return drv.Trigger
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
//	api.RegisterOrgEvents     GET /api/v1/events (SSE, ADR-0048)
//	api.RegisterConversations agent profiles, conversations, messages, control,
//	                          cancel, permission decisions and
//	                          GET /api/v1/conversations/{id}/events (SSE)
//	api.RegisterWorkers       GET /api/v1/workers
//	api.RegisterLaunchers     GET /api/v1/launchers (ADR-0051)
//	api.RegisterPipelines     pipelines, drafts, revisions, publish,
//	                          validate, schemas (docs/m4-contract.md § 2)
//	api.RegisterRuns          runs, node executions, attempts, assignments,
//	                          run events (SSE)
//	api.RegisterSchedules     GET/POST /api/v1/projects/{projectId}/schedules,
//	                          PATCH /api/v1/schedules/{scheduleId} (ADR-0032)
//	api.RegisterApprovals     approval lists, get, decide
//	api.RegisterScheduler     GET /api/v1/system/scheduler
//	postgres.M4Driver         in-process advancer: api.M4Trigger nudges one
//	                          run, the 2 s tick catches dropped triggers,
//	                          one replica at a time under its own advisory
//	                          lock (docs/m4-contract.md § 5). Neither path
//	                          starts when COMMUNICATION_PIPELINE_SCHEDULER=off
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
	// M3 surfaces (docs/m3-contract.md § 2). The mounts are unconditional and
	// the *capability* is conditional: with no keyring the secret write routes
	// refuse through SecretStore.Keys == nil rather than accepting a rotation
	// the process could never decrypt, and with no artifact bytes mounted the
	// content route answers 503 instead of pretending a row has no bytes.
	// Built here (before the routes that consume it) because ADR-0061 gives
	// the issue-listing route a second reason to hold the secret store: a
	// credentialed repository's issues are read WITH its credential.
	secretStore := &postgres.SecretStore{Pool: d.Pool, Keys: d.M3.Keyring}
	api.RegisterGitHubIssues(handler, apiProjects, github.New(), secretStore)
	api.RegisterEvents(handler, apiProjects,
		postgres.APIEventStream{S: projectStore, Wakes: wakes})
	// The org-level stream multiplexes the same journal across the caller's
	// projects (ADR-0048); it reuses the project stream's store read.
	api.RegisterOrgEvents(handler, postgres.APIEventStream{S: projectStore, Wakes: wakes})
	api.RegisterConversations(handler, apiConversations, apiConversations,
		postgres.APIConversationStream{S: conversationStore, Journal: projectStore, Wakes: wakes})
	api.RegisterWorkers(handler, postgres.APIWorkerStore{
		R:                 &postgres.WorkerRegistry{Pool: d.Pool},
		HeartbeatInterval: d.WorkerHeartbeat,
	})
	// ADR-0051: the launcher registry + evidence-backed capability cells.
	// Reuses the /workers liveness window, so the launcher count and the
	// worker list never disagree about which workers are live.
	api.RegisterLaunchers(handler, postgres.APILauncherStore{
		Pool:              d.Pool,
		HeartbeatInterval: d.WorkerHeartbeat,
	})

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
	// ADR-0049 § 2: validate resolves node `template: slug@semver` references
	// against the org's registry (fail-closed template_ref_unresolved).
	definitionService.WithTemplates(d.Pool)
	runStore := &postgres.RunStore{Pool: d.Pool}
	m4Children := &postgres.M4Children{Runs: runStore}
	m4Runtime := postgres.NewRuntimeStore(d.Pool, &runtime.Advancer{
		Deps: runtime.AdvancerDeps{Children: m4Children},
	})
	m4Children.Runtime = m4Runtime // the advancer needs the children; the children, the runtime store
	m4Driver := postgres.NewM4Driver(d.Pool, m4Runtime,
		log.With(slog.String("component", "m4-driver")))
	// ADR-0023's rollback switch, decided once: the routes' trigger and the
	// driver's ticker both read this same answer, so an off replica cannot
	// advance a run by either path.
	startDriver := startPipelineDriver(d.PipelineSchedulerOff)
	var m4Trigger api.M4Trigger
	if startDriver {
		m4Trigger = m4RunTrigger(m4Driver, d.PipelineSchedulerOff)
	} else {
		log.Info("pipeline scheduler disabled on this replica (COMMUNICATION_PIPELINE_SCHEDULER=off)")
	}
	api.RegisterPipelines(handler, postgres.APIPipelineStore{S: pipelineStore}, definitionService)
	api.RegisterNodeTemplates(handler, postgres.APINodeTemplateStore{Pool: d.Pool})
	// ADR-0084: the APM collection library — named, versioned bundles of pinned
	// refs an agent profile attaches in an order of its choosing. Same shape as
	// the step registry beside it (org-scoped reads for any member, writes behind
	// the organization's library role, revisions immutable once published). The
	// worker flattens what is stored here into the one apm.yml whose lock digest
	// gates a launch; nothing in this surface executes anything.
	api.RegisterAPMCollections(handler, postgres.APIAPMCollectionStore{
		S: &postgres.APMCollectionStore{Pool: d.Pool},
	})
	api.RegisterRuns(handler,
		postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
		postgres.APIAssignmentStore{S: pipelineStore},
		apiProjects,
		postgres.APIRunEventStream{Journal: projectStore, Wakes: wakes},
		m4Trigger,
		// ADR-0064: a hand start that names an issue (`RunCreate.issue`)
		// defaults its banner from GitHub — the ADR-0031 read-only adapter,
		// credentialed through the same ADR-0061 secret store the issues
		// route reads with. Best-effort by contract: every failure of this
		// read leaves the title null and the run still starts.
		api.WithGitHubIssueReader(github.New(), secretStore))
	api.RegisterSchedules(handler,
		postgres.APIScheduleStore{S: &postgres.ScheduleStore{Pool: d.Pool}},
		apiProjects)
	api.RegisterIssueTriggers(handler,
		postgres.APIIssueTriggerStore{S: &postgres.IssueTriggerStore{Pool: d.Pool}},
		apiProjects)
	api.RegisterApprovals(handler, postgres.APIApprovalStore{R: m4Runtime},
		apiProjects, m4Trigger)
	// ADR-0052's approval summarization pass and free-text interpretation:
	// one bounded model turn each, over ADR-0034's broker, authorized exactly
	// like the approval routes (a gate the caller cannot see is 404). Reuses
	// the same egress triple as the assistant above — with it unset the routes
	// answer 503 assistant_not_configured and the UI keeps the gate's own text.
	api.RegisterApprovalSummary(handler, postgres.APIApprovalStore{R: m4Runtime},
		api.AssistantConfig{BaseURL: d.Assistant.BaseURL, APIKey: d.Assistant.APIKey, Model: d.Assistant.Model, Timeout: d.Assistant.Timeout})
	// ADR-0047's cross-project reads: the app shell's Home/Board/Threads/
	// Inbox list routes, scoped per membership in the store's SQL.
	api.RegisterCrossProject(handler, postgres.APICrossProjectStore{Pool: d.Pool})
	api.RegisterScheduler(handler, postgres.APISchedulerStore{Pool: d.Pool,
		HeartbeatInterval: d.WorkerHeartbeat}) // same liveness window as /workers
	// ADR-0034's read-only assistant: one route, mounted unconditionally and
	// honest about being unconfigured (503 assistant_not_configured). Its tools
	// are the very store reads mounted above, each issued with the CALLER's own
	// identity — the assistant holds no handle it does not pass a Caller to, and
	// the narrow read interfaces in api/assistant.go expose no write method.
	asstDeps := api.AssistantDeps{
		Projects:  apiProjects,
		Runs:      postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
		Approvals: postgres.APIApprovalStore{R: m4Runtime},
		Pipelines: postgres.APIPipelineStore{S: pipelineStore},
		Profiles:  apiConversations,
		// ADR-0081 § Chat tools: the assistant's catchup.brief answers from the
		// SAME catch-up store the Catch up routes are mounted with (the value is
		// a handle over the pool, so building it twice builds nothing twice).
		// One assembler, one membership predicate — the page and the chat model
		// cannot disagree about what happened. Unwired would be the honest
		// absence: the tool is then never announced.
		Brief: postgres.APICatchUpStore{
			S:       &postgres.CatchUpStore{Pool: d.Pool},
			Denials: projectStore,
		},
		Config: api.AssistantConfig{
			BaseURL: d.Assistant.BaseURL,
			APIKey:  d.Assistant.APIKey,
			Model:   d.Assistant.Model,
			Timeout: d.Assistant.Timeout,
		},
	}
	api.RegisterAssistant(handler, asstDeps)
	// ADR-0080: server-side dictation. Mounted beside the assistant's own routes
	// with the same session + CSRF + assistant-throttle contract; unset speech
	// config answers 503 speech_not_configured and the mic falls back to the
	// browser. Audio never touches disk and neither audio nor transcript is
	// logged — see internal/api/assistant_speech.go.
	api.RegisterAssistantSpeech(handler, d.Speech)
	// The §2 setup read: the same object GET /api/v1/assistant/status serves
	// and the system.status tool answers with. Every store below is the
	// caller-scoped read an existing route already uses, so the checklist can
	// name no row the caller could not read at that route, and no field here
	// could carry a secret value (the secret store's read side returns
	// metadata only — ADR-0018).
	asstStatus := api.NewSystemStatus(api.AssistantStatusDeps{
		Chat:        asstDeps.Config,
		Models:      d.AssistantStatus,
		Workers:     postgres.APIWorkerStore{R: &postgres.WorkerRegistry{Pool: d.Pool}, HeartbeatInterval: d.WorkerHeartbeat},
		Sandbox:     postgres.APISystemSandboxStore{Pool: d.Pool},
		Projects:    apiProjects,
		Repos:       apiProjects,
		Secrets:     postgres.APISecretStore{S: secretStore},
		Pipelines:   postgres.APIPipelineStore{S: pipelineStore},
		Assignments: postgres.APIAssignmentStore{S: pipelineStore},
	})
	api.RegisterAssistantStatus(handler, asstStatus)
	// ADR-0050: the per-user persisted conversations, transcript and
	// change log. Part 2 wires the multi-turn tool-loop runner: the ADR-0034
	// read registry plus the closed write/navigation set, every action run
	// as the caller through the very stores the user's own routes use, the
	// trust level read per turn from the caller's preferences (ADR-0046,
	// default ask_risky), and the draft-edit undo seam applying the closed
	// inverse through the version-checked draft PUT. With no egress triple
	// the runner is nil and the routes answer 503 assistant_not_configured,
	// exactly like the ask route.
	asstBroker, asstErr := api.BuildAssistantBroker(asstDeps, d.API.Logger)
	if asstErr != nil {
		// RegisterAssistant already logged the deployment error; the
		// conversation routes answer 503 assistant_not_configured like the
		// ask route.
		asstBroker = nil
	}
	var asstRunner assistant.TurnRunner
	var asstUndoer assistant.Undoer = assistant.UndoNotWired{}
	if asstBroker != nil {
		asstDraft := api.NewAssistantDraftService(postgres.APIPipelineStore{S: pipelineStore})
		// ADR-0079: the judge is built only when the base URL and model are
		// both set; anything else (including a base URL that is not an
		// http(s) root) leaves it nil, which is the fixed table, not a
		// half-wired model. It raises the gate, never lowers it, so a
		// deployment that cannot reach it asks MORE than one that can.
		var asstJudge assistant.Judge
		if d.Decision.BaseURL != "" && d.Decision.Model != "" {
			asstJudge = assistant.NewChatJudge(d.Decision.BaseURL, d.Decision.APIKey,
				d.Decision.Model, d.Decision.Timeout, nil)
			if asstJudge == nil {
				// Named without being usable: say which, without the key or
				// the userinfo a URL could hide.
				d.API.Logger.Warn("assistant decision model is configured but unusable; the fixed tool-class table decides",
					slog.String("endpoint_host", decisionEndpointHost(d.Decision.BaseURL)))
			}
		}
		asstRunner = assistant.NewConversationRunner(assistant.ConversationRunnerDeps{
			Broker: asstBroker,
			Draft:  asstDraft,
			Judge:  asstJudge,
			// Thread → workflow (design 2f): the caller-checked chat read
			// (the GET /conversations/{id} store read, the summary row's
			// repository, the SSE stream's journal read, member names) and
			// the library-role-checked draft creation (the user's own
			// CreatePipeline + CreateDraft with source_kind "assistant").
			Chats: api.NewAssistantChatTranscript(apiConversations,
				postgres.APIConversationStream{S: conversationStore, Journal: projectStore, Wakes: wakes},
				apiProjects),
			Library: api.NewAssistantLibraryDraftCreator(postgres.APIPipelineStore{S: pipelineStore}),
			// The §2 setup checklist: the tool answers with exactly the
			// object GET /api/v1/assistant/status serves, built as the
			// caller. An unwired service would keep the tool unannounced;
			// serve always wires it.
			Status: api.NewAssistantStatusReader(asstStatus),
			// Handoff §6 read tools (credential.list, workflow.list/inspect,
			// repo.check, issue.list, profile.list, schedule.list): each one
			// reads through the caller-scoped store the matching route uses.
			Setup: api.NewAssistantSetupReader(api.AssistantSetupDeps{
				Projects:         apiProjects,
				Secrets:          postgres.APISecretStore{S: secretStore},
				Pipelines:        postgres.APIPipelineStore{S: pipelineStore},
				Assignments:      postgres.APIAssignmentStore{S: pipelineStore},
				Profiles:         apiConversations,
				Schedules:        postgres.APIScheduleStore{S: &postgres.ScheduleStore{Pool: d.Pool}},
				Credentials:      secretStore,
				NamedCredentials: postgres.APISecretStore{S: secretStore},
				RepoGet:          github.New(),
				IssueLister:      github.New(),
			}),
			Actions: api.NewAssistantActions(api.AssistantActionsDeps{
				Runs:        postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
				Assignments: postgres.APIAssignmentStore{S: pipelineStore},
				Approvals:   postgres.APIApprovalStore{R: m4Runtime},
				Projects:    apiProjects,
				Trigger:     m4Trigger,
				// The §6 setup writes: the SAME store adapters the UI routes
				// are registered with, so an assistant action and the
				// person's own click run identical SQL as the same caller.
				ProjectWrites:    apiProjects,
				Secrets:          postgres.APISecretStore{S: secretStore},
				Revisions:        postgres.APIPipelineStore{S: pipelineStore},
				AssignmentWrites: postgres.APIAssignmentStore{S: pipelineStore},
				Schedules:        postgres.APIScheduleStore{S: &postgres.ScheduleStore{Pool: d.Pool}},
				RunStop:          postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
			}),
		})
		// The draft-edit inverse (ADR-0050 decision 5): delete_node /
		// update_prompt back through the same CAS PUT the edit used; a
		// draft that moved refuses (the route's 409 change_not_undoable).
		asstUndoer = assistant.DraftEditUndoer{Draft: asstDraft}
	}
	// The per-turn trust read (ADR-0046/C2): the caller's own row, defaults
	// under a never-saved user; it authorizes nothing.
	asstPrefs := postgres.APIUserPreferencesStore{S: &postgres.UserPreferencesStore{Pool: d.Pool}}
	api.RegisterAssistantConversations(handler, api.AssistantConversationDeps{
		Store: &postgres.AssistantConversationStore{
			Pool:   d.Pool,
			Undoer: asstUndoer,
		},
		Runner:     asstRunner,
		TrustLevel: api.AssistantTrustLevel(asstPrefs),
	})
	api.RegisterSandbox(handler,
		postgres.APITurnSandboxStore{Pool: d.Pool},
		postgres.APISystemSandboxStore{
			Pool:                 d.Pool,
			PinnedBackendVersion: d.M3.PinnedVersion,
			PolicyDigest:         d.M3.PolicyDigest,
		})
	// The operations page's one read and one action: GET /system/overview and
	// POST /system/models/{kind}/probe. Every value below is config this
	// process already resolved (the assistant's egress triple, the §2 model
	// pair, the judge's key, the artifact backend's own name, the preview
	// host) or a caller-scoped read an existing route already serves, so the
	// overview can state no fact the routes above disagree with. See
	// internal/api/system_overview.go for what each row means and what the
	// probe refuses to say.
	api.RegisterSystemOverview(handler, api.NewSystemOverviewService(api.SystemOverviewDeps{
		Version:         d.API.Version,
		Replica:         d.API.ReplicaName,
		Chat:            asstDeps.Config,
		Models:          d.AssistantStatus,
		DecisionAPIKey:  d.Decision.APIKey,
		WorkerChat:      d.WorkerChat,
		IssuerURL:       d.Auth.Issuer,
		SignInProviders: d.Auth.SignInProviders(),
		ArtifactBackend: api.ArtifactBackendName(d.M3.ArtifactBytes),
		PreviewHost:     d.M3.PreviewHost,
		Workers:         postgres.APIWorkerStore{R: &postgres.WorkerRegistry{Pool: d.Pool}, HeartbeatInterval: d.WorkerHeartbeat},
		Projects:        apiProjects,
		Secrets:         postgres.APISecretStore{S: secretStore},
		Heartbeat:       d.WorkerHeartbeat,
	}, d.API.Logger))
	// ADR-0046: the per-user display preferences (GET/PATCH
	// /api/v1/me/preferences). Self-scoped — keyed by the caller's own user
	// id, so the store needs only the pool. (The same store answers the
	// assistant's per-turn trust read above.)
	api.RegisterPreferences(handler, asstPrefs)

	// ADR-0071: the assistant's notes — per-user suggestions about one
	// repository or one thread, dismissible by their owner. The two reads and
	// the one write are the store's own authorization (membership, or the
	// organization's admin) and the store audits every refusal. The optional
	// third argument is step 2's generator: the same broker the assistant
	// speaks through, reading through the routes the caller already has, and
	// writing through the store's insert — there is still no write route.
	// With no egress triple the builder answers nil and these routes are the
	// pure reads they were without it.
	api.RegisterAssistantNotes(handler,
		postgres.APIAssistantNotesStore{
			S:       &postgres.AssistantNotesStore{Pool: d.Pool},
			Denials: projectStore,
		},
		api.BuildAssistantNotesGenerator(api.AssistantNotesGenDeps{
			Broker:      asstBroker,
			Notes:       &postgres.AssistantNotesStore{Pool: d.Pool},
			Runs:        postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
			Pipelines:   postgres.APIPipelineStore{S: pipelineStore},
			Repos:       apiProjects,
			Lister:      github.New(),
			Credentials: secretStore,
			Threads:     apiConversations,
			Chats: api.NewAssistantChatTranscript(apiConversations,
				postgres.APIConversationStream{S: conversationStore, Journal: projectStore, Wakes: wakes},
				apiProjects),
			Logger: d.API.Logger,
		}))

	// ADR-0078: Catch up — what the agents did while this person was away. The
	// eight routes are the store's own membership rule (a work item in a project
	// the caller is not in is the same 404 as a deleted one, and the adapter
	// audits that refusal against the project it lived in), and the per-user
	// reading state is keyed on the reader. The second argument is the delivery
	// half of a decision reply: the SAME conversation store the messages route
	// uses, so the controller lock, the one-active-turn rule and the thread's
	// audit stay in one place — a reply is a sentence handed to an agent, never
	// a gate that could move a run. What is absent on purpose is the browser-
	// facing half that WRITES tours: no route accepts a tour, because the
	// only writer of a shared tour is the generator below — the server's own
	// assistant behind ADR-0034's egress, scheduled by `POST
	// /catch-up/visits` (never by a list read; ADR-0078 § Migration, Trigger
	// note), and nothing a browser
	// sends belongs in a shared tour.
	// The generator (ADR-0078 § Migration + Trigger note): the same broker
	// the assistant speaks through, reading the caller's own run/node/pipeline/
	// transcript reads and writing through the store's own upsert and
	// append. `POST /catch-up/visits` schedules a pass after it answers —
	// the list read does not, and neither does an item read; the sidebar
	// badge reads the list on every page and a list trigger spent a model
	// call per page load. The SECOND trigger is the completion sweep below
	// (ADR-0078 § Trigger): a finished run gets its tour without anybody
	// opening the page. With no egress triple the builder returns nil
	// and the routes stay the pure reads they were — an empty page, never
	// a stub narrative.
	catchUpGen := api.BuildCatchUpGenerator(api.CatchUpGenDeps{
		Broker:    asstBroker,
		CatchUp:   postgres.APICatchUpGenerator{S: &postgres.CatchUpStore{Pool: d.Pool}},
		Runs:      postgres.APIRunStore{Runs: runStore, Runtime: m4Runtime},
		Pipelines: postgres.APIPipelineStore{S: pipelineStore},
		// ADR-0078 § Patch artifacts: the tour's diff excerpts read the SAME
		// artifact list and byte backend the download routes use, so the
		// generator can open exactly what this caller could open in the
		// artifacts tab — and nothing when no byte backend is mounted (the
		// honest "this deployment records no patches", never an invented
		// hunk).
		Patches: catchUpPatchSource(apiArtifacts, d.M3.ArtifactBytes),
		Chats: api.NewAssistantChatTranscript(apiConversations,
			postgres.APIConversationStream{S: conversationStore, Journal: projectStore, Wakes: wakes},
			apiProjects),
		Logger:                 d.API.Logger,
		Cooldown:               d.CatchUpGenCooldown,
		MaxModelCallsPerWindow: d.CatchUpGenPer10M,
		MaxSweepCallsPerWindow: d.CatchUpSweepPer10M,
	})
	api.RegisterCatchUp(handler,
		postgres.APICatchUpStore{
			S:       &postgres.CatchUpStore{Pool: d.Pool},
			Denials: projectStore,
		},
		apiConversations,
		api.WithTourGenerator(catchUpGen),
		// The recap (T13b): the same broker, asked once per request, behind
		// the assistant's own per-principal throttle. A recap is one reader's
		// own row, so a browser may ask for it; a tour is shared, so no
		// browser route may write one.
		api.WithRecapGenerator(api.BuildCatchUpRecapGenerator(api.CatchUpRecapDeps{
			Broker: asstBroker,
			Logger: d.API.Logger,
		})),
		// ADR-0081's headline: the same broker, asked in the BACKGROUND by the
		// brief read and answered from a 5-minute per-(reader, window, digest)
		// cache. The brief's lists never wait on it, so this route buys no
		// completion in front of a browser and carries no assistant throttle.
		api.WithCatchUpHeadlineGenerator(api.BuildCatchUpHeadlineGenerator(api.CatchUpHeadlineDeps{
			Broker: asstBroker,
			Logger: d.API.Logger,
		})))

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
	// advisory-lock pattern as the reconciler below, its own lock name. With
	// COMMUNICATION_PIPELINE_SCHEDULER=off it does not tick here at all — the
	// goroutine is never started (see serveStackDeps.PipelineSchedulerOff).
	driverCtx, stopDriver := context.WithCancel(context.Background())
	if startDriver {
		runDriver := d.m4DriverRunner
		if runDriver == nil {
			runDriver = func(ctx context.Context) error { return m4Driver.Run(ctx, 2*time.Second) }
		}
		go func() {
			if err := runDriver(driverCtx); err != nil {
				log.Error("m4 driver stopped", slog.String("error", err.Error()))
				return
			}
			log.Info("m4 driver stopped")
		}()
	}

	// The ADR-0032 schedule tick: the SAME decision as the driver above — a
	// replica that does not run the pipeline engine does not fire schedules
	// either, so COMMUNICATION_PIPELINE_SCHEDULER=off skips this goroutine
	// too. Two replicas may tick together; TickSchedules' FOR UPDATE SKIP
	// LOCKED claim is the mutex (ADR-0032 § 4), so no advisory lock here.
	tickCtx, stopTick := context.WithCancel(context.Background())
	if startDriver {
		runTick := d.scheduleTickRunner
		if runTick == nil {
			scheduleStore := &postgres.ScheduleStore{
				Pool: d.Pool,
				Log:  log.With(slog.String("component", "schedule-tick")),
			}
			every := d.ScheduleTick
			runTick = func(ctx context.Context) error {
				return runScheduleTicker(ctx, scheduleStore, every,
					log.With(slog.String("component", "schedule-tick")))
			}
		}
		go func() {
			if err := runTick(tickCtx); err != nil {
				log.Error("schedule ticker stopped", slog.String("error", err.Error()))
				return
			}
			log.Info("schedule ticker stopped")
		}()
	}

	// The ADR-0056 part-2 issue-trigger poll tick: the same due-row claim and
	// FOR UPDATE SKIP LOCKED mutex as the schedule tick above, on its own
	// cadence (COMMUNICATION_ISSUE_TRIGGER_TICK, default 60 s). Two replicas may
	// tick together; TickIssueTriggers' FOR UPDATE SKIP LOCKED claim is the
	// mutex, so no advisory lock here.
	issueTriggerStore := &postgres.IssueTriggerStore{
		Pool: d.Pool,
		// ADR-0061 § 5: a credentialed repository's poll resolves its token
		// through this replica's secret store; without the wiring the poll
		// fails onto last_error rather than going anonymous silently.
		Credentials: secretStore,
		Log:         log.With(slog.String("component", "issue-tick")),
	}
	issueTriggerRunner := d.issueTriggerTickRunner
	if issueTriggerRunner == nil {
		issueTriggerRunner = func(ctx context.Context) error {
			return runIssueTriggerTicker(ctx, issueTriggerStore, github.New(), d.IssueTriggerTick,
				log.With(slog.String("component", "issue-tick")))
		}
	}
	go func() {
		if err := issueTriggerRunner(tickCtx); err != nil {
			log.Error("issue trigger ticker stopped", slog.String("error", err.Error()))
			return
		}
		log.Info("issue trigger ticker stopped")
	}()

	// Audit F1's retention tick: expired rows are dead the moment their TTL
	// passes (sessions enforce expires_at in SQL, login states are taken with
	// a WHERE expires_at > now()), but nothing deleted them until this loop —
	// /auth/login inserts a row per unauthenticated hit, so a churned table
	// was the attack. It runs on EVERY replica, unconditionally: PurgeExpired
	// is DELETE ... WHERE expires_at <= now(), so two replicas firing the
	// same beat is harmless — the loser either matches zero rows or waits on
	// the winner's row locks for one statement. Unlike the schedule tick this
	// is not gated on the pipeline scheduler: identity hygiene belongs to
	// every serving replica. The interval itself is the gate
	// (COMMUNICATION_SESSION_PURGE_INTERVAL=0 disables).
	purgeCtx, stopPurge := context.WithCancel(context.Background())
	if d.SessionPurgeInterval > 0 {
		runPurge := d.sessionPurgeRunner
		if runPurge == nil {
			purger, every := identity, d.SessionPurgeInterval
			runPurge = func(ctx context.Context) error {
				return runSessionPurger(ctx, purger, every,
					log.With(slog.String("component", "session-purge")))
			}
		}
		go func() {
			if err := runPurge(purgeCtx); err != nil {
				log.Error("session purge ticker stopped", slog.String("error", err.Error()))
				return
			}
			log.Info("session purge ticker stopped")
		}()
	}

	// ADR-0078 § Trigger, the completion sweep: a run that finishes gets its
	// tour without anybody opening the Catch up page (TASK T13 — "when a run
	// finishes… write or rewrite its tour"). One goroutine per replica, every
	// COMMUNICATION_CATCHUP_GEN_SWEEP (2 m default, 0 = the visit trigger
	// alone). It needs no lock between replicas and no gate on the pipeline
	// scheduler: the tour write is idempotent on the run's claim (the
	// generator re-reads CatchUpRunAlreadyToured before spending a completion
	// and again before writing), and the sweep spends its OWN per-replica
	// model-call budget (COMMUNICATION_CATCHUP_SWEEP_PER_10M, default 3) —
	// separate from the visit pass's COMMUNICATION_CATCHUP_GEN_PER_10M purse
	// precisely so background sweeping can never spend the budget a person
	// opening Catch up is waiting on — while the per-run cooldown stays
	// shared between the triggers.
	sweepCtx, stopSweep := context.WithCancel(context.Background())
	if d.CatchUpGenSweep > 0 && catchUpGen != nil {
		runSweep := d.catchUpGenSweepRunner
		if runSweep == nil {
			sweeper, every := catchUpGen, d.CatchUpGenSweep
			runSweep = func(ctx context.Context) error {
				sw, ok := sweeper.(catchUpSweeper)
				if !ok {
					return errors.New("serve: the catch-up generator has no sweep face")
				}
				return runCatchUpGenSweeper(ctx, sw, every,
					log.With(slog.String("component", "catch-up-sweep")))
			}
		}
		go func() {
			if err := runSweep(sweepCtx); err != nil {
				log.Error("catch-up sweep ticker stopped", slog.String("error", err.Error()))
				return
			}
			log.Info("catch-up sweep ticker stopped")
		}()
	}

	var closeOnce sync.Once
	closeStack := func() {
		closeOnce.Do(func() {
			stopReconciler()
			stopDriver()
			stopTick()
			stopPurge()
			stopSweep()
			wakes.Close()
		})
	}

	return stacked, closeStack, nil
}

// compile-time proof that the OIDC service is usable as the API's
// Authenticator: "serve uses the auth service" means this assignment, not a
// stub that has to be remembered later.
var _ api.Authenticator = (*auth.Service)(nil)
