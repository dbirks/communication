import { describe, expect, it } from "vitest";
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS, changeKindGlyph, trustPillLabel } from "./types";

describe("types (ADR-0050 mirror)", () => {
  it("lists exactly the three trust levels, with ask_risky first-class", () => {
    expect(TRUST_LEVELS.map((level) => level.value)).toEqual(["ask_all", "ask_risky", "no_ask"]);
    expect(DEFAULT_TRUST_LEVEL).toBe("ask_risky");
  });

  it("maps trust levels to the lowercase pill labels from the shots", () => {
    expect(trustPillLabel("ask_all")).toBe("ask before everything");
    expect(trustPillLabel("ask_risky")).toBe("ask for risky");
    expect(trustPillLabel("no_ask")).toBe("don't ask");
  });

  it("gives every change kind a glyph (none empty)", () => {
    for (const kind of [
      "draft_edit",
      "navigate",
      "run_start",
      "run_retry",
      "approval_decision",
      "publish",
    ] as const) {
      expect(changeKindGlyph(kind).length).toBeGreaterThan(0);
    }
  });
});
