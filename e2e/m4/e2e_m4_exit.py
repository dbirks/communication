#!/usr/bin/env python3
"""M4 exit proof — STACK SKELETON (docs/m4-contract.md § 7).

Status: the lifecycle, fixtures and helpers below are real. C1 is the real
§ 7.1 proof — seed-manifest driven, honestly SKIPping until a live stack and
a seed-manifest.json exist, deterministic once the stack answers; its pure
logic is unit-tested offline by e2e/m4/test_c1_logic.py. Every other gate
(C2–C14, W1–W11) prints `SKIP (pending)` with its one-line intent. No gate
here may ever print PASS without the literal Postgres/API output its § 7
docstring names (12-test-strategy.md: a mocked or inferred green is not done).

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
  python3 e2e/m4/e2e_m4_exit.py [--up] [--seed] [--down] [--only C1,C5,W2] [--list]
  (run from the repository root; --up prepares .harness dirs + the fixture
  repo and builds; --seed shells out to the § 7.0 seed.sh contract and parses
  its manifest; --down tears the project down at the end, even on failure)
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
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

# § 7.0 seed contract: the driver shells out to the probe's seed.sh and reads
# its manifest; M4_SEED_MANIFEST overrides the path exactly as seed.sh's does.
SEED_SH = os.path.join(REPO_DIR, "docs", "compatibility", "probes", "m4", "seed.sh")
MANIFEST_PATH = os.environ.get("M4_SEED_MANIFEST") or os.path.join(
    SCRATCH, "seed-manifest.json")

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
              ".harness/m4-fixtures", ".harness/m4-fixtures/bin"):
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
           "-v", f"{FIXTURE_HOST}/bin:/opt/m4/bin:ro",
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
           "-c", "export PATH=/opt/m4/bin:$PATH; exec communication worker"]
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


# --- C1 pure logic — unit-tested offline by e2e/m4/test_c1_logic.py -----------
# Nothing below this line may touch the stack: manifest normalization, key-set
# algebra, SSE frame parsing, journal-shape and result-binding assertions all
# run against canned fixtures so most of C1 is proven WITHOUT a server.

FD_SLUG = "feature-development"
TW_SLUG = "feature-development-deterministic"
II_SLUG = "issue-implementation"

# § 7.1 C1d's root key set for the seeded pipeline: the when-gated fan-out
# pair and the losing publish arm exist as TERMINAL `skipped` rows (the
# pipeline.yaml header says so in words: "appear as node.execution_skipped
# exactly like publish_needs_attention already does").
C1_ROOT_KEYS = {
    "/plan": "succeeded",
    "/approve": "succeeded",
    "/build_until_verified": "succeeded",
    "/emit_items": "skipped",
    "/fan_out": "skipped",
    "/verdict": "succeeded",
    "/publish_verified": "succeeded",
    "/publish_needs_attention": "skipped",
}


def expected_node_keys(iterations):
    """The full node_instance_key -> expected terminal status map for an
    until-loop run that passed at `iterations` (iteration body rows carry the
    [n] suffix; the loop itself is the unsuffixed composite row)."""
    keys = dict(C1_ROOT_KEYS)
    for i in range(1, iterations + 1):
        for n in ("implement", "test", "review"):
            keys[f"/build_until_verified[{i}]/{n}"] = "succeeded"
    return keys


def observed_iterations(keys):
    """Highest /build_until_verified[n]/… suffix seen in a key set (0 if none)."""
    ns = [int(m.group(1)) for k in keys if (m := re.match(r"^/build_until_verified\[(\d+)\]", k))]
    return max(ns) if ns else 0


def collapse_iterations(keys):
    """/build_until_verified[2]/review -> …[*]/review — the iteration-counter-
    free view of a key set (the stable cross-variant identity: equal node ids,
    equal scopes, whatever iteration count each variant spent)."""
    return {re.sub(r"\[\d+\]", "[*]", k) for k in keys}


def compare_key_sets(a, b):
    """(identical, only_in_a, only_in_b) with the diffs sorted for the print."""
    sa, sb = set(a), set(b)
    return sa == sb, sorted(sa - sb), sorted(sb - sa)


class SseFrames(list):
    """Parsed SSE envelopes plus a `_junk` note: data frames that arrived but
    were not JSON — reported, never crashy (a malformed observer frame is a
    fact about the stream, not a verdict on the run)."""
    _junk: list


def parse_sse(text):
    """Standard SSE framing (communication-spec/09): id:/event: fields and
    ': heartbeat' comments are consumed; blank line dispatches the data as
    JSON. Returns the parsed envelopes in stream order."""
    events, junk, buf = SseFrames(), [], []
    for line in text.splitlines():
        if line.startswith(":"):
            continue
        if line == "":
            if buf:
                raw = "\n".join(buf)
                buf = []
                try:
                    events.append(json.loads(raw))
                except ValueError:
                    junk.append(raw[:120])
            continue
        if line.startswith("data:"):
            buf.append(line[5:].lstrip())
    if buf:  # stream closed on an un-dispatched final frame
        try:
            events.append(json.loads("\n".join(buf)))
        except ValueError:
            junk.append("\n".join(buf)[:120])
    events._junk = junk
    return events


# Envelope correlation rules (openapi run-events description, stated once):
# a worker row that touches a node execution sets run_id + node_execution_id
# + attempt_id; the control plane may carry node_execution_id with attempt_id
# NULL because control-plane work creates no attempts (ADR-0023 § 3).
ATTEMPT_CORRELATED_TYPES = {
    "node.attempt.started", "node.attempt.completed", "node.attempt.failed",
    "node.attempt.interrupted", "node.attempt.cancelled",
    "node.attempt.retry_scheduled",
}
CONTROL_PLANE_GATE_TYPES = {"approval.requested", "approval.decided"}

# § 7.1 C1h: the milestone chain that must appear, first-occurrence by
# first-occurrence, run.created to run.completed. node.attempt.* is asserted
# separately (it legitimately opens the story at /plan, before the gate);
# the GATE-then-EXECUTE order is what the chain pins.
JOURNAL_MILESTONES = ["run.created", "approval.requested", "approval.decided",
                      "run.checkpoint_saved", "node.scope.completed", "run.completed"]


def journal_shape(rows):
    """C1h over one run's journal slice — rows are dicts
    {global_seq, type, node_execution_id, attempt_id}. Returns
    [(label, ok, detail)] for the gate's CHECK lines; pure."""
    out = []
    types = [r["type"] for r in rows]
    seqs = [int(r["global_seq"]) for r in rows]
    out.append(("journal non-empty", bool(rows), f"{len(rows)} rows"))
    out.append(("journal opens with run.created",
                bool(types) and types[0] == "run.created", str(types[:1])))
    out.append(("journal closes with run.completed",
                bool(types) and types[-1] == "run.completed", str(types[-1:])))
    regress = [(a, b) for a, b in zip(seqs, seqs[1:]) if b <= a]
    out.append(("run slice strictly ascending in global_seq (the run's own slice is "
                "the contiguity contract; global gaps belong to other runs)",
                not regress, f"{len(seqs)} rows, {len(regress)} regressions {regress[:3]}"))
    present = [m for m in JOURNAL_MILESTONES if m in types]
    firsts = [types.index(m) for m in present]
    out.append(("milestone chain run.created→approval.*→checkpoint→scope→completed",
                present == JOURNAL_MILESTONES and firsts == sorted(firsts),
                "seen: " + ",".join(present)))
    att_idx = [i for i, t in enumerate(types) if t in ATTEMPT_CORRELATED_TYPES]
    out.append(("node.attempt.* events present between the terminals",
                bool(att_idx) and 0 < min(att_idx) < len(types) - 1,
                f"{len(att_idx)} attempt rows"))
    viol = [(r["global_seq"], r["type"]) for r in rows
            if r["type"] in ATTEMPT_CORRELATED_TYPES
            and not (r["node_execution_id"] and r["attempt_id"])]
    out.append(("worker attempt rows carry node_execution_id AND attempt_id",
                not viol, str(viol[:4])))
    viol2 = [(r["global_seq"], r["type"]) for r in rows
             if r["type"] in CONTROL_PLANE_GATE_TYPES
             and (not r["node_execution_id"] or r["attempt_id"])]
    out.append(("control-plane gate rows: node_execution_id set, attempt_id NULL",
                not viol2, str(viol2[:4])))
    return out


