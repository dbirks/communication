/**
 * The semantic diff against the real § 7 exit seed: document 1 of
 * `docs/compatibility/probes/m4/pipeline.yaml` is the base (parsed to JS, the
 * same shape `canonical_document` carries) and every case is a modified copy
 * of it — added, removed, changed, moved, edge change, layout-only, and the
 * key-order-only no-op that must read as an empty diff.
 */
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { semanticDiff, type NodeChange } from "./semanticDiff";

// This project's tsconfig sets `types: ["vite/client"]`, so `@types/node` is
// out of the program and no new dependency may be added here. `node:fs` is
// reached by a runtime-resolved dynamic import with local types (the same
// pattern as `templates/drift.test.ts`).
declare const process: { cwd(): string };

interface NodeFs {
  readFileSync: (path: string, encoding: "utf8") => string;
}

/** Resolved at runtime only — a literal specifier would be typechecked away. */
async function readProbeText(): Promise<string> {
  const specifier = "node:fs";
  const fs = (await import(specifier)) as unknown as NodeFs;
  // vitest runs with the `ui` directory as cwd; the probe lives at the repo root.
  return fs.readFileSync(`${process.cwd()}/../docs/compatibility/probes/m4/pipeline.yaml`, "utf8");
}

/** Document 1 of the probe set — the agent-driven variant. */
const base = parseAllDocuments(await readProbeText())[0]?.toJS();

function modified(): Record<string, any> {
  return structuredClone(base as Record<string, any>);
}

function changeOf(result: ReturnType<typeof semanticDiff>, id: string): NodeChange {
  const found = result.nodes.find((node) => node.id === id);
  expect(found, `node ${id} in diff`);
  return found as NodeChange;
}

function edgesOf(result: ReturnType<typeof semanticDiff>, from: string) {
  return result.edges.filter((edge) => edge.from === from);
}

describe("semanticDiff against the m4 probe document", () => {
  it("reads the base document: a diff of it against itself is empty", () => {
    const result = semanticDiff(base, structuredClone(base));
    expect(result.empty).toBe(true);
    expect(result.layoutOnly).toBe(false);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.pipeline).toEqual([]);
  });

  it("a diff against no published revision adds every node", () => {
    const result = semanticDiff(null, base);
    expect(result.empty).toBe(false);
    expect(result.layoutOnly).toBe(false);
    for (const node of result.nodes) expect(node.change).toBe("added");
    expect(result.nodes.map((node) => node.id)).toContain("plan");
    expect(result.nodes.map((node) => node.id)).toContain("invoke");
    const invoke = result.nodes.find((node) => node.id === "invoke");
    expect(invoke?.scope).toBe("fan_out");
  });

  it("reports an added node with its added edges", () => {
    const next = modified();
    next.spec.nodes.push({ id: "extra", kind: "model.chat", dependsOn: ["plan"] });
    const result = semanticDiff(base, next);
    expect(result.empty).toBe(false);
    expect(changeOf(result, "extra")).toEqual({
      id: "extra",
      scope: "",
      kind: "model.chat",
      change: "added",
      fields: [],
    });
    expect(edgesOf(result, "plan")).toContainEqual({
      from: "plan",
      to: "extra",
      change: "added",
    });
    // the plan node itself did not change
    expect(result.nodes.find((node) => node.id === "plan")).toBeUndefined();
  });

  it("reports a removed node with its removed edges", () => {
    const next = modified();
    const before = next.spec.nodes.length;
    next.spec.nodes = next.spec.nodes.filter((node: any) => node.id !== "emit_items");
    expect(next.spec.nodes.length).toBe(before - 1);
    const result = semanticDiff(base, next);
    const removed = changeOf(result, "emit_items");
    expect(removed.change).toBe("removed");
    expect(removed.kind).toBe("process.exec");
    expect(edgesOf(result, "approve")).toContainEqual({
      from: "approve",
      to: "emit_items",
      change: "removed",
    });
  });

  it("reports a changed prompt at its dotted path", () => {
    const next = modified();
    const plan = next.spec.nodes.find((node: any) => node.id === "plan");
    const original = plan.config.prompt;
    plan.config.prompt = `${original} Also cite the test names.`;
    const result = semanticDiff(base, next);
    const changed = changeOf(result, "plan");
    expect(changed.change).toBe("changed");
    expect(changed.fields.map((field: any) => field.path)).toContain("config.prompt");
    const field = changed.fields.find((f: any) => f.path === "config.prompt");
    expect(field?.before).toBe(original);
    expect(field?.after).toBe(`${original} Also cite the test names.`);
    // nothing else about the plan changed
    expect(changed.fields).toHaveLength(1);
  });

  it("reports a node moved into a scope as moved, keeping its field changes", () => {
    const next = modified();
    const emit = next.spec.nodes.find((node: any) => node.id === "emit_items");
    next.spec.nodes = next.spec.nodes.filter((node: any) => node.id !== "emit_items");
    const scope = next.spec.nodes.find((node: any) => node.id === "build_until_verified");
    scope.config.body.nodes.push(emit);
    // also change a field while it moves, so the move carries its field diff
    emit.timeoutSeconds = 310;
    const result = semanticDiff(base, next);
    const moved = changeOf(result, "emit_items");
    expect(moved.change).toBe("moved");
    expect(moved.scope).toBe("build_until_verified");
    expect(moved.fields.map((field: any) => field.path)).toContain("timeoutSeconds");
    // the scope node itself is not shown as changed — its body.nodes is the
    // children's location, not a field of the scope
    expect(result.nodes.find((node) => node.id === "build_until_verified")).toBeUndefined();
  });

  it("reports a dependsOn change as the two edge changes", () => {
    const next = modified();
    const emit = next.spec.nodes.find((node: any) => node.id === "emit_items");
    expect(emit.dependsOn).toEqual(["approve"]);
    emit.dependsOn = ["plan"];
    const result = semanticDiff(base, next);
    expect(edgesOf(result, "plan")).toContainEqual({
      from: "plan",
      to: "emit_items",
      change: "added",
    });
    expect(edgesOf(result, "approve")).toContainEqual({
      from: "approve",
      to: "emit_items",
      change: "removed",
    });
  });

  it("treats a metadata.ui-only difference as layoutOnly", () => {
    const next = modified();
    next.metadata.ui = { columns: { plan: { x: 40, y: 20 } } };
    const result = semanticDiff(base, next);
    expect(result.layoutOnly).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.pipeline).toEqual([]);
    // and a second layout move (different ui value) is still layoutOnly
    const again = modified();
    again.metadata.ui = { columns: { plan: { x: 41, y: 20 } } };
    expect(semanticDiff(next, again).layoutOnly).toBe(true);
  });

  it("reads a key-order-only difference as empty", () => {
    const next = modified();
    // re-key the plan node (and its config) in reverse order: same content,
    // different order
    const plan = next.spec.nodes.find((node: any) => node.id === "plan");
    const rekey = (value: any): any => {
      if (Array.isArray(value)) return value.map(rekey);
      if (value === null || typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) out[key] = rekey(value[key]);
      return out;
    };
    next.spec.nodes[next.spec.nodes.indexOf(plan)] = rekey(plan);
    const result = semanticDiff(base, next);
    expect(result.empty).toBe(true);
  });

  it("reports pipeline-level policy changes outside the nodes", () => {
    const next = modified();
    next.spec.policies.maxDurationSeconds = 28800;
    const result = semanticDiff(base, next);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.pipeline).toContainEqual({
      path: "spec.policies.maxDurationSeconds",
      before: 14400,
      after: 28800,
    });
    expect(result.layoutOnly).toBe(false);
  });
});
