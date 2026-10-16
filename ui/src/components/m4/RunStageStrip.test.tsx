/**
 * The stage strip is honest about a loop: one cell per definition node, counts
 * in words, and one segment per execution — never a duplicated stage.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunStageStrip, stageCells } from "./RunStageStrip";
import { fanOutNodes, featureNodes, interruptedNodes } from "../../test/fixtures/m4/runs";
import type { NodeExecutionStatus, NodeExecutionSummary } from "../../lib/pipeline/contract";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

describe("stageCells", () => {
  it("collapses a loop's iterations into one cell", () => {
    const cells = stageCells(featureNodes);
    const byId = Object.fromEntries(cells.map((cell) => [cell.nodeId, cell]));
    expect(Object.keys(byId)).toEqual([
      "plan",
      "approve",
      "build_until_verified",
      "implement",
      "test",
      "review",
      "verdict",
      "publish_verified",
      "publish_needs_attention",
    ]);
    // `implement` ran in both iterations and finished in both: two segments,
    // both done. The interruption it survived is an attempt-level fact and lives
    // in the attempt panel, not in a stage cell that would claim the node is stuck.
    expect(byId.implement.instances).toHaveLength(2);
    expect(byId.implement.counts).toEqual([{ state: "done", word: "done", count: 2 }]);
    expect(byId.implement.state).toBe("done");
    // The gate is behind this run: § 9.3 puts it before the loop.
    expect(byId.approve.state).toBe("done");
    // The loop's cell counts its two *iterations*, rolled up from the nodes
    // inside each one: pass 1 finished, pass 2 is mid-flight.
    expect(byId.build_until_verified.instances).toHaveLength(2);
    expect(byId.build_until_verified.counts.map((c) => `${c.count} ${c.word}`).join(" ")).toBe(
      "1 running 1 done",
    );
    // Never reached is `pending` — not `skipped`, which would claim someone
    // decided to skip it, and not `blocked`, a state the API does not send.
    expect(byId.publish_verified.state).toBe("queued");
    expect(byId.publish_verified.counts[0].word).toBe("pending");
  });

  it("follows the definition's order, not the order the API listed the rows in", () => {
    // The real route answers `?sort=node_instance_key`, which reads
    // alphabetically: the loop before the node that leads to it.
    asApiListsIt(featureNodes);
    const alphabetical = stageCells(asApiListsIt(featureNodes)).map((cell) => cell.nodeId);
    expect(alphabetical.slice(0, 3)).toEqual(["approve", "build_until_verified", "implement"]);
    // Given the pinned revision's node order, the strip reads left-to-right like
    // the graph it belongs to.
    const order = [
      "plan",
      "approve",
      "build_until_verified",
      "implement",
      "test",
      "review",
      "verdict",
      "publish_verified",
      "publish_needs_attention",
    ];
    expect(stageCells(asApiListsIt(featureNodes), order).map((cell) => cell.nodeId)).toEqual(order);
  });

  it("calls a node interrupted only when its execution actually is", () => {
    const byId = Object.fromEntries(
      stageCells(interruptedNodes).map((cell) => [cell.nodeId, cell]),
    );
    expect(byId.implement.counts).toEqual([
      { state: "interrupted", word: "stopped", count: 1 },
      { state: "done", word: "done", count: 1 },
    ]);
    expect(byId.implement.state).toBe("interrupted");
  });

  it("abbreviates a state where the tree spells it out, without changing it", async () => {
    // Both come from the one mapping table in `ds/states.ts`: a stage cell shows
    // the short word, the tree row shows the sentence form of the *same* state.
    // Neither may invent a third reading — that is identity rule 06, and the one
    // place a person can check a colour against a word.
    const { RunTree } = await import("./RunTree");
    const cell = stageCells(interruptedNodes).find((entry) => entry.nodeId === "implement")!;
    expect(cell.state).toBe("interrupted");
    expect(cell.counts.find((entry) => entry.state === "interrupted")?.word).toBe("stopped");
    render(
      <RunTree
        nodes={interruptedNodes}
        expandedKeys={["/build_until_verified", "/build_until_verified[2]"]}
      />,
    );
    const row = screen.getByTestId("run-tree-row-/build_until_verified[2]/implement");
    expect(row.textContent).toContain("interrupted — outcome unknown");
    // The state is not quietly upgraded into a verdict the API did not send.
    expect(row.textContent).not.toMatch(/failed|cancelled|skipped/);
  });

  it("keeps the fan-out's 25 invocations in one cell", () => {
    const cells = stageCells(fanOutNodes);
    const invoke = cells.find((cell) => cell.nodeId === "invoke")!;
    expect(invoke.instances).toHaveLength(25);
    expect(invoke.counts.map((entry) => `${entry.count} ${entry.word}`).join(" ")).toContain(
      "18 done",
    );
  });

  it("holds ONE cell for a loop that ran twice — W2's live measurement", () => {
    // The 14 rows the lab's `01a144f4…` run really wrote (`node_id | key | kind |
    // status`, read off the ledger): the loop is one stage with two iterations,
    // and the iterations reach the page as the body rows under `[1]` and `[2]`.
    const cells = stageCells(twinLedger());
    const loops = cells.filter((cell) => cell.nodeId === "build_until_verified");
    expect(loops).toHaveLength(1);
    // Two iterations, both finished — repeat counts on one stage, not two stages.
    expect(loops[0].instances.map((instance) => instance.key)).toEqual([
      "/build_until_verified[1]",
      "/build_until_verified[2]",
    ]);
    expect(loops[0].counts).toEqual([{ state: "done", word: "done", count: 2 }]);
    // One cell per definition node, and no empty cell left over for the places.
    expect(cells.map((cell) => cell.nodeId)).toEqual([
      "plan",
      "approve",
      "build_until_verified",
      "implement",
      "review",
      "test",
      "emit_items",
      "fan_out",
      "verdict",
      "publish_verified",
      "publish_needs_attention",
    ]);
  });

  it("keeps one cell even when the server spells a place's node_id with its iteration", () => {
    // The same ledger read a second way: the loop also sends a row per place,
    // `/build_until_verified[1]`, with `node_id` carrying the suffix. Grouping by
    // that spelling would hand the loop a second stage cell — the duplication
    // `10` J7 forbids.
    const suffixed = twinLedger().map((node) => ({
      ...node,
      node_id: node.node_instance_key.split("/").filter(Boolean).pop() ?? node.node_id,
    }));
    const place = (iteration: number): NodeExecutionSummary => ({
      ...suffixed[2],
      id: `exec-place-${iteration}`,
      node_id: `build_until_verified[${iteration}]`,
      node_instance_key: `/build_until_verified[${iteration}]`,
      iterations: undefined,
      items: undefined,
    });
    const cells = stageCells([...suffixed, place(1), place(2)]);
    const loop = cells.filter((cell) => cell.nodeId === "build_until_verified");
    expect(loop).toHaveLength(1);
    // The two real place rows are the cell's two segments, states and all.
    expect(loop[0].instances.map((instance) => instance.key)).toEqual([
      "/build_until_verified[1]",
      "/build_until_verified[2]",
    ]);
    expect(cells.some((cell) => cell.nodeId.startsWith("build_until_verified["))).toBe(false);
    expect(cells).toHaveLength(11);
  });
});

describe("RunStageStrip", () => {
  it("renders one button per definition node, with counts beside the colours", () => {
    const onSelectNode = vi.fn();
    render(<RunStageStrip nodes={featureNodes} onSelectNode={onSelectNode} />);
    expect(screen.getAllByTestId(/^run-stage-cell-/)).toHaveLength(9);
    expect(screen.getByTestId("run-stage-counts-build_until_verified").textContent).toContain(
      "1 running",
    );
    fireEvent.click(screen.getByTestId("run-stage-cell-implement"));
    expect(onSelectNode).toHaveBeenCalledWith("implement");
  });

  it("gives the loop exactly one button a name-checker can count (W2)", () => {
    // The live leg counts stage cells by their accessible name — `"<node id>,
    // <n> <word>, …"`, the sr-only line below. Two buttons answering to the loop
    // is the duplication the row fails the page for, so the count is asserted
    // here as well as in the view model.
    render(<RunStageStrip nodes={twinLedger()} />);
    const named = screen
      .getAllByTestId(/^run-stage-cell-/)
      .filter((cell) =>
        /^build_until_verified\b[^,]*,\s*\d+\s/.test((cell.textContent ?? "").trim()),
      );
    expect(named).toHaveLength(1);
    expect(named[0].textContent).toContain("2 done");
  });

  it("draws a segment per execution, so the loop reads as repeats", () => {
    render(<RunStageStrip nodes={interruptedNodes} />);
    const segments = screen.getByTestId("run-stage-segments-implement");
    expect(segments.children).toHaveLength(2);
    expect(segments.getAttribute("aria-hidden")).toBe("true");
    // The same facts reach assistive tech as words, in the cell itself.
    expect(screen.getByTestId("run-stage-cell-implement").textContent).toContain("1 stopped");
    expect(screen.getByTestId("run-stage-cell-implement").textContent).toContain("1 done");
  });

  it("marks the selected node with aria-current, not with colour alone", () => {
    render(<RunStageStrip nodes={featureNodes} selectedNodeId="test" />);
    expect(screen.getByTestId("run-stage-cell-test").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("run-stage-cell-plan").hasAttribute("aria-current")).toBe(false);
  });

  it("says what the strip is, so a screen reader is not handed a bar chart", () => {
    render(<RunStageStrip nodes={fanOutNodes} />);
    expect(screen.getByTestId("run-stage-note").textContent).toContain(
      "the loop is not duplicated as stages",
    );
  });

  it("handles a run with nothing executed yet", () => {
    render(<RunStageStrip nodes={[]} />);
    expect(screen.queryAllByTestId(/^run-stage-cell-/)).toHaveLength(0);
    expect(screen.getByTestId("run-stage-note")).toBeTruthy();
  });
});
/** The rows as the route returns them: sorted by instance key, not by the plan. */
function asApiListsIt(nodes: typeof featureNodes): typeof featureNodes {
  return [...nodes].sort((a, b) => a.node_instance_key.localeCompare(b.node_instance_key));
}

