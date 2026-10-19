import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import {
  addNode,
  canConnect,
  connect,
  deleteNode,
  disconnect,
  findNode,
  insertAfter,
  insertOnEdge,
  isValidId,
  moveIntoScope,
  parseGraph,
  renameNode,
  scopeKey,
  skeletonNode,
  unwrapScope,
  uniqueId,
  updateConfig,
  updateNodeFields,
  wrapInScope,
  type GraphModel,
  type OpResult,
} from "./graphDoc.js";

// `node:fs` is reached by a runtime-resolved dynamic import and given local
// types: this project's tsconfig sets `types: ["vite/client"]`, so
// `@types/node` is out of the program and no new dependency may be added here.
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
const fixtureText = fsMod.readFileSync(
  pathMod.resolve(process.cwd(), "../docs/compatibility/probes/m4/pipeline.yaml"),
  "utf8",
);
// seed.sh posts one document per `---`-delimited slice; document 1 is first.
const FIXTURE = fixtureText.split(/^---$/m)[0];

/** The failure text of an OpResult ("" when ok) so the union narrows cleanly. */
function failReason(result: OpResult): string {
  if (result.ok) return "";
  return "error" in result ? result.error : result.reasons.join("; ");
}

/** Re-parse text and walk every scope to find a node by id (plain JS). */
function nodeOf(text: string, id: string): Record<string, unknown> | undefined {
  const doc = parseDocument(text).toJS() as { spec?: { nodes?: unknown[] } };
  const walk = (nodes: unknown[] | undefined): Record<string, unknown> | undefined => {
    for (const raw of nodes ?? []) {
      const n = raw as Record<string, unknown>;
      if (n.id === id) return n;
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const body = (cfg.body ?? {}) as Record<string, unknown>;
      const found = walk(body.nodes as unknown[] | undefined);
      if (found) return found;
      for (const branch of (cfg.branches as unknown[] | undefined) ?? []) {
        const foundBranch = walk(
          ((branch as Record<string, unknown>).nodes as unknown[]) ?? undefined,
        );
        if (foundBranch) return foundBranch;
      }
    }
    return undefined;
  };
  return walk(doc.spec?.nodes);
}

/** v2-native style: round-trips byte-identically. */
const INLINE = `kind: Pipeline
spec:
  nodes:
    - id: a
      kind: process.exec
      config:
        executable: sh
        # keep me
        args: []
    - id: b
      kind: process.exec
      dependsOn:
        - a
      config:
        executable: sh
    - id: rescue
      kind: human.approval
      config:
        summary: "ok?"
`;

