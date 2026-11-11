/**
 * The Operations surface (Settings → Operations).
 *
 * The page answers one question in the first screenful: *is anything broken,
 * and where do I look?* So it leads with a single line, then six tiles — health,
 * workers, queue, approvals, sandbox, models — each a button that walks the
 * reader to the panel that explains it. Below sit the panels, in the order a
 * person diagnoses a stall: who is here, what is waiting, what the app can ask a
 * model, what the sandbox proved, what the agents can do, who signs in, and
 * which build this is.
 *
 * What it deliberately does not do:
 * * list every worker pod that ever registered (the offline ones collapse behind
 *   one counted line — `WorkersPanel`),
 * * claim a capability no read showed (a missing read is `—` / `couldn't load`,
 *   and `api/sandbox.ts` owns the wording of an unverified sandbox),
 * * say "all systems normal" while a read is still in flight.
 *
 * It renders no `<h1>` of its own: the Settings page owns the heading, and this
 * body's sections are its `h2`s. The legacy `/ops` URL redirects here.
 */
import { problemOf } from "../../api/client";
import {
  useHealth,
  useMe,
  useReadiness,
  useWorkers,
  useSystemSandbox,
  useSystemOverview,
} from "../../api/queries";
import { useSystemScheduler } from "../../api/runs";
import type { Health, Readiness, Worker, WorkerSandboxStatus } from "../../api/types";
import {
  ENFORCEMENT_COPY,
  shortVolume,
  systemIntegrity,
  UNKNOWN_VOLUME_WARNING,
  workerSandboxCopy,
  workerSandboxState,
} from "../../api/sandbox";
import { formatAge, formatTime, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";
import { Link } from "react-router";
import { CapabilityMatrix } from "./CapabilityMatrix";
import { InterruptedCallout } from "./InterruptedCallout";
import { ModelsPanel, appModels } from "./ModelsPanel";
import type { ModelKind, SystemOverview } from "../../api/overview";
import { OpsError, OpsPanel, OpsSkeleton } from "./OpsPanel";
import { StatTile } from "./StatTile";
import { StatusDot, type OpsStatus } from "./StatusDot";
import { WorkersPanel, type SchedulerWorkerLoad } from "./WorkersPanel";

/* ------------------------------------------------------------ tile rules */

/** A tile's three lines plus the state that colours its dot. */
interface Tile {
  label: string;
  value: string;
  sub: string;
  status: OpsStatus;
  target: string;
}

/** Oldest queued age in seconds → the tile's warn/bad line (5m, 30m). */
const QUEUE_WARN_SECONDS = 300;
const QUEUE_BAD_SECONDS = 1800;

/** `queue empty` for an empty queue, else `4m` / `2h` — the tile's age word. */
function ageWords(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

type Read<T> = { data?: T; error: unknown; isPending: boolean };

/**
 * The HEALTH tile says two things at once: the replica answered (`health`) and
 * its database is current (`readiness`). Either answer missing is `NOT OK` — a
 * replica that cannot say it is migrated is not a replica to trust the rest of
 * this page about.
 */
function healthTile(health: Read<Health>, readiness: Read<Readiness>): Tile {
  const replica = health.data?.replica ?? "";
  const schema =
    readiness.data === undefined
      ? "schema —"
      : `schema ${readiness.data.schema_version} of ${readiness.data.expected_schema_version}`;
  const sub = replica === "" ? schema : `${schema} · replica …${replica.slice(-5)}`;
  if (health.isPending || readiness.isPending) {
    return { label: "Health", value: "—", sub: "loading…", status: "off", target: "ops-about" };
  }
  const ok = health.data?.status === "ok" && readiness.data?.status === "ready";
  return {
    label: "Health",
    value: ok ? "OK" : "NOT OK",
    sub: health.error || readiness.error ? "couldn't load" : sub,
    status: ok ? "ok" : "bad",
    target: "ops-about",
  };
}

function workerTile(workers: Worker[], schedulerLoads: SchedulerWorkerLoad[] | null): Tile {
  const online = workers.filter((worker) => worker.status === "online");
  const slots = schedulerLoads?.reduce((sum, load) => sum + load.capacity, 0) ?? null;
  const busy = schedulerLoads?.reduce((sum, load) => sum + load.active_attempts, 0) ?? null;
  const sub =
    slots === null || busy === null ? "no capacity reported" : `${slots} slots · ${busy} busy`;
  return {
    label: "Workers",
    value: `${online.length} online`,
    sub,
    status: online.length > 0 ? "ok" : "bad",
    target: "ops-workers",
  };
}

function queueTile(
  queued: number | null,
  oldest: number | null,
  unbindable: number | null,
  failed: boolean,
): Tile {
  if (failed) {
    return {
      label: "Queue",
      value: "—",
      sub: "couldn't load",
      status: "bad",
      target: "ops-queue",
    };
  }
  if (queued === null) {
    return { label: "Queue", value: "—", sub: "loading…", status: "off", target: "ops-queue" };
  }
  const status: OpsStatus =
    unbindable !== null && unbindable > 0
      ? "bad"
      : oldest !== null && oldest > QUEUE_BAD_SECONDS
        ? "bad"
        : oldest !== null && oldest > QUEUE_WARN_SECONDS
          ? "warn"
          : "ok";
  return {
    label: "Queue",
    value: `${queued} queued`,
    sub: `oldest ${ageWords(oldest)}`,
    status,
    target: "ops-queue",
  };
}

function approvalTile(waiting: number | null, failed: boolean): Tile {
  if (failed) {
    return {
      label: "Approvals",
      value: "—",
      sub: "couldn't load",
      status: "bad",
      target: "ops-queue",
    };
  }
  if (waiting === null) {
    return {
      label: "Approvals",
      value: "—",
      sub: "loading…",
      status: "off",
      target: "ops-queue",
    };
  }
  return {
    label: "Approvals",
    value: `${waiting} waiting`,
    sub: waiting === 1 ? "on someone" : "on anyone",
    status: waiting > 0 ? "warn" : "ok",
    target: "ops-queue",
  };
}

/**
 * The fleet sandbox tile: `required · verified` is only said when every ONLINE
 * worker's own row says it (`05`, ADR-0019 D5). No worker online means no
 * verified launch anywhere, which is a finding, not an empty box.
 */
function sandboxTile(
  workers: Worker[],
  online: Worker[],
  verdicts: WorkerSandboxStatus[],
  pinned: string | null,
  pending: boolean,
): Tile {
  const value = pinned ? `nono ${pinned}` : "nono —";
  if (pending) {
    return { label: "Sandbox", value, sub: "loading…", status: "off", target: "ops-sandbox" };
  }
  if (online.length === 0 || verdicts.length === 0) {
    return {
      label: "Sandbox",
      value,
      sub: workers.length === 0 ? "no worker registered" : "no online worker verified",
      status: "bad",
      target: "ops-sandbox",
    };
  }
  const allVerified = online.every((worker) => {
    const verdict = verdicts.find((entry) => entry.worker_id === worker.id);
    return verdict !== undefined && verdict.verified && verdict.enforcement === "required";
  });
  const first = verdicts[0]!;
  const mode = ENFORCEMENT_COPY[first.enforcement];
  return {
    label: "Sandbox",
    value,
    sub: `${mode?.word ?? first.enforcement} · ${allVerified ? "verified" : "unverified"}`,
    status: allVerified ? "ok" : "bad",
    target: "ops-sandbox",
  };
}

function modelTile(
  models: { kind: ModelKind | string; configured: boolean }[],
  pending: boolean,
  failed: boolean,
  served: boolean,
): Tile {
  if (pending) {
    return { label: "Models", value: "—", sub: "loading…", status: "off", target: "ops-models" };
  }
  if (failed) {
    return {
      label: "Models",
      value: "—",
      sub: "couldn't load",
      status: "bad",
      target: "ops-models",
    };
  }
  if (!served) {
    return {
      label: "Models",
      value: "—",
      sub: "not reported",
      status: "off",
      target: "ops-models",
    };
  }
  const configured = models.filter((model) => model.configured);
  const assistant = models.find((model) => model.kind === "assistant");
  const status: OpsStatus =
    assistant && assistant.configured
      ? configured.length === models.length
        ? "ok"
        : "warn"
      : "bad";
  return {
    label: "Models",
    value: `${configured.length} of ${models.length}`,
    sub:
      configured.length === 0
        ? "none configured"
        : configured.map((model) => String(model.kind)).join(" · "),
    status,
    target: "ops-models",
  };
}

/* ------------------------------------------------------------- read shape */

/**
 * The lead line: one sentence, derived from the tiles it sits above. It says
 * nothing while a read is in flight (a page cannot know it is healthy yet), and
 * counts the tiles that are not `ok` — including a tile that could not load,
 * because "we cannot see" is exactly what needs attention.
 */
function leadLine(tiles: Tile[], pendingCount: number): string {
  if (pendingCount > 0 && tiles.every((tile) => tile.status === "off")) return "Loading…";
  const needing = tiles.filter((tile) => tile.status === "warn" || tile.status === "bad").length;
  return needing === 0
    ? "All systems normal."
    : `${needing} ${needing === 1 ? "thing" : "things"} need${needing === 1 ? "s" : ""} attention.`;
}

/* ---------------------------------------------------------------- page */

/**
 * The Operations surface: a lead line, six tiles, and the panels they walk to —
 * workers, queue, models, sandbox, agents, identity & storage, about.
 */
export function OperationsBody() {
  const health = useHealth();
  const readiness = useReadiness();
  const workers = useWorkers();
  const scheduler = useSystemScheduler();
  const sandbox = useSystemSandbox();
  const overview = useSystemOverview();
  const me = useMe();

  const registered = workers.data?.items ?? [];
  const online = registered.filter(
    (worker) => worker.status === "online" || worker.status === "draining",
  );
  const loadOf = (name: string): SchedulerWorkerLoad | null =>
    scheduler.data?.workers.find((entry) => entry.name === name) ?? null;
  const verdictOf = (workerId: string): WorkerSandboxStatus | null =>
    sandbox.data?.workers.find((entry) => entry.worker_id === workerId) ?? null;
  const nameOfWorker = (workerId: string) =>
    registered.find((worker) => worker.id === workerId)?.name ?? testidOf(workerId);

  const models = appModels(overview.data);
  const tiles: Tile[] = [
    healthTile(health, readiness),
    workerTile(registered, scheduler.data?.workers ?? null),
    queueTile(
      scheduler.data ? scheduler.data.attempts_by_status.queued : null,
      scheduler.data?.oldest_queued_age_seconds ?? null,
      scheduler.data?.queued_unbindable_runs ?? null,
      Boolean(scheduler.error),
    ),
    approvalTile(
      scheduler.data ? scheduler.data.waiting_approvals : null,
      Boolean(scheduler.error),
    ),
    sandboxTile(
      registered,
      online,
      sandbox.data?.workers ?? [],
      sandbox.data?.pinned_backend_version ?? null,
      sandbox.isPending,
    ),
    modelTile(models, overview.isPending, Boolean(overview.error), overview.data !== null),
  ];
  const pendingCount = [health, readiness, workers, scheduler, sandbox, overview].filter(
    (read) => read.isPending,
  ).length;

  return (
    <section aria-label="Operations" className="max-w-[1120px] space-y-4">
      <p className="text-[13px] text-muted" data-testid="ops-health-line">
        {leadLine(tiles, pendingCount)}
      </p>

      <div
        className="grid grid-cols-2 gap-[8px] min-[640px]:grid-cols-3 min-[1100px]:grid-cols-6"
        data-testid="ops-stat-strip"
      >
        {tiles.map((tile) => (
          <StatTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            sub={tile.sub}
            status={tile.status}
            targetId={tile.target}
            ariaValue={tile.value}
          />
        ))}
      </div>

      <InterruptedCallout leaseExpirations={scheduler.data?.lease_expirations ?? null} />

      <WorkersPanel
        workers={registered}
        pending={workers.isPending}
        error={workers.error}
        onRetry={() => void workers.refetch()}
        loadOf={loadOf}
        sandboxOf={verdictOf}
        sidePending={scheduler.isPending || sandbox.isPending}
      />

      <QueuePanel scheduler={scheduler} />

      <ModelsPanel
        overview={overview.data ?? null}
        pending={overview.isPending}
        error={overview.error}
        onRetry={() => void overview.refetch()}
        isAdmin={me.data?.is_org_admin === true}
      />

      <SandboxPanel
        sandbox={sandbox}
        online={online}
        nameOf={nameOfWorker}
        onlineIds={new Set(online.map((worker) => worker.id))}
      />

      {/* The matrix keeps its own panel and its own footnote — every cell is a
          probe result or an honest `not tested` — so this section is the anchor
          the tiles and the outline need, not a second frame around it. */}
      <section id="ops-agents" aria-label="Agents" data-testid="ops-agents">
        <CapabilityMatrix />
      </section>

      <IdentityStoragePanel overview={overview} />

      <AboutPanel health={health} readiness={readiness} overview={overview} />
    </section>
  );
}

/* --------------------------------------------------------------- queue */

export interface QueuePanelProps {
  scheduler: ReturnType<typeof useSystemScheduler>;
}

/**
 * QUEUE (`ops-queue`): the engine's own counters, the load each worker reports,
 * and the honest sentence C13f demands about resource limits. A `404` is the
 * serving image predating the endpoint — `couldn't load`, not an empty queue.
 */
export function QueuePanel({ scheduler }: QueuePanelProps) {
  const status = scheduler.data;
  const counters: Array<[string, number | string, string]> = status
    ? [
        ["queued", status.attempts_by_status.queued, "scheduler-attempts-queued"],
        ["running", status.attempts_by_status.running, "scheduler-attempts-running"],
        ["leased", status.attempts_by_status.leased, "scheduler-attempts-leased"],
        ["waiting approvals", status.waiting_approvals, "scheduler-waiting-approvals"],
        ["oldest queued", ageWords(status.oldest_queued_age_seconds), "scheduler-oldest-queued"],
        ["lease expirations", status.lease_expirations, "scheduler-lease-expirations"],
        ["retry depth", status.max_retry_loop_depth, "scheduler-max-retry-depth"],
        ["unbindable runs", status.queued_unbindable_runs, "scheduler-queued-unbindable"],
      ]
    : [];

  return (
    <OpsPanel
      id="ops-queue"
      title="Queue"
      meta={
        status
          ? `${status.workers.length} ${status.workers.length === 1 ? "worker" : "workers"} reporting`
          : undefined
      }
    >
      {scheduler.isPending ? <OpsSkeleton testid="queue-skeleton" /> : null}
      {scheduler.error ? (
        <OpsError
          thing="the queue"
          detail={problemOf(scheduler.error).detail}
          onRetry={() => void scheduler.refetch()}
          testid="scheduler-unavailable"
        />
      ) : null}
      {status ? (
        <>
          <dl className="grid grid-cols-2 gap-x-[16px] gap-y-[10px] min-[640px]:grid-cols-4">
            {counters.map(([term, value, testid]) => (
              <div key={term} data-testid={testid}>
                <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
                  {term}
                </dt>
                <dd className="text-[13px] text-ink">{String(value)}</dd>
              </div>
            ))}
          </dl>
          {status.queued_unbindable_runs > 0 ? (
            <p
              className="pt-[10px] text-[12.5px] text-ink-2"
              data-testid="scheduler-unbindable-note"
            >
              {status.queued_unbindable_runs} run(s) waiting for its worker — the worker that holds
              its workspace is offline, draining or full
            </p>
          ) : null}
          {status.workers.length === 0 ? (
            <p className="pt-[10px] text-[12.5px] text-muted">No worker load reported</p>
          ) : (
            <div className="pt-[10px]" data-testid="scheduler-workers-table">
              <div className="flex gap-x-[12px] border-b border-line pb-[4px] font-mono text-[10.5px] font-semibold tracking-[.06em] text-faint uppercase">
                <span className="min-w-0 flex-1">Worker</span>
                <span>Active / capacity</span>
              </div>
              <ul>
                {status.workers.map((worker) => (
                  <li
                    key={worker.worker_id}
                    data-testid={`scheduler-worker-row-${worker.name}`}
                    className="flex items-baseline gap-x-[12px] border-b border-line-soft py-[6px] text-[12.5px] last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink">{worker.name}</span>
                    <span className="font-mono text-[11.5px] text-ink-2">
                      {worker.active_attempts} / {worker.capacity}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
      {/* C13f: the page says in words that per-run limits do not exist, so no
          one reads a silent cap into the absence. One muted line, always. */}
      <p className="pt-[10px] text-[11.5px] text-muted" data-testid="ops-resource-limits">
        Resource limits: not implemented — runs have no cpu, memory or disk caps in this release.
      </p>
    </OpsPanel>
  );
}

/* ------------------------------------------------------------- sandbox */

export interface SandboxPanelProps {
  sandbox: ReturnType<typeof useSystemSandbox>;
  /** The workers that are online right now — the ones whose verdict counts. */
  online: Worker[];
  nameOf: (workerId: string) => string;
  onlineIds: Set<string>;
}

/**
 * One line of a digest pair: the label, the value, and the copy button that
 * makes the whole string available. The value keeps its full text in the DOM
 * (`truncate` clips it visually, `title` holds it for a byte-for-byte compare),
 * because an operator comparing two digests must be able to select them.
 */
function DigestLine({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="flex items-baseline gap-x-[6px]">
      <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">{label}</dt>
      <dd className="flex items-baseline gap-x-[6px]">
        <span
          title={value}
          className="max-w-[12ch] truncate font-mono text-[11.5px] text-ink-2"
          data-testid={testid}
        >
          {value}
        </span>
        <CopyChip value={value} testid={`${testid}-copy`} />
      </dd>
    </div>
  );
}

/** jsdom has no clipboard and non-secure contexts lack it: the button no-ops. */
function CopyChip({ value, testid }: { value: string; testid: string }) {
  return (
    <button
      type="button"
      aria-label="Copy the full value"
      data-clipboard-value={value}
      className="rounded-[2px] border border-line px-[5px] py-[1px] font-mono text-[10px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      data-testid={testid}
      onClick={(event) => {
        const clip = navigator.clipboard;
        if (!clip) return;
        void clip.writeText(value).then(
          () => {
            event.currentTarget.textContent = "copied";
            window.setTimeout(() => {
              event.currentTarget.textContent = "copy";
            }, 2000);
          },
          () => {},
        );
      }}
    >
      copy
    </button>
  );
}

/**
 * SANDBOX (`ops-sandbox`): what this deployment pins, and what each worker that
 * reports has actually verified. `verified: false` is never drawn as a pass —
 * `workerSandboxCopy` is the sentence, quoted so no screen softens it, and the
 * long probe notes stay behind a collapsed `<details>`.
 */
export function SandboxPanel({ sandbox, online, nameOf, onlineIds }: SandboxPanelProps) {
  const data = sandbox.data;
  const rows = data?.workers ?? [];

  return (
    <OpsPanel
      id="ops-sandbox"
      title="Sandbox"
      meta={
        data ? `${rows.length} ${rows.length === 1 ? "worker" : "workers"} reporting` : undefined
      }
    >
      {sandbox.isPending ? <OpsSkeleton testid="sandbox-skeleton" /> : null}
      {sandbox.error ? (
        <OpsError
          thing="the sandbox report"
          detail={problemOf(sandbox.error).detail}
          onRetry={() => void sandbox.refetch()}
          testid="sandbox-health-error"
        />
      ) : null}
      {data ? (
        <>
          <dl className="flex flex-wrap gap-x-[20px] gap-y-[6px]">
            <DigestLine
              label="pinned backend"
              value={data.pinned_backend_version}
              testid="sandbox-pinned-version"
            />
            <DigestLine
              label="policy digest"
              value={data.policy_digest}
              testid="sandbox-policy-digest"
            />
          </dl>
          {rows.length === 0 ? (
            <p className="pt-[10px] text-[12.5px] text-muted">
              No worker has registered, so no agent here runs under any sandbox at all.
            </p>
          ) : (
            <ul className="space-y-[8px] pt-[10px]" data-testid="sandbox-worker-list">
              {rows.map((worker) => {
                const state = workerSandboxState(worker);
                const dot: OpsStatus =
                  state === "done" ? "ok" : state === "failed" ? "bad" : "warn";
                const mode = ENFORCEMENT_COPY[worker.enforcement];
                const listed = onlineIds.has(worker.worker_id);
                return (
                  <li
                    key={worker.worker_id}
                    data-testid={`sandbox-worker-row-${testidOf(worker.worker_id)}`}
                    className="text-[12.5px]"
                  >
                    <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px]">
                      <StatusDot status={dot} />
                      <span className="text-ink">{nameOf(worker.worker_id)}</span>
                      <span
                        className="font-mono text-[11.5px] text-muted"
                        data-testid={`sandbox-enforcement-${testidOf(worker.worker_id)}`}
                      >
                        {worker.backend} {worker.backend_version ?? "?"} ·{" "}
                        {mode?.word ?? worker.enforcement} ·{" "}
                        {worker.verified ? "verified" : "unverified"}
                      </span>
                      {!listed ? (
                        <span className="text-[11.5px] text-muted">· not online now</span>
                      ) : null}
                    </span>
                    {/* The honest sentence, never a bare ✓: `verified: false` has
                        not been observed running anything under a sandbox. */}
                    <span className="block text-[11.5px] text-muted" role="status">
                      {workerSandboxCopy(worker)}
                    </span>
                    <span className="flex flex-wrap gap-x-[16px] gap-y-[2px] pt-[2px]">
                      {(worker.volumes ?? []).length === 0 ? (
                        <span
                          className="font-mono text-[11.5px] text-st-waiting-tag-fg"
                          data-testid="volume-unknown"
                        >
                          {UNKNOWN_VOLUME_WARNING}
                        </span>
                      ) : (
                        (worker.volumes ?? []).map((volume) => (
                          <span
                            key={volume.root_kind}
                            className="font-mono text-[11.5px] text-ink-2"
                            data-testid={`volume-row-${volume.root_kind}`}
                          >
                            <span className="text-muted">{volume.root_kind}</span>{" "}
                            {volume.volume_id ? (
                              shortVolume(volume.volume_id)
                            ) : (
                              <span
                                className="text-st-waiting-tag-fg"
                                data-testid={`volume-unknown-${volume.root_kind}`}
                              >
                                {UNKNOWN_VOLUME_WARNING}
                              </span>
                            )}
                          </span>
                        ))
                      )}
                    </span>
                    {mode && worker.enforcement !== "required" ? (
                      <span className="block text-[11.5px] text-st-waiting-pale-fg">
                        {mode.note}
                      </span>
                    ) : null}
                    {worker.notes && worker.notes.length > 0 ? (
                      <details
                        className="pt-[2px]"
                        data-testid={`sandbox-notes-${testidOf(worker.worker_id)}`}
                      >
                        <summary className="cursor-pointer text-[11.5px] text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
                          Probe notes
                        </summary>
                        <ul className="space-y-[2px] pt-[2px] font-mono text-[11px] text-ink-2">
                          {worker.notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {systemIntegrity(data).length > 0 ? (
            <ul className="space-y-[2px] pt-[10px]">
              {systemIntegrity(data).map((finding) => (
                <li key={finding} className="text-[11.5px] text-st-waiting-tag-fg">
                  {finding}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="pt-[10px] text-[11.5px] text-muted" data-testid="ops-sandbox-footnote">
            {online.length === 0
              ? "No worker is online, so nothing here has run an agent under a sandbox just now."
              : `The tile above counts only the ${online.length} ${online.length === 1 ? "worker" : "workers"} still live (online or draining).`}
          </p>
        </>
      ) : null}
    </OpsPanel>
  );
}

/* -------------------------------------------------- identity & storage */

export interface IdentityStoragePanelProps {
  overview: ReturnType<typeof useSystemOverview>;
}

/**
 * IDENTITY & STORAGE (`ops-identity`): how a person gets in, and where the
 * bytes live. `dev_login` is a warning, not a status: it means anyone who can
 * reach this port is somebody, which is fine on a laptop and never in a lab
 * someone else can reach.
 */
export function IdentityStoragePanel({ overview }: IdentityStoragePanelProps) {
  const data = overview.data;
  return (
    <OpsPanel id="ops-identity" title="Identity & storage">
      {overview.isPending ? <OpsSkeleton testid="identity-skeleton" /> : null}
      {overview.error ? (
        <OpsError
          thing="the sign-in and storage configuration"
          detail={problemOf(overview.error).detail}
          onRetry={() => void overview.refetch()}
          testid="identity-error"
        />
      ) : null}
      {data === null && !overview.isPending && !overview.error ? (
        <p className="text-[12.5px] text-muted" data-testid="identity-not-served">
          This server does not report how it is wired, so the sign-in provider, artifact store and
          secret counts are not shown.
        </p>
      ) : null}
      {data ? (
        <dl className="grid grid-cols-1 gap-x-[20px] gap-y-[10px] min-[640px]:grid-cols-2">
          <div>
            <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
              Sign-in
            </dt>
            <dd
              className={`text-[13px] ${data.identity.dev_login ? "text-st-waiting-tag-fg" : "text-ink"}`}
              data-testid="identity-signin"
            >
              {data.identity.dev_login
                ? "Dev login (local only)"
                : `OIDC · ${data.identity.issuer_host || "no issuer host"}`}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
              Artifacts
            </dt>
            <dd className="text-[13px] text-ink" data-testid="identity-artifacts">
              {data.storage.artifact_backend || "—"}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
              Previews
            </dt>
            <dd className="text-[13px] text-ink" data-testid="identity-previews">
              {data.storage.preview_host || "—"}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
              Secrets
            </dt>
            <dd
              className="flex flex-wrap items-baseline gap-x-[8px] text-[13px] text-ink"
              data-testid="identity-secrets"
            >
              <span>
                {data.secrets.secrets} {data.secrets.secrets === 1 ? "secret" : "secrets"} in{" "}
                {data.secrets.projects} {data.secrets.projects === 1 ? "project" : "projects"} ·{" "}
                {data.secrets.mounts} {data.secrets.mounts === 1 ? "mount" : "mounts"}
              </span>
              <Link
                to={routes.projects()}
                className="text-[12.5px] text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid="identity-secrets-link"
              >
                Manage per project
              </Link>
            </dd>
          </div>
        </dl>
      ) : null}
    </OpsPanel>
  );
}

/* --------------------------------------------------------------- about */

export interface AboutPanelProps {
  health: ReturnType<typeof useHealth>;
  readiness: ReturnType<typeof useReadiness>;
  overview: ReturnType<typeof useSystemOverview>;
}

/** The `started_at` a build reports, or null when this server reports none. */
function startedAt(overview: SystemOverview | null | undefined): string | null {
  return overview?.server.started_at ?? null;
}
/**
 * ABOUT (`ops-about`): which build answered. Version, commit, replica, schema
 * and the start time — the five facts you need before reading anything else on
 * this page, because they decide whether the answers above came from the binary
 * you just deployed. Health and readiness print their served word (`ok`,
 * `ready`, `not ready`), never a colour.
 */
export function AboutPanel({ health, readiness, overview }: AboutPanelProps) {
  const server = overview.data?.server ?? null;
  const replica = health.data?.replica ?? server?.replica ?? null;
  const started = startedAt(overview.data);
  return (
    <OpsPanel
      id="ops-about"
      title="About"
      meta={replica ? `replica …${replica.slice(-5)}` : undefined}
    >
      <dl className="grid grid-cols-1 gap-x-[20px] gap-y-[10px] min-[640px]:grid-cols-2">
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">Version</dt>
          <dd className="font-mono text-[12.5px] text-ink" data-testid="ops-about-version">
            {server?.version ?? health.data?.version ?? "— not reported"}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">Commit</dt>
          <dd className="font-mono text-[12.5px] text-ink" data-testid="ops-about-commit">
            {server?.commit ? server.commit : "— not reported"}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">Replica</dt>
          <dd className="font-mono text-[12.5px] text-ink" data-testid="ops-about-replica">
            {replica ?? "— not reported"}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">Schema</dt>
          {readiness.isPending ? (
            <dd className="font-mono text-[12.5px] text-muted">loading…</dd>
          ) : (
            <dd className="font-mono text-[12.5px] text-ink" data-testid="readiness-card">
              {readiness.data
                ? `status: ${readiness.data.status} · schema version ${readiness.data.schema_version} of ${readiness.data.expected_schema_version}`
                : `status: not ready · ${problemOf(readiness.error).detail ?? "the readiness read failed"}`}
            </dd>
          )}
        </div>
        {health.isPending ? null : (
          <div data-testid="health-card">
            <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
              Health
            </dt>
            <dd className="font-mono text-[12.5px] text-ink">
              {health.data
                ? `status: ${health.data.status} · replica ${health.data.replica}`
                : `status: unreachable · ${problemOf(health.error).detail ?? "the health read failed"}`}
            </dd>
          </div>
        )}
        <div>
          <dt className="font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">Started</dt>
          <dd
            className="font-mono text-[12.5px] text-ink"
            title={formatTime(started)}
            data-testid="ops-about-started"
          >
            {started ? `${formatAge(started)} ago` : "— not reported"}
          </dd>
        </div>
      </dl>
    </OpsPanel>
  );
}
