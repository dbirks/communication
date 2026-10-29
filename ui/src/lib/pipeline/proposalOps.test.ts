/**
 * proposalOps tests: each op of the ADR-0044 closed set applied to the real
 * m4 probe fixture (document 1), the result re-parses, and untouched nodes
 * are byte-stable (ids, kinds, dependsOn and when are all unchanged).
 */
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { findNode, insertOnEdge, parseGraph, updateConfig, type OpResult } from "./graphDoc";
import { applyProposal, type ProposalOp } from "./proposalOps";

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

function failReason(result: OpResult): string {
  if (result.ok) return "";
  return "error" in result ? result.error : result.reasons.join("; ");
}

/** Re-parse text and walk every scope to find a node by id (plain JS). */
function nodeOf(text: string, id: string): Record<string, unknown> | undefined {
  const doc = parseDocument(text).toJS() as { spec?: { nodes?: unknown[] } };
  const walk = (nodes: unknown[] | undefined): Record<string, unknown> | undefined => {
    if (!Array.isArray(nodes)) return undefined;
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      if (node.id === id) return node;
      const config = node.config as { body?: { nodes?: unknown[] } } | undefined;
      const found = walk(config?.body?.nodes);
      if (found) return found;
      const branches = node.config as { branches?: { nodes?: unknown[] }[] } | undefined;
      for (const branch of branches?.branches ?? []) {
        const inBranch = walk(branch.nodes);
        if (inBranch) return inBranch;
      }
    }
    return undefined;
  };
  return walk(doc.spec?.nodes);
}

/** Every node id + kind + dependsOn + when, in document order. */
function fingerprint(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const doc = parseDocument(text).toJS() as { spec?: { nodes?: unknown[] } };
  const walk = (nodes: unknown[] | undefined): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      const id = String(node.id);
      map.set(id, JSON.stringify([node.kind, node.dependsOn ?? null, node.when ?? null]));
      const config = node.config as
        | {
            body?: { nodes?: unknown[] };
            branches?: { nodes?: unknown[] }[];
          }
        | undefined;
      walk(config?.body?.nodes);
      for (const branch of config?.branches ?? []) walk(branch.nodes);
    }
  };
  walk(doc.spec?.nodes);
  return map;
}

/** The fingerprint of every node the op did not touch must be unchanged. */
function untouchedUnchanged(before: string, after: string, touched: string[]): void {
  const beforeMap = fingerprint(before);
  const afterMap = fingerprint(after);
  const touchedSet = new Set(touched);
  for (const [id, fp] of beforeMap) {
    if (touchedSet.has(id)) continue;
    expect(afterMap.get(id), `node ${id} changed`).toBe(fp);
  }
}

