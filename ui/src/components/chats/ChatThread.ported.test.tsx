/**
 * Behaviours ported from the `/threads/:id` pane (`pages/Threads.test.tsx`)
 * and the gh-69 switching file (`pages/ThreadsSwitch.test.tsx`) onto their
 * replacement, `components/chats/ChatThread.tsx` (the right column of
 * `pages/Chats.tsx`).
 *
 * The old pane's own chrome is retired with it: the 320px list geometry, the
 * page band, the header's mono meta line with its `turn-status` readout, and
 * the collapsed `<details>` context block. What a person still does — read
 * the chat's SCOPE in words, drive the composer, reach the workspace /
 * artifacts / hand-off, watch a switching thread — is asserted against the
 * ids the new components define.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Chats from "../../pages/Chats";
import { queryKeys } from "../../api/queries";
import type { Conversation, ConversationSummary, Repository } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  turnFixture,
  type FetchMock,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
});

const webRepo: Repository = {
  id: "01987a79-aaaa-7000-8000-abcdef044444",
  project_id: projectFixture.id,
  name: "web",
  git_url: "https://git.example/web.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none",
};

/** A second thread, so a click can move from one open chat to another. */
const secondId = "01987a99-9999-7000-8000-abcdef999999";
const second: Conversation = { ...conversationFixture, id: secondId, title: "Second chat" };
const secondRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: secondId,
  title: "Second chat",
};

function routesFor(
  items: ConversationSummary[],
  conversation: Conversation,
  extra: RouteStub[] = [],
): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [webRepo] } },
    { path: `/api/v1/projects/${projectFixture.id}/workspaces`, body: { workspaces: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/assignments`, body: { assignments: [] } },
    {
      path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
      body: { issue_triggers: [] },
    },
    { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/artifacts`, body: { artifacts: [] } },
    { path: "/api/v1/pipelines", body: { pipelines: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: "/api/v1/conversations", body: { items, next_cursor: null } },
    { path: `/api/v1/conversations/${conversationId}`, method: "GET", body: conversation },
    { path: `/api/v1/conversations/${secondId}`, method: "GET", body: second },
    {
      path: `/api/v1/conversations/${conversationId}/assistant-notes`,
      body: { notes: [] },
    },
  ];
}

function renderChats(
  path: string,
  routes: RouteStub[],
): { requests: ReturnType<typeof mockFetch>["requests"]; fetchMock: FetchMock } {
  const { requests, fetchMock } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chats/:conversationId?" element={<Chats />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, fetchMock };
}

/** Hold every request whose url contains `part` until the returned release runs. */
function gateRequests(fetchMock: FetchMock, part: string): () => void {
  const original = fetchMock.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
  const waiting: Array<() => void> = [];
  fetchMock.mockImplementation((...args: unknown[]) => {
    const url = typeof args[0] === "string" ? args[0] : String(args[0]);
    const response = original(...args);
    if (url.includes(part)) {
      return new Promise<Response>((release) => waiting.push(() => release(response)));
    }
    return response;
  });
  return () => waiting.shift()?.();
}

