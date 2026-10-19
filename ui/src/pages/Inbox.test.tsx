/**
 * The inbox as a real route: per-project approvals and runs read through the
 * same hooks the rest of the app uses, sections grouped by what they ask of
 * you, decisions and retries acted on inline. The fixture wires are the frozen
 * M4 ones — nothing here invents a field the API does not carry.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  permissionRequestFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { testidOf } from "../lib/format";
import { INBOX_POLL_MS } from "./Inbox";

const PROJECTS_PATH = "/api/v1/projects";
const APPROVALS_PATH = `/api/v1/projects/${wireProjectId}/approvals`;
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const CONVERSATIONS_PATH = `/api/v1/projects/${wireProjectId}/conversations`;
const CONVERSATION_PATH = `/api/v1/conversations/${conversationId}`;
const DECIDE_PATH = `/api/v1/approvals/${WIRE_APPROVAL_ID}/decide`;
const RETRY_PATH = `/api/v1/runs/${WIRE_RUN_ID}/retry`;

/** A second conversation, distinguishable by `testidOf` (first 13 hex). */
const otherConversationId = "01987a70-3333-7000-8000-abcdef012345";

const failedRun = {
  ...wireRun,
  status: "failed",
  failed_cause: "node_execution_failed:/implement",
} as unknown as typeof wireRun;

function routes(
  approvals: unknown,
  runs: unknown,
  extra: RouteStub[] = [],
  conversations: unknown = { items: [] },
): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: PROJECTS_PATH, method: "GET", body: { items: [projectFixture] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: APPROVALS_PATH, body: approvals },
    { path: RUNS_PATH, body: runs },
    { path: CONVERSATIONS_PATH, body: conversations },
  ];
}

function mountInbox(
  approvals: unknown = wireApprovalList,
  runs: unknown = wireRunList,
  extra: RouteStub[] = [],
  conversations: unknown = { items: [] },
) {
  return renderApp({
    path: "/inbox",
    routes: routes(approvals, runs, extra, conversations),
  });
}

