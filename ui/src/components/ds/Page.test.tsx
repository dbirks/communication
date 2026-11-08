/**
 * `ds/Page` (finding 07): the one layout contract. Each layout's classes and
 * the shared band are asserted here — the band carries the 22px/600 title,
 * the mono subline under it, the actions on the right, and the same inset
 * every page already used (`22px` sides, `20px` above, `28px` from `md` up);
 * `reading` caps the body at 960px LEFT-aligned (never centred); `wide` runs
 * the full column; `canvas` adds no padding and no band — the page draws its
 * own.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page, { PAGE_BAND_PAD } from "./Page";

afterEach(cleanup);

describe("Page — reading", () => {
  it("draws the shared band and caps the body at 960px, left-aligned", () => {
    render(
      <Page layout="reading" title="Settings" subtitle="mono line" testid="the-page">
        <p>body</p>
      </Page>,
    );
    const root = screen.getByTestId("the-page");
    expect(root.getAttribute("data-page-layout")).toBe("reading");
    const band = screen.getByTestId("page-band");
    expect(band.className).toContain(PAGE_BAND_PAD);
    const h1 = band.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("Settings");
    expect(h1.className).toContain("text-[22px]");
    expect(h1.className).toContain("leading-[28px]");
    expect(h1.className).toContain("font-semibold");
    const sub = h1.parentElement?.querySelector("div") as HTMLElement;
    expect(sub.textContent).toBe("mono line");
    expect(sub.className).toContain("font-mono");
    // The band's padding is the project frame's inset: 22px sides, 20px
    // above, 28px from md up.
    expect(PAGE_BAND_PAD).toContain("px-[22px]");
    expect(PAGE_BAND_PAD).toContain("pt-[20px]");
    expect(PAGE_BAND_PAD).toContain("md:px-[28px]");
    // The body caps at 960px and carries no `mx-auto` — the left edge is the
    // band's edge, so the title never jumps between pages.
    const column = (screen.getByText("body").parentElement ?? root) as HTMLElement;
    expect(column.className).toContain("max-w-[960px]");
    expect(column.className).not.toContain("mx-auto");
  });

  it("places actions on the title row", () => {
    render(
      <Page layout="reading" title="T" actions={<button type="button">Go</button>}>
        <p>body</p>
      </Page>,
    );
    const band = screen.getByTestId("page-band");
    expect(screen.getByRole("button", { name: "Go" }).closest("header")).toBe(band);
  });
});

describe("Page — wide", () => {
  it("runs the body the full content column with the band's inset", () => {
    render(
      <Page layout="wide" title="Projects" band={<div data-testid="tabs">tabs</div>}>
        <p>body</p>
      </Page>,
    );
    expect(screen.getByTestId("tabs").closest("header")).toBeTruthy();
    const body = (screen.getByText("body").parentElement ?? new HTMLElement()) as HTMLElement;
    expect(body.className).not.toContain("max-w-");
    expect(body.className).toContain("px-[22px]");
    expect(body.className).toContain("md:px-[28px]");
    expect(body.className).toContain("pb-[28px]");
  });
});

describe("Page — canvas", () => {
  it("adds no padding, no band, and keeps the page's own markup", () => {
    render(
      <Page layout="canvas" testid="canvas-page" title="ignored">
        <div data-testid="own-band">own header</div>
      </Page>,
    );
    const root = screen.getByTestId("canvas-page");
    expect(root.getAttribute("data-page-layout")).toBe("canvas");
    expect(root.querySelector("header")).toBeNull();
    expect(screen.queryByTestId("page-band")).toBeNull();
    expect(root.className).toContain("min-h-full");
    expect(root.className).not.toContain("px-[");
    // The canvas layout draws no band: a title passed anyway prints nothing.
    expect(screen.queryByText("ignored")).toBeNull();
  });
});

describe("Page — a wide/reading page that draws its own band", () => {
  it("omits the shared header when no title is given", () => {
    render(
      <Page layout="wide" testid="repo-page">
        <header data-testid="own-band">repo header</header>
      </Page>,
    );
    expect(screen.queryByTestId("page-band")).toBeNull();
    expect(screen.getByTestId("own-band")).toBeTruthy();
  });
});
