/**
 * StudioHeader layout tests (design 1g): the breadcrumb, the name owning the
 * free header space and WRAPPING it (pass-2 review, 1g-studio-1280/390 DEFECT:
 * names and titles wrap, never truncate), the draft chip showing only the parts
 * that are true, the Canvas | YAML tablist, the Runs/Assigned affordances being
 * GONE from the header (design 1g drops them; the testids are retired), the
 * action group flush right, and the action buttons keeping a 44px phone tap
 * target.
 */
import { cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioHeader, type StudioView } from "./StudioHeader";

const LONG_NAME = "feature-development-with-a-far-too-long-slug-for-any-header";

function props(overrides: Partial<Parameters<typeof StudioHeader>[0]> = {}) {
  const view: StudioView = "canvas";
  return {
    pipelineName: LONG_NAME,
    pipelineFolder: "delivery",
    savedVersion: 3,
    readOnly: false,
    canUndo: true,
    canRedo: true,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onSave: vi.fn(),
    saving: false,
    dirty: true,
    onValidate: vi.fn(),
    validatePending: false,
    onPublish: vi.fn(),
    publishPending: false,
    publishReason: null,
    view,
    onViewChange: vi.fn(),
    ...overrides,
  };
}

function renderHeader(overrides: Partial<Parameters<typeof StudioHeader>[0]> = {}) {
  return render(<MemoryRouter>{<StudioHeader {...props(overrides)} />}</MemoryRouter>);
}

afterEach(cleanup);

