/**
 * The add/edit trigger dialog (design 2c) — opened from a workflow row on the
 * repository page, so the project, the repository and the assignment are
 * already set: the dialog only asks WHEN (a GitHub issue, or a schedule) and
 * with what (labels / cron + fixed run inputs). There are deliberately no
 * project or repository selects.
 *
 * Chrome is the New workflow dialog's (1c): 520px, ink border, `2px 2px 0`
 * ink shadow (`--shadow-raised`), radius 4. `START IT WHEN` is a hug-content
 * segmented control whose selected segment is `bg-ink text-surface` at 600
 * over the unselected 400 label; the run-input mapping is echoed back in the
 * `THE RUN GETS` box (`bg-paper`), where the fixed repository is named
 * unquoted.
 *
 * Icons are Lucide at 14px / stroke 2 / `currentColor` (`Clock`, `Play`).
 * lucide-react 1.x dropped the brand glyphs, so the GitHub issue mark is the
 * official lucide `github` path rebuilt with `createLucideIcon` — the same
 * bytes the artboard's `lucide-static/icons/github.svg` carries. The `#` /
 * `◷` text glyphs are never used for trigger types.
 *
 * The server stays the authority for the cron grammar, the label set and the
 * fixed inputs: a `422 invalid_cron`, a `422 not_a_github_repository` /
 * `repository_mismatch` or a stale-version `409` renders inline and the
 * dialog stays open — never dressed up as a saved state. The footnote says
 * only "Checked every minute": ADR-0061 adds per-repository GitHub
 * credentials, so nothing here claims public-repositories-only.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"`
 * + `aria-modal`, labelled by its own title, focus trapped while open, Escape
 * closes, focus returns to the opener.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Clock, createLucideIcon } from "lucide-react";
import { Button } from "../ds/Button";
import { Field, Input, Select } from "../ds/Field";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import {
  defaultValuesOf,
  inputProblemsOf,
  runInputFieldsOf,
  wireInputsOf,
  InputFieldControl,
  type InputValue,
  type RunInputField,
} from "../m4/NewRunForm";
import { useCreateSchedule, usePatchSchedule, useRevision } from "../../api/pipelines";
import type { Schedule } from "../../api/pipelines";
import { useCreateIssueTrigger, usePatchIssueTrigger } from "../../api/useIssueTriggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import { cronInWords } from "../../lib/cronText";
import type { Assignment, Repository } from "../../api/types";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The any-of label ceiling the server enforces (`invalid_labels`); the
 * dialog refuses beyond it before a request leaves. */
const MAX_ISSUE_TRIGGER_LABELS = 20;

/** lucide's `github` glyph (lucide-static `icons/github.svg`): lucide-react
 * 1.x removed the brand icons from the package, so the mark is rebuilt from
 * the library's own path data and rendered by the same Lucide machinery. */
export const GithubIcon = createLucideIcon("Github", [
  [
    "path",
    {
      d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
    },
  ],
  ["path", { d: "M9 18c-4.51 2-5-2-7-2" }],
]);

/** The fire-time placeholders the ADR-0056 poller fills, in words — the
 * `THE RUN GETS` box reads the mapping, not the token soup. */
const ISSUE_TOKENS: [token: string, words: string][] = [
  ["{{issue.number}}", "the issue number"],
  ["{{issue.title}}", "the issue title"],
  ["{{issue.body}}", "the issue body"],
  ["{{issue.url}}", "the issue URL"],
  ["{{issue.labels}}", "the issue labels"],
];

/** The value in words when it is made of issue placeholders only
 * (`{{issue.title}}\n\n{{issue.body}}` → "the issue title and the issue
 * body"); null when the value carries prose, so the caller shows the text. */
export function issueValueInWords(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const used = ISSUE_TOKENS.filter(([token]) => trimmed.includes(token));
  if (used.length === 0) return null;
  let rest = trimmed;
  for (const [token] of used) rest = rest.split(token).join("");
  if (rest.trim() !== "") return null;
  const ordered = [...new Set(used.map(([, words]) => words))];
  return ordered.join(" and ");
}

