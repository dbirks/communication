# ADR-0015 — ACP Go SDK: `github.com/coder/acp-go-sdk` v0.13.5 behind `internal/agent/acp`

- **Date:** 2026-10-14
- **Status:** Accepted (closes the SDK-selection half of D-016; protocol-version support stays limited to what has been observed)
- **Owners:** M0/M2 agent-runtime implementers
- **Related decisions / contracts:** D-006 (ACP primary coding-agent protocol, adapters), D-016 (ACP Go SDK choice / supported protocol versions — *Spike required*), `communication-spec/04-agent-runtime.md` ("Go library adoption", "Permission policy"), `communication-spec/12-test-strategy.md` (compatibility matrix must never be prefilled), `communication-spec/IMPLEMENTATION_AGENT_BRIEF.md` rule 2, `docs/compatibility/ACP.md`, ADR-0007 (layout), ADR-0013 (events)

## Context

D-006 makes ACP the control protocol for coding agents, and `04-agent-runtime.md` "Go library adoption" already states the preference: "Candidate: `github.com/coder/acp-go-sdk` for typed Go ACP, but evaluate current schema version alignment, streaming cancellation, and helper lifecycle in `M0 ACP compatibility spike`; avoid committing to specific library APIs in persisted domain schemas. Prefer SDK over reimplementing JSON-RPC and maintain an `AgentRuntime` interface." IMPLEMENTATION_AGENT_BRIEF rule 2 repeats it: "Build SDK adapters, do not reimplement ACP/APM protocols where a tested SDK exists."

D-016 kept the selection *Spike required* because a green unit test says nothing about whether a Go SDK can speak to real adapters. M0 produced two evidence artefacts: the raw stdlib-only probe and baseline matrix `docs/compatibility/ACP.md` (Claude Code adapter `@agentclientprotocol/claude-agent-acp@0.90.0`, Codex adapter `@agentclientprotocol/codex-acp@2.2.2`, both negotiating `protocolVersion: 1`), and the Go adapter `internal/agent/acp/` that must reproduce that behaviour message-for-message.

