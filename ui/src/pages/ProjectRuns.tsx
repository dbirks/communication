/**
 * `/projects/:projectId/runs` — the run list of the design's run view
 * (`communication-spec/10-ui-design-handoff.md`: run inspector; reference
 * 3d). The left column is the list; the run page reuses the very same column
 * so the list never disappears when a run opens.
 *
 * Honesty rules this page obeys: the wire carries no run *name* and no node
 * tallies, so a row shows the pipeline slug from the library (never an
 * invented title), the pinned revision digest the server reports, and the
 * elapsed wall clock it can derive from `started_at`/`finished_at`. "New run"
 * opens `NewRunForm`, whose fields are read off the pinned revision's
 * `spec.inputs` — the page never invents an input shape of its own.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { RUN_STATE, type StateName } from "../components/ds/states";
import { NewRunForm } from "../components/m4/NewRunForm";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { usePipelines } from "../api/pipelines";
import { useProjectRuns } from "../api/runs";
import { problemOf } from "../api/client";
import type { RunSummary } from "../api/types";
import type { RunStatus } from "../lib/pipeline/contract";

const ACTIVE_STATES: readonly RunStatus[] = ["queued", "preparing", "running"];
const WAITING_STATES: readonly RunStatus[] = ["waiting_human", "paused"];
/** 4a's first lens: a person owes an answer, or the run broke and nobody has
 * cleaned it up. A union of states the wire already reports — never a guess. */
const ATTENTION_STATES: readonly RunStatus[] = [
  "waiting_human",
  "paused",
  "failed",
  "interrupted",
];

export type RunsFilter = "attention" | "active" | "waiting" | "all";

export interface RunsListColumnProps {
  projectId: string;
  /** The run whose page is open — its row is the raised one. */
  selectedRunId?: string | null;
}

/**
 * The 3d column: heading, "New run", the filter chips, the rows. Top-level
 * runs only — children belong to their parent's tree (`route 24`), and a list
 * that mixed them would read as independent work.
 */
