# ADR-0065 — The thread list serves its repository and the agent's last line: derived at read time, never stored twice

- **Date:** 2026-10-27
- **Status:** Accepted (implemented and verified on real PostgreSQL — see Verification)
- **Owners:** control-plane persistence + web UI maintainers
- **Related decisions / contracts:** ADR-0016 (the conversation surface and its list row), ADR-0043 (`origin`/`run_link` on `ConversationSummary`: "a list row must say it without the detail route's joins"), ADR-0047 (the cross-project `GET /api/v1/conversations` answers the *same* `ConversationSummary` schema), ADR-0017 D1 + ADR-0053 (`workspaces`/`workspace_repos` as the thread's recorded binding; a released workspace keeps it, a lost one's volume is gone), ADR-0016 § 4 / `internal/worker/sink.go` (the transcript is chunked `conversation.message.agent` journal rows), ADR-0063 (bounded database work: a page read pays seeks, not scans), ADR-0013 (forward-only migrations), `communication-spec/09` (the journal is the transcript's authority), `docs/design/handoff-projects` (designs 1b/1g: rows are `project / repo · agent` with the last agent line under the title)

## Context

Both thread surfaces — the Projects overview's RECENT THREADS (1b) and the `/threads`
list pane (1g) — draw each thread as `repo · agent` with the agent's last line under
the title. Neither field existed on `ConversationSummary`, so the UI said so in
words ("the summary carries no transcript text…"), and the project page's repository
rows likewise refused to print the design's `N open issues` because
`GET /projects/{id}/repos` serves no count. The repository *does* exist in the
database — `workspaces` + `workspace_repos` bind a conversation to repositories
(ADR-0017), and the run-from-thread path (ADR-0053) already reads those rows to pin
heads — and so does the last agent line, as the newest `conversation.message.agent`
journal row. What was missing was the *list read* being allowed to reach them without
becoming an N+1.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: derive both onto the list read — one LATERAL per fact, one partial index each (chosen)** | nothing stored twice, so nothing to drift: the binding and the journal stay the single authority; a thread that never ran a workspace or never heard the agent answers `null` because the seek found nothing, not because a flag says so; both list READS (project and cross-project) share the SQL shape and the mapping function | every page read pays two index seeks per row (≤ 100 rows), and the last-line preview is the newest *chunk* — a multi-chunk message shows its tail's first line | implemented; `TestConversationListRepositoryAndLastLine`, `TestCnvLastAgentLine`, `TestConversationSummaryADR0065Fields` |
| B: denormalize `last_agent_message_text` / `repository_name` onto `conversations` (or a new column pair) | the list read stops joining | a second copy of a fact the journal and `workspace_repos` already own: every chunk append or workspace release must maintain it or the list silently rots — exactly the double-bookkeeping ADR-0016 § 4 avoided by making the journal the transcript; and it re-answers a question migration 00019 was written to stop asking | the sink flushes chunks per turn (`internal/worker/sink.go`); a stored copy would need fence-aware updates |
| C: the UI fetches each thread's detail/workspaces to fill the gap | no API change | one request per visible row per page (the N+1 the brief forbids), and the project-scoped list already caps at 100 rows | `useProjectRepoIndex` is today's version of this and only covers *live* workspaces — a released thread shows nothing |
| D: a server-side issue-count column for repositories too | one read serves the count | GitHub answers at most 50 rows with no total, so a stored "count" is a lie past the cap; the honest answer is the live route's own page size | `GitHubIssueList` (api/openapi.yaml): "at most `per_page=50` … no pagination surface yet" |

## Decision

`ConversationSummary` (api/openapi.yaml; `ConversationSummaryView` in
`internal/api/conversations.go`) gains three members, served by **both** list
READS — the project-scoped `GET /projects/{id}/conversations` and ADR-0047's
`GET /api/v1/conversations` (they share `cnvAPISummary`, so the schema cannot
diverge between them):

- `repository_id` / `repository_name` (`uuid|string`, both nullable, both null
  together): the first repository (checkout-path order — the stable one) bound to
  the conversation's **newest** `scope_kind = 'conversation'` workspace row, in any
  state except `lost`. A released workspace keeps its binding (ADR-0017 D1) — a
  finished thread still shows where it worked; a lost workspace's volume is gone,
  so its binding must not be shown. Same rule the run-from-thread head pinning
  already applies (`m4api_runs_write.go`).
- `last_agent_line` (`string|null`, ≤ 160 characters): the newest
  `conversation.message.agent` journal row's text (`ORDER BY global_seq DESC`, the
  order the transcript itself renders in), rendered as its first non-empty line,
  trimmed, cut on a rune boundary to 160 runes **with the ellipsis counted inside
  the cap**. Null when the agent has not spoken. This is a preview of the newest
  chunk; the transcript route stays the authority for the whole message.
