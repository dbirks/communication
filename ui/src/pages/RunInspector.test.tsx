/**
 * The run inspector, mounted on its route (`/projects/:id/runs/:runId`) outside
 * the Run Workbench that now owns that route: header verbs, the Definition |
 * Execution | Timeline panes, and a node selection that lives in `?node=` so a
 * pane is linkable. Served by the fake fetch and the fake EventSource — the
 * same doubles that prove `/__m4-preview?source=live`.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeEventSource,
  claudeProfile,
  controlledByOther,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  permissionRequestFixture,
  projectFixture,
  requestsTo,
  turnId,
  type RouteStub,
} from "../test/fakes";
import { mountRunPage } from "../test/inspectorMount";
import { routes as appRoutes } from "../lib/routes";
import RunInspector, {
  attentionNodeId,
  diagnosticsLayoutFor,
  retryVerdict,
  type DiagnosticsLayout,
} from "./RunInspector";
import type { NodeExecution } from "../api/types";
import type { NodeExecutionSummary } from "../lib/pipeline/contract";
import { viewNodeExecution } from "../api/m4view";
import { shortDigest } from "../lib/pipeline/yamlPointer";
import {
  WIRE_ATTEMPT_1,
  WIRE_NODE_IMPLEMENT,
  WIRE_NODE_PLAN,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wireCheckpoint,
  wireNodeDetail,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunEvent,
  wireRunList,
  wireAttempt,
  wireTree,
} from "../test/fixtures/m4/wire";

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const PAUSE_PATH = `${RUN_PATH}/pause`;
const WIRE_NODE_APPROVE = "01987b24-0009-7000-8000-abcdef012345";
const WIRE_NODE_EACH = "01987b24-000a-7000-8000-abcdef012345";
const WIRE_NODE_MOD_1 = "01987b24-000b-7000-8000-abcdef012345";
const WIRE_NODE_MOD_2 = "01987b24-000c-7000-8000-abcdef012345";

/** The same run fanned out instead of looped: `/verify_each` declared 3 items,
 * item 1 came back clean, item 2 is red, item 3 has not started. The grid's
 * cell count is the scope's own `items`, so the third cell must be drawn. */
const wireFanOutNodes: NodeExecution[] = [
  {
    ...wireNodeList.node_executions[1],
    id: WIRE_NODE_EACH,
    node_id: "verify_each",
    kind: "for_each",
    node_instance_key: "/verify_each",
    status: "running",
    iterations: undefined,
    items: 3,
    in_flight: 1,
    attempt_count: 0,
  },
  {
    ...wireNodeList.node_executions[2],
    id: WIRE_NODE_MOD_1,
    node_id: "check_module",
    node_instance_key: "/verify_each[1]/check_module",
    scope_key: "/verify_each[1]",
    status: "succeeded",
  },
  {
    ...wireNodeList.node_executions[2],
    id: WIRE_NODE_MOD_2,
    node_id: "check_module",
    node_instance_key: "/verify_each[2]/check_module",
    scope_key: "/verify_each[2]",
    status: "failed",
    failed_cause: "module check exited 1",
  },
];

/** The same run held at its gate: `approve` waits for a human and nothing else
 * has started. The wire fixture is a run mid-loop, which proves the other
 * half of the auto-select rule. */
const wireWaitingNodes: NodeExecution[] = [
  {
    ...wireNodeList.node_executions[0],
    id: WIRE_NODE_APPROVE,
    node_id: "approve",
    kind: "human.approval",
    node_instance_key: "/approve",
    status: "waiting",
    waiting_reason: "approval",
    finished_at: null,
  },
  ...wireNodeList.node_executions,
];

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: PAUSE_PATH, method: "POST", body: { ...wireRun, status: "paused" } },
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
    { path: `${RUN_PATH}/nodes`, body: wireNodeList },
    { path: `${RUN_PATH}/tree`, body: wireTree },
    { path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: wireNodeDetail },
    { path: `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`, body: wireNodeDetail },
    { path: `/api/v1/revisions/${wireRun.revision_digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
  ];
}

function mountRun(search = "", extra: RouteStub[] = []): ReturnType<typeof mountRunPage> {
  return mountRunPage({
    path: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}${search}`,
    routes: routes(extra),
    element: <RunInspector />,
  });
}

