/**
 * flowModel tests: the probe fixture (docs/compatibility/probes/m4) is the
 * source of truth for shape — parent/child relative positions for the until
 * scope, ui_layout overrides, terminal detection, nearestEdge hits/misses.
 */
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseGraph, wrapInScope } from "../../lib/pipeline/graphDoc";
import {
  canvasLayout,
  canvasDirection,
  chooseCanvasOrientation,
  clearLabelAnchor,
  edgeLabelAnchor,
  flowId,
  nearestEdge,
  pointSegmentDistance,
  routeLabel,
  toFlow,
  type FlowNodeBase,
} from "./flowModel";

/**
 * `node:fs` / `node:path` are reached by a runtime-resolved dynamic import and
 * given local types: this project's tsconfig sets `types: ["vite/client"]`, so
 * `@types/node` is out of the program and no new dependency may be added here
 * (same convention as graphDoc.test.ts).
 */
declare const process: { cwd(): string };

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}

interface NodePath {
  resolve: (...parts: string[]) => string;
}

/** Resolved at runtime only — a literal specifier would be typechecked away. */
async function nodeFs(): Promise<NodeFs> {
  const specifier = "node:fs";
  return import(specifier) as unknown as NodeFs;
}

async function nodePath(): Promise<NodePath> {
  const specifier = "node:path";
  return import(specifier) as unknown as NodePath;
}

const [fsMod, pathMod] = await Promise.all([nodeFs(), nodePath()]);
// vitest runs with the `ui` directory as cwd; the probe lives at the repo root.
const probeAll = fsMod.readFileSync(
  pathMod.resolve(process.cwd(), "../docs/compatibility/probes/m4/pipeline.yaml"),
  "utf8",
);
// seed.sh posts one document per `---`-delimited slice; document 1 is first.
const probeYaml = probeAll.split(/^---$/m)[0];
const probeDocument = parseDocument(probeYaml).toJS();
const parsed = parseGraph(probeYaml);
if (!parsed.ok) throw new Error(`probe should parse: ${parsed.error}`);
const model = parsed.model;

function node(flowIdStr: string): FlowNodeBase {
  const found = toFlow(model, probeDocument).nodes.find((n) => n.id === flowIdStr);
  if (!found) throw new Error(`flow node ${flowIdStr} not found`);
  return found;
}

describe("flowId", () => {
  it("qualifies ids by their scope path", () => {
    expect(flowId([], "plan")).toBe("plan");
    expect(flowId(["build_until_verified"], "implement")).toBe("build_until_verified/implement");
  });
});

