# Gap analysis — phase 4: Workflows index + folders, Steps, editor step picker, new agent step

Area: README "Workflows index (3a)", "Workflow editor (4a/4b)", "Steps (3b)".
Artboards: 3a, 3b, 4a, 4b, 1d, 2b.

## 1. Design asks

**Workflows index (3a)**
- Grouped by **folder**, collapsible headers; sidebar lists folders.
- Row grid: name + revision chip (`✓ PUBLISHED r3 8f2c1a` green; `! BETA r5 · STABLE r4` amber); step chain with loop chip (`loop: implement · test · review`); assigned repos + trigger (`manual` / `GitHub issues · label:ready` / `weekly · mon 06:00`); open-draft link (`draft #12 · by assistant`) or `no open draft`; `Duplicate` / `Open` actions.
- Header: filter chips (`all folders`, `used in Acme Portal`, `has open draft`), `Import YAML`, `New workflow`.

**Workflow editor (1d → 2b → 4a/4b)**
- 52px top bar: breadcrumb `Workflows / Delivery /`, name, `· DRAFT #12` chip, tabs **Canvas / YAML / Runs / Assigned to N repos**, `Validate`, `Publish r4`.
- **Add a step (4a)**: `+` on an edge → 360px picker with search/describe input; **START A NEW STEP** kind cards (Agent, Command, Approval, Loop, Workflow — *Publish shown but "leave it out"*); **YOUR SAVED STEPS** section; footer hint "type a description and the assistant drafts it".
- **New agent step (4b)**: dashed "new · unsaved" node; inspector: step id, **Agent profile** dropdown defaulting to the previous agent step's profile (marked SUGGESTED), every option with sandbox status, last option `+ New profile…`, "What should it do?" prompt, unchecked **Also save as a reusable step**.
- Selecting an existing step: `Duplicate as a new step…` and `Edit for all N workflows → version x.y.z` (running runs keep old version; workflows get drafts to adopt).
- Assistant proposals on canvas as dashed steps with Accept/Undo (1d, 2b).

**Steps (3b)**
- Grouped list (AGENT / CHECK / GATE / PUBLISH / LOOP), rows: name + version, config summary, kind (mono), "N workflows".
- Right panel (360px): description, key/value facts, **USED IN N WORKFLOWS** with live status per use, `Edit for all N → version`, `Duplicate as a new step…`.

## 2. Exists today (evidence)

**Routes / pages**
- Routes are `/library`, `/library/:pipelineId`, `/library/:pipelineId/drafts/:draftId` (`ui/src/App.tsx:83,99,107`). Design wants `/workflows`, `/workflows/:id`, `/workflows/:id/drafts/:n` + `/steps` — pure rename/redirect.
- "Library" page = org **pipeline** library (`ui/src/pages/Library.tsx:103`, testid `library-page`); row = `viewPipeline`/`viewPipelineSummary` over `GET /api/v1/pipelines/{id}` + its drafts list (`Library.tsx:1-14`). Per-pipeline page has REVISIONS panel with `r{n} {version_label}` chips (testid `revision-row-{n}`, `Library.tsx:633-660`) and an `AssignToProjectPanel` (`Library.tsx:807-871`) that fans out `GET /projects/{id}/assignments` per maintainer project.
- Note: the "templates" in `Library.tsx` (`library-template-*` testids, `ui/src/lib/pipeline/templates.ts`) are **new-pipeline YAML starters**, not node templates — different concept, keep the name out of the report.

