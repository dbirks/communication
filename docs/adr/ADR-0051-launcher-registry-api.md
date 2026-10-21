# ADR-0051 — Launcher registry + observed-capability evidence: `GET /api/v1/launchers`

- **Date:** 2026-10-21
- **Status:** Accepted
- **Owners:** backend (be-launchers)
- **Related decisions / contracts:** ADR-0019 D5 (worker registration carries sandbox state), ADR-0035/ADR-0036 (per-launcher sandbox evidence), `api/openapi.yaml` `listLaunchers`, `docs/compatibility/ACP.md` + `SANDBOX.md`, C5 of the app-shell redesign handoff (`docs/design/handoff-app-shell/README.md`)

## Context

The app-shell redesign's five agent cards (profiles list, New-profile dialog,
Operations capability matrix — `gaps/profiles.md` §1/§5, `gaps/inbox-ops.md`
"Agent × capability matrix") need one honest source for three different kinds
of fact about each launcher id:

1. **Is it registered?** Today the only registry is code
   (`internal/agent/acp/launchers.go`: `claude`, `codex`); no API lists it, so
   the UI would hardcode `{claude, codex}` (gap §3 row "Sandbox chip": *"no
   API lists the registry → client hardcodes"*).
2. **What was observed?** The capability cells (ACP session, resume,
   permission prompts, nono-required) exist only as prose in
   `docs/compatibility/ACP.md` and `SANDBOX.md`, with raw probe JSON under
   `docs/compatibility/probes/acp/`. No machine-readable record, no DB table
   (gap §2: *"No database table stores probe results"*).
3. **Can anything run it?** Workers register their sandbox state
   (`workers.sandbox_backend/version/enforcement/verified`, ADR-0019 D5) but
   **not** the launchers they can run — `WorkerView` carries no launcher set.

Spec support: `communication-spec/12-test-strategy.md` (the compatibility
table must never be prefilled with PASS — every row needs observed evidence);
`04-agent-runtime.md` ("Permission policy": the server selects the prompting
mode, so `permission_prompts` evidence is mode-specific); `09-api-events-data.md`
(read-only org surfaces need a session, not membership).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Read-only route over the code registry + an embedded, append-only evidence file (`docs/compatibility/acp-observed.json`) + the sandbox-verified live-worker count as `workers_online` | Zero new persisted state (no migration); evidence stays in reviewed commits next to the prose it transcribes; every `observed` is traceable to a dated, path-cited row; the test suite fails on a row whose evidence file is missing | `workers_online` is fleet-level, not per-launcher (documented below); evidence updates need a commit, not a write API | `internal/agent/acp/evidence.go`, `internal/api/launchers.go` |
| B. A `probe_results` table the API reads, written by a probe-run endpoint | Evidence in the database like everything else | A writer for evidence is a security surface (someone could write "observed" without a probe); needs a migration, an ADR on who may write it, and a probe runner that does not exist yet — all for data that currently lives in reviewed documents | rejected for now (see Consequences) |
| C. UI-only: the client hardcodes the registry and parses the markdown | No backend | The exact thing the gap table rejects: hardcoded ids, unparseable prose, and readiness text that can claim more than the evidence says | `gaps/profiles.md` §3 |

## Decision

**A.** `GET /api/v1/launchers` (session required, no membership — matching
`/workers` and `/system/sandbox`) returns `{"launchers":[...]}`:

- **Registry** = the built-in launchers (`acp.KnownLaunchers`: `claude`,
  `codex`) union the four product card ids (`claude`, `codex`, `pi`,
  `antigravity`), card ids first. `registered=false` for ids without a
  launcher entry; a profile naming such an id fails closed at launch
  (ADR-0019 D6). Extra registered launchers beyond the cards are appended, so
  the client's "Other ACP agent" card covers a real id.
- **Capabilities** = the four cells `acp_session | resume |
  permission_prompts | nono_required`. Each result comes **only** from a row
  in `docs/compatibility/acp-observed.json`, embedded in the binary
  (`internal/agent/acp/evidence.go`; the embedded copy must stay byte-identical
  to the docs file — a test enforces it). A cell with no row is
  `not_tested`; `observed_at`/`evidence` are present exactly when the verdict
  is evidence-backed. The file transcribes only what `ACP.md`/`SANDBOX.md`
  record as observed, each row with its date and the evidence path they cite
  (probe JSON or the doc section that records the lab run).
- **`workers_online`** is a **documented approximation**: workers do not
  report which launchers they can run, so the number is the count of live
  workers whose registration says `sandbox_enforcement='required'` AND
  `sandbox_verified=true` — the same liveness rule `/workers` applies (a stale
  heartbeat counts offline). For an unregistered launcher it is `0`: with no
  launcher entry nothing runs on any worker. The shipped worker image
  installs the claude and codex adapters (worker/Dockerfile), so the
  count is the honest fleet-level upper bound for both; it must never be
  rendered as a per-launcher guarantee.

## Consequences

- The UI's readiness line is now unforgeable by the API: "observed" without a
  dated, path-cited row is impossible, and `not_tested` is the default — the
  honest-empty rule of `gaps/profiles.md` §5 (Pi/Antigravity cards read
  "not registered" / "not tested", never green).
- **Updating evidence:** today a probe run appends a row to
  `docs/compatibility/acp-observed.json` via a **reviewed commit** (later
  `observed_at` wins per cell; on a tie the later row wins), re-copies the
  embedded file (`go generate ./internal/agent/acp`), and the test suite
  fails if any cited evidence path does not exist in the repo. A
  probe-results table (option B) is the likely later step once a probe runner
  exists; this ADR defers it deliberately — there is no writer to authorize.
- `workers_online` is fleet-level. If workers start registering a launcher
  set, the count becomes exact without an API change (the interface is
  `CountLaunchWorkers`; only the SQL changes).
- The route is read-only and value-authorizes-nothing: no mutation, no new
  permissions, no secrets.

## Security/privacy

Read-only session-authenticated route; no membership needed (org-level
operational read, same class as `/workers`). No secrets: the response carries
launcher ids, names, dates and file paths. Fail-closed: an unregistered
launcher is visible as such, and the evidence loader panics (not silently
`not_tested`) on a malformed embedded file, because a build-time defect that
reads as honest is worse than a crash.

## Verification

- `internal/agent/acp/evidence_test.go` — embedded copy is byte-identical to
  `docs/compatibility/acp-observed.json`; **every `observed` row names an
  evidence path that exists in the repo**; claude = observed on all four
  cells, codex `nono_required` = not_tested (SANDBOX.md: Codex was not
  tested), pi/antigravity = all not_tested; validation rejects rows with an
  unknown capability/result, a non-RFC3339 date, a missing evidence path or a
  recorded `not_tested`.
- `internal/api/launchers_test.go` — the four card ids in order, exactly the
  `Launcher`/`LauncherCapability` field set, `registered` from the code
  registry, capability verdicts exactly as the evidence file records them,
  `workers_online` = store count for registered / 0 for unregistered, 500
  without the store error text, 401 anonymous.
- `internal/store/postgres/launchers_test.go` — against a real PostgreSQL:
  only `required`+`verified`+live rows count; stale heartbeats and offline
  rows count nothing.

## Migration/rollback

No persisted state, no schema change. Rollback = remove the route wiring
(`cmd/communication/serve.go`), the openapi path/schemas, and the client
generation; the evidence file and ADR remain as the compatibility record.
