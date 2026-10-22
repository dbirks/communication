/**
 * Conversation page: shared live transcript, controller handoff, permission
 * prompts and cancel (`10-ui-design-handoff.md` J2/J6/J7). The API is mocked at
 * the fetch boundary and the SSE stream is a fake `EventSource` the test drives,
 * so every assertion below is about what a member actually sees.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../api/queries";
import { renderApp } from "../test/render";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  controlledByOther,
  meFixture,
  otherUserId,
  permissionRequestFixture,
  projectFixture,
  requestsTo,
  turnId,
  turnSandboxFixture,
  workerId,
  type RouteStub,
} from "../test/fakes";
import type { Conversation, TurnSandbox } from "../api/types";
import { shortId } from "../api/names";
import { DRAFT_PR_PROMPT } from "./Conversation";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;
const path = `/p/${projectFixture.id}/conversations/${conversationId}`;

function routes(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  // `extra` first so a stub there can shadow the defaults below.
  return [
    ...extra,
    me,
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: conversationPath, method: "GET", body: conversation },
  ];
}

const staleControlConflict = {
  type: "https://communication.dev/errors/control-version-stale",
  title: "Control version stale",
  status: 409,
  detail: "conversation_control.version is 9, not 1.",
  conversation_id: conversationId,
  control: {
    kind: "human" as const,
    user_id: "01987a63-3333-7000-8000-abcdef012345",
    display_name: "Grace Hopper",
    previous_user_id: otherUserId,
    version: 9,
  },
};

describe("/p/:projectId/conversations/:conversationId", () => {
  it("keeps the legacy /projects/:id/conversations/:id address alive as a redirect", async () => {
    // The pre-move address still renders the same surface: App.tsx turns it
    // into a replace-navigate to the canonical /p/:id/conversations/:id.
    renderApp({
      path: `/projects/${projectFixture.id}/conversations/${conversationId}`,
      routes: routes(conversationFixture),
    });
    await screen.findByTestId("conversation-title");
  });

  it("renders the transcript and merges streamed agent chunks into one message", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    const source = FakeEventSource.last();
    expect(source.url).toBe(`${conversationPath}/events`);

    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Fix the flaky spec",
        }),
      );
      source.emit(
        conversationEvent("conversation.message.agent", { chunk_seq: 1, text: "Reading " }),
      );
      source.emit(
        conversationEvent("conversation.message.agent", {
          chunk_seq: 2,
          text: "the test file.",
          final: true,
        }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the flaky spec");
    // One agent message, not one per chunk.
    expect(items[1].textContent).toContain("Reading the test file.");
    expect(within(transcript).queryByText("the test file.")).toBeNull();
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });

  it("updates a tool call in place as its status changes", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_01",
          title: "Edit internal/api/projects.go",
          kind: "edit",
          status: "in_progress",
          input_preview: "func list()",
        }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    expect(within(transcript).getAllByTestId("transcript-item")).toHaveLength(1);
    expect(screen.getByTestId("tool-status-toolu_01").textContent).toBe("status: in_progress");
    // 6d: a tool call is one row; its output is behind a click, not on screen.
    expect(within(transcript).queryByTestId("tool-preview-input")).toBeNull();
    fireEvent.click(screen.getByTestId("tool-row-toolu_01"));
    expect(within(transcript).getByTestId("tool-preview-input").textContent).toContain(
      "func list()",
    );

    act(() => {
      source.emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_01",
          status: "completed",
          output_preview: "written",
          update_seq: 1,
        }),
      );
    });

    // Same single row, now completed, and the output is on screen because the
    // row was expanded (a second click would show all of it).
    expect(within(transcript).getAllByTestId("transcript-item")).toHaveLength(1);
    expect(screen.getByTestId("tool-status-toolu_01").textContent).toBe("status: completed");
    expect(transcript.textContent).toContain("written");
    expect(screen.getByTestId("tool-row-toolu_01").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not duplicate items when a reconnect replays frames", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent(
          "conversation.message.user",
          { submitted_by: meFixture.id, text: "hello" },
          { global_seq: 10 },
        ),
      );
      source.emit(
        conversationEvent("conversation.message.agent", { text: "hi" }, { global_seq: 11 }),
      );
    });
    const transcript = await screen.findByTestId("transcript");
    expect(within(transcript).getAllByTestId("transcript-item")).toHaveLength(2);

    // The stream does not wait on EventSource's private retry: our own
    // reconnect re-opens the same scope carrying the cursor it last rendered
    // (`?after=11`), so a replayed 11 is ignored and 12 lands once.
    act(() => source.fail());
    expect(screen.getByTestId("stream-status").textContent).toBe("reconnecting");
    const reconnected = await waitFor(() => {
      const next = FakeEventSource.instances.at(-1)!;
      expect(next).not.toBe(source);
      return next;
    });
    expect(reconnected.url).toContain("?after=11");
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    act(() => {
      reconnected.emit(
        conversationEvent("conversation.message.agent", { text: "hi" }, { global_seq: 11 }),
      );
      reconnected.emit(
        conversationEvent(
          "conversation.message.agent",
          { text: " there", final: true },
          { global_seq: 12 },
        ),
      );
    });

    expect(within(transcript).getAllByTestId("transcript-item")).toHaveLength(2);
    expect(transcript.textContent).toContain("hi there");
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });

  it("shows a disabled composer and Take control for a member who is not the controller", async () => {
    const { queryClient } = renderApp({ path, routes: routes(controlledByOther) });
    await screen.findByTestId("conversation-title");

    expect(screen.getByTestId("controller-badge").textContent).toBe("Controlled by Dana Observer");
    expect(screen.getByTestId<HTMLTextAreaElement>("composer-input").disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "Only the controller (Dana Observer)",
    );
    // No stop button for somebody who does not hold the lock.
    expect(screen.queryByTestId("stop-turn")).toBeNull();
    expect(screen.getByTestId("take-control")).toBeTruthy();
    // ADR-0016 §9: the version the UI will echo is the one it read.
    expect(
      queryClient.getQueryData<Conversation>(queryKeys.conversation(conversationId))?.control
        .version,
    ).toBe(7);
  });

  it("takes control by echoing the version it read, and adopts a 409's control", async () => {
    const taken = {
      ...conversationFixture,
      control: {
        kind: "human" as const,
        user_id: meFixture.id,
        display_name: meFixture.display_name,
        previous_user_id: otherUserId,
        version: 8,
      },
    };
    const { requests } = renderApp({
      path,
      routes: routes(controlledByOther, [
        { path: `${conversationPath}/take-control`, method: "POST", status: 200, body: taken },
      ]),
    });

    fireEvent.click(await screen.findByTestId("take-control"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/take-control`, "POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({ version: 7 });
    });
    await waitFor(() =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("You are in control"),
    );

    // The composer becomes usable now that this browser holds the lock.
    expect(screen.getByTestId<HTMLTextAreaElement>("composer-input").disabled).toBe(false);
  });

  it("adopts the control row from a 409 instead of retrying the take", async () => {
    const { requests, queryClient } = renderApp({
      path,
      routes: routes(controlledByOther, [
        {
          path: `${conversationPath}/take-control`,
          method: "POST",
          status: 409,
          body: staleControlConflict,
        },
      ]),
    });

    fireEvent.click(await screen.findByTestId("take-control"));

    await waitFor(() =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("Controlled by Grace Hopper"),
    );
    expect(
      queryClient.getQueryData<Conversation>(queryKeys.conversation(conversationId))?.control
        .version,
    ).toBe(9);
    // Exactly one attempt: a loser adopts, it does not hammer the CAS.
    expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1);
    expect(screen.getByTestId("form-error").textContent).toContain("Control version stale");
  });

  it("returns control with the current version", async () => {
    const returned = {
      ...conversationFixture,
      control: {
        kind: "human" as const,
        user_id: otherUserId,
        display_name: "Dana Observer",
        previous_user_id: meFixture.id,
        version: 2,
      },
    };
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `${conversationPath}/return-control`,
          method: "POST",
          status: 200,
          body: returned,
        },
      ]),
    });

    fireEvent.click(await screen.findByTestId("return-control"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/return-control`, "POST");
      expect(JSON.parse(request.body ?? "{}")).toEqual({ version: 1 });
    });
    await waitFor(() =>
      expect(screen.getByTestId("controller-badge").textContent).toBe(
        "Controlled by Dana Observer",
      ),
    );
  });

  it("lets only the controller answer a permission prompt, and posts the chosen option", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `${conversationPath}/permissions/${permissionRequestFixture.id}`,
          method: "POST",
          status: 200,
          body: {
            ...permissionRequestFixture,
            status: "decided",
            decided_by: meFixture.id,
            decision_option_id: "allow_once",
          },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.permission.requested", {
          permission_request_id: permissionRequestFixture.id,
          title: permissionRequestFixture.tool_title,
          kind: permissionRequestFixture.tool_kind,
          tool_call_id: permissionRequestFixture.tool_call_id,
          options: permissionRequestFixture.options,
          deadline_at: "2026-10-14T18:12:00Z",
        }),
      );
    });

    const card = await screen.findByTestId("permission-card");
    expect(within(card).getByTestId("permission-allow")).toBeTruthy();
    expect(within(card).getByTestId("permission-reject")).toBeTruthy();

    fireEvent.click(within(card).getByTestId("permission-allow"));
    await waitFor(() => {
      const [request] = requestsTo(
        requests,
        `${conversationPath}/permissions/${permissionRequestFixture.id}`,
        "POST",
      );
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({ option_id: "allow_once" });
    });

    // The card closes when the durable decision event arrives, not on the POST.
    act(() => {
      source.emit(
        conversationEvent("conversation.permission.decided", {
          permission_request_id: permissionRequestFixture.id,
          status: "decided",
          decision_option_id: "allow_once",
          decided_by: meFixture.id,
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("permission-card").textContent).toContain(
        'answered "Allow once" by Ada Lovelace',
      ),
    );
    expect(
      within(screen.getByTestId("permission-card")).queryByTestId("permission-allow"),
    ).toBeNull();
  });

  it("shows a permission prompt read-only to a non-controller", async () => {
    const { requests } = renderApp({ path, routes: routes(controlledByOther) });
    await screen.findByTestId("conversation-title");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.permission.requested", {
          permission_request_id: permissionRequestFixture.id,
          title: "Write to internal/api/projects.go",
          kind: "edit",
          options: permissionRequestFixture.options,
        }),
      );
    });

    const card = await screen.findByTestId("permission-card");
    expect(within(card).queryByTestId("permission-allow")).toBeNull();
    expect(within(card).getByTestId("permission-readonly").textContent).toContain(
      "Only the controller (Dana Observer)",
    );
    expect(
      requestsTo(
        requests,
        `${conversationPath}/permissions/${permissionRequestFixture.id}`,
        "POST",
      ),
    ).toHaveLength(0);
  });

  it("stops the active turn for the controller", async () => {
    const withTurn: Conversation = {
      ...conversationFixture,
      active_turn: {
        id: turnId,
        conversation_id: conversationId,
        status: "running",
        submitted_by: meFixture.id,
        created_at: "2026-10-14T18:01:00Z",
      },
    };
    const { requests } = renderApp({
      path,
      routes: routes(withTurn, [
        {
          path: `${conversationPath}/cancel`,
          method: "POST",
          status: 202,
          body: { ...withTurn.active_turn, cancel_requested_at: "2026-10-14T18:02:00Z" },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    expect(screen.getByTestId("turn-status").textContent).toBe("running");
    // Never two prompts into one running turn (01 invariant, 06).
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain("already open");

    fireEvent.click(screen.getByTestId("stop-turn"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/cancel`, "POST");
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
    });
  });

  it("renders an interrupted turn honestly", async () => {
    const disconnected: Conversation = { ...conversationFixture, status: "disconnected" };
    renderApp({ path, routes: routes(disconnected) });
    await screen.findByTestId("conversation-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.turn.started", {
          worker_id: "01987a74-5555-7000-8000-abcdef012345",
          fencing_token: 41,
          session_origin: "new",
        }),
      );
      source.emit(conversationEvent("conversation.turn.interrupted", { reason: "lease_expired" }));
    });

    const notice = await screen.findByTestId("interrupted-notice");
    expect(notice.textContent).toContain("stopped — outcome unknown");
    expect(notice.textContent).toContain("you can send a new prompt");
    expect(notice.textContent?.toLowerCase()).not.toContain("resumed without loss");
    expect(screen.getByTestId("turn-status").textContent).toBe("stopped — outcome unknown");
    // The transcript says who lost the turn rather than pretending nothing happened.
    expect(screen.getByTestId("transcript").textContent).toContain(
      "Turn stopped — outcome unknown (the worker's lease expired)",
    );
  });

  it("queues a prompt for the controller and does not pretend to answer it", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `${conversationPath}/messages`,
          method: "POST",
          status: 202,
          body: {
            id: turnId,
            conversation_id: conversationId,
            status: "queued",
            submitted_by: meFixture.id,
            created_at: "2026-10-14T18:01:00Z",
          },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "Summarise the repo" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/messages`, "POST");
      expect(JSON.parse(request.body ?? "{}")).toEqual({ prompt: "Summarise the repo" });
    });
    // The prompt text lands in the transcript from the journal, not from the POST.
    expect(screen.getByTestId("transcript-empty")).toBeTruthy();
  });

  it("takes a terminal turn event as proof the queued turn is over", async () => {
    const withTurn: Conversation = {
      ...conversationFixture,
      active_turn: {
        id: turnId,
        conversation_id: conversationId,
        status: "running",
        submitted_by: meFixture.id,
        created_at: "2026-10-14T18:01:00Z",
      },
    };
    renderApp({ path, routes: routes(withTurn) });
    await screen.findByTestId("conversation-title");
    expect(screen.getByTestId("turn-status").textContent).toBe("running");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.completed", {
          worker_id: workerId,
          fencing_token: 42,
          stop_reason: "end_turn",
        }),
      );
    });

    // The turn row and its terminal event commit together, so the event is
    // proof the cached active turn has already moved on.
    await waitFor(() =>
      expect(screen.getByTestId("turn-status").textContent).toBe("completed (end_turn)"),
    );
    expect(screen.getByTestId("transcript").textContent).toContain("Turn completed (end_turn)");
  });

  it("explains that a viewer may only watch", async () => {
    renderApp({
      path,
      routes: routes(controlledByOther, [
        { path: projectPath, method: "GET", body: { ...projectFixture, my_role: "viewer" } },
      ]),
    });
    await screen.findByTestId("conversation-title");

    expect(screen.queryByTestId("take-control")).toBeNull();
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "watch this conversation",
    );
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
  });

  it("says the conversation was not found when the API answers 404", async () => {
    renderApp({
      path,
      routes: [
        me,
        { path: projectPath, method: "GET", body: projectFixture },
        {
          path: conversationPath,
          method: "GET",
          status: 404,
          body: {
            type: "https://communication.dev/errors/not-found",
            title: "Not found",
            status: 404,
            detail: "No such conversation.",
          },
        },
      ],
    });

    await screen.findByTestId("conversation-not-found");
  });
});

/* ------------------------------------------------- 6d layout: two columns */

