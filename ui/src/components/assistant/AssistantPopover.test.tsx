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

interface Stub {
  posted: { conversationId: string; body: string }[];
  created: number;
}

function stubFetch(postResponse: () => Response): Stub {
  const stub: Stub = { posted: [], created: 0 };
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
      return postResponse();
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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssistantPopover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
