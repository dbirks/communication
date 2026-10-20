/**
 * The workbench's right dock, keyed by the node's kind: `agent.acp` leads
 * with the conversation panel (mocked — one chat surface is proven in
 * Conversation.test.tsx), `process.exec` reads the attempt's captured stdout,
 * `human.approval` leads with the gate card and its decide verbs, and a node
 * with more than one attempt gets attempt tabs.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewNodeExecution, viewRun } from "../../api/m4view";
import {
  conversationId,
  meFixture,
  mockFetch,
  projectFixture,
  turnId,
  type RouteStub,
} from "../../test/fakes";
import type { Attempt, NodeExecution } from "../../api/types";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";
import { WorkbenchDock, type WorkbenchDockProps } from "./WorkbenchDock";
import {
  WIRE_NODE_PLAN,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wireAttempt,
  wireNodeDetail,
  wireNodeList,
  wireProjectId,
  wireRun,
} from "../../test/fixtures/m4/wire";

vi.mock("../conversation/AgentConversationPanel", () => ({
  AgentConversationPanel: (props: {
    conversationId: string;
    turnFilter?: string;
    attemptTurnId?: string;
    variant?: string;
  }) => (
    <div
      data-testid="mock-agent-conversation"
      data-conversation-id={props.conversationId}
      data-turn-filter={props.turnFilter ?? ""}
      data-attempt-turn-id={props.attemptTurnId ?? ""}
      data-variant={props.variant ?? ""}
    />
  ),
}));

afterEach(cleanup);

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const NODES: readonly NodeExecutionSummary[] = wireNodeList.node_executions.map(viewNodeExecution);

function baseProps(): Omit<WorkbenchDockProps, "execution" | "attemptNumber" | "onAttemptChange"> {
  return {
    run: viewRun(wireRun),
    projectId: wireProjectId,
    definitionNode: null,
    nodes: NODES,
    frames: [],
    tree: null,
  };
}

function renderDock(
  execution: NodeExecutionSummary | null,
  extra: RouteStub[] = [],
  over: Partial<Pick<WorkbenchDockProps, "attemptNumber" | "onAttemptChange" | "tree">> = {},
) {
  const onAttemptChange = vi.fn();
  const { requests } = mockFetch([
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
    {
      path: `/api/v1/projects/${wireProjectId}/approvals`,
      body: { ...wireApprovalList, approvals: [] },
    },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkbenchDock
          {...baseProps()}
          execution={execution}
          attemptNumber={null}
          onAttemptChange={onAttemptChange}
          {...over}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, onAttemptChange };
}

const row = (over: Partial<NodeExecution>): NodeExecutionSummary =>
  viewNodeExecution({ ...wireNodeList.node_executions[0], ...over });

/** One child-run tree row, keyed by the invocation's own instance key. */
function childRunRow(key: string, runId: string) {
  return {
    node_instance_key: key,
    child_run_id: runId,
    pipeline_slug: "issue-implementation",
    revision_digest: "sha256:ab",
    depth: 1,
    wait_policy: "completion" as const,
    status: "running" as const,
    created_at: "2026-01-01T12:00:00Z",
    started_at: "2026-01-01T12:00:05Z",
    finished_at: null,
  };
}

