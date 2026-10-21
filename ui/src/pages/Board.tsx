/**
 * The board (artboard 2d) — the cross-project mission-control view.
 *
 * Data is one call: `useBoardRuns` (contract C3, `GET /api/v1/runs`) with the
 * grouping and filters applied client-side, and live updates ride the org
 * journal stream (`useBoardLiveUpdates`) — no polling. Grouping is by state
 * (the five 2d columns), by repo (the run's project — the run list carries
 * no per-run repo) or by workflow. Clicking a card keeps `?run=<id>` in the
 * URL; the 440px right-hand run drawer (artboard 3c, `RunDrawer`) reads it
 * and renders over the board.
 */
import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { problemOf } from "../api/client";
import { useBoardLiveUpdates, useBoardRuns } from "../api/board";
import { useProjects } from "../api/queries";
import { routes } from "../lib/routes";
import { VARIANT_CLASS } from "../components/ds/Button";
import { RunCard } from "../components/board/RunCard";
import { RunDrawer } from "../components/board/RunDrawer";
import {
  BOARD_COLUMNS,
  columnRuns,
  groupByRepo,
  groupByWorkflow,
  type BoardColumnSpec,
  type BoardRowGroup,
  type CrossProjectRun,
} from "../components/board/columns";

type GroupBy = "state" | "repo" | "workflow";

const GROUP_OPTIONS: readonly { id: GroupBy; label: string }[] = [
  { id: "state", label: "by state" },
  { id: "repo", label: "by repo" },
  { id: "workflow", label: "by workflow" },
];

/**
 * One state column: colored header band (glyph + label + count, never color
 * alone) over the cards. On a phone the columns stack and each becomes a
 * collapsible section; on a desktop grid the header stays inert so the
 * layout never depends on an accidental toggle.
 */
