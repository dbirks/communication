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
import { evaluateConnect, StudioCanvas, type StudioCanvasProps } from "./StudioCanvas";

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
    // The accessible list names the dependency.
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
