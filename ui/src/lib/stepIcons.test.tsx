/**
 * stepIcons.test.tsx — the issue #65 contract for the one shared step-kind
 * icon map: every catalogue kind has a distinct lucide icon, the icon renders
 * at 14px (16px ceiling) with the design's 1.5 stroke and currentColor, it is
 * aria-hidden decoration (the kind's name is carried by the text beside it),
 * and an unknown kind gets the neutral square box — never an invented icon.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Square } from "lucide-react";
import { NODE_KINDS } from "./pipeline/definition";
import { STEP_KIND_ICONS, StepKindIcon, UNKNOWN_STEP_ICON, stepKindIcon } from "./stepIcons";

describe("STEP_KIND_ICONS", () => {
  it("covers every catalogue kind with a distinct icon", () => {
    expect(Object.keys(STEP_KIND_ICONS).sort()).toEqual([...NODE_KINDS].sort());
    expect(new Set(Object.values(STEP_KIND_ICONS)).size).toBe(NODE_KINDS.length);
  });

  it("gives an unknown kind the neutral square box", () => {
    expect(stepKindIcon("agent.future")).toBe(UNKNOWN_STEP_ICON);
    expect(UNKNOWN_STEP_ICON).toBe(Square);
  });
});

describe("StepKindIcon", () => {
  it("renders one aria-hidden 14px/1.5-stroke currentColor svg per kind", () => {
    for (const kind of NODE_KINDS) {
      const { container } = render(<StepKindIcon kind={kind} />);
      const svg = container.querySelector("svg");
      expect(svg, kind).toBeTruthy();
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      expect(svg!.getAttribute("data-step-kind")).toBe(kind);
      expect(svg!.getAttribute("width")).toBe("14");
      expect(svg!.getAttribute("height")).toBe("14");
      expect(svg!.getAttribute("stroke-width")).toBe("1.5");
      expect(svg!.getAttribute("stroke")).toBe("currentColor");
    }
  });

  it("never draws bigger than the 16px ceiling", () => {
    const { container } = render(<StepKindIcon kind="agent.acp" size={40} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });
});
