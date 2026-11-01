/**
 * `spec.inputs` as readable rows (design 1g, studio-inspector pass-1 review).
 *
 * The workflow inspector used to open on the document's own path: a textarea
 * holding the JSON Schema the runner validates against (`"type": "object"`,
 * `"required"`, `"minLength"`). A person authoring a workflow is not thinking
 * in schema keywords — they are thinking "every run of this gets a `goal`, and
 * it may not start without one", which is exactly what the workflow Overview
 * prints as `goal — What the plan should accomplish`.
 *
 * So: read the schema into rows (name, description, required), and write the
 * same rows back to the same schema. Nothing is invented and nothing is lost —
 * every keyword the rows do not edit (`type`, `minLength`, `format`, a
 * declared `default`) rides along on the row untouched and comes back out in
 * the document. When the declared shape is one these rows cannot honestly
 * carry (`$ref`, `oneOf`, a boolean sub-schema, a root keyword like
 * `patternProperties`), the read returns `null` and the caller keeps the JSON
 * box: a field is never silently hidden, and a form that would drop the author
 * — or the validation — is worse than the textarea it replaces.
 */
/** The row shape the editor holds; `schema` is the property's own declared
 * schema minus the `description` the row edits. */
export interface RunInputRow {
  name: string;
  description: string;
  required: boolean;
  schema: Record<string, unknown>;
}

export interface RunInputsModel {
  rows: RunInputRow[];
  /** The root keywords preserved verbatim (`additionalProperties`, `title`, a
   * root `description`). `type` is never in here — these rows always write
   * `type: object`, which is what the canonical schema's `jsonSchemaObject`
   * demands. */
  root: Record<string, unknown>;
}

/** Input names are the canonical schema's `identifier`: lower-case letter,
 * then letters/digits/underscore, at most 63 characters — every name has to be
 * a legal single CEL selector (`${{ inputs.goal }}`). */
export const RUN_INPUT_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Root keywords these rows carry through. Anything else means the shape is
 * not a plain input list and the JSON box stays. */
const ROOT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
]);

/** A property schema may carry any of these untouched; composition keywords
 * mean the row could not show what the input actually is. */
const UNSUPPORTED_PROPERTY_KEYS = [
  "$ref",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "$defs",
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

/**
 * Project `spec.inputs` into rows, in the document's declared order.
 * `undefined`/`null` (a workflow that declares nothing yet) is an empty list,
 * not a refusal; a shape the rows cannot write back is `null`.
 */
export function readRunInputs(inputs: unknown): RunInputsModel | null {
  if (inputs === undefined || inputs === null) return { rows: [], root: {} };
  if (!isObj(inputs)) return null;
  if (inputs.type !== undefined && inputs.type !== "object") return null;
  for (const key of Object.keys(inputs)) if (!ROOT_KEYS.has(key)) return null;

  const declared = inputs.properties;
  if (declared !== undefined && !isObj(declared)) return null;
  const required = inputs.required;
  if (required !== undefined && !isStringArray(required)) return null;
  const requiredNames = new Set(required ?? []);
  // A `required` name with no declared property is not a list of inputs the
  // rows could show and write back — the JSON box keeps that document.
  if (declared !== undefined)
    for (const name of requiredNames) if (!(name in declared)) return null;

  const rows: RunInputRow[] = [];
  for (const [name, entry] of Object.entries(declared ?? {})) {
    if (!isObj(entry)) return null;
    for (const keyword of UNSUPPORTED_PROPERTY_KEYS) if (keyword in entry) return null;
    const { description, ...schema } = entry as Record<string, unknown> & {
      description?: unknown;
    };
    rows.push({
      name,
      description: typeof description === "string" ? description : "",
      required: requiredNames.has(name),
      schema,
    });
  }

  const root: Record<string, unknown> = {};
  for (const key of ["title", "description", "additionalProperties"]) {
    if (inputs[key] !== undefined) root[key] = inputs[key];
  }
  return { rows, root };
}

/** Write the rows back as the `jsonSchemaObject` the canonical schema wants:
 * `type`, the preserved root keywords, `required` (only while an input is
 * required) and `properties` in row order. */
export function writeRunInputs(model: RunInputsModel): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object", ...model.root };
  const named = model.rows.filter((row) => row.name.trim() !== "");
  const required = named.filter((row) => row.required).map((row) => row.name.trim());
  if (required.length > 0) out.required = required;
  const properties: Record<string, unknown> = {};
  for (const row of named) {
    // A row with nothing declared is a new input: `Add input` starts every one
    // as a string. A row that declares something else (`type: boolean`, a
    // `minLength`, a `format`) rides back out exactly as it came in — these
    // rows edit a name and its words, never the type.
    const entry: Record<string, unknown> =
      Object.keys(row.schema).length === 0 ? { type: "string" } : { ...row.schema };
    if (row.description.trim() !== "") entry.description = row.description;
    else delete entry.description;
    properties[row.name.trim()] = entry;
  }
  out.properties = properties;
  return out;
}

/** Why this row's name cannot be written, in the words the author needs;
 * `null` when the name is fine (including a blank new row, which is simply not
 * written to the document yet). */
export function runInputNameProblem(
  name: string,
  rows: readonly RunInputRow[],
  index: number,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  if (!RUN_INPUT_NAME.test(trimmed))
    return "a name is a lower-case letter, then letters, digits or _ (e.g. goal)";
  if (rows.some((row, i) => i !== index && row.name.trim() === trimmed))
    return "two inputs cannot share a name";
  return null;
}
