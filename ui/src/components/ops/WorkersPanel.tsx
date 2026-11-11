/**
 * WORKERS — the fleet as it is, not as a pod list.
 *
 * Two rules the old table broke:
 *
 * * A dead worker is not news every reload. A k8s lab accumulates pod names
 *   whose lease long ago expired, and 35 rows of `STATUS: OFFLINE` above the
 *   one live worker hid the fact that the fleet was fine. Online (and
 *   draining) workers are listed; the rest collapse into one honest line that
 *   counts them and gives the last-seen span, expandable on demand.
 * * A name twice is not information. The worker name and its hostname are the
 *   same string in every container deployment, so the hostname prints only
 *   when it differs — where it is a real fact (two names, one box).
 *
 * The status is a dot plus its word at 12px; the chip treatment is gone because
 * 36 chips of the same pale red read as decoration, not as status.
 */
import { useState } from "react";
import { ENFORCEMENT_COPY, workerSandboxState } from "../../api/sandbox";
import type { SchedulerStatus, Worker, WorkerSandboxStatus } from "../../api/types";
import { formatAge, formatTime } from "../../lib/format";
import { OpsError, OpsPanel, OpsSkeleton } from "./OpsPanel";
import { StatusDot, type OpsStatus } from "./StatusDot";

/** One worker's claim capacity, as the scheduler reports it. */
export type SchedulerWorkerLoad = SchedulerStatus["workers"][number];

/** Worker status → the ops dot state (`offline` is a fact, not a finding). */
const WORKER_DOT: Record<Worker["status"], OpsStatus> = {
  online: "ok",
  draining: "warn",
  offline: "off",
};

/** Worker status → the word under the dot (the word IS the status, no "status:" prefix). */
const WORKER_WORD: Record<Worker["status"], string> = {
  online: "online",
  draining: "draining",
  offline: "offline",
};

/** A worker is listed when it is not retired: online and draining still matter. */
function isLive(worker: Worker): boolean {
  return worker.status !== "offline";
}

/**
 * The six columns. The label text is lowercase because it is what a screen
 * reader says (the row is a grid, not a table, so a cell has no header to
 * inherit) and what the phone card prints before its value; the desktop header
 * row uppercases the same words.
 */
