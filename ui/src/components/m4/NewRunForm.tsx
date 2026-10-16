/**
 * The "New run" form (`docs/m4-contract.md` § 7.2 row W1): a run is started
 * against a project **assignment**, whose pinned revision carries
 * `spec.inputs` — a JSON Schema object (`13` decisions table row 7). The form
 * therefore *derives* its fields from that schema: one control per declared
 * input, using its declared `type`, `required`, `default`, `description`,
 * `enum`, `minLength` and numeric bounds. Nothing here is a hard-coded
 * goal/repository/criteria component — change the revision's `spec.inputs` and
 * the fields change with it.
 *
 * Two honesty rules this component keeps:
 * - an input the form cannot render honestly (an object/array schema) is
 *   named as unsupported rather than squeezed into a textarea;
 * - an optional input left empty is *omitted* from the body so the server
 *   records it as `origin: default` (`09`'s run_inputs) instead of the UI
 *   inventing a value.
 *
 * Submission carries one idempotency key per form instance (ADR-0023 § 12):
 * the key is minted once on mount, so a double click, a retry after a network
 * failure, or a `max_concurrent_runs` retry re-answers with the same run
 * rather than creating a second one.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAssignments, usePipelines, useRevision } from "../../api/pipelines";
import { useRepositories } from "../../api/queries";
import { useCreateRun } from "../../api/runs";
import { isNotGitHubRepository, useRepoIssues, type GitHubIssue } from "../../api/issues";
import { problemOf } from "../../api/client";
import type { Repository, RunCreate } from "../../api/types";
import { formatAge } from "../../lib/format";
import { Button } from "../ds/Button";
import { Field, Input, Select, Textarea } from "../ds/Field";
import { ProblemBanner, Spinner } from "../Feedback";

/** Value types a run input can carry on the wire. */
export type InputValue = string | number | boolean;

/** How a declared input is rendered. */
export type FieldKind =
  | "textarea" // string (multi-line prose: goal, acceptance criteria)
  | "text" // string with a single-line format hint
  | "repository" // string naming one of the project's repositories
  | "enum" // any schema with an `enum` of scalars
  | "boolean"
  | "integer"
  | "number"
  | "unsupported";

export interface RunInputField {
  name: string;
  /** The declared `type` (`string`, `boolean`, …) or `enum`/`repository`. */
  kind: FieldKind;
  required: boolean;
  description?: string;
  enumValues?: string[];
  defaultValue?: InputValue;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  /** Populated when `kind` is `unsupported` — never silently skipped. */
  unsupportedReason?: string;
}

