# m4 probe suite — pipeline engine / scheduler / worker claims behind `docs/m4-contract.md`

The evidence-capture arm of the M4 exit test (§ 7). The scripted cases C1–C14
and the Playwright legs W1–W11 live in `e2e/m4/e2e_m4_exit.py`; this directory
holds the shell probe contract (`CHECK`/`NOTE` lines, `results-*.txt` evidence)
so any single claim can be re-derived without replaying the whole exit run.

**Status: live.** The § 7.0 seed side (`seed.sh`, `pipeline.yaml`,
`validate_pipeline.py` below) is real and has seeded a running stack, every § 7
gate has an implementation in `e2e/m4/e2e_m4_exit.py`, and the lab has been run
for real — what has actually been *observed* is listed under "Live evidence"
and nothing outside that list carries a verdict. `run.sh` here is the intent
ledger, not the judge: it prints the ENV header plus one `CHECK <id> SKIP …`
naming each gate's purpose and never a `PASS`. Verdicts come from the driver.
Honesty over green is unchanged (AGENTS.md: no capability claim without a real
test; 12-test-strategy.md: a mocked green never substitutes for § 7) — it just
no longer means "everything SKIPs".

## Layout

| File | Contents |
| --- | --- |
| `run.sh` | Intent ledger: prints the ENV header and one `CHECK <id> SKIP …` per § 7 gate, then `SUMMARY`/`FAILED_CLAIM`. Writes `results-exit.txt` (the § 7.0 evidence file; `M4_RESULTS=<path>` overrides). Never starts or stops the stack, and never reports a gate's verdict — the driver does. |
| `lib.sh` | Sourced helpers § 7.0 names: `run_sql`, `api` (cookie jar per user), `events_of_run <run_id> <type>…`, `m4_assert`, plus the `CHECK`/`NOTE` reporters and `m4_stack_up`. **bash only** — sourcing it from zsh breaks the shell's `PATH` (zsh ties `path` to `PATH`, and lib.sh sets `path` as an array), so always `bash -c 'source docs/compatibility/probes/m4/lib.sh; …'`. |
| `pipeline.yaml` | The § 7 sample pipeline set — **three `---`-delimited documents**: the § 9.3 corrected sample (`feature-development`, agent variant), its deterministic `process.exec` twin (`feature-development-deterministic`, identical node ids ⇒ identical compiled `node_instance_key` set — the C1 twin requirement), and the C8 fan-out child (`issue-implementation`). See "The seed pipeline" below. |
| `seed.sh` | The § 7.0 seed contract: logs the lab users through the mock IdP, creates the project/members/repo, seeds the three profiles (SQL — there is no profile-write API, M3 D10), creates + mounts the `test-database-url` sentinel secret, then draft → validate → publish → assignment → **POST two runs** (agent + twin), printing every id to a `seed-manifest.json` the exit gates consume. Contract = `api/openapi.yaml` only; every failed call prints the problem detail verbatim and stops. |
| `validate_pipeline.py` | Offline schema check for `pipeline.yaml` against `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json` (the canonical asset the API serves at `GET /api/v1/schemas/pipeline-v1alpha1`). Host tooling only: `python3` + `PyYAML` + `jsonschema` (draft 2020-12) — already present in the lab, **not repo dependencies**; structure only — the loader/compiler rules (DAG, unknown ids, CEL subset, secret policy) are proven by the `validate` route and by C12/C13. |

## Isolation (§ 7.0 — the reason this directory has its own compose project)

