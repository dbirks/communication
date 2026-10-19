/**
 * StepOutline tests: the <1024px fallback list. The checkbox per step
 * toggles the same multi-selection the canvas' Shift+click builds, the
 * outline SelectionToolbar offers the wrap/unwrap actions to
 * keyboard / narrow users, and the per-step "+" opens the same
 * StepPicker the canvas' "+" opens.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { StepOutline } from "./StepOutline";

const YAML = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
    - id: check
      kind: process.exec
      dependsOn: [plan]
    - id: fix_loop
      kind: until
      config:
        body:
          nodes:
            - id: inner
              kind: agent.acp
              config:
                prompt: fix it
      dependsOn: [check]
`;

function model() {
  const parsed = parseGraph(YAML);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.model;
}

const props = {
  readOnly: false,
  onToggleSelect: vi.fn(),
  onSelect: vi.fn(),
  onAddAfter: vi.fn(),
  onWrap: vi.fn(),
  onUnwrap: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StepOutline", () => {
  it("lists every step indented by its scope depth and selects on click", () => {
    render(<StepOutline model={model()} selectedId={null} {...props} />);
    // Scope path: root steps at depth 0, `inner` at depth 1.
    const plan = screen.getByTestId("step-outline-plan");
    const inner = screen.getByTestId("step-outline-inner");
    expect(plan.style.paddingLeft).toBe("0px");
    expect(inner.style.paddingLeft).toBe("14px");
    fireEvent.click(screen.getByTestId("step-outline-check"));
    expect(props.onSelect).toHaveBeenCalledWith("check");
    // Clicking the selected row again clears the selection.
    cleanup();
    render(<StepOutline model={model()} selectedId="check" {...props} />);
    fireEvent.click(screen.getByTestId("step-outline-check"));
    expect(props.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("checkboxes toggle the multi-selection and check the selected rows", () => {
    render(<StepOutline model={model()} selectedId={null} selectedIds={["plan"]} {...props} />);
    expect((screen.getByTestId("step-outline-select-plan") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("step-outline-select-check") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("step-outline-select-check"));
    expect(props.onToggleSelect).toHaveBeenCalledWith("check");
    // Two checked → the outline selection actions appear.
    cleanup();
    render(
      <StepOutline model={model()} selectedId={null} selectedIds={["plan", "check"]} {...props} />,
    );
    expect(
      within(screen.getByTestId("outline-selection-actions")).getByTestId("outline-wrap-until"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("outline-wrap-until"));
    expect(props.onWrap).toHaveBeenCalledWith("until");
  });

  it("offers Unwrap in the outline actions for a single selected scope", () => {
    render(<StepOutline model={model()} selectedId={null} selectedIds={["fix_loop"]} {...props} />);
    fireEvent.click(screen.getByTestId("outline-unwrap-scope"));
    expect(props.onUnwrap).toHaveBeenCalledWith("fix_loop");
    // A plain step (or a multi-selection) gets no Unwrap.
    cleanup();
    render(<StepOutline model={model()} selectedId={null} selectedIds={["plan"]} {...props} />);
    expect(screen.queryByTestId("outline-unwrap-scope")).toBeNull();
  });

  it("the per-step + opens the picker and picks the same onAddAfter the canvas uses", () => {
    render(<StepOutline model={model()} selectedId={null} {...props} />);
    fireEvent.click(screen.getByTestId("step-outline-add-check"));
    const picker = screen.getByTestId("step-picker");
    fireEvent.click(within(picker).getByTestId("step-picker-item-process.exec"));
    expect(props.onAddAfter).toHaveBeenCalledWith("check", [], "process.exec");
  });

  it("read-only: no checkboxes toggling, no + buttons, no actions", () => {
    render(
      <StepOutline
        model={model()}
        selectedId={null}
        selectedIds={["plan"]}
        readOnly
        onToggleSelect={undefined}
        onSelect={vi.fn()}
        onAddAfter={vi.fn()}
      />,
    );
    expect((screen.getByTestId("step-outline-select-plan") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByTestId("step-outline-add-plan")).toBeNull();
    expect(
      (
        within(screen.getByTestId("outline-selection-actions")).getByTestId(
          "outline-wrap-until",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
