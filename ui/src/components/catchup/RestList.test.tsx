/**
 * Rest-list contract (acceptance 42474636182): the panel lists the unseen
 * pieces the tour cards do NOT already show; a piece with only some of its
 * unseen stops in the cards stays; an all-featured pile says so honestly.
 * Below 768px rows stack into two lines and the checkbox carries a 44px hit
 * area without moving the desktop grid. Acceptance 42482110455 adds the
 * overlap rule: the title/summary cell owns its width (it truncates inside
 * its own cell and sits in the grid's first row), so its summary line can
 * never print under the resolution chip.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { RestList } from "./RestList";
import type { CatchUpListItem } from "../../api/catchup";

function item(id: string, unseenStops: number): CatchUpListItem {
  return {
    id,
    project: { id: "p1", name: "payments", color: "#6a4bc4" },
    shape: "issue",
    title: `Work ${id}`,
    summary: "One line under the title",
    resolution: "merged",
    refs: { issues: [{ number: 215 }] },
    updated: false,
    unseen_stops: unseenStops,
    total_stops: unseenStops,
    importance: "must_know",
    updated_at: "2026-10-14T09:00:00Z",
    created_at: "2026-10-13T09:00:00Z",
  } as unknown as CatchUpListItem;
}

const noop = () => undefined;

function mount(items: CatchUpListItem[], tourStopsByItem: Record<string, number> = {}) {
  render(
    <MemoryRouter>
      <RestList
        items={items}
        showSeen={false}
        onToggleShowSeen={noop}
        onMarkAllSeen={noop}
        onMarkSeen={noop}
        markingIds={[]}
        tourStopsByItem={tourStopsByItem}
      />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("RestList", () => {
  it("excludes pieces whose unseen stops are all in the tour cards and counts the rest", () => {
    mount([item("a", 2), item("b", 1), item("c", 2)], { a: 1, b: 1 });
    // b is fully featured; a has only one of two stops shown and stays.
    expect(screen.getByTestId("catchup-row-a")).toBeTruthy();
    expect(screen.queryByTestId("catchup-row-b")).toBeNull();
    expect(screen.getByTestId("catchup-rest").textContent).toContain("THE REST · 2 UNSEEN");
  });

  it("says so honestly when the cards show everything unseen", () => {
    mount([item("a", 1), item("b", 2)], { a: 1, b: 2 });
    expect(screen.getByTestId("catchup-rest").textContent).toContain(
      "Everything unseen is in the tour above.",
    );
    expect(screen.getByTestId("catchup-rest").textContent).toContain("THE REST · 0 UNSEEN");
  });

  it("keeps the summary inside its own cell so it can never print over the chip", () => {
    mount([item("a", 2)]);
    const row = screen.getByTestId("catchup-row-a");
    // The text cell owns its width: `min-w-0` lets the flex/grid track shrink
    // below the text's own length and `truncate` clips what is left, so the
    // summary line stops at the cell edge instead of running under the
    // resolution chip (acceptance 42482110455, cu-8a: the summary painted a
    // 30×14px patch over `branch ready`).
    const cell = row.querySelector('[class*="col-start-4"]');
    expect(cell?.className).toContain("min-w-0");
    expect(cell?.className).toContain("truncate");
    // It is the last child, so the ≥768 grid needs its row named: left on an
    // auto row, the sparse packing cursor (already past column 4) pushed it
    // into a second row, where its second line sat on the NEXT row's chip.
    expect(cell?.className).toContain("md:row-start-1");
    expect(cell?.className).toContain("md:col-start-4");
    // Both lines truncate on their own, and the chip is never squeezed.
    const lines = Array.from(cell?.children ?? []);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.className).toContain("truncate");
    const chip = row.querySelector('[class*="col-start-5"]');
    expect(chip?.className).toContain("shrink-0");
    expect(chip?.textContent).toBe("merged");
  });

  it("stacks rows into two lines below 768px with a 44px checkbox hit area", () => {
    mount([item("a", 2)]);
    const row = screen.getByTestId("catchup-row-a");
    // Mobile: flex-wrap column-of-two-lines; desktop: the 8a grid returns.
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("md:grid");
    expect(row.className).toContain(
      "md:grid-cols-[16px_104px_minmax(0,160px)_minmax(0,1fr)_auto_64px]",
    );
    // The 15px visual box keeps its size; an absolute overlay grows the hit
    // area to 44×44 on phones and coarse pointers only.
    const overlay = row.querySelector("label > span[aria-hidden]");
    expect(overlay?.className).toContain("-inset-[14.5px]");
    expect(overlay?.className).toContain("max-md:block");
    expect(overlay?.className).toContain("pointer-coarse:block");
    const box = screen.getByLabelText("Mark Work a seen");
    expect(box.className).toContain("h-[15px]");
  });
});
