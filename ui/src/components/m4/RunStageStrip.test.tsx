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

  it("holds ONE cell for the loop of the m4 seed as it is published today", () => {
    // The seed (`docs/compatibility/probes/m4/pipeline.yaml`, document 2) grew a
    // `test_evidence` publisher INSIDE the loop body — `test-${{ iteration }}.json`
    // per pass, so C7b has one artifact row per iteration — and a `publish_plan`
    // appended after the fan-out's publishers, so C9f has a ready artifact before
    // /approve's gate. A body node that publishes on every pass must not widen the
    // loop into more stages: W2 counts the loop's cells in the live page's stage
    // strip, and 1c190fe GAPped because it never found the ONE cell it was told to
    // count — so the shape it reads is pinned here too.
    const rows: NodeExecutionSummary[] = [];
    for (const node of twinLedger()) {
      rows.push(node);
      if (node.node_id === "test") {
        const iteration = /\[(\d+)\]\/test$/.exec(node.node_instance_key)?.[1];
        rows.push({
          ...node,
          id: `exec-test-evidence-${iteration}`,
          node_id: "test_evidence",
          node_instance_key: `/build_until_verified[${iteration}]/test_evidence`,
          kind: "artifact.publish",
        });
      }
    }
    rows.push({
      ...rows[0],
      id: "exec-/publish_plan",
      node_id: "publish_plan",
      node_instance_key: "/publish_plan",
      kind: "artifact.publish",
      iterations: undefined,
      items: undefined,
    });

    const cells = stageCells(rows);
    const loops = cells.filter((cell) => cell.nodeId === "build_until_verified");
    expect(loops).toHaveLength(1);
    // One cell, two segments: the loop's cell counts its PASSES (rolled up from
    // the four body rows of each), never one stage per pass.
    expect(loops[0].instances.map((instance) => instance.key)).toEqual([
      "/build_until_verified[1]",
      "/build_until_verified[2]",
    ]);
    expect(loops[0].counts.map((entry) => `${entry.count} ${entry.word}`)).toEqual(["2 done"]);
    expect(cells.some((cell) => cell.nodeId.startsWith("build_until_verified["))).toBe(false);
    // The per-iteration publisher is ONE cell of its own (both passes are its
    // segments), and the appended pre-gate publisher is on the strip too.
    expect(cells.filter((cell) => cell.nodeId === "test_evidence")).toHaveLength(1);
    expect(cells.find((cell) => cell.nodeId === "test_evidence")?.instances).toHaveLength(2);
    expect(cells.some((cell) => cell.nodeId === "publish_plan")).toBe(true);

    // And the strip draws it the way the W2 driver counts it: exactly one button
    // whose accessible name opens with the loop's id and carries its counts.
    render(<RunStageStrip nodes={rows} />);
    const named = screen
      .getAllByTestId(/^run-stage-cell-/)
      .filter((cell) =>
        /^build_until_verified\b[^,]*,\s*\d+\s/.test((cell.textContent ?? "").trim()),
      );
    expect(named).toHaveLength(1);
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

describe("the strip in a 350px pane (the run page's Diagnostics view)", () => {
  // The Diagnostics pane is ~350px on a 1280 screen and ~356px at 390, and the
  // old strip read 3 cells to a row there with the ids clipped —
  // `BUILD_UNTIL_V…` — which threw away the one fact the cell exists to carry.
  // These are the layout contract the fix ships; jsdom draws nothing, so it
  // pins the CSS the browser will apply, and `.playwright-cli/` holds the shots.
  it("gives a cell the strip's full width before it wraps a name", () => {
    const { container } = render(<RunStageStrip nodes={featureNodes} />);
    const strip = container.querySelector("[data-testid=run-stage-strip]") as HTMLElement;
    // A grid, not a wrap-flex row of `min-w-[7rem] flex-1` cells: with a 13rem
    // floor, a 350px pane holds exactly one column and every name is on screen.
    expect(strip.className).toContain("grid");
    expect(strip.className).not.toContain("flex-wrap");
    expect(strip.style.gridTemplateColumns).toContain("repeat(auto-fit");
    expect(strip.style.gridTemplateColumns).toContain("minmax(min(13rem, 100%), 1fr)");
    // `min(…, 100%)` is what keeps the floor from forcing the page sideways at
    // 390; `auto-fit` (not `auto-fill`) collapses the empty tracks so the
    // hairline background cannot show through as a gray block.
    expect(strip.className).not.toContain("divide-x");
    for (const cell of screen.getAllByTestId(/^run-stage-cell-/)) {
      expect(cell.className).toContain("min-w-0");
      expect(cell.className).not.toContain("flex-1");
    }
  });

  it("wraps a long stage name instead of ellipsising it, at 11px or more", () => {
    render(<RunStageStrip nodes={featureNodes} />);
    // The longest id on the strip: 23 characters, clipped by the old cell.
    const id = screen.getByTestId("run-stage-id-publish_needs_attention");
    expect(id.textContent).toBe("publish_needs_attention");
    expect(id.className).toContain("break-words"); // it takes a second row…
    expect(id.className).not.toContain("truncate"); // …it never clips
    expect(id.className).toContain("text-[11px]"); // legible, not shrunk to fit
    // Every id on the strip is addressable as text, so none of them is hidden.
    expect(screen.getAllByTestId(/^run-stage-id-/).map((node) => node.textContent)).toEqual([
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
  });

  it("keeps the loop cell's iteration segments beside its full-width name", () => {
    render(<RunStageStrip nodes={featureNodes} />);
    const cell = screen.getByTestId("run-stage-cell-build_until_verified");
    expect(screen.getByTestId("run-stage-id-build_until_verified").textContent).toBe(
      "build_until_verified",
    );
    const segments = screen.getByTestId("run-stage-segments-build_until_verified");
    // Two passes → two segments, and the bar spans the cell so each pass is a
    // visible band rather than a 3px sliver in a 117px cell.
    expect(segments.children).toHaveLength(2);
    expect(segments.className).toContain("w-full");
    expect(cell.contains(segments)).toBe(true);
  });

  it("keeps every fact inside the cell's own box, so a narrow pane loses nothing", () => {
    // The Diagnostics pane is the width RunWorkbench gives it, and a cell that
    // refuses to shrink (a `whitespace-nowrap` title-bar meta is how the
    // DEFINITION GRAPH panel ended up 447px of min-content in the same pane) is
    // what pushes that pane past the edge of the space the page can show. The
    // strip may never add to that: everything in a cell wraps, the cell keeps
    // horizontal padding, and the bar spans the padded box — never the page.
    const { container } = render(<RunStageStrip nodes={featureNodes} />);
    const strip = container.querySelector("[data-testid=run-stage-strip]") as HTMLElement;
    for (const node of Array.from(strip.querySelectorAll("span,div,button,p"))) {
      const className = typeof node.className === "string" ? node.className : "";
      // Nothing in the strip may hold its text on one unbreakable line…
      expect(className).not.toMatch(/whitespace-nowrap|truncate/);
      // …and a cell that may not shrink may only carry ONE word, so its
      // min-content stays the longest state word rather than a whole sentence.
      if (/\bshrink-0\b/.test(className)) {
        expect(node.textContent?.trim()).not.toMatch(/\s/);
      }
    }
    const cell = screen.getByTestId("run-stage-cell-build_until_verified");
    expect(cell.className).toContain("px-[11px]"); // padding, not edge-to-edge ink
    const row = cell.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex-wrap"); // the name line may take a second row
    const bar = screen.getByTestId("run-stage-segments-build_until_verified");
    // `w-full` of a padded box: the bar's own width follows the cell, so it
    // cannot be the thing that runs past a clip.
    expect(bar.className).toContain("w-full");
    expect(bar.parentElement).toBe(cell);
  });

  it("still names each cell the way the m4 driver counts cells", () => {
    render(<RunStageStrip nodes={featureNodes} />);
    // e2e/m4/e2e_m4_exit.py's `w_strip_cells` matches a button's accessible name
    // against `^([a-z][\w.]*)\b[^\d,]*\1,\s*\d+\s`: the id, then nothing but the
    // state word (no digits, no commas), then the id again with its counts. The
    // reflow moved those pieces onto one line and must not have put a number
    // between them — so the name is recomputed here, from the DOM, the way the
    // browser computes it (aria-hidden subtrees contribute nothing).
    const wholeStrip = /^([a-z][\w.]*)\b[^\d,]*\1,\s*\d+\s/;
    const cells = screen.getAllByTestId(/^run-stage-cell-/);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const name = accessibleName(cell);
      expect(name).toMatch(wholeStrip);
      // And the id-only form the loop count uses.
      const nodeId = cell.getAttribute("data-testid")!.replace("run-stage-cell-", "");
      expect(name).toMatch(new RegExp(`^${nodeId}\\b[^,]*,\\s*\\d+\\s`));
    }
    // Corroboration, with testing-library's own accname implementation rather
    // than the helper above: the name it computes also runs id → state word →
    // id, with no number in between, which is only true because the counts line
    // is `aria-hidden`. (Chromium's own name for such a cell is on record in the
    // m4 driver's docstring — `build_until_verified queued build_until_verified,
    // 1 pending` — and `\s*` covers the two implementations' different joins.)
    expect(
      screen.getByRole("button", {
        name: /^build_until_verified\s*running\s*build_until_verified/,
      }),
    ).toBe(screen.getByTestId("run-stage-cell-build_until_verified"));
  });
});

/**
 * Name-from-content: skip `aria-hidden` subtrees, join what survives with single
 * spaces, and collapse the whitespace the markup's own indentation leaves.
 */
function accessibleName(element: Element): string {
  if (element.getAttribute("aria-hidden") === "true") return "";
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) text += `${child.textContent} `;
    else if (child.nodeType === 1) text += `${accessibleName(child as Element)} `;
  }
  return text.replace(/\s+/g, " ").trim();
}
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
