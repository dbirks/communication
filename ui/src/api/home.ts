/**
 * The Home briefing's cross-project reads (artboard 2a, contract C3 —
 * ADR-0047) and its live updates (the org journal stream, ADR-0048 —
 * contract C4). No polling: the briefing refetches only when a journal
 * frame lands, coalesced to at most one refetch per second.
 *
 * The run list itself reuses the board's `useBoardRuns` (api/board.ts):
 * the same `GET /api/v1/runs` rows drive the count line and the
 * "running now" section, so Home and Board can never disagree about a
 * run's state.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useOrgEvents } from "./events";
import type { components } from "./schema";

export type CrossProjectApprovalList = components["schemas"]["CrossProjectApprovalList"];
export type CrossProjectConversationList = components["schemas"]["CrossProjectConversationList"];
export type CrossProjectRunSummary = components["schemas"]["CrossProjectRunSummary"];
export type CrossProjectRunStep = components["schemas"]["CrossProjectRunStep"];

/** Query keys. Runs live under the board's key (shared rows); the two
 * briefing-only reads get their own, both under a `home` prefix so one
 * invalidation covers the page. */
export const homeKeys = {
  approvals: ["home", "approvals", "pending"] as const,
  conversations: ["home", "conversations"] as const,
};

/**
 * `GET /api/v1/approvals?status=pending` — the caller's gates across every
 * project they belong to, pending-first by deadline (ADR-0047). The Home
 * callout shows at most three; the rest wait in the Inbox.
 */
export function useHomeApprovals() {
  return useQuery({
    queryKey: homeKeys.approvals,
    queryFn: () => apiFetch<CrossProjectApprovalList>("/api/v1/approvals?status=pending"),
  });
}

/**
 * `GET /api/v1/conversations?limit=` — conversation summaries across every
 * visible project, newest first (ADR-0047). The briefing keeps only the
 * `origin === "manual"` rows (one-off threads, ADR-0043): a run-opened
 * conversation is part of its run, not a thread.
 */
export function useHomeConversations(limit = 50) {
  return useQuery({
    queryKey: [...homeKeys.conversations, limit],
    queryFn: () => apiFetch<CrossProjectConversationList>(`/api/v1/conversations?limit=${limit}`),
  });
}

/** A frame that moves the count line or a running row. */
export function isHomeRunFrame(type: string): boolean {
  return type.startsWith("run.") || type.startsWith("approval.");
}

/** A frame that can change the recent-threads section. */
export function isHomeThreadFrame(type: string): boolean {
  return type.startsWith("conversation.");
}

/**
 * Subscribe the open Home to the org journal stream (C4): run/approval
 * frames mark the run rows and the gate list dirty (one shared refetch of
 * the board runs key and the Home approvals key — the rows come from the
 * same cache the board reads), conversation frames refresh the thread list.
 * Frames inside the 1s window collapse into a single invalidation, the
 * frame batching `useProjectEvents` proved.
 */
export function useHomeLiveUpdates(enabled = true): void {
  const queryClient = useQueryClient();
  const dirty = useRef<Set<"runs" | "threads">>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const targets = dirty.current;
    dirty.current = new Set();
    if (targets.has("runs")) {
      void queryClient.invalidateQueries({ queryKey: ["board", "runs"] });
      void queryClient.invalidateQueries({ queryKey: homeKeys.approvals });
    }
    if (targets.has("threads")) {
      void queryClient.invalidateQueries({ queryKey: homeKeys.conversations });
    }
  }, [queryClient]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      dirty.current = new Set();
    },
    [],
  );

  useOrgEvents(
    enabled
      ? (event) => {
          if (isHomeRunFrame(event.type)) dirty.current.add("runs");
          else if (isHomeThreadFrame(event.type)) dirty.current.add("threads");
          if (dirty.current.size === 0) return;
          if (!timer.current) timer.current = setTimeout(flush, 1_000);
        }
      : undefined,
  );
}
