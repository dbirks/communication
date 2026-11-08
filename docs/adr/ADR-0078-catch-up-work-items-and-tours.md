# ADR-0078 — Catch up: one shared tour per piece of work, per-user seen state keyed on stable stop ids, and decision replies that are plain text into an agent conversation

- **Date:** 2026-11-07
- **Status:** Proposed (step 1 shipped schema, store and contract; § Grouping
  makes the work item an issue/PR/push rather than a run. The generator that
  writes tours and the routes that serve them are later tasks; see
  Migration/rollback)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0013 (forward-only migrations),
  ADR-0014 § 3 (a refusal is audited and never leaks existence), ADR-0034 /
  ADR-0050 (the assistant that writes these sentences, over the secret-scanned
  egress), ADR-0052 (model writes, human decides — a decision reply reuses that
  shape and must not be confused with it), ADR-0063 (bounded database work),
  ADR-0071 (the per-user / shared split and the "the write path enforces what a
  CHECK cannot" argument, both reused here), ADR-0016 + ADR-0021..0024 (runs,
  gates and the fixed approval verbs a decision reply is NOT),
  `communication-spec/09-api-events-data.md` (the tables below are store
  tables, not event types), the design handoff's "Catch up" page.

## Context

An engineer leaves for four hours and the agents keep working. When they come
back they have one question — *what happened while I was away?* — and every
answer the current surface can give is a list: runs by status, conversations by
recency, artifacts by kind. A list makes a person re-read machine output to
reconstruct a story that the machine already watched happen.

The design's answer is a page with a model-written narrative on it, which puts
four problems on the table at once, and each one has to be decided before a
generator or a route can exist:

1. **Who owns a story.** A tour that describes a project's code cannot
   sensibly have 12 versions, one per reader: two engineers on the same project
   would be reading different accounts of the same commits, and "has anybody
   seen this?" becomes unanswerable. But if the story is shared, then the
   reading state cannot be shared — one person marking a beat read must not
   mark it read for the team.
2. **What a rewrite does to reading.** The story is rewritten as the work moves
   (a fix lands, a beat is added), so either reading state is thrown away at
   every rewrite — and a person who read six beats re-reads six beats because a
   seventh appeared — or reading state has to be keyed on something that
   survives the rewrite.
3. **What a question is.** Some beats end with "YOUR CALL": the agent chose a
   branch, and it wants to be told if that was wrong. The platform already has
   a thing that pauses work and asks a human — the workflow gate — and reusing
   it is the obvious move. It is also the wrong one: a gate carries fixed verbs
   (`Approve` / `Request changes` / `Reject`), a decider, a run state that moves,
   and an audit consequence. "Which branch should this have gone to?" is not
   that. It is a sentence, and the answer is a sentence back.
4. **What the model is allowed to be.** The narrative, the importance labels and
   the evidence list are model output about text the model does not control,
   including text in repositories (ADR-0071's injection argument, one page
   later). Nothing on this page may execute, navigate, or decide.

There is also a smaller product constraint that shapes the schema: there is **no
GitHub sync** in this design. The page describes what the platform saw — its own
runs, its own repositories — and labels the rest.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: shared versioned tour + per-(user, stop id) seen state with the version recorded; decisions stored as text (chosen)** | one account per project; a rewrite neither resurrects read beats nor hides new ones; a reply is a fact with an owner and a destination | seen state is a join over a jsonb document; the model must be told to keep stop ids stable | implemented; `internal/store/postgres/catch_up_test.go` |
| B: one tour per (work item, user) | seen keyed on the tour itself, no stable-id rule | N copies of one story, N model calls, and two members of a project reading different accounts of the same commits; "who has seen this?" is per-reader and so useless for a team | the design's shared tour + the seen roster |
| C: seen keyed on (user, work item, tour version) — a version is read or it is not | one row per read, no jsonb | every rewrite re-asks for every beat it carried over, including the four the reader already saw. A story that moves is a story that must be re-read whole | the design's UPDATED badge, which only means anything if part of the item is already read |
| D: a *current* tour row, rewritten in place, plus a `seen_version` on the work item | one row, no join | the previous account is gone: no answer to "why did this change", and a rewrite silently re-orders what a reader had already trusted | ADR-0071 kept a dismissed note rather than overwriting it, for the same reason |
| E: a decision reply *is* an approval gate | reuses the decider, the audit, the notification path, the UI | a gate's verbs are fixed and its answer moves a run; a beat's question has model-chosen options and its answer is text for an agent. Making it a gate means either a run that nobody asked to gate, or a gate that authorizes nothing — the second is a lie in the ledger | ADR-0052: the model never decides; a human's *interpretation* is separate from a decision |
| F: sync issue/PR state from GitHub into the refs | the page could say "still open" truthfully | a credential, a poll, a reconciler, and a failure mode where the page is wrong because the API was; and the platform already knows what *it* did | the design's "no GitHub sync" |
| G: model output as structured commands (a stop carries a url / a tool call) | richer stops | ADR-0071's exact refusal, one page later: repository text becomes an instruction | ADR-0071 § Options D |

