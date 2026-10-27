/**
 * "Needs your decision" and "failed" callouts (Projects Review design 1b).
 *
 * One callout per item that asks something of a person, in the ALERT pale set:
 * an open gate (Read plan · Approve) or a run that stopped (Open run · Retry
 * from <step>). The list is the inbox's own read (`lib/attention.ts`) narrowed
 * to this project, so a stalled run can never read as fine here and urgent
 * there, and a `waiting_human` run whose gate is still open appears once — as
 * the decision — not twice.
 *
 * Honesty rules are the run pages'. The wire carries no run title and no
 * repository on a run, so a callout names its run by the workflow slug the
 * library serves, its short id and the `failed_cause` the server reported —
 * never an invented sentence about what went wrong.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../../api/approvals";
import { useQueryClient } from "@tanstack/react-query";
import { problemOf } from "../../api/client";
import { usePipelines } from "../../api/pipelines";
import { useProjectRuns } from "../../api/runs";
import { useResumeRun, useRetryRun, runConflictOf } from "../../api/runs";
import { useAttentionForProject } from "../../lib/attention";
import type { Approval, Project, RunSummary } from "../../api/types";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { Spinner } from "../Feedback";
import { RUN_STATE, SHORT_WORD, stateOf } from "../ds/states";
import { ATTENTION_TITLE_CLAMP, attentionTitle } from "../../lib/attention";
import { formatAge, shortId, testidOf } from "../../lib/format";
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
      {!attention.pending && total === 0 ? (
        <p
          className="flex items-center gap-[6px] rounded-[3px] border border-st-done-pale-edge bg-st-done-pale-body px-[12px] py-[8px] text-[13px] text-st-done-pale-fg"
          data-testid="project-attention-empty"
        >
          <span aria-hidden="true">✓</span>
          Nothing needs attention in this project.
        </p>
      ) : null}
      {attention.decisions.map(({ approval }) => (
        <DecisionCallout
          key={approval.id}
          approval={approval}
          workflowSlug={
            runsById.get(approval.run_id)
              ? (slugs.get(runsById.get(approval.run_id)!.pipeline_id) ?? null)
              : null
          }
          slugKnown={runs.data !== undefined && pipelines.data !== undefined}
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

/** A gate that is still open. `Approve` asks first — a gate is a business
 * outcome, not a click — then posts the row's own `version` as the CAS token;
 * a `409` adopts the winner rather than pretending the click was lost. */
function DecisionCallout({
  approval,
  workflowSlug,
  slugKnown,
}: {
  approval: Approval;
  workflowSlug: string | null;
  slugKnown: boolean;
}) {
  const decide = useDecideApproval(approval.project_id);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = testidOf(approval.id);
  const meta = [
    slugKnown ? (workflowSlug ?? "workflow unknown") : "…",
    formatAge(approval.created_at),
  ].join(" · ");

  const submit = () => {
    setConfirming(false);
    setError(null);
    decide.mutate(
      { approvalId: approval.id, body: { decision: "approved", version: approval.version } },
      {
        onSuccess: () => setError(null),
        onError: (err) => {
          if (approvalConflictOf(err)) {
            adoptApprovalConflict(queryClient, err);
            setError("someone decided this gate first — what you see now is the winner's");
          } else {
            setError(problemOf(err).detail || problemOf(err).title);
          }
        },
      },
    );
  };

  return (
    <Alert
      state="waiting"
      label="NEEDS YOUR DECISION"
      testid={`project-attention-decision-${key}`}
      meta={meta}
      action={
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          <Link
            to={routes.approval(approval.id)}
            className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
            data-testid={`project-read-plan-${key}`}
          >
            Read plan
          </Link>
          {confirming ? (
            <>
              <span className="font-mono text-[10.5px] text-st-waiting-pale-fg" role="status">
                approve this gate?
              </span>
              <Button
                variant="primary"
                compact
                disabled={decide.isPending}
                onClick={submit}
                data-testid={`project-approve-confirm-${key}`}
              >
                {decide.isPending ? "Posting…" : "Confirm"}
              </Button>
              <Button
                variant="ghost"
                compact
                data-testid={`project-approve-cancel-${key}`}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              compact
              disabled={decide.isPending}
              onClick={() => setConfirming(true)}
              data-testid={`project-approve-${key}`}
            >
              {decide.isPending ? "Posting…" : "Approve"}
            </Button>
          )}
        </div>
      }
    >
      <p
        className={`text-[13.5px] leading-[19px] font-medium ${ATTENTION_TITLE_CLAMP}`}
        title={approval.summary}
      >
        {attentionTitle(approval.summary)}
      </p>
      <p className="mt-[6px] flex flex-wrap items-center gap-[6px] font-mono text-[10.5px] text-st-waiting-pale-fg">
        <StatusChip
          state="waiting"
          label="approval"
          className="h-[15px]"
          labelProps={{ "data-testid": `project-attention-decision-status-${key}` }}
        />
        <span>
          run #{shortId(approval.run_id)} · {approval.node_instance_key ?? "gate"}
        </span>
      </p>
      {error ? (
        <p
          className="mt-[6px] font-mono text-[10.5px] text-st-failed-pale-fg"
          role="alert"
          data-testid={`project-attention-decision-error-${key}`}
        >
          × {error}
        </p>
      ) : null}
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
      meta={meta}
      action={
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
      }
    >
      <p className="text-[13.5px] leading-[19px] font-medium">
        {failedCauseInWords(run.failed_cause)}
      </p>
      <p className="mt-[6px] flex flex-wrap items-center gap-[6px] font-mono text-[10.5px]">
        <StatusChip
          state={state}
          label={SHORT_WORD[state]}
          className="h-[15px]"
          labelProps={{ "data-testid": `project-attention-run-status-${key}` }}
        />
        <span>run #{shortId(run.id)}</span>
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
    </Alert>
  );
}
