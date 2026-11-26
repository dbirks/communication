/**
 * The add/edit schedule dialog behind the Triggers section's `Add schedule`
 * control (`data-testid="trigger-add-schedule"`) and per-row Edit action
 * (`data-testid="trigger-edit-<scheduleId>"`): pick the project assignment the
 * schedule belongs to, spell the cron (presets first, plain text after — the
 * server stays the authority), and carry the assignment's declared run inputs
 * through the same `NewRunForm` controls the run-create form uses, so "what a
 * run needs" has one rendering.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"` +
 * `aria-modal`, labelled by its own title, focus trapped on the first control
 * while open, Escape closes, focus returns to the opener when it closes.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useCreateSchedule, usePatchSchedule, useRevision } from "../../api/pipelines";
import { useRepositories } from "../../api/queries";
import { Field, Input, Select } from "../ds/Field";
import { Sheet } from "../ds/Sheet";
import { SoftButton } from "../ds/SoftButton";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import {
  defaultValuesOf,
  inputProblemsOf,
  runInputFieldsOf,
  wireInputsOf,
  InputFieldControl,
  type InputValue,
} from "../m4/NewRunForm";
import { routes } from "../../lib/routes";
import type { TriggerGroup } from "./Triggers";
import type { Schedule } from "../../api/pipelines";

/** The cadences the dialog offers before the custom cron field: hourly, daily
 * 09:00 UTC, weekdays 09:00 UTC, weekly Monday 09:00 UTC — the shapes ADR-0032
 * names and the plain-English helper already translates. */
const CRON_PRESETS: [string, string][] = [
  ["hourly", "0 * * * *"],
  ["daily 09:00 UTC", "0 9 * * *"],
  ["weekdays 09:00 UTC", "0 9 * * 1-5"],
  ["weekly Monday", "0 9 * * 1"],
];

export interface TriggersDialogProps {
  open: boolean;
  onClose: () => void;
  /** The workflow's assignments the caller may create schedules on — the
   * dialog picks among these, never among a wider set. */
  assignments: TriggerGroup[];
  /** The schedule being edited, when the dialog is in edit mode. */
  editing: { group: TriggerGroup; schedule: Schedule } | null;
}

export function TriggersDialog({ open, onClose, assignments, editing }: TriggersDialogProps) {
  if (!open) return null;
  return <TriggersDialogBody onClose={onClose} assignments={assignments} editing={editing} />;
}