describe("ChatThread (ported from the /threads/:id pane)", () => {
  it("opens the chat with its composer ready and the transcript column capped at 720px", async () => {
    renderChats(
      `/chats/${conversationId}`,
      routesFor([conversationSummaryFixture], conversationFixture),
    );

    expect((await screen.findByTestId("chat-title")).textContent).toBe(conversationFixture.title);
    expect(await screen.findByTestId("composer-input")).toBeTruthy();
    // Design 3: the messages ride a column capped at 720 (the composer box
    // shares the measure), never the full width of the pane.
    const column = (await screen.findByTestId("transcript-empty")).closest(
      ".max-w-\\[720px\\]",
    ) as HTMLElement;
    expect(column).toBeTruthy();
    // The composer is the last thing in the thread: the transcript precedes it.
    const thread = screen.getByTestId("chat-thread");
    const composer = within(thread).getByTestId("chat-composer");
    expect(
      column.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the chat's SCOPE in words — the repository it is bound to, or Whole project", async () => {
    // rcn-2e works-in-moved / rcn-review13: a row whose own `repository_id`
    // says null names no repository, even when the name member still carries
    // the workspace's checkout.
    const bound: Conversation = {
      ...conversationFixture,
      repository_id: webRepo.id,
      repository_name: "web",
    };
    renderChats(`/chats/${conversationId}`, routesFor([conversationSummaryFixture], bound));
    const chip = await screen.findByTestId("chat-repo-chip");
    expect(chip.textContent).toBe("web");
    expect(chip.getAttribute("href")).toBe(
      `/p/${projectFixture.id}/${encodeURIComponent(webRepo.name)}`,
    );

    cleanup();
    const moved: Conversation = {
      ...conversationFixture,
      repository_id: null,
      // the summary's three-arm derivation still names the old checkout
      repository_name: "server",
    };
    renderChats(`/chats/${conversationId}`, routesFor([conversationSummaryFixture], moved));
    const whole = await screen.findByTestId("chat-repo-chip");
    expect(whole.textContent).toBe("Whole project");
    expect(whole.tagName).not.toBe("A");
    expect(whole.textContent).not.toContain("server");
  });

  it("keeps the workspace, the artifacts and the hand-off reachable behind the … menu", async () => {
    renderChats(
      `/chats/${conversationId}`,
      routesFor([conversationSummaryFixture], conversationFixture),
    );
    await screen.findByTestId("chat-header");

    // Design 3 moves the old pane's collapsed context block behind the
    // header's "…" menu: Details opens the same facts in a sheet.
    fireEvent.click(screen.getByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-details"));

    expect(await screen.findByTestId("workspace-widget-empty")).toBeTruthy();
    expect(screen.getByTestId("hand-to-workflow")).toBeTruthy();
    // Artifacts ride their own menu entry, which opens the sheet at them.
    fireEvent.click(screen.getByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-artifacts"));
    expect(await screen.findByTestId("artifacts-rail")).toBeTruthy();
  });

  it("re-shelves nothing: the open chat's row wears the turn as it opens on this page", async () => {
    // Pass review 1g defect 1, in the new list's words: the row beside the
    // open chat is the cross-project summary read, the one the per-frame
    // invalidation does not reach. The session still recomputes that cache
    // when the open turn flips, so the row answers `● run` without a remount.
    const idleRow: ConversationSummary = {
      ...conversationSummaryFixture,
      status: "idle",
      has_active_turn: false,
    };
    const openTurnRow: ConversationSummary = {
      ...conversationSummaryFixture,
      status: "idle",
      has_active_turn: true,
    };
    let listCall = 0;
    renderChats(
      `/chats/${conversationId}`,
      routesFor([idleRow], { ...conversationFixture, active_turn: turnFixture() }, [
        {
          path: "/api/v1/conversations",
          body: () => {
            listCall += 1;
            return {
              items: listCall === 1 ? [idleRow] : [openTurnRow],
              next_cursor: null,
            };
          },
        },
      ]),
    );

    const row = await screen.findByTestId(`chat-row-${conversationId}`);
    expect(screen.queryByTestId(`chat-row-status-${conversationId}`)).toBeNull();

    act(() => {
      FakeEventSource.last().open();
    });
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Hello from the pane",
        }),
      );
      FakeEventSource.last().emit(conversationEvent("conversation.turn.started", {}));
    });

    const status = await screen.findByTestId(`chat-row-status-${conversationId}`, undefined, {
      timeout: 5_000,
    });
    expect(status.textContent).toBe("● run");
    // The row itself never left the screen: no remount, no flash.
    expect(screen.getByTestId(`chat-row-${conversationId}`)).toBe(row);
  });

  it("keeps the chat list up while a cold chat loads (gh-69)", async () => {
    const { fetchMock } = renderChats(
      "/chats",
      routesFor([conversationSummaryFixture, secondRow], conversationFixture),
    );
    await screen.findByTestId(`chat-row-${conversationId}`);
    const release = gateRequests(fetchMock, `/api/v1/conversations/${secondId}`);
    fireEvent.click(screen.getByTestId(`chat-row-${secondId}`));

    // The frame holds: the list is still the list, its rows still listed, and
    // the pending line sits inside the thread column rather than replacing
    // the screen.
    expect(screen.getByTestId("chat-list")).toBeTruthy();
    expect(screen.getByTestId(`chat-row-${conversationId}`)).toBeTruthy();
    expect(screen.getByTestId("chat-thread").textContent).toContain("Loading chat");

    release();
    await waitFor(() => expect(screen.getByTestId("chat-title").textContent).toBe(second.title));
    expect(screen.getByTestId(`chat-row-${secondId}`).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the previously opened chat painted while the next one loads (gh-69)", async () => {
    const { fetchMock, requests } = renderChats(
      `/chats/${conversationId}`,
      routesFor([conversationSummaryFixture, secondRow], conversationFixture),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-title").textContent).toBe(conversationFixture.title),
    );

    const release = gateRequests(fetchMock, `/api/v1/conversations/${secondId}`);
    fireEvent.click(screen.getByTestId(`chat-row-${secondId}`));

    await waitFor(() =>
      expect(requests.filter((r) => r.url === `/api/v1/conversations/${secondId}`)).toHaveLength(1),
    );
    // placeholderData: keepPreviousData — the first chat stays painted and no
    // fallback line ever appears in the column.
    expect(screen.getByTestId("chat-title").textContent).toBe(conversationFixture.title);
    expect(screen.queryByText("Loading chat")).toBeNull();

    release();
    await waitFor(() => expect(screen.getByTestId("chat-title").textContent).toBe(second.title));
  });

  it("marks the chat the URL opens (no second selection state)", async () => {
    const queryClient = new QueryClient();
    void queryClient.getQueryData(queryKeys.conversation(conversationId));
    renderChats(
      `/chats/${conversationId}`,
      routesFor([conversationSummaryFixture, secondRow], conversationFixture),
    );
    const row = await screen.findByTestId(`chat-row-${conversationId}`);
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.textContent).toContain(conversationFixture.title);
    expect(screen.getByTestId(`chat-row-${secondId}`).getAttribute("aria-current")).toBeNull();
  });
});