## Decision

1. **Six tables and one column** (migration `00028`).
   `catchup_work_items` — one piece of work, `shape` CHECKed to
   `issue | pr | push` (an issue with its PRs and commits nested, a PR with no
   issue, commits on the default branch with no PR), a title, a one-line
   summary, a `resolution` CHECKed to
   `merged | branch_ready | open | run_failed | no_code`, `refs` (a jsonb object
   of issue numbers, PR numbers, commit SHAs and run ids), `source_run_id` and
   `conversation_id`, and `updated_at` — the clock "since T" filters on.
   `catchup_tour_versions` — `PRIMARY KEY (work_item_id, version)`, a `reason`
   ("Fix landed, stop 3 added"), and `stops` jsonb CHECKed to be an array of
   1..24. `catchup_seen_stops` — `PRIMARY KEY (user_id, work_item_id, stop_id)`
   with `tour_version` recorded. `catchup_recaps` (per user, with `window`,
   `project_ids[]`, `written_at`), `catchup_visits` (per user, per visit) and
   `catchup_decision_replies`. Everything cascades from `projects` and `users`
   the way `00027` cascades from both.
   `projects.color` is nullable with a CHECK against the eight-hue palette; the
   reads fall back to a deterministic pick **by project id** (not by name, not by
   creation order, so it cannot shuffle between replicas or after a rename), and
   nothing is backfilled — a NULL is "nobody chose", which a reader can tell from
   a choice, which a backfill would erase.
2. **A tour is a version history, not a row.** `AppendTourVersion` writes
   `previous + 1` and nothing else: the insert admits its row *only while
   `version - 1` is still the newest*, in the statement that reads that fact, so
   concurrent appends produce 4 and 5 rather than 4 and 4 and no version is ever
   skipped (the loser recomputes and retries, bounded). Overwriting a tour in
   place would destroy the only evidence of why the story changed, which is
   exactly the sentence the page shows beside an UPDATED badge.
3. **Stable stop ids are the hinge.** Each stop carries a model-chosen `id` that
   survives rewrites, plus `added_in_version` — stamped by the store for any stop
   that does not declare one, and refused if it declares a version that cannot
   exist yet. A stop is **read** for a user when a seen row exists whose recorded
   `tour_version >= added_in_version`. That single rule is what produces the four
   behaviours the design asks for: a carried-over beat that was read stays read;
   a beat new in the newest version is unseen; an item whose tour moved since you
   read it comes back as UPDATED (`EXISTS` a seen row at an *older* version) with
   only its new stops owed; and "seen" means every stop of the newest version is
   read. `MarkStopsSeen` reads the ids **out of the named tour version** rather
   than trusting the caller, so an unknown stop id or version marks nothing at all
   (`ErrCatchUpNotFound`) instead of writing a seen row that will never be
   counted; `MarkAllSeen` merges with `GREATEST(current, new)` so the button can
   never *demote* a reader's recorded version.
   `Kind` ("BUG · FIXED", "UI CHANGE", "YOUR CALL") and the evidence payload
   beside each stop's `type` are deliberately **not** CHECKed vocabularies: they
   are labels the model picks, and freezing them would be the rule-writing the
   design rejects. Only `importance`
   (`must_know | worth_a_look | routine`) is closed, because ranking is rendered
   from it.