describe(`/projects/:projectId/runs/:runId`, () => {
  it("renders the header, the run's status and the three view tabs", async () => {
    mountRun();

    const title = await screen.findByTestId("run-title");
    expect(title.textContent).toMatch(/^Run #/);
    expect(screen.getByTestId("run-header-status").textContent).toContain("running");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByTestId("run-tab-definition")).toBeTruthy();
    expect(screen.getByTestId("run-tab-execution")).toBeTruthy();
    expect(screen.getByTestId("run-tab-timeline")).toBeTruthy();
    // The design's left column is the project's section rail, at `Runs` — the
    // runs list is not on the run page (`10` has none; it lives on the
    // project's Runs tab), so the rail is the way back to it.
    const rail = await screen.findByRole("navigation", { name: "Project sections" });
    const runsLink = within(rail).getByRole("link", { name: "Runs" });
    expect(runsLink.getAttribute("href")).toBe(appRoutes.projectTab(wireProjectId, "runs"));
    expect(screen.queryByTestId("runs-list")).toBeNull();
    expect(screen.queryByTestId(`run-row-${WIRE_RUN_ID}`)).toBeNull();
  });

  it("4a: the stage strip rides above the tabs, on every tab", async () => {
    // 4a draws the strip as the run's compact header, not as content that
    // hides behind a tab — so it answers before anyone clicks Execution.
    const { requests } = mountRun();
    await screen.findByTestId("run-stage-strip");
    // The graph arrives with the pinned revision read, which is its own frame
    // after the strip's first paint (the strip needs only the run's rows). The
    // old synchronous read passed because the runs column's request kept the
    // query queue busy through this tick; the strip's contract — it rides above
    // the tabs on every tab — is unchanged.
    expect(await screen.findByTestId("definition-graph")).toBeTruthy();

    fireEvent.click(screen.getByTestId("run-tab-timeline"));
    expect(screen.getByTestId("run-stage-strip")).toBeTruthy();
    // Selecting from the strip works from any tab: the pane reads the cell's node.
    fireEvent.click(screen.getByTestId("run-stage-cell-plan"));
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`)).toHaveLength(1),
    );
  });
  it("W4: shows the pinned-revision notice only when a newer revision is published", async () => {
    // The run's pinned r7 is the newest published revision: 12 case 11 must
    // stay invisible when nothing newer exists.
    const quiet = mountRun();
    await screen.findByTestId("run-title");
    await waitFor(() =>
      expect(
        requestsTo(quiet.requests, `/api/v1/pipelines/${WIRE_PIPELINE_ID}/revisions`),
      ).toHaveLength(1),
    );
    expect(screen.queryByTestId("run-new-revision-notice")).toBeNull();
    cleanup();

    // Another tab publishes r8 while this run is live; the reload says so —
    // the exact § 7.2 wording — and still shows the pinned digest (§ 7 W4).
    const newer = {
      revisions: [
        {
          ...wirePipeline.revisions[0],
          revision_number: 8,
          version_label: "8.0.0",
          revision_digest: `sha256:${"c".repeat(64)}`,
        },
        ...wirePipeline.revisions,
      ],
    };
    mountRun("", [{ path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}/revisions`, body: newer }]);

    const notice = await screen.findByTestId("run-new-revision-notice");
    expect(notice.textContent).toContain(
      "revision 8 published since this run started — this run is pinned to 7",
    );
    expect(screen.getByTestId("run-new-revision-link").getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}`,
    );
    // The pinned identity the run started with is unchanged on the page.
    expect(screen.getByTestId("run-title").textContent).toMatch(/^Run #/);
  });

  it("opens on Definition with the graph, and pre-selects what the run waits on", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("run-title");

    expect(await screen.findByTestId("definition-graph")).toBeTruthy();
    expect(requestsTo(requests, `/api/v1/revisions/${wireRun.revision_digest}`)).toHaveLength(1);
    // This run is mid-loop, so the node in flight is what the pane shows — the
    // scope row above it owns no attempt of its own and is skipped.
    expect(await screen.findByTestId("attempt-status")).toBeTruthy();
    expect(screen.queryByTestId("run-detail-none")).toBeNull();
    // The pick is raised on the canvas too, so graph and pane agree.
    expect(
      (
        await screen.findByTestId("definition-graph-node-build_until_verified-implement")
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    // Execution is one tab away, not the first thing a reader meets.
    fireEvent.click(screen.getByTestId("run-tab-execution"));
    expect(await screen.findByTestId("run-stage-strip")).toBeTruthy();
    expect(screen.getByTestId("run-tree")).toBeTruthy();
  });

  it("opens a run waiting at its gate on the gate, with the decision wired", async () => {
    const { requests } = mountRun("", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
      {
        path: `/api/v1/projects/${wireProjectId}/approvals`,
        body: {
          ...wireApprovalList,
          approvals: [{ ...wireApproval, node_execution_id: WIRE_NODE_APPROVE }],
        },
      },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_APPROVE}`, body: wireNodeDetail },
      {
        path: `/api/v1/approvals/${wireApproval.id}/decide`,
        method: "POST",
        body: { ...wireApproval, state: "approved", decision: "approved" },
      },
    ]);

    // The reader lands on the thing they owe an answer to: no click first.
    expect(await screen.findByTestId("approval-summary")).toBeTruthy();
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
    expect(screen.getByTestId("approval-reject")).toBeTruthy();
    expect(
      (await screen.findByTestId("definition-graph-node-approve")).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/approvals/${wireApproval.id}/decide`, "POST"),
      ).toHaveLength(1),
    );
  });

  it("shows the gate card for a node with no attempts at all", async () => {
    // A control-plane approval gate never has attempts (attempt_count=0), so
    // the pane must not spin on "Reading attempts…" forever — the decision is
    // the only thing there to read.
    mountRun("", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
      {
        path: `/api/v1/projects/${wireProjectId}/approvals`,
        body: {
          ...wireApprovalList,
          approvals: [{ ...wireApproval, node_execution_id: WIRE_NODE_APPROVE }],
        },
      },
      {
        path: `${RUN_PATH}/nodes/${WIRE_NODE_APPROVE}`,
        body: { ...wireNodeDetail, attempts: [], checkpoint: null },
      },
    ]);

    expect(await screen.findByTestId("approval-summary")).toBeTruthy();
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
    expect(screen.queryByTestId("run-detail-pending")).toBeNull();
    expect(screen.queryByTestId("attempt-status")).toBeNull();
  });

  it("says so honestly for a loaded node with no attempts and no gate", async () => {
    mountRun(`?node=${WIRE_NODE_PLAN}`, [
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: { ...wireNodeDetail, attempts: [] } },
    ]);

    const line = await screen.findByTestId("run-detail-no-attempts");
    expect(line.textContent).toContain("/plan");
    expect(line.textContent).toContain("succeeded");
    expect(screen.queryByTestId("run-detail-pending")).toBeNull();
  });

  it("a graph click on a scoped node fills the pane for that iteration", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("definition-graph");

    // The graph's key drops the `[1]` the run's instance key carries; the click
    // still has to land on a node execution, or the pane stays empty.
    fireEvent.click(screen.getByTestId("definition-graph-node-build_until_verified-implement"));
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`)).toHaveLength(1),
    );
    expect(screen.getByTestId("attempt-status").textContent).toContain("running");
    // The selection survives a tab change — it lives in `?node=`, not in
    // component state a tab switch would drop.
    fireEvent.click(screen.getByTestId("run-tab-execution"));
    expect(screen.getByTestId("attempt-status").textContent).toContain("running");
  });

  it("uses the whole viewport, with the panes at the run view's widths", async () => {
    mountRun();
    await screen.findByTestId("run-title");
    const inspector = screen.getByTestId("run-inspector");
    // The shell's centred column is ~64rem; the inspector reports the viewport it
    // bled out to instead, and the wide grid template is on the element itself.
    expect(inspector.getAttribute("data-full-width")).toBe(
      String(document.documentElement.clientWidth || window.innerWidth),
    );
    // The rail is the 160px column every other project screen gives it, and it
    // is always there: no runs column, so no collapse control and no 2.25rem
    // shut variant of the template.
    expect(inspector.className).toContain("xl:grid-cols-[10rem_minmax(0,1fr)");
    expect(screen.getByTestId("run-inspector-detail")).toBeTruthy();
    expect(screen.queryByTestId("run-nav-collapse")).toBeNull();
    expect(screen.queryByTestId("run-nav-expand")).toBeNull();
    // The rail's Runs link is how the reader gets back to the list.
    const rail = screen.getByTestId("run-inspector-nav");
    expect(within(rail).getByRole("link", { name: "Runs" })).toBeTruthy();
  });

  it("selects a node from the definition graph into the URL and the right pane", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("definition-graph");

    fireEvent.click(screen.getByTestId("definition-graph-node-plan"));

    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`)).toHaveLength(1),
    );
    expect(await screen.findByTestId("attempt-status")).toBeTruthy();
    // The graph box carries the pressed state, so the selection is visible on the
    // canvas and not only in the URL.
    expect(screen.getByTestId("definition-graph-node-plan").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("selects a node from the stage strip into the right pane and the URL", async () => {
    const { requests } = mountRun("?tab=execution");
    await screen.findByTestId("run-stage-strip");

    fireEvent.click(screen.getByTestId("run-stage-cell-plan"));

    // The detail read is keyed by node execution id — the handle `?node=` carries.
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`)).toHaveLength(1),
    );
    expect(await screen.findByTestId("attempt-status")).toBeTruthy();
    // The same node is raised in the tree.
    expect(screen.getByTestId("run-tree-row-/plan").getAttribute("aria-selected")).toBe("true");
  });

  it("reads ?node= on first paint, so a selection is linkable", async () => {
    const { requests } = mountRun(`?node=${WIRE_NODE_IMPLEMENT}`);

    expect(await screen.findByTestId("attempt-status")).toBeTruthy();
    expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`)).toHaveLength(1);
  });

  it("names the pane's node 4a-style: stage · place · attempt", async () => {
    // `/build_until_verified[1]/implement` is an `until` pass, so the crumb
    // says `iter`, and the attempt shown is the one the pane reads.
    mountRun(`?node=${WIRE_NODE_IMPLEMENT}`);
    expect((await screen.findByTestId("node-pane-crumb")).textContent).toBe(
      "implement \u00b7 iter 1 \u00b7 attempt 1",
    );
    expect(screen.getByTestId("node-pane-key").textContent).toBe(
      "/build_until_verified[1]/implement",
    );
  });

  it("calls a for_each item task in the pane crumb, like the branch history does", async () => {
    mountRun(`?tab=execution&branch=1&node=${WIRE_NODE_MOD_1}`, [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireFanOutNodes } },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_MOD_1}`, body: wireNodeDetail },
    ]);
    await screen.findByTestId("branch-grid");

    expect((await screen.findByTestId("node-pane-crumb")).textContent).toBe(
      "check_module \u00b7 task 1 \u00b7 attempt 1",
    );
  });

  it("shows the pinned revision in the Definition tab, not the library's newest", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("run-title");

    fireEvent.click(screen.getByTestId("run-tab-definition"));
    expect(await screen.findByTestId("definition-graph")).toBeTruthy();
    expect(requestsTo(requests, `/api/v1/revisions/${wireRun.revision_digest}`)).toHaveLength(1);
  });

  it("lists the stage cells in definition order, not the API's alphabetical one", async () => {
    mountRun("?tab=execution");
    await screen.findByTestId("run-stage-strip");
    const cells = screen
      .getAllByTestId(/^run-stage-cell-/)
      .map((cell) => cell.getAttribute("data-testid")!.replace("run-stage-cell-", ""));
    // The wire fixture's three rows, in the order the pinned document declares
    // them. The API answers in instance-key order, which would read
    // `build_until_verified`, `implement`, `plan` — the loop before the node that
    // leads to it.
    expect(cells).toEqual(["plan", "build_until_verified", "implement"]);
    // The failed row says its own name, and a terminal row says nothing is in
    // flight.
    const planRow = await screen.findByTestId("run-tree-row-/plan");
    expect(planRow.textContent).toContain("plan");
    expect(planRow.textContent).not.toContain("in flight");
  });

  it("lists the stream's frames in Timeline, oldest first", async () => {
    mountRun("?tab=timeline");
    await screen.findByTestId("run-title");
    expect(screen.getByTestId("run-timeline-empty").textContent).toContain("No run events yet");
  });

  it("draws the branch grid for the run's for_each scope under the strip", async () => {
    mountRun("?tab=execution", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireFanOutNodes } },
    ]);
    const strip = await screen.findByTestId("run-stage-strip");
    const grid = await screen.findByTestId("branch-grid");

    // The grid goes under the stage strip, not instead of it.
    expect(strip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One cell per declared item — the third has no rows yet and is still drawn.
    expect(screen.getAllByTestId(/^branch-cell-/)).toHaveLength(3);
    expect(screen.getByTestId("branch-cell-3").getAttribute("data-branch-state")).toBe("queued");
    expect(screen.getByTestId("branch-counts").textContent).toContain("3 branches");
    expect(screen.getByTestId("branch-counts").textContent).toContain("1 failed");
    // Stuck first by default, so the red item leads the grid.
    expect(cells()[0]).toBe("branch-cell-2");
    // Nothing picked, so no history — an empty strip would claim the branch ran nothing.
    expect(screen.getByTestId("branch-history-empty").textContent).toContain("select a branch");
  });

  it("a branch cell click selects that branch's latest execution and keeps the branch in the URL", async () => {
    const { requests } = mountRun("?tab=execution", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireFanOutNodes } },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_MOD_1}`, body: wireNodeDetail },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_MOD_2}`, body: wireNodeDetail },
    ]);
    await screen.findByTestId("branch-grid");

    fireEvent.click(screen.getByTestId("branch-cell-1"));

    // `?node=` moved to the branch's own execution: the pane reads that row.
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_MOD_1}`)).toHaveLength(1),
    );
    // `?branch=` rides along: the cell stays raised after the selection lands,
    // and the history strip names it — both read the URL, not local state.
    expect(screen.getByTestId("branch-cell-1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("branch-history").textContent).toContain("task 1");
    expect(screen.getByTestId("branch-history").textContent).toContain("check_module");
    // And it survives the tab switch a shared link forces.
    fireEvent.click(screen.getByTestId("run-tab-definition"));
    fireEvent.click(screen.getByTestId("run-tab-execution"));
    await screen.findByTestId("branch-grid");
    expect(screen.getByTestId("branch-cell-1").getAttribute("aria-current")).toBe("true");
  });

  it("raises a queued branch on click even though it owns no execution yet", async () => {
    const { requests } = mountRun("?tab=execution", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireFanOutNodes } },
    ]);
    await screen.findByTestId("branch-grid");

    fireEvent.click(screen.getByTestId("branch-cell-3"));

    expect(screen.getByTestId("branch-cell-3").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("branch-history-none").textContent).toContain("queued");
    // No row is invented for a branch the run has not reached — the pane keeps
    // reading the node the run is actually stopped on.
    expect(requestsTo(requests, `${RUN_PATH}/nodes/nx_verify_each_3`)).toHaveLength(0);
  });

  it("reads ?branch= on first paint, so a branch view is linkable", async () => {
    const { requests } = mountRun(`?tab=execution&branch=1&node=${WIRE_NODE_MOD_1}`, [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireFanOutNodes } },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_MOD_1}`, body: wireNodeDetail },
    ]);
    await screen.findByTestId("branch-grid");

    expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_MOD_1}`).length).toBeGreaterThan(0);
    expect(screen.getByTestId("branch-cell-1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("branch-history").textContent).toContain("task 1");
  });

  it("filters the timeline to failures, and selects a row's node on click", async () => {
    const { requests } = mountRun("?tab=timeline");
    await screen.findByTestId("run-title");

    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "node.attempt.started",
          {
            node_instance_key: "/plan",
            attempt_number: 1,
          },
          { node_execution_id: WIRE_NODE_PLAN, global_seq: 9101 },
        ),
      );
      FakeEventSource.last().emit(
        wireRunEvent(
          "node.attempt.failed",
          {
            node_instance_key: "/plan",
            attempt_number: 1,
            error_class: "agent_error",
            detail: "agent exited 1",
          },
          { node_execution_id: WIRE_NODE_PLAN, global_seq: 9102 },
        ),
      );
      FakeEventSource.last().emit(
        wireRunEvent(
          "approval.requested",
          {
            node_instance_key: "/approve",
            approval_id: wireApproval.id,
          },
          {
            node_execution_id: WIRE_NODE_APPROVE,
            global_seq: 9103,
            actor: { kind: "human", id: meFixture.id },
          },
        ),
      );
    });

    const rows = await screen.findAllByTestId(/^run-timeline-row-/);
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("run-timeline-count").textContent).toContain("3 of 3");
    // Each row says when, what, where and who.
    expect(screen.getByTestId("run-timeline-row-9102").textContent).toContain(
      "node.attempt.failed",
    );
    expect(screen.getByTestId("run-timeline-row-9102").textContent).toContain("/plan");
    expect(screen.getByTestId("run-timeline-row-9102").textContent).toContain("the system");
    await waitFor(() =>
      expect(screen.getByTestId("run-timeline-row-9103").textContent).toContain("Ada Lovelace"),
    );

    // The stage chip comes from the node the frames name; failures keeps one row.
    fireEvent.click(screen.getByTestId("run-timeline-filter-failures"));
    expect(timelineRows()).toHaveLength(1);
    expect(screen.getByTestId("run-timeline-row-9102").textContent).toContain("agent exited 1");
    expect(screen.queryByTestId("run-timeline-row-9101")).toBeNull();

    fireEvent.click(screen.getByTestId("run-timeline-filter-human"));
    expect(timelineRows()).toHaveLength(1);
    expect(screen.getByTestId("run-timeline-row-9103").textContent).toContain("approval.requested");

    fireEvent.click(screen.getByTestId("run-timeline-stage-plan"));
    expect(timelineRows()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("run-timeline-filter-all"));
    fireEvent.click(screen.getByTestId("run-timeline-row-9101"));
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`)).toHaveLength(1),
    );
  });

  it("keeps the attempt slot for attempts and labels a checkpoint boundary as one", async () => {
    // Browser QA: the `run.checkpoint_saved` row rendered `att 8cce` — the
    // attempt-slot fallback on an opaque id tail, which reads as attempt
    // number 3278. An attempt number is only ever the server's
    // `attempt_number`, and a boundary names itself.
    mountRun("?tab=timeline");
    await screen.findByTestId("run-title");

    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "node.attempt.started",
          { node_instance_key: "/plan", attempt_number: 1 },
          { node_execution_id: WIRE_NODE_PLAN, attempt_id: WIRE_ATTEMPT_1, global_seq: 9151 },
        ),
      );
      FakeEventSource.last().emit(
        wireRunEvent(
          "run.checkpoint_saved",
          {
            checkpoint: {
              node_instance_key: "/plan",
              inputs_digest: wireCheckpoint.inputs_digest,
              outputs_digest: wireCheckpoint.outputs_digest,
              volume_id: wireCheckpoint.volume_id,
            },
          },
          { node_execution_id: WIRE_NODE_PLAN, attempt_id: WIRE_ATTEMPT_1, global_seq: 9152 },
        ),
      );
    });

    await screen.findAllByTestId(/^run-timeline-row-/);
    // The attempt row still says which attempt it is.
    expect(screen.getByTestId("run-timeline-row-9151").textContent).toContain("att 1");
    // The boundary row names no attempt number at all: no id fragment in the
    // attempt slot, and the checkpoint reference says what it is.
    const boundary = screen.getByTestId("run-timeline-row-9152");
    expect(boundary.textContent).not.toMatch(/\batt\s/i);
    expect(screen.getByTestId("run-timeline-boundary-9152").textContent).toBe(
      `checkpoint ${shortDigest(wireCheckpoint.outputs_digest)}`,
    );
  });

  it("Pause asks the pause route once per click", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("run-title");

    fireEvent.click(screen.getByTestId("run-pause"));
    await waitFor(() => expect(requestsTo(requests, PAUSE_PATH, "POST")).toHaveLength(1));
  });

  it("renders a run that answers 404 as a 404", async () => {
    mountRunPage({
      path: `/projects/${wireProjectId}/runs/01987b11-dead-dead-dead-deaddeaddead`,
      routes: routes([
        {
          path: "/api/v1/runs/01987b11-dead-dead-dead-deaddeaddead",
          status: 404,
          body: { type: "about:blank", title: "Not Found", status: 404 },
        },
      ]),
      element: <RunInspector />,
    });
    expect(await screen.findByTestId("run-not-found")).toBeTruthy();
    expect(screen.queryByTestId("run-stage-strip")).toBeNull();
  });
});

