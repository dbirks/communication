import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLD_TO_TALK_MS, useHoldToTalk } from "./HoldToTalk";

function Harness({
  speechAvailable = true,
  onTap = vi.fn(),
  onHoldStart = vi.fn(),
  onHoldEnd = vi.fn(),
  onHoldCancel = vi.fn(),
}: {
  speechAvailable?: boolean;
  onTap?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  onHoldCancel?: () => void;
}) {
  useHoldToTalk({ speechAvailable, onTap, onHoldStart, onHoldEnd, onHoldCancel });
  return <input data-testid="other-input" type="text" />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHoldToTalk", () => {
  it("opens on tap (< 500ms) when K or the modifier is released before the timer fires", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    render(<Harness onTap={onTap} onHoldStart={onHoldStart} onHoldEnd={onHoldEnd} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(onTap).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS - 1);
    });
    expect(onHoldStart).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: "k", metaKey: true });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("also treats releasing the modifier before 500ms as a tap", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    render(<Harness onTap={onTap} onHoldStart={onHoldStart} />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.keyUp(window, { key: "Control" });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  it("starts dictation at 500ms without calling onTap, and sends on release", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    render(<Harness onTap={onTap} onHoldStart={onHoldStart} onHoldEnd={onHoldEnd} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    });
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: "Meta" });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat keydown events while holding", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    render(<Harness onTap={onTap} onHoldStart={onHoldStart} onHoldEnd={onHoldEnd} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true, repeat: false });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.keyDown(window, { key: "k", metaKey: true, repeat: true });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "k", metaKey: true, repeat: true });
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: "k" });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  it("cancels without sending on window blur while holding", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onHoldCancel = vi.fn();
    render(
      <Harness
        onTap={onTap}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onHoldCancel={onHoldCancel}
      />,
    );

    // Blur while still pending (< 500ms): cancels pending timer.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.blur(window);
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS + 100);
    });
    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();

    // Blur after hold started (>= 500ms): calls onHoldCancel and never onHoldEnd.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    });
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    fireEvent.blur(window);
    expect(onHoldCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { key: "k" });
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("never fires on a plain 'k' without the modifier, including inside a text field", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    render(<Harness onTap={onTap} onHoldStart={onHoldStart} />);

    const input = screen.getByTestId("other-input");
    input.focus();
    fireEvent.keyDown(input, { key: "k" });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS + 100);
    });
    fireEvent.keyUp(input, { key: "k" });
    expect(onTap).not.toHaveBeenCalled();
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  it("falls back immediately to a tap when speech is unavailable", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onHoldStart = vi.fn();
    render(<Harness speechAvailable={false} onTap={onTap} onHoldStart={onHoldStart} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(onTap).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS + 100);
    });
    expect(onHoldStart).not.toHaveBeenCalled();
  });
});
