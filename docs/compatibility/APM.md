# APM staging compatibility

Provenance: probed 2026-10-14 with Microsoft APM CLI
`Agent Package Manager (APM) CLI version 0.33.0 (18c4c43)`, release tarball
`apm-linux-x86_64.tar.gz` sha256
`e6374402c74318f7c8bef97a90d8572d049fdab0dc3871492c6b0647ae9e881f`
(verified against the published `.sha256`), Linux x86_64, git host access not
required (local-path fixtures). Rerun with:

```bash
bash docs/compatibility/probes/apm/run.sh > docs/compatibility/probes/apm/results.txt 2>&1
```

Raw observed output: [`probes/apm/results.txt`](probes/apm/results.txt).
This is a preparation/dependency-plane probe, not a sandbox claim (D-017).

## APM CLI upgrade 0.33.0 → 0.34.0 (2026-10-23)

The worker image now vendors APM CLI **0.34.0** (`65b3b9f`), release tarball
`apm-linux-x86_64.tar.gz` sha256
`4487af55604b4fa6f4587f3ee6e833b44ce99c491f11069790e4e13e297cde8c`
(verified against the release's own `.sha256` asset), Linux x86_64.
`internal/agent/apm/stage.go` `PinnedVersion` moved to `0.34.0`.

- **New lock digest** (measured 2026-10-23 with the real apm 0.34.0 binary via
  `COMMUNICATION_APM_REAL=1` resolve of `mattpocock/skills#v1.3.1`):
  `sha256:44cf8ba0ba5b34af878358795b4f0dbcbc5698ebfe72c7cfc162d5f7040cc55d`.
  Old (0.33.0, 2026-10-16): `sha256:f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33`.
- **A version bump invalidates existing locks**: `apm.lock.yaml` records
  `apm_version`, so the same package content now hashes to a different lock
  digest. Profiles that recorded the 0.33.0-era digest must **re-Lock** before a
  launch; the launch gate refuses a mismatch (`Stage` returns `*DigestMismatch`
  when the on-disk lock digest differs from the profile's pin).
- **BREAKING (0.34.0)**: `apm install --frozen` no longer writes
  `apm.lock.yaml`; a frozen install whose lockfile does not record every
  deployed file now fails and names the missing paths instead of silently
  repairing the lockfile. Checkouts that track a lock must have one that
  records all deployed files; fresh checkouts keep bootstrapping the lock
  through the resolving install / `apm lock`.

## Results

| Target | T1 generated paths | T2 reproducible | T3 isolated | T4 HOME untouched | T6 harness picks it up |
|--------|--------------------|-----------------|-------------|-------------------|------------------------|
| claude | `.claude/skills/alpha-skill/SKILL.md`, `apm_modules/_local/pkg-alpha/**`, `apm.lock.yaml`, `.gitignore` | PASS | PASS | FAIL | PASS (`claude -p` reported `alpha-skill`) |
| codex | `.agents/skills/alpha-skill/SKILL.md` (shared skills dir), empty `.codex/` dir, `apm_modules/_local/pkg-alpha/**`, `apm.lock.yaml`, `.gitignore` | PASS | PASS | FAIL | PASS (`codex exec` reported `alpha-skill`) |

T4 detail (identical for both targets, observed inside an isolated fake
HOME): APM wrote `~/.apm/config.json` (CLI config bootstrap) and
`~/.cache/apm/last_version_check` (empty self-update staleness marker) even
though no network package was resolved.

## Observed generated layout per target (project scope)

```
<project>/
  apm.yml                      # authored manifest (rewritten/normalized by apm)
  apm.lock.yaml                # lockfile: lockfile_version '1', apm_version 0.34.0,
                               # per-dep source coords + deployed_file_hashes
  .gitignore                   # created with "# APM dependencies / apm_modules/"
  apm_modules/_local/<pkg>/    # vendored copy of each local-path dependency
  .claude/skills/<skill>/SKILL.md      # claude target only (per-client path)
  .agents/skills/<skill>/SKILL.md      # codex target (shared skills dir)
  .codex/                              # codex target: empty directory created
```

Notes: manifest is `apm.yml` and lockfile is `apm.lock.yaml` as the spec
expected; `apm install --target {claude|codex}` and `--frozen` exist as
documented (`--runtime` is a legacy single-target alias; `--root DIR` can
separate generated artifacts from the manifest cwd). `apm install` does
**not** compile instructions into `CLAUDE.md`/`AGENTS.md` — that is
`apm compile`; instructions from a dependency only appear under
`apm_modules/` after install. The lockfile content (and therefore its
digest) differs per target because it records per-target `deployments`.

## Implications for Communication

- **Per-run staging into the checkout is viable**: `apm install --frozen
  --target <harness>` inside the per-run workspace reproduced every file
  byte-for-byte from the pinned `apm.lock.yaml`, with no git-host or network
  resolution needed for local packages. Generated paths
  (`.claude/`, `.agents/`, `apm_modules/`, `.gitignore`) must be excluded
  from commits or cleaned up per the spec's checkout-exclusion rule.
- **An isolated HOME is required**: APM writes `~/.apm/config.json` and
  `~/.cache/apm/` into the invoking user's home on every run (T4 FAIL). With
  a shared worker HOME this is shared mutable state between sessions
  (config, git cache, version-check timestamp); the worker must set a
  per-run `HOME` (or equivalent) as the spec anticipates for
  home-path harnesses.
- **`apm_lock_digest`**: store `sha256(apm.lock.yaml)` per
  AgentProfileRevision (e.g. `80afa759…c984e` for the claude variant and
  `086829a2…7601` for the codex variant of the same dependency set —
  digests are target-specific, so the digest must be recorded per target).
  `deployed_file_hashes` inside the lock additionally content-address each
  deployed file; `apm audit`/`audit --ci` verify on-disk integrity.
- **Isolation between staged sessions held at file level** (T3): separate
  consumer directories never received the other package's marker. This is
  staging hygiene only — APM remains NOT a sandbox.
- **Still untested**: git/registry-sourced dependencies (supply-chain pinning
  beyond local paths), MCP/LSP target config (e.g. generated
  `.mcp.json`-style files), `apm compile` output semantics, `-g/--global`
  scope, registry marketplaces, concurrent installs sharing a real HOME,
  behavior with harness auth/env present, and Windows/macOS targets.

## M3 exit-run observations (apm 0.33.0, `communication-worker:dev`, 2026-10-15)

- **`--frozen` verifies the lockfile is PRESENT, not that upstream bytes match
  it (the A5 caveat, now proven twice):**
  1. `apm install --frozen` **rewrites `apm.lock.yaml` in place** — it
     re-serializes and re-hashes local-path dependency content, so the bytes
     on disk after staging are generally *not* the bytes that were committed
     (`b6c7…` → `f0be…` after one frozen install against a mutated upstream;
     deterministic and idempotent once upstream is stable). A profile's
     `apm_lock_digest` is therefore only usable if it pins the
     **post-install** bytes.
  2. Mutating a local-path dependency's content afterwards **moves the
     on-disk digest** (drift is visible) and the worker's digest gate refuses
     the launch with a named-digest failure. A profile *without* a pin would
     silently stage the mutated content — the pinned digest is load-bearing.
- **A tracked `apm.lock.yaml` cannot be excluded from git** — exclusion files
  do not apply to tracked content and `check-ignore` says so. Declaring it as
  an APM-generated path used to fail prepare outright;
  `internal/workspace/git` now drops tracked declarations (`TestDeclareExclusionsSkipsTrackedPaths`)
  and the rewritten lock simply rides the unit's run ref.
- **The lock is generated with `apm lock`, not `apm install`** (0.34 CLI):
  `install` on an app whose `dependencies.apm[]` list is empty answers
  "No changes — install state already up to date" and writes no lock. The
  schema is `dependencies: {apm: [<path-or-source#ref>]}`; a
  `pkg: {path: …}` mapping parses as *zero* dependencies.
- Observed PASS, exit run C14 (contract § 7): frozen staging across an
  upstream mutation refuses rather than restages (C14e), digest gate holds
  (C14b: staged tree + completed turn with post-install digest == pin),
  per-attempt HOME (T4) unchanged, and the staged trees stay out of the
  project's tracked surface (C14b `git status`).

## Git-tag sources (spike 2026-10-16)

Probed inside `communication-worker:dev` (apm 0.33.0, `/opt/apm/apm`, git 2.47)
in throwaway containers, per-run `HOME=/w/home`, anonymous https to github.com.
Target: `mattpocock/skills`; tags from `git ls-remote --tags` (peeled):
`v1.3.1` → `24fe0ef7737efae15c87225755e9f6f5965e4888`,
`v1.3.0` → `984a2c023c9fb42bb6ea40c70a652284a109dc05`. Manifest used:

```yaml
name: spike-tag
version: 0.1.0
description: apm git-tag spike
dependencies:
  apm:
    - mattpocock/skills#v1.3.1   # owner/repo#<tag|branch|SHA>; also object
                                 # form {git:, ref:, path:, skills:}
```

| Test | claude | codex | Evidence (literal tails) |
|------|--------|-------|--------------------------|
| T-tag-1 install at tag | PASS | PASS | `[+] mattpocock/skills #v1.3.1 @24fe0ef7` / `27 skill(s) integrated -> .claude/skills/` (codex: `-> .agents/skills/` + empty `.codex/`); generated: `.claude/skills/*/SKILL.md`…, `apm_modules/mattpocock/skills/**`, `apm.lock.yaml`, `.gitignore` |
| T-tag-2 lock records resolved commit | PASS | PASS | `resolved_commit: 24fe0ef7737efae15c87225755e9f6f5965e4888` / `resolved_ref: v1.3.1` + per-file `deployed_file_hashes` + `content_hash: sha256:127ccf2b…` |
| T-tag-3 reproducible (`--frozen` after deleting trees) | PASS | PASS | claude lock `f6bfa2d6…e33` SAME, tree `6a2e0a1c…378` SAME; codex lock `a303a649…89e` SAME, tree `a14a2ca0…cc3` SAME (`apm install --frozen --target t` → "Lockfile presence verified") |
| T-tag-4 different tag → different digest | PASS | n/a (digest is target-specific; claude shown) | `#v1.3.0` → `@984a2c02`, lock `14edbd6c…33c` ≠ `f6bfa2d6…e33` |
| T-tag-5 single skill from multi-skill repo | PASS | PASS (same flag) | `--skill grill-me`: apm.yml persists `skills: [grill-me]`, lock persists `skill_subset: [grill-me]`, only `.claude/skills/grill-me/**` deployed; frozen replay identical (`510cdc49…966`/`05738bc0…059a`). Virtual-subdirectory form also works: `mattpocock/skills/skills/engineering/ask-matt#v1.3.1` deploys only ask-matt; a wrong subpath fails loudly ("Subdirectory … not found", nothing committed) |

Key extra observation: a `--frozen` reinstall with `--network none` succeeded
identically — for git deps the frozen path replays the **locked commit** with
no ref discovery (0.33 `install --help` also says `--frozen` rejects a lock
"out of sync with apm.yml, including Git source, ref"). The lock digest was
stable across repeat frozen installs (no in-place rewrite, unlike the A5
local-path case).

### Meaning for `internal/agent/apm/stage.go`

- `sha256(apm.lock.yaml)` **does pin the tag's content**: the lock carries
  `resolved_commit`, and the digest changes when the pinned content changes
  (T-tag-2/3/4). So the existing digest gate is sufficient for git-tag refs.
- **A moved tag cannot change content under the same lock with `--frozen`**
  (proven offline): the clone is by commit, and only `apm install` without
  `--frozen`, `--refresh`, or `apm update` re-resolves the ref. Keep
  `--frozen` in `Stage`; a bare install would let a force-pushed tag move the
  staged tree (and then the digest gate is what refuses the launch).
- Caveat inherited from A5b: the pin is only load-bearing if profiles record
  the post-install digest; a profile with no `apm_lock_digest` stages whatever
  the tag currently points at.
- T5: single-skill selection persists in both apm.yml and the lock, so it
  survives frozen per-run staging; the `--skill` flag itself is not needed by
  `Stage` (manifest-authored is enough).

## Profile APM package end to end (2026-10-16)

Lab: compose project `communication-m4` (LB :18091, api-a/b :18092/:18093,
worker-a/worker-b), seeded at HEAD. Profile `skills-demo` (launcher claude,
permission_mode `ask`) pins `mattpocock/skills#v1.3.1` / target `claude` /
digest `sha256:f6bfa2d6…e33`. Scratch client: `$HOME/.cache/apm-e2e/probe.py`
(login + conversation helpers copied from `e2e/m4/e2e_m4_exit.py`).

Steps: alice → `POST /api/v1/projects/<M4 Exit>/conversations` with
`agent_profile_id=skills-demo` + the prompt "List the names of the skills
available to you in .claude/skills, one per line, nothing else." → poll
`GET /api/v1/conversations/<id>` → read `domain_events`.

**Verdict: FAIL (end to end) — staging refuses before the agent launches.**
(superseded by the re-run below)
Turn `01a143bc-f8d5-7848-92b3-60e4a4926d67` → `failed` in 0.8s; no
`conversation.message.agent`, no permission prompt, nothing in `.claude/`.

Literal evidence (`conversation.turn.failed`, also the only apm worker log line):

```
worker: stage apm context into app: apm install --frozen --target claude in
/workspaces/conversation/01a143bc-f8d4-7dd6-8113-ae62e979919b/work/repos/app:
exit status 1 ([x] No apm.yml found
[i] Run 'apm init' to create one, or:
[i]   apm install <org/repo> to auto-create + install
[!] Install interrupted after 0.0s.)
```
(worker-b-1, `logs worker-a worker-b --since 20m | grep -i apm`; ran on
`communication-m4-worker-b-1`)

```
$ ls -a …/work/repos/app   ->  . .. .git README.md hello.py pytest.ini tests
$ find …/<workspace> -maxdepth 5 -name .claude   ->  (none; only work/home/.cache/apm)
```

**Finding F1 (the blocker).** No code path turns `apm_package_ref` into an
`apm.yml` in the run checkout (`grep -rn "apm.yml" internal/` → comments only);
`Stage` runs the install against a checkout that carries only what the project
repo tracks — and the M4 fixture repo tracks no manifest. So every APM-pinned
profile fails the turn at staging. Fix sketch (not applied): `prepare`/`Stage`
must materialize the manifest (`dependencies.apm: [<ref>]`, object form for
`--skill`/subdirectory refs) into the checkout *before* `apm install`, and keep
it in the exclusion set so it never reaches a checkpoint.

**Finding F2 (`--frozen` cannot bootstrap a lock).** Proven offline in the same
image (`communication-m4-worker-b-1`, throwaway `/tmp`, `HOME` per run): with
`apm.yml` authored but no lock, `apm install --frozen --target claude` →
`[x] --frozen requires apm.lock.yaml to exist at …`. `apm lock` writes it
(`[+] mattpocock/skills #v1.3.1 @24fe0ef7`), then frozen install →
"Lockfile presence verified", `sha256(apm.lock.yaml) =
f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33` — **equal to
the pin** — and `.claude/skills/grill-me/SKILL.md` present. So `Stage`'s
install-then-compare order can never work for a fresh checkout: the lock has to
come from `apm lock` (or be tracked in the repo), which is what T4's "lock is
generated with `apm lock`" note already says.

Next: implement F1+F2 (materialize apm.yml + `apm lock`, or track a lock) and
re-run this probe; PASS requires the reply to name `grill-me` and the checkout
to contain `.claude/skills/grill-me/SKILL.md`.

### Re-run after ADR-0030 Amendment 1 — PASS

Lab rebuilt from fbf4fd5 (staging materializes the manifest + `apm lock`).

```
profile skills-demo: apm_package_ref=mattpocock/skills#v1.3.1 apm_target=claude
  apm_lock_digest=sha256:f6bfa2d63d31f7834824817efa6cbf4d8abbe9dc80dc77b6fd0645a5ccd14e33 (created via POST /agent-profiles + PATCH, 201/200)
turn rows: 01a143c8-6fc7-7510-a933-48d2a2e7915b|completed|end_turn|2026-10-16 08:16:11Z|08:16:22Z
prompt: "List the names of the skills available to you in .claude/skills, one per line, nothing else."
agent reply (27 lines): ask-matt code-review codebase-design diagnosing-bugs domain-modeling grill-me grill-with-docs grilling handoff implement implement-spec improve-codebase-architecture pr prototype research retro setup-matt-pocock-skills tdd teach to-questionnaire to-spec to-tickets triage wait-what wayfinder wizard writing-for-agents
```

**Control.** The host's `~/.claude` (mounted into the lab worker as
`CLAUDE_CONFIG_DIR`) contains NO `grill-me` / Matt Pocock skills
(`ls ~/.claude/skills` → playwright-cli, synced; `grep -r grill-me
~/.claude/plugins` → nothing), so the 27 names can only come from the staged
package; 27 equals the spike's "27 skill(s) integrated".

**Not observed live.** The conversation workspace's `repos/` dir was already
empty when inspected after the turn, so the git-excluded/clean-status property
is covered by `internal/agent/apm/stage_test.go` only, not by live evidence.

**Result: agent sees the pinned package's skills: PASS (claude target); codex
target NOT RUN.**
