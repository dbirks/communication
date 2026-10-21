# ADR-0046 — Per-user display preferences: `GET/PATCH /api/v1/me/preferences`, one row per principal, values authorize nothing

- **Date:** 2026-10-20 · **Status:** Accepted · **Owners:** API maintainer; UI maintainer
- **Evidence:** `internal/store/postgres/user_preferences_test.go` (defaults, merge,
  validation, expanded bounds — real PostgreSQL), `internal/api/preferences_test.go`
  (200/400/401, CSRF refusal before the handler, 500 mapping)
- **Related:** ADR-0014 (HTTP/problem conventions), ADR-0013 (forward-only migrations),
  ADR-0034 (assistant broker — the server-side cap this ADR's trust level must not
  weaken), `communication-spec/09-api-events-data.md` (API resource and table
  conventions), `communication-spec/06-collaboration-identity.md` (session/CSRF
  conventions), design handoff `docs/design/handoff-app-shell/` (Sidebar v3 and
  Settings → Layout; gap `gaps/shell.md` §3: "Per-user `layoutPrefs` … needs backend +
  needs ADR")

## Context

The app-shell redesign needs one persisted state the server does not have today: the
signed-in user's display preferences — sidebar projects mode (tree/switcher), Ask-button
placement (sidebar/floating), whether Workflows expand to folders, the `expanded`
map of open/close state, and the assistant trust level (`gaps/shell.md` §3, unit W5).
`GET /api/v1/me` is identity-only (openapi:350) and no settings table or route exists
(grep for `preference` across `ui/src internal api`: no hits). The design brief says the
trust level "doesn't need its own server-side enforcement": it is enforced client-side
in the assistant tool loop. That is a decision this ADR records explicitly, together with
why the rest of the document is equally non-privileged.

The shape that pins the design:

- **Per principal, self-scoped.** The document belongs to the signed-in user; there is
  no project, no other reader, no role predicate — `communication-spec/06` names the
  session/CSRF conventions and the user is the principal (`users.id`, spec 09's table
  family line 52). Nothing here is a project fact.
- **Display state, not operational state.** Values change at keyboard-velocity while the
  user reshapes the sidebar; they carry no authorization weight and no other component
  consumes them. Journaling every save into the project event stream (spec 09's
  families) would flood the streams with events nobody subscribes to, and would imply a
  durable history the product does not want.
- **Strict, name-the-field validation.** The UI client is generated from the same
  `api/openapi.yaml` this ADR extends, so a bad value must die on the request that
  submits it, with the dotted field path in the problem body (ADR-0014's detail-embedded
  code).

## Decision

1. **Table `user_preferences`** (migration `00008_user_preferences.sql`, forward-only
   per ADR-0013): `user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`,
   `layout jsonb NOT NULL DEFAULT '{}'` and `assistant jsonb NOT NULL DEFAULT '{}'`
   (each `CHECK (jsonb_typeof(...) = 'object')`), and `updated_at timestamptz` that
   stays `NULL` until the first save — the API surfaces that as "never saved", which a
   `DEFAULT now()` would hide. One row per principal makes the save a plain
   `ON CONFLICT (user_id)` upsert; a deleted user's row cannot outlive the user.
2. **Routes** `GET /api/v1/me/preferences` and `PATCH /api/v1/me/preferences`
   (`internal/api/preferences.go`), session-authenticated like `/api/v1/me`; the PATCH
   goes through the same `RequireCSRF` guard as every other mutation
   (`communication-spec/06` line 7). The document, defaults and merge rules:

   | member | default | rule |
   |---|---|---|
   | `layout.projects_mode` | `tree` | enum `tree\|switcher` |
   | `layout.ask_placement` | `sidebar` | enum `sidebar\|floating` |
   | `layout.show_workflow_folders` | `true` | boolean |
   | `layout.expanded` | `{}` | map id→bool; **≤ 500 keys, keys ≤ 120 chars**, merged key-by-key |
   | `assistant.trust_level` | `ask_risky` | enum `ask_all\|ask_risky\|no_ask` |

   `updated_at` is `null` until the first save, then RFC3339.

3. **The PATCH body is any subset, deep-merged per section** (`{"layout":{"projects_mode":"switcher"}}`
   leaves every other member alone; `expanded` merges key-by-key). The answer is the
   full document with the new `updated_at`. Unknown keys at any level are refused by the
   strict JSON decoder; unknown enum values and bound violations are refused by the
   store (`internal/store/postgres/user_preferences.go`) as
   `400` problem+json `code: invalid_preferences` with the dotted `field`
   (e.g. `assistant.trust_level`) — the stable-code convention ADR-0037/0038 set. A
   refused patch writes nothing.
4. **Concurrence is last-write-wins, deliberately.** The values are UI display state:
   there is no version, no `Idempotency-Key`, and no lost update a user could act on —
   two tabs saving at once just leaves the later one's picture. This is the one place
   the "resources include `etag/version`" line of spec 09 is consciously relaxed, and
   only because the relaxed resource authorizes nothing.
5. **No journal event.** A save appends no `domain_events` row: spec 09's event families
   are the project/org operational state that the org event stream multiplexes, and a
   display change is neither observable to anyone else nor part of any run's or
   project's history. Writing one would put per-keystroke traffic into the SSE streams
   (spec 09, `Last-Event-ID` resume) for zero information gain, and would audit-trail a
   fact the product does not claim to track.
6. **Authorization semantics.** These values **authorize nothing**: no authorization
   path reads `user_preferences`, so a tampered or stale document cannot grant access —
   the worst case is a misplaced button. The `assistant.trust_level` is enforced
   client-side in the assistant tool loop (the design brief's decision); the server-side
   cap stands regardless — every assistant call is still brokered as the caller's own
   `Caller` at the caller's role (ADR-0034), and `trust_level` never widens which tools
   the broker exposes.
7. **Forward compatibility of stored rows.** The reader merges the defaults *under* the
   stored documents, so a preference added after a user's row was written keeps its
   default for that user, and unknown stored keys are dropped on the way out (rows
   written by an older binary normalize to the current shape on the next save).

## Consequences

- `api/openapi.yaml` gains `/api/v1/me/preferences` and the `UserPreferences` /
  `UserPreferencesPatch` schemas; `pnpm --dir ui gen:api` regenerates the client the
  settings page (W4) and sidebar consume.
- The UI's `useLayoutPrefs`/`useAssistantPrefs` hooks fall back honestly when a server
  predates this ADR (404 → in-memory for the session), so the shell ships before or
  with the backend.
- One small per-user table, one upsert per save, no new indexes, no journal traffic;
  the schema-version bump is picked up by `ExpectedSchemaVersion` from the embedded
  migrations automatically.
- If the product later wants per-organization defaults or admin-visible settings, this
  ADR's relaxation (no version, no event) must be revisited — the moment a preference
  authorizes anything, it stops being display state and this table is the wrong home.
