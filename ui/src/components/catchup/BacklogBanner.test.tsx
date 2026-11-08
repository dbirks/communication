/**
 * Big-backlog banner contract (acceptance 42524332059, `cu-8a-backlog`): the
 * 38px one-line banner is the DESKTOP layout only. At phone width (< 768px)
 * the nowrap text plus the shrink-0 buttons made the page scroll sideways —
 * scrollWidth 692px against a 390px viewport — so below the md breakpoint the
 * row wraps: text on its own lines (`min-w-0`, no base `whitespace-nowrap`),
 * the two buttons on a row below (`w-full`, buttons right-aligned), while
 * `md:` restores the exact one-line 38px bar. Threshold behavior (> 12 unseen)
 * is the banner's other half and stays asserted here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BACKLOG_BANNER_THRESHOLD, BacklogBanner } from "./BacklogBanner";

const noop = () => undefined;

function mount(unseen: number) {
  render(
    <BacklogBanner
      unseen={unseen}
      days={6}
      tourStops={8}
      suggestedWindow="24h"
      onNarrow={noop}
      onKeepAll={noop}
    />,
  );
  return screen.queryByTestId("catchup-banner");
}

/** The banner's own class tokens — bare, so `md:` variants never match. */
function classes(target: Element | null): string[] {
  return (target?.className ?? "").split(/\s+/);
}

afterEach(cleanup);

describe("BacklogBanner", () => {
  it("is absent at or under the threshold and present above it", () => {
    expect(mount(BACKLOG_BANNER_THRESHOLD)).toBeNull();
    expect(mount(BACKLOG_BANNER_THRESHOLD + 1)).not.toBeNull();
  });

  it("says the pile's numbers and the suggested window", () => {
    const banner = mount(13);
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("13 unseen over 6 days.");
    expect(banner?.textContent).toContain("Narrow to the last 24h?");
    expect(screen.getByTestId("catchup-banner-narrow-24h")).toBeDefined();
    expect(screen.getByTestId("catchup-banner-keep-all")).toBeDefined();
  });

  it("wraps at phone width instead of pushing the page sideways", () => {
    const banner = mount(13);
    expect(banner).not.toBeNull();
    // The row may wrap, and its fixed 38px height is desktop-only.
    expect(banner!.className).toContain("flex-wrap");
    const row = classes(banner);
    expect(row).not.toContain("h-[38px]");
    expect(row).toContain("md:h-[38px]");
    // The text breaks inside its own cell: min-w-0, and NO base nowrap.
    const text = banner!.querySelector("span");
    expect(text).not.toBeNull();
    expect(classes(text)).toContain("min-w-0");
    expect(classes(text)).not.toContain("whitespace-nowrap");
    expect(classes(text)).toContain("md:whitespace-nowrap");
    // The buttons ride a full-width row below on phone, inline on desktop.
    const buttons = screen.getByTestId("catchup-banner-keep-all").closest("span");
    expect(buttons).not.toBeNull();
    const buttonRow = classes(buttons);
    expect(buttonRow).toContain("w-full");
    expect(buttonRow).toContain("md:w-auto");
    expect(buttonRow).toContain("justify-end");
    expect(buttonRow).toContain("md:ml-auto");
  });

  it("keeps the one-line 38px layout at desktop width", () => {
    // The desktop contract is the base classes every `md:` variant restores:
    // a fixed 38px row, nowrap text, and the buttons pulled right inline.
    const banner = mount(13);
    expect(banner).not.toBeNull();
    const row = classes(banner);
    expect(row).toContain("md:flex-nowrap");
    expect(row).toContain("md:h-[38px]");
    const buttons = screen.getByTestId("catchup-banner-narrow-24h").closest("span");
    expect(classes(buttons)).toContain("shrink-0");
    expect(classes(buttons)).toContain("md:ml-auto");
  });
});