interface InputSchemaNode {
  type?: unknown;
  /** Extension point an author may use to name the control explicitly. */
  repositoryHint?: unknown;
  enum?: unknown;
  default?: unknown;
  description?: unknown;
  format?: unknown;
  minLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

/** A repository input is one the document *declares* as such — by `format`,
 * an `x-repository` hint, or the input name the contract's own examples use
 * (`repository`, `target_repo`, `repos`). */
function looksLikeRepository(name: string, node: InputSchemaNode): boolean {
  const hints = [node.format, node.repositoryHint]
    .filter((value) => value !== undefined)
    .map((value) => String(value).toLowerCase());
  if (hints.some((value) => value.includes("repositor"))) return true;
  return /(^|[_-])repos?itor?y?(ies|s)?($|[_-])/.test(name.toLowerCase());
}

function enumStrings(node: InputSchemaNode): string[] | undefined {
  if (!Array.isArray(node.enum)) return undefined;
  const values = node.enum.filter(
    (value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  if (values.length === 0 || values.length !== node.enum.length) return undefined;
  return values.map(String);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function kindOf(name: string, node: InputSchemaNode): { kind: FieldKind; reason?: string } {
  if (enumStrings(node)) return { kind: "enum" };
  const type =
    typeof node.type === "string"
      ? node.type
      : Array.isArray(node.type)
        ? String(node.type.find((t) => t !== "null") ?? "")
        : "";
  if (type === "boolean") return { kind: "boolean" };
  if (type === "integer" || type === "number") return { kind: type };
  if (type === "string") {
    if (looksLikeRepository(name, node)) return { kind: "repository" };
    const format = typeof node.format === "string" ? node.format : "";
    if (format === "" || format === "text" || format === "textarea" || format === "multiline")
      return { kind: "textarea" };
    return { kind: "text" };
  }
  if (type === "") return { kind: "unsupported", reason: "the input declares no type" };
  return { kind: "unsupported", reason: `input type “${type}” has no form control here` };
}

function defaultOf(node: InputSchemaNode, kind: FieldKind): InputValue | undefined {
  if (node.default === undefined) return undefined;
  if (kind === "boolean") return typeof node.default === "boolean" ? node.default : undefined;
  if (kind === "integer" || kind === "number")
    return typeof node.default === "number" ? node.default : undefined;
  if (typeof node.default === "string") return node.default;
  return String(node.default);
}

/**
 * Project a revision's `canonical_document` into the form's fields, in the
 * document's declared order. Returns `null` while the shape is not the
 * `spec.inputs` object schema the schema demands.
 */
export function runInputFieldsOf(canonicalDocument: unknown): RunInputField[] | null {
  const spec = (canonicalDocument as { spec?: unknown } | null)?.spec;
  const inputs = (spec as { inputs?: unknown } | null)?.inputs;
  const node = inputs as
    | (InputSchemaNode & { properties?: Record<string, InputSchemaNode>; required?: unknown })
    | null;
  if (!node || typeof node !== "object" || !node.properties) return null;
  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((n): n is string => typeof n === "string")
      : [],
  );
  return Object.entries(node.properties).map(([name, entry]) => {
    const declared: InputSchemaNode = entry ?? {};
    const { kind, reason } = kindOf(name, declared);
    const field: RunInputField = {
      name,
      kind,
      required: required.has(name),
      description: typeof declared.description === "string" ? declared.description : undefined,
      enumValues: enumStrings(declared),
      defaultValue: defaultOf(declared, kind),
      minLength: numberOf(declared.minLength),
      minimum: numberOf(declared.minimum),
      maximum: numberOf(declared.maximum),
      unsupportedReason: reason,
    };
    return field;
  });
}

/** The stable, per-form-instance idempotency key (ADR-0023 § 12). */
function newRunKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `newrun-${c.randomUUID()}`;
  return `newrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Values for a fresh schema: declared defaults only, never guesses. */
export function defaultValuesOf(fields: readonly RunInputField[]): Record<string, InputValue> {
  const values: Record<string, InputValue> = {};
  for (const field of fields) {
    if (field.kind === "unsupported") continue;
    if (field.defaultValue !== undefined) values[field.name] = field.defaultValue;
    else if (field.kind === "boolean") values[field.name] = false;
  }
  return values;
}

function isEmpty(value: InputValue | undefined): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Client-side mirror of the declared constraints. The control plane stays the
 * authority (`422` with validate-style locations); this only refuses the
 * obvious cases before a request leaves.
 */
export function inputProblemsOf(
  fields: readonly RunInputField[],
  values: Record<string, InputValue>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (isEmpty(value)) {
      if (field.required) problems[field.name] = `${field.name} is required by spec.inputs`;
      continue;
    }
    if (typeof value === "string") {
      if (field.minLength !== undefined && value.length < field.minLength)
        problems[field.name] = `${field.name} must be at least ${field.minLength} characters`;
      continue;
    }
    if (typeof value === "number") {
      if (field.minimum !== undefined && value < field.minimum)
        problems[field.name] = `${field.name} must be at least ${field.minimum}`;
      if (field.maximum !== undefined && value > field.maximum)
        problems[field.name] = `${field.name} must be at most ${field.maximum}`;
    }
  }
  return problems;
}

/** The `inputs` body member: filled values only, so an untouched optional
 * input keeps its server-recorded `origin: default`. */
export function wireInputsOf(
  fields: readonly RunInputField[],
  values: Record<string, InputValue>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (isEmpty(value)) continue;
    inputs[field.name] = value;
  }
  return inputs;
}

/**
 * The values an issue writes into a revision's declared inputs — and nothing
 * else. Matching is by the name the revision declares, never by inventing a
 * field: `goal` (string) gets `#<number> <title>` plus the body, an integer
 * `issue_number`/`number` gets the number, a string `issue_url`/`url` gets
 * GitHub's link. An input the schema does not declare is never added, and an
 * input it does declare but that no rule covers keeps whatever the user typed.
 */
export function issueValuesFor(
  fields: readonly RunInputField[],
  issue: GitHubIssue,
): { values: Record<string, InputValue>; filled: string[] } {
  const heading = `#${issue.number} ${issue.title}`;
  const body = issue.body.trim();
  const text = body === "" ? heading : `${heading}\n\n${issue.body}`;
  const values: Record<string, InputValue> = {};
  const filled: string[] = [];
  for (const field of fields) {
    if (field.kind === "unsupported") continue;
    const name = field.name.toLowerCase();
    const isText = field.kind === "textarea" || field.kind === "text";
    const isInteger = field.kind === "integer" || field.kind === "number";
    if (isText && name === "goal") values[field.name] = text;
    else if (isInteger && (name === "issue_number" || name === "number"))
      values[field.name] = issue.number;
    else if (isText && (name === "issue_url" || name === "url"))
      values[field.name] = issue.html_url;
    else continue;
    filled.push(field.name);
  }
  return { values, filled };
}

export interface NewRunFormProps {
  projectId: string;
  /** Called with the created run id; the form then navigates to the run. */
  onCreated?: (runId: string) => void;
  onCancel?: () => void;
}

/** The run-input form for a project: fields come from the pinned revision. */
export function NewRunForm({ projectId, onCreated, onCancel }: NewRunFormProps) {
  const navigate = useNavigate();
  const assignments = useAssignments(projectId);
  const pipelines = usePipelines();
  const repositories = useRepositories(projectId);
  const createRun = useCreateRun(projectId);

  const [assignmentId, setAssignmentId] = useState("");
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const [showProblems, setShowProblems] = useState(false);
  const idempotencyKey = useRef<string>(newRunKey());
  // A second click before React can repaint the disabled button is still one
  // request: the ref closes the gap between `mutate` and `isPending`.
  const inFlight = useRef(false);

  const options = useMemo(() => {
    const slugs = new Map(
      (pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug]),
    );
    return (assignments.data?.assignments ?? [])
      .filter((assignment) => assignment.enabled)
      .map((assignment) => ({
        id: assignment.id,
        pipelineSlug: slugs.get(assignment.pipeline_id) ?? assignment.pipeline_id,
        versionLabel:
          assignment.pinned_version_label ?? assignment.pinned_revision_digest.slice(0, 19),
        pinnedRevisionId: assignment.pinned_revision_id,
        maxConcurrentRuns: assignment.max_concurrent_runs,
      }));
  }, [assignments.data, pipelines.data]);

  const active = options.find((option) => option.id === assignmentId) ?? options[0] ?? null;
  const revision = useRevision(active?.pinnedRevisionId ?? "");
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );

  // Seed the declared defaults once per revision so switching assignments does
  // not fight what the user typed.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!fields || !active || seeded.current === active.id) return;
    seeded.current = active.id;
    setValues(defaultValuesOf(fields));
    setShowProblems(false);
  }, [fields, active]);

  const repoNames = (repositories.data?.items ?? []).map((repo) => repo.name);
  const repos = repositories.data?.items ?? [];
  // The repository the issue picker reads is the one a `repository`-typed
  // input currently names — the form has no separate repo chooser.
  const repositoryField = fields?.find((field) => field.kind === "repository") ?? null;
  const repositoryValue = repositoryField ? values[repositoryField.name] : undefined;
  const chosenRepo =
    typeof repositoryValue === "string"
      ? (repos.find((repo) => repo.name === repositoryValue) ?? null)
      : null;
  const [issueFillNote, setIssueFillNote] = useState<string | null>(null);
  // A note about what was filled belongs to one repository choice.
  useEffect(() => setIssueFillNote(null), [repositoryValue]);
  const fillFromIssue = (issue: GitHubIssue) => {
    if (!fields) return;
    const patch = issueValuesFor(fields, issue);
    if (patch.filled.length === 0) {
      setIssueFillNote(
        `#${issue.number} filled nothing — this revision declares no matching input`,
      );
      return;
    }
    setValues((current) => ({ ...current, ...patch.values }));
    setIssueFillNote(`filled ${patch.filled.join(", ")} from #${issue.number}`);
  };
  const problems = fields ? inputProblemsOf(fields, values) : {};
  const declaresFields = fields !== null && fields.length > 0;
  const blocked =
    createRun.isPending ||
    active === null ||
    revision.isPending ||
    revision.isError ||
    !declaresFields ||
    Object.keys(problems).length > 0;

  const setValue = (name: string, value: InputValue) =>
    setValues((current) => ({ ...current, [name]: value }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!active || !fields || createRun.isPending || inFlight.current) return;
    setShowProblems(true);
    if (Object.keys(inputProblemsOf(fields, values)).length > 0) return;
    inFlight.current = true;
    const body: RunCreate = {
      assignment_id: active.id,
      inputs: wireInputsOf(fields, values),
      idempotency: idempotencyKey.current,
    };
    createRun.mutate(
      { body, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (run) => {
          onCreated?.(run.run_id);
          navigate(`/projects/${projectId}/runs/${run.run_id}`);
        },
        onError: () => {
          // The key is unchanged: the retry re-answers with the same run (or
          // the same 409), it never mints a second one.
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} aria-labelledby="new-run-heading" data-testid="new-run-form">
      <h2
        className="font-mono text-[10.5px] font-semibold tracking-[.04em] text-muted uppercase"
        id="new-run-heading"
      >
        New run
      </h2>

      {assignments.isPending ? <Spinner label="Loading assignments" /> : null}
      {assignments.isError ? (
        <ProblemBanner error={assignments.error} fallback="Assignments could not be loaded." />
      ) : null}
      {!assignments.isPending && !assignments.isError && options.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="new-run-no-assignments">
          This project has no enabled pipeline assignment, so there is no pinned revision to start a
          run from.
        </p>
      ) : null}

      {options.length > 0 ? (
        <Field id="new-run-assignment" label="Pipeline assignment">
          <Select
            id="new-run-assignment"
            value={active?.id ?? ""}
            onChange={(event) => setAssignmentId(event.target.value)}
            data-testid="new-run-assignment"
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.pipelineSlug} · {option.versionLabel} · max {option.maxConcurrentRuns}{" "}
                concurrent
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {revision.isPending ? <Spinner label="Loading pinned revision" /> : null}
      {revision.isError ? (
        <ProblemBanner error={revision.error} fallback="The pinned revision could not be read." />
      ) : null}
      {fields === null && revision.data ? (
        <p className="text-[12.5px] text-muted" data-testid="new-run-no-inputs">
          The pinned revision declares no <code>spec.inputs</code> object schema, so this form
          offers no fields.
        </p>
      ) : null}

      <div className="space-y-3">
        {fields?.map((field) => (
          <InputFieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            repositories={repoNames}
            repositoriesLoading={repositories.isPending}
            error={showProblems ? problems[field.name] : undefined}
            onChange={(value) => setValue(field.name, value)}
          />
        ))}
      </div>

      {chosenRepo ? (
        <GitHubIssueSection
          key={chosenRepo.id}
          projectId={projectId}
          repository={chosenRepo}
          onFill={fillFromIssue}
          fillNote={issueFillNote}
        />
      ) : null}

      {createRun.isError ? <RunCreateError error={createRun.error} /> : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={blocked}
          data-testid="new-run-submit"
          title={
            fields !== null && !declaresFields
              ? "The pinned revision declares no inputs — there is nothing to submit"
              : undefined
          }
        >
          {createRun.isPending ? "Starting run…" : "Start run"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} data-testid="new-run-cancel">
            Cancel
          </Button>
        ) : null}
        <span
          className="ml-auto font-mono text-[10.5px] text-faint"
          data-testid="new-run-idempotency-key"
        >
          idempotency {idempotencyKey.current.slice(0, 22)}
        </span>
      </div>
    </form>
  );
}

