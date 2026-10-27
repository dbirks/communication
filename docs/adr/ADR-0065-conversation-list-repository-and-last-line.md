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
  **Run-thread arm (seen on the lab):** a thread a run *node* opened usually has
  no conversation-scoped workspace at all — the work happened in the run's own
  workspace (ADR-0017), and only `attempts` link the thread to it — so the
  binding lateral finds nothing and the row used to say `project · agent` with no
  repository at all while its run was plainly working in `tally`. When (and only
  when) the binding is empty, the read falls back to the **linked run's**
  repository: `runs.repository_id` (ADR-0060, served since ADR-0064) joined to
  `repositories.name`, keyed by the run-link lateral's own `la.run_id`. The
  fallback is a fallback, not an override: a thread with a binding of its own
  keeps it, and a thread with neither a binding nor a repository-bearing run
  answers null as before. The extra arm is `cnvRunRepoSubquery`, one `runs`
  primary-key seek plus one `repositories` primary-key seek — no migration, no
  new index, still one statement (ADR-0063).
- `last_agent_line` (`string|null`, ≤ 160 characters): the newest
  `conversation.message.agent` journal row's text (`ORDER BY global_seq DESC`, the
  order the transcript itself renders in), rendered as its first non-empty line,
  trimmed, cut on a rune boundary to 160 runes **with the ellipsis counted inside
  the cap**. Null when the agent has not spoken. This is a preview of the newest
  chunk; the transcript route stays the authority for the whole message.
  **Structured-output arm (seen on the lab):** a run node's agent ends *on its
  structured output*, so the newest chunk is `{"summary": "The repo already had a
  full Node.js…", …}` and the row printed the braces. When the chunk is one JSON
  object — pretty-printed, and/or wrapped in a ` ```json ` fence — the **whole
  message** is parsed first (`cnvStructuredAgentText`: trim, lift the fence, then
  decode exactly one object), and the line is chosen from the object's own values,
  in this order:

  1. a **headline key** — `summary`, `goal`, `title`, `notes`, `reason`, `message`,
     tried in that order — with non-blank string content, looked for at depth 0
     (the object's own members) before depth 1 (one nested object, the shape of a
     schema that wraps its answer: `{"plan": {"goal": …}}`); within a depth, key
     priority wins over document order, so a top-level `notes` beats a nested
     `summary` and a nested `summary` beats a nested `goal`;
  2. else the **first string value** found breadth-first in the object's document
     order (arrays walked too: `"outputs": ["…"]` is the agent's own prose), at
     most three containers deep — past that a string is a schema's field, not a
     line, and the braces are more honest than a guess;
  3. else, when the object holds **no string at any depth**, its top-level scalars
     as `key: value` pairs joined by ` · ` — a reviewer's verdict reads
     `approved: true`, not `{"approved": true,`.

  Whatever that picks is then rendered by the plain rule above (first non-empty
  line, trimmed, 160-rune cap), so a multi-line `summary` is still one preview
  line. Parsing precedes line-taking: the old rule cut the first line *before*
  asking whether the text was JSON, which is why a pretty-printed object printed
  `{"approved": true,`. Anything that is not exactly one object — prose, a
  ` ```go ` or unclosed fence or prose after the closing fence, an array, a chunk
  the worker split mid-object, invalid JSON that merely starts with `{`, an object
  whose only strings are deeper than the bound — keeps the plain rule on the raw
  text, so a message that merely contains a brace is untouched and nothing is
  invented.
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
  more. A split structured-output chunk reads as raw text, because half an object
  is not evidence of a summary. The repository member reflects the workspace
  binding first and the linked run's repository second, so a thread that
  discussed a repository without ever checking it out *or* running against one
  still shows null — the same evidence rule ADR-0053 pins heads by. A run-linked
  thread whose run names no repository (a project-wide run, ADR-0060) shows
  nothing either: there is no repository to name.
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
- `TestConversationListRunThreadRepository` (same file, real PostgreSQL) — the
  run-thread arm on a real linked run (revision → run with `repository_id` →
  node execution → attempt stamped with the thread and its turn): a run node's
  thread with **no** binding resolves the run's repository and its structured
  output resolves to the agent's summary; a bound *and* run-linked thread keeps
  its own binding; a lost binding falls back to the run instead of going quiet;
  a plain thread with neither stays null; and the cross-project read answers the
  same rows.
- `TestCnvLastAgentLine` — the renderer alone: empty/whitespace → none, exactly
  160 stays, 161 truncates, a cut never splits a rune, and the JSON arms: a
  headline key at depth 0 wins in key order (`summary` over `goal`, `title` over
  `reason`), a nested `plan.goal` reads when the top level has no headline, depth
  0 still beats depth 1, a blank `summary` falls through, a pretty-printed or
  ` ```json `-fenced object reads, the first string is found breadth-first (an
  `outputs` array included) but not four containers down, an object with no string
  renders `count: 3 · ok: true`, and prose / a ` ```go ` fence / an unclosed fence
  / an array / a truncated chunk / invalid JSON that starts with `{` / an object
  with trailing prose all keep the raw text — while an extracted line is capped
  exactly as a raw one was.
- `TestConversationListStructuredLastAgentLine` and
  `TestConversationListLastAgentLineNewestChunk` (real PostgreSQL): the four lab
  shapes served on real rows by both list READS — a multi-line reviewer object
  (`reason`), a fenced planner object with a nested `plan.goal`, a no-string
  verdict (`approved: true · blocking: 0 · waived: null`) and a prose thread
  beside them — and the preview following the **newest** chunk in each direction
  (narration then output shows the summary; output then narration shows the
  narration).
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

Amended (2026-10-27, after the same commit was seen on the lab at `a6e06bb`):

1. **`last_agent_line` reads the whole structured reply, not its first line.**
   The shipped rule cut the newest chunk to its first non-empty line and only
   then asked whether the text was JSON, and only ever looked at *top-level*
   strings. A run thread therefore still printed braces and a key path: a
   reviewer's pretty-printed object read `{"approved": true,` and a planner's
   wrapped answer read `{"plan": {"goal": "Add a docstring to add() in ap…`.
   The Decision's structured-output arm is restated: fence first, parse the whole
   message, headline keys at depth 0 then depth 1, first string breadth-first to
   three containers, scalar pairs when there is no string — and only then the
   first-line + 160-rune rule. `api/openapi.yaml`
   (`ConversationSummary.last_agent_line`) and `ui/src/api/schema.d.ts` (generated)
   carry the same text; the plain rule, the 160-rune cap, the null-means-silent
   rule, the SQL, the indexes and the additive-ness of the members are unchanged.
