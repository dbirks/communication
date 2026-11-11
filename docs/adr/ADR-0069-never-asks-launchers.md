# ADR-0069 — never-asks launchers: autonomous_within_sandbox + pi provider-config delivery (P5)

- **Date:** 2026-10-24
- **Status:** Accepted (unit-proven; live pi proof pending a lab rebuild — no PASS claimed here)
- **Owners:** worker/agent runtime maintainers; product owner (the launcher decision)
- **Related decisions / contracts:** ADR-0019 (D6 fail-closed launch), ADR-0036 (claude-only preapproved lab exception), ADR-0039 (policy permission verdicts), ADR-0040/ADR-0059 (credential and API-key delivery channels), ADR-0058 (versioned profiles), `04-agent-runtime.md` "Permission policy", `05-workspaces-security-secrets.md`, migration `00025`, `docs/compatibility/ACP.md` ("Pi"), `docs/compatibility/SANDBOX.md` § "pi launcher in nono (2026-10-24)" rows P1–P5

## Context

The lab and CI agents must run on launcher `pi` against the LLM collective
(Claude needs a personal login runners do not have). Two documented gaps make
pi run **no turn** on the current product:

1. **Prompting mode (P1/P4).** `pi-acp@0.0.34` never routes tool execution
   through `session/request_permission` (its only permission call is the
   extension-UI handler). The worker therefore fail-closes every
   `ask`/`deny`/`preapproved_within_sandbox` profile on launcher pi
   (ADR-0019 D6, `internal/worker/agentturn.go`, `turnloop.go`) — correctly:
   running the adapter's never-asks default under a *prompting* mode would
   journal a review that never happened. Result: pi runs no turn at all.
2. **Provider config (P5).** ADR-0059 documents the per-turn agent-home
   `models.json` (from `COMMUNICATION_PI_BASE_URL` + `COMMUNICATION_PI_MODEL`,
   key via `COMMUNICATION_PI_API_KEY_FILE` → `OPENAI_API_KEY`), but
   `ApiModelsJSON` had zero worker call sites and the per-turn key never
   joined the launch environment: a launched pi would fall back to
   `api.openai.com`, which the egress allowlist denies.

The three recorded modes all *claim review* (a prompt, answered and journalled
by a human or a policy). A launcher that cannot prompt can honestly run under
none of them.

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: run pi under `preapproved_within_sandbox` anyway | no schema change | makes a review claim the launcher cannot keep: zero `conversation.permission.*` rows while the mode's contract (ADR-0036/0039) is journalled verdicts; ADR-0036's exception is claude-only and reverts if "the launcher is not claude" | SANDBOX.md P1/P4: refusal before sandbox verification; verdict list item 1 named exactly this consequence |
| B: new mode `autonomous_within_sandbox` (chosen) | honest label: no review claim at all; legal only beside `sandbox_enforcement=required`; prompting modes stay fail-closed on pi | fourth mode to validate, journal-word and UI-word | this ADR |
| C: wait for upstream `pi-acp` prompting support | ADR-0036 semantics preserved | blocks the operator decision (all lab/CI agents on pi) indefinitely; PRs unknown | ACP.md "Pi": no prompting mode at the pinned version |

## Decision

**A — a fourth permission mode, `autonomous_within_sandbox`:**

* It makes **no review claim**. Nothing is asked, so no prompt and no verdict
  row is produced; the run/thread UI and the journal word it as **"runs
  without asking; the sandbox is the boundary"** — never "approved", never a
  divider implying a reviewer. (Where a prompt *does* arrive anyway — a
  launcher change, a different harness — the mode answers it as policy: the
  durable row gets `decided_by_kind=policy`, `decided_by_policy=autonomous_within_sandbox`,
  an `allow_*` option; the row names the mode as decider, never a person.)
* It is **allowed only with `sandbox_enforcement='required'`** — enforced at
  the write (migration `00025` DB CHECK plus the store's named
  `422 permission_mode_invalid` on the one write path that moves a mode,
  ADR-0058 version restore) and at launch (both worker paths refuse the mode
  on a worker below `required`, before any spawn). As today, nono
  verification must **pass before the child starts** (ADR-0019 D6: no
  fallback branch), so the boundary sentence is checked, not asserted.