def result_bindings_ok(rb, variant):
    """§ 7.1 C1g: implementation_summary non-empty, review_approved=true,
    iterations=2 (twin) / >=2 (agent). [(label, ok, detail)] — pure."""
    rb = rb if isinstance(rb, dict) else {}
    s = rb.get("implementation_summary")
    it = rb.get("iterations")
    out = [
        ("result_bindings.implementation_summary non-empty",
         isinstance(s, str) and s.strip() != "", repr(s)[:90]),
        ("result_bindings.review_approved == true",
         rb.get("review_approved") is True, repr(rb.get("review_approved"))),
    ]
    if variant == "twin":
        out.append(("result_bindings.iterations == 2 (twin is deterministic)",
                    it == 2, repr(it)))
    else:
        out.append(("result_bindings.iterations >= 2 (agent, § 7.1 C1g)",
                    isinstance(it, int) and not isinstance(it, bool) and it >= 2,
                    repr(it)))
    return out


def validate_manifest(obj):
    """seed-manifest/1 (docs/compatibility/probes/m4/README.md) -> the facts C1
    consumes without re-deriving anything: {agent|twin: {project_id,
    pipeline_id, revision_id, revision_digest, plan_digest, assignment_id,
    run_id, inputs}}. Raises ValueError naming the missing member — the loud
    abort on a manifest that is absent-shaped wrong."""
    if not isinstance(obj, dict):
        raise ValueError(f"manifest is {type(obj).__name__}, not an object")
    if obj.get("schema") != "m4-seed-manifest/1":
        raise ValueError(f"schema tag is {obj.get('schema')!r}, want m4-seed-manifest/1")
    project = obj.get("project") if isinstance(obj.get("project"), dict) else {}
    project_id = project.get("id")
    if not project_id:
        raise ValueError("project.id missing")
    pipes = obj.get("pipelines") if isinstance(obj.get("pipelines"), dict) else {}
    by_variant = {r.get("variant"): r for r in obj.get("runs") or [] if isinstance(r, dict)}

    def facts(slug, variant):
        p = pipes.get(slug)
        if not isinstance(p, dict):
            raise ValueError(f"pipelines.{slug} missing")
        for k in ("pipeline_id", "revision_id", "revision_digest", "plan_digest",
                  "assignment_id"):
            if not p.get(k):
                raise ValueError(f"pipelines.{slug}.{k} missing")
        run_id = p.get("run_id") or (by_variant.get(variant) or {}).get("run_id")
        if not run_id:
            raise ValueError(f"no {variant} run_id (pipelines.{slug}.run_id / runs[])")
        return {"project_id": project_id, "pipeline_id": p["pipeline_id"],
                "revision_id": p["revision_id"], "revision_digest": p["revision_digest"],
                "plan_digest": p["plan_digest"], "assignment_id": p["assignment_id"],
                "run_id": run_id,
                "inputs": (by_variant.get(variant) or {}).get("inputs") or {}}

    return {"agent": facts(FD_SLUG, "agent"), "twin": facts(TW_SLUG, "twin")}


# --- C1 live helpers — the stack-facing half -----------------------------------


def load_manifest_facts():
    """Read + validate MANIFEST_PATH; None when absent (the SKIP path) and a
    CHECK-FAIL on a corrupt one (loud, never a crash)."""
    if not os.path.exists(MANIFEST_PATH):
        return None
    try:
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            facts = validate_manifest(json.load(f))
    except (ValueError, OSError) as e:
        check("seed manifest parses", False, f"{MANIFEST_PATH}: {e}")
        return None
    show("seed manifest (ids C1 consumes verbatim)",
         json.dumps({v: {k: f[k] for k in ("revision_id", "revision_digest",
                                           "plan_digest", "run_id")}
                     for v, f in facts.items()}, indent=1))
    return facts


def run_seed():
    """§ 7.0's seed contract from the driver: bash seed.sh -> MANIFEST_PATH.
    Loud abort when seed.sh is absent or the seed fails — a stale manifest is
    deleted first so an old file can never masquerade as a fresh seed."""
    if not os.path.isfile(SEED_SH):
        check("seed.sh present (§ 7.0 seed contract)", False, SEED_SH)
        return False
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    if os.path.exists(MANIFEST_PATH):
        os.remove(MANIFEST_PATH)
    env = dict(COMPOSE_ENV, M4_SEED_MANIFEST=MANIFEST_PATH, M4_URL=LB,
               M4_API_A=A, M4_API_B=B, M4_REPO_DIR=REPO_DIR)
    rc, out = run(["bash", SEED_SH], env=env)
    show(f"bash docs/compatibility/probes/m4/seed.sh (rc={rc})", out[-1600:])
    ok = rc == 0 and os.path.exists(MANIFEST_PATH)
    check("seed.sh seeded — manifest written", ok,
          "" if ok else f"rc={rc}, no manifest at {MANIFEST_PATH}: the SEED FAIL "
                        "lines above are the reason")
    return ok


class RunWatch:
    """The C1c 'watch' leg: hold the run SSE stream open in a daemon thread
    while the poll loop reads the ledger. The stream is an OBSERVER — a drop
    is recorded, never fatal, because domain_events in Postgres is the truth
    C1h re-reads wholesale. Thread appends only; the main thread reads after
    stop() (the daemon dies with the process if C1 aborts mid-stream)."""

    def __init__(self, client, run_id):
        self.client, self.run_id = client, run_id
        self.frames = []
        self.error = None
        self._stop = threading.Event()
        self._resp = None
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        self._thread.start()

    def _loop(self):
        url = LB + f"/api/v1/runs/{self.run_id}/events"
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "text/event-stream",
                "Cookie": "; ".join(f"{k}={v}" for k, v in self.client.cookies.items())})
            with urllib.request.urlopen(req, timeout=120) as resp:
                self._resp = resp
                parts, raw = [], b""
                while not self._stop.is_set():
                    chunk = resp.read(1)
                    if not chunk:
                        break
                    raw += chunk
                    if not raw.endswith(b"\n"):
                        continue
                    line, raw = raw[:-1], b""
                    text = line.decode("utf-8", "replace").rstrip("\r")
                    if text == "":
                        if parts:
                            try:
                                self.frames.append(json.loads("\n".join(parts)))
                            except ValueError:
                                pass
                            parts = []
                        continue
                    if text.startswith(":") or text.startswith("id:") or text.startswith("event:"):
                        continue
                    if text.startswith("data:"):
                        parts.append(text[5:].lstrip())
        except Exception as e:  # noqa: BLE001 — observer thread; the ledger poll decides
            if not self._stop.is_set():
                self.error = f"{type(e).__name__}: {e}"

    def stop(self):
        self._stop.set()
        try:
            if self._resp:
                self._resp.close()
        except Exception:  # noqa: BLE001 — close race with the daemon is fine
            pass
        self._thread.join(timeout=5)
        return self


def run_status(run_id):
    try:
        return psql(f"SELECT status FROM runs WHERE id = '{run_id}'")
    except RuntimeError as e:
        return f"PSQL_ERROR {e}"[:160]


