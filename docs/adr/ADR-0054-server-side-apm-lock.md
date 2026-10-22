# ADR-0054 — Server-side APM lock digest: `POST /api/v1/agent-profiles/{id}/apm/lock`

- **Date:** 2026-10-21
- **Status:** Accepted (design; implementation later — evidence per § Verification required)
- **Owners:** control-plane contributors + worker (be-apm-lock)
- **Related decisions / contracts:** ADR-0008 (APM staging), ADR-0013 (journal), ADR-0014 (HTTP/SSE), ADR-0019 (nono `required` mode), ADR-0026 (command sandbox), ADR-0030 (writable profiles, APM triple as one unit, "staging is not isolation"), `internal/agent/apm/stage.go` + `manifest.go` (worker-side digest check), `gaps/profiles.md` §3 (W7, "Lock it") + §5 (APM), app-shell handoff `docs/design/handoff-app-shell/GAPS.md` ADR register

## Context

The app-shell redesign's profile detail shows a "FROM APM PACKAGE" section (skills · instructions ·
MCP servers) and a `Lock it` button that records the lock digest. Today:

- The digest `sha256(apm.lock.yaml)` is **pasted by hand** by the operator
  (`ui` `agents-digest-input`; `PATCH /api/v1/agent-profiles/{profileId}` triple, ADR-0030).
  The app-shell acceptance check forbids any digest in the UI that "wasn't returned by the API"
  (`gaps/profiles.md` §7.4) — so a UI `Lock it` button cannot exist without an API that computes it.
- No API resolves or lists an APM package: `internal/agent/apm` runs **in the worker only**, at
  launch, staging the pinned triple into the run checkout and refusing a
  `sha256(apm.lock.yaml)` mismatch (`stage.go`, `manifest.go`). Nothing computes a lock for an
  arbitrary `{ref, target}` on demand, and nothing enumerates what a package would contain
  (`gaps/profiles.md` §5 APM: "No API computes a lock/digest ('Lock it') and no API lists package
  contents").

The product owner's decision list names this as the "server-side APM lock digest" ADR. Two
constraints bind the design:

1. **Resolution touches the network and a package source** (the `#<ref>` git remote; APM's own
   registry for dependencies). It must therefore run where the worker already runs agent/launcher
   processes — never in the API/control-plane process (ADR-0001: control mode owns no workloads).
2. **The control plane remains the only writer of profile state.** The worker never
   `PATCH`es `agent_profiles` itself; it reports facts, the control plane stores them (ADR-0013:
   a mutation writes state + its journal event in one transaction).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. API process shells out to the pinned `apm` CLI | one less hop | egress + filesystem work in the control plane — the one mode with no sandbox, no launcher registry, no workloads; contradicts ADR-0001/ADR-0019 layering | ADR-0001, ADR-0019 D5 |
| B. **Worker-side resolve, sandboxed child, result reported to the control plane; API is a thin trigger** (chosen) | resolution runs under the same worker + sandbox discipline as agent launches; API surface stays stateless wrt package content; digest/contents are journaled like every other profile mutation | one claim round-trip; UI must wait (202 + event), not get a synchronous 200 | ADR-0008, ADR-0013, `stage.go` probe notes A5/A5b |
| C. UI computes the lock locally (`apm` in the browser/CI) | no backend | impossible in the browser; would move an egress-touching step onto an unmanaged machine — ADR-0030's "friction" becomes an un-auditable copy-paste from anywhere | ADR-0030 § Consequences |

## Decision

**B.** `POST /api/v1/agent-profiles/{id}/apm/lock` — the colon form `apm:lock` is not a stable
mux segment, so the route is `apm/lock`. Semantics:

1. **Preconditions (control plane, before any dispatch).** The profile exists in the caller's
   org (else 404, existence stays org-scoped), the caller holds the same write right as
   `PATCH /agent-profiles` (org admin today; refusal journaling to `audit_events` unchanged), the
   CSRF/origin pair validates (ADR-0012/0014), and the profile already has **both**
   `apm_package_ref` and `apm_target` set — locking a missing coordinate is
   `409 apm_pin_incomplete` (the ADR-0030 code, reused). The request body is empty.
2. **Worker-side resolve (the only process that sees the package).** The claim is dispatched like
   any worker job. In a **sandboxed child** the worker runs the pinned `apm` CLI with
   `apm install --target <target>` **without `--frozen`** in a scratch checkout at the `#<ref>`
   position — exactly the sequence ADR-0030's § Verification notes (`--frozen` refuses to
   bootstrap a missing lock; the non-frozen run is what *writes* one and resolves the tag). The
   child then reads `apm.yml`/`apm.lock.yaml` and the staged manifest tree and computes
   `sha256(apm.lock.yaml)`. Timeout-bounded; any failure (network, ref missing, CLI refusal)
   closes the job with a named error and writes nothing.
