/**
 * StudioCanvas tests. React Flow in jsdom needs ResizeObserver and DOMMatrix
 * stubs; the canvas renders one focusable step per node, the edge "+" opens
 * the picker and calls onInsertOnEdge, readOnly strips the "+" affordances,
 * and a refused connect surfaces its reason without calling onConnect.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parse } from "yaml";
import { addNode, parseGraph, type OpResult } from "../../lib/pipeline/graphDoc";
import {
  centerOnBox,
  anchorWrapPanel,
  panToShowWrap,
  chooseFloatingPanelPlacement,
  chooseNodeMenuPlacement,
  clampViewportToGraph,
  computeEditorFitViewport,
  computeFitViewport,
  computeSelectionPaneRect,
  computeTopFitViewport,
  evaluateConnect,
  fitMinZoom,
  GOAL_FRAME_SAFE_PAD_PX,
  initialFitMinZoom,
  isBoxVisibleInPane,
  MENU_COMPACT_W_PX,
  mirrorOwnedChanges,
  moveDraggedNode,
  absoluteNodePosition,
  nodeGhostSize,
  snapDroppedPosition,
  parseViewportTransform,
  PHONE_VIEWPORT_PX,
  CANVAS_DOT_COLOR,
  CANVAS_DOT_DIAMETER_PX,
  CANVAS_DOT_GAP_PX,
  CANVAS_DOT_OFFSET_PX,
  canvasDotSizePx,
  FIT_EDGE_PAD_PX,
  FIT_LEFT_PAD_PX,
  FIT_TOP_PAD_PX,
  SMALL_WORKFLOW_OPEN_ZOOM,
  StudioCanvas,
  moveNote,
  newNote,
  type StudioCanvasProps,
} from "./StudioCanvas";
import { routeEdge, toFlow, type CanvasNote } from "./flowModel";
import { snapToGrid20 } from "./DragGhost";
import { EDGE_ADD_LABEL_OFFSET_PX, EDGE_ADD_TARGET_PX } from "./edges";
import { StudioInspector } from "./StudioInspector";

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

/** The same two steps with a GUARDED `plan→ship` route: the edge carries the
 * design's label pill, which must dodge the "+" target the same way. */
const guardedYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: studio-guarded
  description: one guarded route
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
    - id: ship
      kind: process.exec
      dependsOn: [plan]
      when: nodes.plan.outputs.text == 'ok'
      config:
        executable: sh
        args: []
