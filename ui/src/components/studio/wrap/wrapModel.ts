/**
 * wrapModel.ts — pure YAML-preserving helpers for wrapping canvas selections
 * into `until` (Repeat until) and `parallel` (Side by side) scopes, and for
 * reading the structured goal back out of an `until` scope for GoalFrame.
 *
 * How each Repeat-until GoalKind is represented in today's schema & engine
 * (internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json):
 *
 * Neither `node` nor `configUntil` admits a `name`, `description`, or custom
 * metadata field (`additionalProperties: false` on both), so no fields are
 * invented. All three kinds compile against today's v1alpha1 schema and CEL
 * subset (internal/pipelines/expr/env.go):
 *
 * 1. `judge`:
 *    Appends a `model.chat` step (`id`: unique `judge` / `judge_2`…) as the
 *    last child inside `until.config.body.nodes`, depending on the wrapped
 *    subgraph's exit nodes, with:
 *      - `config.model`: caller-provided `model` or `"default"`
 *      - `config.messages`: `[{ role: "user", content:
 *          'Decide whether this goal is met: "<escapedText>". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.' }]`
 *      - `outputs`: `{ type: "object", properties: { text: { type: "string" } } }`
 *    and sets `until.config.passWhen` to:
 *      `nodes.<judgeId>.status == 'succeeded' && has(nodes.<judgeId>.outputs.text) && nodes.<judgeId>.outputs.text.contains('GOAL_MET')`
 *    `readGoal` identifies a judge loop by matching this `passWhen` + prompt
 *    format on the referenced `model.chat` (or `agent.acp`) child step and
 *    extracting the goal text from the prompt.
 *
 * 2. `command`:
 *    Appends a `process.exec` step (`id`: unique `check` / `check_2`…) as the
 *    last child inside `until.config.body.nodes`, depending on the wrapped
 *    subgraph's exit nodes, with `config.executable` + `config.args` parsed
 *    from the command text (falling back to `executable: "sh", args: ["-c", text]`
 *    when shell operators or path separators appear), declares
 *      `outputs`: `{ type: "object", required: ["exit_code"], properties: { exit_code: { type: "integer" } } }`
 *    and sets `until.config.passWhen` to:
 *      `nodes.<cmdId>.status == 'succeeded' && has(nodes.<cmdId>.outputs.exit_code) && nodes.<cmdId>.outputs.exit_code == 0`
 *
 * 3. `contains`:
 *    Targets the last exit node of the wrapped subgraph (`lastId`), chooses its
 *    primary string output field (`text`, `summary`, `stdout_preview`, `output`,
 *    `message`, `result`, or the first declared `type: "string"` property —
 *    defaulting by node kind if no `outputs` schema is declared yet and adding a
 *    non-restrictive `outputs` schema with that string property when absent so
 *    the Go CEL compiler accepts the field reference), and sets
 *    `until.config.passWhen` to:
 *      `nodes.<lastId>.status == 'succeeded' && has(nodes.<lastId>.outputs.<field>) && nodes.<lastId>.outputs.<field>.contains('<escapedText>')`
 */
import { Document, isMap, isSeq, parseDocument, YAMLMap, type YAMLSeq } from "yaml";
import { toBlockString } from "../../../lib/pipeline/blockYaml";
import type { DefinitionNode } from "../../../lib/pipeline/definition";
import {
  findNode,
  isValidId,
  parseGraph,
  uniqueId,
  wrapInScope,
  type GraphModel,
  type GraphNode,
  type OpResult,
  type ScopePath,
} from "../../../lib/pipeline/graphDoc";

export type GoalKind = "judge" | "command" | "contains";

export interface GoalSpec {
  kind: GoalKind;
  text: string;
  maxRounds: number;
}

export type CanWrapResult = { ok: true } | { ok: false; reason: string };

export type WrapResult = OpResult | { ok: false; unsupported: string };

