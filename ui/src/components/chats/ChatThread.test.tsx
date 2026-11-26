import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "./ChatThread";
import type { Conversation } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  conversationFixture,
  conversationId,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
});

function renderThread(conversation: Conversation) {
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
    { path: `/api/v1/conversations/${conversation.id}`, body: conversation },
    { path: `/api/v1/conversations/${conversation.id}/assistant-notes`, body: { notes: [] } },
  ];
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatThread conversationId={conversation.id} scope={projectFixture.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatThread Details sheet part-of-run-link", () => {
  it("shows part-of-run-link with ?node=&instance=&attempt= for a run-linked chat", async () => {
    const runLinked: Conversation = {
      ...conversationFixture,
      origin: "run",
      run_link: {
        run_id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
        node_execution_id: "01987b11-0000-7000-8000-000000000011",
        node_instance_key: "/loop/implement",
        node_id: "implement",
        attempt_id: "01987b11-0000-7000-8000-000000000022",
        attempt_number: 2,
        run_title: "Fix flaky test",
      },
    };
    renderThread(runLinked);

    fireEvent.click(await screen.findByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-details"));
    const sheet = await screen.findByTestId("chat-details-sheet");
    const link = within(sheet).getByTestId("part-of-run-link");
    expect(link.textContent).toContain("Part of run");
    expect(link.getAttribute("href")).toBe(
      `/runs/01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c?node=implement&instance=01987b11-0000-7000-8000-000000000011&attempt=2`,
    );
  });

  it("omits part-of-run-link for a manual chat", async () => {
    renderThread({ ...conversationFixture, id: conversationId, origin: "manual", run_link: null });

    fireEvent.click(await screen.findByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-details"));
    const sheet = await screen.findByTestId("chat-details-sheet");
    expect(within(sheet).queryByTestId("part-of-run-link")).toBeNull();
  });
});