def dump_run_evidence(client, run_id):
    """Failure honesty: dump the run row, the node tree and the last journal
    rows BEFORE the FAIL — an exit run that times out must arrive with its
    evidence already printed."""
    try:
        show(f"runs row {run_id}", psql(
            f"SELECT status || ' cause=' || COALESCE(failed_cause,'-') || "
            f"' rd=' || revision_digest || ' pd=' || plan_digest "
            f"FROM runs WHERE id = '{run_id}'"))
    except RuntimeError as e:
        show("runs row", str(e))
    try:
        show("node tree (ledger)", psql(
            f"SELECT node_instance_key || ' ' || kind || ' ' || execution_location || ' ' || "
            f"status || ' ' || COALESCE(outcome,'-') || ' att=' || attempt_count::text || "
            f"' ' || COALESCE(waiting_reason,'') FROM node_executions "
            f"WHERE run_id = '{run_id}' ORDER BY node_instance_key"))
    except RuntimeError as e:
        show("node tree", str(e))
    if client is not None:
        try:
            r = client.get(LB, f"/api/v1/runs/{run_id}/tree")
            show(f"GET /runs/{run_id}/tree", f"{r.status} {r.text[:600]}")
        except Exception as e:  # noqa: BLE001
            show("GET /runs/../tree", str(e))
    try:
        show("last 12 journal rows", psql(
            f"SELECT global_seq::text || ' ' || type || ' ' || "
            f"COALESCE(node_execution_id::text,'-') || ' ' || COALESCE(attempt_id::text,'-') "
            f"FROM domain_events WHERE run_id = '{run_id}' ORDER BY global_seq DESC LIMIT 12"))
    except RuntimeError as e:
        show("last journal rows", str(e))


def approve_gate(client, project_id, run_id):
    """C1b, silent half: find the run's pending gate through the frozen list
    route, re-read it for the CAS version, decide approved. True on the 200."""
    try:
        r = client.get(LB, f"/api/v1/projects/{project_id}/approvals")
        if r.status != 200:
            return False
        pend = [a for a in r.json().get("approvals", [])
                if a.get("run_id") == run_id and a.get("state") == "pending"]
        if not pend:
            return False
        cur = client.get(LB, f"/api/v1/approvals/{pend[0]['id']}")
        if cur.status != 200:
            return False
        gate = cur.json()
        d = client.post(LB, f"/api/v1/approvals/{gate['id']}/decide",
                        {"decision": "approved", "version": gate["version"],
                         "comments": "M4 exit C1b (docs/m4-contract.md § 7.1)"})
        return d.status == 200
    except Exception:  # noqa: BLE001 — transient; the poll retries until the cap
        return False


def watch_run(client, facts, run_id, cap, label):
    """Poll to terminal via the ledger with the SSE stream watched alongside;
    alice's gate lands the moment the run waits. Returns (terminal status,
    watch) or (None, watch) after the cap — with the evidence dump already
    printed and the timeout CHECK already made."""
    watch = RunWatch(client, run_id)
    watch.start()
    approved, status, deadline = False, "", time.time() + cap
    while time.time() < deadline:
        status = run_status(run_id)
        if status in ("completed", "failed", "cancelled", "interrupted"):
            break
        if status == "waiting_human" and not approved:
            approved = approve_gate(client, facts["project_id"], run_id)
            if approved:
                check(f"C1b {label}: alice's gate decision -> 200", True, run_id)
        time.sleep(5)
    watch.stop()
    if status not in ("completed", "failed", "cancelled", "interrupted"):
        dump_run_evidence(client, run_id)
        check(f"{label}: terminal within {cap}s cap", False,
              f"last observed status={status!r} (tree + journal dumped above)")
        return None, watch
    ok = check(f"{label}: terminal status completed (§ 7.1 C1c)", status == "completed",
               f"observed {status!r}")
    if not ok:
        dump_run_evidence(client, run_id)
        return None, watch
    return status, watch


def post_c1_run(client, facts, idem, label):
    """§ 7.1 C1a: POST /api/v1/projects/{p}/runs pinned straight to the
    manifest's revision (the frozen route and RunCreate body from
    api/openapi.yaml); 201/queued or nothing."""
    body = {"pipeline_revision_id": facts["revision_id"],
            "inputs": facts["inputs"], "idempotency": idem}
    r = client.post(LB, f"/api/v1/projects/{facts['project_id']}/runs", body)
    if not check(f"C1a {label}: POST runs ({idem}) -> 201 queued",
                 r.status in (200, 201), f"{r.status} {r.text[:200]}"):
        return None
    d = r.json()
    check(f"C1a {label}: response status queued", d.get("status") == "queued",
          str(d.get("status")))
    return d.get("run_id")


