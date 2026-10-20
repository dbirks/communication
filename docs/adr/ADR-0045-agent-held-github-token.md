# ADR-0045 — Agents may hold a GitHub token in the sandbox; the Publish step is left out of the Studio step picker

- **Date:** 2026-10-20
- **Status:** Accepted (product owner decision, 2026-10-20)
- **Owners:** agent-runtime / sandbox maintainer
- **Related decisions / contracts:**
  `communication-spec/05-workspaces-security-secrets.md:19,45,66,68–70` (amended — one-line
  "Amended by ADR-0045" notes added in place), ADR-0018 (SecretRef scoped materialization and
  envelope encryption), ADR-0035 (agent-turn egress allowlist; `COMMUNICATION_AGENT_EGRESS_ALLOW`,
  shipped default `api.anthropic.com`), ADR-0040 (secret delivery must not leak through nono's
  verbatim argv audit — file/env materialization, never `-- env NAME=value` argv), ADR-0031
  (GitHub integration is read-only issue listing; no token in the sandbox today), design handoff
  `docs/design/handoff-app-shell/gaps/library.md` §4.1 (step picker) and `gaps/profiles.md`
  §4.1 (GitHub-token conflict note).

## Context

Product direction (app-shell + IA redesign, "Six Directions"): an agent that implements a change
should be able to push the branch and open a draft PR itself, using its own account attached to
its agent profile — the human then reviews the PR, as in the redesign's profile/thread flows
(`gaps/profiles.md` §1–2, "ACCOUNT … (value never shown · long-lived token)"). The Studio step
picker's "Publish" kind (`git.publish`, currently shown as "not runnable yet: M6",
`ui/src/lib/pipeline/graphDoc.ts:153-155`) is dropped from the picker for now; it may return
later as an optional step.

Spec 05 currently constrains this in four places:

- **`05-workspaces-security-secrets.md:19`** — "Do not automatically push/merge changes."
- **`05-workspaces-security-secrets.md:45`** — classifies "GitHub Apps/PATs/SSH deploy keys" as
  *project/organization integration credentials* (concept 2), not harness authentication.
- **`05-workspaces-security-secrets.md:66`** — "For third-party credentials prefer a restricted
  broker/token over long-lived raw secrets where feasible."
- **`05-workspaces-security-secrets.md:68-70`** — "Configure separate commands/nodes for commit,
  push, draft PR, human review and merge … External publication operations need idempotent
  tokens and post-crash reconciliation."

The gap analyses flagged exactly this as the one GitHub-token decision needing an ADR
(`gaps/profiles.md` §4.1; `gaps/threads.md` §4.1), because handing a token to the agent's
sandbox is a long-lived raw secret in the agent's reach (amending :66), and because pushing/PRs
from the sandbox is precisely "automatically push/merge changes" (amending :19) and collapses
the separate publish-node pipeline (amending :68-70).

Constraints that already hold and this ADR does not touch:

- **SecretRef plumbing is unchanged** (spec 05:48): `scope`, `allowed_agent_profiles`,
  `delivery_mode (env|file|integration_broker)`, `audit_policy`, encrypted at rest, no
  view-raw-secret endpoint, values never logged (ADR-0018). A GitHub token attached to an
  agent profile is an existing secret row whose `allowed_agent_profile_ids` names that profile.
- **Egress is allowlisted per profile** (ADR-0035): the sandboxed turn can only reach domains in
  `network.allow_domain`; the shipped allowlist is `api.anthropic.com` only, so push does not
  work until the operator adds the GitHub hosts — a deliberate, visible gate.
- **Delivery must avoid the argv journal** (ADR-0040): nono records child argv verbatim, so the
  token is materialized as env/file through the existing scoped materialization path, never
  through an argv hop.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Agent-held GitHub token in the sandbox, push/PR by the agent; Publish left out of the picker | Matches the redesigned flows (profile ACCOUNT "add a token", "open a draft PR from this branch"); no new publish machinery; review stays a normal GitHub PR; least-privilege fine-grained tokens per profile/repo | Long-lived raw secret reachable by the agent (amends :66); requires operator to widen the egress allowlist; agent can push to any ref the token allows | Product decision; ADR-0018/0035/0040 supply the safeguards; `gaps/profiles.md` §4.1 |
| B. Keep platform-side `git.publish` node as the only push path; no token in sandbox | No raw secret in the agent's reach; publish is a discrete, idempotent, reconciled platform operation (:68-70) | `git.publish` is not runnable yet (M6); redesign explicitly drops it from the picker; agent cannot iterate on its own PR (force-push fixes, replies-as-commits, branch updates) | `graphDoc.ts:153-155` "not runnable yet: M6"; `gaps/library.md` §4.1 |
| C. GitHub App / integration broker that signs on the agent's behalf (no token visible to the agent) | Closest to the :66 "restricted broker" ideal; strongest secrecy | No GitHub App integration exists (ADR-0031 is read-only, anonymous); broker is an entirely new surface with webhook/reconciliation cost; blocks the redesign's "add a token" flow now | ADR-0031; spec 05:45 concept 2 |

## Decision

**Option A, as a product decision.** An agent may hold a GitHub token inside the sandbox, via a
secret attached to its agent profile (SecretRef `allowed_agent_profiles` naming that profile),
and use it to push branches and open/update draft PRs from within a run. This ADR amends the
four spec-05 statements quoted above:

1. **:19 ("Do not automatically push/merge changes")** — pushing a *work branch* and opening a
   *draft* PR from an agent turn is allowed when the agent's profile is authorized for such a
   GitHub token. **Merging is not "publishing a workspace result" here and stays human** (see
   "What is not decided"). "Automatically" still means: no merge, no push to protected/main
   refs without the human's own action — enforced by the token's scopes, not the platform.
