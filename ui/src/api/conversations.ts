/**
 * The conversation's repository scope — the WORKS IN switcher's write
 * (ADR-0067 amendment).
 *
 * `PATCH /api/v1/conversations/{conversationId}` moves the thread's declared
 * binding to one of the project's repositories, or to `null` (the whole
 * project, a pre-ADR-0067 row's answer). The same authorization as sending a
 * turn moves it: the human controller; a non-controller is `409`, a viewer
 * `403`, a foreign repository id `422 repository_not_in_project`. On success
 * the fresh conversation is written back to the cache and the thread list is
 * invalidated — its summary rows resolve the same binding, so the repo page's
 * feed follows the move without a manual refresh.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { invalidateConversation, queryKeys } from "./queries";
import type { Conversation } from "./types";

/** The PATCH body: `repository_id` a project repository id, or null. */
export interface ConversationScopePatch {
  repository_id: string | null;
}

export interface ScopeChangeArgs {
  conversationId: string;
  /** One of the project's repository ids, or null for the whole project. */
  repositoryId: string | null;
}

export function patchConversationScope(conversationId: string, repositoryId: string | null) {
  return apiFetch<Conversation>(`/api/v1/conversations/${conversationId}`, {
    method: "PATCH",
    json: { repository_id: repositoryId } satisfies ConversationScopePatch,
  });
}

/**
 * The switcher's mutation: PATCH, then write the fresh conversation back and
 * forget the thread's list rows (their `repository_id`/`repository_name`
 * answer the moved binding). The `project_id` the response carries scopes the
 * list invalidation to the thread's own project.
 */
export function useChangeConversationScope() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, repositoryId }: ScopeChangeArgs) =>
      patchConversationScope(conversationId, repositoryId),
    onSuccess: (conversation) => {
      queryClient.setQueryData(queryKeys.conversation(conversation.id), conversation);
      invalidateConversation(queryClient, conversation.id, conversation.project_id);
      // The shell's cross-project thread list (ThreadListPane's
      // `["conversations", "cross-project", …]` read) is NOT project-scoped,
      // so `invalidateConversation`'s project-prefix invalidation never
      // reaches it — its row would keep naming the old repository until a
      // manual refresh (rcn-review12 works-in-moved).
      void queryClient.invalidateQueries({ queryKey: ["conversations", "cross-project"] });
    },
  });
}