describe("applyProposal · insert_after", () => {
  it("inserts a configured agent after a terminal step (root scope)", () => {
    // publish_needs_attention is a terminal root step (no dependents), so a
    // bare insert_after is well-formed there; insertAfter itself refuses a
    // step that still runs into others (see below). The seed's pre-gate
    // publisher publish_plan is NOT such an anchor — approve depends on it.
    // Inside the until body the seed's test_evidence is a second body exit
    // beside review (see the body-scope case below).
    const op: ProposalOp = {
      op: "insert_after",
      after: "publish_needs_attention",
      kind: "agent.acp",
      id: "assistant_note",
      config: {
        profile: "m4-reviewer",
        prompt: "Summarise the approved plan for the log.",
      },
    };
    const result = applyProposal(FIXTURE, op);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(failReason(result));
    // The new node re-parses where it should, wired and configured.
    const node = nodeOf(result.text, "assistant_note");
    expect(node).toMatchObject({
      id: "assistant_note",
      kind: "agent.acp",
      dependsOn: ["publish_needs_attention"],
      config: op.config,
    });
    const parsed = parseGraph(result.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    const placed = findNode(parsed.model, "assistant_note");
    expect(placed?.scope).toEqual([]);
    expect(placed?.dependsOn).toEqual(["publish_needs_attention"]);
    // Every other node (including approve's own dependencies) is untouched.
    untouchedUnchanged(FIXTURE, result.text, ["assistant_note"]);
  });

  it("appends after the seed's per-iteration publisher, inside the until body", () => {
    // test_evidence is a body exit (nothing depends on it), so a bare
    // insert_after is well-formed there — and it follows the anchor into the
    // loop body rather than pulling the new step to the root scope.
    const result = applyProposal(FIXTURE, {
      op: "insert_after",
      after: "test_evidence",
      kind: "agent.acp",
      id: "x_note",
      config: { profile: "m4-reviewer", prompt: "Note the iteration's evidence." },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(failReason(result));
    const parsed = parseGraph(result.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const placed = findNode(parsed.model, "x_note");
    expect(placed?.scope).toEqual(["build_until_verified"]);
    expect(placed?.dependsOn).toEqual(["test_evidence"]);
    expect(placed?.pointer).toBe("/spec/nodes/2/config/body/nodes/4");
    untouchedUnchanged(FIXTURE, result.text, ["x_note"]);
  });

  it("refuses an anchor that does not exist", () => {
    const result = applyProposal(FIXTURE, {
      op: "insert_after",
      after: "does_not_exist",
      kind: "agent.acp",
      id: "x_note",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/does_not_exist/);
  });

  it("refuses a step that already has dependents (insertAfter's own error)", () => {
    // plan runs into approve, so a bare insert_after is ambiguous-by-design:
    // the human gesture must pick the specific edge.
    const result = applyProposal(FIXTURE, {
      op: "insert_after",
      after: "plan",
      kind: "agent.acp",
      id: "x_note",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/plan still runs into approve/);
  });
});

describe("applyProposal · insert_on_edge", () => {
  it("splices implement→test into implement→assistant_gate→test", () => {
    const op: ProposalOp = {
      op: "insert_on_edge",
      from: "implement",
      to: "test", // both inside the build_until_verified until body
      kind: "process.exec",
      id: "assistant_gate",
      config: { command: "echo", args: ["gate"] },
    };
    const result = applyProposal(FIXTURE, op);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(failReason(result));
    const node = nodeOf(result.text, "assistant_gate");
    expect(node).toMatchObject({
      kind: "process.exec",
      dependsOn: ["implement"],
      config: op.config,
    });
    // The target now depends on the splice, not on implement.
    expect(nodeOf(result.text, "test")?.dependsOn).toEqual(["assistant_gate"]);
    // And the splice's downstream neighbour (review still waits on test).
    expect(nodeOf(result.text, "review")?.dependsOn).toEqual(["test"]);
    // Comments survive: the fixture header comment is still first.
    expect(result.text.startsWith("# docs/compatibility/probes")).toBe(true);
    untouchedUnchanged(FIXTURE, result.text, ["assistant_gate", "test"]);
  });

  it("refuses a cross-scope edge", () => {
    // dependsOn never crosses a scope boundary, so graphDoc reports the
    // connection as a missing edge rather than an ambiguity.
    const result = applyProposal(FIXTURE, {
      op: "insert_on_edge",
      from: "plan",
      to: "implement", // a different scope (inside build_until_verified)
      kind: "agent.acp",
      id: "x_gate",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/no edge plan -> implement/);
  });

  it("refuses an edge that is not there", () => {
    const result = applyProposal(FIXTURE, {
      op: "insert_on_edge",
      from: "approve",
      to: "fan_out",
      kind: "agent.acp",
      id: "x_gate",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/no edge approve -> fan_out/);
  });

  it("returns a binding edge as ambiguous instead of splicing blind", () => {
    // approve's config reads nodes.plan.*; graphDoc reports that binding as
    // the edge's reason, so the splice comes back ambiguous for the UI.
    const result = applyProposal(FIXTURE, {
      op: "insert_on_edge",
      from: "plan",
      to: "approve",
      kind: "agent.acp",
      id: "x_gate",
      config: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result) || !result.ambiguous)
      throw new Error(failReason(result));
    expect(result.reasons.join("; ")).toMatch(/approve reads nodes\.plan\.\*/);
  });

  it("returns the seed's plan -> publish_plan publisher edge as ambiguous", () => {
    // publish_plan is the pre-gate publication the § 7 exit seed added: it
    // reads nodes.plan.outputs, so splicing between plan and the publisher is
    // the same binding-edge ambiguity, reported with the publisher's own words.
    const result = applyProposal(FIXTURE, {
      op: "insert_on_edge",
      from: "plan",
      to: "publish_plan",
      kind: "agent.acp",
      id: "x_gate",
      config: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result) || !result.ambiguous)
      throw new Error(failReason(result));
    expect(result.reasons.join("; ")).toMatch(/publish_plan reads nodes\.plan\.\*/);
  });

  it("splices into the seed's two-dependency approve without dropping publish_plan", () => {
    // The seed made approve depend on [plan, publish_plan]. The human-gesture
    // path (the A3 ambiguity dialog's "Insert") replaces ONLY plan and keeps
    // the publisher in its original position — applyProposal never takes this
    // route (ADR-0044 returns ambiguous results to the UI untouched), so the
    // graphDoc op is what the dialog calls.
    const result = insertOnEdge(
      FIXTURE,
      { from: "plan", to: "approve" },
      { kind: "agent.acp", id: "x_gate" },
      { acceptAmbiguity: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nodeOf(result.text, "approve")?.dependsOn).toEqual(["x_gate", "publish_plan"]);
    expect(nodeOf(result.text, "publish_plan")?.dependsOn).toEqual(["plan"]);
    expect(nodeOf(result.text, "x_gate")?.dependsOn).toEqual(["plan"]);
    expect(parseGraph(result.text).ok).toBe(true);
  });

  it("returns a guarded edge as ambiguous for the UI to explain (ADR-0042 §4)", () => {
    const result = applyProposal(FIXTURE, {
      op: "insert_on_edge",
      from: "verdict",
      to: "publish_verified", // when: nodes.verdict.outputs.route == 'verified'
      kind: "agent.acp",
      id: "x_gate",
      config: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok || !("ambiguous" in result) || !result.ambiguous)
      throw new Error(failReason(result));
    // graphDoc's edge-reason wording, surfaced verbatim (no acceptAmbiguity).
    expect(result.reasons.join("; ")).toMatch(/publish_verified only runs when/);
  });

  it("is byte-identical to calling graphDoc.insertOnEdge + updateConfig directly", () => {
    const op: ProposalOp = {
      op: "insert_on_edge",
      from: "implement",
      to: "test",
      kind: "process.exec",
      id: "assistant_gate",
      config: { command: "echo", args: ["gate"] },
    };
    const viaProposal = applyProposal(FIXTURE, op);
    const direct = insertOnEdge(
      FIXTURE,
      { from: "implement", to: "test" },
      {
        kind: "process.exec",
        id: "assistant_gate",
      },
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error(failReason(direct));
    const configured = updateConfig(direct.text, "assistant_gate", op.config);
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error(failReason(configured));
    expect(viaProposal.ok).toBe(true);
    if (!viaProposal.ok) throw new Error(failReason(viaProposal));
    expect(viaProposal.text).toBe(configured.text);
  });
});

describe("applyProposal · update_prompt", () => {
  it("replaces plan's prompt and nothing else", () => {
    const before = nodeOf(FIXTURE, "plan")?.config as Record<string, unknown>;
    expect(typeof before?.prompt).toBe("string");
    const result = applyProposal(FIXTURE, {
      op: "update_prompt",
      node: "plan",
      prompt: "Plan the change. Prefer the smallest diff that passes the tests.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(failReason(result));
    const node = nodeOf(result.text, "plan");
    expect(node?.config).toMatchObject({
      prompt: "Plan the change. Prefer the smallest diff that passes the tests.",
    });
    // The rest of the config kept its values.
    expect(node?.config).toMatchObject({ profile: before.profile });
    untouchedUnchanged(FIXTURE, result.text, ["plan"]);
  });

  it("errors when the node does not exist", () => {
    const result = applyProposal(FIXTURE, {
      op: "update_prompt",
      node: "no_such_node",
      prompt: "hi",
    });
    expect(result.ok).toBe(false);
    expect(failReason(result)).toMatch(/no_such_node/);
  });
});