function TriggersDialogBody({
  onClose,
  assignments,
  editing,
}: {
  onClose: () => void;
  assignments: TriggerGroup[];
  editing: { group: TriggerGroup; schedule: Schedule } | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(editing?.group.assignment.id ?? null);
  const selected =
    (selectedId !== null
      ? assignments.find((group) => group.assignment.id === selectedId)
      : undefined) ??
    assignments[0] ??
    null;
  const [cron, setCron] = useState(editing ? editing.schedule.cron_expr : CRON_PRESETS[0][1]);
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const [showProblems, setShowProblems] = useState(false);

  const create = useCreateSchedule(selected?.project.id ?? "");
  const patch = usePatchSchedule(selected?.project.id ?? "");
  const revision = useRevision(selected?.assignment.pinned_revision_id ?? "");
  const repositories = useRepositories(selected?.project.id ?? "");
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const key = editing?.schedule.id ?? "__new__";
    if (seeded.current === key) return;
    seeded.current = key;
    if (!fields) return;
    setValues((current) => {
      const base = Object.keys(current).length ? current : defaultValuesOf(fields);
      const next = { ...base };
      if (editing) {
        Object.entries(editing.schedule.inputs ?? {}).forEach(([name, value]) => {
          next[name] = value as InputValue;
        });
      }
      return next;
    });
  }, [fields, editing]);
  const problems = fields ? inputProblemsOf(fields, values) : {};
  const busy = create.isPending || patch.isPending;
  const blocked = Object.keys(problems).length > 0 || busy || !selected || !revision.data;

  function submit(event: FormEvent) {
    event.preventDefault();
    setShowProblems(true);
    if (!selected) return;
    const inputs = fields ? wireInputsOf(fields, values) : {};
    if (editing) {
      patch.mutate(
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
    create.mutate(
      {
        assignment_id: selected.assignment.id,
        cron_expr: cron.trim(),
        inputs,
        enabled: true,
      },
      { onSuccess: () => onClose() },
    );
  }

  const assignable = assignments.filter((group) => group.canManage);

  if (assignable.length === 0) {
    return (
      <Sheet
        onClose={onClose}
        closeOnBackdrop={false}
        labelledBy="trigger-add-schedule-title"
        testid="trigger-add-schedule-dialog"
        widthClassName="w-[480px]"
        panelClassName="p-0"
      >
        <h2
          id="trigger-add-schedule-title"
          className="border-b border-line px-[20px] py-[14px] text-[15px] font-bold max-md:px-[16px]"
        >
          Add a schedule
        </h2>
        <div className="px-[20px] py-[16px] max-md:px-[16px]" data-testid="trigger-add-empty">
          <p className="text-[12.5px] text-muted" data-testid="trigger-add-empty-text">
            Assign this workflow to a project first — a schedule belongs to a project assignment,
            and none of the projects you maintain has this workflow assigned.
          </p>
          <Link
            to={routes.projects()}
            className="font-mono text-[11.5px] text-accent-text"
            data-testid="trigger-add-empty-link"
          >
            your projects
          </Link>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      onClose={onClose}
      closeOnBackdrop={false}
      labelledBy="trigger-add-schedule-title"
      testid="trigger-add-schedule-dialog"
      widthClassName="w-[560px]"
      panelClassName="p-0"
    >
      <h2
        id="trigger-add-schedule-title"
        className="border-b border-line px-[20px] py-[14px] text-[15px] font-bold max-md:px-[16px]"
      >
        {editing ? "Edit schedule" : "Add a schedule"}
      </h2>
      <form
        className="space-y-[10px] px-[20px] py-[16px] max-md:px-[16px]"
        onSubmit={submit}
        data-testid="trigger-add-schedule-form"
      >
        {assignments.length > 1 ? (
          <Field id="trigger-add-assignment" label="project assignment" className="max-w-[20rem]">
            <Select
              id="trigger-add-assignment"
              value={selected?.assignment.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="font-ui"
              data-testid="trigger-add-assignment"
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
          id="trigger-add-cron"
          label="cron (minute hour dom month dow, UTC)"
          hint={
            <span data-testid="trigger-add-cron-hint">
              the server validates the cadence; seconds, names and ? L W # H are refused
            </span>
          }
        >
          <Input
            id="trigger-add-cron"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            data-testid="trigger-add-cron"
          />
        </Field>
        <div
          className="flex flex-wrap items-center gap-[6px]"
          role="group"
          aria-label="cron presets"
        >
          {CRON_PRESETS.map(([label, expr]) => (
            <SoftButton
              key={expr}
              compact
              variant={cron === expr ? "primary" : "ghost"}
              data-testid={`trigger-preset-${expr.replace(/\*/g, "star").replace(/\s/g, "-")}`}
              onClick={() => setCron(expr)}
            >
              {label}
            </SoftButton>
          ))}
          <SoftButton
            compact
            variant="ghost"
            data-testid="trigger-preset-custom"
            onClick={() => setCron("")}
          >
            custom
          </SoftButton>
        </div>
        {revision.isPending ? <Spinner label="Loading the pinned revision" /> : null}
        {revision.isError ? (
          <ProblemBanner error={revision.error} fallback="The pinned revision could not be read." />
        ) : null}
        {fields?.map((field) => (
          <InputFieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            repositories={(repositories.data?.items ?? []).map((repo) => repo.name)}
            repositoriesLoading={repositories.isPending}
            error={showProblems ? problems[field.name] : undefined}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        <div className="flex items-center gap-[6px]">
          <SoftButton
            type="submit"
            variant="primary"
            compact
            disabled={blocked}
            data-testid="trigger-add-confirm"
          >
            {editing ? "Save" : "Add"}
          </SoftButton>
          <SoftButton compact variant="ghost" data-testid="trigger-add-cancel" onClick={onClose}>
            Cancel
          </SoftButton>
        </div>
        {create.isError || patch.isError ? (
          <FormError
            error={create.isError ? create.error : patch.error}
            testid="trigger-add-error"
          />
        ) : null}
      </form>
    </Sheet>
  );
}
