/**
 * Catch up (ADR-0078, design 8a): the reader's own pile of pieces of work,
 * the per-piece tours, the recap, and the seen-state writes.
 *
 * Shape notes this module has to own:
 *
 * - The recap read answers `404` when the generator has never written this
 *   reader one. That is an honest empty, not a failure, so its queryFn maps a
 *   `404` `ApiError` to `null` and lets every other error through.
 * - `GET /catch-up/tour` is still landing on the backend. The shape below is
 *   the contract the page codes against; it is a LOCAL type (commented as
 *   such) because `schema.d.ts` is generated and must not be hand-edited.
 * - The rest-list checkbox is an explicit "mark this whole piece seen", so
 *   `useMarkItemSeen` reads the item first (the store demands a
 *   `{version, stop_ids}` body) and posts every beat of the newest version.
 *   Reading one stop is NOT that: `useMarkStopsSeen` posts exactly the stop
 *   ids its caller names, so leaving one stop pays only that stop's debt.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { components } from "./schema";

export type CatchUpItemList = components["schemas"]["CatchUpItemList"];
export type CatchUpListItem = components["schemas"]["CatchUpListItem"];
export type CatchUpItem = components["schemas"]["CatchUpItem"];
export type CatchUpProjectChip = components["schemas"]["CatchUpProjectChip"];
export type CatchUpRefs = components["schemas"]["CatchUpRefs"];
export type CatchUpRecap = components["schemas"]["CatchUpRecap"];
export type CatchUpVisitSuggestion = components["schemas"]["CatchUpVisitSuggestion"];
export type CatchUpStop = components["schemas"]["CatchUpStop"];
export type CatchUpImportance = CatchUpStop["importance"];
export type CatchUpEvidence = NonNullable<CatchUpStop["evidence"]>[number];
export type CatchUpDecision = components["schemas"]["CatchUpDecision"];
export type CatchUpReplyResult = components["schemas"]["CatchUpReplyResult"];

/** The window chips the page owns; "unseen" sends no `since` at all. */
export type CatchUpWindow = "unseen" | "6h" | "24h" | "2d" | "7d";
export const CATCH_UP_WINDOWS: readonly CatchUpWindow[] = ["unseen", "6h", "24h", "2d", "7d"];

const WINDOW_HOURS: Record<Exclude<CatchUpWindow, "unseen">, number> = {
  "6h": 6,
  "24h": 24,
  "2d": 48,
  "7d": 168,
};

/** RFC 3339 instant `now - window` — the `since` the list read filters on. */
export function windowSince(window: CatchUpWindow, now: Date = new Date()): string | undefined {
  if (window === "unseen") return undefined;
  return new Date(now.getTime() - WINDOW_HOURS[window] * 3_600_000).toISOString();
}

/** The filters every catch-up read shares. */
export interface CatchUpFilters {
  /** Project ids to intersect; empty means "every project I belong to". */
  projects?: string[];
  /** Window chip value; "unseen" means no `since`. */
  window?: CatchUpWindow;
  /** Keep already-seen items in the list (the rest panel's "show seen"). */
  includeSeen?: boolean;
  /** Fixed "now" for window math — tests pass one; prod passes nothing. */
  now?: Date;
}

