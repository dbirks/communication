/**
 * The WORKS-IN switcher's mutation (ADR-0067 amendment, rcn-review12
 * works-in-moved): on a successful scope change the fresh conversation is
 * written back to the shared cache, and EVERY conversation list the thread
 * list and the repo feed read is invalidated — the project's own lists
 * (the `["project", projectId, "conversations"]` prefix) AND the shell's
 * cross-project thread list (`["conversations", "cross-project", …]`, which
 * is not project-scoped and therefore out of reach of the prefix
 * invalidation). Without the second one the pane's selected live row kept
 * naming the old repository until a manual refresh.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  conversationFixture,
  conversationId,
  mockFetch,
  requestsTo,
  projectFixture,
} from "../test/fakes";
import { patchConversationScope, useChangeConversationScope } from "./conversations";

const moved = { ...conversationFixture, repository_id: null, repository_name: null };

/** Prime one list read the way the pane and the repo page do, so the
 * invalidation has an entry to mark. */
function prime(queryClient: QueryClient, key: readonly unknown[]) {
  return queryClient.prefetchQuery({ queryKey: key, queryFn: async () => ({}) });
}

describe("useChangeConversationScope", () => {
  it("writes the fresh conversation back and invalidates every conversation list", async () => {
    const { requests } = mockFetch([
      {
        path: `/api/v1/conversations/${conversationId}`,
        method: "PATCH",
        body: moved,
      },
    ]);

    const queryClient = new QueryClient();
    // The list reads the thread list and the repo feed make.
    await Promise.all([
      prime(queryClient, ["conversations", "cross-project", null]),
      prime(queryClient, ["project", projectFixture.id, "conversations", null, null]),
      prime(queryClient, ["conversation", conversationId]),
    ]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useChangeConversationScope(), { wrapper });
    result.current.mutate({ conversationId, repositoryId: null });

    // The PATCH is one write, the null binding verbatim.
    await waitFor(() => {
      const patches = requestsTo(requests, `/api/v1/conversations/${conversationId}`, "PATCH");
      expect(patches).toHaveLength(1);
      expect(patches[0].body).toBe(JSON.stringify({ repository_id: null }));
    });

    // The fresh conversation lands in the shared cache entry …
    await waitFor(() =>
      expect(queryClient.getQueryData(["conversation", conversationId])).toMatchObject({
        repository_id: null,
        repository_name: null,
      }),
    );

    // … and every conversation list read is invalidated: the cross-project
    // one the pane's selected row reads (NOT under the project prefix) and
    // the project's own list the repo feed and the page read.
    const cross = queryClient.getQueryCache().findAll({
      queryKey: ["conversations", "cross-project"],
    });
    expect(cross).toHaveLength(1);
    expect(cross[0].state.isInvalidated).toBe(true);
    const scoped = queryClient.getQueryCache().findAll({
      queryKey: ["project", projectFixture.id, "conversations"],
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].state.isInvalidated).toBe(true);
  });

  it("PATCHes the conversation's scope through the update route", async () => {
    const { requests } = mockFetch([
      {
        path: `/api/v1/conversations/${conversationId}`,
        method: "PATCH",
        body: { ...conversationFixture, repository_id: "repo-1", repository_name: "web" },
      },
    ]);
    const reply = await patchConversationScope(conversationId, "repo-1");
    expect(reply.repository_id).toBe("repo-1");
    const patch = requestsTo(requests, `/api/v1/conversations/${conversationId}`, "PATCH")[0];
    expect(patch.body).toBe(JSON.stringify({ repository_id: "repo-1" }));
  });
});
