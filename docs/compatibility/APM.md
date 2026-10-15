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
  apm.lock.yaml                # lockfile: lockfile_version '1', apm_version 0.33.0,
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
- **The lock is generated with `apm lock`, not `apm install`** (0.33 CLI):
  `install` on an app whose `dependencies.apm[]` list is empty answers
  "No changes — install state already up to date" and writes no lock. The
  schema is `dependencies: {apm: [<path-or-source#ref>]}`; a
  `pkg: {path: …}` mapping parses as *zero* dependencies.
- Observed PASS, exit run C14 (contract § 7): frozen staging across an
  upstream mutation refuses rather than restages (C14e), digest gate holds
  (C14b: staged tree + completed turn with post-install digest == pin),
  per-attempt HOME (T4) unchanged, and the staged trees stay out of the
  project's tracked surface (C14b `git status`).