describe("parseGraph", () => {
  it("parses the real m4 fixture: node ids and labels", () => {
    const result = parseGraph(FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.model.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(
      [
        "approve",
        "build_until_verified",
        "emit_items",
        "fan_out",
        "implement",
        "invoke",
        "plan",
        "publish_needs_attention",
        "publish_verified",
        "review",
        "test",
        "verdict",
      ].sort(),
    );
    expect(findNode(result.model, "plan")?.label).toBe("Coding agent");
    expect(findNode(result.model, "build_until_verified")?.label).toBe("Repeat until");
  });

  it("gives until-body nodes the loop scope and body pointers", () => {
    const result = parseGraph(FIXTURE);
    if (!result.ok) throw new Error("fixture must parse");
    for (const id of ["implement", "test", "review"]) {
      const n = findNode(result.model, id);
      expect(n?.scope).toEqual(["build_until_verified"]);
    }
    expect(findNode(result.model, "implement")?.pointer).toBe("/spec/nodes/2/config/body/nodes/0");
    expect(findNode(result.model, "build_until_verified")?.isScope).toBe(true);
    expect(findNode(result.model, "fan_out")?.isScope).toBe(true);
    expect(findNode(result.model, "invoke")?.scope).toEqual(["fan_out"]);
  });

  it("marks edges from the verdict condition as guarded, with reasons", () => {
    const result = parseGraph(FIXTURE);
    if (!result.ok) throw new Error("fixture must parse");
    const e = result.model.edges.find(
      (ed) => ed.from === "verdict" && ed.to === "publish_verified",
    );
    expect(e?.kind).toBe("guarded");
    expect(e?.reasons).toContain("verdict is a condition; this edge is its route");
    expect(e?.reasons).toContain(
      "publish_verified only runs when nodes.verdict.outputs.route == 'verified'",
    );
    expect(e?.id).toBe(":verdict->publish_verified");
    expect(e?.scope).toEqual([]);
  });

  it("keeps body edges inside the body scope", () => {
    const result = parseGraph(FIXTURE);
    if (!result.ok) throw new Error("fixture must parse");
    const e = result.model.edges.find((ed) => ed.from === "implement" && ed.to === "test");
    expect(e?.scope).toEqual(["build_until_verified"]);
    expect(e?.id).toBe("build_until_verified:implement->test");
    expect(e?.kind).toBe("depends");
    expect(e?.reasons).toEqual([]);
  });

  it("records a depends edge reason when the downstream node reads the upstream outputs", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: a
      kind: process.exec
      config:
        executable: sh
    - id: b
      kind: process.exec
      dependsOn:
        - a
      config:
        executable: sh
        notes: "checks nodes.a.outputs before running"
`;
    const result = parseGraph(text);
    if (!result.ok) throw new Error("must parse");
    const e = result.model.edges.find((ed) => ed.from === "a" && ed.to === "b");
    expect(e?.kind).toBe("depends");
    expect(e?.reasons).toEqual(["b reads nodes.a.*"]);
  });

  it("adds an error edge for onFailure.errorRoute", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: flaky
      kind: process.exec
      onFailure:
        onExecutionError: route
        errorRoute: rescue
      config:
        executable: sh
    - id: rescue
      kind: human.approval
      dependsOn:
        - flaky
      config:
        summary: "ok?"
`;
    const result = parseGraph(text);
    if (!result.ok) throw new Error("must parse");
    const errEdge = result.model.edges.find((ed) => ed.kind === "error");
    expect(errEdge?.from).toBe("flaky");
    expect(errEdge?.to).toBe("rescue");
    expect(errEdge?.reasons).toEqual(["error route"]);
    expect(errEdge?.id).toBe(":flaky->rescue");
  });

  it("returns ok:false with a line number for invalid YAML", () => {
    const result = parseGraph("a: 1\n  b: 2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
    expect(result.line).toBe(2);
  });

  it("rejects non-pipeline documents", () => {
    const result = parseGraph("kind: Widget\nfoo: bar");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Pipeline/);
      expect(result.line).toBeNull();
    }
  });

  it("reports the when expression as a guard reason and keeps when:null plain", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: a
      kind: process.exec
      config:
        executable: sh
    - id: b
      kind: process.exec
      when: inputs.enabled == true
      dependsOn:
        - a
      config:
        executable: sh
`;
    const result = parseGraph(text);
    if (!result.ok) throw new Error("must parse");
    const e = result.model.edges.find((ed) => ed.to === "b");
    expect(e?.kind).toBe("guarded");
    expect(e?.reasons).toEqual(["b only runs when inputs.enabled == true"]);
    expect(findNode(result.model, "a")?.when).toBeNull();
  });
});

describe("scopeKey / uniqueId / skeletonNode / findNode", () => {
  it("scopeKey", () => {
    expect(scopeKey([])).toBe("");
    expect(scopeKey(["loop"])).toBe("loop");
    expect(scopeKey(["par", "1"])).toBe("par/1");
    expect(scopeKey(["loop", "par", "1"])).toBe("loop/par/1");
  });

  it("uniqueId walks the whole document (all scopes)", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: review
      kind: agent.acp
      config:
        profile: ""
        prompt: ""
    - id: loop
      kind: until
      config:
        maxIterations: 3
        passWhen: "true"
        body:
          nodes:
            - id: review_2
              kind: process.exec
              config:
                executable: sh
`;
    const result = parseGraph(text);
    if (!result.ok) throw new Error("must parse");
    const model: GraphModel = result.model;
    expect(uniqueId(model, "review")).toBe("review_3");
    expect(uniqueId(model, "newish")).toBe("newish");
  });

  it("skeletonNode covers every runnable kind with schema-required keys", () => {
    expect(skeletonNode("agent.acp")).toEqual({ profile: "", prompt: "" });
    expect(skeletonNode("model.chat")).toEqual({
      model: "",
      messages: [{ role: "user", content: "" }],
    });
    expect(skeletonNode("process.exec")).toEqual({ executable: "sh", args: [] });
    expect(skeletonNode("human.approval")).toEqual({ summary: "Approve?" });
    expect(skeletonNode("condition")).toEqual({
      cases: [{ when: "true", route: "yes" }],
      default: "no",
    });
    expect(skeletonNode("until")).toEqual({
      maxIterations: 3,
      passWhen: "true",
      body: { nodes: [] },
    });
    expect(skeletonNode("for_each")).toEqual({ items: "${{ [] }}", body: { nodes: [] } });
    expect(skeletonNode("pipeline.invoke")).toEqual({ pipeline: "" });
    expect(skeletonNode("artifact.publish")).toEqual({
      name: "artifact.md",
      mediaType: "text/markdown",
    });
    expect(skeletonNode("parallel")).toEqual({});
  });

  it("findNode returns undefined for a missing id", () => {
    const result = parseGraph(INLINE);
    if (!result.ok) throw new Error("must parse");
    expect(findNode(result.model, "nope")).toBeUndefined();
    expect(findNode(result.model, "b")?.kind).toBe("process.exec");
  });
});

