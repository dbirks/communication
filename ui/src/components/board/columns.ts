/**
 * Board (2d) pure mapping: the cross-project run list (contract C3,
 * `GET /api/v1/runs`) onto the board's five state columns, the segmented
 * per-step progress and the two secondary groupings (repo / workflow).
 *
 * Everything here is a pure function of the wire row — no fetch, no clock
 * except where `now` is a parameter — so the mapping is testable without a
 * server. The seven step states come from `CrossProjectRunStep.state`
 * (ADR-0047 § 4); the run status is the `RunStatus` machine from `01`.
 */
import type { components } from "../../api/schema";

export type CrossProjectRun = components["schemas"]["CrossProjectRunSummary"];
export type CrossProjectRunStep = components["schemas"]["CrossProjectRunStep"];
export type RunStatus = components["schemas"]["RunStatus"];

/** The five board columns, in render order (artboard 2d). */
export type BoardColumnId = "queued" | "running" | "needs-you" | "failed" | "done";

export interface BoardColumnSpec {
  id: BoardColumnId;
  /** Header word; the glyph is prefixed in the header (rule 06: never color alone). */
  label: string;
  /** Handoff glyph for the header. */
  glyph: string;
  /** Header band classes from `ui/src/styles/tokens.css` (no raw hex here). */
  headerClass: string;
  /** One muted line for an empty column. */
  emptyLine: string;
}

/**
 * Column header styling. RUNNING uses the handoff's pale-blue pair
 * (`#d9eefa` / `#0f5e96` = `st-running-tag`); NEEDS YOU and FAILED are the
 * solid state tokens (ink text on waiting, white on failed) per the design
 * brief. QUEUED and DONE TODAY stay pale so the two solid bands read as the
 * states that need a person.
 */
export const BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  {
    id: "queued",
    label: "QUEUED",
    glyph: "·",
    headerClass: "bg-st-queued-tag text-st-queued-tag-fg",
    emptyLine: "Nothing queued.",
  },
  {
    id: "running",
    label: "RUNNING",
    glyph: "●",
    headerClass: "bg-st-running-tag text-st-running-tag-fg",
    emptyLine: "Nothing running.",
  },
  {
    id: "needs-you",
    label: "NEEDS YOU",
    glyph: "!",
    headerClass: "bg-st-waiting-strong text-ink",
    emptyLine: "Nothing is waiting on you.",
  },
  {
    id: "failed",
    label: "FAILED",
    glyph: "×",
    headerClass: "bg-st-failed-strong text-st-failed-strong-fg",
    emptyLine: "Nothing failed.",
  },
  {
    id: "done",
    label: "DONE TODAY",
    glyph: "✓",
    headerClass: "bg-st-done-tag text-st-done-tag-fg",
    emptyLine: "Nothing finished today.",
  },
] as const;

export function boardColumnSpec(id: BoardColumnId): BoardColumnSpec {
  return BOARD_COLUMNS.find((column) => column.id === id)!;
}

/**
 * `RunStatus` → board column. `preparing` has not visibly started, so it
 * reads as queued; `waiting_human` (a gate holds a scope) and `paused` are
 * the two states that need a person; `failed`, `interrupted` and `cancelled`
 * are the not-completed terminal states (the card shows its own status word,
 * so "cancelled" is never spelled as a failure); only `completed` can reach
 * DONE TODAY.
 */
const STATUS_COLUMN: Record<RunStatus, BoardColumnId> = {
  queued: "queued",
  preparing: "queued",
  running: "running",
  waiting_human: "needs-you",
  paused: "needs-you",
  failed: "failed",
  interrupted: "failed",
  cancelled: "failed",
  completed: "done",
};

export function columnOf(status: RunStatus): BoardColumnId {
  return STATUS_COLUMN[status] ?? "queued";
}

/**
 * DONE TODAY is a clock, not a status: a `completed` run belongs to the
 * column while `COALESCE(finished_at, created_at)` (the same predicate the
 * API's `updated_since` uses) is at or after local midnight.
 */
export function localMidnight(now: Date): Date {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return midnight;
}

export function runUpdatedAt(run: CrossProjectRun): Date {
  return new Date(run.finished_at ?? run.created_at);
}

export function isDoneToday(run: CrossProjectRun, now: Date): boolean {
  return (
    columnOf(run.status) === "done" && runUpdatedAt(run).getTime() >= localMidnight(now).getTime()
  );
}

/** The five columns, newest-first within each (the API's own order). */
export function columnRuns(
  runs: readonly CrossProjectRun[],
  now: Date,
): Record<BoardColumnId, CrossProjectRun[]> {
  const out: Record<BoardColumnId, CrossProjectRun[]> = {
    queued: [],
    running: [],
    "needs-you": [],
    failed: [],
    done: [],
  };
  for (const run of runs) {
    const column = columnOf(run.status);
    if (column === "done" && !isDoneToday(run, now)) continue;
    out[column].push(run);
  }
  return out;
}

/* ------------------------------------------------------- step segments */

/**
 * The segmented card bar's palette, one 7px segment per top-level step.
 * Token classes only (`bg-seg-*` from `ui/src/components/ds/states.ts`);
 * `skipped` folds into done — the step made it across, it just had nothing
 * to do.
 */
export const STEP_SEGMENT_CLASS: Record<CrossProjectRunStep["state"], string> = {
  pending: "bg-seg-open",
  running: "bg-seg-running",
  waiting: "bg-seg-waiting",
  succeeded: "bg-seg-done",
  failed: "bg-seg-failed",
  skipped: "bg-seg-done",
  cancelled: "bg-seg-failed",
};