/** The one placeholder a numeric input may carry: ADR-0056's amendment of
 * 2026-10-25 renders a value that is EXACTLY this token as a JSON number, so an
 * integer `issue_number` can be bound to the fired issue. Every other token
 * renders a string, and mixed text (`"#{{issue.number}}"`) does too — which is
 * why this is offered for numeric fields and not accepted for them elsewhere. */
const ISSUE_NUMBER_TOKEN = "{{issue.number}}";

/** The line under a numeric input that is bound to the fired issue: the control
 * itself cannot show a template (it is a number field), so the binding the
 * server will honour is spelled out where the author is looking. Nothing for a
 * fixed number, an empty field, or anything the integer input would refuse. */
export function numericIssueBinding(value: InputValue | undefined): string | null {
  if (typeof value !== "string") return null;
  // The server's rule is anchored (ADR-0056 amendment of 2026-10-25): the WHOLE
  // value is the token or it renders a string the input refuses, so `#{{…}}`
  // and `{{issue.title}}` are not bindings a numeric field has.
  if (value !== ISSUE_NUMBER_TOKEN) return null;
  return "the run gets the issue number — type a number to fix it instead";
}

/** The binding line rendered under a numeric input in issue mode (empty for a
 * fixed number, so the author is never told a `0` default is a binding). */
function NumericIssueBindingLine({ name, value }: { name: string; value: InputValue | undefined }) {
  const binding = numericIssueBinding(value);
  if (binding === null) return null;
  return (
    <span
      className="font-mono text-[10.5px] text-faint"
      data-testid={`trigger-dialog-numeric-binding-${name}`}
    >
      {binding}
    </span>
  );
}

/** One `THE RUN GETS` line: how the value the trigger carries reads to a
 * person. Honest to what is stored — a template made only of placeholders is
 * named in words, anything else is shown quoted and trimmed. */
export function runGetsValue(field: RunInputField, value: InputValue | undefined): string {
  if (field.kind === "boolean") return value === true ? "yes" : "no";
  if (typeof value === "number") return String(value);
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "—";
  // A repository input is not a choice this dialog offers — the trigger was
  // opened from that repository — so the box names it plainly, unquoted.
  if (field.kind === "repository") return text.replace(/\s+/g, " ");
  const words = issueValueInWords(text);
  if (words !== null) return words;
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 48 ? `“${flat.slice(0, 48)}…”` : `“${flat}”`;
}

export type TriggerEditing =
  | { kind: "schedule"; schedule: Schedule }
  | { kind: "issue"; trigger: IssueTrigger };

export interface TriggerDialogProps {
  open: boolean;
  onClose: () => void;
  /** The library workflow the trigger belongs to (its display name or slug). */
  workflowLabel: string;
  project: { id: string; name: string };
  /** The repository the dialog was opened from — the watched repo, fixed. */
  repository: Repository;
  /** The assignment (this repo's or the whole project's) the trigger joins. */
  assignment: Assignment;
  /** The trigger being edited; null opens the dialog in add mode. */
  editing?: TriggerEditing | null;
}

export function TriggerDialog({
  open,
  onClose,
  workflowLabel,
  project,
  repository,
  assignment,
  editing = null,
}: TriggerDialogProps) {
  if (!open) return null;
  return (
    <TriggerDialogBody
      onClose={onClose}
      workflowLabel={workflowLabel}
      project={project}
      repository={repository}
      assignment={assignment}
      editing={editing}
    />
  );
}

interface BodyProps {
  onClose: () => void;
  workflowLabel: string;
  project: { id: string; name: string };
  repository: Repository;
  assignment: Assignment;
  editing: TriggerEditing | null;
}

