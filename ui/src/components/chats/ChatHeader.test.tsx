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

function renderHeader(
  session: ConversationSession,
  props: Partial<Parameters<typeof ChatHeader>[0]> = {},
) {
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
        {...props}
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

/**
 * Phone layout (below 768px). jsdom applies no CSS, so the `max-md:*` order
 * classes and the DOM shape ARE the contract: the header breaks into row 1 =
 * back arrow · title (full width) · "…" menu, and row 2 = repo chip · status
 * line. Desktop stays the one 54px row (`md:h-[54px]`, the row-2 wrapper is
 * `md:contents`, so the chip and the status line are plain header items).
 */
function mobileOrderOf(element: HTMLElement): number {
  const match = element.className.match(/(?:^|\s)max-md:order-(\d+)/);
  return match ? Number(match[1]) : 0;
}

describe("ChatHeader phone rows", () => {
  it("puts the back arrow, the title and the menu on row 1, the chip and status on row 2", () => {
    renderHeader(makeSession(), { showBack: true });

    const back = screen.getByTestId("chat-back");
    const title = screen.getByTestId("chat-title");
    const menu = screen.getByTestId("chat-menu").parentElement as HTMLElement;
    const chip = screen.getByTestId("chat-repo-chip");
    const status = screen.getByTestId("chat-header-status");

    // Row 1 order: back < title < menu, and the title is the flexible item.
    expect(mobileOrderOf(back)).toBe(1);
    expect(mobileOrderOf(title)).toBe(2);
    expect(mobileOrderOf(menu)).toBe(3);
    for (const cls of ["max-md:flex-1", "min-w-0", "truncate"]) {
      expect(title.className.split(/\s+/)).toContain(cls);
    }

    // Row 2: the chip and the status line ride one full-width band, the chip
    // first, and that band follows the menu.
    expect(chip.parentElement).toBe(status.parentElement);
    const row2 = chip.parentElement as HTMLElement;
    expect(mobileOrderOf(row2)).toBe(4);
    for (const cls of ["max-md:w-full", "max-md:flex", "md:contents"]) {
      expect(row2.className.split(/\s+/)).toContain(cls);
    }
    expect(chip.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.textContent).toContain("agent: claude");

    // Desktop keeps the single row: the header is a fixed-height nowrap flex
    // band and the row-2 wrapper dissolves.
    const header = screen.getByTestId("chat-header");
    for (const cls of ["md:h-[54px]", "md:flex-nowrap", "flex-wrap"]) {
      expect(header.className.split(/\s+/)).toContain(cls);
    }
  });

  it("still breaks into two rows without the back arrow or a repository", () => {
    renderHeader(makeSession(), { repositoryName: null, wholeProject: true });
    const title = screen.getByTestId("chat-title");
    const chip = screen.getByTestId("chat-repo-chip");
    expect(mobileOrderOf(title)).toBe(2);
    expect(chip.textContent).toBe("Whole project");
    expect(mobileOrderOf(chip.parentElement as HTMLElement)).toBe(4);
  });
});
