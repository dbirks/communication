/**
 * `New workflow` START FROM tiles and the dialog's own failure surface
 * (design 1c). A tile advertises how many steps its starter puts on the
 * canvas — `4 steps`, `One agent step` — counted from the document itself
 * with the same parse the canvas draws with, never a hand-written number and
 * never the skeleton's placeholder node id `first` the author is meant to
 * rename. When the library read has failed, the FAILED banner renders INSIDE
 * the dialog: the overlay covers the page, so a page-level banner would sit
 * behind the very dialog whose folders it explains.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NewWorkflowDialog, starterHint, tileSubtitle } from "./NewWorkflowDialog";
import { ApiError } from "../../api/client";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  firstSentence,
  templateById,
} from "../../lib/pipeline/templates";

afterEach(cleanup);

describe("NewWorkflowDialog tileSubtitle", () => {
  it("the Blank tile says what it is — one step, not the skeleton's node id", () => {
    const blank = templateById("blank");
    expect(blank).toBeTruthy();
    expect(blank?.stepCount).toBe(1);
    expect(tileSubtitle(blank!)).toBe("One agent step");
    expect(tileSubtitle(blank!)).not.toContain("first");
  });

  it("template tiles count their own document's steps, like the design", () => {
    // The real samples' own node counts (the drift test keeps these bytes
    // identical to docs/samples/home), so the tile cannot promise steps the
    // canvas will not draw.
    expect(tileSubtitle(templateById("plan-with-approval")!)).toBe("4 steps");
    expect(tileSubtitle(templateById("security-review")!)).toBe("3 steps");
    expect(tileSubtitle(templateById("issue-to-pr")!)).toBe("4 steps");
    for (const template of PIPELINE_TEMPLATES.filter((t) => t.id !== "blank")) {
      expect(tileSubtitle(template)).toBe(`${template.stepCount} steps`);
      // The chain is not the tile's line any more (it stays on the index's
      // starter cards, where there is room for it).
      expect(tileSubtitle(template)).not.toContain("›");
    }
  });

  it("an unparseable document shows nothing rather than an invented count", () => {
    expect(
      tileSubtitle({
        ...templateById("blank")!,
        documentYaml: BLANK_SKELETON_YAML,
        stepCount: 3,
      }),
    ).toBe("3 steps");
    expect(
      tileSubtitle({
        ...templateById("blank")!,
        documentYaml: "not: [a: pipeline",
        stepCount: null,
      }),
    ).toBe("");
  });
});

describe("NewWorkflowDialog tiles + failure surface (rendered)", () => {
  function mount(options: { listError?: unknown } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NewWorkflowDialog
            open
            onClose={() => {}}
            canCreate
            folders={["Delivery"]}
            listError={options.listError}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return screen.getByTestId("new-workflow-dialog");
  }

  it("keeps every START FROM tile's text left-aligned at any width", () => {
    // reflow-390 item 1: at 390 the tile text centred while 1280 was
    // left-aligned; the phone card must read as the same card.
    mount();
    for (const id of ["blank", "plan-with-approval", "security-review", "issue-to-pr"]) {
      expect(screen.getByTestId(`new-workflow-template-${id}`).className).toContain("text-left");
    }
  });

  it("each tile shows its own step count under its name", () => {
    const dialog = mount();
    const tile = (id: string) => screen.getByTestId(`new-workflow-template-${id}`).textContent;
    expect(tile("blank")).toBe("BlankOne agent step");
    expect(tile("plan-with-approval")).toContain("4 steps");
    expect(tile("security-review")).toContain("3 steps");
    expect(tile("issue-to-pr")).toContain("4 steps");
    // Nothing invented: the number IS the document's node count.
    for (const template of PIPELINE_TEMPLATES.filter((t) => t.id !== "blank")) {
      expect(tile(template.id)).toContain(`${template.stepCount} steps`);
    }
    expect(dialog).toBeTruthy();
  });

  it("carries the library read's FAILED banner inside the dialog, not behind it", () => {
    const error = new ApiError(
      { type: "about:blank", title: "Internal Server Error", status: 500 },
      { title: "Internal Server Error", status: 500 },
    );
    mount({ listError: error });
    const banner = screen.getByTestId("new-workflow-list-failure");
    // Inside the dialog's own box — the page behind the overlay shows nothing.
    expect(screen.getByTestId("new-workflow-dialog").contains(banner)).toBe(true);
    expect(banner.textContent).toContain("FAILED");
    expect(banner.textContent).toContain("Internal Server Error");
  });

  it("draws no banner when the library read answered", () => {
    mount();
    expect(screen.queryByTestId("new-workflow-list-failure")).toBeNull();
  });
});

// The line under the START FROM cards (design 1c). A template quotes its own
// metadata; Blank's metadata line is a build note about the skeleton FILE
// ("skeleton draft — the top-level shape and one node, then write the YAML
// yourself"), which is not a sentence for the person choosing a start
// (2026-10-30 copy review, 1c item 1).
describe("starterHint", () => {
  it("says Blank in the canvas's own words, not the skeleton's", () => {
    const hint = starterHint(templateById("blank"));
    expect(hint).toBe("One agent step to start from. Add and edit steps on the canvas.");
    // No build vocabulary: the reader is not being told how the starter file
    // is assembled or that YAML exists at all at this moment.
    expect(hint).not.toMatch(/skeleton|YAML|top-level|node/i);
  });

  it("leaves every real template on its own first sentence", () => {
    for (const template of PIPELINE_TEMPLATES.filter((t) => t.id !== "blank")) {
      expect(starterHint(template)).toBe(firstSentence(template.description));
      expect(starterHint(template)).not.toBe("");
    }
    expect(starterHint(null)).toBe("");
  });
});
