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
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../api/client";
import { useAgentProfiles, useSystemSandbox } from "../../api/queries";
import { nodeTemplateKeys, type NodeTemplate } from "../../api/nodeTemplates";
import type { components } from "../../api/schema";

type NodeTemplateCreateBody = components["schemas"]["NodeTemplateCreate"];
import { useLaunchers } from "../../api/launchers";
import { sandboxChip } from "../../lib/profiles";
import { NewProfileDialog } from "../profiles/NewProfileDialog";
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
import { Button } from "../ds/Button";
import { routes } from "../../lib/routes";
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

/** The select value that means "open New profile…" — never written to the draft. */
const NEW_PROFILE_VALUE = "__new_profile__";

/** The `name`/`launcher_id` the chip needs; org profile rows satisfy this. */
interface AgentProfileLike {
  id: string;
  name: string;
  launcher_id: string;
  apm_package_ref?: string | null;
}

/**
 * The 4b SUGGESTED default (shots/4b): the `config.profile` of the nearest
 * upstream `agent.acp` node — BFS over `dependsOn`, staying in the node's
 * own scope (edges only cross scopes through the scope itself). Null when
 * no upstream agent step carries a profile yet.
 */
function suggestedUpstreamProfile(
  model: GraphModel,
  doc: Record<string, unknown>,
  nodeId: string,
): { nodeId: string; profile: string } | null {
  const me = findNode(model, nodeId);
  if (me === undefined) return null;
  const seen = new Set<string>([nodeId]);
  const queue = [...me.dependsOn];
  while (queue.length > 0) {
    const depId = queue.shift() as string;
    if (seen.has(depId)) continue;
    seen.add(depId);
    const dep = findNode(model, depId);
    if (dep === undefined || dep.scope.length !== me.scope.length) continue;
    if (dep.kind === "agent.acp") {
      const nodeObj = nodeObjectOf(doc, dep.pointer);
      const profile = nodeObj === null ? undefined : getAt(nodeObj, ["config", "profile"]);
      if (profile !== undefined && profile !== null && String(profile) !== "") {
        return { nodeId: dep.id, profile: String(profile) };
      }
    }
    queue.push(...dep.dependsOn);
  }
  return null;
}

/** The agent profile as a select over the org's launch descriptors.
 *
 * 4b: every option shows the sandbox chip (glyph + words, never colour
 * alone) for the profile's launcher; a NEW agent node (no `config.profile`
 * yet) defaults to the nearest upstream agent node's profile, marked
 * SUGGESTED; the last option `+ New profile…` opens the NewProfileDialog
 * with `forStep` = this node's id — choosing it never mutates the draft,
 * only the created callback writes `config.profile`.
 */
function ProfileSelect({
  readOnly,
  value,
  onCommit,
  model,
  nodeId,
  doc,
}: {
  readOnly: boolean;
  value: unknown;
  onCommit: (value: string) => void;
  model: GraphModel;
  nodeId: string;
  doc: Record<string, unknown>;
}) {
  const { data } = useAgentProfiles();
  const { data: sandbox } = useSystemSandbox();
  const { data: launcherList } = useLaunchers();
  const [creating, setCreating] = useState(false);
  const profiles: AgentProfileLike[] = (data?.items ?? []) as AgentProfileLike[];
  const current = value === undefined || value === null ? "" : String(value);
  const known = new Set(profiles.map((p) => p.name));
  const launchers = launcherList?.launchers ?? null;
  const suggested = current === "" ? suggestedUpstreamProfile(model, doc, nodeId) : null;
  const shown = current !== "" ? current : (suggested?.profile ?? "");

  const optionLabel = (p: AgentProfileLike): string => {
    const chip = sandboxChip({
      launcherId: p.launcher_id,
      launchers,
      sandbox,
    });
    const base =
      `${p.name} · ${p.launcher_id}` +
      (p.apm_package_ref ? ` · ${p.apm_package_ref}` : "") +
      ` ${chip.glyph} ${chip.text}`;
    if (suggested !== null && suggested.profile === p.name)
      return `SUGGESTED · same as ${suggested.nodeId} — ${base}`;
    return base;
  };

  return (
    <Field
      id="agent-profile"
      label="Agent profile"
      hint={
        <span className="block">
          Profile settings apply to every step that uses this profile; fields below override only
          this step.{" "}
          <Link to={routes.profiles()} className="underline" data-testid="insp-profile-edit">
            Edit profile ↗
          </Link>
        </span>
      }
    >
      <select
        id="agent-profile"
        className="w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--color-accent-ring)]"
        disabled={readOnly}
        value={shown}
        data-testid="insp-profile"
        onChange={(e) => {
          if (e.target.value === NEW_PROFILE_VALUE) {
            setCreating(true);
            return; // the draft is not touched until a profile is actually created
          }
          onCommit(e.target.value);
        }}
      >
        {profiles.length === 0 ? (
          <option value="">{shown !== "" ? shown : "no profiles yet"}</option>
        ) : (
          profiles.map((p) => (
            <option key={p.id} value={p.name}>
              {optionLabel(p)}
            </option>
          ))
        )}
        {shown !== "" && !known.has(shown) ? <option value={shown}>{shown}</option> : null}
        <option value={NEW_PROFILE_VALUE} data-testid="insp-profile-new">
          + New profile…
        </option>
      </select>
      {suggested !== null && current === "" ? (
        <p className="font-mono text-[11px] text-faint" data-testid="insp-profile-suggested">
          SUGGESTED · same as {suggested.nodeId}
        </p>
      ) : null}
      {creating ? (
        <NewProfileDialog
          open={creating}
          onClose={() => setCreating(false)}
          forStep={nodeId}
          onCreated={(profile: { id: string; name: string; launcher_id: string }) => {
            setCreating(false);
            if (!readOnly) onCommit(profile.name);
          }}
        />
      ) : null}
    </Field>
  );
}

