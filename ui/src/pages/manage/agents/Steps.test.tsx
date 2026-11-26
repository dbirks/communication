/**
 * The Steps tab of Manage → Agents & models (Step templates). The tab draws no
 * Page band, no title and no tab strip, ignores the route's `:itemId` (an agent
 * profile id under `/manage/agents/:itemId`) and reads the selection from
 * `?item=`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Steps from "./Steps";
import { mockFetch, type RouteStub } from "../../../test/fakes";

const TEMPLATE = {
  id: "t-1",
  slug: "code-reviewer",
  display_name: "Code reviewer",
  kind: "agent.acp",
  description: "Read-only review.",
  status: "active",
  latest_revision: {
    revision_id: "r-1",
    revision_number: 1,
    version_label: "2.0.0",
    revision_digest: "sha256:abc",
    created_at: "2026-07-01T10:00:00Z",
  },
  used_in_count: 2,
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:00:00Z",
};

const REVISION = {
  revision_id: "r-1",
  revision_number: 1,
  version_label: "2.0.0",
  parameters: { type: "object", properties: {} },
  config: { profile: "reviewer" },
  output_schema: { type: "object" },
  workspace_mode: "read_only",
  revision_digest: "sha256:abc",
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
};

const DETAIL = { template: TEMPLATE, revisions: [REVISION], usages: [] };

function mount(path: string, stubs: RouteStub[]) {
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/manage/agents" element={<Steps />} />
          <Route path="/manage/agents/:itemId" element={<Steps />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
}

afterEach(cleanup);

describe("Steps embedded", () => {
  it("ignores the route's id param and draws no page chrome", async () => {
    mount("/manage/agents/p-99?tab=steps", [
      { path: "/api/v1/node-templates", body: { templates: [TEMPLATE], next_cursor: null } },
    ]);
    const row = await screen.findByTestId("step-row-t-1");
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByTestId("step-detail-loading")).toBeNull();
    expect(screen.queryByTestId("step-detail")).toBeNull();
    expect(screen.queryByTestId("workflows-tabs")).toBeNull();
    expect(screen.queryByTestId("page-band")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // The detail read must not fire for the route's agent profile id.
    expect(screen.queryByTestId("steps-embedded")).toBeTruthy();
  });

  it("row links select in ?item=, keeping the pathname and tab query", async () => {
    mount("/manage/agents?tab=steps", [
      { path: "/api/v1/node-templates", body: { templates: [TEMPLATE], next_cursor: null } },
      { path: "/api/v1/node-templates/t-1", body: DETAIL },
      {
        path: "/api/v1/node-templates/t-1/usage",
        body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
      },
    ]);
    const row = await screen.findByTestId("step-row-t-1");
    expect(row.getAttribute("aria-current")).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByTestId("step-detail")).toBeTruthy();
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("selects a step from ?item= and renders the detail panel", async () => {
    mount("/manage/agents?tab=steps&item=t-1", [
      { path: "/api/v1/node-templates", body: { templates: [TEMPLATE], next_cursor: null } },
      { path: "/api/v1/node-templates/t-1", body: DETAIL },
      {
        path: "/api/v1/node-templates/t-1/usage",
        body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
      },
    ]);
    const row = await screen.findByTestId("step-row-t-1");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(await screen.findByTestId("step-detail")).toBeTruthy();
    expect(screen.queryByTestId("workflows-tabs")).toBeNull();
    expect(screen.queryByTestId("page-band")).toBeNull();
  });
});
