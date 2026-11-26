import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { isDefinitionDocument, type DefinitionNode } from "../../../lib/pipeline/definition";
import { parseGraph } from "../../../lib/pipeline/graphDoc";
import { PIPELINE_SCHEMA_DEFS, type JsonSchema } from "../../../lib/pipeline/schemaAsset";
import {
  canWrap,
  goalSentence,
  readGoal,
  updateUntilGoal,
  verdictStepId,
  wrapInUntil,
  wrapSideBySide,
  type GoalKind,
} from "./wrapModel";

const SAMPLE_PIPELINE = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: wrap-test
  description: Test pipeline for wrap operations
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
  nodes:
    - id: plan
      kind: model.chat
      config:
        model: default
        messages:
          - role: user
            content: Make a plan
    - id: implement
      kind: agent.acp
      dependsOn: [plan]
      config:
        profile: coder
        prompt: Implement the plan
    - id: test
      kind: process.exec
      dependsOn: [implement]
      config:
        executable: sh
        args: []
    - id: review
      kind: agent.acp
      dependsOn: [test]
      config:
        profile: reviewer
        prompt: Review the changes
    - id: publish
      kind: human.approval
      dependsOn: [review]
      config:
        summary: Approve release?
`;

function validateAgainstSchemaDefs(rawDoc: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isDefinitionDocument(rawDoc)) {
    errors.push("Not a Pipeline DefinitionDocument");
    return errors;
  }
  const defs = PIPELINE_SCHEMA_DEFS;

  const checkConfig = (node: DefinitionNode, path: string) => {
    const allOf = (defs.node?.allOf as JsonSchema[] | undefined) ?? [];
    const clause = allOf.find((c) => {
      const k = c.if?.properties?.kind;
      return k?.const === node.kind || (Array.isArray(k?.enum) && k.enum.includes(node.kind));
    });
    if (!clause) return;
    const refName = (clause.then?.properties?.config as JsonSchema | undefined)?.$ref?.replace(
      /^#\/\$defs\//,
      "",
    );
    if (!refName || !defs[refName]) return;
    const cfgDef = defs[refName];
    const cfg = node.config ?? {};
    for (const req of cfgDef.required ?? []) {
      if (!(req in cfg)) {
        errors.push(`${path}.config missing required key "${req}"`);
      }
    }
    if (cfgDef.additionalProperties === false && cfgDef.properties) {
      for (const key of Object.keys(cfg)) {
        if (!(key in cfgDef.properties)) {
          errors.push(`${path}.config has unexpected additional property "${key}"`);
        }
      }
    }
    if (node.kind === "until") {
      const maxIter = cfg.maxIterations;
      if (typeof maxIter !== "number" || maxIter < 1 || maxIter > 32) {
        errors.push(`${path}.config.maxIterations out of range 1..32`);
      }
      if (typeof cfg.passWhen !== "string" || cfg.passWhen.length === 0) {
        errors.push(`${path}.config.passWhen must be non-empty`);
      }
      const bodyNodes = (cfg.body as { nodes?: DefinitionNode[] } | undefined)?.nodes ?? [];
      if (bodyNodes.length < 1) {
        errors.push(`${path}.config.body.nodes must have at least 1 node`);
      }
      bodyNodes.forEach((child, idx) => checkNode(child, `${path}.config.body.nodes[${idx}]`));
    }
    if (node.kind === "parallel") {
      const branches = (cfg.branches as { nodes?: DefinitionNode[] }[] | undefined) ?? [];
      if (branches.length < 1) {
        errors.push(`${path}.config.branches must have at least 1 branch`);
      }
      branches.forEach((branch, bi) => {
        const bNodes = branch.nodes ?? [];
        if (bNodes.length < 1) errors.push(`${path}.config.branches[${bi}].nodes empty`);
        bNodes.forEach((child, ni) =>
          checkNode(child, `${path}.config.branches[${bi}].nodes[${ni}]`),
        );
      });
    }
    if (node.kind === "process.exec") {
      const pattern = new RegExp(
        String(defs.configProcessExec.properties?.executable?.pattern ?? ".*"),
      );
      if (typeof cfg.executable !== "string" || !pattern.test(cfg.executable)) {
        errors.push(`${path}.config.executable "${String(cfg.executable)}" fails schema pattern`);
      }
    }
    if (node.kind === "model.chat") {
      if (typeof cfg.model !== "string" || cfg.model.length === 0) {
        errors.push(`${path}.config.model must be non-empty`);
      }
      const msgs = cfg.messages as { role?: string; content?: string }[] | undefined;
      if (!Array.isArray(msgs) || msgs.length === 0) {
        errors.push(`${path}.config.messages must be non-empty`);
      }
    }
  };

  const checkNode = (node: DefinitionNode, path: string) => {
    const idPat = new RegExp(String(defs.identifier.pattern));
    if (!idPat.test(node.id)) {
      errors.push(`${path}.id "${node.id}" fails identifier pattern`);
    }
    const allowedNodeKeys = new Set(Object.keys(defs.node.properties ?? {}));
    for (const k of Object.keys(node as unknown as Record<string, unknown>)) {
      if (!allowedNodeKeys.has(k)) {
        errors.push(`${path} has unexpected node property "${k}"`);
      }
    }
    checkConfig(node, path);
  };

  rawDoc.spec.nodes.forEach((n, idx) => checkNode(n, `spec.nodes[${idx}]`));
  return errors;
}

describe("canWrap", () => {
  it("accepts a contiguous selection in the same scope", () => {
    const parsed = parseGraph(SAMPLE_PIPELINE);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(canWrap(parsed.model, ["implement", "test", "review"])).toEqual({ ok: true });
  });

  it("refuses a non-contiguous selection with a sentence", () => {
    const parsed = parseGraph(SAMPLE_PIPELINE);
    if (!parsed.ok) throw new Error(parsed.error);
    const res = canWrap(parsed.model, ["implement", "review"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/\.$/);
      expect(res.reason.toLowerCase()).toContain("contiguous");
    }
  });

  it("refuses an empty selection, duplicates, different scopes, and existing scopes", () => {
    const parsed = parseGraph(SAMPLE_PIPELINE);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(canWrap(parsed.model, []).ok).toBe(false);
    expect(canWrap(parsed.model, ["implement", "implement"]).ok).toBe(false);

    const wrapped = wrapInUntil(SAMPLE_PIPELINE, ["implement", "test"], {
      kind: "command",
      text: "pnpm test",
      maxRounds: 3,
    });
    if (!wrapped.ok) throw new Error("wrap failed");
    const after = parseGraph(wrapped.text);
    if (!after.ok) throw new Error(after.error);

    const mixed = canWrap(after.model, ["plan", "implement"]);
    expect(mixed.ok).toBe(false);
    const scopeSel = canWrap(after.model, ["until"]);
    expect(scopeSel.ok).toBe(false);
  });

  it("refuses a selection that would create a cycle via an outside intermediate step", () => {
    const diamond = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: diamond
spec:
  inputs:
    type: object
  nodes:
    - id: a
      kind: model.chat
      config:
        model: default
        messages: [{ role: user, content: a }]
    - id: b
      kind: model.chat
      dependsOn: [a]
      config:
        model: default
        messages: [{ role: user, content: b }]
    - id: c
      kind: model.chat
      dependsOn: [a, b]
      config:
        model: default
        messages: [{ role: user, content: c }]
`;
    const parsed = parseGraph(diamond);
    if (!parsed.ok) throw new Error(parsed.error);
    const res = canWrap(parsed.model, ["a", "c"]);
    expect(res.ok).toBe(false);
  });
});

