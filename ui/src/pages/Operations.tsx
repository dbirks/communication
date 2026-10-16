import { problemOf } from "../api/client";
import { useHealth, useReadiness, useWorkers } from "../api/queries";
import { useSystemScheduler } from "../api/runs";
import { shortId } from "../lib/format";
import { SandboxHealthPanel } from "../components/Sandbox";
import { Spinner } from "../components/Feedback";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { WORKER_STATE, stateOf, type StateName } from "../components/ds/states";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export interface StatusCardProps {
  testid: string;
  title: string;
  status: string;
  ok: boolean;
  rows: Array<[string, string]>;
  detail?: string;
}

/**
 * Health/readiness card (CARD-L). The status is always written out as text;
 * the title bar only takes the failed state's strong color when the answer is
 * bad — a healthy panel stays gray (rule: bars mean "needs action").
 */
function StatusCard({ testid, title, status, ok, rows, detail }: StatusCardProps) {
  const state: StateName = ok ? "done" : "failed";
  return (
    <div data-testid={testid}>
      <Panel
        title={title.toUpperCase()}
        headingLevel={3}
        state={ok ? undefined : state}
        meta={<StatusChip state={state} label={status} className="h-[15px] normal-case" />}
      >
        <div className="p-[10px]">
          {detail ? <p className="font-mono text-[11px] text-st-failed-tag-fg">{detail}</p> : null}
          <dl className="space-y-1 font-mono text-[11px] text-ink-2">
            {rows.map(([term, value]) => (
              <div key={term} className="flex gap-2">
                <dt className="text-muted">{term}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Panel>
    </div>
  );
}

/** Age of the oldest queued attempt in human units; null means the queue is empty. */
function formatAgeSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "queue empty";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export interface SchedulerPanelProps {
  scheduler: ReturnType<typeof useSystemScheduler>;
}

/**
 * Scheduler telemetry (`docs/m4-contract.md` § 6.2 via `SchedulerStatus`), plus
 * the two honest sentences W7/C13f demand: unbindable runs are *waiting for its
 * worker*, and CPU/memory/disk limits are not implemented at all.
 */
export function SchedulerPanel({ scheduler }: SchedulerPanelProps) {
  const problem = scheduler.error ? problemOf(scheduler.error) : null;
  const status = scheduler.data;
  const counters: Array<[string, string, string]> = status
    ? [
        ["attempts queued", String(status.attempts_by_status.queued), "scheduler-attempts-queued"],
        ["attempts leased", String(status.attempts_by_status.leased), "scheduler-attempts-leased"],
        [
          "attempts running",
          String(status.attempts_by_status.running),
          "scheduler-attempts-running",
        ],
        ["lease expirations", String(status.lease_expirations), "scheduler-lease-expirations"],
        ["max retry loop depth", String(status.max_retry_loop_depth), "scheduler-max-retry-depth"],
        [
          "oldest queued age",
          formatAgeSeconds(status.oldest_queued_age_seconds),
          "scheduler-oldest-queued",
        ],
        ["waiting approvals", String(status.waiting_approvals), "scheduler-waiting-approvals"],
        [
          "queued unbindable runs",
          String(status.queued_unbindable_runs),
          "scheduler-queued-unbindable",
        ],
      ]
    : [];

  return (
    <Panel
      title="SCHEDULER"
      headingLevel={2}
      meta={status ? `${status.workers.length} worker(s) reporting` : undefined}
    >
      <div className="p-[10px]">
        {scheduler.isPending ? <Spinner label="Loading scheduler" /> : null}
        {problem ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            role="alert"
            data-testid="scheduler-unavailable"
          >
            × {problem.detail || "Scheduler status could not be loaded."}
          </p>
        ) : null}
        {status ? (
          <>
            <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
              {counters.map(([term, value, testid]) => (
                <div key={term} className="flex gap-2" data-testid={testid}>
                  <dt className="text-muted">{term}</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {status.queued_unbindable_runs > 0 ? (
              <p className="pt-2 text-[12.5px] text-ink-2" data-testid="scheduler-unbindable-note">
                {status.queued_unbindable_runs} run(s) waiting for its worker — the worker that
                holds its workspace is offline, draining or full
              </p>
            ) : null}
            <p className="pt-2 text-[12.5px] text-muted" data-testid="scheduler-no-resource-limits">
              Resource limits (CPU, memory, disk): not implemented — nothing is silently capped.
            </p>
            {status.workers.length === 0 ? (
              <p className="pt-2 text-[12.5px] text-muted">No worker load reported</p>
            ) : (
              <table
                className="w-full border-collapse pt-2 text-[12.5px]"
                data-testid="scheduler-workers-table"
              >
                <caption className="sr-only">Per-worker claim capacity</caption>
                <thead>
                  <tr className="border-b border-line-strong text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                    <th scope="col" className="py-1 pr-4">
                      Worker
                    </th>
                    <th scope="col" className="py-1">
                      Active attempts / capacity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {status.workers.map((worker) => (
                    <tr
                      key={worker.worker_id}
                      data-testid={`scheduler-worker-row-${worker.name}`}
                      className="border-b border-line-soft last:border-b-0"
                    >
                      <td className="py-[5px] pr-4 font-semibold">{worker.name}</td>
                      <td className="py-[5px] font-mono text-[11px]">
                        {worker.active_attempts} / {worker.capacity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export default function Operations() {
  const health = useHealth();
  const readiness = useReadiness();
  const workers = useWorkers();
  const scheduler = useSystemScheduler();
  // Worker rows are keyed by name in `workers-table`; the sandbox panel registers
  // by id, so the two surfaces agree on one label instead of one of them showing
  // a uuid.
  const nameOfWorker = (workerId: string) =>
    workers.data?.items.find((worker) => worker.id === workerId)?.name ?? shortId(workerId);

  const healthProblem = health.error ? problemOf(health.error) : null;
  const readinessProblem = readiness.error ? problemOf(readiness.error) : null;

  return (
    <section aria-labelledby="ops-heading" className="space-y-4">
      <h1 id="ops-heading" className="text-title-l font-bold">
        Operations
      </h1>
      <p className="text-[12.5px] text-muted">
        Each request lands on whichever API replica the load balancer chose; the replica badge in
        the footer shows which one answered last.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {health.isPending ? <Spinner label="Checking health" /> : null}
        {health.data ? (
          <StatusCard
            testid="health-card"
            title="Health"
            status={`status: ${health.data.status}`}
            ok={health.data.status === "ok"}
            rows={[
              ["replica", health.data.replica],
              ["version", health.data.version],
            ]}
          />
        ) : healthProblem ? (
          <StatusCard
            testid="health-card"
            title="Health"
            status="status: unreachable"
            ok={false}
            rows={[]}
            detail={`${healthProblem.title}${healthProblem.detail ? `: ${healthProblem.detail}` : ""}`}
          />
        ) : null}

        {readiness.isPending ? <Spinner label="Checking readiness" /> : null}
        {readiness.data ? (
          <StatusCard
            testid="readiness-card"
            title="Readiness"
            status={`status: ${readiness.data.status}`}
            ok={readiness.data.status === "ready"}
            rows={[
              ["schema version", String(readiness.data.schema_version)],
              ["expected", String(readiness.data.expected_schema_version)],
            ]}
          />
        ) : readinessProblem ? (
          <StatusCard
            testid="readiness-card"
            title="Readiness"
            status="status: not ready"
            ok={false}
            rows={[]}
            detail={`${readinessProblem.title}${readinessProblem.detail ? `: ${readinessProblem.detail}` : ""}`}
          />
        ) : null}
      </div>

      <Panel
        title="WORKERS"
        headingLevel={2}
        meta={workers.data ? `${workers.data.items.length} registered` : undefined}
      >
        <div className="p-[10px]">
          {workers.isPending ? <Spinner label="Loading workers" /> : null}
          {workers.error ? (
            <p className="font-mono text-[11px] text-st-failed-tag-fg" role="alert">
              × {problemOf(workers.error).detail || "Workers could not be loaded."}
            </p>
          ) : null}
          {workers.data ? (
            workers.data.items.length === 0 ? (
              <p className="text-[12.5px] text-muted">No workers registered</p>
            ) : (
              <table className="w-full border-collapse text-[12.5px]" data-testid="workers-table">
                <caption className="sr-only">Registered execution workers</caption>
                <thead>
                  <tr className="border-b border-line-strong text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                    <th scope="col" className="py-1 pr-4">
                      Name
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Hostname
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Version
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Status
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      Started
                    </th>
                    <th scope="col" className="py-1">
                      Last heartbeat
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {workers.data.items.map((worker) => (
                    <tr
                      key={worker.id}
                      data-testid={`worker-row-${worker.name}`}
                      className="border-b border-line-soft last:border-b-0"
                    >
                      <td className="py-[5px] pr-4 font-semibold">{worker.name}</td>
                      <td className="py-[5px] pr-4 font-mono text-[11px]">{worker.hostname}</td>
                      <td className="py-[5px] pr-4 font-mono text-[11px]">{worker.version}</td>
                      <td className="py-[5px] pr-4">
                        <StatusChip
                          state={stateOf(WORKER_STATE[worker.status])}
                          label={`status: ${worker.status}`}
                        />
                      </td>
                      <td className="py-[5px] pr-4 font-mono text-[11px]">
                        {formatTime(worker.started_at)}
                      </td>
                      <td className="py-[5px] font-mono text-[11px]">
                        {formatTime(worker.last_heartbeat_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
        </div>
      </Panel>

      <SchedulerPanel scheduler={scheduler} />

      {/* M3: the fleet's sandbox verdict. A worker that never verified, or that
          registered `permissive-dev`/`disabled`, is a finding an operator must
          see without reading worker logs (`05`, ADR-0019 D5). */}
      <SandboxHealthPanel nameOf={nameOfWorker} />
    </section>
  );
}
