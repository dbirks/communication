/**
 * The phone inbox card (finding 04 rewrite): chip, project, age, title, the
 * clamped summary with "More", and the shared `DecisionBar` — fixed verbs
 * (Approve / Request changes / Reject) behind a 5s undo hold. The card stays
 * presentational: the bar's POST is injected and reaches the parent through
 * `onDecide(id, decision, comments?)`. Model-written labels no longer exist
 * on this card (the `actions` prop is ignored); there is no confirm step and
 * no "is not a decision word" path to test any more.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { testidOf } from "../../lib/format";
import InboxCard from "./InboxCard";

const ID = "01987b26-0000-7000-8000-abcdef012345";
const T = testidOf(ID);

const BASE = {
  kind: "approval" as const,
  id: ID,
  projectName: "acme-api",
  createdAt: "2026-07-31T10:44:02Z",
  title: "Rate limiter for /v2/search",
  summary:
    "Plans a per-key limiter backed by Redis: 60 requests a minute, burst 20. Adds one dependency and touches 3 files.",
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function textOf(element: Element): string {
  return element.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InboxCard", () => {
  it("renders chip, project, age, title and the clamped summary", () => {
    render(<InboxCard {...BASE} onDecide={vi.fn()} />, { wrapper: wrapper() });
    expect(screen.getByTestId(`inbox-card-${T}`)).toBeTruthy();
    expect(screen.getByText("acme-api")).toBeTruthy();
    expect(textOf(screen.getByTestId(`inbox-card-title-${T}`))).toContain(BASE.title);
    const more = screen.getByTestId(`inbox-card-more-${T}`);
    expect(textOf(more)).toBe("More");
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the summary on More", () => {
    render(<InboxCard {...BASE} onDecide={vi.fn()} />, { wrapper: wrapper() });
    const more = screen.getByTestId(`inbox-card-more-${T}`);
    fireEvent.click(more);
    expect(textOf(more)).toBe("Less");
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders the fixed verbs and ignores model-written labels", () => {
    const onDecide = vi.fn();
    render(
      <InboxCard
        {...BASE}
        actions={[{ label: "Ship it", intent: "other", risk: "proceed" }]}
        onDecide={onDecide}
      />,
      { wrapper: wrapper() },
    );
    expect(textOf(screen.getByTestId("decision-approve"))).toBe("Approve");
    expect(textOf(screen.getByTestId("decision-request-changes"))).toBe("Request changes");
    expect(textOf(screen.getByTestId("decision-reject"))).toBe("Reject");
    expect(screen.queryByText("Ship it")).toBeNull();
    expect(screen.queryByTestId(`inbox-card-action-${T}-0`)).toBeNull();
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
  });

  it("the Read button opens the detail and decides nothing", () => {
    const onOpen = vi.fn();
    const decide = vi.fn();
    render(<InboxCard {...BASE} summary={undefined} onDecide={decide} onOpen={onOpen} />, {
      wrapper: wrapper(),
    });
    expect(screen.queryByTestId(`inbox-card-more-${T}`)).toBeNull();
    expect(textOf(screen.getByTestId(`inbox-card-read-${T}`))).toBe("Read");
    fireEvent.click(screen.getByTestId(`inbox-card-read-${T}`));
    expect(onOpen).toHaveBeenCalledWith(ID);
    expect(decide).not.toHaveBeenCalled();
  });

  it("Approve holds the undo window; only the expired hold reaches the parent", async () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} onDecide={onDecide} />, { wrapper: wrapper() });

    fireEvent.click(screen.getByTestId("decision-approve"));
    expect(textOf(screen.getByTestId("decision-status"))).toContain(
      "Approved. The run continues in 5s.",
    );
    expect(onDecide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(ID, "approved", undefined);
  });

  it("Undo sends nothing and restores the bar", async () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} onDecide={onDecide} />, { wrapper: wrapper() });

    fireEvent.click(screen.getByTestId("decision-reject"));
    fireEvent.click(screen.getByTestId("decision-undo"));
    expect(screen.getByTestId("decision-reject")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30000);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("Request changes needs text and arrives as rejected with the note", async () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} onDecide={onDecide} />, { wrapper: wrapper() });

    fireEvent.click(screen.getByTestId("decision-request-changes"));
    expect((screen.getByTestId("decision-changes-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("decision-changes-text"), {
      target: { value: "Name the flag after the RFC." },
    });
    fireEvent.click(screen.getByTestId("decision-changes-send"));
    expect(onDecide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(onDecide).toHaveBeenCalledWith(ID, "rejected", "Name the flag after the RFC.");
  });
});
