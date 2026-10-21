/**
 * StudioHeader layout tests: the name and the publish reason truncate with an
 * ellipsis instead of squeezing each other (the name keeps a 160px floor, the
 * reason truncates and keeps its full text in `title` + an accessible label),
 * the tab strip is a real tablist with the Runs / Assigned links, and the
 * action buttons keep a 44px phone tap target.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValidateBody } from "../../lib/pipeline/contract";
import { routes } from "../../lib/routes";
import { StudioHeader, type StudioView } from "./StudioHeader";

const VALID: ValidateBody = {
  valid: true,
  revision_digest: "rev_1",
  plan_digest: "plan_1",
  digest_scope: "full",
  errors: [],
  notes: [],
};

const LONG_NAME = "feature-development-with-a-far-too-long-slug-for-any-header";
const LONG_REASON =
  "the server's last verdict is invalid (3 findings): node plan has no prompt and node check references a step that does not exist in the pinned revision";

function props(overrides: Partial<Parameters<typeof StudioHeader>[0]> = {}) {
  const view: StudioView = "canvas";
  return {
    pipelineName: LONG_NAME,
    pipelineId: "pipe_1",
    savedVersion: 3,
    validation: VALID,
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
    onDiff: vi.fn(),
    diffOpen: false,
    onPublish: vi.fn(),
    publishPending: false,
    publishReason: LONG_REASON,
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
  it("keeps the name's 160px floor and truncates it with an ellipsis", () => {
    renderHeader();
    const title = screen.getByTestId("studio-title") as HTMLElement;
    expect(title.classList.contains("min-w-[160px]")).toBe(true);
    expect(title.classList.contains("truncate")).toBe(true);
    expect(title.title).toBe(LONG_NAME);
    expect((screen.getByTestId("studio-breadcrumb-workflows") as HTMLElement).textContent).toBe(
      "Workflows",
    );
  });

  it("truncates the publish reason with the full text in title and an accessible label", () => {
    renderHeader();
    const reason = screen.getByTestId("studio-publish-reason");
    expect((reason as HTMLElement).textContent).toBe(LONG_REASON);
    expect((reason as HTMLElement).title).toBe(LONG_REASON);
    expect((reason as HTMLElement).getAttribute("aria-label")).toBe(LONG_REASON);
    expect((reason as HTMLElement).classList.contains("truncate")).toBe(true);
    // The reason may shrink to zero but never forces the header wider: it is
    // a truncating flex item, not a shrink-0 one.
    expect((reason as HTMLElement).classList.contains("shrink-0")).toBe(false);
  });

  it("hides the reason and enables Publish when the gate is open", () => {
    renderHeader({ publishReason: null });
    expect(screen.queryByTestId("studio-publish-reason")).toBeNull();
    expect((screen.getByTestId("studio-publish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Canvas/YAML as tabs and Runs/Assigned as links to the workflow page", () => {
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });
    expect(screen.getByRole("tab", { name: "Canvas" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByTestId("studio-view-yaml"));
    expect(onViewChange).toHaveBeenCalledWith("yaml");
    const target = routes.workflow("pipe_1");
    for (const testid of ["studio-header-runs", "studio-header-assigned"]) {
      expect((screen.getByTestId(testid) as HTMLAnchorElement).getAttribute("href")).toBe(target);
    }
    // AXE aria-required-children (critical): a tablist may only own tab
    // children — the Runs/Assigned links live in the strip, outside it.
    const tablist = screen.getByRole("tablist");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tablist.contains(tab)).toBe(true);
    for (const testid of ["studio-header-runs", "studio-header-assigned"]) {
      expect(tablist.contains(screen.getByTestId(testid))).toBe(false);
    }
  });

  it("gives every phone action button a 44px tap target", () => {
    renderHeader();
    for (const testid of [
      "studio-undo",
      "studio-redo",
      "studio-save",
      "studio-validate",
      "studio-diff",
      "studio-publish",
    ]) {
      expect((screen.getByTestId(testid) as HTMLElement).classList.contains("min-h-[44px]")).toBe(
        true,
      );
    }
  });

  it("shows the read-only note instead of the write actions", () => {
    renderHeader({ readOnly: true, publishReason: "read-only" });
    expect(screen.queryByTestId("studio-save")).toBeNull();
    expect(screen.queryByTestId("studio-publish")).toBeNull();
    expect(screen.getByTestId("studio-read-only-note")).not.toBeNull();
  });
});
