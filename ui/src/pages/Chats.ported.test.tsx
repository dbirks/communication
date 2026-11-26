/**
 * The project's chats (`/p/:projectId/chats`, the redesign's replacement for
 * `pages/ProjectConversations.tsx`'s Threads tab), ported from
 * `pages/ProjectConversations.test.tsx`.
 *
 * The old tab's frame is gone by design: the project header band, its tab row
 * and the at-rest thread column no longer stand around the list. What the
 * person still has — their project's chats in the app's words rather than the
 * wire's, the search riding the list route, the empty state, and the honest
 * limit a viewer meets when they try to start a chat — is asserted here at the
 * new route.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Chats from "./Chats";
import type { ConversationSummary } from "../api/types";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const conversationPath = `/api/v1/projects/${projectFixture.id}/conversations`;

const someoneElses: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a64-3333-7000-8000-abcdef012347",
  title: "Nightly triage",
  created_by: "01987a10-9999-7000-8000-abcdef012399",
  created_by_display_name: "Dana Observer",
};

function renderProjectChats(
  items: ConversationSummary[],
  extra: RouteStub[] = [],
  path = `/p/${projectFixture.id}/chats`,
) {
  const routes: RouteStub[] = [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: "/api/v1/conversations", body: { items, next_cursor: null } },
    { path: conversationPath, method: "GET", body: { items } },
  ];
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chats/:conversationId?" element={<Chats />} />
          <Route path="/p/:projectId/chats/:conversationId?" element={<Chats />} />
          <Route path="/p/:projectId/chats" element={<Chats />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("/p/:projectId/chats (ported from the project's Threads tab)", () => {
  it("lists each of the project's chats in the app's words — title, agent, last line, no wire field names", async () => {
    renderProjectChats([conversationSummaryFixture, someoneElses]);

    const row = await screen.findByTestId(`chat-row-${conversationFixture.id}`);
    expect(row.textContent).toContain("Refactor billing");
    // The summary names only the profile id; the list resolves the name.
    expect(row.textContent).not.toContain(conversationFixture.agent_profile_id);
    expect(row.textContent).not.toContain("profile:");
    expect(row.textContent).not.toContain("controller:");
    // The wire's raw status never reaches the screen, and the clock is
    // relative like every other age.
    expect(row.textContent).not.toMatch(/\bACTIVE\b/);
    expect(row.textContent).not.toContain(conversationFixture.updated_at);
    // The row links inside the project's own URL space.
    expect(row.getAttribute("href")).toBe(
      `/p/${projectFixture.id}/chats/${conversationFixture.id}`,
    );
    expect(row.getAttribute("href")).not.toContain("/threads/");
  });

  it("says there are no chats yet", async () => {
    renderProjectChats([]);
    const empty = await screen.findByTestId("chat-list-empty");
    expect(empty.textContent).toBe("No chats yet.");
  });

  it("sends the search to the project's list route as q, and says when nothing matches", async () => {
    const seen: string[] = [];
    const { requests } = renderProjectChats([conversationSummaryFixture]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input, init);
    });

    const search = await screen.findByTestId("chat-search");
    fireEvent.change(search, { target: { value: "billing" } });
    expect(await screen.findByTestId(`chat-row-${conversationFixture.id}`)).toBeTruthy();
    await waitFor(() =>
      expect(seen.some((url) => url.startsWith(`${conversationPath}?`))).toBe(true),
    );

    // Nothing on the page matches: the list says so, and it is a different
    // sentence from the unfiltered empty shelf.
    fireEvent.change(search, { target: { value: "nothing like this" } });
    const nomatch = await screen.findByTestId("chat-list-empty");
    expect(nomatch.textContent).toBe("No chats match your search.");

    expect(requests[0]?.method).toBe("GET");
  });

  it("keeps a viewer out of the create form: the New chat pane names the limit instead of dead-ending", async () => {
    // The old tab said it in the header band ("read-only", no `New thread`
    // verb). The redesign's create surface is the New chat pane, whose project
    // picker lists only the projects the caller can write to.
    renderProjectChats(
      [conversationSummaryFixture],
      [
        {
          path: "/api/v1/projects",
          body: { items: [{ ...projectFixture, my_role: "viewer" }] },
        },
      ],
      "/chats",
    );

    await screen.findByTestId(`chat-row-${conversationFixture.id}`);
    fireEvent.click(screen.getByTestId("chat-new"));
    await screen.findByTestId("chat-new-pane");
    fireEvent.click(await screen.findByTestId("new-chat-project-chip"));
    expect(await screen.findByText("No projects where you can start a chat.")).toBeTruthy();
  });
});

describe("NewChatPane in a project the caller only reads", () => {
  it("names the read-only limit instead of dead-ending a viewer on a 403", async () => {
    renderProjectChats(
      [conversationSummaryFixture],
      [
        {
          path: `/api/v1/projects/${projectFixture.id}`,
          body: { ...projectFixture, my_role: "viewer" },
        },
      ],
      `/p/${projectFixture.id}/chats/new`,
    );

    await screen.findByTestId("chat-new-pane");
    expect(
      await screen.findByText(
        `You can read chats in ${projectFixture.name}, but only members can start one.`,
      ),
    ).toBeTruthy();
    expect((screen.getByTestId("new-chat-prompt-input") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(screen.queryByTestId("new-chat-prompt-send")).toBeNull();
  });

  it("shows the project-free read-only limit under All scope when no writable project exists", async () => {
    renderProjectChats(
      [conversationSummaryFixture],
      [
        {
          path: "/api/v1/projects",
          body: { items: [{ ...projectFixture, my_role: "viewer" }] },
        },
      ],
      "/chats/new",
    );

    await screen.findByTestId("chat-new-pane");
    expect(
      await screen.findByText("You can read chats, but only members can start one."),
    ).toBeTruthy();
    expect((screen.getByTestId("new-chat-prompt-input") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(screen.queryByTestId("new-chat-prompt-send")).toBeNull();
  });
});
