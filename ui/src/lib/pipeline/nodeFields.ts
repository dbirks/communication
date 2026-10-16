/**
 * Per-node form fields for the draft editor (wishlist W4).
 *
 * The draft editor owns one textarea holding the whole YAML document, and the
 * draft API owns one write (`PUT /drafts/{id}`) that carries those bytes. A
 * per-step form must therefore *edit the text*, not replace it: every field
 * write lands on the single line its JSON pointer names and leaves the rest of
 * the document byte-identical, so the textarea stays authoritative and Save
 * still PUTs the whole document.
 *
 * What this module deliberately is not:
 * - Not a YAML parser. It reuses `indexPointers` (a reader, not a parser) and
 *   only ever rewrites one `key: value` line, plus the body lines of a `|`
 *   block scalar that key already owns.
 * - Not a schema. `editableFields` is a fixed table over the kinds whose
 *   config has scalar or flat-array members in
 *   `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json`; every
 *   other kind gets no fields and says so, and `yamlOnlyKeys` names the keys of
 *   a covered kind that stay in the textarea. `agent.acp` has no system-prompt
 *   member at all — the system instructions belong to the profile revision
 *   (`04:26`), which stays out of scope until an ADR decides node vs profile.
 * - Not smart about quoting. A string round-trips as a single-quoted scalar
 *   (`'` doubled), a multi-line string as a `|` block indented two spaces
 *   deeper than its key, a boolean and a number bare. That rewrites a key's
 *   style on touch, which is why the untouched lines, not the edited one, are
 *   what the tests pin byte-for-byte.
 */
import { indexPointers, type PointerLocation } from "./yamlPointer";

/** One `spec.nodes` entry, as far as the reader can see it. */
export interface NodeSummary {
  /** Position under `/spec/nodes` — the pointer index, not the id. */
  index: number;
  /** The node's `id`, or null when the document does not carry one. */
  id: string | null;
  /** The node's `kind`, or null when the document does not carry one. */
  kind: string | null;
}

/**
 * How a field is edited. `number` and `bool` write a bare scalar, never a
 * quoted one (`carryForward: 'true'` is a string to the schema, `true` is the
 * boolean it asked for). `list` edits a flat array of scalars — flow
 * (`[a, b]`) or block (`- a`) as one comma-separated field, in the style the
 * document already uses.
 */
export type FieldType = "text" | "textarea" | "number" | "bool" | "list";

export interface NodeField {
  /** The key as it appears in the document. */
  key: string;
  label: string;
  type: FieldType;
  /** This field's JSON pointer for the node at `index`. */
  pointer: (index: number) => string;
  /** Allowed values (a schema `enum`): the field offers these rather than an
   * empty box. Free text is still accepted — the server's finding is the
   * authority on a value outside the list, not this widget. */
  options?: readonly string[];
}

/** Shown verbatim when a kind has no fields — the YAML is the only editor. */
export const NO_EDITABLE_FIELDS = "no editable fields — edit the YAML";

const configPointer = (index: number, key: string) => `/spec/nodes/${index}/config/${key}`;
const timeoutPointer = (index: number) => `/spec/nodes/${index}/timeoutSeconds`;
/** A field whose config key matches its own name — the shape of almost all of them. */
const configField = (
  key: string,
  label: string,
  type: FieldType,
  options?: readonly string[],
): NodeField => ({ key, label, type, pointer: (i) => configPointer(i, key), options });

/** The schema's `enum` members, copied verbatim so the form cannot invent a
 * value the compiler would refuse. */
