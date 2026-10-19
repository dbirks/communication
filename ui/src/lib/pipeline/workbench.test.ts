/**
 * `workbench.ts`: definition-topology overlays, scope selectors, auto-select
 * and URL state — fixtures shaped on the probe pipeline (plan, approve,
 * build_until_verified{implement, test, review}, verdict, emit_items,
 * fan_out{child}).
 */
import { describe, expect, it } from "vitest";
import type { NodeExecutionSummary, RunTreeChild, RunTreeRoot } from "./contract";
import {
  attentionNode,
  childRunOf,
  definitionIdOfKey,
  instancesOfNode,
  overlays,
  parseWorkbenchUrl,
  scopeInstances,
  workbenchSearch,
  type WorkbenchUrlState,
} from "./workbench";

/** One node execution row; the fields a workbench never reads default away. */
function row(fields: {
  id: string;
  node_id: string;
  node_instance_key: string;
  kind?: string;
  status: NodeExecutionSummary["status"];
  waiting_reason?: NodeExecutionSummary["waiting_reason"];
  attempt_count?: number;
  attempt_limit?: number;
  iterations?: number | null;
  items?: number | null;
  finished_at?: string | null;
}): NodeExecutionSummary {
  return {
    id: fields.id,
    run_id: "run-1",
    node_id: fields.node_id,
    node_instance_key: fields.node_instance_key,
    scope_key: "/",
    kind: fields.kind ?? "agent.acp",
    execution_location: "worker",
    status: fields.status,
    outcome: null,
    error_class: null,
    failed_cause: null,
    attempt_count: fields.attempt_count ?? 1,
    attempt_limit: fields.attempt_limit ?? 3,
    in_flight: 0,
    waiting_reason: fields.waiting_reason ?? null,
    artifact_refs: [],
    iterations: fields.iterations,
    items: fields.items,
    ready_at: null,
    finished_at: fields.finished_at ?? null,
  };
}

/**
 * The probe pipeline mid-run: review failed in until iteration 1, iteration 2
 * is running implement on attempt 2; fan_out has 25 items (22 done, 2 running,
 * 1 failed); verdict has not started.
 */
