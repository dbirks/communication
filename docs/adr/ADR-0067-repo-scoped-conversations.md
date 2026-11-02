# ADR-0067 — A conversation may be born bound to one repository, and the thread list filters by it: the declared binding, recorded once, ahead of the read-time derivation

- **Date:** 2026-10-28
- **Status:** Accepted (implemented and verified on real PostgreSQL — see Verification)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0016 (the conversation surface; create = conversation + controller + first turn in one transaction), ADR-0043 (`origin`/`q` list filters — this filter rides their shape), ADR-0047 (the cross-project `GET /api/v1/conversations` answers the *same* `ConversationSummary` schema, so the binding rides it too), ADR-0053 (run-from-thread reads the same workspace binding), ADR-0060 (`runs.repository_id` + the composite-FK precedent on `assignments`), ADR-0063 (bounded database work), ADR-0065 (the read-time repository derivation this amends with a first arm), ADR-0013 (forward-only migrations), migration `00022`; design source `docs/design/handoff-repo-chat-nav/` (README § "Repo page, List view (3a)" — "Needs a repo filter on conversations"; DECISIONS.md — "Chats default to a repo")

## Context

The repo page (design 3a) shows one activity feed of **runs and chats for this
repository** and a chat box whose `Start` "creates a conversation scoped to
*this repo* (chosen agent profile, first message) and navigates to it". The
API answered neither half:

1. `GET /projects/{id}/conversations` had `origin` and `q` (ADR-0043) but no
   way to ask for one repository's threads. ADR-0065 already *serves*
   `repository_id`/`repository_name` per row by derivation — a UI-side filter
   over a 100-row server cap is not a filter, and ADR-0065's row says nothing
   about a thread that has no workspace and no run yet.
2. `ConversationCreate` carried `agent_profile_id`, `title` and an optional
   `prompt`, but no repository. Binding existed only as the worker's
   `workspaces`/`workspace_repos` rows (ADR-0017), which an API replica cannot
   write: they require worker/volume/path/commit facts the create request does
   not have. So the repo page could not start a thread "in" its repo, and the
   ADR-0065 derivation could not answer one until a worker had prepared a
   workspace.

The binding the design asks for is *declared intent* — "this thread was
opened FOR this repository" — which is exactly the fact `runs.repository_id`
(ADR-0060) records once at creation, and exactly as unreadable-by-derivation:
the same honesty that refuses to backfill `runs.title` refuses to guess a
binding from a later checkout.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: nullable `conversations.repository_id`, written in the create transaction, composite FK to `(id, project_id)` like `assignments`; the list READs and the filter resolve it FIRST, then fall back to ADR-0065's derivation (chosen)** | one request answers the design's Start; the fact is recorded once at creation and never re-derived (ADR-0023 § 2's pin-at-creation rule); "repo belongs to the project" becomes a database fact (the composite FK, 00015's precedent), so no caller can bind a foreign repository even by skipping the store; every pre-ADR-0067 row is NULL and keeps ADR-0065's answer verbatim | a second repository *source* — the chain order must be pinned in prose or display and filter drift apart | migration `00022`, `TestConversationCreateInRepositoryAndListFilter`, `TestConversationRepositoryBindingPrecedence`, `TestConversationRepositoryFilterUnknownAndForeign` |
| B: filter on the ADR-0065 derivation only (no create binding) | zero schema | a just-started repo chat appears in no repo until a worker prepares a workspace — the feed would not show the row the UI just created and navigated to; and the derivation's workspace arm ignores *intent* (the worker checks out every project repo, so "first by checkout path" is alphabetical, not chosen) | the brief's own acceptance ("the list filter then finds the new thread") fails |
| C: have create write a `workspaces` row in `preparing` | reuses the binding table | impossible without lies: `workspaces` requires `worker_id`, `volume_id`, `root_path` and `workspace_repos` requires mirror/admin/commit facts only the worker learns at Prepare (ADR-0017); an API-side stub would fail 00004's CHECKs or poison the one-live-workspace index | 00004's column definitions |
| D: a `conversation_repos` join table | multi-repo threads later | the design scopes a chat to exactly ONE repo ("this repo"); a join table is double bookkeeping for a 1:0..1 fact, and every read pays a join today to buy a maybe | DECISIONS.md "Chats default to a repo" |

## Decision

1. **Binding.** `conversations.repository_id` (migration `00022`, nullable
   uuid) records the repository the conversation was created bound to,
   written once in the create transaction and never changed by any API path —
   the same rule `runs.repository_id` carries. The FK is composite,
   `(repository_id, project_id) → repositories (id, project_id)` (the
   `assignments_repository_fk` shape from 00015): the repository **must belong
   to the conversation's project** as a database fact, not a caller's promise.
   The referenced key `(id, project_id)` has been unique since 00012's
   `repositories_id_project_unique`, so the migration adds no index.

