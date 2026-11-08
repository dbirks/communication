/**
 * The graph-first Run Workbench at `/projects/:projectId/runs/:runId`
 * (ADR-0043). React Flow in jsdom needs ResizeObserver/DOMMatrix stubs —
 * the same doubles StudioCanvas.test.tsx installs.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRunPage } from "../test/inspectorMount";
import {
  FakeEventSource,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import RunWorkbench from "./RunWorkbench";
import { shortId } from "../lib/format";
import type { Attempt, NodeExecution } from "../api/types";
import {
  WIRE_NODE_IMPLEMENT,
  WIRE_NODE_LOOP,
  WIRE_NODE_PLAN,
  WIRE_ATTEMPT_1,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApproval,
  wireApprovalList,
  wireAttempt,
  wireNodeDetail,
  wireNodeList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunEvent,
  wireRunList,
  wireTree,
} from "../test/fixtures/m4/wire";

const RUN_PATH = `/api/v1/runs/${WIRE_RUN_ID}`;
const WIRE_NODE_APPROVE = "01987b24-0009-7000-8000-abcdef012345";

class ResizeObserverStub {
  private readonly callback: (
    entries: { target: Element; contentRect: { width: number; height: number } }[],
  ) => void;
  constructor(
    callback: (
      entries: { target: Element; contentRect: { width: number; height: number } }[],
    ) => void,
  ) {
    this.callback = callback;
  }
  observe(target: Element): void {
    queueMicrotask(() => this.callback([{ target, contentRect: { width: 1200, height: 800 } }]));
  }
  unobserve(): void {}
  disconnect(): void {}
}

class DOMMatrixStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m22 = 1;
  multiplySelf(): this {
    return this;
  }
  translateSelf(): this {
    return this;
  }
  scaleSelf(): this {
    return this;
  }
}

const offsetPatch: { offsetWidth: PropertyDescriptor; offsetHeight: PropertyDescriptor } = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!,
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!,
};

beforeEach(() => {
  // jsdom doubles (StudioCanvas.test.tsx): React Flow measures via
  // ResizeObserver and offsetWidth/offsetHeight, which jsdom reports 0 for.
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrix", DOMMatrixStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixStub);
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 208,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 96,
  });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetPatch.offsetWidth);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetPatch.offsetHeight);
  cleanup();
});

/** The same run held at its gate: `approve` waits for a human and nothing
 * else has started — the auto-select rule's other half. */
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

