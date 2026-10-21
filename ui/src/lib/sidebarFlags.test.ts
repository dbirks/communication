/**
 * The sidebar flag rules (`lib/sidebarFlags.ts`): the pure cuts of both the
 * attention reduction (worst-state order, the per-project map, the Inbox
 * parity fields) and the cross-project reads (contract C3), plus the hook
 * itself: it settles (rendering it twice with the same data causes no extra
 * renders — the whole-cache subscription the v1 draft used was the
 * "maximum update depth" bug) and it refetches from the org stream at most
 * once per second (no polling). The fixtures stand in for a full `Attention`
 * with only the fields the cuts read (`length` and `project.id`), so they
 * are cast once at the top.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../api/types";
import type { Project } from "../api/types";
import {
  envelopeFixture,
  FakeEventSource,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
} from "../test/fakes";
import type { Attention, RunItem } from "./attention";
import {
  flagFromView,
  FLAG_RANK,
  flagsFromCrossProject,
  sidebarFlagKeys,
  sidebarFlagsFromAttention,
  useSidebarFlags,
  type CrossProjectRunSummary,
} from "./sidebarFlags";

const projects = [
  { id: "p-1", name: "Acme" },
  { id: "p-2", name: "Northwind" },
] as unknown as Project[];

function makeAttention(
  partial: {
    decisions?: string[]; // project ids
    stalled?: string[];
    running?: string[];
    conversations?: string[];
    pending?: boolean;
  } = {},
): Attention {
  const {
    decisions = [],
    stalled = [],
    running = [],
    conversations = [],
    pending = false,
  } = partial;
  const project = (id: string) => (id === "p-1" ? projects[0] : projects[1]);
  const run = (id: string): RunItem =>
    ({
      project: project(id),
      run: { id: `run-${id}` },
    }) as unknown as RunItem;
  const approvalFor = (id: string) => ({
    project: project(id),
    approval: { run_id: `run-${id}` },
  });
  const convoFor = (id: string) => ({
    project: project(id),
    conversation: { id: `c-${id}` },
    pendingPermissions: 0,
  });
  return {
    decisions: decisions.map(approvalFor),
    stalled: stalled.map(run),
    running: running.map(run),
    conversations: conversations.map(convoFor),
    unread: [],
    pending,
  } as unknown as Attention;
}

describe("flagFromView — the worst state present wins", () => {
  it("is none when the project has no open work", () => {
    expect(flagFromView({ decisions: [], stalled: [], running: [] })).toEqual({
      kind: "none",
      count: 0,
    });
  });

  it("ranks failed above waiting and running", () => {
    expect(flagFromView({ decisions: [], stalled: [], running: [1] as never })).toEqual({
      kind: "running",
      count: 1,
    });
    expect(flagFromView({ decisions: [1] as never, stalled: [], running: [] })).toEqual({
      kind: "waiting",
      count: 1,
    });
    expect(
      flagFromView({ decisions: [1] as never, stalled: [1] as never, running: [1] as never }),
    ).toEqual({ kind: "failed", count: 1 });
    expect(FLAG_RANK.failed).toBeGreaterThan(FLAG_RANK.waiting);
    expect(FLAG_RANK.waiting).toBeGreaterThan(FLAG_RANK.running);
    expect(FLAG_RANK.running).toBeGreaterThan(FLAG_RANK.none);
  });

  it("carries the winning kind's own count, not the total", () => {
    expect(
      flagFromView({ decisions: [1, 2] as never, stalled: [1] as never, running: [] }),
    ).toEqual({ kind: "failed", count: 1 });
    expect(
      flagFromView({ decisions: [1, 2] as never, stalled: [], running: [1] as never }),
    ).toEqual({ kind: "waiting", count: 2 });
  });
});

describe("sidebarFlagsFromAttention — the same numbers Inbox shows", () => {
  it("splits the reduction per project and keeps the cross-project totals", () => {
    const flags = sidebarFlagsFromAttention(
      makeAttention({
        decisions: ["p-1"],
        stalled: ["p-2", "p-2"],
        running: ["p-1", "p-2"],
        conversations: ["p-1"],
      }),
      projects,
    );
    expect(flags.inbox.needsYou).toBe(3); // one gate + two stalled runs
    expect(flags.inbox.failed).toBe(2);
    expect(flags.board.running).toBe(2);
    expect(flags.threads).toBe(1);
    expect(flags.projects["p-1"]).toEqual({ kind: "waiting", count: 1 });
    expect(flags.projects["p-2"]).toEqual({ kind: "failed", count: 2 });
  });

  it("leaves the thread count `null` while the reads are still in flight", () => {
    const flags = sidebarFlagsFromAttention(
      makeAttention({ decisions: ["p-1"], pending: true }),
      projects,
    );
    expect(flags.threads).toBeNull();
  });

  it("has a row for every project, none otherwise", () => {
    const flags = sidebarFlagsFromAttention(makeAttention(), projects);
    expect(Object.keys(flags.projects).sort()).toEqual(["p-1", "p-2"]);
    expect(flags.projects["p-1"].kind).toBe("none");
    expect(flags.inbox.needsYou).toBe(0);
    expect(flags.board.running).toBe(0);
  });
});

/* ------------------------------------------------ the C3 cross-project reads */