Everything runs against project **`communication-m4`**:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml up -d --build
```

(`--build` from the working tree, or build the two dev images once and use
`--no-build` — see "Running it live" below.)

Ports 18091 (app), 18092/18093 (API replicas), 18094 (preview), 18095 (OIDC),
18099 (the C11 collector). **Never** the `communication` project, **never**
18080–18090, **never** 8080/8081/8090. Teardown is `down -v` on that project
alone — no `docker system/volume/image prune`, no pattern `pkill`; workers are
killed only by `docker compose -p communication-m4 kill worker-a`.

## Result words

`PASS` = observed, matched expectation, literal pasted. `FAIL` = observed, did
not match. `GAP` = could not be measured here, with the reason. `SKIP` = the
precondition (built stack / implemented gate) is absent, printed
honestly. `N/A` = precondition not applicable. Never `PASS` by inference, and
never a mocked stand-in for a real run.

## Running it live — what the lab actually takes

The driver owns stack up/down and seeds through `seed.sh`; the steps below are
what it does, and what to do when you drive the parts by hand.

**0. Generate the fixture repo before anything seeds.**

```bash
bash e2e/m4/make_fixture_repo.sh .harness/m4-fixtures
```

An absent `.harness/m4-fixtures/app.git` is not a subtle failure: every attempt
fails honestly at prepare with git's own `does not appear to be a git
repository`, and the infra reason reads like a protocol fault until you look at
the bind. Generate first (`stack_up` calls the same script via
`ensure_fixture_repo`).

**1. Build the images, then bring the stack up on them.** `communication:dev`
comes from `api/Dockerfile`, `communication-worker:dev` from
`worker/Dockerfile` (both built by this plan; nobody pulls the dev tags):

```bash
docker build -t communication:dev -f api/Dockerfile .
docker build -t communication-worker:dev -f worker/Dockerfile .
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -p communication-m4 -f compose.yml -f compose.harness.yml \
  -f compose.m4.yml up -d --no-build
```

`--no-build` reuses the images you just made; `up -d --build` rebuilds them from
the working tree. **To test exactly a commit, build from a `git archive HEAD`
export rather than a dirty tree** — a green run against uncommitted edits
proves nothing about the sha you are quoting.

`HOST_UID`/`HOST_GID` are not optional (compose.harness.yml's warning, observed
in `docs/compatibility/ACP.md`): the image's user is uid 10001 and the host
agent configs are `0600`/`0700` and owned by you.

**2. Seed where the driver will read it.** `seed.sh`'s own default is
`$M4_PROBE_ROOT_BASE/seed-manifest.json` (`…/m4-probes/`), but the exit driver
reads `$HOME/.cache/communication-lab/m4-exit/seed-manifest.json`, so a
hand-run seed has to be pointed at the driver's path:

```bash
M4_SEED_MANIFEST=$HOME/.cache/communication-lab/m4-exit/seed-manifest.json \
  bash docs/compatibility/probes/m4/seed.sh
```

Seed.sh is re-runnable: byte-identical published documents reuse the live
revision (`revision_already_published` → `existing_revision_id`) and the fixed
idempotency keys replay the seeded runs (200, stored run). Library-role calls —
draft → validate → publish and their library lookups — run as the bootstrap org
admin **`admin`** (`COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS`), never as a project
maintainer. It exits non-zero and writes no manifest if any step, or the
manifest itself, fails.

**3. Run gates.**

```bash
python3 e2e/m4/e2e_m4_exit.py --only C1,C9 --down
```

A gate that *crashes* records a FAIL naming the raising frame and the driver
continues to the next gate (183b7e8) — a broken gate is a fact about the gate,
never a silent green or a stopped run. Every gate's verdict logic also has
offline tests, `e2e/m4/test_*_logic.py`, which CI runs in the **`m4-gate-logic`**
job: canned Postgres/API evidence through the reducer, stdlib unittest only, no
stack. Those prove the reducer is self-consistent; they are not § 7 evidence.

**Harness credentials.** `${HOME}/.claude` is bind-mounted at `/harness/claude`
(`CLAUDE_CONFIG_DIR`) on both workers — and since 966dcac an *agent attempt*
receives the `harness_credentials` grant the same way M3's conversation turns
did, so the ACP legs (C1/C2/C9/C11) spend real turns under real logins.

## Live evidence — observed 2026-10-16

Exactly what has been seen against a running lab, stated as it stands:

| Gate | Observed | Status of that evidence |
| --- | --- | --- |
| **C9** | `30 PASS / 2 FAIL` | The two FAILs are C9c (approver who lost project access was accepted); fixed in 1c1721c, **not yet re-run**, so C9's recorded live verdict is still 30/2. |
| **C13** | first run `15 FAIL / 8 GAP` | That run drove fixes d2fdf26 (secret literals refused at validate/publish), 183b7e8 and c0c86e4 (gate documents, CEL roots). **Not yet re-run.** |
| Both sample pipelines | first node completes live; after 52685c1 the run continues **past the approval gate into the `until` loop** | Observed for `feature-development` and its `process.exec` twin. Not the whole C1 verdict. |

Everything else — C1–C8, C10–C14, W1–W11 — is implemented and has **not yet
been run live**. No gate is claimed to pass; the fixes named above are named as
fixes awaiting the re-run that would earn their gates a verdict.

## Seed contract (`seed.sh`) — bare stack → running sample pipeline, no Go in between

Wire order with the exit driver (`e2e/m4/e2e_m4_exit.py` owns up/down; seed.sh
touches neither):

```bash
python3 e2e/m4/e2e_m4_exit.py --up --ready            # host prep, fixture repo, compose up
M4_SEED_MANIFEST=$HOME/.cache/communication-lab/m4-exit/seed-manifest.json \
  bash docs/compatibility/probes/m4/seed.sh           # -> seed-manifest.json, ids on stdout