function TriggerDialogBody({
  onClose,
  workflowLabel,
  project,
  repository,
  assignment,
  editing,
}: BodyProps) {
  const [mode, setMode] = useState<"issue" | "schedule">(editing?.kind ?? "issue");
  const [event, setEvent] = useState<IssueTrigger["event"]>(
    editing?.kind === "issue" ? editing.trigger.event : "opened",
  );
  const [labels, setLabels] = useState<string[]>(
    editing?.kind === "issue" ? editing.trigger.labels : [],
  );
  const [labelDraft, setLabelDraft] = useState("");
  const [cron, setCron] = useState(
    editing?.kind === "schedule" ? editing.schedule.cron_expr : "0 9 * * *",
  );
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const [showProblems, setShowProblems] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const createSchedule = useCreateSchedule(project.id);
  const patchSchedule = usePatchSchedule(project.id);
  const createIssue = useCreateIssueTrigger(project.id);
  const patchIssue = usePatchIssueTrigger(project.id);
  const revision = useRevision(assignment.pinned_revision_id);
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  // A `repository`-typed input is NOT a control here: opened from a repository
  // page, the repository is fixed. It still rides along in `inputs` (seeded
  // below) and the `THE RUN GETS` box names it; everything else the revision
  // declares stays editable.
  const editableFields = useMemo(
    () => (fields ? fields.filter((field) => field.kind !== "repository") : null),
    [fields],
  );

  // Seed once per dialog subject: declared defaults, this repository for a
  // `repository`-typed input (the dialog is opened from that repo), then what
  // the edited trigger already carries.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const key = editing
      ? `${editing.kind}:${editing.kind === "schedule" ? editing.schedule.id : editing.trigger.id}`
      : "__new__";
    if (seeded.current === key) return;
    if (!fields) return;
    seeded.current = key;
    const next: Record<string, InputValue> = { ...defaultValuesOf(fields) };
    for (const field of fields) {
      if (field.kind === "repository" && typeof next[field.name] !== "string") {
        next[field.name] = repository.name;
      }
    }
    if (editing) {
      const stored = editing.kind === "schedule" ? editing.schedule.inputs : editing.trigger.inputs;
      for (const [name, value] of Object.entries(stored ?? {})) {
        next[name] = value as InputValue;
      }
    }
    setValues(next);
  }, [fields, editing, repository.name]);

  const problems = fields ? inputProblemsOf(fields, values) : {};
  const busy =
    createSchedule.isPending ||
    patchSchedule.isPending ||
    createIssue.isPending ||
    patchIssue.isPending;
  const blocked = busy || revision.isPending || !revision.data || Object.keys(problems).length > 0;

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function addLabel() {
    const next = labelDraft.trim();
    if (next === "") return;
    if (labels.length >= MAX_ISSUE_TRIGGER_LABELS) return;
    if (!labels.includes(next)) setLabels((current) => [...current, next]);
    setLabelDraft("");
  }

  function submit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setShowProblems(true);
    if (blocked) return;
    const inputs = fields ? wireInputsOf(fields, values) : {};
    if (mode === "issue") {
      if (editing?.kind === "issue") {
        patchIssue.mutate(
          {
            issueTriggerId: editing.trigger.id,
            body: {
              version: editing.trigger.version,
              event,
              labels,
              inputs,
              enabled: editing.trigger.enabled,
            },
          },
          { onSuccess: () => onClose() },
        );
        return;
      }
      createIssue.mutate(
        {
          assignment_id: assignment.id,
          repository_id: repository.id,
          event,
          labels,
          inputs,
          enabled: true,
        },
        { onSuccess: () => onClose() },
      );
      return;
    }
    if (editing?.kind === "schedule") {
      patchSchedule.mutate(
        {
          scheduleId: editing.schedule.id,
          body: {
            version: editing.schedule.version,
            cron_expr: cron.trim(),
            inputs,
            enabled: editing.schedule.enabled,
          },
        },
        { onSuccess: () => onClose() },
      );
      return;
    }
    createSchedule.mutate(
      {
        assignment_id: assignment.id,
        cron_expr: cron.trim(),
        inputs,
        enabled: true,
      },
      { onSuccess: () => onClose() },
    );
  }

  const writeError =
    createSchedule.error ?? patchSchedule.error ?? createIssue.error ?? patchIssue.error;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trigger-dialog-title"
        className="w-[520px] max-w-full rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="trigger-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="trigger-dialog-title" className="text-[15px] font-semibold">
              {editing ? "Edit trigger" : "Add a trigger"}
            </h2>
            <span
              className="block truncate font-mono text-[10.5px] text-muted"
              data-testid="trigger-dialog-context"
            >
              {`${workflowLabel} · ${project.name} / ${repository.name}`}
            </span>
          </div>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
        </div>
        <form
          className="flex max-h-[calc(100vh-8rem)] flex-col gap-[14px] overflow-y-auto px-4 py-4"
          onSubmit={submit}
          data-testid="trigger-dialog-form"
        >
          <div className="flex flex-col gap-[6px]">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              START IT WHEN
            </span>
            <div
              className="flex w-max overflow-hidden rounded-[3px] border border-line-strong"
              role="group"
              aria-label="start it when"
              data-testid="trigger-dialog-mode"
            >
              <button
                type="button"
                aria-pressed={mode === "issue"}
                onClick={() => setMode("issue")}
                className={`flex items-center gap-[6px] px-3 py-[5px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-ring ${
                  mode === "issue"
                    ? "bg-ink font-semibold text-surface"
                    : "bg-surface font-normal text-ink-2"
                }`}
                data-testid="trigger-dialog-mode-issue"
              >
                <GithubIcon size={14} strokeWidth={2} aria-hidden />
                A GitHub issue…
              </button>
              <button
                type="button"
                aria-pressed={mode === "schedule"}
                onClick={() => setMode("schedule")}
                className={`flex items-center gap-[6px] border-l border-line-strong px-3 py-[5px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-ring ${
                  mode === "schedule"
                    ? "bg-ink font-semibold text-surface"
                    : "bg-surface font-normal text-ink-2"
                }`}
                data-testid="trigger-dialog-mode-schedule"
              >
                <Clock size={14} strokeWidth={2} aria-hidden />
                On a schedule
              </button>
            </div>
          </div>

          {mode === "issue" ? (
            <>
              <Field id="trigger-dialog-event" label="IS">
                <Select
                  id="trigger-dialog-event"
                  value={event}
                  onChange={(changeEvent) =>
                    setEvent(changeEvent.target.value as IssueTrigger["event"])
                  }
                  className="font-ui"
                  data-testid="trigger-dialog-event"
                >
                  <option value="opened">opened</option>
                  <option value="labeled">labeled</option>
                </Select>
              </Field>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                  WITH ANY OF THESE LABELS
                </span>
                <div
                  className="flex min-h-[30px] flex-wrap items-center gap-[6px] rounded-[3px] border border-line-strong bg-surface px-2 py-[3px] focus-within:border-ink focus-within:shadow-[0_0_0_2px_var(--color-accent-ring)]"
                  data-testid="trigger-dialog-labels-row"
                >
                  {labels.map((label, index) => (
                    <span
                      key={`${label}-${index}`}
                      className="inline-flex items-center gap-[4px] rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[11px] text-ink-2"
                      data-testid={`trigger-dialog-label-chip-${index}`}
                    >
                      {label}
                      <button
                        type="button"
                        aria-label={`remove label ${label}`}
                        className="text-faint hover:text-ink"
                        onClick={() =>
                          setLabels((current) => current.filter((_, i) => i !== index))
                        }
                        data-testid={`trigger-dialog-label-remove-${index}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="trigger-dialog-labels"
                    value={labelDraft}
                    onChange={(changeEvent) => setLabelDraft(changeEvent.target.value)}
                    onKeyDown={(keyEvent) => {
                      if (keyEvent.key === "Enter" || keyEvent.key === ",") {
                        keyEvent.preventDefault();
                        addLabel();
                      }
                    }}
                    onBlur={addLabel}
                    placeholder="add label…"
                    aria-label="labels (any of)"
                    className="min-w-[120px] flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
                    data-testid="trigger-dialog-labels"
                  />
                </div>
                <p
                  className="font-mono text-[10.5px] text-faint"
                  data-testid="trigger-dialog-labels-hint"
                >
                  any-of: an issue fires when it carries one of these labels; empty means every
                  issue
                </p>
              </div>
            </>
          ) : (
            <Field
              id="trigger-dialog-cron"
              label="CRON (MINUTE HOUR DOM MONTH DOW, UTC)"
              hint="the server validates the cadence; seconds, names and `? L W # H` are refused"
            >
              <div className="flex flex-wrap items-center gap-[8px]">
                <Input
                  id="trigger-dialog-cron"
                  value={cron}
                  onChange={(changeEvent) => setCron(changeEvent.target.value)}
                  className="max-w-[180px] font-mono"
                  data-testid="trigger-dialog-cron"
                />
                <span
                  className="font-mono text-[11px] text-ink-2"
                  data-testid="trigger-dialog-cron-words"
                >
                  {cronInWords(cron)}
                </span>
              </div>
            </Field>
          )}

          {revision.isPending ? <Spinner label="Loading the pinned revision" /> : null}
          {revision.isError ? (
            <ProblemBanner
              error={revision.error}
              fallback="The pinned revision could not be read."
            />
          ) : null}

          {fields && fields.length > 0 ? (
            <div
              className="flex flex-col gap-1 rounded-[3px] border border-line bg-paper px-3 py-[10px]"
              data-testid="trigger-dialog-run-gets"
            >
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
                THE RUN GETS
              </span>
              {fields.map((field) => (
                <span
                  key={field.name}
                  className="text-[12.5px] text-ink"
                  data-testid={`trigger-dialog-run-gets-${field.name}`}
                >
                  <code className="font-mono text-[11.5px]">{field.name}</code> ={" "}
                  {runGetsValue(field, values[field.name])}
                </span>
              ))}
            </div>
          ) : null}

          {editableFields?.map((field) => (
            <div key={field.name} className="flex flex-col gap-1">
              <InputFieldControl
                field={field}
                value={values[field.name]}
                repositories={[repository.name]}
                repositoriesLoading={false}
                error={showProblems ? problems[field.name] : undefined}
                onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              />
              {mode === "issue" && (field.kind === "text" || field.kind === "textarea") ? (
                <button
                  type="button"
                  onClick={() =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: "{{issue.title}}\n\n{{issue.body}}",
                    }))
                  }
                  className="w-max font-mono text-[11px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`trigger-dialog-quickfill-${field.name}`}
                >
                  use issue title/body
                </button>
              ) : null}
              {/* An integer input (the shipped `issue-to-pr` template's
                  `issue_number`) is unfillable without this: the number control
                  cannot type a placeholder, and the fire fills the value the
                  row carries. */}
              {mode === "issue" && (field.kind === "integer" || field.kind === "number") ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: ISSUE_NUMBER_TOKEN,
                      }))
                    }
                    className="w-max font-mono text-[11px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid={`trigger-dialog-quickfill-${field.name}`}
                  >
                    use issue number
                  </button>
                  <NumericIssueBindingLine name={field.name} value={values[field.name]} />
                </>
              ) : null}
            </div>
          ))}

          {mode === "issue" ? (
            <span className="font-mono text-[10.5px] text-faint" data-testid="trigger-dialog-note">
              Checked every minute
            </span>
          ) : null}

          {writeError ? <FormError error={writeError} testid="trigger-dialog-error" /> : null}

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              data-testid="trigger-dialog-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={blocked}
              data-testid="trigger-dialog-submit"
            >
              {busy
                ? "Saving…"
                : editing
                  ? mode === "issue"
                    ? "Save trigger"
                    : "Save schedule"
                  : mode === "issue"
                    ? "Add trigger"
                    : "Add schedule"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
