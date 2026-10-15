/**
 * The run- and gate-side hooks plus the wire→view mapping, against the fake
 * fetch. Two contract behaviours get the closest look: run creation is
 * *idempotent* (a retried click is not a second run), and a gate decision is
 * compare-and-swap (a lost race adopts the winner, never a retry).
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "./client";
import { queryKeys } from "./queries";
import {
  runConflictOf,
  useCancelRun,
  useCreateRun,
  useProjectRuns,
  useRetryRun,
  useRunNode,
} from "./runs";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useDecideApproval,
  useProjectApprovals,
} from "./approvals";
import { viewArtifactRefs, viewNodeExecution, viewRun, viewRunTree } from "./m4view";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_APPROVAL_ID,
  WIRE_NODE_IMPLEMENT,
  WIRE_CHILD_PIPELINE_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wireNodeDetail,
  wireNodeList,
  wireProjectId,
  wireRun,
  wireRunList,
  wireTree,
} from "../test/fixtures/m4/wire";

afterEach(cleanup);

/** `gcTime` must outlive the test: an adopted `409` winner is read back out of
 * the cache, and a `gcTime: 0` client would collect that row before the assertion. */
function harness(routes: RouteStub[], gcTime = 60_000) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { requests, queryClient, wrapper };
}

const runsPath = `/api/v1/projects/${wireProjectId}/runs`;
const runPath = `/api/v1/runs/${WIRE_RUN_ID}`;
const approvalPath = `/api/v1/approvals/${WIRE_APPROVAL_ID}`;

describe("run hooks (frozen M4 routes)", () => {
  it("GETs the project run list; no request before a project exists", async () => {
    const { requests, wrapper } = harness([{ path: runsPath, body: wireRunList }]);
    const listed = renderHook(() => useProjectRuns(wireProjectId), { wrapper });
    await waitFor(() => expect(listed.result.current.isSuccess).toBe(true));
    expect(listed.result.current.data?.runs[0]?.status).toBe("running");
    expect(requestsTo(requests, runsPath)).toHaveLength(1);

    const idle = renderHook(() => useProjectRuns(""), { wrapper });
    await waitFor(() => expect(idle.result.current.fetchStatus).toBe("idle"));
  });

  it("sends Idempotency-Key as the header (and mirrors it into the body) — § 12", async () => {
    setCsrfToken("csrf-m4");
    const { requests, wrapper } = harness([
      {
        path: runsPath,
        method: "POST",
        status: 201,
        body: { run_id: WIRE_RUN_ID, status: "queued" },
      },
      { path: runsPath, body: wireRunList },
    ]);
    const create = renderHook(() => useCreateRun(wireProjectId), { wrapper });
    create.result.current.mutate({
      body: { assignment_id: "as", inputs: { goal: "ship" } },
      idempotencyKey: "case-1-retry",
    });
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
    const post = requestsTo(requests, runsPath, "POST")[0];
    expect(post.headers.get("idempotency-key")).toBe("case-1-retry");
    expect(post.headers.get("x-csrf-token")).toBe("csrf-m4");
    expect(JSON.parse(String(post.body))).toEqual({
      assignment_id: "as",
      inputs: { goal: "ship" },
      idempotency: "case-1-retry",
    });
    setCsrfToken(null);
  });

  it("POSTs lifecycle verbs to the contract paths with no body", async () => {
    const { requests, wrapper } = harness([
      { path: `${runPath}/cancel`, method: "POST", body: wireRun },
    ]);
    const cancel = renderHook(() => useCancelRun(WIRE_RUN_ID), { wrapper });
    cancel.result.current.mutate();
    await waitFor(() => expect(cancel.result.current.isSuccess).toBe(true));
    const post = requestsTo(requests, `${runPath}/cancel`, "POST")[0];
    expect(post.body).toBeUndefined();
  });

  it("reads a run_not_retriable 409 off the problem body (RunConflictProblem)", async () => {
    const { wrapper } = harness([
      {
        path: `${runPath}/retry`,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/run-not-retriable",
          title: "Run not retriable",
          status: 409,
          detail: "status is running",
          run_id: WIRE_RUN_ID,
          run_status: "running",
        },
      },
    ]);
    const retry = renderHook(() => useRetryRun(WIRE_RUN_ID), { wrapper });
    retry.result.current.mutate({ reason: "flaky test" });
    await waitFor(() => expect(retry.result.current.isError).toBe(true));
    expect(runConflictOf(retry.result.current.error)).toMatchObject({
      run_id: WIRE_RUN_ID,
      run_status: "running",
    });
  });

  it("GETs one node execution with its attempt history (route 25)", async () => {
    const path = `${runPath}/nodes/${WIRE_NODE_IMPLEMENT}`;
    const { requests, wrapper } = harness([{ path, body: wireNodeDetail }]);
    const { result } = renderHook(() => useRunNode(WIRE_RUN_ID, WIRE_NODE_IMPLEMENT), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, path)).toHaveLength(1);
    expect(result.current.data?.attempts[0]?.attempt_number).toBe(1);
  });

  it("GETs the project's pending gates (route 34)", async () => {
    const path = `/api/v1/projects/${wireProjectId}/approvals`;
    const { requests, wrapper } = harness([{ path, body: wireApprovalList }]);
    const { result } = renderHook(() => useProjectApprovals(wireProjectId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, path)).toHaveLength(1);
    expect(result.current.data?.approvals[0]?.state).toBe("pending");
  });
});

