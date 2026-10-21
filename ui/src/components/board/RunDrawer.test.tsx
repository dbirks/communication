/**
 * The board's 440px run drawer (artboard 3c), against the DOM: the
 * accessible-modal contract (role/aria-modal, Esc and × close, focus moves
 * in), the state-coloured header, one labelled cell per top-level step, the
 * gate's own summary when waiting (labelled "from the workflow"), the latest
 * three events, the per-state actions with their confirm steps, and the
 * "Ask about this run…" composer (503 assistant_not_configured disables it
 * with that reason).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { Approval, EventEnvelope, Run } from "../../api/types";
import { RunDrawer } from "./RunDrawer";
import type { CrossProjectRun, CrossProjectRunStep } from "./columns";

const mocks = vi.hoisted(() => ({
  run: { data: null as unknown, isPending: false },
  nodes: { data: null as unknown, isPending: false },
  approvals: { data: null as unknown, isPending: false },
  events: { events: [] as unknown[], status: "live" },
  decide: { mutate: vi.fn(), isPending: false, error: null },
  retry: { mutate: vi.fn(), isPending: false, error: null },
  createDraft: { mutate: vi.fn(), isPending: false, error: null },
  ask: { mutate: vi.fn(), isPending: false, error: null },
}));

vi.mock("../../api/runs", () => ({
  useRun: () => mocks.run,
  useRunNodes: () => mocks.nodes,
  useRetryRun: () => mocks.retry,
}));
vi.mock("../../api/approvals", () => ({
  useProjectApprovals: () => mocks.approvals,
  useDecideApproval: () => mocks.decide,
}));
vi.mock("../../api/runEvents", () => ({ useRunEvents: () => mocks.events }));
vi.mock("../../api/pipelines", () => ({ useCreateDraft: () => mocks.createDraft }));
vi.mock("../../api/assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/assistant")>();
  return { ...actual, useAssistantAsk: () => mocks.ask };
});

afterEach(() => {
  cleanup();
  mocks.run = { data: null, isPending: false };
  mocks.nodes = { data: null, isPending: false };
  mocks.approvals = { data: null, isPending: false };
  mocks.events = { events: [], status: "live" };
  mocks.decide = { mutate: vi.fn(), isPending: false, error: null };
  mocks.retry = { mutate: vi.fn(), isPending: false, error: null };
  mocks.createDraft = { mutate: vi.fn(), isPending: false, error: null };
  mocks.ask = { mutate: vi.fn(), isPending: false, error: null };
});

const RUN_ID = "9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000";
const PIPELINE_ID = "pip-1";
const PROJECT_ID = "p-1";
// Relative to the real clock (formatAge uses `new Date()` inside the drawer).
const NOW = new Date();
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

function steps(states: CrossProjectRunStep["state"][]): CrossProjectRunStep[] {
  const ids = ["plan", "implement", "test", "publish"];
  return states.map((state, index) => ({
    node_id: ids[index % ids.length],
    kind: "agent.acp",
    state,
  }));
}

function boardRun(overrides: Partial<CrossProjectRun> = {}): CrossProjectRun {
  return {
    id: RUN_ID,
    project_id: PROJECT_ID,
    pipeline_id: PIPELINE_ID,
    pipeline_revision_id: "rev-1",
    revision_digest: "d",
    plan_digest: "d",
    status: "waiting_human",
    depth: 0,
    priority: 0,
    created_at: TWO_HOURS_AGO,
    started_at: TWO_HOURS_AGO,
    finished_at: null,
    project_name: "acme-api",
    pipeline_slug: "process-ready-issues",
    pipeline_display_name: "process-ready-issues",
    steps: steps(["succeeded", "waiting", "pending", "pending"]),
    ...overrides,
  };
}

function runDetail(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    project_id: PROJECT_ID,
    pipeline_id: PIPELINE_ID,
    pipeline_revision_id: "rev-1",
    revision_digest: "d",
    plan_digest: "d",
    status: "waiting_human",
    depth: 0,
    priority: 0,
    created_at: TWO_HOURS_AGO,
    started_at: TWO_HOURS_AGO,
    finished_at: null,
    digest_scope: "d",
    paused_reason: null,
    cancel_requested_at: null,
    placement: { scheduled: true },
    expression_evaluations: 0,
    ...overrides,
  };
}

function approval(): Approval {
  return {
    id: "appr-1",
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    node_execution_id: "ne-1",
    node_instance_key: "implement",
    kind: "pipeline_gate",
    summary: "Merge the auth refactor before deploy.",
    artifact_refs: [{ id: "art-1", name: "plan.md", kind: "plan" }],
    approver_roles: ["maintainer"],
    approver_user_ids: [],
    deadline_at: NOW.toISOString(),
    on_timeout: "fail",
    re_requested: false,
    state: "pending",
    decision: null,
    comments: null,
    decided_by: null,
    decided_at: null,
    version: 3,
    created_at: TWO_HOURS_AGO,
  };
}

function event(type: string, seq: number, payload: Record<string, unknown>): EventEnvelope {
  return {
    event_id: `ev-${seq}`,
    global_seq: seq,
    type,
    schema_version: 1,
    occurred_at: NOW.toISOString(),
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    actor: { kind: "system", id: "system" },
    payload,
  } as unknown as EventEnvelope;
}

function renderDrawer(run: CrossProjectRun, onClose = vi.fn()) {
  const utils = render(
    <MemoryRouter initialEntries={["/board"]}>
      <RunDrawer runId={RUN_ID} boardRun={run} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onClose, ...utils };
}

describe("RunDrawer", () => {
  it("opens as an accessible modal: dialog role, state header, title and meta", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const drawer = screen.getByRole("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("data-testid")).toBe("run-drawer");
    expect(screen.getByTestId("run-drawer-state").textContent).toBe("NEEDS YOUR DECISION");
    expect(screen.getByTestId("run-drawer-title").textContent).toContain("process-ready-issues");
    const meta = screen.getByTestId("run-drawer-title").parentElement!.textContent ?? "";
    expect(meta).toContain("workflow #9c1e");
    expect(meta).toContain("acme-api");
    expect(meta).toContain("started 2h");
  });

  it("renders one labelled cell per top-level step, coloured by the step state", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const strip = screen.getByTestId("run-drawer-steps");
    expect(within(strip).getAllByTestId(/^run-drawer-step-/).length).toBe(4);
    const implement = screen.getByTestId("run-drawer-step-implement");
    expect(implement.getAttribute("aria-label")).toBe("step implement: waiting");
    expect(implement.className).toContain("bg-seg-waiting");
  });

  it("shows the pending gate's own summary, labelled, with the plan link", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const summary = screen.getByTestId("run-drawer-summary");
    expect(summary.textContent).toContain("Merge the auth refactor before deploy.");
    expect(summary.textContent).toContain("from the workflow");
    expect(screen.queryByText(/written by the model/i)).toBeNull();
    const plan = screen.getByTestId("run-drawer-plan-link");
    expect(plan.getAttribute("href")).toBe("/artifacts/art-1");
  });

  it("lists the latest three events with a time and a one-line detail", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    mocks.events = {
      events: [
        event("run.started", 1, {}),
        event("node.leased", 2, {}),
        event("node.waiting", 3, { status: "waiting_human" }),
      ],
      status: "live",
    };
    renderDrawer(boardRun());
    const items = screen.getAllByTestId("run-drawer-event-item");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("node.waiting");
    expect(items[0].textContent).toContain("waiting_human");
    expect(items[0].querySelector("time")).toBeTruthy();
  });

  it("waiting: Approve asks for confirmation, then decides the pending gate", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    fireEvent.click(screen.getByTestId("run-drawer-approve"));
    fireEvent.click(screen.getByTestId("run-drawer-approve-confirm"));
    expect(mocks.decide.mutate).toHaveBeenCalledWith(
      {
        approvalId: "appr-1",
        body: { decision: "approved", version: 3 },
      },
      expect.anything(),
    );
  });

  it("waiting without a pending approval: Approve stays shut and says why", () => {
    mocks.run = { data: runDetail({ status: "paused" }), isPending: false };
    mocks.approvals = { data: { approvals: [] }, isPending: false };
    renderDrawer(
      boardRun({
        status: "paused",
        steps: steps(["succeeded", "succeeded", "pending", "pending"]),
      }),
    );
    expect((screen.getByTestId("run-drawer-approve") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("run-drawer-approve").textContent).toBe("Approve");
    expect(screen.getByText(/No approval is pending/)).toBeTruthy();
  });

  it("failed: Retry from the failed step confirms, then targets that node only", () => {
    const row = boardRun({
      status: "failed",
      steps: steps(["succeeded", "failed", "pending", "pending"]),
    });
    mocks.run = {
      data: runDetail({ status: "failed", failed_cause: "node_execution_failed:implement" }),
      isPending: false,
    };
    mocks.approvals = { data: { approvals: [] }, isPending: false };
    renderDrawer(row);
    const retry = screen.getByTestId("run-drawer-retry");
    expect(retry.textContent).toContain("Retry from implement");
    fireEvent.click(retry);
    fireEvent.click(screen.getByTestId("run-drawer-retry-confirm"));
    expect(mocks.retry.mutate).toHaveBeenCalledWith({ node_instance_keys: ["implement"] });
  });

  it("failed: Fix the workflow starts a draft from the pinned revision", () => {
    const row = boardRun({
      status: "failed",
      steps: steps(["succeeded", "failed", "pending", "pending"]),
    });
    mocks.run = {
      data: runDetail({ status: "failed", failed_cause: "node_execution_failed:implement" }),
      isPending: false,
    };
    mocks.approvals = { data: { approvals: [] }, isPending: false };
    renderDrawer(row);
    fireEvent.click(screen.getByTestId("run-drawer-fix"));
    fireEvent.click(screen.getByTestId("run-drawer-fix-confirm"));
    expect(mocks.createDraft.mutate).toHaveBeenCalledWith(
      { from_revision_id: "rev-1" },
      expect.anything(),
    );
  });

  it("Open run › is always present and links the project-less workbench route", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const open = screen.getByTestId("run-drawer-open-run");
    expect(open.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
  });

  it("Esc, the × and the backdrop all close, and the drawer unmounts", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    const { onClose } = renderDrawer(boardRun());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("× and the backdrop close too", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    const { onClose } = renderDrawer(boardRun());
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.click(screen.getByLabelText("Close run drawer"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the drawer on open and back to the opener on close", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <MemoryRouter initialEntries={["/board"]}>
        <RunDrawer runId={RUN_ID} boardRun={boardRun()} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("ask: submits the question with the run's route as context, and shows the answer inline", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const input = screen.getByTestId("run-drawer-ask-input");
    fireEvent.change(input, { target: { value: "why is implement waiting?" } });
    let options: { onSuccess?: (answer: never) => void } | undefined;
    mocks.ask.mutate.mockImplementation((_arg: unknown, opts?: unknown) => {
      options = opts as typeof options;
    });
    fireEvent.submit(screen.getByTestId("run-drawer-ask"));
    expect(mocks.ask.mutate).toHaveBeenCalledWith(
      { question: "why is implement waiting?", route: `/runs/${RUN_ID}` },
      expect.anything(),
    );
    const answer = {
      answer_markdown: "The gate waits for a maintainer decision.",
      links: [],
      tool_calls: [],
      assistant_turn_id: "t-1",
    };
    act(() => {
      options?.onSuccess?.(answer as never);
    });
    expect(screen.getByTestId("run-drawer-ask-answer").textContent).toContain(
      "The gate waits for a maintainer decision.",
    );
  });

  it("ask: a 503 assistant_not_configured disables the composer with that reason", () => {
    mocks.run = { data: runDetail(), isPending: false };
    mocks.approvals = { data: { approvals: [approval()] }, isPending: false };
    renderDrawer(boardRun());
    const input = screen.getByTestId("run-drawer-ask-input");
    fireEvent.change(input, { target: { value: "hello?" } });
    let options: { onError?: (error: Error) => void } | undefined;
    mocks.ask.mutate.mockImplementation((_arg: unknown, opts?: unknown) => {
      options = opts as typeof options;
    });
    fireEvent.submit(screen.getByTestId("run-drawer-ask"));
    act(() => {
      options?.onError?.(
        new ApiError(
          {
            type: "https://communication.example/problems/assistant",
            title: "Assistant unavailable",
            status: 503,
            detail: "",
          } as never,
          { degraded: "assistant_not_configured" },
        ),
      );
    });
    expect(screen.getByTestId("run-drawer-ask-unavailable").textContent).toContain(
      "assistant_not_configured",
    );
    expect((screen.getByTestId("run-drawer-ask-input") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("run-drawer-ask-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
