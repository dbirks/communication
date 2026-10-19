/**
 * SelectionToolbar tests: the wrap/unwrap actions of a step selection.
 * The model comes from parseGraph so `isScope`/`kind` are real, not faked.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { SelectionToolbar, unwrapTargetOf } from "./SelectionToolbar";

const YAML = `kind: Pipeline
spec:
  nodes:
    - id: impl
      kind: agent.acp
    - id: check
      kind: process.exec
      dependsOn: [impl]
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

afterEach(cleanup);

describe("SelectionToolbar", () => {
  it("renders nothing with an empty selection", () => {
    render(<SelectionToolbar selectedIds={[]} model={model()} onWrap={vi.fn()} />);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("shows the wrap actions when ≥1 step is selected and fires them", () => {
    const onWrap = vi.fn();
    render(<SelectionToolbar selectedIds={["impl", "check"]} model={model()} onWrap={onWrap} />);
    expect(screen.getByTestId("selection-toolbar")).toBeTruthy();
    expect(screen.getByTestId("selection-count").textContent).toBe("2 steps selected");
    fireEvent.click(screen.getByTestId("wrap-until"));
    expect(onWrap).toHaveBeenCalledWith("until");
    fireEvent.click(screen.getByTestId("wrap-for-each"));
    expect(onWrap).toHaveBeenCalledWith("for_each");
    // Neither selected node is a scope: no Unwrap.
    expect(screen.queryByTestId("unwrap-scope")).toBeNull();
  });

  it("offers Unwrap for a single selected repeat scope, not for a plain step", () => {
    const onUnwrap = vi.fn();
    render(
      <SelectionToolbar
        selectedIds={["fix_loop"]}
        model={model()}
        onWrap={vi.fn()}
        onUnwrap={onUnwrap}
      />,
    );
    fireEvent.click(screen.getByTestId("unwrap-scope"));
    expect(onUnwrap).toHaveBeenCalledWith("fix_loop");
    cleanup();
    render(<SelectionToolbar selectedIds={["impl"]} model={model()} onUnwrap={onUnwrap} />);
    expect(screen.queryByTestId("unwrap-scope")).toBeNull();
    cleanup();
    render(
      <SelectionToolbar selectedIds={["fix_loop", "impl"]} model={model()} onUnwrap={onUnwrap} />,
    );
    expect(screen.queryByTestId("unwrap-scope")).toBeNull();
  });

  it("readonly: wrap buttons disabled, no Unwrap", () => {
    render(
      <SelectionToolbar
        selectedIds={["fix_loop"]}
        model={model()}
        readOnly
        onWrap={vi.fn()}
        onUnwrap={vi.fn()}
      />,
    );
    expect((screen.getByTestId("wrap-until") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("wrap-for-each") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("unwrap-scope")).toBeNull();
  });

  it("panel and outline variants use their own testids", () => {
    const onWrap = vi.fn();
    render(
      <SelectionToolbar variant="panel" selectedIds={["impl"]} model={model()} onWrap={onWrap} />,
    );
    expect(screen.getByTestId("multi-selection-actions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("multi-wrap-until"));
    expect(onWrap).toHaveBeenCalledWith("until");
    expect(screen.queryByTestId("wrap-until")).toBeNull();
    render(
      <SelectionToolbar variant="outline" selectedIds={["impl"]} model={model()} onWrap={onWrap} />,
    );
    expect(screen.getByTestId("outline-selection-actions")).toBeTruthy();
    expect(screen.getByTestId("outline-wrap-for-each")).toBeTruthy();
  });

  it("unwrapTargetOf: only a single until / for_each scope unwraps", () => {
    const m = model();
    expect(unwrapTargetOf(m, ["fix_loop"])).toBe("fix_loop");
    expect(unwrapTargetOf(m, ["impl"])).toBeNull();
    expect(unwrapTargetOf(m, ["impl", "check"])).toBeNull();
    expect(unwrapTargetOf(m, [])).toBeNull();
  });
});
