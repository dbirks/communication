/**
 * useStudioDraft — the Workflow Studio's draft state over the existing
 * version-checked draft contract (`PUT /drafts/{id}`, ADR-0002): the YAML
 * text is the source of truth, `ui_layout` carries the non-semantic
 * positions (ADR-0042 §3, digest-excluded), and undo/redo is an in-memory
 * stack of `{text, ui_layout}` snapshots.
 *
 * The text→text graph ops of `docs/design/studio-workbench.md` §4 (connect,
 * insert-on-edge with the ambiguity dialog, disconnect) are pure exported
 * functions here: they parse the YAML, enforce the safety rules, mutate the
 * `yaml` Document and re-serialize so comments survive. `addNode` and
 * `deleteNode` come from `lib/pipeline/graphDoc.ts`, the single place the
 * schema's node lists are walked — these ops resolve node positions through
 * the pointers `parseGraph` already computed and never re-walk the schema.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { toBlockString } from "../../lib/pipeline/blockYaml";
import {
  findNode,
  parseGraph,
  scopeKey,
  skeletonNode,
  uniqueId,
  type GraphEdge,
  type GraphModel,
  type OpResult,
  type ParseResult,
  type ScopePath,
} from "../../lib/pipeline/graphDoc";
import { draftConflictOf, useDraft, usePutDraft } from "../../api/pipelines";
import { queryKeys } from "../../api/queries";
import type { DraftPut } from "../../api/types";
import { useUnsavedGuard, type UnsavedGuard } from "../../lib/pipeline/unsavedGuard";
import type { UiLayout } from "./StudioCanvas";

/** The canvas's `{nodes: {id: {x, y}}}` layout, normalized off unknown shapes. */
export function normalizeLayout(value: unknown): UiLayout {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nodes = (value as { nodes?: unknown }).nodes;
    if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
      return { nodes: nodes as UiLayout["nodes"] };
    }
  }
  return {};
}

/**
 * The layout's durable home is the document's own `metadata.ui` block: the
 * frozen DraftPut body is `{document_yaml, version}` (route 9 400s on any
 * other member) and the stored `metadata.ui` is re-resolved from the
 * replaced document. ADR-0021 § 5: the block never enters the revision
 * digest, so saving positions cannot change what a run executes.
 */
export function withUILayout(text: string, layout: UiLayout): string {
  const nodes = layout.nodes ?? {};
  if (text.length === 0 || Object.keys(nodes).length === 0) return text;
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch {
    return text;
  }
  if (doc.errors.length > 0) return text;
  const root = doc.contents;
  if (!isMap(root)) return text;
  let meta: YAMLMap | undefined = root.get("metadata") as YAMLMap | undefined;
  if (!isMap(meta)) {
    meta = doc.createNode({}) as YAMLMap;
    root.set("metadata", meta);
  }
  meta.set("ui", doc.createNode({ nodes }) as YAMLMap);
  return toBlockString(doc);
}

/** A yaml AST node as plain JS (the layout only ever needs plain objects). */
function toPlain(doc: Document, value: unknown): unknown {
  const node = value as { toJS?: (doc: Document) => unknown } | null;
  return node && typeof node.toJS === "function" ? node.toJS(doc) : value;
}

/** The document's `metadata.ui` as a canvas layout; `{}` when absent or broken. */
export function uiLayoutOfText(text: string): UiLayout {
  if (text.length === 0) return {};
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch {
    return {};
  }
  if (doc.errors.length > 0) return {};
  const root = doc.contents;
  if (!isMap(root)) return {};
  const meta = root.get("metadata");
  if (!isMap(meta)) return {};
  return normalizeLayout(toPlain(doc, meta.get("ui")));
}

/** The parsed JS document the canvas lays out; null when the YAML is broken. */
export function toJsDocument(text: string): unknown {
  try {
    return parseDocument(text).toJS();
  } catch {
    return null;
  }
}

