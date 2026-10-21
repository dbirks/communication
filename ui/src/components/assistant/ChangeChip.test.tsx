import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChangeChip from "./ChangeChip";
import type { AssistantChange } from "./types";

afterEach(() => {
  cleanup();
});

const change = (overrides: Partial<AssistantChange> = {}): AssistantChange => ({
  id: "chg-1",
  kind: "draft_edit",
  target_ref: "draft:01K1",
  summary: "Inserted node `review` after `tests`",
  undoable: true,
  undone_at: null,
  created_at: "2026-10-20T10:00:00Z",
  ...overrides,
});

describe("ChangeChip", () => {
  it("renders nothing for an empty change list", () => {
    const { container } = render(
      <ChangeChip changes={[]} onUndo={() => {}} onUndoAll={() => {}} />,
    );
    expect(screen.queryByTestId("assistant-change-chip")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("shows the collapsed chip with the count and undo all", () => {
    const onUndoAll = vi.fn();
    render(
      <ChangeChip
        changes={[change(), change({ id: "chg-2" })]}
        onUndo={() => {}}
        onUndoAll={onUndoAll}
      />,
    );
    const toggle = screen.getByTestId("assistant-change-chip-toggle");
    expect(toggle.textContent).toContain("2 changes");
    expect(screen.getByTestId("assistant-change-chip").textContent).toContain("undo all");
    expect(screen.queryByTestId("assistant-change-list")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-change-undo-all"));
    expect(onUndoAll).toHaveBeenCalledTimes(1);
  });

  it("singularizes a single change and expands to per-item rows", () => {
    render(<ChangeChip changes={[change()]} onUndo={() => {}} onUndoAll={() => {}} />);
    expect(screen.getByTestId("assistant-change-chip-toggle").textContent).toContain("1 change");
    fireEvent.click(screen.getByTestId("assistant-change-chip-toggle"));
    const rows = screen.getAllByTestId("assistant-change-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Inserted node `review` after `tests`");
  });

  it("calls onUndo with the row's id and shows undo per undoable row", () => {
    const onUndo = vi.fn();
    render(
      <ChangeChip
        changes={[
          change({ id: "chg-1", summary: "+ step security-reviewer 1.0.0" }),
          change({ id: "chg-2", summary: "~ feature-delivery draft #12" }),
        ]}
        onUndo={onUndo}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    const undos = screen.getAllByTestId("assistant-change-undo");
    expect(undos).toHaveLength(2);
    fireEvent.click(undos[0]);
    expect(onUndo).toHaveBeenCalledWith("chg-1");
    fireEvent.click(undos[1]);
    expect(onUndo).toHaveBeenCalledWith("chg-2");
  });

  it("marks non-undoable rows (runs/approvals) with muted text, no button", () => {
    const onUndo = vi.fn();
    render(
      <ChangeChip
        changes={[
          change({
            id: "run-1",
            kind: "run_retry",
            summary: "Retried node `test` on run 9c1e",
            undoable: false,
          }),
          change({
            id: "ap-1",
            kind: "approval_decision",
            summary: "Approved the publish gate on run 31bd",
            undoable: false,
          }),
        ]}
        onUndo={onUndo}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    expect(screen.queryAllByTestId("assistant-change-undo")).toEqual([]);
    const notes = screen.getAllByTestId("assistant-change-not-undoable");
    expect(notes).toHaveLength(2);
    expect(notes[0].textContent).toBe("can't be undone");
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("shows undone rows as resolved, without an undo button", () => {
    render(
      <ChangeChip
        changes={[
          change({
            id: "chg-1",
            undoable: true,
            undone_at: "2026-10-20T11:00:00Z",
          }),
        ]}
        onUndo={() => {}}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    expect(screen.queryAllByTestId("assistant-change-undo")).toEqual([]);
    expect(screen.getByTestId("assistant-change-undone").textContent).toBe("✓ undone");
  });
});
