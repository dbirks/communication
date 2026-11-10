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
    // Handoff §1: the kind mark is a Tabler icon, not a Unicode glyph.
    expect(rows[0].querySelector("svg")?.getAttribute("class")).toContain("tabler-icon-");
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

  it("says a draft edit that kept no inverse op cannot be undone either", () => {
    render(
      <ChangeChip
        changes={[change({ id: "chg-1", undoable: false })]}
        onUndo={() => {}}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    expect(screen.queryAllByTestId("assistant-change-undo")).toEqual([]);
    expect(screen.getByTestId("assistant-change-not-undoable").textContent).toBe("can't be undone");
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
    const undone = screen.getByTestId("assistant-change-undone");
    expect(undone.textContent).toBe("undone");
    expect(undone.querySelector("svg")?.getAttribute("class")).toContain("tabler-icon-check");
  });
  it("offers Undo on draft edits only: a run or approval row reads can't be undone even when the store kept an inverse op (A5)", () => {
    const onUndo = vi.fn();
    render(
      <ChangeChip
        changes={[
          change({ id: "run-1", kind: "run_start", summary: "Started run 4f2a", undoable: true }),
          change({
            id: "pub-1",
            kind: "publish",
            summary: "Published revision 3 of feature-delivery",
            undoable: true,
          }),
          change({ id: "nav-1", kind: "navigate", summary: "Opened run 4f2a", undoable: false }),
          change({
            id: "ap-1",
            kind: "approval_decision",
            summary: "Approved the gate",
            undoable: true,
          }),
          change({
            id: "retry-1",
            kind: "run_retry",
            summary: "Retried node `test`",
            undoable: true,
          }),
          change({
            id: "edit-1",
            kind: "draft_edit",
            summary: "Renamed node `plan`",
            undoable: true,
          }),
        ]}
        onUndo={onUndo}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    // exactly one row keeps the button, and it is the draft edit
    const undos = screen.getAllByTestId("assistant-change-undo");
    expect(undos).toHaveLength(1);
    fireEvent.click(undos[0]);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith("edit-1");
    const notes = screen.getAllByTestId("assistant-change-not-undoable");
    expect(notes).toHaveLength(5);
    expect(notes.map((note) => note.textContent)).toEqual([
      "can't be undone",
      "can't be undone",
      "can't be undone",
      "can't be undone",
      "can't be undone",
    ]);
  });
});

/**
 * Walk-through finding 6: "undo all" is an offer, not a decoration. It stands
 * only while the list holds at least one change that could actually be undone —
 * a draft edit that is still standing — because a thread whose every change is
 * a run, an approval or a created project has nothing for it to undo.
 */
describe("undo all appears only when something is undoable", () => {
  const notUndoable = (overrides = {}) => ({
    ...change(overrides),
    kind: "run_start" as const,
    undoable: false,
  });

  it("hides undo all when no listed change can be undone", () => {
    render(
      <ChangeChip
        changes={[
          notUndoable({ id: "run-1", summary: "Started run 4f2a" }),
          notUndoable({ id: "ap-1", kind: "approval_decision", summary: "Approved the gate" }),
        ]}
        onUndo={() => {}}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    expect(screen.queryByTestId("assistant-change-undo-all")).toBeNull();
    // The chip itself still reports what happened, and each row says why not.
    expect(screen.getByTestId("assistant-change-chip-toggle").textContent).toContain("2 changes");
    expect(screen.getAllByTestId("assistant-change-not-undoable")).toHaveLength(2);
    // The separator that introduced the offer is gone with it.
    expect(screen.getByTestId("assistant-change-chip-toggle").parentElement?.textContent).toBe(
      "2 changes",
    );
  });

  it("shows undo all when one draft edit is still undoable", () => {
    render(
      <ChangeChip
        changes={[notUndoable({ id: "run-1" }), change({ id: "draft-1" })]}
        onUndo={() => {}}
        onUndoAll={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-change-undo-all")).toBeTruthy();
  });

  it("drops undo all once the only undoable row has been undone", () => {
    render(
      <ChangeChip
        changes={[
          change({ id: "draft-1", undone_at: "2026-10-20T11:00:00Z" }),
          notUndoable({ id: "run-1" }),
        ]}
        onUndo={() => {}}
        onUndoAll={() => {}}
        defaultOpen
      />,
    );
    expect(screen.queryByTestId("assistant-change-undo-all")).toBeNull();
    expect(screen.getAllByTestId("assistant-change-undone")).toHaveLength(1);
  });
});
