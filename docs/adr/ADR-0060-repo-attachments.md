# ADR-0060 — Repo attachments: a library workflow is used by a repository

- **Date:** 2026-10-24
- **Status:** Accepted (repo-scoped attachments + run repository recording + issue-trigger last-fired)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0013 (forward-only migrations), ADR-0014 (§3 invisible resource / uniform 404), ADR-0023 (§5 run shape, §12 idempotency keys), ADR-0032 (schedules, `schedule-<id>-<slot>` idempotency keys), ADR-0056 (run triggers, `trigger_kind`/`trigger_ref`, the issue-polling fire), the design handoff `docs/design/handoff-app-shell/` §1–2 and the "Workflows Review" handoff (`/home/david/.cache/pi-orch/communication/design/wf/README.md`), `communication-spec/05` (workspaces/git), `communication-spec/09` (API resources)

## Context

The app-shell redesign's workflow screens (the product owner's "Workflows Review" handoff) settle a
mental model that the API does not yet express: **a library workflow is a template; a repository uses
it**. The library workflow page has no Start run and no trigger editing; triggers are authored on the
repository page, under each workflow the repository uses, and runs belong to that *use*.

Today an assignment is one row per `(project_id, pipeline_id)` — a pin plus budgets, never a
repository-scoped or project-wide intent (migration `00005_m4_pipelines.sql`, `UNIQUE
(project_id, pipeline_id)`). The redesign's "Used in" tab (artboard 2a) and the repo page's
"WORKFLOWS ON THIS REPO" panel (artboard 1e/2e) need one workflow to be usable by *one repository of
one project* while another repository of the same project keeps using it, or by the whole project
(`repository_id` NULL — the legacy meaning, "any repo").

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: `assignments.repository_id uuid NULL` + `UNIQUE NULLS NOT DISTINCT (project_id, pipeline_id, repository_id)` | one row per (pipeline, repository) intent; NULL = the whole project, exactly the legacy meaning; Postgres ≥15 `NULLS NOT DISTINCT` keeps "one project-wide pin" honest | new migration; the old UNIQUE becomes an ordinary index-backed uniqueness on the new triple | migration `00005`, `00012`, ADR-0056 |
| B: drop the single-assignment-per-pipeline rule, add a per-repo join table | flexible, no NULL-semantics subtlety | a second table to keep in sync with the pin/budget state; the run's pin resolution gets two sources of truth | ADR-0056 §1 |
| C: keep `(project_id, pipeline_id)` and add `repository_id` as a plain nullable column with a plain UNIQUE | simplest migration | plain UNIQUE treats NULLs as distinct, so the project-wide pin and a repo pin could coexist — the exact ambiguity the redesign removes | migration `00005`, task brief |

## Decision

1. **`assignments` gains `repository_id uuid NULL`** (migration `00015_repo_attachments.sql`),
   `FOREIGN KEY (repository_id, project_id) REFERENCES repositories (id, project_id)` — the composite
   unique the migration added for `issue_triggers` (`repositories (id, project_id)`, `00012`) is the
   pattern the new FK reuses. `NULL` means the whole project (legacy / any repo) and is a first-class
   value.
2. **Uniqueness becomes one assignment per `(project_id, pipeline_id, repository_id)` with
   `NULLS NOT DISTINCT`** (Postgres ≥ 15; verified on the lab test database via `SELECT version()`):
   `UNIQUE NULLS NOT DISTINCT (project_id, pipeline_id, repository_id)`. A second assignment of one
   pipeline to the *same* repository — including a second project-wide one — is `409`
   (`assignment-already-exists`); a repo pin and a project-wide pin of the same pipeline coexist.
3. **Runs record the repository they work on** (`runs.repository_id uuid NULL`, FK to
   `repositories (id)`), set at insert, never later, via the precedence the task fixes:
   explicit `repository_id` in `POST /projects/{projectId}/runs` (must be a repository of the project,
   else `422` `invalid_repository`) → the assignment's `repository_id` → the issue trigger's
   repository (`issue`-fired runs) → resolve `inputs.repository` (a string) to a repository of the
   project by name (exact, case-sensitive) → `NULL`.
   Schedule-fired runs take the assignment's repository, else `inputs.repository` (ADR-0032's fire
   writes through the same create path).
4. **An issue trigger on a repository-scoped assignment must use that same repository** (else `422
   repository_mismatch`); a project-wide assignment may pick any repository.
5. **The API** (`api/openapi.yaml`) gains: `AssignmentCreate.repository_id` (+ read-only
   `Assignment.repository_id` / `repository_name` on the response), the run-list filters
   `?repository_id=` / `?assignment_id=` on `GET /api/v1/projects/{projectId}/runs`, and the
   `IssueTrigger` read-only `last_fired_at` + `last_run_id` (the newest run with
   `trigger_kind = 'issue'` fired by that trigger, via one LATERAL subquery in the list SQL).
   `PATCH /api/v1/assignments/{assignmentId}` keeps re-pinning/budgets/enabled and refuses an
   immutable `repository_id` with `422`.
6. **Repository deletion** follows the existing behaviour for other references: a repository that an
   assignment names is refused (`409`) while assignments name it; nothing new is cascaded by this ADR
   (the run-snapshot design already keeps runs pinned to revisions, not repositories).

## Consequences

- The UI can render "used in <project> / <repo>" honestly from real rows; the library workflow page has
  no Start run and the repo page owns triggers (the "Workflows Review" handoff's settled wording).
- New public API + new persisted state ⇒ this ADR is required by the house rules; the migration is
  forward-only (ADR-0013).
- `GET /api/v1/runs?pipeline_id=` already exists (cross-project board list), so no new route was needed
  for pipeline scoping; the repository scoping landed on the project run list.

## Security/privacy

No trust-boundary change: an assignment naming a repository still scopes runs to that repository of
the same project, and the `repository_mismatch` refusal keeps a repo-scoped assignment's issue
triggers inside the same repository.

## Verification

- `go test -race ./internal/store/postgres/... -count=1` — migration 00015 up/down/up; repo + project-wide
  duplicate assignments; `repository_mismatch`; run-repository precedence per branch; list filters;
  issue-trigger last-fired after a fired run; cross-project invisibility via the SQL predicate.
- `go test -race ./internal/api/... -count=1` — the `422 repository_mismatch` / `422 invalid_repository`
  arms and the run-create repository resolution.
- OpenAPI: `npx --yes @redocly/cli@2.63.0 lint api/openapi.yaml` clean; `pnpm --dir ui gen:api` (generated
  client picks up the new members and query params).

## Migration/rollback

`00015_repo_attachments.sql` (additive: `assignments.repository_id` + its composite FK, the
`NULLS NOT DISTINCT` uniqueness, `runs.repository_id` + its FK and the
`(project_id, repository_id, created_at DESC)` index). `migrate down` rolls the run-side columns and
index back first, then the assignment-side FK and the new uniqueness, restoring the pre-00015 single
`(project_id, pipeline_id)` uniqueness.

## Note

`docs/design/approval-files.md` names its draft migration `00015_approval_gate_changes.sql`; it moves
to `00016_approval_gate_changes.sql` with this ADR (the approval-gate migration is not part of this
ADR's brief).