const runOf = (project_id: string, status: string, depth = 0) =>
  ({
    id: `run-${project_id}-${status}-${depth}`,
    project_id,
    status,
    depth,
  }) as unknown as CrossProjectRunSummary;
const gateOf = (project_id: string, run_id: string) =>
  ({ project_id, run_id, state: "pending" }) as unknown as Approval;

describe("flagsFromCrossProject — the two C3 reads, with the Inbox rules", () => {
  it("ranks per project: failed beats waiting, waiting beats running", () => {
    const flags = flagsFromCrossProject(
      [
        runOf("p-1", "failed"),
        runOf("p-2", "waiting_human"),
        runOf("p-3", "running"),
        runOf("p-3", "queued"),
      ],
      [gateOf("p-2", "run-p-2-waiting_human-0")],
    );
    expect(flags.projects["p-1"]).toEqual({ kind: "failed", count: 1 });
    expect(flags.projects["p-2"]).toEqual({ kind: "waiting", count: 1 });
    expect(flags.projects["p-3"]).toEqual({ kind: "running", count: 2 });
    expect(flags.board.running).toBe(2);
    expect(flags.threads).toBeNull();
  });

  it("a waiting_human run behind an open gate is the decision, not a stall", () => {
    const run = runOf("p-1", "waiting_human");
    const flags = flagsFromCrossProject([run], [gateOf("p-1", run.id)]);
    expect(flags.projects["p-1"]).toEqual({ kind: "waiting", count: 1 });
    expect(flags.inbox.failed).toBe(0);
    expect(flags.inbox.needsYou).toBe(1);
  });

  it("a waiting_human run with no open gate is a stalled run", () => {
    const flags = flagsFromCrossProject([runOf("p-1", "waiting_human")], []);
    expect(flags.projects["p-1"]).toEqual({ kind: "failed", count: 1 });
    expect(flags.inbox.failed).toBe(1);
  });

  it("child runs belong to their parent's tree and do not count", () => {
    const flags = flagsFromCrossProject([runOf("p-1", "failed", 1)], []);
    expect(flags.projects["p-1"]).toBeUndefined();
    expect(flags.inbox.failed).toBe(0);
    expect(flags.inbox.needsYou).toBe(0);
  });

  it("needsYou is the open gates plus the stalled runs", () => {
    const flags = flagsFromCrossProject(
      [runOf("p-1", "failed"), runOf("p-2", "failed"), runOf("p-3", "running")],
      [gateOf("p-1", "run-p-1-waiting_human-0")],
    );
    expect(flags.inbox.needsYou).toBe(3);
    expect(flags.inbox.failed).toBe(2);
  });
});

