#!/usr/bin/env python3
"""M4 exit proof — STACK SKELETON (docs/m4-contract.md § 7).

Status: the lifecycle, fixtures and helpers below are real; every gate C1–C14
and W1–W11 prints `SKIP (pending)` with its one-line intent. No gate here may
ever print PASS without the literal Postgres/API output its § 7 docstring
names (12-test-strategy.md: a mocked or inferred green is not done).

Host safety (§ 7.0, repeated because M4 is the first two-worker milestone):
every docker command here uses compose project `communication-m4` with its
own port block — 18091 (lb/app), 18092/18093 (api-a/api-b), 18094 (preview),
18095 (OIDC), 18099 (collector). NEVER the `communication` project, NEVER
host ports 18080–18090 or 8080/8081/8090, and `down -v` removes only what
this project created (no docker system/volume/image prune, no pattern pkill).

Stack (compose.yml + compose.harness.yml + compose.m4.yml):
  lb         http://localhost:18091          app origin (API ×2 behind caddy)
  api-a/b    18092 / 18093                   `communication serve` replicas
  preview    http://preview.localhost:18094  sandboxed artifact origin
  oidc       http://localhost:18095          mock-oauth2-server
  worker-a   volume repos-a, capacity 3      worker-b: volume repos-b, cap 1
  collector  host port 18099                 § 7 C11 egress sentinel
  postgres   internal only; SQL here is READ-ONLY evidence (writes happen
             through the API; profile pins with no API yet go by SQL, M3 D10).

Usage:
  python3 e2e/m4/e2e_m4_exit.py [--up] [--down] [--only C1,C5,W2] [--list]
  (run from the repository root; --up prepares .harness dirs + the fixture
  repo and builds; --down tears the project down at the end, even on failure)
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus

LB = "http://localhost:18091"
A = "http://localhost:18092"
B = "http://localhost:18093"
IDP = "http://localhost:18095"
PREVIEW = "http://preview.localhost:18094"
COLLECTOR = "http://localhost:18099"

REPO_DIR = os.environ.get("COMM_REPO_DIR") or os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
WS_BIND = os.path.join(REPO_DIR, ".harness", "workspaces")     # = /workspaces
REMOTES = os.path.join(REPO_DIR, ".harness", "remotes")
FIXTURE_HOST = os.path.join(REPO_DIR, ".harness", "m4-fixtures")  # = /srv/m4/fixtures
FIXTURE_URL = "file:///srv/m4/fixtures/app.git"  # the URL stored in the database
SCRATCH = os.environ.get("M4X_SCRATCH") or os.path.join(
    os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
    "communication-lab", "m4-exit")

# § 7.0's lab fixture secret — the literal the contract fixes (its value is a
# public contract string, not a credential; C2c asserts it appears NOWHERE).
SENTINEL = "SENTINEL-m4-7c1e9d42-exit-test-only"

WORKER_A = "communication-m4-worker-a"
WORKER_B = "communication-m4-worker-b"
NETWORK = "communication-m4_default"
MASTERKEYS_VOL = "communication-m4_masterkeys"
COMPOSE = ["docker", "compose", "-p", "communication-m4",
           "-f", "compose.yml", "-f", "compose.harness.yml", "-f", "compose.m4.yml"]
COMPOSE_ENV = dict(os.environ, HOST_UID=str(os.getuid()), HOST_GID=str(os.getgid()))

FAILURES, GAPS, SKIPPED, EVIDENCE = [], [], [], {}
CTX = {}   # gates will accumulate run ids / digests / attempt ids here


# --- printers (e2e_m3_exit.py's house idiom, plus the honest SKIP word) ----


def step(t):
    print(f"\n=== {t}", flush=True)


def check(label, ok, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"  {mark}  {label}{(' — ' + detail) if detail else ''}", flush=True)
    if not ok:
        FAILURES.append(label)
    return ok


def gap(label, why):
    print(f"  GAP   {label} — {why}", flush=True)
    GAPS.append(f"{label}: {why}")


def skip(label, intent):
    """The only verdict an unimplemented gate may print. Never PASS-by-schedule."""
    print(f"  SKIP  {label} (pending) — {intent}", flush=True)
    SKIPPED.append(label)


def show(label, out):
    """Echo a command's literal output the way the acceptance report needs it."""
    print(f"  $ {label}", flush=True)
    for line in str(out).rstrip().splitlines():
        print(f"    {line}", flush=True)