const RUN_ID = "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c";
const NODE_EXECUTION_ID = "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d";
const ATTEMPT_ID = "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e";

describe("the thread page is a transcript column with a context rail", () => {
  it("puts the workspace and the sandbox in the rail, and the control line in the header", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    const main = await screen.findByTestId("conversation-main");
    const rail = screen.getByRole("complementary", { name: "Thread context" });
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Where is the context rail?",
        }),
      );
    });
    // The transcript and the composer are the reading surface; the context that
    // explains them is beside it, never below it.
    expect(await screen.findByTestId("transcript")).toBeTruthy();
    expect(within(main).getByTestId("transcript")).toBeTruthy();
    expect(within(main).getByTestId("composer-input")).toBeTruthy();
    expect(within(rail).getByTestId("workspace-widget")).toBeTruthy();
    expect(within(rail).getByTestId("sandbox-verdict")).toBeTruthy();
    // 4f: the controller pill and the control acts sit with the title.
    expect(within(main).getByTestId("controller-badge")).toBeTruthy();
    expect(within(main).queryByTestId("take-control")).toBeNull(); // you already hold control
    expect(within(main).getByTestId("return-control")).toBeTruthy();
    expect(within(rail).queryByTestId("controller-badge")).toBeNull();
    // 4f: the meta line reads `thread · <project> · <profile> · <age>`.
    const meta = screen.getByTestId("conversation-meta");
    expect(meta.textContent).toContain("thread");
    expect(meta.textContent).toContain(projectFixture.name);
    expect(meta.textContent).toContain(claudeProfile.name);
    expect(screen.getByTestId("thread-age").textContent).toMatch(/\d+[smhd]/);
    // 4f: ARTIFACTS says not available yet; NEXT offers the handoff (now live)
    // and, for the controller, the draft-PR ask. The thread has no runs yet,
    // so the linked-runs list stays hidden.
    expect(within(rail).getByTestId("artifacts-rail").textContent).toContain("Not available yet");
    const handoff = within(rail).getByTestId("hand-to-workflow");
    expect((handoff as HTMLButtonElement).disabled).toBe(false);
    expect(within(rail).queryByTestId("thread-linked-runs")).toBeNull();
    expect(within(rail).getByTestId("thread-draft-pr-open").textContent).toContain(
      "Open a draft PR from this branch",
    );
  });

  it("names the run the transcript belongs to from the ids the journal carried", async () => {
    const factoryRun: Conversation = {
      ...conversationFixture,
      origin: "run",
      control: { kind: "run_attempt", version: 3 },
    };
    renderApp({ path, routes: routes(factoryRun) });
    await screen.findByTestId("conversation-title");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent(
          "conversation.turn.started",
          { worker_id: workerId, fencing_token: 41, session_origin: "new" },
          { run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID, attempt_id: ATTEMPT_ID },
        ),
      );
    });

    const link = await screen.findByTestId("part-of-run-link");
    expect(link.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    expect(screen.getByTestId("part-of-node").textContent).toContain("node execution");
    expect(screen.getByTestId("controller-badge").textContent).toContain("pipeline run");
  });

  it("offers no run link when nothing in the journal names a run", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.started", { session_origin: "new" }),
      );
    });
    await screen.findByTestId("transcript");
    expect(screen.queryByTestId("part-of-run-link")).toBeNull();
  });

  it("renders an agent message as a speaker block and cycles the tool output open", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent(
          "conversation.message.agent",
          { text: "Reading the tests.", final: true },
          { occurred_at: "2026-10-14T18:03:07Z" },
        ),
      );
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_big",
          title: "go test ./...",
          kind: "execute",
          status: "in_progress",
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_big",
          status: "in_progress",
          output_preview: "line one\nline two\nline three\nline four\nline five",
        }),
      );
    });

    const speaker = await screen.findByTestId("agent-speaker");
    expect(speaker.textContent).toBe("Claude Code · 18:03:07 UTC");

    const row = screen.getByTestId("tool-row-toolu_big");
    expect(within(row).getByText("go test ./...")).toBeTruthy();
    // Row one: collapsed. Row two: the head of the output. Row three: all of it.
    fireEvent.click(row);
    expect(screen.getByTestId("tool-preview-output").textContent).toBe(
      "line one\nline two\nline three",
    );
    fireEvent.click(screen.getByTestId("tool-show-all-toolu_big"));
    expect(screen.getByTestId("tool-preview-output").textContent).toContain("line five");
    expect(within(row).getByText("status: in_progress")).toBeTruthy();
  });

  it("ellipsizes a long tool title and keeps the full text in the title", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");

    const longTitle = "bash: npm run build -- --minify --source-map --target es2022";
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_long",
          title: longTitle,
          kind: "execute",
          status: "in_progress",
        }),
      );
    });

    const row = screen.getByTestId("tool-row-toolu_long");
    const title = within(row).getByText(longTitle);
    // Long tool text is one line: ellipsized in the row, full text in the title.
    expect(title.getAttribute("title")).toBe(longTitle);
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    // The chevron + timing row keeps its own slot instead of pushing content out.
    const timing = screen.getByTestId("tool-timing-toolu_long");
    expect(timing.className).toContain("w-[72px]");
    expect(timing.className).toContain("shrink");
  });
});

