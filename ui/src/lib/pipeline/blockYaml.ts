/**
 * blockYaml.ts — block-style YAML for the workflow YAML surfaces (design 2d).
 *
 * The stored workflow source may be written in flow style (`required: [goal,
 * repository]`, `retry: {maxAttempts: 2}`); the Workflows Review design moves
 * every collection to block style: lists as `- item`, maps nested under their
 * keys, no inline `{ }` / `[ ]` flow collections. The `yaml` package parses
 * into a Document whose Map/SMap nodes carry a `flow` flag; clearing it and
 * re-serializing with block options gives the proposed text without touching
 * comments, key order, scalar formatting or anchors.
 *
 * Empty collections have no block spelling — the emitter keeps `{}` / `[]` —
 * so an empty map or sequence serializes as flow even in block mode. That is
 * the one deliberate exception, and it is why `toBlockYaml` is not a no-op for
 * documents containing empty collections.
 */
import { parseDocument, YAMLMap, YAMLSeq, type Document, type ToStringOptions } from "yaml";

/** Block-style emission: no line folding (the `yaml` package default line width
 * re-wraps long scalars) and no flow collections. */
export const BLOCK_OPTIONS: ToStringOptions = { lineWidth: 0 };

function clearFlow(node: unknown): void {
  if (node instanceof YAMLMap) {
    // Empty collections have no block spelling: the emitter keeps their
    // `{}` / `[]` form, so they are left in flow rather than cleared.
    if (node.items.length > 0) node.flow = false;
    for (const pair of node.items) {
      clearFlow(pair.key);
      clearFlow(pair.value);
    }
    return;
  }
  if (node instanceof YAMLSeq) {
    if (node.items.length > 0) node.flow = false;
    for (const item of node.items) clearFlow(item);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) clearFlow(item);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value !== null && typeof value === "object") clearFlow(value);
    }
  }
}

function parseOrNull(text: string): Document | null {
  try {
    const doc = parseDocument(text);
    return doc.errors.length > 0 ? null : doc;
  } catch {
    return null;
  }
}

function containsFlow(node: unknown): boolean {
  if (node instanceof YAMLMap) {
    if (node.flow === true) return true;
    return node.items.some((pair) => containsFlow(pair?.key) || containsFlow(pair.value));
  }
  if (node instanceof YAMLSeq) {
    if (node.flow === true) return true;
    return node.items.some(containsFlow);
  }
  if (Array.isArray(node)) return node.some(containsFlow);
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    return Object.keys(record).some((key) => containsFlow(record[key]));
  }
  return false;
}

/**
 * Serialize a parsed `Document` in block style: lists as `- item`, maps nested
 * under their keys, no inline `{ }` / `[ ]`. Every Map/SMap/Sequence node that
 * carries items is cleared of its `flow` flag before emission; empty
 * collections keep their `{}` / `[]` spelling, which is the one form block
 * style cannot express. Shared by the text-level converter and the graph ops so
 * every write path emits the same block text.
 */
export function toBlockString(doc: Document): string {
  clearFlow(doc.contents);
  return doc.toString(BLOCK_OPTIONS);
}

/**
 * Convert flow-style YAML text to block style: lists as `- item`, maps nested
 * under their keys, no inline `{ }` / `[ ]`. On a parse error the input is
 * returned unchanged.
 */
export function toBlockYaml(text: string): string {
  const doc = parseOrNull(text);
  if (!doc) return text;
  return toBlockString(doc);
}

/**
 * True when the document holds no flow Map/SMap — lists as `- item` and maps
 * nested under their keys, the shape `toBlockYaml` emits. Empty collections
 * written in flow (`{}` / `[]`) still count as flow.
 */
export function isBlockStyle(text: string): boolean {
  const doc = parseOrNull(text);
  if (!doc) return false;
  return !containsFlow(doc.contents);
}
