/**
 * The 4h "⊘ INTERRUPTED — outcome unknown" callout.
 *
 * It only speaks from data the API actually serves:
 *
 * - runs whose status is `interrupted` (`GET /api/v1/runs?status=interrupted`,
 *   contract C3 / ADR-0047 — a run that stopped without completing, whose
 *   uncommitted edits stayed on the host that ran them); each one names the
 *   project, the workflow, the run and the steps the pinned revision left
 *   unfinished, and offers **Reclaim and retry** on the run's own page.
 * - otherwise `SchedulerStatus.lease_expirations` > 0: the reconciler
 *   observed N attempt leases die mid-flight since this replica started, but
 *   no endpoint lists those attempts by name, so the callout says exactly
 *   that and links to the board instead of inventing rows.
 *
 * Zero interrupted runs and zero lease expirations → nothing renders: empty
 * is healthy, and a stale heartbeat must never fabricate a finding.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { apiFetch, ApiError } from "../../api/client";
import type { CrossProjectRunList } from "../../api/board";
import { Panel } from "../ds/Panel";
import { Spinner, ProblemBanner } from "../Feedback";
import { formatAge, shortId } from "../../lib/format";
import { routes } from "../../lib/routes";

export type InterruptedRun = CrossProjectRunList["runs"][number];

/** Step states that still count as "the plan got here and stopped short". */
const NON_TERMINAL = new Set(["pending", "running", "waiting", "failed"]);

/** One page of the org's interrupted runs is plenty for a callout. */
const INTERRUPTED_QUERY = "/api/v1/runs?status=interrupted&limit=10";
/** `404` = the serving image predates the cross-project runs endpoint: the
 *  run list is "not available yet", not an error state. */
export function useInterruptedRuns() {
  return useQuery({
    queryKey: ["ops", "interrupted-runs"],
    queryFn: async (): Promise<CrossProjectRunList | null> => {
      try {
        return await apiFetch<CrossProjectRunList>(INTERRUPTED_QUERY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** The unfinished top-level steps of a run, definition order, or none. */
export function stalledSteps(run: InterruptedRun): InterruptedRun["steps"] {
  return run.steps.filter((step) => NON_TERMINAL.has(step.state));
}

function RunLine({ run }: { run: InterruptedRun }) {
  const steps = stalledSteps(run);
  return (
    <li className="space-y-1" data-testid={`ops-interrupted-run-${shortId(run.id)}`}>
      <p className="text-[12.5px] text-ink-2">
        <span className="font-semibold">{run.project_name}</span> · {run.pipeline_display_name} —
        run {shortId(run.id)}
        {run.finished_at ? ` (interrupted ${formatAge(run.finished_at)} ago)` : ""}
      </p>
      <p className="font-mono text-[11px] text-ink-2">
        {steps.length === 0
          ? "no top-level step named by the pinned revision"
          : steps.map((step) => `${step.node_id}: ${step.state}`).join(" · ")}
      </p>
      <Link
        to={routes.run(run.id)}
        className="ds-btn ds-btn--primary ds-btn--compact inline-block"
        data-testid={`ops-interrupted-retry-${shortId(run.id)}`}
      >
        Reclaim and retry
      </Link>
    </li>
  );
}

export interface InterruptedCalloutProps {
  /**
   * `SchedulerStatus.lease_expirations` — reconciler-observed lease deaths
   * since this replica started; `null` while the scheduler read is unknown.
   */
  leaseExpirations: number | null;
}

export function InterruptedCallout({ leaseExpirations }: InterruptedCalloutProps) {
  const runs = useInterruptedRuns();
  const named = runs.data?.runs.filter((run) => run.status === "interrupted") ?? [];
  const hasLeaseCount = (leaseExpirations ?? 0) > 0;
  if (named.length === 0 && !hasLeaseCount) return null;

  // The lease-count line, in words: the counter is real, so it is always
  // shown; the run-list clause names exactly what else the data does or
  // does not add (never a fabricated row).
  const leaseClause =
    named.length > 0
      ? ""
      : runs.isPending
        ? " — checking the interrupted runs"
        : runs.data === null
          ? " — the cross-project run list is not served by this server, so no run names them"
          : runs.error
            ? " — the interrupted-run list could not be read"
            : " — no run is left in the interrupted state, so no run names them";

  return (
    <Panel
      title="INTERRUPTED — OUTCOME UNKNOWN"
      headingLevel={2}
      state="interrupted"
      meta={named.length > 0 ? `${named.length} run(s) stopped short` : undefined}
    >
      <div className="p-[10px]" data-testid="ops-interrupted">
        {named.length > 0 ? (
          <ul className="space-y-3">
            {named.slice(0, 5).map((run) => (
              <RunLine key={run.id} run={run} />
            ))}
            {named.length > 5 ? (
              <li className="text-[12.5px] text-muted">
                … and {named.length - 5} more on the{" "}
                <Link to={routes.board()} className="underline">
                  board
                </Link>
              </li>
            ) : null}
          </ul>
        ) : runs.isPending ? (
          <Spinner label="Loading interrupted runs" />
        ) : runs.error ? (
          <ProblemBanner
            error={runs.error}
            fallback="The interrupted-run list could not be read."
            testid="ops-interrupted-error"
          />
        ) : null}
        {hasLeaseCount ? (
          <p className="mt-2 font-mono text-[11px] text-ink-2" data-testid="ops-interrupted-leases">
            ⊘ {leaseExpirations} lease expiration(s) since replica start — each one is a node
            attempt the reconciler observed die mid-flight
            {leaseClause}; see the{" "}
            <Link to={routes.board()} className="underline">
              board
            </Link>
          </p>
        ) : null}
        <p className="mt-2 text-[12.5px] text-ink-2">
          An interrupted attempt's uncommitted edits stayed on the host that ran it; reclaiming
          re-queues the attempt and retry re-runs it.
        </p>
      </div>
    </Panel>
  );
}