**API / data available for 3a rows**
- `Pipeline` has `latest_revision_number`, `revision_count`, `revisions[]` with `revision_number`, `version_label`, `revision_digest` (`api/openapi.yaml:6715-6795`) → revision chip is fully computable (short digest = first 6 hex of `sha256:`).
- `DraftSummary` = `{id, status: draft|validating|valid|invalid|published, version, updated_at, edited_by}` (`openapi.yaml:6915-6940`) → "open draft" + editor identity (actor names exist via `useActorNames`). "by assistant" specifically is *not* distinguishable — assistant acts as the user's identity.
- `Assignment` = project pin of `pinned_revision_id`/`pinned_version_label` (`openapi.yaml:7093+`) → "assigned repos" requires the per-project fan-out that `AssignToProjectPanel` already does. `Schedule` (cron, `openapi.yaml:7208+`, ADR-0032) → cron trigger row. `manual` = no schedule + no integration trigger.
- **GitHub-issue triggers (`label:ready`) do not exist** — issue listing is read-only (ADR-0031); no trigger fires runs from GitHub.
- **No duplicate endpoint** anywhere in `api/openapi.yaml` (grep `duplicate` → only 409 semantics).
- **No folder/grouping field**: `PipelineCreate` is `{slug, display_name, description}`; `PipelineUpdate` metadata-only.
- **BETA/STABLE channels do not exist**: `Assignment` description says channels are M6, "not a stable/beta rollout channel" (`openapi.yaml:7093` area); `Library.tsx` header comment: `channels` is M6 vocabulary, wire serves none.
- **Node templates**: kind exists and compiles from YAML (`internal/pipelines/loader/loader.go:44` `KindNodeTemplate`; `internal/pipelines/compiler/template.go`), spec 01:17 "Reusable parameterized typed node, **versioned**; PostgreSQL / YAML", spec 03:33. But **publication is blocked**: `internal/store/postgres/m4api.go:979-984` — "NodeTemplate publication is deferred to M5; the template registry does not exist yet". No `/steps`/`/templates` route in `api/openapi.yaml`; no DB registry; nothing stores which pipelines use which template.

**Studio (4a/4b)**
- `StepPicker` exists: searchable popover opened by every `+` on edges, testid `step-picker` (`ui/src/components/studio/StepPicker.tsx`); items = **static** `STEP_LIBRARY` (kind only, `ui/src/lib/pipeline/graphDoc.ts:75-165`). No "START A NEW STEP" cards, no "YOUR SAVED STEPS", no assistant-draft hint. `git.publish` ("not runnable yet: M6", `graphDoc.ts:153-155`) and `artifact.publish` are in the list → must be filtered out per the decision.
- `StudioPalette` (left rail) groups the same static list; drag type `application/x-communication-kind` (`StudioPalette.tsx`).
- Header has title, draft version, validation chip, Save/Validate/Publish (`StudioHeader.tsx:70-132`) — **no Canvas/YAML/Runs/Assigned tabs**; YAML is a view toggle inside the page (`Studio.tsx:79`), Runs/Assigned not linked.
- Agent node references a profile **per node** via `config.profile` name string (`StudioInspector.tsx:531-540`, `graphDoc.ts:183`); the select lists org launch descriptors `name · launcher_id · apm_package_ref` (`StudioInspector.tsx:195-199`, `GET /api/v1/agent-profiles`, `openapi.yaml:839+`). No sandbox-status per option, no SUGGESTED default, no `+ New profile…`. Profile CRUD exists (`POST/PATCH /agent-profiles`); sandbox state per worker exists at `GET /api/v1/system/sandbox` (`openapi.yaml:1970`, `ui/src/api/queries.ts:448`) — the raw material for "✓ sandbox verified" per launcher.
- Assistant draft proposals on canvas already exist (ADR-0044; `ui/src/components/studio/AssistantProposalBox.tsx`, `ui/src/lib/pipeline/proposalOps.ts`, `internal/api/assistant_proposals.go`) → the 1d/2b dashed-proposal + Accept/Undo is covered except the "describe a step and the assistant drafts it" trigger in the picker.
- "Publish" gating: publish is blocked until validate passes and says "revisions are immutable" (`Studio.tsx:332,345-352`).

## 3. Gap table

