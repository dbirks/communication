import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import ListeningBar from "./ListeningBar";
import MicButton from "./MicButton";

class FakeRecognition {}

afterEach(() => {
  cleanup();
  delete (window as any).webkitSpeechRecognition;
  vi.useRealTimers();
});

describe("MicButton", () => {
  it("renders nothing when the Web Speech API is absent", () => {
    const { container } = render(<MicButton listening={false} onToggle={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByLabelText("Start dictation")).toBeNull();
  });

  it("toggles aria-pressed and aria-label with listening state", () => {
    (window as any).webkitSpeechRecognition = FakeRecognition as any;
    const { rerender } = render(<MicButton listening={false} onToggle={() => {}} />);
    let button = screen.getByLabelText("Start dictation");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-testid")).toBe("mic-button");

    rerender(<MicButton listening onToggle={() => {}} />);
    button = screen.getByLabelText("Stop dictation");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onToggle once per click", () => {
    (window as any).webkitSpeechRecognition = FakeRecognition as any;
    const onToggle = vi.fn();
    render(<MicButton listening={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId("mic-button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("honours disabled", () => {
    (window as any).webkitSpeechRecognition = FakeRecognition as any;
    const onToggle = vi.fn();
    render(<MicButton listening={false} onToggle={onToggle} disabled />);
    fireEvent.click(screen.getByTestId("mic-button"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("ListeningBar", () => {
  it("shows the running transcript, a 0:00 timer and Done", () => {
    render(<ListeningBar interim="make the" final="reviewer" onDone={() => {}} />);
    expect(screen.getByTestId("listening-bar")).toBeTruthy();
    expect(screen.getByText("reviewer make the")).toBeTruthy();
    expect(screen.getByText("0:00")).toBeTruthy();
    expect(screen.getByTestId("listening-done")).toBeTruthy();
    expect(screen.getByTestId("listening-done").textContent).toBe("Done");
  });

  it("shows a placeholder while no transcript has arrived", () => {
    render(<ListeningBar interim="" final="" onDone={() => {}} />);
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it("counts the timer up while mounted", () => {
    vi.useFakeTimers();
    render(<ListeningBar interim="" final="" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByText("1:05")).toBeTruthy();
  });

  it("Done calls onDone", () => {
    const onDone = vi.fn();
    render(<ListeningBar interim="" final="hi" onDone={onDone} />);
    fireEvent.click(screen.getByTestId("listening-done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
