/**
 * The board's pure mapping (columns.ts): run status → the five 2d columns,
 * the DONE TODAY clock, the per-step segment bar, and the two secondary
 * groupings. All of it is a function of the wire row, so a fake clock and
 * fake rows pin the whole mapping without a server.
 */
import { describe, expect, it } from "vitest";
import type { CrossProjectRun, CrossProjectRunStep, RunStatus } from "./columns";
import {
  BOARD_COLUMNS,
  columnOf,
  columnRuns,
  currentStep,
  formatAge,
  groupByRepo,
  groupByWorkflow,
  isDoneToday,
  localMidnight,
  progressAriaLabel,
  runTitle,
  shortId,
} from "./columns";

const NOW = new Date(2026, 5, 18, 14, 0, 0); // a fixed Thursday afternoon
const TODAY_EARLY = new Date(2026, 5, 18, 6, 30, 0).toISOString();
const YESTERDAY = new Date(2026, 5, 17, 10, 0, 0).toISOString();

function steps(states: CrossProjectRunStep["state"][]): CrossProjectRunStep[] {
  return states.map((state, index) => ({
    node_id: `step-${index + 1}`,
    kind: "agent.acp",
    state,
  }));
}

function run(overrides: Partial<CrossProjectRun> = {}): CrossProjectRun {
  return {
    id: "b810aaaa-bbbb-cccc-dddd-eeeeeeee0000",
    project_id: "p1",
    pipeline_id: "w1",
    pipeline_revision_id: "r1",
    revision_digest: "digest",
    plan_digest: "digest",
    status: "running",
    depth: 0,
    priority: 0,
    created_at: TODAY_EARLY,
    started_at: null,
    finished_at: null,
    project_name: "Acme",
    pipeline_slug: "feature-delivery",
    pipeline_display_name: "Feature delivery",
    steps: steps(["succeeded", "running", "pending", "pending"]),
    ...overrides,
  };
}

describe("columnOf — the RunStatus machine onto the five columns", () => {
  it("maps every status to exactly one column", () => {
    const expected: Record<RunStatus, string> = {
      queued: "queued",
      preparing: "queued",
      running: "running",
      waiting_human: "needs-you",
      paused: "needs-you",
      failed: "failed",
      interrupted: "failed",
      cancelled: "failed",
      completed: "done",
    };
    for (const [status, column] of Object.entries(expected)) {
      expect(columnOf(status as RunStatus)).toBe(column);
    }
  });

  it("the column set is the 2d five, in order", () => {
    expect(BOARD_COLUMNS.map((column) => column.id)).toEqual([
      "queued",
      "running",
      "needs-you",
      "failed",
      "done",
    ]);
  });
});

describe("DONE TODAY — a clock, not a status", () => {
  it("local midnight is the start of the column's window", () => {
    expect(localMidnight(new Date(2026, 5, 18, 14, 0, 0)).toISOString()).toBe(
      new Date(2026, 5, 18, 0, 0, 0).toISOString(),
    );
  });

  it("a run finished this morning is today's; last afternoon is not", () => {
    expect(isDoneToday(run({ status: "completed", finished_at: TODAY_EARLY }), NOW)).toBe(true);
    expect(isDoneToday(run({ status: "completed", finished_at: YESTERDAY }), NOW)).toBe(false);
  });

  it("a non-completed run is never done-today, however fresh", () => {
    expect(isDoneToday(run({ status: "failed", finished_at: TODAY_EARLY }), NOW)).toBe(false);
  });
});

describe("columnRuns — the five buckets", () => {
  it("buckets every run and drops yesterday's completions", () => {
    const runs = [
      run({ id: "a", status: "queued" }),
      run({ id: "b", status: "preparing" }),
      run({ id: "c", status: "running" }),
      run({ id: "d", status: "waiting_human" }),
      run({ id: "e", status: "failed" }),
      run({ id: "f", status: "completed", finished_at: TODAY_EARLY }),
      run({ id: "g", status: "completed", finished_at: YESTERDAY }),
    ];
    const byState = columnRuns(runs, NOW);
    expect(byState.queued.map((item) => item.id)).toEqual(["a", "b"]);
    expect(byState.running.map((item) => item.id)).toEqual(["c"]);
    expect(byState["needs-you"].map((item) => item.id)).toEqual(["d"]);
    expect(byState.failed.map((item) => item.id)).toEqual(["e"]);
    expect(byState.done.map((item) => item.id)).toEqual(["f"]);
  });
});