python3 e2e/m4/e2e_m4_exit.py --ready --only C1,C9 --down   # gates read the manifest, then teardown
```

(`--up --seed` runs the seed itself with `M4_SEED_MANIFEST` already pointed at
the driver's path; the middle line is what to type when you seeded by hand —
see step 2 above for why the override is needed.)

Route shapes come from **`api/openapi.yaml` only** (paths, payloads, the
`X-CSRF-Token` + `Origin` mutation pair from the doc's conventions block,
`application/problem+json` errors) — the OpenAPI document is seed.sh's whole
contract, which is what makes handler drift surface as a loud `SEED FAIL`
rather than a quietly re-tuned probe. Every call fails loudly:
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
never a side effect of seeding. Publishing a byte-identical document is the
one reusable publish `409`: `revision_already_published` names the live row in
`existing_revision_id`, the seed `GET /api/v1/revisions/{id}` for its digests
(the same source the `201` body provides) and carries on — detected on that
member, because the code only appears in the problem `type` URI
(`…/errors/revision-already-published`). Every other `409` (stale version, not
valid, already-published draft) stays fatal. The `validate` step prints
`valid` / `digest_scope` / `errors` only: `ValidateResponse` carries no digests
in this build, so printing them there would print empties.

### seed-manifest format (`m4-seed-manifest/1`)

`M4_SEED_MANIFEST` overrides the path; default
`$M4_PROBE_ROOT_BASE/seed-manifest.json` (lab cache, never committed) — which
is `…/m4-probes/`, **not** the `…/m4-exit/` path the exit driver reads. JSON,
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
5. **`inputs.hold_seconds` on the twin only** (integer, 0–600, default `0`):
   each twin `process.exec` (`plan`, `implement`, `test`, `review`) passes it as
   `env: M4_HOLD_SECONDS`, and `m4-exit.sh` sleeps that many seconds **before**
   the step does anything. The shipped steps are `printf`s that close in <1s, so
   without a hold C4's lease freeze, C5's `docker kill` and C6's restore all land
   on an attempt that has already `succeeded` (live6: `C4 FAIL=14`,
   `C5 GAP`, `C6 FAIL=9` — every one of them "nothing was running"). The fault
   gates therefore have to post their runs with `hold_seconds: 45` (≥ the 30s
   lease + 15s reconciler tick and the gate's own 45s freeze — the arms are
   `c4()`/`c5()`/`c6()`'s `post_c1_run` calls in `e2e/m4/e2e_m4_exit.py`);
   C1's two manifest runs, C7's
   exhaustion twin and C8's fan-out keep the default `0`, which sleeps nothing and
   leaves stdout byte-identical (`emit_items`/`fan_out` and the C8 child carry no
   hold on purpose — C8b measures real in-flight concurrency). Node ids, count
   and the `until` cap are unchanged, so C1's key-set equality still holds
   (measured by compiling both documents: 12 identical `node_instance_key`s).
   Document 2's leading comment block cannot grow: `c12_splice` requires
   `apiVersion:`/`kind: Pipeline` inside the first 600 characters of the
   document's text, and they already sit at 543/582 — hence this note lives in
   the README rather than in the YAML header.
6. **Document 1's `/plan` output is an object, not § 9.3's string.** Every real
   `m4-planner` reply captured live in the lab answers
   `{"plan":{"goal","findings":[…],"steps":[{id,file,action}]}}`; against § 9.3's
   `plan: {type: string}` the validator honestly refused it
   (`invalid_output: at /plan: got object, want string`, 3 attempts × 2 runs).
   The declared schema now matches the observed shape (goal/findings/steps
   required, steps' `action` required, extra keys like `risks`/`acceptance`
   admitted), and the prompt names that shape explicitly. The approval gate
   reads the object through the bindingText join rule (ADR-0022 § 1 /
   `expr.Stringify`: canonical JSON for a structured value), split into
   Objective/Findings/Steps lines; the `Plan for ${{ inputs.goal }}` C12/C11
   needle is byte-unchanged. The twin (document 2) keeps its string plan and
   `make_fixture_repo.sh` its string fixture: C1's cross-variant proof
   compares `node_instance_key` SETS (and per-pipeline `plan_digest`), never
   output shapes — verified against the three live replies, which all validate
   clean under the new schema.

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
structure only, exactly the layer enforced server-side; loader/compiler rules
(DAG, unknown ids, CEL subset, secret policy) are proven by the `validate`
route the seed calls on every run. Cross-evidence that the *asset itself* is
sound in the pinned validator: `go run ./cmd/communication doctor --pipelines`
(all lanes `ok`, reports the `cel_env_digest` revisions pin).

## Rerun

```bash
cd docs/compatibility/probes/m4
bash run.sh                 # -> results-exit.txt (intent ledger; SKIPs by contract)
bash seed.sh                # § 7.0 seed: ids + seed-manifest.json (needs the stack up)
```

Seed.sh error-path proof without a stack (the two dry-run arms this was
verified with): against nothing it dies at the readiness gate (`SEED FAIL
stack not ready`, exit 1, no manifest); against a stand-in origin that answers
the two readiness probes and replies `application/problem+json` to everything
else — `python3 -m http.server`-shaped responder or
`M4_URL=http://127.0.0.1:PORT M4_API_A=… M4_API_B=… bash seed.sh` — the first
non-redirect prints the problem detail verbatim and stops cleanly, again with
no manifest. seed.sh never writes the manifest until every step succeeded, and
the manifest itself is a step that can fail loudly: the writer runs into
`$MANIFEST.$$` (which is passed the stack URL through `M4_SEED_STACK_URL`, not
read from an unexported `M4_URL`), the file is only moved into place on a zero
exit, and the installed file is re-parsed and checked for `schema` /
`stack` / `project` / `pipelines` / `runs` and the two seeded run ids plus the
three revision ids. Any of those failing prints `SEED FAIL manifest: …` and
exits 1 — `SEED done` never appears over a manifest that does not parse or is
missing the run ids.

