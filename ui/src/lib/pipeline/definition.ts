/**
 * The pipeline definition model the graph renders (`03` "Definition versus
 * runtime graph", ADR-0021 § 2's document shape).
 *
 * A *published revision* serves `canonical_document` (route 13), which is the
 * JSON this module reads; it is never re-parsed from YAML here. The model is
 * deliberately shallow: it knows node ids, kinds, `dependsOn`, `when`, the
 * composite scopes and where `${{ }}` bindings live — nothing else — because
 * a graph renderer that re-implements the compiler is a second authority, and
 * the compiler in `serve` is the authority (`01` invariant 6).
 */

/** The sixteen catalogue `kind` names (candidate schema's enum, ADR-0024). */
export const NODE_KINDS = [
  "agent.acp",
  "model.chat",
  "process.exec",
  "condition",
  "gate",
  "human.approval",
  "until",
  "for_each",
  "parallel",
  "join",
  "pipeline.invoke",
  "artifact.publish",
  "git.commit",
  "git.publish",
  "integration.query",
  "integration.action",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/** Kinds M4 refuses to execute — ADR-0024 § 2's seven, with the milestone
 * named the way the `kind_not_implemented` message names it. */
export const DEFERRED_KINDS: Partial<Record<NodeKind, string>> = {
  parallel: "M5",
  join: "M5",
  gate: "M5",
  "git.commit": "M6",
  "git.publish": "M6",
  "integration.query": "M6",
  "integration.action": "M6",
};

/**
 * Kind glyphs. The handoff left graph nodes undesigned, so these follow its
 * rule for every status: a glyph **and** a word, never a shape alone. Glyphs
 * are drawn, not font-loaded (a missing glyph is an invisible node).
 * The mapping and the reasoning are in `docs/design/handoff/graph-nodes.md`.
 */
export const KIND_GLYPH: Record<NodeKind, string> = {
  "agent.acp": "◆",
  "model.chat": "◇",
  "process.exec": "▸",
  condition: "⌄",
  gate: "◉",
  // `⊙`, not an emoji hand: U+270B defaults to *emoji presentation* on several
  // platforms, which would drop a coloured pictogram into a system whose only
  // colour is state. Same circle family as `gate`, dot inside rather than ring.
  "human.approval": "⊙",
  until: "↻",
  for_each: "⊕",
  parallel: "∥",
  join: "≡",
  // `⇒` and `↑` rather than `▶`/`⬆`: U+25B6 and U+2B06 are emoji-presentation
  // capable, and a coloured pictogram would be the only colour on the canvas that
  // does not mean a state.
  "pipeline.invoke": "⇒",
  "artifact.publish": "↑",
  "git.commit": "◍",
  "git.publish": "⇧",
  "integration.query": "?",
  "integration.action": "!",
};

export const SCOPE_KINDS: readonly NodeKind[] = ["until", "for_each", "parallel"];

/**
 * The few words a graph box can carry for a kind. `kind` stays the catalogue
 * name verbatim (it is what an expression and the API say, and it is what the
 * `aria-label`, the `title` and the node list carry); this is only the label
 * inside a 168px box, where `artifact.publish` does not fit next to a state
 * chip. A kind with no entry shows its catalogue name unchanged.
 */
export const KIND_WORD: Partial<Record<NodeKind, string>> = {
  "agent.acp": "agent",
  "model.chat": "model",
  "process.exec": "command",
  "human.approval": "gate",
  gate: "gate",
  "pipeline.invoke": "invoke",
  "artifact.publish": "publish",
  "git.commit": "commit",
  "git.publish": "push",
  "integration.query": "query",
  "integration.action": "action",
  for_each: "for each",
};

export function kindWord(kind: string): string {
  return (KIND_WORD as Record<string, string | undefined>)[kind as NodeKind] ?? kind;
}

/** A `human.approval` / `gate` node is a GATE: the canvas draws it amber and
 * the words say `gate`, per the run-view reference. */
export function isGateKind(kind: string): boolean {
  return kind === "human.approval" || kind === "gate";
}

/**
 * The annotation a scope box carries under its children: what repeats, in the
 * document's own terms (`03` § 3), never a guessed branch name.
 */
export function scopeLoopNote(node: DefinitionNode): string {
  if (node.kind === "until") {
    return typeof node.config?.passWhen === "string"
      ? "\u21bb until passWhen holds"
      : "\u21bb repeats until its bound";
  }
  if (node.kind === "for_each") return "\u2295 one place per item";
  if (node.kind === "parallel") return "\u2225 branches run together";
  return "";
}

export function isScopeKind(kind: string): boolean {
  return (SCOPE_KINDS as readonly string[]).includes(kind);
}

export function isNodeKind(kind: string): kind is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(kind);
}

export function kindGlyph(kind: string): string {
  return isNodeKind(kind) ? KIND_GLYPH[kind] : "□";
}

/** One node of a definition document, as the canonical JSON carries it. */
export interface DefinitionNode {
  id: string;
  kind: string;
  dependsOn?: string[];
  when?: string;
  timeoutSeconds?: number;
  retry?: { maxAttempts?: number };
  onFailure?: { action?: string; errorRoute?: string };
  outputs?: unknown;
  config?: Record<string, unknown>;
}

export interface DefinitionDocument {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; description?: string };
  spec: {
    inputs?: unknown;
    outputs?: unknown;
    policies?: Record<string, unknown>;
    nodes: DefinitionNode[];
    resultBindings?: Record<string, string>;
  };
}

