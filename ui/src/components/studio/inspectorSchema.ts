/**
 * The Studio inspector's field table, derived from the canonical v1alpha1
 * authoring schema (ADR-0042 § 3.3).
 *
 * `fieldsFor(kind)` walks the schema's `node` allOf chain to find the
 * `config$def` the kind is bound to, plus the `commonNodeFields` every node
 * shares, and turns each property into an ordered section of fields. Widgets
 * are chosen from the schema's own keywords (type, enum, minimum/maximum,
 * items, properties, additionalProperties); shapes the generator cannot
 * represent fall back to a JSON textarea — a field is never silently hidden.
 */
import { PIPELINE_SCHEMA_DEFS, type JsonSchema } from "../../lib/pipeline/schemaAsset";

export type Widget =
  | "text"
  | "textarea"
  | "number"
  | "bool"
  | "select"
  | "list"
  | "rows"
  | "kv"
  | "json"
  | "cel"
  | "steps"
  | "deps";

/** One row of a small array-of-objects editor (condition cases, messages…). */
export interface RowField {
  key: string;
  label: string;
  widget: Widget;
  enum?: string[];
}

export interface InspectorField {
  /** Path from the node root: `["config", "passWhen"]`. */
  path: string[];
  label: string;
  widget: Widget;
  /** Schema `enum` values (a select offers exactly these). */
  enum?: string[];
  min?: number;
  max?: number;
  /** Schema type is `integer`: the number widget rejects fractions. */
  integer?: boolean;
  required?: boolean;
  help?: string;
  /** Present when the widget is `rows`: the fixed row shape. */
  rowFields?: RowField[];
  /** `errorRoute` only: options are the node's sibling ids, not a schema enum. */
  optionsFrom?: "siblings";
}

export interface InspectorSection {
  title: string;
  /** A muted, kind-level sentence shown with the section (e.g. pipeline.invoke). */
  note?: string;
  fields: InspectorField[];
}

export const CEL_HINT = "${{ … }} inserts a value; expressions are checked by Validate";

