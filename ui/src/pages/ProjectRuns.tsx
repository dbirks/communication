/**
 * `/p/:projectId/runs` — the project's Runs tab, inside the 1b frame.
 *
 * The tab is the header band + tab row the overview draws (`ProjectFrame`), and
 * under it one honest list. It used to draw the old left `ProjectSectionNav`
 * rail beside a two-column grid whose right column was a large blank "Pick a
 * run" — at 390 that pane was most of the screen and said nothing.
 *
 * Honesty rules this page obeys: since ADR-0064 the wire carries each run's own
 * `title` and repository, so a row titles itself with that title when the run
 * has one and with the workflow slug from the library when it does not — never
 * an invented title, and never an upper-cased hex id standing in for a name
 * (pass-2 review: `#30OABCBF` was the row's headline). The row's second line
 * is the repository the server names and the wall clock it derives from
 * `started_at`/`finished_at` — no unlabelled digest; the revision the run is
 * pinned to is said on the run's own page. Its status is the app's short state
 * word (`SHORT_WORD`, one table with the run pages), never the wire's
 * `waiting_human` spelled out.
 *
 * Starting a run has ONE door — the header band's `Start run`, which lands
 * here with `?new=1` and opens `NewRunForm` (whose fields are read off the
 * pinned revision's `spec.inputs`). The panel used to carry its own "New run"
 * button beside that verb; the review named the duplicate, so it is gone.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { RUN_STATE, SHORT_WORD, stateOf, type StateName } from "../components/ds/states";
import { NewRunForm } from "../components/m4/NewRunForm";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ProjectFrame } from "../components/project/ProjectFrame";
import { usePipelines } from "../api/pipelines";
import { useProjectRuns } from "../api/runs";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";
import type { RunSummary } from "../api/types";
import type { RunStatus } from "../lib/pipeline/contract";
import { routes } from "../lib/routes";

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
  className?: string;
}

/**
 * The runs list: panel bar, the filter lenses, the rows. Top-level runs only —
 * children belong to their parent's tree (`route 24`), and a list that mixed
 * them would read as independent work. There is no "New run" button here: the
 * band's `Start run` is the page's one door into the form (design 1b).
 *
 * It is a component rather than markup inside the route so the run page's
 * Diagnostics arm and the tests can mount it against one read.
 */