2. **Create.** `ConversationCreate` gains an optional `repository` member: the
   repository **name**, project-unique, same pattern addRepository validates
   (`^[A-Za-z0-9._-]{1,100}$`, and the same `.`/`..` traversal refusal). Name
   rather than id: the repo page routes by name (`/p/:projectId/:repo`), the
   list filter names repositories the same way, and names are immutable today
   (`RepositoryPatch` touches only the credential). One `POST` therefore does
   what the design's `Start` button asks: conversation + controller + binding
   + first message, in one request.
   - **Validation:** the store resolves the name against
     `repositories (project_id, name)` inside the create transaction, before
     anything is written. A malformed name is a 422 from the handler; a name
     the project does not have — **including another project's repository,
     answered identically** so a foreign name leaks nothing about who else has
     it — is `422` ("no such repository … in this project"), the same shape as
     the unknown-profile refusal. The composite FK is the second gate, not the
     first. Membership is unchanged from ADR-0016: contributor or maintainer,
     a viewer gets 403, a non-member gets the project's 404.
   - **First message:** unchanged from ADR-0016 § 2 and proven still so with a
     binding: the optional `prompt` is enqueued as **turn 1 under the
     starter's control** — the caller is controller at version 1, the turn
     row is `queued` with `submitted_by` = the starter, and
     `conversation.message.user` is journalled in the same transaction. The
     binding names what the thread was opened for; it launches nothing.

3. **Filter.** `GET /projects/{id}/conversations` gains a `repository` query
   parameter (the repo name). The store resolves name → id on the project's
   unique `(project_id, name)` index (one seek per page, never per row); a
   well-formed name the project does not have is `404` (a filter naming a
   missing resource answers like the missing resource — never an empty 200
   that pretends it exists), and a malformed one is `400`
   `invalid_repository` before any lookup (the `invalid_origin` discipline).
   A **query** filter is 404/400 while the **body** field is 422 on purpose:
   a query parameter names a target that can simply not exist; a body member
   the client invented is a wrong field.

4. **One chain, list and filter alike.** Both list READS resolve
   `repository_id`/`repository_name` through one COALESCE and filter against
   the same expression, so a thread always appears under exactly the
   repository its row names:
   **declared binding (ADR-0067) → workspace binding (ADR-0065) → linked
   run's repository (ADR-0065's run-thread arm) → null.** A declared binding
   outranks a later workspace checkout — "which repo was this opened FOR" is
   not amended by a volume fact — while every row that predates this ADR (or
   never declared) is untouched: its `repository_id` is NULL and ADR-0065's
   derivation answers exactly as before. The id and the name stay one fact:
   the declared binding's name is read off the same `repositories` row its id
   points at (a primary-key `LEFT JOIN`, no second lateral per arm), so an
   id is never paired with another arm's name. The filter composes with
   `origin`/`q` (all three AND together).