# --- shell / psql / exec helpers --------------------------------------------


def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_DIR,
                       env=COMPOSE_ENV, **kw)
    out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
    return p.returncode, out.rstrip()


def psql(sql):
    rc, out = run(COMPOSE + ["exec", "-T", "postgres", "psql", "-U", "communication",
                             "-d", "communication", "-tAqc", sql])
    if rc != 0:
        raise RuntimeError(f"psql failed rc={rc}: {out}\n  sql: {sql}")
    return out.strip()


def wexec(sh, worker=WORKER_A):
    """Run sh inside a stack worker (C2's /proc probes, C5's git reads)."""
    return run(["docker", "exec", worker, "sh", "-c", sh])


def compose_logs(*services):
    rc, out = run(COMPOSE + ["logs", "--no-color", *services])
    return out


# --- HTTP client / login (cloned shapes from e2e_m3_exit.py) -----------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Resp:
    def __init__(self, status, headers, body, url):
        self.status, self.headers, self.body, self.url = status, headers, body or b"", url

    @property
    def replica(self):
        return self.headers.get("X-Communication-Replica", "?")

    @property
    def location(self):
        return self.headers.get("Location", "")

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.body or b"{}")


class Client:
    def __init__(self, who):
        self.who, self.cookies, self.csrf = who, {}, None
        self.opener = urllib.request.build_opener(_NoRedirect())

    def call(self, url, method="GET", body=None, headers=None, timeout=60):
        hdrs, data = dict(headers or {}), None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        if self.cookies:
            hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            r = self.opener.open(req, timeout=timeout)
            status, rh, payload = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, rh, payload = e.code, e.headers, e.read()
        for line in rh.get_all("Set-Cookie") or []:
            name, _, value = line.split(";", 1)[0].partition("=")
            if value in ("", "deleted"):
                self.cookies.pop(name.strip(), None)
            else:
                self.cookies[name.strip()] = value
        return Resp(status, rh, payload, url)

    def get(self, base, path, **kw):
        return self.call(base + path, **kw)

    def post(self, base, path, body=None):
        return self.call(base + path, method="POST", body={} if body is None else body,
                         headers={"Origin": LB, "X-CSRF-Token": self.csrf or ""})

    def put(self, base, path, body):
        return self.call(base + path, method="PUT", body=body,
                         headers={"Origin": LB, "X-CSRF-Token": self.csrf or ""})

    def patch(self, base, path, body):
        return self.call(base + path, method="PATCH", body=body,
                         headers={"Origin": LB, "X-CSRF-Token": self.csrf or ""})

    def me(self, base=LB):
        r = self.get(base, "/api/v1/me")
        if r.status == 200:
            self.csrf = r.json().get("csrf_token")
        return r


def login(client):
    r = client.call(LB + "/auth/login?return_to=/projects")
    authz = r.location
    form = client.call(authz)
    if 'name="username"' not in form.text:
        check(f"{client.who}: IdP served its form", False, str(form.status))
        return None
    body = urllib.parse.urlencode({"username": client.who,
                                   "claims": json.dumps({"email": f"{client.who}@example.test"})}).encode()
    posted = client.call(authz, method="POST", body=body,
                         headers={"Content-Type": "application/x-form-urlencoded"
                                  .replace("x-form", "x-www-form")})
    cb = posted.location
    parts = urllib.parse.urlsplit(cb)
    client.call(LB + parts.path + ("?" + parts.query if parts.query else ""))
    me = client.me()
    if me.status != 200 or "communication_session" not in client.cookies:
        check(f"{client.who}: signed in", False, str(me.status))
        return None
    d = me.json()
    print(f"  [{client.who:6s}|{me.replica}] signed in id={d['id']}", flush=True)
    return d


