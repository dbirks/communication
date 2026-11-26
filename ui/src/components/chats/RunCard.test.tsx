import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCard, compressRunSegments } from "./RunCard";
import type { NodeExecution, Run } from "../../api/types";

type NodeExecutionStatus = NodeExecution["status"];
import { mockFetch, type RouteStub } from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(index: number, id: string, status: NodeExecutionStatus): NodeExecution {
  return {
    id: `ne-${index}`,
    run_id: "run-1",
    node_id: id,
    kind: "agent.acp",
    node_instance_key: `/${id}`,
    scope_key: "/",
    execution_location: "worker",
    status,
    artifact_refs: [],
    depends_on: [],
    attempt_count: 1,
    attempt_limit: 1,
    in_flight: 0,
    created_at: `2026-10-14T18:0${index}:00Z`,
  };
}

function renderRunCard(run: Run, nodes: NodeExecution[]) {
  const routes: RouteStub[] = [
    { path: `/api/v1/runs/${run.id}`, body: run },
    { path: `/api/v1/runs/${run.id}/nodes`, body: { node_executions: nodes } },
    {
      path: "/api/v1/pipelines",
      body: {
        pipelines: [{ id: run.pipeline_id, slug: "wf-1", display_name: "Workflow One" }],
      },
    },
  ];
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RunCard runId={run.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseRun: Run = {
  id: "01987a7f-1111-7000-8000-abcdef012345",
  project_id: "proj-1",
  pipeline_id: "pipe-1",
  pipeline_revision_id: "rev-1",
  revision_digest: "abc123",
  plan_digest: "def456",
  digest_scope: "v1",
  status: "running",
  priority: 0,
  depth: 0,
  placement: { scheduled: true },
  expression_evaluations: 0,
  created_at: "2026-10-14T18:00:00Z",
};

describe("compressRunSegments", () => {
  it("keeps 3 segments for a 3-step run", () => {
    const nodes = [
      node(1, "plan", "succeeded"),
      node(2, "implement", "running"),
      node(3, "review", "pending"),
    ];
    expect(compressRunSegments(nodes, 5)).toEqual(["done", "running", "todo"]);
  });

  it("compresses an 8-step run proportionally into 5 segments", () => {
    const nodes = [
      node(1, "s1", "succeeded"),
      node(2, "s2", "succeeded"),
      node(3, "s3", "succeeded"),
      node(4, "s4", "succeeded"),
      node(5, "s5", "running"),
      node(6, "s6", "pending"),
      node(7, "s7", "pending"),
      node(8, "s8", "pending"),
    ];
    expect(compressRunSegments(nodes, 5)).toEqual(["done", "done", "done", "running", "todo"]);
  });
});

describe("RunCard", () => {
  it("renders a 3-step running card and links Open in Factory to routes.run(runId)", async () => {
    const nodes = [
      node(1, "plan", "succeeded"),
      node(2, "implement", "running"),
      node(3, "review", "pending"),
    ];
    renderRunCard(baseRun, nodes);

    await screen.findByText("Workflow One");
    expect(screen.getByTestId(`run-card-state-${baseRun.id}`).textContent).toBe("● running");
    expect(screen.getByTestId("run-card-step").textContent).toBe("implement");
    expect(screen.getByTestId("run-card-strip").children).toHaveLength(3);
    expect(screen.getByTestId("run-card-segment-0").getAttribute("data-segment-state")).toBe(
      "done",
    );
    expect(screen.getByTestId("run-card-segment-1").getAttribute("data-segment-state")).toBe(
      "running",
    );
    expect(screen.getByTestId("run-card-segment-2").getAttribute("data-segment-state")).toBe(
      "todo",
    );

    const open = screen.getByTestId("run-card-open");
    expect(open.getAttribute("href")).toBe(`/runs/${baseRun.id}`);
  });

  it("compresses an 8-step run into 5 segments and shows state words for waiting/done/failed/interrupted", async () => {
    const cases: { status: Run["status"]; expected: string }[] = [
      { status: "waiting_human", expected: "! waiting" },
      { status: "completed", expected: "✓ done" },
      { status: "failed", expected: "× failed" },
      { status: "interrupted", expected: "⊘ interrupted" },
    ];
    const eightNodes = Array.from({ length: 8 }, (_, i) =>
      node(i + 1, `step-${i + 1}`, i < 4 ? "succeeded" : i === 4 ? "waiting" : "pending"),
    );

    for (const c of cases) {
      cleanup();
      renderRunCard({ ...baseRun, status: c.status }, eightNodes);
      await screen.findByText("Workflow One");
      expect(screen.getByTestId(`run-card-state-${baseRun.id}`).textContent).toBe(c.expected);
      expect(screen.getByTestId("run-card-strip").children).toHaveLength(5);
    }
  });
});