def assert_c1_run(client, facts, run_id, variant, watch, label):
    """§ 7.1 C1d–C1h for one completed run. Every assertion is its own CHECK
    with the literal pasted; returns {keys, iterations, plan_digest} for the
    cross-run comparisons or None if the run did not survive the gauntlet."""
    ok_all = True

    # C1d — per-node terminal rows, from the LEDGER, not fixtures.
    rows = (psql(f"SELECT node_instance_key || '|' || kind || '|' || execution_location || '|' ||"
                 f" status || '|' || COALESCE(outcome,'-') || '|' || attempt_count::text"
                 f" FROM node_executions WHERE run_id = '{run_id}' ORDER BY node_instance_key")).splitlines()
    show(f"C1d {label}: node_executions ledger rows", "\n".join(rows) or "(none)")
    seen = {}
    for line in rows:
        parts = line.split("|")
        if len(parts) == 6:
            seen[parts[0]] = {"kind": parts[1], "loc": parts[2], "status": parts[3],
                              "outcome": parts[4], "attempt_count": int(parts[5])}
    iters = observed_iterations(set(seen))
    exp = expected_node_keys(iters)
    ident, only_a, only_b = compare_key_sets(set(seen), set(exp))
    ok_all &= check(f"C1d {label}: full node_instance_key set ({len(exp)} keys) from ledger rows",
                    ident, f"ledger_only={only_a} expected_only={only_b}")
    wrong = {k: v["status"] for k, v in seen.items() if v["status"] != exp.get(k)}
    ok_all &= check(f"C1d {label}: every node terminal at its expected status "
                    f"(succeeded / when-skipped)", not wrong, str(wrong))
    ctrl = {k: v["loc"] for k, v in seen.items()
            if k in ("/approve", "/verdict") and v["loc"] != "control_plane"}
    ctrl |= {k: v["loc"] for k, v in seen.items()
             if re.match(r"^/build_until_verified\[\d+\]/(implement|test|review)$", k)
             and v["loc"] != "worker"}
    ok_all &= check("C1d /approve,/verdict control_plane; loop bodies worker (two writers, "
                    "ADR-0023 § 3)", not ctrl, str(ctrl))

    # C1e — validated inputs, digests, checkpoints.
    n_inputs = int(psql(f"SELECT count(*) FROM run_inputs WHERE run_id = '{run_id}'") or 0)
    origins = psql(f"SELECT name || '=' || origin FROM run_inputs WHERE run_id = '{run_id}' "
                   f"ORDER BY name")
    ok_all &= check("C1e run_inputs: 5 validated rows (4 submitted + declared default; "
                    "README: read the manifest, not the old 2-rows prose)",
                    n_inputs == 5 and all(f"{n}=submitted" in origins
                                          for n in ("goal", "repository")),
                    f"count={n_inputs} origins={origins.splitlines()}")
    dig = psql(f"SELECT revision_digest || '|' || plan_digest || '|' || digest_scope "
               f"FROM runs WHERE id = '{run_id}'").strip().split("|")
    ok_all &= check(f"C1e run digests match the manifest (which came from publish) verbatim",
                    len(dig) == 3 and dig[0] == facts["revision_digest"]
                    and dig[1] == facts["plan_digest"] and dig[2] != "",
                    f"db={dig[:2]} manifest={[facts['revision_digest'][:18], facts['plan_digest'][:18]]}")
    api_run = client.get(LB, f"/api/v1/runs/{run_id}")
    ok_all &= check("C1e GET /runs/{id} agrees with the ledger (API says X, Postgres says X)",
                    api_run.status == 200 and api_run.json().get("revision_digest") == dig[0]
                    and api_run.json().get("plan_digest") == dig[1]
                    and api_run.json().get("status") == "completed",
                    f"{api_run.status}")
    ck = int(psql(f"SELECT count(*) FROM run_checkpoints WHERE run_id = '{run_id}'") or 0)
    sw = int(psql(f"SELECT count(*) FROM node_executions WHERE run_id = '{run_id}' "
                  f"AND execution_location = 'worker' AND status = 'succeeded'") or 0)
    ok_all &= check("C1e run_checkpoints == succeeded worker node executions", ck == sw > 0,
                    f"checkpoints={ck} succeeded_worker={sw}")
    t2 = psql(f"SELECT attempt_count::text FROM node_executions WHERE run_id = '{run_id}' "
              f"AND node_instance_key = '/build_until_verified[2]/test'").strip()
    if t2:
        ok_all &= check("C1e /build_until_verified[2]/test attempt_count = 1 (it failed the "
                        "BUSINESS way, not by retrying)", t2 == "1", f"attempt_count={t2}")

    # C1f — the published evidence artifact, readable through the M3 routes.
    arts = psql(f"SELECT id || ' ' || name || ' ' || kind || ' ' || media_type || ' ' ||"
                f" sha256 || ' ' || sensitivity || ' ' || redaction_count::text || ' ' || state"
                f" FROM artifacts WHERE run_id = '{run_id}'").splitlines()
    show(f"C1f {label}: artifacts journaled to the run", "\n".join(arts) or "(none)")
    ev = [a.split(" ") for a in arts
          if len(a.split(" ")) == 7 and a.split(" ")[1] == "review-evidence.md"]
    ok_all &= check("C1f review-evidence.md (markdown/text/markdown) published exactly once",
                    len(ev) == 1 and ev[0][2] == "markdown" and ev[0][3] == "text/markdown",
                    str([a[:4] for a in ev]))
    if ev:
        aid, sha = ev[0][0], ev[0][4]
        ok_all &= check("C1f redaction_count=0 and state=ready (ADR-0020 D4: 0 is the scanner "
                        "saying so, not silence)", ev[0][5] == "0" and ev[0][6] == "ready",
                        f"redaction={ev[0][5]} state={ev[0][6]}")
        meta = client.get(LB, f"/api/v1/artifacts/{aid}")
        body = client.get(LB, f"/api/v1/artifacts/{aid}/content")
        got = hashlib.sha256(body.body).hexdigest()
        ok_all &= check("C1f GET /artifacts/{id} + /content readable; bytes hash to the row's sha256",
                        meta.status == 200 and body.status == 200 and got == sha,
                        f"meta={meta.status} content={body.status} sha {got[:12]} vs {sha[:12]}")
        show("C1f artifact bytes (first line)", body.text.splitlines()[0] if body.text else "(empty)")
        j = int(psql(f"SELECT count(*) FROM artifacts a JOIN domain_events e "
                     f"ON e.payload->>'artifact_id' = a.id::text AND e.type = 'artifact.created' "
                     f"WHERE a.run_id = '{run_id}'") or 0)
        ok_all &= check("C1f artifact.created journaled (row+event in one transaction)", j > 0, f"n={j}")

    # C1g — run.completed result_bindings.
    raw = psql(f"SELECT payload->'result_bindings' FROM domain_events WHERE run_id = '{run_id}' "
               f"AND type = 'run.completed' LIMIT 1").strip()
    rb = json.loads(raw) if raw else {}
    show(f"C1g {label}: result_bindings", raw or "(none)")
    for lbl, ok, detail in result_bindings_ok(rb, variant):
        ok_all &= check(f"C1g {label}: {lbl}", ok, detail)
    it_rb = rb.get("iterations")
    ok_all &= check(f"C1g {label}: journal iterations agree with the ledger's last suffix",
                    it_rb == iters, f"rb={it_rb} ledger={iters}")

    # C1h — the event journal's shape and correlation discipline.
    jrows = []
    for line in psql(f"SELECT global_seq::text || '|' || type || '|' ||"
                    f" COALESCE(node_execution_id::text,'') || '|' ||"
                    f" COALESCE(attempt_id::text,'') FROM domain_events "
                    f"WHERE run_id = '{run_id}' ORDER BY global_seq").splitlines():
        p = line.split("|")
        if len(p) == 4:
            jrows.append({"global_seq": p[0], "type": p[1],
                          "node_execution_id": p[2] or None, "attempt_id": p[3] or None})
    for lbl, ok, detail in journal_shape(jrows):
        ok_all &= check(f"C1h {label}: {lbl}", ok, detail)
    show(f"C1h {label}: journal head/tail",
         "\n".join(f"{r['global_seq']} {r['type']}" for r in jrows[:3] + jrows[-3:]))
    types = {r["type"] for r in jrows}
    ok_all &= check("C1h run.checkpoint_saved rows exist per succeeded worker node",
                    sum(1 for r in jrows if r["type"] == "run.checkpoint_saved") >= sw,
                    f"events>={sum(1 for r in jrows if r['type'] == 'run.checkpoint_saved')} vs {sw}")

    # The SSE observer watched the same story as it happened.
    sse_types = [f.get("type") for f in watch.frames if isinstance(f, dict)]
    if watch.error:
        gap(f"C1c {label}: SSE observer", f"stream dropped ({watch.error}); ledger "
            "polling and the C1h re-read carried the proof — the run stream itself is W2/C14's subject")
    ok_all &= check(f"C1c {label}: SSE stream observed the opening and the closing event",
                    "run.created" in sse_types and "run.completed" in sse_types,
                    f"{len(sse_types)} frames seen")

    ok_all &= check(f"C1d {label}: no unexpected node kinds/keys (loop spent {iters} iteration(s))",
                    iters >= 1, str(iters))
    if not ok_all:
        dump_run_evidence(client, run_id)
    return {"keys": set(seen), "iterations": iters,
            "plan_digest": dig[1] if len(dig) == 3 else None}


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
    facts = CTX.get("manifest")
    if facts is None:
        facts = load_manifest_facts()
        if facts is None and CTX.get("stack_up"):
            if run_seed():
                facts = load_manifest_facts()
        elif facts is None and not CTX.get("stack_up"):
            CTX["c1_skip"] = True
        if facts is not None:
            CTX["manifest"] = facts
    if facts is None:
        if CTX.get("c1_skip"):
            # The honest pending path: no stack answered, so there is nothing
            # to prove against — never a crash, never an inferred green.
            skip("C1", "needs the live stack + seed.sh manifest; both variants "
                       "complete end to end on the disposable repo, key sets and "
                       "plan_digests asserted from ledger rows")
        return
    alice = CTX.get("alice") or Client("alice")
    if login(alice) is None and "communication_session" not in alice.cookies:
        check("C1: alice signed in", False, "no session — the gate cannot decide itself")
        return
    CTX["alice"] = alice
    suffix = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

    # ---- agent variant (C1a–C1h, cap 30 min) ----
    agent = facts["agent"]
    run_a = post_c1_run(alice, agent, f"m4x-c1-agent-{suffix}", "agent")
    res_a = None
    if run_a:
        status, watch = watch_run(alice, agent, run_a, 1800, "agent")
        if status:
            res_a = assert_c1_run(alice, agent, run_a, "agent", watch, "agent")

    # ---- deterministic twin: finish the seeded run, then RE-RUN the variant ----
    tw = facts["twin"]
    res_tw_seed = None
    status, watch = watch_run(alice, tw, tw["run_id"], 600, "twin(seed)")
    if status:
        res_tw_seed = assert_c1_run(alice, tw, tw["run_id"], "twin", watch, "twin(seed)")
    run_tw = post_c1_run(alice, tw, f"m4x-c1-twin-{suffix}", "twin(replay)")
    res_tw = None
    if run_tw:
        status, watch = watch_run(alice, tw, run_tw, 300, "twin(replay)")
        if status:
            res_tw = assert_c1_run(alice, tw, run_tw, "twin", watch, "twin(replay)")

    # ---- C1i — replay identity + the cross-variant key-set proof ----
    if res_tw_seed and res_tw:
        ident, oa, ob = compare_key_sets(res_tw_seed["keys"], res_tw["keys"])
        check("C1i twin re-run: node_instance_key SET identical (ledger rows, exact)",
              ident, f"seed_only={oa} replay_only={ob}")
        check("C1i twin re-run: plan_digest identical (seed == replay == manifest)",
              res_tw_seed["plan_digest"] == res_tw["plan_digest"] == tw["plan_digest"],
              f"{str(res_tw['plan_digest'])[:23]}")
    else:
        gap("C1i twin replay identity", "twin seed or replay leg did not reach completed "
                                        "(see the FAILs above — identity is asserted only "
                                        "over two ledger-complete runs)")
    if res_a and res_tw:
        ident, oa, ob = compare_key_sets(res_a["keys"], res_tw["keys"])
        check("C1 cross-variant key set identical, EXACT (both variants spent "
              f"{res_a['iterations']}/{res_tw['iterations']} iterations — § 9.4: the agent "
              "leg earns this only when the model actually looped like the fixture)",
              ident, f"agent_only={oa} twin_only={ob}")
    ident_n, oa, ob = compare_key_sets(
        collapse_iterations(res_a["keys"]) if res_a else set(),
        collapse_iterations(res_tw["keys"]) if res_tw else set())
    check("C1 cross-variant key set identical, iteration-normalized (the equal-node-ids "
          "claim pipeline.yaml's twin makes)", res_a is not None and res_tw is not None
          and ident_n, f"agent_only={oa} twin_only={ob}" if res_a and res_tw else "a leg failed")
    CTX["c1"] = {"agent": res_a, "twin_seed": res_tw_seed, "twin": res_tw,
                 "runs": [run_a, tw["run_id"], run_tw]}


