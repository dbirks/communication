/**
 * Sidebar status flags (phase 1, v2).
 *
 * The source of truth is one cross-project read each of the two lists the
 * control plane serves org-wide (contract C3 — ADR-0047):
 *
 *   GET /api/v1/runs?status=queued,running,waiting_human,failed
 *   GET /api/v1/approvals?status=pending
 *
 * and live updates from the org journal stream (C4 — ADR-0048): `run.*` /
 * `approval.*` frames mark the reads dirty, coalesced to at most one
 * invalidation per second. No polling, no cache-wide subscription — the
 * column's state moves only when one of its own reads moves.
 *
 * The rules are the Inbox rules (`lib/attention.ts`): a `waiting_human` run
 * whose gate is still open is a decision (the pending approval behind it),
 * not a stall, and a child run belongs to its parent's tree. When either
 * cross-project endpoint 404s (a replica older than ADR-0047) the hook
 * falls back to that same reduction over the per-project reads, so the
 * numbers still agree with the Inbox the page beside the column shows.
 *
 * `Flag` keeps only the *worst* state present (failed > waiting > running),
 * which is what the 240px column has room for: `× n` red, `! n` amber,
 * `● n` blue — glyph plus count, never colour alone.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, problemOf } from "../api/client";
import { useOrgEvents } from "../api/events";
import type { components } from "../api/schema";
import { useMe, useProjects } from "../api/queries";
import type { Approval, Project } from "../api/types";
import {
  EMPTY_PROJECT_VIEW,
  needsYou,
  useProjectAttention,
  type Attention,
  type ProjectAttentionView,
} from "./attention";

export type CrossProjectRunSummary = components["schemas"]["CrossProjectRunSummary"];
type CrossProjectRunList = components["schemas"]["CrossProjectRunList"];
type CrossProjectApprovalList = components["schemas"]["CrossProjectApprovalList"];

/** One column's status badge: the worst state present, with its count. */
export interface Flag {
  kind: "failed" | "waiting" | "running" | "none";
  count: number;
}

export interface SidebarFlags {
  /** Inbox's own heading: everything that needs a person, plus the failed half. */
  inbox: { needsYou: number; failed: number };
  /** The board's live column. */
  board: { running: number };
  /** Live conversations; `null` while a read is in flight or unsupported. */
  threads: number | null;
  /** One worst-state flag per project id. */
  projects: Record<string, Flag>;
}

/** Worst-state ranking — `failed` outranks `waiting`, which outranks `running`. */
export const FLAG_RANK: Record<Flag["kind"], number> = {
  failed: 3,
  waiting: 2,
  running: 1,
  none: 0,
};

/**
 * The one rule that turns three counts into a flag: the worst kind present
 * wins and carries its own count.
 */
export function worstFlag(counts: { failed: number; waiting: number; running: number }): Flag {
  if (counts.failed > 0) return { kind: "failed", count: counts.failed };
  if (counts.waiting > 0) return { kind: "waiting", count: counts.waiting };
  if (counts.running > 0) return { kind: "running", count: counts.running };
  return { kind: "none", count: 0 };
}

/** The same rule for an attention slice (`decisions` are the open gates). */
export function flagFromView(
  view: Pick<ProjectAttentionView, "decisions" | "stalled" | "running">,
): Flag {
  return worstFlag({
    failed: view.stalled.length,
    waiting: view.decisions.length,
    running: view.running.length,
  });
}

/** The pure cut: one `Attention` (Inbox's reduction) into sidebar flags. */
export function sidebarFlagsFromAttention(
  attention: Attention,
  projects: readonly Project[],
): SidebarFlags {
  const views = attentionByProject(attention, projects);
  const projectFlags: Record<string, Flag> = {};
  for (const project of projects) {
    projectFlags[project.id] = flagFromView(views.get(project.id) ?? EMPTY_PROJECT_VIEW);
  }
  return {
    inbox: {
      needsYou: needsYou({ decisions: attention.decisions, stalled: attention.stalled }),
      failed: attention.stalled.length,
    },
    board: { running: attention.running.length },
    // `pending` means at least one of the project reads is still in flight;
    // an unfinished count would look like a real one, so it stays `null`.
    threads: attention.pending ? null : attention.conversations.length,
    projects: projectFlags,
  };
}

/** Bucket an already-computed `Attention` by project (the pure helper). */
function attentionByProject(
  attention: Attention,
  projects: readonly Project[],
): Map<string, ProjectAttentionView> {
  const views = new Map<string, ProjectAttentionView>();
  for (const project of projects) {
    views.set(project.id, { decisions: [], stalled: [], conversations: [], running: [] });
  }
  for (const item of attention.decisions) views.get(item.project.id)?.decisions.push(item);
  for (const item of attention.stalled) views.get(item.project.id)?.stalled.push(item);
  for (const item of attention.conversations) {
    views.get(item.project.id)?.conversations.push(item);
  }
  for (const item of attention.running) views.get(item.project.id)?.running.push(item);
  return views;
}

/**
 * The two cross-project reads the flags project (contract C3, ADR-0047).
 * One page each of the newest rows: a flag is a glance, not a census.
 */
export const SIDEBAR_RUN_STATUSES = ["queued", "running", "waiting_human", "failed"] as const;
const RUNS_PATH = `/api/v1/runs?status=${SIDEBAR_RUN_STATUSES.join(",")}&limit=200`;
const APPROVALS_PATH = "/api/v1/approvals?status=pending";

