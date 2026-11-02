# ADR-0071 — Assistant notes: a per-user suggestion store, dismissed by its owner, with an allowlisted action union

- **Date:** 2026-11-02
- **Status:** Accepted (step 1 implemented and verified on real PostgreSQL — see Verification; step 2's generator is specified here and built next)
- **Owners:** control-plane API + store maintainers
- **Related:** ADR-0034/0050 (the assistant that writes these), ADR-0052 (model writes, human decides — step 2 reuses its shape), ADR-0046 (a preference is display state; a note is not), ADR-0014 § 3 (a refusal is audited), ADR-0013 (forward-only), ADR-0063 (bounded database work), `docs/design/handoff-repo-chat-nav` (3a's `ASSISTANT NOTICED`, 2e's side-panel note, 2f's `Make a workflow…`)

## Context

The UI already has the slots — `components/repo/AssistantNotes.tsx`,
`components/conversation/AssistantNote.tsx` — and both draw nothing without a
source, because there is none: "a store of suggestions the assistant generates
(per user, can be dismissed)" is the design's whole sentence about the data, and
no table holds it. Three questions have to be settled before a generator can be
built: who owns a note, what getting rid of one means, and what a note may
*offer* — given that the thing writing notes reads text it does not control,
including text sitting in somebody's repository.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: one row per (user, scope); dismissal and expiry are timestamps; the action is a closed union (chosen)** | one member's `dismiss` cannot silence advice another member needed; the row keeps what the assistant claimed, which is how step 2 gets evaluated; a client can only navigate somewhere it already owns | the same sentence is stored once per reader | implemented; `internal/store/postgres/assistant_notes_test.go` |
| B: one note per scope, dismissal in a child table | no duplicated text | two tables and a join for a list the panel reads whole, and a shared note makes one person's click everybody's loss | the brief's "per user" |
| C: notes inside `user_preferences.assistant` | no migration | preferences are display state that authorizes nothing, merged last-write-wins (ADR-0046): nothing bounds or expires them, and a lost update silently loses a note | ADR-0046's own scope |
| D: `action: {label, href}` | the assistant could offer anything | model output becomes a link a browser follows — injection through repository text turns into a navigation. Rules instead of a model (the other alternative) is what the design forbids: "there are no hard-coded rules" | ADR-0052 refuses the same for approvals; design 3a |

## Decision

1. **Storage.** `assistant_notes` (migration `00027`): `project_id`, `user_id`,
   `scope_kind` (`repository` | `conversation`, CHECKed), `scope_id`, `text`
   (CHECK 1..280 characters, CHECKed as stored-trimmed), `action` (jsonb,
   CHECKed to be an object), `created_at`, `dismissed_at`, `expires_at`, plus
   `assistant_notes_active_idx ON (user_id, scope_kind, scope_id) WHERE
   dismissed_at IS NULL` — the read the surface makes. Both keys cascade: a note
   without its project or its reader is a fact about nothing. `scope_id` has
   **no foreign key** by design: one uuid cannot key two tables, and an
   exclusive-or pair of nullable columns sets a constraint the reads never use
   in front of the index the surface depends on. The write path closes the gap
   instead — the insert is one statement whose own `WHERE` admits a note only
   when `scope_id` resolves to a row of `scope_kind` **inside `project_id`**, so
   a dangling or cross-project scope is never written rather than cleaned up
   afterwards.
2. **Active means neither dismissed nor expired, three per user and scope.**
   Dismissal and expiry are timestamps, not deletes: an inactive note is still a
   row, because "what did the assistant claim, and did the person act on it" is
   the generator's evaluation data. Only the **overflow** is deleted — the note a
   fourth suggestion displaced, ranked newest-first inside the same insert
   statement, so the cap cannot be dodged by a caller that skipped a read. The
   list carries the same cap as a `LIMIT`: bounded (ADR-0063) and honest about
   what the panel draws.
3. **Dismissal is per user, and the only write a browser may make.**
   `POST /api/v1/notes/{id}/dismiss` answers `204`; another user's identical
   note is untouched. Everything else answers `404` and never `403`, because
   `403` would confirm that somebody else was advised. A second dismiss is
   `404`, not a `204`: reporting a write that did not happen is a lie. Acting
   on a note does *not* consume it — the design's "acting removes the note" is
   the client dismissing on the way out, since a silent consume would be a
   second write path with no owner.
4. **The action union is allowlisted:** `start_chat{prompt}`,
   `hand_off{issue_numbers[]}`, `make_workflow{conversation_id}`,
   `open_run{run_id}` — exactly the payload its kind owns (an `open_run`
   carrying a prompt is refused on write and fails the read), and never a url:
   the client switches on `kind` and navigates with a route it already owns.
   The jsonb CHECK states the object shape; the vocabulary lives in
   `internal/api` with the rest of the contract.
5. **No write route.** Step 1 is the store, the contract and dismissal; the
   generator calls `InsertAssistantNote` from the server's own assistant.
   Nothing a browser sends belongs in another user's panel.
6. **Generation (step 2) is bounded and treats repository text as data.** One
   bounded completion per (user, scope), issued as the caller over ADR-0034's
   secret-scanned egress, with repository text, run titles and transcript lines
   supplied as quoted input and never as instructions — the rule that keeps a
   `README` from becoming a task. Its answer is this union or nothing: an unknown
   `kind`, a missing payload, a sentence over 280 characters or a fourth note are
   dropped at validation, never half-shown. A note restating something this user
   already dismissed for this scope is dropped too — dismissal was an
   instruction about the subject, not only about the row. No call happens for a
   user whose panel is already full, and no prompt or transcript excerpt is
   stored: only what was served.

## Consequences

- The two UI slots gain a source and no component change is implied here; the
  surface is wholly additive, so no existing schema, route or event changes.
- Duplication per reader is accepted, and it is what keeps a note from becoming
  a permission question *between* members: it is never shared.
- Dismissed and expired rows accumulate. Nothing is incorrect while they do
  (both are filtered on read); a retention rule belongs with the generator's
  evaluation window, not before it.
- The assistant can now be wrong in public: each note is one sentence with no
  state behind it, and every action in the union lands somewhere a person can
  see that it was wrong.

## Security/privacy

A note is readable only by the user it was written for (`user_id = caller` is
part of every read), and both scopes are authorized by the project's own rule:
membership (a `viewer` sees the panel because they see the repository) or the
organization's admin. A stranger, an unknown project and an unknown repository
are one `404`, each audited (`assistant_note.repository.list`,
`assistant_note.conversation.list`, `assistant_note.dismiss`) — the store audits
because the row that says "not yours" is the only thing that knows whose project
it was refused in. No secret, path, worker identity or lease fact rides a note,
and repository text reaching one may propose one of four navigations and nothing
else.

## Verification

`internal/store/postgres/assistant_notes_test.go` (real PostgreSQL): the cap of
three active per user and scope with the overflow **deleted** and the newest
kept, independent on both axes; owner dismissal (row kept with `dismissed_at`,
re-dismiss refused, another user's note unaffected); expiry (a stale note
admitted and never served, a future deadline served with the note, an undated
note serving no `expires_at`, an expired note not dismissible); authz on both
scopes for an in-org and an out-of-org stranger, every refusal present in
`audit_events`; a non-owner dismiss answering the 404 sentinel with exactly one
audit row and the owner's note still active, and a gone id answering it with
none; the scope guard, the trim/280/blank rules, and a corrupt action failing
the read where a non-object action is refused by the table's CHECK.
`internal/api/assistant_notes_test.go`: both list shapes with `[]` never absent,
the union's JSON round trip carrying only its own member, each validation rule,
the 422s before any store call, one `404` for stranger and non-owner with no id
echoed, a 500 that leaks nothing, `204` with no body, the session gate on all
three routes and the CSRF gate on the dismiss. Plus
`go build ./... && test -z "$(gofmt -l internal cmd)" && go vet ./internal/...`,
`redocly lint` (0 errors), `pnpm --dir ui gen:api:check` and
`go test ./internal/assistant/`.

## Migration/rollback

`00027_assistant_notes.sql` adds one table and one partial index; the head
constant in `internal/store/postgres/migrate_test.go` moves to 27 and an older
replica simply never serves notes. Forward-only per ADR-0013 (the `Down` section
is for test resets). Mounting the routes
(`api.RegisterAssistantNotes(handler, postgres.APIAssistantNotesStore{S: …, Denials: projectStore})`)
is outside this change's files; until it lands, the three routes answer the
mux's own 404.
