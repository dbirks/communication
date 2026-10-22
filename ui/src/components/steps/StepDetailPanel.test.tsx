/**
 * The Steps page's 360px detail panel: the USED IN section reads the step's
 * usage report (`GET /api/v1/node-templates/{templateId}/usage`) — the rows,
 * the honest empty, error and truncation states, and the draft link.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { StepDetailPanel } from "./StepDetailPanel";
import type { NodeTemplateDetail } from "../../api/nodeTemplates";
import { mockFetch, type RouteStub } from "../../test/fakes";

const templateId = "01987a81-2222-7000-8000-abcdef012345";
const workflowId = "01987b20-0000-7000-8000-abcdef012345";
const draftId = "01987b30-0000-7000-8000-abcdef012345";

const revision = {
  revision_id: "01987a82-2222-7000-8000-abcdef012345",
  revision_number: 2,
  version_label: "2.0.0",
  parameters: { type: "object", properties: { profile: { type: "string" } } },
  config: { profile: "reviewer", prompt: "review" },
  output_schema: { type: "object" },
  workspace_mode: "read_only",
  revision_digest: "sha256:abc",
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
} as unknown as NodeTemplateDetail["revisions"][number];

const detail: NodeTemplateDetail = {
  template: {
    id: templateId,
    slug: "code-review",
    display_name: "Code Review",
    kind: "agent.acp",
    description: "Reviews a diff",
    status: "active",
    latest_revision: {
      revision_id: "01987a82-2222-7000-8000-abcdef012345",
      revision_number: 2,
      version_label: "2.0.0",
      revision_digest: "sha256:abc",
      created_at: "2026-07-01T10:00:00Z",
    },
    used_in_count: 1,
    created_by: "u-1",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
  },
  revisions: [revision],
  usages: [],
};

function harness(routes: RouteStub[] = []) {
  const { fetchMock } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StepDetailPanel
          detail={detail}
          loading={false}
          error={null}
          onEdit={() => {}}
          onDuplicate={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock };
}

afterEach(cleanup);

describe("StepDetailPanel — USED IN", () => {
  it("lists the workflows that use the step, with their source and revision", async () => {
    harness([
      {
        path: `/api/v1/node-templates/${templateId}/usage`,
        method: "GET",
        body: {
          workflow_count: 1,
          step_count: 1,
          uses: [
            {
              pipeline_id: workflowId,
              pipeline_name: "Widget review",
              source: "revision",
              revision_number: 2,
              draft_id: null,
              node_id: "implement",
              node_label: "Code Review",
            },
          ],
          truncated: false,
        },
      },
    ]);
    expect(await screen.findByTestId("step-usage")).toBeTruthy();
    expect(await screen.findByText("USED IN 1 WORKFLOW")).toBeTruthy();
    const row = await screen.findByTestId("step-usage-row");
    expect(row.textContent).toContain("Widget review");
    expect(row.textContent).toContain("v2");
    expect(screen.getByTestId(`step-usage-workflow-${workflowId}`).getAttribute("href")).toBe(
      `/workflows/${workflowId}`,
    );
  });

  it("links a draft use to the draft route and marks the row draft", async () => {
    harness([
      {
        path: `/api/v1/node-templates/${templateId}/usage`,
        method: "GET",
        body: {
          workflow_count: 1,
          step_count: 1,
          uses: [
            {
              pipeline_id: workflowId,
              pipeline_name: "Widget review",
              source: "draft",
              revision_number: null,
              draft_id: draftId,
              node_id: "implement",
              node_label: "Code Review",
            },
          ],
          truncated: false,
        },
      },
    ]);
    const row = await screen.findByTestId("step-usage-row");
    expect(row.textContent).toContain("draft");
    expect(row.textContent).not.toContain("v2");
    const workflowLink = screen.getByTestId(
      `step-usage-workflow-${workflowId}`,
    ) as HTMLAnchorElement;
    expect(workflowLink.getAttribute("href")).toBe(`/workflows/${workflowId}/drafts/${draftId}`);
  });

  it("renders the honest empty when no workflow uses the step", async () => {
    harness([
      {
        path: `/api/v1/node-templates/${templateId}/usage`,
        method: "GET",
        body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
      },
    ]);
    expect(await screen.findByTestId("step-detail-unused")).toBeTruthy();
    expect(screen.getByTestId("step-detail-unused").textContent).toContain("not used yet");
  });

  it("renders the muted usage-unavailable copy when the report cannot be read", async () => {
    harness([
      {
        path: `/api/v1/node-templates/${templateId}/usage`,
        method: "GET",
        status: 500,
        body: { title: "Internal Server Error", status: 500, detail: "usage store down" },
      },
    ]);
    expect(await screen.findByTestId("step-usage-error")).toBeTruthy();
    expect(screen.getByTestId("step-usage-error").textContent).toContain("usage unavailable");
  });

  it("says showing first 200 when the report is truncated", async () => {
    harness([
      {
        path: `/api/v1/node-templates/${templateId}/usage`,
        method: "GET",
        body: {
          workflow_count: 2,
          step_count: 2,
          uses: [
            {
              pipeline_id: workflowId,
              pipeline_name: "Widget review",
              source: "revision",
              revision_number: 2,
              draft_id: null,
              node_id: "implement",
              node_label: "Code Review",
            },
          ],
          truncated: true,
        },
      },
    ]);
    expect(await screen.findByTestId("step-usage-truncated")).toBeTruthy();
  });
});