const cells = () =>
  [...screen.getByTestId("branch-grid").querySelectorAll("button")].map(
    (button) => button.getAttribute("data-testid") ?? "",
  );

const timelineRows = () => screen.getAllByTestId(/^run-timeline-row-/);

describe("attentionNodeId", () => {
  const row = (
    id: string,
    kind: string,
    status: NodeExecutionSummary["status"],
    waiting_reason: NodeExecutionSummary["waiting_reason"] = null,
  ): Pick<NodeExecutionSummary, "id" | "kind" | "status" | "waiting_reason"> => ({
    id,
    kind,
    status,
    waiting_reason,
  });

  it("prefers the gate a human owes an answer at over everything else", () => {
    expect(
      attentionNodeId([
        row("n-plan", "agent.acp", "succeeded"),
        row("n-implement", "agent.acp", "failed"),
        row("n-approve", "human.approval", "waiting", "approval"),
        row("n-loop", "until", "waiting", "approval"),
      ]),
    ).toBe("n-approve");
  });

  it("takes a failure when nobody is being asked, and the work in flight after that", () => {
    expect(
      attentionNodeId([
        row("n-plan", "agent.acp", "succeeded"),
        row("n-implement", "agent.acp", "failed"),
        row("n-test", "agent.acp", "running"),
      ]),
    ).toBe("n-implement");
    expect(
      attentionNodeId([
        row("n-loop", "until", "running"),
        row("n-implement", "agent.acp", "running"),
      ]),
    ).toBe("n-implement");
  });

  it("says nothing is owed on a run with no open work", () => {
    expect(attentionNodeId([row("n-plan", "agent.acp", "succeeded")])).toBeNull();
    expect(attentionNodeId([])).toBeNull();
  });
});

