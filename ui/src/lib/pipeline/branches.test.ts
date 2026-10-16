/**
 * The branch grid's arithmetic: which rows are one branch, what state that
 * branch is in, and what its history strip says. All of it is pure, so all of
 * it is checked here rather than through a render.
 */
import { describe, expect, it } from "vitest";
import { branchCounts, branchPlaceOf, branchesOf, findBranch, sortBranches } from "./branches";
import type { NodeExecutionSummary } from "./contract";

/** Only the fields this projection reads; the rest is the shape's filler. */
function row(
  key: string,
  status: NodeExecutionSummary["status"],
  overrides: Partial<NodeExecutionSummary> = {},
): NodeExecutionSummary {
  const id =
    key
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\[\d+\]$/, "") ?? key;
  return {
    id: `nx_01J8${key.replace(/\W/g, "").toUpperCase()}`,
    run_id: "run_01J8FANOUT",
    node_id: id,
    node_instance_key: key,
    scope_key: key.includes("/") ? `/${key.split("/")[1]}` : "/",
    kind: "pipeline.invoke",
    execution_location: "control_plane",
    status,
    outcome: status === "succeeded" ? "passed" : null,
    error_class: null,
    failed_cause: null,
    attempt_count: status === "pending" ? 0 : 1,
    attempt_limit: 3,
    in_flight: status === "running" ? 1 : 0,
    waiting_reason: null,
    artifact_refs: [],
    ready_at: null,
    finished_at: null,
    ...overrides,
  };
}

/** The fan-out the run view draws: a 25-item `for_each`, three reached. */
function fanOut(): NodeExecutionSummary[] {
  const scope = row("/verify_each", "running", { kind: "for_each", items: 25 });
  const done = [
    row("/verify_each[1]", "succeeded"),
    row("/verify_each[1]/invoke", "succeeded"),
    row("/verify_each[2]", "waiting", { waiting_reason: "approval" }),
    row("/verify_each[2]/invoke", "waiting", { waiting_reason: "approval" }),
    row("/verify_each[3]", "running"),
    row("/verify_each[3]/invoke", "running"),
  ];
  return [scope, ...done];
}

describe("branchPlaceOf", () => {
  it("splits a row into its branch and the path inside it", () => {
    expect(branchPlaceOf("/verify_each[14]/invoke", "/verify_each")).toEqual({
      index: 14,
      rest: "/invoke",
    });
    // The place row is the branch itself, not a step inside it.
    expect(branchPlaceOf("/verify_each[14]", "/verify_each")).toEqual({
      index: 14,
      rest: "",
    });
    // A sibling scope's row, and a plain node, are not branches of this scope.
    expect(branchPlaceOf("/verify_eachX[4]/invoke", "/verify_each")).toBeNull();
    expect(branchPlaceOf("/plan", "/verify_each")).toBeNull();
  });
});

