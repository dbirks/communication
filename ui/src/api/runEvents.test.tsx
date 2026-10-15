/**
 * The run-stream feed and its fold. Everything here is the fake `EventSource`
 * driven by hand — the same argument `projectTranscript` is tested with, for
 * the run scope (ADR-0014 § 5): replayed frames must not double-apply, and a
 * frame that arrives out of order (after a reconnect that skipped the socket's
 * resume rule) must still land in journal order.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { useRunEvents } from "./runEvents";
import { queryKeys } from "./queries";
import { normalizeRunFrames, projectRun, toRunEvent } from "../lib/pipeline/runEvents";
import { FakeEventSource, mockFetch } from "../test/fakes";
import type { EventEnvelope } from "./types";
import { featureNodes, featureRun } from "../test/fixtures/m4/runs";
import { pendingApproval } from "../test/fixtures/m4/approvals";
import {
  WIRE_ATTEMPT_1,
  WIRE_NODE_IMPLEMENT,
  WIRE_RUN_ID,
  wireRunEvent,
} from "../test/fixtures/m4/wire";

afterEach(cleanup);

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useRunEvents (GET /runs/{runId}/events)", () => {
  it("opens the run-scoped stream and buffers frames in journal order", async () => {
    mockFetch([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.run(WIRE_RUN_ID), { status: "running" });
    const { result } = renderHook(() => useRunEvents(WIRE_RUN_ID), {
      wrapper: wrapperFor(queryClient),
    });
    const source = FakeEventSource.last();
    expect(source.url).toBe(`/api/v1/runs/${WIRE_RUN_ID}/events`);
    expect(result.current.status).toBe("reconnecting");

    source.open();
    await waitFor(() => expect(result.current.status).toBe("live"));

    const started = wireRunEvent(
      "node.attempt.started",
      { node_instance_key: "/build_until_verified[1]/implement", attempt_number: 1 },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: WIRE_ATTEMPT_1, global_seq: 5100 },
    );
    // Same `global_seq` delivered twice = a replay; the buffer keeps one.
    act(() => source.emit(started));
    act(() => source.emit(started));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0].event_id).toBe(started.event_id);
    // The frame also dirtied the run subtree so the next read confirms it.
    expect(queryClient.getQueryState(queryKeys.run(WIRE_RUN_ID))?.isInvalidated).toBe(true);
  });

  it("closes cleanly when the run changes (no stale stream on two runs)", async () => {
    mockFetch([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ runId }: { runId: string }) => useRunEvents(runId), {
      wrapper: wrapperFor(queryClient),
      initialProps: { runId: WIRE_RUN_ID },
    });
    const first = FakeEventSource.last();
    rerender({ runId: "01987b11-0000-7000-8000-000000000000" });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.last().url).toContain(
      "/runs/01987b11-0000-7000-8000-000000000000/events",
    );
    expect(result.current.events).toHaveLength(0);
  });
});

describe("run fold (projectRun) — transcript-style application, ADR-0014", () => {
  /** The W5 sequence, scrambled the way a reconnect can deliver it. The
   * `node_execution_id` matches the `featureNodes` row at that key (index 6 of
   * the fixture's id scheme) — the same key the attempt events carry. */
  const frames: EventEnvelope[] = [
    wireRunEvent(
      "node.attempt.completed",
      {
        node_instance_key: "/build_until_verified[2]/implement",
        attempt_number: 2,
        outputs_digest: `sha256:${"9c".repeat(32)}`,
      },
      {
        run_id: featureRun.id,
        node_execution_id: "01J8NODE000006",
        attempt_id: "01J8ATTEMPT00000000000002",
        global_seq: 421,
      },
    ),
    wireRunEvent(
      "run.failed",
      { failed_cause: "node_execution_failed:/build_until_verified[2]/test" },
      { run_id: featureRun.id, global_seq: 423 },
    ),
    wireRunEvent(
      "node.attempt.started",
      { node_instance_key: "/build_until_verified[2]/implement", attempt_number: 2 },
      {
        run_id: featureRun.id,
        node_execution_id: "01J8NODE000006",
        attempt_id: "01J8ATTEMPT00000000000002",
        global_seq: 420,
      },
    ),
    wireRunEvent(
      "approval.decided",
      {
        approval_id: pendingApproval.id,
        decision: "approved",
        version: 2,
        decided_by: "usr_alice",
      },
      { run_id: featureRun.id, global_seq: 422 },
    ),
  ];

  it("dedupes repeated event_id/global_seq and folds in journal order regardless of arrival", () => {
    const withDuplicates = [
      ...frames,
      frames[1],
      { ...frames[0], event_id: "different-but-same-seq" },
    ];
    const normalized = normalizeRunFrames(withDuplicates);
    expect(normalized.map((frame) => frame.global_seq)).toEqual([420, 421, 422, 423]);
    // Same content, both arrival orders → identical projection.
    const scrambled = projectRun(
      { run: featureRun, nodes: featureNodes, approvals: [pendingApproval] },
      withDuplicates,
    );
    const ordered = projectRun(
      { run: featureRun, nodes: featureNodes, approvals: [pendingApproval] },
      [...frames].sort((a, b) => a.global_seq - b.global_seq),
    );
    expect(scrambled.nodes).toEqual(ordered.nodes);
    expect(scrambled.run).toEqual(ordered.run);
    expect(scrambled.approvals).toEqual(ordered.approvals);
  });

  it("paints node, attempt-bearing row, run and approval state from the frames", () => {
    const projection = projectRun(
      { run: featureRun, nodes: featureNodes, approvals: [pendingApproval] },
      frames,
    );
    const implement = projection.nodes.find(
      (node) => node.node_instance_key === "/build_until_verified[2]/implement",
    );
    expect(implement?.status).toBe("succeeded");
    expect(implement?.attempt_count).toBe(2);
    expect(projection.run?.status).toBe("failed");
    expect(projection.run?.failed_cause).toBe(
      "node_execution_failed:/build_until_verified[2]/test",
    );
    // The approval frame arrived before the fold could sort it into place; the
    // gate it names was on screen, so it closed on screen.
    expect(projection.approvals[0]).toMatchObject({
      state: "decided",
      decision: "approved",
      version: 2,
    });
  });

  it("a frame about a row this screen never received is a no-op, never an invented row", () => {
    const projection = projectRun({ nodes: featureNodes }, [
      wireRunEvent(
        "node.attempt.started",
        { node_instance_key: "/never_sent[9]/ghost" },
        { global_seq: 500 },
      ),
    ]);
    expect(projection.nodes).toEqual(featureNodes.map((node) => node));
    expect(projection.run).toBeNull();
  });

  it("run.cancel_requested is the request, not the stop (status unchanged)", () => {
    const projection = projectRun({ run: featureRun }, [
      wireRunEvent(
        "run.cancel_requested",
        { cascade: false },
        { run_id: featureRun.id, global_seq: 501 },
      ),
    ]);
    expect(projection.run?.status).toBe("running");
    expect(projection.run?.cancel_requested_at).not.toBeNull();
  });

  it("reused M2/M3 frames project to no run-event (consumers ignore what they do not know)", () => {
    const frame = wireRunEvent("workspace.prepared", { scope_kind: "run" }, { global_seq: 502 });
    expect(toRunEvent(frame)).toBeNull();
    const known = wireRunEvent(
      "node.scope.iteration",
      { node_instance_key: "/build_until_verified[2]", iteration: 3 },
      { global_seq: 503 },
    );
    expect(toRunEvent(known)?.type).toBe("node.scope.iteration");
  });
});
