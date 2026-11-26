/**
 * FactoryHealth: the one sentence, from the brief's arithmetic where the
 * page has it and from the board's rows otherwise; "All quiet." when every
 * count is zero.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FactoryHealth, factoryHealthCounts } from "./FactoryHealth";
import type { CatchUpBriefNumbers } from "../../api/catchup";
import type { CrossProjectRunSummary } from "../../api/home";
import { projectFixture } from "../../test/fakes";

const numbers = (over: Partial<CatchUpBriefNumbers> = {}): CatchUpBriefNumbers => ({
  runs: { succeeded: 5, failed: 0, cancelled: 0, running: 2 },
  approvals: { decided: 3, pending: 1 },
  threads_active: 0,
  prs: 0,
  commits: 0,
  ...over,
});

const row = (overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary => ({
  id: `run-${overrides.status ?? "running"}-${overrides.created_at ?? "a"}`,
  project_id: projectFixture.id,
  pipeline_id: "p",
  pipeline_revision_id: "pr",
  revision_digest: "rev",
  plan_digest: "plan",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-10-14T17:00:00Z",
  project_name: "Project One",
  pipeline_slug: "wf-1",
  pipeline_display_name: "Workflow One",
  steps: [],
  ...overrides,
});

const NOW = new Date("2026-10-14T18:00:00Z");

afterEach(cleanup);

describe("FactoryHealth", () => {
  it("prints the brief's counts (2 running, 1 waiting, 0 failed) as one sentence", () => {
    render(<FactoryHealth runs={[]} numbers={numbers()} now={NOW} />);
    expect(screen.getByTestId("factory-health-sentence").textContent).toBe(
      "2 running, 1 waiting on a person, 0 failed in the last day.",
    );
  });

  it("says All quiet. when every count is zero", () => {
    render(
      <FactoryHealth
        runs={[]}
        numbers={numbers({
          runs: { succeeded: 0, failed: 0, cancelled: 0, running: 0 },
          approvals: { decided: 0, pending: 0 },
        })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("factory-health-sentence").textContent).toBe("All quiet.");
  });

  it("falls back to the board's rows, counting only red runs of the last day", () => {
    expect(
      factoryHealthCounts(
        [
          row(),
          row({ status: "waiting_human" }),
          row({ status: "paused" }),
          row({ status: "failed", finished_at: "2026-10-14T12:00:00Z" }),
          // A week old: outside "the last day".
          row({ status: "failed", finished_at: "2026-10-07T12:00:00Z" }),
          row({ status: "completed" }),
        ],
        null,
        NOW,
      ),
    ).toEqual({ running: 1, waiting: 2, failed: 1 });
  });
});
