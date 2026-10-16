/**
 * Live mode: every screen mounted against the frozen M4 routes — served by
 * the fake fetch and the fake EventSource, because the Go control plane does
 * not answer these routes yet (a concurrent worker is building them). This
 * proves the wiring (paths, payload mapping, event application); the § 7
 * W-legs re-run the same page in a browser against the real server later.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FakeEventSource,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { renderApp } from "../test/render";
import {
  WIRE_CHILD_PIPELINE_ID,
  WIRE_NODE_IMPLEMENT,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wireAssignmentList,
  wireDraftSummaries,
  wireNodeDetail,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunEvent,
  wireTree,
} from "../test/fixtures/m4/wire";

/**
 * Wait budgets for real async boundaries, not a retry policy.
 *
 * `findBy*` waits 1000 ms by default, which measures the runner rather than the
 * page: on an idle box the live mount paints in ~320 ms and its first library
 * row arrives ~100 ms later, but with the CPU oversubscribed ~2x the mount
 * measured 1.6 s and a single mocked read 1.4 s — and the whole test was seen
 * past vitest's 5000 ms watchdog. The budgets below are those measurements with
 * headroom, and they are only ever applied where an actual boundary exists:
 * `MOUNT_MS` for the lazy route chunk's first paint, `READ_MS` for one
 * `/api/v1` round trip through the fake fetch and the repaint it causes.
 */
const MOUNT_MS = 10_000;
const READ_MS = 5_000;
/** Every boundary one test can still be waiting on, summed, as its watchdog. */
const TEST_TIMEOUT = MOUNT_MS + 6 * READ_MS;

beforeAll(async () => {
  // Warm the chunk `App` mounts lazily — it pulls the blocks and the fixture
  // graph with it — so no module load sits inside a render assertion.
  await import("./M4Preview");
});