export function RunsListColumn({ projectId, selectedRunId = null }: RunsListColumnProps) {
  const runs = useProjectRuns(projectId);
  const pipelines = usePipelines();
  const [filter, setFilter] = useState<RunsFilter>("active");
  const [composing, setComposing] = useState(false);

  const slugs = useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );

  const rows = useMemo(() => {
    const all = (runs.data?.runs ?? []).filter((run) => run.depth === 0);
    const matching =
      filter === "all"
        ? all
        : filter === "attention"
          ? all.filter((run) => ATTENTION_STATES.includes(run.status))
          : filter === "waiting"
            ? all.filter((run) => WAITING_STATES.includes(run.status))
            : all.filter((run) => ACTIVE_STATES.includes(run.status));
    return matching;
  }, [runs.data, filter]);

  const counts = useMemo(
    () => ({
      attention: (runs.data?.runs ?? []).filter(
        (r) => r.depth === 0 && ATTENTION_STATES.includes(r.status),
      ).length,
      active: (runs.data?.runs ?? []).filter(
        (r) => r.depth === 0 && ACTIVE_STATES.includes(r.status),
      ).length,
      waiting: (runs.data?.runs ?? []).filter(
        (r) => r.depth === 0 && WAITING_STATES.includes(r.status),
      ).length,
      all: (runs.data?.runs ?? []).filter((r) => r.depth === 0).length,
    }),
    [runs.data],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 border-r border-line px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-[15px] font-bold" id="runs-column-heading">
          Runs
        </h1>
        <Button
          variant="secondary"
          onClick={() => setComposing((current) => !current)}
          aria-expanded={composing}
          aria-controls="new-run-panel"
          data-testid="runs-new"
        >
          New run
        </Button>
      </div>
      {composing ? (
        <Panel title="NEW RUN" headingId="new-run-panel-heading" className="shrink-0">
          <div id="new-run-panel" className="p-[10px]">
            <NewRunForm
              projectId={projectId}
              onCancel={() => setComposing(false)}
              onCreated={() => setComposing(false)}
            />
          </div>
        </Panel>
      ) : null}
      <div className="flex flex-wrap gap-[6px]" role="group" aria-label="Filter runs">
        {(["attention", "active", "waiting", "all"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setFilter(name)}
            aria-pressed={filter === name}
            data-testid={`runs-filter-${name}`}
            className={`rounded-[3px] border px-2 py-[3px] font-mono text-[11px] ${
              filter === name
                ? "border-ink bg-ink text-paper"
                : "border-line text-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {name} {counts[name]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-[6px] overflow-y-auto" data-testid="runs-list">
        {runs.isPending ? <Spinner label="Loading runs" /> : null}
        {runs.isError ? (
          <ProblemBanner error={runs.error} fallback="Runs could not be loaded." />
        ) : null}
        {runs.data && rows.length === 0 ? (
          <p className="px-1 text-[12.5px] text-muted" data-testid="runs-empty">
            {counts.all === 0
              ? "No runs yet — this project has never started a pipeline."
              : filter === "attention"
                ? "Nothing needs attention — no run is waiting on a person or lying broken."
                : `No ${filter} runs.`}
          </p>
        ) : null}
        {rows.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            slug={slugs.get(run.pipeline_id) ?? run.pipeline_id}
            selected={run.id === selectedRunId}
            to={`/projects/${projectId}/runs/${run.id}`}
          />
        ))}
      </div>
    </div>
  );
}

function RunRow({
  run,
  slug,
  to,
  selected,
}: {
  run: RunSummary;
  slug: string;
  to: string;
  selected: boolean;
}) {
  return (
    <Row to={to} selected={selected} data-testid={`run-row-${run.id}`}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[6px]">
          <span className="truncate text-[13px] font-semibold">
            #{shortId(run.id)} {slug}
          </span>
          <RunStatusChip status={run.status} />
        </span>
        <span className="block truncate font-mono text-[10.5px] text-muted">
          {shortDigest(run.revision_digest)} · {elapsed(run)}
          {run.failed_cause ? ` · ${run.failed_cause}` : ""}
          {run.parent_run_id ? " · child" : ""}
        </span>
      </span>
    </Row>
  );
}

export function RunStatusChip({
  status,
  testid = "run-status",
}: {
  status: RunStatus;
  testid?: string;
}) {
  const state: StateName = RUN_STATE[status] ?? "info";
  return (
    <StatusChip
      state={state}
      label={status.replaceAll("_", " ")}
      labelProps={{ "data-testid": testid, role: "status" }}
    />
  );
}

/** `#482`-style handle: the last eight characters of the run's id. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(-8).toUpperCase();
}

export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return "—";
  return digest.startsWith("sha256:") ? digest.slice(7, 19) : digest.slice(0, 12);
}

/** Wall clock from `started_at` (or creation) to `finished_at` (or now). */
export function elapsed(
  run: Pick<RunSummary, "created_at" | "started_at" | "finished_at">,
  now: number = Date.now(),
): string {
  const from = Date.parse(run.started_at ?? run.created_at);
  const to = run.finished_at ? Date.parse(run.finished_at) : now;
  if (!Number.isFinite(from)) return "—";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The project's section rail lives in `../components/ProjectSectionNav.tsx`
 * now that every screen under `/projects/:id` mounts the same one; this
 * re-export keeps the run pages' existing imports working.
 */
export { ProjectSectionNav } from "../components/ProjectSectionNav";

/**
 * The route body: the list column plus the honest middle. The design's empty
 * centre is a pointer at the list, not a fake inspector.
 */
export default function ProjectRuns() {
  const { projectId = "" } = useParams();
  const runs = useProjectRuns(projectId);

  if (runs.isError) {
    const problem = problemOf(runs.error);
    if (problem.status === 404) {
      return (
        <div className="px-4 py-6" data-testid="project-runs-not-found">
          <Panel title="RUNS" headingId="project-runs-heading">
            <p className="p-[10px] text-[12.5px] text-muted">
              This project is not visible to you, or no longer exists — the control plane answered
              404, and this page invents no list to fill the gap.
            </p>
          </Panel>
        </div>
      );
    }
  }

  return (
    <div
      className="grid min-h-full grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]"
      data-testid="project-runs"
    >
      <RunsListColumn projectId={projectId} />
      <div className="px-6 py-8">
        <h1 className="text-[19px] font-bold" id="project-runs-heading">
          Runs
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {runs.isPending
            ? "Reading the project's runs…"
            : "Pick a run to open its definition, execution tree and timeline."}
        </p>
        <p className="mt-4 font-mono text-[11px] text-faint">
          <Link className="underline" to={`/projects/${projectId}/pipelines`}>
            Pipelines
          </Link>{" "}
          decide what a run of this project looks like.
        </p>
      </div>
    </div>
  );
}