function mount(search = "", extra: RouteStub[] = []): ReturnType<typeof mountRunPage> {
  return mountRunPage({
    path: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}${search}`,
    routes: routes(extra),
    element: <RunWorkbench />,
  });
}

/** The canvas's step rows land after React Flow's measurement microtask; give
 * them the room a loaded machine needs. */
const stepRow = (id: string) => screen.findByTestId(id, undefined, { timeout: 5000 });

describe("the Run Workbench", () => {
  it("opens on the Graph tab with the pinned revision's canvas", async () => {
    const { requests } = mount();

    // The title is the run's own goal input, not "Run #<id>".
    const title = await screen.findByTestId("run-title");
    expect(title.textContent).toContain("ship M4");

    // Graph is the default view: selected, and the canvas comes from the
    // pinned revision's document, not the library's newest.
    expect(screen.getByTestId("workbench-tab-graph").getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("workbench-graph-view")).toBeTruthy();
    expect(await screen.findByTestId("studio-canvas")).toBeTruthy();
    expect(requestsTo(requests, `/api/v1/revisions/${wireRun.pipeline_revision_id}`)).toHaveLength(
      1,
    );
    // The run's state lands on the canvas as overlays, not as extra nodes.
    expect(await stepRow("canvas-step-row-plan")).toBeTruthy();
  });

  it("?full=1 folds the graph into the step strip and centres the transcript at 760px", async () => {
    mount("?full=1");
    await screen.findByTestId("run-title");
    const strip = await screen.findByTestId("workbench-step-strip", undefined, { timeout: 5000 });
    // The canvas is folded away and the split's tab row leaves with it.
    expect(screen.queryByTestId("workbench-graph-frame")).toBeNull();
    expect(screen.queryByTestId("workbench-tab-graph")).toBeNull();
    // One cell per TOP-LEVEL step, in the pinned revision's document order.
    const cells = strip.querySelectorAll("[data-testid^='workbench-step-cell-']");
    expect(Array.from(cells).map((cell) => cell.getAttribute("data-testid"))).toEqual([
      "workbench-step-cell-plan",
      "workbench-step-cell-approve",
      "workbench-step-cell-build_until_verified",
      "workbench-step-cell-verdict",
      "workbench-step-cell-publish_verified",
      "workbench-step-cell-publish_needs_attention",
    ]);
    // The loop cell wears the graph overlay's iteration counter, compacted.
    expect(screen.getByTestId("workbench-step-cell-build_until_verified").textContent).toContain(
      "1/2",
    );
    // The transcript is centred and capped at 760px.
    const transcript = screen.getByTestId("workbench-fullscreen-transcript");
    expect(transcript.className).toContain("max-w-[760px]");
  });

  it("a strip cell selects that step's transcript, and ⤡ show graph returns to the split", async () => {
    mount("?full=1&node=plan", [
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_LOOP}`, body: wireNodeDetail },
    ]);
    await screen.findByTestId("run-title");
    const planCell = await screen.findByTestId("workbench-step-cell-plan", undefined, {
      timeout: 5000,
    });
    // The deep-link selection (node=plan) is the raised cell.
    expect(planCell.getAttribute("aria-pressed")).toBe("true");
    expect(planCell.className).toContain("shadow-(--shadow-raised)");

    // Clicking the loop's cell is clicking its node on the graph: the dock
    // follows to the scope's own execution.
    fireEvent.click(screen.getByTestId("workbench-step-cell-build_until_verified"));
    // The dock follows to the scope's own execution: its pane header carries the
    // instance key (the dock title says only the kind — a path printed twice in
    // one pane is one too many).
    expect(await screen.findByTestId("node-pane-key")).toBeTruthy();
    expect(screen.getByTestId("node-pane-key").textContent).toContain("/build_until_verified");
    expect(
      screen.getByTestId("workbench-step-cell-build_until_verified").getAttribute("aria-pressed"),
    ).toBe("true");

    // ⤡ show graph: `full` leaves the URL and the canvas is back.
    fireEvent.click(screen.getByTestId("workbench-show-graph"));
    expect(screen.queryByTestId("workbench-step-strip")).toBeNull();
    expect(await stepRow("canvas-step-row-plan")).toBeTruthy();
  });

  it("Esc leaves full screen — but not while the reader is typing", async () => {
    mount("?full=1");
    await screen.findByTestId("run-title");
    await screen.findByTestId("workbench-step-strip", undefined, { timeout: 5000 });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByTestId("workbench-step-strip")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("workbench-step-strip")).toBeNull());
    input.remove();
  });

  it("auto-selects the gate the run is waiting on before the reader clicks", async () => {
    mount("", [
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
      {
        path: `/api/v1/projects/${wireProjectId}/approvals`,
        body: {
          ...wireApprovalList,
          approvals: [{ ...wireApproval, node_execution_id: WIRE_NODE_APPROVE }],
        },
      },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_APPROVE}`, body: wireNodeDetail },
    ]);

    // The reader lands on the thing they owe an answer to: no click first.
    // The card can only exist after a real sequential chain: run + nodes
    // fetches → the auto-select effect rewrites the URL → the dock's own
    // node-detail fetch. Each round resolves in microtasks, but under the
    // full suite their wall time outruns the default 1000 ms findBy window
    // (observed ~1270 ms), so the intermediate state is awaited explicitly
    // and the final find gets the same justified room as `stepRow`.
    await stepRow("canvas-step-row-approve");
    const summary = await screen.findByTestId("approval-summary", undefined, {
      timeout: 5000,
    });
    expect(summary.closest('[data-testid="workbench-dock"]')).toBeTruthy();
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(screen.getByTestId("decision-reject")).toBeTruthy();
    // The graph agrees: the gate is the raised node.
    expect((await stepRow("canvas-step-row-approve")).className).toContain("bg-accent-wash");
  });

  it("auto-selects the gate that opens after first data had nothing needing attention", async () => {
    // The acceptance node set with the gate not yet open: plan succeeded,
    // approve still pending, the scopes not started — the first data needs
    // no attention, so the auto-select latch must stay open for the gate.
    const wireGateNotOpen: NodeExecution[] = [
      { ...wireWaitingNodes[0], status: "pending", waiting_reason: null },
      wireNodeList.node_executions[0],
    ];
    const nodesRoute: RouteStub = {
      path: `${RUN_PATH}/nodes`,
      body: { node_executions: wireGateNotOpen },
    };
    const { requests } = mount("", [
      nodesRoute,
      {
        path: `/api/v1/projects/${wireProjectId}/approvals`,
        body: {
          ...wireApprovalList,
          approvals: [{ ...wireApproval, node_execution_id: WIRE_NODE_APPROVE }],
        },
      },
      { path: `${RUN_PATH}/nodes/${WIRE_NODE_APPROVE}`, body: wireNodeDetail },
    ]);

    // First data: nothing needs attention — the dock asks for a pick and no
    // box is raised.
    await stepRow("canvas-step-row-plan");
    expect(screen.getByTestId("workbench-dock-empty")).toBeTruthy();
    expect(screen.getByTestId("canvas-step-row-plan").className).not.toContain("bg-accent-wash");

    // The gate opens: the journal now carries the wait and the stream
    // delivers the frame; the stream's invalidation refetches the nodes and
    // the auto-select rule still has its door open.
    nodesRoute.body = { node_executions: wireWaitingNodes };
    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "approval.requested",
          { node_instance_key: "/approve", approval_id: wireApproval.id },
          { node_execution_id: WIRE_NODE_APPROVE, global_seq: 9701 },
        ),
      );
    });

    const summary = await screen.findByTestId("approval-summary", undefined, { timeout: 5000 });
    expect(summary.closest('[data-testid="workbench-dock"]')).toBeTruthy();
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(screen.getByTestId("decision-reject")).toBeTruthy();
    // The graph agrees: the gate is the raised node.
    await waitFor(() =>
      expect(screen.getByTestId("canvas-step-row-approve").className).toContain("bg-accent-wash"),
    );
    // The refetch after the frame is what proved the wait.
    expect(requestsTo(requests, `${RUN_PATH}/nodes`)).toHaveLength(2);
  });

  it("never moves a user's selection again, even when events shift the attention", async () => {
    const { requests } = mount();
    await screen.findByTestId("studio-canvas");

    // The reader's own pick, after the auto-select has already fired.
    fireEvent.click(await stepRow("canvas-step-row-plan"));
    await waitFor(() =>
      expect(requestsTo(requests, `${RUN_PATH}/nodes/${WIRE_NODE_PLAN}`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("canvas-step-row-plan").className).toContain("bg-accent-wash"),
    );

    // A failure lands on the node the run was in flight in — the old rule
    // would have yanked the selection to it.
    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "node.attempt.failed",
          {
            node_instance_key: "/build_until_verified[1]/implement",
            attempt_number: 1,
            error_class: "agent_error",
            detail: "agent exited 1",
          },
          { node_execution_id: WIRE_NODE_IMPLEMENT, global_seq: 9601 },
        ),
      );
    });

    await screen.findByTestId("dock-title");
    await waitFor(() => {
      expect(screen.getByTestId("canvas-step-row-plan").className).toContain("bg-accent-wash");
      expect(screen.getByTestId("canvas-step-row-implement").className).not.toContain(
        "bg-accent-wash",
      );
    });
    // The dock still reads the node the reader picked — named by the pane
    // header, while the title says the kind once.
    expect(screen.getByTestId("dock-title").textContent).toBe("agent");
    expect(screen.getByTestId("node-pane-crumb").textContent).toContain("plan");
  });

  it("renders the timeline for ?view=timeline", async () => {
    mount("?view=timeline");

    await screen.findByTestId("run-title");
    expect(screen.getByTestId("workbench-tab-timeline").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("workbench-graph-view")).toBeNull();
    expect(await screen.findByTestId("run-timeline-empty")).toBeTruthy();
  });

  it("maps the old inspector link ?tab=execution to the tree view", async () => {
    mount("?tab=execution");

    await screen.findByTestId("run-title");
    // The rewrite happens on first data — then the tree view is what renders,
    // reached through its toggle (the old tab's testid lives on the toggle,
    // not on a fifth tab button).
    await waitFor(() =>
      expect(screen.getByTestId("workbench-tab-tree").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(await screen.findByTestId("run-tree")).toBeTruthy();
    expect(screen.queryByTestId("workbench-graph-view")).toBeNull();
  });

  it("reaches the execution tree from the toggle inside the Graph view", async () => {
    mount();
    await screen.findByTestId("workbench-graph-view");
    expect(screen.getByTestId("workbench-tab-tree").textContent).toContain("execution tree");
    expect(screen.queryByTestId("run-tree")).toBeNull();

    fireEvent.click(screen.getByTestId("workbench-tab-tree"));
    await waitFor(() =>
      expect(screen.getByTestId("workbench-tab-tree").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(await screen.findByTestId("run-tree")).toBeTruthy();
    expect(screen.queryByTestId("workbench-graph-view")).toBeNull();
  });

  it("lists the run's referenced artifacts on the Artifacts tab with the count badge", async () => {
    mount("?view=artifacts");

    await screen.findByTestId("run-title");
    expect(screen.getByTestId("workbench-tab-artifacts").getAttribute("aria-selected")).toBe(
      "true",
    );
    const view = await screen.findByTestId("workbench-artifacts-view");
    // The wire's run names one artifact (the plan step's `plan.md`): the
    // badge is the client-side sum of the steps' artifact_refs.
    expect(screen.getByTestId("workbench-artifacts-badge").textContent).toBe("1");
    const link = screen.getByTestId("workbench-artifact-link-0");
    expect(link.textContent).toContain("plan.md");
    expect(link.getAttribute("href")).toContain("/artifacts/");
    expect(view.textContent).toContain("referenced by /plan");
  });

  it("shows the honest empty state when no step has referenced an artifact", async () => {
    const noRefs: NodeExecution[] = wireNodeList.node_executions.map((node) => ({
      ...node,
      artifact_refs: [],
    }));
    mount("?view=artifacts", [{ path: `${RUN_PATH}/nodes`, body: { node_executions: noRefs } }]);

    await screen.findByTestId("workbench-artifacts-empty");
    expect(screen.queryByTestId("workbench-artifacts-badge")).toBeNull();
    expect(screen.getByTestId("workbench-artifacts-project-link")).toBeTruthy();
  });
});

/* -------------------------------------------------- the header stays honest */

describe("the run header's facts row", () => {
  it("names the workflow, the pinned revision and the started age; the run's handle rides the title", async () => {
    mount();

    // Finding 11 split the old one-line mono sentence into labeled facts:
    // `Workflow · rev {n}`, `Repository`, `Started`, `Pinned digest`.
    // Round-2 review item 3 (hide internal ids where a name exists) still
    // holds: this run serves a `goal` input, which IS its title, so the short
    // id is not printed in the copy — it rides the facts row's `title` and the
    // URL in the address bar.
    const facts = await screen.findByTestId("run-header-meta");
    expect(facts.textContent).toContain("feature-development");
    expect(facts.textContent).not.toContain("#");
    expect(facts.getAttribute("title")).toBe(`run ${shortId(WIRE_RUN_ID)}`);
    // The H1 says the same thing the meta used to spell with the handle.
    expect(screen.getByTestId("run-title").textContent).toBe("ship M4");
    // The labels are the facts row's own vocabulary, printed uppercase. The
    // Repository fact is absent here because this project's data cannot name
    // the one repository the run ran in — the fact is left out, not guessed.
    expect(Array.from(facts.querySelectorAll("dt")).map((label) => label.textContent)).toEqual([
      "Workflow",
      "Started",
      "Pinned digest",
    ]);
    expect(screen.queryByTestId("run-fact-repository")).toBeNull();
    // The age rides an "ago": a bare "14s by the system" reads as a
    // truncation; the fact is "14s ago by the system" (and the no-timestamp
    // case stays the whole word "unknown", no "ago").
    expect(screen.getByTestId("run-fact-started").textContent).toMatch(
      /^Started(\S+ ago|unknown)$/,
    );
    // § 7.2 W4: the page names the pin with its number AND the pinned digest —
    // the number on the Workflow fact, the full 12 hex chars `shortDigest`
    // prints everywhere else in the app (the runs list, the newer-revision
    // notice, the diagnostics pin) on its own fact. Six chars printed without
    // an ellipsis is a truncated fact wearing a whole one: the reader cannot
    // compare it against the library's digests, which is the point of 12 case
    // 11 made visible.
    const pin = screen.getByTestId("run-pinned-revision");
    // The digest is on the run row and paints with the header; the NUMBER rides the
    // separate revision read, so the pin line is awaited rather than asserted blind.
    await waitFor(() => expect(pin.textContent).toBe("rev 7"));
    expect(screen.getByTestId("run-fact-digest").textContent).toBe("Pinned digest3f2f3f2f3f2f");
    // No actor frame in the journal buffer yet — the "by" half is absent,
    // not invented. The header keeps no worker name anywhere (ADR-0016 § 8).
    expect(facts.textContent).not.toContain(" by ");
    expect(facts.textContent).not.toContain("worker");
  });

  it("wraps the H1 at EVERY width — the run title is never the thing that gives way (pass-1 390 + acceptance 46 1280)", async () => {
    // At 390 the one-line `truncate` cut “emu gate journey
    // pass-1-20261101113830” to one ellipsised line — the meaningful half of
    // the run's own title was lost on the phone. 89d81ad's `lg:truncate`
    // brought that cut back at desktop and acceptance 46
    // (run-gate-waiting 1280x900) failed on it: the e2e check
    // `scrollWidth - clientWidth <= 0` on `run-title` IS the contract — the
    // run's own title never gives way at ANY width. jsdom performs no
    // layout, so the classes are the jsdom-visible half of it: wrap-anywhere
    // (overflow-wrap:anywhere) at every breakpoint, and NOT ONE truncate or
    // whitespace-nowrap token at any prefix. The FULL title still rides
    // `title`. The revision chip beside it is untouched — the pinned digest
    // stays visible text (§ 7.2 W4, asserted by the meta-line test above).
    mount();
    const title = await screen.findByTestId("run-title");
    const tokens = title.className.split(/\s+/);
    expect(tokens).toContain("wrap-anywhere");
    expect(tokens).toContain("min-w-0");
    expect(title.className).not.toMatch(/truncate|nowrap/); // no ellipsis shape at any breakpoint
    expect(title.getAttribute("title")).toBe(`ship M4 · run ${shortId(WIRE_RUN_ID)}`);
  });

  it("still prints the pinned digest when the revision read cannot name its number", async () => {
    // The run row always carries the pinned digest; the NUMBER arrives with the
    // separate revision read. When that read fails the honest header prints the
    // digest fact alone and drops the `rev` link — never a guessed `r1`.
    mount("", [{ path: `/api/v1/revisions/${WIRE_REVISION_ID}`, status: 500, body: {} }]);

    const digest = await screen.findByTestId("run-fact-digest");
    expect(digest.textContent).toBe("Pinned digest3f2f3f2f3f2f");
    await waitFor(() => expect(screen.queryByTestId("run-pinned-revision")).toBeNull());
  });

  it("adds the started-by actor only when a run.created frame names it", async () => {
    mount();

    await screen.findByTestId("run-header-meta");
    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "run.created",
          {},
          { actor: { kind: "human", id: meFixture.id }, global_seq: 9901 },
        ),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("run-header-meta").textContent).toContain(
        `by ${meFixture.display_name}`,
      ),
    );
  });

  it("renames the draft verb to Fix the workflow… and keeps its testid", async () => {
    mount("", [{ path: "/api/v1/me", body: { ...meFixture, is_org_admin: true } }]);

    // Finding 11: the draft verb is not a header button any more — the header
    // holds ONE primary action and the `⋯` menu holds every other one.
    fireEvent.click(await screen.findByTestId("run-more-actions"));
    const button = await screen.findByTestId("run-new-draft");
    expect(button.textContent).toBe("Fix the workflow…");
  });
});

/* ---------------- the header's width is never a property of its own content */

/**
 * The width contract, read off the structure (jsdom performs no layout, so the
 * classes *are* the layout here). The title column used to be `flex-1`, whose
 * zero flex-basis makes its width whatever the actions column leaves: a
 * completed run at 1280 whose `Retry` reason sentence is showing measures 930px
 * of actions out of 1008px, which squeezed the breadcrumb, the title and the
 * whole meta line into a 66px column. Finding 11 stacked the header into three
 * rows; the rule that fixed the squeeze rides on inside row 2: the title column
 * keeps a 20rem basis floor, its row wraps at the right edge, and the facts row
 * is a block of the full width, so no fact's width is ever a button's slack.
 */
function headerWidthContract() {
  const facts = screen.getByTestId("run-header-meta");
  const header = facts.parentElement as HTMLElement;
  const row = header.children[1] as HTMLElement;
  const column = screen.getByTestId("run-header-title");
  const actions = screen.getByTestId("run-header-actions");
  // The floor, not the zero basis that made the meta's width the buttons' slack.
  expect(column.className).not.toContain("flex-1");
  expect(column.className).toContain("basis-[20rem]");
  expect(column.className).toContain("grow");
  expect(column.className).toContain("min-w-0");
  // The action column leaves the line when it cannot fit beside the floor,
  // and lands against the right edge of its own line where it already sat.
  expect(row.className).toContain("flex-wrap");
  expect(row.className).toContain("justify-end");
  expect(actions.className).not.toContain("flex-1");
  // The facts row spans the header's whole width, under a hairline.
  expect(facts.tagName).toBe("DL");
  expect(facts.className).toContain("flex-wrap");
  expect(facts.className).toContain("border-t");
  return { facts, column, row, actions };
}

describe("the run header's width", () => {
  it("puts the title on a flex-basis floor so a wide action column wraps below it", async () => {
    mount();
    await screen.findByTestId("run-header-meta");
    headerWidthContract();
  });

  it("keeps that floor for a run whose goal is empty — the title's length is not the layout", async () => {
    // A run the API serves with no `goal` input at all: the case that read as a
    // ~66px meta column at 1280.
    mount("", [{ path: RUN_PATH, body: { ...wireRun, inputs: [] } }]);

    await screen.findByTestId("run-header-meta");
    headerWidthContract();
    // The workflow name and the pin are the facts row's, not the title's: an
    // unnamed run loses nothing but the sentence nobody wrote, and the handle
    // the fallback title carries stays out of the facts.
    expect(screen.getByTestId("run-header-meta").textContent).toContain("feature-development");
    expect(screen.getByTestId("run-header-meta").textContent).not.toContain("#");
    expect(screen.getByTestId("run-title").textContent).toContain(`Run #`);
  });

  it("titles an empty-goal run with the title the server serves", async () => {
    mount("", [
      { path: RUN_PATH, body: { ...wireRun, inputs: [], title: "Add saved cards to checkout" } },
    ]);

    const title = await screen.findByTestId("run-title");
    expect(title.textContent).toBe("Add saved cards to checkout");
    headerWidthContract();
  });

  it("titles a run nobody ever named `Run #<short id>` — the inspector's own words", async () => {
    mount("", [{ path: RUN_PATH, body: { ...wireRun, inputs: [], title: null } }]);

    const title = await screen.findByTestId("run-title");
    expect(title.textContent).toBe(`Run #${shortId(WIRE_RUN_ID)}`);
    // No worker, no invention: the fallback is the run's own id and nothing else.
    expect(title.textContent).not.toContain("undefined");
    headerWidthContract();
  });
});

