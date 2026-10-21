# ADR-0053 — Starting a run from a thread: `RunCreate.source`, the thread branch as pinned run base, `handoff_summary` input, and the thread ↔ run link

- **Date:** 2026-10-20 · **Status:** Accepted · **Owners:** API maintainer; workspace/worker maintainer
- **Evidence:** real-PostgreSQL store tests `internal/store/postgres/run_source_test.go` (named in § Verification), real-git workspace tests `internal/workspace/git/workspace_test.go` (pinned-base arm), handler tests `internal/api/runs.go` (source shape validation)
- **Related:** ADR-0017 (per-project mirrors, per-scope run refs `refs/heads/<scope>/<repo>`, the run ref persists after release — the thread branch is exactly such a ref), ADR-0023 (runs pin their revision and its snapshots at creation and never re-resolve, 12 case 11), ADR-0043 (UI vocabulary: a "thread" is the API's `conversation`, `origin=manual`); design source `docs/design/handoff-app-shell/gaps/threads.md` §2/§4.3/§5, artboard 5d

## Context

The app-shell design's artboard 5d ("Hand to a workflow") asks for a way to hand a one-off thread to a workflow: the thread's branch becomes the run's starting point (including the committed edits), a summary of the thread becomes the first step's input, named artifacts ride along, and the thread stays open and links to the run. Today `POST /projects/{projectId}/runs` accepts no base override and no source conversation (`api/openapi.yaml` `RunCreate`), the run's workspace branches from the mirror's default branch unconditionally (`internal/workspace/git/workspace.go` `startPoint` — the base is hard-coded to the mirror default branch and never a pinned commit), nothing links a run to the thread it came from, and the thread detail has no way to say "this thread started a run".

The pieces to reuse already exist:

- `runs.repo_snapshot` — a jsonb column written at creation, decoded as `RunRepoSnapshot` (`{repository_id, base_commit}`) — "a commit identity, never a path" (`03` step 2). It was empty on every create path until now; this is its first writer.
- `run_inputs` — the seeded-input place where inputs already flow: validated against the pinned revision's `spec.inputs`, recorded with origin, bound as `${{ inputs.x }}` (`communication-spec/03-pipeline-engine.md:45`).
- `workspace_repos.head_commit` / `base_commit` — the post-commit ref read (ADR-0017 D8/P8) records the thread branch's real head for each repo, so the control plane knows the thread's committed head without touching a mirror.
- `artifacts.run_id` — the nullable M4 column the 00004 migration left unpopulated ("M4 fills run_id"), the ready-made attach-by-reference field.
- `runs` has no title; `conversations` + `projects` + `memberships` give the visibility predicate.

The control plane has no mirrors (they are worker-owned, ADR-0017 D1), so "the commit at the thread's ref" cannot be *resolved* at create time — but the control plane *does* store the thread's recorded head (`workspace_repos.head_commit`), and that recorded head is the commit identity the run pins.

## Decision

1. **`RunCreate` gains an optional `source` member** (`api/openapi.yaml` schema `RunSource`):
   `source: { conversation_id: uuid, summary?: string, artifact_ids?: uuid[] }`.
   `artifact_ids` is a nullable-typed array (`["array","null"]`, § 3.1). The role gate is unchanged:
   starting a run is `run.create` (contributor+, ADR-0023 § 4); handing a thread to a workflow is
   the same right (gaps/threads.md §8.5 default). `summary` and `artifact_ids` only apply when
   `conversation_id` is present.

2. **Source validation is in the creating transaction** (`APIRunStore.CreateRun`,
   `internal/store/postgres/m4api_runs_write.go` `m4RunSource`), after the pin resolves:
   - the caller must see the conversation (the `conversations` → `projects` → `memberships`
     visibility predicate, verbatim in SQL). Invisible or unknown conversation ⇒ `404`
     `api.ErrConversationNotFound` (the answer to "you may not know this exists"), no row written.
   - the conversation's project must equal the URL's project. Mismatch ⇒ `422`
     `source_project_mismatch` — the caller may legitimately see both objects and still must not
     start a run "in" the wrong one (the same rule the pin-project check applies, and the reason
     this is a 422 refusal rather than the 404 invisibility answer).
   - every named artifact must exist, live in the same project, not be deleted, and be unattached
     (or already attached to this same run — a replay is a no-op). Unknown / foreign / deleted ⇒
     `404` `api.ErrArtifactNotFound`; attached to another run ⇒ `422` `source_artifact_taken`.
     Attachment is `UPDATE artifacts SET run_id = <new run>` in the create transaction
     (attach by reference: the row keeps its `conversation_id`, so the thread's ARTIFACTS rail
     keeps listing it; the run's artifact list gains it).

3. **The thread branch is the run's base only where it carries commits; the base commit is
   snapshotted at creation and the run pins it like its revision — it never moves.**
   Per repository of the project, the rule is answered from `workspace_repos` (the honest
   recorded state, one query):
   - a `workspace_repos` row for the thread's workspace with `head_commit` non-empty and
     different from `base_commit` (the thread branch has commits beyond its base) ⇒ the run's
     base for that repo is that `head_commit`, pinned into `runs.repo_snapshot` as
     `{repository_id, base_commit}`.
   - otherwise (no workspace row, no recorded head, or head == base — a clean thread) ⇒ that repo
     falls back to the repository's default branch, exactly as today.
   No per-repo `base_ref` column is added: `runs.repo_snapshot` **is** the pinned-base record
   (its schema is already "a commit identity, never a path"). The create response carries the
   honest answer per repository: `base.repositories[] = { repository_id,
   mode: thread_branch | default_branch, base_commit (null in default_branch), reason }`, and the
   reason names what was observed ("head commit h… beyond base b…" / "no recorded commits beyond
   the base — starts from the default branch").

4. **The worker bases the run's worktree on the pinned commit and refuses rather than moves.**
   `RepoSpec` gains `BaseCommit` (empty = today's default-branch `startPoint`). On first prepare
   of a run workspace (`internal/worker` + `cmd/communication` preparer, which reads
   `runs.repo_snapshot` via `RunWorkspaces.BaseCommits`) with a non-empty pin:
   - the run ref does not exist ⇒ the mirror must contain the pinned object (`rev-parse
     --verify`); it creates `refs/heads/<run>/<repo>` from it and records it as the workspace's
     `base_commit`.
   - the run ref exists ⇒ resume from it (ADR-0017 D1's existing rule, unchanged).
   - the pinned object is **not in this worker's mirror** ⇒ prepare fails (infra class, the
     attempt does not launch, the run is retryable): thread refs are local mirror state
     (`mirrorFetchRefspec` never fetches them from the remote), so the honest answer on another
     worker's fresh mirror is a refusal with the commit id named, never a silent fall-back to the
     default branch — falling back would move the pinned base, which § 3 forbids. In practice the
     run returns to the worker that owns the thread's workspace (or a re-hand from the thread
     re-snapshots), and the `different_worker`/volume machinery of ADR-0023 § 7 covers the rest.

5. **`summary` is the first step's seeded input in the place run inputs already flow.** It is
   recorded as a run input named `handoff_summary` (origin `submitted`) when non-empty. A pinned
   revision that **declares** `handoff_summary` in `spec.inputs` type-checks it; one that does
   not still records it — the handoff summary is a system-provided input, not an undeclared user
   input (the `unknown_input` 422 does not apply to it). A workflow reads it like any input:
   `${{ inputs.handoff_summary }}`. This is deliberately *not* a change to input validation:
   `m4ValidateRunInputs` gains an `extraAllowed` parameter that only the create path fills, and
   the retry and schedule paths pass none.

6. **The thread ↔ run link is one column, read from both sides.** Migration
   `00011_run_source.sql`: `runs.source_conversation_id uuid NULL REFERENCES conversations(id)
   ON DELETE SET NULL` + a partial index. The conversation detail
   (`GET /conversations/{conversationId}`) gains `linked_runs: [{run_id, created_at}]` (the runs
   that named it as source); the run detail (`GET /runs/{runId}`) gains
   `source_conversation_id` (null for ordinary runs). The thread stays open: nothing in the
   thread's state, control or turn machinery is touched by the handoff.

7. **Agents start fresh sessions — the transcript is NOT replayed.** The run's node attempts open
   new ACP sessions in the run's own workspace (ADR-0023 § 4; ADR-0016 sessions are
   conversation-scoped). The thread's messages are carried only insofar as the caller chose
   `summary` and/or artifacts. This is stated as the feature's contract: "the run starts fresh
   agent sessions; the thread's conversation is not replayed" (artboard 5d, note line).

8. **Journal.** No new event type: `run.created` gains one optional payload member
   `source_conversation_id` (omitted when absent — the envelope schema stays valid, the event
   table in `api/openapi.yaml` names the member). The link rows (§ 6) are the durable read path.

## Consequences

- The UI's 5d dialog has its honest data source: `base.repositories[]` in the 201 (and
  `repo_snapshot` on `GET /runs/{id}`) answers "does the branch carry anything?" before the run
  can even run; the dialog's CARRIES OVER panel must fall back to the
  "starts from the repository's default branch" copy exactly when the response says so
  (gaps/threads.md §5).
- A new worker failure mode: pinned base absent from this mirror ⇒ infra refusal with the commit
  id named. Honest by design (never a silent move).
- `artifacts.run_id` becomes populated by a second writer (the create transaction), not only by
  M4 node attempts; readers of the artifacts list are unaffected (the column already ships).
- New public API ⇒ `api/openapi.yaml` (`RunSource`, `RunSourceBase`, `RunCreate.source`,
  `RunCreateResponse.base`, `Run.source_conversation_id`, `Conversation.linked_runs`,
  `run.created` payload member) and the generated client.

## Alternatives

- **A `base_ref`/`base_commit` member per repo in the request body** (the client picks the
  commit): rejected — the client would name a commit identity it cannot prove, and the
  control-plane answer "is the thread actually ahead of base?" needs the recorded
  `workspace_repos` state anyway. The server computes the base from the thread's recorded state
  and *pins* it; the request only says which thread.
- **Replay the thread transcript into the run's first session**: against ADR-0016's
  conversation-scoped session model and ADR-0023's one-conversation-per-attempt shape, and it
  would make run cost depend on thread length. The design note asks for the opposite (fresh
  sessions); `summary` + artifacts carry the context the caller chooses.
- **A new `run.handoff` event type**: the link needs no second journal row — `run.created`
  already names the run it describes, and the two reads in § 6 answer both directions.

## Verification

- `go test -race ./internal/store/postgres/... -count=1` — `TestRunSourceThreadBranchBase`,
  `TestRunSourceCleanThreadFallsBackToDefaultBranch`,
  `TestRunSourceInvisibleConversationIsNotFound`, `TestRunSourceProjectMismatchIs422`,
  `TestRunSourceArtifactAttachAndRefusals`, `TestRunSourceConversationLinkedRuns`
  (`internal/store/postgres/run_source_test.go`).
- `go test -race ./internal/workspace/git/... -count=1` —
  `TestPreparePinnedBaseCommit` (real git: a second-scope "thread" commits; a run scope pinned to
  that commit branches from it — `base_commit` equals the thread commit and the thread's file
  content is present; an unknown pinned commit is refused, never a guess).
- `go test -race ./internal/api/... -count=1` — `TestCreateRunSourceShapeValidation`
  (bad uuid / bad artifact id ⇒ 400 before the store; a well-formed source reaches the store).
- OpenAPI: `npx @redocly/cli@2.63.0 lint api/openapi.yaml` clean; `pnpm --dir ui gen:api`
  (generated client regenerated from the same file).