4. **A decision reply is text with an owner and a destination.**
   `catchup_decision_replies` stores (work item, stop id, user, text) plus the
   `conversation_id` **copied from the work item at write time** — never from the
   caller, which is what stops a reply being posted into a thread its author
   chose. The write refuses a stop that is not in the item's *newest* tour and a
   stop whose stop object carries no `decision` object. A later task posts the
   text, unchanged, as an ordinary message in that conversation (ADR-0016's
   conversation path, with its controller, permission modes and audit intact);
   this table is the record, not the delivery. It is **not** a gate, and the
   difference is not cosmetic: a gate carries the fixed verbs Approve / Request
   changes / Reject (ADR-0052's `decideApproval`), a decider whose identity
   authorizes something, and a run state that moves when it is answered. A beat's
   question carries model-chosen options, authorizes nothing, and its answer
   changes no run state — the receiving agent may act on it, which is the whole
   point, and may ignore it. Wiring the two together would let model-written
   prose vote on a workflow, or force a beat's free-text answer into three verbs
   that were never about it. Storing it separately keeps both honest.
5. **The story is shared; the reading is not.** `catchup_tour_versions` has no
   `user_id` column at all, so a tour cannot be personalized even by accident, and
   ranking comes from `importance` — the same for everybody on the project, which
   is what lets "2 of 4 have seen this" be a true sentence. `SeenBy` reports the
   members who have finished the *newest* version, and only to a caller who can
   see the item.
6. **No GitHub sync.** `refs` is a jsonb object of the assistant's own claims —
   issue numbers, PR numbers, commit SHAs, run ids — with no reconciler and no
   constraint that they still exist upstream. The page describes what this
   platform observed. A PR closed on GitHub after the tour was written does not
   make the tour a lie about our database; it makes the tour a dated account,
   which is what a version history with `created_at` already is.
7. **Model output, rendered as text.** The store validates the tour document on
   the way in (bounded lengths, 1..24 stops, unique stop ids inside a version,
   closed `importance` and evidence `type`, 1..4 decision options) and re-validates
   on the way out, failing the read rather than serving a stop that half-parsed:
   a reader trusts the beats they can see, so a corrupt one must not appear as a
   normal one. A narrative is never re-read as an instruction here, an evidence
   object carries no url and is never navigated to (its `type` is one of four
   kinds and its payload is rendered by whichever client owns that kind), and a
   `decision` is a question whose options are strings, not actions. The generator
   that writes these rows is ADR-0034's bounded completion over secret-scanned
   egress and treats transcript and repository text as data (ADR-0071 § 6 is the
   precedent); nothing about this schema lets it be anything else.
8. **Authorization is project membership, and there is no second tier.** Every
   read and write carries the caller's own `visible` predicate — the caller's
   organization AND (org admin OR `memberships`) — joined in the statement itself,
   the ADR-0071 shape. Consequences, all intended: a work item in a project you
   are not in is `ErrCatchUpNotFound`, the same answer as no work item, so
   existence never leaks across membership (ADR-0014 § 3); a `viewer` sees the
   page (they see the repository); a `ListUnseenWorkItems` request naming a
   project the caller is not in is **intersected**, so naming a project can only
   narrow a result, never widen one; and a `MarkAllSeen` with no project list is
   "everything I belong to", not "everything".
   Personal state (`catchup_recaps`, `catchup_visits`) needs no project at all —
   it is a fact about a reader — and is read with the reader's own id as part of
   the query, not as a filter the caller may omit.
9. **`source_run_id` and `conversation_id` carry no foreign key**, for two
   different reasons that point the same way. Runs are pruned by retention, and
   the record of what a pruned run *did* must outlive it; deleting a thread must
   not erase the decision reply that was meant for it. Neither id is a join key in
   any read here — the work item's project already scopes both — and both are
   uuid-typed so an id a reader follows is at least an id. Provenance never moves:
   both columns are `COALESCE`d on the upsert, because which run made which work,
   in which thread, is a fact and not a field to revise. (§ Grouping narrows
   this: `conversation_id` still never moves, while `source_run_id` came to mean
   the item's LATEST run once one piece of work could hold several runs.)

## Grouping

**Status: Proposed** (migration `00029`, store, generator; the product brief's
"one piece of work" wording is what this section implements).

The design says a piece of work is an **issue with its PRs and commits nested
under it**, a **PR only**, or a **push to main**, and that its tour "is
rewritten as the work moves, with versions and new stops marked ADDED". Step 1
keyed the work item by `(project, source_run_id)` — which was the engine's
vocabulary, not the product's. Two runs on the same issue (the issue-to-pr
template run twice, or a fix run after a failed run) became two items with two
tours, and the reader had to reconstruct the grouping the design had already
decided. Grouping moves the identity onto the work:

1. **The key is derived from the run's own refs, never from its narrative.**
   `domain.CatchUpGroupKey(repositoryID, issueNumber, prNumber, runID)` yields
   `issue:<repository>:<number>`, else `pr:<repository>:<number>`, else
   `run:<run id>`. The numbers come from the same server-side read of the run's
   inputs (the issue-trigger's typed `issue_number`) and node outputs
   (`issue_number`, `pr_number`, the tail of a `pr_url`) that produces the
   `refs` — the model's answer has no member to put a key in, so naming your way
   into somebody else's story is unrepresentable rather than filtered. An issue
   number means nothing outside a repository, so a run that names a number but
   belongs to no repository keeps its own key; two repositories' #7 are two
   pieces of work.
2. **`catchup_work_items.group_key` is the identity, `source_run_id` is the
   latest run.** The (project, group_key) partial unique index is the upsert's
   conflict target; `catchup_work_item_runs (work_item_id, run_id, added_at)`
   records every run folded into the item, with no foreign key on `run_id` for
   the same reason `source_run_id` has none (retention prunes runs; the record
   outlives them). Where 00028 COALESCEd `source_run_id` so provenance never
   moved, grouping moves it deliberately: once several runs share one piece of
   work, "the run this came from" has several honest answers and the newest is
   the one a reader follows. `conversation_id` still never moves — a decision
   reply belongs to the thread the work was BORN in, not to whichever run moved
   it last.
3. **Claims are written by the tour, not by the item.** Appending a version is
   what records `(item, run)`, in the statement that admits the version. If the
   item write claimed the run and the completion then failed, the run would be
   unclaimed-by-nobody and untold forever: a transient model error would cost
   the work for good. So "a run is owed a story" means exactly *no tour version
   of the item that claims it was written after the run's newest move*, and a
   candidate read that says so is one `NOT EXISTS` over the claim table.
4. **A rewrite sees the story it is rewriting, without seeing its prose.** The
   generator's DATA block gains a `previous_tour` member — each stop's *title,
   kind and importance* and the version that introduced it, never the narrative.
   Shown verbatim, the old beats would become the model's source material and a
   rewritten tour would drift into a summary of a summary; shown as labels, the
   model rewrites from the facts of the work and keeps the titles that still
   hold. Stop ids stay the server's, matched by title as before, so a carried
   beat keeps its id and its `added_in_version` (read stays read) and a genuinely
   new beat is stamped at the new version — which is what the UI's ADDED tags and
   UPDATED badge already read. The version's `reason` is what CHANGED ("Fix
   landed after the failed run"), because the reader knows the rest.
5. **Refs merge; they do not replace.** A second run's claims are unioned into
   the item's (`domain.CatchUpRefs.UnionWith`, deduped, insertion-ordered,
   `CatchUpRefsListMax` per list), so the PR the first run opened survives the
   fix run that closed it. The merge is a read-modify-write rather than one
   statement: two replicas grouping the same issue in the same instant can lose
   one number from the document. That is the limit to name — no run can land in
   the *wrong* item, because the unique index decides the row and not the read,
   and what a lost entry costs is a label on a story rather than a state the
   platform drives (§ Decision 6).
6. **Grouping is decided at the first telling and never revised.** An item keeps
   its `group_key` for life (`COALESCE`d on every write, so a later run can fill
   in a key an older row never had but cannot move one that exists), and
   `00029` backfills existing rows with `run:<source_run_id>` — the identity
   they were already keyed by — rather than re-deriving issue keys from stored
   `refs`. Re-deciding old groupings would move stops between documents that
   readers have already read, which is the one thing § Decision 3 exists to
   prevent.

Rejected within grouping, because the table made it look cheap: keying on
`(project, issue_number)` with no repository (two repositories' #7 would be one
story); a `run_id` foreign key plus cascade (a pruned run would take the story of
what it did with it); claiming the run at the item write (a point-4 failure
becomes permanent); and putting the key in the generator's answer (a tour that
can name its own destination can attach a run to work it did not do).