3. **Result the worker reports back:** the digest, and a **manifest summary** — the package's
   `skills[]`, `instructions[]`, `mcp_servers[]` **names** (never contents, prompts or paths
   beyond names; a lock summary, not a payload).
4. **Control-plane store (one transaction).** On the reported result the control plane writes
   `agent_profiles.apm_lock_digest` (existing column, ADR-0030) **and** a new
   `agent_profiles.apm_contents_summary jsonb` (the manifest summary; null until locked) with
   `updated_at`, plus the journal event **`agent.profile.apm_locked`** (org-scoped, `project_id`
   NULL, dotted grammar per ADR-0030 §7) naming the digest and the summary counts. Migration: a
   new forward-only migration at implementation time (next number after `00010`).
5. **API surface.** The `POST` answers **202 Accepted** (a claim was dispatched); `GET
   /agent-profiles` and the detail gain `apm_contents` (`{skills, instructions, mcp_servers}` as
   name arrays, null when unlocked) next to the existing triple. The event stream carries
   `agent.profile.apm_locked` so the detail page can flip without polling. The manual triple
   `PATCH` (paste-by-hand) stays as-is — ADR-0030's all-or-nothing rule is untouched; the lock
   endpoint is a convenience writer of the same column, not a fourth field.
6. **UI.** The `Lock it` button POSTs, then renders the digest and the "FROM APM PACKAGE" names
   **only from the API response / `apm_contents`** (acceptance: no `sha256:` digest or content
   list ever appears that the API did not return; before a lock exists the section says "not
   locked yet", never "0 skills").

## Consequences

Positive: the digest the worker enforces at launch is the same string the API recorded — the
manual paste step (and its typos) is gone; "FROM APM PACKAGE" is real data, not a guess; every
lock is attributed and journalled like any other profile write.

Limitations: the summary is a **name list at lock time** — contents change upstream only by
moving the digest (ADR-0030's invariant is untouched; the check stays `sha256(apm.lock.yaml)`,
A5b). The 202+event latency replaces a synchronous round-trip; the UI must tolerate a lock job
still in flight. `apm_contents_summary` is display state — nothing authorizes from it.

## Security/privacy

- **Resolution runs on a worker, in a sandboxed child, never in the API process.** The scratch
  checkout + child process are confined exactly as a command/agent launch: the command sandbox
  grants (ADR-0026) and, where `enforcement: required`, nono (ADR-0019). The child gets the `apm`
  binary (built-in launcher path, ADR-0030 § Verification's pinned CLI) and a fresh HOME.
- **Network egress is allowlisted, never open.** The child may reach only the package source for
  the profile's `#<ref>` and APM's registry — a worker-config allowlist (a sibling of ADR-0035's
  `COMMUNICATION_AGENT_EGRESS_ALLOW`, worker-level config, **never** pipeline/UI data) — because
  "resolve `{ref, target}`" means fetching arbitrary upstream source, which is the one step in
  this flow that cannot be pre-audited per package.
- **APM staging is still not a security boundary** (ADR-0030: "a digest makes content
  *identifiable*, not safe"). `Lock it` does not make a package safe: a hostile upstream at a
  pinned ref still delivers hostile skill/MCP content on the next launch, and only the launch-time
  digest check (plus the agent's own sandbox) contains it. The UI copy says so (the existing
  "staging is not isolation" disclaimer, kept).
- The result payload carries names + digest only: no lock file body, no file paths, no prompts,
  no values. The `#<ref>` coordinate is public source-control metadata (ADR-0030).

## Verification

Design-only today; implementation must land (mirrors ADR-0030's test shape):

- Store (real PostgreSQL, `internal/store/postgres`): report → `apm_lock_digest` +
  `apm_contents_summary` + `agent.profile.apm_locked` in one transaction; non-admin report
  refused; cross-org profile → not-found; digest nulled behind the API still refuses a launch
  (the ADR-0030 invariant holds through the new writer).
- Handler (`internal/api`): preconditions (404 / `apm_pin_incomplete` / CSRF / non-admin), 202
  while dispatched, `apm_contents` in the list/detail after a reported result.
- Worker (`internal/agent/apm`): a **real** resolve against a pinned test package — scratch
  checkout, non-frozen `apm install`, digest equals `sha256(apm.lock.yaml)`, summary names equal
  the staged manifest; a tampered upstream ref produces a *different* digest (A5b property);
  egress denial (allowlist off / ref host absent) fails the job with a named error and writes
  nothing.
- Browser: `Lock it` on a seeded profile → `apm.lock` 202 → detail shows the server-returned
  digest and name list only; the `document.body.innerText` never contains a digest the API did
  not return (acceptance check §7.4).

## Migration/rollback

Forward-only migration adds `apm_contents_summary` (nullable; existing rows stay null =
unlocked — no backfill, the digest column is unchanged and stays authoritative). Rollback =
stop advertising the route; the column is inert, the manual `PATCH` triple remains fully
functional, and the launch-time digest check is independent of this ADR entirely.

## Amendment 1 (2026-10-22) — implementation

The design above is implemented as accepted; nothing in the Accepted text is reopened.
The concrete mechanism the control plane, worker and API landed on:

1. **Dispatch.** `POST /api/v1/agent-profiles/{profileId}/apm/lock` answers `202` with the
   queued request id; `GET .../apm/lock` answers the latest request status (`none` when no
   request was ever queued). The control plane queues an `apm_lock_requests` row
   (migration `00013_apm_lock.sql`: `apm_contents_summary jsonb` on `agent_profiles` plus
   the queue table); the worker claims it through the family-wide `FOR UPDATE SKIP LOCKED` +
   lease idiom (`internal/worker/apmlock.go`) and resolves in a fresh scratch dir via the
   `APMTyper.Resolve` seam (`internal/agent/apm/resolve.go`). The resolve deadline is
   `worker.DefaultAPMLockResolveTimeout` (5 min); a wedged resolve leaves the lease to be
   re-claimed.
2. **One transaction.** The worker-reported result lands through
   `TurnStore.CompleteAPMLockRequest`: on success it writes `apm_lock_digest` +
   `apm_contents_summary` and appends `agent.profile.apm_locked` in one transaction
   (ADR-0013); on failure it marks the request failed and writes nothing.
3. **Event.** `agent.profile.apm_locked` (`events.TypeAgentProfileAPMLocked`) carries the
   worker-attributed payload — ids, digest, ref, resolved ref, commit, version — and never a
   contents body.
4. **API.** `AgentProfileView.apm_contents` (`{skills, instructions, mcp_servers,
   truncated}`, null while unlocked) sits beside the existing triple; the 202/status GET
   answers the `APMLockRequest` view. The OpenAPI contract gained the two routes, the
   `APMLockRequest` schema and the `apm_contents` field; `pnpm --dir ui gen:api` passes.
5. **Egress.** The resolve child runs the pinned `apm` binary with a fresh HOME in a scratch
   dir; the worker's environment/egress allowlist must permit `github.com` for the pinned
   `#<ref>`.

## Verification

- Store (`internal/store/postgres/apm_lock_test.go`): queue → claim → complete writes the
  digest, contents summary and journal event in one transaction; failure path; cross-org
  profile is not found.
- Worker (`internal/worker/apmlock_test.go`): resolve → report through the store; failure.
- API (`internal/api/apm_lock_test.go`): 202 shape, status GET, CSRF gate, anonymous arm;
  precondition refusals (404 / `apm_pin_incomplete`) ride the shared store-error mapping.
- OpenAPI: `redocly lint` clean for the new paths; `pnpm --dir ui gen:api:check` passes.

## Amendment 2 (2026-10-22) — unlocked pins are usable

The orchestrator's lab finding: the committed lock flow could never be used, because the
ADR-0030 all-or-nothing pin rule refused a `{ref, target}` without a digest — the exact shape
an operator reaches for first, and the one "Lock it" exists to remove.

Amended:

1. **Unlocked pins are legal** (`internal/store/postgres/agent_profiles_write.go`,
   `internal/api/agent_profiles.go`). A write carrying the ref and the target with no digest is
   an UNLOCKED pin and is accepted; the digest alone, or a ref/target without its partner, is a
   partial pin and stays `422 apm_pin_incomplete`. Clearing the pin (all three absent) is the
   only other legal write.
2. **Changing ref or target clears the digest and the contents** (`PatchAgentProfileAPM` writes
   `apm_contents_summary` alongside `apm_lock_digest` in one transaction, so a digest recorded
   for a previous ref/target cannot survive a change).
3. **A launch with an unlocked pin is refused** with the named remedy: the worker-side profile
   read (`internal/store/postgres/workspaces.go`) and the launch gate
   (`internal/agent/apm/stage.go`) both answer an empty lock digest with a ref set
   ("…the APM pin is not locked yet — Lock it on the profile"). The invariant from ADR-0030 is
   therefore unchanged; the refusal moved from the half-pin rejection to the not-locked-yet
   state, because the latter is the state an operator actually reaches for.
4. **The lock flow itself is unchanged**: `POST …/apm/lock` still queues a worker-side resolve,
   and the resolve is what writes the digest + contents summary.

## Verification

- Store (`internal/store/postgres/m4_agent_profiles_write_test.go`): an unlocked pin is
  accepted; changing the ref on a locked profile clears the digest and the contents summary in
  the same write; a digest without a ref is refused as a partial pin.
- Launch gate (`internal/agent/apm/stage_test.go`): a stage with a ref and an empty digest
  refuses with the not-locked-yet remedy.
