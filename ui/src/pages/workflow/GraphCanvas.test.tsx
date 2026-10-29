/**
 * GraphCanvas geometry (design 1e, pass-4 + the side-by-side fix): the line
 * leaves the BOTTOM CENTRE of the source card and enters the TOP CENTRE of
 * the target card — the rendered box (the Studio's 200×52 card re-centred on
 * dagre's axis via `stepCardBox`), not dagre's own box — drawn with the
 * Studio's orthogonal `routeEdge` as an SVG `<path>`, with no arrowheads.
 * For a linear chain every card shares ONE axis and every connector is
 * straight up that axis: no diagonal segment, no drift.
 * jsdom does no layout, but every coordinate here is inline (style
 * attributes and the path's `d`), so the contract is fully assertable
 * without a browser.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphCanvas } from "./GraphCanvas";
import { CARD_TITLE_PX, MIN_FIT_SCALE, MIN_TITLE_PX } from "./graphFit";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { samplePipelineDocument } from "../../test/fixtures/m4/samplePipeline";

const doc = samplePipelineDocument as unknown as DefinitionDocument;

afterEach(cleanup);

function renderCanvas() {
  render(<GraphCanvas document={doc} label="read-only · r1 · caption" />);
}

/** A card's rendered box, read from the inline style the component writes. */
function cardBox(testid: string) {
  const el = screen.getByTestId(testid);
  const left = parseFloat(el.style.left || "0");
  const top = parseFloat(el.style.top || "0");
  const width = parseFloat(el.style.width || "0");
  const height = parseFloat(el.style.height || "0");
  return { cx: left + width / 2, top, bottom: top + height };
}

/** The rendered edge: the SVG `d` and the vertices its M/L commands name. */
function edgePath(testid: string): { d: string; points: { x: number; y: number }[] } {
  const el = screen.getByTestId(testid) as unknown as SVGElement;
  const d = el.getAttribute("d") ?? "";
  const points = [...d.matchAll(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  return { d, points };
}

const edgePoints = (testid: string) => edgePath(testid).points;

/** A linear chain in the design's own shape (survey → plan → approve →
 * publish_plan) — the document 1e's built screen renders. */
const linearDoc = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "linear" },
  spec: {
    nodes: [
      { id: "survey", kind: "process.exec", config: { executable: "sh" } },
      { id: "plan", kind: "model.chat", dependsOn: ["survey"], config: { model: "org/model" } },
      {
        id: "approve",
        kind: "human.approval",
        dependsOn: ["plan"],
        config: { approverRoles: ["maintainer"] },
      },
      {
        id: "publish_plan",
        kind: "artifact.publish",
        dependsOn: ["approve"],
        config: { name: "publish · plan.md" },
      },
    ],
  },
} as unknown as DefinitionDocument;

const LINEAR_IDS = ["survey", "plan", "approve", "publish_plan"];

