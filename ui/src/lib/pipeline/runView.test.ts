import { describe, expect, it } from "vitest";
import { definitionKeyOf, iterationOf, rollupStatuses } from "./runView";
import type { NodeExecutionSummary } from "./contract";
import { featureNodes } from "../../test/fixtures/m4/runs";

/** Only the fields this projection reads; the rest is the shape's filler. */
function row(
  key: string,
  status: NodeExecutionSummary["status"],
  overrides: Partial<NodeExecutionSummary> = {},
): NodeExecutionSummary {
  const id = key.split("/").filter(Boolean).pop() ?? key;
  return {
    id: `nx_01J8${id.toUpperCase()}`,
    run_id: "run_01J8FEAT",
    node_id: id,
    node_instance_key: key,
    scope_key: key.includes("/") ? `/${key.split("/")[1]}` : "/",
    kind: "agent.acp",
    execution_location: "worker",
    status,
    outcome: status === "succeeded" ? "passed" : null,
    error_class: null,
    failed_cause: null,
    attempt_count: 1,
    attempt_limit: 3,
    in_flight: 0,
    waiting_reason: null,
    artifact_refs: [],
    ready_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("definitionKeyOf", () => {
  it("strips the loop suffix from every segment of the key", () => {
    // The leading `/` stays: this is the same string the API sends, minus the
    // suffix, so it joins the graph's node keys without a translation layer.
    expect(definitionKeyOf("/build_until_verified[2]/review")).toBe("/build_until_verified/review");
    expect(definitionKeyOf("/plan")).toBe("/plan");
    expect(definitionKeyOf("/fan[3]/invoke/child/invoke")).toBe("/fan/invoke/child/invoke");
  });
});

describe("iterationOf", () => {
  it("reads the iteration off the segment carrying it", () => {
    expect(iterationOf("/build_until_verified[2]/review")).toBe(2);
    expect(iterationOf("/verify_each[11]/invoke")).toBe(11);
    expect(iterationOf("/build_until_verified/review")).toBeNull();
    expect(iterationOf("/plan")).toBeNull();
  });
});

describe("rollupStatuses", () => {
  it("answers once per definition node, at the worst state its rows reached", () => {
    // The loop's instances are one graph node, so the keys never carry `[n]`.
    expect(Object.keys(rollupStatuses(featureNodes)).every((key) => !/\[\d+\]/.test(key))).toBe(
      true,
    );
    expect(
      rollupStatuses([row("/scope[1]/body", "succeeded"), row("/scope[2]/body", "failed")]),
    ).toEqual({ "/scope/body": "failed" });
    // Order is a priority, not the row order.
    expect(
      rollupStatuses([row("/scope[2]/body", "failed"), row("/scope[1]/body", "succeeded")]),
    ).toEqual({ "/scope/body": "failed" });
  });

  it("keeps waiting and pending distinct, because they are different facts", () => {
    expect(rollupStatuses([row("/gate", "waiting"), row("/later", "pending")])).toEqual({
      "/gate": "waiting",
      "/later": "pending",
    });
  });

  it("marks the nodes the run fixture actually has, and no others", () => {
    const statuses = rollupStatuses(featureNodes);
    expect(statuses["/plan"]).toBe("succeeded");
    expect(statuses["/build_until_verified/implement"]).toBe("succeeded");
    // The gate is behind this run, and the verdict behind the gate has not been
    // reached: `pending`, which the graph must show as its own state.
    expect(statuses["/approve"]).toBe("succeeded");
    expect(statuses["/verdict"]).toBe("pending");
    // A node that never got an instance row is absent, not skipped: the graph
    // must not claim a state the server never reported.
    expect(statuses["/publish_verified"] ?? "absent").toBeDefined();
  });

  it("says nothing about a run with no rows", () => {
    expect(rollupStatuses([])).toEqual({});
  });
});