/**
 * The unchecked "Also save as a reusable step" + `Save as step` (4b).
 * Checking the box arms the button; the button POSTs the node's kind +
 * config as a node template (slug = node id, version 1.0.0) and shows
 * either a link to `/steps/{id}` or the API error (a 403 for a caller
 * without the library role stays an error, not a silent skip).
 */
function SaveAsStep({
  nodeId,
  kind,
  config,
  readOnly,
}: {
  nodeId: string;
  kind: string;
  config: unknown;
  readOnly: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<NodeTemplate | null>(null);
  const queryClient = useQueryClient();

  const save = () => {
    if (!armed || busy || readOnly) return;
    setBusy(true);
    setError(null);
    const body: NodeTemplateCreateBody = {
      slug: nodeId,
      display_name: `${kindDisplayName(kind)} · ${nodeId}`,
      kind,
      parameters: {},
      // The OpenAPI-generated `Record<string, never>` is the `object` shape;
      // the node's config values are plain strings/maps, so a cast is the
      // only honest fit here (the body is validated server-side).
      config: (isObj(config) ? config : {}) as Record<string, never>,
      version_label: "1.0.0",
    };
    void apiFetch<NodeTemplate>("/api/v1/node-templates", { method: "POST", json: body })
      .then((template) => {
        setCreated(template);
        void queryClient.invalidateQueries({ queryKey: nodeTemplateKeys.list });
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? `${e.status} ${e.message}` : String(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-[6px]" data-testid="insp-save-step">
      <label className="flex items-center gap-[6px] font-mono text-[12.5px] text-ink">
        <input
          type="checkbox"
          className="accent-ink"
          disabled={readOnly}
          checked={armed}
          data-testid="insp-save-step-toggle"
          onChange={(e) => setArmed(e.target.checked)}
        />
        Also save as a reusable step
      </label>
      <button
        type="button"
        className="rounded-[3px] border border-line-strong bg-paper px-[10px] py-1 font-mono text-[12px] text-ink hover:border-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--color-accent-ring)]"
        disabled={!armed || busy || readOnly}
        onClick={save}
        data-testid="insp-save-step-button"
      >
        {busy ? "Saving…" : "Save as step"}
      </button>
      {created !== null ? (
        <p className="font-mono text-[11px] text-faint" data-testid="insp-save-step-done">
          Saved as step “{created.slug}” v1.0.0. "
          <Link
            to={routes.step(created.id)}
            className="underline"
            data-testid="insp-save-step-link"
          >
            View the step ↗
          </Link>
        </p>
      ) : null}
      {error !== null ? (
        <p
          className="font-mono text-[11px] text-st-failed-tag-fg"
          data-testid="insp-save-step-error"
        >
          {error}
        </p>
      ) : null}
    </div>
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
  onDelete,
}: {
  model: GraphModel;
  nodeId: string | null;
  /** The parsed draft document (used when `text` cannot be parsed). */
  document: unknown;
  text: string;
  readOnly: boolean;
  apply: (op: (text: string) => OpResult) => void;
  /** The page's delete op — the inspector's Delete runs the same one as the keyboard. */
  onDelete?: (id: string) => void;
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
  const prevId = node.dependsOn[0] ?? null;

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
        <div className="flex flex-wrap items-center gap-[8px]">
          <KindChip kind={kind} deferredTo={deferred} testid="insp-kind-chip" />
          <span className="text-[15px] font-semibold text-ink" data-testid="insp-node-id-label">
            {nodeId}
          </span>
          <span className="font-mono text-[11px] text-muted" data-testid="insp-after">
            {prevId ? `${kind} · after ${prevId}` : kind}
          </span>
          <Button
            variant="danger"
            compact
            className="ml-auto"
            onClick={() => onDelete?.(nodeId)}
            data-testid="insp-delete"
          >
            Delete
          </Button>
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
                    model={model}
                    nodeId={nodeId}
                    doc={doc}
                  />
                  <p className="font-mono text-[11px] text-faint">
                    Model is chosen by the profile's launcher.
                  </p>
                  <SaveAsStep
                    key={`save-step-${nodeId}`}
                    nodeId={nodeId}
                    kind={kind}
                    config={getAt(nodeObj, ["config"])}
                    readOnly={readOnly}
                  />
                </div>
              );
            }
            // 4b: the agent prompt field reads as "What should it do?"
            // (label only — the field, its widget and its op are unchanged).
            const shown =
              kind === "agent.acp" && field.path[0] === "config" && field.path[1] === "prompt"
                ? { ...field, label: "What should it do?" }
                : field;
            return (
              <FieldControl
                key={fid}
                field={shown}
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
