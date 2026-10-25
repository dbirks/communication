/**
 * The shared conversation surface: one panel for the page and the docks.
 *
 * Mocked at the fetch boundary, the same way the conversation page's suite is
 * (route stubs plus a fake `EventSource` the test drives), so the assertions
 * are about what a member sees: the dock's transcript and open-full link, the
 * viewer's disabled handoff, the controller's live composer, and the
 * non-controller's explainer.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { render as renderDom, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "../../api/client";
import { AgentConversationPanel } from "./AgentConversationPanel";
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
  projectFixture,
  mockFetch,
  requestsTo,
  turnFixture,
  turnId,
  type RouteStub,
} from "../../test/fakes";
import type { Conversation } from "../../api/types";

afterEach(cleanup);

/** The panel is a component, not a page: wrap it in the app's providers only.
 * `requests` is the fetch-boundary log, for the mutation assertions. */
function renderPanel(ui: ReactNode, routes: RouteStub[]) {
  setCsrfToken(null);
  const { requests } = mockFetch(routes, {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return {
    ...renderDom(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
    requests,
    queryClient,
  };
}

const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;

function routes(conversation: Conversation, myRole: string = "maintainer"): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: { ...projectFixture, my_role: myRole } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: conversationPath, method: "GET", body: conversation },
  ];
}

/** A conversation the factory still controls: a takeover is on offer. */
const runControlled: Conversation = {
  ...conversationFixture,
  origin: "run",
  control: { kind: "run_attempt", version: 2 },
};

const dock = (props: Record<string, unknown> = {}) => (
  <AgentConversationPanel
    conversationId={conversationId}
    projectId={projectFixture.id}
    variant="dock"
    {...props}
  />
);

