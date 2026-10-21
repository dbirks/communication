# ADR-0049 — Node-template ("Step") registry: versioned immutable revisions, adopt-via-draft, and workflow folders

- **Date:** 2026-10-20
- **Status:** Accepted (product owner decision, 2026-10-20 — app-shell "Six Directions" handoff,
  `docs/design/handoff-app-shell/`, gap analysis `gaps/library.md` §2/§3/§4.2/§6 U6)
- **Owners:** pipelines/schema maintainer; postgres store maintainer; API maintainer
- **Related decisions / contracts:**
  `communication-spec/01-domain-model.md:17` (Node Template entity: "Reusable parameterized typed
  node, versioned; PostgreSQL / YAML"), `:99` (references by unique node/template/revision IDs),
  `03-pipeline-engine.md:5` (published definition immutable for the duration of a run), `:33`
  (templates are parameterized, versioned wrappers over built-in kinds; must not bypass
  sandbox/credential policy), `09-api-events-data.md:16` (`/node-templates` endpoint), `:48`
  (one journal event per state transition, same transaction), `:54` (`node_templates` table),
  ADR-0002 (published revisions are immutable), ADR-0014 (HTTP/problem+json), ADR-0013
  (migrations), ADR-0021 (canonical document, digests, revision digest), ADR-0023 (runs pin
  revisions), ADR-0024 §2 (the M5 deferral this ADR lifts), ADR-0027 (config bindings resolve
  at claim time), ADR-0045 (step-picker wording decisions), design handoff 3a/3b/4a/4b.

## Context

Spec 01:17 and 03:33 require a versioned, reusable node-template registry; spec 09:16/54 already
reserve the `/node-templates` endpoint and the `node_templates` table. M4 shipped the shape, not
the registry:

- A `NodeTemplate` document (`apiVersion: communication.dev/v1alpha1`, `kind: NodeTemplate`,
  `spec.implements/parameters/config/outputSchema`) loads, schema-validates and compiles, but
  **publication is refused**: `PipelineDefinitions.Validate` adds the
  `CodeTemplatePublishDefer` finding — "the template registry does not exist yet"
  (`internal/store/postgres/m4api.go:979-984`); the compiler does the same under
  `AllowNodeTemplatePublish == false` (`internal/pipelines/compiler/template.go`).
- The compiler's `Registries.NodeTemplates` is a bare `NameSet` used **only for
  duplicate-name detection** of template documents (`compiler/template.go:67-70`,
  `helpers.go:41-55`) — it cannot resolve a revision.
- **No pipeline node can reference a template today.** The v1alpha1 schema
  (`internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json`) gives pipeline nodes
  `kind` + inline `config` only. (The `template` property at schema line 1143 is
  `configGate`'s `judge` template — a different concept.) Nothing stores which pipelines use
  which template, so "USED IN N WORKFLOWS" (design 3b) and "Edit for all N → version x.y.z"
  (4a/4b) have no source of truth.
- Pipelines have **no folder** field (`PipelineCreate` = `{slug, display_name, description}`),
  which the Workflows index (3a) and the `showWorkflowFolders` preference need.

The design's escape hatch is consistent with immutability (03:5, ADR-0002): running runs keep
their pinned revision, and workflow changes arrive as **drafts to adopt** — nothing published
is ever rewritten.

## Decision

### § 1. Tables — migration `internal/store/postgres/migrations/00009_step_registry.sql`

(00008 is taken by preferences; this migration is the single one for this ADR.)

```sql
-- +goose Up
-- ADR-0049 § 1: the node-template registry (spec 01:17, 09:54) and workflow folders.

CREATE TABLE node_templates (
    id               uuid        PRIMARY KEY DEFAULT uuidv7(),
    organization_id  uuid        NOT NULL REFERENCES organizations (id),
    slug             text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9.-]{0,127}$'),  -- = metadata.name in YAML
    display_name     text        NOT NULL CHECK (length (display_name) BETWEEN 1 AND 200),
    kind             text        NOT NULL,          -- the implemented kind, e.g. agent.acp
    description      text        NOT NULL DEFAULT '',
    status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_by       uuid        NOT NULL REFERENCES users (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

-- Immutability is structural, as in pipeline_revisions (00005): no UPDATE path to the
-- content columns, the API has no mutation route, and pipeline revisions pin a row here.
CREATE TABLE node_template_revisions (
    id               uuid        PRIMARY KEY DEFAULT uuidv7(),
    template_id      uuid        NOT NULL REFERENCES node_templates (id),
    organization_id  uuid        NOT NULL REFERENCES organizations (id),
    revision_number  integer     NOT NULL CHECK (revision_number >= 1),
    version_label    text        NOT NULL CHECK (version_label ~ '^\d+\.\d+\.\d+$'),  -- 07's semver
    parameters       jsonb       NOT NULL CHECK (jsonb_typeof (parameters) = 'object'),
    config           jsonb       NOT NULL CHECK (jsonb_typeof (config) = 'object'),
    output_schema    jsonb       NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof (output_schema) = 'object'),
    workspace_mode   text        NOT NULL DEFAULT 'run_workspace'
                       CHECK (workspace_mode IN ('run_workspace','read_only')),
    revision_digest  text        NOT NULL CHECK (revision_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_by       uuid        NOT NULL REFERENCES users (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, revision_number),
    UNIQUE (template_id, version_label)
);
CREATE INDEX node_template_revisions_template_idx
    ON node_template_revisions (template_id, revision_number DESC);

-- Written at publish time (same transaction as the pipeline_revisions row); the source of
-- truth for "used in N workflows" (ADR-0049 § 3).
CREATE TABLE pipeline_revision_template_refs (
    pipeline_revision_id uuid NOT NULL REFERENCES pipeline_revisions (id) ON DELETE CASCADE,
    template_id          uuid NOT NULL REFERENCES node_templates (id),
    template_revision_id uuid NOT NULL REFERENCES node_template_revisions (id),
    node_id              text NOT NULL,
    PRIMARY KEY (pipeline_revision_id, node_id, template_id)
);
CREATE INDEX ptr_refs_template_idx
    ON pipeline_revision_template_refs (template_id, pipeline_revision_id);

-- Workflow folders (design 3a): a plain display string, no folder entity (per-folder
-- permissions would need their own ADR).
ALTER TABLE pipelines ADD COLUMN folder text
    CHECK (folder IS NULL OR length (folder) BETWEEN 1 AND 200);
```

Notes: `revision_digest` is over the canonical JSON of
`(parameters, config, output_schema, workspace_mode)` via ADR-0021 canonicalization, digest
scope `v1alpha1-canonical-1`. Unlike `pipeline_revisions`, there is **no organization-wide
digest uniqueness**: identical content in two templates is legitimate (it is exactly what
`:duplicate` produces). `node_templates.status='retired'` is settable in SQL for now; no
retire endpoint in this ADR — new references to a retired template fail to compile, existing
revisions keep resolving (retirement never deletes a revision).

### § 2. How a pipeline revision references a template revision

**Findings first:** the compiler supports *nothing* for pipeline→template references today —
no node field names a template, and `Registries.NodeTemplates` answers only "does this name
exist". This ADR adds the reference and the resolution:

1. **Schema:** a pipeline node object gains one optional property
   `template: string` with pattern `^[a-z][a-z0-9.-]{0,127}@\d+\.\d+\.\d+$` (i.e.
   `slug@semver`, e.g. `template: security-reviewer@1.2.0`). The node's `kind` must equal the
   template revision's `kind` (its `spec.implements`). The node's `config` carries the
   **parameter values**; the template revision's `config` is the parameterized body. The
   canonical document stores the reference string as written — **never** the expansion — so a
   template's content change cannot move a revision digest, and ADR-0021's digest semantics
   are untouched. (01:99: references are by unique IDs, not positional indices.)
2. **Resolution at compile/publish (fail-closed).** `compiler.Registries` gains a template
   lookup alongside `Profiles`/`Repositories`/`PipelineRevs` (`compiler/helpers.go:41-55`):
   `GetActiveTemplate(name)` and `GetTemplateRevision(name, version)` returning the pinned
   revision (`config`, `parameters`, `workspace_mode`, digest) — populated from Postgres on
   the same read path the other registries use. For each node with `template`:
   - the referenced `(slug, version)` must exist in the caller's org and the template be
     `active`, else a new compile diagnostic `template_ref_unresolved` (validate answers, no
     500, ADR-0014/ADR-0021 style);
   - the node's `config` is validated against the revision's `parameters` JSON schema;
   - the revision's `config` bindings are composed with the node's `config` as the parameter
     values, using the template-scope expression environment the compiler already builds in
     `compiler/template.go` (`ScopeTemplate`, `w.plan.Inputs = parameters`); sandbox and
     credential policy checks run on the composed node exactly as on an inline node (03:33 —
     a template "must not silently bypass" policy).
3. **Pinning.** Each resolving node contributes a `template_refs` entry to its `compiled_plan`
   node record: `{template_id, template_revision_id, template_revision_digest}`; the entries
   are covered by `plan_digest`. Because runs execute the pinned `compiled_plan` (ADR-0023),
   a run started before a template re-publish is unaffected by it, and after it, both
   versions keep working — template revisions are never deleted. Secret literals inside a
   template `config` are rejected exactly as in any node config (ADR-0021 finding codes).
4. **Refs table.** On draft publish, the store writes one
   `pipeline_revision_template_refs` row per (node, template) in the **same transaction** as
   the `pipeline_revisions` row. The `CodeTemplatePublishDefer` refusal in
   `m4api.go:979-984` is deleted; standalone `NodeTemplate` documents can still be authored in
   YAML but are not the write path (the API in § 3 is). M4 documents that only reference
   inline nodes compile byte-identically as before.

### § 3. API (`api/openapi.yaml`, problem+json per ADR-0014)

New schemas: `NodeTemplate`, `NodeTemplateRevision`, `TemplateUsage`, request bodies
`NodeTemplateCreate`, `NodeTemplateRevisionCreate`, `TemplateDuplicate`.

- `GET /api/v1/node-templates` → `200 {"templates": [NodeTemplate], "next_cursor": string|null}`
  (list-only cursor, ADR-0014 pagination; org-scoped, one org per deploy as today).
  `NodeTemplate = {id, slug, display_name, kind, description, status,
  latest_revision: NodeTemplateRevisionSummary, used_in_count: int, created_by, created_at,
  updated_at}` where `latest_revision = {revision_id, revision_number, version_label,
  revision_digest, created_at}` and `used_in_count` is § 4's number.
- `POST /api/v1/node-templates` → `201` NodeTemplate (with its revision 1). Body
  `NodeTemplateCreate = {slug, display_name, description, kind, parameters: JSON-schema
  object, config: object, output_schema: object (default {}), workspace_mode
  (default "run_workspace"), version_label (default "1.0.0")}`. One transaction: both rows +
  journal (§ 7). `kind` must be in the v1alpha1 catalogue. Unknown `kind` / invalid
  parameters schema → `400`.
- `GET /api/v1/node-templates/{id}` → `200 {template: NodeTemplate, revisions:
  [NodeTemplateRevision], usages: [TemplateUsage]}` (full revision history, newest first; one
  query per relation — no N+1). `NodeTemplateRevision = {revision_id, revision_number,
  version_label, parameters, config, output_schema, workspace_mode, revision_digest,
  created_by, created_at}`.
- `POST /api/v1/node-templates/{id}/revisions` → `201` = "Edit for all". Body
  `NodeTemplateRevisionCreate = {parameters, config, output_schema, workspace_mode,
  version_label, adopt_using_workflows: bool (default false)}`. Creates revision N+1 (new
  `revision_number`, digest) in one transaction; `version_label` already taken → `409`.
  With `adopt_using_workflows: true`, also performs § 5. Response: `{revision:
  NodeTemplateRevision, adopted: [{pipeline_id, pipeline_slug, draft_id, draft_version}],
  skipped: [{pipeline_id, reason: "open_draft"}]}`. This is the endpoint behind the UI
  "Edit for all N workflows → version x.y.z".
- `POST /api/v1/node-templates/{id}:duplicate` → `201` a **new** template
  (`slug`/`display_name` in the body; `409` if the slug exists) whose revision 1 is a content
  copy of the source's latest revision (same `parameters/config/output_schema/workspace_mode`,
  same `version_label`, `revision_number = 1`, new digest row). One transaction, one journal
  event. This is "Duplicate as a new step…".
- `PATCH /api/v1/pipelines/{id}` (existing metadata-only update) accepts `"folder": string|null`
  (≤ 200 chars; `null` clears). Existing `pipeline.update` journal event detail gains `folder`
  when it changed. No new event type.
- `GET /api/v1/pipelines` list response: each `Pipeline` gains `"folder": string|null`.

Unknown template id, or an id outside the caller's org → the api not-found sentinel `404`
(invisible resource, house style). `TemplateUsage = {pipeline_id, pipeline_slug,
pipeline_display_name, revision_number, template_revision_id, node_ids: [string],
up_to_date: bool}` — `up_to_date` is true iff the referencing pipeline revision references
the template's **latest** revision; it is the honest signal behind design 3b's "live status
per use" (no invented run states).

### § 4. "Used in N workflows" — computed, not stored

The refs table (written at publish, § 2.4) is the source of truth; the latest-revision
semantics keep "used in" honest (a pipeline that moved on no longer counts):

```sql
SELECT DISTINCT pr.pipeline_id, pr.revision_number, p.slug, p.display_name
FROM pipeline_revision_template_refs r
JOIN pipeline_revisions pr ON pr.id = r.pipeline_revision_id
JOIN pipelines p ON p.id = pr.pipeline_id
WHERE r.template_id = $1 AND p.archived_at IS NULL
  AND pr.revision_number = (SELECT max(revision_number) FROM pipeline_revisions
                            WHERE pipeline_id = p.id);
```

`used_in_count` = row count; the same rows feed `usages` (joining again for
`template_revision_id`/`node_id`/`up_to_date` against `node_templates`' latest revision
number). A draft's references do **not** count — only published revisions do; the count
updates on the next publish. One indexed query, no document scan, no N+1 (mirrors the C3
cross-project-reads style).

### § 5. "Edit for all N" — adopt via draft (immutability preserved)

Publishing a new template revision with `adopt_using_workflows: true` **never mutates a
published pipeline revision and never touches a running run** (03:5, ADR-0002/0023). It
creates, in the **same transaction** as the revision row, a draft per affected pipeline:

1. Scope: every pipeline whose **latest published revision** has a refs row for this
   template (any template revision; the § 4 query), excluding archived pipelines.
2. Transformation: take that revision's `canonical_document`, set `template` to
   `slug@<new version_label>` on every referencing node, and regenerate `document_text`
   from the canonical document exactly as publish does (00005 comment, ADR-0021 §5). No
   YAML string surgery, no other node is touched.
3. Draft row: `pipeline_drafts` with `status='draft'`, `source_kind='manual'`, `version=1`,
   `edited_by=<caller>`. If the pipeline already has an **open draft** (any
   `status != 'published'`), the pipeline is **skipped** (never clobber a human's
   in-progress draft) and reported in the response's `skipped` array as
   `{pipeline_id, reason: "open_draft"}`.
4. Journal: one `pipeline.draft.create` event per adopted draft (existing event name),
   with detail `{"reason": "template_adopt", "template_id": ..., "version": "x.y.z"}`.
   The revision row itself gets `node_template.revision.publish` (§ 7). The `up_to_date`
   flag in § 3 flips to true for these pipelines once the adopter publishes the draft.

The adopter is a separate actor from the template author's intent only in name — the draft
is edited by, and journal-attributed to, the caller who published the revision.

### § 6. "Also save as a reusable step" (Studio inspector)

The checkbox (design 4b) is served by the existing `POST /api/v1/node-templates` — no new
endpoint. The Studio builds `NodeTemplateCreate` from the selected node: `kind` = the
node's `kind`; `config` = the node's `config` (parameterization starts empty: the first
revision's `parameters` is `{"type": "object", "properties": {}}`, so every field is a
literal and behaviour is byte-identical to the inline node); `output_schema` = `{
"type": "object"}`; `slug`/`display_name` from the step id / a name field in the inspector;
`version_label` defaults to `1.0.0`. Success response carries the created
`NodeTemplate`; the UI then inserts the optional reference (`slug@1.0.0`) into the draft
through the normal version-checked PUT (ADR-0042/0044 apply path) — the save itself
publishes nothing pipeline-side, so the node stays inline in the current draft unless the
author opts into the reference.

### § 7. Journal events and permissions

Journal (all in the same transaction as the state write, `domain_events`, 09:48):

| mutation | event |
|---|---|
| `POST /node-templates` (template + revision 1) | `node_template.create` |
| `POST /node-templates/{id}/revisions` | `node_template.revision.publish` |
| `POST /node-templates/{id}:duplicate` (template + copied revision 1) | `node_template.duplicate` |
| adopt draft per pipeline (§ 5) | `pipeline.draft.create` (existing name, detail `reason: template_adopt`) |
| `PATCH /pipelines/{id}` folder change | `pipeline.update` (existing name, detail gains `folder`) |

Event payload: org id, template/revision/pipeline ids, `version_label`, actor id — same
envelope conventions as the project stream (ADR-0014); org event streaming (C4) picks these
up with no extra work.

Permissions (house predicates, no new authz surface): **read** (list/get incl. revisions
and usages) = any caller in the org — the same visibility rule as `GET /pipelines`; a
template that is not in the caller's org is the not-found sentinel `404`. **Write**
(create, new revision, duplicate) = `c.IsOrgAdmin` — the exact gate
agent-profile writes already use (`internal/api/agent_profiles.go:120`); non-admin →
`403`. Folders: `PATCH /pipelines/{id}` keeps its existing authorization (pipeline
metadata is org-admin-writable, member-readable).

### § 8. Folders — sidebar and index

`pipelines.folder` (§ 1) is the whole backend: `PATCH /pipelines/{id}` sets/clears it and
the list response carries it. The sidebar "distinct folders with counts" and the grouped
Workflows index (3a) are computed client-side from the org pipeline list (`showWorkflowFolders`
pref hides the grouping; `NULL`/empty renders as an **Unfiled** group — honest, no empty
string special-casing in the API). No folder entity, no per-folder permissions; if those
appear, that is a new ADR.

## Consequences

- Lifts the ADR-0024 §2 deferral: `CodeTemplatePublishDefer` is removed from
  `m4api.go`/`compiler/template.go`; the M5 gate becomes a feature, and the compiler's
  `template_ref_unresolved` diagnostic replaces it for references.
- The v1alpha1 schema gains an additive, optional node field; existing documents compile
  identically, so no revision re-publish is forced.
- "Used in N" is always true by construction (refs written at publish, latest-revision
  semantics) — the UI can finally drop the M5 note from the Steps page and
  YOUR SAVED STEPS picker sections (gaps §5 honest-empty states become real data).
- `plan_digest`/`compiled_plan` shape grows (`template_refs` provenance entries); the
  composed config bindings live in the immutable plan, so an old run keeps working after
  template re-publishes with no claim-time lookups (ADR-0027's claim-time resolution still
  applies to the bindings it already covers, e.g. secret refs).
- Template YAML authoring (`kind: NodeTemplate` documents) remains validatable but the API
  is the only publish path; standalone NodeTemplate drafts without a pipeline owner stay
  unpublishable as before (no change).

## Security/privacy

- Templates are org-scoped like all config; no new trust boundary. A template revision's
  `config` is secret-checked and policy-checked at compile time exactly like an inline
  node (03:33, ADR-0018, ADR-0021): a template **cannot bypass** sandbox/credential policy
  or carry a secret literal.
- `workspace_mode` is pinned per revision and enforced per node, as for inline nodes.
- No new egress, no new principal; the adopt flow only ever creates drafts (a draft cannot
  publish itself — publishing still requires the draft's own `PUT`/publish right).
- Write gate is `IsOrgAdmin`; a project member with no org-admin role can read templates
  but gets `403` on every mutation (covered by an API test).

## Verification

- Unit: schema pattern/`additionalProperties` for the node `template` field; resolution
  fail-closed (unknown slug/version/retired template → `template_ref_unresolved`);
  parameter-validation errors; `used_in_count` latest-revision semantics (stale reference
  in an old revision + moved-on latest revision = 0); adopt transformation on a multi-node
  canonical document (only referencing nodes change, `document_text` re-render equals
  canonical re-render).
- Integration (real Postgres, `COMMUNICATION_TEST_DATABASE_URL`): every § 3 endpoint
  round-trip incl. `409` on duplicate `version_label`/slug, `404` not-found sentinel for a
  foreign-org template, `403` for non-admin writes; adopt creates the draft rows + journal
  in one transaction (kill/rollback leaves nothing half-written); refs rows land in the
  same transaction as the publish.
- Contract: `pnpm --dir ui gen:api` regenerates clean after the `openapi.yaml` edit;
  `pnpm --dir ui check` green; UI acceptance per `gaps/library.md` §7 (Steps page shows
  real counts; "Edit for all" response drives the adopted/skipped UI).

## Migration/rollback

- Up: `00009_step_registry.sql` as written; additive only — no backfill (existing
  revisions reference no templates), `folder` defaults NULL.
- Down: goose down drops the three tables, the `folder` column and re-adds the publish
  deferral code (reverting the `m4api.go`/`compiler` hunks); adopted drafts are ordinary
  drafts (deletable); published revisions are untouched by everything in this ADR, so
  rollback never invalidates a run's pin.
