/**
 * The runs list as a real route: rows come from `GET /projects/{id}/runs`
 * through the same hooks the preview's live seam proved, the filter chips are
 * the design's, and the empty/404 states are honest.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import {
  WIRE_RUN_ID,
  wirePipelineList,
  wireProjectId,
  wireRun,
  wireRunList,
} from "../test/fixtures/m4/wire";

const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const childRun = { ...wireRun, id: "01987b11-0000-0000-8000-00000000000c", depth: 1 };

function routes(runs: unknown = wireRunList, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: RUNS_PATH, body: runs },
  ];
}

function mountRuns(runs?: unknown, extra: RouteStub[] = []) {
  return renderApp({ path: `/projects/${wireProjectId}/runs`, routes: routes(runs, extra) });
}

describe("/projects/:projectId/runs", () => {
  it("lists top-level runs from the API with their slug, status and digest", async () => {
    const { requests } = mountRuns({ runs: [...wireRunList.runs, childRun] });

    const list = await screen.findByTestId("runs-list");
    const row = await within(list).findByTestId(`run-row-${WIRE_RUN_ID}`);
    // The row names the pipeline by its library slug — the wire carries no title.
    expect(row.textContent).toContain("feature-development");
    expect(within(row).getByTestId("run-status").textContent).toContain("running");
    // The row carries the pinned digest, not an invented revision number.
    expect(row.textContent).toContain("3f2f3f2f3f2f");
    expect(requestsTo(requests, RUNS_PATH)).toHaveLength(1);

    // A child run belongs to its parent's tree, never to this list.
    expect(within(list).queryByTestId(`run-row-${childRun.id}`)).toBeNull();
  });

  it("filters by state, and the empty filter result says which filter is empty", async () => {
    mountRuns({ runs: [{ ...wireRun, status: "waiting_human" }] });

    // The default filter is `active`; a waiting run is not active work.
    expect((await screen.findByTestId("runs-empty")).textContent).toContain("No active runs");
    expect(screen.getByTestId("runs-filter-waiting").textContent).toContain("waiting 1");

    fireEvent.click(screen.getByTestId("runs-filter-all"));
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
  });

  it("shows the honest empty state when the project has never run", async () => {
    mountRuns({ runs: [] });
    expect((await screen.findByTestId("runs-empty")).textContent).toContain("No runs yet");
  });

  it("renders a 404 as a 404 rather than an empty list", async () => {
    mountRuns(undefined, [
      {
        path: RUNS_PATH,
        status: 404,
        body: { type: "about:blank", title: "Not Found", status: 404 },
      },
    ]);
    expect(await screen.findByTestId("project-runs-not-found")).toBeTruthy();
    expect(screen.queryByTestId("runs-list")).toBeNull();
  });

  it("links each row to the run inspector route", async () => {
    mountRuns();
    const row = await screen.findByTestId(`run-row-${WIRE_RUN_ID}`);
    expect(row.getAttribute("href")).toBe(`/projects/${wireProjectId}/runs/${WIRE_RUN_ID}`);
    expect(row.textContent).toMatch(/#\w{8} feature-development/);
  });
});
