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
  repositoryId,
  turnFixture,
  type RouteStub,
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

function renderComposer(
  session: ConversationSession,
  onOpenWorkflow = vi.fn(),
  withState = false,
  extraRoutes: RouteStub[] = [],
) {
  mockFetch([
    // `extra` first so a stub there shadows the defaults below.
    ...extraRoutes,
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

  // rx-c1: the `/ skill` and `# issue` triggers were the odd ones out in the
  // chip row — a 28px mono box with a hard border, and an icon hash. Both now
  // wear `PromptChip` exactly, led by a muted mono glyph.
  it("renders the / skill and # issue triggers as composer chips", async () => {
    const session = makeSession({
      data: { ...conversationFixture, repository_name: "communication" },
    });
    renderComposer(session, vi.fn(), false, [
      {
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: {
          items: [
            {
              id: repositoryId,
              name: "communication",
              git_url: "https://github.com/example/communication.git",
              default_branch: "main",
            },
          ],
        },
      },
    ]);

    // A genuine `PromptChip` in the same row is the reference for the look.
    const reference = screen.getByTestId("chat-run-workflow");
    const skill = screen.getByTestId("composer-skill-button");
    // The `#` chip only exists once the repo read says the chat's repository
    // is GitHub-hosted, so it arrives one tick later.
    const issue = await screen.findByTestId("chat-issue-button");
    expect(skill.className).toBe(reference.className);
    expect(issue.className).toBe(reference.className);

    // Leading glyph: a muted mono character, then the word in the UI font.
    for (const [chip, glyph] of [
      [skill, "/"],
      [issue, "#"],
    ] as const) {
      const mark = chip.querySelector("span") as HTMLElement;
      expect(mark.textContent).toBe(glyph);
      expect(mark.className).toContain("font-mono");
      expect(mark.className).toContain("text-muted");
      const word = mark.nextElementSibling as HTMLElement;
      expect(word.className).toContain("font-semibold");
      expect(word.className).toContain("text-[12.5px]");
    }

    // Their ids and accessible names survive the restyle.
    expect(skill.getAttribute("aria-label")).toBe("Skills");
    expect(skill.getAttribute("aria-haspopup")).toBe("menu");
    expect(issue.getAttribute("aria-haspopup")).toBe("menu");
    expect(issue.getAttribute("aria-expanded")).toBe("false");
  });

  // rx-c1: on a phone the row used to fold under itself and push Send off the
  // line. It is one scrolling line at every width now.
  it("never clips the chip row: a scrolling row would hide the pickers that open from it", () => {
    renderComposer(makeSession());
    const row = screen.getByTestId("composer-chips");
    // `overflow-x: auto` also clips vertically, so the agent picker opened
    // under the transcript and could not be clicked (Acceptance 45917627404).
    expect(row.className).not.toMatch(/overflow-/);
    expect(row.className).toContain("flex-wrap");
    // The chips are the row's children and the send button stays outside it.
    expect(row.contains(screen.getByTestId("composer-agent-chip"))).toBe(true);
    expect(row.contains(screen.getByTestId("composer-send"))).toBe(false);
  });
});