describe("the run header follows the stream", () => {
  it("reads running after the gate is decided — the advancer's run.resumed names the cleared gate park", async () => {
    mount("", [
      {
        path: RUN_PATH,
        body: { ...wireRun, status: "waiting_human", paused_reason: null },
      },
      { path: `${RUN_PATH}/nodes`, body: { node_executions: wireWaitingNodes } },
    ]);

    const chip = await screen.findByTestId("run-header-status");
    // `waiting_human` is the wire's token; the header says the app's word for
    // that state — the same one the Runs tab, the strip and the graph boxes use.
    expect(chip.textContent).toContain("need you");

    // The real journal tail for an approved gate (`01` row 5 + the decide
    // commit): the decision row, then the advancer's move
    // `waiting_human → running` with its own `run.resumed` naming the park it
    // cleared. The chip must leave the gate for `running` — never `queued`.
    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent(
          "approval.decided",
          { approval_id: wireApproval.id, decision: "approved", version: 2 },
          { node_execution_id: WIRE_NODE_APPROVE, global_seq: 9301 },
        ),
      );
      FakeEventSource.last().emit(
        wireRunEvent("run.resumed", { paused_reason: "waiting_human" }, { global_seq: 9302 }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("run-header-status").textContent).toContain("running"),
    );
    expect(screen.getByTestId("run-header-status").textContent).not.toContain("pending");
  });

  it("reads pending when a manual pause is cleared — the same frame type, the other park", async () => {
    mount("", [
      { path: RUN_PATH, body: { ...wireRun, status: "paused", paused_reason: "manual" } },
    ]);

    const chip = await screen.findByTestId("run-header-status");
    expect(chip.textContent).toContain("need you");

    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent("run.resumed", { paused_reason: "manual" }, { global_seq: 9401 }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("run-header-status").textContent).toContain("pending"),
    );
  });

  it("stays running when a refetched baseline outruns the takeover's stale resume frame", async () => {
    // The bug the fold used to draw (header-status2): the page opened during
    // iteration 1, the takeover paused the run and the return journaled
    // `run.resumed` (`paused → queued`); the run then leased and executed
    // again with no further `run.*` frame. The refetched baseline says
    // `running` — the replayed tail must not pin the header on `queued`.
    mount("", [{ path: RUN_PATH, body: { ...wireRun, status: "running", paused_reason: null } }]);

    const chip = await screen.findByTestId("run-header-status");
    expect(chip.textContent).toContain("running");

    act(() => {
      FakeEventSource.last().emit(
        wireRunEvent("run.paused", { paused_reason: "human_takeover" }, { global_seq: 9701 }),
      );
      FakeEventSource.last().emit(
        wireRunEvent("run.resumed", { paused_reason: "human_takeover" }, { global_seq: 9702 }),
      );
    });

    // The chip keeps the refetched baseline's status; the invalidation's
    // refetch (same `running` row) confirms it.
    await waitFor(() =>
      expect(screen.getByTestId("run-header-status").textContent).toContain("running"),
    );
    expect(screen.getByTestId("run-header-status").textContent).not.toContain("pending");
  });
});