const ROLE_OPTIONS = ["maintainer", "contributor"] as const;
const SESSION_MODE_OPTIONS = ["new", "resume_if_supported", "continue_live"] as const;
const ON_TIMEOUT_OPTIONS = ["fail", "cancel_run", "expire"] as const;
const ON_CHILD_FAILURE_OPTIONS = ["stop", "collect_and_continue", "fail_after_all"] as const;
const ARTIFACT_KIND_OPTIONS = [
  "markdown",
  "image",
  "html",
  "json",
  "patch",
  "archive",
  "checkpoint",
] as const;
const SENSITIVITY_OPTIONS = ["standard", "internal", "restricted", "secret"] as const;
const BOOL_OPTIONS = ["true", "false"] as const;

/**
 * Keys checked against the schema's `configAgentAcp`/`configProcessExec`/
 * `configModelChat` and the § 7 exit seed
 * (`docs/compatibility/probes/m4/pipeline.yaml`): `config.profile`,
 * `config.prompt` and node-level `timeoutSeconds` on the `agent.acp` nodes,
 * `config.executable` on `process.exec`, `config.model` on `model.chat`.
 *
 * `model.chat` is listed with a `prompt` because the brief asks for one, but the
 * schema's `configModelChat` carries `messages` (an array) and no `prompt`, so
 * that field only ever edits a prompt a hand-written draft already has; a
 * document without one gets "add it in the YAML" rather than a bogus key.
 */
const TABLE: Record<string, NodeField[]> = {
  "agent.acp": [
    { key: "profile", label: "Profile", type: "text", pointer: (i) => configPointer(i, "profile") },
    {
      key: "prompt",
      label: "Prompt",
      type: "textarea",
      pointer: (i) => configPointer(i, "prompt"),
    },
    configField("sessionMode", "Session mode", "text", SESSION_MODE_OPTIONS),
    configField("fallback", "Fallback", "text", ["new", "fail"] as const),
    configField("secretRefs", "Secret references", "list"),
    {
      key: "timeoutSeconds",
      label: "Timeout (seconds)",
      type: "number",
      pointer: timeoutPointer,
    },
  ],
  "process.exec": [
    {
      key: "executable",
      label: "Executable",
      type: "text",
      pointer: (i) => configPointer(i, "executable"),
    },
    configField("args", "Arguments", "list"),
    configField("cwd", "Working directory", "text"),
    configField("secretRefs", "Secret references", "list"),
    {
      key: "timeoutSeconds",
      label: "Timeout (seconds)",
      type: "number",
      pointer: timeoutPointer,
    },
  ],
  "model.chat": [
    { key: "model", label: "Model", type: "text", pointer: (i) => configPointer(i, "model") },
    {
      key: "prompt",
      label: "Prompt",
      type: "textarea",
      pointer: (i) => configPointer(i, "prompt"),
    },
  ],
  // Keys below are the `configHumanApproval`/`configUntil`/`configForEach`/
  // `configCondition`/`configArtifactPublish` members of the canonical schema
  // that are a scalar or a flat array of scalars; whatever is nested
  // (`body.nodes`, `cases[]`, `from`, `resultBindings`, `env`) stays YAML-only
  // and `yamlOnlyKeys` says which per kind.
  "human.approval": [
    configField("summary", "Summary", "textarea"),
    configField("approverRoles", "Approver roles", "list", ROLE_OPTIONS),
    configField("approverUserIds", "Approver user ids", "list"),
    configField("artifactRefs", "Artifact references", "list"),
    configField("deadlineSeconds", "Deadline (seconds)", "number"),
    configField("onTimeout", "On timeout", "text", ON_TIMEOUT_OPTIONS),
  ],
  until: [
    configField("maxIterations", "Max iterations", "number"),
    configField("maxDurationSeconds", "Max duration (seconds)", "number"),
    configField("passWhen", "Pass when (CEL)", "text"),
    configField("failWhen", "Fail when (CEL)", "text"),
    configField("carryForward", "Carry forward", "bool", BOOL_OPTIONS),
  ],
  for_each: [
    configField("items", "Items", "text"),
    configField("maxConcurrency", "Max concurrency", "number"),
    configField("onChildFailure", "On child failure", "text", ON_CHILD_FAILURE_OPTIONS),
  ],
  condition: [configField("default", "Default route", "text")],
  "artifact.publish": [
    configField("name", "Artifact name", "text"),
    configField("kind", "Artifact kind", "text", ARTIFACT_KIND_OPTIONS),
    configField("mediaType", "Media type", "text"),
    configField("sensitivity", "Sensitivity", "text", SENSITIVITY_OPTIONS),
    configField("retentionSeconds", "Retention (seconds)", "number"),
  ],
};