/** Turn a factory attempt's ids onto the stream the way the worker stamps them. */
function emitAttemptTurn(): void {
  act(() => {
    FakeEventSource.last().emit(
      conversationEvent(
        "conversation.turn.started",
        { worker_id: workerId, fencing_token: 41, session_origin: "new" },
        { run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID, attempt_id: ATTEMPT_ID },
      ),
    );
  });
}

describe("the PART OF panel says which run this transcript belongs to", () => {
  it("renders the attempt's short id, with no expression left unrendered", async () => {
    const runControlled: Conversation = {
      ...conversationFixture,
      origin: "run",
      control: { kind: "run_attempt", version: 3 },
    };
    renderApp({ path, routes: routes(runControlled) });
    await screen.findByTestId("conversation-title");
    emitAttemptTurn();

    const node = await screen.findByTestId("part-of-node");
    // The bug this pins: `· attempt {shortId(runLink.attemptId)}` sat inside a
    // template literal, so the page printed the source code as a label.
    const panel = node.closest("section") ?? node;
    expect(panel.textContent).not.toContain("{");
    expect(panel.textContent).not.toContain("}");
    expect(node.textContent).toContain(`attempt ${shortId(ATTEMPT_ID)}`);
    // And the attempt is not a bare hex: it names the run it lives inside.
    const attempt = screen.getByTestId("part-of-attempt-link");
    expect(attempt.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    expect(screen.getByTestId("part-of-run-link").getAttribute("href")).toBe(`/runs/${RUN_ID}`);
  });

  it("says no verdict was recorded instead of asserting the run was unsandboxed", async () => {
    // What `GET /turns/{id}/sandbox` honestly answers for a turn whose journal
    // holds no sandbox event: stage `none`, verified false, nothing else. A
    // pipeline attempt writes `sandbox.verified` against its own attempt, with
    // no turn and no conversation on the row, so this conversation cannot reach
    // the enforcement it really ran under — and must not claim the opposite.
    const noRecord: TurnSandbox = {
      turn_id: turnId,
      workspace_id: null,
      worker_id: null,
      stage: "none",
      reason: null,
      policy_digest: null,
      backend: "none",
      backend_version: null,
      enforcement: null,
      verified: false,
      af_unix_mediation: null,
      network_enforced: false,
      child_started: false,
      grants: [],
      commit_granted: false,
      denied_what: [],
    };
    renderApp({
      path,
      routes: routes(conversationFixture, [
        { path: `/api/v1/turns/${turnId}/sandbox`, body: noRecord },
      ]),
    });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.started", { session_origin: "new" }),
      );
    });

    const verdict = await screen.findByText(/No sandbox verdict recorded for this conversation/);
    expect(verdict.getAttribute("data-testid")).toBe("sandbox-verdict");
    // The old copy asserted a finding nobody recorded.
    expect(document.body.textContent).not.toContain("WITHOUT a verified sandbox");
    expect(document.body.textContent).not.toContain("treat this unit as unsandboxed");
  });

  it("still shows a recorded verdict in full", async () => {
    renderApp({
      path,
      routes: routes(conversationFixture, [
        { path: `/api/v1/turns/${turnId}/sandbox`, body: turnSandboxFixture },
      ]),
    });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.started", { session_origin: "new" }),
      );
    });

    await screen.findByTestId("sandbox-verdict-panel");
    expect(document.body.textContent).not.toContain("No sandbox verdict recorded");
  });
});