- Neither field gates anything: they ride the row's existing visibility predicate —
  a caller who may list a project's conversations may already read those
  conversations' transcripts on the detail and stream routes (same membership), so
  the preview and the binding widen nothing.

Computation is one `LEFT JOIN LATERAL … LIMIT 1` per fact in the list statement —
no N+1, no second query per page. The two seeks are made bounded by **migration
00021**: a partial index over `domain_events` for `conversation.message.agent`
rows (without it a conversation whose agent never spoke walks its whole event
stream backwards on every list), and an index on `workspaces (conversation_id)`
(00004's partial unique index covers live states only and cannot answer a read
that includes `released`). That is ADR-0063's rule for a page read: an index seek
per row, never a scan.

The repository rows' `N open issues` (design 1b) needs **no API change** and is
deliberately *not* an ADR-0065 schema member: `GET
/projects/{id}/repos/{repoId}/issues` already answers it live, and the count is a
UI read (ADR-0065 § UI below) because a stored count past GitHub's 50-row
page cap would be a number nobody served.

## Consequences

- Positive: the thread rows are every design value served — `ThreadListPane`
  (`project / repo · agent`, last line under the row) and the project overview's
  RECENT THREADS (`repo · agent`, served name preferred over the live-workspace
  index, last line under the title) print real fields; a null (unbound, silent,
  or a server predating this contract) falls back to exactly the honest line that
  shipped before.
- `Repositories` (project page) prints `N open issues` per **GitHub** row —
  `isGitHubRepository` decides before any request (a file remote never asks), the
  wording is `no open issues` at 0 and `50+ open issues` at the route's 50-row
  page cap, and a refusal or an in-flight read prints nothing. It uses the
  repository page's own `useRepoIssues` query key, so the two screens share one
  cache entry per repository rather than spending the anonymous GitHub budget
  twice.
- Limitations: the last line is the newest *chunk* — a turn whose flush split into
  chunks shows the tail's first line, and a `workspace:` note chunk counts as
  agent text. Both are honest readings of the journal; neither is fixed by storing
  more. The repository member reflects the workspace binding, so a thread that
  discussed a repository without ever checking it out still shows null — the same
  evidence rule ADR-0053 pins heads by.
- Backwards compatibility: purely additive JSON members; existing clients ignore
  them, and this UI treats *absent* and null identically (the fallback branch).

## Security/privacy

No new authority is consulted: both facts are derived inside the list statement
that already carries the caller's project-membership predicate, for rows the
caller may see (cross-project rows pass the ADR-0047 membership predicate in
SQL). The last line is transcript text, and transcript text is already readable
by every project member via the conversation stream — the preview inherits that
scope and cannot exceed it. Workspace bindings expose a repository name within a
project that already lists its repositories.

## Verification

- `TestConversationListRepositoryAndLastLine`
  (`internal/store/postgres/conversations_list_fields_test.go`, real PostgreSQL):
  a two-repository workspace resolves to the checkout-path-first repository; a
  released workspace keeps the binding; an unbound thread and a lost-workspace
  thread answer no repository; a blank-led padded chunk renders to its first
  trimmed non-empty line; a 280-rune multi-byte first line truncates to exactly
  160 runes ending in `…`; and `ListVisibleConversations` (the cross-project
  read) answers the same three fields for the same rows.
- `TestCnvLastAgentLine` — the renderer alone: empty/whitespace → none, exactly
  160 stays, 161 truncates, a cut never splits a rune.
- `TestConversationSummaryADR0065Fields` (`internal/api/conversations_test.go`):
  the route serves the three keys with values when the store has them and as
  literal `null`s (never omissions, never empty strings) when it does not.
- UI (`ui`): `Threads.test.tsx` proves the served row (`project / repo · agent`,
  last line) and both fallbacks (nulls and an older server's absent fields);
  `Project.test.tsx` proves RECENT THREADS prefers the served repository over the
  workspace index and draws the served last line, and proves the repository-row
  counts (`3 open issues`, `50+ open issues` at the cap, `no open issues` at 0,
  nothing on refusal, and **no request at all** for a non-GitHub remote).

## Migration/rollback

Migration `00021_conversation_list_reads.sql` is two `CREATE INDEX` statements
(one partial); it takes no locks beyond a brief `SHARE` per table and can be
reverted by its Down section (drop the indexes) with the reads degrading to
sequential scans rather than failing. The API members are additive: an older
database plus newer code answers every row as null (both latters simply find
nothing — well, the repository lateral still resolves from `workspaces`, which
exists since 00004; only the *indexes* are new), and newer database plus older
code ignores them. Roll back by reverting the view/scans; nothing stored changes
shape.