# --- stack lifecycle ---------------------------------------------------------


def prepare_host_dirs():
    """compose.harness.yml's host prep, extended for two workers + fixtures.
    Docker would create a missing bind source root-owned; these must be ours."""
    for d in (".harness/workspaces", ".harness/home-a", ".harness/home-b",
              ".harness/remotes", ".harness/apm-upstream",
              ".harness/m4-fixtures"):
        os.makedirs(os.path.join(REPO_DIR, d), exist_ok=True)


def ensure_fixture_repo():
    """Regenerate the disposable fixture (file:///srv/m4/fixtures/app.git)."""
    rc, out = run(["bash", os.path.join(REPO_DIR, "e2e", "m4", "make_fixture_repo.sh"),
                   FIXTURE_HOST])
    return check("fixture repo generated (bare, intentionally failing pytest)", rc == 0,
                 out.replace("\n", " | ")[-240:])


def stack_up(build=True):
    prepare_host_dirs()
    if not ensure_fixture_repo():
        return False
    cmd = COMPOSE + ["up", "-d"] + (["--build"] if build else [])
    rc, out = run(cmd)
    show("compose up -d --build", out[-400:])
    return check("stack up", rc == 0)


def stack_down():
    """Project-scoped teardown only (§ 7.0): down -v removes this project's
    containers/network/volumes/images — never docker system prune."""
    rc, out = run(COMPOSE + ["down", "-v", "--remove-orphans"])
    show("compose down -v --remove-orphans", out[-300:])
    return check("stack down", rc == 0)


def wait_ready(timeout=180, hard=True):
    """hard=True (we were asked to bring the stack up) => readiness is a FAIL
    line; hard=False => an honest note, since the skeleton gates SKIP anyway."""
    probe = Client("probe")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ra = probe.get(A, "/api/v1/system/readiness")
            rb = probe.get(B, "/api/v1/system/readiness")
            if ra.status == rb.status == 200:
                print(f"  stack ready schema={ra.json().get('schema_version')}", flush=True)
                return True
        except Exception:  # noqa: BLE001 — readiness probe, retry is the point
            pass
        time.sleep(2)
    if hard:
        return check("stack ready (both replicas /system/readiness 200)", False)
    print("  NOTE stack not reachable — gates below can only SKIP (honest, not green)",
          flush=True)
    return False


# --- throwaway worker (M3's shape, M4 names/volumes) --------------------------


