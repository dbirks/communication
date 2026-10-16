# m4 probe suite — pipeline engine / scheduler / worker claims behind `docs/m4-contract.md`

The evidence-capture arm of the M4 exit test (§ 7). The scripted cases C1–C14
and the Playwright legs W1–W11 live in `e2e/m4/e2e_m4_exit.py`; this directory
holds the shell probe contract (`CHECK`/`NOTE` lines, `results-*.txt` evidence)
so any single claim can be re-derived without replaying the whole exit run.

**Status: skeleton.** The M4 Go code is landing as this is written, so the
honest output of `run.sh` today is 25 `SKIP` lines naming each gate's intent
and why it cannot yet be measured. That is deliberate — honesty over green
(AGENTS.md: no capability claim without a real test; 12-test-strategy.md: a
mocked green never substitutes for § 7). The § 7.0 *seed* side is now real
(`seed.sh`, `pipeline.yaml`, `validate_pipeline.py` below): schema-valid
offline today, and `seed.sh` against a stack-less lab fails the same honest
way — loud, with no manifest — because its contract is the frozen
`api/openapi.yaml`, not the in-flight handlers.

## Layout

| File | Contents |
| --- | --- |
| `run.sh` | Runner: prints the ENV header and one `CHECK <id> SKIP …` per § 7 gate, then `SUMMARY`/`FAILED_CLAIM`. Writes `results-exit.txt` (the § 7.0 evidence file; `M4_RESULTS=<path>` overrides). Never starts or stops the stack. |
| `lib.sh` | Sourced helpers § 7.0 names: `run_sql`, `api` (cookie jar per user), `events_of_run <run_id> <type>…`, `m4_assert`, plus the `CHECK`/`NOTE` reporters and `m4_stack_up`. |
| `pipeline.yaml` | The § 7 sample pipeline set — **three `---`-delimited documents**: the § 9.3 corrected sample (`feature-development`, agent variant), its deterministic `process.exec` twin (`feature-development-deterministic`, identical node ids ⇒ identical compiled `node_instance_key` set — the C1 twin requirement), and the C8 fan-out child (`issue-implementation`). See "The seed pipeline" below. |
| `seed.sh` | The § 7.0 seed contract: logs the lab users through the mock IdP, creates the project/members/repo, seeds the three profiles (SQL — there is no profile-write API, M3 D10), creates + mounts the `test-database-url` sentinel secret, then draft → validate → publish → assignment → **POST two runs** (agent + twin), printing every id to a `seed-manifest.json` the exit gates consume. Contract = `api/openapi.yaml` only; every failed call prints the problem detail verbatim and stops. |
| `validate_pipeline.py` | Offline schema check for `pipeline.yaml` against `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json` (the canonical asset the API serves at `GET /api/v1/schemas/pipeline-v1alpha1`). Host tooling only: `python3` + `PyYAML` + `jsonschema` (draft 2020-12) — already present in the lab, **not repo dependencies**; structure only, the compiler rules arrive with the gates. |

## Isolation (§ 7.0 — the reason this directory has its own compose project)

