/**
 * The inbox as a real route: per-project approvals and runs read through the
 * same hooks the rest of the app uses, sections grouped by what they ask of
 * you, decisions and retries acted on inline. The fixture wires are the frozen
 * M4 ones — nothing here invents a field the API does not carry.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import {
  WIRE_APPROVAL_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wirePipelineList,
  wireProjectId,
  wireRun,
  wireRunList,
} from "../test/fixtures/m4/wire";
import { testidOf } from "../lib/format";

const PROJECTS_PATH = "/api/v1/projects";
const APPROVALS_PATH = `/api/v1/projects/${wireProjectId}/approvals`;
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const DECIDE_PATH = `/api/v1/approvals/${WIRE_APPROVAL_ID}/decide`;
const RETRY_PATH = `/api/v1/runs/${WIRE_RUN_ID}/retry`;

const failedRun = {
  ...wireRun,
  status: "failed",
  failed_cause: "node_execution_failed:/implement",
} as unknown as typeof wireRun;

function routes(approvals: unknown, runs: unknown, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: PROJECTS_PATH, method: "GET", body: { items: [projectFixture] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: APPROVALS_PATH, body: approvals },
    { path: RUNS_PATH, body: runs },
  ];
}

function mountInbox(
  approvals: unknown = wireApprovalList,
  runs: unknown = wireRunList,
  extra: RouteStub[] = [],
) {
  return renderApp({ path: "/inbox", routes: routes(approvals, runs, extra) });
}

describe("/inbox", () => {
  it("greets the signed-in user and states the cross-project tally", async () => {
    mountInbox({ approvals: [] }, { runs: [] });
    expect((await screen.findByTestId("inbox-greeting")).textContent).toContain("Ada");
    expect((await screen.findByTestId("inbox-summary")).textContent).toBe(
      "Across 1 project: 0 decisions, 0 stalled runs. 0 runs are going fine.",
    );
  });

  it("lists a pending gate under decisions and posts the row's version on approve", async () => {
    const { requests } = mountInbox(wireApprovalList, { runs: [] }, [
      {
        path: DECIDE_PATH,
        method: "POST",
        body: { ...wireApproval, state: "decided", decision: "approved", version: 2 },
      },
    ]);

    const list = await screen.findByTestId("inbox-decisions");
    const row = await within(list).findByTestId(`inbox-decision-${testidOf(WIRE_APPROVAL_ID)}`);
    // The gate text is the wire's `summary`; the run and node are the ids it serves.
    expect(row.textContent).toContain("The plan is ready");
    expect(row.textContent).toContain("Widgets");
    expect(row.textContent).toContain("/approve");

    fireEvent.click(within(row).getByTestId(`inbox-approve-${testidOf(WIRE_APPROVAL_ID)}`));
    await waitFor(() => expect(requestsTo(requests, DECIDE_PATH, "POST")).toHaveLength(1));
    const [request] = requestsTo(requests, DECIDE_PATH, "POST");
    expect(JSON.parse(request.body ?? "{}")).toEqual({ decision: "approved", version: 1 });
  });

  it("refuses a decision inline rather than silently, on 403", async () => {
    mountInbox(wireApprovalList, { runs: [] }, [
      {
        path: DECIDE_PATH,
        method: "POST",
        status: 403,
        body: { type: "about:blank", title: "Forbidden", status: 403, detail: "not an approver" },
      },
    ]);

    const row = await screen.findByTestId(`inbox-decision-${testidOf(WIRE_APPROVAL_ID)}`);
    fireEvent.click(within(row).getByTestId(`inbox-reject-${testidOf(WIRE_APPROVAL_ID)}`));
    const error = await screen.findByTestId(`inbox-decision-error-${testidOf(WIRE_APPROVAL_ID)}`);
    expect(error.textContent).toContain("not an approver");
  });

  it("lists a failed run under stalled and retries it from there", async () => {
    const { requests } = mountInbox({ approvals: [] }, { runs: [failedRun] }, [
      { path: RETRY_PATH, method: "POST", body: { ...wireRun, status: "queued" } },
    ]);

    const list = await screen.findByTestId("inbox-stalled");
    const row = await within(list).findByTestId(`inbox-stalled-${testidOf(WIRE_RUN_ID)}`);
    expect(
      within(row).getByTestId(`inbox-stalled-status-${testidOf(WIRE_RUN_ID)}`).textContent,
    ).toContain("failed");
    // The cause is the server's `failed_cause`, never a composed sentence.
    expect(row.textContent).toContain("node_execution_failed:/implement");
    expect(
      within(row)
        .getByTestId(`inbox-open-run-${testidOf(WIRE_RUN_ID)}`)
        .getAttribute("href"),
    ).toBe(`/projects/${wireProjectId}/runs/${WIRE_RUN_ID}`);

    fireEvent.click(within(row).getByTestId(`inbox-retry-${testidOf(WIRE_RUN_ID)}`));
    await waitFor(() => expect(requestsTo(requests, RETRY_PATH, "POST")).toHaveLength(1));
  });

  it("treats a waiting_human run with no open gate as stalled", async () => {
    const waiting = { ...wireRun, status: "waiting_human" } as unknown as typeof wireRun;
    mountInbox({ approvals: [] }, { runs: [waiting] });
    const stalled = await screen.findByTestId("inbox-stalled");
    expect(within(stalled).getByTestId(`inbox-stalled-${testidOf(WIRE_RUN_ID)}`)).toBeTruthy();
    // No gate open means no Retry: only a failed run is retriable here.
    expect(within(stalled).queryByTestId(`inbox-retry-${testidOf(WIRE_RUN_ID)}`)).toBeNull();
  });

  it("counts a waiting_human run whose gate is open as a decision, not a stall", async () => {
    const waiting = { ...wireRun, status: "waiting_human" } as unknown as typeof wireRun;
    mountInbox(wireApprovalList, { runs: [waiting] });
    const decisions = await screen.findByTestId("inbox-decisions");
    expect(
      within(decisions).getByTestId(`inbox-decision-${testidOf(WIRE_APPROVAL_ID)}`),
    ).toBeTruthy();
    expect(screen.queryByTestId("inbox-stalled")).toBeNull();
  });

  it("puts active runs in the quiet running-fine strip with their pipeline slug", async () => {
    mountInbox({ approvals: [] }, wireRunList);
    const strip = await screen.findByTestId("inbox-running");
    const item = within(strip).getByTestId(`inbox-running-${testidOf(WIRE_RUN_ID)}`);
    expect(item.textContent).toContain("feature-development");
    expect(item.textContent).toContain("running");
    expect(screen.queryByTestId("inbox-stalled")).toBeNull();
    expect(screen.queryByTestId("inbox-decisions")).toBeNull();
  });

  it("says so when nothing needs you", async () => {
    mountInbox({ approvals: [] }, { runs: [] });
    expect((await screen.findByTestId("inbox-empty")).textContent).toContain("Nothing needs you.");
    expect(screen.queryByTestId("inbox-decisions")).toBeNull();
  });
});
