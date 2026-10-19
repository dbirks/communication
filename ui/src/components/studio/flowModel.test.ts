/**
 * flowModel tests: the probe fixture (docs/compatibility/probes/m4) is the
 * source of truth for shape — parent/child relative positions for the until
 * scope, ui_layout overrides, terminal detection, nearestEdge hits/misses.
 */
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { layoutDefinition } from "../../lib/pipeline/layout";
import { flowId, nearestEdge, pointSegmentDistance, toFlow, type FlowNodeBase } from "./flowModel";

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

    const laid = layoutDefinition(probeDocument as never);
    const abs = new Map(
      (laid as { nodes: { pointer: string; x: number; y: number }[] }).nodes.map((n) => [
        n.pointer,
        n,
      ]),
    );
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

  it("labels guarded edges with the short when text and error routes with 'on error'", () => {
    const flow = toFlow(model, probeDocument);
    const guarded = flow.edges.find(
      (e) => e.data.edge.from === "emit_items" && e.data.edge.to === "fan_out",
    );
    expect(guarded?.type).toBe("insertable");
    expect(guarded?.label).toBe("inputs.fanout == true");
    const plain = flow.edges.find(
      (e) => e.data.edge.from === "plan" && e.data.edge.to === "approve",
    );
    expect(plain?.label).toBeNull();
    // The probe declares no error routes; none may be invented.
    expect(flow.edges.filter((e) => e.type === "error")).toHaveLength(0);
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