Everything runs against project **`communication-m4`**:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml up -d --build
```

Ports 18091 (app), 18092/18093 (API replicas), 18094 (preview), 18095 (OIDC),
18099 (the C11 collector). **Never** the `communication` project, **never**
18080–18090, **never** 8080/8081/8090. Teardown is `down -v` on that project
alone — no `docker system/volume/image prune`, no pattern `pkill`; workers are
killed only by `docker compose -p communication-m4 kill worker-a`.

## Result words

`PASS` = observed, matched expectation, literal pasted. `FAIL` = observed, did
not match. `GAP` = could not be measured here, with the reason. `SKIP` = the
precondition (built stack / implemented gate) is absent **today**, printed
honestly. `N/A` = precondition not applicable. Never `PASS` by inference, and
never a mocked stand-in for a real run.

## Seed contract (`seed.sh`) — bare stack → running sample pipeline, no Go in between

Wire order with the exit driver (`e2e/m4/e2e_m4_exit.py` owns up/down; seed.sh
touches neither):

```bash
python3 e2e/m4/e2e_m4_exit.py --up --ready            # host prep, fixture repo, compose up
bash docs/compatibility/probes/m4/seed.sh             # -> seed-manifest.json, ids on stdout
python3 e2e/m4/e2e_m4_exit.py --ready --only C1,C9 --down   # gates read the manifest, then teardown
```

Route shapes come from **`api/openapi.yaml` only** (paths, payloads, the
`X-CSRF-Token` + `Origin` mutation pair from the doc's conventions block,
`application/problem+json` errors) — the handlers are written concurrently, so
the OpenAPI document is seed.sh's whole contract. Every call fails loudly:
non-2xx (or unreachable) prints `SEED FAIL <label>`, the method/path/status,
and the **problem-detail body verbatim**, exits non-zero, and writes no
manifest. The login dance is `e2e_m3_exit.py`'s `login()` shape (mock-IdP form:
`/auth/login?return_to` → `username` + `claims` POST → callback → `/api/v1/me`;
cookie jars under `$M4_PROBE_ROOT_BASE/jars/`). Lab users: **alice** (creates
the project ⇒ maintainer, decides the gate), **bob** (contributor — C9b),
**carol** + **dan** (maintainers — C9d), and **admin** (the lab's bootstrap
org admin — `COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS` in compose.yml — the
only identity holding the pipeline **library role**, so the draft → validate
→ publish calls and their library lookups run as admin while alice stays a
plain project maintainer, which is exactly what gate C9c needs when it
removes her). W9's "carol, project B only" arm is
the gate implementer's sequencing (remove her afterwards or use a second
project); the manifest records the seeded membership truthfully.

What seed.sh creates, in order: project `m4-exit` (409 ⇒ resolved via the list
route) → members (PUT upsert) → repo `app` = `file:///srv/m4/fixtures/app.git`
(the URL `e2e/m4/make_fixture_repo.sh` generates) → profiles `m4-planner` /
`m4-implementer` (`commit_granted=true`) / `m4-reviewer` by `INSERT … ON
CONFLICT DO UPDATE` (launcher `claude`, `sandbox_enforcement=required`, § 7.0;
SQL because there is no profile-write API — M3 D10) → secret
`test-database-url` = the § 7.0 contract sentinel (write-only, never echoed;
`allowed_agent_profile_ids` = m4-implementer only) + mount `env` /
`DATABASE_URL` / `lifecycle=node_attempt` → the three `pipeline.yaml`
documents through draft → validate → publish (library-role calls, as **admin**)
→ assignment (project-scoped, as alice) → then **POST the
agent run and the twin run** (fixed `idempotency` body members per
ADR-0023 § 12, so a re-seed replays 200 with the stored run). Reseeds are
idempotent end to end; an assignment pinned to a *different* revision is a
loud stop — re-pinning is deliberate promotion (`PATCH /assignments/{id}`),
never a side effect of seeding.

### seed-manifest format (`m4-seed-manifest/1`)

`M4_SEED_MANIFEST` overrides the path; default
`$M4_PROBE_ROOT_BASE/seed-manifest.json` (lab cache, never committed). JSON,
keyed so gates never re-derive ids:

```json
{ "schema": "m4-seed-manifest/1", "seeded_at": "…",
  "stack":  {"compose_project": "communication-m4", "url": "http://localhost:18091"},
  "users":  {"admin": "<uuid>", "alice": "<uuid>", "bob": "…", "carol": "…", "dan": "…"},
  "project": {"id": "<uuid>", "slug": "m4-exit"},
  "repositories": {"app": {"id": "<uuid>", "git_url": "file:///srv/m4/fixtures/app.git"}},
  "profiles": {"m4-planner": "<uuid>", "m4-implementer": "…", "m4-reviewer": "…"},
  "secret":   {"id": "…", "slug": "test-database-url", "mount_id": "…",
               "env_name": "DATABASE_URL", "lifecycle": "node_attempt",
               "allowed_profile": "m4-implementer"},
  "pipelines": {
    "feature-development": {"pipeline_id": "…", "slug": "…", "revision_id": "…",
        "revision_number": 1, "version_label": "1.0.0",
        "revision_digest": "sha256:…", "plan_digest": "sha256:…", "assignment_id": "…",
        "run_id": "…"},
    "feature-development-deterministic": { "…same shape…, "run_id": "…"},
    "issue-implementation": { "…no run_id — the fan-out child…" }},
  "runs": [ {"run_id": "…", "variant": "agent", "pipeline_slug": "feature-development",
             "revision_digest": "…", "plan_digest": "…",
             "inputs": {"goal": "Document and fix add() in hello.py",
                         "repository": "app", "fanout": false, "fanout_count": 0}},
           {"…variant": "twin"…} ],
  "fixture": {"git_url": "file:///srv/m4/fixtures/app.git",
              "generator": "e2e/m4/make_fixture_repo.sh"} }
```

Digest provenance: `revision_digest`/`plan_digest` are captured from the
`POST /drafts/{id}/validate` body and re-read from the publish response /
`GET /revisions/{id}` — the values C1e compares against the `runs` row. The
seeded C1 runs carry **4 submitted inputs** (`goal`, `repository`,
`fanout=false`, `fanout_count=0`), so C1e's `run_inputs` count is
declared-inputs-with-their-origins, not the contract's older "2 rows"
shorthand — read the manifest, not the prose. No secret values are ever
written to the manifest or the log.

