/**
 * `/inbox` — the org-level attention inbox (design 6a): one prioritized list
 * across every project the caller belongs to, acted on inline.
 *
 * Honesty rules are `pages/ProjectRuns.tsx`'s: the wire carries no run *name*
 * and no approval *title*, so a row shows the gate's `summary`, its
 * `node_instance_key`, the pipeline slug from the library and the short ids the
 * server actually serves. Nothing is invented.
 *
 * 6a's CONVERSATIONS section is deliberately not built: no API route reports a
 * conversation that "needs you", and a section invented from nothing would put
 * data on screen the wire does not carry.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { InitialsBox } from "../components/ds/AppBar";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { RUN_STATE, stateOf } from "../components/ds/states";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../api/approvals";
import { apiFetch, problemOf } from "../api/client";
import { usePipelines } from "../api/pipelines";
import { useRetryRun, runConflictOf } from "../api/runs";
import { queryKeys, useMe, useProjects } from "../api/queries";
import type { Approval, ApprovalList, Project, RunSummary, RunSummaryList } from "../api/types";
import { formatAge, shortId, testidOf } from "../lib/format";

type RunStatus = RunSummary["status"];

const ACTIVE_STATES: readonly RunStatus[] = ["queued", "preparing", "running"];
const STALLED_STATES: readonly RunStatus[] = ["failed", "paused"];

export interface DecisionItem {
  project: Project;
  approval: Approval;
}

export interface RunItem {
  project: Project;
  run: RunSummary;
}

export default function Inbox() {
  const me = useMe();
  const projects = useProjects();
  const pipelines = usePipelines();

  const list = projects.data?.items ?? [];
  const attention = useProjectAttention(list);

  const slugs = useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );

  if (projects.isPending) {
    return (
      <p data-testid="inbox-loading">
        <Spinner label="Reading your projects" />
      </p>
    );
  }
  if (projects.isError) {
    return <ProblemBanner error={projects.error} fallback="Your projects could not be read." />;
  }

  const { decisions, stalled, running, unread } = attention;
  const summary = `Across ${list.length} ${list.length === 1 ? "project" : "projects"}: ${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}, ${stalled.length} stalled ${stalled.length === 1 ? "run" : "runs"}. ${running.length} ${running.length === 1 ? "run is" : "runs are"} going fine.`;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-[22px] leading-[28px] font-semibold" data-testid="inbox-greeting">
          {greeting(new Date(), me.data?.display_name)}
        </h1>
        <p className="text-[13px] text-muted" data-testid="inbox-summary">
          {summary}
        </p>
      </header>

      {unread.length > 0 ? (
        <ul className="space-y-1" data-testid="inbox-unread">
          {unread.map(({ project, title }) => (
            <li key={project.id} className="font-mono text-[10.5px] text-st-failed-tag-fg">
              × {project.name}: {title}
            </li>
          ))}
        </ul>
      ) : null}

      {decisions.length === 0 && stalled.length === 0 && running.length === 0 ? (
        <p className="text-[13px] text-muted" data-testid="inbox-empty">
          Nothing needs you.
        </p>
      ) : null}

      {decisions.length > 0 ? (
        <Panel
          title={`NEEDS YOUR DECISION · ${decisions.length}`}
          headingId="inbox-decisions-heading"
          headingLevel={2}
          state="waiting"
        >
          <div data-testid="inbox-decisions">
            {decisions.map(({ project, approval }) => (
              <DecisionRow key={approval.id} project={project} approval={approval} />
            ))}
          </div>
        </Panel>
      ) : null}

      {stalled.length > 0 ? (
        <Panel
          title={`STALLED · ${stalled.length}`}
          headingId="inbox-stalled-heading"
          headingLevel={2}
        >
          <div data-testid="inbox-stalled">
            {stalled.map(({ project, run }) => (
              <StalledRow key={run.id} project={project} run={run} slugs={slugs} />
            ))}
          </div>
        </Panel>
      ) : null}

      {running.length > 0 ? <RunningStrip items={running} slugs={slugs} /> : null}
    </div>
  );
}

/** "Good morning|afternoon|evening, <first name>" — the wall clock's, not the
 * server's (the wire carries no greeting). */
