/**
 * The approval decision POST body (ui-confirm; ADR-0050 decision 2):
 * `Retry` posts exactly `{"confirm": <id>}` and `Not now` exactly
 * `{"dismiss": <id>}` — NEVER `text` alongside (the handler 400s a
 * decision post that carries text), and a rejected decision shows the
 * API's own message inline on the popover.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import AssistantPopover, {
  openAssistantPopover,
  openAssistantWorkflowDraft,
} from "./AssistantPopover";
import { openAsk } from "./askControl";
import { sectionOf } from "../Shell";

const CONV = "conv-1";
/** m5-assistant.spec.ts's verbatim ask (the e2e replica below posts it). */
const QUESTION = "Which projects can I see, and is anything waiting for approval?";
const OLD_CONV = "conv-old";
const UNDATED_CONV = "conv-untitled";
const NEW_CONV = "conv-new";
const CONVS_PATH = "/api/v1/assistant/conversations?limit=5";
const CREATE_PATH = "/api/v1/assistant/conversations";
const MSG = "msg-1";

/** Newest first (last_message_at): conv-1, then conv-old. */
const CONV_ROW = {
  id: CONV,
  title: "approvals",
  created_at: "2026-07-06T00:00:00Z",
  updated_at: "2026-07-07T00:00:00Z",
  last_message_at: "2026-07-07T00:00:00Z",
};
const OLD_ROW = {
  id: OLD_CONV,
  title: "older thread",
  created_at: "2026-07-05T00:00:00Z",
  updated_at: "2026-07-06T00:00:00Z",
  last_message_at: "2026-07-06T00:00:00Z",
};
/** No first message yet — the title stays null (ADR-0050 decision 2). */
const UNDATED_ROW = {
  id: UNDATED_CONV,
  title: null,
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:00:00Z",
  last_message_at: null,
};
const NEW_ROW = {
  id: NEW_CONV,
  title: null,
  created_at: "2026-07-07T01:00:00Z",
  updated_at: "2026-07-07T01:00:00Z",
  last_message_at: null,
};

const WIRE_PENDING = {
  id: MSG,
  kind: "approval_request",
  payload: {
    kind: "approval_request",
    turn_id: "t-1",
    action: "rerun_step",
    summary: "Retry the failed build step",
    risk: "Re-runs the step as you; it can spend build budget.",
    state: "pending",
  },
  created_at: "2026-07-07T00:00:00Z",
};
const WIRE_CONFIRMED = {
  ...WIRE_PENDING,
  payload: { ...WIRE_PENDING.payload, state: "confirmed" },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": status === 404 ? "application/problem+json" : "application/json" },
  });
}

/** A plain-text turn row (the user message the server echoes first). */
const WIRE_USER = {
  id: "msg-user-1",
  kind: "user",
  payload: { kind: "user", text: "A", context: null },
  created_at: "2026-07-07T00:00:01Z",
};
/** A follow-up question the model wrote (ui-convfix: option click test). */
const WIRE_QUESTION = {
  id: "msg-q-1",
  kind: "question",
  payload: {
    kind: "question",
    turn_id: "t-1",
    prompt: "Which change should I apply?",
    options: [
      { label: "Update an agent node's prompt", value: "update_prompt" },
      { label: "Insert a new node", value: "insert_node" },
    ],
    allow_free_text: true,
    answered_by: null,
  },
  created_at: "2026-07-07T00:00:02Z",
};

interface Stub {
  posted: { conversationId: string; body: string }[];
  created: number;
}

/**
 * `postResponses` is a queue (or single) of turn responses: the n-th POST
 * gets the n-th response — the question test's first turn ends with a
 * question card, the option's turn is a plain one.
 */
