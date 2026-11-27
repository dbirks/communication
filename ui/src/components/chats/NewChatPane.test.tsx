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
  it("asks for the new chat with the one placeholder sentence, in both scopes", async () => {
    renderNewChat(null, []);
    const allScope = await screen.findByTestId("new-chat-prompt-input");
    expect(allScope.getAttribute("placeholder")).toBe("Ask, plan, or hand off a task…");
    cleanup();

    renderNewChat(projectFixture.id, []);
    const projectScope = await screen.findByTestId("new-chat-prompt-input");
    expect(projectScope.getAttribute("placeholder")).toBe("Ask, plan, or hand off a task…");
  });

  it("creates a conversation with first prompt and navigates to the new chat", async () => {
    const { requests } = renderNewChat(projectFixture.id, []);

    await screen.findByTestId("new-chat-prompt");
    await screen.findByText(claudeProfile.name);
    // In project scope the picker is gone; the project wears a fixed chip.
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

  it("lists the five chats after the first three when there are more than three", async () => {
    renderNewChat(null, recentItems);

    const pickUp = await screen.findByTestId("new-chat-pick-up");
    expect(pickUp.textContent).toContain("OR PICK UP");
    // The first three are already at the top of the left list.
    expect(screen.queryByTestId("new-chat-recent-chat-1")).toBeNull();
    expect(screen.queryByTestId("new-chat-recent-chat-3")).toBeNull();
    expect(screen.getByTestId("new-chat-recent-chat-4").getAttribute("href")).toBe("/chats/chat-4");
    expect(screen.getByTestId("new-chat-recent-chat-6")).toBeTruthy();
    expect(pickUp.querySelectorAll("a")).toHaveLength(3);
  });

  it("lists every chat when there are three or fewer", async () => {
    renderNewChat(null, recentItems.slice(0, 2));
    await screen.findByTestId("new-chat-recent-chat-1");
    expect(screen.getByTestId("new-chat-recent-chat-2")).toBeTruthy();
    expect(screen.getByTestId("new-chat-pick-up").querySelectorAll("a")).toHaveLength(2);
    cleanup();

    renderNewChat(null, recentItems.slice(0, 3));
    await screen.findByTestId("new-chat-recent-chat-1");
    expect(screen.getByTestId("new-chat-recent-chat-3")).toBeTruthy();
    expect(screen.getByTestId("new-chat-pick-up").querySelectorAll("a")).toHaveLength(3);
  });

  it("caps the list at the next five chats", async () => {
    renderNewChat(
      null,
      Array.from({ length: 10 }, (_, i) => ({
        ...recentItems[0],
        id: `chat-${i + 1}`,
        title: `Recent chat ${i + 1}`,
      })),
    );

    await screen.findByTestId("new-chat-recent-chat-4");
    expect(screen.getByTestId("new-chat-recent-chat-8")).toBeTruthy();
    expect(screen.queryByTestId("new-chat-recent-chat-9")).toBeNull();
    expect(screen.getByTestId("new-chat-pick-up").querySelectorAll("a")).toHaveLength(5);
  });

  it("gives each pick-up row its resume arrow, and the project tag only at All scope", async () => {
    renderNewChat(null, recentItems.slice(0, 3));
    const allScopeRow = await screen.findByTestId("new-chat-recent-chat-1");
    const icon = allScopeRow.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("class")).toContain("text-accent-edge");
    const tag = screen.getByTestId("new-chat-recent-project-chat-1");
    expect(tag.textContent).toBe(projectFixture.name);
    expect(tag.getAttribute("class")).toContain("font-mono");
    // The project tag sits before the age.
    expect(
      Array.from(allScopeRow.querySelectorAll("span")).indexOf(tag) <
        Array.from(allScopeRow.querySelectorAll("span")).indexOf(
          allScopeRow.querySelector(".text-faint")!,
        ),
    ).toBe(true);
    cleanup();

    renderNewChat(projectFixture.id, recentItems.slice(0, 3));
    const scopedRow = await screen.findByTestId("new-chat-recent-chat-1");
    expect(scopedRow.querySelector("svg")).toBeTruthy();
    expect(screen.queryByTestId("new-chat-recent-project-chat-1")).toBeNull();
    // A scoped row shows no project name at all.
    expect(scopedRow.textContent).not.toContain(projectFixture.name);
  });

  it("centres the block in the pane and caps the box and list at 700px", async () => {
    renderNewChat(projectFixture.id, recentItems.slice(0, 2));

    const body = await screen.findByTestId("new-chat-body");
    // 740 − the 20px side padding on each side = the README's 700px box.
    expect(body.getAttribute("class")).toContain("max-w-[740px]");
    expect(body.getAttribute("class")).toContain("px-[20px]");
    expect(body.getAttribute("class")).toContain("min-h-full");
    expect(body.getAttribute("class")).toContain("justify-center");
    expect(body.getAttribute("class")).toContain("py-[48px]");
    // Phone (below 768px): start at the top with 24px of padding.
    expect(body.getAttribute("class")).toContain("max-md:justify-start");
    expect(body.getAttribute("class")).toContain("max-md:pt-[24px]");

    // The prompt box and the OR PICK UP list are the block's only children.
    await screen.findByTestId("new-chat-pick-up");
    expect(screen.getByTestId("new-chat-prompt").parentElement).toBe(body);
    expect(screen.getByTestId("new-chat-pick-up").parentElement).toBe(body);
  });

  it("shows the project as a fixed chip in a project scope and the picker at All scope", async () => {
    renderNewChat(projectFixture.id, []);
    const chip = await screen.findByTestId("chat-new-project-fixed");
    expect(chip.textContent).toContain(projectFixture.name);
    expect(chip.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("new-chat-project-menu")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByTestId("new-chat-project-menu")).toBeNull();
    cleanup();

    renderNewChat(null, []);
    await screen.findByTestId("new-chat-project-chip");
    expect(screen.queryByTestId("chat-new-project-fixed")).toBeNull();
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