function listQuery(filters: CatchUpFilters, includeSeen: boolean): string {
  const params = new URLSearchParams();
  if (filters.projects && filters.projects.length > 0)
    params.set("projects", filters.projects.join(","));
  const since = windowSince(filters.window ?? "unseen", filters.now);
  if (since) params.set("since", since);
  if (includeSeen) params.set("include_seen", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** One key family so a seen-write invalidates every catch-up read at once. */
export const catchUpKeys = {
  all: ["catch-up"] as const,
  items: (filters: CatchUpFilters) =>
    [
      "catch-up",
      "items",
      filters.projects ?? [],
      filters.window ?? "unseen",
      Boolean(filters.includeSeen),
    ] as const,
  item: (id: string) => ["catch-up", "item", id] as const,
  tour: (filters: CatchUpFilters, offset: number) =>
    ["catch-up", "tour", filters.projects ?? [], filters.window ?? "unseen", offset] as const,
  recap: (filters: CatchUpFilters) => ["catch-up", "recap", filters.projects ?? []] as const,
  visitSuggestion: ["catch-up", "visit-suggestion"] as const,
};

/**
 * `GET /api/v1/catch-up/items` — the page's own read: the pieces of work the
 * assistant grouped, with how much of each story this reader still owes.
 */
export function useCatchUpItems(filters: CatchUpFilters = {}) {
  return useQuery({
    queryKey: catchUpKeys.items(filters),
    queryFn: () =>
      apiFetch<CatchUpItemList>(
        `/api/v1/catch-up/items${listQuery(filters, Boolean(filters.includeSeen))}`,
      ),
  });
}

/** `GET /api/v1/catch-up/items/{itemId}` — one piece with its whole story. */
export function useCatchUpItem(id: string) {
  return useQuery({
    queryKey: catchUpKeys.item(id),
    queryFn: () => apiFetch<CatchUpItem>(`/api/v1/catch-up/items/${id}`),
    enabled: id.length > 0,
  });
}

/* ------------------------------------------------------------------ tour
 * LOCAL TYPES for `GET /api/v1/catch-up/tour` (the route is still landing in
 * `internal/api/catch_up.go` and has no generated type yet). If a field is
 * missing here, this file — not schema.d.ts — is where it gets added. */
export interface CatchUpTourStop {
  id: string;
  title: string;
  narrative: string;
  kind?: string;
  importance: CatchUpImportance;
  evidence?: CatchUpEvidence[];
  decision?: components["schemas"]["CatchUpDecision"];
  seen: boolean;
  added_in_version: number;
}
export interface CatchUpTourEntry {
  work_item_id: string;
  stop: CatchUpTourStop;
  project: CatchUpProjectChip;
  refs: CatchUpRefs;
  minutes: number;
}
export interface CatchUpTourPage {
  stops: CatchUpTourEntry[];
  total_unseen_stops: number;
  more_available: boolean;
  built_from: number;
  minutes_total: number;
}
/* ------------------------------------------------------------- /tour end */

/** Tour page size — the "See more" card asks for up to 4 more stops. */
export const CATCH_UP_TOUR_LIMIT = 4;

/**
 * `GET /api/v1/catch-up/tour?projects=&offset=&limit=4` — this reader's
 * catch-up tour: the highest-importance unseen beats of the per-piece tours,
 * priority first. `offset` is the "See more" cursor.
 */
export function useCatchUpTour(filters: CatchUpFilters = {}, offset = 0, enabled = true) {
  return useQuery({
    queryKey: catchUpKeys.tour(filters, offset),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.projects && filters.projects.length > 0) {
        params.set("projects", filters.projects.join(","));
      }
      params.set("offset", String(offset));
      params.set("limit", String(CATCH_UP_TOUR_LIMIT));
      return apiFetch<CatchUpTourPage>(`/api/v1/catch-up/tour?${params.toString()}`);
    },
    enabled,
    retry: false,
  });
}

/**
 * `GET /api/v1/catch-up/recap` — the assistant's saved summary for THIS
 * reader. A `404` is the honest answer "the generator has never written you
 * one", so it resolves to `null` rather than throwing; the page renders
 * "No recap yet." and every other error stays an error.
 */
