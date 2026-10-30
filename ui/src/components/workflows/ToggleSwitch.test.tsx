/**
 * The shared on/off switch every trigger and schedule row uses. The contract is
 * the 390px defect that produced it (the phone's 44px touch floor stretching a
 * pill into an oval) plus the two things the suites locate the control by: the
 * native `checked` value and the `switch` role with its accessible name.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./ToggleSwitch";

afterEach(cleanup);

describe("ToggleSwitch", () => {
  it("is a checkbox wearing the switch role in a fixed 28×16 track", () => {
    render(<ToggleSwitch checked testid="x-enabled" onChange={() => undefined} />);
    const track = screen.getByTestId("x-enabled");
    expect(track.tagName).toBe("INPUT");
    expect(track.getAttribute("type")).toBe("checkbox");
    // `input[type=checkbox]` is what tokens.css's phone floor exempts, so the
    // track keeps its shape and the label around it takes the 44px target.
    expect(track.getAttribute("role")).toBe("switch");
    expect(track.getAttribute("aria-checked")).toBe("true");
    expect((track as HTMLInputElement).checked).toBe(true);
    for (const cls of ["h-[16px]", "w-[28px]", "shrink-0", "appearance-none", "rounded-full"]) {
      expect(track.className).toContain(cls);
    }
    // The hit area is the label, never the pill itself.
    const line = track.parentElement as HTMLElement;
    expect(line.tagName).toBe("LABEL");
    expect(line.className).toContain("whitespace-nowrap");
  });

  it("says the state in a word as well as a colour, under its own test id", () => {
    render(<ToggleSwitch checked={false} testid="x-enabled" onChange={() => undefined} />);
    expect(screen.getByTestId("x-enabled-state").textContent).toBe("paused");
    cleanup();

    render(
      <ToggleSwitch
        checked
        testid="y-enabled"
        stateTestid="y-state"
        stateWords={["on the clock", "held"]}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByTestId("y-state").textContent).toBe("on the clock");
    expect(screen.queryByTestId("y-enabled-state")).toBeNull();
  });

  it("names itself for the state by default, and for the row when told to", () => {
    render(<ToggleSwitch checked testid="a" onChange={() => undefined} />);
    expect(screen.getByTestId("a").getAttribute("aria-label")).toBe("pause this trigger");
    cleanup();
    render(<ToggleSwitch checked={false} testid="b" onChange={() => undefined} />);
    expect(screen.getByTestId("b").getAttribute("aria-label")).toBe("turn this trigger on");
    cleanup();
    render(
      <ToggleSwitch
        checked
        testid="c"
        labels={[`schedule payments on`, `schedule payments off`]}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByTestId("c").getAttribute("aria-label")).toBe("schedule payments on");
  });

  it("reports the value the control now holds, not the one it started with", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked testid="d" onChange={onChange} />);
    const track = screen.getByTestId("d");
    fireEvent.click(track); // a click on a checkbox flips it before the change
    expect(onChange).toHaveBeenCalledWith(false);
    cleanup();

    const onChange2 = vi.fn();
    render(<ToggleSwitch checked={false} testid="e" onChange={onChange2} />);
    fireEvent.click(screen.getByTestId("e"));
    expect(onChange2).toHaveBeenCalledWith(true);
  });
});
