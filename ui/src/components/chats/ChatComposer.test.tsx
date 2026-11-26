import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ChatComposer } from "./ChatComposer";
import type { ConversationSession } from "../conversation/useConversationSession";
import {
  claudeProfile,
  conversationFixture,
  controlledByOther,
  meFixture,
  mockFetch,
  projectFixture,
  turnFixture,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMutation(mutate = vi.fn()) {
  return {
    mutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  } as unknown as ConversationSession["sendMessage"];
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversation: { data: conversationFixture } as ConversationSession["conversation"],
    data: conversationFixture,
    activeTurn: undefined,
    control: conversationFixture.control,
    isController: true,
    roleKnown: true,
    canRequestControl: true,
    nameOf: () => meFixture.display_name,
    events: [],
    status: "live",
    transcript: { items: [], turns: [] } as unknown as ConversationSession["transcript"],
    turnRows: [],
    described: {
      status: "idle",
      record: null,
      active: null,
    } as unknown as ConversationSession["described"],
    turnInProgress: false,
    prompt: "",
    setPrompt: vi.fn(),
    onSend: vi.fn(),
    onDecide: vi.fn(),
    decidingRequestId: null,
    sendMessage: stubMutation(),
    switchAgent: stubMutation() as unknown as ConversationSession["switchAgent"],
    takeControl: stubMutation() as unknown as ConversationSession["takeControl"],
    returnControl: stubMutation() as unknown as ConversationSession["returnControl"],
    cancelTurn: stubMutation() as unknown as ConversationSession["cancelTurn"],
    decide: stubMutation() as unknown as ConversationSession["decide"],
    ...overrides,
  };
}

function renderComposer(session: ConversationSession, onOpenWorkflow = vi.fn(), withState = false) {
  mockFetch([
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Wrapper() {
    const [prompt, setPrompt] = useState(session.prompt);
    const merged = withState ? { ...session, prompt, setPrompt } : session;
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ChatComposer session={merged} onOpenWorkflow={onOpenWorkflow} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return render(<Wrapper />);
}

describe("ChatComposer", () => {
  it("sends a prompt when submitted by the controller", () => {
    const sendMutate = vi.fn();
    const session = makeSession({
      sendMessage: stubMutation(sendMutate),
    });
    renderComposer(session, vi.fn(), true);

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "Check the logs" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0][0]).toEqual({ prompt: "Check the logs" });
  });

  it("shows Stop while a turn is running and calls cancelTurn on click", () => {
    const cancelMutate = vi.fn();
    const session = makeSession({
      turnInProgress: true,
      activeTurn: turnFixture({ status: "running" }),
      cancelTurn: stubMutation(cancelMutate) as unknown as ConversationSession["cancelTurn"],
    });
    renderComposer(session);

    const stop = screen.getByTestId("stop-turn");
    expect(stop.textContent).toBe("Stop");
    fireEvent.click(stop);
    expect(cancelMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "A turn is already open",
    );
  });

  it("disables composer and shows explainer when not the controller", () => {
    const session = makeSession({
      data: controlledByOther,
      control: controlledByOther.control,
      isController: false,
      canRequestControl: true,
    });
    renderComposer(session);

    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain(
      "Only the controller (Dana Observer) can send prompts. Take control to drive.",
    );
  });
});
