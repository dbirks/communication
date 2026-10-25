/**
 * GraphCanvas geometry (design 1e, pass-4): the line leaves the BOTTOM CENTRE
 * of the source card and enters the TOP CENTRE of the target card — the
 * rendered box (200×52 floor), not dagre's own box — and the lines carry no
 * arrowheads. jsdom does no layout, but every coordinate here is inline
 * (style attributes and the polyline's `points`), so the contract is fully
 * assertable without a browser.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphCanvas } from "./GraphCanvas";
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

function edgePoints(testid: string): { x: number; y: number }[] {
  const el = screen.getByTestId(testid) as unknown as SVGElement;
  return (el.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
}

describe("GraphCanvas", () => {
  it("draws plain lines: no arrowheads anywhere", () => {
    renderCanvas();
    const edges = screen.getByTestId("workflow-graph-edges");
    expect(edges.querySelector("[marker-end]")).toBeNull();
    expect(edges.querySelector("marker")).toBeNull();
  });

  it("joins the bottom-centre of each source card to the top-centre of its target", () => {
    renderCanvas();
    // The sample's `plan` follows `approve`… use an edge that exists in the
    // frozen sample: every `plan → approve` style link is one polyline keyed
    // by its endpoints; check the plan→approve one.
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
