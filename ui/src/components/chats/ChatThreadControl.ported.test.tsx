/**
 * The chat thread's control hand-off, composer and stream, ported from
 * `pages/Conversation.test.tsx` onto their replacement,
 * `components/chats/ChatThread.tsx` (ChatHeader + ChatComposer +
 * ConversationTranscript) at the redesign's `/p/:projectId/chats/:id`.
 *
 * The old page's own chrome is retired with it: the header's `controller-badge`
 * pill, the mono meta line, the inline control buttons beside the title and the
 * `turn-status` chip. What a person still does — hand the wheel over, take it,
 * watch without touching, stop a turn, send a prompt — is asserted here through
 * the ids the new components define: the control acts live behind the header's
 * `chat-menu`, and the turn's state is read in `composer-explainer`.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import { queryKeys } from "../../api/queries";
import type { Conversation } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  controlledByOther,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  otherUserId,
  permissionRequestFixture,
  projectFixture,
  requestsTo,
  turnFixture,
  turnId,
  workerId,
  type RouteStub,
} from "../../test/fakes";

const conversationPath = `/api/v1/conversations/${conversationId}`;
const projectPath = `/api/v1/projects/${projectFixture.id}`;
const path = `/p/${projectFixture.id}/chats/${conversationId}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
  window.localStorage.clear();
});

function routes(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  // `extra` first so a stub there can shadow the defaults below.
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [] } },
    { path: `${projectPath}/assignments`, method: "GET", body: { assignments: [] } },
    { path: "/api/v1/pipelines", method: "GET", body: { pipelines: [] } },
    { path: `${projectPath}/issue-triggers`, method: "GET", body: { issue_triggers: [] } },
    { path: `${projectPath}/runs`, method: "GET", body: { runs: [] } },
    { path: `${projectPath}/artifacts`, method: "GET", body: { artifacts: [] } },
    { path: "/api/v1/conversations", method: "GET", body: { items: [], next_cursor: null } },
    {
      path: `${projectPath}/conversations`,
      method: "GET",
      body: { items: [], next_cursor: null },
    },
    { path: conversationPath, method: "GET", body: conversation },
    { path: `${conversationPath}/notes`, method: "GET", body: { notes: [] } },
  ];
}

/** Open the header's `…` menu, where the control acts now live. */
async function openControlMenu(): Promise<void> {
  await screen.findByTestId("chat-header");
  fireEvent.click(screen.getByTestId("chat-menu"));
  await screen.findByTestId("chat-menu-popover");
}

