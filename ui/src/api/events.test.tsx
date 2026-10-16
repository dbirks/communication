/**
 * The journal stream's resume behaviour (M4 W10, ADR-0014 § 5/§ 9).
 *
 * What the live leg measured and could not forgive: after an api replica rolled,
 * the page re-opened the run stream with neither `Last-Event-ID` nor `?after=`,
 * i.e. from the journal head, and the document itself was replaced. Both are
 * client faults — the cursor is ours to send and nothing about a dropped socket
 * justifies a navigation. So the fake socket is failed by hand and the *next*
 * constructor call is inspected, plus the buffer that was on screen.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeUrl, useEventStream } from "./events";
import { FakeEventSource } from "../test/fakes";
import { wireRunEvent } from "../test/fixtures/m4/wire";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("resumeUrl (the ?after= cursor `api/openapi.yaml` defines)", () => {
  it("names the cursor only once a frame has been seen", () => {
    expect(resumeUrl("/api/v1/runs/r/events", 0)).toBe("/api/v1/runs/r/events");
    expect(resumeUrl("/api/v1/runs/r/events", -1)).toBe("/api/v1/runs/r/events");
    expect(resumeUrl("/api/v1/runs/r/events", 5100)).toBe("/api/v1/runs/r/events?after=5100");
    expect(resumeUrl("/api/v1/runs/r/events?live=1", 7)).toBe(
      "/api/v1/runs/r/events?live=1&after=7",
    );
  });
});

const TYPE = "node.attempt.started";

function streamOf(runId: string) {
  return renderHook(() =>
    useEventStream({
      url: `/api/v1/runs/${runId}/events`,
      types: [TYPE],
      keys: [runId],
    }),
  );
}

describe("useEventStream — reconnect, not reload", () => {
  it("opens the plain scope first and reports live on open", async () => {
    const { result } = streamOf("r1");
    const source = FakeEventSource.last();
    expect(source.url).toBe("/api/v1/runs/r1/events");
    expect(result.current.status).toBe("reconnecting");
    act(() => source.open());
    expect(result.current.status).toBe("live");
  });

  it("re-opens the same url with ?after=<last seen id> after the socket dies", async () => {
    vi.useFakeTimers();
    const { result } = streamOf("r2");
    const first = FakeEventSource.last();
    act(() => {
      first.open();
      first.emit(wireRunEvent(TYPE, { node_instance_key: "/plan" }, { global_seq: 5100 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.events.map((event) => event.global_seq)).toEqual([5100]);

    // The replica the stream was pinned to dies.
    act(() => first.fail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const second = FakeEventSource.last();
    expect(second).not.toBe(first);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(second.url).toBe("/api/v1/runs/r2/events?after=5100");
    // No navigation, no remount: the rows the page already drew are still drawn.
    expect(result.current.events.map((event) => event.global_seq)).toEqual([5100]);
    expect(result.current.status).toBe("reconnecting");
  });

  it("drops the frames a replay redelivers by id and keeps the new tail", async () => {
    vi.useFakeTimers();
    const { result } = streamOf("r3");
    const first = FakeEventSource.last();
    act(() => first.emit(wireRunEvent(TYPE, {}, { global_seq: 6000 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => first.fail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const second = FakeEventSource.last();
    // Replay from the cursor: what we drew (6000), a stale row (5999), the tail.
    for (const seq of [6000, 5999, 6001, 6002]) {
      act(() => second.emit(wireRunEvent(TYPE, {}, { global_seq: seq })));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.events.map((event) => event.global_seq)).toEqual([6000, 6001, 6002]);
  });

  it("backs off instead of hammering a restarting replica", async () => {
    vi.useFakeTimers();
    streamOf("r4");
    expect(FakeEventSource.instances).toHaveLength(1);
    for (const [wait, seen] of [
      [1_000, 2],
      [5_000, 3],
      [5_000, 4],
    ] as const) {
      act(() => FakeEventSource.last().fail());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait);
      });
      expect(FakeEventSource.instances).toHaveLength(seen);
    }
  });

  it("closes the socket and cancels the pending retry on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = streamOf("r5");
    const source = FakeEventSource.last();
    act(() => source.fail());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});
