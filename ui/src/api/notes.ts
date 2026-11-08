/**
 * Assistant notes (ADR-0071): the quiet, model-written suggestions one person
 * sees about one repository or one chat.
 *
 * Three facts shape this module:
 *
 * - **Per user.** The server writes a note for a reader, so dismissing one
 *   here hides it for nobody else. There is no shared list to keep in step.
 * - **Reads only.** Nothing here can write a note. The generator is the
 *   server's own assistant (`POST` does not exist on purpose), so the only
 *   browser-side write is the one flag: `dismiss`.
 * - **Actions are a closed union.** A note carries `{kind, …}`, never a url.
 *   The client switches on `kind` and navigates with a route it already owns,
 *   which is why an unrecognised kind renders no button at all: a note is
 *   model output, and model output is data, not a destination.
 *
 * The cache keys sit under `["project", id]` and `["conversation", id]` so the
 * SSE feeds' existing `invalidateProject`/conversation invalidation covers
 * them like every other project-scoped read.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { components } from "./schema";

export type AssistantNote = components["schemas"]["AssistantNote"];
export type AssistantNoteAction = components["schemas"]["AssistantNoteAction"];
export type AssistantNoteList = components["schemas"]["AssistantNoteList"];

/** The four kinds the union owns (the server's allowlist, mirrored so an
 * action this build cannot perform is dropped rather than guessed at). */
export type AssistantNoteActionKind = "start_chat" | "hand_off" | "make_workflow" | "open_run";

const ACTION_KINDS: readonly AssistantNoteActionKind[] = [
  "start_chat",
  "hand_off",
  "make_workflow",
  "open_run",
];

/** The panel's cap: three notes, the same number the store caps the rows at. */
export const ASSISTANT_NOTES_CAP = 3;

/** `["project", id, "repos", repoId, "notes"]` — under the project subtree. */
export function repoNotesKey(projectId: string, repositoryId: string) {
  return ["project", projectId, "repos", repositoryId, "notes"] as const;
}

/** `["conversation", id, "notes"]` — the thread is its own scope. */
export function conversationNotesKey(conversationId: string) {
  return ["conversation", conversationId, "notes"] as const;
}

/** The cache key a note lives under, from the note itself: the row carries
 * its own scope precisely so a dismissal can find its list without the caller
 * remembering which route it came from. */
export function notesKeyFor(note: AssistantNote): QueryKey {
  return note.scope_kind === "repository"
    ? repoNotesKey(note.project_id, note.scope_id)
    : conversationNotesKey(note.scope_id);
}

/**
 * `GET /api/v1/projects/{projectId}/repos/{repositoryId}/notes`.
 *
 * The GET is the generator's trigger server-side: it answers with whatever is
 * stored now and, when this scope has no fresh generation, schedules one in
 * the background. The UI never waits for a model, and never retries to chase
 * one — a note that arrives after this read shows on the next look.
 */
export function useRepoAssistantNotes(projectId: string, repositoryId: string, enabled = true) {
  return useQuery({
    queryKey: repoNotesKey(projectId, repositoryId),
    queryFn: () =>
      apiFetch<AssistantNoteList>(`/api/v1/projects/${projectId}/repos/${repositoryId}/notes`),
    enabled: enabled && projectId.length > 0 && repositoryId.length > 0,
    retry: false,
  });
}

/** `GET /api/v1/conversations/{conversationId}/notes` — the same read with the
 * thread as its own authorization scope. */
export function useConversationAssistantNotes(conversationId: string, enabled = true) {
  return useQuery({
    queryKey: conversationNotesKey(conversationId),
    queryFn: () => apiFetch<AssistantNoteList>(`/api/v1/conversations/${conversationId}/notes`),
    enabled: enabled && conversationId.length > 0,
    retry: false,
  });
}

/**
 * `POST /api/v1/notes/{id}/dismiss` — 204, and the note is this user's only.
 *
 * The row leaves the cache before the request is answered, so the panel
 * empties on the click rather than on the response; a refusal puts it back on
 * the next read (the note was never the client's to keep anyway).
 */
