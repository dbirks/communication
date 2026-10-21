/**
 * StudioPalette tests: clicking an item adds after the selected node (or at
 * the end of the root scope when nothing is selected), the search box
 * filters, and the library is grouped with the non-runnable kinds apart.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTE_DRAG_TYPE, StudioPalette } from "./StudioPalette";

afterEach(cleanup);

describe("StudioPalette", () => {
  it("clicks add after the selected node", () => {
    const onAddAfter = vi.fn();
    render(<StudioPalette selectedId="plan" onAddAfter={onAddAfter} />);
    fireEvent.click(screen.getByTestId("palette-item-model.chat"));
    expect(onAddAfter).toHaveBeenCalledWith("plan", [], "model.chat");
  });

  it("clicks at the end of the root scope when nothing is selected", () => {
    const onAddAfter = vi.fn();
    render(<StudioPalette selectedId={null} onAddAfter={onAddAfter} />);
    fireEvent.click(screen.getByTestId("palette-item-process.exec"));
    expect(onAddAfter).toHaveBeenCalledWith(null, [], "process.exec");
  });

  it("stays inert in read-only and passes the drag type on drag start", () => {
    const onAddAfter = vi.fn();
    const first = render(<StudioPalette selectedId="plan" readOnly onAddAfter={onAddAfter} />);
    const item = first.getByTestId("palette-item-agent.acp");
    expect(item.draggable).toBe(false);
    fireEvent.click(item);
    expect(onAddAfter).not.toHaveBeenCalled();

    // RTL result queries are bound to the document body: unmount the read-only
    // palette first so its items cannot collide with the next render's.
    first.unmount();
    const second = render(<StudioPalette selectedId="plan" onAddAfter={vi.fn()} />);
    const item2 = second.getByTestId("palette-item-agent.acp");
    expect(item2.draggable).toBe(true);
    const setData = vi.fn();
    fireEvent.dragStart(item2, {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith(PALETTE_DRAG_TYPE, "agent.acp");
  });

  it("never offers Publish kinds (ADR-0045)", () => {
    render(<StudioPalette selectedId={null} onAddAfter={vi.fn()} />);
    expect(screen.queryByTestId("palette-item-git.publish")).toBeNull();
    expect(screen.queryByTestId("palette-item-artifact.publish")).toBeNull();
  });

  it("filters with the search box and shows the non-runnable group greyed", () => {
    render(<StudioPalette selectedId={null} onAddAfter={vi.fn()} />);
    expect(screen.getByText("Not runnable yet")).toBeTruthy();
    const input = screen.getByTestId("palette-search");
    fireEvent.change(input, { target: { value: "approval" } });
    expect(screen.getByTestId("palette-item-human.approval")).toBeTruthy();
    expect(screen.queryByTestId("palette-item-agent.acp")).toBeNull();
    fireEvent.change(input, { target: { value: "zzz-nothing" } });
    expect(screen.getByTestId("palette-empty")).toBeTruthy();
  });
});
