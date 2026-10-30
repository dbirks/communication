/**
 * Two things the run page's removed Runs column used to be the only witness of.
 *
 * 1. The project-less deep link. `/runs/:runId` carries no `:projectId`:
 *    `RunDeepLink` resolves the project off the run's own read and hands it to
 *    the workbench as a *prop*. The inspector used to pass the empty route param
 *    straight into its project-scoped reads — `useProjectRuns` among them, whose
 *    query is `enabled: projectId.length > 0` — so they never fired a request
 *    and sat `isPending` forever: "· Loading runs…" over a project with real
 *    runs, minutes apart, forever. The fix is the run's own `project_id` as the
 *    fallback, and the inspector's remaining project-scoped reads (the section
 *    rail's links, the run's approvals, the timeline's actor names) depend on it
 *    exactly as the column did.
 *
 * 2. The column's own honest answers on the surface that still mounts it — the
 *    project's Runs tab (`ProjectRuns.tsx`): a missing project id is a sentence,
 *    a failed read is a banner with a Retry that really reads again.
 *
 * What is *not* here any more: the run page renders no runs list. The design's
 * run view (`communication-spec/10-ui-design-handoff.md`) has none — the
 * project's runs live on the project's Runs tab — so the inspector's nav is the
 * section rail alone, and the first block below asserts both halves of that.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../api/client";
import { resetReplicaName } from "../api/replica";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApprovalList,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunList,
  wireTree,
} from "../test/fixtures/m4/wire";
import { routes } from "../lib/routes";
import RunInspector from "./RunInspector";
import { RunsListColumn } from "./ProjectRuns";

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const APPROVALS_PATH = `/api/v1/projects/${wireProjectId}/approvals`;

describe("the run page on /runs/:runId (no project in the URL)", () => {
  afterEach(cleanup);

  /** The same stub set `RunInspector.test.tsx` serves, mounted on the
   * project-less workbench deep link — the only URL the app actually routes. */
  function mountDiagnostics(extra: RouteStub[] = []) {
    setCsrfToken(null);
    resetReplicaName();
    const { requests } = mockFetch([
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
      { path: APPROVALS_PATH, body: { ...wireApprovalList, approvals: [] } },
      { path: RUN_PATH, body: wireRun },
      { path: `${RUN_PATH}/nodes`, body: wireNodeList },
      { path: `${RUN_PATH}/tree`, body: wireTree },
      { path: `/api/v1/revisions/${wireRun.revision_digest}`, body: wireRevision },
      { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
      // Stubbed so a page that still asked for the list would say so: this is
      // the read the removed column made, and nothing on this page makes it now.
      { path: RUNS_PATH, body: wireRunList },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/runs/${WIRE_RUN_ID}`]}>
          <Routes>
            <Route path="/runs/:runId" element={<RunInspector embedded />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { requests };
  }

  it("names the run's own project in its rail, and lists no runs", async () => {
    const { requests } = mountDiagnostics();

    // The bug's exact shape reversed: the page must ask for the project the
    // *run* names, and must show the reader the way back to that project's runs
    // rather than a copy of them.
    const rail = await screen.findByTestId("run-inspector-nav");
    const runsLink = within(rail).getByRole("link", { name: "Runs" });
    expect(runsLink.getAttribute("href")).toBe(routes.projectTab(wireProjectId, "runs"));
    expect(runsLink.getAttribute("href")).not.toContain("/projects//");

    // The approvals read is project-scoped off the same fallback — proof the
    // id reached the hooks and not just the link.
    await waitFor(() => expect(requestsTo(requests, APPROVALS_PATH).length).toBeGreaterThan(0));

    // And the runs list is gone, not merely hidden: no column, no rows, no
    // request for them.
    expect(within(rail).queryByTestId("runs-list")).toBeNull();
    expect(within(rail).queryAllByTestId(/^run-row-/)).toHaveLength(0);
    expect(requestsTo(requests, RUNS_PATH)).toHaveLength(0);
  });
});

describe("the project's runs column (mounted by the project's Runs tab)", () => {
  afterEach(cleanup);

  function mountColumn(projectId: string, runsResponse: unknown, extra: RouteStub[] = []) {
    setCsrfToken(null);
    resetReplicaName();
    const { requests } = mockFetch([
      ...(runsResponse === undefined ? [] : [{ path: RUNS_PATH, body: runsResponse } as RouteStub]),
      ...extra,
      { path: "/api/v1/pipelines", body: wirePipelineList },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RunsListColumn projectId={projectId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { requests };
  }

  it("error: a failed runs read is an honest banner with a working Retry", async () => {
    const { requests } = mountColumn(wireProjectId, undefined, [
      {
        path: RUNS_PATH,
        status: 500,
        body: {
          type: "about:blank",
          title: "Internal Server Error",
          status: 500,
          detail: "runs are unavailable",
        },
      },
    ]);

    const list = await screen.findByTestId("runs-list");
    const alert = await within(list).findByRole("alert");
    expect(alert.textContent).toContain("runs are unavailable");
    expect(screen.queryByText("· Loading runs…")).toBeNull();

    // Retry is a real second read, not a decoration.
    fireEvent.click(within(list).getByTestId("runs-retry"));
    await waitFor(() => expect(requestsTo(requests, RUNS_PATH)).toHaveLength(2));
  });

  it("no project at all: the column refuses honestly, without a perpetual spinner", async () => {
    // The column's own guard: an empty id leaves the read disabled forever, so
    // it must never dress that up as "Loading".
    const { requests } = mountColumn("", { runs: [] });

    expect((await screen.findByTestId("runs-no-project")).textContent).toContain("no project");
    expect(screen.queryByText("· Loading runs…")).toBeNull();
    expect(requestsTo(requests, "/api/v1/projects//runs")).toHaveLength(0);
  });
});
