/**
 * The inline `Start a run…` expansion on an OPEN ISSUES row (design 1e).
 *
 * The raised row (ink border, hard shadow) holds the issue, then a royal-wash
 * strip: `RUN` · a workflow select · the mapping text · `Start run` (primary)
 * · `Cancel` (ghost). Everything the strip shows is what the API can actually
 * do:
 *
 * - the workflow choices are the assignments this repository uses (the same
 *   ADR-0060 set the WORKFLOWS panel lists) — `POST /projects/{id}/runs` takes
 *   an `assignment_id`, so a run always starts from a pinned revision;
 * - the mapping text is read from THAT revision's `spec.inputs` (the shared
 *   `runInputFieldsOf`/`issueValuesFor` rules from `NewRunForm`): it names the
 *   inputs the issue will actually fill (`goal = issue title + body`, …) and
 *   never promises a seed the schema cannot receive;
 * - an input the revision requires but the issue cannot fill is named on the
 *   line too — the request still goes (the server is the authority and its
 *   `422` lands inline), because pretending the click would work is worse
 *   than letting the server answer.
 *
 * Known gap (listed in the build report): a hand-started run records
 * `trigger.kind = manual` with no ref — the API has no way to attach the
 * issue to a manual start, so the run does NOT link back to the issue yet.
 * Only trigger-fired issue runs carry `trigger.ref = owner/repo#n`.
 *
 * Submission carries one idempotency key per expansion (ADR-0023 § 12): a
 * double click or a retry re-answers with the same run.
 */
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useRevision } from "../../api/pipelines";
import { useCreateRun } from "../../api/runs";
import type { GitHubIssue } from "../../api/issues";
import type { Assignment } from "../../api/types";
import { problemOf } from "../../api/client";
import { Button } from "../ds/Button";
import { Select } from "../ds/Field";
import { Spinner } from "../Feedback";
import { routes } from "../../lib/routes";
import {
  defaultValuesOf,
  issueValuesFor,
  runInputFieldsOf,
  wireInputsOf,
  type InputValue,
} from "../m4/NewRunForm";

export interface IssueRunExpansionProps {
  projectId: string;
  issue: GitHubIssue;
  /** The assignments this repository uses (enabled ones are startable). */
  assignments: readonly Assignment[];
  /** Workflow slug by pipeline id — the only name the wire gives. */
  nameFor: (pipelineId: string) => string;
  onClose: () => void;
}

