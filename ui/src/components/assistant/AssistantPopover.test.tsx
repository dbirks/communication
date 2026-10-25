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
import AssistantPopover, { openAssistantPopover } from "./AssistantPopover";

const CONV = "conv-1";
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
function stubFetch(postResponses: (() => Response) | (() => Response)[]): Stub {
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

function renderPopover() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssistantPopover />
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

describe("the ⌘K chord survives the studio footer hijack (p789-t5)", () => {
  it("reopens after a close even when a bubble-phase listener stops the chord", async () => {
    stubFetch(() => json({ messages: [], next_cursor: null }));
    renderPopover();

    // The Studio draft footer (AssistantProposalBox, design 1g) answers ⌘K
    // with stopImmediatePropagation(). Once the popover's chord effect has
    // cycled (open → close), its reopened listener is registered LAST, so a
    // bubble-phase hijack would swallow every later ⌘K and the ask surface
    // could never reopen on the draft page — observed live on the M4 lab.
    const hijack = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", hijack);
    try {
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      await screen.findByTestId("assistant-popover");
      // esc closes the panel — the chord effect re-runs and re-registers last.
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("assistant-popover")).toBeNull());
      // ADR-0050: ⌘K always re-opens the ask surface, chord order be damned.
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      await screen.findByTestId("assistant-popover");
    } finally {
      window.removeEventListener("keydown", hijack);
    }
  });
});