`;

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

  it.each([
    ["agent.acp", "profile: reviewer", "Agent · reviewer"],
    ["process.exec", "executable: make", "Command · make"],
    ["human.approval", "approver: team", "Gate · team"],
  ])("renders tile, title and subline for %s", (kind, config, subline) => {
    const yaml = `kind: Pipeline\nspec:\n  nodes:\n    - id: task\n      kind: ${kind}\n      config:\n        ${config}\n`;
    const graph = parseGraph(yaml);
    if (!graph.ok) throw new Error(graph.error);
    renderCanvas({ model: graph.model, document: parse(yaml) });
    const node = screen.getByTestId("canvas-step-task");
    expect(node.textContent).toContain("task");
    expect(screen.getByTestId("canvas-step-fact-task").textContent?.toLowerCase()).toBe(
      subline.toLowerCase(),
    );
    expect(node.querySelector("svg")).toBeTruthy();
    expect(node.querySelector(".rounded-\\[8px\\]")).toBeTruthy();
  });

  it("snaps a node drag before passing its position to the draft", () => {
    const onMove = vi.fn();
    const dropped = { id: "plan", position: { x: 157, y: 143 }, data: { id: "plan" } };
    moveDraggedNode(dropped, [dropped], onMove);
    expect(onMove).toHaveBeenCalledWith("plan", { x: 160, y: 140 });
  });

  it("renders edges without arrow markers", async () => {
    const { container } = renderCanvas({ direction: "LR" });
    await screen.findByTestId("edge-add-plan-check");
    const paths = container.querySelectorAll(".react-flow__edge-path");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.getAttribute("marker-end")).toBeNull();
      expect(path.getAttribute("marker-start")).toBeNull();
    }
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

  it("inserts exactly one step per picker click: the open picker swallows the “+”, never a second insert", async () => {
    // The acceptance-33 defect: the 44px "+" hit square sat over the open
    // picker, so a click aimed at a kind card could hit the "+" instead. The
    // contract: one item click → exactly one onInsertOnEdge call, and the "+"
    // is inert (no reopen, no duplicate picker) while the picker is open.
    const onInsertOnEdge = vi.fn();
    renderCanvas({ onInsertOnEdge });
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    fireEvent.click(add);
    expect(screen.getAllByTestId("step-picker")).toHaveLength(1);
    // Re-clicking the "+" with its picker open changes nothing: still ONE
    // picker on the canvas, and no insert has happened yet.
    fireEvent.click(add);
    expect(screen.getAllByTestId("step-picker")).toHaveLength(1);
    expect(onInsertOnEdge).not.toHaveBeenCalled();
    // The single card click inserts exactly one step.
    fireEvent.click(screen.getByTestId("step-picker-item-process.exec"));
    expect(onInsertOnEdge).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("step-picker")).toBeNull();
  });

  it("stacks the open picker above the “+” hit square (jsdom has no paint order)", async () => {
    // jsdom implements neither layout nor `document.elementFromPoint`, so the
    // fix is asserted through the DOM contract the browser stacks by: the
    // picker renders AFTER its "+" button inside the group, carries its own
    // z-50, and the open group itself is z-raised above every other edge's
    // transform-stacked group (a neighbour's 44px square used to win the hit
    // test against the first kind card).
    renderCanvas();
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    const group = add.parentElement as HTMLElement;
    expect(group.className).not.toContain("z-50");
    fireEvent.click(add);
    const picker = screen.getByTestId("step-picker");
    const pickerWrap = picker.parentElement as HTMLElement;
    expect(pickerWrap.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(pickerWrap.className).toContain("z-50");
    expect(group.className).toContain("z-50");
    // The 44px target and the 22px circle stay exactly as designed.
    expect(add.className).toContain("h-[44px]");
    expect(add.querySelector("span[aria-hidden='true']")?.className).toContain("h-[22px]");
  });

  it("shows the trailing + only on terminal steps, and never in read-only mode", async () => {
    const { unmount } = renderCanvas();
    expect(screen.getByTestId("add-after-check")).toBeTruthy();
    expect(screen.queryByTestId("add-after-plan")).toBeNull();
    // An EDITABLE canvas draws the edge "+" — prove it before claiming its
    // absence elsewhere means anything (a run's canvas is the same component
    // with `readOnly`, and a missing-by-timing assertion proves nothing).
    await screen.findByTestId("edge-add-plan-check");

    unmount();
    const { container } = renderCanvas({ readOnly: true });
    await screen.findByTestId("canvas-step-check");
    // Edge bodies only paint once their nodes measure; wait for the layer.
    await waitFor(() => expect(container.querySelector(".react-flow__edge")).toBeTruthy());
    expect(screen.queryByTestId("add-after-check")).toBeNull();
    expect(screen.queryByTestId("edge-add-plan-check")).toBeNull();
  });

  it("says read-only on a run's canvas instead of the editor's wiring hint", async () => {
    const { unmount } = renderCanvas();
    expect(screen.getByTestId("canvas-caption").textContent).toContain("always top to bottom");
    unmount();
    renderCanvas({ readOnly: true });
    const caption = screen.getByTestId("canvas-caption");
    expect(caption.textContent).not.toContain("always top to bottom");
    expect(caption.textContent).toContain("read-only");
    // The zoom band is not an editor affordance — a run's graph pans and fits.
    expect(screen.getByTestId("canvas-controls")).toBeTruthy();
  });

  it("keeps a step's own text left-aligned, with the key fact truncated in the box", () => {
    renderCanvas();
    const card = document.querySelector<HTMLElement>(
      "[data-testid='canvas-step-plan'] [role='button']",
    );
    expect(card).toBeTruthy();
    // The app-shell phone band gives every `[role=button]` `align-items:
    // center`; inside a step card that centres the words AND lets the second
    // line grow past the box. The card opts out, so the text is left-aligned
    // at every width and the lines truncate.
    expect(card!.className).toContain("items-center");
    const fact = screen.getByTestId("canvas-step-fact-plan");
    expect(fact.parentElement!.className).toContain("min-w-0");
    expect(fact.className).toContain("truncate");
    // The full text (kind word + key fact) travels in the title, never cut off.
    expect(fact.getAttribute("title")).toBe(fact.textContent);
    expect(fact.getAttribute("title")).toContain("\u00b7 m");
  });

  it("draws each insert + as a fixed 22px circle on a 44px target", async () => {
    const { container } = renderCanvas();
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    // The phone band's 44px floor used to stretch the CIRCLE itself into a tall
    // pill (and the emulator measures the real box, so opting out is not an
    // option): target and ink are separate elements — 44px button, 22px circle.
    expect(add.className).toContain("h-[44px]");
    expect(add.className).toContain("w-[44px]");
    const circle = add.querySelector("span[aria-hidden='true']");
    expect(circle?.className).toContain("h-[22px]");
    expect(circle?.className).toContain("w-[22px]");
    expect(circle?.className).toContain("rounded-full");
    const after = (await screen.findByTestId("add-after-check")) as HTMLElement;
    expect(after.className).toContain("h-[44px]");
    // The terminal circle keeps its drawn size AND its seat on the stub: the
    // extra hit area falls into the empty band under the sink.
    const afterCircle = after.querySelector("span[aria-hidden='true']");
    expect(afterCircle?.className).toContain("h-[22px]");
    // Review-1 09-1280-7: the trailing “+” (and its stub) is a hover/focus
    // affordance too — hidden until the step or the “+” itself is hovered or
    // focused, never permanent ink.
    expect(afterCircle?.className).toContain("opacity-0");
    expect(afterCircle?.className).toContain("group-hover:opacity-100");
    expect(afterCircle?.className).toContain("group-focus-within:opacity-100");
    expect(container.querySelector("[data-testid='add-after-plan']")).toBeNull();
  });

  it("keeps the edge label copy outside the “+” target box", async () => {
    // The pass-1 overlap defect (`1g inspector-edit` at 1280:
    // `edge-add-survey-plan × span "insert step"`, 6×16px): the hover word
    // started 16px out from the line, i.e. INSIDE the invisible 44px target,
    // so the emulated cursor's `findOverlaps` measured the word painting over
    // its own button. jsdom lays nothing out and reports no rects, so the
    // invariant is asserted on the offsets the browser positions by: the
    // "+" is centred on the group origin, so any box that must sit beside it
    // starts at or past the target's edge, and a label pill that crosses the
    // target's band is anchored by its NEAR edge (`translate(0, -50%)`) so its
    // own width can never reach back over it.
    expect(EDGE_ADD_TARGET_PX).toBe(44);
    expect(EDGE_ADD_LABEL_OFFSET_PX).toBeGreaterThan(EDGE_ADD_TARGET_PX / 2);
    renderCanvas();
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    const hover = screen.getByTestId("edge-add-label-plan-check") as HTMLElement;
    // The word belongs to THIS button's group, and the box it must dodge is
    // the full 44px target (the 22px circle is only the ink inside it).
    expect(add.parentElement).toBe(hover.parentElement);
    expect(add.className).toContain("h-[44px]");
    // The design's word (1g): shown only on hover/focus, to the right, clear
    // of the target.
    expect(hover.textContent).toBe("insert step");
    expect(hover.className).toContain("opacity-0");
    expect(hover.className).toContain("group-hover:opacity-100");
    expect(parseFloat(hover.style.left)).toBe(EDGE_ADD_LABEL_OFFSET_PX);

    // A LABELED (guarded) edge has no hover word; its pill takes the same seat.
    const guardedModel = parseGraph(guardedYaml);
    expect(guardedModel.ok).toBe(true);
    if (!guardedModel.ok) return;
    renderCanvas({ model: guardedModel.model, document: parse(guardedYaml) });
    const guardedAdd = (await screen.findByTestId("edge-add-plan-ship")) as HTMLElement;
    const pill = guardedAdd.parentElement?.querySelector("span[title]") as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.style.transform).toBe("translate(-50%, -50%)");
    expect(parseFloat(pill.style.left)).toBeGreaterThan(EDGE_ADD_LABEL_OFFSET_PX / 2);
  });

  it("keeps the caption and the zoom/fit group in one flow band below the pane", () => {
    const { container } = renderCanvas();
    const caption = screen.getByTestId("canvas-caption");
    const controls = screen.getByTestId("canvas-controls");
    const pane = container.querySelector<HTMLElement>("[data-testid='studio-canvas'] > div");
    expect(pane).toBeTruthy();
    // React Flow clips its own viewport to the pane, so anything rendered in
    // there can be painted over by a node — the pass-6 defect was the bottom-
    // pinned caption across `publish_plan` and the floating − + fit group on
    // top of it. Both now live in a flow row AFTER the pane.
    expect(caption.closest(".react-flow")).toBeNull();
    expect(controls.closest(".react-flow")).toBeNull();
    expect(caption.parentElement).toBe(controls.parentElement);
    expect(caption.parentElement?.parentElement).toBe(pane?.parentElement);
    expect(pane!.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The caption is never `absolute`/`fixed` over the canvas any more.
    expect(caption.className).not.toMatch(/absolute|fixed/);
    expect(controls.className).not.toMatch(/absolute|fixed/);
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

  it("shows NO Duplicate/Delete menu for a plain selection — a left click only selects (#66)", () => {
    // Issue #66: the old contract opened the two-verb menu the moment a step
    // was selected. A left click is now select + inspector ONLY; the verbs
    // answer right-click, the ⋯ on the selected step, and the keyboard. The
    // click DOES select (React Flow's ring appears) — the menu simply no
    // longer follows it.
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderCanvas({ selectedId: "check", onDuplicate, onDelete, onSelect });
    // A selected step alone draws no menu…
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    // …and clicking a step only reports the selection.
    fireEvent.click(screen.getByLabelText("Run command / tests step check"));
    expect(onSelect).toHaveBeenCalledWith("check");
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    // Re-clicking the ALREADY-selected step (the old reopen path) still
    // shows nothing.
    fireEvent.click(screen.getByLabelText("Run command / tests step check"));
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    // Neither verb was reachable “for free” from those clicks.
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("opens Duplicate/Delete from the ⋯ on the selected step and wires the actions", () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDuplicate, onDelete });
    // The ⋯ rides the step React Flow has SELECTED (the ring the reader
    // sees): clicking `check` selects it; `plan` never carries a ⋯.
    fireEvent.click(screen.getByLabelText("Run command / tests step check"));
    expect(screen.queryByTestId("node-menu-button-plan")).toBeNull();
    const trigger = screen.getByTestId("node-menu-button-check");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    // Issue #66 place: the ⋯ is ABSOLUTE in the step's top-right corner, never
    // a flow child under the card (that bottom-left spot on the edge line is
    // what the pass-1 review caught). `.icon-hit` lives outside Tailwind's
    // utility layer and sets `position: relative`, so only the IMPORTANT
    // `absolute!` keeps the button out of flow — the regression this pins.
    const triggerClasses = trigger.className.split(/\s+/);
    expect(triggerClasses).toContain("icon-hit");
    expect(triggerClasses).toContain("absolute!");
    expect(triggerClasses).toContain("right-[2px]");
    expect(triggerClasses).toContain("top-[2px]");
    // The ⋯ opens the menu and does NOT re-trigger the step's selection.
    fireEvent.click(trigger);
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
    expect(screen.getByTestId("studio-node-menu-duplicate")).toBeTruthy();
    fireEvent.click(screen.getByTestId("studio-node-menu-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(["check"]);
    // The menu closed after the action; the ⋯ opens it again for the next one.
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("node-menu-button-check"));
    fireEvent.click(screen.getByTestId("studio-node-menu-duplicate"));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith("check");
  });

  it("keeps the selected step's ⋯ across a canvas remount (the 767px layout swap)", () => {
    // The 390 reflow defect: the Studio page swaps its whole layout branch at
    // the 767px phone rule, React Flow remounts, and the store's selection
    // dies with the old instance — while the PAGE still holds the selection
    // ("1 step selected", the open inspector). The reader has a phone: no
    // right-click, no Shift+F10. A canvas that mounts over an empty local node
    // set therefore adopts the page's selection, so the ⋯ survives the swap.
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const { unmount } = renderCanvas({ selectedId: "check", onDuplicate, onDelete });
    fireEvent.click(screen.getByLabelText("Run command / tests step check"));
    expect(screen.getByTestId("node-menu-button-check")).toBeTruthy();
    unmount();
    const second = renderCanvas({ selectedId: "check", onDuplicate, onDelete });
    // No re-click: the freshly mounted canvas already carries the ring's ⋯…
    const trigger = screen.getByTestId("node-menu-button-check");
    // …and it opens the same menu: Duplicate works for a phone-width reader.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("studio-node-menu-duplicate"));
    expect(onDuplicate).toHaveBeenCalledWith("check");
    // A canvas mounting with no page selection draws no ⋯ (nothing adopted).
    second.unmount();
    renderCanvas({ onDuplicate, onDelete });
    expect(screen.queryByTestId("node-menu-button-check")).toBeNull();
  });

  it("draws no ⋯ and opens no menu on an uneditable canvas", () => {
    // Right-click is the canvas's only menu gesture that needs no selection,
    // so the read-only/stale refusal is asserted through it (the ⋯ rides the
    // selection React Flow keeps).
    const { unmount } = renderCanvas({ selectedId: "check", readOnly: true });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    expect(screen.queryByTestId("node-menu-button-check")).toBeNull();
    unmount();
    renderCanvas({ selectedId: "check", stale: true });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
    expect(screen.queryByTestId("node-menu-button-check")).toBeNull();
  });

  it("opens the context menu on right-click and deletes from it", () => {
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDelete });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("studio-node-menu-delete"));
    expect(onDelete).toHaveBeenCalledWith(["check"]);
  });

  it("opens the context menu with Shift+F10 and the ContextMenu key (#66)", () => {
    // Keyboard/touch parity for the verbs that left the plain-click toolbar.
    const { unmount } = renderCanvas({ selectedId: "check" });
    fireEvent.keyDown(document, { key: "F10", shiftKey: true });
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("studio-node-menu"), { key: "Escape" });
    unmount();
    renderCanvas({ selectedId: "check" });
    fireEvent.keyDown(document, { key: "ContextMenu" });
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
  });

  it("opens the keyboard context menu for the FOCUSED step, not the selection", () => {
    const onDelete = vi.fn();
    renderCanvas({ selectedId: "check", onDelete });
    const plan = screen.getByLabelText("Ask a model step plan") as HTMLElement;
    plan.focus();
    fireEvent.keyDown(plan, { key: "ContextMenu" });
    // The menu speaks for the FOCUSED step: its Delete targets `plan`.
    fireEvent.click(screen.getByTestId("studio-node-menu-delete"));
    expect(onDelete).toHaveBeenCalledWith(["plan"]);
  });

  it("closes the context menu with Escape", () => {
    renderCanvas({ selectedId: "check" });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    const menu = screen.getByTestId("studio-node-menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("studio-node-menu")).toBeNull();
  });

  it("closes the context menu when the selection moves to another step", () => {
    const { rerender } = renderCanvas({ selectedId: "check", onSelect: vi.fn() });
    fireEvent.contextMenu(screen.getByTestId("canvas-step-check"));
    expect(screen.getByTestId("studio-node-menu")).toBeTruthy();
    // A left click elsewhere moved the selection — the menu belonged to
    // `check`, so it goes with it.
    rerender(
      <StudioCanvas
        model={fixtureModel}
        document={parse(fixtureYaml)}
        layout={{}}
        selectedId="plan"
        readOnly={false}
        stale={false}
        onSelect={vi.fn()}
      />,
    );
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
    // (and the 44px target it sits inside) is centred on it.
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
    const firstSegment = `M ${src.x + src.width / 2} ${src.y + src.height} C ${src.x + src.width / 2}`;
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

  it("gives the zoom controls a ≥30px hit box without growing the painted glyph (#68)", () => {
    // Issue #68 remainder: the − / + measured 29×27 at 1280 (the CSS box is
    // 28×26). The box moves to 30×30 and the shared `.icon-hit` utility keeps
    // the 30px floor; the painted glyphs keep their type.
    renderCanvas();
    for (const testid of ["canvas-zoom-in", "canvas-zoom-out"]) {
      const button = screen.getByTestId(testid) as HTMLElement;
      const classes = button.className.split(/\s+/);
      expect(classes).toContain("icon-hit");
      expect(classes).toContain("h-[30px]");
      expect(classes).toContain("w-[30px]");
      expect(classes).toContain("text-[13px]"); // the glyph is not magnified
    }
    const fit = screen.getByTestId("canvas-fit") as HTMLElement;
    expect(fit.className.split(/\s+/)).toContain("icon-hit");
    expect(fit.className.split(/\s+/)).toContain("h-[30px]");
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

/**
 * studio-a2 regression (acceptance 41, cbe4ee8): the SECOND “+” picker add
 * created no step. The live shape: after an add the new step is selected and
 * the reader edits it in the inspector (fill executable, blur), then opens
 * the next “+” — a pointer-down inside the unguarded picker started React
 * Flow's node-drag/pan gesture (XYDrag filters on `closest('.nodrag')`,
 * clickDistance 0), which swallowed the kind-card click (the failing run's
 * snapshot still showed the open picker) or landed it seconds late. This
 * harness is the Studio page in miniature — text as source of truth, the
 * real `addNode` op, selection of the changed step, the real inspector —
 * because the defect lives in the SEQUENCE add → edit → add, not in any one
 * component. The pickers the canvas hosts are mounted inside React Flow's
 * DOM, so the gesture guard is asserted exactly where the library reads it:
 * `closest('.nodrag' / '.nopan')` from the pointer's target.
 */
function DraftHarness() {
  const [text, setText] = useState(fixtureYaml);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const parsed = parseGraph(text);
  const doc = useMemo(() => parse(text), [text]);
  function apply(op: (t: string) => OpResult) {
    const result = op(text);
    if (!result.ok) return;
    setText(result.text);
    setSelectedId(result.changed[0] ?? null);
  }
  if (!parsed.ok) throw new Error(`the harness keeps the draft parseable: ${parsed.error}`);
  return (
    <>
      <StudioCanvas
        model={parsed.model}
        document={doc}
        layout={{}}
        selectedId={selectedId}
        readOnly={false}
        stale={false}
        onSelect={setSelectedId}
        onAddAfter={(afterId, scope, kind) =>
          apply((t) => addNode(t, { kind, scope, after: afterId }))
        }
      />
      <StudioInspector
        model={parsed.model}
        nodeId={selectedId}
        document={doc}
        text={text}
        readOnly={false}
        apply={apply}
      />
      <span data-testid="harness-yaml" hidden>
        {text}
      </span>
    </>
  );
}

describe("two consecutive picker adds across an inspector edit (studio-a2)", () => {
  afterEach(cleanup);

  it("the second “+” add inserts its step too: add → edit → add, one step each", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DraftHarness />
      </QueryClientProvider>,
    );

    // 1) First add on the terminal step's “+”: exactly one new step, and the
    // canvas answers with it selected (the page's runOp selects `changed[0]`).
    fireEvent.click(await screen.findByTestId("add-after-check"));
    fireEvent.click(screen.getByTestId("step-picker-item-process.exec"));
    await screen.findByTestId("canvas-step-process");

    // 2) The reader edits the fresh step in the inspector (fill + blur is a
    // commit), and it lands in the draft text.
    fireEvent.click(screen.getByTestId("canvas-step-process"));
    const exec = screen.getByTestId("insp-config-executable");
    fireEvent.change(exec, { target: { value: "echo" } });
    fireEvent.blur(exec);
    await waitFor(() =>
      expect(screen.getByTestId("harness-yaml").textContent).toContain("executable: echo"),
    );

    // 3) The second “+”: every pointer-down inside the picker must be off
    // limits for the node-drag / canvas-pan gestures XYDrag and the pane
    // install (a gesture started from the picker is how the real browser ate
    // this click). Asserted from the two targets a reader hits: the search
    // box and the kind card.
    fireEvent.click(screen.getByTestId("add-after-process"));
    const picker = screen.getByTestId("step-picker");
    for (const flowClass of ["nowheel", "nopan", "nodrag"]) {
      expect(picker.classList.contains(flowClass), `dialog carries ${flowClass}`).toBe(true);
    }
    for (const chrome of ["step-picker-search", "step-picker-item-process.exec"]) {
      expect(screen.getByTestId(chrome).closest(".nodrag"), `${chrome} in .nodrag`).toBeTruthy();
      expect(screen.getByTestId(chrome).closest(".nopan"), `${chrome} in .nopan`).toBeTruthy();
    }

    // 4) The pick lands: exactly ONE new step, named after the one before it.
    fireEvent.click(screen.getByTestId("step-picker-item-process.exec"));
    await screen.findByTestId("canvas-step-process_2");
    // The outline row spells the edge the picker promised: after `process`.
    expect(screen.getByTestId("canvas-step-row-process_2").textContent).toContain("after process");
    const yaml = screen.getByTestId("harness-yaml").textContent ?? "";
    expect(yaml).toContain("id: process_2");
    expect(yaml).toContain("executable: echo");
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
    expect(vp.y).toBe(FIT_TOP_PAD_PX);
    // The graph (x 0..200) centres in the 700px pane at its zoom.
    expect(vp.x + 100 * vp.zoom).toBeCloseTo(350, 6);
  });

  it("caps at zoom 1 — a tall chain overflows and pans instead of shrinking", () => {
    const vp = computeTopFitViewport(boxes, 700, 400)!;
    // Content 280px tall + padding fits in 400 → still exactly top-aligned
    // at full scale, no magnification.
    expect(vp.zoom).toBe(1);
    expect(vp.y).toBe(FIT_TOP_PAD_PX);
  });

  it("refuses degenerate panes and boxes like the centred fit does", () => {
    expect(computeTopFitViewport(boxes, 0, 400)).toBeNull();
    expect(computeTopFitViewport([{ x: 0, y: 0, width: 0, height: 0 }], 700, 400)).toBeNull();
  });

  it("keeps the phone fit at 1:1 — the 44px touch floor is CSS px, scaled by the transform", () => {
    // The 390 Studio: a chain TALLER than the 46vh pane. Desktop would shrink
    // it to fit (the observed ~0.86 — the exact scale that rendered the edge
    // “+”s at 38px); the phone fit takes `fitMinZoom(390)` = 1 and overflows
    // downward instead, which the 1g top-aligned fit is built to do.
    const phone = computeTopFitViewport(boxes, 374, 260, FIT_TOP_PAD_PX, fitMinZoom(390))!;
    expect(phone.zoom).toBe(1);
    expect(phone.y).toBe(FIT_TOP_PAD_PX); // still top-aligned, never centred
    // …and the same pane at desk width still shrinks to fit (1280 unchanged).
    const desk = computeTopFitViewport(boxes, 374, 260, FIT_TOP_PAD_PX, fitMinZoom(1280))!;
    expect(desk.zoom).toBeCloseTo(0.78, 2);
  });
});

describe("clampViewportToGraph (a resize never strands the graph)", () => {
  // The 1g chain: one 200×52 column, 376px tall.
  const chain = [
    { x: 0, y: 0, width: 200, height: 52 },
    { x: 0, y: 324, width: 200, height: 52 },
  ];

  it("pulls a graph that hangs past the pane back inside it", () => {
    // The Run Workbench at 390: the 1280 fit (x=204) applied to a pane that is
    // now 354 wide — the cards ran 50px past the pane's right edge.
    const out = clampViewportToGraph({ x: 204, y: 41, zoom: 1 }, chain, 354, 439)!;
    expect(out).not.toBeNull();
    expect(out.zoom).toBe(1); // the reader's zoom is never touched
    // The column's right edge is back inside the pane with the pad clear.
    expect(out.x + 200 * out.zoom).toBe(354 - FIT_EDGE_PAD_PX);
    expect(out.y).toBe(41); // already inside on Y: not moved
  });

  it("holds a graph LARGER than the pane so it still covers the pane", () => {
    const wide = [{ x: 0, y: 0, width: 900, height: 52 }];
    // Panned too far right: an empty gutter at the left edge.
    const out = clampViewportToGraph({ x: 400, y: 0, zoom: 1 }, wide, 354, 439)!;
    expect(out.x).toBe(FIT_EDGE_PAD_PX - 0); // left edge back at the pad
    // Panned too far left: an empty gutter at the right edge.
    const back = clampViewportToGraph({ x: -800, y: 0, zoom: 1 }, wide, 354, 439)!;
    expect(back.x).toBe(354 - FIT_EDGE_PAD_PX - 900);
  });

  it("leaves a fitted graph exactly where it is", () => {
    // A chain taller than the pane (the 1g phone fit overflows and pans): the
    // clamp has nothing to do — the top-aligned fit is the design.
    const tall = [
      { x: 0, y: 0, width: 200, height: 52 },
      { x: 0, y: 424, width: 200, height: 52 },
    ];
    const fitted = computeTopFitViewport(tall, 354, 439, FIT_TOP_PAD_PX, fitMinZoom(390))!;
    expect(clampViewportToGraph(fitted, tall, 354, 439)).toEqual(fitted);
  });

  it("refuses a missing viewport, an empty box list and a degenerate pane", () => {
    expect(clampViewportToGraph(null, chain, 354, 439)).toBeNull();
    expect(clampViewportToGraph({ x: 0, y: 0, zoom: NaN }, chain, 354, 439)).toBeNull();
    expect(clampViewportToGraph({ x: 0, y: 0, zoom: 1 }, [], 354, 439)).toBeNull();
    expect(
      clampViewportToGraph(
        { x: 0, y: 0, zoom: 1 },
        [{ x: 0, y: 0, width: 0, height: 0 }],
        354,
        439,
      ),
    ).toBeNull();
    expect(clampViewportToGraph({ x: 0, y: 0, zoom: 1 }, chain, 0, 439)).toBeNull();
    expect(clampViewportToGraph({ x: 0, y: 0, zoom: 1 }, chain, 354, 24)).toBeNull();
  });
});

describe("fitMinZoom (APP-SHELL-PHONE 44px floor under the fit transform)", () => {
  it("is 1 below the phone breakpoint, 0.4 at and above it", () => {
    expect(fitMinZoom(390)).toBe(1);
    expect(fitMinZoom(559)).toBe(1);
    expect(fitMinZoom(560)).toBe(0.4); // tokens.css is `width < 560px`
    expect(fitMinZoom(1280)).toBe(0.4);
  });

  it("is not the phone floor for a non-finite viewport (no window)", () => {
    expect(fitMinZoom(Number.NaN)).toBe(0.4);
    expect(fitMinZoom(Number.POSITIVE_INFINITY)).toBe(0.4);
  });

  it("is keyed to the VIEWPORT, not the pane — the 1280 canvas pane is ~530px wide", () => {
    // A pane-width test would have clamped the desktop canvas too and changed
    // 1280; `PHONE_VIEWPORT_PX` is the same split the CSS media query uses.
    expect(PHONE_VIEWPORT_PX).toBe(560);
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

describe("chooseNodeMenuPlacement (the selected step's menu never covers a step)", () => {
  const step = { x: 95, y: 100, w: 200, h: 52 };
  const menu = { w: 110, h: 58 };

  it("sits right of the node, vertically centred on it, when the slot is clear", () => {
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [],
      menu,
      pane: { w: 1000, h: 700 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(false);
    // issue #66 place: the popover is centred on the step's mid-line (58px
    // menu on a 52px step → 3px above the step's top), not hung off its top.
    expect(place).toMatchObject({ x: 303, y: 100 + 52 / 2 - 58 / 2 });
  });

  it("drops below the node when the right slot lands on another step", () => {
    const place = chooseNodeMenuPlacement({
      node: step,
      // A wider neighbour crowds the right slot out.
      others: [{ x: 300, y: 90, w: 120, h: 60 }],
      menu,
      pane: { w: 1000, h: 700 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(false);
    expect(place).toMatchObject({ x: 95, y: 160 });
  });

  it("OPENS UPWARD when the slot below is the next step (the 390 chain)", () => {
    // 390px: the pane fits one column of steps, so the slot right of the node
    // is off-pane and the slot below it is the next step. Pass-8 review,
    // defect 1: the answer used to be the one-row strip dropped directly under
    // the node, which printed across the connector edge and the next card and
    // hugged the pane's own border. The menu now turns around and opens upward
    // instead — still anchored to its step, over nothing but empty canvas.
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [{ x: 95, y: 160, w: 200, h: 52 }],
      menu,
      pane: { w: 390, h: 400 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(false);
    expect(place).toMatchObject({ x: 95, y: 100 - 8 - menu.h });
    expect(place.y + place.h).toBeLessThan(160); // never touches the next step
  });

  it("stays inside the pane for a node hugging its right and bottom edges", () => {
    // The pass-7 contract was “the one row is pulled back inside the pane”;
    // pass-8 keeps that promise with the full menu, opened upward on the
    // inside edge rather than hanging off the canvas' bottom-right corner.
    const place = chooseNodeMenuPlacement({
      node: { x: 250, y: 380, w: 200, h: 52 },
      others: [],
      menu,
      pane: { w: 390, h: 440 },
    });
    expect(place.docked).toBe(false);
    expect(place.x + place.w).toBeLessThanOrEqual(390 - 8);
    expect(place.y + place.h).toBeLessThanOrEqual(440 - 8);
    expect(place.y).toBeGreaterThanOrEqual(0);
  });

  it("slides the menu back beside its own step when the pane edge cuts the slot", () => {
    // No room above or below (a step in the middle of a dense chain), and the
    // design's right-hand slot hangs off the pane: the menu is clamped back
    // inside, still on its own step's row. The only card it can cover there is
    // the one it belongs to — never the neighbour, never the connector edge.
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [
        { x: 95, y: 30, w: 200, h: 52 },
        { x: 95, y: 160, w: 200, h: 52 },
      ],
      menu,
      pane: { w: 390, h: 400 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(false);
    // Vertically centred on the step's row (the design slot's y), not hung on
    // the step's top — the pass-8 promise, now with the popover centred.
    expect(place.y).toBe(100 + 52 / 2 - 58 / 2); // its own row, not a strip of its own
    expect(place.x + place.w).toBeLessThanOrEqual(390 - 8);
    for (const other of [
      { x: 95, y: 30, w: 200, h: 52 },
      { x: 95, y: 160, w: 200, h: 52 },
    ]) {
      const covers =
        place.x < other.x + other.w &&
        place.x + place.w > other.x &&
        place.y < other.y + other.h &&
        place.y + place.h > other.y;
      expect(covers, `menu at ${place.x},${place.y} paints over ${other.y}`).toBe(false);
    }
  });

  it("centres the ONE ROW in the measured gap when no full-menu slot is clear", () => {
    // Every full-menu slot is taken — the step above, the step below, the
    // pane's right edge and the neighbour in the right column — so the two
    // actions fall back to one row. It goes into the free air between the step
    // and its next sibling, centred in what is ACTUALLY clear (58px of gap for
    // a 52px row here), so it covers neither the card below nor nothing at all.
    const others = [
      { x: 95, y: 44, w: 200, h: 52 }, // above: 44..96
      { x: 95, y: 210, w: 200, h: 52 }, // below: 210..262, 58px of clear air
      { x: 300, y: 96, w: 40, h: 60 }, // the clamped side slot's column
    ];
    const place = chooseNodeMenuPlacement({
      node: step,
      others,
      menu,
      compact: { w: 153, h: 52 },
      pane: { w: 340, h: 400 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(true);
    expect(place).toMatchObject({ x: 95, y: 155 }); // 152 + (58-52)/2
    for (const other of others) {
      const covers =
        place.x < other.x + other.w &&
        place.x + place.w > other.x &&
        place.y < other.y + other.h &&
        place.y + place.h > other.y;
      expect(covers, `menu at ${place.x},${place.y} paints over ${other.y}`).toBe(false);
    }
  });

  it("keeps the last-resort ONE ROW anchored to its own step, never docked", () => {
    // A dense chain with no clear air at all: the actions still stay attached
    // to the step they act on (docking them to the pane's edge is what pass-7
    // review rejected), clamped inside the pane sideways and down.
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [
        { x: 95, y: 44, w: 200, h: 52 },
        { x: 95, y: 152, w: 200, h: 52 },
      ],
      menu,
      pane: { w: 390, h: 400 },
    });
    expect(place.docked).toBe(false);
    expect(place.compact).toBe(true);
    expect(place).toMatchObject({ x: 95, y: 160 });
    // Clamped: the row it paints is the row the math reserved, and the whole
    // thing stays inside a 390px pane.
    expect(place.w).toBe(MENU_COMPACT_W_PX);
    expect(place.x + MENU_COMPACT_W_PX).toBeLessThanOrEqual(390);
    expect(place.x + place.w).toBeLessThanOrEqual(390 - 8);
    expect(place.y + place.h).toBeLessThanOrEqual(400 - 8);
  });

  it("docks to its own strip only when the pane cannot hold the row at all", () => {
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [],
      menu,
      pane: { w: 390, h: 40 },
    });
    expect(place.docked).toBe(true);
    expect(place.compact).toBe(false);
  });

  it("keeps the plain right-hand position while the pane is unmeasured", () => {
    // jsdom / a canvas that has not laid out: a 0×0 pane says nothing about
    // where the menu fits, so it stays where the design puts it.
    const place = chooseNodeMenuPlacement({
      node: step,
      others: [{ x: 95, y: 160, w: 200, h: 52 }],
      menu,
      pane: { w: 0, h: 0 },
    });
    expect(place.docked).toBe(false);
    // The unmeasured pane says nothing, so the design slot keeps its x AND
    // its centred y (no clamping was possible).
    expect(place).toMatchObject({ x: 303, y: 100 + 52 / 2 - 58 / 2 });
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

describe("canvas tools", () => {
  it("switches tools with keys but ignores text fields and modifiers", () => {
    renderCanvas({ showToolIsland: true });
    fireEvent.keyDown(window, { key: "h" });
    expect(
      screen.getByRole("button", { name: "Move around (H)" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "b" });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(
      screen.getByRole("button", { name: "Move around (H)" }).getAttribute("aria-pressed"),
    ).toBe("true");
    input.remove();
    fireEvent.keyDown(window, { key: "b" });
    expect(
      screen.getByRole("button", { name: "Box select (B)" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("uses pane panning for move and selection dragging for box", () => {
    const { container } = renderCanvas({ showToolIsland: true });
    const pane = container.querySelector(".react-flow__pane")!;
    const node = container.querySelector(".react-flow__node")!;
    expect(pane.classList.contains("draggable")).toBe(true);
    expect(node.classList.contains("draggable")).toBe(true);
    fireEvent.keyDown(window, { key: "h" });
    expect(pane.classList.contains("draggable")).toBe(true);
    expect(node.classList.contains("draggable")).toBe(false);
    fireEvent.keyDown(window, { key: "b" });
    expect(pane.classList.contains("draggable")).toBe(false);
  });

  it("connects two clicked steps through validation and cancels with Escape", async () => {
    const onConnect = vi.fn();
    const canConnect = vi.fn(() => ({ ok: true as const }));
    renderCanvas({ showToolIsland: true, onConnect, canConnect });
    const plan = await screen.findByRole("button", { name: "Ask a model step plan" });
    const check = await screen.findByRole("button", { name: "Run command / tests step check" });
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.click(plan);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(check);
    expect(onConnect).not.toHaveBeenCalled();
    fireEvent.click(plan);
    expect(canConnect).toHaveBeenCalledWith("check", "plan");
    expect(onConnect).toHaveBeenCalledWith("check", "plan");
  });
});

describe("R5 editor canvas additions", () => {
  it("places floating panels 16px right of target and flips left near the right edge", () => {
    const right = chooseFloatingPanelPlacement(
      { x: 100, y: 120, width: 200, height: 100 },
      { w: 340, h: 300 },
      { w: 1200, h: 800 },
      16,
    );
    expect(right.side).toBe("right");
    expect(right.left).toBe(316);

    const flipped = chooseFloatingPanelPlacement(
      { x: 750, y: 120, width: 180, height: 100 },
      { w: 340, h: 300 },
      { w: 1000, h: 800 },
      16,
    );
    expect(flipped.side).toBe("left");
    expect(flipped.left).toBe(750 - 16 - 340);
  });

  it("computes selection bounding box with 14px padding under pan/zoom and renders MarchingAnts + WrapPanel", async () => {
    const rect = computeSelectionPaneRect(
      ["plan", "check"],
      [
        {
          id: "plan",
          position: { x: 40, y: 80 },
          data: { id: "plan" },
          measured: { width: 168, height: 56 },
        },
        {
          id: "check",
          position: { x: 260, y: 80 },
          data: { id: "check" },
          measured: { width: 168, height: 56 },
        },
      ] as Parameters<typeof computeSelectionPaneRect>[1],
      { x: 10, y: 20, zoom: 1.5 },
      14,
    );
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeCloseTo(40 * 1.5 + 10 - 14, 4);
    expect(rect!.y).toBeCloseTo(80 * 1.5 + 20 - 14, 4);
    expect(rect!.width).toBeCloseTo((260 + 168 - 40) * 1.5 + 28, 4);

    const onSelectionChange = vi.fn();
    renderCanvas({
      showToolIsland: true,
      selectedIds: ["plan", "check"],
      onSelectionChange,
      onWrapRepeat: vi.fn(),
      onWrapSideBySide: vi.fn(),
    });
    expect(await screen.findByTestId("marching-ants")).toBeTruthy();
    expect(screen.getByTestId("marching-ants-label").textContent).toBe("2 steps selected");
    expect(screen.getByTestId("wrap-panel")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("renders R5 step state colours across done, running, waiting, and failed states", async () => {
    const yaml = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
    - id: check
      kind: process.exec
      dependsOn: [plan]
    - id: gate
      kind: human.approval
      dependsOn: [check]
    - id: notify
      kind: notify
      dependsOn: [gate]
`;
    const parsed = parseGraph(yaml);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parse(yaml);
    const statusOverlay: Record<string, { state: string; label: string }> = {
      plan: { state: "succeeded", label: "done" },
      check: { state: "running", label: "running" },
      gate: { state: "waiting", label: "waiting" },
      notify: { state: "failed", label: "failed" },
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ width: 960, height: 640 }}>
          <StudioCanvas
            model={parsed.model}
            document={doc}
            layout={{}}
            selectedId={null}
            stale={false}
            onSelect={() => {}}
            readOnly
            statusOverlay={statusOverlay}
          />
        </div>
      </QueryClientProvider>,
    );

    expect((await screen.findByTestId("canvas-step-plan")).getAttribute("data-state-kind")).toBe(
      "done",
    );
    expect(screen.getByTestId("canvas-step-tile-plan").className).toContain("bg-st-done-tag");
    expect(screen.getByTestId("canvas-step-check").getAttribute("data-state-kind")).toBe("running");
    expect(
      screen.getByTestId("canvas-step-check").querySelector("[role='button']")?.className,
    ).toContain("border-st-running-strong");
    expect(screen.getByTestId("canvas-step-gate").getAttribute("data-state-kind")).toBe("waiting");
    expect(screen.getByTestId("canvas-step-notify").getAttribute("data-state-kind")).toBe("failed");
  });

  it("renders GoalFrame for recognized until scopes and quiet frame for non-goal scopes without back-edges", async () => {
    const goalDocText = `kind: Pipeline
spec:
  nodes:
    - id: build_loop
      kind: until
      config:
        maxIterations: 3
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                prompt: 'Decide whether this goal is met: "Tests pass". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
    - id: fan
      kind: for_each
      dependsOn: [build_loop]
      config:
        items: ["a"]
        body:
          nodes:
            - id: step_a
              kind: process.exec
`;
    const parsed = parseGraph(goalDocText);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parse(goalDocText);

    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ width: 960, height: 640 }}>
          <StudioCanvas
            model={parsed.model}
            document={doc}
            layout={{}}
            selectedId={null}
            stale={false}
            onSelect={() => {}}
            readOnly
            statusOverlay={{ build_loop: { state: "running", label: "running" } }}
            verdictsByScope={{
              build_loop: [{ n: 1, verdict: "not_yet", reason: "Lint failed." }],
            }}
          />
        </div>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("goal-frame")).toBeTruthy();
    expect(screen.getByTestId("goal-frame-text").textContent).toContain("Tests pass");
    // The bound keeps the footer's left; the loop's own state (glyph + word)
    // rides its right, so the frame never says "running" in colour alone.
    expect(screen.getByTestId("goal-frame-footer").firstElementChild?.textContent).toBe(
      "up to 3 rounds · then stop",
    );
    expect(screen.getByTestId("goal-frame-status").textContent).toBe("● running");
    expect(screen.getByTestId("goal-frame-ants")).toBeTruthy();
    expect(screen.getByTestId("verdict-stack")).toBeTruthy();
    expect(screen.getByTestId("verdict-round-1").textContent).toContain("Lint failed.");
    expect(screen.getByTestId("canvas-scope-fan").style.borderRadius).toBe("16px");
    expect(container.querySelector("[data-testid='canvas-recurrence-arrow']")).toBeNull();
  });

  // The run view's whole promise is that a reader can stand in front of the
  // canvas and read the run: every box says its state in a GLYPH AND A WORD
  // (identity rule 06 — never colour alone, and never motion alone either).
  // Three boxes that used to break it: a goal frame (which drew only its
  // animated outline), a step the run stopped (which drew a bullet, not the
  // interrupted set's ⊘, on a plain white card), and a step the run never
  // produced a row for (which said nothing at all).
  it("says the state of every box in a run view: goal frame, stopped step, un-produced step", async () => {
    const runDocText = `kind: Pipeline
spec:
  nodes:
    - id: build_loop
      kind: until
      config:
        maxIterations: 3
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                prompt: 'Decide whether this goal is met: "Tests pass". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
    - id: stopped_step
      kind: process.exec
      dependsOn: [build_loop]
      config:
        executable: sh
        args: []
    - id: untouched_step
      kind: process.exec
      dependsOn: [stopped_step]
      config:
        executable: sh
        args: []
`;
    const parsed = parseGraph(runDocText);
    if (!parsed.ok) throw new Error(parsed.error);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ width: 960, height: 640 }}>
          <StudioCanvas
            model={parsed.model}
            document={parse(runDocText)}
            layout={{}}
            selectedId={null}
            stale={false}
            onSelect={() => {}}
            readOnly
            statusOverlay={{
              build_loop: { state: "running", label: "iteration 2 of 3" },
              code: { state: "done", label: "done" },
              judge: { state: "running", label: "running" },
              stopped_step: { state: "interrupted", label: "stopped" },
              untouched_step: { state: "queued", label: "not started" },
            }}
          />
        </div>
      </QueryClientProvider>,
    );

    // The goal frame: its outline animates AND the header says the word.
    expect(await screen.findByTestId("goal-frame-ants")).toBeTruthy();
    const frameStatus = screen.getByTestId("goal-frame-status");
    expect(frameStatus.textContent).toBe("● iteration 2 of 3");
    expect(frameStatus.getAttribute("title")).toBe("● iteration 2 of 3");

    // A stopped step carries the interrupted set's ⊘ and its own pale card.
    const stopped = screen.getByTestId("canvas-step-stopped_step");
    expect(stopped.getAttribute("data-state-kind")).toBe("interrupted");
    expect(screen.getByTestId("step-status-stopped_step").textContent).toBe("⊘ stopped");
    // The card's role=button name OVERRIDES its text for a screen reader, so
    // the state word has to ride that name or the state is sighted-only.
    expect(stopped.querySelector("[role='button']")?.getAttribute("aria-label")).toBe(
      "Run command / tests step stopped_step · stopped",
    );

    // A step the run never reached is still a state the reader is told.
    expect(screen.getByTestId("step-status-untouched_step").textContent).toBe("· not started");
    expect(screen.getByTestId("step-status-code").textContent).toBe("✓ done");
  });

  it("draws the README dot grid inside the pane, at a constant on-screen size", () => {
    // Review-1 09-1280-4: React Flow's Background multiplies `size` by the
    // viewport zoom, so the ~0.86 fit rendered the dots sub-pixel and the
    // darkest canvas pixel sampled #FBFBFA. The canvas divides the zoom
    // back out: every dot renders 1.1 CSS px wide at any zoom.
    expect(canvasDotSizePx(1)).toBe(CANVAS_DOT_DIAMETER_PX);
    expect(canvasDotSizePx(0.5)).toBeCloseTo(4.4, 6);
    expect(canvasDotSizePx(0)).toBe(CANVAS_DOT_DIAMETER_PX); // never divides by zero
    expect(CANVAS_DOT_COLOR).toBe("#d6d2c8");
    expect(CANVAS_DOT_GAP_PX).toBe(20);
    expect(CANVAS_DOT_OFFSET_PX).toBe(10);

    const { container } = renderCanvas();
    const bg = container.querySelector(".react-flow__background");
    expect(bg).toBeTruthy();
    // jsdom mounts the pattern at zoom 1: the README's dot (the gradient
    // stop 1.1px is a RADIUS → a 2.2px-diameter dot, r = 1.1) on the 20px
    // grid — the geometry, actually painted.
    const dot = container.querySelector(".react-flow__background-pattern.dots");
    expect(dot?.getAttribute("r")).toBe(String(CANVAS_DOT_DIAMETER_PX / 2));
    const pattern = container.querySelector("pattern");
    expect(pattern?.getAttribute("width")).toBe(String(CANVAS_DOT_GAP_PX));
  });

  it("renders synthetic TriggerNode when trigger prop is set and invokes onClick", async () => {
    const onClick = vi.fn();
    renderCanvas({
      showToolIsland: true,
      trigger: { subline: "Every weekday at 9am", onClick },
    });
    const node = await screen.findByTestId("canvas-trigger-node");
    expect(node.textContent).toContain("Every weekday at 9am");
    const btn = node.querySelector("button")!;
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("opens a small workflow (<= 8 steps) at zoom 1.0 exactly, left- and top-aligned at 72px", () => {
    // Review-1 09-1280-5 / brief: a small workflow is NEVER zoomed out to
    // fit — 168x56 cards render at their designed size — and the first box
    // lands 72px from the pane's left and top edges (review-1 09-390-1: no
    // more centred mid-flow open). Larger workflows may zoom out.
    expect(initialFitMinZoom(1280, 4)).toBe(SMALL_WORKFLOW_OPEN_ZOOM);
    expect(initialFitMinZoom(1280, 8)).toBe(SMALL_WORKFLOW_OPEN_ZOOM);
    expect(initialFitMinZoom(390, 4)).toBe(1);
    expect(initialFitMinZoom(390, 12)).toBe(1); // phone floor stays 1

    // A 5-step line that a centred fit used to place mid-pane:
    const wide = Array.from({ length: 5 }, (_, i) => ({
      x: i * 204,
      y: 0,
      width: 168,
      height: 56,
    }));
    const vp = computeEditorFitViewport({
      boxes: wide,
      paneWidth: 1216,
      paneHeight: 700,
      viewportWidth: 1280,
      stepCount: 5,
    })!;
    expect(vp).not.toBeNull();
    expect(vp.zoom).toBe(1); // never zoomed out to fit
    expect(vp.x).toBe(FIT_LEFT_PAD_PX - 0); // first box at 72px from the left
    expect(vp.y).toBe(FIT_TOP_PAD_PX - 0); // …and 72px under the top

    // TALLER than the pane: still 1.0 — it overflows and pans, it does not
    // shrink (the old 0.75 clamp floor).
    const tallSmall = computeEditorFitViewport({
      boxes: [{ x: 0, y: 0, width: 200, height: 1200 }],
      paneWidth: 960,
      paneHeight: 600,
      viewportWidth: 1280,
      stepCount: 4,
    });
    expect(tallSmall).not.toBeNull();
    expect(tallSmall!.zoom).toBe(1);

    // A bigger workflow (9+ steps) may still zoom out to fit its pane.
    const big = computeEditorFitViewport({
      boxes: wide,
      paneWidth: 500,
      paneHeight: 600,
      viewportWidth: 1280,
      stepCount: 12,
    })!;
    expect(big.zoom).toBeLessThan(1);
    expect(big.x).toBe(FIT_LEFT_PAD_PX - 0); // …but the left anchor stays
  });

  it("leaves >= 72px top and left padding when a GoalFrame sits under top/left chrome", () => {
    const vp = computeEditorFitViewport({
      boxes: [{ x: 0, y: 0, width: 260, height: 220 }],
      goalBoxes: [{ x: 0, y: 0, width: 260, height: 220 }],
      paneWidth: 320,
      paneHeight: 400,
      viewportWidth: 1280,
      stepCount: 2,
    });
    expect(vp).not.toBeNull();
    expect(vp!.y).toBeGreaterThanOrEqual(GOAL_FRAME_SAFE_PAD_PX);
    expect(vp!.x).toBeGreaterThanOrEqual(GOAL_FRAME_SAFE_PAD_PX);

    expect(
      isBoxVisibleInPane(
        { x: 0, y: 0, width: 200, height: 150 },
        { x: 80, y: 80, zoom: 1 },
        960,
        640,
      ),
    ).toBe(true);
    expect(
      isBoxVisibleInPane(
        { x: 0, y: 0, width: 200, height: 150 },
        { x: 20, y: 20, zoom: 1 },
        960,
        640,
      ),
    ).toBe(false);
  });

  it("opens goal edit card on GoalFrame header click and invokes onOpenInspector from More settings", async () => {
    const goalDocText = `kind: Pipeline
spec:
  nodes:
    - id: until
      kind: until
      config:
        maxIterations: 3
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
              config:
                profile: worker
                prompt: Write code
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                profile: reviewer
                prompt: 'Decide whether this goal is met: "Tests pass". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
`;
    const parsed = parseGraph(goalDocText);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parse(goalDocText);
    const onOpenInspector = vi.fn();
    const onSelect = vi.fn();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ width: 960, height: 640 }}>
          <StudioCanvas
            model={parsed.model}
            document={doc}
            layout={{}}
            selectedId="until"
            readOnly={false}
            stale={false}
            onSelect={onSelect}
            onOpenInspector={onOpenInspector}
          />
        </div>
      </QueryClientProvider>,
    );

    const header = await screen.findByTestId("goal-frame-header");
    fireEvent.click(header);
    expect(await screen.findByTestId("goal-edit-anchor")).toBeTruthy();

    fireEvent.click(screen.getByTestId("goal-card-more-settings"));
    expect(onOpenInspector).toHaveBeenCalledWith("until");
    expect(screen.queryByTestId("goal-edit-anchor")).toBeNull();

    // Selected scope node also exposes its ⋯ button to open More settings from NodeMenu.
    fireEvent.click(screen.getByTestId("node-menu-button-until"));
    fireEvent.click(await screen.findByTestId("studio-node-menu-settings"));
    expect(onOpenInspector).toHaveBeenCalledTimes(2);
    expect(onOpenInspector).toHaveBeenLastCalledWith("until");
  });
});

/**
 * The Note tool (review-1 09-1280-1): the island's fifth row, a click that
 * puts a note on the canvas, and `ui_layout.notes` as the one place a note
 * lives — never the graph, never the executable document.
 *
 * `NotePlayground` is the Studio's own loop: the canvas is presentational, so
 * the note list has to be held by the caller and fed back in as `layout`.
 */
const noteFixture = { id: "note-1", x: 200, y: 100, width: 200, text: "check with Ada" };

function NotePlayground({
  notes: initial = [],
  onNotesChange,
}: {
  notes?: CanvasNote[];
  onNotesChange?: (notes: CanvasNote[]) => void;
}) {
  const [held, setHeld] = useState<CanvasNote[]>(initial);
  const write = (next: CanvasNote[]) => {
    onNotesChange?.(next);
    setHeld(next);
  };
  return (
    <div style={{ width: 960, height: 640 }}>
      <StudioCanvas
        model={fixtureModel}
        document={parse(fixtureYaml)}
        layout={{ nodes: {}, notes: held }}
        selectedId={null}
        readOnly={false}
        stale={false}
        onSelect={vi.fn()}
        showToolIsland
        onNotesChange={write}
      />
    </div>
  );
}

describe("canvas notes", () => {
  it("the N key picks the Note tool, as the island shows it", async () => {
    render(<NotePlayground />);
    await screen.findByTestId("canvas-step-check");
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByTestId("tool-note").getAttribute("aria-pressed")).toBe("true");
  });

  it("with the Note tool a click on empty canvas drops a snapped note and hands the tool back", async () => {
    const onNotesChange = vi.fn();
    render(<NotePlayground onNotesChange={onNotesChange} />);
    fireEvent.keyDown(window, { key: "n" });
    const pane = (await screen.findByTestId("canvas-step-check")).closest(".react-flow__pane");
    expect(pane).toBeTruthy();
    fireEvent.click(pane as HTMLElement, { clientX: 213, clientY: 137 });
    expect(onNotesChange).toHaveBeenCalledWith([
      { id: "note-1", x: 220, y: 140, width: 200, text: "" },
    ]);
    // The note is born typing, and the island is back on Select.
    const area = await screen.findByTestId("canvas-note-input-note-1");
    // The note is BORN typing: the click-then-type gesture needs the caret in
    // its text without a second click.
    await waitFor(() =>
      expect(globalThis.document.activeElement?.getAttribute("data-testid")).toBe(
        "canvas-note-input-note-1",
      ),
    );
    expect(screen.getByTestId("tool-note").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("Select (V)").getAttribute("aria-pressed")).toBe("true");
    // Click → type → leave: the words are the note, and they persist with it.
    fireEvent.change(area, { target: { value: "check with Ada before making live" } });
    fireEvent.blur(area);
    expect(onNotesChange).toHaveBeenLastCalledWith([
      { id: "note-1", x: 220, y: 140, width: 200, text: "check with Ada before making live" },
    ]);
  });

  it("typing into a note writes its text back through the note list", async () => {
    const onNotesChange = vi.fn();
    render(<NotePlayground notes={[noteFixture]} onNotesChange={onNotesChange} />);
    const card = await screen.findByTestId("canvas-note-note-1");
    expect(card.textContent).toContain("check with Ada");
    fireEvent.doubleClick(card);
    const area = await screen.findByTestId("canvas-note-input-note-1");
    fireEvent.change(area, { target: { value: "check with Ada before making live" } });
    fireEvent.blur(area);
    expect(onNotesChange).toHaveBeenCalledWith([
      { ...noteFixture, text: "check with Ada before making live" },
    ]);
    const saved = await screen.findByTestId("canvas-note-note-1");
    expect(saved.textContent).toContain("before making live");
  });

  it("an emptied note is removed, not kept as blank paper", async () => {
    const onNotesChange = vi.fn();
    render(<NotePlayground notes={[noteFixture]} onNotesChange={onNotesChange} />);
    const card = await screen.findByTestId("canvas-note-note-1");
    fireEvent.doubleClick(card);
    const area = await screen.findByTestId("canvas-note-input-note-1");
    fireEvent.change(area, { target: { value: "   " } });
    fireEvent.blur(area);
    expect(onNotesChange).toHaveBeenCalledWith([]);
    await waitFor(() => expect(screen.queryByTestId("canvas-note-note-1")).toBeNull());
  });

  it("Delete on a selected note removes the note, not the selected step", async () => {
    const onNotesChange = vi.fn();
    const onDelete = vi.fn();
    render(
      <div style={{ width: 960, height: 640 }}>
        <StudioCanvas
          model={fixtureModel}
          document={parse(fixtureYaml)}
          layout={{ notes: [noteFixture] }}
          selectedId="plan"
          readOnly={false}
          stale={false}
          onSelect={vi.fn()}
          onNotesChange={onNotesChange}
          onDelete={onDelete}
        />
      </div>,
    );
    fireEvent.click(await screen.findByTestId("canvas-note-note-1"));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onNotesChange).toHaveBeenCalledWith([]);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("a note drag stores the snapped position beside the note", () => {
    expect(moveNote([noteFixture], "note-1", { x: 337, y: 211 })).toEqual([
      { ...noteFixture, x: 340, y: 220 },
    ]);
    // A note id nobody holds leaves the list untouched.
    expect(moveNote([noteFixture], "note-9", { x: 1, y: 1 })).toEqual([noteFixture]);
  });

  it("a new note takes the first free id and lands on the grid", () => {
    expect(newNote({ x: 213, y: 137 }, [])).toEqual({
      id: "note-1",
      x: 220,
      y: 140,
      width: 200,
      text: "",
    });
    expect(newNote({ x: 0, y: 0 }, [{ ...noteFixture }]).id).toBe("note-2");
  });

  it("shows notes without a way to change them, read-only", async () => {
    const onNotesChange = vi.fn();
    renderCanvas({ layout: { notes: [noteFixture] }, readOnly: true, onNotesChange });
    const card = await screen.findByTestId("canvas-note-note-1");
    expect(card.textContent).toContain("check with Ada");
    fireEvent.doubleClick(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.queryByTestId("canvas-note-input-note-1")).toBeNull();
    expect(onNotesChange).not.toHaveBeenCalled();
  });

  it("keeps notes out of a box select — a note is never part of a wrap", async () => {
    render(<NotePlayground notes={[noteFixture]} />);
    const card = await screen.findByTestId("canvas-note-note-1");
    const noteWrapper = card.closest(".react-flow__node") as HTMLElement;
    const stepWrapper = (await screen.findByTestId("canvas-step-plan")).closest(
      ".react-flow__node",
    ) as HTMLElement;
    expect(stepWrapper.className).toContain("selectable");
    expect(noteWrapper.className).not.toContain("selectable");
  });
});

/* ------------------------------------ dragging a node (README §8, 5b) */

/** React Flow's drag is d3-drag: after a mousedown it listens on the event's
 * `view` (the window) for the moves and the release. jsdom rejects a Window
 * passed through the MouseEvent init dict ("member view is not of type
 * Window"), so the property is shadowed onto the event object instead — and
 * every step runs in `act` so React flushes the state the handlers set. */
function flowMouse(target: EventTarget, type: string, init: MouseEventInit) {
  act(() => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    });
    Object.defineProperty(event, "view", { get: () => window });
    target.dispatchEvent(event);
  });
}

function nodeWrapperOf(card: HTMLElement): HTMLElement {
  return card.closest(".react-flow__node") as HTMLElement;
}

/** `translate(280px, 240px)` → [280, 240]. */
function transformOf(wrapper: HTMLElement): [number, number] {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(wrapper.style.transform);
  expect(m).toBeTruthy();
  return [Number(m![1]), Number(m![2])];
}

describe("dragging a step (5b)", () => {
  it("follows the pointer freely, shows its snap target, lands on the grid", async () => {
    const onMove = vi.fn();
    const { container } = renderCanvas({ layout: { nodes: { plan: { x: 200, y: 200 } } }, onMove });
    const card = await screen.findByTestId("canvas-step-plan");
    const wrapper = nodeWrapperOf(card);
    expect(transformOf(wrapper)).toEqual([200, 200]);

    flowMouse(wrapper, "mousedown", { clientX: 300, clientY: 300 });
    for (const [x, y] of [
      [320, 310],
      [345, 325],
      [375, 340],
    ]) {
      flowMouse(window, "mousemove", { clientX: x, clientY: y });
    }

    const portal = container.querySelector(".react-flow__viewport-portal") as HTMLElement;
    const target = portal.querySelector('[data-testid="drag-snap-target"]') as HTMLElement;
    const hatch = portal.querySelector('[data-testid="drag-hatch"]') as HTMLElement;
    // Free drag: the card sits where the pointer left it, OFF the 20px grid,
    // while the dashed target marks the grid point it will drop into and the
    // hatch rides 6px down-right of the card.
    const [freeX, freeY] = transformOf(wrapper);
    expect(freeX).toBeGreaterThan(200);
    expect(freeX % 20 !== 0 || freeY % 20 !== 0).toBe(true);
    const [snapX, snapY] = [snapToGrid20(freeX), snapToGrid20(freeY)];
    expect(snapX % 20).toBe(0);
    expect(target.style.left).toBe(`${snapX}px`);
    expect(target.style.top).toBe(`${snapY}px`);
    expect(hatch.style.left).toBe(`${freeX + 6}px`);
    expect(hatch.style.top).toBe(`${freeY + 6}px`);
    expect(wrapper.className).toContain("dragging");

    flowMouse(window, "mouseup", { clientX: 375, clientY: 340 });
    expect(onMove).toHaveBeenCalledWith("plan", { x: snapX, y: snapY });
    // The card is corrected to the snapped position even though the draft
    // never moved (the page's `layout` prop is unchanged here), and the ghost
    // is gone.
    expect(transformOf(wrapper)).toEqual([snapX, snapY]);
    expect(container.querySelector('[data-testid="drag-snap-target"]')).toBeNull();
    expect(container.querySelector('[data-testid="drag-hatch"]')).toBeNull();
  });

  it("a press that moves less than 4px is a click, not a drag", async () => {
    const onMove = vi.fn();
    const { container } = renderCanvas({
      layout: { nodes: { plan: { x: 200, y: 200 } } },
      onMove,
    });
    const card = await screen.findByTestId("canvas-step-plan");
    const wrapper = nodeWrapperOf(card);
    flowMouse(wrapper, "mousedown", { clientX: 300, clientY: 300 });
    flowMouse(window, "mousemove", { clientX: 302, clientY: 301 });
    expect(container.querySelector('[data-testid="drag-hatch"]')).toBeNull();
    flowMouse(window, "mouseup", { clientX: 302, clientY: 301 });
    expect(onMove).not.toHaveBeenCalled();
    expect(wrapper.className).not.toContain("dragging");
    expect(transformOf(wrapper)).toEqual([200, 200]);
  });

  it("writes the snapped position when a note is dropped", async () => {
    const onNotesChange = vi.fn();
    render(<NotePlayground notes={[noteFixture]} onNotesChange={onNotesChange} />);
    const card = await screen.findByTestId("canvas-note-note-1");
    const wrapper = nodeWrapperOf(card);
    flowMouse(wrapper, "mousedown", { clientX: 400, clientY: 400 });
    for (const [x, y] of [
      [430, 415],
      [460, 430],
      [475, 440],
    ]) {
      flowMouse(window, "mousemove", { clientX: x, clientY: y });
    }
    flowMouse(window, "mouseup", { clientX: 475, clientY: 440 });
    expect(onNotesChange).toHaveBeenCalledTimes(1);
    const [moved] = onNotesChange.mock.calls[0][0] as [CanvasNote];
    expect(moved.id).toBe("note-1");
    expect(moved.text).toBe(noteFixture.text);
    // Down-right of where it started, and on the grid.
    expect(moved.x).toBeGreaterThan(noteFixture.x);
    expect(moved.y).toBeGreaterThan(noteFixture.y);
    expect(moved.x % 20).toBe(0);
    expect(moved.y % 20).toBe(0);
  });

  it("keeps the goal frame's own drag snapping on drop", async () => {
    // Scope frames get no ghost, but the drop still lands on the grid.
    expect(
      snapDroppedPosition({ id: "frame", type: "scope", position: { x: 213, y: 137 } }, []),
    ).toEqual({ x: 220, y: 140 });
  });
});

describe("drag drop geometry", () => {
  it("adds a child's position to its frame's", () => {
    const frame = { id: "g1", type: "scope", position: { x: 13, y: 7 }, data: {} };
    const child = {
      id: "n1",
      type: "step",
      parentId: "g1",
      position: { x: 105, y: 35 },
      data: {},
    };
    expect(absoluteNodePosition(child, [frame, child])).toEqual({ x: 118, y: 42 });
    // The grid is the ABSOLUTE one, so the relative number is whatever puts
    // the card on 120/40 inside the off-grid frame.
    expect(snapDroppedPosition(child, [frame, child])).toEqual({ x: 107, y: 33 });
    expect(absoluteNodePosition({ ...child, parentId: "missing" }, [frame, child])).toEqual({
      x: 105,
      y: 35,
    });
  });

  it("clamps a drop above the origin", () => {
    expect(snapDroppedPosition({ id: "p", position: { x: 157, y: -8 } }, [])).toEqual({
      x: 160,
      y: 0,
    });
  });

  it("sizes the ghost from the measured box, with the designed fallback", () => {
    expect(
      nodeGhostSize({
        id: "s",
        type: "step",
        position: { x: 0, y: 0 },
        data: {},
        measured: { width: 168, height: 56 },
      }),
    ).toEqual({ width: 168, height: 56 });
    expect(nodeGhostSize({ id: "s", type: "step", position: { x: 0, y: 0 }, data: {} })).toEqual({
      width: 168,
      height: 56,
    });
    expect(
      nodeGhostSize({
        id: "n",
        type: "note",
        position: { x: 0, y: 0 },
        data: {},
        style: { width: 240 },
      }),
    ).toEqual({ width: 240, height: 56 });
  });
});

describe("the wrap panel is anchored to the selection (README section 8)", () => {
  const box = { x: 300, y: 200, width: 200, height: 100 };

  it("sits 18px right of the box, on its vertical middle", () => {
    expect(anchorWrapPanel(box, { w: 1200, h: 700 })).toEqual({
      left: 518,
      top: 250,
      side: "right",
    });
  });

  it("flips to the left only when the right has no room and the left does", () => {
    const far = { x: 800, y: 200, width: 200, height: 100 };
    expect(anchorWrapPanel(far, { w: 1200, h: 700 })).toEqual({
      left: 442,
      top: 250,
      side: "left",
    });
    const wide = { x: 100, y: 200, width: 900, height: 100 };
    // Too wide for either side: the panel stays inside the pane.
    expect(anchorWrapPanel(wide, { w: 1200, h: 700 })).toEqual({
      left: 852,
      top: 250,
      side: "right",
    });
  });

  it("asks for no pan when box and panel already fit", () => {
    expect(
      panToShowWrap({ x: 300, y: 300, width: 200, height: 100 }, { w: 1200, h: 800 }),
    ).toBeNull();
  });

  it("pans left for a panel past the right edge and down for one under the top chrome", () => {
    const move = panToShowWrap({ x: 700, y: 100, width: 300, height: 80 }, { w: 1200, h: 800 });
    // right edge of the panel: 700 + 300 + 18 + 340 = 1358 → 1184; top: 140 - 210 = -70 → 72
    expect(move).toEqual({ dx: -174, dy: 142 });
  });
});
