/**
 * The phone's chat details sheet (rcn-chat-rail-390): the sheet chrome
 * keeps the shell's mobile-drawer contract — it floats above the page,
 * the backdrop closes it, Esc closes it, and focus moves into it on open
 * (the close button is where the keyboard lands). The page returns focus
 * to its toggle on close (`closeDetails`), so the contract tested here is
 * the sheet's own half: open → focused; any of the three close ways →
 * `onClose` exactly once.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatDetailsSheet } from "./ChatDetailsSheet";

afterEach(cleanup);

function panelChildren() {
  return <div data-testid="fake-side-panel">the panel content</div>;
}

describe("ChatDetailsSheet", () => {
  it("renders nothing while closed", () => {
    const onClose = vi.fn();
    render(
      <ChatDetailsSheet open={false} onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    expect(screen.queryByTestId("chat-details-sheet")).toBeNull();
    expect(screen.queryByTestId("chat-details-backdrop")).toBeNull();
    expect(screen.queryByTestId("chat-details-overlay")).toBeNull();
    // Closed, it listens to nothing either — not even to a real keydown
    // path (body → document → window).
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens as a right-side dialog carrying the caller's content", () => {
    render(
      <ChatDetailsSheet open onClose={() => {}}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    const sheet = screen.getByTestId("chat-details-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    const classes = sheet.className.split(/\s+/);
    expect(classes).toContain("inset-y-0");
    expect(classes).toContain("right-0");
    // The brief's width: full height, never wider than 22rem, no wider
    // than the viewport (a 390px phone gets the whole width — no
    // horizontal overflow).
    expect(classes).toContain("max-w-[22rem]");
    expect(classes).toContain("w-[min(22rem,100vw)]");
    expect(screen.getByTestId("chat-details-backdrop")).toBeTruthy();
    expect(screen.getByTestId("fake-side-panel")).toBeTruthy();
    expect(screen.getByTestId("chat-details-close")).toBeTruthy();
  });

  it("moves focus into the sheet on open — the close button is where the keyboard lands", () => {
    render(
      <ChatDetailsSheet open onClose={() => {}}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("chat-details-close"));
  });

  it("closes from its close button, and the backdrop click closes too", () => {
    const onClose = vi.fn();
    render(
      <ChatDetailsSheet open onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    fireEvent.click(screen.getByTestId("chat-details-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("chat-details-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Esc closes — and only while it stands", () => {
    const onClose = vi.fn();
    render(
      <ChatDetailsSheet open onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Other keys are the page's business.
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The emulator's flake (repo-chat-nav rcn-2e): the capture helper resizes
  // 390 → 1280 (where the page gates `open` on the viewport, so the sheet's
  // DOM unmounts and its listener detaches) → back to 390, and presses
  // Escape with focus on body. The remounted sheet must be Esc-closable
  // from its first frame — the listener attaches in the mount commit
  // (layout effect), not after paint.
  it("closes on Esc after a viewport round-trip remount, with focus on body", () => {
    const onClose = vi.fn();
    const sheet = (
      <ChatDetailsSheet open onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>
    );
    const { rerender } = render(sheet);
    // Desktop frame: the caller's `open` gate flips false, the sheet's DOM
    // and listener go away, and focus falls back to body.
    rerender(
      <ChatDetailsSheet open={false} onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    expect(screen.queryByTestId("chat-details-sheet")).toBeNull();
    // Back to the phone frame: the sheet remounts ALREADY open and the
    // very next Escape — pressed while focus sits on body, never having
    // entered the sheet — must close it.
    rerender(sheet);
    expect(screen.getByTestId("chat-details-sheet")).toBeTruthy();
    // The mount focus lands on the close button; force the keyboard back to
    // body — the emulator's state after the 1280 unmount — for this case.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes even when a focused child inside the sheet holds the keyboard", () => {
    // The sheet's close button has focus on mount; the keydown originates
    // there (bubbling to document), which is the real browser path.
    const onClose = vi.fn();
    render(
      <ChatDetailsSheet open onClose={onClose}>
        {panelChildren()}
      </ChatDetailsSheet>,
    );
    const close = screen.getByTestId("chat-details-close");
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