/**
 * The config keys a kind has that this form will not touch, per
 * `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json`: an
 * `additionalProperties: false` object means nothing here can add one, so the
 * editor names what stays in the textarea instead of looking like full cover.
 */
const YAML_ONLY: Record<string, string[]> = {
  "agent.acp": ["config.context (from/as objects)", "config.workspace", "config.structuredOutput"],
  "process.exec": ["config.env", "config.workspace", "config.outputExtraction"],
  "model.chat": ["config.messages", "config.responseSchema", "config.provider"],
  "human.approval": [],
  until: ["config.body (the nested node graph)", "config.resultBindings"],
  for_each: ["config.body (the nested node graph)", "config.resultBindings"],
  condition: ["config.cases (when/route pairs)"],
  "artifact.publish": ["config.from (mode/path/value object)"],
};

/** The keys of `kind` this form cannot edit, in schema order; [] = it covers them all. */
export function yamlOnlyKeys(kind: string | null): string[] {
  if (kind === null) return [];
  return YAML_ONLY[kind] ?? [];
}

/** The fields to show for a node `kind`; unknown kinds get none. */
export function editableFields(kind: string | null): NodeField[] {
  if (kind === null) return [];
  return TABLE[kind] ?? [];
}

/** Every top-level `spec.nodes` entry, in document order. Nested `body` nodes
 * are not projectable into this list: their pointers run through
 * `/config/body/nodes`, which the form does not reach. */
export function listNodes(text: string): NodeSummary[] {
  const doc = open(text);
  const nodes: NodeSummary[] = [];
  for (const [pointer, loc] of doc.pointers) {
    const found = /^\/spec\/nodes\/(\d+)$/.exec(pointer);
    if (!found || !loc.exact) continue;
    nodes.push({
      index: Number(found[1]),
      id: readIn(doc, `${pointer}/id`, "text"),
      kind: readIn(doc, `${pointer}/kind`, "text"),
    });
  }
  return nodes.sort((a, b) => a.index - b.index);
}

/**
 * Read `pointer`'s scalar out of `text`, or null when the document carries no
 * scalar there — an absent key, a key whose value is a nested mapping or
 * sequence, or a value swallowed by a flow scalar. The form turns null into
 * "not in this document — add it in the YAML".
 *
 * A block scalar reads as its dedented body without the trailing newline `|`
 * would keep: the editor round-trips that back to the same bytes. A double-
 * quoted scalar reads as its text minus the quotes; `\n`-style escapes are not
 * decoded, because a draft that needs them is better edited as a block.
 *
 * `type: "list"` is the exception to "never a sequence": a *flat* array of
 * scalars — flow (`[a, b]`) or block (`- a`) — reads as one comma-separated
 * line. An array whose items are objects (`cases`) is still structure, so it
 * reads as null.
 */
export function readScalar(text: string, pointer: string, type: FieldType = "text"): string | null {
  return readIn(open(text), pointer, type);
}

export interface WriteResult {
  /** The document with the one line (and, for a block, its body) rewritten. */
  text: string;
  /** True when the key is not there to write: the caller changes nothing. */
  missing: boolean;
}

/**
 * Rewrite only `pointer`'s value, leaving every other byte of `text` alone.
 * Returns `text` untouched plus `missing: true` when the key is absent or holds
 * structure this form must not overwrite.
 */
