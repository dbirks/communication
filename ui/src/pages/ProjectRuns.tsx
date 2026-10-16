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
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { RUN_STATE, type StateName } from "../components/ds/states";
import { NewRunForm } from "../components/m4/NewRunForm";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { usePipelines } from "../api/pipelines";
import { useProjectRuns } from "../api/runs";
import { useProject } from "../api/queries";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";
import type { RunSummary } from "../api/types";
import type { RunStatus } from "../lib/pipeline/contract";

const ACTIVE_STATES: readonly RunStatus[] = ["queued", "preparing", "running"];
const WAITING_STATES: readonly RunStatus[] = ["waiting_human", "paused"];
/** 4a's first lens: a person owes an answer, or the run broke and nobody has
 * cleaned it up. A union of states the wire already reports — never a guess. */
const ATTENTION_STATES: readonly RunStatus[] = ["waiting_human", "paused", "failed", "interrupted"];

export type RunsFilter = "attention" | "active" | "waiting" | "all";

/** The order the opening lens is chosen in: live work first, then what a
 * person owes, then what is parked, then everything. */
export const RUNS_FILTER_ORDER: readonly RunsFilter[] = ["active", "attention", "waiting", "all"];

export type RunsCounts = Record<RunsFilter, number>;

/**
 * The lens a list opens on: the first *non-empty* filter, so a project with no
 * active work never lands on a blank "No active runs." the person has to
 * dismiss by hand. `all` is both last in the order and the fallback.
 */
export function defaultRunsFilter(counts: Partial<RunsCounts>): RunsFilter {
  return RUNS_FILTER_ORDER.find((name) => (counts[name] ?? 0) > 0) ?? "all";
}

function matchesFilter(run: RunSummary, filter: RunsFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return ATTENTION_STATES.includes(run.status);
  if (filter === "waiting") return WAITING_STATES.includes(run.status);
  return ACTIVE_STATES.includes(run.status);
}

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
  // Three states, deliberately: `picked` is a human choice (it never moves
  // again), `latched` is the auto default frozen at the moment the list first
  // answered, and `null` (still loading / failed) presses no chip at all.
  const [picked, setPicked] = useState<RunsFilter | null>(null);
  const [latched, setLatched] = useState<RunsFilter | null>(null);
  const [composing, setComposing] = useState(false);

  const slugs = useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );

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

  // The default is read off the counts of the *first* loaded list and then
  // frozen: a later refetch must not move a filter nobody asked to move.
  const auto = runs.data ? defaultRunsFilter(counts) : null;
  useEffect(() => {
    if (latched === null && auto !== null) setLatched(auto);
  }, [latched, auto]);
  const filter = picked ?? latched ?? auto;

  const { rows, matched } = useMemo(() => {
    const all = (runs.data?.runs ?? []).filter((run) => run.depth === 0);
    if (filter === null) return { rows: [], matched: [] };
    const matched = all.filter((run) => matchesFilter(run, filter));
    // The open run stays in the list whatever the filter says — a selection
    // the filter hides would read as the run having vanished.
    const rows =
      selectedRunId && !matched.some((run) => run.id === selectedRunId)
        ? all.filter((run) => matchesFilter(run, filter) || run.id === selectedRunId)
        : matched;
    return { rows, matched };
  }, [runs.data, filter, selectedRunId]);

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
            onClick={() => setPicked(name)}
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
        {runs.data && filter !== null && matched.length === 0 ? (
          <p className="px-1 text-[12.5px] text-muted" data-testid="runs-empty">
            {counts.all === 0
              ? "No runs yet — this project has never started a pipeline."
              : filter === "attention"
                ? `Nothing needs attention${rows.length > 0 ? " (the open run is kept in the list)" : ""} — no run is waiting on a person or lying broken.`
                : `No ${filter} runs${rows.length > 0 ? " — the open run is listed because its page is here." : "."}`}
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
  const project = useProject(projectId);
  const runs = useProjectRuns(projectId);

  // A non-member (or a deleted project) gets the overview's sentence, not a
  // run column around a project she cannot open: the list route answers the
  // same 404 the project read does, and a shell that renders "no runs" would
  // confirm more than the API chose to say.
  if (projectAccessRefused(project.error) || projectAccessRefused(runs.error)) {
    return (
      <ProjectUnavailable
        heading="Runs"
        headingId="project-runs-heading"
        testid="project-runs-not-found"
      />
    );
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