Constraints on the decision: AGENTS.md forbids SDK types in `internal/domain` (adapters depend on interfaces, never the reverse); the worker, not the API, owns agent stdio processes (ADR-0001); and `communication doctor --acp <id>` plus the tagged integration test are the recurring proof surface for M2's conversation work.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **`github.com/coder/acp-go-sdk v0.13.5` (chosen)** | Typed v1 ACP for both sides of the connection; generated from the protocol schema; **zero transitive modules** (its `go.mod` declares no requires and its packages import only stdlib) so the CI license/dependency gate sees nothing new; survived a real `claude-agent-acp@0.90.0` round trip including tool calls, permission and cancel | Generated types freeze our wire shape to whatever protocol revision the SDK was generated from; unstable/experimental methods arrive as `Unstable*` Go methods we must choose to expose; upstream release cadence is outside our control | `go mod graph` shows only `github.com/coder/acp-go-sdk@v0.13.5 go@1.21`; live check below; `docs/compatibility/ACP.md` |
| Reimplement JSON-RPC 2.0 + ACP types by hand (the Python probe's approach in Go) | Complete control over wire behaviour (e.g. strict discriminator-only parsing, exact ordering); no upstream dependency at all | Rejected: `04` says "Prefer SDK over reimplementing JSON-RPC" and rule 2 forbids reimplementing a protocol where a tested SDK exists; a hand-rolled stack is permanently-maintained protocol surface with no second user to catch mistakes | Compared; the probe stays as the *checker*, not the product path |
| Another Go ACP SDK | — | **None evaluated.** No second Go SDK was surveyed or tested for this ADR; that gap is recorded here rather than dressed up as a comparison | Gap acknowledged; D-016's "supported protocol versions" follow-up should revisit it only if v0.13.5 blocks us |
| Shell out to an existing TypeScript ACP client library | Mature upstream implementation | Rejected: adds a Node runtime to the worker, a second process boundary to supervise, and no typed Go surface for `domain` mapping | Compared; contradicts D-002's single Go binary ownership model |

## Decision

1. **Pin `github.com/coder/acp-go-sdk v0.13.5`** (checksum in `go.sum`) as the ACP wire library, used **only** from `internal/agent/acp/`.
2. The adapter implements the SDK-free `domain.AgentRuntime` / `domain.AgentHandle` contracts: `Start`, `Prompt`, `Cancel`, `Close`, `Events() <-chan domain.ConversationEvent`. No `acp.*` type crosses that boundary; `internal/domain` and `internal/pipelines/runtime` cannot see the SDK.
3. **Protocol v1 only.** Both observed adapters negotiated `protocolVersion: 1` (`docs/compatibility/ACP.md`); the adapter records the negotiated version and no v2 path is exercised. A future v2 (or SDK major bump) is gated behind an explicit flag and a compatibility-matrix row with observed evidence, not enabled by an upgrade.
4. Client posture is deliberately minimal: `initialize` offers **no** filesystem or terminal services (`Fs` read/write and `Terminal` false), so agent-side `fs/*` and `terminal/*` requests are answered `method-not-found` rather than silently served. `session/new` includes `additionalDirectories` **only** when the agent advertised the capability.
5. Permission requests are mapped through the adapter's policy (`deny` default → `reject_once`, falling back to `reject_always`, cancelling when no reject option exists; `preapproved` → `allow_once`), keyed on option **`kind`**, never on `optionId` — the Codex adapter's reject option is literally id `cancel`.
6. Unknown `sessionUpdate` kinds map to `Kind: "unknown"` opaque conversation events; never fatal.
7. Long-lived agent processes stay in the worker; `communication doctor --acp claude|codex` remains the one-command live check, and `internal/agent/acp/integration_test.go` (build tag `acp_integration`, executable selected via `COMMUNICATION_ACP_CLAUDE`) is the CI-reachable version of the same round trip.

## Consequences

Positive: typed messages, both connection sides available for the fake-agent tests, no new transitive dependency, and a live round trip that matches the raw-probe baseline.

Observed differences between the SDK path and the raw probe (all of them are adapter responsibilities, not free passes):

- **`false` capabilities are omitted, not sent.** The generated capability structs use `omitempty` on bools (e.g. `terminal,omitempty`), so a `false` disappears from the JSON instead of being sent explicitly. An agent that infers support from key presence rather than value would mis-read us; our own behaviour depends on absent meaning false.
- **Unknown `sessionUpdate` kinds fall back to field-shape matching.** `SessionUpdate.UnmarshalJSON` dispatches on the `sessionUpdate` discriminator, and its generated branches also accept payloads lacking a discriminator by matching field shape — so an *unknown* update that happens to carry `toolCallId` can be typed as a `tool_call`/`tool_call_update`. Our adapter cannot distinguish that case, which is why unknown kinds are surfaced as `unknown` **and** why tool-call ids from unknown shapes must never be trusted for correlation.
- **Responses are ordered after prior notifications.** The SDK serializes an answered request behind notifications already queued on the same connection, so a response can arrive after updates that were emitted during the call — ordering-sensitive UI code must key on `global_seq`/event order, not on call return.
- **`additionalDirectories` is capability-gated**, so an agent that needs extra dirs but does not advertise them silently does not receive them (unit-tested both ways).
- **Zero transitive modules** keeps the `go-licenses` gate and the SBOM unchanged.
- Cancel reliability is a *property of the adapter+harness*, not of the SDK: 5/5 `stopReason=cancelled` when `session/cancel` is sent 2 s into a turn, but flaky at 5 s because Claude Code sometimes backgrounds a long shell command (`run_in_background: true`) and closes the turn `end_turn` first (`docs/compatibility/ACP.md` "Cancel"). The integration test therefore cancels at 2 s and instructs the reader to record, not silently trust, an `end_turn` observation.
- Limitation: we inherit upstream type naming/generation lag; if the SDK's schema trail falls behind a protocol revision our adapters want, the escape hatch is adapter-side raw extension calls (`_extMethod`), not a second protocol stack.

## Security/privacy

- The SDK unmarshals **untrusted output from a child process** an agent may compromise. Field-shape fallback mis-typing is the concrete risk above; mitigations are: never interpret unknown payloads beyond surfacing them, never let an event kind authorize an action, and keep the permission decision in the adapter's policy code.
- We offer no `fs`/`terminal` client capabilities, so a compromised agent cannot read arbitrary host files *through Communication*; it can only use whatever its own harness permits, which is the sandbox's problem (`05`, ADR-0003/0009), not ACP's.
- Permission default is deny; `preapproved` exists only for lab/test use and is never a default (per `04` "Permission policy" and `06` "auto-approve only within an enforced sandbox").
- Adapter stderr is kept in a bounded ring buffer for diagnostics, so transcripts cannot grow unbounded, and prompts/session output must never be logged with secrets (also ADR-0013/0014 payload rules).
- Launchers ride the developer's own harness login (see `docs/compatibility/ACP.md` "Auth mode") — organisation-managed credential injection is separate work (`05` § Credential source) and is not enabled by this ADR.

## Verification

Observed on the M0 lab host (Arch, `go1.27.2`; adapters pinned in `docs/compatibility/ACP.md`) at the time of writing:

```
$ go run ./cmd/communication doctor --acp claude
…
acp:claude    ok       @agentclientprotocol/claude-agent-acp@0.90.0 protocol=1 loadSession=true session=61546742 events=message_chunk:2,tool_call:1,tool_call_update:4,unknown:10 elapsed=5.5s
exit=0

$ go test -count=1 -v -run 'TestEventMappingSeqAndUnknown|TestHandshakePassesAdditionalDirsWhenAdvertised|TestCancelDuringPendingPermissionYieldsCancelled' ./internal/agent/acp/
--- PASS: TestHandshakePassesAdditionalDirsWhenAdvertised (0.00s)
--- PASS: TestEventMappingSeqAndUnknown (0.00s)
--- PASS: TestCancelDuringPendingPermissionYieldsCancelled (0.00s)
ok  	github.com/dbirks/communication/internal/agent/acp	0.006s

$ go mod graph | grep '^github.com/coder/acp-go-sdk'
github.com/coder/acp-go-sdk@v0.13.5 go@1.21
```

The live integration round trip is build-tagged and requires the pinned adapter plus the developer's own harness login; without it the test skips rather than passing vacuously:

```
$ go test -count=1 -tags acp_integration -run 'Integration' -v ./internal/agent/acp/
    integration_test.go:83: COMMUNICATION_ACP_CLAUDE not set; set it to the claude-agent-acp executable
--- SKIP: TestClaudeAdapterIntegrationRoundTrip (0.00s)
```

Not claimed: `doctor --acp codex` was not re-run in this session (its evidence is the probe rows in `docs/compatibility/ACP.md`); Gemini and Pi adapters remain GAP; `session/load` across a *different* workspace, APM-targeted sessions and sandboxed runs are untested (later milestones).

## Migration/rollback

Upgrades are dependency bumps with a re-verification duty, never silent: change the pin, run `go test ./internal/agent/acp/`, `go run ./cmd/communication doctor --acp claude` and `--acp codex`, and the tagged integration test; update `docs/compatibility/ACP.md`/`docs/compatibility/probes/` evidence rows with observed results before the matrix may say PASS again. Protocol-version changes additionally require a D-016 register update.

Rollback of the SDK itself is contained: `domain.AgentRuntime` is the seam, so replacing `coder/acp-go-sdk` with another library (or the hand-rolled path) rewrites only `internal/agent/acp/`. Nothing is persisted in SDK types — conversation events, session bindings and capability snapshots are our own shapes (`09` table families) — so no migration or data rewrite is involved. If no path works, the honest fallback is a GAP row in the matrix plus a new ADR, not a silently degraded protocol claim.