/** The API's problem verbatim, plus the `errors[]` locations a `422` carries. */
export function RunCreateError({ error }: { error: unknown }) {
  const problem = problemOf(error);
  const raw = (problem as { errors?: unknown }).errors;
  const findings = Array.isArray(raw)
    ? (raw as { instance_location?: unknown; code?: unknown; message?: unknown }[])
    : [];
  return (
    <div className="space-y-1" data-testid="new-run-error">
      <ProblemBanner
        error={error}
        fallback={`The control plane answered ${problem.status}.`}
        testid="new-run-error-problem"
      />
      {findings.length > 0 ? (
        <ul className="space-y-[2px] font-mono text-[11px] text-muted">
          {findings.map((finding, index) => (
            <li key={index} data-testid={`new-run-error-finding-${index}`}>
              {typeof finding.instance_location === "string" ? `${finding.instance_location} ` : ""}
              {typeof finding.code === "string" ? `[${finding.code}] ` : ""}
              {typeof finding.message === "string" ? finding.message : JSON.stringify(finding)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface InputFieldControlProps {
  field: RunInputField;
  value: InputValue | undefined;
  repositories: string[];
  repositoriesLoading: boolean;
  error?: string;
  onChange: (value: InputValue) => void;
}

/** One control per declared input, chosen by the schema, never by name. */
export function InputFieldControl({
  field,
  value,
  repositories,
  repositoriesLoading,
  error,
  onChange,
}: InputFieldControlProps) {
  const id = `new-run-input-${field.name}`;
  const label = `${field.name}${field.required ? " *" : ""}`;
  const hint = field.description ? (
    <p className="font-mono text-[10.5px] text-faint" data-testid={`${id}-hint`}>
      {field.description}
    </p>
  ) : undefined;

  if (field.kind === "unsupported") {
    return (
      <div data-testid={`${id}-unsupported`}>
        <Field
          id={id}
          label={label}
          error={field.unsupportedReason ?? error}
          className="opacity-80"
        >
          <p className="rounded-[3px] border border-line bg-fill px-[10px] py-1 font-mono text-[11.5px] text-muted">
            {field.unsupportedReason}
          </p>
        </Field>
      </div>
    );
  }

  if (field.kind === "boolean") {
    return (
      <div className="flex items-center gap-2" data-testid={`${id}-row`}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          data-testid={id}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={field.description ? `${id}-hint` : undefined}
          className="size-3 accent-accent"
        />
        <label htmlFor={id} className="font-mono text-[12px] text-ink">
          {label}
        </label>
        {field.description ? (
          <span className="font-mono text-[10.5px] text-faint" data-testid={`${id}-hint`}>
            {field.description}
          </span>
        ) : null}
      </div>
    );
  }

  if (field.kind === "enum" || field.kind === "repository") {
    const choices =
      field.kind === "repository"
        ? repositories
        : (field.enumValues ?? []).filter((choice) => choice !== "");
    const known = value !== undefined && choices.includes(String(value));
    return (
      <Field id={id} label={label} error={error} hint={hint}>
        <Select
          id={id}
          value={known ? String(value) : ""}
          onChange={(event) => onChange(event.target.value)}
          data-testid={id}
        >
          <option value="">
            {choices.length === 0
              ? field.kind === "repository" && !repositoriesLoading
                ? "the project has no repositories"
                : "—"
              : "— choose —"}
          </option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.kind === "integer" || field.kind === "number") {
    return (
      <Field id={id} label={label} error={error} hint={hint}>
        <Input
          id={id}
          type="number"
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          step={field.kind === "integer" ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === "" ? "" : Number(next));
          }}
          invalid={Boolean(error)}
          data-testid={id}
        />
      </Field>
    );
  }

  const single = field.kind === "text";
  const control = single ? (
    <Input
      id={id}
      type="text"
      value={typeof value === "string" ? value : ""}
      minLength={field.minLength}
      onChange={(event) => onChange(event.target.value)}
      invalid={Boolean(error)}
      data-testid={id}
    />
  ) : (
    <Textarea
      id={id}
      rows={3}
      value={typeof value === "string" ? value : ""}
      minLength={field.minLength}
      onChange={(event) => onChange(event.target.value)}
      invalid={Boolean(error)}
      data-testid={id}
    />
  );
  return (
    <Field id={id} label={label} error={error} hint={hint}>
      {control}
    </Field>
  );
}

interface GitHubIssueSectionProps {
  projectId: string;
  repository: Repository;
  onFill: (issue: GitHubIssue) => void;
  fillNote: string | null;
}

/**
 * "Start from a GitHub issue" (W3's UI half, ADR-0031). The list is fetched as
 * soon as a repository is chosen — that request is also how the form *learns*
 * the remote is not GitHub — and the rows stay collapsed until the reader asks.
 * A repository whose remote is not GitHub answers `422
 * not_a_github_repository`, and this section collapses into a muted line rather
 * than showing an empty tracker. Repeated label filters are the caller's click,
 * never a keystroke, because the anonymous GitHub budget is 60 req/h per IP.
 */
export function GitHubIssueSection({
  projectId,
  repository,
  onFill,
  fillNote,
}: GitHubIssueSectionProps) {
  const [open, setOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [label, setLabel] = useState("");
  const issues = useRepoIssues(projectId, repository.id, label);
  const notGitHub = isNotGitHubRepository(issues.error);

  if (notGitHub) {
    return (
      <p className="mt-3 font-mono text-[10.5px] text-faint" data-testid="issue-section-not-github">
        {repository.name} is not a GitHub remote, so there is no issue to start a run from.
      </p>
    );
  }

  return (
    <div className="mt-3" data-testid="issue-section">
      <button
        type="button"
        data-testid="issue-section-toggle"
        aria-expanded={open}
        aria-controls="issue-section-body"
        onClick={() => setOpen((previous) => !previous)}
        className="flex w-full items-center gap-[6px] font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted hover:text-ink"
      >
        <span aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span>
        Start from a GitHub issue
      </button>
      {open ? (
        <div id="issue-section-body" className="mt-1 space-y-1">
          <div className="flex items-center gap-2">
            <input
              id="issue-label-filter"
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              placeholder="filter by label"
              aria-label="Filter issues by label"
              className="w-40 rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[11.5px] text-ink placeholder:text-faint focus-visible:border-ink focus-visible:outline-none"
            />
            <Button type="button" variant="ghost" onClick={() => setLabel(labelDraft)}>
              Apply label
            </Button>
          </div>
          {issues.isPending ? <Spinner label="Reading GitHub" /> : null}
          {issues.isError ? (
            <ProblemBanner error={issues.error} fallback="GitHub could not be read." />
          ) : null}
          {issues.data && issues.data.items.length === 0 ? (
            <p className="font-mono text-[11px] text-muted" data-testid="issue-list-empty">
              GitHub answered {issues.data.repository} with no open issues
              {issues.data.label ? ` labelled ${issues.data.label}` : ""}.
            </p>
          ) : null}
          <ul className="space-y-1" data-testid="issue-list">
            {(issues.data?.items ?? []).map((issue) => (
              <IssueRow key={issue.number} issue={issue} onFill={() => onFill(issue)} />
            ))}
          </ul>
          {fillNote ? (
            <p className="font-mono text-[10.5px] text-accent-text" data-testid="issue-fill-note">
              {fillNote}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface IssueRowProps {
  issue: GitHubIssue;
  onFill: () => void;
}

/**
 * One tracker row, two lines: the number and the title share line 1 with the
 * button that writes the issue into the declared inputs, and the metadata —
 * labels, how stale, GitHub's own link, whether the body was clipped — sits on
 * line 2. The runs column is narrow, so a single row squeezed the title out
 * entirely; the title gets the flexible width here and ellipsizes instead of
 * vanishing (the full text stays in the `title` attribute).
 */
function IssueRow({ issue, onFill }: IssueRowProps) {
  return (
    <li
      className="space-y-[2px] rounded-[3px] border border-line bg-paper px-[8px] py-[4px]"
      data-testid={`issue-row-${issue.number}`}
    >
      <div className="flex items-center gap-[6px]">
        <span className="shrink-0 font-mono text-[11px] text-ink-2">#{issue.number}</span>
        <span
          className="min-w-0 flex-1 truncate text-[12px] leading-[17px] text-ink"
          title={issue.title}
          data-testid={`issue-title-${issue.number}`}
        >
          {issue.title}
        </span>
        <Button
          type="button"
          variant="ghost"
          compact
          className="ml-auto shrink-0"
          onClick={onFill}
          data-testid={`issue-use-${issue.number}`}
        >
          Use this issue
        </Button>
      </div>
      <div className="flex items-center gap-[6px] font-mono text-[10px] text-muted">
        {issue.labels.length > 0 ? (
          <>
            <span data-testid={`issue-labels-${issue.number}`}>{issue.labels.join(", ")}</span>
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          </>
        ) : null}
        <span data-testid={`issue-age-${issue.number}`} className="text-faint">
          {formatAge(issue.updated_at)} ago
        </span>
        {issue.body_truncated ? (
          <>
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            <span className="text-faint" title="GitHub's body was clipped to 4000 bytes">
              body clipped
            </span>
          </>
        ) : null}
        <span aria-hidden="true" className="text-faint">
          ·
        </span>
        <a
          href={issue.html_url}
          target="_blank"
          rel="noreferrer"
          className="text-accent-text hover:text-ink"
          data-testid={`issue-link-${issue.number}`}
        >
          on GitHub
        </a>
      </div>
    </li>
  );
}