describe("toFlow", () => {
  it("renders the until scope as a scope group whose children are positioned relative to it", () => {
    const group = node("build_until_verified");
    expect(group.type).toBe("scope");
    expect(group.parentId).toBeNull();
    expect(group.data.emptyBody).toBe(false);
    expect(group.data.headerText).toBeTruthy();
    expect(group.data.headerText).toContain("build_until_verified");

    const laid = canvasLayout(probeDocument)?.laid ?? null;
    if (!laid) throw new Error("canvas layout for the probe document not found");
    const abs = new Map(laid.nodes.map((n) => [n.pointer, n]));
    for (const childId of ["implement", "test", "review"]) {
      const child = node(`build_until_verified/${childId}`);
      expect(child.parentId).toBe("build_until_verified");
      expect(child.type).toBe("step");
      // The child's flow position plus the group's is the dagre absolute.
      const layoutNode =
        (abs.get(
          `/spec/nodes/2/config/body/nodes/${["implement", "test", "review"].indexOf(childId)}`,
        ) as { x: number; y: number }) ?? null;
      if (!layoutNode) throw new Error(`layout node for ${childId} not found`);
      const absoluteX = child.position.x + group.position.x;
      const absoluteY = child.position.y + group.position.y;
      expect(absoluteX).toBeCloseTo(layoutNode.x);
      expect(absoluteY).toBeCloseTo(layoutNode.y);
    }
  });

  it("emits every scope group before the nodes that parent to it", () => {
    const flow = toFlow(model, probeDocument);
    const index = (id: string): number => {
      const i = flow.nodes.findIndex((n) => n.id === id);
      if (i < 0) throw new Error(`flow node ${id} not found`);
      return i;
    };
    expect(index("build_until_verified")).toBeLessThan(index("build_until_verified/implement"));
    expect(index("build_until_verified")).toBeLessThan(index("build_until_verified/review"));
    expect(index("fan_out")).toBeLessThan(index("fan_out/invoke"));
    // The general property: no node may precede its own parent group —
    // React Flow needs the parent in front of the child in the `nodes`
    // array or the child is dropped ("Parent node … not found") and the
    // canvas can blank out.
    for (const n of flow.nodes) {
      if (n.parentId === null) continue;
      expect(index(n.parentId)).toBeLessThan(index(n.id));
    }
  });

  it("keeps parents before children after wrapInScope nests a fresh scope", () => {
    const doc = `kind: Pipeline
spec:
  nodes:
    - id: start
      kind: process.exec
      config:
        executable: sh
        args: []
    - id: a
      kind: process.exec
      dependsOn:
        - start
      config:
        executable: sh
        args: []
    - id: b
      kind: process.exec
      dependsOn:
        - a
      config:
        executable: sh
        args: []
    - id: outer
      kind: until
      config:
        maxIterations: 3
        passWhen: "true"
        body:
          nodes:
            - id: inner
              kind: for_each
              config:
                items: \"\${{ [] }}\"
                body:
                  nodes:
                    - id: work
                      kind: process.exec
                      config:
                        executable: sh
                        args: []`;
    const wrapped = wrapInScope(doc, ["a", "b"], { kind: "until", id: "loop" });
    if (!wrapped.ok) throw new Error("wrap must succeed");
    const parsed = parseGraph(wrapped.text);
    if (!parsed.ok) throw new Error(`wrapped doc must parse: ${parsed.error}`);
    const flow = toFlow(parsed.model, parseDocument(wrapped.text).toJS());
    const index = (id: string): number => {
      const i = flow.nodes.findIndex((n) => n.id === id);
      if (i < 0) throw new Error(`flow node ${id} not found`);
      return i;
    };
    // The fresh scope precedes the steps just wrapped into it.
    expect(index("loop")).toBeLessThan(index("loop/a"));
    expect(index("loop/a")).toBeLessThan(index("loop/b"));
    // Pre-existing nested scopes keep the property at every depth.
    expect(index("outer")).toBeLessThan(index("outer/inner"));
    expect(index("outer/inner")).toBeLessThan(index("outer/inner/work"));
    for (const n of flow.nodes) {
      if (n.parentId === null) continue;
      expect(index(n.parentId)).toBeLessThan(index(n.id));
    }
  });

  it("lets ui_layout overrides replace the dagre positions", () => {
    const flow = toFlow(model, probeDocument, { nodes: { plan: { x: 500, y: 320 } } });
    const plan = flow.nodes.find((n) => n.id === "plan");
    expect(plan?.position).toEqual({ x: 500, y: 320 });
    // Un-overridden nodes keep their dagre positions.
    const baseline = toFlow(model, probeDocument);
    const verdict = flow.nodes.find((n) => n.id === "verdict");
    const baselineVerdict = baseline.nodes.find((n) => n.id === "verdict");
    expect(verdict?.position).toEqual(baselineVerdict?.position);
  });

  it("flags exactly the nodes with no dependents in their scope as terminal", () => {
    const flow = toFlow(model, probeDocument);
    const isTerminal = (id: string) => flow.nodes.find((n) => n.id === id)?.data.terminal;
    // Root scope: plan feeds approve; verdict fans to both publish routes.
    expect(isTerminal("plan")).toBe(false); // approve depends on it
    expect(isTerminal("approve")).toBe(false); // build_until_verified + emit_items depend on it
    expect(isTerminal("build_until_verified/implement")).toBe(false); // test depends on it
    expect(isTerminal("build_until_verified/review")).toBe(true); // body exit
    expect(isTerminal("verdict")).toBe(false); // both publish routes depend on it
    expect(isTerminal("publish_verified")).toBe(true);
    expect(isTerminal("publish_needs_attention")).toBe(true);
    // Scope nodes never carry the trailing "+".
    expect(isTerminal("build_until_verified")).toBe(false);
  });

  it("labels guarded edges with the short route value and error routes with 'on error'", () => {
    const flow = toFlow(model, probeDocument);
    const guarded = flow.edges.find(
      (e) => e.data.edge.from === "emit_items" && e.data.edge.to === "fan_out",
    );
    expect(guarded?.type).toBe("insertable");
    // The label carries the few words ("fanout"), the full expression the tooltip.
    expect(guarded?.label).toBe("fanout");
    expect(guarded?.labelTitle).toBe("inputs.fanout == true");
    const plain = flow.edges.find(
      (e) => e.data.edge.from === "plan" && e.data.edge.to === "approve",
    );
    expect(plain?.label).toBeNull();
    expect(plain?.labelTitle).toBeNull();
    // The probe declares no error routes; none may be invented.
    expect(flow.edges.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("reduces a guarded when expression to its route value", () => {
    expect(routeLabel("nodes.verdict.outputs.route == 'verified'")).toBe("verified");
    expect(routeLabel("inputs.fanout == true")).toBe("fanout");
    expect(routeLabel("nodes.a.state == 'ready' && inputs.gate == true")).toBe("ready");
    expect(routeLabel("nodes.x.done == true")).toBe("true");
    // An unreadable guard still renders something, not nothing.
    expect(routeLabel("1 + 1").length).toBeGreaterThan(0);
  });
});

describe("nearestEdge", () => {
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {
    a: { x: 0, y: 0, width: 100, height: 60 },
    b: { x: 200, y: 0, width: 100, height: 60 },
    c: { x: 0, y: 400, width: 100, height: 60 },
    d: { x: 0, y: 600, width: 100, height: 60 },
  };
  const edges = [
    { id: "a->b", from: "a", to: "b" },
    { id: "c->d", from: "c", to: "d" },
  ];

  it("hits a horizontal edge near its midpoint", () => {
    // a's right-centre (100, 30) → b's left-centre (200, 30).
    expect(nearestEdge(boxes, edges, { x: 150, y: 10 }, 24)?.edgeId).toBe("a->b");
  });

  it("hits a vertical edge near its midpoint", () => {
    // c's bottom-centre (50, 460) → d's top-centre (50, 600).
    expect(nearestEdge(boxes, edges, { x: 70, y: 530 }, 24)?.edgeId).toBe("c->d");
  });

  it("picks the nearer edge when two qualify", () => {
    expect(nearestEdge(boxes, edges, { x: 150, y: 20 }, 1000)?.edgeId).toBe("a->b");
  });

  it("misses when the pointer is farther than the radius", () => {
    expect(nearestEdge(boxes, edges, { x: 150, y: 100 }, 24)).toBeNull();
    expect(nearestEdge(boxes, edges, { x: 500, y: 500 }, 24)).toBeNull();
  });

  it("measures to the segment, not to the endpoints", () => {
    // 40px from the segment midpoint but 93px from either endpoint.
    expect(pointSegmentDistance({ x: 150, y: -40 }, { x: 100, y: 30 }, { x: 200, y: 30 })).toBe(70);
    expect(pointSegmentDistance({ x: 150, y: 100 }, { x: 100, y: 30 }, { x: 200, y: 30 })).toBe(70);
  });
});

describe("chooseCanvasOrientation", () => {
  const box = (width: number, height: number) =>
    ({ width, height, nodes: [], groups: [], edges: [] }) as never;

  it("picks TB when its box fits the canvas panes better than the wide LR one", () => {
    // The twin graph's two cuts, roughly: LR wide and squat, TB near square.
    expect(chooseCanvasOrientation({ LR: box(900, 300), TB: box(520, 520) })).toBe("TB");
  });

  it("stays left-to-right when the LR box already fits better", () => {
    expect(chooseCanvasOrientation({ LR: box(500, 400), TB: box(1400, 600) })).toBe("LR");
  });

  it("keeps LR on a tie", () => {
    expect(chooseCanvasOrientation({ LR: box(610, 1020), TB: box(610, 1020) })).toBe("LR");
  });
});

describe("toFlow direction", () => {
  it("carries the canvas layout's direction on every node", () => {
    const flow = toFlow(model, probeDocument);
    expect(flow.nodes.length).toBeGreaterThan(0);
    expect(flow.nodes.every((n) => n.data.direction === canvasDirection())).toBe(true);
  });
});

describe("clearLabelAnchor", () => {
  // Vertical edge: source box on top, target below, one rank gap between.
  const src = { x: 100, y: 0, width: 100, height: 60 };
  const dst = { x: 100, y: 150, width: 100, height: 60 };

  it("keeps the path midpoint when it is clear of every box", () => {
    // The pill is drawn at the smooth-step path's label point (edges.tsx
    // resolves it from the same handles); when that point clears every box
    // the anchor stays null and the edges keep the path midpoint.
    expect(clearLabelAnchor("verified", src, dst, [src, dst])).toBeNull();
  });

  it("shifts off a neighbour box sitting at the path label point", () => {
    // The `fanout` ∩ `fan_out` case: the S-curve's label point lands on a
    // neighbouring scope box, so the pill must slide along the edge line.
    const wall = { x: 90, y: 88, width: 120, height: 24 };
    const anchor = clearLabelAnchor("fanout", src, dst, [src, dst, wall]);
    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeCloseTo(150, 0); // still on the edge's vertical line
    const halfW = 50,
      halfH = 12; // ≥ the pill's half-size
    const overlaps = (box: typeof wall) =>
      anchor!.x - halfW < box.x + box.width &&
      box.x < anchor!.x + halfW &&
      anchor!.y - halfH < box.y + box.height &&
      box.y < anchor!.y + halfH;
    expect(overlaps(wall)).toBe(false);
    expect(overlaps(src)).toBe(false);
    expect(overlaps(dst)).toBe(false);
  });

  it("falls back to the path midpoint when no candidate clears", () => {
    const wall = { x: -500, y: -500, width: 1500, height: 1500 };
    expect(clearLabelAnchor("verified", src, dst, [src, dst, wall])).toBeNull();
  });

  it("publishes the shifted anchor for the renderer", () => {
    const flow = toFlow(model, probeDocument);
    const shifted = flow.edges.filter((e) => e.labelX !== null);
    for (const e of shifted) {
      expect(edgeLabelAnchor(e.id)).toEqual({ x: e.labelX, y: e.labelY });
    }
    // The twin draft's guarded edges need a shift in the dense top-to-bottom
    // cut (the regression this exists for).
    expect(shifted.length).toBeGreaterThan(0);
  });
});