describe("wrapInUntil + readGoal", () => {
  it.each<{ kind: GoalKind; text: string; maxRounds: number }>([
    {
      kind: "judge",
      text: 'Tests pass and "edge cases" are covered',
      maxRounds: 4,
    },
    {
      kind: "command",
      text: "pnpm test --filter api",
      maxRounds: 5,
    },
    {
      kind: "contains",
      text: "LGTM",
      maxRounds: 2,
    },
  ])(
    "wraps $kind, validates against schema + graphDoc, and round-trips through readGoal",
    (goal) => {
      const res = wrapInUntil(SAMPLE_PIPELINE, ["implement", "test", "review"], goal);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const graph = parseGraph(res.text);
      expect(graph.ok).toBe(true);

      const jsDoc = parseDocument(res.text).toJS() as Record<string, unknown>;
      expect(validateAgainstSchemaDefs(jsDoc)).toEqual([]);

      const docTyped = jsDoc as unknown as { spec: { nodes: DefinitionNode[] } };
      const untilNode = docTyped.spec.nodes.find((n) => n.kind === "until");
      expect(untilNode).toBeDefined();
      expect(untilNode?.config?.maxIterations).toBe(goal.maxRounds);

      const parsedGoal = readGoal(untilNode);
      expect(parsedGoal).toEqual(goal);
    },
  );

  it("handles shell commands cleanly for command kind and reads them back", () => {
    const goal = { kind: "command" as const, text: "./scripts/check.sh && echo ok", maxRounds: 6 };
    const res = wrapInUntil(SAMPLE_PIPELINE, ["implement", "test"], goal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const jsDoc = parseDocument(res.text).toJS() as Record<string, unknown>;
    expect(validateAgainstSchemaDefs(jsDoc)).toEqual([]);
    const untilNode = (jsDoc as { spec: { nodes: DefinitionNode[] } }).spec.nodes.find(
      (n) => n.kind === "until",
    );
    expect(readGoal(untilNode)).toEqual(goal);
  });

  it("distinguishes contains('GOAL_MET') on a non-judge node from a judge loop", () => {
    const goal = { kind: "contains" as const, text: "GOAL_MET", maxRounds: 3 };
    const res = wrapInUntil(SAMPLE_PIPELINE, ["implement", "test", "review"], goal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const jsDoc = parseDocument(res.text).toJS() as { spec: { nodes: DefinitionNode[] } };
    const untilNode = jsDoc.spec.nodes.find((n) => n.kind === "until");
    expect(readGoal(untilNode)).toEqual(goal);
  });

  it("readGoal returns null for non-until or custom passWhen loops", () => {
    expect(readGoal(null)).toBeNull();
    expect(readGoal({ id: "a", kind: "model.chat", config: {} })).toBeNull();
    expect(
      readGoal({
        id: "loop",
        kind: "until",
        config: {
          maxIterations: 3,
          passWhen: "nodes.review.outputs.approved == true",
          body: { nodes: [{ id: "review", kind: "agent.acp" }] },
        },
      }),
    ).toBeNull();
  });
});

describe("wrapSideBySide", () => {
  it("wraps selected steps as parallel branches with join: all and preserves outer edges", () => {
    const res = wrapSideBySide(SAMPLE_PIPELINE, ["implement", "test", "review"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const graph = parseGraph(res.text);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    const jsDoc = parseDocument(res.text).toJS() as Record<string, unknown>;
    expect(validateAgainstSchemaDefs(jsDoc)).toEqual([]);

    const parNode = (jsDoc as { spec: { nodes: DefinitionNode[] } }).spec.nodes.find(
      (n) => n.kind === "parallel",
    );
    expect(parNode).toBeDefined();
    expect(parNode?.dependsOn).toEqual(["plan"]);
    expect(parNode?.config?.join).toBe("all");
    const branches = parNode?.config?.branches as { nodes: DefinitionNode[] }[];
    expect(branches).toHaveLength(3);
    expect(branches.map((b) => b.nodes[0].id)).toEqual(["implement", "test", "review"]);
    for (const branch of branches) {
      expect(branch.nodes[0].dependsOn).toBeUndefined();
    }

    const publishNode = (jsDoc as { spec: { nodes: DefinitionNode[] } }).spec.nodes.find(
      (n) => n.id === "publish",
    );
    expect(publishNode?.dependsOn).toEqual([parNode!.id]);
  });
});

describe("goalSentence", () => {
  it("returns the exact sentence per GoalKind", () => {
    expect(goalSentence("judge")).toBe("Repeat until a judge says:");
    expect(goalSentence("command")).toBe("Repeat until this command passes:");
    expect(goalSentence("contains")).toBe("Repeat until the output contains:");
    expect(goalSentence({ kind: "judge" })).toBe("Repeat until a judge says:");
  });
});

describe("updateUntilGoal + verdictStepId", () => {
  it("updates goal text/rounds in place and switches across goal kinds cleanly", () => {
    const wrapped = wrapInUntil(SAMPLE_PIPELINE, ["implement", "test"], {
      kind: "judge",
      text: "Tests pass",
      maxRounds: 3,
    });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    const updatedSame = updateUntilGoal(wrapped.text, "until", {
      kind: "judge",
      text: "All unit and integration tests pass",
      maxRounds: 6,
    });
    expect(updatedSame.ok).toBe(true);
    if (!updatedSame.ok) return;
    let jsDoc = parseDocument(updatedSame.text).toJS() as { spec: { nodes: DefinitionNode[] } };
    expect(validateAgainstSchemaDefs(jsDoc as unknown as Record<string, unknown>)).toEqual([]);
    let untilNode = jsDoc.spec.nodes.find((n) => n.id === "until");
    expect(readGoal(untilNode)).toEqual({
      kind: "judge",
      text: "All unit and integration tests pass",
      maxRounds: 6,
    });
    expect(verdictStepId(untilNode)).toBe("judge");

    const switchedCmd = updateUntilGoal(updatedSame.text, "until", {
      kind: "command",
      text: "pnpm test",
      maxRounds: 4,
    });
    expect(switchedCmd.ok).toBe(true);
    if (!switchedCmd.ok) return;
    jsDoc = parseDocument(switchedCmd.text).toJS() as { spec: { nodes: DefinitionNode[] } };
    expect(validateAgainstSchemaDefs(jsDoc as unknown as Record<string, unknown>)).toEqual([]);
    untilNode = jsDoc.spec.nodes.find((n) => n.id === "until");
    expect(readGoal(untilNode)).toEqual({
      kind: "command",
      text: "pnpm test",
      maxRounds: 4,
    });
    expect(verdictStepId(untilNode)).toBe("check");
  });
});
