/**
 * The status dot is the ops page's only colour-only mark, so the two rules that
 * keep it honest are asserted here: it says nothing to an assistive technology
 * (`aria-hidden`, so the word next to it is the whole message), and each state
 * draws its own segment colour — `off` is the white/open segment, which must
 * never be mistaken for the done segment's ink.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot";

afterEach(cleanup);

describe("StatusDot", () => {
  it.each([
    ["ok", "bg-st-done-strong"],
    ["warn", "bg-seg-waiting"],
    ["bad", "bg-seg-failed"],
  ] as const)("draws %s with the %s segment", (status, token) => {
    render(<StatusDot status={status} />);
    const dot = screen.getByTestId("status-dot");
    expect(dot.getAttribute("class")).toContain(token);
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("data-status")).toBe(status);
  });

  it("gives the `off` dot an edge, because white on white would read as nothing", () => {
    render(<StatusDot status="off" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot.getAttribute("class")).toContain("bg-seg-open");
    expect(dot.getAttribute("class")).toContain("border-line-strong");
  });

  it("is an 8px square with a 2px radius (the tile's first row)", () => {
    render(<StatusDot status="ok" />);
    const classes = screen.getByTestId("status-dot").getAttribute("class") ?? "";
    expect(classes).toContain("h-[8px]");
    expect(classes).toContain("w-[8px]");
    expect(classes).toContain("rounded-[2px]");
  });
});