## The seed pipeline (`pipeline.yaml`)

Document 1 is `internal/pipelines/testdata/feature-development-contract.yaml`
(contract § 9.3, the shape `contractprobe`/`cmd/probes` already compile) with
four deliberate, provenance-headed adjustments:

1. **Test node executes the fixture script.** § 9.3's `go test ./...` carried
   over from the spec example, but § 7.0's fixture is Python (`pytest.ini`,
   intended `add(1,2)==99` failure), and § 7.1 names `m4-exit.sh` as the
   committed script that owns the deterministic steps. So the test node is
   `m4-exit.sh [test]` with the § 9.3 slots unchanged (`cwd: repos/app`,
   `json_from_path build/test-result.json`, `{exit_code, result{successful}}`
   outputs — the script must write the extraction file). The C1/C5
   implementation workers commit that script onto the workers' PATH; the
   schema-legal bare name is `m4-exit.sh`.
2. **C8 arms live inside the sample** as the when-gated `emit_items`
   (`m4-exit.sh [items]`, emits `{"items":[{number,title}…]}`, count from
   `M4_FANOUT_COUNT`) → `fan_out` (`for_each`, `maxConcurrency: 3`,
   `onChildFailure: collect_and_continue`, body `invoke` →
   `pipeline.invoke` `issue-implementation`). Guard is `inputs.fanout`
   (default `false`), so the C1 key set is untouched — the two rows appear as
   `node.execution_skipped` exactly like `publish_needs_attention` already
   does. C8a runs with `fanout_count=0` (scope `items: 0`), C8b–e with
   `fanout_count=25` (item 13 exits 1 in the child script — the C8e `stop` /
   `fail_after_all` arms are the gate's own re-authored revisions, same as
   C7's `maxIterations: 3` exhaustion twin: publish extra revisions, don't
   widen this one).
3. **`maxChildDepth: 1`** (was 0) because the fan-out invokes depth-1 child
   runs; `issue-implementation` keeps 0, which is what makes C8f's third
   level refuse.
4. **Twin as document 2**: same eight node ids, three `agent.acp` →
   `process.exec` (`m4-exit.sh [plan|implement|review]`,
   `json_from_stdout`, `secretRefs` and workspace modes unchanged, `passWhen`
   unchanged) ⇒ equal `node_instance_key` sets, which is what C1 asserts
   across the two manifest runs. The `until` stays bounded
   (`maxIterations: 4`) so exhaustion (`failed_cause: until_exhausted`) is
   reachable without a runaway.

### Offline validation (no server needed)

```bash
cd docs/compatibility/probes/m4
python3 validate_pipeline.py pipeline.yaml
# OK   pipeline.yaml#1 kind=Pipeline name=feature-development nodes=8
# OK   pipeline.yaml#2 kind=Pipeline name=feature-development-deterministic nodes=8
# OK   pipeline.yaml#3 kind=Pipeline name=issue-implementation nodes=1
# docs=3 errors=0
```

The validator is a draft-2020-12 check against the pinned canonical asset —
structure only, exactly the layer santhosh enforces server-side; loader/compiler
rules (DAG, unknown ids, CEL subset, secret policy) are proven by the
`validate` route once handlers land. Cross-evidence that the *asset itself* is
sound in the pinned validator: `go run ./cmd/communication doctor --pipelines`
(all lanes `ok`, reports the `cel_env_digest` revisions pin).

## Rerun

```bash
cd docs/compatibility/probes/m4
bash run.sh                 # -> results-exit.txt
bash seed.sh                # § 7.0 seed: ids + seed-manifest.json (needs the stack up)
```

Seed.sh error-path proof without a stack (the two dry-run arms this was
verified with): against nothing it dies at the readiness gate (`SEED FAIL
stack not ready`, exit 1, no manifest); against a stand-in origin that answers
the two readiness probes and replies `application/problem+json` to everything
else — `python3 -m http.server`-shaped responder or
`M4_URL=http://127.0.0.1:PORT M4_API_A=… M4_API_B=… bash seed.sh` — the first
non-redirect prints the problem detail verbatim and stops cleanly, again with
no manifest. seed.sh never writes the manifest until every step succeeded.

With a live stack, per-claim probes will be added here as `c<N>_*.sh` scripts
using `lib.sh` (the m3 p1…p6 pattern); until then `run.sh`'s SKIP block is the
whole honest state of the evidence. Fixture scratch lives under
`$HOME/.cache/communication-lab/m4-probes/`; the disposable repo itself is
generated by `e2e/m4/make_fixture_repo.sh` into the gitignored
`.harness/m4-fixtures/` (mounted read-only at `/srv/m4/fixtures` inside the
workers — same-path bind trick, see `e2e/m4/README.md`).
