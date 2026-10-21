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
const CONVS_PATH = "/api/v1/assistant/conversations?limit=1";
const MESSAGES_PATH = `/api/v1/assistant/conversations/${CONV}/messages`;
const MSG = "msg-1";

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
  posted: { body: string }[];
}

function stubFetch(postResponse: () => Response): Stub {
  const stub: Stub = { posted: [] };
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/v1/me/preferences") return json({});
    if (method === "GET" && url === CONVS_PATH) {
      return json({
        conversations: [
          {
            id: CONV,
            title: "approvals",
            created_at: "2026-07-07T00:00:00Z",
            updated_at: "2026-07-07T00:00:00Z",
            last_message_at: "2026-07-07T00:00:00Z",
          },
        ],
        next_cursor: null,
      });
    }
    if (method === "GET" && url === `${MESSAGES_PATH}?limit=200`) {
      return json({ messages: [WIRE_PENDING], next_cursor: null });
    }
    if (method === "POST" && url === MESSAGES_PATH) {
      stub.posted.push({ body: String(init?.body) });
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