def c2():
    """C2 — the unit of work is the attempt, not the turn (invariant 5 + node_attempt).
    Acceptance: during the implement attempt the sentinel is in /proc/<agent>/environ
    and NOT as a .env file; after the boundary secret_materializations.cleaned_at is
    set by the worker; SENTINEL-m4-7c1e9d42 appears in zero domain_events/audit_events
    rows, zero artifact bytes, zero container logs, zero mirror refs; the reviewer
    attempt's prompt contains no DATABASE_URL."""
    skip("C2", "secret sentinel lives only in the authorized attempt's live environment")


# --- C3/C4 pure logic — unit-tested offline by e2e/m4/test_c3c4_logic.py -----
# Claim-hand-out and fence verdicts computed over canned ledger rows, so the
# live gates only have to feed them real Postgres/API output. Nothing here may
# stand in for the live two-worker run (12-test-strategy.md).

FENCE_REFUSAL_RE = re.compile(r"stale (owner|token)|fenc|lease lost", re.I)
FENCE_LOG_SAMPLE = 6
C4_FOLLOWING_TYPES = ("node.attempt.retry_scheduled", "run.failed")

# 12 case 2's negative control, restated verbatim in the report (§ 7.1 C3d).
C3_NEGATIVE_CONTROL = (
    "SKIP LOCKED makes the CLAIM single-file, not the execution: two workers can still both "
    "run one node (slow renewal, frozen clock, killed process). Exactly-once execution is the "
    "fencing TOKEN's job, and C4 — a stale owner's write refused by the fence, provable "
    "by token order — is that proof. No line in C3 claims exactly-once execution.")


def psql_rows(text, ncols, sep="|"):
    """Split `psql -tAqc` output into equal-length rows; ragged lines (psql can
    print notes/errors on stdout between rows) are dropped, never verdicted."""
    rows = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(sep)]
        if len(parts) == ncols and all(p != "" for p in parts):
            rows.append(parts)
    return rows


def truthy(v):
    """Postgres `-tA` renders boolean as t/f; accept the Python spellings too."""
    return str(v).strip().lower() in ("t", "true", "1", "yes")


def _int(v):
    """psql text -> int; anything unreadable is 0 (a count that never passes)."""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def count_or_none(v):
    """A ledger count as int, or None when the text is not a number — garbage then
    FAILS its verdict instead of reading as a clean zero (never PASS by parse)."""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def c3_handout_verdicts(rows):
    """§ 7.1 C3b over claim-hand-out groups. rows: [{key, held, workers}] where
    `held` = rows in a claiming/claimed status, `workers` = count(distinct
    worker_id). [(label, ok, detail)] — pure."""
    out = []
    for r in rows:
        key = str(r.get("key", "?"))
        held, workers = count_or_none(r.get("held")), count_or_none(r.get("workers"))
        out.append((f"C3b {key}: leased<=1 (never two live claims of one attempt)",
                    held is not None and held <= 1, f"held={held}"))
        out.append((f"C3b {key}: never two distinct workers",
                    workers is not None and workers <= 1,
                    f"count(distinct worker_id)={workers}"))
    return out


def c3_claim_verdicts(att):
    """§ 7.1 C3c over ONE claimed attempt {distinct_workers, fencing_token,
    status, key}. A queued row is not a claim, so it can only GAP-fail here."""
    dw = _int(att.get("distinct_workers"))
    tok = _int(att.get("fencing_token"))
    key = str(att.get("key", "?"))
    return [
        (f"C3c {key}: claimed exactly once — count(distinct worker_id)=1",
         dw == 1, f"observed {dw} (status={att.get('status')!r})"),
        (f"C3c {key}: fencing_token > 0 on the claimed row", tok > 0, f"observed {tok}"),
    ]


def c3_token_verdicts(max_token, seq_last):
    """C3c's sequence arm: the store draws attempt_fencing_seq once per CLAIM
    (00005's comment: 'drawn at claim time only, never per row'), so the highest
    token in the ledger equals the number of draws."""
    try:
        mx, last = int(max_token), int(seq_last)
    except (TypeError, ValueError):
        return [("C3c max(fencing_token) = claims drawn", False,
                 f"unreadable max={max_token!r} last_value={seq_last!r}")]
    return [("C3c max(fencing_token) = claim count (attempt_fencing_seq last_value — "
             "one draw per claim, ADR-0016 § 3)", mx == last and mx > 0,
             f"max(fencing_token)={mx} last_value={last}")]


def c4_live_attempt(text):
    """Parse the C4a poll row: key|node_instance_key|worker_name|token|
    attempt_number|turn_id-or-dash. None when nothing is live (pure)."""
    rows = psql_rows(text, 6)
    if not rows:
        return None
    k = ("id", "key", "worker", "token", "attempt_number", "turn")
    return dict(zip(k, rows[0]))


def c4_fence_log(text):
    """C4c's log arm: (matched_line_count, sample) over the OWNER worker's own
    log — a count>0 is an observed refusal, not a simulated one."""
    lines = [ln.strip() for ln in (text or "").splitlines() if FENCE_REFUSAL_RE.search(ln)]
    return len(lines), lines[:FENCE_LOG_SAMPLE]


def c4_dead_attempt_verdicts(a):
    """C4c's 'a dead attempt publishes nothing' arm. keys: status,
    outputs_null, artifacts_ready, checkpoints, completed_events. Pure.
    NOTE: § 7.1 C4c also expects finished_at NULL, which 00005's
    attempts_terminal_timestamped CHECK makes unrepresentable for any terminal
    status — c4() records that conflict as a GAP instead of asserting a lie."""
    st = str(a.get("status"))
    arts, cps, done = (count_or_none(a.get("artifacts_ready")),
                       count_or_none(a.get("checkpoints")),
                       count_or_none(a.get("completed_events")))
    return [
        ("C4c the fenced attempt is interrupted", st == "interrupted", f"observed {st!r}"),
        ("C4c the fenced attempt published NO outputs",
         st == "interrupted" and truthy(a.get("outputs_null")),
         f"status={st!r} outputs is null={a.get('outputs_null')!r}"),
        ("C4c zero ready artifacts for the fenced attempt",
         arts == 0, f"count={a.get('artifacts_ready')!r}"),
        ("C4c zero run_checkpoints for the fenced attempt",
         cps == 0, f"count={a.get('checkpoints')!r}"),
        ("C4c zero node.attempt.completed events for the fenced attempt",
         done == 0, f"count={a.get('completed_events')!r}"),
    ]