const MAX_ROUNDS_LIMIT = 32;
const EXECUTABLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const JUDGE_PROMPT_PREFIX = 'Decide whether this goal is met: "';
const JUDGE_PROMPT_SUFFIX =
  '". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.';

function sameScope(a: ScopePath, b: ScopePath): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

function escapePromptQuotes(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapePromptQuotes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i += 1;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

function celStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

function parseCelStringLiteral(literal: string): string | null {
  if (literal.length < 2) return null;
  const quote = literal[0];
  if ((quote !== "'" && quote !== '"') || literal[literal.length - 1] !== quote) {
    return null;
  }
  const inner = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

function judgePromptFor(goalText: string): string {
  return `${JUDGE_PROMPT_PREFIX}${escapePromptQuotes(goalText)}${JUDGE_PROMPT_SUFFIX}`;
}

function extractJudgeGoalFromPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith(JUDGE_PROMPT_PREFIX) || !trimmed.endsWith(JUDGE_PROMPT_SUFFIX)) {
    return null;
  }
  const raw = trimmed.slice(
    JUDGE_PROMPT_PREFIX.length,
    trimmed.length - JUDGE_PROMPT_SUFFIX.length,
  );
  return unescapePromptQuotes(raw);
}

/**
 * Split a command string into `process.exec` `{ executable, args }`, falling
 * back to `sh -c <cmd>` when shell metacharacters or path separators appear.
 */
function splitCommand(command: string): { executable: string; args: string[] } {
  const trimmed = command.trim();
  if (/[|&;<>()$`\\]/.test(trimmed)) {
    return { executable: "sh", args: ["-c", trimmed] };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) {
    return { executable: "sh", args: ["-c", trimmed] };
  }
  if (hasToken) tokens.push(current);
  if (tokens.length === 0 || !EXECUTABLE_PATTERN.test(tokens[0])) {
    return { executable: "sh", args: ["-c", trimmed] };
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}

function joinCommand(executable: string, args: unknown): string {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (executable === "sh" && list.length === 2 && list[0] === "-c") {
    return list[1];
  }
  const formattedArgs = list.map((arg) => {
    if (arg === "") return '""';
    if (/[\s"']/.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`;
    return arg;
  });
  return [executable, ...formattedArgs].join(" ");
}

/**
 * Checks whether wrapping `idSet` within `scope` would create a cycle through
 * an outside sibling node (e.g. `a -> b -> c` with `a -> c` and selecting `{a, c}`).
 */
