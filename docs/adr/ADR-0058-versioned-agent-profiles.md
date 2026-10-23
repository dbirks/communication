# ADR-0058 — Versioned agent profiles, part 1: the version history and its token

- **Date:** 2026-10-22
- **Status:** Accepted (design's "v3 / Save as v4"; part 1 = ADR + migration + API — the version
  history reads, the write-side token and the write paths that land versions)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0030 (writable agent profiles with APM packages — this
  ADR amends its §2 "no optimistic version token"), ADR-0054 (server-side APM lock — the lock
  resolve is a profile write and lands a version), ADR-0013 (forward-only migrations), ADR-0014
  (§3 invisible resource / uniform 404), ADR-0023 (§12 state + journal in one transaction), the
  design handoff `docs/design/handoff-app-shell/gaps/profiles.md` §3 (the "Profile versions
  `v3` / `Save as v4` / history" row), `docs/design/handoff-app-shell/GAPS.md` conflict 7, the
  PO decision of 2026-10-22 ("we should version them").

## Context

ADR-0030 fixed the writable profile surface (the APM triple, all-or-nothing, library role) and
explicitly recorded "**no optimistic `version` token**" (`ADR-0030:62`): the triple is written
whole, so the last committed writer shows in the journal and a lost race is unobservable. The
app-shell redesign's Phase 5 asks for versioned profiles — the artboard's header glyph
(`CLAUDE CODE · WORK v3`), the `Save as v4` flow — and the product owner decided on 2026-10-22
to version them. That is a new persisted-state surface (a version history) plus a new
optimistic-concurrency contract on the existing write path, and both belong in one ADR.

Today a profile is one row (`agent_profiles`) with no version, no history and no token: a
profile that changed its pin is indistinguishable from one that never did, and two racing writers
resolve by last-writer-wins. The versioned-history design's "v3 / Save as v4" cannot be honest
about *which* state a conversation or run is executing without a recorded version.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: `agent_profiles.version` token + `agent_profile_versions` history | token = the row (CAS), history = append-only rows; one migration, one write path | new migration + new table; a write that changes nothing still costs a version row | ADR-0030 §2, design handoff §3 |
| B: history only, no token; versions derived by replaying `agent.profile.*` | no migration for the token | replay is not a write-side fact; a racing writer still overwrites; "Save as v4" has nothing to diff against | ADR-0030 §2 |
| C: token only, no history rows | CAS only | no `Save as v4`, no `GET …/versions`, no restore — the design's ask is not met | design handoff §3 |

## Decision

1. **`agent_profiles.version int NOT NULL DEFAULT 1`** (migration `00014_agent_profile_versions.sql`)
   is the **current version** and the **optimistic-concurrency token** (amends ADR-0030:62). A
   write carries the version it saw; a write whose version is stale answers **409** and lands
   nothing. Writes that carry no version still land (the server bumps and journals every write).
2. **`agent_profile_versions`** (migration 00014): `id, profile_id, organization_id, version,
   snapshot jsonb, created_by, created_at, note text NULL`, `UNIQUE (profile_id, version)`.
   One row per version; the snapshot is the frozen launch-descriptor state (name, launcher,
   permission mode, the APM coordinates) — never a secret value, because a profile only ever
   references secrets, it does not hold them.
3. **Every profile write appends a version in the same transaction** as the state change: the
   create's version 1, the APM-triple patch's bumped version, and the server-side APM lock resolve's
   landed version. The token bump and the history row ride one transaction (ADR-0013), so the
   token and the history can never disagree.
4. **What pins a version:** a conversation records `agent_profile_version` at creation (the
   profile's current version, resolved off the row), and a run started from a conversation
   (`RunCreate.source`) inherits that pin. The conversation is the resolution root the worker's
   `ProfileFor` joins through, so the pin is the least invasive place the version can be recorded.
5. **Reading a historical version:** `GET /api/v1/agent-profiles/{profileId}/versions` (list,
   oldest first) and `GET /api/v1/agent-profiles/{profileId}/versions/{version}` (one frozen
   version, `404` when the version does not exist).
6. **"Restore version n" is a new write whose snapshot equals n** — a new version row whose
   snapshot is n's snapshot; history is append-only, so the restore adds a version rather than
   rewriting one.

## Consequences

- The design's version glyph (`CLAUDE CODE · WORK v3`) and the `Save as v4` flow have a backend to
  render: the profile view carries the current version, the history answers reads, and a stale
  write is a 409 the client resolves by re-reading.
- No trust-boundary change: versions freeze identifiers and references, not secrets or prompts.
- New public API + new persisted state ⇒ this ADR is required by the house rules; the migration is
  forward-only (ADR-0013).

## Security/privacy

No new secret surface. Snapshots hold only the launch-descriptor state; secret *values* live in
`secret_versions` (envelope-encrypted, ADR-0018) and a profile only ever names the secret it may
use, which is what the snapshot must never carry.

## Verification

- `go test -race ./internal/store/postgres/... -count=1` — each write path (create, patch, lock)
  appends exactly one version in-transaction; a stale version answers 409 and lands nothing;
  list/get of the history; cross-organization 404; the migration backfills version 1 for existing
  profiles.
- `go test -race ./internal/api/... -count=1` — status/code/CSRF for the version reads and the
  409 on a stale version.
- OpenAPI: `npx @redocly/cli@2.63.0 lint api/openapi.yaml` clean; `pnpm --dir ui gen:api` (the
  generated client picks up the new `version` member, the two version routes and the nullable
  patch token).

## Migration/rollback

`00014_agent_profile_versions.sql`: add `agent_profiles.version` (default 1), create
`agent_profile_versions` + its unique index, backfill version 1 for every existing profile, and
add the conversations/runs `agent_profile_version` pin columns. `migrate down` drops the tables
and columns; forward-only per ADR-0013.
