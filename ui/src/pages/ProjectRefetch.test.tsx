/**
 * The overview must not turn the journal replay into a read storm (live lab:
 * opening `/projects/:id` issued 950 `GET /api/v1/projects/:id` in ~6s and the
 * browser died with `net::ERR_INSUFFICIENT_RESOURCES`).
 *
 * The project SSE scope replays the project's whole journal on connect, and the
 * feed invalidated every project query once per replayed frame — one invalida-
 * tion per round trip is one refetch per frame. Frames are therefore delivered
 * here interleaved with the fetches they trigger (one microtask between each),
 * which is how the server actually streams them.
 */
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

/** Deliver SSE frames one at a time, letting the fetch each frame triggers
 * complete before the next arrives — the interleaving a replaying server gives. */
async function emitInterleaved(source: FakeEventSource, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      source.emit(envelopeFixture({ global_seq: 200_000 + i, type: "repository.added" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("/projects/:projectId read storm", () => {
  it("reads the project a bounded number of times across a journal replay", async () => {
    const { requests } = renderApp({ path: `/projects/${projectId}`, routes });
    await screen.findByTestId("project-name");

    const source = FakeEventSource.instances.find(
      (instance) => instance.url === `${projectPath}/events`,
    );
    if (!source) throw new Error("the activity feed never opened the project event scope");
    act(() => source.open());

    await emitInterleaved(source, 40);
    // Let any queued invalidation-refetch land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const projectReads = requestsTo(requests, projectPath).length;
    expect(projectReads).toBeLessThanOrEqual(2);
  });

  it("still refetches the project once the coalescing window closes", async () => {
    const { requests } = renderApp({ path: `/projects/${projectId}`, routes });
    await screen.findByTestId("project-name");

    const source = FakeEventSource.instances.find(
      (instance) => instance.url === `${projectPath}/events`,
    );
    if (!source) throw new Error("the activity feed never opened the project event scope");
    act(() => source.open());

    act(() => source.emit(envelopeFixture({ global_seq: 300_001, type: "repository.added" })));
    // One invalidation per window, so past the window the dirty subtree must
    // have been refetched — coalescing must not drop the update.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_BATCH_MS + 500));
    });

    expect(requestsTo(requests, projectPath).length).toBe(2);
  });
});