/** One idempotency key per mounted expansion (same rule as NewRunForm). */
function newIssueRunKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `issuerrun-${c.randomUUID()}`;
  return `issuerrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Human words for what one filled input receives, per `issueValuesFor`'s
 * rules: prose inputs get the issue's title + body, number inputs its number,
 * link inputs its URL. */
function mappingText(name: string, kind: string): string {
  if (kind === "integer" || kind === "number") return `${name} = issue number`;
  if (name.toLowerCase() === "issue_url" || name.toLowerCase() === "url")
    return `${name} = issue link`;
  return `${name} = issue title + body`;
}

export function IssueRunExpansion({
  projectId,
  issue,
  assignments,
  nameFor,
  onClose,
}: IssueRunExpansionProps) {
  const navigate = useNavigate();
  const startable = useMemo(
    () => assignments.filter((assignment) => assignment.enabled),
    [assignments],
  );
  const [assignmentId, setAssignmentId] = useState(startable[0]?.id ?? "");
  const active = startable.find((assignment) => assignment.id === assignmentId) ?? null;
  const revision = useRevision(active?.pinned_revision_id ?? "");
  const createRun = useCreateRun(projectId);
  const idempotencyKey = useRef<string>(newIssueRunKey());
  const inFlight = useRef(false);

  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  const seeded = fields ? issueValuesFor(fields, issue) : null;
  const unfilledRequired = fields
    ? fields
        .filter((field) => field.required && !(field.name in (seeded?.values ?? {})))
        .map((field) => field.name)
    : [];

  const mappingLine = (() => {
    if (!active) return "no workflow selected — assign one to this repository first";
    if (revision.isPending) return "reading the pinned revision…";
    if (revision.isError) return "the pinned revision could not be read — the mapping is unknown";
    if (!fields || fields.length === 0)
      return "this workflow declares no inputs — the issue is not passed to the run";
    if (!seeded || seeded.filled.length === 0)
      return "the issue fills nothing — this revision declares no input the issue matches";
    const parts = seeded.filled.map((name) => {
      const field = fields.find((candidate) => candidate.name === name);
      return mappingText(name, field?.kind ?? "text");
    });
    if (unfilledRequired.length > 0)
      return `${parts.join(" · ")} · ${unfilledRequired.join(", ")} not filled from the issue`;
    return parts.join(" · ");
  })();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!active || !fields || createRun.isPending || inFlight.current) return;
    inFlight.current = true;
    const values: Record<string, InputValue> = {
      ...defaultValuesOf(fields),
      ...seeded?.values,
    };
    createRun.mutate(
      {
        body: {
          assignment_id: active.id,
          inputs: wireInputsOf(fields, values),
          idempotency: idempotencyKey.current,
        },
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: (run) => navigate(routes.run(run.run_id)),
        onError: () => {
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <div
      className="mx-3 my-2 rounded-[3px] border border-ink bg-surface shadow-(--shadow-raised)"
      data-testid={`repo-issue-expand-${issue.number}`}
    >
      <div className="flex items-center gap-3 px-3 py-[10px]">
        <span className="min-w-0 flex-1">
          <a
            href={issue.html_url}
            target="_blank"
            rel="noreferrer"
            data-testid={`repo-issue-title-${issue.number}`}
            className="block text-[13px] font-semibold text-ink hover:underline"
          >
            #{issue.number} {issue.title}
          </a>
          <IssueLabels issue={issue} />
        </span>
      </div>
      <form
        onSubmit={onSubmit}
        className="flex flex-wrap items-center gap-[10px] border-t border-line bg-accent-wash px-3 py-[10px]"
        data-testid={`repo-issue-runform-${issue.number}`}
      >
        <label
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          htmlFor={`repo-issue-workflow-${issue.number}`}
        >
          Run
        </label>
        {startable.length === 0 ? (
          <span
            className="font-mono text-[11px] text-muted"
            data-testid={`repo-issue-noworkflow-${issue.number}`}
          >
            this repository has no enabled workflow to start
          </span>
        ) : (
          <Select
            id={`repo-issue-workflow-${issue.number}`}
            value={assignmentId}
            onChange={(event) => setAssignmentId(event.target.value)}
            className="h-[28px] w-auto min-w-[200px] max-w-full py-0 text-[12px]"
            data-testid={`repo-issue-workflow-${issue.number}`}
          >
            {startable.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {nameFor(assignment.pipeline_id)}
              </option>
            ))}
          </Select>
        )}
        <span
          className="min-w-0 text-[12px] text-muted"
          data-testid={`repo-issue-mapping-${issue.number}`}
        >
          {mappingLine}
        </span>
        <span className="ml-auto flex items-center gap-[10px]">
          <Button
            type="submit"
            variant="primary"
            compact
            disabled={
              active === null ||
              revision.isPending ||
              revision.isError ||
              fields === null ||
              createRun.isPending
            }
            data-testid={`repo-issue-start-${issue.number}`}
          >
            {createRun.isPending ? "Starting…" : "Start run"}
          </Button>
          <Button
            variant="ghost"
            compact
            onClick={onClose}
            data-testid={`repo-issue-cancel-${issue.number}`}
          >
            Cancel
          </Button>
        </span>
        {revision.isPending && active ? <Spinner label="Reading the pinned revision" /> : null}
        {createRun.isError ? (
          <p
            role="alert"
            className="w-full font-mono text-[11px] text-st-failed-pale-fg"
            data-testid={`repo-issue-start-error-${issue.number}`}
          >
            <span aria-hidden="true">×</span>{" "}
            {problemOf(createRun.error).detail || "The server refused the run."}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** `#n title` over its mono label chips (or the honest `no labels` line). */
export function IssueLabels({ issue }: { issue: GitHubIssue }) {
  return issue.labels.length > 0 ? (
    <span className="mt-1 flex flex-wrap gap-1" data-testid={`repo-issue-labels-${issue.number}`}>
      {issue.labels.map((label) => (
        <span
          key={label}
          className="rounded-[2px] border border-line px-[5px] font-mono text-[10px] text-ink-2"
        >
          {label}
        </span>
      ))}
    </span>
  ) : (
    <span
      className="mt-1 block font-mono text-[10px] text-faint"
      data-testid={`repo-issue-labels-${issue.number}`}
    >
      no labels
    </span>
  );
}