describe("AgentConversationPanel (dock)", () => {
  it("renders the transcript and the open-full conversation link", async () => {
    renderPanel(dock(), routes(conversationFixture));
    const open = await screen.findByTestId("dock-open-conversation");
    expect(open.getAttribute("href")).toBe(
      `/projects/${projectFixture.id}/conversations/${conversationId}`,
    );
    expect(screen.getByText("Open full conversation")).toBeTruthy();

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Fix the flaky spec",
        }),
      );
      source.emit(conversationEvent("conversation.message.agent", { text: "On it.", final: true }));
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the flaky spec");
    // The dock badge says who is driving, in words.
    expect(screen.getByTestId("controller-badge").textContent).toContain("in control");
  });

  it("shows a disabled Take control to a viewer, and says watching is all they may do", async () => {
    renderPanel(dock(), routes(controlledByOther, "viewer"));
    const take = await screen.findByTestId("take-control");
    expect(take.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "watch this conversation",
    );
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(true);
  });

  it("gives the controller an enabled composer", async () => {
    renderPanel(
      dock({
        composer: {
          inputId: "panel-prompt",
          rows: 2,
          nonControllerPlaceholder: "Only the controller can prompt.",
        },
      }),
      routes(conversationFixture),
    );
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(false);
    const send = screen.getByTestId("composer-send");
    // Empty prompts are never sent.
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "Check the tests" } });
    expect(send.hasAttribute("disabled")).toBe(false);
  });

  it("shows the non-controller the explainer instead of a live composer", async () => {
    renderPanel(dock(), routes(controlledByOther));
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(true);
    const explainer = screen.getByTestId("composer-explainer");
    expect(explainer.textContent).toContain(
      "Only the controller (Dana Observer) can send prompts.",
    );
    expect(explainer.textContent).toContain("Take control to drive.");
  });

  it("shows the whole conversation, marking the attempt's turn and the human turns", async () => {
    // A takeover cancels the attempt's turn and opens a NEW turn in the same
    // conversation — the dock must keep the first turn AND show the human's
    // prompt and the reply, with markers at each boundary.
    const humanTurnId = "01987a99-0000-7000-8000-abcdef012346";
    renderPanel(dock({ attemptTurnId: turnId }), routes(conversationFixture));
    const source = FakeEventSource.last();
    act(() => {
      // The attempt's own (factory) turn: agent work, no user message.
      source.emit(
        conversationEvent("conversation.message.agent", { text: "Working on it.", final: true }),
      );
      // A human takes over and prompts — a new turn in the same conversation.
      source.emit(
        conversationEvent("conversation.message.user", {
          turn_id: humanTurnId,
          submitted_by: meFixture.id,
          text: "New direction: keep the diff minimal",
        }),
      );
      source.emit(
        conversationEvent("conversation.message.agent", {
          turn_id: humanTurnId,
          text: "Understood — minimal diff.",
          final: true,
        }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    // 3 journal rows plus 2 marker rows — nothing is hidden.
    expect(items).toHaveLength(5);
    expect(transcript.textContent).toContain("Working on it.");
    expect(transcript.textContent).toContain("New direction: keep the diff minimal");
    expect(transcript.textContent).toContain("Understood — minimal diff.");
    // The marker before the attempt's first frame names that turn…
    const attemptMarker = items.find((item) =>
      item.textContent?.includes("this attempt's turn starts here"),
    );
    expect(attemptMarker).toBeDefined();
    expect(items.indexOf(attemptMarker as HTMLElement)).toBe(0);
    // …and the marker before the human's turn names the person.
    const humanMarker = items.find((item) =>
      item.textContent?.includes("human turn — prompted by Ada Lovelace"),
    );
    expect(humanMarker).toBeDefined();
    expect(items.indexOf(humanMarker as HTMLElement)).toBe(2);
  });

  it("marks the attempt's unattended turn as one nobody typed (ADR-0062)", async () => {
    // A schedule fire's agent turn: the seam stamps the turn row (no
    // `conversation.message.user` frame — the prompt row belongs to a human's
    // own POST), so the only thing naming this turn is `active_turn`, and what
    // it names is the member who authorised the schedule.
    const fired: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "schedule",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(fired));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { turn_id: turnId, text: "Planning." }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    const marker = within(transcript)
      .getAllByTestId("transcript-item")
      .find((item) => item.textContent?.includes("this attempt's turn starts here"));
    expect(marker?.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · schedule",
    );
    // The line that would credit a person with typing it is gone.
    expect(marker?.textContent).not.toContain("human turn");
  });

  it("refuses to call an issue trigger's turn a human turn, even with a prompt row", async () => {
    // Precedence: the frame names a person and the row says no person queued
    // it, and the row is the fact (ADR-0062) — the old code called any user
    // frame proof a member had taken over and typed the prompt.
    const fired: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "issue_trigger",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(fired));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent(
          "conversation.message.user",
          { turn_id: turnId, submitted_by: otherUserId, text: "Open the PR for issue #7" },
          { global_seq: 5100 },
        ),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · issue trigger",
    );
    expect(transcript.textContent).not.toContain("human turn — prompted by");
    // The prompt bubble itself says the same thing rather than a bare author.
    const onBehalf = within(transcript).getAllByTestId("turn-on-behalf-of");
    expect(onBehalf).toHaveLength(1);
    expect(onBehalf[0].textContent).toBe("on behalf of Dana Observer · issue trigger");
  });

  it("keeps the human wording for a turn the row says a person typed", async () => {
    // The child_run/automation branch must not swallow the honest case: a turn
    // whose row says `human` still reads exactly as it did before.
    const typed: Conversation = {
      ...conversationFixture,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "human",
      }),
    };
    renderPanel(dock({ attemptTurnId: "01987a99-0000-7000-8000-abcdef012346" }), routes(typed));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent(
          "conversation.message.user",
          { turn_id: turnId, submitted_by: otherUserId, text: "Keep the diff minimal" },
          { global_seq: 5200 },
        ),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain("human turn — prompted by Dana Observer");
    expect(transcript.textContent).not.toContain("on behalf of");
    expect(within(transcript).queryAllByTestId("turn-on-behalf-of")).toHaveLength(0);
  });

  it("marks a child run's inherited turn as unattended too", async () => {
    const child: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "child_run",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(child));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { turn_id: turnId, text: "Reviewing." }),
      );
    });
    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · child run",
    );
  });

  it("makes the dock's Take control a two-step confirm, and the card says what a takeover does", async () => {
    const taken: Conversation = {
      ...runControlled,
      control: {
        kind: "human",
        user_id: meFixture.id,
        display_name: meFixture.display_name,
        version: 3,
      },
    };
    const { requests } = renderPanel(dock({ stepName: "implement" }), [
      ...routes(runControlled),
      { path: `${conversationPath}/take-control`, method: "POST", status: 200, body: taken },
    ]);

    // The first click shows the card — it must NOT fire the mutation.
    fireEvent.click(await screen.findByTestId("take-control"));
    const card = await screen.findByTestId("take-control-card");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("take-control-card-heading").textContent).toBe(
      "Take control of implement?",
    );
    expect(card.textContent).toContain(
      "The current attempt of implement stops and the run pauses.",
    );
    expect(card.textContent).toContain("runs again as a new attempt with whatever you changed.");
    expect(card.textContent).not.toContain("pauses before");
    // Focus moved to the primary action.
    expect(document.activeElement).toBe(screen.getByTestId("take-control-confirm"));
    expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(0);

    // Just watch (here: Escape) closes the card and still sends nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("take-control-card")).toBeNull();
    expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(0);

    // Confirming is the only click that POSTs — once, echoing the version read.
    fireEvent.click(screen.getByTestId("take-control"));
    fireEvent.click(await screen.findByTestId("take-control-confirm"));
    await waitFor(() =>
      expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1),
    );
    const posts = requestsTo(requests, `${conversationPath}/take-control`, "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body ?? "{}")).toEqual({ version: 2 });
    // The takeover landed: the badge says so, and the composer unlocks.
    await waitFor(async () =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("You are in control"),
    );
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the one-click take when the surface opts out of the confirm card", async () => {
    // The standalone Conversation page wears exactly this: the take button
    // with `confirmTakeover` off — the first click fires the mutation, no card.
    const taken: Conversation = {
      ...runControlled,
      control: {
        kind: "human",
        user_id: meFixture.id,
        display_name: meFixture.display_name,
        version: 3,
      },
    };
    const { requests } = renderPanel(dock({ confirmTakeover: false }), [
      ...routes(runControlled),
      { path: `${conversationPath}/take-control`, method: "POST", status: 200, body: taken },
    ]);
    fireEvent.click(await screen.findByTestId("take-control"));
    await waitFor(() =>
      expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1),
    );
    expect(screen.queryByTestId("take-control-card")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("You are in control"),
    );
  });
});