2. **:45 (credential concepts)** — a GitHub token used by an agent is still concept 2
   (integration credential); it is delivered to the agent only because the owner *authorized
   that agent profile* for it. No new credential concept is introduced.
3. **:66 (prefer restricted broker/token)** — accepted as a deviation, justified by: (a) a
   fine-grained GitHub token scoped to one repo and `contents:write` / `pull_requests:write`
   only *is* the restricted-token form; (b) delivery is scoped materialization (below), never a
   platform-wide env; (c) the egress allowlist is the second gate; (d) a GitHub App broker
   (option C) is the intended later replacement and this decision does not preclude it.
4. **:68-70 (separate publish nodes, idempotent tokens, reconciliation)** — the platform-side
   `git.publish` node **stays in the node catalogue** (YAML authors can still publish revisions
   containing it; it remains "not runnable yet: M6"). What changes is the Studio **step picker**,
   which no longer offers the Publish kind (`git.publish` / `artifact.publish`) for new authoring.
   Agent-driven push/PR does not need idempotency keys or post-crash reconciliation: the git
   protocol is its own reconciliation (push is idempotent per ref+commit; PR creation is
   idempotent per head ref), and a crashed attempt simply leaves the pushed branch in place for
   the retried attempt.

**Safeguards that remain (binding):**

- **Scoped materialization only.** The token is materialized only into the sandbox of an agent
  whose profile is in the secret's `allowed_agent_profiles`, only for the duration of that
  node attempt, through the existing scoped-materialization path (ADR-0018; spec 05:48
  `delivery_mode`, lifecycle "remove at attempt completion"). No platform-wide environment
  variable, no worker-level copy.
- **Never logged, never shown.** The value never appears in logs, journal entries, events,
  transcripts or the UI — the UI shows only the secret's reference ("value never shown"),
  matching the existing secrets API (spec 05:48 "Avoid UI view-raw-secret endpoint and never
  log secrets"; ADR-0018 D4; ADR-0040's argv rule applies to delivery too).
- **Egress allowlist is a gate, not a formality.** Push/PR only work once the operator adds the
  GitHub hosts (`github.com`, `api.github.com`) to the profile's `network.allow_domain` via
  `COMMUNICATION_AGENT_EGRESS_ALLOW` (ADR-0035). Until then the agent holds a token it cannot
  use for push, and the sandbox's `NetworkEnforced` tri-state reports the state honestly.
- **Least privilege recommended (documented, enforced by GitHub).** Fine-grained (repository
  access) tokens, scoped to the specific repo, with `contents:write` + `pull_requests:write`
  and no admin/org scopes. Platform cannot enforce GitHub-side scopes; the documentation and
  the profile UI note state the minimum required.
- **Revocation and rotation.** Owner revokes/rotates through the existing secret versioning
  endpoints; materialization re-reads at each attempt ("rotate/revoke and rematerialize on
  retry", spec 05:64), so a revoked value stops working from the next attempt onward. Every
  materialization is audit-journaled with the existing `audit_policy`.
- **Sandbox boundary unchanged.** The token sits in the same nono `required`-mode sandbox as
  everything else (ADR-0003/0019); the trust caveat — nono is not a tenant boundary — applies,
  and a token leaked by one agent's attempt must be treatable as compromised (rotation is the
  recovery).

## What is NOT decided

- **Merging stays human.** An agent's token must not be granted merge rights; a merged commit
  on a shared branch remains a deliberate human act (or a later, separately-ADR'd merge
  queue). Draft PRs only is the guidance, not the platform rule — the rule is "no merge scope
  on the token".
- **GitHub App broker (option C)** — open as the later replacement for the raw token; this
  decision precludes nothing.
- **Whether the assistant may propose `git.publish` nodes** (library gap §8.4) — the ADR only
  governs the picker; YAML and assistant proposals are a separate decision.
- **GitHub PR *creation* via the platform API** (i.e. a run-level "open PR" action without the
  agent) — not in scope; today the agent does it with its own `gh`/API calls in the sandbox.
- **Threads "open a draft PR from this branch"** (threads gap §3) — depends on the same token
  path but its run/thread wiring (base override, link fields) is its own ADR.

## Consequences

- Positive: the redesigned agent flows (push, draft PR, iterate) work with only existing
  machinery (SecretRef, scoped materialization, egress allowlist); no new API surface, no new
  table, no migration. The step picker can honestly drop Publish without a catalogue change.
- Limitations: a raw long-lived secret is reachable by the agent for the life of an attempt —
  the threat model at spec 05:66 applies ("Treat redaction as a defense-in-depth best effort,
  not absolute secrecy after an agent has seen a value"); exfiltration is bounded by the egress
  allowlist, not by file permissions.
- Operational: operators enabling this must (1) create the fine-grained token, (2) attach it
  to the profile via the secret's `allowed_agent_profile_ids`, (3) widen
  `COMMUNICATION_AGENT_EGRESS_ALLOW` — three explicit, separately-observable steps.
- Compatibility: none. Existing read-only GitHub integration (ADR-0031) is untouched; existing
  published revisions with `git.publish` nodes are untouched (they stay unrunnable until M6).

## Verification

- `grep -n "ADR-0045" communication-spec/05-workspaces-security-secrets.md docs/adr/README.md`
  shows the amendment notes at spec lines 19, 45, 66, 68-70 and the index entry.
- The picker change (hiding `git.publish`/`artifact.publish`) and any live push turn are
  separate units of work and are verified there (live lab: push + draft PR under a
  `github.com`/`api.github.com` allowlist, token value absent from all logs/journal/UI), not by
  this document.
