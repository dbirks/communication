/**
 * duplicateNode — the Studio's "Duplicate" affordance (design 1g): copy a
 * step right after itself in the same scope, same kind and config, no
 * incoming or outgoing edges copied — the copy takes the original's
 * `dependsOn`, so the human's edges are untouched.
 */
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { toBlockString } from "./blockYaml";
import { parseGraph, uniqueId, type OpResult } from "./graphDoc";

interface Located {
  item: YAMLMap;
  list: YAMLSeq;
  index: number;
  scope: string[];
}

function findInSeq(
  list: YAMLSeq,
  scope: string[],
  prefix: string,
  id: string,
): Located | { error: string } {
  for (let i = 0; i < list.items.length; i += 1) {
    const item = list.items[i];
    if (!isMap(item)) continue;
    const itemId = String(item.get("id") ?? "");
    if (itemId === id) return { item, list, index: i, scope };
    const kind = String(item.get("kind") ?? "");
    const cfg = item.get("config");
    const body = isMap(cfg) ? cfg.get("body") : undefined;
    const branches = isMap(cfg) ? cfg.get("branches") : undefined;
    if ((kind === "until" || kind === "for_each") && isMap(body) && isSeq(body.get("nodes"))) {
      const sub = findInSeq(
        body.get("nodes") as YAMLSeq,
        [...scope, itemId],
        `${prefix}/${i}/config/body/nodes`,
        id,
      );
      if (!("error" in sub)) return sub;
    }
    if (kind === "parallel" && isSeq(branches)) {
      for (let b = 0; b < branches.items.length; b += 1) {
        const branch = branches.items[b];
        if (isMap(branch) && isSeq(branch.get("nodes"))) {
          const sub = findInSeq(
            branch.get("nodes") as YAMLSeq,
            [...scope, itemId, String(b)],
            `${prefix}/${i}/config/branches/${b}/nodes`,
            id,
          );
          if (!("error" in sub)) return sub;
        }
      }
    }
  }
  return { error: `no node with id ${id}` };
}

function cloneYamlValue(value: unknown): unknown {
  if (isMap(value)) {
    const map = new YAMLMap();
    for (const pair of value.items) map.set(pair.key, cloneYamlValue(pair.value));
    return map;
  }
  if (isSeq(value)) {
    const seq = new YAMLSeq();
    for (const val of value.items) seq.items.push(cloneYamlValue(val));
    return seq;
  }
  return value;
}

/**
 * Copy the step `id` as `<id>_copy` (unique across the document), inserted
 * right after the original in the same scope, same kind + config, no edges
 * copied — the copy takes the original's dependsOn.
 */
export function duplicateNode(text: string, id: string): OpResult {
  const parsed = parseGraph(text);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const newId = uniqueId(parsed.model, `${id}_copy`);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message };
  const root = doc.contents;
  if (!isMap(root) || String((root as YAMLMap).get("kind") ?? "") !== "Pipeline") {
    return { ok: false, error: "document is not a Pipeline with spec.nodes" };
  }
  const spec = isMap(root) ? (root as YAMLMap).get("spec") : undefined;
  if (!isMap(spec)) return { ok: false, error: "document has no spec" };
  const nodes = spec.get("nodes");
  if (!isSeq(nodes)) return { ok: false, error: "document has no nodes" };
  const found = findInSeq(nodes, [], "/spec/nodes", id);
  if ("error" in found) return { ok: false, error: found.error };
  const copy: Record<string, unknown> = { id: newId, kind: String(found.item.get("kind") ?? "") };
  const deps = found.item.get("dependsOn");
  if (deps !== undefined) copy.dependsOn = doc.createNode((deps as YAMLSeq).items.map(String));
  const cfg = found.item.get("config");
  if (cfg !== undefined) copy.config = doc.createNode(cloneYamlValue(cfg));
  found.list.items.splice(found.index + 1, 0, doc.createNode(copy) as YAMLMap);
  // Design 2d: a newly created node serializes in block style like every other
  // write path — a flow-style source is re-emitted as block when it is edited.
  return { ok: true, text: toBlockString(doc), changed: [newId] };
}
