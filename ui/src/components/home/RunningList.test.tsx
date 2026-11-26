/**
 * RunningList: the empty sentence, and one running row per run in flight —
 * running-only filter (queued/waiting rows belong to the counts, not here),
 * the workflow name in the running colour, project · step · age, linking to
 * the run's workbench.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RunningList, currentStepLabel } from "./RunningList";
import type { CrossProjectRunSummary } from "../../api/home";
import { projectFixture } from "../../test/fakes";

const runFixture = (overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary => ({
  id: "01987a9a-4444-7000-8000-dddddddddddd",
  project_id: projectFixture.id,
  pipeline_id: "01987a9a-5555-7000-8000-eeeeeeeeeeee",
  pipeline_revision_id: "01987a9a-6666-7000-8000-ffffffffffff",
  revision_digest: "rev-digest",
  plan_digest: "plan-digest",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-10-14T17:42:00Z",
  project_name: "Project One",
  pipeline_slug: "wf-1",
  pipeline_display_name: "Workflow One",
  steps: [
    { node_id: "plan", kind: "agent.acp", state: "succeeded" },
    { node_id: "implement", kind: "agent.acp", state: "running" },
    { node_id: "ship", kind: "command.shell", state: "pending" },
  ],
  ...overrides,
});

afterEach(cleanup);

describe("RunningList", () => {
  it("says nothing is running when no row runs", () => {
    render(
      <MemoryRouter>
        <RunningList
          runs={[
            runFixture({ status: "queued" }),
            runFixture({ status: "waiting_human", id: "r2" }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("running-list-empty").textContent).toBe("Nothing is running.");
  });

  it("draws one row per running run, linking to its workbench", () => {
    render(
      <MemoryRouter>
        <RunningList runs={[runFixture(), runFixture({ status: "queued", id: "r-queued" })]} />
      </MemoryRouter>,
    );
    const row = screen.getByTestId("running-row-01987a9a-4444-7000-8000-dddddddddddd");
    expect(row.getAttribute("href")).toBe("/runs/01987a9a-4444-7000-8000-dddddddddddd");
    expect(row.textContent).toContain("● Workflow One");
    expect(row.textContent).toContain("Project One");
    expect(row.textContent).toContain("implement");
    expect(screen.queryByTestId("running-row-r-queued")).toBeNull();
  });

  it("reads the current step as the first one not done", () => {
    expect(
      currentStepLabel([
        { node_id: "a", kind: "k", state: "succeeded" },
        { node_id: "b", kind: "k", state: "skipped" },
        { node_id: "c", kind: "k", state: "waiting" },
      ]),
    ).toBe("c");
    expect(currentStepLabel([{ node_id: "a", kind: "k", state: "succeeded" }])).toBe("—");
  });
});