* It is the **only mode a never-asks launcher may run under**, and
  `ask`/`deny`/`preapproved_within_sandbox` on launcher pi **stay
  fail-closed**. That refusal is honest and stays — with exactly one carve-out,
  which does not weaken it: ADR-0072 § 12 makes an agent-mail *target's* read-only
  a mount (`workspace_repo` at access `ro`) rather than a prompt, so a mailed
  `ask` turn on a never-asks launcher runs this mode's launch (the never-asks
  default, under `required` enforcement, this ADR's own gate) because it makes no
  review claim to be dishonest about. No other `ask` turn is unlocked: an
  ordinary `ask` conversation on pi is refused as always, and so is a mailed
  turn whose read-only mount a person has already lifted — approval widens the
  filesystem, it does not unlock a mode that claims review.
* Profiles declare it the way ADR-0036 declares preapproved: **not via the
  API** (create still writes the `ask` column default; the mode arrives via
  the seed/GitOps SQL route, e.g. `docs/compatibility/probes/m4/seed*.sh`,
  where `COMMUNICATION_LAB_LAUNCHER=pi` now seeds
  `autonomous_within_sandbox` + `sandbox_enforcement=required`).
  *(Superseded for the create path by "Amendment 2026-11-11" below: an
  organization admin's create of a launcher with no verified prompting mode
  resolves this mode server-side — it is still never a request-body field.)*
* **UI wording (for the UI brief):** profile chip and run/thread transcript —
  `pi · runs without asking · sandboxed`. The transcript must not render a
  permission divider for a mode that produces none, and must not label tool
  calls "approved".

**B — implement ADR-0059's P5 delivery (the launcher must be able to reach
its model once allowed to run):** at turn launch for a launcher whose
provider config is configured (`Launcher.WriteProviderConfig`):

* write the agent-home `models.json` (base URL + model, `apiKey` by
  `$OPENAI_API_KEY` **environment interpolation only** — the key value never
  enters the file) and a `settings.json` pin (`defaultProvider`/`defaultModel`)
  under the launcher's `AgentConfigDir` (`$HOME/.pi/agent`, pi's documented
  agent dir). The pin is load-bearing: measured on this host (pi 1.1.0/1.4.0,
  2026-10-24), pi with only a `models.json` custom provider still resolves its
  startup model to the ambient `openai` provider — with `OPENAI_API_KEY` set
  that is a request to `api.openai.com` (401 observed; egress-denied in
  lab). With the pin, pi connects to the configured base URL (connection
  attempt to the configured host observed). Pre-existing files are merged,
  never clobbered; a non-JSON file is a launch refusal, not an overwrite.
* the key reaches the child through the existing **ADR-0040/0059 channel
  only**: `Launcher.ApiKeyKV()` (per-launch read of
  `COMMUNICATION_PI_API_KEY_FILE`) joins the launch *process environment*
  (nono inherits it into the child), never the argv `env` hop the audit
  journal records verbatim, never a file, never the journal;
* the provider host joins the agent-turn egress allowlist resolution
  (`agentEgressAllow`, ADR-0035): the launcher registry's *operator-configured*
  base-URL host (`COMMUNICATION_PI_BASE_URL`) is operator configuration, the
  same class as `COMMUNICATION_AGENT_EGRESS_ALLOW` itself, so the resolved
  allowlist becomes (operator list or shipped default) ∪ provider hosts —
  pipeline documents and profile rows still cannot touch it, and an explicit
  `open` needs no addition. The conversation path's unit profile now resolves
  the same allowlist as the attempt path (before this change it silently used
  the shipped default only, ignoring the operator env the ADR-0035 text
  assigns to the whole agent-turn kind).

## Amendment 2026-11-11 — the admin who creates a profile IS the operator

Deployed finding: `New profile` with launcher `pi` wrote the `ask` column
default, so the profile existed and could never run — every turn failed closed
with "permission mode ask needs a prompting mode for launcher pi; none is
verified". The "seed/GitOps SQL route" above assumed the person declaring the
mode was never the person pressing a button; in this product they are the same
person, because creating an agent profile already requires the organization's
library role.