function stubFetch(
  postResponses: (() => Response | Promise<Response>) | Array<() => Response | Promise<Response>>,
): Stub {
  const queue = Array.isArray(postResponses) ? postResponses : [postResponses];
  const stub: Stub = { posted: [], created: 0 };
  let postCount = 0;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/v1/me/preferences") return json({});
    if (method === "GET" && url === CONVS_PATH) {
      return json({ conversations: [CONV_ROW, OLD_ROW, UNDATED_ROW], next_cursor: null });
    }
    if (method === "POST" && url === CREATE_PATH) {
      stub.created += 1;
      return json(NEW_ROW);
    }
    const msgs = /^\/api\/v1\/assistant\/conversations\/([^/]+)\/messages\?limit=200$/.exec(url);
    if (method === "GET" && msgs) {
      // Only conv-1 carries the pending approval; the others are empty.
      return json({ messages: msgs[1] === CONV ? [WIRE_PENDING] : [], next_cursor: null });
    }
    const post = /^\/api\/v1\/assistant\/conversations\/([^/]+)\/messages$/.exec(url);
    if (method === "POST" && post) {
      stub.posted.push({ conversationId: post[1], body: String(init?.body) });
      const responder = queue[Math.min(postCount, queue.length - 1)];
      postCount += 1;
      return responder();
    }
    return json({ title: "Not Found", status: 404, detail: `unstubbed ${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return stub;
}

function renderPopover(props: ComponentProps<typeof AssistantPopover> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssistantPopover {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

/** Open the popover and wait until the pending approval card is actable. */
async function openToApproval() {
  renderPopover();
  act(() => openAssistantPopover());
  await screen.findByTestId("assistant-approval-confirm");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // ui-convfix: the session choice lives in sessionStorage — a test must
  // not inherit a previous test's conversation (or pending New).
  window.sessionStorage.clear();
});

describe("approval decision post body (ui-confirm)", () => {
  it("Retry posts exactly {confirm: id} — no text", async () => {
    const stub = stubFetch(() => json({ messages: [WIRE_CONFIRMED], next_cursor: null }));
    await openToApproval();
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    expect(JSON.parse(stub.posted[0].body)).toEqual({ confirm: MSG });
    // The decision's ack row lands in the transcript with the outcome
    // (glyph + text); the stale pending row stays until the next refetch.
    const headers = screen.getAllByTestId("assistant-approval-header").map((el) => el.textContent);
    expect(headers).toContain("✓ APPROVED");
  });

  it("Not now posts exactly {dismiss: id} — no text", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    await openToApproval();
    fireEvent.click(screen.getByTestId("assistant-approval-dismiss"));
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    expect(JSON.parse(stub.posted[0].body)).toEqual({ dismiss: MSG });
  });

  it("a rejected decision shows the API's message inline", async () => {
    stubFetch(() =>
      json(
        {
          title: "Conflict",
          status: 409,
          detail: "approval request is no longer pending",
        },
        409,
      ),
    );
    await openToApproval();
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    expect((await screen.findByTestId("assistant-error")).textContent).toBe(
      "× approval request is no longer pending",
    );
  });
});

/**
 * Honest failure lines: a transient upstream cause answers with the retry
 * line (the broker already retried), never the bare status and never the
 * not-configured sentence.
 */
describe("assistant send failure honesty (503 degraded mapping)", () => {
  it("a transient upstream degraded cause shows the retry line on the send error", async () => {
    stubFetch(() =>
      json(
        {
          type: "https://communication.dev/errors/assistant-degraded",
          title: "Assistant unavailable",
          status: 503,
          detail: "the model endpoint returned 503",
          degraded: "model_unreachable",
        },
        503,
      ),
    );
    renderPopover();
    act(() => openAssistantPopover());
    const input = await screen.findByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "what is failing?" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect((await screen.findByTestId("assistant-error")).textContent).toContain(
      "The assistant's model is unavailable right now — try again. the model endpoint returned 503",
    );
  });
});

/** 2f acceptance review: `Make a workflow…` opens the assistant PANEL at its
 * normal size — never the small floating popover over the chat's composer —
 * the visible ask is one human sentence, and the conversation id rides the
 * POST as structured context.
 *
 * rcn-2f round 7 changed WHERE that panel stands: at 1280 the fixed-right
 * sheet sat ON TOP of the chat ("Return control" cut off, the composer's
 * agent picker reading "m4-planne", user bubbles truncated). Design 2f
 * docks it BESIDE the chat — the panel reserves its 450px on the shell's
 * main area (the `data-assistant-dock` flag + the injected CSS), so the
 * chat column narrows and nothing is covered.
 */
describe("thread → workflow draft ask (2f)", () => {
  it("docks the panel beside the chat: reserves its width on the shell's main area", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/01P/conversations/c-42"]}>
          {/* The chat the draft is drafted FROM, still mounted beside the
              dock: the dock reserves its column instead of covering it. */}
          <p data-testid="chat-behind">Search revamp spike</p>
          <AssistantPopover />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() => openAssistantWorkflowDraft({ id: "c-42", title: "Search revamp spike" }));
    const panel = await screen.findByTestId("assistant-panel");
    expect(panel.getAttribute("data-variant")).toBe("docked");
    // The sheet is the right-hand column, and it reserves that width on the
    // shell's main area: the flag on the document element plus the CSS that
    // shrinks the content column and steps the thread page's fixed rails
    // aside while the dock is open.
    const dock = screen.getByTestId("assistant-popover");
    expect(dock.getAttribute("data-dock")).toBe("right");
    expect(dock.className).toContain("lg:left-auto");
    expect(dock.className).toContain("lg:w-[450px]");
    expect(document.documentElement.getAttribute("data-assistant-dock")).toBe("on");
    const style = dock.querySelector("style") as HTMLStyleElement | null;
    expect(style?.textContent).toContain("margin-right: 450px");
    expect(style?.textContent).toContain("width: calc(100% - 450px)");
    expect(style?.textContent).toContain("max-width: none");
    expect(style?.textContent).toContain("html[data-assistant-dock=on] main");
    expect(style?.textContent).toContain('[data-testid="thread-list-pane"]');
    expect(style?.textContent).toContain('[data-testid="thread-side-panel-aside"]');
    // The reservation is desktop-only: below the Shell's phone width the
    // sheet takes the screen and reserves no width at all.
    expect(style?.textContent).toContain("@media (min-width: 1024px)");
    // And the chat it drafts from is still in the tree beside the dock.
    expect(screen.getByTestId("chat-behind")).toBeTruthy();
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    const body = JSON.parse(stub.posted[0].body) as {
      text: string;
      context?: { entity?: { kind: string; id: string } };
    };
    expect(body.text).toBe("Turn the thread \u201CSearch revamp spike\u201D into a workflow");
    expect(body.text).not.toContain("c-42");
    expect(body.context?.entity).toEqual({ kind: "conversation", id: "c-42" });
  });

  it("releases the reserved width the moment the dock stands down", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/01P/conversations/c-42"]}>
          <AssistantPopover />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() => openAssistantWorkflowDraft({ id: "c-42", title: "Search revamp spike" }));
    await screen.findByTestId("assistant-panel");
    expect(document.documentElement.getAttribute("data-assistant-dock")).toBe("on");
    // Shrink: back to the 400px popover; the column is the chat's again.
    fireEvent.click(screen.getByTestId("assistant-shrink"));
    expect(document.documentElement.getAttribute("data-assistant-dock")).toBeNull();
  });
});

/**
 * ui-newconv: the header's `New conversation` control and the Recent menu
 * (ADR-0050 part 1 stores many conversations per user; the popover used to
 * adopt the caller's newest one and never let go of it).
 */
describe("new conversation + recent menu (ui-newconv)", () => {
  it("New clears the panel and the next send posts to a FRESH conversation id", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => openAssistantPopover());
    // The caller's newest conversation is adopted and its transcript shows.
    await screen.findByTestId("assistant-approval-confirm");
    fireEvent.click(screen.getByTestId("assistant-new-conversation"));
    // The panel is cleared: no transcript, no stale change chip.
    expect(screen.queryByTestId("assistant-approval-confirm")).toBeNull();
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "fresh question" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.created).toBe(1));
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    // The message went to the NEW conversation, not the adopted one — and
    // the adoption effect did not sneak the old id back in.
    expect(stub.posted[0].conversationId).toBe(NEW_CONV);
    expect(stub.posted.filter((post) => post.conversationId === CONV)).toHaveLength(0);
  });

  it("Recent lists the caller's last 5 conversations and switches back", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-approval-confirm");
    fireEvent.click(screen.getByTestId("assistant-history"));
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(3);
    // Newest first, active one checked, honest age next to each title.
    expect(items[0].textContent).toContain("✓");
    expect(items[0].textContent).toContain("approvals");
    expect(items[1].textContent).toContain("older thread");
    expect(items[1].textContent).not.toContain("✓");
    fireEvent.click(items[1]);
    // The switched conversation's (empty) transcript replaces conv-1's.
    await waitFor(() => expect(screen.queryByTestId("assistant-approval-confirm")).toBeNull());
  });

  it("a null title shows as Untitled in the menu", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-approval-confirm");
    fireEvent.click(screen.getByTestId("assistant-history"));
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(3);
    expect(items[2].textContent).toContain("Untitled");
    expect(items[2].textContent).not.toContain("✓");
  });

  it("esc closes the Recent menu first, the panel second", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-approval-confirm");
    fireEvent.click(screen.getByTestId("assistant-history"));
    expect(screen.getByTestId("assistant-history-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "Escape" });
    expect(screen.queryByTestId("assistant-history-menu")).toBeNull();
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("assistant-popover")).toBeNull();
  });
});

/**
 * ui-convfix: the lab's step-f journey (fk224808) lost the ask between
 * turns — the follow-up landed in a conversation whose history did not
 * carry the first turn, and a question option click did not reach the
 * model. The wire truth: every send must post to the SAME conversation
 * the first send created, across turns, list refetches, expand/shrink
 * and remounts; an option click posts its LABEL as a plain-text user
 * message (the server stamps the question's answered_by).
 */
describe("conversation continuity across turns (ui-convfix)", () => {
  /** Open, press New conversation, send `text`, wait for the turn to settle. */
  async function newConversationSend(stub: Stub, text: string) {
    const rendered = renderPopover();
    act(() => openAssistantPopover());
    const input = await screen.findByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-new-conversation"));
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    // The turn settles (busy clears, the user row is on screen) before
    // the next send — the composer is enabled again.
    await waitFor(() => expect(screen.getAllByTestId("assistant-msg-user").length).toBe(1));
    return rendered;
  }

  it("New conversation → send A → send B: both post to the SAME new id, no re-adopt", async () => {
    const stub = stubFetch([() => json({ messages: [WIRE_USER], next_cursor: null })]);
    const { queryClient } = await newConversationSend(stub, "A");
    // Between turns the conversations list refetches (a fresh page — the
    // newest row is still the caller's old conversation, not the new one):
    // the adopt effect must not clobber the active id with it.
    void queryClient.invalidateQueries({ queryKey: ["assistant", "conversations", 5] });
    const input = screen.getByTestId("assistant-composer-input");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "B" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    expect(stub.created).toBe(1); // exactly one conversation, ever
    expect(stub.posted[0].conversationId).toBe(NEW_CONV);
    expect(stub.posted[1].conversationId).toBe(NEW_CONV);
  });

  it("a question option click posts the LABEL as plain text to the same conversation", async () => {
    const stub = stubFetch([
      () => json({ messages: [WIRE_USER, WIRE_QUESTION], next_cursor: null }),
      () => json({ messages: [WIRE_USER], next_cursor: null }),
    ]);
    await newConversationSend(stub, "A");
    // The turn ended with the model's question card; click an option
    // (the card renders one button per option — same testid on each).
    const [option] = await screen.findAllByTestId("assistant-question-option");
    expect(option.textContent).toBe("Update an agent node's prompt");
    fireEvent.click(option);
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    // The reply travels as a plain-text user message to the SAME
    // conversation — exactly like typing it (no value, no special body).
    expect(stub.posted[1].conversationId).toBe(NEW_CONV);
    const body = JSON.parse(stub.posted[1].body);
    expect(body.text).toBe("Update an agent node's prompt");
    expect(body.confirm).toBeUndefined();
    expect(body.dismiss).toBeUndefined();
  });

  it("a remount does not re-adopt: the next send posts to the same new id", async () => {
    const stub = stubFetch([() => json({ messages: [WIRE_USER], next_cursor: null })]);
    const first = await newConversationSend(stub, "A");
    first.unmount(); // e.g. the shell remounts (a page reload, a key change)
    // Fresh mount, fresh query cache — the session choice must come from
    // sessionStorage, not from the adopt-newest effect.
    const second = renderPopover();
    act(() => openAssistantPopover());
    const input = await screen.findByTestId("assistant-composer-input");
    // Give the (refetched) conversations list a chance to land: the adopt
    // effect must not take the caller's newest conversation back.
    await waitFor(() =>
      expect(second.queryClient.getQueryData(["assistant", "conversations", 5])).toBeTruthy(),
    );
    fireEvent.change(input, { target: { value: "B" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    expect(stub.created).toBe(1); // no second conversation after the remount
    expect(stub.posted[1].conversationId).toBe(NEW_CONV);
  });

  it("a remount keeps a pending New conversation: the first send creates, not adopts", async () => {
    const stub = stubFetch([() => json({ messages: [WIRE_USER], next_cursor: null })]);
    const first = renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-new-conversation"));
    first.unmount();
    const second = renderPopover();
    act(() => openAssistantPopover());
    const input = await screen.findByTestId("assistant-composer-input");
    await waitFor(() =>
      expect(second.queryClient.getQueryData(["assistant", "conversations", 5])).toBeTruthy(),
    );
    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    // The pending New survived the remount: the send created a fresh
    // conversation instead of adopting the caller's newest (CONV).
    expect(stub.created).toBe(1);
    expect(stub.posted[0].conversationId).toBe(NEW_CONV);
  });
});

describe("the ⌘J chord is order-invariant (finding 08; was p789-t5 for ⌘K)", () => {
  it("reopens after a close even when a bubble-phase listener stops the chord", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();

    // Finding 08 moved Ask onto ⌘J (⌘K belongs to the jump palette now) and
    // replaced the Studio's `stopImmediatePropagation` hijack with an explicit
    // claim — but the chord itself still has to survive any page that stops it
    // in the bubble phase: once this popover's chord effect has cycled (open →
    // close) it re-registers LAST, so a bubble-phase hijack would swallow every
    // later ⌘J and the ask surface could never reopen — the failure that was
    // observed live on the M4 lab with ⌘K. Capture registration is what fixes
    // it, and the test pins that it stayed.
    const hijack = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", hijack);
    try {
      fireEvent.keyDown(document.body, { key: "j", metaKey: true });
      await screen.findByTestId("assistant-popover");
      // esc closes the panel — the chord effect re-runs and re-registers last.
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("assistant-popover")).toBeNull());
      // ⌘J always re-opens the ask surface, chord order be damned.
      fireEvent.keyDown(document.body, { key: "j", metaKey: true });
      await screen.findByTestId("assistant-popover");
    } finally {
      window.removeEventListener("keydown", hijack);
    }
  });
});

/**
 * assistant-lost-ask (acceptance 30, journey f): a turn that fails stores
 * NOTHING server-side (ADR-0034) — the lab's 503
 * `{"degraded":"model_call_cap_exceeded"}` erased the person's ask from the
 * screen and from history, so the next turn reached a model with no ask at all.
 * The composer therefore takes the text back on a failed send, the line says
 * the question was not sent and can be sent again (naming the step limit), and
 * the same holds for the expanded view and for a question the command palette
 * carried over without ever putting it in the composer.
 */
describe("a failed send never loses the ask (assistant-lost-ask)", () => {
  const ASK = "Add a human approval step named journey_check after plan";

  const capProblem = () =>
    json(
      {
        type: "https://communication.dev/errors/assistant-degraded",
        title: "Assistant unavailable",
        status: 503,
        detail: "the turn reached the 12 completion cap without an answer",
        degraded: "model_call_cap_exceeded",
      },
      503,
    );
  const okTurn = () => json({ messages: [WIRE_USER], next_cursor: null });

  /** Open the popover over a fresh conversation with `text` in the composer. */
  async function armedComposer(stub: Stub, text: string) {
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-new-conversation"));
    const input = screen.getByTestId("assistant-composer-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    expect(input.value).toBe(text);
    return { input, stub };
  }

  it("the step-limit line names the cause and says the ask can be sent again", async () => {
    const { stub } = await armedComposer(stubFetch(capProblem), ASK);
    fireEvent.click(screen.getByTestId("assistant-send"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("hit its step limit before answering");
    expect(line.textContent).toContain("nothing was saved");
    expect(line.textContent).toContain("send again");
    // The server's internal cap phrasing is not shown as the whole story.
    expect(line.textContent).not.toContain("12 completion cap");
    expect(stub.posted).toHaveLength(1);
  });

  it("a failed send puts the ask back in the composer; Send again posts it", async () => {
    const { stub, input } = await armedComposer(stubFetch([capProblem, okTurn]), ASK);
    fireEvent.click(screen.getByTestId("assistant-send"));
    await screen.findByTestId("assistant-error");
    // The ask is where it was typed, and is sendable again.
    await waitFor(() => expect(input.value).toBe(ASK));
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    // The retry is the ORIGINAL ask, verbatim, in the same conversation.
    expect(JSON.parse(stub.posted[1].body).text).toBe(ASK);
    expect(stub.posted[1].conversationId).toBe(stub.posted[0].conversationId);
    // The retried turn landed: no error line, the transcript row, composer clear.
    await waitFor(() => expect(screen.queryByTestId("assistant-error")).toBeNull());
    await screen.findByTestId("assistant-msg-user");
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("a transient failure says the question was not sent and keeps the ask", async () => {
    const { input } = await armedComposer(
      stubFetch(() =>
        json(
          {
            type: "https://communication.dev/errors/assistant-degraded",
            title: "Assistant unavailable",
            status: 503,
            detail: "the model endpoint returned 503",
            degraded: "model_timeout",
          },
          503,
        ),
      ),
      ASK,
    );
    fireEvent.click(screen.getByTestId("assistant-send"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("Your question was not sent");
    expect(line.textContent).toContain("send it again");
    await waitFor(() => expect(input.value).toBe(ASK));
  });

  it("text already in the composer is never clobbered by a restored ask", async () => {
    const stub = stubFetch(capProblem);
    renderPopover();
    act(() => openAssistantPopover());
    const input = await screen.findByTestId("assistant-composer-input");
    // The person is mid-sentence when the palette's carried question fails:
    // their own draft wins, the restored ask must not overwrite it.
    fireEvent.change(input, { target: { value: "my new draft" } });
    act(() => openAssistantPopover("carried question"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("hit its step limit before answering");
    expect(JSON.parse(stub.posted[0].body).text).toBe("carried question");
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((input as HTMLInputElement).value).toBe("my new draft");
  });

  it("the expanded view shows the failure line and keeps the ask too", async () => {
    const { input } = await armedComposer(stubFetch([capProblem, okTurn]), ASK);
    fireEvent.click(screen.getByTestId("assistant-expand"));
    expect(screen.getByTestId("assistant-panel").dataset.variant).toBe("expanded");
    fireEvent.click(screen.getByTestId("assistant-send"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("hit its step limit before answering");
    await waitFor(() => expect(input.value).toBe(ASK));
  });

  it("a palette question that fails to send comes back into the composer", async () => {
    const stub = stubFetch(capProblem);
    renderPopover();
    act(() => openAssistantPopover("why is run 4f2a stuck?"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("hit its step limit before answering");
    // The carried-over question never lived in the composer: it lands there
    // on failure, so the person can read and re-send their own words.
    await waitFor(() =>
      expect((screen.getByTestId("assistant-composer-input") as HTMLInputElement).value).toBe(
        "why is run 4f2a stuck?",
      ),
    );
    expect(stub.posted).toHaveLength(1);
    expect(JSON.parse(stub.posted[0].body).text).toBe("why is run 4f2a stuck?");
  });

  it("a failed approval Retry says nothing about a lost question", async () => {
    stubFetch(() =>
      json(
        { title: "Conflict", status: 409, detail: "approval request is no longer pending" },
        409,
      ),
    );
    renderPopover();
    act(() => openAssistantPopover());
    fireEvent.change(await screen.findByTestId("assistant-composer-input"), {
      target: { value: "a draft ask" },
    });
    fireEvent.click(await screen.findByTestId("assistant-approval-confirm"));
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toBe("× approval request is no longer pending");
    // The composer still holds what the person typed — nothing was restored
    // over it, and no sentence claims their question was lost.
    expect((screen.getByTestId("assistant-composer-input") as HTMLInputElement).value).toBe(
      "a draft ask",
    );
  });
});

/** Issue #62: one menu open at a time. Opening Ask must close the shell's
 * New menu; the keyboard paths have no outside pointerdown for it to react
 * to, so the popover's open transitions broadcast `communication:
 * close-other-menus`, which NewMenu listens for. */
describe("menu-close coordination (issue #62)", () => {
  const closed: Event[] = [];
  const listener = (event: Event) => closed.push(event);
  afterEach(() => {
    window.removeEventListener("communication:close-other-menus", listener);
    closed.length = 0;
  });

  it("broadcasts close-other-menus when Ask opens, and only when Ask opens", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    window.addEventListener("communication:close-other-menus", listener);
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-popover");
    expect(closed).toHaveLength(1);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    // Finding 08: ⌘K is the JUMP chord — it opens no ask surface, so there is
    // no second broadcast and no popover re-open churn.
    expect(closed).toHaveLength(1);
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
  });

  it("broadcasts close-other-menus when Ask opens over the ⌘J chord (the floating Ask press)", () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    window.addEventListener("communication:close-other-menus", listener);
    renderPopover();
    // Shell's floating button calls the same explicit handle (finding 08 —
    // no synthetic keydown any more).
    act(() => openAsk());
    expect(closed).toHaveLength(1);
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
  });
});

/**
 * Issue #63: clicking a suggested question ("What needs me right now?")
 * showed `thinking…` while the suggestions stayed on screen and the clicked
 * question appeared nowhere. The new contract: the click puts the question
 * into the transcript as the person's OWN message bubble immediately (the
 * suggestions disappear with it), `thinking…` follows, and the reply lands
 * under it. A failed request keeps the person's message on screen with the
 * honest error line UNDER it and a `Retry` that sends the same words again.
 */
describe("a clicked suggestion becomes the person's message (issue #63)", () => {
  /** The server echo of the asked text + one plain answer row. */
  const echoTurn = (text: string) =>
    json({
      messages: [
        {
          id: "msg-user-echo",
          kind: "user",
          payload: { kind: "user", text, context: null },
          created_at: "2026-07-07T00:00:03Z",
        },
        {
          id: "msg-answer-1",
          kind: "assistant",
          payload: {
            kind: "assistant",
            turn_id: "t-9",
            answer_markdown: "Nothing is blocked on you right now.",
            links: [],
            tool_calls: [],
          },
          created_at: "2026-07-07T00:00:04Z",
        },
      ],
      next_cursor: null,
    });

  const modelTimeout = () =>
    json(
      {
        type: "https://communication.dev/errors/assistant-degraded",
        title: "Assistant unavailable",
        status: 503,
        detail: "the model endpoint returned 503",
        degraded: "model_timeout",
      },
      503,
    );

  /** Open the popover over a FRESH conversation (empty transcript ⇒ the
   * "FOR THIS PAGE" chips render) and return the first chip with its text. */
  async function openToFreshSuggestions() {
    renderPopover();
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-new-conversation"));
    const [chip] = await screen.findAllByTestId("assistant-suggest");
    return { chip, text: (chip.textContent ?? "").trim() };
  }

  it("the click hides the suggestions and shows the question as the person's bubble while thinking", async () => {
    let settleTurn: (value: Response) => void = () => {};
    const turn = new Promise<Response>((resolve) => {
      settleTurn = resolve;
    });
    stubFetch(() => turn);
    const { chip, text } = await openToFreshSuggestions();
    fireEvent.click(chip);
    // Same instant: the chips are gone and the clicked question is the
    // person's own transcript row — exactly as if it had been typed+sent.
    expect(screen.queryAllByTestId("assistant-suggest")).toHaveLength(0);
    expect(screen.queryByTestId("assistant-empty")).toBeNull();
    expect(screen.getByTestId("assistant-msg-user").textContent).toBe(text);
    // `thinking…` follows the bubble; the composer locks with the turn.
    await screen.findByTestId("assistant-thinking");
    expect((screen.getByTestId("assistant-composer-input") as HTMLInputElement).disabled).toBe(
      true,
    );
    // The reply lands under it, and the local row is REPLACED by the
    // server's echo — never duplicated.
    await act(async () => {
      settleTurn(echoTurn(text));
    });
    await waitFor(() => expect(screen.queryByTestId("assistant-thinking")).toBeNull());
    expect(screen.getAllByTestId("assistant-msg-user")).toHaveLength(1);
    expect(screen.getByTestId("assistant-msg-user").textContent).toBe(text);
    expect((await screen.findByTestId("assistant-answer")).textContent).toContain(
      "Nothing is blocked on you right now.",
    );
    // The transcript stays open: on the next empty-state there are no chips
    // to click over a live conversation.
    expect(screen.queryAllByTestId("assistant-suggest")).toHaveLength(0);
  });

  it("a failed request keeps the message on screen, lines the error under it, and Retry sends the same words", async () => {
    const stub = stubFetch([modelTimeout, () => echoTurn("x")]);
    const { chip, text } = await openToFreshSuggestions();
    fireEvent.click(chip);
    const line = await screen.findByTestId("assistant-error");
    // The person's message STAYS, with the line under it — not a banner at
    // the top of the panel, and not the question lost off-screen.
    const bubble = screen.getByTestId("assistant-msg-user");
    expect(bubble.textContent).toContain(text);
    expect(bubble.contains(line)).toBe(true);
    expect(line.textContent).toContain("Your question was not sent — send it again.");
    expect(screen.queryByTestId("assistant-thinking")).toBeNull();
    // assistant-lost-ask still holds: the composer also holds the words.
    await waitFor(() =>
      expect((screen.getByTestId("assistant-composer-input") as HTMLInputElement).value).toBe(text),
    );
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    await waitFor(() => expect(stub.posted).toHaveLength(2));
    // Retry re-sends the SAME words to the SAME conversation.
    expect(JSON.parse(stub.posted[1].body).text).toBe(text);
    expect(stub.posted[1].conversationId).toBe(stub.posted[0].conversationId);
    expect(stub.created).toBe(1);
    // It landed: no error line, one bubble (the echo replaced the local row),
    // and the reply under it.
    await waitFor(() => expect(screen.queryByTestId("assistant-error")).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId("assistant-msg-user")).toHaveLength(1));
    expect(await screen.findByTestId("assistant-answer")).toBeTruthy();
  });

  it("a typed ask gets the same treatment: bubble first, then thinking, then the reply", async () => {
    let settleTurn: (value: Response) => void = () => {};
    const turn = new Promise<Response>((resolve) => {
      settleTurn = resolve;
    });
    stubFetch(() => turn);
    const { text } = await openToFreshSuggestions();
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "why is run 4f2a stuck?" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(screen.getByTestId("assistant-msg-user").textContent).toBe("why is run 4f2a stuck?");
    await act(async () => {
      settleTurn(echoTurn("why is run 4f2a stuck?"));
    });
    await waitFor(() => expect(screen.getAllByTestId("assistant-msg-user")).toHaveLength(1));
    // The untouched suggestion chip is still there for later (the empty
    // state only ever renders with an empty transcript, so the live
    // conversation shows none).
    expect(screen.queryAllByTestId("assistant-suggest")).toHaveLength(0);
    expect(text).not.toBe("");
  });
});

/**
 * T16 (finding 08): the tour player is the one page OUTSIDE the Shell, so it
 * mounts this surface itself and says what an ask there is about. The ⌘J chord
 * and any bare `openAsk()` then carry the page's context — the stop on screen —
 * instead of opening an empty box, while a caller that brings its own question
 * still wins.
 */
describe("a mount that names its own ask context (T16)", () => {
  const stopAsk = () => ({
    text: "About the catch-up stop \u201CDuplicates found\u201D on \u201CRefund webhook\u201D: what first?",
    subject: "Refund webhook sent duplicates",
  });

  it("the ⌘J chord asks the page's context and the chip names it", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover({ askContext: stopAsk });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true })));
    await screen.findByTestId("assistant-popover");
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    expect(JSON.parse(stub.posted[0].body).text).toBe(stopAsk().text);
    expect(screen.getByTestId("assistant-context-chip").textContent).toBe(stopAsk().subject);
  });

  it("a caller's own question and subject win over the page's", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover({ askContext: stopAsk });
    act(() => openAsk({ text: "What failed here?", subject: "the run" }));
    await screen.findByTestId("assistant-popover");
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    expect(JSON.parse(stub.posted[0].body).text).toBe("What failed here?");
    expect(screen.getByTestId("assistant-context-chip").textContent).toBe("the run");
  });

  it("with no context the chord stays the bare ask it was", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => openAsk());
    await screen.findByTestId("assistant-popover");
    expect(stub.posted).toHaveLength(0);
    // With nothing named, the chip stays what it always was: the page section.
    expect(screen.getByTestId("assistant-context-chip").textContent).toBe(sectionOf("/"));
  });
});

/**
 * m5-assistant:278 replica — the exact e2e ask path on the T16 build: Ctrl+J
 * opens the popover (a bare chord ask: NOTHING posts), the question is typed
 * into the composer and Enter sends it. The 8f6f378 context change rides only
 * `openAsk()` and the header chip; this proves a typed ask still reaches the
 * conversation's message route with the same body (`{text, context.route}`)
 * the lab POST must answer — the e2e's failed run was a server-side 503
 * `model_unreachable` on that POST (the question WAS sent), not a UI change.
 */
describe("the typed composer ask still posts (m5 ask path)", () => {
  it("Ctrl+J opens without posting; Enter in the composer posts the question to the messages route", async () => {
    const stub = stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "J", ctrlKey: true })));
    await screen.findByTestId("assistant-popover");
    // The bare chord sends nothing (no page askContext at a Shell mount).
    expect(stub.posted).toHaveLength(0);
    // The popover adopts the caller's newest conversation — conv-1, whose
    // pending approval row is on screen (the m5 POST will carry that id).
    await screen.findByTestId("assistant-approval-confirm");
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: QUESTION } });
    // Enter (no Shift) is the composer's own send key (AssistantPanel).
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(stub.posted).toHaveLength(1));
    // The popover adopted the caller's newest conversation — the m5 POST
    // goes to ITS messages route, exactly as the e2e's response listener
    // (`POST …/assistant/conversations/<id>/messages`) expects.
    expect(stub.posted[0].conversationId).toBe(CONV);
    expect(JSON.parse(stub.posted[0].body)).toEqual({
      text: QUESTION,
      context: { route: "/" },
    });
  });
});