/* ADR-0043: where the conversation was opened — the run panel deep-links into
   the Run Workbench, and a manual conversation never carries a run link. */
describe("the page says where the conversation was opened", () => {
  it("links a run conversation into the workbench from the api's run_link", async () => {
    const runLinked: Conversation = {
      ...conversationFixture,
      origin: "run",
      run_link: {
        run_id: RUN_ID,
        run_title: "Ship the billing refactor",
        node_execution_id: NODE_EXECUTION_ID,
        node_instance_key: "/review",
        node_id: "review",
        attempt_id: ATTEMPT_ID,
        attempt_number: 2,
      },
    };
    renderApp({ path, routes: routes(runLinked) });
    const link = await screen.findByTestId("part-of-run-link");
    expect(link.getAttribute("href")).toBe(
      `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`,
    );
    expect(link.textContent).toContain("Ship the billing refactor");
    expect(screen.getByTestId("part-of-node").textContent).toContain("node review");
    expect(screen.getByTestId("part-of-node").textContent).toContain("attempt 2");
    expect(screen.queryByTestId("conversation-manual-label")).toBeNull();
  });

  it("uses the instance-key leaf and the run's short id when the api stored no names", async () => {
    const unlinked: Conversation = {
      ...conversationFixture,
      origin: "run",
      run_link: {
        run_id: RUN_ID,
        run_title: null,
        node_execution_id: NODE_EXECUTION_ID,
        node_instance_key: "/loop/body/scan",
        node_id: null,
        attempt_id: ATTEMPT_ID,
        attempt_number: 1,
      },
    };
    renderApp({ path, routes: routes(unlinked) });
    const link = await screen.findByTestId("part-of-run-link");
    // No definition node id was stored, so the workbench link omits `node`.
    expect(link.getAttribute("href")).toBe(
      `/runs/${RUN_ID}?instance=${NODE_EXECUTION_ID}&attempt=1`,
    );
    expect(link.textContent).toContain(shortId(RUN_ID));
    expect(screen.getByTestId("part-of-node").textContent).toContain("node scan");
  });

  it("labels a manual conversation and never offers a run link, even when the journal names one", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    expect(await screen.findByTestId("conversation-manual-label")).toBeTruthy();
    expect(screen.getByTestId("conversation-manual-label").textContent).toBe("One-off thread");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent(
          "conversation.turn.started",
          { worker_id: workerId, fencing_token: 41, session_origin: "new" },
          { run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID, attempt_id: ATTEMPT_ID },
        ),
      );
    });
    await screen.findByTestId("transcript");
    expect(screen.queryByTestId("part-of-run-link")).toBeNull();
  });
});

