/**
 * PromptBox / PromptChip shape checks (rx-h3):
 * - the send button is a 32px CIRCLE at every viewport width: fixed 32×32,
 *   rounded-full, and `data-round` — the attribute tokens.css exempts it with
 *   from the phone 44px touch-target floor (which would stretch it into a
 *   capsule) while a transparent ::before keeps the 44px hit area.
 * - the chip label is 12.5px/600 text-ink in the UI font, and `chevron` adds
 *   the trailing 12px muted chevron that marks a chip as a menu trigger.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { PromptBox, PromptChip } from "./PromptBox";

function renderBox(props: Partial<Parameters<typeof PromptBox>[0]> = {}) {
  const sent: string[] = [];
  function Box() {
    const [value, setValue] = useState("");
    return (
      <main>
        <PromptBox
          label="Ask something"
          placeholder="Ask…"
          value={value}
          onChange={setValue}
          onSubmit={(text) => sent.push(text)}
          {...props}
        />
      </main>
    );
  }
  render(<Box />);
  return sent;
}

afterEach(cleanup);

describe("PromptBox send button", () => {
  it("is a 32px circle and opts out of the phone floor with data-round", () => {
    renderBox();
    const send = screen.getByTestId("prompt-box-send");
    expect(send.getAttribute("data-round")).toBe("true");
    // Rounded BTN-I, round variant: 32×32, radius 999, primary border and
    // 2px offset shadow (tokens.css `.ds-btn--round`).
    for (const cls of ["ds-btn", "ds-btn--primary", "ds-btn--round", "shrink-0"]) {
      expect(send.className).toContain(cls);
    }
    // A fixed 32×32 box: no min-height/padding utility that could stretch it.
    expect(send.className).not.toMatch(/min-h-\[/);
  });

  it("is disabled while empty and sends the trimmed text once there is one", () => {
    const sent = renderBox();
    const send = screen.getByTestId("prompt-box-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("prompt-box-input"), { target: { value: "  hi  " } });
    const next = screen.getByTestId("prompt-box-send") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(sent).toEqual(["hi"]);
  });
});

describe("PromptChip", () => {
  it("labels itself 12.5px/600 text-ink in the UI font", () => {
    render(<PromptChip testid="chip">Widgets</PromptChip>);
    const chip = screen.getByTestId("chip");
    expect(chip.className).toContain("font-ui");
    const label = chip.querySelector("span") as HTMLElement;
    expect(label.textContent).toBe("Widgets");
    for (const cls of ["text-[12.5px]", "font-semibold", "text-ink"]) {
      expect(label.className).toContain(cls);
    }
  });

  it("shows the 12px muted chevron only when asked", () => {
    render(
      <>
        <PromptChip testid="menu-chip" chevron>
          Project
        </PromptChip>
        <PromptChip testid="action-chip">or run a workflow</PromptChip>
      </>,
    );
    const chevron = screen
      .getByTestId("menu-chip")
      .querySelector("svg") as unknown as SVGElement | null;
    expect(chevron?.getAttribute("class")).toContain("tabler-icon-chevron-down");
    expect(chevron?.getAttribute("class")).toContain("text-muted");
    expect(screen.getByTestId("menu-chip").querySelectorAll("svg").length).toBe(1);
    expect(screen.getByTestId("action-chip").querySelector("svg")).toBeNull();
  });
});
