/**
 * A stop's decision (design 8b, ADR-0078 § Decision 4) over the mocked
 * reply route: options post as the model's own labels, the free-text box
 * only exists when the model offered one, and every state says what
 * actually happened — sent, busy (409, retryable), or stored with nowhere to
 * go. This is not the workflow gate: nothing here renders decide verbs.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "../../api/client";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import { StopDecision } from "./StopDecision";

const itemId = "01987a90-0000-7000-8000-222222222222";
const stopId = "s3";
const replyPath = `/api/v1/catch-up/items/${itemId}/stops/${stopId}/reply`;

const decision = {
  prompt: "24h grace: your call",
  options: ["Keep 24h", "Change to 12h"],
  allow_text: true,
};

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

function mount(routes: RouteStub[], dec = decision) {
  setCsrfToken("test-csrf");
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <Wrapper>
      <StopDecision itemId={itemId} stopId={stopId} decision={dec} />
    </Wrapper>,
  );
  return { requests };
}

const sent = { reply_id: "r1", conversation_id: "c1", turn_id: "t1" };

describe("StopDecision", () => {
  it("posts the chosen option as plain text and confirms the send with the time", async () => {
    const { requests } = mount([{ path: replyPath, method: "POST", status: 202, body: sent }]);
    expect(screen.getByTestId("catchup-decision").textContent).toContain("24h grace: your call");
    fireEvent.click(screen.getByTestId("catchup-decision-option-1"));
    await waitFor(() =>
      expect(requestsTo(requests, replyPath, "POST").at(-1)?.body).toContain("Keep 24h"),
    );
    const status = await screen.findByTestId("catchup-decision-status");
    await waitFor(() => expect(status.textContent).toContain("Sent to the agent: “Keep 24h”"));
    expect(status.textContent).toMatch(/· \d{2}:\d{2}/);
    expect(screen.getByTestId("catchup-decision-option-1").hasAttribute("disabled")).toBe(true);
  });

  it("the free-text box only exists when the model offers it, and its answer posts verbatim", async () => {
    const { requests } = mount([{ path: replyPath, method: "POST", status: 202, body: sent }]);
    const box = screen.getByTestId("catchup-decision-text");
    fireEvent.change(box, { target: { value: "Go to 6h instead" } });
    fireEvent.click(screen.getByTestId("catchup-decision-send"));
    await waitFor(() =>
      expect(requestsTo(requests, replyPath, "POST").at(-1)?.body).toContain("Go to 6h instead"),
    );
    await screen.findByText(/Sent to the agent: “Go to 6h instead”/);
    cleanup();

    mount(
      [
        {
          path: `/api/v1/catch-up/items/${itemId}/stops/other/reply`,
          method: "POST",
          status: 202,
          body: sent,
        },
      ],
      { prompt: "Pick one", options: ["Yes", "No"], allow_text: false },
    );
    expect(screen.queryByTestId("catchup-decision-text")).toBeNull();
  });

  it("a busy agent (409) says the answer wasn't sent and Retry posts it again", async () => {
    const { requests } = mount([
      {
        path: replyPath,
        method: "POST",
        status: 409,
        body: { type: "about:blank", title: "Busy", status: 409, detail: "turn in progress" },
      },
    ]);
    fireEvent.click(screen.getByTestId("catchup-decision-option-2"));
    const status = await screen.findByTestId("catchup-decision-status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        "The agent is busy right now. Your answer wasn't sent — try again in a moment.",
      ),
    );
    fireEvent.click(screen.getByTestId("catchup-decision-retry"));
    await waitFor(() => expect(requestsTo(requests, replyPath, "POST")).toHaveLength(2));
    expect(requestsTo(requests, replyPath, "POST")[1]?.body).toContain("Change to 12h");
  });

  it("a work item with no conversation is the honest dead end: saved, nobody notified", async () => {
    mount([
      {
        path: replyPath,
        method: "POST",
        status: 202,
        body: { reply_id: "r1", conversation_id: null, turn_id: null },
      },
    ]);
    fireEvent.click(screen.getByTestId("catchup-decision-option-1"));
    const status = await screen.findByTestId("catchup-decision-status");
    await waitFor(() =>
      expect(status.textContent).toContain(
        "Saved. This work has no agent session to answer, so nobody was notified.",
      ),
    );
    expect(status.textContent).not.toContain("Sent to the agent");
  });
});