describe("gate decisions are exactly-one (CAS)", () => {
  const winner = {
    type: "https://communication.dev/errors/approval-already-decided",
    title: "Approval already decided",
    status: 409,
    detail: "a maintainer decided this gate first.",
    approval_id: WIRE_APPROVAL_ID,
    approval: { state: "decided", decision: "rejected", decided_by: "someone-else", version: 2 },
  };

  it("POSTs {decision, comments, version} with the CSRF header (route 36)", async () => {
    setCsrfToken("csrf-m4");
    const { requests, wrapper } = harness([
      {
        path: `${approvalPath}/decide`,
        method: "POST",
        body: { ...wireApproval, state: "decided", decision: "approved", version: 2 },
      },
    ]);
    const decide = renderHook(() => useDecideApproval(wireProjectId), { wrapper });
    decide.result.current.mutate({
      approvalId: WIRE_APPROVAL_ID,
      body: { decision: "approved", comments: "go", version: 1 },
    });
    await waitFor(() => expect(decide.result.current.isSuccess).toBe(true));
    const post = requestsTo(requests, `${approvalPath}/decide`, "POST")[0];
    expect(JSON.parse(String(post.body))).toEqual({
      decision: "approved",
      comments: "go",
      version: 1,
    });
    expect(post.headers.get("x-csrf-token")).toBe("csrf-m4");
    setCsrfToken(null);
  });

  it("a lost race adopts the winner: the cached gate shows the decided state, the loser does not retry", async () => {
    const { requests, queryClient, wrapper } = harness([
      { path: `${approvalPath}/decide`, method: "POST", status: 409, body: winner },
      {
        path: approvalPath,
        body: {
          ...wireApproval,
          state: "decided",
          decision: "rejected",
          decided_by: "someone-else",
          version: 2,
        },
      },
    ]);
    queryClient.setQueryData(queryKeys.approval(WIRE_APPROVAL_ID), wireApproval);
    const decide = renderHook(() => useDecideApproval(wireProjectId), { wrapper });
    decide.result.current.mutate(
      { approvalId: WIRE_APPROVAL_ID, body: { decision: "approved", version: 1 } },
      { onError: (error) => adoptApprovalConflict(queryClient, error) },
    );
    await waitFor(() => expect(decide.result.current.isError).toBe(true));
    expect(approvalConflictOf(decide.result.current.error)?.approval?.decision).toBe("rejected");
    // Patched immediately, and a re-read queued (the conflict body is a summary,
    // the full gate is a GET). Exactly one POST: the loser never retries.
    expect(requestsTo(requests, `${approvalPath}/decide`, "POST")).toHaveLength(1);
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ state: string; decision: string | null }>(
        queryKeys.approval(WIRE_APPROVAL_ID),
      );
      expect(cached?.state).toBe("decided");
      expect(cached?.decision).toBe("rejected");
    });
  });

  it("a non-conflict refusal keeps the gate pending (a refusal is not a decision)", () => {
    const error = Object.assign(new Error("Forbidden"), {
      status: 403,
      body: { type: "x", title: "Forbidden", status: 403 },
    });
    expect(approvalConflictOf(error)).toBeNull();
  });
});

describe("wire → view mapping (api/m4view)", () => {
  it("maps a run response onto the run view without inventing fields", () => {
    const view = viewRun(wireRun);
    expect(view).toMatchObject({
      id: WIRE_RUN_ID,
      status: "running",
      digest_scope: "v1alpha1-canonical-1",
      placement: { scheduled: true },
      assignment_id: expect.any(String),
    });
    // `latest_revision_number` is not on the wire — the view leaves it absent.
    expect(view.latest_revision_number).toBeUndefined();
  });

  it("maps node rows, dropping artifact-ref records with no id (unknown members ignored)", () => {
    const view = viewNodeExecution(wireNodeList.node_executions[0]);
    expect(view.artifact_refs[0]).toMatchObject({ name: "plan.md", kind: "json" });
    expect(view.outcome).toBeNull();
    expect(view.error_class).toBeNull();
    expect(viewArtifactRefs([{ name: "no id, not a ref" }, 7])).toEqual([]);
  });

  it("the tree's child labels come from the library map; absent → the honest id", () => {
    const tree = viewRunTree(wireTree, (id) =>
      id === WIRE_CHILD_PIPELINE_ID ? "module-check" : id,
    );
    expect(tree.children[0]).toMatchObject({
      child_run_id: wireTree.children[0].run.id,
      pipeline_slug: "module-check",
      // Absent on the wire means the compiled default (`03`), stated as fact.
      wait_policy: "completion",
      depth: 1,
    });
    const unknown = viewRunTree(wireTree);
    expect(unknown.children[0].pipeline_slug).toBe(WIRE_CHILD_PIPELINE_ID);
  });

  it("maps control-plane scope rows (kind, iterations) without position indexes", () => {
    const view = viewNodeExecution(wireNodeList.node_executions[1]);
    expect(view.kind).toBe("until");
    expect(view.iterations).toBe(2);
  });
});