export function writeScalar(
  text: string,
  pointer: string,
  value: string,
  type: FieldType = "text",
): WriteResult {
  return writeIn(open(text), pointer, value, type);
}

interface Doc {
  text: string;
  lines: string[];
  eol: string;
  pointers: Map<string, PointerLocation>;
}

function open(text: string): Doc {
  // `indexPointers` indexes `text.split(/\r?\n/)`, so the same split keeps its
  // 1-based line numbers aligned with `lines[]`; the eol is put back on join.
  return {
    text,
    lines: text.split(/\r?\n/),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    pointers: indexPointers(text),
  };
}

/** `- id: plan` — the dash is captured apart so the rewritten line keeps it. */
const KEY_LINE = /^([ \t]*)(-[ \t]+)?("[^"]*"|'[^']*'|[^:]*?)([ \t]*:[ \t]*)(.*)$/;

/** `|` / `>` / `>-` … with an optional trailing comment. */
function splitIndicator(rest: string): { indicator: string; comment: string } | null {
  const m = /^([|>][+-]?\d*)(?:[ \t]+(#.*)|[ \t]*)$/.exec(rest);
  return m ? { indicator: m[1], comment: m[2] ?? "" } : null;
}

/** End index (inclusive) of a quoted scalar; -1 when it never closes. */
function quoteEnd(value: string, quote: string): number {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] !== quote) continue;
    if (quote === "'" && value[i + 1] === "'") {
      i += 1;
      continue;
    }
    if (quote === '"' && value[i - 1] === "\\") continue;
    return i;
  }
  return -1;
}

/** A mapping key's text: quoted keys lose their quotes, plain ones are whole. */
function keyName(key: string): string {
  const quote = key[0];
  if ((quote !== "'" && quote !== '"') || !key.endsWith(quote) || key.length < 2) return key;
  return unquote(key);
}

/** Unescape a single-quoted scalar; a double-quoted one loses only its quotes. */
function unquote(value: string): string {
  const quote = value[0];
  const end = quoteEnd(value, quote);
  if (end < 0) return value;
  const inner = value.slice(1, end);
  return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, "$1");
}

