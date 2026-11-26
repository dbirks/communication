/**
 * Behaviours ported from the `/threads/:id` header (`pages/Threads.test.tsx`)
 * onto its replacement, `components/chats/ChatHeader.tsx`.
 *
 * The old header's own chrome is retired with the page: the mono meta line,
 * the `turn-status` / separator-dot readout, the two-line wrap rules and the
 * inline control pill. What a person still needs — who is in the chat, that
 * the stream is live, and the control hand-off — is here, behind the ids the
 * new header defines.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import type { ConversationSession } from "../conversation/useConversationSession";
import { conversationFixture, controlledByOther, meFixture, mockFetch } from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMutation<T>(mutate = vi.fn()): T {
  return {
    mutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  } as unknown as T;
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    data: conversationFixture,
    control: conversationFixture.control,
    isController: true,
    roleKnown: true,
    canRequestControl: true,
    status: "live",
    prompt: "",
    setPrompt: vi.fn(),
    takeControl: stubMutation<ConversationSession["takeControl"]>(),
    returnControl: stubMutation<ConversationSession["returnControl"]>(),
    ...overrides,
  } as unknown as ConversationSession;
}

function renderHeader(
  session: ConversationSession,
  props: Partial<Parameters<typeof ChatHeader>[0]> = {},
) {
  mockFetch([{ path: "/api/v1/me", body: meFixture }]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenDetails = vi.fn();
  const onOpenArtifacts = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatHeader
          session={session}
          projectId="p-1"
          scope={null}
          repositoryName={null}
          wholeProject={false}
          participants={[]}
          onOpenDetails={onOpenDetails}
          onOpenArtifacts={onOpenArtifacts}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenDetails, onOpenArtifacts };
}

describe("ChatHeader (ported from the thread header)", () => {
  it("names the people in the chat and the agent, and says the stream is live without a pile of chips", async () => {
    renderHeader(makeSession(), { participants: ["Ada Lovelace", "Grace Hopper"] });

    const header = await screen.findByTestId("chat-header");
    // The old `stream:` / `turn:` chip prefixes are gone; the live stream is
    // an announced line, not ink.
    expect(header.textContent).not.toContain("stream:");
    expect(header.textContent).not.toContain("turn:");
    expect(header.textContent).not.toContain("· •");
    const stream = within(header).getByTestId("stream-status");
    expect(stream.textContent).toBe("live");
    expect(stream.className.split(/\s+/)).toContain("sr-only");
    expect(within(header).getByTestId("chat-people").textContent).toBe(
      "Ada Lovelace, Grace Hopper · Claude Code",
    );
  });

  it("shows the retrying stream in words when the connection is not live", async () => {
    renderHeader(makeSession({ status: "reconnecting" }));
    const header = await screen.findByTestId("chat-header");
    const stream = within(header).getByTestId("stream-status");
    expect(stream.textContent).toContain("reconnecting");
    expect(stream.className.split(/\s+/)).not.toContain("sr-only");
  });

  it("returns control through the … menu, echoing the version it read", async () => {
    const mutate = vi.fn();
    renderHeader(
      makeSession({ returnControl: stubMutation<ConversationSession["returnControl"]>(mutate) }),
    );

    fireEvent.click(await screen.findByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("return-control"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ version: conversationFixture.control.version });
  });

  it("offers Take control to a member who is not the controller", async () => {
    const mutate = vi.fn();
    renderHeader(
      makeSession({
        data: controlledByOther,
        control: controlledByOther.control,
        isController: false,
        canRequestControl: true,
        takeControl: stubMutation<ConversationSession["takeControl"]>(mutate),
      }),
    );

    fireEvent.click(await screen.findByTestId("chat-menu"));
    expect(screen.queryByTestId("return-control")).toBeNull();
    fireEvent.click(await screen.findByTestId("take-control"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ version: controlledByOther.control.version });
  });

  it("refuses the act to a viewer, saying why in the item's own title", async () => {
    renderHeader(
      makeSession({
        data: controlledByOther,
        control: controlledByOther.control,
        isController: false,
        canRequestControl: false,
      }),
    );
    fireEvent.click(await screen.findByTestId("chat-menu"));
    const item = await screen.findByTestId("take-control");
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute("title")).toBe("Viewers cannot take control of a chat.");
  });

  it("opens the details and the artifacts sheets from the same menu", async () => {
    const { onOpenDetails, onOpenArtifacts } = renderHeader(makeSession());

    fireEvent.click(await screen.findByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-details"));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-artifacts"));
    expect(onOpenArtifacts).toHaveBeenCalledTimes(1);
  });
});
