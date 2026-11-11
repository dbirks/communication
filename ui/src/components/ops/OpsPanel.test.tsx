/**
 * The ops panel frame: a section a tile can scroll to, a head that names it and
 * sizes it, and the two bodies every section owes the reader while the read is
 * not there yet — three skeleton lines, or a sentence that says what could not
 * be loaded and a way to try again.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpsError, OpsPanel, OpsSkeleton } from "./OpsPanel";

afterEach(cleanup);

describe("OpsPanel", () => {
  it("is a named section with the id its tile scrolls to", () => {
    render(
      <OpsPanel id="ops-queue" title="Queue" meta="1 worker reporting">
        <p>body</p>
      </OpsPanel>,
    );
    const section = screen.getByTestId("ops-queue");
    expect(section.getAttribute("id")).toBe("ops-queue");
    expect(section.getAttribute("aria-labelledby")).toBe("ops-queue-heading");
    expect(screen.getByRole("heading", { name: "Queue" }).textContent).toBe("Queue");
    expect(section.textContent).toContain("1 worker reporting");
    expect(section.textContent).toContain("body");
  });

  it("draws the frame the design names: 4px radius, line edge, paper head, 12px body", () => {
    render(
      <OpsPanel id="ops-workers" title="Workers">
        <p>rows</p>
      </OpsPanel>,
    );
    const classes = screen.getByTestId("ops-workers").getAttribute("class") ?? "";
    expect(classes).toContain("rounded-[4px]");
    expect(classes).toContain("border-line");
    expect(classes).toContain("bg-surface");
    const head = screen.getByRole("heading").parentElement;
    expect(head?.getAttribute("class")).toContain("h-[36px]");
    expect(head?.getAttribute("class")).toContain("bg-paper");
  });
});

describe("OpsSkeleton", () => {
  it("is three lines the section will grow into", () => {
    render(<OpsSkeleton testid="workers-skeleton" />);
    const box = screen.getByTestId("workers-skeleton");
    expect(box.children).toHaveLength(3);
    for (const line of Array.from(box.children)) {
      expect(line.getAttribute("class")).toContain("bg-fill");
      expect(line.getAttribute("class")).toContain("h-[12px]");
      expect(line.getAttribute("class")).toContain("rounded-[2px]");
    }
    expect(box.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("OpsError", () => {
  it("names the thing it could not load, in the sentence's own words", () => {
    render(<OpsError thing="the queue" detail="scheduler telemetry is not served" />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load the queue.");
    expect(screen.getByRole("alert").textContent).toContain("scheduler telemetry is not served");
  });

  it("offers Retry only when the caller can re-open the read", () => {
    let retried = 0;
    render(<OpsError thing="the queue" onRetry={() => (retried += 1)} />);
    fireEvent.click(screen.getByTestId("ops-error-retry"));
    expect(retried).toBe(1);
    cleanup();
    render(<OpsError thing="the queue" />);
    expect(screen.queryByTestId("ops-error-retry")).toBeNull();
  });
});
