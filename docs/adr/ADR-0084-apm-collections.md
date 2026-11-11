# ADR-0084: APM collections, named and pinned skill bundles that agent profiles attach

- **Date:** 2026-11-11
- **Status:** Proposed
- **Owners:** project owner, orchestrator
- **Related decisions / contracts:**
  - ADR-0008 (APM profile staging)
  - ADR-0030 (writable profiles with an APM package; this amends §3's "exactly one package")
  - ADR-0054 (server-side APM lock)
  - ADR-0059 (pi launcher)
  - `docs/research/2026-11-apm-collections-and-harnesses.md`

## Context
The owner wants bundles of skills, instructions and MCP servers that can be attached to different ACP agent
setups. Examples are "Matt Pocock's skills", "pstack" and "our team conventions", attached to Claude Code, Codex
or Pi profiles.

Today a profile pins exactly **one** APM ref (`apm_package_ref` + `apm_target` + `apm_lock_digest`), and the
worker stages it per launch (research §6).

Upstream APM (0.34 pinned, 0.35 latest) **removed** the `.collection.yml` kind in 0.12.0. What remains:

- **Dependency-only `apm.yml` meta-packages.** `dependencies.apm` is an ordered list, resolved transitively into
  one `apm.lock.yaml`.
- **Skill collections.** These are a layout: `skills/<name>/SKILL.md`, cherry-picked with `skills:` or
  `--skill`.

Two dependencies that ship the same skill name resolve by **install order**: the last claimant becomes
`active_owner`.

pstack can't be installed whole. Its `plugin.json` is a portable Agent Plugin, which APM doesn't dissect. It
**can** be consumed per skill from Cursor's generated Claude tree, `cursor/plugins/harness/pstack/claude-code`.
That tree also has the Cursor tool names translated.

## Options considered
| Option | Advantages | Disadvantages |
|---|---|---|
| A. Ask users to publish a meta-package repo and pin that one ref | no schema change | a GitHub repo per bundle; no UI, no reuse across profiles; edits mean commits elsewhere |
| **B. Collections as first-class library items, flattened by the worker into one meta `apm.yml`** | editable in the app, reusable across profiles, one lock digest per profile, matches APM's own composition model | schema plus API plus UI work; ordering semantics must be explicit |
| C. Several independent `apm install`s per launch | none | breaks the single-lock invariant and the digest gate |

## Decision
Option B.

### Model
- **`apm_collections`** has `id`, `org_id`, `slug` (unique per org), `name`, `description`,
  `created_by` and timestamps.
- **`apm_collection_revisions`** has `collection_id` and `revision`. Revisions are immutable once published,
  like pipelines (ADR-0002).
  - `entries jsonb` is an ordered array of
    `{ref: "owner/repo[/path]#<tag|full-sha>", skills?: [names], note?: string}`.
  - Each ref passes the existing `ValidAPMPackageRef`. A floating branch is refused; a tag or a 40-character SHA
    is required.
  - `status` is `draft` or `published`.
- **Profiles** gain `apm_collections jsonb`, an ordered array of `{collection_id, revision}`, beside the existing
  single `apm_package_ref`.
  - The existing ref becomes "extra packages" and keeps working.
  - Profile revisions freeze the list, as they freeze the ref today.
  - Changing the list **clears `apm_lock_digest`**, as changing the ref does (ADR-0054).
- **Flattening** (worker and lock resolver, one function `apm.FlattenProfile`) builds one meta `apm.yml`:
  - `dependencies.apm` is the concatenation of each attached collection's entries **in attach order**, then the
    profile's own ref.
  - An exact duplicate ref appears once, at its first position.
  - The result is rendered through the existing `manifestYAML` whitelist.
  - `skills:` subsets use APM's object form.
- **Ordering rule.** When two entries ship the same skill name, the **later** one wins, which is APM's own rule.
  - The lock summary (`collectContents`) gains per-skill attribution `{skill, from_ref}`.
  - The UI shows "overridden by …" on the losing entry.
  - No silent merge is added: what APM decides is shown, not reinterpreted.
- **One digest.** `apm_lock_digest` stays `sha256(apm.lock.yaml)` of the flattened install and covers the whole
  set. The launch gate (`stage.go:241-249`) is unchanged.
- **Pi.** `launcherTarget("pi")` maps to `agent-skills` (`.agents/skills/`). Pi reads `.agents/skills` through
  the shared Agent Skills convention. That is a **spike** (A-1) before the Pi row says supported. Until A-1 is
  green, the UI says "staged, not yet verified for Pi".

### Seeded collections (examples, created by migration as `published` revision 1, editable afterwards)
- **"Matt Pocock skills"**: `mattpocock/skills#v1.3.2`, the whole plugin set of 27 skills.
- **"pstack (Claude Code)"**: per-skill refs at
  `cursor/plugins/harness/pstack/claude-code/skills/<name>#63912a91d52c43946f974f2aaf661334a6116a82`, MIT, by
  Lauren Tan. It includes the router `poteto-mode`, the core working set (`how`, `why`, `architect`,
  `interrogate`, `tdd`, `blast-radius`, `unslop`, `recall`, `ketchup`, `teach`, `technical-writing`) and all 24
  `principle-*` skills, which the mode skill invokes by name.
  - The Cursor-only parts (benny automations, Bugbot, cloud agents) are not included.
  - Each skill is a separate cached clone of the same SHA.
- **"Review conventions"**: an empty, editable starter for the team's own instructions.

### Workflow templates (the Workflows "Start from" gallery)
These are sample pipelines under `docs/samples/home/`, compiled by `samples_test.go` and copied byte-for-byte into
the UI, as today:

1. **"Matt Pocock: spec to tickets to PR".** `to-spec` → approve → `to-tickets` → implement → report, on a Claude
   Code profile with the Matt Pocock collection.
2. **"pstack feature (poteto-mode)".** survey → plan (`poteto-mode` feature playbook) → approve → implement →
   `interrogate` self-review → report, on Claude Code with the pstack collection.
3. **"Implement, then Codex review".** implement (Claude Code) → review (a **Codex** profile with `read-only`
   mode, which reads the diff and writes `review.md`) → approve → report.
   - The Codex node needs a Codex login on the worker. Without one, the step fails closed with the launcher's
     existing "credential directory unusable" error, and the template card says "needs a Codex login on the
     worker".

## Consequences
- Bundles are editable in the app, versioned, reusable, and attached in an order the user controls.
- One lock and one digest per profile. The launch gate is unchanged.
- APM's last-writer-wins on skill names is surfaced, not hidden.
- More clones per lock for per-skill pstack refs. The content-addressed cache makes repeats cheap.

## Security/privacy
- Every entry must be pinned to a tag or SHA, so nothing follows a moving branch.
- Collections are org-scoped library items with the same write role as profiles ("library role").
- APM staging is still not isolation (ADR-0008). Skills run inside the nono sandbox like any workspace content.

## Verification
- **Unit:** flatten order, dedupe, skills subsets, the whitelist, digest clearing on change, and revision
  immutability.
- **Real APM:** the worker's resolver run against the seeded Matt Pocock and pstack collections (network,
  gated). It records the lock digest and the skill attribution in `docs/compatibility/APM.md`.
- **Spike A-1:** Pi with `agent-skills` sees a staged skill.
- **Samples:** each new template compiles in `internal/pipelines/samples_test.go` with zero diagnostics.

## Migration/rollback
The change is additive: new tables, a new nullable jsonb column, and seeded rows. Profiles without collections
behave exactly as today. Rollback hides the UI. The columns stay forward-only (ADR-0013).
