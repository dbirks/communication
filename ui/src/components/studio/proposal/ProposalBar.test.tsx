import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProposalBar } from "./ProposalBar";

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof ProposalBar>[0]> = {}) {
  const props = {
    request: "Add a test step after Write the fix",
    changeCount: 2,
    onReview: vi.fn(),
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
  render(<ProposalBar {...props} />);
  return props;
}

it("renders the floating bar with its region label", () => {
  renderBar();
  const bar = screen.getByTestId("proposal-bar");
  expect(bar.getAttribute("role")).toBe("region");
  expect(bar.getAttribute("aria-label")).toBe("Assistant proposal");
  // Floating top-centre below the editor toolbar row, 600px wide, pop float style (README 1d).
  expect(bar.className).toContain("absolute");
  expect(bar.className).toContain("left-1/2");
  expect(bar.className).toContain("top-[64px]");
  expect(bar.className).toContain("-translate-x-1/2");
  expect(bar.className).toContain("w-[600px]");
  expect(bar.className).toContain("max-w-[calc(100%-32px)]");
  expect(bar.className).toContain("px-[14px]");
  expect(bar.className).toContain("py-[12px]");
  expect(bar.className).toContain("gap-3");
  expect(bar.className).toContain("border-fill-edge");
  expect(bar.className).toContain("rounded-[12px]");
  expect(bar.className).toContain("shadow-[var(--shadow-pop)]");
});

it("shows the request in one truncated line", () => {
  renderBar({ request: "Add a test step after Write the fix" });
  const request = screen.getByTestId("proposal-bar-request");
  expect(request.textContent).toBe("Add a test step after Write the fix");
  expect(request.className).toContain("text-[13.5px]");
  expect(request.className).toContain("font-semibold");
  expect(request.className).toContain("truncate");
});

it("wraps the request to two lines and fills the width when narrow", () => {
  renderBar({ narrow: true });
  const bar = screen.getByTestId("proposal-bar");
  expect(bar.className).toContain("w-[calc(100%-32px)]");
  expect(bar.className).not.toContain("w-[600px]");
  expect(screen.getByTestId("proposal-bar-request").className).toContain("line-clamp-2");
});

it("wording: singular for one change", () => {
  renderBar({ changeCount: 1 });
  expect(screen.getByTestId("proposal-bar").textContent).toContain(
    "from ⌘K · 1 change · nothing saved yet ·",
  );
});

it("wording: plural for three changes", () => {
  renderBar({ changeCount: 3 });
  expect(screen.getByTestId("proposal-bar").textContent).toContain(
    "from ⌘K · 3 changes · nothing saved yet ·",
  );
});

it("the Review link calls onReview", () => {
  const { onReview } = renderBar();
  const review = screen.getByTestId("proposal-bar-review");
  expect(review.textContent).toBe("Review");
  expect(review.className).toContain("text-accent-text");
  expect(review.className).toContain("underline");
  fireEvent.click(review);
  expect(onReview).toHaveBeenCalledTimes(1);
});

it("the Review link reads Hide review while the review panel is open", () => {
  const { onReview } = renderBar({ reviewOpen: true });
  const review = screen.getByTestId("proposal-bar-review");
  expect(review.textContent).toBe("Hide review");
  fireEvent.click(review);
  expect(onReview).toHaveBeenCalledTimes(1);
});

it("Apply and Discard call their handlers", () => {
  const { onApply, onDiscard } = renderBar();
  const apply = screen.getByTestId("proposal-bar-apply");
  const discard = screen.getByTestId("proposal-bar-discard");
  expect(apply.className).toContain("ds-btn--primary");
  expect(apply.className).toContain("max-md:min-h-[44px]");
  expect(discard.className).toContain("ds-btn--secondary-plain");
  expect(discard.className).toContain("max-md:min-h-[44px]");
  fireEvent.click(apply);
  fireEvent.click(discard);
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onDiscard).toHaveBeenCalledTimes(1);
});

it("pending hides Apply and shows working on it", () => {
  renderBar({ pending: true, changeCount: 0 });
  expect(screen.queryByTestId("proposal-bar-apply")).toBeNull();
  expect(screen.queryByTestId("proposal-bar-review")).toBeNull();
  const bar = screen.getByTestId("proposal-bar");
  expect(bar.textContent).toContain("from ⌘K · working on it…");
  expect(bar.textContent).not.toContain("nothing saved yet");
  // Discard is still available to bail out.
  expect(screen.getByTestId("proposal-bar-discard")).toBeTruthy();
});

it("error shows the message and hides Apply and Review", () => {
  renderBar({ error: "The assistant could not read the draft" });
  const bar = screen.getByTestId("proposal-bar");
  expect(bar.textContent).toContain("The assistant could not read the draft");
  expect(bar.textContent).not.toContain("nothing saved yet");
  expect(screen.queryByTestId("proposal-bar-apply")).toBeNull();
  expect(screen.queryByTestId("proposal-bar-review")).toBeNull();
  expect(screen.getByTestId("proposal-bar-discard")).toBeTruthy();
});

it("the error text uses the failed colour", () => {
  renderBar({ error: "No model available" });
  const bar = screen.getByTestId("proposal-bar");
  const failed = bar.querySelector(".text-st-failed-tag-fg");
  expect(failed?.textContent).toBe("No model available");
});

it("applying disables both buttons and reads Applying…", () => {
  const { onApply, onDiscard } = renderBar({ applying: true });
  const apply = screen.getByTestId("proposal-bar-apply") as HTMLButtonElement;
  const discard = screen.getByTestId("proposal-bar-discard") as HTMLButtonElement;
  expect(apply.textContent).toBe("Applying…");
  expect(apply.disabled).toBe(true);
  expect(discard.disabled).toBe(true);
  fireEvent.click(apply);
  fireEvent.click(discard);
  expect(onApply).not.toHaveBeenCalled();
  expect(onDiscard).not.toHaveBeenCalled();
});
