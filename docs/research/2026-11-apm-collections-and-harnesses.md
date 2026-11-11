# APM collections, pstack, Matt Pocock's skills, and Codex / Pi as ACP agents

**Status:** research only — no code changed, no decision taken. Every external fact was read
**2026-11-11** unless another date is given. Repo claims carry a `file:line`.
Nothing here upgrades a row in `docs/compatibility/`: per `communication-spec/12-test-strategy.md`
a capability is PASS only with a real observed run, and §2/§6 below name the spikes that would be
needed before this repo could consume pstack or a multi-package profile collection.

## 1. APM — microsoft/apm, the Agent Package Manager

**Answer**

* **Latest release: `v0.35.0`, published 2026-10-22T22:51:41Z** (GitHub releases API,
  `releases/latest`). License at that tag is **MIT**; the `Unreleased` section of `CHANGELOG.md`
  announces a move of APM-owned software/primitives to **Apache-2.0** (docs CC-BY-4.0), so the
  next release changes the license the worker image redistributes. Our image vendors **0.34.0**
  (`worker/Dockerfile:85-86`), and `apm.lock.yaml` records `apm_version`, so any bump moves every
  recorded lock digest (`docs/compatibility/APM.md:25-33`).
* **Primitives are declared by *layout*, not by manifest fields.** A package authors
  `.apm/skills/<name>/SKILL.md`, `.apm/instructions/*.instructions.md`,
  `.apm/prompts/*.prompt.md`, `.apm/agents/*.agent.md`, `.apm/hooks/*.json`; root `SKILL.md`
  (single skill bundle) and `skills/<name>/SKILL.md` (many skills in one repo) are other
  recognized shapes. `apm.yml` itself carries identity + policy: required `name`, `version`;
  optional `description`, `author`, `license`, `target`/`targets`, `type`, `scripts`, `includes`,
  `policy`, `registries`, `x-*` extension keys, `replace` (candidate), `devDependencies`,
  `compilation.*`, `marketplace:` — plus `dependencies.apm`, `dependencies.mcp`,
  `dependencies.lsp`. **MCP and LSP servers *are* manifest fields**; skills/instructions/prompts
  are not.
* **Collections: the `.collection.yml` kind is dead.** APM 0.12.0 (2026-05-03) shipped
  "**BREAKING: dropped support for `.collection.yml` / `.collection.yaml` virtual packages**…
  Convert any such entry to a regular `apm.yml` with a `dependencies:` section, then reference the
  directory itself" (CHANGELOG line 2126, PR #1097 closing #1094; the maintainer comment on #1094
  states "collections support is removed entirely (commit `f1b8109a`)"). Two live notions remain:
  **(a)** a *skill collection* = one repo holding `skills/<name>/SKILL.md`, cherry-picked with
  `--skill` / the object-form `skills:` list; **(b)** a *meta-package* = a dependency-only
  `apm.yml` whose only job is to pull other packages (accepted after #1094/#1097; the older
  "must carry `.apm/`" rule and the `/collections/` path trap are both gone).
* **Composition.** `dependencies.apm` entries are strings (`owner/repo[/virtual/path]#ref`) or
  objects `{git, path, ref, alias, type, skills, targets, allow_insecure}` — unknown object keys
  fail closed. Resolution is transitive; the pipeline is deterministic:
  resolve → policy gate → Unicode/security scan → integrate → write `apm.lock.yaml`. Target
  selection precedence is `--target` > `apm.yml targets:` > filesystem auto-detection.
  Two paths requiring different immutable commits of one identity **fail the install**.
