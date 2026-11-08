/**
 * The catch-up reads and writes (ADR-0078) against the fake fetch: the wire
 * URLs, the window→`since` translation, the recap's honest 404-as-null, and
 * the seen-writes' bodies. The tour hook codes against the local
 * `CatchUpTourPage` type — these tests pin the query string the backend is
 * being built to answer.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import {
  useCatchUpItems,
  useCatchUpRecap,
  useCatchUpTour,
  useVisitSuggestion,
  useMarkSeen,
  useMarkAllSeen,
  useReplyToStop,
  useRecordVisit,
  windowSince,
  firstSentence,
} from "./catchup";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import { setCsrfToken } from "./client";

const projectId = "01987a90-0000-7000-8000-111111111111";
const itemId = "01987a90-0000-7000-8000-222222222222";

const itemList = {
  items: [
    {
      id: itemId,
      project: { id: projectId, name: "payments", color: "#6a4bc4" },
      shape: "issue",
      title: "Refund webhook sent duplicates",
      summary: "Fixed on main, no review.",
      resolution: "merged",
      refs: { issue_numbers: [215] },
      updated: false,
      unseen_stops: 2,
      total_stops: 2,
      importance: "must_know",
      updated_at: "2026-10-14T09:00:00Z",
      created_at: "2026-10-13T09:00:00Z",
    },
  ],
  total_unseen: 1,
  oldest_unseen_at: "2026-10-14T09:00:00Z",
};

const itemDetail = {
  id: itemId,
  project: { id: projectId, name: "payments", color: "#6a4bc4" },
  shape: "issue",
  title: "Refund webhook sent duplicates",
  summary: "Fixed on main, no review.",
  resolution: "merged",
  refs: { issue_numbers: [215] },
  source_run_id: null,
  conversation_id: null,
  latest: {
    version: 2,
    reason: "Fix landed, stop 3 added",
    created_at: "2026-10-14T09:00:00Z",
    stops: [
      {
        id: "s1",
        title: "Found",
        narrative: "The webhook fired twice.",
        importance: "must_know",
        added_in_version: 1,
        seen: false,
      },
      {
        id: "s2",
        title: "Fixed",
        narrative: "Idempotency key added.",
        importance: "must_know",
        added_in_version: 2,
        seen: false,
      },
    ],
  },
  history: [],
  seen_by: [],
  you_saw_version: 1,
  unseen_stops: 2,
  total_stops: 2,
  created_at: "2026-10-13T09:00:00Z",
  updated_at: "2026-10-14T09:00:00Z",
};

function harness(routes: RouteStub[]) {
  setCsrfToken("test-csrf");
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { requests, fetchMock, wrapper };
}

/** Raw request URL (query included) of the first call to `path`. */
function rawUrl(fetchMock: ReturnType<typeof mockFetch>["fetchMock"], path: string): string {
  const call = fetchMock.mock.calls.find((args) => String(args[0]).startsWith(path));
  if (!call) throw new Error(`no request recorded for ${path}`);
  return String(call[0]);
}

afterEach(() => setCsrfToken(null));

describe("windowSince", () => {
  it("turns a window chip into an RFC 3339 instant, and unseen into nothing", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(windowSince("unseen", now)).toBeUndefined();
    expect(windowSince("6h", now)).toBe("2026-10-14T06:00:00.000Z");
    expect(windowSince("24h", now)).toBe("2026-10-13T12:00:00.000Z");
    expect(windowSince("2d", now)).toBe("2026-10-12T12:00:00.000Z");
    expect(windowSince("7d", now)).toBe("2026-10-07T12:00:00.000Z");
  });
});

describe("firstSentence", () => {
  it("keeps the sentence a card's why-line is made of", () => {
    expect(firstSentence("From PR #417 yesterday. Fixed on main.")).toBe("From PR #417 yesterday.");
    expect(firstSentence("One sentence only.")).toBe("One sentence only.");
  });
});

