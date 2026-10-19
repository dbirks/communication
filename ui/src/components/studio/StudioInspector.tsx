/**
 * The Studio inspector (ADR-0042 § 3.3): a schema-driven right column for
 * Workflow Studio. The field table comes from `inspectorSchema` (which reads
 * the canonical v1alpha1 authoring schema), and every edit is a pure
 * text→text op over the draft's YAML (`updateConfig`, `updateNodeFields`,
 * `renameNode` from `graphDoc`) — the inspector never holds a second copy of
 * the document. Shapes the generator cannot form fall back to a JSON box
 * with a warning; a field is never silently hidden.
 *
 * Edits commit on blur/Enter (text), on tick (checkbox) or on change
 * (select), never per keystroke, so the YAML document only moves when the
 * user is done with a field. `readOnly` disables every widget and makes the
 * inspector display-only.
 */
import { useMemo, useState } from "react";
import { isMap, parse, parseDocument, type YAMLMap } from "yaml";
import { Link } from "react-router";
import {
  findNode,
  renameNode,
  updateConfig,
  updateNodeFields,
  type GraphModel,
  type OpResult,
} from "../../lib/pipeline/graphDoc";
import { DEFERRED_KINDS } from "../../lib/pipeline/definition";
import { useAgentProfiles } from "../../api/queries";
import {
  CEL_HINT,
  fieldsFor,
  kindDisplayName,
  JSON_FALLBACK_HINT,
  type InspectorField,
  type InspectorSection,
} from "./inspectorSchema";
import {
  BoolField,
  DepsChips,
  JsonField,
  KvField,
  ListField,
  NumberField,
  RowsField,
  SelectField,
  StepsList,
  TextField,
  TextareaField,
} from "./fields";
import { Field, Input } from "../ds/Field";
import { KindChip } from "../m4/KindChip";

const DEFERRED: Record<string, string | undefined> = DEFERRED_KINDS as Record<
  string,
  string | undefined
>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function getAt(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Deep-clones `root` (the object at `path`'s prefix) and sets/deletes the tail. */
function setAt(root: unknown, tail: string[], value: unknown): unknown {
  const clone: unknown =
    root === undefined || root === null || Array.isArray(root) ? [] : { ...root };
  if (tail.length === 0) return value;
  const [head, ...rest] = tail;
  if (Array.isArray(clone)) {
    (clone as unknown[])[Number(head)] = setAt((clone as unknown[])[Number(head)], rest, value);
    return clone;
  }
  if (!isObj(clone)) return value;
  if (value === undefined) delete (clone as Record<string, unknown>)[head];
  else (clone as Record<string, unknown>)[head] = setAt(clone[head], rest, value);
  return clone;
}

/**
 * A small local op for the pipeline-level panel (metadata.description,
 * spec.inputs): `graphDoc` owns the node ops, but nothing else writes
 * pipeline metadata, so the op lives here — still pure text→text over the
 * yaml Document API, comments preserved.
 */
function setDocValue(text: string, path: string[], value: unknown): OpResult {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message };
  let cur: unknown = doc.contents;
  for (const p of path.slice(0, -1)) {
    if (!isMap(cur)) return { ok: false, error: `document has no ${p}` };
    cur = (cur as YAMLMap).get(p);
  }
  if (!isMap(cur)) return { ok: false, error: `${path.join(".")} is not an object` };
  const last = path[path.length - 1];
  if (value === undefined) (cur as YAMLMap).delete(last);
  else (cur as YAMLMap).set(last, doc.createNode(value));
  return { ok: true, text: doc.toString(), changed: [path.join("/")] };
}

/** Pipeline-level panel: shown when nothing is selected on the canvas. */
function PipelinePanel({
  readOnly,
  doc,
  apply,
}: {
  readOnly: boolean;
  doc: Record<string, unknown>;
  apply: (op: (text: string) => OpResult) => void;
}) {
  const name = String(getAt(doc, ["metadata", "name"]) ?? "");
  const description = getAt(doc, ["metadata", "description"]);
  const inputs = getAt(doc, ["spec", "inputs"]);
  return (
    <div className="space-y-[12px]" data-testid="insp-pipeline">
      <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
        Pipeline
      </p>
      <Field
        id="pipeline-name"
        label="Name"
        hint="read-only — the name is fixed when the pipeline is created"
      >
        <Input
          id="pipeline-name"
          className="font-mono"
          disabled
          value={name}
          data-testid="insp-pipeline-name"
        />
      </Field>
      <TextareaField
        id="pipeline-description"
        label="Description"
        readOnly={readOnly}
        value={description}
        onCommit={(v) => apply((t) => setDocValue(t, ["metadata", "description"], v || undefined))}
      />
      <JsonField
        id="pipeline-inputs"
        label="spec.inputs"
        hint="the inputs schema every run must satisfy (JSON)"
        readOnly={readOnly}
        value={inputs}
        onCommit={(v) => apply((t) => setDocValue(t, ["spec", "inputs"], v))}
      />
    </div>
  );
}

/** The agent profile as a select over the org's launch descriptors. */
function ProfileSelect({
  readOnly,
  value,
  onCommit,
}: {
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string) => void;
}) {
  const { data } = useAgentProfiles();
  const profiles = data?.items ?? [];
  const current = value === undefined || value === null ? "" : String(value);
  const known = profiles.map((p) => p.name);
  return (
    <Field
      id="agent-profile"
      label="Agent profile"
      hint={
        <span className="block">
          Profile settings apply to every step that uses this profile; fields below override only
          this step.{" "}
          <Link to="/agents" className="underline" data-testid="insp-profile-edit">
            Edit profile ↗
          </Link>
        </span>
      }
    >
      <select
        id="agent-profile"
        className="w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--color-accent-ring)]"
        disabled={readOnly}
        value={current}
        data-testid="insp-profile"
        onChange={(e) => onCommit(e.target.value)}
      >
        {profiles.length === 0 ? (
          <option value="">{current !== "" ? current : "no profiles yet"}</option>
        ) : (
          profiles.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name} · {p.launcher_id}
              {p.apm_package_ref ? ` · ${p.apm_package_ref}` : ""}
            </option>
          ))
        )}
        {current !== "" && !known.includes(current) ? (
          <option value={current}>{current}</option>
        ) : null}
      </select>
    </Field>
  );
}