export function greeting(now: Date, displayName: string | undefined | null): string {
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = displayName?.trim().split(/\s+/)[0];
  return `Good ${part}, ${first || "there"}`;
}

export interface UnreadProject {
  project: Project;
  title: string;
}

export interface Attention {
  decisions: DecisionItem[];
  stalled: RunItem[];
  running: RunItem[];
  unread: UnreadProject[];
}

/**
 * The per-project reads the inbox aggregates. `useQueries` over the caller's
 * dynamic project list rather than a child component per project: the sections
 * are cross-project (a row from one project sorts against a row from another),
 * so the data has to arrive in one place anyway.
 */
function useProjectAttention(projects: Project[]): Attention {
  const gateResults = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.approvals(project.id),
      queryFn: () => apiFetch<ApprovalList>(`/api/v1/projects/${project.id}/approvals`),
    })),
  });
  const runResults = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.runs(project.id),
      queryFn: () => apiFetch<RunSummaryList>(`/api/v1/projects/${project.id}/runs`),
    })),
  });

  return useMemo(() => {
    const decisions: DecisionItem[] = [];
    const stalled: RunItem[] = [];
    const running: RunItem[] = [];
    const unread: UnreadProject[] = [];

    projects.forEach((project, index) => {
      const gates = gateResults[index];
      const runs = runResults[index];
      /** A `waiting_human` run whose gate is still open is a decision, not a
       * stall — the same fact must not be listed twice under two headings. */
      const pendingGates = new Set<string>();

      if (gates?.data) {
        for (const approval of gates.data.approvals) {
          if (approval.state !== "pending") continue;
          pendingGates.add(approval.run_id);
          decisions.push({ project, approval });
        }
      } else if (gates?.isError) {
        unread.push({ project, title: problemOf(gates.error).title });
      }

      if (runs?.data) {
        for (const run of runs.data.runs) {
          if (run.depth !== 0) continue; // children belong to their parent's tree
          if (ACTIVE_STATES.includes(run.status)) running.push({ project, run });
          else if (STALLED_STATES.includes(run.status)) stalled.push({ project, run });
          else if (run.status === "waiting_human" && !pendingGates.has(run.id)) {
            stalled.push({ project, run });
          }
        }
      } else if (runs?.isError) {
        unread.push({ project, title: problemOf(runs.error).title });
      }
    });

    const byAge = (a: RunItem, b: RunItem) => b.run.created_at.localeCompare(a.run.created_at);
    stalled.sort(byAge);
    running.sort(byAge);
    // Oldest gate first: the one closest to its deadline is the one still open.
    decisions.sort((a, b) => a.approval.created_at.localeCompare(b.approval.created_at));
    return { decisions, stalled, running, unread };
  }, [projects, gateResults, runResults]);
}

/**
 * One gate, decided inline. The request shape is `RunInspector`'s: the row's
 * `version` travels back as the CAS token, a `409` adopts the winner rather
 * than overwriting it, and every refusal (403 included) is stated in place.
 */
