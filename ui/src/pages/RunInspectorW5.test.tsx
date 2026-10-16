/**
 * W5 (`docs/m4-contract.md` § 7.2): `docker kill` the owning worker mid-node.
 * The journal then holds `node.attempt.interrupted`, the engine schedules a
 * retry, and attempt 2 runs — and the *run page* has to say all three in the
 * contract's words: attempt 1 renders as "interrupted — the worker disappeared
 * mid-node", then the retry countdown read off `node.attempt.retry_scheduled`'s
 * `scheduled_at`, then attempt 2. "resumed", "restored" and "no data lost" must
 * never appear on the page (`10` J7's honesty rule).
 *
 * A fixture journal (interrupted → retry_scheduled → attempt 2 started →
 * completed) over a node detail that carries both attempts: the pane renders
 * every attempt of the node, and the Timeline tab names both frames.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { FakeEventSource, meFixture, projectFixture, type RouteStub } from "../test/fakes";
import type { Attempt, NodeExecution } from "../api/types";
import {
  WIRE_ATTEMPT_1,
  WIRE_NODE_IMPLEMENT,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApprovalList,
  wireAttempt,
  wireNodeDetail,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunEvent,
  wireRunList,
  wireTree,
} from "../test/fixtures/m4/wire";

/** Extra ids are local: `wire.ts` is shared with the other run tests. */
const ATTEMPT_2 = "01987b25-0001-7000-8000-abcdef012345";
const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const NODE_PATH = `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`;
const IMPLEMENT_KEY = "/build_until_verified[2]/implement";
const RETRY_AT = "2026-07-31T10:34:47Z";

/** Attempt 1: the worker died mid-turn, so its outcome is unknown. */
const interruptedAttempt: Attempt = {
  ...wireAttempt,
  id: WIRE_ATTEMPT_1,
  attempt_number: 1,
  status: "interrupted",
  error_class: "interrupted",
  detail: "the worker stopped answering its lease while the agent was mid-turn",
  scheduled_at: "2026-07-31T10:21:04Z",
  started_at: "2026-07-31T10:21:09Z",
  finished_at: "2026-07-31T10:33:47Z",
  outputs: null,
  outputs_digest: null,
  conversation_id: null,
  turn_id: null,
  retry_context: { mode: "continue_workspace", workspace_policy: "keep", attempt: 1 },
};

/** Attempt 2: the retry, which ran and finished clean. */
const replacementAttempt: Attempt = {
  ...wireAttempt,
  id: ATTEMPT_2,
  attempt_number: 2,
  status: "succeeded",
  error_class: undefined,
  detail: null,
  scheduled_at: RETRY_AT,
  started_at: "2026-07-31T10:34:52Z",
  finished_at: "2026-07-31T10:41:19Z",
  outputs: { summary: "Implemented the approved plan" },
  outputs_digest: `sha256:${"9c1f".repeat(16)}`,
  conversation_id: null,
  turn_id: null,
  retry_context: { mode: "continue_workspace", workspace_policy: "keep", attempt: 1 },
};

/** The node whose attempt was interrupted: two attempts, the node itself fine. */
const implementNode: NodeExecution = {
  ...wireNodeList.node_executions[2],
  id: WIRE_NODE_IMPLEMENT,
  node_instance_key: IMPLEMENT_KEY,
  status: "succeeded",
  attempt_count: 2,
};

/** W5's journal: interrupted → retry_scheduled → attempt 2 started → completed. */
function w5Journal(): ReturnType<typeof wireRunEvent>[] {
  const attemptFrames = [
    wireRunEvent(
      "node.attempt.started",
      { attempt_number: 1, node_instance_key: IMPLEMENT_KEY },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: WIRE_ATTEMPT_1, global_seq: 9301 },
    ),
    wireRunEvent(
      "node.attempt.interrupted",
      { attempt_number: 1, reason: "worker_gone", node_instance_key: IMPLEMENT_KEY },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: WIRE_ATTEMPT_1, global_seq: 9302 },
    ),
    wireRunEvent(
      "node.attempt.retry_scheduled",
      {
        attempt_number: 1,
        next_attempt_number: 2,
        scheduled_at: RETRY_AT,
        delay_seconds: 10,
        error_class: "interrupted",
        node_instance_key: IMPLEMENT_KEY,
      },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: WIRE_ATTEMPT_1, global_seq: 9303 },
    ),
    wireRunEvent(
      "node.attempt.started",
      { attempt_number: 2, node_instance_key: IMPLEMENT_KEY },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: ATTEMPT_2, global_seq: 9304 },
    ),
    wireRunEvent(
      "node.attempt.completed",
      { attempt_number: 2, outputs_digest: `sha256:${"9c1f".repeat(16)}` },
      { node_execution_id: WIRE_NODE_IMPLEMENT, attempt_id: ATTEMPT_2, global_seq: 9305 },
    ),
  ];
  return attemptFrames;
}

