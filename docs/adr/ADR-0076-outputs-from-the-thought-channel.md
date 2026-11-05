# ADR-0076 — The thought channel may supply an attempt's structured outputs when the reply channel said nothing the agent said

- **Date:** 2026-11-05
- **Status:** Accepted (implemented and verified — see Verification)
- **Owners:** worker + runtime maintainers
- **Related decisions / contracts:** ADR-0016 § 5 (the conversation event vocabulary: `conversation.message.agent` and `conversation.thought` are **different rows**; `internal/events`' own reading of the latter is "never as evidence of what the agent did"), ADR-0072 § 7 (a consumer that quotes "what the agent said" reads `conversation.message.agent` rows and must skip notices), ADR-0065 (the thread's last line is a message row), ADR-0022 § 4 rule 2 (the boundary refuses an envelope its plan's outputs schema would not accept), ADR-0023 § 7 (`invalid_output` is reserved for "output failed its JSON Schema" — a reply to judge), ADR-0073 (the claim carries the pinned plan's `OutputsSchema` and the refusal feedback), contract § 4 step 6, `docs/compatibility/ACP.md` (launcher pi streams `agent_thought_chunk` alongside `agent_message_chunk`; "client mapping must decide what is displayable"). Evidence: Actions run 42094770050 (commit `fe6949b`), pipeline `github-loop`, issue #351, journal rows E359/E365/E366/E370.

## Context

Contract § 4 step 6 extracts `structuredOutput` from the turn's coalesced **agent message** text, and the worker has always read exactly that stream (`agentText`). Nothing ever *recorded* "the message channel is the only thing that can answer" as a decision: it was inherited from ADR-0016's channel split, whose point is that thoughts are reasoning to be displayed, not the agent's words. That inheritance is what this ADR amends — narrowly.

Actions run 42094770050 ran the real GitHub loop on launcher `pi` with model `qwen3-8-flash-next`. The `/implement` agent did the whole job: it ran the tests green and opened draft PR #352 on the pushed branch. Then:

```
E359 conversation.message.agent  text="\n\n"                  (the only reply text of the turn)
E365 conversation.thought        "Changes made (…):\n\n```json\n{\n  \"summary\": \"The tally project …
E366 agent.session.disconnected  reason=process_exited
E370 node.attempt.failed         error_class=invalid_output
                                 detail="agent turn produced no text to extract structured outputs from
                                          (01 invariant 4: a succeeded attempt HAS outputs)"
```

The answer — the same prose-plus-fenced-JSON shape the prompt asks for, validating against the node's declared outputs schema — had arrived one channel to the left. The executor had nothing to judge, `01` invariant 4 forbids a succeeded attempt without outputs, so it spoke `invalid_output`; `/implement` lists `[infra, interrupted, timeout, agent_error]` as retriable and `invalid_output` is therefore permanent; the run failed and the issue got a FAIL verdict comment on work that was sitting in a draft PR.

The same turn, one day earlier, could not have been classified any other way: ADR-0023 § 7's `invalid_output` needs a reply, and the silence-classifier this repo added for run 42079149686 (`agentturn_silence.go`) refuses to blame the agent for a silence a dead or retrying harness left behind. Here the harness was alive, the process exited normally, and the agent *had* answered — the reply channel was just empty. Neither existing arm described that turn, so the classification fell through to the blame-the-agent arm and was wrong.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **One fallback, at extraction time: when the reply channel carries nothing the agent said AND the node declares an outputs schema, run the unchanged candidate selection over the turn's final thought text and accept it only if the schema ACCEPTS it (valid arm or the disjoint-union merge arm), journalling a `conversation.notice` that says which channel supplied the document (chosen)** | rescues the observed class with the schema as the only judge — it cannot smuggle a document the boundary would refuse; a reply with substance is never consulted against; a node with no declared schema is untouched, because nothing can be proven about its thought text; zero schema/API/event-type change; the transcript stays honest about where the envelope came from | the answer a run acts on can be text the agent never put in its message channel (mitigated: only a schema-validating document is ever taken, and the notice is mandatory) | `TestAgentTurnOutputsFromThought` (9 sub-cases), unchanged `TestAgentTurnSilenceIsNotInvalidOutput` / `TestAttachOutputsSplitsMergeAndNoSchema` |
| Add `invalid_output` to the github-loop `/implement` retry list | one YAML line, no executor change | does not fix anything — a model that answers on the thought channel answers there again; and a re-run of `/implement` is **not idempotent**: the branch slug is the model's choice and step 6 is a bare `gh pr create --draft`, so attempt 2 can push a second branch and open a second draft PR on the same issue | `ui/src/lib/pipeline/templates/issue-to-pr.yaml.txt` steps 1/5/6, `seed-github-loop.sh`'s temp-copy sed of that same template |
| Merge `agent_thought_chunk` into the message stream in the ACP adapter (one channel again) | the executor never learns about channels | falsifies ADR-0016's vocabulary: reasoning becomes agent words, which ADR-0072 § 7's mail quoting and ADR-0065's last-line read would then serve to another chat as the agent's answer, and every thought in every thread becomes candidate output | rejected — the transcript's channel split is the point |
| Add a new error class (e.g. `no_reply`) for this turn | names the shape | ADR-0023 § 7's class set is the retry policy's vocabulary, migrations CHECK it, and this turn is not a failure once the fallback applies; `no_reply` already exists as a *notice* kind for exactly the silence case | rejected — no new vocabulary |
| Prompt harder ("reply with JSON on the message channel only") | cheap, helps at the margin | already maximally explicit (`Write nothing outside this object`), ADR-0073's decoration states the schema every attempt, and the failure is the model's channel choice, not its knowledge of the contract | necessary-but-not-sufficient; not taken as the fix |

## Decision

1. **The turn keeps a second coalesced stream.** `agentText` (internal/worker/agentturn.go) buffers `thought_chunk` text into its own builder under exactly the message buffer's rules — a new tool window resets both, so what survives is the turn's *final* thought text. It is exposed through one reader, `agentText.thoughtText()`, which has exactly one caller. Nothing else in the system reads it; no thought text is ever journalled as `conversation.message.agent`.
2. **The rescue is narrow, and it runs last in the classification order.** In the `end_turn` arm: (a) the infra classification of `agentturn_silence.go` still speaks first — a mid-turn transport death, or a banner-only turn whose harness is gone or spent the turn retrying its provider, is the transport's story and gets no thought fallback (an agent that never worked has no answer to rescue); (b) only a refusal that survives that arm reaches `AgentTurn.outputsFromThought`, which requires ALL of: the reply text (after the existing banner/retry-status filtering) is launcher chatter only — **a reply with substantive text never consults thoughts**; the claim declares an `OutputsSchema`; and the thought text yields a document the judge ACCEPTS, i.e. `selectOutputDocument`'s valid arm or its disjoint-union merge arm. `outputSelection` gains `unverified`, set only on the arm that hands today's pick forward because the plan's schema could not be compiled: a verdict that was never computed is not an accepted document, so it does not qualify here (behaviour is unchanged everywhere else).
3. **An accepted thought document is a normal success** — same 32 KiB inline cap, same digest, same checkpoint, same validation at `Complete` — plus exactly one `conversation.notice` row, kind `outputs_from_thought`, stating that the message channel was silent and the final `conversation.thought` text supplied the validating document. A thought answer that itself needed the split-object merge earns the existing `outputs_merged` row too. Both rows carry the worker actor, as every non-answer notice does.
4. **A rejected thought is silent failure:** if the selection fails, is refused by the schema, is `unverified`, or overflows the inline cap, the attempt fails exactly as it did before this ADR, carrying **the reply channel's own evidence** (for run 42094770050's shape, `agent turn produced no text to extract structured outputs from …`). The fallback can only rescue; it cannot add a way to fail, and cannot replace the sentence a reader of the ledger expects.
5. **What readers call "the agent's reply" is unchanged.** ADR-0072 § 7's quoting rule, ADR-0065's `last_agent_line` and the transcript UI keep meaning `conversation.message.agent` rows; ADR-0016's channel split is intact. What changes is only what the *worker* may accept as the outputs envelope of an `agent.acp` attempt, and it says so in the thread when it does.

## Consequences

- A turn whose reasoning model answered on the wrong channel costs nothing: the run gets its envelope, the `resultBindings` resolve, the report artifact publishes, and the loop's verdict on the issue is the PR that already exists.
- The `outputs_from_thought` notice is the operator's signal that the launcher is misrouting answers for that model — the row is per-attempt evidence for `docs/compatibility/ACP.md`'s pi rows (which already record that pi streams `agent_thought_chunk` and that its `streaming` probe step FAILed for want of any `agent_message_chunk`).
- The declared outputs schema is now load-bearing for a *correctness* decision, not only a validation one: a node with no `outputs` schema keeps the old behaviour, which is the honest arm, because nothing in a thought can be proven to be an answer without a schema to ask.
- `process.exec` extraction (which reads a file or stdout, not a conversation channel) is untouched; `model.chat` streams no thoughts at all.
- Retry policy of the github-loop seed pipeline is deliberately unchanged (see Context and the Options table): `/implement` still does not retry `invalid_output`, because a re-run of that turn is not idempotent — the fix belongs in the classification, not in another attempt at the same non-idempotent work.

## Security/privacy

Thought text is not more trusted here, only more *checked*: the only thing the fallback can produce is a document the node's own declared schema accepted through `runtime.CheckNodeOutputs` — the boundary's judge — and that document then passes through the materializer's redaction like any other attempt result (`Execute`'s `redactResult` covers `res.Outputs`), so a secret echoed in reasoning cannot land in the attempt row through this path any more than through the reply path. The notice names a channel and a policy, never the document's contents. No new event type, no new table, no new field on any resource.

## Verification

- `internal/worker/agentturn_thought_test.go` (offline, no ACP — the real executor path over a stub session): `TestAgentTurnOutputsFromThought` —
  - blank reply + final thought with a fenced json envelope that validates → `succeeded`, outputs carry both declared fields, digest/outcome normal, exactly one `conversation.notice` of kind `outputs_from_thought`, no `outputs_merged` row, and the journalled `conversation.message.agent` rows stay the (empty) reply text;
  - thought chunks split mid-token across two `thought_chunk` events → coalesced, same success;
  - a stale thought streamed *before* the last `tool_call` → the final thought's document wins (the buffer's tool-window rule);
  - blank reply + thought JSON that violates the declared schema → `failed` / `invalid_output` as today, no rescue notice;
  - node declares no outputs schema + valid thought → `failed` / `invalid_output` as today (no judge, no fallback);
  - substantive prose reply + valid thought → the thought is never consulted: today's `invalid_output`, no notice;
  - banner-only + dead harness + **a perfectly valid thought** → still `infra`: the silence classification runs first and the fallback does not speak for an agent that never answered;
  - banner-only + dead harness + no thoughts → `infra`, no notices (the pre-existing pin, restated here);
  - thought document over the 32 KiB inline cap → not accepted, `invalid_output` as today.
- Regression unchanged: `TestAgentTurnSilenceIsNotInvalidOutput`, `TestChatterOnlyIsAnchoredOnLauncherBoilerplate`, `TestSelectOutputDocument*`, `TestAttachOutputsSplitsMergeAndNoSchema` (updated only for `attachOutputs` returning typed notes instead of a bare string), and the whole `./internal/worker/ ./internal/pipelines/...` suite.
- `go build ./... && go vet ./... && go test -count=1 ./internal/worker/ ./internal/pipelines/`.

## Migration/rollback

No migration, no schema change, no route change. Rolling the executor back returns this turn-shape to its old death (`invalid_output` on a run whose work is already pushed); nothing else moves.