def start_throwaway(name, enforcement, repos_volume=None):
    """A THROWAWAY worker container — its own name, scratch dirs, artifact
    root and (optionally) its OWN repos volume for C6e's cross-volume arm;
    only the read-mostly state (workspace bind, remotes, keyring, agent
    logins) is shared. Removed by stop_throwaway; the stack's worker-a/b are
    never reconfigured."""
    scr = os.path.join(SCRATCH, name)
    for d in ("sandbox-home", "sandbox-policy", "sandbox-selftest", "home", "artifacts"):
        os.makedirs(os.path.join(scr, d), exist_ok=True)
    vol = f"communication-m4-{name}-repos" if repos_volume else f"{scr}/repos"
    if repos_volume:
        run(["docker", "volume", "create", vol])  # idempotent; removed by stop
    run(["docker", "rm", "-f", name])  # dead leftover of a prior attempt, by name
    cmd = ["docker", "run", "-d", "--name", name,
           "--network", NETWORK,
           "-u", f"{os.getuid()}:{os.getgid()}",
           "-v", f"{WS_BIND}:/workspaces",
           "-v", f"{vol}:/repos",
           "-v", f"{FIXTURE_HOST}:/srv/m4/fixtures:ro",
           "-v", f"{REMOTES}:{REMOTES}:ro",
           "-v", f"{scr}/sandbox-home:/sandbox-home",
           "-v", f"{scr}/sandbox-policy:/sandbox-policy",
           "-v", f"{scr}/sandbox-selftest:/sandbox-selftest",
           "-v", f"{scr}/home:/harness/home",
           "-v", f"{scr}/artifacts:/artifacts",
           "-v", f"{MASTERKEYS_VOL}:/keyring:ro",
           "-v", f"{os.path.expanduser('~/.claude')}:/harness/claude",
           "-v", f"{os.path.expanduser('~/.codex')}:/harness/codex",
           "-e", "HOME=/harness/home",
           "-e", "COMMUNICATION_DATABASE_URL=postgres://communication@postgres:5432/communication?sslmode=disable",
           "-e", f"COMMUNICATION_WORKER_NAME={name}",
           "-e", "COMMUNICATION_WORKER_HEARTBEAT=10s",
           "-e", "COMMUNICATION_WORKSPACE_ROOT=/workspaces",
           "-e", "COMMUNICATION_REPOS_ROOT=/repos",
           "-e", "COMMUNICATION_ARTIFACT_ROOT=/artifacts",
           "-e", "COMMUNICATION_ARTIFACT_BACKEND=local",
           "-e", "COMMUNICATION_SECRET_KEYRING=/keyring",
           "-e", f"COMMUNICATION_SANDBOX_ENFORCEMENT={enforcement}",
           "-e", "COMMUNICATION_SANDBOX_HOME=/sandbox-home",
           "-e", "COMMUNICATION_SANDBOX_POLICY_DIR=/sandbox-policy",
           "-e", "COMMUNICATION_SANDBOX_SELFTEST_DIR=/sandbox-selftest",
           "-e", "COMMUNICATION_AGENT_GIT_NAME=Communication Worker",
           "-e", "COMMUNICATION_AGENT_GIT_EMAIL=worker@communication.invalid",
           "-e", "CLAUDE_CONFIG_DIR=/harness/claude",
           "-e", "CODEX_HOME=/harness/codex",
           "--entrypoint", "/bin/sh", "communication-worker:dev",
           "-c", "exec communication worker"]
    rc, out = run(cmd)
    check(f"throwaway {enforcement} worker {name} started", rc == 0, out[-200:])
    return name


def stop_throwaway(name, repos_volume=False):
    rc, out = run(["docker", "rm", "-f", name])
    if repos_volume:
        run(["docker", "volume", "rm", f"communication-m4-{name}-repos"])
    show(f"throwaway {name} removed", out or f"rc={rc}")