/** The lab's completed deterministic twin, row for row, as `GET /nodes` sent it. */
function twinLedger(): NodeExecutionSummary[] {
  const row = (
    nodeId: string,
    key: string,
    kind: string,
    status: NodeExecutionStatus,
    extra: Partial<NodeExecutionSummary> = {},
  ): NodeExecutionSummary => ({
    id: `exec-${key}`,
    run_id: "01a144f4-936f-7eb8-9ed4-630b866c94e9",
    node_id: nodeId,
    node_instance_key: key,
    scope_key: key.includes("[") ? "/build_until_verified" : "/",
    kind,
    execution_location: kind === "until" || kind === "for_each" ? "control_plane" : "worker",
    status,
    outcome: null,
    error_class: null,
    failed_cause: null,
    attempt_count: status === "succeeded" ? 1 : 0,
    attempt_limit: 1,
    in_flight: 0,
    waiting_reason: null,
    artifact_refs: [],
    ready_at: null,
    finished_at: status === "succeeded" ? "2026-10-16T13:44:20Z" : null,
    ...extra,
  });
  const body = (iteration: number) =>
    ["implement", "review", "test"].map((nodeId) =>
      row(nodeId, `/build_until_verified[${iteration}]/${nodeId}`, "process.exec", "succeeded"),
    );
  return [
    row("plan", "/plan", "process.exec", "succeeded"),
    row("approve", "/approve", "human.approval", "succeeded"),
    // The scope row is the only one that knows how many times it ran; the loop
    // never sends a row per place, which is why the cell counts from `iterations`.
    row("build_until_verified", "/build_until_verified", "until", "succeeded", {
      iterations: 2,
      items: 0,
    }),
    ...body(1),
    ...body(2),
    row("emit_items", "/emit_items", "process.exec", "skipped"),
    row("fan_out", "/fan_out", "for_each", "skipped", { iterations: null, items: 0 }),
    row("verdict", "/verdict", "condition", "succeeded"),
    row("publish_verified", "/publish_verified", "artifact.publish", "succeeded"),
    row("publish_needs_attention", "/publish_needs_attention", "artifact.publish", "skipped"),
  ];
}
