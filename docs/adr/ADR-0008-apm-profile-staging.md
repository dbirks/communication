# ADR-0008 — APM profile staging: pinned CLI, per-run checkout, isolated HOME

- **Date:** 2026-10-14
- **Status:** **Proposed** (not Accepted — Verification below is partly unexercised)
- **Owners:** project owner
- **Related decisions / contracts:** D-017 (**Spike required**), D-013 (AgentProfileRevision),
  `communication-spec/04-agent-runtime.md` § "Profile → environment → instance",
  `communication-spec/09-api-events-data.md` `AgentProfileRevision.apm_lock_digest`,
  `communication-spec/14-research-notes.md` § "APM". Refines staging hygiene implied by ADR-0003;
  supersedes nothing.

## Context

An `AgentProfileRevision` carries `apm_package_ref` and `apm_lock_digest` (04 § "Agent profile").
Before the worker launches an agent over ACP it must turn that profile into harness-native files —
skills, instructions, MCP/client config — which is APM's job (`apm install --target <harness>`).
04 requires staging **before** agent launch, pinned versions, generated files visible to the harness
natively, states APM preparation "is **not** itself isolation", and says to "avoid modifying shared
user home or source repo by default". D-017 is **Spike required**, so the contract must come from a
run, not an assumption.

The M0 probe (2026-10-14, APM CLI `0.33.0 (18c4c43)`, Linux x86_64, local-path fixtures;
`docs/compatibility/APM.md` + `probes/apm/results.txt`) observed, per target (`claude`, `codex`):
generated paths differ by target — `.claude/skills/<skill>/SKILL.md` vs `.agents/skills/<skill>/SKILL.md`
plus an empty `.codex/`, both with `apm_modules/_local/<pkg>/`, `apm.lock.yaml` and a created
`.gitignore` (T1); `apm install --frozen` reproduced all five generated files byte-for-byte from the
pinned lock with no git-host or network resolution (T2); two separately staged consumer directories
never received the other package's marker (T3); APM wrote `~/.apm/config.json` and
`~/.cache/apm/last_version_check` into the invoking HOME even with everything local (T4 **FAIL**);
`sha256(apm.lock.yaml)` differs per target — `80afa759…c984e` (claude) vs `086829a2…7601` (codex) for
one dependency set (T5); and the real harness reported the staged skill with cwd = staged project (T6).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A (selected).** Stage per run **into the per-run checkout** with `apm install --frozen --target <harness>`, and run **every `apm` invocation under a per-attempt isolated `HOME`**; pin APM `0.33.0`; store `sha256(apm.lock.yaml)` per target | Matches 04 without amendment; byte-reproducible, network-free at launch (T2); harness reads the files in place (T6); the T4 HOME writes land in throwaway per-attempt state | Generated paths must be excluded from commits/checkpoints; per-target digest doubles profile bookkeeping (T5); harness auth must be provisioned into the isolated HOME — untested with real auth | APM.md T1/T2/T3/T5/T6, T4 **FAIL**; probes/apm/README.md ("Every `apm` invocation runs with `HOME=$fakehome`") |
| B. Same staging, one **shared worker `HOME`** for all `apm` runs | Simplest launcher; harness auth already present | `~/.apm/config.json`, cache and version-check marker become shared mutable state between concurrent sessions of different projects | APM.md T4 **FAIL** + "shared mutable state between sessions"; "Still untested: concurrent installs sharing a real HOME" |
| C. Stage **outside** the checkout (`apm install --root DIR`) and point harness config at it | Checkout stays clean; generated files can never be committed | Neither probed harness was shown to read skills from a redirected location — T6 only proves cwd = staged project; 04 warns target-native config semantics differ | probes/apm/README.md T6; APM.md notes `--root DIR` separates artifacts (mechanism observed, harness consumption **not** observed) |
| D. Stage at authoring time and commit `apm_modules/` + generated config to the repo | No run-time staging; reviewable in PR | Third-party content in every customer checkout; contradicts 04 "avoid modifying … source repo by default"; one repo cannot serve many harness targets (T5) | 04 § "Profile → environment → instance"; APM.md T5 (lock records per-target `deployments`) |

## Decision

Option **A**, as a concrete staging contract:

1. **Pin the tool.** APM `0.33.0` (`Agent Package Manager (APM) CLI version 0.33.0 (18c4c43)`), from
   the release tarball verified against the published `.sha256` (`e6374402…492c6b0647ae9e881f`,
   `apm-linux-x86_64.tar.gz`), kept with its `_internal/` sibling (PyInstaller layout). The worker
   image vendors it; a version bump revisits this ADR.
2. **Stage per run, into the run's checkout** (`workspaces/<run-id>/repos/<name>/`, 05 § "Workspace
   design") with `apm install --frozen --target <claude|codex>` — frozen only, never a resolving
   install at launch time (T2).