/** One schema field onto its widget; commits go through `onCommit`. */
function FieldControl({
  field,
  id,
  nodeObj,
  model,
  nodeId,
  readOnly,
  commit,
}: {
  field: InspectorField;
  id: string;
  nodeObj: Record<string, unknown>;
  model: GraphModel;
  nodeId: string;
  readOnly: boolean;
  commit: (field: InspectorField, value: unknown) => void;
}) {
  const value = getAt(nodeObj, field.path);
  const node = findNode(model, nodeId);
  const siblings = node
    ? model.nodes
        .filter(
          (n) =>
            n.id !== node.id &&
            n.scope.length === node.scope.length &&
            n.scope.every((s, i) => node.scope[i] === s),
        )
        .map((n) => n.id)
    : [];
  const children = node
    ? model.nodes
        .filter(
          (n) =>
            n.scope.length === node.scope.length + 1 &&
            [...node.scope, node.id].every((s, i) => n.scope[i] === s),
        )
        .map((n) => n.id)
    : [];

  switch (field.widget) {
    case "deps":
      return <DepsChips id={id} value={node?.dependsOn ?? []} />;
    case "steps":
      return <StepsList id={id} value={children} />;
    case "number":
      return (
        <NumberField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          min={field.min}
          max={field.max}
          integerOnly={field.integer === true}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "bool":
      return (
        <BoolField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "select":
      return (
        <SelectField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          options={field.optionsFrom === "siblings" ? siblings : (field.enum ?? [])}
          required={field.required}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "list":
      return (
        <ListField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "rows":
      return (
        <RowsField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          rowFields={field.rowFields ?? []}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "kv":
      return (
        <KvField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "json":
      return (
        <JsonField
          id={id}
          label={field.label}
          hint={field.help ?? JSON_FALLBACK_HINT}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "cel":
      return (
        <TextareaField
          id={id}
          label={field.label}
          hint={field.help ?? CEL_HINT}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    case "textarea":
      return (
        <TextareaField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          onCommit={(v) => commit(field, v)}
        />
      );
    default:
      return (
        <TextField
          id={id}
          label={field.label}
          hint={field.help}
          readOnly={readOnly}
          value={value}
          mono={field.path[field.path.length - 1] === "revisionDigest"}
          onCommit={(v) => commit(field, v)}
        />
      );
  }
}

function nodeObjectOf(doc: unknown, pointer: string): Record<string, unknown> | null {
  let cur: unknown = doc;
  for (const p of pointer.split("/")) {
    if (p === "") continue;
    cur = Array.isArray(cur) ? cur[Number(p)] : isObj(cur) ? cur[p] : undefined;
  }
  return isObj(cur) ? cur : null;
}

export function StudioInspector({
  model,
  nodeId,
  document,
  text,
  readOnly,
  apply,
}: {
  model: GraphModel;
  nodeId: string | null;
  /** The parsed draft document (used when `text` cannot be parsed). */
  document: unknown;
  text: string;
  readOnly: boolean;
  apply: (op: (text: string) => OpResult) => void;
}) {
  const [renameError, setRenameError] = useState<string | null>(null);
  const parsed = useMemo(() => {
    try {
      const d: unknown = parse(text);
      return isObj(d) ? d : null;
    } catch {
      return null;
    }
  }, [text]);
  const doc = parsed ?? (isObj(document) ? document : null);
  const node = nodeId !== null ? findNode(model, nodeId) : undefined;

  if (doc === null) {
    return (
      <div className="rounded-[3px] border border-line bg-paper p-[8px]" data-testid="insp-invalid">
        <p className="font-mono text-[11px] text-faint">
          YAML has errors — the inspector is paused. Fix the YAML to keep editing fields.
        </p>
      </div>
    );
  }

  if (nodeId === null || node === undefined)
    return <PipelinePanel readOnly={readOnly} doc={doc} apply={apply} />;

  const nodeObj = nodeObjectOf(doc, node.pointer);
  if (nodeObj === null) {
    return (
      <div className="rounded-[3px] border border-line bg-paper p-[8px]">
        <p className="font-mono text-[11px] text-faint" data-testid="insp-notfound">
          step {nodeId} is not in the parsed document — the canvas and the YAML disagree
        </p>
      </div>
    );
  }

  const kind = node.kind;
  const deferred = DEFERRED[kind];
  const sections = fieldsFor(kind);

  function commit(field: InspectorField, value: unknown) {
    if (readOnly) return;
    // Route the on-failure select: choosing anything but `route` drops the
    // now-dead errorRoute in the same op, instead of leaving a dangling ref.
    if (field.path[0] === "onFailure" && field.path[1] === "onExecutionError") {
      const cur = getAt(nodeObj, ["onFailure"]);
      const next: Record<string, unknown> = isObj(cur) ? { ...cur } : {};
      if (value === undefined || value === null || value === "") delete next.onExecutionError;
      else next.onExecutionError = value;
      if (value !== "route") delete next.errorRoute;
      apply((t) => updateNodeFields(t, nodeId as string, { onFailure: next }));
      return;
    }
    const topKey = field.path[0];
    if (field.path.length <= 2) {
      const key = field.path.length === 1 ? field.path[0] : field.path[1];
      const v = value === undefined || value === null || value === "" ? undefined : value;
      apply((t) =>
        topKey === "config"
          ? updateConfig(t, nodeId as string, { [key]: v })
          : updateNodeFields(t, nodeId as string, { [key]: v }),
      );
      return;
    }
    const holder = getAt(nodeObj, [topKey, field.path[1]]);
    const nextHolder = setAt(holder, field.path.slice(2), value);
    const v = nextHolder === undefined || nextHolder === null ? undefined : nextHolder;
    apply((t) =>
      topKey === "config"
        ? updateConfig(t, nodeId as string, { [field.path[1]]: v })
        : updateNodeFields(t, nodeId as string, { [topKey]: v }),
    );
  }

  return (
    <div className="space-y-[14px]" data-testid="insp-node">
      {/* Header: what this step is, and what it's called. */}
      <div className="space-y-[8px]" data-testid="insp-header">
        <div className="flex flex-wrap items-center gap-[6px]">
          <KindChip kind={kind} deferredTo={deferred} testid="insp-kind-chip" />
          <span className="font-mono text-[12.5px] font-semibold text-ink">
            {kindDisplayName(kind)}
          </span>
        </div>
        {deferred ? (
          <p className="font-mono text-[11px] text-faint" data-testid="insp-deferred">
            Not runnable yet — {kind} runs in {deferred}. These fields still write the YAML.
          </p>
        ) : null}
        <TextField
          id="node-id"
          label="Node id"
          hint="lowercase letters, digits, - and _ ; other steps may reference it"
          mono
          readOnly={readOnly}
          value={nodeId}
          onCommit={(v) => {
            if (v === nodeId) return;
            // Check the refusal against the current text so the reason can be
            // shown inline; the op itself is applied only when it passes.
            const res = renameNode(text, nodeId as string, v);
            if (!res.ok) {
              setRenameError("error" in res ? res.error : "referenced by other steps");
              return;
            }
            setRenameError(null);
            apply((t) => renameNode(t, nodeId as string, v));
          }}
        />
        {renameError ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            data-testid="insp-rename-error"
          >
            {renameError}
          </p>
        ) : null}
      </div>

      {/* The kind's config, then the fields every node shares. */}
      {sections.map((section: InspectorSection) => (
        <section
          key={section.title}
          className="space-y-[8px] border-t border-line pt-[10px] first:border-t-0"
        >
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
            {section.title}
          </p>
          {section.note ? <p className="font-mono text-[11px] text-faint">{section.note}</p> : null}
          {section.fields.map((field) => {
            const fid = field.path.join("-");
            if (kind === "agent.acp" && field.path[1] === "profile") {
              return (
                <div key={fid} className="space-y-[6px]">
                  <ProfileSelect
                    readOnly={readOnly}
                    value={getAt(nodeObj, ["config", "profile"])}
                    onCommit={(v) => commit(field, v)}
                  />
                  <p className="font-mono text-[11px] text-faint">
                    Model is chosen by the profile's launcher.
                  </p>
                </div>
              );
            }
            return (
              <FieldControl
                key={fid}
                field={field}
                id={fid}
                nodeObj={nodeObj}
                model={model}
                nodeId={nodeId}
                readOnly={readOnly}
                commit={commit}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}
