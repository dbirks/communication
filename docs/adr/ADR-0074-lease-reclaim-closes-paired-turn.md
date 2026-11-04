# ADR-0074 — A re-claimed attempt's orphaned conversation turn is closed in the re-claim transaction

- **Date:** 2026-11-04
- **Status:** Accepted (implemented and verified — see Verification)
- **Owners:** runtime + store maintainers
- **Related decisions / contracts:** ADR-0023 § 4 (the two-lease rule: "the attempt renewal renews the turn in the same statement"), ADR-0023 § 11 pass 1 (the lease re-claim is the engine's own, unfenced by design), ADR-0016 § 4 (the turn-lease reconciler's honest `interrupted{lease_expired}` word), contract § 4 step 6 (a retry rides the conversation its earlier attempts used) / step 12 (every attempt terminal closes its paired turn — every arm), schema `conversation_turns_one_active_idx`. Lab evidence: run 41766977189, commit e3dcbc1, lab-e2e (worker logs + Postgres `duplicate key … conversation_turns_one_active_idx` spam, 2026-11-04).

## Context

ADR-0023 § 4 renews the attempt lease and its paired conversation turn's lease in one statement, so when a worker stops speaking for an attempt, the attempt's lease dies first (or together with the turn's), and § 5.4 pass 1 is the component that takes the attempt over: it interrupts the attempt `interrupted{lease_expired}`, returns the worker's slot, and the advancer re-queues the retry on the node's schedule. But the re-claim terminalized the attempt **without touching its turn**, leaving the orphaned turn `leased` with its lease still in the future. The only closer left was the M2/M3 turn-lease reconciler — a second, separate loop on its own interval — while the retry claim's stamp (`agentturn_seams.go`) was refused every second by `conversation_turns_one_active_idx` and sat in its documented busy-wait: one 23505 a second in the Postgres log, and the node stuck leased until the other loop finally arrived (or, if it could not, forever).

Contract § 4 step 12 already says every attempt terminal closes its paired turn in the same transaction — the worker's boundary writes do (closeAttemptTurnTx), the takeover hands the close to the worker, and the M3 arm covers the rest. The re-claim was the one engine terminal that did not.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **The re-claim (RuntimeStore.ReconcileLeases) closes each re-claimed attempt's live paired turn — `interrupted`, `finished_at`, journaled `conversation.turn.interrupted{lease_expired}`, system actor — in the SAME transaction as the attempt's terminal (chosen)** | the retry claim finds the slot open the instant the re-queue is visible; one honest transcript line naming the stale worker's dead token; no new table, no new event type, no new turn status — the M2 vocabulary and the migration's CHECKs are untouched; all-or-nothing with the attempt terminal (settle's single transaction) | the re-claim learns the shape of a conversation write (guarded by the row lock + live-status re-check, unfenced on purpose — the re-claim is what makes the old triple stale) | `TestLeaseReclaimClosesOrphanedTurnInSameTransaction`, `TestLeaseReclaimDoesNotDoubleJournalTheTurnTerminal` |
| Lean on the M3 turn-lease reconciler alone (status quo) | zero new code | the retry's stamp waits a second loop's whole interval plus its lease-safety margin for a deadline that is the re-claim's own consequence; a deployment where the M3 arm is slow or absent wedges the node indefinitely; the transcript line is up to ~40 s late | the lab's per-second 23505 log |
| Have the retry claim's stamp close the orphaned turn itself | the wait never happens | the claim would be speaking the stale owner's turn vocabulary under its own new fence — exactly the split the one-active-turn index exists to prevent; it also invents a close reason the claim cannot know (did the lease die, or a takeover?); and a HUMAN's turn can hold that slot too, which the claim must not touch | rejected on the index's own rationale |
| A new turn status/reason (e.g. `lease_lost`) | named specifically | the domain's transition table and the M2 reason vocabulary are closed sets (`internal/events`, migration CHECKs); `interrupted{lease_expired}` already says "a deadline, not the dead process, decided this" — the same word the M3 arm uses | rejected — no invented vocabulary |

## Decision

1. `RuntimeStore.ReconcileLeases` (the § 5.4 pass 1 re-claim) snapshots the hydrated live attempts, runs the engine's interrupt, and for every attempt whose status went live → `interrupted` in this pass, closes the live turn stamped with that attempt's `node_attempt_id` in the same settle transaction (`closeReclaimedAttemptTurnsTx`): `status='interrupted'`, `finished_at=now()`, and one journaled `conversation.turn.interrupted` with `reason=lease_expired`, the turn's own worker id and dead fencing token, actor `system`.
2. The close is **unfenced and guarded**: it takes the turn row `FOR UPDATE` and re-checks liveness, so a turn the M3 arm or the old worker's own close answered first is left untouched and journaled exactly once (one journal row total, whichever arm won).
3. Only the attempt's own paired turn is ever touched: a human's own turn on the same conversation belongs to M2's turn loop and the re-claim's busy-wait deferral (ADR-0016 § 5), and a non-agent attempt owns no turn (no-op).
4. The M3 turn-lease reconciler remains the backstop for turns the re-claim cannot see (human turns; an attempt already terminal when the pass ran — the takeover's worker-owned close).

## Consequences

- A retry claim after a lost lease no longer depends on a second loop's arrival: the stamp's `conversation_turns_one_active_idx` refusal is now reachable only for the documented human-turn case, where the wait is the intended behaviour.
- The transcript gains one honest system line at the re-claim instant ("the worker lost the turn"), spoken by the deadline rather than a later guess — the same shape the M3 arm has always journaled.
- The engine adapter acquires knowledge of one conversation-family write; it stays inside the re-claim transaction, reads only `node_attempt_id`-stamped rows, and invents no turn vocabulary.
- No schema change; no public API change; no migration.

## Security/privacy

The close reveals nothing the ledger already exposes: the turn's worker id, its dead fencing token and the reason string are the exact fields ADR-0016 § 4 already journals for a reconciler-interrupted turn. The write path is fenced out of the stale owner by construction (its attempt is terminal in the same transaction), and the guard refuses to touch any turn the re-claim did not orphan.

## Verification

- `internal/store/postgres/attempt_lease_reclaim_turn_test.go` (real Postgres, migrated): `TestLeaseReclaimClosesOrphanedTurnInSameTransaction` — agent.acp attempt with a stamped conversation turn, attempt lease expired, `ReconcileLeases` re-claims: attempt `interrupted{interrupted class}`, turn `interrupted` in the same commit, exactly one `conversation.turn.interrupted{lease_expired}` (system actor, stale worker + dead token), worker slot released, the stale owner's next fenced write refused `ErrLeaseLost`, and the engine-queued retry (backoff landing time persisted) claims and stamps its fresh turn on the same conversation with no busy wait. Disabling the close reproduces the lab: the turn stays `leased` and the retry's stamp is refused.
- `TestLeaseReclaimDoesNotDoubleJournalTheTurnTerminal` — the M3 arm speaks first (both leases expired); the re-claim then re-derives from the same rows and leaves the first word standing: one journal row, turn unchanged.

## Migration/rollback

No migration: the behaviour is a narrower transaction, and rows are the source of truth — an instance running the old code still converges through the M3 arm. Rolling back re-opens the lab's wait window, nothing else.
