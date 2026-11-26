import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatList } from "./ChatList";
import { queryKeys } from "../../api/queries";
import type { Conversation, ConversationSummary, Project } from "../../api/types";
import {
  claudeProfile,
  conversationFixture,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  otherUserId,
  permissionRequestFixture,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const projectOne: Project = { ...projectFixture, id: "proj-1", slug: "p1", name: "Project One" };
const projectTwo: Project = { ...projectFixture, id: "proj-2", slug: "p2", name: "Project Two" };

const chatA: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "chat-a",
  project_id: "proj-1",
  title: "First chat",
  has_active_turn: true,
  last_agent_line: "Working on the handler now.",
};

const chatB: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "chat-b",
  project_id: "proj-2",
  title: "Second chat",
  has_active_turn: false,
  control: {
    kind: "human",
    user_id: meFixture.id,
    display_name: meFixture.display_name,
    previous_user_id: otherUserId,
    version: 2,
  },
  last_agent_line: "Handed back to you.",
};

const chatC: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "chat-c",
  project_id: "proj-1",
  title: "Third chat",
  has_active_turn: false,
  control: {
    kind: "human",
    user_id: meFixture.id,
    display_name: meFixture.display_name,
    previous_user_id: null,
    version: 1,
  },
  last_agent_line: null,
};

function renderChatList({
  scope,
  selectedId,
  items,
  seedConversation,
}: {
  scope: string | null;
  selectedId?: string;
  items: ConversationSummary[];
  seedConversation?: Conversation;
}) {
  const routes: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectOne, projectTwo] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: "/api/v1/conversations", body: { items, next_cursor: null } },
    { path: "/api/v1/projects/proj-1/conversations", body: { items } },
  ];
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seedConversation) {
    queryClient.setQueryData(queryKeys.conversation(seedConversation.id), seedConversation);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatList scope={scope} selectedId={selectedId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatList", () => {
  it("groups chats by project under All scope and omits headers in a project scope", async () => {
    renderChatList({ scope: null, items: [chatA, chatB, chatC] });

    await screen.findByTestId("chat-group-proj-1");
    expect(screen.getByTestId("chat-group-proj-1").textContent).toContain("Project One");
    expect(screen.getByTestId("chat-group-proj-2").textContent).toContain("Project Two");
    expect(screen.getByTestId("chat-row-chat-a").getAttribute("href")).toBe("/chats/chat-a");
    expect(screen.getByTestId("chat-new").getAttribute("href")).toBe("/chats/new");

    cleanup();
    renderChatList({ scope: "proj-1", items: [chatA, chatC] });
    await screen.findByTestId("chat-row-chat-a");
    expect(screen.queryByTestId("chat-group-proj-1")).toBeNull();
    expect(screen.getByTestId("chat-row-chat-a").getAttribute("href")).toBe(
      "/p/proj-1/chats/chat-a",
    );
    expect(screen.getByTestId("chat-new").getAttribute("href")).toBe("/p/proj-1/chats/new");
  });

  it("shows '! you' when waiting on current person and '● run' when a turn is running", async () => {
    const waitingConv: Conversation = {
      ...conversationFixture,
      id: "chat-c",
      pending_permissions: [permissionRequestFixture],
    };
    renderChatList({ scope: null, items: [chatA, chatB, chatC], seedConversation: waitingConv });

    await screen.findByTestId("chat-row-chat-a");
    const statusA = screen.getByTestId("chat-row-status-chat-a");
    expect(statusA.textContent).toBe("● run");
    expect(statusA.className).toContain("text-st-running-tag-fg");

    const statusB = screen.getByTestId("chat-row-status-chat-b");
    expect(statusB.textContent).toBe("! you");
    expect(statusB.className).toContain("text-st-waiting-tag-fg");

    const statusC = screen.getByTestId("chat-row-status-chat-c");
    expect(statusC.textContent).toBe("! you");
  });

  it("marks the selected row with aria-current='page' and accent-wash background", async () => {
    renderChatList({ scope: null, selectedId: "chat-a", items: [chatA, chatB] });
    const rowA = await screen.findByTestId("chat-row-chat-a");
    expect(rowA.getAttribute("aria-current")).toBe("page");
    expect(rowA.className).toContain("bg-accent-wash");
    expect(screen.getByTestId("chat-row-chat-b").getAttribute("aria-current")).toBeNull();
  });

  it("shows empty state when there are no chats", async () => {
    renderChatList({ scope: null, items: [] });
    const empty = await screen.findByTestId("chat-list-empty");
    expect(empty.textContent).toBe("No chats yet.");
  });

  it("filters All / One-off / From runs in All scope and sends origin param in project scope", async () => {
    const runChat: ConversationSummary = {
      ...chatA,
      id: "chat-run",
      title: "Run chat",
      origin: "run",
    };
    const manualChat: ConversationSummary = {
      ...chatC,
      id: "chat-manual",
      title: "Manual chat",
      origin: "manual",
    };
    renderChatList({ scope: null, items: [manualChat, runChat] });

    await screen.findByTestId("chat-row-chat-manual");
    expect(screen.getByTestId("chat-row-chat-run")).toBeTruthy();

    fireEvent.click(screen.getByTestId("threads-filter-runs"));
    expect(screen.queryByTestId("chat-row-chat-manual")).toBeNull();
    expect(screen.getByTestId("chat-row-chat-run")).toBeTruthy();

    fireEvent.click(screen.getByTestId("threads-filter-manual"));
    expect(screen.getByTestId("chat-row-chat-manual")).toBeTruthy();
    expect(screen.queryByTestId("chat-row-chat-run")).toBeNull();

    fireEvent.click(screen.getByTestId("threads-filter-all"));
    expect(screen.getByTestId("chat-row-chat-manual")).toBeTruthy();
    expect(screen.getByTestId("chat-row-chat-run")).toBeTruthy();

    cleanup();
    const seen: string[] = [];
    const routes: RouteStub[] = [
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectOne] } },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
      { path: "/api/v1/projects/proj-1/conversations", body: { items: [manualChat, runChat] } },
    ];
    const { fetchMock } = mockFetch(routes);
    const inner = fetchMock.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input, init);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ChatList scope="proj-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId("chat-row-chat-run");
    fireEvent.click(screen.getByTestId("threads-filter-runs"));
    await waitFor(() => expect(seen).toContain("/api/v1/projects/proj-1/conversations?origin=run"));
  });
});