describe("an agent message that served a plan", () => {
  // The m4-planner's real final message, brace for brace.
  const planText = JSON.stringify({
    plan: {
      goal: "Document and fix add() in app/hello.py",
      steps: [
        { id: 1, file: "app/hello.py", action: "Add a docstring to add()" },
        { id: 2, file: "app/tests/test_hello.py", action: "Correct the failing assertion" },
      ],
      risks: ["If the contract requires the test file unchanged, steps 1-2 conflict."],
    },
  });

  async function agentSays(text: string) {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.agent", { text, final: true }),
      );
    });
    return screen.findByTestId("transcript");
  }

  it("renders it as a plan, with the raw text one click away", async () => {
    const transcript = await agentSays(planText);
    // PlanView's own surface, not the wall of escaped text (`live-conversation-3.png`).
    expect(within(transcript).getByTestId("plan-view")).toBeTruthy();
    expect(within(transcript).getByTestId("plan-goal").textContent).toContain(
      "Document and fix add()",
    );
    expect(within(transcript).getAllByTestId(/^plan-step-/).length).toBeGreaterThan(0);
    expect(transcript.textContent).not.toContain('{"plan":{"goal"');

    fireEvent.click(within(transcript).getByTestId("agent-plan-toggle"));
    expect(within(transcript).getByTestId("agent-plan-raw").textContent).toBe(planText);
    // Nothing is lost on the way back either.
    fireEvent.click(within(transcript).getByTestId("agent-plan-toggle"));
    expect(within(transcript).getByTestId("plan-view")).toBeTruthy();
  });

  it("leaves every other message as the text it is", async () => {
    const transcript = await agentSays("Reading the failing spec now.");
    expect(within(transcript).queryByTestId("plan-view")).toBeNull();
    expect(within(transcript).queryByTestId("agent-plan-toggle")).toBeNull();
    expect(transcript.textContent).toContain("Reading the failing spec now.");
  });

  it("waits for a plan that has not fully arrived", async () => {
    // A chunk of the same document mid-stream is not a plan, and rendering the
    // fragment as one would show a goal that was never served.
    const transcript = await agentSays(planText.slice(0, 40));
    expect(within(transcript).queryByTestId("plan-view")).toBeNull();
    expect(transcript.textContent).toContain('{"plan":{"goal":');
  });

  it("reads a plan served without the envelope too", async () => {
    const bare = JSON.stringify({
      goal: "Split the billing job",
      steps: [{ id: 1, title: "Cut the cron entry", actions: ["remove the schedule"] }],
    });
    const transcript = await agentSays(bare);
    expect(within(transcript).getByTestId("plan-goal").textContent).toBe("Split the billing job");
    expect(within(transcript).getByTestId("agent-plan-toggle")).toBeTruthy();
  });
});