describe("the segmented bar", () => {
  it("spells the counts the way the card's aria-label reads", () => {
    expect(
      progressAriaLabel(
        steps(["succeeded", "succeeded", "running", "pending", "pending", "skipped"]),
      ),
    ).toBe("3 of 6 steps done, 1 running");
  });

  it("adds a failed clause only when there is one", () => {
    expect(progressAriaLabel(steps(["succeeded", "failed", "pending"]))).toBe(
      "1 of 3 steps done, 1 failed",
    );
    expect(progressAriaLabel(steps(["succeeded", "succeeded"]))).toBe("2 of 2 steps done");
  });

  it("current step: running first, then waiting, then the next pending", () => {
    expect(currentStep(steps(["succeeded", "running", "pending"]))?.node_id).toBe("step-2");
    expect(currentStep(steps(["succeeded", "waiting", "pending"]))?.node_id).toBe("step-2");
    expect(currentStep(steps(["pending", "pending"]))?.node_id).toBe("step-1");
    expect(currentStep(steps(["succeeded", "succeeded"]))).toBeUndefined();
    expect(currentStep([])).toBeUndefined();
  });
});

describe("identity and age", () => {
  it("short ids are the first four hex chars", () => {
    expect(shortId("b810aaaa-bbbb-cccc-dddd-eeeeeeee0000")).toBe("b810");
  });

  it("the title falls back to the workflow's display name (no run title exists yet)", () => {
    expect(runTitle(run())).toBe("Feature delivery");
    expect(
      runTitle({ ...run(), title: "Export invoices as CSV" } as unknown as CrossProjectRun),
    ).toBe("Export invoices as CSV");
  });

  it("ages read 1m / 2h / 3d", () => {
    expect(formatAge(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("5m");
    expect(formatAge(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW)).toBe("2h");
    expect(formatAge(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW)).toBe("3d");
    expect(formatAge(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe("0m");
  });
});

describe("the secondary groupings", () => {
  it("by repo groups by the run's project, first-seen order", () => {
    const runs = [
      run({ id: "a", project_id: "p1", project_name: "Acme" }),
      run({ id: "b", project_id: "p2", project_name: "Northwind" }),
      run({ id: "c", project_id: "p1", project_name: "Acme" }),
    ];
    const groups = groupByRepo(runs);
    expect(groups.map((group) => [group.key, group.label, group.runs.length])).toEqual([
      ["p1", "Acme", 2],
      ["p2", "Northwind", 1],
    ]);
  });

  it("by workflow groups by the pipeline's human name", () => {
    const runs = [
      run({ id: "a", pipeline_id: "w1", pipeline_display_name: "Feature delivery" }),
      run({ id: "b", pipeline_id: "w2", pipeline_display_name: "Bug fix" }),
      run({ id: "c", pipeline_id: "w1", pipeline_display_name: "Feature delivery" }),
    ];
    const groups = groupByWorkflow(runs);
    expect(groups.map((group) => [group.label, group.runs.length])).toEqual([
      ["Feature delivery", 2],
      ["Bug fix", 1],
    ]);
  });
});

describe("the header bands — AA contrast on the solid state fills", () => {
  it("FAILED is the solid failed token with white text, NEEDS YOU ink on waiting", () => {
    const failed = BOARD_COLUMNS.find((column) => column.id === "failed");
    const waiting = BOARD_COLUMNS.find((column) => column.id === "needs-you");
    expect(failed?.headerClass).toBe("bg-st-failed-strong text-st-failed-strong-fg");
    expect(waiting?.headerClass).toBe("bg-st-waiting-strong text-ink");
  });

  it("no header band (or anything inheriting it) may dilute a token fg with opacity", () => {
    // 80% white over the failed token computes to 4.21:1 — the axe serious
    // found on the board. The band and its count badge must stay full-strength.
    for (const column of BOARD_COLUMNS) {
      expect(column.headerClass).not.toMatch(/opacity/);
    }
  });
});