/* ------------------------------------- the pane shows the agent's own work */

const conversationWorkRoute = {
  ...wireNodeDetail,
  attempts: [
    {
      ...wireAttempt,
      conversation_id: conversationId,
      turn_id: turnId,
      outputs: { summary: "Fixed the TTL comparison", files_changed: ["backend/cart/ttl.go"] },
      outputs_digest: "sha256:9c1f7a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c0a2e4d6b8c",
    },
  ],
};

function mountAgentAttempt(extra: RouteStub[] = []) {
  return mountRun(`?node=${WIRE_NODE_IMPLEMENT}`, [
    ...extra,
    { path: `/api/v1/conversations/${conversationId}`, body: controlledByOther },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`, body: conversationWorkRoute },
  ]);
}

/** The stream the pane opened, not the run stream — two `EventSource`s are live
 * on this screen and each test drives exactly one of them. */
function sourceFor(url: string): FakeEventSource {
  const source = FakeEventSource.instances.find((instance) => instance.url === url);
  if (!source) throw new Error(`no EventSource opened for ${url}`);
  return source;
}

describe("the attempt pane as the agent's work log", () => {
  it("renders the agent's turn: control banner, tool rows and a permission prompt", async () => {
    mountAgentAttempt();
    await screen.findByTestId("attempt-agent-work");

    const conversationStream = sourceFor(`/api/v1/conversations/${conversationId}/events`);
    act(() => {
      conversationStream.emit(
        conversationEvent("conversation.message.agent", {
          text: "Fixing the TTL comparison.",
          final: true,
        }),
      );
      conversationStream.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_edit",
          title: "edit backend/cart/ttl.go",
          kind: "edit",
          status: "in_progress",
          input_preview: '{"+12":"added","-3":"removed"}',
        }),
      );
      conversationStream.emit(
        conversationEvent("conversation.permission.requested", {
          permission_request_id: permissionRequestFixture.id,
          title: "Network access: proxy.golang.org?",
          kind: "execute",
          options: permissionRequestFixture.options,
        }),
      );
    });

    expect(screen.getAllByTestId("transcript-item").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("edit backend/cart/ttl.go")).toBeTruthy();
    expect(screen.getByTestId("tool-status-toolu_edit").textContent).toContain("in_progress");
    // The prompt is offered read-only: the run's attempt holds control, so the
    // card says who must answer instead of handing out dead buttons.
    const card = screen.getByTestId("permission-card");
    expect(card.textContent).toContain("Network access: proxy.golang.org?");
    expect(screen.getByTestId("permission-readonly")).toBeTruthy();
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    // ...and the pane offers the handoff that would make them live.
    expect(screen.getByTestId("attempt-take-control").textContent).toContain("Take control");
    expect(screen.getByTestId("attempt-composer-input").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("attempt-composer-input").getAttribute("placeholder")).toContain(
      "Take control to prompt this agent",
    );
  });

  it("gives the decide buttons to the controller, and only to the controller", async () => {
    const { requests } = mountAgentAttempt([
      { path: `/api/v1/conversations/${conversationId}`, body: conversationFixture },
    ]);
    await screen.findByTestId("attempt-agent-work");

    act(() => {
      sourceFor(`/api/v1/conversations/${conversationId}/events`).emit(
        conversationEvent("conversation.permission.requested", {
          permission_request_id: permissionRequestFixture.id,
          title: "Network access: proxy.golang.org?",
          kind: "execute",
          options: permissionRequestFixture.options,
        }),
      );
    });

    fireEvent.click(screen.getByTestId("permission-allow"));
    await waitFor(() =>
      expect(
        requestsTo(
          requests,
          `/api/v1/conversations/${conversationId}/permissions/${permissionRequestFixture.id}`,
          "POST",
        ).length,
      ).toBeGreaterThan(0),
    );
  });

  it("shows the outputs collapsed, next to the work, not instead of it", async () => {
    mountAgentAttempt();
    await screen.findByTestId("attempt-agent-work");
    const toggle = screen.getByTestId("attempt-outputs-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("attempt-outputs").hasAttribute("hidden")).toBe(false);
  });

  it("says the node and attempt once, not again through the conversation's generated name", async () => {
    // Browser QA: the title line read `/plan · attempt 1 · run 01a1454f /plan
    // attempt 1` — the server-generated conversation name repeated what the
    // line already said, and its `run 01a1454f` is a UUIDv7 *head* prefix,
    // identical for every run started in the same second. The pane keeps its
    // own `node · attempt N` wording and drops the generated echo.
    mountAgentAttempt([
      {
        path: `/api/v1/conversations/${conversationId}`,
        body: {
          ...controlledByOther,
          title: "run 01a1454f /build_until_verified[1]/implement attempt 1",
        },
      },
    ]);
    await screen.findByTestId("attempt-agent-work");
    const title = await screen.findByTestId("attempt-work-title");
    expect(title.textContent).toBe("/build_until_verified[1]/implement · attempt 1");
    expect(title.textContent).not.toMatch(/run 01a1454f/i);
    expect(title.textContent?.match(/attempt/g)).toHaveLength(1);
  });

  it("keeps a conversation title a person wrote in the attempt line", async () => {
    mountAgentAttempt();
    await screen.findByTestId("attempt-agent-work");
    const title = await screen.findByTestId("attempt-work-title");
    expect(title.textContent).toBe(
      "/build_until_verified[1]/implement · attempt 1 · Refactor billing",
    );
  });
});