| item | kind | evidence / spec ref | size |
|---|---|---|---|
| Rename routes `/library*` → `/workflows*`, keep old as redirects | UI-only | `ui/src/App.tsx:83-107` | S |
| 3a row: revision chip (rN + short digest, states) | UI on existing API | `openapi.yaml:6795` | S |
| 3a row: step chain + loop chip | UI on existing API | revision `GET /revisions/{id}/document` + `components/m4/DefinitionGraph` | M |
| 3a row: assigned repos | UI on existing API (fan-out) | `AssignToProjectPanel` `Library.tsx:807-871` | M |
| 3a row: trigger (manual / cron) | UI on existing API | `openapi.yaml:7208+` (Schedule) | S |
| 3a row: GitHub-issue trigger | **needs backend** (M6) | ADR-0031 read-only only | — (empty state) |
| 3a row: open draft + editor | UI on existing API | `openapi.yaml:6915-6940` | S |
| 3a row: `Duplicate` | UI (3 writes) or needs backend endpoint | no endpoint in `openapi.yaml` | M |
| 3a header: filter chips | UI-only (client filter) | — | S |
| 3a header: `Import YAML` | UI on existing API (pipeline + draft create) | `POST /pipelines`, `POST /pipelines/{id}/drafts` | S |
| Folders (field, grouping, sidebar) | **needs backend + ADR** | `PipelineCreate` has no folder field | M |
| BETA/STABLE dual revision chip | needs backend (M6 channels) | `openapi.yaml:7093` Assignment desc | — (empty state) |
| Steps page (3b) list | UI on static list, **honest degradation** | `STEP_LIBRARY` `graphDoc.ts:75-165` | S |
| Steps page: version, config summary, "N workflows", USED IN N with live status | **needs backend + ADR** (template registry, M5) | `m4api.go:984`; spec 01:17, 03:33 | L |
| `Edit for all N → version x.y.z` (adopt via drafts) | **needs backend + ADR** | immutability: spec 03:5, 09:83, ADR-0002 | L |
| `Duplicate as a new step…` | **needs backend + ADR** (no template storage) | `m4api.go:979-984` | M |
| Picker: START A NEW STEP kind cards | UI-only | `StepPicker.tsx` | S |
| Picker: remove Publish kinds | UI-only | filter `git.publish`/`artifact.publish` from `STEP_LIBRARY` uses | S |
| Picker: YOUR SAVED STEPS section | UI now (empty), backend later | needs template registry | S→L |
| Picker: assistant "describe → draft" hint | UI on existing API | ADR-0044 + `internal/api/assistant_proposals.go` | M |
| New-agent-step inspector: SUGGESTED default profile | UI-only | `StudioInspector.tsx:531+` | S |
| New-agent-step: sandbox status per option | UI on existing API | join `/agent-profiles` × `/system/sandbox` (`queries.ts:448`) | S |
| New-agent-step: `+ New profile…` | UI-only | `POST /agent-profiles` | S |
| "Also save as a reusable step" checkbox | UI now (disabled+note), backend later | needs template registry | S |
| Editor tabs Canvas/YAML/Runs/Assigned | UI-only (Runs/Assigned = links) | `StudioHeader.tsx` | S |

## 4. Spec / design conflicts

1. **Agent pushes / opens PRs itself; no Publish step in picker** vs spec 05:19 "Do not automatically push/merge changes." and 05:70 "Configure separate commands/nodes for commit, push, draft PR, human review and merge." Also 05:66 threat model ("prefer a restricted broker/token over long-lived raw secrets") — an agent holding a GitHub token in-sandbox is the long-lived raw-secret case. **ADR must amend spec 05 lines 19 and 70** (and address 45/66 re: token scoping). Removing `git.publish` from the picker is UI-only; the kind stays in the v1alpha1 catalogue, so YAML authoring of publish nodes remains possible — the ADR should say whether that is intended.
2. **`Edit for all N → version x.y.z`** vs published-revision immutability: spec 03:5 "The published definition remains immutable for the duration of a run"; `openapi.yaml:83` (`09`): publish "returns immutable revision and non-mutated assignments"; ADR-0002. The design's escape hatch (running runs keep old; workflows get **drafts** to adopt) is *consistent* with immutability — nothing is rewritten — but it requires template revisions + usage tracking that don't exist (`m4api.go:984`). Needs its own ADR (template versioning) before any of it.
3. **Vocabulary**: design says "Steps (was 'Node library')", "Workflows". UI today is "Library"/"Pipeline(s)"; API/spec vocabulary (pipelines, node templates, revisions) stays per the settled decision — the Steps page is the one place where "step" would map to *node template* (spec 01:17), not to pipeline nodes.
4. **`draft #12 · by assistant`** — drafts carry `edited_by` (a user id); there is no assistant-vs-human distinction persisted. The design's chip implies attribution the API can't honestly render.
5. **BETA r5 · STABLE r4** chip vs M4 reality: channels are M6 (`openapi.yaml:7093` Assignment description).

