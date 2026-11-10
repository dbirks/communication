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
 * Icons are Tabler at 14px / stroke 2 / `currentColor` (`IconClock`,
 * `IconPlayerPlay`). The GitHub issue mark is Tabler's own brand glyph
 * (`IconBrandGithub`), exported here as `GithubIcon` so every trigger surface
 * draws the one mark. The `#` / `◷` text glyphs are never used for trigger
 * types.
 *
 * A write that came back refusing is said in the app's ONE failure treatment
 * (2026-11-01 review, pass-1 shot 2c-server-error): the plain sentence
 * `Couldn't save the trigger. Nothing was changed.`, the server's own problem
 * document kept below it as the muted `server said:` line, and the primary verb
 * left ENABLED — the author presses `Add trigger` again rather than hunting for
 * a way back in. Where the verb really is off (the pinned revision could not be
 * read, so the run's inputs are unknown; or a field is still incomplete) the
 * dialog SAYS that reason in the same words next to the button: a greyed verb
 * with no sentence beside it reads as a stuck dialog, not as a refusal.
 *
 * The server stays the authority for the cron grammar, the label set and the
 * fixed inputs: a `422 invalid_cron`, a `422 not_a_github_repository` /
 * `repository_mismatch` or a stale-version `409` renders inline and the
 * dialog stays open — never dressed up as a saved state. The converse is
 * just as hard: a create or update the server ACCEPTED closes the dialog
 * (`onSuccess` → `onClose`) so a saved trigger is never left sitting over a
 * form that still claims to be editing it — and the error line belongs to
 * ONE write attempt, the arm (issue/schedule, create/edit) that made it, so a
 * refusal from the other arm cannot haunt a form the author has since moved
 * to. The footnote says
 * only "Checked every minute": ADR-0061 adds per-repository GitHub
 * credentials, so nothing here claims public-repositories-only.
 *
 * 2026-10-30 review (2c item 5): the author does not read their own form as the
 * server's grammar. A text input whose value is only `{{issue.*}}` placeholders
 * shows the WORDS the fire fills it with (`the issue title and the issue body`),
 * with `write my own words` as the way back to the template bytes, and the hints
 * describe what the form does — no `422` codes, no grammar mnemonics.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"`
 * + `aria-modal`, labelled by its own title, focus trapped while open, Escape
 * closes, focus returns to the opener.
 *
 * Design 3a: an EXISTING trigger's pause lives here — the repository page's
 * inline switch retired with the STARTS WHEN boxes, so the edit dialog carries
 * the same `ToggleSwitch` (`Active` / `Paused`) and the flip rides the ONE
 * PATCH the Save verb already spends (`enabled` on the schedule/issue update
 * route). A paused trigger keeps every other answer; pausing is not deleting.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IconBrandGithub, IconClock } from "@tabler/icons-react";
import { Button } from "../ds/Button";
import { Field, Input, Select, labelClass } from "../ds/Field";
import { ProblemBanner, Spinner } from "../Feedback";
import { problemOf } from "../../api/client";
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
import { hasCredential } from "../repo/GitHubAccess";
import { useCreateIssueTrigger, usePatchIssueTrigger } from "../../api/useIssueTriggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import { cronInWords } from "../../lib/cronText";
import { ToggleSwitch } from "./ToggleSwitch";
import type { Assignment, Repository } from "../../api/types";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The any-of label ceiling the server enforces (`invalid_labels`); the
 * dialog refuses beyond it before a request leaves. */
const MAX_ISSUE_TRIGGER_LABELS = 20;

/** The GitHub mark: `@tabler/icons-react` ships the brand glyph, so nothing is
 * rebuilt by hand any more (the icon package this file used before had
 * dropped its brand glyphs, which is why it carried the path data itself).
 *
 * The nodes Tabler generates each carry a `key`, so the glyph renders through
 * the library's array machinery without React's “Each child in a list should
 * have a unique ‘key’ prop” dev warning — the defect the hand-built node array
 * risked on every screen showing the mark (pass-1-20261027044149 dev-server
 * defect on 2e repo and 2c schedule-trigger-saved). `GithubIcon.test.tsx`
 * guards that, and the export name so the call sites stay unchanged. */
export const GithubIcon = IconBrandGithub;

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

/** A text input's value shown as the design words it: an issue-bound value is
 * a fire-time template, and `{{issue.title}}` in a box is a note to the server,
 * not a sentence to the author (2026-10-30 review, 2c item 5). The control keeps
 * the field's own test id — in this arm it IS that field, in its bound state —
 * and `write my own words` is the way back to the raw bytes. */
