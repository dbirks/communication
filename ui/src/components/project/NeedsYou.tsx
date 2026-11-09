/**
 * "Needs your decision" and "failed" callouts (Projects Review design 1b).
 *
 * One callout per item that asks something of a person, in the ALERT pale set:
 * an open gate (Read plan + the shared `DecisionBar`) or a run that stopped
 * (Open run · Retry from <step>). Deciding a gate is the SAME bar the briefing,
 * the approval page and the run workbench render (finding 04): fixed verbs
 * (Approve / Request changes / Reject), a 5s Undo window instead of a confirm
 * step, and a conflict sentence that names who beat the click — so the
 * overview teaches nothing the other screens do not. A gate the overview's list
 * drops while its bar still holds the click stays on screen as a "lost" row
 * until dismissed, exactly as `components/home/DecisionCallout.tsx` keeps it.
 * The list is the inbox's own read (`lib/attention.ts`) narrowed
 * to this project, so a stalled run can never read as fine here and urgent
 * there, and a `waiting_human` run whose gate is still open appears once — as
 * the decision — not twice.
 *
 * Honesty rules are the run pages'. The wire carries no run title and no
 * repository on a run, so a callout names its run by the workflow slug the
 * library serves and the `failed_cause` the server reported — never an invented
 * sentence about what went wrong.
 *
 * The callout is the design's shape and nothing more (1b): ONE header strip —
 * the state word, then `workflow · age` in the bar's right slot — and ONE body
 * sentence, with the actions beside it. The pass-3 review cut the second mono
 * line (`! APPROVAL  run #af9713f0 · /approve`): the bar already says the state,
 * and a run short-id and a node path are two things a person cannot read, click
 * or say back to anyone. The run is still reachable — `Read plan` and `Open run`
 * are links to it.
 *
 * Shape (pass-2 review, 390): the bar's mono meta truncates instead of
 * wrapping against the label — `NEEDS YOUR DECISION` never sits on two lines
 * against a long workflow name — and the buttons sit *under* the body on the
 * phone, where side-by-side squeezed both. From `md` up the body and the
 * actions share the row, as the design draws it.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { problemOf } from "../../api/client";
import { usePipelines } from "../../api/pipelines";
import { useProjectRuns } from "../../api/runs";
import { useResumeRun, useRetryRun, runConflictOf } from "../../api/runs";
import { useAttentionForProject } from "../../lib/attention";
import type { Approval, Project, RunSummary } from "../../api/types";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import DecisionBar from "../ds/DecisionBar";
import type { DecisionConflict } from "../ds/DecisionBar";
import { Spinner } from "../Feedback";
import { RUN_STATE, SHORT_WORD, stateOf } from "../ds/states";
import { ATTENTION_TITLE_CLAMP, attentionTitle } from "../../lib/attention";
import { formatAge, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** `node_execution_failed:/loop/body/scan` → the instance key to retry, plus
 * the leaf a person would call the step (`scan`). Any other cause — a budget
 * name, `until_exhausted` — has no step, so the retry targets the whole run. */
export function retryTarget(
  cause: string | null | undefined,
): { key: string; label: string } | null {
  if (!cause) return null;
  if (!cause.startsWith("node_execution_failed:")) return null;
  const key = cause.slice("node_execution_failed:".length);
  if (!key) return null;
  const leaf = key.split("/").filter(Boolean).at(-1) ?? key;
  return { key, label: leaf };
}

/** The server's `failed_cause` in a sentence a person can act on. Every branch
 * is a cause the wire really reports (`01`'s run table, ADR-0023 § 12); an
 * unknown one is quoted rather than guessed at, because a wrong reason is
 * worse than a raw one. */
export function failedCauseInWords(cause: string | null | undefined): string {
  const target = retryTarget(cause);
  if (target) return `A step failed: ${target.label}`;
  switch (cause) {
    case "run_duration_exceeded":
      return "The run passed its total duration budget.";
    case "node_execution_budget_exceeded":
      return "A step ran out of its execution budget.";
    case "expression_eval_budget_exceeded":
      return "The run ran out of expression evaluations.";
    case "max_duration_exceeded":
      return "A step passed its maximum duration.";
    case "child_depth_exceeded":
      return "The run hit the child-run depth limit.";
    case "until_exhausted":
      return "The loop never reached its until condition.";
    case null:
    case undefined:
    case "":
      return "The run stopped without finishing.";
    default:
      return `The run stopped: ${cause}`;
  }
}

/** The bar's right slot, in one line at any width: the workflow name ellipses
 *  before the bar ever wraps a second line against `NEEDS YOUR DECISION`, and
 *  the whole meta stays in the element's tooltip. */
