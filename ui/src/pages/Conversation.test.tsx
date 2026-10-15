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
  workerId,
  type RouteStub,
} from "../test/fakes";
import type { Conversation } from "../api/types";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;
const path = `/projects/${projectFixture.id}/conversations/${conversationId}`;

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

describe("/projects/:projectId/conversations/:conversationId", () => {
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

    // Same single row, now completed.
    expect(within(transcript).getAllByTestId("transcript-item")).toHaveLength(1);
    expect(screen.getByTestId("tool-status-toolu_01").textContent).toBe("status: completed");
    expect(transcript.textContent).toContain("written");
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

    // EventSource replays from Last-Event-ID after a drop; the second delivery
    // of global_seq 11 must be ignored, and 12 must land once.
    act(() => source.fail());
    expect(screen.getByTestId("stream-status").textContent).toBe("reconnecting");
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { text: "hi" }, { global_seq: 11 }),
      );
      source.emit(
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
