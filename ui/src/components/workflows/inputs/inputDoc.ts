/**
 * inputDoc.ts — the pure YAML half of the Inputs tab (design 1j, ADR-0066).
 *
 * The draft document is the single source of truth for a workflow's inputs:
 * `spec.inputs` is a JSON Schema object whose `properties` may carry one
 * extension keyword, `x-communication-input: {type, label, help}`, while
 * `required` stays JSON Schema's `required` array and `default` stays the
 * property's own `default` (ADR-0066 — no shadow copies). This module mirrors
 * that derivation for the EDIT view (the server's `input_specs` is the same
 * reading of the same document, derived from the last validated plan) and
 * implements the three edits the tab can make — add, edit, remove — as
 * text→text operations on the draft's YAML, re-serialized through
 * `toBlockString` so comments and key order survive exactly like the Studio's
 * graph ops do.
 *
 * Rules mirrored from the ADR:
 * - a property WITHOUT the annotation is presented as `text` (presentation
 *   only — the annotation is not written unless the editor changes one);
 * - an unknown annotation `type` rides through unchanged (open string);
 * - the JSON Schema `type` must describe the runtime shape: `object` for
 *   `github_issue`, `string` for the rest — the editor keeps them in step;
 * - input names use the wire vocabulary `^[a-z][a-z0-9_]{0,62}$`.
 */
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { toBlockString } from "../../../lib/pipeline/blockYaml";

/** The five widget types (ADR-0066), in the order the Type select lists them. */
export const INPUT_TYPES = [
  { value: "github_issue", label: "GitHub issue" },
  { value: "branch", label: "Branch" },
  { value: "agent_profile", label: "Agent profile" },
  { value: "text", label: "Text" },
  { value: "long_text", label: "Long text" },
] as const;

/** Wire vocabulary for an input name (`^[a-z][a-z0-9_]{0,62}$`). */
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The label the row shows for a type — unknown types ride through verbatim,
 * exactly as the wire's `InputSpec.type` does. */
