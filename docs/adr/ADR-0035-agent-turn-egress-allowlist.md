# ADR-0035 — Agent-turn egress is a domain allowlist in the profile; the network axis becomes tri-state

- **Date:** 2026-10-18
- **Status:** **Accepted** for the mechanism (profile schema, argv, reporting rule, config
  ownership). **Provisional** for the host list itself — `api.anthropic.com` is the shipped default
  until the live lab turn in `docs/design/agent-egress.md` ("Lab test that flips row 8") proves the
  set a real `claude-agent-acp` turn needs. This record amends **ADR-0019 D3**; it does not restate
  D1, D2, D4, D5 or D6.
- **Owners:** worker runtime and sandbox adapter maintainers; the lab operator who runs the turn
- **Related decisions / contracts:** D-021 (**Provisional** — this record gives it an implementation,
  not an acceptance), D-025 (**Open**, trust model), ADR-0019 D3 (network as an axis), ADR-0009
  (verify-then-run), ADR-0033 (how a `profileVersion` bump is justified), `docs/design/agent-egress.md`
  (the measurements this decision is made on), `communication-spec/05-workspaces-security-secrets.md`
  § "Sandbox backend", `docs/compatibility/SANDBOX.md` row 8, `docs/m3-contract.md` D5, M4 contract § 0.

## Context

