import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalDiff } from "./proposalDiff";
import { ProposalReview, wordDiff } from "./ProposalReview";

type ReviewProps = ComponentProps<typeof ProposalReview>;

afterEach(cleanup);

const step = (id: string, kind: string, isScope = false) => ({
  id,
  kind,
  label: id,
  isScope,
});

const longPromptBefore = "Summarize the change briefly in one short line for the reviewer";
const longPromptAfter = "Summarize the change in one short line for the reviewer and link the run";

function makeDiff(overrides: Partial<ProposalDiff> = {}): ProposalDiff {
  return {
    added: [step("fix", "agent.acp"), step("loop", "scope.repeat", true)],
    edited: [
      {
        ...step("pr", "agent.acp"),
        fields: [
          { field: "config.prompt", before: longPromptBefore, after: longPromptAfter },
          { field: "config.maxTurns", before: 3, after: 5 },
          { field: "dependsOn", before: ["fix"], after: ["fix", "loop"] },
        ],
      },
    ],
    removed: [step("legacy", "process.exec")],
    addedEdges: [
      { from: "fix", to: "pr" },
      { from: "pr", to: "loop" },
    ],
    removedEdges: [{ from: "legacy", to: "pr" }],
    count: 4,
    ...overrides,
  };
}

function renderReview(overrides: Partial<ProposalDiff> = {}, props: Partial<ReviewProps> = {}) {
  const handlers = {
    focusedId: null as string | null,
    onFocus: vi.fn(),
    onShowOnCanvas: vi.fn(),
    onClose: vi.fn(),
    sheet: false,
    footer: undefined as ReactNode,
  };
  const result = render(
    <ProposalReview
      diff={makeDiff(overrides)}
      focusedId={handlers.focusedId}
      onFocus={handlers.onFocus}
      onShowOnCanvas={handlers.onShowOnCanvas}
      onClose={handlers.onClose}
      sheet={handlers.sheet}
      footer={handlers.footer}
      {...props}
    />,
  );
  return { ...handlers, container: result.container };
}

describe("wordDiff", () => {
  it("marks the words only one side has", () => {
    const ops = wordDiff("write the fix now", "write the fix then test");
    expect(
      ops
        .filter((o) => o.kind === "del")
        .map((o) => o.text)
        .join(""),
    ).toContain("now");
    expect(
      ops
        .filter((o) => o.kind === "add")
        .map((o) => o.text)
        .join(""),
    ).toContain("test");
    expect(
      ops
        .filter((o) => o.kind === "same")
        .map((o) => o.text)
        .join(""),
    ).toContain("write the fix");
  });
});