describe("/inbox", () => {
  it("greets the signed-in user and states the cross-project tally", async () => {
    mountInbox({ approvals: [] }, { runs: [] });
    expect((await screen.findByTestId("inbox-greeting")).textContent).toContain("Ada");
    expect((await screen.findByTestId("inbox-summary")).textContent).toBe(
      "Across 1 project: 0 decisions, 0 stalled runs, 0 conversations. 0 runs are going fine.",
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

  it("drops the plan JSON a gate's summary carries from its row", async () => {
    const planGate = {
      ...wireApproval,
      summary:
        'Plan for Document and fix add() in hello.py\n{"acceptance":["pytest passes in app/ with both tests green"],"goal":"Document and fix add() in app/hello.py","steps":[{"action":"Add a docstring to add().","file":"app/hello.py","id":1}]}',
    } as unknown as typeof wireApproval;
    mountInbox({ approvals: [planGate] }, { runs: [] });

    const row = await screen.findByTestId(`inbox-decision-${testidOf(WIRE_APPROVAL_ID)}`);
    expect(row.textContent).toContain("Plan for Document and fix add() in hello.py");
    expect(row.textContent).not.toContain('"acceptance"');
    // Two lines on screen, the whole summary behind the tooltip.
    const title = screen.getByTestId(`inbox-decision-title-${testidOf(WIRE_APPROVAL_ID)}`);
    expect(title.className).toContain("line-clamp-2");
    expect(title.getAttribute("title")).toBe(planGate.summary);
    expect(title.textContent).toBe("Plan for Document and fix add() in hello.py");
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

  it("lists an active conversation with an Open link to its transcript", async () => {
    const { requests } = mountInbox({ approvals: [] }, { runs: [] }, [], {
      items: [conversationSummaryFixture],
    });

    const list = await screen.findByTestId("inbox-conversations");
    const row = await within(list).findByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    // The title is the wire's `title`; the profile id is not shown because the
    // list row has no name for it here.
    expect(row.textContent).toContain("Refactor billing");
    // STATUS-E: the state rides a glyph+word chip ("● active"; the word is the
    // DOM text, CSS uppercases it visually only).
    expect(row.textContent).toContain("●active");
    expect(
      within(row).getByTestId(`inbox-conversation-tag-${testidOf(conversationId)}`).textContent,
    ).toContain("active");
    expect(
      within(row).getByTestId(`inbox-open-conversation-${testidOf(conversationId)}`).textContent,
    ).toContain("Open conversation");
    expect(
      within(row)
        .getByTestId(`inbox-open-conversation-${testidOf(conversationId)}`)
        .getAttribute("href"),
    ).toBe(`/projects/${wireProjectId}/conversations/${conversationId}`);
    expect((await screen.findByTestId("inbox-summary")).textContent).toContain("1 conversation");
    // No turn is open on the list row, so nothing asks a prompt: the detail
    // route is not read for a row the list already answers.
    expect(requestsTo(requests, CONVERSATION_PATH, "GET")).toHaveLength(0);
  });

  it("tags a conversation whose detail reports a pending permission request", async () => {
    const { requests } = mountInbox(
      { approvals: [] },
      { runs: [] },
      [
        {
          path: CONVERSATION_PATH,
          body: { ...conversationFixture, pending_permissions: [permissionRequestFixture] },
        },
      ],
      { items: [{ ...conversationSummaryFixture, has_active_turn: true }] },
    );

    await waitFor(() => expect(requestsTo(requests, CONVERSATION_PATH, "GET")).toHaveLength(1));
    const row = await screen.findByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    expect(
      within(row).getByTestId(`inbox-conversation-tag-${testidOf(conversationId)}`).textContent,
    ).toContain("permission");
    expect(
      within(row).getByTestId(`inbox-open-conversation-${testidOf(conversationId)}`).textContent,
    ).toContain("Open");
  });

  it("leaves a finished and a dormant conversation out of the section", async () => {
    const archived = { ...conversationSummaryFixture, status: "archived" };
    const idle = { ...conversationSummaryFixture, id: otherConversationId, status: "idle" };
    mountInbox({ approvals: [] }, { runs: [] }, [], {
      items: [conversationSummaryFixture, archived, idle],
    });

    const list = await screen.findByTestId("inbox-conversations");
    expect(within(list).getAllByTestId(/^inbox-open-conversation-/)).toHaveLength(1);
    expect(screen.queryByTestId(`inbox-conversation-${testidOf(otherConversationId)}`)).toBeNull();
    expect((await screen.findByTestId("inbox-summary")).textContent).toContain("1 conversation");
  });

  it("badges where a conversation was opened and deep-links a run one into the workbench", async () => {
    const runLinked = {
      ...conversationSummaryFixture,
      origin: "run" as const,
      run_link: {
        run_id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
        run_title: "Ship billing",
        node_execution_id: "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d",
        node_instance_key: "/review",
        node_id: "review",
        attempt_id: "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e",
        attempt_number: 2,
      },
    };
    mountInbox({ approvals: [] }, { runs: [] }, [], { items: [runLinked] });

    const row = await screen.findByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    const badge = within(row).getByTestId("conversation-origin-run");
    expect(badge.textContent).toContain("From run · Ship billing · review");
    expect(badge.getAttribute("href")).toBe(
      `/projects/${wireProjectId}/runs/01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c?node=review&instance=01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d&attempt=2`,
    );
  });

  it("labels a manual conversation in the row and never deep-links it", async () => {
    mountInbox({ approvals: [] }, { runs: [] }, [], {
      items: [conversationSummaryFixture],
    });

    const row = await screen.findByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    const badge = within(row).getByTestId("conversation-origin-manual");
    expect(badge.textContent).toBe("Manual");
    expect(badge.getAttribute("href")).toBeNull();
    expect(within(row).queryByTestId("conversation-origin-run")).toBeNull();
  });

  it("says so when nothing needs you", async () => {
    mountInbox({ approvals: [] }, { runs: [] });
    expect((await screen.findByTestId("inbox-empty")).textContent).toContain("Nothing needs you.");
    expect(screen.queryByTestId("inbox-decisions")).toBeNull();
  });
});

/**
 * The Inbox is left open, so a gate or a prompt that turns pending afterwards
 * has to arrive on the page's own timer rather than by reload. Each test mounts
 * under fake timers, lets the first fetch land, then changes what the server
 * answers and advances one `INBOX_POLL_MS` tick — and checks the node it drew
 * first is still the node on screen, i.e. the page refreshed in place.
 */
describe("/inbox live refresh", () => {
  afterEach(() => vi.useRealTimers());

  /** Let the mount's fetches settle while every clock is fake: each tick is a
   * fraction of `INBOX_POLL_MS`, so no interval has fired by the end. */
  async function settle() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
  }

  it("draws a gate that turns pending while the page sits open", async () => {
    vi.useFakeTimers();
    const { requests } = mountInbox({ approvals: [] }, { runs: [] });
    await settle();

    // First paint: the wire asked for nothing, and the gates were read once.
    expect(screen.getByTestId("inbox-empty").textContent).toContain("Nothing needs you.");
    expect(requestsTo(requests, APPROVALS_PATH, "GET")).toHaveLength(1);
    const greeting = screen.getByTestId("inbox-greeting");

    // A gate goes pending underneath the open page.
    const poll = mockFetch(routes(wireApprovalList, { runs: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    });

    const row = screen.getByTestId(`inbox-decision-${testidOf(WIRE_APPROVAL_ID)}`);
    expect(row.textContent).toContain("The plan is ready");
    expect(screen.getByTestId("inbox-summary").textContent).toContain("1 decision");
    // Proven by a re-read, not a remount: one fresh approvals request, and the
    // header element from the first paint is still the element on screen.
    expect(requestsTo(poll.requests, APPROVALS_PATH, "GET")).toHaveLength(1);
    expect(screen.getByTestId("inbox-greeting")).toBe(greeting);
  });

  it("tags a permission prompt that appears on the detail re-read", async () => {
    vi.useFakeTimers();
    const withTurn = [{ ...conversationSummaryFixture, has_active_turn: true }];
    const { requests } = mountInbox(
      { approvals: [] },
      { runs: [] },
      [{ path: CONVERSATION_PATH, body: { ...conversationFixture, pending_permissions: [] } }],
      { items: withTurn },
    );
    await settle();

    const testid = `inbox-conversation-tag-${testidOf(conversationId)}`;
    const row = screen.getByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    expect(within(row).getByTestId(testid).textContent).toContain("active");
    // The list row says a turn is open, so its detail is the one read that can
    // answer a prompt — and the only detail read in flight.
    expect(requestsTo(requests, CONVERSATION_PATH, "GET")).toHaveLength(1);

    // The agent asks for permission while the page is open.
    const poll = mockFetch(
      routes(
        { approvals: [] },
        { runs: [] },
        [
          {
            path: CONVERSATION_PATH,
            body: { ...conversationFixture, pending_permissions: [permissionRequestFixture] },
          },
        ],
        { items: withTurn },
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    });

    expect(requestsTo(poll.requests, CONVERSATION_PATH, "GET")).toHaveLength(1);
    const tagged = screen.getByTestId(`inbox-conversation-${testidOf(conversationId)}`);
    expect(within(tagged).getByTestId(testid).textContent).toContain("permission");
    // Same row element, re-labelled in place.
    expect(tagged).toBe(row);
  });
});
