/**
 * StarterPills against the fake wire: the two resume pills (newest threads
 * first, labelled with their own titles), the run pills for the project's
 * assigned workflows, the always-there New chat pill, and the honest row when
 * the project has neither conversations nor assignments.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { STARTER_PILL_LIMIT, StarterPills } from "./StarterPills";
import {
  conversationSummaryFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import type { Assignment, ConversationSummary, PipelineList } from "../../api/types";
import { shortId } from "../../lib/format";

const projectId = projectFixture.id;

function thread(id: string, title: string, updatedAt: string): ConversationSummary {
  return { ...conversationSummaryFixture, id, title, updated_at: updatedAt };
}

function assignment(pipelineId: string, id: string, enabled = true): Assignment {
  return {
    id,
    project_id: projectId,
    pipeline_id: pipelineId,
    pinned_revision_id: "01987b10-0000-7000-8000-0000000000r1",
    pinned_revision_digest: "sha256:1",
    max_concurrent_runs: 1,
    budget_overrides: {},
    effective_budgets: {},
    enabled,
    pinned_version_label: null,
    repository_id: null,
    repository_name: null,
    version: 1,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-20T10:00:00Z",
  };
}

const pipelineList: PipelineList = {
  pipelines: [
    {
      id: "01987b20-0000-7000-8000-abcdef012345",
      slug: "wf-1",
      display_name: "Workflow One",
      latest_revision_number: 1,
      revision_count: 1,
      archived: false,
    },
  ],
};

function harness(routes: RouteStub[]) {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { wrapper };
}

afterEach(cleanup);

describe("StarterPills", () => {
  it("shows only the New chat pill when the project has nothing to start from", () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/conversations`, body: { items: [] } },
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [] } },
      { path: "/api/v1/pipelines", body: { pipelines: [] } },
    ]);
    render(<StarterPills projectId={projectId} />, { wrapper });

    expect(screen.getByTestId("starter-pills")).toBeTruthy();
    expect(screen.getByTestId("starter-pill-chat").getAttribute("href")).toBe(
      `/p/${projectId}/chats/new`,
    );
    expect(screen.queryAllByTestId(/^starter-pill-resume-/).length).toBe(0);
    expect(screen.queryAllByTestId(/^starter-pill-run-/).length).toBe(0);
  });

  it("caps each kind, orders the resume pills by the newest thread, and links each one", async () => {
    const { wrapper } = harness([
      {
        path: `/api/v1/projects/${projectId}/conversations`,
        body: {
          items: [
            thread("01987b30-0000-7000-8000-0000000000a1", "Older story", "2026-11-01T10:00:00Z"),
            thread("01987b30-0000-7000-8000-0000000000a2", "Newest story", "2026-11-09T10:00:00Z"),
            thread("01987b30-0000-7000-8000-0000000000a3", "Middle story", "2026-11-05T10:00:00Z"),
          ],
        },
      },
      {
        path: `/api/v1/projects/${projectId}/assignments`,
        body: {
          assignments: [
            assignment("01987b20-0000-7000-8000-abcdef012345", "as-1"),
            assignment("01987b20-0000-7000-8000-abcdef012399", "as-2"),
            assignment("01987b20-0000-7000-8000-abcdef012398", "as-3", false),
          ],
        },
      },
      { path: "/api/v1/pipelines", body: pipelineList },
    ]);
    render(<StarterPills projectId={projectId} />, { wrapper });

    await screen.findByText("Newest story");
    const pills = screen.getAllByTestId(/^starter-pill-(resume|run)-/);
    expect(pills.length).toBe(STARTER_PILL_LIMIT * 2);
    // Newest first, and the third thread never appears.
    expect(pills[0].textContent).toContain("Newest story");
    expect(pills[1].textContent).toContain("Middle story");
    expect(screen.queryByText("Older story")).toBeNull();
    expect(pills[0].getAttribute("href")).toBe(
      `/p/${projectId}/chats/01987b30-0000-7000-8000-0000000000a2`,
    );
    // A disabled assignment is not a workflow this project runs.
    expect(screen.queryByText("Run workflow as-3")).toBeNull();
    // The library names the pinned workflow; the pill says what it runs.
    expect(pills[2].textContent).toBe("Run Workflow One");
    expect(pills[2].getAttribute("href")).toBe(
      `/p/${projectId}/factory/01987b20-0000-7000-8000-abcdef012345`,
    );
  });

  it("labels a pin the library no longer names by its short id, never an invented name", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/conversations`, body: { items: [] } },
      {
        path: `/api/v1/projects/${projectId}/assignments`,
        body: { assignments: [assignment("01987b20-0000-7000-8000-abcdef999999", "as-9")] },
      },
      { path: "/api/v1/pipelines", body: { pipelines: [] } },
    ]);
    render(<StarterPills projectId={projectId} />, { wrapper });

    const pill = await screen.findByTestId(
      `starter-pill-run-${shortId("01987b20-0000-7000-8000-abcdef999999")}`,
    );
    expect(pill.textContent).toBe(
      `Run workflow ${shortId("01987b20-0000-7000-8000-abcdef999999")}`,
    );
  });
});