const COLUMNS = [
  { key: "name", label: "name" },
  { key: "status", label: "status" },
  { key: "leases", label: "leases" },
  { key: "sandbox", label: "sandbox" },
  { key: "seen", label: "last seen" },
  { key: "version", label: "version" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

/** `8m – 23h ago` over a set of workers: the span the dead ones cover. */
function seenSpan(workers: Worker[], now = Date.now()): string {
  const ages = workers
    .map((worker) => formatAge(worker.last_heartbeat_at, now))
    .filter((age) => age !== "unknown");
  if (ages.length === 0) return "unknown";
  const rank = (age: string) => {
    const value = Number(age.replace(/[^0-9.]/g, ""));
    const unit = age.endsWith("d") ? 86400 : age.endsWith("h") ? 3600 : age.endsWith("m") ? 60 : 1;
    return (Number.isFinite(value) ? value : 0) * unit;
  };
  const sorted = [...ages].sort((a, b) => rank(a) - rank(b));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return first === last ? `${first} ago` : `${first} – ${last} ago`;
}

export interface WorkersPanelProps {
  /** Every registered worker; the panel decides what is listed and what collapses. */
  workers: Worker[];
  pending: boolean;
  error: unknown | null;
  onRetry?: () => void;
  /** Scheduler claim capacity by worker name (the scheduler's own report). */
  loadOf?: (name: string) => SchedulerWorkerLoad | null;
  /** Sandbox verdict by worker id (the fleet sandbox report). */
  sandboxOf?: (workerId: string) => WorkerSandboxStatus | null;
  /** Whether the two side reads have answered, so a `—` means "not reported". */
  sidePending?: boolean;
}

/**
 * One cell's label. Read at every width, seen only under 640px: on desktop the
 * header row already names the column in ink, but the row is a grid, so the
 * cell needs its own words for anyone listening; on phone the row stacks and
 * `status: online` is the only thing holding the card together.
 */
function CellLabel({ column }: { column: ColumnKey }) {
  const found = COLUMNS.find((entry) => entry.key === column)!;
  return (
    <span className="sr-only max-[640px]:not-sr-only max-[640px]:mr-[6px] max-[640px]:font-mono max-[640px]:text-[10.5px] max-[640px]:tracking-[.06em] max-[640px]:text-faint max-[640px]:uppercase">
      {`${found.label}: `}
    </span>
  );
}

export function WorkersPanel({
  workers,
  pending,
  error,
  onRetry,
  loadOf,
  sandboxOf,
  sidePending = false,
}: WorkersPanelProps) {
  const [showOffline, setShowOffline] = useState(false);
  const live = workers.filter(isLive);
  const offline = workers.filter((worker) => !isLive(worker));
  const listed = showOffline ? [...live, ...offline] : live;

  // Draining is neither online nor offline, and the head count that lies about
  // it is the one this page has to get right.
  const onlineCount = workers.filter((worker) => worker.status === "online").length;
  const draining = workers.length - onlineCount - offline.length;
  const meta = [
    `${onlineCount} online`,
    draining > 0 ? `${draining} draining` : null,
    offline.length > 0 ? `${offline.length} offline` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <OpsPanel id="ops-workers" title="Workers" meta={workers.length > 0 ? meta : undefined}>
      {pending ? <OpsSkeleton testid="workers-skeleton" /> : null}
      {error ? (
        <OpsError
          thing="the worker list"
          detail={error === null ? null : String((error as { detail?: string }).detail ?? "")}
          onRetry={onRetry}
          testid="workers-error"
        />
      ) : null}
      {!pending && !error ? (
        workers.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="workers-empty">
            No workers have registered. Start one with{" "}
            <span className="font-mono text-[11.5px] text-ink-2">communication worker</span>.
          </p>
        ) : (
          <>
            {/* Grid rows, not a `<table>`: at phone width the same row has to read
                as `label value` pairs, and a table cannot reflow that far. */}
            <div data-testid="workers-table" className="text-[12.5px]">
              <div className="hidden gap-x-[12px] border-b border-line pb-[4px] font-mono text-[10.5px] font-semibold tracking-[.06em] text-faint uppercase min-[640px]:grid min-[640px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                {COLUMNS.map((column) => (
                  <span key={column.key}>{column.label}</span>
                ))}
              </div>
              <ul className="min-[640px]:block">
                {listed.map((worker) => {
                  const load = loadOf?.(worker.name) ?? null;
                  const verdict = sandboxOf?.(worker.id) ?? null;
                  const muted = !isLive(worker);
                  return (
                    <li
                      key={worker.id}
                      data-testid={`worker-row-${worker.name}`}
                      data-status={worker.status}
                      className={`grid grid-cols-1 items-baseline gap-x-[12px] gap-y-[2px] border-b border-line-soft py-[6px] last:border-b-0 min-[640px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] ${
                        muted ? "text-muted" : "text-ink-2"
                      }`}
                    >
                      <span
                        data-testid={`worker-name-${worker.name}`}
                        className="min-w-0 break-words"
                      >
                        <span className={muted ? "" : "font-semibold text-ink"}>{worker.name}</span>
                        {worker.hostname !== worker.name ? (
                          <span className="block font-mono text-[10.5px] text-muted">
                            {worker.hostname}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-[6px] text-[12px]">
                        <CellLabel column="status" />
                        <StatusDot status={WORKER_DOT[worker.status]} />
                        {WORKER_WORD[worker.status]}
                      </span>
                      <span className="font-mono text-[11.5px]">
                        <CellLabel column="leases" />
                        <span data-testid={`worker-leases-${worker.name}`}>
                          {load
                            ? `${load.active_attempts} / ${load.capacity} active`
                            : sidePending
                              ? "—"
                              : "— not reported"}
                        </span>
                      </span>
                      <span
                        className="flex items-center gap-[6px] font-mono text-[11.5px]"
                        data-testid={`worker-sandbox-${worker.name}`}
                      >
                        <CellLabel column="sandbox" />
                        {verdict ? <SandboxState verdict={verdict} /> : "—"}
                      </span>
                      <span
                        className="font-mono text-[11.5px]"
                        title={formatTime(worker.last_heartbeat_at)}
                      >
                        <CellLabel column="seen" />
                        <span data-testid={`worker-heartbeat-${worker.name}`}>
                          {formatAge(worker.last_heartbeat_at)} ago
                        </span>
                      </span>
                      <span className="font-mono text-[11.5px]">
                        <CellLabel column="version" />
                        {worker.version}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            {offline.length > 0 ? (
              <p className="pt-[8px] text-[12.5px] text-muted" data-testid="workers-offline-line">
                {offline.length} offline {offline.length === 1 ? "worker" : "workers"}, last seen{" "}
                {seenSpan(offline)}
                <button
                  type="button"
                  onClick={() => setShowOffline((current) => !current)}
                  aria-expanded={showOffline}
                  aria-controls="workers-table"
                  className="ml-[6px] text-[12.5px] text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid="workers-offline-toggle"
                >
                  {showOffline ? "Hide" : "Show"}
                </button>
              </p>
            ) : null}
          </>
        )
      ) : null}
    </OpsPanel>
  );
}

/** One worker's sandbox cell: mode + verdict together, never the mode alone. */
function SandboxState({ verdict }: { verdict: WorkerSandboxStatus }) {
  const state = workerSandboxState(verdict);
  const dot: OpsStatus = state === "done" ? "ok" : state === "failed" ? "bad" : "warn";
  const mode = ENFORCEMENT_COPY[verdict.enforcement];
  return (
    <>
      <StatusDot status={dot} />
      <span>
        {verdict.backend} {mode?.word ?? verdict.enforcement} ·{" "}
        {verdict.verified ? "verified" : "unverified"}
      </span>
    </>
  );
}