def wait_worker_row(name, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        row = psql(f"SELECT id || ' ' || sandbox_enforcement || ' ' || capacity::text "
                   f"FROM workers WHERE name = '{name}' ORDER BY started_at DESC LIMIT 1")
        if row:
            parts = row.split()
            return parts[0], parts[1], parts[2]
        time.sleep(2)
    return None, None, None


# --- gates: docs/m4-contract.md § 7.1 (C1–C14) -------------------------------
# Each gate becomes real by replacing its skip() with the assertions in its
# docstring, pasting literal output via show(). Docstrings condense the
# contract's § 7 text; the contract remains the authority.


def c1():
    """C1 — the sample runs end to end, twice, deterministically.
    Acceptance: agent-driven § 9.3 pipeline AND its process.exec twin; 201 queued,
    alice approves the gate, terminal status completed; the full node_instance_key
    set (/plan /approve /implement /test /review /build_until_verified[2]/{…}
    /publish_evidence) all succeeded; run_inputs 2 validated rows; the run's
    revision_digest/plan_digest match the revision row verbatim; run_checkpoints
    count = succeeded worker node executions; review-evidence.md artifact bytes
    + redaction_count=0; run.completed result_bindings carry implementation_summary,
    review_approved=true, iterations=2 (twin); journal sequence contiguous; a
    second run yields an identical key set and identical plan_digest."""
    skip("C1", "sample pipeline completes twice on the disposable repo, digests pinned")


def c2():
    """C2 — the unit of work is the attempt, not the turn (invariant 5 + node_attempt).
    Acceptance: during the implement attempt the sentinel is in /proc/<agent>/environ
    and NOT as a .env file; after the boundary secret_materializations.cleaned_at is
    set by the worker; SENTINEL-m4-7c1e9d42 appears in zero domain_events/audit_events
    rows, zero artifact bytes, zero container logs, zero mirror refs; the reviewer
    attempt's prompt contains no DATABASE_URL."""
    skip("C2", "secret sentinel lives only in the authorized attempt's live environment")


def c3():
    """C3 — two workers claim one ready attempt; only one fencing token commits (12 case 2).
    Acceptance: with worker-a capacity 3 / worker-b capacity 1 and the C8 fan-out
    queue deep, every attempt_number has leased<=1 and never two distinct workers;
    one /implement attempt claimed exactly once (count(distinct worker_id)=1),
    fencing_token>0, max(fencing_token) = claim count; record the negative-control
    sentence: the claim is not exactly-once execution — the fence is (C4 proves it)."""
    skip("C3", "contended claims hand out once; the sequence draws per claim")


def c4():
    """C4 — worker loses its lease but keeps running; the stale write is rejected (12 case 3).
    Acceptance: `compose pause worker-a` for 45s freezes renewals; reconciler writes
    interrupted{lease_expired}; the woken worker's own log shows the fence refusal;
    the dead attempt has no outputs/finished_at/artifact/checkpoint/completed event;
    the replacement attempt's fencing_token is strictly greater; attempt N+1 succeeds
    and the run completes; the fenced turn adds no transcript after unpause."""
    skip("C4", "stale-owner writes are refused by the fence, provable by token order")


def c5():
    """C5 — THE exit gate: kill the worker mid-node, retry from the last checkpoint (12 case 5).
    Acceptance: on the deterministic twin, `compose kill worker-a` during a ~40s
    process.exec; reconciler writes interrupted (never the dead process); checkpoints
    and ready artifacts survive byte-identical; `up -d worker-a` reclaims the SAME
    workspace on repos-a (no recovery_lost); POST /runs/{id}/retry appends attempt 2
    with retry_context{head_commit, modified_path_count}; continue_workspace is the
    DEFAULT — HEAD unchanged and dirty edits preserved; run completes with the same
    node_instance_key set; the maxAttempts=1 arm fails the run honestly."""
    skip("C5", "docker kill mid-node → interrupted → bounded retry → completed, same volume")


def c6():
    """C6 — restore_checkpoint, and the honest loss case (D-009/D-024).
    Acceptance: a revision with retry.workspacePolicy=restore_checkpoint; after kill+
    retry, run.checkpoint_restored{from_commit, discarded_paths} and the worktree
    reset clean BEFORE anything execs; uncommitted-boundary retry => 409
    checkpoint_unavailable with NOTHING reset; cross-volume arm (worker-c on a new
    volume): workspace.recovery_lost{volume_changed|different_worker}, error_class
    workspace_lost, NO auto-retry; D-024 stays Open — no portable-checkpoint claim."""
    skip("C6", "restore_checkpoint reset is real; the loss arm says 'lost', never 'resumed'")


def c7():
    """C7 — `until` never passes (12 case 7).
    Acceptance: no-op implementer twin, maxIterations 3 => run failed|until_exhausted;
    exactly 3x3 body node rows, all terminal; node.scope.iteration x3 with
    pass_when_result=false then node.scope.failed{until_exhausted, evidence[]} and
    run.failed with evidence_artifacts; an indeterminate passWhen is predicate_error
    (scope fails at once, NEVER counted false); carryForward: `previous` empty on
    iteration 1, non-empty on iteration 2, echoed in the twin's prompt."""
    skip("C7", "bounded until terminates by exhaustion with per-iteration evidence")


def c8():
    """C8 — fan-out: zero items, and 25 children with one failing (12 case 8).
    Acceptance: issue-implementation pipeline via for_each -> pipeline.invoke,
    maxConcurrency 3; zero items: scope succeeded with items:0; 25 items => 25 invoke
    rows + 25 pipeline_invocations, depth 1, project inherited; max concurrently
    running <= 3 measured from the journal, across BOTH workers' capacity split;
    item 13 fails: collect_and_continue keeps 24 siblings, stop cancels queued and
    PRESERVES completed, fail_after_all runs all 25; self-invoke => child_depth_exceeded
    and a third level refused by runs_depth_check; mid-fan-out cancel cascades;
    cancelPolicy: detach refused at validate (unsupported_policy)."""
    skip("C8", "for_each 0/25 items with bounded concurrency, child failure policies, cascade")


def c9():
    """C9 — durable gates, and the approver who lost access (12 case 9).
    Acceptance: while /approve waits there are ZERO attempts and no lease, run is
    waiting_human, scheduler excludes it from active_attempts; a contributor's decide
    is 403 + approval.denied{not_a_designated_approver} with the gate still pending;
    a maintainer REMOVED from the project is refused at decision time
    {approver_lost_access} with CAS version unchanged; two maintainers: exactly one
    200, the other 409 approval_already_decided; rejection is a BUSINESS outcome
    (succeeded|rejected, dependants skipped); only a timeout is execution-side
    (approval_expired; expire re-requests exactly once); take-control pauses the run
    and return-control resumes with the intervention as retry_context."""
    skip("C9", "gates hold no lease; authorization is checked at decision time")


def c10():
    """C10 — a malformed reviewer reply does not read as 'not approved' (ADR-0022 § 4).
    Acceptance: {approved:'yes'} against a boolean schema => failed|invalid_output
    with JSON-Schema locations in output_errors and no node.attempt.completed;
    during the failure the scope's routing never changed (the silent false-coercion
    was never reached — outputs are schema-validated first); retry gets it right;
    the same reply via model.chat fails identically — the boundary owns the guarantee."""
    skip("C10", "schema validation precedes every expression; coercion is unrepresentable")


def c11():
    """C11 — prompt-injection egress probe (this contract creates the vector; this contract tests it).
    Acceptance: the collector on host 18099 logs every request; the planner echoes
    an injected issue body telling the agent to fetch http://172.17.0.1:18099/?d=…;
    the interpolated text reaches the implementer's prompt verbatim (vector proven);
    `compose logs collector` contains ZERO SENTINEL-m4-7c1e9d42 and ZERO
    fencing/lease_expires matches; if ANYTHING arrived, sandbox.verified's
    network_enforced=false is reported in the clear (M3's SANDBOX.md row stands)."""
    skip("C11", "injected fetch reaches the collector with no sentinel and no fence values")


def c12():
    """C12 — the subset cannot be widened by authoring; a revision cannot move under a run (12 case 11).
    Acceptance: exists()/now()/matches()/workspace.* each fail validate
    (cel_function_not_allowed / undeclared_root); 65 expressions =>
    expression_budget_exceeded; 1001 items => fanout_items_exceeded; over-budget
    node executions => node_execution_budget_exceeded; publishing a NEW revision
    mid-run leaves the run's digests and node outputs byte-identical, and
    re-pinning an assignment affects only NEW runs; byte-identical republish =>
    409 revision_already_published while a semantic change publishes normally;
    whitespace-only wording moves revision_digest but not plan_digest; a passWhen
    operator moves both."""
    skip("C12", "validate-time refusals; runs pinned to (revision_digest, plan_digest)")


def c13():
    """C13 — the refusals are real (12 case 13's genre: nothing silently half-works).
    Acceptance: parallel/join/gate/git.commit/git.publish/integration.query/
    integration.action => seven kind_not_implemented errors naming their milestone,
    status invalid; the config-typo probes each yield the exact § 2.2 error with a
    location; config.env with a secret URL => 422 secret_literal_detected, redacted,
    unpublishable; one expression per declared CEL root compiles and `loop` is
    refused with undeclared_root; sessionMode continue_live => unsupported_session_mode;
    /system/scheduler says resource limits are NOT implemented, in words."""
    skip("C13", "every deferred kind, typo and literal is refused at validate, loudly")


def c14():
    """C14 — control-plane rolling update during a live run (12 case 4, advancer as writer).
    Acceptance: restart both API replicas mid-twin and the SSE stream reconnects with
    Last-Event-ID gapless; force both replicas to advance the SAME run — no duplicated
    terminal event and no duplicated succeeded key (row locks make the loser a no-op);
    a replica with COMMUNICATION_PIPELINE_SCHEDULER=off serves reads, never claims or
    advances, its run stays queued for the other replica, and with the flag off
    everywhere M2/M3 behaviour is fully intact."""
    skip("C14", "replica restarts and the two-replica advance race change nothing")


# --- gates: docs/m4-contract.md § 7.2 (W1–W11, Playwright legs) --------------
# Driven with `pnpm dlx @playwright/cli`; screenshots stay in .playwright-cli/
# and are never committed (AGENTS.md).


def _playwright_stub(gid, intent):
    skip(gid, f"Playwright leg: {intent}")


def w1():
    """W1 — the New-run form renders from spec.inputs (goal textarea, repository
    select, acceptance-criteria with default); the POST carries the Idempotency-Key
    header; a second Submit click creates ONE run."""
    _playwright_stub("W1", "run form generated from spec.inputs; idempotent submit")


def w2():
    """W2 — live run page: run.created -> node.attempt.started ->
    conversation.turn.* -> run.checkpoint_saved render in order, no gap;
    /build_until_verified[1] and [2] show as ITERATIONS, not duplicate nodes."""
    _playwright_stub("W2", "event stream renders live, iterations not duplicated nodes")


def w3():
    """W3 — gate card: approver roles, deadline countdown, artifact links;
    alice's Approve posts /decide; bob sees the card with NO button and the
    'not a designated approver' line (C9b's UI arm)."""
    _playwright_stub("W3", "gate card: designated approver sees a button, others don't")


def w4():
    """W4 — publish a new revision while the run is live; the run page keeps
    the PINNED digests and shows the 'revision N+1 published since this run
    started — pinned to N' notice (12 case 11 made visible)."""
    _playwright_stub("W4", "pinned-digest notice after a mid-run republish")


def w5():
    """W5 — docker kill worker-a (C5) watched in the browser: interrupted
    'the worker disappeared mid-node', then the retry countdown, then attempt 2.
    The words 'resumed'/'restored'/'no data lost' appear NOWHERE; no console
    error, no stuck spinner."""
    _playwright_stub("W5", "kill -> honest interrupted wording, no 'resumed' anywhere")


def w6():
    """W6 — the C6e different-volume run says 'prior edits lost, rerun
    required' with a workspace_lost chip and NO auto-retry offered (M3 W8's
    rule, unchanged wording)."""
    _playwright_stub("W6", "cross-volume loss says 'lost', never 'resumed'")


def w7():
    """W7 — Ops page: § 6.2 counters (queued/running/waiting attempts, lease
    expirations, retry loops, queued_unbindable_runs, per-worker
    active_attempts/capacity); an offline worker makes the page say the run is
    'waiting for its worker' in those words."""
    _playwright_stub("W7", "scheduler counters and the honest waiting-for-worker state")


def w8():
    """W8 — the YAML Validate panel renders every loader/schema/compiler error
    with instance_location on the document, its source, and the hint;
    kind_not_implemented names M5/M6; secret-literal findings render redacted."""
    _playwright_stub("W8", "validate panel: located errors by source, redacted literals")


def w9():
    """W9 — as carol (project B only), deep-linking the M4 run id, /nodes,
    /approvals/{id} and the run SSE URL gives 404/not-found states, no project
    name, no node names, no digests, SSE never opens, console clean
    (12 case 15 extended to the new surface)."""
    _playwright_stub("W9", "cross-project deep links 404 with zero leakage")


def w10():
    """W10 — reload mid-run, reconnect with Last-Event-ID, roll an API
    replica (C14a): continuity across the new event types, no gap, no
    cross-project event."""
    _playwright_stub("W10", "stream continuity across a replica roll")


def w11():
    """W11 — the C8 child-run tree renders depth-1 children with statuses;
    one node execution's attempt list shows attempt 1 interrupted with
    retry_context and attempt 2 succeeded; fencing_token / lease_expires_at /
    worker_id appear NOWHERE in the DOM (ADR-0016 § 8 re-asserted)."""
    _playwright_stub("W11", "tree + attempt list, internals absent from the DOM")


GATES = [("C1", c1), ("C2", c2), ("C3", c3), ("C4", c4), ("C5", c5),
         ("C6", c6), ("C7", c7), ("C8", c8), ("C9", c9), ("C10", c10),
         ("C11", c11), ("C12", c12), ("C13", c13), ("C14", c14),
         ("W1", w1), ("W2", w2), ("W3", w3), ("W4", w4), ("W5", w5),
         ("W6", w6), ("W7", w7), ("W8", w8), ("W9", w9), ("W10", w10),
         ("W11", w11)]


# --- main --------------------------------------------------------------------


def finish():
    step("summary")
    print(f"  FAIL={len(FAILURES)}  GAP={len(GAPS)}  "
          f"SKIP={len(SKIPPED)}/{len(GATES)} gates", flush=True)
    for f in FAILURES:
        print(f"  FAILED  {f}", flush=True)
    for g in GAPS:
        print(f"  GAP     {g}", flush=True)
    if SKIPPED:
        print("  NOTE: SKIP count > 0 means this run is a SKELETON, not an "
              "acceptance run — § 7 gates report real output before M4 is called done.",
              flush=True)
    return 1 if FAILURES else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--up", action="store_true",
                    help="prepare host dirs + fixture, compose up -d --build")
    ap.add_argument("--down", action="store_true",
                    help="tear the project down at the end (down -v, project-scoped)")
    ap.add_argument("--no-build", action="store_true",
                    help="with --up, skip --build (reuse current images)")
    ap.add_argument("--ready", action="store_true",
                    help="wait for both replicas' readiness before running gates")
    ap.add_argument("--only", metavar="IDS",
                    help="comma-separated gate ids to run (default: all)")
    ap.add_argument("--list", action="store_true",
                    help="print the gate table and exit")
    args = ap.parse_args(argv)

    if args.list:
        for gid, fn in GATES:
            print(f"{gid:4s} {fn.__doc__.strip().splitlines()[0]}")
        return 0

    sel = {s.strip().upper() for s in args.only.split(",")} if args.only else None

    if args.up:
        step("stack: host prep, fixture repo, compose up")
        if not stack_up(build=not args.no_build):
            if args.down:
                stack_down()
            return finish()

    if args.up or args.ready:
        step("stack: readiness")
        if not wait_ready(hard=True):
            if args.down:
                stack_down()
            return finish()
    else:
        # Skeleton default: a five-second informational probe. Absent stack
        # prints a NOTE, never a FAIL — the SKIP lines below carry the honesty.
        step("stack: readiness (informational)")
        wait_ready(timeout=5, hard=False)

    step("§ 7 gates (skeleton: every verdict is an honest SKIP until implemented)")
    for gid, fn in GATES:
        if sel and gid not in sel:
            continue
        step(f"{gid} — {fn.__doc__.strip().splitlines()[0]}")
        fn()

    if args.down:
        step("teardown")
        stack_down()

    return finish()


if __name__ == "__main__":
    sys.exit(main())