function DecisionRow({ project, approval }: { project: Project; approval: Approval }) {
  const decide = useDecideApproval(project.id);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const run = shortId(approval.run_id);

  const submit = (decision: "approved" | "rejected") => {
    setError(null);
    decide.mutate(
      { approvalId: approval.id, body: { decision, version: approval.version } },
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
    <div
      className="border-b border-line last:border-b-0"
      data-testid={`inbox-decision-${testidOf(approval.id)}`}
    >
      <div className="flex items-center gap-[10px] px-[10px] py-[8px]">
        <InitialsBox name={project.name} />
        <StatusChip
          state="waiting"
          label="approval"
          labelProps={{ "data-testid": `inbox-decision-tag-${testidOf(approval.id)}` }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold" title={approval.summary}>
            {approval.summary}
          </p>
          <p className="font-mono text-[10.5px] text-muted">
            {project.name} · run {run} · {approval.node_instance_key}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-faint">{formatAge(approval.created_at)}</span>
        <Button
          variant="primary"
          compact
          disabled={decide.isPending}
          data-testid={`inbox-approve-${testidOf(approval.id)}`}
          onClick={() => submit("approved")}
        >
          {decide.isPending ? "Posting…" : "Approve"}
        </Button>
        <Button
          variant="secondary"
          compact
          disabled={decide.isPending}
          data-testid={`inbox-reject-${testidOf(approval.id)}`}
          onClick={() => submit("rejected")}
        >
          Reject
        </Button>
      </div>
      {error ? (
        <p
          className="px-[10px] pb-[8px] font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`inbox-decision-error-${testidOf(approval.id)}`}
        >
          × {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A run that stopped without finishing. The wire carries no run title, so the
 * row names the run by its short id and, when the server gave one, its
 * `failed_cause` — never an invented reason.
 */
function StalledRow({
  project,
  run,
  slugs,
}: {
  project: Project;
  run: RunSummary;
  slugs: ReadonlyMap<string, string>;
}) {
  const retry = useRetryRun(run.id);
  const [error, setError] = useState<string | null>(null);
  const slug = slugs.get(run.pipeline_id);

  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid={`inbox-stalled-${testidOf(run.id)}`}
    >
      <div className="flex items-center gap-[10px] px-[10px] py-[8px]">
        <InitialsBox name={project.name} />
        <StatusChip
          state={stateOf(RUN_STATE[run.status])}
          label={run.status}
          labelProps={{ "data-testid": `inbox-stalled-status-${testidOf(run.id)}` }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">
            Run {shortId(run.id)}
            {run.failed_cause ? ` — ${run.failed_cause}` : ""}
          </p>
          <p className="font-mono text-[10.5px] text-muted">
            {project.name} · {slug ?? `run ${shortId(run.id)}`} · {run.status}
          </p>
        </div>
        <span className="font-mono text-[10.5px] text-faint">{formatAge(run.created_at)}</span>
        <Link
          to={`/projects/${project.id}/runs/${run.id}`}
          className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
          data-testid={`inbox-open-run-${testidOf(run.id)}`}
        >
          Open run
        </Link>
        {run.status === "failed" ? (
          <Button
            variant="secondary"
            compact
            disabled={retry.isPending}
            data-testid={`inbox-retry-${testidOf(run.id)}`}
            onClick={() => {
              setError(null);
              retry.mutate(
                {},
                {
                  onSuccess: () => setError(null),
                  onError: (err) => {
                    const conflict = runConflictOf(err);
                    setError(
                      conflict
                        ? `not retriable — the run is ${conflict.run_status}`
                        : problemOf(err).detail || problemOf(err).title,
                    );
                  },
                },
              );
            }}
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          className="px-[10px] pb-[8px] font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`inbox-retry-error-${testidOf(run.id)}`}
        >
          × {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * PROGRESS-style dashed strip: work that is going fine gets one quiet line
 * rather than a section of rows, because nothing here asks anything of you.
 */
function RunningStrip({
  items,
  slugs,
}: {
  items: readonly RunItem[];
  slugs: ReadonlyMap<string, string>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-[12px] gap-y-[6px] rounded-[3px] border border-dashed border-line-strong bg-surface px-[10px] py-[7px]"
      data-testid="inbox-running"
    >
      <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-faint uppercase">
        running fine · {items.length}
      </span>
      {items.map(({ project, run }) => (
        <span
          key={run.id}
          className="inline-flex items-center gap-[6px] font-mono text-[10.5px] text-ink-2"
          data-testid={`inbox-running-${testidOf(run.id)}`}
        >
          <span aria-hidden="true" className="text-muted">
            {initialsOf(project.name)}
          </span>
          <Link to={`/projects/${project.id}/runs/${run.id}`} className="text-accent-text">
            {shortId(run.id)}
          </Link>
          <span>{slugs.get(run.pipeline_id) ?? "pipeline"}</span>
          <span className="text-muted">{run.status}</span>
        </span>
      ))}
    </div>
  );
}

/** The same two-letter reading `InitialsBox` gives, in inline mono. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