/** The trailing ` # …` of a plain scalar (YAML needs a space before the `#`). */
function plainComment(value: string): string {
  const m = /(.*?)([ \t]+(#.*))$/.exec(value);
  return m ? m[3] : "";
}

function plainValue(value: string): string {
  const m = /^(.*?)(?:[ \t]+#.*)?$/.exec(value);
  return (m ? m[1] : value).trim();
}

function readIn(doc: Doc, pointer: string, type: FieldType): string | null {
  const target = locate(doc, pointer);
  if (target === null) return null;
  const { at, keyCol, rest } = target;
  if (type === "list") return readList(doc.lines, at, keyCol, rest);
  if (splitIndicator(rest)) return blockBody(doc.lines, at, keyCol);
  // No inline value: the key carries a nested mapping or sequence, which is
  // structure this form does not read as text.
  if (rest === "") return null;
  // A flow value is one scalar on the reader's view; rewriting a key inside it
  // would mean rewriting the whole thing, so it is not editable here.
  if (rest.startsWith("{") || rest.startsWith("[")) return null;
  const quote = rest[0];
  if (quote === "'" || quote === '"') return quoteEnd(rest, quote) < 0 ? null : unquote(rest);
  return plainValue(rest);
}

function writeIn(doc: Doc, pointer: string, value: string, type: FieldType): WriteResult {
  const target = locate(doc, pointer);
  if (target === null) return { text: doc.text, missing: true };
  const { at, keyCol, indent, dash, key, rest } = target;
  if (type === "list") return writeList(doc, target, value);
  const wasBlock = splitIndicator(rest);
  if (wasBlock === null && (rest === "" || rest.startsWith("{") || rest.startsWith("["))) {
    // Absent-looking or structural: the form's answer is "add it in the YAML".
    return { text: doc.text, missing: true };
  }
  const asBlock = type !== "number" && (value.includes("\n") || wasBlock !== null);
  const sep = target.sep.endsWith(" ") ? target.sep : ": ";
  const head = `${indent}${dash ?? ""}${key}${sep}`;
  // Only a comment that sat *after* a plain or block-indicator value survives;
  // one that was inside a quoted scalar belonged to the replaced text.
  const comment =
    wasBlock !== null
      ? (splitIndicator(rest)?.comment ?? "")
      : rest.startsWith("'") || rest.startsWith('"')
        ? ""
        : plainComment(rest);
  const tail = comment ? ` ${comment}` : "";
  const body = blockEnd(doc.lines, at, keyCol);

  const replacement: string[] = asBlock
    ? [
        `${head}|${tail}`,
        ...value
          .replace(/\n+$/, "")
          .split("\n")
          .map((line) => (line === "" ? "" : `${" ".repeat(keyCol + 2)}${line}`)),
      ]
    : [`${head}${serialize(value, type)}${tail}`];

  const lines = [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(body + 1)];
  return { text: lines.join(doc.eol), missing: false };
}

function serialize(value: string, type: FieldType): string {
  if (type === "number" && /^-?\d+$/.test(value.trim())) return value.trim();
  // A boolean writes bare: `'true'` is a string where the schema wants a
  // boolean, and a value that is neither word is quoted so the server, not
  // this form, decides what it means.
  if (type === "bool" && /^(true|false)$/.test(value.trim())) return value.trim();
  // A number field holding non-numbers is quoted rather than guessed at: the
  // server's schema finding is the honest answer, a broken document is not.
  return `'${value.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------ flat arrays */

/**
 * A flat array of scalars as one comma-separated line, or null when the value
 * is not that: a flow mapping, an array whose items are objects, or a key with
 * something else under it.
 */
function readList(lines: string[], at: number, keyCol: number, rest: string): string | null {
  if (rest.startsWith("[")) {
    const items = parseFlowArray(rest);
    return items === null ? null : items.join(", ");
  }
  if (rest !== "" && !rest.startsWith("#")) return null;
  const block = parseBlockItems(lines, at, keyCol);
  return block === null ? null : block.items.join(", ");
}

/** Rewrite `pointer`'s array in the style it already has: flow stays flow, and
 * an emptied field writes `[]` (a key with nothing under it reads back as
 * absent, which would strand the form on its own edit). */
function writeList(doc: Doc, target: Target, value: string): WriteResult {
  const { at, keyCol, indent, dash, key, sep, rest } = target;
  const items = splitListInput(value);
  const flow = rest.startsWith("[");
  const block = flow ? null : parseBlockItems(doc.lines, at, keyCol);
  if (!flow && block === null) return { text: doc.text, missing: true };
  const comment = flow ? (/\]\s*(#.*)$/.exec(rest)?.[1] ?? "") : "";
  const head = `${indent}${dash ?? ""}${key}`;
  const body = block === null ? at : block.end;
  const written = items.map(scalar).join(", ");
  const replacement =
    flow || items.length === 0
      ? [`${head}: [${written}]${comment ? ` ${comment}` : ""}`]
      : [
          `${head}${sep.trimEnd()}`,
          ...items.map((item) => `${" ".repeat(keyCol + 2)}- ${scalar(item)}`),
        ];
  const lines = [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(body + 1)];
  return { text: lines.join(doc.eol), missing: false };
}

/** A list item: quoted like a string scalar, because YAML says `a: b` in a
 * sequence is a one-key mapping, not the text `a: b`. */
function scalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The form's comma-separated input → items. Empty edits an empty array. */
function splitListInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** `['a', b]` → `["a", "b"]`; null when any item is a mapping or nested flow. */
function parseFlowArray(rest: string): string[] | null {
  if (!/^\[[\s\S]*\]\s*(#.*)?$/.test(rest)) return null;
  const inner = rest
    .slice(1, rest.indexOf("]") + 1)
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  const parts = splitTopLevel(inner);
  if (parts === null) return null;
  if (parts.length === 1 && parts[0].trim() === "") return [];
  const items: string[] = [];
  for (const part of parts) {
    const item = plainItem(part.trim());
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** `- a` / `- 'a'` lines under the key at `at`; null when they are not a flat
 * scalar sequence (an object item, or a deeper continuation line). */
function parseBlockItems(
  lines: string[],
  at: number,
  keyCol: number,
): { items: string[]; end: number } | null {
  const items: string[] = [];
  let end = at;
  let itemCol: number | null = null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    // The server's canonical serializer puts a block sequence at its key's own
    // indent (`cases:` then `- when: …`), so only a shallower line ends it.
    if (indent < keyCol) break;
    if (!line.trim().startsWith("-")) break;
    if (itemCol === null) itemCol = indent;
    else if (indent !== itemCol) break;
    const after = line.trim().slice(1);
    const item = plainItem(after.trim());
    if (item === null) return null;
    items.push(item);
    end = i;
  }
  return itemCol === null ? null : { items, end };
}

/** One sequence/flow item read as text: a quoted or plain scalar only. */
function plainItem(item: string): string | null {
  if (item === "") return null;
  const quote = item[0];
  if (quote === "'" || quote === '"') return quoteEnd(item, quote) < 0 ? null : unquote(item);
  if (item.startsWith("[") || item.startsWith("{")) return null;
  // `a: b` is a mapping item, and a `#` opens a comment, not text.
  if (/:(\s|$)/.test(item) || item.startsWith("#")) return null;
  return item;
}

/** Split flow contents on top-level commas; null when a bracket never closes. */
function splitTopLevel(inner: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const ch of inner) {
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) return null;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (depth !== 0 || quote !== "") return null;
  parts.push(current);
  return parts;
}

interface Target {
  /** Index into `doc.lines`. */
  at: number;
  /** Column the key itself starts at — the block body must sit deeper. */
  keyCol: number;
  indent: string;
  dash: string | undefined;
  key: string;
  sep: string;
  rest: string;
}

function locate(doc: Doc, pointer: string): Target | null {
  const encoded = encodePointer(pointer);
  const loc = doc.pointers.get(encoded);
  // An inexact location is the reader admitting it only found an ancestor —
  // rewriting that line would rewrite the wrong key.
  if (!loc || !loc.exact) return null;
  const at = loc.line - 1;
  const raw = doc.lines[at];
  const wanted = encoded.split("/").pop();
  if (raw === undefined || wanted === undefined) return null;
  const m = KEY_LINE.exec(raw);
  if (!m) return null;
  const [, indent, dash, key, sep, rest] = m;
  if (keyName(key) !== wanted) return null;
  return { at, keyCol: indent.length + (dash?.length ?? 0), indent, dash, key, sep, rest };
}

/** Body text of the block scalar opened on line `at`, dedented, no trailing newline. */
function blockBody(lines: string[], at: number, keyCol: number): string {
  const end = blockEnd(lines, at, keyCol);
  const body = lines.slice(at + 1, end + 1);
  const indents = body.filter((line) => line.trim() !== "").map(indentOf);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return body.map((line) => (line.trim() === "" ? "" : line.slice(strip))).join("\n");
}

/** Last line that belongs to `at`'s block scalar; interior blanks count, a run
 * of blanks with no deeper line after them does not. */
function blockEnd(lines: string[], at: number, keyCol: number): number {
  let end = at;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= keyCol) break;
    end = i;
  }
  return end;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function encodePointer(pointer: string): string {
  return pointer
    .split("/")
    .map((token, index) => (index === 0 ? token : token.replace(/~/g, "~0").replace(/\//g, "~1")))
    .join("/");
}