function BarMeta({ text }: { text: string }) {
  return (
    <span className="block max-w-[38vw] truncate text-right md:max-w-none" title={text}>
      {text}
    </span>
  );
}

export interface NeedsYouProps {
  project: Project;
}

export function NeedsYou({ project }: NeedsYouProps) {
  // The inbox's own reduction, one project wide — the same keys the header's tab
  // count reads, mounted in the same commit, so the fan is one set of requests.
  const attention = useAttentionForProject(project);
  const runs = useProjectRuns(project.id);
  const pipelines = usePipelines();
  // Pipeline id → slug: the only name the wire gives a run.
  const slugs = useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );
  const runsById = useMemo(
    () => new Map((runs.data?.runs ?? []).map((run) => [run.id, run] as const)),
    [runs.data],
  );
  // A gate whose bar reported "someone else decided" lives here — outside the
  // pending read, which has already dropped it — until the person dismisses it,
  // so the news never vanishes with the row that carried it (finding 04).
  const [lost, setLost] = useState<LostDecision[]>([]);
  const rememberLost = useCallback((row: Approval, conflict: DecisionConflict) => {
    setLost((current) => {
      const rest = current.filter((entry) => entry.conflict.approvalId !== conflict.approvalId);
      return [...rest, { approval: row, conflict }];
    });
  }, []);
  const dismissLost = useCallback((approvalId: string) => {
    setLost((current) => current.filter((entry) => entry.conflict.approvalId !== approvalId));
  }, []);
  const lostIds = new Set(lost.map((entry) => entry.conflict.approvalId));
  const total = attention.decisions.length + attention.stalled.length;

  return (
    <div className="space-y-[12px]" data-testid="project-attention">
      {attention.pending ? <Spinner label="Reading what needs you" /> : null}
      {attention.unread.map(({ title }) => (
        <p
          key={title}
          className="font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid="project-attention-unread"
        >
          × {title}
        </p>
      ))}
      {!attention.pending && total === 0 && lost.length === 0 ? (
        <p
          className="flex items-center gap-[6px] rounded-[3px] border border-st-done-pale-edge bg-st-done-pale-body px-[12px] py-[8px] text-[13px] text-st-done-pale-fg"
          data-testid="project-attention-empty"
        >
          <span aria-hidden="true">✓</span>
          Nothing needs attention in this project.
        </p>
      ) : null}
      {/* Lost gates ride above the live list: the pending read no longer
          carries them, and the sentence is the news still to be dismissed. */}
      {lost.map((entry) => (
        <DecisionCallout
          key={`lost-${entry.approval.id}`}
          approval={entry.approval}
          workflowSlug={
            runsById.get(entry.approval.run_id)
              ? (slugs.get(runsById.get(entry.approval.run_id)!.pipeline_id) ?? null)
              : null
          }
          slugKnown={runs.data !== undefined && pipelines.data !== undefined}
          conflict={entry.conflict}
          onDismiss={() => dismissLost(entry.conflict.approvalId)}
        />
      ))}
      {attention.decisions
        .filter(({ approval }) => !lostIds.has(approval.id))
        .map(({ approval }) => (
          <DecisionCallout
            key={approval.id}
            approval={approval}
            workflowSlug={
              runsById.get(approval.run_id)
                ? (slugs.get(runsById.get(approval.run_id)!.pipeline_id) ?? null)
                : null
            }
            slugKnown={runs.data !== undefined && pipelines.data !== undefined}
            onLost={rememberLost}
          />
        ))}
      {attention.stalled.map(({ run }) => (
        <StoppedRunCallout
          key={run.id}
          run={run}
          workflowSlug={slugs.get(run.pipeline_id) ?? null}
          named={runs.data !== undefined && pipelines.data !== undefined}
        />
      ))}
    </div>
  );
}

/** A row whose decision lost the race: the gate as last seen (for the callout's
 * own header and title) plus the facts its bar reported. */
interface LostDecision {
  approval: Approval;
  conflict: DecisionConflict;
}

/** A gate that is still open — or one the viewer just lost. Deciding is the
 * shared `DecisionBar`: it holds the POST for 5s behind an Undo, sends the
 * row's own `version` as the CAS token, adopts the winner on a `409` and says
 * who beat the click. `initialConflict` is the shape of a lost gate: the bar
 * boots straight into the conflict sentence, with no verbs left to click. */
