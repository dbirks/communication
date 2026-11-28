/**
 * proposalDiff — what an assistant proposal changes in the open draft
 * (editor interactions 1d). Pure: compares the saved draft text with the
 * proposed text and lists added, edited and removed steps (by id, in canvas
 * order), the scopes the proposal created (a wrap), and the connections it
 * adds or removes. The canvas draws ghosts from it; the review panel lists it.
 */
import { parse as parseYaml } from "yaml";
import { parseGraph, type GraphModel, type GraphNode } from "../../../lib/pipeline/graphDoc";

export interface FieldChange {
  /** Dotted path inside the step, e.g. "config.prompt", "dependsOn". */
  field: string;
  before: unknown;
  after: unknown;
}

export interface StepChange {
  id: string;
  kind: string;
  label: string;
  /** True when the step is a scope (a wrap such as a repeat-until loop). */
  isScope: boolean;
}

export interface EditedStep extends StepChange {
  fields: FieldChange[];
}

export interface EdgeChange {
  from: string;
  to: string;
}

export interface ProposalDiff {
  added: StepChange[];
  edited: EditedStep[];
  removed: StepChange[];
  addedEdges: EdgeChange[];
  removedEdges: EdgeChange[];
  /** added + edited + removed steps (connections ride on their step). */
  count: number;
}

function modelOf(text: string): GraphModel | null {
  const parsed = parseGraph(text);
  return parsed.ok ? parsed.model : null;
}

function rawAt(doc: unknown, pointer: string): Record<string, unknown> | null {
  let cur: unknown = doc;
  for (const part of pointer.split("/").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return null;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
  }
  return cur && typeof cur === "object" && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null;
}

/** A step's own fields, without the body of a scope (its children diff on their own). */
function ownFields(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "config" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [ck, cv] of Object.entries(value as Record<string, unknown>)) {
        if (ck === "body") continue;
        out[`config.${ck}`] = cv;
      }
    } else if (key !== "id") {
      out[key] = value;
    }
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const stepOf = (n: GraphNode): StepChange => ({
  id: n.id,
  kind: n.kind,
  label: n.label,
  isScope: n.isScope,
});

export function proposalDiff(baseText: string, proposedText: string): ProposalDiff | null {
  const base = modelOf(baseText);
  const next = modelOf(proposedText);
  if (!base || !next) return null;
  let baseDoc: unknown;
  let nextDoc: unknown;
  try {
    baseDoc = parseYaml(baseText);
    nextDoc = parseYaml(proposedText);
  } catch {
    return null;
  }
  const baseById = new Map(base.nodes.map((n) => [n.id, n]));
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));

  const added: StepChange[] = [];
  const edited: EditedStep[] = [];
  for (const n of next.nodes) {
    const before = baseById.get(n.id);
    if (!before) {
      added.push(stepOf(n));
      continue;
    }
    const a = ownFields(rawAt(baseDoc, before.pointer));
    const b = ownFields(rawAt(nextDoc, n.pointer));
    const fields: FieldChange[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!same(a[key], b[key])) fields.push({ field: key, before: a[key], after: b[key] });
    }
    if (before.scope.join("/") !== n.scope.join("/")) {
      fields.push({ field: "scope", before: before.scope.join(" / "), after: n.scope.join(" / ") });
    }
    if (fields.length > 0) edited.push({ ...stepOf(n), fields });
  }
  const removed = base.nodes.filter((n) => !nextById.has(n.id)).map(stepOf);

  const key = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
  const baseEdges = new Set(base.edges.map(key));
  const nextEdges = new Set(next.edges.map(key));
  const addedEdges = next.edges
    .filter((e) => !baseEdges.has(key(e)))
    .map((e) => ({ from: e.from, to: e.to }));
  const removedEdges = base.edges
    .filter((e) => !nextEdges.has(key(e)))
    .map((e) => ({ from: e.from, to: e.to }));

  return {
    added,
    edited,
    removed,
    addedEdges,
    removedEdges,
    count: added.length + edited.length + removed.length,
  };
}
