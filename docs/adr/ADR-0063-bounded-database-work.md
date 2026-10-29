# ADR-0063 — Bounded database work: a trigger fire's run creates ride its own transaction, and no lock may outlive its holder's liveness

- **Date:** 2026-10-25
- **Status:** Accepted (implemented in `944474c` and verified on real PostgreSQL — see Verification; Decision 2's single poll bound refined by the 2026-10-29 amendment at the end of this record)
- **Owners:** control-plane persistence + worker loop maintainers
- **Related decisions / contracts:** ADR-0013 D2/D3 (pgx v5.11.0, one `pgxpool.Pool` per process, goose forward-only), ADR-0014 (the per-project journal append lock `pg_advisory_xact_lock`, held to COMMIT, and "a foreign long transaction reads as latency"), ADR-0016 § 4 (reconciler discipline: "many replicas are safe, zero replicas only delay detection"; every input to a pass is a row whose deadline already passed), ADR-0023 § 4 (30 s attempt lease), § 9 (the fencing triple) and § 11 pass 1 (lease-expiry reclaim), ADR-0032 (schedule fires), ADR-0056 (`issue_triggers`, the fire path, `last_polled_at`/`last_error`), ADR-0062 (the unattended turn a fired run stamps), the pass-tx context carried for `pipeline.invoke` children since `21656f6` (`internal/store/postgres/passtx.go`), `communication-spec/02` ("Scheduling and recovery"), `communication-spec/09` (state transitions), `communication-spec/12` (test layers)

## Context

The M4 lab wedged on 2026-10-25 and stayed wedged for hours. The evidence chain, in the order
the observations line up (all of it recorded in the code comments and test headers this decision
ships with — `internal/store/postgres/issue_triggers.go`, `m4api_runs_write.go`,
`issue_triggers_lease_test.go`, `attempt_lease_reclaim_test.go`):

1. **13:48:34 — one issue-trigger fire takes the project journal lock and never lets go.**
   Trigger `01a17351-7fd7`'s tick listed GitHub, matched issue #11, began its fire transaction,
   and appended `run.created` — which takes the per-project journal advisory lock
   (`postgres.LockEventJournal`, ADR-0014) that is held **to COMMIT**.
2. **The same fire then went to create a second run — on a second connection.** The poll had
   matched *two* issues. `APIRunStore.createRunPinned` opened its own transaction on another pool
   connection, and that transaction waited for the journal advisory lock the fire transaction
   (its own caller) already held. Postgres cannot name this: the holder is **idle in
   transaction**, not waiting, so the deadlock detector sees a wait-for graph with no cycle. It is
   a self-deadlock across two transactions of one goroutine, and it waits forever.
3. **Nothing recorded the poll.** The fire never committed, so `last_polled_at` stayed NULL and
   `last_error` stayed empty; the serve ticker's goroutine never returned, so that replica
   stopped polling entirely. Every other replica's due claim (`FOR UPDATE SKIP LOCKED`) skipped
   the locked trigger row **without recording anything either**. Issue #12 was labelled ~70
   minutes later and nothing ever looked.
4. **A worker claim froze in the same queue.** Run `01a17351-fa02`, attempt `6902a939`: the claim
   landed, then `BeginAttempt`'s journal append queued behind the wedged advisory lock. The call
   shared the loop's untimed context, so the goroutine parked forever — before the lease-renewal
   loop ever started, with no log line, without releasing the claim, and while still holding the
   attempt row's `FOR UPDATE` fence. The lease expired with nobody renewing it; the worker's
   capacity slot stayed spent.
5. **The fleet's only recovery joined the queue.** The m4 driver's `ReconcileLeases` pass — the
   ADR-0023 § 11 pass-1 backstop — waited **85+ minutes** for that attempt row lock, frozen while
   holding the driver's session-scoped advisory lock, which locked every other replica out of the
   backstop too. One stuck row had become a frozen fleet.

Two independent defects are visible in that chain, and the fix needs both halves. **Structural:**
nested writes inside a lock-holding transaction must use that transaction, never a second
connection that queues behind it — the shape `21656f6` had already solved for `pipeline.invoke`
children, but only on the advancer's pass path, not on the trigger fire's.
**Absence of bounds:** nothing in the process — application or database — could cut a wedged
writer loose, so a single parked goroutine converted into permanent unavailability instead of one
delayed tick. Per `communication-spec/02` and ADR-0016 § 4, recovery is supposed to *delay*
detection when a holder misbehaves, never end it.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: ride the fire transaction (savepoints) *and* bound every unit of database work — poll, pass, begin, and the connection itself (chosen)** | the self-deadlock becomes unrepresentable, not merely unlikely; a multi-issue poll fires all matches in one atomic commit; every remaining wedge is bounded by a deadline that cancels the statements and frees the locks; bookkeeping survives the failure, so the next operator question ("did it look?") has an answer | a trigger fire's whole poll commits or aborts together; per-run all-or-nothing needs a sub-unit (savepoint) to survive idempotent replay; timeouts become a documented tuning surface with a scope limit (§ Decision 5) | implemented; `TestIssueTriggerTwoMatchingIssuesFireInOnePoll`, `TestExpiredUnstartedLeaseReclaimedAfterWedgedHolder`, `TestAttemptWedgedBeginIsNotADropOnTheFloor`, `TestOpenPoolBoundsWedgedTransactions` on real PostgreSQL |
| B: commit the poll first, then create each run in its own transaction (never nest) | no savepoints; the journal lock is released before any create | breaks the fire's atomicity: a crash between the poll commit and a create loses a fire the cursor already consumed, and re-deriving "which matches still need a run" turns the idempotency-key ledger into a work queue — the read-time practice ADR-0056 § Options already rejected | ADR-0056 (the `issue-<id>-<number>` keys are a write-side dedupe ledger), `fireIssueTrigger`'s cursor semantics |
| C: keep the second connection, just bound it | smallest diff | bounds the *hang*, not the *bug*: every two-match poll would end in a recorded failure and fire nothing, which is a silently dead feature with nicer logs | the same 60 s statement_timeout, applied to a wait that can never succeed |
| D: stop holding the journal lock to COMMIT (per-project sequences, batched appends) | removes this one shared lock | reopens ADR-0014's accepted commit-order/sequence invariant for a bug that has a local fix, and does nothing about the worker's untimed `BeginAttempt` or the driver's untimed pass — the other three links in the chain | ADR-0014 § Limitation ("held to COMMIT … a foreign long transaction reads as latency") |

## Decision

Implemented in `944474c`, no schema change, no new dependency.

1. **An issue trigger's run creates ride the fire transaction, as savepoints.**
   `fireIssueTrigger` now puts its own transaction on the context
   (`ctx = withPassTx(ctx, tx)`, `internal/store/postgres/issue_triggers.go`) — the same
   mechanism `passtx.go` carries for an advancer pass — and `APIRunStore.createRunPinned`
   (`internal/store/postgres/m4api_runs_write.go`) checks for it: when a caller owns the
   transaction, the create runs inside it as a **savepoint** (`outer.Begin`), committing with
   `RELEASE SAVEPOINT` or rolling back to it. That keeps the per-run all-or-nothing rule intact
   where a plain nested call could not: an idempotent replay (an issue edited after it already
   fired) rolls back **to its savepoint**, not the caller's work, so the other matches in the same
   poll still commit. With no pass transaction the old pool-owned path is byte-for-byte what it
   was. Consequences that follow from this and must be understood, not discovered: the whole
   multi-issue poll is one commit, so a failure anywhere in it fires nothing (and says so via
   `last_error`), and every journal append in the poll is serialized behind one project's advisory
   lock by construction — bounded by Decision 2 and 4 rather than by a second connection.
   The fire's deferred rollback also runs on a **fresh, bounded, detached** context
   (`context.WithoutCancel` + 5 s): rolling back with the fire's own expired deadline sends
   nothing, and an uncommitted fire would keep the trigger row *and* the journal advisory lock
   pinned against every other replica's tick — the lab's exact silence, one step later.
2. **One poll of one trigger is bounded, and its bookkeeping is recorded detached.** New
   `issueTriggerPollTimeout = 30s` (overridable as `IssueTriggerStore.PollTimeout`) wraps the
   claim, the credential resolve, the GitHub list **and** the fire transaction together;
   `fireIssueTriggerBounded` returns within that bound plus `issueTriggerFireJoinGrace = 2s` even
   if the poll's goroutine parks somewhere that ignores cancellation. 30 s is deliberately well
   under the `issueTriggerPollInterval = 60s` beat, so a cut-loose poll cannot outlive its own
   beat. *(The single bound wrapping "the fire transaction together" is superseded by the
   2026-10-29 amendment at the end of this ADR: `PollTimeout` now bounds only the poll's EXTERNAL
   calls and the fire transaction answers to its own `FireTimeout`. Everything else in this
   Decision — the 2 s join grace, the 60 s beat rule, record-on-every-exit, the detached recorder
   and the shutdown carve-out — stands as written.)*
   **Every exit records the poll**: the success path lands `last_polled_at` inside the fire
   transaction, and any failure — including the timeout — is landed by
   `recordIssueTriggerPollFailed` as a *separate* write on a detached, bounded context
   (`context.WithoutCancel(ctx)` + 10 s) that commits whatever the fire transaction's fate was and
   only logs if it too fails. The rule this encodes: **poll bookkeeping must never depend on the
   success of the poll it describes** — a trigger whose poll vanished without a trace
   (`last_polled_at` NULL forever) is indistinguishable from one that was never scheduled.
   Shutdown (`ctx.Err()`) is deliberately *not* a failing poll and records nothing, exactly like
   the interval ticker that stops mid-beat.
3. **`BeginAttempt` and every `RuntimeStore` pass are bounded.** On the worker,
   `attemptBeginTimeout` (a var, so tests drive the cadence; = `attemptTerminalWriteTimeout` =
   10 s) bounds the leased→running write. Spending it means this worker **stops speaking for the
   attempt and leaves it to the lease**: the loop logs
   `"begin attempt failed; the attempt is not started"` with the attempt id, writes the honest
   `failed`/`infra` terminal, gives the capacity slot back, and keeps claiming — instead of the
   lab's silent stall (no start, no release, no log, no renewal). The follow-up `honestFail` word
   now runs on its own fresh bounded context, because the write that failed may have spent the
   budget that produced the failure. On the control plane, `RuntimeStore.PassTimeout`
   (default `defaultRuntimePassTimeout = 15s`) bounds one whole
   lock→hydrate→apply→write-back→commit settle pass, and the deferred rollback again runs on a
   fresh detached 5 s context. A pass is a short scripted transaction over ONE run, so the bound
   exists purely to stop a wedged peer from converting one stuck row into a frozen fleet: the
   driver loop treats a timeout as an ordinary pass failure and retries next tick. The pass is
   all-or-nothing under the bound — the reclaim test asserts a refused pass wrote *nothing* — and
   once the wedged holder is gone, the next pass reclaims the expired UNSTARTED lease within one
   bounded pass, landing exactly where ADR-0023 § 11 pass 1 says: `interrupted{lease_expired}`,
   `started_at` NULL (the ledger never claims work that did not start), node back to `ready`,
   worker slot released, and the replacement claim drawing a strictly greater fencing token.
4. **Every pooled connection carries server-side bounds, with a URL override.**
   `postgres.Open` (`internal/store/postgres/db.go`) sets
   `idle_in_transaction_session_timeout = 30s` and `statement_timeout = 60s` into
   `ConnConfig.RuntimeParams`, so they apply to every connection the pool opens — in `serve`
   (`cmd/communication/serve.go` `openPool`) and in `worker` (`cmd/communication/worker.go`, the
   same `openPool`) alike, since `BeginAttempt` runs on the worker's pool. The two bounds answer
   the two halves of the wedge: the idle-in-transaction timeout kills a transaction whose client
   stopped speaking at all (lab step 2 — a holder that is *not* waiting is invisible to
   `pg_blocking_pids` and to the deadlock detector), and `statement_timeout` bounds one statement,
   **including every lock-wait** — the lab's reclaim UPDATE waited 90 minutes for a row lock.
   30 s is two orders of magnitude above the slowest observed in-transaction gap and one below the
   point where "eventually" stops meaning anything; 60 s is above every statement in this codebase
   at today's data volume. **The fill is conditional:** `Open` only sets a parameter that is
   unset, so an explicit `?statement_timeout=…` / `?idle_in_transaction_session_timeout=…` in
   `COMMUNICATION_DATABASE_URL` (any GUC pgx copies into `RuntimeParams` — observed on pgx
   v5.11.0, 2026-10-25) wins per process without a code change. The
   `options=-c statement_timeout=…` spelling does **not** suppress the default (pgx files it under
   `options`, not the GUC name), so overrides use the plain parameter.
5. **Scope limit — what is deliberately NOT bounded.**
   - **Migrations** (`internal/store/postgres/migrate.go`): `openSQLDB` opens a *separate*
     `database/sql` handle over the pgx stdlib driver (`stdlib.OpenDB`) and goose runs
     `UpContext` on it. It never touches `Open`, so it carries neither timeout. That is
     intentional: DDL is legitimately long (the 00017 backfill, any future index build on a live
     table), it runs once per deployment under a caller-supplied context in `migrate`/`dev`
     startup — not inside a tick that a fleet depends on — and goose's own advisory/version
     discipline, not a statement bound, is what serialises it. A `statement_timeout` here would
     turn a slow-but-honest migration into a half-applied, retryable-by-hand failure.
   - **The LISTEN connection** (`internal/store/postgres/events.go` `listenOnce`): it is opened
     directly with `pgx.Connect(ctx, w.databaseURL)`, outside the pool, and is not bounded either
     — also intentional. That connection opens no transaction and takes no lock, so it cannot
     produce the shape this ADR prevents; its whole job is to sit in `WaitForNotification`
     indefinitely, which is *liveness*, not a wedge. Its bounds are the caller's context plus the
     bounded reconnect backoff (`evtReconnectMax`) and the wake-all after a reconnect, and a
     per-statement bound there would only risk killing the `LISTEN` itself for no protective gain.
     (Journal *reads and appends* still go through the bounded pool; only the notification wait
     does not.)
   - Also outside the pool, and therefore unbounded by this ADR: anything that opens its own
     connection later. The rule for such a connection is the same one stated in Consequences —
     if it holds a lock anyone waits on, it needs its own bound.

## Consequences

- **Positive.** The lab's five-step chain is broken at every link: two matching issues fire in one
  commit instead of deadlocking; a poll that cannot finish is cut loose, recorded, and the tick
  moves on; a wedged `BeginAttempt` becomes a loud, bounded infra failure that returns the
  capacity slot; a wedged row delays a reconcile pass by one tick instead of freezing the backstop
  for 85 minutes; and if the application forgets its bound, the database enforces a server-side
  one, so the failure mode is self-healing. `last_polled_at` becomes trustworthy as a liveness
  signal for the first time — every poll answers, including the ones that died.
- **The 60-second rule.** `statement_timeout = 60s` applies to every statement on a pooled
  connection, so **any future statement that legitimately needs more than 60 seconds must not
  borrow this pool**: it gets its own connection (as migrations do) or an explicit
  `SET LOCAL statement_timeout = …` inside the transaction that needs it, reviewed as part of
  that feature. Report/aggregation reads (ADR-0047's cross-project lists, the assistant's reads)
  are the likeliest candidates; the right answer there is an index or a bounded query, not a
  bigger global timeout.
- **Reconciliation is delayed by a tick, never ended.** Every caller of a bounded unit treats the
  timeout as retryable backstop work — driver tick, reconciler pass, trigger ticker — because
  every input to a pass is a row whose deadline already passed (ADR-0016 § 4). The trade is
  explicit: repeated timeouts look like noise in the log and in `last_error`, and are still
  preferable to silence, which is what hid this wedge.
- **Cut-loose work is not necessarily rolled back.** A poll abandoned at its deadline "stands as it
  committed it": the fire transaction's own rollback (fresh, bounded) releases its row locks, but a
  statement that already committed stays committed, and the detached recorder may report a poll
  whose outcome was partial. `issue-<trigger id>-<number>` idempotency keys are what make the
  retry safe (ADR-0056); the `last_error` text says the poll "was cut loose".
- **A multi-issue trigger fire is atomic now** — one failed create means no create. Combined with
  the replay-is-a-savepoint rule, an already-fired pair no longer jams later polls (ADR-0056
  amendment).
- **Backwards compatibility:** no wire, schema, or event change. Behaviour only: three more
  Postgres GUC-visible defaults on pooled connections, and two more error texts
  (`issue trigger poll exceeded 30s …`, `begin attempt failed; the attempt is not started`).
  Operators upgrading into a database where these GUCs are set cluster-wide see no change; a
  cluster whose *server* default is lower than 30 s/60 s now gets the tighter value from the URL
  parameters this code sends.
- **Known limit:** the per-project journal append lock is still one lock held to COMMIT
  (ADR-0014), so a slow-but-under-60 s project writer still serialises that project's appends.
  This ADR bounds the damage; it does not remove the serialization.

## Security/privacy

No trust-boundary change, and nothing here widens one. The bounds are availability controls: they
reduce the blast radius of a wedged or hostile-slow client, and they make a stalled tenant's
transaction stop pinning another project's journal appends. Fail-closed direction is deliberate at
each cut — a timed-out `BeginAttempt` does not proceed on an unproven write (the attempt lands
`failed`/`infra`, or the expired lease speaks through the reconciler), and a timed-out poll fires
nothing. Failure text is bounded: `last_error` is truncated to `maxIssueTriggerErrorLen` (400
bytes) before it lands, and the causes recorded here are deadline/context errors and upstream list
errors, never credential material — the detached recorder writes no token, and `postgres.Open`
scrubs the connection string from every error it returns, including a timeout error.
`last_polled_at`/`last_error` ride the trigger API row (ADR-0056) as project-member-visible poll
bookkeeping, which is the point: an operator must be able to tell "looked and failed" from "never
scheduled". No secret, no `.env`, no new egress site; `idle_in_transaction_session_timeout` also
means an abandoned interactive transaction on a pooled connection cannot linger as a session
someone else inherits.

## Verification

Real PostgreSQL (`COMMUNICATION_TEST_DATABASE_URL`, `postgres://ci@127.0.0.1:55432/ci`),
2026-10-25, at `944474c`:

```
$ go test ./internal/store/postgres/ -run 'TestOpenPoolBoundsWedgedTransactions|TestIssueTrigger' -count=1 -v
--- PASS: TestOpenPoolBoundsWedgedTransactions (1.06s)         pg_settings on a pool from Open: idle_in_transaction_session_timeout=30000 ms, statement_timeout=60000 ms
--- PASS: TestIssueTriggerPollSetsLastPolled (0.56s)           a clean no-match poll still lands last_polled_at
--- PASS: TestIssueTriggerTwoMatchingIssuesFireInOnePoll (3.28s)  the lab's exact fire: #11 AND #12 create runs in one fire tx, poll commits, no self-deadlock
--- PASS: TestIssueTriggerHungPollIsCutLooseAndRecordedAndTickKeepsGoing (0.62s)  beat 1 hung ⇒ tick returns bounded, last_polled_at+last_error land detached, trigger row is claimable again (FOR UPDATE SKIP LOCKED sees it free); beat 2 hard list error is recorded, tick stays healthy; beat 3 fires again
--- PASS: TestIssueTriggerOpenedFiresPerNewIssue (0.45s)
--- PASS: TestIssueTriggerLabeledFiresOnlyOnMatchingLabel (0.55s)
--- PASS: TestIssueTriggerRepollDoesNotDoubleFire (0.56s)
--- PASS: TestIssueTriggerEditedAfterFireReplaysGreen (0.37s)  the replay arm of Decision 1's savepoint rollback
--- PASS: TestIssueTriggerSkipsPullRequests (0.20s)
--- PASS: TestIssueTriggerRateLimitRecordsErrorAndTickContinues (0.20s)
--- PASS: TestIssueTriggerDisabledNeverPolls (0.25s)
--- PASS: TestIssueTriggerTemplateRendering (0.26s)
--- PASS: TestIssueTriggerOtherOrganizationCannotListOrPatch (0.25s)
--- PASS: TestIssueTriggerPollPassesRepositoryCredential (0.35s)
--- PASS: TestIssueTriggerCredentialFailureLandsLastError (0.42s)
--- PASS: TestIssueTriggerTypedPlaceholderFiresAsNumber (0.37s)
--- PASS: TestIssueTriggerTypedPlaceholderRefusals (0.31s)
PASS
ok  	github.com/dbirks/communication/internal/store/postgres	11.404s

$ go test ./internal/store/postgres/ -run 'TestExpiredUnstartedLease' -count=1 -v
--- PASS: TestExpiredUnstartedLeaseIsNeverReclaimedWhileTheLeaseIsLive (1.26s)  a live lease is untouched: the scan only writes rows the clock passed
--- PASS: TestExpiredUnstartedLeaseReclaimedAfterWedgedHolder (0.65s)  external tx holds the attempt FOR UPDATE ⇒ ReconcileLeases answers at PassTimeout (300 ms) and wrote NOTHING (all-or-nothing); after the holder lets go, one pass reclaims: interrupted{lease_expired}, started_at NULL, finished_at set, node ready/in_flight 0, active_attempts 0, retry claim's fencing token strictly greater, the stale owner's late BeginAttempt lands NOTHING
PASS
ok  	github.com/dbirks/communication/internal/store/postgres	13.065s

$ go test ./internal/worker/ -run 'TestAttemptWedgedBeginIsNotADropOnTheFloor' -count=1 -v
--- PASS: TestAttemptWedgedBeginIsNotADropOnTheFloor (0.04s)  attemptBeginTimeout=40ms + a parked BeginAttempt ⇒ executor never ran, attempt failed/infra, loud log line naming the attempt id, active_attempts back to 0, and the same loop goes on to run a2
PASS
ok  	github.com/dbirks/communication/internal/worker	0.068s
```

Plus, with this ADR's files the only change in the tree: `go build ./...` (clean) and
`go vet ./internal/store/postgres ./internal/worker` (clean), 2026-10-25. The URL-override claim
in Decision 4 was checked against pgx v5.11.0's `ParseConfig` directly: a plain
`statement_timeout=5000` query parameter arrives in `ConnConfig.RuntimeParams` (so `Open` leaves it
alone), while `options=-c statement_timeout=5000` arrives under `options` (so it does not) — hence
the "use the plain parameter" instruction. Not yet exercised: a live lab re-run of the two-issue
trigger under load (the wedge's original setting) and an observation of the 30 s
idle-in-transaction kill firing in a real replica's log; both are operational confirmations of
paths the tests above pin at the database, and each belongs in the next lab pass.

## Migration/rollback

No migration, no head change, no backfill — this is behaviour plus three `RuntimeParams` writes at
pool construction. Rollback is a straight revert of `944474c`: `createRunPinned` returns to its own
pool transaction, `TickIssueTriggers` calls `fireIssueTrigger` directly, `settle` loses its
deadline, and the pool opens without GUC bounds — which restores the wedge exactly as described
above, so rollback is only appropriate while the lab is not running anything that matters. There is
no half-revert: removing only the pool bounds (Decision 4) or only the savepoint path (Decision 1)
leaves the other defect live, and removing only the bounds while keeping the timeout code produces
timeouts whose statements outlive their deadline. No operator action is required on upgrade; a
deployment that needs a longer ceiling sets the URL parameters named in Decision 4 rather than
editing the constants. If a future statement needs a per-transaction ceiling, `SET LOCAL` is the
forward path (Consequences), and that would be recorded against this ADR, not silently added.

## Amendment (2026-10-29) — the poll bound and the fire transaction are two bounds, not one

D2 wrapped the claim, the credential resolve, the GitHub list **and** the fire transaction in **one**
`issueTriggerPollTimeout`; that wrapping is all this amendment narrows. The rule now, in
`internal/store/postgres/issue_triggers.go`:

1. **`issueTriggerPollTimeout = 30s` (`IssueTriggerStore.PollTimeout`) bounds the EXTERNAL half of
   one poll only**: `issueTriggerToken` (the credential resolve), `ListIssues`, the `GithubNow`
   clock read and the per-issue `issueLabelTiming` timelines. It is the deadline that exists to
   catch a GitHub call that never answers.
2. **`issueTriggerFireTimeout = 30s` (`IssueTriggerStore.FireTimeout`) bounds ONE fire transaction
   end to end**: `Begin`, the claim re-check, the pin reads, the run creates, the journal appends,
   the cursor write and the **COMMIT**. `fireIssueTrigger` takes two contexts — `ctx` (the fire
   bound, the context every one of those statements actually runs under) and `pollCtx` (the
   external slice) — and `fireIssueTriggerBounded` derives the poll deadline *from* the fire
   deadline (`context.WithTimeout(fctx, every)`), so the external calls can never outlive the
   transaction wrapped around them and a caller that drives `PollTimeout` above `FireTimeout`
   gets the fire bound as its real ceiling. The tick's join timer is `FireTimeout +
   issueTriggerFireJoinGrace`.
3. **Both are derived from the tick's context, so D2's shutdown carve-out is untouched**: a fire
   parked on Postgres rather than on GitHub still answers to `ctx.Err()`, and shutdown still
   records nothing. The 60 s beat rule keeps its shape — 30 s fire + 2 s grace < 60 s — with D4's
   server-side `statement_timeout = 60s` still the backstop underneath it.

**Why.** `TestIssueTriggerEveryPassRecordsLastPolled` went red in the full-package `-race` run with
`postgres: lock event journal: timeout: context deadline exceeded` (surfacing as
`postgres: commit issue trigger fire …: timeout: context deadline exceeded`). One deadline had been
serving two different failures at once — "a connection that went quiet" and "a journal append that
is merely slow" — and the number chosen for the first was measuring the second. This ADR's own
**Known limit** says exactly why that second case is normal: the per-project journal lock is still
one advisory lock held to COMMIT (ADR-0014), so under load a fire's append queues behind another
replica's commit and spends seconds doing nothing wrong. The shared bound let that healthy commit
lose a fire it had already created and land a `last_error` blaming a poll that was never hung. The
bounds now measure what they name: a slow commit is measured against Postgres, a hung call against
GitHub, and neither against the other's ceiling.

**What did not change**, and what pins each line:

- **A poll cut loose by its own bound is still a failing beat, and still records its cause** (D2's
  record-on-every-exit rule, verbatim). When the *poll* deadline expires while the transaction is
  healthy, `recordIssueTriggerPoll` lands the precise cause on the row on the fire's own context
  and returns an error carrying the `errIssueTriggerPollRecorded` marker, so the tick reports the
  beat as failed while the detached net is prevented from overwriting that cause with its generic
  cut-loose text. Pinned by `TestIssueTriggerHungPollIsCutLooseAndRecordedAndTickKeepsGoing`
  (unchanged from § Verification) and hung beat 1 of `TestIssueTriggerEveryPassRecordsLastPolled`.
- **A deadline spent mid-listing aborts the fire atomically** — D1's all-or-nothing fire applied to
  a cut-loose poll. `fireIssueTrigger` checks `pollCtx.Err()` for each issue and returns before it
  decides on the degraded `updated_at` proxy (ADR-0056's fallback) with a deadline nobody is
  watching: nothing commits, the cursor does not move, and the `issue-<trigger id>-<number>`
  idempotency keys make the next beat's re-fire safe.
- **A slow-but-healthy commit still fires.** `TestIssueTriggerSlowCommitStillFiresOnce` builds this
  ADR's Known limit on demand instead of waiting for it under load: a second transaction takes the
  project's journal advisory lock — the exact key `AppendEvent` takes, held to COMMIT — and holds it
  past a 2 s `PollTimeout`; the fire's run create queues behind it (a wait latched from `pg_locks`,
  so a fire that never reached the lock fails loudly rather than passing vacuously), and when the
  lock lands the beat has fired EXACTLY ONE run, advanced the cursor, and stayed green.

No schema change, no new dependency, no wire or event change. Two error texts change: the cut-loose
message names both bounds (`issue trigger poll exceeded 30s (poll bound 30s, fire-transaction bound
30s) and was cut loose; …`) and the mid-listing abort adds `issue trigger poll bound of 30s spent
mid-listing: …` (truncated to `maxIssueTriggerErrorLen` as before, no credential material in
either). Evidence is the three tests above, which run against real PostgreSQL through
`COMMUNICATION_TEST_DATABASE_URL` in `internal/store/postgres/issue_triggers_lease_test.go` — this
record changes no code and re-runs nothing. Rolling the amendment back on its own (re-wrapping the
fire in the poll deadline) restores the flake, not the wedge: D1's savepoint path and D4's
server-side bounds are what hold the wedge, and both stay as accepted.