5. **No new index, on evidence.** The filter predicate is
   `COALESCE(c.repository_id::text, repo.repository_id, runrepo.repository_id) = $4`
   — a computed expression the planner cannot reduce to an index on
   `conversations.repository_id` alone (the derivation arms must be evaluated
   per row anyway, and they already ride 00021's seeks). EXPLAIN on the
   shipped statement with a seeded project of 240 conversations (100 declared
   to `expla-a`, 60 declared to `expla-b`, 80 unbound of which 20 own a ready
   workspace checked out to `expla-b`): with the filter ON, `Limit ← Sort ←
   Nested Loop Left Join` over `conversations_project_created_idx`, ~1.4 ms
   and ~550 shared-buffer hits per page, 100 rows for `expla-a` and exactly 80
   (60 declared + 20 derived) for `expla-b`; with the filter OFF the plan
   streams `LIMIT 100` without the Sort, 0.8 ms. The filter changes only
   which rows survive the per-row seeks — never a scan the page was not
   already paying (ADR-0063). A partial index on `(project_id,
   repository_id) WHERE repository_id IS NOT NULL` cannot serve the chain and
   would be dead weight — `conversations.repository_id` is never a standalone
   predicate.

6. **The detail route stays as ADR-0065 left it.** `Conversation` (detail)
   gains no repository members here: the thread rail reads list rows (which
   carry them), and ADR-0065's own detail-route reasoning still holds. The
   `conversation.created` payload is unchanged — the **row** is the binding's
   authority, and re-stating it in the journal would be a second copy.

7. **What the binding is NOT (yet):** a restriction on the agent's workspace.
   The worker prepares a conversation workspace from the project's repository
   index (`turnloop.go` `ProjectRepos`), so a repo-scoped thread can still see
   its project's other repositories until the worker is taught to scope
   checkouts by `conversations.repository_id` (that worker change needs no
   schema or API change — the binding is already readable). It is also not a
   run default: ADR-0053's hand-off still resolves bases per repository from
   the workspace binding. Both are honest extension points of "the thread was
   opened for this repo", not contradictions of it.

## Consequences

- Positive: the repo page's `Start` is one request, its feed is one request
  (`?repository=<name>`), and the new thread is in that feed before any
  worker touches it; the ADR-0065 list fields gain the same declared-first
  answer, so `repo · agent` on a fresh chat says where the chat lives.
- Negative: a third repository source exists for a conversation (declared,
  workspace, run) — pinned in this ADR, in `ConversationSummary`'s schema
  description, and by `TestConversationRepositoryBindingPrecedence`, because
  a chain nobody wrote down is a chain that drifts.
- Backwards compatibility: purely additive — an absent `repository` (query or
  body) is exactly the pre-ADR-0067 behavior; old rows carry NULL and answer
  through ADR-0065's arms alone; a database older than 00022 with newer code
  fails only the new statements, which is the ordinary migration ordering,
  and newer code never reads the column from an older schema.

## Security/privacy

The filter and the binding are reads/writes **of the project**: the list
statement's membership predicate runs before any repository predicate is
evaluated (a non-member gets the project's 404, never a filtered list), and
create keeps ADR-0016 § 8's role gate (contributor+, 403 for a viewer, 404 for
a non-member) — naming a repository grants nothing. A foreign project's
repository name is answered exactly like a name that exists nowhere (404 on
the filter, 422 on the create), so neither probe tells the caller who else
has that repository. The composite FK makes a cross-project bind impossible at
the row level regardless of caller.

## Verification

- `TestConversationCreateInRepositoryAndListFilter`
  (`internal/store/postgres/conversations_repo_scoped_test.go`, real
  PostgreSQL): a create naming `acme-api` writes `conversations.repository_id`
  and queues the prompt as turn 1 under the starter (`submitted_by`,
  `status='queued'`, journalled `conversation.message.user`); the filter
  returns exactly that repo's threads — the declared-bound one under
  `acme-api`, the declared **and** the workspace-derived ones under `zeta`,
  unbound threads under neither; the declared thread's list row carries the
  repository **before any workspace exists**; the filter composes with
  `origin` and `q`; and the cross-project read answers the same declared
  repository for the same row.
- `TestConversationRepositoryFilterUnknownAndForeign` (same file): an unknown
  name and another project's name both raise the filter's
  `ErrConversationRepositoryNotFound` (404) and the create's
  `ErrConversationValidation` (422), and a direct `UPDATE conversations SET
  repository_id = <another project's repository>` is refused by the composite
  FK — the second gate proven independently of the first.
- `TestConversationRepoScopedAuthz` (same file): a non-member's filtered list
  and repo-bound create are both `ErrConversationNotFound` (the project's
  404), the creator's binding survives the attempt untouched, a viewer may
  read the filtered list but its repo-bound create is
  `ErrConversationForbidden` (403).
- `TestConversationRepositoryBindingPrecedence` (same file): a thread declared
  for `acme-api` whose newest workspace checked out `zeta` resolves — id and
  name together — to `acme-api`, matches `?repository=acme-api` and not
  `?repository=zeta`; the declared arm outranks the checkout.
- `TestListConversationsRepositoryFilter` (`internal/api/conversations_test.go`):
  a malformed `repository` (including `..`, a space and a >100-char value) is
  `400 invalid_repository` and never reaches the store; a well-formed unknown
  one is the store's `404`; a valid one reaches the store verbatim and its
  row echoes `repository_name`; a stranger is `404` with or without the
  filter.
- `TestCreateConversationInRepository` (same file): the `repository` member
  rides the one create call beside the profile and the first prompt; a well-
  formed name the project lacks is `422` and the store records no create; a
  malformed one is refused before the store is asked; an omitted one is the
  plain unbound create (the fake enforces both refusals the real store does).
- Contract: `TestM4RouteTableMatchesOpenAPI` (routes unchanged; new
  parameter/member only), the assistant package's route mirror,
  `redocly` lint on `api/openapi.yaml`, and `pnpm gen:api:check` (the
  regenerated `ui/src/api/schema.d.ts` is committed with this change).

## Migration/rollback

Migration `00022_conversation_repository_binding.sql` adds one nullable column
and one composite FK — a brief `ACCESS EXCLUSIVE` per statement on
`conversations`/`repositories`, no rewrite, no backfill (old rows are NULL,
and guessing a binding from a later workspace would be ADR-0065's derivation
worn as a fact). The Down section drops the constraint and the column for
test resets only. API members are additive (`repository` query + body); a
browser that sends neither sees exactly the ADR-0065/0043 contract. Roll back
by reverting the code: the column stays, unread, NULL-or-not, harmlessly.