function labelFor(key: string): string {
  const direct = LABELS[key];
  if (direct) return direct;
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
export const JSON_FALLBACK_HINT = "edited as JSON — not a form field yet";

const defs = PIPELINE_SCHEMA_DEFS;

/** Approachable labels; anything absent falls back to a spaced, capitalized key. */
const LABELS: Record<string, string> = {
  passWhen: "Pass when (CEL)",
  failWhen: "Fail early when",
  maxIterations: "Max iterations (1–32)",
  maxDurationSeconds: "Max duration (seconds)",
  carryForward: "Carry outputs to the next iteration",
  onChildFailure: "When an item fails",
  maxConcurrency: "Max items in flight",
  items: "Items (binding or list)",
  prompt: "Prompt",
  profile: "Agent profile",
  sessionMode: "Session",
  fallback: "Fallback",
  context: "Context inputs",
  workspace: "Workspace",
  secretRefs: "Secret references",
  structuredOutput: "Structured output",
  executable: "Executable",
  args: "Arguments",
  cwd: "Working directory",
  env: "Environment",
  outputExtraction: "Output extraction",
  cases: "Cases",
  default: "Default route",
  summary: "Summary",
  artifactRefs: "Artifacts to show",
  approverRoles: "Who can approve",
  approverUserIds: "Specific approvers",
  deadlineSeconds: "Deadline (seconds)",
  onTimeout: "When the deadline passes",
  pipeline: "Pipeline",
  revisionDigest: "Pinned revision (sha256:…)",
  inputs: "Inputs",
  waitFor: "Wait for",
  revisionPolicy: "Revision policy",
  mediaType: "Media type",
  sensitivity: "Sensitivity",
  retentionSeconds: "Retention (seconds)",
  provider: "Provider",
  model: "Model",
  messages: "Messages",
  responseSchema: "Response schema",
  temperature: "Temperature",
  maxTokens: "Max tokens",
  reasoningEffort: "Reasoning effort",
  repositories: "Repositories",
  mode: "Mode",
  when: "Only when (CEL)",
  timeoutSeconds: "Timeout (seconds)",
  maxAttempts: "Max attempts",
  baseDelaySeconds: "Base delay (seconds)",
  baseSeconds: "Base delay (seconds)",
  multiplier: "Backoff multiplier",
  capSeconds: "Delay cap (seconds)",
  maxSeconds: "Delay cap (seconds)",
  jitter: "Add jitter",
  retriableErrors: "Retriable errors",
  onExecutionError: "On execution error",
  errorRoute: "Route to (sibling node)",
  dependsOn: "Run after",
  outputs: "Outputs schema",
  quorum: "Quorum",
  branches: "Branches (steps inside)",
  body: "Steps inside",
  resultBindings: "Result bindings",
  name: "Name",
  value: "Value",
  route: "Route",
  role: "Role",
  content: "Content",
  from: "Source",
  as: "Alias",
  path: "Path",
  repository: "Repository",
  operation: "Operation",
  arguments: "Arguments",
  credentialRef: "Credential",
  judge: "Judge",
  template: "Template",
  delegate: "Delegate",
};

/* ------------------------------------------------------------------ */
/* Schema walking                                                      */
/* ------------------------------------------------------------------ */

const stripRef = (s: JsonSchema): JsonSchema => {
  const rest = { ...s } as Record<string, unknown>;
  delete rest.$ref;
  return rest as JsonSchema;
};

/** Follow `$ref` (in `#/$defs/…`) until the schema stands on its own. */
function resolve(s: JsonSchema, depth = 0): JsonSchema {
  let cur = s;
  while (cur.$ref && depth < 8) {
    const target = defs[cur.$ref.replace(/^#\/\$defs\//, "")];
    if (!target) break;
    cur = { ...target, ...stripRef(cur) };
    depth += 1;
  }
  return cur;
}

/** The `config` `$defs` entry a kind's `node` allOf clause binds to. */
export function configDefFor(kind: string): JsonSchema | null {
  const allOf = (defs.node?.allOf as JsonSchema[] | undefined) ?? [];
  for (const clause of allOf) {
    const k = clause.if?.properties?.kind;
    if (!k) continue;
    const matches =
      k.const === kind || (Array.isArray(k.enum) && (k.enum as unknown[]).includes(kind));
    if (!matches) continue;
    const ref = clause.then?.properties?.config as JsonSchema | undefined;
    if (!ref?.enum) {
      const name = ref?.$ref?.replace(/^#\/\$defs\//, "");
      if (name && defs[name]) return defs[name];
    }
  }
  return null;
}

/** Widget for a scalar schema (after refs are resolved). */
function scalarSpec(s: JsonSchema): {
  widget: Exclude<Widget, "object" | "kv" | "rows" | "steps" | "deps">;
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  fallback: boolean;
} | null {
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const values = s.enum.filter((v): v is string => typeof v === "string");
    if (values.length > 0) return { widget: "select", enum: values, fallback: false };
  }
  const types: string[] = s.type ? (Array.isArray(s.type) ? s.type : [s.type]) : [];
  if (types.includes("boolean")) return { widget: "bool", fallback: false };
  if (types.includes("integer") || types.includes("number")) {
    return {
      widget: "number",
      min: s.minimum,
      max: s.maximum,
      integer: types.includes("integer"),
      fallback: false,
    };
  }
  // `oneOf` over a const and a real type (cwd) — take the real branch.
  if (s.oneOf) {
    for (const part of s.oneOf) {
      const inner = scalarSpec(resolve(part));
      if (inner && !inner.fallback) return { ...inner, fallback: false };
    }
  }
  if (types.includes("string")) return { widget: "text", fallback: false };
  return null;
}

/** Refs whose meaning is fixed by ADR-0021/0022/0027 naming. */
const REF_WIDGET: Record<string, Widget> = {
  celExpression: "cel",
  bindingText: "textarea",
  bindingOrString: "text",
  bindingValue: "text",
  jsonSchemaObject: "json",
  identifier: "text",
  secretRef: "text",
  relativePath: "text",
};

interface Spec {
  widget: Widget | "object" | "kv";
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  help?: string;
  properties?: Record<string, JsonSchema>;
  rowFields?: RowField[];
}

/** How one schema value shape maps onto a widget. */
function specOf(raw: JsonSchema): Spec {
  let s = raw;
  if (s.$ref) {
    const name = s.$ref.replace(/^#\/\$defs\//, "");
    if (REF_WIDGET[name]) {
      const help = name === "celExpression" || name === "bindingText" ? CEL_HINT : undefined;
      return { widget: REF_WIDGET[name], help };
    }
    s = resolve(s);
  }
  const sc = scalarSpec(s);
  if (sc && !sc.fallback) {
    const widget =
      s.type === "string" && s.maxLength !== undefined && s.maxLength >= 200
        ? "textarea"
        : sc.widget;
    return {
      widget: widget as Exclude<Widget, "object" | "kv">,
      enum: sc.enum,
      min: sc.min,
      max: sc.max,
      integer: sc.integer,
    };
  }
  if (
    s.type === "array" ||
    (s.items !== undefined && s.type === undefined && s.minItems !== undefined)
  ) {
    const item = s.items ? resolve(s.items) : null;
    if (item && item.type === "object" && item.properties) {
      const rowFields: RowField[] = Object.entries(item.properties).map(([k, v]) => {
        const sub = specOf(v);
        return {
          key: k,
          label: labelFor(k),
          widget: sub.widget === "object" || sub.widget === "kv" ? "text" : sub.widget,
          enum: sub.enum,
        };
      });
      return { widget: "rows", rowFields };
    }
    const itemSpec = item ? scalarSpec(item) : null;
    return { widget: "list", enum: itemSpec?.enum };
  }
  if (s.type === "object") {
    if (s.properties && Object.keys(s.properties).length > 0) {
      return { widget: "object", properties: s.properties };
    }
    if (s.additionalProperties && s.additionalProperties !== true) {
      return { widget: "kv" };
    }
  }
  // Anything the generator cannot represent: a JSON box, never a hidden field.
  return { widget: "json", help: JSON_FALLBACK_HINT };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** One property of an object into a field (or a nested spec). */
function fieldFrom(
  path: string[],
  key: string,
  raw: JsonSchema,
  requiredKeys: string[] | undefined,
): InspectorField | null {
  const spec = specOf(raw);
  const base: InspectorField = {
    path: [...path, key],
    label: labelFor(key),
    widget: spec.widget as Widget,
    enum: spec.enum,
    min: spec.min,
    max: spec.max,
    integer: spec.integer,
    required: requiredKeys?.includes(key) ?? false,
    help: spec.help,
    rowFields: spec.rowFields,
  };
  // Scope bodies are edited on the canvas; the inspector lists them read-only.
  if (key === "body" || key === "branches") return { ...base, widget: "steps" };
  return base;
}

/** Nested objects become sub-sections (retry.backoff, onFailure, workspace…). */
function sectionsForObject(
  title: string,
  base: string[],
  properties: Record<string, JsonSchema>,
  required: string[] | undefined,
  depth: number,
): InspectorSection[] {
  const fields: InspectorField[] = [];
  const nested: InspectorSection[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    // Scope bodies are edited on the canvas; the inspector lists them as a
    // read-only steps list, never as a nested rows editor.
    if (key === "body" || key === "branches") {
      const steps = fieldFrom(base, key, raw, required);
      if (steps) fields.push(steps);
      continue;
    }
    const spec = specOf(raw);
    if (spec.widget === "object" && spec.properties && depth < 2) {
      nested.push(
        ...sectionsForObject(
          `${title} · ${labelFor(key)}`,
          [...base, key],
          spec.properties,
          (raw as JsonSchema).required,
          depth + 1,
        ),
      );
      continue;
    }
    const field = fieldFrom(base, key, raw, required);
    if (field) fields.push(field);
  }
  if (fields.length === 0 && nested.length === 0) return [];
  return [{ title, fields }, ...nested];
}

const KIND_NOTES: Record<string, string> = {
  "pipeline.invoke": 'Child runs pin an explicit revision — never "latest".',
};

function configSections(kind: string): InspectorSection[] {
  const cfg = configDefFor(kind);
  if (!cfg || !cfg.properties) return [];
  const sections = sectionsForObject(kindLabel(kind), ["config"], cfg.properties, cfg.required, 0);
  const note = KIND_NOTES[kind];
  if (note && sections.length > 0) sections[0] = { ...sections[0], note };
  return sections;
}

const KIND_WORD: Record<string, string> = {
  "agent.acp": "Coding agent",
  "model.chat": "Model chat",
  "process.exec": "Command",
  condition: "Condition",
  "human.approval": "Human approval",
  until: "Repeat until",
  for_each: "For each",
  parallel: "Parallel",
  join: "Join",
  "pipeline.invoke": "Pipeline call",
  "artifact.publish": "Artifact publish",
  "git.commit": "Git commit",
  "git.publish": "Git publish",
  "integration.query": "Integration query",
  "integration.action": "Integration action",
  gate: "Gate",
};

function kindLabel(kind: string): string {
  return KIND_WORD[kind] ?? kind;
}

/** The approachable, human word for a kind ("Repeat until", "Command", …). */
export function kindDisplayName(kind: string): string {
  return KIND_WORD[kind] ?? kind;
}

function commonSections(): InspectorSection[] {
  // `commonNodeFields` is a flat table of the shared node fields (when,
  // timeoutSeconds, retry, …) — the fields are its direct keys, not a
  // `properties` block. `id` belongs to the header, not the common section.
  const c = defs.commonNodeFields as Record<string, JsonSchema>;
  const fields: InspectorField[] = [{ path: ["dependsOn"], label: "Run after", widget: "deps" }];
  for (const key of ["when", "timeoutSeconds", "outputs"] as const) {
    const schema = c[key];
    if (schema) {
      const f = fieldFrom([], key, schema, undefined);
      if (f) fields.push(f);
    }
  }

  const retry = resolve(defs.retryPolicy);
  const retrySection = sectionsForObject(
    "Retry",
    ["retry"],
    retry.properties ?? {},
    retry.required,
    1,
  );
  const failure = resolve(defs.nodeFailure);
  const failureSection = sectionsForObject(
    "On failure",
    ["onFailure"],
    failure.properties ?? {},
    failure.required,
    1,
  );
  // The error route's options are sibling node ids, not a schema enum.
  for (const section of failureSection) {
    for (const field of section.fields) {
      if (field.path[field.path.length - 1] === "errorRoute") {
        field.widget = "select";
        field.optionsFrom = "siblings";
      }
    }
  }
  return [{ title: "Common", fields }, ...retrySection, ...failureSection];
}

/**
 * The ordered inspector sections for a node kind: the kind's config (derived
 * from its schema `$defs` entry) followed by the fields every node shares.
 * A kind the allOf chain does not cover still gets its Common section, and
 * this function never throws on any of the schema's kind enum values.
 */
export function fieldsFor(kind: string): InspectorSection[] {
  const config = (() => {
    try {
      return configSections(kind);
    } catch {
      return [];
    }
  })();
  return [...config, ...commonSections()];
}

/** The `kind` values the canonical schema's `node` def admits. */
export const SCHEMA_KINDS: string[] = Array.isArray(defs.node?.properties?.kind?.enum)
  ? (defs.node?.properties?.kind?.enum as string[])
  : [];
