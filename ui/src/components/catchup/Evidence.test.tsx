/**
 * Shared evidence rendering (design 8b / 7b): the dark log block with its
 * header strip, the tinted diff, the mono file list, and the screenshot's
 * honest placeholder versus real before/after images. Payloads are model
 * output — the tests pin that text is rendered as text and that no url the
 * server did not label as an image is ever followed.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CatchUpEvidence } from "../../api/catchup";
import { Evidence } from "./Evidence";

afterEach(cleanup);

function evidence(over: Record<string, unknown>): CatchUpEvidence {
  return { type: "log", ...over } as unknown as CatchUpEvidence;
}

describe("Evidence", () => {
  it("renders a log as the dark block with the excerpt's label in a header strip", () => {
    const { container } = render(
      <Evidence
        evidence={evidence({
          type: "log",
          label: "NIGHTLY REPLAY TEST · 11:10",
          text: "refund.sent id=rf_8812 attempt=2 ← duplicate\nFAIL TestReplayRefunds",
        })}
      />,
    );
    const block = container.querySelector(".bg-ink")!;
    expect(block.className).toContain("text-line");
    expect(block.className).toContain("font-mono");
    expect(block.textContent).toContain("refund.sent id=rf_8812 attempt=2 ← duplicate");
    expect(block.textContent).toContain("FAIL TestReplayRefunds");
    const strip = container.querySelector(".bg-ink-2")!;
    expect(strip.textContent).toBe("NIGHTLY REPLAY TEST · 11:10");
  });

  it("tints diff + and − lines and keeps the sign glyphs visible", () => {
    const { container } = render(
      <Evidence
        evidence={evidence({
          type: "diff",
          path: "webhook/sender.go",
          text: "-old line\n+new line\n context line",
        })}
      />,
    );
    const added = screen.getByText("new line").closest("div")!;
    const removed = screen.getByText("old line").closest("div")!;
    expect(added.className).toContain("bg-st-done-pale-body");
    expect(removed.className).toContain("bg-st-failed-pale-body");
    expect(added.textContent).toBe("+new line");
    expect(removed.textContent).toBe("-old line");
    expect(screen.getByText("webhook/sender.go")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("lists files in mono, one per line", () => {
    render(
      <Evidence
        evidence={evidence({
          type: "files",
          files: ["Checkout.tsx", "Totals.tsx"],
        })}
      />,
    );
    expect(screen.getByText("Checkout.tsx")).toBeTruthy();
    expect(screen.getByText("Totals.tsx")).toBeTruthy();
  });

  it("says so honestly when a screenshot was never captured", () => {
    render(<Evidence evidence={evidence({ type: "screenshot", label: "before/after" })} />);
    const placeholder = screen.getByTestId("catchup-evidence-no-screenshot");
    expect(placeholder.textContent).toContain("No screenshot was captured.");
    expect(document.querySelector("img")).toBeNull();
  });

  it("draws before/after images when the payload carries their urls", () => {
    render(
      <Evidence
        evidence={evidence({
          type: "screenshot",
          label: "Checkout summary",
          before_url: "https://example.test/before.png",
          after_url: "https://example.test/after.png",
        })}
      />,
    );
    const images = document.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("https://example.test/before.png");
    expect(images[1]?.getAttribute("src")).toBe("https://example.test/after.png");
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
  });

  it("keeps a quiet frame for evidence types this build cannot draw", () => {
    render(<Evidence evidence={evidence({ type: "table" as never, label: "counts" })} />);
    expect(screen.getByText("counts")).toBeTruthy();
    expect(screen.getByText("counts").closest("div")!.className).toContain("border-dashed");
  });
});