ADR-0019 D3 shipped the network axis with two values because only two mechanisms were proven: the
`agent-turn` profile (network **open**, `network_enforced: false` — "the harness cannot answer without
its model API") and the `agent-turn-egress-denied` / `communication-command` profiles (`--block-net`,
proving case 13's observed denial). Its own text left the door open: "If the proxy spike succeeds
(`--allow-domain` … denial *and* allowance both observed from inside a real ACP turn), `agent-turn` may
move to allowlisted egress and this section gets amended. Until then D-021 stays Provisional and no run
may claim enforced egress control."

The spike has been run (`docs/design/agent-egress.md`, 2026-10-16, measured inside
`communication-worker:dev` on `nono 0.80.0`). What it found is that nono is not an on/off switch:

* nono 0.80 ships a domain-allowlist **proxy** (`--allow-domain`, `--deny-domain`, `nono proxy`, and a
  `NetworkConfig` schema member with `block`, `allow_domain`, `deny_domain`, …).
* A profile carrying `"network": {"allow_domain": ["example.com","api.anthropic.com"]}` holds the
  filesystem axis and filters egress in the same sandboxed child:
  `NET https://example.com http=200`, `NET https://example.org ERR Request was cancelled.`,
  `NET anthropic http=405` (a GET on the real `/v1/messages`).
* It is proxy **and** kernel: under an allowlist, `net.connect(443,"93.184.216.34")` → `EACCES` and
  `dns.lookup("example.com")` → `EAI_AGAIN`. Hostname entries are CONNECT tunnels — real upstream
  certificate, ALPN h2, **no generated CA** — and `CONNECT example.org:443` → `HTTP/1.1 403 Forbidden:
  host example.org:443 is not in the allowlist`. Only URL/glob entries switch on TLS interception.
* It fails closed and it is auditable: `--block-net` + an allowlist aborts at nono's own parser
  ("contradictory: domain filtering requires proxy mode"); `nono audit show <id> --json` journals
  `network_events` with `{"decision":"deny","denial_category":"host_denied","target":"example.org",…}`
  while `--diagnostics-json` reports `denials: []` for the same run — so the audit journal, not
  diagnostics, is the evidence surface.
* **Not measured:** a real `claude-agent-acp` turn under an allowlist. No harness credentials exist in
  a throwaway container, so whether `api.anthropic.com` alone is the whole set a turn needs is unknown.

`NetworkEnforced bool` cannot name the middle state: a bool says "everything blocked" or "nothing
blocked", and neither is true of an allowlist. That is the schema change this ADR makes.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A — **allowlist in the Communication profile** (selected) | One boundary per launched tree, argv shape unchanged, the host set is inside the policy digest, N-a…N-d still describe the whole launch, per-run audit | The host list is a product decision (D-025) and a missing host degrades a turn silently | `agent-egress.md` "Measured facts" + "Designs A"; the CLI/profile equivalence and the deny-precedence rows |
| B — worker-owned `nono proxy` sidecar, agent gets `--block-net --open-port <proxy>` | One policy across turns, denials in one log, works for launchers nono cannot wrap | A supervised long-lived process, port+token handoff, a `--no-auth`/`--pass` decision, and every client proxy convention (`git`, `npm`) becomes ours; the child no longer *is* the sandbox | `agent-egress.md` B (measured: `SIDECAR-ALLOW http=200`, `SIDECAR-DENY ERR`, `SIDECAR-BYPASS ERR EACCES`) |
| C — allowlist travels with the AgentProfileRevision (`…-egress-model-only` vs `…-egress-model-plus-packages`) | Enforcement identical; per-profile policy | Profile proliferation plus a host-list admin surface, for a second host set nobody has asked for yet | `agent-egress.md` C |
| D — leave the agent profile open and keep `network_enforced: false` forever | Zero risk of a silently degraded turn | Row 8 stays FAIL, D-021 can never move, and `preapproved_within_sandbox` stays refused on the exfiltration argument (SANDBOX.md's own recommendation) | `docs/compatibility/SANDBOX.md` § "Recommendation" |

## Decision

Option **A**, with design A's reporting rule as the part that keeps the claim honest.

### 1. The agent profile gains a `network.allow_domain` member

`profileSource` (`internal/sandbox/nono/profile.go`) grows an optional `network` object
(`profileNetwork`: `allow_domain`, `deny_domain`; a pointer, so "absent" is representable and stays the
byte shape every pre-ADR-0035 digest had). Only the **agent** kind may carry it:

| Kind | `network` member | argv | tri-state |
|---|---|---|---|
| `communication-agent` | `{"allow_domain": [<hosts>]}` | unchanged — no new flag | `allowlisted` |
| `communication-agent` authored with `open` | absent | unchanged | `open` |
| `communication-agent-egress-denied` | refused at authoring | `--block-net` | `denied` |
| `communication-command` | **refused at authoring** | `--block-net`, unchanged | `denied` |

`profileVersion` 3.3.0 → **3.4.0**, so a recorded `policy_digest` identifies a host set and not just a
filename (`worker/sandbox/profiles/communication-command.json` is regenerated and changes only in that
version string — its egress mechanism is untouched, and case 13's denial row still rests on it).

`block` is never authored: `--block-net` plus `allow_domain` is the contradiction nono's own parser
aborts on, so it cannot appear in a Communication file, and `launchplan.go` refuses the pairing before
a kernel is ever asked (`--block-net` under an allowlisted profile, or a denied profile launched without
the flag, are both errors today, as before). URL/glob entries are refused by `NormalizeEgressHosts`: a
path glob silently opts into nono's generated intercept CA (`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`),
which is a different claim from a hostname tunnel.

### 2. `NetworkEnforced` becomes the tri-state `open | allowlisted | denied`

It is a property of the profile bytes and therefore of the digest. `Profile.NetworkEnforced`,
`nono.VerificationResult.NetworkEnforced` and `acp.Verification.NetworkEnforcement` carry it;
`acp.Verification.NetworkClaim` carries the run-level string. `sandbox.verified` keeps
`network_enforced` (a bool, unchanged meaning: egress control actually observed for this run) and gains
`network`: `"open"` | `"denied"` | `"allowlisted:<comma-separated hosts>"`. An absent `network` on an
older journal row means "written before ADR-0035", never "enforced".

### 3. A run says `allowlisted` only on its own evidence

`VerificationResult.EgressReport()` is the only path from a chain to those two fields:

* profile `denied` → `("denied", true)` — the flag is in the argv we recorded;
* profile `allowlisted` **and this run's** `nono audit show <id> --json` recorded a `deny` network
  event → `("allowlisted:<hosts>", true)`;
* profile `allowlisted` with no observed denial → `("open", false)`.

The third row is the decision, not a detail. A host set that no connection ever tested proves nothing
about the process that carried it, so an unexercised allowlist reports exactly what it reported before
this ADR: not enforced. Nothing in configuration flips it — there is no `network=allowlisted` setting,
and `EgressDenials` is never populated by `Verify` (there is no child to have been denied yet). The
lab's row 8b is what produces the first true value.

### 4. The host list is worker operator configuration, never pipeline data

`COMMUNICATION_AGENT_EGRESS_ALLOW` (comma-separated, `internal/worker/egress.go`, documented in
`communication worker`'s usage text) is the only input; `AgentTurn.EgressAllow` is its in-process form.
An unset variable means the shipped default; the words `open|none|off|unrestricted` mean the
ADR-0019 D3 open shape; an empty-but-set value, a scheme, a path, a port or a space is a startup-time
refusal of that *attempt* rather than a silently narrower or wider policy. A pipeline document, an
agent profile row and a node config have no path to this value — the agent must not choose which hosts
it may talk to (`05`: the worker owns the sandbox; ADR-0030's "staging is not isolation").

**Shipped default: `api.anthropic.com` — provisional.** It is the only host this project has measured a
real request against (`https://api.anthropic.com/v1/messages` → `405`, the live API answering a GET).
Claude Code's actual dependency set is unproven, and a missing host degrades a turn *silently* (the
agent sees a proxy refusal and may narrate it as its own failure), so the first live lab turn is
authoritative and this line changes with its evidence.

## Consequences

* Positive: egress becomes a *labelled axis with three values* instead of a bool that could only lie in
  one direction. `docs/m3-contract.md` D5's reason for two profiles ("domain allowlisting is a userland
  MITM proxy never proven end-to-end") is now half-retired: it is a CONNECT-tunnel proxy needing no CA,
  measured — and the profile it lands in is the same file N-b/N-c/N-d already assert.
* Positive: `sandbox.verified` can eventually answer "what could this turn reach?" from the journal alone,
  because the answer is a digest-committed host list plus an event, not a flag someone might have passed.
* Cost: `profileVersion` 3.4.0 changes every agent-turn policy digest, so old digests in `domain_events`
  and in `GET /api/v1/turns/{id}/sandbox` rows describe 3.3.0 and stay what they are. The
  **deployment-pinned** digest reported by `GET /api/v1/system/sandbox` (`pinnedPolicy()` in
  `cmd/communication/m3env.go`) is the *shipped default* list's digest; a worker configured with a
  different `COMMUNICATION_AGENT_EGRESS_ALLOW` legitimately registers under a different digest, which is
  the field's purpose and not a drift alarm.
* Cost: a host that is not on the list breaks a real turn. That is the shape of the risk D-021 has always
  had, now with a diagnosable surface (`403 … is not in the allowlist` in the transcript, a `deny`
  network event in the audit) instead of a hang.
* Cost: `pinned_within_sandbox` (SANDBOX.md's § "Recommendation") is still refused — this ADR closes
  condition (b)'s *mechanism*, not its *evidence*, and its auditability condition (a) is untouched.
* No migration: no table, no route, no UI. `network_enforced` keeps its type and meaning, so the UI's ops
  page and the API's `TurnSandboxView` are unchanged by construction; `network` is additive and the
  OpenAPI event table row is updated in the same commit as the payload struct (the field-name test that
  compares them is `TestM2PayloadFieldsMatchOpenAPITable`).

## Security/privacy

* The boundary moves from "an agent can reach any host" to "an agent can reach the hosts this worker's
  operator listed" — per-turn, in the same Landlock tree, with the proxy and the kernel both refusing
  anything else (measured: `EACCES` on a raw connect, `EAI_AGAIN` on a lookup, `403` on a denied CONNECT).
  It is a *host* boundary, not a content or destination-integrity boundary: an allowed host is allowed,
  and everything readable inside the grants still leaves over it. It does not weaken ADR-0019 D4's
  standing warning — the rw `harness_credentials` grant is still shared and this record is still not
  evidence of credential isolation.
* Fail-closed everywhere it can be: no `network` member and no `--block-net` means the claim is `open`;
  an allowlist that resolves to zero hosts cannot be authored; a profile claiming `allowlisted` whose
  file does not carry exactly that list fails `AssertOwnBytes` before nono is asked anything; a probe that
  does not observe TCP rule support refuses an allowlisted launch (without that backstop the proxy is a
  suggestion, not a boundary).
* The allowlist is not secret and never contains one — it is a list of hostnames inside a 0444 policy
  file that is world-readable by design; what is secret stays in the harness credential tree and the
  materialized secret files (ADR-0018).

## Verification

Unit, this commit (`go test ./internal/sandbox/... ./internal/worker/`):

* `TestAgentProfileAuthorsTheEgressAllowlist` — the file carries `allow_domain`, no `block`, and passes
  the adapter's own byte assertions.
* `TestAllowlistChangesTheDigest` — four policies (open, host A, host B, A+C) get four digests.
* `TestProfileBuilderRefusesUnreadableEgressPolicies` — empty allowlist, an allowlist on the command kind,
  `--block-net` with hosts, a URL/glob entry, a sneaked separator, `open` on a denied kind, unknown kind.
* `TestAllowlistedAgentTurnLaunchesWithoutBlockNet` — argv is unchanged (no `--block-net`,
  `--allow-domain`, `--proxy-port`, `--sandbox-policy`, `--allow-cwd`), and both contradiction directions
  are refused.
* `TestEgressReportNeedsAnObservedDenial` — the reporting rule, including a nil chain.
* `TestAuditEgressDenialsReadsTheMeasuredShape` — the parser is pinned to the recorded audit JSON; empty
  or truncated audit output is an error, never "no denials".
* worker: `TestParseEgressAllow`, `TestAgentTurnProfileCarriesTheWorkersAllowlist`,
  `TestAgentTurnProfileFallsBackToTheEnvironment` (including the bad-value refusal), and
  `TestVerifiedPayloadOnlyClaimsAllowlistedWithAnObservedDenial`, which asserts the same profile and
  digest journalling `"open"/false` in one run and `"allowlisted:api.anthropic.com"/true` in another.
* `TestAgentTurnRequiredUsesTheAgentTurnProfile` (existing) still asserts an agent turn is never launched
  with `--block-net`; `TestCommandProfileCarriesTheEgressClaim` still asserts the command kind's `denied`.

Mechanism observed on the developer host with the real backend (`nono 0.80.0`,
`WriteProfileNetwork("/tmp/egress-probe", ProfileAgentTurn, NetworkAllowlisted, ["example.com"])` and the
shipped default profile), launching `node` through the same argv the worker builds:

```
$ HOME=/tmp/egress-lhome nono run -s -p /tmp/egress-probe/communication-agent.json \
    --allow /tmp/egress-work -- env HOME=/tmp/egress-work node --input-type=module -e '<fetch loop>'
NET https://example.com http=200
NET https://example.org ERR TypeError: fetch failed
NET https://api.anthropic.com/v1/messages ERR TypeError: fetch failed
# with the shipped default list instead:
NET https://api.anthropic.com/v1/messages http=405
NET https://example.com ERR TypeError: fetch failed
```

so the file the builder writes is the file nono honours, on both sides of the list. This is **not** a
lab row: it is not the worker container, not `required` mode's full chain, not a `claude-agent-acp`
turn, and `nono audit show` was never consulted, so the `allowlisted` label stayed unreported by design.

**Not verified — and nothing above may be read as verified until it is** (`docs/compatibility/SANDBOX.md`
row 8, `docs/design/agent-egress.md` "Lab test that flips row 8"): the live
`communication-m4-worker-a-1` re-run — 8a `fetch('https://api.anthropic.com/v1/messages')` → `http=405`,
8b `fetch('https://example.com')` → a `{"decision":"deny","denial_category":"host_denied"}` line in that
run's own audit, a completing `claude-agent-acp` turn on the shipped list, and a
`sandbox.verified`/`network: "allowlisted:…"` pair produced by a real process. Until then D-021 stays
**Provisional** and the mechanism's own rows say "live rows pending".

## Migration/rollback

Reverting this ADR means deleting the `network` member from `profileBody` and the tri-state (the digests
return to 3.3.0's shape); nothing else moves. Operationally, `COMMUNICATION_AGENT_EGRESS_ALLOW=open`
restores ADR-0019 D3's exact behaviour on one worker without a rebuild — the open profile is still
authorable, still asserted, and still reports `network_enforced: false`. Widening the list is a worker
restart (the profile file is re-written and re-digested per process); it is never a pipeline edit, and
per-launcher or per-profile host sets (design B, design C) need a further ADR.