## Consequences

- The page is possible: unseen-per-user over shared tours, UPDATED badges that
  mean "the story moved", a seen roster, a per-visit recap cache, and a window
  suggested from real visit history rather than a hard-coded 24 hours.
- The seen count is a join over a jsonb document (`jsonb_array_elements` of one
  tour version per item, then an anti-join per stop). It is bounded by the tour
  itself — 1..24 stops, one version per item — so the read shape cannot run away,
  and the indexes exist for it (`(project_id, updated_at DESC)`,
  `(work_item_id, version DESC)`, `(work_item_id, user_id, tour_version)`). If a
  future product raises `CatchUpStopsMax` by an order of magnitude, this becomes a
  table rather than a document, and it will be a different argument.
- Tours accumulate versions and nothing prunes them: a work item rewritten 20
  times is 20 rows. That is intentional for now (history is the product), and a
  retention window will have to be chosen against the generator's evaluation
  needs rather than as a janitor's convenience.
- Duplication is refused for the story and accepted for reading state, which is
  the opposite of ADR-0071's choice — because a note is advice to a person and a
  tour is an account of shared work.
- The platform is now asserting, in prose, what its agents accomplished, and it
  can be wrong: the narrative, the resolution and the refs are a model's claim
  with no state behind them. `resolution` is CHECKed as a *vocabulary*, not as a
  fact. Every sentence on the page is falsifiable by the diff it describes, which
  is why a stop's evidence is stored at all.
