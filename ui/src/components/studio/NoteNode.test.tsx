/**
 * NoteNode — the canvas sticky note (review-1 09-1280-1). Its own box, its own
 * editing rule, and nothing that could wire it into a run.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NoteNode, type NoteNodeRender } from "./NoteNode";
import { NOTE_MIN_HEIGHT, type CanvasNote } from "./flowModel";

afterEach(cleanup);

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

function renderNote(overrides: Partial<NoteNodeRender> = {}) {
  const note: CanvasNote = { id: "note-1", x: 240, y: 120, width: 200, text: "check with Ada" };
  const data: NoteNodeRender = {
    note,
    readOnly: false,
    selected: false,
    editing: false,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  const props = {
    id: note.id,
    type: "note",
    data,
    selected: false,
    isConnectable: false,
    dragging: false,
    zIndex: 1,
    width: note.width,
    height: NOTE_MIN_HEIGHT,
    positionAbsoluteX: note.x,
    positionAbsoluteY: note.y,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  } as unknown as NodeProps<Node<NoteNodeRender>>;
  const view = render(<NoteNode {...props} />);
  return { note, data, view };
}

describe("NoteNode", () => {
  it("draws the design's amber box with no connection handles", () => {
    renderNote();
    const card = screen.getByTestId("canvas-note-note-1");
    expect(card.textContent).toContain("check with Ada");
    // 200px wide, ≥56 tall, `#fdf6e4` paper / `#e8cf94` edge off the token table.
    expect(card.style.width).toBe("200px");
    expect(card.style.minHeight).toBe(`${NOTE_MIN_HEIGHT}px`);
    expect(card.className).toContain("bg-st-waiting-pale-body");
    expect(card.className).toContain("border-st-waiting-pale-edge");
    expect(card.className).toContain("rounded-[10px]");
    expect(card.className).toContain("text-[13px]");
    expect(card.className).toContain("leading-[18px]");
    // Not a step: no handles at all, so nothing can be wired to or from it.
    expect(card.querySelector(".react-flow__handle")).toBeNull();
    // The card is the drag handle (React Flow's opt-out class must be off it).
    expect(card.className).not.toContain("nodrag");
    expect(screen.getByRole("button", { name: "Note: check with Ada" })).toBeTruthy();
  });

  it("rings the selected note with the ink edge + shadow", () => {
    renderNote({ selected: true });
    const card = screen.getByTestId("canvas-note-note-1");
    expect(card.className).toContain("border-ink");
    expect(card.className).toContain("shadow-(--shadow-node-selected)");
    expect(card.dataset["selected"]).toBe("true");
  });

  it("rests with the tonal offset shadow", () => {
    renderNote();
    const card = screen.getByTestId("canvas-note-note-1");
    expect(card.className).toContain("shadow-(--shadow-node)");
    expect(card.className).not.toContain("shadow-(--shadow-node-selected)");
  });

  it("a plain click selects, a double-click edits", () => {
    const { data } = renderNote();
    const card = screen.getByTestId("canvas-note-note-1");
    fireEvent.click(card);
    expect(data.onSelect).toHaveBeenCalledOnce();
    expect(data.onEdit).not.toHaveBeenCalled();
    fireEvent.doubleClick(card);
    expect(data.onEdit).toHaveBeenCalledOnce();
  });

  it("Enter while selected edits in place", () => {
    const { data } = renderNote();
    fireEvent.keyDown(screen.getByTestId("canvas-note-note-1"), { key: "Enter" });
    expect(data.onEdit).toHaveBeenCalledOnce();
  });

  it("opens an editor on the note's text; blur saves what was typed", () => {
    const { data } = renderNote({ editing: true });
    const area = screen.getByTestId("canvas-note-input-note-1") as HTMLTextAreaElement;
    // Selecting words inside the editor must never drag the note around.
    expect(area.className).toContain("nodrag");
    expect(area.value).toBe("check with Ada");
    fireEvent.change(area, { target: { value: "check with Ada before making live" } });
    fireEvent.blur(area);
    expect(data.onSave).toHaveBeenCalledWith("check with Ada before making live");
  });

  it("Esc saves its text and never reaches the canvas's deselect", () => {
    const { data } = renderNote({ editing: true });
    const area = screen.getByTestId("canvas-note-input-note-1") as HTMLTextAreaElement;
    area.focus();
    const reachedWindow: string[] = [];
    window.addEventListener("keydown", () => reachedWindow.push("window"));
    fireEvent.change(area, { target: { value: "kept" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(data.onSave).toHaveBeenCalledWith("kept");
    // The editor owns its Escape: the canvas's window-level handler (which
    // clears the whole selection) must not see it.
    expect(reachedWindow).toEqual([]);
    expect(area).toHaveProperty("value", "kept");
  });

  it("grows with its own text", () => {
    renderNote({ editing: true });
    const area = screen.getByTestId("canvas-note-input-note-1") as HTMLTextAreaElement;
    expect(parseInt(area.style.height, 10)).toBeGreaterThanOrEqual(40);
    fireEvent.input(area, { target: { value: "one\n two\n three" } });
    expect(parseInt(area.style.height, 10)).toBe(3 * 18);
  });

  it("shows the paper without a way to change it, read-only", () => {
    const { data } = renderNote({ readOnly: true });
    const card = screen.getByTestId("canvas-note-note-1");
    expect(screen.getByRole("note", { name: "Note: check with Ada" })).toBeTruthy();
    fireEvent.click(card);
    fireEvent.doubleClick(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(data.onSelect).not.toHaveBeenCalled();
    expect(data.onEdit).not.toHaveBeenCalled();
    expect(card.querySelector("textarea")).toBeNull();
  });
});