describe("GraphCanvas", () => {
  it("lays a linear chain on ONE centred axis with straight vertical connectors (design 1e / 1g)", () => {
    render(<GraphCanvas document={linearDoc} label="read-only · r1 · caption" />);
    // Every card sits exactly on the design's 200×52 measure, and every
    // card's x-CENTRE is the same number — no publish_plan drifting left of
    // the column because its id made the dagre box wider.
    const centres = LINEAR_IDS.map((id) => cardBox(`workflow-graph-node-${id}`).cx);
    for (const [index, card] of LINEAR_IDS.map((id) =>
      screen.getByTestId(`workflow-graph-node-${id}`),
    ).entries()) {
      expect(parseFloat(card.style.width)).toBe(200);
      expect(parseFloat(card.style.height)).toBeGreaterThanOrEqual(52);
      expect(centres[index]).toBeCloseTo(centres[0], 6);
    }
    // Each connector is straight DOWN the shared axis: the path is pure
    // M/L (no curve commands), every vertex sits on the column's x-centre,
    // and consecutive vertices differ only in y — no diagonal segment.
    for (const [from, to] of [
      ["survey", "plan"],
      ["plan", "approve"],
      ["approve", "publish_plan"],
    ] as const) {
      const { d, points } = edgePath(`workflow-graph-edge-${from}-to-${to}`);
      expect(d).toMatch(/^(M|L)/);
      expect(d).not.toMatch(/[AaCcQqSsTt]/); // no curves
      expect(points.length).toBeGreaterThanOrEqual(2);
      // Every vertex on the shared axis ⇒ every segment moves only in y — a
      // diagonal bend (the "<" zig-zag the mismatch drew) is impossible here.
      for (const point of points) {
        expect(point.x).toBeCloseTo(centres[0], 6);
      }
      const source = cardBox(`workflow-graph-node-${from}`);
      const target = cardBox(`workflow-graph-node-${to}`);
      expect(points[0].x).toBeCloseTo(source.cx, 6);
      expect(points[0].y).toBeCloseTo(source.bottom, 6);
      expect(points[points.length - 1].x).toBeCloseTo(target.cx, 6);
      expect(points[points.length - 1].y).toBeCloseTo(target.top, 6);
      expect(points[1].y).toBeGreaterThan(points[0].y); // downward, not zig-zag
    }
  });

  it("keeps the caption BELOW the graph, never printed over a card (390px 1e)", () => {
    render(<GraphCanvas document={linearDoc} label="read-only · r1 · caption" />);
    const caption = screen.getByTestId("workflow-graph-caption");
    // In-flow (a `block` in the column), not `absolute` pinned to the pane's
    // bottom — the pin is what put the text over `publish_plan` at 390.
    expect(caption.className).toContain("block");
    expect(caption.className).not.toContain("absolute");
    expect(caption.className).not.toMatch(/\bbottom-/);
    // The canvas is the caption's column sibling: the caption is the graph
    // root's next sibling after the canvas area, so the field grows past the
    // last card instead of overlapping it.
    const root = screen.getByTestId("workflow-graph");
    const canvasArea = root.firstElementChild as HTMLElement;
    expect(canvasArea.contains(screen.getByTestId("workflow-graph-canvas"))).toBe(true);
    expect(canvasArea.nextElementSibling).toBe(caption);
  });

  it("draws plain lines: no arrowheads anywhere", () => {
    renderCanvas();
    const edges = screen.getByTestId("workflow-graph-edges");
    expect(edges.querySelector("[marker-end]")).toBeNull();
    expect(edges.querySelector("marker")).toBeNull();
  });

  it("joins the bottom-centre of each source card to the top-centre of its target", () => {
    renderCanvas();
    // The sample's `plan` → `approve` link is one path keyed by its
    // endpoints; check that one.
    const points = edgePoints("workflow-graph-edge-plan-to-approve");
    expect(points.length).toBeGreaterThanOrEqual(2);
    const source = cardBox("workflow-graph-node-plan");
    const target = cardBox("workflow-graph-node-approve");
    expect(points[0]).toEqual({ x: source.cx, y: source.bottom });
    expect(points[points.length - 1]).toEqual({ x: target.cx, y: target.top });
  });

  it("honours the card floor: a narrow dagre box renders 200×52 and the line follows the card", () => {
    renderCanvas();
    const card = screen.getByTestId("workflow-graph-node-plan");
    expect(parseFloat(card.style.width)).toBeGreaterThanOrEqual(200);
    expect(parseFloat(card.style.height)).toBeGreaterThanOrEqual(52);
    const points = edgePoints("workflow-graph-edge-plan-to-approve");
    const source = cardBox("workflow-graph-node-plan");
    // The first point's x equals the card centre — 46px right of where a
    // dagre-box-based point would sit for the sample's narrower box.
    expect(points[0].x).toBeCloseTo(source.cx, 6);
  });

  it("labels each card with glyph + kind word + the one key fact the config carries", () => {
    renderCanvas();
    const approve = screen.getByTestId("workflow-graph-node-approve");
    // human.approval in the sample names its approver role — the card shows
    // `⊙ gate · maintainer`, nothing invented (the fact comes from
    // config.approverRoles[0]).
    expect(approve.textContent).toContain("⊙");
    expect(approve.textContent).toContain("gate");
    expect(approve.textContent).toContain("maintainer");
    // The sample's `plan` is an agent step (agent.acp → ◆ agent).
    const plan = screen.getByTestId("workflow-graph-node-plan");
    expect(plan.textContent).toContain("◆");
    expect(plan.textContent).toContain("agent");
  });
});

