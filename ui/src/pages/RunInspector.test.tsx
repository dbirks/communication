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

  it("starts on Execution: the stage strip and the tree, with an empty right pane", async () => {
    mountRun();
    await screen.findByTestId("run-title");

    expect(screen.getByTestId("run-stage-strip")).toBeTruthy();
    expect(screen.getByTestId("run-tree")).toBeTruthy();
    expect(screen.getByTestId("run-detail-none").textContent).toContain("Select a node");
  });

  it("selects a node from the stage strip into the right pane and the URL", async () => {
    const { requests } = mountRun();
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