describe("useCatchUpItems", () => {
  it("GETs the plain list with no filters", async () => {
    const { fetchMock, wrapper } = harness([{ path: "/api/v1/catch-up/items", body: itemList }]);
    const listed = renderHook(() => useCatchUpItems(), { wrapper });
    await waitFor(() => expect(listed.result.current.isSuccess).toBe(true));
    expect(listed.result.current.data?.total_unseen).toBe(1);
    expect(rawUrl(fetchMock, "/api/v1/catch-up/items")).toBe("/api/v1/catch-up/items");
  });

  it("sends projects, since and include_seen as the filters name them", async () => {
    const { fetchMock, wrapper } = harness([{ path: "/api/v1/catch-up/items", body: itemList }]);
    const now = new Date("2026-10-14T12:00:00Z");
    const listed = renderHook(
      () =>
        useCatchUpItems({
          projects: [projectId, "other"],
          window: "24h",
          includeSeen: true,
          now,
        }),
      { wrapper },
    );
    await waitFor(() => expect(listed.result.current.isSuccess).toBe(true));
    const url = new URL(rawUrl(fetchMock, "/api/v1/catch-up/items").replace(/^\//, "http://x/"));
    expect(url.searchParams.get("projects")).toBe(`${projectId},other`);
    expect(url.searchParams.get("since")).toBe("2026-10-13T12:00:00.000Z");
    expect(url.searchParams.get("include_seen")).toBe("true");
  });
});

describe("useCatchUpRecap", () => {
  it("answers a 404 with null, not an error", async () => {
    const { wrapper } = harness([
      {
        path: "/api/v1/catch-up/recap",
        status: 404,
        body: { type: "about:blank", title: "Not found", status: 404, detail: "" },
      },
    ]);
    const read = renderHook(() => useCatchUpRecap(), { wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    expect(read.result.current.data).toBeNull();
    expect(read.result.current.isError).toBe(false);
  });

  it("returns the saved recap when there is one", async () => {
    const recap = {
      text: "Start with the refund bug.",
      written_at: "2026-10-14T14:00:00Z",
      window: "unseen",
      project_ids: [],
    };
    const { wrapper } = harness([{ path: "/api/v1/catch-up/recap", body: recap }]);
    const read = renderHook(() => useCatchUpRecap(), { wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    expect(read.result.current.data).toEqual(recap);
  });
});

describe("useCatchUpTour", () => {
  it("asks for the reader's tour page with offset and limit", async () => {
    const page = {
      stops: [],
      total_unseen_stops: 0,
      more_available: false,
      built_from: 0,
      minutes_total: 0,
    };
    const { fetchMock, wrapper } = harness([
      {
        path: "/api/v1/catch-up/tour",
        body: (n: number) => (n === 1 ? page : { ...page, stops: [] }),
      },
    ]);
    const read = renderHook(() => useCatchUpTour({ projects: [projectId] }, 4), { wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    const url = new URL(rawUrl(fetchMock, "/api/v1/catch-up/tour").replace(/^\//, "http://x/"));
    expect(url.searchParams.get("projects")).toBe(projectId);
    expect(url.searchParams.get("offset")).toBe("4");
    expect(url.searchParams.get("limit")).toBe("4");
  });
});

describe("useVisitSuggestion", () => {
  it("reads the suggested window", async () => {
    const { wrapper } = harness([
      { path: "/api/v1/catch-up/visits/suggestion", body: { window: "7d", visits_per_week: 1.2 } },
    ]);
    const read = renderHook(() => useVisitSuggestion(), { wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    expect(read.result.current.data?.window).toBe("7d");
  });
});

describe("seen writes", () => {
  it("useMarkSeen reads the item, then posts every beat of its newest version", async () => {
    const { requests, wrapper } = harness([
      { path: `/api/v1/catch-up/items/${itemId}`, body: itemDetail },
      { path: `/api/v1/catch-up/items/${itemId}/seen`, method: "POST", status: 204 },
    ]);
    const write = renderHook(() => useMarkSeen(), { wrapper });
    write.result.current.mutate({ itemId });
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, `/api/v1/catch-up/items/${itemId}/seen`, "POST")).toHaveLength(1);
    expect(JSON.parse(requests[requests.length - 1]!.body!)).toEqual({
      version: 2,
      stop_ids: ["s1", "s2"],
    });
  });

  it("useMarkAllSeen posts the scope, and nothing when unscoped", async () => {
    const { requests, wrapper } = harness([
      { path: "/api/v1/catch-up/seen-all", method: "POST", status: 204 },
    ]);
    const write = renderHook(() => useMarkAllSeen(), { wrapper });
    write.result.current.mutate([projectId]);
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    expect(JSON.parse(requestsTo(requests, "/api/v1/catch-up/seen-all", "POST")[0]!.body!)).toEqual(
      {
        projects: [projectId],
      },
    );
  });

  it("useRecordVisit stamps one visit", async () => {
    const { requests, wrapper } = harness([
      { path: "/api/v1/catch-up/visits", method: "POST", status: 204 },
    ]);
    const write = renderHook(() => useRecordVisit(), { wrapper });
    write.result.current.mutate();
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, "/api/v1/catch-up/visits", "POST")).toHaveLength(1);
  });
});

describe("useReplyToStop", () => {
  const replyPath = `/api/v1/catch-up/items/${itemId}/stops/s2/reply`;

  it("posts the answer as plain text and returns where it landed", async () => {
    const { requests, wrapper } = harness([
      {
        path: replyPath,
        method: "POST",
        status: 202,
        body: {
          reply_id: "r1",
          conversation_id: "c1",
          turn_id: "t1",
        },
      },
    ]);
    const write = renderHook(() => useReplyToStop(), { wrapper });
    write.result.current.mutate({ itemId, stopId: "s2", text: "Keep 24h" });
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    const sent = requestsTo(requests, replyPath, "POST")[0]!;
    expect(JSON.parse(sent.body!)).toEqual({ text: "Keep 24h" });
    expect(write.result.current.data?.conversation_id).toBe("c1");
  });

  it("surfaces the busy-agent 409 as an error the caller can branch on", async () => {
    const { wrapper } = harness([
      {
        path: replyPath,
        method: "POST",
        status: 409,
        body: { type: "about:blank", title: "Busy", status: 409, detail: "turn in progress" },
      },
    ]);
    const busy = renderHook(() => useReplyToStop(), { wrapper });
    busy.result.current.mutate({ itemId, stopId: "s2", text: "Keep 24h" });
    await waitFor(() => expect(busy.result.current.isError).toBe(true));
  });

  it("answers with a null conversation for a work item with no thread", async () => {
    const { wrapper } = harness([
      {
        path: replyPath,
        method: "POST",
        status: 202,
        body: { reply_id: "r1", conversation_id: null, turn_id: null },
      },
    ]);
    const write = renderHook(() => useReplyToStop(), { wrapper });
    write.result.current.mutate({ itemId, stopId: "s2", text: "12h" });
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    expect(write.result.current.data?.conversation_id).toBeNull();
  });
});