function hasOutsideIntermediateCycle(
  model: GraphModel,
  idSet: Set<string>,
  scope: ScopePath,
): boolean {
  const forward = new Map<string, string[]>();
  const scopeNodes = model.nodes.filter((n) => sameScope(n.scope, scope));
  for (const n of scopeNodes) {
    for (const dep of n.dependsOn) {
      const list = forward.get(dep) ?? [];
      list.push(n.id);
      forward.set(dep, list);
    }
  }
  // BFS from every outside node that depends on a selected node; if it can
  // reach any selected node, wrapping the selection would introduce a cycle.
  const starts = scopeNodes
    .filter((n) => !idSet.has(n.id) && n.dependsOn.some((dep) => idSet.has(dep)))
    .map((n) => n.id);
  const visited = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of forward.get(cur) ?? []) {
      if (idSet.has(next)) return true;
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

/**
 * Check whether `nodeIds` can be wrapped into a scope using the same structural
 * rules as `wrapInScope` (non-empty, unique, same scope, non-scope, contiguous
 * without gaps).
 */
export function canWrap(model: GraphModel, nodeIds: string[]): CanWrapResult {
  if (nodeIds.length === 0) {
    return { ok: false, reason: "Select at least one step to wrap." };
  }
  if (new Set(nodeIds).size !== nodeIds.length) {
    return { ok: false, reason: "Duplicate steps cannot be wrapped." };
  }
  const found: GraphNode[] = [];
  for (const id of nodeIds) {
    const node = findNode(model, id);
    if (!node) {
      return { ok: false, reason: `Step "${id}" was not found.` };
    }
    if (found.length > 0 && !sameScope(node.scope, found[0].scope)) {
      return { ok: false, reason: "Steps in different scopes cannot be wrapped together." };
    }
    if (node.isScope) {
      return { ok: false, reason: `"${id}" is already a scope and cannot be wrapped.` };
    }
    found.push(node);
  }
  const idSet = new Set(nodeIds);
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of model.edges) {
    if (edge.kind === "error" || !idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
    adj.get(edge.to)!.push(edge.from);
  }
  const seen = new Set<string>([nodeIds[0]]);
  const stack = [nodeIds[0]];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  if (seen.size !== idSet.size) {
    return { ok: false, reason: "Selected steps must be contiguous without gaps." };
  }
  if (hasOutsideIntermediateCycle(model, idSet, found[0].scope)) {
    return {
      ok: false,
      reason: "Selected steps must be contiguous without outside steps in between.",
    };
  }
  return { ok: true };
}

function findNodeMapInDoc(doc: Document, id: string): YAMLMap | null {
  const root = doc.contents;
  if (!isMap(root)) return null;
  const spec = root.get("spec");
  if (!isMap(spec)) return null;
  const nodes = spec.get("nodes");
  if (!isSeq(nodes)) return null;

  const visit = (list: YAMLSeq): YAMLMap | null => {
    for (const item of list.items) {
      if (!isMap(item)) continue;
      if (item.get("id") === id) return item;
      const cfg = item.get("config");
      if (!isMap(cfg)) continue;
      const body = cfg.get("body");
      if (isMap(body) && isSeq(body.get("nodes"))) {
        const found = visit(body.get("nodes") as YAMLSeq);
        if (found) return found;
      }
      const branches = cfg.get("branches");
      if (isSeq(branches)) {
        for (const branch of branches.items) {
          if (isMap(branch) && isSeq(branch.get("nodes"))) {
            const found = visit(branch.get("nodes") as YAMLSeq);
            if (found) return found;
          }
        }
      }
    }
    return null;
  };

  return visit(nodes);
}

function scopeExitNodeIds(bodyNodes: YAMLSeq): string[] {
  const maps = bodyNodes.items.filter((item): item is YAMLMap => isMap(item));
  const ids = new Set(maps.map((m) => String(m.get("id") ?? "")));
  const dependedOn = new Set<string>();
  for (const m of maps) {
    const deps = m.get("dependsOn");
    if (!isSeq(deps)) continue;
    for (const dep of deps.items) {
      const depId = String(dep);
      if (ids.has(depId)) dependedOn.add(depId);
    }
  }
  const exits = maps.map((m) => String(m.get("id") ?? "")).filter((id) => !dependedOn.has(id));
  if (exits.length > 0) return exits;
  return maps.length > 0 ? [String(maps[maps.length - 1].get("id") ?? "")] : [];
}

const PREFERRED_TEXT_FIELDS = ["text", "summary", "stdout_preview", "output", "message", "result"];

function pickStringOutputField(node: YAMLMap): { field: string; needsSchema: boolean } {
  const outputs = node.get("outputs");
  if (isMap(outputs)) {
    const props = outputs.get("properties");
    if (isMap(props)) {
      const stringFields: string[] = [];
      for (const pair of props.items) {
        const key = String(pair.key);
        const val = pair.value;
        if (isMap(val)) {
          const typeVal = val.get("type");
          if (typeVal === "string") stringFields.push(key);
        }
      }
      for (const preferred of PREFERRED_TEXT_FIELDS) {
        if (stringFields.includes(preferred)) {
          return { field: preferred, needsSchema: false };
        }
      }
      if (stringFields.length > 0) {
        return { field: stringFields[0], needsSchema: false };
      }
    }
  }
  const kind = String(node.get("kind") ?? "");
  if (kind === "process.exec") return { field: "stdout_preview", needsSchema: !isMap(outputs) };
  if (kind === "human.approval") return { field: "comments", needsSchema: !isMap(outputs) };
  if (kind === "condition") return { field: "route", needsSchema: !isMap(outputs) };
  return { field: "text", needsSchema: !isMap(outputs) };
}

/**
 * Wrap `nodeIds` in an `until` scope configured for `goal`.
 */
export function wrapInUntil(
  text: string,
  nodeIds: string[],
  goal: GoalSpec,
  opts?: { id?: string; model?: string },
): WrapResult {
  const trimmedText = goal.text.trim();
  if (!trimmedText) {
    return { ok: false, error: "Enter the repeat-until condition before wrapping." };
  }
  if (
    !Number.isInteger(goal.maxRounds) ||
    goal.maxRounds < 1 ||
    goal.maxRounds > MAX_ROUNDS_LIMIT
  ) {
    return {
      ok: false,
      error: `Max rounds must be a whole number between 1 and ${MAX_ROUNDS_LIMIT}.`,
    };
  }
  const parsed = parseGraph(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const check = canWrap(parsed.model, nodeIds);
  if (!check.ok) {
    return { ok: false, error: check.reason };
  }

  const wrapped = wrapInScope(text, nodeIds, { kind: "until", id: opts?.id });
  if (!wrapped.ok) return wrapped;

  const scopeId = wrapped.changed[0];
  const doc = parseDocument(wrapped.text);
  if (doc.errors.length > 0) {
    return { ok: false, error: doc.errors[0].message };
  }
  const afterModel = parseGraph(wrapped.text);
  if (!afterModel.ok) {
    return { ok: false, error: afterModel.error };
  }
  const scopeItem = findNodeMapInDoc(doc, scopeId);
  if (!scopeItem) {
    return { ok: false, error: `Wrapped scope "${scopeId}" was not found.` };
  }
  const cfg = scopeItem.get("config") as YAMLMap;
  const body = cfg.get("body") as YAMLMap;
  const bodyNodes = body.get("nodes") as YAMLSeq;
  const exitIds = scopeExitNodeIds(bodyNodes);
  const changed = [...wrapped.changed];

  cfg.set("maxIterations", goal.maxRounds);

  if (goal.kind === "command") {
    const cmdId = uniqueId(afterModel.model, "check");
    const cmdSpec = splitCommand(trimmedText);
    const cmdNode: Record<string, unknown> = {
      id: cmdId,
      kind: "process.exec",
      ...(exitIds.length > 0 ? { dependsOn: exitIds } : {}),
      config: {
        executable: cmdSpec.executable,
        args: cmdSpec.args,
      },
      outputs: {
        type: "object",
        required: ["exit_code"],
        properties: {
          exit_code: { type: "integer" },
        },
      },
    };
    bodyNodes.add(doc.createNode(cmdNode));
    cfg.set(
      "passWhen",
      `nodes.${cmdId}.status == 'succeeded' && has(nodes.${cmdId}.outputs.exit_code) && nodes.${cmdId}.outputs.exit_code == 0`,
    );
    changed.push(cmdId);
  } else if (goal.kind === "judge") {
    const judgeId = uniqueId(afterModel.model, "judge");
    const modelName = opts?.model?.trim() || "default";
    const judgeNode: Record<string, unknown> = {
      id: judgeId,
      kind: "model.chat",
      ...(exitIds.length > 0 ? { dependsOn: exitIds } : {}),
      config: {
        model: modelName,
        messages: [
          {
            role: "user",
            content: judgePromptFor(trimmedText),
          },
        ],
      },
      outputs: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
        },
      },
    };
    bodyNodes.add(doc.createNode(judgeNode));
    cfg.set(
      "passWhen",
      `nodes.${judgeId}.status == 'succeeded' && has(nodes.${judgeId}.outputs.text) && nodes.${judgeId}.outputs.text.contains('GOAL_MET')`,
    );
    changed.push(judgeId);
  } else {
    const lastId = exitIds[exitIds.length - 1];
    const lastNode = findNodeMapInDoc(doc, lastId);
    if (!lastNode) {
      return { ok: false, error: `Last step "${lastId}" was not found inside the loop.` };
    }
    const { field, needsSchema } = pickStringOutputField(lastNode);
    if (needsSchema) {
      lastNode.set(
        "outputs",
        doc.createNode({
          type: "object",
          properties: {
            [field]: { type: "string" },
          },
        }),
      );
    }
    cfg.set(
      "passWhen",
      `nodes.${lastId}.status == 'succeeded' && has(nodes.${lastId}.outputs.${field}) && nodes.${lastId}.outputs.${field}.contains(${celStringLiteral(trimmedText)})`,
    );
  }

  return {
    ok: true,
    text: toBlockString(doc),
    changed,
  };
}

