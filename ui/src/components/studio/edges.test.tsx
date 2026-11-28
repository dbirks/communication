/**
 * edges tests (issue #67): the edge “+” step picker must
 *   • hand the wheel to its own list (`nowheel`, plus `nopan nodrag` so a
 *     pointer-down inside the picker never drags or pans the graph) instead of
 *     zooming the canvas,
 *   • close on an outside pointerdown — without swallowing that gesture — and
 *     on Escape whether or not focus is inside the picker,
 *   • keep b266061's one-click-one-step rule: the picker's own “+” stays inert
 *     while the picker is open (no close-then-reopen, no second picker, and
 *     the “+”'s pointerdown is INSIDE the group so it never closes it first).
 * The picker lives inside the full canvas (its true React Flow host), so these
 * drive the real `StudioCanvas` the same way the canvas tests do.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { StudioCanvas, type StudioCanvasProps } from "./StudioCanvas";

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
  name: edges-test
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

/** Open the edge picker and return its “+” button. */
async function openEdgePicker() {
  renderCanvas();
  const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
  fireEvent.click(add);
  return { add, picker: screen.getByTestId("insert-step-menu") as HTMLElement };
}

/**
 * Review-1 09-1280-7: every edge “+” is a hover/focus affordance now, never
 * permanent ink. The circle paints only while its edge group is hovered or
 * holds (keyboard) focus; the 44px hit button stays in the DOM and tabbable
 * either way, and the open picker keeps the circle revealed.
 */
it("edge “+” circle is hidden until the edge group is hovered or focused", async () => {
  renderCanvas();
  const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
  const circle = add.querySelector("span") as HTMLElement;
  expect(circle.className).toContain("opacity-0");
  // Keyboard reachability: focus-within reveals it, and the button itself is
  // a real focus target with a visible ring.
  expect(circle.className).toContain("group-focus-within:opacity-100");
  expect(circle.className).toContain("group-hover:opacity-100");
  expect(add.className).toContain("focus-visible:ring-2");
  // With the picker open the circle must stay revealed even unhovered.
  fireEvent.click(add);
  const openCircle = (screen.getByTestId("edge-add-plan-check") as HTMLElement).querySelector(
    "span",
  ) as HTMLElement;
  expect(openCircle.className).toContain("opacity-100");
});

describe("edge “+” picker — wheel stays in the picker (#67)", () => {
  it("carries React Flow's nowheel/nopan/nodrag on the picker wrapper", async () => {
    const { picker } = await openEdgePicker();
    // The wrapper React Flow's own d3-zoom/drag filters test with
    // `event.target.closest('.nowheel' | '.nopan' | '.nodrag')`.
    const wrapper = picker.parentElement as HTMLElement;
    const classes = wrapper.className.split(/\s+/);
    expect(classes).toContain("nowheel");
    expect(classes).toContain("nopan");
    expect(classes).toContain("nodrag");
    // The z-bump b266061 needed (the picker above every neighbour “+”) stays.
    expect(classes).toContain("z-50");
  });

  it("keeps every row of the insert menu inside the nowheel/nopan/nodrag wrapper", async () => {
    const { picker } = await openEdgePicker();
    for (const row of Array.from(picker.querySelectorAll("[role='menuitem']"))) {
      expect(row.closest(".nowheel")).toBeTruthy();
      expect(row.closest(".nopan")).toBeTruthy();
      expect(row.closest(".nodrag")).toBeTruthy();
    }
  });
});

describe("edge “+” picker — dismissal (#67)", () => {
  it("closes on an outside pointerdown without swallowing it", async () => {
    await openEdgePicker();
    const outside = document.querySelector("[data-testid='studio-canvas']") as HTMLElement;
    // The dismiss must not eat the gesture: the same pointerdown keeps its
    // default behaviour (it reaches its real target — the canvas/pane).
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    fireEvent(outside, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("insert-step-menu")).toBeNull();
  });

  it("stays open on a pointerdown inside the picker", async () => {
    const { picker } = await openEdgePicker();
    fireEvent.pointerDown(picker.querySelector("[role='menuitem']") as HTMLElement);
    fireEvent.pointerDown(picker);
    expect(screen.getByTestId("insert-step-menu")).toBeTruthy();
  });

  it("closes on Escape when focus is NOT inside the picker", async () => {
    // The picker autofocuses its search input; the defect was every later
    // focus landing (the reader clicking around the canvas, tabbing away).
    // Escape is now a document-level contract while the picker is open: move
    // focus back to the “+” (outside the picker) and press it there.
    const { add } = await openEdgePicker();
    add.focus();
    expect(document.activeElement).toBe(add);
    fireEvent.keyDown(add, { key: "Escape" });
    expect(screen.queryByTestId("insert-step-menu")).toBeNull();
  });

  it("closes on Escape when focus IS inside the picker (a menu row)", async () => {
    const { picker } = await openEdgePicker();
    const search = picker.querySelector("[role='menuitem']") as HTMLElement;
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("insert-step-menu")).toBeNull();
  });

  it("keeps one-click-one-step: the “+” is inert and its pointerdown does not close its own picker", async () => {
    // b266061's rule survives the new click-away: the “+” lives INSIDE the
    // edge's group, so a pointerdown on it is not "outside" — the picker does
    // not flicker closed-and-reopened, and the click itself neither reopens a
    // second picker nor fires a second insert.
    const onInsertOnEdge = vi.fn();
    renderCanvas({ onInsertOnEdge });
    const add = (await screen.findByTestId("edge-add-plan-check")) as HTMLElement;
    fireEvent.click(add);
    expect(screen.getAllByTestId("insert-step-menu")).toHaveLength(1);
    fireEvent.pointerDown(add);
    expect(screen.getAllByTestId("insert-step-menu")).toHaveLength(1);
    fireEvent.click(add);
    expect(screen.getAllByTestId("insert-step-menu")).toHaveLength(1);
    expect(onInsertOnEdge).not.toHaveBeenCalled();
    // One card click → exactly one insert.
    fireEvent.click(screen.getByTestId("insert-step-process.exec"));
    expect(onInsertOnEdge).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("insert-step-menu")).toBeNull();
  });
});