/* -------------------------------------------------- the header stays honest */

describe("the run header follows the stream", () => {
  it("leaves waiting_human when the gate is decided — no run.* frame is ever written for it", async () => {
    mountRun("", [
      { path: RUN_PATH, body: { ...wireRun, status: "waiting_human" } },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
    ]);
    await screen.findByTestId("run-header-status");
    expect(screen.getByTestId("run-header-status").textContent).toContain("waiting");

    act(() => {
      // The journal replays from the start on connect, so the park is folded
      // before the decision is — the fold must un-park on the decision.
      FakeEventSource.last().emit(wireRunEvent("run.waiting_human", {}, { global_seq: 9201 }));
      FakeEventSource.last().emit(
        wireRunEvent(
          "approval.decided",
          { approval_id: wireApproval.id, decision: "approved", version: 2 },
          { node_execution_id: WIRE_NODE_APPROVE, global_seq: 9202 },
        ),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("run-header-status").textContent).toContain("running");
    });
  });
});

/* ------------------------------------- Retry: the run page's own way back */

/**
 * The M5 journey's run after a maintainer **rejected** its gate. The gate is
 * `succeeded` with the business outcome `rejected` and the dependant was
 * skipped by its `when` (docs/m4-contract.md § 5.3, C9e) — so route 31 has no
 * target and `POST /runs/{id}/retry` answers `409 run_not_retriable`.
 */