export function RunsListColumn({
  projectId,
  selectedRunId = null,
  className = "",
}: RunsListColumnProps) {
  const runs = useProjectRuns(projectId);
  const pipelines = usePipelines();
  // Three states, deliberately: `picked` is a human choice (it never moves
  // again), `latched` is the auto default frozen at the moment the list first
  // answered, and `null` (still loading / failed) presses no chip at all.
  const [picked, setPicked] = useState<RunsFilter | null>(null);
  const [latched, setLatched] = useState<RunsFilter | null>(null);

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
    <Panel
      title={runs.data ? `RUNS · ${counts.all}` : "RUNS"}
      headingId="runs-column-heading"
      headingLevel={2}
      className={className}
    >
      <div className="space-y-[10px] p-[10px]">
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
      </div>
      <div className="min-h-0 border-t border-line" data-testid="runs-list">
        {/* A missing project id is a caller bug, not a state of the world:
            the read below is `enabled` on a non-empty id, so an empty one
            would stay `isPending` forever and press a permanent spinner for
            a request that never happens. Say so instead. */}
        {!projectId ? (
          <p className="px-[10px] py-[10px] text-[12.5px] text-muted" data-testid="runs-no-project">
            This page has no project, so there is no run list to read — the list never asked, and
            never will.
          </p>
        ) : runs.isPending ? (
          <div className="px-[10px] py-[10px]">
            <Spinner label="Loading runs" />
          </div>
        ) : null}
        {runs.isError ? (
          <div className="space-y-[6px] px-[10px] py-[10px]">
            <ProblemBanner
              error={runs.error}
              fallback="Runs could not be loaded."
              subject="this project's runs"
              hint="The list below is empty because the read failed, not because the project has never run."
              retry={{
                onClick: () => void runs.refetch(),
                pending: runs.isFetching,
                testid: "runs-retry",
              }}
            />
          </div>
        ) : null}
        {runs.data && filter !== null && matched.length === 0 ? (
          <p className="px-[10px] py-[10px] text-[12.5px] text-muted" data-testid="runs-empty">
            {counts.all === 0
              ? "No runs yet — nothing has started a workflow in this project."
              : filter === "attention"
                ? `Nothing needs attention${rows.length > 0 ? " (the open run is kept in the list)" : ""} — no run is waiting on a person or lying broken.`
                : `No ${filter} runs${rows.length > 0 ? " — the open run is listed because its page is here." : "."}`}
          </p>
        ) : null}
        <ul className="divide-y divide-line-soft">
          {rows.map((run) => (
            <li key={run.id}>
              <RunRow
                run={run}
                slug={slugs.get(run.pipeline_id) ?? run.pipeline_id}
                selected={run.id === selectedRunId}
                to={routes.run(run.id)}
              />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/**
 * One run. Two truncating lines — the readable title and its state, then
 * `repo · age` in mono — so the row survives 390: nothing here is a
 * fixed-width chip row that eats the title, and nothing is a hex string
 * standing where a name should be. The run's own page carries the pinned
 * digest, the `#short-id` handle and the failure cause in full.
 */
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
    <Link
      to={to}
      data-testid={`run-row-${run.id}`}
      className={`flex min-w-0 items-start gap-[10px] px-[10px] py-[9px] hover:bg-accent-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        selected ? "bg-accent-wash shadow-(--shadow-raised)" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-[6px]">
          {/* ADR-0064: the run's own title when the wire serves one; the
              workflow slug from the library when it does not. Never an
              upper-cased id — an id is a handle, not a subject line. */}
          <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
            {run.title ?? slug}
          </span>
          <RunStateChip status={run.status} />
          {run.parent_run_id ? (
            <span className="shrink-0 font-mono text-[10.5px] text-muted">· child</span>
          ) : null}
        </span>
        <span className="block truncate font-mono text-[10.5px] text-muted">
          {run.repository_name ? `${run.repository_name} · ` : ""}
          {elapsed(run)}
          {run.failed_cause ? ` · ${run.failed_cause}` : ""}
        </span>
      </span>
    </Link>
  );
}

/**
 * A run's state in the app's short word — the same table the overview's run
 * rows and the stage strip print (`SHORT_WORD`), not the wire's status spelled
 * out as "WAITING HUMAN".
 */
export function RunStateChip({
  status,
  testid = "run-status",
}: {
  status: RunStatus;
  testid?: string;
}) {
  const state: StateName = stateOf(RUN_STATE[status]);
  return (
    <StatusChip
      state={state}
      label={SHORT_WORD[state]}
      labelProps={{ "data-testid": testid, role: "status" }}
    />
  );
}

/** The run's own status in the same short word, for a page with no chip — the
 * mono line beside the child run's slug, the tree row, the header chip: one
 * table (`SHORT_WORD`), never the wire's token spelled out as "waiting human". */
export function runStateWord(status: RunStatus): string {
  return SHORT_WORD[stateOf(RUN_STATE[status])];
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
 * The project's section rail lives in `../components/ProjectSectionNav.tsx`;
 * the run page (`RunInspector.tsx`) still mounts it, and this re-export keeps
 * that import working. No project TAB mounts it any more — the header tab row
 * replaced it (design 1b).
 */
export { ProjectSectionNav } from "../components/ProjectSectionNav";

/**
 * The route body: the list, inside the frame. There is no "Pick a run" pane —
 * a row is a link to the run page, and an empty column pointing at the list
 * people are already looking at is the shell artefact this replaces.
 */
export default function ProjectRuns() {
  const { projectId = "" } = useParams();
  return (
    <ProjectFrame projectId={projectId} active="runs" testid="project-runs" heading="Runs">
      {() => <RunsTabBody projectId={projectId} />}
    </ProjectFrame>
  );
}

/**
 * The list, the one door into the form, and the footnote, in the frame's body
 * column — at the full width of that column (the README: these bodies are not
 * capped; the centred `56rem` column was the pass-2 defect).
 *
 * It is a component rather than markup in the route so that its `runs` read
 * mounts in the SAME commit as the header band's own reads: a page-level
 * `useProjectRuns` would ask one commit earlier, the answer would be stale by
 * the time the band arrived, and the page would fetch the project's runs twice
 * (the header's attention read is the same query key). It also owns the
 * refusal: the list route answers the same 404/403 the project read does for a
 * caller it hides the project from, and a run column — or an empty-state
 * sentence — around a project she cannot open says more than the API did.
 *
 * `?new=1` — the state the band's `Start run` navigates with — opens the run
 * form above the list; `Cancel` closes it and cleans the URL, so a reload of
 * the plain tab does not press the form again.
 */
export function RunsTabBody({ projectId }: { projectId: string }) {
  const runs = useProjectRuns(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const composing = searchParams.get("new") === "1";
  const closeForm = () =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("new");
        return next;
      },
      { replace: true },
    );

  if (projectAccessRefused(runs.error)) {
    return (
      <ProjectUnavailable
        heading="Runs"
        headingId="project-runs-heading"
        testid="project-runs-not-found"
        hint="The project's own tabs are the way in — a run list you cannot open is not listed here."
      />
    );
  }

  return (
    <div className="min-w-0 space-y-[10px]">
      {composing ? (
        // A raised card, not a titled panel: `NewRunForm` carries its own
        // "New run" heading (`new-run-heading` is the form's accessible
        // name), and a panel bar above it would say the same words twice.
        <div className="rounded-[3px] border border-line-strong bg-surface p-[12px]">
          <NewRunForm projectId={projectId} onCancel={closeForm} />
        </div>
      ) : null}
      <RunsListColumn projectId={projectId} />
      <p className="font-mono text-[10.5px] leading-[16px] text-faint">
        Every row opens its run — definition, steps and timeline. What a run of this project looks
        like comes from{" "}
        <Link
          to={routes.projectTab(projectId, "pipelines")}
          className="text-accent-text hover:text-ink"
        >
          the workflows it uses
        </Link>
        .
      </p>
    </div>
  );
}
