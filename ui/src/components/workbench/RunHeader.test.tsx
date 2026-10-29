/**
 * notice-390-bleed: the run page's "NEW REVISION PUBLISHED" notice read at
 * ONE WORD PER LINE at 390 because the `slug in the library` chip rode
 * Alert's `action` slot — a `shrink-0` sibling beside a zero-basis text
 * column — so a ~230px chip left the sentence ~101px. The notice now wraps:
 * the text span carries a 20rem flex-basis floor inside a wrapping row, so
 * below floor + chip the chip drops to its own line and the text keeps the
 * full width, while any host wide enough still seats them side by side.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NewRevisionNotice } from "./RunHeader";

afterEach(cleanup);

function mountNotice() {
  render(
    <MemoryRouter>
      <NewRevisionNotice
        notice={{ newest: 7, pinned: 1 }}
        slug="feature-development-deterministic"
        pipelineId="pl_feat"
        revisionDigest={`sha256:${"a".repeat(64)}`}
      />
    </MemoryRouter>,
  );
}

const PHONES_BODY = 390 - 32 - 20; // viewport − workbench `px-4` − Alert `px-[10px]`
const FLOOR_REM = 20; // the text span's flex-basis floor, in rem
const GAP = 10; // the row's gap, in px
// The shortest chip the row can ever carry: a 1-char slug, `x in the library`
// in 11px mono (~106px) plus the chip's own `px-2` padding and borders.
const MIN_CHIP = 120;

describe("NewRevisionNotice", () => {
  it("words the § 7.2 sentence exactly and links to the pinned workflow", () => {
    mountNotice();
    const notice = screen.getByTestId("run-new-revision-notice");
    expect(notice.textContent).toContain(
      "revision 7 published since this run started — this run is pinned to 1 (aaaaaaaaaaaa). " +
        "The run stays on the revision it started with.",
    );
    const link = screen.getByTestId("run-new-revision-link");
    expect(link.getAttribute("href")).toBe("/workflows/pl_feat");
    expect(link.textContent).toBe("feature-development-deterministic in the library");
  });

  it("wraps the chip below the text at phone widths instead of beside a 101px column", () => {
    mountNotice();
    const link = screen.getByTestId("run-new-revision-link");
    const text = link.previousElementSibling as HTMLElement;
    const row = link.parentElement as HTMLElement;
    // The chip rides inside the Alert BODY, not the `action` slot: the row it
    // shares with the sentence wraps, and the text refuses to shrink below
    // its floor — which is what pushes the chip onto its own line at 390.
    expect(row.className).toContain("flex-wrap");
    expect(text.className).toContain("flex-1");
    expect(text.className).toContain("min-w-0");
    expect(text.className).toContain(`basis-[${FLOOR_REM}rem]`);
    expect(link.className).toContain("shrink-0");
    // And the chip never hangs past the body box on its own line: whatever
    // the slug's natural width, `max-w-full` caps it at the row and the mono
    // label wraps inside the chip (a 354px chip in a 338px body was the bleed).
    expect(link.className).toContain("max-w-full");
    // The floor + gap + the narrowest possible chip exceed a phone's body box,
    // so the pair CANNOT share a line there — the chip takes its own row and
    // the text keeps the full width. Any ≥ floor + gap + chip host still seats
    // them side by side, pixel-identical to the old layout at 1280.
    expect(FLOOR_REM * 16 + GAP + MIN_CHIP).toBeGreaterThan(PHONES_BODY);
  });
});