def c4_retry_verdicts(gt):
    """C4c's proof-of-rejection: the replacement attempt drew a STRICTLY greater
    token, which is what makes the refusal mechanical (01 invariant 3)."""
    return [("C4c the replacement attempt's fencing_token is strictly greater "
             "(01 invariant 3 observed)", truthy(gt), f"observed {gt!r}")]


def c4_event_verdicts(rows, interrupted_type, need_follow=False):
    """C4b/C4e over the fenced attempt's journal slice: rows are
    {type, actor_kind, reason} in global_seq order. [(label, ok, detail)] — pure."""
    types = [str(r.get("type")) for r in rows]
    hits = [r for r in rows if str(r.get("type")) == interrupted_type]
    tail = f"journal={types[-8:]}"
    out = [
        (f"{interrupted_type} present", bool(hits), tail),
        (f"{interrupted_type} reason=lease_expired",
         bool(hits) and all(str(r.get("reason")) == "lease_expired" for r in hits),
         "reasons=" + ",".join(sorted({str(r.get("reason")) for r in hits}) or ["-"])),
        (f"{interrupted_type} actor_kind=system",
         bool(hits) and all(str(r.get("actor_kind")) == "system" for r in hits),
         "actors=" + ",".join(sorted({str(r.get("actor_kind")) for r in hits}) or ["-"])),
    ]
    if need_follow:
        last = max((i for i, t in enumerate(types) if t == interrupted_type), default=-1)
        after = [t for i, t in enumerate(types) if i > last and t in C4_FOLLOWING_TYPES]
        out.append(("node.attempt.retry_scheduled or run.failed follows the interruption",
                    bool(after), f"following={after[-3:]}"))
    return out


def c4_transcript_verdicts(before_seq, after_seq, fence_ts_ok, has_turn=True):
    """C4e: no transcript row appended after the fence. before/after are the
    max(global_seq) of agent transcript events read either side of the wake-up;
    fence_ts_ok is Postgres's own `max(occurred_at) <= unpause now()`."""
    if not has_turn:
        return []
    quiet = str(before_seq) == str(after_seq)
    return [
        ("C4e no transcript row appended after unpause (max global_seq of "
         "conversation.message.agent unchanged across the wake-up)", quiet,
         f"before={before_seq!r} after={after_seq!r}"),
        ("C4e every agent transcript row predates the unpause (§ 8 timing, "
         "compared in Postgres's clock)", truthy(fence_ts_ok), f"observed {fence_ts_ok!r}"),
    ]


def c4_api_verdicts(ledger, api):
    """'Postgres says interrupted and the API says interrupted': the ledger row
    {status, error_class} against the GET /api/v1/attempts/{id} body."""
    if not isinstance(api, dict):
        return [("C4c GET /api/v1/attempts/{ATT} returns the attempt", False,
                 "no JSON body — the API said nothing to compare")]
    out = [
        ("C4c API status matches the ledger (interrupted in both)",
         api.get("status") == ledger.get("status"),
         f"api={api.get('status')!r} ledger={ledger.get('status')!r}"),
        ("C4c API error_class matches the ledger",
         api.get("error_class") == ledger.get("error_class"),
         f"api={api.get('error_class')!r} ledger={ledger.get('error_class')!r}"),
        ("C4c the API body carries no lease machinery (no worker_id, fencing_token "
         "or lease_expires_at — ADR-0016 § 8)",
         not any(k in api for k in ("worker_id", "fencing_token", "lease_expires_at")),
         str(sorted(k for k in api if k in ("worker_id", "fencing_token",
                                            "lease_expires_at")))),
    ]
    return out


def c3_run_ids(facts):
    """Runs whose attempt rows C3 may read: C1's own runs when it produced any,
    else the seed manifest's. (run_ids, source_label) — never invented ids."""
    ids = [r for r in (CTX.get("c1") or {}).get("runs", []) if r]
    if ids:
        return ids, "C1's runs (this exit pass)"
    ids = [f["run_id"] for f in (facts or {}).values() if isinstance(f, dict) and f.get("run_id")]
    return ids, "the § 7.0 seed manifest runs"


def c4_wait_live_attempt(run_id, timeout=300):
    """Poll the ledger for the first attempt a worker actually holds — the row
    whose lease C4 then freezes. Returns the parsed row or None."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if run_status(run_id) in ("completed", "failed", "cancelled", "interrupted"):
            return None
        try:
            row = c4_live_attempt(psql(
                f"SELECT a.id || '|' || ne.node_instance_key || '|' || w.name || '|' || "
                f"a.fencing_token::text || '|' || a.attempt_number::text || '|' || "
                f"coalesce(a.turn_id::text, '-') FROM attempts a "
                f"JOIN node_executions ne ON ne.id = a.node_execution_id "
                f"JOIN workers w ON w.id = a.worker_id "
                f"WHERE a.run_id = '{run_id}' AND a.status IN ('leased','running') "
                f"ORDER BY a.started_at DESC NULLS LAST LIMIT 1"))
        except RuntimeError as e:
            show("C4a claim poll (psql)", str(e)[:300])
            return None
        if row:
            return row
        time.sleep(2)
    return None


def c4_worker_container(name):
    """Compose SERVICE name = the worker row's name; the container is this
    project's prefixed one. Unknown names return None (never a guessed id)."""
    return {"worker-a": WORKER_A, "worker-b": WORKER_B}.get(name)


