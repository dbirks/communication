/**
 * The run inspector's Runs column on the real deep-link route
 * (`/runs/:runId`, the graph-first workbench — ADR-0043).
 *
 * That route carries no `:projectId`: `RunDeepLink` resolves the project off
 * the run's own read and hands it to the workbench as a *prop*. The inspector
 * used to pass the empty route param straight into `useProjectRuns`, whose
 * query is `enabled: projectId.length > 0` — so it never fired a request and
 * stayed `isPending` forever: "· Loading runs…" over a project with real runs
 * and all-zero chips, minutes apart, forever. The fix: the inspector falls
 * back to the run's own `project_id`.
 *
 * These cases drive the panel through the three honest answers it may give —
 * loaded, empty, error with retry — on that route, plus the panel's own
 * no-project guard, so a future caller with an empty id gets a sentence, not
 * a perpetual spinner.
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
import RunInspector from "./RunInspector";
import { RunsListColumn } from "./ProjectRuns";

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;

/** The same stub set `RunInspector.test.tsx` serves, mounted on the
 * project-less workbench deep link — the only URL the app actually routes. */
function mountDiagnostics(runsResponse: unknown, extra: RouteStub[] = []) {
  setCsrfToken(null);
  resetReplicaName();
  const { requests } = mockFetch([
    ...(runsResponse === undefined ? [] : [{ path: RUNS_PATH, body: runsResponse } as RouteStub]),
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
    { path: RUN_PATH, body: wireRun },
    { path: `${RUN_PATH}/nodes`, body: wireNodeList },
    { path: `${RUN_PATH}/tree`, body: wireTree },
    { path: `/api/v1/revisions/${wireRun.revision_digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
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

describe("the run inspector's Runs column on /runs/:runId (no project in the URL)", () => {
  afterEach(cleanup);

  it("loaded: reads the run's own project and lists its real runs", async () => {
    const { requests } = mountDiagnostics(wireRunList);

    // The bug's exact shape: no request ever went out and the spinner never
    // resolved. The panel must ask for the project the *run* names.
    await waitFor(() => expect(requestsTo(requests, RUNS_PATH).length).toBeGreaterThan(0));
    const row = await screen.findByTestId(`run-row-${WIRE_RUN_ID}`);
    expect(row.textContent).toContain("feature-development");
    // The chips count the real list, not the empty one the spinner waited on.
    expect(screen.getByTestId("runs-filter-all").textContent).toContain(
      `all ${wireRunList.runs.length}`,
    );
    expect(screen.queryByText("· Loading runs…")).toBeNull();
  });

  it("empty: a project with no runs says so instead of spinning", async () => {
    mountDiagnostics({ runs: [] });

    const empty = await screen.findByTestId("runs-empty");
    expect(empty.textContent).toContain("No runs yet");
    expect(screen.queryByText("· Loading runs…")).toBeNull();
  });

  it("error: a failed runs read is an honest banner with a working Retry", async () => {
    const { requests } = mountDiagnostics(undefined, [
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
    // The panel's own guard: an empty id leaves the read disabled forever, so
    // the column must never dress that up as "Loading".
    setCsrfToken(null);
    resetReplicaName();
    const { requests } = mockFetch([{ path: "/api/v1/pipelines", body: wirePipelineList }]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RunsListColumn projectId="" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect((await screen.findByTestId("runs-no-project")).textContent).toContain("no project");
    expect(screen.queryByText("· Loading runs…")).toBeNull();
    expect(requestsTo(requests, "/api/v1/projects//runs")).toHaveLength(0);
  });
});