function DecisionCallout({
  approval,
  workflowSlug,
  slugKnown,
  conflict = null,
  onLost,
  onDismiss,
}: {
  approval: Approval;
  workflowSlug: string | null;
  slugKnown: boolean;
  /** Set when this row is a just-decided-elsewhere gate: the bar renders the
   * sticky conflict sentence and the callout offers a Dismiss. */
  conflict?: DecisionConflict | null;
  onLost?: (approval: Approval, conflict: DecisionConflict) => void;
  onDismiss?: () => void;
}) {
  const key = testidOf(approval.id);
  const meta = [
    slugKnown ? (workflowSlug ?? "workflow unknown") : "…",
    formatAge(approval.created_at),
  ].join(" · ");

  return (
    <Alert
      state="waiting"
      label="NEEDS YOUR DECISION"
      testid={`project-attention-decision-${key}`}
      meta={<BarMeta text={meta} />}
    >
      {/* Body first, actions after: stacked on the phone (the review's 390
          finding), side by side from `md` up (the design's inline actions). */}
      <div className="flex flex-col gap-[8px] md:flex-row md:items-center md:gap-[10px]">
        <div className="min-w-0 flex-1">
          <p
            className={`text-[13.5px] leading-[19px] font-medium ${ATTENTION_TITLE_CLAMP}`}
            title={approval.summary}
          >
            {attentionTitle(approval.summary)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          <Link
            to={routes.approval(approval.id)}
            className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
            data-testid={`project-read-plan-${key}`}
          >
            Read plan
          </Link>
          <DecisionBar
            approval={approval}
            compact
            initialConflict={conflict}
            onConflict={
              onLost && conflict === null
                ? (info: DecisionConflict) => onLost(approval, info)
                : undefined
            }
          />
          {conflict !== null && onDismiss ? (
            <Button
              variant="secondary"
              compact
              data-testid={`project-decision-dismiss-${key}`}
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </Alert>
  );
}

/** A run that stopped and still asks something: a failure (retry), a pause
 * (resume) or a gate that closed without an open decision to make. */
function StoppedRunCallout({
  run,
  workflowSlug,
  named,
}: {
  run: RunSummary;
  workflowSlug: string | null;
  named: boolean;
}) {
  const retry = useRetryRun(run.id);
  const resume = useResumeRun(run.id);
  const [error, setError] = useState<string | null>(null);
  const key = testidOf(run.id);
  const state = stateOf(RUN_STATE[run.status]);
  const target = retryTarget(run.failed_cause);
  const meta = [named ? (workflowSlug ?? "workflow unknown") : "…", formatAge(run.created_at)].join(
    " · ",
  );

  const act = (fn: () => void) => {
    setError(null);
    fn();
  };

  return (
    <Alert
      state={state}
      label={SHORT_WORD[state].toUpperCase()}
      role="alert"
      testid={`project-attention-run-${key}`}
      meta={<BarMeta text={meta} />}
    >
      {/* Same shape as the decision callout: body above actions on the phone,
          inline from `md` up. */}
      <div className="flex flex-col gap-[8px] md:flex-row md:items-center md:gap-[10px]">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-[19px] font-medium">
            {failedCauseInWords(run.failed_cause)}
          </p>
          {error ? (
            <p
              className="mt-[6px] font-mono text-[10.5px] text-st-failed-pale-fg"
              role="alert"
              data-testid={`project-attention-run-error-${key}`}
            >
              × {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          <Link
            to={routes.run(run.id)}
            className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
            data-testid={`project-open-run-${key}`}
          >
            Open run
          </Link>
          {run.status === "failed" ? (
            <Button
              variant="primary"
              compact
              disabled={retry.isPending}
              data-testid={`project-retry-${key}`}
              onClick={() =>
                act(() =>
                  retry.mutate(target ? { node_instance_keys: [target.key] } : {}, {
                    onSuccess: () => setError(null),
                    onError: (err) => {
                      const clash = runConflictOf(err);
                      setError(
                        clash
                          ? `not retriable — the run is ${clash.run_status}`
                          : problemOf(err).detail || problemOf(err).title,
                      );
                    },
                  }),
                )
              }
            >
              {retry.isPending ? "Retrying…" : target ? `Retry from ${target.label}` : "Retry"}
            </Button>
          ) : null}
          {run.status === "paused" ? (
            <Button
              variant="primary"
              compact
              disabled={resume.isPending}
              data-testid={`project-resume-${key}`}
              onClick={() =>
                act(() =>
                  resume.mutate(undefined, {
                    onSuccess: () => setError(null),
                    onError: (err) => setError(problemOf(err).detail || problemOf(err).title),
                  }),
                )
              }
            >
              {resume.isPending ? "Resuming…" : "Resume"}
            </Button>
          ) : null}
        </div>
      </div>
    </Alert>
  );
}