function listAtScope(doc: Document, scope: ScopePath): { list: YAMLSeq } | { error: string } {
  const root = doc.contents;
  if (!isMap(root) || root.get("kind") !== "Pipeline") {
    return { error: "document is not a Pipeline with spec.nodes" };
  }
  const spec = root.get("spec");
  if (!isMap(spec) || !isSeq(spec.get("nodes"))) {
    return { error: "document is not a Pipeline with spec.nodes" };
  }
  let list = spec.get("nodes") as YAMLSeq;
  let i = 0;
  while (i < scope.length) {
    const id = scope[i];
    i += 1;
    const item = list.items.find((entry) => isMap(entry) && entry.get("id") === id);
    if (!isMap(item)) return { error: `node ${id} not found` };
    const cfg = item.get("config");
    if (!isMap(cfg)) return { error: `node ${id} has no config` };
    if (i < scope.length) {
      const bi = Number(scope[i]);
      i += 1;
      const branches = cfg.get("branches");
      if (!isSeq(branches) || !Number.isInteger(bi) || bi < 0 || bi >= branches.items.length) {
        return { error: `branch ${bi} of ${id} not found` };
      }
      const branch = branches.items[bi];
      if (!isMap(branch) || !isSeq(branch.get("nodes"))) {
        return { error: `branch ${bi} of ${id} has no nodes list` };
      }
      list = branch.get("nodes") as YAMLSeq;
    } else {
      const body = cfg.get("body");
      if (!isMap(body) || !isSeq(body.get("nodes"))) {
        return { error: `node ${id} has no body` };
      }
      list = body.get("nodes") as YAMLSeq;
    }
  }
  return { list };
}

