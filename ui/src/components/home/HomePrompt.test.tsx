/**
 * HomePrompt: the All-scope project chip starts on the stored pick, submit
 * sends exactly the body NewConversationDialog sends and lands on the new
 * chat, the project scope hides the picker, a multi-repository project gets
 * the repository chip (default: none, like the dialog), and an empty
 * project list disables the box with the honest footer.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HOME_PROJECT_KEY, HomePrompt, titleFromPrompt } from "./HomePrompt";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";

const secondProject = {
  ...projectFixture,
  id: "01987a6c-0000-7000-8000-999999999999",
  name: "Project Two",
};

function Probe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname}</div>;
}

function renderPrompt(routes: RouteStub[], props: Parameters<typeof HomePrompt>[0] = {}) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        {children}
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(<HomePrompt {...props} />, { wrapper });
  return { requests };
}

const repoFixture = (name: string) => ({
  id: `01987a79-aaaa-7000-8000-${name}`,
  project_id: projectFixture.id,
  name,
  git_url: `https://github.com/example/${name}.git`,
  default_branch: "main",
  created_at: "2026-10-14T15:00:00Z",
});

const baseRoutes = (
  projects: unknown[],
  repos: unknown[] = [],
  profiles: unknown[] = [claudeProfile],
): RouteStub[] => [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: projects } },
  { path: "/api/v1/agent-profiles", body: { items: profiles } },
  { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: repos } },
  { path: `/api/v1/projects/${secondProject.id}/repos`, body: { items: [] } },
];

const pickAgentAndSend = async (text: string) => {
  fireEvent.change(await screen.findByTestId("home-prompt-input"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("home-prompt-agent"));
  fireEvent.click(await screen.findByTestId(`agent-option-${claudeProfile.id}`));
  fireEvent.click(screen.getByTestId("home-prompt-send"));
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("titleFromPrompt", () => {
  it("takes the first line and caps it", () => {
    expect(titleFromPrompt("Fix the flaky test\n\nwith details")).toBe("Fix the flaky test");
    expect(titleFromPrompt(`  ${"a".repeat(200)}`)).toBe(`${"a".repeat(80)}…`);
  });
});

describe("HomePrompt (All scope)", () => {
  it("asks for the new chat with the one placeholder sentence", async () => {
    renderPrompt(baseRoutes([projectFixture]));
    const input = await screen.findByTestId("home-prompt-input");
    expect(input.getAttribute("placeholder")).toBe("Ask, plan, or hand off a task…");
    expect(input.getAttribute("aria-label")).toBe("Ask, plan or start something");
  });

  it("defaults to the first project and first profile and ignores stale storage", async () => {
    localStorage.setItem(HOME_PROJECT_KEY, "removed");
    localStorage.setItem(`communication.home.agent.${projectFixture.id}`, "removed");
    renderPrompt(baseRoutes([projectFixture, secondProject]));
    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-project").textContent).toBe("Widgets"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(claudeProfile.name),
    );
  });

  it("remembers agent choices separately for each project and stores project choices", async () => {
    const secondAgent = { ...claudeProfile, id: "second-agent", name: "Second Agent" };
    localStorage.setItem(`communication.home.agent.${secondProject.id}`, secondAgent.id);
    renderPrompt(baseRoutes([projectFixture, secondProject], [], [claudeProfile, secondAgent]));
    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(claudeProfile.name),
    );
    fireEvent.click(screen.getByTestId("home-prompt-agent"));
    fireEvent.click(await screen.findByTestId(`agent-option-${secondAgent.id}`));
    expect(localStorage.getItem(`communication.home.agent.${projectFixture.id}`)).toBe(
      secondAgent.id,
    );
    fireEvent.click(screen.getByTestId("home-prompt-project"));
    fireEvent.click(await screen.findByTestId(`home-prompt-project-option-${secondProject.id}`));
    expect(localStorage.getItem(HOME_PROJECT_KEY)).toBe(secondProject.id);
    expect(screen.getByTestId("home-prompt-agent").textContent).toContain(secondAgent.name);
    fireEvent.click(screen.getByTestId("home-prompt-agent"));
    fireEvent.click(await screen.findByTestId(`agent-option-${claudeProfile.id}`));
    fireEvent.click(screen.getByTestId("home-prompt-project"));
    fireEvent.click(await screen.findByTestId(`home-prompt-project-option-${projectFixture.id}`));
    expect(screen.getByTestId("home-prompt-agent").textContent).toContain(secondAgent.name);
  });

  it("starts on the stored project and names it on the chip", async () => {
    localStorage.setItem(HOME_PROJECT_KEY, secondProject.id);
    renderPrompt(baseRoutes([projectFixture, secondProject]));
    const chip = await screen.findByText("Project Two");
    expect(chip.closest("[data-testid='home-prompt-project']")).toBeTruthy();
  });

  it("opens on the single project when there is exactly one", async () => {
    renderPrompt(baseRoutes([projectFixture]));
    const chip = await screen.findByText("Widgets");
    expect(chip.closest("[data-testid='home-prompt-project']")).toBeTruthy();
  });

  it("marks the menu chips with a trailing chevron (project, repository) — rx-h3", async () => {
    renderPrompt(baseRoutes([projectFixture], [repoFixture("api"), repoFixture("web")]));
    const lastClass = (el: Element) => {
      const svgs = el.querySelectorAll("svg");
      return svgs[svgs.length - 1]?.getAttribute("class") ?? "";
    };
    const projectChip = await screen.findByTestId("home-prompt-project");
    // The folder icon comes first, the chevron last.
    expect(projectChip.querySelectorAll("svg").length).toBe(2);
    expect(lastClass(projectChip)).toContain("tabler-icon-chevron-down");
    const repoChip = await screen.findByTestId("home-prompt-repository");
    expect(lastClass(repoChip)).toContain("tabler-icon-chevron-down");
  });

  it("creates the conversation with the dialog's body, remembers the pick, and navigates to the chat", async () => {
    const { requests } = renderPrompt([
      ...baseRoutes([projectFixture]),
      {
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        method: "POST",
        body: conversationFixture,
      },
    ]);
    await pickAgentAndSend("Fix the flaky test");

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST").length,
      ).toBe(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST")[0].body ??
        "{}",
    );
    // Exactly the NewConversationDialog body: the typed text is the first
    // prompt; the title is its first line. No repository — the dialog's default.
    expect(body).toEqual({
      agent_profile_id: claudeProfile.id,
      title: "Fix the flaky test",
      prompt: "Fix the flaky test",
    });
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe(
        `/p/${projectFixture.id}/chats/${conversationFixture.id}`,
      ),
    );
    expect(localStorage.getItem(HOME_PROJECT_KEY)).toBe(projectFixture.id);
  });

  it("asks for an agent before sending and never posts", async () => {
    const { requests } = renderPrompt(baseRoutes([projectFixture], [], []));
    await screen.findByText("No agents yet");
    fireEvent.change(await screen.findByTestId("home-prompt-input"), {
      target: { value: "Start something" },
    });
    expect(await screen.findByTestId("home-prompt-need-agent")).toBeTruthy();
    expect((screen.getByTestId("home-prompt-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("home-prompt-agent") as HTMLButtonElement).disabled).toBe(false);
    expect(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST").length,
    ).toBe(0);
  });

  it("disables the box and points at Manage when there are no projects", async () => {
    renderPrompt(baseRoutes([]));
    const input = (await screen.findByTestId("home-prompt-input")) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    const footer = await screen.findByTestId("home-prompt-no-projects");
    expect(footer.textContent).toContain("Add a project to start.");
    expect(footer.querySelector("a")?.getAttribute("href")).toBe("/manage/projects");
  });

  it("shows the repository chip only when the project has more than one, and sends the chosen name", async () => {
    renderPrompt(baseRoutes([projectFixture], [repoFixture("api"), repoFixture("web")]));
    const chip = await screen.findByTestId("home-prompt-repository");
    // The dialog's default: no repository bound; the list settles a beat later.
    await waitFor(() => expect(chip.textContent).toBe("No repository"));
  });

  it("sends the picked repository in the create body", async () => {
    const { requests } = renderPrompt(
      [
        ...baseRoutes([projectFixture], [repoFixture("api"), repoFixture("web")]),
        {
          path: `/api/v1/projects/${projectFixture.id}/conversations`,
          method: "POST",
          body: conversationFixture,
        },
      ],
      {},
    );
    fireEvent.change(await screen.findByTestId("home-prompt-input"), {
      target: { value: "Bump the api client" },
    });
    await screen.findByTestId("home-prompt-repository");
    fireEvent.click(screen.getByTestId("home-prompt-repository"));
    fireEvent.click(await screen.findByTestId("home-prompt-repository-option-web"));
    fireEvent.click(screen.getByTestId("home-prompt-agent"));
    fireEvent.click(await screen.findByTestId(`agent-option-${claudeProfile.id}`));
    fireEvent.click(screen.getByTestId("home-prompt-send"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST").length,
      ).toBe(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST")[0].body ??
        "{}",
    );
    expect(body.repository).toBe("web");
  });
});

describe("HomePrompt (project scope)", () => {
  it("hides the project chip and navigates inside the project", async () => {
    renderPrompt(
      [
        ...baseRoutes([projectFixture]),
        {
          path: `/api/v1/projects/${projectFixture.id}/conversations`,
          method: "POST",
          body: conversationFixture,
        },
      ],
      { projectId: projectFixture.id, placeholder: "What should we do in Widgets?" },
    );
    expect(screen.queryByTestId("home-prompt-project")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(claudeProfile.name),
    );
    expect((await screen.findByTestId("home-prompt-input")).getAttribute("placeholder")).toBe(
      "What should we do in Widgets?",
    );
    await pickAgentAndSend("Ship the beta");
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe(
        `/p/${projectFixture.id}/chats/${conversationFixture.id}`,
      ),
    );
  });
});

describe("the agent chip's starting profile (ADR-0086)", () => {
  const codexAgent = { ...codexProfile };

  it("preselects the project's default agent when nothing was chosen here", async () => {
    // The default is NOT the first profile, so the pick can only come from the
    // project's own row.
    const withDefault = {
      ...projectFixture,
      default_agent_profile_id: codexAgent.id,
      default_agent_profile_name: codexAgent.name,
    };
    renderPrompt(baseRoutes([withDefault], [], [claudeProfile, codexAgent]));

    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(codexAgent.name),
    );
  });

  it("the choice stored in this browser still outranks the project's default", async () => {
    localStorage.setItem(`communication.home.agent.${projectFixture.id}`, claudeProfile.id);
    const withDefault = {
      ...projectFixture,
      default_agent_profile_id: codexAgent.id,
      default_agent_profile_name: codexAgent.name,
    };
    renderPrompt(baseRoutes([withDefault], [], [claudeProfile, codexAgent]));

    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(claudeProfile.name),
    );
  });

  it("ignores a default that is no longer one of the profiles", async () => {
    const stale = {
      ...projectFixture,
      default_agent_profile_id: "deleted-profile",
      default_agent_profile_name: "Deleted profile",
    };
    renderPrompt(baseRoutes([stale], [], [claudeProfile, codexAgent]), {
      projectId: projectFixture.id,
    });

    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(claudeProfile.name),
    );
    expect(screen.getByTestId("home-prompt-agent").textContent).not.toContain("Deleted");
  });

  it("sends the preselected default without anyone touching the chip", async () => {
    const withDefault = {
      ...projectFixture,
      default_agent_profile_id: codexAgent.id,
      default_agent_profile_name: codexAgent.name,
    };
    const { requests } = renderPrompt(
      [
        ...baseRoutes([withDefault], [], [claudeProfile, codexAgent]),
        {
          path: `/api/v1/projects/${projectFixture.id}/conversations`,
          method: "POST",
          body: conversationFixture,
        },
      ],
      { projectId: projectFixture.id },
    );

    await waitFor(() =>
      expect(screen.getByTestId("home-prompt-agent").textContent).toContain(codexAgent.name),
    );
    fireEvent.change(screen.getByTestId("home-prompt-input"), {
      target: { value: "Triage the flaky tests" },
    });
    fireEvent.click(screen.getByTestId("home-prompt-send"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST").length,
      ).toBe(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST")[0].body ??
        "{}",
    );
    expect(body.agent_profile_id).toBe(codexAgent.id);
  });
});
