/**
 * The board's data (artboard 2d): one cross-project run list call
 * (`GET /api/v1/runs`, contract C3 / ADR-0047) and live updates from the
 * org journal stream (`GET /api/v1/events`, ADR-0048). No polling: the
 * board refetches only when a `run.*` / `approval.*` frame lands, and
 * invalidations are coalesced to at most one per second — the same frame
 * batching `useProjectEvents` proved on the project screens.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useOrgEvents } from "./events";
import type { components } from "./schema";

export type CrossProjectRunList = components["schemas"]["CrossProjectRunList"];

/**
 * The board fetches every status it can place: queued/preparing → QUEUED,
 * running → RUNNING, waiting_human/paused → NEEDS YOU, the not-completed
 * terminals → FAILED, completed → DONE TODAY (the page keeps only today's).
 * The server's own `updated_since` filter cannot express "active forever,
 * completed only since local midnight" in one call, so the DONE TODAY clock
 * is applied client-side (`columns.isDoneToday`).
 */
export const BOARD_RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "waiting_human",
  "paused",
  "failed",
  "interrupted",
  "cancelled",
  "completed",
] as const;

/** Page size: the board is a glance, one page of the newest runs. */
const BOARD_RUN_LIMIT = 200;

export interface BoardRunFilter {
  /** Keep one project's runs; absent = every project the caller belongs to. */
  projectId?: string;
  /** `mine=true` — runs the caller started. */
  mine?: boolean;
}

/** The query string a filter builds; exported so tests pin the wire shape. */
export function boardRunQuery(filter: BoardRunFilter): string {
  const params = new URLSearchParams();
  params.set("status", BOARD_RUN_STATUSES.join(","));
  params.set("limit", String(BOARD_RUN_LIMIT));
  if (filter.projectId) params.set("project_id", filter.projectId);
  if (filter.mine) params.set("mine", "true");
  return params.toString();
}

/** Query-key prefix; `invalidateBoardRuns` clears every board list at once. */
export const boardRunsKey = (filter: BoardRunFilter): readonly unknown[] => [
  "board",
  "runs",
  { projectId: filter.projectId ?? "", mine: filter.mine ?? false },
];

/**
 * `GET /api/v1/runs` — the caller's runs across every project they belong
 * to, newest first, with each run's pinned-revision top-level steps
 * embedded (no N+1: one request per board load regardless of row count).
 */
export function useBoardRuns(filter: BoardRunFilter) {
  return useQuery({
    queryKey: boardRunsKey(filter),
    queryFn: () => apiFetch<CrossProjectRunList>(`/api/v1/runs?${boardRunQuery(filter)}`),
  });
}

/**
 * Frames that change what the board shows: any run lifecycle transition or
 * an approval decision moving a `waiting_human` run back to `running`.
 * `node.*` frames are deliberately *not* here — step progress is read from
 * the run list's embedded `steps`, and invalidating on every node frame is
 * the read storm the project stream's batching exists to stop.
 */
export function isBoardRelevant(type: string): boolean {
  return type.startsWith("run.") || type.startsWith("approval.");
}

/**
 * Subscribe the open board to the org journal stream and keep its query
 * fresh: every relevant frame marks the board dirty, and one flush at most
 * per second invalidates the board lists (frames within the window are
 * coalesced into a single refetch).
 */
export function useBoardLiveUpdates(enabled = true): void {
  const queryClient = useQueryClient();
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    void queryClient.invalidateQueries({ queryKey: ["board", "runs"] });
  }, [queryClient]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      dirty.current = false;
    },
    [],
  );

  useOrgEvents(
    enabled
      ? (event) => {
          if (!isBoardRelevant(event.type)) return;
          dirty.current = true;
          if (!timer.current) timer.current = setTimeout(flush, 1_000);
        }
      : undefined,
  );
}
