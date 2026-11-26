/**
 * `useThreadList` — the read the redesign's chat list
 * (`components/chats/ChatList.tsx`) and New chat pane
 * (`components/chats/NewChatPane.tsx`) share — and the pane's own title rule.
 *
 * The pane's screen assertions lived on `/threads`, which is a
 * replace-redirect now: the rows, the search, the keyset walk, the error
 * state and the row previews are pinned against the replacement in
 * `components/chats/ChatList.ported.test.tsx` and
 * `components/chats/ChatThread.ported.test.tsx`, and the LIVE / EARLIER
 * shelves, the filter chips, the row's `project / repo · agent` meta line and
 * the page-band arrangement are retired with the old page (the new list groups
 * by project and says the chat's scope in its header). What is left here is
 * the one rule a host that draws no page band still relies on: the pane names
 * itself and offers the verb.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeProfile,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import { ThreadListPane } from "./ThreadListPane";
import type { ConversationSummary } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wholeProjectRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-1111-7000-8000-abcdef000001",
  title: "Move the billing service",
  repository_id: null,
  repository_name: null,
};

function routes(): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: "/api/v1/conversations", body: { items: [wholeProjectRow], next_cursor: null } },
  ];
}

describe("the pane's title belongs to whoever draws the band (finding 07)", () => {
  it(
    "with no band above the column, the pane still names itself and offers the verb",
    { timeout: 15_000 },
    async () => {
      mockFetch(routes());
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ThreadListPane />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const pane = await screen.findByTestId("threads-page");
      expect(pane.querySelector("h1")?.textContent).toBe("Threads");
      expect(pane.contains(screen.getByTestId("threads-new-open"))).toBe(true);
    },
  );
});
