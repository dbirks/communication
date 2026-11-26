/**
 * Manage → Runners (redesign R7): the machines that execute agent work.
 *
 * The facts are exactly the ones Settings → Operations showed for the fleet
 * (`components/ops/WorkersPanel`): the worker's own name, where it is (the
 * hostname when it differs from the name, otherwise the build it runs — the
 * wire carries no pool or label list), its status in the app's own words and
 * glyphs, and its claim capacity as the scheduler reports it. The old panel
 * also carried the sandbox verdict per worker; the sandbox story is the
 * fleet's own surface (`components/Sandbox.tsx`, fed by
 * `GET /system/sandbox`) and is not this table's column, so it is not
 * duplicated here — what is not read here is not claimed here.
 *
 * "USED BY" prints `—`: no read connects a worker to the projects or runs it
 * serves (the scheduler answers capacity per worker, the run summary answers
 * the affinity worker's *id*, and nothing joins them), so the column says so
 * instead of guessing.
 *
 * Below the table the two reads that explain a stall stay where Operations
 * body had them: the `⊘ INTERRUPTED` callout (driven by
 * `SchedulerStatus.lease_expirations` plus the cross-project interrupted-run
 * list) and the launcher capability matrix, whose cells are probe results.
 * The queue/model tiles of Operations do not belong to Runners: the queue is
 * engine telemetry the redesign shows nowhere else yet, and models moved to
 * Agents & models (CONTRACT "What happens to the old app").
 */
import { useWorkers } from "../../api/queries";
import { useSystemScheduler } from "../../api/runs";
import type { SchedulerStatus, Worker } from "../../api/types";
import { useReplicaName } from "../../api/replica";
import { OperationsBody } from "../../components/ops/OperationsBody";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { STATES } from "../../components/ds/states";
import { ManageTable, SectionHeader, SectionLabel } from "./ManageTable";
import type { ManageColumn, ManageRow } from "./ManageTable";

/** Worker status → the glyph + word pair the design assigns it. */
const STATUS_GLYPH: Record<Worker["status"], string> = {
  online: STATES.done.glyph,
  draining: STATES.waiting.glyph,
  offline: STATES.interrupted.glyph,
};

/** Worker status → the state colour the glyph + word is drawn in. */
const STATUS_CLASS: Record<Worker["status"], string> = {
  online: STATES.done.tagFg,
  draining: STATES.waiting.tagFg,
  offline: "text-muted",
};

/** One worker's claim capacity, as the scheduler reports it. */
type SchedulerWorkerLoad = SchedulerStatus["workers"][number];

const COLUMNS: ManageColumn[] = [
  { key: "name", label: "Name" },
  { key: "where", label: "Where" },
  { key: "status", label: "Status" },
  { key: "busy", label: "Busy" },
  { key: "usedBy", label: "Used by" },
];

/** Where the worker runs: the hostname when it is a second name, else the
 * build it runs. The wire has no pool/label field to prefer over them. */
function whereText(worker: Worker): string {
  return worker.hostname !== worker.name ? worker.hostname : worker.version;
}

/** `{active} of {capacity}` claims, or the honest `—` while the scheduler has
 * not answered / does not list this worker. */
function busyText(load: SchedulerWorkerLoad | null, pending: boolean): string {
  if (!load) return pending ? "…" : "—";
  return `${load.active_attempts} of ${load.capacity}`;
}

export default function RunnersSection() {
  const workers = useWorkers();
  const scheduler = useSystemScheduler();

  const items = workers.data?.items ?? [];
  const loadFor = (name: string): SchedulerWorkerLoad | null =>
    scheduler.data?.workers.find((entry) => entry.name === name) ?? null;

  const rows: ManageRow[] = items.map((worker) => ({
    id: worker.id,
    cells: {
      name: (
        <span className="font-mono" data-testid={`runner-name-${worker.name}`}>
          {worker.name}
          {worker.hostname !== worker.name ? null : (
            <span className="ml-[6px] font-sans text-[11.5px] font-normal text-muted">
              same host
            </span>
          )}
        </span>
      ),
      where: (
        <span className="font-mono text-[12px]" title={`version ${worker.version}`}>
          {whereText(worker)}
        </span>
      ),
      status: (
        <span
          className={`inline-flex items-center gap-[5px] font-mono text-[11.5px] font-semibold ${STATUS_CLASS[worker.status]}`}
          data-testid={`runner-status-${worker.name}`}
        >
          <span aria-hidden="true">{`${STATUS_GLYPH[worker.status]} `}</span>
          {worker.status}
        </span>
      ),
      busy: (
        <span className="font-mono text-[12px]" data-testid={`runner-busy-${worker.name}`}>
          {busyText(loadFor(worker.name), scheduler.isPending)}
        </span>
      ),
      usedBy: (
        <span className="text-muted" data-testid={`runner-used-${worker.name}`}>
          —
        </span>
      ),
    },
  }));

  const replica = useReplicaName();
  return (
    <div className="flex flex-col gap-[18px]" data-testid="manage-runners">
      {/* No org-admin gate: `GET /api/v1/workers` and
        `GET /api/v1/system/scheduler` are session-only by contract, which is
        what OperationsBody relied on as well — its one admin decision was the
        ModelsPanel's secret labels, and models are Agents & models now. */}
      <SectionHeader title="Runners" blurb="Machines that run agents and workflows." />

      {workers.isPending ? <Spinner label="Loading runners" /> : null}
      {workers.error ? (
        <ProblemBanner
          error={workers.error}
          fallback="The worker list could not be loaded."
          subject="the fleet"
          retry={{ onClick: () => void workers.refetch(), pending: workers.isFetching }}
        />
      ) : null}

      <ManageTable
        columns={COLUMNS}
        rows={rows}
        empty="No runners have registered. Start one with communication worker."
        testid="manage-runners-table"
      />

      {/* The rest of what Operations showed: health, the queue, the sandbox
        verdicts, what each agent can do, identity & storage, about. */}
      <div>
        <SectionLabel testid="manage-runners-server-label">This server</SectionLabel>
        {/* Which API replica answered the last request (it came off the old
          Settings page with the rest of this surface). */}
        <p className="mb-[10px] font-mono text-[11px] text-muted" data-testid="replica-badge">
          replica: {replica}
        </p>
        <OperationsBody embedded />
      </div>
    </div>
  );
}
