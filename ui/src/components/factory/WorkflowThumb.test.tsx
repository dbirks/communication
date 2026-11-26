/**
 * WorkflowThumb — the strip's classes come from the state tokens (a raw hex
 * here would be a second palette), and the strip is announced rather than
 * hidden: its only statement of "where the run is" is visual.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHIP_CLASS, WorkflowThumb, chipClasses, chipLabel, chipLabelMax } from "./WorkflowThumb";
import { CHIP_LABEL_MAX, CHIP_LABEL_MAX_LONG } from "./WorkflowThumb";
import type { ThumbStep } from "./factoryData";

afterEach(cleanup);

const steps: ThumbStep[] = [
  { id: "trigger", label: "schedule", kind: "trigger", state: "idle" },
  { id: "plan", label: "plan", kind: "agent", state: "done" },
  { id: "test", label: "run the whole test suite", kind: "command", state: "running" },
  { id: "approve", label: "approve", kind: "approval", state: "waiting" },
  { id: "ship", label: "ship", kind: "git", state: "failed" },
];

function chip(id: string): HTMLElement {
  return screen.getByTestId(`workflow-thumb-chip-${id}`);
}

describe("WorkflowThumb", () => {
  it("draws one chip per step, the trigger chip inked", () => {
    render(<WorkflowThumb steps={steps} />);
    expect(chip("trigger").className).toContain("bg-ink");
    expect(chip("trigger").className).toContain("text-surface");
    expect(chip("trigger").textContent).toBe("schedule");
  });

  // Review 07-1280-5: the prototype draws the strip's chips as words (sans
  // 11.5/600), not as ids in mono type.
  it("draws the chip text in the UI's own sans, not in mono", () => {
    render(<WorkflowThumb steps={steps} />);
    const chipClass = chip("plan").className;
    expect(chipClass).not.toContain("font-mono");
    expect(chipClass).toContain("text-[11.5px]");
    expect(chipClass).toContain("font-semibold");
  });

  it("uses the state token classes, never a raw colour", () => {
    render(<WorkflowThumb steps={steps} />);
    expect(chip("plan").className).toContain(CHIP_CLASS.done);
    expect(chip("test").className).toContain("bg-st-running-tag");
    expect(chip("approve").className).toContain("border-st-waiting-strong");
    expect(chip("ship").className).toContain("text-st-failed-tag-fg");
    for (const state of ["running", "waiting", "done", "failed"] as const) {
      expect(chipClasses("agent", state)).toBe(CHIP_CLASS[state]);
      for (const token of CHIP_CLASS[state].split(/\s+/)) {
        expect(token).not.toMatch(/#/);
      }
    }
  });

  it("cuts a long label at nine characters, with the whole text in the title", () => {
    render(<WorkflowThumb steps={steps} />);
    expect(chip("test").textContent).toBe(`${"run the w"}…`);
    expect(chip("test").getAttribute("title")).toBe("run the whole test suite");
    expect(chipLabel("123456789")).toBe("123456789");
  });

  it("packs a long chain tighter instead of crushing every chip to one letter", () => {
    // Measured on the lab's `feature-development` card: seven chips at the
    // design's own padding overflowed the card and squeezed the step labels to
    // `p…`, so a strip over five chips packs (`0 6`, a 14px connector) and
    // cuts its labels at six characters.
    render(<WorkflowThumb steps={steps} />);
    expect(chipLabelMax(steps.length)).toBe(CHIP_LABEL_MAX);
    const many: ThumbStep[] = Array.from({ length: 7 }, (_unused, index) => ({
      id: `step-${index}`,
      label: `step-${index}`,
      kind: index === 0 ? ("trigger" as const) : ("other" as const),
      state: "idle" as const,
    }));
    render(<WorkflowThumb steps={many} />);
    expect(chipLabelMax(many.length)).toBe(CHIP_LABEL_MAX_LONG);
    expect(chipLabel("implement", CHIP_LABEL_MAX_LONG)).toBe("implem…");
    const packed = chip("step-1").className;
    expect(packed).toContain("px-[6px]");
    expect(packed).not.toContain("px-[8px]");
  });

  it("is announced as what it shows, not as decoration", () => {
    render(<WorkflowThumb steps={steps} />);
    const strip = screen.getByTestId("workflow-thumb");
    expect(strip.getAttribute("role")).toBe("img");
    expect(strip.getAttribute("aria-label")).toBe(
      "4 steps; step 'approve' is waiting on an approval",
    );
    expect(strip.getAttribute("aria-hidden")).toBeNull();
  });

  it("has a plain line for a workflow with no published steps", () => {
    render(<WorkflowThumb steps={[]} />);
    expect(screen.getByTestId("workflow-thumb").textContent).toBe("no steps yet");
  });

  it("caps direct step lists at 5 steps + +N and left-aligns with a right fade", () => {
    const ten: ThumbStep[] = [
      { id: "trigger", label: "manual", kind: "trigger", state: "idle" },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `s-${i + 1}`,
        label: `step-${i + 1}`,
        kind: "command" as const,
        state: "idle" as const,
      })),
    ];
    render(<WorkflowThumb steps={ten} />);
    expect(chip("trigger")).toBeTruthy();
    expect(chip("s-5")).toBeTruthy();
    expect(screen.queryByTestId("workflow-thumb-chip-s-6")).toBeNull();
    expect(chip("+4").textContent).toBe("+4");
    expect(screen.getByTestId("workflow-thumb-strip").className).toContain("mx-auto");
    expect(screen.getByTestId("workflow-thumb-fade")).toBeTruthy();
  });
});
