/**
 * Rest-list contract (acceptance 42474636182): the panel lists the unseen
 * pieces the tour cards do NOT already show; a piece with only some of its
 * unseen stops in the cards stays; an all-featured pile says so honestly.
 * Below 768px rows stack into two lines and the checkbox carries a 44px hit
 * area without moving the desktop grid.
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