- A decision reply with no conversation is stored and goes nowhere. That is
  honest (the question was asked, the answer was given) and it is also a dead end
  the UI must show as one, rather than as "sent".
- Ranking is shared, so an engineer cannot promote their own work to the top of
  somebody else's page — and equally cannot demote a colleague's. Importance is
  the tour's opinion, once, for everybody.

## Security/privacy

Tours are read by every project member, which means model-written prose about a
person's code is visible to their colleagues. It is not visible outside the
project: every read is membership-scoped in its own statement, and a stranger
(inside the organization or out of it) gets the same empty result and the same
not-found as a deleted row — no existence leak, no `403` that confirms a project
has catch-up content (ADR-0014 § 3). Per-user state is never shared and never
queryable by another user: `LatestRecap` and `RecentVisits` carry the caller's id
into the `WHERE` rather than accepting one.

`SeenBy` is a presence indicator — "who has read this" — inside a project whose
members can already see each other's commits, runs and conversations, so it adds
no new axis of surveillance; it is deliberately unavailable to non-members, and it
lists readers rather than non-readers.

Nothing here carries a secret, a path, a worker identity or a lease fact. No
model output on this page can execute: no url, no action union, no tool call. The
one write path that reaches the agent runtime is a decision reply's *text*, which
is posted as an ordinary user message and is therefore subject to everything that
governs an ordinary user message — the conversation's controller, its permission
mode, its audit rows and ADR-0016's fencing. A reply authorizes nothing by itself:
answering "which branch?" is not approving a run, and a reply carries no decision
enum precisely so it cannot be mistaken for one.

The `projects.color` CHECK is a small allowlist rather than a colour grammar
because the set is the design's, and the reason for the set — none of the eight
may be a state hue — is a legibility rule a grammar cannot express.

## Verification

`internal/domain/catchup_test.go` (no database): the four closed vocabularies
refuse their near-misses (`commit`, `shipped`, `important`) and the open ones do
not exist as enums; a tour refuses a repeated stop id, an empty or runaway stop
list, an over-long narrative, and a stop whose `added_in_version` is in the
future; an unstamped stop is refused once a version is named, and stamping fills
only what is silent; a decision refuses 0 and 5 options; evidence survives a JSON
round trip with its opaque members and with the server's `type` winning over a
`type` smuggled into the payload; the colour fallback is deterministic per id,
palette-bound and case-insensitive, and a chosen colour is never overridden while
`""`/whitespace is treated as unset.

`internal/store/postgres/catch_up_test.go` (real PostgreSQL; skipped unless
`COMMUNICATION_TEST_DATABASE_URL` is set, run by CI on PostgreSQL 18, which is
the only way any of it is actually known): a work item with no tour is
unpresentable and appears in nobody's list; a first tour is version 1; unseen
counts and the seen/unseen flip on `MarkStopsSeen`; `includeSeen` reads the same
row with nothing outstanding; **the rewrite that is the whole argument** — v2
carrying `s1` and adding `s3` leaves alice with exactly 1 unseen and `updated =
true` while bob, who never read v1, owes both beats and is not `updated`; v3
adding `s4` owes alice only `s4`; marking an unknown stop id or an unknown
version marks nothing; `SeenBy` lists the reader who finished the newest version
and not the one who did not, by name and time; `MarkAllSeen` clears the caller's
own list and nobody else's and cannot resurrect a read beat after a rewrite;
outsider and other-organization users get nothing from all seven methods, and
naming a project cannot widen a list; a malformed uuid is a validation error
rather than a 500; five concurrent appends produce versions 1..6 each exactly
once; the run id is still a re-grouping key when nothing else names the row (one
item, not two) and a revision that names no run does not move provenance; an
explicit id revises that row and an id naming nothing writes nothing; three refused appends leave the head at 1; refs, evidence and narrative
round-trip; recaps and visits are per user and regeneration keeps the earlier
row; every palette colour stores and a state hue, a padded or an unprefixed one
fails `projects_color_check`; a hand-corrupted `importance` fails the read where
`stops = '[]'::jsonb` and a non-array document are refused by the table's own
CHECK; and dropping a project or a reader cascades the work items, tours, seen
rows, replies, visits and recaps with them.

