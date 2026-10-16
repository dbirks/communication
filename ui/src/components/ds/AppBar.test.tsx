/**
 * The app bar at phone width. Browser QA on a 390px viewport saw the run
 * page's document itself scrolling sideways — "Operations" at x=403, "Sign
 * out" at x=551 — because the 52px bar is a desktop measurement and five
 * section names plus the user area do not fit. jsdom knows nothing of layout
 * pixels, so this asserts the structure that makes wrapping possible: the row
 * and both shrinkable regions carry the wrap/min-w-0 classes, and the fixed
 * 52px height is restored only from `sm:` up.
 */
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppBar } from "./AppBar";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

const items = [
  { to: "/", label: "Projects", end: true },
  { to: "/library", label: "Library" },
  { to: "/runs", label: "Operations" },
  { to: "/conversations", label: "Conversations" },
  { to: "/settings", label: "Settings" },
];

function show() {
  return render(
    <MemoryRouter initialEntries={["/runs"]}>
      <AppBar items={items} right={<button type="button">Sign out</button>} />
    </MemoryRouter>,
  );
}

describe("AppBar at phone width", () => {
  it("the header row wraps instead of forcing the page wider", () => {
    const { container } = show();
    const row = container.querySelector("header > div");
    expect(row).toBeTruthy();
    const classes = row!.className;
    expect(classes).toContain("flex-wrap");
    // The desktop bar's 52px survives as a floor, the full height only from
    // `sm:` up — nothing pins the row to one non-wrapping line at 390px.
    expect(classes).toContain("min-h-[52px]");
    expect(classes).not.toMatch(/(^|\s)h-\[52px\]/);
  });

  it("the section track and the user area both shrink and wrap", () => {
    show();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("min-w-0");
    expect(nav.className).toContain("flex-wrap");
    // Every nav label is in the track: nothing is overflowing off its right
    // edge waiting for a viewport wide enough to reach it.
    expect(screen.getByRole("link", { name: "Operations" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Conversations" })).toBeTruthy();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    const userArea = signOut.parentElement;
    expect(userArea?.className).toContain("min-w-0");
    expect(userArea?.className).toContain("flex-wrap");
  });

  it("keeps the single 52px line at desktop widths", () => {
    const { container } = show();
    const row = container.querySelector("header > div");
    expect(row?.className).toContain("sm:h-[52px]");
    expect(row?.className).toContain("sm:flex-nowrap");
  });
});