describe("GraphCanvas fit-to-pane (design 1e, 390px reflow)", () => {
  /** Class list of the canvas root's first child — the stage that centres
   * a fitting graph or left-aligns a panning one. */
  function stageClass(): string {
    const root = screen.getByTestId("workflow-graph").firstElementChild as HTMLElement;
    return root.className;
  }

  it("draws at natural scale, centred, with no pan hint when the pane fits it (the 1280 look)", () => {
    // jsdom does no layout: `clientWidth` is 0 = “unmeasured”, and an
    // unmeasured pane must not shrink the graph to nothing.
    render(<GraphCanvas document={doc} label="read-only · r1 · caption" />);
    expect(screen.getByTestId("workflow-graph-canvas").getAttribute("data-scale")).toBe("1.000");
    expect(screen.getByTestId("workflow-graph").getAttribute("data-pans")).toBe("false");
    expect(stageClass()).toContain("justify-center");
    expect(screen.queryByTestId("workflow-graph-pan-hint")).toBeNull();
  });

  it("a pane narrower than the graph holds the readable floor, left-aligns at the graph's left edge and says it pans", () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 320 });
    try {
      render(<GraphCanvas document={doc} label="read-only · r1 · caption" />);
      const canvas = screen.getByTestId("workflow-graph-canvas");
      const scale = Number(canvas.getAttribute("data-scale"));
      // Never under the floor, and the invariant in the reader's units.
      expect(scale).toBeGreaterThanOrEqual(MIN_FIT_SCALE);
      expect(CARD_TITLE_PX * scale).toBeGreaterThanOrEqual(MIN_TITLE_PX);
      // The sized box the pane scrolls measures the scaled graph — and it is
      // wider than the pane, which is exactly why the stage left-aligns: a
      // centred overflow would strand the graph's left column in the
      // unscrollable dead zone (the 390px cut-off this replaces).
      const sized = canvas.parentElement as HTMLElement;
      const boxWidth = parseFloat(sized.style.width);
      expect(boxWidth).toBeGreaterThan(320);
      expect(stageClass()).toContain("justify-start");
      expect(stageClass()).not.toContain("justify-center");
      expect(screen.getByTestId("workflow-graph").getAttribute("data-pans")).toBe("true");
      // …and the pan is said out loud, in plain user words: what to do,
      // in the caption line's voice — never pixel counts or geometry.
      const hint = screen.getByTestId("workflow-graph-pan-hint");
      expect(hint.textContent).toContain("Scroll sideways to see the rest of the graph.");
      expect(hint.textContent).not.toMatch(/\d/);
      expect(hint.textContent).not.toContain("edge");
      // The hint rides BELOW the caption — the caption stays the canvas's
      // last flow row before it (the pass-5 overlap rule keeps holding).
      const caption = screen.getByTestId("workflow-graph-caption");
      expect(caption.nextElementSibling).toBe(hint);
      // The cards keep their graph coordinates inside the scaled layer — the
      // fit is a transform, not a re-layout.
      const card = screen.getByTestId("workflow-graph-node-plan");
      expect(parseFloat(card.style.width)).toBeGreaterThanOrEqual(200);
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });

  it("a pane wider than the graph changes nothing: natural scale, centred, no hint", () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 900 });
    try {
      render(<GraphCanvas document={doc} label="read-only · r1 · caption" />);
      const canvas = screen.getByTestId("workflow-graph-canvas");
      expect(canvas.getAttribute("data-scale")).toBe("1.000");
      expect(screen.getByTestId("workflow-graph").getAttribute("data-pans")).toBe("false");
      expect(stageClass()).toContain("justify-center");
      expect(screen.queryByTestId("workflow-graph-pan-hint")).toBeNull();
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });
});