3. **One isolated `HOME` per attempt**, worker-created and worker-deleted under
   `workspaces/<run-id>/meta/` (05: `meta/` is worker-only). Every `apm` invocation — and the agent it
   prepares — runs with that `HOME`, never the worker process HOME (T4).
4. **`apm_lock_digest` = `sha256(apm.lock.yaml)` recorded per (AgentProfileRevision, target)** (T5),
   validated against the file produced by the install before launch; `deployed_file_hashes` inside the
   lock content-address each deployed file.
5. **Exclusions.** `.claude/`, `.agents/`, `.codex/`, `apm_modules/` and the APM-written `.gitignore`
   are staging output: excluded from commits, diffs, artifacts and checkpoint payloads (05 §
   "Checkpoint/recovery policy"); tie-in with ADR-0010 commit grants.
6. **APM schema stays out of the pipeline schema:** `apm.yml` / `apm.lock.yaml` are opaque versioned
   inputs identified by ref + digest — no field-level validation, no mirrored schema in our DSL, per
   14-research-notes.md § "APM" ("Do not hardcode APM schema into Communication pipeline schema").
7. **Cleanup at attempt end:** delete the attempt `HOME`; for reused workspaces revert staging paths —
   reinstall `--frozen` must reproduce the tree (T2).

## Consequences

- Positive: launch-time staging needs no network for local-path packages and is reproducible from the
  digest alone (APM.md T2 + provenance note); the T4 write set is confined to a deleted directory.
- Limitation: digests are target-specific (T5), so one profile serving two harnesses carries two lock
  digests and a target switch is a new profile revision, not a relabel.
- Limitation: APM writes into the checkout, so "clean workspace" stops meaning "no staging noise";
  anything diffing the workspace (checkpoints, artifacts, PR prep) must apply Decision 5's exclusions.
- Limitation: `apm install` does **not** compile instructions into `CLAUDE.md`/`AGENTS.md` — that is
  `apm compile` (APM.md note), which this ADR does not cover.
- Operational: worker images vendor the pinned binary rather than resolving "latest".

## Security/privacy

APM is the preparation/dependency plane, **not** an isolation boundary: APM.md's header states "This is
a preparation/dependency-plane probe, not a sandbox claim (D-017)", and T3 is "staging hygiene only —
APM remains NOT a sandbox". What this ADR buys is *state hygiene*: a per-attempt `HOME` removes a
shared writable path so one project's install cannot influence another's config or cache. Staged
`apm_modules/` is third-party code inside the workspace — sandbox grants treat it as ordinary workspace
files (see ADR-0010) and checkpoint payloads must not ship it. Supply-chain risk stays open: the pin
covers a digest-verified binary and local-path dependencies only; git/registry sources, MCP/LSP target
config and marketplaces are listed untested in APM.md, so profiles using them must not claim
reproducible provenance. Fail-open risk: an accidentally inherited `HOME` is silent — it surfaces as
cross-session config drift, not an error.

## Verification

Observed 2026-10-14 (`bash docs/compatibility/probes/apm/run.sh`, targets `claude` and `codex`): T1
per-target generated paths; T2 byte-identical `--frozen` reinstall; T3 no marker leakage between
consumer directories; T4 **FAIL** — `~/.apm/config.json` and `~/.cache/apm/last_version_check` written
into an otherwise isolated HOME; T5 lock digests `80afa759…c984e` (claude) / `086829a2…7601` (codex);
T6 `claude -p` and `codex exec` reported `alpha-skill` with cwd = staged project.

**Not verified** (this ADR must not be Accepted on these): git- and registry-sourced dependencies,
including whether `--frozen` avoids all network for them; harness behaviour when the *agent* process
itself runs under the per-attempt `HOME` and with real harness auth (only `apm` did); concurrent
installs and a shared real HOME; `apm compile`, `-g/--global`, MCP/LSP target config, marketplaces,
`apm audit`/`audit --ci` (APM.md "Still untested"); worker crash mid-staging and whether a partial
staging is caught by the digest check; Windows/macOS targets. Required before Accept: cases 1–3 and
crash-mid-staging as probe checks, plus an integration test that a workspace holding staging output
cannot be committed by an agent (ties to ADR-0010).

## Migration/rollback

Forward is additive: a profile with no `apm_package_ref` skips staging entirely. Changing the pinned
APM version means re-running the probe, re-recording per-target digests and amending Decision 1,
because `lockfile_version '1'` / `apm_version 0.33.0` are embedded in the digested file (APM.md
layout). Rollback: drop the staging step, hand the agent a checkout with no generated APM paths, and
record in the profile that the harness's own defaults apply. Cleanup of a staged workspace is `rm -rf`
of the Decision 5 paths plus the attempt `HOME` — no DB schema, wire format or history change, so no
data migration.