export function inputTypeLabel(type: string): string {
  return INPUT_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/** The JSON Schema `type` that describes the annotated type's runtime shape
 * (ADR-0066's table): `object` for an issue, `string` for everything else. */
function schemaTypeFor(type: string): string {
  return type === "github_issue" ? "object" : "string";
}

/** One input as the edit view reads it — the same six fields as the wire's
 * `InputSpec`, derived client-side from the document the editor writes. */
export interface DraftInputSpec {
  name: string;
  type: string;
  label?: string;
  help?: string;
  required: boolean;
  /** The property's JSON Schema `default` verbatim; absent when none. */
  default?: unknown;
}

/** The annotation member of a property, normalized off any shape. */
function annotationOf(property: unknown): Record<string, unknown> {
  const value = (property as Record<string, unknown> | null)?.["x-communication-input"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** True when the text parses as a YAML mapping — the check behind the tab's
 * “the draft cannot be read” state (an unparseable draft is not “no
 * inputs”). */
export function draftTextParses(text: string): boolean {
  try {
    const doc = parseDocument(text);
    return doc.errors.length === 0 && isMap(doc.contents);
  } catch {
    return false;
  }
}

/**
 * The document's inputs, sorted by name (the server's `InputSpec[]` order):
 * each `spec.inputs.properties` member merged with its annotation. A missing
 * or unparseable `spec.inputs` yields no rows, not an error — a workflow
 * without inputs is the design's empty state.
 */
export function draftInputSpecs(text: string): DraftInputSpec[] {
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch {
    return [];
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const plain = doc.toJS() as { spec?: { inputs?: unknown } };
  const inputs = plain.spec?.inputs as
    | { properties?: Record<string, unknown>; required?: unknown }
    | undefined;
  if (!inputs || typeof inputs !== "object") return [];
  const required = new Set(
    Array.isArray(inputs.required)
      ? inputs.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const properties = inputs.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties)
    .map(([name, property]) => {
      const annotation = annotationOf(property);
      const spec: DraftInputSpec = {
        name,
        // An un-annotated property is PRESENTED as text — nothing is written
        // back for it unless the editor touches it (ADR-0066).
        type: textOf(annotation.type) ?? "text",
        label: textOf(annotation.label),
        help: textOf(annotation.help),
        required: required.has(name),
      };
      const declared = (property as Record<string, unknown> | null)?.default;
      if (declared !== undefined) spec.default = declared;
      return spec;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------ step-binding reference */

function containsIssueBinding(value: unknown, name: string): boolean {
  // `${{ inputs.<name> }}` or `${{ inputs.<name>.body }}` — the boundary keeps
  // `inputs.issue` from matching a sibling `inputs.issue_number`.
  const pattern = new RegExp(`\\$\\{\\{[^}]*\\binputs\\.${escapeRegExp(name)}(?!\\w)[^}]*\\}\\}`);
  return pattern.test(JSON.stringify(value ?? null));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The ids of the steps whose bindings read `inputs.<name>` — innermost
 * first: a node whose own body contains a matching sub-node reports the
 * sub-node, not itself. Walks `spec.nodes` and every nested `config.body`
 * list generically, so loop and scope bodies are covered. */
export function usedByStepNames(text: string, name: string): string[] {
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch {
    return [];
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const plain = doc.toJS() as { spec?: { nodes?: unknown } };
  const found: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const record = node as Record<string, unknown>;
      const id = textOf(record.id);
      if (id === undefined) continue;
      const before = found.length;
      // Descend first so the innermost step that reads the input is the one
      // named; only a node with no matching descendant reports itself.
      const body = (record.config as { body?: { nodes?: unknown } } | undefined)?.body;
      walk(body?.nodes);
      if (found.length === before && containsIssueBinding(record, name)) found.push(id);
    }
  };
  walk(plain.spec?.nodes);
  return found;
}

/* ------------------------------------------------------------- edit ops */

export type InputEdit =
  | { op: "add"; name: string; type?: string }
  | {
      op: "edit";
      name: string;
      patch: {
        label?: string;
        help?: string;
        type?: string;
        required?: boolean;
        /** `undefined` = leave the `default` alone; `null` = clear it; a
         * string = write it (always a string default — the five types are
         * string-or-object and an issue carries no form default). */
        defaultText?: string | null;
      };
    }
  | { op: "remove"; name: string };

/** Parse for an edit; `null` on anything that is not a YAML mapping — the
 * edit then refuses rather than rewriting bytes it cannot understand. */
function parseForEdit(text: string): Document | null {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** The `spec.inputs` map, creating `{type: object, properties: {}}` on the
 * way when the document has none yet. */
function ensureInputs(doc: Document): YAMLMap | null {
  const root = doc.contents;
  if (!isMap(root)) return null;
  let spec = root.get("spec") as YAMLMap | undefined;
  if (!isMap(spec)) {
    spec = doc.createNode({}) as YAMLMap;
    root.set("spec", spec);
  }
  let inputs = spec.get("inputs") as YAMLMap | undefined;
  if (!isMap(inputs)) {
    inputs = doc.createNode({ type: "object" }) as YAMLMap;
    spec.set("inputs", inputs);
  }
  if (!isMap(inputs.get("properties"))) {
    inputs.set("properties", doc.createNode({}) as YAMLMap);
  }
  return inputs;
}

function propertiesOf(inputs: YAMLMap): YAMLMap {
  return inputs.get("properties") as YAMLMap;
}

/** The `required` sequence, created empty only when a write needs it. */
function requiredSeq(doc: Document, inputs: YAMLMap, create: boolean): YAMLSeq | null {
  const seq = inputs.get("required");
  if (isSeq(seq)) return seq;
  if (!create || !isMap(inputs)) return null;
  const fresh = doc.createNode([]) as YAMLSeq;
  inputs.set("required", fresh);
  return fresh;
}

/** The sequence's plain values — items are AST nodes; scalars unwrap to their
 * value, anything else keeps whatever the document holds. */
function seqValues(seq: YAMLSeq): unknown[] {
  return seq.items.map((item) => (isScalar(item) ? item.value : item));
}

/** Rewrite the sequence's contents from plain values — the one spelling that
 * survives AST scalars and raw strings alike. */
function seqSet(doc: Document, seq: YAMLSeq, values: unknown[]): void {
  seq.items = values.map((value) => doc.createNode(value) as never);
}

function seqAdd(doc: Document, seq: YAMLSeq, name: string): void {
  const values = seqValues(seq);
  if (!values.includes(name)) seqSet(doc, seq, [...values, name]);
}

function seqRemove(doc: Document, seq: YAMLSeq, name: string): void {
  seqSet(
    doc,
    seq,
    seqValues(seq).filter((value) => value !== name),
  );
}

/** Write the annotation, omitting empty presentation strings (an empty label
 * means “no label”, not `label: ""` on the wire). */
function writeAnnotation(
  doc: Document,
  property: YAMLMap,
  type: string,
  label?: string,
  help?: string,
): void {
  const annotation = doc.createNode({}) as YAMLMap;
  annotation.set("type", type);
  if ((label ?? "") !== "") annotation.set("label", label as string);
  if ((help ?? "") !== "") annotation.set("help", help as string);
  property.set("x-communication-input", annotation);
}

function applyAdd(doc: Document, name: string, type = "text"): string | null {
  const inputs = ensureInputs(doc);
  if (!inputs) return null;
  const properties = propertiesOf(inputs);
  if (properties.has(name)) return toBlockString(doc);
  const property = doc.createNode({ type: schemaTypeFor(type) }) as YAMLMap;
  writeAnnotation(doc, property, type);
  properties.set(name, property);
  return toBlockString(doc);
}

function applyEdit(doc: Document, edit: Extract<InputEdit, { op: "edit" }>): string | null {
  const inputs = ensureInputs(doc);
  if (!inputs) return null;
  const properties = propertiesOf(inputs);
  const existing = properties.get(edit.name);
  if (!isMap(existing)) return null;
  const property = existing;
  const { patch } = edit;

  if (patch.type !== undefined || patch.label !== undefined || patch.help !== undefined) {
    const type = patch.type ?? textOf(annotationOf(plainProperty(doc, edit.name)).type) ?? "text";
    // Keep the JSON Schema type and the annotated shape in step (ADR-0066's
    // runtime-shape table); an incompatible default is cleared rather than
    // left to fail validation behind the editor's back.
    if (patch.type !== undefined) {
      property.set("type", schemaTypeFor(patch.type));
      // An old shape of the previous widget goes with the switch: an issue's
      // object default and nested `properties` cannot ride a string field.
      if (patch.type === "github_issue") property.delete("default");
      else {
        property.delete("properties");
        const declared = (plainProperty(doc, edit.name) as Record<string, unknown> | undefined)
          ?.default;
        if (declared !== undefined && declared !== null && typeof declared === "object")
          property.delete("default");
      }
    }
    const current = annotationOf(plainProperty(doc, edit.name));
    writeAnnotation(
      doc,
      property,
      type,
      patch.label ?? textOf(current.label),
      patch.help ?? textOf(current.help),
    );
  }

  if (patch.defaultText !== undefined) {
    if (patch.defaultText === null || patch.defaultText === "") property.delete("default");
    else property.set("default", patch.defaultText);
  }

  if (patch.required !== undefined) {
    const seq = requiredSeq(doc, inputs, patch.required);
    if (patch.required && seq) seqAdd(doc, seq, edit.name);
    else if (seq) seqRemove(doc, seq, edit.name);
  }
  return toBlockString(doc);
}

/** The plain-JS view of one property (for reading the CURRENT label/help when
 * a patch changes only one of them). */
function plainProperty(doc: Document, name: string): unknown {
  const plain = doc.toJS() as { spec?: { inputs?: { properties?: Record<string, unknown> } } };
  return plain.spec?.inputs?.properties?.[name];
}

function applyRemove(doc: Document, name: string): string | null {
  const inputs = ensureInputs(doc);
  if (!inputs) return null;
  propertiesOf(inputs).delete(name);
  const seq = requiredSeq(doc, inputs, false);
  if (seq) seqRemove(doc, seq, name);
  return toBlockString(doc);
}

/** Apply one edit to the draft text. Throws on an unparseable document or an
 * edit that names a property that is not there — the caller renders the
 * refusal rather than writing bytes it cannot account for. */
export function applyInputEdit(text: string, edit: InputEdit): string {
  const doc = parseForEdit(text);
  if (!doc) throw new Error("the draft document is not readable YAML — fix it in the Studio first");
  const out =
    edit.op === "add"
      ? applyAdd(doc, edit.name, edit.type)
      : edit.op === "remove"
        ? applyRemove(doc, edit.name)
        : applyEdit(doc, edit);
  if (out === null) throw new Error(`the draft has no input named ${edit.name}`);
  return out;
}

/** A fresh, unused name for `+ add input` — the wire vocabulary, `new_input`,
 * `new_input2`, … */
export function suggestInputName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has("new_input")) return "new_input";
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `new_input${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `new_input${Date.now()}`;
}

/* ---------------------------------------------------------- YAML preview */

/** Preview-safe scalar spelling: plain unless YAML would reinterpret it. */
function previewScalar(value: unknown): string {
  if (typeof value === "string") {
    if (/^[A-Za-z0-9 ._@:/+-]+$/.test(value) && value.trim() === value && value !== "")
      return value;
    return JSON.stringify(value);
  }
  return JSON.stringify(value ?? null);
}

/** The `inputs:` block of the design's YAML panel — the typed declaration in
 * the fewest lines that read as YAML. This is a PREVIEW of what the editor
 * writes into the draft (the full `x-communication-input` spelling lives in
 * the YAML tab), not the document's own text. */
export function inputsYamlPreview(specs: readonly DraftInputSpec[]): string {
  if (specs.length === 0) return "inputs: {}";
  const lines: string[] = ["inputs:"];
  for (const spec of specs) {
    lines.push(`  ${spec.name}:`);
    lines.push(`    type: ${spec.type}`);
    if (spec.required) lines.push("    required: true");
    if (spec.default !== undefined) lines.push(`    default: ${previewScalar(spec.default)}`);
  }
  return lines.join("\n");
}