/** "3 of 6 steps done, 1 running" — and the failed clause when there is one. */
export function progressAriaLabel(steps: readonly CrossProjectRunStep[]): string {
  const done = steps.filter(
    (step) => step.state === "succeeded" || step.state === "skipped",
  ).length;
  const running = steps.filter((step) => step.state === "running").length;
  const failed = steps.filter((step) => step.state === "failed").length;
  let label = `${done} of ${steps.length} steps done`;
  if (running > 0) label += `, ${running} running`;
  if (failed > 0) label += `, ${failed} failed`;
  return label;
}

/**
 * The step the card names as "current": the first running step, else the
 * first waiting one (a gate names the step that holds it), else the first
 * pending step (what starts next). Terminal runs with nothing live fall
 * through to `undefined` and the card shows no current step.
 */
export function currentStep(
  steps: readonly CrossProjectRunStep[],
): CrossProjectRunStep | undefined {
  return (
    steps.find((step) => step.state === "running") ??
    steps.find((step) => step.state === "waiting") ??
    steps.find((step) => step.state === "pending")
  );
}

/** State glyph for a card's current-step line (matches the segment colors). */
const STEP_GLYPH: Record<CrossProjectRunStep["state"], string> = {
  pending: "·",
  running: "●",
  waiting: "!",
  succeeded: "✓",
  failed: "×",
  skipped: "✓",
  cancelled: "×",
};

export function stepGlyph(state: CrossProjectRunStep["state"]): string {
  return STEP_GLYPH[state];
}

/* ------------------------------------------------------------- identity */

/** `#b810` — the first four hex chars of the id (dashes stripped, artboard 2d). */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 4);
}

/**
 * The card's title line. `CrossProjectRunSummary` carries no run title today
 * (gap analysis Q2: it would be a run input), so the honest value is the
 * workflow's display name — never an invented sentence.
 */
export function runTitle(run: CrossProjectRun): string {
  const title = (run as { title?: unknown }).title;
  return typeof title === "string" && title.trim() !== "" ? title : run.pipeline_display_name;
}

/** "1m" / "2h" / "3d" — the card's age line, from `created_at`. */
export function formatAge(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ----------------------------------------------------------- trigger */

/** ADR-0056 (part 1): the run's trigger kind — how it was started. */
export type RunTriggerKind = components["schemas"]["RunTrigger"]["kind"];

/** The run-row shape the trigger reads: the board summary's `trigger` plus the
 *  detail's thread link (the drawer reads both from the same row source). */
export interface RunTriggerSource {
  trigger?: { kind?: string | null; ref?: string | null } | null;
}

/** The trigger's own identifier for a non-manual kind: the schedule id, or `owner/repo#<number>`. */
export function triggerRef(run: RunTriggerSource): string | null {
  const ref = run.trigger?.ref;
  return typeof ref === "string" && ref !== "" ? ref : null;
}

/** The thread a `thread`-kind run was started from (ADR-0053), when the row carries it. */
export function triggerConversationId(run: RunTriggerSource): string | null {
  const id = (run as { source_conversation_id?: string | null }).source_conversation_id;
  return id ?? null;
}

/** The badge state for a run's trigger; null for a `manual` (or trigger-less) run. */
export type RunTriggerBadgeState =
  | { kind: "schedule"; scheduleId: string | null }
  | { kind: "issue"; owner: string; repo: string; number: string }
  | { kind: "thread"; conversationId: string };

/**
 * The badge the board cards and the run drawer render for a run's trigger
 * (ADR-0056 part 1; artboards 2d / 3c). A `manual` run — or a row that carries
 * no trigger at all — gets no badge; the honest absence is no badge. An issue
 * ref that does not parse into `owner/repo#<number>` renders no badge either.
 */
export function runTriggerBadge(run: RunTriggerSource): RunTriggerBadgeState | null {
  const kind = run.trigger?.kind;
  if (kind === "manual") return null;
  if (kind === "schedule") {
    const ref = run.trigger?.ref ?? null;
    return { kind: "schedule", scheduleId: ref };
  }
  if (kind === "issue") {
    const match = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(run.trigger?.ref ?? "");
    if (!match) return null;
    return { kind: "issue", owner: match[1], repo: match[2], number: match[3] };
  }
  if (kind === "thread") {
    const conversationId = triggerConversationId(run);
    if (!conversationId) return null;
    return { kind: "thread", conversationId };
  }
  return null;
}

/* ------------------------------------------------------------ groupings */

export interface BoardRowGroup {
  key: string;
  label: string;
  runs: CrossProjectRun[];
}

/**
 * Grouping "by repo". The run list does not carry a per-run repo (a run can
 * touch several), so the honest grouping is the run's project — labelled as
 * such, never a fabricated repo name. First-seen order (newest runs first).
 */
export function groupByRepo(runs: readonly CrossProjectRun[]): BoardRowGroup[] {
  return groupBy(
    runs,
    (run) => run.project_id,
    (run) => run.project_name,
  );
}

/** Grouping "by workflow": one row per pipeline, human display name. */
export function groupByWorkflow(runs: readonly CrossProjectRun[]): BoardRowGroup[] {
  return groupBy(
    runs,
    (run) => run.pipeline_id,
    (run) => run.pipeline_display_name,
  );
}

function groupBy(
  runs: readonly CrossProjectRun[],
  keyOf: (run: CrossProjectRun) => string,
  labelOf: (run: CrossProjectRun) => string,
): BoardRowGroup[] {
  const order: string[] = [];
  const groups = new Map<string, BoardRowGroup>();
  for (const run of runs) {
    const key = keyOf(run);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelOf(run), runs: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.runs.push(run);
  }
  return order.map((key) => groups.get(key)!);
}