* **Name conflicts between two packages' skills are ownership handoffs, not merges.** The lock's
  `deployments` rows carry `owners` (oldest→newest) plus one `active_owner`, so the last claimant
  wins per deployed locator; 0.35.0 hardened this ("preserves separately owned assets when
  dependencies share a skill directory", "checks the complete selected skill plan for differing
  unmanaged files before deploying any dependency", PRs #3313/#3314). A user-authored
  same-named skill now refuses the whole selected plan (install "Behavior" section); `--force`
  remains the destructive override.
* **Lockfile** (`apm.lock.yaml`, commit it): `lockfile_version` (`"1"`, `"2"` for
  registry/git-semver; `"3"` is an unratified replacement candidate), `apm_version`,
  `dependencies[]` with `repo_url`, `virtual_path`, `resolved_ref`, `resolved_commit`, `version`,
  `depth`, `package_type`, `resolved_by`, `skill_subset`, `deployed_files`,
  `deployed_file_hashes`, `content_hash`, vendor `x-*` keys; then `mcp_servers`, `mcp_configs`,
  `deployments[]` (the ownership ledger), `local_deployed_files`/`local_deployed_file_hashes`.
  `resolved_commit` is the pin `apm audit` and `--frozen` replay; `apm_version` is why a CLI bump
  moves the digest.
* **Harness targeting.** `--target` accepts `copilot, claude, grok-build, cursor, opencode, codex,
  gemini, antigravity, windsurf, kiro, intellij, vscode, agent-skills, hermes, grok-bot, all`
  (+ experimental). Auto-detect signals: `.claude/`|`CLAUDE.md`→claude, `.codex/`→codex,
  `.cursor/`|`.cursorrules`→cursor, `.opencode/`→opencode, `.github/copilot-instructions.md`→copilot.
  Skills converge on the shared `.agents/skills/` for copilot/cursor/opencode/gemini/antigravity/
  codex/hermes(project)/windsurf; `claude` keeps `.claude/skills/`. `apm compile` is a separate
  step that folds `.apm/instructions/**` (own + `apm_modules/`) into root context files
  (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`); for `codex`/`gemini`/`opencode`/`hermes` APM prints a
  post-install reminder that compile is required.
* **Minimal apm.yml that is "a collection of three GitHub skill repos"** (dependency-only
  meta-package; no `.apm/` required any more):

  ```yaml
  name: communication-team-collection
  version: 0.1.0
  description: Three curated skill packs installed as one bundle.
  targets: [claude]
  dependencies:
    apm:
      - mattpocock/skills#v1.3.2
      - cursor/plugins/pstack/skills/poteto-mode#<full-40-char-commit-sha>
      - github/awesome-copilot/skills/review-and-refactor
  ```

  Pin every entry: a bare `owner/repo` follows the default branch, which is what
  `docs/compatibility/APM.md` and ADR-0030 §3 already refuse for profile refs.

**Evidence**

* https://github.com/microsoft/apm/releases/latest — `v0.35.0`, `2026-10-22T22:51:41Z`.
* https://raw.githubusercontent.com/microsoft/apm/main/CHANGELOG.md — 0.35.0 block (skill-dir
  ownership #3313, selected-plan conflict check #3314, Unreleased license change).
* https://microsoft.github.io/apm/reference/manifest-schema/ — §3 top-level fields, §4.1
  `dependencies.apm` string/object grammar, §4.1.3 virtual packages +
  "Removed (#1094): the legacy `.collection.yml`… form is no longer supported", §4.2 `mcp`,
  §4.3 `lsp`, Appendix A complete example.
* https://microsoft.github.io/apm/reference/package-types/ — layout summary table;
  Skill collection (`skills/<name>/SKILL.md`) + `--skill`/`skill_subset`;
  Plugin collection vs Portable Agent Plugin (`$schema` discrimination).
* https://microsoft.github.io/apm/consumer/install-packages/ — pipeline phases, target
  precedence, detection, what to commit, transitive MCP gating.
* https://microsoft.github.io/apm/reference/cli/install/ — `--target` value list, `--skill`,
  `--frozen`, "Unmanaged skill conflicts fail by default", immutable-requirement conflicts.
* https://microsoft.github.io/apm/reference/lockfile-spec/ — top-level + per-entry fields,
  `deployments` `owners`/`active_owner`, `skill_subset`, drift/audit mapping.
* https://microsoft.github.io/apm/reference/targets-matrix/ — deploy roots, skills convergence,
  detection-signal whitelist, post-install instruction compilation.
* https://github.com/microsoft/apm/issues/1094 (+ maintainer comment 2026-05-02) and
  https://github.com/microsoft/apm/issues/1120 — collections removal, plugin namespacing/collision
  history.
* Local: `worker/Dockerfile:85-86` (APM 0.34.0 + sha256 pin),
  `docs/compatibility/APM.md:17-58` (0.34.0 upgrade, lock digest, per-target layout),
  `internal/agent/apm/stage.go:51` (`PinnedVersion = "0.34.0"`).

## 2. pstack (Lauren Tan / @poteto)

**Answer**

* **Where it lives:** the `pstack/` directory of `github.com/cursor/plugins` — 705 files, MIT
  (`pstack/LICENSE`, "Copyright (c) 2026 Lauren Tan"), version **0.15.36** in both
  `pstack/plugin.json` and `pstack/.cursor-plugin/plugin.json`. The repo itself carries no tags
  and no releases, so an APM pin must be a **full commit SHA** (or `main`).
* **Layout:** `pstack/{plugin.json,.cursor-plugin/plugin.json,README.md,LICENSE,assets/logo.png}`,
  `pstack/skills/` (**58** `SKILL.md` skills), `pstack/agents/{poteto-agent.md,comment-sicko.md}`,
  `pstack/automations/benny/` (FOR_AGENTS.md + 3 automation skills + prompt templates),
  `pstack/docs/guide/` (10 chapters + images) and `pstack/docs/harness/claude-code.md`.
  `poteto-mode` is the router skill and ships **23 playbooks**: investigation, bug-fix,
  perf-issue, hillclimb, runtime-forensics, trace-forensics, feature, refactoring, prototype,
  visual-parity, authoring-a-skill, eval, babysit, shipping, autonomous-run, orchestrate,
  autopilot-full, autopilot-stack, session-pickup, pause-safely, multi-phase-plan,
  worktree-cleanup, opening-a-pr.
* **Skill list (58), one line each.** Entry/routing: `poteto-mode` (default entry for any
  non-trivial task, picks a playbook), `poteto-help` (which skill/playbook fits), `figure-it-out`
  (no playbook fits → design one), `in-your-own-words` (play the goal back first), `sharpen`
  (deepen the prompt, don't do the task), `automate-me` (draft your own `-mode`).
  Understanding: `how` (subsystem walkthrough), `why` (why it was built this way, parallel
  evidence sources), `teach` (weave how+why into one explanation), `recall` (rebuild recent
  context), `ketchup` (what changed since my last message), `ketchup-video` (same as slides video),
  `blast-radius` (what else could break), `statechart` (TLA+ model + mermaid statechart of the
  user-visible behavior). Design/build: `architect` (caller usage/types/module shape first),
  `arena` (N parallel attempts, keep the best parts), `swarm` (N parallel workers, one report),
  `interrogate` (multi-model break-my-diff), `tdd` (failing test first),
  `typescript-best-practices`, `correct` (mine repeated corrections to the highest enforcing
  level), `show-me-your-work` (TSV decision trail). Verification: `create-verification-skill`,
  `maintain-verification-skill`, `create-formal-verification-skill`,
  `maintain-formal-verification-skill`, `benchmark-checklist`. Writing/cleanup: `unslop`, `bro`,
  `no-comments`, `technical-writing`, `reflect`, `setup-pstack` (per-role model config),
  `make-bot-ui` (Grok Bot webhook dashboard). Plus **24 `principle-*` skills**
  (`attack-the-premise`, `boundary-discipline`, `build-the-lever`,
  `encode-lessons-in-structure`, `exhaust-the-design-space`, `experience-first`,
  `explain-the-number`, `fix-root-causes`, `foundational-thinking`,
  `guard-the-context-window`, `laziness-protocol`, `make-operations-idempotent`,
  `migrate-callers-then-delete-legacy-apis`, `minimize-reader-load`, `model-the-domain`,
  `never-block-on-the-human`, `outcome-oriented-execution`, `prove-it-works`,
  `redesign-from-first-principles`, `separate-before-serializing-shared-state`,
  `sequence-verifiable-units`, `subtract-before-you-add`,
  `test-behavior-not-implementation`, `type-system-discipline`) — machine-readable engineering
  rules the mode skill invokes.
* **Install.** Cursor: `/add-plugin pstack`. Claude Code:
  `/plugin marketplace add cursor/plugins` then `/plugin install pstack@cursor-plugins`
  (auto-update off by default for third-party marketplaces). Claude does **not** install
  `pstack/` — the root `.claude-plugin/marketplace.json` maps `pstack` → the *generated* copy
  `harness/pstack/claude-code` (650 files: 58 skills, 2 agents, guide, README, its own
  `.claude-plugin/plugin.json`), produced by `node scripts/generate-pstack-harness-trees.mjs`
  with CI refusing a stale copy. Commands are namespaced: `/pstack:poteto-mode`.
* **Cursor-specific parts:** `.cursor-plugin/plugin.json` (displayName/logo/category/tags);
  `automations/benny` (runs on Cursor Automations, "benny runs on cursor automations, so it is
  cursor-only"); Bugbot steps; Cursor cloud agents; `.cursor/rules/*.mdc`; Cursor tool names
  (`Task`, `AskQuestion`, `subagent_type: generalPurpose`, `environment: "cloud"`), and Cursor
  model slugs (`claude-opus-5-5-xhigh`, `grok-*`). `pstack/docs/harness/claude-code.md` is the
  translation table (e.g. `Task`→`Agent`, `environment:"cloud"`→`isolation:"worktree"`,
  model rule `~/.cursor/rules/pstack-models.mdc`→`~/.claude/rules/pstack-models.md`) and names the
  skip protocol: `Skipped in Claude Code: <step>. <reason>.`
* **open-pstack (`ericlitman/open-pstack`, MIT, v1.21.0, 567 stars, pushed 2026-11-08)** is the
  community translation: "Open Pstack 1.21.0 tracks pstack 0.15.36 at Cursor commit
  `2776ddd2…`" with `UPSTREAM.md`, `CHANGES.md`, `NOTICE.md`. It changes: **one shared skill tree**
  for Claude Code **and Codex** (Lauren's pstack does not run in Codex) plus Grok/T3 Code; a
  typed **model+provider registry** (skills point at catalog role defaults instead of naming
  models; a new provider is one adapter module); a **runner** that drives nine other providers'
  CLIs with allowlisted environments and a per-run receipt; `setup-pstack` writes a checked
  `provider:model@effort` sheet; `arena`/`architect`/`interrogate` default to three-model panels
  (Opus/Sol/Grok vs Lauren's Opus 5.5/Grok); extra skills (`babysit`, `deslop`, `fix-ci`,
  `fix-merge-conflicts`, `get-pr-comments`, `verify-open-pstack`); manifests per harness at
  `plugins/pstack/{.claude-plugin,.codex-plugin,.grok-plugin}/plugin.json`. Claude Code installs
  `/plugin marketplace add ericlitman/open-pstack` + `/plugin install pstack@open-pstack` —
  and the README warns to install **only one** of the two, since both use the `pstack:` prefix.
* **Can APM consume pstack today?** Partially, and not by the obvious reference. APM does install
  from a repo **subdirectory** (`owner/repo/<virtual-path>#ref`, and our own probe proved the
  nested form `mattpocock/skills/skills/engineering/ask-matt#v1.3.1`, APM.md T-tag-5), and it does
  consume Claude/Agent plugins: `.claude-plugin/` or a `plugin.json` with an *unrecognized*
  `$schema` is dissected into primitives, while a `plugin.json` carrying the **recognized Agent
  Plugins v1 `$schema`** (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`) is a
  *Portable Agent Plugin* — "installed whole and registered when the effective targets include
  Copilot", "nothing is dissected". **pstack's `plugin.json` (and `harness/pstack/claude-code/plugin.json`)
  both declare that v1 `$schema`**, and pstack has no `pstack/.claude-plugin/` (404) and no
  `apm.yml`. So `apm install cursor/plugins/pstack#<sha> --target claude` is a coin-flip between
  "portable Agent Plugin, nothing deployed to `.claude/skills/`" and the 0.31.0 behaviour that
  makes such an install exit 1 ("exits `1` when Agent Plugins v1 target exclusion leaves no
  package deployed"). **Do not assume it works — spike it.**
* **Smallest wrapper that would work** (per-skill virtual subdirectories, the shape APM.md
  T-tag-5 already proved against `mattpocock/skills`; a wrapper repo of your own, one manifest,
  no `.apm/` needed):

  ```yaml
  # pstack-apm/apm.yml  — a wrapper repo whose only content is this manifest
  name: pstack-collection
  version: 0.15.36
  description: pstack (Lauren Tan) skills, pinned to one cursor/plugins commit, installed by APM.
  targets: [claude]
  dependencies:
    apm:
      - cursor/plugins/pstack/skills/poteto-mode#<sha>
      - cursor/plugins/pstack/skills/interrogate#<sha>
      - cursor/plugins/pstack/skills/unslop#<sha>
  ```

  Caveats: each entry is a separate clone of `cursor/plugins` at that SHA (content-addressed cache
  makes the repeat fetch cheap, but the graph is N deps); pstack skills cross-reference each other
  by name (`/why` invoking `how`, the mode routing to playbooks), so a partial subset degrades
  silently rather than failing; and the Cursor→Claude translation table
  (`docs/harness/claude-code.md`) is a *doc*, not a rewrite — APM copies SKILL.md bytes verbatim,
  so a Claude-launched pstack still reads Cursor tool names unless you consume the generated
  `harness/pstack/claude-code` tree instead. For our purposes the honest options are (a) the
  generated Claude tree via per-skill subdirectory refs, or (b) fork-and-vendor.

**Evidence**

* https://github.com/cursor/plugins (tree API `git/trees/main?recursive=1`, 2843 paths; 705 under
  `pstack/`, 58 `pstack/skills/*/SKILL.md`, 24 `principle-*`, 23 playbooks under
  `pstack/skills/poteto-mode/playbooks/`, `pstack/agents/`, `pstack/automations/benny/`).
* https://raw.githubusercontent.com/cursor/plugins/main/pstack/plugin.json and
  `…/pstack/.cursor-plugin/plugin.json` — `$schema` agent-plugins.org 1.0.0, `version: 0.15.36`,
  `license: MIT`, `skills: ./skills/`, `agents: ./agents/`.
* https://raw.githubusercontent.com/cursor/plugins/main/pstack/LICENSE — MIT, Lauren Tan 2026.
* https://raw.githubusercontent.com/cursor/plugins/main/pstack/README.md — install gestures
  (`/add-plugin pstack`; `/plugin marketplace add cursor/plugins` + `/plugin install
  pstack@cursor-plugins`), namespacing, generated-copy rule, playbook/skill tables,
  "benny runs on cursor automations, so it is cursor-only".
* https://raw.githubusercontent.com/cursor/plugins/main/pstack/docs/harness/claude-code.md — the
  Cursor→Claude tool/model/paths tables and the "Cursor-only features" skip list.
* https://raw.githubusercontent.com/cursor/plugins/main/.claude-plugin/marketplace.json —
  `pstack` → `source: ./harness/pstack/claude-code`.
* https://github.com/cursor/plugins/tags and `/releases` — both empty (read 2026-11-11): pin by SHA.
* https://github.com/ericlitman/open-pstack — MIT, v1.21.0, README ("Open Pstack 1.21.0 tracks
  pstack 0.15.36 at Cursor commit 2776ddd2…", model/provider registry, runner, T3, three-model
  panels, `plugins/pstack/…` manifests).
* APM consumption: https://microsoft.github.io/apm/reference/manifest-schema/ §4.1.3 (subdirectory
  virtual packages) + https://microsoft.github.io/apm/reference/package-types/ ("Plugin collection
  (`plugin.json`)" dissected vs "Agent Plugin … nothing is dissected"; `--skill` cherry-picking by
  leaf or source-relative path) + https://github.com/microsoft/apm/blob/main/CHANGELOG.md (0.31.0
  "Non-dry-run `apm install` now exits `1` when Agent Plugins v1 target exclusion leaves no package
  deployed", #2806).
* Local: `docs/compatibility/APM.md:153-160` (T-tag-5 subdirectory + `--skill` persistence),
  `docs/compatibility/APM.md:140-152` (`mattpocock/skills#v1.3.1` → `24fe0ef7…`, 27 skills).

## 3. Matt Pocock's skills

**Answer**

* **Repo:** `github.com/mattpocock/skills`, MIT ("Copyright (c) 2026 Matt Pocock"), latest tag
  **v1.3.2** (v1.3.1 is what our compatibility doc pins), last push 2026-11-09, ~321k stars.
* **Layout:** 39 `SKILL.md` files under `skills/<category>/<skill>/SKILL.md` — categories
  `engineering` (20), `productivity` (7), `misc` (4), `in-progress` (8) — plus `docs/`,
  `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`, `SCOPE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
  (changesets), `scripts/`, `.agents/adr/`, and **`.claude-plugin/{plugin.json,marketplace.json}`**.
  `plugin.json` (`mattpocock-skills`, 1.3.2, MIT) declares an explicit `skills:` list of **27**
  paths — the authoritative set, which is why our probe counted "27 skill(s) integrated" out of a
  repo carrying 39 skills. There is **no `apm.yml`** in the repository.
* **Skills, one line each.** Engineering: `ask-matt` (router over the user-invoked skills),
  `grill-with-docs` (grilling + builds GLOSSARY.md/ADRs inline), `triage` (issues through a
  role state machine), `improve-codebase-architecture` (deepening opportunities as an HTML
  report, then grill), `setup-matt-pocock-skills` (one-time per repo: tracker, triage labels, doc
  layout), `to-spec` (conversation → spec on the tracker), `to-tickets` (spec → tracer-bullet
  tickets with blocking edges), `implement` (build the spec, driving `/tdd`, closing with
  `/code-review`), `implement-spec` (whole spec on one integration branch via parallel implementer
  subagents), `wayfinder` (decision-ticket map for work larger than one session), `retro`
  (post-session environment improvements), `prototype` (throwaway answer to a design question),
  `diagnosing-bugs` (red→minimise→hypothesise→instrument→fix→regression-test), `research`
  (cited markdown from primary sources), `tdd` (red-green-refactor vertical slices),
  `domain-modeling` (challenge terms, update glossary/ADRs), `codebase-design` (deep-module
  discipline/vocabulary), `code-review` (Standards + Spec axes as parallel sub-agents), `pr`
  (PR-body shape: summary, before/after evidence, merge-danger call), `wizard` (interactive bash
  wizard for human-only steps). Productivity: `grill-me`, `grilling` (the reusable interview
  primitive), `handoff`, `teach` (multi-session teaching workspace), `to-questionnaire`,
  `wait-what`, `writing-for-agents`. Misc: `git-guardrails-claude-code`,
  `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`. In-progress: `chief-of-staff`,
  `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `software-factory`, `writing-beats`,
  `writing-fragments`, `writing-shape`.
* **Install method (per agent).** Claude Code: `claude plugin install
  mattpocock-skills@claude-plugins-official`. Codex: `codex plugin marketplace add
  mattpocock/skills` + `codex plugin add mattpocock-skills@mattpocock`. Copilot:
  `copilot plugin marketplace add mattpocock/skills` + `copilot plugin install
  mattpocock-skills@mattpocock` (plus an `extraKnownMarketplaces` entry for auto-update).
  Gemini: `gemini skills install https://github.com/mattpocock/skills.git --path
  skills/engineering` (and again for `--path skills/productivity`). Everything else / editable
  files: `npx skills@latest add mattpocock/skills -a <agent>` (cursor, opencode, devin, windsurf,
  amp, **pi**). Then run `/setup-matt-pocock-skills` once per repo. The README's own warning:
  pick **one** path, "because installing both gives you every skill twice".
* **APM?** Yes, already proven here: `mattpocock/skills#v1.3.1` installs cleanly for both
  `claude` and `codex` targets, `--skill grill-me` persists a `skills:` subset into both
  `apm.yml` and the lock, and the nested virtual-subdirectory form
  `mattpocock/skills/skills/engineering/ask-matt#v1.3.1` deploys exactly one skill
  (`docs/compatibility/APM.md:140-160`). This is the reference package for our profile pins.

**Evidence**

* https://api.github.com/repos/mattpocock/skills (MIT, main, pushed 2026-11-09T14:03:07Z) and
  `…/tags` (`v1.3.2`, `v1.3.1`, …).
* https://api.github.com/repos/mattpocock/skills/git/trees/HEAD?recursive=1 (282 paths; 39
  `SKILL.md`; category dirs `engineering|productivity|misc|in-progress|deprecated`; no `apm.yml`;
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`).
* https://raw.githubusercontent.com/mattpocock/skills/main/.claude-plugin/plugin.json —
  `name: mattpocock-skills`, `version: 1.3.2`, `license: MIT`, `skills:` = 27 declared paths;
  `…/marketplace.json` — one plugin entry, `source: "./"`.
* https://raw.githubusercontent.com/mattpocock/skills/main/README.md — installation commands per
  agent, `/setup-matt-pocock-skills`, per-skill one-liners.
* Local: `docs/compatibility/APM.md:137-160` (git-tag spike against this repo, both targets),
  `internal/api/agent_profiles_test.go:155` (`apm_package_ref: "mattpocock/skills#v1.3.1"`).

## 4. Codex as an ACP agent

**Answer**

* **Yes — but not in the repo the question names.** `zed-industries/codex-acp` is
  **archived** (last push 2026-07-22, npm `@zed-industries/codex-acp` latest **0.16.0**, GitHub
  release v0.16.0 dated 2026-06-08) and its README says development moved to
  **`agentclientprotocol/codex-acp`**; that repo's latest release is **v2.6.0**
  (published 2026-11-08; npm dist-tags `latest: 2.6.0`, `preview: 2.6.1-preview.2`), Apache-2.0.
  This repo already uses the new package and pin:
  `@agentclientprotocol/codex-acp` **2.2.2** (`internal/agent/acp/launchers.go:132-141`).
* **Mechanism:** `codex-acp` is a **stdio ACP agent server**: it starts the Codex **App Server**,
  translates ACP requests into Codex operations and maps Codex events back. It ships a compatible
  `@openai/codex` dependency; `CODEX_PATH` overrides the binary. It is headless by construction
  (no TTY), which is how our probe ran it (`docs/compatibility/ACP.md:54-57`: protocolVersion 1,
  `loadSession: true`, image+embeddedContext prompt caps, MCP http, session
  resume/list/close/delete/fork/additionalDirectories/subagents, `auth.logout`).
* **Auth, per the adapter README:** ChatGPT login (browser OAuth; hidden when `NO_BROWSER` is set,
  and it does not work in remote projects), `CODEX_API_KEY` (wins) or `OPENAI_API_KEY`, or a
  client-provided OpenAI-compatible gateway. Other env: `CODEX_CONFIG` (JSON merged into the
  session config), `MODEL_PROVIDER`, `DEFAULT_AUTH_REQUEST`, `INITIAL_AGENT_MODE`
  (`read-only|workspace-write|agent|agent-full-access|permission-profile:<id>`),
  `APP_SERVER_LOGS`. Our own probe recorded that `authMethods` offers `api-key` and `chat-gpt`
  but neither was used — the **existing `codex-cli` login in `~/.codex/auth.json` was sufficient**,
  and the launcher declares `CODEX_HOME` as the credential-location env var
  (`internal/agent/acp/launchers.go:138`).
* **`~/.codex/auth.json` shape** (`AuthDotJson` in `codex-rs/login/src/auth/storage.rs`):
  `auth_mode`, `OPENAI_API_KEY`, `tokens` (`TokenData`: `id_token` parsed into claims,
  `access_token`, `refresh_token`, `oauth_provenance{issuer,client_id}`, `login_owner_id`,
  `account_id`), `last_refresh`, plus newer `agent_identity`, `personal_access_token`,
  `bedrock_api_key`, `bedrock_access_keys`.
* **It refreshes *and writes back*.** The refresh path mutates the token fields, stamps
  `last_refresh = Utc::now()` and commits with `storage.compare_and_save(&original, &auth_dot_json)`
  (`manager.rs:1785-1801`), which for file mode writes `$CODEX_HOME/auth.json` from a private
  (0600) temp file plus atomic rename (`storage.rs:274-290`), guarded so a concurrent change fails
  with "Credentials changed before refresh commit". ChatGPT refresh tokens are **single-use**, so
  a copy of `auth.json` used in two places burns the other one (`refresh_token_reused`) — the
  documented CI pattern is "run Codex, then persist the updated `auth.json`", and one third-party
  worker hit exactly our shape (isolated `CODEX_HOME` deleted after the run → next run 401).
* **Consequence for us:** a per-attempt `CODEX_HOME` that is thrown away with the unit is only
  safe on the **API-key** path. On the **ChatGPT-subscription** path the rotated file must be
  written back to the durable credential dir (or the mount must be the live one), and one
  subscription must not be mounted into two concurrent units. Today `CODEX_HOME` rides the
  harness credential dirs (`internal/worker/unit.go:818`,
  `internal/workspace/git/plan.go:280`), so this is a mount-lifetime decision, not a code bug —
  but nobody has measured it: our container E2E row for Codex is UNVERIFIED
  (`docs/compatibility/ACP.md:109`).

**Evidence**

* https://github.com/zed-industries/codex-acp/ — archived banner, "Development has moved to
  agentclientprotocol/codex-acp… Use `@agentclientprotocol/codex-acp` for new installs"; auth
  methods incl. "ChatGPT subscription (requires paid subscription and doesn't work in remote
  projects)".
* https://api.github.com/repos/zed-industries/codex-acp (`archived: true`, pushed 2026-07-22) and
  `…/releases` (v0.16.0 2026-06-08, v0.15.0 2026-05-22); npm
  `@zed-industries%2Fcodex-acp` `dist-tags.latest = 0.16.0`.
* https://api.github.com/repos/agentclientprotocol/codex-acp (active, pushed 2026-11-09) and
  `…/releases` (v2.6.0 2026-11-08, v2.5.0 2026-10-29); npm `dist-tags`
  `{"latest":"2.6.0","preview":"2.6.1-preview.2"}`.
* https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/README.md — stdio server
  over the Codex App Server, bundled `@openai/codex`, Authentication section, Runtime-options env
  list (`CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_PATH`, `CODEX_CONFIG`, `MODEL_PROVIDER`,
  `DEFAULT_AUTH_REQUEST`, `INITIAL_AGENT_MODE`, `NO_BROWSER`, `APP_SERVER_LOGS`).
* https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs (`AuthDotJson`,
  `save()` temp-file+rename, `compare_and_save`) and
  https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs (lines 1785-1801:
  tokens replaced, `last_refresh` set, `compare_and_save`) and
  https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs (`TokenData`).
* https://learn.chatgpt.com/docs/auth/ci-cd-auth — keep the refreshed `auth.json`; do not share
  one file across concurrent jobs or machines.
* https://github.com/openai/codex/pull/11802 (refresh/reload hole between two live instances);
  https://github.com/kitepon-rgb/codex-sidecar/commit/aa571fe (isolated `CODEX_HOME` discarded →
  `refresh_token_reused` on the next run); https://github.com/scrimba/pr-explainer/issues/2
  (single-use refresh tokens break static `auth.json` secrets in CI).
* Local: `internal/agent/acp/launchers.go:132-141` (codex launcher, package + 2.2.2 pin,
  `AuthEnvVars: ["CODEX_HOME"]`, "auth rode the existing codex-cli login"),
  `docs/compatibility/ACP.md:10,25,54-57,109`, `internal/worker/unit.go:818`,
  `internal/workspace/git/plan.go:280`.

## 5. Pi as an ACP agent

**Answer**

* **Pi does not speak ACP natively.** `@earendil-works/pi-coding-agent` (pi-mono, latest npm
  **1.5.2**, published 2026-11-10) has exactly three non-TUI interfaces — `--print`,
  `--mode json`, `--mode rpc` (`docs/cli.md:45-50`) — and its docs never mention ACP. The upstream
  request, `earendil-works/pi` issue **#175 "ACP Support"**, is **closed** without a shipped mode.
  This repo reached the same conclusion and recorded it: "the native `pi --mode acp` mode does not
  exist in any released pi" (`internal/agent/acp/launchers.go:143-148`).
* **The adapter is `pi-acp`.** `svkozak/pi-acp`, MIT, npm **`pi-acp@0.0.34`** (published
  2026-09-24, latest) — the same version this repo ships
  (`internal/agent/acp/launchers.go:151-167`, `docs/compatibility/ACP.md:97`). It speaks **ACP
  JSON-RPC 2.0 over stdio** and **spawns `pi --mode rpc`**, bridging ACP requests/events to pi's
  JSONL RPC records; it needs Node 22+ and pi ≥ 0.81.0 on `PATH`. It maps tool calls to
  `tool_call`/`tool_call_update` (paths resolved against session cwd, structured old/new diffs
  for edits), keeps a session map at `~/.pi/pi-acp/session-map.json`, forwards skills and file
  slash-commands, and reports `contextUsage` as `usage_update`. **Stated limitations:** no ACP
  `fs/*` or `terminal/*` delegation (pi reads/writes/executes locally), ACP-supplied MCP servers
  are stored but not wired into pi, no separate thought channel. Only env knob:
  `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`. An earlier variant,
  `victor-software-house/pi-acp` (npm `0.17.1`, embeds pi through the SDK instead of subprocess),
  is archived as of 2026-06-08 — so the version numbering is a trap: `0.17.x` is the *old fork*.
* **Pointing pi at an OpenAI-compatible endpoint.** Put a `models.json` in the agent dir (default
  `~/.pi/agent`, relocated with `PI_CODING_AGENT_DIR`; project config lives in `<cwd>/.pi`):

  ```json
  { "providers": {
      "my-gateway": {
        "baseUrl": "https://gateway.example/v1",
        "api": "openai-completions",
        "apiKey": "${GATEWAY_API_KEY}",
        "models": [{ "id": "qwen3-8-flash-next" }]
      } } }
  ```

  `apiKey` (and header values) accept `$NAME` / `${NAME}` environment interpolation, a literal, or
  a leading `!command` run at request time (`docs/models.md:65`). Credential precedence is
  `--api-key` → stored `auth.json` → `models.json apiKey` → provider env vars
  (`docs/models.md:23`). Model selection: `--provider`/`--model` (`--model provider/id`,
  `:thinking` suffix), `--thinking off|minimal|low|medium|high|xhigh|max`.
* **Headless run shapes:** `pi --print "…"` (one-shot, final text on stdout),
  `pi --mode json "…"` (JSONL events), `pi --mode rpc --no-session` (long-lived JSONL RPC child —
  what `pi-acp` drives), stdin piped in ⇒ print mode unless json/rpc is chosen.
* **What this repo already does with it:** the launcher writes
  `$HOME/.pi/agent/models.json` with `"apiKey": "$OPENAI_API_KEY"` (interpolation only, never the
  value) plus the load-bearing `settings.json` `defaultProvider`/`defaultModel` pin, and fails
  closed on a partially-set base URL/model (`Launcher.ApiModelsJSON`/`ApiSettingsJSON`/
  `WriteProviderConfig`, `internal/agent/acp/launchers.go:272-381`, called from
  `internal/worker/unit.go:482` and `internal/worker/agentturn.go:526`; measured note at
  `docs/compatibility/ACP.md:92`).

**Evidence**

* https://microsoft.github.io/… (n/a here) — pi facts from
  https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/cli.md
  (lines 45-50: `-p/--print`, `--mode text|json|rpc`), `…/docs/models.md` (line 23 credential
  order; line 65 `$NAME`/`${NAME}`/`!command` interpolation), `…/docs/configuration.md`
  (agent dir `~/.pi/agent`, `PI_CODING_AGENT_DIR`, `models.json`, `auth.json`),
  `…/docs/rpc.md` (`pi --mode rpc --no-session`, JSONL command/response/event records).
* npm registry: `@earendil-works%2Fpi-coding-agent` `dist-tags.latest = 1.5.2`
  (modified 2026-11-10); `pi-acp` `dist-tags.latest = 0.0.34` (2026-09-24);
  `@victor-software-house%2Fpi-acp` `0.17.1` (2026-06-09).
* https://github.com/svkozak/pi-acp/ and
  https://raw.githubusercontent.com/svkozak/pi-acp/main/README.md — "spawns `pi --mode rpc`",
  prerequisites, features, `PI_ACP_ENABLE_EMBEDDED_CONTEXT`, Limitations, MIT.
* https://github.com/victor-software-house/pi-acp (archived, pushed 2026-06-08, MIT) and
  https://github.com/earendil-works/pi/issues/175 — "ACP Support", **closed**.
* Local: `internal/agent/acp/launchers.go:143-168` (pi launcher + pi-acp pin + why),
  `internal/agent/acp/launchers.go:272-381` (`ApiModelsJSON`, `ApiSettingsJSON`,
  `WriteProviderConfig`), `docs/compatibility/ACP.md:82,92,97`, `docs/adr/ADR-0059-…`,
  `docs/adr/ADR-0069-never-asks-launchers.md:22-23,95-100`.

## 6. This repo's APM + ACP seams

**Answer — how a profile's APM package is prepared today**

1. A profile carries exactly one pin: `apm_package_ref` + `apm_target` + `apm_lock_digest`
   (`agent_profiles` columns from `internal/store/postgres/migrations/00004_…sql:459` plus
   `00013_apm_lock.sql`, mirrored into the frozen revision JSONB at
   `internal/store/postgres/agent_profile_versions.go:61-63` and copied to each conversation pin
   at `internal/api/conversations.go:107-109`; worker-side fields
   `internal/worker/unit.go:145-147`).
2. Writes validate the triple: `checkAPMPin` (`agent_profiles_write.go:241`) accepts all-three
   (locked) or ref+target (unlocked) and nothing else; `ValidAPMPackageRef` (`:205`) enforces
   `owner/repo[/subdir]#<tag|branch|commit>` — **one string**, so a list is refused today.
3. Locking is a worker round-trip: `POST /agent-profiles/{id}/apm/lock` queues an
   `apm_lock_requests` row (`00013_apm_lock.sql:28`, single `package_ref` + `target` columns);
   `APMLockLoop.apmResolve` (`internal/worker/apmlock.go:338`) calls `apm.Resolve`
   (`internal/agent/apm/resolve.go:140`), which renders **one** `dependencies.apm` entry
   (`manifest.go:100 manifestYAML`, `:124 writeManifest`), runs `apm install --target <t>`, reads
   `sha256(apm.lock.yaml)` and the names-only summary (`collectContents`, `resolve.go:341`), and
   `CompleteAPMLockRequest` (`apm_lock.go:137`) stores digest + summary + `resolved_commit`.
4. Launch staging is the gate: `Unit.stageAPM` (`internal/worker/unit.go:834`) maps launcher→target
   (`launcherTarget`, `:1164`; **`pi` maps to nothing**) and calls `apm.Stage`
   (`internal/agent/apm/stage.go:160`) per repo: materialize `apm.yml` when the checkout has none
   (`:202`), `apm install --frozen --target t` or the resolving form (`:214-216`), write the git
   exclusions (`:235`), then compare digests and **refuse the launch** on mismatch (`:241-249`,
   `DigestMismatch` at `:281`). Generated paths join the exclusion set (`unit.go:931`).
5. The ACP side is separate: `knownLaunchers` (`internal/agent/acp/launchers.go:112-168`) is a
   static claude/codex/pi table (executable+npm pin); the launcher decides `apm_target`, the agent
   HOME, the credential env (`AuthEnvVars`, `OAuthTokenKV`, `ApiKeyKV`) and the pi-only per-turn
   provider config (`WriteProviderConfig`).

**What a "collections" list (several packages per profile) would change**

* `agent_profiles` needs `apm_packages jsonb` (ordered array) or a child table, with a CHECK that
  each element passes the existing grammar — `ValidAPMPackageRef` should stay per-element;
  ordering becomes a *stored* property because `deployments.active_owner` makes last-writer-wins
  (`internal/store/postgres/migrations/00013_apm_lock.sql`, `agent_profile_versions.go:61-63`).
* `manifestYAML` (`internal/agent/apm/manifest.go:100`) renders N entries and must keep the
  character whitelist (`checkRefChars`) per element; `writeManifest`/`ResolveRequest.PackageRef`/
  `StageRequest.PackageRef` (`stage.go:75`, `resolve.go:61`) become `[]string`, and
  `apm_lock_requests.package_ref` (`00013_apm_lock.sql`) becomes a jsonb array or a per-dep row.
* The digest stays **one** value — it covers the union lock — but its meaning becomes "the whole
  collection": adding, removing or reordering a dep moves `sha256(apm.lock.yaml)` and forces a
  re-Lock (ADR-0054 §"changing the ref on a locked profile clears the digest"); events
  (`internal/events/events.go:1189,1204,1222`) and API pin views
  (`internal/api/agent_profiles.go:105-107`) need list shapes plus a stable digest-permutation rule.
* `collectContents` (names-only) must report per-package attribution, because two deps can ship the
  same skill name and APM resolves that by install order, not by an error.
* `Unit.Profile` needs the list plus the target for `pi`: today `launcherTarget` returns `""` for
  pi, so a pi profile with any pin is refused — a collection feature is the moment to decide
  whether `--target agent-skills` (`.agents/skills/`) becomes pi's third supported target.
* UI/API/docs: profile pin editor, `docs/adr/ADR-0030-…` §3's "exactly one package" invariant
  needs an amendment, and the pstack/Agent-Plugin question of §2 needs its own spike row before
  any of it is claimed as supported.

**Evidence**

* `internal/agent/apm/manifest.go:31,38,47,82,100,124,148,167`;
  `internal/agent/apm/stage.go:44,51,62,67,75,102,126,160,202,214-216,235,241-249,281,295,307,397`;
  `internal/agent/apm/resolve.go:57,61,96,113,140,180,192,227,238,258,291,309,341,387`.
* `internal/store/postgres/agent_profiles_write.go:195-268`;
  `internal/store/postgres/agent_profile_versions.go:61-63`;
  `internal/store/postgres/apm_lock.go:110,137,181,219`;
  `internal/store/postgres/migrations/00004_m3_workspaces_secrets_artifacts.sql:459`;
  `internal/store/postgres/migrations/00013_apm_lock.sql:22-45`.
* `internal/worker/unit.go:145-147,265,448,482,818,834-861,931,1164`;
  `internal/worker/seams.go:175-218`; `internal/worker/apmlock.go:52,79,338,365`;
  `internal/worker/apmsandbox.go:74-130`; `internal/worker/agentturn.go:526`;
  `internal/api/conversations.go:107-109`; `internal/api/agent_profiles.go:105-130`;
  `internal/events/events.go:1189-1222`; `internal/agent/acp/launchers.go:44,112-168,190-245,272-381`;
  `internal/workspace/git/plan.go:280,320`.
* `docs/adr/ADR-0030-writable-agent-profiles-with-apm-packages.md:11-15,30,41,85-96`;
  `docs/adr/ADR-0054-server-side-apm-lock.md:44,142-149,198-204`;
  `docs/adr/ADR-0008-apm-profile-staging.md`; `docs/adr/ADR-0059-pi-acp-launcher-api-key.md:44-49`;
  `docs/adr/ADR-0069-never-asks-launchers.md:22-23,95-100`.
* `docs/compatibility/APM.md:17-58,74-107,137-168`; `docs/compatibility/ACP.md:10-13,25,54-57,82,92,97,109`;
  `worker/Dockerfile:70-75,85-86,124-133,162`; `api/openapi.yaml:2128,8198,7374`.

## Surprises / risks

1. **"Collections" in APM means two different things now, and neither is a first-class object.**
   `.collection.yml` support was *deleted* in 0.12.0 (#1094/#1097); what remains is a skill-collection
   *layout* plus dependency-only `apm.yml` meta-packages. Anything in our specs that assumed a
   collection kind of package is written against a format that no longer parses.
2. **A pstack profile is not installable by APM the way a `mattpocock/skills` profile is.**
   pstack's `plugin.json` declares the recognized Agent Plugins v1 `$schema`, which APM treats as a
   whole, Copilot-registration-only unit ("nothing is dissected"), and since 0.31.0 such an install
   can exit 1 when no target accepts it. Consume pstack via per-skill virtual subdirectories, or
   via the generated Claude tree — both unproven here and needing a spike (AGENTS.md forbids
   claiming the capability before a test).
3. **Skill-name collisions across packages are resolved by install order, not by an error.**
   The lock's `owners`/`active_owner` ledger means reordering a collection's list can silently
   change which skill the agent gets. If we ever store several packages per profile, the order must
   be part of the pin (and of the digest's meaning), or we must refuse duplicate deployed paths at
   resolve time.
4. **`apm_version` inside the lock makes the worker's APM pin load-bearing for security.**
   A CLI bump (0.34.0 → 0.35.0/0.40.x) invalidates every recorded digest; every bump is a
   fleet-wide re-Lock event, and the 0.35.0-*unreleased* license switch (MIT → Apache-2.0) also
   changes what `worker/Dockerfile` redistributes.
5. **`--frozen` is not a content freeze.** APM's own docs scope `--frozen` to replaying the locked
   commits for unchanged git deps; our probe A5 showed a *local-path* dependency mutating content
   behind a passing frozen install. The digest gate, not the flag, is the control
   (`docs/compatibility/APM.md:98-107`).
6. **ChatGPT-subscription Codex cannot be mounted read-only or throwaway.** Refresh tokens are
   single-use and Codex rewrites `auth.json` in place; an ephemeral `CODEX_HOME` per unit either
   writes the rotated file back or burns the session for every other consumer
   (`refresh_token_reused`). This is a deployment-model decision, and our Codex-in-container row is
   UNVERIFIED, so nothing should lean on subscription auth yet.
7. **pi's ACP support is a community adapter with declared gaps** (no `fs/*`/`terminal/*`
   delegation, no ACP-MCP passthrough) **and confusing version lineage** — `pi-acp@0.17.1` is the
   archived fork, `pi-acp@0.0.34` is current. Pinning by package name alone invites the wrong one.
8. **The cursor→claude translation for pstack is documentation, not transformation.** APM copies
   `SKILL.md` bytes; Cursor tool names, `subagent_type`, `.mdc` rules and model slugs remain in the
   deployed text unless the generated `harness/pstack/claude-code` tree is what you install.
9. **pstack and open-pstack collide on the `pstack:` namespace** — a profile that staged both would
   hand the agent two sets of same-named skills, which is exactly the APM collision case in (3).
10. **Our `pi` launcher has no APM target at all** (`launcherTarget` → `""`), so a pi profile with a
    package pin is refused today. Collections should decide whether `agent-skills`
    (`.agents/skills/`) becomes a supported third target for pi-launched turns.
11. **Matt Pocock's repo ships 39 skills but its plugin manifest declares 27.** Anything we count
    from disk and anything a harness reports after install will disagree; the contents summary in
    `apm_contents_summary` is names-only and inherits that ambiguity.