Per-claim probes live here as `c<N>_*.sh` scripts using `lib.sh` (the m3 p1…p6
pattern) alongside the driver's gates; `run.sh`'s SKIP block names intent only.
Fixture scratch lives under
`$HOME/.cache/communication-lab/m4-probes/`; the disposable repo itself is
generated by `e2e/m4/make_fixture_repo.sh` into the gitignored
`.harness/m4-fixtures/` (mounted read-only at `/srv/m4/fixtures` inside the
workers — same-path bind trick, see `e2e/m4/README.md`).

## Troubleshooting — symptoms seen running this for real

| Symptom | Cause |
| --- | --- |
| Attempt fails with `exit 126` | The attempt's tool read grant is missing — the script (`m4-exit.sh` under `/opt/m4/bin`) is mounted but not readable/executable by the unit's sandbox policy. Fix the grant, not the script. |
| Agent turn dies with the adapter's `Authentication required` | Harness credentials never reached the worker: `${HOME}/.claude` not bind-mounted at `/harness/claude`, or `CLAUDE_CONFIG_DIR` unset, or the stack came up without `HOST_UID`/`HOST_GID` so uid 10001 cannot read your `0600` config. |
| Run sits in `waiting_human` after the gate was decided | Pre-52685c1 build: nothing resumed the run once its last approval gate was decided. Rebuild the image from ≥ 52685c1. |
| Attempts queue forever, never claimed | The **run** is not in `running` — the scheduler only hands out attempts for a running run. Read the run row and its gate state before blaming the worker. |
| Seed dies with `SEED FAIL … 403` on draft/validate/publish | The caller lacks the pipeline **library role**. Those calls must run as the bootstrap org admin `admin`; a project maintainer (alice) is deliberately not one. |