/* ------------------------------------------------------------ the hook */

function queryHarness(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function c3Routes(runList: unknown, approvalList: unknown) {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/runs", method: "GET", body: runList },
    { path: "/api/v1/approvals", method: "GET", body: approvalList },
  ];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("useSidebarFlags — the hook", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("settles: rendering the hook twice with the same data causes no extra renders", async () => {
    mockFetch(
      c3Routes(
        { runs: [runOf(projectFixture.id, "failed")], next_cursor: null },
        { approvals: [gateOf(projectFixture.id, "run-some-other")] },
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const wrapper = queryHarness(queryClient);
    let rendersA = 0;
    let rendersB = 0;
    const resultA = renderHook(
      () => {
        rendersA += 1;
        return useSidebarFlags();
      },
      { wrapper },
    );
    const resultB = renderHook(
      () => {
        rendersB += 1;
        return useSidebarFlags();
      },
      { wrapper },
    );

    await waitFor(
      () => {
        expect(queryClient.getQueryData(sidebarFlagKeys.runs)).toBeTruthy();
        expect(queryClient.getQueryData(sidebarFlagKeys.approvals)).toBeTruthy();
      },
      { timeout: 2_000 },
    );
    expect(resultA.result.current.projects[projectFixture.id]).toEqual({
      kind: "failed",
      count: 1,
    });
    expect(resultA.result.current.inbox.needsYou).toBe(2); // the gate + the failed run

    // Settle, then prove the render count is flat: no cache subscription, no
    // polling, no self-triggered state update.
    await sleep(200);
    const snapshotA = rendersA;
    const snapshotB = rendersB;
    await sleep(200);
    expect(rendersA).toBe(snapshotA);
    expect(rendersB).toBe(snapshotB);
    expect(resultA.result.current).toEqual(resultB.result.current);
  });

  it("falls back to the Inbox reduction when the C3 reads 404", async () => {
    const P = projectFixture.id;
    mockFetch([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: `/api/v1/projects/${P}/approvals`, body: { approvals: [] } },
      {
        path: `/api/v1/projects/${P}/runs`,
        body: {
          runs: [{ id: "r1", status: "failed", depth: 0, created_at: "2026-07-01T10:00:00Z" }],
        },
      },
      { path: `/api/v1/projects/${P}/conversations`, body: { items: [] } },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const { result } = renderHook(() => useSidebarFlags(), {
      wrapper: queryHarness(queryClient),
    });
    await waitFor(() => expect(result.current.projects[P]).toEqual({ kind: "failed", count: 1 }), {
      timeout: 2_000,
    });
    expect(result.current.inbox.failed).toBe(1);
    expect(result.current.inbox.needsYou).toBe(1);
    expect(result.current.threads).toBe(0);
  });

  it("coalesces org frames into one refetch per second, and polls nothing", async () => {
    vi.useFakeTimers();
    const { requests } = mockFetch(c3Routes({ runs: [], next_cursor: null }, { approvals: [] }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    renderHook(() => useSidebarFlags(), { wrapper: queryHarness(queryClient) });

    await act(async () => {
      await Promise.resolve();
    });
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);
    expect(requestsTo(requests, "/api/v1/approvals")).toHaveLength(1);

    const source = FakeEventSource.last();
    act(() => {
      source.emit(envelopeFixture({ type: "run.failed" }));
      source.emit(envelopeFixture({ type: "run.started", global_seq: 152004 }));
      source.emit(envelopeFixture({ type: "approval.requested", global_seq: 152005 }));
    });
    // Frames mark the reads dirty; they do not fetch themselves.
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Three frames, one second, one refetch of each read.
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(2);
    expect(requestsTo(requests, "/api/v1/approvals")).toHaveLength(2);

    // No frames, no requests: the column polls nothing.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(requestsTo(requests, "/api/v1/runs")).toHaveLength(2);
  });
});
