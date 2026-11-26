import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowSuggestion } from "./WorkflowSuggestion";
import { ChatComposer } from "./ChatComposer";
import { dismissWorkflowSuggestion, isWorkflowSuggestionDismissed } from "./chatSuggestion";
import type { ConversationSession } from "../conversation/useConversationSession";
import { conversationFixture, meFixture } from "../../test/fakes";
import { useState } from "react";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function stubMutation() {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  } as unknown as ConversationSession["sendMessage"];
}

function makeSession(): ConversationSession {
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
  };
}

describe("WorkflowSuggestion", () => {
  const suggestion = {
    pipelineId: "pipe-1",
    name: "wf-1",
    subject: "#42",
    summary: "plan + implement + test",
  };

  it("calls onRun when Run it is clicked", () => {
    const onRun = vi.fn();
    const onDismiss = vi.fn();
    render(<WorkflowSuggestion suggestion={suggestion} onRun={onRun} onDismiss={onDismiss} />);
    expect(screen.getByTestId("workflow-suggestion").textContent).toContain("wf-1");
    expect(screen.getByTestId("workflow-suggestion").textContent).toContain("#42");
    expect(screen.getByTestId("workflow-suggestion").textContent).toContain(
      "plan + implement + test",
    );

    fireEvent.click(screen.getByTestId("workflow-suggestion-run"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("pressing Tab then Enter in the composer does NOT accept the suggestion", () => {
    const onRun = vi.fn();
    const onDismiss = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Harness() {
      const [prompt, setPrompt] = useState("Fix #42");
      const session = { ...makeSession(), prompt, setPrompt };
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ChatComposer
              session={session}
              onOpenWorkflow={vi.fn()}
              aboveBox={
                <WorkflowSuggestion suggestion={suggestion} onRun={onRun} onDismiss={onDismiss} />
              }
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    }

    render(<Harness />);
    const input = screen.getByTestId("composer-input");
    input.focus();
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(document.activeElement ?? input, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("dismisses when × is clicked and persists dismissal", () => {
    const onRun = vi.fn();
    const onDismiss = vi.fn(() => dismissWorkflowSuggestion("conv-99"));
    render(<WorkflowSuggestion suggestion={suggestion} onRun={onRun} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(isWorkflowSuggestionDismissed("conv-99")).toBe(true);
  });
});
