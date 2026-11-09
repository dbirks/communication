/**
 * `ds/Page` (finding 07): the one layout contract. Each layout's classes and
 * the shared band are asserted here — the band carries the 22px/600 title,
 * the mono subline under it, the actions on the right, and the same inset
 * every page already used (`22px` sides, `20px` above, `28px` from `md` up);
 * `reading` caps the body at 960px LEFT-aligned (never centred); `wide` runs
 * the full column; `canvas` adds no padding and no band — the page draws its
 * own.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page, {
  PAGE_BAND_HEIGHT_PX,
  PAGE_BAND_PAD,
  PAGE_BREADCRUMB_CLASS,
  CrumbSep,
  PageBand,
} from "./Page";

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
  it("omits the shared header but keeps the shared inset when no title is given", () => {
    render(
      <Page layout="wide" testid="repo-page">
        <header data-testid="own-band">repo header</header>
      </Page>,
    );
    expect(screen.queryByTestId("page-band")).toBeNull();
    expect(screen.getByTestId("own-band")).toBeTruthy();
    // Acceptance 42452527578: the page draws its own band, but the INSET is
    // still the shell's job. Without it the repository header sat flush on the
    // sidebar edge (x=220 at 1280) while every other page's title sits at 248.
    const body = (screen.getByTestId("own-band").parentElement ?? new HTMLElement()) as HTMLElement;
    for (const cls of [...PAGE_BAND_PAD.split(/\s+/), "pb-[28px]"]) {
      expect(body.className).toContain(cls);
    }
    expect(body.className).not.toContain("max-w-");
  });

  it("caps nothing for a title-less `reading` page (the page owns its width)", () => {
    render(
      <Page layout="reading" testid="quiet-page">
        <p>body</p>
      </Page>,
    );
    const body = (screen.getByText("body").parentElement ?? new HTMLElement()) as HTMLElement;
    expect(screen.queryByTestId("page-band")).toBeNull();
    expect(body.className).toContain("px-[22px]");
    expect(body.className).toContain("md:px-[28px]");
  });
});

/**
 * `PageBand` is the same band on its own, for the `canvas` pages that own the
 * whole column (Threads, the workflow page): the ruler the acceptance reads —
 * `page-band`, one H1 at 22px/600 under `PAGE_BAND_PAD` — has to hold there
 * too, or the title jumps when the route changes.
 */
describe("PageBand — the shared band outside <Page>", () => {
  it("is the band <Page> draws, with the page's own classes added", () => {
    render(
      <Page layout="canvas" testid="canvas-page">
        <PageBand
          title="Threads"
          subtitle="mono"
          actions={<button type="button">New</button>}
          band={<div data-testid="tabs">tabs</div>}
          className="border-b border-line-strong bg-surface"
        />
        <div>panes</div>
      </Page>,
    );
    const band = screen.getByTestId("page-band");
    expect(band.tagName).toBe("HEADER");
    for (const cls of PAGE_BAND_PAD.split(/ +/)) expect(band.className).toContain(cls);
    expect(band.className).toContain("border-b");
    expect(band.className).toContain("bg-surface");
    const h1 = band.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe("Threads");
    expect(h1.className).toContain("text-[22px]");
    expect(h1.className).toContain("leading-[28px]");
    expect(h1.className).toContain("font-semibold");
    // The canvas page keeps its own body: the band adds no padding around it.
    expect(screen.getByTestId("canvas-page").className).toContain("flex-col");
    expect(screen.getByText("panes").parentElement).toBe(screen.getByTestId("canvas-page"));
    // The height a full-height canvas page takes off the viewport under the
    // band: the 20px above the title plus the 28px title line.
    expect(PAGE_BAND_HEIGHT_PX).toBe(20 + 28);
  });
});

/**
 * The `breadcrumb` slot (finding 11: trails read ABOVE titles) must not move
 * the title (finding 07: one baseline). It buys its room by sitting absolutely
 * inside the band's own `pt-[20px]`, so the band's padding classes stay exactly
 * what the e2e ruler computes from.
 */
describe("PageBand breadcrumb — above the title, off the baseline", () => {
  const trail = (name: string) => (
    <>
      <a href="/workflows">Workflows</a>
      <CrumbSep />
      <span aria-current="page">{name}</span>
    </>
  );

  it("renders the trail BEFORE the H1 in DOM order and leaves the band's padding alone", () => {
    render(<PageBand title="Review gate" breadcrumb={trail("Review gate")} />);
    const band = screen.getByTestId("page-band");
    // The inset is byte-for-byte `PAGE_BAND_PAD` plus the positioning context —
    // nothing is added above the title, so the H1's baseline cannot move.
    expect(band.className.trim().split(/ +/)).toEqual([...PAGE_BAND_PAD.split(/ +/), "relative"]);
    expect(band.className).toContain("pt-[20px]");
    const h1 = band.querySelector("h1") as HTMLElement;
    const crumb = within(band).getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 11px mono in a 14px line, parked in the 20px above the title.
    expect(PAGE_BREADCRUMB_CLASS.split(/ +/)).toEqual(
      expect.arrayContaining([
        "absolute",
        "top-[4px]",
        "font-mono",
        "text-[11px]",
        "leading-[14px]",
        "truncate",
      ]),
    );
    expect(crumb.className).toContain(PAGE_BREADCRUMB_CLASS.split(/ +/)[0]);
    // The trail ends on the current page — a leaf, not a dangling separator.
    expect(crumb.textContent).toBe("Workflows›Review gate");
    expect(crumb.textContent).not.toMatch(/[\u2039\u203a/]$/);
  });

  it("adds nothing at all to a band that passes no breadcrumb", () => {
    render(<PageBand title="Projects" />);
    const band = screen.getByTestId("page-band");
    expect(band.className.trim().split(/ +/)).toEqual(PAGE_BAND_PAD.split(/ +/));
    expect(within(band).queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("<Page> hands the slot to its band", () => {
    render(
      <Page layout="reading" title="Settings" breadcrumb={trail("Settings")}>
        <p>body</p>
      </Page>,
    );
    const band = screen.getByTestId("page-band");
    const crumb = within(band).getByRole("navigation", { name: "Breadcrumb" });
    expect(
      crumb.compareDocumentPosition(band.querySelector("h1") as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(band.className).toContain("pt-[20px]");
  });
});