function collectAllNodeMaps(doc: Document): YAMLMap[] {
  const out: YAMLMap[] = [];
  const root = doc.contents;
  if (!isMap(root)) return out;
  const spec = root.get("spec");
  if (!isMap(spec) || !isSeq(spec.get("nodes"))) return out;
  const walk = (seq: YAMLSeq) => {
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      out.push(item);
      const cfg = item.get("config");
      if (!isMap(cfg)) continue;
      const body = cfg.get("body");
      if (isMap(body) && isSeq(body.get("nodes"))) {
        walk(body.get("nodes") as YAMLSeq);
      }
      const branches = cfg.get("branches");
      if (isSeq(branches)) {
        for (const branch of branches.items) {
          if (isMap(branch) && isSeq(branch.get("nodes"))) {
            walk(branch.get("nodes") as YAMLSeq);
          }
        }
      }
    }
  };
  walk(spec.get("nodes") as YAMLSeq);
  return out;
}

/**
 * Wrap sibling steps as branches of a `parallel` scope with `join: "all"`.
 */
export function wrapSideBySide(text: string, nodeIds: string[], opts?: { id?: string }): OpResult {
  if (nodeIds.length === 0) {
    return { ok: false, error: "Select at least one step to wrap." };
  }
  if (new Set(nodeIds).size !== nodeIds.length) {
    return { ok: false, error: "Duplicate steps cannot be wrapped." };
  }
  const parsed = parseGraph(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const model = parsed.model;
  const found: GraphNode[] = [];
  for (const id of nodeIds) {
    const n = findNode(model, id);
    if (!n) return { ok: false, error: `Step "${id}" was not found.` };
    if (found.length > 0 && !sameScope(n.scope, found[0].scope)) {
      return { ok: false, error: "Steps in different scopes cannot be wrapped together." };
    }
    if (n.isScope) {
      return { ok: false, error: `"${id}" is already a scope and cannot be wrapped.` };
    }
    found.push(n);
  }
  const idSet = new Set(nodeIds);
  if (hasOutsideIntermediateCycle(model, idSet, found[0].scope)) {
    return {
      ok: false,
      error: "Selected steps must be contiguous without outside steps in between.",
    };
  }
  const scopeId = opts?.id ?? uniqueId(model, "parallel");
  if (!isValidId(scopeId)) {
    return { ok: false, error: "ids use lowercase letters, digits and _ (start with a letter)" };
  }
  if (model.nodes.some((n) => n.id === scopeId)) {
    return { ok: false, error: `node id ${scopeId} is already used` };
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { ok: false, error: doc.errors[0].message };
  }
  const allItems = collectAllNodeMaps(doc);
  const referrers = allItems
    .filter((item) => {
      const itemId = String(item.get("id"));
      if (idSet.has(itemId) || itemId === scopeId) return false;
      const nodeText = item.toString();
      return nodeIds.some((memberId) => nodeText.includes(`nodes.${memberId}.`));
    })
    .map((item) => String(item.get("id")));
  if (referrers.length > 0) {
    return {
      ok: false,
      error: `cannot wrap into parallel: ${referrers.join(", ")} reference nodes.<member>.`,
    };
  }

  const at = listAtScope(doc, found[0].scope);
  if ("error" in at) return { ok: false, error: at.error };

  const firstIdx = Math.min(
    ...nodeIds.map((id) => at.list.items.findIndex((item) => isMap(item) && item.get("id") === id)),
  );
  if (firstIdx < 0) return { ok: false, error: `Step "${nodeIds[0]}" was not found.` };

  const members: YAMLMap[] = [];
  for (const item of at.list.items) {
    if (isMap(item) && idSet.has(String(item.get("id")))) {
      members.push(item);
    }
  }
  if (members.length !== idSet.size) {
    return { ok: false, error: "not all wrapped steps were found" };
  }

  const outerDeps: string[] = [];
  const changed: string[] = [scopeId];
  for (const member of members) {
    changed.push(String(member.get("id")));
    const deps = member.get("dependsOn");
    if (isSeq(deps)) {
      for (const d of deps.items) {
        const s = String(d);
        if (!idSet.has(s) && !outerDeps.includes(s)) outerDeps.push(s);
      }
      // Branches inside a parallel scope are isolated scopes; intra-selection
      // dependsOn edges are removed so each step runs as its own branch.
      member.delete("dependsOn");
    }
  }

  const scopeVal: Record<string, unknown> = {
    id: scopeId,
    kind: "parallel",
    ...(outerDeps.length > 0 ? { dependsOn: outerDeps } : {}),
    config: {
      join: "all",
      branches: members.map((member) => ({ nodes: [member] })),
    },
  };
  const scopeItem = doc.createNode(scopeVal) as YAMLMap;

  for (const member of members) {
    const idx = at.list.items.indexOf(member);
    if (idx >= 0) at.list.delete(idx);
  }
  at.list.items.splice(firstIdx, 0, scopeItem);

  for (const item of at.list.items) {
    if (!isMap(item)) continue;
    const deps = item.get("dependsOn");
    if (!isSeq(deps) || !deps.items.some((d) => idSet.has(String(d)))) continue;
    const next = [...new Set(deps.items.map((d) => (idSet.has(String(d)) ? scopeId : String(d))))];
    item.set("dependsOn", doc.createNode(next));
    changed.push(String(item.get("id")));
  }

  return {
    ok: true,
    text: toBlockString(doc),
    changed,
  };
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (isMap(value)) {
    return value.toJS(new Document()) as Record<string, unknown>;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nodePromptText(node: Record<string, unknown>): string | null {
  const cfg = asPlainObject(node.config);
  if (!cfg) return null;
  if (node.kind === "model.chat" && Array.isArray(cfg.messages)) {
    for (let i = cfg.messages.length - 1; i >= 0; i -= 1) {
      const msg = asPlainObject(cfg.messages[i]);
      if (msg && typeof msg.content === "string") return msg.content;
    }
  }
  if (node.kind === "agent.acp" && typeof cfg.prompt === "string") {
    return cfg.prompt;
  }
  return null;
}

const CONTAINS_RE =
  /nodes\.([a-z][a-z0-9_]{0,62})\.outputs\.[a-zA-Z0-9_]+\.contains\((['"](?:\\.|[^\\])*?['"])\)/;
const CMD_EXIT_ZERO_RE =
  /(?:nodes\.([a-z][a-z0-9_]{0,62})\.outputs\.exit_code\s*==\s*0|0\s*==\s*nodes\.([a-z][a-z0-9_]{0,62})\.outputs\.exit_code)/;

/**
 * Reconstruct the structured goal (`judge`, `command`, or `contains`) from an
 * `until` scope definition node, or `null` if the scope is not a recognized goal loop.
 */
export function readGoal(
  scope: DefinitionNode | Record<string, unknown> | null | undefined,
): GoalSpec | null {
  const node = asPlainObject(scope);
  if (!node || node.kind !== "until") return null;
  const cfg = asPlainObject(node.config);
  if (!cfg) return null;
  const maxRounds = cfg.maxIterations;
  const passWhen = cfg.passWhen;
  if (
    typeof maxRounds !== "number" ||
    !Number.isFinite(maxRounds) ||
    typeof passWhen !== "string"
  ) {
    return null;
  }
  const body = asPlainObject(cfg.body);
  const bodyNodes = Array.isArray(body?.nodes)
    ? body.nodes
        .map((n) => asPlainObject(n))
        .filter((n): n is Record<string, unknown> => n !== null)
    : [];

  const cmdMatch = CMD_EXIT_ZERO_RE.exec(passWhen);
  if (cmdMatch) {
    const cmdId = cmdMatch[1] ?? cmdMatch[2];
    const cmdNode = bodyNodes.find((n) => n.id === cmdId && n.kind === "process.exec");
    const cmdCfg = cmdNode ? asPlainObject(cmdNode.config) : null;
    if (cmdCfg && typeof cmdCfg.executable === "string") {
      return {
        kind: "command",
        text: joinCommand(cmdCfg.executable, cmdCfg.args),
        maxRounds,
      };
    }
  }

  const containsMatch = CONTAINS_RE.exec(passWhen);
  if (containsMatch) {
    const stepId = containsMatch[1];
    const needle = parseCelStringLiteral(containsMatch[2]);
    if (needle !== null) {
      if (needle === "GOAL_MET") {
        const judgeNode = bodyNodes.find((n) => n.id === stepId);
        const prompt = judgeNode ? nodePromptText(judgeNode) : null;
        const extracted = prompt ? extractJudgeGoalFromPrompt(prompt) : null;
        if (extracted !== null) {
          return {
            kind: "judge",
            text: extracted,
            maxRounds,
          };
        }
      }
      return {
        kind: "contains",
        text: needle,
        maxRounds,
      };
    }
  }

  return null;
}

/** Human-readable header sentence for a Repeat-until GoalFrame. */
export function goalSentence(goal: GoalKind | Pick<GoalSpec, "kind">): string {
  const kind = typeof goal === "string" ? goal : goal.kind;
  switch (kind) {
    case "judge":
      return "Repeat until a judge says:";
    case "command":
      return "Repeat until this command passes:";
    case "contains":
      return "Repeat until the output contains:";
  }
}
