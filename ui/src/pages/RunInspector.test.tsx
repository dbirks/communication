/**
 * The run inspector as a real route (`/projects/:id/runs/:runId`): header
 * verbs, the Definition | Execution | Timeline panes, and a node selection
 * that lives in `?node=` so a pane is linkable. Served by the fake fetch and
 * the fake EventSource — the same doubles that prove `/__m4-preview?source=live`.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import {
  WIRE_NODE_IMPLEMENT,
  WIRE_NODE_PLAN,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApprovalList,
  wireNodeDetail,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunList,
  wireTree,
} from "../test/fixtures/m4/wire";

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const PAUSE_PATH = `${RUN_PATH}/pause`;

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: PAUSE_PATH, method: "POST", body: { ...wireRun, status: "paused" } },
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
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

function mountRun(search = "") {
  return renderApp({
    path: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}${search}`,
    routes: routes(),
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
    // The design's left column is the run list, with the open run raised.
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
  });

  it("opens on Definition: the graph the run is pinned to, with an empty right pane", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("run-title");

    expect(await screen.findByTestId("definition-graph")).toBeTruthy();
    expect(requestsTo(requests, `/api/v1/revisions/${wireRun.revision_digest}`)).toHaveLength(1);
    expect(screen.getByTestId("run-detail-none").textContent).toContain("Select a node");
    // Execution is one tab away, not the first thing a reader meets.
    fireEvent.click(screen.getByTestId("run-tab-execution"));
    expect(await screen.findByTestId("run-stage-strip")).toBeTruthy();
    expect(screen.getByTestId("run-tree")).toBeTruthy();
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
    expect(inspector.className).toContain("xl:grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)");
    expect(screen.getByTestId("run-inspector-detail")).toBeTruthy();
    // The runs column collapses to make room for the graph and stays restorable.
    fireEvent.click(screen.getByTestId("run-nav-collapse"));
    expect(screen.getByTestId("run-inspector").className).toContain(
      "xl:grid-cols-[2.25rem_minmax(0,1fr)",
    );
    fireEvent.click(screen.getByTestId("run-nav-expand"));
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
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

  it("Pause asks the pause route once per click", async () => {
    const { requests } = mountRun();
    await screen.findByTestId("run-title");

    fireEvent.click(screen.getByTestId("run-pause"));
    await waitFor(() => expect(requestsTo(requests, PAUSE_PATH, "POST")).toHaveLength(1));
  });

  it("renders a run that answers 404 as a 404", async () => {
    renderApp({
      path: `/projects/${wireProjectId}/runs/01987b11-dead-dead-dead-deaddeaddead`,
      routes: routes([
        {
          path: "/api/v1/runs/01987b11-dead-dead-dead-deaddeaddead",
          status: 404,
          body: { type: "about:blank", title: "Not Found", status: 404 },
        },
      ]),
    });
    expect(await screen.findByTestId("run-not-found")).toBeTruthy();
    expect(screen.queryByTestId("run-stage-strip")).toBeNull();
  });
});
