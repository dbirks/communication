# ADR-0085: In-app agent sign-in (Codex device code, Antigravity paste-back)

- **Date:** 2026-11-18
- **Status:** Proposed
- **Owners:** project owner, orchestrator
- **Related decisions / contracts:**
  - ADR-0019 D4 (launcher credential directories, `AuthEnvVars`)
  - ADR-0040 (headless credentials never in argv, logs or journals)
  - ADR-0054 (server-side APM lock: the control-plane-queues, worker-claims pattern reused here)
  - ADR-0086 (Antigravity launcher)

## Context
Subscription-backed agents need an interactive login once per worker credential volume. Today that means an
operator running `kubectl exec … codex login --device-auth` against production. The owner wants the app to say
"this agent needs sign-in", offer a button, show the link/code, and finish by itself.

Observed on 2026-11-18 (this machine, throwaway homes, no login completed):

- **Codex** (`codex-cli 0.166.0`, the one `codex-acp 2.6.0` bundles): `codex app-server` answers
  `account/login/start {"type":"chatgptDeviceCode"}` with `{loginId, verificationUrl:
  "https://auth.openai.com/codex/device", userCode}`, and `account/read` reports `{account: null,
  requiresOpenaiAuth: true}` when signed out. Completion arrives as the `account/login/completed` notification;
  `account/login/cancel {loginId}` cancels. The ChatGPT account must have "device code sign-in for Codex"
  enabled under Security settings, or OpenAI refuses the code.
- **Antigravity** (`agy 1.5.9`): `antigravity acp --login` prints a Google OAuth URL (redirect
  `https://antigravity.google/oauth-callback`, PKCE) to stdout, then reads one line from stdin: the authorization
  code shown on the callback page, or that page's full URL. It works over plain pipes with no TTY and with a bare
  environment (no SSH, no DISPLAY). The ACP server itself refuses a headless `authenticate` (`"No browser is
  available here …"`) and `session/new` answers `-32000 Authentication required` while signed out.

## Options considered
| Option | Advantages | Disadvantages |
|---|---|---|
| A. Keep `kubectl exec` logins | nothing to build | prod by hand; invisible in the app; no state shown |
| B. Copy credential files into SOPS secrets | GitOps | a copied ChatGPT/Google refresh token is shared with the source machine and goes stale (docs/home-cluster.md); someone must handle the token |
| **C. Worker-run login, app-driven** | no token ever leaves the worker volume; visible state; no prod shell | new queue, routes and UI; the pasted Antigravity code transits the API |

## Decision
Option C.

### Model (migration 00035)
`agent_logins` is the request queue, one row per sign-in attempt:

