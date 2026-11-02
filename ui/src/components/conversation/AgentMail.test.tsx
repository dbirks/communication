/**
 * Agent mail across repos (ADR-0072, design 3d), UI side.
 *
 * The transcript card is proven from the journal frames through the real
 * chat page — user turn, agent answer, `conversation.mail.asked` cutting
 * the transcript under that answer, `conversation.mail.answered` folding
 * into the same card by link id — plus the side panel's LINKED CHATS rows
 * and the composer's @-hint, which shows only while the project setting is
 * on. A rejected ask renders no card: it is a journal row and a follow-up
 * notice, never a link.
 */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import {
  conversationEvent,
  conversationFixture,
  conversationId,
  FakeEventSource,
  meFixture,
  projectFixture,
  turnId,
  type RouteStub,
} from "../../test/fakes";
import type { components } from "../../api/schema";
import type { Conversation, Project } from "../../api/types";

type ConversationLink = components["schemas"]["ConversationLink"];
import { MailCard, mailAskedFromEvent, mailAnswerLine, mergeMailAnswered } from "./MailCard";
import { segmentTranscript } from "./ConversationTranscript";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const path = `/p/${projectFixture.id}/conversations/${conversationId}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;

const linkedChat: ConversationLink = {
  id: "01987a75-1111-7000-8000-000000000001",
  direction: "outgoing" as const,
  repo_name: "api",
  state: "answered" as const,
  question: "Does GET /search accept cursor params?",
  answer: "Cursor-based: ?after=<id>&limit=, max 100.",
  reason: null,
  other_conversation: {
    id: "chat-api-1",
    title: "mail from search spike → api",
    status: "idle" as const,
  },
  launcher_id: "codex",
  created_at: "2026-10-14T18:03:00Z",
  answered_at: "2026-10-14T18:05:00Z",
};

const mailProject: Project = { ...projectFixture, agent_mail_enabled: true };
const mailConversation: Conversation = {
  ...conversationFixture,
  linked_chats: [linkedChat],
};

function routes(project: Project, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${projectFixture.id}`, body: project },
    { path: conversationPath, body: mailConversation },
  ];
}

function emitMailFlow(): void {
  const source = FakeEventSource.last();
  act(() => {
    source.emit(
      conversationEvent("conversation.message.user", {
        turn_id: turnId,
        submitted_by: meFixture.id,
        text: "Check with api before you wire it.",
      }),
    );
    source.emit(
      conversationEvent("conversation.message.agent", {
        turn_id: turnId,
        text: "I'll ask the api team.",
        final: true,
      }),
    );
    source.emit(
      conversationEvent("conversation.mail.asked", {
        turn_id: turnId,
        link_id: "link-1",
        to_conversation_id: "chat-api-1",
        repo: "api",
        question: "Does GET /search accept cursor params?",
        state: "asked",
      }),
    );
    source.emit(
      conversationEvent("conversation.mail.answered", {
        link_id: "link-1",
        from_conversation_id: conversationId,
        to_conversation_id: "chat-api-1",
        repo: "api",
        state: "answered",
        answer: "Cursor-based: ?after=<id>&limit=, max 100.",
        launcher_id: "codex",
      }),
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the transcript mail card", () => {
  it("cuts the transcript at the ask and folds the answer into the same card", async () => {
    renderApp({ path, routes: routes(mailProject) });
    await screen.findByTestId("conversation-title");
    emitMailFlow();

    const cards = await screen.findAllByTestId("mail-card");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(within(card).getByTestId("mail-card-bar").textContent).toContain("asked the agent in");
    expect(within(card).getByTestId("mail-card-bar").textContent).toContain("api");
    expect(within(card).getByTestId("mail-card-question").textContent).toContain("cursor params");
    const answer = await within(card).findByTestId("mail-card-answer");
    expect(answer.textContent).toContain("← api · codex");
    expect(answer.textContent).toContain("max 100");
    const open = within(card).getByTestId("mail-card-open-chat");
    expect(open.getAttribute("href")).toContain("/threads/chat-api-1");
    // The agent's own final message precedes the card in document order:
    // the ask cut the transcript under it.
    const transcript = screen.getByTestId("transcript");
    expect(
      transcript.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a pending ask without an answer line and shows the wait copy", () => {
    const card = {
      linkId: "link-2",
      repo: "web",
      question: "How is the form mounted?",
      turnId,
      toConversationId: "chat-web-1",
    };
    render(
      <MemoryRouter>
        <ul>
          <MailCard card={card} />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("mail-card-pending").textContent).toContain("answer arrives");
    expect(screen.queryByTestId("mail-card-answer")).toBeNull();
  });

  it("a rejected ask renders no card", () => {
    const event = conversationEvent("conversation.mail.asked", {
      link_id: "",
      repo: "ghost",
      question: "hello?",
      state: "rejected",
      reason: 'no repository named "ghost" in this project',
    });
    expect(mailAskedFromEvent(event)).toBeNull();
    const parts = segmentTranscript([], [event]);
    expect(parts.every((part) => part.mails.length === 0)).toBe(true);
  });

  it("mergeMailAnswered matches by link id only", () => {
    const base = { linkId: "l-1", repo: "api", question: "q", turnId: "t" };
    const other = conversationEvent("conversation.mail.answered", {
      link_id: "l-2",
      state: "answered",
      answer: "wrong thread",
    });
    expect(mergeMailAnswered(base, other)).toBe(base);
    const mine = conversationEvent("conversation.mail.answered", {
      link_id: "l-1",
      state: "failed",
      reason: "the answering turn ended failed",
      launcher_id: "claude",
    });
    const merged = mergeMailAnswered(base, mine);
    expect(merged.state).toBe("failed");
    expect(mailAnswerLine(merged)).toBe("← api · claude · failed");
  });
});

describe("the side panel LINKED CHATS section", () => {
  it("lists the mail links with their state", async () => {
    renderApp({ path, routes: routes(mailProject) });
    await screen.findByTestId("conversation-title");
    const links = await screen.findByTestId("side-panel-links");
    const row = within(links).getByTestId("side-panel-link-row-0");
    expect(row.textContent).toContain("api");
    expect(row.textContent).toContain("✓ answered");
    expect(row.textContent).toContain("read-only");
    expect(within(links).getByTestId("side-panel-link-chat-0").getAttribute("href")).toContain(
      "/threads/chat-api-1",
    );
    expect(within(links).getByTestId("side-panel-links-note").textContent).toContain("read-only");
  });

  it("is absent when there are no links", async () => {
    renderApp({
      path,
      routes: routes(mailProject, [
        { path: conversationPath, body: { ...conversationFixture, linked_chats: [] } },
      ]),
    });
    await screen.findByTestId("conversation-title");
    expect(screen.queryByTestId("side-panel-links")).toBeNull();
  });
});

describe("the composer @-hint", () => {
  it("shows only while the project setting is on", async () => {
    renderApp({ path, routes: routes(mailProject) });
    await screen.findByTestId("conversation-title");
    const hint = await screen.findByTestId("composer-mail-hint");
    expect(hint.textContent).toContain("another repo's agent");
    expect(hint.textContent).toContain("read-only");
  });

  it("is absent for a project with the setting off", async () => {
    renderApp({
      path,
      routes: routes({ ...projectFixture, agent_mail_enabled: false }),
    });
    await screen.findByTestId("conversation-title");
    await waitFor(() => screen.getByTestId("conversation-title"));
    expect(screen.queryByTestId("composer-mail-hint")).toBeNull();
  });
});