const wireRejectedGateNodes: NodeExecution[] = [
  { ...wireNodeList.node_executions[0] },
  {
    ...wireNodeList.node_executions[0],
    id: WIRE_NODE_APPROVE,
    node_id: "approve",
    kind: "human.approval",
    node_instance_key: "/approve",
    status: "succeeded",
    outcome: "rejected",
    attempt_count: 0,
    waiting_reason: null,
    execution_location: "control_plane",
  },
  {
    ...wireNodeList.node_executions[0],
    id: WIRE_NODE_IMPLEMENT,
    node_id: "publish_plan",
    kind: "artifact.publish",
    node_instance_key: "/publish_plan",
    status: "skipped",
    outcome: null,
  },
];

/** The same pipeline approved, then its own `verify` node failed (exit 1). */
const wireVerifyFailedNodes: NodeExecution[] = [
  ...wireRejectedGateNodes
    .slice(0, 2)
    .map((n) => (n.kind === "human.approval" ? { ...n, outcome: null } : n)),
  {
    ...wireNodeList.node_executions[0],
    id: WIRE_NODE_IMPLEMENT,
    node_id: "verify",
    kind: "process.exec",
    node_instance_key: "/verify",
    status: "failed",
    outcome: null,
    error_class: "infra",
    attempt_count: 1,
  },
];

const summaries = (nodes: NodeExecution[]): NodeExecutionSummary[] => nodes.map(viewNodeExecution);

describe("the run page's Retry control", () => {
  it("explains a business rejection instead of offering a Retry that would 409", async () => {
    const { requests } = mountRun("", [
      { path: RUN_PATH, body: { ...wireRun, status: "completed" } },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireRejectedGateNodes } },
    ]);
    await screen.findByTestId("run-title");

    const retry = screen.getByTestId("run-retry") as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    const reason = screen.getByTestId("run-retry-reason").textContent ?? "";
    expect(reason).toContain("/approve");
    expect(reason).toContain("rejected");
    expect(reason).toContain("business outcome");
    // The honest sentence, not an invented "you can retry anyway".
    expect(reason).toContain("no target");
    fireEvent.click(retry);
    await waitFor(() => expect(requestsTo(requests, `${RUN_PATH}/retry`, "POST")).toHaveLength(0));
  });

  it("gives a run whose worker node failed a Retry that posts route 31", async () => {
    const { requests } = mountRun("", [
      {
        path: RUN_PATH,
        body: { ...wireRun, status: "failed", failed_cause: "node_execution_failed:/verify" },
      },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireVerifyFailedNodes } },
      {
        path: `${RUN_PATH}/retry`,
        method: "POST",
        body: { ...wireRun, status: "queued", failed_cause: null },
      },
    ]);
    await screen.findByTestId("run-title");

    const retry = screen.getByTestId("run-retry") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("title")).toContain("/verify");
    expect(screen.queryByTestId("run-retry-reason")).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(requestsTo(requests, `${RUN_PATH}/retry`, "POST")).toHaveLength(1));
  });

  it("says nothing about Retry while the run is still working", async () => {
    mountRun("", [
      { path: RUN_PATH, body: { ...wireRun, status: "waiting_human" } },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
    ]);
    await screen.findByTestId("run-title");
    expect(screen.queryByTestId("run-retry")).toBeNull();
  });

  it("retryVerdict reads the same rows route 31 reads", () => {
    expect(retryVerdict("completed", summaries(wireRejectedGateNodes))).toMatchObject({
      show: true,
      available: false,
    });
    expect(retryVerdict("failed", summaries(wireVerifyFailedNodes))).toMatchObject({
      show: true,
      available: true,
    });
    // A run that merely finished with no gate answered has no target either.
    expect(retryVerdict("completed", [summaries(wireNodeList.node_executions)[0]])).toMatchObject({
      show: true,
      available: false,
    });
    expect(retryVerdict("running", summaries(wireVerifyFailedNodes)).show).toBe(false);
    // An ordinary failure's reason stays the plain route-31 re-run sentence.
    expect(retryVerdict("failed", summaries(wireVerifyFailedNodes)).reason).not.toContain(
      "manual rerun",
    );
    // § 7.2 W6: the node that LOST its workspace keeps the manual rerun (route 31
    // carries no workspace_lost exclusion) and says what it cannot bring back.
    const lost = wireVerifyFailedNodes.map((n) =>
      n.status === "failed" ? { ...n, error_class: "workspace_lost" as const } : n,
    );
    const verdict = retryVerdict("failed", summaries(lost));
    expect(verdict).toMatchObject({ show: true, available: true });
    expect(verdict.reason).toContain("manual rerun");
    expect(verdict.reason).toContain("no automatic retry is offered");
    expect(verdict.reason).toContain("prior edits lost, rerun required");
    expect(verdict.reason.toLowerCase()).not.toMatch(/resumed|restored|no data lost/);
  });
});

