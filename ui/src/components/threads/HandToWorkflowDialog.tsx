/**
 * "Hand to a workflow" (artboard 5d, ADR-0053): start a project run whose
 * base is the thread's branch, whose first-step input is the thread's
 * summary, and whose artifacts ride along — the thread stays open and links
 * to the run.
 *
 * Honesty rules (gaps/threads.md §5):
 * - the CARRIES OVER branch line comes from the thread's recorded workspace
 *   state only (`workspace_repos` head vs base, ADR-0017 D8/P8) before the
 *   create, and from the `201 base` member after it — never a claim;
 * - the pinned revision's declared `spec.inputs` are rendered as form fields
 *   (the same projection as the New run form) and sent with the create — a
 *   workflow that declares REQUIRED inputs 422s otherwise;
 * - the summary is prefilled with the thread's LAST AGENT MESSAGE from the
 *   transcript projection, labelled "Summary (editable)" — it is never
 *   claimed to have been model-written;
 * - the artifacts section renders only when the project artifact list
 *   actually loaded: a failed read is not "no artifacts";
 * - the run starts fresh agent sessions; the thread's transcript is NOT
 *   replayed (ADR-0053 § 7), and the dialog says so.
 *
 * Submission is idempotent per ADR-0023 § 12 (one key per dialog instance);
 * the dialog is a 640px accessible modal: focus trapped, esc closes, focus
 * returns to the opener (the same contract as NewProfileDialog).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { useConversationEvents } from "../../api/events";
import {
  BRANCH_PENDING_COPY,
  CARRIES_BRANCH_COPY,
  NO_COMMITS_COPY,
  baseResultLines,
  handoffRunCreateBody,
  handoffRunKey,
  handoffWorkflowOptions,
  lastAgentMessageOf,
  threadBranchCarriesCommits,
  threadWorkspaceOf,
} from "../../api/handoff";
import { useAssignments, usePipelines, useRevision } from "../../api/pipelines";
import { useArtifacts, useRepositories, useWorkspaces } from "../../api/queries";
import { useCreateRun } from "../../api/runs";
import type { RunCreateResponse } from "../../api/types";
import { Button } from "../ds/Button";
import { Field, Select, Textarea } from "../ds/Field";
import { ProblemBanner, Spinner } from "../Feedback";
import {
  InputFieldControl,
  defaultValuesOf,
  inputProblemsOf,
  runInputFieldsOf,
  wireInputsOf,
  type InputValue,
} from "../m4/NewRunForm";

export interface HandToWorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: { id: string; project_id: string; title: string };
  onStarted: (runId: string) => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function HandToWorkflowDialog(props: HandToWorkflowDialogProps) {
  // Rendered only while open, so mounting is the opener holding focus and the
  // layout effect can capture it before moving focus into the dialog.
  if (!props.open) return null;
  return (
    <DialogBody
      conversation={props.conversation}
      onClose={props.onClose}
      onStarted={props.onStarted}
    />
  );
}

// Default export per the unit contract; a named re-export for callers that
// import by name.
export { HandToWorkflowDialog };

interface DialogBodyProps {
  conversation: { id: string; project_id: string; title: string };
  onClose: () => void;
  onStarted: (runId: string) => void;
}

function DialogBody({ conversation, onClose, onStarted }: DialogBodyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const projectId = conversation.project_id;

  const assignments = useAssignments(projectId);
  const pipelines = usePipelines();
  const workspaces = useWorkspaces(projectId);
  const artifacts = useArtifacts(projectId);
  const repositories = useRepositories(projectId);
  const transcript = useConversationEvents(conversation.id);
  const createRun = useCreateRun(projectId);

  const [assignmentId, setAssignmentId] = useState("");
  const [summary, setSummary] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const summaryTouched = useRef(false);
  const [chosenArtifacts, setChosenArtifacts] = useState<ReadonlySet<string>>(new Set());
  // Values for the revision's declared `spec.inputs` — one control per
  // declared input, collected exactly as the New run form does.
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const inputTouched = useRef<Set<string>>(new Set());
  const [created, setCreated] = useState<RunCreateResponse | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  // One key per dialog instance: a second click before the repaint is still
  // one request, and a retry re-answers with the stored run.
  const idempotencyKey = useRef<string>(handoffRunKey());
  const inFlight = useRef(false);

  const options = useMemo(
    () =>
      handoffWorkflowOptions(assignments.data?.assignments ?? [], pipelines.data?.pipelines ?? []),
    [assignments.data, pipelines.data],
  );
  const activeOption = options.find((option) => option.id === assignmentId) ?? options[0] ?? null;

  // The pinned revision's declared `spec.inputs`, projected into form fields
  // exactly the way the New run form does — a workflow that declares REQUIRED
  // inputs used to 422 the create because the dialog seeded none of them.
  const revision = useRevision(activeOption?.pinnedRevisionId ?? "");
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  const problems = fields ? inputProblemsOf(fields, values) : {};
  const inputProblems = Object.keys(problems).length > 0;

  // Seed the declared defaults once per chosen assignment, mirroring
  // NewRunForm: switching assignments resets the fields rather than keeping
  // stale values under a different schema.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!fields || !activeOption || seededFor.current === activeOption.id) return;
    seededFor.current = activeOption.id;
    setValues(defaultValuesOf(fields));
    inputTouched.current = new Set();
  }, [fields, activeOption]);

  // The dialog's own contract: the first-step input is the thread's summary.
  // The first free-text string input carries it — prefilled only while the
  // field is still empty and unedited, never over what the person typed.
  const prefillTarget = useMemo(
    () => fields?.find((field) => field.kind === "textarea" || field.kind === "text") ?? null,
    [fields],
  );
  const prefillNote =
    prefillTarget !== null &&
    summary !== "" &&
    typeof values[prefillTarget.name] === "string" &&
    values[prefillTarget.name] === summary;
  useEffect(() => {
    if (!prefillTarget || summary === "") return;
    setValues((current) => {
      if (inputTouched.current.has(prefillTarget.name)) return current;
      const existing = current[prefillTarget.name];
      if (typeof existing === "string" && existing.trim() !== "") return current;
      return { ...current, [prefillTarget.name]: summary };
    });
  }, [prefillTarget, summary]);

  // The artifact list is project-scoped on the API; the filter is what makes
  // it the THREAD's list. A failed read is not "none" — the section is
  // omitted rather than claiming an empty rail.
  const threadArtifacts = useMemo(
    () =>
      artifacts.isSuccess
        ? (artifacts.data?.artifacts ?? []).filter(
            (artifact) => artifact.conversation_id === conversation.id,
          )
        : null,
    [artifacts.isSuccess, artifacts.data, conversation.id],
  );

  // Prefill the summary with the thread's last agent message exactly once,
  // and never over what the person already typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || summaryTouched.current) return;
    const message = lastAgentMessageOf(transcript.events);
    if (message === "") return;
    seeded.current = true;
    setSummary(message);
    setPrefilled(true);
  }, [transcript.events]);

  // The pre-create branch answer, from the recorded workspace state only —
  // the same rows (workspace_repos head vs base) the server pins from.
  const branchCopy = !workspaces.isSuccess
    ? BRANCH_PENDING_COPY
    : threadBranchCarriesCommits(threadWorkspaceOf(workspaces.data?.workspaces, conversation.id))
      ? CARRIES_BRANCH_COPY
      : NO_COMMITS_COPY;

  // Focus trap + escape, the accessible-modal contract (the same pattern as
  // NewProfileDialog).
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useLayoutEffect(() => {
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (created || inFlight.current || !activeOption || inputProblems) return;
    inFlight.current = true;
    setSubmitError(null);
    const body = handoffRunCreateBody(activeOption.id, {
      conversationId: conversation.id,
      summary,
      artifactIds: [...chosenArtifacts],
      inputs: fields !== null ? wireInputsOf(fields, values) : undefined,
    });
    createRun.mutate(
      { body, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (response) => {
          setCreated(response);
          onStarted(response.run_id);
        },
        onError: (error) => setSubmitError(error),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  const busy = createRun.isPending;
  // `422` locations travel on the raw problem body, which ApiError keeps.
  const rawFindings =
    submitError instanceof ApiError
      ? ((submitError.body as { errors?: unknown } | null)?.errors ?? undefined)
      : undefined;
  const findings = Array.isArray(rawFindings)
    ? (rawFindings as { instance_location?: unknown; code?: unknown; message?: unknown }[])
    : [];
  const baseLines = created ? baseResultLines(created.base) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        data-testid="handoff-dialog"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[640px] overflow-y-auto rounded-[3px] border border-line-strong bg-surface p-4 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
      >
        <header className="space-y-0.5">
          <h2 id="handoff-title" className="text-[15px] font-bold text-ink">
            Hand to a workflow
          </h2>
          <p className="text-[12.5px] text-muted" data-testid="handoff-from">
            from thread “{conversation.title}”
          </p>
        </header>

        <form
          onSubmit={(event) => void submit(event)}
          data-testid="handoff-form"
          className="mt-3 space-y-4"
        >
          {/* WORKFLOW — the project's enabled assignments, their pinned revision. */}
          <Field id="handoff-workflow" label="Workflow">
            {assignments.isPending ? (
              <Spinner label="Loading workflows" />
            ) : assignments.isError ? (
              <ProblemBanner
                error={assignments.error}
                fallback="Workflows could not be loaded."
                testid="handoff-workflows-problem"
              />
            ) : options.length === 0 ? (
              <p className="text-[12.5px] text-muted" data-testid="handoff-no-workflows">
                No enabled workflow assignment for this project yet — a run cannot be started from
                it.
              </p>
            ) : (
              <Select
                id="handoff-workflow"
                data-testid="handoff-workflow-select"
                value={activeOption?.id ?? ""}
                onChange={(event) => setAssignmentId(event.target.value)}
                disabled={created !== null}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* RUN INPUTS — one control per declared `spec.inputs` entry of the
              pinned revision; a workflow with REQUIRED inputs 422s a create
              that seeds none of them. */}
          {revision.isPending ? <Spinner label="Reading the revision's inputs" /> : null}
          {revision.isError ? (
            <ProblemBanner
              error={revision.error}
              fallback="The pinned revision's inputs could not be read."
              testid="handoff-revision-problem"
            />
          ) : null}
          {!revision.isPending && !revision.isError && fields === null ? (
            <p className="text-[12.5px] text-muted" data-testid="handoff-no-inputs">
              The pinned revision declares no <code>spec.inputs</code> — there is nothing to fill
              in.
            </p>
          ) : null}
          {fields !== null && fields.length > 0 ? (
            <section className="space-y-2" data-testid="handoff-inputs">
              <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                Run inputs
              </span>
              {fields.map((field) => (
                <InputFieldControl
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  repositories={(repositories.data?.items ?? []).map((repo) => repo.name)}
                  repositoriesLoading={repositories.isPending}
                  error={problems[field.name]}
                  onChange={(value) => {
                    if (value !== undefined && typeof value === "string")
                      inputTouched.current.add(field.name);
                    setValues((current) => ({ ...current, [field.name]: value }));
                  }}
                />
              ))}
              {prefillNote ? (
                <p
                  className="font-mono text-[10.5px] text-faint"
                  data-testid="handoff-input-prefill-note"
                >
                  {prefillTarget?.name} was prefilled with the summary — edit either before you
                  start.
                </p>
              ) : null}
            </section>
          ) : null}

          {/* CARRIES OVER — every line is answered from real data. */}
          <section
            className="space-y-3 rounded-[3px] border border-line p-3"
            data-testid="handoff-carries-over"
          >
            <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              Carries over
            </span>
            <p className="font-mono text-[11.5px] text-ink" data-testid="handoff-branch-copy">
              {branchCopy}
            </p>
            <Field
              id="handoff-summary"
              label="Summary (editable)"
              hint={
                prefilled ? (
                  <span className="font-mono text-[10.5px] text-faint">
                    Prefilled with the thread's last agent message — edit it before you start.
                  </span>
                ) : undefined
              }
            >
              <Textarea
                id="handoff-summary"
                data-testid="handoff-summary"
                rows={4}
                value={summary}
                onChange={(event) => {
                  summaryTouched.current = true;
                  setSummary(event.target.value);
                }}
                disabled={created !== null}
              />
            </Field>
            {threadArtifacts ? (
              <fieldset data-testid="handoff-artifacts" className="space-y-1.5">
                <legend className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                  Artifacts
                </legend>
                {threadArtifacts.length === 0 ? (
                  <p className="text-[12px] text-muted" data-testid="handoff-artifacts-empty">
                    No artifacts attached to this thread yet.
                  </p>
                ) : (
                  threadArtifacts.map((artifact) => (
                    <label
                      key={artifact.id}
                      className="flex items-center gap-2 text-[12.5px] text-ink"
                    >
                      <input
                        type="checkbox"
                        data-testid={`handoff-artifact-${artifact.id}`}
                        checked={chosenArtifacts.has(artifact.id)}
                        disabled={created !== null}
                        onChange={(event) => {
                          setChosenArtifacts((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(artifact.id);
                            else next.delete(artifact.id);
                            return next;
                          });
                        }}
                      />
                      <span className="font-mono">{artifact.name}</span>
                    </label>
                  ))
                )}
              </fieldset>
            ) : null}
            <p className="font-mono text-[11px] text-muted" data-testid="handoff-thread-note">
              thread — stays open and links to the run.
            </p>
          </section>

          <p className="font-mono text-[11.5px] text-muted" data-testid="handoff-fresh-sessions">
            The run starts fresh agent sessions; the thread's conversation is not replayed.
          </p>

          {submitError ? (
            <div data-testid="handoff-problem" className="space-y-1">
              <ProblemBanner
                error={submitError}
                fallback="The run could not be started."
                testid="handoff-problem-banner"
              />
              {findings.length > 0 ? (
                <ul className="space-y-[2px] font-mono text-[11px] text-muted">
                  {findings.map((finding, index) => (
                    <li key={index} data-testid={`handoff-problem-finding-${index}`}>
                      {typeof finding.instance_location === "string"
                        ? `${finding.instance_location} `
                        : ""}
                      {typeof finding.code === "string" ? `[${finding.code}] ` : ""}
                      {typeof finding.message === "string"
                        ? finding.message
                        : JSON.stringify(finding)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {created ? (
            <div className="space-y-1" role="status" data-testid="handoff-started">
              <p className="font-mono text-[12px] text-st-done-tag-fg">
                ✓ Run started — queued from this thread.
              </p>
              {baseLines.length > 0 ? (
                <ul className="space-y-[2px] font-mono text-[11.5px] text-ink">
                  {baseLines.map((line, index) => (
                    <li key={index} data-testid={`handoff-base-${index}`}>
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="font-mono text-[11.5px] text-muted">
                  The create response did not report the per-repository base — the run detail's
                  repo_snapshot is the durable record.
                </p>
              )}
            </div>
          ) : null}

          <footer className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              data-testid="handoff-cancel"
            >
              Cancel
            </Button>
            {created ? (
              <Button type="button" variant="primary" onClick={onClose} data-testid="handoff-done">
                Done
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  activeOption === null ||
                  inputProblems ||
                  revision.isPending ||
                  revision.isError
                }
                data-testid="handoff-submit"
              >
                {busy ? "Starting run…" : "Start run"}
              </Button>
            )}
          </footer>
        </form>
      </div>
    </div>
  );
}
