/**
 * Tour-card layout contract (mock 8a, second review): the evidence frame is
 * CAPPED at the mock's 124px, not fixed to it — a card whose evidence is a
 * three-line file list used to print that list at the top of a 124px box with
 * the rest empty. The card's bottom edge still belongs to "Start here ›",
 * through `mt-auto` on the footer rather than by stretching the frame. The
 * "See more" card's copy names the unit it counts: `remaining` is the tour's
 * unseen STOPS still behind it, so the sentence says "unseen stops".
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { TourCards } from "./TourCards";
import type { CatchUpTourEntry } from "../../api/catchup";

function entry(id: string, evidence: Record<string, unknown>[]): CatchUpTourEntry {
  return {
    work_item_id: `w-${id}`,
    stop: {
      id,
      title: `Stop ${id}`,
      narrative: `Narrative for stop ${id}. Second sentence nobody shows.`,
      kind: "BUG · FIXED",
      importance: "must_know",
      added_in_version: 1,
      seen: false,
      evidence,
    },
    project: { id: "p1", name: "payments", color: "#6a4bc4" },
    refs: { issues: [{ number: 215 }] },
    minutes: 2,
  } as unknown as CatchUpTourEntry;
}

afterEach(cleanup);

function mount(stops: CatchUpTourEntry[], more?: { remaining?: number; moreAvailable?: boolean }) {
  render(
    <MemoryRouter>
      <TourCards
        stops={stops}
        remaining={more?.remaining ?? 3}
        moreAvailable={more?.moreAvailable ?? false}
        loadingMore={false}
        onSeeMore={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe("catch-up tour cards", () => {
  it("caps the evidence frame at 124px and lets the footer own the card's bottom", () => {
    mount([
      entry("s1", [{ type: "log", label: "NIGHTLY REPLAY TEST", text: "FAIL TestReplayRefunds" }]),
      entry("s2", [{ type: "files", files: ["a.ts", "b.ts", "c.ts"] }]),
    ]);
    for (const index of [1, 2]) {
      const card = screen.getByTestId(`catchup-card-${index}`);
      const frame = card.querySelector('[class*="124px"]');
      expect(frame).toBeTruthy();
      // A ceiling, not a fixed box: the frame is the content's own height up to
      // the mock's 124px.
      expect(frame!.className).toContain("max-h-[124px]");
      expect(frame!.className).not.toMatch(/(^|\s)h-\[124px\](\s|$)/);
      expect(frame!.className).toContain("overflow-hidden");
      // "Start here ›" stays at the bottom of the card without stretching the
      // frame above it.
      const link = card.querySelector("a");
      expect(link?.textContent).toBe("Start here ›");
      expect(link?.className).toContain("mt-auto");
    }
  });

  it("draws no frame at all for a stop with no evidence", () => {
    mount([entry("s1", [])]);
    const card = screen.getByTestId("catchup-card-1");
    expect(card.querySelector('[class*="124px"]')).toBeNull();
    expect(card.querySelector("a")?.className).toContain("mt-auto");
  });

  it("counts what is behind See more in the unit it actually is: unseen stops", () => {
    mount([entry("s1", [])], { remaining: 5, moreAvailable: true });
    const more = screen.getByTestId("catchup-see-more");
    // `remaining` is total_unseen_stops minus the stops on screen — stops,
    // not pieces — so the copy must not let the bare number read either way.
    expect(more.textContent).toContain(
      "The assistant picks up to 4 more from the remaining 5 unseen stops.",
    );
  });
});