/** A `${{ }}` binding or a bare-CEL slot attached to a node. */
export interface NodeBinding {
  /** Dot path inside the node, e.g. `config.prompt` or `when`. */
  slot: string;
  /** The expression text — the CEL source for a slot, one interpolation for bindingText. */
  expression: string;
  /** `interpolation` = written inside text; `expression` = the slot is bare CEL. */
  position: "interpolation" | "expression";
}

/** Slots whose whole value is a bare CEL expression (ADR-0022 § 1 position 3). */
const CEL_SLOTS = new Set(["when", "passWhen", "failWhen", "condition"]);

const BINDING_RE = /\$\{\{([^}]*)\}\}/g;

/** The delimiters, as values rather than as escapes inside a template literal —
 * a renderer rebuilding a binding has to show the same characters the author
 * typed, and `\${` in a JSX expression is a thing no reader checks. */
export const BINDING_OPEN = "${{";
export const BINDING_CLOSE = "}}";

/** A binding as it was written: the delimiters and the expression between them. */
export function bindingText(binding: NodeBinding): string {
  return binding.position === "expression"
    ? binding.expression
    : `${BINDING_OPEN} ${binding.expression} ${BINDING_CLOSE}`;
}

/**
 * Every binding a node publishes, for hover/inspect. Walks strings only —
 * it does not evaluate, and it never claims an expression is valid.
 */
export function nodeBindings(node: DefinitionNode): NodeBinding[] {
  const found: NodeBinding[] = [];
  if (typeof node.when === "string") {
    found.push({ slot: "when", expression: node.when, position: "expression" });
  }
  walkConfig(node.config ?? {}, "config", found);
  return found;
}

function walkConfig(value: unknown, path: string, out: NodeBinding[]): void {
  if (typeof value === "string") {
    if (CEL_SLOTS.has(path.split(".").pop() ?? "")) {
      out.push({ slot: path, expression: value, position: "expression" });
      return;
    }
    for (const match of value.matchAll(BINDING_RE)) {
      const text = match[1] ?? "";
      if (text.trim()) out.push({ slot: path, expression: text.trim(), position: "interpolation" });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkConfig(item, `${path}.${index}`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // `body` is the nested graph, rendered as a scope group, not as bindings.
      if (key === "body") continue;
      walkConfig(item, `${path}.${key}`, out);
    }
  }
}

/** The body nodes of a composite scope, or `[]` when it has none. */
export function scopeBody(node: DefinitionNode): DefinitionNode[] {
  const body = node.config?.body;
  if (!body || typeof body !== "object") return [];
  const nodes = (body as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? (nodes as DefinitionNode[]) : [];
}

/** The `until`/`for_each` bound shown in the group's bar — never invented. */
export function scopeBoundLabel(node: DefinitionNode): string {
  const config = node.config ?? {};
  const maxIterations = config.maxIterations;
  if (typeof maxIterations === "number") return `max ${maxIterations}`;
  const maxConcurrency = config.maxConcurrency;
  if (typeof maxConcurrency === "number") return `≤${maxConcurrency} parallel`;
  const items = config.items;
  if (Array.isArray(items)) return `${items.length} items`;
  return "";
}

/**
 * Body nodes nothing else in the body depends on — the group's entry points.
 * A body with a missing or ambiguous entry is a compiler error
 * (`scope_entry_ambiguous`); the renderer degrades to "the first node" so a
 * draft still draws, and never claims the document is valid.
 */
export function scopeEntryNodes<T extends DefinitionNode>(body: T[]): T[] {
  if (body.length === 0) return [];
  const ids = new Set(body.map((node) => node.id));
  const roots = body.filter((node) => !(node.dependsOn ?? []).some((dep) => ids.has(dep)));
  return roots.length > 0 ? roots : body.slice(0, 1);
}

/** Body nodes nothing in the body depends on — the group's exit points. */
export function scopeExitNodes<T extends DefinitionNode>(body: T[]): T[] {
  if (body.length === 0) return [];
  const ids = new Set(body.map((node) => node.id));
  const named = new Set(
    body.flatMap((node) => (node.dependsOn ?? []).filter((dep) => ids.has(dep))),
  );
  const exits = body.filter((node) => !named.has(node.id));
  return exits.length > 0 ? exits : body.slice(-1);
}

/** Parse a document only far enough to know it is a pipeline. */
export function isDefinitionDocument(value: unknown): value is DefinitionDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<DefinitionDocument>;
  return doc.kind === "Pipeline" && !!doc.spec && Array.isArray(doc.spec.nodes);
}

/**
 * The declared roots an expression names, in the order the contract's § 2.4
 * table lists them. A reader sees which environment it is reading — `inputs`,
 * `nodes`, `previous`, `iteration` — without the UI re-resolving anything.
 *
 * Quoted string literals are blanked first: the words inside `'(first
 * iteration: no prior review)'` are prose the agent reads, not a reference to
 * the `iteration` root, and reporting them as one would be a false claim about
 * the expression's dependencies.
 */
export function rootWords(expression: string): string[] {
  const scannable = expression.replace(/'[^']*'|"[^"]*"/g, " ");
  const patterns: [RegExp, string][] = [
    [/\binputs\b/, "inputs"],
    [/\brun\b/, "run"],
    [/\bbudget\b/, "budget"],
    [/\bnodes\s*[.[]/, "nodes"],
    [/\bprevious\b/, "previous"],
    [/\biteration\b/, "iteration"],
    [/\bitems\s*\[/, "items"],
    [/\bitem\b/, "item"],
  ];
  const found: string[] = [];
  for (const [pattern, word] of patterns) {
    if (pattern.test(scannable)) found.push(word);
  }
  return found.length > 0 ? found : ["no declared root"];
}