describe("branchesOf", () => {
  it("draws every declared branch, including the ones not reached yet", () => {
    const branches = branchesOf(fanOut(), "/verify_each");
    // 25 cells, not 3: the design's "25 branches · 2 queued" line needs the
    // cells the run has not started to exist and to say `queued`.
    expect(branches).toHaveLength(25);
    expect(branches.map((branch) => branch.index)).toEqual(
      Array.from({ length: 25 }, (_, at) => at + 1),
    );
    expect(branches[24]).toMatchObject({ key: "/verify_each[25]", state: "queued", steps: [] });
    expect(branches[0]?.state).toBe("done");
    // A branch held at a gate is the one a person has to act on.
    expect(branches[1]).toMatchObject({ state: "waiting", stuck: true });
    expect(branches[0]?.stuck).toBe(false);
  });

  it("rolls a branch's state up from its rows, worst first", () => {
    const nodes = [
      row("/each", "running", { kind: "for_each", items: 2 }),
      row("/each[1]/impl", "succeeded"),
      row("/each[1]/checks", "failed", { error_class: "agent_error", failed_cause: "tests_red" }),
      row("/each[1]/review", "running"),
    ];
    const branches = branchesOf(nodes, "/each");
    // A failed step in an otherwise-live branch is the fact that matters.
    expect(branches[0]?.state).toBe("failed");
    expect(branches[0]?.stuck).toBe(true);
    expect(branches[1]?.state).toBe("queued");
  });

  it("orders the history by pass then definition order, and marks a retry", () => {
    const nodes = [
      row("/each", "running", { kind: "for_each", items: 1 }),
      row("/each[1]/build[1]/impl", "succeeded"),
      row("/each[1]/build[1]/checks", "succeeded"),
      row("/each[1]/build[1]/review", "failed", {
        error_class: "invalid_output",
        failed_cause: "missing test",
      }),
      // The until loop's second pass: the same `impl`, retried because review
      // failed. It is one branch's history, never a second branch.
      row("/each[1]/build[2]/impl", "running", { attempt_count: 2 }),
    ];
    const [branch] = branchesOf(nodes, "/each", ["impl", "checks", "review"]);
    expect(branch?.steps.map((step) => step.nodeId)).toEqual(["impl", "checks", "review", "impl"]);
    expect(branch?.steps.map((step) => step.pass)).toEqual([1, 1, 1, 2]);
    // Only the repeat is numbered — `impl` alone would read as a second node.
    expect(branch?.steps.map((step) => step.repeated)).toEqual([false, false, false, true]);
    expect(branch?.steps.map((step) => step.state)).toEqual(["done", "done", "failed", "running"]);
    expect(branch?.steps[2]?.reason).toBe("missing test");
    // A passing step has no reason to explain.
    expect(branch?.steps[0]?.reason).toBeNull();
    expect(branch?.attempts).toBe(2);
    // Without the revision's order the passes still separate; within a pass the
    // key's own order stands, which is why the caller passes the revision.
    const unranked = branchesOf(nodes, "/each")[0];
    expect(unranked?.steps.map((step) => step.pass)).toEqual([1, 1, 1, 2]);
    expect(unranked?.steps[3]?.nodeId).toBe("impl");
  });

  it("shows an attempt-level retry of a single node as one chip", () => {
    // A retried *attempt* is one execution (one row, attempt_count 2), so the
    // strip gets one chip — a second one would invent a pass that never ran.
    const nodes = [
      row("/each", "running", { kind: "for_each", items: 1 }),
      row("/each[1]/impl", "running", { attempt_count: 2 }),
    ];
    const branch = branchesOf(nodes, "/each")[0];
    expect(branch?.steps).toHaveLength(1);
    expect(branch?.steps[0]).toMatchObject({ nodeId: "impl", repeated: false });
    expect(branch?.attempts).toBe(2);
  });
});

describe("sortBranches and the counts header", () => {
  const branches = branchesOf(fanOut(), "/verify_each");

  it("puts stuck branches first, keeping index order inside each group", () => {
    expect(
      sortBranches(branches, "stuck")
        .map((branch) => branch.index)
        .slice(0, 3),
    ).toEqual([2, 1, 3]);
    expect(
      sortBranches(branches, "number")
        .map((branch) => branch.index)
        .slice(0, 3),
    ).toEqual([1, 2, 3]);
  });

  it("counts every state once, so the words match the cells", () => {
    const counts = Object.fromEntries(
      branchCounts(branches).map((entry) => [entry.state, entry.count]),
    );
    expect(counts).toEqual({ running: 1, waiting: 1, done: 1, queued: 22 });
    expect(branchCounts(branches).reduce((sum, entry) => sum + entry.count, 0)).toBe(25);
  });

  it("finds a branch by index and answers null for none", () => {
    expect(findBranch(branches, 3)?.key).toBe("/verify_each[3]");
    expect(findBranch(branches, null)).toBeNull();
    expect(findBranch(branches, 99)).toBeNull();
  });
});
