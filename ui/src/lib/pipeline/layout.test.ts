import { describe, expect, it } from "vitest";
import { layoutDefinition } from "./layout";
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
