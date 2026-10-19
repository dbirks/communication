/**
 * The workbench's runtime-instance selectors (ADR-0043 decision 1): `until`
 * gets one chip per observed iteration, `for_each` a paged, state-filterable
 * item list. `scopeInstances` rolls the journal's rows up to one state per
 * instance with the same precedence the scope box uses.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";
import { InstancePicker, scopeInstances } from "./InstancePicker";

const row = (key: string, status: NodeExecutionSummary["status"]): NodeExecutionSummary =>
  ({ node_instance_key: key, status }) as unknown as NodeExecutionSummary;

afterEach(cleanup);

describe("scopeInstances", () => {
  it("rolls the rows under each instance up with the failure-first precedence", () => {
    const nodes = [
      row("/loop[1]/implement", "running"),
      row("/loop[1]/test", "succeeded"),
      row("/loop[2]/implement", "failed"),
      row("/loop[2]/test", "running"),
      // A body row outside every iteration is not an instance and is skipped.
      row("/loop", "running"),
    ];
    const instances = scopeInstances(nodes, "/loop");
    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({ index: 1, key: "/loop[1]", state: "running" });
    expect(instances[1]).toMatchObject({ index: 2, key: "/loop[2]", state: "failed" });
  });
});

describe("InstancePicker", () => {
  it("until: one chip per iteration, and the pick toggles through onSelect", () => {
    const onSelect = vi.fn();
    const instances = scopeInstances(
      [row("/loop[1]/implement", "running"), row("/loop[2]/implement", "failed")],
      "/loop",
    );
    const first = render(
      <InstancePicker
        scopeId="loop"
        defKey="/loop"
        kind="until"
        instances={instances}
        selected={null}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId("instance-picker-loop")).toBeTruthy();
    expect(screen.getByTestId("instance-loop-1").textContent).toBe("Iteration 1 · running");
    expect(screen.getByTestId("instance-loop-2").textContent).toBe("Iteration 2 · failed");
    expect(screen.queryByTestId("instance-loop-latest")).toBeNull();

    fireEvent.click(screen.getByTestId("instance-loop-1"));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    // Pressed state is the URL's selection, fed back by the page.
    first.unmount();
    render(
      <InstancePicker
        scopeId="loop"
        defKey="/loop"
        kind="until"
        instances={instances}
        selected={1}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId("instance-loop-1").getAttribute("aria-pressed")).toBe("true");
    // Re-picking the raised chip goes back to the aggregate.
    fireEvent.click(screen.getByTestId("instance-loop-1"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    // …as does the explicit latest.
    fireEvent.click(screen.getByTestId("instance-loop-latest"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("for_each: pages 25 items twenty per page, with live counts", () => {
    const items = Array.from({ length: 25 }, (_, i) => {
      const n = i + 1;
      return row(
        `/verify_each[${n}]/check_module`,
        n === 2 ? "failed" : n > 20 ? "running" : "succeeded",
      );
    });
    const instances = scopeInstances(items, "/verify_each");
    render(
      <InstancePicker
        scopeId="verify_each"
        defKey="/verify_each"
        kind="for_each"
        instances={instances}
        selected={null}
        onSelect={() => {}}
      />,
    );

    const picker = screen.getByTestId("instance-picker-verify_each");
    expect(picker.textContent).toContain("25 items");
    expect(picker.textContent).toMatch(/1\s+×\s+failed/);
    expect(picker.textContent).toMatch(/5\s+●\s+running/);
    expect(picker.textContent).toMatch(/19\s+✓\s+done/);

    // Page 1: the first twenty, in item order; item 21 waits for page 2.
    expect(screen.getByTestId("instance-verify_each-20")).toBeTruthy();
    expect(screen.queryByTestId("instance-verify_each-21")).toBeNull();
    expect(screen.getByTestId("instance-verify_each-page").textContent).toBe("1 of 2");
    expect((screen.getByTestId("instance-verify_each-prev") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId("instance-verify_each-next") as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByTestId("instance-verify_each-next"));
    expect(screen.getByTestId("instance-verify_each-21")).toBeTruthy();
    expect(screen.queryByTestId("instance-verify_each-20")).toBeNull();
    expect(screen.getByTestId("instance-verify_each-page").textContent).toBe("2 of 2");
    expect((screen.getByTestId("instance-verify_each-next") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("for_each: the state filter narrows the list and resets the page", () => {
    const items = Array.from({ length: 25 }, (_, i) => {
      const n = i + 1;
      return row(
        `/verify_each[${n}]/check_module`,
        n === 2 ? "failed" : n > 20 ? "running" : "succeeded",
      );
    });
    const instances = scopeInstances(items, "/verify_each");
    render(
      <InstancePicker
        scopeId="verify_each"
        defKey="/verify_each"
        kind="for_each"
        instances={instances}
        selected={null}
        onSelect={(index) => expect(index).toBe(2)}
      />,
    );

    // Move to page 2, then narrow to failures: only item 2 remains and the
    // pager disappears with it.
    fireEvent.click(screen.getByTestId("instance-verify_each-next"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "failed" } });

    const chips = screen.getAllByTestId(/^instance-verify_each-\d+$/);
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("data-testid")).toBe("instance-verify_each-2");
    expect(chips[0].textContent).toBe("Item 2 · failed");
    expect(screen.queryByTestId("instance-verify_each-page")).toBeNull();

    // The filter does not hide the counts — all 25 items are still the truth.
    expect(screen.getByTestId("instance-picker-verify_each").textContent).toContain("25 items");

    fireEvent.click(chips[0]);
  });
});
