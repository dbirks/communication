/**
 * The thread rail's ARTIFACTS list (docs/design/handoff-app-shell/gaps/threads.md,
 * work unit W3): one thread's artifacts, read through the project artifact list
 * filtered by conversation — `GET /api/v1/projects/{projectId}/artifacts?conversation_id=…`.
 *
 * The empty answer is real: the server resolves the conversation before
 * filtering, so a thread that simply has no artifacts yet answers `200` with an
 * empty array, while an unknown or invisible thread is the not-found answer.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { ArtifactList } from "./types";
import { queryKeys } from "./queries";

export function useConversationArtifacts(projectId: string, conversationId: string) {
  return useQuery({
    queryKey: queryKeys.artifacts(projectId, conversationId),
    queryFn: () =>
      apiFetch<ArtifactList>(
        `/api/v1/projects/${projectId}/artifacts?conversation_id=${encodeURIComponent(conversationId)}`,
      ),
    enabled: projectId.length > 0 && conversationId.length > 0,
  });
}