describe("the NEXT rail: hand to a workflow, linked runs and the draft-PR ask", () => {
  const linkedRunId = "01987a81-1111-7000-8000-abcdef012345";

  it("lists the linked runs with their status, age and the workbench link", async () => {
    const handed: Conversation = {
      ...conversationFixture,
      linked_runs: [
        { run_id: linkedRunId, created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
      ],
    };
    renderApp({
      path,
      routes: routes(handed, [
        // The list row carries no status; the row reads it from the run detail.
        { path: `/api/v1/runs/${linkedRunId}`, method: "GET", body: { status: "queued" } },
      ]),
    });
    const rail = await screen.findByRole("complementary", { name: "Thread context" });
    const list = await within(rail).findByTestId("thread-linked-runs");
    expect(within(list).getByTestId("thread-linked-run-status-0").textContent).toContain("queued");
    // The age is answered from the recorded handoff moment (30 minutes back).
    expect(list.textContent).toContain("30m");
    const link = within(list).getByTestId("thread-linked-run-link-0");
    expect(link.textContent).toContain(`run ${shortId(linkedRunId)}`);
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(`/runs/${linkedRunId}`);
  });

  it("hides the linked-runs list while the thread has not started any run", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    const rail = await screen.findByRole("complementary", { name: "Thread context" });
    expect(within(rail).queryByTestId("thread-linked-runs")).toBeNull();
  });

  it("opens the handoff dialog, links a started run and refetches the thread", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `/api/v1/projects/${projectFixture.id}/assignments`,
          method: "GET",
          body: {
            assignments: [
              {
                id: "01987a82-2222-7000-8000-abcdef012345",
                project_id: projectFixture.id,
                pipeline_id: "01987a83-3333-7000-8000-abcdef012345",
                pinned_revision_id: "01987a84-4444-7000-8000-abcdef012345",
                pinned_revision_digest: "abc1234def56789012345678",
                pinned_version_label: "stable r4",
                max_concurrent_runs: 1,
                budget_overrides: {},
                effective_budgets: {},
                enabled: true,
                version: 1,
                created_at: "2026-10-14T17:00:00Z",
                updated_at: "2026-10-14T17:00:00Z",
              },
            ],
          },
        },
        {
          path: "/api/v1/pipelines",
          method: "GET",
          body: {
            pipelines: [
              {
                id: "01987a83-3333-7000-8000-abcdef012345",
                slug: "bug-fix",
              },
            ],
          },
        },
        // The pinned revision declares a REQUIRED `goal` input: the dialog
        // renders it as a form field and gates Start until it is filled.
        {
          path: `/api/v1/revisions/01987a84-4444-7000-8000-abcdef012345`,
          method: "GET",
          body: {
            id: "01987a84-4444-7000-8000-abcdef012345",
            canonical_document: {
              spec: {
                inputs: {
                  type: "object",
                  properties: {
                    goal: { type: "string", description: "What should the run do?" },
                  },
                  required: ["goal"],
                },
              },
            },
          },
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/workspaces`,
          method: "GET",
          body: { workspaces: [] },
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/artifacts`,
          method: "GET",
          body: { artifacts: [] },
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/runs`,
          method: "POST",
          status: 201,
          body: { run_id: linkedRunId, status: "queued" },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    fireEvent.click(screen.getByTestId("hand-to-workflow"));
    const dialog = await screen.findByTestId("handoff-dialog");
    // Wait for the workflow options to load; the summary starts empty
    // because this thread has no agent message yet.
    await within(dialog).findByTestId("handoff-workflow-select");
    // The pinned revision's REQUIRED `goal` input is empty, so the submit
    // stays gated until it is filled.
    const goal = await within(dialog).findByTestId("new-run-input-goal");
    expect(within(dialog).getByTestId("handoff-submit").hasAttribute("disabled")).toBe(true);
    fireEvent.change(goal, { target: { value: "Trace the slow query" } });
    const submit = within(dialog).getByTestId("handoff-submit");
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    // The dialog itself reports the start…
    expect(await within(dialog).findByTestId("handoff-started")).toBeTruthy();
    // …and the rail links the run with its short id.
    const started = screen.getByTestId("thread-handoff-started");
    expect(started.textContent).toContain(`Run #${shortId(linkedRunId)} started`);
    expect((started as HTMLAnchorElement).getAttribute("href")).toBe(`/runs/${linkedRunId}`);

    // The handoff body rides the API's own source contract (ADR-0053)…
    await waitFor(() => {
      const [create] = requestsTo(requests, `/api/v1/projects/${projectFixture.id}/runs`, "POST");
      const body = JSON.parse(create.body ?? "{}");
      expect(body.source.conversation_id).toBe(conversationId);
    });
    // …and the thread refetches itself: its linked_runs are the rail's list.
    await waitFor(() => {
      expect(requestsTo(requests, conversationPath, "GET").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("sends the exact draft-PR prompt through the message path when the controller confirms", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `${conversationPath}/messages`,
          method: "POST",
          status: 202,
          body: {
            id: turnId,
            conversation_id: conversationId,
            status: "queued",
            submitted_by: meFixture.id,
            created_at: "2026-10-14T18:01:00Z",
          },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    fireEvent.click(screen.getByTestId("thread-draft-pr-open"));
    const confirm = await screen.findByTestId("thread-draft-pr-confirm");
    expect(confirm.textContent).toContain("GitHub token on its profile (ADR-0045)");
    expect(confirm.textContent).toContain("the worker's egress allows github.com");
    fireEvent.click(within(confirm).getByTestId("thread-draft-pr-send"));

    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/messages`, "POST");
      expect(JSON.parse(request.body ?? "{}")).toEqual({ prompt: DRAFT_PR_PROMPT });
    });
    // The confirmation closes and the honest note: a PR exists only if the
    // transcript shows its URL.
    expect(screen.queryByTestId("thread-draft-pr-confirm")).toBeNull();
    expect(screen.getByTestId("thread-draft-pr-sent").textContent).toContain(
      "the agent's reply appears in the transcript",
    );
  });

  it("cancels the draft-PR confirmation without sending anything", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(conversationFixture, [
        {
          path: `${conversationPath}/messages`,
          method: "POST",
          status: 202,
          body: {
            id: turnId,
            conversation_id: conversationId,
            status: "queued",
            submitted_by: meFixture.id,
            created_at: "2026-10-14T18:01:00Z",
          },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");

    fireEvent.click(screen.getByTestId("thread-draft-pr-open"));
    const confirm = await screen.findByTestId("thread-draft-pr-confirm");
    fireEvent.click(within(confirm).getByTestId("thread-draft-pr-cancel"));
    expect(screen.queryByTestId("thread-draft-pr-confirm")).toBeNull();
    expect(requestsTo(requests, `${conversationPath}/messages`, "POST")).toEqual([]);
  });

  it("shows the draft-PR reason instead of the button to a non-controller", async () => {
    renderApp({ path, routes: routes(controlledByOther) });
    await screen.findByTestId("conversation-title");

    expect(screen.queryByTestId("thread-draft-pr-open")).toBeNull();
    expect(screen.getByTestId("thread-draft-pr").textContent).toContain(
      "Take control to ask the agent",
    );
  });
});