`TestCatchUpGrouping` (same real PostgreSQL) is § Grouping as a data rule: two
failed runs whose refs name issue 42 in one repository write ONE work item
(`again.ID == item.ID`), both runs end up in `catchup_work_item_runs`, the
served `refs` hold both runs' issue/PR numbers and both commit SHAs, the item's
`source_run_id` names the later run, its history is two versions with the second
`reason` saying what changed, and its newest tour carries the old beat at
`added_in_version` 1 and the fix at 2; a run that names no number keeps its own
item; the same key in a second project the caller belongs to is a second item;
a run with no key at all still re-describes the one row the pre-grouping index
names; and a made-up key is a validation error. The candidate read is asserted
on both sides of a claim: an item with no tour has not told its run, and after
the rewrite neither run comes back.

`internal/assistant/catchup_gen_test.go` (fake model, no database) pins the
generator half: a run whose facts carry `issue:repo-1:42` asks for the item that
key names, and the rewrite it writes back is version 2 with the carried beat's
id and introducing version intact, the new beat stamped ADDED, and the item's
own conversation (not the newest run's) as the destination of a decision; the
prompt block carried the previous stops' titles, kinds and importance and NOT
their narrative; a first telling carries no `previous_tour` at all and stamps
version 1.

Plus `go build ./...`, `go vet ./internal/store/... ./internal/domain/...`,
`gofmt -l internal/` (empty) and `go test ./internal/domain/...`.

Not verified here, and not claimed: the generator (what writes the tours, and
whether its narratives are true), the HTTP surface, and the page itself. Every
row of the protocol-compatibility sense of "done" for this ADR arrives with those.

## Migration/rollback

`00029_catch_up_grouping.sql` adds `catchup_work_items.group_key` with its
partial unique index and the `catchup_work_item_runs` claim table (§ Grouping),
backfilling both from the `source_run_id` the rows already carried; it changes
nothing else.

`00028_catch_up.sql` adds six tables, `projects.color`, and the four indexes the
reads above need; it changes no existing column semantics and breaks no existing
reader — the whole surface is additive, so no route, event or existing schema
changes, and an older replica simply has no catch-up data to serve. Per ADR-0013
it is forward-only; the `Down` section exists for test resets only, and reverting
a deployed replica means dropping the six tables and the column, which discards
reading state and tour history — an operator decision, not a rollback script.

Rolling out is: this change (schema + store + contract), then the generator
behind ADR-0034's egress (a project with no configured egress produces no tours
and therefore an empty page, never a stub), then the routes —
`GET` the unseen list, `GET` one work item, `POST` seen, `POST` mark-all-seen,
`POST` a decision reply (which performs the conversation post), `GET`/`POST` the
recap, and the visit stamp — each with the same membership predicate this store
already applies, and each audited at the store where a refusal is the only row
that knows which project it refused. The colour is read through
`domain.CatchUpProjectColorOr`, so the UI never has to know the palette or the
fallback rule; mounting the routes is outside this change's files.

**Trigger** (post-acceptance fix). The generator is scheduled by `POST
/api/v1/catch-up/visits` — opening the Catch up page — and by nothing else:
the list read no longer triggers it. The badge the sidebar draws reads
`GET /catch-up/items` on every page of the app, and a list trigger spent a
model call per page load until the lab's gateway rate-limited the assistant
and the agents with it (429). The read is still a pure read; the pass is
still at most two generations with the per-run cooldown
(`COMMUNICATION_CATCHUP_GEN_COOLDOWN`), and a per-replica global cap now
bounds it too: at most `COMMUNICATION_CATCHUP_GEN_PER_10M` (default 6, 0
disables generation entirely) generation model calls per ten minutes, a pass
the cap refuses logged rather than left silent.