const decidedApproval: RouteStub = {
  path: `/api/v1/approvals/${wireApproval.id}/decide`,
  method: "POST",
  body: {
    ...wireApproval,
    state: "decided",
    decision: "approved",
    decided_by: meFixture.id,
    version: 2,
  },
};

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}/drafts`, body: wireDraftSummaries },
    {
      path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`,
      body: { ...wirePipeline, id: WIRE_CHILD_PIPELINE_ID, slug: "module-check" },
    },
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}/drafts`, body: { drafts: [] } },
    { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    { path: `/api/v1/runs/${WIRE_RUN_ID}`, body: wireRun },
    { path: `/api/v1/runs/${WIRE_RUN_ID}/nodes`, body: wireNodeList },
    { path: `/api/v1/runs/${WIRE_RUN_ID}/tree`, body: wireTree },
    { path: `/api/v1/runs/${WIRE_RUN_ID}/nodes/${WIRE_NODE_IMPLEMENT}`, body: wireNodeDetail },
    { path: `/api/v1/projects/${wireProjectId}/approvals`, body: wireApprovalList },
    decidedApproval,
  ];
}

function mountLive() {
  return renderApp({
    path: `/__m4-preview?source=live&project=${wireProjectId}&run=${WIRE_RUN_ID}`,
    routes: routes(),
  });
}

/** Walk the tree down to the in-flight `implement` execution — loop heading,
 * scope place, node. The tree starts collapsed because a run inspector earns
 * its depth one click at a time. */
function expandToImplement() {
  fireEvent.click(screen.getByTestId("run-tree-toggle-/build_until_verified"));
  fireEvent.click(screen.getByTestId("run-tree-toggle-/build_until_verified[1]"));
}

describe("M4 live preview (fixture seam → real routes)", () => {
  it(
    "renders the library, the pinned revision, the run inspector and the gates from the wire",
    async () => {
      const { requests } = mountLive();

      // The mode bar (the lazy preview chunk lands a tick late).
      const notice = await screen.findByTestId("m4-live-notice", undefined, { timeout: MOUNT_MS });
      expect(notice.textContent).toMatch(/LIVE, FROM \/api\/v1/);

      // Library: the list route + the per-definition fan (summaries carry no
      // revisions, drafts or channel facts — the rows say what they read).
      await screen.findByTestId("pipeline-name-feature-development", undefined, {
        timeout: READ_MS,
      });
      const row = screen.getByTestId("pipeline-row-feature-development");
      expect(row.textContent).toContain("latest published r7");
      expect(
        within(row).getByTestId("pipeline-no-channel-feature-development").textContent,
      ).toContain("no channel set");
      expect(
        within(row).getByTestId("pipeline-validation-feature-development").textContent,
      ).toContain("draft has findings");
      expect(requestsTo(requests, `/api/v1/pipelines/${WIRE_PIPELINE_ID}/drafts`)).toHaveLength(1);

      // Pinned revision: assignment → revision record → YAML + graph.
      await screen.findByTestId("yaml-view-label", undefined, { timeout: READ_MS });
      expect(screen.getAllByTestId("yaml-view-label").at(-1)?.textContent).toContain("7.0.0");
      expect(screen.getAllByTestId(/^definition-graph-list-/).length).toBeGreaterThanOrEqual(4);
      expect(requestsTo(requests, `/api/v1/revisions/${WIRE_REVISION_ID}`)).toHaveLength(1);

      // Run inspector: identity line, stage cells, tree rows.
      await screen.findByTestId("m4-live-run-identity", undefined, { timeout: READ_MS });
      expect(screen.getByTestId("m4-live-run-identity").textContent).toContain("status running");
      expect(screen.getByTestId("run-stage-cell-plan")).toBeTruthy();
      expect(screen.getByTestId("run-stage-cell-build_until_verified")).toBeTruthy();
      expect(screen.getByTestId("run-tree-row-/plan").textContent).toContain("succeeded");

      // The child run joins through the tree route and the library's slug map —
      // the wire only carries `pipeline_id`, so a `module-check` label on screen
      // is the mapping doing its job. It is on screen *without* the reader
      // opening the branch that invoked it (W11: every child the route reports
      // is reachable), and still names the invocation that made it.
      const childRow = screen.getByTestId(`run-tree-row-run:${wireTree.children[0].run.id}`);
      expect(childRow.textContent).toContain("module-check");
      expect(childRow.textContent).toContain("invoked by /build_until_verified[1]/implement");

      // Select the execution → its attempt history (route 25) and checkpoint.
      expandToImplement();
      fireEvent.click(
        within(screen.getByTestId("run-tree-row-/build_until_verified[1]/implement")).getByRole(
          "button",
          { name: /^implement/ },
        ),
      );
      await screen.findByTestId("attempt-status", undefined, { timeout: READ_MS });
      expect(screen.getAllByTestId("attempt-status").at(-1)?.textContent).toContain("running");
      expect(screen.getByTestId("attempt-checkpoint-volume").textContent).toContain("sha256:");
      expect(
        requestsTo(requests, `/api/v1/runs/${WIRE_RUN_ID}/nodes/${WIRE_NODE_IMPLEMENT}`).length,
      ).toBeGreaterThan(0);

      // Gates: pending card with the decision form (the caller is a named approver).
      await screen.findByTestId("approval-summary", undefined, { timeout: READ_MS });
      expect(screen.getByTestId("approval-approve")).toBeTruthy();

      fireEvent.click(screen.getByTestId("approval-approve"));
      await waitFor(
        () =>
          expect(
            requestsTo(requests, `/api/v1/approvals/${wireApproval.id}/decide`, "POST"),
          ).toHaveLength(1),
        { timeout: READ_MS },
      );
      const post = requestsTo(requests, `/api/v1/approvals/${wireApproval.id}/decide`, "POST")[0];
      expect(JSON.parse(String(post.body))).toEqual({ decision: "approved", version: 1 });
      expect(post.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
    },
    TEST_TIMEOUT,
  );

  it(
    "the run stream paints the tree before any refetch does",
    async () => {
      const { requests } = mountLive();
      // First paint of the lazy chunk plus the run, node and tree reads.
      await screen.findByTestId("m4-live-run-identity", undefined, { timeout: MOUNT_MS });
      const source = FakeEventSource.last();
      expect(source.url).toBe(`/api/v1/runs/${WIRE_RUN_ID}/events`);
      act(() => source.open());
      await waitFor(
        () => expect(screen.getByTestId("m4-live-stream-status").textContent).toBe("live"),
        { timeout: READ_MS },
      );
      expandToImplement();

      const rowKey = "/build_until_verified[1]/implement";
      expect(screen.getByTestId(`run-tree-row-${rowKey}`).textContent).toContain("running");
      const requestsBefore = requests.length;

      act(() =>
        source.emit(
          wireRunEvent(
            "node.attempt.completed",
            { node_instance_key: rowKey, attempt_number: 1, outputs: { files: 1 } },
            {
              node_execution_id: WIRE_NODE_IMPLEMENT,
              attempt_id: "01987b25-0000-7000-8000-abcdef012345",
            },
          ),
        ),
      );
      // The frame alone repaints the chip — the invalidation it also fires proves
      // ADR-0014's other half (the next read confirms what the stream painted).
      await waitFor(
        () =>
          expect(screen.getByTestId(`run-tree-row-${rowKey}`).textContent).toContain("succeeded"),
        { timeout: READ_MS },
      );
      expect(requests.length).toBeGreaterThan(requestsBefore);

      // A replay below the cursor is dropped at the stream floor, so the row
      // cannot walk backwards over its own history.
      act(() =>
        source.emit(
          wireRunEvent(
            "node.attempt.started",
            { node_instance_key: rowKey, attempt_number: 1 },
            { node_execution_id: WIRE_NODE_IMPLEMENT, global_seq: 1 },
          ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByTestId(`run-tree-row-${rowKey}`).textContent).toContain("succeeded");
    },
    MOUNT_MS + 2 * READ_MS,
  );

  it(
    "a 404 problem from a route the server does not answer yet reads as a problem, not a crash",
    async () => {
      // Drop the run/gate stubs: `mockFetch` answers 404 problem+json for
      // unknown paths — the honest state of a control plane that has not landed.
      renderApp({
        path: `/__m4-preview?source=live&project=${wireProjectId}&run=${WIRE_RUN_ID}`,
        routes: routes().filter(
          (stub) => !stub.path.startsWith("/api/v1/runs/") && !stub.path.includes("approvals"),
        ),
      });
      await screen.findByTestId("m4-live-run-error", undefined, { timeout: MOUNT_MS });
      expect(screen.getByTestId("m4-live-run-error").textContent).toMatch(/Not found/i);
      // The rest of the page still stands — the library is not hostage to the
      // run. Awaits its own reads, so this proves the library *painted*, not
      // merely that it had not been unmounted yet.
      await screen.findByTestId("pipeline-name-feature-development", undefined, {
        timeout: READ_MS,
      });
    },
    MOUNT_MS + READ_MS,
  );
});
