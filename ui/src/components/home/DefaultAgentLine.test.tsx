/**
 * The project's DEFAULT AGENT line (ADR-0086): the name it may print, who is
 * allowed to move it, and what a refused write says.
 *
 * The line is always mounted from a `useProject` read, exactly as the project
 * home and the Manage detail page mount it — so a save lands through the
 * project cache, and a rollback is visible as the label the server still says.
 *
 * The write itself is the project's optimistic PATCH: the body must carry the
 * id (or the explicit `null` that clears it) plus the `version` the read
 * returned; the two sentences the server's answers map onto are asserted here,
 * not the server's behaviour.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultAgentLine, defaultAgentSaveLine } from "./DefaultAgentLine";
import { useProject } from "../../api/queries";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";
import type { Project } from "../../api/types";

const projectPath = `/api/v1/projects/${projectFixture.id}`;

function project(overrides: Partial<Project> = {}): Project {
  return {
    ...projectFixture,
    default_agent_profile_id: claudeProfile.id,
    default_agent_profile_name: claudeProfile.name,
    ...overrides,
  };
}

/** The line as the pages mount it: from the project's own read. */
function MountedLine() {
  const read = useProject(projectFixture.id);
  if (!read.data) return null;
  return <DefaultAgentLine project={read.data} />;
}

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch([
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    ...routes,
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MountedLine />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

/** The one read every case below starts from. */
const get = (body: RouteStub["body"]): RouteStub => ({ path: projectPath, method: "GET", body });

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("what the line says", () => {
  it("heads the block with a sentence-case column heading", async () => {
    harness([get(project({ my_role: "viewer" }))]);

    const head = await screen.findByTestId("project-default-agent-label");
    expect(head.tagName).toBe("H3");
    expect(head.textContent).toBe("Default agent");
    expect(head.className).toContain("text-[16px]");
    expect(head.className).toContain("border-line-soft");
    expect(head.className).not.toContain("font-mono");
  });

  it("prints the profile's own name for a member, with no way to move it", async () => {
    harness([get(project({ my_role: "viewer" }))]);

    const name = await screen.findByTestId("project-default-agent-name");
    expect(name.textContent).toBe(claudeProfile.name);
    expect(screen.queryByTestId("project-default-agent-change")).toBeNull();
    expect(screen.queryByTestId("project-default-agent-clear")).toBeNull();
  });

  it("says 'none yet' when the project names no default", async () => {
    harness([get(project({ my_role: "viewer", default_agent_profile_id: null }))]);

    const none = await screen.findByTestId("project-default-agent-none");
    expect(none.textContent).toBe("none yet");
    expect(screen.queryByTestId("project-default-agent-name")).toBeNull();
  });

  it("gives a maintainer the picker, labelled with the current profile, and a clear", async () => {
    harness([get(project())]);

    const chip = await screen.findByTestId("project-default-agent-change");
    // The chip prints the name from the profile read, so it appears when that
    // read answers.
    await waitFor(() => expect(chip.textContent).toContain(claudeProfile.name));
    expect(screen.getByTestId("project-default-agent-clear").textContent).toContain(
      "use no default",
    );
  });

  it("offers no clear button when there is nothing to clear", async () => {
    harness([get(project({ default_agent_profile_id: null, default_agent_profile_name: null }))]);

    expect(await screen.findByTestId("project-default-agent-change")).toBeTruthy();
    expect(screen.queryByTestId("project-default-agent-clear")).toBeNull();
  });
});

describe("the write", () => {
  it("choosing a profile PATCHes the id with the version and moves the label", async () => {
    const saved = project({
      version: 2,
      default_agent_profile_id: codexProfile.id,
      default_agent_profile_name: codexProfile.name,
    });
    const { requests } = harness([
      get((n: number) => (n > 1 ? saved : project())),
      { path: projectPath, method: "PATCH", body: saved },
    ]);

    fireEvent.click(await screen.findByTestId("project-default-agent-change"));
    fireEvent.click(await screen.findByTestId(`agent-option-${codexProfile.id}`));

    // The label moved with the pick before the answer came back at all.
    expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
      codexProfile.name,
    );
    await waitFor(() => expect(requestsTo(requests, projectPath, "PATCH")).toHaveLength(1));
    expect(JSON.parse(String(requestsTo(requests, projectPath, "PATCH")[0].body))).toEqual({
      default_agent_profile_id: codexProfile.id,
      version: 1,
    });
    await waitFor(() => expect(screen.queryByTestId("project-default-agent-error")).toBeNull());
    expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
      codexProfile.name,
    );
  });

  it("'use no default' PATCHes the explicit null", async () => {
    const cleared = project({
      version: 2,
      default_agent_profile_id: null,
      default_agent_profile_name: null,
    });
    const { requests } = harness([
      get((n: number) => (n > 1 ? cleared : project())),
      { path: projectPath, method: "PATCH", body: cleared },
    ]);

    fireEvent.click(await screen.findByTestId("project-default-agent-clear"));

    await waitFor(() => expect(requestsTo(requests, projectPath, "PATCH")).toHaveLength(1));
    expect(JSON.parse(String(requestsTo(requests, projectPath, "PATCH")[0].body))).toEqual({
      default_agent_profile_id: null,
      version: 1,
    });
    await waitFor(() =>
      expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
        "Choose agent",
      ),
    );
  });

  it("a lost CAS says someone else changed the project, and the label rolls back", async () => {
    const moved = project({ version: 5 });
    const { requests } = harness([
      get((n: number) => (n > 1 ? moved : project())),
      { path: projectPath, method: "PATCH", status: 409 },
    ]);

    fireEvent.click(await screen.findByTestId("project-default-agent-change"));
    fireEvent.click(await screen.findByTestId(`agent-option-${codexProfile.id}`));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Someone else changed this project. Try again.");
    // The rollback is the server's name, not the pick that was refused.
    expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
      claudeProfile.name,
    );
    // And the project is read again: the version in hand is not the one to
    // retry with.
    await waitFor(() => expect(requestsTo(requests, projectPath, "GET").length).toBeGreaterThan(1));
  });

  it("a profile outside the project's organization is named as such, and the label rolls back", async () => {
    harness([
      get(project()),
      {
        path: projectPath,
        method: "PATCH",
        status: 400,
        body: {
          type: "https://communication.dev/errors/invalid-agent-profile",
          title: "Invalid Agent Profile",
          status: 400,
          detail:
            "default_agent_profile_id must name an agent profile of this project's organization, or null to clear the default.",
          code: "invalid_agent_profile",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("project-default-agent-change"));
    fireEvent.click(await screen.findByTestId(`agent-option-${codexProfile.id}`));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That agent profile isn't available in this project.");
    expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
      claudeProfile.name,
    );
  });

  it("an answer that names neither cause still gets one honest sentence", async () => {
    const { requests } = harness([
      get(project()),
      { path: projectPath, method: "PATCH", status: 503 },
    ]);

    fireEvent.click(await screen.findByTestId("project-default-agent-change"));
    fireEvent.click(await screen.findByTestId(`agent-option-${codexProfile.id}`));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The default agent could not be saved.",
    );
    // A refusal that is not a lost CAS refetches nothing.
    expect(requestsTo(requests, projectPath, "GET")).toHaveLength(1);
  });
});

describe("defaultAgentSaveLine", () => {
  it("falls back to one sentence when the server named no cause", () => {
    expect(defaultAgentSaveLine(new Error("boom"))).toBe("The default agent could not be saved.");
  });
});