function IssueWordsField({
  field,
  words,
  onWriteOwnWords,
}: {
  field: RunInputField;
  words: string;
  onWriteOwnWords(): void;
}) {
  const id = `new-run-input-${field.name}`;
  return (
    <div className="space-y-1">
      <span className={labelClass}>
        {field.name}
        {field.required ? " *" : ""}
      </span>
      <div
        id={id}
        data-testid={id}
        data-bound="issue"
        className="rounded-[3px] border border-line bg-paper px-[10px] py-1 font-mono text-[12.5px] text-ink"
      >
        {words}
      </div>
      {field.description ? (
        <p className="font-mono text-[10.5px] text-faint" data-testid={`${id}-hint`}>
          {field.description}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onWriteOwnWords}
        className="w-max font-mono text-[11px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid={`trigger-dialog-raw-${field.name}`}
      >
        write my own words
      </button>
    </div>
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

/**
 * The block a refused write leaves in the dialog: Feedback's shared
 * `Couldn't …` block (error-details-r6 — every caller gets the one treatment
 * through it, not a copy of it), with the verb a WRITE needs. The plain
 * sentence in the reader's words leads, the status gets its own plain line
 * when one applies, and the server's problem document sits collapsed behind
 * `Details` — quoting `Internal Server Error: emulated failure` on the reading
 * line is developer-facing text (the pass-1 review's defect), while dropping
 * it would be dishonest, so the disclosure keeps it one keypress away.
 *
 * The old rendering was the compact `× FAILED / <problem>` callout, which the
 * 2c review graded a defect on both counts: `FAILED` is a run's status word (the
 * handoff's rule 06), and with the verb greyed beside it the screen said
 * “something broke, and you cannot do anything about it”.
 */
function TriggerWriteFailure({
  error,
  verb,
  canRetry,
}: {
  error: unknown;
  /** The dialog's own primary verb, so the sentence points at the real button. */
  verb: string;
  /** Whether that verb is pressable right now (a broken read says its own
   * reason beside the button instead of promising a press that does nothing). */
  canRetry: boolean;
}) {
  return (
    <ProblemBanner
      error={error}
      fallback="Nothing was changed."
      subject="the trigger"
      verb="save"
      hint={
        canRetry
          ? `Nothing was changed. Your answers are still here — press ${verb} to try again.`
          : `Nothing was changed. Your answers are still here — ${verb} says below what it is waiting for.`
      }
      testid="trigger-dialog-error"
      className="shrink-0"
    />
  );
}

/** Why the primary verb sits disabled, in the words the author reads — null
 * when it is live (2026-11-01 review: the pass-1 shot showed a filled-looking
 * form with a greyed `Add trigger` and nothing explaining it, which reads as a
 * dead end rather than as a rule).
 *
 * An EMPTY LABEL FIELD is deliberately not one of these reasons: the label hint
 * already says “leave it empty to watch every issue”, so empty labels are a
 * valid answer, not a blocker. */
export function primaryVerbBlock({
  verb,
  revisionPending,
  revisionFailed,
  problems,
}: {
  verb: string;
  revisionPending: boolean;
  revisionFailed: boolean;
  problems: Record<string, string>;
}): string | null {
  if (revisionFailed) {
    return `${verb} is off until the pinned workflow revision can be read — the run's inputs come from it.`;
  }
  if (revisionPending) {
    return `${verb} is off while the pinned workflow revision loads.`;
  }
  const names = Object.keys(problems);
  if (names.length === 0) return null;
  // The field itself carries the full note; this line repeats it where the
  // button is, without the grammar mnemonic the author does not read.
  const what = names.map((name) => problems[name].replace(/ by spec\.inputs$/i, "")).join("; ");
  return `${verb} is off until the form is complete — ${what}.`;
}

export type TriggerEditing =
  | { kind: "schedule"; schedule: Schedule }
  | { kind: "issue"; trigger: IssueTrigger };

/** The four writes this dialog can spend: each is its own mutation, and the
 * inline error is the one THIS attempt answered with. */
type TriggerWrite = "schedule-create" | "schedule-patch" | "issue-create" | "issue-patch";

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
  // The pause control's value (design 3a): the edited trigger's own `enabled`,
  // saved through the SAME update route the Save verb spends. A new trigger is
  // born active, as it was before the switch existed.
  const [enabled, setEnabled] = useState(
    editing === null
      ? true
      : editing.kind === "schedule"
        ? editing.schedule.enabled
        : editing.trigger.enabled,
  );
  const [values, setValues] = useState<Record<string, InputValue>>({});
  // Which text inputs the author has opened as RAW template text. A value made
  // only of fire-time placeholders is shown in words, not as `{{issue.title}}`
  // soup (2026-10-30 review, 2c item 5); this map is the way back to the bytes
  // the row actually carries, and it is per-field because two inputs of one
  // trigger can be in different states.
  const [rawTemplates, setRawTemplates] = useState<Record<string, boolean>>({});
  const [showProblems, setShowProblems] = useState(false);
  // Which of the four writes the LAST submit attempted: the error line on
  // screen is that write's answer, never another arm's leftover.
  const [lastWrite, setLastWrite] = useState<TriggerWrite | null>(null);
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

  /** Moving between the two `START IT WHEN` arms abandons the refusal the
   * other arm answered with: that message names labels or a cron this form no
   * longer shows, so leaving it up would describe a form the author is not
   * looking at. */
  function chooseMode(next: "issue" | "schedule") {
    setMode(next);
    setLastWrite(null);
  }

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
    // Name the arm this submit spends before it leaves, so what renders below
    // is this attempt's answer and nothing else's.
    setLastWrite(
      mode === "issue"
        ? editing?.kind === "issue"
          ? "issue-patch"
          : "issue-create"
        : editing?.kind === "schedule"
          ? "schedule-patch"
          : "schedule-create",
    );
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
              enabled,
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
            enabled,
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

  const writeErrors: Record<TriggerWrite, unknown> = {
    "schedule-create": createSchedule.error,
    "schedule-patch": patchSchedule.error,
    "issue-create": createIssue.error,
    "issue-patch": patchIssue.error,
  };
  const writeError = lastWrite === null ? null : writeErrors[lastWrite];
  // The verb the author reads on the button, reused in the sentences that talk
  // about the button, so the copy and the control never disagree.
  const verb = editing ? "Save trigger" : "Add trigger";
  // A failed write does NOT disable the verb (nothing about the form changed),
  // so the only reasons left to explain are the ones `blocked` answers for.
  const blockReason = busy
    ? null
    : primaryVerbBlock({
        verb,
        revisionPending: revision.isPending,
        revisionFailed: revision.isError,
        problems,
      });

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
              className="block break-words font-mono text-[10.5px] text-muted"
              data-testid="trigger-dialog-context"
            >
              {/* The whole context line, at every width (2026-10-30 copy review,
                  2c item 8): `truncate` cut the REPOSITORY off — the one name
                  the trigger is about — because the project's name came first. It
                  wraps instead. */}
              {`${workflowLabel} · ${project.name} / ${repository.name}`}
            </span>
          </div>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
        </div>
        <form
          className="flex max-h-[calc(100vh-8rem)] flex-col gap-[14px] px-4 py-4"
          onSubmit={submit}
          data-testid="trigger-dialog-form"
        >
          {/* The fields scroll; the refusal and the verbs do not (2026-11-01
              review): with the whole form scrolling, a tall run-input form pushed
              `Couldn't save the trigger.` below the fold — the explanation the
              author needs to read sat under the very button it explains. */}
          <div
            className="flex min-h-0 flex-col gap-[14px] overflow-y-auto"
            data-testid="trigger-dialog-body"
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
                  onClick={() => chooseMode("issue")}
                  className={`flex items-center gap-[6px] px-3 py-[5px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-ring ${
                    mode === "issue"
                      ? "bg-ink font-semibold text-surface"
                      : "bg-surface font-normal text-ink-2"
                  }`}
                  data-testid="trigger-dialog-mode-issue"
                >
                  <GithubIcon size={14} stroke={2} aria-hidden />
                  A GitHub issue…
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "schedule"}
                  onClick={() => chooseMode("schedule")}
                  className={`flex items-center gap-[6px] border-l border-line-strong px-3 py-[5px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-ring ${
                    mode === "schedule"
                      ? "bg-ink font-semibold text-surface"
                      : "bg-surface font-normal text-ink-2"
                  }`}
                  data-testid="trigger-dialog-mode-schedule"
                >
                  <IconClock size={14} stroke={2} aria-hidden />
                  On a schedule
                </button>
              </div>
            </div>

            {/* Design 3a: the pause control for an EXISTING trigger — the
                successor to the retired inline switch. It sits with the arm it
                governs (an edit that moved to the other arm is authoring a NEW
                trigger, which is born active), and its flip is saved by the
                same PATCH as every other answer: no second write, no silent
                save. `Active` / `Paused` are the words the row will show. */}
            {editing !== null && mode === editing.kind ? (
              <div className="flex items-center gap-[10px]">
                <ToggleSwitch
                  checked={enabled}
                  testid="trigger-dialog-enabled"
                  stateWords={["Active", "Paused"]}
                  onChange={setEnabled}
                />
                <span
                  className="font-mono text-[10.5px] text-faint"
                  data-testid="trigger-dialog-enabled-hint"
                >
                  a paused trigger keeps its answers and stops firing
                </span>
              </div>
            ) : null}

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
                    an issue with any one of these labels starts the run; leave it empty to watch
                    every issue
                  </p>
                </div>
              </>
            ) : (
              <Field
                id="trigger-dialog-cron"
                label="RUNS AT (UTC)"
                hint={
                  <span data-testid="trigger-dialog-cron-hint">
                    five fields: minute, hour, day of month, month, day of week
                  </span>
                }
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
                fallback="The dialog cannot see what the run needs, so it will not send a trigger it cannot complete."
                subject="the pinned workflow revision"
                testid="trigger-dialog-revision-error"
                // A 404 is a refusal, not a break: re-asking for a revision that
                // is not there answers the same, so the block offers no Retry
                // (the rule `ProblemBanner` states for every load failure).
                retry={
                  problemOf(revision.error).status === 404
                    ? undefined
                    : {
                        onClick: () => void revision.refetch(),
                        pending: revision.isFetching,
                        testid: "trigger-dialog-revision-retry",
                      }
                }
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

            {editableFields?.map((field) => {
              // The issue arm reads a placeholder-only value in words; the
              // schedule arm has no issue to fill anything, so the same bytes
              // there ARE the literal text and stay in the box the author typed.
              const stored = values[field.name];
              const isTextKind = field.kind === "text" || field.kind === "textarea";
              const words =
                mode === "issue" && isTextKind
                  ? issueValueInWords(typeof stored === "string" ? stored : "")
                  : null;
              const showRaw = words === null || rawTemplates[field.name] === true;
              return (
                <div key={field.name} className="flex flex-col gap-1">
                  {showRaw ? (
                    <InputFieldControl
                      field={field}
                      value={stored}
                      repositories={[repository.name]}
                      repositoriesLoading={false}
                      error={showProblems ? problems[field.name] : undefined}
                      onChange={(value) =>
                        setValues((current) => ({ ...current, [field.name]: value }))
                      }
                    />
                  ) : (
                    <IssueWordsField
                      field={field}
                      words={words}
                      onWriteOwnWords={() =>
                        setRawTemplates((current) => ({ ...current, [field.name]: true }))
                      }
                    />
                  )}
                  {showRaw && mode === "issue" && isTextKind ? (
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
              );
            })}

            {mode === "issue" ? (
              <span
                className="font-mono text-[10.5px] text-faint"
                data-testid="trigger-dialog-note"
              >
                {/* Design 2c's footnote, told honestly: the poll is minute-based,
                  and an issue trigger can only be read from a repository this
                  platform can reach anonymously — i.e. a public one. ADR-0061
                  gives a repository a GitHub credential, and with one that limit
                  is gone, so the second half is said only where it is true
                  (2026-10-30 copy review; pass-8 review item 10 put the design's
                  words back for the case they describe). */}
                Checked every minute
                {hasCredential(repository) ? "" : " · public GitHub repositories only"}
              </span>
            ) : null}
          </div>

          {writeError ? (
            <TriggerWriteFailure
              error={writeError}
              verb={verb}
              // The way out of a refusal is the same verb; say so only when the
              // button can actually be pressed.
              canRetry={!blocked}
            />
          ) : null}

          <div className="flex shrink-0 flex-col items-end gap-[6px] border-t border-line pt-3">
            {/* The reason sits beside the verb it explains, not in a tooltip on a
                button a pointer cannot hover and a screen reader cannot reach. */}
            {blockReason ? (
              <p
                id="trigger-dialog-submit-reason"
                className="w-full max-w-[360px] text-right font-mono text-[10.5px] text-muted"
                data-testid="trigger-dialog-submit-reason"
              >
                {blockReason}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
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
                aria-describedby={blockReason ? "trigger-dialog-submit-reason" : undefined}
                data-testid="trigger-dialog-submit"
              >
                {busy ? "Saving…" : verb}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
