/**
 * The overview must not turn the journal replay into a read storm (live lab:
 * opening `/projects/:id` issued 950 `GET /api/v1/projects/:id` in ~6s and the
 * browser died with `net::ERR_INSUFFICIENT_RESOURCES`).
 *
 * The project SSE scope replays the project's whole journal on connect, so the
 * feed coalesces its invalidations: every frame in a window dirties the id,
 * and one flush per `FRAME_BATCH_MS` performs at most one invalidation. The
 * replay is one fast burst on the wire, i.e. one window, so the page may read
 * the project at most once more than its mount read.
 *
 * The clocks here are fake on purpose: the coalescing window is measured in
 * wall time by the source, and a slow machine used to stretch the real-clock
 * replay loop past the window boundary, firing extra — perfectly legitimate —
 * flushes the bound does not account for. Under fake time the replay occupies
 * no window at all, and window boundaries advance only when a test says so.
 */
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { FRAME_BATCH_MS } from "../api/events";
import {
  FakeEventSource,
  envelopeFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;

const routes: RouteStub[] = [
  { path: "/api/v1/me", body: meFixture },
  { path: projectPath, method: "GET", body: projectFixture },
  { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
  { path: `${projectPath}/members`, method: "GET", body: { items: [] } },
  { path: "/api/v1/users", method: "GET", body: { items: [] } },
  { path: `${projectPath}/approvals`, method: "GET", body: { approvals: [] } },
  { path: `${projectPath}/runs`, method: "GET", body: { runs: [] } },
  { path: `${projectPath}/conversations`, method: "GET", body: { items: [] } },
  { path: `${projectPath}/artifacts`, method: "GET", body: { artifacts: [] } },
  { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [] } },
  { path: "/api/v1/pipelines", method: "GET", body: { pipelines: [] } },
];

/** Flush the microtask queue (the mocked fetches resolve with no real time)
 * and let the React commits they cause land. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Let the mount's reads (and the children they unmount) land while every
 * clock is fake. */
async function landMountReads(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

/** Deliver SSE frames one at a time, settling React between them — how a
 * replaying server streams them. No fake window time elapses per frame, so a
 * slow machine can never stretch the replay across a coalescing boundary. */
async function emitInterleaved(source: FakeEventSource, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    act(() => {
      source.emit(envelopeFixture({ global_seq: 200_000 + i, type: "repository.added" }));
    });
    await settle();
  }
}

describe("/projects/:projectId read storm", () => {
  it("reads the project a bounded number of times across a journal replay", async () => {
    vi.useFakeTimers();
    try {
      const { requests } = renderApp({ path: `/projects/${projectId}`, routes });
      await landMountReads();
      screen.getByTestId("project-name");

      const source = FakeEventSource.instances.find(
        (instance) => instance.url === `${projectPath}/events`,
      );
      if (!source) throw new Error("the activity feed never opened the project event scope");
      act(() => source.open());

      await emitInterleaved(source, 40);
      // Let any queued invalidation-refetch land — the replay occupied no
      // window, so at most the mount read plus one coalesced refetch may exist.
      await settle();
      await settle();

      expect(requestsTo(requests, projectPath).length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still refetches the project once the coalescing window closes", async () => {
    vi.useFakeTimers();
    try {
      const { requests } = renderApp({ path: `/projects/${projectId}`, routes });
      await landMountReads();
      screen.getByTestId("project-name");

      const source = FakeEventSource.instances.find(
        (instance) => instance.url === `${projectPath}/events`,
      );
      if (!source) throw new Error("the activity feed never opened the project event scope");
      act(() => source.open());
      await settle();

      act(() => {
        source.emit(envelopeFixture({ global_seq: 300_001, type: "repository.added" }));
      });
      // One invalidation per window: advance past the window and the dirty
      // subtree must have been refetched — coalescing must not drop the update.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_BATCH_MS + 500);
      });
      await settle();

      expect(requestsTo(requests, projectPath).length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
