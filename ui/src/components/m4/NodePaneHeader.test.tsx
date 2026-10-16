/**
 * The right pane's crumb header: `implement · task 14 · attempt 2`, only from
 * what the node rows carry — the instance key's `[n]`, the scope row's kind,
 * and the attempt the pane shows. No invented titles.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NodePaneHeader, placeCrumbOf } from "./NodePaneHeader";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";

function row(overrides: Partial<NodeExecutionSummary>): NodeExecutionSummary {
  return {
    id: `nx_${overrides.node_instance_key ?? "x"}`.replace(/\W/g, ""),
    run_id: "run_pane_header",
    node_id: "implement",
    node_instance_key: "/implement",
    scope_key: "/",
    kind: "agent.acp",
    execution_location: "worker",
    status: "running",
    outcome: null,
    error_class: null,
    failed_cause: null,
    attempt_count: 1,
    attempt_limit: 2,
    in_flight: 1,
    waiting_reason: null,
    artifact_refs: [],
    ready_at: null,
    finished_at: null,
    ...overrides,
  };
}

const fanOut: NodeExecutionSummary[] = [
  row({
    node_id: "verify_each",
    kind: "for_each",
    node_instance_key: "/verify_each",
    status: "running",
  }),
  row({
    node_id: "check_module",
    node_instance_key: "/verify_each[14]/check_module",
    scope_key: "/verify_each[14]",
    status: "running",
  }),
];
const loop: NodeExecutionSummary[] = [
  row({
    node_id: "build_until_verified",
    kind: "until",
    node_instance_key: "/build_until_verified",
  }),
  row({
    node_id: "implement",
    node_instance_key: "/build_until_verified[2]/implement",
    scope_key: "/build_until_verified[2]",
  }),
];

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

describe("placeCrumbOf", () => {
  it("names a for_each item task, an until pass iter, and an unknown scope branch", () => {
    expect(placeCrumbOf("/verify_each[14]/check_module", fanOut)).toBe("task 14");
    expect(placeCrumbOf("/build_until_verified[2]/implement", loop)).toBe("iter 2");
    expect(placeCrumbOf("/mystery[3]/leaf", [])).toBe("branch 3");
  });

  it("takes the innermost place of a nested path and nothing outside any scope", () => {
    const nested = [
      ...fanOut,
      row({
        node_id: "build_until_verified",
        kind: "until",
        node_instance_key: "/verify_each[1]/build_until_verified",
      }),
      row({
        node_id: "review",
        node_instance_key: "/verify_each[1]/build_until_verified[2]/review",
        scope_key: "/verify_each[1]/build_until_verified[2]",
      }),
    ];
    expect(placeCrumbOf("/verify_each[1]/build_until_verified[2]/review", nested)).toBe("iter 2");
    expect(placeCrumbOf("/plan", [])).toBeNull();
  });
});

describe("NodePaneHeader", () => {
  it("draws the 4a crumb: node · place · attempt", () => {
    render(<NodePaneHeader node={fanOut[1]} nodes={fanOut} attemptNumber={2} />);
    expect(screen.getByTestId("node-pane-crumb").textContent).toBe(
      "check_module \u00b7 task 14 \u00b7 attempt 2",
    );
    // The identity line carries the run's own name for the place — the wire
    // serves no human title, so none is invented.
    expect(screen.getByTestId("node-pane-key").textContent).toBe("/verify_each[14]/check_module");
    expect(screen.getByTestId("node-pane-status").textContent).toContain("running");
  });

  it("says only the node for a placeless row with no attempt yet", () => {
    render(
      <NodePaneHeader
        node={row({ node_id: "plan", node_instance_key: "/plan", attempt_count: 0 })}
        attemptNumber={null}
      />,
    );
    expect(screen.getByTestId("node-pane-crumb").textContent).toBe("plan");
    expect(screen.getByTestId("node-pane-crumb").textContent).not.toContain("attempt");
  });
});