## 5. Honest empty states

- **Steps page (3b)**: no template registry → show the static kind catalogue (`STEP_LIBRARY`) grouped by AGENT/CHECK/GATE/PUBLISH/LOOP with `—` in the version and "used in" columns and one sentence: "Saved node templates arrive with the M5 template registry; today every step is defined inline in a workflow." Right panel: per-kind facts only; **never** render invented "N workflows" counts.
- **YOUR SAVED STEPS in the picker**: same note, 0 items; section header stays (structure for phase 4+).
- **GitHub-issue trigger**: show `manual` / cron only; do not render `label:ready` triggers.
- **BETA/STABLE chip**: show single `✓ PUBLISHED rN {digest6}`; no amber dual chip.
- **`by assistant`**: show the real editor name (`edited_by` → actor), or omit the suffix.
- **Sandbox status in profile dropdown**: join against `/system/sandbox` workers *per launcher*; if no worker reports `verified: true` for that launcher, render the honest "not verified" state (the spec-mandated wording, `openapi.yaml:1970` description).

## 6. Proposed work units

Ordered; U1–U3 and U5 can start immediately, U6 serializes on the ADR.

1. **U1 — Workflows index, data-complete (UI).** Rename routes to `/workflows*` with `/library*` redirects; rebuild 3a rows from existing reads: revision chip, step chain (revision document + `DefinitionGraph`), assigned repos (reuse the `AssignToProjectPanel` fan-out), trigger (cron/manual), open-draft link with real editor name, `Duplicate` as client-side 3 writes (`GET /revisions/{id}/document` → `POST /pipelines` new slug → `POST /pipelines/{id}/drafts`), filter chips, `Import YAML` (paste → pipeline + draft). Files: `ui/src/pages/Library.tsx`, `ui/src/App.tsx`, `ui/src/api/pipelines.ts`, new `ui/src/pages/Workflows.tsx` (move+rename ok).
2. **U2 — Steps page shell with honest degradation (UI).** `/steps` route; grouped `STEP_LIBRARY` list (40px rows: name, kind, static config summary); right panel with kind facts; version/usage columns show `—` + M5 note (section 5). Files: new `ui/src/pages/Steps.tsx`, `ui/src/App.tsx`. *Parallel with U1* (no shared files).
3. **U3 — Editor chrome (UI).** 52px header: breadcrumb `Workflows / {name}`, `· DRAFT #n` chip, tabs Canvas / YAML / Runs (link to the pipeline page's run links) / Assigned (link to assignment panel). Files: `ui/src/components/studio/StudioHeader.tsx`, `ui/src/pages/Studio.tsx`. *Parallel with U1/U2.*
4. **U4 — Step picker rebuild (UI).** 360px picker: START A NEW STEP kind cards (Agent/Command/Approval/Loop/Workflow; **no Publish** — filter `git.publish` and `artifact.publish`), existing search, YOUR SAVED STEPS (empty + note), footer hint wired to the existing assistant draft-proposal flow. Files: `ui/src/components/studio/StepPicker.tsx`, `ui/src/lib/pipeline/graphDoc.ts` (picker-only exclusion, keep catalogue intact), palette parity. *After U3 shares no files — parallel OK, but both touch the Studio page only via existing props.*
5. **U5 — New-agent-step inspector (UI).** On picking Agent: dashed "new · unsaved" node (existing proposal styling), step id, profile select defaulting to previous agent node's `config.profile` marked SUGGESTED, per-option sandbox status (join `useAgentProfiles` × `useSystemSandbox` by launcher), `+ New profile…` → `/agents` new-profile path, "Also save as a reusable step" disabled with M5 note. Files: `ui/src/components/studio/StudioInspector.tsx`, `ui/src/api/queries.ts`. *Serializes after U4 if U4 touches `StudioInspector.tsx` (it shouldn't).*
6. **U6 — ADRs + backend (serial, L).** (a) ADR amending spec 05:19/70 (agent-held GitHub token; push/PR from sandbox; picker exclusion). (b) ADR for node-template registry + versioning (spec 01:17, 03:33; lifts the `m4api.go:984` M5 gate): table(s), `GET/POST /steps` list + create, usage scan over revision documents, immutable template revisions, "adopt via draft" semantics. (c) ADR for `folder` grouping field on pipelines. Split into one ADR unit + two backend units (template registry; folder column + API). *None parallel with each other; blocks the real Steps page and the real YOUR SAVED STEPS / Edit-for-all.*

