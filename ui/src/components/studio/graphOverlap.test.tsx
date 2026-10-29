/**
 * Graph-overlap invariant: no two boxes the graph RENDERS may intersect
 * unless one lives inside the other (a scope group's own body).
 *
 * The design's graph never overlaps. Both canvas paths — the authoring
 * Studio (`toFlow`: 200×52 step boxes re-centred on the dagre boxes, scope
 * groups grown to contain them) and the workflow Overview page
 * (`GraphCanvas`: `stepCardBox` cards, scope rects grown the same way) —
 * derive their rendered boxes from `layoutDefinition`'s dense TB cut, but
 * the renderer's boxes are not the boxes dagre was fed: steps render at a
 * fixed 200×52 floor and scope boxes carry a title bar and foot added after
 * layout. When dagre spaces its OWN narrower boxes, the wider rendered boxes
 * collide — observed on the m4 seed (`review` and `test_evidence` in the
 * until body rendering 28px into each other, and the root scope
 * `build_until_verified` reaching over `emit_items` / `fan_out`).
 *
 * This test takes every fixture document the pages can render — both seed
 * documents of `docs/compatibility/probes/m4/pipeline.yaml`, the pi-proof
 * probe, the ui's sample/template fixtures — through the SAME path each page
 * renders, reads the boxes back out (DOM inline geometry for `GraphCanvas`,
 * absolute flow coordinates for `toFlow`), and fails on any intersection
 * between boxes that do not nest. A nested box must sit FULLY inside its
 * group — a scope border slicing through a step is the same defect mirrored.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { PIPELINE_TEMPLATES } from "../../lib/pipeline/templates";
import { fanOutPipelineDocument, samplePipelineYaml } from "../../test/fixtures/m4/samplePipeline";
import { GraphCanvas } from "../../pages/workflow/GraphCanvas";
import { canvasLayout, toFlow } from "./flowModel";

/**
 * `node:fs` / `node:path` are reached by a runtime-resolved dynamic import and
 * given local types: this project's tsconfig sets `types: ["vite/client"]`, so
 * `@types/node` is out of the program and no new dependency may be added here
 * (same convention as flowModel.test.ts / graphDoc.test.ts).
 */
declare const process: { cwd(): string };

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}

interface NodePath {
  resolve: (...parts: string[]) => string;
}

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
const piProofYaml = fsMod.readFileSync(
  pathMod.resolve(process.cwd(), "../docs/compatibility/probes/m4/pi-proof.yaml"),
  "utf8",
);

interface Fixture {
  name: string;
  /** The YAML text `parseGraph` reads (Studio canvas); absent for fixtures
   * that only exist as parsed documents. */
  yaml: string | null;
  document: DefinitionDocument;
}

function yamlFixture(name: string, yaml: string): Fixture {
  return { name, yaml, document: parseDocument(yaml).toJS() as DefinitionDocument };
}

/** The three `---`-delimited seed documents (agent variant, deterministic
 * twin, invoked child) — seed.sh posts each slice as its own pipeline. */
const fixtures: Fixture[] = [
  ...probeAll
    .split(/^---$/m)
    .filter((slice) => slice.includes("kind: Pipeline"))
    .map((slice, index) => yamlFixture(`m4/pipeline.yaml#doc${index + 1}`, slice)),
  yamlFixture("m4/pi-proof.yaml", piProofYaml),
  // The ui's own sample / template fixtures.
  yamlFixture("fixtures/samplePipeline", samplePipelineYaml),
  { name: "fixtures/fanOutPipeline", yaml: null, document: fanOutPipelineDocument },
  ...PIPELINE_TEMPLATES.filter((template) => template.id !== "blank").map((template) =>
    yamlFixture(`templates/${template.id}`, template.documentYaml),
  ),
];

/** Documents the canvas refuses (no parseable `spec.nodes`) render no boxes;
 * asserting "no overlap" over zero boxes would pass vacuously, so the suite
 * runs only over documents that DO lay out — and pins the set is not empty. */
const layingOut = fixtures.filter((fixture) => canvasLayout(fixture.document) !== null);

afterEach(cleanup);

interface Box {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Full `/scope/…/id`-style path — the containment algebra both canvases
   * share: a group's box owns the subtree under its path. */
  path: string;
  isGroup: boolean;
}

/** Half-pixel slack: the layout is sub-pixel exact and a shared edge is not a
 * collision; a real overlap (the measured defect was 28px wide) always trips. */
const EPS = 0.5;

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

/** Does scope path `ancestor` strictly enclose `descendant`? */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  return ancestor !== descendant && descendant.startsWith(`${ancestor}/`);
}

function describeBox(box: Box): string {
  return `${box.label} [${box.x.toFixed(1)},${box.y.toFixed(1)} ${box.width.toFixed(1)}x${box.height.toFixed(1)}]`;
}

