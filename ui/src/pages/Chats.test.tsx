import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Chats from "./Chats";
import {
  FakeEventSource,
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
});

function stubMatchMedia(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 767.98px") ? narrow : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderChats(path: string, narrow: boolean) {
  stubMatchMedia(narrow);
  vi.stubGlobal("EventSource", FakeEventSource);

  const routes: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/workspaces`, body: { workspaces: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/assignments`, body: { assignments: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/artifacts`, body: { artifacts: [] } },
    { path: "/api/v1/pipelines", body: { pipelines: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    {
      path: "/api/v1/conversations",
      body: { items: [conversationSummaryFixture], next_cursor: null },
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/conversations`,
      body: { items: [conversationSummaryFixture] },
    },
    { path: `/api/v1/conversations/${conversationId}`, body: conversationFixture },
    { path: `/api/v1/conversations/${conversationId}/assistant-notes`, body: { notes: [] } },
  ];
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chats/:conversationId?" element={<Chats />} />
          <Route path="/p/:projectId/chats/:conversationId?" element={<Chats />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Chats", () => {
  it("renders ChatList + NewChatPane on /chats and /chats/new at desktop", async () => {
    renderChats("/chats/new", false);
    await screen.findByTestId("chat-list");
    expect(screen.getByTestId("chat-new-pane")).toBeTruthy();
    expect(screen.queryByTestId("chat-thread")).toBeNull();
  });

  it("renders ChatList + ChatThread on /chats/:id at desktop", async () => {
    renderChats(`/chats/${conversationId}`, false);
    await screen.findByTestId("chat-list");
    await screen.findByTestId("chat-header");
    expect(screen.getByTestId("chat-thread")).toBeTruthy();
    expect(screen.getByTestId("chat-title").textContent).toBe(conversationFixture.title);
    expect(screen.queryByTestId("chat-new-pane")).toBeNull();
  });

  it("on phone (<768px), shows only the list at /chats and only the thread with back arrow at /chats/:id", async () => {
    renderChats("/p/widgets/chats", true);
    await screen.findByTestId("chat-list");
    expect(screen.queryByTestId("chat-new-pane")).toBeNull();
    expect(screen.queryByTestId("chat-thread")).toBeNull();

    cleanup();
    renderChats(`/p/${projectFixture.id}/chats/${conversationId}`, true);
    await screen.findByTestId("chat-header");
    expect(screen.queryByTestId("chat-list")).toBeNull();
    const back = screen.getByTestId("chat-back");
    expect(back.getAttribute("href")).toBe(`/p/${projectFixture.id}/chats`);

    cleanup();
    renderChats("/chats/new", true);
    await screen.findByTestId("chat-new-pane");
    expect(screen.queryByTestId("chat-list")).toBeNull();
    expect(screen.getByTestId("chat-back").getAttribute("href")).toBe("/chats");
  });
});
