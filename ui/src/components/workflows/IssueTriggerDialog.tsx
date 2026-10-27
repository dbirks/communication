/**
 * The add/edit issue-trigger dialog behind the Triggers section's
 * `Add issue trigger` control (`data-testid="trigger-add-issue"`) and the
 * per-row Edit action (`data-testid="trigger-issue-edit-<id>"`): pick the
 * project assignment the trigger belongs to, name the watched GitHub
 * repository, spell WHEN (an issue was opened / labelled) and optionally WHAT
 * (the any-of label set), and carry the assignment's declared run inputs
 * through the same `NewRunForm` controls the run-create form uses — so "what a
 * run needs" has one rendering.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"` +
 * `aria-modal`, labelled by its own title, focus trapped on the first control
 * while open, Escape closes, focus returns to the opener when it closes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useCreateIssueTrigger, usePatchIssueTrigger } from "../../api/useIssueTriggers";
import { useRevision } from "../../api/pipelines";
import { useRepositories } from "../../api/queries";
import { FormError, ProblemBanner } from "../Feedback";
import { Button } from "../ds/Button";
import { Field, Input, Select, Textarea } from "../ds/Field";
import {
  defaultValuesOf,
  inputProblemsOf,
  runInputFieldsOf,
  wireInputsOf,
  type InputValue,
  type RunInputField,
} from "../m4/NewRunForm";
import { repoRefOf } from "./IssueTriggerRow";
import type { TriggerGroup } from "./Triggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The any-of label ceiling the server enforces (`invalid_labels`); the dialog
 * refuses beyond it before a request leaves. */
const MAX_ISSUE_TRIGGER_LABELS = 20;

const ISSUE_EVENT_OPENED = "opened";
const ISSUE_EVENT_LABELED = "labeled";

export interface IssueTriggerDialogProps {
  open: boolean;
  onClose: () => void;
  /** The workflow's assignments the caller may create issue triggers on — the
   * dialog picks among these, never among a wider set. */
  assignments: TriggerGroup[];
  /** The issue trigger being edited, when the dialog is in edit mode. */
  editing: { group: TriggerGroup; trigger: IssueTrigger } | null;
}

export function IssueTriggerDialog({
  open,
  onClose,
  assignments,
  editing,
}: IssueTriggerDialogProps) {
  if (!open) return null;
  return <IssueTriggerDialogBody onClose={onClose} assignments={assignments} editing={editing} />;
}