/** The overlap invariant over a set of rendered boxes. */
function overlapViolations(boxes: Box[]): string[] {
  const violations: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!intersects(a, b)) continue;
      const aHoldsB = a.isGroup && isAncestorOf(a.path, b.path);
      const bHoldsA = b.isGroup && isAncestorOf(b.path, a.path);
      if (aHoldsB || bHoldsA) {
        const group = aHoldsB ? a : b;
        const member = aHoldsB ? b : a;
        if (!contains(group, member)) {
          violations.push(`${describeBox(group)} cuts ${describeBox(member)}`);
        }
        continue;
      }
      violations.push(`${describeBox(a)} overlaps ${describeBox(b)}`);
    }
  }
  return violations;
}

/** The `GraphCanvas` (workflow Overview page) rendered boxes, read from the
 * DOM the component itself writes: cards from their inline style, scope rects
 * from their SVG attributes. Rects match their layout keys by document order
 * (both come from the same `shown.groups` array the component maps). */
function workflowPageBoxes(document: DefinitionDocument): Box[] {
  const canvas = canvasLayout(document);
  if (!canvas) throw new Error("fixture should lay out");
  const { laid } = canvas;
  const { container } = render(<GraphCanvas document={document} label="overlap check" />);
  const boxes: Box[] = [];
  for (const node of laid.nodes) {
    const slug = node.key.replace(/^\//, "").replace(/\W+/g, "-");
    const el = container.querySelector<HTMLElement>(`[data-testid="workflow-graph-node-${slug}"]`);
    if (!el) throw new Error(`card for ${node.key} not rendered`);
    boxes.push({
      label: `card ${node.key}`,
      x: parseFloat(el.style.left || "0"),
      y: parseFloat(el.style.top || "0"),
      width: parseFloat(el.style.width || "0"),
      height: parseFloat(el.style.height || "0"),
      path: node.key.slice(1),
      isGroup: false,
    });
  }
  const rectEls = [
    ...container.querySelectorAll<SVGRectElement>("[data-testid^=workflow-graph-scope-]"),
  ];
  laid.groups.forEach((group, index) => {
    const el = rectEls[index];
    if (!el) throw new Error(`scope rect for ${group.key} not rendered`);
    boxes.push({
      label: `scope ${group.key}`,
      x: parseFloat(el.getAttribute("x") ?? "0"),
      y: parseFloat(el.getAttribute("y") ?? "0"),
      width: parseFloat(el.getAttribute("width") ?? "0"),
      height: parseFloat(el.getAttribute("height") ?? "0"),
      path: group.key.replace(/^#/, "").slice(1),
      isGroup: true,
    });
  });
  return boxes;
}

/** The Studio canvas (`toFlow`) rendered boxes in absolute flow coordinates:
 * a child's flow position is relative to its group, which the canvas adds
 * back at render time. */
function studioBoxes(fixture: Fixture): Box[] {
  if (fixture.yaml === null) return [];
  const parsed = parseGraph(fixture.yaml);
  if (!parsed.ok) throw new Error(`${fixture.name} should parse: ${parsed.error}`);
  const flow = toFlow(parsed.model, fixture.document);
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const abs = new Map<string, { x: number; y: number }>();
  const place = (id: string): { x: number; y: number } => {
    const known = abs.get(id);
    if (known) return known;
    const node = byId.get(id);
    if (!node) throw new Error(`flow node ${id} missing`);
    const parent = node.parentId ? place(node.parentId) : { x: 0, y: 0 };
    const at = { x: node.position.x + parent.x, y: node.position.y + parent.y };
    abs.set(id, at);
    return at;
  };
  const boxes: Box[] = [];
  for (const node of flow.nodes) {
    const at = place(node.id);
    const isGroup = node.type === "scope";
    // The box's full path — a scope's includes its own id (it owns the
    // subtree under that path), a card's is its scope plus its id.
    const path = [...node.data.scope, node.data.nodeId].join("/");
    boxes.push({
      label: `${isGroup ? "scope" : "card"} ${node.id}`,
      x: at.x,
      y: at.y,
      width: node.width,
      height: node.height,
      path,
      isGroup,
    });
  }
  return boxes;
}

describe("graph boxes never overlap (workflow Overview page)", () => {
  it("has fixtures that lay out (a vacuous pass here would hide the bug)", () => {
    expect(layingOut.length).toBeGreaterThanOrEqual(6);
  });

  for (const fixture of layingOut) {
    it(`${fixture.name}: no two rendered boxes intersect`, () => {
      expect(overlapViolations(workflowPageBoxes(fixture.document))).toEqual([]);
    });
  }
});

describe("graph boxes never overlap (Studio canvas)", () => {
  for (const fixture of layingOut) {
    if (fixture.yaml === null) continue;
    it(`${fixture.name}: no two rendered flow boxes intersect`, () => {
      expect(overlapViolations(studioBoxes(fixture))).toEqual([]);
    });
  }
});