/* ------------- the inspector header's width is never a property of its verbs */

/** The classes *are* the layout — jsdom performs none — so this reads the same
 * width contract `RunWorkbench.test.tsx` reads off the workbench header, from
 * the inspector's own page. The title/meta column used to be `flex-1`, whose
 * zero flex-basis makes its width whatever the actions column leaves: a
 * completed run at 1280 with the `Retry` reason sentence showing left the meta
 * line and the title a ~54–66px column. The column now carries a 20rem basis
 * floor, the header wraps its lines at the right edge, and `RunActions` puts
 * that sentence UNDER its verbs instead of asking for the header's whole width
 * beside them (`w-full` on a non-wrapping row). A header that already fits side
 * by side is untouched — which is why the normal run asserts the same classes. */
function inspectorHeaderWidthContract() {
  const classes = (el: Element) => el.getAttribute("class")?.split(/\s+/) ?? [];
  const meta = screen.getByTestId("run-inspector-meta");
  const column = meta.parentElement as HTMLElement;
  const header = column.parentElement as HTMLElement;
  const actions = screen.getByTestId("run-actions");

  // The floor, not the zero basis that made the meta's width the buttons' slack.
  expect(column.getAttribute("data-testid")).toBe("run-inspector-title");
  expect(classes(column)).not.toContain("flex-1");
  expect(classes(column)).toContain("basis-[20rem]");
  expect(classes(column)).toContain("grow");
  expect(classes(column)).toContain("min-w-0");
  // The actions column leaves the line when it cannot fit beside the floor, and
  // lands against the right edge of its own line where it already sat.
  expect(classes(header)).toContain("flex-wrap");
  expect(classes(header)).toContain("justify-end");
  expect(classes(actions)).not.toContain("flex-1");
  expect(header.children[1]).toBe(actions);

  // The reason sentence is a line under the verbs, never a `w-full` flex item
  // beside them: it may span the actions column, but it cannot demand the
  // header's whole width and crush the meta line to afford it.
  const verbs = actions.children[0] as HTMLElement;
  expect(classes(verbs)).not.toContain("flex-col");
  expect(verbs.contains(screen.getByTestId("run-pause"))).toBe(true);
  expect(verbs.contains(screen.getByTestId("run-cancel"))).toBe(true);
  for (const line of Array.from(actions.querySelectorAll("p"))) {
    expect(verbs.contains(line)).toBe(false);
    expect(classes(line)).not.toContain("w-full");
    expect(classes(line)).toContain("max-w-full");
  }
  return { meta, column, header, actions };
}

describe("the inspector header's width", () => {
  it("puts the meta line on a flex-basis floor so a wide action column wraps below it", async () => {
    // The crushed case: a completed run whose gate was answered rejected, so the
    // long `Retry` reason sentence is showing beside three verbs.
    mountRun("", [
      { path: RUN_PATH, body: { ...wireRun, status: "completed" } },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireRejectedGateNodes } },
    ]);
    await screen.findByTestId("run-title");

    expect(screen.getByTestId("run-retry-reason").textContent).toContain("business outcome");
    inspectorHeaderWidthContract();
  });

  it("keeps the side-by-side geometry for a normal run — the floor only changes the crush", async () => {
    mountRun();
    await screen.findByTestId("run-title");

    // No reason line at all while the run works: the header is the same two
    // columns it was, the meta column simply absorbs the leftover space.
    expect(screen.queryByTestId("run-retry-reason")).toBeNull();
    inspectorHeaderWidthContract();
    expect(screen.getByTestId("run-inspector-meta").textContent).toContain("frames folded");
  });

  it("keeps the floor when a refused verb explains itself with an error line", async () => {
    // The other `RunActions` sentence: a refusal coming back over the stream.
    mountRun("", [
      {
        path: `${RUN_PATH}/pause`,
        method: "POST",
        status: 409,
        body: { code: "conflict", run_id: WIRE_RUN_ID, run_status: "completed" },
      },
    ]);
    await screen.findByTestId("run-title");
    fireEvent.click(screen.getByTestId("run-pause"));

    await screen.findByTestId("run-action-error");
    inspectorHeaderWidthContract();
  });
});

/* ---------------- the diagnostics grid fits the space its host actually has */

/** What a `grid-cols-[a_b_c]` template asks its host for as a floor: every
 * track's minimum — a `minmax`'s first argument, a fixed length in full, and
 * nothing from a flexible track. A grid that asks for more than the host has
 * paints the difference OUTSIDE the host, which is precisely how the node
 * detail and the right pixel of every stage cell got under the dock. */