function mountW5(search = `?node=${WIRE_NODE_IMPLEMENT}`, extra: RouteStub[] = []) {
  const nodeDetail = { ...wireNodeDetail, attempts: [interruptedAttempt, replacementAttempt] };
  return renderApp({
    path: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}${search}`,
    routes: [
      ...extra,
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/users", body: { items: [meFixture] } },
      { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
      { path: "/api/v1/pipelines", body: wirePipelineList },
      { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
      {
        path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}/revisions`,
        body: { revisions: wirePipeline.revisions },
      },
      {
        path: `/api/v1/projects/${wireProjectId}/approvals`,
        body: { ...wireApprovalList, approvals: [] },
      },
      { path: `/api/v1/projects/${wireProjectId}/runs`, body: wireRunList },
      { path: RUN_PATH, body: wireRun },
      {
        path: `${RUN_PATH}/nodes`,
        body: { node_executions: [implementNode, ...wireNodeList.node_executions] },
      },
      { path: `${RUN_PATH}/tree`, body: wireTree },
      { path: NODE_PATH, body: nodeDetail },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`, body: nodeDetail },
      { path: `/api/v1/revisions/${wireRun.revision_digest}`, body: wireRevision },
      { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    ],
  });
}

/** The run stream this page opened (the pane may hold others). */
function runStream(): FakeEventSource {
  const source = FakeEventSource.instances.find(
    (instance) => instance.url === `${RUN_PATH}/events`,
  );
  if (!source) throw new Error(`no EventSource opened for ${RUN_PATH}/events`);
  return source;
}

describe("W5: the run page says an attempt was interrupted when its worker died", () => {
  it("renders every attempt of the node, attempt 1 as interrupted, then attempt 2", async () => {
    mountW5();
    await screen.findByTestId("run-title");
    act(() => {
      for (const frame of w5Journal()) runStream().emit(frame);
    });

    // Both attempts are on screen, in the order they happened (W11's list rule).
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent ?? "")
      .filter((text) => /ATTEMPT \d/.test(text));
    expect(headings.join(" | ")).toMatch(/ATTEMPT 1.*ATTEMPT 2/);
    expect(screen.getAllByTestId("attempt-status").map((chip) => chip.textContent)).toEqual([
      "interrupted",
      "succeeded",
    ]);

    // § 7.2 W5's exact wording, on the interrupted attempt.
    const note = screen.getByTestId("attempt-interrupted-note");
    expect(note.textContent).toContain("interrupted — the worker disappeared mid-node");

    // The retry countdown is the frame's own `scheduled_at`, not a guess.
    const countdown = screen.getByTestId("attempt-retry-countdown");
    expect(countdown.textContent).toContain("2026-07-31 10:34:47 UTC");
    expect(countdown.textContent).toContain("backoff 10s");

    // `10` J7: nothing on the page may claim the work carried on by itself.
    expect(document.body.textContent).not.toMatch(/resumed|restored|no data lost|picked up/i);
  });

  it("gives the interrupted frame and the retry its own rows in the Timeline tab", async () => {
    mountW5();
    await screen.findByTestId("run-title");
    act(() => {
      for (const frame of w5Journal()) runStream().emit(frame);
    });
    fireEvent.click(screen.getByTestId("run-tab-timeline"));

    const list = await screen.findByTestId("run-timeline");
    // The two frames a dead worker writes, in journal order, with the contract's
    // words — then attempt 2.
    expect(list.textContent).toContain("node.attempt.interrupted");
    expect(screen.getByTestId("run-timeline-copy-9302").textContent).toBe(
      "interrupted — the worker disappeared mid-node",
    );
    expect(screen.getByTestId("run-timeline-copy-9303").textContent).toBe(
      "retry scheduled — next attempt at 2026-07-31 10:34:47 UTC (in 10s)",
    );
    expect(list.textContent).toMatch(
      /node\.attempt\.interrupted.*retry scheduled.*node\.attempt\.started/s,
    );
    expect(list.textContent).not.toMatch(/resumed|restored|no data lost/i);
  });

  it("files each frame under the attempt it names, not only the newest one", async () => {
    mountW5();
    await screen.findByTestId("run-title");
    act(() => {
      for (const frame of w5Journal()) runStream().emit(frame);
    });

    // Attempt 1's own slice of the journal — the interruption and the retry it
    // owed; attempt 2's slice — its turn. Neither pane borrows the other's.
    const [first, second] = await screen.findAllByTestId("attempt-events");
    await waitFor(() => expect(first.querySelectorAll("li").length).toBe(3));
    expect(second.querySelectorAll("li").length).toBe(2);
    expect(first.textContent).toContain("node.attempt.interrupted");
    expect(first.textContent).toContain("node.attempt.retry_scheduled");
    expect(first.textContent).not.toContain("node.attempt.completed");
    expect(second.textContent).toContain("node.attempt.completed");
    expect(second.textContent).not.toContain("node.attempt.interrupted");
  });
});