export function useCatchUpRecap(filters: CatchUpFilters = {}) {
  return useQuery({
    queryKey: catchUpKeys.recap(filters),
    queryFn: async (): Promise<CatchUpRecap | null> => {
      try {
        const params = new URLSearchParams();
        if (filters.projects && filters.projects.length > 0) {
          params.set("projects", filters.projects.join(","));
        }
        const qs = params.toString();
        return await apiFetch<CatchUpRecap>(`/api/v1/catch-up/recap${qs ? `?${qs}` : ""}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/**
 * `GET /api/v1/catch-up/visits/suggestion` — the window the big-backlog
 * banner should propose, inferred from this reader's own visit stamps.
 */
export function useVisitSuggestion() {
  return useQuery({
    queryKey: catchUpKeys.visitSuggestion,
    queryFn: () => apiFetch<CatchUpVisitSuggestion>("/api/v1/catch-up/visits/suggestion"),
    retry: false,
  });
}

/** `POST /api/v1/catch-up/visits` — stamp this page open (204, no body). */
export function useRecordVisit() {
  return useMutation({
    mutationFn: () => apiFetch<void>("/api/v1/catch-up/visits", { method: "POST" }),
  });
}

/** A seen-mark scoped to one ITEM: only the rest-list row's explicit
 * "mark this piece seen" checkbox uses it — never stop navigation. */
export interface MarkItemSeenInput {
  itemId: string;
}

/**
 * `POST /api/v1/catch-up/items/{itemId}/seen` — mark this reader's debt on
 * one WHOLE piece done (the rest list's checkbox). The body must name a tour
 * version and its beat ids, so the mutation reads the item first and posts
 * every beat of its newest version (an item with no tour has nothing to mark
 * and posts nothing). Moving between stops must NOT use this — see
 * `useMarkStopsSeen`.
 */
export function useMarkItemSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId }: MarkItemSeenInput) => {
      const item = await apiFetch<CatchUpItem>(`/api/v1/catch-up/items/${itemId}`);
      if (!item.latest) return;
      const stopIds = item.latest.stops.map((stop) => stop.id);
      if (stopIds.length === 0) return;
      await apiFetch<void>(`/api/v1/catch-up/items/${itemId}/seen`, {
        method: "POST",
        json: {
          version: item.latest.version,
          stop_ids: stopIds,
        } satisfies components["schemas"]["CatchUpSeenRequest"],
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catchUpKeys.all });
    },
  });
}

/** A seen-mark scoped to named beats: the caller already knows the tour
 * version and the stop ids it is leaving behind. */
export interface MarkStopsSeenInput {
  itemId: string;
  /** The tour version the named beats live in — the page posts exactly this
   * version, it does not go hunting for the newest one. */
  version: number;
  /** The beats this reader actually viewed. Empty posts nothing. */
  stopIds: string[];
}

/**
 * `POST /api/v1/catch-up/items/{itemId}/seen` — pay the debt for EXACTLY the
 * named beats ("Viewing a stop marks it seen when you move on", ADR-0078).
 * The tour player and the piece page mark only the stop left behind with
 * this; the whole-item checkbox is `useMarkItemSeen`.
 */
export function useMarkStopsSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, version, stopIds }: MarkStopsSeenInput) => {
      if (stopIds.length === 0) return Promise.resolve();
      return apiFetch<void>(`/api/v1/catch-up/items/${itemId}/seen`, {
        method: "POST",
        json: {
          version,
          stop_ids: stopIds,
        } satisfies components["schemas"]["CatchUpSeenRequest"],
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catchUpKeys.all });
    },
  });
}

/** One answer to one beat's question. It is text, and it authorizes nothing
 * (ADR-0078 § Decision 4) — this route is NOT the workflow-gate decide path. */
export interface ReplyToStopInput {
  itemId: string;
  stopId: string;
  text: string;
}

/**
 * `POST /api/v1/catch-up/items/{itemId}/stops/{stopId}/reply` — answer a
 * stop's `YOUR CALL` question. The server stores the text verbatim and posts
 * it, unchanged, into the conversation the WORK ITEM names. A busy agent is
 * the conversation's own `409` (the reply stays stored, the send did not go
 * out); a work item with no conversation answers with
 * `conversation_id: null` — a stored answer that goes nowhere, which the
 * surface must show as a dead end rather than as a send.
 */
export function useReplyToStop() {
  return useMutation({
    mutationFn: ({ itemId, stopId, text }: ReplyToStopInput) =>
      apiFetch<CatchUpReplyResult>(`/api/v1/catch-up/items/${itemId}/stops/${stopId}/reply`, {
        method: "POST",
        json: { text } satisfies components["schemas"]["CatchUpReplyRequest"],
      }),
  });
}

/** `POST /api/v1/catch-up/seen-all` — "mark all seen", optionally scoped to
 * the projects the panel is currently filtered to. */
export function useMarkAllSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projects: string[] = []) =>
      apiFetch<void>("/api/v1/catch-up/seen-all", {
        method: "POST",
        json: projects.length > 0 ? { projects } : {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: catchUpKeys.all });
    },
  });
}

/** The first sentence of a narrative — the card's "why" line. */
export function firstSentence(text: string): string {
  const match = /^(.+?[.!?])\s/.exec(`${text.trim()} `);
  return (match ? match[1] : text).trim();
}
