import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ListeningCapsule from "./ListeningCapsule";

/**
 * The listening capsule (redesign review-1 findings 48/49): mic disc + waveform
 * on the left, live transcript (or phase words) in the middle, Stop on the right.
 * It lives in normal flow so it never covers the answer above it.
 */

afterEach(() => {
  cleanup();
});

describe("ListeningCapsule", () => {
  it("shows the live transcript in curly quotes with the mic disc, waveform and working Stop", () => {
    const onStop = vi.fn();
    render(<ListeningCapsule phase="recording" liveTranscript="what is running" onStop={onStop} />);

    const capsule = screen.getByTestId("listening-capsule");
    expect(capsule.textContent).toContain("“what is running…”");
    expect(capsule.textContent).not.toContain("Listening…");

    // Mic disc replaces the old amber dot and keeps the pulse while recording.
    const dot = screen.getByTestId("listening-capsule-dot");
    expect(dot.className).toContain("bg-accent");
    expect(dot.className).toContain("quick-chat-listening-dot");

    // Four waveform bars.
    const bars = screen.getByTestId("listening-capsule-waveform").children;
    expect(bars).toHaveLength(4);

    const stop = screen.getByTestId("listening-capsule-stop");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows the listening words when there is no transcript yet", () => {
    render(<ListeningCapsule phase="recording" liveTranscript="" onStop={() => undefined} />);
    const capsule = screen.getByTestId("listening-capsule");
    expect(capsule.textContent).toContain("Listening…");
    expect(capsule.textContent).not.toContain("“");
  });

  it("shows the transcribing wording with model and no Stop button", () => {
    render(
      <ListeningCapsule phase="transcribing" model="whisper-large" onStop={() => undefined} />,
    );
    const capsule = screen.getByTestId("listening-capsule");
    expect(capsule.textContent).toContain("Transcribing · whisper-large…");
    expect(screen.queryByTestId("listening-capsule-stop")).toBeNull();
    // No pulse animation outside the recording phase.
    expect(screen.getByTestId("listening-capsule-dot").className).not.toContain(
      "quick-chat-listening-dot",
    );
  });

  it("shows the notice and renders nothing when idle", () => {
    const { rerender } = render(
      <ListeningCapsule phase="idle" notice="Didn't catch that." onStop={() => undefined} />,
    );
    expect(screen.getByTestId("listening-capsule").textContent).toContain("Didn't catch that.");

    rerender(<ListeningCapsule phase="idle" onStop={() => undefined} />);
    expect(screen.queryByTestId("listening-capsule")).toBeNull();
  });
});
