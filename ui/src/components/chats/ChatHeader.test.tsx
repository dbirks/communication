import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import type { ConversationSession } from "../conversation/useConversationSession";
import { conversationFixture, controlledByOther } from "../../test/fakes";

afterEach(cleanup);

function stubMutation() {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  } as unknown as ConversationSession["takeControl"];
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    data: {
      ...conversationFixture,
      agent_session: {
        id: "sess-1",
        launcher_id: "claude",
        session_origin: "new",
        connected_at: "2026-11-20T10:00:00Z",
      },
    },
    control: conversationFixture.control,
    isController: true,
    roleKnown: true,
    canRequestControl: true,
    status: "live",
    nameOf: () => "Ada Lovelace",
    described: { status: "running", active: { id: "t-1", status: "running" } as never },
    takeControl: stubMutation(),
    returnControl: stubMutation() as unknown as ConversationSession["returnControl"],
    ...overrides,
  } as unknown as ConversationSession;
}

function renderHeader(session: ConversationSession) {
  render(
    <MemoryRouter>
      <ChatHeader
        session={session}
        projectId="p-1"
        scope={null}
        repositoryName="web"
        wholeProject={false}
        participants={["Ada Lovelace"]}
        onOpenDetails={vi.fn()}
        onOpenArtifacts={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("ChatHeader status line", () => {
  it("shows running turn status, controller badge, and agent session line", () => {
    renderHeader(makeSession());
    const turn = screen.getByTestId("turn-status");
    expect(turn.textContent).toBe("● running");
    expect(turn.className).toContain("text-st-running-tag-fg");
    expect(screen.getByTestId("controller-badge").textContent).toBe("you control");
    expect(screen.getByTestId("agent-session").textContent).toBe("agent: claude");
  });

  it("shows done, cancelled, and failed turn statuses with their state colours and other controller name", () => {
    renderHeader(
      makeSession({
        data: controlledByOther,
        control: controlledByOther.control,
        isController: false,
        described: {
          status: "completed",
          record: { turnId: "t-1", status: "completed" } as never,
        },
      }),
    );
    expect(screen.getByTestId("turn-status").textContent).toBe("✓ done");
    expect(screen.getByTestId("turn-status").className).toContain("text-st-done-tag-fg");
    expect(screen.getByTestId("controller-badge").textContent).toBe("Dana Observer controls");

    cleanup();
    renderHeader(
      makeSession({
        described: {
          status: "cancelled",
          record: { turnId: "t-2", status: "cancelled" } as never,
        },
      }),
    );
    expect(screen.getByTestId("turn-status").textContent).toBe("⊘ cancelled");
    expect(screen.getByTestId("turn-status").className).toContain("text-st-interrupted-tag-fg");

    cleanup();
    renderHeader(
      makeSession({
        described: {
          status: "failed",
          record: { turnId: "t-3", status: "failed" } as never,
        },
      }),
    );
    expect(screen.getByTestId("turn-status").textContent).toBe("× failed");
    expect(screen.getByTestId("turn-status").className).toContain("text-st-failed-tag-fg");
  });
});
