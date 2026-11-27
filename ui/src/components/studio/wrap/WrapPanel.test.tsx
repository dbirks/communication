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

  it("renders only the reason sentence when reason is provided", () => {
    render(
      <WrapPanel
        count={2}
        reason="Selected steps must be contiguous without gaps."
        onWrapRepeat={vi.fn()}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("wrap-panel-reason").textContent).toBe(
      "Selected steps must be contiguous without gaps.",
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("wrap-submit")).toBeNull();
  });

  it("shows the helper sentence, compact right-aligned Wrap button on the rounds row, and prototype choice borders", () => {
    const { unmount } = render(
      <WrapPanel count={3} onWrapRepeat={vi.fn()} onWrapSideBySide={vi.fn()} onClose={vi.fn()} />,
    );

    // 1. Helper sentence directly under the segmented control on the Repeat tab.
    expect(screen.getByTestId("wrap-repeat-helper").textContent).toBe(
      "Run these again until the goal is met.",
    );
    expect(screen.getByTestId("wrap-repeat-helper").className).toContain("text-[12.5px]");

    // 2. Compact, right-aligned primary Wrap button (no longer full width).
    const submit = screen.getByTestId("wrap-submit");
    expect(submit.className).toContain("ds-btn--primary");
    expect(submit.className).not.toContain("w-full");

    // 3. Wrap button shares the rounds row with the "rounds" text.
    const roundsText = screen.getByText("rounds");
    expect(roundsText.parentElement).toBe(submit.parentElement);
    expect(submit.parentElement?.className).toContain("whitespace-nowrap");
    expect(submit.className).toContain("ml-auto");

    // 4. Choice borders: selected accent, unselected transparent.
    expect(screen.getByTestId("wrap-goal-judge").className).toContain("border-accent");
    expect(screen.getByTestId("wrap-goal-command").className).toContain("border-transparent");
    expect(screen.getByTestId("wrap-goal-contains").className).toContain("border-transparent");
    unmount();

    // The helper and the compact Wrap button also show in edit mode.
    render(
      <WrapPanel
        count={1}
        mode="edit"
        initialGoal={{ kind: "judge", text: "Tests pass", maxRounds: 2 }}
        onWrapRepeat={vi.fn()}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("wrap-repeat-helper").textContent).toBe(
      "Run these again until the goal is met.",
    );
    expect(screen.getByTestId("wrap-submit").className).toContain("ds-btn--primary");
    expect(screen.getByTestId("wrap-submit").className).not.toContain("w-full");
  });

  it("offers Side by side only when two or more steps are selected", () => {
    render(
      <WrapPanel count={1} onWrapRepeat={vi.fn()} onWrapSideBySide={vi.fn()} onClose={vi.fn()} />,
    );
    const side = screen.getByTestId("wrap-tab-side") as HTMLButtonElement;
    expect(side.disabled).toBe(true);
    expect(side.title).toBe("Select two or more steps to run them side by side");
    fireEvent.click(side);
    expect(screen.getByTestId("wrap-tab-repeat").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the side-by-side Wrap button compact and right-aligned", () => {
    render(
      <WrapPanel count={3} onWrapRepeat={vi.fn()} onWrapSideBySide={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("wrap-tab-side"));
    const submit = screen.getByTestId("wrap-submit");
    expect(submit.className).toContain("ds-btn--primary");
    expect(submit.className).not.toContain("w-full");
    expect(submit.parentElement?.className).toContain("flex");
    expect(submit.parentElement?.className).toContain("justify-end");
  });

  it("supports edit mode with prefilled goal, Update button, More settings link, and Unwrap link", () => {
    const onWrapRepeat = vi.fn();
    const onUnwrap = vi.fn();
    const onMoreSettings = vi.fn();
    render(
      <WrapPanel
        count={3}
        mode="edit"
        initialGoal={{ kind: "command", text: "pnpm test", maxRounds: 5 }}
        onUnwrap={onUnwrap}
        onMoreSettings={onMoreSettings}
        onWrapRepeat={onWrapRepeat}
        onWrapSideBySide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect((screen.getByTestId("wrap-goal-input") as HTMLInputElement).value).toBe("pnpm test");
    expect(screen.getByTestId("wrap-rounds-value").textContent).toBe("5");
    expect(screen.getByTestId("wrap-submit").textContent).toBe("Update");
    fireEvent.click(screen.getByTestId("wrap-submit"));
    expect(onWrapRepeat).toHaveBeenCalledWith({
      kind: "command",
      text: "pnpm test",
      maxRounds: 5,
    });
    fireEvent.click(screen.getByTestId("goal-card-more-settings"));
    expect(onMoreSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("goal-unwrap"));
    expect(onUnwrap).toHaveBeenCalledTimes(1);
  });
});
