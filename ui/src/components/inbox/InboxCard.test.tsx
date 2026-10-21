/**
 * The phone inbox card (2f → 3f): the model writes the labels, the risk
 * writes the style, and a confirm step stands between the tap and the
 * decision. The contract under test is behavioral:
 * - `onDecide` fires only after the human confirms (never on the tap);
 * - Escape closes the confirm step without deciding;
 * - no model summary/actions → the static Approve / Read fallback;
 * - the two-line summary clamps, "More" expands it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const MODEL_ACTIONS = [
  { label: "Approve plan", intent: "approve", risk: "proceed" },
  { label: "Reject and stop the run", intent: "reject", risk: "destructive" },
] as const;

function textOf(element: Element): string {
  return element.textContent ?? "";
}

afterEach(cleanup);

describe("InboxCard", () => {
  it("renders chip, project, age, title and the clamped summary", () => {
    render(<InboxCard {...BASE} onDecide={vi.fn()} />);
    expect(screen.getByTestId(`inbox-card-${T}`)).toBeTruthy();
    expect(screen.getByText("acme-api")).toBeTruthy();
    expect(textOf(screen.getByTestId(`inbox-card-title-${T}`))).toContain(BASE.title);
    const more = screen.getByTestId(`inbox-card-more-${T}`);
    expect(textOf(more)).toBe("More");
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the summary on More", () => {
    render(<InboxCard {...BASE} onDecide={vi.fn()} />);
    const more = screen.getByTestId(`inbox-card-more-${T}`);
    fireEvent.click(more);
    expect(textOf(more)).toBe("Less");
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("falls back to Approve and Read when the model gives nothing", () => {
    const onOpen = vi.fn();
    const decide = vi.fn();
    render(<InboxCard {...BASE} summary={undefined} onDecide={decide} onOpen={onOpen} />);
    expect(screen.queryByTestId(`inbox-card-more-${T}`)).toBeNull();
    const read = screen.getByTestId(`inbox-card-read-${T}`);
    expect(textOf(read)).toBe("Read");
    const approve = screen.getByTestId(`inbox-card-action-${T}-0`);
    expect(textOf(approve)).toBe("Approve");
    expect(screen.queryByTestId(`inbox-card-action-${T}-1`)).toBeNull();

    // "Read" is a link, not a decision: it opens the detail and decides nothing.
    fireEvent.click(screen.getByTestId(`inbox-card-read-${T}`));
    expect(onOpen).toHaveBeenCalledWith(ID);
    expect(decide).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
  });

  it("colors the model's actions by risk", () => {
    render(<InboxCard {...BASE} actions={[...MODEL_ACTIONS]} onDecide={vi.fn()} />);
    const approve = screen.getByTestId(`inbox-card-action-${T}-0`);
    const reject = screen.getByTestId(`inbox-card-action-${T}-1`);
    expect(textOf(approve)).toBe("Approve plan");
    expect(textOf(reject)).toBe("Reject and stop the run");
    expect(approve.className).toContain("ds-btn--primary");
    expect(reject.className).toContain("ds-btn--danger");
  });

  it("does not decide on the tap: the confirm step opens instead", () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} actions={[...MODEL_ACTIONS]} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(`inbox-card-action-${T}-0`));

    expect(onDecide).not.toHaveBeenCalled();
    const confirm = screen.getByTestId(`inbox-card-confirm-${T}`);
    expect(textOf(confirm)).toContain("Approve plan");
    expect(textOf(confirm)).toContain("approved");
  });

  it("Escape closes the confirm step without deciding", () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} actions={[...MODEL_ACTIONS]} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(`inbox-card-action-${T}-0`));
    expect(screen.getByTestId(`inbox-card-confirm-${T}`)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("records the mapped wire decision only after the human confirms", () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} actions={[...MODEL_ACTIONS]} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(`inbox-card-action-${T}-1`));
    expect(textOf(screen.getByTestId(`inbox-card-confirm-${T}`))).toContain("rejected");

    fireEvent.click(screen.getByTestId(`inbox-card-confirm-go-${T}`));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(ID, "rejected");
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
  });

  it("cancels the confirm step", () => {
    const onDecide = vi.fn();
    render(<InboxCard {...BASE} actions={[...MODEL_ACTIONS]} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(`inbox-card-action-${T}-0`));
    fireEvent.click(screen.getByTestId(`inbox-card-confirm-cancel-${T}`));
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("offers the decision when the action's intent is not a decision word", () => {
    const onDecide = vi.fn();
    render(
      <InboxCard
        {...BASE}
        actions={[{ label: "Inspect the plan", intent: "other", risk: "other" }]}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByTestId(`inbox-card-action-${T}-0`));
    const confirm = screen.getByTestId(`inbox-card-confirm-${T}`);
    expect(textOf(confirm)).toContain("not a decision word");
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`inbox-card-confirm-rejected-${T}`));
    expect(onDecide).toHaveBeenCalledWith(ID, "rejected");
    expect(screen.queryByTestId(`inbox-card-confirm-${T}`)).toBeNull();
  });
});
