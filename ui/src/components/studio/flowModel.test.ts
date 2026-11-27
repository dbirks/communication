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
  clearLabelAnchor,
  nextNoteId,
  normalizeNotes,
  NOTE_DEFAULT_WIDTH,
  snapToNoteGrid,
  edgeLabelAnchor,
  flowId,
  nearestEdge,
  pointSegmentDistance,
  EDGE_ADD_TARGET_PX,
  labelBoxSize,
  routeEdge,
  routeLabel,
  toFlow,
  tidyLayout,
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
  it("carries a moved scope's body with it: children keep their offsets and edges follow", () => {
    const plain = toFlow(model, probeDocument);
    const scope = plain.nodes.find((n) => n.id === "build_until_verified")!;
    const moved = toFlow(model, probeDocument, {
      nodes: { build_until_verified: { x: scope.position.x + 300, y: scope.position.y - 40 } },
    });
    const movedScope = moved.nodes.find((n) => n.id === "build_until_verified")!;
    expect(movedScope.position).toEqual({ x: scope.position.x + 300, y: scope.position.y - 40 });
    for (const child of plain.nodes.filter((n) => n.parentId === "build_until_verified")) {
      const after = moved.nodes.find((n) => n.id === child.id)!;
      expect(after.position).toEqual(child.position);
    }
    // An edge between two body steps is routed from their moved boxes.
    const inner = plain.edges.find(
      (e) =>
        e.source.startsWith("build_until_verified/") &&
        e.target.startsWith("build_until_verified/"),
    )!;
    const innerMoved = moved.edges.find((e) => e.id === inner.id)!;
    const box = (e: typeof inner) =>
      (e as unknown as { sourceBox: { x: number; y: number } }).sourceBox;
    expect(box(innerMoved).x - box(inner).x).toBe(300);
    expect(box(innerMoved).y - box(inner).y).toBe(-40);
  });

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
    // The seed lists the body's steps in this order (its per-iteration
    // publisher is appended LAST so these pointers keep holding).
    const bodyIds = ["implement", "test", "review", "test_evidence"];
    for (const childId of bodyIds) {
      const child = node(`build_until_verified/${childId}`);
      expect(child.parentId).toBe("build_until_verified");
      expect(child.type).toBe("step");
      // The child's flow position plus the group's is the dagre absolute.
      const layoutNode =
        (abs.get(`/spec/nodes/2/config/body/nodes/${bodyIds.indexOf(childId)}`) as {
          x: number;
          y: number;
          width: number;
          height: number;
        }) ?? null;
      if (!layoutNode) throw new Error(`layout node for ${childId} not found`);
      // Design 1g: every step box is the fixed 200×52 rendered box, re-centred
      // on the dagre box — so the child's absolute position is the dagre
      // position shifted by half the size difference.
      expect(child.width).toBe(168);
      expect(child.height).toBe(56);
      const absoluteX = child.position.x + group.position.x;
      const absoluteY = child.position.y + group.position.y;
      expect(absoluteX).toBeCloseTo(layoutNode.x + (layoutNode.width - 168) / 2);
      expect(absoluteY).toBeCloseTo(layoutNode.y + (layoutNode.height - 56) / 2);
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
                items: "\${{ [] }}"
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

  it("labels a kind the runtime refuses with plain words, never a milestone", () => {
    const doc = `kind: Pipeline
spec:
  nodes:
    - id: start
      kind: process.exec
      config:
        executable: sh
        args: []
    - id: ship
      kind: git.commit
      dependsOn:
        - start
      config:
        message: "chore: shipped"
    - id: review
      kind: gate
      dependsOn:
        - ship
      config:
        reason: "release"`;
    const parsed = parseGraph(doc);
    if (!parsed.ok) throw new Error(`deferred-kind doc must parse: ${parsed.error}`);
    const flow = toFlow(parsed.model, parseDocument(doc).toJS());
    expect(flow.nodes.map((n) => n.id).sort()).toEqual(["review", "ship", "start"]);
    const words = (id: string): string | null =>
      flow.nodes.find((n) => n.id === id)?.data.deferred ?? null;
    // The refused steps say the plain thing; the runnable one says nothing.
    expect(words("ship")).toBe("not available yet");
    expect(words("review")).toBe("not available yet");
    expect(words("start")).toBeNull();
    // The internal milestone the data map carries reaches nobody: the chip only
    // ever holds these words.
    for (const n of flow.nodes) {
      expect(String(n.data.deferred ?? "")).not.toMatch(/\bM\d\b/);
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
    // Root scope: plan feeds approve AND the pre-gate publisher publish_plan
    // (which approve in turn waits on); verdict fans to both publish routes.
    expect(isTerminal("plan")).toBe(false); // approve + publish_plan depend on it
    expect(isTerminal("publish_plan")).toBe(false); // approve dependsOn [plan, publish_plan]
    expect(isTerminal("approve")).toBe(false); // build_until_verified + emit_items depend on it
    expect(isTerminal("build_until_verified/implement")).toBe(false); // test depends on it
    expect(isTerminal("build_until_verified/test")).toBe(false); // review + test_evidence depend on it
    expect(isTerminal("build_until_verified/review")).toBe(true); // body exit
    expect(isTerminal("build_until_verified/test_evidence")).toBe(true); // body exit too
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

describe("canvasLayout (authoring: always top-to-bottom)", () => {
  it("lays a linear template top-to-bottom", () => {
    const linear = `kind: Pipeline
spec:
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
    const parsed = parseGraph(linear);
    if (!parsed.ok) throw new Error(`linear fixture should parse: ${parsed.error}`);
    const doc = parseDocument(linear).toJS();
    const flow = toFlow(parsed.model, doc);
    expect(flow.nodes.length).toBe(2);
    // Always top-to-bottom: the dependency sits ABOVE the step that needs it.
    expect(flow.nodes[0]!.position.y).toBeLessThan(flow.nodes[1]!.position.y);
    expect(canvasLayout(doc)?.direction).toBe("TB");
    const lr = toFlow(parsed.model, doc, {}, { direction: "LR" });
    expect(lr.nodes[0]!.position.x).toBeLessThan(lr.nodes[1]!.position.x);
    const overrides = { nodes: { [parsed.model.nodes[0]!.id]: { x: 800, y: 400 } } };
    expect(toFlow(parsed.model, doc, overrides, { direction: "LR" }).nodes[0]!.position).toEqual({
      x: 800,
      y: 400,
    });
    expect(tidyLayout(overrides).nodes).toEqual({});
  });
});

describe("routeEdge", () => {
  it("routes a top-to-bottom edge bottom→top with a vertical first segment", () => {
    const src = { x: 100, y: 0, width: 100, height: 52 };
    const dst = { x: 100, y: 150, width: 100, height: 52 };
    const { path, x, y } = routeEdge(src, dst, "v");
    // Source bottom (150, 52) → target top (150, 150): vertical first segment.
    expect(path).toBe("M 150 52 C 150 101, 150 101, 150 150");
    expect(x).toBe(150);
    expect(y).toBe(101);
  });
});

describe('the route label\'s seat beside the "+"', () => {
  /**
   * A fan-out: two guarded routes off one step, so the two midpoints — and the
   * two "+" squares the canvas centres on them — sit side by side, closer
   * together than the longer route label is wide. The pass-1 overlap rule
   * (`e2e/emulator/reflow.ts`'s `findOverlaps`: no leaf text or control paints
   * over another by more than 4px on BOTH axes) measures the REAL 44px target,
   * so a label may not reach into one: not its own, and not its sibling's.
   */
  const fanoutYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: fanout-seat
  description: two guarded routes
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
      dependsOn:
        - plan
      when: nodes.plan.outputs.text == 'ok'
      config:
        executable: sh
        args: []
    - id: hold
      kind: process.exec
      dependsOn:
        - plan
      when: nodes.plan.outputs.text == 'needs attention'
      config:
        executable: sh
        args: []
`;

  it("seats every label clear of the " + " squares the canvas draws", () => {
    const parsed = parseGraph(fanoutYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const flow = toFlow(parsed.model, parseDocument(fanoutYaml).toJS(), {}, { addButtons: true });
    const labelled = flow.edges.filter((e) => e.labelX !== null && e.sourceBox && e.targetBox);
    expect(labelled.length).toBe(2);

    /** The 44px square `edges.tsx` centres on the edge's routed midpoint. */
    const addBox = (edge: (typeof flow.edges)[number]) => {
      const mid = routeEdge(edge.sourceBox!, edge.targetBox!, edge.axis);
      return {
        x: mid.x - EDGE_ADD_TARGET_PX / 2,
        y: mid.y - EDGE_ADD_TARGET_PX / 2,
        width: EDGE_ADD_TARGET_PX,
        height: EDGE_ADD_TARGET_PX,
      };
    };
    const boxes = flow.edges.filter((e) => e.sourceBox && e.targetBox).map(addBox);
    for (const edge of labelled) {
      const mid = routeEdge(edge.sourceBox!, edge.targetBox!, edge.axis);
      const size = labelBoxSize(String(edge.label));
      const cx = edge.labelX ?? mid.x;
      const cy = edge.labelY ?? mid.y;
      const pill = {
        x: cx - size.width / 2,
        y: cy - size.height / 2,
        width: size.width,
        height: size.height,
      };
      for (const box of boxes) {
        const dx = Math.min(pill.x + pill.width, box.x + box.width) - Math.max(pill.x, box.x);
        const dy = Math.min(pill.y + pill.height, box.y + box.height) - Math.max(pill.y, box.y);
        const paintsOver = dx > 0 && dy > 0;
        expect(
          paintsOver,
          `label "${String(edge.label)}" overlaps a "+" box by ${dx.toFixed(1)}x${dy.toFixed(1)}px`,
        ).toBe(false);
      }
    }
  });

  it("draws no seat offset on a canvas without " + " squares", () => {
    // The Run Workbench's read-only graph has no insert affordance, so nothing
    // owns the midpoint and a label whose path point clears the nodes keeps it.
    const parsed = parseGraph(fanoutYaml);
    if (!parsed.ok) throw new Error("fixture must parse");
    const flow = toFlow(parsed.model, parseDocument(fanoutYaml).toJS(), {}, { addButtons: false });
    const shifted = flow.edges.filter((e) => e.labelX !== null);
    for (const edge of shifted) {
      const mid = routeEdge(edge.sourceBox!, edge.targetBox!, edge.axis);
      expect([edge.labelX, edge.labelY]).toEqual([mid.x, mid.y]);
    }
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

describe("R5 flowModel LR + GoalFrame + Trigger", () => {
  it("lays out initial LR graph left-to-right, preserves saved positions, and tidyLayout resets to LR", () => {
    const seqYaml = `kind: Pipeline
spec:
  nodes:
    - id: first
      kind: agent.acp
    - id: second
      kind: process.exec
      dependsOn: [first]
`;
    const seqDoc = parseDocument(seqYaml).toJS();
    const seqParsed = parseGraph(seqYaml);
    if (!seqParsed.ok) throw new Error(seqParsed.error);
    const lr = toFlow(seqParsed.model, seqDoc, undefined, { direction: "LR" });
    const first = lr.nodes.find((n) => n.id === "first")!;
    const second = lr.nodes.find((n) => n.id === "second")!;
    expect(second.position.x).toBeGreaterThan(first.position.x);

    const saved = { nodes: { second: { x: 420, y: 180 } } };
    const withSaved = toFlow(seqParsed.model, seqDoc, saved, { direction: "LR" });
    expect(withSaved.nodes.find((n) => n.id === "second")?.position).toEqual({ x: 420, y: 180 });

    const tidied = toFlow(seqParsed.model, seqDoc, tidyLayout(saved), { direction: "LR" });
    const tFirst = tidied.nodes.find((n) => n.id === "first")!;
    const tSecond = tidied.nodes.find((n) => n.id === "second")!;
    expect(tSecond.position.x).toBeGreaterThan(tFirst.position.x);
  });

  it("attaches GoalSpec to recognized until scopes and adds synthetic TriggerNode when trigger is set", () => {
    const goalYaml = `kind: Pipeline
spec:
  nodes:
    - id: loop
      kind: until
      config:
        maxIterations: 4
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                prompt: 'Decide whether this goal is met: "Build succeeds". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
`;
    const goalDoc = parseDocument(goalYaml).toJS();
    const gParsed = parseGraph(goalYaml);
    if (!gParsed.ok) throw new Error(gParsed.error);
    const flow = toFlow(gParsed.model, goalDoc, undefined, {
      direction: "LR",
      trigger: { subline: "On every pull request" },
    });
    const loopNode = flow.nodes.find((n) => n.id === "loop");
    expect(loopNode?.data.goal).toEqual({
      kind: "judge",
      text: "Build succeeds",
      maxRounds: 4,
    });
    const trig = flow.nodes.find((n) => n.id === "__trigger__");
    expect(trig?.type).toBe("trigger");
    expect(trig?.data.triggerSubline).toBe("On every pull request");
    expect(flow.edges.some((e) => e.id === "__trigger__->loop")).toBe(true);

    // GoalFrame reserves >= 64px below its lowest child card so the terminal
    // "+" button (10px stub + 22px circle) and an 8px gap sit above the footer.
    const judge = flow.nodes.find((n) => n.id === "loop/judge")!;
    const childBottomRel = judge.position.y + (judge.height ?? 0);
    expect((loopNode?.height ?? 0) - childBottomRel).toBeGreaterThanOrEqual(64);
  });
});

describe("canvas notes (ui_layout.notes)", () => {
  it("normalizes the authored block: malformed rows drop, the grid and width clamp", () => {
    expect(
      normalizeNotes([
        // A note the canvas can draw: only the width is missing, and it has a
        // default; coordinates are off the grid and get snapped.
        { id: "note-1", x: 213, y: 137, text: "check with Ada" },
        // Too wide / too narrow for the design's range.
        { id: "note-2", x: 0, y: 0, width: 900, text: "" },
        { id: "note-3", x: 0, y: 0, width: 20, text: "" },
        // Not notes.
        { id: "note-4", x: 0, y: 0 },
        { id: "", x: 0, y: 0, text: "" },
        { id: 7, x: 0, y: 0, text: "" },
        null,
        ["note-5"],
        // A duplicate id would collide as a flow node id — the second one goes.
        { id: "note-1", x: 40, y: 40, text: "again" },
      ]),
    ).toEqual([
      { id: "note-1", x: 220, y: 140, width: NOTE_DEFAULT_WIDTH, text: "check with Ada" },
      { id: "note-2", x: 0, y: 0, width: 360, text: "" },
      { id: "note-3", x: 0, y: 0, width: 140, text: "" },
    ]);
    expect(normalizeNotes(undefined)).toEqual([]);
    expect(normalizeNotes({ nodes: {} })).toEqual([]);
    expect(snapToNoteGrid(-7)).toEqual(0);
  });

  it("ids never reuse a note the canvas already holds", () => {
    expect(nextNoteId([])).toBe("note-1");
    const held = normalizeNotes([
      { id: "note-1", x: 0, y: 0, text: "a" },
      { id: "note-3", x: 0, y: 0, text: "b" },
    ]);
    expect(nextNoteId(held)).toBe("note-2");
  });

  it("emits a note as its own node, never as a graph member", () => {
    const flow = toFlow(model, probeDocument, {
      nodes: { plan: { x: 400, y: 120 } },
      notes: [{ id: "note-1", x: 220, y: 140, width: 200, text: "a sticky" }],
    });
    const note = flow.nodes[flow.nodes.length - 1];
    expect(note.id).toBe("__note__:note-1");
    expect(note.type).toBe("note");
    expect(note.position).toEqual({ x: 220, y: 140 });
    expect(note.width).toBe(200);
    expect(note.parentId).toBeNull();
    // Its own lane: above the goal frames' fill (0), under the step cards.
    expect(note.zIndex).toBe(1);
    expect(flow.nodes.find((n) => n.id === "plan")?.position).toEqual({ x: 400, y: 120 });
    // A note is not a step: nothing in the graph references it.
    expect(flow.edges.some((e) => e.source === note.id || e.target === note.id)).toBe(false);
    expect(flow.nodes.filter((n) => n.type === "note")).toHaveLength(1);
  });

  it("a note never disturbs the layout of the steps", () => {
    const bare = toFlow(model, probeDocument);
    const withNote = toFlow(model, probeDocument, {
      notes: [{ id: "note-1", x: -1200, y: 900, width: 200, text: "far away" }],
    });
    const steps = (flow: typeof bare) =>
      flow.nodes
        .filter((n) => n.type !== "note")
        .map((n) => `${n.id}:${n.position.x},${n.position.y}`);
    expect(steps(withNote)).toEqual(steps(bare));
    expect(withNote.edges).toHaveLength(bare.edges.length);
  });
});

describe("the trigger node's centre line", () => {
  const triggerYaml = `kind: Pipeline
spec:
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
      config:
        executable: sh
        args: []
`;
  const triggerDoc = parseDocument(triggerYaml).toJS();
  const triggerGraph = parseGraph(triggerYaml);
  if (!triggerGraph.ok) throw new Error(triggerGraph.error);

  it("shares the first step's vertical centre in the editor's left-to-right cut", () => {
    const flow = toFlow(triggerGraph.model, triggerDoc, undefined, {
      direction: "LR",
      trigger: { subline: "when you start it" },
    });
    const trig = flow.nodes.find((n) => n.id === "__trigger__");
    const plan = flow.nodes.find((n) => n.id === "plan");
    expect(trig).toBeTruthy();
    expect(plan).toBeTruthy();
    // Review-1 rx-rv-editor-editor-1280: the trigger card sat ~8px high —
    // snapping its CENTRE coordinate to the 20px grid cannot land on a 56px
    // card's centre, which is always 28 (off-grid) past a grid corner.
    expect(trig!.position.y + trig!.height / 2).toBeCloseTo(plan!.position.y + plan!.height / 2, 6);
  });

  it("shares the first step's horizontal centre when the graph runs top to bottom", () => {
    const flow = toFlow(triggerGraph.model, triggerDoc, undefined, {
      direction: "TB",
      trigger: { subline: "when you start it" },
    });
    const trig = flow.nodes.find((n) => n.id === "__trigger__");
    const plan = flow.nodes.find((n) => n.id === "plan");
    expect(trig!.position.x + trig!.width / 2).toBeCloseTo(plan!.position.x + plan!.width / 2, 6);
    // The axis that places the card in the free lane still snaps to the grid.
    expect(Math.abs(trig!.position.y % 20)).toBe(0);
  });
});
