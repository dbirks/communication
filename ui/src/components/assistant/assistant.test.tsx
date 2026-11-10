import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ListeningBar, { TranscribingRow } from "./ListeningBar";
import MicButton from "./MicButton";

/**
 * The two mic surfaces: the 30px button's three phases, and the in-box
 * recording/transcribing rows. The dictation state machine itself
 * (`useDictation`) is driven through the composer in `Composer.test.tsx`.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MicButton", () => {
  it("is present with no dictation API at all — the server does the reading", () => {
    const { container } = render(<MicButton phase="idle" onToggle={() => {}} />);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute("data-testid")).toBe("mic-button");
    expect(button.title).toBe("Dictate (adds to the end)");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // Tabler's icon, never a Unicode glyph.
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.textContent?.trim()).toBe("");
  });

  it("turns into the stop control while recording", () => {
    const { rerender } = render(<MicButton phase="idle" onToggle={() => {}} />);
    rerender(<MicButton phase="recording" onToggle={() => {}} />);
    const button = screen.getByTestId("mic-button") as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.title).toBe("Stop and transcribe");
    expect(button.className).toContain("bg-st-failed-strong");
  });

  it("waits, disabled, while the clip is at the server", () => {
    const onToggle = vi.fn();
    render(<MicButton phase="transcribing" onToggle={onToggle} />);
    const button = screen.getByTestId("mic-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Transcribing…");
    expect(button.className).toContain("bg-disabled-bg");
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("honours disabled (a turn is in flight) and toggles once per tap", () => {
    const onToggle = vi.fn();
    render(<MicButton phase="idle" onToggle={onToggle} disabled />);
    fireEvent.click(screen.getByTestId("mic-button"));
    expect(onToggle).not.toHaveBeenCalled();

    onToggle.mockClear();
    render(<MicButton phase="recording" onToggle={onToggle} />);
    const mic = screen.getAllByTestId("mic-button")[1];
    fireEvent.click(mic);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("ListeningBar", () => {
  it("draws 28 bars and the m:ss clock", () => {
    render(<ListeningBar seconds={65} />);
    const bar = screen.getByTestId("listening-bar");
    // one wrapper + 28 bars
    expect(bar.querySelectorAll("span:not([class])")).toHaveLength(28);
    expect(bar.textContent).toContain("1:05");
    expect(bar.getAttribute("aria-label")).toBe("Recording 1:05");
  });

  it("counts with the caller's clock, formatted as m:ss", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ListeningBar seconds={0} />);
    expect(screen.getByTestId("listening-bar").textContent).toContain("0:00");
    rerender(<ListeningBar seconds={125} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("listening-bar").textContent).toContain("2:05");
  });

  it("names the speech model while the clip is transcribing", () => {
    render(<TranscribingRow model="qwen3-asr-1-7b" />);
    expect(screen.getByTestId("transcribing-row").textContent).toBe(
      "transcribing · qwen3-asr-1-7b…",
    );
    // The glyph is Tabler's wave-sine svg, not a character.
    expect(screen.getByTestId("transcribing-row").querySelector("svg")).toBeTruthy();
  });

  it("says only `transcribing…` when the server names no speech model", () => {
    render(<TranscribingRow model={null} />);
    expect(screen.getByTestId("transcribing-row").textContent).toBe("transcribing…");
  });
});