def c3():
    """C3 — two workers claim one ready attempt; only one fencing token commits (12 case 2).
    Acceptance: with worker-a capacity 3 / worker-b capacity 1 and the C8 fan-out
    queue deep, every attempt_number has leased<=1 and never two distinct workers;
    one /implement attempt claimed exactly once (count(distinct worker_id)=1),
    fencing_token>0, max(fencing_token) = claim count; record the negative-control
    sentence: the claim is not exactly-once execution — the fence is (C4 proves it)."""
    if not CTX.get("stack_up"):
        skip("C3", "contended claims hand out once; the sequence draws per claim")
        return
    facts = CTX.get("manifest") or load_manifest_facts()
    if facts is not None:
        CTX["manifest"] = facts
    run_ids, source = c3_run_ids(facts)
    if not run_ids:
        gap("C3", f"no attempts to read: the stack answered, but neither C1 produced a run "
                  f"nor does a § 7.0 seed manifest exist at {MANIFEST_PATH}, so there is no "
                  "run_id to group claim rows by (attempt rows ARE the evidence)")
        return
    show(f"C3 runs under inspection ({source})", " ".join(run_ids))
    show("workers (the capacity split contention rests on)", psql(
        "SELECT name || ' ' || status || ' cap=' || capacity::text || ' active=' || "
        "active_attempts::text FROM workers ORDER BY name"))
    check("C3a both lab workers online — two claimers must exist to contend",
          int(psql("SELECT count(*) FROM workers WHERE status = 'online'") or 0) >= 2,
          psql("SELECT string_agg(name || '=' || status, ' ') FROM workers ORDER BY name"))
    fan = CTX.get("c8_run")
    if fan:
        show(f"C3a hand-out over the C8 fan-out run {fan}", psql(
            f"SELECT a.worker_id || ' ' || a.status || ' ' || count(*)::text FROM attempts a "
            f"WHERE a.run_id = '{fan}' GROUP BY 1,2 ORDER BY 3 DESC"))
    else:
        gap("C3a deep-queue hand-out (25 queued attempts at once)",
            "§ 7.1 creates the contention on the C8 fan-out run, which this driver has not "
            "implemented yet (C8 prints SKIP), so no 25-attempt queue exists to watch; every "
            "assertion below is measured over the seed/C1 runs, where worker-a (cap 3) and "
            "worker-b (cap 1) still both draw claims")
    claims = []
    for rid in run_ids:
        show(f"C3b § 7.1's literal per-attempt_number query, run {rid}", psql(
            f"SELECT attempt_number::text || ' ' || count(*) FILTER (WHERE status='leased')::text "
            f"|| ' leased ' || coalesce(string_agg(DISTINCT worker_id::text, ','), "
            f"'(never claimed)') || ' workers' FROM attempts WHERE run_id = '{rid}' "
            f"GROUP BY attempt_number ORDER BY attempt_number"))
        rows = psql_rows(psql(
            f"SELECT ne.node_instance_key || '|' || a.attempt_number::text || '|' || "
            f"count(*) FILTER (WHERE a.status IN ('leased','running'))::text || '|' || "
            f"count(DISTINCT a.worker_id)::text FROM attempts a "
            f"JOIN node_executions ne ON ne.id = a.node_execution_id "
            f"WHERE a.run_id = '{rid}' GROUP BY ne.node_instance_key, a.attempt_number "
            f"ORDER BY ne.node_instance_key, a.attempt_number"), 4)
        if not rows:
            gap(f"C3b run {rid}: attempt rows exist",
                f"0 attempt rows (run status={run_status(rid)!r}) — nothing was handed out, "
                "so the hand-out rule is unmeasurable on this run")
            continue
        # Grouped by (node_execution_id, attempt_number), which is strictly stronger
        # than § 7.1's group-by-attempt_number: attempt 1 exists once per node, so
        # the contract's grouping would merge unrelated nodes into one row.
        for label, ok, detail in c3_handout_verdicts(
                [dict(zip(("key", "attempt_number", "held", "workers"), r)) for r in rows]):
            check(label, ok, detail)
        claims += psql_rows(psql(
            f"SELECT ne.node_instance_key || '|' || a.id || '|' || "
            f"count(DISTINCT a.worker_id)::text || '|' || a.fencing_token::text || '|' || a.status "
            f"FROM attempts a JOIN node_executions ne ON ne.id = a.node_execution_id "
            f"WHERE a.run_id = '{rid}' AND a.worker_id IS NOT NULL "
            f"AND ne.node_instance_key LIKE '/build_until_verified[%/implement' "
            f"GROUP BY ne.node_instance_key, a.id, a.fencing_token, a.status, a.attempt_number "
            f"ORDER BY a.attempt_number"), 5)
    for r in claims:
        for label, ok, detail in c3_claim_verdicts(dict(zip(
                ("key", "id", "distinct_workers", "fencing_token", "status"), r))):
            check(label, ok, detail)
    if not claims:
        gap("C3c one /implement attempt claimed exactly once",
            "no /implement attempt row with a worker_id exists in any inspected run — the "
            "runs above never reached a worker-held attempt, so there is no claimed row to "
            "count workers over (see the C3b lines / run statuses)")
    try:
        for label, ok, detail in c3_token_verdicts(
                psql("SELECT coalesce(max(fencing_token), 0)::text FROM attempts"),
                psql("SELECT last_value::text FROM attempt_fencing_seq")):
            check(label, ok, detail)
    except RuntimeError as e:
        show("C3c fencing token vs sequence", str(e)[:300])
    show("C3d NEGATIVE CONTROL (12 case 2 / ADR-0016 § 3 — recorded verbatim, as "
         "the contract requires)", C3_NEGATIVE_CONTROL)
    EVIDENCE["C3d"] = C3_NEGATIVE_CONTROL