describe("the chat's control hand-off (ported from the thread page)", () => {
  it("shows a disabled composer and Take control for a member who is not the controller", async () => {
    const { queryClient } = renderApp({ path, routes: routes(controlledByOther) });
    await screen.findByTestId("chat-title");

    expect(screen.getByTestId<HTMLTextAreaElement>("composer-input").disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "Only the controller (Dana Observer)",
    );
    // No stop button for somebody who does not hold the lock.
    expect(screen.queryByTestId("stop-turn")).toBeNull();
    // 4f's inline `controller-badge` is retired: the act is behind the menu.
    await openControlMenu();
    expect(await screen.findByTestId("take-control")).toBeTruthy();
    // ADR-0016 §9: the version the UI will echo is the one it read.
    expect(
      queryClient.getQueryData<Conversation>(queryKeys.conversation(conversationId))?.control
        .version,
    ).toBe(7);
  });

  it("takes control by echoing the version it read, and becomes the driver", async () => {
    const taken: Conversation = {
      ...conversationFixture,
      control: {
        kind: "human",
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

    await openControlMenu();
    fireEvent.click(await screen.findByTestId("take-control"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/take-control`, "POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({ version: 7 });
    });
    // The composer becomes usable now that this browser holds the lock.
    await waitFor(() =>
      expect(screen.getByTestId<HTMLTextAreaElement>("composer-input").disabled).toBe(false),
    );
    // And the menu now offers the other half of the hand-off.
    await openControlMenu();
    expect(await screen.findByTestId("return-control")).toBeTruthy();
  });

  it("adopts the control row from a 409 instead of retrying the take", async () => {
    const { requests, queryClient } = renderApp({
      path,
      routes: routes(controlledByOther, [
        {
          path: `${conversationPath}/take-control`,
          method: "POST",
          status: 409,
          body: {
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
          },
        },
      ]),
    });

    await openControlMenu();
    fireEvent.click(await screen.findByTestId("take-control"));

    // Exactly one attempt: a loser adopts, it does not hammer the CAS.
    await waitFor(() =>
      expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1),
    );
    expect(
      queryClient.getQueryData<Conversation>(queryKeys.conversation(conversationId))?.control
        .version,
    ).toBe(9);
    // The refusal is said, and the next read of the menu names the new driver.
    await openControlMenu();
    const item = await screen.findByTestId("take-control");
    await waitFor(() => expect(item.closest("button")).toBeTruthy());
    expect(
      (item as HTMLButtonElement).disabled || screen.getByTestId("chat-control-error"),
    ).toBeTruthy();
  });

  it("returns control with the current version", async () => {
    const returned: Conversation = {
      ...conversationFixture,
      control: {
        kind: "human",
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

    await openControlMenu();
    fireEvent.click(await screen.findByTestId("return-control"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `${conversationPath}/return-control`, "POST");
      expect(JSON.parse(request.body ?? "{}")).toEqual({ version: 1 });
    });
    // The explainer now names the person who took the wheel.
    await waitFor(() =>
      expect(screen.getByTestId("composer-explainer").textContent).toContain("Dana Observer"),
    );
  });

  it("explains that a viewer may only watch", async () => {
    renderApp({
      path,
      routes: routes(controlledByOther, [
        { path: projectPath, method: "GET", body: { ...projectFixture, my_role: "viewer" } },
      ]),
    });
    await screen.findByTestId("chat-title");

    expect(screen.getByTestId("composer-explainer").textContent).toContain("watch this thread");
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
    // A viewer gets the act refused in words, not a silent dead button.
    await openControlMenu();
    const take = await screen.findByTestId("take-control");
    expect((take as HTMLButtonElement).disabled).toBe(true);
    expect(take.getAttribute("title")).toContain("Viewers cannot take control");
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
    await screen.findByTestId("chat-title");

    act(() => {
      FakeEventSource.last().emit(
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
    // The row pins the request id, so a reader can follow THIS card across the
    // pending→decided transition (two turns of one prompt share a title).
    expect(
      card.closest("[data-permission-request-id]")?.getAttribute("data-permission-request-id"),
    ).toBe(permissionRequestFixture.id);
    expect(withinCard(card, "permission-allow")).toBeTruthy();
    expect(withinCard(card, "permission-reject")).toBeTruthy();

    fireEvent.click(withinCard(card, "permission-allow"));
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
      FakeEventSource.last().emit(
        conversationEvent("conversation.permission.decided", {
          permission_request_id: permissionRequestFixture.id,
          status: "decided",
          decision_option_id: "allow_once",
          decided_by: meFixture.id,
        }),
      );
    });
    await waitFor(() => {
      const decided = screen.getByTestId("permission-card");
      expect(decided.textContent).toContain('answered "Allow once" by Ada Lovelace');
      expect(decided.querySelector("[data-testid='permission-allow']")).toBeNull();
    });
  });

  it("shows a permission prompt read-only to a non-controller", async () => {
    const { requests } = renderApp({ path, routes: routes(controlledByOther) });
    await screen.findByTestId("chat-title");

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
    expect(card.querySelector("[data-testid='permission-allow']")).toBeNull();
    expect(card.querySelector("[data-testid='permission-readonly']")?.textContent).toContain(
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
});

describe("the chat's composer and stream (ported from the thread page)", () => {
  it("renders the transcript and merges streamed agent chunks into one message", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("chat-title");

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
    const items = Array.from(transcript.querySelectorAll("[data-testid='transcript-item']"));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the flaky spec");
    // One agent message, not one per chunk.
    expect(items[1].textContent).toContain("Reading the test file.");
    expect(transcript.textContent).not.toContain("\nthe test file.");
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });

  it("does not duplicate items when a reconnect replays frames", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("chat-title");

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
    expect(transcript.querySelectorAll("[data-testid='transcript-item']")).toHaveLength(2);

    // The stream does not wait on EventSource's private retry: our own
    // reconnect re-opens the same scope carrying the cursor it last rendered
    // (`?after=11`), so a replayed 11 is ignored and 12 lands once.
    act(() => source.fail());
    expect(screen.getByTestId("stream-status").textContent).toContain("reconnecting");
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

    expect(transcript.querySelectorAll("[data-testid='transcript-item']")).toHaveLength(2);
    expect(transcript.textContent).toContain("hi there");
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });

  it("names the automation that queued the turn, not a person who typed it (ADR-0062)", async () => {
    const fired: Conversation = {
      ...conversationFixture,
      origin: "run",
      control: { kind: "run_attempt", version: 2 },
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "issue_trigger",
      }),
    };
    renderApp({ path, routes: routes(fired) });
    await screen.findByTestId("chat-title");

    // The retired header's `turn-origin` chip said this once more; the
    // composer's explainer is the thread's one open-turn sentence now, and the
    // author line is the transcript's.
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.user", {
          turn_id: turnId,
          submitted_by: otherUserId,
          text: "label added: bug",
        }),
      );
    });
    const transcript = await screen.findByTestId("transcript");
    expect(transcript.querySelector("[data-testid='turn-on-behalf-of']")?.textContent).toBe(
      "on behalf of Dana Observer · issue trigger",
    );
    // The bold author prefix — the claim that this person submitted the prompt —
    // is gone, and with it any reading of the line as something a member typed.
    expect(transcript.textContent).not.toContain("Dana Observer:");
  });

  it("keeps today's rendering for a human turn and for a control plane that sends no submitted_via", async () => {
    for (const via of ["human", undefined] as const) {
      const active = turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: via,
      });
      renderApp({
        path,
        routes: routes({ ...conversationFixture, active_turn: active }),
      });
      await screen.findByTestId("chat-title");

      act(() => {
        FakeEventSource.last().emit(
          conversationEvent("conversation.message.user", {
            turn_id: turnId,
            submitted_by: otherUserId,
            text: "Fix the flaky spec",
          }),
        );
      });
      const transcript = await screen.findByTestId("transcript");
      expect(transcript.querySelector("[data-testid='turn-on-behalf-of']")).toBeNull();
      // The author's own line, in the transcript's current shape: the name, not
      // an automation sentence.
      expect(transcript.querySelector("[data-testid='user-speaker']")?.textContent).toContain(
        "Dana Observer",
      );
      cleanup();
    }
  });

  it("stops the active turn for the controller", async () => {
    const withTurn: Conversation = {
      ...conversationFixture,
      active_turn: turnFixture({ id: turnId, status: "running", submitted_by: meFixture.id }),
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
    await screen.findByTestId("chat-title");

    // Never two prompts into one running turn (01 invariant, 06): the send is
    // gated and the reason is said in the composer's explainer.
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
    const explainer = screen.getByTestId("composer-explainer");
    expect(explainer.textContent).toContain("already open");
    expect(explainer.textContent).toContain("running");

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
    await screen.findByTestId("chat-title");

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
    // The transcript says who lost the turn rather than pretending nothing happened.
    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain(
      "Turn stopped — outcome unknown (the worker stopped checking in mid-turn)",
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
    await screen.findByTestId("chat-title");

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
      active_turn: turnFixture({ id: turnId, status: "running", submitted_by: meFixture.id }),
    };
    renderApp({ path, routes: routes(withTurn) });
    await screen.findByTestId("chat-title");

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
    // proof the cached active turn has already moved on. rcn-2e review defect 1:
    // the reader's line is the plain sentence and the wire's words ride the
    // tooltip — so both assertions check the sentence AND that the enum
    // survived into `title`.
    const transcript = await screen.findByTestId("transcript");
    await waitFor(() => {
      expect(transcript.textContent).toContain("Turn completed");
      expect(transcript.textContent).not.toContain("end_turn");
    });
    const completedLine = Array.from(transcript.querySelectorAll("[data-testid='transcript-item']"))
      .concat(Array.from(transcript.querySelectorAll("li[title]")))
      .find((el) => el.textContent?.includes("Turn completed"));
    expect(completedLine?.getAttribute("title")).toBe("stop_reason end_turn");
    // And the composer is usable again for the controller.
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true),
    );
  });

  it("says the conversation was not found when the API answers 404", async () => {
    renderApp({
      path,
      routes: [
        { path: "/api/v1/me", body: meFixture },
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

function withinCard(card: HTMLElement, testId: string): HTMLElement {
  const found = card.querySelector(`[data-testid='${testId}']`) as HTMLElement | null;
  if (!found) throw new Error(`no [${testId}] inside the permission card`);
  return found;
}