describe("addNode", () => {
  it("appends to the root scope with a skeleton config", () => {
    const result = addNode(INLINE, { kind: "agent.acp", scope: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(["agent"]);
    const n = nodeOf(result.text, "agent");
    expect(n?.kind).toBe("agent.acp");
    expect(n?.config as Record<string, unknown>).toEqual({ profile: "", prompt: "" });
  });

  it("keeps existing comments after adding a node", () => {
    const result = addNode(INLINE, { kind: "process.exec", id: "c", scope: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("# keep me");
  });

  it("with `after`, the new node depends only on that node", () => {
    const result = addNode(INLINE, { kind: "human.approval", id: "c", scope: [], after: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const n = nodeOf(result.text, "c");
    expect(n?.dependsOn).toEqual(["a"]);
    const reparse = parseGraph(result.text);
    if (!reparse.ok) return;
    expect(reparse.model.edges.find((e) => e.from === "a" && e.to === "c")?.kind).toBe("depends");
    // b was not rewired
    expect(nodeOf(result.text, "b")?.dependsOn).toEqual(["a"]);
  });

  it("adds into an empty until body", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: loop
      kind: until
      config:
        maxIterations: 3
        passWhen: "true"
        body:
          nodes: []
`;
    const result = addNode(text, { kind: "process.exec", id: "step", scope: ["loop"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reparse = parseGraph(result.text);
    if (!reparse.ok) return;
    expect(reparse.model.nodes.find((n) => n.id === "step")?.scope).toEqual(["loop"]);
    expect(reparse.model.nodes.find((n) => n.id === "step")?.pointer).toBe(
      "/spec/nodes/0/config/body/nodes/0",
    );
  });

  it("refuses an id that already exists anywhere in the document", () => {
    const result = addNode(INLINE, { kind: "process.exec", id: "rescue", scope: [] });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/already used/);
  });

  it("refuses `after` pointing at a node outside the scope", () => {
    const result = addNode(INLINE, { kind: "process.exec", id: "c", scope: [], after: "missing" });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/missing/);
  });

  it("keeps untouched lines byte-identical (v2-native layout)", () => {
    const result = addNode(INLINE, { kind: "process.exec", id: "c", scope: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = INLINE.split("\n").slice(0, -1); // doc.toString() drops the trailing newline
    const after = result.text.split("\n");
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).join("\n")).toContain("id: c");
  });
});

describe("deleteNode", () => {
  it("rewires siblings to the deleted node's own dependsOn (deduped)", () => {
    const result = deleteNode(INLINE, "a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nodeOf(result.text, "a")).toBeUndefined();
    // b depended only on a, so its (now empty) dependsOn key is dropped
    expect(nodeOf(result.text, "b")?.dependsOn).toBeUndefined();
    expect(result.changed).toContain("a");
  });

  it("merges inherited deps without duplicates", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: a
      kind: process.exec
      config:
        executable: sh
    - id: b
      kind: process.exec
      dependsOn:
        - a
      config:
        executable: sh
    - id: c
      kind: process.exec
      dependsOn:
        - a
        - b
      config:
        executable: sh
`;
    const result = deleteNode(text, "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nodeOf(result.text, "c")?.dependsOn).toEqual(["a"]);
    expect(result.changed.sort()).toEqual(["b", "c"]);
  });

  it("drops the dependsOn key when nothing remains", () => {
    const result = deleteNode(INLINE, "a");
    if (!result.ok) throw new Error("delete failed");
    const b = parseDocument(result.text).toJS() as { spec: { nodes: Record<string, unknown>[] } };
    expect(b.spec.nodes.find((n) => n.id === "b")?.dependsOn).toBeUndefined();
  });

  it("refuses when another node's text references nodes.<id>.", () => {
    const result = deleteNode(INLINE, "a"); // a is safe to delete — build a referenced doc instead
    if (!result.ok) throw new Error("unexpected");
    const withRef = addNode(result.text, { kind: "process.exec", id: "d", scope: [], after: "b" });
    if (!withRef.ok) throw new Error("add failed");
    const patched = updateConfig(withRef.text, "d", { notes: "see nodes.a.outputs" });
    if (!patched.ok) throw new Error("patch failed");
    const refused = deleteNode(patched.text, "a");
    expect(refused.ok).toBe(false);
    expect(failReason(refused)).toMatch(/d/);
  });

  it("refuses deleting a missing node", () => {
    const result = deleteNode(INLINE, "ghost");
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/no node/);
  });
});

describe("updateConfig / updateNodeFields", () => {
  it("sets and deletes config keys and keeps a sibling comment", () => {
    const set = updateConfig(INLINE, "a", { executable: "bash", note: "hi" });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(nodeOf(set.text, "a")?.config).toEqual({ executable: "bash", args: [], note: "hi" });
    expect(set.text).toContain("# keep me");
    const del = updateConfig(set.text, "a", { note: undefined });
    if (!del.ok) throw new Error("delete failed");
    expect(nodeOf(del.text, "a")?.config).toEqual({ executable: "bash", args: [] });
    expect(del.text).toContain("# keep me");
  });

  it("works on nested scope nodes", () => {
    const patched = updateConfig(FIXTURE, "implement", { structuredOutput: "1024" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const reparse = parseGraph(patched.text);
    if (!reparse.ok) return;
    const impl = reparse.model.nodes.find((n) => n.id === "implement");
    expect(impl?.scope).toEqual(["build_until_verified"]);
    expect(nodeOf(patched.text, "implement")?.config).toMatchObject({ structuredOutput: "1024" });
  });

  it("updateNodeFields sets/removes top-level fields and rejects unknown ones", () => {
    const set = updateNodeFields(INLINE, "a", { timeoutSeconds: 600, when: "inputs.ok == true" });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const a = nodeOf(set.text, "a");
    expect(a?.timeoutSeconds).toBe(600);
    expect(a?.when).toBe("inputs.ok == true");
    const del = updateNodeFields(set.text, "a", { timeoutSeconds: undefined });
    if (!del.ok) throw new Error("delete failed");
    expect(nodeOf(del.text, "a")?.timeoutSeconds).toBeUndefined();
    const bad = updateNodeFields(INLINE, "a", { kind: "model.chat" });
    expect(bad.ok).toBe(false);
    expect(failReason(bad)).toMatch(/not a node field/);
  });
});

describe("renameNode", () => {
  it("rewrites dependsOn entries", () => {
    const result = renameNode(INLINE, "a", "alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nodeOf(result.text, "alpha")).toBeDefined();
    expect(nodeOf(result.text, "a")).toBeUndefined();
    expect(nodeOf(result.text, "b")?.dependsOn).toEqual(["alpha"]);
  });

  it("rewrites condition route values equal to the old id", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: verdict
      kind: condition
      config:
        cases:
          - when: "true"
            route: ok
        default: fix
    - id: fix
      kind: human.approval
      dependsOn:
        - verdict
      config:
        summary: "ok?"
`;
    const result = renameNode(text, "fix", "repair");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = nodeOf(result.text, "verdict")?.config as Record<string, unknown>;
    expect(cfg.default).toBe("repair");
  });

  it("refuses when nodes.<id>. appears in expressions, naming the offenders", () => {
    const withRef = updateConfig(INLINE, "b", { notes: "reads nodes.a.outputs" });
    if (!withRef.ok) throw new Error("patch failed");
    const refused = renameNode(withRef.text, "a", "alpha");
    expect(refused.ok).toBe(false);
    expect(failReason(refused)).toMatch(/b/);
    expect(failReason(refused)).toMatch(/nodes\.a\./);
  });

  it("refuses renaming to an existing id", () => {
    const refused = renameNode(INLINE, "a", "b");
    expect(refused.ok).toBe(false);
    expect(failReason(refused)).toMatch(/already used/);
  });

  it("renames on the real fixture (verdict has no expression references of its own)", () => {
    const refused = renameNode(FIXTURE, "verdict", "final");
    // downstream guards contain nodes.verdict. → must be refused, naming them
    expect(refused.ok).toBe(false);
    expect(failReason(refused)).toMatch(/publish_verified/);
    expect(failReason(refused)).toMatch(/publish_needs_attention/);
  });
});

/** A small doc exercising plain, guarded, condition, error and body edges. */
const EDGE_DOC = `kind: Pipeline
spec:
  nodes:
    - id: a
      kind: process.exec
      config:
        executable: sh
        # keep me
        args: []
    - id: b
      kind: process.exec
      dependsOn:
        - a
      config:
        executable: sh
    - id: c
      kind: process.exec
      dependsOn:
        - b
        - a
      config:
        executable: sh
    - id: gated
      kind: process.exec
      dependsOn:
        - c
      when: nodes.b.outputs.ok == true
      config:
        executable: sh
    - id: guard
      kind: condition
      config:
        cases:
          - when: "true"
            route: pass
        default: skip
    - id: guarded
      kind: process.exec
      dependsOn:
        - guard
      when: nodes.guard.outputs.route == 'pass'
      config:
        executable: sh
    - id: loop
      kind: until
      dependsOn:
        - c
      config:
        maxIterations: 3
        passWhen: "true"
        body:
          nodes:
            - id: p
              kind: process.exec
              config:
                executable: sh
            - id: q
              kind: process.exec
              dependsOn:
                - p
              onFailure:
                onExecutionError: stop
                errorRoute: p
              config:
                executable: sh
`;

function modelOfText(text: string): GraphModel {
  const r = parseGraph(text);
  if (!r.ok) throw new Error(`must parse: ${r.error}`);
  return r.model;
}

function depsOf(text: string, id: string): string[] {
  return (nodeOf(text, id)?.dependsOn as string[] | undefined) ?? [];
}

describe("identifier rules", () => {
  it("isValidId matches the schema pattern exactly", () => {
    expect(isValidId("review")).toBe(true);
    expect(isValidId("review_2")).toBe(true);
    expect(isValidId("review-2")).toBe(false);
    expect(isValidId("2review")).toBe(false);
    expect(isValidId("Review")).toBe(false);
    expect(isValidId("_review")).toBe(false);
  });

  it("uniqueId falls back to underscores and addNode refuses dashes", () => {
    const text = `kind: Pipeline
spec:
  nodes:
    - id: review
      kind: agent.acp
      config:
        profile: ""
        prompt: ""
`;
    const r = parseGraph(text);
    if (!r.ok) throw new Error("must parse");
    expect(uniqueId(r.model, "review")).toBe("review_2");
    const bad = addNode(text, { kind: "process.exec", id: "re-view", scope: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok && "error" in bad) {
      expect(bad.error).toBe("ids use lowercase letters, digits and _ (start with a letter)");
    }
  });
});

describe("insertOnEdge", () => {
  it("splits a plain edge: B.dependsOn replaces A in place and comments survive", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "a", to: "b" },
      {
        kind: "model.chat",
        id: "ask",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("# keep me");
    expect(depsOf(result.text, "b")).toEqual(["ask"]);
    expect(depsOf(result.text, "ask")).toEqual(["a"]);
    const reparsed = parseGraph(result.text);
    expect(reparsed.ok).toBe(true);
  });

  it("keeps the target's other deps in their original order", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "a", to: "c" },
      {
        kind: "model.chat",
        id: "ask",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(depsOf(result.text, "c")).toEqual(["b", "ask"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("inserts into an until body and scopes the new node before the target", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "p", to: "q" },
      {
        kind: "process.exec",
        id: "mid",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = modelOfText(result.text);
    expect(findNode(model, "mid")?.scope).toEqual(["loop"]);
    expect(findNode(model, "mid")?.dependsOn).toEqual(["p"]);
    expect(findNode(model, "q")?.dependsOn).toEqual(["mid"]);
    const body = (
      (
        parseDocument(result.text).toJS() as { spec: { nodes: Record<string, unknown>[] } }
      ).spec.nodes.find((n) => n.id === "loop")?.config as Record<string, unknown>
    )?.body as { nodes: Record<string, unknown>[] };
    expect(body.nodes.map((n) => n.id)).toEqual(["p", "mid", "q"]);
  });

  it("a guarded edge is ambiguous, naming the when reason", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "c", to: "gated" },
      {
        kind: "model.chat",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result)) throw new Error("expected ambiguity");
    expect(result.reasons.join(" ")).toMatch(/only runs when nodes\.b\.outputs\.ok/);
  });

  it("with acceptAmbiguity, B's when stays byte-identical", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "c", to: "gated" },
      { kind: "model.chat", id: "gate2" },
      { acceptAmbiguity: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nodeOf(result.text, "gated")?.when).toBe("nodes.b.outputs.ok == true");
    expect(depsOf(result.text, "gated")).toEqual(["gate2"]);
    expect(depsOf(result.text, "gate2")).toEqual(["c"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("a condition source is ambiguous", () => {
    const result = insertOnEdge(
      EDGE_DOC,
      { from: "guard", to: "guarded" },
      {
        kind: "process.exec",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result)) throw new Error("expected ambiguity");
    expect(result.reasons.join(" ")).toMatch(/is a condition/);
  });

  it("an error route cannot be split", () => {
    const result = insertOnEdge(EDGE_DOC, { from: "q", to: "p" }, { kind: "process.exec" });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/error routes cannot be split/);
    }
  });

  it("a binding reader is ambiguous", () => {
    const withNote = updateConfig(INLINE, "b", { note: "reads nodes.a.outputs" });
    if (!withNote.ok) throw new Error("updateConfig must work");
    const result = insertOnEdge(
      withNote.text,
      { from: "a", to: "b" },
      {
        kind: "process.exec",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result)) throw new Error("expected ambiguity");
    expect(result.reasons.join(" ")).toMatch(/reads nodes\.a/);
  });

  it("refuses a missing edge and a dashed id", () => {
    const missing = insertOnEdge(EDGE_DOC, { from: "b", to: "a" }, { kind: "process.exec" });
    expect(missing.ok).toBe(false);
    if (!missing.ok && "error" in missing) expect(missing.error).toMatch(/no edge/);
    const badId = insertOnEdge(
      EDGE_DOC,
      { from: "a", to: "b" },
      {
        kind: "model.chat",
        id: "ask-2",
      },
    );
    expect(badId.ok).toBe(false);
    if (!badId.ok && "error" in badId) {
      expect(badId.error).toBe("ids use lowercase letters, digits and _ (start with a letter)");
    }
  });
});

describe("insertAfter", () => {
  it("appends a node after a terminal step", () => {
    const result = insertAfter(EDGE_DOC, "guarded", { kind: "human.approval", id: "signoff" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(depsOf(result.text, "signoff")).toEqual(["guarded"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("refuses a step that still has downstream steps", () => {
    const result = insertAfter(EDGE_DOC, "a", { kind: "process.exec" });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) expect(result.error).toMatch(/insertOnEdge/);
  });
});

describe("canConnect / connect / disconnect", () => {
  const model = modelOfText(EDGE_DOC);

  it("refuses a self edge", () => {
    const check = canConnect(model, "a", "a");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/itself/);
  });

  it("refuses a duplicate edge", () => {
    const check = canConnect(model, "a", "b");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/already connected/);
  });

  it("refuses an edge that would create a cycle, naming the path", () => {
    const check = canConnect(model, "c", "a");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/cycle/);
    if (!check.ok) expect(check.reason).toMatch(/c -> b -> a/);
  });

  it("refuses a cross-scope edge", () => {
    const check = canConnect(model, "a", "p");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/different scopes/);
  });

  it("refuses a missing node and accepts a legal edge", () => {
    expect(canConnect(model, "a", "ghost").ok).toBe(false);
    expect(canConnect(model, "a", "gated")).toEqual({ ok: true });
  });

  it("connect then disconnect restores the dependsOn list", () => {
    const connected = connect(EDGE_DOC, "a", "gated");
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(depsOf(connected.text, "gated")).toEqual(["c", "a"]);
    const disconnected = disconnect(connected.text, "a", "gated");
    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) return;
    expect(depsOf(disconnected.text, "gated")).toEqual(["c"]);
    expect(parseGraph(disconnected.text).ok).toBe(true);
    expect(disconnected.text).toContain("# keep me");
  });

  it("connect refuses via the same rules and disconnect a missing edge", () => {
    const bad = connect(EDGE_DOC, "c", "a");
    expect(bad.ok).toBe(false);
    if (!bad.ok && "error" in bad) expect(bad.error).toMatch(/cycle/);
    const missing = disconnect(EDGE_DOC, "a", "gated");
    expect(missing.ok).toBe(false);
    if (!missing.ok && "error" in missing) expect(missing.error).toMatch(/no edge/);
  });
});

const WRAP_DOC = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
      config:
        profile: ""
        prompt: plan it
    - id: implement
      kind: agent.acp
      dependsOn:
        - plan
      config:
        profile: ""
        prompt: implement it
    - id: test
      kind: process.exec
      dependsOn:
        - implement
      config:
        executable: sh
        args: []
    - id: review
      kind: agent.acp
      dependsOn:
        - test
      config:
        profile: ""
        prompt: review it
`;

const WRAP_REF_DOC = `${WRAP_DOC}    - id: publish
      kind: artifact.publish
      dependsOn:
        - review
      config:
        name: report.md
        mediaType: text/markdown
        note: nodes.review.outputs.summary
`;

describe("wrapInScope / unwrapScope", () => {
  it("wraps a 3-step chain into an until loop", () => {
    const result = wrapInScope(WRAP_DOC, ["implement", "test", "review"], { kind: "until" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = modelOfText(result.text);
    expect(findNode(model, "until")?.dependsOn).toEqual(["plan"]);
    expect(findNode(model, "implement")?.scope).toEqual(["until"]);
    expect(findNode(model, "implement")?.dependsOn).toEqual([]);
    expect(findNode(model, "test")?.dependsOn).toEqual(["implement"]);
    expect(findNode(model, "review")?.dependsOn).toEqual(["test"]);
    const body = (
      (
        parseDocument(result.text).toJS() as { spec: { nodes: Record<string, unknown>[] } }
      ).spec.nodes.find((n) => n.id === "until")?.config as Record<string, unknown>
    )?.body as { nodes: Record<string, unknown>[] };
    expect(body.nodes.map((n) => n.id)).toEqual(["implement", "test", "review"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("refuses to wrap steps from different scopes", () => {
    const result = wrapInScope(EDGE_DOC, ["a", "p"], { kind: "until" });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) expect(result.error).toMatch(/different scopes/);
  });

  it("refuses when an outside step reads a member's outputs", () => {
    const result = wrapInScope(WRAP_REF_DOC, ["implement", "test", "review"], {
      kind: "until",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/publish/);
      expect(result.error).toMatch(/resultBindings/);
    }
  });

  it("unwrap restores the equivalent dependsOn graph", () => {
    const wrapped = wrapInScope(WRAP_DOC, ["implement", "test", "review"], { kind: "until" });
    if (!wrapped.ok) throw new Error("wrap must work");
    const unwrapped = unwrapScope(wrapped.text, "until");
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    const model = modelOfText(unwrapped.text);
    expect(findNode(model, "until")).toBeUndefined();
    expect(findNode(model, "implement")?.dependsOn).toEqual(["plan"]);
    expect(findNode(model, "test")?.dependsOn).toEqual(["implement"]);
    expect(findNode(model, "review")?.dependsOn).toEqual(["test"]);
    expect(parseGraph(unwrapped.text).ok).toBe(true);
  });

  it("refuses to unwrap when an expression references the scope", () => {
    const wrapped = wrapInScope(WRAP_DOC, ["implement", "test", "review"], { kind: "until" });
    if (!wrapped.ok) throw new Error("wrap must work");
    const guarded = updateNodeFields(wrapped.text, "implement", {
      when: "nodes.until.outputs.done == true",
    });
    if (!guarded.ok) throw new Error("updateNodeFields must work");
    const result = unwrapScope(guarded.text, "until");
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/implement/);
    }
  });
});

describe("moveIntoScope", () => {
  it("moves an isolated node into a scope body", () => {
    const added = addNode(EDGE_DOC, { kind: "model.chat", id: "solo", scope: [] });
    if (!added.ok) throw new Error("addNode must work");
    const result = moveIntoScope(added.text, "solo", "loop");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = modelOfText(result.text);
    expect(findNode(model, "solo")?.scope).toEqual(["loop"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("refuses a node that still has edges in its scope", () => {
    const result = moveIntoScope(EDGE_DOC, "a", "loop");
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) expect(result.error).toMatch(/edges/);
  });
});
