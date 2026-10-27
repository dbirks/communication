/**
 * StudioHeader layout tests (design 1g): the breadcrumb, the name's 160px
 * floor and ellipsis, the draft chip showing only the parts that are true,
 * the Canvas | YAML tablist, the Runs/Assigned affordances being GONE from
 * the header (design 1g drops them; the testids are retired), and the action
 * buttons keeping a 44px phone tap target.
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
  it("renders the breadcrumb Workflows / <folder> / and truncates the name", () => {
    renderHeader();
    const title = screen.getByTestId("studio-title") as HTMLElement;
    expect(title.classList.contains("md:min-w-[160px]")).toBe(true);
    expect(title.classList.contains("truncate")).toBe(true);
    expect(title.title).toBe(LONG_NAME);
    const breadcrumb = screen.getByTestId("studio-breadcrumb");
    expect(breadcrumb.textContent).toContain("Workflows");
    expect(breadcrumb.textContent).toContain("delivery");
    expect(
      (screen.getByTestId("studio-breadcrumb-workflows") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/workflows");
  });

  it("shows only the true parts of the draft chip: version and unsaved", () => {
    const base = props();
    const { rerender }: RenderResult = render(
      <MemoryRouter>
        <StudioHeader {...base} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("studio-draft-version") as HTMLElement).textContent).toBe(
      "· DRAFT V3 · UNSAVED",
    );
    rerender(
      <MemoryRouter>
        <StudioHeader {...base} savedVersion={null} dirty={false} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId("studio-draft-version") as HTMLElement).textContent).toBe("· DRAFT");
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
