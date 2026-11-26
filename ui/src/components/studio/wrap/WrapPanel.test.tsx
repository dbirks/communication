import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrapPanel } from "./WrapPanel";

afterEach(cleanup);

describe("WrapPanel", () => {
  it("switches between Repeat until and Side by side by click and arrow keys", () => {
    render(
      <WrapPanel count={3} onWrapRepeat={vi.fn()} onWrapSideBySide={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("wrap-panel")).toBeTruthy();
    expect(screen.getByText("WRAP 3 STEPS IN")).toBeTruthy();

    const repeatTab = screen.getByTestId("wrap-tab-repeat");
    const sideTab = screen.getByTestId("wrap-tab-side");
    expect(repeatTab.getAttribute("aria-selected")).toBe("true");
    expect(sideTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(repeatTab, { key: "ArrowRight" });
    expect(sideTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/These steps run at the same time/)).toBeTruthy();

    fireEvent.keyDown(sideTab, { key: "ArrowLeft" });
    expect(repeatTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(sideTab);
    expect(sideTab.getAttribute("aria-selected")).toBe("true");
  });

  it("changes the field with the selected goal kind and disables Wrap until text is entered", () => {
    const onWrapRepeat = vi.fn();
    render(
      <WrapPanel
        count={3}
        onWrapRepeat={onWrapRepeat}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const submit = screen.getByTestId("wrap-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Default: judge -> textarea labelled "The goal"
    expect(screen.getByLabelText("The goal").tagName).toBe("TEXTAREA");

    // Switch to command -> mono input labelled "Command"
    fireEvent.click(screen.getByTestId("wrap-goal-command"));
    const cmdInput = screen.getByLabelText("Command") as HTMLInputElement;
    expect(cmdInput.tagName).toBe("INPUT");
    expect(submit.disabled).toBe(true);

    fireEvent.change(cmdInput, { target: { value: "pnpm test" } });
    expect(submit.disabled).toBe(false);

    // Switch to contains -> mono input labelled "Look for" (empty, so disabled again)
    fireEvent.click(screen.getByTestId("wrap-goal-contains"));
    const lookInput = screen.getByLabelText("Look for") as HTMLInputElement;
    expect(lookInput.tagName).toBe("INPUT");
    expect(submit.disabled).toBe(true);

    fireEvent.change(lookInput, { target: { value: "LGTM" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onWrapRepeat).toHaveBeenCalledWith({
      kind: "contains",
      text: "LGTM",
      maxRounds: 3,
    });
  });

  it("bounds the rounds stepper to 1..20 with default 3 and passes maxRounds", () => {
    const onWrapRepeat = vi.fn();
    render(
      <WrapPanel
        count={2}
        onWrapRepeat={onWrapRepeat}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const valueEl = screen.getByTestId("wrap-rounds-value");
    const dec = screen.getByTestId("wrap-rounds-dec") as HTMLButtonElement;
    const inc = screen.getByTestId("wrap-rounds-inc") as HTMLButtonElement;
    expect(valueEl.textContent).toBe("3");
    expect(valueEl.getAttribute("aria-live")).toBe("polite");

    // Decrement down to 1
    fireEvent.click(dec);
    fireEvent.click(dec);
    expect(valueEl.textContent).toBe("1");
    expect(dec.disabled).toBe(true);
    fireEvent.click(dec);
    expect(valueEl.textContent).toBe("1");

    // Increment up to 20
    for (let i = 0; i < 25; i += 1) {
      fireEvent.click(inc);
    }
    expect(valueEl.textContent).toBe("20");
    expect(inc.disabled).toBe(true);

    // Step down to 5 and submit judge
    for (let i = 0; i < 15; i += 1) {
      fireEvent.click(dec);
    }
    expect(valueEl.textContent).toBe("5");
    fireEvent.change(screen.getByLabelText("The goal"), {
      target: { value: "All checks pass" },
    });
    fireEvent.click(screen.getByTestId("wrap-submit"));
    expect(onWrapRepeat).toHaveBeenCalledWith({
      kind: "judge",
      text: "All checks pass",
      maxRounds: 5,
    });
  });

  it("disables an unsupported kind with its reason and selects the first supported kind", () => {
    render(
      <WrapPanel
        count={2}
        unsupported={{ judge: "Judge requires an LLM profile." }}
        onWrapRepeat={vi.fn()}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const judgeBtn = screen.getByTestId("wrap-goal-judge") as HTMLButtonElement;
    expect(judgeBtn.disabled).toBe(true);
    expect(screen.getByText("Judge requires an LLM profile.")).toBeTruthy();
    expect(screen.getByTestId("wrap-goal-command").getAttribute("aria-checked")).toBe("true");
  });

  it("fires onWrapSideBySide and onClose, and supports sheet layout", () => {
    const onWrapSideBySide = vi.fn();
    const onClose = vi.fn();
    render(
      <WrapPanel
        count={3}
        sheet
        onWrapRepeat={vi.fn()}
        onWrapSideBySide={onWrapSideBySide}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("wrap-panel").className).toContain("w-full");
    expect(screen.getByTestId("wrap-panel").className).toContain("rounded-t-[14px]");

    fireEvent.click(screen.getByTestId("wrap-tab-side"));
    fireEvent.click(screen.getByTestId("wrap-submit"));
    expect(onWrapSideBySide).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
