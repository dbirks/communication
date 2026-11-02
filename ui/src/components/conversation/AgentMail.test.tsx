/**
 * Agent mail across repos (ADR-0072, design 3d), UI side.
 *
 * The transcript card is proven from the journal frames through the real
 * chat page — user turn, agent answer, `conversation.mail.asked` cutting
 * the transcript under that answer, `conversation.mail.answered` folding
 * into the same card by link id — plus the side panel's LINKED CHATS rows
 * and the composer's @-hint, which shows only while the project setting is
 * on. A rejected ask renders no card: it is a journal row and a follow-up
 * notice, never a link. And the § 9 person-initiated path: the composer's
 * `@` opens the ds menu over the project's OTHER repositories, picking one
 * completes the token, and sending `@<repo> <question>` posts the same
 * messages route with `mail_to` — no prompt turn, the mail ask.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
import { mailAskFromPrompt, mentionQueryAtCaret } from "./AgentConversationPanel";

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

// The § 9 composer @-ask: the menu offers the project's OTHER repositories
// (the thread's own `repository_name` is never a candidate), picking one
// completes the `@<repo> ` token, and sending posts the messages route with
// `mail_to` — the mail dispatch, not a prompt turn.
const mailMessagesPath = `${conversationPath}/messages`;
const reposStub: RouteStub = {
  path: `/api/v1/projects/${projectFixture.id}/repos`,
  body: {
    items: ["api", "web", "docs"].map((name, index) => ({
      id: `01987a77-000${index}-7000-8000-000000000000`,
      project_id: projectFixture.id,
      name,
      git_url: `file:///srv/${name}`,
      default_branch: "main",
      created_at: "2026-10-14T18:00:00Z",
    })),
  },
};
const askedRoute: RouteStub = {
  method: "POST",
  path: mailMessagesPath,
  status: 202,
  body: {
    link_id: "01987a78-1111-7000-8000-000000000001",
    to_conversation_id: "chat-api-1",
    repo: "api",
    question: "where is search wired?",
    state: "asked",
  },
};

function mailRoutes(project: Project): RouteStub[] {
  return routes(project, [
    { path: conversationPath, body: { ...mailConversation, repository_name: "web" } },
    reposStub,
    askedRoute,
  ]);
}

describe("the composer @-menu (ADR-0072 § 9)", () => {
  it("lists the project's other repositories and completes the token on pick", async () => {
    const { fetchMock } = renderApp({ path, routes: mailRoutes(mailProject) });
    void fetchMock;
    await screen.findByTestId("conversation-title");
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "@" } });

    const menu = await screen.findByTestId("composer-mail-menu");
    // The repos read rides the project page's query key; the items land when
    // it answers.
    const apiItem = await within(menu).findByTestId("composer-mail-repo-api");
    expect(apiItem.textContent).toContain("api");
    expect(await within(menu).findByTestId("composer-mail-repo-docs")).toBeTruthy();
    // The thread's OWN repository is not an offer — the ask is for another
    // repo's agent, and the project has exactly these three.
    expect(within(menu).queryByTestId("composer-mail-repo-web")).toBeNull();

    fireEvent.click(within(menu).getByTestId("composer-mail-repo-api"));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("@api "));
    expect(screen.queryByTestId("composer-mail-menu")).toBeNull();
  });

  it("sending `@<repo> <question>` posts mail_to — not a prompt", async () => {
    const { requests } = renderApp({ path, routes: mailRoutes(mailProject) });
    await screen.findByTestId("conversation-title");
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "@api where is search wired?" } });
    const send = await screen.findByTestId("composer-send");
    // The verb says what the click does: an ask, not a prompt.
    await waitFor(() => expect(send.textContent).toBe("Ask"));
    fireEvent.click(send);

    await waitFor(() => {
      const post = requests.find(
        (request) => request.method === "POST" && request.url === mailMessagesPath,
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body ?? "{}")).toEqual({
        prompt: "where is search wired?",
        mail_to: "api",
      });
    });
    // The composer clears only after the ask is durable (202), and the mail
    // arm queued NO prompt — the card and the answer arrive on the stream.
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("an ordinary prompt, and a mention of the thread's own repo, post no mail_to", async () => {
    const { requests } = renderApp({ path, routes: mailRoutes(mailProject) });
    await screen.findByTestId("conversation-title");
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "run the tests" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === "POST" &&
            request.url === mailMessagesPath &&
            JSON.parse(request.body ?? "{}").mail_to === undefined,
        ),
      ).toBe(true),
    );

    // `@web …` names THIS thread's repository: it stays a prompt to this
    // chat's own agent — the menu never offers it, and the send path agrees.
    fireEvent.change(input, { target: { value: "@web explain the change" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === "POST" &&
            request.url === mailMessagesPath &&
            JSON.parse(request.body ?? "{}").prompt === "@web explain the change",
        ),
      ).toBe(true),
    );
    expect(requests.some((request) => (request.body ?? "").includes("mail_to"))).toBe(false);
  });

  it("is absent while the setting is off", async () => {
    const { fetchMock } = renderApp({
      path,
      routes: routes({ ...projectFixture, agent_mail_enabled: false }, [reposStub]),
    });
    void fetchMock;
    await screen.findByTestId("conversation-title");
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.queryByTestId("composer-mail-menu")).toBeNull();
  });

  it("the parsers name the token, not an email or a bare mention", () => {
    expect(mentionQueryAtCaret("@ap", 3)).toBe("ap");
    expect(mentionQueryAtCaret("ask @", 5)).toBe("");
    expect(mentionQueryAtCaret("mail@x", 6)).toBeNull();
    expect(mentionQueryAtCaret("@api question", 4)).toBe("api");
    expect(mailAskFromPrompt("@api  hello ", ["api", "docs"])).toEqual({
      repo: "api",
      question: "hello",
    });
    // A bare `@api` asks nothing, and an unknown repo is an ordinary prompt.
    expect(mailAskFromPrompt("@api", ["api"])).toBeNull();
    expect(mailAskFromPrompt("@ghost hello", ["api"])).toBeNull();
    expect(mailAskFromPrompt("@API hello", ["api"])).toEqual({ repo: "api", question: "hello" });
  });
});