/* ------------------------------- the attempt pane the § 7.2 W5 arm navigates */

describe("the dock draws the attempt the URL names", () => {
  /** Attempt 1 died mid-node; attempt 2 is the retry that answered it. */
  const died: Attempt = {
    ...wireAttempt,
    id: WIRE_ATTEMPT_1,
    attempt_number: 1,
    status: "interrupted",
    error_class: "interrupted",
    outputs: null,
    outputs_digest: null,
  };
  const retry: Attempt = {
    ...wireAttempt,
    id: "01987b25-0002-7000-8000-abcdef012345",
    attempt_number: 2,
    status: "succeeded",
    outputs: { summary: "Implemented the approved plan" },
    outputs_digest: `sha256:${"9c1f".repeat(16)}`,
  };
  const attemptsRoute = (): RouteStub => ({
    path: `${RUN_PATH}/nodes/${WIRE_NODE_IMPLEMENT}`,
    body: { ...wireNodeDetail, attempts: [died, retry], checkpoint: null },
  });

  it("opens the dead attempt by ?attempt= and says the worker disappeared mid-node", async () => {
    // § 7.2 W5: the exit arm reads the pane of the attempt the kill took, not the
    // retry that answered it. The dock draws ONE attempt at a time and leads with
    // the newest (ADR-0043 decision 5), so `?attempt=` is what makes the row's
    // sentence reachable — and the tab strip names each try's own state so the
    // death is never hidden while the newest attempt is on screen (`10` J7).
    mount(`?node=${WIRE_NODE_IMPLEMENT}&attempt=1`, [attemptsRoute()]);

    const note = await screen.findByTestId("attempt-interrupted-note");
    expect(note.textContent).toContain("interrupted — the worker disappeared mid-node");
    // The strip's words are the attempt chip's `SHORT_WORD` (`stopped`, `done`),
    // not the wire's `interrupted`/`succeeded` tokens.
    expect((await screen.findByTestId("dock-attempt-1")).textContent).toContain(
      "attempt 1 · stopped",
    );
    expect(screen.getByTestId("dock-attempt-2").textContent).toContain("attempt 2 · done");

    // Drop the param and the page leads with the retry: the sentence is gone from
    // the pane, which is exactly why the arm aims at the dead attempt — and why the
    // strip has to carry the word `stopped` regardless.
    cleanup();
    mount(`?node=${WIRE_NODE_IMPLEMENT}`, [attemptsRoute()]);
    expect((await screen.findByTestId("dock-attempt-2")).textContent).toContain("attempt 2 · done");
    expect(screen.queryByTestId("attempt-interrupted-note")).toBeNull();
  });

  it("answers the W5 arm's own link: ?tab=execution&node=<execution>&attempt=<the dead try>", async () => {
    // The leg still writes the pre-workbench link (the § 7.2 arm navigates it), so
    // the remap has to carry `attempt=` through the `?tab=execution` → tree rewrite
    // rather than reset it to the newest attempt.
    mount(`?tab=execution&node=${WIRE_NODE_IMPLEMENT}&attempt=1`, [attemptsRoute()]);

    expect((await screen.findByTestId("attempt-interrupted-note")).textContent).toContain(
      "interrupted — the worker disappeared mid-node",
    );
    expect((await screen.findByTestId("workbench-tab-tree")).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