## 7. Acceptance checks (browser + real lab)

1. `GET /library` and `GET /library/{id}` 301/redirect to `/workflows…`; `/workflows` renders testid `workflows-page` (or renamed `library-page`) with row count == `len(GET /pipelines).pipelines`.
2. On a pipeline with a published revision, the chip text equals `PUBLISHED r{revision_number} {first 6 hex of revision_digest}` using `GET /pipelines/{id}` values (no invented numbers).
3. Hover a canvas edge → `data-testid="step-picker"` opens; its option list contains **no** `git.publish` / `Publish` entry; it contains the 5 START A NEW STEP cards; YOUR SAVED STEPS section renders 0 items + M5 note.
4. Add an Agent step after an existing `agent.acp` node: inspector `#agent-profile` select value == previous node's `config.profile`; the option is flagged SUGGESTED; last option label is `+ New profile…`; clicking it leaves the draft unchanged (no node mutation) and navigates/opens profile creation.
5. Every profile option shows a sandbox flag whose truth value matches `GET /api/v1/system/sandbox` for that launcher's worker backend (`verified: true` ⇔ green check); with no verified worker the flag is the non-safe wording, never green.
6. Steps page: `/steps` renders the grouped catalogue; every "used in" cell is `—`/note (assert absence of any `workflow` count text) — count check on `document.querySelectorAll` for `/\d+ workflows/` == 0.
7. Duplicate: record `GET /pipelines` count N and slug set; click `Duplicate` on a row; assert N+1 pipelines, the new slug not in the original set, and its drafts list has exactly 1 row.
8. Publish gating: in the editor, after a failed validate, `studio-validate` re-enables and `Publish` stays blocked; after publish, note shows `published as r{n} {version_label}` and the draft is read-only (`studio-read-only-note` visible).

## 8. Open questions for the product owner

1. **Scope of "Workflows": org or project?** The index today is org-scoped (`/library`); 3a rows show per-repo assignments, which fits org scope. *Default: keep org-scoped; project page keeps its own pipeline/assignment panel.*
2. **Duplicate: client-side 3 writes now, backend endpoint later?** A backend `POST /pipelines/{id}:duplicate` (atomic, single `pipeline.created` event) is cleaner but costs API/ADR work. *Default: client-side for phase 4; backend endpoint in U6 if requested.*
3. **Folders: new pipeline column or a separate group entity?** A `folder` string column is the minimum that satisfies 3a and the `showWorkflowFolders` pref. *Default: column + client grouping; folder entity later only if per-folder permissions appear.*
4. **Should the Publish exclusion go beyond the picker?** Filtering the picker keeps `git.publish`/`artifact.publish` authorable in raw YAML and in assistant proposals. *Default: picker-only for now; ADR (U6a) decides whether the assistant must also stop proposing publish nodes.*
5. **`draft #n · by assistant` attribution.** No assistant identity is persisted on drafts. *Default: show the real editor name; skip "by assistant" until an ADR adds an assistant principal (out of this phase).*