export const sidebarFlagKeys = {
  runs: ["sidebar-flags", "runs"] as const,
  approvals: ["sidebar-flags", "approvals"] as const,
};

/**
 * The one projection of the two cross-project reads into the flags, with the
 * Inbox rules applied: a `waiting_human` run whose gate is open is the
 * decision behind it, not a second failure; children belong to their
 * parent's tree. A run in a status the list never fetches (paused,
 * preparing, a terminal the query filters out) is not counted.
 */
export function flagsFromCrossProject(
  runs: readonly CrossProjectRunSummary[],
  approvals: readonly Approval[],
): SidebarFlags {
  /** Open gates: the `waiting_human` runs they sit behind are decisions. */
  const pendingGates = new Set<string>();
  /** Per-project open gates — a decision count, exactly like Inbox. */
  const gatesByProject = new Map<string, number>();
  for (const approval of approvals) {
    if (approval.state !== "pending") continue;
    pendingGates.add(approval.run_id);
    gatesByProject.set(approval.project_id, (gatesByProject.get(approval.project_id) ?? 0) + 1);
  }

  const counts = new Map<string, { failed: number; waiting: number; running: number }>();
  const bucket = (projectId: string) => {
    let entry = counts.get(projectId);
    if (!entry) {
      entry = { failed: 0, waiting: 0, running: 0 };
      counts.set(projectId, entry);
    }
    return entry;
  };
  let stalled = 0;
  let running = 0;
  for (const run of runs) {
    if (run.depth !== 0) continue; // children belong to their parent's tree
    const entry = bucket(run.project_id);
    if (run.status === "failed") {
      entry.failed += 1;
      stalled += 1;
    } else if (run.status === "waiting_human") {
      if (!pendingGates.has(run.id)) {
        // The gate is decided/expired but the run never moved on: stalled.
        entry.failed += 1;
        stalled += 1;
      }
    } else {
      // The list fetches only `queued` and `running` besides the two above.
      entry.running += 1;
      running += 1;
    }
  }
  for (const [projectId, gates] of gatesByProject) bucket(projectId).waiting = gates;

  const projects: Record<string, Flag> = {};
  for (const [projectId, entry] of counts) projects[projectId] = worstFlag(entry);
  const gateTotal = [...gatesByProject.values()].reduce((sum, n) => sum + n, 0);
  return {
    inbox: { needsYou: gateTotal + stalled, failed: stalled },
    board: { running },
    // The cross-project conversation list is not one of the two reads, so a
    // C3-fed column shows no thread count rather than a stale one.
    threads: null,
    projects,
  };
}

const NO_PROJECTS: readonly Project[] = [];
const NO_RUNS: readonly CrossProjectRunSummary[] = [];
const NO_APPROVALS: readonly Approval[] = [];

/** A 404 is a version fact, not a transient fault: do not retry it. */
function no404Retry(failureCount: number, error: unknown): boolean {
  return problemOf(error).status === 404 ? false : failureCount < 2;
}

/**
 * The org journal keeps the two reads fresh (C4 — ADR-0048): a `run.*` or
 * `approval.*` frame marks them dirty, and one flush at most per second
 * invalidates them (frames within the window collapse into a single
 * refetch). Conversation frames do not move either read and are ignored.
 */
export function useSidebarFlagInvalidation(): void {
  const queryClient = useQueryClient();
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    void queryClient.invalidateQueries({ queryKey: sidebarFlagKeys.runs });
    void queryClient.invalidateQueries({ queryKey: sidebarFlagKeys.approvals });
  }, [queryClient]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      dirty.current = false;
    },
    [],
  );

  useOrgEvents((event) => {
    if (!event.type.startsWith("run.") && !event.type.startsWith("approval.")) return;
    dirty.current = true;
    if (!timer.current) timer.current = setTimeout(flush, 1_000);
  });
}

/**
 * The flags the column shows. Both cross-project reads belong to the column
 * (one each), invalidation belongs to the org stream, and only when either
 * read 404s does the column borrow the Inbox's per-project reduction.
 */
export function useSidebarFlags(): SidebarFlags {
  const me = useMe();
  const projectsQuery = useProjects();
  const projects = me.data ? (projectsQuery.data?.items ?? NO_PROJECTS) : NO_PROJECTS;

  const runsQuery = useQuery({
    queryKey: sidebarFlagKeys.runs,
    queryFn: () => apiFetch<CrossProjectRunList>(RUNS_PATH),
    retry: no404Retry,
    staleTime: 30_000,
  });
  const approvalsQuery = useQuery({
    queryKey: sidebarFlagKeys.approvals,
    queryFn: () => apiFetch<CrossProjectApprovalList>(APPROVALS_PATH),
    retry: no404Retry,
    staleTime: 30_000,
  });

  const c3Down =
    (runsQuery.isError && problemOf(runsQuery.error).status === 404) ||
    (approvalsQuery.isError && problemOf(approvalsQuery.error).status === 404);

  /**
   * The pre-ADR-0047 fallback: the very reduction Inbox runs. The fan-out is
   * mounted only once a 404 is observed — while the cross-project endpoints
   * answer, `projects` stays empty here and not one of its reads fires.
   */
  const attention = useProjectAttention(c3Down ? projects : NO_PROJECTS);

  useSidebarFlagInvalidation();

  if (c3Down) return sidebarFlagsFromAttention(attention, projects);
  return flagsFromCrossProject(
    runsQuery.data?.runs ?? NO_RUNS,
    approvalsQuery.data?.approvals ?? NO_APPROVALS,
  );
}
