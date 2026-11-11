/**
 * The headline block's three states (ADR-0081 § The model's job): the text and
 * the per-project list when the model answered, a skeleton and the words
 * `writing headline…` while it has not, and NOTHING when this deployment has no
 * model at all — the sections are the answer either way, and a placeholder box
 * would tell the reader a headline exists and is empty.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BriefHeadline } from "./BriefHeadline";
import { fullBrief, pendingBrief } from "./briefFixtures";

afterEach(cleanup);

describe("BriefHeadline", () => {
  it("draws the ready text and the per-project list under it", () => {
    render(<BriefHeadline headline={fullBrief.headline} byProject={fullBrief.by_project} />);
    const block = screen.getByTestId("catchup-brief-headline");
    expect(block.textContent).toContain(fullBrief.headline.text);
    // 15px text-ink at a 22px leading, clamped to the two lines the model is
    // asked for — a longer answer is the generator's bug, not the page's.
    expect(block.querySelector("p")?.className).toContain("text-[15px]");
    expect(block.querySelector("p")?.className).toContain("leading-[22px]");
    expect(block.querySelector("p")?.className).toContain("line-clamp-2");
    const lines = screen.getAllByTestId(/^catchup-brief-project-/);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain("payments-api");
    expect(lines[0]?.textContent).toContain("CI still red");
  });

  it("draws no project list when the model gave no per-project lines", () => {
    render(
      <BriefHeadline headline={{ text: "One project moved.", state: "ready" }} byProject={[]} />,
    );
    expect(screen.queryByTestId("catchup-brief-by-project")).toBeNull();
    expect(screen.getByText("One project moved.")).toBeDefined();
  });

  it("shows a skeleton bar and `writing headline…` while pending", () => {
    render(<BriefHeadline headline={pendingBrief.headline} byProject={[]} />);
    const pending = screen.getByTestId("catchup-brief-headline-pending");
    expect(pending.textContent).toContain("writing headline…");
    // The bar is the height the text lands at, at 70% of the column.
    const bar = pending.querySelector("span");
    expect(bar?.className).toContain("h-[14px]");
    expect(bar?.className).toContain("w-[70%]");
    expect(bar?.className).toContain("bg-fill");
  });

  it("renders nothing at all when the headline is unavailable", () => {
    const { container } = render(
      <BriefHeadline headline={{ text: "", state: "unavailable" }} byProject={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the headline text as text, never as markup", () => {
    render(
      <BriefHeadline
        headline={{ text: "<img src=x onerror=alert(1)> shipped", state: "ready" }}
        byProject={[]}
      />,
    );
    // Model output is data (ADR-0034): the tags are drawn as the words they are.
    expect(screen.getByTestId("catchup-brief-headline").querySelector("img")).toBeNull();
    expect(screen.getByTestId("catchup-brief-headline").textContent).toContain("<img src=x");
  });
});