So `POST /api/v1/agent-profiles` now resolves the mode for that caller: when the
launcher's registry entry names no verified prompting mode
(`AskModeID == ""`, `internal/agent/acp/launchers.go`), an org admin's create
lands `permission_mode = autonomous_within_sandbox` with
`sandbox_enforcement = required`, frozen as the profile's version 1 (the history
row's note names the resolution). A caller without the role is refused `422`
with the new code `launcher_needs_operator` rather than handed a profile that
can never run; the mode is still not a body member, `ask`/`deny`/
`preapproved_within_sandbox` on a never-asks launcher stay fail-closed at launch,
and the pair rule (autonomous only beside `required`: DB CHECK, store 422,
launch gate) is unchanged and still checked three times. An id the registry does
not carry is not "never asks" — absence is not evidence, and it keeps the `ask`
default. The app says the same thing in the same words: the dialog reads
`autonomous · sandbox: required`, and a profile detail reads
`permission: autonomous (sandbox is the boundary)`.


## Consequences

* pi can run turns in the lab/CI; every other launcher's behaviour is
  unchanged (claude/codex keep ADR-0036's preapproved lab rows; the new mode
  opts in per profile).
* The autonomy is real and visible: an autonomous transcript shows tool calls
  with no human or policy *verdict* rows. That is the mode's honesty, not a
  bug to paper over — the review story is the sandbox + the audit.
* Limitations: the credential axis is no stronger than ADR-0036's (an rw
  harness-credentials grant, allowed hosts carry content); the pi boundary
  itself is **unmeasured** until the rebuilt-lab proof (SANDBOX.md P1–P5).
* Backwards-compatible: additive enum, additive migration; no row can carry
  the mode before the migration, so no rewrite is needed.

## Security/privacy

Trust boundary = nono, verified before launch (`required` only; fail-closed,
no fallback — ADR-0019 D6). The mode must never be reachable on
`permissive-dev`/`disabled` workers, at the write (DB CHECK + store 422) and
at the launch (both worker paths). The API keeps refusing to write any
permission mode. Fail-closed everywhere: unknown mode → refusal; the mode
below required enforcement → refusal before spawn; provider config file
unparseable → refusal. Secrets: the key value rides process environment only
(ADR-0040); `models.json` references it by `$OPENAI_API_KEY`; errors name the
file and the fault, never the value. The egress allowlist remains
worker-operator-owned (ADR-0035); adding the operator's own provider host is
a union of two operator facts, not a widening by anything a project edits.

## Verification

* Unit: mode validation (`checkAgentProfilePermissionMode` + migration CHECK
  test on real PostgreSQL), launch gating (`internal/worker`: pi +
  autonomous launches under required; pi + `ask`/`deny`/`preapproved` still
  refuse; autonomous on a non-required worker refuses with the sandbox named),
  provider config (`internal/agent/acp`: rendered `models.json` carries base
  URL + model and **no key value**; settings pin written; merge rules), egress
  (provider host appears in the resolved allowlist; `open` unchanged).
* Unit (2026-11-11 amendment): `internal/api`'s `TestCreateAgentProfileNeverAsksLauncher`
  (admin pi create resolves the pair; a member gets `launcher_needs_operator`; a
  prompting launcher and an unregistered id keep `ask`; a body naming
  `permission_mode` is still a 400) and the real-Postgres
  `TestAgentProfileCreateWritesResolvedLaunchAxes` (the pair + mode grammar at the
  store, the version-1 snapshot + note and the `agent.profile.created` payload naming
  the mode, a non-admin caller refused in the store itself, "" axes meaning the
  defaults); UI: `suggestProfileName`, `permissionModeLabel`, the dialog's
  autonomous copy, the whitespace-only agent block and the no-answer end line
  (vitest).
* Host observation (2026-10-24, this machine, pi 1.4.0): models.json alone →
  `pi -p hi` reached `api.openai.com` (401); with the settings pin →
  "Connection error" against the configured (unreachable) host. Source of the
  "pin is load-bearing" claim.
* **Not yet run (blocking the PASS rows):** the live lab proof — rebuild with
  `LAUNCHER=pi`, `seed-pi.sh`, `pi-proof.sh` (SANDBOX.md P1–P5 may flip only
  on literal journal rows). ACP.md/SANDBOX.md record these cells as
  *implemented, live proof pending* — not PASS.

## Migration/rollback

Apply migration `00025` (additive CHECK changes). Rollback: Down restores the
three-mode CHECK (it fails while a profile carries the new mode, which is the
honest refusal rather than a silent row delete); lab profiles revert by
re-running `seed.sh`/`seed-github-loop.sh` without `COMMUNICATION_LAB_LAUNCHER=pi`
(their read-back rows then print the claude/preapproved shape again). No API
route ever wrote a mode, so no client breaks either way.
