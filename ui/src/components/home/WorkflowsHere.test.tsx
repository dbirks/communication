/**
 * WorkflowsHere: the project's assigned workflows, each on one line with the
 * Factory's own plain-English trigger sentence; the empty sentence with its
 * link to the Factory; and the refusal to name a trigger before its reads
 * answer.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { WorkflowsHere } from "./WorkflowsHere";
import { mockFetch, projectFixture, type RouteStub } from "../../test/fakes";
import type { Assignment } from "../../api/types";
import { shortId } from "../../lib/format";

const projectId = projectFixture.id;
const pipelineId = "01987b20-0000-7000-8000-abcdef012345";
/** The person who wrote the schedule/trigger rows — the reads name them. */
const me = "01987a61-2345-7000-8000-abcdef012345";

function assignment(id = "as-1", enabled = true): Assignment {
  return {
    id,
    project_id: projectId,
    pipeline_id: pipelineId,
    pinned_revision_id: "01987b10-0000-7000-8000-000000000001",
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

const library: RouteStub = {
  path: "/api/v1/pipelines",
  body: {
    pipelines: [
      {
        id: pipelineId,
        slug: "wf-1",
        display_name: "Workflow One",
        latest_revision_number: 1,
        revision_count: 1,
        archived: false,
      },
    ],
  },
};

afterEach(cleanup);

describe("WorkflowsHere", () => {
  it("heads the block with a column heading and words its Factory link in the UI font", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [] } },
      { path: `/api/v1/projects/${projectId}/schedules`, body: { schedules: [] } },
      { path: `/api/v1/projects/${projectId}/issue-triggers`, body: { issue_triggers: [] } },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper });

    const head = await screen.findByTestId("workflows-here-label");
    expect(head.tagName).toBe("H3");
    expect(head.textContent).toBe("Workflows here");
    expect(head.className).toContain("text-[15px]");
    expect(head.className).toContain("border-line-soft");
    expect(head.className).not.toContain("font-mono");

    const link = await screen.findByTestId("workflows-here-factory");
    expect((link.textContent ?? "").trim()).toBe("Open the Factory");
    expect(link.className).not.toContain("font-mono");
    expect(link.className).toContain("text-[13px]");
    expect(link.className).toContain("text-accent-text");
    expect(link.className).toContain("hover:underline");
  });

  it("says nothing is assigned and points at the Factory", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [] } },
      { path: `/api/v1/projects/${projectId}/schedules`, body: { schedules: [] } },
      { path: `/api/v1/projects/${projectId}/issue-triggers`, body: { issue_triggers: [] } },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper });

    const empty = await screen.findByText("No workflows here yet.");
    expect(empty.getAttribute("data-testid")).toBe("workflows-here-empty");
    expect(screen.getByTestId("workflows-here-factory").getAttribute("href")).toBe(
      `/p/${projectId}/factory`,
    );
  });

  it("words the trigger the Factory does: an issue label beats a cron beats the manual start", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [assignment()] } },
      {
        path: `/api/v1/projects/${projectId}/schedules`,
        body: {
          schedules: [
            {
              id: "sch-1",
              project_id: projectId,
              assignment_id: "as-1",
              cron_expr: "0 9 * * 1-5",
              inputs: {},
              enabled: true,
              next_run_at: "2026-11-23T09:00:00Z",
              version: 1,
              created_by: me,
              created_at: "2026-11-20T10:00:00Z",
              updated_at: "2026-11-20T10:00:00Z",
            },
          ],
        },
      },
      {
        path: `/api/v1/projects/${projectId}/issue-triggers`,
        body: {
          issue_triggers: [
            {
              id: "it-1",
              project_id: projectId,
              assignment_id: "as-1",
              repository_id: "01987a79-aaaa-7000-8000-abcdef012345",
              event: "labeled",
              labels: ["ready"],
              inputs: {},
              enabled: true,
              version: 1,
              created_by: me,
              created_at: "2026-11-20T10:00:00Z",
              updated_at: "2026-11-20T10:00:00Z",
            },
          ],
        },
      },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper });

    const row = await screen.findByTestId(`workflow-here-${shortId(pipelineId)}`);
    expect(row.querySelector("a")?.textContent).toBe("Workflow One");
    expect(row.querySelector("a")?.getAttribute("href")).toBe(
      `/p/${projectId}/factory/${pipelineId}`,
    );
    expect(row.querySelector("[data-trigger]")?.textContent).toBe("when an issue gets 'ready'");
  });

  it("falls back to the cron, then to the manual start, and says so when the reads fail", async () => {
    const cronOnly = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [assignment()] } },
      {
        path: `/api/v1/projects/${projectId}/schedules`,
        body: {
          schedules: [
            {
              id: "sch-1",
              project_id: projectId,
              assignment_id: "as-1",
              cron_expr: "0 9 * * 1-5",
              inputs: {},
              enabled: true,
              next_run_at: "2026-11-23T09:00:00Z",
              version: 1,
              created_by: me,
              created_at: "2026-11-20T10:00:00Z",
              updated_at: "2026-11-20T10:00:00Z",
            },
          ],
        },
      },
      { path: `/api/v1/projects/${projectId}/issue-triggers`, body: { issue_triggers: [] } },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper: cronOnly.wrapper });
    const row = await screen.findByTestId(`workflow-here-${shortId(pipelineId)}`);
    expect(row.querySelector("[data-trigger]")?.textContent).toBe("every weekday at 09:00 UTC");
    cleanup();

    const manual = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [assignment()] } },
      { path: `/api/v1/projects/${projectId}/schedules`, body: { schedules: [] } },
      { path: `/api/v1/projects/${projectId}/issue-triggers`, body: { issue_triggers: [] } },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper: manual.wrapper });
    expect(
      (await screen.findByTestId(`workflow-here-${shortId(pipelineId)}`)).querySelector(
        "[data-trigger]",
      )?.textContent,
    ).toBe("when you start it");
    cleanup();

    const failed = harness([
      { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [assignment()] } },
      { path: `/api/v1/projects/${projectId}/schedules`, status: 500, body: {} },
      { path: `/api/v1/projects/${projectId}/issue-triggers`, body: { issue_triggers: [] } },
      library,
    ]);
    render(<WorkflowsHere projectId={projectId} />, { wrapper: failed.wrapper });
    expect(
      (await screen.findByTestId(`workflow-here-${shortId(pipelineId)}`)).querySelector(
        "[data-trigger]",
      )?.textContent,
    ).toBe("triggers unavailable");
  });
});