def c4():
    """C4 — worker loses its lease but keeps running; the stale write is rejected (12 case 3).
    Acceptance: `compose pause worker-a` for 45s freezes renewals; reconciler writes
    interrupted{lease_expired}; the woken worker's own log shows the fence refusal;
    the dead attempt has no outputs/finished_at/artifact/checkpoint/completed event;
    the replacement attempt's fencing_token is strictly greater; attempt N+1 succeeds
    and the run completes; the fenced turn adds no transcript after unpause."""
    if not CTX.get("stack_up"):
        skip("C4", "stale-owner writes are refused by the fence, provable by token order")
        return
    facts = CTX.get("manifest") or load_manifest_facts()
    if facts is None:
        gap("C4", f"needs the § 7.0 seed manifest at {MANIFEST_PATH}: without the twin "
                  "revision id there is no run to freeze a lease on (C1 seeds on demand)")
        return
    CTX["manifest"] = facts
    tw = facts.get("twin")
    if not isinstance(tw, dict) or not tw.get("revision_id"):
        gap("C4", "the seed manifest carries no twin variant (the deterministic pipeline "
                  "whose ~40s process.exec gives the freezer a live lease to expire)")
        return
    alice = CTX.get("alice") or Client("alice")
    if login(alice) is None:
        check("C4: alice signed in", False, "no session — the gate cannot start a run")
        return
    CTX["alice"] = alice
    run_id = post_c1_run(alice, tw, f"m4x-c4-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}",
                         "c4")
    if not run_id:
        return
    CTX["c4_run"] = run_id
    live = c4_wait_live_attempt(run_id, 300)
    if live is None:
        dump_run_evidence(alice, run_id)
        gap("C4a a live lease to freeze",
            f"no attempt on run {run_id} was ever held by a worker within 300s (status="
            f"{run_status(run_id)!r}) — with no lease there is no stale owner, so nothing "
            "below is measurable (evidence dumped above)")
        return
    att, owner = live["id"], live["worker"]
    svc = c4_worker_container(owner)
    if svc is None:
        gap("C4a pause the owning worker",
            f"the claim belongs to worker row {owner!r}, which is not one of this project's "
            "two lab workers — the driver freezes nothing it did not create (§ 7.0 host safety)")
        return
    if owner != "worker-a":
        show("C4a note — which container gets frozen",
             f"§ 7.1 names worker-a, but the live claim landed on {owner}; the gate is about "
             f"the OWNER losing its lease, so {owner} is frozen and this report says so")
    show("C4a the attempt about to be fenced", psql(
        f"SELECT status || ' worker=' || coalesce((SELECT name FROM workers WHERE id = "
        f"a.worker_id),'-') || ' token=' || a.fencing_token::text || ' attempt=' || "
        f"a.attempt_number::text || ' node=' || ne.node_instance_key || ' turn=' || "
        f"coalesce(a.turn_id::text,'(none, process.exec)') FROM attempts a "
        f"JOIN node_executions ne ON ne.id = a.node_execution_id WHERE a.id = '{att}'"))
    rc, out = run(COMPOSE + ["pause", owner])
    if rc != 0:
        gap("C4a compose pause (freezer, not a kill)",
            f"rc={rc}: {out[-240:]} — the lease cannot be expired without killing the child, "
            "and a killed worker is C5's scenario, not C4's")
        return
    show(f"compose pause {owner} — leases stop renewing while the child keeps writing", out[-240:])
    time.sleep(45)                                  # lease 30s + reconciler tick 15s
    rc, out = run(COMPOSE + ["unpause", owner])
    unpause_ts = psql("SELECT now()::text")          # Postgres's own clock, § 8's rule
    check(f"C4a unpause {owner} after 45s of frozen renewals", rc == 0, out[-200:] or unpause_ts)
    turn = live["turn"] != "-"
    before = psql(f"SELECT coalesce(max(global_seq), 0)::text FROM domain_events "
                  f"WHERE attempt_id = '{att}' AND type = 'conversation.message.agent'") \
        if turn else "0"

    # The reconciler runs in the API, not the frozen worker: the interruption
    # usually lands DURING the pause. Poll the ledger rather than assume it.
    deadline = time.time() + 150
    row = psql_rows(psql(
        f"SELECT status || '|' || coalesce(error_class,'-') FROM attempts "
        f"WHERE id = '{att}'"), 2)
    while time.time() < deadline and not (row and row[0][0] == "interrupted"):
        time.sleep(3)
        row = psql_rows(psql(
            f"SELECT status || '|' || coalesce(error_class,'-') FROM attempts "
            f"WHERE id = '{att}'"), 2)
    show(f"C4a the fenced attempt's row after the wake-up ({att})",
         " | ".join(row[0]) if row else "(no row)")
    ledger = dict(zip(("status", "error_class"), row[0])) if row else {}
    show("C4b Postgres says", psql(
        f"SELECT status || ' | ' || coalesce(error_class,'-') FROM attempts WHERE id = '{att}'"))

    ev = [dict(zip(("type", "actor_kind", "reason"), r)) for r in psql_rows(psql(
        f"SELECT type || '|' || actor_kind || '|' || coalesce(payload->>'reason','-') "
        f"FROM domain_events WHERE (attempt_id = '{att}' OR (type = 'run.failed' AND "
        f"run_id = '{run_id}')) AND type IN ('node.attempt.interrupted', "
        f"'node.attempt.retry_scheduled', 'node.attempt.completed', 'run.failed') "
        f"ORDER BY global_seq"), 3)]
    show(f"C4b the fenced attempt's journal slice ({att})",
         "\n".join(f"{e['type']} reason={e['reason']} actor={e['actor_kind']}" for e in ev)
         or "(no attempt-correlated rows)")
    for label, ok, detail in c4_event_verdicts(ev, "node.attempt.interrupted", need_follow=True):
        check(label, ok, detail)

    arow = psql_rows(psql(
        f"SELECT a.status || '|' || (a.outputs IS NULL)::text || '|' || "
        f"(SELECT count(*) FROM artifacts t WHERE t.attempt_id = a.id AND t.state = 'ready')::text "
        f"|| '|' || (SELECT count(*) FROM run_checkpoints c WHERE c.attempt_id = a.id)::text || "
        f"'|' || (SELECT count(*) FROM domain_events de WHERE de.attempt_id = a.id AND "
        f"de.type = 'node.attempt.completed')::text FROM attempts a WHERE a.id = '{att}'"), 5)
    dead = dict(zip(("status", "outputs_null", "artifacts_ready", "checkpoints",
                    "completed_events"), arow[0])) if arow else {}
    for label, ok, detail in c4_dead_attempt_verdicts(dead):
        check(label, ok, detail)
    fa = psql(f"SELECT coalesce(finished_at::text, 'NULL') FROM attempts WHERE id = '{att}'")
    if fa.strip().upper() == "NULL":
        check("C4c finished_at IS NULL (§ 7.1 literal)", True, fa)
    else:
        gap("C4c finished_at IS NULL (§ 7.1's literal expectation)",
            f"observed finished_at={fa!r}: 00005's attempts_terminal_timestamped CHECK makes a "
            "terminal row WITHOUT finished_at unrepresentable, so the schema forbids the NULL "
            "the contract line expects. The half that matters — the dead attempt published "
            "nothing — is CHECKed above from outputs/artifacts/checkpoints/completed-events.")

    rc, log = run(["docker", "logs", svc])
    n_lines, sample = c4_fence_log(log)
    show(f"C4c fence refusals in {owner}'s OWN log (docker logs | grep -ciE "
         f"'{FENCE_REFUSAL_RE.pattern}')", "\n".join(sample) or "(no matching line)")
    check("C4c the stale owner's refusal is OBSERVED in its own log (count > 0, "
          "never simulated)", n_lines > 0, f"matched {n_lines} lines")
    r = alice.get(LB, f"/api/v1/attempts/{att}")
    show(f"GET /api/v1/attempts/{att} — what the API says", f"{r.status} {r.text[:400]}")
    try:
        body = r.json() if r.status == 200 else None
    except ValueError:
        body = None
    for label, ok, detail in c4_api_verdicts({"status": "interrupted",
                                             "error_class": "interrupted"}, body):
        check(label, ok, detail)

    gt = psql(
        f"SELECT max(b.fencing_token) > (SELECT fencing_token FROM attempts WHERE id = '{att}') "
        f"FROM attempts b WHERE b.node_execution_id = (SELECT node_execution_id FROM attempts "
        f"WHERE id = '{att}') AND b.id <> '{att}'")
    repl_n = psql(
        f"SELECT count(*)::text FROM attempts WHERE node_execution_id = "
        f"(SELECT node_execution_id FROM attempts WHERE id = '{att}') AND id <> '{att}'")
    check("C4c a replacement attempt exists for the same node execution", _int(repl_n) >= 1,
          f"replacement rows={_int(repl_n)}")
    for label, ok, detail in c4_retry_verdicts(gt):
        check(label, ok, detail)

    status, _watch = watch_run(alice, tw, run_id, 900, "c4")
    if status:
        repl = psql(
            f"SELECT attempt_number::text || ' ' || status FROM attempts WHERE "
            f"node_execution_id = (SELECT node_execution_id FROM attempts WHERE id = '{att}') "
            f"AND attempt_number > {live['attempt_number']} ORDER BY attempt_number LIMIT 1")
        check("C4d the retry (attempt N+1) succeeded and the run completed — ownership "
              "moved, no process died", repl.split()[-1:] == ["succeeded"], f"{repl!r}")
    else:
        gap("C4d attempt N+1 succeeds and the run completes",
            f"the frozen run never reached a terminal status (see the dump above)")

    if not turn:
        gap("C4e the fenced turn adds no transcript after unpause",
            f"the fenced attempt is {live['key']} with attempts.turn_id NULL — a "
            "process.exec node owns no ACP turn, so conversation.turn.interrupted and the "
            "transcript-timing arm are unmeasurable on it (they need an agent.acp attempt: "
            "C6/C7's territory)")
    else:
        tev = [dict(zip(("type", "actor_kind", "reason"), r)) for r in psql_rows(psql(
            f"SELECT type || '|' || actor_kind || '|' || coalesce(payload->>'reason','-') "
            f"FROM domain_events WHERE attempt_id = '{att}' AND "
            f"type = 'conversation.turn.interrupted' ORDER BY global_seq"), 3)]
        for label, ok, detail in c4_event_verdicts(tev, "conversation.turn.interrupted"):
            check(label, ok, detail)
        after = psql(f"SELECT coalesce(max(global_seq), 0)::text FROM domain_events "
                     f"WHERE attempt_id = '{att}' AND type = 'conversation.message.agent'")
        ts_ok = psql(
            f"SELECT coalesce(max(occurred_at) <= '{unpause_ts}'::timestamptz, true) "
            f"FROM domain_events WHERE attempt_id = '{att}' "
            f"AND type = 'conversation.message.agent'")
        for label, ok, detail in c4_transcript_verdicts(before, after, ts_ok, has_turn=True):
            check(label, ok, detail)
    CTX["c4"] = {"run_id": run_id, "attempt_id": att, "owner": owner,
                 "fencing_token": live["token"], "unpause_ts": unpause_ts}


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
    ap.add_argument("--seed", action="store_true",
                    help="run the § 7.0 seed.sh contract against the ready stack "
                         "and parse its manifest (C1 also seeds on demand when the "
                         "stack is up but no manifest exists)")
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
        ready = wait_ready(hard=True)
        CTX["stack_up"] = ready
        if not ready:
            if args.down:
                stack_down()
            return finish()
        if args.seed:
            step("stack: § 7.0 seed contract (seed.sh -> seed-manifest.json)")
            if not run_seed():
                if args.down:
                    stack_down()
                return finish()
            CTX["manifest"] = load_manifest_facts()
    else:
        # Skeleton default: a five-second informational probe. Absent stack
        # prints a NOTE, never a FAIL — the SKIP lines below carry the honesty.
        step("stack: readiness (informational)")
        CTX["stack_up"] = wait_ready(timeout=5, hard=False)

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