describe("ProposalReview", () => {
  it("renders the header count and the counts line", () => {
    renderReview();
    const panel = screen.getByTestId("proposal-review");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("Review proposed changes");
    expect(panel.textContent).toContain("REVIEW · 4 PROPOSED CHANGES");
    expect(panel.textContent).toContain("2 added · 1 edited · 1 removed");
  });

  it("says CHANGE for one change and omits zero counts", () => {
    const one = makeDiff({
      added: [],
      edited: [
        { ...step("pr", "agent.acp"), fields: [{ field: "config.maxTurns", before: 3, after: 5 }] },
      ],
      removed: [],
      addedEdges: [],
      count: 1,
    });
    render(
      <ProposalReview
        diff={one}
        focusedId={null}
        onFocus={vi.fn()}
        onShowOnCanvas={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const panel = screen.getByTestId("proposal-review");
    expect(panel.textContent).toContain("REVIEW · 1 PROPOSED CHANGE");
    expect(panel.textContent).toContain("1 edited");
    expect(panel.textContent).not.toContain("added");
    expect(panel.textContent).not.toContain("removed");
  });

  it("lists rows added, then edited, then removed", () => {
    const { container } = renderReview();
    const ids = Array.from(
      container.querySelectorAll("[data-testid^='proposal-change-']"),
      (node) => node.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "proposal-change-fix",
      "proposal-change-loop",
      "proposal-change-pr",
      "proposal-change-legacy",
    ]);
  });

  it("labels wraps and struck-through removals", () => {
    renderReview();
    expect(screen.getByTestId("proposal-change-loop").textContent).toContain(
      "new wrap · scope.repeat",
    );
    expect(screen.getByTestId("proposal-change-pr").textContent).toContain("edited · agent.acp");
    const legacy = screen.getByTestId("proposal-change-legacy");
    expect(legacy.textContent).toContain("removed · process.exec");
    expect(legacy.querySelector(".line-through")).not.toBeNull();
    // A removed change has no way to be shown on the canvas.
    expect(screen.queryByTestId("proposal-show-legacy")).toBeNull();
    expect(screen.getByTestId("proposal-show-fix")).toBeTruthy();
  });

  it("word-diffs a long prompt, marking removed and added words", () => {
    renderReview();
    const row = screen.getByTestId("proposal-change-pr");
    const del = Array.from(row.querySelectorAll('[data-diff="del"]'))
      .map((node) => node.textContent)
      .join("");
    const add = Array.from(row.querySelectorAll('[data-diff="add"]'))
      .map((node) => node.textContent)
      .join("");
    expect(del).toContain("briefly");
    expect(add).toContain("and link the run");
    const delNode = row.querySelector('[data-diff="del"]');
    expect(delNode?.className).toContain("bg-st-failed-tag");
    expect(delNode?.className).toContain("line-through");
    const addNode = row.querySelector('[data-diff="add"]');
    expect(addNode?.className).toContain("underline");
    // The field label is the config key, without the "config." prefix.
    expect(row.textContent).toContain("PROMPT");
    expect(row.textContent).not.toContain("CONFIG.");
  });

  it("shows non-string and short values as before → after", () => {
    renderReview();
    const row = screen.getByTestId("proposal-change-pr");
    expect(row.textContent).toContain("3 → 5");
    expect(row.textContent).toContain('["fix"] → ["fix","loop"]');
    expect(row.textContent).toContain("DEPENDSON");
  });

  it("lists an added row's new connections and no removed edges", () => {
    renderReview();
    expect(screen.getByTestId("proposal-change-fix").textContent).toContain("fix → pr");
    expect(screen.getByTestId("proposal-change-legacy").textContent).not.toContain("legacy → pr");
  });

  it("focuses the ink-bordered row and calls onFocus as it moves down", () => {
    const { onFocus } = renderReview({}, { focusedId: "fix" });
    expect(screen.getByTestId("proposal-change-pr").className).toContain("border-line");
    expect(screen.getByTestId("proposal-change-fix").className).toContain("border-ink");
    fireEvent.keyDown(screen.getByTestId("proposal-change-fix"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("proposal-change-loop"), { key: "ArrowDown" });
    const third = screen.getByTestId("proposal-change-pr");
    expect(third.className).toContain("border-ink");
    expect(document.activeElement).toBe(third);
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus).toHaveBeenLastCalledWith("pr");
  });

  it("calls onFocus when a row is clicked", () => {
    const { onFocus } = renderReview({}, { focusedId: "fix" });
    fireEvent.click(screen.getByTestId("proposal-change-pr"));
    expect(onFocus).toHaveBeenCalledWith("pr");
  });

  it("shows the focused change on the canvas with Enter and the icon button", () => {
    const { onShowOnCanvas } = renderReview({}, { focusedId: "loop" });
    fireEvent.keyDown(screen.getByTestId("proposal-change-loop"), { key: "Enter" });
    expect(onShowOnCanvas).toHaveBeenCalledWith("loop");
    fireEvent.click(screen.getByTestId("proposal-show-fix"));
    expect(onShowOnCanvas).toHaveBeenCalledWith("fix");
  });

  it("closes with Escape and with ×", () => {
    const { onClose } = renderReview();
    fireEvent.keyDown(screen.getByTestId("proposal-change-fix"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("proposal-review-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("proposal-review-close").getAttribute("aria-label")).toBe("Close");
  });

  it("says so when the proposal changes nothing", () => {
    renderReview({
      added: [],
      edited: [],
      removed: [],
      addedEdges: [],
      removedEdges: [],
      count: 0,
    });
    const panel = screen.getByTestId("proposal-review");
    expect(panel.textContent).toContain("REVIEW · 0 PROPOSED CHANGES");
    expect(panel.textContent).toContain("Nothing to review: the proposal changes nothing.");
    expect(panel.querySelector("[data-testid^='proposal-change-']")).toBeNull();
  });

  it("is a bottom sheet on phone and carries the footer", () => {
    renderReview({}, { sheet: true, footer: <button type="button">Apply proposal</button> });
    const panel = screen.getByTestId("proposal-review");
    expect(panel.className).toContain("max-h-[60dvh]");
    expect(panel.className).toContain("rounded-t-[14px]");
    expect(panel.className).toContain("inset-x-0");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("proposal-review-footer").textContent).toBe("Apply proposal");
  });

  it("is a docked panel on desktop with no footer row", () => {
    renderReview();
    const panel = screen.getByTestId("proposal-review");
    expect(panel.className).toContain("w-[372px]");
    expect(panel.className).toContain("right-4");
    expect(panel.className).toContain("top-[62px]");
    expect(panel.className).toContain("border-fill-edge");
    expect(panel.getAttribute("aria-modal")).toBeNull();
    expect(screen.queryByTestId("proposal-review-footer")).toBeNull();
  });
});