function IssueTriggerDialogBody({
  onClose,
  assignments,
  editing,
}: {
  onClose: () => void;
  assignments: TriggerGroup[];
  editing: { group: TriggerGroup; trigger: IssueTrigger } | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(editing?.group.assignment.id ?? null);
  const selected =
    (selectedId !== null
      ? assignments.find((group) => group.assignment.id === selectedId)
      : undefined) ??
    assignments[0] ??
    null;
  const [event, setEvent] = useState<IssueTrigger["event"]>(
    editing?.trigger.event ?? ISSUE_EVENT_OPENED,
  );
  const [labels, setLabels] = useState<string[]>(editing?.trigger.labels ?? []);
  const [labelDraft, setLabelDraft] = useState("");
  const [repositoryId, setRepositoryId] = useState<string>(editing?.trigger.repository_id ?? "");
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const [showProblems, setShowProblems] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const create = useCreateIssueTrigger(selected?.project.id ?? "");
  const patch = usePatchIssueTrigger(selected?.project.id ?? "");
  const revision = useRevision(selected?.assignment.pinned_revision_id ?? "");
  const repositories = useRepositories(selected?.project.id ?? "");
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const key = editing?.trigger.id ?? "__new__";
    if (seeded.current === key) return;
    seeded.current = key;
    if (!fields) return;
    setValues((current) => {
      const base = Object.keys(current).length ? current : defaultValuesOf(fields);
      const next = { ...base };
      if (editing) {
        Object.entries(editing.trigger.inputs ?? {}).forEach(([name, value]) => {
          next[name] = typeof value === "string" ? value : String(value);
        });
      }
      return next;
    });
  }, [fields, editing]);

  const problems = fields ? inputProblemsOf(fields, values) : {};
  const busy = create.isPending || patch.isPending;
  const blocked = Object.keys(problems).length > 0 || busy || !selected || !revision.data;

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>("input, button, textarea");
    first?.focus();
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
    if (!selected) return;
    const inputs = fields ? wireInputsOf(fields, values) : {};
    if (editing) {
      patch.mutate(
        {
          issueTriggerId: editing.trigger.id,
          body: {
            version: editing.trigger.version,
            assignment_id: selected.assignment.id,
            repository_id: repositoryId,
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
    create.mutate(
      {
        assignment_id: selected.assignment.id,
        repository_id: repositoryId,
        event,
        labels,
        inputs,
        enabled: true,
      },
      { onSuccess: () => onClose() },
    );
  }

  const assignable = assignments.filter((group) => group.canManage);

  if (assignable.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="trigger-add-issue-title"
          className="w-[480px] max-w-full rounded-[4px] border border-line bg-surface shadow-(--shadow-raised)"
          data-testid="trigger-add-issue-dialog"
        >
          <h2
            id="trigger-add-issue-title"
            className="border-b border-line px-[14px] py-[10px] text-[13px] font-bold"
          >
            Add an issue trigger
          </h2>
          <div className="px-[14px] py-[12px]" data-testid="trigger-add-issue-empty">
            <p className="text-[12.5px] text-muted" data-testid="trigger-add-issue-empty-text">
              Assign this workflow to a project first — an issue trigger belongs to a project
              assignment, and none of the projects you maintain has this workflow assigned.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trigger-add-issue-title"
        className="w-[560px] max-w-full rounded-[4px] border border-line bg-surface shadow-(--shadow-raised)"
        data-testid="trigger-add-issue-dialog"
      >
        <h2
          id="trigger-add-issue-title"
          className="border-b border-line px-[14px] py-[10px] text-[13px] font-bold"
        >
          {editing ? "Edit issue trigger" : "Add an issue trigger"}
        </h2>
        <form
          className="space-y-[10px] px-[14px] py-[12px]"
          onSubmit={submit}
          data-testid="trigger-add-issue-form"
        >
          {assignments.length > 1 ? (
            <Field
              id="trigger-add-issue-assignment"
              label="project assignment"
              className="max-w-[20rem]"
            >
              <Select
                id="trigger-add-issue-assignment"
                value={selected?.assignment.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
                className="font-ui"
                data-testid="trigger-add-issue-assignment"
              >
                {assignments.map((group) => (
                  <option key={group.assignment.id} value={group.assignment.id}>
                    {group.project.name} —{" "}
                    {group.assignment.pinned_version_label ?? "pinned revision"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field
            id="trigger-add-issue-repository"
            label="repository"
            hint="the server refuses anything that is not a GitHub remote (`422 not_a_github_repository`)"
          >
            <Select
              id="trigger-add-issue-repository"
              value={repositoryId}
              onChange={(event) => {
                const next = event.target.value;
                setRepositoryId(next);
                const repository = (repositories.data?.items ?? []).find(
                  (candidate) => candidate.id === next,
                );
                const repositoryField = fields?.find((field) => field.name === "repository");
                if (repository && repositoryField && repositoryField.kind === "repository") {
                  setValues((current) => ({ ...current, repository: repository.name }));
                }
              }}
              className="font-ui"
              data-testid="trigger-add-issue-repository"
            >
              <option value="">— choose —</option>
              {(repositories.data?.items ?? []).map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repoRefOf(repository)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-[2px]" data-testid="trigger-add-issue-event">
            <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              event
            </span>
            <div className="flex flex-wrap items-center gap-[14px]">
              <label className="flex cursor-pointer items-center gap-[6px] font-mono text-[12px] text-ink">
                <input
                  type="radio"
                  name="issue-trigger-event"
                  value={ISSUE_EVENT_OPENED}
                  checked={event === ISSUE_EVENT_OPENED}
                  onChange={() => setEvent(ISSUE_EVENT_OPENED)}
                  data-testid="trigger-add-issue-event-opened"
                />
                <span>when an issue is opened</span>
              </label>
              <label className="flex cursor-pointer items-center gap-[6px] font-mono text-[12px] text-ink">
                <input
                  type="radio"
                  name="issue-trigger-event"
                  value={ISSUE_EVENT_LABELED}
                  checked={event === ISSUE_EVENT_LABELED}
                  onChange={() => setEvent(ISSUE_EVENT_LABELED)}
                  data-testid="trigger-add-issue-event-labeled"
                />
                <span>when an issue is labeled</span>
              </label>
            </div>
          </div>
          <div className="space-y-[2px]">
            <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              labels
            </span>
            <Input
              id="trigger-add-issue-labels"
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  addLabel();
                }
              }}
              placeholder="add a label…"
              aria-label="issue trigger labels"
              className="font-ui"
              data-testid="trigger-add-issue-labels"
            />
            {labels.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-[4px]"
                data-testid="trigger-add-issue-label-chips"
              >
                {labels.map((label, index) => (
                  <span
                    key={`${label}-${index}`}
                    className="inline-flex items-center gap-[4px] rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10.5px] text-ink-2"
                    data-testid={`trigger-add-issue-label-chip-${index}`}
                  >
                    {label}
                    <button
                      type="button"
                      aria-label={`remove label ${label}`}
                      className="text-faint hover:text-ink"
                      onClick={() => setLabels((current) => current.filter((_, i) => i !== index))}
                      data-testid={`trigger-add-issue-label-remove-${index}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <p
              className="font-mono text-[10.5px] text-faint"
              data-testid="trigger-add-issue-label-hint"
            >
              any-of: an issue fires when it carries one of these labels; empty means every issue
            </p>
          </div>
          {fields?.map((field) => (
            <IssueTriggerInputField
              key={field.name}
              field={field}
              value={values[field.name]}
              problems={showProblems ? problems[field.name] : undefined}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              onQuickFill={() =>
                setValues((current) => ({
                  ...current,
                  [field.name]: "{{issue.title}}\n\n{{issue.body}}",
                }))
              }
            />
          ))}
          <div className="flex items-center gap-[6px]">
            <Button
              type="submit"
              variant="primary"
              compact
              disabled={blocked}
              data-testid="trigger-add-issue-confirm"
            >
              {editing ? "Save" : "Add"}
            </Button>
            <Button
              compact
              variant="ghost"
              data-testid="trigger-add-issue-cancel"
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
          {create.isError || patch.isError ? (
            <FormError
              error={create.isError ? create.error : patch.error}
              testid="trigger-add-issue-error"
            />
          ) : null}
          {repositories.isError ? (
            <ProblemBanner
              error={repositories.error}
              fallback="The project's repositories could not be read."
              testid="trigger-add-issue-repositories-error"
            />
          ) : null}
        </form>
      </div>
    </div>
  );
}

interface IssueTriggerInputFieldProps {
  field: RunInputField;
  value: InputValue | undefined;
  problems?: string;
  onChange: (value: InputValue) => void;
  onQuickFill: () => void;
}

/** One declared run input — chosen by the schema, never by name — with the
 * template-token helper row for the text kinds (`{{issue.title}}` /
 * `{{issue.body}}` / …) the ADR's fire-time templating fills in. */
function IssueTriggerInputField({
  field,
  value,
  problems,
  onChange,
  onQuickFill,
}: IssueTriggerInputFieldProps) {
  const id = `trigger-add-issue-input-${field.name}`;
  const label = `${field.name}${field.required ? " *" : ""}`;

  if (field.kind === "unsupported") {
    return (
      <Field
        id={id}
        label={label}
        error={field.unsupportedReason ?? problems}
        className="opacity-80"
      >
        <p className="rounded-[3px] border border-line bg-fill px-[10px] py-1 font-mono text-[11.5px] text-muted">
          {field.unsupportedReason}
        </p>
      </Field>
    );
  }

  if (field.kind === "boolean") {
    return (
      // The input lives INSIDE the label: at phone width the 44px touch rule
      // (APP-SHELL-PHONE in styles/tokens.css) grows the label box, and the
      // association no longer needs htmlFor.
      <label className="flex items-center gap-2" data-testid={`${id}-row`}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          data-testid={id}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={field.description ? `${id}-hint` : undefined}
          className="size-3 accent-accent"
        />
        <span className="font-mono text-[12px] text-ink">{label}</span>
        {field.description ? (
          <span className="font-mono text-[10.5px] text-faint" data-testid={`${id}-hint`}>
            {field.description}
          </span>
        ) : null}
      </label>
    );
  }

  if (field.kind === "enum") {
    const choices = (field.enumValues ?? []).filter((choice) => choice !== "");
    return (
      <Field
        id={id}
        label={label}
        error={problems}
        hint={field.description}
        className="max-w-[20rem]"
      >
        <Select id={id} value="" onChange={() => undefined} data-testid={id}>
          <option value="">{choices.length === 0 ? "—" : "— choose —"}</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.kind === "repository") {
    return (
      <Field
        id={id}
        label={label}
        error={problems}
        hint={field.description}
        className="max-w-[20rem]"
      >
        <Select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={() => undefined}
          data-testid={id}
        >
          <option value="">the project has no repositories</option>
        </Select>
      </Field>
    );
  }

  if (field.kind === "integer" || field.kind === "number") {
    return (
      <Field
        id={id}
        label={label}
        error={problems}
        hint={field.description}
        className="max-w-[16rem]"
      >
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
          invalid={Boolean(problems)}
          data-testid={id}
        />
      </Field>
    );
  }

  const isText = field.kind === "text";
  const control = isText ? (
    <Input
      id={id}
      type="text"
      value={typeof value === "string" ? value : ""}
      minLength={field.minLength}
      onChange={(event) => onChange(event.target.value)}
      invalid={Boolean(problems)}
      data-testid={id}
    />
  ) : (
    <Textarea
      id={id}
      rows={3}
      value={typeof value === "string" ? value : ""}
      minLength={field.minLength}
      onChange={(event) => onChange(event.target.value)}
      invalid={Boolean(problems)}
      data-testid={id}
    />
  );
  return (
    <Field
      id={id}
      label={label}
      error={problems}
      hint={field.description}
      className="max-w-[32rem]"
    >
      <div className="space-y-[6px]">
        {control}
        {isText ? (
          <Button
            type="button"
            variant="ghost"
            compact
            onClick={onQuickFill}
            data-testid={`${id}-quickfill`}
          >
            use issue title/body
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
