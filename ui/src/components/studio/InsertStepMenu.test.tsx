import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InsertStepMenu } from "./InsertStepMenu";

afterEach(cleanup);

function renderMenu(overrides: Partial<Parameters<typeof InsertStepMenu>[0]> = {}) {
  const props = {
    mode: "insert" as const,
    between: { from: "Read", to: "Write" },
    onPick: vi.fn(),
    onDescribe: vi.fn(),
    onClose: vi.fn(),
    side: "below" as const,
    caret: 130,
    ...overrides,
  };
  render(<InsertStepMenu {...props} />);
  return props;
}

const KINDS = ["agent.acp", "process.exec", "human.approval", "model.chat"];

describe("InsertStepMenu", () => {
  it("titles the card INSERT STEP with a between subtitle in insert mode", () => {
    renderMenu();
    const card = screen.getByTestId("insert-step-menu");
    expect(card.textContent).toContain("INSERT STEP");
    expect(card.textContent).toContain("between Read and Write");
  });

  it("titles the card ADD STEP in add mode with no subtitle", () => {
    renderMenu({ mode: "add", between: undefined });
    const card = screen.getByTestId("insert-step-menu");
    expect(card.textContent).toContain("ADD STEP");
    expect(card.textContent).not.toContain("between");
  });

  it("lists the four step types in order", () => {
    renderMenu();
    const rows = screen.getAllByRole("menuitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Agent", "Command", "Approval", "Judge"]);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(
      KINDS.map((kind) => `insert-step-${kind}`),
    );
  });

  it("picks a kind on click", () => {
    const { onPick } = renderMenu();
    fireEvent.click(screen.getByTestId("insert-step-process.exec"));
    expect(onPick).toHaveBeenCalledWith("process.exec");
  });

  it("starts with the first row active and focused", () => {
    renderMenu();
    const first = screen.getByTestId(`insert-step-${KINDS[0]}`);
    expect(first.getAttribute("data-active")).toBe("true");
    expect(document.activeElement).toBe(first);
  });

  it("moves down with ArrowDown and picks with Enter", () => {
    const { onPick } = renderMenu();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByTestId("insert-step-human.approval").getAttribute("data-active")).toBe(
      "true",
    );
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("human.approval");
  });

  it("wraps up from the first row to Judge", () => {
    const { onPick } = renderMenu();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByTestId("insert-step-model.chat").getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("model.chat");
  });

  it("sends trimmed describe text on Enter", () => {
    const { onDescribe } = renderMenu();
    const input = screen.getByTestId("insert-step-describe");
    fireEvent.change(input, { target: { value: "  write a test for the parser  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDescribe).toHaveBeenCalledWith("write a test for the parser");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("ignores an empty or whitespace describe", () => {
    const { onDescribe } = renderMenu();
    const input = screen.getByTestId("insert-step-describe");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDescribe).not.toHaveBeenCalled();
  });

  it("does not render the input without onDescribe", () => {
    renderMenu({ onDescribe: undefined });
    expect(screen.queryByTestId("insert-step-describe")).toBeNull();
  });

  it("closes from × and from Escape", () => {
    const a = renderMenu();
    fireEvent.click(screen.getByTestId("beside-card-close"));
    expect(a.onClose).toHaveBeenCalledTimes(1);
    cleanup();

    const b = renderMenu();
    fireEvent.keyDown(screen.getByTestId("insert-step-menu"), { key: "Escape" });
    expect(b.onClose).toHaveBeenCalledTimes(1);
  });

  it("is 260 wide", () => {
    renderMenu();
    expect(screen.getByTestId("insert-step-menu").style.width).toBe("260px");
  });
});