export function useDismissAssistantNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: AssistantNote) =>
      apiFetch<void>(`/api/v1/notes/${note.id}/dismiss`, { method: "POST" }),
    onMutate: (note) => {
      const key = notesKeyFor(note);
      const previous = queryClient.getQueryData<AssistantNoteList>(key);
      if (previous) {
        queryClient.setQueryData<AssistantNoteList>(key, {
          notes: previous.notes.filter((row) => row.id !== note.id),
        });
      }
      return { key, previous };
    },
    onError: (_error, _note, rollback) => {
      // A 404 says the row is no longer this reader's to dismiss: it was
      // already dismissed, it aged out, or the generator's cap replaced it
      // (acceptance 42339622074 pass-2). In every one of those cases the
      // store serves it no more — putting it back on the panel would be a
      // claim about a row that a fresh read contradicts. Reconcile with the
      // server instead of rolling back. Any other failure (the network, a
      // 5xx) means the write did not happen and the note was never
      // dismissed: it goes back on the panel, because a dismissal that
      // silently vanished would be a claim about a write that did not.
      if (_error instanceof ApiError && _error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: notesKeyFor(_note) });
        return;
      }
      if (rollback?.previous) {
        queryClient.setQueryData(rollback.key, rollback.previous);
      }
    },
    onSuccess: (_data, note) => {
      // The answer is a 204 with no body, so the row is re-read rather than
      // assumed: whatever the store now holds for this scope is what shows.
      void queryClient.invalidateQueries({ queryKey: notesKeyFor(note) });
    },
  });
}

/** The notes to draw: newest first as served, capped at the panel's three. */
export function visibleAssistantNotes(
  notes: readonly AssistantNote[] | undefined,
): AssistantNote[] {
  return (notes ?? []).slice(0, ASSISTANT_NOTES_CAP);
}

/**
 * The kind this build knows how to perform, or null. A kind the server adds
 * later must not become a button that does something else: the honest answer
 * is the note's sentence with no action beside it.
 */
export function noteActionKind(
  action: AssistantNoteAction | undefined,
): AssistantNoteActionKind | null {
  if (!action) return null;
  return (ACTION_KINDS as readonly string[]).includes(action.kind)
    ? (action.kind as AssistantNoteActionKind)
    : null;
}

/** What the action's button says. The words name the navigation the client
 * itself performs, never anything the note supplied. */
export function noteActionLabel(action: AssistantNoteAction | undefined): string | null {
  switch (noteActionKind(action)) {
    case "start_chat":
      return "Ask in a new thread";
    case "hand_off":
      return "Hand it off";
    case "make_workflow":
      return "Make a workflow…";
    case "open_run":
      return "Open the run";
    default:
      return null;
  }
}

/**
 * The action narrowed to the kind it is, so TypeScript's discriminated union
 * is what decides which payload member is readable. A kind outside the four
 * narrows to nothing, which is the same answer `noteActionKind` gives.
 */
function noteActionOf<K extends AssistantNoteActionKind>(
  action: AssistantNoteAction | undefined,
  kind: K,
): Extract<AssistantNoteAction, { kind: K }> | null {
  return action && action.kind === kind
    ? (action as Extract<AssistantNoteAction, { kind: K }>)
    : null;
}

/** The issue numbers a `hand_off` names, filtered to the positives the run
 * form can carry (the server already validated them; this is the belt). */
export function handOffIssueNumbers(action: AssistantNoteAction | undefined): number[] {
  const handOff = noteActionOf(action, "hand_off");
  if (!handOff) return [];
  return handOff.issue_numbers.filter((n: number) => Number.isInteger(n) && n > 0);
}

/** The prompt a `start_chat` prefills. */
export function chatPromptFor(action: AssistantNoteAction | undefined): string {
  return noteActionOf(action, "start_chat")?.prompt ?? "";
}

/** The run an `open_run` means. */
export function runIdFor(action: AssistantNoteAction | undefined): string {
  return noteActionOf(action, "open_run")?.run_id ?? "";
}

/** The thread a `make_workflow` means. */
export function workflowConversationIdFor(action: AssistantNoteAction | undefined): string {
  return noteActionOf(action, "make_workflow")?.conversation_id ?? "";
}
