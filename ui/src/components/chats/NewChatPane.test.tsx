import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatPane } from "./NewChatPane";
import type { ConversationSummary } from "../../api/types";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function PathDisplay() {
  const { pathname } = useLocation();
  return <div data-testid="location-path">{pathname}</div>;
}

const recentItems: ConversationSummary[] = Array.from({ length: 6 }, (_, i) => ({
  ...conversationSummaryFixture,
  id: `chat-${i + 1}`,
  project_id: projectFixture.id,
  title: `Recent chat ${i + 1}`,
  last_agent_line: `Last line ${i + 1}`,
}));

function renderNewChat(scope: string | null, items: ConversationSummary[] = recentItems) {
  const createdConv = { ...conversationFixture, id: "new-conv-1" };
  const routes: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
    { path: "/api/v1/conversations", method: "GET", body: { items, next_cursor: null } },
    { path: `/api/v1/projects/${projectFixture.id}/conversations`, method: "GET", body: { items } },
    {
      path: `/api/v1/projects/${projectFixture.id}/conversations`,
      method: "POST",
      status: 201,
      body: createdConv,
    },
  ];
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[scope ? `/p/${scope}/chats/new` : "/chats/new"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NewChatPane scope={scope} />
                <PathDisplay />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("NewChatPane", () => {
  it("creates a conversation with first prompt and navigates to the new chat", async () => {
    const { requests } = renderNewChat(projectFixture.id, []);

    await screen.findByTestId("new-chat-prompt");
    await screen.findByText(claudeProfile.name);
    // In project scope, project picker chip is hidden.
    expect(screen.queryByTestId("new-chat-project-chip")).toBeNull();

    const input = screen.getByTestId("new-chat-prompt-input");
    fireEvent.change(input, { target: { value: "Investigate flaky test" } });
    fireEvent.click(screen.getByTestId("new-chat-prompt-send"));

    await waitFor(() => {
      expect(screen.getByTestId("location-path").textContent).toBe(
        `/p/${projectFixture.id}/chats/new-conv-1`,
      );
    });

    const posts = requestsTo(
      requests,
      `/api/v1/projects/${projectFixture.id}/conversations`,
      "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body!)).toEqual({
      agent_profile_id: claudeProfile.id,
      title: "Investigate flaky test",
      prompt: "Investigate flaky test",
    });
  });

  it("renders up to 5 OR PICK UP recent chat rows linking to them", async () => {
    renderNewChat(null, recentItems);

    const pickUp = await screen.findByTestId("new-chat-pick-up");
    expect(pickUp.textContent).toContain("OR PICK UP");
    expect(screen.getByTestId("new-chat-recent-chat-1").getAttribute("href")).toBe("/chats/chat-1");
    expect(screen.getByTestId("new-chat-recent-chat-5")).toBeTruthy();
    expect(screen.queryByTestId("new-chat-recent-chat-6")).toBeNull();
  });
});

/** The pane for a project whose default agent is NOT the first profile, with
 * the profile list and both project reads stubbed. */
function renderScopedWithDefault(defaultId: string | null, defaultName: string | null) {
  const scopedProject = {
    ...projectFixture,
    default_agent_profile_id: defaultId,
    default_agent_profile_name: defaultName,
  };
  const routes: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [scopedProject] } },
    { path: `/api/v1/projects/${projectFixture.id}`, method: "GET", body: scopedProject },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
    {
      path: `/api/v1/projects/${projectFixture.id}/conversations`,
      method: "GET",
      body: { items: [] },
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/conversations`,
      method: "POST",
      status: 201,
      body: { ...conversationFixture, id: "new-conv-1" },
    },
  ];
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${projectFixture.id}/chats/new`]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NewChatPane scope={projectFixture.id} />
                <PathDisplay />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("the agent chip's starting profile (ADR-0086)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    // The per-project agent memory is this browser's, not the suite's.
    localStorage.clear();
  });

  it("preselects the project's default agent, not the first profile", async () => {
    renderScopedWithDefault(codexProfile.id, codexProfile.name);

    await waitFor(() =>
      expect(screen.getByTestId("new-chat-agent-picker").textContent).toContain(codexProfile.name),
    );
  });

  it("the choice stored for this project wins over the project's default", async () => {
    localStorage.setItem(`communication.home.agent.${projectFixture.id}`, claudeProfile.id);
    renderScopedWithDefault(codexProfile.id, codexProfile.name);

    await waitFor(() =>
      expect(screen.getByTestId("new-chat-agent-picker").textContent).toContain(claudeProfile.name),
    );
  });

  it("a default that is no longer offered falls back to the first profile", async () => {
    renderScopedWithDefault("deleted-profile", "Deleted profile");

    await waitFor(() =>
      expect(screen.getByTestId("new-chat-agent-picker").textContent).toContain(claudeProfile.name),
    );
    expect(screen.getByTestId("new-chat-agent-picker").textContent).not.toContain("Deleted");
  });

  it("starts a chat on the preselected default, and remembers a pick for the project", async () => {
    const { requests } = renderScopedWithDefault(codexProfile.id, codexProfile.name);

    await waitFor(() =>
      expect(screen.getByTestId("new-chat-agent-picker").textContent).toContain(codexProfile.name),
    );
    fireEvent.change(screen.getByTestId("new-chat-prompt-input"), {
      target: { value: "Skim the failing suite" },
    });
    fireEvent.click(screen.getByTestId("new-chat-prompt-send"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST")[0]
          .body!,
      ).agent_profile_id,
    ).toBe(codexProfile.id);

    // A pick made here is the same per-project memory the Home box writes.
    fireEvent.click(screen.getByTestId("new-chat-agent-picker"));
    fireEvent.click(await screen.findByTestId(`agent-option-${claudeProfile.id}`));
    expect(localStorage.getItem(`communication.home.agent.${projectFixture.id}`)).toBe(
      claudeProfile.id,
    );
  });
});
