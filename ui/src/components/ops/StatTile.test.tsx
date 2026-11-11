/**
 * The stat tile: a button that names itself in words, scrolls to its section,
 * and never says the state by colour. The a11y sentence in the brief
 * (`"Workers: 1 online, ok"`) is the whole point of the component, so it is the
 * first assertion here.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatTile } from "./StatTile";

afterEach(() => {
  cleanup();
  // jsdom has no scrollIntoView; the test that exercises the scroll installs it.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function tile(overrides: Partial<React.ComponentProps<typeof StatTile>> = {}) {
  return {
    label: "Workers",
    value: "1 online",
    sub: "2 slots · 0 busy",
    status: "ok" as const,
    targetId: "ops-workers",
    ariaValue: "1 online",
    ...overrides,
  };
}

describe("StatTile", () => {
  it("names the tile with its words and its state, not its colour", () => {
    render(<StatTile {...tile()} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("Workers: 1 online, ok");
    // The dot inside is decoration for scanners; the words carry the state.
    expect(screen.getByTestId("status-dot").getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["ok", "bg-st-done-strong"],
    ["warn", "bg-seg-waiting"],
    ["bad", "bg-seg-failed"],
    ["off", "bg-seg-open"],
  ] as const)("shows the %s state on the dot", (status, token) => {
    render(<StatTile {...tile({ status })} />);
    expect(screen.getByTestId("status-dot").getAttribute("class")).toContain(token);
  });

  it("scrolls to its own section when pressed", () => {
    const section = document.createElement("section");
    section.id = "ops-workers";
    const calls: unknown[] = [];
    section.scrollIntoView = (arg?: unknown) => calls.push(arg);
    document.body.appendChild(section);

    render(<StatTile {...tile()} />);
    fireEvent.click(screen.getByRole("button"));

    expect(calls).toHaveLength(1);
    expect((calls[0] as { behavior: string }).behavior).toBe("smooth");
  });

  it("keeps a focus ring (the tile is the page's only keyboard path to a section)", () => {
    render(<StatTile {...tile()} />);
    const classes = screen.getByRole("button").getAttribute("class") ?? "";
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-accent");
  });

  it("lays out three lines: label, value, sub", () => {
    render(<StatTile {...tile()} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Workers");
    expect(button.textContent).toContain("1 online");
    expect(button.textContent).toContain("2 slots · 0 busy");
  });

  it("shows the loading shape the page promises: an em dash and the word loading", () => {
    render(
      <StatTile
        {...tile({ value: "—", sub: "loading…", status: "off", ariaValue: "no data yet" })}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("—");
    expect(button.textContent).toContain("loading…");
    expect(button.getAttribute("aria-label")).toBe("Workers: no data yet, no data");
  });
});