| column | notes |
|---|---|
| `id uuid pk default uuidv7()` | |
| `organization_id uuid not null` | |
| `launcher text not null check (launcher in ('codex','antigravity'))` | |
| `worker_id text` | the worker that must run it (the credential volume is that worker's); null = any |
| `status text not null default 'queued'` | `queued → starting → awaiting_user → (verifying) → succeeded\|failed\|cancelled\|expired` |
| `verification_url text` | shown to the user |
| `user_code text` | Codex's device code; null for Antigravity |
| `needs_code boolean not null default false` | true when the user must paste a code back (Antigravity) |
| `submitted_code text` | the pasted Antigravity authorization code; **cleared by the worker in the same statement that reads it** |
| `account_label text` | e.g. the signed-in email, when the harness reports one |
| `error text` | a human sentence; never contains a code or token |
| `requested_by uuid not null` | the admin who started it |
| `claimed_by text`, `lease_expires_at timestamptz` | the APM-lock claim idiom (FOR UPDATE SKIP LOCKED + lease) |
| `expires_at timestamptz not null` | created_at + 15 minutes; after it the worker gives up and writes `expired` |
| `created_at`, `updated_at` | |

A partial unique index allows at most one active (`queued|starting|awaiting_user|verifying`) row per
(`organization_id`, `launcher`, `coalesce(worker_id,'')`).

`agent_account_status` is what the Settings page reads, one row per (`worker_id`, `launcher`):
`state ('signed_in'|'signed_out'|'unknown')`, `account_label`, `detail` (a sentence), `checked_at`. The worker
writes it at registration, after every login attempt, and every 10 minutes.

### API (org admin only; every route 403s for non-admins)
- `GET  /api/v1/agent-accounts` → `{items: [{worker_id, worker_name, launcher, state, account_label, detail,
  checked_at, login: <active or most recent AgentLogin> | null}]}` for live workers and the launchers that
  support sign-in.
- `POST /api/v1/agent-accounts/{launcher}/logins` body `{worker_id?}` → 201 `AgentLogin`; 409 when one is active.
- `GET  /api/v1/agent-logins/{id}` → `AgentLogin` `{id, launcher, worker_id, status, verification_url, user_code,
  needs_code, account_label, error, expires_at, created_at, updated_at}`. `submitted_code` is **never** returned.
- `POST /api/v1/agent-logins/{id}/code` body `{code}` → 202; 409 unless `status = awaiting_user` and
  `needs_code`. The value is trimmed, must be 1–2048 chars, and is never logged or journaled.
- `POST /api/v1/agent-logins/{id}/cancel` → 202.
- Journal: `agent.login.started|succeeded|failed|cancelled` with `{launcher, worker_id, login_id, account_label}`;
  no code, no URL.

### Worker
An `AgentLoginLoop` beside the APM lock loop claims rows for its own worker id (or null), runs one driver, and
writes state back through fenced updates (a lost lease writes nothing):

- **Codex driver:** spawns the bundled `codex app-server` with `CODEX_HOME` from the worker environment, sends
  `initialize`, `initialized`, then `account/login/start {type: chatgptDeviceCode}`; writes
  `verification_url`, `user_code`, `awaiting_user`; waits for `account/login/completed`; on success reads
  `account/read` for the label. Cancel/expiry sends `account/login/cancel`.
- **Antigravity driver:** spawns `antigravity acp --login --disable-telemetry` with the Antigravity home
  (ADR-0086), parses the first `https://accounts.google.com/` URL from stdout, writes it with `needs_code = true`
  and `awaiting_user`; polls the row (1 s) for `submitted_code`, reads-and-clears it in one statement, writes it
  plus `\n` to stdin, sets `verifying`, and maps exit 0 → `succeeded`, non-zero → `failed` with the CLI's last
  stderr/stdout line (codes redacted).
- **Status probe:** Codex `account/read`; Antigravity ACP `initialize` + `session/new` in a scratch dir
  (`Authentication required` → signed_out).

The login child runs outside nono, exactly as the `kubectl exec` it replaces did: it needs write access to the
credential directory and egress to the provider's auth host, and it runs no model or repository content. Moving
it under a nono profile is a follow-up, not a claim made here.

### UI
Settings gains an **Agent accounts** tab (`/settings/accounts`): one row per worker × launcher with the state chip
(Signed in as … / Needs sign-in / Unknown), `checked_at`, and a **Sign in** button. The dialog shows:

- Codex: the link (opens in a new tab), the code in large monospace with a copy button, "Waiting for you to
  approve…", and the note about enabling device code sign-in in ChatGPT settings.
- Antigravity: the link, then a "Paste the code from the page you land on" field and **Submit**.

It polls `GET /agent-logins/{id}` every 2 s until a terminal status, then refreshes the list. Non-admins do not see
the tab.

## Consequences
- No more production shells for agent logins; the state is visible to admins.
- The Antigravity authorization code transits the API once. It is PKCE-bound (useless without the verifier held
  in the worker's child process), single-use, cleared on read, and never logged.
- Credentials stay per worker volume; a second worker needs its own sign-in, which the per-worker rows show.

## Security/privacy
- Org admin only; every start/finish is journaled without codes.
- Tokens are written only by the harness into its own credential directory; nothing here reads them.
- `submitted_code` is never returned by any route and is cleared by the claim that consumes it.

## Verification
- Store: claim/lease/fence, the one-active index, read-and-clear of `submitted_code`.
- API: admin gate, 409s, `submitted_code` never in any response body.
- Worker: drivers against fake `codex`/`antigravity` executables that speak the observed shapes.
- UI: the tab and dialog states (vitest).
- Real: the deployed app signs Codex in through the dialog (screenshots), then a Codex thread completes a turn.

## Migration/rollback
Migration 00035 adds two tables; Down drops them. Rolling back the app leaves credential volumes untouched.
