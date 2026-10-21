# ADR-0055 — Pause-before-next-step takeover (evaluated and deferred)

- **Date:** 2026-10-21
- **Status:** Proposed (design record; the decision it records is to **keep** today's semantics — nothing here is implemented)
- **Owners:** pipeline runtime + workbench UI
- **Related decisions / contracts:** ADR-0016 §5 (takeover semantics, `cancel_requested_at` on the running turn), ADR-0023 §5/§6/§9 (attempt terminal states, durable boundaries, the takeover arm), ADR-0037 (retry/unknown-node honesty), ADR-0043 (Run Workbench, graph-first) + its addendum (return-to-factory waits for the human turn), `internal/pipelines/runtime/retry.go` (`MarkCancelledByHumanTakeover` :472-487, `ResumeFromHumanTakeover` :503-555), `internal/pipelines/runtime/state.go` (`paused_reason` incl. `human_takeover`), app-shell handoff `docs/design/handoff-app-shell/gaps/workbench.md` §4.1 + `GAPS.md` ADR register

## Context

The Run Workbench artboard (turn 4–5, card 5c) draws the two-step take-control confirm card as:
*"TAKE CONTROL OF `implement`? … the loop continues from `test`"* — i.e. a run pauses **before its
next step** and, on hand-back, advances from the interrupted step's successor. The accepted
behavior, shipped and acceptance-proven, is different:

- **Takeover interrupts the current attempt.** `MarkCancelledByHumanTakeover`
  (`retry.go:472-487`): *pause first* (the run moves to `paused`, `paused_reason=human_takeover`;
  pause stops future scheduling only — live attempts keep their leases), *then*
  `Interrupt` closes the attempt `interrupted {reason: "human_takeover"}` (ADR-0023 §9; the
  conversation-control CAS also sets `cancel_requested_at` on the running turn, ADR-0016 §5).
- **Hand-back re-runs the same step.** `ResumeFromHumanTakeover` (`retry.go:503-555`) lifts the
  pause and re-queues **the interrupted node once**, as a **new attempt** whose `retry_context`
  carries `human_takeover: <intervention>` (plus attempt number, error class and the last durable
  boundary's repo facts — "never a memory", ADR-0023 §5.1/§6). The takeover is *not* an execution
  failure, so it inherits no retry budget and no backoff.
- **Proof:** A5 evidence — "the run is paused for human_takeover (the attempt was interrupted)"
  and "a NEW attempt (attempt 2) of code_review was queued"
  (`docs/design/issue2-acceptance.md`).

The product owner's decision list names "pause-before-next-step" as ADR-requiring
(`gaps/workbench.md` §4.1, gap 5c-copy; `GAPS.md` ADR register). This record evaluates it so the
decision is on the record rather than in the copy.

## The 5c semantics, defined

**Pause-before-next-step (PBNs):** a takeover requested while an attempt runs does **not** close
the attempt. The agent's turn ends (the human wins the conversation control row; one controller,
ADR-0016 invariant 2), but the **node execution stays open**: the run pauses at the next step
boundary — no successor node is claimed while `paused_reason=human_takeover` — and the attempt is
resumable, not terminal. On hand-back the run unpauses, the attempt **completes** (its work up to
the human's hand-back stands, recorded as the attempt's outcome), and the loop **continues from
the next node** — no new attempt of the interrupted step.

## Comparison

| Dimension | Today (accepted) | PBNs |
|---|---|---|
| Interrupted step's work | discarded; re-derived from the last durable boundary (ADR-0023 §6) | kept; the attempt completes |
| Attempt numbering | the re-queued node gets a new attempt (attempt +1) | unchanged; one attempt per node execution |
| `retry_context` | carries the `human_takeover` intervention into the new attempt (C9g) | the intervention must be delivered some other way — the agent turn that would receive it is gone |
| Pause point | immediately (`human_takeover` pause, `state.go`) | at the next step boundary (a third pause reason or a sub-state of `paused`) |
| Recovery (API/worker restart mid-takeover) | trivial: the attempt is already terminal; resume re-queues the node | the scheduler + ADR-0016's lease reconciliation must distinguish "attempt open, run paused for takeover" from "abandoned attempt" — fencing tokens and the 5 s reconciler gain a new arm |
| Scheduler/advancer | unchanged | the advance path must hold at the boundary while the takeover pause is set; a successor claim during the pause must be refused, not just never scheduled |
| UI copy | must say "the current step is interrupted; when you hand back, the same step runs again with your changes" | the 5c card's current wording becomes literally true |
| Risk | none — accepted and tested | partial work survives a human hand-back unvetted: a half-written attempt becomes a durable predecessor for the next step, and nothing (no new attempt, no retry budget, no backoff) re-checks it |

The last row is the load-bearing difference: today, the human's changes reach the agent through
the *re-run* (the new attempt's `retry_context`), and the interrupted work is honestly recorded
`interrupted` in the journal. PBNs would make an **interrupted, human-interrupted attempt** the
recorded success that the next step builds on.

## Decision

**Keep today's semantics.** This redesign does not adopt PBNs. The product owner's decision
(2026-10-20, `GAPS.md` Decisions: "Take control keeps the existing takeover semantics") stands:

1. **Runtime and scheduler: unchanged.** `MarkCancelledByHumanTakeover` /
   `ResumeFromHumanTakeover` (ADR-0023 §9, ADR-0016 §5) remain the contract; no new pause reason,
   no boundary-hold in the advancer, no new lease-reconciliation arm.
2. **UI copy: fixed to the truth.** The 5c confirm card says the interrupted step is stopped and
   that handing back runs the same step again with the human's changes — shipped in `126af18`
   (acceptance: after `Return to factory`, the **same node** shows `attempt_count` +1, not the
   next node advanced; `gaps/workbench.md` §7.1).
3. **PBNs is recorded, not built.** It returns to the record only if the product owner wants
   "keep the interrupted step's work" — and then as an amending ADR to ADR-0023 §9 / ADR-0043
   with the table above as its change list (runtime, scheduler, ADR-0016 §5, recovery, copy),
   because each of those is accepted surface today.

## Consequences

Positive: the acceptance evidence (A5) keeps applying verbatim; the confirm card's copy is now a
testable statement of the shipped behavior; no recovery-semantics change (AGENTS.md: changes to
recovery semantics need an ADR — this ADR is the record that the semantics are *not* changing).

Limitations: the 5c artboard's "the loop continues from `test`" is copy, not behavior; anyone who
reads the artboard as a spec should read this record instead.

## Security/privacy

No trust-boundary change. Takeover stays CAS-on-the-control-row + human-actor journal events
(`run.paused`/`run.resumed` name the actor; `retry.go`'s comments call an actor-less
`run.paused` "a lie about who did it"). Nothing in this ADR widens or narrows a permission.

## Verification

Not applicable to implementation (none is decided). The decision itself is verified by the
existing evidence: `retry.go`'s takeover tests, ADR-0016 §5's tests, and the A5 acceptance
(`docs/design/issue2-acceptance.md`) — all describing the semantics that this ADR keeps.

## Migration/rollback

No migration. Reverting this ADR is trivial (it commits no change); adopting PBNs later is not
reversible without its own amending ADR, because the attempt/journal semantics it would change
are already acceptance-proven.