function templateFloorPx(layout: DiagnosticsLayout): number {
  const template = /^grid-cols-\[(.+)\]$/.exec(layout.grid)?.[1];
  if (!template) return 0; // `grid-cols-1`: one column, whatever the host has
  return template.split("_").reduce((sum, track) => {
    const floor = /^minmax\(([0-9.]+)(rem|px)/.exec(track) ?? /^([0-9.]+)(rem|px)$/.exec(track);
    if (!floor) return sum;
    return sum + Number(floor[1]) * (floor[2] === "rem" ? 16 : 1);
  }, 0);
}

/** And what the flexible pane is left with once the fixed tracks have taken
 * their ceilings — a grid fills those before it gives an `fr` anything. */
function templatePanePx(layout: DiagnosticsLayout, host: number): number {
  const template = /^grid-cols-\[(.+)\]$/.exec(layout.grid)?.[1];
  if (!template) return host;
  return (
    host -
    template.split("_").reduce((sum, track) => {
      const ceiling =
        /^minmax\([^,]+,([0-9.]+)(rem|px)\)$/.exec(track) ?? /^([0-9.]+)(rem|px)$/.exec(track);
      if (!ceiling) return sum;
      return sum + Number(ceiling[1]) * (ceiling[2] === "rem" ? 16 : 1);
    }, 0)
  );
}

describe("the diagnostics grid's columns", () => {
  // The widths this grid is read at: 1040 = the workbench `<main>` with the
  // dock collapsed at 1280, 593 = the same screen with the default 440px dock
  // open, 314 = the dock dragged to its 720px maximum, 390 = the phone. Plus
  // the widths either side of each threshold (880 = rail 10rem + detail 26rem
  // + pane 19rem; 460 = rail 10rem + a 300px pane), where a tier chosen one
  // pixel early is the bug. Measured against the running page, not invented:
  // see the workbench-dock-grid report.
  const HOSTS = [
    200, 313, 314, 358, 390, 459, 460, 461, 480, 593, 640, 700, 820, 879, 880, 881, 1040, 1280,
    1600,
  ];

  it("asks for no more than its host has", () => {
    for (const host of HOSTS) {
      const layout = diagnosticsLayoutFor(host);
      expect(templateFloorPx(layout), `${host} → ${layout.grid}: floor`).toBeLessThanOrEqual(host);
      if (layout.tier !== "stacked") {
        // The middle pane is the work surface; under ~19rem it is a caption.
        expect(
          templatePanePx(layout, host),
          `${host} → ${layout.grid}: pane`,
        ).toBeGreaterThanOrEqual(300);
      }
    }
  });

  it("keeps the run view's three panes exactly where the design has them", () => {
    // 1280 with the dock closed is the drawn look, and it is the same template
    // the inspector's own route puts on at `xl:`: the 160px section rail, a
    // flexible middle, the node detail at the run view's drawn width. The
    // 13–15rem the runs column took is gone, so the graph and the strip get it.
    expect(diagnosticsLayoutFor(1040).grid).toBe(
      "grid-cols-[10rem_minmax(0,1fr)_minmax(22.5rem,26rem)]",
    );
    expect(diagnosticsLayoutFor(1040).tier).toBe("panes");
  });

  it("gives up one column at a time as the dock takes the room", () => {
    expect(diagnosticsLayoutFor(593).tier).toBe("split"); // 1280, 440px dock open
    expect(diagnosticsLayoutFor(314).tier).toBe("stacked"); // 1280, dock at its 720px max
    expect(diagnosticsLayoutFor(390).tier).toBe("stacked"); // the phone's reflow
    // The rail never collapses, so the templates it offers are the only ones:
    // the dock-open split is the rail beside the panes, nothing narrower.
    expect(diagnosticsLayoutFor(593).grid).toBe("grid-cols-[10rem_minmax(0,1fr)]");
    expect(diagnosticsLayoutFor(460).tier).toBe("split");
    expect(diagnosticsLayoutFor(459).tier).toBe("stacked");
    expect(diagnosticsLayoutFor(880).tier).toBe("panes");
    expect(diagnosticsLayoutFor(879).tier).toBe("split");
  });
});

describe("the diagnostics grid hosted by the workbench", () => {
  // jsdom defines `clientWidth` up the prototype chain, not on HTMLElement.
  const clientWidthOwner = (() => {
    for (
      let proto: object | null = HTMLElement.prototype;
      proto;
      proto = Object.getPrototypeOf(proto)
    )
      if (Object.getOwnPropertyDescriptor(proto, "clientWidth")) return proto;
    throw new Error("no clientWidth to put back");
  })();
  const clientWidthPatch = Object.getOwnPropertyDescriptor(clientWidthOwner, "clientWidth")!;
  afterEach(() => {
    Object.defineProperty(clientWidthOwner, "clientWidth", clientWidthPatch);
  });

  /** The workbench's own frame: `<main>` with the node-detail dock beside it in
   * the same flex row. jsdom lays nothing out, so the host's measured width IS
   * the number the page reads — 593 with the 440px dock open at 1280, 1040 with
   * it collapsed, 390 on a phone. */
  function mountEmbedded(hostWidth: number) {
    Object.defineProperty(clientWidthOwner, "clientWidth", {
      configurable: true,
      get: () => hostWidth,
    });
    return mountRunPage({
      path: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}`,
      routes: routes(),
      element: (
        <main data-testid="host-main">
          <RunInspector embedded />
        </main>
      ),
    });
  }

  it("reads its columns off `<main>`, not off the viewport", async () => {
    // The old answer was the one viewport template at 1280 whatever the dock
    // cost. Here the window is jsdom's 1024, under every desktop breakpoint,
    // and the grid still resolves the dock-open template — because the width it
    // measured is its host's, not the window's.
    mountEmbedded(593);
    const inspector = await screen.findByTestId("run-inspector");
    expect(inspector.getAttribute("data-diagnostics-tier")).toBe("split");
    expect(inspector.className).toContain("grid-cols-[10rem_minmax(0,1fr)]");
    expect(inspector.className).not.toContain("minmax(22.5rem,26rem)");
    expect(inspector.className).not.toContain("xl:");
    // The node detail is the whole run of the row under the rail and the panes.
    expect(screen.getByTestId("run-inspector-detail").className).toContain("col-span-2");
    // And what sits in that first 160px column is the section rail, not a runs
    // list: the run page has no runs column any more.
    expect(within(screen.getByTestId("run-inspector-nav")).queryByTestId("runs-list")).toBeNull();
  });

  it("keeps all three panes when the dock is closed", async () => {
    mountEmbedded(1040);
    const inspector = await screen.findByTestId("run-inspector");
    expect(inspector.getAttribute("data-diagnostics-tier")).toBe("panes");
    expect(inspector.className).toContain("grid-cols-[10rem_minmax(0,1fr)_minmax(22.5rem,26rem)]");
    const detail = screen.getByTestId("run-inspector-detail");
    expect(detail.className).toContain("border-l");
    expect(detail.className).not.toContain("col-span-2");
  });

  it("stacks into one column on a phone", async () => {
    mountEmbedded(390);
    const inspector = await screen.findByTestId("run-inspector");
    expect(inspector.getAttribute("data-diagnostics-tier")).toBe("stacked");
    expect(inspector.className).toContain("grid min-h-full grid-cols-1 border-y");
    const detail = screen.getByTestId("run-inspector-detail");
    expect(detail.className).toContain("border-t");
    expect(detail.className).not.toContain("col-span-2");
    // And the section rail is a top block again, not a column with a right border.
    expect(screen.getByTestId("run-inspector-nav").className).toContain("border-b");
  });

  it("keeps its own route on the viewport's three panes", async () => {
    // The standalone page bleeds to the shell's whole column, so `xl:` is the
    // honest read there and nothing about this fix touches it.
    Object.defineProperty(clientWidthOwner, "clientWidth", {
      configurable: true,
      get: () => 1024,
    });
    mountRun();
    const inspector = await screen.findByTestId("run-inspector");
    expect(inspector.getAttribute("data-diagnostics-tier")).toBe("route");
    expect(inspector.className).toContain("grid-cols-1");
    expect(inspector.className).toContain(
      "xl:grid-cols-[10rem_minmax(0,1fr)_minmax(22.5rem,26rem)]",
    );
  });
});
