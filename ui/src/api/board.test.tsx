/**
 * The board's data hook, against the fake fetch and the fake journal socket.
 * Two contract behaviours get the closest look: the cross-project list's
 * wire shape (one call, every status the board places, `mine`/`project_id`
 * only when set), and the live leg — `run.*`/`approval.*` frames invalidate
 * the board list, coalesced to at most one refetch per second (no polling:
 * a board with no frames makes exactly one request, ever).
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useBoardRuns, boardRunQuery, isBoardRelevant } from "./board";
import { useBoardLiveUpdates } from "./board";
import { mockFetch, requestsTo, FakeEventSource } from "../test/fakes";
import { wireRunEvent } from "../test/fixtures/m4/wire";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LIST = {
  runs: [
    {
      id: "b810aaaa-bbbb-cccc-dddd-eeeeeeee0000",
      project_id: "p1",
      pipeline_id: "w1",
      pipeline_revision_id: "r1",
      revision_digest: "d",
      plan_digest: "d",
      status: "running",
      depth: 0,
      priority: 0,
      created_at: "2026-06-18T06:30:00Z",
      project_name: "Acme",
      pipeline_slug: "feature-delivery",
      pipeline_display_name: "Feature delivery",
      steps: [{ node_id: "implement", kind: "agent.acp", state: "running" }],
    },
  ],
  next_cursor: null,
};

function harness() {
  const { requests } = mockFetch([{ path: "/api/v1/runs", method: "GET", body: LIST }]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { requests, wrapper };
}

describe("boardRunQuery — the wire shape the server 400-checks", () => {
  it("always sends every board status and the page size", () => {
    const query = new URLSearchParams(boardRunQuery({}));
    expect(query.get("status")).toBe(
      "queued,preparing,running,waiting_human,paused,failed,interrupted,cancelled,completed",
    );
    expect(query.get("limit")).toBe("200");
    expect(query.get("project_id")).toBeNull();
    expect(query.get("mine")).toBeNull();
  });

  it("adds project_id and mine only when the filters say so", () => {
    const query = new URLSearchParams(boardRunQuery({ projectId: "p1", mine: true }));
    expect(query.get("project_id")).toBe("p1");
    expect(query.get("mine")).toBe("true");
  });

  it("adds the trigger kind only when the filter says so", () => {
    const query = new URLSearchParams(boardRunQuery({ trigger: "schedule" }));
    expect(query.get("trigger")).toBe("schedule");
    const issueQuery = new URLSearchParams(boardRunQuery({ trigger: "issue" }));
    expect(issueQuery.get("trigger")).toBe("issue");
  });

  it("omits the trigger when the filter has none", () => {
    const query = new URLSearchParams(boardRunQuery({}));
    expect(query.get("trigger")).toBeNull();
  });
});

describe("useBoardRuns", () => {
  it("reads the cross-project list", async () => {
    const { requests, wrapper } = harness();
    renderHook(() => useBoardRuns({}), { wrapper });
    expect(await waitFor(() => requestsTo(requests, "/api/v1/runs"))).toHaveLength(1);
  });

  it("a 404 server (pre-ADR-0047 build) is an error, not an empty board", async () => {
    const { requests } = mockFetch([
      {
        path: "/api/v1/runs",
        method: "GET",
        status: 404,
        body: {
          type: "https://communication.dev/errors/not-found",
          title: "Not found",
          status: 404,
          detail: "no such route",
        },
      },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBoardRuns({}), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);
  });
});

describe("isBoardRelevant — which frames dirty the board", () => {
  it("run and approval frames do; transcript and project frames don't", () => {
    expect(isBoardRelevant("run.started")).toBe(true);
    expect(isBoardRelevant("run.waiting_human")).toBe(true);
    expect(isBoardRelevant("approval.decided")).toBe(true);
    expect(isBoardRelevant("node.attempt.started")).toBe(false);
    expect(isBoardRelevant("conversation.message.agent")).toBe(false);
    expect(isBoardRelevant("project.created")).toBe(false);
  });
});

describe("useBoardLiveUpdates — frames, not polls", () => {
  it("a run frame refetches once, after the one-second coalescing window", async () => {
    vi.useFakeTimers();
    const { requests, wrapper } = harness();
    renderHook(
      () => {
        useBoardRuns({});
        useBoardLiveUpdates();
      },
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);

    const source = FakeEventSource.last();
    expect(source.url).toBe("/api/v1/events");
    act(() => {
      source.emit(wireRunEvent("run.started", {}, { global_seq: 100 }));
    });
    // Inside the window: coalesced, not refetched per frame.
    act(() => {
      source.emit(wireRunEvent("run.completed", {}, { global_seq: 101 }));
    });
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // Exactly one refetch for both frames.
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(2);
  });

  it("an irrelevant frame makes no request at all", async () => {
    vi.useFakeTimers();
    const { requests, wrapper } = harness();
    renderHook(
      () => {
        useBoardRuns({});
        useBoardLiveUpdates();
      },
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const source = FakeEventSource.last();
    act(() => {
      source.emit(wireRunEvent("conversation.created", {}, { global_seq: 200 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);
  });
});