describe("WorkbenchDock", () => {
  it("says so honestly when no node is selected", async () => {
    renderDock(null);
    expect(await screen.findByTestId("workbench-dock-empty")).toBeTruthy();
  });

  it("says the agent has not started when the attempt holds no conversation", async () => {
    renderDock(row({}), [{ path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: wireNodeDetail }]);
    expect(await screen.findByTestId("dock-no-conversation")).toBeTruthy();
    expect(screen.getByTestId("dock-title").textContent).toContain("/plan");
  });

  it("rides the shared conversation when a takeover re-run is not stamped yet, and says the factory took the conversation back", async () => {
    const prior: Attempt = {
      ...wireAttempt,
      id: "01987b25-000a-7000-8000-abcdef012345",
      attempt_number: 1,
      status: "interrupted",
      error_class: "interrupted",
      outputs: null,
      outputs_digest: null,
      conversation_id: conversationId,
      turn_id: turnId,
    };
    const rerun: Attempt = {
      ...wireAttempt,
      id: "01987b25-000b-7000-8000-abcdef012345",
      attempt_number: 2,
      status: "queued",
      retry_context: {
        human_takeover: { turns: [], turn_count: 0, returned_by: "u1", reason: "human_takeover" },
      },
      conversation_id: null,
      turn_id: null,
    };
    const detail = {
      ...wireNodeDetail,
      attempts: [prior, rerun],
      checkpoint: null,
    };
    // The newest attempt (the re-run) leads the dock: it holds no
    // conversation yet — stamped at claim time — but attempt 1's does.
    renderDock(row({ attempt_count: 2, status: "running" }), [
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: detail },
    ]);
    const note = await screen.findByTestId("dock-attempt-restarting");
    expect(note.textContent).toContain("Attempt 2 is starting");
    expect(note.textContent).toContain("the factory took the conversation back");
    expect(note.textContent).toContain("attempt 1 opened");
    // The SAME conversation the interrupted attempt opened: its control
    // badge is live on this pane, not an empty dock.
    const panel = screen.getByTestId("mock-agent-conversation");
    expect(panel.getAttribute("data-conversation-id")).toBe(conversationId);
    expect(panel.closest('[data-testid="dock-conversation"]')).toBeTruthy();
    expect(screen.queryByTestId("dock-no-conversation")).toBeNull();
  });

  it("renders the conversation panel for an agent.acp attempt, as the main content", async () => {
    const detail = {
      ...wireNodeDetail,
      attempts: [
        {
          ...wireAttempt,
          conversation_id: conversationId,
          turn_id: turnId,
          outputs: { summary: "Fixed the TTL comparison" },
          outputs_digest: `sha256:${"9c1f".repeat(16)}`,
        },
      ],
    };
    renderDock(row({}), [{ path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: detail }]);

    const panel = await screen.findByTestId("mock-agent-conversation");
    expect(panel.getAttribute("data-conversation-id")).toBe(conversationId);
    // The dock shows the WHOLE conversation (a takeover opens a new turn in
    // the same one) and only marks where this attempt's turn starts.
    expect(panel.getAttribute("data-turn-filter")).toBe("");
    expect(panel.getAttribute("data-attempt-turn-id")).toBe(turnId);
    expect(panel.getAttribute("data-variant")).toBe("dock");
    expect(panel.closest('[data-testid="dock-conversation"]')).toBeTruthy();
  });

  it("reads a process.exec attempt's captured stdout, not the whole log", async () => {
    const execId = "01987b24-000d-7000-8000-abcdef012345";
    const detail = {
      ...wireNodeDetail,
      attempts: [
        {
          ...wireAttempt,
          id: "01987b25-000d-7000-8000-abcdef012345",
          status: "succeeded" as const,
          outputs: {
            summary: "module check clean",
            exit_code: 0,
            stdout_preview: "checking 3 modules\nok",
            stdout_bytes: 32,
            stderr_bytes: 0,
          },
          outputs_digest: `sha256:${"ab3c".repeat(16)}`,
        },
      ],
    };
    renderDock(
      row({
        id: execId,
        node_id: "verify",
        kind: "process.exec",
        node_instance_key: "/verify",
        status: "succeeded",
      }),
      [{ path: `${RUN_PATH}/nodes/${execId}`, body: detail }],
    );

    const facts = await screen.findByTestId("attempt-process-facts");
    expect(facts.textContent).toContain("checking 3 modules");
    expect(facts.textContent).toContain("captured 32 / 0 bytes");
    expect(screen.getByTestId("attempt-exit-code").textContent).toBe("0");
    // The gate card never rides along on an exec node.
    expect(screen.queryByTestId("approval-summary")).toBeNull();
  });

  it("leads a human.approval node with the ApprovalCard and its decide verbs", async () => {
    const gateId = "01987b24-0009-7000-8000-abcdef012345";
    renderDock(
      row({
        id: gateId,
        node_id: "approve",
        kind: "human.approval",
        node_instance_key: "/approve",
        status: "waiting",
        waiting_reason: "approval",
        attempt_count: 0,
      }),
      [
        { path: `${RUN_PATH}/nodes/${gateId}`, body: { ...wireNodeDetail, attempts: [] } },
        {
          path: `/api/v1/projects/${wireProjectId}/approvals`,
          body: {
            ...wireApprovalList,
            approvals: [{ ...wireApproval, node_execution_id: gateId }],
          },
        },
      ],
    );

    const summary = await screen.findByTestId("approval-summary");
    expect(summary.closest('[data-testid="workbench-dock"]')).toBeTruthy();
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
    expect(screen.getByTestId("approval-reject")).toBeTruthy();
    // A gate with no attempts does not spin on "Reading attempts…".
    expect(screen.queryByTestId("workbench-dock-pending")).toBeNull();
  });

  it("gives the dock attempt tabs when the node ran more than once", async () => {
    const interrupted: Attempt = {
      ...wireAttempt,
      id: "01987b25-0001-7000-8000-abcdef012345",
      attempt_number: 1,
      status: "interrupted",
      error_class: "interrupted",
      outputs: null,
      outputs_digest: null,
    };
    const replacement: Attempt = {
      ...wireAttempt,
      id: "01987b25-0002-7000-8000-abcdef012345",
      attempt_number: 2,
      status: "succeeded",
      outputs: { summary: "Implemented the approved plan" },
      outputs_digest: `sha256:${"9c1f".repeat(16)}`,
    };
    const detail = {
      ...wireNodeDetail,
      attempts: [interrupted, replacement],
      checkpoint: null,
    };
    const { onAttemptChange } = renderDock(row({ attempt_count: 2, status: "succeeded" }), [
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: detail },
    ]);

    await screen.findByTestId("dock-attempt-2");
    expect(screen.getByTestId("dock-attempt-1")).toBeTruthy();
    // The newest attempt leads: attempt 2's succeeded chip is what shows.
    expect(screen.getByTestId("attempt-status").textContent).toBe("succeeded");

    fireEvent.click(screen.getByTestId("dock-attempt-1"));
    // The tab does not write its own state — it hands the pick to the URL.
    expect(onAttemptChange).toHaveBeenCalledWith(1);
    // With the URL's `attempt=1` applied, the dock reads attempt 1 instead.
    cleanup();
    const detail2 = { ...detail };
    const { onAttemptChange: secondClick } = renderDock(
      row({ attempt_count: 2, status: "succeeded" }),
      [{ path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`, body: detail2 }],
      { attemptNumber: 1 },
    );
    await screen.findByTestId("dock-attempt-1");
    expect(screen.getByTestId("attempt-status").textContent).toBe("interrupted");
    expect(secondClick).not.toHaveBeenCalled();
  });

  it("shows the failure block for a failed exec node, in the inspector's words", async () => {
    const execId = "01987b24-000e-7000-8000-abcdef012345";
    const detail = {
      ...wireNodeDetail,
      attempts: [
        {
          ...wireAttempt,
          id: "01987b25-000e-7000-8000-abcdef012345",
          status: "failed" as const,
          error_class: "agent_error" as const,
          detail: "module check exited 1",
          outputs: null,
          outputs_digest: null,
        },
      ],
      checkpoint: null,
    };
    renderDock(
      row({
        id: execId,
        node_id: "verify",
        kind: "process.exec",
        node_instance_key: "/verify",
        status: "failed",
        error_class: "agent_error",
        failed_cause: "node_execution_failed:/verify",
        attempt_count: 1,
      }),
      [{ path: `${RUN_PATH}/nodes/${execId}`, body: detail }],
    );

    expect(await screen.findByTestId("dock-failure")).toBeTruthy();
    expect(screen.getByTestId("dock-error-class").textContent).toBe("agent_error");
    expect(screen.getByTestId("dock-attempt-count").textContent).toContain("attempt 1 of");
  });

  it("links a pipeline.invoke to its child run through the run tree", async () => {
    const invokeId = "01987b24-000f-7000-8000-abcdef012345";
    const detail = {
      ...wireNodeDetail,
      attempts: [
        {
          ...wireAttempt,
          id: "01987b25-000f-7000-8000-abcdef012345",
          status: "succeeded" as const,
          outputs: { summary: "issue 13 closed" },
          outputs_digest: `sha256:${"de5f".repeat(16)}`,
        },
      ],
      checkpoint: null,
    };
    renderDock(
      row({
        id: invokeId,
        node_id: "invoke",
        kind: "pipeline.invoke",
        node_instance_key: "/fan_out[13]/invoke",
        status: "succeeded",
      }),
      [{ path: `${RUN_PATH}/nodes/${invokeId}`, body: detail }],
      {
        tree: {
          run_id: WIRE_RUN_ID,
          status: "running",
          depth: 0,
          children: [childRunRow("/fan_out[13]/invoke", "child-run-13")],
        },
      },
    );

    const line = await screen.findByTestId("dock-child-run-line");
    expect(line.textContent).toContain("issue-implementation");
    expect(line.textContent).toContain("running");
    const link = screen.getByTestId("dock-child-run-link");
    expect(link.textContent).toBe("Open child run");
    expect(link.getAttribute("href")).toBe(`/projects/${wireProjectId}/runs/child-run-13`);
  });

  it("says so when a pipeline.invoke has no child run in the tree yet", async () => {
    renderDock(
      row({
        node_id: "invoke",
        kind: "pipeline.invoke",
        node_instance_key: "/fan_out[1]/invoke",
        status: "running",
      }),
      [
        {
          path: `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`,
          body: { ...wireNodeDetail, attempts: [], checkpoint: null },
        },
      ],
      { tree: { run_id: WIRE_RUN_ID, status: "running", depth: 0, children: [] } },
    );
    expect(await screen.findByTestId("dock-no-child-run")).toBeTruthy();
    expect(screen.queryByTestId("dock-child-run-link")).toBeNull();
  });

  it("keeps the failure block on a control-plane failure with no worker attempt", async () => {
    const invokeId = "01987b24-0010-7000-8000-abcdef012345";
    const detail = {
      ...wireNodeDetail,
      attempts: [],
      checkpoint: null,
    };
    renderDock(
      row({
        id: invokeId,
        node_id: "invoke",
        kind: "pipeline.invoke",
        node_instance_key: "/fan_out[12]/invoke",
        status: "failed",
        error_class: "infra",
        failed_cause: "child_run_failed:node_execution_failed:/implement",
        attempt_count: 0,
        attempt_limit: 1,
      }),
      [{ path: `${RUN_PATH}/nodes/${invokeId}`, body: detail }],
      {
        tree: {
          run_id: WIRE_RUN_ID,
          status: "failed",
          depth: 0,
          children: [{ ...childRunRow("/fan_out[12]/invoke", "child-run-12"), status: "failed" }],
        },
      },
    );

    const failure = await screen.findByTestId("dock-failure");
    expect(failure).toBeTruthy();
    expect(screen.getByTestId("dock-error-class").textContent).toBe("infra");
    expect(screen.getByTestId("dock-failed-cause").textContent).toBe(
      "child_run_failed:node_execution_failed:/implement",
    );
    expect(screen.getByTestId("dock-attempt-count").textContent).toBe("attempt 0 of 1");
    expect(screen.getByTestId("dock-no-attempt").textContent).toContain("no worker attempt");
    expect(screen.getByTestId("dock-child-run-link").textContent).toBe("Open child run");
  });
});