function probeRun(): NodeExecutionSummary[] {
  const rows: NodeExecutionSummary[] = [
    row({
      id: "ne-plan",
      node_id: "plan",
      node_instance_key: "/plan",
      status: "succeeded",
      finished_at: "2026-01-01T09:00:00Z",
    }),
    row({
      id: "ne-approve",
      node_id: "approve",
      node_instance_key: "/approve",
      kind: "human.approval",
      status: "waiting",
      waiting_reason: "approval",
    }),
    row({
      id: "ne-buv",
      node_id: "build_until_verified",
      node_instance_key: "/build_until_verified",
      kind: "until",
      status: "running",
      iterations: 2,
    }),
    row({
      id: "ne-buv-1",
      node_id: "build_until_verified",
      node_instance_key: "/build_until_verified[1]",
      kind: "until",
      status: "failed",
      finished_at: "2026-01-01T10:00:00Z",
    }),
    row({
      id: "ne-buv-2",
      node_id: "build_until_verified",
      node_instance_key: "/build_until_verified[2]",
      kind: "until",
      status: "running",
    }),
    row({
      id: "ne-impl-1",
      node_id: "implement",
      node_instance_key: "/build_until_verified[1]/implement",
      status: "succeeded",
      finished_at: "2026-01-01T09:10:00Z",
    }),
    row({
      id: "ne-test-1",
      node_id: "test",
      node_instance_key: "/build_until_verified[1]/test",
      status: "succeeded",
      finished_at: "2026-01-01T09:20:00Z",
    }),
    row({
      id: "ne-review-1",
      node_id: "review",
      node_instance_key: "/build_until_verified[1]/review",
      status: "failed",
      attempt_count: 2,
      finished_at: "2026-01-01T09:30:00Z",
    }),
    row({
      id: "ne-impl-2",
      node_id: "implement",
      node_instance_key: "/build_until_verified[2]/implement",
      status: "running",
      attempt_count: 2,
    }),
    row({
      id: "ne-verdict",
      node_id: "verdict",
      node_instance_key: "/verdict",
      kind: "model.chat",
      status: "pending",
    }),
    row({
      id: "ne-emit",
      node_id: "emit_items",
      node_instance_key: "/emit_items",
      kind: "process.exec",
      status: "succeeded",
      finished_at: "2026-01-01T11:00:00Z",
    }),
    row({
      id: "ne-fan",
      node_id: "fan_out",
      node_instance_key: "/fan_out",
      kind: "for_each",
      status: "running",
      items: 25,
    }),
  ];
  for (let i = 1; i <= 25; i += 1) {
    const status = i === 25 ? "failed" : i >= 23 ? "running" : "succeeded"; // 22 ✓ 2 ● 1 ✗
    rows.push(
      row({
        id: `ne-child-${i}`,
        node_id: "child",
        node_instance_key: `/fan_out[${i}]/child`,
        status,
        finished_at: `2026-01-01T12:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
  }
  return rows;
}

describe("definitionIdOfKey", () => {
  it("takes the last path segment without its loop suffix", () => {
    expect(definitionIdOfKey("/plan")).toBe("plan");
    expect(definitionIdOfKey("/fan_out[14]")).toBe("fan_out");
    expect(definitionIdOfKey("/build_until_verified[2]/implement")).toBe("implement");
    expect(definitionIdOfKey("/build_until_verified[2]/fan_out[3]/child")).toBe("child");
  });
});

describe("overlays", () => {
  it("shows the newest until iteration by default (iteration 2 of 2)", () => {
    const out = overlays(probeRun(), {});
    expect(out.build_until_verified).toEqual({
      state: "running",
      label: "iteration 2 of 2",
      executionId: "ne-buv-2",
    });
  });

  it("resolves body nodes to the selected iteration", () => {
    const out = overlays(probeRun(), { "/build_until_verified": 1 });
    expect(out.implement).toEqual({ state: "done", label: "succeeded", executionId: "ne-impl-1" });
    expect(out.test).toEqual({ state: "done", label: "succeeded", executionId: "ne-test-1" });
  });

  it("labels a retrying body node with its attempt count", () => {
    const out = overlays(probeRun(), {});
    expect(out.implement).toEqual({
      state: "running",
      label: "attempt 2 of 3 · running",
      executionId: "ne-impl-2",
    });
    const iterationOne = overlays(probeRun(), { "/build_until_verified": 1 });
    expect(iterationOne.review).toEqual({
      state: "failed",
      label: "attempt 2 of 3 · failed",
      executionId: "ne-review-1",
    });
  });

  it("shows a body node that has not run in the selected iteration as not started", () => {
    const out = overlays(probeRun(), {});
    expect(out.review).toEqual({ state: "queued", label: "not started", executionId: null });
  });

  it("shows a pending node as queued / not started", () => {
    const out = overlays(probeRun(), {});
    expect(out.verdict).toEqual({
      state: "queued",
      label: "not started",
      executionId: "ne-verdict",
    });
  });

  it("aggregates a for_each without a selected item: counts by state, worst state", () => {
    const out = overlays(probeRun(), {});
    expect(out.child).toEqual({
      state: "failed",
      label: "25 items: 1 × failed · 2 ● running · 22 ✓ done",
      executionId: null,
    });
  });

  it("resolves a for_each item selection to that item's execution", () => {
    const out = overlays(probeRun(), { "/fan_out": 14 });
    expect(out.child).toEqual({ state: "done", label: "succeeded", executionId: "ne-child-14" });
    expect(out.fan_out).toEqual({
      state: "done",
      label: "item 14 of 25",
      executionId: "ne-child-14",
    });
  });

  it("shows the for_each scope box as N items when no item is selected", () => {
    const out = overlays(probeRun(), {});
    expect(out.fan_out).toEqual({ state: "failed", label: "25 items", executionId: "ne-fan" });
  });

  it("labels the approval wait specifically", () => {
    const out = overlays(probeRun(), {});
    expect(out.approve).toEqual({
      state: "waiting",
      label: "waiting for approval",
      executionId: "ne-approve",
    });
  });

  it("keys nested scope selections by the scope's definition key", () => {
    const nested: NodeExecutionSummary[] = [
      row({
        id: "n-loop",
        node_id: "loop",
        node_instance_key: "/loop",
        kind: "until",
        status: "running",
        iterations: 2,
      }),
      row({
        id: "n-loop-1",
        node_id: "loop",
        node_instance_key: "/loop[1]",
        kind: "until",
        status: "succeeded",
        finished_at: "2026-01-01T09:00:00Z",
      }),
      row({
        id: "n-loop-2",
        node_id: "loop",
        node_instance_key: "/loop[2]",
        kind: "until",
        status: "running",
      }),
      row({
        id: "n-fan-1",
        node_id: "fan",
        node_instance_key: "/loop[1]/fan",
        kind: "for_each",
        status: "succeeded",
        items: 2,
      }),
      row({
        id: "n-fan-2",
        node_id: "fan",
        node_instance_key: "/loop[2]/fan",
        kind: "for_each",
        status: "running",
        items: 2,
      }),
      row({
        id: "n-job-1a",
        node_id: "job",
        node_instance_key: "/loop[1]/fan[1]/job",
        status: "succeeded",
        finished_at: "2026-01-01T09:01:00Z",
      }),
      row({
        id: "n-job-1b",
        node_id: "job",
        node_instance_key: "/loop[1]/fan[2]/job",
        status: "succeeded",
        finished_at: "2026-01-01T09:02:00Z",
      }),
      row({
        id: "n-job-2a",
        node_id: "job",
        node_instance_key: "/loop[2]/fan[1]/job",
        status: "succeeded",
        finished_at: "2026-01-01T10:01:00Z",
      }),
      row({
        id: "n-job-2b",
        node_id: "job",
        node_instance_key: "/loop[2]/fan[2]/job",
        status: "running",
      }),
    ];
    // Default: latest until iteration (2), inner for_each unselected → aggregate.
    const def = overlays(nested, {});
    expect(def.job).toEqual({
      state: "running",
      label: "2 items: 1 ● running · 1 ✓ done",
      executionId: null,
    });
    // Selecting the nested for_each item resolves within the default iteration 2.
    const item = overlays(nested, { "/loop/fan": 1 });
    expect(item.job).toEqual({ state: "done", label: "succeeded", executionId: "n-job-2a" });
    // Selecting both scopes walks to iteration 1, item 2.
    const both = overlays(nested, { "/loop": 1, "/loop/fan": 2 });
    expect(both.job).toEqual({ state: "done", label: "succeeded", executionId: "n-job-1b" });
    expect(both.fan).toEqual({ state: "done", label: "item 2 of 2", executionId: "n-job-1b" });
  });
});

describe("scopeInstances", () => {
  it("lists until iterations with per-iteration state, sorted by index", () => {
    const out = scopeInstances(probeRun(), "/build_until_verified");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      index: 1,
      key: "/build_until_verified[1]",
      state: "failed",
      label: "iteration 1 of 2",
    });
    expect(out[1]).toEqual({
      index: 2,
      key: "/build_until_verified[2]",
      state: "running",
      label: "iteration 2 of 2",
    });
  });

  it("lists for_each items via the branch roll-up, worst states first", () => {
    const out = scopeInstances(probeRun(), "/fan_out");
    expect(out).toHaveLength(25);
    expect(out[0]).toMatchObject({
      index: 1,
      key: "/fan_out[1]",
      state: "done",
      label: "item 1 of 25",
    });
    expect(out[22]).toMatchObject({ index: 23, state: "running" });
    expect(out[24]).toMatchObject({ index: 25, state: "failed", label: "item 25 of 25" });
  });
});

describe("instancesOfNode", () => {
  it("returns every execution of a definition node, newest first", () => {
    const out = instancesOfNode(probeRun(), "child");
    expect(out).toHaveLength(25);
    expect(out[0]?.id).toBe("ne-child-25");
    expect(out[1]?.id).toBe("ne-child-24");
    expect(out[24]?.id).toBe("ne-child-1");
  });

  it("orders iterations newest first and returns empty for unknown nodes", () => {
    const out = instancesOfNode(probeRun(), "implement");
    expect(out.map((row) => row.id)).toEqual(["ne-impl-2", "ne-impl-1"]);
    expect(instancesOfNode(probeRun(), "nope")).toEqual([]);
  });
});

describe("attentionNode", () => {
  it("prefers the approval wait over failures and running work", () => {
    expect(attentionNode(probeRun())).toEqual({
      definitionNodeId: "approve",
      executionId: "ne-approve",
      selection: {},
    });
  });

  it("falls back to the failed node and returns the selection that shows it", () => {
    const withoutGate = probeRun().filter((row) => row.id !== "ne-approve");
    expect(attentionNode(withoutGate)).toEqual({
      definitionNodeId: "review",
      executionId: "ne-review-1",
      selection: { "/build_until_verified": 1 },
    });
  });

  it("falls back to running work (skipping scope rows) and to null when idle", () => {
    const runningOnly = probeRun().filter((row) => row.id === "ne-impl-2" || row.id === "ne-buv-2");
    expect(attentionNode(runningOnly)).toEqual({
      definitionNodeId: "implement",
      executionId: "ne-impl-2",
      selection: { "/build_until_verified": 2 },
    });
    const doneOnly = probeRun().filter((row) => row.id === "ne-plan");
    expect(attentionNode(doneOnly)).toBeNull();
  });

  it("prefers interrupted over running", () => {
    const rows: NodeExecutionSummary[] = [
      row({ id: "a", node_id: "a", node_instance_key: "/a", status: "running" }),
      row({ id: "b", node_id: "b", node_instance_key: "/b", status: "interrupted" }),
    ];
    expect(attentionNode(rows)).toEqual({ definitionNodeId: "b", executionId: "b", selection: {} });
  });
});

describe("workbench URL state", () => {
  it("parses every parameter including scoped selections", () => {
    const search = new URLSearchParams(
      "node=implement&instance=ne-impl-2&attempt=2&view=timeline&scope=/build_until_verified:2,/fan_out:14",
    );
    expect(parseWorkbenchUrl(search)).toEqual({
      node: "implement",
      instance: "ne-impl-2",
      attempt: 2,
      view: "timeline",
      scopes: { "/build_until_verified": 2, "/fan_out": 14 },
    });
  });

  it("defaults missing parameters (view=graph, no node/instance/attempt, no scopes)", () => {
    expect(parseWorkbenchUrl(new URLSearchParams())).toEqual({
      node: null,
      instance: null,
      attempt: null,
      view: "graph",
      scopes: {},
    });
  });

  it("serializes and omits defaults, and round-trips through parse", () => {
    const state: WorkbenchUrlState = {
      node: "child",
      instance: "ne-child-14",
      attempt: null,
      view: "tree",
      scopes: { "/fan_out": 14 },
    };
    expect(workbenchSearch(state)).toBe(
      "node=child&instance=ne-child-14&view=tree&scope=%2Ffan_out:14",
    );
    expect(
      workbenchSearch({ node: null, instance: null, attempt: null, view: "graph", scopes: {} }),
    ).toBe("");
    expect(parseWorkbenchUrl(new URLSearchParams(workbenchSearch(state)))).toEqual(state);
  });
});

describe("childRunOf", () => {
  const child = (key: string | null, runId: string, children: RunTreeChild[] = []) => ({
    node_instance_key: key,
    child_run_id: runId,
    pipeline_slug: "issue-implementation",
    revision_digest: "sha256:ab",
    depth: 1,
    wait_policy: "completion" as const,
    status: "running" as const,
    created_at: "2026-01-01T12:00:00Z",
    started_at: null,
    finished_at: null,
    children,
  });

  it("finds the tree row keyed by the invocation's own instance key", () => {
    const tree: RunTreeRoot = {
      run_id: "run-1",
      status: "running",
      depth: 0,
      children: [child("/fan_out[1]/invoke", "child-1"), child("/fan_out[13]/invoke", "child-13")],
    };
    expect(childRunOf(tree, "/fan_out[13]/invoke")?.child_run_id).toBe("child-13");
    expect(childRunOf(tree, "/fan_out[1]/invoke")?.child_run_id).toBe("child-1");
  });

  it("returns null for a key the tree does not carry and for a null tree", () => {
    const tree: RunTreeRoot = {
      run_id: "run-1",
      status: "running",
      depth: 0,
      children: [child("/fan_out[1]/invoke", "child-1")],
    };
    expect(childRunOf(tree, "/fan_out[2]/invoke")).toBeNull();
    expect(childRunOf(null, "/fan_out[1]/invoke")).toBeNull();
  });

  it("walks nested levels for a grandchild invocation", () => {
    const tree: RunTreeRoot = {
      run_id: "run-1",
      status: "running",
      depth: 0,
      children: [
        child("/fan_out[1]/invoke", "child-1", [child("/loop[1]/invoke", "grandchild-1")]),
      ],
    };
    expect(childRunOf(tree, "/loop[1]/invoke")?.child_run_id).toBe("grandchild-1");
  });
});
