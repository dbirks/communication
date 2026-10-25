/**
 * StudioCanvas tests. React Flow in jsdom needs ResizeObserver and DOMMatrix
 * stubs; the canvas renders one focusable step per node, the edge "+" opens
 * the picker and calls onInsertOnEdge, readOnly strips the "+" affordances,
 * and a refused connect surfaces its reason without calling onConnect.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import {
  centerOnBox,
  computeFitViewport,
  computeTopFitViewport,
  evaluateConnect,
  mirrorOwnedChanges,
  parseViewportTransform,
  StudioCanvas,
  type StudioCanvasProps,
} from "./StudioCanvas";
import { routeEdge, toFlow } from "./flowModel";

class ResizeObserverStub {
  private readonly callback: (
    entries: { target: Element; contentRect: { width: number; height: number } }[],
  ) => void;
  constructor(
    callback: (
      entries: { target: Element; contentRect: { width: number; height: number } }[],
    ) => void,
  ) {
    this.callback = callback;
  }
  observe(target: Element): void {
    // jsdom never fires resize callbacks; notify synchronously-deferred so
    // React Flow measures the node and renders its edges.
    queueMicrotask(() => this.callback([{ target, contentRect: { width: 1200, height: 800 } }]));
  }
  unobserve(): void {}
  disconnect(): void {}
}

class DOMMatrixStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m22 = 1;
  multiplySelf(): this {
    return this;
  }
  translateSelf(): this {
    return this;
  }
  scaleSelf(): this {
    return this;
  }
}

const offsetPatch: { offsetWidth: PropertyDescriptor; offsetHeight: PropertyDescriptor } = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!,
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!,
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrix", DOMMatrixStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixStub);
  // React Flow measures via offsetWidth/offsetHeight; jsdom reports 0, which
  // keeps edges (and the edge "+" buttons) unrendered.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 208,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 96,
  });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetPatch.offsetWidth);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetPatch.offsetHeight);
  cleanup();
});

const fixtureYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: studio-test
  description: two steps
spec:
  policies:
    maxConcurrentNodes: 1
  nodes:
    - id: plan
      kind: model.chat
      config:
        model: m
        messages:
          - { role: user, content: hi }
    - id: check
      kind: process.exec
      dependsOn: [plan]
      config:
        executable: sh
        args: []
`;

const parsed = parseGraph(fixtureYaml);
if (!parsed.ok) throw new Error(`fixture should parse: ${parsed.error}`);
// Module-scope narrowing does not flow into closures: bind the model once.
const fixtureModel = parsed.model;

function renderCanvas(overrides: Partial<StudioCanvasProps> = {}) {
  const props: StudioCanvasProps = {
    model: fixtureModel,
    document: parse(fixtureYaml),
    layout: {},
    selectedId: null,
    readOnly: false,
    stale: false,
    onSelect: vi.fn(),
    ...overrides,
  };
  return render(<StudioCanvas {...props} />);
}

describe("StudioCanvas", () => {
  it("renders a focusable step per node with its aria-label", () => {
    renderCanvas();
    const plan = screen.getByLabelText("Ask a model step plan");
    expect(plan).toBeTruthy();
    expect(screen.getByLabelText("Run command / tests step check")).toBeTruthy();
    expect(screen.getByTestId("canvas-step-list")).toBeTruthy();
    // The accessible list names the dependency (the rows stay in the DOM
    // behind the collapsed disclosure).
    expect(screen.getByTestId("canvas-step-row-check").textContent).toContain("after plan");
  });

  it("edge + opens the picker and calls onInsertOnEdge with the picked kind", async () => {
    const onInsertOnEdge = vi.fn();
    renderCanvas({ onInsertOnEdge });
    // Edges render only after the (stubbed) ResizeObserver has measured the
    // nodes — a microtask after mount.
    fireEvent.click(await screen.findByTestId("edge-add-plan-check"));
    expect(screen.getByTestId("step-picker")).toBeTruthy();
    fireEvent.click(screen.getByTestId("step-picker-item-process.exec"));
    expect(onInsertOnEdge).toHaveBeenCalledTimes(1);
    const [edge, kind] = onInsertOnEdge.mock.calls[0];
    expect(edge.from).toBe("plan");
    expect(edge.to).toBe("check");
    expect(kind).toBe("process.exec");
  });

  it("shows the trailing + only on terminal steps, and never in read-only mode", () => {
    const { unmount } = renderCanvas();
    expect(screen.getByTestId("add-after-check")).toBeTruthy();
    expect(screen.queryByTestId("add-after-plan")).toBeNull();

    unmount();
    renderCanvas({ readOnly: true });
    expect(screen.queryByTestId("add-after-check")).toBeNull();
    expect(screen.queryByTestId("edge-add-plan-check")).toBeNull();
  });

  it("renders the greyed banner when the YAML is stale", () => {
    renderCanvas({ stale: true, staleMessage: "YAML has errors — editing paused." });
    expect(screen.getByTestId("canvas-stale-banner").textContent).toBe(
      "YAML has errors — editing paused.",
    );
  });

  it("shows the add-first affordance for an empty canvas", () => {
    const empty = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: empty
  description: no steps
spec:
  policies:
    maxConcurrentNodes: 1
  nodes: []
`;
    const emptyParsed = parseGraph(empty);
    if (!emptyParsed.ok) throw new Error(emptyParsed.error);
    const onAddAfter = vi.fn();
    renderCanvas({ model: emptyParsed.model, document: parse(empty), onAddAfter });
    fireEvent.click(screen.getByTestId("canvas-add-first"));
    fireEvent.click(screen.getByTestId("step-picker-item-agent.acp"));
    expect(onAddAfter).toHaveBeenCalledWith(null, [], "agent.acp");
  });

  it("keeps every node on the canvas when a scope child is selected and overlays are on", () => {
    // The Run Workbench hands the shared canvas a URL-selected definition node
    // (a scope child: `implement` inside the until scope) plus a per-node
    // status overlay map. The canvas must still draw the whole definition —
    // scope group and every body node — with the overlay on the child.
    const scoped = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: studio-test-scoped
  description: run view over a scope
spec:
  policies:
    maxConcurrentNodes: 1
  nodes:
    - id: plan
      kind: model.chat
      config:
        model: m
        messages:
          - { role: user, content: hi }
    - id: build_until_verified
      kind: until
      dependsOn: [plan]
      config:
        maxIterations: 4
        passWhen: "true"
        body:
          nodes:
            - id: implement
              kind: process.exec
              config:
                executable: sh
                args: []
            - id: test
              kind: process.exec
              dependsOn: [implement]
              config:
                executable: sh
                args: []
`;
    const parsed = parseGraph(scoped);
    if (!parsed.ok) throw new Error(`scoped fixture must parse: ${parsed.error}`);
    const { container } = renderCanvas({
      model: parsed.model,
      document: parse(scoped),
      selectedId: "implement",
      readOnly: true,
      statusOverlay: {
        plan: { state: "succeeded", label: "succeeded" },
        build_until_verified: { state: "running", label: "iteration 2 of 4" },
        implement: { state: "running", label: "running" },
        test: { state: "queued", label: "not started" },
      },
    });
    // One React Flow node per definition node — nothing dropped: selecting
    // the scope child and painting the overlays leave the graph intact.
    const flowNodes = container.querySelectorAll(".react-flow__node");
    expect(flowNodes.length).toBe(4);
    expect(screen.getByTestId("canvas-step-plan")).toBeTruthy();
    expect(screen.getByTestId("canvas-scope-build_until_verified")).toBeTruthy();
    expect(screen.getByTestId("canvas-step-implement")).toBeTruthy();
    expect(screen.getByTestId("canvas-step-test")).toBeTruthy();
    // The overlay lands on the scoped child by its definition id.
    expect(screen.getByTestId("step-status-implement").textContent).toContain("running");
    expect(screen.getByTestId("scope-status-build_until_verified").textContent).toContain(
      "iteration 2 of 4",
    );
  });

  it("renders the selected node's menu with Duplicate and Delete, and wires the actions", () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDuplicate, onDelete });
    const menu = screen.getByTestId("studio-node-menu");
    expect(menu).toBeTruthy();
    expect(screen.getByTestId("studio-node-menu-duplicate")).toBeTruthy();
    expect(screen.getByTestId("studio-node-menu-delete")).toBeTruthy();

    // Both actions live in one menu that closes after each activation, so the
    // second action needs the menu re-opened (right-click) before it can fire.
    fireEvent.click(screen.getByTestId("studio-node-menu-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(["check"]);

    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    fireEvent.click(screen.getByTestId("studio-node-menu-duplicate"));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith("check");
  });

  it("opens the context menu on right-click and deletes from it", () => {
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDelete });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("studio-node-menu-delete"));
    expect(onDelete).toHaveBeenCalledWith(["check"]);
  });

  it("closes the context menu with Escape", () => {
    renderCanvas({ selectedId: "check" });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    const menu = screen.getByTestId("studio-node-menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
  });

  it("navigates the context menu with arrow keys and deletes with Enter", () => {
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDelete });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    const menu = screen.getByTestId("studio-node-menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onDelete).toHaveBeenCalledWith(["check"]);
  });

  it("keeps the edge plus sign centred on the line at its midpoint", async () => {
    renderCanvas();
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    expect(add).toBeTruthy();
    // Plain expect on the numbers/attributes — the jest-dom style matcher is
    // not registered in this project's vitest setup.
    expect(add.style.left).toBe("50%");
    expect(add.style.top).toBe("50%");
    // The label layer sits exactly on the routed edge's midpoint, and the "+"
    // is centred on it.
    const flow = toFlow(fixtureModel, parse(fixtureYaml));
    const edge = flow.edges[0]!;
    const { x: midX, y: midY } = routeEdge(edge.sourceBox!, edge.targetBox!, edge.axis);
    expect(add.parentElement!.style.left).toBe(`${midX}px`);
    expect(add.parentElement!.style.top).toBe(`${midY}px`);
  });

  it("attaches every step's handles to the top and bottom of the node", async () => {
    const { container } = renderCanvas();
    const check = container.querySelector<HTMLElement>("[data-testid='canvas-step-check']");
    expect(check).toBeTruthy();
    // The authoring canvas is ALWAYS top-to-bottom: the target handle rides
    // the node's top and the source handle its bottom, so a dragged step keeps
    // its bottom→top connection instead of wrapping around the sides.
    expect(check!.querySelector<HTMLElement>('[data-handlepos="top"]')).toBeTruthy();
    expect(check!.querySelector<HTMLElement>('[data-handlepos="bottom"]')).toBeTruthy();
  });

  it("keeps the edge's first segment vertical from the source bottom after a move", async () => {
    // A simulated drag: the target step moves BELOW the source, and the edge
    // must still leave the source's bottom and enter the target's top.
    const layout = { nodes: { check: { x: 320, y: 700 } } };
    const flow = toFlow(fixtureModel, parse(fixtureYaml), layout);
    const edge = flow.edges[0]!;
    const src = edge.sourceBox!;
    const tgt = edge.targetBox!;
    const firstSegment = `M ${src.x + src.width / 2} ${src.y + src.height} L ${src.x + src.width / 2} ${tgt.y}`;
    const { container } = renderCanvas({ layout });
    // Edge bodies render after the nodes measure (microtask) — wait for the
    // "+" to be present, which means the path layer is in the DOM.
    await screen.findByTestId("edge-add-plan-check");
    const pathEl = container.querySelector(".react-flow__edge-path");
    expect(pathEl).toBeTruthy();
    expect(pathEl!.getAttribute("d")).toContain(firstSegment);
  });

  it("deletes the selected step with the Backspace key", () => {
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDelete });
    fireEvent.keyDown(document, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(["check"]);
  });

  it("keeps the terminal plus sign on the terminal step via the add-after stub", async () => {
    renderCanvas();
    const addAfter = (await screen.findByTestId("add-after-check")) as HTMLElement;
    expect(addAfter).toBeTruthy();
    // The stub wrapper sits on the node's vertical axis (left-1/2) and the
    // "+" itself is centred on it.
    expect(addAfter.parentElement).toBeTruthy();
    expect(addAfter.parentElement!.className).toContain("left-1/2");
  });
});

describe("viewport fit guards (issue #2 blank canvas)", () => {
  const boxes = [
    { x: 0, y: 0, width: 200, height: 60 },
    { x: 240, y: 0, width: 200, height: 60 },
    { x: 120, y: 120, width: 200, height: 60 },
  ];

  it("fits a real graph into a real pane within the zoom band", () => {
    const vp = computeFitViewport(boxes, 1000, 600);
    expect(vp).not.toBeNull();
    const { x, y, zoom } = vp!;
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(zoom).toBeGreaterThanOrEqual(0.4);
    expect(zoom).toBeLessThanOrEqual(1.25);
  });

  it("refuses a zero-sized or sub-minimum pane (the 0×0 mid-run case)", () => {
    expect(computeFitViewport(boxes, 0, 600)).toBeNull();
    expect(computeFitViewport(boxes, 1000, 0)).toBeNull();
    expect(computeFitViewport(boxes, 1000, 47)).toBeNull();
    expect(computeFitViewport(boxes, -5, 600)).toBeNull();
  });

  it("refuses NaN / non-finite pane dimensions", () => {
    expect(computeFitViewport(boxes, Number.NaN, 600)).toBeNull();
    expect(computeFitViewport(boxes, 1000, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("refuses unmeasured (zero-area) or non-finite boxes instead of fitting wrong", () => {
    expect(computeFitViewport([{ x: 0, y: 0, width: 0, height: 0 }], 1000, 600)).toBeNull();
    expect(
      computeFitViewport([{ x: Number.NaN, y: 0, width: 20, height: 20 }], 1000, 600),
    ).toBeNull();
    expect(computeFitViewport([], 1000, 600)).toBeNull();
  });

  it("keeps the graph's centre on the pane's centre when it fits", () => {
    const vp = computeFitViewport(boxes, 1000, 600)!;
    const boundsW = 440; // 0..440
    const boundsH = 180; // 0..180
    const cx = 0 + boundsW / 2;
    const cy = 0 + boundsH / 2;
    const zoom = Math.min((1000 - 0.16 * 1000) / boundsW, (600 - 0.16 * 600) / boundsH);
    if (zoom >= 0.4 && zoom <= 1.25) {
      expect(vp.x + cx * vp.zoom).toBeCloseTo(500, 1);
      expect(vp.y + cy * vp.zoom).toBeCloseTo(300, 1);
    }
  });
});

describe("computeTopFitViewport (design 1g: top-aligned, never magnified)", () => {
  const boxes = [
    { x: 0, y: 0, width: 200, height: 52 },
    { x: 0, y: 114, width: 200, height: 52 },
    { x: 0, y: 228, width: 200, height: 52 },
  ];

  it("aligns the first box FIT_TOP_PAD_PX under the pane top and centres X", () => {
    const vp = computeTopFitViewport(boxes, 700, 900)!;
    expect(vp).not.toBeNull();
    expect(vp.zoom).toBeLessThanOrEqual(1);
    // The graph's top box (y=0) lands exactly FIT_TOP_PAD_PX under the pane.
    expect(vp.y).toBe(50);
    // The graph (x 0..200) centres in the 700px pane at its zoom.
    expect(vp.x + 100 * vp.zoom).toBeCloseTo(350, 6);
  });

  it("caps at zoom 1 — a tall chain overflows and pans instead of shrinking", () => {
    const vp = computeTopFitViewport(boxes, 700, 400)!;
    // Content 280px tall + padding fits in 400 → still exactly top-aligned
    // at full scale, no magnification.
    expect(vp.zoom).toBe(1);
    expect(vp.y).toBe(50);
  });

  it("refuses degenerate panes and boxes like the centred fit does", () => {
    expect(computeTopFitViewport(boxes, 0, 400)).toBeNull();
    expect(computeTopFitViewport([{ x: 0, y: 0, width: 0, height: 0 }], 700, 400)).toBeNull();
  });
});

describe("mirrorOwnedChanges (canvas owns the element set)", () => {
  it("swallows add/remove but keeps position/select/dimensions/replace", () => {
    const changes = [
      { id: "a", type: "select", selected: true },
      { id: "a", type: "position", position: { x: 1, y: 2 } },
      { id: "a", type: "dimensions", measured: { width: 5, height: 5 } },
      { id: "b", type: "remove" },
      { id: "c", type: "add", item: {}, index: 0 },
    ] as const;
    const kept = mirrorOwnedChanges(changes.map((c) => ({ ...c })));
    expect(kept.map((c) => c.type)).toEqual(["select", "position", "dimensions"]);
  });

  it("keeps an empty / all-removal batch empty", () => {
    expect(mirrorOwnedChanges([])).toEqual([]);
    expect(mirrorOwnedChanges([{ id: "a", type: "remove" }])).toEqual([]);
  });
});

describe("parseViewportTransform", () => {
  it("parses a finite rendered transform", () => {
    expect(parseViewportTransform("translate(69.3822px, 13.6008px) scale(1.1749)")).toEqual({
      x: 69.3822,
      y: 13.6008,
      zoom: 1.1749,
    });
  });

  it("returns null for a non-finite (NaN) or missing transform", () => {
    expect(parseViewportTransform("")).toBeNull();
    expect(parseViewportTransform(null)).toBeNull();
    expect(parseViewportTransform("translate(69px, 13px) scale(NaN)")).toBeNull();
    expect(parseViewportTransform("scale(1)")).toBeNull();
  });
});

describe("centerOnBox", () => {
  it("centres the box in the pane at the current zoom", () => {
    const vp = centerOnBox({ x: 100, y: 50, width: 100, height: 40 }, 1000, 600, 1);
    expect(vp).not.toBeNull();
    expect(vp!.x + (100 + 50) * vp!.zoom).toBeCloseTo(500, 1);
    expect(vp!.y + (50 + 20) * vp!.zoom).toBeCloseTo(300, 1);
  });

  it("refuses a zero pane and a non-finite box", () => {
    expect(centerOnBox({ x: 0, y: 0, width: 10, height: 10 }, 0, 600, 1)).toBeNull();
    expect(centerOnBox({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1000, 600, 1)).toBeNull();
  });
});

describe("evaluateConnect", () => {
  it("reports the refusal reason and does not proceed", () => {
    const canConnect: StudioCanvasProps["canConnect"] = () => ({
      ok: false,
      reason: "Cycle: check → plan → check",
    });
    expect(evaluateConnect(canConnect, "plan", "check")).toEqual({
      refused: "Cycle: check → plan → check",
      proceed: false,
    });
  });

  it("proceeds when canConnect is absent or approves", () => {
    expect(evaluateConnect(undefined, "a", "b")).toEqual({ refused: null, proceed: true });
    expect(evaluateConnect(() => ({ ok: true }), "a", "b")).toEqual({
      refused: null,
      proceed: true,
    });
  });
});