/** A graph edit's one-stop: parse the text, run the edit, re-serialize. */
function withDoc(text: string, fn: (doc: Document, model: GraphModel) => string[]): OpResult {
  const parsed = parseGraph(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  try {
    const changed = fn(doc, parsed.model);
    return { ok: true, text: toBlockString(doc), changed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Walk `pointer` (e.g. `/spec/nodes/2/config/body/nodes/0`) into a Document. */
function resolvePointer(doc: Document, pointer: string): YAMLMap | null {
  let cur: unknown = doc.contents;
  for (const segment of pointer.split("/")) {
    if (segment === "") continue;
    if (isSeq(cur as YAMLSeq)) {
      cur = (cur as YAMLSeq).items[Number(segment)];
    } else if (isMap(cur as YAMLMap)) {
      cur = (cur as YAMLMap).get(segment);
    } else {
      return null;
    }
  }
  return isMap(cur as YAMLMap) ? (cur as YAMLMap) : null;
}

/** The node list of `scope` (root = `/spec/nodes`), walking scope ids by `id`. */
function scopeListAt(doc: Document, scope: ScopePath): YAMLSeq | { error: string } {
  const root = doc.contents;
  if (!isMap(root) || root.get("kind") !== "Pipeline") {
    return { error: "document is not a Pipeline" };
  }
  const spec = root.get("spec");
  if (!isMap(spec)) return { error: "document has no spec" };
  let list: YAMLSeq = spec.get("nodes") as YAMLSeq;
  if (!isSeq(list)) return { error: "spec.nodes is not a list" };
  let i = 0;
  while (i < scope.length) {
    const id = scope[i];
    i += 1;
    const idx = list.items.findIndex(
      (item) => isMap(item as YAMLMap) && (item as YAMLMap).get("id") === id,
    );
    if (idx < 0)
      return {
        error: `node ${id} not found in scope ${scopeKey(scope.slice(0, i - 1)) || "(root)"}`,
      };
    const node = list.items[idx] as YAMLMap;
    const cfg: YAMLMap = node.get("config") as YAMLMap;
    if (!isMap(cfg)) return { error: `node ${id} has no config` };
    if (i < scope.length) {
      const bi = Number(scope[i]);
      i += 1;
      const branches: YAMLSeq = cfg.get("branches") as YAMLSeq;
      if (!isSeq(branches) || bi < 0 || bi >= branches.items.length) {
        return { error: `branch ${bi} of ${id} not found` };
      }
      const branch: YAMLMap = branches.items[bi] as YAMLMap;
      if (!isMap(branch) || !isSeq(branch.get("nodes"))) {
        return { error: `branch ${bi} of ${id} has no nodes list` };
      }
      list = branch.get("nodes") as YAMLSeq;
    } else {
      const body: YAMLMap = cfg.get("body") as YAMLMap;
      if (!isMap(body) || !isSeq(body.get("nodes"))) {
        return { error: `node ${id} has no body` };
      }
      list = body.get("nodes") as YAMLSeq;
    }
  }
  return list;
}

/** Append `value` to the node's `dependsOn`, creating the key if absent. */
function ensureDependsOn(doc: Document, item: YAMLMap): YAMLSeq {
  const existing = item.get("dependsOn");
  if (isSeq(existing as YAMLSeq)) return existing as YAMLSeq;
  const seq = doc.createNode([]) as YAMLSeq;
  item.set("dependsOn", seq);
  return seq;
}

function describeScope(scope: ScopePath): string {
  return scope.length === 0 ? "the top level" : `scope ${scopeKey(scope)}`;
}

/** BFS over dependsOn edges: the path from `start` to `target`, if any. */
function pathTo(model: GraphModel, start: string, target: string): string[] | null {
  const queue: string[][] = [[start]];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) continue;
    const node = model.nodes.find((n) => n.id === path[path.length - 1]);
    if (!node) continue;
    for (const dep of node.dependsOn) {
      if (dep === target) return [...path, target];
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push([...path, dep]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graph ops (studio-workbench.md §4): pure text → text, reasons on refusal
// ---------------------------------------------------------------------------

export type ConnectVerdict = { ok: true } | { ok: false; reason: string };

/** The OpResult branch the page opens the AmbiguityDialog for. */
export function isAmbiguousOp(
  result: OpResult,
): result is { ok: false; ambiguous: true; reasons: string[] } {
  return !result.ok && "ambiguous" in result;
}

/**
 * The connect refusals of §4, each naming its case: self-edge, cycle (the
 * existing path that would be closed), cross-scope (the two scopes named),
 * duplicate edge.
 */
export function canConnectOf(model: GraphModel, from: string, to: string): ConnectVerdict {
  const a = findNode(model, from);
  const b = findNode(model, to);
  if (!a) return { ok: false, reason: `node ${from} is not in the parsed graph` };
  if (!b) return { ok: false, reason: `node ${to} is not in the parsed graph` };
  if (from === to) return { ok: false, reason: `${from} cannot depend on itself` };
  if (scopeKey(a.scope) !== scopeKey(b.scope)) {
    return {
      ok: false,
      reason: `cross-scope: ${from} is in ${describeScope(a.scope)}, ${to} is in ${describeScope(
        b.scope,
      )} — dependsOn never crosses a scope boundary`,
    };
  }
  if (b.dependsOn.includes(from)) {
    return { ok: false, reason: `duplicate edge: ${from} → ${to} already exists` };
  }
  const cycle = pathTo(model, to, from);
  if (cycle) {
    return { ok: false, reason: `connecting ${from} → ${to} closes a cycle: ${cycle.join(" → ")}` };
  }
  return { ok: true };
}

/** Add `from` to `to`'s dependsOn after the §4 checks pass. */
export function connectOp(text: string, from: string, to: string): OpResult {
  return withDoc(text, (doc, model) => {
    const verdict = canConnectOf(model, from, to);
    if (!verdict.ok) return fail(verdict.reason);
    const target = resolvePointer(doc, findNode(model, to)!.pointer);
    if (!target) return fail(`node ${to} cannot be located in the document`);
    ensureDependsOn(doc, target).add(from);
    return [to];
  });
}

/**
 * Split `edge.from → edge.to` into `from → NEW → to`: the new node is appended
 * to the edge's scope list with dependsOn `[from]`, and `to`'s dependsOn
 * replaces `from` with NEW. Error-route edges are hard-refused; an edge with
 * §4 reasons is ambiguous (the dialog names them) unless `acceptAmbiguity`.
 */
export function insertOnEdgeOp(
  text: string,
  edge: GraphEdge,
  kind: string,
  opts: { acceptAmbiguity?: boolean } = {},
): OpResult {
  if (edge.kind === "error") {
    return {
      ok: false,
      error: `error-route edges cannot be split: ${edge.from} → ${edge.to} is a failure route`,
    };
  }
  if (edge.reasons.length > 0 && !opts.acceptAmbiguity) {
    return { ok: false, ambiguous: true, reasons: edge.reasons };
  }
  return withDoc(text, (doc, model) => {
    const toNode = findNode(model, edge.to);
    if (!toNode) return fail(`node ${edge.to} is not in the parsed graph`);
    const list = scopeListAt(doc, edge.scope);
    if ("error" in list) return fail(list.error);
    const id = uniqueId(model, kind.includes(".") ? kind.split(".")[0] : kind);
    const node: Record<string, unknown> = { id, kind, dependsOn: [edge.from] };
    const config = skeletonNode(kind);
    if (Object.keys(config).length > 0) node.config = config;
    list.add(doc.createNode(node) as YAMLMap);
    const toItem = resolvePointer(doc, toNode.pointer);
    if (!toItem) return fail(`node ${edge.to} cannot be located in the document`);
    const deps = toItem.get("dependsOn");
    if (isSeq(deps as YAMLSeq)) {
      for (let i = 0; i < (deps as YAMLSeq).items.length; i += 1) {
        if (String((deps as YAMLSeq).items[i]) === edge.from) {
          (deps as YAMLSeq).items[i] = doc.createNode(id);
        }
      }
    }
    return [id, edge.to];
  });
}

/**
 * Drop the edge behind its `${scopeKey}:${from}->${to}` id: `from` is removed
 * from `to`'s dependsOn. Node ids contain neither `:` nor `->`, so the split
 * is unambiguous.
 */
export function disconnectEdgeOp(text: string, edgeId: string): OpResult {
  const colon = edgeId.indexOf(":");
  const arrow = colon >= 0 ? edgeId.indexOf("->", colon) : edgeId.indexOf("->");
  if (colon < 0 || arrow < 0) return { ok: false, error: `not an edge id: ${edgeId}` };
  const from = edgeId.slice(colon + 1, arrow);
  const to = edgeId.slice(arrow + 2);
  return withDoc(text, (doc, model) => {
    const target = findNode(model, to);
    if (!target) return fail(`node ${to} is not in the parsed graph`);
    const item = resolvePointer(doc, target.pointer);
    if (!item) return fail(`node ${to} cannot be located in the document`);
    const deps = item.get("dependsOn");
    if (!isSeq(deps as YAMLSeq)) return fail(`${to} has no dependsOn`);
    const seq = deps as YAMLSeq;
    for (let i = 0; i < seq.items.length; i += 1) {
      if (String(seq.items[i]) === from) {
        seq.items.splice(i, 1);
        return [to];
      }
    }
    return fail(`edge ${from} → ${to} does not exist`);
  });
}

function fail(message: string): string[] {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

interface Snapshot {
  text: string;
  layout: UiLayout;
}

export interface LastGood {
  model: GraphModel;
  document: unknown;
}

/** One saved burst of typing (coalesced) is one undo step. */
const TYPING_COALESCE_MS = 1000;

export interface StudioDraft {
  /** The YAML source of truth (what the canvas renders, or `lastGood` when broken). */
  text: string;
  /** `ui_layout` positions — non-semantic, digest-excluded (ADR-0042 §3). */
  layout: UiLayout;
  /** The version last written (or read) from the server. */
  savedVersion: number;
  dirty: boolean;
  /** `parseGraph(text)` — re-derived on every change. */
  parse: ParseResult;
  /** The last parse that succeeded; the canvas's stale fallback. */
  lastGood: LastGood | null;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  /** A 409 `stale_draft_version`: the server's newer version, with recovery. */
  conflict: { currentVersion: number } | null;
  saveError: unknown;
  /** Run a text→text op. ok → committed (undoable); ambiguous/error → returned, unchanged. */
  apply: (op: (text: string) => OpResult) => OpResult;
  /** YAML typing; history coalesced per 1s. */
  setText: (text: string) => void;
  /** Move a node in `ui_layout` only — undoable, never touches the YAML. */
  move: (id: string, pos: { x: number; y: number }) => void;
  undo: () => void;
  redo: () => void;
  /** PUT `{document_yaml, version, ui_layout}`; 409 → `conflict`, never a retry. */
  save: () => Promise<boolean>;
  /** Discard local edits and adopt what the server holds (re-read). */
  reloadTheirs: () => void;
  /** Re-PUT the local text against the server's newer version. */
  overwrite: () => Promise<boolean>;
  /** Unsaved-changes guard (lib/pipeline/unsavedGuard.ts), active while `dirty`. */
  guard: UnsavedGuard;
}

export function useStudioDraft(draftId: string): StudioDraft {
  const queryClient = useQueryClient();
  const draft = useDraft(draftId);
  const put = usePutDraft(draftId);

  const [text, setTextState] = useState("");
  const [layout, setLayout] = useState<UiLayout>(() => normalizeLayout(draft.data?.ui_layout));
  const [savedVersion, setSavedVersion] = useState(draft.data?.version ?? 0);
  const [dirty, setDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const parse = useMemo(() => parseGraph(text), [text]);

  const textRef = useRef(text);
  textRef.current = text;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const [lastGood, setLastGood] = useState<LastGood | null>(null);
  useEffect(() => {
    if (parse.ok) setLastGood({ model: parse.model, document: toJsDocument(text) });
  }, [parse, text]);

  // Seed from the served draft whenever the local copy is not ahead of it; a
  // successful save or a `reloadTheirs` lands here with the same or newer bytes.
  const served = draft.data;
  const servedKey = served ? `${served.version}:${served.updated_at}` : "none";
  useEffect(() => {
    if (!served || dirty || conflict !== null) return;
    const bytes = served.document_yaml ?? "";
    setTextState(bytes);
    // Positions live in the served document's `metadata.ui`; the served
    // `ui_layout` member wins when it actually carries positions.
    const servedLayout = normalizeLayout(served.ui_layout);
    const seededLayout =
      Object.keys(servedLayout.nodes ?? {}).length > 0 ? servedLayout : uiLayoutOfText(bytes);
    setLayout(seededLayout);
    setSavedVersion(served.version);
    setUndoStack([]);
    setRedoStack([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servedKey, dirty, conflict === null ? "none" : "conflict"]);

  /** Push the current snapshot onto undo, clear redo. */
  function pushUndo() {
    setUndoStack((stack) => [...stack, { text: textRef.current, layout: layoutRef.current }]);
    setRedoStack([]);
  }

  function apply(op: (text: string) => OpResult): OpResult {
    const result = op(textRef.current);
    if (result.ok) {
      pushUndo();
      setTextState(result.text);
      setDirty(true);
    }
    return result;
  }

  const typingAt = useRef(0);
  function setText(next: string) {
    const now = Date.now();
    if (now - typingAt.current > TYPING_COALESCE_MS) pushUndo();
    typingAt.current = now;
    setTextState(next);
    setDirty(true);
  }

  function move(id: string, pos: { x: number; y: number }) {
    pushUndo();
    setLayout((current) => ({
      nodes: { ...current.nodes, [id]: pos },
    }));
    setDirty(true);
  }

  function undo() {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, { text: textRef.current, layout: layoutRef.current }]);
    setTextState(previous.text);
    setLayout(previous.layout);
    setDirty(true);
  }

  function redo() {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, { text: textRef.current, layout: layoutRef.current }]);
    setTextState(next.text);
    setLayout(next.layout);
    setDirty(true);
  }

  async function putBytes(version: number): Promise<boolean> {
    // The frozen wire body is `{document_yaml, version}` (route 9 400s on
    // any other member); positions ride the bytes as the digest-excluded
    // `metadata.ui` block, which the server re-resolves from the document.
    const sentText = withUILayout(textRef.current, layoutRef.current);
    try {
      const saved = await put.mutateAsync({
        document_yaml: sentText,
        version,
      } as DraftPut);
      setSavedVersion(saved.version);
      // The local bytes are now exactly what the server holds, ui block and
      // all; the layout state re-reads from whichever of the two carries it.
      setTextState(sentText);
      const servedLayout = normalizeLayout(saved.ui_layout);
      setLayout(
        Object.keys(servedLayout.nodes ?? {}).length > 0 ? servedLayout : uiLayoutOfText(sentText),
      );
      setDirty(false);
      return true;
    } catch (error) {
      const body = draftConflictOf(error);
      if (body && typeof body.current_version === "number") {
        // In conflict the local bytes are edits worth keeping: the save never
        // landed, so the draft stays dirty until `overwrite` or `reloadTheirs`.
        setConflict({ currentVersion: body.current_version });
        setDirty(true);
      } else {
        setSaveError(error);
      }
      return false;
    }
  }

  /** Plain function (re-created each render) so `put` is never stale; the
   * keyboard handler reads it through `keyHandler.current` for the same reason. */
  const save = (): Promise<boolean> => putBytes(savedVersion);

  function reloadTheirs() {
    setConflict(null);
    setSaveError(null);
    setDirty(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
  }

  async function overwrite(): Promise<boolean> {
    const version = conflict?.currentVersion;
    if (typeof version !== "number") return false;
    setConflict(null);
    setSaveError(null);
    return putBytes(version);
  }

  // Ctrl/Cmd+S, Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl/Cmd+Y. Inside text inputs
  // every binding but Save is ignored — the textarea keeps its own undo.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const target = event.target as HTMLElement | null;
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
    if (key === "s") {
      event.preventDefault();
      event.stopPropagation();
      void save();
      return;
    }
    if (inField) return;
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (key === "z") {
      event.preventDefault();
      undo();
    } else if (key === "y") {
      event.preventDefault();
      redo();
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return {
    text,
    layout,
    savedVersion,
    dirty,
    parse,
    lastGood,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    saving: put.isPending,
    conflict,
    saveError,
    apply,
    setText,
    move,
    undo,
    redo,
    save,
    reloadTheirs,
    overwrite,
    guard: useUnsavedGuard(dirty),
  };
}