function BoardColumn({
  spec,
  runs,
  onOpenRun,
  now,
}: {
  spec: BoardColumnSpec;
  runs: CrossProjectRun[];
  onOpenRun: (runId: string) => void;
  now: Date;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section
      data-testid={`board-col-${spec.id}`}
      className="min-w-0 rounded-[6px] border border-line bg-paper"
      aria-label={`${spec.label} (${runs.length})`}
    >
      {/* The header and its count badge share the column's token fg: the
          solid states (NEEDS YOU ink-on-waiting, FAILED white-on-failed) are
          AA at full opacity, and no opacity blend may dilute them below
          4.5:1 (e.g. 80% white over the failed token computes to 4.21:1). */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-1.5 rounded-t-[6px] px-2.5 py-1.5 text-[11px] font-semibold tracking-wide md:pointer-events-none ${spec.headerClass}`}
      >
        <span aria-hidden="true">{spec.glyph}</span>
        <span>{spec.label}</span>
        <span
          className="ml-auto rounded-[3px] px-1 font-mono text-[10px]"
          data-testid={`board-col-count-${spec.id}`}
        >
          {runs.length}
        </span>
      </button>
      <div className={`flex flex-col gap-2 p-2 ${open ? "" : "hidden md:flex"}`}>
        {runs.length === 0 ? (
          <p className="px-1 py-0.5 text-[11px] text-muted">{spec.emptyLine}</p>
        ) : (
          runs.map((run) => <RunCard key={run.id} run={run} onOpenRun={onOpenRun} now={now} />)
        )}
      </div>
    </section>
  );
}

/** One by-repo / by-workflow row: the group label, then the same cards. */
function BoardRow({
  group,
  onOpenRun,
  now,
}: {
  group: BoardRowGroup;
  onOpenRun: (runId: string) => void;
  now: Date;
}) {
  return (
    <section className="min-w-0" aria-label={`${group.label} (${group.runs.length})`}>
      <h2 className="flex items-baseline gap-2 border-b border-line pb-1 text-[12px] font-semibold text-ink">
        {group.label}
        <span className="font-mono text-[10px] font-normal text-faint">{group.runs.length}</span>
      </h2>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {group.runs.map((run) => (
          <RunCard key={run.id} run={run} onOpenRun={onOpenRun} now={now} />
        ))}
      </div>
    </section>
  );
}

export default function Board() {
  const [groupBy, setGroupBy] = useState<GroupBy>("state");
  const [projectId, setProjectId] = useState("");
  const [mine, setMine] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const projects = useProjects();
  const runs = useBoardRuns({ projectId: projectId || undefined, mine });
  // Live updates: run.*/approval.* frames invalidate the board list (batched
  // to at most one invalidation per second inside the hook).
  useBoardLiveUpdates();

  // The card click sets `?run=`; the drawer renders it (and `onClose`
  // removes the param, so the drawer state is the URL — no separate state).
  const openRunId = searchParams.get("run") ?? "";
  const openRun = useCallback(
    (runId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("run", runId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const closeRun = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const drawerRun = useMemo(
    () => (openRunId ? (runs.data?.runs.find((r) => r.id === openRunId) ?? undefined) : undefined),
    [openRunId, runs.data],
  );

  // Ages are recomputed when the data arrives; the column clocks (DONE
  // TODAY, "xh ago") share this one `now` so the board agrees with itself.
  const now = useMemo(() => new Date(), [runs.data]);
  const byState = useMemo(
    () => (runs.data ? columnRuns(runs.data.runs, now) : null),
    [runs.data, now],
  );
  const byRepo = useMemo(() => (runs.data ? groupByRepo(runs.data.runs) : null), [runs.data]);
  const byWorkflow = useMemo(
    () => (runs.data ? groupByWorkflow(runs.data.runs) : null),
    [runs.data],
  );

  const startRunTo = projectId ? routes.projectTab(projectId, "runs") : routes.projects();

  return (
    <section data-testid="board-page" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-title-l font-bold">Board</h1>

        {/* Grouping: by state / by repo / by workflow (native radio group —
            arrow keys move between the options). */}
        <div
          role="radiogroup"
          aria-label="Group by"
          className="flex rounded-[4px] border border-line bg-surface p-0.5"
        >
          {GROUP_OPTIONS.map((option) => (
            <label
              key={option.id}
              data-testid={`board-group-by-${option.id}`}
              className="cursor-pointer"
            >
              <input
                type="radio"
                name="board-group-by"
                value={option.id}
                checked={groupBy === option.id}
                onChange={() => setGroupBy(option.id)}
                className="peer sr-only"
              />
              <span className="block rounded-[3px] px-2 py-0.5 text-[11px] text-ink-2 peer-checked:bg-accent-tint peer-checked:font-semibold peer-checked:text-accent-text peer-focus-visible:ring-2 peer-focus-visible:ring-accent-ring">
                {option.label}
              </span>
            </label>
          ))}
        </div>

        {/* Filters: all projects (the select) / mine / from issues /
            scheduled. The last two have no data behind them yet (no
            trigger-source column, ADR-0031) — honest and disabled. */}
        <select
          data-testid="board-project-select"
          aria-label="Filter by project"
          className="h-[26px] rounded-[4px] border border-line bg-surface px-1.5 text-[11px] text-ink-2"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">all projects</option>
          {(projects.data?.items ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="board-filter-mine"
          aria-pressed={mine}
          onClick={() => setMine((value) => !value)}
          className={`h-[26px] rounded-[4px] border px-2 text-[11px] ${
            mine
              ? "border-accent-edge bg-accent-tint font-semibold text-accent-text"
              : "border-line bg-surface text-ink-2"
          }`}
        >
          mine
        </button>
        <button
          type="button"
          disabled
          title="not available yet"
          className="h-[26px] cursor-default rounded-[4px] border border-line bg-disabled-bg px-2 text-[11px] text-disabled-fg"
        >
          from issues
        </button>
        <button
          type="button"
          disabled
          title="not available yet"
          className="h-[26px] cursor-default rounded-[4px] border border-line bg-disabled-bg px-2 text-[11px] text-disabled-fg"
        >
          scheduled
        </button>

        <Link
          data-testid="board-start-run"
          className={`ds-btn ${VARIANT_CLASS.primary} ml-auto inline-flex h-[28px] items-center rounded-[4px] px-3 text-[12px]`}
          to={startRunTo}
        >
          Start run
        </Link>
      </header>

      {/* Body: loading, honest error (the lab API image predates the
          cross-project list until it is rebuilt), the all-empty state, or
          the grouped cards. */}
      {runs.isPending ? (
        <p className="text-[12px] text-muted" data-testid="board-loading">
          Loading your runs…
        </p>
      ) : runs.error ? (
        <div className="max-w-[560px] text-[12px] text-muted">
          <p data-testid="board-error">
            {problemOf(runs.error).status === 404
              ? "This server doesn't serve the cross-project run list yet, so the board is empty — it will fill as soon as the API build that carries it is running."
              : `The run list could not be loaded: ${problemOf(runs.error).title ?? runs.error.message}`}
          </p>
          <Link
            className={`ds-btn ${VARIANT_CLASS.primary} mt-3 inline-flex h-[28px] items-center rounded-[4px] px-3 text-[12px]`}
            to={startRunTo}
          >
            Start run
          </Link>
        </div>
      ) : runs.data && runs.data.runs.length === 0 ? (
        <div className="max-w-[560px]">
          <p className="text-[12px] text-muted" data-testid="board-empty">
            No runs to show here yet.
          </p>
          <Link
            className={`ds-btn ${VARIANT_CLASS.primary} mt-3 inline-flex h-[28px] items-center rounded-[4px] px-3 text-[12px]`}
            to={startRunTo}
          >
            Start run
          </Link>
        </div>
      ) : groupBy === "state" && byState ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          {BOARD_COLUMNS.map((spec) => (
            <BoardColumn
              key={spec.id}
              spec={spec}
              runs={byState[spec.id]}
              onOpenRun={openRun}
              now={now}
            />
          ))}
        </div>
      ) : groupBy === "repo" && byRepo ? (
        <div className="flex flex-col gap-5">
          {byRepo.map((group) => (
            <BoardRow key={group.key} group={group} onOpenRun={openRun} now={now} />
          ))}
        </div>
      ) : byWorkflow ? (
        <div className="flex flex-col gap-5">
          {byWorkflow.map((group) => (
            <BoardRow key={group.key} group={group} onOpenRun={openRun} now={now} />
          ))}
        </div>
      ) : null}

      {/* The 440px right-hand run drawer (artboard 3c): opened by `?run=`. */}
      {openRunId ? <RunDrawer runId={openRunId} boardRun={drawerRun} onClose={closeRun} /> : null}
    </section>
  );
}
