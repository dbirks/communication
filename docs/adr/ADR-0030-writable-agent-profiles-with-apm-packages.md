# ADR-0030 — Writable agent profiles with an APM package pin

- **Date:** 2026-10-16
- **Status:** Accepted
- **Owners:** control-plane contributors
- **Related:** ADR-0008 (apm 0.33.0), ADR-0009, ADR-0014, ADR-0016, `04-agent-runtime.md:16,24-30,60`,
  APM.md "Git-tag sources", `wishlist-gap.md` § W6

## Context

`agent_profiles.apm_package_ref/apm_target/apm_lock_digest` date from migration 00004 and
`internal/agent/apm` stages from them, refusing a launch whose `sha256(apm.lock.yaml)` differs from
the recorded digest. No API could fill them, so pinning packaged context meant a hand-written
`INSERT`: unvalidated, unjournalled, permission-checked by nobody. Half-right is the dangerous case —
probe A5 showed `apm install --frozen` verifies only that a lockfile is *present* (a mutated upstream
installed cleanly), and A5b that the digest moves exactly when content moves. A ref without a digest
stages whatever the ref points at today, and the worker's read (`workspaces.go`) refuses that state.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Stay read-only; operators `INSERT` | no new API | no permission check, journal or validation | today's state |
| B. `PATCH` each APM column independently | smallest surface | permits the half pin A5b makes dangerous | rejected |
| C. Triple as one unit, library role, digest mandatory (**chosen**) | the API only produces states the worker accepts | approved changes need the digest re-recorded — the point | APM.md T-tag-1…5 |

## Decision

1. **Public API change.** `POST /api/v1/agent-profiles` (`name`, `launcher_id`) and
   `PATCH /api/v1/agent-profiles/{profileId}` (`apm_package_ref`, `apm_target`, `apm_lock_digest`),
   mirrored in `api/openapi.yaml`; the triple joins the list view as explicit nulls. No migration —
   the 00004 columns and their `CHECK`s are reused verbatim.
2. **Who may write: the organization's library role** — the fail-closed predicate already governing
   the shared pipeline library (`api/pipelines.go` `requireLibraryRole`: an org admin, nothing else,
   until that role has a column; widening it is additive there). The check is *in the SQL*:
   `INSERT … SELECT … WHERE $is_org_admin` inserts zero rows for a non-admin, and the `UPDATE`
   carries it likewise. Listing stays open to every org member (ADR-0016 §1), which fixes the codes:
   unknown/cross-org → **404** (never a peek, ADR-0014 §3); same org, no role → **403**.
3. **Package ref grammar**, as proven in APM.md: `<owner>/<repo>[/<subdir>][#<tag|branch|commit>]`, e.g.
   `mattpocock/skills/skills/engineering/ask-matt#v1.3.1` for one skill of a multi-skill repo
   (T-tag-5: the subset persists in `apm.yml` *and* the lock, so `--frozen` replay is unchanged).
   **`#<ref>` is required** — without it apm resolves the default branch, which no digest describes.
4. **All three or none.** A partial triple is **422** `apm_pin_incomplete`; a full triple and a full
   clear are the only other shapes. Refusals name a stable `code` (`apm_pin_incomplete`,
   `apm_package_ref_invalid`, `apm_target_invalid`, `apm_lock_digest_invalid`, `profile_name_invalid`,
   `launcher_id_invalid`) with a matching `type` URI; the prose is not the contract. Validation runs
   in the handler *and* the store, so a `CHECK` never surfaces as a 500 and no caller that skips HTTP
   can land a half pin.
5. **`permission_mode` and every grant axis stay unwritable.** `ask` is the only mode a profile
   without a verified enforced sandbox may hold (ADR-0009), and a route able to move the
   sandbox/workspace/commit axes would widen grants while "attaching a skills package".
6. **APM staging is not isolation** (`04-agent-runtime.md:28`). Staging installs context *before* the
   grant set exists, unsandboxed, in the worker; a digest makes content *identifiable*, not safe, and
   APM.md T3 (isolation) / T4 (HOME untouched) still FAIL — nothing here is a tenant-boundary claim.
7. **Events.** `agent.profile.created` / `agent.profile.updated` in the row's own transaction,
   organization-scoped (`project_id` NULL). Dotted, not `agent_profile.*`: the envelope grammar is
   `^[a-z]+(\.[a-z_]+)+$`.

## Consequences

Pins become attributable, reviewable, journalled; wanting new skill content now requires an operator
to re-record a digest, the intended friction. No optimistic `version` token — the triple is written
whole, so the last committed writer shows in the journal, and a CAS column would be a migration.
Fail-closed on both writes; a ref is a coordinate in public source control, not a secret, and no
payload carries a path, value or prompt. Refusals write an `audit_events` row with no project
(org-scoped, like pipeline definitions). The worker still owns every launch decision.

## Verification

`internal/store/postgres/m4_agent_profiles_write_test.go` (real PostgreSQL): create → patch triple →
list exposes it; each partial triple → `apm_pin_incomplete`; malformed digest/target/ref → named
codes, no SQLSTATE reaching the caller; non-admin store call → forbidden with **zero rows inserted**;
cross-org → not-found; duplicate name → conflict; refusals journal nothing; and `ProfileReader` reads
exactly the triple the API wrote (its digest nulled behind the API's back, that read refuses — the
equivalence the 422 preserves). `internal/api/agent_profiles_test.go`: status, code, CSRF.

## Migration/rollback

None forward. Rollback removes the two routes; rows and journal entries written meanwhile stay valid,
and the worker's unverifiable-pin refusal holds the line if the API is bypassed.
