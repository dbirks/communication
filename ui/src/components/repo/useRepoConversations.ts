/**
 * The repo page's conversation read (ADR-0067): the project conversations
 * route with `?repository=<name>` — threads bound to THIS repository (born
 * bound, workspace-bound or run-bound, the server's three arms). The key sits
 * under the project's conversations prefix, so `useCreateConversation`'s
 * prefix invalidation refreshes it after a chat box Start.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import type { ConversationSummaryList } from "../../api/types";

export function useRepoConversations(projectId: string, repositoryName: string) {
  return useQuery({
    queryKey: [...queryKeys.conversations(projectId), "repository", repositoryName] as const,
    queryFn: () =>
      apiFetch<ConversationSummaryList>(
        `/api/v1/projects/${projectId}/conversations?repository=${encodeURIComponent(repositoryName)}`,
      ),
    enabled: projectId.length > 0 && repositoryName.length > 0,
  });
}
