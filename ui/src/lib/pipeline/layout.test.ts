import { describe, expect, it } from "vitest";
import {
  GROUP_GAP,
  layoutDefinition,
  separateSiblingGroups,
  type GraphGroupView,
  type GraphNodeView,
} from "./layout";
import { nodeBindings, rootWords, scopeBody, scopeEntryNodes, scopeExitNodes } from "./definition";
import {
  fanOutPipelineDocument,
  samplePipelineDocument,
} from "../../test/fixtures/m4/samplePipeline";
import type { DefinitionDocument } from "./definition";

describe("layoutDefinition", () => {
  const layout = layoutDefinition(samplePipelineDocument)!;

  it("lays out the § 9.3 sample as 6 concrete nodes inside one scope group", () => {
    expect(layout).not.toBeNull();
    // The `until` node is a group, not a box: implement/test/review sit in it.
    expect(layout.nodes.map((node) => node.key)).toEqual([
      "/plan",
      "/approve",
      "/build_until_verified/implement",
      "/build_until_verified/test",
      "/build_until_verified/review",
      "/verdict",
      "/publish_verified",
      "/publish_needs_attention",
    ]);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]).toMatchObject({ ownerId: "build_until_verified", kind: "until" });
  });

  it("puts the group box around its members, not over them", () => {
    const group = layout.groups[0];
    const members = layout.nodes.filter((node) => node.groupKey === group.key);
    expect(members).toHaveLength(3);
    for (const member of members) {
      expect(member.x).toBeGreaterThanOrEqual(group.x);
      expect(member.y).toBeGreaterThanOrEqual(group.y);
      expect(member.x + member.width).toBeLessThanOrEqual(group.x + group.width);
      expect(member.y + member.height).toBeLessThanOrEqual(group.y + group.height);
    }
    // The bar has its own space above the first member.
    expect(group.y).toBeLessThan(Math.min(...members.map((member) => member.y)));
  });

  it("wires a scope dependency to the body's entry and exit, never to the group", () => {
    // approve → until scope means approve → implement (the only entry).
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "/approve", to: "/build_until_verified/implement" }),
    );
    // the scope → verdict leaves from review, the body's only exit.
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "/build_until_verified/review", to: "/verdict" }),
    );
    expect(layout.edges.some((edge) => edge.from.startsWith("#") || edge.to.startsWith("#"))).toBe(
      false,
    );
  });

  it("wires the edges inside a scope body, not just the ones crossing it", () => {
    const keys = layout.edges.map((edge) => `${edge.from}→${edge.to}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "/plan→/approve",
        "/approve→/build_until_verified/implement",
        "/build_until_verified/implement→/build_until_verified/test",
        "/build_until_verified/test→/build_until_verified/review",
        "/build_until_verified/review→/verdict",
        "/verdict→/publish_verified",
        "/verdict→/publish_needs_attention",
      ]),
    );
    // Seven edges for seven dependencies: nothing is invented and nothing is lost.
    expect(layout.edges).toHaveLength(7);
  });

  it("keeps every node inside the reported canvas", () => {
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("is deterministic — the same document never reflows", () => {
    const again = layoutDefinition(samplePipelineDocument)!;
    expect(again.nodes.map((node) => [node.key, node.x, node.y])).toEqual(
      layout.nodes.map((node) => [node.key, node.x, node.y]),
    );
  });

  it("carries bindings and the deferred milestone on each node", () => {
    const implement = layout.nodes.find((node) => node.id === "implement")!;
    expect(implement.kind).toBe("agent.acp");
    expect(implement.bindings.map((binding) => binding.slot)).toEqual(
      expect.arrayContaining(["config.workspace.repositories.0", "config.prompt"]),
    );
    expect(implement.pointer).toBe("/spec/nodes/2/config/body/nodes/0");

    const publish = layout.nodes.find((node) => node.id === "publish_verified")!;
    expect(publish.when).toBe("nodes.verdict.outputs.route == 'verified'");
    expect(publish.deferredTo).toBeNull();
  });

  it("says what a scope repeats, and which box is a gate", () => {
    const group = layout.groups[0];
    // The bar reads in the few words the design uses, and the annotation under
    // the children says what repeats — never a shape alone.
    expect(group.word).toBe("until");
    expect(group.boundLabel).toBe("max 4");
    expect(group.loopNote).toContain("until passWhen holds");
    const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
    expect(byKey.get("/approve")?.gate).toBe(true);
    expect(byKey.get("/approve")?.word).toBe("gate");
    expect(byKey.get("/plan")?.word).toBe("agent");
    expect(byKey.get("/verdict")?.gate).toBe(false);
  });

  it("keeps an empty-bodied scope visible as a node instead of an empty box", () => {
    const fanOut = layoutDefinition(fanOutPipelineDocument)!;
    expect(fanOut.groups).toHaveLength(0);
    expect(fanOut.nodes.map((node) => node.id)).toEqual(["inventory", "verify_each", "collect"]);
    expect(fanOut.edges.map((edge) => `${edge.from}→${edge.to}`)).toEqual([
      "/inventory→/verify_each",
      "/verify_each→/collect",
    ]);
    expect(fanOut.nodes[1].boundLabel).toBe("≤3 parallel");
  });

  it("refuses a document with no readable nodes", () => {
    expect(layoutDefinition({ apiVersion: "x", kind: "Pipeline", spec: { nodes: [] } })).toBeNull();
  });

  it("draws an error route as one dashed edge, never as every edge out of the node", () => {
    // `a` both gates `b` and routes its failure to `recover`. Two edges leave
    // `a`, and only the route is an error edge: painting the plain dependency
    // dashed-and-red would tell a reader `b` is a failure branch, which the
    // document does not say (contract § 10 D6 keeps this a readiness exception).
    const doc = {
      apiVersion: "communication.dev/v1alpha1",
      kind: "Pipeline",
      spec: {
        nodes: [
          { id: "a", kind: "agent.acp", onFailure: { action: "route", errorRoute: "recover" } },
          { id: "b", kind: "process.exec", dependsOn: ["a"] },
          { id: "recover", kind: "artifact.publish", when: "nodes.a.status == 'failed'" },
        ],
      },
    } as unknown as DefinitionDocument;
    const routed = layoutDefinition(doc)!;
    expect(routed.edges).toContainEqual(
      expect.objectContaining({ from: "/a", to: "/recover", kind: "error" }),
    );
    expect(routed.edges).toContainEqual(
      expect.objectContaining({ from: "/a", to: "/b", kind: "depends" }),
    );
  });

  it("leaves a scope through its body's exits when it routes a failure", () => {
    // The error source is a composite: its own key names a group, and dagre has
    // no box to leave from, so the route must start at a concrete node or the
    // edge silently disappears from the canvas.
    const doc = {
      apiVersion: "communication.dev/v1alpha1",
      kind: "Pipeline",
      spec: {
        nodes: [
          {
            id: "loop",
            kind: "until",
            onFailure: { action: "route", errorRoute: "recover" },
            config: {
              maxIterations: 2,
              body: { nodes: [{ id: "work", kind: "agent.acp" }] },
            },
          },
          { id: "recover", kind: "artifact.publish" },
        ],
      },
    } as unknown as DefinitionDocument;
    const routed = layoutDefinition(doc)!;
    expect(routed.edges).toContainEqual(
      expect.objectContaining({ from: "/loop/work", to: "/recover", kind: "error" }),
    );
    // Nothing is addressed to a group id, and no phantom node entered the graph.
    expect(
      routed.edges.every((edge) => !edge.from.startsWith("#") && !edge.to.startsWith("#")),
    ).toBe(true);
    expect(routed.nodes.map((node) => node.key)).toEqual(["/loop/work", "/recover"]);
  });
});

describe("definition model", () => {
  const until = samplePipelineDocument.spec.nodes[2];

  it("reads the until body and its entry/exit", () => {
    const body = scopeBody(until);
    expect(body.map((node) => node.id)).toEqual(["implement", "test", "review"]);
    expect(scopeEntryNodes(body).map((node) => node.id)).toEqual(["implement"]);
    expect(scopeExitNodes(body).map((node) => node.id)).toEqual(["review"]);
  });

  it("separates a written interpolation from a bare expression slot", () => {
    const bindings = nodeBindings(until);
    const passWhen = bindings.find((binding) => binding.slot === "config.passWhen");
    expect(passWhen).toMatchObject({ position: "expression" });
    const summary = nodeBindings(samplePipelineDocument.spec.nodes[1]).find(
      (binding) => binding.slot === "config.summary",
    );
    expect(summary).toMatchObject({ position: "interpolation", expression: "inputs.goal" });
  });

  it("names the roots an expression refers to, and not the words inside its strings", () => {
    expect(rootWords("nodes.build_until_verified.outputs.approved == true")).toEqual(["nodes"]);
    expect(rootWords("inputs.goal")).toEqual(["inputs"]);
    expect(
      rootWords(
        "has(previous.review_feedback) ? previous.review_feedback : '(first iteration: none)'",
      ),
    ).toEqual(["previous"]);
    expect(rootWords("${item.name} and ${items[0]}")).toEqual(["items", "item"]);
    expect(rootWords("'just prose about runs and nodes'")).toEqual(["no declared root"]);
  });

  it("does not turn the nested body into bindings of its parent", () => {
    const slots = nodeBindings(until).map((binding) => binding.slot);
    expect(slots.some((slot) => slot.startsWith("config.body"))).toBe(false);
  });
});

describe("sibling scope boxes", () => {
  /** The shape the live `feature-development` revision has: two scopes entered
   * from the same gate, one a short vertical chain, one a wider loop body. Its
   * children land in different ranks, so dagre's `nodesep` spaces the children
   * and leaves the bar and the foot of one box over the other. */
  const twoScopes = {
    apiVersion: "communication.dev/v1alpha1",
    kind: "Pipeline",
    metadata: { name: "two-scopes" },
    spec: {
      nodes: [
        { id: "plan", kind: "process.exec", config: { executable: "ls" } },
        {
          id: "approve",
          kind: "human.approval",
          dependsOn: ["plan"],
          config: { summary: "ok?", approver_roles: ["maintainer"] },
        },
        {
          id: "fan_out",
          kind: "for_each",
          dependsOn: ["approve"],
          config: {
            items: "${{ nodes.plan.outputs.rows }}",
            maxConcurrency: 3,
            invokePolicy: "per_item",
            body: {
              nodes: [
                { id: "emit_items", kind: "process.exec", config: { executable: "ls" } },
                {
                  id: "invoke",
                  kind: "pipeline.invoke",
                  dependsOn: ["emit_items"],
                  config: { pipeline: "child", inputs: {} },
                },
              ],
            },
          },
        },
        {
          id: "build_until_verified",
          kind: "until",
          dependsOn: ["approve"],
          config: {
            maxIterations: 5,
            until: "previous.passed == true",
            body: {
              nodes: [
                { id: "implement", kind: "process.exec", config: { executable: "ls" } },
                {
                  id: "test",
                  kind: "process.exec",
                  dependsOn: ["implement"],
                  config: { executable: "ls" },
                },
                {
                  id: "review",
                  kind: "process.exec",
                  dependsOn: ["test"],
                  config: { executable: "ls" },
                },
              ],
            },
          },
        },
        {
          id: "verdict",
          kind: "condition",
          dependsOn: ["build_until_verified", "fan_out"],
          config: { condition: "previous.passed == true", true: "publish_verified" },
        },
      ],
    },
  } as unknown as DefinitionDocument;

  const layout = layoutDefinition(twoScopes)!;

  it("draws the two scopes the document declares", () => {
    expect(layout.groups.map((group) => group.ownerId).sort()).toEqual([
      "build_until_verified",
      "fan_out",
    ]);
  });

  it("keeps sibling scope boxes and their bars clear of each other", () => {
    const [a, b] = layout.groups;
    const separated =
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
    // A box's title bar lives inside its own rect, so a rect that does not
    // intersect is a label that is not sitting on another scope's children.
    expect(
      separated,
      `${a.ownerId} ${a.x},${a.y},${a.width}x${a.height} vs ${b.ownerId} ${b.x},${b.y},${b.width}x${b.height}`,
    ).toBe(true);
  });

  it("keeps every node inside the box it belongs to after the push", () => {
    for (const group of layout.groups) {
      for (const node of layout.nodes.filter((item) => item.groupKey === group.key)) {
        expect(node.x).toBeGreaterThanOrEqual(group.x);
        expect(node.y).toBeGreaterThanOrEqual(group.y);
        expect(node.x + node.width).toBeLessThanOrEqual(group.x + group.width);
        expect(node.y + node.height).toBeLessThanOrEqual(group.y + group.height);
      }
    }
  });

  it("grows the reported canvas over whatever was pushed down", () => {
    const bottom = Math.max(
      ...layout.nodes.map((node) => node.y + node.height),
      ...layout.groups.map((group) => group.y + group.height),
    );
    expect(layout.height).toBeGreaterThanOrEqual(bottom);
    const right = Math.max(
      ...layout.nodes.map((node) => node.x + node.width),
      ...layout.groups.map((group) => group.x + group.width),
    );
    expect(layout.width).toBeGreaterThanOrEqual(right);
  });

  it("routes every edge onto the boxes it connects, dagre points or not", () => {
    // After a push the library's own polyline no longer ends where the node is;
    // the router that replaces it must still start and stop on the endpoints.
    const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
    for (const edge of layout.edges) {
      expect(edge.points.length).toBeGreaterThan(1);
      const from = byKey.get(edge.from)!;
      const to = byKey.get(edge.to)!;
      const first = edge.points[0];
      const last = edge.points.at(-1)!;
      expect(first.y).toBeCloseTo(from.y + from.height / 2);
      expect(last.y).toBeCloseTo(to.y + to.height / 2);
      expect(first.x).toBeCloseTo(from.x + from.width);
      expect(last.x).toBeCloseTo(to.x);
    }
  });
});

describe("separateSiblingGroups", () => {
  const scope = (key: string, x: number, y: number, width: number, height: number) =>
    ({
      key,
      ownerId: key.replace(/^#\//, "").split("/").pop(),
      x,
      y,
      width,
      height,
    }) as GraphGroupView;
  const box = (key: string, y: number) =>
    ({ key, x: 0, y, width: 108, height: 60 }) as GraphNodeView;

  it("pushes a scope out of the one above it, its members riding along", () => {
    // The shape the live `feature-development` revision produced: the `for each`
    // box's foot reaches 20px into the `until` box below it, which is the
    // `until` title bar sitting behind the `↻ one place per item` line.
    const groups = [
      scope("#/fan_out", 513, 259, 100, 146),
      scope("#/build_until_verified", 470, 371, 340, 126),
    ];
    const nodes = [box("/fan_out/emit_items", 293), box("/build_until_verified/implement", 405)];
    expect(separateSiblingGroups(groups, nodes)).toBe(true);
    const [upper, lower] = groups;
    expect(lower.y).toBe(upper.y + upper.height + GROUP_GAP);
    // The pushed box's member moved with it, by exactly the overlap plus the gap.
    expect(nodes[1].y).toBe(405 + (lower.y - 371));
    // Nothing above the pushed box moves.
    expect(nodes[0].y).toBe(293);
  });

  it("carries a nested scope and its members with the box they sit in", () => {
    const groups = [
      scope("#/outer", 0, 0, 100, 200),
      scope("#/outer/inner", 10, 30, 60, 80),
      scope("#/sibling", 20, 190, 60, 80),
    ];
    const nodes = [box("/outer/inner/deep", 50), box("/sibling/shallow", 210)];
    expect(separateSiblingGroups(groups, nodes)).toBe(true);
    // The sibling moves; the box it was pushed out of, and what sits inside that
    // box, do not.
    expect(groups[2].y).toBe(212);
    expect(nodes[1].y).toBe(232);
    expect(groups[0].y).toBe(0);
    expect(groups[1].y).toBe(30);
    expect(nodes[0].y).toBe(50);
    // And the pushed box now clears its sibling's children too, not just its box.
    expect(groups[2].y + groups[2].height).toBeGreaterThan(nodes[1].y);
  });

  it("leaves scopes that already clear each other exactly where they are", () => {
    const groups = [scope("#/a", 0, 0, 100, 100), scope("#/b", 0, 112, 100, 100)];
    expect(separateSiblingGroups(groups, [])).toBe(false);
    expect(groups[1].y).toBe(112);
  });
});

describe("canvas (dense) spacing", () => {
  it("leaves the standard cut untouched — default and explicit standard agree", () => {
    expect(layoutDefinition(samplePipelineDocument)).toEqual(
      layoutDefinition(samplePipelineDocument, { spacing: "standard" }),
    );
  });

  it("packs the dense cut tighter than the standard one in both directions", () => {
    const stdLR = layoutDefinition(samplePipelineDocument, {
      spacing: "standard",
      rankdir: "LR",
    })!;
    const denseLR = layoutDefinition(samplePipelineDocument, {
      spacing: "dense",
      rankdir: "LR",
    })!;
    expect(denseLR.width).toBeLessThan(stdLR.width);
    expect(denseLR.height).toBeLessThan(stdLR.height);
  });

  it("lays a scope body sideways when the graph runs top-to-bottom", () => {
    const tb = layoutDefinition(samplePipelineDocument, { spacing: "dense", rankdir: "TB" })!;
    const tbOpp = layoutDefinition(samplePipelineDocument, {
      spacing: "dense",
      rankdir: "TB",
      subgraphRankdir: "opposite",
    })!;
    const group = (laid: typeof tb) =>
      laid.groups.find((g) => g.ownerId === "build_until_verified")!;
    // Without the flip the until body stacks vertically: a tall narrow box.
    expect(group(tb).height).toBeGreaterThan(group(tb).width);
    // With it the chain runs sideways inside the group: a short wide box,
    // and the whole graph ends up shorter to boot.
    expect(group(tbOpp).width).toBeGreaterThan(group(tbOpp).height);
    expect(tbOpp.height).toBeLessThan(tb.height);
  });

  it("keeps a top-to-bottom scope body top-to-bottom (subgraphRankdir same)", () => {
    const tbSame = layoutDefinition(samplePipelineDocument, {
      spacing: "dense",
      rankdir: "TB",
      subgraphRankdir: "same",
    })!;
    const group = tbSame.groups.find((g) => g.ownerId === "build_until_verified")!;
    // The authoring Studio is always top-to-bottom: a scope body keeps the
    // graph's own direction instead of flipping sideways.
    expect(group.height).toBeGreaterThan(group.width);
  });

  it("keeps the dense top-to-bottom cut inside fit zoom 1.2 of the canvas panes", () => {
    const tb = layoutDefinition(samplePipelineDocument, {
      spacing: "dense",
      rankdir: "TB",
      subgraphRankdir: "opposite",
    })!;
    // The panes `chooseCanvasOrientation` (flowModel's CANVAS_PANES) is
    // picked against: the Workbench graph pane and the Studio canvas. The
    // Studio pane carries the step-list section, which consumes ~220px of
    // the 776px fit space at the 1500x950 check viewport (e2e/
    // .canvas-check.mjs floors it at zoom >= 1.0 there; the 1.2 here leaves
    // room for the fitView padding). The ranksep floor is the collision-
    // checked edge-label pill's height, not the old "twice the widest
    // label" gap that kept the twin at zoom ~0.8.
    const panes = [
      { width: 1020, height: 610 },
      { width: 920, height: 556 },
    ];
    for (const pane of panes) {
      const fit = Math.min(pane.width / tb.width, pane.height / tb.height);
      expect(fit, `pane ${pane.width}x${pane.height}`).toBeGreaterThanOrEqual(1.2);
    }
  });
});