describe("StudioHeader", () => {
  it("renders the breadcrumb Workflows / <folder> / and wraps the name", () => {
    // Pass-2 review, DEFECT on 1g-studio-1280/390: the header drew
    // `Emu plan pass-2-202…` with ~180px of free header beside it. The product
    // rule is that names and titles wrap, never truncate — so the H1 takes the
    // free space (`flex-1` + `min-w-0`), stops growing at its own text width
    // (`md:max-w-max`, which keeps the chip and the tabs beside it), breaks
    // anywhere (`[overflow-wrap:anywhere]`) and the 52px row is a FLOOR, not a
    // cap. The old contract (a 320px cap + `truncate`) is gone.
    renderHeader();
    const title = screen.getByTestId("studio-title") as HTMLElement;
    expect(title.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(title.className).not.toMatch(/(^|\s)(whitespace-nowrap|text-ellipsis)(\s|$)/);
    expect(title.className).not.toMatch(/(^|\s)md:max-w-\[(\d|\.)+(px|ch|rem)\](\s|$)/);
    expect(title.classList.contains("md:flex-1")).toBe(true);
    expect(title.classList.contains("min-w-0")).toBe(true);
    expect(title.classList.contains("md:max-w-max")).toBe(true);
    expect(title.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(title.classList.contains("md:min-w-[160px]")).toBe(true);
    // 390: the name sits on a line of its own and wraps there (`flex-basis 100%`
    // below md, restored to `flex-1` from md up).
    expect(title.classList.contains("flex-[1_1_100%]")).toBe(true);
    // The full name stays readable by assistive tech and on hover.
    expect(title.title).toBe(LONG_NAME);
    const header = screen.getByTestId("studio-header");
    expect(header.classList.contains("md:min-h-[52px]")).toBe(true);
    expect(header.className).not.toMatch(/(^|\s)md:h-\[52px\](\s|$)/);
    // The deficit is never turned into a sideways scroll either: at 768–1023px
    // a `md:flex-nowrap` + `md:overflow-x-auto` bar pushed the whole
    // Validate/Save/Publish group off-screen (measured: header scrollWidth 818
    // in a 784px bar). The header wraps into extra rows instead — the 390
    // reflow rule one breakpoint up.
    expect(header.className).not.toMatch(/(^|\s)md:flex-nowrap(\s|$)/);
    expect(header.className).not.toMatch(/(^|\s)md:overflow-x-auto(\s|$)/);
    const breadcrumb = screen.getByTestId("studio-breadcrumb");
    expect(breadcrumb.textContent).toContain("Workflows");
    expect(breadcrumb.textContent).toContain("delivery");
    expect(
      (screen.getByTestId("studio-breadcrumb-workflows") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/workflows");
  });

  it("keeps the action group flush right with the name as the only grower", () => {
    // The name owns the free space; the actions take what it did not need.
    // A second `md:flex-1` spacer (the old layout) split that space in two and
    // re-created the 1280 ellipsis, so the header must have exactly one grower.
    renderHeader();
    const header = screen.getByTestId("studio-header");
    const growers = [...header.children].filter((child) => child.classList.contains("md:flex-1"));
    expect(growers).toHaveLength(1);
    expect(growers[0]).toBe(screen.getByTestId("studio-title"));
    const actions = screen.getByTestId("studio-header-actions");
    expect(actions.classList.contains("ml-auto")).toBe(true);
    expect(actions.className).not.toMatch(/(^|\s)md:ml-0(\s|$)/);
    // The group is never squeezed to make the name fit — its buttons are
    // `flex-nowrap`, so a shrunk group would clip them off-screen. It keeps its
    // full width and, when the row is too narrow, wraps onto a row of its own
    // where `ml-auto` still holds it flush right.
    expect(actions.classList.contains("md:shrink-0")).toBe(true);
    expect(actions.className).not.toMatch(/(^|\s)md:min-w-0(\s|$)/);
  });

  it("shows only the true parts of the draft chip: version and unsaved", () => {
    // 2026-10-30 review (1g item 4): the chip is the ONE place `unsaved` is
    // written — the status bar used to repeat it, and a bare second `unsaved`
    // sat beside the chip. Both are gone; the mark lives inside the chip, where
    // design 1g draws `· draft v3 · unsaved`.
    const base = props();
    const { rerender }: RenderResult = render(
      <MemoryRouter>
        <StudioHeader {...base} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("studio-draft-version") as HTMLElement).textContent).toBe(
      "· DRAFT V3 · unsaved",
    );
    // The chip's own lettering is uppercase; the DOM text stays the plain word
    // (the e2e suites assert `studio-dirty` = "unsaved"), CSS does the shaping.
    expect(
      (screen.getByTestId("studio-dirty") as HTMLElement).classList.contains("uppercase"),
    ).toBe(true);
    // One `unsaved` in the header, and the header is all that says it.
    expect(screen.getAllByText("unsaved", { exact: true })).toHaveLength(1);
    rerender(
      <MemoryRouter>
        <StudioHeader {...base} savedVersion={null} dirty={false} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("studio-draft-version") as HTMLElement).textContent).toBe("· DRAFT");
    expect(screen.queryByTestId("studio-dirty")).toBeNull();
    rerender(
      <MemoryRouter>
        <StudioHeader {...base} savedVersion={5} dirty={false} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("studio-draft-version") as HTMLElement).textContent).toBe(
      "· DRAFT V5",
    );
  });

  it("hides the truncated publish reason — it moved to the status bar", () => {
    renderHeader({ publishReason: "to publish: save, then validate" });
    expect(screen.queryByTestId("studio-publish-reason")).toBeNull();
    expect((screen.getByTestId("studio-publish") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderHeader({ publishReason: null });
    expect((screen.getByTestId("studio-publish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Canvas/YAML as tabs and no longer carries Runs/Assigned (design 1g)", () => {
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });
    expect(screen.getByRole("tab", { name: "Canvas" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByTestId("studio-view-yaml"));
    expect(onViewChange).toHaveBeenCalledWith("yaml");
    // Design 1g drops the Runs/Assigned links from the header; the testids
    // are retired (ui/scripts/retired-testids.json), so they must be gone.
    expect(screen.queryByTestId("studio-header-runs")).toBeNull();
    expect(screen.queryByTestId("studio-header-assigned")).toBeNull();
    // AXE aria-required-children (critical): the tablist owns only the two tabs.
    const tablist = screen.getByRole("tablist");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tablist.contains(tab)).toBe(true);
  });

  it("gives every phone action button a 44px tap target", () => {
    renderHeader();
    // Pass 2 #6: at phone width the header wraps — the text buttons keep
    // `min-h-[44px] md:min-h-[26px]`.
    for (const testid of ["studio-save", "studio-validate", "studio-publish"]) {
      expect((screen.getByTestId(testid) as HTMLElement).classList.contains("min-h-[44px]")).toBe(
        true,
      );
    }
    // The 390 reflow: undo/redo is ONE pair at every width — the utility
    // span is never display:none on the phone, and the button keeps the
    // design's 26px desktop size.
    expect((screen.getByTestId("studio-undo").parentElement as HTMLElement).className).toContain(
      "flex shrink-0",
    );
    expect((screen.getByTestId("studio-undo") as HTMLElement).className).toContain("h-[26px]");
    // The phone-only duplicates are gone (retired-testids.json).
    expect(screen.queryByTestId("studio-undo-mobile")).toBeNull();
    expect(screen.queryByTestId("studio-redo-mobile")).toBeNull();
  });

  it("reflows the breadcrumb and the unsaved mark into the phone header", () => {
    // The 390 reflow rule: the header hides no desktop content — the
    // breadcrumb and the dirty mark are never `hidden`/`md:inline`.
    renderHeader();
    expect(screen.getByTestId("studio-breadcrumb").className).not.toContain("hidden");
    expect(screen.getByTestId("studio-dirty").className).not.toContain("hidden");
    // The mark is INSIDE the chip now, so the chip's box is what reflows.
    expect(screen.getByTestId("studio-draft-version").parentElement?.className).not.toContain(
      "hidden",
    );
  });

  it("offers the Steps/Inspect drawer toggles only on phone (design 1g)", () => {
    renderHeader();
    expect(screen.queryByTestId("studio-phone-palette")).toBeNull();
    cleanup();
    const onTogglePalette = vi.fn();
    const onToggleInspector = vi.fn();
    renderHeader({
      phoneToggles: {
        paletteOpen: false,
        inspectorOpen: false,
        onTogglePalette,
        onToggleInspector,
      },
    });
    fireEvent.click(screen.getByTestId("studio-phone-palette"));
    expect(onTogglePalette).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("studio-phone-inspector"));
    expect(onToggleInspector).toHaveBeenCalledTimes(1);
    // The whole toggle group is a <768px-only surface.
    expect(
      (screen.getByTestId("studio-phone-palette").parentElement as HTMLElement).className,
    ).toContain("md:hidden");
  });

  it("shows the read-only note instead of the write actions", () => {
    renderHeader({ readOnly: true, publishReason: "read-only" });
    expect(screen.queryByTestId("studio-save")).toBeNull();
    expect(screen.queryByTestId("studio-publish")).toBeNull();
    expect(screen.getByTestId("studio-read-only-note")).not.toBeNull();
  });
});
